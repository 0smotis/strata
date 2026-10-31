// Tests for src/js/engine/inpaint.js  —  run: node test/engine/inpaint.test.mjs
// Optional: DUMP=1 writes before/after PNGs (needs `npm i --no-save pngjs`) to $DUMP_DIR
// (default: ./inpaint-out next to this file). QUICK=1 skips the large timing cases.
import { inpaint, pushPull, heal, findSourceOffset, spotHeal } from '../../src/js/engine/inpaint.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DUMP = !!process.env.DUMP;
const DUMP_DIR = process.env.DUMP_DIR || path.join(here, 'inpaint-out');
const QUICK = !!process.env.QUICK;

let PNG = null;
if (DUMP) {
  try { ({ PNG } = await import('pngjs')); fs.mkdirSync(DUMP_DIR, { recursive: true }); }
  catch { console.warn('pngjs not installed; skipping PNG dumps'); }
}

// ---------------------------------------------------------------- utilities
let failures = 0, passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log('  ok   ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
}
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function mkImg(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  const px = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    px[3] = 255; fn(x, y, px);
    const i = (y * w + x) * 4;
    data[i] = px[0]; data[i + 1] = px[1]; data[i + 2] = px[2]; data[i + 3] = px[3];
  }
  return { data, width: w, height: h };
}
function circleMask(w, h, cx, cy, rad, soft = 0) {
  const m = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.floor(cx - rad - soft - 1)), x1 = Math.min(w - 1, Math.ceil(cx + rad + soft + 1));
  const y0 = Math.max(0, Math.floor(cy - rad - soft - 1)), y1 = Math.min(h - 1, Math.ceil(cy + rad + soft + 1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (soft > 0) { const a = Math.max(0, Math.min(1, (rad + soft - d) / soft)); if (a > 0) m[y * w + x] = Math.round(a * 255); }
    else if (d <= rad) m[y * w + x] = 255;
  }
  return m;
}
function rectMask(w, h, x0, y0, rw, rh) {
  const m = new Uint8Array(w * h);
  for (let y = Math.max(0, y0); y < Math.min(h, y0 + rh); y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + rw); x++) m[y * w + x] = 255;
  return m;
}
function lineMask(w, h, xa, ya, xb, yb, thick) {
  const m = new Uint8Array(w * h);
  const len = Math.hypot(xb - xa, yb - ya), ux = (xb - xa) / len, uy = (yb - ya) / len;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (x - xa) * ux + (y - ya) * uy;
    if (t < 0 || t > len) continue;
    const dd = Math.abs(-(x - xa) * uy + (y - ya) * ux);
    if (dd <= thick / 2) m[y * w + x] = 255;
  }
  return m;
}
function paintObject(img, mask, color) {
  // put garbage into the hole so leaking it would be detectable
  const d = img.data;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 127) { d[i * 4] = color[0]; d[i * 4 + 1] = color[1]; d[i * 4 + 2] = color[2]; }
}
function outsideUnchanged(orig, res, mask) {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) continue;
    const p = i * 4;
    if (orig[p] !== res[p] || orig[p + 1] !== res[p + 1] || orig[p + 2] !== res[p + 2] || orig[p + 3] !== res[p + 3]) return false;
  }
  return true;
}
function holeStats(truth, res, mask, thr = 127) {
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] <= thr) continue;
    for (let c = 0; c < 3; c++) { const e = Math.abs(truth[i * 4 + c] - res[i * 4 + c]); sum += e; if (e > max) max = e; }
    n++;
  }
  return { mae: sum / Math.max(1, n * 3), max, n };
}
function seamScore(res, mask, w, h, band = 6) {
  // mean abs luminance step across the hole boundary vs. mean step in a thin band just outside it
  // (similar values = no visible seam)
  const L = (i) => 0.299 * res[i * 4] + 0.587 * res[i * 4 + 1] + 0.114 * res[i * 4 + 2];
  const inH = (i) => mask[i] > 127;
  let near = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) near[i] = inH(i) ? 1 : 0;
  for (let k = 0; k < band; k++) {
    const nx = near.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (near[i]) continue;
      if ((x > 0 && near[i - 1]) || (x < w - 1 && near[i + 1]) || (y > 0 && near[i - w]) || (y < h - 1 && near[i + w])) nx[i] = 1;
    }
    near = nx;
  }
  let across = 0, na = 0, ref = 0, nr = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    for (const j of [x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1]) {
      if (j < 0) continue;
      const a = inH(i), b = inH(j);
      if (a !== b) { across += Math.abs(L(i) - L(j)); na++; }
      else if (!a && near[i] && near[j]) { ref += Math.abs(L(i) - L(j)); nr++; }
    }
  }
  return { across: across / Math.max(1, na), ref: ref / Math.max(1, nr) };
}
function dump(name, img, res, mask, w, h) {
  if (!PNG || !DUMP) return;
  const crop = (data) => data;
  const save = (fname, data) => {
    const png = new PNG({ width: w, height: h });
    png.data = Buffer.from(crop(data).buffer, crop(data).byteOffset, w * h * 4);
    fs.writeFileSync(path.join(DUMP_DIR, fname), PNG.sync.write(png));
  };
  if (img) {
    const vis = new Uint8ClampedArray(img);
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const a = mask[i] / 255 * 0.6; vis[i * 4] = vis[i * 4] * (1 - a) + 255 * a; vis[i * 4 + 1] *= 1 - a; vis[i * 4 + 2] = vis[i * 4 + 2] * (1 - a) + 255 * a; }
    save(name + '-before.png', vis);
  }
  save(name + '-after.png', res);
}
function cropImg(img, x0, y0, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y + y0) * img.width + x0) * 4, ((y + y0) * img.width + x0 + w) * 4), y * w * 4);
  return out;
}
function time(fn, reps = 1) {
  const t0 = performance.now();
  let r;
  for (let i = 0; i < reps; i++) r = fn();
  return { r, ms: (performance.now() - t0) / reps };
}

