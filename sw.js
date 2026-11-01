/* Qur'an Hifz Tracker - service worker
 *
 * Put this file in the SAME folder as the tracker page (e.g. next to hifd-index-2.html / index.html).
 * It only works on https:// (GitHub Pages is fine) or http://localhost.
 *
 * What it does
 *   1. Offline app      the page, Tailwind, and the Google font files are kept, so the tracker opens offline.
 *   2. Saved answers    Quran text / translation / page / audio-link answers from api.alquran.cloud are kept
 *                       (the Quran text never changes), so opened surahs work offline and cost no API request.
 *   3. Saved audio      every verse recitation that is played is kept (cache-first) and also works offline.
 *                       It uses the same cache name as the page ('hifz-audio-v1'), so both share the files.
 *   4. Saved images     Mus'haf page images are kept when their server allows it.
 *   5. Polite gate      EVERY request that really goes to the internet passes one gate, shared by all open tabs:
 *                         - minimum gap between requests to the same host (everyayah.com: 1 s, Quran API: 0.11 s)
 *                         - after HTTP 429 / 503 (and 403 on everyayah.com) the host is left alone for the time the
 *                           server asks (Retry-After, default 60 s, at most 5 min) - even across reloads
 *                       Requests answered from the saved copies never touch the network.
 *
 * Order for audio (decided by the page, executed here): saved copy -> Al Quran Cloud links/CDN ->
 * the same reciter on everyayah.com as the last resort.
 */
'use strict';

const CFG = Object.assign({
  VERSION: 'v1',
  HOST_GAP_MS: { 'everyayah.com': 1000, 'api.alquran.cloud': 110 },
  DEFAULT_COOLDOWN_MS: { 'api.alquran.cloud': 5000, default: 60000 },
  MAX_COOLDOWN_MS: 300000,
  NAV_TIMEOUT_MS: 4000,                       // open the saved page if the network needs longer than this
  API_TTL_MS: 30 * 24 * 3600 * 1000,
  EDITION_TTL_MS: 7 * 24 * 3600 * 1000,
  MAX_AUDIO: 400,
  MAX_IMAGES: 80
}, self.HIFZ_SW_CONFIG || {});

const STATIC_CACHE = `hifz-static-${CFG.VERSION}`;
const API_CACHE = `hifz-api-${CFG.VERSION}`;
const IMAGE_CACHE = `hifz-images-${CFG.VERSION}`;
const META_CACHE = `hifz-meta-${CFG.VERSION}`;
const AUDIO_CACHE = 'hifz-audio-v1';          // must match AUDIO_CACHE_NAME in the page
const ALL_CACHES = [STATIC_CACHE, API_CACHE, IMAGE_CACHE, META_CACHE, AUDIO_CACHE];

const SCOPE = self.registration.scope;
const AUDIO_HOSTS = new Set(['everyayah.com', 'cdn.islamic.network', 'cdn.islamic.ru']);
const IMAGE_HOSTS = new Set(['android.quran.com', 'mushaf.quran.com', 'api.islamic.app', 'cdn.islamic.network']);
const STATIC_HOSTS = new Set(['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com']);

// Things the page needs to start offline (must match the <script>/<link> tags of the page exactly).
const PRECACHE = [
  SCOPE,
  'https://cdn.tailwindcss.com/',
  'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Inter:wght@300;400;500;600;700&display=swap'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hostOf = url => new URL(url).hostname;
const isOffline = () => self.navigator && self.navigator.onLine === false;

// ------------------------------------------------------------------ install / activate
self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('hifz-') && !ALL_CACHES.includes(name)) await caches.delete(name);   // old versions
    }
    await self.clients.claim();
  })());
});

async function precache() {
  const cache = await caches.open(STATIC_CACHE);
  await Promise.allSettled(PRECACHE.map(async url => {
    const sameOrigin = new URL(url).origin === self.location.origin;
    const res = await fetch(sameOrigin ? new Request(url) : new Request(url, { mode: 'no-cors' }));
    if (res.ok || (!sameOrigin && res.type === 'opaque')) await cache.put(url, res);
  }));
}

// The page tells us its own address after the first visit (the very first load is not intercepted yet).
self.addEventListener('message', event => {
  const data = event.data || {};
  if (data.type !== 'CACHE_URLS' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    for (const u of data.urls) {
      try {
        const url = new URL(u, SCOPE);
        if (url.origin !== self.location.origin) continue;     // only our own pages
        const res = await fetch(url.href, { cache: 'reload' });
        if (res.ok) await cache.put(url.href, res);
      } catch (e) { /* offline: nothing to do */ }
    }
  })());
});

// ------------------------------------------------------------------ routing
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  let handler = null;
  if (request.mode === 'navigate') handler = () => handleNavigation(request);
  else if (url.hostname === 'api.alquran.cloud') handler = () => handleApi(request);
  else if (AUDIO_HOSTS.has(url.hostname) && /\.mp3$/i.test(url.pathname)) handler = () => handleAudio(request);
  else if (request.destination === 'image' && IMAGE_HOSTS.has(url.hostname)) handler = () => handleImage(request);
  else if (STATIC_HOSTS.has(url.hostname) || url.origin === self.location.origin) handler = () => staleWhileRevalidate(event, request);

  if (handler) event.respondWith(handler());           // anything else goes to the network untouched
});

// ------------------------------------------------------------------ the polite gate
const lastSlot = new Map();                            // host -> time of the last reserved request slot
const corsBlocked = new Set();                         // hosts that do not allow reading their files via fetch()
const putCounter = new Map();

