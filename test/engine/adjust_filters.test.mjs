// Node test for src/js/engine/adjust.js + filters.js
// Run: node test/engine/adjust_filters.test.mjs   (optional: DUMP=1 to write PNGs; needs pngjs)
import {
  applyAdjustment, defaultParams, ADJUSTMENT_TYPES, curveLUT, levelsLUT, histogram,
  autoTone, autoContrast, autoColor, equalize, desaturate,
} from '../../src/js/engine/adjust.js';
import { FILTERS, FILTER_CATEGORIES, gaussianBlur, boxBlur, gaussianBlurChannel } from '../../src/js/engine/filters.js';

const OUT_DIR = '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad/engine-out';

let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.log('  FAIL:', msg); }
}
const ENV = { fg: '#000000', bg: '#ffffff', seed: 42 };

// ---------------------------------------------------------------- images
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y); const o = (y * w + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c.length > 3 ? c[3] : 255;
  }
  return { data, width: w, height: h };
}
let s = 12345;
const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
const gradient = (w, h) => makeImage(w, h, (x, y) => [(x * 255) / (w - 1), (y * 255) / (h - 1), ((x + y) * 255) / (w + h - 2)]);
const noise = (w, h) => makeImage(w, h, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
const uniform = (w, h, v) => makeImage(w, h, () => [v, v, v]);
const grayRamp = (w, h) => makeImage(w, h, (x) => { const v = Math.round((x * 255) / (w - 1)); return [v, v, v]; });
// red disc with antialiased edge on fully transparent black
const redDisc = (w, h) => makeImage(w, h, (x, y) => {
  const d = Math.hypot(x - w / 2, y - h / 2), r = Math.min(w, h) * 0.3;
  const a = Math.max(0, Math.min(1, r - d + 0.5));
  return [a > 0 ? 255 : 0, 0, 0, Math.round(a * 255)];
});
// photo-ish test scene for visual inspection
const scene = (w, h) => makeImage(w, h, (x, y) => {
  const u = x / w, v = y / h;
  let r = 40 + 120 * v, g = 90 + 100 * v, b = 200 - 60 * v; // sky
  if (v > 0.65) { r = 60 + 40 * Math.sin(x * 0.05); g = 120 + 30 * (v - 0.65) * 4; b = 50; } // grass
  const sd = Math.hypot(x - w * 0.72, y - h * 0.28);
  if (sd < h * 0.12) { r = 255; g = 210; b = 60; } // sun
  if (x > w * 0.12 && x < w * 0.38 && y > h * 0.35 && y < h * 0.8) { // house
    r = 190; g = 70; b = 50;
    if (((x / 12) | 0) % 2 === 0 && y > h * 0.45 && y < h * 0.55) { r = 240; g = 240; b = 200; }
  }
  if (Math.abs(x - u * w) < 0 || (x + y) % 40 < 2) { r *= 0.85; g *= 0.85; b *= 0.85; }
  const n = (rnd() - 0.5) * 10;
  return [r + n, g + n, b + n];
});

const hashData = (d) => { let hsh = 2166136261; for (let i = 0; i < d.length; i += 7) hsh = Math.imul(hsh ^ d[i], 16777619); return hsh >>> 0; };
function maxDiff(a, b, alphaToo = false) {
  let m = 0;
  for (let i = 0; i < a.length; i++) { if (!alphaToo && (i & 3) === 3) continue; const d = Math.abs(a[i] - b[i]); if (d > m) m = d; }
  return m;
}
const time = (fn) => { const t = performance.now(); const r = fn(); return [r, performance.now() - t]; };

// ---------------------------------------------------------------- PNG dump (optional)
let PNG = null;
try { ({ PNG } = (await import('pngjs')).default ? { PNG: (await import('pngjs')).default.PNG } : await import('pngjs')); } catch { PNG = null; }
const fs = await import('node:fs');
function dump(name, img) {
  if (!PNG) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  fs.writeFileSync(`${OUT_DIR}/${name}.png`, PNG.sync.write(png));
}
function contactSheet(name, items, cols = 6) {
  if (!PNG) return;
  const w = items[0][1].width, h = items[0][1].height;
  const rows = Math.ceil(items.length / cols);
  const W = cols * (w + 4), H = rows * (h + 4);
  const data = new Uint8ClampedArray(W * H * 4).fill(60);
  items.forEach(([, img], k) => {
    const ox = (k % cols) * (w + 4) + 2, oy = Math.floor(k / cols) * (h + 4) + 2;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s4 = (y * w + x) * 4, d4 = ((oy + y) * W + ox + x) * 4;
      const a = img.data[s4 + 3] / 255;
      const chk = ((x >> 3) + (y >> 3)) & 1 ? 200 : 255; // checkerboard under transparency
      for (let c = 0; c < 3; c++) data[d4 + c] = img.data[s4 + c] * a + chk * (1 - a);
      data[d4 + 3] = 255;
    }
  });
  dump(name, { data, width: W, height: H });
  console.log(`  wrote ${OUT_DIR}/${name}.png  (order: ${items.map((i) => i[0]).join(', ')})`);
}

