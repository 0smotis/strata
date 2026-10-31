// Node test for src/js/engine/raw.js (Camera Raw Filter engine)
// Run: node test/engine/raw.test.mjs        (FAST=1 skips the 12 MP timing runs)
import {
  defaultRawSettings, applyCameraRaw, autoRawSettings, autoWhiteBalance, rawHistogram,
  normalizeRawSettings, isDefaultRawSettings, mergeRawSettings, RAW_PRESETS, WB_PRESETS, HSL_COLORS,
} from '../../src/js/engine/raw.js';

let failures = 0, passes = 0;
function check(cond, msg) { if (cond) passes++; else { failures++; console.log('  FAIL:', msg); } }
const section = (t) => console.log('== ' + t);

// ---------------------------------------------------------------- images
function makeImage(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = fn(x, y), o = (y * w + x) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = c.length > 3 ? c[3] : 255;
  }
  return { data, width: w, height: h };
}
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const grayRamp = (w, h) => makeImage(w, h, (x) => { const v = Math.round((x * 255) / (w - 1)); return [v, v, v]; });
const uniform = (w, h, c) => makeImage(w, h, () => c);
const noisy = (w, h, base = 128, amp = 40) => makeImage(w, h, () => [base + (rnd() - 0.5) * amp, base + (rnd() - 0.5) * amp, base + (rnd() - 0.5) * amp]);
// photo-ish scene: sky gradient, sun, ground with texture, red disc, alpha ramp at the bottom-right
const scene = (w, h, alpha = false) => makeImage(w, h, (x, y) => {
  const u = x / w, v = y / h;
  let c;
  if (v < 0.55) { const t = v / 0.55; c = [90 + 120 * t, 150 + 80 * t, 230 + 20 * t]; }
  else { const n = ((Math.sin(x * 0.9) * Math.cos(y * 1.3) + 1) * 0.5) * 50; c = [40 + n, 90 + n, 30 + n * 0.5]; }
  const dsun = Math.hypot(u - 0.75, v - 0.2); if (dsun < 0.06) c = [255, 250, 235];
  const dd = Math.hypot(u - 0.35, v - 0.6); if (dd < 0.12) c = [200, 40, 35];
  if (u < 0.08 && v > 0.8) c = [8, 8, 10];
  const a = alpha ? Math.round(255 * Math.min(1, (1 - u) * 3)) : 255;
  return [c[0], c[1], c[2], a];
});
const lumOf = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
function meanLum(img) { let s = 0; const d = img.data; for (let i = 0; i < d.length; i += 4) s += lumOf(d, i); return s / (d.length / 4); }
function meanChroma(img) { let s = 0; const d = img.data; for (let i = 0; i < d.length; i += 4) s += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); return s / (d.length / 4); }
function meanCh(img, c) { let s = 0; const d = img.data; for (let i = c; i < d.length; i += 4) s += d[i]; return s / (d.length / 4); }
function stdLum(img) { const m = meanLum(img); let s = 0; const d = img.data; for (let i = 0; i < d.length; i += 4) s += (lumOf(d, i) - m) ** 2; return Math.sqrt(s / (d.length / 4)); }
function hiFreq(img) { // mean |L - avg of 4 neighbours|
  const { width: w, height: h, data: d } = img; let s = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4, L = lumOf(d, i);
    const nb = (lumOf(d, i - 4) + lumOf(d, i + 4) + lumOf(d, i - w * 4) + lumOf(d, i + w * 4)) / 4;
    s += Math.abs(L - nb); n++;
  }
  return s / n;
}
const px = (img, x, y) => { const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]; };
const set = (patch) => mergeRawSettings(defaultRawSettings(), patch);
const run = (img, patch, opts) => applyCameraRaw(img, set(patch), opts);
const sameData = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }
function meanDiff(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m += Math.abs(a[i] - b[i]); return m / a.length; }
function alphaSame(a, b) { for (let i = 3; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) return false; return true; }

const S = scene(160, 110), SA = scene(160, 110, true);
const RAMP = grayRamp(256, 4);

