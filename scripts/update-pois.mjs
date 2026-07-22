#!/usr/bin/env node
// Lataa Suomen karttakohteet (nuotiopaikat, laavut, bensa-asemat, terassit)
// staattisiksi tiedostoiksi pois/-hakemistoon. Appi lataa nama suoraan omalta
// palvelimelta eika riipu Overpassin saatavuudesta ajon aikana.
//
// Lahteet:
//   geofabrik (oletus): lataa Geofabrikin Suomi-ekstraktin (~700 MB, valimuistiin
//     scripts/.cache/) ja suodattaa sen osmium-tyokalulla. Vaatii osmiumin
//     (brew install osmium-tool / apt install osmium-tool). Luotettavin reitti.
//   overpass: hakee suoraan Overpass-rajapinnasta. Ei riippuvuuksia, mutta
//     Overpassin saatavuus vaihtelee.
//
// Ajo:      node scripts/update-pois.mjs
//           node scripts/update-pois.mjs --source overpass
// Rajattu:  node scripts/update-pois.mjs --source overpass --bbox 60.0,24.0,60.5,25.5  (S,W,N,E)
//
// Tuloste:
//   pois/index.json     { version, generated, cellLatDeg, cellLonDeg, kinds, cells }
//   pois/p_<la>_<lo>.json  taulukko: [kindIdx, lat, lon, name?, operator?, opening_hours?, website?]
// Solu on 0.5° x 1.0° (~55 x 55 km Suomen leveysasteilla).

import { mkdir, readdir, unlink, writeFile, stat } from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { execFileSync } from 'child_process';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pois');
const CELL_LAT = 0.5;
const CELL_LON = 1.0;
const KINDS = ['firepit', 'shelter', 'fuel', 'terrace', 'slipway', 'marina', 'water', 'mooring'];
const FILTERS = [
  '[leisure=firepit]',
  '[amenity=bbq]',
  '[tourism=wilderness_hut]',
  '[tourism=picnic_site][shelter]',
  '[amenity=shelter]',
  '[amenity=fuel]',
  '[waterway=fuel]',
  '[outdoor_seating=yes]',
  '[amenity=biergarten]',
  '[leisure=outdoor_seating]',
  '[leisure=slipway]',
  '[leisure=marina]',
  '[amenity=drinking_water]',
  '[mooring]',
  '["seamark:type"=anchorage]'
];
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

// Sama luokittelu kuin sovelluksen poiKind()-funktiossa (index.html), paitsi:
// picnic_site vaatii shelter-tagin (kuten sovelluksen Overpass-kysely vaati),
// muuten mukaan tulisi tuhansia kattamattomia levahdyspaikkoja "laavuina".
function poiKind(tags) {
  if (!tags) return null;
  if (tags.leisure === 'firepit' || tags.amenity === 'bbq') return 'firepit';
  if (tags.tourism === 'picnic_site') return tags.shelter && tags.shelter !== 'no' ? 'shelter' : null;
  if (tags.tourism === 'wilderness_hut' ||
    (tags.amenity === 'shelter' && (!tags.shelter_type || tags.shelter_type !== 'public_transport'))) return 'shelter';
  if (tags.leisure === 'slipway') return 'slipway';
  if (tags.leisure === 'marina') return 'marina';
  if (tags.amenity === 'drinking_water') return 'water';
  if (tags['seamark:type'] === 'anchorage' ||
    (tags.mooring && tags.mooring !== 'no' && tags.mooring !== 'private')) return 'mooring';
  if (tags.amenity === 'fuel' || tags.waterway === 'fuel') return 'fuel';
  if (tags.leisure === 'outdoor_seating' || tags.amenity === 'biergarten' || tags.outdoor_seating === 'yes') return 'terrace';
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryOverpass(filter, bbox) {
  const scope = bbox
    ? `nwr(${bbox})${filter};`
    : `area["ISO3166-1"="FI"][admin_level=2]->.fi;nwr(area.fi)${filter};`;
  const query = `[out:json][timeout:300];${scope}out center tags;`;
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
          signal: AbortSignal.timeout(320000)
        });
        if (res.status === 429 || res.status === 504) {
          console.log(`  ${endpoint} -> ${res.status}, odotetaan 15 s`);
          await sleep(15000);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (e) {
        lastError = e;
        console.log(`  ${endpoint} epäonnistui (${e.message}), kokeillaan seuraavaa`);
        await sleep(3000);
      }
    }
  }
  throw lastError || new Error('kaikki Overpass-päätepisteet epäonnistuivat');
}

