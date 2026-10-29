import test from 'node:test';
import assert from 'node:assert/strict';
import { capacityLevel, collectOperationsHealth, formatCapacityBytes, renderOperationsHealth, classifyOperationsEvidence,
  BACKUP_STALE_AFTER_MS, BACKUP_ATTEMPT_UNFINISHED_AFTER_MS, WORKSPACE_STATE_LIMIT_BYTES } from '../src/operations-health.js';

const snapshot = () => ({ company: { name: 'Orquivia' }, clients: [], documents: [], payments: [], expenses: [], taxRecords: [] });
const evidence = () => ({ serverTime: '2026-10-28T12:00:00.000Z',
  lastAttempt: { status: 'succeeded', startedAt: '2026-10-28T10:58:00.000Z', finishedAt: '2026-10-28T11:00:00.000Z', errorCode: null },
  lastSuccess: { finishedAt: '2026-10-28T11:00:00.000Z', sourceCommit: 'a'.repeat(40), encryptedBytes: 20_000_000,
    storageObjects: 42, storageBytes: 10_000_000, checksumVerified: true, permissionsChecked: true }, lastRestore: null });
const receipt = { evidenceReceivedAt: 100, now: 100 };

test('capacity counts UTF-8 bytes of the loaded snapshot rather than text characters or file sizes', () => {
  const state = snapshot();
  state.company.name = 'Orquivia · 日本';
  state.expenses.push({ attachments: [{ path: 'org/gasto/file.pdf', size: 9_000_000 }] });
  const health = collectOperationsHealth(state);
  assert.equal(health.stateBytes, Buffer.byteLength(JSON.stringify(state), 'utf8'));
  assert.ok(health.stateBytes > JSON.stringify(state).length);
  assert.equal(health.stateLimit, 5_000_000);
  assert.equal(health.knownFileBytes, 9_000_000);
  assert.equal(health.stateLevel, 'normal');
});

test('collection capacity uses the complete combined document history', () => {
  const state = snapshot();
  state.documents = [{ kind: 'quote', status: 'draft', date: '2025-01-01' }, { kind: 'quote', status: 'sent', date: '2026-01-01' }, { kind: 'invoice', status: 'issued', date: '2026-10-01' }];
  state.expenses = [{}, {}];
  state.taxRecords = [{}];
  const records = collectOperationsHealth(state).records;
  assert.equal(records.find(record => record.key === 'documents').count, 3);
  assert.equal(records.find(record => record.key === 'expenses').count, 2);
  assert.equal(records.find(record => record.key === 'taxRecords').count, 1);
  assert.ok(records.every(record => record.limit === 10_000));
});

test('referenced files are counted once across expenses and tax records and do not pretend to be a storage quota', () => {
  const state = snapshot();
  state.expenses = [{ attachments: [{ path: 'org/a/a.pdf', size: 2500 }, { id: 'unknown-file' }] }];
  state.taxRecords = [{ attachments: [{ path: 'org/a/a.pdf', size: 2500 }, { path: 'org/b/b.pdf', size: 1000 }] }];
  const health = collectOperationsHealth(state);
  assert.equal(health.fileCount, 3);
  assert.equal(health.knownFileBytes, 3500);
  assert.equal(health.unknownFileSizes, 1);
  assert.equal(health.storageQuota, undefined);
  assert.equal(health.lastBackup, undefined);
});

test('unmeasurable snapshots report unknown capacity instead of zero or success', () => {
  const state = snapshot(); state.circular = state;
  const health = collectOperationsHealth(state);
  assert.equal(health.stateBytes, null);
  assert.equal(health.stateLevel, 'unknown');
  assert.equal(formatCapacityBytes(health.stateBytes), 'Sin calcular');
});

test('capacity warnings start before the hard limit and report exactly reached or exceeded limits', () => {
  const limit = WORKSPACE_STATE_LIMIT_BYTES;
  for (const [fraction, expected] of [[0, 'normal'], [0.749, 'normal'], [0.75, 'watch'], [0.899, 'watch'], [0.9, 'warning'], [0.999, 'warning'], [1, 'full'], [1.1, 'full']]) {
    assert.equal(capacityLevel(limit * fraction, limit), expected);
  }
  assert.equal(capacityLevel(null, limit), 'unknown');
  assert.equal(capacityLevel(-1, limit), 'unknown');
});

test('health panel is absent unless the caller has an explicit authorized admin role', () => {
  for (const role of [undefined, null, 'editor', 'admin-other', '']) {
    assert.equal(renderOperationsHealth(snapshot(), { role }), '');
  }
  const markup = renderOperationsHealth(snapshot(), { role: 'admin', version: '1.4.1' });
  assert.match(markup, /Estado del portal/);
  assert.match(markup, /Versión 1\.4\.1/);
  assert.match(markup, /Pendiente de verificar/);
  assert.match(markup, /No hay una comprobación automática conectada/);
  assert.match(markup, /ni mide el almacenamiento total de Supabase/);
  assert.match(markup, /JSON compacto/);
  assert.match(markup, /servidor puede ocupar más/);
  assert.doesNotMatch(markup, /Respaldo correcto|Última copia correcta|Todo protegido/);
});