// ---------------------------------------------------------------- test images
const gradient = (w, h) => mkImg(w, h, (x, y, p) => { p[0] = 30 + 180 * x / w; p[1] = 50 + 150 * y / h; p[2] = 100 + 60 * (x + y) / (w + h); });
const stripes = (w, h, period = 12, noise = 0, seed = 7) => {
  const R = rng(seed), th = 0.5;
  return mkImg(w, h, (x, y, p) => {
    const t = Math.sin(2 * Math.PI * (x * Math.cos(th) + y * Math.sin(th)) / period);
    const n = noise ? (R() - 0.5) * noise : 0;
    p[0] = 120 + 70 * t + 30 * x / w + n; p[1] = 100 + 50 * t + 30 * y / h + n; p[2] = 80 + 40 * t + n;
  });
};
function valueNoise(w, h, cell, seed) {
  const R = rng(seed), gw = Math.ceil(w / cell) + 2, gh = Math.ceil(h / cell) + 2;
  const g = new Float32Array(gw * gh).map(() => R());
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
    out[y * w + x] = (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
  }
  return out;
}
function photoLike(w, h, seed = 3) {
  // sky gradient, hills horizon, grass texture, brick wall, a fence post line
  const R = rng(seed);
  const n1 = valueNoise(w, h, 3, seed + 1), n2 = valueNoise(w, h, 17, seed + 2), n3 = valueNoise(w, h, 60, seed + 3);
  return mkImg(w, h, (x, y, p) => {
    const hor = h * 0.38 + 18 * Math.sin(x / w * 5.0) + 8 * Math.sin(x / w * 13.0 + 1);
    const i = y * w + x, j = (R() - 0.5) * 10;
    if (y < hor) {
      const t = y / hor;
      p[0] = 110 + 70 * t + 10 * n3[i]; p[1] = 150 + 50 * t + 10 * n3[i]; p[2] = 230 - 10 * t; // sky
    } else if (x > w * 0.68) {
      // brick wall
      const bh = 14, bwid = 34, row = Math.floor((y - hor) / bh), off = (row & 1) * bwid / 2;
      const mx = ((x + off) % bwid), my = ((y - hor) % bh);
      const mortar = mx < 3 || my < 3;
      const tint = 25 * Math.sin(row * 12.9898 + Math.floor((x + off) / bwid) * 78.233);
      if (mortar) { p[0] = 190 + j; p[1] = 185 + j; p[2] = 175 + j; }
      else { p[0] = 150 + tint + 30 * n1[i] + j; p[1] = 70 + tint * 0.4 + 20 * n1[i] + j; p[2] = 50 + 15 * n1[i] + j; }
    } else {
      const g = 0.55 * n1[i] + 0.3 * n2[i] + 0.15 * n3[i];
      p[0] = 50 + 70 * g + j; p[1] = 90 + 90 * g + j; p[2] = 30 + 40 * g + j; // grass
    }
    // fence post (vertical structure)
    if (Math.abs(x - w * 0.3) < 4 && y > hor - 40) { p[0] = 120 + j; p[1] = 90 + j; p[2] = 60 + j; }
  });
}

