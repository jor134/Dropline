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

import { getVapid, sendPush } from './push.js';
import { SP, SPECIES, MONTHS, estWeightKg, computeGuide, fetchWeather, readWeather, matchSpecies, dist, bearing, compass, speciesFromAra } from '../public/guide.js';

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
      if (path === '/api/catches' && request.method === 'POST') {
        const r = await addCatch(env.DB, await request.json());
        if (r.ok && r.c.isNew) ctx.waitUntil(notifyCatch(env, r.c).catch(() => {}));
        return json(r.ok ? { ok: true, id: r.c.id } : { error: r.error }, r.ok ? 200 : r.status);
      }
      if (path === '/api/fishinfo') return json(await fishInfo(env, ctx));
      if (path.startsWith('/api/fishimg/')) return await fishImage(env, path.slice(13), ctx);
      if (path.startsWith('/api/fishphoto/') && request.method === 'POST') return await setFishPhoto(env, path.slice(15), request);
      if (path.startsWith('/api/fishphoto/') && request.method === 'DELETE') return await clearFishPhoto(env, path.slice(15));
      if (path === '/api/push/key') return json({ key: (await getVapid(env.DB)).pub });
      if (path === '/api/push/subscribe' && request.method === 'POST') return await pushSubscribe(env, request, url);
      if (path === '/api/push/unsubscribe' && request.method === 'POST') { const b = await request.json(); await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint || '')).run(); return json({ ok: true }); }
      if (path === '/api/push/test' && request.method === 'POST') return await pushTest(env, request);
      if (path === '/api/quick/catch' && request.method === 'POST') return await quickCatch(env, request, ctx);
      if (path === '/api/quick/where') return await quickWhere(env, request, url, ctx);
      if (path.startsWith('/api/catches/') && request.method === 'DELETE') return await deleteCatch(env.DB, path.slice(13), request);
      if (path.startsWith('/api/photo/')) return await getPhoto(env.DB, path.slice(11));
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    ctx.waitUntil(weatherAlerts(env));
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
  const b = await lakeBundleData(lid, ctx);
  if (!b) return json({ error: 'Lake not found' }, 404);
  return json(b);
}
async function lakeBundleData(lid, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://dropline.cache/lake/${BUNDLE_VERSION}/${lid}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const warnings = [];
  const ara = await arcQuery(LAYER.ara, {
    where: `WATERBODY_LID='${sqlStr(lid)}'`, outFields: '*', returnGeometry: 'true', maxAllowableOffset: '0.00004',
  });
  const feats = ara.features || [];
  if (!feats.length) return null;

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
  if (!warnings.length) {
    ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(bundle), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=604800' } })));
  }
  return bundle;
}

// ---------- fish photos (Wikipedia lead images, Wikimedia Commons licences) ----------
const FISH_TITLES = {
  walleye: 'Walleye', sauger: 'Sauger', pike: 'Northern pike', muskie: 'Muskellunge',
  lmb: 'Largemouth bass', smb: 'Smallmouth bass', rockbass: 'Rock bass', crappie: 'Black crappie',
  bluegill: 'Bluegill', pumpkinseed: 'Pumpkinseed', perch: 'Yellow perch', laker: 'Lake trout',
  brookie: 'Brook trout', rainbow: 'Rainbow trout', brown: 'Brown trout', splake: 'Splake',
  chinook: 'Chinook salmon', coho: 'Coho salmon', whitefish: 'Lake whitefish', catfish: 'Channel catfish',
  bullhead: 'Brown bullhead', carp: 'Common carp', drum: 'Freshwater drum', burbot: 'Burbot',
  sturgeon: 'Lake sturgeon', eel: 'American eel',
};
const WIKI_UA = 'Dropline/1.0 (private family fishing app on Cloudflare Workers)';
const FISH_CATALOG_VERSION = 1;
const stripHtml = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

