// Strata — Camera Raw engine (pure math, no DOM). Runs in Node and module Web Workers.
// Images are {data: Uint8ClampedArray RGBA (non-premultiplied), width, height}.
//
//   defaultRawSettings()                 -> settings (all neutral; applying them is an exact identity)
//   applyCameraRaw(img, settings, opts?) -> {data,width,height} (new image, same size)
//   autoRawSettings(img)                 -> partial settings (tone + presence, like "Auto")
//   autoWhiteBalance(img)                -> {temperature, tint}
//   rawHistogram(img)                    -> {r,g,b,l} Uint32Array(256) each (pixels with alpha > 0)
//
// opts (all optional) — used by the dialog so previews match the final render:
//   scale:    resolution of `img` relative to the final full-res image (preview: <1). Absolute pixel
//             radii (sharpening, noise reduction, grain) are multiplied by it.
//   region:   {x,y,width,height} — render only this rectangle of `img` (returns that size).
//   guide:    a (usually downscaled) copy of the whole image, used for the low-frequency guides
//             (shadows/highlights mask, clarity, dehaze) when `region` is set.
//   view:     'sharpenMask' -> grayscale sharpening edge mask instead of the image.
//   onProgress(f) 0..1
//
// Pipeline (roughly Camera Raw order):
//   geometry (lens distortion, perspective, rotate, scale)  -> linear light: white balance, exposure,
//   lens vignette, highlight shoulder -> local highlights/shadows (luminance ratio) -> perceptual:
//   dehaze, texture, clarity -> tone LUT (contrast, whites, blacks, parametric + point curves) ->
//   colour (HSL mixer / B&W mix, vibrance, saturation, colour grading, defringe) -> noise reduction
//   -> sharpening -> effects (post-crop vignette, grain).

export const HSL_COLORS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
export const HSL_LABELS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
export const HSL_HUES = [0, 30, 60, 120, 180, 240, 270, 300];

// White balance presets for non-raw images: relative Temperature/Tint offsets (scene assumed daylight).
export const WB_PRESETS = {
  asShot: { temperature: 0, tint: 0 },
  daylight: { temperature: 0, tint: 0 },
  cloudy: { temperature: 14, tint: 3 },
  shade: { temperature: 28, tint: 6 },
  tungsten: { temperature: -60, tint: 8 },
  fluorescent: { temperature: -38, tint: 26 },
  flash: { temperature: 6, tint: 0 },
};
export const WB_LABELS = [['asShot', 'As Shot'], ['auto', 'Auto'], ['daylight', 'Daylight'], ['cloudy', 'Cloudy'], ['shade', 'Shade'], ['tungsten', 'Tungsten'], ['fluorescent', 'Fluorescent'], ['flash', 'Flash'], ['custom', 'Custom']];

const ID_CURVE = () => [[0, 0], [255, 255]];
const zeros8 = () => [0, 0, 0, 0, 0, 0, 0, 0];

export function defaultRawSettings() {
  return {
    version: 1,
    // Basic
    treatment: 'color',            // 'color' | 'bw'
    wb: 'asShot', temperature: 0, tint: 0,
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    // Curve
    parametric: { highlights: 0, lights: 0, darks: 0, shadows: 0, split1: 25, split2: 50, split3: 75 },
    pointCurve: { rgb: ID_CURVE(), red: ID_CURVE(), green: ID_CURVE(), blue: ID_CURVE() },
    // Detail
    sharpen: { amount: 0, radius: 1, detail: 25, masking: 0 },
    noise: { luminance: 0, lumDetail: 50, lumContrast: 0, color: 0, colorDetail: 50, colorSmoothness: 50 },
    // Color Mixer (index order = HSL_COLORS)
    hsl: { hue: zeros8(), saturation: zeros8(), luminance: zeros8() },
    bwMix: zeros8(),
    // Color Grading
    grading: {
      shadows: { hue: 0, sat: 0, lum: 0 }, midtones: { hue: 0, sat: 0, lum: 0 },
      highlights: { hue: 0, sat: 0, lum: 0 }, global: { hue: 0, sat: 0, lum: 0 },
      blending: 50, balance: 0,
    },
    // Optics
    optics: { distortion: 0, vignette: 0, vignetteMidpoint: 50, defringePurple: 0, defringeGreen: 0 },
    // Geometry
    geometry: { vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, offsetX: 0, offsetY: 0, constrain: false, fill: 'transparent' },
    // Effects
    effects: {
      grainAmount: 0, grainSize: 25, grainRoughness: 50,
      vignetteStyle: 'highlight', vignetteAmount: 0, vignetteMidpoint: 50, vignetteRoundness: 0, vignetteFeather: 50, vignetteHighlights: 0,
    },
  };
}

// Built-in presets: partial settings merged over the current ones ('auto' is computed).
export const RAW_PRESETS = [
  { name: 'Auto', auto: true, settings: {} },
  { name: 'Vivid', settings: { contrast: 18, vibrance: 35, saturation: 8, clarity: 10, dehaze: 6, whites: 8, blacks: -6 } },
  { name: 'Matte', settings: { contrast: -18, highlights: -20, shadows: 15, saturation: -12, pointCurve: { rgb: [[0, 38], [64, 72], [190, 196], [255, 240]] }, grading: { shadows: { hue: 215, sat: 8, lum: 0 } } } },
  { name: 'B&W High Contrast', settings: { treatment: 'bw', contrast: 45, clarity: 22, whites: 18, blacks: -22, highlights: -15, bwMix: [10, 6, 0, -12, -18, -28, -10, 4] } },
  { name: 'Warm Film', settings: { temperature: 16, tint: 4, contrast: -6, saturation: -6, pointCurve: { rgb: [[0, 22], [70, 74], [185, 192], [255, 246]] }, grading: { shadows: { hue: 200, sat: 12, lum: 0 }, highlights: { hue: 42, sat: 22, lum: 0 } }, effects: { grainAmount: 22, grainSize: 30, grainRoughness: 55 } } },
  { name: 'Cool', settings: { temperature: -20, tint: -3, saturation: -6, vibrance: 8, grading: { global: { hue: 212, sat: 8, lum: 0 } } } },
  { name: 'Landscape Pop', settings: { dehaze: 14, vibrance: 28, clarity: 16, highlights: -35, shadows: 25, texture: 10 } },
  { name: 'Soft Portrait', settings: { texture: -22, clarity: -12, vibrance: 10, highlights: -10, shadows: 8, effects: { vignetteAmount: -14, vignetteMidpoint: 40, vignetteFeather: 70 } } },
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const srgbDec = (p) => (p <= 0.04045 ? p / 12.92 : Math.pow((p + 0.055) / 1.055, 2.4));
const srgbEnc = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);

const DEC8 = new Float32Array(256);
for (let i = 0; i < 256; i++) DEC8[i] = srgbDec(i / 255);
// nearest-neighbour LUTs: 64K entries for linear->sRGB (max error ~0.03 of an 8-bit level), 16K for sRGB->linear
const ENC_N = 65535;
const ENC = new Float32Array(ENC_N + 1);
for (let i = 0; i <= ENC_N; i++) ENC[i] = srgbEnc(i / ENC_N);
const DEC_N = 16383;
const DECF = new Float32Array(DEC_N + 1);
for (let i = 0; i <= DEC_N; i++) DECF[i] = srgbDec(i / DEC_N);
function enc(l) { return l > 0 ? (l < 1 ? ENC[(l * ENC_N + 0.5) | 0] : 1) : 0; }
function dec(p) { return p > 0 ? (p < 1 ? DECF[(p * DEC_N + 0.5) | 0] : 1) : 0; }

function newImage(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
function copyImage(img) { return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height }; }

// deep merge of plain objects; arrays are replaced (copied)
function mergeInto(dst, src) {
  if (!src || typeof src !== 'object') return dst;
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (Array.isArray(v)) dst[k] = v.map((x) => (Array.isArray(x) ? x.slice() : x));
    else if (v && typeof v === 'object') { if (!dst[k] || typeof dst[k] !== 'object' || Array.isArray(dst[k])) dst[k] = {}; mergeInto(dst[k], v); }
    else if (v !== undefined) dst[k] = v;
  }
  return dst;
}
export function mergeRawSettings(base, partial) { return mergeInto(mergeInto({}, base), partial); }

