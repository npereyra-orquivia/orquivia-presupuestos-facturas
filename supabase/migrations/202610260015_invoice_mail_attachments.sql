-- Invoice-only extra attachments. Historical MIME copies remain unchanged.
begin;

alter table orquivia_private.mail_jobs
  add column attachments jsonb not null default '[]'::jsonb,
  add column transient_message boolean not null default false;
alter table orquivia_private.mail_jobs drop constraint mail_jobs_raw_message_check;
alter table orquivia_private.mail_jobs add constraint mail_jobs_raw_message_check
  check(raw_message is null or octet_length(raw_message)<=20000000);

create function orquivia_private.valid_mail_attachments(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare attachment jsonb; name text; mime text; total bigint:=0; size bigint; names text[]:='{}';
begin
  if jsonb_typeof(value) is distinct from 'array' then return false; end if;
  if jsonb_array_length(value)>5 then return false; end if;
  for attachment in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(attachment) is distinct from 'object' then return false; end if;
    if (select count(*) from jsonb_object_keys(attachment))<>4
      or not attachment ?& array['name','contentType','size','sha256'] then return false; end if;
    if jsonb_typeof(attachment->'name') is distinct from 'string'
      or jsonb_typeof(attachment->'contentType') is distinct from 'string'
      or jsonb_typeof(attachment->'sha256') is distinct from 'string'
      or jsonb_typeof(attachment->'size') is distinct from 'number' then return false; end if;
    name:=attachment->>'name';mime:=attachment->>'contentType';
    if length(name) not between 1 and 140 or name<>btrim(name) or left(name,1)='.'
      or name ~ '[[:cntrl:]/\\:<>"|?*]' or name ~ ('['||chr(128)||'-'||chr(159)||']') or name<>normalize(name,NFC)
      or name ~ ('['||chr(8234)||'-'||chr(8238)||chr(8294)||'-'||chr(8297)||']')
      or position(chr(8232) in name)>0 or position(chr(8233) in name)>0
      or attachment->>'sha256' !~ '^[0-9a-f]{64}$'
      or attachment->>'size' !~ '^[0-9]{1,7}$' then return false; end if;
    if not ((mime='application/pdf' and name ~* '\.pdf$')
      or (mime='image/jpeg' and name ~* '\.jpe?g$') or (mime='image/png' and name ~* '\.png$')) then return false; end if;
    if (select sum(case when ascii(letter)>65535 then 2 else 1 end) from regexp_split_to_table(name,'') as letters(letter))>140 then return false; end if;
    if lower(name)=any(names) then return false; end if;
    names:=array_append(names,lower(name));
    size:=(attachment->>'size')::bigint;
    if size not between 1 and 5000000 then return false; end if;
    total:=total+size;
    if total>10000000 then return false; end if;
  end loop;
  return true;
end; $$;

alter table orquivia_private.mail_jobs add constraint mail_jobs_attachments_check
  check(orquivia_private.valid_mail_attachments(attachments));

create or replace function orquivia_private.mail_job_json(j orquivia_private.mail_jobs) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'documentId',j.document_id,'sender',j.sender,'to',j.recipients,'cc',j.cc,'subject',j.subject,
    'status',case when j.status='sending' and j.created_at<now()-interval '3 minutes' then 'uncertain' else j.status end,
    'createdAt',j.created_at,'sentAt',j.sent_at,'errorCode',j.error_code,'pdfHash',j.pdf_hash,
    'accepted',j.accepted_recipients,'rejected',j.rejected_recipients,'attachments',j.attachments);
$$;

-- The old 8/9-argument calls keep resolving through the default values.
drop function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb);

