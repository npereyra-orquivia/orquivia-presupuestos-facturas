-- Push-only server configuration. Private VAPID keys never enter the web build.
-- Apply after 202610140004_personal_profiles.sql.
begin;

create table orquivia_private.push_runtime_config (
  singleton boolean primary key default true check(singleton),
  cron_secret text not null check(length(cron_secret)>=32),
  public_key text,
  private_key text,
  subject text,
  scheduled boolean not null default false,
  last_run_at timestamptz,
  last_success_at timestamptz,
  last_status text check(last_status in ('ok','unavailable')),
  created_at timestamptz not null default now()
);
alter table orquivia_private.push_runtime_config enable row level security;
revoke all on orquivia_private.push_runtime_config from public,anon,authenticated,service_role;
-- Two independently generated UUIDv4 values provide 244 random bits. Generation
-- is inside PostgreSQL; the secret is not present in a migration or cron command.
insert into orquivia_private.push_runtime_config(singleton,cron_secret)
values(true,replace(gen_random_uuid()::text||gen_random_uuid()::text,'-',''));

create function public.get_orquivia_push_runtime_config() returns jsonb
language sql stable security definer set search_path='' as $$
  select jsonb_build_object('publicKey',public_key,'privateKey',private_key,'subject',subject,
    'cronSecret',cron_secret,'scheduled',scheduled,'lastRunAt',last_run_at,'lastStatus',last_status)
  from orquivia_private.push_runtime_config where singleton;
$$;

create function public.initialize_orquivia_push_runtime(p_public_key text,p_private_key text,p_subject text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare settings orquivia_private.push_runtime_config;
begin
  if p_public_key is null or p_private_key is null or p_subject is null
    or p_public_key !~ '^[A-Za-z0-9_-]{87}$' or p_private_key !~ '^[A-Za-z0-9_-]{43}$'
    or p_subject !~ '^mailto:[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(p_subject)>240 then
    raise exception 'INVALID_PUSH_CONFIGURATION' using errcode='22023';
  end if;
  select * into settings from orquivia_private.push_runtime_config where singleton for update;
  if not found then raise exception 'PUSH_CONFIGURATION_MISSING' using errcode='55000'; end if;
  if settings.public_key is null then
    update orquivia_private.push_runtime_config set public_key=p_public_key,private_key=p_private_key,subject=p_subject
      where singleton returning * into settings;
  end if;
  -- Concurrent bootstrap calls all receive the same winning key pair.
  return jsonb_build_object('publicKey',settings.public_key,'privateKey',settings.private_key,'subject',settings.subject,
    'cronSecret',settings.cron_secret,'scheduled',settings.scheduled,'lastRunAt',settings.last_run_at,'lastStatus',settings.last_status);
end;
$$;

create function public.record_orquivia_push_run(p_success boolean) returns void
language sql security definer set search_path='' as $$
  update orquivia_private.push_runtime_config set last_run_at=now(),
    last_success_at=case when p_success then now() else last_success_at end,
    last_status=case when p_success then 'ok' else 'unavailable' end where singleton;
$$;

revoke all on function public.get_orquivia_push_runtime_config(),public.initialize_orquivia_push_runtime(text,text,text),
  public.record_orquivia_push_run(boolean) from public,anon,authenticated;
grant execute on function public.get_orquivia_push_runtime_config(),public.initialize_orquivia_push_runtime(text,text,text),
  public.record_orquivia_push_run(boolean) to service_role;

create function public.get_orquivia_push_config() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare settings orquivia_private.push_runtime_config;
begin
  perform orquivia_private.personal_context();
  select * into settings from orquivia_private.push_runtime_config where singleton;
  return jsonb_build_object('publicKey',settings.public_key,
    'configured',settings.public_key is not null and settings.scheduled,
    'lastRunAt',settings.last_run_at,'lastSuccessAt',settings.last_success_at,'lastStatus',settings.last_status);
end;
$$;
revoke all on function public.get_orquivia_push_config() from public,anon,authenticated;
grant execute on function public.get_orquivia_push_config() to authenticated;
commit;