// Merge with defaults + sanitise / clamp every value.
export function normalizeRawSettings(s) {
  const d = defaultRawSettings();
  const o = mergeInto(d, s || {});
  const N = (obj, k, lo, hi, def) => { obj[k] = clamp(num(Number(obj[k]), def), lo, hi); };
  const D = defaultRawSettings();
  o.treatment = o.treatment === 'bw' ? 'bw' : 'color';
  for (const [k, lo, hi] of [['temperature', -100, 100], ['tint', -100, 100], ['exposure', -5, 5], ['contrast', -100, 100], ['highlights', -100, 100], ['shadows', -100, 100], ['whites', -100, 100], ['blacks', -100, 100], ['texture', -100, 100], ['clarity', -100, 100], ['dehaze', -100, 100], ['vibrance', -100, 100], ['saturation', -100, 100]]) N(o, k, lo, hi, D[k]);
  const pc = o.parametric;
  for (const k of ['highlights', 'lights', 'darks', 'shadows']) N(pc, k, -100, 100, 0);
  N(pc, 'split1', 5, 90, 25); N(pc, 'split2', 10, 90, 50); N(pc, 'split3', 10, 95, 75);
  pc.split2 = clamp(pc.split2, pc.split1 + 5, 90); pc.split3 = clamp(pc.split3, pc.split2 + 5, 95);
  for (const ch of ['rgb', 'red', 'green', 'blue']) {
    let pts = Array.isArray(o.pointCurve[ch]) ? o.pointCurve[ch] : ID_CURVE();
    pts = pts.filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])).map((p) => [clamp(+p[0], 0, 255), clamp(+p[1], 0, 255)]).sort((a, b) => a[0] - b[0]);
    o.pointCurve[ch] = pts.length >= 2 ? pts : ID_CURVE();
  }
  N(o.sharpen, 'amount', 0, 150, 0); N(o.sharpen, 'radius', 0.5, 3, 1); N(o.sharpen, 'detail', 0, 100, 25); N(o.sharpen, 'masking', 0, 100, 0);
  for (const k of ['luminance', 'lumDetail', 'lumContrast', 'color', 'colorDetail', 'colorSmoothness']) N(o.noise, k, 0, 100, D.noise[k]);
  for (const k of ['hue', 'saturation', 'luminance']) { const a = Array.isArray(o.hsl[k]) ? o.hsl[k] : []; o.hsl[k] = HSL_COLORS.map((_, i) => clamp(num(Number(a[i]), 0), -100, 100)); }
  { const a = Array.isArray(o.bwMix) ? o.bwMix : []; o.bwMix = HSL_COLORS.map((_, i) => clamp(num(Number(a[i]), 0), -100, 100)); }
  for (const r of ['shadows', 'midtones', 'highlights', 'global']) {
    const g = o.grading[r] = o.grading[r] && typeof o.grading[r] === 'object' ? o.grading[r] : { hue: 0, sat: 0, lum: 0 };
    g.hue = ((num(Number(g.hue), 0) % 360) + 360) % 360; N(g, 'sat', 0, 100, 0); N(g, 'lum', -100, 100, 0);
  }
  N(o.grading, 'blending', 0, 100, 50); N(o.grading, 'balance', -100, 100, 0);
  N(o.optics, 'distortion', -100, 100, 0); N(o.optics, 'vignette', -100, 100, 0); N(o.optics, 'vignetteMidpoint', 0, 100, 50);
  N(o.optics, 'defringePurple', 0, 20, 0); N(o.optics, 'defringeGreen', 0, 20, 0);
  const g = o.geometry;
  for (const k of ['vertical', 'horizontal', 'aspect', 'offsetX', 'offsetY']) N(g, k, -100, 100, 0);
  N(g, 'rotate', -45, 45, 0); N(g, 'scale', 50, 150, 100); g.constrain = !!g.constrain; g.fill = g.fill === 'edge' ? 'edge' : 'transparent';
  const e = o.effects;
  N(e, 'grainAmount', 0, 100, 0); N(e, 'grainSize', 0, 100, 25); N(e, 'grainRoughness', 0, 100, 50);
  N(e, 'vignetteAmount', -100, 100, 0); N(e, 'vignetteMidpoint', 0, 100, 50); N(e, 'vignetteRoundness', -100, 100, 0); N(e, 'vignetteFeather', 0, 100, 50); N(e, 'vignetteHighlights', 0, 100, 0);
  e.vignetteStyle = ['highlight', 'color', 'paint'].includes(e.vignetteStyle) ? e.vignetteStyle : 'highlight';
  if (typeof o.wb !== 'string') o.wb = 'asShot';
  return o;
}

const isIdCurve = (pts) => pts.every((p) => Math.abs(p[0] - p[1]) < 1e-6);

// What each stage needs (all false => identity)
function analyse(s) {
  const g = s.geometry, gr = s.grading, pc = s.parametric;
  const st = {};
  st.geometry = !!(g.vertical || g.horizontal || g.rotate || g.aspect || g.scale !== 100 || g.offsetX || g.offsetY || s.optics.distortion);
  st.wb = !!(s.temperature || s.tint);
  st.exposure = s.exposure !== 0;
  st.lensVig = s.optics.vignette !== 0;
  st.linear = st.wb || st.exposure || st.lensVig;
  st.hs = !!(s.highlights || s.shadows);
  st.dehaze = s.dehaze !== 0;
  st.clarity = s.clarity !== 0;
  st.texture = s.texture !== 0;
  st.defringe = !!(s.optics.defringePurple || s.optics.defringeGreen);
  st.tone = !!(s.contrast || s.whites || s.blacks || pc.highlights || pc.lights || pc.darks || pc.shadows ||
    !isIdCurve(s.pointCurve.rgb) || !isIdCurve(s.pointCurve.red) || !isIdCurve(s.pointCurve.green) || !isIdCurve(s.pointCurve.blue));
  st.bw = s.treatment === 'bw';
  st.hsl = !st.bw && [...s.hsl.hue, ...s.hsl.saturation, ...s.hsl.luminance].some((v) => v !== 0);
  st.sat = !st.bw && !!(s.saturation || s.vibrance);
  st.grading = ['shadows', 'midtones', 'highlights', 'global'].some((k) => gr[k].sat > 0 || gr[k].lum !== 0);
  st.color = st.bw || st.hsl || st.sat || st.grading || st.defringe;
  st.main = st.linear || st.hs || st.dehaze || st.clarity || st.texture || st.tone || st.color;
  st.lnr = s.noise.luminance > 0;
  st.cnr = s.noise.color > 0;
  st.sharpen = s.sharpen.amount > 0;
  st.detail = st.lnr || st.cnr || st.sharpen;
  st.grain = s.effects.grainAmount > 0;
  st.pcv = s.effects.vignetteAmount !== 0;
  st.effects = st.grain || st.pcv;
  st.any = st.geometry || st.main || st.detail || st.effects;
  return st;
}

// White balance gains (linear light). Model: temperature moves along blue<->amber, tint along green<->magenta.
const WB_A = 0.5, WB_B = 0.75, WB_C = 0.12, WB_D = 0.42;
function wbGains(temp, tint) {
  const t = temp / 100, n = tint / 100;
  let r = Math.exp(WB_A * t + WB_C * n), g = Math.exp(-WB_D * n), b = Math.exp(-WB_B * t + WB_C * n);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r / y, g / y, b / y];
}

