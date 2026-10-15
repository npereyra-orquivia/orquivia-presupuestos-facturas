import { escapeHTML as esc, money } from './domain.js';
import { mailStatus } from './mail-domain.js';

const fields = {
  kind: 'Tipo', number: 'Número', clientId: 'Cliente', date: 'Fecha', dueDate: 'Vencimiento / validez',
  contractExpectedDate: 'Fecha de seguimiento', contractReceived: 'Aceptación / contrato', title: 'Referencia interna',
  status: 'Estado', items: 'Conceptos', vat: 'IVA', withholding: 'Retención', discount: 'Descuento',
  notes: 'Notas y condiciones', po: 'Orden de pedido (PO)', paymentMethod: 'Método de pago', total: 'Total',
  companySnapshot: 'Datos de empresa del documento', clientSnapshot: 'Datos del cliente del documento', quoteId: 'Presupuesto vinculado',
  paymentReviewNeeded: 'Confirmación del cobro', name: 'Nombre', taxId: 'NIF', address: 'Dirección', email: 'Correo', phone: 'Teléfono',
  supplier: 'Proveedor', supplierTaxId: 'NIF del proveedor', description: 'Concepto', category: 'Categoría', base: 'Base imponible',
  vatAmount: 'Importe de IVA', vatRate: 'Tipo de IVA', vatDeductibleAmount: 'IVA para el gestor', vatReviewNeeded: 'Revisión fiscal',
  vatDocumentStatus: 'IVA del justificante', reviewNeeded: 'Revisión del justificante', paymentStatus: 'Estado del pago',
  paidDate: 'Fecha del pago', reference: 'Referencia', attachments: 'Justificantes', additionalAmount: 'Suplidos / importe adicional',
  cashAmount: 'Importe pagado', cashMovements: 'Pagos del gasto', documentId: 'Factura vinculada', amount: 'Importe',
  openingBalance: 'Saldo inicial', openingBalanceDate: 'Día de inicio', legalName: 'Razón social', iban: 'Cuenta bancaria',
  model: 'Modelo tributario', year: 'Ejercicio fiscal', quarter: 'Trimestre fiscal', linkedExpenseId: 'Pago incluido en gasto del gestor', missingReceiptReason: 'Motivo de falta de justificante',
  paymentTerms: 'Plazo de pago', other: 'Otros datos del registro', sourceMetadata: 'Datos del archivo de origen',
  originalNumber: 'Número original', importWarnings: 'Advertencias de importación', reviewRequired: 'Revisión del documento', id: 'Identificador',
};
export function historyFieldLabel(name) { return fields[name] || 'Otros datos del registro'; }
export function captureOperationScope({ getMode, getIdentity, getBackend, getGeneration }) {
  const mode = getMode(), identity = getIdentity(), backend = getBackend(), generation = getGeneration();
  return () => getMode() === mode && getIdentity() === identity && getBackend() === backend && getGeneration() === generation;
}
export async function runScopedOperation(isCurrent, operation, { onSuccess, onError, onFinally }) {
  try {
    const result = await operation();
    if (!isCurrent()) return false;
    return onSuccess(result);
  } catch (error) {
    if (!isCurrent()) return false;
    return onError(error);
  } finally {
    if (isCurrent()) onFinally?.();
  }
}
const dateTime = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid', dateStyle: 'medium', timeStyle: 'short' }) : 'Fecha no disponible';
};
const recordType = { document: 'Documento', expense: 'Gasto', client: 'Cliente', payment: 'Cobro', company: 'Empresa', tax: 'Declaración' };
function historyAction(entry) {
  const action = { created: 'creado', updated: 'actualizado', deleted: 'eliminado' }[entry.action] || 'actualizado';
  if (entry.entityType === 'payment') return { created: 'Cobro registrado', updated: 'Cobro actualizado', deleted: 'Cobro eliminado' }[entry.action] || 'Cobro actualizado';
  if (entry.event === 'issue' && entry.entityType === 'document') return 'Documento emitido';
  return `${recordType[entry.entityType] || 'Registro'} ${action}`;
}
export function renderHistoryEntries(entries) {
  if (!entries.length) return '<p class="record-history-empty">Aún no hay cambios en el historial detallado de este registro. Los cambios anteriores siguen disponibles en el historial general de Configuración.</p>';
  return `<ol class="record-history-list">${entries.map(entry => `<li><strong>${esc(entry.actorEmail || 'Cuenta autorizada')}</strong><span>${esc(historyAction(entry))} · ${esc(dateTime(entry.createdAt))}</span><small>${esc([...new Set(entry.changedFields || [])].map(historyFieldLabel).join(', ') || 'Sin cambios de campos')} · versión ${esc(String(entry.workspaceVersion ?? '—'))}</small></li>`).join('')}</ol>`;
}
const text = value => typeof value === 'string' ? value : '';
const timestamp = value => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
};
const addressKey = value => text(value).trim().toLowerCase();
const recipientText = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').join(', ') : text(value);

