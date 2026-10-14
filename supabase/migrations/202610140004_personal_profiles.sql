-- Personal profiles and device registrations stay separate from company finances.
-- Only the profile owner, still an active MFA-authorized member, can access them.
begin;

create function orquivia_private.default_notification_preferences() returns jsonb
language sql immutable set search_path='' as $$
  select '{"enabled":false,"payment":true,"contract":true,"review":true,"daysBefore":2,"onDueDate":true,"repeatDays":2,"hour":9}'::jsonb;
$$;
create function orquivia_private.valid_notification_preferences(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare field text; value numeric;
begin
  if jsonb_typeof(p) is distinct from 'object' or (select count(*) from jsonb_object_keys(p))<>8 then return false; end if;
  foreach field in array array['enabled','payment','contract','review','onDueDate'] loop
    if jsonb_typeof(p->field) is distinct from 'boolean' then return false; end if;
  end loop;
  foreach field in array array['daysBefore','repeatDays','hour'] loop
    if jsonb_typeof(p->field) is distinct from 'number' then return false; end if;
    value:=(p->>field)::numeric;
    if value<>round(value,0) or value<0 or value>(case field when 'hour' then 23 else 30 end) then return false; end if;
  end loop;
  return true;
exception when others then return false;
end; $$;
create function orquivia_private.avatar_path_valid(p_path text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|jpeg|png|webp)$',false);
$$;
create function orquivia_private.valid_avatar(p jsonb,p_org uuid,p_user uuid) returns boolean
language plpgsql immutable set search_path='' as $$
declare value numeric;
begin
  if p is null or p='null'::jsonb then return true; end if;
  if jsonb_typeof(p)<>'object' or jsonb_typeof(p->'path') is distinct from 'string' or not orquivia_private.avatar_path_valid(p->>'path')
    or split_part(p->>'path','/',1)<>p_org::text or split_part(p->>'path','/',2)<>p_user::text
    or p->>'path' is distinct from p_org::text||'/'||p_user::text||'/'||(p->>'id')||'.'||(p->>'extension')
    or p->>'mimeType' is distinct from orquivia_private.receipt_mime(p->>'extension')
    or jsonb_typeof(p->'size') is distinct from 'number' then return false; end if;
  value:=(p->>'size')::numeric;
  return value=round(value,0) and value between 1 and 2097152;
exception when others then return false;
end; $$;

create table public.orquivia_personal_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.orquivia_organizations(id) on delete cascade,
  display_name text not null default '' check(length(display_name)<=100 and display_name !~ '[[:cntrl:]]'),
  avatar jsonb,
  notification_preferences jsonb not null default orquivia_private.default_notification_preferences() check(orquivia_private.valid_notification_preferences(notification_preferences)),
  updated_at timestamptz not null default now(),
  foreign key(organization_id,user_id) references public.orquivia_memberships(organization_id,user_id) on delete cascade,
  check(orquivia_private.valid_avatar(avatar,organization_id,user_id))
);
alter table public.orquivia_personal_profiles enable row level security;
revoke all on public.orquivia_personal_profiles from public,anon,authenticated;
grant select on public.orquivia_personal_profiles to authenticated;
grant all on public.orquivia_personal_profiles to service_role;
create policy "Own active personal profile" on public.orquivia_personal_profiles for select to authenticated
  using(user_id=(select auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')='aal2' and orquivia_private.is_member(organization_id));

create function orquivia_private.personal_context() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare org uuid;
begin
  select organization_id into org from public.orquivia_memberships where user_id=auth.uid() and active;
  perform orquivia_private.require_member(org);
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'MFA_REQUIRED' using errcode='42501'; end if;
  return org;
end; $$;
create function orquivia_private.profile_json(p public.orquivia_personal_profiles) returns jsonb
language sql stable set search_path='' as $$
  select jsonb_build_object('userId',p.user_id,'organizationId',p.organization_id,'displayName',p.display_name,
    'avatar',p.avatar,'notifications',p.notification_preferences,'updatedAt',p.updated_at);
$$;
create function public.load_orquivia_profile() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=orquivia_private.personal_context(); profile public.orquivia_personal_profiles;
begin
  select p.* into profile from public.orquivia_personal_profiles p where p.user_id=auth.uid() and p.organization_id=org;
  if found then return orquivia_private.profile_json(profile); end if;
  return jsonb_build_object('userId',auth.uid(),'organizationId',org,'displayName','','avatar',null,
    'notifications',orquivia_private.default_notification_preferences(),'updatedAt',null);
end; $$;
create function public.save_orquivia_profile(p_profile jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid:=orquivia_private.personal_context(); owner uuid:=auth.uid(); profile public.orquivia_personal_profiles; avatar jsonb:=p_profile->'avatar';
begin
  if jsonb_typeof(p_profile) is distinct from 'object' or jsonb_typeof(p_profile->'displayName') is distinct from 'string'
    or length(p_profile->>'displayName')>100 or p_profile->>'displayName' ~ '[[:cntrl:]]'
    or not orquivia_private.valid_notification_preferences(p_profile->'notifications') then
    raise exception 'INVALID_PROFILE' using errcode='22023';
  end if;
  if not orquivia_private.valid_avatar(avatar,org,owner) then raise exception 'INVALID_AVATAR' using errcode='22023'; end if;
  -- Serialize linking and deletion even when a profile has not been created yet.
  perform pg_advisory_xact_lock(hashtextextended('orquivia-avatar:'||owner::text,0));
  if avatar is not null and avatar<>'null'::jsonb then
    if not exists(select 1 from storage.objects o where o.bucket_id='orquivia-avatars' and o.name=avatar->>'path'
      and o.metadata->>'mimetype'=avatar->>'mimeType' and (o.metadata->>'size')::numeric=(avatar->>'size')::numeric) then
      raise exception 'INVALID_AVATAR' using errcode='22023';
    end if;
  else avatar:=null; end if;
  insert into public.orquivia_personal_profiles(user_id,organization_id,display_name,avatar,notification_preferences)
    values(owner,org,btrim(p_profile->>'displayName'),avatar,p_profile->'notifications')
    on conflict(user_id) do update set display_name=excluded.display_name,avatar=excluded.avatar,
      notification_preferences=excluded.notification_preferences,updated_at=now()
    returning * into profile;
  return orquivia_private.profile_json(profile);
end; $$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('orquivia-avatars','orquivia-avatars',false,2097152,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create function orquivia_private.avatar_owner(p_path text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
  if not orquivia_private.avatar_path_valid(p_path) then return false; end if;
  return split_part(p_path,'/',2)=auth.uid()::text and coalesce(auth.jwt()->>'aal','aal1')='aal2' and orquivia_private.is_member(split_part(p_path,'/',1)::uuid);
end; $$;
create function orquivia_private.avatar_unreferenced(p_path text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
begin
  if not orquivia_private.avatar_owner(p_path) then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('orquivia-avatar:'||auth.uid()::text,0));
  return not exists(select 1 from public.orquivia_personal_profiles p where p.user_id=auth.uid() and p.avatar->>'path'=p_path);
end; $$;
create policy "Orquivia owner avatars read" on storage.objects for select to authenticated
  using(bucket_id='orquivia-avatars' and orquivia_private.avatar_owner(name));
create policy "Orquivia owner avatars upload" on storage.objects for insert to authenticated
  with check(bucket_id='orquivia-avatars' and orquivia_private.avatar_owner(name));
create policy "Orquivia unlinked avatars delete" on storage.objects for delete to authenticated
  using(bucket_id='orquivia-avatars' and orquivia_private.avatar_unreferenced(name));
create policy "Orquivia avatars authenticated boundary" on storage.objects as restrictive for all to authenticated
  using(bucket_id<>'orquivia-avatars' or orquivia_private.avatar_owner(name))
  with check(bucket_id<>'orquivia-avatars' or orquivia_private.avatar_owner(name));
create policy "Orquivia avatars anonymous boundary" on storage.objects as restrictive for all to anon
  using(bucket_id<>'orquivia-avatars') with check(bucket_id<>'orquivia-avatars');
create policy "Orquivia avatars immutable originals" on storage.objects as restrictive for update to authenticated
  using(bucket_id<>'orquivia-avatars') with check(bucket_id<>'orquivia-avatars');
create policy "Orquivia avatars keep linked originals" on storage.objects as restrictive for delete to authenticated
  using(bucket_id<>'orquivia-avatars' or orquivia_private.avatar_unreferenced(name));

create function orquivia_private.valid_push_subscription(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare endpoint text; host text;
begin
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'endpoint') is distinct from 'string'
    or jsonb_typeof(p->'keys') is distinct from 'object' then return false; end if;
  endpoint:=p->>'endpoint';
  -- A provider allowlist also prevents the service sender being used for SSRF.
  if length(endpoint)>2048 or endpoint !~ '^https://[a-z0-9.-]+/[^[:space:]#]*$' then return false; end if;
  host:=split_part(split_part(endpoint,'://',2),'/',1);
  if host not in ('fcm.googleapis.com','updates.push.services.mozilla.com','push.services.mozilla.com','web.push.apple.com')
    and host !~ '^[a-z0-9.-]+\.notify\.windows\.com$' then return false; end if;
  return coalesce(p->'keys'->>'p256dh' ~ '^[A-Za-z0-9_-]{87}$' and p->'keys'->>'auth' ~ '^[A-Za-z0-9_-]{22}$',false);
exception when others then return false;
end; $$;
create table public.orquivia_push_subscriptions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.orquivia_organizations(id) on delete cascade,
  endpoint text not null unique, subscription jsonb not null check(orquivia_private.valid_push_subscription(subscription)),
  active boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(organization_id,user_id) references public.orquivia_memberships(organization_id,user_id) on delete cascade,
  check(endpoint=subscription->>'endpoint')
);
alter table public.orquivia_push_subscriptions enable row level security;
revoke all on public.orquivia_push_subscriptions from public,anon,authenticated;
grant select on public.orquivia_push_subscriptions to authenticated;
grant all on public.orquivia_push_subscriptions to service_role;
create policy "Own active device subscriptions" on public.orquivia_push_subscriptions for select to authenticated
  using(user_id=(select auth.uid()) and coalesce(auth.jwt()->>'aal','aal1')='aal2' and orquivia_private.is_member(organization_id));
create function public.save_orquivia_push_subscription(p_subscription jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare org uuid:=orquivia_private.personal_context(); owner uuid:=auth.uid(); record public.orquivia_push_subscriptions;
begin
  if not orquivia_private.valid_push_subscription(p_subscription) then raise exception 'INVALID_PUSH_SUBSCRIPTION' using errcode='22023'; end if;
  -- Re-authentication at AAL2 is required for enrollment even in an org without a forced-MFA policy.
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'MFA_REQUIRED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('orquivia-push:'||owner::text,0));
  if (select count(*) from public.orquivia_push_subscriptions s where s.user_id=owner and s.active and s.endpoint<>p_subscription->>'endpoint')>=10 then
    raise exception 'INVALID_PUSH_SUBSCRIPTION' using errcode='22023';
  end if;
  insert into public.orquivia_push_subscriptions(user_id,organization_id,endpoint,subscription)
    values(owner,org,p_subscription->>'endpoint',jsonb_build_object('endpoint',p_subscription->>'endpoint','expirationTime',null,'keys',p_subscription->'keys'))
    on conflict(endpoint) do update set subscription=excluded.subscription,active=true,updated_at=now()
      where public.orquivia_push_subscriptions.user_id=owner and public.orquivia_push_subscriptions.organization_id=org
    returning * into record;
  if record.id is null then raise exception 'INVALID_PUSH_SUBSCRIPTION' using errcode='22023'; end if;
  return jsonb_build_object('id',record.id,'active',record.active,'createdAt',record.created_at);
end; $$;
create function public.remove_orquivia_push_subscription(p_endpoint text) returns boolean
language plpgsql security definer set search_path='' as $$
declare org uuid:=orquivia_private.personal_context(); changed integer;
begin
  update public.orquivia_push_subscriptions set active=false,updated_at=now()
    where user_id=auth.uid() and organization_id=org and endpoint=p_endpoint;
  get diagnostics changed=row_count;
  return changed>0;
end; $$;
create function public.list_orquivia_push_subscriptions() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare org uuid:=orquivia_private.personal_context(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'endpoint',s.endpoint,'active',s.active,'createdAt',s.created_at,'updatedAt',s.updated_at) order by s.created_at),'[]'::jsonb)
    into result from public.orquivia_push_subscriptions s where s.user_id=auth.uid() and s.organization_id=org and s.active;
  return result;
end; $$;

-- Only the scheduled server can read delivery material and company data together.
create function public.list_orquivia_push_targets() returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'user_id',s.user_id,'organization_id',s.organization_id,
    'subscription',s.subscription,'notification_preferences',p.notification_preferences,'state',w.state)),'[]'::jsonb)
  from public.orquivia_push_subscriptions s
    join public.orquivia_personal_profiles p on p.user_id=s.user_id and p.organization_id=s.organization_id
    join public.orquivia_memberships m on m.user_id=s.user_id and m.organization_id=s.organization_id and m.active
    join public.orquivia_team_workspaces w on w.organization_id=s.organization_id
  where s.active and (p.notification_preferences->>'enabled')::boolean
    and exists(select 1 from auth.mfa_factors f where f.user_id=s.user_id and f.status='verified');
