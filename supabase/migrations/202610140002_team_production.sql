-- Shared company workspace. Apply after 202610130001_orquivia.sql.
-- Existing per-user data is retained for an explicit operator import; no account
-- is automatically admitted to a company and the legacy browser API is disabled.
begin;
revoke all on public.orquivia_workspaces from anon, authenticated;
revoke all on function public.save_orquivia_state(jsonb,bigint) from public,anon,authenticated;
revoke all on function orquivia_private.save_state(jsonb,bigint) from public,anon,authenticated;

create or replace function orquivia_private.valid_date(p_text text) returns boolean
language plpgsql immutable set search_path='' as $$
declare d date;
begin
  if p_text is null or p_text !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  d := p_text::date;
  return to_char(d,'YYYY-MM-DD')=p_text;
exception when others then return false;
end; $$;

create or replace function orquivia_private.document_total(d jsonb) returns numeric
language plpgsql immutable set search_path='' as $$
declare subtotal numeric; base numeric;
begin
  select coalesce(sum(round((v->>'quantity')::numeric*(v->>'price')::numeric,2)),0)
    into subtotal from jsonb_array_elements(d->'items') v;
  base := subtotal-round(subtotal*coalesce((d->>'discount')::numeric,0)/100,2);
  return base+round(base*coalesce((d->>'vat')::numeric,0)/100,2)
    -round(base*coalesce((d->>'withholding')::numeric,0)/100,2);
end; $$;

create or replace function orquivia_private.number_sequence(p_kind text,p_number text,p_year integer) returns bigint
language plpgsql immutable set search_path='' as $$
declare matched text[]; n bigint;
begin
  if p_kind not in ('invoice','quote') then return null; end if;
  matched := regexp_match(p_number,'^(?:'||case when p_kind='invoice' then 'F-' else 'PR-' end||')?'||p_year||'-(\d+)$','i');
  if matched is null then return null; end if;
  n := matched[1]::bigint;
  return case when n>0 then n else null end;
exception when others then return null;
end; $$;

create or replace function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare collection text; r jsonb; item jsonb; d jsonb; field text; value numeric;
  amount numeric; total numeric; year integer; sequence bigint; seen text[]:=array[]::text[];
  today date:=(now() at time zone 'Europe/Madrid')::date;
