import { renderMailSettings, bindMailSettings, renderMailComposer, bindMailComposer } from './mail-ui.js';
import { defaultMailProfile, normalizeMailProfile, defaultMailDraft } from './mail-domain.js';

export function createMailFeature(ctx) {
  let profile = null, identity = null, cleanup = null, mountRequest = 0;
  const drafts = new Map();
  function reset() { cleanup?.(); cleanup = null; profile = null; identity = null; drafts.clear(); ++mountRequest; }
  function current() {
    const owner = ctx.getUser()?.id || ctx.getMode();
    if (identity !== owner) { reset(); identity = owner; }
    return profile || defaultMailProfile(ctx.getUser() || {});
  }
  async function loadProfile() {
    const isCurrent = ctx.scope(); current();
    const result = ctx.getMode() === 'cloud' ? await ctx.getBackend().mail.profile() : current();
    if (!isCurrent()) throw new Error('La sesión cambió. Vuelve a entrar.');
    return profile = normalizeMailProfile(result, ctx.getUser() || {});
  }
  async function mountSettings(host, { refresh = true } = {}) {
    if (!host) return;
    cleanup?.(); cleanup = null; current();
    const request = ++mountRequest, scope = ctx.scope();
    const valid = () => request === mountRequest && scope() && host.isConnected;
    function draw(error = '', loading = false) {
      if (!valid()) return;
      host.innerHTML = renderMailSettings({ profile: current(), user: ctx.getUser(), mode: ctx.getMode(), error, loading, logoUrl: ctx.logoUrl });
      cleanup = bindMailSettings(host, {
        user: ctx.getUser(), profile: current(), logoUrl: ctx.logoUrl,
        loadProfile: () => mountSettings(host),
        configure: fields => ctx.getBackend().mail.configure(fields),
        disconnect: fields => ctx.getBackend().mail.disconnect(fields),
        saveSignature: fields => ctx.getMode() === 'cloud' ? ctx.getBackend().mail.signature(fields) : Promise.resolve({ ...current(), signature: fields.signature }),
        onResult: (result, action) => {
          if (!valid()) return;
          profile = normalizeMailProfile(result, ctx.getUser() || {});
          const message = action === 'configure' ? 'Correo conectado y comprobado. La copia se guardará en Enviados.' : action === 'disconnect' ? 'Correo desconectado.' : 'Firma guardada.';
          cleanup?.(); draw(message); ctx.toast(message);
        },
      });
    }
    draw('', refresh);
    if (refresh) try { await loadProfile(); draw(); } catch (error) { draw(error.message); }
  }
  async function openComposer(document, { draft, job } = {}) {
    const isCurrent = ctx.scope(); const backend = ctx.getBackend(); const cloud = ctx.getMode() === 'cloud';
    if (ctx.isBusy() || ctx.isConflict()) return ctx.toast('Termina de revisar los cambios antes de enviar.', true);
    ctx.openModal(ctx.header('Enviar presupuesto', document.number) + '<p>Cargando tu correo y el historial…</p>', true);
    const modal = ctx.root.querySelector('.modal');
    const valid = () => isCurrent() && modal.isConnected;
    try {
      const p = await loadProfile();
      const history = cloud ? await backend.mail.history(document.id) : [];
      if (!valid()) return;
      const savedDraft = draft || drafts.get(document.id) || { ...defaultMailDraft(document, ctx.clientFor(document)), idempotencyKey: crypto.randomUUID() };
      drafts.set(document.id, savedDraft);
      const known = job || history.find(entry => entry.id === savedDraft.idempotencyKey);
      modal.innerHTML = ctx.header('Enviar presupuesto', document.number) + renderMailComposer({ document, client: ctx.clientFor(document), profile: p, history, preview: ctx.preview(document), draft: savedDraft, job: known, logoUrl: ctx.logoUrl });
      modal.querySelectorAll('[data-close]').forEach(button => button.onclick = () => ctx.closeModal());
      const send = async fields => {
        if (!valid() || !cloud || ctx.isConflict() || ctx.isBusy()) throw new Error('Entra de nuevo y revisa el presupuesto antes de enviar.');
        ctx.setBusy(true);
        try { return await backend.mail.send(document.id, fields); }
        finally { if (isCurrent()) ctx.setBusy(false); }
      };
      const dispose = bindMailComposer(modal, {
        draft: savedDraft, profile: p, logoUrl: ctx.logoUrl, send,
        onDraftChange: value => { if (valid()) drafts.set(document.id, value); },
        configure: () => { ctx.closeModal(true); ctx.navigate('personal'); },
        retryArchive: fields => backend.mail.retryArchive(fields),
        reloadHistory: value => { if (valid()) openComposer(ctx.documentFor(document.id) || document, { draft: value }); },
        onResult: result => {
          if (!valid()) return;
          if (result.workspace) ctx.adopt(result.workspace);
          openComposer(ctx.documentFor(document.id) || document, { draft: drafts.get(document.id), job: result.job });
        },
      });
      ctx.cleanup(dispose);
      if (known && ['sent', 'archive_pending', 'failed'].includes(known.status)) {
        const button = ctx.root.ownerDocument.createElement('button');
        button.type = 'button'; button.className = 'button secondary'; button.textContent = 'Preparar otro envío';
        button.onclick = () => { const next = { ...drafts.get(document.id), idempotencyKey: crypto.randomUUID() }; drafts.set(document.id, next); openComposer(ctx.documentFor(document.id) || document, { draft: next }); };
        modal.querySelector('.mail-actions').prepend(button);
      }
      if (known) modal.querySelectorAll('#mail-compose-form input,#mail-compose-form textarea').forEach(input => { input.readOnly = true; });
    } catch (error) { if (valid()) modal.innerHTML = ctx.header('Correo no disponible') + `<p class="mail-job-error"></p><button class="button secondary" data-return-mail>Cerrar</button>`;
      if (valid()) { modal.querySelector('.mail-job-error').textContent = error.message; modal.querySelector('[data-return-mail]').onclick = () => ctx.closeModal(); modal.querySelector('[data-close]').onclick = () => ctx.closeModal(); }
    }
  }
  return { reset, mountSettings, openComposer };
}
