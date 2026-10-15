import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { prepareRelease } from '../scripts/prepare-release.mjs';

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'orquivia-release-'));
  assert.equal(path.dirname(await fs.realpath(temporary)), temporaryRoot);
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'dist'), legacy = path.join(temporary, 'legacy');
  for (const [directory, name] of [[root, 'operational'], [legacy, 'legacy']]) {
    await fs.mkdir(path.join(directory, 'assets'), { recursive: true });
    await fs.writeFile(path.join(directory, 'index.html'), `<html><script type="module" src="./assets/${name}.js"></script></html>`);
    await fs.writeFile(path.join(directory, 'assets', `${name}.js`), `export const build = '${name}';`);
    await fs.writeFile(path.join(directory, 'service-worker.js'), `// ${name} original worker`);
    await fs.writeFile(path.join(directory, 'orquivia-icon-192.png'), Buffer.from([1, 2, 3, name.length]));
    await fs.writeFile(path.join(directory, 'manifest.webmanifest'), JSON.stringify({ id: './', name: 'Orquívia', start_url: './', scope: './', icons: [{ src: 'orquivia-icon-192.png', sizes: '192x192', type: 'image/png' }] }));
  }
  await fs.mkdir(path.join(legacy, 'pdfjs', 'standard_fonts'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'pdfjs', 'standard_fonts', 'font.ttf'), Buffer.from([0, 1, 255, 50]));
  await fs.writeFile(path.join(legacy, 'assets', 'lazy-pdf.js'), 'export const pdf = true;');
  await fs.writeFile(path.join(legacy, 'assets', 'legacy.css'), 'body{color:black}');
  await fs.writeFile(path.join(legacy, 'orquivia-logo.png'), Buffer.from([8, 9, 10]));
  return { temporary, root, legacy, target: path.join(root, 'pruebas-v1-1') };
}

