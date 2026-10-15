// Dropline guide engine — shared by the app (browser) and the Worker (watch shortcuts, alerts).
// Keep this file free of browser-only and Worker-only code.

/* =====================================================================
   SPECIES — rules of thumb for Ontario inland lakes (metres).
   phases: ice (Dec–Mar), spring (Apr–May), summer (Jun–Aug), fall (Sep–Nov)
   ws: standard-weight equation log10(g) = a + b·log10(TL mm); v = verified source
   ===================================================================== */
const SPECIES = [
 {k:'walleye',n:'Walleye',ara:['Walleye'],act:['Walleye'],col:'#C99A2E',spawn:[4],wind:1,ws:[-5.453,3.180,1],
  ph:{ice:[[4,9],'Edges of mid-lake humps and main-lake points. Best bite at dawn, dusk and after dark.'],
      spring:[[1,4],'After the spawn: rocky shoals, current near inflows, then nearby sand and mud flats.'],
      summer:[[5,10],'Breaklines off points and humps, mud-flat edges. They slide shallower in low light and on windy shores.'],
      fall:[[4,12],'Steep rocky breaks near deep water, following baitfish deeper as the water cools.']},
  id:'Glassy marble eye, white tip on the lower tail, no spots on the spiny dorsal fin. Sharp teeth.',
  cook:'Ontario’s favourite eating fish. Fillet, skin off, then shore-lunch style: dredge in seasoned flour or crushed crackers and pan-fry in butter and oil 2–3 min a side. Also excellent baked with lemon.'},
 {k:'sauger',n:'Sauger',ara:['Sauger'],act:['Sauger'],col:'#A88A3A',spawn:[4],wind:1,ws:[-5.492,3.187,0],
  ph:{ice:[[6,12],'Deeper than walleye; soft-bottom basin edges.'],spring:[[2,6],'River mouths and rocky current areas.'],summer:[[6,14],'Deep breaks and basin edges in murky water.'],fall:[[6,14],'Deep structure near current.']},
  id:'Like a walleye but with dark spots on the spiny dorsal fin and no white tail tip.',
  cook:'Cook exactly like walleye. Thinner fillets, so fry a little shorter.'},
 {k:'pike',n:'Northern pike',ara:['Northern Pike','Pikes'],act:['Northern Pike'],col:'#5E8C3A',spawn:[3,4],wind:1,ws:[-5.437,3.096,0],
  ph:{ice:[[1,5],'Weedy bays and the first drop-off outside them.'],spring:[[0.5,3],'Shallow, warming bays and marsh edges.'],summer:[[2,7],'Outside weed edges. The big ones go deeper and cooler.'],fall:[[2,8],'Remaining green weeds and points near deep water.']},
  id:'Long body, duck-bill snout, light bean-shaped spots on a dark green body.',
  cook:'Firm, white and mild. Watch for the Y-bones: fillet them out (look up “boneless pike fillet”), or score the fillet and fry so the small bones soften. Great in fish cakes. Big pike carry more mercury — keep the smaller ones to eat.'},
 {k:'muskie',n:'Muskellunge',ara:['Muskellunge'],act:['Muskellunge'],col:'#3D6B4F',spawn:[4,5],wind:1,ws:[-5.600,3.137,0],release:'Most anglers release muskie, and size limits are very high.',
  ph:{ice:null,spring:[[1,4],'Shallow, warming bays. Season is usually closed in spring — check your zone.'],summer:[[2,8],'Weed edges, rock reefs, and open water over basins.'],fall:[[3,10],'Points and breaks near deep water; the trophy season.']},
  id:'Like a pike but with dark bars or spots on a light body, and no scales on the lower half of the cheek.',
  cook:'Release. Muskie are slow-growing, high in mercury, and minimum sizes are usually over 100 cm.'},
 {k:'lmb',n:'Largemouth bass',ara:['Largemouth Bass'],act:['Largemouth Bass','Centrarchidae','Sunfishes'],col:'#7A9A2E',spawn:[5,6],wind:0,ws:[-5.528,3.273,0],
  ph:{ice:[[3,6],'Deepest weed edges in bays.'],spring:[[0.5,2.5],'Shallow, soft-bottom bays as they warm. Season usually opens late June.'],summer:[[1,4],'Thick weeds, docks, lily pads, fallen trees.'],fall:[[2,5],'Weed edges near the first drop-off.']},
  id:'Jaw extends past the eye; dark side stripe; the two dorsal fins are nearly split.',
  cook:'Mild white fillets. Skin them (the skin tastes weedy) and fry or grill. Fish from warm, weedy water taste better in cooler months.'},
 {k:'smb',n:'Smallmouth bass',ara:['Smallmouth Bass'],act:['Smallmouth Bass','Centrarchidae','Sunfishes'],col:'#8C6D3A',spawn:[5,6],wind:1,ws:[-5.329,3.200,0],
  ph:{ice:[[6,12],'Deep rock and steep breaks; slow.'],spring:[[1.5,5],'Gravel and rock flats warming in the sun. Season usually opens late June.'],summer:[[3,8],'Rock humps, points, and boulder breaks.'],fall:[[5,12],'Steep rocky breaks; they school up deep.']},
  id:'Bronze with vertical bars; jaw stops below the eye; red eye.',
  cook:'Firm and clean-tasting. Skin off, then fry, grill or bake. One of the better-eating bass.'},
 {k:'rockbass',n:'Rock bass',ara:['Rock Bass'],act:['Rock Bass'],col:'#7A4E3A',spawn:[6],wind:0,ws:[-4.827,3.074,0],
  ph:{ice:[[3,6],'Rocky drop-offs.'],spring:[[1,3],'Rocky shorelines.'],summer:[[1,5],'Boulders, docks and rocky points.'],fall:[[2,6],'Rocky breaks.']},
  id:'Thick-bodied, red eye, rows of dark spots. Great first fish for kids.',
  cook:'Pan-fry whole (scaled and gutted) or in small fillets.'},
 {k:'crappie',n:'Black crappie',ara:['Black Crappie'],act:['Black Crappie','Centrarchidae','Sunfishes'],col:'#6E6E8C',spawn:[5,6],wind:0,ws:[-5.618,3.345,0],
  ph:{ice:[[4,9],'Suspended over the deepest basin; often mid-water.'],spring:[[0.5,2.5],'Shallow bays, reeds and fallen wood.'],summer:[[2,6],'Weed edges and wood; suspended at dusk.'],fall:[[3,8],'Moving to basins; schools up.']},
  id:'Flat, silvery with black speckles; 7–8 spines on the dorsal fin.',
  cook:'Sweet, flaky and delicate. Fillet and pan-fry lightly floured. Excellent eating.'},
 {k:'bluegill',n:'Bluegill',ara:['Bluegill'],act:['Blue Gill','Centrarchidae','Sunfishes'],col:'#3E7FA0',spawn:[6],wind:0,ws:[-5.374,3.316,0],
  ph:{ice:[[2,6],'Weed edges in bays.'],spring:[[0.5,2],'Warm, shallow bays.'],summer:[[1,4],'Weeds and docks; nests in sand in June.'],fall:[[2,5],'Weed edges.']},
  id:'Dark ear flap with no colour edge; faint vertical bars.',
  cook:'Pan-fry whole or as tiny fillets. Sweet and mild; a great kids’ fish.'},
 {k:'pumpkinseed',n:'Pumpkinseed',ara:['Pumpkinseed'],act:['Pumpkinseed','Centrarchidae','Sunfishes'],col:'#D08A2E',spawn:[5,6],wind:0,ws:[-5.179,3.237,0],
  ph:{ice:[[1.5,5],'Weedy bays.'],spring:[[0.3,1.5],'Very shallow, warm shorelines.'],summer:[[0.5,3],'Docks and weeds right along shore.'],fall:[[1,4],'Weed edges.']},
  id:'Orange belly, blue squiggles on the face, red spot on the ear flap.',
  cook:'Same as bluegill — pan-fried whole.'},
 {k:'perch',n:'Yellow perch',ara:['Yellow Perch'],act:['Yellow Perch','Perches'],col:'#C9B230',spawn:[4,5],wind:1,ws:[-5.386,3.230,1],
  ph:{ice:[[3,10],'Soft-bottom flats and basin edges; schools roam.'],spring:[[1,4],'Shallow weeds and wood.'],summer:[[3,8],'Weed edges and sand-to-mud transitions.'],fall:[[3,9],'Deeper flats; big schools.']},
  id:'Yellow with 6–8 dark vertical bars; orange lower fins.',
  cook:'Among the best eating in Ontario. Fillet, dip in egg and breadcrumbs, quick fry.'},
 {k:'laker',n:'Lake trout',ara:['Lake Trout'],act:['Lake Trout','Salmonidae'],col:'#4B6E8C',spawn:[10],wind:0,cold:1,ws:[-5.681,3.246,0],
  ph:{ice:[[8,30],'Points and humps near deep water; they cruise high under the ice.'],spring:[[2,10],'Right after ice-out they feed shallow near shore.'],summer:[[15,35],'Deep, cold water below the thermocline.'],fall:[[3,12],'Rocky shoals for spawning — most zones close the season in fall.']},
  id:'Deeply forked tail, light spots on a dark grey-green body.',
  cook:'Rich, oily flesh. Grill, bake or smoke. Larger lake trout can carry more mercury — keep the smaller ones.'},
 {k:'brookie',n:'Brook trout',ara:['Brook Trout'],act:['Brook Trout','Salmonidae'],col:'#A04A3A',spawn:[10],wind:0,cold:1,ws:[-5.186,3.103,0],
  ph:{ice:[[1,5],'Shallow shorelines and spring inflows.'],spring:[[0.5,4],'Shallow shorelines feeding on insects.'],summer:[[4,10],'Cold springs and deep, cool water.'],fall:[[1,4],'Spawning shoals and inflows; often closed.']},
  id:'Worm-like marks on the back, red spots with blue halos, white-edged lower fins.',
  cook:'Delicate. Cook whole in a pan with butter or over the fire wrapped in foil.'},
 {k:'rainbow',n:'Rainbow trout',ara:['Rainbow Trout'],act:['Rainbow Trout','Salmonidae'],col:'#C06A8C',spawn:[4],wind:0,cold:1,ws:[-4.898,2.990,1],
  ph:{ice:[[2,8],'Near shore and points.'],spring:[[1,5],'Inflows and shorelines.'],summer:[[6,20],'Cool water near the thermocline.'],fall:[[2,8],'Moving shallower as it cools.']},
  id:'Pink side stripe, small black spots over the body and tail.',
  cook:'Bake, grill or pan-fry whole. Mild and rich.'},
 {k:'brown',n:'Brown trout',ara:['Brown Trout'],act:['Brown Trout','Salmonidae'],col:'#8C5A2E',spawn:[10,11],wind:0,cold:1,ws:[-5.422,3.194,1],
  ph:{ice:[[2,6],'Shallow shorelines.'],spring:[[1,5],'Warming shorelines and inflows.'],summer:[[6,15],'Cool, deeper water; shallow at night.'],fall:[[2,8],'Heading to spawning streams.']},
  id:'Black and red spots, often with pale halos; little or no spotting on the tail.',
  cook:'Like rainbow trout. Great smoked.'},
 {k:'splake',n:'Splake',ara:['Splake'],act:['Salmonidae'],col:'#5A7A8C',spawn:[10],wind:0,cold:1,ws:[-5.186,3.103,0],
  ph:{ice:[[2,10],'Shorelines and points; very active under the ice.'],spring:[[1,6],'Shallow after ice-out.'],summer:[[8,20],'Cool, deep water.'],fall:[[2,8],'Rocky shorelines.']},
  id:'Brook × lake trout hybrid: brook-trout markings with a slightly forked tail.',
  cook:'Pan-fry or bake like brook trout.'},
 {k:'chinook',n:'Chinook salmon',ara:['Chinook Salmon'],act:['Chinook Salmon','Salmonidae'],col:'#6A7A9A',spawn:[9,10],wind:0,cold:1,ws:[-5.15,3.07,0],
  ph:{ice:null,spring:[[3,15],'Near shore where warm water meets cold.'],summer:[[15,35],'Deep, cold water off shore.'],fall:[[1,5],'Staging at river mouths before running.']},
  id:'Black gums, small spots on the back and the whole tail.',
  cook:'Grill or bake. Great Lakes fish have stricter consumption limits — check the guide for the exact area.'},
 {k:'coho',n:'Coho salmon',ara:['Coho Salmon'],act:['Coho Salmon','Salmonidae'],col:'#7A8AA0',spawn:[10],wind:0,cold:1,ws:[-5.1,3.05,0],
  ph:{ice:null,spring:[[2,10],'Near shore in warmer water.'],summer:[[10,25],'Off shore, cool water.'],fall:[[1,5],'River mouths.']},
  id:'White gums, spots only on the upper half of the tail.',
  cook:'Like chinook. Milder flavour.'},
 {k:'whitefish',n:'Lake whitefish',ara:['Lake Whitefish'],act:['Lake Whitefish'],col:'#9AA6A0',spawn:[11],wind:0,cold:1,ws:[-5.38,3.18,0],
  ph:{ice:[[10,25],'Soft-bottom basins; a classic ice-fishing target.'],spring:[[5,15],'Mid-depth flats.'],summer:[[15,30],'Deep, cold water.'],fall:[[5,15],'Moving to rocky spawning shoals.']},
  id:'Silver, small mouth tucked under a rounded snout, forked tail.',
  cook:'Superb smoked; also pan-fried. Mild and flaky.'},
 {k:'catfish',n:'Channel catfish',ara:['Channel Catfish'],act:[],col:'#5A5A6E',spawn:[6,7],wind:0,ws:[-5.800,3.294,0],
  ph:{ice:[[5,12],'Deep holes.'],spring:[[1,4],'Warming shallows and river mouths.'],summer:[[2,6],'Holes and wood; feed in the shallows at night.'],fall:[[3,8],'Deep holes.']},
  id:'Whiskers, forked tail, small dark spots on younger fish.',
  cook:'Skin, then fry in cornmeal. Smaller ones taste best.'},
 {k:'bullhead',n:'Brown bullhead',ara:['Brown Bullhead'],act:['Brown Bullhead'],col:'#6E5A3A',spawn:[5,6],wind:0,ws:[-5.084,3.115,0],
  ph:{ice:[[2,6],'Soft-bottom bays.'],spring:[[0.5,2],'Warm, muddy bays.'],summer:[[1,4],'Soft bottoms; best after dark.'],fall:[[1,4],'Bays.']},
  id:'Whiskers, square tail, mottled brown. Watch the sharp fin spines.',
  cook:'Skin, then fry. Sweet, tender meat.'},
 {k:'carp',n:'Common carp',ara:['Common Carp'],act:['Common Carp'],col:'#B08A4A',spawn:[6],wind:0,ws:[-4.639,2.920,0],
  ph:{ice:[[3,8],'Deep, soft-bottom basins; sluggish.'],spring:[[0.5,2],'Shallow, warm bays and marshes.'],summer:[[1,4],'Shallow flats; look for muddy water and bubbles.'],fall:[[2,5],'Moving deeper.']},
  id:'Large scales, two pairs of barbels at the mouth.',
  cook:'Mostly a catch-and-release sport fish here. If keeping one, it’s best smoked or in fish cakes.'},
 {k:'drum',n:'Freshwater drum',ara:['Freshwater Drum'],act:[],col:'#9A9AA6',spawn:[6],wind:1,ws:[-5.111,3.110,0],
  ph:{ice:[[5,12],'Deep basins.'],spring:[[2,6],'Mid-depth flats.'],summer:[[3,8],'Mussel beds and soft flats.'],fall:[[4,10],'Deep flats.']},
  id:'Silver, humped back, long dorsal fin, rounded tail. Croaks when landed.',
  cook:'Firm and mild; fry or use in chowder.'},
 {k:'burbot',n:'Burbot',ara:['Burbot'],act:['Burbot'],col:'#6A5A4A',spawn:[2],wind:0,cold:1,ws:[-4.868,2.898,1],
  ph:{ice:[[6,20],'Rocky humps and flats at night — the classic late-winter target.'],spring:[[10,25],'Deep.'],summer:[[15,35],'Deep and cold.'],fall:[[10,25],'Deep rock.']},
  id:'Eel-like, single chin barbel, mottled. Freshwater cod.',
  cook:'“Poor man’s lobster”: boil chunks in salted water and dip in butter. Firm, sweet meat.'},
 {k:'sturgeon',n:'Lake sturgeon',ara:['Lake Sturgeon'],act:[],col:'#555',protected:1,ws:null,ph:{},
  id:'Shark-like tail, rows of bony plates, shovel snout.',
  cook:'Protected or heavily restricted in most of Ontario. Release gently.'},
 {k:'eel',n:'American eel',ara:['American Eel'],act:[],col:'#555',protected:1,ws:null,ph:{},
  id:'Snake-like body with one long fin.',
  cook:'Endangered in Ontario. Keeping one is not permitted — release it.'},
];
const SP = Object.fromEntries(SPECIES.map(s => [s.k, s]));
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const phaseOf = m => (m === 12 || m <= 3) ? 'ice' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'fall';
function speciesFromAra(name) {
  return SPECIES.find(s => s.ara.some(a => a.toLowerCase() === name.toLowerCase()));
}