// ---------------------------------------------------------------- identity
section('defaults are an exact identity');
{
  const d = defaultRawSettings();
  check(isDefaultRawSettings(d), 'isDefaultRawSettings(defaults)');
  check(JSON.stringify(normalizeRawSettings(d)) === JSON.stringify(d), 'normalize(defaults) == defaults');
  for (const [name, img] of [['scene', S], ['alpha scene', SA], ['noise', noisy(64, 48, 128, 255)], ['ramp', RAMP]]) {
    const o = applyCameraRaw(img, d);
    check(o !== img && o.data !== img.data, name + ': returns a new image');
    check(o.width === img.width && o.height === img.height && sameData(o.data, img.data), name + ': output == input');
  }
  check(sameData(applyCameraRaw(S, {}).data, S.data), 'empty settings object == identity');
  check(sameData(applyCameraRaw(S, null).data, S.data), 'null settings == identity');
  // neutral-but-present values
  check(sameData(run(S, { wb: 'daylight', pointCurve: { rgb: [[0, 0], [128, 128], [255, 255]] }, grading: { shadows: { hue: 200, sat: 0, lum: 0 } } }).data, S.data), 'neutral values (hue w/o sat, identity curve with extra point) == identity');
  // region of defaults
  const rg = applyCameraRaw(S, d, { region: { x: 10, y: 5, width: 30, height: 20 } });
  check(rg.width === 30 && rg.height === 20 && px(rg, 0, 0).join() === px(S, 10, 5).join(), 'identity region crop');
}

