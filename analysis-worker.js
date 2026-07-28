// Web Worker kalapaikka-analyysin koko putkelle: WFS-haku, jasennys, tiilicache
// (IndexedDB) ja ruudukkolaskenta. Karttasaie lahettaa vain rajat ja saa valmiin
// ruudukon, joten isotkin nakymat eivat jumita puhelinta.
import { buildAnalysis, parseContours, parseBands, parseSoundings, wgs84ToTm35 } from './analysis.js';

var SYKE_DEPTH_WFS = 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_el/wfs';
var TRAFICOM_DEPTH_WFS = 'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs';
var TILE_M = 6000;
var TILE_TTL_MS = 30 * 24 * 3600 * 1000;
var MEM_MAX = 60;
var MAX_TILES = 35;
var CACHE_MAX_BYTES = 12 * 1024 * 1024;
var CACHE_MAX_ENTRIES = 150;
var RESULT_TTL_MS = 60 * 60 * 1000;
var RESULT_MAX = 4;
var TILE_CACHE_PREFIX = 't:v3:';
var RESULT_CACHE_PREFIX = 'r:v6:';

var memTiles = new Map();
var fetching = new Map();
var resultCache = new Map();
var dbPromise = null;
var lastTrimAt = 0;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open('kalastusplotteri-depth', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles', { keyPath: 'key' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var req = db.transaction('tiles', 'readonly').objectStore('tiles').get(key);
    req.onsuccess = function () { resolve(req.result || null); };
    req.onerror = function () { reject(req.error); };
  });
}

async function idbPut(record) {
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').put(record);
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function idbDelete(keys) {
  if (!keys.length) return;
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var tx = db.transaction('tiles', 'readwrite');
    keys.forEach(function (key) { tx.objectStore('tiles').delete(key); });
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

async function idbMeta() {
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var out = [];
    var req = db.transaction('tiles', 'readonly').objectStore('tiles').openCursor();
    req.onsuccess = function () {
      var cur = req.result;
      if (!cur) return resolve(out);
      out.push({ key: cur.value.key, updated: cur.value.updated || 0, size: cur.value.size || 0 });
      cur.continue();
    };
    req.onerror = function () { reject(req.error); };
  });
}

async function idbClear() {
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').clear();
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { reject(tx.error); };
  });
}

function tileKeysForBounds(b) {
  var corners = [
    wgs84ToTm35(b.south, b.west), wgs84ToTm35(b.south, b.east),
    wgs84ToTm35(b.north, b.west), wgs84ToTm35(b.north, b.east)
  ];
  var minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
  corners.forEach(function (c) {
    minE = Math.min(minE, c.e); maxE = Math.max(maxE, c.e);
    minN = Math.min(minN, c.n); maxN = Math.max(maxN, c.n);
  });
  var keys = [];
  for (var tx = Math.floor(minE / TILE_M); tx <= Math.floor(maxE / TILE_M); tx++) {
    for (var ty = Math.floor(minN / TILE_M); ty <= Math.floor(maxN / TILE_M); ty++) {
      keys.push(tx + ':' + ty);
    }
  }
  return keys;
}

function putMem(key, tile) {
  memTiles.delete(key);
  memTiles.set(key, tile);
  while (memTiles.size > MEM_MAX) memTiles.delete(memTiles.keys().next().value);
}

async function trimCache() {
  if (Date.now() - lastTrimAt < 60000) return;
  lastTrimAt = Date.now();
  try {
    var meta = await idbMeta();
    var now = Date.now();
    var expired = meta.filter(function (m) { return now - m.updated > TILE_TTL_MS; });
    var live = meta.filter(function (m) { return now - m.updated <= TILE_TTL_MS; });
    live.sort(function (a, b) { return a.updated - b.updated; });
    var bytes = live.reduce(function (sum, m) { return sum + m.size; }, 0);
    var remove = expired.slice();
    while (live.length > CACHE_MAX_ENTRIES || bytes > CACHE_MAX_BYTES) {
      var oldest = live.shift();
      if (!oldest) break;
      bytes -= oldest.size;
      remove.push(oldest);
    }
    await idbDelete(remove.map(function (m) { return m.key; }));
  } catch (e) { /* trimmaus on best effort */ }
}