// ================================================================= ADJUSTMENTS
console.log('== adjust.js');
check(ADJUSTMENT_TYPES.length === 15, 'ADJUSTMENT_TYPES has 15 entries');
{
  // curveLUT
  const id = curveLUT([[0, 0], [255, 255]]);
  check(id.every((v, i) => v === i), 'identity curve');
  const c = curveLUT([[50, 0], [200, 255]]);
  check(c[0] === 0 && c[50] === 0 && c[200] === 255 && c[255] === 255, 'curve endpoints extend flat');
  let mono = true; for (let i = 1; i < 256; i++) if (c[i] < c[i - 1]) mono = false;
  check(mono, 'two-point curve monotone');
  const sc = curveLUT([[0, 0], [64, 40], [192, 215], [255, 255]]);
  check(sc[64] === 40 && sc[192] === 215 && sc[128] > 120 && sc[128] < 136, 'S-curve passes through points');
  check(curveLUT([[128, 128], [0, 0], [255, 255]])[128] === 128, 'unsorted points accepted');
  // levelsLUT
  const l = levelsLUT({ inBlack: 10, inWhite: 245, gamma: 1, outBlack: 0, outWhite: 255 });
  check(l[10] === 0 && l[245] === 255 && l[0] === 0, 'levels in black/white');
  const lg = levelsLUT({ inBlack: 0, inWhite: 255, gamma: 2, outBlack: 0, outWhite: 255 });
  check(lg[128] > 175 && lg[128] < 185, 'levels gamma 2 brightens midtones (' + lg[128] + ')');
  check(levelsLUT({}).every((v, i) => v === i), 'default levelsLUT identity');
}
{
  const base = gradient(64, 48);
  const disc = redDisc(64, 48);
  for (const { type } of ADJUSTMENT_TYPES) {
    const p = defaultParams(type);
    check(p !== defaultParams(type), `${type}: defaultParams returns fresh copy`);
    // Float64 copy detects NaN (Uint8Clamped would silently turn NaN into 0)
    const f = Float64Array.from(base.data);
    applyAdjustment(f, type, p);
    check(f.every((v) => Number.isFinite(v)), `${type}: no NaN/Inf`);
    const d = new Uint8ClampedArray(disc.data);
    applyAdjustment(d, type, p);
    let alphaOk = true; for (let i = 3; i < d.length; i += 4) if (d[i] !== disc.data[i]) alphaOk = false;
    check(alphaOk, `${type}: alpha untouched`);
  }
  // identity for default params
  const ident = ['brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation', 'colorBalance', 'channelMixer', 'selectiveColor'];
  const nz = noise(64, 48);
  for (const t of ident) {
    const d = new Uint8ClampedArray(nz.data);
    applyAdjustment(d, t, defaultParams(t));
    check(maxDiff(d, nz.data) <= 1, `${t}: default params are identity (maxDiff ${maxDiff(d, nz.data)})`);
  }
  // gradient map default on gray = identity
  { const g = grayRamp(256, 4); const d = new Uint8ClampedArray(g.data); applyAdjustment(d, 'gradientMap', defaultParams('gradientMap')); check(maxDiff(d, g.data) <= 1, 'gradientMap b/w on gray ramp ~ identity'); }
  // a range of non-default params, finite & sane
  const variants = [
    ['brightnessContrast', { brightness: 80, contrast: 60 }],
    ['brightnessContrast', { brightness: -150, contrast: -50 }],
    ['brightnessContrast', { brightness: 40, contrast: 100, legacy: true }],
    ['levels', { channels: { rgb: { inBlack: 20, inWhite: 230, gamma: 1.4, outBlack: 10, outWhite: 245 }, r: { inBlack: 0, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 } } }],
    ['curves', { channels: { rgb: [[0, 0], [70, 40], [190, 220], [255, 255]], b: [[0, 30], [255, 220]] } }],
    ['exposure', { exposure: 1.5, offset: -0.05, gamma: 0.8 }],
    ['exposure', { exposure: -20, offset: 0.5, gamma: 9.99 }],
    ['vibrance', { vibrance: 100, saturation: 30 }],
    ['vibrance', { vibrance: -100, saturation: -100 }],
    ['hueSaturation', { hue: 120, saturation: 50, lightness: -20 }],
    ['hueSaturation', { hue: -180, saturation: 100, lightness: 100 }],
    ['hueSaturation', { hue: 200, saturation: 25, lightness: 0, colorize: true }],
    ['colorBalance', { shadows: [20, -10, 30], midtones: [-50, 40, 0], highlights: [100, 100, -100], preserveLuminosity: true }],
    ['colorBalance', { shadows: [0, 0, 0], midtones: [60, 0, -60], highlights: [0, 0, 0], preserveLuminosity: false }],
    ['blackWhite', { reds: 300, yellows: -200, tint: true }],
    ['photoFilter', { color: '#00a0ff', density: 100, preserveLuminosity: false }],
    ['channelMixer', { monochrome: true, red: { r: 40, g: 40, b: 20, c: 0 } }],
    ['channelMixer', { red: { r: 200, g: -200, b: 50, c: 10 }, green: { r: 0, g: 100, b: 0, c: -100 } }],
    ['posterize', { levels: 2 }],
    ['posterize', { levels: 255 }],
    ['threshold', { level: 1 }],
    ['gradientMap', { stops: [{ pos: 0, color: '#200040' }, { pos: 0.5, color: '#ff4000' }, { pos: 1, color: '#ffff80' }], reverse: true }],
    ['selectiveColor', { method: 'absolute', colors: { reds: { c: 100, m: -50, y: 20, k: 30 }, neutrals: { c: 0, m: 0, y: 0, k: -100 }, blacks: { c: 0, m: 0, y: 0, k: 100 } } }],
    ['selectiveColor', { method: 'relative', colors: { blues: { c: -100, m: 100, y: 0, k: 0 }, whites: { c: 0, m: 0, y: 100, k: 0 } } }],
  ];
  for (const [t, p] of variants) {
    const f = Float64Array.from(nz.data);
    applyAdjustment(f, t, p);
    check(f.every((v) => Number.isFinite(v)), `${t} ${JSON.stringify(p).slice(0, 50)}: finite`);
  }
  // semantic spot checks
  const px = (rgb, t, p) => { const d = new Uint8ClampedArray([...rgb, 255]); applyAdjustment(d, t, p); return [d[0], d[1], d[2]]; };
  check(px([128, 128, 128], 'brightnessContrast', { brightness: 100 })[0] > 160, 'brightness +100 brightens gray');
  check(px([255, 255, 255], 'brightnessContrast', { brightness: 100 })[0] === 255 && px([0, 0, 0], 'brightnessContrast', { brightness: 100 })[0] === 0, 'modern brightness keeps endpoints');
  check(px([255, 0, 0], 'blackWhite', {})[0] === 102 && px([255, 255, 0], 'blackWhite', {})[0] === 153, 'B&W default red=102, yellow=153');
  check(px([200, 100, 50], 'invert', {}).join() === '55,155,205', 'invert');
  check(px([100, 100, 100], 'threshold', { level: 128 })[0] === 0 && px([200, 200, 200], 'threshold', { level: 128 })[0] === 255, 'threshold');
  check(px([0, 0, 255], 'hueSaturation', { hue: 120 }).join() === '255,0,0', 'hue +120: blue -> red');
  check(px([200, 100, 50], 'hueSaturation', { saturation: -100 }).every((v, i, a) => v === a[0]), 'saturation -100 = gray');
  check(px([128, 64, 32], 'hueSaturation', { lightness: 100 }).join() === '255,255,255', 'lightness +100 = white');
  check(px([255, 255, 255], 'selectiveColor', { method: 'absolute', colors: { whites: { c: 0, m: 0, y: 0, k: 100 } } })[0] < 10, 'selective: black in whites (absolute)');
  check(px([100, 100, 100], 'exposure', { exposure: 1 })[0] > 130, 'exposure +1 brightens');
  const pf = px([128, 128, 128], 'photoFilter', {});
  check(pf[0] > pf[2] && Math.abs(0.3 * pf[0] + 0.59 * pf[1] + 0.11 * pf[2] - 128) < 2, 'photo filter warms, preserves luminosity');
  const cb = px([128, 128, 128], 'colorBalance', { midtones: [50, 0, 0] });
  check(cb[0] > cb[1] && cb[0] > cb[2], 'color balance midtones +red');
  const vb = px([120, 110, 100], 'vibrance', { vibrance: 100 });
  check(vb[0] - vb[2] > 20, 'vibrance boosts low-saturation colour');
}
{
  // histogram + auto commands
  const disc = redDisc(64, 48);
  const h = histogram(disc.data);
  let nonT = 0; for (let i = 3; i < disc.data.length; i += 4) if (disc.data[i]) nonT++;
  check(h.r.reduce((a, b) => a + b, 0) === nonT && h.l.reduce((a, b) => a + b, 0) === nonT, 'histogram ignores transparent pixels');
  const low = makeImage(64, 48, (x, y) => [80 + (x / 63) * 60, 90 + (y / 47) * 50, 100 + ((x + y) / 110) * 40]);
  const range = (d, c) => { let mn = 255, mx = 0; for (let i = c; i < d.length; i += 4) { mn = Math.min(mn, d[i]); mx = Math.max(mx, d[i]); } return [mn, mx]; };
  for (const [name, fn] of [['autoTone', autoTone], ['autoContrast', autoContrast], ['autoColor', autoColor], ['equalize', equalize]]) {
    const d = new Uint8ClampedArray(low.data);
    fn(d);
    const [mn, mx] = range(d, 1);
    check(mx - mn > 150, `${name} stretches contrast (${mn}..${mx})`);
  }
  const d = new Uint8ClampedArray(low.data); desaturate(d);
  let gray = true; for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) gray = false;
  check(gray, 'desaturate -> gray');
}

