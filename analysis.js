// Kalapaikka-analyysin puhdas laskenta: projektio, WFS-datan jasennys,
// syvyysruudukko, gradientti, tuulialtistus, yhdistetty indeksi ja paivakerroin.
// Ei DOM- eika Leaflet-riippuvuuksia.

export var SCORE_WEIGHTS = {
  slope: 0.45,
  wind: 0.35,
  depthPref: 0.20,
  slopeNormPerMeter: 0.08,
  windMinMs: 1.0,
  windFullMs: 7.0,
  shoreSplatCells: 8,
  minScoreToShow: 0.12
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
    var depth = parseFloat(feat.properties && feat.properties.syvyyskayra_m);
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
    var range = parseBandRange(feat.properties && feat.properties.syvyysvali_m);
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

// ---------- syvyysruudukko ja indeksi ----------
export function buildAnalysis(input) {
  var contours = input.contours || [];
  var bands = input.bands || [];
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
  contours.forEach(function (c) {
    c.lines.forEach(function (line) {
      for (var i = 0; i < line.length; i++) {
        var p = line[i];
        if (p[0] < west - 0.01 || p[0] > east + 0.01 || p[1] < south - 0.01 || p[1] > north + 0.01) continue;
        points.push({ x: p[0], y: p[1], d: c.d });
      }
    });
  });
  if (points.length > 8000) {
    var stride = Math.ceil(points.length / 8000);
    points = points.filter(function (_, i) { return i % stride === 0; });
  }
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

  var maxDistM = Math.max(400, cellM * 6);
  var maxRing = Math.ceil(maxDistM / binM);

  function idw(lon, lat) {
    var bx = Math.floor((lon - west) / binLon);
    var by = Math.floor((lat - south) / binLat);
    var found = [];
    for (var ring = 0; ring <= maxRing; ring++) {
      for (var dx = -ring; dx <= ring; dx++) {
        for (var dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          var arr = bins.get((bx + dx) + ':' + (by + dy));
          if (arr) found = found.concat(arr);
        }
      }
      if (found.length >= 6 && ring >= 1) break;
    }
    if (!found.length) return NaN;
    var num = 0, den = 0, count = 0;
    for (var i = 0; i < found.length; i++) {
      var p = found[i];
      var dxm = (p.x - lon) * mPerLon;
      var dym = (p.y - lat) * mPerLat;
      var distSq = dxm * dxm + dym * dym;
      if (distSq > maxDistM * maxDistM) continue;
      if (distSq < 25) return p.d;
      var wgt = 1 / distSq;
      num += wgt * p.d;
      den += wgt;
      count++;
    }
    return count ? num / den : NaN;
  }

  // 3) vesimaski syvyysvyohykkeista (fallback: IDW-osumat)
  var useBands = bands.length > 0;
  var depth = new Float32Array(nx * ny);
  var mask = new Uint8Array(nx * ny);
  for (var gy = 0; gy < ny; gy++) {
    for (var gx = 0; gx < nx; gx++) {
      var lon = west + (gx + 0.5) * cellLon;
      var lat = south + (gy + 0.5) * cellLat;
      var idx = gy * nx + gx;
      var inWater = !useBands;
      if (useBands) {
        for (var b = 0; b < bands.length; b++) {
          var bb = bands[b].bbox;
          if (lon < bb[0] || lon > bb[2] || lat < bb[1] || lat > bb[3]) continue;
          if (pointInRings(lon, lat, bands[b].rings)) { inWater = true; break; }
        }
      }
      if (!inWater) { depth[idx] = NaN; continue; }
      var d = idw(lon, lat);
      depth[idx] = d;
      if (!isNaN(d)) mask[idx] = 1;
    }
  }

  // 4) gradientti erotusosamaaralla
  var slope = new Float32Array(nx * ny);
  for (gy = 0; gy < ny; gy++) {
    for (gx = 0; gx < nx; gx++) {
      idx = gy * nx + gx;
      if (!mask[idx]) continue;
      var dl = mask[gy * nx + Math.max(0, gx - 1)] ? depth[gy * nx + Math.max(0, gx - 1)] : depth[idx];
      var dr = mask[gy * nx + Math.min(nx - 1, gx + 1)] ? depth[gy * nx + Math.min(nx - 1, gx + 1)] : depth[idx];
      var dd = mask[Math.max(0, gy - 1) * nx + gx] ? depth[Math.max(0, gy - 1) * nx + gx] : depth[idx];
      var du = mask[Math.min(ny - 1, gy + 1) * nx + gx] ? depth[Math.min(ny - 1, gy + 1) * nx + gx] : depth[idx];
      var gxm = (dr - dl) / (2 * cellM);
      var gym = (du - dd) / (2 * cellM);
      slope[idx] = Math.sqrt(gxm * gxm + gym * gym);
    }
  }

  // 5) tuulialtistus: 0-kayrat rantaviivana, normaali . tuulivektori
  var windExp = new Float32Array(nx * ny);
  var windScale = 0;
  if (wind && isFinite(wind.speed) && isFinite(wind.direction)) {
    windScale = Math.max(0, Math.min(1, (wind.speed - weights.windMinMs) / (weights.windFullMs - weights.windMinMs)));
  }
  if (windScale > 0) {
    var windToRad = ((wind.direction + 180) % 360) * Math.PI / 180;
    var wvx = Math.sin(windToRad);
    var wvy = Math.cos(windToRad);
    var splatR = weights.shoreSplatCells;
    contours.forEach(function (c) {
      if (c.d !== 0) return;
      c.lines.forEach(function (line) {
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
              var val = facing * (1 - dist / splatR);
              if (val > windExp[pidx]) windExp[pidx] = val;
            }
          }
        }
      });
    });
  }

  function sampleDepth(lon, lat) {
    var gx2 = Math.floor((lon - west) / cellLon);
    var gy2 = Math.floor((lat - south) / cellLat);
    if (gx2 < 0 || gx2 >= nx || gy2 < 0 || gy2 >= ny) return NaN;
    return depth[gy2 * nx + gx2];
  }

  // 6) yhdistetty indeksi; painot normalisoidaan aktiivisten signaalien yli
  var score = new Float32Array(nx * ny);
  var wSlope = weights.slope;
  var wWind = windScale > 0 ? weights.wind : 0;
  var wPref = weights.depthPref;
  var wSum = wSlope + wWind + wPref;
  var hasAny = false;
  for (idx = 0; idx < nx * ny; idx++) {
    if (!mask[idx]) continue;
    var slopeN = Math.min(1, slope[idx] / weights.slopeNormPerMeter);
    slopeN *= Math.min(1, Math.max(0, (depth[idx] - 0.8) / 1.7));
    var pref = depthPreference(depth[idx]);
    var s = (wSlope * slopeN + wWind * windExp[idx] * windScale + wPref * pref) / wSum;
    score[idx] = s;
    if (s >= weights.minScoreToShow) hasAny = true;
  }

  return {
    nx: nx, ny: ny, west: west, south: south, east: east, north: north,
    cellM: cellM, cellLon: cellLon, cellLat: cellLat,
    depth: depth, mask: mask, slope: slope, windExp: windExp, score: score,
    windScale: windScale, pointCount: points.length,
    hasData: true, hasScore: hasAny
  };
}

export function depthPreference(d) {
  if (isNaN(d) || d <= 0.5) return 0;
  if (d < 2.5) return (d - 0.5) / 2.0;
  if (d <= 6) return 1;
  if (d >= 12) return 0;
  return (12 - d) / 6;
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
