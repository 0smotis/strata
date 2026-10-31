// Strata retouching engine: content-aware fill, healing brush, spot healing.
//
// Pure ES module, no DOM / canvas. Runs in Node and in module Web Workers.
//
// Images: {data: Uint8ClampedArray RGBA (non-premultiplied), width, height}
// Masks:  Uint8Array(width*height). Any value > 0 is treated as "hole" for
//         filling; the value / 255 is used as blend weight when the result is
//         written back, so soft (feathered) edges stay soft.
//
// Algorithms (public literature only):
//  - Wexler, Shechtman, Irani: "Space-Time Completion of Video" (EM / voting)
//  - Barnes et al.: "PatchMatch" (propagation + random search)
//  - Newson et al.: "Video Inpainting of Complex Scenes" (texture features,
//    coarse-to-fine NNF upsampling)
//  - Perez et al.: "Poisson Image Editing" / Georgiev "Covariant derivatives"
//    (healing = source + harmonic membrane of the boundary difference)
//  - Gortler et al. push-pull, plus a multigrid Laplace solve for the membrane.
//  - Darabi et al. "Image Melding" style colour adaptation (per-patch bias).
//
// Exports: inpaint, pushPull, heal, findSourceOffset, spotHeal, maskBBox.
// Common options of the image functions:
//   bbox       {x0,y0,x1,y1} (inclusive) or {x,y,w,h}: skip the full-mask scan (useful on 24MP images)
//   returnRect true -> return {data, x, y, width, height} with only the changed rectangle (no full copy)
//   output     Uint8ClampedArray(w*h*4) that already holds the image (e.g. img.data for in-place);
//              only the changed rectangle is written into it and it is returned
//
// pipeline of inpaint(): crop (hole bbox + context margin, union sourceMask bbox) -> optional
// downscale to a working resolution -> pyramid (RGB[A] + 2 texture-feature channels) -> harmonic init
// of the coarsest hole -> per level: EM iterations of {PatchMatch (bias-adaptive SSD), weighted voting}
// -> NNF upsampling between levels -> final sharp vote -> harmonic boundary correction (Poisson-style
// seam removal) -> (if downscaled) NNF transfer + re-vote with full-res pixels -> soft-mask blend.

// ============================================================================
// small helpers
// ============================================================================

const DEBUG = typeof process !== 'undefined' && process.env && process.env.INPAINT_DEBUG;
const clampI = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampF = (v, b) => (v < -b ? -b : v > b ? b : v);

function seedState(seed) {
  let s = (seed | 0) ^ 0x2545f491;
  if (s === 0) s = 0x1234567;
  for (let i = 0; i < 4; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; }
  return s | 0 || 1;
}

/** Tight bbox of mask > 0. Returns {x0,y0,x1,y1} (inclusive) or null. */
export function maskBBox(mask, w, h, thr = 0) {
  const n = w * h;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  let i = 0;
  if (thr === 0 && (mask.byteOffset & 3) === 0 && n >= 16 && mask.BYTES_PER_ELEMENT === 1) {
    const nw = n >> 2;
    const words = new Uint32Array(mask.buffer, mask.byteOffset, nw);
    // first / last nonzero word give the y range quickly
    let k0 = 0;
    while (k0 < nw && words[k0] === 0) k0++;
    if (k0 === nw) { i = nw << 2; }
    else {
      let k1 = nw - 1;
      while (k1 > k0 && words[k1] === 0) k1--;
      for (let k = k0; k <= k1; k++) {
        if (words[k] === 0) continue;
        const base = k << 2;
        for (let j = 0; j < 4; j++) {
          if (mask[base + j] !== 0) {
            const idx = base + j, y = (idx / w) | 0, x = idx - y * w;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      i = nw << 2;
    }
  }
  for (; i < n; i++) {
    if (mask[i] > thr) {
      const y = (i / w) | 0, x = i - y * w;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x0: minX, y0: minY, x1: maxX, y1: maxY };
}

function normBBox(b, W, H) {
  // accepts {x0,y0,x1,y1} or {x,y,w,h} / {x,y,width,height}
  if (b.x0 !== undefined) return { x0: clampI(b.x0, 0, W - 1), y0: clampI(b.y0, 0, H - 1), x1: clampI(b.x1, 0, W - 1), y1: clampI(b.y1, 0, H - 1) };
  const bw = b.w ?? b.width, bh = b.h ?? b.height;
  return { x0: clampI(b.x, 0, W - 1), y0: clampI(b.y, 0, H - 1), x1: clampI(b.x + bw - 1, 0, W - 1), y1: clampI(b.y + bh - 1, 0, H - 1) };
}

/** Square max filter (Chebyshev dilation) of a 0/1 map. */
function dilate(m, w, h, r) {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let c = 0;
    for (let x = 0; x <= r && x < w; x++) c += m[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = c > 0 ? 1 : 0;
      const a = x + r + 1, b = x - r;
      if (a < w) c += m[row + a];
      if (b >= 0) c -= m[row + b];
    }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y <= r && y < h; y++) c += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = c > 0 ? 1 : 0;
      const a = y + r + 1, b = y - r;
      if (a < h) c += tmp[a * w + x];
      if (b >= 0) c -= tmp[b * w + x];
    }
  }
  return out;
}

/** out=1 iff the whole (2r+1)^2 window is inside the image and all 1. */
function erode(m, w, h, r) {
  const P = 2 * r + 1;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  if (w < P || h < P) return out;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let c = 0;
    for (let x = 0; x < P; x++) c += m[row + x];
    for (let x = r; x < w - r; x++) {
      tmp[row + x] = c === P ? 1 : 0;
      if (x + r + 1 < w) c += m[row + x + r + 1] - m[row + x - r];
    }
  }
  for (let x = r; x < w - r; x++) {
    let c = 0;
    for (let y = 0; y < P; y++) c += tmp[y * w + x];
    for (let y = r; y < h - r; y++) {
      out[y * w + x] = c === P ? 1 : 0;
      if (y + r + 1 < h) c += tmp[(y + r + 1) * w + x] - tmp[(y - r) * w + x];
    }
  }
  return out;
}

/** Chamfer distance from each hole pixel to the nearest non-hole pixel (image border is not a seed). */
function chamfer(hole, w, h) {
  const INF = 1e9, D2 = Math.SQRT2;
  const d = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = hole[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
      if (y > 0) {
        if (d[i - w] + 1 < v) v = d[i - w] + 1;
        if (x > 0 && d[i - w - 1] + D2 < v) v = d[i - w - 1] + D2;
        if (x < w - 1 && d[i - w + 1] + D2 < v) v = d[i - w + 1] + D2;
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
      if (y < h - 1) {
        if (d[i + w] + 1 < v) v = d[i + w] + 1;
        if (x < w - 1 && d[i + w + 1] + D2 < v) v = d[i + w + 1] + D2;
        if (x > 0 && d[i + w - 1] + D2 < v) v = d[i + w - 1] + D2;
      }
      d[i] = v;
    }
  }
  const cap = w + h;
  for (let i = 0; i < w * h; i++) if (d[i] > cap) d[i] = cap;
  return d;
}

/** Separable box sum (radius r), out-of-bounds = 0. */
function boxSum(a, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= r && x < w; x++) s += a[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      if (x + r + 1 < w) s += a[row + x + r + 1];
      if (x - r >= 0) s -= a[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= r && y < h; y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) s -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

// ============================================================================
// Membrane (Laplace) solver: push-pull initial guess + multigrid V-cycles
// ============================================================================
// state: 0 = unknown (solved), 1 = known (Dirichlet, also feeds the guess),
//        2 = inactive (treated as fixed by the solver, value = push-pull guess)

function pushPullGuess(vals, state, w, h, c) {
  const levels = [];
  let lw = w, lh = h;
  let sum = new Float32Array(w * h * c), cnt = new Float32Array(w * h), area = new Float32Array(w * h).fill(1);
  let anyUnknown = false, anyKnown = false;
  for (let i = 0; i < w * h; i++) {
    if (state[i] === 1) {
      cnt[i] = 1; anyKnown = true;
      for (let k = 0; k < c; k++) sum[i * c + k] = vals[i * c + k];
    } else anyUnknown = true;
  }
  const out = new Float32Array(w * h * c);
  if (!anyKnown) return out;
  if (!anyUnknown) { out.set(vals.subarray(0, w * h * c)); return out; }
  levels.push({ w: lw, h: lh, sum, cnt, area });
  for (;;) {
    let full = true;
    for (let i = 0; i < lw * lh; i++) if (cnt[i] === 0) { full = false; break; }
    if (full || (lw === 1 && lh === 1)) break;
    const nw = (lw + 1) >> 1, nh = (lh + 1) >> 1;
    const s2 = new Float32Array(nw * nh * c), c2 = new Float32Array(nw * nh), a2 = new Float32Array(nw * nh);
    for (let y = 0; y < lh; y++) {
      const py = (y >> 1) * nw;
      for (let x = 0; x < lw; x++) {
        const i = y * lw + x, p = py + (x >> 1);
        c2[p] += cnt[i]; a2[p] += area[i];
        if (cnt[i] > 0) for (let k = 0; k < c; k++) s2[p * c + k] += sum[i * c + k];
      }
    }
    lw = nw; lh = nh; sum = s2; cnt = c2; area = a2;
    levels.push({ w: lw, h: lh, sum, cnt, area });
  }
  // pull
  let top = levels[levels.length - 1];
  let v = new Float32Array(top.w * top.h * c);
  {
    // coarsest: average where known; unknown cells (only possible at 1x1 w/o data) -> global mean
    for (let i = 0; i < top.w * top.h; i++) {
      if (top.cnt[i] > 0) for (let k = 0; k < c; k++) v[i * c + k] = top.sum[i * c + k] / top.cnt[i];
    }
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], U = levels[l + 1];
    const nv = new Float32Array(L.w * L.h * c);
    for (let y = 0; y < L.h; y++) {
      let fy = (y - 0.5) * 0.5; let y0 = Math.floor(fy); let ty = fy - y0;
      let y1 = y0 + 1; if (y0 < 0) { y0 = 0; ty = 0; } if (y1 > U.h - 1) y1 = U.h - 1; if (y0 > U.h - 1) y0 = U.h - 1;
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x;
        const a = L.cnt[i] / L.area[i];
        let fx = (x - 0.5) * 0.5; let x0 = Math.floor(fx); let tx = fx - x0;
        let x1 = x0 + 1; if (x0 < 0) { x0 = 0; tx = 0; } if (x1 > U.w - 1) x1 = U.w - 1; if (x0 > U.w - 1) x0 = U.w - 1;
        const i00 = (y0 * U.w + x0) * c, i01 = (y0 * U.w + x1) * c, i10 = (y1 * U.w + x0) * c, i11 = (y1 * U.w + x1) * c;
        for (let k = 0; k < c; k++) {
          const up = (v[i00 + k] * (1 - tx) + v[i01 + k] * tx) * (1 - ty) + (v[i10 + k] * (1 - tx) + v[i11 + k] * tx) * ty;
          nv[i * c + k] = a > 0 ? a * (L.sum[i * c + k] / L.cnt[i]) + (1 - a) * up : up;
        }
      }
    }
    v = nv;
  }
  // exact known values at level 0
  for (let i = 0; i < w * h; i++) if (state[i] === 1) for (let k = 0; k < c; k++) v[i * c + k] = vals[i * c + k];
  return v;
}

