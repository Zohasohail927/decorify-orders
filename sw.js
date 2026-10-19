// Decorify Orders service worker (v7).
// Caches ONLY the app's own files so it opens quickly and offline.
// Customer data from Supabase is never stored in the browser cache.
const CACHE = 'decorify-orders-v7';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './config.js', './insights-core.js', './supabase-2.45.4.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES).catch(() => {})));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Network first for the app's own files, falling back to the cache when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (url.origin !== self.location.origin && !fonts) return;   // Supabase (customer data): straight to the network, never cached
  if (/^\/(rest|auth|realtime|storage)\//.test(url.pathname)) return;   // data APIs are never cached, even on the same address
  e.respondWith(
    fetch(req).then(r => {
      if ((r.ok && r.type === 'basic') || (fonts && (r.ok || r.type === 'opaque'))) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return r;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
