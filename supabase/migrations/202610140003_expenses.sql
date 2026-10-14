-- Expenses and private receipt originals. Apply after the team production migration.
-- No bucket is public and no browser key can bypass organization membership/MFA.
begin;

create function orquivia_private.receipt_mime(p_extension text) returns text
language sql immutable set search_path='' as $$
  select case p_extension
    when 'pdf' then 'application/pdf' when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png' when 'webp' then 'image/webp' when 'gif' then 'image/gif'
    when 'heic' then 'image/heic' when 'heif' then 'image/heif'
    when 'doc' then 'application/msword'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xls' then 'application/vnd.ms-excel'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'odt' then 'application/vnd.oasis.opendocument.text'
    when 'ods' then 'application/vnd.oasis.opendocument.spreadsheet'
    when 'rtf' then 'application/rtf' else null end;
$$;
create function orquivia_private.receipt_path_valid(p_path text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|jpeg|png|webp|gif|heic|heif|doc|docx|xls|xlsx|odt|ods|rtf)$',false);
$$;
create function orquivia_private.receipt_org(p_path text) returns uuid
language plpgsql immutable set search_path='' as $$
begin
  if not orquivia_private.receipt_path_valid(p_path) then return null; end if;
  return split_part(p_path,'/',1)::uuid;
end; $$;

-- Keep all existing document, payment and invoice immutability validation intact.
alter function orquivia_private.valid_state(jsonb) rename to valid_state_documents;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare e jsonb; a jsonb; field text; value numeric; base numeric; vat numeric; total numeric;
  today date:=(now() at time zone 'Europe/Madrid')::date;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  paths text[]:=array[]::text[]; ids text[]:=array[]::text[];
