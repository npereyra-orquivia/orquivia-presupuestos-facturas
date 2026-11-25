// Operation sidecar compatibility against real PostgreSQL routines, synthetic data only.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { planningFixture } from './planning-fixture.mjs';
import { distributionFixture } from './distribution-fixture.mjs';
import { validatePlanningState } from '../../src/planning-state.js';

const db=await PGlite.create();
const owner='e1000000-0000-4000-8000-000000000001',editor='e1000000-0000-4000-8000-000000000002',outsider='e1000000-0000-4000-8000-000000000003',viewer='e1000000-0000-4000-8000-000000000004',org='e2000000-0000-4000-8000-000000000001';
let checks=0,workspace;
const query=async(sql,args=[])=>{try{return(await db.query(sql,args)).rows;}catch(error){error.testSQL=sql;throw error;}};
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
const denied=async(sql,args=[],message,code)=>{await assert.rejects(db.query(sql,args),error=>(!message||error.message===message)&&(!code||error.code===code));checks++;};
const as=async(role,id=owner,aal='aal2')=>{await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role,aal})]);};
const load=async()=>(await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL='select public.save_orquivia_team_state($1,$2,$3) result';
const save=async(next)=>{const result=(await query(saveSQL,[org,next,workspace.version]))[0].result;workspace=await load();return result;};
const history=async(id='planning',expected=editor)=>(await query('select public.load_orquivia_record_history($1,$2,$3,$4,$5) result',[org,'planning',id,100,expected]))[0].result;
const migration=async name=>{const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');await db.exec(sql.replace('create extension if not exists supabase_vault with schema vault;',''));};

try{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;grant select on auth.users to service_role;
    insert into auth.users values('${owner}','owner@example.test'),('${editor}','editor@example.test'),('${outsider}','outsider@example.test'),('${viewer}','viewer@example.test');
    insert into auth.mfa_factors(user_id,status) values('${owner}','verified'),('${editor}','verified'),('${outsider}','verified'),('${viewer}','verified');
    create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;grant usage on schema storage to anon,authenticated,service_role;grant select,insert,update,delete on storage.objects to anon,authenticated;grant all on storage.objects,storage.buckets to service_role;
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql','202610140004_personal_profiles.sql',
    '202610140006_personal_identity.sql','202610140007_expense_quick_entry.sql','202610140008_vat_document_status.sql','202610140009_record_history.sql',
    '202610140010_tax_records_missing_receipts.sql','202610150011_prepared_quotes.sql','202610150012_document_mail.sql','202610150013_mail_recipients.sql',
    '202610230014_invoice_mail.sql','202610260015_invoice_mail_attachments.sql','202610270016_rpc_conflict_http.sql','202611160018_multi_quote_mail.sql',
    '202611160019_mail_drafts.sql','202611180020_document_payment_terms.sql','202611190021_client_document_sync.sql','202611250022_financial_planning.sql'])await migration(name);
  await as('service_role');await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[owner,editor,'Fixture company',org]);
  await query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await as('authenticated',editor);workspace=await load();
  const initial=structuredClone(workspace.state);initial.planning=planningFixture();initial.clients=[{id:'client-fixture',name:'Fixture client'}];await save(initial);
  const before=structuredClone(workspace),pastHistory=await history();
  await db.exec('reset role');await migration('202611250023_distribution_operations.sql');
  await as('authenticated',editor);workspace=await load();equal(workspace,before,'Migration does not rewrite 1.10 plans or operational records');equal(await history(),pastHistory);
  const next=structuredClone(workspace.state);next.planningExtensions=distributionFixture();
  const result=await save(next);equal(result.state,workspace.state);equal(workspace.state.planning,next.planning);equal(validatePlanningState(workspace.state.planning),next.planning,'Persisted base still has the strict v1 shape');
  equal(workspace.state.documents,before.state.documents);equal(workspace.state.payments,before.state.payments);equal(workspace.state.company,before.state.company);
  const sideHistory=await history('distribution:scenario-a');equal(sideHistory.length,1);equal(sideHistory[0].actorId,editor);equal(sideHistory[0].changedFields,['operations']);
  equal(JSON.stringify(await history()).includes('PRIVATE-OPERATION'),false,'Audit does not expose operation labels or fiscal values');
  equal((await history('scenario:scenario-a')).some(h=>h.entityId==='distribution:scenario-a'),true,'Scenario history includes its operation history');
  equal((await history('settings')).some(h=>h.entityId==='tax-profile:person-a'),true,'Settings history includes profile metadata history');
  await as('service_role');
  const unicodeSample=structuredClone(workspace.state.planningExtensions);unicodeSample.scenarios[0].operations[0].label='Línea 📆\ncon espacios y "comillas"';
  equal(Number((await query('select orquivia_private.distribution_json_bytes($1) bytes',[unicodeSample]))[0].bytes),new TextEncoder().encode(JSON.stringify(unicodeSample)).byteLength,'Compact byte budget matches the client, including string whitespace and Unicode');
  const overPlanning=structuredClone(workspace.state.planning),overExtensions=distributionFixture(),template=overExtensions.scenarios[0].operations[0];
  overPlanning.scenarios=Array.from({length:50},(_,n)=>({id:`s${n}`,name:'Scenario',people:[{personId:'person-a',workGross:1000,dividendGross:0}],dividendDate:null,notes:''}));
  overExtensions.scenarios=overPlanning.scenarios.map((scenario,n)=>({scenarioId:scenario.id,operations:Array.from({length:50},(_,i)=>({...template,id:`operation-${n}-${i}`.padEnd(140,'x'),label:'x'.repeat(200),amount:20}))}));
  equal((await query('select orquivia_private.valid_planning_extensions($1,$2) valid',[overExtensions,overPlanning]))[0].valid,false,'Server rejects a structurally valid sidecar beyond 1 MB');
  await as('authenticated',editor);

  const legacy=structuredClone(workspace.state);delete legacy.planningExtensions;legacy.clients[0].name='Edited through an older client';
  const extension=structuredClone(workspace.state.planningExtensions),extensionHistory=await history('distribution:scenario-a');
  await save(legacy);equal(workspace.state.planningExtensions,extension);equal(await history('distribution:scenario-a'),extensionHistory);
  const oldVersion=workspace.version;
  for(const change of [s=>s.planning.scenarios[0].people[0].workGross+=100,s=>s.planning.scenarios[0].dividendDate='2026-07-15']){
    const stale=structuredClone(workspace.state);delete stale.planningExtensions;change(stale);
    await denied(saveSQL,[org,stale,workspace.version],'PLANNING_CLIENT_UPDATE_REQUIRED','22023');equal((await load()).version,oldVersion);
  }
  const clonedSidecar=structuredClone(workspace.state);clonedSidecar.planning.scenarios[0].people[0].workGross+=100;
  await denied(saveSQL,[org,clonedSidecar,workspace.version],'PLANNING_CLIENT_UPDATE_REQUIRED','22023');
  const consistent=structuredClone(workspace.state);consistent.planning.scenarios[0].people[0].workGross+=100;consistent.planningExtensions.scenarios[0].operations[0].amount+=100;
  await save(consistent);equal((await history('distribution:scenario-a'))[0].changedFields,['operations']);
  const dateEdit=structuredClone(workspace.state);dateEdit.planning.scenarios[0].dividendDate='2026-07-15';await save(dateEdit);
  equal(workspace.state.planning.scenarios[0].dividendDate,'2026-07-15','A capable client can edit the scenario date atomically');
  await denied(saveSQL,[org,consistent,oldVersion],'VERSION_CONFLICT','PT409');
  const oldRename=structuredClone(workspace.state);delete oldRename.planningExtensions;oldRename.planning.scenarios[0].name='Renamed through old client';await save(oldRename);
  equal(workspace.state.planningExtensions.scenarios[0].operations[0].amount,2300);

  const mutations=[e=>e.people[0].taxRegion=null,e=>e.people[0].taxRegion='unknown',e=>e.people[0].personId='missing',e=>e.people.push(structuredClone(e.people[0])),
    e=>e.scenarios[0].scenarioId='missing',e=>e.scenarios.push(structuredClone(e.scenarios[0])),e=>e.scenarios[0].operations.push(structuredClone(e.scenarios[0].operations[0])),
    e=>e.scenarios[0].operations[0].kind=null,e=>e.scenarios[0].operations[0].kind='transfer',e=>e.scenarios[0].operations[0].personId=null,
    e=>e.scenarios[0].operations[5].personId='person-a',e=>e.scenarios[0].operations[0].amount=-1,e=>e.scenarios[0].operations[0].amount=1.001,
    e=>e.scenarios[0].operations[0].employeeSSRate=101,e=>e.scenarios[0].operations[0].vatRate='21',e=>e.scenarios[0].operations[0].withholdingRate=true,
    e=>e.scenarios[0].operations[0].taxTreatmentConfirmed=null,e=>e.scenarios[0].operations[0].label='\u00a0',e=>e.scenarios[0].operations[0].label='control\u0085',e=>e.scenarios[0].operations[0].credential='fixture'];
  for(const change of mutations){
    const invalid=structuredClone(workspace.state);change(invalid.planningExtensions);
    await as('service_role');equal((await query('select orquivia_private.valid_state($1) valid',[invalid]))[0].valid,false);
    await as('authenticated',editor);await denied(saveSQL,[org,invalid,workspace.version],'INVALID_STATE','22023');
  }
  const bad=structuredClone(workspace.state);bad.planningExtensions=null;
  await as('service_role');await denied('update public.orquivia_team_workspaces set state=$1 where organization_id=$2',[bad,org],undefined,'23514');
  await as('authenticated',editor);
  const company=structuredClone(workspace.state);company.company.name='Forbidden';await denied(saveSQL,[org,company,workspace.version],'ADMIN_REQUIRED','42501');
  const removal=structuredClone(workspace.state);delete removal.planningExtensions;removal.planning.settings.people=removal.planning.settings.people.filter(p=>p.id!=='person-b');removal.planning.settings.people[0].sharePercent=100;removal.planning.scenarios[0].people=removal.planning.scenarios[0].people.filter(p=>p.personId!=='person-b');
  await denied(saveSQL,[org,removal,workspace.version],'PLANNING_CLIENT_UPDATE_REQUIRED','22023');
  const added=structuredClone(workspace.state);added.planning.settings.people.push({...added.planning.settings.people[0],id:'unused-person',name:'Unused person',sharePercent:0});added.planningExtensions.people.push({personId:'unused-person',taxRegion:'other'});await save(added);
  const pruneProfile=structuredClone(workspace.state);delete pruneProfile.planningExtensions;pruneProfile.planning.settings.people=pruneProfile.planning.settings.people.filter(p=>p.id!=='unused-person');await save(pruneProfile);
  equal(workspace.state.planningExtensions.people.some(p=>p.personId==='unused-person'),false);equal((await history('tax-profile:unused-person'))[0].action,'deleted');
  const extra=structuredClone(workspace.state);extra.planning.scenarios.push({...structuredClone(extra.planning.scenarios[0]),id:'scenario-b'});extra.planningExtensions.scenarios.push({...structuredClone(extra.planningExtensions.scenarios[0]),scenarioId:'scenario-b'});await save(extra);
  const deletion=structuredClone(workspace.state);delete deletion.planningExtensions;deletion.planning.scenarios=deletion.planning.scenarios.filter(s=>s.id!=='scenario-a');await save(deletion);
  equal(workspace.state.planningExtensions.scenarios.map(s=>s.scenarioId),['scenario-b']);equal((await history('distribution:scenario-a'))[0].action,'deleted');
  const oldRestore=structuredClone(workspace.state);delete oldRestore.planningExtensions;delete oldRestore.planning;const planningBefore=structuredClone(workspace.state.planning);await save(oldRestore);equal(workspace.state.planning,planningBefore);equal(workspace.state.planningExtensions.scenarios.length,1);

  await as('authenticated',editor,'aal1');await denied(saveSQL,[org,workspace.state,workspace.version],'MFA_REQUIRED','42501');await denied('select public.load_orquivia_record_history($1,$2,$3,$4,$5)',[org,'planning','planning',50,editor],'MFA_REQUIRED','42501');equal((await query('select * from public.orquivia_team_workspaces where organization_id=$1',[org])).length,0);
  await as('service_role');await query('update public.orquivia_memberships set active=false where user_id=$1',[editor]);
  await as('authenticated',editor);await denied(saveSQL,[org,workspace.state,workspace.version],'MEMBERSHIP_REQUIRED','42501');
  await as('authenticated',outsider);await denied('select public.load_orquivia_record_history($1,$2,$3,$4,$5)',[org,'planning','planning',50,outsider],undefined,'42501');
  await db.exec(`reset role;alter table public.orquivia_memberships drop constraint orquivia_memberships_role_check;alter table public.orquivia_memberships add constraint orquivia_memberships_role_check check(role in ('admin','editor','viewer'));`);
  await query('insert into public.orquivia_memberships(organization_id,user_id,role) values($1,$2,$3)',[org,viewer,'viewer']);await as('authenticated',viewer);
  const readOnly=structuredClone(workspace.state);delete readOnly.planningExtensions;await denied(saveSQL,[org,readOnly,workspace.version],'WRITE_ACCESS_REQUIRED','42501');
  equal((await load()).state,workspace.state);
  console.log(`Distribution operations PostgreSQL: ${checks} checks passed`);
}finally{await db.close();}