/* ===================== geo helpers ===================== */
const R = 6371000, D2R = Math.PI / 180;
function dist(a, b) { const x = (b.lng - a.lng) * D2R * Math.cos((a.lat + b.lat) / 2 * D2R), y = (b.lat - a.lat) * D2R; return Math.sqrt(x * x + y * y) * R; }
function bearing(a, b) { const y = Math.sin((b.lng - a.lng) * D2R) * Math.cos(b.lat * D2R); const x = Math.cos(a.lat * D2R) * Math.sin(b.lat * D2R) - Math.sin(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.cos((b.lng - a.lng) * D2R); return (Math.atan2(y, x) / D2R + 360) % 360; }
const compass = d => ['N','NE','E','SE','S','SW','W','NW'][Math.round(((d % 360) + 360) % 360 / 45) % 8];
function centroidOfRing(r) { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return { lng: x / r.length, lat: y / r.length }; }

/* ===================== weight ===================== */
function estWeightKg(spKey, lengthCm) {
  const s = SP[spKey];
  if (!s || !s.ws || !lengthCm) return null;
  const ws = Math.pow(10, s.ws[0] + s.ws[1] * Math.log10(lengthCm * 10)) / 1000; // kg, good-condition fish
  return { kg: ws * 0.9, lo: ws * 0.78, hi: ws * 1.05, verified: !!s.ws[2] };
}

/* ===================== the guide engine =====================
   Combines: species seasonal depth range (rules of thumb), real depth
   contours (steep breaks score higher), government spawning areas
   (bonus just before / after spawning only), the crew's catches,
   and wind (windward shores for wind-loving species). */
function computeGuide(lake, spKey, month, wx, catches, opts = {}) {
  const sp = SP[spKey];
  const out = { sp, phase: phaseOf(month), spots: [], zone: [], notes: [] };
  if (!sp) return out;
  if (sp.protected) { out.notes.push(sp.cook); return out; }
  const prof = sp.ph[out.phase];
  if (!prof) { out.closed = true; out.notes.push(`${sp.n} usually aren’t fished at this time of year in Ontario.`); return out; }
  let [dmin, dmax] = prof[0];
  out.tip = prof[1];
  if (!sp.cold && lake.secchi) {
    if (lake.secchi >= 4) { dmin *= 1.2; dmax *= 1.25; out.notes.push('Clear water: fish tend to sit deeper and bite best in low light.'); }
    else if (lake.secchi < 1.5) { dmin *= 0.8; dmax *= 0.8; out.notes.push('Stained water: fish tend to sit shallower.'); }
  }
  const maxC = lake.contours.reduce((m, c) => Math.max(m, c.d), 0);
  const lakeMax = Math.max(lake.maxDepth || 0, maxC);
  if (lakeMax && dmin > lakeMax * 0.85) {
    out.notes.push(`This lake (max ${lakeMax.toFixed(1)} m) is shallower than where ${sp.n.toLowerCase()} usually sit now — fish the deepest water you can find.`);
    dmin = lakeMax * 0.6; dmax = lakeMax;
  }
  if (lakeMax && dmax > lakeMax) dmax = lakeMax; // never send people deeper than the lake goes
  out.range = [Math.round(dmin * 10) / 10, Math.round(dmax * 10) / 10];
  if (sp.spawn && sp.spawn.includes(month)) out.notes.push(`${sp.n} are spawning around now. Many zones close the season — check the regulations, and leave spawning fish alone.`);

  // local metric projection
  const lat0 = (lake.bbox[1] + lake.bbox[3]) / 2, lng0 = (lake.bbox[0] + lake.bbox[2]) / 2;
  const kx = Math.cos(lat0 * D2R) * 111320, ky = 110540;
  const P = (lng, lat) => [(lng - lng0) * kx, (lat - lat0) * ky];

  // resample every contour to even spacing, then build a spatial grid
  let totalLen = 0;
  const projected = lake.contours.map(c => { const pts = c.c.map(([lng, lat]) => P(lng, lat)); for (let i = 1; i < pts.length; i++) totalLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return pts; });
  const STEP = Math.max(20, totalLen / 150000);
  const CELL = 60, grid = new Map(), cand = [];
  lake.contours.forEach((c, ci) => {
    const inRange = c.d >= dmin && c.d <= dmax;
    if (inRange) out.zone.push(c);
    const pts = projected[ci];
    const add = (x, y) => {
      const v = { x, y, d: c.d, lng: lng0 + x / kx, lat: lat0 + y / ky }, key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
      (grid.get(key) || grid.set(key, []).get(key)).push(v);
      if (inRange) cand.push(v);
    };
    add(...pts[0]);
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay);
      let t = STEP - carry;
      while (t <= L) { add(ax + (bx - ax) * t / L, ay + (by - ay) * t / L); t += STEP; }
      carry = L - (t - STEP);
    }
  });
  // spawning areas relevant just before / after the spawn
  const spawnPts = [];
  if (sp.spawn) {
    const near = sp.spawn.some(m => Math.abs(m - month) === 1 || Math.abs(m - month) === 11);
    if (near) for (const a of lake.activity) if (sp.act.some(n => a.type.startsWith(n))) for (const poly of a.polys) { const c = centroidOfRing(poly[0]); spawnPts.push(P(c.lng, c.lat)); }
    if (spawnPts.length) out.notes.push('Staging near known spawning areas is weighted higher this month.');
  }
  const crewPts = catches.filter(c => c.species === spKey && c.lat != null).map(c => P(c.lng, c.lat));
  let windVec = null;
  if (sp.wind && wx && wx.wind >= 12) {
    const toward = (wx.windDir + 180) * D2R; windVec = [Math.sin(toward), Math.cos(toward)];
    out.notes.push(`Wind ${Math.round(wx.wind)} km/h from the ${compass(wx.windDir)}: shores and points on the ${compass(wx.windDir + 180)} side get pushed bait — worth a look.`);
  }
  const W = Math.max((lake.bbox[2] - lake.bbox[0]) * kx, (lake.bbox[3] - lake.bbox[1]) * ky) / 2 || 1;

  const stride = Math.max(1, Math.floor(cand.length / (opts.maxCandidates || 40000)));
  const scored = [];
  for (let i = 0; i < cand.length; i += stride) {
    const v = cand[i];
    const gx = Math.floor(v.x / CELL), gy = Math.floor(v.y / CELL);
    let steep = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const cell = grid.get(`${gx + dx},${gy + dy}`); if (!cell) continue;
      for (const u of cell) {
        const dd = Math.abs(u.d - v.d); if (dd < 1) continue;
        const dm = Math.hypot(u.x - v.x, u.y - v.y); if (dm > 80) continue;
        steep = Math.max(steep, dd / Math.max(dm, 8));
      }
    }
    let score = 0.4 + Math.min(steep * 8, 4);
    for (const [sx, sy] of spawnPts) if (Math.hypot(sx - v.x, sy - v.y) < 400) { score += 2; break; }
    let crew = 0; for (const [cx, cy] of crewPts) if (Math.hypot(cx - v.x, cy - v.y) < 150) crew++;
    score += Math.min(crew * 1.5, 4.5);
    if (windVec) score += Math.max(0, (v.x * windVec[0] + v.y * windVec[1]) / W) * 1.2;
    scored.push({ ...v, score, steep, crew });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    if (out.spots.length >= 8) break;
    if (out.spots.some(p => Math.hypot(p.x - s.x, p.y - s.y) < 220)) continue;
    const why = [];
    if (s.steep > 0.12) why.push('steep break'); else if (s.steep > 0.05) why.push('gentle drop-off'); else why.push('right depth');
    if (s.crew) why.push(`${s.crew} crew catch${s.crew > 1 ? 'es' : ''} nearby`);
    out.spots.push({ lat: s.lat, lng: s.lng, depth: s.d, score: s.score, why: why.join(', '), x: s.x, y: s.y });
  }
  if (!lake.contours.length) out.notes.push('No depth map exists for this lake, so spots come only from crew catches and spawning areas. Use the depth range with a sonar or a weighted line.');
  return out;
}