// ---------------------------------------------------------------------------
// planes: gaussian blur (separable kernel for small sigma, 3x box for large)
// ---------------------------------------------------------------------------
function blurPlane(src, w, h, sigma) {
  if (!(sigma > 0.2)) return new Float32Array(src);
  const tmp = new Float32Array(w * h);
  if (sigma < 1.6) {
    // symmetric folded gaussian kernel (accurate for the small radii used by sharpening / texture)
    const out = new Float32Array(w * h);
    const R = Math.ceil(sigma * 3), K = new Float64Array(R + 1);
    let sum = 0; for (let i = 0; i <= R; i++) { K[i] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += i ? 2 * K[i] : K[i]; }
    for (let i = 0; i <= R; i++) K[i] /= sum;
    const pad = new Float32Array(w + 2 * R), k0 = K[0];
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) pad[x + R] = src[row + x];
      for (let k = 0; k < R; k++) { pad[k] = src[row]; pad[w + R + k] = src[row + w - 1]; }
      for (let x = 0; x < w; x++) { const c = x + R; let acc = pad[c] * k0; for (let k = 1; k <= R; k++) acc += (pad[c - k] + pad[c + k]) * K[k]; tmp[row + x] = acc; }
    }
    const acc = new Float64Array(w);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) acc[x] = tmp[o + x] * k0;
      for (let k = 1; k <= R; k++) {
        const a = (y - k < 0 ? 0 : y - k) * w, b = (y + k >= h ? h - 1 : y + k) * w, kv = K[k];
        for (let x = 0; x < w; x++) acc[x] += (tmp[a + x] + tmp[b + x]) * kv;
      }
      for (let x = 0; x < w; x++) out[o + x] = acc[x];
    }
    return out;
  }
  // three box passes (Kovesi box sizes)
  const out = new Float32Array(src);
  const n = 3, wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2, m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  for (let p = 0; p < n; p++) {
    const r = ((p < m ? wl : wu) - 1) >> 1;
    boxH(out, tmp, w, h, r); boxV(tmp, out, w, h, r);
  }
  return out;
}
function boxH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w; const first = src[row], last = src[row + w - 1];
    let acc = first * (r + 1);
    for (let k = 1; k <= r; k++) acc += src[row + (k < w ? k : w - 1)];
    for (let x = 0; x < w; x++) {
      dst[row + x] = acc * inv;
      const add = x + r + 1, sub = x - r;
      acc += (add < w ? src[row + add] : last) - (sub >= 0 ? src[row + sub] : first);
    }
  }
}
function boxV(src, dst, w, h, r) {
  // row-wise running sums (cache friendly)
  const inv = 1 / (2 * r + 1), acc = new Float64Array(w);
  for (let x = 0; x < w; x++) acc[x] = src[x] * (r + 1);
  for (let k = 1; k <= r; k++) { const o = Math.min(k, h - 1) * w; for (let x = 0; x < w; x++) acc[x] += src[o + x]; }
  for (let y = 0; y < h; y++) {
    const o = y * w, ad = Math.min(y + r + 1, h - 1) * w, sb = Math.max(y - r, 0) * w;
    for (let x = 0; x < w; x++) { dst[o + x] = acc[x] * inv; acc[x] += src[ad + x] - src[sb + x]; }
  }
}
// Box mean (radius r) of a plane — two running-sum passes.
function boxMean(src, w, h, r) { const t = new Float32Array(w * h), o = new Float32Array(w * h); boxH(src, t, w, h, r); boxV(t, o, w, h, r); return o; }
// Self-guided filter (He et al.): edge-preserving smoothing. Strong edges (contrast >> sqrt(eps)) are kept,
// so local-contrast and shadow/highlight masks built from it don't halo around hard edges.
function guidedSelf(I, w, h, r, eps) {
  const n = w * h, II = new Float32Array(n);
  for (let k = 0; k < n; k++) II[k] = I[k] * I[k];
  const mI = boxMean(I, w, h, r), mII = boxMean(II, w, h, r);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let k = 0; k < n; k++) { const v = mII[k] - mI[k] * mI[k], a = v / (v + eps); A[k] = a; B[k] = mI[k] - a * mI[k]; }
  const mA = boxMean(A, w, h, r), mB = boxMean(B, w, h, r);
  const q = new Float32Array(n);
  for (let k = 0; k < n; k++) q[k] = mA[k] * I[k] + mB[k];
  return blurPlane(q, w, h, 0.8);
}
// Guided filter with a separate guide I for input p (used to snap the dehaze transmission map to edges).
function guided(I, p, w, h, r, eps) {
  const n = w * h, II = new Float32Array(n), Ip = new Float32Array(n);
  for (let k = 0; k < n; k++) { II[k] = I[k] * I[k]; Ip[k] = I[k] * p[k]; }
  const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mII = boxMean(II, w, h, r), mIp = boxMean(Ip, w, h, r);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let k = 0; k < n; k++) { const v = mII[k] - mI[k] * mI[k], c = mIp[k] - mI[k] * mp[k], a = c / (v + eps); A[k] = a; B[k] = mp[k] - a * mI[k]; }
  const mA = boxMean(A, w, h, r), mB = boxMean(B, w, h, r);
  const q = new Float32Array(n);
  for (let k = 0; k < n; k++) q[k] = mA[k] * I[k] + mB[k];
  return q;
}
// min filter (square window radius r), separable, O(n*r) — only used on small guide planes
function erodePlane(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity; const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
    for (let k = a; k <= b; k++) { const v = src[y * w + k]; if (v < m) m = v; }
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = Infinity; const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
    for (let k = a; k <= b; k++) { const v = tmp[k * w + x]; if (v < m) m = v; }
    out[y * w + x] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry: inverse mapping dst -> src (normalized coords; resolution independent)
// ---------------------------------------------------------------------------
function geometryMapper(s, W, H) {
  const g = s.geometry, D = s.optics.distortion / 100;
  const cx = (W - 1) / 2, cy = (H - 1) / 2, f = Math.max(W, H) / 2, halfDiag = Math.hypot(W, H) / 2 / f;
  const F = 1.6; // focal length in half-long-edge units (~ 35mm equivalent)
  const av = (g.vertical / 100) * 0.42, ah = (g.horizontal / 100) * 0.42; // radians (~24deg)
  // R = Rx(av) * Ry(ah); we need R^T
  const ca = Math.cos(av), sa = Math.sin(av), cb = Math.cos(ah), sb = Math.sin(ah);
  // Rx = [[1,0,0],[0,ca,-sa],[0,sa,ca]], Ry = [[cb,0,sb],[0,1,0],[-sb,0,cb]]
  // R = Rx*Ry
  const R = [cb, 0, sb, sa * sb, ca, -sa * cb, -ca * sb, sa, ca * cb];
  // R^T
  const T = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  const rot = (-g.rotate * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
  const asp = Math.pow(2, (g.aspect / 100) * 0.5), ax = Math.sqrt(asp), ay = 1 / ax;
  const ox = (g.offsetX / 100) * 0.5, oy = (g.offsetY / 100) * 0.5;
  const persp = !!(g.vertical || g.horizontal);
  const kD = -0.32 * D;
  // returns false if invalid; writes into out[0], out[1] (src pixel coords)
  const map = (X, Y, zoom, out) => {
    let x = (X - cx) / f - ox, y = (Y - cy) / f - oy;
    const sc = (g.scale / 100) * zoom;
    x /= sc * ax; y /= sc * ay;
    // undo rotation (content rotated clockwise for +)
    let x2 = x * cr - y * sr, y2 = x * sr + y * cr;
    if (persp) {
      const wx = x2 / F, wy = y2 / F;
      const sx = T[0] * wx + T[1] * wy + T[2], sy = T[3] * wx + T[4] * wy + T[5], sz = T[6] * wx + T[7] * wy + T[8];
      if (sz <= 1e-4) return false;
      x2 = (F * sx) / sz; y2 = (F * sy) / sz;
    }
    if (kD) { const rr = (x2 * x2 + y2 * y2) / (halfDiag * halfDiag); const k = 1 + kD * rr; x2 *= k; y2 *= k; }
    out[0] = cx + x2 * f; out[1] = cy + y2 * f;
    return true;
  };
  return map;
}
function constrainZoom(map, W, H) {
  const pts = [];
  const N = 16;
  for (let i = 0; i <= N; i++) { const t = i / N; pts.push([t * (W - 1), 0], [t * (W - 1), H - 1], [0, t * (H - 1)], [W - 1, t * (H - 1)]); }
  const tmp = [0, 0];
  const ok = (z) => pts.every(([x, y]) => map(x, y, z, tmp) && tmp[0] >= -0.01 && tmp[1] >= -0.01 && tmp[0] <= W - 0.99 && tmp[1] <= H - 0.99);
  if (ok(1)) return 1;
  let lo = 1, hi = 8;
  if (!ok(hi)) return hi;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (ok(m)) hi = m; else lo = m; }
  return hi;
}
// Remap the dst rectangle (rx,ry,rw,rh) of a W x H output from `src` (also W x H).
function remapGeometry(src, s, rx, ry, rw, rh) {
  const W = src.width, H = src.height, sd = src.data;
  const out = newImage(rw, rh), od = out.data;
  const map = geometryMapper(s, W, H);
  const zoom = s.geometry.constrain ? constrainZoom(map, W, H) : 1;
  const edge = s.geometry.fill === 'edge';
  const p = [0, 0];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const o = (y * rw + x) * 4;
      if (!map(rx + x, ry + y, zoom, p)) continue;
      let sx = p[0], sy = p[1];
      if (edge) { sx = clamp(sx, 0, W - 1); sy = clamp(sy, 0, H - 1); }
      if (sx <= -1 || sy <= -1 || sx >= W || sy >= H) continue;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let k = 0; k < 4; k++) {
        const xx = x0 + (k & 1), yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const wgt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
        if (wgt <= 0) continue;
        const i = (yy * W + xx) * 4, a = sd[i + 3] * wgt;
        ar += sd[i] * a; ag += sd[i + 1] * a; ab += sd[i + 2] * a; aa += a;
      }
      if (aa > 1e-6) { od[o] = ar / aa; od[o + 1] = ag / aa; od[o + 2] = ab / aa; od[o + 3] = aa; }
    }
  }
  return out;
}
function cropImage(src, x, y, w, h) {
  if (x === 0 && y === 0 && w === src.width && h === src.height) return src;
  const out = newImage(w, h);
  for (let r = 0; r < h; r++) out.data.set(src.data.subarray(((y + r) * src.width + x) * 4, ((y + r) * src.width + x + w) * 4), r * w * 4);
  return out;
}

// ---------------------------------------------------------------------------
// Tone LUTs
// ---------------------------------------------------------------------------
const TONE_N = 4096;
function splineFloat(points) {
  const pts = points.map((p) => [p[0], p[1]]);
  const uniq = [];
  for (const p of pts) { if (uniq.length && Math.abs(uniq[uniq.length - 1][0] - p[0]) < 1e-6) uniq[uniq.length - 1] = p; else uniq.push(p); }
  const n = uniq.length, xs = uniq.map((p) => p[0]), ys = uniq.map((p) => p[1]);
  const y2 = new Float64Array(n), u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]), p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
    u[i] = ((6 * d) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
  }
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
  return (xv) => {
    const x = xv * 255;
    if (n === 1) return ys[0] / 255;
    if (x <= xs[0]) return ys[0] / 255;
    if (x >= xs[n - 1]) return ys[n - 1] / 255;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] > x) hi = m; else lo = m; }
    const h = xs[hi] - xs[lo], a = (xs[hi] - x) / h, b = (x - xs[lo]) / h;
    const y = a * ys[lo] + b * ys[hi] + ((a * a * a - a) * y2[lo] + (b * b * b - b) * y2[hi]) * (h * h) / 6;
    return clamp01(y / 255);
  };
}
function bump(p, L, P, R) {
  if (p <= L || p >= R) return 0;
  const t = p < P ? (p - L) / (P - L) : (R - p) / (R - P);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}
// Global tone function (perceptual 0..1 -> 0..1) excluding the per-channel point curves.
export function toneFunction(s) {
  const c = s.contrast / 100, wv = s.whites / 100, bv = s.blacks / 100, pc = s.parametric;
  const k1 = pc.split1 / 100, k2 = pc.split2 / 100, k3 = pc.split3 / 100;
  const amt = [pc.shadows / 100, pc.darks / 100, pc.lights / 100, pc.highlights / 100];
  const zones = [[0, k1 * 0.5, k2], [k1 * 0.3, (k1 + k2) / 2, k3], [k1, (k2 + k3) / 2, 1 - (1 - k3) * 0.3], [k2, k3 + (1 - k3) * 0.5, 1]];
  const pivot = 0.46;
  const wGain = wv > 0 ? 1 / (1 - 0.28 * wv) - 1 : -0.27 * -wv;
  const bGain = bv < 0 ? 1 / (1 - 0.28 * -bv) - 1 : -0.27 * bv;
  return (p) => {
    // contrast: S-curve around pivot
    if (c) {
      let sv;
      if (c > 0) sv = p < pivot ? pivot * Math.pow(p / pivot, 2) : 1 - (1 - pivot) * Math.pow((1 - p) / (1 - pivot), 2);
      else sv = p < pivot ? pivot * Math.sqrt(p / pivot) : 1 - (1 - pivot) * Math.sqrt((1 - p) / (1 - pivot));
      p += (sv - p) * (c > 0 ? c * 0.85 : -c * 0.6);
    }
    if (wv) p = p * (1 + wGain * p * p);
    if (bv) { const q = 1 - p; p = 1 - q * (1 + bGain * q * q); }
    if (amt[0] || amt[1] || amt[2] || amt[3]) {
      const pp = clamp01(p);
      let off = 0;
      for (let z = 0; z < 4; z++) if (amt[z]) off += amt[z] * bump(pp, zones[z][0], zones[z][1], zones[z][2]);
      p = pp + off * 0.24 * (pp < 0.5 ? Math.min(1, pp * 6) : Math.min(1, (1 - pp) * 6));
    }
    return clamp01(p);
  };
}
function buildToneLUTs(s) {
  const tf = toneFunction(s);
  const rgb = splineFloat(s.pointCurve.rgb), cr = splineFloat(s.pointCurve.red), cg = splineFloat(s.pointCurve.green), cb = splineFloat(s.pointCurve.blue);
  const idR = isIdCurve(s.pointCurve.rgb), idr = isIdCurve(s.pointCurve.red), idg = isIdCurve(s.pointCurve.green), idb = isIdCurve(s.pointCurve.blue);
  const L = [new Float32Array(TONE_N + 2), new Float32Array(TONE_N + 2), new Float32Array(TONE_N + 2)];
  let prev = 0;
  for (let i = 0; i <= TONE_N; i++) {
    let v = tf(i / TONE_N);
    if (v < prev) v = prev; prev = v; // keep the global part monotonic
    if (!idR) v = rgb(v);
    L[0][i] = idr ? v : cr(v); L[1][i] = idg ? v : cg(v); L[2][i] = idb ? v : cb(v);
  }
  for (const l of L) l[TONE_N + 1] = l[TONE_N];
  return L;
}
// Highlights/Shadows: 2D LUT over (mask m, value p)
const HS_NP = 256, HS_NM = 32;
function buildHSLUT(s) {
  const S = s.shadows / 100, H = s.highlights / 100;
  const T = new Float32Array((HS_NM + 1) * (HS_NP + 2));
  for (let mi = 0; mi <= HS_NM; mi++) {
    const m = mi / HS_NM;
    const wS = 1 - 0.85 * smooth(0.04, 0.72, m), wH = 0.15 + 0.85 * smooth(0.28, 0.96, m);
    for (let pi = 0; pi <= HS_NP; pi++) {
      let p = pi / HS_NP;
      if (S) { const k = S > 0 ? 1.55 : 0.85; p = p + S * k * wS * p * Math.pow(1 - p, 3) * 1.0; }
      if (H) { let q = 1 - p; const k = H < 0 ? 1.6 : 0.85; q = q - H * k * wH * q * Math.pow(1 - q, 3); p = 1 - q; }
      T[mi * (HS_NP + 2) + pi] = clamp01(p);
    }
    T[mi * (HS_NP + 2) + HS_NP + 1] = T[mi * (HS_NP + 2) + HS_NP];
  }
  return T;
}

