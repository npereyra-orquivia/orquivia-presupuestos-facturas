import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat, rename, rm, mkdir, realpath, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// The format contains encrypted JSON-lines records, including the manifest.
// Neither original names nor project configuration are left in the clear.
const MAGIC = Buffer.from('ORQBK001');
const HEADER_BYTES = MAGIC.length + 12;
const TAG_BYTES = 16;
const CHUNK_BYTES = 48 * 1024;
const MAX_LINE_BYTES = 96 * 1024;
export const DEFAULT_LIMITS = Object.freeze({ entries: 100000, bytes: 20_000_000_000, entryBytes: 2_000_000_000 });
const fail = (code) => Object.assign(new Error(code), { code });

export function readKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw fail('BACKUP_KEY_INVALID');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw fail('BACKUP_KEY_INVALID');
  return key;
}

function limitsWith(values = {}) {
  const limits = { ...DEFAULT_LIMITS, ...values };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw fail('BACKUP_LIMIT_INVALID');
  return limits;
}

function checkName(name) {
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 4096 || /[\\\x00-\x1f]/.test(name)
    || name.startsWith('/') || name.split('/').some(piece => !piece || piece === '.' || piece === '..')) throw fail('BACKUP_ENTRY_INVALID');
}

const line = (record) => {
  const encoded = Buffer.from(`${JSON.stringify(record)}\n`);
  if (encoded.length > MAX_LINE_BYTES) throw fail('BACKUP_METADATA_TOO_LARGE');
  return encoded;
};

function hashEntries(entries) { return createHash('sha256').update(JSON.stringify(entries)).digest('hex'); }
function checkHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function sameHash(a, b) { return checkHash(a) && checkHash(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }

export async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > bytes.length - offset) throw fail('BACKUP_WRITE_FAILED');
    offset += result.bytesWritten;
  }
}

export async function assertPrivateDestination(directory, repositoryRoot) {
  if (!isAbsolute(directory)) throw fail('BACKUP_DESTINATION_MUST_BE_ABSOLUTE');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = await realpath(directory), root = await realpath(repositoryRoot);
  const rel = relative(root, destination);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) throw fail('BACKUP_DESTINATION_INSIDE_REPOSITORY');
  return destination;
}

