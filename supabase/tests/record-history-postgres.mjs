// Runs the real migrations and authorization/CAS routines against PostgreSQL
// (PGlite/WASM); fixture-only users and documents never touch the live company.
import { PGlite } from '../.verification/node_modules/@electric-sql/pglite/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = await PGlite.create();
const admin = 'a1000000-0000-4000-8000-000000000001';
const editor = 'a1000000-0000-4000-8000-000000000002';
const third = 'a1000000-0000-4000-8000-000000000003';
const outsider = 'a1000000-0000-4000-8000-000000000004';
const org = 'a2000000-0000-4000-8000-000000000001';
const otherOrg = 'a2000000-0000-4000-8000-000000000002';
const expenseId = 'a4000000-0000-4000-8000-000000000001';
let checks = 0;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const deny = async (sql, params = [], code = '42501', message) => {
  await assert.rejects(db.query(sql, params), (e) => e.code === code && (!message || e.message === message)); checks++;
};
const as = async (role, id = null, aal = 'aal2') => {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, role, aal })]);
};
const load = async () => (await query('select public.load_orquivia_workspace() result'))[0].result;
const save = async (state, version) => (await query('select public.save_orquivia_team_state($1,$2,$3) result', [org, state, version]))[0].result;
const historySQL = 'select public.load_orquivia_record_history($1,$2,$3,$4,$5) result';
const history = async (type, id, userId = admin, organizationId = org, limit = 50) =>
  (await query(historySQL, [organizationId, type, id, limit, userId]))[0].result;

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${admin}','nicole@example.test'),('${editor}','liliana@example.test'),('${third}','third@example.test'),('${outsider}','outsider@example.test');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;`);
  for (const name of ['202610130001_orquivia.sql', '202610140002_team_production.sql', '202610140003_expenses.sql',
    '202610140004_personal_profiles.sql', '202610140006_personal_identity.sql', '202610140007_expense_quick_entry.sql',
    '202610140008_vat_document_status.sql']) {
    await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  await as('service_role');
  await db.query('select public.bootstrap_orquivia_team($1,$2,$3,$4)', [admin, editor, 'Test company', org]);
  await db.query('insert into public.orquivia_organizations(id,name,require_mfa) values($1,$2,true)', [otherOrg, 'Other company']);
  await db.query('update public.orquivia_organizations set require_mfa=true where id=$1', [org]);
  await db.query('insert into public.orquivia_memberships(organization_id,user_id,role) values($1,$2,$3)', [org, third, 'editor']);
  const priorAudit = await query('select * from public.orquivia_audit_log order by id');
  await db.exec('reset role');
  await db.exec(await readFile(new URL('../migrations/202610140009_record_history.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await query('select * from public.orquivia_audit_log order by id'), priorAudit, 'Upgrade must preserve prior aggregate audit'); checks++;
  assert.equal((await query('select count(*) count from public.orquivia_record_history'))[0].count, 0, 'Upgrade must not invent past changes'); checks++;

  await as('authenticated', admin);
  const initial = await load();
  const state = structuredClone(initial.state);
  state.clients = [{ id: 'c1', name: 'Client' }];
  state.documents = [{ id: 'd1', kind: 'invoice', status: 'draft', number: '', clientId: 'c1', date: '2025-01-10',
    dueDate: '2025-02-10', items: [{ description: 'Service', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0 }];
  state.expenses = [{ id: expenseId, date: '2025-01-10', supplier: '', supplierTaxId: '', description: 'Receipt', category: '', reference: '',
    notes: '', base: 2.41, vatAmount: 0, vatDeductibleAmount: 0, total: 2.41, paymentStatus: 'paid', paidDate: '2025-01-10',
    attachments: [], vatReviewNeeded: true, vatDocumentStatus: 'not-stated' }];
  const saved = await save(state, initial.version);
  const created = await history('expense', expenseId);
  assert.equal(created.length, 1); assert.equal(created[0].action, 'created');
  assert.equal(created[0].actorId, admin); assert.equal(created[0].actorEmail, 'nicole@example.test');
  assert.equal(created[0].workspaceVersion, saved.version); assert.ok(created[0].changedFields.includes('total'));
  assert.ok(!JSON.stringify(created).includes('Receipt'), 'Field values must not enter record history'); checks++;
  const beforeConflict = (await query('select count(*) count from public.orquivia_record_history'))[0].count;
  await as('authenticated', editor);
  const stale = structuredClone(state); stale.expenses[0].description = 'Stale concurrent edit';
  await deny('select public.save_orquivia_team_state($1,$2,$3)', [org, stale, initial.version], '40001', 'VERSION_CONFLICT');
  assert.equal((await query('select count(*) count from public.orquivia_record_history'))[0].count, beforeConflict, 'Failed CAS must append no record changes');
  assert.equal((await load()).state.expenses[0].description, 'Receipt', 'Failed CAS must preserve the winning save'); checks++;

  const latest = await load();
  const updated = structuredClone(latest.state); updated.expenses[0].reviewNeeded = true;
  updated.expenses[0].notes = 'This value is private';
  const editorSave = await save(updated, latest.version);
  const edited = await history('expense', expenseId, editor);
  assert.equal(edited.length, 2); assert.equal(edited[0].actorId, editor);
  assert.equal(edited[0].action, 'updated'); assert.deepEqual(edited[0].changedFields, ['notes', 'reviewNeeded']);
  assert.ok(!JSON.stringify(edited).includes('This value is private')); checks++;
  await deny('select public.load_orquivia_record_history($1,$2,$3,$4,$5)', [org, 'expense', expenseId, 50, admin], '42501', 'AUTH_CHANGED');
  await deny('insert into public.orquivia_record_history(audit_id,organization_id,event,workspace_version,entity_type,entity_id,action,changed_fields) values(1,$1,$2,9,$3,$4,$5,$6)', [org, 'forged', 'expense', expenseId, 'updated', []]);
  await deny('update public.orquivia_record_history set actor_email=$1', ['forged@example.test']);
  await deny('delete from public.orquivia_record_history');
  await deny('select orquivia_private.audit($1,$2,99,$3,$4,$5)', [org, 'forged', updated, updated, admin]);

  await as('authenticated', third);
  const thirdState = await load(); thirdState.state.expenses[0].description = 'Third member edit';
  const thirdSave = await save(thirdState.state, thirdState.version);
  assert.equal((await history('expense', expenseId, third))[0].actorEmail, 'third@example.test', 'Any authorized future member participates'); checks++;
  const issued = (await query('select public.issue_orquivia_document($1,$2,$3) result', [org, 'd1', thirdSave.version]))[0].result;
  const documentHistory = await history('document', 'd1', third);
  assert.equal(documentHistory[0].event, 'issue'); assert.equal(documentHistory[0].actorId, third);
  assert.ok(documentHistory[0].changedFields.includes('number')); checks++;
  const paymentState = structuredClone(issued.state);
  paymentState.payments = [{ id: 'p1', documentId: 'd1', amount: 121, date: '2025-01-11', reference: 'Bank payment' }];
  paymentState.documents[0].status = 'paid';
  const paidSave = await save(paymentState, issued.version);
  const paidHistory = await history('document', 'd1', third);
  assert.ok(paidHistory.some((entry) => entry.entityType === 'payment' && entry.entityId === 'p1' && entry.action === 'created'), 'Invoice history includes its payment changes'); checks++;

  const same = await load();
  const noChangeSave = await save(same.state, same.version);
  assert.equal((await history('expense', expenseId, third)).length, 3, 'Unchanged saves create no duplicate record changes'); checks++;
  const deletedState = structuredClone(same.state); deletedState.expenses = [];
  await save(deletedState, noChangeSave.version);
  assert.equal((await history('expense', expenseId, third))[0].action, 'deleted', 'Deletion evidence survives after record removal'); checks++;
  assert.equal((await history('expense', expenseId, third, org, 1)).length, 1); checks++;
  await deny(historySQL, [otherOrg, 'document', 'd1', 50, third]);
  await as('authenticated', third, 'aal1'); await deny(historySQL, [org, 'document', 'd1', 50, third], '42501', 'MFA_REQUIRED');
  assert.equal((await query('select * from public.orquivia_record_history')).length, 0); checks++;
  await as('authenticated', outsider); await deny(historySQL, [org, 'document', 'd1', 50, outsider]);
  assert.equal((await query('select * from public.orquivia_record_history')).length, 0); checks++;
  await as('anon'); await deny(historySQL, [org, 'document', 'd1', 50, null]);
  await deny('select * from public.orquivia_record_history');
  await as('service_role');
  await db.query('update public.orquivia_memberships set active=false where user_id=$1', [third]);
  await as('authenticated', third); await deny(historySQL, [org, 'document', 'd1', 50, third]);
  await db.exec('reset role');
  const fields = (await query("select orquivia_private.record_change_fields('expense',$1,$2) fields", [{ id: 'x', notes: 'old' }, { id: 'x', notes: 'new', password: 'private-secret', avatar: { private: 'profile' } }]))[0].fields;
  assert.deepEqual(fields, ['notes', 'other'], 'Unknown/credential/profile keys are never exposed'); checks++;
  console.log(`PASS ${checks} PostgreSQL checks: atomic record audit, stale editor denial, dynamic third member, invoice/payment history, immutable permissions, MFA/RLS/org isolation, session identity, upgrade preservation and safe field-only history.`);
} catch (error) {
  console.error('Record history PostgreSQL verification failed:', error.code, error.message, error.detail || '', error.where || '');
  process.exitCode = 1;
} finally { await db.close(); }