// Hue tables for the colour mixer / B&W mix / vibrance skin protection / defringe
function hueWeights(h) {
  // returns [i, wi, j, wj] cosine partition of unity between neighbouring centres
  const C = HSL_HUES;
  for (let i = 0; i < 8; i++) {
    const a = C[i], b = i === 7 ? 360 : C[i + 1];
    if (h >= a && h < b) { const t = (h - a) / (b - a), w = 0.5 + 0.5 * Math.cos(Math.PI * t); return [i, w, (i + 1) % 8, 1 - w]; }
  }
  return [0, 1, 1, 0];
}
function buildHueTables(s) {
  const N = 360;
  const cosT = new Float32Array(N), sinT = new Float32Array(N), satT = new Float32Array(N), lumT = new Float32Array(N), bwT = new Float32Array(N), skinT = new Float32Array(N);
  for (let h = 0; h < N; h++) {
    const [i, wi, j, wj] = hueWeights(h);
    const dh = (s.hsl.hue[i] * wi + s.hsl.hue[j] * wj) / 100 * 32; // degrees
    const a = (dh * Math.PI) / 180;
    cosT[h] = Math.cos(a); sinT[h] = -Math.sin(a) / Math.sqrt(3);
    satT[h] = (s.hsl.saturation[i] * wi + s.hsl.saturation[j] * wj) / 100;
    lumT[h] = (s.hsl.luminance[i] * wi + s.hsl.luminance[j] * wj) / 100;
    bwT[h] = (s.bwMix[i] * wi + s.bwMix[j] * wj) / 100;
    const dSkin = Math.min(Math.abs(h - 25), 360 - Math.abs(h - 25));
    skinT[h] = 1 - 0.6 * Math.max(0, 1 - dSkin / 30);
  }
  return { cosT, sinT, satT, lumT, bwT, skinT };
}
function hueVec(hue) {
  // unit-ish chroma offset vector (zero luminance) for a hue
  const h = ((hue % 360) + 360) % 360 / 60, x = 1 - Math.abs((h % 2) - 1);
  let r, g, b;
  if (h < 1) [r, g, b] = [1, x, 0]; else if (h < 2) [r, g, b] = [x, 1, 0]; else if (h < 3) [r, g, b] = [0, 1, x];
  else if (h < 4) [r, g, b] = [0, x, 1]; else if (h < 5) [r, g, b] = [x, 0, 1]; else [r, g, b] = [1, 0, x];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [r - y, g - y, b - y];
}

// ---------------------------------------------------------------------------
// small per-source cache (opt-in via opts.cache) so slider drags skip unchanged work
// ---------------------------------------------------------------------------
const CACHE = new WeakMap();
function cached(on, img, key, fn) {
  if (!on || !img || !img.data) return fn();
  let m = CACHE.get(img.data);
  if (!m) { m = new Map(); CACHE.set(img.data, m); }
  if (m.has(key)) { const v = m.get(key); m.delete(key); m.set(key, v); return v; }
  const v = fn(); m.set(key, v);
  while (m.size > 8) m.delete(m.keys().next().value);
  return v;
}
export function clearRawCache(img) { if (img && img.data) CACHE.delete(img.data); }

// ---------------------------------------------------------------------------
// Guides (low-frequency planes, normalized image coordinates)
// ---------------------------------------------------------------------------
const GUIDE_MAX = 640;
// area-average linear RGB at guide resolution (independent of the tone settings)
function guideBase(img) {
  const W = img.width, H = img.height, sd = img.data;
  const sc = Math.min(1, GUIDE_MAX / Math.max(W, H));
  const gw = Math.max(1, Math.round(W * sc)), gh = Math.max(1, Math.round(H * sc));
  const n = gw * gh;
  const ar = new Float32Array(n), ag = new Float32Array(n), ab = new Float32Array(n), aw = new Float32Array(n);
  const xm = new Int32Array(W); for (let x = 0; x < W; x++) xm[x] = Math.min(gw - 1, Math.floor((x * gw) / W));
  const st = Math.max(1, Math.floor(W / gw / 2.5)); // subsample when the reduction is large
  for (let y = 0; y < H; y += st) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / H)) * gw;
    let i = y * W * 4;
    for (let x = 0; x < W; x += st, i += 4 * st) {
      const a = sd[i + 3] + 0.5, k = gy + xm[x];
      ar[k] += DEC8[sd[i]] * a; ag[k] += DEC8[sd[i + 1]] * a; ab[k] += DEC8[sd[i + 2]] * a; aw[k] += a;
    }
  }
  for (let k = 0; k < n; k++) { const a = aw[k] || 1; ar[k] /= a; ag[k] /= a; ab[k] /= a; }
  return { gw, gh, ar, ag, ab };
}
function buildGuides(base, st, gains, shoulder) {
  const { gw, gh, ar, ag, ab } = base, n = gw * gh;
  const P = new Float32Array(n), R = st.dehaze ? new Float32Array(n) : null, G = st.dehaze ? new Float32Array(n) : null, B = st.dehaze ? new Float32Array(n) : null;
  for (let k = 0; k < n; k++) {
    let r = ar[k] * gains[0], g = ag[k] * gains[1], b = ab[k] * gains[2];
    if (shoulder) { r = shoulder(r); g = shoulder(g); b = shoulder(b); }
    P[k] = enc(0.2126 * r + 0.7152 * g + 0.0722 * b);
    if (R) { R[k] = enc(r); G[k] = enc(g); B[k] = enc(b); }
  }
  const ug = Math.max(gw, gh) / 2000;
  const out = { gw, gh };
  if (st.hs) out.big = guidedSelf(P, gw, gh, Math.max(2, Math.round(52 * ug)), 0.006);
  if (st.clarity) out.mid = guidedSelf(P, gw, gh, Math.max(2, Math.round(40 * ug)), 0.012);
  if (st.dehaze) {
    const dc = new Float32Array(n);
    for (let k = 0; k < n; k++) dc[k] = Math.min(R[k], G[k], B[k]);
    const er = erodePlane(dc, gw, gh, Math.max(1, Math.round(4 * ug)));
    // atmospheric light: mean colour of the ~0.2% haziest pixels (threshold via histogram)
    const hist = new Uint32Array(1025);
    for (let k = 0; k < n; k++) hist[Math.min(1024, (clamp01(er[k]) * 1024) | 0)]++;
    let need = Math.max(1, Math.round(n * 0.002)), thr = 1024;
    for (let acc = 0; thr > 0; thr--) { acc += hist[thr]; if (acc >= need) break; }
    let Ar = 0, Ag = 0, Ab = 0, cnt = 0;
    for (let k = 0; k < n; k++) if (((clamp01(er[k]) * 1024) | 0) >= thr) { Ar += R[k]; Ag += G[k]; Ab += B[k]; cnt++; }
    cnt = cnt || 1; Ar /= cnt; Ag /= cnt; Ab /= cnt;
    const Am = Math.max(0.25, (Ar + Ag + Ab) / 3);
    const bl = guided(P, er, gw, gh, Math.max(2, Math.round(24 * ug)), 0.001);
    for (let k = 0; k < n; k++) bl[k] = clamp01(bl[k] / Am);
    out.haze = bl; out.A = [Math.max(0.3, Ar), Math.max(0.3, Ag), Math.max(0.3, Ab)];
  }
  return out;
}

