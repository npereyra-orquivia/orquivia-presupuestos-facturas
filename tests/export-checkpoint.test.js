import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { bufferEntry, writeArchive, verifyArchive, extractArchive } from '../scripts/backup/archive.mjs';
import { CHECKPOINT_SCOPE, CHECKPOINT_RELEASE, CHECKPOINT_COMMIT, CHECKPOINT_PATHS, assertCheckpointContents, main } from '../scripts/backup/export-checkpoint.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = { scope: CHECKPOINT_SCOPE, release: CHECKPOINT_RELEASE, commit: CHECKPOINT_COMMIT };
const scope = { scope: CHECKPOINT_SCOPE, release: CHECKPOINT_RELEASE, completeSystemBackup: false,
  databaseRestored: false, accountsIncluded: false, profilesIncluded: false, mailboxSecretsIncluded: false };
function originals(scopeOverrides = {}) {
  return new Map([
    ['LEEME.json', Buffer.from(JSON.stringify({ ...scope, ...scopeOverrides }))],
    ['export/empresa.json', Buffer.from('{"version":1,"exportedAt":"2026-10-26","state":{"fixture":true}}')],
    ['export/historico.zip', Buffer.from('Fixture bytes only: not an actual ZIP')],
    ['source/orquivia-v1.4.1.bundle', Buffer.from('Fixture bytes only: not an actual Git bundle')],
  ]);
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'orquivia-checkpoint-test-'));
  t.after(async () => {
    assert.ok(directory.startsWith(join(tmpdir(), 'orquivia-checkpoint-test-')));
    await rm(directory, { recursive: true, force: true });
  });
  const key = randomBytes(32), file = join(directory, 'fixture.orqbackup'), repo = join(directory, 'tools');
  await mkdir(repo);
  const contents = options.contents || originals(options.scopeOverrides);
  await writeArchive({ output: file, key, source: options.source || source,
    entries: [...contents].map(([name, value]) => bufferEntry(name, value)) });
  return { directory, repo, key, file, contents, env: { ORQUIVIA_BACKUP_KEY: key.toString('base64') } };
}

test('operational verification reports its exact historical scope and never a system recovery', async t => {
  const f = await fixture(t), before = await readdir(f.directory);
  const result = await main(['verify', '--file', f.file], f.env);
  assert.equal(result.status, 'checkpoint-authenticated-and-verified');
  assert.equal(result.scope, CHECKPOINT_SCOPE); assert.equal(result.release, '1.4.1');
  assert.equal(result.sourceCommit, CHECKPOINT_COMMIT); assert.equal(result.entries, 4);
  assert.equal(result.completeSystemBackup, false); assert.equal(result.recoveryTested, false); assert.equal(result.databaseRestored, false);
  assert.deepEqual(await readdir(f.directory), before);
});

test('scope validator requires exactly four paths and the stable release, commit and source scope', async t => {
  const f = await fixture(t), manifest = await verifyArchive({ file: f.file, key: f.key });
  assert.equal(assertCheckpointContents(manifest), true);
  for (const changed of [{ scope: 'complete-system' }, { release: '1.5.0' }, { commit: 'a'.repeat(40) }]) {
    assert.throws(() => assertCheckpointContents({ ...manifest, source: { ...source, ...changed } }), { code: 'CHECKPOINT_SOURCE_INVALID' });
  }
  const variants = [manifest.entries.slice(1), [...manifest.entries, { name: 'extra.txt', size: 1 }],
    manifest.entries.map((item, index) => index === 1 ? manifest.entries[0] : item),
    manifest.entries.map((item, index) => index === 1 ? { ...item, name: 'export/other.json' } : item),
    manifest.entries.map((item, index) => index === 1 ? { ...item, size: 0 } : item),
    manifest.entries.map(item => item.name === 'LEEME.json' ? { ...item, size: 65537 } : item)];
  for (const entries of variants) assert.throws(() => assertCheckpointContents({ ...manifest, entries }));
  assert.throws(() => assertCheckpointContents({ ...manifest, entryCount: 3 }), { code: 'CHECKPOINT_CONTENTS_INVALID' });
});