$$;
create table public.orquivia_push_deliveries (
  subscription_id uuid not null references public.orquivia_push_subscriptions(id) on delete cascade,
  reminder_date date not null, status text not null default 'pending' check(status in ('pending','sent','failed','cancelled')),
  payload jsonb not null check(jsonb_typeof(payload)='object'), lease_token uuid not null,
  claimed_at timestamptz not null default now(), sent_at timestamptz, error text,
  primary key(subscription_id,reminder_date)
);
alter table public.orquivia_push_deliveries enable row level security;
revoke all on public.orquivia_push_deliveries from public,anon,authenticated;
grant all on public.orquivia_push_deliveries to service_role;
create function public.claim_orquivia_push_delivery(p_subscription_id uuid,p_date date,p_lease_token uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.orquivia_push_subscriptions s
    join public.orquivia_personal_profiles p on p.user_id=s.user_id and p.organization_id=s.organization_id
    join public.orquivia_memberships m on m.user_id=s.user_id and m.organization_id=s.organization_id
    where s.id=p_subscription_id and s.active and m.active and (p.notification_preferences->>'enabled')::boolean
      and exists(select 1 from auth.mfa_factors f where f.user_id=s.user_id and f.status='verified')) then return null; end if;
  insert into public.orquivia_push_deliveries(subscription_id,reminder_date,lease_token,payload)
    values(p_subscription_id,p_date,p_lease_token,p_payload)
    on conflict(subscription_id,reminder_date) do update set status='pending',lease_token=excluded.lease_token,claimed_at=now(),error=null
      where public.orquivia_push_deliveries.status='failed'
        or (public.orquivia_push_deliveries.status='pending' and public.orquivia_push_deliveries.claimed_at<now()-interval '10 minutes')
    returning payload into result;
  return result;
