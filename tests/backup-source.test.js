import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { assertCaptureStable, projectRef, databaseEnvironment, databaseFingerprint, configurationFingerprint, SNAPSHOT_FINGERPRINT_SQL, storageClient, authenticationConfig, recoveryPackage, restorePlan, commandText, sourceEntries, PRODUCTION_PROJECT_REF } from '../scripts/backup/source.mjs';
const ref = 'abcdefghijklmnopqrst', targetRef = 'zyxwvutsrqponmlkjihg';
const origin = `https://${ref}.supabase.co`;
const database = (id = ref) => `postgresql://${encodeURIComponent('postgres.' + id)}:${encodeURIComponent('fixture-only') }@aws-1-eu-west-1.pooler.supabase.com:5432/postgres`;
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const client = (fetchFn, extra = {}) => storageClient({ url: origin, serviceKey: 'fixture_' + 'not-a-real-key'.repeat(4), fetchFn, ...extra });
const item = (name, size = 4) => ({ name, id: `id-${name}`, metadata: { size, mimetype: 'application/pdf' }, updated_at: '2026-01-01T00:00:00Z' });

test('project and database destinations cannot carry credentials to unapproved hosts or disable TLS', () => {
  assert.equal(projectRef(origin), ref);
  for (const url of ['http://' + ref + '.supabase.co', `${origin}/other`, `${origin}?q=value`, `${origin}#value`, `https://user:pass@${ref}.supabase.co`, 'https://evil.example']) assert.throws(() => projectRef(url));
  const env = databaseEnvironment(database(), ref, { PATH: 'example', PGSERVICE: 'malicious', PGOPTIONS: 'malicious', PRIVATE_TEST_VALUE: 'should-not-inherit' });
  assert.equal(env.PGUSER, `postgres.${ref}`);
  assert.equal(env.PGSSLMODE, 'verify-full');
  assert.equal(env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal(env.PGSERVICE, undefined); assert.equal(env.PRIVATE_TEST_VALUE, undefined);
  for (const url of [database(targetRef), database() + '?sslmode=disable', database() + '?options=unsafe', database().replace(':5432/', ':6543/'), database().replace('.pooler.supabase.com', '.evil.example')]) assert.throws(() => databaseEnvironment(url, ref));
});

test('storage inventory paginates the server and preserves every object', async () => {
  const calls = [], first = Array.from({ length: 1000 }, (_, i) => item(`file-${i}.pdf`));
  const api = client(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/bucket')) return json([{ id: 'receipts', public: false }]);
    const request = JSON.parse(options.body);
    return json(request.offset === 0 ? first : [item('last.pdf')]);
  }, { maxObjects: 2000 });
  const inventory = await api.inventory();
  assert.equal(inventory.objects.length, 1001);
  assert.equal(JSON.parse(calls[2].options.body).offset, 1000);
  assert.ok(calls.every(call => call.url.startsWith(origin + '/storage/v1/')));
  assert.ok(calls.every(call => call.options.redirect === 'error'));
  assert.match(inventory.digest, /^[a-f0-9]{64}$/);
});

test('nested folders are traversed and downloads retain expected size and immutable identity', async () => {
  const api = client(async (url, options) => {
    if (url.endsWith('/bucket')) return json([{ id: 'receipts' }]);
    if (url.includes('/object/list/')) return json(JSON.parse(options.body).prefix === '' ? [{ name: 'folder', id: null, metadata: null }] : [item('one.pdf')]);
    assert.equal(url, `${origin}/storage/v1/object/receipts/folder/one.pdf`);
    return new Response('body');
  });
  const inventory = await api.inventory();
  assert.equal(inventory.objects[0].name, 'folder/one.pdf');
  const original = await api.object(inventory.objects[0]);
  assert.equal(original.expectedSize, 4);
  const chunks = []; for await (const value of original.body) chunks.push(value);
  assert.equal(Buffer.concat(chunks).toString(), 'body');
});

