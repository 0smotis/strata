// Strata — Neural Filters engine.
// - Model loading / inference (Transformers.js, vendored) for Super Zoom, JPEG artifacts and Depth Blur.
// - Pure post-processing (no DOM) for every filter, so it runs (and is tested) in Node.
// Images are {data: Uint8ClampedArray RGBA (non-premultiplied), width, height}.
import { FILTERS } from '../engine/filters.js';

// ===========================================================================
// Model loading (same conventions as ai.js; own loader functions)
// ===========================================================================

export const NEURAL_MODELS = {
  sr2: { id: 'Xenova/swin2SR-classical-sr-x2-64', task: 'image-to-image', scale: 2, label: 'Super Zoom ×2', size: '~5 MB' },
  sr4: { id: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr', task: 'image-to-image', scale: 4, label: 'Super Zoom ×4', size: '~17 MB' },
  jpeg: { id: 'Xenova/swin2SR-compressed-sr-x4-48', task: 'image-to-image', scale: 4, label: 'JPEG artifacts', size: '~17 MB' },
  depth: { id: 'onnx-community/depth-anything-v2-small', alt: 'Xenova/depth-anything-small-hf', task: 'depth-estimation', label: 'Depth', size: '~27–100 MB' },
};

let T = null, pipelineFactory = null;
const pipes = {}, pipeErr = {};
async function tf() {
  if (T) return T;
  const base = new URL('../../vendor/', import.meta.url).href;
  T = await import(base + 'transformers/transformers.min.js');
  T.env.allowLocalModels = false;
  T.env.useBrowserCache = true;
  T.env.backends.onnx.wasm.wasmPaths = base + 'transformers/';
  return T;
}
async function device() {
  let useGPU = true;
  try { const { app } = await import('../state.js'); useGPU = app.settings.useGPU !== false; } catch { }
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  return (useGPU && nav && nav.gpu && (await nav.gpu.requestAdapter().catch(() => null))) ? 'webgpu' : 'wasm';
}
function progressCb(onProgress, label) {
  const files = {};
  return (p) => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      const L = Object.values(files).reduce((a, [l]) => a + l, 0), Tt = Object.values(files).reduce((a, [, t]) => a + t, 0);
      onProgress && onProgress(L / Tt, `Downloading ${label} model… ${(L / 1048576).toFixed(0)}/${(Tt / 1048576).toFixed(0)} MB`);
    }
  };
}
export function friendlyModelError(e, label = 'AI') {
  const m = String(e && e.message || e);
  if (/fetch|network|Failed to load|ERR_|404|403|401|Could not locate|Unauthorized|Forbidden|load model|NetworkError|CORS|offline/i.test(m))
    return Object.assign(new Error(`Could not download the ${label} model. Check your internet connection — models download once from huggingface.co, then work offline.`), { cause: e, network: true });
  return Object.assign(new Error(`The ${label} model failed to run: ${m}`), { cause: e });
}
/** Test hook: replace the Transformers.js pipeline factory. fn(task, modelId, opts) -> callable. Pass null to restore. */
export function __setPipelineFactory(fn) { pipelineFactory = fn; for (const k in pipes) delete pipes[k]; for (const k in pipeErr) delete pipeErr[k]; }
export function modelStatus(key) { return pipes[key] ? 'ready' : pipeErr[key] ? 'error' : 'idle'; }
export function resetModelError(key) { delete pipeErr[key]; }

async function getPipe(key, onProgress) {
  if (pipes[key]) return pipes[key];
  const M = NEURAL_MODELS[key];
  const cb = progressCb(onProgress, M.label);
  try {
    let p;
    if (pipelineFactory) p = await pipelineFactory(M.task, M.id, { progress_callback: cb });
    else {
      const t = await tf(); const dev = await device();
      const mk = (id, d) => t.pipeline(M.task, id, { device: d, dtype: d === 'webgpu' ? 'fp32' : (M.task === 'depth-estimation' ? 'q8' : 'fp32'), progress_callback: cb });
      p = await mk(M.id, dev).catch((e) => dev === 'webgpu' ? mk(M.id, 'wasm') : Promise.reject(e))
        .catch((e) => M.alt ? mk(M.alt, 'wasm') : Promise.reject(e));
    }
    delete pipeErr[key];
    return (pipes[key] = p);
  } catch (e) {
    const err = friendlyModelError(e, M.label);
    pipeErr[key] = err;
    throw err;
  }
}

// RGBA img -> RawImage (RGB). RawImage-like output -> RGBA img.
function toRaw(t, img) {
  const n = img.width * img.height, rgb = new Uint8ClampedArray(n * 3), d = img.data;
  for (let i = 0; i < n; i++) { rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2]; }
  return t && t.RawImage ? new t.RawImage(rgb, img.width, img.height, 3) : { data: rgb, width: img.width, height: img.height, channels: 3 };
}
export function fromRaw(raw) {
  const w = raw.width, h = raw.height, ch = raw.channels || Math.round(raw.data.length / (w * h)), n = w * h;
  const out = newImg(w, h), d = out.data, s = raw.data;
  for (let i = 0; i < n; i++) {
    const o = i * 4, k = i * ch;
    if (ch >= 3) { d[o] = s[k]; d[o + 1] = s[k + 1]; d[o + 2] = s[k + 2]; } else d[o] = d[o + 1] = d[o + 2] = s[k];
    d[o + 3] = ch === 4 ? s[k + 3] : 255;
  }
  return out;
}

/** Returns async (img) => img × model scale. kind: 'sr2' | 'sr4' | 'jpeg'. */
export async function loadUpscaler(kind, onProgress) {
  const p = await getPipe(kind, onProgress);
  const t = pipelineFactory ? null : await tf();
  const run = async (img) => {
    let out = await p(toRaw(t, img));
    if (Array.isArray(out)) out = out[0];
    return fromRaw(out);
  };
  run.scale = NEURAL_MODELS[kind].scale;
  return run;
}

/** Returns async (img) => {data: Float32Array 0..1 (1 = near), width, height}. */
export async function loadDepthEstimator(onProgress) {
  const p = await getPipe('depth', onProgress);
  const t = pipelineFactory ? null : await tf();
  return async (img) => {
    let out = await p(toRaw(t, img));
    if (Array.isArray(out)) out = out[0];
    return depthFromOutput(out, img.width, img.height);
  };
}
// Normalise a depth-estimation output ({predicted_depth?, depth: RawImage}) to 0..1, near = 1 (robust percentiles).
export function depthFromOutput(out, w, h) {
  let src, sw, sh;
  const pd = out.predicted_depth;
  if (pd && pd.data && pd.dims && pd.dims.length >= 2) { src = pd.data; sh = pd.dims[pd.dims.length - 2]; sw = pd.dims[pd.dims.length - 1]; }
  else { const d = out.depth || out; const ch = d.channels || 1; sw = d.width; sh = d.height; src = new Float32Array(sw * sh); for (let i = 0; i < src.length; i++) src[i] = d.data[i * ch]; }
  let plane = Float32Array.from(src);
  if (sw !== w || sh !== h) plane = resizePlane(plane, sw, sh, w, h);
  const s = Float32Array.from(plane).sort();
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
  const k = hi - lo > 1e-9 ? 1 / (hi - lo) : 0;
  for (let i = 0; i < plane.length; i++) plane[i] = clamp((plane[i] - lo) * k, 0, 1);
  return { data: plane, width: w, height: h };
}

// ===========================================================================
// Basic image / plane helpers
// ===========================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
export function newImg(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
export function copyImg(img) { return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height }; }
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

function planeY(img) {
  const n = img.width * img.height, d = img.data, Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return Y;
}
function planesRGB(img) {
  const n = img.width * img.height, d = img.data, R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) { R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; B[i] = d[i * 4 + 2]; }
  return [R, G, B];
}

