import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { emptyState } from '../../src/demo.js';
import { isMailAddress } from '../../src/mail-address.js';

const db = await PGlite.create();
const user='10000000-0000-4000-8000-000000000001', editor='10000000-0000-4000-8000-000000000002', org='20000000-0000-4000-8000-000000000001', job='30000000-0000-4000-8000-000000000001';
let checks=0;
const query=async(sql,params=[])=>(await db.query(sql,params)).rows;
const equal=(a,b)=>{assert.deepEqual(a,b);++checks;};
const deny=async(sql,params=[])=>{await assert.rejects(db.query(sql,params));++checks;};
const as=async(role,owner=user)=>{await db.exec(`reset role;set role ${role}`);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role,aal:'aal2'})]);};
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${user}','owner@example.test'),('${editor}','editor@example.test');
    insert into auth.mfa_factors(user_id,status) values('${user}','verified'),('${editor}','verified');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;
    -- Synthetic Vault adapter only for this in-memory SQL permissions test.
    -- Production installs the real encrypted Supabase Vault extension.
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);
    create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql','202610140004_personal_profiles.sql','202610140006_personal_identity.sql','202610140007_expense_quick_entry.sql','202610140008_vat_document_status.sql','202610140009_record_history.sql','202610140010_tax_records_missing_receipts.sql','202610150011_prepared_quotes.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const migration=await readFile(new URL('../migrations/202610150012_document_mail.sql',import.meta.url),'utf8');
  await db.exec(migration.replace('create extension if not exists supabase_vault with schema vault;',''));
  await db.exec(await readFile(new URL('../migrations/202610150013_mail_recipients.sql',import.meta.url),'utf8'));
  await as('service_role');await db.query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[user,editor,'Fixture company',org]);

  await db.exec('reset role');
  for(const name of ['202610230014_invoice_mail.sql','202610260015_invoice_mail_attachments.sql','202610270016_rpc_conflict_http.sql','202611160018_multi_quote_mail.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const state=emptyState();state.clients=[{id:'client',name:'Fixture client'},{id:'other',name:'Other client'}];
  const quote=id=>({id,kind:'quote',number:'',status:'draft',clientId:'client',date:'2025-05-01',dueDate:'',items:[{description:'Synthetic service',quantity:1,price:100}],vat:21,discount:0,withholding:0});
  state.documents=['main','extra','unchanged','third','fourth','fifth','wrong-client','unused','linked','no-date-edit'].map(quote);
  state.documents.find(d=>d.id==='wrong-client').clientId='other';
  state.documents.push({...quote('invoice'),kind:'invoice'},{...quote('draft')});
  await as('authenticated');
  let workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  let saved=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,state,workspace.version]))[0].result;
  for(const d of state.documents.filter(d=>d.id!=='draft')) saved=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,d.id,saved.version]))[0].result;
  workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  const save='select public.save_orquivia_team_state($1,$2,$3) result';
  // A never-mailed prepared quote can be reused within its numbering year.
  let revised=structuredClone(workspace.state);revised.documents.find(d=>d.id==='unused').date='2025-05-02';
  saved=(await query(save,[org,revised,workspace.version]))[0].result;
  workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  equal(workspace.state.documents.find(d=>d.id==='unused').date,'2025-05-02');
  await as('service_role');
  equal((await query("select issue_date::text,number from public.orquivia_document_numbers where document_id='unused'"))[0],{issue_date:'2025-05-02',number:workspace.state.documents.find(d=>d.id==='unused').number});
  await as('authenticated');
  for(const [id,date] of [['unused','2024-12-31'],['unused','2999-01-01'],['invoice','2025-05-02']]) {
    revised=structuredClone(workspace.state);revised.documents.find(d=>d.id===id).date=date;
    await deny(save,[org,revised,workspace.version]);
  }
  // A failed broader edit must roll back its provisional ledger-date change.
  revised=structuredClone(workspace.state);Object.assign(revised.documents.find(d=>d.id==='unused'),{date:'2025-05-03',number:'FORGED'});
  await deny(save,[org,revised,workspace.version]);
  await as('service_role');equal((await query("select issue_date::text from public.orquivia_document_numbers where document_id='unused'"))[0].issue_date,'2025-05-02');
  const profile=(await query('select public.orquivia_mail_save_profile($1,$2,$3,$4,$5,$6,$7,$8) result',[user,org,0,{name:'Fixture owner',role:'',phone:''},'serviciodecorreo','synthetic-test-secret','Sent',false]))[0].result;
  equal(profile.connected,true);
  const claim='select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
  const values=(id,doc='main',related=['extra'],version=workspace.version)=>[user,org,id,doc,version,'fixture-request',['client@example.test'],'Two alternatives',[],[],related];
  const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  for(const related of [['main'],['extra','extra'],['wrong-client'],['draft'],['missing'],['invoice'],['extra','third','fourth','fifth','unused'],[5],null]) await deny(claim,values(id(1),'main',related));
  await deny(claim,values(id(1),'invoice',['extra']));
  await deny(claim,values(id(1),'main',['extra'],workspace.version-1));
  await as('authenticated');await deny(claim,values(id(1)));await as('anon');await deny(claim,values(id(1)));await as('service_role');
  let result=(await query(claim,values(id(1))))[0].result;
  equal(result.existing,false);equal(result.relatedDocuments.map(v=>v.document.id),['extra']);equal(result.job.relatedDocumentIds,['extra']);
  equal(result.job.relatedDocuments,[{id:'extra',number:workspace.state.documents.find(d=>d.id==='extra').number,kind:'quote'}]);
  equal(result.job.documentNumber,workspace.state.documents.find(d=>d.id==='main').number);
  equal((await query(claim,values(id(1))))[0].result.existing,true);
  await deny(claim,values(id(1),'main',['third']));
  await deny(claim,values(id(2),'extra',[]));
  await deny(claim,values(id(2),'third',['extra']));
  // Changes made after the claim are preserved while unchanged members are marked sent.
  await as('authenticated');revised=structuredClone(workspace.state);revised.documents.find(d=>d.id==='extra').notes='Concurrent authorized correction';
  saved=(await query(save,[org,revised,workspace.version]))[0].result;workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  revised=structuredClone(workspace.state);revised.documents.find(d=>d.id==='main').date='2025-05-02';await deny(save,[org,revised,workspace.version]);
  await as('service_role');
  const complete='select public.orquivia_mail_complete($1,$2,$3,$4,$5) result';
  const raw=Buffer.from('exact synthetic MIME').toString('base64');
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,id(1),raw,'<fixture@example.test>','fixture-pdf-hash']);
  result=(await query(complete,[user,org,id(1),'archive_pending',null]))[0].result;
  equal(result.workspace.version,workspace.version+1);
  equal(result.workspace.state.documents.find(d=>d.id==='main').status,'sent');
  equal(result.workspace.state.documents.find(d=>d.id==='extra').status,'ready');
  equal(result.workspace.state.documents.find(d=>d.id==='extra').notes,'Concurrent authorized correction');
  equal(result.workspace.state.documents.find(d=>d.id==='unchanged').status,'ready');
  equal((await query('select public.orquivia_mail_history($1,$2,$3) result',[user,org,'main']))[0].result.history[0].id,id(1));
  equal((await query('select public.orquivia_mail_history($1,$2,$3) result',[editor,org,'extra']))[0].result.history[0].id,id(1));
  result=(await query(complete,[user,org,id(1),'sent',null]))[0].result;equal(result.job.status,'sent');
  await db.exec('reset role');equal((await query('select raw_message from orquivia_private.mail_jobs where id=$1',[id(1)]))[0].raw_message,null);
  equal((await query("select count(*)::int count from public.orquivia_audit_log where event='email_sent'"))[0].count,1);
  await as('authenticated');workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  await as('service_role');
  result=(await query(claim,values(id(2),'extra',['third'])))[0].result;
  result=(await query(complete,[user,org,id(2),'archive_pending',null]))[0].result;
  equal(result.workspace.state.documents.filter(d=>['extra','third'].includes(d.id)).map(d=>d.status),['sent','sent']);
  await query(complete,[user,org,id(2),'sent',null]);
  await as('authenticated');workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  await as('service_role');
  await query(claim,values(id(3),'fourth',['fifth']));
  result=(await query(complete,[user,org,id(3),'uncertain',{errorCode:'SMTP_PARTIAL',accepted:['client@example.test'],rejected:[]}]))[0].result;
  equal(result.workspace,undefined);equal(result.job.status,'uncertain');
  await deny(claim,values(id(4),'fifth',[]));await deny(claim,values(id(4),'unused',['fourth']));
  await as('authenticated');revised=structuredClone(workspace.state);revised.documents.find(d=>d.id==='fourth').date='2025-05-02';await deny(save,[org,revised,workspace.version]);
  // Linked invoice quotes cannot have their numbering date revised.
  revised=structuredClone(workspace.state);revised.documents.push({...quote('linked-invoice'),kind:'invoice',quoteId:'linked'});
  saved=(await query(save,[org,revised,workspace.version]))[0].result;workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  revised=structuredClone(workspace.state);revised.documents.find(d=>d.id==='linked').date='2025-05-02';await deny(save,[org,revised,workspace.version]);
  equal((await query('select public.load_orquivia_workspace() result'))[0].result.version,workspace.version);
  console.log(`PASS ${checks} multi-quote PostgreSQL checks: same-client isolation, permissions, immutable snapshots, grouped statuses/history, concurrency, idempotency, partial SMTP protection and restricted prepared-quote date correction.`);
} catch(error) { console.error(error.code,error.message,error.where||'',error.position||'');process.exitCode=1; }
finally {await db.close();}
