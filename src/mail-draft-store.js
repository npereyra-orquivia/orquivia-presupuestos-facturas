const copy = value => structuredClone(value);
const failure = (message, code) => Object.assign(new Error(message), { code });

function text(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw failure('Revisa los campos del borrador.', 'INVALID_DRAFT');
  return value;
}

function addresses(value) {
  if (Array.isArray(value)) {
    if (value.some(address => typeof address !== 'string')) throw failure('Revisa los destinatarios del borrador.', 'INVALID_DRAFT');
    return value.join(', ');
  }
  return text(value);
}

/** Persist references to official PDFs, never file bytes or mailbox credentials. */
export function serializeMailDraft(value = {}) {
  const ids = value.relatedDocumentIds === undefined ? [] : value.relatedDocumentIds;
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw failure('Revisa los presupuestos seleccionados.', 'INVALID_DRAFT');
  return {
    to: addresses(value.to), cc: addresses(value.cc), subject: text(value.subject), message: text(value.message),
    relatedDocumentIds: [...ids], idempotencyKey: text(value.idempotencyKey),
  };
}

/** Serialize saves with a server CAS version; edits made in flight are coalesced. */
export function createMailDraftStore({ initialDraft = {}, version = 0, updatedAt = null, save,
  isCurrent = () => true, onState = () => {}, delay = 650,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof save !== 'function' || !Number.isSafeInteger(version) || version < 0) throw new TypeError('Invalid draft store configuration');
  let draft = serializeMailDraft(initialDraft), key = JSON.stringify(draft), savedKey = version > 0 ? key : null;
  let timer = null, running = null, busy = false, disposed = false, error = null, conflict = null;
  const available = () => !disposed && isCurrent();
  const scopeError = () => failure(disposed ? 'El borrador se ha cerrado.' : 'La sesión cambió. Vuelve a abrir el borrador.', disposed ? 'DRAFT_DISPOSED' : 'AUTH_CHANGED');
  const dirty = () => key !== savedKey;
  function getState() {
    return { status: conflict ? 'conflict' : busy ? 'saving' : error ? 'error' : dirty() ? 'dirty' : 'saved',
      dirty: dirty(), version, updatedAt, error: conflict || error, draft: copy(draft) };
  }
  const notify = () => { if (available()) onState(getState()); };
  function stopTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
  function schedule() {
    stopTimer();
    if (!available() || running || conflict || !dirty()) return;
    timer = setTimer(() => { timer = null; saveNow().catch(() => {}); }, delay);
  }
  function set(value) {
    if (!available()) throw scopeError();
    const next = serializeMailDraft(value), nextKey = JSON.stringify(next);
    if (nextKey === key) return getState();
    draft = next; key = nextKey;
    if (!conflict) error = null;
    notify(); schedule();
    return getState();
  }
  function saveNow() {
    stopTimer();
    if (!available()) return Promise.reject(scopeError());
    if (conflict) return Promise.reject(conflict);
    if (running) return running;
    if (!dirty()) return Promise.resolve(getState());
    // Assign the promise before callbacks can synchronously queue another edit.
    running = Promise.resolve().then(async () => {
      try {
        while (dirty()) {
          if (!available()) throw scopeError();
          const captured = copy(draft), capturedKey = key, expected = version;
          busy = true; error = null; notify();
          const result = await save(captured, expected);
          if (!available()) throw scopeError();
          if (!result || !Number.isSafeInteger(result.version) || result.version !== expected + 1) {
            throw failure('No se pudo confirmar el guardado del borrador. Vuelve a cargarlo antes de continuar.', 'DRAFT_RESPONSE_INVALID');
          }
          version = result.version; updatedAt = result.updatedAt || null; savedKey = capturedKey;
          busy = false; notify();
        }
        return getState();
      } catch (cause) {
        if (available()) {
          error = cause instanceof Error ? cause : failure('No se pudo guardar el borrador.', 'DRAFT_SAVE_FAILED');
          if (error.code === 'DRAFT_CONFLICT') conflict = error;
        }
        throw cause;
      } finally { busy = false; notify(); }
    }).finally(() => { running = null; });
    return running;
  }
  function dispose() { stopTimer(); disposed = true; }
  return { set, saveNow, getState, dispose };
}