/* ===================== weather ===================== */
async function fetchWeather(lat, lng) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lng.toFixed(3)}&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,precipitation_probability&past_days=1&forecast_days=3&timezone=auto&wind_speed_unit=kmh`;
  const r = await fetch(u); if (!r.ok) throw new Error('weather');
  const j = await r.json(); j.savedAt = Date.now(); return j;
}
function readWeather(raw) {
  if (!raw || !raw.hourly) return null;
  const h = raw.hourly, now = Date.now();
  const off = (raw.utc_offset_seconds || 0) * 1000; // Open-Meteo times are lake-local; convert so this works anywhere
  let i = h.time.findIndex(t => Date.parse(t + 'Z') - off > now) - 1;
  if (i < 0) i = h.time.length - 1;
  const p = h.pressure_msl, i3 = Math.max(0, i - 3);
  const trend = p[i] - p[i3];
  let read;
  if (trend <= -1) read = 'Pressure falling — angler rule of thumb: fish often feed harder ahead of a front.';
  else if (trend >= 1.5) read = 'Pressure rising fast after a front — fish tend to go quiet and tuck into cover. Slow down, fish tighter.';
  else read = 'Pressure steady — normal patterns should hold.';
  const stale = now - (raw.savedAt || now) > 6 * 3600e3;
  return { temp: h.temperature_2m[i], wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i], windDir: h.wind_direction_10m[i],
           pressure: p[i], trend, cloud: h.cloud_cover[i], rain: h.precipitation_probability[i], read, stale, savedAt: raw.savedAt };
}


/* ===================== spoken / typed species names (watch shortcuts) ===================== */
const SPOKEN = {
  pickerel: 'walleye', 'yellow pickerel': 'walleye', 'pike': 'pike', 'northern': 'pike', 'jack': 'pike', 'jackfish': 'pike',
  musky: 'muskie', muskie: 'muskie', 'largemouth': 'lmb', 'smallmouth': 'smb', 'bass': 'lmb', 'bronzeback': 'smb',
  crappie: 'crappie', 'speck': 'crappie', sunfish: 'pumpkinseed', sunny: 'pumpkinseed', 'perch': 'perch',
  laker: 'laker', 'lake trout': 'laker', 'speckled trout': 'brookie', 'speckle': 'brookie', brookie: 'brookie',
  steelhead: 'rainbow', rainbow: 'rainbow', 'king salmon': 'chinook', king: 'chinook', 'silver salmon': 'coho',
  whitefish: 'whitefish', catfish: 'catfish', bullhead: 'bullhead', mudcat: 'bullhead', carp: 'carp', sheepshead: 'drum',
  drum: 'drum', ling: 'burbot', lawyer: 'burbot', eelpout: 'burbot', sturgeon: 'sturgeon', eel: 'eel',
};
function matchSpecies(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  if (SP[t]) return SP[t];
  const exact = SPECIES.find(s => s.n.toLowerCase() === t); if (exact) return exact;
  const byName = SPECIES.find(s => t.includes(s.n.toLowerCase())); if (byName) return byName;
  const keys = Object.keys(SPOKEN).sort((a, b) => b.length - a.length);
  for (const k of keys) if (t.includes(k)) return SP[SPOKEN[k]];
  return SPECIES.find(s => s.n.toLowerCase().includes(t)) || null;
}

export { SPECIES, SP, MONTHS, phaseOf, speciesFromAra, R, D2R, dist, bearing, compass, centroidOfRing,
  estWeightKg, computeGuide, fetchWeather, readWeather, matchSpecies };
