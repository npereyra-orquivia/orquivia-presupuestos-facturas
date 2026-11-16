import { renderMailSettings, bindMailSettings, renderMailComposer, bindMailComposer, renderMailLoading, renderMailResult, bindMailResult } from './mail-ui.js';
import { defaultMailProfile, normalizeMailProfile, defaultMailDraft } from './mail-domain.js';
import { createMailContextCache, mergeMailJob } from './mail-context-cache.js';
import { resolveMailComposeEntry } from './mail-compose-entry.js';
import { normalizeOrquivia } from './brand.js';
import { relatedQuoteOptions, renderRelatedQuotePreviews } from './mail-related-quotes.js';
import { createMailDraftStore } from './mail-draft-store.js';

export function createMailFeature(ctx) {
  let profile = null, identity = null, cleanup = null, mountRequest = 0, composerRequest = 0;
  const drafts = new Map();
  const contexts = createMailContextCache({
    getIdentity: () => `${ctx.getMode()}:${ctx.getUser()?.id || ''}`,
    async load(documentId) {
      const isCurrent = ctx.scope();
      const result = ctx.getMode() === 'cloud' ? await ctx.getBackend().mail.composer(documentId) : { profile: current(), history: [] };
      if (!isCurrent()) throw new Error('La sesión cambió. Vuelve a entrar.');
      return { profile: normalizeMailProfile(result.profile, ctx.getUser() || {}), history: Array.isArray(result.history) ? result.history : [],
        draft: result.draft || null, draftVersion: result.draftVersion || 0, draftUpdatedAt: result.draftUpdatedAt || null };
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
    let data, draft, job, dispose, draftStore, closing = false;
    const documentNow = () => ctx.documentFor(document.id) || document;
    const remember = () => contexts.remember(document.id, data);
    const chooseJob = () => data.history.find(entry => entry.id === draft?.idempotencyKey);
    function renderDraftState(value = draftStore?.getState()) {
      if (!valid() || !value) return;
      const status = modal.querySelector('[data-mail-draft-status]');
      if (status) {
        const time = value.updatedAt ? new Date(value.updatedAt).toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }) : '';
        status.textContent = value.status === 'saved' ? `Borrador guardado en tu cuenta${time ? ' · ' + time : ''}.`
          : value.status === 'saving' ? 'Guardando borrador…'
            : value.status === 'dirty' ? 'Cambios pendientes de guardar…'
              : value.error?.message || 'No se ha podido guardar. Conserva esta ventana y vuelve a intentarlo.';
        status.classList.toggle('is-error', ['error', 'conflict'].includes(value.status));
      }
      const reload = modal.querySelector('[data-reload-mail-draft]');
      if (reload) reload.hidden = value.status !== 'conflict';
      if (value.status === 'saved') {
        data = { ...data, draft: value.draft, draftVersion: value.version, draftUpdatedAt: value.updatedAt }; remember();
      }
    }
    async function saveDraft(value = draft) {
      if (!valid()) throw new Error('Vuelve a abrir el borrador antes de guardarlo.');
      if (!draftStore) return;
      draftStore.set(value);
      await draftStore.saveNow();
    }
    async function requestClose() {
      if (!valid() || ctx.isBusy() || closing) return false;
      closing = true; ctx.setBusy(true);
      try {
        if (draftStore) await draftStore.saveNow();
        if (!valid()) return false;
        ctx.closeModal(true); return true;
      } catch (error) {
        if (valid()) { renderDraftState(); ctx.toast(error.message || 'Guarda el borrador antes de cerrar.', true); }
        return false;
      } finally {
        closing = false;
        if (isCurrent()) ctx.setBusy(false);
        if (valid()) ctx.setCloseHandler?.(requestClose);
      }
    }
    const bindClose = () => modal.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => requestClose(); });
    function newMail() {
      if (!valid() || ctx.isBusy() || ctx.isConflict()) return;
      draft = { ...draft, subject: normalizeOrquivia(draft.subject), message: normalizeOrquivia(draft.message), attachments: [], idempotencyKey: crypto.randomUUID() };
      drafts.set(document.id, draft); draftStore?.set(draft); job = null; draw();
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
      data = { ...data, history: mergeMailJob(data.history, job) }; contexts.clear(); remember();
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
      const relatedQuotes = relatedQuoteOptions(documentNow(), ctx.getDocuments?.() || []);
      const relatedPreview = ids => renderRelatedQuotePreviews(relatedQuotes.filter(value => ids.includes(value.id)), ctx.preview);
      modal.innerHTML = ctx.header(title, document.number) + (job
        ? renderMailResult({ job, document: documentNow(), history: data.history })
        : renderMailComposer({ document: documentNow(), client: ctx.clientFor(documentNow()), profile: data.profile, history: data.history, preview: ctx.preview(documentNow()), relatedQuotes, relatedPreviews: relatedPreview(draft.relatedDocumentIds || []), draft, draftPersistence: cloud, logoUrl: ctx.logoUrl }));
      bindClose();
      const bindings = {
        draft, document: documentNow(), relatedQuotes, relatedPreview, profile: data.profile, logoUrl: ctx.logoUrl, send, onResult, retryArchive, reloadHistory, onNewMail: newMail, isCurrent: valid,
        ...(cloud ? { saveDraft, beforeSend: saveDraft, reloadDraft: () => { drafts.delete(document.id); contexts.clear(); return openComposer(documentNow()); } } : {}),
        onClose: requestClose,
        onDraftChange: value => { if (valid()) { draft = value; drafts.set(document.id, value); draftStore?.set(value); } },
        configure: async () => { if (await requestClose()) ctx.navigate('personal'); },
      };
      dispose = job ? bindMailResult(modal, bindings) : bindMailComposer(modal, bindings);
      renderDraftState();
      modal.scrollTop = 0;
      modal.querySelector(job ? '[data-new-mail], [data-close]' : 'input[name="to"]')?.focus({ preventScroll: true });
    }
    const lifecycle = ctx.lifecycleTarget || (typeof window !== 'undefined' ? window : null);
    const beforeUnload = event => { const value = draftStore?.getState(); if (valid() && value && (value.dirty || ['saving', 'error', 'conflict'].includes(value.status))) { event.preventDefault(); event.returnValue = ''; } };
    ctx.cleanup(() => { dispose?.(); draftStore?.dispose(); lifecycle?.removeEventListener('beforeunload', beforeUnload); });
    try {
      data = await contexts.get(document.id, { force: cloud });
      if (!valid()) return;
      profile = data.profile;
      const memory = drafts.get(document.id);
      const saved = cloud ? (data.draft ? { ...data.draft, ...(memory?.idempotencyKey === data.draft.idempotencyKey && memory.attachments ? { attachments: memory.attachments } : {}) } : memory) : memory;
      const latest = documentNow(), client = ctx.clientFor(latest);
      ({ draft, job } = resolveMailComposeEntry({ savedDraft: saved, history: data.history,
        defaultDraft: defaultMailDraft(latest, client),
        preferDefaultRecipients: latest.kind === 'invoice' && Boolean(latest.billingEmail || client?.billingEmail) }));
      if (!saved && latest.kind === 'quote' && !job) {
        const previous = data.history[0]?.relatedDocumentIds?.length ? data.history[0] : null;
        if (previous) draft.relatedDocumentIds = [...new Set([previous.documentId, ...previous.relatedDocumentIds])].filter(id => id && id !== latest.id);
      }
      drafts.set(document.id, draft);
      if (cloud) {
        draftStore = createMailDraftStore({ initialDraft: data.draft || draft, version: data.draftVersion, updatedAt: data.draftUpdatedAt,
          save: (value, version) => backend.mail.saveDraft(document.id, value, version), isCurrent: valid, onState: renderDraftState });
        draftStore.set(draft);
        lifecycle?.addEventListener('beforeunload', beforeUnload);
        ctx.setCloseHandler?.(requestClose);
      }
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
