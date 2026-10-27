import test from 'node:test';
import assert from 'node:assert/strict';
import { OFFICIAL_PORTAL_URL, MONITOR_LIMITS, monitorConfiguration, portalEntryAssets, monitorPortal, monitorSummary, main } from '../scripts/operations/monitor.mjs';

const HTML = '<!doctype html><html><head><title>Orquivia · Portal</title><script type="module" src="./assets/index-123.js"></script><link rel="stylesheet" href="./assets/index-456.css"></head><body><div id="app"></div></body></html>';
const PUBLIC = { VITE_SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_public-example' };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
function responder(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (Object.hasOwn(overrides, url)) return typeof overrides[url] === 'function' ? overrides[url](url, options) : overrides[url].clone();
    if (url === OFFICIAL_PORTAL_URL) return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    if (url.endsWith('/version.json')) return json({ version: '1.4.1' });
    if (url.endsWith('.js')) return new Response('export const ready=true;', { headers: { 'content-type': 'text/javascript' } });
    if (url.endsWith('.css')) return new Response('body{color:black}', { headers: { 'content-type': 'text/css' } });
    if (url.endsWith('/auth/v1/health')) return json({ name: 'GoTrue', version: 'example' });
    throw new Error('Unexpected URL in test');
  };
  return { fetcher, calls };
}

test('monitor accepts only the official root and a complete optional public Auth pair', () => {
  assert.equal(monitorConfiguration().auth, null);
  assert.equal(monitorConfiguration({ ORQUIVIA_PORTAL_URL: OFFICIAL_PORTAL_URL, ...PUBLIC }).auth.anonKey, PUBLIC.VITE_SUPABASE_PUBLISHABLE_KEY);
  for (const ORQUIVIA_PORTAL_URL of ['http://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/', `${OFFICIAL_PORTAL_URL}?token=secret`, `${OFFICIAL_PORTAL_URL}#facturas`, 'https://evil.test/', OFFICIAL_PORTAL_URL.slice(0, -1)]) {
    assert.throws(() => monitorConfiguration({ ORQUIVIA_PORTAL_URL }), /Configuración no admitida/);
  }
  for (const env of [{ VITE_SUPABASE_URL: PUBLIC.VITE_SUPABASE_URL }, { VITE_SUPABASE_PUBLISHABLE_KEY: PUBLIC.VITE_SUPABASE_PUBLISHABLE_KEY }, { ...PUBLIC, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private' }, { ...PUBLIC, VITE_SUPABASE_URL: 'https://user:secret@example.test/' }]) {
    assert.throws(() => monitorConfiguration(env), /Configuración no admitida/);
  }
});

test('public monitor checks root, release version and only direct JS/CSS assets without authentication', async () => {
  const fake = responder();
  const report = await monitorPortal({ fetcher: fake.fetcher });
  assert.equal(report.ok, true);
  assert.equal(report.version, '1.4.1');
  assert.equal(report.assetsChecked, 2);
  assert.equal(report.auth, 'not_configured');
  assert.equal(fake.calls.length, 4);
  for (const { url, options } of fake.calls) {
    assert.ok(url.startsWith(OFFICIAL_PORTAL_URL));
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.apikey, undefined);
    assert.equal(options.headers.Authorization, undefined);
  }
});

test('optional Auth probe is GET health only and transmits only the validated public apikey to Supabase', async () => {
  const fake = responder();
  const report = await monitorPortal({ env: PUBLIC, fetcher: fake.fetcher });
  assert.equal(report.ok, true);
  assert.equal(report.auth, 'ok');
  const authCalls = fake.calls.filter(call => call.url.startsWith(PUBLIC.VITE_SUPABASE_URL));
  assert.equal(authCalls.length, 1);
  assert.equal(authCalls[0].url, `${PUBLIC.VITE_SUPABASE_URL}/auth/v1/health`);
  assert.equal(authCalls[0].options.headers.apikey, PUBLIC.VITE_SUPABASE_PUBLISHABLE_KEY);
  assert.equal(authCalls[0].options.headers.Authorization, undefined);
  assert.ok(fake.calls.every(call => !/storage|rest\/v1|token|user|workspace/.test(call.url)));
});

test('bad public configuration fails before making a network request and never prints its input', async () => {
  let calls = 0;
  const report = await monitorPortal({ env: { ...PUBLIC, VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_DO_NOT_PRINT' }, fetcher: async () => { calls++; } });
  assert.equal(report.ok, false);
  assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(report) + monitorSummary(report), /DO_NOT_PRINT|sb_secret/);
});

test('asset parser rejects off-origin, traversal, queries, encoded attributes and base changes before requesting assets', () => {
  for (const source of ['https://evil.test/index.js', '//evil.test/index.js', '../assets/index.js', './assets/../index.js', './assets/index.js?token=secret', './assets/index.js#secret', './assets/%69ndex.js', '&#104;ttps://evil.test/index.js', 'javascript:alert(1)']) {
    assert.throws(() => portalEntryAssets(HTML.replace('./assets/index-123.js', source)), /entradas de la aplicación/);
  }
  assert.throws(() => portalEntryAssets(HTML.replace('<head>', '<head><base href="https://evil.test/">')), /contenido público/);
  assert.throws(() => portalEntryAssets(HTML.replace('src="./assets/index-123.js"', 'src="./assets/index-123.js" src="https://evil.test/a.js"')), /entradas de la aplicación/);
  assert.throws(() => portalEntryAssets('<html><title>Not the portal</title></html>'), /contenido público/);
});

test('monitor rejects redirects and never follows the Location destination or retries a redirect', async () => {
  const fake = responder({ [OFFICIAL_PORTAL_URL]: new Response('', { status: 302, headers: { location: 'https://evil.test/?token=secret' } }) });
  const report = await monitorPortal({ fetcher: fake.fetcher, sleep: async () => {} });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.id === 'portal').code, 'REDIRECT');
  assert.equal(fake.calls.filter(call => call.url === OFFICIAL_PORTAL_URL).length, 1);
  assert.ok(fake.calls.every(call => !call.url.includes('evil.test')));
  assert.doesNotMatch(monitorSummary(report), /evil|secret|Location/);
});

test('discarding a cloned response does not wait on its unconsumed sibling body', async () => {
  const fake = responder({ [OFFICIAL_PORTAL_URL]: new Response('discarded response', { status: 302, headers: { location: 'https://evil.test/' } }) });
  const report = await monitorPortal({ fetcher: fake.fetcher, timeoutMs: 50, retries: 0 });
  assert.equal(report.checks.find(check => check.id === 'portal').code, 'REDIRECT');
  assert.equal(report.ok, false);
});

test('size limits apply to both declared length and streamed bytes', async () => {
  for (const response of [new Response('small', { headers: { 'content-type': 'text/html', 'content-length': `${MONITOR_LIMITS.html + 1}` } }), new Response('x'.repeat(MONITOR_LIMITS.html + 1), { headers: { 'content-type': 'text/html' } })]) {
    const fake = responder({ [OFFICIAL_PORTAL_URL]: response });
    const report = await monitorPortal({ fetcher: fake.fetcher });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find(check => check.id === 'portal').code, 'SIZE');
    assert.equal(fake.calls.filter(call => call.url === OFFICIAL_PORTAL_URL).length, 1);
  }
});

