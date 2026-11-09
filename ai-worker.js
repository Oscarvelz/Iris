// Iris AI worker: runs EmbeddingGemma 2 off the main thread so the app stays smooth.
const RT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-retrieval@1.2.0';
const CACHE = 'iris-model-v2';
const MAN = 'https://iris-model.invalid/eg2-tv440/manifest';
const key = (i) => 'https://iris-model.invalid/eg2-tv440/part/' + i;
let mp = null, emb = null, diag = '';

async function modelReader(blob) {
  if (blob) return blob.stream().getReader();
  const c = await caches.open(CACHE);
  const r = await c.match(MAN); if (!r) throw new Error('Model not downloaded');
  const m = await r.json(); let i = 0;
  return new ReadableStream({
    async pull(ctl) {
      if (i >= m.parts) return ctl.close();
      const p = await c.match(key(i));
      if (!p) { await c.delete(MAN); ctl.error(new Error('Part of the model is missing. Download it again.')); return; }
      ctl.enqueue(new Uint8Array(await p.arrayBuffer())); i++;
      postMessage({ progress: Math.round(i / m.parts * 100) });
    },
  }).getReader();
}
const out = (res) => { const e = res?.embeddings?.[0]; if (!e?.floatEmbedding) throw new Error('No embedding'); return Float32Array.from(e.floatEmbedding); };

async function createEmbedder(fileset, arg, delegate) {
  const baseOptions = { modelAssetBuffer: await modelReader(arg) };
  if (delegate) baseOptions.delegate = delegate;
  return mp.UniversalEmbedder.createFromOptions(fileset, { baseOptions, l2Normalize: true });
}

// Prove an embedder really works (a delegate can fail on first use, not at creation).
async function testEmbedder(e) {
  out(await e.embedText('iris delegate check'));
  const bmp = await createImageBitmap(new OffscreenCanvas(8, 8));
  try { out(await e.embedImage(bmp)); } finally { if (bmp.close) bmp.close(); }
}

onmessage = async ({ data }) => {
  const { id, op, arg } = data;
  try {
    let r = null;
    if (op === 'init') {
      if (!emb) {
        if (!mp) mp = await import(RT + '/retrieval_bundle.mjs');
        // Register the WASM factory OURSELVES first. History: as a MODULE worker (until 2.46),
        // MediaPipe's load dance left self.ModuleFactory unset in Oscar's WebView 156 —
        // 'ModuleFactory not set', silent page fallback — and pre-importing the module loader
        // ourselves (2.43) did not save it there either (his Diagnostics, 2026-11-09, still
        // '(page)'). So 2.47 goes back to the canonical pairing the PAGE path uses: this is a
        // CLASSIC worker now, and the classic loader registers the factory via importScripts,
        // the standard Emscripten way. diag records the factory state at each step and rides
        // the error back to the page's Diagnostics if init still fails — no more blind catch.
        try { importScripts(RT + '/wasm/retrieval_wasm_internal.js'); } catch (e) { diag += ' importScripts threw: ' + ((e && e.message) || e) + ';'; }
        diag += ' factory after importScripts: ' + typeof self.ModuleFactory + ';';
        const fileset = await mp.FilesetResolver.forRetrievalTasks(RT + '/wasm');
        diag += ' factory after fileset: ' + typeof self.ModuleFactory + ';';
        // GPU delegate test (2026-11-06): try GPU first and prove it with a real
        // text+image embed; on ANY failure, fall back to the exact CPU setup Iris
        // has always used. To undo this test, restore the single createEmbedder
        // call without a delegate.
        try {
          const g = await createEmbedder(fileset, arg, 'GPU');
          await testEmbedder(g);
          emb = g;
        } catch (gpuErr) {
          emb = await createEmbedder(fileset, arg);
        }
      }
    } else if (op === 'text') r = out(await emb.embedText(arg));
    else if (op === 'image') r = out(await emb.embedImage(arg));
    postMessage({ id, ok: true, r }, r ? [r.buffer] : []);
  } catch (e) {
    postMessage({ id, ok: false, err: ((e && e.message) || String(e)) + (diag ? ' {' + diag.trim() + '}' : '') });
  }
};