function listOf(m, n) {
  let k = 0;
  for (let i = 0; i < n; i++) if (m[i]) k++;
  const out = new Int32Array(k);
  k = 0;
  for (let i = 0; i < n; i++) if (m[i]) out[k++] = i;
  return out;
}

function gsSweep(e, f, list, w, h, c, omega, reverse) {
  const n = list.length;
  for (let t = 0; t < n; t++) {
    const p = list[reverse ? n - 1 - t : t];
    const y = (p / w) | 0, x = p - y * w;
    const hasL = x > 0, hasR = x < w - 1, hasU = y > 0, hasD = y < h - 1;
    const deg = (hasL ? 1 : 0) + (hasR ? 1 : 0) + (hasU ? 1 : 0) + (hasD ? 1 : 0);
    if (deg === 0) continue;
    const inv = 1 / deg, pc = p * c;
    for (let k = 0; k < c; k++) {
      let s = 0;
      if (hasL) s += e[pc - c + k];
      if (hasR) s += e[pc + c + k];
      if (hasU) s += e[pc - w * c + k];
      if (hasD) s += e[pc + w * c + k];
      const v = (s - (f ? f[pc + k] : 0)) * inv;
      e[pc + k] += omega * (v - e[pc + k]);
    }
  }
}

function mgSolve(u, state, w, h, c, maxCycles, tol) {
  const unk0 = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) unk0[i] = state[i] === 0 ? 1 : 0;
  const list0 = listOf(unk0, w * h);
  if (list0.length === 0) return;
  const levels = [{ w, h, unk: unk0, list: list0, e: u, f: null }];
  let lw = w, lh = h, unk = unk0;
  while (lw > 3 && lh > 3 && levels[levels.length - 1].list.length > 64) {
    const nw = (lw + 1) >> 1, nh = (lh + 1) >> 1;
    // coarse cell is unknown only if all its children are unknown: cells straddling the Dirichlet
    // boundary stay fixed (error 0); the fine smoother resolves the boundary layer. Stable on
    // arbitrary domains (the 'any child' rule can diverge near irregular boundaries).
    const u2 = new Uint8Array(nw * nh).fill(1);
    for (let y = 0; y < nh * 2; y++) for (let x = 0; x < nw * 2; x++) {
      const inb = x < lw && y < lh;
      if (inb && !unk[y * lw + x]) u2[(y >> 1) * nw + (x >> 1)] = 0;
    }
    lw = nw; lh = nh; unk = u2;
    levels.push({ w: lw, h: lh, unk, list: listOf(u2, nw * nh), e: new Float32Array(nw * nh * c), f: new Float32Array(nw * nh * c) });
  }
  const nL = levels.length;
  const resid = (L, accumulateInto) => {
    // residual r = f - Lap(e) on unknown pixels; optionally restrict (sum) into next level f
    const { w: W, h: H, list, e, f } = L;
    let maxR = 0;
    const N = accumulateInto;
    for (let t = 0; t < list.length; t++) {
      const p = list[t], y = (p / W) | 0, x = p - y * W, pc = p * c;
      const hasL = x > 0, hasR = x < W - 1, hasU = y > 0, hasD = y < H - 1;
      const deg = (hasL ? 1 : 0) + (hasR ? 1 : 0) + (hasU ? 1 : 0) + (hasD ? 1 : 0);
      const q = N ? ((y >> 1) * N.w + (x >> 1)) * c : 0;
      for (let k = 0; k < c; k++) {
        let s = -deg * e[pc + k];
        if (hasL) s += e[pc - c + k];
        if (hasR) s += e[pc + c + k];
        if (hasU) s += e[pc - W * c + k];
        if (hasD) s += e[pc + W * c + k];
        const r = (f ? f[pc + k] : 0) - s;
        if (N) N.f[q + k] += r;
        const ar = r < 0 ? -r : r;
        if (ar > maxR) maxR = ar;
      }
    }
    return maxR;
  };
  const prolongAdd = (L, N) => {
    const { w: W, list, e } = L;
    for (let t = 0; t < list.length; t++) {
      const p = list[t], y = (p / W) | 0, x = p - y * W, pc = p * c;
      let fy = (y - 0.5) * 0.5, y0 = Math.floor(fy), ty = fy - y0, y1 = y0 + 1;
      if (y0 < 0) { y0 = 0; ty = 0; } if (y1 > N.h - 1) y1 = N.h - 1; if (y0 > N.h - 1) y0 = N.h - 1;
      let fx = (x - 0.5) * 0.5, x0 = Math.floor(fx), tx = fx - x0, x1 = x0 + 1;
      if (x0 < 0) { x0 = 0; tx = 0; } if (x1 > N.w - 1) x1 = N.w - 1; if (x0 > N.w - 1) x0 = N.w - 1;
      const a = (y0 * N.w + x0) * c, b = (y0 * N.w + x1) * c, cc = (y1 * N.w + x0) * c, d = (y1 * N.w + x1) * c;
      for (let k = 0; k < c; k++) {
        e[pc + k] += (N.e[a + k] * (1 - tx) + N.e[b + k] * tx) * (1 - ty) + (N.e[cc + k] * (1 - tx) + N.e[d + k] * tx) * ty;
      }
    }
  };
  const vcycle = (l) => {
    const L = levels[l];
    if (l === nL - 1) {
      const it = Math.min(400, 20 + 4 * Math.max(L.w, L.h));
      for (let s = 0; s < it; s++) gsSweep(L.e, L.f, L.list, L.w, L.h, c, 1.6, s & 1);
      return;
    }
    gsSweep(L.e, L.f, L.list, L.w, L.h, c, 1, 0);
    gsSweep(L.e, L.f, L.list, L.w, L.h, c, 1, 1);
    const N = levels[l + 1];
    N.f.fill(0); N.e.fill(0);
    resid(L, N);
    vcycle(l + 1);
    prolongAdd(L, N);
    gsSweep(L.e, L.f, L.list, L.w, L.h, c, 1, 0);
    gsSweep(L.e, L.f, L.list, L.w, L.h, c, 1, 1);
  };
  for (let cyc = 0; cyc < maxCycles; cyc++) {
    vcycle(0);
    if (nL === 1) break;
    if (tol > 0 && resid(levels[0], null) < tol) break;
  }
}

function membraneSolve(vals, state, w, h, c, opts = {}) {
  const u = pushPullGuess(vals, state, w, h, c);
  let anyKnown = false;
  for (let i = 0; i < w * h; i++) if (state[i] === 1) { anyKnown = true; break; }
  if (!anyKnown) return u;
  mgSolve(u, state, w, h, c, opts.cycles ?? 8, opts.tol ?? 0.02);
  return u;
}

/**
 * Smooth membrane fill of unknown pixels.
 * @param {Float32Array} values  w*h*c interleaved
 * @param {Uint8Array} known     w*h, 1 = known (kept), 0 = unknown (filled)
 * @returns {Float32Array} w*h*c, known pixels unchanged, unknown = harmonic (Laplace) interpolation
 * opts: {cycles=8 multigrid V-cycles (0 = plain push-pull), tol}
 */
export function pushPull(values, known, w, h, c, opts = {}) {
  const state = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) state[i] = known[i] ? 1 : 0;
  if ((opts.cycles ?? 8) === 0) return pushPullGuess(values, state, w, h, c);
  return membraneSolve(values, state, w, h, c, opts);
}

// ============================================================================
// PatchMatch / EM machinery
// ============================================================================

function patchDist(img, w, h, C, r, tx, ty, sx, sy, maxD) {
  const P = 2 * r + 1;
  if (tx >= r && ty >= r && tx < w - r && ty < h - r) {
    const span = P * C, stride = w * C;
    let ti = ((ty - r) * w + tx - r) * C, si = ((sy - r) * w + sx - r) * C;
    let s = 0;
    for (let row = 0; row < P; row++) {
      for (let k = 0; k < span; k++) { const d = img[ti + k] - img[si + k]; s += d * d; }
      if (s >= maxD) return s;
      ti += stride; si += stride;
    }
    return s;
  }
  let s = 0, n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const y = ty + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = tx + dx;
      if (x < 0 || x >= w) continue;
      const ti = (y * w + x) * C, si = ((sy + dy) * w + sx + dx) * C;
      for (let k = 0; k < C; k++) { const d = img[ti + k] - img[si + k]; s += d * d; }
      n++;
    }
  }
  return n ? (s * P * P) / n : 1e30;
}

