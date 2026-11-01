// Iris prep worker: decodes photos, makes the AI copy + thumbnail, and measures sharpness/brightness,
// all off the main thread so scrolling and taps stay smooth while indexing.
// HEIC/HEIF (Samsung "High efficiency pictures", iPhone): browsers can't decode it, so use libheif (WASM), loaded only when needed.
const HEIF_URL = 'https://cdn.jsdelivr.net/npm/libheif-js@1.19.8/libheif-wasm/libheif-bundle.js';
let heif = null;
const isHeif = (f) => /\.(heic|heif)$/i.test(f.name || '') || /hei[cf]/i.test(f.type || '');
async function decodeHeif(file) {
  if (!heif) { importScripts(HEIF_URL); heif = self.libheif(); }
  const dec = new heif.HeifDecoder(); const imgs = dec.decode(new Uint8Array(await file.arrayBuffer()));
  if (!imgs || !imgs.length) throw new Error('empty HEIF');
  const im = imgs[0]; const w = im.get_width(), h = im.get_height();
  const data = await new Promise((res, rej) => im.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (r) => r ? res(r) : rej(new Error('HEIF decode failed'))));
  for (const i of imgs) try { i.free && i.free(); } catch {}
  try { dec.decoder && heif.heif_context_free && heif.heif_context_free(dec.decoder); } catch {}
  return createImageBitmap(new ImageData(data.data, w, h));
}
async function bitmap(file) {
  try { return await createImageBitmap(file); }
  catch (e) { if (isHeif(file)) return decodeHeif(file); throw new Error('can’t decode ' + (file.type || file.name) + ': ' + (e && e.message || e)); }
}
// full-screen copy for the viewer (HEIC can't be shown directly)
async function big(file) {
  const bmp = await bitmap(file); const s = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
}
async function prep(file) {
  const bmp = await bitmap(file);
  const W = bmp.width, H = bmp.height; const s = Math.min(1, 640 / Math.max(W, H));
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
  return { bytes, thumb, w: W, h: H, bright, sharp, dh };
}
onmessage = async ({ data }) => {
  if (data.op === 'big') { try { postMessage({ id: data.id, p: await big(data.file), heavy: isHeif(data.file) ? 1 : 0 }); } catch (e) { postMessage({ id: data.id, p: null, err: String(e && e.message || e) }); } return; }
  try { const p = await prep(data.file); postMessage({ id: data.id, p, heavy: isHeif(data.file) ? 1 : 0 }, p ? [p.bytes.buffer] : []); }
  catch (e) { postMessage({ id: data.id, p: null, err: String(e && e.message || e), heavy: isHeif(data.file) ? 1 : 0 }); }
};