/** Project only the public history fields; credentials and raw MIME never enter the view model. */
export function mergeRecordHistory(entries = [], jobs = []) {
  if (!Array.isArray(entries) || !Array.isArray(jobs)) throw new Error('El historial recibido no es válido.');
  const changes = entries.map((entry, index) => ({
    kind: 'change', id: `change:${entry.id ?? `${entry.entityType}:${entry.entityId}:${entry.createdAt}:${index}`}`,
    historyId: entry.id, entityType: entry.entityType, entityId: entry.entityId, actorEmail: text(entry.actorEmail),
    action: entry.action, event: entry.event, changedFields: Array.isArray(entry.changedFields) ? [...new Set(entry.changedFields.filter(field => typeof field === 'string'))] : [],
    workspaceVersion: entry.workspaceVersion, createdAt: entry.createdAt,
  }));
  const mailById = new Map();
  for (const job of jobs) {
    if (typeof job?.id !== 'string' || !job.id.trim() || job.id.length > 160 || /[\u0000-\u001f\u007f]/.test(job.id)) throw new Error('El historial de envíos recibido no es válido.');
    if (mailById.has(job.id)) continue;
    mailById.set(job.id, {
      kind: 'mail', id: `mail:${job.id}`, jobId: job.id, documentId: text(job.documentId),
      sender: text(job.sender || job.from), to: recipientText(job.to), cc: recipientText(job.cc), subject: text(job.subject),
      status: text(job.status), partial: job.errorCode === 'SMTP_PARTIAL', accepted: recipientText(job.accepted), rejected: recipientText(job.rejected),
      createdAt: timestamp(job.sentAt) !== null ? job.sentAt : job.createdAt, requestedAt: job.createdAt,
    });
  }
  const mail = [...mailById.values()], absorbed = new Set();
  for (const change of changes) {
    if (change.event !== 'email_sent' || change.entityType !== 'document' || change.action !== 'updated'
      || change.changedFields.length !== 1 || change.changedFields[0] !== 'status'
      || !addressKey(change.actorEmail) || timestamp(change.createdAt) === null) continue;
    const candidates = mail.filter(entry => !entry.stateChange && !entry.partial && ['sent', 'archive_pending'].includes(entry.status)
      && addressKey(entry.sender) === addressKey(change.actorEmail)
      && (!entry.documentId || !change.entityId || entry.documentId === change.entityId)
      && timestamp(entry.createdAt) !== null && Math.abs(timestamp(entry.createdAt) - timestamp(change.createdAt)) <= 5000)
      .map(entry => ({ entry, distance: Math.abs(timestamp(entry.createdAt) - timestamp(change.createdAt)) }))
      .sort((a, b) => a.distance - b.distance);
    // A tie is ambiguous: keep the audit event rather than guessing a pairing.
    if (!candidates.length || candidates[1]?.distance === candidates[0].distance) continue;
    candidates[0].entry.stateChange = { historyId: change.historyId, workspaceVersion: change.workspaceVersion,
      actorEmail: change.actorEmail, changedFields: change.changedFields, createdAt: change.createdAt };
    absorbed.add(change);
  }
  return [...changes.filter(change => !absorbed.has(change)), ...mail].sort((a, b) => {
    const difference = (timestamp(b.createdAt) ?? -Infinity) - (timestamp(a.createdAt) ?? -Infinity);
    return Number.isNaN(difference) || difference === 0 ? a.id.localeCompare(b.id) : difference;
  });
}

