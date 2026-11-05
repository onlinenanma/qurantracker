/* quranlearning.app - service worker
 * IMPORTANT: bump VERSION on every release. The browser only detects an update when
 * this file's bytes change; that triggers the in-app "Update now" banner.
 */
const VERSION = 'v1.0.1';
const CACHE_NAME = 'quranlearning.app-' + VERSION;
const CACHE_PREFIX = 'quranlearning.app-';
const AUDIO_CACHE = 'hifz-audio-v1';   // used by the page for verse audio - must NOT be deleted

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // allSettled: one missing file will not break the whole install
      Promise.allSettled(ASSETS_TO_CACHE.map(url => cache.add(url)))
    )
  );
  // No automatic skipWaiting(): the new version waits until the user taps "Update now".
});

// The page sends this when the user taps "Update now"
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          // delete only OLD app-shell caches; keep the current one and the audio cache
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Audio, Quran APIs, page images, CDN scripts: leave to the page / network
  if (url.origin !== self.location.origin) return;

  // Opening the app / page: network first (so new releases show up), cache when offline
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put('./index.html', copy));
          return res;
        })
        .catch(() =>
          caches.match('./index.html').then(r => r || caches.match('./'))
        )
    );
    return;
  }

  // Other local files (manifest, icons): cache first, refresh in the background
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