function makeLevel(w, h, C, img, hole, allow, r, alpha, cfg) {
  const N = w * h;
  const valid = erode(allow, w, h, r);
  const validList = listOf(valid, N);
  const isTarget = dilate(hole, w, h, r);
  const targets = listOf(isTarget, N);
  const tIndex = new Int32Array(N).fill(-1);
  const tBorder = new Uint8Array(targets.length);
  for (let t = 0; t < targets.length; t++) {
    const p = targets[t], y = (p / w) | 0, x = p - y * w;
    tIndex[p] = t;
    tBorder[t] = x < r || y < r || x >= w - r || y >= h - r ? 1 : 0;
  }
  const vm = dilate(hole, w, h, 1);
  const vlist = listOf(vm, N);
  const vidx = new Int32Array(N).fill(-1);
  let vx0 = w, vy0 = h, vx1 = -1, vy1 = -1, nHole = 0;
  for (let k = 0; k < vlist.length; k++) {
    const p = vlist[k];
    vidx[p] = k;
    const y = (p / w) | 0, x = p - y * w;
    if (x < vx0) vx0 = x; if (x > vx1) vx1 = x; if (y < vy0) vy0 = y; if (y > vy1) vy1 = y;
    if (hole[p]) nHole++;
  }
  const dist = chamfer(hole, w, h);
  const conf = new Float32Array(targets.length);
  const la = Math.log(alpha);
  for (let t = 0; t < targets.length; t++) conf[t] = Math.exp(-la * Math.min(dist[targets[t]], 40));
  const CC = cfg.CC, kappa = cfg.kappa, kappaV = cfg.kappaV, maxShift = cfg.maxShift;
  // source patch means (colour channels) - only meaningful at valid source centres (fully known)
  let mS = null;
  if (kappa > 0) {
    mS = new Float32Array(N * CC);
    const ch = new Float32Array(N);
    const inv = 1 / ((2 * r + 1) * (2 * r + 1));
    for (let c = 0; c < CC; c++) {
      for (let i = 0; i < N; i++) ch[i] = img[i * C + c];
      const b = boxSum(ch, w, h, r);
      for (let i = 0; i < N; i++) mS[i * CC + c] = b[i] * inv;
    }
  }
  return {
    w, h, C, CC, r, kappa, kappaV, maxShift, img, hole, tBorder, tmpMean: new Float32Array(4), allow, valid, validList, isTarget, targets, tIndex, vlist, vidx, conf, nHole, dist,
    vbb: { x0: vx0, y0: vy0, x1: vx1, y1: vy1 },
    mS, mT: kappa > 0 ? new Float32Array(targets.length * CC) : null,
    acc: new Float32Array(vlist.length * C), accW: new Float32Array(vlist.length),
  };
}

function downLevel(L, r, alpha, cfg) {
  const { w, h, C, img, hole, allow } = L;
  const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
  const img2 = new Float32Array(cw * ch * C), hole2 = new Uint8Array(cw * ch), allow2 = new Uint8Array(cw * ch);
  const accA = new Float32Array(C), accB = new Float32Array(C);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      accA.fill(0); accB.fill(0);
      let nk = 0, na = 0, anyHole = 0, allAllow = 1;
      for (let dy = 0; dy < 2; dy++) {
        const y = 2 * cy + dy;
        if (y >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = 2 * cx + dx;
          if (x >= w) continue;
          const i = y * w + x;
          na++;
          for (let k = 0; k < C; k++) accB[k] += img[i * C + k];
          if (hole[i]) anyHole = 1;
          else { nk++; for (let k = 0; k < C; k++) accA[k] += img[i * C + k]; }
          if (!allow[i]) allAllow = 0;
        }
      }
      const p = cy * cw + cx;
      for (let k = 0; k < C; k++) img2[p * C + k] = nk ? accA[k] / nk : accB[k] / na;
      hole2[p] = anyHole;
      allow2[p] = allAllow && !anyHole ? 1 : 0;
    }
  }
  return makeLevel(cw, ch, C, img2, hole2, allow2, r, alpha, cfg);
}

/**
 * Fraction of the hole boundary that has a whole source patch available right next to it (a valid
 * source centre within r+1 px). Low values mean the surroundings of the hole are made of strips too
 * narrow to be sampled at this scale, so a coarser level would fill the hole with unrelated content.
 */
function boundaryCoverage(L, r) {
  const { w, h, hole, valid } = L;
  const near = dilate(valid, w, h, r + 1);
  let nb = 0, ok = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!hole[i]) continue;
    const b = (x > 0 && !hole[i - 1]) || (x < w - 1 && !hole[i + 1]) || (y > 0 && !hole[i - w]) || (y < h - 1 && !hole[i + w]);
    if (!b) continue;
    nb++;
    if (near[i]) ok++;
  }
  return nb ? ok / nb : 1;
}

function computeFeatures(img, hole, w, h, C, CC, lambda, fr) {
  const N = w * h;
  const Y = new Float32Array(N), gx = new Float32Array(N), gy = new Float32Array(N), kk = new Float32Array(N);
  for (let i = 0; i < N; i++) Y[i] = 0.299 * img[i * C] + 0.587 * img[i * C + 1] + 0.114 * img[i * C + 2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (hole[i]) continue;
      const l = x > 0 && !hole[i - 1], rr = x < w - 1 && !hole[i + 1];
      const u = y > 0 && !hole[i - w], d = y < h - 1 && !hole[i + w];
      let vx = 0, vy = 0;
      if (l && rr) vx = Math.abs(Y[i + 1] - Y[i - 1]) * 0.5; else if (rr) vx = Math.abs(Y[i + 1] - Y[i]); else if (l) vx = Math.abs(Y[i] - Y[i - 1]);
      if (u && d) vy = Math.abs(Y[i + w] - Y[i - w]) * 0.5; else if (d) vy = Math.abs(Y[i + w] - Y[i]); else if (u) vy = Math.abs(Y[i] - Y[i - w]);
      gx[i] = vx; gy[i] = vy; kk[i] = 1;
    }
  }
  const sx = boxSum(gx, w, h, fr), sy = boxSum(gy, w, h, fr), sk = boxSum(kk, w, h, fr);
  for (let i = 0; i < N; i++) {
    if (hole[i] || sk[i] <= 0) { img[i * C + CC] = 0; img[i * C + CC + 1] = 0; continue; }
    img[i * C + CC] = lambda * sx[i] / sk[i];
    img[i * C + CC + 1] = lambda * sy[i] / sk[i];
  }
}

/** Target patch means (colour channels) from the current image estimate. */
function computeMT(L, r) {
  if (!L.mT) return;
  const { w, h, C, CC, img, targets, mT } = L;
  for (let t = 0; t < targets.length; t++) {
    const p = targets[t], y = (p / w) | 0, x = p - y * w;
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r), x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
    let a = 0, b = 0, c = 0, d = 0;
    for (let yy = y0; yy <= y1; yy++) {
      let i = (yy * w + x0) * C;
      for (let xx = x0; xx <= x1; xx++, i += C) { a += img[i]; b += img[i + 1]; c += img[i + 2]; if (CC === 4) d += img[i + 3]; }
    }
    const inv = 1 / ((y1 - y0 + 1) * (x1 - x0 + 1)), o = t * CC;
    mT[o] = a * inv; mT[o + 1] = b * inv; mT[o + 2] = c * inv; if (CC === 4) mT[o + 3] = d * inv;
  }
}

/** Mean of the source patch at s restricted to the in-image part of target t's patch (border targets). */
function subsetMean(L, t, s) {
  const { w, h, C, CC, img, targets, tmpMean, r } = L;
  const p = targets[t], ty = (p / w) | 0, tx = p - ty * w, sy = (s / w) | 0, sx = s - sy * w;
  const y0 = Math.max(-r, -ty), y1 = Math.min(r, h - 1 - ty), x0 = Math.max(-r, -tx), x1 = Math.min(r, w - 1 - tx);
  for (let c = 0; c < CC; c++) tmpMean[c] = 0;
  for (let dy = y0; dy <= y1; dy++) {
    let i = ((sy + dy) * w + sx + x0) * C;
    for (let dx = x0; dx <= x1; dx++, i += C) for (let c = 0; c < CC; c++) tmpMean[c] += img[i + c];
  }
  const inv = 1 / ((y1 - y0 + 1) * (x1 - x0 + 1));
  for (let c = 0; c < CC; c++) tmpMean[c] *= inv;
}

// Colour adaptation (cf. Image Melding gain/bias, Photoshop "Color Adaptation"): a source patch may be
// shifted by a per-channel bias b = clamp(muT - muS, +-B). The SSD of the shifted patch has the closed
// form SSD - n*g(muT-muS); kappa < 1 keeps a penalty so sources with similar means are preferred.
function biasK(L, t, s, n) {
  const { CC, mT } = L;
  let mS = L.mS, q = s * CC;
  if (L.tBorder[t]) { subsetMean(L, t, s); mS = L.tmpMean; q = 0; }
  const o = t * CC;
  const B = L.maxShift;
  let K = 0;
  for (let c = 0; c < CC; c++) {
    const dm = mT[o + c] - mS[q + c], a = dm < 0 ? -dm : dm;
    K += a <= B ? a * a : 2 * B * a - B * B; // bias clamped to +-B (see vote)
  }
  return K * L.kappa * n;
}

function recomputeD(L, nnfS, nnfD, r) {
  const { w, h, C, img, targets } = L;
  const n = (2 * r + 1) * (2 * r + 1);
  const ad = L.kappa > 0;
  for (let t = 0; t < targets.length; t++) {
    const p = targets[t], s = nnfS[p];
    const ty = (p / w) | 0, tx = p - ty * w, sy = (s / w) | 0, sx = s - sy * w;
    const K = ad ? biasK(L, t, s, n) : 0;
    nnfD[p] = patchDist(img, w, h, C, r, tx, ty, sx, sy, 1e30) - K;
  }
}

function randomInit(L, nnfS, nnfD, r, rs) {
  const { targets, validList } = L;
  const nv = validList.length;
  for (let t = 0; t < targets.length; t++) {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
    nnfS[targets[t]] = validList[((rs >>> 0) % nv)];
  }
  return rs;
}