begin
  if not orquivia_private.valid_state_documents(p_state) then return false; end if;
  if p_state->'company' ? 'openingBalance' or p_state->'company' ? 'openingBalanceDate' then
    if jsonb_typeof(p_state->'company'->'openingBalance') is distinct from 'number'
      or not orquivia_private.valid_date(p_state->'company'->>'openingBalanceDate')
      or (p_state->'company'->>'openingBalanceDate')::date>today then return false; end if;
    value:=(p_state->'company'->>'openingBalance')::numeric;
    if abs(value)>90071992547409.91 or value<>round(value,2) then return false; end if;
  end if;
  if not(p_state ? 'expenses') then return true; end if;
  if jsonb_typeof(p_state->'expenses') is distinct from 'array' or jsonb_array_length(p_state->'expenses')>10000 then return false; end if;
  if (select count(*) from jsonb_array_elements(p_state->'expenses'))<>(select count(distinct v->>'id') from jsonb_array_elements(p_state->'expenses') v) then return false; end if;
  for e in select v from jsonb_array_elements(p_state->'expenses') v loop
    if jsonb_typeof(e)<>'object' or jsonb_typeof(e->'id') is distinct from 'string' or e->>'id' !~ uuid_pattern
      or not orquivia_private.valid_date(e->>'date') or (e->>'date')::date>today
      or jsonb_typeof(e->'supplier') is distinct from 'string' or btrim(e->>'supplier')='' or length(e->>'supplier')>240
      or jsonb_typeof(e->'description') is distinct from 'string' or btrim(e->>'description')='' or length(e->>'description')>2000 then return false; end if;
    foreach field in array array['category','supplierTaxId','reference','notes'] loop
      if e ? field and (jsonb_typeof(e->field)<>'string' or length(e->>field)>(case field when 'category' then 100 when 'supplierTaxId' then 80 when 'reference' then 240 else 10000 end)) then return false; end if;
    end loop;
    foreach field in array array['base','vatAmount','total'] loop
      if jsonb_typeof(e->field) is distinct from 'number' then return false; end if;
      value:=(e->>field)::numeric;
      if value<0 or value>90071992547409.91 or value<>round(value,2) then return false; end if;
    end loop;
    base:=(e->>'base')::numeric; vat:=(e->>'vatAmount')::numeric; total:=(e->>'total')::numeric;
    if total<=0 or total<>base+vat then return false; end if;
    if e ? 'vatRate' then
      if jsonb_typeof(e->'vatRate')<>'number' then return false; end if;
      value:=(e->>'vatRate')::numeric;
      if value<0 or value>100 or value<>round(value,2) then return false; end if;
    end if;
    if e ? 'vatDeductibleAmount' then
      if jsonb_typeof(e->'vatDeductibleAmount')<>'number' then return false; end if;
      value:=(e->>'vatDeductibleAmount')::numeric;
      if value<0 or value>vat or value<>round(value,2) then return false; end if;
    end if;
    if e ? 'reviewNeeded' and jsonb_typeof(e->'reviewNeeded')<>'boolean' then return false; end if;
    if jsonb_typeof(e->'paymentStatus') is distinct from 'string' or e->>'paymentStatus' not in ('paid','pending') then return false; end if;
    if e->>'paymentStatus'='paid' then
      if not orquivia_private.valid_date(e->>'paidDate') or (e->>'paidDate')::date>today then return false; end if;
    elsif coalesce(e->>'paidDate','')<>'' then return false; end if;
    if e ? 'attachments' then
      if jsonb_typeof(e->'attachments')<>'array' or jsonb_array_length(e->'attachments')>10 then return false; end if;
      for a in select v from jsonb_array_elements(e->'attachments') v loop
        if jsonb_typeof(a)<>'object' or jsonb_typeof(a->'id') is distinct from 'string' or a->>'id' !~ uuid_pattern
          or jsonb_typeof(a->'name') is distinct from 'string' or btrim(a->>'name')='' or length(a->>'name')>240
          or a->>'name' ~ '[[:cntrl:]\\/]'
          or jsonb_typeof(a->'path') is distinct from 'string' or not orquivia_private.receipt_path_valid(a->>'path')
          or split_part(a->>'path','/',2)<>e->>'id'
          or split_part(split_part(a->>'path','/',3),'.',1)<>a->>'id'
          or jsonb_typeof(a->'mimeType') is distinct from 'string'
          or a->>'mimeType' is distinct from orquivia_private.receipt_mime(split_part(split_part(a->>'path','/',3),'.',2))
          or jsonb_typeof(a->'size') is distinct from 'number' then return false; end if;
        value:=(a->>'size')::numeric;
        if value<1 or value>10485760 or value<>round(value,0) or a->>'path'=any(paths) or a->>'id'=any(ids) then return false; end if;
        paths:=array_append(paths,a->>'path'); ids:=array_append(ids,a->>'id');
      end loop;
    end if;
  end loop;
  return true;
