// Executes actual PostgreSQL (PGlite/WASM), not a hand-written SQL mock.
// Install locally: npm install --prefix supabase/.verification --no-save --no-package-lock @electric-sql/pglite
import { PGlite } from '../.verification/node_modules/@electric-sql/pglite/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = await PGlite.create();
let checks = 0;
const admin='a1000000-0000-4000-8000-000000000001', editor='a1000000-0000-4000-8000-000000000002', outsider='a1000000-0000-4000-8000-000000000003';
const org='a2000000-0000-4000-8000-000000000001';
const query=async (sql,params=[]) => (await db.query(sql,params)).rows;
const deny=async (sql,params,code) => { await assert.rejects(db.query(sql,params),e=>e.code===code); checks++; };
const as=async (role,id=null) => { await db.exec(`reset role; set role ${role};`); await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role,aal:'aal1'})]); };
const draft=(id,kind='invoice',date='2025-01-10')=>({id,kind,status:'draft',number:'',clientId:'c1',date,dueDate:'2025-02-10',contractExpectedDate:'',contractReceived:false,items:[{description:'Servicio',quantity:1,price:100}],vat:21,discount:0,withholding:0,total:121});
try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls; create schema auth;
    create table auth.users(id uuid primary key,email text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${admin}','admin@example.test'),('${editor}','editor@example.test'),('${outsider}','outsider@example.test');`);
  // Minimal managed-Storage schema for exercising the real receipt RLS policies.
  // Supabase itself supplies these tables and their API-side size/MIME checks.
  await db.exec(`create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql','202610140003_expenses.sql']) await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  checks++;
  await as('service_role');
  await db.query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[admin,editor,'Test company',org]);
  const initial=(await query('select state from public.orquivia_team_workspaces'))[0].state;
  const state=structuredClone(initial); state.clients=[{id:'c1',name:'Cliente'}]; state.documents=[draft('d1'),draft('q1','quote')];
  await as('authenticated',admin);
  const saved=(await query('select public.save_orquivia_team_state($1,$2,1) result',[org,state]))[0].result;
  assert.equal(saved.version,2); checks++;
  await deny('select public.save_orquivia_team_state($1,$2,1)',[org,state],'40001');
  const invoice=(await query('select public.issue_orquivia_document($1,$2,2) result',[org,'d1']))[0].result;
  assert.equal(invoice.document_number,'F-2025-001'); checks++;
  const quote=(await query('select public.issue_orquivia_document($1,$2,3) result',[org,'q1']))[0].result;
  assert.equal(quote.document_number,'PR-2025-001'); checks++;
  await as('authenticated',editor);
  assert.equal((await query('select public.load_orquivia_workspace() result'))[0].result.state.documents.length,2); checks++;
  await deny('update public.orquivia_team_workspaces set version=50',[],'42501');
  const invalid=structuredClone(quote.state); invalid.company.iban='Changed';
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,invalid],'42501');
  const fiscal=structuredClone(quote.state); fiscal.documents[0].items[0].price=200; fiscal.documents[0].total=242;
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,fiscal],'22023');
  for(const field of ['sourceMetadata','importWarnings','title','paymentMethod']) {
    const evidence=structuredClone(quote.state); evidence.documents[0][field]=field==='sourceMetadata'?{file:'changed.pdf'}:field==='importWarnings'?['Changed original evidence']:'Changed';
    await deny('select public.save_orquivia_team_state($1,$2,4)',[org,evidence],'22023');
  }
  const followup=structuredClone(quote.state);
  Object.assign(followup.documents[0],{po:'ORDER-12',notes:'Comentario',dueDate:'2025-03-01',contractExpectedDate:'2025-01-15',contractReceived:true,paymentReviewNeeded:true});
  await db.exec('begin');
  assert.equal((await query('select public.save_orquivia_team_state($1,$2,4) result',[org,followup]))[0].result.version,5); checks++;
  await db.exec('rollback');
  const overpaid=structuredClone(quote.state); overpaid.payments=[{id:'p1',documentId:'d1',amount:200,date:'2025-01-20'}];
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,overpaid],'22023');
  const malformed=structuredClone(quote.state); malformed.documents[0].dueDate='2025-02-30';
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,malformed],'22023');
  const forged=structuredClone(quote.state); forged.documents.push({...draft('d3'),status:'issued',number:'F-2025-099'});
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,forged],'22023');
  const deletion=structuredClone(quote.state); deletion.documents.shift();
  await deny('select public.save_orquivia_team_state($1,$2,4)',[org,deletion],'22023');
  assert.ok((await query('select * from public.orquivia_audit_log')).length>=3); checks++;
  await deny('delete from public.orquivia_audit_log',[],'42501');
  await deny('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[admin,editor,'Forbidden',org],'42501');
  await as('authenticated',outsider);
  assert.equal((await query('select * from public.orquivia_team_workspaces')).length,0); checks++;
  await deny('select public.load_orquivia_workspace()',[],'42501');
  await deny('select public.refresh_orquivia_access()',[],'42501');
  await deny('select public.issue_orquivia_document($1,$2,4)',[org,'d1'],'42501');
  await as('anon');
  await deny('select * from public.orquivia_team_workspaces',[],'42501');
  await deny('select public.load_orquivia_workspace()',[],'42501');
  await deny('select public.refresh_orquivia_access()',[],'42501');
  await as('service_role');
  const imported=structuredClone(quote.state); imported.documents.push({...draft('historical'),number:'2025-008',status:'issued',paymentReviewNeeded:true});
  await db.query('select public.import_orquivia_state($1,$2,4)',[org,imported]); checks++;
  await as('authenticated',admin);
  const loaded=(await query('select public.load_orquivia_workspace() result'))[0].result;
  loaded.state.documents.push(draft('d2'));
  await db.query('select public.save_orquivia_team_state($1,$2,5)',[org,loaded.state]);
  assert.equal((await query('select public.issue_orquivia_document($1,$2,6) result',[org,'d2']))[0].result.document_number,'F-2025-009'); checks++;
  await as('service_role');
  await db.query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await as('authenticated',admin);
  assert.equal((await query('select * from public.orquivia_team_workspaces')).length,0); checks++;
  await deny('select public.load_orquivia_workspace()',[],'42501');
  await deny('select public.refresh_orquivia_access()',[],'42501');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:admin,role:'authenticated',aal:'aal2'})]);
  assert.equal((await query('select * from public.orquivia_team_workspaces')).length,1); checks++;
  const refreshed=(await query('select public.refresh_orquivia_access() result'))[0].result;
  assert.equal(refreshed.require_mfa,true); assert.equal(refreshed.role,'admin'); assert.equal(refreshed.state,undefined); checks++;
  await as('service_role');
  const deliveryPayload={to:['owner@example.test'],subject:'Original body'};
  const claim='select public.claim_orquivia_team_reminder($1,$2,$3,$4) result';
  const lease='a3000000-0000-4000-8000-000000000001';
  assert.deepEqual((await query(claim,[org,'2025-02-01',lease,deliveryPayload]))[0].result,deliveryPayload); checks++;
  assert.equal((await query(claim,[org,'2025-02-01',lease,{subject:'Changed'}]))[0].result,null); checks++;
  await db.exec("update public.orquivia_team_reminder_deliveries set status='failed'");
  assert.deepEqual((await query(claim,[org,'2025-02-01',lease,{subject:'Changed'}]))[0].result,deliveryPayload); checks++;
  await db.exec("update public.orquivia_team_reminder_deliveries set status='sent'");
  assert.equal((await query(claim,[org,'2025-02-01',lease,{subject:'Changed'}]))[0].result,null); checks++;
  await as('authenticated',admin);
  await deny(claim,[org,'2025-02-01',lease,deliveryPayload],'42501');
  await as('service_role');
  await db.query('update public.orquivia_organizations set require_mfa=false where id=$1',[org]);
  await db.query('update public.orquivia_memberships set active=false where user_id=$1',[editor]);
  await as('authenticated',editor);
  await deny('select public.load_orquivia_workspace()',[],'42501');
  await deny('select public.refresh_orquivia_access()',[],'42501');
  // Apply the expense extension after the workspace and save routines have
  // already been used, exercising a real upgrade rather than only fresh setup.
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../migrations/202610140007_expense_quick_entry.sql',import.meta.url),'utf8')); checks++;
  await as('authenticated',admin);
  const expenseId='a4000000-0000-4000-8000-000000000001', attachmentId='a5000000-0000-4000-8000-000000000001';
  const path=`${org}/${expenseId}/${attachmentId}.pdf`;
  const attachment={id:attachmentId,name:'Factura proveedor.pdf',path,mimeType:'application/pdf',size:9};
  const objectInsert='insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)';
  await db.query(objectInsert,['orquivia-receipts',path,{size:9,mimetype:'application/pdf'}]); checks++;
  await deny(objectInsert,['orquivia-receipts',`b2000000-0000-4000-8000-000000000001/${expenseId}/${attachmentId}.pdf`,{size:9,mimetype:'application/pdf'}],'42501');
  await deny(objectInsert,['orquivia-receipts',`${org}/../${attachmentId}.pdf`,{size:9,mimetype:'application/pdf'}],'42501');
  await deny(objectInsert,['orquivia-receipts',`${org}/${expenseId}/${attachmentId}.html`,{size:9,mimetype:'text/html'}],'42501');
  assert.equal((await query('update storage.objects set metadata=$1 where name=$2 returning id',[{size:99,mimetype:'text/html'},path])).length,0); checks++;
  const workspaceWithExpense=(await query('select public.load_orquivia_workspace() result'))[0].result;
  const withExpense=structuredClone(workspaceWithExpense.state);
  withExpense.expenses=[{id:expenseId,date:'2025-01-10',supplier:'Proveedor',description:'Material',category:'Material',base:100,vatAmount:21,vatDeductibleAmount:0,total:121,paymentStatus:'paid',paidDate:'2025-01-05',attachments:[attachment]}];
  let expenseVersion=workspaceWithExpense.version;
  expenseVersion=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,withExpense,expenseVersion]))[0].result.version; checks++;
  for(const fields of [
    {supplier:'',base:121,vatAmount:0,total:121,vatReviewNeeded:true},
    {kind:'credit',base:-40,vatAmount:-8.4,total:-48.4,vatDeductibleAmount:-4.2},
    {base:725,vatAmount:152.25,additionalAmount:636.02,total:1513.27},
    {base:61.95,vatAmount:0,total:61.95,cashAmount:61.8},
    {base:110.96,vatAmount:23.3,total:134.26,cashMovements:[
      {id:'a9000000-0000-4000-8000-000000000001',date:'2025-01-02',amount:144.16,reference:'Cargo'},
      {id:'a9000000-0000-4000-8000-000000000002',date:'2025-01-05',amount:-9.9,reference:'Devolución'}]},
  ]) {
    const supported=structuredClone(withExpense); Object.assign(supported.expenses[0],fields);
    expenseVersion=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,supported,expenseVersion]))[0].result.version;
    assert.deepEqual((await query('select public.load_orquivia_workspace() result'))[0].result.state.expenses[0],supported.expenses[0]); checks++;
  }
  expenseVersion=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,withExpense,expenseVersion]))[0].result.version; checks++;
  for(const fields of [
    {supplier:null},{supplier:' '.repeat(241)},{kind:'credit',base:40,vatAmount:-8.4,total:31.6},
    {kind:'credit',base:-40,vatAmount:-8.4,total:-48.4,vatDeductibleAmount:-8.41},
    {base:725,vatAmount:152.25,additionalAmount:636.02,total:1513.26},
    {vatReviewNeeded:'true'},{vatReviewNeeded:true},{cashAmount:-1},
    {cashMovements:[]},{cashMovements:[{id:'a9000000-0000-4000-8000-000000000001',date:'2025-01-05',amount:120}]},
    {paymentStatus:'pending',paidDate:null,cashMovements:[{id:'a9000000-0000-4000-8000-000000000001',date:'2025-01-05',amount:121}]},
    {cashMovements:[{id:'a9000000-0000-4000-8000-000000000001',date:'2025-01-05',amount:100},
      {id:'a9000000-0000-4000-8000-000000000001',date:'2025-01-05',amount:21}]},
  ]) {
    const unsupported=structuredClone(withExpense); Object.assign(unsupported.expenses[0],fields);
    await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,unsupported,expenseVersion],'22023');
  }
  assert.equal((await query('delete from storage.objects where name=$1 returning id',[path])).length,0); checks++;
  const invalidExpense=structuredClone(withExpense); invalidExpense.expenses[0].total=122;
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  invalidExpense.expenses[0].total=121; invalidExpense.expenses[0].vatDeductibleAmount=22;
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  invalidExpense.expenses[0].vatDeductibleAmount=0; invalidExpense.expenses[0].attachments[0].size=10;
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  invalidExpense.expenses[0].attachments[0].size=9; invalidExpense.expenses[0].attachments[0].path=`b2000000-0000-4000-8000-000000000001/${expenseId}/${attachmentId}.pdf`;
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  invalidExpense.expenses[0].attachments[0].path=`${org}/${expenseId}/a5000000-0000-4000-8000-000000000009.pdf`; invalidExpense.expenses[0].attachments[0].id='a5000000-0000-4000-8000-000000000009';
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  invalidExpense.expenses[0].attachments=[]; invalidExpense.company.openingBalance=0.001; invalidExpense.company.openingBalanceDate='2025-01-01';
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,invalidExpense,expenseVersion],'22023');
  assert.equal((await query('select changes from public.orquivia_audit_log order by id desc limit 1'))[0].changes.expenseCount,1); checks++;
  await as('service_role');
  await db.query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await db.query('update public.orquivia_memberships set active=true where user_id=$1',[editor]);
  assert.equal((await query('select public from storage.buckets where id=$1',['orquivia-receipts']))[0].public,false); checks++;
  await as('authenticated',admin);
  assert.equal((await query('select * from storage.objects')).length,0); checks++;
  await deny(objectInsert,['orquivia-receipts',`${org}/${expenseId}/a5000000-0000-4000-8000-000000000002.pdf`,{size:9,mimetype:'application/pdf'}],'42501');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:admin,role:'authenticated',aal:'aal2'})]);
  assert.equal((await query('select * from storage.objects')).length,1); checks++;
  await as('authenticated',outsider);
  assert.equal((await query('select * from storage.objects')).length,0); checks++;
  await deny(objectInsert,['orquivia-receipts',`${org}/${expenseId}/a5000000-0000-4000-8000-000000000002.pdf`,{size:9,mimetype:'application/pdf'}],'42501');
  await as('anon');
  assert.equal((await query('select * from storage.objects')).length,0); checks++;
  await as('authenticated',editor);
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:editor,role:'authenticated',aal:'aal2'})]);
  assert.equal((await query('select * from storage.objects')).length,1); checks++;
  const editorOpening=structuredClone(withExpense); editorOpening.company.openingBalance=-100; editorOpening.company.openingBalanceDate='2025-01-01';
  await deny('select public.save_orquivia_team_state($1,$2,$3)',[org,editorOpening,expenseVersion],'42501');
  const unlink=structuredClone(withExpense); unlink.expenses[0].attachments=[];
  expenseVersion=(await query('select public.save_orquivia_team_state($1,$2,$3) result',[org,unlink,expenseVersion]))[0].result.version; checks++;
  assert.equal((await query('delete from storage.objects where name=$1 returning id',[path])).length,1); checks++;
  console.log(`PASS ${checks} PostgreSQL checks: migrations, shared team access, RLS/MFA, CAS, strict finance, immutable invoices, server numbering/import high-water, append-only audit, org email dedupe, revoked membership, expenses and private immutable receipt originals.`);
} catch(error) { console.error('PostgreSQL verification failed:', error.code, error.message, error.detail || '', error.where || '', 'position',error.position,error.internalPosition); if(error.query && error.position){ const p=Number(error.position);console.error(error.query.slice(Math.max(0,p-150),p+150)); } process.exitCode=1; }
finally { await db.close(); }
