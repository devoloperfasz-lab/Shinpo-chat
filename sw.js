self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data.json();
  } catch (_) {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.some((c) => c.visibilityState === 'visible' && c.focused)) return;
      return self.registration.showNotification(d.title || 'ShinPo Chat', {
        body: d.body || '',
        tag: d.from || 'chat',
        data: { from: d.from || '' },
      });
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const from = (e.notification.data && e.notification.data.from) || '';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) {
        list[0].postMessage({ open: from });
        return list[0].focus();
      }
      return self.clients.openWindow('/#' + encodeURIComponent(from));
    })
  );
});