function mailHistoryEntry(entry) {
  const status = mailStatus(entry.status), label = entry.partial ? 'Envío parcial · por revisar' : ({
    sent: 'Correo enviado', archive_pending: 'Correo enviado · copia pendiente', failed: 'Correo no enviado',
    uncertain: 'Resultado del envío por confirmar', sending: 'Envío en curso',
  })[entry.status] || status.label;
  const stateChange = entry.stateChange;
  return `<li class="record-history-mail" data-history-id="${esc(entry.id)}"><strong>${esc(entry.sender || 'Cuenta autorizada')}</strong><span class="record-history-action">${esc(label)} · ${esc(dateTime(entry.createdAt))}</span><dl class="record-history-mail-fields"><div><dt>Para</dt><dd>${esc(entry.to || 'No disponible')}</dd></div>${entry.cc ? `<div><dt>CC</dt><dd>${esc(entry.cc)}</dd></div>` : ''}<div><dt>Asunto</dt><dd>${esc(entry.subject || 'Sin asunto')}</dd></div>${entry.status !== 'sent' || entry.partial ? `<div><dt>Estado</dt><dd>${esc(entry.partial ? 'El servidor aceptó solo algunos destinatarios. Revisa tu correo antes de repetir el envío.' : status.description)}</dd></div>` : ''}${entry.partial ? `<div><dt>Aceptados</dt><dd>${esc(entry.accepted || 'Por confirmar')}</dd></div><div><dt>Rechazados</dt><dd>${esc(entry.rejected || 'Por confirmar')}</dd></div>` : ''}</dl>${stateChange ? `<small data-history-audit-id="${esc(String(stateChange.historyId ?? ''))}">Estado del documento actualizado · ${esc(stateChange.changedFields.map(historyFieldLabel).join(', '))} · versión ${esc(String(stateChange.workspaceVersion ?? '—'))}</small>` : ''}</li>`;
}

export function renderUnifiedHistory(entries, jobs) {
  const timeline = mergeRecordHistory(entries, jobs);
  if (!timeline.length) return '<p class="record-history-empty">Aún no hay cambios ni envíos en el historial detallado de este registro. Los cambios anteriores siguen disponibles en el historial general de Configuración.</p>';
  return `<ol class="record-history-list record-history-timeline">${timeline.map(entry => entry.kind === 'mail' ? mailHistoryEntry(entry)
    : `<li data-history-id="${esc(entry.id)}"><strong>${esc(entry.actorEmail || 'Cuenta autorizada')}</strong><span>${esc(entry.event === 'email_sent' && entry.entityType === 'document' ? 'Estado marcado como enviado por correo' : historyAction(entry))} · ${esc(dateTime(entry.createdAt))}</span><small>${esc(entry.changedFields.map(historyFieldLabel).join(', ') || 'Sin cambios de campos')} · versión ${esc(String(entry.workspaceVersion ?? '—'))}</small></li>`).join('')}</ol>`;
}

