-- One immutable SMTP message may carry several alternative quotes for one client.
-- Invoice delivery, credentials, numbering and original financial records stay isolated.
begin;

alter table orquivia_private.mail_jobs add column related_documents jsonb not null default '[]'::jsonb
  check(jsonb_typeof(related_documents)='array' and jsonb_array_length(related_documents)<=4);
create index mail_jobs_related_history on orquivia_private.mail_jobs using gin(related_documents jsonb_path_ops);

create or replace function orquivia_private.mail_job_json(j orquivia_private.mail_jobs) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'documentId',j.document_id,'documentNumber',j.document_snapshot->>'number','sender',j.sender,'to',j.recipients,'cc',j.cc,'subject',j.subject,
    'status',case when j.status='sending' and j.created_at<now()-interval '3 minutes' then 'uncertain' else j.status end,
    'createdAt',j.created_at,'sentAt',j.sent_at,'errorCode',j.error_code,'pdfHash',j.pdf_hash,
    'accepted',j.accepted_recipients,'rejected',j.rejected_recipients,'attachments',j.attachments,
    'relatedDocumentIds',coalesce((select jsonb_agg(r->'document'->'id' order by r->'document'->>'id') from jsonb_array_elements(j.related_documents) r),'[]'::jsonb),
    'relatedDocuments',coalesce((select jsonb_agg(jsonb_build_object('id',r->'document'->>'id','number',r->'document'->>'number','kind',r->'document'->>'kind') order by r->'document'->>'id') from jsonb_array_elements(j.related_documents) r),'[]'::jsonb));
$$;

drop function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb);

