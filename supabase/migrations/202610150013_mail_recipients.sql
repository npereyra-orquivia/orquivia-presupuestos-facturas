-- Keep earlier callers compatible while allowing multiple To and Cc recipients.
-- Mail remains service-only; financial records are not changed by this migration.
begin;
alter table orquivia_private.mail_jobs
  add column cc jsonb not null default '[]'::jsonb check(jsonb_typeof(cc)='array'),
  add column accepted_recipients jsonb not null default '[]'::jsonb check(jsonb_typeof(accepted_recipients)='array'),
  add column rejected_recipients jsonb not null default '[]'::jsonb check(jsonb_typeof(rejected_recipients)='array');

create or replace function orquivia_private.mail_job_json(j orquivia_private.mail_jobs) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'documentId',j.document_id,'sender',j.sender,'to',j.recipients,'cc',j.cc,'subject',j.subject,
    'status',case when j.status='sending' and j.created_at<now()-interval '3 minutes' then 'uncertain' else j.status end,
    'createdAt',j.created_at,'sentAt',j.sent_at,'errorCode',j.error_code,'pdfHash',j.pdf_hash,
    'accepted',j.accepted_recipients,'rejected',j.rejected_recipients);
$$;

-- One signature with a default preserves the eight-argument RPC contract and
-- prevents PostgREST from choosing an ambiguous overload for omitted Cc.
drop function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text);
create function public.orquivia_mail_claim(p_user uuid,p_org uuid,p_id uuid,p_document text,p_version bigint,p_hash text,p_to jsonb,p_subject text,p_cc jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare email text:=orquivia_private.mail_member(p_user,p_org); j orquivia_private.mail_jobs; s jsonb; v bigint; d jsonb;
  address jsonb; normalized text; seen text[]:='{}';
begin
  perform pg_advisory_xact_lock(hashtextextended('mail-send:'||p_org::text,0));
  select * into j from orquivia_private.mail_jobs where id=p_id;
  if found then
    if j.user_id<>p_user or j.organization_id<>p_org or j.document_id<>p_document or j.request_hash<>p_hash then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing',true,'job',orquivia_private.mail_job_json(j));
  end if;
  select state,version into s,v from public.orquivia_team_workspaces where organization_id=p_org for update;
  if v is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  select value into d from jsonb_array_elements(s->'documents') where value->>'id'=p_document;
  if d is null or d->>'kind'<>'quote' or d->>'status' not in ('ready','sent') or coalesce(d->>'number','')='' then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  if exists(select 1 from orquivia_private.mail_jobs where organization_id=p_org and document_id=p_document and status in ('sending','uncertain')) then raise exception 'MAIL_OUTCOME_UNCERTAIN'; end if;
  if (select count(*) from orquivia_private.mail_jobs where user_id=p_user and created_at>now()-interval '1 minute')>=5
    or (select count(*) from orquivia_private.mail_jobs where user_id=p_user and created_at>now()-interval '1 hour')>=20
    or (select count(*) from orquivia_private.mail_jobs where user_id=p_user and created_at>now()-interval '1 day')>=100 then raise exception 'RATE_LIMITED'; end if;
  if jsonb_typeof(p_to) is distinct from 'array' or jsonb_typeof(p_cc) is distinct from 'array' then raise exception 'INVALID_MESSAGE'; end if;
  if jsonb_array_length(p_to) not between 1 and 20 or jsonb_array_length(p_to)+jsonb_array_length(p_cc)>20
    or p_subject is null or length(p_subject) not between 1 and 200 or p_subject ~ '[[:cntrl:]]' then raise exception 'INVALID_MESSAGE'; end if;
  -- The Edge validates and normalizes the addresses. This independent database
  -- boundary rejects malformed lists, duplicates and header/control injection.
  for address in select value from jsonb_array_elements(p_to||p_cc) loop
    if jsonb_typeof(address)<>'string' then raise exception 'INVALID_MESSAGE'; end if;
    normalized:=address#>>'{}';
    if normalized<>btrim(normalized) or length(normalized)>254 or normalized ~ '[[:cntrl:][:space:]]'
      or normalized !~ '^[^@,;<>]+@[^@,;<>]+\.[^@,;<>]+$' or lower(normalized)=any(seen) then raise exception 'INVALID_MESSAGE'; end if;
    seen:=array_append(seen,lower(normalized));
  end loop;
  insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,cc,subject,status)
    values(p_id,p_org,p_user,p_document,p_hash,d,email,p_to,p_cc,p_subject,'sending') returning * into j;
  return jsonb_build_object('existing',false,'job',orquivia_private.mail_job_json(j),'document',d,'company',coalesce(d->'companySnapshot',s->'company'),
    'client',coalesce(d->'clientSnapshot',(select value from jsonb_array_elements(s->'clients') where value->>'id'=d->>'clientId')));
