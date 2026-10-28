import { createHash, timingSafeEqual } from 'node:crypto';
import { open, lstat, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKey, verifyArchive, assertRecoveryContents } from './archive.mjs';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_FIELDS = 'id,name,size,md5Checksum,sha256Checksum,parents,mimeType,trashed';
const CREATE_URL = `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=${DRIVE_UPLOAD_FIELDS}`;
export const DRIVE_UPLOAD_LIMITS = Object.freeze({ bytes: 40_000_000_000, chunk: 8 * 1024 * 1024, json: 131_072, requests: 8192, requestMs: 60_000, totalMs: 60 * 60 * 1000 });
const ID = /^[A-Za-z0-9_-]{10,128}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.orqbackup$/;
const error = code => Object.assign(new Error(code), { code });
const discard = body => { try { void body?.cancel().catch(() => {}); } catch {} };
const equalHash = (a, b, size) => typeof a === 'string' && typeof b === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(a)
  && new RegExp(`^[a-f0-9]{${size}}$`).test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function canonicalEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || /[^\x21-\x7e]/.test(value)) return null;
  const email = value.toLowerCase(), parts = email.split('@'), local = parts[0], domain = parts[1];
  if (parts.length !== 2 || !local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !domain || domain.length > 253 || !domain.includes('.')
    || !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return email;
}

function allowedEmailConfiguration(value) {
  if (typeof value !== 'string' || value.length > 5099) throw error('DRIVE_ALLOWED_EMAILS_INVALID');
  const emails = value.split(','), allowedEmails = new Set(emails);
  if (emails.length < 1 || emails.length > 20 || allowedEmails.size !== emails.length
    || emails.some(email => canonicalEmail(email) !== email)) throw error('DRIVE_ALLOWED_EMAILS_INVALID');
  return allowedEmails;
}

export function driveConfiguration(env = {}) {
  if (env.ORQUIVIA_DRIVE_UPLOAD_ENABLED !== 'true') throw error('DRIVE_UPLOAD_NOT_AUTHORIZED');
  const allowedEmails = allowedEmailConfiguration(env.ORQUIVIA_DRIVE_ALLOWED_EMAILS);
  const folderId = env.ORQUIVIA_DRIVE_FOLDER_ID, clientId = env.ORQUIVIA_DRIVE_CLIENT_ID;
  const clientSecret = env.ORQUIVIA_DRIVE_CLIENT_SECRET, refreshToken = env.ORQUIVIA_DRIVE_REFRESH_TOKEN;
  if (typeof folderId !== 'string' || !ID.test(folderId)
    || typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/.test(clientId)
    || typeof clientSecret !== 'string' || clientSecret.length < 10 || clientSecret.length > 1024 || /[^\x21-\x7e]/.test(clientSecret)
    || typeof refreshToken !== 'string' || refreshToken.length < 20 || refreshToken.length > 8192 || /[^\x21-\x7e]/.test(refreshToken)) {
    throw error('DRIVE_CONFIGURATION_INVALID');
  }
  return { folderId, clientId, clientSecret, refreshToken, allowedEmails };
}

/** A resumable URL is a credential. It is followed only on this exact Google endpoint. */
export function validateSessionURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\p{Cc}]/u.test(value)) throw error('DRIVE_SESSION_URL_INVALID');
  let url; try { url = new URL(value); } catch { throw error('DRIVE_SESSION_URL_INVALID'); }
  const keys = [...url.searchParams.keys()];
  // The real Drive response retains our exact projection and can add an opaque
  // session_crd capability. Keep both private, scoped to this fixed HTTPS path.
  // Do not rewrite that capability or allow arbitrary query parameters.
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || url.port || url.hash
    || url.pathname !== '/upload/drive/v3/files' || url.searchParams.get('uploadType') !== 'resumable'
    || !/^[A-Za-z0-9._~-]{10,2048}$/.test(url.searchParams.get('upload_id') || '')
    || keys.some(key => !['uploadType', 'upload_id', 'fields', 'session_crd'].includes(key))
    || new Set(keys).size !== keys.length
    || (url.searchParams.has('fields') && url.searchParams.get('fields') !== DRIVE_UPLOAD_FIELDS)
    || (url.searchParams.has('session_crd') && !/^[A-Za-z0-9._~-]{8,2048}$/.test(url.searchParams.get('session_crd') || ''))) throw error('DRIVE_SESSION_URL_INVALID');
  return url.href;
}

