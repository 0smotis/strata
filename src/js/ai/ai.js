// Local AI (transformers.js / onnxruntime-web) + Generative Fill via user-configured providers.
import { app } from '../state.js';
import { createCanvas, ctx2d, clamp, canvasToBytes, bytesToImage, alphaBounds } from '../util.js';
import { retouch } from '../engine/client.js';
import { toast } from '../ui/common.js';

const base = new URL('../../vendor/', import.meta.url).href;
let T = null;
async function tf() {
  if (T) return T;
  T = await import(base + 'transformers/transformers.min.js');
  T.env.allowLocalModels = false;
  T.env.useBrowserCache = true;
  T.env.backends.onnx.wasm.wasmPaths = base + 'transformers/';
  return T;
}
const device = async () => (app.settings.useGPU !== false && navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null))) ? 'webgpu' : 'wasm';
function progressCb(onProgress, label) {
  const files = {};
  return (p) => {
    if (p.status === 'progress' && p.total) { files[p.file] = [p.loaded, p.total]; const L = Object.values(files).reduce((a, [l]) => a + l, 0), Tt = Object.values(files).reduce((a, [, t]) => a + t, 0); onProgress && onProgress(L / Tt, `Downloading ${label} model… ${(L / 1048576).toFixed(0)}/${(Tt / 1048576).toFixed(0)} MB`); }
  };
}
function friendly(e) {
  const m = String(e && e.message || e);
  if (/fetch|network|Failed to load|ERR_|404|403/i.test(m)) return new Error('Could not download the AI model. Check your internet connection (models download once from huggingface.co, then work offline).');
  return e instanceof Error ? e : new Error(m);
}

// ---------- Subject segmentation ----------
const models = {};
async function subjectModel(onProgress) {
  const id = app.settings.subjectModel || 'briaai/RMBG-1.4';
  if (models[id]) return models[id];
  const t = await tf();
  const dev = await device();
  const cb = progressCb(onProgress, 'subject');
  let model, processor;
  if (id === 'briaai/RMBG-1.4') {
    model = await t.AutoModel.from_pretrained(id, { config: { model_type: 'custom' }, device: dev, dtype: 'fp32', progress_callback: cb }).catch(async (e) => { if (dev === 'webgpu') return t.AutoModel.from_pretrained(id, { config: { model_type: 'custom' }, device: 'wasm', progress_callback: cb }); throw e; });
    processor = await t.AutoProcessor.from_pretrained(id, { config: { do_normalize: true, do_pad: false, do_rescale: true, do_resize: true, image_mean: [0.5, 0.5, 0.5], feature_extractor_type: 'ImageFeatureExtractor', image_std: [1, 1, 1], resample: 2, rescale_factor: 0.00392156862745098, size: { width: 1024, height: 1024 } }, progress_callback: cb });
  } else {
    model = await t.AutoModel.from_pretrained(id, { device: dev, progress_callback: cb });
    processor = await t.AutoProcessor.from_pretrained(id, { progress_callback: cb });
  }
  return (models[id] = { model, processor });
}
async function segmentSubject(canvas, onProgress) {
  const t = await tf();
  const { model, processor } = await subjectModel(onProgress);
  onProgress && onProgress(0.9, 'Analyzing image…');
  const w = canvas.width, h = canvas.height;
  const id = ctx2d(canvas).getImageData(0, 0, w, h);
  const img = new t.RawImage(new Uint8ClampedArray(id.data), w, h, 4).rgb();
  const { pixel_values } = await processor(img);
  const out = await model({ input: pixel_values });
  const tensor = out.output || out.logits || Object.values(out)[0];
  let m = await t.RawImage.fromTensor(tensor[0].mul(255).to('uint8')).resize(w, h);
  const res = new Uint8Array(w * h);
  const ch = m.channels || 1;
  for (let i = 0; i < res.length; i++) res[i] = m.data[i * ch];
  return res;
}

function sourceCanvas(doc, sampleAll = true) {
  if (sampleAll || !doc.active || !doc.active.canvas) return doc.flatten();
  const c = createCanvas(doc.width, doc.height), L = doc.active, ct = doc.layerContent(L); ctx2d(c).drawImage(ct.canvas, ct.x, ct.y); return c;
}