end; $$;

-- The old four-argument call continues to work through the default. Partial
-- delivery records only requested recipients and never updates quote status.
drop function public.orquivia_mail_complete(uuid,uuid,uuid,text);
create function public.orquivia_mail_complete(p_user uuid,p_org uuid,p_id uuid,p_status text,p_delivery jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j orquivia_private.mail_jobs; old_state jsonb; next_state jsonb; v bigint; d jsonb; idx integer; result jsonb;
  address jsonb; seen text[]:='{}';
begin
  perform orquivia_private.mail_member(p_user,p_org);
  select * into j from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or p_status not in ('failed','uncertain','archive_pending','sent') then raise exception 'INVALID_MAIL_JOB'; end if;
  if j.status not in ('sending','archive_pending') or (j.status='archive_pending' and p_status not in ('archive_pending','sent')) then return jsonb_build_object('job',orquivia_private.mail_job_json(j)); end if;
  if p_delivery is not null then
    if p_status<>'uncertain' or p_delivery->>'errorCode' is distinct from 'SMTP_PARTIAL'
      or jsonb_typeof(p_delivery->'accepted') is distinct from 'array' or jsonb_typeof(p_delivery->'rejected') is distinct from 'array' then raise exception 'INVALID_MAIL_JOB'; end if;
    if jsonb_array_length(p_delivery->'accepted') not between 1 and 20
      or jsonb_array_length(p_delivery->'accepted')+jsonb_array_length(p_delivery->'rejected')>20 then raise exception 'INVALID_MAIL_JOB'; end if;
    for address in select value from jsonb_array_elements((p_delivery->'accepted')||(p_delivery->'rejected')) loop
      if jsonb_typeof(address)<>'string' or not (j.recipients||j.cc) @> jsonb_build_array(address)
        or lower(address#>>'{}')=any(seen) then raise exception 'INVALID_MAIL_JOB'; end if;
      seen:=array_append(seen,lower(address#>>'{}'));
    end loop;
  end if;
  update orquivia_private.mail_jobs set status=p_status,sent_at=case when p_status in ('sent','archive_pending') then coalesce(sent_at,now()) else sent_at end,
    archive_lease_until=null,error_code=case when p_delivery is not null then 'SMTP_PARTIAL' else error_code end,
    accepted_recipients=case when p_delivery is not null then p_delivery->'accepted' else accepted_recipients end,
    rejected_recipients=case when p_delivery is not null then p_delivery->'rejected' else rejected_recipients end
    where id=p_id returning * into j;
  result:=jsonb_build_object('job',orquivia_private.mail_job_json(j));
  if p_status in ('sent','archive_pending') then
    select state,version into old_state,v from public.orquivia_team_workspaces where organization_id=p_org for update;
    select value,ordinality::integer-1 into d,idx from jsonb_array_elements(old_state->'documents') with ordinality where value->>'id'=j.document_id;
    if d=j.document_snapshot and d->>'status'='ready' then
      next_state:=jsonb_set(old_state,array['documents',idx::text,'status'],'"sent"'::jsonb);
      update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=now() where organization_id=p_org;
      perform orquivia_private.audit(p_org,'email_sent',v+1,old_state,next_state,p_user);
      result:=result||jsonb_build_object('workspace',jsonb_build_object('state',next_state,'version',v+1,'updated_at',now()));
    end if;
  end if;
  return result;
end; $$;
revoke all on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb),public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb),public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb) to service_role;
revoke all on function orquivia_private.mail_job_json(orquivia_private.mail_jobs) from public,anon,authenticated;
notify pgrst, 'reload schema';
commit;
