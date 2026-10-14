// Executes the real schema, CAS, audit and Storage policies in local PostgreSQL
// (PGlite/WASM). All identities, amounts and receipt metadata are synthetic.
// No network, production credentials, live Storage objects or live writes.
import { PGlite } from '../.verification/node_modules/@electric-sql/pglite/dist/index.js';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db = await PGlite.create();
const admin = 'c1000000-0000-4000-8000-000000000001';
const editor = 'c1000000-0000-4000-8000-000000000002';
const third = 'c1000000-0000-4000-8000-000000000003';
const outsider = 'c1000000-0000-4000-8000-000000000004';
const org = 'c2000000-0000-4000-8000-000000000001';
const otherOrg = 'c2000000-0000-4000-8000-000000000002';
const expenseId = 'c3000000-0000-4000-8000-000000000001';
const taxId = (number = 1) => `c4000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const fileId = (number = 1) => `c5000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
let checks = 0;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const check = (condition, label) => { assert.ok(condition, label); checks++; };
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const deny = async (sql, params = [], code = '42501', message) => {
  await assert.rejects(db.query(sql, params), (e) => e.code === code && (!message || e.message === message)); checks++;
};
const as = async (role, id = null, aal = 'aal2') => {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: id, role, aal })]);
};
const owner = async () => { await db.exec('reset role'); };
const load = async () => (await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL = 'select public.save_orquivia_team_state($1,$2,$3) result';
const save = async (state, version) => (await query(saveSQL, [org, state, version]))[0].result;
const historySQL = 'select public.load_orquivia_record_history($1,$2,$3,$4,$5) result';
const history = async (id, userId = admin, organizationId = org, type = 'tax') =>
  (await query(historySQL, [organizationId, type, id, 50, userId]))[0].result;
const attachment = (recordId = taxId(), number = 1, organizationId = org) => ({
  id: fileId(number), name: 'Modelo.pdf', path: `${organizationId}/${recordId}/${fileId(number)}.pdf`,
  mimeType: 'application/pdf', size: 20,
});
const tax = (number = 1, overrides = {}) => ({
  id: taxId(number), date: '2025-07-13', model: '303', year: 2025, quarter: 2, amount: 100,
  reference: 'Synthetic declaration', notes: '', paymentStatus: 'paid', paidDate: '2025-07-20',
  attachments: [attachment(taxId(number), number)], ...overrides,
});
const workspace = (overrides = {}) => ({
  company: { name: 'Fixture company' }, clients: [], documents: [], payments: [], expenses: [], ...overrides,
});
const expense = (overrides = {}) => ({
  id: expenseId, date: '2025-07-01', supplier: '', description: 'Services and fiscal suplido', notes: '',
  base: 100, vatAmount: 21, vatDeductibleAmount: 0, additionalAmount: 30, total: 151,
  paymentStatus: 'paid', paidDate: '2025-07-01', attachments: [], ...overrides,
});
const valid = async (state) => (await query('select orquivia_private.valid_state($1) valid', [state]))[0].valid;
const registerObject = async (metadata) => {
  await db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',
    ['orquivia-receipts', metadata.path, { size: metadata.size, mimetype: metadata.mimeType }]);
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
    insert into auth.users values('${admin}','admin@example.test'),('${editor}','editor@example.test'),('${third}','third@example.test'),('${outsider}','outsider@example.test');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;`);
  for (const name of ['202610130001_orquivia.sql', '202610140002_team_production.sql', '202610140003_expenses.sql',
    '202610140004_personal_profiles.sql', '202610140006_personal_identity.sql', '202610140007_expense_quick_entry.sql',
    '202610140008_vat_document_status.sql', '202610140009_record_history.sql']) {
    await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  await as('service_role');
  await db.query('select public.bootstrap_orquivia_team($1,$2,$3,$4)', [admin, editor, 'Fixture company', org]);
  await db.query('insert into public.orquivia_organizations(id,name,require_mfa) values($1,$2,true)', [otherOrg, 'Other fixture']);
  await db.query('update public.orquivia_organizations set require_mfa=true where id=$1', [org]);
  await db.query('insert into public.orquivia_memberships(organization_id,user_id,role) values($1,$2,$3)', [org, third, 'editor']);
  await registerObject(attachment(expenseId, 20));
  await as('authenticated', admin);
  const initial = await load();
  const priorState = structuredClone(initial.state);
  priorState.expenses = [expense({ attachments: [attachment(expenseId, 20)] })];
  priorState.clients = [{ id: 'fixture-client', name: 'Client' }];
  priorState.documents = [{ id: 'fixture-invoice', kind: 'invoice', status: 'draft', number: '', clientId: 'fixture-client',
    date: '2025-07-01', dueDate: '2025-08-01', items: [{ description: 'Service', quantity: 1, price: 100 }], vat: 21, discount: 0, withholding: 0 }];
  await save(priorState, initial.version);
  await owner();
  const priorWorkspace = await query('select * from public.orquivia_team_workspaces order by organization_id');
  const priorAudit = await query('select * from public.orquivia_audit_log order by id');
  const priorHistory = await query('select * from public.orquivia_record_history order by id');
  const priorObjects = await query('select * from storage.objects order by id');
  await db.exec(await readFile(new URL('../migrations/202610140010_tax_records_missing_receipts.sql', import.meta.url), 'utf8'));
  equal(await query('select * from public.orquivia_team_workspaces order by organization_id'), priorWorkspace, 'Upgrade preserves existing state, version and update time');
  equal(await query('select * from public.orquivia_audit_log order by id'), priorAudit, 'Upgrade preserves aggregate audit');
  equal(await query('select * from public.orquivia_record_history order by id'), priorHistory, 'Upgrade preserves per-record history');
  equal(await query('select * from storage.objects order by id'), priorObjects, 'Upgrade preserves original receipt metadata');
  equal((await query("select public from storage.buckets where id='orquivia-receipts'"))[0].public, false, 'Originals stay private');

  const cases = [
    tax(1, { model: '111', amount: 0, paymentStatus: 'no-payment', paidDate: null }),
    tax(2),
    tax(3, { amount: -25 }),
    tax(4, { amount: -10, paymentStatus: 'unconfirmed', paidDate: null }),
    tax(5, { paymentStatus: 'pending', paidDate: null }),
    tax(6, { amount: 30, paymentStatus: 'included', paidDate: null, linkedExpenseId: expenseId }),
  ];
  for (const record of cases) {
    check(await valid(workspace({ expenses: [expense()], taxRecords: [record] })), `Valid ${record.paymentStatus} signed result ${record.amount}`);
    await registerObject(record.attachments[0]);
  }
  check(await valid(workspace()), 'Tax collection is optional for legacy workspaces');
  check(await valid(workspace({ taxRecords: [] })), 'Empty tax collection is valid');
  const missingReceipt = expense({ base: 3, vatAmount: 0, additionalAmount: 0, total: 3, vatReviewNeeded: true,
    vatDocumentStatus: 'not-stated', missingReceiptReason: 'No ticket was requested at the networking bar.', attachments: [] });
  check(await valid(workspace({ expenses: [missingReceipt] })), 'Explicit missing receipt remains cash expense with unknown VAT');
  for (const change of [{ missingReceiptReason: '' }, { missingReceiptReason: '   ' }, { missingReceiptReason: 3 },
    { missingReceiptReason: 'x'.repeat(2001) }, { vatReviewNeeded: false }, { vatRate: 0 },
    { base: 2, vatAmount: 1 }, { vatDeductibleAmount: 0.1 }]) {
    equal(await valid(workspace({ expenses: [{ ...missingReceipt, ...change }] })), false, `Missing receipt guard ${Object.keys(change).join(',')}`);
  }
  const invalid = [
    { id: 'invalid' }, { model: '999' }, { model: 111 }, { year: 2025.5 }, { year: 2026 }, { quarter: 0 },
    { quarter: 5 }, { quarter: 2.5 }, { quarter: 4 }, { date: '2025-02-30' }, { date: '2999-01-01' },
    { amount: '100' }, { amount: 0 }, { amount: 0, paymentStatus: 'pending', paidDate: null },
    { amount: 1.001 }, { amount: 90071992547410 }, { paymentStatus: 'no-payment' },
    { paymentStatus: 'unconfirmed' }, { paymentStatus: 'pending' }, { paidDate: '' },
    { paidDate: '2025-02-30' }, { paidDate: '2999-01-01' }, { paymentStatus: 'bad' },
    { amount: -1, paymentStatus: 'pending', paidDate: null }, { linkedExpenseId: expenseId },
    { paymentStatus: 'included', paidDate: null, linkedExpenseId: 'missing' },
    { paymentStatus: 'included', paidDate: null, linkedExpenseId: expenseId, amount: 31 },
    { amount: -1, paymentStatus: 'included', paidDate: null, linkedExpenseId: expenseId },
    { reference: 12 }, { reference: 'x'.repeat(241) }, { notes: 12 }, { notes: 'x'.repeat(10001) },
    { attachments: [] }, { attachments: {} }, { attachments: Array.from({ length: 11 }, () => attachment()) },
    { attachments: [{ ...attachment(), id: 'invalid' }] },
    { attachments: [{ ...attachment(), name: '../Modelo.pdf' }] },
    { attachments: [{ ...attachment(), name: 'bad\nname.pdf' }] },
    { attachments: [{ ...attachment(), name: '' }] },
    { attachments: [{ ...attachment(), name: 'x'.repeat(241) }] },
    { attachments: [attachment(expenseId)] },
    { attachments: [{ ...attachment(), path: `${org}/${taxId()}/${fileId(2)}.pdf` }] },
    { attachments: [{ ...attachment(), path: `${org}/${taxId()}/../evil.pdf` }] },
    { attachments: [{ ...attachment(), mimeType: 'text/html' }] },
    { attachments: [{ ...attachment(), size: 0 }] },
    { attachments: [{ ...attachment(), size: 1.5 }] },
    { attachments: [{ ...attachment(), size: 10485761 }] },
  ];
  for (const change of invalid) equal(await valid(workspace({ expenses: [expense()], taxRecords: [tax(1, change)] })), false, `Invalid fiscal fixture ${JSON.stringify(change).slice(0, 150)}`);
  equal(await valid(workspace({ taxRecords: {} })), false, 'Tax collection must be array');
  equal(await valid(workspace({ taxRecords: [tax(), tax()] })), false, 'Tax record IDs cannot repeat');
  equal(await valid(workspace({ expenses: [expense()], taxRecords: [tax(1, { id: expenseId, attachments: [attachment(expenseId)] })] })), false, 'Tax and expense IDs cannot collide');
  equal(await valid(workspace({ expenses: [expense({ attachments: [attachment(expenseId)] })], taxRecords: [tax()] })), false, 'Tax and expense receipt IDs cannot collide');
  equal(await valid(workspace({ taxRecords: [tax(), tax(2, { attachments: [attachment(taxId(2), 1)] })] })), false, 'Receipt IDs cannot repeat across declarations');
  equal(await valid(workspace({ taxRecords: [tax(1, { attachments: [attachment(), attachment()] })] })), false, 'Repeated original path cannot be saved twice');
  equal(await valid(workspace({ expenses: [expense()], taxRecords: [cases[5], tax(7, { amount: 1, paymentStatus: 'included', paidDate: null, linkedExpenseId: expenseId })] })), false, 'Aggregate links cannot exceed the already recorded suplido');

  await as('authenticated', admin);
  const beforeTax = await load();
  const state = structuredClone(beforeTax.state); state.taxRecords = cases;
  const created = await save(state, beforeTax.version);
  equal((await load()).state.taxRecords, cases, 'Authenticated CAS keeps declaration records without normalizing signed amounts or zero');
  const createdHistory = await history(taxId(2));
  equal(createdHistory.length, 1); equal(createdHistory[0].action, 'created');
  equal(createdHistory[0].actorId, admin); equal(createdHistory[0].actorEmail, 'admin@example.test');
  equal(createdHistory[0].workspaceVersion, created.version);
  check(createdHistory[0].changedFields.includes('amount') && createdHistory[0].changedFields.includes('paymentStatus'), 'Tax history includes economic and payment field names');
  check(!JSON.stringify(createdHistory).includes('Synthetic declaration'), 'History contains field names but no private field values');
  const expenseHistory = await history(expenseId, admin, org, 'expense');
  check(expenseHistory.some(row => row.entityType === 'tax' && row.entityId === taxId(6)), 'Linked tax history appears on its expense');
  const auditBeforeConflict = await query('select * from public.orquivia_audit_log order by id');
  const historyBeforeConflict = await query('select * from public.orquivia_record_history order by id');
  await as('authenticated', editor);
  const stale = structuredClone(state); stale.taxRecords[1].amount = 200;
  await deny(saveSQL, [org, stale, beforeTax.version], '40001', 'VERSION_CONFLICT');
  equal(await query('select * from public.orquivia_audit_log order by id'), auditBeforeConflict, 'Failed CAS appends no aggregate audit');
  equal(await query('select * from public.orquivia_record_history order by id'), historyBeforeConflict, 'Failed CAS appends no record audit');
  equal((await load()).state.taxRecords[1].amount, 100, 'Stale editor cannot overwrite winner');

  const latest = await load(); latest.state.taxRecords[1].notes = 'Private note value';
  latest.state.taxRecords[1].amount = 120; latest.state.taxRecords[1].paymentStatus = 'pending'; latest.state.taxRecords[1].paidDate = null;
  await save(latest.state, latest.version);
  const updatedHistory = await history(taxId(2), editor);
  equal(updatedHistory[0].actorId, editor);
  equal(updatedHistory[0].changedFields, ['amount', 'notes', 'paidDate', 'paymentStatus']);
  check(!JSON.stringify(updatedHistory).includes('Private note value'), 'Updates do not leak notes');
  await deny(historySQL, [org, 'tax', taxId(2), 50, admin], '42501', 'AUTH_CHANGED');

  await as('authenticated', third);
  const thirdState = await load(); thirdState.state.taxRecords[1].notes = 'Third authorized member';
  await save(thirdState.state, thirdState.version);
  equal((await history(taxId(2), third))[0].actorEmail, 'third@example.test', 'New authorized members may save and read tax history');
  const thirdCurrent = await load();
  await deny(saveSQL, [org, { ...thirdCurrent.state, taxRecords: [tax(8)] }, thirdCurrent.version], '22023', 'INVALID_RECEIPT_REFERENCE');
  await deny(saveSQL, [org, { ...thirdCurrent.state, taxRecords: [tax(2, { attachments: [{ ...attachment(taxId(2), 2), size: 21 }] })] }, thirdCurrent.version], '22023', 'INVALID_RECEIPT_REFERENCE');
  await owner(); await registerObject(attachment(taxId(2), 30, otherOrg));
  await as('authenticated', third);
  await deny(saveSQL, [org, { ...thirdCurrent.state, taxRecords: [tax(2, { attachments: [attachment(taxId(2), 30, otherOrg)] })] }, thirdCurrent.version], '22023', 'INVALID_RECEIPT_REFERENCE');
  const afterReferenceErrors = await load();
  equal(afterReferenceErrors.version, thirdCurrent.version, 'Invalid reference saves leave CAS version unchanged');
  equal(afterReferenceErrors.state, thirdCurrent.state, 'Invalid reference saves leave all records unchanged');
  equal((await history(taxId(2), third)).length, 3, 'Invalid references append no history');
  await deny('select orquivia_private.valid_state($1)', [thirdCurrent.state]);
  await deny('select orquivia_private.valid_state_vat_documents_v3($1)', [thirdCurrent.state]);

  // A future broad Storage policy must not bypass existing restrictive guards.
  await owner();
  await db.exec(`create policy "Fixture broad authenticated read" on storage.objects for select to authenticated using(true);
    create policy "Fixture broad anonymous read" on storage.objects for select to anon using(true);
    create policy "Fixture broad update" on storage.objects for update to authenticated using(true) with check(true);
    create policy "Fixture broad delete" on storage.objects for delete to authenticated using(true);`);
  await as('authenticated', third);
  equal((await query('select name from storage.objects where name=$1', [attachment(taxId(1), 1).path])).length, 1, 'MFA member can read declaration original');
  equal((await query('select name from storage.objects where name=$1', [attachment(taxId(2), 30, otherOrg).path])).length, 0, 'Member cannot read other organization original');
  equal((await query('update storage.objects set metadata=$1 where name=$2 returning name', [{ size: 20, mimetype: 'application/pdf', forged: true }, attachment(taxId(1), 1).path])).length, 0, 'Declaration originals cannot be overwritten');
  equal((await query('delete from storage.objects where name=$1 returning name', [attachment(taxId(1), 1).path])).length, 0, 'Linked tax originals cannot be deleted');
  equal((await query('select name from storage.objects where name=$1', [attachment(taxId(1), 1).path])).length, 1, 'Linked original survives denied mutation');

  await as('authenticated', third, 'aal1');
  await deny(historySQL, [org, 'tax', taxId(1), 50, third], '42501', 'MFA_REQUIRED');
  await deny(saveSQL, [org, thirdCurrent.state, thirdCurrent.version], '42501', 'MFA_REQUIRED');
  equal((await query('select * from public.orquivia_record_history')).length, 0, 'AAL1 cannot read history table');
  equal((await query('select * from storage.objects')).length, 0, 'AAL1 cannot download private originals');
  await as('authenticated', outsider);
  await deny(historySQL, [org, 'tax', taxId(1), 50, outsider], '42501', 'MEMBERSHIP_REQUIRED');
  await deny(saveSQL, [org, thirdCurrent.state, thirdCurrent.version], '42501', 'MEMBERSHIP_REQUIRED');
  equal((await query('select * from public.orquivia_record_history')).length, 0, 'Outsider cannot read history table');
  equal((await query('select * from storage.objects')).length, 0, 'Outsider cannot download originals');
  await as('anon');
  await deny(historySQL, [org, 'tax', taxId(1), 50, null]);
  await deny(saveSQL, [org, thirdCurrent.state, thirdCurrent.version]);
  await deny('select * from public.orquivia_record_history');
  await deny('select orquivia_private.valid_state($1)', [thirdCurrent.state]);
  equal((await query('select * from storage.objects')).length, 0, 'Anonymous cannot download originals even with broad select policy');

  console.log(`PASS ${checks} PostgreSQL checks: tax results and payment states, missing-receipt guards, private original references, upgrade preservation, atomic actor-derived tax audit, stale-save denial, dynamic membership, MFA/identity/RLS boundaries and immutable linked originals.`);
} catch (error) {
  console.error('Tax records PostgreSQL verification failed:', error.code, error.message, error.detail || '', error.where || '');
  process.exitCode = 1;
} finally { await db.close(); }
