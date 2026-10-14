// Dropline service worker: app shell offline. Lake data lives in IndexedDB (saved by the app).
const SHELL = 'dropline-shell-v1';
const FONTS = 'dropline-fonts-v1';
const SHELL_FILES = [
  '/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => ![SHELL, FONTS].includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

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

  // Everything else in the shell: cache first
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
});
