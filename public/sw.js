// Dropline service worker: app shell offline. Lake data lives in IndexedDB (saved by the app).
const SHELL = 'dropline-shell-v3';
const FONTS = 'dropline-fonts-v1';
const FISH = 'dropline-fish-v1';
const SHELL_FILES = [
  '/', '/index.html', '/guide.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, FONTS, FISH].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Fish photos: keep once seen so the fish guide works offline (keyed without the group code)
  if (url.pathname.startsWith('/api/fishimg/')) {
    const key = new Request(url.origin + url.pathname);
    e.respondWith(caches.open(FISH).then(async c => {
      const hit = await c.match(key); if (hit) return hit;
      const res = await fetch(req); if (res.ok) c.put(key, res.clone()); return res;
    }));
    return;
  }

  // API, weather and map tiles: always network (the app handles offline itself)
  if (url.pathname.startsWith('/api/') || url.hostname.endsWith('open-meteo.com') || url.hostname.endsWith('openstreetmap.org')) return;

  // Fonts: cache as they're used
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async c => {
      const hit = await c.match(req); if (hit) return hit;
      const res = await fetch(req); if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res;
    }));
    return;
  }

  // Page: network first so updates arrive, cache fallback offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => { caches.open(SHELL).then(c => c.put('/', res.clone())); return res; })
      .catch(() => caches.match('/')));
    return;
  }

  // Our own files: serve the cached copy instantly, refresh it in the background for next launch
  if (url.origin === self.location.origin) {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req);
      const fresh = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
    return;
  }
  // CDN files: cache first
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});

// ---- alerts ----
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Dropline', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Dropline', {
    body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { w.postMessage({ type: 'open', url }); return w.focus(); } }
    return self.clients.openWindow(url);
  })());
});
self.addEventListener('pushsubscriptionchange', () => {}); // the app re-syncs its subscription each time it opens
