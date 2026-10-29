import { escapeHTML } from './domain.js';

// These are application validation limits, not a Supabase subscription quota.
export const WORKSPACE_STATE_LIMIT_BYTES = 5_000_000;
export const WORKSPACE_COLLECTION_LIMIT = 10_000;
// Weekly Sunday copies allow one extra day before reporting missing evidence.
export const BACKUP_STALE_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
export const BACKUP_ATTEMPT_UNFINISHED_AFTER_MS = 3 * 60 * 60 * 1000;
const collections = Object.freeze([
  ['clients', 'Clientes'],
  ['documents', 'Presupuestos y facturas'],
  ['payments', 'Cobros'],
  ['expenses', 'Gastos'],
  ['taxRecords', 'Declaraciones'],
]);
const numbers = new Intl.NumberFormat('es-ES', { useGrouping: 'always', maximumFractionDigits: 0 });
const decimals = new Intl.NumberFormat('es-ES', { useGrouping: 'always', maximumFractionDigits: 2 });

export function capacityLevel(value, limit) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(limit) || limit <= 0) return 'unknown';
  if (value >= limit) return 'full';
  if (value >= limit * 0.9) return 'warning';
  if (value >= limit * 0.75) return 'watch';
  return 'normal';
}

export function formatCapacityBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Sin calcular';
  if (bytes < 1000) return `${numbers.format(bytes)} B`;
  if (bytes < 1_000_000) return `${decimals.format(bytes / 1000)} kB`;
  if (bytes < 1_000_000_000) return `${decimals.format(bytes / 1_000_000)} MB`;
  return `${decimals.format(bytes / 1_000_000_000)} GB`;
}

/** A local snapshot only: no secret, file body, remote quota or backup success is inferred. */
export function collectOperationsHealth(state) {
  let stateBytes = null;
  try {
    const json = JSON.stringify(state);
    if (typeof json === 'string') stateBytes = new TextEncoder().encode(json).length;
  } catch { /* An unmeasurable snapshot must never be reported as zero. */ }
  const records = collections.map(([key, label]) => {
    const count = Array.isArray(state?.[key]) ? state[key].length : 0;
    return { key, label, count, limit: WORKSPACE_COLLECTION_LIMIT, level: capacityLevel(count, WORKSPACE_COLLECTION_LIMIT) };
  });
  const files = new Map();
  for (const key of ['expenses', 'taxRecords']) {
    for (const record of Array.isArray(state?.[key]) ? state[key] : []) {
      for (const attachment of Array.isArray(record?.attachments) ? record.attachments : []) {
        // A repeated reference must not inflate the known size. Keep unknown
        // identities distinct rather than treating separate files as one.
        const identity = attachment?.path || attachment?.id || Symbol();
        if (files.has(identity)) continue;
        files.set(identity, Number.isSafeInteger(attachment?.size) && attachment.size > 0 ? attachment.size : null);
      }
    }
  }
  const knownFileBytes = [...files.values()].reduce((total, bytes) => total + (bytes ?? 0), 0);
  return {
    stateBytes, stateLimit: WORKSPACE_STATE_LIMIT_BYTES,
    stateLevel: capacityLevel(stateBytes, WORKSPACE_STATE_LIMIT_BYTES),
    records, fileCount: files.size, knownFileBytes,
    unknownFileSizes: [...files.values()].filter(bytes => bytes === null).length,
  };
}

function meter(value, limit, label) {
  if (!Number.isFinite(value)) return '';
  return `<meter min="0" max="${limit}" low="${limit * 0.75}" high="${limit * 0.9}" optimum="0" value="${Math.min(value, limit)}" aria-label="${escapeHTML(label)}"></meter>`;
}

const capacityMessages = Object.freeze({
  normal: 'Disponible', watch: 'Conviene planificar la ampliación',
  warning: 'Cerca del límite', full: 'Límite alcanzado', unknown: 'Sin calcular',
});

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const closedCode = value => value === null || (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,80}$/.test(value));
const evidenceDate = new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Madrid' });

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, minute, second] = match.map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || h > 23 || minute > 59 || second > 59) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

