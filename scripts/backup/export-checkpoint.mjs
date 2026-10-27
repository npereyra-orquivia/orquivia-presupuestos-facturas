import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptedRecords, extractArchive, readKey, verifyArchive } from './archive.mjs';

// This helper deliberately imports no application, database, network or npm code.
// It handles one historical operational export, never a full system restoration.
export const CHECKPOINT_SCOPE = 'operational-export-and-source-only';
export const CHECKPOINT_RELEASE = '1.4.1';
export const CHECKPOINT_COMMIT = '1625e0494638fb6c782e4f8cbdf02b08ec4d3bb2';
export const CHECKPOINT_PATHS = Object.freeze([
  'LEEME.json',
  'export/empresa.json',
  'export/historico.zip',
  'source/orquivia-v1.4.1.bundle',
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const limits = Object.freeze({ entries: 4, bytes: 1024 * 1024 * 1024, entryBytes: 512 * 1024 * 1024 });
const maxEncryptedBytes = 1536 * 1024 * 1024;
const fail = code => Object.assign(new Error(code), { code });

export function assertCheckpointContents(manifest) {
  if (manifest?.source?.scope !== CHECKPOINT_SCOPE || manifest.source.release !== CHECKPOINT_RELEASE
    || manifest.source.commit !== CHECKPOINT_COMMIT) throw fail('CHECKPOINT_SOURCE_INVALID');
  const entries = manifest.entries;
  if (!Array.isArray(entries) || entries.length !== CHECKPOINT_PATHS.length || manifest.entryCount !== CHECKPOINT_PATHS.length
    || new Set(entries.map(entry => entry.name)).size !== CHECKPOINT_PATHS.length
    || entries.some(entry => !CHECKPOINT_PATHS.includes(entry.name))) throw fail('CHECKPOINT_CONTENTS_INVALID');
  if (entries.some(entry => !Number.isSafeInteger(entry.size) || entry.size < 1)) throw fail('CHECKPOINT_CONTENTS_INVALID');
  const scopeFile = entries.find(entry => entry.name === 'LEEME.json');
  if (scopeFile.size > 64 * 1024) throw fail('CHECKPOINT_SCOPE_FILE_INVALID');
  return true;
}

function argumentsFor(argv) {
  const result = { command: argv[0] };
  if (!['verify', 'extract'].includes(result.command)) throw fail('CHECKPOINT_ARGUMENT_INVALID');
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index], value = argv[index + 1];
    if (!['--file', '--key-file', '--output-dir'].includes(name) || typeof value !== 'string'
      || !value || value.startsWith('--') || result[name] !== undefined) throw fail('CHECKPOINT_ARGUMENT_INVALID');
    result[name] = value; index++;
  }
  if (!result['--file'] || (result.command === 'extract' && !result['--output-dir'])
    || (result.command === 'verify' && result['--output-dir'])) throw fail('CHECKPOINT_ARGUMENT_INVALID');
  return result;
}

function localPath(value) {
  // No URLs, UNC shares, Windows device paths or alternate data streams.
  // Normal paths may be absolute or relative to cwd; extraction additionally
  // requires an absolute destination in extractArchive.
  if (typeof value !== 'string' || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value)
    || value.replace(/^[a-z]:[\\/]/i, '').includes(':')) throw fail('CHECKPOINT_LOCAL_FILE_REQUIRED');
  return resolve(value);
}

async function keyFromFile(filename) {
  const path = localPath(filename);
  let handle, material;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 44 || before.size > 46) throw fail('CHECKPOINT_KEY_FILE_INVALID');
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) throw fail('CHECKPOINT_KEY_FILE_INVALID');
    // A bounded read avoids a growing file allocating unbounded private memory.
    material = Buffer.alloc(47);
    const { bytesRead } = await handle.read(material, 0, material.length, 0);
    if (bytesRead !== info.size || bytesRead > 46) throw fail('CHECKPOINT_KEY_FILE_INVALID');
    const value = material.subarray(0, bytesRead).toString('utf8');
    if (!/^[A-Za-z0-9+/]{43}=(?:\r?\n)?$/.test(value)) throw fail('CHECKPOINT_KEY_FILE_INVALID');
    return readKey(value.replace(/\r?\n$/, ''));
  } catch (error) {
    if (error.code === 'BACKUP_KEY_INVALID') throw error;
    throw fail('CHECKPOINT_KEY_FILE_INVALID');
  } finally { material?.fill(0); await handle?.close(); }
}

