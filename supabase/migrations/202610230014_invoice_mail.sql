-- Invoice delivery is independent from invoice collection/payment status.
-- No historical records, counters, memberships or mail credentials are changed.
begin;

create function orquivia_private.valid_billing_email(value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare address text; local_part text; domain_part text; label text;
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  address:=value#>>'{}';
  if length(address) not between 3 and 254 or address ~ '[[:cntrl:][:space:]<>]'
    or length(address)-length(replace(address,'@',''))<>1 then return false; end if;
  local_part:=split_part(address,'@',1); domain_part:=split_part(address,'@',2);
  if length(local_part) not between 1 and 64 or left(local_part,1)='.' or right(local_part,1)='.'
    or position('..' in local_part)>0 or local_part !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+$'
    or length(domain_part)>253 or position('.' in domain_part)=0 then return false; end if;
  foreach label in array string_to_array(domain_part,'.') loop
    if label !~ '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$' then return false; end if;
  end loop;
  return true;
end; $$;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_prepared_quotes_v5;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare d jsonb;
begin
  -- Delegate every original fiscal, expense, tax, limit and quote rule first.
  if not orquivia_private.valid_state_prepared_quotes_v5(p_state) then return false; end if;
  for d in select value from jsonb_array_elements(p_state->'clients') loop
    if d ? 'billingEmail' and not coalesce(orquivia_private.valid_billing_email(d->'billingEmail'),false) then return false; end if;
  end loop;
  for d in select value from jsonb_array_elements(p_state->'documents') loop
    if d ? 'billingEmail' and (d->>'kind'<>'invoice' or not coalesce(orquivia_private.valid_billing_email(d->'billingEmail'),false)) then return false; end if;
    if d ? 'deliveryStatus' and (d->>'kind'<>'invoice' or d->>'status'='draft'
      or jsonb_typeof(d->'deliveryStatus') is distinct from 'string' or d->>'deliveryStatus' not in ('ready','sent')) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end; $$;

alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

create or replace function orquivia_private.fiscal_data(d jsonb) returns jsonb
language sql immutable set search_path='' as $$
  -- Sending metadata may change after issue. Amounts, tax, parties, snapshots,
  -- identifiers, dates and every unknown future fiscal field stay immutable.
  select d-array['status','total','notes','po','dueDate','contractExpectedDate','contractReceived','paymentReviewNeeded','billingEmail','deliveryStatus'];
$$;

alter function orquivia_private.record_change_fields(text,jsonb,jsonb) rename to record_change_fields_before_invoice_mail;
create function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare fields text[]; additions text[]:=array[]::text[]; field text;
begin
  if p_type='document' then additions:=array['billingEmail','deliveryStatus'];
  elsif p_type='client' then additions:=array['billingEmail']; end if;
  fields:=orquivia_private.record_change_fields_before_invoice_mail(p_type,p_old-additions,p_new-additions);
  foreach field in array additions loop
    if p_old->field is distinct from p_new->field then fields:=array_append(fields,field); end if;
  end loop;
  return fields;
end; $$;

-- Functions below retain the same public signatures and grants. Full SMTP
-- acceptance changes only the delivery metadata of a canonical issued invoice.

create or replace function orquivia_private.issue_document(p_organization_id uuid,p_document_id text,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_state jsonb; next_state jsonb; old_version bigint; d jsonb; client jsonb; idx integer;
  v_year integer; seq bigint; num text; timestamp timestamptz:=now();
begin
  perform orquivia_private.require_member(p_organization_id);
  select state,version into old_state,old_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if old_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  select value,ordinality::integer-1 into d,idx from jsonb_array_elements(old_state->'documents') with ordinality where value->>'id'=p_document_id;
  if d is null or d->>'status'<>'draft' then raise exception 'DOCUMENT_NOT_DRAFT' using errcode='22023'; end if;
  if (d->>'date')::date>(timestamp at time zone 'Europe/Madrid')::date then raise exception 'INVALID_ISSUE_DATE' using errcode='22023'; end if;
  v_year:=extract(year from (d->>'date')::date);
  insert into public.orquivia_number_counters(organization_id,kind,year,last_sequence) values(p_organization_id,d->>'kind',v_year,1)
    on conflict(organization_id,kind,year) do update set last_sequence=public.orquivia_number_counters.last_sequence+1 returning last_sequence into seq;
  num:=case when d->>'kind'='invoice' then 'F-' else 'PR-' end||v_year||'-'||lpad(seq::text,greatest(3,length(seq::text)),'0');
  select c into client from jsonb_array_elements(old_state->'clients') c where c->>'id'=d->>'clientId';
  d:=d||jsonb_build_object('number',num,'status',case when d->>'kind'='invoice' then 'issued' else 'ready' end,
    'companySnapshot',old_state->'company','clientSnapshot',client,'paymentReviewNeeded',false);
  if d->>'kind'='invoice' then d:=d||jsonb_build_object('deliveryStatus','ready'); end if;
  next_state:=jsonb_set(old_state,array['documents',idx::text],d);
  if not orquivia_private.valid_state(next_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  insert into public.orquivia_document_numbers(organization_id,document_id,kind,year,sequence,number,issue_date,fiscal_data,source)
    values(p_organization_id,p_document_id,d->>'kind',v_year,seq,num,(d->>'date')::date,orquivia_private.fiscal_data(d),'issued');
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=timestamp where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'issue',old_version+1,old_state,next_state);
  return jsonb_build_object('state',next_state,'version',old_version+1,'updated_at',timestamp,'document_number',num);
end; $$;


create or replace function public.orquivia_mail_claim(p_user uuid,p_org uuid,p_id uuid,p_document text,p_version bigint,p_hash text,p_to jsonb,p_subject text,p_cc jsonb default '[]'::jsonb) returns jsonb
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
  if d is null or coalesce(d->>'number','')='' or not (
    (d->>'kind'='quote' and d->>'status' in ('ready','sent'))
    or (d->>'kind'='invoice' and d->>'status' in ('issued','partial','paid','overdue') and exists(
      select 1 from public.orquivia_document_numbers n where n.organization_id=p_org and n.document_id=p_document
        and n.kind='invoice' and n.number=d->>'number' and n.issue_date=(d->>'date')::date
        and n.fiscal_data=orquivia_private.fiscal_data(d)))) then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
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


create or replace function public.orquivia_mail_complete(p_user uuid,p_org uuid,p_id uuid,p_status text,p_delivery jsonb default null) returns jsonb
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

revoke all on function orquivia_private.valid_billing_email(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.valid_state_prepared_quotes_v5(jsonb),orquivia_private.record_change_fields_before_invoice_mail(text,jsonb,jsonb),
  orquivia_private.record_change_fields(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_billing_email(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.valid_state_prepared_quotes_v5(jsonb),orquivia_private.record_change_fields_before_invoice_mail(text,jsonb,jsonb),
  orquivia_private.record_change_fields(text,jsonb,jsonb) to service_role;
revoke all on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb),
  public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb),
  public.orquivia_mail_complete(uuid,uuid,uuid,text,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