// Soft highlight shoulder for gains > 1: compresses [knee, maxGain] smoothly into [knee, 1).
function makeShoulder(maxGain) {
  if (!(maxGain > 1.0001)) return null;
  const knee = Math.max(0.45, 1 - (maxGain - 1) * 0.35), span = 1 - knee;
  const fn = (x) => (x <= knee ? x : knee + span * (1 - Math.exp(-(x - knee) / span)));
  const N = 2048, top = maxGain * 1.02 + 0.01, sc = N / (top - knee), lut = new Float32Array(N + 2);
  for (let i = 0; i <= N + 1; i++) lut[i] = fn(knee + i / sc);
  fn.knee = knee; fn.sc = sc; fn.lut = lut; fn.N = N;
  return fn;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export function applyCameraRaw(img, settings, opts = {}) {
  const s = normalizeRawSettings(settings);
  const st = analyse(s);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const prog = (f) => { if (onProgress) onProgress(clamp01(f)); };
  const useCache = !!opts.cache;
  const FW = img.width, FH = img.height;
  const reg = { x: 0, y: 0, w: FW, h: FH };
  if (opts.region) {
    reg.x = clamp(Math.floor(num(opts.region.x, 0)), 0, FW - 1); reg.y = clamp(Math.floor(num(opts.region.y, 0)), 0, FH - 1);
    reg.w = clamp(Math.round(num(opts.region.width, FW)), 1, FW - reg.x); reg.h = clamp(Math.round(num(opts.region.height, FH)), 1, FH - reg.y);
  }
  const maskView = opts.view === 'sharpenMask';
  if (!st.any && !maskView) { prog(1); const c = cropImage(img, reg.x, reg.y, reg.w, reg.h); return c === img ? copyImage(img) : c; }
  const scale = num(opts.scale, 1) > 0 ? num(opts.scale, 1) : 1;
  const u = Math.max(FW, FH) / 2000; // relative unit (resolution independent)
  const sigTex = Math.max(0.7, 2.4 * u);
  const sigDf = Math.max(1, 2 * scale);
  const sigLNR = scale * (0.7 + (2.4 * s.noise.luminance) / 100);
  const sigCNR = scale * (1.5 + (7 * s.noise.color) / 100) * (0.6 + (0.9 * s.noise.colorSmoothness) / 100);
  const sigSh = Math.max(0.25, s.sharpen.radius * scale);
  let margin = 0;
  if (opts.region) {
    let m = 0;
    if (st.texture) m = Math.max(m, sigTex * 3); if (st.defringe) m = Math.max(m, sigDf * 3 + 1);
    if (st.lnr) m = Math.max(m, sigLNR * 3); if (st.cnr) m = Math.max(m, sigCNR * 3);
    if (st.sharpen || maskView) m = Math.max(m, sigSh * 3.6 + 2);
    margin = Math.ceil(m) + 2;
  }
  const wx = Math.max(0, reg.x - margin), wy = Math.max(0, reg.y - margin);
  const ww = Math.min(FW, reg.x + reg.w + margin) - wx, wh = Math.min(FH, reg.y + reg.h + margin) - wy;
  prog(0.02);
  // ---- geometry
  const geoKey = st.geometry ? JSON.stringify([s.geometry, s.optics.distortion]) : '-';
  const rectKey = [wx, wy, ww, wh].join(',');
  const Wimg = st.geometry ? cached(useCache, img, 'geo|' + geoKey + '|' + rectKey, () => remapGeometry(img, s, wx, wy, ww, wh)) : cropImage(img, wx, wy, ww, wh);
  prog(st.geometry ? 0.15 : 0.05);
  const w = ww, h = wh, n = w * h;
  const out = newImage(w, h);
  // ---- linear stage parameters
  const wbg = st.wb ? wbGains(s.temperature, s.tint) : [1, 1, 1];
  const ex = Math.pow(2, s.exposure);
  const gains = [wbg[0] * ex, wbg[1] * ex, wbg[2] * ex];
  let maxGain = Math.max(gains[0], gains[1], gains[2]);
  const lvA = s.optics.vignette / 100;
  if (lvA > 0) maxGain *= Math.pow(2, lvA * 1.4);
  const shoulder = st.linear ? makeShoulder(maxGain) : null;
  let lensLUT = null;
  if (st.lensVig) {
    lensLUT = new Float32Array(1026);
    const r0 = 0.1 + (s.optics.vignetteMidpoint / 100) * 0.65;
    for (let i = 0; i <= 1025; i++) { const r = Math.sqrt(Math.min(1, i / 1024)); const t = clamp01((r - r0) / (1 - r0)); lensLUT[i] = Math.pow(2, lvA * 1.4 * t * t); }
  }
  // ---- guides
  let G = null;
  if (st.hs || st.clarity || st.dehaze) {
    const gsrc = opts.region ? (opts.guide || img) : img;
    const gKey = 'gb|' + geoKey + (opts.region ? '' : '|' + rectKey);
    const base = cached(useCache, gsrc, gKey, () => {
      let gi = opts.region ? gsrc : Wimg;
      if (opts.region && st.geometry) gi = remapGeometry(gsrc, s, 0, 0, gsrc.width, gsrc.height);
      return guideBase(gi);
    });
    G = cached(useCache, gsrc, 'g|' + gKey + '|' + JSON.stringify([gains, maxGain, st.hs, st.clarity, st.dehaze]), () => buildGuides(base, st, gains, shoulder));
  }
  prog(0.25);
  // ---- texture / defringe planes (input luminance and its blur)
  let lumIn = null, lumBl = null, dfBl = null;
  if (st.texture || st.defringe) {
    const planes = cached(useCache, img, 'lum|' + geoKey + '|' + rectKey, () => {
      const sd = Wimg.data, L = new Float32Array(n);
      for (let k = 0, i = 0; k < n; k++, i += 4) L[k] = (0.2126 * sd[i] + 0.7152 * sd[i + 1] + 0.0722 * sd[i + 2]) / 255;
      return { L, bl: {} };
    });
    lumIn = planes.L;
    if (st.texture) lumBl = planes.bl[sigTex] || (planes.bl[sigTex] = blurPlane(lumIn, w, h, sigTex));
    if (st.defringe) dfBl = planes.bl['d' + sigDf] || (planes.bl['d' + sigDf] = blurPlane(lumIn, w, h, sigDf));
  }
  prog(0.32);
  if (st.main) {
    mainPass({
      s, st, sd: Wimg.data, od: out.data, w, h, wx, wy, FW, FH, G, gains, shoulder, lensLUT, lumIn, lumBl, dfBl,
      toneL: st.tone ? buildToneLUTs(s) : null, hsL: st.hs ? buildHSLUT(s) : null,
      HT: st.hsl || st.bw || st.sat || st.defringe ? buildHueTables(s) : null,
      prog: onProgress ? (f) => prog(0.32 + 0.38 * f) : null,
    });
  } else out.data.set(Wimg.data);
  prog(0.7);
  // ---- detail: noise reduction + sharpening (operate on the perceptual 8-bit result)
  if (st.detail || maskView) detailPass(out, s, st, { sigLNR, sigCNR, sigSh, view: opts.view, prog: (f) => prog(0.7 + 0.22 * f) });
  prog(0.92);
  if (st.effects && !maskView) effectsPass(out, s, st, { wx, wy, FW, FH, scale });
  prog(1);
  const res = cropImage(out, reg.x - wx, reg.y - wy, reg.w, reg.h);
  return res;
}

function mainPass(P) {
  const { s, st, sd, od, w, h, wx, wy, FW, FH, G, gains, shoulder, lensLUT, lumIn, lumBl, dfBl, toneL, hsL, HT, prog } = P;
  const linear = st.linear, linNeeded = st.linear || st.hs, doDehaze = st.dehaze, doClar = st.clarity, doTex = st.texture;
  const doColor = st.color, doBW = st.bw, doHSL = st.hsl, doSat = st.sat, doDf = st.defringe, doGrade = st.grading;
  const g0 = gains[0], g1 = gains[1], g2 = gains[2];
  const shK = shoulder ? shoulder.knee : 9, shS = shoulder ? shoulder.sc : 0, shL = shoulder ? shoulder.lut : null, shN = shoulder ? shoulder.N : 0;
  const tR = toneL && toneL[0], tG = toneL && toneL[1], tB = toneL && toneL[2];
  const clar = (s.clarity / 100) * (s.clarity > 0 ? 1.6 : 0.6), tex = (s.texture / 100) * (s.texture > 0 ? 1.6 : 0.95);
  const dh = s.dehaze / 100;
  const sat = s.saturation / 100, vib = s.vibrance / 100;
  const dfP = s.optics.defringePurple / 20, dfG = s.optics.defringeGreen / 20;
  const gr = s.grading, gv = {};
  for (const k of ['shadows', 'midtones', 'highlights', 'global']) { const v = hueVec(gr[k].hue), a = (gr[k].sat / 100) * 0.24; gv[k] = [v[0] * a, v[1] * a, v[2] * a, (gr[k].lum / 100) * 0.22]; }
  const gBal = gr.balance / 100, gWid = 0.12 + (gr.blending / 100) * 0.38;
  const S0 = gv.shadows[0], S1 = gv.shadows[1], S2 = gv.shadows[2], S3 = gv.shadows[3];
  const M0 = gv.midtones[0], M1 = gv.midtones[1], M2 = gv.midtones[2], M3 = gv.midtones[3];
  const H0 = gv.highlights[0], H1 = gv.highlights[1], H2 = gv.highlights[2], H3 = gv.highlights[3];
  const L0 = gv.global[0], L1 = gv.global[1], L2 = gv.global[2], L3 = gv.global[3];
  const sA = 0.33 - gWid, sB = 0.33 + gWid, hA = 0.67 - gWid, hB = 0.67 + gWid;
  const Gbig = G && G.big, Gmid = G && G.mid, Ghz = G && G.haze, A = G && G.A;
  const A0 = A ? A[0] : 0, A1 = A ? A[1] : 0, A2 = A ? A[2] : 0;
  const cosT = HT && HT.cosT, sinT = HT && HT.sinT, satT = HT && HT.satT, lumT = HT && HT.lumT, bwT = HT && HT.bwT, skinT = HT && HT.skinT;
  const HSW = HS_NP + 2;
  const fcx = (FW - 1) / 2, fcy = (FH - 1) / 2, invHD2 = 1024 / ((FW / 2) * (FW / 2) + (FH / 2) * (FH / 2));
  let gx0, gx1, gfx, gy0, gy1, gfy;
  if (G) {
    const { gw, gh } = G;
    gx0 = new Int32Array(w); gx1 = new Int32Array(w); gfx = new Float32Array(w);
    gy0 = new Int32Array(h); gy1 = new Int32Array(h); gfy = new Float32Array(h);
    for (let x = 0; x < w; x++) { const g = clamp(((wx + x + 0.5) / FW) * gw - 0.5, 0, gw - 1); gx0[x] = g | 0; gx1[x] = Math.min(gw - 1, gx0[x] + 1); gfx[x] = g - gx0[x]; }
    for (let y = 0; y < h; y++) { const g = clamp(((wy + y + 0.5) / FH) * gh - 0.5, 0, gh - 1); gy0[y] = (g | 0) * gw; gy1[y] = Math.min(gh - 1, (g | 0) + 1) * gw; gfy[y] = g - (g | 0); }
  }
  const gwN = G ? G.gw : 1;
  const rowBig = new Float32Array(gwN), rowMid = new Float32Array(gwN), rowHz = new Float32Array(gwN);
  for (let y = 0; y < h; y++) {
    if (prog && (y & 63) === 0) prog(y / h);
    const dyv = wy + y - fcy, dy2 = dyv * dyv;
    if (G) {
      const fy = gfy[y], ry0 = gy0[y], ry1 = gy1[y];
      if (Gbig) for (let q = 0; q < gwN; q++) rowBig[q] = Gbig[ry0 + q] + (Gbig[ry1 + q] - Gbig[ry0 + q]) * fy;
      if (Gmid) for (let q = 0; q < gwN; q++) rowMid[q] = Gmid[ry0 + q] + (Gmid[ry1 + q] - Gmid[ry0 + q]) * fy;
      if (Ghz) for (let q = 0; q < gwN; q++) rowHz[q] = Ghz[ry0 + q] + (Ghz[ry1 + q] - Ghz[ry0 + q]) * fy;
    }
    for (let x = 0; x < w; x++) {
      const k = y * w + x, i = k * 4;
      let r, g, b, pLum = 0;
      let q0 = 0, q1 = 0, fx = 0;
      if (G) { fx = gfx[x]; q0 = gx0[x]; q1 = gx1[x]; }
      if (linNeeded) {
        r = DEC8[sd[i]]; g = DEC8[sd[i + 1]]; b = DEC8[sd[i + 2]];
        if (linear) {
          let kr = g0, kg = g1, kb = g2;
          if (lensLUT) { const dx = wx + x - fcx; const m = lensLUT[((dx * dx + dy2) * invHD2) | 0]; kr *= m; kg *= m; kb *= m; }
          r *= kr; g *= kg; b *= kb;
          if (shK < 2) {
            if (r > shK) { let f = (r - shK) * shS; if (f > shN) f = shN; const j = f | 0; r = shL[j] + (shL[j + 1] - shL[j]) * (f - j); }
            if (g > shK) { let f = (g - shK) * shS; if (f > shN) f = shN; const j = f | 0; g = shL[j] + (shL[j + 1] - shL[j]) * (f - j); }
            if (b > shK) { let f = (b - shK) * shS; if (f > shN) f = shN; const j = f | 0; b = shL[j] + (shL[j + 1] - shL[j]) * (f - j); }
          }
        }
        const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        pLum = enc(Y);
        if (hsL) {
          const gm = rowBig[q0] + (rowBig[q1] - rowBig[q0]) * fx;
          const m = clamp01(0.3 * pLum + 0.7 * gm) * HS_NM, mi = m | 0, mf = m - mi, mi1 = mi < HS_NM ? mi + 1 : mi;
          const pp = clamp01(pLum) * HS_NP, pi = pp | 0, pf = pp - pi;
          const r0 = mi * HSW + pi, r1 = mi1 * HSW + pi;
          const v0 = hsL[r0] + (hsL[r0 + 1] - hsL[r0]) * pf, v1 = hsL[r1] + (hsL[r1 + 1] - hsL[r1]) * pf;
          const p2 = v0 + (v1 - v0) * mf;
          if (Y > 1e-7) { const kk = dec(p2) / Y; r *= kk; g *= kk; b *= kk; } else { r = g = b = dec(p2); }
        }
        r = enc(r); g = enc(g); b = enc(b);
      } else {
        r = sd[i] * (1 / 255); g = sd[i + 1] * (1 / 255); b = sd[i + 2] * (1 / 255);
        if (G) pLum = enc(0.2126 * DEC8[sd[i]] + 0.7152 * DEC8[sd[i + 1]] + 0.0722 * DEC8[sd[i + 2]]);
      }
      if (doDehaze) {
        const hz = rowHz[q0] + (rowHz[q1] - rowHz[q0]) * fx;
        if (dh > 0) {
          const t = Math.max(0.18, 1 - dh * 0.88 * hz), it = (1 / t) , comp = 1 + dh * 0.08;
          r = ((r - A0) * it + A0) * comp; g = ((g - A1) * it + A1) * comp; b = ((b - A2) * it + A2) * comp;
        } else {
          const t = 1 + dh * 0.62 * (0.45 + 0.55 * hz);
          r = r * t + A0 * (1 - t); g = g * t + A1 * (1 - t); b = b * t + A2 * (1 - t);
        }
      }
      if (doClar || doTex) {
        let d = 0;
        if (doClar) {
          const gm = rowMid[q0] + (rowMid[q1] - rowMid[q0]) * fx;
          const l = pLum < 0 ? 0 : pLum > 1 ? 1 : pLum, q = 2 * l - 1, mw = 1 - 0.75 * q * q;
          let dd = (pLum - gm) * clar * mw;
          if (clar > 0) dd = dd / (1 + (dd < 0 ? -dd : dd) * 2.2);
          d += dd;
        }
        if (doTex) { const dd = (lumIn[k] - lumBl[k]) * tex; d += tex > 0 ? dd / (1 + (dd < 0 ? -dd : dd) * 3) : dd; }
        r += d; g += d; b += d;
      }
      if (toneL) {
        let f = (r < 0 ? 0 : r > 1 ? 1 : r) * TONE_N, j = f | 0; r = tR[j] + (tR[j + 1] - tR[j]) * (f - j);
        f = (g < 0 ? 0 : g > 1 ? 1 : g) * TONE_N; j = f | 0; g = tG[j] + (tG[j + 1] - tG[j]) * (f - j);
        f = (b < 0 ? 0 : b > 1 ? 1 : b) * TONE_N; j = f | 0; b = tB[j] + (tB[j + 1] - tB[j]) * (f - j);
      }
      if (doColor) {
        r = r < 0 ? 0 : r > 1 ? 1 : r; g = g < 0 ? 0 : g > 1 ? 1 : g; b = b < 0 ? 0 : b > 1 ? 1 : b;
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b), dd = mx - mn;
        let hue = -1;
        if (cosT && dd > 1e-5) {
          let hh = mx === r ? (g - b) / dd : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
          hh *= 60; if (hh < 0) hh += 360; hue = (hh + 0.5) | 0; if (hue >= 360) hue = 0;
        }
        if (doBW) {
          let L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (hue >= 0) L *= 1 + bwT[hue] * (dd / (mx + 1e-6)) * 1.1;
          r = g = b = L;
        } else {
          if (doHSL && hue >= 0) {
            const c = cosT[hue], sn = sinT[hue], sv = dd / (mx + 1e-6);
            if (c !== 1) {
              const m3 = (r + g + b) / 3, oc = 1 - c;
              const nr = r * c + (g - b) * sn + m3 * oc, ng = g * c + (b - r) * sn + m3 * oc, nb = b * c + (r - g) * sn + m3 * oc;
              const fade = sv * 4 < 1 ? sv * 4 : 1; r += (nr - r) * fade; g += (ng - g) * fade; b += (nb - b) * fade;
            }
            const ds = satT[hue];
            if (ds) { const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, kk = 1 + ds; r = L + (r - L) * kk; g = L + (g - L) * kk; b = L + (b - L) * kk; }
            const dl = lumT[hue];
            if (dl) { const kk = 1 + dl * 0.55 * (sv * 1.6 < 1 ? sv * 1.6 : 1); r *= kk; g *= kk; b *= kk; }
          }
          if (doSat) {
            const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            let kk = 1 + sat;
            if (vib) {
              const mx2 = r > g ? (r > b ? r : b) : (g > b ? g : b), mn2 = r < g ? (r < b ? r : b) : (g < b ? g : b);
              const sv = mx2 > 1e-6 ? (mx2 - mn2) / mx2 : 0;
              kk *= vib > 0 ? 1 + vib * 1.15 * (1 - sv) * (1 - sv) * (hue >= 0 ? skinT[hue] : 1) : 1 + vib * (1 - sv * 0.6);
            }
            r = L + (r - L) * kk; g = L + (g - L) * kk; b = L + (b - L) * kk;
          }
        }
        if (doDf && hue >= 0) {
          let wgt = 0;
          if (dfP && hue >= 250 && hue <= 335) wgt = dfP * Math.min(1, (hue - 250) / 15, (335 - hue) / 15);
          if (dfG && hue >= 75 && hue <= 165) wgt = Math.max(wgt, dfG * Math.min(1, (hue - 75) / 15, (165 - hue) / 15));
          if (wgt > 0) {
            const xl = x > 0 ? k - 1 : k, xr = x < w - 1 ? k + 1 : k, yu = y > 0 ? k - w : k, yd = y < h - 1 ? k + w : k;
            const gxv = dfBl[xr] - dfBl[xl], gyv = dfBl[yd] - dfBl[yu];
            const e = Math.min(1, Math.sqrt(gxv * gxv + gyv * gyv) * 9);
            const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, kk = 1 - Math.min(1, wgt * e * 1.5);
            r = L + (r - L) * kk; g = L + (g - L) * kk; b = L + (b - L) * kk;
          }
        }
        if (doGrade) {
          const Lr = 0.2126 * r + 0.7152 * g + 0.0722 * b, L = Lr < 0 ? 0 : Lr > 1 ? 1 : Lr;
          let Lb = L + gBal * 0.3; Lb = Lb < 0 ? 0 : Lb > 1 ? 1 : Lb;
          let t1 = (Lb - sA) / (sB - sA); t1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
          let t2 = (Lb - hA) / (hB - hA); t2 = t2 < 0 ? 0 : t2 > 1 ? 1 : t2;
          const wS = 1 - t1 * t1 * (3 - 2 * t1), wH = t2 * t2 * (3 - 2 * t2), wMr = 1 - wS - wH, wM = wMr > 0 ? wMr : 0;
          const e1 = L * 5 < 1 ? L * 5 : 1, e2 = (1 - L) * 5 < 1 ? (1 - L) * 5 : 1, ends = e1 * e2 * 0.8 + 0.2;
          const lum = S3 * wS * (1 - L) + M3 * wM * 4.8 * L * (1 - L) + H3 * wH * L + L3 * 4 * L * (1 - L);
          r += (S0 * wS + M0 * wM + H0 * wH + L0) * ends + lum;
          g += (S1 * wS + M1 * wM + H1 * wH + L1) * ends + lum;
          b += (S2 * wS + M2 * wM + H2 * wH + L2) * ends + lum;
        }
      }
      od[i] = r * 255; od[i + 1] = g * 255; od[i + 2] = b * 255; od[i + 3] = sd[i + 3];
    }
  }
}