function patchMatch(L, nnfS, nnfD, r, iters, rs, radFrac) {
  const { w, h, C, img, valid, isTarget, targets } = L;
  const nT = targets.length;
  const maxRad = Math.max(4, Math.round(Math.max(w, h) * radFrac));
  const lo = r, hiX = w - 1 - r, hiY = h - 1 - r;
  const n = (2 * r + 1) * (2 * r + 1);
  const ad = L.kappa > 0;
  for (let it = 0; it < iters; it++) {
    const fwd = (it & 1) === 0, dir = fwd ? 1 : -1;
    for (let k = 0; k < nT; k++) {
      const t = fwd ? k : nT - 1 - k;
      const p = targets[t];
      const y = (p / w) | 0, x = p - y * w;
      let best = nnfS[p], bestD = nnfD[p];
      // propagation (horizontal)
      const nx = x - dir;
      if (nx >= 0 && nx < w) {
        const q = p - dir;
        if (isTarget[q]) {
          const c = nnfS[q] + dir;
          const cy = (c / w) | 0, cx = c - cy * w;
          if (c !== best && cx >= lo && cx <= hiX && cy === ((nnfS[q] / w) | 0) && valid[c]) {
            const K = ad ? biasK(L, t, c, n) : 0;
            const d = patchDist(img, w, h, C, r, x, y, cx, cy, bestD + K) - K;
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      // propagation (vertical)
      const ny = y - dir;
      if (ny >= 0 && ny < h) {
        const q = p - dir * w;
        if (isTarget[q]) {
          const c = nnfS[q] + dir * w;
          const cy = (c / w) | 0, cx = c - cy * w;
          if (c !== best && cy >= lo && cy <= hiY && valid[c]) {
            const K = ad ? biasK(L, t, c, n) : 0;
            const d = patchDist(img, w, h, C, r, x, y, cx, cy, bestD + K) - K;
            if (d < bestD) { bestD = d; best = c; }
          }
        }
      }
      // random search
      let by = (best / w) | 0, bx = best - by * w;
      for (let rad = maxRad; rad >= 1; rad >>= 1) {
        rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
        const u = rs >>> 0;
        let cx = bx + Math.floor(((u & 0xffff) / 32768 - 1) * rad + 0.5);
        let cy = by + Math.floor(((u >>> 16) / 32768 - 1) * rad + 0.5);
        if (cx < lo) cx = lo; else if (cx > hiX) cx = hiX;
        if (cy < lo) cy = lo; else if (cy > hiY) cy = hiY;
        const c = cy * w + cx;
        if (c === best || !valid[c]) continue;
        const K = ad ? biasK(L, t, c, n) : 0;
        const d = patchDist(img, w, h, C, r, x, y, cx, cy, bestD + K) - K;
        if (d < bestD) { bestD = d; best = c; bx = cx; by = cy; }
      }
      nnfS[p] = best; nnfD[p] = bestD;
    }
  }
  return rs;
}

function percentileD(nnfD, targets, q) {
  const n = targets.length;
  if (!n) return 0;
  const m = Math.min(n, 2048);
  const step = n / m;
  const s = new Float32Array(m);
  for (let i = 0; i < m; i++) s[i] = nnfD[targets[Math.floor(i * step)]];
  s.sort();
  return s[Math.min(m - 1, Math.floor(q * m))];
}

/**
 * Weighted voting. Writes hole pixels of L.img; fills L.acc/L.accW for hole+ring pixels.
 * uniform: confidence-only weights (used right after NNF upsampling, when distances are stale)
 */
function vote(L, nnfS, nnfD, r, uniform, sharp) {
  const { w, h, C, CC, img, targets, vidx, vlist, hole, conf, acc, accW, mT, mS, kappa } = L;
  acc.fill(0); accW.fill(0);
  let inv2s = 0;
  if (!uniform) {
    const P2C = (2 * r + 1) * (2 * r + 1) * C;
    // sharp (final pass): a much narrower similarity kernel, so each pixel is dominated by the best
    // few patches covering it instead of averaging many slightly misaligned ones (avoids blur)
    const p = sharp ? Math.max(percentileD(nnfD, targets, 0.25) * sharp, P2C * 0.05) : Math.max(percentileD(nnfD, targets, 0.75), P2C * 0.25);
    inv2s = 1 / (2 * p);
  }
  const ad = kappa > 0 && mT;
  const bias = new Float32Array(C);
  for (let t = 0; t < targets.length; t++) {
    const q = targets[t];
    let wq = conf[t];
    if (!uniform) wq *= Math.exp(-Math.min(30, Math.max(0, nnfD[q]) * inv2s));
    const qy = (q / w) | 0, qx = q - qy * w;
    const s = nnfS[q], sy = (s / w) | 0, sx = s - sy * w;
    if (ad) {
      if (L.tBorder[t]) { subsetMean(L, t, s); for (let c = 0; c < CC; c++) bias[c] = L.kappaV * clampF(mT[t * CC + c] - L.tmpMean[c], L.maxShift); }
      else for (let c = 0; c < CC; c++) bias[c] = L.kappaV * clampF(mT[t * CC + c] - mS[s * CC + c], L.maxShift);
    }
    const y0 = qy - r < 0 ? -qy : -r, y1 = qy + r > h - 1 ? h - 1 - qy : r;
    const x0 = qx - r < 0 ? -qx : -r, x1 = qx + r > w - 1 ? w - 1 - qx : r;
    for (let dy = y0; dy <= y1; dy++) {
      const rowT = (qy + dy) * w + qx, rowS = (sy + dy) * w + sx;
      for (let dx = x0; dx <= x1; dx++) {
        const vi = vidx[rowT + dx];
        if (vi < 0) continue;
        const si = (rowS + dx) * C, ai = vi * C;
        for (let c = 0; c < C; c++) acc[ai + c] += wq * (img[si + c] + bias[c]);
        accW[vi] += wq;
      }
    }
  }
  let change = 0, nh = 0;
  for (let k = 0; k < vlist.length; k++) {
    const p = vlist[k];
    if (!hole[p]) continue;
    const ww = accW[k];
    if (!(ww > 0)) continue;
    const inv = 1 / ww, pi = p * C, ai = k * C;
    for (let c = 0; c < C; c++) {
      const v = acc[ai + c] * inv;
      if (c < CC) change += Math.abs(v - img[pi + c]);
      img[pi + c] = v;
    }
    nh++;
  }
  return change / Math.max(1, nh * CC);
}

/** Initialise fine-level hole pixels by bilinear upsampling of the (filled) coarse level. */
function upsampleImage(Lc, Lf) {
  const { w: wc, h: hc, C } = Lc, ci = Lc.img;
  const { w, img, vlist, hole } = Lf;
  for (let k = 0; k < vlist.length; k++) {
    const p = vlist[k];
    if (!hole[p]) continue;
    const y = (p / w) | 0, x = p - y * w;
    let fy = (y - 0.5) * 0.5, y0 = Math.floor(fy), ty = fy - y0, y1 = y0 + 1;
    if (y0 < 0) { y0 = 0; ty = 0; } if (y1 > hc - 1) y1 = hc - 1; if (y0 > hc - 1) y0 = hc - 1;
    let fx = (x - 0.5) * 0.5, x0 = Math.floor(fx), tx = fx - x0, x1 = x0 + 1;
    if (x0 < 0) { x0 = 0; tx = 0; } if (x1 > wc - 1) x1 = wc - 1; if (x0 > wc - 1) x0 = wc - 1;
    const a = (y0 * wc + x0) * C, b = (y0 * wc + x1) * C, c = (y1 * wc + x0) * C, d = (y1 * wc + x1) * C;
    for (let k2 = 0; k2 < C; k2++) img[p * C + k2] = (ci[a + k2] * (1 - tx) + ci[b + k2] * tx) * (1 - ty) + (ci[c + k2] * (1 - tx) + ci[d + k2] * tx) * ty;
  }
}

function upsampleNNF(Lc, nnfC, Lf, nnfF, r, rs) {
  const wc = Lc.w, hc = Lc.h, wf = Lf.w, hf = Lf.h;
  const { targets, valid, validList } = Lf;
  const lo = r, hiX = wf - 1 - r, hiY = hf - 1 - r;
  const order = [0, 0, -1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1];
  for (let t = 0; t < targets.length; t++) {
    const p = targets[t], y = (p / wf) | 0, x = p - y * wf;
    const cx = Math.min(x >> 1, wc - 1), cy = Math.min(y >> 1, hc - 1);
    let found = -1;
    for (let k = 0; k < order.length && found < 0; k += 2) {
      const qx = cx + order[k], qy = cy + order[k + 1];
      if (qx < 0 || qy < 0 || qx >= wc || qy >= hc) continue;
      const q = qy * wc + qx;
      if (!Lc.isTarget[q]) continue;
      const s = nnfC[q], sy = (s / wc) | 0, sx = s - sy * wc;
      const fx = clampI(x + 2 * (sx - qx), lo, hiX), fy = clampI(y + 2 * (sy - qy), lo, hiY);
      const c = fy * wf + fx;
      if (valid[c]) found = c;
    }
    if (found < 0) {
      rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
      found = validList[(rs >>> 0) % validList.length];
    }
    nnfF[p] = found;
  }
  return rs;
}

/** Add a harmonic correction so that the fill matches the known ring (from the last vote's ring recon). */
function boundaryCorrect(L, CC, maxCorr) {
  const { w, C, img, hole, vlist, acc, accW, vbb } = L;
  if (vbb.x1 < 0) return;
  const lw = vbb.x1 - vbb.x0 + 1, lh = vbb.y1 - vbb.y0 + 1;
  const vals = new Float32Array(lw * lh * CC), state = new Uint8Array(lw * lh).fill(2);
  let any = false;
  for (let k = 0; k < vlist.length; k++) {
    const p = vlist[k], y = (p / w) | 0, x = p - y * w;
    const li = (y - vbb.y0) * lw + (x - vbb.x0);
    if (hole[p]) { state[li] = 0; continue; }
    if (!(accW[k] > 0)) continue;
    state[li] = 1; any = true;
    const inv = 1 / accW[k];
    for (let c = 0; c < CC; c++) vals[li * CC + c] = clampF(img[p * C + c] - acc[k * C + c] * inv, maxCorr);
  }
  if (!any) return;
  const m = membraneSolve(vals, state, lw, lh, CC, { cycles: 3, tol: 0.25 });
  for (let ly = 0; ly < lh; ly++) {
    for (let lx = 0; lx < lw; lx++) {
      const li = ly * lw + lx;
      if (state[li] !== 0) continue;
      const p = (ly + vbb.y0) * w + lx + vbb.x0;
      for (let c = 0; c < CC; c++) img[p * C + c] += m[li * CC + c];
    }
  }
}

// ============================================================================
// inpaint core
// ============================================================================

function holeThickness(mask, W, H, bb) {
  const x0 = Math.max(0, bb.x0 - 1), y0 = Math.max(0, bb.y0 - 1);
  const x1 = Math.min(W - 1, bb.x1 + 1), y1 = Math.min(H - 1, bb.y1 + 1);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const m = new Uint8Array(w * h);
  let count = 0;
  for (let y = 0; y < h; y++) {
    const row = (y + y0) * W + x0;
    for (let x = 0; x < w; x++) if (mask[row + x] > 0) { m[y * w + x] = 1; count++; }
  }
  const d = chamfer(m, w, h);
  let R = 0;
  for (let i = 0; i < w * h; i++) if (d[i] > R) R = d[i];
  return { R, count };
}

/** Full-resolution harmonic fill of the hole from its surroundings (fallback when no patches can be sampled). */
function smoothFillRect(img, mask, bb) {
  const W = img.width, H = img.height, data = img.data;
  const x0 = Math.max(0, bb.x0 - 2), y0 = Math.max(0, bb.y0 - 2), x1 = Math.min(W - 1, bb.x1 + 2), y1 = Math.min(H - 1, bb.y1 + 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w * h > 8e6) return null;
  const vals = new Float32Array(w * h * 4), state = new Uint8Array(w * h);
  let any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const gi = (y + y0) * W + x + x0, li = y * w + x;
    if (mask[gi] === 0) { state[li] = 1; any = true; for (let c = 0; c < 4; c++) vals[li * 4 + c] = data[gi * 4 + c]; }
  }
  if (!any) return null; // nothing known: leave the image unchanged
  const f = membraneSolve(vals, state, w, h, 4, { cycles: 6, tol: 0.1 });
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const gi = (y + bb.y0) * W + x + bb.x0, li = ((y + bb.y0 - y0) * w + x + bb.x0 - x0) * 4, oi = (y * bw + x) * 4;
    const a = mask[gi] / 255;
    for (let c = 0; c < 4; c++) out[oi + c] = data[gi * 4 + c] + (f[li + c] - data[gi * 4 + c]) * a;
  }
  return { x: bb.x0, y: bb.y0, w: bw, h: bh, data: out };
}

/**
 * Returns {x, y, w, h, data: Uint8ClampedArray(w*h*4)} covering the mask bbox, or null if mask empty.
 */
function inpaintCore(img, mask, opts) {
  const W = img.width, H = img.height, data = img.data;
  let P = opts.patchSize ?? 7;
  P = Math.max(3, P | 1);
  const r = P >> 1;
  const alpha = opts.confidenceBase ?? 1.3;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const bb = opts.bbox ? normBBox(opts.bbox, W, H) : maskBBox(mask, W, H);
  if (!bb) return null;
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const { R, count: holeCount } = holeThickness(mask, W, H, bb);
  if (holeCount === 0) return null;

  // ---- crop ----
  const extent = Math.min(Math.max(bw, bh), Math.max(16, 8 * R));
  const margin = Math.round(opts.contextMargin ?? Math.max(48, 1.25 * extent));
  let cx0 = Math.max(0, bb.x0 - margin), cy0 = Math.max(0, bb.y0 - margin);
  let cx1 = Math.min(W - 1, bb.x1 + margin), cy1 = Math.min(H - 1, bb.y1 + margin);
  const sm = opts.sourceMask || null;
  if (sm) {
    const sb = maskBBox(sm, W, H, 127);
    if (sb) { cx0 = Math.min(cx0, sb.x0); cy0 = Math.min(cy0, sb.y0); cx1 = Math.max(cx1, sb.x1); cy1 = Math.max(cy1, sb.y1); }
  }
  const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;

  // ---- alpha channel present? ----
  let hasAlpha = false;
  for (let y = cy0; y <= cy1 && !hasAlpha; y++) {
    let i = (y * W + cx0) * 4 + 3;
    for (let x = cx0; x <= cx1; x++, i += 4) if (data[i] !== 255) { hasAlpha = true; break; }
  }
  const CC = hasAlpha ? 4 : 3;
  const useFeat = opts.textureFeatures !== false;
  const C = CC + (useFeat ? 2 : 0);

  // ---- working scale ----
  const maxWork = opts.maxWorkingPixels ?? 2.5e6;
  const maxHole = opts.maxHolePixels ?? 1.2e5;
  let s = Math.min(1, Math.sqrt(maxWork / (cw * ch)), Math.sqrt(maxHole / holeCount));
  if (s > 0.97) s = 1;
  const ww = s === 1 ? cw : Math.max(P + 2, Math.round(cw * s));
  const wh = s === 1 ? ch : Math.max(P + 2, Math.round(ch * s));
  const N0 = ww * wh;
  const img0 = new Float32Array(N0 * C), hole0 = new Uint8Array(N0), allow0 = new Uint8Array(N0);
  if (s === 1) {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const gi = (y + cy0) * W + x + cx0, li = y * cw + x;
        for (let c = 0; c < CC; c++) img0[li * C + c] = data[gi * 4 + c];
        const ho = mask[gi] > 0;
        hole0[li] = ho ? 1 : 0;
        allow0[li] = !ho && (!sm || sm[gi] > 127) ? 1 : 0;
      }
    }
  } else {
    const acc = new Float64Array(CC), accAll = new Float64Array(CC);
    for (let y = 0; y < wh; y++) {
      const sy0 = Math.floor(y * ch / wh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * ch / wh));
      for (let x = 0; x < ww; x++) {
        const sx0 = Math.floor(x * cw / ww), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * cw / ww));
        acc.fill(0); accAll.fill(0);
        let nk = 0, na = 0, anyHole = 0, allAllow = 1;
        for (let yy = sy0; yy < sy1; yy++) {
          let gi = (yy + cy0) * W + sx0 + cx0;
          for (let xx = sx0; xx < sx1; xx++, gi++) {
            na++;
            const gp = gi * 4;
            if (mask[gi] > 0) { anyHole = 1; allAllow = 0; for (let c = 0; c < CC; c++) accAll[c] += data[gp + c]; }
            else {
              nk++;
              for (let c = 0; c < CC; c++) acc[c] += data[gp + c];
              if (sm && !(sm[gi] > 127)) allAllow = 0;
            }
          }
        }
        const li = y * ww + x;
        for (let c = 0; c < CC; c++) img0[li * C + c] = nk ? acc[c] / nk : accAll[c] / na;
        hole0[li] = anyHole;
        allow0[li] = allAllow;
      }
    }
  }
  if (useFeat) computeFeatures(img0, hole0, ww, wh, C, CC, opts.featureWeight ?? 3, opts.featureRadius ?? 2);

  // ---- pyramid ----
  const kappa = Math.max(0, Math.min(1, opts.colorAdaptation ?? 0.9));
  const cfg = { CC, kappa, kappaV: kappa > 0 ? 1 : 0, maxShift: opts.maxColorShift ?? 40 };
  const levels = [makeLevel(ww, wh, C, img0, hole0, allow0, r, alpha, cfg)];
  const Rw = R * s;
  let nLev = opts.levels ?? Math.max(1, 1 + Math.ceil(Math.log2(Math.max(1, Rw / Math.max(2, r)))));
  while (levels.length < nLev) {
    const prev = levels[levels.length - 1];
    // keep the coarsest level large enough that patches still describe local context (a 7x7 patch on a
    // 16x16 image spans half the scene, and then everything matches the dominant object)
    const minDim = opts.minCoarseSize ?? Math.max(40, 6 * P);
    if (((prev.w + 1) >> 1) < minDim || ((prev.h + 1) >> 1) < minDim) break;
    const nl = downLevel(prev, r, alpha, cfg);
    if (nl.validList.length < 24 || nl.targets.length === 0) break;
    // the hole's immediate surroundings must still be representable by whole source patches at this
    // scale; otherwise (narrow background strips next to the hole) the coarse fill latches onto
    // whatever large object happens to be sampleable there
    const cov = boundaryCoverage(nl, r);
    if (DEBUG) console.log(`candidate level ${nl.w}x${nl.h} boundary coverage ${cov.toFixed(2)}`);
    // ...but never stop while the hole is still much thicker than a patch at the current scale:
    // a thick hole at the coarsest level converges to a smooth blur
    const Rprev = Rw / (1 << (levels.length - 1));
    if (cov < (opts.minBoundaryCoverage ?? 0.85) && Rprev <= 3 * P) break;
    levels.push(nl);
  }
  nLev = levels.length;
  const L0 = levels[0];

  let rs = seedState(opts.seed ?? 12345);

  // ---- no usable source patches (tiny image / everything masked) -> smooth membrane fill only ----
  if (L0.validList.length === 0) return smoothFillRect(img, mask, bb);

  // ---- schedules ----
  const emAt = (l) => {
    if (opts.emIterations != null) return l === nLev - 1 ? Math.max(opts.emIterations, 2 * opts.emIterations) : opts.emIterations;
    if (nLev === 1) return opts.singleScaleIterations ?? 6;
    if (l === nLev - 1) return 10;
    if (l === 0) return 2;
    return l === 1 ? 3 : 5;
  };
  const pmAt = (l) => opts.pmIterations ?? (nLev === 1 ? 2 : l === 0 ? 1 : l === 1 ? 2 : 3);
  let total = 0, done = 0;
  for (let l = 0; l < nLev; l++) total += levels[l].targets.length * emAt(l) * (pmAt(l) + 1);
  const report = () => { if (onProgress) onProgress(Math.min(0.999, done / Math.max(1, total)) * (s < 1 ? 0.85 : 0.97)); };

  // ---- coarsest init ----
  const Lc = levels[nLev - 1];
  // smooth (harmonic) init by default; 'onion' = onion-peel init (can propagate structures further,
  // but also drags whole objects into large holes)
  if (!(nLev > 1 && opts.init === 'onion' && onionPeelFill(Lc, r))) smoothFill(Lc);
  let nnfS = new Int32Array(Lc.w * Lc.h), nnfD = new Float32Array(Lc.w * Lc.h);
  rs = randomInit(Lc, nnfS, nnfD, r, rs);

  for (let l = nLev - 1; l >= 0; l--) {
    const L = levels[l];
    if (l < nLev - 1) {
      const ns = new Int32Array(L.w * L.h);
      rs = upsampleNNF(levels[l + 1], nnfS, L, ns, r, rs);
      nnfS = ns; nnfD = new Float32Array(L.w * L.h);
      upsampleImage(levels[l + 1], L);
      computeMT(L, r);
      vote(L, nnfS, nnfD, r, true, false);
    }
    const em = emAt(l), pm = pmAt(l);
    const _t0 = DEBUG ? performance.now() : 0; let _its = 0;
    for (let it = 0; it < em; it++) {
      _its++;
      computeMT(L, r);
      recomputeD(L, nnfS, nnfD, r);
      // the coarsest level searches globally; finer levels refine an upsampled NNF, so a smaller
      // random-search window suffices (global exploration already happened at coarse scale)
      rs = patchMatch(L, nnfS, nnfD, r, pm, rs, l === nLev - 1 ? 1 : l === 0 ? 0.125 : 0.25);
      const last = l === 0 && (it === em - 1);
      const change = vote(L, nnfS, nnfD, r, false, last ? (opts.finalSharpness ?? 0.15) : 0);
      done += L.targets.length * (pm + 1);
      report();
      if (it >= 1 && change < 0.15) { done += L.targets.length * (pm + 1) * (em - it - 1); break; }
    }
    if (opts._debugLevel) opts._debugLevel(l, L, nnfS);
    if (DEBUG) console.log(`level ${l}: ${L.w}x${L.h} targets ${L.targets.length} valid ${L.validList.length} em ${_its}/${em} pm ${pm} ${(performance.now() - _t0).toFixed(1)} ms`);
  }

  let result;
  if (s < 1) {
    result = fullResStage(img, mask, sm, { x0: cx0, y0: cy0, w: cw, h: ch }, bb, L0, nnfS, nnfD, r, CC, hasAlpha, opts);
  } else {
    if (opts.boundaryCorrection !== false) boundaryCorrect(L0, CC, opts.maxBoundaryCorrection ?? 64);
    result = writeBack(img, mask, bb, L0, cx0, cy0, hasAlpha);
  }
  if (onProgress) onProgress(1);
  return result;
}

