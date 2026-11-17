// Iris prep worker: decodes photos, makes the AI copy + thumbnail, and measures sharpness/brightness,
// all off the main thread so scrolling and taps stay smooth while indexing.
// HEIC/HEIF (Samsung "High efficiency pictures", iPhone): browsers can't decode it, so use libheif (WASM), loaded only when needed.
const HEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js';
let heif = null;
const isHeif = (f) => /\.(heic|heif)$/i.test(f.name || '') || /hei[cf]/i.test(f.type || '');
async function decodeHeif(file) {
  if (!heif) { importScripts(HEIF_URL); heif = self.libheif(); }
  // From here the library is in hand, so a failure inside the flagged region
  // is libheif ANSWERING with an error about the file, and the thrown error
  // carries lib: 1 so the answer can be told from the silence of a library
  // that never loaded (R9-PS2). The import above stays outside the region —
  // its failure carries no flag — and the file's bytes are read before it
  // too: a read failure is not the library's answer either.
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const dec = new heif.HeifDecoder(); const imgs = dec.decode(bytes);
    if (!imgs || !imgs.length) throw new Error('empty HEIF');
    const im = imgs[0]; const w = im.get_width(), h = im.get_height();
    const data = await new Promise((res, rej) => im.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (r) => r ? res(r) : rej(new Error('HEIF decode failed'))));
    for (const i of imgs) try { i.free && i.free(); } catch {}
    try { dec.decoder && heif.heif_context_free && heif.heif_context_free(dec.decoder); } catch {}
    return await createImageBitmap(new ImageData(data.data, w, h));
  } catch (e) { const err = new Error(e && e.message || e); err.lib = 1; throw err; }
}
// bitmap() also reports whether libheif did the decoding (lib): the browser's own
// decoder succeeding — above all on the shell's resized JPEG copy of a HEIC photo,
// which keeps the .heic name over JPEG bytes — says nothing about the library, and
// the page's HEIC circuit breaker may only credit an answer to the library that
// actually produced it (R7-P2). A failure reached BEFORE libheif — the import
// itself failing — carries no lib: the library never answered. But a failure
// INSIDE decodeHeif, after the library loaded, is flagged lib: 1 by decodeHeif
// itself (R9-PS2): the library answered with an error about the file, which
// ends the silence the breaker tripped on — the page credits the answering
// toward revival, while the decode still counts as failed for the photo.
async function bitmap(file) {
  try { return { bmp: await createImageBitmap(file), lib: 0 }; }
  catch (e) { if (isHeif(file)) return { bmp: await decodeHeif(file), lib: 1 }; throw new Error('can’t decode ' + (file.type || file.name) + ': ' + (e && e.message || e)); }
}
// full-screen copy for the viewer (HEIC can't be shown directly)
async function big(file) {
  const d = await bitmap(file); const bmp = d.bmp; const s = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return { p: await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 }), lib: d.lib };
}
async function prep(file, ow = 0, oh = 0) {
  const bd = await bitmap(file); const bmp = bd.bmp;
  const W = ow || bmp.width, H = oh || bmp.height; const s = Math.min(1, 640 / Math.max(W, H));
  const mw = Math.max(1, Math.round(W * s)), mh = Math.max(1, Math.round(H * s));
  const c = new OffscreenCanvas(mw, mh); c.getContext('2d').drawImage(bmp, 0, 0, mw, mh); bmp.close();
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.88 })).arrayBuffer());
  const ts = Math.min(1, 360 / Math.max(mw, mh));
  const tc = new OffscreenCanvas(Math.max(1, Math.round(mw * ts)), Math.max(1, Math.round(mh * ts)));
  tc.getContext('2d').drawImage(c, 0, 0, tc.width, tc.height);
  const thumb = await tc.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const as = 128 / Math.max(mw, mh); const aw = Math.max(8, Math.round(mw * as)), ah = Math.max(8, Math.round(mh * as));
  const ac = new OffscreenCanvas(aw, ah); const ax = ac.getContext('2d', { willReadFrequently: true }); ax.drawImage(c, 0, 0, aw, ah);
  const d = ax.getImageData(0, 0, aw, ah).data; const g = new Float32Array(aw * ah); let sum = 0;
  for (let i = 0; i < g.length; i++) { g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; sum += g[i]; }
  const bright = sum / g.length; let lm = 0, l2 = 0, n = 0;
  for (let y = 1; y < ah - 1; y++) for (let x = 1; x < aw - 1; x++) { const i = y * aw + x; const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - aw] - g[i + aw]; lm += l; l2 += l * l; n++; }
  const sharp = n ? l2 / n - (lm / n) ** 2 : 0;
  const hc = new OffscreenCanvas(9, 8); const hx = hc.getContext('2d', { willReadFrequently: true }); hx.drawImage(c, 0, 0, 9, 8);
  const hd = hx.getImageData(0, 0, 9, 8).data; let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const a = (y * 9 + x) * 4, b = a + 4; bits += (hd[a] + hd[a + 1] + hd[a + 2]) > (hd[b] + hd[b + 1] + hd[b + 2]) ? '1' : '0'; }
  const dh = BigInt('0b' + bits).toString(16).padStart(16, '0');
  return { bytes, thumb, w: W, h: H, bright, sharp, dh, lib: bd.lib };
}
onmessage = async ({ data }) => {
  if (data.op === 'big') { try { const r = await big(data.file); postMessage({ id: data.id, p: r.p, lib: r.lib, heavy: isHeif(data.file) ? 1 : 0 }); } catch (e) { postMessage({ id: data.id, p: null, err: String(e && e.message || e), ...(e && e.lib ? { lib: 1 } : {}) }); } return; }
  try { const p = await prep(data.file, data.ow, data.oh); const lib = p.lib || 0; delete p.lib; postMessage({ id: data.id, p, lib, heavy: isHeif(data.file) ? 1 : 0 }, p ? [p.bytes.buffer] : []); }
  catch (e) { postMessage({ id: data.id, p: null, err: String(e && e.message || e), ...(e && e.lib ? { lib: 1 } : {}), heavy: isHeif(data.file) ? 1 : 0 }); }
};