// Gaussian blur computed at half resolution (for smooth, low-frequency planes such as chroma).
function blurHalf(src, w, h, sigma) {
  if (sigma < 1.2 || w < 8 || h < 8) return blurPlane(src, w, h, sigma);
  const hw = (w + 1) >> 1, hh = (h + 1) >> 1, sm = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
    const x0 = x * 2, y0 = y * 2, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    sm[y * hw + x] = (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]) * 0.25;
  }
  const b = blurPlane(sm, hw, hh, Math.sqrt(Math.max(0.05, sigma * sigma - 0.25)) / 2);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = clamp((y - 0.5) / 2, 0, hh - 1), iy = gy | 0, fy = gy - iy, iy1 = Math.min(hh - 1, iy + 1);
    for (let x = 0; x < w; x++) {
      const gx = clamp((x - 0.5) / 2, 0, hw - 1), ix = gx | 0, fx = gx - ix, ix1 = Math.min(hw - 1, ix + 1);
      out[y * w + x] = (b[iy * hw + ix] * (1 - fx) + b[iy * hw + ix1] * fx) * (1 - fy) + (b[iy1 * hw + ix] * (1 - fx) + b[iy1 * hw + ix1] * fx) * fy;
    }
  }
  return out;
}

function detailPass(img, s, st, o) {
  const w = img.width, h = img.height, n = w * h, d = img.data;
  const Y = new Float32Array(n);
  for (let k = 0, i = 0; k < n; k++, i += 4) Y[k] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  const dY = st.lnr ? new Float32Array(n) : null;
  let Ycur = Y;
  if (st.lnr) {
    const B = blurPlane(Y, w, h, o.sigLNR);
    const amt = Math.min(1, (s.noise.luminance / 100) * 1.6);
    const sd = 0.012 + 0.16 * (1 - s.noise.lumDetail / 100) * (0.3 + 0.7 * s.noise.luminance / 100);
    const keep = (s.noise.lumContrast / 100) * 0.55;
    const Yn = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const diff = B[k] - Y[k], e = diff / sd, wgt = 1 / (1 + e * e);
      let v = Y[k] + diff * amt * wgt;
      v += (Y[k] - v) * keep * (1 - wgt);
      Yn[k] = v;
    }
    Ycur = Yn;
  }
  o.prog(0.3);
  if (st.cnr) {
    // chroma (Cr = R-Y, Cb = B-Y) is smooth: denoise it at half resolution
    const hw = (w + 1) >> 1, hh = (h + 1) >> 1, hn = hw * hh;
    const Cr = new Float32Array(hn), Cb = new Float32Array(hn), Yh = new Float32Array(hn);
    for (let y = 0; y < h; y++) {
      const hy = (y >> 1) * hw;
      for (let x = 0; x < w; x++) {
        const k = y * w + x, i = k * 4, q = hy + (x >> 1), yv = Y[k];
        Cr[q] += d[i] / 255 - yv; Cb[q] += d[i + 2] / 255 - yv; Yh[q] += yv;
      }
    }
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      const c = (Math.min(2, h - y * 2)) * (Math.min(2, w - x * 2)), q = y * hw + x;
      Cr[q] /= c; Cb[q] /= c; Yh[q] /= c;
    }
    const hs = Math.sqrt(Math.max(0.05, o.sigCNR * o.sigCNR - 0.25)) / 2;
    const bCr = blurPlane(Cr, hw, hh, hs), bCb = blurPlane(Cb, hw, hh, hs);
    const det = s.noise.colorDetail / 100;
    const Yb = det > 0 ? blurPlane(Yh, hw, hh, Math.max(0.5, hs * 0.5)) : null;
    const amt = Math.min(1, (s.noise.color / 100) * 2.2);
    for (let y = 0; y < h; y++) {
      const gy = clamp((y - 0.5) / 2, 0, hh - 1), iy = gy | 0, fy = gy - iy, r0 = iy * hw, r1 = Math.min(hh - 1, iy + 1) * hw;
      for (let x = 0; x < w; x++) {
        const gx = clamp((x - 0.5) / 2, 0, hw - 1), ix = gx | 0, fx = gx - ix, ix1 = ix + 1 < hw ? ix + 1 : ix;
        const k = y * w + x, i = k * 4, yv = Y[k];
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
        let wgt = amt;
        if (Yb) {
          const yb = Yb[r0 + ix] * w00 + Yb[r0 + ix1] * w01 + Yb[r1 + ix] * w10 + Yb[r1 + ix1] * w11;
          const e = Math.min(1, Math.abs(yv - yb) * 18); wgt *= 1 - e * det * 0.85;
        }
        const crO = d[i] / 255 - yv, cbO = d[i + 2] / 255 - yv;
        const crB = bCr[r0 + ix] * w00 + bCr[r0 + ix1] * w01 + bCr[r1 + ix] * w10 + bCr[r1 + ix1] * w11;
        const cbB = bCb[r0 + ix] * w00 + bCb[r0 + ix1] * w01 + bCb[r1 + ix] * w10 + bCb[r1 + ix1] * w11;
        const cr = crO + (crB - crO) * wgt, cb = cbO + (cbB - cbO) * wgt;
        const rr = yv + cr, bb = yv + cb, gg = (yv - 0.2126 * rr - 0.0722 * bb) / 0.7152;
        d[i] = rr * 255; d[i + 1] = gg * 255; d[i + 2] = bb * 255;
      }
    }
  }
  o.prog(0.6);
  if (dY) for (let k = 0; k < n; k++) dY[k] = Ycur[k] - Y[k];
  if (st.sharpen || o.view === 'sharpenMask') {
    const B = blurPlane(Ycur, w, h, o.sigSh);
    const amt = (s.sharpen.amount / 100) * 1.35 * (0.6 + 0.4 * o.sigSh / Math.max(0.25, s.sharpen.radius));
    const det = s.sharpen.detail / 100, lim = 0.015 + 0.25 * det * det;
    const mk = s.sharpen.masking / 100;
    let mask = null;
    if (mk > 0 || o.view === 'sharpenMask') {
      const E = blurPlane(Ycur, w, h, Math.max(0.8, o.sigSh * 1.2));
      mask = new Float32Array(n);
      const t0 = mk * mk * 0.12, t1 = t0 + 0.02 + mk * 0.04, gk = 2.5 / Math.max(0.6, o.sigSh);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const k = y * w + x;
        const gx = E[y * w + (x < w - 1 ? x + 1 : x)] - E[y * w + (x > 0 ? x - 1 : x)];
        const gy = E[(y < h - 1 ? y + 1 : y) * w + x] - E[(y > 0 ? y - 1 : y) * w + x];
        mask[k] = mk > 0 ? smooth(t0, t1, Math.sqrt(gx * gx + gy * gy) * gk) : 1;
      }
    }
    if (o.view === 'sharpenMask') {
      for (let k = 0, i = 0; k < n; k++, i += 4) { const v = mask ? mask[k] * 255 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return;
    }
    const dl = 1 - det;
    for (let k = 0, i = 0; k < n; k++, i += 4) {
      let df = Ycur[k] - B[k];
      const cl = df > lim ? lim : df < -lim ? -lim : df;
      df = (df * det + cl * dl) * amt;
      if (mask) df *= mask[k];
      const v = (dY ? dY[k] + df : df) * 255;
      if (v > 0.02 || v < -0.02) { d[i] += v; d[i + 1] += v; d[i + 2] += v; }
    }
    return;
  }
  if (dY) for (let k = 0, i = 0; k < n; k++, i += 4) { const v = dY[k] * 255; if (v) { d[i] += v; d[i + 1] += v; d[i + 2] += v; } }
}

