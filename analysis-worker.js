// Web Worker kalapaikka-analyysin koko putkelle: WFS-haku, jasennys, tiilicache
// (IndexedDB) ja ruudukkolaskenta. Karttasaie lahettaa vain rajat ja saa valmiin
// ruudukon, joten isotkin nakymat eivat jumita puhelinta.
import { buildAnalysis, parseContours, parseBands, parseSoundings, wgs84ToTm35 } from './analysis.js?v=20260729-empty-cache-guard-1';

var SYKE_DEPTH_WFS = 'https://paikkatiedot.ymparisto.fi/geoserver/inspire_el/wfs';
var TRAFICOM_DEPTH_WFS = 'https://julkinen.traficom.fi/inspirepalvelu/rajoitettu/wfs';
var TILE_M = 6000;
var TILE_TTL_MS = 30 * 24 * 3600 * 1000;
var PARTIAL_TILE_TTL_MS = 24 * 3600 * 1000;
var FAILED_TILE_TTL_MS = 30 * 1000;
var MEM_MAX = 60;
var MAX_TILES = 35;
var TILE_CACHE_MAX_BYTES = 80 * 1024 * 1024;
var TILE_CACHE_MAX_ENTRIES = 220;
var RESULT_CACHE_MAX_BYTES = 24 * 1024 * 1024;
var RESULT_CACHE_MAX_ENTRIES = 8;
var RESULT_TTL_MS = 60 * 60 * 1000;
var RESULT_MAX = 4;
var DEPTH_FETCH_TIMEOUT_MS = 12000;
var DEPTH_TILE_NETWORK_TIMEOUT_MS = 18000;
var DEPTH_TILES_SOFT_DEADLINE_MS = 2500;
var IDB_READ_TIMEOUT_MS = 2500;
var TILE_CACHE_PREFIX = 't:v4:';
var RESULT_CACHE_PREFIX = 'r:v8:';

var memTiles = new Map();
var fetching = new Map();
var resultCache = new Map();
var dbPromise = null;
var lastTrimAt = {};

function addStatsEvent(stats, event, data) {
  if (!stats) return;
  var entry = Object.assign({ event: event, t: Date.now() }, data || {});
  if (!stats.events) stats.events = [];
  if (!stats.errors) stats.errors = [];
  stats.events.push(entry);
  if (event.indexOf('error') !== -1 || entry.error) stats.errors.push(entry);
  if (stats.events.length > 80) stats.events = stats.events.slice(stats.events.length - 80);
  if (stats.errors.length > 40) stats.errors = stats.errors.slice(stats.errors.length - 40);
}

function withTimeout(promise, ms, label) {
  var timer;
  var timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error(label || 'timeout')); }, ms);
  });
  return Promise.race([promise, timeout]).finally(function () {
    if (timer) clearTimeout(timer);
  });
}

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