begin
  if p_state is null or jsonb_typeof(p_state)<>'object' or jsonb_typeof(p_state->'company') is distinct from 'object'
    or octet_length(p_state::text)>5000000 then return false; end if;
  if jsonb_typeof(p_state->'company'->'name') is distinct from 'string' or btrim(p_state->'company'->>'name')='' then return false; end if;
  foreach field in array array['name','legalName','taxId','address','email','phone','iban','bic','notificationEmail','privacyText'] loop
    if (p_state->'company' ? field) and jsonb_typeof(p_state->'company'->field)<>'string' then return false; end if;
  end loop;
  if (p_state->'company' ? 'emailNotifications') and jsonb_typeof(p_state->'company'->'emailNotifications')<>'boolean' then return false; end if;
  if p_state->'company'->>'emailNotifications'='true' and coalesce(p_state->'company'->>'notificationEmail','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return false; end if;
  foreach field in array array['vat','withholding','paymentTerms'] loop
    if p_state->'company' ? field then
      if jsonb_typeof(p_state->'company'->field)<>'number' then return false; end if;
      value:=(p_state->'company'->>field)::numeric;
      if value<0 or value>(case when field='paymentTerms' then 365 else 100 end)
        or value<>round(value,case when field='paymentTerms' then 0 else 2 end) then return false; end if;
    end if;
  end loop;
  foreach collection in array array['clients','documents','payments'] loop
    if jsonb_typeof(p_state->collection) is distinct from 'array' or jsonb_array_length(p_state->collection)>10000 then return false; end if;
    for r in select v from jsonb_array_elements(p_state->collection) v loop
      if jsonb_typeof(r)<>'object' or jsonb_typeof(r->'id') is distinct from 'string' or btrim(r->>'id')='' or length(r->>'id')>160 then return false; end if;
    end loop;
    if (select count(*) from jsonb_array_elements(p_state->collection))<>(select count(distinct v->>'id') from jsonb_array_elements(p_state->collection) v) then return false; end if;
  end loop;
  for r in select v from jsonb_array_elements(p_state->'clients') v loop
    if jsonb_typeof(r->'name') is distinct from 'string' or btrim(r->>'name')='' then return false; end if;
    foreach field in array array['taxId','address','email','contact','phone'] loop
      if r ? field and jsonb_typeof(r->field)<>'string' then return false; end if;
    end loop;
  end loop;
  for d in select v from jsonb_array_elements(p_state->'documents') v loop
    if d->>'kind' not in ('invoice','quote') or jsonb_typeof(d->'kind') is distinct from 'string'
      or jsonb_typeof(d->'status') is distinct from 'string' or jsonb_typeof(d->'number') is distinct from 'string'
      or not orquivia_private.valid_date(d->>'date') then return false; end if;
    if (d->>'kind'='quote' and d->>'status' not in ('draft','sent','accepted','rejected'))
      or (d->>'kind'='invoice' and d->>'status' not in ('draft','issued','paid','partial','overdue')) then return false; end if;
    if d->>'status'<>'draft' and (btrim(d->>'number')='' or (d->>'date')::date>today) then return false; end if;
    foreach field in array array['title','notes','po','paymentMethod'] loop
      if d ? field and jsonb_typeof(d->field)<>'string' then return false; end if;
    end loop;
    foreach field in array array['contractReceived','paymentReviewNeeded'] loop
      if d ? field and jsonb_typeof(d->field)<>'boolean' then return false; end if;
    end loop;
    if d->>'paymentReviewNeeded'='true' and (d->>'kind'<>'invoice' or d->>'status'<>'issued') then return false; end if;
    if d->'dueDate' is not null and d->'dueDate'<>'null'::jsonb and d->>'dueDate'<>'' then
      if not orquivia_private.valid_date(d->>'dueDate') or (d->>'dueDate')::date<(d->>'date')::date then return false; end if;
    end if;
    if coalesce(d->>'contractExpectedDate','')<>'' and not orquivia_private.valid_date(d->>'contractExpectedDate') then return false; end if;
    foreach field in array array['sourceMetadata','companySnapshot','clientSnapshot'] loop
      if d ? field and jsonb_typeof(d->field)<>'object' then return false; end if;
    end loop;
    if d ? 'importWarnings' then
      if jsonb_typeof(d->'importWarnings')<>'array' or exists(select 1 from jsonb_array_elements(d->'importWarnings') v where jsonb_typeof(v)<>'string') then return false; end if;
    end if;
    if jsonb_typeof(d->'clientId') is distinct from 'string' or not exists(select 1 from jsonb_array_elements(p_state->'clients') c where c->>'id'=d->>'clientId') then return false; end if;
    if jsonb_typeof(d->'items') is distinct from 'array' or jsonb_array_length(d->'items')=0 then return false; end if;
    for item in select v from jsonb_array_elements(d->'items') v loop
      if jsonb_typeof(item)<>'object' or jsonb_typeof(item->'description') is distinct from 'string' or btrim(item->>'description')=''
        or jsonb_typeof(item->'quantity') is distinct from 'number' or jsonb_typeof(item->'price') is distinct from 'number' then return false; end if;
      if item ? 'detail' and jsonb_typeof(item->'detail')<>'string' then return false; end if;
      if (item->>'quantity')::numeric<=0 or (item->>'quantity')::numeric<>round((item->>'quantity')::numeric,3)
        or (item->>'price')::numeric<0 or (item->>'price')::numeric<>round((item->>'price')::numeric,2) then return false; end if;
      if (item->>'quantity')::numeric*(item->>'price')::numeric>90071992547409.91 then return false; end if;
    end loop;
    foreach field in array array['discount','vat','withholding'] loop
      if jsonb_typeof(d->field) is distinct from 'number' then return false; end if;
      value:=(d->>field)::numeric;
      if value<0 or value>100 or value<>round(value,2) then return false; end if;
    end loop;
    select coalesce(sum(round((v->>'quantity')::numeric*(v->>'price')::numeric,2)),0) into value from jsonb_array_elements(d->'items') v;
    if value>90071992547409.91 then return false; end if;
    total:=orquivia_private.document_total(d);
    if total<0 or total>90071992547409.91 then return false; end if;
    if d ? 'total' and (jsonb_typeof(d->'total')<>'number' or (d->>'total')::numeric<>total) then return false; end if;
    if btrim(d->>'number')<>'' then
      year:=extract(year from (d->>'date')::date); sequence:=orquivia_private.number_sequence(d->>'kind',d->>'number',year);
      field:=d->>'kind'||':'||case when sequence is null then 'raw:'||lower(btrim(d->>'number')) else year||':'||sequence end;
      if field=any(seen) then return false; end if; seen:=array_append(seen,field);
    end if;
    if coalesce(d->>'quoteId','')<>'' then
      if jsonb_typeof(d->'quoteId') is distinct from 'string' or d->>'kind'<>'invoice' or not exists(select 1 from jsonb_array_elements(p_state->'documents') q
        where q->>'id'=d->>'quoteId' and q->>'kind'='quote' and q->>'clientId'=d->>'clientId') then return false; end if;
      if (select count(*) from jsonb_array_elements(p_state->'documents') v where v->>'quoteId'=d->>'quoteId')>1 then return false; end if;
    end if;
  end loop;
  for r in select v from jsonb_array_elements(p_state->'payments') v loop
    if jsonb_typeof(r->'amount') is distinct from 'number' or not orquivia_private.valid_date(r->>'date') or (r->>'date')::date>today then return false; end if;
    amount:=(r->>'amount')::numeric;
    if amount<=0 or amount<>round(amount,2) or amount>90071992547409.91 then return false; end if;
    if r ? 'reference' and jsonb_typeof(r->'reference')<>'string' then return false; end if;
    if jsonb_typeof(r->'documentId') is distinct from 'string' or not exists(select 1 from jsonb_array_elements(p_state->'documents') v where v->>'id'=r->>'documentId' and v->>'kind'='invoice' and v->>'status'<>'draft') then return false; end if;
  end loop;
  for d in select v from jsonb_array_elements(p_state->'documents') v where v->>'kind'='invoice' loop
    total:=orquivia_private.document_total(d);
    select coalesce(sum((p->>'amount')::numeric),0) into amount from jsonb_array_elements(p_state->'payments') p where p->>'documentId'=d->>'id';
    if amount>total then return false; end if;
    if d->>'paymentReviewNeeded'='true' and amount>0 then return false; end if;
    if d->>'status'='paid' and amount<>total then return false; end if;
    if d->>'status'='partial' and not(amount>0 and amount<total) then return false; end if;
    if d->>'status'='overdue' and (amount>=total or not orquivia_private.valid_date(d->>'dueDate') or (d->>'dueDate')::date>=today) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end; $$;

create table public.orquivia_organizations (
  id uuid primary key default gen_random_uuid(), name text not null,
  require_mfa boolean not null default false, created_at timestamptz not null default now()
);
create table public.orquivia_memberships (
  organization_id uuid not null references public.orquivia_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check(role in ('admin','editor')), active boolean not null default true,
  created_at timestamptz not null default now(), primary key(organization_id,user_id), unique(user_id)
);
create table public.orquivia_team_workspaces (
  organization_id uuid primary key references public.orquivia_organizations(id),
  state jsonb not null check(orquivia_private.valid_state(state)),
  version bigint not null default 1 check(version>0), updated_at timestamptz not null default now()
);
create table public.orquivia_number_counters (
  organization_id uuid not null references public.orquivia_organizations(id), kind text not null check(kind in ('invoice','quote')),
  year integer not null check(year between 1 and 9999), last_sequence bigint not null check(last_sequence>=0),
  primary key(organization_id,kind,year)
);
create table public.orquivia_document_numbers (
  organization_id uuid not null references public.orquivia_organizations(id), document_id text not null,
  kind text not null check(kind in ('invoice','quote')), year integer not null, sequence bigint,
  number text not null, issue_date date not null, fiscal_data jsonb not null,
  source text not null check(source in ('issued','imported')), issued_at timestamptz not null default now(),
  primary key(organization_id,document_id), unique(organization_id,kind,year,sequence), unique(organization_id,kind,number)
);
create table public.orquivia_audit_log (
  id bigint generated always as identity primary key, organization_id uuid not null references public.orquivia_organizations(id),
  actor_id uuid, actor_email text, event text not null, workspace_version bigint not null,
  changes jsonb not null, state_digest text not null, created_at timestamptz not null default now()
);
create index on public.orquivia_audit_log(organization_id,id desc);

create or replace function orquivia_private.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.orquivia_memberships m join public.orquivia_organizations o on o.id=m.organization_id
    where m.organization_id=p_org and m.user_id=auth.uid() and m.active and (not o.require_mfa or coalesce(auth.jwt()->>'aal','aal1')='aal2'));