function hash2(x, y, seed) {
  let hh = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 2246822519) | 0;
  hh = Math.imul(hh ^ (hh >>> 13), 1274126177);
  hh ^= hh >>> 16;
  return ((hh & 0xffff) / 32767.5) - 1;
}
function effectsPass(img, s, st, o) {
  const w = img.width, h = img.height, d = img.data, e = s.effects;
  const { wx, wy, FW, FH, scale } = o;
  // post-crop vignette map over normalized coords (VN x VN grid)
  let vmap = null, VN = 129;
  if (st.pcv) {
    vmap = new Float32Array(VN * VN);
    const rnd = e.vignetteRoundness / 100, mid = e.vignetteMidpoint / 100, fe = e.vignetteFeather / 100;
    const r0 = 0.15 + mid * 0.95, fw = 0.04 + fe * 0.95;
    const nExp = rnd < 0 ? 2 + -rnd * 10 : 2;
    for (let j = 0; j < VN; j++) for (let i = 0; i < VN; i++) {
      const nx = (i / (VN - 1)) * 2 - 1, ny = (j / (VN - 1)) * 2 - 1;
      let dist;
      if (rnd >= 0) {
        const de = Math.hypot(nx, ny); // ellipse following the image aspect
        const px = nx * FW, py = ny * FH, dc = (Math.hypot(px, py) / Math.hypot(FW, FH)) * Math.SQRT2; // circle in pixel space
        dist = de * (1 - rnd) + dc * rnd;
      } else dist = Math.pow(Math.pow(Math.abs(nx), nExp) + Math.pow(Math.abs(ny), nExp), 1 / nExp);
      vmap[j * VN + i] = smooth(r0 - fw * 0.5, r0 + fw * 0.5, dist);
    }
  }
  const amt = e.vignetteAmount / 100, hp = e.vignetteHighlights / 100, style = e.vignetteStyle;
  // grain
  const gA = (e.grainAmount / 100) * 0.16;
  const cell = 0.7 + (e.grainSize / 100) * 3.3; // full-res pixels
  const cellPx = cell * scale, ampK = Math.min(1, cellPx);
  const rough = e.grainRoughness / 100;
  // grain lattices (value noise, two octaves) covering this tile only
  let oct = null;
  if (gA > 0 && cellPx >= 1) {
    const mk = (fq, off, seedN) => {
      const k = 1 / (scale * cell) * fq;
      const cx0 = new Int32Array(w), csx = new Float32Array(w), cy0 = new Int32Array(h), csy = new Float32Array(h);
      const lx0 = Math.floor(wx * k + off), ly0 = Math.floor(wy * k + off * 0.37);
      const lw = Math.floor((wx + w) * k + off) - lx0 + 2, lh = Math.floor((wy + h) * k + off * 0.37) - ly0 + 2;
      for (let x = 0; x < w; x++) { const v = (wx + x) * k + off, f = Math.floor(v), t = v - f; cx0[x] = f - lx0; csx[x] = t * t * (3 - 2 * t); }
      for (let y = 0; y < h; y++) { const v = (wy + y) * k + off * 0.37, f = Math.floor(v), t = v - f; cy0[y] = (f - ly0) * lw; csy[y] = t * t * (3 - 2 * t); }
      const L = new Float32Array(lw * lh);
      for (let j = 0; j < lh; j++) for (let i2 = 0; i2 < lw; i2++) L[j * lw + i2] = hash2(lx0 + i2, ly0 + j, seedN);
      return { cx0, csx, cy0, csy, L, lw };
    };
    oct = [mk(1, 0, 7), mk(2.3, 17.1, 11)];
  }
  const w1 = 1 - rough * 0.5, w2 = rough * 0.7;
  for (let y = 0; y < h; y++) {
    const Y = wy + y, vy = ((Y + 0.5) / FH) * (VN - 1);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, X = wx + x;
      let r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      if (vmap) {
        const vx = ((X + 0.5) / FW) * (VN - 1), ix = Math.min(VN - 2, vx | 0), iy = Math.min(VN - 2, vy | 0), fx = vx - ix, fy = vy - iy;
        const f = (vmap[iy * VN + ix] * (1 - fx) + vmap[iy * VN + ix + 1] * fx) * (1 - fy) + (vmap[(iy + 1) * VN + ix] * (1 - fx) + vmap[(iy + 1) * VN + ix + 1] * fx) * fy;
        if (f > 0) {
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          if (amt < 0) {
            let th = (L - 0.55) / 0.45; th = th < 0 ? 0 : th > 1 ? 1 : th; const a = -amt * f * (1 - hp * th * th * (3 - 2 * th));
            if (style === 'paint') { r -= r * a; g -= g * a; b -= b * a; r = r * 0.85 + r * 0.15 * (1 - a); g = g * 0.85 + g * 0.15 * (1 - a); b = b * 0.85 + b * 0.15 * (1 - a); }
            else if (style === 'color') { const k = 1 - a * 0.95; r *= k; g *= k; b *= k; }
            else { const k0 = 1 - a * 0.95, k = k0 * Math.sqrt(k0); r = enc(dec(r) * k); g = enc(dec(g) * k); b = enc(dec(b) * k); }
          } else {
            const a = amt * f;
            if (style === 'paint') { r += (1 - r) * a; g += (1 - g) * a; b += (1 - b) * a; }
            else { const k = 1 - a * 0.9; r = 1 - (1 - r) * k; g = 1 - (1 - g) * k; b = 1 - (1 - b) * k; }
          }
        }
      }
      if (gA > 0) {
        let nz;
        if (oct) {
          nz = 0;
          for (let q = 0; q < 2; q++) {
            const O = oct[q], L = O.L, a = O.cy0[y] + O.cx0[x], sx = O.csx[x], sy = O.csy[y];
            const v = (L[a] + (L[a + 1] - L[a]) * sx) * (1 - sy) + (L[a + O.lw] + (L[a + O.lw + 1] - L[a + O.lw]) * sx) * sy;
            nz += v * (q ? w2 : w1);
          }
        } else nz = hash2(X, Y, 7) * (1 - rough * 0.3) * 0.9;
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const v = nz * gA * ampK * (0.35 + 2.6 * L * (1 - L));
        r += v; g += v; b += v;
      }
      d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
    }
  }
}