// ---------------------------------------------------------------- tests
const T = {};

T.pushPull = () => {
  console.log('pushPull');
  const w = 120, h = 90, c = 3;
  const v = new Float32Array(w * h * c), known = new Uint8Array(w * h), truth = new Float32Array(w * h * c);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    truth[i * 3] = 2 * x + y; truth[i * 3 + 1] = 100 - 0.5 * y; truth[i * 3 + 2] = 0.7 * x - 0.3 * y + 20;
    const inHole = Math.hypot(x - 60, y - 45) < 35 || (x > 100 && y > 60);
    known[i] = inHole ? 0 : 1;
    if (!inHole) for (let k = 0; k < 3; k++) v[i * 3 + k] = truth[i * 3 + k];
  }
  const { r: out, ms } = time(() => pushPull(v, known, w, h, c));
  let maxE = 0, bad = false, lo = Infinity, hi = -Infinity, over = 0;
  for (let i = 0; i < w * h * c; i++) if (known[(i / c) | 0]) { lo = Math.min(lo, v[i]); hi = Math.max(hi, v[i]); }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    const i = (y * w + x) * c + k;
    if (!Number.isFinite(out[i])) bad = true;
    if (x <= 100 || y <= 60) maxE = Math.max(maxE, Math.abs(out[i] - truth[i])); // interior hole: exact harmonic
    else if (out[i] < lo - 1e-3 || out[i] > hi + 1e-3) over++;                   // edge hole (Neumann): bounded
  }
  check(!bad, 'no NaN');
  check(maxE < 0.5, `linear function reproduced in interior hole (max err ${maxE.toFixed(3)}) in ${ms.toFixed(1)} ms`);
  check(over === 0, 'edge-touching hole stays within known range (max principle)');
  const k2 = new Uint8Array(w * h);
  const zero = pushPull(v, k2, w, h, c);
  check(zero.every((x) => x === 0), 'no known pixels -> zeros, no crash');
};

T.gradientFill = () => {
  console.log('inpaint: linear gradient, circle hole');
  const w = 260, h = 200;
  const truth = gradient(w, h), img = gradient(w, h);
  const mask = circleMask(w, h, 130, 100, 45);
  paintObject(img, mask, [255, 0, 255]);
  const orig = new Uint8ClampedArray(img.data);
  const { r: res, ms } = time(() => inpaint(img, mask));
  check(outsideUnchanged(orig, res, mask), 'outside unchanged');
  const st = holeStats(truth.data, res, mask);
  check(st.mae < 2.0 && st.max < 12, `gradient error mae=${st.mae.toFixed(2)} max=${st.max} (${ms.toFixed(0)} ms)`);
  check(img.data.every((v, i) => v === orig[i]), 'input not mutated');
  dump('gradient', img.data, res, mask, w, h);
};

