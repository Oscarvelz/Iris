// Iris service worker: app shell + MediaPipe runtime cached for offline use.
// The AI model itself is cached by the app in the 'iris-model' cache.
const VERSION = 'iris-v65';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png', './ai-worker.js', './prep-worker.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    // 'iris-runtime' (unversioned, cache-first) is retired too: it accumulated entries since the
    // app's first days and is a suspect in the worker's 'ModuleFactory not set' failure — a bad
    // cached body for the WASM loader would be served forever. Its replacement is versioned.
    caches.keys().then((keys) => Promise.all(keys.filter((k) => (k.startsWith('iris-v') && k !== VERSION) || k === 'iris-runtime').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Never intercept the big model download; the app manages it.
  if (url.hostname.endsWith('huggingface.co') || url.hostname.includes('hf.co') || url.hostname.includes('xethub')) return;
  // CDN runtime (wasm + js): network-first, cache as the offline fallback — fresh code always
  // wins, so a bad cached body can never be served forever (the old cache-first 'iris-runtime'
  // is a suspect in the AI worker's 'ModuleFactory not set' failure on Oscar's phone).
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.open('iris-runtime-2').then(async (c) => {
      try { const res = await fetch(e.request); if (res.ok) c.put(e.request, res.clone()); return res; }
      catch { const hit = await c.match(e.request); if (hit) return hit; throw new Error('offline and not cached'); }
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