/** In-place box blur of a Float32 plane (normalised at edges). */
export function boxPlane(P, w, h, r, tmp) {
  r = Math.round(r); if (r < 1 || w < 1 || h < 1) return P;
  tmp = tmp && tmp.length >= w * h ? tmp : new Float32Array(w * h);
  const S = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w; S[0] = 0;
    for (let x = 0; x < w; x++) S[x + 1] = S[x] + P[o + x];
    for (let x = 0; x < w; x++) { const a = x - r < 0 ? 0 : x - r, b = x + r + 1 > w ? w : x + r + 1; tmp[o + x] = (S[b] - S[a]) / (b - a); }
  }
  const acc = new Float64Array(w); let top = 0, bot = -1;
  for (let y = 0; y < h; y++) {
    const a = y - r < 0 ? 0 : y - r, b = y + r > h - 1 ? h - 1 : y + r;
    while (bot < b) { bot++; const o = bot * w; for (let x = 0; x < w; x++) acc[x] += tmp[o + x]; }
    while (top < a) { const o = top * w; for (let x = 0; x < w; x++) acc[x] -= tmp[o + x]; top++; }
    const inv = 1 / (b - a + 1), o = y * w;
    for (let x = 0; x < w; x++) P[o + x] = acc[x] * inv;
  }
  return P;
}
/** In-place gaussian-ish blur (3 box passes, or a direct kernel for small sigma). */
export function blurPlane(P, w, h, sigma, tmp) {
  if (!(sigma > 0.3)) return P;
  tmp = tmp && tmp.length >= w * h ? tmp : new Float32Array(w * h);
  if (sigma < 2) {
    const r = Math.ceil(sigma * 3), k = new Float32Array(2 * r + 1); let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * P[o + clamp(x + i, 0, w - 1)]; tmp[o + x] = a; } }
    for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * tmp[clamp(y + i, 0, h - 1) * w + x]; P[o + x] = a; } }
    return P;
  }
  const wI = Math.sqrt(12 * sigma * sigma / 3 + 1); let wl = Math.floor(wI); if (wl % 2 === 0) wl--;
  const m = Math.round((12 * sigma * sigma - 3 * wl * wl - 12 * wl - 9) / (-4 * wl - 4));
  for (let i = 0; i < 3; i++) boxPlane(P, w, h, ((i < m ? wl : wl + 2) - 1) >> 1, tmp);
  return P;
}
/** Guided filter (He et al.), gray guide I, input p. Returns new plane. */
export function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h, tmp = new Float32Array(n);
  const mI = Float32Array.from(I), mP = Float32Array.from(p), II = new Float32Array(n), IP = new Float32Array(n);
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; IP[i] = I[i] * p[i]; }
  boxPlane(mI, w, h, r, tmp); boxPlane(mP, w, h, r, tmp); boxPlane(II, w, h, r, tmp); boxPlane(IP, w, h, r, tmp);
  const a = II, b = IP; // reuse
  for (let i = 0; i < n; i++) { const v = II[i] - mI[i] * mI[i], c = IP[i] - mI[i] * mP[i], A = c / (v + eps); a[i] = A; b[i] = mP[i] - A * mI[i]; }
  boxPlane(a, w, h, r, tmp); boxPlane(b, w, h, r, tmp);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = a[i] * I[i] + b[i];
  return q;
}
function dilate(M, w, h, r) { // binary-ish (max) separable, Uint8
  if (r < 1) return M; const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) if (M[y * w + i] > m) m = M[y * w + i]; t[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i++) if (t[i * w + x] > m) m = t[i * w + x]; o[y * w + x] = m; }
  return o;
}
function erode(M, w, h, r) {
  if (r < 1) return M; const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 255; for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) if (M[y * w + i] < m) m = M[y * w + i]; t[y * w + x] = m; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 255; for (let i = Math.max(0, y - r); i <= Math.min(h - 1, y + r); i++) if (t[i * w + x] < m) m = t[i * w + x]; o[y * w + x] = m; }
  return o;
}

// ---------- resampling ----------
export function resizePlane(P, sw, sh, w, h) { // bilinear (pixel-centre aligned)
  const out = new Float32Array(w * h), fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const sy = clamp((y + 0.5) * fy - 0.5, 0, sh - 1), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = clamp((x + 0.5) * fx - 0.5, 0, sw - 1), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      out[y * w + x] = (P[y0 * sw + x0] * (1 - tx) + P[y0 * sw + x1] * tx) * (1 - ty) + (P[y1 * sw + x0] * (1 - tx) + P[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}
/** Sample a sub-rectangle (in map pixel coords, may be fractional) of a plane into w×h. */
export function samplePlane(P, mw, mh, rx, ry, rw, rh, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = clamp(ry + (y + 0.5) * rh / h - 0.5, 0, mh - 1), y0 = Math.floor(sy), y1 = Math.min(mh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = clamp(rx + (x + 0.5) * rw / w - 0.5, 0, mw - 1), x0 = Math.floor(sx), x1 = Math.min(mw - 1, x0 + 1), tx = sx - x0;
      out[y * w + x] = (P[y0 * mw + x0] * (1 - tx) + P[y0 * mw + x1] * tx) * (1 - ty) + (P[y1 * mw + x0] * (1 - tx) + P[y1 * mw + x1] * tx) * ty;
    }
  }
  return out;
}
/** Area-average downscale (or bilinear if upscaling). */
export function resizeImg(img, w, h) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const sw = img.width, sh = img.height, s = img.data, out = newImg(w, h), d = out.data;
  if (w >= sw && h >= sh) return resizeBicubic(img, w, h);
  const fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * fy, y1 = y0 + fy;
    for (let x = 0; x < w; x++) {
      const x0 = x * fx, x1 = x0 + fx;
      let r = 0, g = 0, b = 0, a = 0, wt = 0, ws = 0;
      for (let yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx), k = wx * wy, o = (yy * sw + xx) * 4, al = s[o + 3] * k;
          r += s[o] * al; g += s[o + 1] * al; b += s[o + 2] * al; a += al; ws += k;
          wt += k;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; }
      d[o + 3] = a / (ws || 1);
    }
  }
  return out;
}
/** Catmull-Rom bicubic resample (any size). */
export function resizeBicubic(img, w, h) {
  const sw = img.width, sh = img.height, s = img.data;
  const cub = (t) => { t = Math.abs(t); return t < 1 ? 1.5 * t * t * t - 2.5 * t * t + 1 : t < 2 ? -0.5 * t * t * t + 2.5 * t * t - 4 * t + 2 : 0; };
  // horizontal pass into float buffer sw->w
  const tmp = new Float32Array(w * sh * 4), fx = sw / w;
  const xi = new Int32Array(w * 4), xw = new Float32Array(w * 4);
  for (let x = 0; x < w; x++) { const sx = (x + 0.5) * fx - 0.5, x0 = Math.floor(sx); for (let k = 0; k < 4; k++) { xi[x * 4 + k] = clamp(x0 - 1 + k, 0, sw - 1); xw[x * 4 + k] = cub(sx - (x0 - 1 + k)); } }
  for (let y = 0; y < sh; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = 0; k < 4; k++) { const o = (y * sw + xi[x * 4 + k]) * 4, wt = xw[x * 4 + k], al = s[o + 3] * wt; r += s[o] * al; g += s[o + 1] * al; b += s[o + 2] * al; a += al; }
    const o = (y * w + x) * 4; tmp[o + 3] = a; if (Math.abs(a) > 1e-6) { tmp[o] = r / a; tmp[o + 1] = g / a; tmp[o + 2] = b / a; }
  }
  const out = newImg(w, h), d = out.data, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) * fy - 0.5, y0 = Math.floor(sy);
    const yi = [0, 1, 2, 3].map(k => clamp(y0 - 1 + k, 0, sh - 1)), yw = [0, 1, 2, 3].map(k => cub(sy - (y0 - 1 + k)));
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < 4; k++) { const o = (yi[k] * w + x) * 4, wt = yw[k], al = tmp[o + 3] * wt; r += tmp[o] * al; g += tmp[o + 1] * al; b += tmp[o + 2] * al; a += al; }
      const o = (y * w + x) * 4; d[o + 3] = a; if (Math.abs(a) > 1e-6) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; }
    }
  }
  return out;
}
export function cropImg(img, x, y, w, h) {
  const out = newImg(w, h);
  for (let yy = 0; yy < h; yy++) {
    const sy = clamp(y + yy, 0, img.height - 1);
    for (let xx = 0; xx < w; xx++) { const sx = clamp(x + xx, 0, img.width - 1), o = (sy * img.width + sx) * 4, q = (yy * w + xx) * 4; out.data[q] = img.data[o]; out.data[q + 1] = img.data[o + 1]; out.data[q + 2] = img.data[o + 2]; out.data[q + 3] = img.data[o + 3]; }
  }
  return out;
}
// mulberry32
function rng(seed) { let a = (seed * 2654435761) >>> 0 || 1; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ===========================================================================
// Colour: sRGB <-> CIELAB (D65), vectorised with LUTs
// ===========================================================================
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const GAM_N = 4096, GAM = new Float32Array(GAM_N + 1);
for (let i = 0; i <= GAM_N; i++) { const c = i / GAM_N; GAM[i] = 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); }
const toSrgb = (l) => (l <= 0 ? 0 : l >= 1 ? 255 : GAM[(l * GAM_N) | 0]);
const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t) => (t > 0.206893 ? t * t * t : (t - 16 / 116) / 7.787);