// ---------------------------------------------------------------- directions
section('slider directions');
{
  const base = meanLum(S);
  check(meanLum(run(S, { exposure: 1 })) > base + 15, '+exposure brightens');
  check(meanLum(run(S, { exposure: -1 })) < base - 15, '-exposure darkens');
  const e2 = run(RAMP, { exposure: 2 });
  check(px(e2, 255, 0)[0] === 255 && px(e2, 250, 0)[0] < 256, 'exposure keeps white white');
  check(px(run(RAMP, { exposure: 1 }), 64, 0)[0] > 64 * 1.2, '+1 EV lifts a dark gray substantially');
  // highlight shoulder: +exposure must keep some separation among bright values
  const e1 = run(RAMP, { exposure: 1.5 });
  check(px(e1, 200, 0)[0] < px(e1, 240, 0)[0], 'exposure shoulder keeps highlight separation');

  check(stdLum(run(S, { contrast: 60 })) > stdLum(S) * 1.05, '+contrast increases spread');
  check(stdLum(run(S, { contrast: -60 })) < stdLum(S) * 0.95, '-contrast reduces spread');
  const c = run(RAMP, { contrast: 80 });
  check(px(c, 40, 0)[0] < 40 && px(c, 215, 0)[0] > 215, '+contrast: darks down, lights up');

  const hl = run(RAMP, { highlights: -100 });
  const dHi = 230 - px(hl, 230, 0)[0], dLo = 40 - px(hl, 40, 0)[0];
  check(dHi > 10 && dHi > dLo * 3, `highlights -100 lowers bright pixels more than darks (hi ${dHi}, lo ${dLo})`);
  check(px(run(RAMP, { highlights: 100 }), 200, 0)[0] > 200, 'highlights +100 brightens lights');
  const sh = run(RAMP, { shadows: 100 });
  const sLo = px(sh, 50, 0)[0] - 50, sHi = px(sh, 220, 0)[0] - 220;
  check(sLo > 10 && sLo > sHi * 3, `shadows +100 lifts darks more than lights (lo ${sLo}, hi ${sHi})`);
  check(px(run(RAMP, { shadows: -100 }), 60, 0)[0] < 60, 'shadows -100 deepens darks');
  check(px(run(RAMP, { whites: 100 }), 220, 0)[0] > 225, '+whites brightens near-whites');
  check(px(run(RAMP, { whites: -100 }), 250, 0)[0] < 240, '-whites pulls whites down');
  check(px(run(RAMP, { blacks: -100 }), 30, 0)[0] < 25, '-blacks crushes darks');
  check(px(run(RAMP, { blacks: 100 }), 10, 0)[0] > 14, '+blacks lifts darks');
  const bw = run(RAMP, { whites: 100 }), bwPx = px(bw, 30, 0)[0];
  check(Math.abs(bwPx - 30) <= 2, 'whites barely touch darks');

  const G = uniform(16, 16, [128, 128, 128]);
  const warm = px(run(G, { temperature: 50 }), 3, 3), cool = px(run(G, { temperature: -50 }), 3, 3);
  check(warm[0] > warm[2] + 20, 'temp + warms (R > B)');
  check(cool[2] > cool[0] + 20, 'temp - cools (B > R)');
  const mag = px(run(G, { tint: 50 }), 3, 3), grn = px(run(G, { tint: -50 }), 3, 3);
  check(mag[1] < mag[0] && mag[1] < mag[2], 'tint + magenta (G lowest)');
  check(grn[1] > grn[0] && grn[1] > grn[2], 'tint - green (G highest)');
  check(Math.abs(lumOf(run(G, { temperature: 60 }).data, 0) - 128) < 12, 'WB roughly preserves luminance');

  const ch = meanChroma(S);
  check(meanChroma(run(S, { saturation: -100 })) < 1.01, '-100 saturation removes chroma');
  check(meanChroma(run(S, { saturation: -50 })) < ch * 0.7, '-saturation reduces chroma');
  check(meanChroma(run(S, { saturation: 50 })) > ch * 1.2, '+saturation increases chroma');
  const lowSat = uniform(8, 8, [140, 120, 110]), hiSat = uniform(8, 8, [40, 60, 220]);
  const gLow = meanChroma(run(lowSat, { vibrance: 100 })) / meanChroma(lowSat), gHi = meanChroma(run(hiSat, { vibrance: 100 })) / meanChroma(hiSat);
  check(gLow > 1.2 && gLow > gHi, `+vibrance boosts muted colours more (${gLow.toFixed(2)} vs ${gHi.toFixed(2)})`);
  check(meanChroma(run(S, { vibrance: -100 })) < ch * 0.6, '-vibrance desaturates');

  const T = noisy(96, 96, 128, 30);
  check(hiFreq(run(T, { texture: 100 })) > hiFreq(T) * 1.2, '+texture increases fine detail');
  check(hiFreq(run(T, { texture: -100 })) < hiFreq(T) * 0.8, '-texture smooths fine detail');
  const blobs = makeImage(200, 140, (x, y) => { const v = 128 + 50 * Math.sin(x / 9) * Math.cos(y / 11); return [v, v, v]; });
  check(stdLum(run(blobs, { clarity: 100 })) > stdLum(blobs) * 1.05, '+clarity increases local contrast');
  check(stdLum(run(blobs, { clarity: -100 })) < stdLum(blobs) * 0.95, '-clarity reduces local contrast');
  const hazy = makeImage(160, 100, (x, y) => { const v = 150 + 40 * Math.sin(x / 7) * Math.sin(y / 9); return [v * 0.9 + 25, v * 0.9 + 25, v * 0.9 + 30]; });
  check(stdLum(run(hazy, { dehaze: 80 })) > stdLum(hazy) * 1.15, '+dehaze increases contrast of a hazy image');
  check(stdLum(run(hazy, { dehaze: -80 })) < stdLum(hazy) * 0.9, '-dehaze adds haze');

  check(px(run(RAMP, { parametric: { highlights: 100 } }), 225, 0)[0] > 228, 'parametric highlights + raises highlights');
  check(px(run(RAMP, { parametric: { shadows: -100 } }), 35, 0)[0] < 33, 'parametric shadows - lowers shadows');
  check(px(run(RAMP, { parametric: { darks: 100 } }), 95, 0)[0] > 100, 'parametric darks + raises darks');
  check(px(run(RAMP, { parametric: { lights: -100 } }), 160, 0)[0] < 155, 'parametric lights - lowers lights');
  const pc = run(RAMP, { pointCurve: { rgb: [[0, 0], [128, 170], [255, 255]] } });
  check(px(pc, 128, 0)[0] >= 168 && px(pc, 128, 0)[0] <= 172, 'point curve RGB maps 128 -> ~170');
  const pr = px(run(RAMP, { pointCurve: { red: [[0, 0], [128, 90], [255, 255]] } }), 128, 0);
  check(pr[0] < 100 && pr[1] === 128 && pr[2] === 128, 'red point curve affects red only');

  const HS = makeImage(64, 8, (x) => (x < 32 ? [40, 80, 220] : [220, 40, 40]));
  const blueDesat = run(HS, { hsl: { saturation: [0, 0, 0, 0, 0, -100, 0, 0] } });
  const pb = px(blueDesat, 5, 3), prd = px(blueDesat, 50, 3);
  check(Math.max(...pb.slice(0, 3)) - Math.min(...pb.slice(0, 3)) < 45, 'HSL blue saturation -100 desaturates blue');
  check(prd.slice(0, 3).join() === '220,40,40', 'HSL blue leaves red unchanged');
  const redHue = px(run(HS, { hsl: { hue: [100, 0, 0, 0, 0, 0, 0, 0] } }), 50, 3);
  check(redHue[1] > 70 && redHue[2] < 60, 'HSL red hue + shifts red toward orange');
  const blueDark = px(run(HS, { hsl: { luminance: [0, 0, 0, 0, 0, -100, 0, 0] } }), 5, 3);
  check(lumOf(blueDark, 0) < lumOf([40, 80, 220], 0) - 10, 'HSL blue luminance - darkens blue');
  const mid = makeImage(64, 4, (x) => { const h = (x / 64) * 360; const c = [Math.cos(h / 57.3) * 80 + 128, Math.cos((h - 120) / 57.3) * 80 + 128, Math.cos((h - 240) / 57.3) * 80 + 128]; return c; });
  const sm = run(mid, { hsl: { saturation: [0, 0, 100, 0, 0, 0, 0, 0] } });
  let jumps = 0; for (let x = 1; x < 64; x++) { const a = px(sm, x - 1, 1), b = px(sm, x, 1), a0 = px(mid, x - 1, 1), b0 = px(mid, x, 1); for (let c = 0; c < 3; c++) if (Math.abs((b[c] - a[c]) - (b0[c] - a0[c])) > 30) jumps++; }
  check(jumps === 0, 'HSL weighting is smooth across hue (no jumps)');

  const bwImg = run(S, { treatment: 'bw' });
  let gray = true; for (let i = 0; i < bwImg.data.length; i += 4) if (bwImg.data[i] !== bwImg.data[i + 1] || bwImg.data[i] !== bwImg.data[i + 2]) { gray = false; break; }
  check(gray, 'B&W treatment yields neutral pixels');
  const bwBlue = run(HS, { treatment: 'bw', bwMix: [0, 0, 0, 0, 0, -100, 0, 0] }), bwBase = run(HS, { treatment: 'bw' });
  check(px(bwBlue, 5, 3)[0] < px(bwBase, 5, 3)[0] - 10 && px(bwBlue, 50, 3)[0] === px(bwBase, 50, 3)[0], 'B&W mix blue - darkens blues only');

  const grd = run(RAMP, { grading: { shadows: { hue: 240, sat: 100, lum: 0 } } });
  const gs = px(grd, 50, 0), ghi = px(grd, 240, 0);
  check(gs[2] > gs[0] + 8, 'colour grading shadows blue tints darks');
  check(Math.abs(ghi[2] - ghi[0]) < Math.abs(gs[2] - gs[0]) / 2, 'shadow grading barely affects highlights');
  const grh = px(run(RAMP, { grading: { highlights: { hue: 45, sat: 100, lum: 0 } } }), 200, 0);
  check(grh[0] > grh[2] + 8, 'colour grading highlights warm tints lights');
  const glob = px(run(RAMP, { grading: { global: { hue: 120, sat: 80, lum: 0 } } }), 128, 0);
  check(glob[1] > glob[0] && glob[1] > glob[2], 'global grading tints midtones');
  const balT = (b) => { const p = px(run(RAMP, { grading: { highlights: { hue: 45, sat: 100, lum: 0 }, balance: b } }), 128, 0); return p[0] - p[2]; };
  check(balT(100) > balT(-100), 'balance + favours highlight grading');

  const big = uniform(120, 80, [128, 128, 128]);
  const lv = run(big, { optics: { vignette: 100 } });
  check(px(lv, 1, 1)[0] > 150 && Math.abs(px(lv, 60, 40)[0] - 128) <= 1, 'lens vignette + brightens corners only');
  const pcv = run(big, { effects: { vignetteAmount: -100 } });
  check(px(pcv, 1, 1)[0] < 90 && Math.abs(px(pcv, 60, 40)[0] - 128) <= 1, 'post-crop vignette - darkens corners only');
  check(px(run(big, { effects: { vignetteAmount: 100 } }), 1, 1)[0] > 170, 'post-crop vignette + lightens corners');
  for (const style of ['highlight', 'color', 'paint']) check(px(run(big, { effects: { vignetteAmount: -60, vignetteStyle: style } }), 1, 1)[0] < 120, `vignette style ${style} darkens`);
  const rect = px(run(big, { effects: { vignetteAmount: -100, vignetteRoundness: -100, vignetteMidpoint: 80 } }), 60, 2)[0], round = px(run(big, { effects: { vignetteAmount: -100, vignetteRoundness: 100, vignetteMidpoint: 80 } }), 60, 2)[0];
  check(rect !== round, 'roundness changes the vignette shape');
  const gr1 = run(big, { effects: { grainAmount: 60 } }), gr2 = run(big, { effects: { grainAmount: 60 } });
  check(stdLum(gr1) > 2 && sameData(gr1.data, gr2.data), 'grain adds deterministic noise');
  check(stdLum(run(big, { effects: { grainAmount: 60, grainSize: 100 } })) !== stdLum(gr1), 'grain size changes the grain');

  const N = noisy(96, 96, 128, 60);
  check(hiFreq(run(N, { noise: { luminance: 80 } })) < hiFreq(N) * 0.7, 'luminance NR smooths noise');
  check(hiFreq(run(N, { noise: { luminance: 80, lumDetail: 100 } })) > hiFreq(run(N, { noise: { luminance: 80, lumDetail: 0 } })), 'NR detail preserves more');
  const cvar = (img) => { let s = 0; const d = img.data; for (let i = 0; i < d.length; i += 4) { const y = lumOf(d, i); s += (d[i] - y) ** 2 + (d[i + 2] - y) ** 2; } return s; };
  const cn = run(N, { noise: { color: 80 } });
  check(cvar(cn) < cvar(N) * 0.5, 'colour NR reduces chroma noise');
  check(Math.abs(meanLum(cn) - meanLum(N)) < 2, 'colour NR keeps luminance');
  const edge = makeImage(80, 40, (x) => (x < 40 ? [60, 60, 60] : [190, 190, 190]));
  const shp = run(edge, { sharpen: { amount: 120, radius: 1.5, detail: 60 } });
  check(px(shp, 38, 20)[0] < 60 && px(shp, 41, 20)[0] > 190, 'sharpening creates edge contrast');
  check(px(shp, 10, 20)[0] === 60, 'sharpening leaves flat areas');
  const masked = run(noisy(64, 64, 128, 20), { sharpen: { amount: 150, masking: 100 } }), unmasked = run(noisy(64, 64, 128, 20), { sharpen: { amount: 150, masking: 0 } });
  seed = 12345;
  check(hiFreq(masked) <= hiFreq(unmasked), 'sharpen masking limits sharpening of flat noise');
  const mk = applyCameraRaw(edge, set({ sharpen: { amount: 50, masking: 50 } }), { view: 'sharpenMask' });
  check(px(mk, 40, 20)[0] > 200 && px(mk, 5, 20)[0] < 30, 'sharpen mask view: edges white, flat black');

  const fr = makeImage(60, 20, (x) => (x < 28 ? [30, 30, 30] : x < 32 ? [170, 60, 210] : [235, 235, 235]));
  const dfr = run(fr, { optics: { defringePurple: 20 } });
  const fc = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  check(fc(px(dfr, 30, 10)) < fc(px(fr, 30, 10)) * 0.6, 'defringe purple removes purple fringe at edges');
}

