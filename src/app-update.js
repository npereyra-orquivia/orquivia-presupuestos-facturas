const CHECK_INTERVAL = 60_000;
const MAX_MANIFEST_BYTES = 1024;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function releaseParts(value) {
  return typeof value === 'string' && value.length <= 64 && value === value.trim() && RELEASE_VERSION.test(value)
    ? value.split('.').map(part => BigInt(part)) : null;
}

export function newerAppVersion(candidate, current) {
  const next = releaseParts(candidate), active = releaseParts(current);
  if (!next || !active) return false;
  for (let index = 0; index < 3; index++) {
    if (next[index] !== active[index]) return next[index] > active[index];
  }
  return false;
}

async function manifestVersion(response) {
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_MANIFEST_BYTES) {
    await response.body?.cancel(); return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_MANIFEST_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed && !Array.isArray(parsed) && releaseParts(parsed.version) ? parsed.version : null;
  } finally { reader.releaseLock(); }
}

/** Public release information only. No account state, authentication or storage is read. */
export function startAppUpdates({ version, baseURL = './', win = globalThis.window, doc = globalThis.document,
  fetcher = globalThis.fetch, now = Date.now } = {}) {
  const manifestURL = new URL('version.json', new URL(baseURL, doc.baseURI));
  if (!releaseParts(version) || manifestURL.origin !== win.location.origin) return { check: async () => {}, dispose() {} };
  let disposed = false, pending = null, controller = null, lastCheck = -Infinity;
  let availableVersion = null, loadFailed = false, banner = null;

  function renderNotice() {
    if (disposed || (!availableVersion && !loadFailed)) return;
    if (!banner) {
      banner = doc.createElement('aside');
      banner.className = 'app-update-notice';
      banner.setAttribute('role', 'status');
      banner.setAttribute('aria-live', 'polite');
      banner.setAttribute('aria-atomic', 'true');
      const copy = doc.createElement('div'), title = doc.createElement('strong'), description = doc.createElement('p');
      const button = doc.createElement('button'), dismiss = doc.createElement('button');
      copy.append(title, description); banner.append(copy, button, dismiss);
      button.type = 'button'; button.className = 'button secondary';
      dismiss.type = 'button'; dismiss.className = 'app-update-dismiss'; dismiss.textContent = '×';
      dismiss.setAttribute('aria-label', 'Cerrar aviso');
      dismiss.onclick = () => { banner.hidden = true; };
      button.onclick = () => {
        if (!disposed && win.confirm('La página se recargará. Guarda antes tus cambios: los que no hayas guardado se perderán. ¿Quieres continuar?')) win.location.reload();
      };
      doc.body.append(banner);
    }
    banner.hidden = false;
    const [copy, button] = banner.children, [title, description] = copy.children;
    title.textContent = availableVersion ? 'Hay una actualización disponible.' : 'No se pudo cargar una parte de Orquivia.';
    description.textContent = availableVersion ? 'Guarda tus cambios antes de actualizar. La dirección del portal se mantiene.'
      : 'Puede faltar conexión o haberse actualizado la aplicación. Guarda tus cambios antes de recargar.';
    button.textContent = availableVersion ? 'Actualizar' : 'Recargar';
  }

  function check() {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const timestamp = now();
    if (timestamp - lastCheck < CHECK_INTERVAL) return Promise.resolve();
    lastCheck = timestamp;
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10_000);
    pending = Promise.resolve().then(async () => {
      try {
        const response = await fetcher(manifestURL.href, { cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
        const candidate = await manifestVersion(response);
        if (!disposed && newerAppVersion(candidate, availableVersion || version)) { availableVersion = candidate; renderNotice(); }
      } catch { /* A failed public version check must never interrupt work or access. */ }
      finally { clearTimeout(timeout); pending = null; controller = null; }
    });
    return pending;
  }
  const onFocus = () => { if (doc.visibilityState !== 'hidden') void check(); };
  const onPreloadError = () => {
    // Preserve the original rejection so the operation's existing error handler runs.
    loadFailed = true; renderNotice(); void check();
  };
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onFocus);
  win.addEventListener('vite:preloadError', onPreloadError);
  void check();
  return { check, dispose() {
    disposed = true; controller?.abort(); banner?.remove();
    win.removeEventListener('focus', onFocus);
    doc.removeEventListener('visibilitychange', onFocus);
    win.removeEventListener('vite:preloadError', onPreloadError);
  } };
}