/** Consume only the closed evidence DTO, never an arbitrary status flag or error message. */
function normalizeEvidence(value) {
  if (!object(value)) return null;
  const serverTime = timestamp(value.serverTime);
  if (serverTime === null) return null;
  let lastAttempt = null, lastSuccess = null, lastRestore = null;
  if (value.lastAttempt != null) {
    const entry = value.lastAttempt;
    if (!object(entry) || !['started', 'succeeded', 'failed'].includes(entry.status) || !closedCode(entry.errorCode)) return null;
    const startedAt = timestamp(entry.startedAt), finishedAt = entry.finishedAt === null ? null : timestamp(entry.finishedAt);
    if (startedAt === null || startedAt > serverTime || (entry.status === 'started'
      ? entry.finishedAt !== null || entry.errorCode !== null
      : finishedAt === null || finishedAt < startedAt || finishedAt > serverTime || (entry.status === 'succeeded' && entry.errorCode !== null))) return null;
    lastAttempt = { status: entry.status, startedAt, finishedAt };
  }
  if (value.lastSuccess != null) {
    const entry = value.lastSuccess;
    if (!object(entry) || !commit(entry.sourceCommit) || !count(entry.encryptedBytes) || entry.encryptedBytes === 0
      || !count(entry.storageObjects) || !count(entry.storageBytes) || entry.checksumVerified !== true || entry.permissionsChecked !== true) return null;
    const finishedAt = timestamp(entry.finishedAt);
    if (finishedAt === null || finishedAt > serverTime || !lastAttempt
      || (lastAttempt.finishedAt !== null && finishedAt > lastAttempt.finishedAt)
      || (lastAttempt.status === 'succeeded' && finishedAt !== lastAttempt.finishedAt)) return null;
    lastSuccess = { finishedAt, sourceCommit: entry.sourceCommit, encryptedBytes: entry.encryptedBytes,
      storageObjects: entry.storageObjects, storageBytes: entry.storageBytes };
  } else if (lastAttempt?.status === 'succeeded') return null;
  if (value.lastRestore != null) {
    const entry = value.lastRestore;
    if (!object(entry) || !commit(entry.sourceCommit) || !digest(entry.reportSha256)
      || !['business-data-and-originals', 'full-system'].includes(entry.scope)) return null;
    const verifiedAt = timestamp(entry.verifiedAt);
    if (verifiedAt === null || verifiedAt > serverTime) return null;
    lastRestore = { verifiedAt, scope: entry.scope, sourceCommit: entry.sourceCommit };
  }
  return { serverTime, lastAttempt, lastSuccess, lastRestore };
}

/**
 * The receipt anchor belongs to the authenticated RPC request. It must be kept
 * by the caller; replacing it on every render would freeze the evidence age.
 * A device clock offset from the server is harmless. A clock rollback after
 * receipt makes recency unknown rather than silently extending a green state.
 */
export function classifyOperationsEvidence(value, { evidenceReceivedAt, now = Date.now(), evidenceLoading = false, evidenceError = false } = {}) {
  const evidence = normalizeEvidence(value);
  if (evidenceLoading === true) return { status: 'loading', evidence };
  if (evidenceError) return { status: 'unavailable', evidence };
  if (!evidence) return { status: value == null ? 'pending' : 'invalid', evidence: null };
  if (!Number.isFinite(evidenceReceivedAt) || evidenceReceivedAt < 0 || !Number.isFinite(now) || now < evidenceReceivedAt) return { status: 'unconfirmed', evidence };
  const effectiveNow = evidence.serverTime + (now - evidenceReceivedAt);
  const age = evidence.lastSuccess ? effectiveNow - evidence.lastSuccess.finishedAt : null;
  const backupStale = age !== null && age >= BACKUP_STALE_AFTER_MS;
  const attemptUnfinished = evidence.lastAttempt?.status === 'started'
    && effectiveNow - evidence.lastAttempt.startedAt >= BACKUP_ATTEMPT_UNFINISHED_AFTER_MS;
  const context = { evidence, backupAgeMs: age, backupStale, attemptUnfinished };
  if (evidence.lastAttempt?.status === 'failed') return { status: 'failed', ...context };
  if (backupStale) return { status: 'stale', ...context };
  if (evidence.lastAttempt?.status === 'started') {
    return { status: attemptUnfinished ? 'unfinished' : 'running', ...context };
  }
  return { status: evidence.lastSuccess ? 'recent' : 'pending', ...context };
}