// ---------------------------------------------------------------- geometry
section('geometry');
{
  const G = makeImage(120, 80, (x, y) => [x * 2, y * 3, 128]);
  for (const patch of [{ optics: { distortion: 60 } }, { optics: { distortion: -60 } }, { geometry: { vertical: 50 } }, { geometry: { horizontal: -50 } }, { geometry: { rotate: 10 } }, { geometry: { scale: 80 } }, { geometry: { aspect: 50 } }, { geometry: { offsetX: 30, offsetY: -20 } }]) {
    const o = run(G, patch);
    check(o.width === 120 && o.height === 80, 'same size ' + JSON.stringify(patch));
    check(maxDiff(o.data, G.data) > 10, 'changes pixels ' + JSON.stringify(patch));
  }
  const rot = run(G, { geometry: { rotate: 10 } });
  check(px(rot, 0, 0)[3] === 0 && px(rot, 60, 40)[3] === 255, 'rotate: transparent corners, opaque centre');
  check(px(run(G, { geometry: { rotate: 10, fill: 'edge' } }), 0, 0)[3] === 255, 'rotate with edge fill: opaque corners');
  const con = run(G, { geometry: { rotate: 10, constrain: true } });
  check(px(con, 0, 0)[3] === 255 && px(con, 119, 79)[3] === 255, 'constrain crop removes transparent corners');
  check(px(run(G, { geometry: { scale: 70 } }), 2, 2)[3] === 0, 'scale < 100 leaves transparent border');
  const bar = run(G, { optics: { distortion: -60 } }), pin = run(G, { optics: { distortion: 60 } });
  check(px(bar, 0, 0)[3] === 0 && px(pin, 0, 0)[3] === 255, 'barrel (−) leaves empty corners, pincushion (+) fills');
  const v = run(G, { geometry: { vertical: 60 } });
  let topOpaque = 0, botOpaque = 0; for (let x = 0; x < 120; x++) { if (px(v, x, 1)[3] > 0) topOpaque++; if (px(v, x, 78)[3] > 0) botOpaque++; }
  check(topOpaque !== botOpaque, 'vertical perspective is a keystone (top/bottom widths differ)');
  check(px(run(G, { geometry: { scale: 100.0001 } }), 60, 40).slice(0, 3).join() === px(G, 60, 40).slice(0, 3).join(), 'near-identity geometry ~ identity');
}

