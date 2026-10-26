import { renderMailSettings, bindMailSettings, renderMailComposer, bindMailComposer, renderMailLoading, renderMailResult, bindMailResult } from './mail-ui.js';
import { defaultMailProfile, normalizeMailProfile, defaultMailDraft } from './mail-domain.js';
import { createMailContextCache, mergeMailJob } from './mail-context-cache.js';
import { resolveMailComposeEntry } from './mail-compose-entry.js';

export function createMailFeature(ctx) {
  let profile = null, identity = null, cleanup = null, mountRequest = 0, composerRequest = 0;
  const drafts = new Map();
  const contexts = createMailContextCache({
    getIdentity: () => `${ctx.getMode()}:${ctx.getUser()?.id || ''}`,
    async load(documentId) {
      const isCurrent = ctx.scope();
      const result = ctx.getMode() === 'cloud' ? await ctx.getBackend().mail.composer(documentId) : { profile: current(), history: [] };
      if (!isCurrent()) throw new Error('La sesión cambió. Vuelve a entrar.');
      return { profile: normalizeMailProfile(result.profile, ctx.getUser() || {}), history: Array.isArray(result.history) ? result.history : [] };
    },
  });
  function reset() {
    cleanup?.(); cleanup = null; profile = null; identity = null; drafts.clear(); contexts.clear(); ++mountRequest; ++composerRequest;
  }
  function forgetDraft(documentId) {
    drafts.delete(documentId);
    // Re-read delivery history too: changing a contact is never permission to
    // bypass a send whose outcome is still uncertain on the server.
    contexts.clear();
  }
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
          profile = normalizeMailProfile(result, ctx.getUser() || {}); contexts.clear();
          const message = action === 'configure' ? 'Correo conectado y comprobado. La copia se guardará en Enviados.' : action === 'disconnect' ? 'Correo desconectado.' : 'Firma guardada.';
          cleanup?.(); draw(message); ctx.toast(message);
        },
      });
    }
    draw('', refresh);
    if (refresh) try { await loadProfile(); draw(); } catch (error) { draw(error.message); }
  }
  async function openComposer(document) {
    current();
    const invoice = document.kind === 'invoice', kind = invoice ? 'factura' : 'presupuesto';
    const isCurrent = ctx.scope(), backend = ctx.getBackend(), cloud = ctx.getMode() === 'cloud';
    if (ctx.isBusy() || ctx.isConflict()) return ctx.toast('Termina de revisar los cambios antes de enviar.', true);
    const request = ++composerRequest;
    ctx.openModal(ctx.header(`Enviar ${kind}`) + renderMailLoading());
    const modal = ctx.root.querySelector('.modal');
    const valid = () => request === composerRequest && isCurrent() && modal.isConnected;
    let data, draft, job, dispose;
    const documentNow = () => ctx.documentFor(document.id) || document;
    const remember = () => contexts.remember(document.id, data);
    const chooseJob = () => data.history.find(entry => entry.id === draft?.idempotencyKey);
    const bindClose = () => modal.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => ctx.closeModal(); });
    function newMail() {
      if (!valid() || ctx.isBusy() || ctx.isConflict()) return;
      draft = { ...draft, attachments: [], idempotencyKey: crypto.randomUUID() };
      drafts.set(document.id, draft); job = null; draw();
    }
    async function reloadHistory() {
      if (!valid() || ctx.isBusy()) return;
      const fresh = await contexts.get(document.id, { force: true });
      if (!valid()) return;
      data = fresh; profile = fresh.profile;
      job = chooseJob() || (job ? fresh.history.find(entry => entry.id === job.id) || job : null);
      draw();
    }
    function onResult(result) {
      if (!valid()) return;
      if (result.workspace) ctx.adopt(result.workspace);
      job = result.job;
      if (job?.errorCode !== 'SMTP_PARTIAL' && ['sent', 'archive_pending', 'failed'].includes(job?.status)) {
        draft = { ...draft, attachments: [] }; drafts.set(document.id, draft);
      }
      data = { ...data, history: mergeMailJob(data.history, job) }; remember();
      draw();
    }
    async function send(fields) {
      if (!valid() || !cloud || ctx.isConflict() || ctx.isBusy()) throw new Error(`Entra de nuevo y revisa ${invoice ? 'la' : 'el'} ${kind} antes de enviar.`);
      ctx.setBusy(true);
      try { return await backend.mail.send(document.id, fields); }
      finally { if (isCurrent()) ctx.setBusy(false); }
    }
    async function retryArchive(fields) {
      if (!valid() || !cloud || ctx.isBusy()) throw new Error('Espera a que termine la operación actual.');
      ctx.setBusy(true);
      try { return await backend.mail.retryArchive(fields); }
      finally { if (isCurrent()) ctx.setBusy(false); }
    }
    function draw() {
      if (!valid()) return;
      dispose?.();
      modal.classList.toggle('wide', !job);
      const title = job ? `Envío ${invoice ? 'de la' : 'del'} ${kind}` : `Enviar ${kind}`;
      modal.innerHTML = ctx.header(title, document.number) + (job
        ? renderMailResult({ job, document: documentNow(), history: data.history })
        : renderMailComposer({ document: documentNow(), client: ctx.clientFor(documentNow()), profile: data.profile, history: data.history, preview: ctx.preview(documentNow()), draft, logoUrl: ctx.logoUrl }));
      bindClose();
      const bindings = {
        draft, document: documentNow(), profile: data.profile, logoUrl: ctx.logoUrl, send, onResult, retryArchive, reloadHistory, onNewMail: newMail, isCurrent: valid,
        onDraftChange: value => { if (valid()) { draft = value; drafts.set(document.id, value); } },
        configure: () => { ctx.closeModal(true); ctx.navigate('personal'); },
      };
      dispose = job ? bindMailResult(modal, bindings) : bindMailComposer(modal, bindings);
      modal.scrollTop = 0;
      modal.querySelector(job ? '[data-new-mail], [data-close]' : 'input[name="to"]')?.focus({ preventScroll: true });
    }
    ctx.cleanup(() => dispose?.());
    try {
      data = await contexts.get(document.id);
      if (!valid()) return;
      profile = data.profile;
      const saved = drafts.get(document.id);
      const latest = documentNow(), client = ctx.clientFor(latest);
      ({ draft, job } = resolveMailComposeEntry({ savedDraft: saved, history: data.history,
        defaultDraft: defaultMailDraft(latest, client),
        preferDefaultRecipients: latest.kind === 'invoice' && Boolean(latest.billingEmail || client?.billingEmail) }));
      drafts.set(document.id, draft);
      draw();
    } catch (error) {
      if (!valid()) return;
      modal.classList.remove('wide');
      modal.innerHTML = ctx.header('Correo no disponible') + '<p class="mail-job-error"></p><button class="button secondary" data-close>Cerrar</button>';
      modal.querySelector('.mail-job-error').textContent = error.message; bindClose();
    }
  }
  return { reset, forgetDraft, mountSettings, openComposer };
}