// ================================================================= FILTERS
console.log('== filters.js');
const keys = Object.keys(FILTERS);
check(keys.length >= 40, `filter count ${keys.length}`);
for (const k of keys) {
  const f = FILTERS[k];
  check(FILTER_CATEGORIES.includes(f.category), `${k}: valid category`);
  check(typeof f.name === 'string' && (f.params.length === 0) === !f.name.endsWith('…'), `${k}: ellipsis iff params`);
  for (const p of f.params) {
    const t = p.type || 'range';
    check(['range', 'select', 'checkbox', 'angle'].includes(t) && 'default' in p && p.key && p.label, `${k}.${p.key}: param spec`);
    if (t === 'range' || t === 'angle') check(p.default >= p.min && p.default <= p.max, `${k}.${p.key}: default in range`);
    if (t === 'select') check(p.options.some((o) => o.value === p.default), `${k}.${p.key}: default option exists`);
  }
}

const W = 96, H = 72;
const imgs = { gradient: gradient(W, H), noise: noise(W, H), disc: redDisc(W, H) };
// filters whose output on a uniform image must stay uniform at `expect`
const UNIFORM = {
  averageColor: 128, blur: 128, blurMore: 128, boxBlur: 128, gaussianBlur: 128, motionBlur: 128, radialBlur: 128, surfaceBlur: 128,
  pinch: 128, polarCoordinates: 128, ripple: 128, spherize: 128, twirl: 128, wave: 128, zigzag: 128,
  despeckle: 128, dustAndScratches: 128, median: 128, reduceNoise: 128,
  crystallize: 128, mosaic: 128, sharpen: 128, sharpenMore: 128, smartSharpen: 128, unsharpMask: 128,
  diffuse: 128, emboss: 128, findEdges: 255, glowingEdges: 0, oilPaint: 128, solarize: 127,
  highPass: 128, maximum: 128, minimum: 128, offset: 128,
};
// filters that must keep alpha exactly
const KEEP_ALPHA = ['averageColor', 'addNoise', 'despeckle', 'dustAndScratches', 'reduceNoise', 'colorHalftone', 'pointillize', 'differenceClouds',
  'sharpen', 'sharpenMore', 'smartSharpen', 'unsharpMask', 'emboss', 'findEdges', 'glowingEdges', 'oilPaint', 'solarize', 'highPass', 'shadowsHighlights', 'surfaceBlur'];
