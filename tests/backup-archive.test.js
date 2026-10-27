import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { readKey, writeArchive, verifyArchive, bufferEntry, assertPrivateDestination, assertRecoveryContents, extractArchive } from '../scripts/backup/archive.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'orquivia-backup-test-'));
  t.after(async () => {
    assert.ok(root.startsWith(join(tmpdir(), 'orquivia-backup-test-')));
    await rm(root, { recursive: true, force: true });
  });
  return { root, file: join(root, 'sample.orqbackup'), key: randomBytes(32) };
}
const source = { projectRef: 'abcdefghijklmnopqrst', commit: 'a'.repeat(40), storageObjects: 0 };
const entries = () => [bufferEntry('notes/private.txt', 'An original private document'), bufferEntry('empty', Buffer.alloc(0))];
function seal(records, key) {
  const header = Buffer.concat([Buffer.from('ORQBK001'), randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(8));
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(records.map(record => JSON.stringify(record)).join('\n') + '\n'), cipher.final(), cipher.getAuthTag()]);
}

test('backup is encrypted, authenticated, hash-verified and preserves empty originals', async t => {
  const f = await fixture(t);
  const written = await writeArchive({ output: f.file, key: f.key, source, entries: entries() });
  const bytes = await readFile(f.file);
  assert.equal(bytes.includes(Buffer.from('An original private document')), false);
  assert.equal(bytes.includes(Buffer.from('notes/private.txt')), false);
  assert.equal(bytes.includes(Buffer.from(source.projectRef)), false);
  const verified = await verifyArchive({ file: f.file, key: f.key });
  assert.deepEqual(verified.entries, written.entries);
  assert.equal(verified.bytes, Buffer.byteLength('An original private document'));
  assert.equal(verified.entries[1].size, 0);
});

test('wrong key, modified header, ciphertext, authentication tag and truncation all fail', async t => {
  const f = await fixture(t);
  await writeArchive({ output: f.file, key: f.key, source, entries: entries() });
  await assert.rejects(verifyArchive({ file: f.file, key: randomBytes(32) }));
  const original = await readFile(f.file);
  const variants = [original.subarray(0, original.length - 1), original.subarray(0, 20)];
  for (const offset of [0, 8, 24, original.length - 1]) {
    const mutated = Buffer.from(original); mutated[offset] ^= 1; variants.push(mutated);
  }
  for (let index = 0; index < variants.length; index++) {
    const file = join(f.root, `bad-${index}`); await writeFile(file, variants[index]);
    await assert.rejects(verifyArchive({ file, key: f.key }));
  }
});

test('a failed source leaves neither a final archive nor a partial backup', async t => {
  const f = await fixture(t);
  async function* originals() {
    yield bufferEntry('first', 'ok');
    yield { name: 'second', body: (async function* () { yield Buffer.from('partial'); throw new Error('private failure'); })() };
  }
  await assert.rejects(writeArchive({ output: f.file, key: f.key, source, entries: originals() }));
  assert.deepEqual(await readdir(f.root), []);
});

test('oversized capture, changed source size, duplicate and unsafe names fail closed', async t => {
  const f = await fixture(t);
  const cases = [
    { entries: [bufferEntry('file', 'too long')], limits: { bytes: 2 } },
    { entries: [{ ...bufferEntry('file', 'body'), expectedSize: 9 }] },
    { entries: [bufferEntry('same', 'a'), bufferEntry('same', 'b')] },
    ...['../escape', 'a/../b', '/absolute', 'a\\b', 'a//b', 'a/./b'].map(name => ({ entries: [bufferEntry(name, 'x')] })),
  ];
  for (const options of cases) {
    await assert.rejects(writeArchive({ output: f.file, key: f.key, source, ...options }));
    assert.deepEqual(await readdir(f.root), []);
  }
});

test('existing archives are never overwritten and failed stability checks publish nothing', async t => {
  const f = await fixture(t);
  await writeFile(f.file, 'existing content');
  await assert.rejects(writeArchive({ output: f.file, key: f.key, source, entries: entries() }));
  assert.equal(await readFile(f.file, 'utf8'), 'existing content');
  const next = join(f.root, 'next.orqbackup');
  await assert.rejects(writeArchive({ output: next, key: f.key, source, entries: entries(), beforeManifest() { throw new Error('changed'); } }));
  assert.deepEqual(await readdir(f.root), ['sample.orqbackup']);
  await assert.rejects(writeArchive({ output: next, key: f.key, source, entries: entries(), validateManifest: assertRecoveryContents }), { code: 'BACKUP_RECOVERY_ENTRY_MISSING' });
  assert.deepEqual(await readdir(f.root), ['sample.orqbackup']);
});

test('authenticated content still rejects missing manifest, wrong entry hash and invalid dump format', async t => {
  const f = await fixture(t);
  const variants = [
    [{ type: 'header', version: 1, source }],
    [{ type: 'header', version: 1, source }, { type: 'entry', name: 'file', metadata: {} }, { type: 'chunk', data: Buffer.from('x').toString('base64') }, { type: 'end', size: 1, sha256: '0'.repeat(64) }],
  ];
  for (let i = 0; i < variants.length; i++) {
    const file = join(f.root, `signed-bad-${i}`); await writeFile(file, seal(variants[i], f.key));
    await assert.rejects(verifyArchive({ file, key: f.key }));
  }
  await assert.rejects(writeArchive({ output: f.file, key: f.key, source, entries: [bufferEntry('database.dump', 'not a PostgreSQL dump')] }), { code: 'BACKUP_DATABASE_FORMAT_INVALID' });
});

