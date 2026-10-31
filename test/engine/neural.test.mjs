// Node tests for src/js/ai/neural.js (pure parts + mocked model paths)
// Run: node test/engine/neural.test.mjs
import {
  NEURAL_FILTERS, STACK_ORDER, defaultNeuralParams, runStack, tiledUpscale, runSuperZoom, superZoomPlan,
  labStats, paletteStats, COLOR_PRESETS, skinMask, deblockJpeg, removeScratches, geodesic, resizeImg, resizeBicubic,
  depthFromOutput, fromRaw, changeMask, kuwahara, imgToLab, labToImg, __setPipelineFactory, loadUpscaler, loadDepthEstimator, friendlyModelError,
} from '../../src/js/ai/neural.js';

let failures = 0, passes = 0;
const check = (c, m) => { if (c) passes++; else { failures++; console.log('  FAIL:', m); } };
const make = (w, h, fn) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c.length > 3 ? c[3] : 255; } return { data: d, width: w, height: h }; };
let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
const ctxFor = (img, extra = {}) => ({ scale: 1, region: { x: 0, y: 0, w: img.width, h: img.height }, fullW: img.width, fullH: img.height, seed: 3, ...extra });
const meanRGB = (img, x0 = 0, y0 = 0, w = img.width, h = img.height) => { const m = [0, 0, 0]; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) for (let c = 0; c < 3; c++) m[c] += img.data[(y * img.width + x) * 4 + c]; return m.map(v => v / (w * h)); };
const variance = (img, x0, y0, w, h) => { let s1 = 0, s2 = 0, n = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const v = img.data[(y * img.width + x) * 4 + 1]; s1 += v; s2 += v * v; n++; } return s2 / n - (s1 / n) ** 2; };
const section = (n) => console.log('-', n);

section('Lab round trip');
{
  const img = make(32, 32, (x, y) => [x * 8, y * 8, (x + y) * 4]);
  const [L, A, B] = imgToLab(img), back = labToImg(L, A, B, img);
  let mx = 0; for (let i = 0; i < img.data.length; i++) mx = Math.max(mx, Math.abs(img.data[i] - back.data[i]));
  check(mx <= 2, 'Lab round trip error ' + mx);
}

section('registry');
{
  for (const id of STACK_ORDER) { check(NEURAL_FILTERS[id], 'missing ' + id); check(typeof defaultNeuralParams(id) === 'object', 'defaults ' + id); }
  check(Object.keys(NEURAL_FILTERS).every(k => STACK_ORDER.includes(k)), 'all filters ordered');
}