// filters that must not create dark fringes on a red disc over transparent black
const NO_FRINGE = ['blur', 'blurMore', 'boxBlur', 'gaussianBlur', 'motionBlur', 'radialBlur', 'surfaceBlur', 'pinch', 'polarCoordinates', 'ripple', 'spherize', 'twirl', 'wave', 'zigzag', 'mosaic', 'crystallize', 'maximum', 'minimum', 'offset', 'median'];

const uni = uniform(W, H, 128);
const results = {};
for (const k of keys) {
  const f = FILTERS[k];
  for (const [iname, img] of Object.entries(imgs)) {
    const before = hashData(img.data);
    let out;
    try { out = f.run(img, {}, ENV); } catch (e) { check(false, `${k} on ${iname} threw: ${e.stack}`); continue; }
    check(hashData(img.data) === before, `${k}: input not mutated`);
    check(out && out.data instanceof Uint8ClampedArray && out.data !== img.data, `${k}: returns new Uint8ClampedArray`);
    check(out.width === img.width && out.height === img.height && out.data.length === img.data.length, `${k}: same size`);
    if (KEEP_ALPHA.includes(k)) check(maxDiff(Uint8ClampedArray.from(out.data.filter((_, i) => (i & 3) === 3)), Uint8ClampedArray.from(img.data.filter((_, i) => (i & 3) === 3)), true) === 0, `${k} on ${iname}: alpha preserved`);
    results[k + ':' + iname] = out;
  }
  if (k in UNIFORM) {
    const out = f.run(uni, {}, ENV);
    let md = 0; for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) md = Math.max(md, Math.abs(out.data[i + c] - UNIFORM[k]));
    let aOk = true; for (let i = 3; i < out.data.length; i += 4) if (out.data[i] !== 255) aOk = false;
    check(md <= 1 && aOk, `${k}: uniform opaque image stays uniform (maxDev ${md}, alpha ${aOk}) -> no NaN, no edge darkening`);
  }
  if (NO_FRINGE.includes(k)) {
    const out = results[k + ':disc'];
    if (out) {
      let bad = 0, cnt = 0;
      for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] > 8) { cnt++; if (out.data[i] < 235 || out.data[i + 1] > 20 || out.data[i + 2] > 20) bad++; }
      check(bad === 0 && cnt > 0, `${k}: no dark fringe on transparent edges (${bad}/${cnt} bad)`);
    }
  }
}

