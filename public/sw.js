const CACHE_NAME = 'clue-hunt-v2';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html', // Update these paths to match your main game/clue UI files
  '/style.css',
  '/manifest.json'
];

// Install the Service Worker and cache the core layout
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Drop any caches from older deploys so devices don't get stuck on stale UI
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Network-first for page navigations (so updates show up immediately when online),
// falling back to the cached shell when offline. Cache-first for everything else.
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
