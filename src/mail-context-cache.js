/** Short-lived, memory-only mail context. Never shared across accounts or resets. */
export function createMailContextCache({ getIdentity, load, now = Date.now, maxAge = 30_000 }) {
  let identity, generation = 0;
  const entries = new Map();
  function clear() { ++generation; entries.clear(); identity = getIdentity(); }
  function sync() { if (identity !== getIdentity()) clear(); }
  function remember(documentId, value) {
    sync(); entries.set(documentId, { value, at: now() }); return value;
  }
  async function get(documentId, { force = false } = {}) {
    sync();
    const entry = entries.get(documentId), stamp = now();
    if (entry?.pending) return entry.pending;
    if (!force && entry?.value && stamp >= entry.at && stamp - entry.at < maxAge) return entry.value;
    const capturedGeneration = generation, capturedIdentity = identity;
    const pending = Promise.resolve().then(() => load(documentId)).then(value => {
      if (generation !== capturedGeneration || getIdentity() !== capturedIdentity) {
        throw Object.assign(new Error('La sesión cambió. Vuelve a entrar.'), { code: 'AUTH_CHANGED' });
      }
      return remember(documentId, value);
    }).catch(error => {
      if (entries.get(documentId)?.pending === pending) entries.delete(documentId);
      throw error;
    });
    entries.set(documentId, { pending });
    return pending;
  }
  return { get, remember, clear };
}

export function mergeMailJob(history, job) {
  if (!job?.id) return history;
  return [job, ...history.filter(entry => entry.id !== job.id)].slice(0, 30);
}
