-- Run once in the Supabase SQL editor, or apply with `supabase db push`.
-- orquivia_private must NOT be listed in the Data API's exposed schemas.
begin;

create schema if not exists orquivia_private;
revoke all on schema orquivia_private from public, anon, authenticated;
grant usage on schema orquivia_private to authenticated, service_role;

create or replace function orquivia_private.valid_state(p_state jsonb)
returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  collection text;
  record jsonb;
  line jsonb;
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object'
    or jsonb_typeof(p_state->'company') is distinct from 'object'
    or octet_length(p_state::text) > 5000000 then return false; end if;
  if (p_state->'company' ? 'emailNotifications') and
    jsonb_typeof(p_state->'company'->'emailNotifications') is distinct from 'boolean' then return false; end if;
  if (p_state->'company' ? 'notificationEmail') and
    jsonb_typeof(p_state->'company'->'notificationEmail') is distinct from 'string' then return false; end if;
  foreach collection in array array['clients', 'documents', 'payments'] loop
    if jsonb_typeof(p_state->collection) is distinct from 'array' then return false; end if;
    for record in select value from jsonb_array_elements(p_state->collection) loop
      if jsonb_typeof(record) <> 'object'
        or jsonb_typeof(record->'id') is distinct from 'string'
        or length(btrim(record->>'id')) = 0 then return false; end if;
    end loop;
    if (select count(*) from jsonb_array_elements(p_state->collection)) <>
      (select count(distinct value->>'id') from jsonb_array_elements(p_state->collection))
      then return false; end if;
  end loop;
  for record in select value from jsonb_array_elements(p_state->'documents') loop
    if coalesce(record->>'kind', '') not in ('invoice', 'quote')
      or jsonb_typeof(record->'items') is distinct from 'array' then return false; end if;
    if record ? 'contractReceived' then
      if jsonb_typeof(record->'contractReceived') is distinct from 'boolean' then return false; end if;
    end if;
    if record ? 'total' then
      if jsonb_typeof(record->'total') is distinct from 'number' then return false; end if;
      if (record->>'total')::numeric < 0 then return false; end if;
    end if;
    for line in select value from jsonb_array_elements(record->'items') loop
      if jsonb_typeof(line) <> 'object'
        or jsonb_typeof(line->'quantity') is distinct from 'number'
        or jsonb_typeof(line->'price') is distinct from 'number' then return false; end if;
      if (line->>'quantity')::numeric <= 0 or (line->>'price')::numeric < 0 then return false; end if;
    end loop;
  end loop;
  for record in select value from jsonb_array_elements(p_state->'payments') loop
    if jsonb_typeof(record->'amount') is distinct from 'number' then return false; end if;
    if (record->>'amount')::numeric <= 0 then return false; end if;
    if not exists (
      select 1 from jsonb_array_elements(p_state->'documents') d
      where d->>'id' = record->>'documentId'
    ) then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function orquivia_private.valid_state(jsonb) from public, anon, authenticated;

create table if not exists public.orquivia_workspaces (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null check (orquivia_private.valid_state(state)),
  version bigint not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.orquivia_workspaces enable row level security;
revoke all on table public.orquivia_workspaces from public, anon, authenticated;
grant select on table public.orquivia_workspaces to authenticated;
grant all on table public.orquivia_workspaces to service_role;

create policy "Workspace owner can read"
on public.orquivia_workspaces for select to authenticated
using ((select auth.uid()) = owner_id);

-- The only write path compares versions inside a single database transaction.
-- Keeping the privileged implementation out of an exposed schema also limits its API surface.
create or replace function orquivia_private.save_state(p_state jsonb, p_expected_version bigint)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  saved_version bigint;
  saved_at timestamptz;
begin
  if account_id is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'INVALID_VERSION' using errcode = '22023';
  end if;
  if not orquivia_private.valid_state(p_state) then
    raise exception 'INVALID_STATE' using errcode = '22023';
  end if;

  if p_expected_version = 0 then
    insert into public.orquivia_workspaces (owner_id, state, version)
    values (account_id, p_state, 1)
    on conflict (owner_id) do nothing
    returning version, updated_at into saved_version, saved_at;
  else
    update public.orquivia_workspaces
      set state = p_state, version = version + 1, updated_at = now()
      where owner_id = account_id and version = p_expected_version
      returning version, updated_at into saved_version, saved_at;
  end if;
  if saved_version is null then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;
  return jsonb_build_object('version', saved_version, 'updated_at', saved_at);
end;
$$;
revoke all on function orquivia_private.save_state(jsonb, bigint) from public, anon, authenticated;
grant execute on function orquivia_private.save_state(jsonb, bigint) to authenticated;

create or replace function public.save_orquivia_state(p_state jsonb, p_expected_version bigint)
returns jsonb
language sql security invoker
set search_path = ''
as $$ select orquivia_private.save_state(p_state, p_expected_version); $$;
revoke all on function public.save_orquivia_state(jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_orquivia_state(jsonb, bigint) to authenticated;

-- The optional email function alone can claim and record daily deliveries.
create table if not exists public.orquivia_reminder_deliveries (
  owner_id uuid not null references auth.users(id) on delete cascade,
  reminder_date date not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  email_payload jsonb not null check (jsonb_typeof(email_payload) = 'object'),
  lease_token uuid not null default gen_random_uuid(),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  provider_id text,
  error text,
  primary key (owner_id, reminder_date)
);
alter table public.orquivia_reminder_deliveries enable row level security;
revoke all on table public.orquivia_reminder_deliveries from public, anon, authenticated;
grant all on table public.orquivia_reminder_deliveries to service_role;
-- No end-user policies: delivery history contains operational data only.

create or replace function public.claim_orquivia_reminder(p_owner_id uuid, p_date date, p_lease_token uuid, p_payload jsonb)
returns jsonb
language plpgsql security invoker
set search_path = ''
as $$
declare claimed_payload jsonb;
begin
  insert into public.orquivia_reminder_deliveries (owner_id, reminder_date, lease_token, email_payload)
  values (p_owner_id, p_date, p_lease_token, p_payload)
  on conflict (owner_id, reminder_date) do update
    set status = 'pending', lease_token = excluded.lease_token,
        claimed_at = now(), error = null
    where public.orquivia_reminder_deliveries.status = 'failed'
       or (public.orquivia_reminder_deliveries.status = 'pending'
           and public.orquivia_reminder_deliveries.claimed_at < now() - interval '10 minutes')
  returning email_payload into claimed_payload;
  return claimed_payload;
end;
$$;
revoke all on function public.claim_orquivia_reminder(uuid, date, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.claim_orquivia_reminder(uuid, date, uuid, jsonb) to service_role;

commit;
