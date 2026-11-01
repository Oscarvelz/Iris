// Iris AI worker: runs EmbeddingGemma 2 off the main thread so the app stays smooth.
const RT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-retrieval@1.2.0';
const CACHE = 'iris-model-v2';
const MAN = 'https://iris-model.invalid/eg2-tv440/manifest';
const key = (i) => 'https://iris-model.invalid/eg2-tv440/part/' + i;
let mp = null, emb = null;

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

onmessage = async ({ data }) => {
  const { id, op, arg } = data;
  try {
    let r = null;
    if (op === 'init') {
      if (!emb) {
        if (!mp) mp = await import(RT + '/retrieval_bundle.mjs');
        const fileset = await mp.FilesetResolver.forRetrievalTasks(RT + '/wasm', true);
        emb = await mp.UniversalEmbedder.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: await modelReader(arg) }, l2Normalize: true });
      }
    } else if (op === 'text') r = out(await emb.embedText(arg));
    else if (op === 'image') r = out(await emb.embedImage(arg));
    postMessage({ id, ok: true, r }, r ? [r.buffer] : []);
  } catch (e) {
    postMessage({ id, ok: false, err: (e && e.message) || String(e) });
  }
};