// ---------------------------------------------------------------------------
// histogram + auto
// ---------------------------------------------------------------------------
export function rawHistogram(img) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] + 0.5) | 0]++;
  }
  return { r, g, b, l };
}

function samplePixels(img, max = 250000) {
  const n = img.width * img.height, step = Math.max(1, Math.floor(n / max));
  return { step, n };
}

export function autoWhiteBalance(img) {
  const d = img.data, { step, n } = samplePixels(img);
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let k = 0; k < n; k += step) {
    const i = k * 4; if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx > 250 || mx < 20 || (mx - mn) / mx > 0.6) continue;
    sr += DEC8[r]; sg += DEC8[g]; sb += DEC8[b]; cnt++;
  }
  if (cnt < 16 || !sr || !sg || !sb) return { temperature: 0, tint: 0 };
  // solve the gain model for neutral average (partial correction, like a camera's auto WB)
  const lr = Math.log(sr / cnt), lg = Math.log(sg / cnt), lb = Math.log(sb / cnt);
  const t = (lb - lr) / (WB_A + WB_B);
  const tn = (lg - lr - WB_A * t) / (WB_C + WB_D);
  const k = 0.85;
  return { temperature: Math.round(clamp(t * 100 * k, -100, 100)), tint: Math.round(clamp(tn * 100 * k, -100, 100)) };
}

export function autoRawSettings(img) {
  const d = img.data, { step, n } = samplePixels(img);
  const H = new Float64Array(256); let cnt = 0, satSum = 0;
  for (let k = 0; k < n; k += step) {
    const i = k * 4; if (d[i + 3] < 128) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    H[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++; cnt++;
    const mx = Math.max(r, g, b); satSum += mx ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  if (!cnt) return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, saturation: 0 };
  const pct = (q) => { let acc = 0; for (let i = 0; i < 256; i++) { acc += H[i]; if (acc >= q * cnt) return i / 255; } return 1; };
  const p001 = pct(0.001), p05 = pct(0.05), p50 = pct(0.5), p95 = pct(0.95), p999 = pct(0.999);
  // exposure: bring the median to ~0.45 (perceptual), damped
  let ev = Math.log2(srgbDec(0.45) / Math.max(1e-4, srgbDec(Math.max(0.02, p50)))) * 0.8;
  ev = clamp(ev, -2.5, 2.5);
  const g = Math.pow(2, ev);
  const adj = (p) => clamp01(srgbEnc(Math.min(1, srgbDec(p) * g)));
  const a05 = adj(p05), a95 = adj(p95), a999 = adj(p999), a001 = adj(p001);
  const highlights = a95 > 0.78 ? clamp(-(a95 - 0.7) * 230, -75, 0) : 0;
  const shadows = a05 < 0.16 ? clamp((0.18 - a05) * 260, 0, 60) : 0;
  const whites = clamp((0.985 - a999) * 160, -40, 40);
  const blacks = a001 > 0.05 ? clamp(-(a001 - 0.03) * 220, -40, 0) : clamp((0.012 - a001) * 900, 0, 20);
  const spread = a95 - a05;
  const contrast = clamp((0.72 - spread) * 55, -25, 30);
  const meanSat = satSum / cnt;
  const vibrance = clamp((0.42 - meanSat) * 60, 0, 25);
  const saturation = clamp((0.3 - meanSat) * 15, -5, 6);
  const r2 = (v) => Math.round(v * 20) / 20;
  return { exposure: r2(ev), contrast: Math.round(contrast), highlights: Math.round(highlights), shadows: Math.round(shadows), whites: Math.round(whites), blacks: Math.round(blacks), vibrance: Math.round(vibrance), saturation: Math.round(saturation) };
}

// True when the settings are all neutral (applyCameraRaw would be an identity).
export function isDefaultRawSettings(s) { return !analyse(normalizeRawSettings(s)).any; }
// Which panel groups differ from defaults (for the UI's "edited" dots)
export function rawStages(s) { return analyse(normalizeRawSettings(s)); }

// White balance that makes the given (8-bit, sRGB) colour neutral — for the White Balance tool.
export function neutralWhiteBalance(r8, g8, b8) {
  const r = Math.max(1e-4, srgbDec(clamp(r8, 0, 255) / 255)), g = Math.max(1e-4, srgbDec(clamp(g8, 0, 255) / 255)), b = Math.max(1e-4, srgbDec(clamp(b8, 0, 255) / 255));
  const lr = Math.log(r), lg = Math.log(g), lb = Math.log(b);
  const t = (lb - lr) / (WB_A + WB_B), tn = (lg - lr - WB_A * t) / (WB_C + WB_D);
  return { temperature: Math.round(clamp(t * 100, -100, 100)), tint: Math.round(clamp(tn * 100, -100, 100)) };
}
// Point-curve spline used by the engine (points in 0..255) -> f(x 0..1) -> 0..1
export const curveSpline = (points) => splineFloat(points);
