// Real validation, issuance, audit and CAS routines; synthetic in-memory data only.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db=await PGlite.create();
const owner='10000000-0000-4000-8000-000000000001',editor='10000000-0000-4000-8000-000000000002',org='20000000-0000-4000-8000-000000000001';
let checks=0;
const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
const denied=async(sql,args=[],message)=>{await assert.rejects(db.query(sql,args),message?error=>error.message===message:undefined);checks++;};
const as=async(role,id=owner)=>{await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role,aal:'aal2'})]);};
const load=async()=>(await query('select public.load_orquivia_workspace() result'))[0].result;
const save=async(workspace)=>{await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,workspace.state,workspace.version]);return load();};
const issue=async(id,version)=>(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,id,version]))[0].result;
const history=async(id)=>(await query('select public.load_orquivia_record_history($1,$2,$3,$4,$5) result',[org,'document',id,50,owner]))[0].result;
const document=(id,kind='quote')=>({id,kind,number:'',status:'draft',clientId:'client',date:'2025-05-01',dueDate:'',items:[{description:'Synthetic service',quantity:1,price:100}],vat:21,discount:0,withholding:0});
try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${owner}','owner@example.test'),('${editor}','editor@example.test');
    insert into auth.mfa_factors(user_id,status) values('${owner}','verified'),('${editor}','verified');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;
    -- Synthetic adapter; production uses the encrypted Supabase Vault extension.
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);
    create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql','202610140004_personal_profiles.sql','202610140006_personal_identity.sql','202610140007_expense_quick_entry.sql','202610140008_vat_document_status.sql','202610140009_record_history.sql','202610140010_tax_records_missing_receipts.sql','202610150011_prepared_quotes.sql','202610150012_document_mail.sql','202610150013_mail_recipients.sql','202610230014_invoice_mail.sql','202610260015_invoice_mail_attachments.sql','202610270016_rpc_conflict_http.sql','202611160018_multi_quote_mail.sql','202611160019_mail_drafts.sql']) {
    const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
    await db.exec(sql.replace('create extension if not exists supabase_vault with schema vault;',''));
  }
  await as('service_role');await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[owner,editor,'Fixture company',org]);
  await as('authenticated');let workspace=await load();
  workspace.state.clients=[{id:'client',name:'Fixture client'}];
  workspace.state.documents=[document('legacy-invoice','invoice'),document('quote'),document('draft-invoice','invoice')];
  workspace=await save(workspace);workspace=await issue('legacy-invoice',workspace.version);workspace=await issue('quote',workspace.version);
  const before=await load();
  await as('service_role');const ledgerBefore=await query('select * from public.orquivia_document_numbers order by document_id');
  await db.exec('reset role');await db.exec(await readFile(new URL('../migrations/202611180020_document_payment_terms.sql',import.meta.url),'utf8'));
  await as('authenticated');workspace=await load();equal(workspace,before);
  await as('service_role');equal(await query('select * from public.orquivia_document_numbers order by document_id'),ledgerBefore);
  equal((await query('select orquivia_private.valid_state($1) valid',[workspace.state]))[0].valid,true);
  // Both optional fields retain legacy absence. Zero is immediate, not a missing value.
  for(const value of [0,1,30,365]) {
    const next=structuredClone(workspace.state);next.documents.find(d=>d.id==='draft-invoice').paymentTerms=value;
    equal((await query('select orquivia_private.valid_state($1) valid',[next]))[0].valid,true);
  }
  for(const value of [-1,366,1.5,'0','NaN',null,true,[],{}]) {
    const next=structuredClone(workspace.state);next.documents.find(d=>d.id==='draft-invoice').paymentTerms=value;
    equal((await query('select orquivia_private.valid_state($1) valid',[next]))[0].valid,false);
  }
  const text='100 % al aceptar el presupuesto.';
  for(const value of [text,'A','x'.repeat(500)]) {
    const next=structuredClone(workspace.state);next.documents.find(d=>d.id==='draft-invoice').paymentTermsText=value;
    equal((await query('select orquivia_private.valid_state($1) valid',[next]))[0].valid,true);
  }
  for(const value of ['', ' \t\r\n', 'x'.repeat(501),0,null,true,[],{}]) {
    const next=structuredClone(workspace.state);next.documents.find(d=>d.id==='draft-invoice').paymentTermsText=value;
    equal((await query('select orquivia_private.valid_state($1) valid',[next]))[0].valid,false);
  }
  let invalid=structuredClone(workspace.state);invalid.documents.find(d=>d.id==='draft-invoice').paymentTerms=-1;
  await denied('update public.orquivia_team_workspaces set state=$1 where organization_id=$2',[invalid,org]);
  await as('authenticated');await denied('select public.save_orquivia_team_state($1,$2,$3)',[org,invalid,workspace.version],'INVALID_STATE');
  equal((await load()).version,workspace.version);
  // A prepared quote can be edited. Audit reports field names without exposing values.
  workspace.state.documents.find(d=>d.id==='quote').paymentTerms=0;workspace=await save(workspace);
  let entries=await history('quote');equal(entries[0].changedFields,['paymentTerms']);equal(entries[0].actorId,owner);
  const quote=workspace.state.documents.find(d=>d.id==='quote');
  workspace.state.documents.push({...structuredClone(quote),id:'converted',kind:'invoice',status:'draft',number:'',quoteId:'quote'});
  workspace=await save(workspace);equal(workspace.state.documents.find(d=>d.id==='converted').paymentTerms,0);
  workspace=await issue('converted',workspace.version);equal(workspace.state.documents.find(d=>d.id==='converted').paymentTerms,0);
  equal(workspace.state.company.paymentTerms,before.state.company.paymentTerms);
  // Numeric and custom terms are fiscal: an issued invoice cannot add, change or remove them.
  for(const [id,changes,remove] of [['legacy-invoice',{paymentTerms:0}],['legacy-invoice',{paymentTermsText:text}],['converted',{paymentTerms:30}],['converted',{},'paymentTerms'],['converted',{paymentTermsText:text}]]) {
    const next=structuredClone(workspace.state),d=next.documents.find(d=>d.id===id);Object.assign(d,changes);if(remove)delete d[remove];
    await denied('select public.save_orquivia_team_state($1,$2,$3)',[org,next,workspace.version],'ISSUED_DOCUMENT_IMMUTABLE');
  }
  const q=workspace.state.documents.find(d=>d.id==='quote');delete q.paymentTerms;q.paymentTermsText=text;workspace=await save(workspace);
  entries=await history('quote');equal(entries[0].changedFields,['paymentTerms','paymentTermsText']);equal(JSON.stringify(entries).includes(text),false);
  // Both can coexist for compatibility. The application displays the custom text first.
  Object.assign(workspace.state.documents.find(d=>d.id==='draft-invoice'),{paymentTerms:365,paymentTermsText:text});workspace=await save(workspace);
  workspace=await issue('draft-invoice',workspace.version);
  equal(workspace.state.documents.find(d=>d.id==='draft-invoice').paymentTermsText,text);
  for(const changes of [{paymentTermsText:'Different terms'},{paymentTermsText:null}]) {
    const next=structuredClone(workspace.state);Object.assign(next.documents.find(d=>d.id==='draft-invoice'),changes);
    await denied('select public.save_orquivia_team_state($1,$2,$3)',[org,next,workspace.version],changes.paymentTermsText===null?'INVALID_STATE':'ISSUED_DOCUMENT_IMMUTABLE');
  }
  const next=structuredClone(workspace.state);delete next.documents.find(d=>d.id==='draft-invoice').paymentTermsText;
  await denied('select public.save_orquivia_team_state($1,$2,$3)',[org,next,workspace.version],'ISSUED_DOCUMENT_IMMUTABLE');
  equal((await load()).version,workspace.version);
  for(const role of ['anon','authenticated']) {
    await as(role);await denied('select orquivia_private.valid_state($1)',[workspace.state]);
    await denied('select orquivia_private.record_change_fields($1,$2,$3)',['document',{},{}]);
  }
  console.log(`PASS ${checks} document payment-conditions PostgreSQL checks: legacy preservation, optional numeric/custom validation, audit, quote conversion and issued-invoice immutability.`);
} finally {await db.close();}