T.stripesFill = () => {
  console.log('inpaint: periodic stripes, rectangle hole');
  const w = 240, h = 200;
  const truth = stripes(w, h, 12), img = stripes(w, h, 12);
  const mask = rectMask(w, h, 90, 70, 60, 50);
  paintObject(img, mask, [0, 255, 0]);
  const orig = new Uint8ClampedArray(img.data);
  const { r: res, ms } = time(() => inpaint(img, mask));
  check(outsideUnchanged(orig, res, mask), 'outside unchanged');
  const st = holeStats(truth.data, res, mask);
  check(st.mae < 6, `stripes error mae=${st.mae.toFixed(2)} max=${st.max} (${ms.toFixed(0)} ms)`);
  dump('stripes', img.data, res, mask, w, h);
  // noisy variant, visual + seam check
  const img2 = stripes(w, h, 12, 30), truth2 = stripes(w, h, 12, 30);
  const m2 = circleMask(w, h, 120, 100, 40);
  paintObject(img2, m2, [0, 255, 0]);
  const r2 = inpaint(img2, m2);
  const st2 = holeStats(truth2.data, r2, m2);
  check(st2.mae < 16, `noisy stripes mae=${st2.mae.toFixed(2)} (noise floor ~10)`);
  dump('stripes-noisy', img2.data, r2, m2, w, h);
};

T.photoLike = () => {
  console.log('inpaint: photo-like scene');
  const w = 480, h = 320;
  const truth = photoLike(w, h);
  const cases = [
    ['photo-circle', circleMask(w, h, 150, 140, 38)],           // over fence post + horizon
    ['photo-rect', rectMask(w, h, 280, 170, 90, 70)],            // grass
    ['photo-brick', rectMask(w, h, 360, 200, 60, 50)],           // brick wall
    ['photo-scratch', lineMask(w, h, 20, 300, 460, 60, 4)],      // thin scratch across everything
    ['photo-edge', circleMask(w, h, 470, 300, 40)],              // touching image corner
    ['photo-soft', circleMask(w, h, 230, 110, 30, 10)],          // soft-edged mask
  ];
  for (const [name, mask] of cases) {
    const img = { data: new Uint8ClampedArray(truth.data), width: w, height: h };
    paintObject(img, mask.map((v) => (v === 255 ? 255 : 0)), [255, 0, 255]);
    const orig = new Uint8ClampedArray(img.data);
    const { r: res, ms } = time(() => inpaint(img, mask, { seed: 1 }));
    const ok = outsideUnchanged(orig, res, mask);
    let magenta = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 200 && res[i * 4] > 240 && res[i * 4 + 1] < 20 && res[i * 4 + 2] > 240) magenta++;
    const st = holeStats(truth.data, res, mask);
    const sc = seamScore(res, mask, w, h);
    check(ok && magenta === 0, `${name}: outside unchanged, no hole colour leaked, mae vs truth ${st.mae.toFixed(1)}, seam ${sc.across.toFixed(1)} vs ref ${sc.ref.toFixed(1)} (${ms.toFixed(0)} ms)`);
    check(sc.across < sc.ref * 1.6 + 3, `${name}: no visible seam`);
    dump(name, img.data, res, mask, w, h);
  }
  // soft mask: blend respected (object only in the fully selected core)
  const mask = circleMask(w, h, 230, 110, 30, 10);
  const img = { data: new Uint8ClampedArray(truth.data), width: w, height: h };
  const res = inpaint(img, mask);
  let dsum = 0, dn = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0 && mask[i] < 64) { for (let c = 0; c < 3; c++) dsum += Math.abs(res[i * 4 + c] - truth.data[i * 4 + c]); dn += 3; }
  check(dsum / dn < 4, `soft mask: low-weight pixels stay close to the original (mae ${(dsum / dn).toFixed(2)})`);
  // sourceMask: only sky may be sampled -> a hole in the grass must be filled with sky colours
  const sm = new Uint8Array(w * h);
  for (let y = 0; y < 70; y++) for (let x = 0; x < w; x++) sm[y * w + x] = 255;
  const m3 = rectMask(w, h, 380, 220, 40, 40);
  const r3 = inpaint(img, m3, { sourceMask: sm, colorAdaptation: 0, boundaryCorrection: false });
  let blue = 0, n = 0;
  for (let i = 0; i < m3.length; i++) if (m3[i]) { n++; if (r3[i * 4 + 2] > r3[i * 4 + 1] && r3[i * 4 + 2] > r3[i * 4]) blue++; }
  check(blue / n > 0.95, `sourceMask respected (${(100 * blue / n).toFixed(0)}% sky-coloured)`);
  dump('photo-sourcemask', null, r3, m3, w, h);
  // progress callback + determinism
  const prog = [];
  const a = inpaint(img, m3, { seed: 5, onProgress: (f) => prog.push(f) });
  const b = inpaint(img, m3, { seed: 5 });
  check(prog.length > 2 && prog.every((v, i) => v >= 0 && v <= 1 && (i === 0 || v >= prog[i - 1])) && prog[prog.length - 1] === 1, `onProgress monotonic 0..1 (${prog.length} calls)`);
  check(a.every((v, i) => v === b[i]), 'deterministic for fixed seed');
  // returnRect / output / alpha
  const rr = inpaint(img, m3, { seed: 5, returnRect: true });
  check(rr.x === 380 && rr.y === 220 && rr.width === 40 && rr.height === 40 && rr.data.length === 40 * 40 * 4, 'returnRect gives the bbox rect');
  const empty = inpaint(img, new Uint8Array(w * h));
  check(empty.every((v, i) => v === img.data[i]), 'empty mask -> unchanged copy');
};