async function wikiApi(params) {
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${p}`, {
    headers: { 'User-Agent': WIKI_UA, 'Api-User-Agent': WIKI_UA },
    cf: { cacheTtl: 2592000, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`Wikipedia error ${res.status}`);
  return res.json();
}

async function fishCatalog(ctx) {
  const cache = caches.default;
  const key = new Request(`https://dropline.cache/fishinfo/${FISH_CATALOG_VERSION}`);
  const hit = await cache.match(key);
  if (hit) return hit.json();

  // 1) lead image of each species article (handles redirects / normalised titles)
  const titles = Object.values(FISH_TITLES);
  const pg = await wikiApi({ redirects: '1', prop: 'pageimages', piprop: 'thumbnail|name', pithumbsize: '800', titles: titles.join('|') });
  const q = pg.query || {};
  const resolve = t => {
    for (const n of q.normalized || []) if (n.from === t) t = n.to;
    for (const r of q.redirects || []) if (r.from === t) t = r.to;
    return t;
  };
  const byTitle = new Map((q.pages || []).map(p => [p.title, p]));
  const out = {};
  for (const [k, t] of Object.entries(FISH_TITLES)) {
    const p = byTitle.get(resolve(t));
    if (p && p.thumbnail && p.pageimage) out[k] = { src: p.thumbnail.source, file: p.pageimage, page: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}` };
  }

  // 2) author + licence for each image file
  const files = [...new Set(Object.values(out).map(o => o.file))];
  if (files.length) {
    const ii = await wikiApi({ prop: 'imageinfo', iiprop: 'extmetadata', iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl',
      titles: files.map(f => `File:${f}`).join('|') });
    const meta = new Map();
    for (const p of (ii.query && ii.query.pages) || []) {
      const m = p.imageinfo && p.imageinfo[0] && p.imageinfo[0].extmetadata || {};
      meta.set(p.title.replace(/^File:/, '').replace(/ /g, '_'), {
        artist: stripHtml(m.Artist && m.Artist.value).slice(0, 120) || 'Unknown',
        license: stripHtml(m.LicenseShortName && m.LicenseShortName.value) || 'see source',
        licenseUrl: (m.LicenseUrl && m.LicenseUrl.value) || null,
      });
    }
    for (const o of Object.values(out)) {
      const m = meta.get(o.file.replace(/ /g, '_')) || {};
      Object.assign(o, m, { fileUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(o.file.replace(/ /g, '_'))}` });
    }
  }
  const data = { fish: out, fetchedAt: Date.now() };
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=2592000' } })));
  return data;
}

// Wikipedia catalogue merged with the crew's own photos (crew photos win)
async function fishInfo(env, ctx) {
  let wiki = {};
  try { wiki = (await fishCatalog(ctx)).fish; } catch (e) {}
  const out = {};
  for (const [k, f] of Object.entries(wiki)) out[k] = { ...f, v: 'w' + FISH_CATALOG_VERSION };
  const { results } = await env.DB.prepare('SELECT k, angler, updated_at FROM species_photos').all();
  for (const r of results) out[r.k] = { custom: true, artist: r.angler, license: 'crew photo', v: 'c' + r.updated_at, wiki: !!wiki[r.k] };
  return { fish: out };
}

