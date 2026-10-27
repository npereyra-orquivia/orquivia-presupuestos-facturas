import { escapeHTML } from './domain.js';

// These are application validation limits, not a Supabase subscription quota.
export const WORKSPACE_STATE_LIMIT_BYTES = 5_000_000;
export const WORKSPACE_COLLECTION_LIMIT = 10_000;
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

/** Caller must supply the authorized workspace role, never a form/query value. */
export function renderOperationsHealth(state, { role, version = '' } = {}) {
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
    <div class="operations-health-verification"><strong>Copias y supervisión</strong><span>Pendiente de verificar</span><p>No hay una comprobación automática conectada a este panel. Una copia descargada no confirma que exista un respaldo completo ni que se haya probado su recuperación.</p></div>
  </section>`;
}