test('health presentation escapes external version text and never exposes business records or file paths', () => {
  const state = snapshot();
  state.company.name = 'Empresa secreta';
  state.expenses = [{ description: 'Gasto privado', attachments: [{ path: 'org/secreto/documento.pdf', size: 5000 }] }];
  const markup = renderOperationsHealth(state, { role: 'admin', version: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(markup, /<img|Empresa secreta|Gasto privado|org\/secreto/);
  assert.match(markup, /&lt;img/);
});

test('reaching either record or byte limits produces a visible planning warning', () => {
  const records = snapshot(); records.documents = Array.from({ length: 10_000 }, () => ({}));
  const markup = renderOperationsHealth(records, { role: 'admin' });
  assert.match(markup, /Límite alcanzado/);
  assert.match(markup, /Revisa la capacidad antes de seguir creciendo/);
  const bytes = snapshot(); bytes.company.notes = 'a'.repeat(WORKSPACE_STATE_LIMIT_BYTES);
  assert.equal(collectOperationsHealth(bytes).stateLevel, 'full');
});

test('weekly recency uses server time plus elapsed receipt time and expires exactly at eight days', () => {
  assert.equal(classifyOperationsEvidence(evidence(), receipt).status, 'recent');
  assert.equal(BACKUP_STALE_AFTER_MS, 8 * 24 * 60 * 60 * 1000);
  for (const backupAgeHours of [36, 7 * 24]) {
    const elapsed = (backupAgeHours - 1) * 60 * 60 * 1000;
    const result = classifyOperationsEvidence(evidence(), { ...receipt, now: 100 + elapsed });
    assert.equal(result.status, 'recent');
    assert.equal(result.backupAgeMs, backupAgeHours * 60 * 60 * 1000);
  }
  const elapsedUntilStale = BACKUP_STALE_AFTER_MS - 60 * 60 * 1000;
  assert.equal(classifyOperationsEvidence(evidence(), { ...receipt, now: 100 + elapsedUntilStale - 1 }).status, 'recent');
  const stale = classifyOperationsEvidence(evidence(), { ...receipt, now: 100 + elapsedUntilStale });
  assert.equal(stale.status, 'stale'); assert.equal(stale.backupAgeMs, BACKUP_STALE_AFTER_MS);
  // Both receipt clock values may be monotonic values unrelated to wall time.
  assert.equal(classifyOperationsEvidence(evidence(), { evidenceReceivedAt: 1, now: 1 }).status, 'recent');
  assert.equal(classifyOperationsEvidence(evidence(), { ...receipt, now: 99 }).status, 'unconfirmed');
  assert.equal(classifyOperationsEvidence(evidence()).status, 'unconfirmed');
  const markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: evidence(), ...receipt });
  assert.match(markup, /Programación: domingos\. Aviso de antigüedad a partir de 8 días\./);
});

test('a failed or running attempt never inherits a green state from an earlier successful copy', () => {
  const failed = evidence();
  failed.lastAttempt = { status: 'failed', startedAt: '2026-10-28T11:30:00.000Z', finishedAt: '2026-10-28T11:40:00.000Z', errorCode: 'SCHEDULED_BACKUP_UPLOAD_FAILED' };
  assert.equal(classifyOperationsEvidence(failed, receipt).status, 'failed');
  const markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: failed, ...receipt });
  assert.match(markup, /Último intento fallido/); assert.match(markup, /Última copia verificada/);
  assert.doesNotMatch(markup, /Copia verificada reciente|SCHEDULED_BACKUP_UPLOAD_FAILED/);
  const running = evidence();
  running.lastAttempt = { status: 'started', startedAt: '2026-10-28T11:50:00.000Z', finishedAt: null, errorCode: null };
  assert.equal(classifyOperationsEvidence(running, receipt).status, 'running');
  assert.equal(classifyOperationsEvidence(running, { ...receipt, now: 100 + BACKUP_STALE_AFTER_MS }).status, 'stale');
  const staleFailure = renderOperationsHealth(snapshot(), { role: 'admin', evidence: failed, ...receipt, now: 100 + BACKUP_STALE_AFTER_MS });
  assert.match(staleFailure, /Último intento fallido/); assert.match(staleFailure, /Han pasado 8 días o más/);
});