// ---------------------------------------------------------------- alpha + NaN
section('alpha preserved, no NaN');
{
  const patches = [
    { exposure: 1.3, contrast: 40, highlights: -60, shadows: 50, whites: 20, blacks: -20 },
    { temperature: 40, tint: -20, vibrance: 50, saturation: -20 },
    { texture: 60, clarity: 60, dehaze: 50 },
    { treatment: 'bw', bwMix: [20, 0, 0, -30, 0, -50, 0, 0] },
    { grading: { shadows: { hue: 220, sat: 60, lum: -20 }, highlights: { hue: 40, sat: 50, lum: 10 }, midtones: { hue: 120, sat: 30, lum: 5 }, global: { hue: 300, sat: 10, lum: 0 } } },
    { sharpen: { amount: 100, masking: 30 }, noise: { luminance: 40, color: 40 } },
    { effects: { grainAmount: 40, vignetteAmount: -50 } },
    { optics: { vignette: 50, defringePurple: 10 } },
    { parametric: { highlights: 50, shadows: -40, lights: 20, darks: -10 } },
  ];
  for (const p of patches) check(alphaSame(run(SA, p), SA), 'alpha preserved ' + Object.keys(p).join(','));
  // NaN would become 0 in a Uint8ClampedArray: a bright image should never produce zero channels here
  const bright = noisy(64, 48, 170, 60);
  const extreme = { exposure: 5, contrast: 100, highlights: 100, shadows: 100, whites: 100, blacks: 100, texture: 100, clarity: 100, dehaze: -100, vibrance: 100, saturation: -100, temperature: 100, tint: 100 };
  const ex = run(bright, extreme);
  let zeros = 0; for (let i = 0; i < ex.data.length; i += 4) if (ex.data[i] === 0 && ex.data[i + 1] === 0 && ex.data[i + 2] === 0) zeros++;
  check(zeros === 0, 'extreme settings: no NaN/zero pixels on a bright image');
  const black = uniform(32, 32, [0, 0, 0]), white = uniform(32, 32, [255, 255, 255]);
  for (const img of [black, white]) {
    const o = run(img, { exposure: -5, highlights: -100, shadows: 100, dehaze: 100, clarity: -100, texture: -100, grading: { shadows: { hue: 10, sat: 100, lum: 100 } }, sharpen: { amount: 150 }, noise: { luminance: 100, color: 100 } });
    check(o.data.every((v) => Number.isFinite(v)), 'finite on flat image');
  }
  // fuzz
  let fuzzOk = true;
  const keys = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'texture', 'clarity', 'dehaze', 'vibrance', 'saturation', 'temperature', 'tint'];
  for (let t = 0; t < 25; t++) {
    const p = {}; for (const k of keys) if (rnd() < 0.5) p[k] = Math.round((rnd() * 2 - 1) * (k === 'exposure' ? 4 : 100));
    if (rnd() < 0.3) p.treatment = 'bw';
    if (rnd() < 0.3) p.geometry = { rotate: (rnd() - 0.5) * 20, vertical: (rnd() - 0.5) * 100 };
    if (rnd() < 0.3) p.effects = { grainAmount: rnd() * 100, vignetteAmount: (rnd() - 0.5) * 200, vignetteRoundness: (rnd() - 0.5) * 200 };
    const o = run(SA, p);
    if (o.width !== SA.width || o.height !== SA.height) fuzzOk = false;
    if (!p.geometry && !alphaSame(o, SA)) fuzzOk = false;
  }
  check(fuzzOk, 'fuzz: size + alpha invariants hold');
  check(run(S, { exposure: NaN, contrast: 'abc', hsl: { hue: [NaN] } }).data.every((v, i) => v === S.data[i]), 'garbage values are sanitised to defaults');
}