/** Entries are an async iterable of {name, metadata, body: AsyncIterable<Uint8Array>}. */
export async function writeArchive({ output, key, entries, source, limits: requestedLimits, beforeManifest, validateManifest }) {
  const limits = limitsWith(requestedLimits);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('BACKUP_KEY_INVALID');
  const finalPath = resolve(output), temporary = `${finalPath}.${randomBytes(8).toString('hex')}.partial`;
  const header = Buffer.concat([MAGIC, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  cipher.setAAD(header);
  const completed = [], names = new Set();
  let total = 0, result;
  async function* records() {
    yield line({ type: 'header', version: 1, source, createdAt: new Date().toISOString() });
    for await (const entry of entries) {
      checkName(entry.name);
      if (names.has(entry.name) || names.size >= limits.entries) throw fail('BACKUP_ENTRY_DUPLICATE_OR_LIMIT');
      names.add(entry.name);
      yield line({ type: 'entry', name: entry.name, metadata: entry.metadata || {} });
      const hash = createHash('sha256'); let size = 0;
      for await (const value of entry.body) {
        const data = Buffer.from(value);
        for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
          const chunk = data.subarray(offset, offset + CHUNK_BYTES);
          size += chunk.length; total += chunk.length;
          if (size > limits.entryBytes || total > limits.bytes) throw fail('BACKUP_BYTE_LIMIT');
          hash.update(chunk);
          yield line({ type: 'chunk', data: chunk.toString('base64') });
        }
      }
      const digest = hash.digest('hex');
      if (entry.expectedSize !== undefined && size !== entry.expectedSize) throw fail('BACKUP_SOURCE_SIZE_CHANGED');
      const item = { name: entry.name, size, sha256: digest, metadata: entry.metadata || {} };
      completed.push(item);
      yield line({ type: 'end', size, sha256: digest });
    }
    if (beforeManifest) await beforeManifest();
    const footer = { version: 1, source, bytes: total, entryCount: completed.length, sha256: hashEntries(completed) };
    result = { ...footer, entries: completed };
    yield line({ type: 'manifest', ...footer });
  }
  await mkdir(dirname(finalPath), { recursive: true, mode: 0o700 });
  try {
    // wx refuses to replace even a stale partial file; final files are never overwritten.
    const handle = await open(temporary, 'wx', 0o600);
    try { await writeAll(handle, header); } finally { await handle.close(); }
    await pipeline(Readable.from(records()), cipher, createWriteStream(temporary, { flags: 'a', mode: 0o600 }));
    const tagHandle = await open(temporary, 'a');
    try { await writeAll(tagHandle, cipher.getAuthTag()); await tagHandle.sync(); } finally { await tagHandle.close(); }
    const verified = await verifyArchive({ file: temporary, key, limits });
    if (validateManifest) await validateManifest(verified);
    // link-like no-clobber: reserve the final name first, then replace only our empty reservation.
    const reservation = await open(finalPath, 'wx', 0o600); await reservation.close();
    try { await rename(temporary, finalPath); } catch (error) { await rm(finalPath, { force: true }); throw error; }
    return result;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function* decryptedRecords({ file, key, limits: requestedLimits }) {
  const limits = limitsWith(requestedLimits);
  if (!Buffer.isBuffer(key) || key.length !== 32) throw fail('BACKUP_KEY_INVALID');
  const info = await stat(file);
  if (!info.isFile() || info.size < HEADER_BYTES + TAG_BYTES + 1 || info.size > limits.bytes * 2 + limits.entries * MAX_LINE_BYTES) throw fail('BACKUP_FILE_INVALID');
  const handle = await open(file, 'r');
  const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(TAG_BYTES);
  try { await handle.read(header, 0, HEADER_BYTES, 0); await handle.read(tag, 0, TAG_BYTES, info.size - TAG_BYTES); } finally { await handle.close(); }
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('BACKUP_FORMAT_INVALID');
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(MAGIC.length));
  decipher.setAAD(header); decipher.setAuthTag(tag);
  const input = createReadStream(file, { start: HEADER_BYTES, end: info.size - TAG_BYTES - 1 });
  // The consumer must finish this iterator: authentication is checked only at its end.
  const decrypted = input.pipe(decipher);
  input.on('error', error => decipher.destroy(error));
  let pending = Buffer.alloc(0);
  try {
    for await (const data of decrypted) {
      pending = Buffer.concat([pending, data]);
      let newline;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline > MAX_LINE_BYTES) throw fail('BACKUP_RECORD_TOO_LARGE');
        const raw = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        let value; try { value = JSON.parse(raw.toString('utf8')); } catch { throw fail('BACKUP_RECORD_INVALID'); }
        yield value;
      }
      if (pending.length > MAX_LINE_BYTES) throw fail('BACKUP_RECORD_TOO_LARGE');
    }
    if (pending.length) throw fail('BACKUP_TRUNCATED');
  } catch (error) {
    if (error.code?.startsWith('BACKUP_')) throw error;
    throw fail('BACKUP_AUTHENTICATION_OR_READ_FAILED');
  } finally { input.destroy(); decipher.destroy(); }
}