/**
 * Onion-peel initialisation of the coarsest level (cf. Newson et al.): fill the hole layer by layer
 * from its boundary inwards; each pixel copies the centre of the best source patch, compared on the
 * already-known pixels only. Candidates: the (shifted) sources of already-filled neighbours, which
 * favours coherent copies that continue structures, plus a sample of all valid sources (exhaustive
 * when cheap). Returns false when it would be too expensive (caller falls back to a smooth fill).
 */
function onionPeelFill(L, r) {
  const { w, h, C, img, hole, valid, validList } = L;
  let nh = 0;
  for (let i = 0; i < w * h; i++) if (hole[i]) nh++;
  const nv = validList.length;
  if (!nh || !nv) return false;
  const S = nh * nv <= 2e6 ? nv : Math.min(nv, 400); // sources tried per pixel
  if (nh * S > 4e6) return false;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
  const srcOf = new Int32Array(w * h).fill(-1);
  const offs = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) offs.push(dx, dy);
  const kx = new Int32Array(offs.length / 2), ky = new Int32Array(offs.length / 2);
  const layer = [];
  let rot = 0;
  for (let guard = 0; guard < w + h; guard++) {
    layer.length = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let adj = false;
      for (let dy = -1; dy <= 1 && !adj; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && known[yy * w + xx]) { adj = true; break; }
      }
      if (adj) layer.push(i);
    }
    if (!layer.length) break;
    const vals = new Float32Array(layer.length * C), srcs = new Int32Array(layer.length);
    for (let k = 0; k < layer.length; k++) {
      const p = layer[k], py = (p / w) | 0, px = p - py * w;
      let nk = 0;
      for (let o = 0; o < offs.length; o += 2) {
        const xx = px + offs[o], yy = py + offs[o + 1];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !known[yy * w + xx]) continue;
        kx[nk] = offs[o]; ky[nk] = offs[o + 1]; nk++;
      }
      let best = -1, bestD = Infinity;
      const tryS = (sc) => {
        const sy = (sc / w) | 0, sx = sc - sy * w;
        let d = 0;
        for (let q = 0; q < nk && d < bestD; q++) {
          const ti = ((py + ky[q]) * w + px + kx[q]) * C, si = ((sy + ky[q]) * w + sx + kx[q]) * C;
          for (let c = 0; c < C; c++) { const e = img[ti + c] - img[si + c]; d += e * e; }
        }
        if (d < bestD) { bestD = d; best = sc; }
      };
      // coherent candidates from already filled neighbours
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = px + dx, yy = py + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const sn = srcOf[yy * w + xx];
        if (sn < 0) continue;
        const sy = ((sn / w) | 0) - dy, sx = sn - ((sn / w) | 0) * w - dx;
        if (sx < r || sy < r || sx >= w - r || sy >= h - r) continue;
        const c = sy * w + sx;
        if (valid[c]) tryS(c);
      }
      if (S === nv) for (let j = 0; j < nv; j++) tryS(validList[j]);
      else {
        const step = nv / S;
        rot = (rot + 7919) % nv;
        for (let j = 0; j < S; j++) tryS(validList[(Math.floor(j * step) + rot) % nv]);
      }
      srcs[k] = best;
      for (let c = 0; c < C; c++) vals[k * C + c] = img[best * C + c];
    }
    for (let k = 0; k < layer.length; k++) {
      const p = layer[k];
      for (let c = 0; c < C; c++) img[p * C + c] = vals[k * C + c];
      known[p] = 1; srcOf[p] = srcs[k];
    }
  }
  return true;
}

