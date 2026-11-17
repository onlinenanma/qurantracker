/* quranlearning.app - service worker */
const VERSION = 'v1.0.8';
const CACHE_NAME = 'quranlearning.app-' + VERSION;
const CACHE_PREFIX = 'quranlearning.app-';
const AUDIO_CACHE = 'hifz-audio-v1';       // used by the page for verse audio - must NOT be deleted
const OFFLINE_CACHE = 'pwabuilder-offline-page';
const API_CACHE = 'hifz-api-v1';           // Quran text / translations (kept across app versions, size-limited)
const API_CACHE_MAX_ENTRIES = 600;
// Hosts that supply verses and translations. Audio hosts are deliberately NOT listed: the page caches audio itself.
const API_HOSTS = ['api.alquran.cloud', 'quranenc.com'];

const offlineFallbackPage = 'index.html';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
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

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then(keys => Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )),
      self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve()
    ]).then(() => self.clients.claim())
  );
});

// --- PUSH NOTIFICATIONS SUPPORT ---
self.addEventListener('push', (event) => {
  let data = { title: 'Quran Learning', body: 'New notification received.', icon: './icon-192.png' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon || './icon-192.png',
      badge: './icon-192.png',
      data: data.url || './'
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === event.notification.data && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data);
      }
    })
  );
});

// --- PERIODIC BACKGROUND SYNC SUPPORT ---
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'update-content') {
    event.waitUntil(
      // Add your background data fetch / cache refresh logic here
      Promise.resolve()
    );
  }
});

// --- BACKGROUND SYNC SUPPORT ---
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-offline-data') {
    event.waitUntil(
      // Add your offline data queue synchronization logic here
      Promise.resolve()
    );
  }
});

// --- helpers ---
async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - maxEntries; i++) await cache.delete(keys[i]);   // oldest first
}

// Verses / translations: always try the network first (fresh data), fall back to the last good copy when offline.
async function apiNetworkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      cache.put(req, res.clone()).then(() => trimCache(cache, API_CACHE_MAX_ENTRIES)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (API_HOSTS.includes(url.hostname)) {
    event.respondWith(apiNetworkFirst(req));
    return;
  }

  // Everything else on other origins (audio, fonts, CDNs...) is left to the browser
  if (url.origin !== self.location.origin) return;

  // Media range requests (audio/video seeking) cannot be cached as whole files
  if (req.headers.has('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preloadResp = await event.preloadResponse;
        const networkResp = preloadResp || await fetch(req);
        if (networkResp && networkResp.ok) {
          // Cache each page under its OWN address (the home page also as ./index.html)
          const isHome = url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/');
          const c1 = networkResp.clone();
          const c2 = networkResp.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(c => {
            const jobs = [c.put(req, c1)];
            if (isHome) jobs.push(c.put('./index.html', c2));
            return Promise.all(jobs);
          }).catch(() => {}));
        }
        return networkResp;
      } catch (error) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        const offline = await caches.open(OFFLINE_CACHE).then(c => c.match(offlineFallbackPage));
        return offline || await caches.match('./index.html');
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