export function imgToLab(img) {
  const n = img.width * img.height, d = img.data, L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = LIN[d[i * 4]], g = LIN[d[i * 4 + 1]], b = LIN[d[i * 4 + 2]];
    const X = fLab((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), Y = fLab(r * 0.2126 + g * 0.7152 + b * 0.0722), Z = fLab((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    L[i] = 116 * Y - 16; A[i] = 500 * (X - Y); B[i] = 200 * (Y - Z);
  }
  return [L, A, B];
}
export function labToImg(L, A, B, like) {
  const out = copyImg(like), d = out.data, n = L.length;
  for (let i = 0; i < n; i++) {
    const fy = (L[i] + 16) / 116, fx = fy + A[i] / 500, fz = fy - B[i] / 200;
    const X = fInv(fx) * 0.95047, Y = fInv(fy), Z = fInv(fz) * 1.08883;
    d[i * 4] = toSrgb(3.2406 * X - 1.5372 * Y - 0.4986 * Z);
    d[i * 4 + 1] = toSrgb(-0.9689 * X + 1.8758 * Y + 0.0415 * Z);
    d[i * 4 + 2] = toSrgb(0.0557 * X - 0.2040 * Y + 1.0570 * Z);
  }
  return out;
}
export function hexToLab(hex) {
  const s = String(hex || '#808080').replace('#', ''), v = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s.slice(0, 6), 16) || 0;
  const im = { data: new Uint8ClampedArray([(v >> 16) & 255, (v >> 8) & 255, v & 255, 255]), width: 1, height: 1 };
  const [L, A, B] = imgToLab(im); return [L[0], A[0], B[0]];
}
/** Alpha-weighted Lab mean/std. Subsamples large images. */
export function labStats(img) {
  const n = img.width * img.height, step = Math.max(1, Math.floor(n / 250000));
  const [L, A, B] = imgToLab(img), d = img.data;
  let w = 0; const m = [0, 0, 0], q = [0, 0, 0];
  for (let i = 0; i < n; i += step) {
    const a = d[i * 4 + 3] / 255; if (a < 0.5) continue;
    w += a; m[0] += L[i] * a; m[1] += A[i] * a; m[2] += B[i] * a; q[0] += L[i] * L[i] * a; q[1] += A[i] * A[i] * a; q[2] += B[i] * B[i] * a;
  }
  if (w === 0) return { mean: [50, 0, 0], std: [20, 8, 8], empty: true };
  const mean = m.map(v => v / w), std = q.map((v, k) => Math.sqrt(Math.max(1e-4, v / w - mean[k] * mean[k])));
  return { mean, std };
}
/** Lab stats of a weighted palette [[r,g,b,weight], ...] — used for built-in Color Transfer presets. */
export function paletteStats(colors) {
  const px = []; for (const [r, g, b, wt = 1] of colors) for (let k = 0; k < Math.max(1, Math.round(wt * 10)); k++) px.push(r, g, b, 255);
  return labStats({ data: new Uint8ClampedArray(px), width: px.length / 4, height: 1 });
}
// Luminance-preserving RGB colour balance (+ saturation/brightness in Lab). values ~ -50..50
function colorBalance(img, cr, mg, yb) {
  if (!cr && !mg && !yb) return img;
  const dr = cr * 1.1, dg = mg * 1.1, db = yb * 1.1, dl = lum(dr, dg, db), d = img.data;
  for (let i = 0; i < d.length; i += 4) { d[i] += dr - dl; d[i + 1] += dg - dl; d[i + 2] += db - dl; }
  return img;
}

// ===========================================================================
// Filters
// Each: { stats?(fullFrameImg, p, ctx) -> state, apply(img, p, state, ctx) -> img|Promise<img> }
// ctx: { scale (proc px per full-res px), region {x,y,w,h} full-res px, fullW, fullH,
//        depth?(img) -> Float32 0..1 near=1, aiJpeg?(img) -> Promise<img|null>, seed, abort? }
// ===========================================================================

// ---------- Skin Smoothing ----------
export function skinMask(img) {
  const n = img.width * img.height, d = img.data, m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], y = lum(r, g, b);
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b, cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const u = (cb - 106) / 20, v = (cr - 153) / 17, e = u * u + v * v;      // ellipse in CbCr
    let s = 1 - smooth(0.75, 1.35, e);
    s *= smooth(35, 70, y) * (1 - smooth(245, 255, y)) * (r > b ? 1 : 0.3);
    m[i] = s * d[i * 4 + 3] / 255;
  }
  return m;
}
function skinSmoothing(img, p, ctx) {
  const blur = clamp(num(p.blur, 50), 0, 100) / 100, sm = clamp(num(p.smoothness, 0), -50, 50) / 50;
  if (blur <= 0) return copyImg(img);
  const w = img.width, h = img.height, n = w * h, long = Math.max(ctx.fullW, ctx.fullH);
  const r = Math.max(1, Math.round((2 + blur * 0.01 * long) * ctx.scale));
  const eps = Math.pow(0.015 + blur * 0.07, 2);
  const M = skinMask(img); blurPlane(M, w, h, Math.max(1, r * 0.8));
  const [R, G, B] = planesRGB(img), Y = planeY(img);
  const Yn = new Float32Array(n); for (let i = 0; i < n; i++) Yn[i] = Y[i] / 255;
  const keep = clamp(0.14 - sm * 0.14, 0, 0.45) * (1.15 - blur * 0.3); // detail kept: smoothness +50 -> 0, -50 -> ~0.3
  const fine = Float32Array.from(Y); blurPlane(fine, w, h, Math.max(0.6, 0.9 * ctx.scale * Math.max(1, long / 2000)));
  const out = copyImg(img), o = out.data;
  const ch = [R, G, B];
  for (let c = 0; c < 3; c++) {
    const P = ch[c], Pn = new Float32Array(n); for (let i = 0; i < n; i++) Pn[i] = P[i] / 255;
    const q = guidedFilter(Yn, Pn, w, h, r, eps);
    for (let i = 0; i < n; i++) {
      const orig = P[i], s = q[i] * 255, micro = (Y[i] - fine[i]) * (0.22 - 0.14 * blur) * (1 - Math.max(0, sm) * 0.8); // keep a little pore texture
      const v = s + (orig - s) * keep + micro;
      o[i * 4 + c] = lerp(orig, v, clamp(M[i] * 1.25, 0, 1));
    }
  }
  return out;
}

// ---------- JPEG Artifacts Removal (algorithmic) ----------
const JPEG_STR = { low: 0.45, medium: 0.75, high: 1 };
export function deblockJpeg(img, strength = 0.75, ox = 0, oy = 0) {
  const w = img.width, h = img.height, n = w * h, out = copyImg(img), d = out.data;
  const thr = 8 + strength * 34;
  // 1) deblocking on the 8×8 grid (only meaningful at 1:1 scale)
  const flatT = 3 + strength * 7;
  const fixEdge = (get, set) => { // p3 p2 p1 p0 | q0 q1 q2 q3
    const p0 = get(-1), q0 = get(0), p1 = get(-2), q1 = get(1), p2 = get(-3), q2 = get(2), p3 = get(-4), q3 = get(3);
    const delta = q0 - p0, ad = Math.abs(delta);
    if (ad < 0.5 || ad > thr || Math.abs(p1 - p0) > thr * 0.6 || Math.abs(q1 - q0) > thr * 0.6) return;
    const k = strength;
    if (Math.max(Math.abs(p3 - p0), Math.abs(p2 - p0), Math.abs(q3 - q0), Math.abs(q2 - q0)) < flatT) {
      // both sides flat (heavily quantised blocks): spread the step as a ramp over the whole 8 px
      for (let i = 1; i <= 4; i++) { const c = delta * k * (4.5 - i) / 8; set(-i, get(-i) + c); set(i - 1, get(i - 1) - c); }
      return;
    }
    set(-3, p2 + delta * k / 8); set(-2, p1 + delta * k * 2 / 8); set(-1, p0 + delta * k * 3 / 8);
    set(0, q0 - delta * k * 3 / 8); set(1, q1 - delta * k * 2 / 8); set(2, q2 - delta * k / 8);
  };
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) for (let x = ((8 - ((ox) % 8)) % 8) || 8; x < w - 3; x += 8) {
      if (x < 4) continue; const row = y * w;
      fixEdge((k) => d[(row + x + k) * 4 + c], (k, v) => { d[(row + x + k) * 4 + c] = v; });
    }
    for (let y = ((8 - (oy % 8)) % 8) || 8; y < h - 3; y += 8) {
      if (y < 4) continue;
      for (let x = 0; x < w; x++) fixEdge((k) => d[((y + k) * w + x) * 4 + c], (k, v) => { d[((y + k) * w + x) * 4 + c] = v; });
    }
  }
  // 2) ringing / mosquito noise: self-guided filter on luma, stronger chroma smoothing (JPEG subsamples chroma)
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], y = lum(r, g, b); Y[i] = y / 255; Cb[i] = (b - y) * 0.564; Cr[i] = (r - y) * 0.713; }
  const eps = Math.pow(0.01 + 0.035 * strength, 2);
  const Q = guidedFilter(Y, Y, w, h, 2, eps);
  const ce = 0.002 + 0.006 * strength; // chroma follows luma edges (chroma is subsampled in JPEG)
  const cr2 = 2 + Math.round(5 * strength), cbG = guidedFilter(Y, Cb, w, h, cr2, ce), crG = guidedFilter(Y, Cr, w, h, cr2, ce);
  for (let i = 0; i < n; i++) {
    const y = lerp(Y[i], Q[i], strength) * 255, cb = lerp(Cb[i], cbG[i], strength), cr = lerp(Cr[i], crG[i], strength);
    const r = y + cr / 0.713, b = y + cb / 0.564, g = (y - 0.299 * r - 0.114 * b) / 0.587;
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b;
  }
  return out;
}
async function jpegArtifacts(img, p, ctx) {
  const k = JPEG_STR[p.strength] ?? 0.75;
  let model = null;
  if (p.useAI !== false && ctx.aiJpeg) model = await ctx.aiJpeg(img);
  if (model) { // blend model output with original by strength
    const out = copyImg(img), d = out.data, m = model.data;
    for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] = lerp(d[i + c], m[i + c], k);
    return out;
  }
  const atOne = ctx.scale >= 0.999;
  const rx = atOne ? Math.round(ctx.region.x) : 0, ry = atOne ? Math.round(ctx.region.y) : 0;
  return atOne ? deblockJpeg(img, k, rx, ry) : deblockJpeg(img, k * 0.6, 3, 3);
}

