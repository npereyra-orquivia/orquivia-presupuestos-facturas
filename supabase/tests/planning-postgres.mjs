// Real PostgreSQL validation, membership/MFA, CAS and audit. Synthetic users only.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { planningFixture } from './planning-fixture.mjs';

const db=await PGlite.create();
const owner='f1000000-0000-4000-8000-000000000001',editor='f1000000-0000-4000-8000-000000000002',outsider='f1000000-0000-4000-8000-000000000003',viewer='f1000000-0000-4000-8000-000000000004',org='f2000000-0000-4000-8000-000000000001';
let checks=0,workspace;
const query=async(sql,args=[])=>{try{return(await db.query(sql,args)).rows;}catch(error){error.testSQL=sql;throw error;}};
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
const denied=async(sql,args=[],message,code)=>{await assert.rejects(db.query(sql,args),error=>(!message||error.message===message)&&(!code||error.code===code));checks++;};
const as=async(role,id=owner,aal='aal2')=>{await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role,aal})]);};
const load=async()=>(await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL='select public.save_orquivia_team_state($1,$2,$3) result';
const save=async(next)=>{const result=(await query(saveSQL,[org,next,workspace.version]))[0].result;workspace=await load();return result;};
const history=async(id='planning',expected=editor)=>(await query('select public.load_orquivia_record_history($1,$2,$3,$4,$5) result',[org,'planning',id,100,expected]))[0].result;
const migration=async name=>{
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
  await db.exec(sql.replace('create extension if not exists supabase_vault with schema vault;',''));
};

try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${owner}','owner@example.test'),('${editor}','editor@example.test'),('${outsider}','outsider@example.test'),('${viewer}','viewer@example.test');
    insert into auth.mfa_factors(user_id,status) values('${owner}','verified'),('${editor}','verified'),('${outsider}','verified'),('${viewer}','verified');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);
    create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql','202610140004_personal_profiles.sql',
    '202610140006_personal_identity.sql','202610140007_expense_quick_entry.sql','202610140008_vat_document_status.sql','202610140009_record_history.sql',
    '202610140010_tax_records_missing_receipts.sql','202610150011_prepared_quotes.sql','202610150012_document_mail.sql','202610150013_mail_recipients.sql',
    '202610230014_invoice_mail.sql','202610260015_invoice_mail_attachments.sql','202610270016_rpc_conflict_http.sql','202611160018_multi_quote_mail.sql',
    '202611160019_mail_drafts.sql','202611180020_document_payment_terms.sql','202611190021_client_document_sync.sql']) await migration(name);
  await as('service_role');await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[owner,editor,'Fixture company',org]);
  await query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await as('authenticated');workspace=await load();const before=structuredClone(workspace);
  await db.exec('reset role');await migration('202611250022_financial_planning.sql');
  await as('authenticated');workspace=await load();equal(workspace,before,'Upgrade is additive and does not rewrite business data');

  await as('authenticated',editor);
  const next=structuredClone(workspace.state);next.planning=planningFixture();
  const result=await save(next);equal(result.state,workspace.state);equal(workspace.state.planning,next.planning);
  equal(workspace.state.company,before.state.company,'Editor changes plans without gaining company-admin permissions');
  equal(workspace.state.documents,before.state.documents);equal(workspace.state.payments,before.state.payments);
  const entries=await history();equal(entries.length,3);equal(entries.every(e=>e.entityType==='planning'&&e.actorId===editor),true);
  equal(entries.some(e=>e.entityId==='settings'),true);equal(entries.some(e=>e.entityId==='forecast:forecast-a'),true);
  equal(entries.some(e=>e.entityId==='scenario:scenario-a'),true);
  equal(JSON.stringify(entries).includes('PRIVATE-SCENARIO-NOTE'),false,'History exposes field names, not private fiscal inputs');

  const previous=structuredClone(workspace);
  const edited=structuredClone(workspace.state);edited.planning.scenarios[0].name='Revised scenario';
  await save(edited);equal((await history('scenario:scenario-a'))[0].changedFields,['name']);
  await denied(saveSQL,[org,previous.state,previous.version],'VERSION_CONFLICT','PT409');equal((await load()).state,workspace.state);
  const companyEdit=structuredClone(workspace.state);companyEdit.company.name='Forbidden company edit';
  await denied(saveSQL,[org,companyEdit,workspace.version],'ADMIN_REQUIRED','42501');

  // Old tabs preserve plans while continuing unrelated authorized operations.
  const legacy=structuredClone(workspace.state);delete legacy.planning;legacy.clients.push({id:'client-fixture',name:'Fixture client'});
  const planningBefore=structuredClone(workspace.state.planning),historyBefore=await history();
  await save(legacy);equal(workspace.state.planning,planningBefore);equal(await history(),historyBefore);

  const invalidChanges=[p=>p.settings.pendingCosts=null,p=>p.settings.corporateTaxConfirmed='false',p=>p.settings.taxYear=2025.5,
    p=>p.settings.horizon='2025-02-29',p=>p.settings.horizon='2039-01-01',p=>p.settings.people[0].retaPeriod=null,
    p=>p.settings.people[0].sharePercent=101,p=>p.settings.password='not-a-real-secret',p=>p.items[0].kind=null,
    p=>p.items[0].recurrence=null,p=>p.items[0].treatment=null,p=>p.items[0].amountGross=10.001,
    p=>p.items[0].id='x'.repeat(141),p=>p.items[0].linkedRecordIds=['same','same'],p=>p.items.push(structuredClone(p.items[0])),
    p=>p.scenarios[0].people[0].personId='missing',p=>p.scenarios[0].people.push(structuredClone(p.scenarios[0].people[0])),
    p=>p.scenarios[0].notes='x'.repeat(2001),p=>p.settings.collectionDates['invoice-fixture']='2025-02-30',
    p=>p.items[0].label='\u00a0',p=>p.items[0].label='\ufeff',p=>p.items[0].id='\u00a0forecast',
    p=>Object.defineProperty(p.settings.collectionDates,'__proto__',{value:'2025-12-01',enumerable:true}),
    p=>Object.defineProperty(p.settings.collectionDates,'constructor',{value:'2025-12-01',enumerable:true}),
    p=>Object.defineProperty(p.settings.collectionDates,'prototype',{value:'2025-12-01',enumerable:true})];
  for(const change of invalidChanges){
    const invalid=structuredClone(workspace.state);change(invalid.planning);
    await as('service_role');equal((await query('select orquivia_private.valid_state($1) valid',[invalid]))[0].valid,false);
    await as('authenticated',editor);await denied(saveSQL,[org,invalid,workspace.version],'INVALID_STATE','22023');
  }
  const invalid=structuredClone(workspace.state);invalid.planning=null;
  await as('service_role');await denied('update public.orquivia_team_workspaces set state=$1 where organization_id=$2',[invalid,org],undefined,'23514');
  await as('authenticated',editor);equal((await load()).state,workspace.state);
  const cleared=structuredClone(workspace.state);cleared.planning.items=[];cleared.planning.scenarios=[];await save(cleared);
  equal((await history('forecast:forecast-a'))[0].action,'deleted');equal((await history('scenario:scenario-a'))[0].action,'deleted');

  await as('authenticated',editor,'aal1');await denied(saveSQL,[org,workspace.state,workspace.version],'MFA_REQUIRED','42501');
  await denied('select public.load_orquivia_record_history($1,$2,$3,$4,$5)',[org,'planning','planning',50,editor],'MFA_REQUIRED','42501');
  equal((await query('select * from public.orquivia_team_workspaces where organization_id=$1',[org])).length,0,'RLS hides the private plan at aal1');
  await as('service_role');await query('update public.orquivia_memberships set active=false where user_id=$1',[editor]);
  await as('authenticated',editor);await denied(saveSQL,[org,workspace.state,workspace.version],'MEMBERSHIP_REQUIRED','42501');
  await denied('select public.load_orquivia_record_history($1,$2,$3,$4,$5)',[org,'planning','planning',50,editor],'MEMBERSHIP_REQUIRED','42501');
  equal((await query('select * from public.orquivia_team_workspaces where organization_id=$1',[org])).length,0,'Revoked members cannot read planning through RLS');
  await as('authenticated',outsider);await denied('select public.load_orquivia_record_history($1,$2,$3,$4,$5)',[org,'planning','planning',50,outsider],undefined,'42501');
  await as('anon',null);await denied('select public.load_orquivia_workspace()',[],undefined,'42501');
  // Fixture-only future role; production keeps its existing admin/editor enum.
  await db.exec(`reset role;alter table public.orquivia_memberships drop constraint orquivia_memberships_role_check;
    alter table public.orquivia_memberships add constraint orquivia_memberships_role_check check(role in ('admin','editor','viewer'));`);
  await query('insert into public.orquivia_memberships(organization_id,user_id,role) values($1,$2,$3)',[org,viewer,'viewer']);
  await as('authenticated',viewer);equal((await load()).state,workspace.state,'A hypothetical viewer remains read-only');
  const viewerDraft=structuredClone(workspace.state);viewerDraft.planning.settings.minimumCash=9000;
  await denied(saveSQL,[org,viewerDraft,workspace.version],'WRITE_ACCESS_REQUIRED','42501');
  const viewerLegacy=structuredClone(workspace.state);delete viewerLegacy.planning;
  await denied(saveSQL,[org,viewerLegacy,workspace.version],'WRITE_ACCESS_REQUIRED','42501');
  equal((await load()).state,workspace.state);
  console.log(`Financial planning PostgreSQL: ${checks} checks passed`);
} finally { await db.close(); }