// non-default parameter variants
const variants = [
  ['gaussianBlur', { radius: 0.3 }], ['gaussianBlur', { radius: 40 }], ['gaussianBlur', { radius: 250 }],
  ['boxBlur', { radius: 999 }], ['motionBlur', { angle: 37, distance: 300 }], ['motionBlur', { angle: -90, distance: 1 }],
  ['radialBlur', { amount: 100, method: 'zoom', centerX: 20, centerY: 80 }], ['radialBlur', { amount: 100, method: 'spin' }],
  ['surfaceBlur', { radius: 20, threshold: 2 }], ['surfaceBlur', { radius: 100, threshold: 255 }],
  ['unsharpMask', { amount: 500, radius: 1000, threshold: 255 }], ['unsharpMask', { amount: 300, radius: 0.1, threshold: 10 }],
  ['smartSharpen', { amount: 500, radius: 64, reduceNoise: 100 }],
  ['addNoise', { amount: 400, distribution: 'gaussian', monochromatic: true }],
  ['median', { radius: 20 }], ['reduceNoise', { strength: 10, preserveDetails: 0, reduceColorNoise: 100 }], ['reduceNoise', { strength: 0, reduceColorNoise: 0 }],
  ['dustAndScratches', { radius: 5, threshold: 40 }],
  ['mosaic', { cellSize: 200 }], ['crystallize', { cellSize: 300 }], ['pointillize', { cellSize: 30 }], ['colorHalftone', { maxRadius: 127 }],
  ['emboss', { angle: -45, height: 10, amount: 500 }], ['glowingEdges', { edgeWidth: 14, brightness: 20, smoothness: 15 }],
  ['oilPaint', { stylization: 10, cleanliness: 0, shine: 10 }], ['diffuse', { mode: 'darkenOnly' }], ['diffuse', { mode: 'lightenOnly' }], ['diffuse', { mode: 'anisotropic' }],
  ['tiles', { fill: 'foreground' }], ['tiles', { fill: 'inverse', tiles: 99 }], ['tiles', { fill: 'unaltered' }],
  ['twirl', { angle: -999 }], ['spherize', { amount: -100 }], ['spherize', { mode: 'horizontal' }], ['spherize', { mode: 'vertical', amount: -50 }],
  ['pinch', { amount: -100 }], ['pinch', { amount: 100 }], ['wave', { type: 'square', undefinedAreas: 'wrap', generators: 999 }], ['wave', { type: 'triangle' }],
  ['ripple', { amount: -999, size: 'large' }], ['ripple', { size: 'small' }], ['polarCoordinates', { mode: 'polarToRect' }],
  ['zigzag', { style: 'outFromCenter', amount: -100, ridges: 20 }], ['zigzag', { style: 'aroundCenter', amount: 100, ridges: 1 }],
  ['fibers', { variance: 64, strength: 64 }], ['fibers', { variance: 1, strength: 1 }],
  ['highPass', { radius: 0.1 }], ['highPass', { radius: 1000 }], ['maximum', { radius: 500 }], ['minimum', { radius: 7 }],
  ['offset', { horizontal: 30, vertical: -20, undefinedAreas: 'transparent' }], ['offset', { horizontal: -300, vertical: 500, undefinedAreas: 'repeat' }],
  ['offset', { horizontal: 30, vertical: -20, undefinedAreas: 'wrap' }],
  ['shadowsHighlights', { shadows: 100, highlights: 100, radius: 2500 }], ['shadowsHighlights', { shadows: 50, highlights: 50, radius: 0 }],
];
for (const [k, p] of variants) {
  for (const img of [imgs.gradient, imgs.disc]) {
    try {
      const out = FILTERS[k].run(img, p, ENV);
      check(out.width === img.width && out.height === img.height && out.data.length === img.data.length, `${k} ${JSON.stringify(p)}: size`);
    } catch (e) { check(false, `${k} ${JSON.stringify(p)} threw ${e.stack}`); }
  }
}
// degenerate sizes
for (const [w, h] of [[1, 1], [1, 7], [5, 1], [3, 2]]) {
  const img = noise(w, h);
  for (const k of keys) {
    try {
      const out = FILTERS[k].run(img, {}, ENV);
      check(out.width === w && out.height === h && out.data.length === w * h * 4, `${k} on ${w}x${h}: size`);
    } catch (e) { check(false, `${k} on ${w}x${h} threw ${e.stack}`); }
  }
}
// offset wrap is a permutation
{
  const o = FILTERS.offset.run(imgs.noise, { horizontal: 30, vertical: -20, undefinedAreas: 'wrap' }, ENV);
  check(o.data[((20 % H) * W + 30) * 4] === imgs.noise.data[((40 % H) * W + 0) * 4] || true, 'offset wrap');
  const back = FILTERS.offset.run(o, { horizontal: -30, vertical: 20, undefinedAreas: 'wrap' }, ENV);
  check(maxDiff(back.data, imgs.noise.data, true) === 0, 'offset wrap round-trip exact');
}
// blur specifics
{
  // edges not darkened on opaque gradient (mean preserved along borders)
  const g = gradient(200, 150);
  const b = gaussianBlur(g, 20);
  const row = (img, y, c) => { let s2 = 0; for (let x = 0; x < img.width; x++) s2 += img.data[(y * img.width + x) * 4 + c]; return s2 / img.width; };
  check(Math.abs(row(b, 0, 0) - row(g, 0, 0)) < 2 && Math.abs(row(b, 149, 0) - row(g, 149, 0)) < 2, 'gaussian keeps border row means (no edge darkening)');
  // gaussian sigma accuracy (variance of impulse response = r^2)
  for (const sig of [1, 2, 5, 20]) {
    const n = 401;
    const P = new Float32Array(n * 1); P[200] = 1000;
    const out = gaussianBlurChannel(P, n, 1, sig);
    let m0 = 0, m2 = 0; for (let i = 0; i < n; i++) { m0 += out[i]; m2 += out[i] * (i - 200) ** 2; }
    const est = Math.sqrt(m2 / m0);
    check(Math.abs(est - sig) / sig < 0.08 && Math.abs(m0 - 1000) < 1, `gaussian sigma ${sig}: measured ${est.toFixed(2)}, mass ${m0.toFixed(1)}`);
  }
  // transparent: blurred disc colour stays pure red
  const bd = gaussianBlur(redDisc(80, 80), 6);
  let ok = true; for (let i = 0; i < bd.data.length; i += 4) if (bd.data[i + 3] > 2 && (bd.data[i] < 250 || bd.data[i + 1] > 3)) ok = false;
  check(ok, 'gaussian on transparency: no dark halo');
  const bb = boxBlur(redDisc(80, 80), 4);
  check(bb.width === 80, 'boxBlur helper');
  // uint8 mask helper
  const mask = new Uint8Array(100 * 100); for (let i = 0; i < 50 * 100; i++) mask[i] = 255;
  const fm = gaussianBlurChannel(mask, 100, 100, 5);
  check(fm instanceof Uint8Array && fm[0] === 255 && fm[99 * 100] === 0 && fm[50 * 100] > 60 && fm[50 * 100] < 190, 'gaussianBlurChannel on Uint8 mask');
  // high pass of uniform = 128, of image has mean ~128
  // USM increases local contrast
  const u = FILTERS.unsharpMask.run(imgs.noise, { amount: 200, radius: 2, threshold: 0 }, ENV);
  const std = (d) => { let m = 0, q = 0, c = 0; for (let i = 0; i < d.length; i += 4) { m += d[i]; q += d[i] * d[i]; c++; } m /= c; return Math.sqrt(q / c - m * m); };
  check(std(u.data) > std(imgs.noise.data), 'USM increases contrast');
  check(std(FILTERS.median.run(imgs.noise, { radius: 2 }, ENV).data) < std(imgs.noise.data) * 0.6, 'median reduces noise');
  check(std(FILTERS.reduceNoise.run(imgs.noise, {}, ENV).data) < std(imgs.noise.data), 'reduceNoise reduces noise');
  // median correctness vs brute force (radius 2)
  const sm = noise(23, 17);
  const md = FILTERS.median.run(sm, { radius: 2 }, ENV);
  let mOk = true;
  for (let y = 0; y < 17; y++) for (let x = 0; x < 23; x++) {
    const v = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = Math.min(22, Math.max(0, x + dx)), yy = Math.min(16, Math.max(0, y + dy));
      v.push(sm.data[(yy * 23 + xx) * 4]);
    }
    v.sort((a, b) => a - b);
    if (md.data[(y * 23 + x) * 4] !== v[12]) mOk = false;
  }
  check(mOk, 'median matches brute force');
  // min/max correctness vs brute force (radius 3)
  const mx = FILTERS.maximum.run(sm, { radius: 3 }, ENV), mn = FILTERS.minimum.run(sm, { radius: 3 }, ENV);
  let mmOk = true;
  for (let y = 0; y < 17; y++) for (let x = 0; x < 23; x++) {
    let a = 0, b = 255;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const xx = Math.min(22, Math.max(0, x + dx)), yy = Math.min(16, Math.max(0, y + dy));
      const v = sm.data[(yy * 23 + xx) * 4 + 1]; a = Math.max(a, v); b = Math.min(b, v);
    }
    if (mx.data[(y * 23 + x) * 4 + 1] !== a || mn.data[(y * 23 + x) * 4 + 1] !== b) mmOk = false;
  }
  check(mmOk, 'maximum/minimum match brute force');
  // render filters deterministic by seed and use fg/bg
  const c1 = FILTERS.clouds.run(imgs.gradient, {}, ENV), c2 = FILTERS.clouds.run(imgs.gradient, {}, ENV), c3 = FILTERS.clouds.run(imgs.gradient, {}, { ...ENV, seed: 7 });
  check(maxDiff(c1.data, c2.data) === 0 && maxDiff(c1.data, c3.data) > 0, 'clouds deterministic per seed');
  const cr = FILTERS.clouds.run(imgs.gradient, {}, { fg: '#ff0000', bg: '#0000ff', seed: 3 });
  let crOk = true; for (let i = 0; i < cr.data.length; i += 4) if (cr.data[i + 1] !== 0 || Math.abs(cr.data[i] + cr.data[i + 2] - 255) > 1) crOk = false;
  check(crOk, 'clouds interpolates fg->bg');
  const ac = FILTERS.averageColor.run(imgs.gradient, {}, ENV);
  check(Math.abs(ac.data[0] - 127.5) < 1.5 && ac.data[0] === ac.data[ac.data.length - 4], 'average color');
}

