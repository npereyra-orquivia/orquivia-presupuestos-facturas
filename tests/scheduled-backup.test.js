import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scheduledConfiguration, runScheduled, scheduledFailure } from '../scripts/backup/run-scheduled.mjs';

const RECOVERY = { edgeSecrets: {}, edgeFunctions: [], authSmtp: {}, storageConfiguration: {},
  verifiedAt: '2026-10-27T12:00:00Z', confirmedComplete: true, captureMode: 'drift-checked' };
const ENV = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'npereyra-orquivia/orquivia-presupuestos-facturas',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'schedule', ORQUIVIA_BACKUPS_ENABLED: 'true',
  ORQUIVIA_BACKUP_RESTORE_REHEARSED: 'true', ORQUIVIA_BACKUP_SUPABASE_URL: 'https://tfaglecwycbamibnhqmq.supabase.co',
  ORQUIVIA_BACKUP_RECOVERY_JSON: JSON.stringify(RECOVERY), ORQUIVIA_DRIVE_UPLOAD_ENABLED: 'true',
  ORQUIVIA_DRIVE_ALLOWED_EMAILS: 'owner@example.test,reviewer@example.test',
  ORQUIVIA_DRIVE_FOLDER_ID: 'fixture_private_folder_1234', ORQUIVIA_DRIVE_CLIENT_ID: '123456789-test.apps.googleusercontent.com',
  ORQUIVIA_DRIVE_CLIENT_SECRET: 'fixture-only-client-secret', ORQUIVIA_DRIVE_REFRESH_TOKEN: 'fixture-only-refresh-token-not-real' };
const COMMIT = 'a'.repeat(40);

async function fixture(t) {
  const temp = await mkdtemp(join(tmpdir(), 'orquivia-scheduled-test-'));
  t.after(async () => { assert.ok(temp.startsWith(join(tmpdir(), 'orquivia-scheduled-test-'))); await rm(temp, { recursive: true, force: true }); });
  const calls = [], env = { ...ENV, RUNNER_TEMP: temp };
  const capture = async (args, actualEnv) => {
    calls.push({ kind: 'capture', args, env: actualEnv });
    const file = join(args[2], 'orquivia-fixture.orqbackup'); await writeFile(file, 'fixture-ciphertext');
    return { status: 'captured-and-verified', recoveryTested: false, file, encryptedBytes: 18, sourceCommit: COMMIT };
  };
  const upload = async options => {
    calls.push({ kind: 'upload', options });
    return { status: 'uploaded-and-verified', recoveryTested: false, encryptedBytes: 18, checksumVerified: true, permissionsChecked: true };
  };
  return { temp, env, calls, capture, upload };
}

test('scheduled backup is disabled by default and before any source or upload work', async t => {
  const f = await fixture(t);
  for (const value of [undefined, '', 'false', 'TRUE', '1']) {
    await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_BACKUPS_ENABLED: value }, f), { code: 'SCHEDULED_BACKUP_DISABLED' });
  }
  assert.deepEqual(f.calls, []);
});

test('only an explicitly ready official main workflow may capture', async t => {
  const f = await fixture(t);
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'someone/fork' },
    { GITHUB_REF: 'refs/heads/preview' }, { GITHUB_EVENT_NAME: 'pull_request' }, { GITHUB_EVENT_NAME: 'push' }]) {
    await assert.rejects(runScheduled({ ...f.env, ...patch }, f), { code: 'SCHEDULED_BACKUP_CONTEXT_INVALID' });
  }
  await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_BACKUP_RESTORE_REHEARSED: '' }, f), { code: 'SCHEDULED_BACKUP_READINESS_REQUIRED' });
  assert.deepEqual(f.calls, []);
  scheduledConfiguration({ ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' });
});

test('scheduled runs reject the legacy quiet claim, another project, or absent Drive consent', async t => {
  const f = await fixture(t);
  await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_BACKUP_RECOVERY_JSON: JSON.stringify({ ...RECOVERY, captureMode: undefined, confirmedQuietCapture: true }) }, f), { code: 'SCHEDULED_BACKUP_DRIFT_CHECKS_REQUIRED' });
  await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_BACKUP_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co' }, f), { code: 'SCHEDULED_BACKUP_PROJECT_INVALID' });
  await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_DRIVE_UPLOAD_ENABLED: undefined }, f), { code: 'DRIVE_UPLOAD_NOT_AUTHORIZED' });
  await assert.rejects(runScheduled({ ...f.env, ORQUIVIA_DRIVE_ALLOWED_EMAILS: undefined }, f), { code: 'DRIVE_ALLOWED_EMAILS_INVALID' });
  assert.deepEqual(f.calls, []);
});

test('capture and upload use a unique runner temp directory and emit only a safe summary', async t => {
  const f = await fixture(t), first = await runScheduled(f.env, f), second = await runScheduled(f.env, f);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map(call => call.kind), ['capture', 'upload', 'capture', 'upload']);
  assert.equal(f.calls[0].args[0], 'create'); assert.equal(f.calls[0].args[1], '--output-dir');
  assert.ok(f.calls[0].args[2].startsWith(join(f.temp, 'orquivia-encrypted-backup-')));
  assert.notEqual(f.calls[0].args[2], f.calls[2].args[2]);
  assert.equal(f.calls[1].options.file, join(f.calls[0].args[2], 'orquivia-fixture.orqbackup'));
  assert.equal(f.calls[1].options.env, f.env);
  assert.deepEqual(first, { status: 'captured-and-uploaded-verified', encryptedBytes: 18, checksumVerified: true,
    permissionsChecked: true, sourceCommit: COMMIT, recoveryTested: false });
  assert.deepEqual(second, first); assert.equal(JSON.stringify(first).includes(f.temp), false);
});

