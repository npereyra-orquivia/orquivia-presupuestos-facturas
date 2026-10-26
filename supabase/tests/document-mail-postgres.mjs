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
  const state=emptyState();state.clients=[{id:'client',name:'Fixture client',email:'client@example.test'}];state.documents=[{id:'quote',kind:'quote',number:'',status:'draft',clientId:'client',date:'2025-05-01',dueDate:'',items:[{description:'Synthetic service',quantity:1,price:100}],vat:21,discount:0,withholding:0}];
  state.documents.push({...state.documents[0],id:'quote-partial'});
  state.documents.push({...state.documents[0],id:'invoice',kind:'invoice',po:'PO-FIXTURE'});
  state.documents.push({...state.documents[0],id:'invoice-draft',kind:'invoice'});
  await as('authenticated');let workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  let saved=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,state,workspace.version]))[0].result;
  let issued=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'quote',saved.version]))[0].result;
  issued=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'quote-partial',issued.version]))[0].result;
  issued=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'invoice',issued.version]))[0].result;
  // Migrate a populated workspace. Old delivery metadata stays unclassified;
  // issued financial ledger entries, payment state and counters do not change.
  const preMigration=structuredClone(issued);
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../migrations/202610230014_invoice_mail.sql',import.meta.url),'utf8'));
  await as('authenticated');
  equal((await query('select public.load_orquivia_workspace() result'))[0].result.state,preMigration.state);
  const profileSQL='select public.orquivia_mail_profile($1,$2,$3) result';
  await deny(profileSQL,[user,org,true]);await deny('select * from orquivia_private.mail_jobs');await deny('select * from vault.decrypted_secrets');
  await deny('select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9)',[user,org,job,'quote',issued.version,'hash',['client@example.test'],'Subject',[]]);
  await deny('select public.orquivia_mail_complete($1,$2,$3,$4,$5)',[user,org,job,'uncertain',null]);
  await as('anon');await deny(profileSQL,[user,org,false]);
  await deny('select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9)',[user,org,job,'quote',issued.version,'hash',['client@example.test'],'Subject',[]]);
  await deny('select public.orquivia_mail_complete($1,$2,$3,$4,$5)',[user,org,job,'uncertain',null]);
  await as('service_role');
  // Saved routing addresses must mean the same thing at the browser and SQL
  // boundary, including punctuation, injection attempts and DNS label limits.
  for(const address of ['accounts@example.test',"o'neill+invoices@sub.example.test",'x@y.z',
    '.first@example.test','last.@example.test','two..dots@example.test','x@.test','x@example.',
    'x@-example.test','x@example-.test','x@example..test','x@localhost','a@@example.test',
    'a@example.test,b@example.test','a@example.test;b@example.test','a@example.test\r\nBcc: x@example.test',
    'a@example.test ',' a@example.test','a b@example.test','<a@example.test>',
    `${'a'.repeat(65)}@example.test`,`a@${'x'.repeat(64)}.test`]) {
    equal((await query('select orquivia_private.valid_billing_email($1::jsonb) valid',[JSON.stringify(address)]))[0].valid,isMailAddress(address));
  }
  for(const value of [null,23,[],{},true])equal((await query('select orquivia_private.valid_billing_email($1::jsonb) valid',[JSON.stringify(value)]))[0].valid,false);
  equal((await query("select count(*)::int count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='orquivia_mail_claim'"))[0].count,1);
  equal((await query("select count(*)::int count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='orquivia_mail_complete'"))[0].count,1);
  let profile=(await query(profileSQL,[user,org,false]))[0].result;equal(profile.connected,false);equal(profile.version,0);
  const signature={name:'Fixture owner',role:'Director',phone:'123456789'};
  profile=(await query('select public.orquivia_mail_save_profile($1,$2,$3,$4,$5,$6,$7,$8) result',[user,org,0,signature,'serviciodecorreo','synthetic-test-secret','Sent',false]))[0].result;
  equal(profile.connected,true);equal(profile.version,1);equal(profile.password,undefined);
  equal((await query(profileSQL,[user,org,true]))[0].result.password,'synthetic-test-secret');
  await deny('select public.orquivia_mail_save_profile($1,$2,$3,$4)',[user,org,0,signature]);
  const claimSQL='select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8) result';
  const claim=[user,org,job,'quote',issued.version,'fixture-hash',['client@example.test'],'Fixture subject'];
  await deny(claimSQL,[...claim.slice(0,4),999,...claim.slice(5)]);
  let result=(await query(claimSQL,claim))[0].result;equal(result.existing,false);equal(result.document.status,'ready');
  equal(result.job.cc,[]);
  result=(await query(claimSQL,claim))[0].result;equal(result.existing,true);
  await deny(claimSQL,[editor,...claim.slice(1)]);
  await deny(claimSQL,[user,org,'30000000-0000-4000-8000-000000000002',...claim.slice(3)]);
  const raw=Buffer.from('exact synthetic MIME').toString('base64');
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,job,raw,'<fixture@example.test>','pdf-sha256']);
  await deny('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,job,Buffer.from('different MIME').toString('base64'),'<changed@example.test>','changed-hash']);
  const completeSQL='select public.orquivia_mail_complete($1,$2,$3,$4) result';
  result=(await query(completeSQL,[user,org,job,'archive_pending']))[0].result;
  equal(result.job.status,'archive_pending');equal(result.workspace.version,Number(issued.version)+1);equal(result.workspace.state.documents[0].status,'sent');
  equal((await query('select public.orquivia_mail_archive_claim($1,$2,$3) result',[user,org,job]))[0].result.raw.replace(/\s/g,''),raw);
  await deny('select public.orquivia_mail_archive_claim($1,$2,$3)',[user,org,job]);
  result=(await query(completeSQL,[user,org,job,'sent']))[0].result;equal(result.job.status,'sent');
  await as('authenticated');workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;equal(workspace.version,Number(issued.version)+1);
  await as('service_role');
  const audit=await query("select actor_id,event from public.orquivia_audit_log where event='email_sent'");equal(audit.length,1);equal(audit[0].actor_id,user);
  // A new UUID is an intentional new message for the same already-sent quote.
  // Replaying either UUID cannot create another job or another state change.
  const multiSQL='select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9) result';
  const secondJob='30000000-0000-4000-8000-000000000002',partialJob='30000000-0000-4000-8000-000000000003';
  const multi=[user,org,secondJob,'quote',workspace.version,'second-hash',['client@example.test','second@example.test'],'Another recipient',['copy@example.test']];
  result=(await query(multiSQL,multi))[0].result;equal(result.existing,false);equal(result.job.to,multi[6]);equal(result.job.cc,multi[8]);
  equal((await query(multiSQL,multi))[0].result.existing,true);
  await deny(multiSQL,[...multi.slice(0,5),'different-hash',...multi.slice(6)]);
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,secondJob,raw,'<second@example.test>','second-pdf-hash']);
  result=(await query(completeSQL,[user,org,secondJob,'archive_pending']))[0].result;equal(result.workspace,undefined);
  await query(completeSQL,[user,org,secondJob,'sent']);
  const history=(await query('select public.orquivia_mail_history($1,$2,$3) result',[user,org,'quote']))[0].result.history;
  equal(history.length,2);equal(history.find(entry=>entry.id===secondJob).cc,['copy@example.test']);
  equal((await query("select count(*)::int count from public.orquivia_audit_log where event='email_sent'"))[0].count,1);
  // Database validation remains independent from the Edge parser.
  const partial=[user,org,partialJob,'quote-partial',workspace.version,'partial-hash',['client@example.test'],'Partial fixture',['copy@example.test']];
  for(const [to,cc] of [[[],[]],[['client@example.test'],['CLIENT@example.test']],[Array.from({length:20},(_,i)=>`person${i}@example.test`),['extra@example.test']],[['client@example.test\r\nBcc: injected@example.test'],[]]]) {
    await deny(multiSQL,[...partial.slice(0,6),to,partial[7],cc]);
  }
  result=(await query(multiSQL,partial))[0].result;equal(result.document.status,'ready');
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,partialJob,raw,'<partial@example.test>','partial-pdf-hash']);
  const delivery={errorCode:'SMTP_PARTIAL',accepted:['client@example.test'],rejected:['copy@example.test']};
  await deny('select public.orquivia_mail_complete($1,$2,$3,$4,$5)',[user,org,partialJob,'uncertain',{...delivery,rejected:['unrequested@example.test']}]);
  result=(await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5) result',[user,org,partialJob,'uncertain',delivery]))[0].result;
  equal(result.job.status,'uncertain');equal(result.job.errorCode,'SMTP_PARTIAL');equal(result.job.accepted,delivery.accepted);equal(result.job.rejected,delivery.rejected);equal(result.workspace,undefined);
  await db.exec('reset role');
  equal((await query('select encode(raw_message,\'base64\') raw from orquivia_private.mail_jobs where id=$1',[partialJob]))[0].raw.replace(/\s/g,''),raw);
  await as('service_role');
  equal((await query(multiSQL,partial))[0].result.existing,true);
  await deny(multiSQL,[user,org,'30000000-0000-4000-8000-000000000004',...partial.slice(3)]);
  await as('authenticated');
  const unchanged=(await query('select public.load_orquivia_workspace() result'))[0].result;
  equal(unchanged.version,workspace.version);equal(unchanged.state.documents.find(document=>document.id==='quote-partial').status,'ready');
  await as('service_role');
  // Invoice delivery has its own state. Recipient routing and PO edits are
  // operational, whereas VAT, line prices and fiscal snapshots stay frozen.
  await as('authenticated');
  workspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  const invoiceBefore=structuredClone(workspace.state.documents.find(d=>d.id==='invoice'));
  equal(invoiceBefore.deliveryStatus,undefined);equal(invoiceBefore.status,'issued');
  let invoiceState=structuredClone(workspace.state);
  invoiceState.clients[0].billingEmail='accounts@example.test';
  Object.assign(invoiceState.documents.find(d=>d.id==='invoice'),{billingEmail:'invoice-accounts@example.test',po:'PO-UPDATED',deliveryStatus:'ready'});
  saved=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,invoiceState,workspace.version]))[0].result;
  workspace={...workspace,state:invoiceState,version:saved.version};
  for(const [target,field,value] of [
    ['invoice','vat',10],['invoice','items',[{description:'Changed fiscal item',quantity:1,price:99}]],
    ['invoice','companySnapshot',{name:'Forged company'}],['invoice','clientSnapshot',{name:'Forged client'}],
    ['invoice','number','F-2025-999'],['invoice','date','2025-05-02'],['invoice','clientId','another-client'],
    ['invoice','kind','quote'],['invoice','title','Changed fiscal title'],['invoice','discount',5],
    ['invoice','withholding',10],['invoice','paymentMethod','Changed payment terms'],
    ['invoice','sourceMetadata',{file:'forged.pdf'}],['invoice','importWarnings',['Changed evidence']],
    ['invoice','futureFiscalField','Unknown fields are immutable by default'],
  ]) {
    const changed=structuredClone(workspace.state);changed.documents.find(d=>d.id===target)[field]=value;
    await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,changed,workspace.version]);
  }
  for(const [target,field,value] of [['invoice','deliveryStatus','paid'],['invoice','billingEmail','x@example.test\r\nBcc: bad@example.test'],['invoice','billingEmail',null],['quote','billingEmail','invoice@example.test'],['invoice-draft','deliveryStatus','sent']]) {
    const changed=structuredClone(workspace.state);changed.documents.find(d=>d.id===target)[field]=value;
    await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,changed,workspace.version]);
  }
  const badClient=structuredClone(workspace.state);badClient.clients[0].billingEmail='a@example.test,b@example.test';
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,badClient,workspace.version]);
  // Draft invoices cannot be submitted, even with a connected mailbox.
  await as('service_role');
  await deny(multiSQL,[user,org,'30000000-0000-4000-8000-000000000007','invoice-draft',workspace.version,'draft-hash',['invoice@example.test'],'Draft invoice',[]]);
  await as('authenticated');
  issued=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'invoice-draft',workspace.version]))[0].result;
  equal(issued.state.documents.find(d=>d.id==='invoice-draft').deliveryStatus,'ready');
  equal(issued.state.documents.find(d=>d.id==='invoice-draft').status,'issued');
  workspace={...workspace,state:issued.state,version:issued.version};
  const invoiceJob='30000000-0000-4000-8000-000000000005',invoiceResend='30000000-0000-4000-8000-000000000006';
  const invoiceClaim=[user,org,invoiceJob,'invoice',workspace.version,'invoice-hash',['invoice-accounts@example.test'],'Factura fixture',['controller@example.test']];
  await as('service_role');
  await deny(multiSQL,[...invoiceClaim.slice(0,4),workspace.version-1,...invoiceClaim.slice(5)]);
  // Simulate corrupted evidence in the isolated fixture to verify that an
  // otherwise valid issued state is not enough without its matching ledger.
  await db.exec('reset role;begin');
  await query("update public.orquivia_document_numbers set fiscal_data=fiscal_data||'{\"vat\":10}'::jsonb where organization_id=$1 and document_id='invoice'",[org]);
  await db.exec('savepoint invalid_ledger');
  await as('service_role');
  await deny(multiSQL,invoiceClaim);
  await db.exec('rollback to savepoint invalid_ledger;reset role;rollback');
  await as('service_role');
  result=(await query(multiSQL,invoiceClaim))[0].result;
  equal(result.document.kind,'invoice');equal(result.document.vat,21);equal(result.document.po,'PO-UPDATED');
  equal(result.job.to,['invoice-accounts@example.test']);equal(result.job.cc,['controller@example.test']);
  equal(result.client,invoiceBefore.clientSnapshot);equal(result.company,invoiceBefore.companySnapshot);
  equal((await query(multiSQL,invoiceClaim))[0].result.existing,true);
  await deny(multiSQL,[editor,...invoiceClaim.slice(1)]);
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,invoiceJob,raw,'<invoice@example.test>','invoice-pdf-hash']);
  // Another user records a partial payment and a contract note after the claim.
  // Completion merges only deliveryStatus into that latest canonical workspace.
  await as('authenticated',editor);
  let concurrent=structuredClone(workspace.state);
  Object.assign(concurrent.documents.find(d=>d.id==='invoice'),{status:'partial',contractReceived:true,notes:'Concurrent note'});
  concurrent.payments.push({id:'invoice-payment',documentId:'invoice',amount:10,date:'2025-05-02',reference:'Concurrent receipt'});
  saved=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,concurrent,workspace.version]))[0].result;
  await as('service_role');
  result=(await query(completeSQL,[user,org,invoiceJob,'archive_pending']))[0].result;
  equal(result.workspace.version,Number(saved.version)+1);
  const delivered=result.workspace.state.documents.find(d=>d.id==='invoice');
  equal(delivered.deliveryStatus,'sent');equal(delivered.status,'partial');equal(delivered.contractReceived,true);equal(delivered.notes,'Concurrent note');
  equal(result.workspace.state.payments,concurrent.payments);
  equal(result.workspace.state.documents.find(d=>d.id==='quote'),concurrent.documents.find(d=>d.id==='quote'));
  equal(result.workspace.state.documents.find(d=>d.id==='invoice-draft'),concurrent.documents.find(d=>d.id==='invoice-draft'));
  workspace={...workspace,...result.workspace};
  await query(completeSQL,[user,org,invoiceJob,'sent']);
  equal((await query(completeSQL,[user,org,invoiceJob,'sent']))[0].result.workspace,undefined);
  // Bypass only the fixture rate window, never production limits or permissions.
  await db.exec("reset role;update orquivia_private.mail_jobs set created_at=created_at-interval '2 minutes'");await as('service_role');
  const resend=[user,org,invoiceResend,'invoice',workspace.version,'invoice-resend-hash',['another-accounts@example.test'],'Factura reenviada',[]];
  result=(await query(multiSQL,resend))[0].result;equal(result.existing,false);
  await query('select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)',[user,org,invoiceResend,raw,'<invoice-resend@example.test>','invoice-resend-pdf-hash']);
  result=(await query(completeSQL,[user,org,invoiceResend,'archive_pending']))[0].result;
  equal(result.workspace,undefined);equal(result.job.status,'archive_pending');
  const invoiceHistory=(await query('select public.orquivia_mail_history($1,$2,$3) result',[user,org,'invoice']))[0].result.history;
  equal(invoiceHistory.length,2);equal(invoiceHistory.find(j=>j.id===invoiceResend).to,['another-accounts@example.test']);
  await db.exec('reset role');
  const invoiceAudit=await query("select actor_id,changed_fields from public.orquivia_record_history where entity_id='invoice' and event='email_sent'");
  equal(invoiceAudit.length,1);equal(invoiceAudit[0].actor_id,user);equal(invoiceAudit[0].changed_fields,['deliveryStatus']);
  const ledgerAfter=(await query("select fiscal_data from public.orquivia_document_numbers where organization_id=$1 and document_id='invoice'",[org]))[0].fiscal_data;
  const deliveredFiscal={...delivered};
  for(const field of ['status','total','notes','po','dueDate','contractExpectedDate','contractReceived','paymentReviewNeeded','billingEmail','deliveryStatus'])delete deliveredFiscal[field];
  equal(ledgerAfter,deliveredFiscal);
  await as('service_role');
  const failedInvoiceJob='30000000-0000-4000-8000-000000000008';
  await query(multiSQL,[user,org,failedInvoiceJob,'invoice-draft',workspace.version,'invoice-partial-hash',['accounts@example.test'],'Partial invoice',['copy@example.test']]);
  result=(await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5) result',[user,org,failedInvoiceJob,'uncertain',
    {errorCode:'SMTP_PARTIAL',accepted:['accounts@example.test'],rejected:['copy@example.test']}]))[0].result;
  equal(result.workspace,undefined);equal(result.job.status,'uncertain');
  await as('authenticated');
  const afterPartialInvoice=(await query('select public.load_orquivia_workspace() result'))[0].result;
  equal(afterPartialInvoice.version,workspace.version);
  equal(afterPartialInvoice.state.documents.find(d=>d.id==='invoice-draft').deliveryStatus,'ready');
  equal(afterPartialInvoice.state.payments,workspace.state.payments);

  // Install attachments against a populated history: no historical MIME or
  // financial/workspace record may be rewritten as part of this migration.
  await db.exec('reset role');
  const historicalJobs=await query("select id,status,encode(raw_message,'base64') raw,message_id,pdf_hash from orquivia_private.mail_jobs order by id");
  const attachmentsWorkspace=(await query('select state,version from public.orquivia_team_workspaces where organization_id=$1',[org]))[0];
  await db.exec(await readFile(new URL('../migrations/202610260015_invoice_mail_attachments.sql',import.meta.url),'utf8'));
  equal(await query("select id,status,encode(raw_message,'base64') raw,message_id,pdf_hash from orquivia_private.mail_jobs order by id"),historicalJobs);
  equal((await query('select state,version from public.orquivia_team_workspaces where organization_id=$1',[org]))[0],attachmentsWorkspace);
  equal((await query('select count(*)::int count from orquivia_private.mail_jobs where transient_message'))[0].count,0);
  equal((await query("select count(*)::int count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='orquivia_mail_claim'"))[0].count,1);
  equal((await query("select count(*)::int count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='orquivia_mail_archive_claim'"))[0].count,1);
  const attachment={name:'Justificante.pdf',contentType:'application/pdf',size:20,sha256:'a'.repeat(64)};
  const attachSQL='select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
  const storeSQL='select public.orquivia_mail_store_message($1,$2,$3,$4,$5,$6)';
  const attachmentJob='40000000-0000-4000-8000-000000000001';
  const attachmentClaim=[user,org,attachmentJob,'invoice',workspace.version,'attachment-request-hash',['accounts@example.test'],'Invoice with evidence',[],[attachment]];
  for(const role of ['anon','authenticated']) {
    await as(role);
    await deny(attachSQL,attachmentClaim);
    await deny(storeSQL,[user,org,attachmentJob,raw,'<fixture@example.test>','hash']);
    await deny('select public.orquivia_mail_archive_claim($1,$2,$3,$4)',[user,org,attachmentJob,false]);
    await deny('select orquivia_private.valid_mail_attachments($1)',[[attachment]]);
    await deny('select attachments,raw_message from orquivia_private.mail_jobs');
  }
  await as('service_role');
  equal((await query(claimSQL,claim))[0].result.existing,true);
  equal((await query(multiSQL,multi))[0].result.existing,true);
  const validMeta=async value=>(await query('select orquivia_private.valid_mail_attachments($1::jsonb) valid',[JSON.stringify(value)]))[0].valid;
  equal(await validMeta([]),true);equal(await validMeta([attachment]),true);
  equal(await validMeta([{...attachment,name:'Fotografía.JPG',contentType:'image/jpeg',size:5000000},{...attachment,name:'Segunda.png',contentType:'image/png',size:5000000}]),true);
  equal(await validMeta(Array.from({length:5},(_,i)=>({...attachment,name:`Archivo${i}.pdf`,size:2000000}))),true);
  for(const metadata of [null,{},[null],[[]],[{...attachment,bytes:'not stored'}],[{...attachment,size:0}],
    [{...attachment,size:5000001}],[{...attachment,size:1.5}],[{...attachment,size:'20'}],
    [{...attachment,sha256:'A'.repeat(64)}],[{...attachment,sha256:'short'}],
    [{...attachment,contentType:'text/html'}],[{...attachment,name:'file.png'}],
    [{...attachment,name:'../file.pdf'}],[{...attachment,name:'folder\\file.pdf'}],[{...attachment,name:'.file.pdf'}],
    [{...attachment,name:' file.pdf'}],[{...attachment,name:'file\r\nBcc.pdf'}],
    [{...attachment,name:'file\u0085.pdf'}],[{...attachment,name:'file\u2028.pdf'}],
    [{...attachment,name:'file\u202e.pdf'}],[{...attachment,name:'file\u2066.pdf'}],
    [{...attachment,name:'bad:name.pdf'}],[{...attachment,name:'bad<name.pdf'}],[{...attachment,name:'bad?name.pdf'}],
    [{...attachment,name:'x'.repeat(137)+'.pdf'}],[{...attachment,name:'😀'.repeat(69)+'.pdf'}],
    [{...attachment},{...attachment,name:'JUSTIFICANTE.PDF',sha256:'b'.repeat(64)}],
    [{...attachment,size:5000000},{...attachment,name:'Other.pdf',size:5000000},{...attachment,name:'Third.pdf',size:1}],
    Array.from({length:6},(_,i)=>({...attachment,name:`File${i}.pdf`}))]) equal(await validMeta(metadata),false);
  await deny(attachSQL,[...attachmentClaim.slice(0,3),'quote',...attachmentClaim.slice(4)]);
  await deny(attachSQL,[...attachmentClaim.slice(0,3),'invoice-draft',...attachmentClaim.slice(4)]);
  await deny(attachSQL,[...attachmentClaim.slice(0,4),workspace.version-1,...attachmentClaim.slice(5)]);
  await deny(attachSQL,[...attachmentClaim.slice(0,9),[{...attachment,size:5000001}]]);
  await deny(attachSQL,[editor,'20000000-0000-4000-8000-000000000099',...attachmentClaim.slice(2)]);
  await db.exec('reset role');
  await query("update auth.mfa_factors set status='unverified' where user_id=$1",[editor]);
  await as('service_role');await deny(attachSQL,[editor,...attachmentClaim.slice(1)]);
  await db.exec('reset role');await query("update auth.mfa_factors set status='verified' where user_id=$1",[editor]);
  // Move only fixture clocks outside the rate window, preserving production rules.
  await db.exec("reset role;update orquivia_private.mail_jobs set created_at=created_at-interval '2 hours'");await as('service_role');
  // Attachments cannot make a forged fiscal ledger entry sendable.
  await db.exec('reset role;begin');
  await query("update public.orquivia_document_numbers set fiscal_data=fiscal_data||'{\"vat\":10}'::jsonb where organization_id=$1 and document_id='invoice'",[org]);
  await db.exec('savepoint attachments_invalid_ledger');await as('service_role');
  await deny(attachSQL,attachmentClaim);
  await db.exec('rollback to savepoint attachments_invalid_ledger;reset role;rollback');await as('service_role');
  result=(await query(attachSQL,attachmentClaim))[0].result;
  equal(result.existing,false);equal(result.job.attachments,[attachment]);equal(result.document.kind,'invoice');
  equal((await query(attachSQL,attachmentClaim))[0].result.existing,true);
  await deny(attachSQL,[...attachmentClaim.slice(0,5),'changed-attachment-hash',...attachmentClaim.slice(6)]);
  await deny(attachSQL,[...attachmentClaim.slice(0,9),[{...attachment,sha256:'b'.repeat(64)}]]);
  await query(storeSQL,[user,org,attachmentJob,raw,'<attachments@example.test>','attachment-pdf-hash']);
  await deny(storeSQL,[user,org,attachmentJob,raw,'<attachments@example.test>','attachment-pdf-hash']);
  await query(completeSQL,[user,org,attachmentJob,'archive_pending']);
  const lease=(await query('select public.orquivia_mail_archive_claim($1,$2,$3,$4) result',[user,org,attachmentJob,false]))[0].result;
  equal(lease.messageId,'<attachments@example.test>');equal(lease.raw,undefined);
  await deny('select public.orquivia_mail_archive_claim($1,$2,$3)',[user,org,attachmentJob]);
  await db.exec('reset role');
  equal((await query("select encode(raw_message,'base64') raw,transient_message from orquivia_private.mail_jobs where id=$1",[attachmentJob]))[0],{raw,transient_message:true});
  await query("update orquivia_private.mail_jobs set archive_lease_until=now()-interval '1 second' where id=$1",[attachmentJob]);
  await as('service_role');
  equal((await query('select public.orquivia_mail_archive_claim($1,$2,$3) result',[user,org,attachmentJob]))[0].result.raw.replace(/\s/g,''),raw);
  await query(completeSQL,[user,org,attachmentJob,'sent']);
  await deny('select public.orquivia_mail_archive_claim($1,$2,$3,$4)',[user,org,attachmentJob,false]);
  await db.exec('reset role');
  equal((await query('select raw_message from orquivia_private.mail_jobs where id=$1',[attachmentJob]))[0].raw_message,null);
  // A completed legacy archive deliberately retains its historical bytes.
  equal((await query("select encode(raw_message,'base64') raw from orquivia_private.mail_jobs where id=$1",[invoiceResend]))[0].raw,raw);
  await as('service_role');await query(completeSQL,[user,org,invoiceResend,'sent']);await db.exec('reset role');
  equal((await query("select encode(raw_message,'base64') raw from orquivia_private.mail_jobs where id=$1",[invoiceResend]))[0].raw,raw);
  await as('service_role');
  const metadataHistory=(await query('select public.orquivia_mail_history($1,$2,$3) result',[user,org,'invoice']))[0].result.history;
  equal(metadataHistory.find(j=>j.id===attachmentJob).attachments,[attachment]);
  equal(Object.hasOwn(metadataHistory.find(j=>j.id===attachmentJob),'raw'),false);
  // New failed preparations release their buffer and expose a safe reason.
  const failedAttachmentJob='40000000-0000-4000-8000-000000000002';
  const failedAttachment=[user,org,failedAttachmentJob,'invoice',workspace.version,'failed-attachment-request',['accounts@example.test'],'Failed attachment preparation',[],[attachment]];
  await query(attachSQL,failedAttachment);
  await query(storeSQL,[user,org,failedAttachmentJob,raw,'<failed-attachment@example.test>','pdf-hash']);
  for(const delivery of [{errorCode:'OTHER'},{errorCode:'MAIL_STORAGE_LIMIT',accepted:[]},{errorCode:'MAIL_STORAGE_LIMIT',raw:'secret'},{errorCode:'SMTP_PARTIAL'}]) {
    await deny('select public.orquivia_mail_complete($1,$2,$3,$4,$5)',[user,org,failedAttachmentJob,'failed',delivery]);
  }
  result=(await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5) result',[user,org,failedAttachmentJob,'failed',{errorCode:'MAIL_STORAGE_LIMIT'}]))[0].result;
  equal(result.job.errorCode,'MAIL_STORAGE_LIMIT');equal(result.job.status,'failed');equal(result.workspace,undefined);
  await db.exec('reset role');equal((await query('select raw_message from orquivia_private.mail_jobs where id=$1',[failedAttachmentJob]))[0].raw_message,null);
  await as('service_role');
  const maximumRawJob='40000000-0000-4000-8000-000000000006';
  await query(attachSQL,[user,org,maximumRawJob,'invoice',workspace.version,'max-raw-request',['accounts@example.test'],'Maximum raw message',[],[]]);
  await query('select public.orquivia_mail_store_message($1,$2,$3,encode(repeat(\'m\',20000000)::bytea,\'base64\'),$4,$5)',[user,org,maximumRawJob,'<maximum@example.test>','hash']);
  await db.exec('reset role');equal((await query('select octet_length(raw_message) size from orquivia_private.mail_jobs where id=$1',[maximumRawJob]))[0].size,20000000);await as('service_role');
  result=(await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5) result',[user,org,maximumRawJob,'failed',{errorCode:'MAIL_MESSAGE_TOO_LARGE'}]))[0].result;
  equal(result.job.errorCode,'MAIL_MESSAGE_TOO_LARGE');
  await db.exec('reset role');equal((await query('select raw_message from orquivia_private.mail_jobs where id=$1',[maximumRawJob]))[0].raw_message,null);await as('service_role');
  // Preparing a message enforces decoded, not merely encoded, size.
  await db.exec("reset role;update orquivia_private.mail_jobs set created_at=created_at-interval '2 hours'");await as('service_role');
  const quotaJob='40000000-0000-4000-8000-000000000003';
  await query(attachSQL,[user,org,quotaJob,'invoice',workspace.version,'quota-request',['accounts@example.test'],'Quota fixture',[],[]]);
  await deny('select public.orquivia_mail_store_message($1,$2,$3,encode(repeat(\'x\',20000001)::bytea,\'base64\'),$4,$5)',[user,org,quotaJob,'<large@example.test>','hash']);
  await deny(storeSQL,[user,org,quotaJob,'!!!!','<invalid@example.test>','hash']);
  await deny(storeSQL,[user,org,quotaJob,'','<empty@example.test>','hash']);
  // Pending legacy jobs count against the same 50 MB buffer, whereas already
  // archived legacy history is never rewritten just to recover capacity.
  await db.exec('reset role');
  const buffered=Number((await query("select coalesce(sum(octet_length(raw_message)),0) size from orquivia_private.mail_jobs where organization_id=$1 and raw_message is not null and status in ('sending','uncertain','archive_pending')",[org]))[0].size);
  const fill=[20000000,20000000,9999999-buffered];
  for(let i=0;i<fill.length;i++) await query("insert into orquivia_private.mail_jobs(id,organization_id,user_id,document_id,request_hash,document_snapshot,sender,recipients,subject,status,raw_message) values($1,$2,$3,'quota-filler','quota-filler','{}','owner@example.test','[]','Fixture pending buffer','archive_pending',repeat('q',$4)::bytea)",[`50000000-0000-4000-8000-00000000000${i+1}`,org,user,fill[i]]);
  await as('service_role');
  await assert.rejects(db.query(storeSQL,[user,org,quotaJob,Buffer.from('ab').toString('base64'),'<quota@example.test>','hash']),/MAIL_STORAGE_LIMIT/);++checks;
  await query(storeSQL,[user,org,quotaJob,Buffer.from('a').toString('base64'),'<quota@example.test>','hash']);
  await db.exec('reset role');
  equal(Number((await query("select sum(octet_length(raw_message)) size from orquivia_private.mail_jobs where organization_id=$1 and raw_message is not null and status in ('sending','uncertain','archive_pending')",[org]))[0].size),50000000);
  await as('service_role');
  await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5)',[user,org,quotaJob,'failed',{errorCode:'MAIL_PREPARATION_FAILED'}]);
  await db.exec('reset role');
  equal((await query('select raw_message from orquivia_private.mail_jobs where id=$1',[quotaJob]))[0].raw_message,null);
  await query("update orquivia_private.mail_jobs set status='failed' where document_id='quota-filler'");
  // Unknown/partial outcomes retain their exact MIME and block another send.
  await as('service_role');
  const uncertainAttachmentJob='40000000-0000-4000-8000-000000000004';
  await query(attachSQL,[user,org,uncertainAttachmentJob,'invoice',workspace.version,'uncertain-attachment',['accounts@example.test'],'Uncertain attached invoice',[],[attachment]]);
  await query(storeSQL,[user,org,uncertainAttachmentJob,raw,'<uncertain-attachment@example.test>','hash']);
  result=(await query(completeSQL,[user,org,uncertainAttachmentJob,'uncertain']))[0].result;
  equal(result.job.status,'uncertain');equal(result.workspace,undefined);
  await deny(attachSQL,[user,org,'40000000-0000-4000-8000-000000000005','invoice',workspace.version,'duplicate-after-uncertain',['accounts@example.test'],'Must stay blocked',[],[attachment]]);
  await db.exec('reset role');
  equal((await query("select encode(raw_message,'base64') raw from orquivia_private.mail_jobs where id=$1",[uncertainAttachmentJob]))[0].raw,raw);
  equal((await query('select state,version from public.orquivia_team_workspaces where organization_id=$1',[org]))[0],attachmentsWorkspace);
  equal((await query("select encode(raw_message,'base64') raw from orquivia_private.mail_jobs where id=$1",[partialJob]))[0].raw,raw);

  // A new invoice with partly accepted recipients keeps its entire MIME and
  // leaves the issued delivery/payment metadata untouched.
  await as('authenticated');
  let partialWorkspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  const extraPartialState=structuredClone(partialWorkspace.state);
  extraPartialState.documents.push({...structuredClone(state.documents[0]),id:'attachment-partial-document',kind:'invoice',status:'draft',number:''});
  saved=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,extraPartialState,partialWorkspace.version]))[0].result;
  const partialIssue=(await query('select public.issue_orquivia_document($1,$2,$3) result',[org,'attachment-partial-document',saved.version]))[0].result;
  await db.exec("reset role;update orquivia_private.mail_jobs set created_at=created_at-interval '2 hours'");await as('service_role');
  const partialAttachmentJob='40000000-0000-4000-8000-000000000007';
  await query(attachSQL,[user,org,partialAttachmentJob,'attachment-partial-document',partialIssue.version,'new-partial-attachment',['accounts@example.test'],'Partial attachment', ['copy@example.test'],[attachment]]);
  await query(storeSQL,[user,org,partialAttachmentJob,raw,'<partial-new-attachment@example.test>','hash']);
  result=(await query('select public.orquivia_mail_complete($1,$2,$3,$4,$5) result',[user,org,partialAttachmentJob,'uncertain',{errorCode:'SMTP_PARTIAL',accepted:['accounts@example.test'],rejected:['copy@example.test']}]))[0].result;
  equal(result.job.errorCode,'SMTP_PARTIAL');equal(result.job.attachments,[attachment]);equal(result.workspace,undefined);
  equal(result.job.accepted,['accounts@example.test']);equal(result.job.rejected,['copy@example.test']);
  await db.exec('reset role');
  equal((await query("select encode(raw_message,'base64') raw,transient_message from orquivia_private.mail_jobs where id=$1",[partialAttachmentJob]))[0],{raw,transient_message:true});
  await as('authenticated');partialWorkspace=(await query('select public.load_orquivia_workspace() result'))[0].result;
  equal(partialWorkspace.version,partialIssue.version);equal(partialWorkspace.state.documents.find(d=>d.id==='attachment-partial-document').deliveryStatus,'ready');
  await as('service_role');
  await query('update public.orquivia_memberships set active=false where user_id=$1',[editor]);
  await deny(profileSQL,[editor,org,true]);
  await deny('select public.orquivia_mail_history($1,$2,$3)',[editor,org,'invoice']);
  console.log(`PASS ${checks} SQL mail checks: private credentials, member boundaries, CAS, To/Cc, quote/invoice delivery, legacy preservation, fiscal immutability, concurrent payment preservation, intentional resend, duplicate claims, immutable copies, partial delivery, archive leases, attachment metadata/quotas/transient cleanup, legacy MIME preservation and audited status updates.`);
} catch(error) { console.error(error.code,error.message,error.where||'',error.position||'');process.exitCode=1; }
finally {await db.close();}