test('unsafe paths, duplicate metadata, excessive objects and malformed quotas stop inventory', async () => {
  for (const response of [[item('../escape')], [item('a\\b')], [item('same'), item('same')], [item('too-big', -1)], [item('x'), item('y')]]) {
    const api = client(async url => url.endsWith('/bucket') ? json([{ id: 'receipts' }]) : json(response), { maxObjects: 1 });
    await assert.rejects(api.inventory());
  }
  for (const id of ['..', '/other', 'a\\b']) await assert.rejects(client(async () => json([{ id }])).inventory());
  for (const maxObjects of [0, NaN, 1.5, 100001]) assert.throws(() => client(() => {}, { maxObjects }));
  const api = client(async () => { throw new Error('should not contact remote'); });
  await assert.rejects(api.object({ bucket: 'receipts', name: '../escape', size: 1 }), { code: 'BACKUP_STORAGE_PATH_INVALID' });
});

test('failed and oversized remote responses have generic credential-free errors', async () => {
  const token = 'fixture-token-' + 'x'.repeat(25);
  for (const fetchFn of [async () => { throw new Error(`private server failure ${token}`); }, async () => new Response(token, { status: 403 }), async () => new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } })]) {
    await assert.rejects(authenticationConfig(ref, token, fetchFn), error => {
      assert.equal(error.message.includes(token), false);
      assert.match(error.code, /^BACKUP_SOURCE_/); return true;
    });
  }
});

test('tool subprocess errors never forward stderr or credentials and use no shell', async () => {
  const secret = 'fixture-sensitive-text'; let captured;
  const spawnFn = (executable, args, options) => {
    captured = { executable, args, options };
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.kill = () => { child.exitCode = 1; child.stdout.end(); child.emit('close', 1); };
    queueMicrotask(() => { child.stderr.end(secret); child.stdout.end(); child.exitCode = 1; child.emit('close', 1); });
    return child;
  };
  await assert.rejects(commandText('example-tool', ['--safe'], { env: { PGPASSWORD: secret }, spawnFn }), error => error.code === 'BACKUP_TOOL_FAILED' && !error.message.includes(secret));
  assert.deepEqual(captured.args, ['--safe']); assert.equal(captured.options.shell, false); assert.equal(captured.options.windowsHide, true);
});

test('recovery package needs complete configuration and explicit drift checks or the legacy quiet acknowledgement', () => {
  const good = { edgeSecrets: {}, authSmtp: {}, storageConfiguration: {}, edgeFunctions: [], verifiedAt: '2026-10-26T12:00:00Z', confirmedComplete: true, confirmedQuietCapture: true };
  assert.deepEqual(recoveryPackage(JSON.stringify(good)), good);
  const scheduled = { ...good, captureMode: 'drift-checked', confirmedQuietCapture: false };
  assert.deepEqual(recoveryPackage(JSON.stringify(scheduled)), scheduled);
  for (const patch of [{ confirmedComplete: false }, { confirmedQuietCapture: false }, { edgeSecrets: null }, { verifiedAt: 'invalid' }, { authSmtp: null }, { edgeFunctions: null }]) assert.throws(() => recoveryPackage(JSON.stringify({ ...good, ...patch })), { code: 'BACKUP_RECOVERY_CONFIGURATION_REQUIRED' });
  assert.throws(() => recoveryPackage(JSON.stringify({ ...scheduled, confirmedComplete: false })), { code: 'BACKUP_RECOVERY_CONFIGURATION_REQUIRED' });
  assert.throws(() => recoveryPackage(JSON.stringify({ ...good, captureMode: 'skip-checks' })), { code: 'BACKUP_RECOVERY_CONFIGURATION_REQUIRED' });
});

test('source capture includes real database, roles, portable Vault values and all configuration components', async () => {
  const calls = [], inventory = { buckets: [], objects: [] };
  const command = (name, args, options) => { calls.push({ name, args, options }); return { body: (async function* () { yield Buffer.from('fixture'); })() }; };
  const captured = [];
  const revision = 'a'.repeat(40);
  for await (const entry of sourceEntries({ databaseEnv: { PGPASSWORD: 'fixture-only' }, repositoryRoot: '.', revision, storage: {}, inventory, authConfig: {}, recovery: {}, command })) captured.push(entry);
  assert.deepEqual(captured.map(entry => entry.name), ['database.dump', 'database-roles.sql', 'configuration/vault-secrets.json', 'source.tar', 'configuration/auth.json', 'configuration/recovery.json', 'storage/buckets.json', 'storage/inventory.json']);
  assert.match(calls[2].args.at(-1), /vault\.decrypted_secrets/);
  assert.ok(calls.every(call => !call.args.some(arg => arg.includes('fixture-only'))));
  assert.equal(calls[3].args.at(-1), revision);
  assert.equal(captured[3].metadata.revision, revision);
});

