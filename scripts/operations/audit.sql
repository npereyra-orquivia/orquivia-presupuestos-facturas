-- Read-only operational metadata. Run with an authorized operator in Supabase SQL Editor.
-- No changes, application RPC calls, financial values, names of people, object paths,
-- passwords, tokens, Vault contents, function bodies or cron commands are returned.

select 'database' as check_name, current_setting('server_version') as server_version;

select 'application_tables' as check_name,
       n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
       has_table_privilege('anon', c.oid, 'select') as anon_can_select,
       has_table_privilege('authenticated', c.oid, 'select') as authenticated_can_select,
       has_table_privilege('authenticated', c.oid, 'insert') as authenticated_can_insert,
       has_table_privilege('authenticated', c.oid, 'update') as authenticated_can_update,
       has_table_privilege('authenticated', c.oid, 'delete') as authenticated_can_delete
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r','p') and
      ((n.nspname = 'public' and c.relname like 'orquivia\_%' escape '\') or n.nspname = 'orquivia_private')
order by schema_name, table_name;

select 'application_functions' as check_name,
       n.nspname as schema_name, p.proname as function_name,
       pg_get_function_identity_arguments(p.oid) as argument_types,
       p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_can_execute,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_can_execute,
       exists (select 1 from unnest(coalesce(p.proconfig, array[]::text[])) setting
               where setting like 'search_path=%') as has_explicit_search_path,
       p.prorettype = 'event_trigger'::regtype as returns_event_trigger,
       p.prorettype = 'trigger'::regtype as returns_trigger
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where p.prokind = 'f' and
      ((n.nspname = 'public' and (p.proname like '%orquivia%' or p.proname = 'rls_auto_enable'))
       or n.nspname = 'orquivia_private')
order by schema_name, function_name, argument_types;

select 'membership_summary' as check_name, m.role, m.active,
       count(*) as memberships,
       bool_and(o.require_mfa) as all_require_mfa,
       count(*) filter (where exists (select 1 from auth.mfa_factors f
                                     where f.user_id = m.user_id and f.status = 'verified')) as with_verified_factor
from public.orquivia_memberships m
join public.orquivia_organizations o on o.id = m.organization_id
group by m.role, m.active order by m.role, m.active;

select 'storage_buckets' as check_name, b.id as bucket,
       b.public, b.file_size_limit,
       count(o.id) as object_count,
       coalesce(sum(case when o.metadata->>'size' ~ '^[0-9]{1,16}$'
                         then (o.metadata->>'size')::numeric else 0 end), 0) as declared_object_bytes
from storage.buckets b left join storage.objects o on o.bucket_id = b.id
group by b.id, b.public, b.file_size_limit order by b.id;

select 'workspace_capacity' as check_name,
       count(*) as workspace_count,
       coalesce(max(octet_length(state::text)),0) as maximum_state_bytes,
       coalesce(max(jsonb_array_length(state->'documents')),0) as maximum_document_count,
       coalesce(max(jsonb_array_length(state->'clients')),0) as maximum_client_count,
       coalesce(max(jsonb_array_length(state->'payments')),0) as maximum_payment_count,
       coalesce(max(jsonb_array_length(coalesce(state->'expenses','[]'::jsonb))),0) as maximum_expense_count,
       coalesce(max(jsonb_array_length(coalesce(state->'taxRecords','[]'::jsonb))),0) as maximum_tax_record_count
from public.orquivia_team_workspaces;

select 'policy_summary' as check_name, schemaname, tablename, cmd, roles,
       count(*) as policy_count
from pg_policies
where (schemaname = 'public' and tablename like 'orquivia\_%' escape '\')
   or schemaname = 'orquivia_private'
   or (schemaname = 'storage' and tablename = 'objects')
group by schemaname, tablename, cmd, roles
order by schemaname, tablename, cmd;

select 'extensions' as check_name, e.extname, n.nspname as schema_name, e.extversion
from pg_extension e join pg_namespace n on n.oid = e.extnamespace
where e.extname in ('pg_net','pg_cron','supabase_vault','pgsodium') order by e.extname;