export async function verifyArchive({ file, key, limits: requestedLimits }) {
  const limits = limitsWith(requestedLimits), completed = [], names = new Set();
  let header, manifest, current, total = 0;
  for await (const record of decryptedRecords({ file, key, limits })) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || manifest) throw fail('BACKUP_SEQUENCE_INVALID');
    if (!header) {
      if (record.type !== 'header' || record.version !== 1 || !record.source || typeof record.source !== 'object') throw fail('BACKUP_HEADER_INVALID');
      header = record; continue;
    }
    if (record.type === 'entry') {
      if (current || names.size >= limits.entries) throw fail('BACKUP_SEQUENCE_INVALID');
      checkName(record.name);
      if (names.has(record.name)) throw fail('BACKUP_ENTRY_DUPLICATE_OR_LIMIT');
      if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) throw fail('BACKUP_ENTRY_INVALID');
      names.add(record.name); current = { name: record.name, metadata: record.metadata, hash: createHash('sha256'), size: 0, prefix: Buffer.alloc(0) };
    } else if (record.type === 'chunk') {
      if (!current || typeof record.data !== 'string' || !record.data || record.data.length > CHUNK_BYTES * 4 / 3
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.data)) throw fail('BACKUP_CHUNK_INVALID');
      const chunk = Buffer.from(record.data, 'base64');
      if (chunk.toString('base64') !== record.data) throw fail('BACKUP_CHUNK_INVALID');
      current.size += chunk.length; total += chunk.length;
      if (current.size > limits.entryBytes || total > limits.bytes) throw fail('BACKUP_BYTE_LIMIT');
      current.hash.update(chunk);
      if (current.prefix.length < 5) current.prefix = Buffer.concat([current.prefix, chunk]).subarray(0, 5);
    } else if (record.type === 'end') {
      if (!current || record.size !== current.size || !sameHash(record.sha256, current.hash.digest('hex'))) throw fail('BACKUP_ENTRY_HASH_MISMATCH');
      if (current.name === 'database.dump' && !current.prefix.equals(Buffer.from('PGDMP'))) throw fail('BACKUP_DATABASE_FORMAT_INVALID');
      completed.push({ name: current.name, size: current.size, sha256: record.sha256, metadata: current.metadata }); current = null;
    } else if (record.type === 'manifest') {
      if (current || record.version !== 1 || record.bytes !== total || record.entryCount !== completed.length
        || !sameHash(record.sha256, hashEntries(completed))
        || JSON.stringify(record.source) !== JSON.stringify(header.source)) throw fail('BACKUP_MANIFEST_MISMATCH');
      manifest = record;
    } else throw fail('BACKUP_SEQUENCE_INVALID');
  }
  if (!manifest || current) throw fail('BACKUP_INCOMPLETE');
  return { ...manifest, entries: completed, createdAt: header.createdAt };
}

export function bufferEntry(name, value, metadata = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
  return { name, metadata, expectedSize: bytes.length, body: Readable.from([bytes]) };
}