async function jsonBody(response) {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const length = response.headers.get('content-length');
  if (mime !== 'application/json' || (length && (!/^\d+$/.test(length) || Number(length) > DRIVE_UPLOAD_LIMITS.json)) || !response.body) {
    discard(response.body); throw error('DRIVE_RESPONSE_INVALID');
  }
  const chunks = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > DRIVE_UPLOAD_LIMITS.json) throw error('DRIVE_RESPONSE_TOO_LARGE');
    chunks.push(part);
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw error('DRIVE_RESPONSE_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('DRIVE_RESPONSE_INVALID');
  return value;
}

function requester({ fetcher, timeoutMs, maxRunMs }) {
  const deadline = Date.now() + maxRunMs; let requests = 0;
  return async (url, options, consume) => {
    if (++requests > DRIVE_UPLOAD_LIMITS.requests) throw error('DRIVE_REQUEST_LIMIT');
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw error('DRIVE_TIMEOUT');
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { ...options, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal });
          if (response.redirected || (response.url && new URL(response.url).href !== new URL(url).href)
            || (response.status >= 300 && response.status < 400 && response.status !== 308)) {
            discard(response.body); throw error('DRIVE_REDIRECT_FORBIDDEN');
          }
          return consume(response);
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(error('DRIVE_TIMEOUT')); }, remaining); }),
      ]);
    } catch (failure) {
      if (/^DRIVE_[A-Z_]+$/.test(failure?.code || '')) throw failure;
      throw error(controller.signal.aborted ? 'DRIVE_TIMEOUT' : 'DRIVE_REQUEST_FAILED');
    } finally { clearTimeout(timer); controller.abort(); }
  };
}

async function accessToken(config, request) {
  return request(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token', scope: DRIVE_SCOPE }).toString() }, async response => {
    if (response.status !== 200) { discard(response.body); throw error('DRIVE_AUTHORIZATION_FAILED'); }
    const result = await jsonBody(response);
    const scopes = typeof result.scope === 'string' ? result.scope.trim().split(/\s+/) : [];
    if (scopes.length !== 1 || scopes[0] !== DRIVE_SCOPE) throw error('DRIVE_SCOPE_INVALID');
    if (result.token_type !== 'Bearer' || typeof result.access_token !== 'string' || result.access_token.length < 20 || result.access_token.length > 8192
      || /[^A-Za-z0-9._~+\/-]/.test(result.access_token) || !Number.isSafeInteger(result.expires_in) || result.expires_in < 60) throw error('DRIVE_AUTHORIZATION_FAILED');
    return result.access_token;
  });
}

function authorized(token, extra = {}) { return { Authorization: `Bearer ${token}`, ...extra }; }
const successJson = async response => {
  if (response.status !== 200) { discard(response.body); throw error('DRIVE_METADATA_UNAVAILABLE'); }
  return jsonBody(response);
};

async function assertAllowedSharing(id, allowedEmails, token, request) {
  let pageToken = ''; const seen = new Set(), actualEmails = new Set();
  for (let pages = 0; pages < 20; pages++) {
    const url = new URL(`${API}/files/${id}/permissions`);
    url.searchParams.set('fields', 'nextPageToken,permissions(id,type,role,emailAddress)'); url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await request(url.href, { method: 'GET', headers: authorized(token) }, successJson);
    if (!Array.isArray(data.permissions) || data.permissions.length > 100 || data.permissions.length < 1
      || data.permissions.some(permission => !permission || permission.type !== 'user'
        || !['owner', 'writer', 'commenter', 'reader'].includes(permission.role)
        || !allowedEmails.has(canonicalEmail(permission.emailAddress)))) throw error('DRIVE_FOLDER_SHARING_UNSAFE');
    for (const permission of data.permissions) actualEmails.add(canonicalEmail(permission.emailAddress));
    if (!data.nextPageToken) {
      // The full principal set must match, not merely be a subset of the list.
      // Do not add, remove or repair permissions to make the comparison pass.
      if (actualEmails.size !== allowedEmails.size || [...allowedEmails].some(email => !actualEmails.has(email))) throw error('DRIVE_FOLDER_SHARING_UNSAFE');
      return;
    }
    if (typeof data.nextPageToken !== 'string' || data.nextPageToken.length > 4096 || /[\p{Cc}]/u.test(data.nextPageToken) || seen.has(data.nextPageToken)) throw error('DRIVE_PERMISSION_LIST_INVALID');
    seen.add(data.nextPageToken); pageToken = data.nextPageToken;
  }
  throw error('DRIVE_PERMISSION_LIST_LIMIT');
}