export function recordHistoryMarkup(entityType, entityId, { includeMail = false } = {}) {
  if (!entityId) return '';
  return `<details class="record-history" data-record-history data-entity-type="${esc(entityType)}" data-entity-id="${esc(entityId)}"${includeMail ? ' data-include-mail="true"' : ''}><summary>${includeMail ? 'Historial de cambios y envíos' : 'Historial de cambios'}</summary><div data-history-content><p>${includeMail ? 'Consulta quién editó este registro y el resultado de cada envío por correo.' : 'Consulta quién ha editado este registro y qué campos cambió.'}</p></div><button type="button" class="text-button" data-history-refresh>Actualizar historial</button></details>`;
}
export function bindRecordHistory(root, ctx) {
  const controllers = [...root.querySelectorAll('[data-record-history]')].map(details => {
    const content = details.querySelector('[data-history-content]'), refresh = details.querySelector('[data-history-refresh]');
    const mode = ctx.getMode(), backend = ctx.getBackend(), identity = ctx.getIdentity();
    let active = true, request = 0, loaded = false;
    const isActive = () => active && details.isConnected && ctx.getMode() === mode && ctx.getBackend() === backend && ctx.getIdentity() === identity;
    const load = async () => {
      const token = ++request;
      if (!isActive()) return;
      if (mode !== 'cloud') { content.innerHTML = '<p>El historial compartido está disponible al trabajar con Supabase.</p>'; return; }
      content.innerHTML = '<p role="status">Cargando historial…</p>'; refresh.disabled = true;
      try {
        const includeMail = details.dataset.includeMail === 'true';
        const [entries, jobs] = includeMail ? await Promise.all([
          backend.recordHistory(details.dataset.entityType, details.dataset.entityId),
          backend.mail.history(details.dataset.entityId),
        ]) : [await backend.recordHistory(details.dataset.entityType, details.dataset.entityId), null];
        if (token !== request || !isActive()) return;
        content.innerHTML = includeMail ? renderUnifiedHistory(entries, jobs) : renderHistoryEntries(entries); loaded = true;
      } catch (error) {
        if (token === request && isActive()) content.innerHTML = `<p role="alert">${esc(error.message)}</p>`;
      } finally { if (token === request && isActive()) refresh.disabled = false; }
    };
    details.ontoggle = () => { if (details.open && !loaded) load(); };
    refresh.onclick = load;
    return () => { active = false; ++request; details.ontoggle = null; refresh.onclick = null; };
  });
  const dispose = () => controllers.forEach(controller => controller());
  ctx.registerModalCleanup?.(dispose);
  return dispose;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function changedRecordFields(before, after) {
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter(key => key !== 'id' && !equal(before?.[key], after?.[key])).sort();
}
const collections = { document: 'documents', expense: 'expenses', client: 'clients', payment: 'payments', tax: 'taxRecords' };
export function compareWorkspaceEdits(base, draft, current, { documentId } = {}) {
  const rows = [];
  function add(entityType, id, before, proposed, latest) {
    const localFields = changedRecordFields(before, proposed);
    if (!localFields.length && !(entityType === 'document' && id === documentId)) return;
    const remoteFields = current ? changedRecordFields(before, latest) : [];
    const overlappingFields = localFields.filter(key => remoteFields.includes(key) && !equal(proposed?.[key], latest?.[key]));
    rows.push({ entityType, entityId: id, before, proposed, latest, localFields, remoteFields, overlappingFields,
      label: proposed?.number || proposed?.description || proposed?.name || proposed?.title || before?.number || before?.description || recordType[entityType] });
  }
  for (const [entityType, key] of Object.entries(collections)) {
    const originals = new Map((base[key] || []).map(record => [record.id, record]));
    const proposed = new Map((draft[key] || []).map(record => [record.id, record]));
    const latest = new Map((current?.[key] || []).map(record => [record.id, record]));
    for (const id of new Set([...originals.keys(), ...proposed.keys()])) add(entityType, id, originals.get(id), proposed.get(id), latest.get(id));
  }
  add('company', 'company', base.company, draft.company, current?.company);
  return rows;
}
function comparisonValue(value, key, record, entityType) {
  if (value === undefined) return '—';
  if (entityType === 'expense' && record?.vatReviewNeeded && ['base', 'vatAmount', 'vatDeductibleAmount'].includes(key)) return key === 'vatDeductibleAmount' ? 'No confirmado' : 'Sin confirmar';
  if (typeof value === 'boolean') return value ? 'Sí' : 'No';
  if (value === null || value === '') return 'Vacío';
  if (!Object.hasOwn(fields, key)) return 'Modificado';
  let text;
  if (key === 'items' && Array.isArray(value)) text = value.map(item => `${item.description || 'Concepto'} · ${item.quantity} × ${money(item.price)}${item.detail ? '\n' + item.detail : ''}`).join('\n\n');
  else if (key === 'attachments' && Array.isArray(value)) text = value.map(file => `${file.name || 'Justificante'}${file.size ? ' · ' + Math.ceil(file.size / 1024) + ' KB' : ''}`).join('\n') || 'Sin justificantes';
  else if (key === 'cashMovements' && Array.isArray(value)) text = value.map(payment => `${payment.date || 'Sin fecha'} · ${money(payment.amount)}`).join('\n') || 'Sin pagos';
  else if (['total', 'base', 'vatAmount', 'vatDeductibleAmount', 'additionalAmount', 'cashAmount', 'amount', 'openingBalance'].includes(key) && typeof value === 'number') text = money(value);
  else if (key === 'vatDocumentStatus') text = { 'included-unitemized': 'IVA incluido, sin desglose', 'not-stated': 'Justificante sin datos de IVA' }[value] || 'Por revisar';
  else if (key === 'paymentStatus') text = { paid: 'Pagado', pending: 'Pendiente', 'no-payment': 'Sin ingreso', unconfirmed: 'Pago por confirmar', included: 'Incluido en pago al gestor' }[value] || String(value);
  else if (key === 'status') text = { draft: 'Borrador', issued: 'Emitida', ready: 'Preparado', sent: 'Enviado', accepted: 'Aceptado', rejected: 'Rechazado' }[value] || String(value);
  else if (key === 'kind') text = { quote: 'Presupuesto', invoice: 'Factura', credit: 'Abono / devolución' }[value] || String(value);
  else if (typeof value === 'object') text = Object.entries(value).filter(([name]) => Object.hasOwn(fields, name)).map(([name, item]) => `${historyFieldLabel(name)}: ${typeof item === 'object' ? 'Datos del registro' : item ?? 'Vacío'}`).join('\n') || 'Datos del registro';
  else text = String(value);
  return esc(text.length > 1800 ? text.slice(0, 1800) + '…' : text);
}
export function renderConflictComparison(rows) {
  if (!rows.length) return '<p>No se ha guardado la acción. La empresa cambió desde que abriste esta sesión.</p>';
  return rows.map(row => `<section class="edit-conflict-record"><h4>${esc(recordType[row.entityType] || 'Registro')} · ${esc(row.label)}</h4><p>${!row.latest && row.before ? 'Este registro se ha eliminado en la versión actual.' : row.remoteFields.length ? 'La versión guardada también cambió este registro.' : 'Este registro no cambió; otra parte de la empresa se actualizó.'}</p>${row.overlappingFields.length ? '<p class="edit-conflict-overlap">Hay campos editados en ambas sesiones. Revisa ambas versiones antes de volver a introducir tus cambios.</p>' : ''}<div class="edit-conflict-table"><table><thead><tr><th>Campo</th><th>Tu último intento de guardado</th><th>Versión actual guardada</th></tr></thead><tbody>${[...new Set([...row.localFields, ...row.remoteFields])].map(key => `<tr${row.overlappingFields.includes(key) ? ' class="is-overlap"' : ''}><th>${esc(historyFieldLabel(key))}</th><td>${comparisonValue(row.proposed?.[key], key, row.proposed, row.entityType)}</td><td>${comparisonValue(row.latest?.[key], key, row.latest, row.entityType)}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
}
export function captureFormDraft(root) {
  const forms = [...root.querySelectorAll('form')];
  return forms.map(form => ({ form: form.id, fields: [...form.querySelectorAll('input,select,textarea')].filter(input => input.type !== 'password').map(input => ({
    name: input.name || input.dataset.line || input.id || input.getAttribute('aria-label') || 'Campo',
    value: input.type === 'file' ? [...(input.files || [])].map(file => file.name) : input.type === 'checkbox' ? input.checked : input.value,
  })) }));
}