T.alpha = () => {
  console.log('inpaint: transparent pixels');
  const w = 120, h = 100;
  const img = mkImg(w, h, (x, y, p) => { p[0] = 200; p[1] = 100; p[2] = 50; p[3] = 100 + x; });
  const mask = circleMask(w, h, 60, 50, 15);
  const res = inpaint(img, mask);
  const st = { e: 0, n: 0 };
  for (let i = 0; i < mask.length; i++) if (mask[i]) { st.e += Math.abs(res[i * 4 + 3] - img.data[i * 4 + 3]); st.n++; }
  check(st.e / st.n < 4, `alpha channel filled plausibly (mae ${(st.e / st.n).toFixed(2)})`);
};

T.heal = () => {
  console.log('heal');
  const w = 200, h = 160;
  // target: gradient with a dark blemish. source: the cloned texture (a different, brighter part of the
  // gradient plus fine horizontal texture) already placed at the target position.
  const truth = gradient(w, h);
  const target = gradient(w, h);
  const hard = circleMask(w, h, 100, 80, 26);
  for (let i = 0; i < hard.length; i++) if (hard[i]) { target.data[i * 4] = 20; target.data[i * 4 + 1] = 20; target.data[i * 4 + 2] = 20; }
  const shift = 50;
  const source = mkImg(w, h, (x, y, p) => { const xs = Math.min(w - 1, x + shift); p[0] = 30 + 180 * xs / w + 8 * Math.sin(y / 3); p[1] = 50 + 150 * y / h; p[2] = 100 + 60 * (xs + y) / (w + h); });
  const orig = new Uint8ClampedArray(target.data);
  const { r: res, ms } = time(() => heal(target, source, hard));
  check(outsideUnchanged(orig, res, hard), 'outside unchanged');
  // G and B of source differ from the truth only by a smooth (linear) shift -> the membrane removes it exactly
  let e = 0, n = 0, tex = 0;
  for (let i = 0; i < hard.length; i++) {
    if (!hard[i]) continue;
    e += Math.abs(res[i * 4 + 1] - truth.data[i * 4 + 1]) + Math.abs(res[i * 4 + 2] - truth.data[i * 4 + 2]); n++;
  }
  // the R channel keeps the source's texture (sin term) on top of the corrected low frequencies
  for (let y = 70; y < 90; y++) { const i = y * w + 100; tex += Math.abs((res[i * 4] - truth.data[i * 4]) - 8 * Math.sin(y / 3)); }
  check(e / (2 * n) < 1.5, `heal removes the colour/brightness shift (G,B mae ${(e / (2 * n)).toFixed(2)}) in ${ms.toFixed(1)} ms`);
  check(tex / 20 < 3, `heal keeps the source texture (R residual ${(tex / 20).toFixed(2)})`);
  const sc = seamScore(res, hard, w, h);
  check(sc.across < sc.ref * 1.6 + 3, `heal seam ${sc.across.toFixed(2)} vs ref ${sc.ref.toFixed(2)}`);
  dump('heal', target.data, res, hard, w, h);
  // soft mask path
  const soft = circleMask(w, h, 100, 80, 20, 6);
  const r2 = heal(target, source, soft);
  check(outsideUnchanged(orig, r2, soft), 'soft mask: outside unchanged');
  // mask touching the image border (Neumann boundary there)
  const edge = circleMask(w, h, 0, 0, 30);
  const r3 = heal(target, source, edge);
  let e3 = 0, n3 = 0;
  for (let i = 0; i < edge.length; i++) if (edge[i]) { e3 += Math.abs(r3[i * 4 + 1] - truth.data[i * 4 + 1]); n3++; }
  check(outsideUnchanged(orig, r3, edge) && e3 / n3 < 3, `edge-touching mask heals plausibly (G mae ${(e3 / n3).toFixed(2)})`);
  // timing on a 24MP image for a 100 px brush dab
  if (!QUICK) {
    const W = 6000, H = 4000;
    const big = { data: new Uint8ClampedArray(W * H * 4).fill(128), width: W, height: H };
    const bm = circleMask(W, H, 3000, 2000, 50, 6);
    const { ms: t2 } = time(() => heal(big, big, bm, { bbox: { x0: 2943, y0: 1943, x1: 3057, y1: 2057 }, returnRect: true }));
    const { ms: t3 } = time(() => heal(big, big, bm, { returnRect: true }));
    console.log(`  heal 100px dab in 24MP: ${t2.toFixed(1)} ms (bbox given), ${t3.toFixed(1)} ms (bbox scanned)`);
  }
};

