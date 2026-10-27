import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { bufferEntry } from './archive.mjs';

const fail = (code) => Object.assign(new Error(code), { code });
const REF = /^[a-z]{20}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
export const PRODUCTION_PROJECT_REF = 'tfaglecwycbamibnhqmq';
const pathIsSafe = value => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 4096
  && !/[\\\x00-\x1f]/.test(value) && !value.split('/').some(piece => !piece || piece === '.' || piece === '..');

export function projectRef(value) {
  let url; try { url = new URL(value); } catch { throw fail('BACKUP_PROJECT_URL_INVALID'); }
  const match = url.hostname.match(/^([a-z]{20})\.supabase\.co$/);
  if (!match || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('BACKUP_PROJECT_URL_INVALID');
  return match[1];
}

export function databaseEnvironment(connection, expectedRef, base = process.env) {
  let url; try { url = new URL(connection); } catch { throw fail('BACKUP_DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !REF.test(expectedRef) || !url.username || !url.password || url.hash) throw fail('BACKUP_DATABASE_URL_INVALID');
  let user, password;
  try { user = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw fail('BACKUP_DATABASE_URL_INVALID'); }
  const direct = url.hostname === `db.${expectedRef}.supabase.co` && user === 'postgres';
  const pooled = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && user === `postgres.${expectedRef}` && (!url.port || url.port === '5432');
  if ((!direct && !pooled) || decodeURIComponent(url.pathname) !== '/postgres') throw fail('BACKUP_DATABASE_PROJECT_MISMATCH');
  const allowed = new Set(['sslmode', 'connect_timeout']);
  if ([...url.searchParams.keys()].some(key => !allowed.has(key)) || (url.searchParams.get('sslmode') && url.searchParams.get('sslmode') !== 'verify-full')) throw fail('BACKUP_DATABASE_TLS_REQUIRED');
  // Do not inherit arbitrary libpq connection settings or inject credentials into argv.
  const safeNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'TEMP', 'TMP', 'LANG', 'LC_ALL']);
  const clean = Object.fromEntries(Object.entries(base).filter(([name]) => safeNames.has(name.toUpperCase())));
  return { ...clean, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: 'postgres', PGUSER: user, PGPASSWORD: password, PGSSLMODE: 'verify-full', PGSSLROOTCERT: base.ORQUIVIA_BACKUP_PG_SSL_ROOT_CERT || 'system', PGCONNECT_TIMEOUT: '20', PGAPPNAME: 'orquivia-encrypted-backup', PGOPTIONS: '-c default_transaction_read_only=on' };
}

export function runStream(executable, args, { env, cwd, timeoutMs = 30 * 60 * 1000, spawnFn = spawn } = {}) {
  const child = spawnFn(executable, args, { env, cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  // Never forward child stderr: database/tool errors may contain passwords or SQL data.
  child.stderr.resume();
  let timer;
  const done = new Promise((resolve, reject) => {
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', () => finish(fail('BACKUP_TOOL_UNAVAILABLE')));
    child.once('close', code => finish(code === 0 ? null : fail('BACKUP_TOOL_FAILED')));
    timer = setTimeout(() => { child.kill(); finish(fail('BACKUP_TOOL_TIMEOUT')); }, timeoutMs);
    timer.unref?.();
  });
  done.catch(() => {});
  async function* body() {
    try { for await (const chunk of child.stdout) yield chunk; await done; }
    finally { if (child.exitCode === null) child.kill(); }
  }
  return { body: body(), done };
}

export async function commandText(executable, args, options) {
  const command = runStream(executable, args, options), chunks = [];
  let size = 0;
  for await (const data of command.body) { size += data.length; if (size > MAX_JSON_BYTES) throw fail('BACKUP_TOOL_OUTPUT_LIMIT'); chunks.push(data); }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function requestJson(fetchFn, url, options) {
  let response;
  try { response = await fetchFn(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(60_000) }); }
  catch { throw fail('BACKUP_SOURCE_REQUEST_FAILED'); }
  if (!response.ok) { await response.body?.cancel(); throw fail('BACKUP_SOURCE_REQUEST_FAILED'); }
  if (Number(response.headers?.get('content-length')) > MAX_JSON_BYTES) {
    await response.body?.cancel(); throw fail('BACKUP_SOURCE_RESPONSE_TOO_LARGE');
  }
  const chunks = []; let size = 0;
  if (!response.body) throw fail('BACKUP_SOURCE_RESPONSE_INVALID');
  for await (const part of response.body) { size += part.length; if (size > MAX_JSON_BYTES) throw fail('BACKUP_SOURCE_RESPONSE_TOO_LARGE'); chunks.push(part); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('BACKUP_SOURCE_RESPONSE_INVALID'); }
}

export function storageClient({ url, serviceKey, fetchFn = fetch, maxObjects = 100000 }) {
  projectRef(url);
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 100000) throw fail('BACKUP_STORAGE_LIMIT_INVALID');
  if (typeof serviceKey !== 'string' || serviceKey.length < 30 || /\s/.test(serviceKey)) throw fail('BACKUP_SERVICE_KEY_REQUIRED');
  const base = new URL(url).origin, headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  return {
    async inventory() {
      const buckets = await requestJson(fetchFn, `${base}/storage/v1/bucket`, { headers });
      if (!Array.isArray(buckets)) throw fail('BACKUP_STORAGE_BUCKETS_INVALID');
      const objects = [], identities = new Set(), bucketIds = new Set();
      for (const bucket of buckets) {
        if (!pathIsSafe(bucket.id) || bucket.id.includes('/') || bucketIds.has(bucket.id)) throw fail('BACKUP_STORAGE_BUCKETS_INVALID');
        bucketIds.add(bucket.id);
        const queue = [''], prefixes = new Set();
        for (let index = 0; index < queue.length; index++) {
          const prefix = queue[index];
          if (prefixes.has(prefix) || queue.length > maxObjects) throw fail('BACKUP_STORAGE_LIST_INVALID');
          prefixes.add(prefix);
          for (let offset = 0; ; offset += 1000) {
            const items = await requestJson(fetchFn, `${base}/storage/v1/object/list/${encodeURIComponent(bucket.id)}`, {
              method: 'POST', headers, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
            });
            if (!Array.isArray(items) || items.length > 1000) throw fail('BACKUP_STORAGE_LIST_INVALID');
            for (const item of items) {
              if (!pathIsSafe(item.name)) throw fail('BACKUP_STORAGE_PATH_INVALID');
              const name = prefix ? `${prefix}/${item.name}` : item.name;
              if (item.id === null && item.metadata === null) { queue.push(name); continue; }
              const size = item.metadata?.size;
              if (typeof item.id !== 'string' || !Number.isSafeInteger(size) || size < 0) throw fail('BACKUP_STORAGE_METADATA_INVALID');
              const identity = `${bucket.id}/${name}`;
              if (identities.has(identity) || objects.length >= maxObjects) throw fail('BACKUP_STORAGE_DUPLICATE_OR_LIMIT');
              identities.add(identity);
              objects.push({ bucket: bucket.id, name, id: item.id, size, updatedAt: item.updated_at || null, mimeType: item.metadata.mimetype || 'application/octet-stream' });
            }
            if (items.length < 1000) break;
            if (offset > maxObjects * 2) throw fail('BACKUP_STORAGE_LIST_LIMIT');
          }
        }
      }
      objects.sort((a, b) => `${a.bucket}/${a.name}`.localeCompare(`${b.bucket}/${b.name}`, 'en'));
      buckets.sort((a, b) => a.id.localeCompare(b.id, 'en'));
      return { buckets, objects, digest: createHash('sha256').update(JSON.stringify({ buckets, objects })).digest('hex') };
    },
    async object(object) {
      if (!object || !pathIsSafe(object.bucket) || object.bucket.includes('/') || !pathIsSafe(object.name)
        || !Number.isSafeInteger(object.size) || object.size < 0) throw fail('BACKUP_STORAGE_PATH_INVALID');
      const encoded = [object.bucket, ...object.name.split('/')].map(encodeURIComponent).join('/');
      let response;
      try { response = await fetchFn(`${base}/storage/v1/object/${encoded}`, { headers, redirect: 'error', signal: AbortSignal.timeout(120_000) }); }
      catch { throw fail('BACKUP_STORAGE_DOWNLOAD_FAILED'); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw fail('BACKUP_STORAGE_DOWNLOAD_FAILED'); }
      return { name: `storage/objects/${encoded}`, metadata: { kind: 'storage-object', ...object }, expectedSize: object.size, body: Readable.fromWeb(response.body) };
    },
  };
}

export async function authenticationConfig(ref, token, fetchFn = fetch) {
  if (!REF.test(ref) || typeof token !== 'string' || token.length < 20 || /\s/.test(token)) throw fail('BACKUP_MANAGEMENT_TOKEN_REQUIRED');
  const config = await requestJson(fetchFn, `https://api.supabase.com/v1/projects/${ref}/config/auth`, { headers: { Authorization: `Bearer ${token}` } });
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail('BACKUP_AUTH_CONFIGURATION_INVALID');
  return config;
}

export function recoveryPackage(value) {
  let config; try { config = JSON.parse(value); } catch { throw fail('BACKUP_RECOVERY_CONFIGURATION_REQUIRED'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !config.edgeSecrets || typeof config.edgeSecrets !== 'object' || Array.isArray(config.edgeSecrets)
    || config.confirmedComplete !== true || config.confirmedQuietCapture !== true
    || typeof config.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(config.verifiedAt)
    || !Number.isFinite(Date.parse(config.verifiedAt))
    || !config.authSmtp || typeof config.authSmtp !== 'object' || Array.isArray(config.authSmtp)
    || !config.storageConfiguration || typeof config.storageConfiguration !== 'object' || Array.isArray(config.storageConfiguration)
    || !Array.isArray(config.edgeFunctions)) throw fail('BACKUP_RECOVERY_CONFIGURATION_REQUIRED');
  return config;
}

// Dynamic identifiers come from the catalog and are quoted by PostgreSQL. All
// row data stays on the database server; the only result is one SHA-256 digest.
export const SNAPSHOT_FINGERPRINT_SQL = `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
  COALESCE(pg_catalog.string_agg(
    pg_catalog.format('%I.%I', n.nspname, c.relname) || ':' ||
    pg_catalog.query_to_xml(pg_catalog.format(
      'SELECT pg_catalog.to_jsonb(t) AS row FROM %I.%I AS t ORDER BY pg_catalog.to_jsonb(t)::text',
      n.nspname, c.relname), true, false, '')::text,
    E'\\n' ORDER BY n.nspname, c.relname), ''), 'UTF8')), 'hex')
FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND n.nspname IN ('public','orquivia_private','auth','vault','storage','cron')`;

export async function databaseFingerprint(databaseEnv, { psql = 'psql', command = commandText } = {}) {
  const result = await command(psql, ['--no-psqlrc', '--set', 'ON_ERROR_STOP=on', '--tuples-only', '--no-align', '--command', SNAPSHOT_FINGERPRINT_SQL], { env: databaseEnv });
  if (!/^[a-f0-9]{64}$/.test(result)) throw fail('BACKUP_DATABASE_FINGERPRINT_INVALID');
  return result;
}

export function configurationFingerprint(value) {
  const normalize = input => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export async function assertCaptureStable({ storage, inventoryDigest, readAuth, authDigest, readDatabase, databaseDigest }) {
  if ((await storage.inventory()).digest !== inventoryDigest) throw fail('BACKUP_STORAGE_CHANGED_DURING_CAPTURE');
  if (configurationFingerprint(await readAuth()) !== authDigest) throw fail('BACKUP_AUTH_CHANGED_DURING_CAPTURE');
  if (await readDatabase() !== databaseDigest) throw fail('BACKUP_DATABASE_CHANGED_DURING_CAPTURE');
}

export async function* sourceEntries({ databaseEnv, repositoryRoot, revision, storage, inventory, authConfig, recovery, pgDump = 'pg_dump', pgDumpAll = 'pg_dumpall', psql = 'psql', git = 'git', command = runStream }) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw fail('BACKUP_SOURCE_REVISION_INVALID');
  yield { name: 'database.dump', metadata: { kind: 'postgres-custom-dump', includes: 'Database schemas, data, policies, grants, Auth and private application tables visible to the configured operator; errors abort the capture.' }, body: command(pgDump, ['--format=custom', '--lock-wait-timeout=30000'], { env: databaseEnv }).body };
  yield { name: 'database-roles.sql', metadata: { kind: 'postgres-roles', rolePasswordsExcluded: true }, body: command(pgDumpAll, ['--roles-only', '--no-role-passwords'], { env: databaseEnv }).body };
  const vaultQuery = "SELECT COALESCE(json_agg(json_build_object('id',id,'name',name,'description',description,'secret',decrypted_secret) ORDER BY id),'[]'::json)::text FROM vault.decrypted_secrets";
  yield { name: 'configuration/vault-secrets.json', metadata: { kind: 'portable-vault-secrets', containsSecrets: true, restoreRequiresReencryptionAndReferenceMapping: true }, body: command(psql, ['--no-psqlrc', '--set', 'ON_ERROR_STOP=on', '--tuples-only', '--no-align', '--command', vaultQuery], { env: databaseEnv }).body };
  yield { name: 'source.tar', metadata: { kind: 'git-archive', revision }, body: command(git, ['archive', '--format=tar', revision], { cwd: repositoryRoot, env: databaseEnv }).body };
  yield bufferEntry('configuration/auth.json', authConfig, { kind: 'supabase-auth-configuration' });
  yield bufferEntry('configuration/recovery.json', recovery, { kind: 'operator-recovery-secrets', manualVerificationRequired: true });
  yield bufferEntry('storage/buckets.json', inventory.buckets, { kind: 'storage-bucket-configuration' });
  yield bufferEntry('storage/inventory.json', inventory.objects, { kind: 'storage-inventory' });
  for (const object of inventory.objects) yield await storage.object(object);
}

export function restorePlan({ manifest, targetUrl, targetDatabaseUrl, acknowledgeIsolation, baseEnv }) {
  const sourceRef = manifest.source?.projectRef, targetRef = projectRef(targetUrl);
  if (!REF.test(sourceRef || '')) throw fail('BACKUP_SOURCE_REFERENCE_INVALID');
  if (sourceRef === targetRef || targetRef === PRODUCTION_PROJECT_REF) throw fail('RESTORE_PRODUCTION_TARGET_FORBIDDEN');
  if (acknowledgeIsolation !== `ISOLATED:${targetRef}`) throw fail('RESTORE_ISOLATION_ACK_REQUIRED');
  databaseEnvironment(targetDatabaseUrl, targetRef, baseEnv);
  return { version: 1, sourceRef, targetRef, mode: 'plan-only', mutationsPerformed: false, entryCount: manifest.entryCount, bytes: manifest.bytes,
    steps: ['Keep the destination inaccessible to the portal; disable outgoing SMTP, Edge Functions and database cron before importing.',
      'Have the operator follow the official Supabase logical restore procedure for the matching PostgreSQL version and extensions.',
      'Re-create Vault values using the destination Vault API, then map every old secret UUID to its new UUID (including mail_profiles.secret_id); never assume ciphertext is portable.',
      'Restore Storage originals through the Storage API, without overwriting or making buckets public; check all hashes.',
      'Reconfigure Auth, functions, environment secrets and project URLs for the isolated target; do not enable source jobs.',
      'Test access, MFA, numbering, issued documents and original files; record real results and recovery duration before considering recovery proven.'] };
}