function smoothFill(L) {
  const { w, h, C, img, hole } = L;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
  const f = pushPull(img, known, w, h, C, { cycles: 4, tol: 0.1 });
  for (let i = 0; i < w * h; i++) if (hole[i]) for (let c = 0; c < C; c++) img[i * C + c] = f[i * C + c];
}

/** Blend L0 fill (working scale 1) into an RGBA rect over bb. */
function writeBack(img, mask, bb, L0, cx0, cy0, hasAlpha) {
  const W = img.width, data = img.data;
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const out = new Uint8ClampedArray(bw * bh * 4);
  const { w, C, img: f } = L0;
  for (let y = 0; y < bh; y++) {
    const gy = y + bb.y0;
    for (let x = 0; x < bw; x++) {
      const gx = x + bb.x0, gi = gy * W + gx, oi = (y * bw + x) * 4, gp = gi * 4;
      const m = mask[gi];
      if (m === 0) { out[oi] = data[gp]; out[oi + 1] = data[gp + 1]; out[oi + 2] = data[gp + 2]; out[oi + 3] = data[gp + 3]; continue; }
      const a = m / 255;
      const li = ((gy - cy0) * w + (gx - cx0)) * C;
      for (let c = 0; c < 3; c++) out[oi + c] = data[gp + c] + (f[li + c] - data[gp + c]) * a;
      out[oi + 3] = hasAlpha ? data[gp + 3] + (f[li + 3] - data[gp + 3]) * a : data[gp + 3];
    }
  }
  return { x: bb.x0, y: bb.y0, w: bw, h: bh, data: out };
}

/**
 * Working resolution was reduced: transfer the NNF to full resolution and re-vote with
 * full-res source pixels (keeps full-res texture), then boundary-correct at full res.
 */
