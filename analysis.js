// Kalapaikka-analyysin puhdas laskenta: projektio, WFS-datan jasennys,
// syvyysruudukko, gradientti, tuulialtistus, yhdistetty indeksi ja paivakerroin.
// Ei DOM- eika Leaflet-riippuvuuksia.

export var SCORE_WEIGHTS = {
  slope: 0.45,
  wind: 0.35,
  depthPref: 0.20,
  slopeNormPerMeter: 0.08,
  // tuulen voimakkuusvaste: nousu 2->5 m/s, taso 5->8, lasku 8->14 (sekoittuminen)
  windMinMs: 2.0,
  windFullMs: 5.0,
  windFadeMs: 8.0,
  windMaxMs: 14.0,
  windFloor: 0.2,
  shoreSplatMeters: 250,
  // pyyhkaisymatka: tayteen vaikutukseen tarvitaan ~2 km avovetta tuulen puolella
  fetchSaturateM: 2000,
  fetchMaxM: 2500,
  slopeWindBonus: 0.18,
  minScoreToShow: 0.12
};

// Lajikohtaiset piirteet, kalibroitava kokemuksella. Syvyydet kesakauden
// tyypillisia suomalaisvesille; valosiirto nostaa matalampaan hamarassa.
// - hauki: vaijyy rakenteessa ja tuulirannoilla 0.5-5 m, isot yksilot syvanteen reunoilla
// - kuha: hamarasaalistaja, paivalla 4-10 m penkoilla, nousee yolla selvasti matalaan
// - ahven: paivakala, kivikot ja reunat 1.5-6 m, loppukesalla syvenee
// - muikku: kylman veden pelagi, paivalla harppauskerroksen alapuolella, nousee hamarassa
// - silakka: parvet harppauskerroksen tuntumassa ja alla, merella syvempi kerros
export var SPECIES_TRAITS = {
  hauki:   { habitat: 'benthic', structureAffinity: 0.9,  shoreAffinity: 1.0,  lightSens: 0.4, depth: { b0: 0.3, b1: 1.0, b2: 4.5, b3: 10 } },
  kuha:    { habitat: 'benthic', structureAffinity: 1.0,  shoreAffinity: 0.6,  lightSens: 1.0, depth: { b0: 1.5, b1: 4,   b2: 9,   b3: 16 } },
  ahven:   { habitat: 'benthic', structureAffinity: 0.8,  shoreAffinity: 0.7,  lightSens: 0.2, depth: { b0: 0.5, b1: 1.5, b2: 6,   b3: 12 } },
  muikku:  { habitat: 'pelagic', structureAffinity: 0.05, shoreAffinity: 0.1,  lightSens: 1.0, thermoOffsetM: 2 },
  silakka: { habitat: 'pelagic', structureAffinity: 0.1,  shoreAffinity: 0.15, lightSens: 0.8, thermoOffsetM: 4 }
};

export var DAY_WEIGHTS = {
  pressureStable: 10,
  pressureSlowFall: 18,
  pressureFastFall: 4,
  pressureSlowRise: -8,
  pressureFastRise: -18,
  pressureSlowLimit: 0.8,
  pressureFastLimit: 2.5,
  moonNew: 12,
  moonFull: 10,
  moonQuarter: -6
};