test('fingerprints return hashes only and quote table identifiers on the database server', async () => {
  let captured;
  const digest = 'a'.repeat(64);
  assert.equal(await databaseFingerprint({ PGOPTIONS: '-c default_transaction_read_only=on' }, { command: async (tool, args, options) => { captured = { tool, args, options }; return digest; } }), digest);
  assert.equal(captured.args.at(-1), SNAPSHOT_FINGERPRINT_SQL);
  assert.match(SNAPSHOT_FINGERPRINT_SQL, /%I\.%I/);
  assert.match(SNAPSHOT_FINGERPRINT_SQL, /pg_catalog\.sha256/);
  assert.doesNotMatch(SNAPSHOT_FINGERPRINT_SQL, /INSERT|UPDATE|DELETE|CREATE|DROP/);
  assert.equal(configurationFingerprint({ z: 1, a: { two: 2, one: 1 } }), configurationFingerprint({ a: { one: 1, two: 2 }, z: 1 }));
  assert.notEqual(configurationFingerprint({ z: 1 }), configurationFingerprint({ z: 2 }));
  await assert.rejects(databaseFingerprint({}, { command: async () => 'private database contents' }), { code: 'BACKUP_DATABASE_FINGERPRINT_INVALID' });
});

test('changes in Storage, Auth configuration or database each prevent publishing a capture', async () => {
  const baseline = {
    storage: { inventory: async () => ({ digest: 'stable-storage' }) }, inventoryDigest: 'stable-storage',
    readAuth: async () => ({ fixed: true }), authDigest: configurationFingerprint({ fixed: true }),
    readDatabase: async () => 'stable-database', databaseDigest: 'stable-database',
  };
  await assertCaptureStable(baseline);
  await assert.rejects(assertCaptureStable({ ...baseline, storage: { inventory: async () => ({ digest: 'changed' }) } }), { code: 'BACKUP_STORAGE_CHANGED_DURING_CAPTURE' });
  await assert.rejects(assertCaptureStable({ ...baseline, readAuth: async () => ({ fixed: false }) }), { code: 'BACKUP_AUTH_CHANGED_DURING_CAPTURE' });
  await assert.rejects(assertCaptureStable({ ...baseline, readDatabase: async () => 'changed' }), { code: 'BACKUP_DATABASE_CHANGED_DURING_CAPTURE' });
});

test('PostgreSQL fingerprint SQL detects changed rows and emits no row values, including quoted identifiers', async () => {
  const db = new PGlite();
  try {
    await db.exec(`create schema vault; create schema ignored; create table public."odd""name"(id integer, note text); create table vault.fixture(id integer, secret text); create table ignored.unrelated(id integer);
      insert into public."odd""name" values(1,'private fixture note'); insert into vault.fixture values(1,'private fixture value');`);
    const fingerprint = async () => (await db.query(SNAPSHOT_FINGERPRINT_SQL)).rows[0].encode;
    const first = await fingerprint(); assert.match(first, /^[a-f0-9]{64}$/);
    await db.exec('insert into ignored.unrelated values(1)'); assert.equal(await fingerprint(), first);
    await db.exec(`update vault.fixture set secret='different private fixture value'`);
    assert.notEqual(await fingerprint(), first);
    const result = JSON.stringify((await db.query(SNAPSHOT_FINGERPRINT_SQL)).rows);
    assert.equal(result.includes('private'), false);
  } finally { await db.close(); }
});

test('restore only prepares a plan for a different explicitly isolated project and rejects production', () => {
  const manifest = { source: { projectRef: ref }, entryCount: 8, bytes: 100 };
  const args = { manifest, targetUrl: `https://${targetRef}.supabase.co`, targetDatabaseUrl: database(targetRef), acknowledgeIsolation: `ISOLATED:${targetRef}` };
  const plan = restorePlan(args);
  assert.equal(plan.mode, 'plan-only'); assert.equal(plan.mutationsPerformed, false);
  assert.throws(() => restorePlan({ ...args, acknowledgeIsolation: '' }), { code: 'RESTORE_ISOLATION_ACK_REQUIRED' });
  for (const forbidden of [ref, PRODUCTION_PROJECT_REF]) assert.throws(() => restorePlan({ ...args, targetUrl: `https://${forbidden}.supabase.co` }), { code: 'RESTORE_PRODUCTION_TARGET_FORBIDDEN' });
});
