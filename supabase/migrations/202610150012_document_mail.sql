-- Additive mail feature. Existing v1.0 financial APIs and schemas stay intact.
begin;
create extension if not exists supabase_vault with schema vault;
create table orquivia_private.mail_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.orquivia_organizations(id),
  signature jsonb not null default '{}'::jsonb,
  provider text not null default 'serviciodecorreo' check(provider in ('serviciodecorreo','arsys')),
  secret_id uuid, sent_folder text, version bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table orquivia_private.mail_jobs (
  id uuid primary key,
  organization_id uuid not null references public.orquivia_organizations(id),
  user_id uuid not null references auth.users(id), document_id text not null,
  request_hash text not null, document_snapshot jsonb not null,
  sender text not null, recipients jsonb not null, subject text not null,
  status text not null check(status in ('sending','sent','archive_pending','failed','uncertain')),
  raw_message bytea, message_id text, pdf_hash text,
  created_at timestamptz not null default now(), sent_at timestamptz,
  archive_lease_until timestamptz, error_code text,
  check(raw_message is null or octet_length(raw_message)<=6000000)
);
create index mail_jobs_history on orquivia_private.mail_jobs(organization_id,document_id,created_at desc);
create table orquivia_private.mail_connection_attempts(user_id uuid not null,created_at timestamptz not null default now());
alter table orquivia_private.mail_profiles enable row level security;
alter table orquivia_private.mail_jobs enable row level security;
alter table orquivia_private.mail_connection_attempts enable row level security;
create index mail_jobs_rate on orquivia_private.mail_jobs(user_id,created_at);
create index mail_connection_rate on orquivia_private.mail_connection_attempts(user_id,created_at);
revoke all on orquivia_private.mail_profiles,orquivia_private.mail_jobs,orquivia_private.mail_connection_attempts from public,anon,authenticated;

create function orquivia_private.mail_member(p_user uuid,p_org uuid) returns text
language plpgsql security definer set search_path='' as $$
declare email text;
begin
  if not exists(select 1 from public.orquivia_memberships where user_id=p_user and organization_id=p_org and active) then raise exception 'MEMBERSHIP_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from auth.mfa_factors where user_id=p_user and status='verified') then raise exception 'MFA_REQUIRED' using errcode='42501'; end if;
  select u.email into email from auth.users u where id=p_user;
  if email is null then raise exception 'MEMBERSHIP_REQUIRED' using errcode='42501'; end if;
  return email;
end; $$;

create function orquivia_private.mail_job_json(j orquivia_private.mail_jobs) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('id',j.id,'documentId',j.document_id,'sender',j.sender,'to',j.recipients,'subject',j.subject,
    'status',case when j.status='sending' and j.created_at<now()-interval '3 minutes' then 'uncertain' else j.status end,
    'createdAt',j.created_at,'sentAt',j.sent_at,'errorCode',j.error_code,'pdfHash',j.pdf_hash);
$$;

