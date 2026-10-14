// DROPLINE — Cloudflare Worker
// Serves the app (static assets) and a small API:
//   /api/ping               check group code
//   /api/lakes?q=&lat=&lng= search Ontario lakes (Aquatic Resource Areas)
//   /api/lake/:lid          lake bundle: facts, species, outline, depth contours, access points, spawning areas
//   /api/catches            GET list / POST new catch (shared group log)
//   /api/catches/:id        DELETE (only by the angler who logged it)
//   /api/photo/:id          catch photo
//
// Data: Ontario Land Information Ontario (LIO) open data, Open Government Licence – Ontario.

const LIO = 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA';
const LAYER = {
  ara: `${LIO}/LIO_Open07/MapServer/2`,       // ARA Water Poly Segment: lake facts + fish species
  bathy: `${LIO}/LIO_Open01/MapServer/30`,    // Bathymetry Line: depth contours
  access: `${LIO}/LIO_Open07/MapServer/15`,   // Fishing Access Point
  activity: `${LIO}/LIO_Open07/MapServer/31`, // Fish Activity Area: spawning / nursery areas
};
const BUNDLE_VERSION = 3;
const MAX_PHOTO_CHARS = 1_400_000; // ~1 MB image as base64

let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!env.GROUP_CODE) return json({ error: 'Server not configured: add a GROUP_CODE secret in Cloudflare.' }, 500);
      const code = request.headers.get('X-Group-Code') || url.searchParams.get('k') || '';
      if (!safeEqual(code, env.GROUP_CODE)) return json({ error: 'Wrong group code' }, 401);

      const path = url.pathname;
      if (path === '/api/ping') return json({ ok: true });
      if (path === '/api/lakes') return await searchLakes(url);
      if (path.startsWith('/api/lake/')) return await lakeBundle(decodeURIComponent(path.slice(10)), request, ctx);

      if (!env.DB) return json({ error: 'Server not configured: D1 database binding "DB" missing.' }, 500);
      await ensureSchema(env.DB);
      if (path === '/api/catches' && request.method === 'GET') return await listCatches(env.DB, url);
      if (path === '/api/catches' && request.method === 'POST') return await addCatch(env.DB, request);
      if (path.startsWith('/api/catches/') && request.method === 'DELETE') return await deleteCatch(env.DB, path.slice(13), request);
      if (path.startsWith('/api/photo/')) return await getPhoto(env.DB, path.slice(11));
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