/** Explicit offline recovery export only. It never executes SQL or contacts a service. */
export async function extractArchive({ file, key, directory, repositoryRoot, limits, openFile = open, validateManifest = assertRecoveryContents }) {
  const manifest = await verifyArchive({ file, key, limits });
  await validateManifest(manifest);
  if (!isAbsolute(directory)) throw fail('BACKUP_DESTINATION_MUST_BE_ABSOLUTE');
  const destination = resolve(directory);
  const parent = await assertPrivateDestination(dirname(destination), repositoryRoot);
  if (resolve(parent, destination.slice(dirname(destination).length + 1)) !== destination) throw fail('BACKUP_EXTRACTION_DESTINATION_INVALID');
  try { await lstat(destination); throw fail('BACKUP_EXTRACTION_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = new Map(manifest.entries.map(entry => [entry.name, entry]));
  const completed = new Set(); let current;
  const workingDirectory = `${destination}.${randomBytes(8).toString('hex')}.partial`;
  await mkdir(workingDirectory, { mode: 0o700 });
  try {
    for await (const record of decryptedRecords({ file, key, limits })) {
      if (record.type === 'entry') {
        const item = expected.get(record.name);
        if (current || !item || completed.has(record.name) || JSON.stringify(record.metadata) !== JSON.stringify(item.metadata)) throw fail('BACKUP_EXTRACTION_CHANGED');
        checkName(record.name);
        for (const piece of record.name.split('/')) {
          if (/[<>:"|?*]/.test(piece) || /[. ]$/.test(piece) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece)) throw fail('BACKUP_EXTRACTION_PATH_INVALID');
        }
        const output = resolve(workingDirectory, ...record.name.split('/'));
        const rel = relative(workingDirectory, output);
        if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw fail('BACKUP_EXTRACTION_PATH_INVALID');
        await mkdir(dirname(output), { recursive: true, mode: 0o700 });
        current = { item, output, handle: await openFile(output, 'wx', 0o600), size: 0, hash: createHash('sha256') };
      } else if (record.type === 'chunk') {
        if (!current) throw fail('BACKUP_EXTRACTION_CHANGED');
        const bytes = Buffer.from(record.data, 'base64'); current.size += bytes.length;
        if (current.size > current.item.size) throw fail('BACKUP_EXTRACTION_CHANGED');
        current.hash.update(bytes); await writeAll(current.handle, bytes);
      } else if (record.type === 'end') {
        if (!current || current.size !== current.item.size || !sameHash(current.hash.digest('hex'), current.item.sha256)) throw fail('BACKUP_EXTRACTION_CHANGED');
        await current.handle.sync(); await current.handle.close();
        const diskInfo = await lstat(current.output), diskHash = createHash('sha256');
        if (!diskInfo.isFile() || diskInfo.isSymbolicLink() || diskInfo.size !== current.item.size) throw fail('BACKUP_EXTRACTION_DISK_MISMATCH');
        for await (const bytes of createReadStream(current.output)) diskHash.update(bytes);
        if (!sameHash(diskHash.digest('hex'), current.item.sha256)) throw fail('BACKUP_EXTRACTION_DISK_MISMATCH');
        completed.add(current.item.name); current = null;
      } else if (record.type === 'header') {
        if (JSON.stringify(record.source) !== JSON.stringify(manifest.source)) throw fail('BACKUP_EXTRACTION_CHANGED');
      } else if (record.type === 'manifest') {
        if (current || record.sha256 !== manifest.sha256 || completed.size !== expected.size) throw fail('BACKUP_EXTRACTION_CHANGED');
      } else throw fail('BACKUP_EXTRACTION_CHANGED');
    }
    if (current || completed.size !== expected.size) throw fail('BACKUP_EXTRACTION_CHANGED');
    try { await lstat(destination); throw fail('BACKUP_EXTRACTION_DESTINATION_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(workingDirectory, destination);
    return { status: 'extracted-and-verified', directory: destination, entries: completed.size, recoveryTested: false, databaseRestored: false };
  } catch (error) {
    await current?.handle.close().catch(() => {});
    // Only the new, validated directory created by this invocation is removed.
    if (workingDirectory.startsWith(`${destination}.`) && dirname(workingDirectory) === parent) await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function assertRecoveryContents(manifest) {
  const names = new Set(manifest.entries.map(entry => entry.name));
  for (const required of ['database.dump', 'database-roles.sql', 'source.tar', 'configuration/auth.json', 'configuration/vault-secrets.json', 'configuration/recovery.json', 'storage/buckets.json', 'storage/inventory.json']) {
    if (!names.has(required)) throw fail('BACKUP_RECOVERY_ENTRY_MISSING');
  }
  if (manifest.entries.some(entry => ['database.dump', 'source.tar', 'configuration/auth.json', 'configuration/vault-secrets.json', 'configuration/recovery.json', 'storage/buckets.json', 'storage/inventory.json'].includes(entry.name) && entry.size < 1)) throw fail('BACKUP_RECOVERY_ENTRY_EMPTY');
  const expected = manifest.source?.storageObjects;
  const objects = manifest.entries.filter(entry => entry.metadata?.kind === 'storage-object');
  if (!Number.isSafeInteger(expected) || expected < 0 || objects.length !== expected) throw fail('BACKUP_STORAGE_INCOMPLETE');
  const identities = new Set();
  for (const entry of objects) {
    const { bucket, name, size } = entry.metadata;
    if (typeof bucket !== 'string' || typeof name !== 'string') throw fail('BACKUP_STORAGE_INCOMPLETE');
    checkName(bucket); checkName(name);
    if (bucket.includes('/') || size !== entry.size) throw fail('BACKUP_STORAGE_INCOMPLETE');
    const expectedName = `storage/objects/${[bucket, ...name.split('/')].map(encodeURIComponent).join('/')}`;
    if (entry.name !== expectedName || identities.has(expectedName)) throw fail('BACKUP_STORAGE_INCOMPLETE');
    identities.add(expectedName);
  }
  return true;
}