const evidenceMessages = Object.freeze({
  loading: ['Consultando el servidor', 'Estamos consultando la evidencia de las copias.'],
  unavailable: ['No se pudo consultar', 'No se ha podido actualizar la evidencia del servidor. Revisa la conexión antes de dar la copia por comprobada.'],
  pending: ['Pendiente de verificar', 'No hay una comprobación automática conectada a este panel o todavía no se ha registrado una copia verificada.'],
  invalid: ['Pendiente de verificar', 'La evidencia recibida no permite confirmar el estado de la copia.'],
  unconfirmed: ['Antigüedad sin confirmar', 'Vuelve a consultar la evidencia del servidor. No se puede confirmar que haya una copia reciente.'],
  running: ['Copia en curso', 'Hay un intento iniciado. Solo se confirmará cuando termine la captura, la subida y sus verificaciones.'],
  unfinished: ['Intento sin finalizar', 'Han pasado tres horas o más desde el inicio y no consta un resultado final. Revisa la ejecución antes de dar la copia por terminada.'],
  failed: ['Último intento fallido', 'El último intento no se confirma como copia válida. Una copia anterior, si consta, se muestra debajo.'],
  stale: ['Copia sin actualizar', 'Han pasado 8 días o más sin una nueva copia verificada. Revisa la ejecución semanal.'],
  recent: ['Copia verificada reciente', 'La captura y la subida constan verificadas, incluido el contenido transferido y las personas autorizadas en Drive.'],
});

function renderEvidence(value, options) {
  const result = classifyOperationsEvidence(value, options), { evidence, status } = result;
  const [defaultLabel, defaultMessage] = evidenceMessages[status];
  const label = status === 'pending' && evidence ? 'Sin copia registrada' : defaultLabel;
  const message = status === 'pending' && evidence ? 'El servidor todavía no tiene una captura y subida verificadas registradas para este panel.' : defaultMessage;
  const date = value => escapeHTML(evidenceDate.format(new Date(value)));
  const attempt = evidence?.lastAttempt, success = evidence?.lastSuccess, restore = evidence?.lastRestore;
  const attempts = { started: result.attemptUnfinished ? 'Sin finalizar' : status === 'running' ? 'En curso' : 'Sin final registrado', succeeded: 'Finalizado', failed: 'Fallido' };
  return `<div class="operations-health-verification" data-evidence-status="${status}"><strong>Copias y recuperación</strong><span role="status">${label}</span><p>${message}</p>
    <p class="operations-health-note">Programación: domingos. Aviso de antigüedad a partir de 8 días.</p>
    ${evidence ? `<dl class="operations-health-evidence"><div><dt>Último intento</dt><dd>${attempt ? `${attempts[attempt.status]} · ${date(attempt.finishedAt ?? attempt.startedAt)}` : 'Sin registrar'}</dd></div>
      <div><dt>Última copia verificada</dt><dd>${success ? date(success.finishedAt) : 'Sin registrar'}</dd></div>
      ${success ? `<div><dt>Archivo cifrado</dt><dd>${formatCapacityBytes(success.encryptedBytes)}</dd></div><div><dt>Originales del respaldo</dt><dd>${numbers.format(success.storageObjects)} archivos · ${formatCapacityBytes(success.storageBytes)}</dd></div><div><dt>Código del respaldo</dt><dd><code>${success.sourceCommit.slice(0, 8)}</code></dd></div>` : ''}</dl>` : ''}
    ${result.backupStale && status !== 'stale' ? '<p class="operations-health-warning">Han pasado 8 días o más sin una nueva copia verificada.</p>' : ''}
    <div class="operations-health-restore"><strong>Recuperación</strong><span>${restore ? 'Último ensayo registrado' : 'Pendiente de comprobar'}</span>
      ${restore ? `<p>${date(restore.verifiedAt)} · código <code>${restore.sourceCommit.slice(0, 8)}</code>. ${restore.scope === 'full-system' ? 'El informe acredita un ensayo del sistema completo para esa versión.' : 'El informe acredita la recuperación de datos y originales. No acredita la recuperación de las cuentas ni del segundo factor.'}</p>` : '<p>Una copia verificada no demuestra que se haya probado su recuperación. Este apartado solo cambia cuando existe un informe de un ensayo real.</p>'}</div>
    <p class="operations-health-note">Esta evidencia no mide las cuotas totales del proveedor ni confirma los avisos de supervisión pública.</p></div>`;
}