test('release preserves old lazy assets and public resources while replacing only the legacy application entry', async t => {
  const f = await fixture(t), rootIndex = await fs.readFile(path.join(f.root, 'index.html'));
  const result = await prepareRelease({ dist: f.root, legacyDist: f.legacy });
  assert.equal(result.legacyDirectory, f.target);
  for (const file of ['assets/legacy.js', 'assets/lazy-pdf.js', 'assets/legacy.css', 'pdfjs/standard_fonts/font.ttf', 'orquivia-logo.png', 'orquivia-icon-192.png']) {
    assert.deepEqual(await fs.readFile(path.join(f.target, file)), await fs.readFile(path.join(f.legacy, file)));
  }
  assert.deepEqual(await fs.readFile(path.join(f.root, 'index.html')), rootIndex);
  assert.equal(await fs.readFile(path.join(f.root, 'service-worker.js'), 'utf8'), '// operational original worker');
  const html = await fs.readFile(path.join(f.target, 'index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);assert.match(html, /default-src 'none'; script-src 'self'/);
  assert.match(html, /<script src="\.\/redirect\.js" defer><\/script>/);
  assert.ok(!html.includes('assets/legacy.js'));
  assert.ok([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].every(match => !match[1].trim()));
  assert.ok(!html.includes('unsafe-inline'));assert.ok(!html.includes('http-equiv="refresh"'));
  // A second assembly replaces generated compatibility output, not the root.
  await fs.writeFile(path.join(f.target, 'stale.html'), '<p>old generated output</p>');
  await prepareRelease({ dist: f.root, legacyDist: f.legacy });
  await assert.rejects(fs.stat(path.join(f.target, 'stale.html')), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(f.root, 'index.html')), rootIndex);
});

test('legacy redirect preserves query and hash but cannot select another destination or origin', async t => {
  const f = await fixture(t);await prepareRelease({ dist: f.root, legacyDist: f.legacy });
  const source = await fs.readFile(path.join(f.target, 'redirect.js'), 'utf8');
  for (const suffix of ['?view=alerts#recordatorios', '?next=https%3A%2F%2Fevil.test#//evil.test', '#presupuestos?estado=all', '']) {
    const location = new URL(`https://example.test/orquivia-presupuestos-facturas/pruebas-v1-1/${suffix}`);
    let redirected;
    vm.runInNewContext(source, { URL, window: { location: { href: location.href, origin: location.origin, search: location.search, hash: location.hash, replace: value => { redirected = new URL(value); } } } });
    assert.equal(redirected.origin, 'https://example.test');assert.equal(redirected.pathname, '/orquivia-presupuestos-facturas/');
    assert.equal(redirected.search, location.search);assert.equal(redirected.hash, location.hash);
  }
});

test('legacy manifest retains its installed identity while opening the root and using root icons', async t => {
  const f = await fixture(t);await prepareRelease({ dist: f.root, legacyDist: f.legacy });
  const manifest = JSON.parse(await fs.readFile(path.join(f.target, 'manifest.webmanifest'), 'utf8'));
  const url = 'https://example.test/orquivia-presupuestos-facturas/pruebas-v1-1/manifest.webmanifest';
  assert.equal(new URL(manifest.id, url).pathname, '/orquivia-presupuestos-facturas/pruebas-v1-1/');
  assert.equal(new URL(manifest.start_url, url).pathname, '/orquivia-presupuestos-facturas/');
  assert.equal(new URL(manifest.scope, url).pathname, '/orquivia-presupuestos-facturas/');
  assert.equal(new URL(manifest.icons[0].src, url).pathname, '/orquivia-presupuestos-facturas/orquivia-icon-192.png');
});

test('legacy worker keeps subscriptions and opens root reminders with root icons without an imported worker', async t => {
  const f = await fixture(t);await prepareRelease({ dist: f.root, legacyDist: f.legacy });
  const source = await fs.readFile(path.join(f.target, 'service-worker.js'), 'utf8');
  assert.ok(!/importScripts\s*\(|^\s*import\s/m.test(source));assert.ok(!/unregister\s*\(|unsubscribe\s*\(/.test(source));
  const handlers = new Map(), notifications = [], opened = [], navigated = [];let focused = 0;
  const rootClient = { url: 'https://example.test/orquivia-presupuestos-facturas/#resumen', navigate: async value => { navigated.push(value);return rootClient; }, focus: async () => { ++focused; } };
  const clients = { claim: async () => {}, matchAll: async () => [rootClient], openWindow: async url => { opened.push(url); } };
  vm.runInNewContext(source, { URL, self: { registration: { scope: 'https://example.test/orquivia-presupuestos-facturas/pruebas-v1-1/', showNotification: async (title, options) => { notifications.push({ title, options }); } }, clients, skipWaiting: () => {}, addEventListener: (name, handler) => handlers.set(name, handler) } });
  assert.deepEqual([...handlers.keys()], ['install', 'activate', 'push', 'notificationclick']);
  let work;
  handlers.get('push')({ data: { text: () => JSON.stringify({ kind: 'orquivia-reminder', day: '2026-10-16', body: 'Private invoice details must not appear' }) }, waitUntil: value => { work = value; } });await work;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.icon, 'https://example.test/orquivia-presupuestos-facturas/orquivia-icon-192.png');
  assert.equal(notifications[0].options.data.url, 'https://example.test/orquivia-presupuestos-facturas/?view=alerts');
  assert.ok(!JSON.stringify(notifications).includes('Private invoice details'));
  handlers.get('notificationclick')({ notification: { close() {} }, waitUntil: value => { work = value; } });await work;
  assert.deepEqual(navigated, ['https://example.test/orquivia-presupuestos-facturas/?view=alerts']);assert.equal(focused, 1);assert.deepEqual(opened, []);
  clients.matchAll = async () => [{ url: 'https://evil.test/orquivia-presupuestos-facturas/' }];
  handlers.get('notificationclick')({ notification: { close() {} }, waitUntil: value => { work = value; } });await work;
  assert.deepEqual(opened, ['https://example.test/orquivia-presupuestos-facturas/?view=alerts']);
});

test('release rejects overlapping outputs, non-build directories and unexpected private resources before writing', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareRelease({ dist: f.root, legacyDist: f.root }), /independientes/);
  await assert.rejects(prepareRelease({ dist: f.temporary, legacyDist: f.legacy }), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.legacy, 'private.json'), '{"private":"must not publish"}');
  await assert.rejects(prepareRelease({ dist: f.root, legacyDist: f.legacy }), /inesperado/);
  await assert.rejects(fs.stat(f.target), { code: 'ENOENT' });
});