async function fishImage(env, k, ctx) {
  if (!FISH_TITLES[k]) return new Response('Not found', { status: 404 });
  const own = await env.DB.prepare('SELECT mime, data FROM photos WHERE id = ?').bind('species:' + k).first();
  if (own) {
    const bin = Uint8Array.from(atob(own.data), c => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': own.mime, 'cache-control': 'private, max-age=2592000' } });
  }
  const { fish } = await fishCatalog(ctx);
  const f = fish[k];
  if (!f || !/^https:\/\/upload\.wikimedia\.org\//.test(f.src)) return new Response('No photo', { status: 404 });
  const res = await fetch(f.src, { headers: { 'User-Agent': WIKI_UA }, cf: { cacheTtl: 2592000, cacheEverything: true } });
  if (!res.ok) return new Response('Photo unavailable', { status: 502 });
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=2592000' } });
}

async function setFishPhoto(env, k, request) {
  if (!FISH_TITLES[k]) return json({ error: 'Unknown species' }, 404);
  const angler = (request.headers.get('X-Angler') || '').slice(0, 40);
  const b = await request.json();
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.photo || '');
  if (!m) return json({ error: 'Bad photo' }, 400);
  if (m[2].length > MAX_PHOTO_CHARS) return json({ error: 'Photo too large' }, 413);
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO photos (id, mime, data) VALUES (?, ?, ?)').bind('species:' + k, m[1], m[2]),
    env.DB.prepare('INSERT OR REPLACE INTO species_photos (k, angler, updated_at) VALUES (?, ?, ?)').bind(k, angler || 'Crew', Date.now()),
  ]);
  return json({ ok: true });
}
async function clearFishPhoto(env, k) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM photos WHERE id = ?').bind('species:' + k),
    env.DB.prepare('DELETE FROM species_photos WHERE k = ?').bind(k),
  ]);
  return json({ ok: true });
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
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, angler TEXT,
      lakes TEXT, catches INTEGER, weather INTEGER, created_at INTEGER, updated_at INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, sent_at INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS species_photos (k TEXT PRIMARY KEY, angler TEXT, updated_at INTEGER)`),
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

// returns { ok, c } or { ok:false, status, error }
async function addCatch(db, b) {
  const str = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));
  const num = v => (v === '' || v == null || !isFinite(+v) ? null : +v);
  if (!b.id || !/^[\w-]{8,64}$/.test(b.id)) return { ok: false, status: 400, error: 'Bad id' };
  if (!b.species || !b.angler) return { ok: false, status: 400, error: 'Species and angler are required' };
  let hasPhoto = 0;
  const stmts = [];
  if (b.photo) {
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.photo);
    if (!m) return { ok: false, status: 400, error: 'Bad photo' };
    if (m[2].length > MAX_PHOTO_CHARS) return { ok: false, status: 413, error: 'Photo too large' };
    stmts.push(db.prepare('INSERT OR IGNORE INTO photos (id, mime, data) VALUES (?, ?, ?)').bind(b.id, m[1], m[2]));
    hasPhoto = 1;
  }
  const c = {
    id: b.id, lid: str(b.lid, 20), lake: str(b.lake, 100), species: str(b.species, 40), angler: str(b.angler, 40),
    lat: num(b.lat), lng: num(b.lng), length_cm: num(b.length_cm), weight_kg: num(b.weight_kg), weight_est: b.weight_est ? 1 : 0,
    depth_m: num(b.depth_m), bait: str(b.bait, 120), notes: str(b.notes, 1000), released: b.released ? 1 : 0,
    caught_at: num(b.caught_at) || Date.now(), created_at: Date.now(), has_photo: hasPhoto,
  };
  const exists = await db.prepare('SELECT 1 FROM catches WHERE id = ?').bind(c.id).first();
  stmts.push(db.prepare(`INSERT OR IGNORE INTO catches (${CATCH_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    ...CATCH_COLS.split(',').map(k => c[k])));
  await db.batch(stmts);
  c.isNew = !exists;
  return { ok: true, c };
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

// ---------- notifications ----------
const text = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
const torontoNow = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', hour: 'numeric', month: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { hour: +p.hour, month: +p.month };
};
async function pushSubject(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'origin'").first();
  return row ? row.value : 'mailto:dropline@example.com';
}

