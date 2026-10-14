begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(10);
insert into auth.users(id,email) values
 ('a1000000-0000-4000-8000-000000000001','admin@example.test'),
 ('a1000000-0000-4000-8000-000000000002','editor@example.test'),
 ('a1000000-0000-4000-8000-000000000003','outsider@example.test');
set local role service_role;
select public.bootstrap_orquivia_team('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002','Test','a2000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}',true);
select is((select count(*) from public.orquivia_team_workspaces),1::bigint,'Admin reads company workspace');
select throws_ok('update public.orquivia_team_workspaces set version=999','42501',null,'Direct workspace writes denied');
select throws_ok('delete from public.orquivia_audit_log','42501',null,'Audit is append-only to members');
select throws_ok('update public.orquivia_memberships set role=''admin''','42501',null,'Members cannot grant roles');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}',true);
select is((select count(*) from public.orquivia_team_workspaces),1::bigint,'Editor reads the same company');
select throws_ok($$select public.import_orquivia_state('a2000000-0000-4000-8000-000000000001','{}'::jsonb,1)$$,'42501',null,'Historical import is server-only');
select set_config('request.jwt.claims','{"sub":"a1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}',true);
select is((select count(*) from public.orquivia_team_workspaces),0::bigint,'Nonmember reads nothing');
select throws_ok('select public.load_orquivia_workspace()','42501','MEMBERSHIP_REQUIRED','Nonmember cannot invoke load RPC');
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select throws_ok('select * from public.orquivia_team_workspaces','42501',null,'Anonymous table access denied');
select throws_ok('select public.load_orquivia_workspace()','42501',null,'Anonymous RPC access denied');
reset role;
select * from finish();
rollback;
