import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { assertPrivateDestination, assertRecoveryContents, extractArchive, readKey, verifyArchive, writeArchive } from './archive.mjs';
import { assertCaptureStable, authenticationConfig, commandText, configurationFingerprint, databaseEnvironment, databaseFingerprint, projectRef, recoveryPackage, restorePlan, sourceEntries, storageClient } from './source.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const failure = code => Object.assign(new Error(code), { code });
const messages = {
  BACKUP_TOOL_UNAVAILABLE: 'Falta una herramienta requerida (pg_dump, pg_dumpall, psql o git). Instálala antes de ejecutar la copia.',
  BACKUP_TOOL_FAILED: 'La herramienta de copia terminó con error. No se ha publicado una copia válida; revisar la conexión y permisos sin compartir credenciales.',
  BACKUP_AUTHENTICATION_OR_READ_FAILED: 'La copia no supera la autenticación. Clave incorrecta, archivo incompleto o contenido alterado.',
  BACKUP_RECOVERY_CONFIGURATION_REQUIRED: 'Falta el paquete de recuperación de configuración y secretos externos confirmado por la operadora.',
  BACKUP_DESTINATION_INSIDE_REPOSITORY: 'El destino debe estar fuera del repositorio y de su publicación.',
  RESTORE_PRODUCTION_TARGET_FORBIDDEN: 'El destino es el proyecto original o la producción de Orquivia. Está prohibido usarlo para el ensayo.',
};

function argumentsFor(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index++) {
    const name = argv[index];
    if (!['--file', '--output-dir', '--target-url', '--ack-isolated'].includes(name) || !argv[index + 1] || argv[index + 1].startsWith('--') || result[name]) throw failure('BACKUP_ARGUMENT_INVALID');
    result[name] = argv[++index];
  }
  return result;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = argumentsFor(argv);
  if (!['create', 'verify', 'restore-plan', 'extract'].includes(args.command)) throw failure('BACKUP_ARGUMENT_INVALID');
  const key = readKey(env.ORQUIVIA_BACKUP_KEY);
  try {
    if (args.command === 'create') {
      const url = env.ORQUIVIA_BACKUP_SUPABASE_URL, ref = projectRef(url);
      const databaseEnv = databaseEnvironment(env.ORQUIVIA_BACKUP_DATABASE_URL, ref, env);
      const recovery = recoveryPackage(env.ORQUIVIA_BACKUP_RECOVERY_JSON);
      const outputDirectory = await assertPrivateDestination(args['--output-dir'] || env.ORQUIVIA_BACKUP_OUTPUT_DIR || '', repositoryRoot);
      const commit = await commandText('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
      if (!/^[a-f0-9]{40}$/.test(commit)) throw failure('BACKUP_SOURCE_REVISION_INVALID');
      // Refuse to archive a revision that differs from what is about to be deployed.
      const dirty = await commandText('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repositoryRoot });
      if (dirty) throw failure('BACKUP_SOURCE_HAS_UNCOMMITTED_CHANGES');
      const storage = storageClient({ url, serviceKey: env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY });
      const inventory = await storage.inventory();
      const authConfig = await authenticationConfig(ref, env.ORQUIVIA_BACKUP_ACCESS_TOKEN);
      const databaseDigest = await databaseFingerprint(databaseEnv, { psql: env.ORQUIVIA_BACKUP_PSQL || 'psql' });
      const authDigest = configurationFingerprint(authConfig);
      const filename = `orquivia-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.orqbackup`;
      const output = resolve(outputDirectory, filename);
      const source = { projectRef: ref, commit, storageObjects: inventory.objects.length, storageInventorySha256: inventory.digest,
        databaseSha256: databaseDigest, authConfigurationSha256: authDigest,
        recoveryCompleteness: 'Operator-confirmed external secrets; source fingerprints compared before and after capture. This detects changes but is not an atomic cross-service snapshot or a tested restoration.' };
      const result = await writeArchive({ output, key, source,
        validateManifest: assertRecoveryContents,
        entries: sourceEntries({ databaseEnv, repositoryRoot, revision: commit, storage, inventory, authConfig, recovery,
          pgDump: env.ORQUIVIA_BACKUP_PG_DUMP || 'pg_dump', pgDumpAll: env.ORQUIVIA_BACKUP_PG_DUMPALL || 'pg_dumpall', psql: env.ORQUIVIA_BACKUP_PSQL || 'psql' }),
        beforeManifest: () => assertCaptureStable({ storage, inventoryDigest: inventory.digest,
          readAuth: () => authenticationConfig(ref, env.ORQUIVIA_BACKUP_ACCESS_TOKEN), authDigest,
          readDatabase: () => databaseFingerprint(databaseEnv, { psql: env.ORQUIVIA_BACKUP_PSQL || 'psql' }), databaseDigest }),
      });
      assertRecoveryContents(result);
      const info = await stat(output);
      return { status: 'captured-and-verified', recoveryTested: false, file: output, encryptedBytes: info.size, entries: result.entryCount, originalBytes: result.bytes, sourceCommit: commit };
    }
    if (!args['--file']) throw failure('BACKUP_FILE_REQUIRED');
    const manifest = await verifyArchive({ file: resolve(args['--file']), key });
    assertRecoveryContents(manifest);
    if (args.command === 'verify') return { status: 'authenticated-and-verified', recoveryTested: false, entries: manifest.entryCount, originalBytes: manifest.bytes, createdAt: manifest.createdAt };
    const plan = restorePlan({ manifest, targetUrl: args['--target-url'], targetDatabaseUrl: env.ORQUIVIA_RESTORE_DATABASE_URL,
      acknowledgeIsolation: args['--ack-isolated'], baseEnv: env });
    if (args.command === 'extract') {
      if (!args['--output-dir']) throw failure('BACKUP_EXTRACTION_DESTINATION_REQUIRED');
      return { ...await extractArchive({ file: resolve(args['--file']), key, directory: args['--output-dir'], repositoryRoot }), targetRef: plan.targetRef };
    }
    return plan;
  } finally { key.fill(0); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) {
    // Do not print stack traces, server responses, object names, connection strings or secrets.
    const code = typeof error.code === 'string' && /^(?:BACKUP|RESTORE)_[A-Z_]+$/.test(error.code) ? error.code : 'BACKUP_FAILED';
    console.error(JSON.stringify({ status: 'failed', code, message: messages[code] || 'La operación no ha terminado. No se confirma una copia ni una recuperación correctas.' }));
    process.exitCode = 1;
  }
}