async function pushSubscribe(env, request, url) {
  const b = await request.json();
  if (!b.endpoint || !/^https:\/\//.test(b.endpoint) || !b.keys || !b.keys.p256dh || !b.keys.auth) return json({ error: 'Bad subscription' }, 400);
  const lakes = (Array.isArray(b.lakes) ? b.lakes : []).slice(0, 30).map(l => ({
    lid: String(l.lid).slice(0, 20), name: String(l.name || '').slice(0, 100), lat: +l.lat, lng: +l.lng }));
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('origin', ?)").bind(url.origin),
    env.DB.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, angler, lakes, catches, weather, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth, angler=excluded.angler,
      lakes=excluded.lakes, catches=excluded.catches, weather=excluded.weather, updated_at=excluded.updated_at`)
      .bind(b.endpoint, b.keys.p256dh, b.keys.auth, String(b.angler || '').slice(0, 40), JSON.stringify(lakes),
        b.prefs && b.prefs.catches === false ? 0 : 1, b.prefs && b.prefs.weather === false ? 0 : 1, Date.now(), Date.now()),
  ]);
  return json({ ok: true, lakes: lakes.length });
}

async function pushTest(env, request) {
  const b = await request.json();
  const sub = await env.DB.prepare('SELECT * FROM push_subs WHERE endpoint = ?').bind(String(b.endpoint || '')).first();
  if (!sub) return json({ error: 'Turn alerts on first' }, 404);
  const r = await sendPush(sub, { title: 'Dropline alerts are on', body: 'You’ll hear about crew catches and weather on your saved lakes.', url: '/', tag: 'test' },
    await getVapid(env.DB), await pushSubject(env));
  if (r === 'gone') await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(sub.endpoint).run();
  return r === 'ok' ? json({ ok: true }) : json({ error: 'The notification service refused the test. Try turning alerts off and on again.' }, 502);
}

async function fanOut(env, subs, payload) {
  if (!subs.length) return;
  const vapid = await getVapid(env.DB), subject = await pushSubject(env);
  const results = await Promise.allSettled(subs.map(s => sendPush(s, payload, vapid, subject)));
  const gone = subs.filter((s, i) => results[i].status === 'fulfilled' && results[i].value === 'gone');
  if (gone.length) await env.DB.batch(gone.map(s => env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(s.endpoint)));
}

async function notifyCatch(env, c) {
  if (!c.lid) return;
  const { results } = await env.DB.prepare(`SELECT * FROM push_subs WHERE catches = 1 AND lakes LIKE ?`).bind(`%"lid":"${c.lid}"%`).all();
  const subs = results.filter(s => (s.angler || '').toLowerCase() !== (c.angler || '').toLowerCase());
  const sp = SP[c.species];
  const what = `${c.length_cm ? Math.round(c.length_cm) + ' cm ' : ''}${sp ? sp.n.toLowerCase() : c.species}`;
  await fanOut(env, subs, {
    title: `${c.angler} caught a ${what}`,
    body: [c.lake, c.released ? 'released' : null, c.depth_m ? `${c.depth_m} m deep` : null, c.bait].filter(Boolean).join(' · '),
    url: `/?lake=${encodeURIComponent(c.lid)}&view=log`, tag: `catch-${c.id}`,
  });
}

async function weatherAlerts(env) {
  const { hour } = torontoNow();
  if (hour < 6 || hour > 20) return; // quiet hours
  const { results } = await env.DB.prepare('SELECT * FROM push_subs WHERE weather = 1').all();
  const lakes = new Map();
  for (const s of results) for (const l of JSON.parse(s.lakes || '[]')) {
    if (!isFinite(l.lat) || !isFinite(l.lng)) continue;
    if (!lakes.has(l.lid)) lakes.set(l.lid, { ...l, subs: [] });
    lakes.get(l.lid).subs.push(s);
  }
  for (const lake of [...lakes.values()].slice(0, 40)) {
    let raw;
    try { raw = await fetchWeather(lake.lat, lake.lng); } catch (e) { continue; }
    const h = raw.hourly, off = (raw.utc_offset_seconds || 0) * 1000, now = Date.now();
    let i = h.time.findIndex(t => Date.parse(t + 'Z') - off > now) - 1;
    if (i < 0) continue;
    const next = n => h.time.slice(i, i + n + 1).map((t, k) => ({ t, p: h.pressure_msl[i + k], g: h.wind_gusts_10m[i + k] }));
    const six = next(6);
    const drop = six[0].p - Math.min(...six.map(x => x.p));
    const gust = six.reduce((m, x) => (x.g > m.g ? x : m), six[0]);
    const alerts = [];
    if (drop >= 3) alerts.push({ type: 'pressure', title: `Pressure dropping on ${lake.name}`,
      body: `Down about ${drop.toFixed(0)} hPa over the next few hours. Angler rule of thumb: fish often feed harder ahead of a front.` });
    if (gust.g >= 40) alerts.push({ type: 'gusts', urgent: true, title: `Strong gusts on ${lake.name}`,
      body: `Gusts up to ${Math.round(gust.g)} km/h around ${gust.t.slice(11, 16)}. Rough water for small boats — plan to be off the lake.` });
    for (const a of alerts) {
      const key = `${lake.lid}:${a.type}`;
      const last = await env.DB.prepare('SELECT sent_at FROM alerts WHERE key = ?').bind(key).first();
      if (last && now - last.sent_at < 12 * 3600e3) continue;
      await env.DB.prepare('INSERT OR REPLACE INTO alerts (key, sent_at) VALUES (?, ?)').bind(key, now).run();
      await fanOut(env, lake.subs, { ...a, url: `/?lake=${encodeURIComponent(lake.lid)}&view=map`, tag: `${a.type}-${lake.lid}` });
    }
  }
}

// ---------- Apple Watch shortcuts ----------
async function detectLake(lat, lng) {
  const d = await arcQuery(LAYER.ara, {
    where: 'OFFICIAL_WATERBODY_NAME IS NOT NULL', outFields: 'OFFICIAL_WATERBODY_NAME,WATERBODY_LID', returnGeometry: 'true',
    maxAllowableOffset: '0.0002', geometry: `${lng},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', distance: '400', units: 'esriSRUnit_Meter', resultRecordCount: '20',
  }, 3600);
  const fs = (d.features || []).filter(f => f.properties && f.properties.WATERBODY_LID);
  if (!fs.length) return null;
  const inside = fs.find(f => polysOf(f.geometry).some(rings => inPolygon([lng, lat], rings)));
  const f = inside || fs[0];
  return { lid: f.properties.WATERBODY_LID, name: f.properties.OFFICIAL_WATERBODY_NAME, onShore: !inside };
}
async function readBody(request) {
  const t = request.headers.get('content-type') || '';
  if (t.includes('application/json')) return request.json();
  if (t.includes('form')) return Object.fromEntries(await request.formData());
  try { return JSON.parse(await request.text()); } catch (e) { return {}; }
}
const yes = v => /^(y|yes|true|1|released|release)/i.test(String(v || '').trim());
const firstNum = v => { const m = String(v ?? '').replace(',', '.').match(/\d+(\.\d+)?/); return m ? +m[0] : null; };
const metres = d => d < 1000 ? `${Math.round(d / 10) * 10} metres` : `${(d / 1000).toFixed(1)} kilometres`;
const COMPASS_WORDS = { N: 'north', NE: 'north-east', E: 'east', SE: 'south-east', S: 'south', SW: 'south-west', W: 'west', NW: 'north-west' };

