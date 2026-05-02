const CACHE = 'lhc-worship-shell-v1';
const REQUIRED = ['/index.html', '/manifest.json'];
const OPTIONAL = ['/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async c => {
      await c.addAll(REQUIRED);
      await Promise.allSettled(OPTIONAL.map(u => c.add(u).catch(() => {})));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Let all Google / GAS requests pass through untouched
  if (url.hostname.includes('google') || url.hostname.includes('gstatic')) return;
  // Cache-first for shell assets, fallback to index.html for navigation
  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) return hit;
      return fetch(e.request).catch(() => caches.match('/index.html'));
    })
  );
});