// ---------------------------------------------------------------- region / preview consistency
section('region + preview consistency');
{
  const big = scene(400, 280);
  const p1 = { exposure: 0.4, contrast: 25, saturation: 20, texture: 30, sharpen: { amount: 60 }, noise: { color: 30 }, effects: { grainAmount: 30, vignetteAmount: -40 }, geometry: { rotate: 4 } };
  const full = run(big, p1);
  const R = { x: 150, y: 90, width: 120, height: 80 };
  const reg = applyCameraRaw(big, set(p1), { region: R });
  let md = 0; for (let y = 0; y < R.height; y++) for (let x = 0; x < R.width; x++) { const a = px(reg, x, y), b = px(full, R.x + x, R.y + y); for (let c = 0; c < 4; c++) md = Math.max(md, Math.abs(a[c] - b[c])); }
  check(reg.width === 120 && reg.height === 80 && md <= 1, `region render matches full render (max diff ${md})`);
  const p2 = { highlights: -70, shadows: 60, clarity: 50, dehaze: 30 };
  const full2 = run(big, p2), small = scene(200, 140);
  const reg2 = applyCameraRaw(big, set(p2), { region: R, guide: small });
  let sd = 0, cnt = 0; for (let y = 0; y < R.height; y++) for (let x = 0; x < R.width; x++) { const a = px(reg2, x, y), b = px(full2, R.x + x, R.y + y); for (let c = 0; c < 3; c++) { sd += Math.abs(a[c] - b[c]); cnt++; } }
  check(sd / cnt < 4, `region with downscaled guide ~ full render (mean diff ${(sd / cnt).toFixed(2)})`);
  // preview (half res) vs full: mean luminance + chroma should agree
  const pv = applyCameraRaw(small, set(p2), { scale: 0.5 });
  check(Math.abs(meanLum(pv) - meanLum(full2)) < 3 && Math.abs(meanChroma(pv) - meanChroma(full2)) < 4, `preview stats match full res (${meanLum(pv).toFixed(1)} vs ${meanLum(full2).toFixed(1)})`);
  let pr = []; applyCameraRaw(small, set(p1), { onProgress: (f) => pr.push(f) });
  check(pr.length >= 3 && pr[pr.length - 1] === 1 && pr.every((v, i) => i === 0 || v >= pr[i - 1]), 'progress is monotonic and ends at 1');
}

