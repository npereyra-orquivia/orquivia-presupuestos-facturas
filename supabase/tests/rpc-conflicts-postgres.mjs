// Real PostgreSQL behavior in PGlite, with synthetic users only. HTTP behavior
// is separately checked in staging: PGlite does not run PostgREST's retry loop.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { emptyState } from '../../src/demo.js';

const db = await PGlite.create();
const admin = 'f1000000-0000-4000-8000-000000000001';
const editor = 'f1000000-0000-4000-8000-000000000002';
const outsider = 'f1000000-0000-4000-8000-000000000003';
const org = 'f2000000-0000-4000-8000-000000000001';
const job = 'f3000000-0000-4000-8000-000000000001';
const targets = [
  'public.import_orquivia_state(uuid,jsonb,bigint)',
  'orquivia_private.save_state(jsonb,bigint)',
  'orquivia_private.save_team(uuid,jsonb,bigint)',
  'orquivia_private.issue_document(uuid,text,bigint)',
  'public.orquivia_mail_save_profile(uuid,uuid,bigint,jsonb,text,text,text,boolean)',
  'public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb)',
];
const tables = ['public.orquivia_workspaces', 'public.orquivia_team_workspaces', 'public.orquivia_number_counters',
  'public.orquivia_document_numbers', 'public.orquivia_audit_log', 'public.orquivia_record_history',
  'orquivia_private.mail_profiles', 'orquivia_private.mail_jobs', 'vault.secrets', 'storage.buckets', 'storage.objects'];
let checks = 0;
const query = async (sql, params = []) => (await db.query(sql, params)).rows;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const denied = async (sql, params, code, message) => {
  await assert.rejects(db.query(sql, params), error => error.code === code && (!message || error.message === message)); checks++;
};
const as = async (role, user = admin, aal = 'aal2') => {
  await db.exec(`reset role; set role ${role}`);
  await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, role, aal })]);
};
const owner = () => db.exec('reset role');
const migration = name => readFile(new URL('../migrations/' + name, import.meta.url), 'utf8');
const load = async () => (await query('select public.load_orquivia_workspace() result'))[0].result;
const saveSQL = 'select public.save_orquivia_team_state($1,$2,$3) result';
const issueSQL = 'select public.issue_orquivia_document($1,$2,$3) result';
const profileSQL = 'select public.orquivia_mail_save_profile($1,$2,$3,$4,$5,$6,$7,$8) result';
const claimSQL = 'select public.orquivia_mail_claim($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) result';
const definitions = async () => Promise.all(targets.map(async signature => (await query(
  'select pg_get_functiondef($1::regprocedure) definition', [signature]))[0].definition));
const permissions = async () => Promise.all(targets.map(async signature => (await query(`select oid,proowner,
  proacl::text,prosecdef,proconfig,provolatile,proparallel,proleakproof,prorettype,proargtypes::text,
  proargnames,proargmodes,proallargtypes,proargdefaults::text from pg_proc where oid=$1::regprocedure`, [signature]))[0]));