export async function selectSubject(doc, { region = null, sampleAll = true, onProgress } = {}) {
  try {
    const src = sourceCanvas(doc, sampleAll);
    let r = region ? { x: Math.floor(region.x), y: Math.floor(region.y), w: Math.ceil(region.w), h: Math.ceil(region.h) } : { x: 0, y: 0, w: doc.width, h: doc.height };
    if (region) { const pad = Math.round(Math.max(r.w, r.h) * 0.08); r = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), w: Math.min(doc.width, r.x + r.w + pad) - Math.max(0, r.x - pad), h: Math.min(doc.height, r.y + r.h + pad) - Math.max(0, r.y - pad) }; }
    const crop = createCanvas(r.w, r.h); ctx2d(crop).drawImage(src, -r.x, -r.y);
    const m = await segmentSubject(crop, onProgress);
    const full = new Uint8Array(doc.width * doc.height);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      let v = m[y * r.w + x];
      if (region) { const inBox = x + r.x >= region.x && y + r.y >= region.y && x + r.x <= region.x + region.w && y + r.y <= region.y + region.h; if (!inBox) v = 0; }
      full[(y + r.y) * doc.width + x + r.x] = v;
    }
    // tighten soft matte a bit (Photoshop-like crisp edge) while keeping anti-aliasing
    for (let i = 0; i < full.length; i++) { const v = full[i] / 255; full[i] = clamp(Math.round((v - 0.15) / 0.7 * 255), 0, 255); }
    if (!full.some(v => v > 128)) { toast('No subject was found.', 'err'); return null; }
    return full;
  } catch (e) { throw friendly(e); }
}

let skySeg = null;
export async function selectSky(doc, onProgress) {
  try {
    const t = await tf();
    if (!skySeg) skySeg = await t.pipeline('image-segmentation', 'Xenova/segformer-b2-finetuned-ade-512-512', { device: await device(), progress_callback: progressCb(onProgress, 'sky') }).catch(() => t.pipeline('image-segmentation', 'Xenova/segformer-b0-finetuned-ade-512-512', { progress_callback: progressCb(onProgress, 'sky') }));
    onProgress && onProgress(0.9, 'Finding sky…');
    const src = doc.flatten(), w = src.width, h = src.height;
    const s = Math.min(1, 1024 / Math.max(w, h)), sw = Math.round(w * s), sh = Math.round(h * s);
    const small = createCanvas(sw, sh); ctx2d(small).drawImage(src, 0, 0, sw, sh);
    const id = ctx2d(small).getImageData(0, 0, sw, sh);
    const img = new t.RawImage(new Uint8ClampedArray(id.data), sw, sh, 4).rgb();
    const res = await skySeg(img);
    const sky = res.find(r => r.label === 'sky');
    if (!sky) { toast('No sky was found in this image.', 'err'); return null; }
    const m = await sky.mask.resize(w, h);
    const out = new Uint8Array(w * h); const ch = m.channels || 1;
    for (let i = 0; i < out.length; i++) out[i] = m.data[i * ch];
    // soften the edge
    const c = createCanvas(w, h), g = ctx2d(c), im = g.createImageData(w, h);
    for (let i = 0; i < out.length; i++) { im.data[i * 4 + 3] = out[i]; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255; }
    g.putImageData(im, 0, 0); const c2 = createCanvas(w, h), g2 = ctx2d(c2); g2.filter = `blur(${Math.max(1, Math.round(Math.max(w, h) / 800))}px)`; g2.drawImage(c, 0, 0);
    const d2 = g2.getImageData(0, 0, w, h).data; for (let i = 0; i < out.length; i++) out[i] = d2[i * 4 + 3];
    return out;
  } catch (e) { throw friendly(e); }
}