// ---------------------------------------------------------------- auto, histogram, presets
section('auto / histogram / presets');
{
  const dark = makeImage(100, 60, (x, y) => { const v = 15 + x * 0.4 + y * 0.3; return [v, v * 0.9, v * 0.8]; });
  const brt = makeImage(100, 60, (x, y) => { const v = 200 + x * 0.5; return [v, v, v * 0.95]; });
  const ad = autoRawSettings(dark), ab = autoRawSettings(brt);
  check(ad.exposure > 0.3, 'auto: dark image -> +exposure (' + ad.exposure + ')');
  check(ab.exposure < 0, 'auto: bright image -> -exposure (' + ab.exposure + ')');
  check(Object.values(ad).every(Number.isFinite) && Object.values(ab).every(Number.isFinite), 'auto values finite');
  check(meanLum(run(dark, ad)) > meanLum(dark) + 20, 'auto brightens a dark image');
  const flat = uniform(40, 40, [128, 128, 128]);
  check(Object.values(autoRawSettings(flat)).every(Number.isFinite), 'auto on flat image is finite');
  const blueish = makeImage(80, 60, (x, y) => { const v = 60 + x + y; return [v * 0.75, v * 0.9, v * 1.2]; });
  const wb = autoWhiteBalance(blueish);
  check(wb.temperature > 10, 'auto WB: bluish image -> warmer temperature (' + wb.temperature + ')');
  const wbFix = run(blueish, wb);
  check(Math.abs(meanCh(wbFix, 0) - meanCh(wbFix, 2)) < Math.abs(meanCh(blueish, 0) - meanCh(blueish, 2)) * 0.5, 'auto WB neutralises the cast');
  const greenish = makeImage(80, 60, (x, y) => { const v = 60 + x + y; return [v * 0.85, v * 1.15, v * 0.85]; });
  check(autoWhiteBalance(greenish).tint > 10, 'auto WB: green cast -> + tint (magenta)');
  check(Object.keys(WB_PRESETS).every((k) => Number.isFinite(WB_PRESETS[k].temperature)), 'WB presets');
  check(px(run(flat, WB_PRESETS.tungsten), 5, 5)[2] > px(run(flat, WB_PRESETS.tungsten), 5, 5)[0], 'tungsten preset cools');

  const hgm = rawHistogram(SA);
  const tot = (a) => a.reduce((s, v) => s + v, 0);
  let vis = 0; for (let i = 3; i < SA.data.length; i += 4) if (SA.data[i]) vis++;
  check(hgm.r instanceof Uint32Array && hgm.l.length === 256 && tot(hgm.r) === vis && tot(hgm.l) === vis, 'histogram counts visible pixels');
  check(rawHistogram(uniform(4, 4, [10, 20, 30])).g[20] === 16, 'histogram bins');

  for (const p of RAW_PRESETS) {
    const st = p.auto ? autoRawSettings(S) : p.settings;
    const o = run(S, st);
    check(o.width === S.width && meanDiff(o.data, S.data) > 0.5, 'preset changes pixels: ' + p.name);
  }
  check(HSL_COLORS.length === 8, '8 HSL colours');
  const merged = mergeRawSettings(defaultRawSettings(), { grading: { shadows: { hue: 10 } } });
  check(merged.grading.shadows.sat === 0 && merged.grading.midtones.hue === 0 && merged.grading.shadows.hue === 10, 'deep merge keeps siblings');
}