test('authenticated but mismatching scope JSON is rejected before creating any extraction directory', async t => {
  for (const scopeOverrides of [{ completeSystemBackup: true }, { accountsIncluded: true }, { profilesIncluded: true },
    { mailboxSecretsIncluded: true }, { databaseRestored: true }, { release: '1.5.0' }, { scope: 'other' }]) {
    const f = await fixture(t, { scopeOverrides }), destination = join(f.directory, 'must-not-exist');
    await assert.rejects(main(['extract', '--file', f.file, '--output-dir', destination], f.env, { repositoryRoot: f.repo }), { code: 'CHECKPOINT_SCOPE_FILE_INVALID' });
    assert.equal((await readdir(f.directory)).includes('must-not-exist'), false);
  }
  const malformed = originals(); malformed.set('LEEME.json', Buffer.from('not JSON'));
  const f = await fixture(t, { contents: malformed });
  await assert.rejects(main(['verify', '--file', f.file], f.env), { code: 'CHECKPOINT_SCOPE_FILE_INVALID' });
});

test('default full-backup extraction continues to reject the partial operational checkpoint', async t => {
  const f = await fixture(t);
  await assert.rejects(extractArchive({ file: f.file, key: f.key, directory: join(f.directory, 'no-system-restore'), repositoryRoot: f.repo }), { code: 'BACKUP_RECOVERY_ENTRY_MISSING' });
  assert.deepEqual((await readdir(f.directory)).sort(), ['fixture.orqbackup', 'tools']);
});

test('offline extraction publishes only the four exact verified originals into a new outside directory', async t => {
  const f = await fixture(t), destination = join(f.directory, 'isolated');
  const result = await main(['extract', '--file', f.file, '--output-dir', destination], f.env, { repositoryRoot: f.repo });
  assert.equal(result.status, 'checkpoint-extracted-and-verified'); assert.equal(result.directory, destination);
  assert.equal(result.databaseRestored, false); assert.equal(result.recoveryTested, false);
  assert.deepEqual((await readdir(destination)).sort(), ['LEEME.json', 'export', 'source']);
  for (const [name, value] of f.contents) assert.deepEqual(await readFile(join(destination, ...name.split('/'))), value);
  await assert.rejects(main(['extract', '--file', f.file, '--output-dir', destination], f.env, { repositoryRoot: f.repo }), { code: 'BACKUP_EXTRACTION_DESTINATION_EXISTS' });
  const inside = join(f.repo, 'no-plaintext-here');
  await assert.rejects(main(['extract', '--file', f.file, '--output-dir', inside], f.env, { repositoryRoot: f.repo }), { code: 'BACKUP_DESTINATION_INSIDE_REPOSITORY' });
  assert.equal((await readdir(f.repo)).includes('no-plaintext-here'), false);
  await assert.rejects(main(['extract', '--file', f.file, '--output-dir', 'relative'], f.env, { repositoryRoot: f.repo }), { code: 'BACKUP_DESTINATION_MUST_BE_ABSOLUTE' });
});

test('wrong key, tampering and truncation fail before any plaintext destination is published', async t => {
  const f = await fixture(t), bytes = await readFile(f.file);
  await assert.rejects(main(['verify', '--file', f.file], { ORQUIVIA_BACKUP_KEY: randomBytes(32).toString('base64') }));
  const modified = Buffer.from(bytes); modified[30] ^= 1;
  for (const [index, body] of [modified, bytes.subarray(0, bytes.length - 1)].entries()) {
    const file = join(f.directory, `broken-${index}.orqbackup`), destination = join(f.directory, `no-plaintext-${index}`);
    await writeFile(file, body);
    await assert.rejects(main(['extract', '--file', file, '--output-dir', destination], f.env, { repositoryRoot: f.repo }));
    assert.equal((await readdir(f.directory)).some(name => name.startsWith(`no-plaintext-${index}`)), false);
  }
});

test('key files accept only a bounded canonical key with optional one final newline', async t => {
  const f = await fixture(t), keyFile = join(f.directory, 'private-key.txt');
  for (const end of ['', '\n', '\r\n']) {
    await writeFile(keyFile, f.env.ORQUIVIA_BACKUP_KEY + end, { mode: 0o600 });
    const result = await main(['verify', '--file', f.file, '--key-file', keyFile], {});
    assert.equal(result.entries, 4);
  }
  await assert.rejects(main(['verify', '--file', f.file, '--key-file', keyFile], f.env), { code: 'CHECKPOINT_KEY_SOURCE_AMBIGUOUS' });
  for (const value of ['private text', f.env.ORQUIVIA_BACKUP_KEY + '\n\n', ' ' + f.env.ORQUIVIA_BACKUP_KEY,
    '\ufeff' + f.env.ORQUIVIA_BACKUP_KEY, 'x'.repeat(10000)]) {
    await writeFile(keyFile, value);
    await assert.rejects(main(['verify', '--file', f.file, '--key-file', keyFile], {}), { code: 'CHECKPOINT_KEY_FILE_INVALID' });
  }
  await assert.rejects(main(['verify', '--file', f.file, '--key-file', f.directory], {}), { code: 'CHECKPOINT_KEY_FILE_INVALID' });
});