// ---------- WGS84 -> ETRS-TM35FIN (EPSG:3067) ----------
export function wgs84ToTm35(lat, lon) {
  var a = 6378137.0;
  var f = 1 / 298.257222101;
  var k0 = 0.9996;
  var lon0 = 27 * Math.PI / 180;
  var FE = 500000.0;
  var e2 = f * (2 - f);
  var ep2 = e2 / (1 - e2);
  var phi = lat * Math.PI / 180;
  var lam = lon * Math.PI / 180;
  var sinPhi = Math.sin(phi);
  var cosPhi = Math.cos(phi);
  var N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  var T = Math.tan(phi) * Math.tan(phi);
  var C = ep2 * cosPhi * cosPhi;
  var A = (lam - lon0) * cosPhi;
  var M = a * (
    (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi -
    (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi) +
    (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi) -
    (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi)
  );
  var east = FE + k0 * N * (A + (1 - T + C) * A * A * A / 6 +
    (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A * A * A * A * A / 120);
  var north = k0 * (M + N * Math.tan(phi) * (A * A / 2 +
    (5 - T + 9 * C + 4 * C * C) * A * A * A * A / 24 +
    (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A * A * A * A * A * A / 720));
  return { e: east, n: north };
}

// ---------- WFS-vastausten jasennys kompaktiin muotoon ----------
export function parseContours(fc) {
  var out = [];
  (fc && fc.features || []).forEach(function (feat) {
    var props = feat.properties || {};
    var depth = firstNumber(props, ['syvyyskayra_m', 'VALDCO']);
    if (isNaN(depth)) return;
    var geom = feat.geometry;
    if (!geom) return;
    var lines = geom.type === 'MultiLineString' ? geom.coordinates :
      geom.type === 'LineString' ? [geom.coordinates] : [];
    if (!lines.length) return;
    out.push({ id: feat.id, d: depth, lines: lines });
  });
  return out;
}

function firstNumber(props, names) {
  for (var i = 0; i < names.length; i++) {
    var value = props && props[names[i]];
    if (value == null || value === '') continue;
    var num = parseFloat(String(value).replace(',', '.'));
    if (!isNaN(num)) return num;
  }
  return NaN;
}

export function parseBandRange(text) {
  var nums = String(text == null ? '' : text).match(/\d+(?:[.,]\d+)?/g);
  if (!nums || !nums.length) return null;
  var lo = parseFloat(nums[0].replace(',', '.'));
  var hi = nums.length > 1 ? parseFloat(nums[1].replace(',', '.')) : lo * 1.5;
  return { lo: lo, hi: hi, mid: (lo + hi) / 2 };
}

export function parseBands(fc) {
  var out = [];
  (fc && fc.features || []).forEach(function (feat) {
    var props = feat.properties || {};
    var range = parseBandRange(props.syvyysvali_m);
    if (!range) {
      var lo = firstNumber(props, ['DRVAL1']);
      var hi = firstNumber(props, ['DRVAL2']);
      if (!isNaN(lo) && !isNaN(hi)) range = { lo: lo, hi: hi, mid: (lo + hi) / 2 };
    }
    var geom = feat.geometry;
    if (!range || !geom) return;
    var polys = geom.type === 'MultiPolygon' ? geom.coordinates :
      geom.type === 'Polygon' ? [geom.coordinates] : [];
    polys.forEach(function (rings, idx) {
      if (!rings.length || rings[0].length < 4) return;
      var bbox = ringBbox(rings[0]);
      out.push({ id: feat.id + ':' + idx, lo: range.lo, hi: range.hi, mid: range.mid, rings: rings, bbox: bbox });
    });
  });
  return out;
}

export function parseSoundings(fc) {
  var out = [];
  (fc && fc.features || []).forEach(function (feat) {
    var depth = firstNumber(feat.properties || {}, ['DEPTH', 'depth']);
    if (isNaN(depth)) return;
    var geom = feat.geometry;
    if (!geom) return;
    var points = geom.type === 'MultiPoint' ? geom.coordinates :
      geom.type === 'Point' ? [geom.coordinates] : [];
    points.forEach(function (p, idx) {
      if (!p || p.length < 2) return;
      out.push({ id: feat.id + ':' + idx, x: p[0], y: p[1], d: depth });
    });
  });
  return out;
}

function ringBbox(ring) {
  var w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (var i = 0; i < ring.length; i++) {
    var p = ring[i];
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  return [w, s, e, n];
}

function pointInRings(lon, lat, rings) {
  var inside = false;
  for (var r = 0; r < rings.length; r++) {
    var ring = rings[r];
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1];
      var xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
  }
  return inside;
}

function contourLevelLines(contours, bands) {
  var byDepth = new Map();
  function addLine(depth, line) {
    if (!isFinite(depth) || !line || line.length < 2) return;
    var arr = byDepth.get(depth);
    if (!arr) { arr = []; byDepth.set(depth, arr); }
    arr.push(line);
  }
  contours.forEach(function (c) {
    (c.lines || []).forEach(function (line) { addLine(c.d, line); });
  });
  if (!byDepth.has(0)) {
    bands.forEach(function (b) {
      if (b.lo !== 0) return;
      (b.rings || []).forEach(function (ring) { addLine(0, ring); });
    });
  }
  return Array.from(byDepth.keys()).sort(function (a, b) { return a - b; }).map(function (depth) {
    return { d: depth, lines: byDepth.get(depth) || [] };
  });
}

function rasterizeContourLevel(level, grid) {
  var src = new Uint8Array(grid.nx * grid.ny);
  function mark(gx, gy) {
    var x = Math.round(gx - 0.5);
    var y = Math.round(gy - 0.5);
    if (x < 0 || y < 0 || x >= grid.nx || y >= grid.ny) return;
    src[y * grid.nx + x] = 1;
  }
  level.lines.forEach(function (line) {
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var ax = (a[0] - grid.west) / grid.cellLon;
      var ay = (a[1] - grid.south) / grid.cellLat;
      var bx = (b[0] - grid.west) / grid.cellLon;
      var by = (b[1] - grid.south) / grid.cellLat;
      var steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2));
      for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        mark(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
  });
  return src;
}

function dt1d(f, n) {
  var d = new Float64Array(n);
  var v = new Int32Array(n);
  var z = new Float64Array(n + 1);
  var first = -1;
  for (var qi = 0; qi < n; qi++) {
    if (isFinite(f[qi]) && f[qi] < 1e19) { first = qi; break; }
  }
  if (first < 0) {
    for (qi = 0; qi < n; qi++) d[qi] = Infinity;
    return d;
  }
  var k = 0;
  v[0] = first;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (var q = first + 1; q < n; q++) {
    if (!isFinite(f[q]) || f[q] >= 1e19) continue;
    var s;
    do {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= z[k]) k--;
    } while (k >= 0 && s <= z[k]);
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
    } else {
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = Infinity;
    }
  }
  k = 0;
  for (q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

function distanceTransform(src, nx, ny, cellM) {
  var inf = 1e20;
  var tmp = new Float64Array(nx * ny);
  var row = new Float64Array(nx);
  var col = new Float64Array(ny);
  for (var y = 0; y < ny; y++) {
    var any = false;
    for (var x = 0; x < nx; x++) {
      var i = y * nx + x;
      row[x] = src[i] ? 0 : inf;
      if (src[i]) any = true;
    }
    var dr = any ? dt1d(row, nx) : null;
    for (x = 0; x < nx; x++) tmp[y * nx + x] = dr ? dr[x] : inf;
  }
  var out = new Float32Array(nx * ny);
  for (x = 0; x < nx; x++) {
    var anyFinite = false;
    for (y = 0; y < ny; y++) {
      col[y] = tmp[y * nx + x];
      if (col[y] < inf / 2) anyFinite = true;
    }
    var dc = anyFinite ? dt1d(col, ny) : null;
    for (y = 0; y < ny; y++) {
      var v = dc ? dc[y] : inf;
      out[y * nx + x] = v >= inf / 2 ? Infinity : Math.sqrt(v) * cellM;
    }
  }
  return out;
}

function distSqPointToSegment(px, py, ax, ay, bx, by) {
  var vx = bx - ax, vy = by - ay;
  var lenSq = vx * vx + vy * vy;
  if (lenSq <= 0) {
    var dx0 = px - ax, dy0 = py - ay;
    return dx0 * dx0 + dy0 * dy0;
  }
  var t = ((px - ax) * vx + (py - ay) * vy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  var dx = px - (ax + vx * t), dy = py - (ay + vy * t);
  return dx * dx + dy * dy;
}

function buildContourSegmentIndex(level, params) {
  var mPerLon = params.mPerLon || params.cellM / Math.max(params.cellLon, 1e-12);
  var mPerLat = params.mPerLat || params.cellM / Math.max(params.cellLat, 1e-12);
  var binM = Math.max(120, params.cellM * 3);
  var bins = new Map();
  var segments = [];
  function addToBin(bx, by, segIdx) {
    var key = bx + ':' + by;
    var arr = bins.get(key);
    if (!arr) { arr = []; bins.set(key, arr); }
    arr.push(segIdx);
  }
  (level.lines || []).forEach(function (line) {
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      if (!a || !b) continue;
      var ax = (a[0] - params.west) * mPerLon;
      var ay = (a[1] - params.south) * mPerLat;
      var bx = (b[0] - params.west) * mPerLon;
      var by = (b[1] - params.south) * mPerLat;
      if (!isFinite(ax) || !isFinite(ay) || !isFinite(bx) || !isFinite(by)) continue;
      var seg = { ax: ax, ay: ay, bx: bx, by: by };
      var segIdx = segments.length;
      segments.push(seg);
      var minBx = Math.floor(Math.min(ax, bx) / binM);
      var maxBx = Math.floor(Math.max(ax, bx) / binM);
      var minBy = Math.floor(Math.min(ay, by) / binM);
      var maxBy = Math.floor(Math.max(ay, by) / binM);
      for (var yy = minBy; yy <= maxBy; yy++) {
        for (var xx = minBx; xx <= maxBx; xx++) addToBin(xx, yy, segIdx);
      }
    }
  });
  return { binM: binM, bins: bins, segments: segments, seen: new Int32Array(segments.length), seenToken: 1 };
}

function nearestContourDistance(index, px, py, maxM) {
  if (!index || !index.segments.length) return Infinity;
  var binM = index.binM;
  var bx0 = Math.floor(px / binM);
  var by0 = Math.floor(py / binM);
  var maxRing = Math.ceil((maxM || Infinity) / binM) + 1;
  if (!isFinite(maxRing)) maxRing = 80;
  var bestSq = Infinity;
  var seen = index.seen;
  var token = index.seenToken++;
  if (index.seenToken > 2147483000) {
    seen.fill(0);
    index.seenToken = 2;
    token = 1;
  }
  for (var ring = 0; ring <= maxRing; ring++) {
    for (var by = by0 - ring; by <= by0 + ring; by++) {
      for (var bx = bx0 - ring; bx <= bx0 + ring; bx++) {
        if (Math.max(Math.abs(bx - bx0), Math.abs(by - by0)) !== ring) continue;
        var arr = index.bins.get(bx + ':' + by);
        if (!arr) continue;
        for (var i = 0; i < arr.length; i++) {
          var segIdx = arr[i];
          if (seen[segIdx] === token) continue;
          seen[segIdx] = token;
          var seg = index.segments[segIdx];
          var dSq = distSqPointToSegment(px, py, seg.ax, seg.ay, seg.bx, seg.by);
          if (dSq < bestSq) bestSq = dSq;
        }
      }
    }
    if (isFinite(bestSq)) {
      var searchedM = (ring + 1) * binM;
      if (searchedM * searchedM > bestSq + 2 * binM * binM) break;
    }
  }
  return isFinite(bestSq) ? Math.sqrt(bestSq) : Infinity;
}

function vectorDistanceToContourLevel(level, params, maxM) {
  var out = new Float32Array(params.nx * params.ny);
  var mPerLon = params.mPerLon || params.cellM / Math.max(params.cellLon, 1e-12);
  var mPerLat = params.mPerLat || params.cellM / Math.max(params.cellLat, 1e-12);
  var index = buildContourSegmentIndex(level, params);
  for (var y = 0; y < params.ny; y++) {
    var py = (y + 0.5) * params.cellLat * mPerLat;
    for (var x = 0; x < params.nx; x++) {
      var idx = y * params.nx + x;
      var px = (x + 0.5) * params.cellLon * mPerLon;
      out[idx] = nearestContourDistance(index, px, py, maxM);
    }
  }
  return out;
}

function prefOverlap(dLo, dHi, preset, shift, strat) {
  if (!isFinite(dLo) || !isFinite(dHi) || dHi <= dLo) return 0;
  var w = [1, 4, 2, 4, 1];
  var sum = 0, wsum = 0;
  for (var i = 0; i < 5; i++) {
    var z = dLo + (dHi - dLo) * i / 4;
    sum += w[i] * depthPreference(z, preset, shift, strat);
    wsum += w[i];
  }
  return wsum ? sum / wsum : 0;
}

function percentileFromValues(values, p) {
  if (!values.length) return null;
  values.sort(function (a, b) { return a - b; });
  var idx = Math.max(0, Math.min(values.length - 1, Math.floor((values.length - 1) * p)));
  return values[idx];
}

function maxDepthWithin(depth, mask, nx, ny, cellM, meters) {
  var radius = Math.max(1, Math.ceil(meters / Math.max(1, cellM)));
  var tmp = new Float32Array(nx * ny);
  var out = new Float32Array(nx * ny);
  var deque = new Int32Array(Math.max(nx, ny));
  for (var y = 0; y < ny; y++) {
    var head = 0, tail = 0;
    var right = -1;
    for (var x = 0; x < nx; x++) {
      var targetRight = Math.min(nx - 1, x + radius);
      while (right < targetRight) {
        right++;
        var add = right;
        var addIdx = y * nx + add;
        var addVal = mask[addIdx] && isFinite(depth[addIdx]) ? depth[addIdx] : -Infinity;
        while (tail > head) {
          var last = deque[tail - 1];
          var lastIdx = y * nx + last;
          var lastVal = mask[lastIdx] && isFinite(depth[lastIdx]) ? depth[lastIdx] : -Infinity;
          if (lastVal > addVal) break;
          tail--;
        }
        deque[tail++] = add;
      }
      while (tail > head && deque[head] < x - radius) head++;
      if (tail > head) {
        var bestIdx = y * nx + deque[head];
        tmp[y * nx + x] = mask[bestIdx] && isFinite(depth[bestIdx]) ? depth[bestIdx] : -Infinity;
      } else {
        tmp[y * nx + x] = -Infinity;
      }
    }
  }
  for (x = 0; x < nx; x++) {
    head = 0;
    tail = 0;
    right = -1;
    for (y = 0; y < ny; y++) {
      targetRight = Math.min(ny - 1, y + radius);
      while (right < targetRight) {
        right++;
        add = right;
        addIdx = add * nx + x;
        addVal = tmp[addIdx];
        while (tail > head) {
          last = deque[tail - 1];
          lastIdx = last * nx + x;
          lastVal = tmp[lastIdx];
          if (lastVal > addVal) break;
          tail--;
        }
        deque[tail++] = add;
      }
      while (tail > head && deque[head] < y - radius) head++;
      if (tail > head) {
        bestIdx = deque[head] * nx + x;
        out[y * nx + x] = isFinite(tmp[bestIdx]) ? tmp[bestIdx] : NaN;
      } else {
        out[y * nx + x] = NaN;
      }
    }
  }
  return out;
}

function buildZanderBreakLayer(params) {
  var MAX_ZANDER_BREAK_RUN_M = 550;
  var MIN_ZANDER_BREAK_GRAD = 0.025;
  var MIN_ZANDER_BREAK_CANDIDATE_GRAD = 0.018;
  var MIN_ZANDER_BREAK_OVERLAP = 0.35;
  var MIN_ZANDER_BREAK_DROP_TERM = 0.3;
  var MIN_ZANDER_BREAK_REFUGE = 0.15;
  var levels = contourLevelLines(params.contours, params.bands).filter(function (level) {
    return level.lines.length && level.d > 0;
  });
  if (levels.length < 2) return null;
  var grid = {
    nx: params.nx, ny: params.ny, west: params.west, south: params.south,
    cellLon: params.cellLon, cellLat: params.cellLat, cellM: params.cellM
  };
  var levelData = levels.map(function (level) {
    var indexParams = Object.assign({}, grid, {
      mPerLon: params.mPerLon,
      mPerLat: params.mPerLat
    });
    return {
      d: level.d,
      roughDist: distanceTransform(rasterizeContourLevel(level, grid), params.nx, params.ny, params.cellM),
      index: buildContourSegmentIndex(level, indexParams)
    };
  });
  var edgeRaw = new Float32Array(params.nx * params.ny);
  var edge = new Float32Array(params.nx * params.ny);
  var strong = new Uint8Array(params.nx * params.ny);
  var pairLo = new Float32Array(params.nx * params.ny);
  var pairHi = new Float32Array(params.nx * params.ny);
  var centerSigned = new Float32Array(params.nx * params.ny);
  var values = [];
  var strongCount = 0;
  var candidateCount = 0;
  var deepMax = maxDepthWithin(params.depth, params.mask, params.nx, params.ny, params.cellM, 300);
  var effShift = (params.lightShiftM || 0) * (SPECIES_TRAITS.kuha.lightSens || 1);
  var traits = SPECIES_TRAITS.kuha;
  var roughRunMarginM = Math.max(params.cellM * 2.5, 90);
  var mPerLon = params.mPerLon || params.cellM / Math.max(params.cellLon, 1e-12);
  var mPerLat = params.mPerLat || params.cellM / Math.max(params.cellLat, 1e-12);
  for (var idx = 0; idx < params.nx * params.ny; idx++) {
    pairLo[idx] = NaN;
    pairHi[idx] = NaN;
    centerSigned[idx] = NaN;
    if (!params.mask[idx]) continue;
    if (!isFinite(deepMax[idx])) continue;
    var refuge = Math.min(1, Math.max(0, (deepMax[idx] - 8) / 8));
    if (refuge <= 0) continue;
    var bestRaw = 0;
    var bestLo = null;
    var bestHi = null;
    var bestGrad = 0;
    var bestCenterSigned = NaN;
    var x = idx % params.nx;
    var y = Math.floor(idx / params.nx);
    var px = (x + 0.5) * params.cellLon * mPerLon;
    var py = (y + 0.5) * params.cellLat * mPerLat;
    for (var i = 0; i < levelData.length - 1; i++) {
      var lo = levelData[i];
      var hi = levelData[i + 1];
      var roughRun = lo.roughDist[idx] + hi.roughDist[idx];
      if (!isFinite(roughRun) || roughRun > MAX_ZANDER_BREAK_RUN_M + roughRunMarginM) continue;
      var distLo = nearestContourDistance(lo.index, px, py, MAX_ZANDER_BREAK_RUN_M);
      var distHi = nearestContourDistance(hi.index, px, py, MAX_ZANDER_BREAK_RUN_M);
      var run = distLo + distHi;
      var drop = hi.d - lo.d;
      if (!isFinite(run) || run < params.cellM * 0.75 || drop <= 0) continue;
      if (run > MAX_ZANDER_BREAK_RUN_M) continue;
      var overlap = prefOverlap(lo.d, hi.d, traits.depth, effShift, params.strat || 0);
      var grad = drop / run;
      var gate = overlap * overlap * overlap;
      var dropTerm = Math.min(1, drop / 8);
      if (
        overlap < MIN_ZANDER_BREAK_OVERLAP ||
        dropTerm < MIN_ZANDER_BREAK_DROP_TERM ||
        refuge < MIN_ZANDER_BREAK_REFUGE
      ) continue;
      var raw = grad * gate * dropTerm * refuge;
      if (!isFinite(raw) || raw <= bestRaw) continue;
      bestRaw = raw;
      bestLo = lo;
      bestHi = hi;
      bestGrad = grad;
      bestCenterSigned = distLo - distHi;
    }
    if (!bestLo || !bestHi) continue;
    edgeRaw[idx] = bestRaw;
    pairLo[idx] = bestLo.d;
    pairHi[idx] = bestHi.d;
    centerSigned[idx] = bestCenterSigned;
    values.push(bestRaw);
    if (bestGrad >= MIN_ZANDER_BREAK_CANDIDATE_GRAD) {
      strong[idx] = bestGrad >= MIN_ZANDER_BREAK_GRAD ? 2 : 1;
      candidateCount++;
      if (strong[idx] > 1) strongCount++;
    }
  }
  var p50 = percentileFromValues(values.slice(), 0.50) || 0;
  var p95 = percentileFromValues(values, 0.95) || 0;
  var hasAny = false;
  if (p95 > 0) {
    for (idx = 0; idx < edgeRaw.length; idx++) {
      if (!edgeRaw[idx]) continue;
      edge[idx] = Math.min(1, edgeRaw[idx] / p95);
      if (strong[idx]) hasAny = true;
    }
  }
  return {
    edge: edge,
    raw: edgeRaw,
    strong: strong,
    pairLo: pairLo,
    pairHi: pairHi,
    centerSigned: centerSigned,
    p50: p50,
    p95: p95,
    strongCount: strongCount,
    candidateCount: candidateCount,
    levelCount: levelData.length,
    hasAny: hasAny
  };
}

// ---------- syvyysruudukko ja indeksi ----------
export function buildAnalysis(input) {
  var debug = typeof input.onDebug === 'function' ? input.onDebug : null;
  function nowMs() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
  var debugStart = nowMs();
  var debugLast = debugStart;
  function emitDebug(event, data) {
    if (!debug) return;
    var t = nowMs();
    debug(Object.assign({
      event: event,
      durationMs: Math.round(t - debugLast),
      totalMs: Math.round(t - debugStart)
    }, data || {}));
    debugLast = t;
  }
  var contours = input.contours || [];
  var bands = input.bands || [];
  var soundings = input.soundings || [];
  var wind = input.wind || null;
  var west = input.west, south = input.south, east = input.east, north = input.north;
  var weights = Object.assign({}, SCORE_WEIGHTS, input.weights || {});
  var targetCellM = input.cellMeters || 50;
  var maxCells = input.maxCells || 150;

  var midLat = (south + north) / 2;
  var mPerLat = 111320;
  var mPerLon = 111320 * Math.cos(midLat * Math.PI / 180);
  var widthM = (east - west) * mPerLon;
  var heightM = (north - south) * mPerLat;
  if (widthM <= 0 || heightM <= 0) return null;

  var nx, ny, cellLon, cellLat, cellM;
  if (input.cellLonDeg && input.cellLatDeg) {
    // maailmaan ankkuroitu ruudukko: solurajat kiinteita, kuvio ei muutu panoroidessa
    cellLon = input.cellLonDeg;
    cellLat = input.cellLatDeg;
    nx = Math.max(8, Math.round((east - west) / cellLon));
    ny = Math.max(8, Math.round((north - south) / cellLat));
    if (nx * ny > (input.maxCellsTotal || 120000)) return null;
    cellM = (cellLat * mPerLat + cellLon * mPerLon) / 2;
  } else {
    cellM = Math.max(targetCellM, widthM / maxCells, heightM / maxCells);
    nx = Math.max(8, Math.round(widthM / cellM));
    ny = Math.max(8, Math.round(heightM / cellM));
    cellLon = (east - west) / nx;
    cellLat = (north - south) / ny;
  }

  // 1) syvyyspisteet kayravertekseista
  var points = [];
  soundings.forEach(function (p) {
    if (p.x < west - 0.01 || p.x > east + 0.01 || p.y < south - 0.01 || p.y > north + 0.01) return;
    points.push({ x: p.x, y: p.y, d: p.d, kind: 'sounding' });
  });
  contours.forEach(function (c) {
    c.lines.forEach(function (line) {
      for (var i = 0; i < line.length; i++) {
        var p = line[i];
        if (p[0] < west - 0.01 || p[0] > east + 0.01 || p[1] < south - 0.01 || p[1] > north + 0.01) continue;
        points.push({ x: p[0], y: p[1], d: c.d, kind: 'contour' });
      }
    });
  });
  if (points.length > 8000) {
    var stride = Math.ceil(points.length / 8000);
    points = points.filter(function (_, i) { return i % stride === 0; });
  }
  emitDebug('analysis:points', {
    contours: contours.length,
    bands: bands.length,
    soundings: soundings.length,
    points: points.length,
    grid: nx + 'x' + ny
  });
  if (points.length < 8) {
    return { nx: nx, ny: ny, west: west, south: south, east: east, north: north, cellM: cellM, hasData: false };
  }

  // 2) bin-indeksi lahihakuun
  var binM = cellM * 4;
  var binLon = binM / mPerLon;
  var binLat = binM / mPerLat;
  var bins = new Map();
  points.forEach(function (p) {
    var key = Math.floor((p.x - west) / binLon) + ':' + Math.floor((p.y - south) / binLat);
    var arr = bins.get(key);
    if (!arr) { arr = []; bins.set(key, arr); }
    arr.push(p);
  });
  emitDebug('analysis:bins', { bins: bins.size });

  var maxDistM = Math.max(180, cellM * 3);
  var maxRing = Math.ceil(maxDistM / binM);

  function idw(lon, lat) {
    var bx = Math.floor((lon - west) / binLon);
    var by = Math.floor((lat - south) / binLat);
    var maxDistSq = maxDistM * maxDistM;
    var num = 0, den = 0, count = 0;
    var firstDepth = null;
    var hasVariety = false;
    for (var ring = 0; ring <= maxRing; ring++) {
      for (var dx = -ring; dx <= ring; dx++) {
        for (var dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          var arr = bins.get((bx + dx) + ':' + (by + dy));
          if (!arr) continue;
          for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            var dxm = (p.x - lon) * mPerLon;
            var dym = (p.y - lat) * mPerLat;
            var distSq = dxm * dxm + dym * dym;
            if (distSq > maxDistSq) continue;
            if (p.kind === 'sounding' && distSq < 25) return p.d;
            if (firstDepth == null) {
              firstDepth = p.d;
            } else if (!hasVariety && Math.abs(p.d - firstDepth) > 0.05) {
              hasVariety = true;
            }
            var wgt = 1 / Math.max(distSq, 25);
            num += wgt * p.d;
            den += wgt;
            count++;
          }
        }
      }
      if (count >= 6 && ring >= 1 && hasVariety) break;
    }
    return count ? num / den : NaN;
  }

  // 3) vesimaski syvyysvyohykkeista (fallback: IDW-osumat)
  var useBands = bands.length > 0;
  var depth = new Float32Array(nx * ny);
  var mask = new Uint8Array(nx * ny);
  var bandRows = null;
  var maxRowBands = 0;
  var bandRowRefs = 0;
  if (useBands) {
    bandRows = new Array(ny);
    bands.forEach(function (band) {
      var bb = band.bbox;
      if (!bb) return;
      var y0 = Math.max(0, Math.floor((bb[1] - south) / cellLat) - 1);
      var y1 = Math.min(ny - 1, Math.floor((bb[3] - south) / cellLat) + 1);
      if (y1 < 0 || y0 >= ny) return;
      for (var y = y0; y <= y1; y++) {
        var row = bandRows[y];
        if (!row) row = bandRows[y] = [];
        row.push(band);
        bandRowRefs++;
        if (row.length > maxRowBands) maxRowBands = row.length;
      }
    });
    emitDebug('analysis:band-index', {
      bands: bands.length,
      rowRefs: bandRowRefs,
      maxRowBands: maxRowBands
    });
  }
  var depthStarted = nowMs();
  var depthBudgetMs = input.depthGridBudgetMs || 15000;
  var depthGridPartial = false;
  var waterCells = 0;
  var bandChecks = 0;
  var progressEveryRows = Math.max(4, Math.floor(ny / 8));
  for (var gy = 0; gy < ny; gy++) {
    var rowBands = useBands ? (bandRows[gy] || []) : null;
    for (var gx = 0; gx < nx; gx++) {
      var lon = west + (gx + 0.5) * cellLon;
      var lat = south + (gy + 0.5) * cellLat;
      var idx = gy * nx + gx;
      var inWater = !useBands;
      if (useBands) {
        for (var b = 0; b < rowBands.length; b++) {
          var bb = rowBands[b].bbox;
          if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
          bandChecks++;
          if (pointInRings(lon, lat, rowBands[b].rings)) { inWater = true; break; }
        }
      }
      if (!inWater) { depth[idx] = NaN; continue; }
      waterCells++;
      var d = idw(lon, lat);
      depth[idx] = d;
      if (!isNaN(d)) mask[idx] = 1;
    }
    if (debug && ((gy + 1) % progressEveryRows === 0 || gy === ny - 1)) {
      emitDebug('analysis:depth-grid-progress', {
        rows: gy + 1,
        totalRows: ny,
        cells: (gy + 1) * nx,
        water: waterCells,
        bandChecks: bandChecks,
        elapsedMs: Math.round(nowMs() - depthStarted)
      });
    }
    if (nowMs() - depthStarted > depthBudgetMs) {
      depthGridPartial = true;
      emitDebug('analysis:depth-grid-budget', {
        rows: gy + 1,
        totalRows: ny,
        cells: (gy + 1) * nx,
        water: waterCells,
        bandChecks: bandChecks,
        budgetMs: depthBudgetMs
      });
      break;
    }
  }
  emitDebug('analysis:depth-grid', {
    cells: nx * ny,
    water: waterCells,
    bandChecks: bandChecks,
    partial: depthGridPartial ? 1 : 0,
    elapsedMs: Math.round(nowMs() - depthStarted)
  });

  // 4) gradientti erotusosamaaralla
  var slope = new Float32Array(nx * ny);
  for (gy = 0; gy < ny; gy++) {
    for (gx = 0; gx < nx; gx++) {
      idx = gy * nx + gx;
      if (!mask[idx]) continue;
      var d0 = depth[idx];
      var li = gx > 0 ? gy * nx + gx - 1 : -1;
      var ri = gx < nx - 1 ? gy * nx + gx + 1 : -1;
      var di = gy > 0 ? (gy - 1) * nx + gx : -1;
      var ui = gy < ny - 1 ? (gy + 1) * nx + gx : -1;
      var hasL = li >= 0 && mask[li];
      var hasR = ri >= 0 && mask[ri];
      var hasD = di >= 0 && mask[di];
      var hasU = ui >= 0 && mask[ui];
      var gxm = hasL && hasR ? (depth[ri] - depth[li]) / (2 * cellM) :
        hasR ? (depth[ri] - d0) / cellM :
        hasL ? (d0 - depth[li]) / cellM : 0;
      var gym = hasD && hasU ? (depth[ui] - depth[di]) / (2 * cellM) :
        hasU ? (depth[ui] - d0) / cellM :
        hasD ? (d0 - depth[di]) / cellM : 0;
      slope[idx] = Math.sqrt(gxm * gxm + gym * gym);
    }
  }
  emitDebug('analysis:slope', { cells: nx * ny });

  // 5) tuulialtistus: 0-kayrat rantaviivana, normaali . tuulivektori
  var windExp = new Float32Array(nx * ny);
  var windScale = 0;
  if (wind && isFinite(wind.speed) && isFinite(wind.direction)) {
    var ws = wind.speed;
    if (ws <= weights.windMinMs) windScale = 0;
    else if (ws < weights.windFullMs) windScale = (ws - weights.windMinMs) / (weights.windFullMs - weights.windMinMs);
    else if (ws <= weights.windFadeMs) windScale = 1;
    else windScale = Math.max(weights.windFloor,
      1 - (ws - weights.windFadeMs) / (weights.windMaxMs - weights.windFadeMs) * (1 - weights.windFloor));
  }
  if (windScale > 0) {
    var windToRad = ((wind.direction + 180) % 360) * Math.PI / 180;
    var wvx = Math.sin(windToRad);
    var wvy = Math.cos(windToRad);
    // vaikutuskaista rannasta metreina, ei soluina (muuten leveys riippuisi zoomista)
    var splatR = Math.max(2, Math.round(weights.shoreSplatMeters / cellM));
    // pyyhkaisymatka: askella tuulta vastaan ja mittaa avoveden matka;
    // extentin ulkopuoli tulkitaan avovedeksi (ei rangaista reunoja)
    var maxFetchSteps = Math.ceil(weights.fetchMaxM / cellM);
    var upLonStep = -wvx * cellM / mPerLon;
    var upLatStep = -wvy * cellM / mPerLat;
    var fetchFactor = function (lon, lat) {
      var px = lon, py = lat;
      var steps = 0;
      for (var k = 0; k < maxFetchSteps; k++) {
        px += upLonStep;
        py += upLatStep;
        if (px < west || px > east || py < south || py > north) { steps = maxFetchSteps; break; }
        if (isNaN(sampleDepth(px, py))) { steps = k; break; }
        steps = k + 1;
      }
      return Math.min(1, steps * cellM / weights.fetchSaturateM);
    };
    // rantaviiva: 0-kayrat (SYKE-jarvet); merella niita ei ole, joten
    // fallbackina 0-alkuisten syvyysalueiden reunat (Traficom DRVAL1=0)
    var shoreLines = [];
    contours.forEach(function (c) {
      if (c.d === 0) shoreLines.push.apply(shoreLines, c.lines);
    });
    if (!shoreLines.length) {
      bands.forEach(function (b) {
        if (b.lo === 0) shoreLines.push.apply(shoreLines, b.rings);
      });
    }
    shoreLines.forEach(function (line) {
        for (var i = 1; i < line.length; i++) {
          var ax = line[i - 1][0], ay = line[i - 1][1];
          var bx2 = line[i][0], by2 = line[i][1];
          var mx = (ax + bx2) / 2, my = (ay + by2) / 2;
          if (mx < west || mx > east || my < south || my > north) continue;
          var tx = (bx2 - ax) * mPerLon;
          var ty = (by2 - ay) * mPerLat;
          var len = Math.sqrt(tx * tx + ty * ty);
          if (len < 1) continue;
          var n1x = -ty / len, n1y = tx / len;
          var probe = cellM * 1.5;
          var d1 = sampleDepth(mx + n1x * probe / mPerLon, my + n1y * probe / mPerLat);
          var d2 = sampleDepth(mx - n1x * probe / mPerLon, my - n1y * probe / mPerLat);
          var waterSign = (isNaN(d2) ? 0 : d2) > (isNaN(d1) ? 0 : d1) ? -1 : 1;
          var landNx = -waterSign * n1x, landNy = -waterSign * n1y;
          var facing = wvx * landNx + wvy * landNy;
          if (facing < 0.25) continue;
          var fetchF = fetchFactor(mx, my);
          if (fetchF < 0.05) continue;
          var cgx = Math.round((mx - west) / cellLon);
          var cgy = Math.round((my - south) / cellLat);
          for (var sy = -splatR; sy <= splatR; sy++) {
            for (var sx = -splatR; sx <= splatR; sx++) {
              var px = cgx + sx, py = cgy + sy;
              if (px < 0 || px >= nx || py < 0 || py >= ny) continue;
              var pidx = py * nx + px;
              if (!mask[pidx]) continue;
              var dist = Math.sqrt(sx * sx + sy * sy);
              if (dist > splatR) continue;
              var val = facing * fetchF * (1 - dist / splatR);
              if (val > windExp[pidx]) windExp[pidx] = val;
            }
          }
        }
    });
  }
  emitDebug('analysis:wind', { windScale: Number(windScale.toFixed ? windScale.toFixed(3) : windScale) });

  function sampleDepth(lon, lat) {
    var gx2 = Math.floor((lon - west) / cellLon);
    var gy2 = Math.floor((lat - south) / cellLat);
    if (gx2 < 0 || gx2 >= nx || gy2 < 0 || gy2 >= ny) return NaN;
    return depth[gy2 * nx + gx2];
  }

  // 6) yhdistetty indeksi; painot normalisoidaan aktiivisten signaalien yli
  // ja skaalataan lajin habitaattipiirteilla (pelagisilla rakenne/ranta ~pois)
  var traits = input.traits || null;
  var thermoDepthM = input.thermoDepthM;
  var lightShiftM = input.lightShiftM || 0;
  var strat = input.strat || 0;
  var isPelagic = traits && traits.habitat === 'pelagic';
  var effShift = lightShiftM * (traits ? traits.lightSens : 1);

  var score = new Float32Array(nx * ny);
  var wSlope = weights.slope * (traits ? traits.structureAffinity : 1);
  // paino kasvaa windScalen mukana: heikko tuuli ei pudota muiden signaalien osuutta kertarysayksella
  var wWind = weights.wind * windScale * (traits ? traits.shoreAffinity : 1);
  var wPref = weights.depthPref;
  var slopeWindBonus = Math.max(0, weights.slopeWindBonus || 0);
  var interactionAffinity = traits ? Math.min(traits.structureAffinity || 0, traits.shoreAffinity || 0) : 1;
  var hasAny = false;
  // karkeammassa ruudukossa gradientti laimenee; skaalataan kynnys solukoon mukaan
  var slopeNormEff = weights.slopeNormPerMeter * Math.min(1, Math.sqrt(50 / cellM));
  for (idx = 0; idx < nx * ny; idx++) {
    if (!mask[idx]) continue;
    var slopeN = Math.min(1, slope[idx] / slopeNormEff);
    slopeN *= Math.min(1, Math.max(0, (depth[idx] - 0.5) / 0.8));
    // pelagisilla valosiirto mallintaa vuorokausivaellusta: hamarassa parvi nousee
    var pref = isPelagic
      ? pelagicPreference(depth[idx], thermoDepthM, (traits.thermoOffsetM || 0) - effShift)
      : depthPreference(depth[idx], traits ? traits.depth : null, effShift, strat);
    var wWindCell = windExp[idx] > 0 ? wWind : 0;
    var s = (wSlope * slopeN + wWindCell * windExp[idx] + wPref * pref) / (wSlope + wWindCell + wPref);
    s = Math.min(1, s + slopeWindBonus * interactionAffinity * slopeN * windExp[idx]);
    score[idx] = s;
    if (s >= weights.minScoreToShow) hasAny = true;
  }
  emitDebug('analysis:score', { hasAny: hasAny ? 1 : 0 });

  var zanderBreak = input.includeZanderBreak === false ? null : buildZanderBreakLayer({
    contours: contours,
    bands: bands,
    nx: nx,
    ny: ny,
    west: west,
    south: south,
    cellLon: cellLon,
    cellLat: cellLat,
    cellM: cellM,
    mPerLon: mPerLon,
    mPerLat: mPerLat,
    depth: depth,
    mask: mask,
    lightShiftM: lightShiftM,
    strat: strat
  });
  emitDebug('analysis:zander-break', {
    enabled: input.includeZanderBreak === false ? 0 : 1,
    levels: zanderBreak && zanderBreak.levelCount ? zanderBreak.levelCount : 0,
    strong: zanderBreak && zanderBreak.strongCount ? zanderBreak.strongCount : 0,
    candidates: zanderBreak && zanderBreak.candidateCount ? zanderBreak.candidateCount : 0
  });

  return {
    nx: nx, ny: ny, west: west, south: south, east: east, north: north,
    cellM: cellM, cellLon: cellLon, cellLat: cellLat,
    depth: depth, mask: mask, slope: slope, windExp: windExp, score: score,
    zanderBreak: zanderBreak,
    depthGridPartial: depthGridPartial,
    windScale: windScale, pointCount: points.length,
    hasData: true, hasScore: hasAny
  };
}

function dayOfYear(date) {
  var start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date - start) / 86400000);
}

