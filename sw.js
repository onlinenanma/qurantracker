/* quranlearning.app - service worker */
const VERSION = 'v1.0.2';
const CACHE_NAME = 'quranlearning.app-' + VERSION;
const CACHE_PREFIX = 'quranlearning.app-';
const AUDIO_CACHE = 'hifz-audio-v1';   // used by the page for verse audio - must NOT be deleted
const OFFLINE_CACHE = "pwabuilder-offline-page";

importScripts('https://storage.googleapis.com/workbox-cdn/releases/5.1.2/workbox-sw.js');

const offlineFallbackPage = "index.html";

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then(cache =>
        Promise.allSettled(ASSETS_TO_CACHE.map(url => cache.add(url)))
      ),
      caches.open(OFFLINE_CACHE).then(cache => cache.add(offlineFallbackPage))
    ])
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME && key !== OFFLINE_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// PWABuilder Workbox Navigation Preload & Routing integration
if (workbox.navigationPreload.isSupported()) {
  workbox.navigationPreload.enable();
}

workbox.routing.registerRoute(
  new RegExp('/*'),
  new workbox.strategies.StaleWhileRevalidate({
    cacheName: OFFLINE_CACHE
  })
);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preloadResp = await event.preloadResponse;
        if (preloadResp) {
          return preloadResp;
        }

        const networkResp = await fetch(req);
        const copy = networkResp.clone();
        caches.open(CACHE_NAME).then(c => c.put('./index.html', copy));
        return networkResp;
      } catch (error) {
        const cache = await caches.open(OFFLINE_CACHE);
        const cachedResp = await cache.match(offlineFallbackPage) || await caches.match('./index.html');
        return cachedResp;
      }
    })());
    return;
  }

  // Other local files: cache first, refresh in the background
  event.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
