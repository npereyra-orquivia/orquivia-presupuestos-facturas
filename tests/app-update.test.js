import test from 'node:test';
import assert from 'node:assert/strict';
import { newerAppVersion, startAppUpdates } from '../src/app-update.js';

class Element {
  children = [];
  textContent = '';
  attributes = {};
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  setAttribute(name, value) { this.attributes[name] = value; }
  remove() { this.parent.children = this.parent.children.filter(node => node !== this); }
}

function fixture(fetcher, options = {}) {
  const win = new EventTarget(), doc = new EventTarget(), requests = [], confirmations = [];
  let time = 100_000, reloads = 0, answer = false;
  const href = 'https://example.test/orquivia-presupuestos-facturas/?view=alerts#facturas?estado=paid&envio=sent';
  win.location = { href, origin: new URL(href).origin, reload() { reloads++; } };
  win.confirm = message => { confirmations.push(message); return answer; };
  doc.baseURI = href; doc.visibilityState = 'visible'; doc.body = new Element();
  doc.createElement = () => new Element();
  const ui = startAppUpdates({ version: '1.3.0', win, doc, now: () => time,
    fetcher: async (...args) => { requests.push(args); return fetcher(...args); }, ...options });
  return { ui, win, doc, requests, confirmations, href,
    get reloads() { return reloads; }, get banner() { return doc.body.children[0]; },
    advance(ms = 60_000) { time += ms; }, confirm(value) { answer = value; } };
}
const response = version => new Response(JSON.stringify({ version }), { headers: { 'content-type': 'application/json' } });
const text = element => [element?.textContent || '', ...(element?.children || []).map(text)].join(' ');

test('release comparisons accept only a greater stable semantic version without lexical or integer errors', () => {
  for (const version of ['1.3.1', '1.10.0', '2.0.0', '999999999999999999999.0.0']) assert.equal(newerAppVersion(version, '1.3.0'), true);
  for (const version of ['1.3.0', '1.2.99', '0.99.0', '01.4.0', '1.4', 'v1.4.0', '1.4.0\n', '1.4.0-beta.1', '<script>1.4.0</script>', null, {}]) {
    assert.equal(newerAppVersion(version, '1.3.0'), false);
  }
  assert.equal(newerAppVersion('2.0.0', 'invalid'), false);
});

test('startup, focus and restored visibility share one public request and a 60-second throttle', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  f.win.dispatchEvent(new Event('focus')); f.doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.requests.length, 1);
  finish(response('1.3.0')); await f.ui.check();
  assert.equal(f.banner, undefined);
  const [url, request] = f.requests[0];
  assert.equal(url, 'https://example.test/orquivia-presupuestos-facturas/version.json');
  assert.equal(request.cache, 'no-store'); assert.equal(request.credentials, 'omit'); assert.equal(request.redirect, 'error');
  assert.ok(!url.includes('estado') && !url.includes('alerts'));
  f.advance(59_999); await f.ui.check(); assert.equal(f.requests.length, 1);
  f.advance(1); f.doc.visibilityState = 'hidden'; f.doc.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve(); assert.equal(f.requests.length, 1);
  f.doc.visibilityState = 'visible'; f.doc.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve(); assert.equal(f.requests.length, 2);
  finish(response('1.3.0')); await f.ui.check(); f.ui.dispose();
});

test('new release notice never reloads automatically and the explicit action preserves the current URL', async () => {
  const f = fixture(() => response('1.3.1'));
  const unsavedForm = { concept: 'Un cambio todavía sin guardar' };
  await f.ui.check();
  assert.equal(f.banner.attributes.role, 'status'); assert.equal(f.banner.attributes['aria-live'], 'polite');
  assert.match(text(f.banner), /actualización disponible/); assert.match(text(f.banner), /Guarda tus cambios/);
  const button = f.banner.children[1]; assert.equal(button.textContent, 'Actualizar');
  assert.equal(f.reloads, 0); assert.equal(f.confirmations.length, 0);
  button.onclick(); assert.equal(f.reloads, 0); assert.match(f.confirmations[0], /no hayas guardado se perderán/);
  assert.equal(unsavedForm.concept, 'Un cambio todavía sin guardar');
  f.confirm(true); button.onclick(); assert.equal(f.reloads, 1); assert.equal(f.win.location.href, f.href);
  f.banner.children[2].onclick(); assert.equal(f.banner.hidden, true);
  f.ui.dispose(); assert.equal(f.banner, undefined);
});

test('malformed, oversized, unavailable or older manifests never claim an available release', async () => {
  const results = [
    () => response('1.3.0'), () => response('1.2.2'), () => response('1.3.1-beta.1'),
    () => new Response('not json'), () => new Response('[{"version":"2.0.0"}]'),
    () => new Response(' ', { status: 503 }),
    () => new Response('{"version":"2.0.0"}', { headers: { 'content-length': '1025' } }),
    () => new Response(JSON.stringify({ version: '2.0.0', extra: 'a'.repeat(1024) })),
    () => { throw new Error('offline'); },
  ];
  for (const result of results) {
    const f = fixture(result); await f.ui.check();
    assert.equal(f.banner, undefined); assert.equal(f.reloads, 0); f.ui.dispose();
  }
});

test('stream limit uses bytes and cancels an oversized response even without content-length', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"version":"2.0.0","extra":"' + 'é'.repeat(520)));
  }, cancel() { cancelled = true; } });
  const f = fixture(() => new Response(stream)); await f.ui.check();
  assert.equal(cancelled, true); assert.equal(f.banner, undefined); f.ui.dispose();
});

test('a failed chunk offers an honest recovery action while preserving the original operation error', async () => {
  let remote = '1.3.0';
  const f = fixture(() => response(remote)); await f.ui.check();
  const error = new Event('vite:preloadError', { cancelable: true });
  f.win.dispatchEvent(error);
  assert.equal(error.defaultPrevented, false);
  assert.match(text(f.banner), /No se pudo cargar una parte/); assert.match(text(f.banner), /Puede faltar conexión/);
  assert.doesNotMatch(text(f.banner), /actualización disponible/);
  assert.equal(f.banner.children[1].textContent, 'Recargar'); assert.equal(f.reloads, 0);
  remote = '1.3.1'; f.advance(); await f.ui.check();
  assert.match(text(f.banner), /actualización disponible/); assert.equal(f.banner.children[1].textContent, 'Actualizar');
  f.ui.dispose();
});

test('dispose aborts the public request, removes event listeners and ignores its late response', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; })); await Promise.resolve();
  const signal = f.requests[0][1].signal;
  const inFlight = f.ui.check(); f.ui.dispose(); assert.equal(signal.aborted, true);
  finish(response('2.0.0')); await inFlight; assert.equal(f.banner, undefined);
  f.advance(); f.win.dispatchEvent(new Event('focus')); f.win.dispatchEvent(new Event('vite:preloadError'));
  await f.ui.check(); assert.equal(f.requests.length, 1); assert.equal(f.banner, undefined);
});

test('an external manifest base is rejected before making requests or registering notices', async () => {
  const f = fixture(() => response('2.0.0'), { baseURL: 'https://other.test/' });
  await f.ui.check(); f.win.dispatchEvent(new Event('vite:preloadError'));
  assert.equal(f.requests.length, 0); assert.equal(f.banner, undefined); f.ui.dispose();
});
