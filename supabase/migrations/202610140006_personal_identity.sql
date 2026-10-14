-- Bind a personal request to the user captured before awaiting its transport.
-- The SDK may refresh/change its JWT; compare its final identity on the server
-- before any earlier personal RPC can read or mutate another user's records.
begin;

create function orquivia_private.require_expected_personal_user(p_expected_user_id uuid) returns void
language plpgsql stable set search_path='' as $$
begin
  if p_expected_user_id is null or auth.uid() is distinct from p_expected_user_id then
    raise exception 'AUTH_CHANGED' using errcode='42501';
  end if;
end; $$;

create function public.load_orquivia_profile(p_expected_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  return public.load_orquivia_profile();
end; $$;
create function public.save_orquivia_profile(p_profile jsonb,p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  return public.save_orquivia_profile(p_profile);
end; $$;
create function public.save_orquivia_push_subscription(p_subscription jsonb,p_expected_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  return public.save_orquivia_push_subscription(p_subscription);
end; $$;
create function public.remove_orquivia_push_subscription(p_endpoint text,p_expected_user_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  return public.remove_orquivia_push_subscription(p_endpoint);
end; $$;
create function public.list_orquivia_push_subscriptions(p_expected_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  return public.list_orquivia_push_subscriptions();
end; $$;

revoke all on function orquivia_private.require_expected_personal_user(uuid) from public,anon,authenticated;
revoke all on function public.load_orquivia_profile(),public.save_orquivia_profile(jsonb),
  public.save_orquivia_push_subscription(jsonb),public.remove_orquivia_push_subscription(text),public.list_orquivia_push_subscriptions() from public,anon,authenticated;
revoke all on function public.load_orquivia_profile(uuid),public.save_orquivia_profile(jsonb,uuid),
  public.save_orquivia_push_subscription(jsonb,uuid),public.remove_orquivia_push_subscription(text,uuid),public.list_orquivia_push_subscriptions(uuid) from public,anon,authenticated;
grant execute on function public.load_orquivia_profile(uuid),public.save_orquivia_profile(jsonb,uuid),
  public.save_orquivia_push_subscription(jsonb,uuid),public.remove_orquivia_push_subscription(text,uuid),public.list_orquivia_push_subscriptions(uuid) to authenticated;
grant execute on function orquivia_private.require_expected_personal_user(uuid) to service_role;
commit;