// ---------- Photo Restoration ----------
export function removeScratches(img, amount, scale = 1, fullLong = Math.max(img.width, img.height)) {
  if (amount <= 0) return copyImg(img);
  const w = img.width, h = img.height, n = w * h;
  const r = Math.max(1, Math.round(3 * Math.min(1, scale * 1.5)));
  const med = FILTERS.median.run(img, { radius: r + 1 });
  const Y = planeY(img), mY = planeY(med);
  // robust noise level (MAD) so film grain / noise is not mistaken for scratches
  const dev = new Float32Array(Math.ceil(n / 7)); for (let i = 0, k = 0; i < n; i += 7) dev[k++] = Math.abs(Y[i] - mY[i]);
  const sigma = 1.4826 * dev.sort()[dev.length >> 1];
  const thr = Math.max(lerp(80, 22, amount), 4.5 * sigma + 8);
  // line-coherent response: average the residual along 4 directions (noise averages out, scratches don't)
  const D = new Float32Array(n); for (let i = 0; i < n; i++) D[i] = Y[i] - mY[i];
  const L = 4, dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], lineThr = Math.max(lerp(70, 18, amount), 5 * sigma / Math.sqrt(2 * L + 1) + 8);
  // scratches / dust are near paper-white or near-black: only pixels beyond the legit tonal range qualify
  const sm = new Float32Array(Math.ceil(n / 5)); for (let i = 0, k = 0; i < n; i += 5) sm[k++] = mY[i]; sm.sort();
  const lo = sm[Math.floor(sm.length * 0.005)], hi = sm[Math.floor(sm.length * 0.995)], margin = 10 + 30 * amount;
  const M = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (D[i] > 0 ? Y[i] < hi - margin : Y[i] > lo + margin) continue;
    if (Math.abs(D[i]) > thr) { M[i] = 255; continue; }
    if (Math.abs(D[i]) < lineThr * 0.6) continue;
    for (const [dx, dy] of dirs) {
      let sum = 0;
      for (let k = -L; k <= L; k++) { const xx = clamp(x + dx * k, 0, w - 1), yy = clamp(y + dy * k, 0, h - 1); sum += D[yy * w + xx]; }
      if (Math.abs(sum) / (2 * L + 1) > lineThr && Math.sign(sum) === Math.sign(D[i])) { M[i] = 255; break; }
    }
  }
  const rr = Math.max(1, Math.round(fullLong * scale / 900)) + (amount > 0.55 ? 1 : 0); // scratches are a few px wide at ~1000 px; wider bright/dark shapes are image content
  const opened = dilate(erode(M, w, h, rr), w, h, rr + 1);   // thick structures survive
  const S = new Uint8Array(n); for (let i = 0; i < n; i++) S[i] = M[i] && !opened[i] ? 255 : 0;  // thin lines/specks
  const Sd = dilate(S, w, h, scale > 0.6 ? 2 : 1), F = new Float32Array(n); for (let i = 0; i < n; i++) F[i] = Sd[i] / 255;
  // fill from undamaged neighbours only (normalised convolution), then re-add matching grain
  const Wt = new Float32Array(n); for (let i = 0; i < n; i++) Wt[i] = 1 - F[i];
  const sg = Math.max(1.5, 2.5 * Math.min(1, scale * 1.5)), Wb = blurPlane(Float32Array.from(Wt), w, h, sg);
  const fill = [0, 1, 2].map(c => { const Pp = new Float32Array(n); for (let i = 0; i < n; i++) Pp[i] = img.data[i * 4 + c] * Wt[i]; return blurPlane(Pp, w, h, sg); });
  blurPlane(F, w, h, 0.7);
  const out = copyImg(img), o = out.data, md = med.data, rnd = rng(5), gs = Math.min(sigma, 20) * 0.8;
  for (let i = 0; i < n; i++) {
    const f = clamp(F[i] * 1.6, 0, 1); if (!(f > 0)) continue;
    const g = (rnd() + rnd() + rnd() - 1.5) * gs * 1.4;
    for (let c = 0; c < 3; c++) { const v = Wb[i] > 0.05 ? fill[c][i] / Wb[i] + g : md[i * 4 + c]; o[i * 4 + c] = lerp(o[i * 4 + c], v, f); }
  }
  out.scratchMask = S;
  return out;
}
function denoiseLuma(img, amt, colorAmt, scale) {
  const w = img.width, h = img.height, n = w * h, d = img.data;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) { const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], y = lum(r, g, b); Y[i] = y / 255; Cb[i] = (b - y) * 0.564; Cr[i] = (r - y) * 0.713; }
  let Q = Y;
  if (amt > 0) Q = guidedFilter(Y, Y, w, h, Math.max(1, Math.round(1 + 2 * amt * Math.min(1, scale * 2))), Math.pow(0.006 + 0.04 * amt, 2));
  if (colorAmt > 0) { const s = Math.max(0.6, (1 + 5 * colorAmt) * Math.min(1, scale * 2)); blurPlane(Cb, w, h, s); blurPlane(Cr, w, h, s); }
  const out = copyImg(img), o = out.data;
  for (let i = 0; i < n; i++) { const y = Q[i] * 255, r = y + Cr[i] / 0.713, b = y + Cb[i] / 0.564, g = (y - 0.299 * r - 0.114 * b) / 0.587; o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b; }
  return out;
}
function lumPercentiles(img0) {
  const s0 = Math.min(1, 320 / Math.max(img0.width, img0.height));
  const img = FILTERS.median.run(s0 < 1 ? resizeImg(img0, img0.width * s0, img0.height * s0) : img0, { radius: 2 }); // ignore thin scratches / specks
  const n = img.width * img.height, d = img.data, hist = new Float64Array(256); let tot = 0;
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3]; if (a < 128) continue; hist[Math.round(lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]))]++; tot++; }
  const pct = (q) => { let s = 0; for (let v = 0; v < 256; v++) { s += hist[v]; if (s >= q * tot) return v; } return 255; };
  return { lo: pct(0.003), hi: pct(0.997), mid: pct(0.5) };
}
function photoRestoration(img, p, st, ctx) {
  const pe = clamp(num(p.enhance, 50), 0, 100) / 100, sr = clamp(num(p.scratch, 25), 0, 100) / 100;
  const nr = clamp(num(p.noise, 0), 0, 100) / 100, cnr = clamp(num(p.colorNoise, 0), 0, 100) / 100;
  const ht = clamp(num(p.halftone, 0), 0, 100) / 100, jp = clamp(num(p.jpeg, 0), 0, 100) / 100;
  let out = img;
  if (jp > 0) out = ctx.scale >= 0.999 ? deblockJpeg(out, jp, Math.round(ctx.region.x), Math.round(ctx.region.y)) : deblockJpeg(out, jp * 0.6, 3, 3);
  if (ht > 0) { // halftone dots: low-pass then re-sharpen edges slightly
    const w = out.width, h = out.height, [R, G, B] = planesRGB(out), s = (0.6 + ht * 1.8) * Math.max(0.35, ctx.scale), o = copyImg(out);
    [R, G, B].forEach((P, c) => { blurPlane(P, w, h, s); for (let i = 0; i < w * h; i++) o.data[i * 4 + c] = lerp(out.data[i * 4 + c], P[i], clamp(ht * 1.3, 0, 1)); });
    out = o;
  }
  if (sr > 0) out = removeScratches(out, sr, ctx.scale, Math.max(ctx.fullW, ctx.fullH));
  if (nr > 0 || cnr > 0) out = denoiseLuma(out, nr, cnr, ctx.scale);
  if (pe > 0) {
    const { lo, hi } = st || lumPercentiles(out), w = out.width, h = out.height, n = w * h;
    const span = Math.max(40, hi - lo), lo2 = lerp(0, lo, pe), k = 255 / lerp(255, span, pe) ;
    const Y = planeY(out), B = Float32Array.from(Y);
    blurPlane(B, w, h, Math.max(1.5, 0.015 * Math.max(ctx.fullW, ctx.fullH) * ctx.scale));
    const F2 = Float32Array.from(Y); blurPlane(F2, w, h, Math.max(0.7, 1.2 * ctx.scale * Math.max(1, Math.max(ctx.fullW, ctx.fullH) / 1500)));
    const o = copyImg(out), d = o.data;
    for (let i = 0; i < n; i++) {
      const y = Y[i], yl = (y - lo2) * k, dt = y - F2[i], local = (y - B[i]) * 0.45 * pe + dt * 0.4 * pe * smooth(2, 6, Math.abs(dt)), ny = clamp(yl + local, 0, 255);
      const f = ny / Math.max(1, y), sat = 1 + 0.12 * pe;
      for (let c = 0; c < 3; c++) { const v = d[i * 4 + c] * (y > 1 ? f : 1) + (y > 1 ? 0 : ny); d[i * 4 + c] = ny + (v - ny) * sat; }
    }
    out = o;
  }
  return out === img ? copyImg(img) : out;
}

// ---------- Harmonization ----------
function lumaGuard(L, tm, rm, amt) { // shift luminance only partially (luminance protection)
  return L + (rm - tm) * 0.35 * amt;
}
function harmonize(img, p, st, ref) {
  const s = clamp(num(p.strength, 50), 0, 100) / 100, t = 1 - (1 - s) * (1 - s);
  const tgt = st || labStats(img);
  const [L, A, B] = imgToLab(img), n = L.length;
  if (ref && !ref.empty && t > 0) {
    const ra = clamp(ref.std[1] / tgt.std[1], 0.5, 2.2), rb = clamp(ref.std[2] / tgt.std[2], 0.5, 2.2), rl = clamp(ref.std[0] / tgt.std[0], 0.8, 1.25);
    for (let i = 0; i < n; i++) {
      const l2 = tgt.mean[0] + (L[i] - tgt.mean[0]) * rl;
      L[i] = lerp(L[i], lumaGuard(l2, tgt.mean[0], ref.mean[0], 1), t);
      A[i] = lerp(A[i], ref.mean[1] + (A[i] - tgt.mean[1]) * ra, t);
      B[i] = lerp(B[i], ref.mean[2] + (B[i] - tgt.mean[2]) * rb, t);
    }
  }
  const sat = 1 + clamp(num(p.saturation, 0), -50, 50) / 50, br = clamp(num(p.brightness, 0), -50, 50) * 0.4;
  if (sat !== 1 || br) for (let i = 0; i < n; i++) { A[i] *= sat; B[i] *= sat; L[i] = clamp(L[i] + br * (1 - Math.abs(L[i] - 50) / 120), 0, 100); }
  const out = labToImg(L, A, B, img);
  return colorBalance(out, num(p.cyanRed, 0), num(p.magentaGreen, 0), num(p.yellowBlue, 0));
}