async function assertFolder(config, token, request) {
  const url = `${API}/files/${config.folderId}?fields=id,mimeType,trashed,driveId,capabilities(canAddChildren)`;
  const data = await request(url, { method: 'GET', headers: authorized(token) }, successJson);
  if (data.id !== config.folderId || data.mimeType !== 'application/vnd.google-apps.folder' || data.trashed !== false
    || data.driveId || data.capabilities?.canAddChildren !== true) throw error('DRIVE_FOLDER_INVALID');
  await assertAllowedSharing(config.folderId, config.allowedEmails, token, request);
}

const unchanged = (before, after) => before.dev === after.dev && before.ino === after.ino && before.size === after.size
  && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

async function digests(handle, expected) {
  const md5 = createHash('md5'), sha256 = createHash('sha256'); const buffer = Buffer.alloc(DRIVE_UPLOAD_LIMITS.chunk);
  let offset = 0;
  while (offset < expected.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
    if (!bytesRead) throw error('DRIVE_FILE_CHANGED');
    md5.update(buffer.subarray(0, bytesRead)); sha256.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
  if (!unchanged(expected, await handle.stat())) throw error('DRIVE_FILE_CHANGED');
  return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
}

function nextOffset(response, minimum, maximum) {
  const range = response.headers.get('range');
  if (!range) { if (minimum !== 0) throw error('DRIVE_UPLOAD_RANGE_INVALID'); return 0; }
  const match = range.match(/^bytes=0-(0|[1-9]\d*)$/);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < minimum || offset > maximum) throw error('DRIVE_UPLOAD_RANGE_INVALID');
  return offset;
}

async function uploadChunk(session, token, request, body, start, total) {
  const end = start + body.length;
  const options = { method: 'PUT', headers: authorized(token, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'Content-Range': `bytes ${start}-${end - 1}/${total}` }), body };
  const consume = async response => {
    if ([200, 201].includes(response.status)) return { completed: await jsonBody(response) };
    if (response.status === 308) { const offset = nextOffset(response, start, end); discard(response.body); return { offset }; }
    discard(response.body); throw error(response.status >= 500 || response.status === 429 ? 'DRIVE_RETRY_STATUS' : 'DRIVE_UPLOAD_FAILED');
  };
  try { return await request(session, options, consume); }
  catch (failure) {
    if (!['DRIVE_REQUEST_FAILED', 'DRIVE_TIMEOUT', 'DRIVE_RETRY_STATUS'].includes(failure.code)) throw failure;
    // Never create another file after an uncertain PUT. Ask this same session
    // what it accepted before deciding which ciphertext bytes can be continued.
    try {
      return await request(session, { method: 'PUT', headers: authorized(token, { 'Content-Length': '0', 'Content-Range': `bytes */${total}` }), body: Buffer.alloc(0) }, consume);
    } catch { throw error('DRIVE_UPLOAD_OUTCOME_UNCERTAIN'); }
  }
}

function assertUploaded(data, config, name, size, hashes) {
  if (typeof data.id !== 'string' || !ID.test(data.id) || data.name !== name || data.mimeType !== 'application/octet-stream'
    || data.trashed !== false || data.size !== String(size) || !Array.isArray(data.parents) || data.parents.length !== 1 || data.parents[0] !== config.folderId
    || !equalHash(data.md5Checksum, hashes.md5, 32) || (data.sha256Checksum !== undefined && !equalHash(data.sha256Checksum, hashes.sha256, 64))) throw error('DRIVE_UPLOAD_VERIFICATION_FAILED');
}

