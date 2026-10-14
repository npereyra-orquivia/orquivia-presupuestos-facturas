/* Notifications only. There is deliberately no fetch handler or financial-data cache. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload;
    try {
      const source = event.data?.text() || '';
      if (source.length > 2048) return;
      payload = JSON.parse(source);
    } catch { return; }
    if (payload?.kind !== 'orquivia-reminder' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.day || '')) return;
    // Fixed text protects the lock screen even if a sender supplies extra fields.
    await self.registration.showNotification('Orquívia', {
      body: 'Tienes tareas pendientes. Abre Orquívia para revisarlas.',
      icon: new URL('orquivia-icon-192.png', self.registration.scope).href,
      badge: new URL('orquivia-icon-192.png', self.registration.scope).href,
      tag: `orquivia-${payload.day}`, renotify: false,
      data: { url: new URL('./?view=alerts', self.registration.scope).href },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL('./?view=alerts', self.registration.scope);
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== target.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) continue;
      await client.focus();
      client.postMessage({ type: 'ORQUIVIA_OPEN_ALERTS' });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