exception when others then return false;
end; $$;
alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('orquivia-receipts','orquivia-receipts',false,10485760,array[
  'application/pdf','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif',
  'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text','application/vnd.oasis.opendocument.spreadsheet','application/rtf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create function orquivia_private.receipt_member(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
  select orquivia_private.receipt_path_valid(p_path) and orquivia_private.is_member(orquivia_private.receipt_org(p_path));
$$;
create function orquivia_private.receipt_unreferenced(p_path text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare state jsonb; org uuid:=orquivia_private.receipt_org(p_path);
begin
  if org is null or not orquivia_private.is_member(org) then return false; end if;
  -- Serialize receipt deletion with CAS workspace saves to prevent references
  -- from being attached to an object while another request deletes that object.
  select w.state into state from public.orquivia_team_workspaces w where w.organization_id=org for update;
  return state is not null and not exists(
    select 1 from jsonb_array_elements(coalesce(state->'expenses','[]'::jsonb)) e,
      jsonb_array_elements(coalesce(e->'attachments','[]'::jsonb)) a where a->>'path'=p_path);
end; $$;

create policy "Orquivia receipt members read" on storage.objects for select to authenticated
  using(bucket_id='orquivia-receipts' and orquivia_private.receipt_member(name));
create policy "Orquivia receipt members upload" on storage.objects for insert to authenticated
  with check(bucket_id='orquivia-receipts' and orquivia_private.receipt_member(name));
create policy "Orquivia unreferenced receipts delete" on storage.objects for delete to authenticated
  using(bucket_id='orquivia-receipts' and orquivia_private.receipt_unreferenced(name));
-- Restrictive guards retain the boundary even if a future generic Storage policy
-- is added for another bucket. Original files cannot be overwritten or moved.
create policy "Orquivia receipts authenticated boundary" on storage.objects as restrictive for all to authenticated
  using(bucket_id<>'orquivia-receipts' or orquivia_private.receipt_member(name))
  with check(bucket_id<>'orquivia-receipts' or orquivia_private.receipt_member(name));
create policy "Orquivia receipts anonymous boundary" on storage.objects as restrictive for all to anon
  using(bucket_id<>'orquivia-receipts') with check(bucket_id<>'orquivia-receipts');
create policy "Orquivia receipts immutable originals" on storage.objects as restrictive for update to authenticated
  using(bucket_id<>'orquivia-receipts') with check(bucket_id<>'orquivia-receipts');
create policy "Orquivia receipts keep linked originals" on storage.objects as restrictive for delete to authenticated
  using(bucket_id<>'orquivia-receipts' or orquivia_private.receipt_unreferenced(name));

create function orquivia_private.check_receipts(p_org uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare e jsonb; a jsonb;
begin
  for e in select v from jsonb_array_elements(coalesce(p_state->'expenses','[]'::jsonb)) v loop
    for a in select v from jsonb_array_elements(coalesce(e->'attachments','[]'::jsonb)) v loop
      if orquivia_private.receipt_org(a->>'path') is distinct from p_org or not exists(
        select 1 from storage.objects o where o.bucket_id='orquivia-receipts' and o.name=a->>'path'
          and (o.metadata->>'size')::numeric=(a->>'size')::numeric
          and o.metadata->>'mimetype'=a->>'mimeType') then
        raise exception 'INVALID_RECEIPT_REFERENCE' using errcode='22023';
      end if;
    end loop;
  end loop;
end; $$;

create or replace function orquivia_private.save_team(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare role text; old_state jsonb; old_version bigint; next_state jsonb; timestamp timestamptz:=now();
begin
  role:=orquivia_private.require_member(p_organization_id);
  select state,version into old_state,old_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if old_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if not orquivia_private.valid_state(p_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  if role<>'admin' and old_state->'company' is distinct from p_state->'company' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  perform orquivia_private.check_issued(p_organization_id,old_state,p_state);
  perform orquivia_private.check_receipts(p_organization_id,p_state);
  next_state:=orquivia_private.normalized_state(p_state);
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=timestamp where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'save',old_version+1,old_state,next_state);
  return jsonb_build_object('version',old_version+1,'updated_at',timestamp);
end; $$;
create or replace function orquivia_private.audit(p_org uuid,p_event text,p_version bigint,p_old jsonb,p_new jsonb,p_actor uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=coalesce(p_actor,auth.uid()); email text; summary jsonb;
begin
  select u.email into email from auth.users u where u.id=actor;
  summary:=jsonb_build_object('documentCount',jsonb_array_length(p_new->'documents'),'paymentCount',jsonb_array_length(p_new->'payments'),
    'expenseCount',jsonb_array_length(coalesce(p_new->'expenses','[]'::jsonb)),
    'expensesChanged',p_old->'expenses' is distinct from p_new->'expenses',
    'companyChanged',p_old->'company' is distinct from p_new->'company','previousDigest',case when p_old is null then null else md5(p_old::text) end);
  insert into public.orquivia_audit_log(organization_id,actor_id,actor_email,event,workspace_version,changes,state_digest)
    values(p_org,actor,email,p_event,p_version,summary,md5(p_new::text));
end; $$;

revoke all on function orquivia_private.receipt_mime(text),orquivia_private.receipt_path_valid(text),orquivia_private.receipt_org(text),
  orquivia_private.valid_state(jsonb),orquivia_private.valid_state_documents(jsonb),orquivia_private.receipt_member(text),
  orquivia_private.receipt_unreferenced(text),orquivia_private.check_receipts(uuid,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.receipt_member(text),orquivia_private.receipt_unreferenced(text) to authenticated;
grant execute on all functions in schema orquivia_private to service_role;
commit;