section('tiledUpscale with a mock nearest-neighbour model (padded output)');
{
  const img = make(300, 170, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
  const nearest = async (t) => { // pads to a multiple of 8 like Swin2SR, then upsamples ×2
    const pw = Math.ceil(t.width / 8) * 8, ph = Math.ceil(t.height / 8) * 8, S = 2;
    const o = make(pw * S, ph * S, (x, y) => { const sx = Math.min(t.width - 1, x >> 1), sy = Math.min(t.height - 1, y >> 1), k = (sy * t.width + sx) * 4; return [t.data[k], t.data[k + 1], t.data[k + 2]]; });
    return o;
  };
  let prog = 0;
  const out = await tiledUpscale(img, 2, nearest, { tile: 128, pad: 16, onProgress: (f) => prog = f });
  check(out.width === 600 && out.height === 340, 'size');
  let bad = 0; for (let y = 0; y < 340; y++) for (let x = 0; x < 600; x++) { const a = (y * 600 + x) * 4, b = ((y >> 1) * 300 + (x >> 1)) * 4; for (let c = 0; c < 3; c++) if (out.data[a + c] !== img.data[b + c]) bad++; }
  check(bad === 0, 'tiles reassembled exactly (bad=' + bad + ')');
  check(prog === 1, 'progress reaches 1');
  // runSuperZoom: jpeg plan uses x4 model then downsizes for x2
  check(superZoomPlan({ scale: 2, jpeg: true }).model === 'jpeg' && superZoomPlan({ scale: 4 }).model === 'sr4' && superZoomPlan({ scale: 2 }).model === 'sr2', 'plan');
  const x4 = async (t) => resizeBicubic(t, t.width * 4, t.height * 4);
  const z = await runSuperZoom(make(40, 30, (x) => [x * 6, 100, 50]), { scale: 2, jpeg: true, enhance: false }, x4);
  check(z.width === 80 && z.height === 60, 'jpeg x2 via x4 model sized ' + z.width + 'x' + z.height);
  const zc = await runSuperZoom(make(40, 30, (x) => [x * 6, 100, 50]), { scale: 4, enhance: true }, null);
  check(zc.width === 160 && zc.height === 120, 'classic fallback size');
}

section('mocked pipeline loaders');
{
  __setPipelineFactory(async (task, id) => {
    if (task === 'image-to-image') return async (raw) => { check(raw.channels === 3 && raw.data.length === raw.width * raw.height * 3, 'raw rgb input'); return { data: new Uint8ClampedArray(raw.width * 2 * raw.height * 2 * 3).fill(99), width: raw.width * 2, height: raw.height * 2, channels: 3 }; };
    if (task === 'depth-estimation') return async (raw) => ({ predicted_depth: { data: Float32Array.from({ length: raw.width * raw.height }, (_, i) => (i % raw.width) / raw.width * 10 + 3), dims: [raw.height, raw.width] }, depth: null });
  });
  const up = await loadUpscaler('sr2');
  const r = await up(make(10, 6, () => [1, 2, 3]));
  check(r.width === 20 && r.height === 12 && r.data[0] === 99 && r.data[3] === 255, 'upscaler output converted');
  const de = await loadDepthEstimator();
  const dm = await de(make(50, 20, () => [0, 0, 0]));
  check(dm.width === 50 && dm.data[0] < 0.05 && dm.data[49] > 0.95, 'depth normalised 0..1');
  __setPipelineFactory(async () => { throw new TypeError('Failed to fetch'); });
  let msg = ''; try { await loadUpscaler('sr4'); } catch (e) { msg = e.message; }
  check(/Could not download the Super Zoom ×4 model/.test(msg), 'friendly download error: ' + msg);
  __setPipelineFactory(null);
  check(/failed to run/.test(friendlyModelError(new Error('bad shape'), 'X').message), 'non-network error');
  const g = fromRaw({ data: new Uint8ClampedArray([10, 20]), width: 2, height: 1, channels: 1 });
  check(g.data[4] === 20 && g.data[6] === 20 && g.data[7] === 255, 'gray raw');
  const d2 = depthFromOutput({ depth: { data: new Uint8ClampedArray([0, 255, 0, 255]), width: 2, height: 2, channels: 1 } }, 4, 4);
  check(d2.data.length === 16, 'depth resized');
}

section('harmonization moves colour toward the reference');
{
  const tgt = make(64, 64, () => [60 + rnd() * 30, 90 + rnd() * 30, 160 + rnd() * 30]); // bluish
  const ref = make(64, 64, () => [200 + rnd() * 30, 140 + rnd() * 20, 60 + rnd() * 20]); // warm
  const refStats = labStats(ref);
  const ctx = ctxFor(tgt, { refStats: () => refStats });
  const { img } = await runStack(tgt, [{ id: 'harmonization', params: { ...defaultNeuralParams('harmonization'), strength: 100 } }], ctx);
  const m0 = meanRGB(tgt), m1 = meanRGB(img);
  check(m1[0] > m0[0] + 30 && m1[2] < m0[2] - 30, 'warmer: ' + m0.map(Math.round) + ' -> ' + m1.map(Math.round));
  const L0 = labStats(tgt).mean[0], L1 = labStats(img).mean[0], Lr = refStats.mean[0];
  check(Math.abs(L1 - L0) < Math.abs(Lr - L0) * 0.6, 'luminance protected');
  const { img: same } = await runStack(tgt, [{ id: 'harmonization', params: { ...defaultNeuralParams('harmonization'), strength: 0 } }], ctx);
  check(Math.abs(meanRGB(same)[0] - m0[0]) < 2, 'strength 0 = no change');
  const { img: red } = await runStack(tgt, [{ id: 'harmonization', params: { ...defaultNeuralParams('harmonization'), strength: 0, cyanRed: 50 } }], ctx);
  check(meanRGB(red)[0] > m0[0] + 20, 'Cyan/Red slider');
}

section('color transfer (preset palette)');
{
  const tgt = make(64, 64, (x, y) => [x * 4, y * 4, 128]);
  const ref = paletteStats(COLOR_PRESETS.goldenHour.colors);
  const p = defaultNeuralParams('colorTransfer');
  const { img } = await runStack(tgt, [{ id: 'colorTransfer', params: p }], ctxFor(tgt, { refStats: () => ref }));
  const st = labStats(img);
  check(Math.abs(st.mean[2] - ref.mean[2]) < Math.abs(labStats(tgt).mean[2] - ref.mean[2]) * 0.3, 'b* mean moved to ref');
  const { img: faded } = await runStack(tgt, [{ id: 'colorTransfer', params: { ...p, fade: 100 } }], ctxFor(tgt, { refStats: () => ref }));
  check(Math.abs(meanRGB(faded)[2] - meanRGB(tgt)[2]) < 2, 'fade 100 = original');
  const { img: pl } = await runStack(tgt, [{ id: 'colorTransfer', params: { ...p, preserveLuminance: true } }], ctxFor(tgt, { refStats: () => ref }));
  check(Math.abs(labStats(pl).mean[0] - labStats(tgt).mean[0]) < 1.5, 'preserve luminance');
}

section('skin smoothing only touches skin');
{
  const img = make(120, 60, (x, y) => x < 60 ? [205 + (rnd() - 0.5) * 50, 150 + (rnd() - 0.5) * 50, 125 + (rnd() - 0.5) * 50] : [60 + (rnd() - 0.5) * 50, 110 + (rnd() - 0.5) * 50, 200 + (rnd() - 0.5) * 50]);
  const m = skinMask(img);
  { let a = 0, b = 0; for (let y = 5; y < 55; y++) for (let x = 5; x < 55; x++) { a += m[y * 120 + x]; b += m[y * 120 + x + 60]; } a /= 2500; b /= 2500; check(a > 0.5 && b < 0.1, 'skin mask ' + a.toFixed(2) + ' / ' + b.toFixed(2)); }
  const { img: out } = await runStack(img, [{ id: 'skinSmoothing', params: { blur: 80, smoothness: 30 } }], ctxFor(img));
  const v0 = variance(img, 10, 10, 30, 40), v1 = variance(out, 10, 10, 30, 40), b0 = variance(img, 80, 10, 30, 40), b1 = variance(out, 80, 10, 30, 40);
  check(v1 < v0 * 0.5, `skin variance reduced ${v0.toFixed(0)} -> ${v1.toFixed(0)}`);
  check(b1 > b0 * 0.9, `non-skin kept ${b0.toFixed(0)} -> ${b1.toFixed(0)}`);
}

section('JPEG deblocking reduces 8×8 block edges');
{
  // blocky image: each 8×8 block flat with slightly different value
  const img = make(64, 64, (x, y) => { const v = 100 + ((x >> 3) * 3 + (y >> 3) * 2) % 12; return [v, v, v]; });
  const edge = (im) => { let s = 0; for (let y = 0; y < 64; y++) for (let x = 8; x < 64; x += 8) s += Math.abs(im.data[(y * 64 + x) * 4] - im.data[(y * 64 + x - 1) * 4]); return s; };
  const out = deblockJpeg(img, 1, 0, 0);
  check(edge(out) < edge(img) * 0.5, `block edges ${edge(img)} -> ${edge(out)}`);
  const { img: viaStack } = await runStack(img, [{ id: 'jpegArtifacts', params: { strength: 'high', useAI: true } }], ctxFor(img, { aiJpeg: async () => null }));
  check(edge(viaStack) < edge(img) * 0.5, 'falls back when AI unavailable');
  const { img: viaAI } = await runStack(img, [{ id: 'jpegArtifacts', params: { strength: 'high', useAI: true } }], ctxFor(img, { aiJpeg: async (im) => make(im.width, im.height, () => [7, 7, 7]) }));
  check(viaAI.data[0] === 7, 'uses AI output when available');
}

section('scratch removal');
{
  const img = make(100, 100, (x, y) => { const base = 120 + Math.sin(x / 9) * 30; const scratch = Math.abs(x - y * 0.7 - 20) < 1 ? 120 : 0; return [base + scratch, base + scratch, base + scratch]; });
  const out = removeScratches(img, 0.8, 1);
  let before = 0, after = 0; for (let y = 10; y < 90; y++) { const x = Math.round(y * 0.7 + 20); before += img.data[(y * 100 + x) * 4]; after += out.data[(y * 100 + x) * 4]; }
  check(after < before - 80 * 60, `scratch brightness ${before / 80 | 0} -> ${after / 80 | 0}`);
  check(Math.abs(out.data[(50 * 100 + 5) * 4] - img.data[(50 * 100 + 5) * 4]) < 4, 'background untouched');
}

section('photo restoration stretches a faded photo');
{
  const img = make(80, 80, (x, y) => { const v = 90 + x * 0.8; return [v + 10, v, v - 10]; });
  const { img: out } = await runStack(img, [{ id: 'photoRestoration', params: { ...defaultNeuralParams('photoRestoration'), enhance: 100, scratch: 0 } }], ctxFor(img));
  const range = (im) => { let lo = 255, hi = 0; for (let i = 0; i < im.data.length; i += 4) { lo = Math.min(lo, im.data[i + 1]); hi = Math.max(hi, im.data[i + 1]); } return hi - lo; };
  check(range(out) > range(img) * 2, `contrast ${range(img)} -> ${range(out)}`);
}

section('colorize: guided points respect edges');
{
  // left dark half, right bright half (strong edge), gray
  const img = make(120, 80, (x) => x < 60 ? [60, 60, 60] : [190, 190, 190]);
  const p = { ...defaultNeuralParams('colorize'), points: [{ x: 0.2, y: 0.5, color: '#ff2020' }, { x: 0.8, y: 0.5, color: '#2040ff' }], artifactReduction: 0 };
  const { img: out } = await runStack(img, [{ id: 'colorize', params: p }], ctxFor(img));
  const L = meanRGB(out, 5, 20, 40, 40), R = meanRGB(out, 75, 20, 40, 40);
  check(L[0] > L[2] + 15, 'left reddish ' + L.map(Math.round));
  check(R[2] > R[0] + 15, 'right bluish ' + R.map(Math.round));
  const near = meanRGB(out, 62, 20, 4, 40);
  check(near[2] > near[0], 'just across the edge stays blue ' + near.map(Math.round));
  const D = geodesic(new Float32Array([0, 0, 0, 100, 100, 100]), 6, 1, [[0, 0]]);
  check(D[2] === 2 && D[3] > 100, 'geodesic edge cost');
  const none = await runStack(img, [{ id: 'colorize', params: defaultNeuralParams('colorize') }], ctxFor(img));
  check(Math.abs(meanRGB(none.img)[0] - meanRGB(img)[0]) < 2, 'no points/profile = unchanged');
  const sep = await runStack(img, [{ id: 'colorize', params: { ...defaultNeuralParams('colorize'), profile: 'sepia', profileStrength: 100 } }], ctxFor(img));
  const sm = meanRGB(sep.img, 75, 20, 40, 40); check(sm[0] > sm[2] + 10, 'sepia profile warm');
  // crop-region consistency: stats from full frame, applied to a crop
  const full = ctxFor(img), statsRun = await runStack(img, [{ id: 'colorize', params: p }], full);
  const crop = { data: img.data.slice(0), width: 120, height: 80 };
  const cctx = { ...full };
  const r2 = await runStack(crop, [{ id: 'colorize', params: p }], cctx, statsRun.stats);
  check(Math.abs(meanRGB(r2.img)[2] - meanRGB(statsRun.img)[2]) < 1, 'precomputed stats reused');
}

section('depth blur: far region blurred, near region sharp');
{
  const w = 160, h = 100;
  const img = make(w, h, (x, y) => { const v = ((x >> 2) + (y >> 2)) % 2 ? 230 : 30; return [v, v, v]; }); // checkerboard
  const depth = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = x < 80 ? 1 : 0; // left near
  const ctx = ctxFor(img, { depth: () => depth });
  const { img: out } = await runStack(img, [{ id: 'depthBlur', params: { ...defaultNeuralParams('depthBlur'), blurStrength: 100 } }], ctx);
  const vn = variance(out, 10, 10, 40, 80), vf = variance(out, 115, 10, 40, 80), v0 = variance(img, 115, 10, 40, 80);
  check(vf < v0 * 0.2, `far blurred ${v0 | 0} -> ${vf | 0}`);
  check(vn > v0 * 0.85, `near sharp ${vn | 0}`);
  const { img: dm } = await runStack(img, [{ id: 'depthBlur', params: { ...defaultNeuralParams('depthBlur'), depthOnly: true } }], ctx);
  check(dm.data[0] === 255 && dm.data[(w - 1) * 4] === 0, 'depth map output');
  const { img: focusFar } = await runStack(img, [{ id: 'depthBlur', params: { ...defaultNeuralParams('depthBlur'), focalDistance: 100, blurStrength: 100 } }], ctx);
  check(variance(focusFar, 115, 10, 40, 80) > v0 * 0.85 && variance(focusFar, 10, 10, 40, 80) < v0 * 0.3, 'focus far blurs near');
  const { img: nod } = await runStack(img, [{ id: 'depthBlur', params: defaultNeuralParams('depthBlur') }], ctxFor(img));
  check(nod.data[0] === img.data[0], 'no depth = passthrough');
  const { img: hz } = await runStack(img, [{ id: 'depthBlur', params: { ...defaultNeuralParams('depthBlur'), blurStrength: 0, haze: 100 } }], ctx);
  check(meanRGB(hz, 115, 10, 40, 80)[0] > meanRGB(img, 115, 10, 40, 80)[0] + 30, 'haze brightens far');
}

section('stack order + misc');
{
  const img = make(40, 40, (x, y) => [x * 6, y * 6, 100]);
  const seen = [];
  const keep = { ...NEURAL_FILTERS };
  for (const id of ['colorTransfer', 'skinSmoothing']) { const F = NEURAL_FILTERS[id], ap = F.apply; F.apply = (im, ...r) => { seen.push(id); return ap(im, ...r); }; }
  await runStack(img, [{ id: 'colorTransfer', params: defaultNeuralParams('colorTransfer') }, { id: 'skinSmoothing', params: defaultNeuralParams('skinSmoothing') }], ctxFor(img, { refStats: () => null }));
  check(seen.join() === 'skinSmoothing,colorTransfer', 'fixed order ' + seen);
  Object.assign(NEURAL_FILTERS, keep);
  const a = make(50, 50, () => [100, 100, 100]), b = make(50, 50, (x) => x > 25 ? [200, 100, 100] : [100, 100, 100]);
  const m = changeMask(a, b); check(m[25 * 50 + 45] > 200 && m[25 * 50 + 3] < 30, 'change mask');
  const r = resizeImg(make(100, 50, () => [10, 20, 30]), 33, 17); check(r.width === 33 && r.data[0] === 10 && r.data[3] === 255, 'area resize');
}

section('style transfer + kuwahara + tiled outScale');
{
  const img = make(96, 64, (x, y) => [x * 2.5 + (rnd() - 0.5) * 40, y * 3, 120 + (rnd() - 0.5) * 40]);
  for (const style of ['painting', 'watercolor', 'comic', 'ink', 'pencil']) {
    const { img: out } = await runStack(img, [{ id: 'styleTransfer', params: { ...defaultNeuralParams('styleTransfer'), style, strength: 100 } }], ctxFor(img));
    let d = 0; for (let i = 0; i < out.data.length; i += 4) d += Math.abs(out.data[i] - img.data[i]);
    check(out.width === 96 && d / (96 * 64) > 3, style + ' changes the image');
  }
  const { img: z } = await runStack(img, [{ id: 'styleTransfer', params: { ...defaultNeuralParams('styleTransfer'), strength: 0 } }], ctxFor(img));
  check(z.data[100] === img.data[100], 'strength 0 = original');
  const [R] = kuwahara(...['r', 'g', 'b'].map((_, c) => Float32Array.from({ length: 96 * 64 }, (__, i) => img.data[i * 4 + c])), 96, 64, 4);
  check(variance({ data: Uint8ClampedArray.from({ length: 96 * 64 * 4 }, (_, i) => i % 4 === 1 ? R[i >> 2] : 0), width: 96, height: 64 }, 10, 10, 70, 40) < variance({ data: img.data.map((v, i) => i % 4 === 1 ? img.data[i - 1] : 0), width: 96, height: 64 }, 10, 10, 70, 40), 'kuwahara flattens');
  const x4 = async (t) => resizeBicubic(t, t.width * 4, t.height * 4);
  const o = await tiledUpscale(img, 4, x4, { tile: 40, pad: 8, outScale: 1 });
  let mx = 0; for (let i = 0; i < o.data.length; i += 4) mx = Math.max(mx, Math.abs(o.data[i + 1] - img.data[i + 1]));
  check(o.width === 96 && o.height === 64 && mx < 40, 'x4 model downsampled per tile (outScale 1), max dev ' + mx);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