create function public.orquivia_mail_profile(p_user uuid,p_org uuid,p_secrets boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare email text:=orquivia_private.mail_member(p_user,p_org); p orquivia_private.mail_profiles; result jsonb;
begin
  select * into p from orquivia_private.mail_profiles where user_id=p_user and organization_id=p_org;
  result:=jsonb_build_object('email',email,'signature',coalesce(p.signature,'{}'::jsonb),'provider',coalesce(p.provider,'serviciodecorreo'),
    'connected',p.secret_id is not null,'version',coalesce(p.version,0));
  if p_secrets and p.secret_id is not null then
    result:=result||jsonb_build_object('password',(select decrypted_secret from vault.decrypted_secrets where id=p.secret_id),'sentFolder',p.sent_folder);
  end if;
  return result;
end; $$;

create function public.orquivia_mail_save_profile(p_user uuid,p_org uuid,p_expected_version bigint,p_signature jsonb,p_provider text default null,p_password text default null,p_folder text default null,p_disconnect boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p orquivia_private.mail_profiles; field text; secret uuid;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  perform pg_advisory_xact_lock(hashtextextended('mail-profile:'||p_user,0));
  select * into p from orquivia_private.mail_profiles where user_id=p_user for update;
  if coalesce(p.version,0)<>p_expected_version then raise exception 'PROFILE_CONFLICT' using errcode='40001'; end if;
  if jsonb_typeof(p_signature)<>'object' or length(p_signature->>'name') not between 1 and 100 then raise exception 'INVALID_SIGNATURE'; end if;
  foreach field in array array['name','role','phone'] loop
    if jsonb_typeof(p_signature->field) is distinct from 'string' or p_signature->>field ~ '[[:cntrl:]]'
      or length(p_signature->>field)>(case field when 'name' then 100 when 'role' then 120 else 40 end) then raise exception 'INVALID_SIGNATURE'; end if;
  end loop;
  if p_provider is not null and p_provider not in ('serviciodecorreo','arsys') then raise exception 'INVALID_PROVIDER'; end if;
  secret:=p.secret_id;
  if p_password is not null then
    if length(p_password) not between 1 and 1024 or length(p_folder) not between 1 and 255 then raise exception 'INVALID_CONNECTION'; end if;
    if secret is null then select vault.create_secret(p_password) into secret;
    else perform vault.update_secret(secret,p_password); end if;
  end if;
  if p_disconnect then
    if secret is not null then delete from vault.secrets where id=secret; end if;
    secret:=null;
  end if;
  insert into orquivia_private.mail_profiles(user_id,organization_id,signature,provider,secret_id,sent_folder,version)
    values(p_user,p_org,p_signature,coalesce(p_provider,p.provider,'serviciodecorreo'),secret,case when p_disconnect then null else coalesce(p_folder,p.sent_folder) end,coalesce(p.version,0)+1)
    on conflict(user_id) do update set signature=excluded.signature,provider=excluded.provider,secret_id=excluded.secret_id,sent_folder=excluded.sent_folder,version=excluded.version,updated_at=now();
  return public.orquivia_mail_profile(p_user,p_org,false);
end; $$;

create function public.orquivia_mail_connection_attempt(p_user uuid,p_org uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.mail_member(p_user,p_org);
  perform pg_advisory_xact_lock(hashtextextended('mail-connect:'||p_user,0));
  if (select count(*) from orquivia_private.mail_connection_attempts where user_id=p_user and created_at>now()-interval '1 minute')>=5 then raise exception 'RATE_LIMITED'; end if;
  insert into orquivia_private.mail_connection_attempts(user_id) values(p_user);
end; $$;

create function public.orquivia_mail_claim(p_user uuid,p_org uuid,p_id uuid,p_document text,p_version bigint,p_hash text,p_to jsonb,p_subject text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare email text:=orquivia_private.mail_member(p_user,p_org); j orquivia_private.mail_jobs; s jsonb; v bigint; d jsonb;
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
  if jsonb_typeof(p_to)<>'array' or jsonb_array_length(p_to)<>1 or jsonb_typeof(p_to->0)<>'string' or p_to->>0 ~ '[[:cntrl:]]'
    or length(p_subject) not between 1 and 200 or p_subject ~ '[[:cntrl:]]' then raise exception 'INVALID_MESSAGE'; end if;
  insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,subject,status)
    values(p_id,p_org,p_user,p_document,p_hash,d,email,p_to,p_subject,'sending') returning * into j;
  return jsonb_build_object('existing',false,'job',orquivia_private.mail_job_json(j),'document',d,'company',coalesce(d->'companySnapshot',s->'company'),
    'client',coalesce(d->'clientSnapshot',(select value from jsonb_array_elements(s->'clients') where value->>'id'=d->>'clientId')));
end; $$;

create function public.orquivia_mail_store_message(p_user uuid,p_org uuid,p_id uuid,p_raw text,p_message_id text,p_pdf_hash text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.mail_member(p_user,p_org);
  update orquivia_private.mail_jobs set raw_message=decode(p_raw,'base64'),message_id=p_message_id,pdf_hash=p_pdf_hash
    where id=p_id and user_id=p_user and organization_id=p_org and status='sending' and raw_message is null;
  if not found then raise exception 'INVALID_MAIL_JOB'; end if;
end; $$;

create function public.orquivia_mail_complete(p_user uuid,p_org uuid,p_id uuid,p_status text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j orquivia_private.mail_jobs; old_state jsonb; next_state jsonb; v bigint; d jsonb; idx integer; result jsonb;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  select * into j from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or p_status not in ('failed','uncertain','archive_pending','sent') then raise exception 'INVALID_MAIL_JOB'; end if;
  if j.status not in ('sending','archive_pending') or (j.status='archive_pending' and p_status not in ('archive_pending','sent')) then return jsonb_build_object('job',orquivia_private.mail_job_json(j)); end if;
  update orquivia_private.mail_jobs set status=p_status,sent_at=case when p_status in ('sent','archive_pending') then coalesce(sent_at,now()) else sent_at end,
    archive_lease_until=null where id=p_id returning * into j;
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

create function public.orquivia_mail_archive_claim(p_user uuid,p_org uuid,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j orquivia_private.mail_jobs;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  select * into j from orquivia_private.mail_jobs where id=p_id and user_id=p_user and organization_id=p_org for update;
  if not found or j.status<>'archive_pending' or j.archive_lease_until>now() then raise exception 'INVALID_MAIL_JOB'; end if;
  update orquivia_private.mail_jobs set archive_lease_until=now()+interval '90 seconds' where id=p_id;
  return jsonb_build_object('raw',encode(j.raw_message,'base64'),'messageId',j.message_id);
end; $$;

create function public.orquivia_mail_history(p_user uuid,p_org uuid,p_document text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.mail_member(p_user,p_org);
  return jsonb_build_object('history',coalesce((select jsonb_agg(orquivia_private.mail_job_json(j) order by j.created_at desc)
    from (select * from orquivia_private.mail_jobs where organization_id=p_org and document_id=p_document order by created_at desc limit 30) j),'[]'::jsonb));
end; $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure name from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'orquivia_mail_%' loop
    execute format('revoke all on function %s from public,anon,authenticated',f.name);
    execute format('grant execute on function %s to service_role',f.name);
  end loop;
end $$;
revoke all on function orquivia_private.mail_member(uuid,uuid),orquivia_private.mail_job_json(orquivia_private.mail_jobs) from public,anon,authenticated;
commit;