// ---------------------------------------------------------------- timing
section('timing');
{
  const typical = { exposure: 0.35, contrast: 15, highlights: -40, shadows: 30, whites: 10, blacks: -8, texture: 10, clarity: 15, vibrance: 20, saturation: 5, temperature: 5, sharpen: { amount: 40 }, noise: { color: 25 } };
  const everything = { ...typical, dehaze: 15, treatment: 'color', hsl: { hue: [5, 0, 0, 10, 0, -5, 0, 0], saturation: [0, 10, 0, -20, 0, 15, 0, 0], luminance: [0, 0, 0, 0, 0, -20, 0, 0] }, grading: { shadows: { hue: 210, sat: 15, lum: 0 }, highlights: { hue: 40, sat: 20, lum: 0 } }, parametric: { highlights: 10, shadows: -10 }, pointCurve: { rgb: [[0, 10], [128, 132], [255, 250]] }, noise: { luminance: 20, color: 25 }, optics: { vignette: 20, distortion: 10, defringePurple: 5 }, geometry: { rotate: 1.5, constrain: true }, effects: { grainAmount: 20, vignetteAmount: -20 } };
  const prev = scene(1340, 895);
  for (const [name, p] of [['typical', typical], ['everything', everything]]) {
    applyCameraRaw(prev, set(p), { scale: 0.335, cache: true }); // warm (JIT + cache, like the dialog's worker)
    let t = performance.now(); applyCameraRaw(prev, set(p), { scale: 0.335 }); const tp = performance.now() - t;
    t = performance.now(); applyCameraRaw(prev, set({ ...p, exposure: 0.5 }), { scale: 0.335, cache: true }); const tc = performance.now() - t;
    console.log(`  preview 1.2 MP ${name}: ${tp.toFixed(0)} ms cold, ${tc.toFixed(0)} ms cached`);
    check(tp < 1500, `1.2 MP preview (${name}) < 1500 ms`);
  }
  if (!process.env.FAST) {
    const big = scene(4000, 3000);
    for (const [name, p, lim] of [['typical', typical, 3500], ['everything', everything, 7000]]) {
      const t = performance.now(); const o = applyCameraRaw(big, set(p)); const ms = performance.now() - t;
      console.log(`  12 MP ${name}: ${ms.toFixed(0)} ms`);
      check(o.width === 4000 && o.height === 3000, '12 MP output size');
      check(ms < lim, `12 MP ${name} < ${lim} ms`);
    }
    const t = performance.now(); applyCameraRaw(big, defaultRawSettings()); console.log(`  12 MP identity: ${(performance.now() - t).toFixed(0)} ms`);
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