test('a wrong MIME type, empty script or invalid version never reports the portal healthy', async () => {
  const variants = [
    { [`${OFFICIAL_PORTAL_URL}assets/index-123.js`]: new Response('<html>not found</html>', { headers: { 'content-type': 'text/html' } }) },
    { [`${OFFICIAL_PORTAL_URL}assets/index-123.js`]: new Response('', { headers: { 'content-type': 'text/javascript' } }) },
    { [`${OFFICIAL_PORTAL_URL}version.json`]: json({ version: '<script>secret</script>' }) },
  ];
  for (const overrides of variants) {
    const fake = responder(overrides);
    const report = await monitorPortal({ fetcher: fake.fetcher });
    assert.equal(report.ok, false);
    assert.doesNotMatch(monitorSummary(report), /secret|<script>/);
  }
});

test('temporary network and HTTP failures retry at most once while a 404 does not retry', async () => {
  let attempts = 0;
  const temporary = responder({ [OFFICIAL_PORTAL_URL]: () => ++attempts === 1 ? new Response('private diagnostic', { status: 503 }) : new Response(HTML, { headers: { 'content-type': 'text/html' } }) });
  assert.equal((await monitorPortal({ fetcher: temporary.fetcher, sleep: async () => {} })).ok, true);
  assert.equal(attempts, 2);
  const permanent = responder({ [OFFICIAL_PORTAL_URL]: new Response('private diagnostic', { status: 404 }) });
  assert.equal((await monitorPortal({ fetcher: permanent.fetcher, sleep: async () => {} })).ok, false);
  assert.equal(permanent.calls.filter(call => call.url === OFFICIAL_PORTAL_URL).length, 1);
});

test('timeouts finish even if a fetch implementation ignores abort and redact thrown diagnostics', async () => {
  const timed = responder({ [OFFICIAL_PORTAL_URL]: () => new Promise(() => {}) });
  const report = await monitorPortal({ fetcher: timed.fetcher, timeoutMs: 5, retries: 0 });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find(check => check.id === 'portal').code, 'TIMEOUT');
  const throwing = responder({ [OFFICIAL_PORTAL_URL]: () => { throw new Error('https://secret.example/?token=DO_NOT_PRINT'); } });
  const failed = await monitorPortal({ fetcher: throwing.fetcher, retries: 1, sleep: async () => {} });
  assert.equal(throwing.calls.filter(call => call.url === OFFICIAL_PORTAL_URL).length, 2);
  assert.doesNotMatch(JSON.stringify(failed) + monitorSummary(failed), /secret|token|DO_NOT_PRINT/);
});

test('CLI function returns a nonzero failure code with a generic summary and no response body', async () => {
  const lines = [];
  const fake = responder({ [OFFICIAL_PORTAL_URL]: new Response('PASSWORD_DO_NOT_PRINT', { status: 500 }) });
  assert.equal(await main({ env: {}, fetcher: fake.fetcher, output: line => lines.push(line) }), 1);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /PASSWORD|https:|token|Error:/);
  assert.match(lines[0], /comprobación fallida/);
  assert.equal(await main({ env: {}, fetcher: responder().fetcher, output: () => {} }), 0);
});