function fullResStage(img, mask, sm, crop, bb, L0, nnf0, nnfD0, r, CC, hasAlpha, opts) {
  const W = img.width, data = img.data;
  const { x0: cx0, y0: cy0, w: cw, h: ch } = crop;
  const fx = L0.w / cw, fy = L0.h / ch;
  const allow = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    let gi = (y + cy0) * W + cx0, li = y * cw;
    for (let x = 0; x < cw; x++, gi++, li++) allow[li] = mask[gi] === 0 && (!sm || sm[gi] > 127) ? 1 : 0;
  }
  const valid = erode(allow, cw, ch, r);
  // local region (crop coords)
  const gx0 = Math.max(0, bb.x0 - cx0 - r - 1), gy0 = Math.max(0, bb.y0 - cy0 - r - 1);
  const gx1 = Math.min(cw - 1, bb.x1 - cx0 + r + 1), gy1 = Math.min(ch - 1, bb.y1 - cy0 + r + 1);
  const gw = gx1 - gx0 + 1, gh = gy1 - gy0 + 1;
  const holeL = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const row = (y + gy0 + cy0) * W + gx0 + cx0;
    for (let x = 0; x < gw; x++) holeL[y * gw + x] = mask[row + x] > 0 ? 1 : 0;
  }
  const tgt = dilate(holeL, gw, gh, r);
  const vm = dilate(holeL, gw, gh, 1);
  const vidx = new Int32Array(gw * gh).fill(-1);
  const vlist = listOf(vm, gw * gh);
  for (let k = 0; k < vlist.length; k++) vidx[vlist[k]] = k;
  const nV = vlist.length;
  const acc = new Float32Array(nV * CC), accW = new Float32Array(nV);
  const P2C = (2 * r + 1) * (2 * r + 1) * L0.C;
  const p75 = Math.max(percentileD(nnfD0, L0.targets, 0.75), P2C * 0.25);
  const inv2s = 1 / (2 * p75);
  const w0 = L0.w, h0 = L0.h;
  const ad = L0.kappa > 0 && L0.mT;
  if (ad) computeMT(L0, r);
  const bias = new Float32Array(4);
  const nbr = [0, 0, -1, 0, 1, 0, 0, -1, 0, 1, -1, -1, 1, -1, -1, 1, 1, 1, -2, 0, 2, 0, 0, -2, 0, 2];
  for (let ly = 0; ly < gh; ly++) {
    for (let lx = 0; lx < gw; lx++) {
      if (!tgt[ly * gw + lx]) continue;
      const qx = lx + gx0, qy = ly + gy0;
      const wx = Math.min(w0 - 1, Math.floor((qx + 0.5) * fx)), wy = Math.min(h0 - 1, Math.floor((qy + 0.5) * fy));
      let sxF = -1, syF = -1, wgt = 0, ta = -1, sa = 0;
      for (let k = 0; k < nbr.length && sxF < 0; k += 2) {
        const ax = wx + nbr[k], ay = wy + nbr[k + 1];
        if (ax < 0 || ay < 0 || ax >= w0 || ay >= h0) continue;
        const a = ay * w0 + ax;
        if (!L0.isTarget[a]) continue;
        const s0 = nnf0[a], s0y = (s0 / w0) | 0, s0x = s0 - s0y * w0;
        let sx = Math.round(qx + (s0x - ax) / fx), sy = Math.round(qy + (s0y - ay) / fy);
        sx = clampI(sx, r, cw - 1 - r); sy = clampI(sy, r, ch - 1 - r);
        let ok = valid[sy * cw + sx] === 1;
        if (!ok) {
          for (let dd = 1; dd <= 2 && !ok; dd++) {
            for (let oy = -dd; oy <= dd && !ok; oy++) for (let ox = -dd; ox <= dd && !ok; ox++) {
              const tx = sx + ox, ty = sy + oy;
              if (tx < r || ty < r || tx > cw - 1 - r || ty > ch - 1 - r) continue;
              if (valid[ty * cw + tx]) { sx = tx; sy = ty; ok = true; }
            }
          }
        }
        if (ok) { sxF = sx; syF = sy; wgt = Math.exp(-Math.min(30, Math.max(0, nnfD0[a]) * inv2s)); ta = L0.tIndex[a]; sa = s0; }
      }
      if (sxF < 0) continue;
      if (ad) {
        let ms = L0.mS, q = sa * CC;
        if (L0.tBorder[ta]) { subsetMean(L0, ta, sa); ms = L0.tmpMean; q = 0; }
        for (let c = 0; c < CC; c++) bias[c] = L0.kappaV * clampF(L0.mT[ta * CC + c] - ms[q + c], L0.maxShift);
      }
      const y0 = Math.max(-r, -ly), y1 = Math.min(r, gh - 1 - ly), x0 = Math.max(-r, -lx), x1 = Math.min(r, gw - 1 - lx);
      for (let dy = y0; dy <= y1; dy++) {
        const rowL = (ly + dy) * gw + lx;
        const rowS = (syF + dy + cy0) * W + sxF + cx0;
        for (let dx = x0; dx <= x1; dx++) {
          const vi = vidx[rowL + dx];
          if (vi < 0) continue;
          const sp = (rowS + dx) * 4, ai = vi * CC;
          for (let c = 0; c < CC; c++) acc[ai + c] += wgt * (data[sp + c] + bias[c]);
          accW[vi] += wgt;
        }
      }
    }
  }
  // fill buffer over local region
  const fill = new Float32Array(gw * gh * CC);
  const C0 = L0.C, f0 = L0.img;
  for (let k = 0; k < nV; k++) {
    const lp = vlist[k];
    if (!holeL[lp]) continue;
    const ly = (lp / gw) | 0, lx = lp - ly * gw;
    if (accW[k] > 0) {
      const inv = 1 / accW[k];
      for (let c = 0; c < CC; c++) fill[lp * CC + c] = acc[k * CC + c] * inv;
    } else {
      // bilinear from working fill
      const qx = (lx + gx0 + 0.5) * fx - 0.5, qy = (ly + gy0 + 0.5) * fy - 0.5;
      let ax = Math.floor(qx), ay = Math.floor(qy); let tx = qx - ax, ty = qy - ay;
      if (ax < 0) { ax = 0; tx = 0; } if (ay < 0) { ay = 0; ty = 0; }
      const bx = Math.min(w0 - 1, ax + 1), by = Math.min(h0 - 1, ay + 1);
      ax = Math.min(ax, w0 - 1); ay = Math.min(ay, h0 - 1);
      for (let c = 0; c < CC; c++) {
        fill[lp * CC + c] = (f0[(ay * w0 + ax) * C0 + c] * (1 - tx) + f0[(ay * w0 + bx) * C0 + c] * tx) * (1 - ty) +
          (f0[(by * w0 + ax) * C0 + c] * (1 - tx) + f0[(by * w0 + bx) * C0 + c] * tx) * ty;
      }
    }
  }
  // boundary correction at full res
  if (opts.boundaryCorrection !== false) {
    const maxCorr = opts.maxBoundaryCorrection ?? 64;
    const vals = new Float32Array(gw * gh * CC), state = new Uint8Array(gw * gh).fill(2);
    let any = false;
    for (let k = 0; k < nV; k++) {
      const lp = vlist[k];
      if (holeL[lp]) { state[lp] = 0; continue; }
      if (!(accW[k] > 0)) continue;
      const ly = (lp / gw) | 0, lx = lp - ly * gw;
      const gp = ((ly + gy0 + cy0) * W + lx + gx0 + cx0) * 4;
      const inv = 1 / accW[k];
      for (let c = 0; c < CC; c++) vals[lp * CC + c] = clampF(data[gp + c] - acc[k * CC + c] * inv, maxCorr);
      state[lp] = 1; any = true;
    }
    if (any) {
      const m = membraneSolve(vals, state, gw, gh, CC, { cycles: 3, tol: 0.25 });
      for (let i = 0; i < gw * gh; i++) if (state[i] === 0) for (let c = 0; c < CC; c++) fill[i * CC + c] += m[i * CC + c];
    }
  }
  // write rect over bb
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const out = new Uint8ClampedArray(bw * bh * 4);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gxx = x + bb.x0, gyy = y + bb.y0, gi = gyy * W + gxx, gp = gi * 4, oi = (y * bw + x) * 4;
      const m = mask[gi];
      if (m === 0) { out[oi] = data[gp]; out[oi + 1] = data[gp + 1]; out[oi + 2] = data[gp + 2]; out[oi + 3] = data[gp + 3]; continue; }
      const a = m / 255;
      const lp = ((gyy - cy0 - gy0) * gw + (gxx - cx0 - gx0)) * CC;
      for (let c = 0; c < 3; c++) out[oi + c] = data[gp + c] + (fill[lp + c] - data[gp + c]) * a;
      out[oi + 3] = hasAlpha ? data[gp + 3] + (fill[lp + 3] - data[gp + 3]) * a : data[gp + 3];
    }
  }
  return { x: bb.x0, y: bb.y0, w: bw, h: bh, data: out };
}

// ============================================================================
// output composition
// ============================================================================

function compose(img, rect, opts) {
  if (opts.returnRect) {
    if (!rect) return { data: new Uint8ClampedArray(0), x: 0, y: 0, width: 0, height: 0 };
    return { data: rect.data, x: rect.x, y: rect.y, width: rect.w, height: rect.h };
  }
  const out = opts.output || new Uint8ClampedArray(img.data);
  if (!rect) return out;
  const W = img.width;
  for (let y = 0; y < rect.h; y++) {
    const o = ((rect.y + y) * W + rect.x) * 4;
    out.set(rect.data.subarray(y * rect.w * 4, (y + 1) * rect.w * 4), o);
  }
  return out;
}

// ============================================================================
// public: inpaint
// ============================================================================

/**
 * Content-aware fill.
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {Uint8Array} mask  w*h, >0 = hole (value/255 = blend weight)
 * @param {object} opts
 *   patchSize=7, seed=12345 (deterministic), onProgress(fraction 0..1), bbox, output, returnRect
 *   sourceMask       Uint8Array w*h, >127 = may be sampled (default: everything outside the hole)
 *   emIterations     EM iterations per level (default schedule: coarsest 10, mid 5/3, finest 2; coarsest gets 2x)
 *   pmIterations     PatchMatch sweeps per EM iteration (default 3 coarse .. 1 finest)
 *   maxWorkingPixels crop size above which the fill runs at reduced resolution (2.5e6)
 *   maxHolePixels    hole size (px) above which the fill runs at reduced resolution (1.2e5); the result is then
 *                    re-voted with full-resolution source pixels, so texture stays sharp
 *   contextMargin    px of context around the hole bbox (default max(48, 1.25 * hole extent))
 *   colorAdaptation  0..1 (0.9): allow per-patch colour shifts (gradients, illumination); 0 = off
 *   maxColorShift    max per-channel shift for colour adaptation (40)
 *   boundaryCorrection (true) / maxBoundaryCorrection (64): harmonic seam correction at the hole edge
 *   textureFeatures (true) / featureWeight (3): gradient-magnitude channels that keep fills textured
 *   levels, minCoarseSize, minBoundaryCoverage, finalSharpness, init ('smooth' | 'onion'): tuning
 * @returns {Uint8ClampedArray} full-size RGBA (or {data,x,y,width,height} when opts.returnRect)
 */
export function inpaint(img, mask, opts = {}) {
  const rect = inpaintCore(img, mask, opts);
  return compose(img, rect, opts);
}

// ============================================================================
// public: heal
// ============================================================================

function healCore(tData, sData, sOff, W, H, mask, bb, opts) {
  const x0 = Math.max(0, bb.x0 - 2), y0 = Math.max(0, bb.y0 - 2);
  const x1 = Math.min(W - 1, bb.x1 + 2), y1 = Math.min(H - 1, bb.y1 + 2);
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const c = 4;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y + y0) * W + x0;
    for (let x = 0; x < w; x++) m[y * w + x] = mask[row + x] > 0 ? 1 : 0;
  }
  // Dirichlet boundary for the membrane:
  //  'outer' (default, Photoshop-like): unmasked pixels 4-adjacent to the mask; the blemish under the mask
  //          never leaks into the result. Needs `source` to be valid on that 1px ring (true for a clone
  //          offset image / proximity match).
  //  'inner': the outermost masked pixels (for sources that are only valid inside the mask).
  const inner = opts.boundary === 'inner';
  const state = new Uint8Array(w * h).fill(2);
  const vals = new Float32Array(w * h * c);
  let any = false;
  const gx0 = x0, gy0 = y0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const mi = m[i];
      if (mi && !inner) { state[i] = 0; continue; }
      if (!mi && inner) continue;
      // pixel adjacent (4-neighbourhood) to the other region?
      const want = inner ? 0 : 1;
      const edge = (x > 0 && m[i - 1] === want) || (x < w - 1 && m[i + 1] === want) || (y > 0 && m[i - w] === want) || (y < h - 1 && m[i + w] === want) ||
        (inner && ((x === 0 && x + gx0 > 0) || (x === w - 1 && x + gx0 < W - 1) || (y === 0 && y + gy0 > 0) || (y === h - 1 && y + gy0 < H - 1)));
      if (edge) {
        state[i] = 1; any = true;
        const gp = ((y + gy0) * W + x + gx0) * 4, sp = gp + sOff * 4;
        for (let k = 0; k < c; k++) vals[i * c + k] = tData[gp + k] - sData[sp + k];
      } else if (inner) state[i] = 0;
    }
  }
  let memb = null;
  if (any) memb = membraneSolve(vals, state, w, h, c, { cycles: opts.cycles ?? 8, tol: 0.02 });
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1;
  const out = new Uint8ClampedArray(bw * bh * 4);
  const healAlpha = opts.healAlpha !== false;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const gx = x + bb.x0, gy = y + bb.y0, gi = gy * W + gx, gp = gi * 4, oi = (y * bw + x) * 4;
      const mv = mask[gi];
      if (mv === 0) { out[oi] = tData[gp]; out[oi + 1] = tData[gp + 1]; out[oi + 2] = tData[gp + 2]; out[oi + 3] = tData[gp + 3]; continue; }
      const a = mv / 255, li = ((gy - y0) * w + (gx - x0)) * c, sp = gp + sOff * 4;
      for (let k = 0; k < 4; k++) {
        if (k === 3 && !healAlpha) { out[oi + 3] = tData[gp + 3]; continue; }
        const v = sData[sp + k] + (memb ? memb[li + k] : 0);
        out[oi + k] = tData[gp + k] + (v - tData[gp + k]) * a;
      }
    }
  }
  return { x: bb.x0, y: bb.y0, w: bw, h: bh, data: out };
}

