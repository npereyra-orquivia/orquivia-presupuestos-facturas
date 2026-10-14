import './expenses.css';
import { money, todayISO, escapeHTML as esc } from './domain.js';
import { expenseTotals, splitExpenseTotal, splitExpenseTotalManual, cashSummary, expenseNeedsReview, expenseVATLabel } from './expenses.js';
import { validateReceiptFile, RECEIPT_FILE_TYPES } from './backend.js';
import { icon } from './icons.js';
import { recordHistoryMarkup, bindRecordHistory } from './history-ui.js';

const LOCAL_ORG = '00000000-0000-4000-8000-000000000001';
const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(String(value ?? ''))}" ${extra}></label>`;
const select = (label, name, options, value) => `<label class="field"><span>${label}</span><select name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(value) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
const dateLabel = date => new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
const categories = [['Servicios', 'Servicios profesionales'], ['Material', 'Material y equipos'], ['Transporte', 'Transporte'], ['Suministros', 'Suministros'], ['Comidas', 'Comidas y dietas'], ['Otros', 'Otros gastos']];
const fold = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es');
const needsReview = expenseNeedsReview;
let expenseQuery = '', expenseFilter = 'all', viewerRequest=0, activeViewer=null;

/** A missing voucher is an explicit record for the gestor, never fiscal evidence. */
export function applyReceiptRegistration(expense, { hasReceipt, acknowledged, reason }) {
  const next = { ...expense };
  if (hasReceipt) { delete next.missingReceiptReason; return next; }
  const explanation = String(reason || '').trim();
  if (!acknowledged || !explanation) throw new Error('Añade un justificante o marca «No tengo justificante» y explica el motivo.');
  if (explanation.length > 2000) throw new Error('El motivo de falta de justificante admite hasta 2000 caracteres.');
  next.missingReceiptReason = explanation;
  next.reviewNeeded = Boolean(expense.reviewNeeded);
  next.vatReviewNeeded = true;
  next.vatDocumentStatus = 'not-stated';
  next.vatAmount = 0;
  next.vatDeductibleAmount = 0;
  next.base = Number((next.total - (next.additionalAmount || 0)).toFixed(2));
  delete next.vatRate;
  return next;
}
const saveBlob = (blob, name) => {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
};

async function localDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('orquivia-local-receipts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function localFile(operation, path, file) {
  const db = await localDB();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('files', operation === 'get' ? 'readonly' : 'readwrite'), store = transaction.objectStore('files');
      const request = operation === 'get' ? store.get(path) : operation === 'put' ? store.put(file, path) : store.delete(path);
      let value;
      request.onsuccess = () => value = request.result;
      transaction.oncomplete = () => resolve(value);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar el archivo local.'));
    });
  } finally { db.close(); }
}
export async function localReceipt(attachment) {
  const blob = await localFile('get', attachment.path);
  if (!blob) throw new Error('No se encuentra el justificante local ' + attachment.name);
  return blob;
}
export async function storeLocalReceipt(recordId, file) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recordId)) throw new Error('El registro no tiene un identificador válido.');
  const valid = await validateReceiptFile(file), id = crypto.randomUUID(), path = `${LOCAL_ORG}/${recordId}/${id}.${valid.extension}`;
  await localFile('put', path, file);
  return { id, name: valid.name, path, mimeType: valid.mimeType, size: valid.size };
}
export async function deleteLocalReceipt(attachment) {
  await localFile('delete', attachment.path);
}

async function previewReceipts(ctx,attachments,initialIndex=0,{pendingFiles=new Map(),trigger,isCurrent=()=>true}={}){
  if(!attachments.length||ctx.getMode()==='locked')return;
  const request=++viewerRequest,mode=ctx.getMode(),backend=ctx.getBackend(),identity=ctx.getIdentity();
  const isActive=()=>ctx.getMode()===mode&&ctx.getBackend()===backend&&ctx.getIdentity()===identity&&isCurrent();
  if(trigger)trigger.disabled=true;
  try{
    const {openReceiptViewer}=await import('./receipt-viewer.js');
    if(request!==viewerRequest||!isActive()||trigger&&!trigger.isConnected)return;
    activeViewer?.dispose();let unregister=()=>{},controller=null;
    controller=openReceiptViewer({attachments:structuredClone(attachments),initialIndex,isActive,returnFocus:trigger,
      loadAttachment:async attachment=>{
        if(!isActive())throw new Error('La sesión ha cambiado. Vuelve a entrar para ver el justificante.');
        const file=pendingFiles.get(attachment.id);
        return file|| (mode==='cloud'?await backend.downloadReceipt(attachment):await localReceipt(attachment));
      },onClose:()=>{unregister();if(activeViewer===controller)activeViewer=null}});
    activeViewer=controller;unregister=ctx.registerModalCleanup(controller.dispose);
  }catch(error){if(isActive())ctx.toast(error.message,true)}finally{if(trigger?.isConnected)trigger.disabled=false}
}

export function cashCard(state) {
  const c = cashSummary(state);
  return `<section class="card cash-card"><div class="cash-main"><span class="eyebrow">TU SALDO SEGÚN EL REGISTRO</span><h2>${c.configured ? money(c.balance) : 'Configura tu saldo inicial'}</h2><p>${c.configured ? 'Saldo inicial + cobros − gastos e impuestos pagados desde ' + dateLabel(c.openingBalanceDate) + '.' : 'Indica el saldo al comienzo de un día para calcular lo que queda en caja o en cuenta.'}</p><button class="text-button" data-action="opening-balance">${c.configured ? 'Ajustar saldo inicial' : 'Añadir saldo inicial'}</button></div><div class="cash-metrics"><div><small>Cobros registrados${c.configured ? ' desde el inicio' : ''}</small><strong>${money(c.received)}</strong></div><div><small>Gastos e impuestos pagados${c.configured ? ' desde el inicio' : ''}</small><strong>${money(c.paidExpenses + (c.paidTaxes || 0))}</strong></div><div><small>Previsión tras cobrar y pagar pendientes</small><strong>${c.configured ? money(c.forecastBalance) : '—'}</strong></div></div><p class="cash-footnote">Saldo registrado para contrastar con el banco. Los cobros sin confirmar se excluyen de la previsión.</p></section>`;
}

export function expensesPage(state, preferences) {
  if (preferences) { expenseFilter = preferences.filter || 'all'; expenseQuery = preferences.query || ''; }
  const all = state.expenses || [], term = fold(expenseQuery);
  const matchesFilter = (e, filter) => filter === 'all' || (filter === 'review' ? needsReview(e) : e.paymentStatus === filter);
  const rows = all.filter(e => matchesFilter(e, expenseFilter) && fold([e.description, e.supplier, e.reference, e.category, e.notes].join(' ')).includes(term)).sort((a, b) => b.date.localeCompare(a.date));
  const filters = [['all', 'Todos'], ['paid', 'Pagados'], ['pending', 'Pendientes'], ['review', 'Por revisar']];
  return `<div class="page-heading"><div><div class="eyebrow">GASTOS</div><h1>Tus gastos, registrados al momento.</h1><p>Concepto, total y justificante. Si falta el ticket, deja una nota para el gestor.</p></div><button class="button primary" data-action="new-expense">+ Nuevo gasto</button></div>
  <section class="card expense-list"><div class="list-toolbar"><div class="search-box"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><input id="expense-search" placeholder="Buscar concepto, proveedor o número…" value="${esc(expenseQuery)}" aria-label="Buscar gastos"></div><span class="expense-list-note">Todo el histórico</span></div>
  <div class="tabs" role="group" aria-label="Filtrar gastos" aria-describedby="expense-filter-help">${filters.map(([value, label]) => `<button type="button" data-expense-filter="${value}" class="${expenseFilter === value ? 'selected' : ''}">${label}<span>${all.filter(e => matchesFilter(e, value)).length}</span></button>`).join('')}</div><p class="expense-filter-help" id="expense-filter-help">Un gasto pagado puede estar por revisar: el pago y la revisión del justificante se registran por separado.</p>
  <div class="table-scroll"><table><thead><tr><th>Concepto / proveedor</th><th>Fecha</th><th>Total</th><th>Pago</th><th>Justificantes</th><th></th></tr></thead><tbody>${rows.map(e => {
    const count = (e.attachments || []).length;
    return `<tr><td><button class="doc-link" data-expense="${esc(e.id)}"><span><strong>${esc(e.description)}</strong>${e.kind === 'credit' ? '<small class="expense-credit-note">Abono / devolución</small>' : ''}<small>${esc(e.supplier || e.category || 'Gasto registrado')}${e.reference ? ' · ' + esc(e.reference) : ''}</small>${needsReview(e) ? `<small class="expense-review-label">${e.vatReviewNeeded && !e.vatDocumentStatus ? 'IVA por revisar' : count ? 'Por revisar' : 'Falta justificante'}</small>` : ''}${e.vatDocumentStatus || !count && e.missingReceiptReason ? `<small class="expense-vat-document-label${!count && e.missingReceiptReason ? ' expense-missing-label' : ''}">${esc(expenseVATLabel(e))}</small>` : ''}</span></button></td><td class="date-cell">${dateLabel(e.date)}</td><td class="amount">${money(expenseTotals(e).total)}</td><td><span class="badge ${e.paymentStatus === 'paid' ? 'paid' : 'issued'}"><i></i>${e.paymentStatus === 'paid' ? e.kind === 'credit' ? 'Reembolsado' : 'Pagado' : 'Pendiente'}</span></td><td>${count?`<button type="button" class="text-button expense-preview-link" data-preview-expense="${esc(e.id)}" aria-label="Ver justificantes: ${esc(e.description)}">${icon('eye')}${count} ${count === 1 ? 'archivo' : 'archivos'}</button>`:`<span class="expense-file-count is-missing">${e.missingReceiptReason ? 'Sin justificante registrado' : 'Sin archivos'}</span>`}</td><td><button class="icon-btn" data-expense="${esc(e.id)}" aria-label="Editar gasto: ${esc(e.description)}">›</button></td></tr>`;
  }).join('') || `<tr><td colspan="6"><div class="expense-empty"><strong>${all.length ? 'No hay gastos con este filtro.' : 'Guarda tu primer justificante.'}</strong><p>${all.length ? 'Prueba con otro concepto o selecciona «Todos».' : 'Añade el concepto y el total, haz una foto o adjunta el archivo y guárdalo.'}</p>${all.length ? '<button class="button secondary" id="reset-expense-filter">Ver todos los gastos</button>' : '<button class="button secondary" data-action="new-expense">+ Nuevo gasto</button>'}</div></td></tr>`}</tbody></table></div>
  <div class="table-footer">${rows.length} ${rows.length === 1 ? 'gasto' : 'gastos'}<span>Selecciona un gasto para ver o editar sus datos</span></div></section>`;
}

export function bindExpenses(root, ctx) {
  root.querySelectorAll('[data-expense]').forEach(b => b.onclick = () => expenseModal(ctx, ctx.getState().expenses.find(e => e.id === b.dataset.expense)));
  root.querySelectorAll('[data-preview-expense]').forEach(b=>b.onclick=()=>{const expense=ctx.getState().expenses.find(e=>e.id===b.dataset.previewExpense);if(expense)expenseModal(ctx,expense)});
  root.querySelectorAll('[data-expense-filter]').forEach(b => b.onclick = () => {
    expenseFilter = b.dataset.expenseFilter;
    ctx.setViewState?.('expenses', { filter: expenseFilter, query: expenseQuery });
    ctx.render();
    root.querySelector(`[data-expense-filter="${expenseFilter}"]`)?.focus();
  });
  const search = root.querySelector('#expense-search');
  if (search) search.oninput = () => {
    const caret = search.selectionStart;
    expenseQuery = search.value;
    ctx.setViewState?.('expenses', { filter: expenseFilter, query: expenseQuery });
    ctx.render();
    const next = root.querySelector('#expense-search');
    next?.focus(); next?.setSelectionRange(caret, caret);
  };
  const reset = root.querySelector('#reset-expense-filter');
  if (reset) reset.onclick = () => { expenseQuery = ''; expenseFilter = 'all'; ctx.setViewState?.('expenses', { filter: expenseFilter, query: expenseQuery }); ctx.render(); };
}

export function openingBalanceModal(ctx) {
  const c = ctx.getState().company, editable = ctx.getMode() !== 'cloud' || ctx.getBackend()?.workspaceInfo()?.role === 'admin';
  ctx.openModal(ctx.modalHeader('Saldo inicial', 'El punto de partida para tu caja y tu cuenta.') + `<form id="opening-form"><div class="form-grid">${field('Saldo al comienzo del día (€)', 'openingBalance', c.openingBalance ?? '', 'number', 'step="0.01" required')}${field('Día de inicio', 'openingBalanceDate', c.openingBalanceDate || todayISO(), 'date', `max="${todayISO()}" required`)}</div><p class="field-hint">Introduce el saldo antes de los movimientos de ese día. Los cobros y gastos pagados desde esa fecha se añadirán o restarán. No se consulta el banco automáticamente.</p>${!editable ? '<p class="note-banner">Nicole puede ajustar el saldo inicial compartido.</p>' : ''}<div class="modal-actions"><button class="button secondary" type="button" data-close>Cancelar</button><button class="button primary" ${editable ? '' : 'disabled'}>Guardar saldo inicial</button></div></form>`);
  ctx.enhance();
  const form = ctx.modalRoot.querySelector('#opening-form');
  form.onsubmit = async e => {
    e.preventDefault(); if (!editable) return;
    const f = new FormData(form);
    if (await ctx.commit(s => { s.company.openingBalance = Number(f.get('openingBalance')); s.company.openingBalanceDate = f.get('openingBalanceDate'); }, 'Saldo inicial guardado.')) ctx.closeModal();
  };
}

export function expenseModal(ctx, expense) {
  const draft = structuredClone(expense || { id: crypto.randomUUID(), date: todayISO(), supplier: '', supplierTaxId: '', description: '', category: 'Otros', base: 0, vatAmount: 0, total: 0, vatDeductibleAmount: 0, vatReviewNeeded: true, paymentStatus: 'paid', paidDate: todayISO(), reference: '', notes: '', attachments: [] });
  const pending = [], removed = [], pendingIds = new WeakMap();
  draft.attachments ||= [];
  const originalAttachments = structuredClone(draft.attachments), isCredit = draft.kind === 'credit', hasCashMovements = Array.isArray(draft.cashMovements) && draft.cashMovements.length > 0;
  const expenseCategories=categories.some(([value])=>value===draft.category)||!draft.category?categories:[...categories,[draft.category,draft.category]];
  const cashDetails = hasCashMovements ? `<div class="expense-cash-evidence"><strong>Pagos registrados</strong>${draft.cashMovements.map(m => `<div><span>${dateLabel(m.date)}</span><b>${money(m.amount)}</b></div>`).join('')}<p>Estas fechas e importes se conservan al editar el gasto. Al guardarlo como pendiente se retirarán sus pagos del registro.</p></div>` : draft.cashAmount !== undefined ? `<div class="expense-cash-evidence"><strong>Importe pagado registrado</strong><div><span>Total del movimiento</span><b>${money(draft.cashAmount)}</b></div><p>Este importe puede diferir del justificante por descuentos o ajustes. Se conserva al editar el gasto; se retira si lo guardas como pendiente.</p></div>` : '';
  let verifyingFiles = 0;
  const knownRate = [0, 4, 10, 21].includes(draft.vatRate) && splitExpenseTotal(draft.total - (draft.additionalAmount || 0), draft.vatRate).vatAmount === draft.vatAmount;
  const vatChoice = draft.vatDocumentStatus || (draft.vatReviewNeeded ? 'review' : knownRate ? String(draft.vatRate) : 'manual');
  ctx.openModal(ctx.modalHeader(expense ? 'Editar gasto' : 'Nuevo gasto', 'Registra el gasto con su justificante o deja una nota si no lo tienes.') + `<div class="expense-editor-layout"><form id="expense-form" class="expense-quick-form">
  <div class="expense-quick-fields">${field('Concepto / nombre del gasto', 'description', draft.description, 'text', 'required maxlength="2000" placeholder="Comida, material, transporte…"')}
  <div class="form-grid expense-amount-grid">${field(isCredit ? 'Importe del abono, IVA incluido (€)' : 'Total, IVA incluido (€)', 'total', draft.total || '', 'number', `${isCredit ? 'max="-0.01"' : 'min="0.01"'} step="0.01" required inputmode="decimal" placeholder="0,00"`)}${select('IVA del justificante', 'vatRate', [['review', 'Por revisar'], ['included-unitemized', 'IVA incluido, sin desglose'], ['not-stated', 'Justificante sin datos de IVA'], ['21', '21%'], ['10', '10%'], ['4', '4%'], ['0', 'Sin IVA'], ['manual', 'Indicar importe de IVA']], vatChoice)}</div>
  <div id="manual-vat-field" ${vatChoice === 'manual' ? '' : 'hidden'}>${field('IVA que aparece en el documento (€)', 'vatAmount', draft.vatAmount, 'number', `${isCredit ? 'max="0"' : 'min="0"'} step="0.01" inputmode="decimal"`)}</div><p class="field-hint expense-vat-hint" id="expense-vat-hint"></p>
  <label class="checkbox-label expense-paid-toggle"><input name="alreadyPaid" type="checkbox" ${draft.paymentStatus === 'paid' ? 'checked' : ''}>${isCredit ? 'Reembolso recibido' : 'Ya está pagado'}</label><p class="field-hint expense-payment-warning" id="expense-cash-change-warning" hidden>Al guardar como pendiente se retirarán del saldo sus pagos registrados.</p><div class="expense-review-choice" id="expense-review-choice" hidden><p>Si ya has comprobado el documento y sus notas, puedes completar su revisión. El desglose de IVA seguirá identificado para el gestor.</p><button type="button" class="text-button" id="complete-expense-review">He revisado el justificante</button><span id="expense-review-feedback" role="status"></span></div></div>
  <section class="expense-receipts"><div class="expense-section-heading"><h3>Justificante</h3><span>Foto, archivo o nota</span></div><div class="receipt-actions"><label class="button primary">Tomar una foto<input class="visually-hidden" type="file" id="receipt-camera" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment"></label><label class="button secondary">Adjuntar archivos<input class="visually-hidden" type="file" id="receipt-files" multiple accept="${Object.keys(RECEIPT_FILE_TYPES).map(e => '.' + e).join(',')}"></label></div><div class="receipt-list" id="receipt-list"></div><p class="field-hint">PDF, fotos o documentos. Hasta 10 MB por archivo; se guardan privados.</p><div class="expense-missing-choice" id="expense-missing-choice"><label class="checkbox-label"><input name="noReceiptAcknowledged" type="checkbox" ${draft.missingReceiptReason && !draft.attachments.length ? 'checked' : ''}>No tengo justificante</label><div id="expense-missing-reason-field" hidden><label class="field"><span>Motivo de falta de justificante</span><textarea name="missingReceiptReason" rows="2" maxlength="2000" placeholder="He olvidado pedir el ticket en el bar del networking…">${esc(draft.missingReceiptReason || '')}</textarea></label><p class="field-hint">El gasto y el pago quedarán registrados con esta nota. El IVA seguirá sin confirmar para el gestor.</p></div></div></section>
  <details class="expense-details"><summary><span>Más detalles</span><small>Fecha, proveedor y datos para el gestor</small></summary><div class="expense-details-body"><div class="form-grid">${field('Fecha del justificante', 'date', draft.date, 'date', `required max="${todayISO()}"`)}${field(isCredit ? 'Fecha del reembolso' : 'Fecha del pago', 'paidDate', draft.paidDate || (expense ? draft.date : todayISO()), 'date', `max="${todayISO()}"`)}${field('Proveedor / comercio (opcional)', 'supplier', draft.supplier, 'text', 'maxlength="240"')}${field('NIF del proveedor (opcional)', 'supplierTaxId', draft.supplierTaxId, 'text', 'maxlength="80"')}${field('Número de factura o ticket (opcional)', 'reference', draft.reference, 'text', 'maxlength="240"')}${select('Categoría', 'category', expenseCategories, draft.category || 'Otros')}</div>${cashDetails}<div class="expense-section"><h3>Desglose para el gestor</h3>${field('Suplidos / importe adicional sin IVA (€)', 'additionalAmount', draft.additionalAmount || 0, 'number', `${isCredit ? 'max="0"' : 'min="0"'} step="0.01" inputmode="decimal"`)}${field('Base imponible (€)', 'base', draft.vatReviewNeeded ? '' : draft.base, 'number', 'readonly step="0.01"')}<p class="field-hint">Si hay varios tipos de IVA, selecciona «Indicar importe de IVA» y copia el total de IVA del documento.</p><label class="checkbox-label"><input name="deductible" type="checkbox" ${draft.vatDeductibleAmount !== 0 && draft.vatDeductibleAmount !== undefined ? 'checked' : ''}>IVA confirmado para revisión del gestor</label>${field('Importe de IVA confirmado (€)', 'vatDeductibleAmount', draft.vatDeductibleAmount || 0, 'number', 'min="0" step="0.01"')}<p class="field-hint">El gestor revisará si el gasto y su IVA son deducibles.</p></div><div class="expense-section"><label class="field"><span>Notas (opcional)</span><textarea name="notes" rows="2" maxlength="10000">${esc(draft.notes || '')}</textarea></label><label class="checkbox-label"><input name="reviewNeeded" type="checkbox" ${draft.reviewNeeded ? 'checked' : ''}>Revisar este justificante con el gestor</label></div></div></details>
  ${expense ? recordHistoryMarkup('expense', expense.id) : ''}</form><aside class="expense-preview-panel" aria-label="Justificante junto al formulario"><div class="expense-preview-heading"><span class="preview-label">${icon('eye')}VISTA PREVIA DEL JUSTIFICANTE</span><button type="button" class="text-button" id="expand-expense-preview" hidden>Ampliar visor</button></div><div id="expense-inline-preview"></div></aside></div><div class="modal-actions expense-editor-actions">${expense ? '<button type="button" class="text-button danger" id="remove-expense">Eliminar gasto</button>' : ''}<button class="button secondary" type="button" data-close>Cancelar</button><button type="submit" form="expense-form" class="button primary" id="save-expense">Guardar gasto</button></div>`, true);
  bindRecordHistory(ctx.modalRoot, ctx);
  const form = ctx.modalRoot.querySelector('#expense-form'), list = form.querySelector('#receipt-list'), save = ctx.modalRoot.querySelector('#save-expense');
  const previewHost = ctx.modalRoot.querySelector('#expense-inline-preview'), expandPreview = ctx.modalRoot.querySelector('#expand-expense-preview');
  const previewMode = ctx.getMode(), previewBackend = ctx.getBackend(), previewIdentity = ctx.getIdentity();
  const isPreviewActive = () => form.isConnected && ctx.getMode() === previewMode && ctx.getBackend() === previewBackend && ctx.getIdentity() === previewIdentity;
  let previewController = null, previewGeneration = 0, previewAttachments = [], pendingFiles = new Map();
  ctx.registerModalCleanup(() => { ++previewGeneration; previewController?.dispose(); previewController = null; });
  async function showInlinePreview(index = 0, force = false) {
    if (!isPreviewActive()) return;
    if (previewController && !force) { previewController.select(index); return; }
    const token = ++previewGeneration;
    previewController?.dispose(); previewController = null;
    expandPreview.hidden = !previewAttachments.length;
    if (!previewAttachments.length) {
      previewHost.innerHTML = `<div class="expense-preview-empty">${icon('eye')}<h3>Tu justificante, a la vista</h3><p>Haz una foto o adjunta un archivo. Si no lo tienes, registra el motivo en el formulario.</p></div>`;
      return;
    }
    previewHost.innerHTML = '<div class="expense-preview-empty"><p>Preparando la vista previa…</p></div>';
    const attachments = structuredClone(previewAttachments), pendingSnapshot = new Map(pendingFiles);
    try {
      const { mountReceiptViewer } = await import('./receipt-viewer.js');
      if (token !== previewGeneration || !isPreviewActive()) return;
      previewHost.replaceChildren();
      previewController = mountReceiptViewer({ attachments, initialIndex: index, parent: previewHost, isActive: isPreviewActive,
        loadAttachment: async attachment => {
          if (!isPreviewActive()) throw new Error('La sesión ha cambiado. Vuelve a entrar para ver el justificante.');
          return pendingSnapshot.get(attachment.id) || (previewMode === 'cloud' ? await previewBackend.downloadReceipt(attachment) : await localReceipt(attachment));
        } });
    } catch (error) {
      if (token === previewGeneration && isPreviewActive()) {
        previewHost.innerHTML = '<div class="expense-preview-empty"><h3>No se pudo abrir la vista previa</h3><p></p><button type="button" class="button secondary">Volver a intentar</button></div>';
        previewHost.querySelector('p').textContent = error.message;
        previewHost.querySelector('button').onclick = () => showInlinePreview(index, true);
      }
    }
  }
  expandPreview.onclick = () => {
    const token = previewGeneration;
    previewReceipts(ctx, previewAttachments, previewController?.getSelectedIndex() || 0, { pendingFiles, trigger: expandPreview, isCurrent: () => token === previewGeneration && isPreviewActive() });
  };
  form.addEventListener('invalid', e => { const details = e.target.closest('details'); if (details) details.open = true; }, true);
  function redrawFiles(preferredId) {
    const selectedId = preferredId || previewAttachments[previewController?.getSelectedIndex() || 0]?.id;
    list.innerHTML = draft.attachments.map((a, i) => `<div class="receipt-row"><div><strong>${esc(a.name)}</strong><small>${(a.size / 1024).toFixed(0)} KB · guardado</small></div><button type="button" class="text-button" data-preview-file="${i}" aria-label="Ver ${esc(a.name)}">${icon('eye')}Ver</button><button type="button" class="text-button" data-open-file="${i}">Descargar</button><button type="button" class="icon-btn danger" data-remove-file="${i}" aria-label="Quitar ${esc(a.name)}">×</button></div>`).join('') + pending.map((f, i) => `<div class="receipt-row"><div><strong>${esc(f.name)}</strong><small>${(f.size / 1024).toFixed(0)} KB · listo para guardar</small></div><button type="button" class="text-button" data-preview-pending="${i}" aria-label="Ver ${esc(f.name)}">${icon('eye')}Ver</button><button type="button" class="icon-btn danger" data-remove-pending="${i}" aria-label="Quitar ${esc(f.name)}">×</button></div>`).join('') || '<div class="expense-receipt-placeholder">Haz una foto, adjunta un archivo o indica que no tienes justificante.</div>';
    pendingFiles = new Map();
    previewAttachments=[...draft.attachments,...pending.map(file=>{const id=pendingIds.get(file);pendingFiles.set(id,file);return {id,name:file.name,mimeType:RECEIPT_FILE_TYPES[file.name.split('.').at(-1).toLowerCase()],size:file.size}})];
    list.querySelectorAll('[data-preview-file]').forEach(button=>button.onclick=()=>showInlinePreview(Number(button.dataset.previewFile)));
    list.querySelectorAll('[data-preview-pending]').forEach(button=>button.onclick=()=>showInlinePreview(draft.attachments.length+Number(button.dataset.previewPending)));
    list.querySelectorAll('[data-remove-file]').forEach(b => b.onclick = () => { removed.push(draft.attachments.splice(Number(b.dataset.removeFile), 1)[0]); redrawFiles(); });
    list.querySelectorAll('[data-remove-pending]').forEach(b => b.onclick = () => { pending.splice(Number(b.dataset.removePending), 1); redrawFiles(); });
    list.querySelectorAll('[data-open-file]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        if (!isPreviewActive()) return;
        const a = draft.attachments[Number(b.dataset.openFile)], blob = previewMode === 'cloud' ? await previewBackend.downloadReceipt(a) : await localReceipt(a);
        if (!isPreviewActive()) return;
        saveBlob(blob, a.name);
      } catch (e) { ctx.toast(e.message, true); } finally { b.disabled = false; }
    });
    syncReceiptState();
    showInlinePreview(Math.max(0, previewAttachments.findIndex(a => a.id === selectedId)), true);
  }
  function syncReceiptState() {
    const hasReceipt = Boolean(draft.attachments.length + pending.length);
    const acknowledgement = form.elements.noReceiptAcknowledged;
    if (hasReceipt) acknowledgement.checked = false;
    acknowledgement.disabled = hasReceipt;
    form.querySelector('#expense-missing-choice').hidden = hasReceipt;
    const missing = !hasReceipt && acknowledgement.checked;
    const reason = form.elements.missingReceiptReason;
    reason.disabled = !missing;
    reason.required = missing;
    form.querySelector('#expense-missing-reason-field').hidden = !missing;
    if (missing && form.elements.vatRate.value !== 'not-stated') {
      form.elements.vatRate.value = 'not-stated';
      form.elements.vatRate.dispatchEvent(new Event('change', { bubbles: true }));
    }
    form.elements.vatRate.disabled = missing;
    syncAmounts();
  }
  function syncConfirmed() {
    const reviewing = ['review', 'included-unitemized', 'not-stated'].includes(form.elements.vatRate.value);
    if (reviewing) { form.elements.deductible.checked = false; form.elements.vatDeductibleAmount.value = '0'; }
    form.elements.deductible.disabled = reviewing;
    const enabled = !reviewing && form.elements.deductible.checked;
    form.elements.vatDeductibleAmount.disabled = !enabled;
    form.elements.vatDeductibleAmount.closest('label').hidden = !enabled;
  }
  function syncAmounts() {
    const choice = form.elements.vatRate.value, manual = choice === 'manual', reviewing = ['review', 'included-unitemized', 'not-stated'].includes(choice), undisclosed = ['included-unitemized', 'not-stated'].includes(choice);
    form.querySelector('#manual-vat-field').hidden = !manual;
    form.elements.vatAmount.required = manual;
    form.elements.vatAmount.readOnly = !manual;
    const hint = form.querySelector('#expense-vat-hint');
    try {
      const additional = Number(form.elements.additionalAmount.value || 0), taxableTotal = Number(form.elements.total.value || 0) - additional;
      const t = manual ? splitExpenseTotalManual(taxableTotal, form.elements.vatAmount.value || 0) : splitExpenseTotal(taxableTotal, reviewing ? 0 : Number(choice));
      if (!manual) form.elements.vatAmount.value = t.vatAmount.toFixed(2);
      form.elements.base.value = reviewing ? '' : t.base.toFixed(2);
      form.elements.vatDeductibleAmount.min = String(isCredit ? t.vatAmount : 0);
      form.elements.vatDeductibleAmount.max = String(isCredit ? 0 : t.vatAmount);
      hint.textContent = undisclosed ? 'El total y el pago se conservan. Base e IVA quedan sin confirmar para el gestor; no se calcula un porcentaje ni una deducción.' : reviewing ? 'El total queda guardado. El IVA se deja pendiente para revisar el documento.' : `Base: ${money(t.base)} · IVA: ${money(t.vatAmount)}${additional ? ' · Adicional: ' + money(additional) : ''}`;
    } catch { form.elements.base.value = ''; hint.textContent = 'Revisa el total y el IVA del justificante.'; }
    syncConfirmed();
    const missing = !draft.attachments.length && !pending.length && form.elements.noReceiptAcknowledged.checked;
    form.querySelector('#expense-review-choice').hidden = !undisclosed || missing;
    form.querySelector('#complete-expense-review').hidden = !form.elements.reviewNeeded.checked;
    const hasReceipt = Boolean(draft.attachments.length + pending.length);
    form.querySelector('#complete-expense-review').disabled = !hasReceipt;
    form.querySelector('#expense-review-feedback').textContent = !undisclosed ? '' : !hasReceipt ? 'Falta un justificante para completar la revisión.' : !form.elements.reviewNeeded.checked ? 'Revisión del justificante completada. Se aplicará al guardar.' : '';
  }
  function syncPayment() {
    const paid = form.elements.alreadyPaid.checked;
    form.elements.paidDate.disabled = !paid || hasCashMovements; form.elements.paidDate.required = paid && !hasCashMovements;
    form.elements.paidDate.closest('label').hidden = !paid;
    form.querySelector('#expense-cash-change-warning').hidden = paid || (!hasCashMovements && draft.cashAmount === undefined);
    ctx.enhance();
  }
  for (const name of ['total', 'vatAmount', 'additionalAmount']) form.elements[name].addEventListener('input', syncAmounts);
  form.elements.vatRate.addEventListener('change', syncAmounts);
  form.elements.noReceiptAcknowledged.onchange = () => {
    if (form.elements.noReceiptAcknowledged.checked) form.elements.reviewNeeded.checked = false;
    syncReceiptState();
    if (form.elements.noReceiptAcknowledged.checked) form.elements.missingReceiptReason.focus();
  };
  form.elements.alreadyPaid.onchange = syncPayment;
  form.querySelector('#complete-expense-review').onclick = () => { form.elements.reviewNeeded.checked = false; syncAmounts(); };
  form.elements.reviewNeeded.onchange = syncAmounts;
  form.elements.deductible.onchange = () => { form.elements.vatDeductibleAmount.value = form.elements.deductible.checked ? form.elements.vatAmount.value : '0'; syncConfirmed(); };
  syncAmounts(); syncPayment(); redrawFiles(); ctx.enhance();
  for (const input of form.querySelectorAll('input[type="file"]')) input.onchange = async () => {
    const files = [...input.files]; input.value = ''; verifyingFiles++; save.disabled = true;
    try {
      for (const file of files) {
        try {
          await validateReceiptFile(file);
          if (!form.isConnected) return;
          if (draft.attachments.length + pending.length >= 10) throw new Error('Puedes guardar hasta 10 archivos por gasto.');
          pendingIds.set(file, 'pending-' + crypto.randomUUID()); pending.push(file);
        } catch (e) { ctx.toast(e.message, true); }
      }
    } finally { verifyingFiles--; if (form.isConnected) { save.disabled = verifyingFiles > 0 || ctx.isBusy(); redrawFiles(pendingIds.get(pending.at(-1))); } }
  };
  form.onsubmit = async e => {
    e.preventDefault();
    if (ctx.isBusy()) return;
    if (ctx.isSaveBlocked?.()) { ctx.showEditConflict?.(); ctx.toast('Tu borrador sigue abierto. Revisa los cambios guardados antes de continuar.', true); return; }
    const operationActive = ctx.operationScope?.() || isPreviewActive;
    if (verifyingFiles) { ctx.toast('Espera a que termine la comprobación del justificante.', true); return; }
    const hasReceipt = Boolean(draft.attachments.length + pending.length);
    if (!hasReceipt && (!form.elements.noReceiptAcknowledged.checked || !form.elements.missingReceiptReason.value.trim())) { ctx.toast('Añade un justificante o marca «No tengo justificante» y explica el motivo.', true); form.querySelector('#expense-missing-choice').scrollIntoView({ block: 'center', behavior: 'smooth' }); form.elements.noReceiptAcknowledged.checked ? form.elements.missingReceiptReason.focus() : form.elements.noReceiptAcknowledged.focus(); return; }
    const f = new FormData(form), paid = f.has('alreadyPaid'), choice = form.elements.vatRate.value;
    const unknownVAT = ['review', 'included-unitemized', 'not-stated'].includes(choice);
    let next = { ...draft, additionalAmount: Number(f.get('additionalAmount') || 0), supplier: String(f.get('supplier') || '').trim(), supplierTaxId: String(f.get('supplierTaxId') || '').trim(), date: f.get('date'), description: String(f.get('description') || '').trim(), category: f.get('category'), reference: String(f.get('reference') || '').trim(), notes: String(f.get('notes') || ''), paymentStatus: paid ? 'paid' : 'pending', paidDate: paid ? hasCashMovements ? draft.paidDate : f.get('paidDate') : null, reviewNeeded: f.has('reviewNeeded'), vatReviewNeeded: unknownVAT };
    if (['included-unitemized', 'not-stated'].includes(choice)) next.vatDocumentStatus = choice; else delete next.vatDocumentStatus;
    try {
      if (!paid) { delete next.cashAmount; delete next.cashMovements; }
      const total = Number(f.get('total')), taxableTotal = total - next.additionalAmount;
      Object.assign(next, choice === 'manual' ? splitExpenseTotalManual(taxableTotal, Number(f.get('vatAmount'))) : splitExpenseTotal(taxableTotal, unknownVAT ? 0 : Number(choice)));
      next.total = total;
      if (choice === 'manual' || unknownVAT) delete next.vatRate; else next.vatRate = Number(choice);
      next.vatDeductibleAmount = !unknownVAT && f.has('deductible') ? Number(f.get('vatDeductibleAmount')) : 0;
      next = applyReceiptRegistration(next, { hasReceipt, acknowledged: form.elements.noReceiptAcknowledged.checked, reason: form.elements.missingReceiptReason.value });
      const sample = structuredClone(ctx.getState()); sample.expenses ||= [];
      const i = sample.expenses.findIndex(v => v.id === next.id);
      if (i >= 0) sample.expenses[i] = next; else sample.expenses.push(next);
      ctx.validate(sample);
    } catch (error) { ctx.toast(error.message, true); return; }
    const queued = [...pending], kept = structuredClone(draft.attachments), removedAtSave = [...removed];
    const disabledBefore = [...form.querySelectorAll('input,select,textarea,button'), save].map(input => [input, input.disabled]);
    disabledBefore.forEach(([input]) => input.disabled = true);
    const uploaded = [], cloud = ctx.getMode() === 'cloud', activeBackend = ctx.getBackend();
    ctx.setBusy(true);
    try {
      for (const file of queued) {
        let meta;
        if (cloud) meta = await activeBackend.uploadReceipt(next.id, file);
        else meta = await storeLocalReceipt(next.id, file);
        uploaded.push(meta);
      }
      if (!form.isConnected || !operationActive()) throw new Error('La sesión cambió. Vuelve a entrar antes de guardar.');
      next.attachments = [...kept, ...uploaded];
      ctx.setBusy(false);
      const saved = await ctx.commit(s => {
        s.expenses ||= [];
        const i = s.expenses.findIndex(v => v.id === next.id);
        if (i >= 0) s.expenses[i] = next; else s.expenses.push(next);
      }, next.missingReceiptReason ? 'Gasto guardado con la nota de falta de justificante.' : 'Gasto y justificantes guardados.');
      if (!saved || !operationActive()) throw new Error('El gasto no se guardó. Puedes volver a intentarlo.');
      for (const a of removedAtSave) try { if (cloud) await activeBackend.deleteReceipt(a); else await localFile('delete', a.path); } catch { ctx.toast('El gasto se guardó; un archivo retirado quedó pendiente de limpiar.', true); }
      ctx.closeModal();
    } catch (error) {
      let cleanupPending = false;
      for (const a of uploaded) try { if (cloud) await activeBackend.deleteReceipt(a); else await localFile('delete', a.path); } catch { cleanupPending = true; }
      if (operationActive()) ctx.toast(error.message + (cleanupPending ? ' Un archivo permanece privado y pendiente de limpiar.' : ''), true);
    } finally {
      if (operationActive()) ctx.setBusy(false);
      if (operationActive() && form.isConnected) { disabledBefore.forEach(([input, wasDisabled]) => input.disabled = wasDisabled); save.disabled = false; }
    }
  };
  ctx.modalRoot.querySelector('#remove-expense')?.addEventListener('click', () => ctx.confirmModal('Eliminar este gasto', 'Se quitará el registro y se recalculará el saldo. Descarga sus justificantes antes de continuar.', async () => {
    if (await ctx.commit(s => s.expenses = s.expenses.filter(e => e.id !== draft.id), 'Gasto eliminado.')) {
      for (const a of originalAttachments) try { if (ctx.getMode() === 'cloud') await ctx.getBackend().deleteReceipt(a); else await localFile('delete', a.path); } catch { ctx.toast('Un justificante quedó pendiente de limpiar.', true); }
      ctx.closeModal();
    }
  }));
}