const data = async () => Promise.all(tables.map(table => query(`select to_jsonb(t) value from ${table} t order by to_jsonb(t)::text`)));
const draft = (id, kind = 'invoice') => ({ id, kind, status: 'draft', number: '', clientId: 'fixture-client',
  date: '2025-05-01', dueDate: '', items: [{ description: 'Synthetic service', quantity: 1, price: 100 }],
  vat: 21, discount: 0, withholding: 0 });

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
    insert into auth.mfa_factors(user_id,status) values('${admin}','verified'),('${editor}','verified');
    create schema storage;
    create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    grant all on storage.objects,storage.buckets to service_role;
    -- Synthetic adapter: no real Vault secrets, provider or network access.
    create schema vault;create table vault.secrets(id uuid primary key default gen_random_uuid(),secret text);
    create view vault.decrypted_secrets as select id,secret decrypted_secret from vault.secrets;
    create function vault.create_secret(value text) returns uuid language plpgsql as $$declare result uuid;begin insert into vault.secrets(secret) values(value) returning id into result;return result;end$$;
    create function vault.update_secret(secret_id uuid,value text) returns void language sql as $$update vault.secrets set secret=value where id=secret_id$$;`);
  for (const name of ['202610130001_orquivia.sql', '202610140002_team_production.sql', '202610140003_expenses.sql',
    '202610140004_personal_profiles.sql', '202610140006_personal_identity.sql', '202610140007_expense_quick_entry.sql',
    '202610140008_vat_document_status.sql', '202610140009_record_history.sql', '202610140010_tax_records_missing_receipts.sql',
    '202610150011_prepared_quotes.sql', '202610150012_document_mail.sql', '202610150013_mail_recipients.sql',
    '202610230014_invoice_mail.sql', '202610260015_invoice_mail_attachments.sql']) {
    await db.exec((await migration(name)).replace('create extension if not exists supabase_vault with schema vault;', ''));
  }
  await as('service_role');
  await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)', [admin, editor, 'Synthetic company', org]);
  await query('update public.orquivia_organizations set require_mfa=true where id=$1', [org]);
  await as('authenticated');
  let current = await load();
  current.state.clients = [{ id: 'fixture-client', name: 'Synthetic client', email: 'client@example.test' }];
  current.state.documents = [draft('invoice-first'), draft('invoice-second'), draft('quote', 'quote')];
  let saved = (await query(saveSQL, [org, current.state, current.version]))[0].result;
  let issued = (await query(issueSQL, [org, 'invoice-first', saved.version]))[0].result;
  equal(issued.document_number, 'F-2025-001');
  await as('service_role');
  await query('select orquivia_private.save_state($1,0)', [emptyState()]);
  await as('service_role');
  const signature = { name: 'Synthetic owner', role: 'Director', phone: '123456789' };
  let profile = (await query(profileSQL, [admin, org, 0, signature, 'serviciodecorreo', 'synthetic-test-secret', 'Sent', false]))[0].result;
  equal(profile.version, 1);

  await owner();
  const originalDefinitions = await definitions(), originalPermissions = await permissions(), originalData = await data();
  const fix = await migration('202610270016_rpc_conflict_http.sql');
  await db.exec(fix);
  const fixedDefinitions = await definitions();
  for (const [index, before] of originalDefinitions.entries()) {
    equal(fixedDefinitions[index], before.replace(/(raise\s+exception\s+'(?:VERSION_CONFLICT|PROFILE_CONFLICT)'\s+using\s+errcode\s*=\s*)'40001'/gi, "$1'PT409'"), `Only SQLSTATE changes for ${targets[index]}`);
    equal(fixedDefinitions[index].includes("'40001'"), false);
  }
  equal(await permissions(), originalPermissions, 'OIDs, owners, ACLs, security, search_path, arguments and defaults preserved');
  equal(await data(), originalData, 'Migration does not rewrite application, numbering, audit, file or Vault data');
  await db.exec(fix);
  equal(await definitions(), fixedDefinitions, 'Reapplication is idempotent');
  equal(await permissions(), originalPermissions);
  equal(await data(), originalData);

  // Each of the six installed business conflict paths returns non-retryable
  // PT409 and keeps the exact existing application message.
  await as('service_role');
  await denied('select orquivia_private.save_state($1,0)', [emptyState()], 'PT409', 'VERSION_CONFLICT');
  await as('authenticated');
  await denied('select public.save_orquivia_state($1,0)', [emptyState()], '42501');
  await as('service_role');
  await denied('select public.import_orquivia_state($1,$2,$3)', [org, issued.state, issued.version - 1], 'PT409', 'VERSION_CONFLICT');
  await as('authenticated');
  const firstSnapshot = await load(), peerSnapshot = structuredClone(firstSnapshot);
  firstSnapshot.state.clients[0].contact = 'First writer';
  saved = (await query(saveSQL, [org, firstSnapshot.state, firstSnapshot.version]))[0].result;
  await as('authenticated', editor);
  peerSnapshot.state.clients[0].contact = 'Stale writer';
  await denied(saveSQL, [org, peerSnapshot.state, peerSnapshot.version], 'PT409', 'VERSION_CONFLICT');
  current = await load();
  equal(current.version, firstSnapshot.version + 1);
  equal(current.state.clients[0].contact, 'First writer', 'Stale writer cannot overwrite the winner');
  await owner(); const beforeStaleIssue = await data(); await as('authenticated');
  await denied(issueSQL, [org, 'invoice-second', firstSnapshot.version], 'PT409', 'VERSION_CONFLICT');
  await owner(); equal(await data(), beforeStaleIssue, 'Rejected issue cannot reserve a number, change state or append audit');
  await as('authenticated');
  issued = (await query(issueSQL, [org, 'invoice-second', current.version]))[0].result;
  equal(issued.document_number, 'F-2025-002', 'The next valid issue keeps consecutive server numbering');

  await owner(); const beforeStaleProfile = await data(); await as('service_role');
  await denied(profileSQL, [admin, org, 0, { ...signature, name: 'Stale profile' }, null, 'replacement-test-secret', 'Changed', false], 'PT409', 'PROFILE_CONFLICT');
  await owner(); equal(await data(), beforeStaleProfile, 'Rejected profile cannot replace its password, signature or version');
  await as('service_role');
  profile = (await query(profileSQL, [admin, org, 1, { ...signature, name: 'Current profile' }, null, null, null, false]))[0].result;
  equal(profile.version, 2);
  equal(profile.signature.name, 'Current profile');
  const claim = [admin, org, job, 'invoice-second', issued.version, 'fixture-request-hash', ['client@example.test'], 'Synthetic subject', [], []];
  await owner(); const beforeStaleClaim = await data(); await as('service_role');
  await denied(claimSQL, [...claim.slice(0, 4), issued.version - 1, ...claim.slice(5)], 'PT409', 'VERSION_CONFLICT');
  await owner(); equal(await data(), beforeStaleClaim, 'Rejected claim cannot create a mail job or change numbering/state');
  await as('service_role');
  equal((await query(claimSQL, claim))[0].result.existing, false);
  equal((await query(claimSQL, claim))[0].result.existing, true, 'An accepted claim retains idempotency');
  await as('authenticated', editor);
  current = await load();
  saved = (await query(saveSQL, [org, current.state, current.version]))[0].result;
  equal(saved.version, current.version + 1, 'A fresh save remains usable after conflicts and issuing');
  await as('authenticated', outsider);
  await denied(saveSQL, [org, current.state, saved.version], '42501', 'MEMBERSHIP_REQUIRED');
  await as('authenticated', admin, 'aal1');
  await denied(saveSQL, [org, current.state, saved.version], '42501', 'MFA_REQUIRED');
  await as('anon'); await denied(saveSQL, [org, current.state, saved.version], '42501');
  await as('authenticated'); await denied(claimSQL, claim, '42501');

  // A missing last target or unfamiliar conflict must roll back earlier edits.
  // No function outside the exact allowlist is rewritten as a side effect.
  await owner();
  for (const definition of originalDefinitions) await db.exec(definition);
  await db.exec(`alter function ${targets[5]} rename to fixture_temporarily_missing_claim`);
  await assert.rejects(db.exec(fix), error => error.message === 'RPC_CONFLICT_MIGRATION_FUNCTION_MISSING'); checks++;
  await db.exec('rollback');
  await db.exec('alter function public.fixture_temporarily_missing_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb) rename to orquivia_mail_claim');
  equal(await definitions(), originalDefinitions, 'Missing target rolls back every preceding replacement');
  await db.exec(originalDefinitions[5].replace("raise exception 'VERSION_CONFLICT'", "raise exception 'UNEXPECTED_FIXTURE_CONFLICT'"));
  await assert.rejects(db.exec(fix), error => error.message === 'RPC_CONFLICT_MIGRATION_UNEXPECTED_DEFINITION'); checks++;
  await db.exec('rollback');
  equal((await definitions()).slice(0, 5), originalDefinitions.slice(0, 5), 'Unknown definition rolls back preceding replacements');
  await db.exec(originalDefinitions[5]); await db.exec(fix);
  equal(await definitions(), fixedDefinitions);
  equal(await permissions(), originalPermissions, 'Error guards never widen grants');
  console.log(`PASS ${checks} PostgreSQL conflict checks: six exact RPC bodies, metadata/grants preservation, idempotency and fail-closed rollback, stale saves/profiles/import/mail, MFA, numbering and follow-up saves.`);
} finally { await db.close(); }
