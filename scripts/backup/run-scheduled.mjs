import { mkdtemp, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPrivateDestination } from './archive.mjs';
import { main as createBackup } from './cli.mjs';
import { driveConfiguration, uploadBackup } from './drive-upload.mjs';
import { PRODUCTION_PROJECT_REF, projectRef, recoveryPackage } from './source.mjs';
import { backupEvidenceConfiguration, createBackupHealthReporter } from './health-evidence.mjs';

const REPOSITORY = 'npereyra-orquivia/orquivia-presupuestos-facturas';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const failure = code => Object.assign(new Error(code), { code });
const ownCodes = new Set(['SCHEDULED_BACKUP_DISABLED', 'SCHEDULED_BACKUP_CONTEXT_INVALID',
  'SCHEDULED_BACKUP_READINESS_REQUIRED', 'SCHEDULED_BACKUP_PROJECT_INVALID',
  'SCHEDULED_BACKUP_DRIFT_CHECKS_REQUIRED', 'SCHEDULED_BACKUP_TEMP_REQUIRED',
  'SCHEDULED_BACKUP_CAPTURE_FAILED', 'SCHEDULED_BACKUP_CAPTURE_INVALID',
  'SCHEDULED_BACKUP_UPLOAD_FAILED', 'SCHEDULED_BACKUP_UPLOAD_INVALID',
  'SCHEDULED_BACKUP_EVIDENCE_FAILED', 'SCHEDULED_BACKUP_EVIDENCE_INVALID', 'SCHEDULED_BACKUP_FAILED']);

/** Operator readiness is an attestation, never proof of a restored system. */
export function scheduledConfiguration(env = {}) {
  if (env.ORQUIVIA_BACKUPS_ENABLED !== 'true') throw failure('SCHEDULED_BACKUP_DISABLED');
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== REPOSITORY
    || env.GITHUB_REF !== 'refs/heads/main' || !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) {
    throw failure('SCHEDULED_BACKUP_CONTEXT_INVALID');
  }
  if (env.ORQUIVIA_BACKUP_RESTORE_REHEARSED !== 'true') throw failure('SCHEDULED_BACKUP_READINESS_REQUIRED');
  if (projectRef(env.ORQUIVIA_BACKUP_SUPABASE_URL) !== PRODUCTION_PROJECT_REF) throw failure('SCHEDULED_BACKUP_PROJECT_INVALID');
  const recovery = recoveryPackage(env.ORQUIVIA_BACKUP_RECOVERY_JSON);
  if (recovery.captureMode !== 'drift-checked') throw failure('SCHEDULED_BACKUP_DRIFT_CHECKS_REQUIRED');
  driveConfiguration(env); // Fail before capture if the separate Drive authorization is absent.
  backupEvidenceConfiguration(env);
  if (typeof env.RUNNER_TEMP !== 'string' || !isAbsolute(env.RUNNER_TEMP)) throw failure('SCHEDULED_BACKUP_TEMP_REQUIRED');
}

export async function runScheduled(env = process.env, { capture = createBackup, upload = uploadBackup, createReporter = createBackupHealthReporter, repositoryRoot = root } = {}) {
  scheduledConfiguration(env);
  const temporaryRoot = await assertPrivateDestination(env.RUNNER_TEMP, repositoryRoot);
  const outputDirectory = await mkdtemp(join(temporaryRoot, 'orquivia-encrypted-backup-'));
  const reporter = createReporter(env);
  if (reporter) await reporter.started();
  try {
    let captured;
    try { captured = await capture(['create', '--output-dir', outputDirectory], env); }
    catch { throw failure('SCHEDULED_BACKUP_CAPTURE_FAILED'); }
    // Only this run's authenticated, complete archive can reach Drive. No shell
    // parsing, previous-run lookup, whole-operation retries or plaintext artifacts.
    if (captured?.status !== 'captured-and-verified' || captured.recoveryTested !== false
      || typeof captured.file !== 'string' || !isAbsolute(captured.file)
      || dirname(resolve(captured.file)) !== outputDirectory
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.orqbackup$/.test(basename(captured.file))
      || !Number.isSafeInteger(captured.encryptedBytes) || captured.encryptedBytes <= 0
      || !/^[a-f0-9]{40}$/.test(captured.sourceCommit || '')) throw failure('SCHEDULED_BACKUP_CAPTURE_INVALID');
    const fileInfo = await lstat(captured.file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== captured.encryptedBytes
      || await realpath(captured.file) !== resolve(captured.file)) throw failure('SCHEDULED_BACKUP_CAPTURE_INVALID');
    let uploaded;
    try { uploaded = await upload({ file: captured.file, env, includeEvidence: Boolean(reporter) }); }
    catch { throw failure('SCHEDULED_BACKUP_UPLOAD_FAILED'); }
    if (uploaded?.status !== 'uploaded-and-verified' || uploaded.recoveryTested !== false
      || uploaded.checksumVerified !== true || uploaded.permissionsChecked !== true
      || uploaded.encryptedBytes !== captured.encryptedBytes) throw failure('SCHEDULED_BACKUP_UPLOAD_INVALID');
    // A readiness flag never records a restored system. Only the verified upload
    // can publish a successful capture, with aggregate provenance from its archive.
    if (reporter) await reporter.succeeded(captured, uploaded);
    return { status: 'captured-and-uploaded-verified', encryptedBytes: uploaded.encryptedBytes,
      checksumVerified: true, permissionsChecked: true, sourceCommit: captured.sourceCommit, recoveryTested: false };
  } catch (error) {
    if (reporter) {
      try { await reporter.failed(scheduledFailure(error).code); }
      catch { /* Keep the primary failure; never retry capture or upload. */ }
    }
    throw error;
  }
}

export function scheduledFailure(error) {
  return { status: 'failed', code: ownCodes.has(error?.code) ? error.code : 'SCHEDULED_BACKUP_FAILED',
    message: 'La copia programada no se confirma. Revisar la ejecución sin compartir secretos; no reintentar a ciegas una subida incierta.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runScheduled())); }
  catch (error) { console.error(JSON.stringify(scheduledFailure(error))); process.exitCode = 1; }
}
