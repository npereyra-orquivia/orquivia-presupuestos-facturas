import { randomUUID } from 'node:crypto';
import { PRODUCTION_PROJECT_REF, projectRef } from './source.mjs';

const fail = code => Object.assign(new Error(code), { code });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const codes = new Set(['SCHEDULED_BACKUP_DISABLED','SCHEDULED_BACKUP_CONTEXT_INVALID',
  'SCHEDULED_BACKUP_READINESS_REQUIRED','SCHEDULED_BACKUP_PROJECT_INVALID','SCHEDULED_BACKUP_DRIFT_CHECKS_REQUIRED',
  'SCHEDULED_BACKUP_TEMP_REQUIRED','SCHEDULED_BACKUP_CAPTURE_FAILED','SCHEDULED_BACKUP_CAPTURE_INVALID',
  'SCHEDULED_BACKUP_UPLOAD_FAILED','SCHEDULED_BACKUP_UPLOAD_INVALID','SCHEDULED_BACKUP_EVIDENCE_FAILED',
  'SCHEDULED_BACKUP_EVIDENCE_INVALID','SCHEDULED_BACKUP_FAILED']);

/** Optional until migration 017 and the specific organization's reporter are configured. */
export function backupEvidenceConfiguration(env = {}) {
  const enabled = env.ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED;
  if (enabled === undefined || enabled === '' || enabled === 'false') return null;
  if (enabled !== 'true' || projectRef(env.ORQUIVIA_BACKUP_SUPABASE_URL) !== PRODUCTION_PROJECT_REF
    || !uuid.test(env.ORQUIVIA_BACKUP_ORGANIZATION_ID || '')
    || typeof env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY !== 'string' || env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY.length < 30
    || /\s/.test(env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY)) throw fail('SCHEDULED_BACKUP_EVIDENCE_INVALID');
  return { url: new URL(env.ORQUIVIA_BACKUP_SUPABASE_URL).origin,
    organizationId: env.ORQUIVIA_BACKUP_ORGANIZATION_ID, serviceKey: env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY };
}

async function responseObject(response) {
  if (!response.ok || !response.body || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
    || Number(response.headers.get('content-length') || 0) > 4096) throw fail('SCHEDULED_BACKUP_EVIDENCE_FAILED');
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > 4096) throw fail('SCHEDULED_BACKUP_EVIDENCE_FAILED');
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    try { return JSON.parse(body.toString('utf8')); }
    finally { body.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

export function createBackupHealthReporter(env = {}, { fetchFn = fetch } = {}) {
  const config = backupEvidenceConfiguration(env);
  if (!config) return null;
  const attemptId = randomUUID();
  async function record(phase, report) {
    try {
      const response = await fetchFn(`${config.url}/rest/v1/rpc/record_orquivia_backup_attempt`, {
        method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(25_000),
        headers: { apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}`, 'Content-Type':'application/json' },
        body: JSON.stringify({ p_organization_id:config.organizationId, p_attempt_id:attemptId, p_phase:phase, p_report:report }),
      });
      if (response.redirected) throw fail('SCHEDULED_BACKUP_EVIDENCE_FAILED');
      const value = await responseObject(response);
      if (!value || value.recorded !== true || value.phase !== phase) throw fail('SCHEDULED_BACKUP_EVIDENCE_FAILED');
    } catch { throw fail('SCHEDULED_BACKUP_EVIDENCE_FAILED'); }
  }
  return {
    started: () => record('started', {}),
    async succeeded(captured, uploaded) {
      const evidence = uploaded?.operationalEvidence;
      if (!evidence || evidence.sourceCommit !== captured.sourceCommit || !/^[a-f0-9]{40}$/.test(evidence.sourceCommit || '')
        || !Number.isSafeInteger(evidence.storageObjects) || evidence.storageObjects < 0 || evidence.storageObjects > 100000
        || !Number.isSafeInteger(evidence.storageBytes) || evidence.storageBytes < 0 || evidence.storageBytes > 20_000_000_000
        || !Number.isSafeInteger(uploaded.encryptedBytes) || uploaded.encryptedBytes < 1 || uploaded.encryptedBytes > 40_000_000_000
        || uploaded.checksumVerified !== true || uploaded.permissionsChecked !== true
        || !/^[a-f0-9]{64}$/.test(evidence.archiveSha256 || '')) throw fail('SCHEDULED_BACKUP_EVIDENCE_INVALID');
      await record('succeeded', { sourceCommit:evidence.sourceCommit, encryptedBytes:uploaded.encryptedBytes,
        storageObjects:evidence.storageObjects, storageBytes:evidence.storageBytes,
        checksumVerified:true, permissionsChecked:true, archiveSha256:evidence.archiveSha256 });
    },
    failed: code => record('failed', { errorCode:codes.has(code) ? code : 'SCHEDULED_BACKUP_FAILED' }),
  };
}