/** Caller must supply the authorized workspace role, never a form/query value. */
export function renderOperationsHealth(state, { role, version = '', evidence = null, ...evidenceOptions } = {}) {
  if (role !== 'admin') return '';
  const health = collectOperationsHealth(state);
  const important = health.stateLevel !== 'normal' || health.records.some(record => record.level !== 'normal');
  const stateLabel = `${formatCapacityBytes(health.stateBytes)} de ${formatCapacityBytes(health.stateLimit)}`;
  return `<section class="card settings-card operations-health" aria-labelledby="operations-health-title">
    <div class="operations-health-heading"><h2 id="operations-health-title">Estado del portal</h2><span>Versión ${escapeHTML(version || 'sin indicar')}</span></div>
    <p class="settings-copy">Capacidad orientativa de los datos que tienes cargados. Se actualiza al recargar la empresa.</p>
    <div class="operations-health-resource" data-capacity="${health.stateLevel}"><div><strong>Datos de la empresa</strong><span>${stateLabel}</span></div>${meter(health.stateBytes, health.stateLimit, `Datos de la empresa: ${stateLabel}`)}<small>${capacityMessages[health.stateLevel]}. Mide el JSON compacto, sin PDF ni fotografías originales. La representación del servidor puede ocupar más y alcanzar antes su límite.</small></div>
    ${important ? '<p class="operations-health-warning" role="status">Revisa la capacidad antes de seguir creciendo. Ampliar el almacenamiento no elimina los límites internos de la aplicación.</p>' : ''}
    <details class="operations-health-details"><summary>Ver registros y justificantes</summary><dl>${health.records.map(record => `<div data-capacity="${record.level}"><dt>${record.label}</dt><dd>${numbers.format(record.count)} de ${numbers.format(record.limit)}<small>${capacityMessages[record.level]}</small></dd></div>`).join('')}</dl>
      <p class="operations-health-note">Presupuestos, facturas y borradores comparten un límite de todo el histórico; no es una cuota mensual.</p>
      <div class="operations-health-files"><strong>Justificantes referenciados</strong><span>${numbers.format(health.fileCount)} archivos · ${formatCapacityBytes(health.knownFileBytes)}${health.unknownFileSizes ? ` · ${numbers.format(health.unknownFileSizes)} sin tamaño conocido` : ''}</span></div>
      <p class="operations-health-note">Suma los tamaños guardados en gastos y declaraciones. No comprueba los archivos ni mide el almacenamiento total de Supabase, perfiles o copias de correo.</p>
    </details>
    ${renderEvidence(evidence, evidenceOptions)}
  </section>`;
}