test('archive and key-file symlinks are rejected where platform permits creating them', async t => {
  const f = await fixture(t), keyFile = join(f.directory, 'private-key.txt');
  await writeFile(keyFile, f.env.ORQUIVIA_BACKUP_KEY);
  const archiveLink = join(f.directory, 'archive-link'), keyLink = join(f.directory, 'key-link');
  try { await symlink(f.file, archiveLink, 'file'); await symlink(keyFile, keyLink, 'file'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) { t.skip('Platform does not grant symlink creation'); return; } throw error; }
  await assert.rejects(main(['verify', '--file', archiveLink], f.env), { code: 'CHECKPOINT_LOCAL_FILE_REQUIRED' });
  await assert.rejects(main(['verify', '--file', f.file, '--key-file', keyLink], {}), { code: 'CHECKPOINT_KEY_FILE_INVALID' });
});

test('CLI rejects unsupported arguments, URLs and unwanted verify destinations', async t => {
  const f = await fixture(t);
  for (const argv of [[], ['create'], ['verify'], ['extract', '--file', f.file],
    ['verify', '--file', f.file, '--key', 'SECRET-DO-NOT-PRINT'],
    ['verify', '--file', f.file, '--file', f.file], ['verify', '--file', f.file, '--unknown', 'x'],
    ['verify', '--file', f.file, '--output-dir', f.directory]]) {
    await assert.rejects(main(argv, f.env), { code: 'CHECKPOINT_ARGUMENT_INVALID' });
  }
  for (const path of ['https://example.invalid/backup', 'file:///tmp/backup', '//server/share/backup', '\\\\server\\share\\backup', '\\\\?\\C:\\backup', 'C:\\archive.orqbackup:stream']) {
    await assert.rejects(main(['verify', '--file', path], f.env), { code: 'CHECKPOINT_LOCAL_FILE_REQUIRED' });
  }
  await assert.rejects(main(['extract', '--file', f.file, '--output-dir', '//server/share/recovery'], f.env), { code: 'CHECKPOINT_LOCAL_FILE_REQUIRED' });
  const result = spawnSync(process.execPath, [join(root, 'scripts/backup/export-checkpoint.mjs'), 'verify', '--file', f.file, '--key', f.env.ORQUIVIA_BACKUP_KEY], { encoding: 'utf8', env: { ...process.env, ORQUIVIA_BACKUP_KEY: undefined } });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  assert.equal(JSON.parse(result.stderr).code, 'CHECKPOINT_ARGUMENT_INVALID');
  assert.equal(result.stderr.includes(f.env.ORQUIVIA_BACKUP_KEY), false); assert.equal(result.stderr.includes(f.file), false);
});

test('bootstrap runs from two copied builtin-only modules without GitHub, npm, application or SQL tools', async t => {
  const f = await fixture(t), tools = join(f.repo, 'scripts/backup'); await mkdir(tools, { recursive: true });
  for (const name of ['archive.mjs', 'export-checkpoint.mjs']) await copyFile(join(root, 'scripts/backup', name), join(tools, name));
  const keyFile = join(f.directory, 'private-key.txt'); await writeFile(keyFile, f.env.ORQUIVIA_BACKUP_KEY, { mode: 0o600 });
  const destination = join(f.directory, 'recovered');
  const result = spawnSync(process.execPath, [join(tools, 'export-checkpoint.mjs'), 'extract', '--file', f.file, '--key-file', keyFile, '--output-dir', destination], {
    cwd: f.repo, encoding: 'utf8', env: { ...process.env, ORQUIVIA_BACKUP_KEY: undefined, PATH: '' },
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.entries, CHECKPOINT_PATHS.length); assert.equal(summary.databaseRestored, false); assert.equal(summary.recoveryTested, false);
  for (const [name, value] of f.contents) assert.deepEqual(await readFile(join(destination, ...name.split('/'))), value);
});