// ---------- helpers ----------
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const sqlStr = s => String(s).replace(/'/g, "''");
const r5 = n => Math.round(n * 1e5) / 1e5;

async function arcQuery(layerUrl, params, ttl = 86400) {
  const p = new URLSearchParams({ f: 'geojson', outSR: '4326', ...params });
  const res = await fetch(`${layerUrl}/query?${p}`, { cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!res.ok) throw new Error(`Ontario data service error ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Ontario data service: ${data.error.message || 'query failed'}`);
  return data;
}

// Rings from a GeoJSON Polygon/MultiPolygon -> array of polygons (each = array of rings [[lng,lat],...])
function polysOf(geom) {
  if (!geom) return [];
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  return [];
}
function linesOf(geom) {
  if (!geom) return [];
  if (geom.type === 'LineString') return [geom.coordinates];
  if (geom.type === 'MultiLineString') return geom.coordinates;
  return [];
}
function bboxOf(points, bb = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (const [x, y] of points) {
    if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y;
    if (x > bb[2]) bb[2] = x; if (y > bb[3]) bb[3] = y;
  }
  return bb;
}
// even-odd test across all rings of one polygon (holes / islands handled)
function inPolygon(pt, rings) {
  let inside = false;
  const [x, y] = pt;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
const inLake = (pt, polys) => polys.some(rings => inPolygon(pt, rings));

// ---------- lake search ----------
async function searchLakes(url) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const lat = parseFloat(url.searchParams.get('lat'));
  const lng = parseFloat(url.searchParams.get('lng'));
  const near = Number.isFinite(lat) && Number.isFinite(lng);
  if (!q && !near) return json({ lakes: [] });

  const params = {
    outFields: 'OFFICIAL_WATERBODY_NAME,WATERBODY_LID,FISHERIES_MANAGEMENT_ZONE_ID,SURFACE_AREA,MAXIMUM_DEPTH,WATERBODY_ALIAS_NAME1',
    returnGeometry: 'true',
    maxAllowableOffset: '0.01',
    resultRecordCount: '120',
    where: q
      ? `UPPER(OFFICIAL_WATERBODY_NAME) LIKE '%${sqlStr(q.toUpperCase())}%' OR UPPER(WATERBODY_ALIAS_NAME1) LIKE '%${sqlStr(q.toUpperCase())}%'`
      : "OFFICIAL_WATERBODY_NAME IS NOT NULL",
  };
  if (near) Object.assign(params, {
    geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', distance: q ? '150000' : '25000', units: 'esriSRUnit_Meter',
  });
  const data = await arcQuery(LAYER.ara, params);

  const byLid = new Map();
  for (const f of data.features || []) {
    const a = f.properties || {};
    if (!a.WATERBODY_LID || !a.OFFICIAL_WATERBODY_NAME) continue;
    let e = byLid.get(a.WATERBODY_LID);
    if (!e) {
      e = { lid: a.WATERBODY_LID, name: a.OFFICIAL_WATERBODY_NAME, alias: a.WATERBODY_ALIAS_NAME1 || null,
            fmz: a.FISHERIES_MANAGEMENT_ZONE_ID, areaHa: a.SURFACE_AREA, maxDepth: a.MAXIMUM_DEPTH, bb: undefined };
      byLid.set(a.WATERBODY_LID, e);
    }
    for (const rings of polysOf(f.geometry)) for (const ring of rings) e.bb = bboxOf(ring, e.bb);
  }
  const lakes = [...byLid.values()].map(e => {
    const out = { ...e, lat: null, lng: null };
    if (e.bb && isFinite(e.bb[0])) { out.lng = r5((e.bb[0] + e.bb[2]) / 2); out.lat = r5((e.bb[1] + e.bb[3]) / 2); }
    if (near && out.lat != null) out.km = Math.round(haversine(lat, lng, out.lat, out.lng) / 100) / 10;
    delete out.bb;
    return out;
  });
  lakes.sort((a, b) => (a.km ?? 1e9) - (b.km ?? 1e9) || (b.areaHa || 0) - (a.areaHa || 0));
  return json({ lakes: lakes.slice(0, 40) });
}
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, t = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * t / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin((lng2 - lng1) * t / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- lake bundle ----------
async function lakeBundle(lid, request, ctx) {
  if (!/^[0-9A-Za-z-]{5,20}$/.test(lid)) return json({ error: 'Bad lake id' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://dropline.cache/lake/${BUNDLE_VERSION}/${lid}`);
  const hit = await cache.match(cacheKey);
  if (hit) return new Response(hit.body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-cache': 'hit' } });

  const warnings = [];
  const ara = await arcQuery(LAYER.ara, {
    where: `WATERBODY_LID='${sqlStr(lid)}'`, outFields: '*', returnGeometry: 'true', maxAllowableOffset: '0.00004',
  });
  const feats = ara.features || [];
  if (!feats.length) return json({ error: 'Lake not found' }, 404);

  // merge facts from the most recently updated record, species from all
  feats.sort((a, b) => (b.properties.EFFECTIVE_DATETIME || 0) - (a.properties.EFFECTIVE_DATETIME || 0));
  const a = feats[0].properties;
  const species = new Set();
  const polys = [];
  for (const f of feats) {
    for (const s of String(f.properties.FISH_SPECIES_SUMMARY || '').split(',')) if (s.trim()) species.add(s.trim());
    for (const rings of polysOf(f.geometry)) polys.push(rings.map(r => r.map(([x, y]) => [r5(x), r5(y)])));
  }
  let bb;
  for (const rings of polys) bb = bboxOf(rings[0] || [], bb);
  const env = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`;
  const envParams = { geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects' };

  // depth contours (paged)
  const contours = [];
  try {
    let offset = 0;
    for (let page = 0; page < 8; page++) {
      const d = await arcQuery(LAYER.bathy, { ...envParams, where: '1=1', outFields: 'DEPTH', orderByFields: 'OBJECTID',
        maxAllowableOffset: '0.00003', resultOffset: String(offset), resultRecordCount: '2000' });
      const fs = d.features || [];
      for (const f of fs) {
        const depth = f.properties && f.properties.DEPTH;
        if (depth == null) continue;
        for (const line of linesOf(f.geometry)) {
          if (line.length < 2) continue;
          const mid = line[Math.floor(line.length / 2)];
          if (!inLake(mid, polys)) continue;
          contours.push({ d: depth, c: line.map(([x, y]) => [r5(x), r5(y)]) });
        }
      }
      if (fs.length < 2000 && !d.exceededTransferLimit && !(d.properties && d.properties.exceededTransferLimit)) break;
      offset += fs.length;
      if (page === 7) warnings.push('Very large lake: only part of the depth map was loaded.');
    }
  } catch (e) { warnings.push('Depth contours unavailable right now.'); }

  // depth units sanity check: some older surveys were recorded in feet
  let depthUnit = 'm';
  const maxC = contours.reduce((m, c) => Math.max(m, c.d), 0);
  if (a.MAXIMUM_DEPTH > 0 && maxC > a.MAXIMUM_DEPTH * 2.2 && maxC <= a.MAXIMUM_DEPTH * 3.6) {
    for (const c of contours) c.d = Math.round(c.d * 0.3048 * 10) / 10;
    depthUnit = 'ft→m';
  }

  // access points (slightly larger box so shoreline launches are included)
  let access = [];
  try {
    const pad = 0.01;
    const d = await arcQuery(LAYER.access, { geometry: `${bb[0] - pad},${bb[1] - pad},${bb[2] + pad},${bb[3] + pad}`,
      geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', where: '1=1',
      outFields: 'SITE_NAME,FISHING_ACCESS_POINT_TYPE,PARKING_PRESENCE_FLG,USER_FEE_FLG,ACCESSIBILITY_FLG' });
    access = (d.features || []).filter(f => f.geometry && f.geometry.type === 'Point').map(f => ({
      lng: r5(f.geometry.coordinates[0]), lat: r5(f.geometry.coordinates[1]),
      name: f.properties.SITE_NAME || null, type: f.properties.FISHING_ACCESS_POINT_TYPE || 'Access',
      parking: f.properties.PARKING_PRESENCE_FLG || null, fee: f.properties.USER_FEE_FLG || null,
      accessible: f.properties.ACCESSIBILITY_FLG || null,
    }));
  } catch (e) { warnings.push('Access points unavailable right now.'); }

  // spawning & nursery areas
  let activity = [];
  try {
    const d = await arcQuery(LAYER.activity, { ...envParams, where: '1=1',
      outFields: 'FISH_ACTIVITY_TYPE,HABITAT_CLASS,OBSERVATION_DATE', maxAllowableOffset: '0.00004' });
    for (const f of d.features || []) {
      const ps = polysOf(f.geometry);
      if (!ps.length) continue;
      const touches = ps.some(rings => rings[0].some(pt => inLake(pt, polys)));
      if (!touches) continue;
      activity.push({
        type: f.properties.FISH_ACTIVITY_TYPE, habitat: f.properties.HABITAT_CLASS || null,
        observed: f.properties.OBSERVATION_DATE || null,
        polys: ps.map(rings => rings.map(r => r.map(([x, y]) => [r5(x), r5(y)]))),
      });
    }
  } catch (e) { warnings.push('Spawning areas unavailable right now.'); }

  const bundle = {
    v: BUNDLE_VERSION, lid, fetchedAt: Date.now(),
    name: a.OFFICIAL_WATERBODY_NAME, alias: a.WATERBODY_ALIAS_NAME1 || null,
    fmz: a.FISHERIES_MANAGEMENT_ZONE_ID, thermal: a.THERMAL_REGIME || null,
    areaHa: a.SURFACE_AREA, maxDepth: a.MAXIMUM_DEPTH, meanDepth: a.MEAN_DEPTH, secchi: a.SECCHI_DEPTH,
    comments: a.COMMENTS || null, species: [...species].sort(),
    bbox: bb.map(r5), outline: polys, contours, depthUnit, access, activity, warnings,
  };
  const body = JSON.stringify(bundle);
  if (!warnings.length) {
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=604800' } })));
  }
  return new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

// ---------- catches ----------
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS catches (
      id TEXT PRIMARY KEY, lid TEXT, lake TEXT, species TEXT, angler TEXT,
      lat REAL, lng REAL, length_cm REAL, weight_kg REAL, weight_est INTEGER, depth_m REAL,
      bait TEXT, notes TEXT, released INTEGER, caught_at INTEGER, created_at INTEGER, has_photo INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, mime TEXT, data TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_catches_lid ON catches(lid)`),
  ]);
  schemaReady = true;
}
const CATCH_COLS = 'id,lid,lake,species,angler,lat,lng,length_cm,weight_kg,weight_est,depth_m,bait,notes,released,caught_at,created_at,has_photo';

async function listCatches(db, url) {
  const lid = url.searchParams.get('lid');
  const stmt = lid
    ? db.prepare(`SELECT ${CATCH_COLS} FROM catches WHERE lid = ? ORDER BY caught_at DESC LIMIT 2000`).bind(lid)
    : db.prepare(`SELECT ${CATCH_COLS} FROM catches ORDER BY caught_at DESC LIMIT 2000`);
  const { results } = await stmt.all();
  return json({ catches: results });
}

async function addCatch(db, request) {
  const b = await request.json();
  const str = (v, n) => (v == null ? null : String(v).slice(0, n));
  const num = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
  if (!b.id || !/^[\w-]{8,64}$/.test(b.id)) return json({ error: 'Bad id' }, 400);
  if (!b.species || !b.angler) return json({ error: 'Species and angler are required' }, 400);
  let hasPhoto = 0;
  const stmts = [];
  if (b.photo) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.photo);
    if (!m) return json({ error: 'Bad photo' }, 400);
    if (m[2].length > MAX_PHOTO_CHARS) return json({ error: 'Photo too large' }, 413);
    stmts.push(db.prepare('INSERT OR IGNORE INTO photos (id, mime, data) VALUES (?, ?, ?)').bind(b.id, m[1], m[2]));
    hasPhoto = 1;
  }
  stmts.push(db.prepare(`INSERT OR IGNORE INTO catches (${CATCH_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    b.id, str(b.lid, 20), str(b.lake, 100), str(b.species, 40), str(b.angler, 40),
    num(b.lat), num(b.lng), num(b.length_cm), num(b.weight_kg), b.weight_est ? 1 : 0, num(b.depth_m),
    str(b.bait, 120), str(b.notes, 1000), b.released ? 1 : 0, num(b.caught_at) || Date.now(), Date.now(), hasPhoto));
  await db.batch(stmts);
  return json({ ok: true, id: b.id });
}

async function deleteCatch(db, id, request) {
  const angler = request.headers.get('X-Angler') || '';
  const row = await db.prepare('SELECT angler FROM catches WHERE id = ?').bind(id).first();
  if (!row) return json({ ok: true });
  if (row.angler.toLowerCase() !== angler.toLowerCase()) return json({ error: 'Only the person who logged this catch can delete it' }, 403);
  await db.batch([
    db.prepare('DELETE FROM catches WHERE id = ?').bind(id),
    db.prepare('DELETE FROM photos WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

async function getPhoto(db, id) {
  const row = await db.prepare('SELECT mime, data FROM photos WHERE id = ?').bind(id).first();
  if (!row) return new Response('Not found', { status: 404 });
  const bin = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=31536000, immutable' } });
}