async function quickCatch(env, request, ctx) {
  const b = await readBody(request);
  const sp = matchSpecies(b.species);
  if (!sp) return text(`I didn't recognise "${String(b.species || '').slice(0, 40)}". Try walleye, pike, bass, perch, crappie or trout.`, 400);
  const angler = String(b.angler || b.name || '').trim();
  if (!angler) return text('Add your name to the shortcut first.', 400);
  const lat = firstNum(b.lat ?? b.latitude), lng = b.lng ?? b.longitude;
  const lngN = lng == null ? null : parseFloat(String(lng).replace(',', '.'));
  let lake = null;
  if (lat != null && isFinite(lngN)) { try { lake = await detectLake(lat, lngN); } catch (e) {} }
  const len = firstNum(b.length ?? b.length_cm);
  const est = len ? estWeightKg(sp.k, len) : null;
  const r = await addCatch(env.DB, {
    id: crypto.randomUUID(), lid: lake && lake.lid, lake: lake ? lake.name : null, species: sp.k, angler,
    lat, lng: lngN, length_cm: len, weight_kg: est ? Math.round(est.kg * 100) / 100 : null, weight_est: !!est,
    depth_m: firstNum(b.depth), bait: b.bait ? String(b.bait) : null, notes: b.notes ? String(b.notes) : 'Logged from Apple Watch',
    released: yes(b.released), caught_at: Date.now(),
  });
  if (!r.ok) return text(r.error, r.status);
  ctx.waitUntil(notifyCatch(env, r.c).catch(() => {}));
  let msg = `Logged ${len ? Math.round(len) + ' centimetre ' : ''}${sp.n.toLowerCase()}`;
  msg += lake ? ` on ${lake.name}.` : '. I couldn’t tell which lake you’re on, so it’s saved without one.';
  if (est) msg += ` About ${est.kg.toFixed(1)} kilos.`;
  if (sp.protected) msg += ' This one’s protected — please release it.';
  return text(msg);
}