const metaRequest = () => new Request(SCOPE + '__hifz-meta.json');
async function readMeta() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(metaRequest());
    return res ? await res.json() : {};
  } catch (e) { return {}; }
}
async function writeMeta(meta) {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(metaRequest(), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) { /* ignore */ }
}

const cooldownStatuses = host => host === 'everyayah.com' ? [429, 403, 503] : [429, 503];

function cooldownResponse(until) {
  const secs = Math.max(1, Math.ceil((until - Date.now()) / 1000));
  return new Response('', { status: 429, statusText: 'Cooling down', headers: { 'Retry-After': String(secs) } });
}

// Every real network request goes through here.
async function politeFetch(request) {
  const host = hostOf(request.url);
  const meta = await readMeta();
  const until = (meta.cooldowns && meta.cooldowns[host]) || 0;
  if (Date.now() < until) return cooldownResponse(until);       // still resting: do not bother the server

  const gap = CFG.HOST_GAP_MS[host] || 0;
  if (gap) {
    const now = Date.now();
    const slot = Math.max(now, (lastSlot.get(host) || 0) + gap);
    lastSlot.set(host, slot);
    if (slot > now) await sleep(slot - now);
  }

  const res = await fetch(request);
  if (cooldownStatuses(host).includes(res.status)) {
    const asked = parseInt(res.headers.get('Retry-After'));
    const wait = Math.min((asked > 0 ? asked * 1000 : (CFG.DEFAULT_COOLDOWN_MS[host] || CFG.DEFAULT_COOLDOWN_MS.default)), CFG.MAX_COOLDOWN_MS);
    const fresh = await readMeta();
    fresh.cooldowns = Object.assign({}, fresh.cooldowns, { [host]: Date.now() + wait });
    await writeMeta(fresh);
  }
  return res;
}

async function trim(cache, max) {
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);   // oldest first
  } catch (e) { /* ignore */ }
}
function remember(cache, name, request, response, max) {
  const n = (putCounter.get(name) || 0) + 1;
  putCounter.set(name, n);
  return cache.put(request, response).then(() => { if (n % 20 === 0) return trim(cache, max); });
}

// ------------------------------------------------------------------ pages
async function handleNavigation(request) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await Promise.race([fetch(request), sleep(CFG.NAV_TIMEOUT_MS).then(() => { throw new Error('slow'); })]);
    if (res && res.ok) cache.put(request.url, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(request.url, { ignoreSearch: true }))
      || (await cache.match(SCOPE))
      || new Response('Offline - open the tracker once while online so it can be saved.',
                      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request).then(res => {
    if (res && (res.ok || res.type === 'opaque')) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  if (hit) { event.waitUntil(refresh); return hit; }
  return (await refresh) || Response.error();
}

// ------------------------------------------------------------------ Quran API (text never changes)
async function handleApi(request) {
  const cache = await caches.open(API_CACHE);
  const hit = await cache.match(request.url);
  let stale = null;
  if (hit) {
    const ttl = /\/v1\/edition/.test(request.url) ? CFG.EDITION_TTL_MS : CFG.API_TTL_MS;
    const age = Date.now() - Number(hit.headers.get('x-hifz-cached-at') || 0);
    if (age < ttl) return hit;
    stale = hit;                                      // too old: refresh it, but keep it as the safety net
  }
  try {
    const res = await politeFetch(request);
    if (res.ok) {
      const headers = new Headers(res.headers);
      headers.set('x-hifz-cached-at', String(Date.now()));
      const copy = new Response(await res.clone().blob(), { status: res.status, statusText: res.statusText, headers });
      await remember(cache, 'api', request.url, copy, 2000);
      return res;
    }
    if (stale && (res.status === 429 || res.status >= 500)) return stale;
    return res;
  } catch (e) {
    if (stale) return stale;
    throw e;
  }
}

// ------------------------------------------------------------------ audio (cache first, then politely from the network)
// Media elements ask for byte ranges; answer them from the saved full file.
async function withRange(request, response) {
  const range = request.headers && request.headers.get('range');
  if (!range || response.status !== 200 || response.type === 'opaque') return response;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return response;
  const buf = await response.clone().arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - parseInt(m[2])); end = size - 1; }          // bytes=-N
  else { start = parseInt(m[1]); end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2]), size - 1); }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}

async function handleAudio(request) {
  const cache = await caches.open(AUDIO_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return withRange(request, hit);                      // saved copy: no network at all

  const host = hostOf(request.url);
  if (!corsBlocked.has(host)) {
    try {
      const res = await politeFetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
      if (res.status === 200) {
        await remember(cache, 'audio', request.url, res.clone(), CFG.MAX_AUDIO);
        return withRange(request, res);
      }
      return res;                                               // 404 / 429 ...: the page decides what to do
    } catch (e) {
      if (isOffline()) return Response.error();
      corsBlocked.add(host);                                    // server does not allow fetch(): cannot be saved
      if (request.mode === 'cors') return Response.error();     // the page falls back to streaming by itself
    }
  }
  return politeFetch(request);                                  // media element on such a host: play it, polite but unsaved
}

// ------------------------------------------------------------------ Mus'haf page images
async function handleImage(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;

  const host = hostOf(request.url);
  if (!corsBlocked.has(host)) {
    try {
      const res = await politeFetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
      if (res.ok) await remember(cache, 'image', request.url, res.clone(), CFG.MAX_IMAGES);
      return res;
    } catch (e) {
      if (isOffline()) return Response.error();
      corsBlocked.add(host);
      if (request.mode === 'cors') return Response.error();
    }
  }
  return politeFetch(request);                                  // shown, but not saved (server forbids reading it)
}