test('a missing, relative or repository temp destination stops capture', async t => {
  const f = await fixture(t);
  for (const value of [undefined, '', 'relative-temp']) await assert.rejects(runScheduled({ ...f.env, RUNNER_TEMP: value }, f), { code: 'SCHEDULED_BACKUP_TEMP_REQUIRED' });
  await assert.rejects(runScheduled({ ...f.env, RUNNER_TEMP: resolve('.') }, f), { code: 'BACKUP_DESTINATION_INSIDE_REPOSITORY' });
  assert.deepEqual(f.calls, []);
});

test('capture failure aborts upload without forwarding diagnostic payloads', async t => {
  const f = await fixture(t);
  const capture = async () => { throw new Error('fixture-only-private-server-response'); };
  await assert.rejects(runScheduled(f.env, { ...f, capture }), error => {
    assert.deepEqual(scheduledFailure(error), { status: 'failed', code: 'SCHEDULED_BACKUP_CAPTURE_FAILED',
      message: 'La copia programada no se confirma. Revisar la ejecución sin compartir secretos; no reintentar a ciegas una subida incierta.' });
    return true;
  });
  assert.deepEqual(f.calls, []);
});

test('unverified, foreign or inconsistent capture output can never be uploaded', async t => {
  const f = await fixture(t);
  for (const patch of [{ status: 'partial' }, { recoveryTested: true }, { file: join(f.temp, 'foreign.orqbackup') },
    { encryptedBytes: 19 }, { sourceCommit: 'not-a-revision' }]) {
    const capture = async (...args) => ({ ...await f.capture(...args), ...patch });
    await assert.rejects(runScheduled(f.env, { ...f, capture }), { code: 'SCHEDULED_BACKUP_CAPTURE_INVALID' });
  }
  assert.equal(f.calls.some(call => call.kind === 'upload'), false);
});

test('an uncertain upload is attempted once and never triggers a second capture or upload', async t => {
  const f = await fixture(t); let attempts = 0;
  const upload = async () => { attempts++; throw new Error('fixture-only-sensitive-upload-session'); };
  await assert.rejects(runScheduled(f.env, { ...f, upload }), { code: 'SCHEDULED_BACKUP_UPLOAD_FAILED' });
  assert.equal(attempts, 1); assert.equal(f.calls.filter(call => call.kind === 'capture').length, 1);
});

test('success requires destination checks and never infers a tested restoration', async t => {
  const f = await fixture(t);
  for (const patch of [{ status: 'pending' }, { recoveryTested: true }, { checksumVerified: false },
    { permissionsChecked: false }, { encryptedBytes: 17 }]) {
    const upload = async options => ({ ...await f.upload(options), ...patch });
    await assert.rejects(runScheduled(f.env, { ...f, upload }), { code: 'SCHEDULED_BACKUP_UPLOAD_INVALID' });
  }
  const summary = scheduledFailure({ code: 'UNKNOWN_FIXTURE_SECRET', message: 'fixture-only-secret' });
  assert.equal(summary.code, 'SCHEDULED_BACKUP_FAILED'); assert.equal(JSON.stringify(summary).includes('fixture-only-secret'), false);
});

test('evidence starts before capture and records success only after all upload checks',async t=>{
  const f=await fixture(t),order=[],env={...f.env,ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED:'true',
    ORQUIVIA_BACKUP_ORGANIZATION_ID:'f7200000-0000-4000-8000-000000000001',ORQUIVIA_BACKUP_SERVICE_ROLE_KEY:'fixture-only-service-credential-not-real'};
  const reporter={started:async()=>order.push('started'),succeeded:async(c,u)=>{order.push('succeeded');assert.equal(u.permissionsChecked,true);assert.equal(c.sourceCommit,COMMIT);},failed:async()=>order.push('failed')};
  await runScheduled(env,{...f,createReporter:()=>reporter,
    capture:async(...args)=>{order.push('capture');return f.capture(...args);},
    upload:async(options)=>{order.push('upload');assert.equal(options.includeEvidence,true);return f.upload(options);}});
  assert.deepEqual(order,['started','capture','upload','succeeded']);
});

test('an invalid upload or evidence failure never records success or repeats a capture/upload',async t=>{
  const f=await fixture(t),events=[];
  const reporter={started:async()=>events.push('started'),succeeded:async()=>events.push('succeeded'),failed:async code=>events.push(code)};
  await assert.rejects(runScheduled(f.env,{...f,createReporter:()=>reporter,
    upload:async options=>({...await f.upload(options),permissionsChecked:false})}),{code:'SCHEDULED_BACKUP_UPLOAD_INVALID'});
  assert.deepEqual(events,['started','SCHEDULED_BACKUP_UPLOAD_INVALID']);
  assert.equal(f.calls.filter(call=>call.kind==='upload').length,1);
  let captures=0;
  await assert.rejects(runScheduled(f.env,{...f,createReporter:()=>({...reporter,started:async()=>{throw Object.assign(new Error('private'),{code:'SCHEDULED_BACKUP_EVIDENCE_FAILED'});}}),
    capture:async()=>{captures++;}}),{code:'SCHEDULED_BACKUP_EVIDENCE_FAILED'});
  assert.equal(captures,0);
});
