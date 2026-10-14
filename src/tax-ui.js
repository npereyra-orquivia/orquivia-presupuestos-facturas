import './tax-ui.css';
import { money, todayISO, escapeHTML as esc } from './domain.js';
import { validateReceiptFile, RECEIPT_FILE_TYPES } from './backend.js';
import { localReceipt, storeLocalReceipt } from './expense-ui.js';
import { recordHistoryMarkup, bindRecordHistory } from './history-ui.js';
import { taxFromFields, taxPaymentLabel } from './tax-entry.js';
import { icon } from './icons.js';

const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(String(value ?? ''))}" ${extra}></label>`;
const select = (label, name, options, value) => `<label class="field"><span>${label}</span><select name="${name}">${options.map(([id, text]) => `<option value="${esc(id)}" ${String(value) === String(id) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
const statuses = [['no-payment', 'Sin ingreso (resultado cero)'], ['unconfirmed', 'Pago por confirmar'], ['pending', 'Pendiente de pago'], ['paid', 'Pagado / devolución recibida'], ['included', 'Incluido en un pago al gestor']];
const dateLabel = date => date ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z')) : '—';

export function taxSection(state, records = []) {
  return `<section class="card tax-register"><div class="card-header"><div><h2>Declaraciones y pagos de impuestos</h2><p>Modelos presentados del período seleccionado. Se guardan con su documento original; sus pagos se separan de los gastos y del IVA de proveedores.</p></div><button class="button secondary" data-new-tax>${icon('plus')}Añadir declaración</button></div><div class="table-scroll"><table><thead><tr><th>Modelo / período fiscal</th><th>Presentación</th><th>Resultado</th><th>Pago</th><th>Archivos</th></tr></thead><tbody>${records.map(record => `<tr><td><button class="doc-link" data-tax-record="${esc(record.id)}"><span class="doc-icon">${icon('report')}</span><span><strong>Modelo ${esc(record.model)} · T${record.quarter} ${record.year}</strong><small>${esc(record.reference || 'Sin referencia')}</small></span></button></td><td>${dateLabel(record.date)}</td><td class="amount">${money(record.amount)}</td><td>${esc(taxPaymentLabel(record))}${record.paidDate ? `<small class="tax-paid-date"> · ${dateLabel(record.paidDate)}</small>` : ''}</td><td>${record.attachments?.length || 0}</td></tr>`).join('') || '<tr><td colspan="5"><div class="empty-state">Guarda aquí los modelos que te envíe el gestor, incluidos los de resultado cero.</div></td></tr>'}</tbody></table></div></section>`;
}

export function bindTaxSection(root, ctx) {
  root.querySelector('[data-new-tax]')?.addEventListener('click', () => taxModal(ctx));
  root.querySelectorAll('[data-tax-record]').forEach(button => button.onclick = () => {
    const record = (ctx.getState().taxRecords || []).find(row => row.id === button.dataset.taxRecord);
    if (record) taxModal(ctx, record);
  });
}

export function taxModal(ctx, record) {
  const now = todayISO();
  const draft = structuredClone(record || { id: crypto.randomUUID(), date: now, model: '303', year: Number(now.slice(0, 4)), quarter: Math.max(1, Math.ceil(Number(now.slice(5, 7)) / 3) - 1), amount: 0, paymentStatus: 'no-payment', reference: '', notes: '', attachments: [] });
  draft.attachments ||= [];
  const linked = (ctx.getState().expenses || []).filter(expense => expense.additionalAmount > 0);
  ctx.openModal(ctx.modalHeader(record ? `Modelo ${draft.model} · T${draft.quarter} ${draft.year}` : 'Añadir declaración', 'El período fiscal y la fecha del pago se registran por separado.') + `<div class="tax-editor-layout"><form id="tax-form" class="tax-editor"><div class="form-grid">${select('Modelo', 'model', [['111', '111 · Retenciones'], ['303', '303 · IVA']], draft.model)}${field('Ejercicio', 'year', draft.year, 'number', 'min="1000" max="9999" required')}${select('Trimestre fiscal', 'quarter', [[1, 'T1 · enero–marzo'], [2, 'T2 · abril–junio'], [3, 'T3 · julio–septiembre'], [4, 'T4 · octubre–diciembre']], draft.quarter)}${field('Fecha de presentación', 'date', draft.date, 'date', `required max="${now}"`)}${field('Resultado (€)', 'amount', draft.amount, 'number', 'step="0.01" required inputmode="decimal"')}${field('Número de justificante / referencia', 'reference', draft.reference, 'text', 'maxlength="240"')}${select('Estado del pago', 'paymentStatus', statuses, draft.paymentStatus)}</div><p class="field-hint">Resultado positivo: a ingresar. Negativo: a devolver. Un resultado cero se guarda sin movimiento de caja. Registrar aquí un modelo no presenta ni paga impuestos.</p><div data-tax-paid>${field('Fecha real del pago o devolución', 'paidDate', draft.paidDate || now, 'date', `max="${now}"`)}</div><div data-tax-linked>${select('Gasto que ya incluye el impuesto', 'linkedExpenseId', [['', 'Selecciona el pago al gestor'], ...linked.map(expense => [expense.id, `${expense.description} · suplidos ${money(expense.additionalAmount)}`])], draft.linkedExpenseId || '')}<p class="tax-link-explanation">Selecciona esta opción cuando el impuesto ya esté incluido en un gasto registrado. Se conserva la declaración y no se vuelve a descontar de caja.</p></div><label class="field"><span>Notas (opcional)</span><textarea name="notes" rows="3" maxlength="10000">${esc(draft.notes || '')}</textarea></label><section><h3>Documento original</h3><label class="button secondary">${icon('upload')}Adjuntar documentos<input id="tax-files" class="visually-hidden" type="file" multiple accept="${Object.keys(RECEIPT_FILE_TYPES).map(type => '.' + type).join(',')}"></label><div class="tax-file-list"></div><p class="field-hint">Hasta 10 archivos de 10 MB cada uno. Los archivos guardados se conservan como originales privados.</p></section>${record ? recordHistoryMarkup('tax', draft.id) : ''}</form><aside class="tax-preview" aria-label="Vista previa de la declaración"><div class="preview-label">${icon('eye')}DOCUMENTO ORIGINAL</div><div id="tax-preview-host"><p class="field-hint">Adjunta el modelo para verlo junto a sus datos.</p></div></aside></div><div class="modal-actions tax-editor-actions"><button type="button" class="button secondary" data-close>Cancelar</button><button class="button primary" type="submit" form="tax-form" id="save-tax">Guardar declaración</button></div>`, true);
  bindRecordHistory(ctx.modalRoot, ctx);
  const form = ctx.modalRoot.querySelector('#tax-form'), list = form.querySelector('.tax-file-list'), save = ctx.modalRoot.querySelector('#save-tax');
  const previewHost = ctx.modalRoot.querySelector('#tax-preview-host');
  const scope = ctx.operationScope?.() || (() => ctx.getMode() !== 'locked');
  const mode = ctx.getMode(), backend = ctx.getBackend(), identity = ctx.getIdentity();
  let pending = [], verifying = 0, previewController = null, previewGeneration = 0, active = true, chosen = null;
  const ids = new WeakMap();
  const isActive = () => active && scope() && form.isConnected && ctx.getMode() === mode && ctx.getBackend() === backend && ctx.getIdentity() === identity;
  const allFiles = () => [...draft.attachments, ...pending.map(file => ({ id: ids.get(file), name: file.name, mimeType: RECEIPT_FILE_TYPES[file.name.split('.').at(-1).toLowerCase()], size: file.size }))];
  ctx.registerModalCleanup?.(() => { active = false; ++previewGeneration; previewController?.dispose(); });

  async function preview(id) {
    const generation = ++previewGeneration;
    previewController?.dispose(); previewController = null;
    const attachments = allFiles(), index = Math.max(0, attachments.findIndex(file => file.id === id));
    if (!attachments.length) { previewHost.innerHTML = '<p class="field-hint">Adjunta el modelo para verlo junto a sus datos.</p>'; return; }
    chosen = attachments[index].id;
    const pendingFiles = new Map(pending.map(file => [ids.get(file), file]));
    const valid = () => isActive() && generation === previewGeneration;
    try {
      const { mountReceiptViewer } = await import('./receipt-viewer.js');
      if (!valid()) return;
      previewHost.replaceChildren();
      previewController = mountReceiptViewer({ parent: previewHost, attachments, initialIndex: index, isActive: valid,
        loadAttachment: async attachment => {
          if (!valid()) throw new Error('El visor se ha cerrado.');
          const blob = pendingFiles.get(attachment.id) || (mode === 'cloud' ? await backend.downloadReceipt(attachment) : await localReceipt(attachment));
          if (!valid()) throw new Error('La sesión cambió durante la lectura del documento.');
          return blob;
        }, onError: error => { if (valid()) ctx.toast(error.message, true); } });
    } catch (error) { if (valid()) previewHost.innerHTML = `<p role="alert">${esc(error.message)}</p>`; }
  }
  function files() {
    const attachments = allFiles();
    list.innerHTML = attachments.map(file => `<div class="tax-file-row"><button type="button" data-tax-preview="${esc(file.id)}" class="${file.id === chosen ? 'is-selected' : ''}">${esc(file.name)}<small> · ${pending.some(item => ids.get(item) === file.id) ? 'listo para guardar' : 'guardado'}</small></button>${pending.some(item => ids.get(item) === file.id) ? `<button class="text-button tax-remove-pending" type="button" data-remove-tax="${esc(file.id)}" aria-label="Quitar ${esc(file.name)}">×</button>` : ''}</div>`).join('');
    list.querySelectorAll('[data-tax-preview]').forEach(button => button.onclick = () => { preview(button.dataset.taxPreview); files(); });
    list.querySelectorAll('[data-remove-tax]').forEach(button => button.onclick = () => { pending = pending.filter(file => ids.get(file) !== button.dataset.removeTax); if (!allFiles().some(file => file.id === chosen)) chosen = allFiles()[0]?.id; files(); preview(chosen); });
  }
  function paymentFields() {
    const status = form.elements.paymentStatus.value;
    form.querySelector('[data-tax-paid]').hidden = status !== 'paid';
    form.elements.paidDate.required = status === 'paid';
    form.querySelector('[data-tax-linked]').hidden = status !== 'included';
    form.elements.linkedExpenseId.required = status === 'included';
  }
  form.elements.paymentStatus.onchange = paymentFields;
  form.elements.amount.oninput = () => {
    if (Number(form.elements.amount.value) === 0) form.elements.paymentStatus.value = 'no-payment';
    else if (form.elements.paymentStatus.value === 'no-payment') form.elements.paymentStatus.value = 'unconfirmed';
    form.elements.paymentStatus.dispatchEvent(new Event('change', { bubbles: true }));
  };
  paymentFields(); files(); if (draft.attachments.length) preview(draft.attachments[0].id);
  form.querySelector('#tax-files').onchange = async event => {
    const selected = [...event.target.files]; event.target.value = ''; ++verifying; save.disabled = true;
    try {
      for (const file of selected) {
        await validateReceiptFile(file);
        if (!isActive()) return;
        if (draft.attachments.length + pending.length >= 10) throw new Error('Puedes guardar hasta 10 archivos por declaración.');
        if (pending.some(item => item.name === file.name && item.size === file.size)) continue;
        ids.set(file, crypto.randomUUID()); pending.push(file);
      }
      if (isActive()) { chosen = ids.get(pending.at(-1)) || chosen; files(); preview(chosen); }
    } catch (error) { if (isActive()) ctx.toast(error.message, true); }
    finally { --verifying; if (isActive()) save.disabled = verifying > 0 || ctx.isBusy(); }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (ctx.isBusy() || !isActive()) return;
    if (ctx.isSaveBlocked?.()) { ctx.showEditConflict?.(); return; }
    if (verifying) { ctx.toast('Espera a que termine la comprobación de los documentos.', true); return; }
    if (!draft.attachments.length && !pending.length) { ctx.toast('Adjunta el documento de la declaración para guardarla.', true); return; }
    const next = taxFromFields(draft, Object.fromEntries(new FormData(form)));
    try {
      const organization = mode === 'cloud' ? backend.workspaceInfo()?.organizationId : '00000000-0000-4000-8000-000000000001';
      // Validate the form before any upload. These local pending references are
      // replaced by the server's real metadata before the workspace is saved.
      const validationRecord = { ...next, attachments: [...draft.attachments, ...pending.map(file => {
        const id = ids.get(file), extension = file.name.split('.').at(-1).toLowerCase();
        return { id, name: file.name, size: file.size, mimeType: RECEIPT_FILE_TYPES[extension], path: `${organization}/${next.id}/${id}.${extension}` };
      })] };
      const sample = structuredClone(ctx.getState()); sample.taxRecords ||= []; const index = sample.taxRecords.findIndex(row => row.id === next.id);
      if (index < 0) sample.taxRecords.push(validationRecord); else sample.taxRecords[index] = validationRecord;
      ctx.validate(sample);
    }
    catch (error) { ctx.toast(error.message, true); return; }
    const queued = [...pending], uploaded = [];
    const disabled = [...form.querySelectorAll('input,select,textarea,button'), save].map(control => [control, control.disabled]);
    disabled.forEach(([control]) => control.disabled = true); ctx.setBusy(true);
    try {
      for (const file of queued) {
        const metadata = mode === 'cloud' ? await backend.uploadReceipt(next.id, file) : await storeLocalReceipt(next.id, file);
        if (!isActive()) return;
        uploaded.push(metadata);
      }
      next.attachments = [...draft.attachments, ...uploaded];
      ctx.setBusy(false);
      const saved = await ctx.commit(state => { state.taxRecords ||= []; const index = state.taxRecords.findIndex(row => row.id === next.id); if (index < 0) state.taxRecords.push(next); else state.taxRecords[index] = next; }, 'Declaración y documentos guardados.');
      if (!isActive()) return;
      // Keep successful uploads in a rejected draft so retrying cannot upload them twice.
      draft.attachments = next.attachments; pending = pending.filter(file => !queued.includes(file));
      if (saved) ctx.closeModal(); else { files(); preview(chosen); }
    } catch (error) { if (isActive()) { draft.attachments = [...draft.attachments, ...uploaded]; pending = pending.filter(file => !uploaded.some(meta => meta.name === file.name && meta.size === file.size)); files(); ctx.toast(error.message, true); } }
    finally { if (scope()) ctx.setBusy(false); if (isActive()) disabled.forEach(([control, previous]) => control.disabled = previous); }
  };
  ctx.enhance?.();
}
