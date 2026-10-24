// public/sw.js — offline app shell + notification clicks
// Bump CACHE_NAME whenever the shell files change.

const CACHE_NAME = 'sc-alerts-v3';
const SHELL_ASSETS = [
  '/',
  '/style.css',
  '/app.js',
  '/logic.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheCopy(request, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only our own static files; live data (/api/) and other sites go straight to the network
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // Page: network first so a new deploy shows up immediately; cached copy when offline
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => cacheCopy('/', response))
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Other files: serve cached copy instantly, refresh it in the background
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((response) => cacheCopy(request, response)).catch(() => cached);
      return cached || network;
    })
  );
});

// Notification click: bring the app to the front (or open it)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })()
  );
});
