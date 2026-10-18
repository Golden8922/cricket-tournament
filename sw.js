const CACHE_NAME = 'college-cricket-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/engine.js',
  './js/teams.js',
  './js/db.js',
  './js/seed.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept writes or the live-data API: they must always hit the network
  if (event.request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }

  // For Firebase or external APIs, network first with fallback
  if (url.origin !== location.origin) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Own pages, scripts and styles: network first, so a new deployment shows up on the very
  // first visit. The saved copy is used only when offline or when the network takes over 3 s.
  event.respondWith((async () => {
    const cached = await caches.match(event.request);

    const network = fetch(event.request, { cache: 'no-cache' }).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
      }
      return networkResponse;
    }).catch(() => null);

    if (!cached) {
      const fresh = await network;
      if (fresh) return fresh;
      if (event.request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return Response.error();
    }

    const winner = await Promise.race([
      network,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000))
    ]);
    return winner || cached;
  })());
});
