const CACHE_NAME = 'kalastusplotteri-tile-cache-v2';
const OLD_CACHE_PREFIX = 'kalastusplotteri-tile-cache-';
const DB_NAME = 'kalastusplotteri-cache-meta';
const DB_VERSION = 1;
const META_STORE = 'tiles';

let config = { enabled: false, maxTiles: 600, ttlDays: 7 };

const TILE_HOSTS = new Set([
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  'avoin-karttakuva.maanmittauslaitos.fi',
  'julkinen.traficom.fi',
  'paikkatiedot.ymparisto.fi'
]);

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((name) => name.startsWith(OLD_CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  const message = event.data || {};
  event.waitUntil(handleMessage(message).then(
    (result) => { if (port) port.postMessage(result || { ok: true }); },
    (error) => { if (port) port.postMessage({ ok: false, error: String(error && error.message || error) }); }
  ));
});

self.addEventListener('fetch', (event) => {
  if (!config.enabled || !isTileRequest(event.request)) return;
  event.respondWith(cacheTileRequest(event.request));
});

async function handleMessage(message) {
  if (message.type === 'SET_TILE_CACHE_CONFIG') {
    const next = message.config || {};
    config = {
      enabled: !!next.enabled,
      maxTiles: clamp(parseInt(next.maxTiles, 10) || 600, 100, 5000),
      ttlDays: clamp(parseInt(next.ttlDays, 10) || 7, 1, 30)
    };
    await pruneCache();
    return { ok: true, config };
  }
  if (message.type === 'GET_TILE_CACHE_STATUS') {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    return { ok: true, count: keys.length, config };
  }
  if (message.type === 'CLEAR_TILE_CACHE') {
    await caches.delete(CACHE_NAME);
    await clearMeta();
    return { ok: true, count: 0 };
  }
  return { ok: true };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isTileRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.destination && request.destination !== 'image') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return false;
  }
  if (!TILE_HOSTS.has(url.hostname)) return false;
  if (url.searchParams.get('api-key') === 'YOUR_API_KEY') return false;
  if (url.hostname === 'paikkatiedot.ymparisto.fi' && !url.pathname.includes('/wms')) return false;
  if (url.hostname === 'julkinen.traficom.fi' && !url.pathname.includes('/rasteripalvelu')) return false;
  return true;
}

async function cacheTileRequest(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) {
    await touchMeta(request.url);
    return cached;
  }

  const response = await fetch(request);
  if (response && (response.ok || response.type === 'opaque')) {
    await cache.put(request, response.clone());
    await putMeta(request.url);
    pruneCache();
  }
  return response;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'url' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, mode);
    const store = tx.objectStore(META_STORE);
    const result = callback(store);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function putMeta(url) {
  const now = Date.now();
  await withStore('readwrite', (store) => store.put({ url, created: now, last: now }));
}

async function touchMeta(url) {
  const now = Date.now();
  await withStore('readwrite', (store) => {
    const req = store.get(url);
    req.onsuccess = () => {
      const value = req.result || { url, created: now };
      value.last = now;
      store.put(value);
    };
  });
}

async function getAllMeta() {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const store = tx.objectStore(META_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteMeta(urls) {
  if (!urls.length) return;
  await withStore('readwrite', (store) => {
    urls.forEach((url) => store.delete(url));
  });
}

async function clearMeta() {
  await withStore('readwrite', (store) => store.clear());
}

async function pruneCache() {
  const cache = await caches.open(CACHE_NAME);
  const now = Date.now();
  const ttlMs = config.ttlDays * 24 * 60 * 60 * 1000;
  const meta = await getAllMeta();
  const expired = meta.filter((item) => now - (item.last || item.created || 0) > ttlMs);
  const remaining = meta.filter((item) => !expired.includes(item));
  remaining.sort((a, b) => (b.last || b.created || 0) - (a.last || a.created || 0));
  const overflow = remaining.slice(config.maxTiles);
  const remove = expired.concat(overflow);
  await Promise.all(remove.map((item) => cache.delete(item.url)));
  await deleteMeta(remove.map((item) => item.url));
}
