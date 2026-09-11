// Minimal service worker: makes Conduit installable and gives the app shell an
// offline fallback. Deliberately does NOT cache Jellyfin API or audio/artwork
// (those are large, private and change), only the built static shell.
const SHELL = 'conduit-shell-v1';
self.addEventListener('install', (e) => {
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept the Jellyfin proxy or cross-origin requests.
  if (url.pathname.startsWith('/jf/') || url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  // App shell: network-first, fall back to cache so a reload works offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m || caches.match('/')))
  );
});