async function fetchTile(key) {
  var parts = key.split(':');
  var tx = parseInt(parts[0], 10), ty = parseInt(parts[1], 10);
  var bbox = [tx * TILE_M, ty * TILE_M, (tx + 1) * TILE_M, (ty + 1) * TILE_M].join(',') + ',EPSG:3067';
  var tile = {
    t: Date.now(),
    c: [],
    b: [],
    s: [],
    sources: []
  };
  var sykeBase = SYKE_DEPTH_WFS + '?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=' + encodeURIComponent(bbox);
  try {
    var sykeResponses = await Promise.all([
      fetch(sykeBase + '&typeNames=' + encodeURIComponent('inspire_el:EL.ContourLine'), { cache: 'no-store' }),
      fetch(sykeBase + '&typeNames=' + encodeURIComponent('inspire_el:EL.Syvyysalue'), { cache: 'no-store' })
    ]);
    if (!sykeResponses[0].ok || !sykeResponses[1].ok) throw new Error('SYKE WFS ' + sykeResponses[0].status + '/' + sykeResponses[1].status);
    tile.c = tile.c.concat(tagSource(parseContours(await sykeResponses[0].json()), 'syke'));
    tile.b = tile.b.concat(tagSource(parseBands(await sykeResponses[1].json()), 'syke'));
    if (tile.c.length || tile.b.length) tile.sources.push('SYKE');
  } catch (e) {
    console.warn('SYKE-syvyystiilen haku epäonnistui:', key, e);
  }
  var traficomBase = TRAFICOM_DEPTH_WFS + '?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=' + encodeURIComponent(bbox);
  try {
    var traficomResponses = await Promise.all([
      fetch(traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:DepthContour_L'), { cache: 'no-store' }),
      fetch(traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:DepthArea_A'), { cache: 'no-store' }),
      fetch(traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:Sounding_P'), { cache: 'no-store' })
    ]);
    var denied = traficomResponses.filter(function (r) { return r.status === 401 || r.status === 403; });
    if (denied.length) {
      console.info('Traficom: alue vaatii luvan (vapaa kattavuus: talousvyöhyke + Vuoksi + Kymijoki):', key);
    } else if (!traficomResponses[0].ok || !traficomResponses[1].ok || !traficomResponses[2].ok) {
      throw new Error('Traficom WFS ' + traficomResponses[0].status + '/' + traficomResponses[1].status + '/' + traficomResponses[2].status);
    } else {
      var c0 = tile.c.length, b0 = tile.b.length, s0 = tile.s.length;
      tile.c = tile.c.concat(tagSource(parseContours(await traficomResponses[0].json()), 'traficom'));
      tile.b = tile.b.concat(tagSource(parseBands(await traficomResponses[1].json()), 'traficom'));
      tile.s = tile.s.concat(tagSource(parseSoundings(await traficomResponses[2].json()), 'traficom'));
      if (tile.c.length > c0 || tile.b.length > b0 || tile.s.length > s0) tile.sources.push('Traficom');
    }
  } catch (e) {
    console.warn('Traficom-syvyystiilen haku epäonnistui:', key, e);
  }
  return tile;
}

function tagSource(features, source) {
  features.forEach(function (f) { f.source = source; });
  return features;
}

async function getTile(key) {
  var mem = memTiles.get(key);
  if (mem && Date.now() - mem.t < TILE_TTL_MS) return mem;
  if (fetching.has(key)) return fetching.get(key);
  var promise = (async function () {
    try {
      var cached = await idbGet(TILE_CACHE_PREFIX + key);
      if (cached && cached.value && Date.now() - cached.value.t < TILE_TTL_MS) {
        putMem(key, cached.value);
        return cached.value;
      }
    } catch (e) { /* cache-luku epaonnistui, haetaan verkosta */ }
    var tile = await fetchTile(key);
    putMem(key, tile);
    var size = 0;
    try { size = JSON.stringify(tile).length; } catch (e) { size = 100000; }
    idbPut({ key: TILE_CACHE_PREFIX + key, value: tile, updated: Date.now(), size: size }).then(trimCache).catch(function () {});
    return tile;
  })();
  fetching.set(key, promise);
  try {
    return await promise;
  } finally {
    fetching.delete(key);
  }
}

async function ensureTiles(keys, onProgress) {
  var results = [];
  var queue = keys.slice();
  var done = 0;
  async function work() {
    while (queue.length) {
      var key = queue.shift();
      try {
        results.push(await getTile(key));
      } catch (e) {
        console.warn('Syvyystiilen haku epäonnistui:', key, e);
      }
      done++;
      if (onProgress) onProgress(done, keys.length);
    }
  }
  await Promise.all([work(), work(), work()]);
  return results;
}

async function handleBuild(msg) {
  var cacheKey = ['analysis:v6', msg.west, msg.south, msg.east, msg.north, msg.cellLonDeg, msg.windKey,
    msg.speciesKey, Math.round((msg.lightShiftM || 0) * 10),
    Math.round((msg.strat || 0) * 100), Math.round(msg.thermoDepthM || 0),
    msg.includeZanderBreak ? 'zander' : 'base'].join('|');
  var hit = resultCache.get(cacheKey);
  if (hit && Date.now() - hit.t < RESULT_TTL_MS) {
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, hit);
    return { result: hit.result, sources: hit.sources, cached: true };
  }
  try {
    var diskHit = await idbGet(RESULT_CACHE_PREFIX + cacheKey);
    if (diskHit && diskHit.value && diskHit.value.t && Date.now() - diskHit.value.t < RESULT_TTL_MS) {
      var diskValue = diskHit.value;
      resultCache.set(cacheKey, { t: diskValue.t, result: diskValue.result, sources: diskValue.sources || [] });
      while (resultCache.size > RESULT_MAX) resultCache.delete(resultCache.keys().next().value);
      return { result: diskValue.result, sources: diskValue.sources || [], cached: true };
    }
  } catch (e) { /* persistent analysis cache miss */ }
  var keys = tileKeysForBounds(msg);
  if (keys.length > MAX_TILES) return { result: null, reason: 'toowide' };
  var tiles = await ensureTiles(keys, function (done, total) {
    self.postMessage({ id: msg.id, progress: { done: done, total: total } });
  });
  var contourById = new Map();
  var bandById = new Map();
  var soundingById = new Map();
  var sourceSet = {};
  tiles.forEach(function (tile) {
    (tile.c || []).forEach(function (c) { contourById.set((c.source || '') + ':' + c.id, c); });
    (tile.b || []).forEach(function (b) { bandById.set((b.source || '') + ':' + b.id, b); });
    (tile.s || []).forEach(function (s) { soundingById.set((s.source || '') + ':' + s.id, s); });
    (tile.sources || []).forEach(function (src) { sourceSet[src] = true; });
  });
  var result = buildAnalysis({
    contours: Array.from(contourById.values()),
    bands: Array.from(bandById.values()),
    soundings: Array.from(soundingById.values()),
    wind: msg.wind,
    traits: msg.traits,
    thermoDepthM: msg.thermoDepthM,
    lightShiftM: msg.lightShiftM,
    strat: msg.strat,
    west: msg.west,
    south: msg.south,
    east: msg.east,
    north: msg.north,
    cellLonDeg: msg.cellLonDeg,
    cellLatDeg: msg.cellLatDeg,
    includeZanderBreak: !!msg.includeZanderBreak
  });
  var sources = Object.keys(sourceSet);
  resultCache.set(cacheKey, { t: Date.now(), result: result, sources: sources });
  while (resultCache.size > RESULT_MAX) resultCache.delete(resultCache.keys().next().value);
  try {
    var rec = { t: Date.now(), result: result, sources: sources };
    idbPut({
      key: RESULT_CACHE_PREFIX + cacheKey,
      value: rec,
      updated: rec.t,
      size: JSON.stringify({ sources: sources, nx: result && result.nx, ny: result && result.ny }).length +
        ((result && result.nx && result.ny) ? result.nx * result.ny * (msg.includeZanderBreak ? 40 : 18) : 0)
    }).then(trimCache).catch(function () {});
  } catch (e) { /* persistent analysis cache write is best effort */ }
  return { result: result, sources: sources };
}

async function handleStatus() {
  var meta = await idbMeta();
  return {
    count: meta.length,
    bytes: meta.reduce(function (sum, m) { return sum + m.size; }, 0),
    maxEntries: CACHE_MAX_ENTRIES,
    maxBytes: CACHE_MAX_BYTES
  };
}

async function handleClear() {
  await idbClear();
  memTiles.clear();
  resultCache.clear();
  return { ok: true };
}

self.onmessage = async function (e) {
  var msg = e.data || {};
  try {
    var payload;
    if (msg.type === 'build') payload = await handleBuild(msg);
    else if (msg.type === 'status') payload = await handleStatus();
    else if (msg.type === 'clear') payload = await handleClear();
    else payload = { error: 'unknown message type' };
    self.postMessage(Object.assign({ id: msg.id }, payload));
  } catch (err) {
    self.postMessage({ id: msg.id, error: String(err && err.message || err) });
  }
};