// ---------- LaMa object removal ----------
let ort = null, lama = null, lamaFailed = false;
const LAMA_URL = 'https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx';
async function fetchCached(url, onProgress, label) {
  let cache = null;
  try { cache = await caches.open('strata-models'); const hit = await cache.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error('download failed ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0, reader = r.body.getReader(), chunks = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress && total && onProgress(got / total, `Downloading ${label} model… ${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`); }
  const buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
  try { await cache?.put(url, new Response(buf)); } catch {}
  return buf;
}
async function lamaSession(onProgress) {
  if (lama) return lama;
  if (!ort) { ort = await import(base + 'ort/ort.all.min.mjs'); ort.env.wasm.wasmPaths = base + 'ort/'; }
  const bytes = await fetchCached(LAMA_URL, onProgress, 'Remove Tool (LaMa)');
  const eps = (await device()) === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  lama = await ort.InferenceSession.create(bytes, { executionProviders: eps, graphOptimizationLevel: 'all' });
  return lama;
}
export async function removeObject(img /*ImageData*/, mask /*Uint8Array*/, onProgress) {
  const W = img.width, H = img.height;
  if (!lamaFailed) {
    try {
      const sess = await lamaSession(onProgress);
      onProgress && onProgress(0.95, 'Removing…');
      const S = 512;
      const src = createCanvas(W, H); ctx2d(src).putImageData(img, 0, 0);
      const sc = createCanvas(S, S), sg = ctx2d(sc); sg.imageSmoothingQuality = 'high'; sg.drawImage(src, 0, 0, S, S);
      const mc = createCanvas(W, H), mg = ctx2d(mc), mid = mg.createImageData(W, H); for (let i = 0; i < mask.length; i++) mid.data[i * 4 + 3] = mask[i]; mg.putImageData(mid, 0, 0);
      const ms = createCanvas(S, S), msg = ctx2d(ms); msg.drawImage(mc, 0, 0, S, S);
      const pd = sg.getImageData(0, 0, S, S).data, md = msg.getImageData(0, 0, S, S).data;
      const imT = new Float32Array(3 * S * S), mT = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) { imT[i] = pd[i * 4] / 255; imT[S * S + i] = pd[i * 4 + 1] / 255; imT[2 * S * S + i] = pd[i * 4 + 2] / 255; mT[i] = md[i * 4 + 3] > 20 ? 1 : 0; }
      const names = sess.inputNames;
      const feeds = { [names[0]]: new ort.Tensor('float32', imT, [1, 3, S, S]), [names[1]]: new ort.Tensor('float32', mT, [1, 1, S, S]) };
      const out = await sess.run(feeds);
      const o = out[sess.outputNames[0]].data;
      let mx = 0; for (let i = 0; i < 2000; i++) mx = Math.max(mx, o[i * 37 % o.length]);
      const k = mx > 2 ? 1 : 255;
      const oc = createCanvas(S, S), og = ctx2d(oc), oid = og.createImageData(S, S);
      for (let i = 0; i < S * S; i++) { oid.data[i * 4] = o[i] * k; oid.data[i * 4 + 1] = o[S * S + i] * k; oid.data[i * 4 + 2] = o[2 * S * S + i] * k; oid.data[i * 4 + 3] = 255; }
      og.putImageData(oid, 0, 0);
      const back = createCanvas(W, H), bg = ctx2d(back); bg.imageSmoothingQuality = 'high'; bg.drawImage(oc, 0, 0, W, H);
      const bd = bg.getImageData(0, 0, W, H).data, res = new Uint8ClampedArray(img.data);
      for (let i = 0; i < mask.length; i++) if (mask[i]) { const j = i * 4; res[j] = bd[j]; res[j + 1] = bd[j + 1]; res[j + 2] = bd[j + 2]; res[j + 3] = 255; }
      // add back fine grain lost by the 512px model pass
      if (Math.max(W, H) > 700) { try { const det = await retouch('inpaint', { img: { data: new Uint8ClampedArray(img.data), width: W, height: H }, mask, opts: {} }); return blendDetail(res, det, mask, W, H); } catch { } }
      return res;
    } catch (e) {
      console.warn('LaMa unavailable, falling back to Content-Aware', e);
      lamaFailed = true;
      toast('AI Remove model unavailable — using Content-Aware instead.', '', 4000);
    }
  }
  return retouch('inpaint', { img: { data: img.data, width: W, height: H }, mask, opts: {} }, (f) => onProgress && onProgress(f, 'Content-Aware Fill…'));
}
// Use LaMa's structure + PatchMatch's high-frequency texture
function blendDetail(lamaRes, pm, mask, W, H) {
  const blur = (arr) => { const c = createCanvas(W, H), g = ctx2d(c); g.putImageData(new ImageData(new Uint8ClampedArray(arr), W, H), 0, 0); const b = createCanvas(W, H), bg = ctx2d(b); bg.filter = 'blur(3px)'; bg.drawImage(c, 0, 0); return bg.getImageData(0, 0, W, H).data; };
  const bl = blur(lamaRes), bp = blur(pm), out = new Uint8ClampedArray(lamaRes);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const j = i * 4; for (let c = 0; c < 3; c++) out[j + c] = bl[j + c] + (pm[j + c] - bp[j + c]) * 0.8; }
  return out;
}