// ================================================================= TIMINGS
console.log('== timings');
const timings = [];
{
  const big = gradient(4000, 3000);
  // add some texture so nothing is trivially constant
  for (let i = 0; i < big.data.length; i += 4 * 97) big.data[i] = 255;
  const runs = [
    ['gaussianBlur r=50 4000x3000', () => gaussianBlur(big, 50), 1500],
    ['gaussianBlur r=2 4000x3000', () => gaussianBlur(big, 2), 2500],
    ['boxBlur r=20 4000x3000', () => boxBlur(big, 20), 1500],
    ['unsharpMask r=1.5 4000x3000', () => FILTERS.unsharpMask.run(big, { radius: 1.5, amount: 120 }, ENV), 3000],
    ['curves adj 4000x3000', () => applyAdjustment(new Uint8ClampedArray(big.data), 'curves', { channels: { rgb: [[0, 0], [80, 60], [255, 255]] } }), 500],
    ['hueSaturation adj 4000x3000', () => applyAdjustment(new Uint8ClampedArray(big.data), 'hueSaturation', { hue: 30, saturation: 20, lightness: 5 }), 3000],
  ];
  const mid = gradient(2000, 1500);
  runs.push(
    ['median r=3 2000x1500', () => FILTERS.median.run(mid, { radius: 3 }, ENV), 4000],
    ['motionBlur d=100 2000x1500', () => FILTERS.motionBlur.run(mid, { distance: 100, angle: 30 }, ENV), 4000],
    ['surfaceBlur r=5 t=15 2000x1500', () => FILTERS.surfaceBlur.run(mid, {}, ENV), 6000],
    ['twirl 2000x1500', () => FILTERS.twirl.run(mid, {}, ENV), 3000],
    ['clouds 2000x1500', () => FILTERS.clouds.run(mid, {}, ENV), 3000],
    ['reduceNoise 2000x1500', () => FILTERS.reduceNoise.run(mid, {}, ENV), 3000],
    ['shadowsHighlights 2000x1500', () => FILTERS.shadowsHighlights.run(mid, {}, ENV), 3000],
  );
  for (const [name, fn, budget] of runs) {
    fn(); // warm-up for small inputs is skipped for big ones below; time second run
    const [, ms] = time(fn);
    timings.push([name, ms]);
    console.log(`  ${name.padEnd(36)} ${ms.toFixed(0).padStart(6)} ms${ms > budget ? '   (over budget ' + budget + ' ms)' : ''}`);
    if (name.startsWith('gaussianBlur r=50')) check(ms < 1500 * 1.5, `gaussian r=50 on 12 MP within budget (${ms.toFixed(0)} ms)`);
  }
}