/**
 * Healing Brush blend: inside mask -> source + harmonic membrane of (target - source) on the mask boundary.
 * opts: {bbox, output, returnRect, cycles, healAlpha=true, boundary: 'outer' (default) | 'inner'}
 * With the default 'outer' boundary, `source` must be valid on the 1px ring just outside the mask.
 */
export function heal(target, source, mask, opts = {}) {
  const W = target.width, H = target.height;
  if (source.width !== W || source.height !== H) throw new Error('heal: source must have the same size as target');
  const bb = opts.bbox ? normBBox(opts.bbox, W, H) : maskBBox(mask, W, H);
  if (!bb) return compose(target, null, opts);
  const rect = healCore(target.data, source.data, 0, W, H, mask, bb, opts);
  return compose(target, rect, opts);
}

// ============================================================================
// public: findSourceOffset (Proximity Match)
// ============================================================================

/**
 * Finds an offset (dx,dy) so that img[p + (dx,dy)] is a good replacement for the hole pixels p.
 * Returns {dx, dy, score}; score = Infinity when no valid offset exists.
 * opts: {bbox, band, maxRadiusFactor=3}
 */
export function findSourceOffset(img, mask, opts = {}) {
  const W = img.width, H = img.height, d = img.data;
  const bb = opts.bbox ? normBBox(opts.bbox, W, H) : maskBBox(mask, W, H);
  if (!bb) return { dx: 0, dy: 0, score: Infinity };
  const bw = bb.x1 - bb.x0 + 1, bh = bb.y1 - bb.y0 + 1, size = Math.max(bw, bh);
  const band = opts.band ?? clampI(Math.round(size * 0.2), 3, 10);
  const rx0 = Math.max(0, bb.x0 - band), ry0 = Math.max(0, bb.y0 - band);
  const rx1 = Math.min(W - 1, bb.x1 + band), ry1 = Math.min(H - 1, bb.y1 + band);
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const hl = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    const row = (y + ry0) * W + rx0;
    for (let x = 0; x < rw; x++) hl[y * rw + x] = mask[row + x] > 0 ? 1 : 0;
  }
  const dil = dilate(hl, rw, rh, band);
  const holeAll = [], bandAll = [];
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = y * rw + x;
    if (hl[i]) holeAll.push((y + ry0) * W + x + rx0);
    else if (dil[i]) bandAll.push((y + ry0) * W + x + rx0);
  }
  if (!bandAll.length) return { dx: 0, dy: 0, score: Infinity };
  const sub = (arr, n) => {
    if (arr.length <= n) return Int32Array.from(arr);
    const out = new Int32Array(n), st = arr.length / n;
    for (let i = 0; i < n; i++) out[i] = arr[Math.floor(i * st)];
    return out;
  };
  const bandS = sub(bandAll, 1500), holeS = sub(holeAll, 400), holeF = Int32Array.from(holeAll), bandF = Int32Array.from(bandAll);
  const inHole = (g, dx, dy) => {
    const y = ((g / W) | 0) + dy, x = g - ((g / W) | 0) * W + dx;
    if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
    return hl[(y - ry0) * rw + (x - rx0)] === 1;
  };
  const overlaps = (dx, dy, hs, bs) => {
    for (let i = 0; i < hs.length; i++) if (inHole(hs[i], dx, dy)) return true;
    for (let i = 0; i < bs.length; i++) if (inHole(bs[i], dx, dy)) return true;
    return false;
  };
  const inside = (dx, dy) => rx0 + dx >= 0 && rx1 + dx < W && ry0 + dy >= 0 && ry1 + dy < H;
  const distW = opts.distancePenalty ?? 0.04;
  const score = (dx, dy, best) => {
    const off = (dy * W + dx) * 4;
    let s = 0;
    const n = bandS.length, lim = best * n;
    let mbR = 0, mbG = 0, mbB = 0;
    for (let i = 0; i < n; i++) {
      const p = bandS[i] * 4, q = p + off;
      const a = d[p] - d[q], b = d[p + 1] - d[q + 1], c = d[p + 2] - d[q + 2];
      s += a * a + b * b + c * c;
      mbR += d[q]; mbG += d[q + 1]; mbB += d[q + 2];
      if (s > lim) return Infinity;
    }
    s /= n;
    // interior plausibility: shifted hole should look like the shifted band (no other blemish inside)
    if (holeS.length) {
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < holeS.length; i++) { const q = holeS[i] * 4 + off; r += d[q]; g += d[q + 1]; b += d[q + 2]; }
      const k = 1 / holeS.length, kb = 1 / n;
      const er = r * k - mbR * kb, eg = g * k - mbG * kb, eb = b * k - mbB * kb;
      s += 0.5 * (er * er + eg * eg + eb * eb);
    }
    return s * (1 + distW * Math.hypot(dx, dy) / size);
  };
  const cands = [];
  const tried = new Set();
  const consider = (dx, dy) => {
    dx = Math.round(dx); dy = Math.round(dy);
    const key = dx * 100003 + dy;
    if (tried.has(key)) return;
    tried.add(key);
    if ((dx === 0 && dy === 0) || !inside(dx, dy) || overlaps(dx, dy, holeS, bandS)) return;
    const sc = score(dx, dy, Infinity);
    if (sc < Infinity) cands.push({ dx, dy, sc });
  };
  const maxF = opts.maxRadiusFactor ?? 3;
  for (const f of [0.6, 0.8, 1.0, 1.25, 1.5, 2, 2.5, 3, 4]) {
    if (f > maxF + 1e-9) break;
    const R = Math.max(band + 2, f * size + band);
    const n = clampI(Math.round((2 * Math.PI * R) / Math.max(2, size / 5)), 12, 96);
    for (let k = 0; k < n; k++) { const a = (2 * Math.PI * k) / n; consider(R * Math.cos(a), R * Math.sin(a)); }
  }
  const step = Math.max(2, Math.round(size / 3)), ext = Math.round(maxF * size + band);
  for (let dy = -ext; dy <= ext; dy += step) for (let dx = -ext; dx <= ext; dx += step) consider(dx, dy);
  if (!cands.length) {
    // widen search: coarse grid over the whole image
    const st = Math.max(2, Math.round(Math.max(W, H) / 48));
    for (let dy = -H; dy <= H; dy += st) for (let dx = -W; dx <= W; dx += st) consider(dx, dy);
  }
  if (!cands.length) return { dx: 0, dy: 0, score: Infinity };
  cands.sort((a, b) => a.sc - b.sc);
  const top = cands.slice(0, 6);
  for (const c of top) {
    let st = Math.max(1, Math.round(size / 8));
    while (st >= 1) {
      let moved = false;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy) continue;
        const dx = c.dx + ox * st, dy = c.dy + oy * st;
        if ((dx === 0 && dy === 0) || !inside(dx, dy) || overlaps(dx, dy, holeS, bandS)) continue;
        const sc = score(dx, dy, c.sc);
        if (sc < c.sc) { c.dx = dx; c.dy = dy; c.sc = sc; moved = true; }
      }
      if (!moved) st >>= 1;
    }
  }
  top.sort((a, b) => a.sc - b.sc);
  for (const c of top) if (!overlaps(c.dx, c.dy, holeF, bandF)) return { dx: c.dx, dy: c.dy, score: c.sc };
  for (const c of cands) if (!overlaps(c.dx, c.dy, holeF, bandF)) return { dx: c.dx, dy: c.dy, score: c.sc };
  return { dx: 0, dy: 0, score: Infinity };
}

// ============================================================================
// public: spotHeal
// ============================================================================

/**
 * Spot Healing Brush. Works on a small crop around the spot only.
 * opts: {mode: 'content-aware' | 'proximity' | 'texture', bbox, output, returnRect, seed, patchSize, ...inpaint opts}
 *  content-aware: inpaint() with a small context (margin = max(32, spot size)) incl. harmonic boundary correction
 *  proximity:     findSourceOffset() + heal() (falls back to content-aware when no offset fits)
 *  texture:       patch-synthesised texture from the surroundings (9px patches, no colour adaptation),
 *                 healed in with an unclamped Poisson membrane
 */
export function spotHeal(img, mask, opts = {}) {
  const W = img.width, H = img.height;
  const bb = opts.bbox ? normBBox(opts.bbox, W, H) : maskBBox(mask, W, H);
  if (!bb) return compose(img, null, opts);
  const size = Math.max(bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1);
  let mode = opts.mode || 'content-aware';
  let rect = null;
  if (mode === 'proximity') {
    const off = findSourceOffset(img, mask, { ...opts, bbox: bb });
    if (Number.isFinite(off.score)) rect = healCore(img.data, img.data, off.dy * W + off.dx, W, H, mask, bb, opts);
    else mode = 'content-aware';
  }
  if (mode === 'texture') {
    // "Create Texture": synthesise texture from the immediate surroundings (larger patches, texture
    // features, no colour adaptation, so no attempt to continue gradients/structure), then heal it into
    // the boundary with an unclamped Poisson membrane like the Healing Brush.
    rect = inpaintCore(img, mask, {
      ...opts, bbox: bb, contextMargin: opts.contextMargin ?? Math.max(24, Math.round(size * 0.75)),
      patchSize: opts.patchSize ?? 9, colorAdaptation: 0, featureWeight: opts.featureWeight ?? 2,
      init: 'smooth', maxBoundaryCorrection: 255,
    });
  } else if (mode === 'content-aware' || !rect) {
    rect = inpaintCore(img, mask, { ...opts, bbox: bb, contextMargin: opts.contextMargin ?? Math.max(32, Math.round(size * 1.0)) });
  }
  return compose(img, rect, opts);
}
