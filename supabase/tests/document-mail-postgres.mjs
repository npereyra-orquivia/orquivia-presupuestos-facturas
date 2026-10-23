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
  await as('service_role');
  await query('update public.orquivia_memberships set active=false where user_id=$1',[editor]);
  await deny(profileSQL,[editor,org,true]);
  await deny('select public.orquivia_mail_history($1,$2,$3)',[editor,org,'invoice']);
  console.log(`PASS ${checks} SQL mail checks: private credentials, member boundaries, CAS, To/Cc, quote/invoice delivery, legacy preservation, fiscal immutability, concurrent payment preservation, intentional resend, duplicate claims, immutable copies, partial delivery, archive leases and audited status updates.`);
} catch(error) { console.error(error.code,error.message,error.where||'',error.position||'');process.exitCode=1; }
finally {await db.close();}
