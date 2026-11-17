// Iris service worker: app shell + MediaPipe runtime cached for offline use.
// The AI model itself is cached by the app in the 'iris-model' cache.
const VERSION = 'iris-v85';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png', './ai-worker.js', './prep-worker.js'];

self.addEventListener('install', (e) => {
  // Cache the shell entry by entry (P-4): addAll was all-or-nothing, so ONE missing file in a
  // deploy (a skipped icon, a renamed manifest) made the installing worker redundant and every
  // future update failed the same silent way forever. Now a failed entry is collected, the rest
  // still cache, the worker still activates — and the page is told what is missing, so the fact
  // reaches Diagnostics instead of stranding the app on an old version without a word.
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    const failed = [];
    await Promise.all(SHELL.map(async (u) => { try { await c.add(u); } catch { failed.push(u); } }));
    if (failed.length) { const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' }); for (const cl of cs) cl.postMessage({ type: 'sw-shell-missing', version: VERSION, failed }); }
    await self.skipWaiting();
  })());
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

// Is this body plausibly the runtime file that was asked for (R3-P3)? A resolved 200
// can still carry the WRONG bytes — an edge error page or truncated content under a
// success status — and round 2's handler cached it over the known-good runtime, so the
// offline fallback it built was itself poisoned. The runtime is code or WASM, never a
// document: a response that declares itself HTML, or whose first non-space character
// opens markup, is not the runtime however it is labelled. Anything we cannot inspect
// is NOT distrusted on our own failure — the check must never break a healthy update.
async function plausibleRuntime(res) {
  try { const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : ''; if (/text\/html/i.test(ct)) return false; } catch {}
  let head = null;
  try {
    const body = res.clone().body;
    if (typeof body === 'string') head = body.slice(0, 512);
    else if (body && typeof body.getReader === 'function') {
      const rd = body.getReader(); const dec = new TextDecoder(); let s = '';
      for (let n = 0; n < 4 && !/\S/.test(s); n++) { const { done, value } = await rd.read(); if (done) break; s += dec.decode(value, { stream: true }); }
      try { rd.cancel(); } catch {}
      head = s;
    }
  } catch {}
  if (head === null) { try { if (typeof res.body === 'string') head = res.body.slice(0, 512); } catch {} }
  if (head === null) return true;
  return !head.trimStart().startsWith('<');
}

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
      // A resolved-but-bad response is CDN trouble too (R2-P3): a jsdelivr 5xx during an
      // outage, or a 404 after a package move, used to be served raw while a good cached
      // runtime sat unused — the fallback now answers on ANY unusable response whenever a
      // cached copy exists, and the error is served only when there is nothing cached.
      // "Unusable" includes a 200 with the wrong body (R3-P3, plausibleRuntime above):
      // it is never written over the known-good copy, and the cached copy answers in its
      // place; with nothing cached the suspect body is served — there is nothing better
      // — but it is still not cached, so it cannot become the fallback.
      try { const res = await fetch(e.request); if (res.ok) { if (await plausibleRuntime(res)) { c.put(e.request, res.clone()); return res; } const hit = await c.match(e.request); if (hit) return hit; return res; } const hit = await c.match(e.request); if (hit) return hit; return res; }
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