test('destination must be outside repository, including an inside directory beginning with dots', async t => {
  const f = await fixture(t), repo = join(f.root, 'repository'); await mkdir(repo);
  for (const destination of [repo, join(repo, 'backups'), join(repo, '..private')]) {
    await assert.rejects(assertPrivateDestination(destination, repo), { code: 'BACKUP_DESTINATION_INSIDE_REPOSITORY' });
  }
  await assert.rejects(assertPrivateDestination('relative/path', repo), { code: 'BACKUP_DESTINATION_MUST_BE_ABSOLUTE' });
  assert.equal(await assertPrivateDestination(join(f.root, 'private-backups'), repo), resolve(f.root, 'private-backups'));
});

test('recovery completeness checks every required component and exact original size/path', () => {
  const required = ['database.dump', 'database-roles.sql', 'source.tar', 'configuration/auth.json', 'configuration/vault-secrets.json', 'configuration/recovery.json', 'storage/buckets.json', 'storage/inventory.json'];
  const complete = { source, entries: required.map(name => ({ name, size: 10, metadata: {} })) };
  assert.equal(assertRecoveryContents(complete), true);
  assert.throws(() => assertRecoveryContents({ ...complete, entries: complete.entries.slice(1) }), { code: 'BACKUP_RECOVERY_ENTRY_MISSING' });
  const original = { name: 'storage/objects/receipts/one.pdf', size: 4, metadata: { kind: 'storage-object', bucket: 'receipts', name: 'one.pdf', size: 4 } };
  const withOriginal = { source: { ...source, storageObjects: 1 }, entries: [...complete.entries, original] };
  assert.equal(assertRecoveryContents(withOriginal), true);
  assert.throws(() => assertRecoveryContents({ ...withOriginal, source }), { code: 'BACKUP_STORAGE_INCOMPLETE' });
  assert.throws(() => assertRecoveryContents({ ...withOriginal, entries: [...complete.entries, { ...original, size: 5 }] }), { code: 'BACKUP_STORAGE_INCOMPLETE' });
});

test('keys must be canonical base64 for exactly 256 bits', () => {
  const key = randomBytes(32); assert.deepEqual(readKey(key.toString('base64')), key);
  for (const value of ['', 'example', randomBytes(31).toString('base64'), key.toString('base64') + '\n']) assert.throws(() => readKey(value), { code: 'BACKUP_KEY_INVALID' });
});

test('offline extraction authenticates first, verifies originals and refuses existing destinations', async t => {
  const f = await fixture(t), repo = join(f.root, 'repository'); await mkdir(repo);
  const required = ['database-roles.sql', 'source.tar', 'configuration/auth.json', 'configuration/vault-secrets.json', 'configuration/recovery.json', 'storage/buckets.json', 'storage/inventory.json'];
  const original = bufferEntry('storage/objects/receipts/photo.jpg', 'photograph', { kind: 'storage-object', bucket: 'receipts', name: 'photo.jpg', size: 10 });
  await writeArchive({ output: f.file, key: f.key, source: { ...source, storageObjects: 1 }, entries: [bufferEntry('database.dump', 'PGDMPfixture'), ...required.map(name => bufferEntry(name, '{}')), original] });
  const directory = join(f.root, 'isolated-recovery');
  const result = await extractArchive({ file: f.file, key: f.key, directory, repositoryRoot: repo });
  assert.equal(result.databaseRestored, false); assert.equal(result.recoveryTested, false);
  assert.equal(await readFile(join(directory, 'storage/objects/receipts/photo.jpg'), 'utf8'), 'photograph');
  const shortDirectory = join(f.root, 'short-write-recovery');
  let writeCalls = 0;
  const openFile = async (...args) => {
    const handle = await open(...args);
    return {
      write: async (bytes, offset, length, position) => { writeCalls++; return handle.write(bytes, offset, Math.min(length, 1), position); },
      sync: () => handle.sync(), close: () => handle.close(),
    };
  };
  await extractArchive({ file: f.file, key: f.key, directory: shortDirectory, repositoryRoot: repo, openFile });
  assert.ok(writeCalls > 20);
  assert.equal(await readFile(join(shortDirectory, 'storage/objects/receipts/photo.jpg'), 'utf8'), 'photograph');
  await assert.rejects(extractArchive({ file: f.file, key: f.key, directory, repositoryRoot: repo }), { code: 'BACKUP_EXTRACTION_DESTINATION_EXISTS' });
  const bytes = await readFile(f.file); bytes[35] ^= 1; await writeFile(f.file, bytes);
  const badDirectory = join(f.root, 'must-not-exist');
  await assert.rejects(extractArchive({ file: f.file, key: f.key, directory: badDirectory, repositoryRoot: repo }));
  assert.equal((await readdir(f.root)).includes('must-not-exist'), false);
});