// Kausikerroin: 0 = ei kerrostumaa (kevat/syksy/talvi), 1 = vakaa kesakerrostuma.
// Trapetsoidi: kerrostuma syntyy kesakuussa, pysyy vakaana heina-elokuun ja
// purkautuu syys-lokakuun taysikiertoon.
export function stratificationFactor(date) {
  var doy = dayOfYear(date);
  if (doy < 150 || doy > 285) return 0;
  if (doy < 185) return (doy - 150) / 35;
  if (doy <= 245) return 1;
  return Math.max(0, (285 - doy) / 40);
}

// Karkea kalenteri+leveysaste-approksimaatio, ei mitattua lampotilaa.
// Harppauskerros SYVENEE kesan mittaan taysikiertoon asti (epilimnion kasvaa):
// etela-Suomen jarvissa n. 5-7 m juhannuksena, 8-11 m loppukesalla.
// Pohjoisessa kerrostuma on matalampi ja lyhytikaisempi.
export function estimateThermoclineDepth(date, lat) {
  var strat = stratificationFactor(date);
  if (strat <= 0) return null;
  var progress = Math.max(0, Math.min(1, (dayOfYear(date) - 150) / 120));
  var latFactor = Math.max(0.65, Math.min(1, 1 - (Math.abs(lat) - 60) * 0.04));
  return (4 + 7 * progress) * latFactor;
}