function slimFromTags(tags, lat, lon, kindIdx) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) return null;
  const slim = [
    kindIdx,
    Math.round(lat * 1e5) / 1e5,
    Math.round(lon * 1e5) / 1e5,
    tags.name || tags['name:fi'] || null,
    tags.operator || null,
    tags.opening_hours || null,
    tags.website && /^https?:\/\//i.test(tags.website) ? tags.website : null
  ];
  while (slim.length > 3 && slim[slim.length - 1] == null) slim.pop();
  return slim;
}

// ---------- lahde: Overpass ----------
async function collectFromOverpass(bbox) {
  console.log(bbox ? `Overpass, bbox ${bbox}` : 'Overpass, koko Suomi (area FI)');
  const byId = new Map();
  for (const filter of FILTERS) {
    process.stdout.write(`Kysely ${filter} ... `);
    const data = await queryOverpass(filter, bbox);
    let added = 0;
    for (const el of data.elements || []) {
      const key = el.type + '/' + el.id;
      if (!byId.has(key)) {
        byId.set(key, el);
        added++;
      }
    }
    console.log(`${(data.elements || []).length} elementtiä (${added} uutta, yhteensä ${byId.size})`);
    await sleep(2000);
  }
  return [...byId.values()].map((el) => ({
    tags: el.tags || {},
    lat: el.lat ?? el.center?.lat,
    lon: el.lon ?? el.center?.lon
  }));
}

// ---------- lahde: Geofabrik + osmium ----------
const GEOFABRIK_URL = 'https://download.geofabrik.de/europe/finland-latest.osm.pbf';
const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache');
const PBF_MAX_AGE_MS = 24 * 3600 * 1000;

function geometryCentroid(geom) {
  if (!geom) return null;
  if (geom.type === 'Point') return { lat: geom.coordinates[1], lon: geom.coordinates[0] };
  let coords = geom.coordinates;
  if (geom.type === 'Polygon' || geom.type === 'MultiLineString') coords = coords.flat(1);
  else if (geom.type === 'MultiPolygon') coords = coords.flat(2);
  if (!Array.isArray(coords) || !coords.length || !Array.isArray(coords[0])) return null;
  let sumLat = 0, sumLon = 0;
  for (const p of coords) { sumLon += p[0]; sumLat += p[1]; }
  return { lat: sumLat / coords.length, lon: sumLon / coords.length };
}