end; $$;
create function public.finish_orquivia_push_delivery(p_subscription_id uuid,p_date date,p_lease_token uuid,p_status text,p_error text default null) returns boolean
language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
  if p_status not in ('sent','failed','cancelled') then raise exception 'INVALID_DELIVERY_STATUS' using errcode='22023'; end if;
  update public.orquivia_push_deliveries set status=p_status,sent_at=case when p_status='sent' then now() else null end,error=left(p_error,500)
    where subscription_id=p_subscription_id and reminder_date=p_date and lease_token=p_lease_token and status='pending';
  get diagnostics changed=row_count;
  return changed>0;
end; $$;

revoke all on function orquivia_private.default_notification_preferences(),orquivia_private.valid_notification_preferences(jsonb),
  orquivia_private.avatar_path_valid(text),orquivia_private.valid_avatar(jsonb,uuid,uuid),orquivia_private.personal_context(),
  orquivia_private.profile_json(public.orquivia_personal_profiles),orquivia_private.avatar_owner(text),orquivia_private.avatar_unreferenced(text),
  orquivia_private.valid_push_subscription(jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.avatar_owner(text),orquivia_private.avatar_unreferenced(text) to authenticated;
grant execute on all functions in schema orquivia_private to service_role;
revoke all on function public.load_orquivia_profile(),public.save_orquivia_profile(jsonb),public.save_orquivia_push_subscription(jsonb),
  public.remove_orquivia_push_subscription(text),public.list_orquivia_push_subscriptions(),public.list_orquivia_push_targets(),
  public.claim_orquivia_push_delivery(uuid,date,uuid,jsonb),public.finish_orquivia_push_delivery(uuid,date,uuid,text,text) from public,anon,authenticated;
grant execute on function public.load_orquivia_profile(),public.save_orquivia_profile(jsonb),public.save_orquivia_push_subscription(jsonb),
  public.remove_orquivia_push_subscription(text),public.list_orquivia_push_subscriptions() to authenticated;
grant execute on function public.list_orquivia_push_targets(),public.claim_orquivia_push_delivery(uuid,date,uuid,jsonb),
  public.finish_orquivia_push_delivery(uuid,date,uuid,text,text) to service_role;
commit;
