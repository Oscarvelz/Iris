// Iris service worker: app shell + MediaPipe runtime cached for offline use.
// The AI model itself is cached by the app in the 'iris-model' cache.
const VERSION = 'iris-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('iris-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never intercept the big model download; the app manages it.
  if (url.hostname.endsWith('huggingface.co') || url.hostname.includes('hf.co') || url.hostname.includes('xethub')) return;
  // CDN runtime (wasm + js): cache-first, versioned URLs.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('iris-runtime').then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Network-first for the page so updates arrive; fall back to cache offline.
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
  }
});