/** Dormant until the owner explicitly authorizes a narrow, separate backup connection. */
export async function uploadBackup({ file, env = process.env, fetcher = globalThis.fetch, timeoutMs = DRIVE_UPLOAD_LIMITS.requestMs, maxRunMs = DRIVE_UPLOAD_LIMITS.totalMs, includeEvidence = false } = {}) {
  const config = driveConfiguration(env);
  if (typeof file !== 'string' || !isAbsolute(file) || !FILENAME.test(basename(file)) || typeof fetcher !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DRIVE_UPLOAD_LIMITS.requestMs
    || !Number.isSafeInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > DRIVE_UPLOAD_LIMITS.totalMs
    || typeof includeEvidence !== 'boolean') throw error('DRIVE_CONFIGURATION_INVALID');
  const input = resolve(file), pathInfo = await lstat(input);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size < 40 || pathInfo.size > DRIVE_UPLOAD_LIMITS.bytes) throw error('DRIVE_FILE_INVALID');
  const key = readKey(env.ORQUIVIA_BACKUP_KEY); let handle;
  try {
    handle = await open(input, 'r');
    const original = await handle.stat();
    if (!unchanged(pathInfo, original)) throw error('DRIVE_FILE_CHANGED');
    const manifest = await verifyArchive({ file: input, key }); assertRecoveryContents(manifest);
    // This aggregate comes from the authenticated archive, never from a browser
    // flag or unverified source response. Validate it before contacting Drive.
    const objects = manifest.entries.filter(entry => entry.metadata?.kind === 'storage-object');
    const storageBytes = objects.reduce((total, entry) => total + entry.size, 0);
    if (includeEvidence && (!/^[a-f0-9]{40}$/.test(manifest.source?.commit || '')
      || !Number.isSafeInteger(storageBytes))) throw error('DRIVE_ARCHIVE_METADATA_INVALID');
    if (!unchanged(original, await stat(input)) || !unchanged(original, await handle.stat())) throw error('DRIVE_FILE_CHANGED');
    const hashes = await digests(handle, original), request = requester({ fetcher, timeoutMs, maxRunMs });
    let token = await accessToken(config, request);
    try {
      await assertFolder(config, token, request);
      const session = await request(CREATE_URL, { method: 'POST', headers: authorized(token, { 'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(original.size) }),
        body: JSON.stringify({ name: basename(input), mimeType: 'application/octet-stream', parents: [config.folderId] }) }, response => {
        if (response.status !== 200) { discard(response.body); throw error('DRIVE_UPLOAD_INIT_FAILED'); }
        const location = response.headers.get('location'); discard(response.body); return validateSessionURL(location);
      });
      let offset = 0, stalled = 0, completed;
      while (!completed && offset < original.size) {
        if (!unchanged(original, await handle.stat())) throw error('DRIVE_FILE_CHANGED');
        const chunk = Buffer.alloc(Math.min(DRIVE_UPLOAD_LIMITS.chunk, original.size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead !== chunk.length) throw error('DRIVE_FILE_CHANGED');
        const result = await uploadChunk(session, token, request, chunk, offset, original.size);
        if (result.completed) { completed = result.completed; break; }
        if (result.offset === offset) { if (++stalled > 2) throw error('DRIVE_UPLOAD_STALLED'); } else stalled = 0;
        offset = result.offset;
      }
      if (!completed || !unchanged(original, await handle.stat())) throw error('DRIVE_UPLOAD_OUTCOME_UNCERTAIN');
      assertUploaded(completed, config, basename(input), original.size, hashes);
      // Check the exact allowed users again after creation. Do not try to fix
      // sharing or delete a file automatically if the permissions changed.
      await assertFolder(config, token, request);
      await assertAllowedSharing(completed.id, config.allowedEmails, token, request);
      return { status: 'uploaded-and-verified', encryptedBytes: original.size, checksumVerified: true, permissionsChecked: true, recoveryTested: false,
        ...(includeEvidence ? { operationalEvidence:{sourceCommit:manifest.source.commit,storageObjects:objects.length,storageBytes,archiveSha256:hashes.sha256} } : {}) };
    } finally { token = null; }
  } finally { key.fill(0); await handle?.close(); }
}

export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  if (argv.length !== 2 || argv[0] !== '--file') throw error('DRIVE_ARGUMENT_INVALID');
  return uploadBackup({ file: argv[1], env, ...options });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (failure) {
    const code = /^DRIVE_[A-Z_]+$/.test(failure?.code || '') ? failure.code : 'DRIVE_UPLOAD_FAILED';
    console.error(JSON.stringify({ status: 'failed', code, message: 'No se confirma una copia subida y verificada en Google Drive. Revisa la configuración y el resultado sin repetir una subida incierta.' }));
    process.exitCode = 1;
  }
}
