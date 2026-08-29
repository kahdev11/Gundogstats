const CACHE = 'kvarter-v4';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for everything: always try to get the freshest version of the
// app (and CDN/map/elevation data). Only fall back to the cached copy when
// there's genuinely no network, so the app still works offline — but an
// update you've deployed is never hidden behind a stale cache.
//
// For our own files, `cache: 'no-store'` also tells the BROWSER's own HTTP
// cache to skip itself entirely — "network-first" in this handler doesn't
// help if the browser silently hands back a cached response instead of
// actually hitting the network. This still doesn't control GitHub Pages'
// own CDN, which can take a short while to pick up a new deploy — but it
// removes every delay this app could otherwise add on top of that.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const isOwnOrigin = new URL(event.request.url).origin === self.location.origin;
  event.respondWith(
    fetch(event.request, isOwnOrigin ? { cache: 'no-store' } : {})
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