$$;
revoke all on function orquivia_private.is_member(uuid) from public,anon,authenticated;
grant execute on function orquivia_private.is_member(uuid) to authenticated;

alter table public.orquivia_memberships enable row level security;
revoke all on public.orquivia_memberships from public,anon,authenticated;
grant select on public.orquivia_memberships to authenticated;
grant all on public.orquivia_memberships to service_role;
create policy "Own membership only" on public.orquivia_memberships for select to authenticated using(user_id=(select auth.uid()));
do $$ declare tab text;
begin
  foreach tab in array array['orquivia_organizations','orquivia_team_workspaces','orquivia_number_counters','orquivia_document_numbers','orquivia_audit_log'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from public,anon,authenticated',tab);
    execute format('grant select on public.%I to authenticated',tab);
    execute format('grant all on public.%I to service_role',tab);
    execute format('create policy "Company members read" on public.%I for select to authenticated using(orquivia_private.is_member(%I))',tab,case when tab='orquivia_organizations' then 'id' else 'organization_id' end);
  end loop;
end; $$;
grant usage,select on sequence public.orquivia_audit_log_id_seq to service_role;

create or replace function orquivia_private.require_member(p_org uuid) returns text
language plpgsql security definer set search_path='' as $$
declare member_role text; mfa_required boolean;
begin
  select m.role,o.require_mfa into member_role,mfa_required from public.orquivia_memberships m
    join public.orquivia_organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=auth.uid() and m.active;
  if member_role is null then raise exception 'MEMBERSHIP_REQUIRED' using errcode='42501'; end if;
  if mfa_required and coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'MFA_REQUIRED' using errcode='42501'; end if;
  return member_role;
end; $$;

create or replace function orquivia_private.fiscal_data(d jsonb) returns jsonb
language sql immutable set search_path='' as $$
  -- Only collection/payment status and operational follow-up fields can change.
  -- This also protects source evidence and any future fiscal fields by default.
  select d-array['status','total','notes','po','dueDate','contractExpectedDate','contractReceived','paymentReviewNeeded'];
$$;
create or replace function orquivia_private.normalized_state(s jsonb) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_set(s,'{documents}',coalesce((select jsonb_agg(d||jsonb_build_object('total',orquivia_private.document_total(d))) from jsonb_array_elements(s->'documents') d),'[]'::jsonb));
$$;
create or replace function orquivia_private.check_issued(p_org uuid,p_previous jsonb,p_next jsonb) returns void
language plpgsql set search_path='' as $$
declare d jsonb; issued public.orquivia_document_numbers%rowtype;
begin
  for d in select v from jsonb_array_elements(p_previous->'documents') v where v->>'status'<>'draft' loop
    if not exists(select 1 from jsonb_array_elements(p_next->'documents') n where n->>'id'=d->>'id') then raise exception 'ISSUED_DOCUMENT_DELETE_DENIED' using errcode='22023'; end if;
  end loop;
  for d in select v from jsonb_array_elements(p_next->'documents') v loop
    select * into issued from public.orquivia_document_numbers where organization_id=p_org and document_id=d->>'id';
    if issued.document_id is null then
      if d->>'status'<>'draft' or d->>'number'<>'' then raise exception 'ISSUE_REQUIRED' using errcode='22023'; end if;
    elsif d->>'status'='draft' or d->>'number'<>issued.number or d->>'kind'<>issued.kind or (d->>'date')::date<>issued.issue_date
      or (issued.kind='invoice' and orquivia_private.fiscal_data(d)<>issued.fiscal_data) then
      raise exception 'ISSUED_DOCUMENT_IMMUTABLE' using errcode='22023';
    end if;
  end loop;
end; $$;
create or replace function orquivia_private.audit(p_org uuid,p_event text,p_version bigint,p_old jsonb,p_new jsonb,p_actor uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=coalesce(p_actor,auth.uid()); email text; summary jsonb;
begin
  select u.email into email from auth.users u where u.id=actor;
  summary:=jsonb_build_object('documentCount',jsonb_array_length(p_new->'documents'),'paymentCount',jsonb_array_length(p_new->'payments'),
    'companyChanged',p_old->'company' is distinct from p_new->'company','previousDigest',case when p_old is null then null else md5(p_old::text) end);
  insert into public.orquivia_audit_log(organization_id,actor_id,actor_email,event,workspace_version,changes,state_digest)
    values(p_org,actor,email,p_event,p_version,summary,md5(p_new::text));
end; $$;

create or replace function orquivia_private.load_workspace() returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; role text; result jsonb;
begin
  select organization_id into org from public.orquivia_memberships where user_id=auth.uid() and active;
  role:=orquivia_private.require_member(org);
  select jsonb_build_object('organization_id',org,'organization_name',o.name,'require_mfa',o.require_mfa,'role',role,'state',w.state,'version',w.version,'updated_at',w.updated_at)
    into result from public.orquivia_team_workspaces w join public.orquivia_organizations o on o.id=w.organization_id where w.organization_id=org;
  return result;
end; $$;
create or replace function orquivia_private.refresh_access() returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid; role text; result jsonb;
begin
  select organization_id into org from public.orquivia_memberships where user_id=auth.uid() and active;
  role:=orquivia_private.require_member(org);
  select jsonb_build_object('organization_id',org,'organization_name',o.name,'require_mfa',o.require_mfa,'role',role)
    into result from public.orquivia_organizations o where o.id=org;
  return result;
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
  next_state:=orquivia_private.normalized_state(p_state);
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=timestamp where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'save',old_version+1,old_state,next_state);
  return jsonb_build_object('version',old_version+1,'updated_at',timestamp);
end; $$;
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
  d:=d||jsonb_build_object('number',num,'status',case when d->>'kind'='invoice' then 'issued' else 'sent' end,
    'companySnapshot',old_state->'company','clientSnapshot',client,'paymentReviewNeeded',false);
  next_state:=jsonb_set(old_state,array['documents',idx::text],d);
  if not orquivia_private.valid_state(next_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  insert into public.orquivia_document_numbers(organization_id,document_id,kind,year,sequence,number,issue_date,fiscal_data,source)
    values(p_organization_id,p_document_id,d->>'kind',v_year,seq,num,(d->>'date')::date,orquivia_private.fiscal_data(d),'issued');
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=timestamp where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'issue',old_version+1,old_state,next_state);
  return jsonb_build_object('state',next_state,'version',old_version+1,'updated_at',timestamp,'document_number',num);
end; $$;

create or replace function public.load_orquivia_workspace() returns jsonb language sql security invoker set search_path='' as $$select orquivia_private.load_workspace();$$;
create or replace function public.refresh_orquivia_access() returns jsonb language sql security invoker set search_path='' as $$select orquivia_private.refresh_access();$$;
create or replace function public.save_orquivia_team_state(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$select orquivia_private.save_team(p_organization_id,p_state,p_expected_version);$$;
create or replace function public.issue_orquivia_document(p_organization_id uuid,p_document_id text,p_expected_version bigint) returns jsonb
language sql security invoker set search_path='' as $$select orquivia_private.issue_document(p_organization_id,p_document_id,p_expected_version);$$;

-- Server-only provisioning and historical import. Browser users cannot add members.
create or replace function public.bootstrap_orquivia_team(p_admin_user_id uuid,p_editor_user_id uuid,p_name text default 'Orquívia',p_organization_id uuid default null) returns uuid
language plpgsql security invoker set search_path='' as $$
declare org uuid:=coalesce(p_organization_id,gen_random_uuid()); initial jsonb; inserted integer;
begin
  if p_admin_user_id=p_editor_user_id then raise exception 'DISTINCT_USERS_REQUIRED'; end if;
  insert into public.orquivia_organizations(id,name) values(org,p_name) on conflict(id) do nothing;
  insert into public.orquivia_memberships(organization_id,user_id,role) values(org,p_admin_user_id,'admin'),(org,p_editor_user_id,'editor')
    on conflict(organization_id,user_id) do update set role=excluded.role,active=true;
  initial:='{"company":{"name":"Orquívia","legalName":"","taxId":"","address":"","email":"","phone":"","iban":"","bic":"","vat":21,"withholding":0,"paymentTerms":30,"emailNotifications":false,"notificationEmail":""},"clients":[],"documents":[],"payments":[]}'::jsonb;
  insert into public.orquivia_team_workspaces(organization_id,state) values(org,initial) on conflict(organization_id) do nothing;
  get diagnostics inserted=row_count;
  if inserted=1 then perform orquivia_private.audit(org,'bootstrap',1,null,initial,p_admin_user_id); end if;
  return org;
end; $$;
create or replace function public.import_orquivia_state(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare previous jsonb; old_version bigint; d jsonb; yr integer; seq bigint; ledger public.orquivia_document_numbers%rowtype; next_state jsonb;
begin
  select state,version into previous,old_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if old_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  if not orquivia_private.valid_state(p_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  for d in select v from jsonb_array_elements(p_state->'documents') v where v->>'status'<>'draft' loop
    yr:=extract(year from (d->>'date')::date); seq:=orquivia_private.number_sequence(d->>'kind',d->>'number',yr);
    select * into ledger from public.orquivia_document_numbers where organization_id=p_organization_id and document_id=d->>'id';
    if ledger.document_id is not null then
      if ledger.number<>d->>'number' or ledger.kind<>d->>'kind' or ledger.issue_date<>(d->>'date')::date
        or (ledger.kind='invoice' and ledger.fiscal_data<>orquivia_private.fiscal_data(d)) then raise exception 'ISSUED_DOCUMENT_IMMUTABLE'; end if;
    else
      insert into public.orquivia_document_numbers(organization_id,document_id,kind,year,sequence,number,issue_date,fiscal_data,source)
        values(p_organization_id,d->>'id',d->>'kind',yr,seq,d->>'number',(d->>'date')::date,orquivia_private.fiscal_data(d),'imported');
    end if;
    if seq is not null then
      insert into public.orquivia_number_counters(organization_id,kind,year,last_sequence) values(p_organization_id,d->>'kind',yr,seq)
        on conflict(organization_id,kind,year) do update set last_sequence=greatest(public.orquivia_number_counters.last_sequence,excluded.last_sequence);
    end if;
  end loop;
  perform orquivia_private.check_issued(p_organization_id,previous,p_state);
  next_state:=orquivia_private.normalized_state(p_state);
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=now() where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'historical_import',old_version+1,previous,next_state);
  return jsonb_build_object('version',old_version+1,'document_count',jsonb_array_length(next_state->'documents'));
end; $$;

-- Restrict every private routine after creation; grant only the deliberate entry points.
revoke all on all functions in schema orquivia_private from public,anon,authenticated;
grant execute on function orquivia_private.is_member(uuid),orquivia_private.load_workspace(),orquivia_private.refresh_access(),orquivia_private.save_team(uuid,jsonb,bigint),orquivia_private.issue_document(uuid,text,bigint) to authenticated;
grant execute on all functions in schema orquivia_private to service_role;
revoke all on function public.load_orquivia_workspace(),public.refresh_orquivia_access(),public.save_orquivia_team_state(uuid,jsonb,bigint),public.issue_orquivia_document(uuid,text,bigint),public.bootstrap_orquivia_team(uuid,uuid,text,uuid),public.import_orquivia_state(uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.load_orquivia_workspace(),public.refresh_orquivia_access(),public.save_orquivia_team_state(uuid,jsonb,bigint),public.issue_orquivia_document(uuid,text,bigint) to authenticated;
grant execute on function public.bootstrap_orquivia_team(uuid,uuid,text,uuid),public.import_orquivia_state(uuid,jsonb,bigint) to service_role;

create table public.orquivia_team_reminder_deliveries (
  organization_id uuid not null references public.orquivia_organizations(id), reminder_date date not null,
  status text not null default 'pending' check(status in ('pending','sent','failed','cancelled')),
  email_payload jsonb not null check(jsonb_typeof(email_payload)='object'), lease_token uuid not null,
  claimed_at timestamptz not null default now(), sent_at timestamptz, provider_id text, error text,
  primary key(organization_id,reminder_date)
);
alter table public.orquivia_team_reminder_deliveries enable row level security;
revoke all on public.orquivia_team_reminder_deliveries from public,anon,authenticated;
grant all on public.orquivia_team_reminder_deliveries to service_role;
create or replace function public.claim_orquivia_team_reminder(p_organization_id uuid,p_date date,p_lease_token uuid,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
  insert into public.orquivia_team_reminder_deliveries(organization_id,reminder_date,lease_token,email_payload)
    values(p_organization_id,p_date,p_lease_token,p_payload)
    on conflict(organization_id,reminder_date) do update set status='pending',lease_token=excluded.lease_token,claimed_at=now(),error=null
      where public.orquivia_team_reminder_deliveries.status='failed' or (public.orquivia_team_reminder_deliveries.status='pending' and public.orquivia_team_reminder_deliveries.claimed_at<now()-interval '10 minutes')
    returning email_payload into result;
  return result;
end; $$;
revoke all on function public.claim_orquivia_team_reminder(uuid,date,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.claim_orquivia_team_reminder(uuid,date,uuid,jsonb) to service_role;
commit;
