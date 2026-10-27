import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publicConfigIsValid } from '../../src/security.js';

export const OFFICIAL_PORTAL_URL = 'https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/';
export const MONITOR_LIMITS = Object.freeze({ html: 131_072, version: 1024, js: 2_097_152, css: 524_288, auth: 16_384, assets: 8 });
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'RETRYABLE_HTTP']);
const messages = Object.freeze({
  CONFIGURATION: 'Configuración no admitida.', NETWORK: 'No se pudo contactar con el servicio.',
  TIMEOUT: 'La comprobación agotó su tiempo de espera.', HTTP: 'El servicio no respondió correctamente.',
  RETRYABLE_HTTP: 'El servicio no está disponible temporalmente.', REDIRECT: 'El servicio respondió con una redirección no admitida.',
  CONTENT_TYPE: 'El servicio devolvió un formato inesperado.', SIZE: 'La respuesta superó el tamaño permitido.',
  CONTENT: 'El contenido público no tiene el formato esperado.', ASSETS: 'Las entradas de la aplicación no son válidas.',
});
class MonitorError extends Error {
  constructor(code) { super(messages[code] || messages.CONTENT); this.code = code; }
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// Cancelling one branch of a cloned/tee'd body can wait for the other branch.
// Discard a response without letting cleanup exceed the request's time budget.
function discardBody(body) {
  try { void body?.cancel().catch(() => {}); } catch { /* Cleanup is best effort. */ }
}

/** Configuration accepts only the fixed public portal and an optional pair of public Auth values. */
export function monitorConfiguration(env = {}) {
  if (env.ORQUIVIA_PORTAL_URL !== undefined && env.ORQUIVIA_PORTAL_URL !== '' && env.ORQUIVIA_PORTAL_URL !== OFFICIAL_PORTAL_URL) {
    throw new MonitorError('CONFIGURATION');
  }
  const url = env.VITE_SUPABASE_URL || '', anonKey = env.VITE_SUPABASE_PUBLISHABLE_KEY || '';
  if ((url || anonKey) && !publicConfigIsValid({ url, anonKey })) throw new MonitorError('CONFIGURATION');
  return { portalURL: OFFICIAL_PORTAL_URL, auth: url && anonKey ? { url, anonKey } : null };
}

function attributes(tag) {
  const result = Object.create(null);
  const regex = /\b(src|href|rel|type)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
  for (const match of tag.matchAll(regex)) {
    const key = match[1].toLowerCase();
    if (Object.hasOwn(result, key)) throw new MonitorError('ASSETS');
    result[key] = match[2] ?? match[3] ?? match[4];
  }
  return result;
}

/** Never executes HTML or JS. Only direct, public JS/CSS entry assets are followed. */
export function portalEntryAssets(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<base\b/i.test(source) || !/<div\b[^>]*\bid=["']app["']/i.test(source) || !/<title>[^<]*Orquivia[^<]*<\/title>/i.test(source)) {
    throw new MonitorError('CONTENT');
  }
  const base = new URL(OFFICIAL_PORTAL_URL), assets = new Map();
  for (const match of source.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase(), attrs = attributes(match[0]);
    const type = tag === 'script' && attrs.src ? 'js' : tag === 'link' && attrs.rel?.toLowerCase().split(/\s+/).includes('stylesheet') ? 'css' : null;
    if (!type) continue;
    const value = tag === 'script' ? attrs.src : attrs.href;
    if (!value || /[\s\\&?#%\p{Cc}]/u.test(value) || value.includes('..')) throw new MonitorError('ASSETS');
    let url;
    try { url = new URL(value, base); } catch { throw new MonitorError('ASSETS'); }
    const relative = url.pathname.slice(base.pathname.length);
    if (url.protocol !== 'https:' || url.origin !== base.origin || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith(base.pathname) || !new RegExp(`^assets/[A-Za-z0-9][A-Za-z0-9._-]*\\.${type}$`).test(relative)) {
      throw new MonitorError('ASSETS');
    }
    assets.set(url.href, { url: url.href, type });
    if (assets.size > MONITOR_LIMITS.assets) throw new MonitorError('ASSETS');
  }
  if (![...assets.values()].some(asset => asset.type === 'js') || ![...assets.values()].some(asset => asset.type === 'css')) {
    throw new MonitorError('ASSETS');
  }
  return [...assets.values()];
}

async function boundedText(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    discardBody(response.body); throw new MonitorError('SIZE');
  }
  if (!response.body?.getReader) throw new MonitorError('CONTENT');
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { discardBody(reader); throw new MonitorError('SIZE'); }
      chunks.push(value);
    }
    if (!length) throw new MonitorError('CONTENT');
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new MonitorError('CONTENT'); }
  } finally { reader.releaseLock(); }
}

const mimeTypes = Object.freeze({
  html: new Set(['text/html']), version: new Set(['application/json']),
  js: new Set(['application/javascript', 'text/javascript', 'application/x-javascript']), css: new Set(['text/css']),
  auth: new Set(['application/json']),
});