T.edgeCases = () => {
  console.log('edge cases');
  // tiny image smaller than a patch -> smooth fill, no crash
  const tiny = mkImg(5, 4, (x, y, p) => { p[0] = 10 * x; p[1] = 10 * y; p[2] = 50; });
  const tm = new Uint8Array(20); tm[6] = 255; tm[7] = 255;
  const tr = inpaint(tiny, tm);
  check(tr.length === 80 && Math.abs(tr[6 * 4] - 10) <= 2 && Math.abs(tr[7 * 4] - 20) <= 2, 'tiny image: harmonic fill');
  check(spotHeal(tiny, tm, { mode: 'proximity' }).length === 80, 'tiny image: proximity falls back');
  // everything masked -> unchanged
  const full = new Uint8Array(20).fill(255);
  check(inpaint(tiny, full).every((v, i) => v === tiny.data[i]), 'fully masked image: unchanged (nothing to sample)');
  // reduced working resolution + full-res transfer path (forced via maxHolePixels), hole at the border
  const w = 400, h = 300;
  const img = stripes(w, h, 14, 20, 3), truth = stripes(w, h, 14, 20, 3);
  const m = circleMask(w, h, 395, 150, 60);
  paintObject(img, m, [255, 0, 255]);
  const orig = new Uint8ClampedArray(img.data);
  const r = inpaint(img, m, { maxHolePixels: 2000 });
  const st = holeStats(truth.data, r, m);
  check(outsideUnchanged(orig, r, m) && st.mae < 20, `reduced-resolution path: outside unchanged, mae ${st.mae.toFixed(1)}`);
  dump('reduced-res', img.data, r, m, w, h);
  // sourceMask with no allowed pixel -> smooth fill, no crash
  const r2 = inpaint(img, m, { sourceMask: new Uint8Array(w * h) });
  check(outsideUnchanged(orig, r2, m), 'empty sourceMask: smooth fallback');
  // output / in-place option
  const copy = new Uint8ClampedArray(orig);
  const r3 = inpaint({ data: copy, width: w, height: h }, m, { output: copy });
  check(r3 === copy && outsideUnchanged(orig, copy, m), 'output: in-place write');
};