export function depthPreference(d, preset, shiftM, strat) {
  var p = preset || SPECIES_TRAITS.hauki.depth;
  var s = shiftM || 0;
  var cap = 1 - 0.3 * (strat || 0); // kerrostuneena alusvesi vahemman kiinnostavaa
  var b0 = Math.max(0.1, p.b0 - s);
  var b1 = Math.max(b0 + 0.3, p.b1 - s);
  var b2 = Math.max(b1 + 0.5, p.b2 - s);
  var b3 = Math.max(b2 + 1, (p.b3 - s) * cap);
  if (isNaN(d) || d <= b0) return 0;
  if (d < b1) return (d - b0) / (b1 - b0);
  if (d <= b2) return 1;
  if (d >= b3) return 0;
  return (b3 - d) / (b3 - b2);
}

export function pelagicPreference(d, thermoDepthM, thermoOffsetM) {
  if (isNaN(d) || d <= 0.5 || thermoDepthM == null) return 0;
  var target = Math.max(0.5, thermoDepthM + (thermoOffsetM || 0));
  var dist = Math.abs(d - target);
  return Math.max(0, 1 - dist / 4); // 4 m toleranssi
}

// ---------- paivakerroin: paine + kuu ----------
export function pressureTrend(hourlyTimes, hourlyPressure, now) {
  var nowMs = now.getTime();
  var best = -1, bestDiff = Infinity;
  for (var i = 0; i < hourlyTimes.length; i++) {
    var diff = Math.abs(hourlyTimes[i] - nowMs);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  if (best < 3) return null;
  var pNow = hourlyPressure[best];
  var p3 = hourlyPressure[best - 3];
  var p24 = best >= 24 ? hourlyPressure[best - 24] : null;
  if (pNow == null || p3 == null) return null;
  return { d3h: pNow - p3, d24h: p24 != null ? pNow - p24 : null, now: pNow };
}

export function dayScore(input) {
  var W = Object.assign({}, DAY_WEIGHTS, input.weights || {});
  var parts = [];
  var score = 50;

  var trend = input.trend;
  if (trend) {
    var d3 = trend.d3h;
    var pts, text;
    if (d3 <= -W.pressureFastLimit) { pts = W.pressureFastFall; text = 'nopeasti laskeva (rintama tulossa)'; }
    else if (d3 <= -W.pressureSlowLimit) { pts = W.pressureSlowFall; text = 'hitaasti laskeva'; }
    else if (d3 < W.pressureSlowLimit) { pts = W.pressureStable; text = 'vakaa'; }
    else if (d3 < W.pressureFastLimit) { pts = W.pressureSlowRise; text = 'nouseva'; }
    else { pts = W.pressureFastRise; text = 'nopeasti nouseva'; }
    score += pts;
    parts.push({
      name: 'Ilmanpaine',
      value: pts,
      text: text + ' (' + (d3 >= 0 ? '+' : '') + d3.toFixed(1) + ' hPa/3h, ' + Math.round(trend.now) + ' hPa)'
    });
  } else {
    parts.push({ name: 'Ilmanpaine', value: 0, text: 'ei dataa' });
  }

  var SunCalc = input.SunCalc;
  var now = input.now;
  var lat = input.lat, lon = input.lon;
  if (SunCalc && isFinite(lat) && isFinite(lon)) {
    var phase = SunCalc.getMoonIllumination(now).phase;
    var moonPts = 0, moonText;
    if (phase < 0.06 || phase > 0.94) { moonPts = W.moonNew; moonText = 'uusikuu'; }
    else if (phase > 0.44 && phase < 0.56) { moonPts = W.moonFull; moonText = 'taysikuu'; }
    else if ((phase > 0.19 && phase < 0.31) || (phase > 0.69 && phase < 0.81)) { moonPts = W.moonQuarter; moonText = 'neljänneskuu'; }
    else { moonText = phase < 0.5 ? 'kasvava kuu' : 'vähenevä kuu'; }
    score += moonPts;
    parts.push({ name: 'Kuu', value: moonPts, text: moonText });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  var label = score >= 70 ? 'Erinomainen' : score >= 55 ? 'Hyvä' : score >= 45 ? 'Kohtalainen' : score >= 30 ? 'Vaisu' : 'Huono';
  return { score: score, label: label, parts: parts, bestTimes: bestTimes(input) };
}

export function bestTimes(input) {
  var SunCalc = input.SunCalc;
  var now = input.now;
  var lat = input.lat, lon = input.lon;
  if (!SunCalc || !isFinite(lat) || !isFinite(lon)) return [];
  var out = [];
  var times = SunCalc.getTimes(now, lat, lon);
  if (times.sunrise && !isNaN(times.sunrise)) {
    out.push({ from: new Date(times.sunrise.getTime() - 3600000), to: new Date(times.sunrise.getTime() + 5400000), label: 'Aamuhämärä' });
  }
  if (times.sunset && !isNaN(times.sunset)) {
    out.push({ from: new Date(times.sunset.getTime() - 5400000), to: new Date(times.sunset.getTime() + 3600000), label: 'Iltahämärä' });
  }
  moonTransits(SunCalc, now, lat, lon).forEach(function (t) {
    out.push({ from: new Date(t.t - 3600000), to: new Date(t.t + 3600000), label: t.upper ? 'Kuun ylitys' : 'Kuun alitus' });
  });
  out.sort(function (a, b) { return a.from - b.from; });
  return out;
}

export function moonTransits(SunCalc, day, lat, lon) {
  var start = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  var stepMs = 10 * 60 * 1000;
  var prevAlt = null, prevDelta = null;
  var out = [];
  for (var t = start; t <= start + 24 * 3600000; t += stepMs) {
    var alt = SunCalc.getMoonPosition(new Date(t), lat, lon).altitude;
    if (prevAlt != null) {
      var delta = alt - prevAlt;
      if (prevDelta != null) {
        if (prevDelta > 0 && delta <= 0) out.push({ t: t - stepMs, upper: true });
        if (prevDelta < 0 && delta >= 0) out.push({ t: t - stepMs, upper: false });
      }
      prevDelta = delta;
    }
    prevAlt = alt;
  }
  return out;
}