// ---------- Color Transfer ----------
export const COLOR_PRESETS = {
  goldenHour: { label: 'Golden Hour', colors: [[255, 190, 90, 2], [240, 130, 60, 2], [120, 60, 70, 1], [60, 40, 60, 1], [255, 230, 170, 1]] },
  tealOrange: { label: 'Teal & Orange', colors: [[20, 80, 95, 2], [40, 120, 130, 1], [230, 150, 90, 2], [250, 200, 150, 1], [15, 35, 45, 1]] },
  moodyBlue: { label: 'Moody Blue', colors: [[20, 30, 55, 2], [50, 75, 110, 2], [120, 145, 175, 1], [200, 210, 225, 1]] },
  forest: { label: 'Forest', colors: [[25, 45, 25, 2], [60, 95, 45, 2], [140, 160, 90, 1], [210, 210, 160, 1], [80, 60, 35, 1]] },
  pastel: { label: 'Pastel', colors: [[245, 200, 210, 2], [200, 220, 245, 2], [230, 240, 200, 1], [250, 235, 210, 1], [190, 180, 210, 1]] },
  vintage: { label: 'Vintage Film', colors: [[90, 80, 60, 2], [170, 150, 110, 2], [225, 210, 170, 1], [60, 70, 65, 1], [200, 120, 90, 1]] },
  neonNight: { label: 'Neon Night', colors: [[30, 10, 60, 2], [220, 40, 160, 1], [40, 200, 230, 1], [15, 15, 35, 2], [250, 120, 220, 1]] },
};
function colorTransfer(img, p, st, ref) {
  if (!ref || ref.empty) return copyImg(img);
  const tgt = st || labStats(img);
  const lumAmt = p.preserveLuminance ? 0 : clamp(num(p.luminance, 50), 0, 100) / 100;
  const ci = clamp(num(p.intensity, 50), 0, 100) / 50; // 1 = plain Reinhard
  const sat = 1 + clamp(num(p.saturation, 0), -50, 50) / 50, fade = clamp(num(p.fade, 0), 0, 100) / 100;
  const [L, A, B] = imgToLab(img), n = L.length;
  const rl = clamp(ref.std[0] / tgt.std[0], 0.4, 2.5), ra = clamp(ref.std[1] / tgt.std[1], 0.2, 5) * ci, rb = clamp(ref.std[2] / tgt.std[2], 0.2, 5) * ci;
  const mix = 1 - fade;
  for (let i = 0; i < n; i++) {
    const l2 = clamp(ref.mean[0] + (L[i] - tgt.mean[0]) * rl, 0, 100);
    const a2 = (ref.mean[1] + (A[i] - tgt.mean[1]) * ra) * sat, b2 = (ref.mean[2] + (B[i] - tgt.mean[2]) * rb) * sat;
    L[i] = lerp(L[i], lerp(L[i], l2, lumAmt), mix); A[i] = lerp(A[i], a2, mix); B[i] = lerp(B[i], b2, mix);
  }
  return labToImg(L, A, B, img);
}

// ---------- Depth Blur ----------
function depthBlur(img, p, st, ctx, depth) {
  const w = img.width, h = img.height, n = w * h;
  if (!depth) return copyImg(img);
  if (p.depthOnly) { const out = copyImg(img), d = out.data; for (let i = 0; i < n; i++) { const v = depth[i] * 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255; } return out; }
  const fd = clamp(num(p.focalDistance, 0), 0, 100) / 100, range = clamp(num(p.focalRange, 50), 0, 100) / 100;
  const strength = clamp(num(p.blurStrength, 50), 0, 100) / 100;
  const maxR = strength * 0.028 * Math.max(ctx.fullW, ctx.fullH) * ctx.scale;
  const band = 0.02 + range * 0.32;
  // circle of confusion (0..1) per pixel; dist: 0 = near, 1 = far
  const coc = new Float32Array(n);
  for (let i = 0; i < n; i++) { const dist = 1 - depth[i], dd = Math.abs(dist - fd); coc[i] = smooth(band * 0.5, band * 0.5 + 0.35, dd); }
  // let foreground blur spread over in-focus background (cheap dilation of near CoC)
  const fg = new Float32Array(n); for (let i = 0; i < n; i++) fg[i] = (1 - depth[i]) < fd ? coc[i] : 0;
  if (maxR > 1) { blurPlane(fg, w, h, maxR * 0.35); for (let i = 0; i < n; i++) coc[i] = Math.max(coc[i], Math.min(1, fg[i] * 1.6)); }
  let out;
  if (maxR < 0.6) out = copyImg(img);
  else {
    const K = maxR > 24 ? 7 : maxR > 8 ? 5 : 3;
    const radii = []; for (let k = 0; k < K; k++) radii.push(maxR * Math.pow(k / (K - 1), 1.35));
    // linear-light planes
    const d = img.data, lin = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) lin[c][i] = LIN[d[i * 4 + c]];
    const acc = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], accW = new Float32Array(n);
    const R = coc; for (let i = 0; i < n; i++) R[i] *= maxR; // CoC radius in px (in place)
    const tmp = fg, Wp = new Float32Array(n), P = new Float32Array(n), lw = new Float32Array(n), Wb = new Float32Array(n);
    for (let k = 0; k < K; k++) {
      // interpolation weight of this level for each pixel
      let any = false;
      for (let i = 0; i < n; i++) {
        const r = R[i]; let wgt = 0;
        if (k === 0) wgt = r <= radii[1] ? 1 - r / radii[1] : 0;
        else if (k === K - 1) wgt = r >= radii[k - 1] ? clamp((r - radii[k - 1]) / (radii[k] - radii[k - 1]), 0, 1) : 0;
        else wgt = r >= radii[k - 1] && r <= radii[k + 1] ? (r <= radii[k] ? (r - radii[k - 1]) / (radii[k] - radii[k - 1]) : 1 - (r - radii[k]) / (radii[k + 1] - radii[k])) : 0;
        lw[i] = wgt; if (wgt > 0) any = true;
      }
      if (!any) continue;
      if (k === 0) { for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) acc[c][i] += lin[c][i] * lw[i]; for (let i = 0; i < n; i++) accW[i] += lw[i]; continue; }
      // normalised convolution: in-focus (sharp) pixels don't bleed into the blurred background
      const rk = radii[k], b = Math.max(1, rk * 0.6);
      for (let i = 0; i < n; i++) Wp[i] = 0.02 + smooth(rk * 0.25, rk * 0.6, R[i]);
      Wb.set(Wp); boxPlane(Wb, w, h, b, tmp); boxPlane(Wb, w, h, b, tmp);
      for (let c = 0; c < 3; c++) {
        for (let i = 0; i < n; i++) P[i] = lin[c][i] * Wp[i];
        boxPlane(P, w, h, b, tmp); boxPlane(P, w, h, b, tmp);
        for (let i = 0; i < n; i++) if (lw[i] > 0) acc[c][i] += (P[i] / Wb[i]) * lw[i];
      }
      for (let i = 0; i < n; i++) accW[i] += lw[i];
    }
    out = copyImg(img); const o = out.data;
    for (let i = 0; i < n; i++) { const wt = accW[i] || 1; for (let c = 0; c < 3; c++) o[i * 4 + c] = toSrgb(acc[c][i] / wt); }
  }
  // haze (distance-weighted), warmth, brightness, saturation, grain
  const haze = clamp(num(p.haze, 0), 0, 100) / 100, warm = clamp(num(p.warmth, 0), -50, 50), bri = clamp(num(p.brightness, 0), -50, 50) / 50, sat = clamp(num(p.saturation, 0), -50, 50) / 50, grain = clamp(num(p.grain, 0), 0, 100) / 100;
  const hc = (st && st.hazeColor) || [215, 222, 230];
  const o = out.data, rnd = rng(ctx.seed || 7);
  for (let i = 0; i < n; i++) {
    let r = o[i * 4], g = o[i * 4 + 1], b = o[i * 4 + 2];
    if (haze > 0) { const f = haze * 0.85 * Math.pow(1 - depth[i], 1.3); r = lerp(r, hc[0], f); g = lerp(g, hc[1], f); b = lerp(b, hc[2], f); }
    if (warm) { r += warm * 0.7; b -= warm * 0.7; g += warm * 0.1; }
    if (bri) { const k = 1 + bri * 0.5; r *= k; g *= k; b *= k; }
    if (sat) { const y = lum(r, g, b), k = 1 + sat; r = y + (r - y) * k; g = y + (g - y) * k; b = y + (b - y) * k; }
    if (grain > 0) { const u = (rnd() + rnd() + rnd() - 1.5) * grain * 40; r += u; g += u; b += u; }
    o[i * 4] = r; o[i * 4 + 1] = g; o[i * 4 + 2] = b;
  }
  return out;
}
function hazeColorOf(img) { // average of the brightest 3% (sky / atmosphere)
  const N = img.width * img.height, st = Math.max(1, Math.floor(N / 200000)), n = Math.ceil(N / st), d = img.data, ys = new Float32Array(n);
  for (let k = 0; k < n; k++) { const i = k * st; ys[k] = lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]); }
  const thr = Float32Array.from(ys).sort()[Math.floor(n * 0.97)] || 255;
  let r = 0, g = 0, b = 0, c = 0; for (let k = 0; k < n; k++) if (ys[k] >= thr) { const i = k * st; r += d[i * 4]; g += d[i * 4 + 1]; b += d[i * 4 + 2]; c++; }
  if (!c) return [215, 222, 230];
  const m = [r / c, g / c, b / c]; return m.map((v, k) => lerp(v, [225, 230, 236][k], 0.4));
}