T.findSourceOffset = () => {
  console.log('findSourceOffset');
  const w = 300, h = 240;
  // vertical stripes: exact match exists for vertical shifts and horizontal shifts of k*period
  const img = mkImg(w, h, (x, y, p) => { const t = Math.sin(2 * Math.PI * x / 10); p[0] = 128 + 60 * t; p[1] = 100 + 0.3 * y; p[2] = 90; });
  const mask = circleMask(w, h, 150, 120, 14);
  paintObject(img, mask, [255, 0, 0]);
  const { r: off, ms } = time(() => findSourceOffset(img, mask));
  check(Number.isFinite(off.score), 'found an offset');
  const ok = Math.abs(off.dx) % 10 === 0 || Math.abs(off.dx) % 10 === 0;
  const clean = Math.hypot(off.dx, off.dy) >= 2 * 14;
  check(ok && clean, `offset (${off.dx},${off.dy}) is period-aligned and does not overlap the hole (${ms.toFixed(1)} ms)`);
  // corner hole -> shift must stay inside image
  const m2 = circleMask(w, h, 5, 5, 12);
  const o2 = findSourceOffset(img, m2);
  check(Number.isFinite(o2.score) && o2.dx >= 0 && o2.dy >= 0, `corner hole offset stays in image (${o2.dx},${o2.dy})`);
  const tiny = mkImg(10, 10, (x, y, p) => { p[0] = x; });
  const o3 = findSourceOffset(tiny, circleMask(10, 10, 5, 5, 6));
  check(!Number.isFinite(o3.score), 'no room -> score Infinity');
};

T.spotHeal = () => {
  console.log('spotHeal');
  const w = 480, h = 320;
  const truth = photoLike(w, h);
  for (const mode of ['content-aware', 'proximity', 'texture']) {
    for (const [nm, mask] of [['grass', circleMask(w, h, 200, 250, 16, 3)], ['brick', circleMask(w, h, 400, 230, 14, 3)], ['horizon', circleMask(w, h, 100, 125, 14, 3)]]) {
      const img = { data: new Uint8ClampedArray(truth.data), width: w, height: h };
      paintObject(img, mask.map((v) => (v === 255 ? 255 : 0)), [20, 20, 20]);
      const orig = new Uint8ClampedArray(img.data);
      const { r: res, ms } = time(() => spotHeal(img, mask, { mode }));
      const st = holeStats(truth.data, res, mask);
      check(outsideUnchanged(orig, res, mask) && st.mae < 40, `${mode}/${nm}: outside unchanged, mae ${st.mae.toFixed(1)} (${ms.toFixed(1)} ms)`);
      dump(`spot-${mode}-${nm}`, img.data, res, mask, w, h);
    }
  }
  if (!QUICK) {
    // 24MP: 40px spot must be < 100 ms
    const W = 6000, H = 4000;
    const big = photoLike(1200, 800);
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) data.set(big.data.subarray((y % 800) * 1200 * 4, (y % 800 + 1) * 1200 * 4), y * W * 4), data.copyWithin(y * W * 4 + 1200 * 4, y * W * 4, y * W * 4 + 4800 * 4);
    const img = { data, width: W, height: H };
    const mask = circleMask(W, H, 3100, 2100, 20, 3);
    for (const mode of ['content-aware', 'proximity', 'texture']) {
      spotHeal(img, mask, { mode, returnRect: true });
      const a = time(() => spotHeal(img, mask, { mode, returnRect: true }), 3);
      const b = time(() => spotHeal(img, mask, { mode }), 2);
      const c = time(() => spotHeal(img, mask, { mode, output: data, bbox: { x0: 3077, y0: 2077, x1: 3123, y1: 2123 } }), 1);
      check(a.ms < 100, `24MP 40px spot ${mode}: ${a.ms.toFixed(1)} ms (returnRect), ${b.ms.toFixed(1)} ms (full copy), ${c.ms.toFixed(1)} ms (in place + bbox) — target < 100 ms`);
    }
  }
};

