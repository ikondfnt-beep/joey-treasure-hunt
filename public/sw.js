const CACHE_NAME = 'clue-hunt-v1';
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
    })
  );
});

// Serve cached content when offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});