// ---------- Generative Fill ----------
export async function generativeFill(doc, prompt, { count = 3, onProgress } = {}) {
  if (!doc.selection) throw new Error('Make a selection first.');
  const sb = doc.selBounds || alphaBounds(doc.selection);
  const pad = Math.round(Math.max(48, Math.max(sb.w, sb.h) * 0.3));
  const r = { x: Math.max(0, sb.x - pad), y: Math.max(0, sb.y - pad) }; r.w = Math.min(doc.width, sb.x + sb.w + pad) - r.x; r.h = Math.min(doc.height, sb.y + sb.h + pad) - r.y;
  const flat = doc.flatten();
  const crop = createCanvas(r.w, r.h); ctx2d(crop).drawImage(flat, -r.x, -r.y);
  const selC = createCanvas(r.w, r.h); ctx2d(selC).drawImage(doc.selection, -r.x, -r.y);
  const sd = ctx2d(selC).getImageData(0, 0, r.w, r.h).data, mask = new Uint8Array(r.w * r.h);
  for (let i = 0; i < mask.length; i++) mask[i] = sd[i * 4 + 3] > 16 ? 255 : 0;
  const provider = app.settings.genProvider || 'none';
  const variants = [];
  if (provider === 'none') {
    if (prompt && prompt.trim()) throw Object.assign(new Error('Generating new content from a prompt needs an image model. Choose a provider in Edit › Preferences › Generative AI (a local Stable Diffusion server, Stability AI or OpenAI). Leave the prompt empty to remove or fill using local AI.'), { needsProvider: true });
    const id = ctx2d(crop).getImageData(0, 0, r.w, r.h);
    const res = await removeObject(id, mask, onProgress);
    const c = createCanvas(r.w, r.h); ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(res), r.w, r.h), 0, 0);
    variants.push(c);
  } else {
    // scale to provider-friendly size
    const s = Math.min(1, 1024 / Math.max(r.w, r.h)), gw = Math.max(64, Math.round(r.w * s / 8) * 8), gh = Math.max(64, Math.round(r.h * s / 8) * 8);
    const gi = createCanvas(gw, gh), gg = ctx2d(gi); gg.imageSmoothingQuality = 'high'; gg.drawImage(crop, 0, 0, gw, gh);
    const mbw = createCanvas(gw, gh), mg = ctx2d(mbw); mg.fillStyle = '#000'; mg.fillRect(0, 0, gw, gh);
    const mtmp = createCanvas(r.w, r.h), mt = ctx2d(mtmp), mid = mt.createImageData(r.w, r.h); for (let i = 0; i < mask.length; i++) { mid.data[i * 4] = mid.data[i * 4 + 1] = mid.data[i * 4 + 2] = 255; mid.data[i * 4 + 3] = mask[i]; } mt.putImageData(mid, 0, 0);
    mg.filter = 'blur(2px)'; mg.drawImage(mtmp, 0, 0, gw, gh); mg.filter = 'none';
    const ma = createCanvas(gw, gh), mag = ctx2d(ma); mag.drawImage(gi, 0, 0); mag.globalCompositeOperation = 'destination-out'; mag.drawImage(mtmp, 0, 0, gw, gh);
    onProgress && onProgress(0.2, 'Generating…');
    const outs = await window.host.generate({ provider, prompt, count, width: gw, height: gh, image: await canvasToBytes(gi), maskBW: await canvasToBytes(mbw), maskAlpha: await canvasToBytes(ma) });
    for (const bytes of outs) {
      const im = await bytesToImage(bytes, 'image/png');
      const c = createCanvas(r.w, r.h), g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(im, 0, 0, r.w, r.h);
      variants.push(c);
    }
    if (!variants.length) throw new Error('The provider returned no images.');
  }
  return { rect: r, variants, prompt };
}

app.ai = { selectSubject, selectSky, removeObject, generativeFill };