// ---------- Colorize (user-guided, edge-aware; no AI model) ----------
export const COLORIZE_PROFILES = {
  none: { label: 'None' },
  sepia: { label: 'Sepia', fn: (l) => [6 + l * 0.04, 18 + l * 0.08] },
  warmVintage: { label: 'Warm Vintage', fn: (l) => [lerp(9, 4, l / 100), lerp(10, 26, l / 100)] },
  coolFilm: { label: 'Cool Film', fn: (l) => [lerp(-6, -1, l / 100), lerp(-16, -4, l / 100)] },
  retro: { label: 'Retro Split-Tone', fn: (l) => [lerp(-10, 8, l / 100), lerp(-14, 24, l / 100)] },
  handTinted: { label: 'Hand Tinted', fn: (l) => [lerp(4, 14, smooth(30, 80, l)), lerp(6, 22, smooth(20, 90, l))] },
};
// Geodesic distance from seed points on a small luminance grid (edge-aware: steps across strong edges cost a lot).
export function geodesic(Lp, w, h, seeds, beta = 2.5, iters = 3) {
  const D = new Float32Array(w * h).fill(1e9);
  for (const [sx, sy] of seeds) { const x = clamp(Math.round(sx), 0, w - 1), y = clamp(Math.round(sy), 0, h - 1); D[y * w + x] = 0; }
  const cost = (i, j, base) => base + beta * Math.abs(Lp[i] - Lp[j]);
  const fw = [[-1, 0, 1], [0, -1, 1], [-1, -1, 1.414], [1, -1, 1.414]];
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let v = D[i];
      for (const [dx, dy, b] of fw) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w) continue; const j = yy * w + xx, c = D[j] + cost(i, j, b); if (c < v) v = c; }
      D[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let v = D[i];
      for (const [dx, dy, b] of fw) { const xx = x - dx, yy = y - dy; if (xx < 0 || yy >= h || xx >= w) continue; const j = yy * w + xx, c = D[j] + cost(i, j, b); if (c < v) v = c; }
      D[i] = v;
    }
  }
  return D;
}
function colorizeStats(img, p) {
  const pts = (p.points || []).filter(q => q && q.color);
  if (!pts.length) return null;
  const S = 200, s = Math.min(1, S / Math.max(img.width, img.height)), gw = Math.max(1, Math.round(img.width * s)), gh = Math.max(1, Math.round(img.height * s));
  const small = resizeImg(img, gw, gh), [L] = imgToLab(small); blurPlane(L, gw, gh, 1.4); // structure, not texture
  const diag = Math.hypot(gw, gh), tau = diag * 0.03, R = diag * 1.3;
  const dists = pts.map(q => geodesic(L, gw, gh, [[q.x * gw - 0.5, q.y * gh - 0.5]], 2.2));
  const cols = pts.map(q => hexToLab(q.color));
  const n = gw * gh, A = new Float32Array(n), B = new Float32Array(n), W = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let dmin = 1e9; for (const D of dists) if (D[i] < dmin) dmin = D[i];
    let sw = 0, sa = 0, sb = 0;
    for (let k = 0; k < pts.length; k++) { const e = Math.exp(-(dists[k][i] - dmin) / tau); sw += e; sa += e * cols[k][1]; sb += e * cols[k][2]; }
    A[i] = sa / sw; B[i] = sb / sw; W[i] = Math.exp(-Math.pow(dmin / R, 2));
  }
  return { gw, gh, A, B, W };
}
function colorize(img, p, st, ctx) {
  const w = img.width, h = img.height, n = w * h;
  const [L, A, B] = imgToLab(img);
  const prof = COLORIZE_PROFILES[p.profile] || COLORIZE_PROFILES.none, ps = clamp(num(p.profileStrength, 50), 0, 100) / 100;
  const hasPts = st && st.A, keep = !!p.keepColors || (!hasPts && !prof.fn);
  // base chroma: original colours (if kept) blended with the profile tint
  const baseA = new Float32Array(n), baseB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let a = keep ? A[i] : 0, b = keep ? B[i] : 0;
    if (prof.fn) { const [pa, pb] = prof.fn(L[i]); a = lerp(a, pa + (keep ? A[i] : 0), ps); b = lerp(b, pb + (keep ? B[i] : 0), ps); }
    baseA[i] = a; baseB[i] = b;
  }
  let CA = baseA, CB = baseB;
  if (hasPts) {
    // map this image (region of the full frame) into the propagation grid
    const sx = st.gw / ctx.fullW, sy = st.gh / ctx.fullH, rg = ctx.region;
    const pa = samplePlane(st.A, st.gw, st.gh, rg.x * sx, rg.y * sy, rg.w * sx, rg.h * sy, w, h);
    const pb = samplePlane(st.B, st.gw, st.gh, rg.x * sx, rg.y * sy, rg.w * sx, rg.h * sy, w, h);
    const pw = samplePlane(st.W, st.gw, st.gh, rg.x * sx, rg.y * sy, rg.w * sx, rg.h * sy, w, h);
    // edge-aware refinement against this image's luminance (joint guided upsampling)
    const Ln = new Float32Array(n); for (let i = 0; i < n; i++) Ln[i] = L[i] / 100;
    const r = Math.max(2, Math.round(Math.max(w, h) / 150)), eps = 1e-3;
    const ga = guidedFilter(Ln, pa, w, h, r, eps), gb = guidedFilter(Ln, pb, w, h, r, eps), gwt = guidedFilter(Ln, pw, w, h, r, eps);
    CA = new Float32Array(n); CB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = clamp(gwt[i], 0, 1); let ta = 0, tb = 0;
      if (prof.fn) { const [pa, pb] = prof.fn(L[i]); ta = pa * ps * 0.7 * t; tb = pb * ps * 0.7 * t; } // profile tints the guided colours too
      CA[i] = lerp(baseA[i], ga[i], t) + ta; CB[i] = lerp(baseB[i], gb[i], t) + tb;
    }
  }
  const car = clamp(num(p.artifactReduction, 30), 0, 100) / 100;
  if (car > 0 && hasPts) { const s = car * Math.max(w, h) / 250; blurPlane(CA, w, h, s); blurPlane(CB, w, h, s); }
  const sat = 1 + clamp(num(p.saturation, 0), -50, 50) / 50;
  const cr = num(p.cyanRed, 0) * 0.5, mg = num(p.magentaGreen, 0) * 0.5, yb = num(p.yellowBlue, 0) * 0.5;
  for (let i = 0; i < n; i++) {
    // chroma falls off in deep shadows / highlights (real colour photos do the same)
    const f = smooth(2, 18, L[i]) * (1 - 0.6 * smooth(85, 100, L[i]));
    A[i] = (CA[i] * f) * sat + (cr - mg * 0.9) * f; B[i] = (CB[i] * f) * sat + (-yb + mg * 0.25 + cr * 0.15) * f;
  }
  return labToImg(L, A, B, img);
}