async function collectFromGeofabrik() {
  try {
    execFileSync('osmium', ['--version'], { stdio: 'ignore' });
  } catch (e) {
    throw new Error('osmium-työkalua ei löydy (brew install osmium-tool) — tai aja --source overpass');
  }
  await mkdir(CACHE_DIR, { recursive: true });
  const pbfPath = path.join(CACHE_DIR, 'finland-latest.osm.pbf');
  let fresh = false;
  try {
    const info = await stat(pbfPath);
    fresh = Date.now() - info.mtimeMs < PBF_MAX_AGE_MS && info.size > 100 * 1024 * 1024;
  } catch (e) { /* ei valimuistissa */ }
  if (!fresh) {
    console.log(`Ladataan ${GEOFABRIK_URL} (~700 MB, kerran per vuorokausi)...`);
    const res = await fetch(GEOFABRIK_URL, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Geofabrik HTTP ${res.status}`);
    await pipeline(res.body, createWriteStream(pbfPath));
    console.log('Lataus valmis.');
  } else {
    console.log('Käytetään välimuistissa olevaa ekstraktia:', pbfPath);
  }

  const filteredPath = path.join(CACHE_DIR, 'pois-filtered.osm.pbf');
  const exportPath = path.join(CACHE_DIR, 'pois.geojsonseq');
  const tagFilters = [
    'nwr/leisure=firepit,outdoor_seating,slipway,marina',
    'nwr/amenity=bbq,shelter,fuel,biergarten,drinking_water',
    'nwr/tourism=wilderness_hut,picnic_site', 'nwr/waterway=fuel', 'nwr/outdoor_seating=yes',
    'nwr/mooring', 'nwr/seamark:type=anchorage'
  ];
  console.log('Suodatetaan osmiumilla...');
  execFileSync('osmium', ['tags-filter', pbfPath, ...tagFilters, '-o', filteredPath, '--overwrite'], { stdio: 'inherit' });
  execFileSync('osmium', ['export', filteredPath, '-f', 'geojsonseq', '-o', exportPath, '--overwrite'], { stdio: 'inherit' });

  const elements = [];
  const rl = readline.createInterface({ input: createReadStream(exportPath) });
  for await (const line of rl) {
    const clean = line.replace(/^\x1e/, '').trim();
    if (!clean) continue;
    let feature;
    try { feature = JSON.parse(clean); } catch (e) { continue; }
    const centroid = geometryCentroid(feature.geometry);
    if (!centroid) continue;
    elements.push({ tags: feature.properties || {}, lat: centroid.lat, lon: centroid.lon });
  }
  console.log(`Ekstraktista ${elements.length} ehdokasta.`);
  return elements;
}

async function main() {
  const bboxArg = process.argv.indexOf('--bbox');
  const bbox = bboxArg !== -1 ? process.argv[bboxArg + 1] : null;
  const sourceArg = process.argv.indexOf('--source');
  const source = sourceArg !== -1 ? process.argv[sourceArg + 1] : 'geofabrik';

  const elements = source === 'overpass' ? await collectFromOverpass(bbox) : await collectFromGeofabrik();

  const cells = new Map();
  const kindCounts = Object.fromEntries(KINDS.map((k) => [k, 0]));
  let skipped = 0;
  for (const el of elements) {
    const kind = poiKind(el.tags);
    if (!kind) { skipped++; continue; }
    const slim = slimFromTags(el.tags, el.lat, el.lon, KINDS.indexOf(kind));
    if (!slim) { skipped++; continue; }
    kindCounts[kind]++;
    const cellKey = `p_${Math.floor(slim[1] / CELL_LAT)}_${Math.floor(slim[2] / CELL_LON)}`;
    if (!cells.has(cellKey)) cells.set(cellKey, []);
    cells.get(cellKey).push(slim);
  }

  await mkdir(OUT_DIR, { recursive: true });
  for (const file of await readdir(OUT_DIR).catch(() => [])) {
    if (/^p_-?\d+_-?\d+\.json$/.test(file) || file === 'index.json') await unlink(path.join(OUT_DIR, file));
  }

  const index = {
    version: 1,
    generated: new Date().toISOString(),
    cellLatDeg: CELL_LAT,
    cellLonDeg: CELL_LON,
    kinds: KINDS,
    cells: {}
  };
  let totalBytes = 0;
  for (const [cellKey, elements] of [...cells.entries()].sort()) {
    elements.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
    const body = JSON.stringify(elements);
    totalBytes += body.length;
    await writeFile(path.join(OUT_DIR, cellKey + '.json'), body);
    index.cells[cellKey] = elements.length;
  }
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1));

  const total = Object.values(kindCounts).reduce((a, b) => a + b, 0);
  console.log(`\nValmis: ${total} kohdetta ${cells.size} soluun, ${(totalBytes / 1048576).toFixed(1)} MB`);
  console.log('Luokat:', JSON.stringify(kindCounts));
  console.log(`Ohitettu (ei luokkaa / ei koordinaattia): ${skipped}`);
}

main().catch((e) => {
  console.error('Virhe:', e.message);
  process.exit(1);
});