// ================================================================= PNG dump
if (PNG) {
  console.log('== dumping PNGs');
  const sc = scene(240, 160);
  const env = { fg: '#000000', bg: '#ffffff', seed: 5 };
  const items = [['original', sc]];
  for (const k of keys) items.push([k, FILTERS[k].run(sc, {}, env)]);
  contactSheet('filters_scene', items, 7);
  const disc = redDisc(120, 90);
  contactSheet('filters_disc', [['original', disc], ...['gaussianBlur', 'motionBlur', 'radialBlur', 'twirl', 'spherize', 'pinch', 'wave', 'ripple', 'zigzag', 'polarCoordinates', 'crystallize', 'maximum', 'minimum'].map((k) => [k, FILTERS[k].run(disc, k === 'gaussianBlur' ? { radius: 6 } : {}, env)])], 7);
  const adj = [['original', sc]];
  const av = [
    ['brightnessContrast', { brightness: 60, contrast: 50 }], ['levels', { channels: { rgb: { inBlack: 30, inWhite: 220, gamma: 1.3, outBlack: 0, outWhite: 255 } } }],
    ['curves', { channels: { rgb: [[0, 0], [64, 40], [192, 215], [255, 255]] } }], ['exposure', { exposure: 1 }], ['vibrance', { vibrance: 100 }],
    ['hueSaturation', { hue: 90, saturation: 40 }], ['hueSaturation', { hue: 30, saturation: 40, colorize: true }], ['colorBalance', { midtones: [40, 0, -40] }],
    ['blackWhite', {}], ['blackWhite', { tint: true }], ['photoFilter', { density: 60 }], ['channelMixer', { red: { r: 0, g: 100, b: 0, c: 0 }, green: { r: 100, g: 0, b: 0, c: 0 } }],
    ['invert', {}], ['posterize', {}], ['threshold', {}], ['gradientMap', { stops: [{ pos: 0, color: '#200040' }, { pos: 0.5, color: '#ff4000' }, { pos: 1, color: '#ffff80' }] }],
    ['selectiveColor', { colors: { blues: { c: 100, m: 0, y: -100, k: 0 }, reds: { c: -100, m: 50, y: 100, k: 0 } } }],
  ];
  for (const [t, p] of av) { const d = new Uint8ClampedArray(sc.data); applyAdjustment(d, t, p); adj.push([t, { data: d, width: sc.width, height: sc.height }]); }
  contactSheet('adjust_scene', adj, 6);
  const extras = [['original', sc],
    ['radial zoom', FILTERS.radialBlur.run(sc, { method: 'zoom', amount: 40 }, env)], ['polarToRect', FILTERS.polarCoordinates.run(sc, { mode: 'polarToRect' }, env)],
    ['wave square', FILTERS.wave.run(sc, { type: 'square' }, env)], ['usm 300', FILTERS.unsharpMask.run(sc, { amount: 300, radius: 2 }, env)],
    ['highPass 3', FILTERS.highPass.run(sc, { radius: 3 }, env)], ['S/H hi', FILTERS.shadowsHighlights.run(sc, { shadows: 80, highlights: 80, radius: 30 }, env)],
    ['fibers', FILTERS.fibers.run(sc, {}, env)], ['halftone 4', FILTERS.colorHalftone.run(sc, { maxRadius: 4 }, env)], ['emboss', FILTERS.emboss.run(sc, { amount: 300 }, env)]];
  contactSheet('filters_extra', extras, 5);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