async function fetchPublic(url, kind, { fetcher, timeoutMs, retries, sleep, deadline, headers = {} }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = Math.min(timeoutMs, deadline - Date.now());
    if (remaining <= 0) throw new MonitorError('TIMEOUT');
    const controller = new AbortController();
    let timeout;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetcher(url, { method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
            headers: { Accept: kind === 'html' ? 'text/html' : kind === 'js' ? 'application/javascript,text/javascript' : kind === 'css' ? 'text/css' : 'application/json', ...headers } });
          if (response.redirected || (response.status >= 300 && response.status < 400) || (response.url && response.url !== url)) {
            discardBody(response.body); throw new MonitorError('REDIRECT');
          }
          if (response.status !== 200) {
            discardBody(response.body);
            throw new MonitorError([429, 502, 503, 504].includes(response.status) ? 'RETRYABLE_HTTP' : 'HTTP');
          }
          const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          if (!mimeTypes[kind].has(mime)) { discardBody(response.body); throw new MonitorError('CONTENT_TYPE'); }
          return boundedText(response, MONITOR_LIMITS[kind]);
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new MonitorError('TIMEOUT')); }, remaining); }),
      ]);
    } catch (error) {
      const failure = error instanceof MonitorError ? error : new MonitorError(controller.signal.aborted ? 'TIMEOUT' : 'NETWORK');
      if (!RETRYABLE.has(failure.code) || attempt === retries || Date.now() >= deadline) throw failure;
    } finally { clearTimeout(timeout); controller.abort(); }
    await sleep(250);
  }
  throw new MonitorError('NETWORK');
}

/** Read-only availability check. No login, workspace, Storage, mailbox or backup endpoint is queried. */
export async function monitorPortal({ env = {}, fetcher = globalThis.fetch, timeoutMs = 10_000, retries = 1, sleep = pause, maxRunMs = 45_000 } = {}) {
  const report = { ok: false, checks: [], version: null, assetsChecked: 0, auth: 'not_configured' };
  let config;
  try {
    config = monitorConfiguration(env);
    if (typeof fetcher !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000
      || ![0, 1].includes(retries) || !Number.isInteger(maxRunMs) || maxRunMs < 1 || maxRunMs > 60_000) throw new MonitorError('CONFIGURATION');
  } catch { report.checks.push({ id: 'configuration', ok: false, code: 'CONFIGURATION' }); return report; }
  const request = (url, kind, headers) => fetchPublic(url, kind, { fetcher, timeoutMs, retries, sleep, deadline, headers });
  const deadline = Date.now() + maxRunMs;
  async function check(id, operation) {
    try { const value = await operation(); report.checks.push({ id, ok: true }); return value; }
    catch (error) { report.checks.push({ id, ok: false, code: error instanceof MonitorError ? error.code : 'CONTENT' }); return null; }
  }
  const html = await check('portal', () => request(config.portalURL, 'html'));
  await check('version', async () => {
    const text = await request(new URL('version.json', config.portalURL).href, 'version');
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new MonitorError('CONTENT'); }
    if (!parsed || Array.isArray(parsed) || typeof parsed.version !== 'string' || parsed.version.length > 64 || !VERSION.test(parsed.version)) throw new MonitorError('CONTENT');
    report.version = parsed.version;
    return true;
  });
  if (html !== null) await check('assets', async () => {
    const entries = portalEntryAssets(html);
    for (const asset of entries) { await request(asset.url, asset.type); report.assetsChecked++; }
    return true;
  });
  if (config.auth) {
    report.auth = 'failed';
    const result = await check('auth', async () => {
      const text = await request(new URL('auth/v1/health', `${config.auth.url.replace(/\/$/, '')}/`).href, 'auth', { apikey: config.auth.anonKey });
      let parsed;
      try { parsed = JSON.parse(text); } catch { throw new MonitorError('CONTENT'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new MonitorError('CONTENT');
      return true;
    });
    if (result) report.auth = 'ok';
  }
  report.ok = report.checks.length >= 3 && report.checks.every(entry => entry.ok);
  return report;
}

/** The log contract is intentionally finite: no fetched URL, body, exception text or key is printed. */
export function monitorSummary(report) {
  const labels = { configuration: 'configuración', portal: 'portal', version: 'versión', assets: 'entradas JS/CSS', auth: 'servicio de acceso' };
  const failed = report.checks.filter(check => !check.ok);
  if (failed.length) return `Orquivia: comprobación fallida. ${failed.map(check => `${labels[check.id] || 'servicio'}: ${messages[check.code] || messages.CONTENT}`).join(' ')}`;
  return `Orquivia: portal disponible; versión ${report.version}; ${report.assetsChecked} entradas JS/CSS comprobadas. Servicio de acceso: ${report.auth === 'ok' ? 'responde' : 'sin configurar en esta comprobación'}.`;
}

export async function main({ env = process.env, fetcher = globalThis.fetch, output = text => process.stdout.write(`${text}\n`) } = {}) {
  try {
    const report = await monitorPortal({ env, fetcher });
    output(monitorSummary(report));
    return report.ok ? 0 : 1;
  } catch { output('Orquivia: no se pudo completar la comprobación técnica.'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
