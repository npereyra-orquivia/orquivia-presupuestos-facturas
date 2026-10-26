import { escapeHTML as esc } from './domain.js';
import { MAIL_PROVIDERS, defaultMailDraft, defaultMailProfile, mailAttachmentName, mailStatus, mailRecipientSuggestions, renderMailSignature, validateMailDraft, validateMailSignature } from './mail-domain.js';
import { MAIL_ATTACHMENT_LIMITS, MAIL_ATTACHMENT_ACCEPT, readMailAttachments, encodeMailAttachments, formatMailAttachmentSize } from './mail-attachments.js';

function attachmentHistory(attachments) {
  const values = Array.isArray(attachments) ? attachments.slice(0, MAIL_ATTACHMENT_LIMITS.count).filter(value => typeof value?.name === 'string' && Number.isSafeInteger(value.size) && value.size > 0) : [];
  return values.length ? `<span class="mail-history-attachments">Adjuntos adicionales: ${values.map(value => `${esc(value.name)} (${esc(formatMailAttachmentSize(value.size))})`).join(' · ')}</span>` : '';
}

function extraAttachmentRows(attachments, readonly = false) {
  return attachments.length ? attachments.map((item, index) => `<li><div><strong>${esc(item.name)}</strong><small>${esc(formatMailAttachmentSize(item.bytes?.byteLength || item.size || 0))}</small></div>${readonly ? '' : `<button type="button" class="text-button" data-remove-mail-attachment="${index}" aria-label="Quitar adjunto ${esc(item.name)}">Quitar</button>`}</li>`).join('') : '<li class="mail-extra-empty">No has añadido documentos adicionales.</li>';
}

function extraAttachments(document, draft, job) {
  if (document?.kind !== 'invoice') return '';
  const files = job ? (Array.isArray(job.attachments) ? job.attachments : []) : (Array.isArray(draft.attachments) ? draft.attachments : []);
  const bytes = files.reduce((sum, file) => sum + (file.bytes?.byteLength || file.size || 0), 0);
  return `<section class="mail-extra-attachments" data-mail-extra-attachments aria-label="Adjuntos adicionales de la factura"><div class="mail-extra-heading"><h3>Adjuntos adicionales (opcional)</h3>${job ? '' : '<button type="button" class="button secondary" data-add-mail-attachments>Añadir documentos</button>'}</div>${job ? '' : `<input data-mail-attachments-input type="file" accept="${esc(MAIL_ATTACHMENT_ACCEPT)}" multiple hidden aria-label="Seleccionar adjuntos adicionales"><p class="field-hint">PDF, JPG o PNG. Hasta ${MAIL_ATTACHMENT_LIMITS.count} archivos, ${formatMailAttachmentSize(MAIL_ATTACHMENT_LIMITS.eachBytes)} por archivo y ${formatMailAttachmentSize(MAIL_ATTACHMENT_LIMITS.totalBytes)} en total. La factura se adjunta automáticamente aparte.</p>`}<ul data-mail-extra-list>${extraAttachmentRows(files, Boolean(job))}</ul><p class="mail-extra-total" data-mail-extra-total>${files.length} de ${MAIL_ATTACHMENT_LIMITS.count} archivos · ${formatMailAttachmentSize(bytes)} de ${formatMailAttachmentSize(MAIL_ATTACHMENT_LIMITS.totalBytes)}</p><p class="field-hint">Para otro envío, vuelve a seleccionar los documentos que quieras incluir.</p></section>`;
}