// ---------- Style Transfer (artistic styles; no AI model) ----------
// Smooth generalised Kuwahara (4 quadrants, variance-weighted) — flat paint patches with crisp boundaries.
export function kuwahara(R, G, B, w, h, r) {
  const n = w * h, q = Math.max(1, Math.ceil(r / 2)), tmp = new Float32Array(n);
  const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = lum(R[i], G[i], B[i]) / 255;
  const mY = boxPlane(Float32Array.from(Y), w, h, q, tmp), YY = Y.map(v => v * v); boxPlane(YY, w, h, q, tmp);
  const mR = boxPlane(Float32Array.from(R), w, h, q, tmp), mG = boxPlane(Float32Array.from(G), w, h, q, tmp), mB = boxPlane(Float32Array.from(B), w, h, q, tmp);
  const oR = new Float32Array(n), oG = new Float32Array(n), oB = new Float32Array(n), offs = [[-q, -q], [q, -q], [-q, q], [q, q]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sw = 0, r2 = 0, g2 = 0, b2 = 0;
    for (const [dx, dy] of offs) {
      const j = clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1), v = Math.max(0, YY[j] - mY[j] * mY[j]), wt = 1 / ((v + 2e-4) * (v + 2e-4));
      sw += wt; r2 += mR[j] * wt; g2 += mG[j] * wt; b2 += mB[j] * wt;
    }
    const i = y * w + x; oR[i] = r2 / sw; oG[i] = g2 / sw; oB[i] = b2 / sw;
  }
  return [oR, oG, oB];
}
export const STYLES = { painting: 'Oil Painting', watercolor: 'Watercolor', comic: 'Comic', ink: 'Ink Drawing', pencil: 'Pencil Sketch' };
function abstraction(img, r, iters, eps) { // iterated edge-preserving smoothing (cartoon-like flattening)
  const w = img.width, h = img.height, n = w * h; let [R, G, B] = planesRGB(img);
  for (let it = 0; it < iters; it++) {
    const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = lum(R[i], G[i], B[i]) / 255;
    [R, G, B] = [R, G, B].map(P => { const Pn = P.map(v => v / 255), q = guidedFilter(Y, Pn, w, h, r, eps); return q.map(v => v * 255); });
  }
  return [R, G, B];
}
function xdogLines(Y, w, h, sigma, sharp = 20, thr = 0.985) { // eXtended DoG edge lines, 0 = line, 1 = paper
  const a = Float32Array.from(Y), b = Float32Array.from(Y); blurPlane(a, w, h, sigma); blurPlane(b, w, h, sigma * 1.6);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) { const d = (a[i] - 0.98 * b[i]) / 255 + 0.02; const u = d / 0.02; out[i] = u >= thr ? 1 : 1 + Math.tanh(sharp * (u - thr)); }
  return out;
}
function styleTransfer(img, p, ctx) {
  const style = STYLES[p.style] ? p.style : 'painting', amt = clamp(num(p.strength, 80), 0, 100) / 100, brush = clamp(num(p.brush, 50), 0, 100) / 100;
  const w = img.width, h = img.height, n = w * h, long = Math.max(ctx.fullW, ctx.fullH), sc = ctx.scale;
  const r = Math.max(1, Math.round((1.5 + brush * 0.006 * long) * sc)), Y = planeY(img);
  const rnd = rng(11), paper = new Float32Array(n); for (let i = 0; i < n; i++) paper[i] = rnd(); blurPlane(paper, w, h, Math.max(0.6, 1.2 * sc * long / 2000));
  let R, G, B;
  if (style === 'painting') {
    [R, G, B] = planesRGB(img);
    for (let it = 0; it < 2; it++) [R, G, B] = kuwahara(R, G, B, w, h, Math.max(1, Math.round(r * (it ? 0.6 : 1))));
    const Yp = new Float32Array(n); for (let i = 0; i < n; i++) Yp[i] = lum(R[i], G[i], B[i]);
    const e = Float32Array.from(Yp); blurPlane(e, w, h, Math.max(0.7, r * 0.3));
    for (let i = 0; i < n; i++) { const relief = (Yp[i] - e[i]) * 0.6 + (paper[i] - 0.5) * 18; const y = Yp[i]; for (const P of [R, G, B]) P[i] = y + (P[i] - y) * 1.18 + relief; }
  } else if (style === 'watercolor') {
    [R, G, B] = abstraction(img, Math.max(1, Math.round(r * 1.4)), 2, 0.01 + brush * 0.02);
    const Yp = new Float32Array(n); for (let i = 0; i < n; i++) Yp[i] = lum(R[i], G[i], B[i]);
    const edges = xdogLines(Yp, w, h, Math.max(0.8, r * 0.35), 8, 0.97); blurPlane(edges, w, h, Math.max(0.6, r * 0.25));
    for (let i = 0; i < n; i++) { const wash = 0.82 + 0.18 * edges[i], tex = 1 - (paper[i] - 0.5) * 0.18; for (const P of [R, G, B]) P[i] = (255 - (255 - P[i]) * 0.85 * (2 - wash)) * tex; }
  } else if (style === 'comic') {
    [R, G, B] = abstraction(img, r, 2, 0.006 + brush * 0.01);
    const lines = xdogLines(Y, w, h, Math.max(0.7, 0.9 * sc * long / 1500), 30, 0.99);
    for (let i = 0; i < n; i++) { const y = lum(R[i], G[i], B[i]), q = Math.round(y / 255 * 5) / 5 * 255, k = y > 1 ? q / y : 1; for (const P of [R, G, B]) { const v = P[i] * k; P[i] = (q + (v - q) * 1.35) * (lines[i] < 0.6 ? 0.15 : 1); } }
  } else { // ink / pencil
    const lines = xdogLines(Y, w, h, Math.max(0.6, (0.6 + brush * 1.5) * sc * long / 1500), style === 'ink' ? 40 : 6, style === 'ink' ? 0.99 : 0.96);
    R = new Float32Array(n); G = new Float32Array(n); B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const tex = 247 - paper[i] * 14, shade = style === 'pencil' ? 0.55 + 0.45 * smooth(30, 200, Y[i]) : 1, v = tex * lines[i] * shade; R[i] = v; G[i] = v * 0.99; B[i] = v * 0.96; }
  }
  const out = copyImg(img), o = out.data, d = img.data;
  for (let i = 0; i < n; i++) {
    let r2 = R[i], g2 = G[i], b2 = B[i];
    if (p.preserveColor) { const y2 = lum(r2, g2, b2), y0 = Y[i]; r2 = d[i * 4] - y0 + y2; g2 = d[i * 4 + 1] - y0 + y2; b2 = d[i * 4 + 2] - y0 + y2; }
    o[i * 4] = lerp(d[i * 4], r2, amt); o[i * 4 + 1] = lerp(d[i * 4 + 1], g2, amt); o[i * 4 + 2] = lerp(d[i * 4 + 2], b2, amt);
  }
  return out;
}

// ---------- Super Zoom (tiling + post-processing; model injected) ----------
/**
 * Tile an image through an upscaler. runTile(img) must return an image `scale`× larger (it may be padded; extra is cropped).
 * Each tile carries `pad` px of context that is discarded, so there are no seams.
 */
export async function tiledUpscale(img, scale, runTile, { tile = 256, pad = 16, onProgress, abort, outScale = scale } = {}) {
  const W = img.width, H = img.height, OW = Math.round(W * outScale), OH = Math.round(H * outScale);
  const out = newImg(OW, OH), od = out.data;
  const nx = Math.ceil(W / tile), ny = Math.ceil(H / tile), total = nx * ny; let done = 0;
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    if (abort && abort()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    const cx = tx * tile, cy = ty * tile, cw = Math.min(tile, W - cx), ch = Math.min(tile, H - cy);
    const x0 = Math.max(0, cx - pad), y0 = Math.max(0, cy - pad), x1 = Math.min(W, cx + cw + pad), y1 = Math.min(H, cy + ch + pad);
    const inp = cropImg(img, x0, y0, x1 - x0, y1 - y0);
    let res = await runTile(inp);
    if (res.width !== inp.width * scale || res.height !== inp.height * scale) res = cropImg(res, 0, 0, inp.width * scale, inp.height * scale); // model padding
    if (outScale !== scale) res = resizeImg(res, inp.width * outScale, inp.height * outScale);
    const S = outScale, ox = Math.round((cx - x0) * S), oy = Math.round((cy - y0) * S), dx0 = Math.round(cx * S), dy0 = Math.round(cy * S);
    const tw = Math.round((cx + cw) * S) - dx0, th = Math.round((cy + ch) * S) - dy0;
    for (let y = 0; y < th; y++) {
      const sy = Math.min(res.height - 1, oy + y), dy = dy0 + y;
      for (let x = 0; x < tw; x++) {
        const sx = Math.min(res.width - 1, ox + x), s = (sy * res.width + sx) * 4, d = (dy * OW + dx0 + x) * 4;
        od[d] = res.data[s]; od[d + 1] = res.data[s + 1]; od[d + 2] = res.data[s + 2]; od[d + 3] = 255;
      }
    }
    done++; onProgress && onProgress(done / total);
  }
  // alpha: upscale separately (models are RGB only)
  let opaque = true; for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) { opaque = false; break; }
  if (!opaque) { const a = resizeBicubic(img, OW, OH).data; for (let i = 3; i < od.length; i += 4) od[i] = a[i]; }
  return out;
}
/** Non-AI upscale fallback: bicubic + mild luminance sharpening. */
export function classicUpscale(img, scale) {
  const out = resizeBicubic(img, img.width * scale, img.height * scale);
  return sharpenLuma(out, 0.45, 0.8 * scale / 2);
}
export function sharpenLuma(img, amount, sigma) {
  if (amount <= 0) return img;
  const w = img.width, h = img.height, n = w * h, Y = planeY(img), B = Float32Array.from(Y); blurPlane(B, w, h, Math.max(0.5, sigma));
  const out = copyImg(img), d = out.data;
  for (let i = 0; i < n; i++) { const dlt = clamp((Y[i] - B[i]) * amount, -40, 40); d[i * 4] += dlt; d[i * 4 + 1] += dlt; d[i * 4 + 2] += dlt; }
  return out;
}
export function superZoomPost(img, p) {
  let out = img;
  const nr = clamp(num(p.noise, 0), 0, 100) / 100, sh = clamp(num(p.sharpen, 0), 0, 100) / 100;
  if (nr > 0) out = denoiseLuma(out, nr * 0.8, nr * 0.6, 1);
  if (p.enhance) out = sharpenLuma(out, 0.35, 2.2);
  if (sh > 0) out = sharpenLuma(out, sh * 1.2, 1);
  return out;
}
/** Which model a Super Zoom setting needs + the resize after it. */
export function superZoomPlan(p) {
  const scale = Number(p.scale) === 4 ? 4 : 2;
  if (p.jpeg) return { model: 'jpeg', modelScale: 4, scale, post: scale / 4 };
  return { model: scale === 4 ? 'sr4' : 'sr2', modelScale: scale, scale, post: 1 };
}
/** Upscale through the AI model per plan; downsample if the model scale exceeds the target. */
export async function runSuperZoom(img, p, upscaler, opts = {}) {
  const plan = superZoomPlan(p);
  const out = upscaler ? await tiledUpscale(img, plan.modelScale, upscaler, { tile: plan.modelScale >= 4 ? 160 : 256, outScale: plan.scale, ...opts }) : classicUpscale(img, plan.scale);
  return superZoomPost(out, p);
}

