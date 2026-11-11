/* ============================================================
   Service Worker
   策略：
     - 页面（index.html）：永远走网络。服务器有 ETag，没变化只回 304，
       这样任何人打开都是最新版，不会卡在旧页面上。
     - 图标 / 贴纸：缓存优先，省流量。
     - 接口 / WebSocket：完全不碰。
   ============================================================ */

const CACHE = 'im-shell-v8';
const STATIC = [
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 接口 / WebSocket：直接走网络，不缓存
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // 页面导航：完全交给网络（ETag 会自动处理成 304）
  if (req.mode === 'navigate') return;

  // 图标 / manifest / 贴纸：缓存优先
  if (url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/stickers/') ||
      url.pathname === '/manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit))
    );
  }
});

/* ---------------- 推送（仅浏览器，App 内走原生） ---------------- */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || '新消息';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: data.convId || 'im-message',
    renotify: true,
    silent: false,
    vibrate: [60, 40, 60],
    data: { convId: data.convId || '', ts: data.ts || Date.now() }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const convId = (event.notification.data && event.notification.data.convId) || '';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.focus();
          if (convId && c.postMessage) c.postMessage({ type: 'open-conv', convId });
          return;
        }
      }
      return self.clients.openWindow('/');
    })
  );
});
