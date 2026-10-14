import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
function worker(windows = []) {
  const listeners = {};
  const notifications = [], opened = [];
  const self = {
    addEventListener(type, listener) { listeners[type] = listener; },
    skipWaiting() {},
    registration: {
      scope: 'https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/',
      async showNotification(title, options) { notifications.push({ title, ...options }); },
    },
    clients: { async claim() {}, async matchAll() { return windows; }, async openWindow(url) { opened.push(url); } },
  };
  runInNewContext(source, { self, URL });
  return { listeners, notifications, opened };
}

test('service worker caches no request or account data and uses fixed private notification text', async () => {
  const { listeners, notifications } = worker();
  assert.equal(Object.hasOwn(listeners, 'fetch'), false);
  let pending;
  listeners.push({
    data: { text: () => JSON.stringify({ kind: 'orquivia-reminder', day: '2026-10-14', count: 2, body: 'Client Secret: €25,000', url: 'https://evil.example/' }) },
    waitUntil(value) { pending = value; },
  });
  await pending;
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Orquívia');
  assert.equal(notifications[0].body, 'Tienes tareas pendientes. Abre Orquívia para revisarlas.');
  assert.equal(notifications[0].data.url, 'https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/?view=alerts');
  assert.equal(notifications[0].renotify, false);
  assert.equal(notifications[0].tag, 'orquivia-2026-10-14');
});

test('malformed push data is ignored without publishing attacker-controlled content', async () => {
  const { listeners, notifications } = worker();
  for (const text of ['invalid JSON', JSON.stringify({ kind: 'unrelated', day: '2026-10-14' }), 'x'.repeat(3000)]) {
    let pending;
    listeners.push({ data: { text: () => text }, waitUntil(value) { pending = value; } });
    await pending;
  }
  assert.equal(notifications.length, 0);
});

test('notification click never navigates to payload URL or another GitHub Pages application', async () => {
  let unrelatedFocused = false;
  const { listeners, opened } = worker([{ url: 'https://npereyra-orquivia.github.io/another-app/', async focus() { unrelatedFocused = true; } }]);
  let pending, closed = false;
  listeners.notificationclick({ notification: { data: { url: 'https://evil.example/' }, close() { closed = true; } }, waitUntil(value) { pending = value; } });
  await pending;
  assert.equal(closed, true);
  assert.equal(unrelatedFocused, false);
  assert.deepEqual(opened, ['https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/?view=alerts']);
});

test('notification click focuses an existing app window and requests authenticated alert view', async () => {
  let focused = false, message;
  const { listeners, opened } = worker([{
    url: 'https://npereyra-orquivia.github.io/orquivia-presupuestos-facturas/',
    async focus() { focused = true; }, postMessage(value) { message = value; },
  }]);
  let pending;
  listeners.notificationclick({ notification: { close() {} }, waitUntil(value) { pending = value; } });
  await pending;
  assert.equal(focused, true);
  assert.equal(message.type, 'ORQUIVIA_OPEN_ALERTS');
  assert.deepEqual(opened, []);
});