T.timing = () => {
  if (QUICK) return;
  console.log('timing: 2000x1500');
  const w = 2000, h = 1500;
  const base = photoLike(1000, 750, 9);
  const img = mkImg(w, h, (x, y, p) => { const i = ((y >> 1) * 1000 + (x >> 1)) * 4; p[0] = base.data[i]; p[1] = base.data[i + 1]; p[2] = base.data[i + 2]; });
  const m200 = rectMask(w, h, 900, 800, 200, 200);
  inpaint(img, rectMask(w, h, 100, 100, 20, 20)); // warm-up JIT
  const a = time(() => inpaint(img, m200));
  check(a.ms < 2000, `200x200 hole: ${a.ms.toFixed(0)} ms (target < 2000)`);
  const m30 = rectMask(w, h, 1200, 1000, 30, 30);
  const b = time(() => inpaint(img, m30), 3);
  check(b.ms < 150, `30x30 hole: ${b.ms.toFixed(1)} ms (target < 150)`);
  const mc = circleMask(w, h, 700, 600, 110);
  const c = time(() => inpaint(img, mc));
  console.log(`  r=110 circle: ${c.ms.toFixed(0)} ms`);
  const mbig = circleMask(w, h, 1000, 750, 420);
  const d = time(() => inpaint(img, mbig));
  console.log(`  r=420 circle (reduced working res + full-res transfer): ${d.ms.toFixed(0)} ms`);
  if (DUMP && PNG) {
    for (const [nm, m, x0, y0, cw, ch] of [['t200', m200, 700, 600, 600, 600], ['tbig', mbig, 480, 230, 1040, 1040]]) {
      const res = inpaint(img, m);
      const ri = { data: res, width: w, height: h };
      const mm = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mm[y * cw + x] = m[(y + y0) * w + x + x0];
      dump(nm, cropImg(img, x0, y0, cw, ch), cropImg(ri, x0, y0, cw, ch), mm, cw, ch);
    }
  }
};

T.worker = async () => {
  console.log('worker module');
  const msgs = [];
  globalThis.self = { postMessage: (m) => msgs.push(m) };
  await import(pathToFileURL(path.join(here, '../../src/js/engine/inpaint.worker.js')).href);
  check(typeof globalThis.self.onmessage === 'function', 'worker installs self.onmessage');
  const w = 64, h = 48;
  const img = stripes(w, h);
  const mask = circleMask(w, h, 32, 24, 6);
  globalThis.self.onmessage({ data: { id: 1, op: 'inpaint', args: { img, mask, opts: { seed: 2 } } } });
  globalThis.self.onmessage({ data: { id: 2, op: 'findSourceOffset', args: { img, mask } } });
  globalThis.self.onmessage({ data: { id: 3, op: 'spotHeal', args: { img, mask, opts: { mode: 'proximity' } } } });
  globalThis.self.onmessage({ data: { id: 4, op: 'heal', args: { target: img, source: img, mask } } });
  globalThis.self.onmessage({ data: { id: 5, op: 'nope', args: {} } });
  const fin = (id) => msgs.find((m) => m.id === id && 'ok' in m);
  check(fin(1)?.ok && fin(1).result.length === w * h * 4, 'inpaint reply');
  check(msgs.some((m) => m.id === 1 && typeof m.progress === 'number'), 'progress messages');
  check(fin(2)?.ok && Number.isFinite(fin(2).result.dx), 'findSourceOffset reply');
  check(fin(3)?.ok && fin(4)?.ok, 'spotHeal / heal replies');
  check(fin(5) && fin(5).ok === false && typeof fin(5).error === 'string', 'error reply for unknown op');
};

const only = process.argv[2];
for (const [name, fn] of Object.entries(T)) {
  if (only && name !== only) continue;
  try { await fn(); } catch (e) { failures++; console.log(`  FAIL ${name} threw: ${e.stack}`); }
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