async function quickWhere(env, request, url, ctx) {
  const lat = firstNum(url.searchParams.get('lat')), lngS = url.searchParams.get('lng');
  const lng = lngS == null ? NaN : parseFloat(lngS.replace(',', '.'));
  if (lat == null || !isFinite(lng)) return text('I need your location. Check the shortcut has Get Current Location.', 400);
  const lake = await detectLake(lat, lng).catch(() => null);
  if (!lake) return text('You don’t seem to be on a mapped Ontario lake.');
  const bundle = await lakeBundleData(lake.lid, ctx);
  if (!bundle) return text(`I found ${lake.name} but couldn’t load its map.`);
  const { results: catches } = await env.DB.prepare('SELECT species, lat, lng FROM catches WHERE lid = ?').bind(lake.lid).all();
  let sp = matchSpecies(url.searchParams.get('species'));
  if (!sp) {
    const counts = {}; for (const c of catches) counts[c.species] = (counts[c.species] || 0) + 1;
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    sp = top ? SP[top[0]] : (bundle.species.map(speciesFromAra).find(s => s && !s.protected) || SP.walleye);
  }
  let wx = null;
  try { wx = readWeather(await fetchWeather(lat, lng)); } catch (e) {}
  const { month } = torontoNow();
  const g = computeGuide(bundle, sp.k, month, wx, catches);
  const parts = [`${sp.n} on ${bundle.name} in ${['January','February','March','April','May','June','July','August','September','October','November','December'][month - 1]}.`];
  if (g.closed || !g.range) parts.push(g.notes[0] || 'No guide for this one right now.');
  else {
    parts.push(`Fish ${g.range[0]} to ${g.range[1]} metres.`);
    const me = { lat, lng };
    const near = g.spots.map(s => ({ ...s, d: dist(me, s) })).sort((a, b) => a.d - b.d)[0];
    if (near) parts.push(`Nearest likely spot: ${metres(near.d)} ${COMPASS_WORDS[compass(bearing(me, near))]}, ${near.depth} metres, ${near.why}.`);
    else parts.push(g.tip);
  }
  if (wx) parts.push(`Wind ${Math.round(wx.wind)} km/h from the ${COMPASS_WORDS[compass(wx.windDir)]}. Pressure ${wx.trend <= -1 ? 'falling' : wx.trend >= 1.5 ? 'rising fast' : 'steady'}.`);
  return text(parts.join(' '));
}
