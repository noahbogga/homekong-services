const CACHE_VERSION = 'hk-remote-v1';
const ASSETS = [
  '/guacamole.min.js',
  '/novnc-keyboard.js'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache the HTML pages or API calls — always network-first
  if (e.request.mode === 'navigate' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/tunnel/')) {
    e.respondWith(fetch(e.request));
    return;
  }
  // Static JS assets: cache-first
  if (ASSETS.includes(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request))
    );
    return;
  }
  e.respondWith(fetch(e.request));
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