test('an unfinished attempt becomes an alert at three hours and never remains in progress indefinitely', () => {
  const value = evidence();
  value.lastAttempt = { status: 'started', startedAt: '2026-10-28T11:50:00.000Z', finishedAt: null, errorCode: null };
  const elapsedUntilUnfinished = BACKUP_ATTEMPT_UNFINISHED_AFTER_MS - 10 * 60 * 1000;
  assert.equal(classifyOperationsEvidence(value, { ...receipt, now: 100 + elapsedUntilUnfinished - 1 }).status, 'running');
  assert.equal(classifyOperationsEvidence(value, { ...receipt, now: 100 + elapsedUntilUnfinished }).status, 'unfinished');
  let markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt, now: 100 + elapsedUntilUnfinished });
  assert.match(markup, /Intento sin finalizar/); assert.doesNotMatch(markup, /Copia en curso|En curso/);
  markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt, now: 100 + BACKUP_STALE_AFTER_MS });
  assert.match(markup, /Copia sin actualizar/); assert.match(markup, /Sin finalizar/); assert.doesNotMatch(markup, /Copia en curso|En curso/);
});

test('malformed, incomplete or future evidence cannot confirm a current copy', () => {
  const changes = [
    value => { value.serverTime = '2026-02-30T12:00:00Z'; },
    value => { value.lastSuccess.finishedAt = '2026-10-29T11:00:00Z'; },
    value => { value.lastAttempt.startedAt = '2026-10-28T11:01:00Z'; },
    value => { value.lastSuccess.encryptedBytes = -1; },
    value => { value.lastSuccess.encryptedBytes = 0; },
    value => { value.lastSuccess.storageObjects = 1.5; },
    value => { value.lastSuccess.storageBytes = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.lastSuccess.checksumVerified = 'true'; },
    value => { value.lastSuccess.permissionsChecked = false; },
    value => { value.lastSuccess.sourceCommit = '<img src=x onerror=alert(1)>'; },
    value => { value.lastAttempt = null; },
    value => { value.lastSuccess = null; },
  ];
  for (const change of changes) {
    const value = evidence(); change(value);
    assert.equal(classifyOperationsEvidence(value, receipt).status, 'invalid');
    const markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
    assert.match(markup, /Pendiente de verificar/); assert.doesNotMatch(markup, /Copia verificada reciente|<img/);
  }
  for (const value of [true, { backupHealthy: true }, { status: 'success', recoveryTested: true }]) {
    assert.equal(classifyOperationsEvidence(value, receipt).status, 'invalid');
  }
});

test('the presentation retains verified historical numbers without exposing arbitrary evidence fields or request errors', () => {
  const value = evidence();
  value.privatePath = 'private/recovery/secret-record.json';
  value.lastSuccess.ownerEmail = 'private@example.test';
  const markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
  assert.match(markup, /Copia verificada reciente/); assert.match(markup, /42 archivos · 10 MB/); assert.match(markup, /20 MB/);
  assert.match(markup, /Código del respaldo/); assert.match(markup, /aaaaaaaa/);
  assert.doesNotMatch(markup, /secret-record|private@example|recoveryTested/);
  const unavailable = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt, evidenceError: 'SECRET request body' });
  assert.match(unavailable, /No se pudo consultar/); assert.doesNotMatch(unavailable, /Copia verificada reciente|SECRET/);
  assert.equal(classifyOperationsEvidence(value, { ...receipt, evidenceLoading: true }).status, 'loading');
});

test('restoration remains pending after a successful backup until a valid report identifies its exact scope', () => {
  let value = evidence();
  let markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
  assert.match(markup, /Pendiente de comprobar/);
  assert.match(markup, /Una copia verificada no demuestra que se haya probado su recuperación/);
  assert.doesNotMatch(markup, /Último ensayo registrado|sistema completo para esa versión/);
  value.lastRestore = { verifiedAt: '2026-10-28T11:30:00.000Z', sourceCommit: 'b'.repeat(40), reportSha256: 'c'.repeat(64), scope: 'business-data-and-originals' };
  markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
  assert.match(markup, /Último ensayo registrado/); assert.match(markup, /No acredita la recuperación de las cuentas ni del segundo factor/);
  assert.doesNotMatch(markup, /sistema completo para esa versión/);
  value.lastRestore.scope = 'full-system';
  markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
  assert.match(markup, /El informe acredita un ensayo del sistema completo para esa versión/);
  value.lastRestore.reportSha256 = 'incomplete';
  markup = renderOperationsHealth(snapshot(), { role: 'admin', evidence: value, ...receipt });
  assert.match(markup, /Pendiente de comprobar/); assert.doesNotMatch(markup, /Último ensayo registrado/);
  value = { serverTime: '2026-10-28T12:00:00.000Z', lastAttempt: null, lastSuccess: null, lastRestore: null };
  assert.equal(classifyOperationsEvidence(value, receipt).status, 'pending');
});
