// Real server normalization, fiscal guards, history and mail claims; no live data.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { emptyState } from '../../src/demo.js';

const db=await PGlite.create();
const owner='10000000-0000-4000-8000-000000000001',editor='10000000-0000-4000-8000-000000000002',org='20000000-0000-4000-8000-000000000001';
let checks=0,workspace;
const query=async(sql,args=[])=>{try{return (await db.query(sql,args)).rows;}catch(error){error.testSQL=sql;throw error;}};
const equal=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
const denied=async(sql,args=[],message,code)=>{await assert.rejects(db.query(sql,args),error=>(!message||error.message===message)&&(!code||error.code===code));checks++;};
const as=async(role,id=owner,aal='aal2')=>{await db.exec(`reset role;set role ${role}`);await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role,aal})]);};
const load=async()=>(await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL='select public.save_orquivia_team_state($1,$2,$3) result';
const save=async(next=workspace.state)=>{const result=(await query(saveSQL,[org,next,workspace.version]))[0].result;workspace=await load();return result;};
const edit=async(change)=>{const next=structuredClone(workspace.state);change(next);return save(next);};
const doc=(state,id)=>state.documents.find(d=>d.id===id);
const document=(id,kind='quote')=>({id,kind,number:'',status:'draft',clientId:'client',date:'2025-05-01',dueDate:'',items:[{description:'Synthetic service',quantity:1,price:100}],vat:21,discount:0,withholding:0});
const id=n=>`30000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
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
    insert into auth.users values('${owner}','owner@example.test'),('${editor}','editor@example.test');
    insert into auth.mfa_factors(user_id,status) values('${owner}','verified'),('${editor}','verified');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;
    -- Synthetic adapter; production retains encrypted Supabase Vault.
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);
    create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql','202610140004_personal_profiles.sql','202610140006_personal_identity.sql','202610140007_expense_quick_entry.sql','202610140008_vat_document_status.sql','202610140009_record_history.sql','202610140010_tax_records_missing_receipts.sql','202610150011_prepared_quotes.sql','202610150012_document_mail.sql','202610150013_mail_recipients.sql','202610230014_invoice_mail.sql','202610260015_invoice_mail_attachments.sql','202610270016_rpc_conflict_http.sql','202611160018_multi_quote_mail.sql','202611160019_mail_drafts.sql','202611180020_document_payment_terms.sql']) await migration(name);
  await as('service_role');await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[owner,editor,'Fixture company',org]);
  await query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await as('authenticated');workspace=await load();
  const initial=emptyState();
  initial.clients=[{id:'client',name:'Original client',taxId:'FIXTURE-CLIENT',email:'old-contact@example.test',billingEmail:'old-accounts@example.test',address:'Old address'},{id:'other',name:'Other client',email:'other@example.test'}];
  const quotes=['quote-ready','quote-second','quote-sent','quote-restored','quote-accepted','quote-sending','quote-related','quote-failed','quote-uncertain','quote-archive','quote-linked','quote-linked-draft','quote-new-link','quote-remove-link','quote-new-status','quote-legacy-sent','quote-legacy-ready','quote-legacy-sending','quote-legacy-related','quote-legacy-history'];
  const invoices=['invoice-ready','invoice-custom','invoice-absent','invoice-sent','invoice-unknown','invoice-restored','invoice-sending'];
  initial.documents=[...quotes.map(name=>document(name)),...invoices.map(name=>({...document(name,'invoice'),billingEmail:'old-accounts@example.test'})),
    {...document('draft-quote'),clientSnapshot:{name:'Stale draft client'}},
    {...document('draft-invoice','invoice'),clientSnapshot:{name:'Stale draft client'},billingEmail:'old-accounts@example.test'},
    {...document('draft-custom','invoice'),billingEmail:'custom@example.test'},
    document('draft-absent','invoice'),document('draft-explicit','invoice'),
    {...document('draft-other'),clientId:'other',clientSnapshot:{name:'Stale unrelated draft client'}}];
  doc(initial,'invoice-custom').billingEmail='custom@example.test';
  delete doc(initial,'invoice-absent').billingEmail;
  await save(initial);
  for(const name of [...quotes,...invoices]) {
    const issued=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,name,workspace.version]))[0].result;
    workspace={...workspace,...issued};
  }
  workspace=await load();
  await edit(next=>{
    doc(next,'quote-sent').status='sent';doc(next,'quote-restored').status='sent';doc(next,'quote-accepted').status='accepted';
    doc(next,'quote-legacy-sent').status='sent';delete doc(next,'quote-legacy-sent').clientSnapshot;
    delete doc(next,'quote-legacy-ready').clientSnapshot;
    for(const name of ['quote-legacy-sending','quote-legacy-related','quote-legacy-history']) delete doc(next,name).clientSnapshot;
    doc(next,'quote-legacy-history').status='sent';
    doc(next,'quote-ready').clientSnapshot={name:'Stale prepared client'};
    doc(next,'invoice-sent').deliveryStatus='sent';doc(next,'invoice-restored').deliveryStatus='sent';delete doc(next,'invoice-unknown').deliveryStatus;
    next.documents.push({...document('linked-invoice','invoice'),quoteId:'quote-linked'},
      {...document('linked-draft-invoice','invoice'),quoteId:'quote-linked-draft',billingEmail:'old-accounts@example.test',clientSnapshot:{name:'Stale converted draft client'}},
      {...document('removed-invoice','invoice'),quoteId:'quote-remove-link'});
  });
  await edit(next=>{doc(next,'quote-restored').status='ready';doc(next,'invoice-restored').deliveryStatus='ready';});
  await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'linked-invoice',workspace.version]);
  workspace=await load();
  await db.exec('reset role');
  const fixtures=[['quote-sending','sending'],['quote-failed','failed'],['quote-uncertain','uncertain'],['quote-archive','archive_pending'],['invoice-sending','sending'],['quote-legacy-sending','sending'],['quote-legacy-history','sent']];
  const mailedLegacyClient={...initial.clients[0],name:'Historically captured client'};
  for(const [index,[name,status]] of fixtures.entries()) {
    const relatedId=name==='quote-sending'?'quote-related':name==='quote-legacy-sending'?'quote-legacy-related':null;
    const snapshot=name==='quote-legacy-history'?{...doc(workspace.state,name),clientSnapshot:mailedLegacyClient}:doc(workspace.state,name);
    await query(`insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,subject,status,related_documents,created_at)
      values($1,$2,$3,$4,'fixture-request',$5,'owner@example.test','["old-contact@example.test"]','Synthetic fixture',$6,$7,now()-interval '2 days')`,
      [id(index+1),org,owner,name,snapshot,status,relatedId?[{document:doc(workspace.state,relatedId),client:initial.clients[0],company:workspace.state.company}]:[]]);
  }
  const ledgerBefore=await query('select * from public.orquivia_document_numbers order by document_id');
  const jobsBefore=await query('select * from orquivia_private.mail_jobs order by id');
  const fiscalBefore=(await query("select pg_get_functiondef('orquivia_private.fiscal_data(jsonb)'::regprocedure) definition"))[0].definition;
  await as('authenticated');const before=await load();
  await db.exec('reset role');await migration('202611190021_client_document_sync.sql');
  await as('authenticated');workspace=await load();equal(workspace,before,'Migration itself does not rewrite documents');

  // Every save repairs stale preparation, including drafts belonging to a
  // different client. The response contains precisely the persisted state.
  let result=await edit(next=>{next.clients.find(c=>c.id==='other').name='Other client edited';});
  equal(result.state,workspace.state);equal(result.version,workspace.version);equal(typeof result.updated_at,'string');
  for(const name of ['draft-quote','draft-invoice','draft-other','linked-draft-invoice']) equal(Object.hasOwn(doc(workspace.state,name),'clientSnapshot'),false);
  for(const name of ['quote-ready','quote-legacy-ready']) equal(doc(workspace.state,name).clientSnapshot,initial.clients[0]);
  equal(doc(workspace.state,'quote-legacy-sent').clientSnapshot,initial.clients[0],'Legacy sent quotes freeze their previous effective client');
  equal(doc(workspace.state,'quote-legacy-history').clientSnapshot,mailedLegacyClient,'Available historical evidence takes precedence over the current master');
  for(const name of ['quote-legacy-sending','quote-legacy-related']) equal(doc(workspace.state,name),doc(before.state,name),'Legacy in-flight documents retain exact claim JSON');
  equal(doc(workspace.state,'quote-ready').companySnapshot,doc(before.state,'quote-ready').companySnapshot);
  const history=(await query('select public.load_orquivia_record_history($1,$2,$3,$4,$5) result',[org,'document','quote-legacy-sent',20,owner]))[0].result;
  equal(history[0].changedFields,['clientSnapshot']);equal(history[0].actorId,owner);equal(history[0].event,'save');

  const previous=structuredClone(workspace.state),staleVersion=workspace.version;
  result=await edit(next=>{
    Object.assign(next.clients[0],{name:'Updated client',email:'new-contact@example.test',billingEmail:'new-accounts@example.test',address:'New address'});
    next.documents.push({...document('new-linked-invoice','invoice'),quoteId:'quote-new-link'});
    next.documents=next.documents.filter(d=>d.id!=='removed-invoice');
    doc(next,'quote-new-status').status='sent';
    doc(next,'draft-explicit').billingEmail='chosen-in-this-save@example.test';
  });
  equal(result.state,workspace.state);
  for(const name of ['quote-ready','quote-second','quote-legacy-ready','quote-linked-draft','quote-new-link','quote-remove-link']) equal(doc(workspace.state,name).clientSnapshot,workspace.state.clients[0]);
  const frozenQuotes=['quote-sent','quote-restored','quote-accepted','quote-sending','quote-related','quote-failed','quote-uncertain','quote-archive','quote-linked','quote-legacy-sent','quote-legacy-sending','quote-legacy-related','quote-legacy-history'];
  for(const name of frozenQuotes) equal(doc(workspace.state,name),doc(previous,name),`${name} retains its exact document`);
  // Conversion to a draft keeps both documents in preparation. The quote
  // snapshots the updated master while the draft continues to resolve it live.
  const linkedDraft=doc(workspace.state,'linked-draft-invoice');
  equal(linkedDraft.status,'draft');equal(Object.hasOwn(linkedDraft,'clientSnapshot'),false);
  equal(doc(workspace.state,'quote-linked-draft').clientSnapshot,workspace.state.clients.find(c=>c.id===linkedDraft.clientId));
  equal(linkedDraft.billingEmail,'new-accounts@example.test');
  for(const field of ['clientId','clientSnapshot']) equal(doc(workspace.state,'linked-invoice')[field],doc(previous,'linked-invoice')[field],'An issued linked invoice and its source quote retain their parties');
  equal(doc(workspace.state,'quote-new-status').clientSnapshot,doc(previous,'quote-new-status').clientSnapshot);
  for(const name of ['draft-invoice','draft-absent','invoice-ready','invoice-absent']) equal(doc(workspace.state,name).billingEmail,'new-accounts@example.test');
  for(const name of ['draft-custom','invoice-custom']) equal(doc(workspace.state,name).billingEmail,'custom@example.test');
  equal(doc(workspace.state,'draft-explicit').billingEmail,'chosen-in-this-save@example.test');
  for(const name of ['invoice-sent','invoice-unknown','invoice-restored','invoice-sending']) equal(doc(workspace.state,name),doc(previous,name));
  for(const name of invoices) equal(doc(workspace.state,name).clientSnapshot,doc(previous,name).clientSnapshot,'Every issued fiscal party remains frozen');
  await denied(saveSQL,[org,previous,staleVersion],'VERSION_CONFLICT','PT409');equal((await load()).version,workspace.version);

  // Protected parties cannot be changed or stripped through a crafted request.
  for(const name of [...frozenQuotes,'quote-new-status']) {
    const next=structuredClone(workspace.state);doc(next,name).clientSnapshot={name:'Forged historical client'};
    await denied(saveSQL,[org,next,workspace.version],'DOCUMENT_CLIENT_LOCKED');
  }
  const switched=structuredClone(workspace.state);doc(switched,'quote-sent').clientId='other';
  await denied(saveSQL,[org,switched,workspace.version],'DOCUMENT_CLIENT_LOCKED');
  const oldTab=structuredClone(workspace.state);delete doc(oldTab,'quote-legacy-sent').clientSnapshot;delete doc(oldTab,'quote-sent').clientSnapshot;
  result=await save(oldTab);
  for(const name of ['quote-legacy-sent','quote-sent']) equal(doc(result.state,name).clientSnapshot,doc(previous,name).clientSnapshot,'Omitted historical snapshots are restored for older tabs');
  // A client which ignores response.state can repeat the omission at a fresh
  // CAS version without erasing the authoritative snapshot or blocking saves.
  result=await save(oldTab);equal(doc(result.state,'quote-legacy-sent').clientSnapshot,doc(previous,'quote-legacy-sent').clientSnapshot);
  for(const name of ['invoice-ready','invoice-sent','invoice-unknown']) for(const field of ['clientSnapshot','clientId']) {
    const next=structuredClone(workspace.state);doc(next,name)[field]=field==='clientId'?'other':{name:'Forged invoice party'};
    await denied(saveSQL,[org,next,workspace.version],'ISSUED_DOCUMENT_IMMUTABLE');
  }
  // Operational per-invoice recipient editing remains available independently.
  await edit(next=>{doc(next,'invoice-sent').billingEmail='manual-recipient@example.test';});
  equal(doc(workspace.state,'invoice-sent').billingEmail,'manual-recipient@example.test');

  await db.exec('reset role');
  equal(await query('select * from public.orquivia_document_numbers order by document_id'),ledgerBefore,'No fiscal ledger or counter is rewritten');
  equal(await query('select * from orquivia_private.mail_jobs order by id'),jobsBefore,'Historical messages retain their exact snapshots');
  equal((await query("select pg_get_functiondef('orquivia_private.fiscal_data(jsonb)'::regprocedure) definition"))[0].definition,fiscalBefore);
  // Import has its own path but shares the historical quote invariant checker.
  await as('service_role');
  const forged=structuredClone(workspace.state);doc(forged,'quote-sent').clientSnapshot={name:'Import forgery'};
  await denied('select public.import_orquivia_state($1,$2,$3)',[org,forged,workspace.version],'DOCUMENT_CLIENT_LOCKED');
  const claim='select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result';
  const invoiceClaim=(await query(claim,[owner,org,id(50),'invoice-ready',workspace.version,'invoice-request',['new-accounts@example.test'],'Prepared invoice',[],[],[]]))[0].result;
  equal(invoiceClaim.client,doc(workspace.state,'invoice-ready').clientSnapshot);equal(invoiceClaim.document,doc(workspace.state,'invoice-ready'));
  const quoteClaim=(await query(claim,[owner,org,id(51),'quote-ready',workspace.version,'quote-request',['new-contact@example.test'],'Prepared alternatives',[],[],['quote-second']]))[0].result;
  equal(quoteClaim.client,workspace.state.clients[0]);equal(quoteClaim.relatedDocuments[0].client,workspace.state.clients[0]);
  await as('authenticated');const claimedState=structuredClone(workspace.state);
  await edit(next=>{next.clients[0].email='later-contact@example.test';next.clients[0].billingEmail='later-accounts@example.test';});
  for(const name of ['quote-ready','quote-second','invoice-ready']) equal(doc(workspace.state,name),doc(claimedState,name),'In-flight primary and related documents remain identical');
  equal(doc(workspace.state,'draft-invoice').billingEmail,'later-accounts@example.test');
  await as('service_role');
  const complete='select public.orquivia_mail_complete($1,$2,$3,$4,$5) result';
  const completed=(await query(complete,[owner,org,id(51),'archive_pending',null]))[0].result;
  equal(doc(completed.workspace.state,'quote-ready').status,'sent');equal(doc(completed.workspace.state,'quote-second').status,'sent');
  const invoiceComplete=(await query(complete,[owner,org,id(50),'archive_pending',null]))[0].result;
  equal(doc(invoiceComplete.workspace.state,'invoice-ready').deliveryStatus,'sent');
  const legacyComplete=(await query(complete,[owner,org,id(6),'archive_pending',null]))[0].result;
  for(const name of ['quote-legacy-sending','quote-legacy-related']) {
    equal(doc(legacyComplete.workspace.state,name).status,'sent');
    equal(Object.hasOwn(doc(legacyComplete.workspace.state,name),'clientSnapshot'),false,'Completion preserves legacy JSON while archiving');
  }
  equal(await query('select * from public.orquivia_document_numbers order by document_id'),ledgerBefore);
  await as('authenticated');workspace=await load();await save();
  for(const name of ['quote-legacy-sending','quote-legacy-related']) equal(Object.hasOwn(doc(workspace.state,name),'clientSnapshot'),false,'Archive-pending legacy documents stay unchanged');
  await as('service_role');await query(complete,[owner,org,id(6),'sent',null]);
  await as('authenticated');workspace=await load();
  const latestLegacyFallback=structuredClone(workspace.state.clients[0]);
  await edit(next=>{delete next.clients[0].billingEmail;delete next.clients[0].email;});
  equal(doc(workspace.state,'quote-legacy-sending').clientSnapshot,latestLegacyFallback,'Missing legacy evidence freezes only the last known effective client');
  equal(doc(workspace.state,'quote-legacy-related').clientSnapshot,initial.clients[0],'Related mail retains its captured historical party');
  for(const name of ['draft-invoice','draft-absent','invoice-absent']) equal(Object.hasOwn(doc(workspace.state,name),'billingEmail'),false,'Removing an inherited default removes the operational override');
  equal(doc(workspace.state,'draft-custom').billingEmail,'custom@example.test');equal(doc(workspace.state,'invoice-custom').billingEmail,'custom@example.test');
  equal(doc(workspace.state,'invoice-ready').billingEmail,'new-accounts@example.test','Sent recipients stay as they were');

  // The wrapper retains authorization, validation and CAS, and its predecessor
  // is inaccessible to browser roles, preventing normalization bypass.
  const version=workspace.version;
  await as('authenticated',editor);const companyEdit=structuredClone(workspace.state);companyEdit.company.name='Editor cannot rename company';
  await denied(saveSQL,[org,companyEdit,version],'ADMIN_REQUIRED');
  await as('authenticated',owner,'aal1');await denied(saveSQL,[org,workspace.state,version],'MFA_REQUIRED');
  await as('authenticated');const invalid=structuredClone(workspace.state);invalid.documents[0].items=[];
  await denied(saveSQL,[org,invalid,version],'INVALID_STATE');
  for(const role of ['anon','authenticated']) {
    await as(role);
    await denied('select orquivia_private.save_team_before_client_document_sync($1,$2,$3)',[org,workspace.state,version]);
    await denied('select orquivia_private.sync_document_clients($1,$2,$3)',[org,workspace.state,workspace.state]);
    await denied('select orquivia_private.check_issued_before_client_document_sync($1,$2,$3)',[org,workspace.state,workspace.state]);
  }
  await as('anon');await denied(saveSQL,[org,workspace.state,version]);
  await as('authenticated');equal((await load()).version,version,'Denied writes do not advance CAS');
  console.log(`PASS ${checks} client/document PostgreSQL checks: canonical draft/quote synchronization, historical and mail locks, inherited/custom recipients, unchanged fiscal ledgers, audit, CAS and permissions.`);
} catch(error) {console.error(error.code,error.message,error.where||'',error.position||'',error.testSQL||'',error.code==='ERR_ASSERTION'?error.stack:'');process.exitCode=1;}
finally {await db.close();}