export function renderMailSettings({ profile, user, mode, error = '', loading = false, logoUrl = '' }) {
  const p = profile || defaultMailProfile(user || {}), s = p.signature;
  return `<section class="card mail-settings"><div class="card-header"><div><h2>Tu correo y tu firma</h2><p>Envía desde tu cuenta de Arsys y guarda una copia en Enviados.</p></div><span class="badge ${p.connected ? 'paid' : 'ready'}">${p.connected ? 'Conectado' : 'Sin conectar'}</span></div>
    <form id="mail-settings-form"><fieldset ${loading ? 'disabled' : ''}>
      <label class="field"><span>Correo remitente · tu cuenta</span><input type="email" value="${esc(p.email)}" readonly autocomplete="username"></label>
      <div class="form-grid"><label class="field"><span>Nombre de la firma</span><input name="signatureName" maxlength="100" value="${esc(s.name)}" required></label><label class="field"><span>Cargo</span><input name="signatureRole" maxlength="120" value="${esc(s.role)}"></label></div>
      <label class="field"><span>Teléfono</span><input name="signaturePhone" maxlength="40" value="${esc(s.phone)}" inputmode="tel"></label>
      <div class="mail-signature-preview">${renderMailSignature(s, { email: p.email, logoUrl })}</div>
      <button type="button" class="button secondary" data-save-mail-signature>Guardar firma</button>
      <div class="mail-connection"><label class="field"><span>Servidor de Arsys</span><select name="provider">${MAIL_PROVIDERS.map(item => `<option value="${item.value}" ${p.provider === item.value ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label>
      <label class="field"><span>Contraseña del correo de Arsys</span><input name="mailPassword" type="password" autocomplete="off" maxlength="1024" placeholder="${p.connected ? 'Escríbela solo para cambiar la conexión' : 'Introdúcela aquí, nunca en el chat'}"></label>
      <p class="field-hint">Se guarda cifrada en el servidor. La aplicación no puede mostrarla. La comprobación conecta con el envío y la carpeta Enviados sin mandar ningún correo.</p>
      <div class="mail-actions"><button class="button primary" ${mode !== 'cloud' ? 'disabled' : ''}>${p.connected ? 'Comprobar conexión' : 'Conectar y comprobar'}</button>${p.connected ? '<button type="button" class="text-button" data-disconnect-mail>Desconectar correo</button>' : ''}</div></div>
      <p class="mail-feedback" role="status">${esc(error || (loading ? 'Cargando tu correo…' : mode !== 'cloud' ? 'La conexión se configura al entrar en el portal con tu cuenta.' : ''))}</p>
      <button type="button" class="text-button" data-reload-mail>Volver a cargar configuración</button>
    </fieldset></form></section>`;
}

export function bindMailSettings(root, ctx) {
  const form = root.querySelector('#mail-settings-form'); if (!form) return () => {};
  let active = true, pending = false;
  const feedback = message => { if (active) form.querySelector('.mail-feedback').textContent = message; };
  const signature = () => ({ name: form.elements.signatureName.value, role: form.elements.signatureRole.value, phone: form.elements.signaturePhone.value });
  form.addEventListener('input', event => {
    if (event.target.name.startsWith('signature')) form.querySelector('.mail-signature-preview').innerHTML = renderMailSignature(signature(), { email: ctx.user?.email || '', logoUrl: ctx.logoUrl });
  });
  async function run(action) {
    if (pending) return; pending = true;
    const s = validateMailSignature(signature());
    if (!s.ok) { feedback(Object.values(s.errors)[0]); pending = false; return; }
    const password = form.elements.mailPassword.value;
    form.elements.mailPassword.value = '';
    form.querySelector('fieldset').disabled = true;
    try {
      const version = ctx.profile?.version || 0;
      const result = action === 'signature' ? await ctx.saveSignature({ signature: s.value, expectedVersion: version })
        : action === 'disconnect' ? await ctx.disconnect({ expectedVersion: version })
          : await ctx.configure({ signature: s.value, password: password || undefined, provider: form.elements.provider.value, expectedVersion: version });
      if (active) ctx.onResult?.(result, action);
    } catch (error) { feedback(error.message); }
    finally { pending = false; if (active) { form.querySelector('fieldset').disabled = false; form.elements.mailPassword.value = ''; } }
  }
  form.onsubmit = event => { event.preventDefault(); run('configure'); };
  form.querySelector('[data-save-mail-signature]').onclick = () => run('signature');
  form.querySelector('[data-disconnect-mail]')?.addEventListener('click', () => run('disconnect'));
  form.querySelector('[data-reload-mail]').onclick = () => ctx.loadProfile?.();
  return () => { active = false; form.elements.mailPassword.value = ''; };
}

function historyMarkup(history, { currentArchiveId } = {}) {
  return history.length ? history.map(job => {
    const s = mailStatus(job.status), date = new Date(job.createdAt || job.created_at);
    return `<li><div><strong>${esc(job.errorCode === 'SMTP_PARTIAL' ? 'Envío parcial · por revisar' : s.label)}</strong><span>Para: ${esc(recipientText(job.to))}</span>${job.cc?.length ? `<span>CC: ${esc(recipientText(job.cc))}</span>` : ''}${attachmentHistory(job.attachments)}${['MAIL_STORAGE_LIMIT', 'MAIL_MESSAGE_TOO_LARGE', 'MAIL_PREPARATION_FAILED'].includes(job.errorCode) ? `<span>${esc(jobDescription(job))}</span>` : ''}${job.errorCode === 'SMTP_PARTIAL' ? `<span>Aceptados por el servidor: ${esc(recipientText(job.accepted) || 'Por confirmar')}</span><span>Rechazados: ${esc(recipientText(job.rejected) || 'Por confirmar')}</span>` : ''}<small>${esc(job.sender || job.from || '')} · ${Number.isFinite(date.valueOf()) ? esc(date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })) : 'Fecha por comprobar'}</small></div>${job.status === 'archive_pending' && job.id !== currentArchiveId ? `<button type="button" class="text-button" data-retry-archive="${esc(job.id)}">Guardar solo la copia</button>` : ''}</li>`;
  }).join('') : '<li>Todavía no hay envíos registrados desde la aplicación.</li>';
}

const recipientText = value => Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : '';
const allowsNewMail = job => job?.errorCode !== 'SMTP_PARTIAL' && ['sent', 'archive_pending', 'failed'].includes(job?.status);
const refreshIcon = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3a7 7 0 0 0 11.6-1"/></svg>';

function historySection(document, history, options) {
  const title = document?.kind === 'invoice' ? 'Envíos de esta factura' : document?.kind === 'quote' ? 'Envíos de este presupuesto' : 'Historial de envíos';
  return `<section class="mail-history"><div class="mail-history-heading"><h3>${title}</h3><button type="button" class="button secondary mail-refresh" data-refresh-mail>${refreshIcon}<span>Actualizar estado</span></button></div><ul>${historyMarkup(history, options)}</ul></section>`;
}

function jobDescription(job) {
  const preparation = {
    MAIL_STORAGE_LIMIT: 'Hay demasiados correos pendientes de confirmación o de guardar su copia. Revisa esos envíos antes de enviar más documentos.',
    MAIL_MESSAGE_TOO_LARGE: 'El correo completo supera el tamaño permitido. Prepara otro envío con menos documentos o archivos más pequeños.',
    MAIL_PREPARATION_FAILED: 'No se pudo preparar el PDF o los documentos del correo. Revisa los archivos antes de preparar otro envío.',
  }[job?.errorCode];
  if (preparation) return preparation;
  return job?.errorCode === 'SMTP_PARTIAL'
    ? 'El servidor aceptó solo algunos destinatarios. Revisa el detalle del historial y tu correo antes de volver a enviar a las personas rechazadas.'
    : mailStatus(job?.status).description;
}

export function renderMailLoading() {
  return '<section class="mail-loading" role="status" aria-live="polite" aria-atomic="true"><span class="mail-loading-spinner" aria-hidden="true"></span><h2>Cargando el correo…</h2><p>Un momento, estamos preparando la información.</p></section>';
}

function messagePreview(draft, profile, logoUrl) {
  return `<div class="mail-message-headers"><div><strong>Para</strong><span>${esc(recipientText(draft.to))}</span></div>${recipientText(draft.cc) ? `<div><strong>CC</strong><span>${esc(recipientText(draft.cc))}</span></div>` : ''}<div><strong>Asunto</strong><span>${esc(draft.subject || '')}</span></div></div><div class="mail-message-body">${esc(draft.message || '').replaceAll('\r\n', '\n').replaceAll('\n', '<br>')}</div><div class="mail-signature-preview">${renderMailSignature(profile.signature, { email: profile.email, logoUrl })}</div>`;
}

export function renderMailComposer({ document, client, profile, history = [], preview = '', draft, job, error = '', logoUrl = '' }) {
  const value = draft || defaultMailDraft(document, client), p = profile || defaultMailProfile();
  const suggestions = mailRecipientSuggestions(history);
  const readonly = job ? 'readonly' : '';
  return `<div class="mail-compose-layout"><section class="mail-compose"><form id="mail-compose-form" ${job ? 'data-mail-readonly="true"' : ''}>
    <label class="field"><span>De</span><input value="${esc(p.email)}" readonly></label>
    <label class="field"><span>Para</span><input name="to" type="text" inputmode="email" required maxlength="5200" list="mail-recipients" value="${esc(recipientText(value.to))}" autocomplete="off" aria-describedby="mail-recipients-hint" ${readonly}></label>
    <label class="field"><span>CC · en copia (opcional)</span><input name="cc" type="text" inputmode="email" maxlength="5200" list="mail-recipients" value="${esc(recipientText(value.cc))}" autocomplete="off" aria-describedby="mail-recipients-hint" ${readonly}></label>
    <p class="field-hint" id="mail-recipients-hint">${document?.kind === 'invoice' ? 'La factura puede enviarse a una dirección distinta de la del presupuesto. ' : ''}Puedes añadir varias direcciones separadas por comas o punto y coma. Hasta 20 personas entre Para y CC; todas verán estas direcciones.</p><datalist id="mail-recipients">${suggestions.map(address => `<option value="${esc(address)}"></option>`).join('')}</datalist>
    <label class="field"><span>Asunto</span><input name="subject" required maxlength="200" value="${esc(value.subject)}" ${readonly}></label>
    <label class="field"><span>Mensaje</span><textarea name="message" rows="9" maxlength="20000" required ${readonly}>${esc(value.message)}</textarea></label>
    <section class="mail-message-preview" aria-label="Vista previa del correo"><h3>Así llegará tu mensaje</h3><div data-mail-message-preview>${messagePreview(value, p, logoUrl)}</div></section>
    <div class="mail-attachment">PDF adjunto · <strong>${esc(mailAttachmentName(document))}</strong></div>
    ${extraAttachments(document, value, job)}
    ${!p.connected && !job ? '<p class="note-banner">Conecta primero tu correo en Mi espacio.</p><button type="button" class="button secondary" data-configure-mail>Configurar mi correo</button>' : ''}
    <div class="mail-job-status" role="status" aria-live="polite" data-mail-feedback>${esc(error || (job ? jobDescription(job) : 'Revisa los destinatarios, el mensaje completo con tu firma y el PDF antes de enviar.'))}</div>
    <div class="mail-actions">${!job ? `<button type="button" class="button primary" data-send-mail ${!p.connected ? 'disabled' : ''}>Enviar correo con el PDF</button>` : ''}${allowsNewMail(job) ? '<button type="button" class="button secondary" data-new-mail>Preparar otro envío</button>' : ''}<button class="button secondary" type="button" data-close>${['sent', 'archive_pending'].includes(job?.status) ? 'Cerrar' : 'Cancelar'}</button></div>
    </form>${historySection(document, history)}</section><aside class="mail-document-preview"><h3>PDF que se adjuntará</h3>${preview}</aside></div>`;
}

export function renderMailResult({ job, document, history = [] }) {
  const partial = job?.errorCode === 'SMTP_PARTIAL';
  const titles = { sent: 'Correo enviado correctamente', archive_pending: 'Correo enviado · copia pendiente',
    failed: 'No se ha enviado el correo', uncertain: 'El resultado del envío está por confirmar', sending: 'Envío en curso' };
  const title = partial ? 'Envío parcial · por revisar' : titles[job?.status] || 'Estado del correo por comprobar';
  const description = job?.status === 'sent' && !partial
    ? 'Gracias. El servidor ha confirmado el envío y la copia se ha guardado en Enviados.'
    : job?.status === 'archive_pending' && !partial
      ? 'El servidor ha confirmado el envío. La copia todavía no se ha guardado en Enviados. Puedes guardar solo esa copia sin volver a enviar el correo.'
      : jobDescription(job);
  const icon = job?.status === 'sent' && !partial
    ? '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>'
    : '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5m0 4v.1"/></svg>';
  return `<section class="mail-result"><div class="mail-result-state ${job?.status === 'sent' && !partial ? 'is-success' : 'is-pending'}"><span class="mail-result-icon" aria-hidden="true">${icon}</span><h2>${title}</h2><p role="status" aria-live="polite">${esc(description)}</p>${document?.number ? `<small>${esc(document.kind === 'invoice' ? 'Factura' : 'Presupuesto')} ${esc(document.number)}</small>` : ''}<div class="mail-actions">${job?.status === 'archive_pending' ? `<button type="button" class="button primary" data-retry-archive="${esc(job.id)}">Guardar solo la copia</button>` : ''}${allowsNewMail(job) ? '<button type="button" class="button secondary" data-new-mail>Preparar otro envío</button>' : ''}<button type="button" class="button secondary" data-close>Cerrar</button></div></div><p class="mail-job-status" role="status" aria-live="polite" data-mail-feedback></p>${historySection(document, history, { currentArchiveId: job?.status === 'archive_pending' ? job.id : undefined })}</section>`;
}

function bindMailSurface(root, ctx) {
  const form = root.querySelector('#mail-compose-form'), send = root.querySelector('[data-send-mail]');
  const fileInput = root.querySelector('[data-mail-attachments-input]');
  const readonly = form?.dataset.mailReadonly === 'true';
  let active = true, pending = false, attempted = false;
  let attachments = fileInput && Array.isArray(ctx.draft?.attachments) ? ctx.draft.attachments : [];
  const isActive = () => active && (!ctx.isCurrent || ctx.isCurrent());
  const token = ctx.draft?.idempotencyKey || (form && !readonly ? crypto.randomUUID() : undefined);
  const feedback = message => { const target = root.querySelector('[data-mail-feedback]'); if (isActive() && target) target.textContent = message; };
  const draft = () => ({ ...ctx.draft, to: form.elements.to.value, cc: form.elements.cc.value,
    subject: form.elements.subject.value, message: form.elements.message.value, ...(fileInput ? { attachments } : {}), idempotencyKey: token });
  const rememberDraft = () => {
    if (!form || readonly || attempted) return ctx.draft;
    ctx.draft = draft();
    ctx.onDraftChange?.(ctx.draft);
    return ctx.draft;
  };
  const lockControls = () => {
    const controls = [...root.querySelectorAll('button:not([data-close]),input,textarea,select')].map(control => ({ control, disabled: control.disabled }));
    for (const { control } of controls) control.disabled = true;
    return () => { if (active) for (const { control, disabled } of controls) control.disabled = disabled; };
  };
  async function run(action) {
    if (!isActive() || pending) return;
    pending = true;
    const unlock = lockControls();
    try { await action(); }
    catch (error) { feedback(error?.message || 'No se pudo actualizar el estado. Vuelve a intentarlo.'); }
    finally { pending = false; unlock(); }
  }
  function drawAttachments() {
    const list = root.querySelector('[data-mail-extra-list]'), total = root.querySelector('[data-mail-extra-total]');
    if (!isActive() || !list || !total) return;
    list.innerHTML = extraAttachmentRows(attachments);
    total.textContent = `${attachments.length} de ${MAIL_ATTACHMENT_LIMITS.count} archivos · ${formatMailAttachmentSize(attachments.reduce((sum, item) => sum + item.bytes.byteLength, 0))} de ${formatMailAttachmentSize(MAIL_ATTACHMENT_LIMITS.totalBytes)}`;
    list.querySelectorAll('[data-remove-mail-attachment]').forEach(button => {
      button.onclick = () => {
        if (!isActive() || pending || attempted || readonly) return;
        attachments = attachments.filter((_, index) => index !== Number(button.dataset.removeMailAttachment));
        rememberDraft(); drawAttachments(); feedback('Adjunto quitado.');
      };
    });
  }
  if (fileInput && !readonly) {
    root.querySelector('[data-add-mail-attachments]').onclick = () => { if (isActive() && !pending && !attempted) fileInput.click(); };
    fileInput.onchange = () => run(async () => {
      const files = [...fileInput.files]; if (!files.length) return;
      feedback('Comprobando los documentos…');
      try {
        const next = await (ctx.readAttachments || readMailAttachments)(files, attachments);
        if (!isActive() || attempted) return;
        if (ctx.document && next.some(item => item.name.toLowerCase() === mailAttachmentName(ctx.document).toLowerCase())) throw new Error('La factura ya se adjunta automáticamente. Cambia el nombre del documento adicional si es otro archivo.');
        attachments = next; rememberDraft(); drawAttachments(); feedback('Documentos preparados. Se adjuntarán al enviar el correo.');
      } finally { if (isActive()) fileInput.value = ''; }
    });
    drawAttachments();
  }
  const enter = event => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault(); };
  if (form) {
    form.addEventListener('keydown', enter);
    form.onsubmit = event => event.preventDefault();
    form.oninput = () => {
      if (!isActive() || pending || readonly || attempted) return;
      const value = rememberDraft(), preview = form.querySelector('[data-mail-message-preview]');
      if (preview) preview.innerHTML = messagePreview(value, ctx.profile || defaultMailProfile(), ctx.logoUrl);
    };
  }
  if (form && send && !readonly) send.onclick = async () => {
    if (!isActive() || pending || attempted || send.disabled) return;
    const value = rememberDraft(), validated = validateMailDraft(value);
    if (!validated.ok) return feedback(Object.values(validated.errors)[0]);
    let encoded;
    try { encoded = encodeMailAttachments(attachments); }
    catch (error) { return feedback(error.message); }
    await run(async () => {
      attempted = true;
      for (const input of form.querySelectorAll('input,textarea')) input.readOnly = true;
      send.remove();
      feedback('Enviando… No repitas el envío mientras se comprueba el resultado.');
      try { const result = await ctx.send({ ...validated.value, ...(fileInput ? { attachments: encoded } : {}), idempotencyKey: token }); if (isActive()) await ctx.onResult?.(result); }
      catch (error) { feedback(`${error?.message || 'No hay una confirmación definitiva del envío.'} Actualiza el estado y comprueba tu correo antes de volver a enviar.`); }
    });
  };
  const configure = root.querySelector('[data-configure-mail]');
  if (configure) configure.onclick = () => { if (active && !pending) ctx.configure?.(); };
  const refresh = root.querySelector('[data-refresh-mail]');
  if (refresh) refresh.onclick = () => run(async () => {
    rememberDraft();
    feedback('Actualizando el estado del correo…');
    await ctx.reloadHistory?.(ctx.draft);
    feedback('Estado actualizado.');
  });
  root.querySelectorAll('[data-retry-archive]').forEach(button => {
    button.onclick = () => run(async () => {
      feedback('Guardando solo la copia en Enviados…');
      const result = await ctx.retryArchive({ jobId: button.dataset.retryArchive });
      if (active) await ctx.onResult?.(result);
    });
  });
  root.querySelectorAll('[data-new-mail]').forEach(button => {
    button.onclick = () => { if (active && !pending) ctx.onNewMail?.(); };
  });
  if (ctx.onClose) root.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => ctx.onClose(); });
  return () => {
    active = false;
    form?.removeEventListener('keydown', enter);
  };
}

export function bindMailComposer(root, ctx) { return bindMailSurface(root, ctx); }
export function bindMailResult(root, ctx) { return bindMailSurface(root, ctx); }
