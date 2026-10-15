// Real PostgreSQL checks in local PGlite. Synthetic data only; no network or
// production credentials. Run: node supabase/tests/prepared-quotes-postgres.mjs
import { PGlite } from '../.verification/node_modules/@electric-sql/pglite/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = await PGlite.create();
const admin = 'd1000000-0000-4000-8000-000000000001';
const editor = 'd1000000-0000-4000-8000-000000000002';
const outsider = 'd1000000-0000-4000-8000-000000000003';
const org = 'd2000000-0000-4000-8000-000000000001';
let checks = 0;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const deny = async (sql, params = [], code = '42501', message) => {
  await assert.rejects(db.query(sql, params), error => error.code === code && (!message || error.message === message)); checks++;
};
const as = async (role, user = null, aal = 'aal2') => {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role, aal })]);
};
const owner = async () => { await db.exec('reset role'); };
const load = async () => (await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL = 'select public.save_orquivia_team_state($1,$2,$3) result';
const issueSQL = 'select public.issue_orquivia_document($1,$2,$3) result';
const save = async (state, version) => (await query(saveSQL, [org, state, version]))[0].result;
const issue = async (id, version) => (await query(issueSQL, [org, id, version]))[0].result;
const valid = async state => (await query('select orquivia_private.valid_state($1) valid', [state]))[0].valid;
const document = (id, kind = 'quote', date = '2025-05-01') => ({
  id, kind, status: 'draft', number: '', clientId: 'fixture-client', date, dueDate: '',
  items: [{ description: 'Synthetic service', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0,
});
const changeDocument = async (id, change) => {
  const current = await load();
  current.state.documents = current.state.documents.map(doc => doc.id === id ? { ...doc, ...change } : doc);
  return { ...current, result: await save(current.state, current.version) };
};
const rejectChange = async (id, change, message = 'ISSUED_DOCUMENT_IMMUTABLE') => {
  const current = await load();
  current.state.documents = current.state.documents.map(doc => doc.id === id ? { ...doc, ...change } : doc);
  await deny(saveSQL, [org, current.state, current.version], '22023', message);
};

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${admin}','admin@example.test'),('${editor}','editor@example.test'),('${outsider}','outsider@example.test');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;`);
  for (const name of ['202610130001_orquivia.sql', '202610140002_team_production.sql', '202610140003_expenses.sql',
    '202610140004_personal_profiles.sql', '202610140006_personal_identity.sql', '202610140007_expense_quick_entry.sql',
    '202610140008_vat_document_status.sql', '202610140009_record_history.sql', '202610140010_tax_records_missing_receipts.sql']) {
    await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  await as('service_role');
  await db.query('select public.bootstrap_orquivia_team($1,$2,$3,$4)', [admin, editor, 'Fixture company', org]);
  await db.query('update public.orquivia_organizations set require_mfa=true where id=$1', [org]);
  await as('authenticated', admin);
  const initial = await load();
  initial.state.clients = [{ id: 'fixture-client', name: 'Client' }];
  initial.state.documents = [document('legacy-quote'), document('legacy-invoice', 'invoice')];
  const seeded = await save(initial.state, initial.version);
  const oldQuote = await issue('legacy-quote', seeded.version);
  equal(oldQuote.state.documents.find(doc => doc.id === 'legacy-quote').status, 'sent', 'Fixture reflects legacy issuance behavior');
  await issue('legacy-invoice', oldQuote.version);
  await owner();
  const tables = ['orquivia_team_workspaces', 'orquivia_number_counters', 'orquivia_document_numbers', 'orquivia_audit_log', 'orquivia_record_history'];
  const before = await Promise.all(tables.map(table => query(`select * from public.${table} order by 1,2`)));
  const beforeStorage = await query('select * from storage.buckets order by id');
  await db.exec(await readFile(new URL('../migrations/202610150011_prepared_quotes.sql', import.meta.url), 'utf8'));
  for (const [index, table] of tables.entries()) equal(await query(`select * from public.${table} order by 1,2`), before[index], `Upgrade preserves ${table}`);
  equal(await query('select * from storage.buckets order by id'), beforeStorage, 'Upgrade preserves private Storage configuration');

  // The wrapper admits only ready quotes and keeps the full prior validator.
  const fixture = structuredClone(before[0][0].state);
  fixture.documents[0].status = 'ready';
  check(await valid(fixture), 'Prepared quote with existing number is valid');
  for (const change of [{ number: '' }, { date: '2999-01-01' }, { status: 'ready', kind: 'invoice' },
    { items: [] }, { total: 100 }, { vat: 101 }, { status: 'unknown' }]) {
    const invalid = structuredClone(fixture); Object.assign(invalid.documents[0], change);
    equal(await valid(invalid), false, `Prepared quote retains validation for ${Object.keys(change)}`);
  }
  for (const documents of [null, {}, 'ready']) equal(await valid({ ...fixture, documents }), false, 'Malformed documents remain invalid');
  equal(await valid({ ...fixture, extra: 'x'.repeat(5000000) }), false, 'Actual payload size limit is retained');
  equal(await valid({ ...fixture, expenses: [{ id: 'bad', total: -1 }] }), false, 'Expense validator remains active');
  equal(await valid({ ...fixture, taxRecords: [{ id: 'bad', model: '303' }] }), false, 'Tax validator remains active');

  await as('authenticated', admin);
  const current = await load();
  current.state.documents.push(document('new-quote'), document('new-invoice', 'invoice'), document('prior-year-quote', 'quote', '2024-12-30'));
  const withDrafts = await save(current.state, current.version);
  const prepared = await issue('new-quote', withDrafts.version);
  const preparedQuote = prepared.state.documents.find(doc => doc.id === 'new-quote');
  equal(preparedQuote.status, 'ready', 'New quote is prepared without implying it was sent');
  equal(preparedQuote.number, 'PR-2025-002', 'Quote continues the annual quote sequence');
  equal(preparedQuote.companySnapshot, prepared.state.company, 'Prepared quote snapshots the company');
  equal(preparedQuote.clientSnapshot, prepared.state.clients[0], 'Prepared quote snapshots the client');
  equal(preparedQuote.paymentReviewNeeded, false, 'Quote is not an invoice payment review');
  const issued = await issue('new-invoice', prepared.version);
  equal(issued.state.documents.find(doc => doc.id === 'new-invoice').status, 'issued', 'Invoice issuance stays issued');
  equal(issued.document_number, 'F-2025-002', 'Invoice annual sequence is independent');
  const priorYear = await issue('prior-year-quote', issued.version);
  equal(priorYear.document_number, 'PR-2024-001', 'Different year receives its own quote sequence');
  await deny(issueSQL, [org, 'new-quote', withDrafts.version], '40001', 'VERSION_CONFLICT');
  await deny(issueSQL, [org, 'new-quote', priorYear.version], '22023', 'DOCUMENT_NOT_DRAFT');
  equal((await load()).version, priorYear.version, 'Failed issue calls do not increment workspace version');
  const ledger = await query('select number,sequence,kind from public.orquivia_document_numbers where document_id=$1', ['new-quote']);
  equal(ledger.length, 1, 'Prepared quote has exactly one ledger number');
  equal(ledger[0], { number: 'PR-2025-002', sequence: 2, kind: 'quote' }, 'Prepared quote ledger is unchanged by failed reissue');

  // Authorized members can correct operational statuses with the same ledger.
  await as('authenticated', editor);
  for (const status of ['sent', 'ready', 'accepted', 'rejected', 'ready']) {
    await changeDocument('new-quote', { status });
    equal((await load()).state.documents.find(doc => doc.id === 'new-quote').status, status, `Prepared quote transitions to ${status}`);
  }
  const history = (await query('select public.load_orquivia_record_history($1,$2,$3,$4,$5) result', [org, 'document', 'new-quote', 50, editor]))[0].result;
  equal(history[0].actorId, editor, 'Server records the member who changed the quote status');
  equal(history[0].actorEmail, 'editor@example.test', 'Actor email is server derived');
  equal(history[0].changedFields, ['status'], 'Status change audit contains only field names');
  check(!JSON.stringify(history).includes('Synthetic service'), 'Audit does not expose line-item values');
  await rejectChange('new-quote', { status: 'draft' });
  await rejectChange('new-quote', { number: 'PR-2025-999' });
  await rejectChange('new-quote', { date: '2025-05-02' });
  await rejectChange('new-quote', { kind: 'invoice', status: 'issued' });
  const deleting = await load(); deleting.state.documents = deleting.state.documents.filter(doc => doc.id !== 'new-quote');
  await deny(saveSQL, [org, deleting.state, deleting.version], '22023', 'ISSUED_DOCUMENT_DELETE_DENIED');
  const injecting = await load(); injecting.state.documents.push({ ...document('injected-quote'), status: 'ready', number: 'PR-2025-999' });
  await deny(saveSQL, [org, injecting.state, injecting.version], '22023', 'ISSUE_REQUIRED');
  await rejectChange('new-invoice', { status: 'ready' }, 'INVALID_STATE');
  await rejectChange('new-invoice', { items: [{ description: 'Changed invoice', quantity: 1, price: 200 }], total: 242 });
  // Quotes intentionally retain their previous ability to edit concepts after
  // numbering; invoices retain their immutable issued fiscal data.
  await changeDocument('new-quote', { items: [{ description: 'Updated quote concept', quantity: 1, price: 200 }], total: 242 });
  equal((await load()).state.documents.find(doc => doc.id === 'new-quote').total, 242, 'Prepared quote remains editable like other numbered quotes');
  const fresh = await load();
  const stale = structuredClone(fresh.state); stale.documents.find(doc => doc.id === 'new-quote').status = 'sent';
  await as('authenticated', admin); await changeDocument('new-quote', { status: 'accepted' });
  await as('authenticated', editor);
  await deny(saveSQL, [org, stale, fresh.version], '40001', 'VERSION_CONFLICT');
  equal((await load()).state.documents.find(doc => doc.id === 'new-quote').status, 'accepted', 'Stale editor cannot overwrite a winning status change');
  await deny('select orquivia_private.valid_state($1)', [fixture]);
  await deny('select orquivia_private.valid_state_tax_records_v4($1)', [fixture]);
  await as('authenticated', editor, 'aal1');
  await deny(issueSQL, [org, 'new-quote', fresh.version], '42501', 'MFA_REQUIRED');
  await deny(saveSQL, [org, fresh.state, fresh.version], '42501', 'MFA_REQUIRED');
  equal((await query('select * from public.orquivia_record_history')).length, 0, 'MFA remains required to read record history');
  await as('authenticated', outsider);
  await deny(issueSQL, [org, 'new-quote', fresh.version], '42501', 'MEMBERSHIP_REQUIRED');
  await deny(saveSQL, [org, fresh.state, fresh.version], '42501', 'MEMBERSHIP_REQUIRED');
  await as('anon');
  await deny(issueSQL, [org, 'new-quote', fresh.version]);
  await deny(saveSQL, [org, fresh.state, fresh.version]);
  await deny('select orquivia_private.valid_state($1)', [fixture]);
  await deny('select * from public.orquivia_record_history');
  console.log(`PASS ${checks} PostgreSQL checks: prepared quotes, unchanged legacy records and invoices, annual numbering, quote transitions, issued protections, atomic server-derived history, CAS conflicts and membership/MFA/anonymous boundaries.`);
} catch (error) {
  console.error('Prepared quote PostgreSQL verification failed:', error.code, error.message, error.detail || '', error.where || '');
  process.exitCode = 1;
} finally { await db.close(); }