async function idbMeta(prefix) {
  var db = await openDb();
  return await new Promise(function (resolve, reject) {
    var out = [];
    var req = db.transaction('tiles', 'readonly').objectStore('tiles').openCursor();
    req.onsuccess = function () {
      var cur = req.result;
      if (!cur) return resolve(out);
      var key = cur.value && cur.value.key;
      if (!prefix || (typeof key === 'string' && key.indexOf(prefix) === 0)) {
        out.push({ key: key, updated: cur.value.updated || 0, size: cur.value.size || 0 });
      }
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

function tileTtlMs(tile) {
  if (!tile) return 0;
  if (tile.failed) return FAILED_TILE_TTL_MS;
  if (tile.partial) return PARTIAL_TILE_TTL_MS;
  return TILE_TTL_MS;
}

function tileHasGeometry(tile) {
  return !!(tile && (
    (tile.c && tile.c.length) ||
    (tile.b && tile.b.length) ||
    (tile.s && tile.s.length)
  ));
}

function tileUsable(tile) {
  return !!(tile && !tile.failed && tileHasGeometry(tile));
}

function tileCacheable(tile) {
  return tileUsable(tile);
}

async function trimCache(prefix, maxEntries, maxBytes, ttlMs) {
  var now = Date.now();
  if (now - (lastTrimAt[prefix] || 0) < 60000) return;
  lastTrimAt[prefix] = now;
  try {
    var meta = await idbMeta(prefix);
    var expired = meta.filter(function (m) { return now - m.updated > ttlMs; });
    var live = meta.filter(function (m) { return now - m.updated <= ttlMs; });
    live.sort(function (a, b) { return a.updated - b.updated; });
    var bytes = live.reduce(function (sum, m) { return sum + m.size; }, 0);
    var remove = expired.slice();
    while (live.length > maxEntries || bytes > maxBytes) {
      var oldest = live.shift();
      if (!oldest) break;
      bytes -= oldest.size;
      remove.push(oldest);
    }
    await idbDelete(remove.map(function (m) { return m.key; }));
  } catch (e) { /* trimmaus on best effort */ }
}

async function fetchTile(key, stats) {
  var tileStarted = Date.now();
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
  var sykeStarted = Date.now();
  var sykeBase = SYKE_DEPTH_WFS + '?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=' + encodeURIComponent(bbox);
  var traficomBase = TRAFICOM_DEPTH_WFS + '?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&count=4000&bbox=' + encodeURIComponent(bbox);
  var requests = [
    { key: 'syke-contours', group: 'syke', url: sykeBase + '&typeNames=' + encodeURIComponent('inspire_el:EL.ContourLine') },
    { key: 'syke-bands', group: 'syke', url: sykeBase + '&typeNames=' + encodeURIComponent('inspire_el:EL.Syvyysalue') },
    { key: 'traficom-contours', group: 'traficom', url: traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:DepthContour_L') },
    { key: 'traficom-bands', group: 'traficom', url: traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:DepthArea_A') },
    { key: 'traficom-soundings', group: 'traficom', url: traficomBase + '&typeNames=' + encodeURIComponent('rajoitettu:Sounding_P') }
  ];
  var responses = {};
  var failures = 0;
  var settled = await Promise.allSettled(requests.map(function (req) {
    return fetchJsonWithTimeout(req.url).then(function (response) {
      return { req: req, response: response };
    });
  }));
  settled.forEach(function (item, index) {
    var req = requests[index];
    if (item.status === 'fulfilled') {
      responses[req.key] = item.value.response;
    } else {
      failures++;
      addStatsEvent(stats, 'tile:' + req.group + '-request-error', {
        key: key,
        request: req.key,
        error: String(item.reason && item.reason.message || item.reason)
      });
    }
  });
  var sykeContour = responses['syke-contours'];
  var sykeBand = responses['syke-bands'];
  if (sykeContour && sykeBand && sykeContour.ok && sykeBand.ok) {
    tile.c = tile.c.concat(tagSource(parseContours(sykeContour.json), 'syke'));
    tile.b = tile.b.concat(tagSource(parseBands(sykeBand.json), 'syke'));
    tile.ok = true;
    if (tile.c.length || tile.b.length) tile.sources.push('SYKE');
    addStatsEvent(stats, 'tile:syke', {
      key: key,
      durationMs: Date.now() - sykeStarted,
      contours: tile.c.length,
      bands: tile.b.length,
      status: sykeContour.status + '/' + sykeBand.status
    });
  } else {
    failures++;
    addStatsEvent(stats, 'tile:syke-error', {
      key: key,
      error: 'SYKE WFS ' + (sykeContour ? sykeContour.status : 'missing') + '/' + (sykeBand ? sykeBand.status : 'missing')
    });
  }
  var traficomStarted = Date.now();
  var traficomContour = responses['traficom-contours'];
  var traficomBand = responses['traficom-bands'];
  var traficomSounding = responses['traficom-soundings'];
  var traficomResponses = [traficomContour, traficomBand, traficomSounding].filter(Boolean);
  var denied = traficomResponses.filter(function (r) { return r.status === 401 || r.status === 403; });
  if (denied.length) {
      console.info('Traficom: alue vaatii luvan (vapaa kattavuus: talousvyöhyke + Vuoksi + Kymijoki):', key);
      addStatsEvent(stats, 'tile:traficom-denied', { key: key, status: denied.map(function (r) { return r.status; }).join('/') });
  } else if (traficomContour && traficomBand && traficomSounding &&
      traficomContour.ok && traficomBand.ok && traficomSounding.ok) {
      var c0 = tile.c.length, b0 = tile.b.length, s0 = tile.s.length;
      tile.c = tile.c.concat(tagSource(parseContours(traficomContour.json), 'traficom'));
      tile.b = tile.b.concat(tagSource(parseBands(traficomBand.json), 'traficom'));
      tile.s = tile.s.concat(tagSource(parseSoundings(traficomSounding.json), 'traficom'));
      tile.ok = true;
      if (tile.c.length > c0 || tile.b.length > b0 || tile.s.length > s0) tile.sources.push('Traficom');
      addStatsEvent(stats, 'tile:traficom', {
        key: key,
        durationMs: Date.now() - traficomStarted,
        contours: tile.c.length - c0,
        bands: tile.b.length - b0,
        soundings: tile.s.length - s0,
        status: traficomContour.status + '/' + traficomBand.status + '/' + traficomSounding.status
      });
  } else {
    failures++;
    addStatsEvent(stats, 'tile:traficom-error', {
      key: key,
      error: 'Traficom WFS ' +
        (traficomContour ? traficomContour.status : 'missing') + '/' +
        (traficomBand ? traficomBand.status : 'missing') + '/' +
        (traficomSounding ? traficomSounding.status : 'missing')
    });
  }
  tile.partial = !!(tile.ok && failures);
  tile.failed = !tile.ok;
  addStatsEvent(stats, 'tile:network', {
    key: key,
    durationMs: Date.now() - tileStarted,
    sources: tile.sources,
    contours: tile.c.length,
    bands: tile.b.length,
    soundings: tile.s.length
  });
  return tile;
}

function tagSource(features, source) {
  features.forEach(function (f) { f.source = source; });
  return features;
}

async function fetchJsonWithTimeout(url) {
  var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var timer = controller ? setTimeout(function () { controller.abort(); }, DEPTH_FETCH_TIMEOUT_MS) : null;
  try {
    var response = await fetch(url, {
      cache: 'no-store',
      signal: controller ? controller.signal : undefined
    });
    var json = await response.json();
    return { ok: response.ok, status: response.status, json: json };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getTile(key, stats, opts) {
  var bypassDiskCache = opts && opts.bypassDiskCache;
  var onStage = opts && opts.onStage;
  var mem = memTiles.get(key);
  if (mem && tileUsable(mem) && Date.now() - mem.t < tileTtlMs(mem)) {
    if (stats) stats.mem++;
    addStatsEvent(stats, 'tile:mem', { key: key });
    return mem;
  }
  if (!bypassDiskCache && fetching.has(key)) {
    if (stats) stats.wait++;
    addStatsEvent(stats, 'tile:wait', { key: key });
    return fetching.get(key);
  }
  var promise = (async function () {
    if (bypassDiskCache) {
      addStatsEvent(stats, 'tile:disk-bypass', { key: key });
      if (onStage) onStage('tile:disk-bypass', { key: key });
    } else {
      try {
        if (onStage) onStage('tile:disk-read', { key: key });
        var diskStarted = Date.now();
        var cached = await withTimeout(idbGet(TILE_CACHE_PREFIX + key), IDB_READ_TIMEOUT_MS, 'tile disk cache read timeout');
        var diskDone = {
          key: key,
          ms: Date.now() - diskStarted,
          hit: cached && cached.value ? 1 : 0,
          contours: cached && cached.value ? (cached.value.c || []).length : -1,
          bands: cached && cached.value ? (cached.value.b || []).length : -1,
          soundings: cached && cached.value ? (cached.value.s || []).length : -1,
          sources: cached && cached.value && cached.value.sources ? cached.value.sources.join('+') : '',
          partial: cached && cached.value && cached.value.partial ? 1 : 0,
          failed: cached && cached.value && cached.value.failed ? 1 : 0,
          bytes: cached ? cached.size || 0 : 0
        };
        addStatsEvent(stats, 'tile:disk-done', diskDone);
        if (onStage) onStage('tile:disk-done', diskDone);
        if (cached && cached.value && !tileUsable(cached.value)) {
          addStatsEvent(stats, 'tile:disk-empty', { key: key });
          idbDelete([TILE_CACHE_PREFIX + key]).catch(function () {});
        } else if (cached && cached.value && Date.now() - cached.value.t < tileTtlMs(cached.value)) {
          putMem(key, cached.value);
          if (stats) stats.disk++;
          addStatsEvent(stats, 'tile:disk', { key: key });
          return cached.value;
        }
      } catch (e) {
        addStatsEvent(stats, 'tile:disk-error', { key: key, error: String(e && e.message || e) });
        if (onStage) onStage('tile:disk-error', { key: key, error: String(e && e.message || e) });
      }
    }
    if (onStage) onStage('tile:network-start', { key: key });
    var tile;
    try {
      tile = await withTimeout(fetchTile(key, stats), DEPTH_TILE_NETWORK_TIMEOUT_MS, 'tile network timeout');
    } catch (e) {
      addStatsEvent(stats, 'tile:network-error', { key: key, error: String(e && e.message || e) });
      tile = { t: Date.now(), c: [], b: [], s: [], sources: [], failed: true };
    }
    if (stats) stats.fetch++;
    putMem(key, tile);
    if (tileCacheable(tile)) {
      var size = 0;
      try { size = JSON.stringify(tile).length; } catch (e) { size = 100000; }
      idbPut({ key: TILE_CACHE_PREFIX + key, value: tile, updated: Date.now(), size: size })
        .then(function () { return trimCache(TILE_CACHE_PREFIX, TILE_CACHE_MAX_ENTRIES, TILE_CACHE_MAX_BYTES, TILE_TTL_MS); })
        .catch(function () {});
    }
    return tile;
  })();
  fetching.set(key, promise);
  try {
    return await promise;
  } finally {
    fetching.delete(key);
  }
}

async function ensureTiles(keys, onProgress, opts) {
  var results = [];
  var queue = keys.slice();
  var done = 0;
  var firstDoneAt = 0;
  var stats = { mem: 0, disk: 0, fetch: 0, wait: 0, events: [], errors: [] };
  function progress(data) {
    if (!onProgress) return;
    onProgress(Object.assign({
      done: done,
      total: keys.length,
      mem: stats.mem,
      disk: stats.disk,
      fetch: stats.fetch,
      wait: stats.wait
    }, data || {}));
  }
  async function work(workerIndex) {
    while (queue.length) {
      var key = queue.shift();
      addStatsEvent(stats, 'tile:start', { key: key, worker: workerIndex });
      progress({ event: 'tile:start', key: key, worker: workerIndex });
      try {
        results.push(await getTile(key, stats, Object.assign({}, opts || {}, {
          onStage: function (event, data) { progress(Object.assign({ event: event }, data || {})); }
        })));
      } catch (e) {
        addStatsEvent(stats, 'tile:error', { key: key, error: String(e && e.message || e) });
        console.warn('Syvyystiilen haku epäonnistui:', key, e);
      }
      done++;
      if (!firstDoneAt) firstDoneAt = Date.now();
      progress();
    }
  }
  var allDone = Promise.all([work(1), work(2)]).then(function () { return 'done'; });
  var softDeadline = new Promise(function (resolve) {
    setTimeout(function () { resolve('soft'); }, DEPTH_TILES_SOFT_DEADLINE_MS);
  });
  var winner = await Promise.race([allDone, softDeadline]);
  if (winner === 'soft' && results.length && done < keys.length) {
    stats.partial = true;
    stats.pending = keys.length - done;
    addStatsEvent(stats, 'analysis:tiles-soft-deadline', {
      durationMs: firstDoneAt ? Date.now() - firstDoneAt : DEPTH_TILES_SOFT_DEADLINE_MS,
      done: done,
      total: keys.length,
      pending: keys.length - done
    });
    return { tiles: results.slice(), stats: stats, partial: true, pending: keys.length - done };
  }
  await allDone;
  return { tiles: results, stats: stats, partial: false, pending: 0 };
}

async function handleBuild(msg) {
  var cacheKey = ['analysis:v7', msg.west, msg.south, msg.east, msg.north, msg.cellLonDeg, msg.windKey,
    msg.speciesKey, Math.round((msg.lightShiftM || 0) * 10),
    Math.round((msg.strat || 0) * 100), Math.round(msg.thermoDepthM || 0),
    msg.includeZanderBreak ? 'zander' : 'base'].join('|');
  var hit = resultCache.get(cacheKey);
  if (hit && hit.result && hit.result.hasData && Date.now() - hit.t < RESULT_TTL_MS) {
    resultCache.delete(cacheKey);
    resultCache.set(cacheKey, hit);
    return { result: hit.result, sources: hit.sources, cached: true, debug: {
      events: [{ event: 'analysis:worker-memory-cache-hit', t: Date.now() }],
      errors: []
    } };
  }
  if (msg.bypassDiskCache) {
    self.postMessage({ id: msg.id, progress: { event: 'analysis:disk-cache-bypass' } });
  } else {
    try {
      var diskHit = await withTimeout(idbGet(RESULT_CACHE_PREFIX + cacheKey), IDB_READ_TIMEOUT_MS, 'analysis disk cache read timeout');
      if (diskHit && diskHit.value && diskHit.value.result && diskHit.value.result.hasData &&
          diskHit.value.t && Date.now() - diskHit.value.t < RESULT_TTL_MS) {
        var diskValue = diskHit.value;
        resultCache.set(cacheKey, { t: diskValue.t, result: diskValue.result, sources: diskValue.sources || [] });
        while (resultCache.size > RESULT_MAX) resultCache.delete(resultCache.keys().next().value);
        return { result: diskValue.result, sources: diskValue.sources || [], cached: true, debug: {
          events: [{ event: 'analysis:worker-disk-cache-hit', t: Date.now() }],
          errors: []
        } };
      }
    } catch (e) { /* persistent analysis cache miss */ }
  }
  var keys = tileKeysForBounds(msg);
  if (keys.length > MAX_TILES) return { result: null, reason: 'toowide' };
  var fetchStarted = Date.now();
  var tileResult = await ensureTiles(keys, function (progress) {
    self.postMessage({ id: msg.id, progress: progress });
  }, { bypassDiskCache: !!msg.bypassDiskCache });
  var tiles = tileResult.tiles;
  var stats = tileResult.stats || {};
  if (tileResult.partial) {
    stats.partial = true;
    stats.pending = tileResult.pending || Math.max(0, keys.length - tiles.length);
  }
  addStatsEvent(stats, 'analysis:tiles-ready', {
    durationMs: Date.now() - fetchStarted,
    tiles: tiles.length,
    partial: stats.partial ? 1 : 0,
    pending: stats.pending || 0,
    mem: stats.mem || 0,
    disk: stats.disk || 0,
    fetch: stats.fetch || 0,
    wait: stats.wait || 0
  });
  self.postMessage({ id: msg.id, progress: {
    event: 'analysis:tiles-ready',
    done: stats.partial ? tiles.length : keys.length,
    total: keys.length,
    partial: stats.partial ? 1 : 0,
    pending: stats.pending || 0,
    mem: stats.mem || 0,
    disk: stats.disk || 0,
    fetch: stats.fetch || 0,
    wait: stats.wait || 0
  } });
  var mergeStarted = Date.now();
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
  addStatsEvent(stats, 'analysis:merge', {
    durationMs: Date.now() - mergeStarted,
    contours: contourById.size,
    bands: bandById.size,
    soundings: soundingById.size
  });
  self.postMessage({ id: msg.id, progress: {
    event: 'analysis:merge',
    contours: contourById.size,
    bands: bandById.size,
    soundings: soundingById.size
  } });
  var computeStarted = Date.now();
  self.postMessage({ id: msg.id, progress: {
    event: 'analysis:compute-start',
    contours: contourById.size,
    bands: bandById.size,
    soundings: soundingById.size
  } });
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
    includeZanderBreak: !!msg.includeZanderBreak,
    onDebug: function (event) {
      addStatsEvent(stats, event.event || 'analysis:phase', event);
      self.postMessage({ id: msg.id, progress: Object.assign({}, event) });
    }
  });
  addStatsEvent(stats, 'analysis:computed', {
    durationMs: Date.now() - computeStarted,
    fetchDurationMs: Date.now() - fetchStarted,
    grid: result ? result.nx + 'x' + result.ny : '',
    points: result ? result.pointCount || 0 : 0,
    hasData: result && result.hasData ? 1 : 0
  });
  var sources = Object.keys(sourceSet);
  if (result && stats.partial) {
    result.partialTiles = {
      done: tiles.length,
      total: keys.length,
      pending: stats.pending || 0
    };
  }
  if (result && result.hasData && !stats.partial) {
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
      }).then(function () { return trimCache(RESULT_CACHE_PREFIX, RESULT_CACHE_MAX_ENTRIES, RESULT_CACHE_MAX_BYTES, RESULT_TTL_MS); }).catch(function () {});
    } catch (e) { /* persistent analysis cache write is best effort */ }
  } else if (stats.partial) {
    addStatsEvent(stats, 'analysis:partial-result-not-cached', {
      done: tiles.length,
      total: keys.length,
      pending: stats.pending || 0
    });
  } else {
    addStatsEvent(stats, 'analysis:empty-result-not-cached', {
      grid: result ? result.nx + 'x' + result.ny : '',
      points: result ? result.pointCount || 0 : 0
    });
  }
  return { result: result, sources: sources, debug: {
    events: stats.events || [],
    errors: stats.errors || [],
    tileStats: {
      mem: stats.mem || 0,
      disk: stats.disk || 0,
      fetch: stats.fetch || 0,
      wait: stats.wait || 0,
      total: keys.length,
      partial: stats.partial ? 1 : 0,
      pending: stats.pending || 0
    }
  } };
}

async function handleStatus() {
  var meta = await idbMeta(TILE_CACHE_PREFIX);
  return {
    count: meta.length,
    bytes: meta.reduce(function (sum, m) { return sum + m.size; }, 0),
    maxEntries: TILE_CACHE_MAX_ENTRIES,
    maxBytes: TILE_CACHE_MAX_BYTES
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
