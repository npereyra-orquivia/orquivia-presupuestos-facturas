import './mail.css';
import { escapeHTML as esc } from './domain.js';
import { MAIL_PROVIDERS, defaultMailDraft, defaultMailProfile, mailAttachmentName, mailStatus, mailRecipientSuggestions, renderMailSignature, validateMailDraft, validateMailSignature } from './mail-domain.js';

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
      <p class="mail-feedback" role="status">${esc(error || (loading ? 'Cargando tu correo…' : mode !== 'cloud' ? 'La conexión se configura al entrar en el portal de pruebas con tu cuenta.' : ''))}</p>
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
      if (active) ctx.onResult?.(result);
    } catch (error) { feedback(error.message); }
    finally { pending = false; if (active) { form.querySelector('fieldset').disabled = false; form.elements.mailPassword.value = ''; } }
  }
  form.onsubmit = event => { event.preventDefault(); run('configure'); };
  form.querySelector('[data-save-mail-signature]').onclick = () => run('signature');
  form.querySelector('[data-disconnect-mail]')?.addEventListener('click', () => run('disconnect'));
  form.querySelector('[data-reload-mail]').onclick = () => ctx.loadProfile?.();
  return () => { active = false; form.elements.mailPassword.value = ''; };
}

function historyMarkup(history) {
  return history.length ? history.map(job => {
    const s = mailStatus(job.status), date = new Date(job.createdAt);
    return `<li><div><strong>${esc(s.label)}</strong><span>${esc(job.to?.join(', ') || '')}</span><small>${esc(job.sender || job.from || '')} · ${Number.isFinite(date.valueOf()) ? esc(date.toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })) : 'Fecha por comprobar'}</small></div>${job.status === 'archive_pending' ? `<button type="button" class="text-button" data-retry-archive="${esc(job.id)}">Guardar solo la copia</button>` : ''}</li>`;
  }).join('') : '<li>Todavía no hay envíos registrados desde la aplicación.</li>';
}

export function renderMailComposer({ document, client, profile, history = [], preview, draft, job, error = '', logoUrl = '' }) {
  const value = draft || defaultMailDraft(document, client), p = profile || defaultMailProfile(), s = mailStatus(job?.status || (p.connected ? 'ready' : 'not_configured'));
  const suggestions = mailRecipientSuggestions(history);
  return `<div class="mail-compose-layout"><section class="mail-compose"><form id="mail-compose-form">
    <label class="field"><span>De</span><input value="${esc(p.email)}" readonly></label>
    <label class="field"><span>Para</span><input name="to" type="email" required maxlength="254" list="mail-recipients" value="${esc(value.to?.[0] || '')}" autocomplete="email"></label><datalist id="mail-recipients">${suggestions.map(address => `<option value="${esc(address)}"></option>`).join('')}</datalist>
    <label class="field"><span>Asunto</span><input name="subject" required maxlength="200" value="${esc(value.subject)}"></label>
    <label class="field"><span>Mensaje</span><textarea name="message" rows="9" maxlength="20000" required>${esc(value.message)}</textarea></label>
    <div class="mail-signature-preview">${renderMailSignature(p.signature, { email: p.email, logoUrl })}</div>
    <div class="mail-attachment">PDF adjunto · <strong>${esc(mailAttachmentName(document))}</strong></div>
    ${!p.connected ? '<p class="note-banner">Conecta primero tu correo en Mi espacio.</p><button type="button" class="button secondary" data-configure-mail>Configurar mi correo</button>' : ''}
    <div class="mail-job-status" role="status">${esc(error || (job ? s.description : 'Revisa el destinatario, el mensaje y el PDF antes de enviar.'))}</div>
    <div class="mail-actions"><button class="button primary" data-send-mail ${!p.connected || job && job.status !== 'failed' ? 'disabled' : ''}>Enviar correo con el PDF</button><button class="button secondary" type="button" data-close>Cancelar</button></div>
    </form><section class="mail-history"><h3>Envíos de este presupuesto</h3><button type="button" class="text-button" data-refresh-mail>Actualizar estado</button><ul>${historyMarkup(history)}</ul></section></section><aside class="mail-document-preview"><h3>PDF que se adjuntará</h3>${preview}</aside></div>`;
}

export function bindMailComposer(root, ctx) {
  const form = root.querySelector('#mail-compose-form'); if (!form) return () => {};
  let active = true, pending = false, uncertain = false, token = ctx.draft?.idempotencyKey || crypto.randomUUID();
  const feedback = message => { if (active) form.querySelector('.mail-job-status').textContent = message; };
  const draft = () => ({ to: [form.elements.to.value], subject: form.elements.subject.value, message: form.elements.message.value, idempotencyKey: token });
  form.oninput = () => ctx.onDraftChange?.(draft());
  form.onsubmit = async event => {
    event.preventDefault(); if (pending || uncertain) return;
    const validated = validateMailDraft(draft());
    if (!validated.ok) return feedback(Object.values(validated.errors)[0]);
    ctx.onDraftChange?.(draft()); pending = true; form.querySelector('[data-send-mail]').disabled = true;
    for (const input of form.querySelectorAll('input,textarea')) input.readOnly = true;
    feedback('Enviando… No repitas el envío mientras se comprueba el resultado.');
    try { const result = await ctx.send({ ...validated.value, idempotencyKey: token }); if (active) ctx.onResult?.(result); }
    catch (error) { uncertain = true; feedback(error.message); }
    finally { pending = false; }
  };
  root.querySelector('[data-configure-mail]')?.addEventListener('click', () => ctx.configure?.());
  root.querySelector('[data-refresh-mail]').onclick = () => { if (!pending) ctx.reloadHistory?.(draft()); };
  root.querySelectorAll('[data-retry-archive]').forEach(button => button.onclick = async () => {
    if (pending) return; pending = true; button.disabled = true;
    try { const result = await ctx.retryArchive({ jobId: button.dataset.retryArchive }); if (active) ctx.onResult?.(result); }
    catch (error) { feedback(error.message); }
    finally { pending = false; if (active) button.disabled = false; }
  });
  return () => { active = false; };
}