create or replace function public.orquivia_mail_claim(p_user uuid,p_org uuid,p_id uuid,p_document text,p_version bigint,p_hash text,p_to jsonb,p_subject text,p_cc jsonb default '[]'::jsonb,p_attachments jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare email text:=orquivia_private.mail_member(p_user,p_org); j orquivia_private.mail_jobs; s jsonb; v bigint; d jsonb;
  address jsonb; normalized text; seen text[]:='{}';
begin
  perform pg_advisory_xact_lock(hashtextextended('mail-send:'||p_org::text,0));
  select * into j from orquivia_private.mail_jobs where id=p_id;
  if found then
    if j.user_id<>p_user or j.organization_id<>p_org or j.document_id<>p_document or j.request_hash<>p_hash or j.attachments is distinct from p_attachments then raise exception 'IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('existing',true,'job',orquivia_private.mail_job_json(j));
  end if;
  select state,version into s,v from public.orquivia_team_workspaces where organization_id=p_org for update;
  if v is distinct from p_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  select value into d from jsonb_array_elements(s->'documents') where value->>'id'=p_document;
  if d is null or coalesce(d->>'number','')='' or not (
    (d->>'kind'='quote' and d->>'status' in ('ready','sent'))
    or (d->>'kind'='invoice' and d->>'status' in ('issued','partial','paid','overdue') and exists(
      select 1 from public.orquivia_document_numbers n where n.organization_id=p_org and n.document_id=p_document
        and n.kind='invoice' and n.number=d->>'number' and n.issue_date=(d->>'date')::date
        and n.fiscal_data=orquivia_private.fiscal_data(d)))) then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  if not orquivia_private.valid_mail_attachments(p_attachments) then raise exception 'INVALID_ATTACHMENT'; end if;
  if jsonb_array_length(p_attachments)>0 and d->>'kind'<>'invoice' then raise exception 'ATTACHMENTS_NOT_ALLOWED'; end if;
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
  insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,cc,subject,status,attachments,transient_message)
    values(p_id,p_org,p_user,p_document,p_hash,d,email,p_to,p_cc,p_subject,'sending',p_attachments,true) returning * into j;
  return jsonb_build_object('existing',false,'job',orquivia_private.mail_job_json(j),'document',d,'company',coalesce(d->'companySnapshot',s->'company'),
    'client',coalesce(d->'clientSnapshot',(select value from jsonb_array_elements(s->'clients') where value->>'id'=d->>'clientId')));
end; $$;

