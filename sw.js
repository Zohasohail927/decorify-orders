// Decorify Orders service worker.
// Caches ONLY the app's own files so it opens quickly and offline.
// Customer data from Supabase is never stored in the browser cache.
// CACHE and the versioned file names are written by build/assemble.py on every build, so a new
// release never mixes with files from an older one.
const CACHE = 'decorify-orders-eab113462a';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './config.js', './insights-core.js?v=7d2ee29368', './supabase-2.45.4.js', './inter-var.woff2'];
self.addEventListener('install', e => {
  // all-or-nothing: if any file fails, this version doesn't install and the working one stays
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();   // takes over quietly; pages are never reloaded under the user (drafts stay safe)
});
// Network first for the app's own files, falling back to this version's cache when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                       // Supabase (customer data): straight to the network, never cached
  if (/^\/(rest|auth|realtime|storage)\//.test(url.pathname)) return;    // data APIs are never cached, even on the same address
  e.respondWith(
    fetch(req).then(r => {
      if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return r;
    }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
  );
});