async function readScopeFile(file, key) {
  const chunks = []; let current, size = 0;
  // verifyArchive has already authenticated this file. Consume this pass fully as
  // well: authentication must finish before the scope JSON is accepted.
  for await (const record of decryptedRecords({ file, key, limits })) {
    if (record.type === 'entry') current = record.name;
    else if (record.type === 'chunk' && current === 'LEEME.json') {
      const bytes = Buffer.from(record.data, 'base64'); size += bytes.length;
      if (size > 64 * 1024) throw fail('CHECKPOINT_SCOPE_FILE_INVALID');
      chunks.push(bytes);
    } else if (record.type === 'end') current = undefined;
  }
  let scope;
  try { scope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail('CHECKPOINT_SCOPE_FILE_INVALID'); }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || scope.scope !== CHECKPOINT_SCOPE
    || scope.release !== CHECKPOINT_RELEASE || scope.completeSystemBackup !== false || scope.databaseRestored !== false
    || scope.accountsIncluded !== false || scope.profilesIncluded !== false || scope.mailboxSecretsIncluded !== false) throw fail('CHECKPOINT_SCOPE_FILE_INVALID');
}

export async function verifyCheckpoint({ file, key }) {
  const path = localPath(file), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 37 || info.size > maxEncryptedBytes) throw fail('CHECKPOINT_LOCAL_FILE_REQUIRED');
  const manifest = await verifyArchive({ file: path, key, limits });
  assertCheckpointContents(manifest);
  await readScopeFile(path, key);
  return manifest;
}

function scopeResult(manifest) {
  return {
    scope: CHECKPOINT_SCOPE, release: CHECKPOINT_RELEASE, sourceCommit: CHECKPOINT_COMMIT,
    completeSystemBackup: false, recoveryTested: false, databaseRestored: false,
    entries: manifest.entryCount, originalBytes: manifest.bytes, createdAt: manifest.createdAt,
    limitations: 'Exportación operativa y código históricos. No restaura PostgreSQL, Auth, perfiles, secretos, Storage ni configuración de servicios.',
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, options = {}) {
  const args = argumentsFor(argv);
  if (args['--key-file'] && env.ORQUIVIA_BACKUP_KEY !== undefined) throw fail('CHECKPOINT_KEY_SOURCE_AMBIGUOUS');
  const key = args['--key-file'] ? await keyFromFile(args['--key-file']) : readKey(env.ORQUIVIA_BACKUP_KEY);
  try {
    const file = localPath(args['--file']), manifest = await verifyCheckpoint({ file, key });
    if (args.command === 'verify') return { status: 'checkpoint-authenticated-and-verified', ...scopeResult(manifest) };
    localPath(args['--output-dir']);
    const extracted = await extractArchive({ file, key, directory: args['--output-dir'],
      repositoryRoot: options.repositoryRoot || repositoryRoot, limits, validateManifest: assertCheckpointContents });
    return { ...extracted, status: 'checkpoint-extracted-and-verified', ...scopeResult(manifest) };
  } finally { key.fill(0); }
}

const messages = {
  CHECKPOINT_ARGUMENT_INVALID: 'Usa verify --file RUTA o extract --file RUTA --output-dir DESTINO, con ORQUIVIA_BACKUP_KEY o --key-file RUTA. No se admiten claves como argumentos.',
  CHECKPOINT_KEY_SOURCE_AMBIGUOUS: 'Utiliza una sola fuente de clave: ORQUIVIA_BACKUP_KEY o --key-file.',
  CHECKPOINT_KEY_FILE_INVALID: 'El archivo privado de clave debe ser un archivo normal con una clave base64 de 32 bytes y, opcionalmente, un salto de línea final.',
  BACKUP_KEY_INVALID: 'Falta una clave base64 canónica de exactamente 32 bytes. No la introduzcas como argumento.',
  CHECKPOINT_SOURCE_INVALID: 'El archivo no corresponde al checkpoint operativo de Orquivia v1.4.1 y su revisión estable.',
  CHECKPOINT_CONTENTS_INVALID: 'El checkpoint no contiene exactamente los cuatro archivos operativos esperados.',
  CHECKPOINT_SCOPE_FILE_INVALID: 'El archivo de alcance no identifica esta exportación parcial histórica.',
  CHECKPOINT_LOCAL_FILE_REQUIRED: 'Se requiere un archivo local normal, sin enlace simbólico y dentro del límite de tamaño.',
  BACKUP_DESTINATION_MUST_BE_ABSOLUTE: 'El destino de extracción debe ser una ruta absoluta.',
  BACKUP_DESTINATION_INSIDE_REPOSITORY: 'El destino debe estar fuera de la carpeta de las herramientas y del repositorio.',
  BACKUP_EXTRACTION_DESTINATION_EXISTS: 'El destino ya existe. Elige una carpeta nueva y aislada.',
  BACKUP_AUTHENTICATION_OR_READ_FAILED: 'No se pudo autenticar el archivo: clave incorrecta, archivo incompleto o contenido alterado.',
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) {
    // No paths, supplied arguments, secrets, stack traces or decrypted data.
    const code = typeof error.code === 'string' && /^(?:CHECKPOINT|BACKUP)_[A-Z_]+$/.test(error.code) ? error.code : 'CHECKPOINT_FAILED';
    console.error(JSON.stringify({ status: 'failed', code, message: messages[code] || 'La operación no ha terminado. No se confirma una recuperación correcta.' }));
    process.exitCode = 1;
  }
}