create or replace function public.orquivia_mail_claim(p_user uuid,p_org uuid,p_id uuid,p_document text,p_version bigint,p_hash text,p_to jsonb,p_subject text,p_cc jsonb default '[]'::jsonb,p_attachments jsonb default '[]'::jsonb,p_related_documents jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare email text:=orquivia_private.mail_member(p_user,p_org); j orquivia_private.mail_jobs; s jsonb; v bigint; d jsonb;
  address jsonb; normalized text; seen text[]:='{}'; related_ids jsonb; related jsonb:='[]'::jsonb; related_id jsonb; rd jsonb; requested_ids text[];
begin
  if jsonb_typeof(p_related_documents) is distinct from 'array' or jsonb_array_length(p_related_documents)>4 then raise exception 'INVALID_RELATED_DOCUMENTS'; end if;
  if exists(select 1 from jsonb_array_elements(p_related_documents) r where jsonb_typeof(r) is distinct from 'string' or length(r#>>'{}') not between 1 and 100 or (r#>>'{}') is distinct from btrim(r#>>'{}') or r#>>'{}'=p_document or r#>>'{}' ~ '[[:cntrl:]]')
    or (select count(*) from jsonb_array_elements(p_related_documents))<>(select count(distinct r) from jsonb_array_elements(p_related_documents) r) then raise exception 'INVALID_RELATED_DOCUMENTS'; end if;
  select coalesce(jsonb_agg(r order by r#>>'{}'),'[]'::jsonb) into related_ids from jsonb_array_elements(p_related_documents) r;
  select array[p_document]||coalesce(array_agg(r#>>'{}'),array[]::text[]) into requested_ids from jsonb_array_elements(related_ids) r;
  perform pg_advisory_xact_lock(hashtextextended('mail-send:'||p_org::text,0));
  select * into j from orquivia_private.mail_jobs where id=p_id;
  if found then
    if j.user_id<>p_user or j.organization_id<>p_org or j.document_id<>p_document or j.request_hash<>p_hash or j.attachments is distinct from p_attachments or coalesce((select jsonb_agg(r->'document'->'id' order by r->'document'->>'id') from jsonb_array_elements(j.related_documents) r),'[]'::jsonb) is distinct from related_ids then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing',true,'job',orquivia_private.mail_job_json(j));
  end if;
  select state,version into s,v from public.orquivia_team_workspaces where organization_id=p_org for update;
  if v is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='PT409'; end if;
  select value into d from jsonb_array_elements(s->'documents') where value->>'id'=p_document;
  if d is null or coalesce(d->>'number','')='' or not (
    (d->>'kind'='quote' and d->>'status' in ('ready','sent'))
    or (d->>'kind'='invoice' and d->>'status' in ('issued','partial','paid','overdue') and exists(
      select 1 from public.orquivia_document_numbers n where n.organization_id=p_org and n.document_id=p_document
        and n.kind='invoice' and n.number=d->>'number' and n.issue_date=(d->>'date')::date
        and n.fiscal_data=orquivia_private.fiscal_data(d)))) then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  if jsonb_array_length(related_ids)>0 and d->>'kind'<>'quote' then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  for related_id in select value from jsonb_array_elements(related_ids) loop
    select value into rd from jsonb_array_elements(s->'documents') where value->>'id'=related_id#>>'{}';
    if rd is null or rd->>'kind'<>'quote' or rd->>'status' not in ('ready','sent') or coalesce(rd->>'number','')=''
      or rd->>'clientId' is distinct from d->>'clientId' then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
    related:=related||jsonb_build_array(jsonb_build_object('document',rd,'company',coalesce(rd->'companySnapshot',s->'company'),
      'client',coalesce(rd->'clientSnapshot',(select value from jsonb_array_elements(s->'clients') where value->>'id'=rd->>'clientId'))));
  end loop;
  if not orquivia_private.valid_mail_attachments(p_attachments) then raise exception 'INVALID_ATTACHMENT'; end if;
  if jsonb_array_length(p_attachments)+jsonb_array_length(related_ids)>5 then raise exception 'ATTACHMENT_LIMIT'; end if;
  if jsonb_array_length(p_attachments)>0 and d->>'kind'<>'invoice' then raise exception 'ATTACHMENTS_NOT_ALLOWED'; end if;
  if exists(select 1 from orquivia_private.mail_jobs j2 where j2.organization_id=p_org and j2.status in ('sending','uncertain')
    and (j2.document_id=any(requested_ids) or exists(select 1 from jsonb_array_elements(j2.related_documents) r where r->'document'->>'id'=any(requested_ids)))) then raise exception 'MAIL_OUTCOME_UNCERTAIN'; end if;
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
  insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,cc,subject,status,attachments,transient_message,related_documents)
    values(p_id,p_org,p_user,p_document,p_hash,d,email,p_to,p_cc,p_subject,'sending',p_attachments,true,related) returning * into j;
  return jsonb_build_object('existing',false,'job',orquivia_private.mail_job_json(j),'document',d,'company',coalesce(d->'companySnapshot',s->'company'),
    'client',coalesce(d->'clientSnapshot',(select value from jsonb_array_elements(s->'clients') where value->>'id'=d->>'clientId')),'relatedDocuments',related);
end; $$;

create or replace function public.orquivia_mail_complete(p_user uuid,p_org uuid,p_id uuid,p_status text,p_delivery jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j orquivia_private.mail_jobs; old_state jsonb; next_state jsonb; v bigint; d jsonb; idx integer; result jsonb;
  snapshot jsonb; entry jsonb; address jsonb; seen text[]:='{}';
begin
  perform orquivia_private.mail_member(p_user,p_org);
  select * into j from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or p_status not in ('failed','uncertain','archive_pending','sent') then raise exception 'INVALID_MAIL_JOB'; end if;
  if j.status not in ('sending','archive_pending') or (j.status='archive_pending' and p_status not in ('archive_pending','sent')) then return jsonb_build_object('job',orquivia_private.mail_job_json(j)); end if;
  if p_delivery is not null and p_status='failed' then
    if jsonb_typeof(p_delivery) is distinct from 'object'
      or p_delivery->>'errorCode' not in ('MAIL_STORAGE_LIMIT','MAIL_MESSAGE_TOO_LARGE','MAIL_PREPARATION_FAILED')
      or p_delivery->>'errorCode' is null
      or (select count(*) from jsonb_object_keys(p_delivery))<>1 then raise exception 'INVALID_MAIL_JOB'; end if;
  elsif p_delivery is not null then
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
    archive_lease_until=null,error_code=case when p_delivery is not null then p_delivery->>'errorCode' else error_code end,
    accepted_recipients=case when p_delivery->>'errorCode'='SMTP_PARTIAL' then p_delivery->'accepted' else accepted_recipients end,
    rejected_recipients=case when p_delivery->>'errorCode'='SMTP_PARTIAL' then p_delivery->'rejected' else rejected_recipients end
    where id=p_id returning * into j;
  result:=jsonb_build_object('job',orquivia_private.mail_job_json(j));
  if p_status in ('sent','archive_pending') then
    select state,version into old_state,v from public.orquivia_team_workspaces where organization_id=p_org for update;
    next_state:=old_state;
    for snapshot in select value from jsonb_array_elements(jsonb_build_array(jsonb_build_object('document',j.document_snapshot))||j.related_documents) loop
      entry:=snapshot->'document';
      select value,ordinality::integer-1 into d,idx from jsonb_array_elements(next_state->'documents') with ordinality where value->>'id'=entry->>'id';
      if d=entry and d->>'kind'='quote' and d->>'status'='ready' then
        next_state:=jsonb_set(next_state,array['documents',idx::text,'status'],'"sent"'::jsonb);
      elsif d->>'kind'='invoice' and entry->>'kind'='invoice'
        and d->>'status' in ('issued','partial','paid','overdue')
        and orquivia_private.fiscal_data(d)=orquivia_private.fiscal_data(entry)
        and d->>'deliveryStatus' is distinct from 'sent' then
        next_state:=jsonb_set(next_state,array['documents',idx::text,'deliveryStatus'],'"sent"'::jsonb);
      end if;
    end loop;
    if next_state is distinct from old_state then
      update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=now() where organization_id=p_org;
      perform orquivia_private.audit(p_org,'email_sent',v+1,old_state,next_state,p_user);
      result:=result||jsonb_build_object('workspace',jsonb_build_object('state',next_state,'version',v+1,'updated_at',now()));
    end if;
  end if;
  return result;
end; $$;

create or replace function public.orquivia_mail_history(p_user uuid,p_org uuid,p_document text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.mail_member(p_user,p_org);
  return jsonb_build_object('history',coalesce((select jsonb_agg(orquivia_private.mail_job_json(j) order by j.created_at desc)
    from (select * from orquivia_private.mail_jobs where organization_id=p_org
      and (document_id=p_document or related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',p_document))))
      order by created_at desc limit 30) j),'[]'::jsonb));
end; $$;

-- Quotes which have never left preparation may be revised within their year.
-- Keep the complete original invariant checker and the number/creation trail.
alter function orquivia_private.check_issued(uuid,jsonb,jsonb) rename to check_issued_before_quote_revision;
create function orquivia_private.check_issued(p_org uuid,p_previous jsonb,p_next jsonb) returns void
language plpgsql set search_path='' as $$
declare d jsonb; prior jsonb; issued public.orquivia_document_numbers%rowtype;
begin
  for d in select value from jsonb_array_elements(p_next->'documents') loop
    select * into issued from public.orquivia_document_numbers where organization_id=p_org and document_id=d->>'id';
    if issued.kind='quote' and (d->>'date')::date is distinct from issued.issue_date then
      select value into prior from jsonb_array_elements(p_previous->'documents') where value->>'id'=d->>'id';
      if prior->>'kind' is distinct from 'quote' or prior->>'status' is distinct from 'ready' or d->>'status' is distinct from 'ready'
        or extract(year from (d->>'date')::date)<>issued.year or (d->>'date')::date>(now() at time zone 'Europe/Madrid')::date
        or exists(select 1 from orquivia_private.mail_jobs j where j.organization_id=p_org
          and (j.document_id=d->>'id' or j.related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',d->>'id')))))
        or exists(select 1 from jsonb_array_elements((p_previous->'documents')||(p_next->'documents')) r where r->>'kind'='invoice' and r->>'quoteId'=d->>'id') then
        raise exception 'ISSUED_DOCUMENT_IMMUTABLE' using errcode='22023';
      end if;
      update public.orquivia_document_numbers set issue_date=(d->>'date')::date where organization_id=p_org and document_id=d->>'id' and kind='quote';
    end if;
  end loop;
  perform orquivia_private.check_issued_before_quote_revision(p_org,p_previous,p_next);
end; $$;

revoke all on function orquivia_private.check_issued_before_quote_revision(uuid,jsonb,jsonb),orquivia_private.check_issued(uuid,jsonb,jsonb),orquivia_private.mail_job_json(orquivia_private.mail_jobs) from public,anon,authenticated;
grant execute on function orquivia_private.check_issued_before_quote_revision(uuid,jsonb,jsonb),orquivia_private.check_issued(uuid,jsonb,jsonb),orquivia_private.mail_job_json(orquivia_private.mail_jobs) to service_role;
revoke all on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb,jsonb),public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb),public.orquivia_mail_history(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb,jsonb),public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb),public.orquivia_mail_history(uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
commit;