create or replace function public.orquivia_mail_store_message(p_user uuid,p_org uuid,p_id uuid,p_raw text,p_message_id text,p_pdf_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare job orquivia_private.mail_jobs; raw bytea; retained bigint;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  -- Serialize buffer reservation across every sender in this organization.
  perform pg_advisory_xact_lock(hashtextextended('mail-buffer:'||p_org::text,0));
  select * into job from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or job.status<>'sending' or job.raw_message is not null then raise exception 'INVALID_MAIL_JOB'; end if;
  if p_raw is null or length(p_raw)>28000000 then raise exception 'MAIL_MESSAGE_TOO_LARGE'; end if;
  begin raw:=decode(p_raw,'base64'); exception when others then raise exception 'MAIL_PREPARATION_FAILED'; end;
  if octet_length(raw) not between 1 and 20000000 then raise exception 'MAIL_MESSAGE_TOO_LARGE'; end if;
  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_message_id ~ '[[:cntrl:]]'
    or p_pdf_hash is null or length(p_pdf_hash) not between 1 and 255 or p_pdf_hash ~ '[[:cntrl:]]' then raise exception 'MAIL_PREPARATION_FAILED'; end if;
  select coalesce(sum(octet_length(raw_message)),0) into retained from orquivia_private.mail_jobs
    where organization_id=p_org and raw_message is not null and status in ('sending','uncertain','archive_pending');
  if retained+octet_length(raw)>50000000 then raise exception 'MAIL_STORAGE_LIMIT'; end if;
  update orquivia_private.mail_jobs set raw_message=raw,message_id=p_message_id,pdf_hash=p_pdf_hash,transient_message=true where id=p_id;
end; $$;

-- Only newly stored messages are temporary. No UPDATE rewrites historical jobs.
create function orquivia_private.release_transient_mail_message() returns trigger
language plpgsql set search_path='' as $$
begin
  if new.transient_message and new.status in ('sent','failed') then new.raw_message:=null; end if;
  return new;
end; $$;
create trigger release_transient_mail_message before insert or update on orquivia_private.mail_jobs
  for each row execute function orquivia_private.release_transient_mail_message();


create or replace function public.orquivia_mail_complete(p_user uuid,p_org uuid,p_id uuid,p_status text,p_delivery jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j orquivia_private.mail_jobs; old_state jsonb; next_state jsonb; v bigint; d jsonb; idx integer; result jsonb;
  address jsonb; seen text[]:='{}';
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
    select value,ordinality::integer-1 into d,idx from jsonb_array_elements(old_state->'documents') with ordinality where value->>'id'=j.document_id;
    next_state:=null;
    if d=j.document_snapshot and d->>'kind'='quote' and d->>'status'='ready' then
      next_state:=jsonb_set(old_state,array['documents',idx::text,'status'],'"sent"'::jsonb);
    elsif d->>'kind'='invoice' and j.document_snapshot->>'kind'='invoice'
      and d->>'status' in ('issued','partial','paid','overdue')
      and orquivia_private.fiscal_data(d)=orquivia_private.fiscal_data(j.document_snapshot)
      and d->>'deliveryStatus' is distinct from 'sent' then
      -- Merge into the latest workspace under its row lock. A concurrent payment,
      -- contract update or another record is preserved without replaying state.
      next_state:=jsonb_set(old_state,array['documents',idx::text,'deliveryStatus'],'"sent"'::jsonb);
    end if;
    if next_state is not null then
      update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=now() where organization_id=p_org;
      perform orquivia_private.audit(p_org,'email_sent',v+1,old_state,next_state,p_user);
      result:=result||jsonb_build_object('workspace',jsonb_build_object('state',next_state,'version',v+1,'updated_at',now()));
    end if;
  end if;
  return result;
end; $$;

-- A first send reuses its in-memory MIME after reserving the same archive lease.
-- Retries use the default to retrieve the original, immutable MIME bytes.
drop function public.orquivia_mail_archive_claim(uuid,uuid,uuid);
create function public.orquivia_mail_archive_claim(p_user uuid,p_org uuid,p_id uuid,p_include_raw boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare job orquivia_private.mail_jobs;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  select * into job from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or job.status<>'archive_pending' or job.archive_lease_until>now() or job.raw_message is null
    or p_include_raw is null then raise exception 'INVALID_MAIL_JOB'; end if;
  update orquivia_private.mail_jobs set archive_lease_until=now()+interval '90 seconds' where id=p_id;
  return jsonb_build_object('messageId',job.message_id)
    ||case when p_include_raw then jsonb_build_object('raw',encode(job.raw_message,'base64')) else '{}'::jsonb end;
end; $$;

revoke all on function orquivia_private.valid_mail_attachments(jsonb),
  orquivia_private.release_transient_mail_message(),orquivia_private.mail_job_json(orquivia_private.mail_jobs) from public,anon,authenticated;
grant execute on function orquivia_private.valid_mail_attachments(jsonb),
  orquivia_private.release_transient_mail_message(),orquivia_private.mail_job_json(orquivia_private.mail_jobs) to service_role;
revoke all on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb),
  public.orquivia_mail_store_message(uuid,uuid,uuid,text,text,text),
  public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb),
  public.orquivia_mail_archive_claim(uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb),
  public.orquivia_mail_store_message(uuid,uuid,uuid,text,text,text),
  public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb),
  public.orquivia_mail_archive_claim(uuid,uuid,uuid,boolean) to service_role;
notify pgrst, 'reload schema';
commit;
