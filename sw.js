// Iris service worker: app shell + MediaPipe runtime cached for offline use.
// The AI model itself is cached by the app in the 'iris-model' cache.
const VERSION = 'iris-v104';
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
      // A runtime cache inherited from an older worker gets one honest audit (R4-PS1):
      // a worker from before plausibleRuntime could have cached an impostor body into
      // the shared 'iris-runtime-2', and this worker would otherwise inherit it as its
      // known-good fallback. A cached entry that fails the same check a fresh response
      // must pass is provably not the runtime — code or WASM is never HTML, JSON or
      // empty — so it is dropped; everything plausible is kept untouched (version skew
      // of genuine code is undetectable in principle and stays out of scope).
      .then(async () => { try { const rc = await caches.open('iris-runtime-2'); for (const req of await rc.keys()) { const hit = await rc.match(req); if (hit && !(await plausibleRuntime(hit))) await rc.delete(req); } } catch {} })
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
// Nor is it only documents (R4-P2): an edge's JSON error payload and an empty body
// under a 200 are not the runtime either, so a JSON content type, a body whose first
// non-space character opens a JSON value, and a body that inspects as empty all fail
// the same way. When in doubt the handler falls back to the cached copy, never to the
// network body — and a body we cannot inspect at all is still trusted, as before.
async function plausibleRuntime(res) {
  try { const ct = res.headers && typeof res.headers.get === 'function' ? (res.headers.get('content-type') || '') : ''; if (/text\/html|application\/json|\+json/i.test(ct)) return false; } catch {}
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
  const t = head.trimStart();
  if (!t) return false;
  return !t.startsWith('<') && !t.startsWith('{') && !t.startsWith('[');
}

// A cache write that fails is a fact the page should hear about (the sw-shell-missing
// channel's younger sibling): quota and cache-API failures otherwise vanish into the
// worker's own console, and the app would go on believing its offline fallback is
// whole. Fire-and-forget — a notification must never break the fetch it rides on.
async function notePutFail(url) {
  try { const cs = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' }); for (const cl of cs) cl.postMessage({ type: 'sw-put-failed', version: VERSION, url }); } catch {}
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
      // The put is part of this event's own lifetime now (R3-PS2, settled in round 5):
      // it used to be fired detached — called, never awaited, never waitUntil'd — so a
      // worker terminated inside the write's completion lost a fully-received runtime
      // body, and the first-ever fetch of a runtime file (the one with no cached
      // backstop) was exactly the fetch that could lose it. The clone is still taken
      // synchronously, before the response is returned; the write itself is registered
      // with waitUntil, so the worker lives until it lands, and a failure is reported
      // to the page instead of swallowed.
      try { const res = await fetch(e.request); if (res.ok) { if (await plausibleRuntime(res)) { const copy = res.clone(); e.waitUntil(c.put(e.request, copy).catch(() => notePutFail(e.request.url))); return res; } const hit = await c.match(e.request); if (hit) return hit; return res; } const hit = await c.match(e.request); if (hit) return hit; return res; }
      catch { const hit = await c.match(e.request); if (hit) return hit; throw new Error('offline and not cached'); }
    }));
    return;
  }
  if (url.origin === location.origin) {
    // Network-first for the page so updates arrive; fall back to cache offline.
    // The refresh put is rebuilt to the CDN branch's standard (R5-P6): the clone is
    // taken synchronously, in the same breath as the response — it used to sit inside
    // a deferred caches.open().then(), by which time respondWith had taken the body
    // and clone() threw "Response body is already used" on EVERY request, so this
    // branch never wrote a single entry in its life and the version cache was written
    // by install's precache alone (a shell file that missed its precache could never
    // be cached by a later fetch — offline, it stayed missing forever). The write is
    // waitUntil-registered and its failures are reported to the page.
    e.respondWith(fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => notePutFail(e.request.url))); }
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
  }
});