// ===========================================================================
// Registry (UI metadata + engine hooks). Order = processing order of a stack.
// ===========================================================================
const S = (key, label, min, max, def, extra = {}) => ({ key, type: 'range', label, min, max, default: def, ...extra });
export const NEURAL_GROUPS = ['Portraits', 'Creative', 'Color', 'Photography', 'Restoration'];
export const NEURAL_FILTERS = {
  jpegArtifacts: {
    name: 'JPEG Artifacts Removal', group: 'Restoration', model: 'jpeg', optionalModel: true,
    desc: 'Remove blocky artifacts and ringing caused by JPEG compression.',
    params: [{ key: 'strength', type: 'select', label: 'Strength', options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], default: 'medium' }, { key: 'useAI', type: 'check', label: 'Use AI model (Swin2SR) when available', default: true }],
    apply: (img, p, st, ctx) => jpegArtifacts(img, p, ctx),
  },
  photoRestoration: {
    name: 'Photo Restoration', group: 'Restoration',
    desc: 'Restore old photos: boost contrast, reduce scratches, noise and print artifacts.',
    params: [S('enhance', 'Photo enhancement', 0, 100, 50), S('scratch', 'Scratch reduction', 0, 100, 25), { type: 'header', label: 'Adjustments' }, S('noise', 'Noise reduction', 0, 100, 0), S('colorNoise', 'Color noise reduction', 0, 100, 0), S('halftone', 'Halftone artifacts reduction', 0, 100, 0), S('jpeg', 'JPEG artifacts reduction', 0, 100, 0)],
    stats: (img) => lumPercentiles(img),
    apply: (img, p, st, ctx) => photoRestoration(img, p, st, ctx),
  },
  skinSmoothing: {
    name: 'Skin Smoothing', group: 'Portraits',
    desc: 'Remove blemishes and smooth skin. Works on skin-toned areas of the image.',
    params: [S('blur', 'Blur', 0, 100, 50), S('smoothness', 'Smoothness', -50, 50, 0)],
    apply: (img, p, st, ctx) => skinSmoothing(img, p, ctx),
  },
  colorize: {
    name: 'Colorize', group: 'Color', guided: true,
    desc: 'Guided colorize (no AI model): pick a color and click the image to drop focus points — color spreads up to strong edges. Profiles add a global tint.',
    params: [{ type: 'points' }, { key: 'profile', type: 'select', label: 'Profile', options: Object.entries(COLORIZE_PROFILES).map(([k, v]) => [k, v.label]), default: 'none' }, S('profileStrength', 'Profile strength', 0, 100, 50), S('saturation', 'Saturation', -50, 50, 0), { type: 'header', label: 'Adjustments' }, S('cyanRed', 'Cyan', -50, 50, 0, { right: 'Red' }), S('magentaGreen', 'Magenta', -50, 50, 0, { right: 'Green' }), S('yellowBlue', 'Yellow', -50, 50, 0, { right: 'Blue' }), S('artifactReduction', 'Color artifact reduction', 0, 100, 30), { key: 'keepColors', type: 'check', label: 'Keep existing colors', default: false }],
    stats: (img, p) => colorizeStats(img, p),
    apply: (img, p, st, ctx) => colorize(img, p, st, ctx),
  },
  harmonization: {
    name: 'Harmonization', group: 'Color', needsRef: 'layer',
    desc: 'Harmonize the luminance and color of the current layer with a reference layer to make a seamless composite.',
    params: [{ key: 'ref', type: 'layerRef', label: 'Reference' }, S('strength', 'Strength', 0, 100, 50), { type: 'header', label: 'Adjustments' }, S('cyanRed', 'Cyan', -50, 50, 0, { right: 'Red' }), S('magentaGreen', 'Magenta', -50, 50, 0, { right: 'Green' }), S('yellowBlue', 'Yellow', -50, 50, 0, { right: 'Blue' }), S('saturation', 'Saturation', -50, 50, 0), S('brightness', 'Brightness', -50, 50, 0)],
    stats: (img) => labStats(img),
    apply: (img, p, st, ctx) => harmonize(img, p, st, ctx.refStats && ctx.refStats('harmonization', p)),
  },
  styleTransfer: {
    name: 'Style Transfer', group: 'Creative',
    desc: 'Give the image an artistic look. Built-in styles rendered with edge-aware filters (no AI model).',
    params: [{ key: 'style', type: 'styles', label: 'Style', options: Object.entries(STYLES), default: 'painting' }, S('strength', 'Style strength', 0, 100, 80), S('brush', 'Brush size', 0, 100, 50), { key: 'preserveColor', type: 'check', label: 'Preserve color', default: false }],
    apply: (img, p, st, ctx) => styleTransfer(img, p, ctx),
  },
  colorTransfer: {
    name: 'Color Transfer', group: 'Color', needsRef: 'any',
    desc: 'Transfer the color palette of a reference image (preset, layer or file) to your image.',
    params: [{ key: 'ref', type: 'colorRef', label: 'Reference' }, S('luminance', 'Luminance', 0, 100, 50), S('intensity', 'Color Intensity', 0, 100, 50), S('saturation', 'Saturation', -50, 50, 0), S('fade', 'Fade', 0, 100, 0), { key: 'preserveLuminance', type: 'check', label: 'Preserve luminance', default: false }],
    stats: (img) => labStats(img),
    apply: (img, p, st, ctx) => colorTransfer(img, p, st, ctx.refStats && ctx.refStats('colorTransfer', p)),
  },
  depthBlur: {
    name: 'Depth Blur', group: 'Photography', model: 'depth', clickable: true,
    desc: 'Create environmental depth with a lens-like blur. Click the preview to set the focal point.',
    params: [{ type: 'focal' }, S('focalDistance', 'Focal distance', 0, 100, 0), S('focalRange', 'Focal range', 0, 100, 50), S('blurStrength', 'Blur strength', 0, 100, 50), S('haze', 'Haze', 0, 100, 0), S('warmth', 'Warmth', -50, 50, 0), S('brightness', 'Brightness', -50, 50, 0), S('saturation', 'Saturation', -50, 50, 0), S('grain', 'Grain', 0, 100, 0), { key: 'depthOnly', type: 'check', label: 'Output depth map only', default: false }],
    stats: (img) => ({ hazeColor: hazeColorOf(img) }),
    apply: (img, p, st, ctx) => depthBlur(img, p, st, ctx, ctx.depth ? ctx.depth(img) : null),
  },
  superZoom: {
    name: 'Super Zoom', group: 'Photography', model: 'sr', resizes: true,
    desc: 'Zoom in while keeping detail. Output is always a new, larger document.',
    params: [{ key: 'scale', type: 'seg', label: 'Zoom', options: [[2, '×2'], [4, '×4']], default: 2 }, { key: 'enhance', type: 'check', label: 'Enhance image details', default: true }, { key: 'jpeg', type: 'check', label: 'Remove JPEG artifacts', default: false }, S('noise', 'Noise reduction', 0, 100, 0), S('sharpen', 'Sharpen', 0, 100, 0)],
    // applied separately (after the stack) by the caller: runSuperZoom()
  },
};
export const STACK_ORDER = ['jpegArtifacts', 'photoRestoration', 'skinSmoothing', 'colorize', 'harmonization', 'colorTransfer', 'styleTransfer', 'depthBlur', 'superZoom'];
export function defaultNeuralParams(id) {
  const p = {}; for (const s of NEURAL_FILTERS[id].params) if (s.key && 'default' in s) p[s.key] = s.default;
  if (id === 'colorize') { p.points = []; p.color = '#d9822b'; }
  if (id === 'depthBlur') p.focalPoint = null;
  return p;
}

/**
 * Run the enabled filters (except Super Zoom) in STACK_ORDER.
 * stack: [{id, params}] (any order). statsList: optional precomputed per-filter stats (crop previews).
 * Returns { img, stats } where stats[id] is what each filter computed on its (full-frame) input.
 */
export async function runStack(img, stack, ctx, statsList = null, onStep) {
  const ordered = STACK_ORDER.filter(id => id !== 'superZoom').map(id => stack.find(s => s.id === id)).filter(Boolean);
  const stats = {};
  let cur = img;
  for (let i = 0; i < ordered.length; i++) {
    const { id, params } = ordered[i], F = NEURAL_FILTERS[id];
    if (ctx.abort && ctx.abort()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    onStep && onStep(i / ordered.length, F.name);
    const st = statsList && id in statsList ? statsList[id] : (F.stats ? F.stats(cur, params, ctx) : null);
    stats[id] = st;
    cur = await F.apply(cur, params, st, ctx);
    if (onStep) await new Promise(r => setTimeout(r, 0)); // yield so the UI can paint progress
  }
  return { img: cur === img ? copyImg(img) : cur, stats };
}
/** Per-pixel change mask (0..255) for "New Layer Masked". */
export function changeMask(a, b) {
  const w = a.width, h = a.height, n = w * h, M = new Float32Array(n);
  for (let i = 0; i < n; i++) M[i] = Math.abs(a.data[i * 4] - b.data[i * 4]) + Math.abs(a.data[i * 4 + 1] - b.data[i * 4 + 1]) + Math.abs(a.data[i * 4 + 2] - b.data[i * 4 + 2]);
  blurPlane(M, w, h, Math.max(1.5, Math.max(w, h) / 500));
  const s = Float32Array.from(M).sort(), hi = Math.max(6, s[Math.floor(n * 0.98)]);
  const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = clamp(Math.round(smooth(1.5, hi * 0.6, M[i]) * 255), 0, 255);
  return out;
}
