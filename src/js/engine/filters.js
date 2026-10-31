// Strata — spatial filters (pure math, no DOM). Works in Node and Web Workers.
// Images are {data: Uint8ClampedArray RGBA (non-premultiplied), width, height}.
// Every filter returns a NEW image of the same size.

// ===========================================================================
// Basic utilities
// ===========================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

function newImage(w, h) {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

function copyImage(img) {
  return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
}

function hexToRgb(hex) {
  let s = String(hex || '#000000').trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s.slice(0, 6), 16);
  if (!isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isOpaque(d) {
  for (let i = 3, n = d.length; i < n; i += 4) if (d[i] !== 255) return false;
  return true;
}

// Seeded PRNG (mulberry32) -> [0,1)
function rng(seed) {
  let a = (num(seed, 1) * 2654435761) >>> 0 || 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussRandFactory(rand) {
  let spare = null;
  return function () {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u <= 1e-12) u = rand();
    v = rand();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  };
}

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

// ===========================================================================
// Plane blurs (Float32 planes, clamp-to-edge)
// ===========================================================================

function boxH(src, dst, w, h, r) {
  if (r <= 0) { dst.set(src); return; }
  const inv = 1 / (2 * r + 1);
  const wm = w - 1;
  const xa = Math.min(w, r + 1), xb = Math.max(xa, w - r - 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const first = src[row], last = src[row + wm];
    let acc = first * (r + 1);
    for (let k = 1; k <= r; k++) acc += src[row + (k < wm ? k : wm)];
    let x = 0;
    for (; x < xa; x++) { // left border: window start clamped
      dst[row + x] = acc * inv;
      const a = x + r + 1, s = x - r;
      acc += (a < wm ? src[row + a] : last) - (s > 0 ? src[row + s] : first);
    }
    for (; x < xb; x++) { // interior
      dst[row + x] = acc * inv;
      acc += src[row + x + r + 1] - src[row + x - r];
    }
    for (; x < w; x++) { // right border
      dst[row + x] = acc * inv;
      const a = x + r + 1, s = x - r;
      acc += (a < wm ? src[row + a] : last) - (s > 0 ? src[row + s] : first);
    }
  }
}

function boxV(src, dst, w, h, r, acc) {
  if (r <= 0) { dst.set(src); return; }
  const inv = 1 / (2 * r + 1);
  const hm = h - 1;
  if (!acc || acc.length < w) acc = new Float64Array(w);
  for (let x = 0; x < w; x++) acc[x] = src[x] * (r + 1);
  for (let k = 1; k <= r; k++) {
    const o = (k < hm ? k : hm) * w;
    for (let x = 0; x < w; x++) acc[x] += src[o + x];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = acc[x] * inv;
    const a = y + r + 1, s = y - r;
    const ao = (a < hm ? a : hm) * w, so = (s > 0 ? s : 0) * w;
    for (let x = 0; x < w; x++) acc[x] += src[ao + x] - src[so + x];
  }
}

function gaussKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}

function convH(src, dst, w, h, k) {
  const r = (k.length - 1) >> 1;
  const wm = w - 1;
  const k0 = k[r];
  const x0 = Math.min(r, w), x1 = Math.max(x0, w - r);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < x0; x++) {
      let s = k0 * src[row + x];
      for (let i = 1; i <= r; i++) {
        const a = x - i < 0 ? 0 : x - i, b = x + i > wm ? wm : x + i;
        s += k[r + i] * (src[row + a] + src[row + b]);
      }
      dst[row + x] = s;
    }
    if (r === 1) {
      const k1 = k[2];
      for (let c = row + x0, e = row + x1; c < e; c++) dst[c] = k0 * src[c] + k1 * (src[c - 1] + src[c + 1]);
    } else if (r === 2) {
      const k1 = k[3], k2 = k[4];
      for (let c = row + x0, e = row + x1; c < e; c++) dst[c] = k0 * src[c] + k1 * (src[c - 1] + src[c + 1]) + k2 * (src[c - 2] + src[c + 2]);
    } else {
      for (let c = row + x0, e = row + x1; c < e; c++) {
        let s = k0 * src[c];
        for (let i = 1; i <= r; i++) s += k[r + i] * (src[c - i] + src[c + i]);
        dst[c] = s;
      }
    }
    for (let x = x1; x < w; x++) {
      let s = k0 * src[row + x];
      for (let i = 1; i <= r; i++) {
        const a = x - i < 0 ? 0 : x - i, b = x + i > wm ? wm : x + i;
        s += k[r + i] * (src[row + a] + src[row + b]);
      }
      dst[row + x] = s;
    }
  }
}

function convV(src, dst, w, h, k) {
  const r = (k.length - 1) >> 1;
  const hm = h - 1;
  const k0 = k[r];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) dst[row + x] = k0 * src[row + x];
    for (let i = 1; i <= r; i++) {
      const a = (y - i < 0 ? 0 : y - i) * w, b = (y + i > hm ? hm : y + i) * w, kv = k[r + i];
      for (let x = 0; x < w; x++) dst[row + x] += kv * (src[a + x] + src[b + x]);
    }
  }
}

// Sizes of n boxes approximating a gaussian (Kovesi / Kuckir)
function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  const r = [];
  for (let i = 0; i < n; i++) r.push(((i < m ? wl : wu) - 1) >> 1);
  return r;
}

// In-place gaussian of a Float32 plane. tmp: Float32Array(w*h)
function gaussPlane(P, tmp, w, h, sigma) {
  if (!(sigma > 0.05)) return P;
  if (sigma < 2.5) {
    const k = gaussKernel(sigma);
    convH(P, tmp, w, h, k);
    convV(tmp, P, w, h, k);
  } else {
    const acc = new Float64Array(w);
    for (const r of boxesForGauss(sigma, 3)) {
      boxH(P, tmp, w, h, r);
      boxV(tmp, P, w, h, r, acc);
    }
  }
  return P;
}

function boxPlane(P, tmp, w, h, r) {
  r = Math.round(r);
  if (r <= 0) return P;
  boxH(P, tmp, w, h, r);
  boxV(tmp, P, w, h, r);
  return P;
}

function kernelPlane(k) {
  return (P, tmp, w, h) => { convH(P, tmp, w, h, k); convV(tmp, P, w, h, k); return P; };
}

// Blur an image with an in-place plane function, premultiplied alpha.
function blurImageWith(img, fn) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const out = newImage(w, h);
  const od = out.data;
  const tmp = new Float32Array(n);
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  const opaque = isOpaque(data);
  let A = null;
  if (opaque) {
    for (let i = 0, o = 0; i < n; i++, o += 4) { R[i] = data[o]; G[i] = data[o + 1]; B[i] = data[o + 2]; }
  } else {
    A = new Float32Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = data[o + 3], k = a / 255;
      A[i] = a; R[i] = data[o] * k; G[i] = data[o + 1] * k; B[i] = data[o + 2] * k;
    }
    fn(A, tmp, w, h);
  }
  fn(R, tmp, w, h); fn(G, tmp, w, h); fn(B, tmp, w, h);
  if (opaque) {
    for (let i = 0, o = 0; i < n; i++, o += 4) { od[o] = R[i]; od[o + 1] = G[i]; od[o + 2] = B[i]; od[o + 3] = 255; }
  } else {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = A[i];
      if (a > 1e-3) { const k = 255 / a; od[o] = R[i] * k; od[o + 1] = G[i] * k; od[o + 2] = B[i] * k; od[o + 3] = a; }
    }
  }
  return out;
}

// Same but returns un-premultiplied Float32 planes [R,G,B] (alpha is not changed).
// Colour of fully transparent pixels is taken from the blur (so it is sensible).
function blurredRGB(img, fn) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const tmp = new Float32Array(n);
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  const opaque = isOpaque(data);
  let A = null;
  if (opaque) {
    for (let i = 0, o = 0; i < n; i++, o += 4) { R[i] = data[o]; G[i] = data[o + 1]; B[i] = data[o + 2]; }
  } else {
    A = new Float32Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = data[o + 3], k = a / 255;
      A[i] = a; R[i] = data[o] * k; G[i] = data[o + 1] * k; B[i] = data[o + 2] * k;
    }
    fn(A, tmp, w, h);
  }
  fn(R, tmp, w, h); fn(G, tmp, w, h); fn(B, tmp, w, h);
  if (!opaque) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const a = A[i];
      if (a > 1e-3) { const k = 255 / a; R[i] *= k; G[i] *= k; B[i] *= k; }
      else { R[i] = data[o]; G[i] = data[o + 1]; B[i] = data[o + 2]; }
    }
  }
  return [R, G, B];
}

const gaussFn = (sigma) => (P, tmp, w, h) => gaussPlane(P, tmp, w, h, sigma);
const boxFn = (r) => (P, tmp, w, h) => boxPlane(P, tmp, w, h, r);

// ---- exported helpers -----------------------------------------------------

export function gaussianBlur(img, radius) {
  const r = num(radius, 0);
  if (!(r > 0.05)) return copyImage(img);
  return blurImageWith(img, gaussFn(r));
}

export function boxBlur(img, radius) {
  const r = Math.round(num(radius, 0));
  if (r <= 0) return copyImage(img);
  return blurImageWith(img, boxFn(r));
}

// Blur a single channel (e.g. a selection mask). Returns the same array type.
export function gaussianBlurChannel(channel, width, height, radius) {
  const n = width * height;
  const P = new Float32Array(n);
  for (let i = 0; i < n; i++) P[i] = channel[i];
  gaussPlane(P, new Float32Array(n), width, height, num(radius, 0));
  const out = new channel.constructor(n);
  const isInt = !(out instanceof Float32Array || out instanceof Float64Array);
  for (let i = 0; i < n; i++) out[i] = isInt ? Math.round(P[i]) : P[i];
  return out;
}

// ===========================================================================
// Premultiplied float RGBA helpers + bilinear sampling (geometric filters)
// ===========================================================================

function toPremul(data) {
  const n = data.length;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i += 4) {
    const a = data[i + 3], k = a / 255;
    f[i] = data[i] * k; f[i + 1] = data[i + 1] * k; f[i + 2] = data[i + 2] * k; f[i + 3] = a;
  }
  return f;
}

function fromPremul(f, w, h) {
  const out = newImage(w, h);
  const d = out.data;
  for (let i = 0, n = f.length; i < n; i += 4) {
    const a = f[i + 3];
    if (a > 1e-3) {
      const k = 255 / a;
      d[i] = f[i] * k; d[i + 1] = f[i + 1] * k; d[i + 2] = f[i + 2] * k; d[i + 3] = a;
    }
  }
  return out;
}

const EDGE_CLAMP = 0, EDGE_WRAP = 1, EDGE_TRANSPARENT = 2;
const S4 = new Float64Array(4);

// Bilinear sample of premultiplied float RGBA into S4.
function sampleBilinear(f, w, h, sx, sy, edge) {
  const x0f = Math.floor(sx), y0f = Math.floor(sy);
  const tx = sx - x0f, ty = sy - y0f;
  S4[0] = S4[1] = S4[2] = S4[3] = 0;
  for (let j = 0; j < 2; j++) {
    let yy = y0f + j;
    const wy = j ? ty : 1 - ty;
    if (wy === 0) continue;
    if (yy < 0 || yy >= h) {
      if (edge === EDGE_TRANSPARENT) continue;
      if (edge === EDGE_WRAP) yy = ((yy % h) + h) % h;
      else yy = yy < 0 ? 0 : h - 1;
    }
    for (let i = 0; i < 2; i++) {
      let xx = x0f + i;
      const wgt = (i ? tx : 1 - tx) * wy;
      if (wgt === 0) continue;
      if (xx < 0 || xx >= w) {
        if (edge === EDGE_TRANSPARENT) continue;
        if (edge === EDGE_WRAP) xx = ((xx % w) + w) % w;
        else xx = xx < 0 ? 0 : w - 1;
      }
      const o = (yy * w + xx) * 4;
      S4[0] += f[o] * wgt; S4[1] += f[o + 1] * wgt; S4[2] += f[o + 2] * wgt; S4[3] += f[o + 3] * wgt;
    }
  }
}

// Backward-mapping remap: mapFn(x, y, P) writes source coords into P[0], P[1].
function remap(img, mapFn, edge = EDGE_CLAMP) {
  const { width: w, height: h } = img;
  const f = toPremul(img.data);
  const out = newImage(w, h);
  const d = out.data;
  const P = new Float64Array(2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      mapFn(x, y, P);
      sampleBilinear(f, w, h, P[0], P[1], edge);
      const o = (y * w + x) * 4;
      const a = S4[3];
      if (a > 1e-3) {
        const k = 255 / a;
        d[o] = S4[0] * k; d[o + 1] = S4[1] * k; d[o + 2] = S4[2] * k; d[o + 3] = a;
      }
    }
  }
  return out;
}

const edgeOf = (s) => (s === 'wrap' ? EDGE_WRAP : s === 'transparent' ? EDGE_TRANSPARENT : EDGE_CLAMP);

// ===========================================================================
// Blur filters
// ===========================================================================

// Average of in(p+d) and in(p-d) with constant sub-pixel offset d (bilinear).
function shiftAvgPass(src, dst, w, h, dx, dy) {
  dst.fill(0);
  for (let s = -1; s <= 1; s += 2) {
    const ox = dx * s, oy = dy * s;
    const fx = Math.floor(ox), fy = Math.floor(oy);
    const tx = ox - fx, ty = oy - fy;
    const w00 = (1 - tx) * (1 - ty) * 0.5, w10 = tx * (1 - ty) * 0.5, w01 = (1 - tx) * ty * 0.5, w11 = tx * ty * 0.5;
    const wm = w - 1, hm = h - 1;
    for (let y = 0; y < h; y++) {
      let y0 = y + fy, y1 = y0 + 1;
      y0 = y0 < 0 ? 0 : y0 > hm ? hm : y0;
      y1 = y1 < 0 ? 0 : y1 > hm ? hm : y1;
      const r0 = y0 * w, r1 = y1 * w;
      let o = y * w * 4;
      for (let x = 0; x < w; x++, o += 4) {
        let x0 = x + fx, x1 = x0 + 1;
        x0 = x0 < 0 ? 0 : x0 > wm ? wm : x0;
        x1 = x1 < 0 ? 0 : x1 > wm ? wm : x1;
        const a = (r0 + x0) * 4, b = (r0 + x1) * 4, c = (r1 + x0) * 4, e = (r1 + x1) * 4;
        dst[o] += src[a] * w00 + src[b] * w10 + src[c] * w01 + src[e] * w11;
        dst[o + 1] += src[a + 1] * w00 + src[b + 1] * w10 + src[c + 1] * w01 + src[e + 1] * w11;
        dst[o + 2] += src[a + 2] * w00 + src[b + 2] * w10 + src[c + 2] * w01 + src[e + 2] * w11;
        dst[o + 3] += src[a + 3] * w00 + src[b + 3] * w10 + src[c + 3] * w01 + src[e + 3] * w11;
      }
    }
  }
}

function motionBlur(img, p) {
  const dist = clamp(num(p.distance, 10), 1, 2000);
  const ang = (num(p.angle, 0) * Math.PI) / 180;
  const { width: w, height: h } = img;
  let a = toPremul(img.data), b = new Float32Array(a.length);
  const ux = Math.cos(ang), uy = -Math.sin(ang);
  const k = Math.max(1, Math.ceil(Math.log2(dist)));
  // offsets ±D/4, ±D/8, ... produce 2^k uniform taps spanning ~D
  for (let i = 1; i <= k; i++) {
    const s = dist / Math.pow(2, i + 1);
    shiftAvgPass(a, b, w, h, ux * s, uy * s);
    const t = a; a = b; b = t;
  }
  return fromPremul(a, w, h);
}

function radialBlur(img, p) {
  const amount = clamp(num(p.amount, 10), 1, 100);
  const zoom = p.method === 'zoom';
  const { width: w, height: h } = img;
  const cx = (clamp(num(p.centerX, 50), 0, 100) / 100) * (w - 1);
  const cy = (clamp(num(p.centerY, 50), 0, 100) / 100) * (h - 1);
  const maxR = Math.max(Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy));
  let total, disp;
  if (zoom) { total = (amount / 100) * 0.7; disp = total * maxR; } // log-scale span
  else { total = (amount * Math.PI) / 180; disp = total * maxR; } // angle span (rad)
  const passes = clamp(Math.ceil(Math.log2(Math.max(2, disp))), 1, 13);
  let a = toPremul(img.data), b = new Float32Array(a.length);
  for (let i = 1; i <= passes; i++) {
    const s = total / Math.pow(2, i + 1);
    b.fill(0);
    for (let sg = -1; sg <= 1; sg += 2) {
      const v = s * sg;
      const cs = Math.cos(v), sn = Math.sin(v), sc = Math.exp(v);
      for (let y = 0; y < h; y++) {
        const dy = y - cy;
        for (let x = 0; x < w; x++) {
          const dx = x - cx;
          let sx, sy;
          if (zoom) { sx = cx + dx * sc; sy = cy + dy * sc; }
          else { sx = cx + dx * cs - dy * sn; sy = cy + dx * sn + dy * cs; }
          sampleBilinear(a, w, h, sx, sy, EDGE_CLAMP);
          const o = (y * w + x) * 4;
          b[o] += S4[0] * 0.5; b[o + 1] += S4[1] * 0.5; b[o + 2] += S4[2] * 0.5; b[o + 3] += S4[3] * 0.5;
        }
      }
    }
    const t = a; a = b; b = t;
  }
  return fromPremul(a, w, h);
}

// Photoshop Surface Blur: weight = max(0, 1 - |d| / (2.5*threshold)) inside the
// radius. Implemented as a piecewise-linear bilateral filter (Durand & Dorsey).
function surfaceBlur(img, p) {
  const radius = Math.round(clamp(num(p.radius, 5), 1, 100));
  const thr = clamp(num(p.threshold, 15), 2, 255);
  const { width: w, height: h, data } = img;
  const n = w * h;
  const T = 2.5 * thr;
  const K = clamp(Math.ceil(255 / (T * 0.6)) + 1, 2, 48);
  const step = 255 / (K - 1);
  const out = copyImage(img);
  const od = out.data;
  const I = new Float32Array(n), acc = new Float32Array(n), numP = new Float32Array(n), den = new Float32Array(n), tmp = new Float32Array(n);
  const A = new Float32Array(n);
  for (let i = 0; i < n; i++) A[i] = data[i * 4 + 3] / 255;
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) I[i] = data[i * 4 + c];
    acc.fill(0);
    for (let j = 0; j < K; j++) {
      const L = j * step;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(I[i] - L);
        const wgt = d < T ? (1 - d / T) * A[i] : 0;
        den[i] = wgt; numP[i] = wgt * I[i];
      }
      boxPlane(numP, tmp, w, h, radius);
      boxPlane(den, tmp, w, h, radius);
      for (let i = 0; i < n; i++) {
        const u = Math.abs(I[i] / step - j);
        if (u < 1) acc[i] += (1 - u) * (den[i] > 1e-6 ? numP[i] / den[i] : I[i]);
      }
    }
    for (let i = 0; i < n; i++) od[i * 4 + c] = acc[i];
  }
  return out;
}

function averageColor(img) {
  const { data } = img;
  let r = 0, g = 0, b = 0, a = 0;
  for (let i = 0, n = data.length; i < n; i += 4) {
    const al = data[i + 3];
    r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al;
  }
  const out = copyImage(img);
  if (a === 0) return out;
  const R = r / a, G = g / a, B = b / a;
  const d = out.data;
  for (let i = 0, n = d.length; i < n; i += 4) { d[i] = R; d[i + 1] = G; d[i + 2] = B; }
  return out;
}

// ===========================================================================
// Sharpen
// ===========================================================================

function usmCore(img, sigma, amount, threshold) {
  const [R, G, B] = blurredRGB(img, gaussFn(sigma));
  const out = copyImage(img);
  const d = out.data, s = img.data;
  const n = img.width * img.height;
  const P = [R, G, B];
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    for (let c = 0; c < 3; c++) {
      const v = s[o + c];
      const diff = v - P[c][i];
      if (threshold > 0 && (diff < 0 ? -diff : diff) < threshold) continue;
      d[o + c] = v + diff * amount;
    }
  }
  return out;
}

const SHARPEN_K = new Float32Array([0.25, 0.5, 0.25]);

function sharpenSimple(img, amount) {
  const bl = blurredRGB(img, kernelPlane(SHARPEN_K));
  const out = copyImage(img);
  const d = out.data, s = img.data, n = img.width * img.height;
  for (let c = 0; c < 3; c++) {
    const B = bl[c];
    for (let i = 0; i < n; i++) { const v = s[i * 4 + c]; d[i * 4 + c] = v + (v - B[i]) * amount; }
  }
  return out;
}

function smartSharpen(img, p) {
  const amount = clamp(num(p.amount, 200), 0, 500) / 100;
  const radius = clamp(num(p.radius, 1), 0.1, 64);
  const rn = clamp(num(p.reduceNoise, 10), 0, 100) / 100;
  const { width: w, height: h, data } = img;
  const n = w * h;
  // Luminance-only sharpening (no colour fringes); a second, tighter pass of
  // the gaussian-difference approximates the "remove gaussian blur" deconvolution.
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = lumOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const B = new Float32Array(Y), tmp = new Float32Array(n);
  gaussPlane(B, tmp, w, h, radius);
  const B2 = new Float32Array(Y);
  gaussPlane(B2, tmp, w, h, radius * 2);
  const noiseT = rn * 12; // levels
  const out = copyImage(img);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    let detail = (Y[i] - B[i]) * 1.0 + (B[i] - B2[i]) * 0.35;
    const ad = Math.abs(detail);
    if (noiseT > 0) {
      // soft coring: suppress small (noise) differences
      const t = ad / noiseT;
      detail *= t >= 1 ? 1 : t * t * (3 - 2 * t);
    }
    let delta = detail * amount;
    // halo control: limit overshoot
    const lim = 60 + 40 * amount;
    if (delta > lim) delta = lim; else if (delta < -lim) delta = -lim;
    const o = i * 4;
    d[o] = data[o] + delta; d[o + 1] = data[o + 1] + delta; d[o + 2] = data[o + 2] + delta;
  }
  return out;
}

// ===========================================================================
// Noise
// ===========================================================================

function addNoise(img, p, env) {
  const amt = clamp(num(p.amount, 12.5), 0.1, 400) / 100;
  const gauss = p.distribution === 'gaussian';
  const mono = !!p.monochromatic;
  const rand = rng(env.seed);
  const gr = gaussRandFactory(rand);
  const out = copyImage(img);
  const d = out.data;
  const scaleU = amt * 127.5, scaleG = amt * 64;
  const nv = gauss ? () => gr() * scaleG : () => (rand() * 2 - 1) * scaleU;
  for (let i = 0, n = d.length; i < n; i += 4) {
    if (mono) {
      const v = nv();
      d[i] += v; d[i + 1] += v; d[i + 2] += v;
    } else {
      d[i] += nv(); d[i + 1] += nv(); d[i + 2] += nv();
    }
  }
  // Uint8ClampedArray `+=` is computed in float then clamped
  return out;
}

// Huang sliding-histogram median on one channel (stride 4), clamped edges.
function medianChannel(src, dst, w, h, c, r) {
  const hist = new Int32Array(256);
  const N = (2 * r + 1) * (2 * r + 1);
  const half = N >> 1;
  const wm = w - 1, hm = h - 1;
  const rows = new Int32Array(2 * r + 1);
  for (let y = 0; y < h; y++) {
    for (let k = -r; k <= r; k++) rows[k + r] = clamp(y + k, 0, hm) * w;
    hist.fill(0);
    for (let k = 0; k < rows.length; k++) {
      for (let dx = -r; dx <= r; dx++) hist[src[(rows[k] + clamp(dx, 0, wm)) * 4 + c]]++;
    }
    let m = 0, below = 0;
    while (below + hist[m] <= half) { below += hist[m]; m++; }
    for (let x = 0; x < w; x++) {
      dst[(y * w + x) * 4 + c] = m;
      if (x === wm) break;
      const xr = x - r < 0 ? 0 : x - r;
      const xa = x + r + 1 > wm ? wm : x + r + 1;
      if (xr !== xa) {
        for (let k = 0; k < rows.length; k++) {
          const vo = src[(rows[k] + xr) * 4 + c];
          hist[vo]--; if (vo < m) below--;
          const vi = src[(rows[k] + xa) * 4 + c];
          hist[vi]++; if (vi < m) below++;
        }
        while (below > half) { m--; below -= hist[m]; }
        while (below + hist[m] <= half) { below += hist[m]; m++; }
      }
    }
  }
}

function medianImage(img, r, channels = 4) {
  const out = copyImage(img);
  for (let c = 0; c < channels; c++) medianChannel(img.data, out.data, img.width, img.height, c, r);
  return out;
}

function median(img, p) {
  return medianImage(img, Math.round(clamp(num(p.radius, 1), 1, 100)));
}

function dustAndScratches(img, p) {
  const r = Math.round(clamp(num(p.radius, 1), 1, 100));
  const t = clamp(num(p.threshold, 0), 0, 255);
  const med = medianImage(img, r, 3);
  const out = copyImage(img);
  const d = out.data, m = med.data, s = img.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    for (let c = 0; c < 3; c++) if (Math.abs(s[i + c] - m[i + c]) > t) d[i + c] = m[i + c];
  }
  return out;
}

// Self-guided filter (He et al.) on luminance + chroma smoothing.
function reduceNoise(img, p) {
  const strength = clamp(num(p.strength, 6), 0, 10);
  const pd = clamp(num(p.preserveDetails, 60), 0, 100) / 100;
  const cn = clamp(num(p.reduceColorNoise, 45), 0, 100) / 100;
  const { width: w, height: h, data } = img;
  const n = w * h;
  if (strength === 0 && cn === 0) return copyImage(img);
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    const y = lumOf(r, g, b);
    Y[i] = y / 255; Cb[i] = (b - y) * 0.564; Cr[i] = (r - y) * 0.713;
  }
  const tmp = new Float32Array(n);
  let Q = Y;
  if (strength > 0) {
    const rr = 1 + Math.round(strength * 0.4);
    const sn = (strength / 10) * 0.09 * (1 - pd * 0.75);
    const eps = sn * sn;
    const mI = new Float32Array(Y), mII = new Float32Array(n);
    for (let i = 0; i < n; i++) mII[i] = Y[i] * Y[i];
    boxPlane(mI, tmp, w, h, rr);
    boxPlane(mII, tmp, w, h, rr);
    const a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.max(0, mII[i] - mI[i] * mI[i]);
      a[i] = v / (v + eps);
      b[i] = mI[i] * (1 - a[i]);
    }
    boxPlane(a, tmp, w, h, rr);
    boxPlane(b, tmp, w, h, rr);
    Q = new Float32Array(n);
    for (let i = 0; i < n; i++) Q[i] = a[i] * Y[i] + b[i];
  }
  if (cn > 0) {
    gaussPlane(Cb, tmp, w, h, cn * 4);
    gaussPlane(Cr, tmp, w, h, cn * 4);
  }
  const out = copyImage(img);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    const y = Q[i] * 255;
    const r = y + Cr[i] / 0.713, b = y + Cb[i] / 0.564;
    const g = (y - 0.299 * r - 0.114 * b) / 0.587;
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b;
  }
  return out;
}

// Sigma filter: average of neighbours within a tolerance (edge-preserving).
function despeckle(img) {
  const { width: w, height: h, data } = img;
  const out = copyImage(img);
  const d = out.data;
  const tol = 20, r = 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = data[o + c];
        let s = 0, cnt = 0;
        for (let dy = -r; dy <= r; dy++) {
          const yy = clamp(y + dy, 0, h - 1) * w;
          for (let dx = -r; dx <= r; dx++) {
            const q = data[(yy + clamp(x + dx, 0, w - 1)) * 4 + c];
            if (Math.abs(q - v) <= tol) { s += q; cnt++; }
          }
        }
        d[o + c] = s / cnt;
      }
    }
  }
  return out;
}

// ===========================================================================
// Pixelate
// ===========================================================================

function mosaic(img, p) {
  const cs = Math.round(clamp(num(p.cellSize, 10), 2, 200));
  const { width: w, height: h, data } = img;
  const out = newImage(w, h);
  const d = out.data;
  for (let by = 0; by < h; by += cs) {
    for (let bx = 0; bx < w; bx += cs) {
      const ex = Math.min(w, bx + cs), ey = Math.min(h, by + cs);
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const o = (y * w + x) * 4, al = data[o + 3];
        r += data[o] * al; g += data[o + 1] * al; b += data[o + 2] * al; a += al; cnt++;
      }
      const R = a ? r / a : 0, G = a ? g / a : 0, B = a ? b / a : 0, A = a / cnt;
      for (let y = by; y < ey; y++) for (let x = bx; x < ex; x++) {
        const o = (y * w + x) * 4;
        d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = A;
      }
    }
  }
  return out;
}

// Jittered-grid Voronoi labelling. Returns {label Int32Array, px, py, gw, gh}
function voronoi(w, h, cs, seed) {
  const rand = rng(seed);
  const gw = Math.ceil(w / cs), gh = Math.ceil(h / cs);
  const px = new Float32Array(gw * gh), py = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
    px[j * gw + i] = (i + 0.1 + rand() * 0.8) * cs;
    py[j * gw + i] = (j + 0.1 + rand() * 0.8) * cs;
  }
  const label = new Int32Array(w * h), dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const cj = Math.floor(y / cs);
    for (let x = 0; x < w; x++) {
      const ci = Math.floor(x / cs);
      let best = 1e30, bi = 0;
      for (let j = cj - 1; j <= cj + 1; j++) {
        if (j < 0 || j >= gh) continue;
        for (let i = ci - 1; i <= ci + 1; i++) {
          if (i < 0 || i >= gw) continue;
          const k = j * gw + i;
          const dx = px[k] - x, dy = py[k] - y;
          const dd = dx * dx + dy * dy;
          if (dd < best) { best = dd; bi = k; }
        }
      }
      label[y * w + x] = bi;
      dist[y * w + x] = Math.sqrt(best);
    }
  }
  return { label, dist, px, py, count: gw * gh };
}

function cellAverages(img, label, count) {
  const { data } = img;
  const s = new Float64Array(count * 5);
  for (let i = 0, n = img.width * img.height; i < n; i++) {
    const k = label[i] * 5, o = i * 4, a = data[o + 3];
    s[k] += data[o] * a; s[k + 1] += data[o + 1] * a; s[k + 2] += data[o + 2] * a; s[k + 3] += a; s[k + 4]++;
  }
  return s;
}

function crystallize(img, p, env) {
  const cs = Math.round(clamp(num(p.cellSize, 10), 3, 300));
  const { width: w, height: h } = img;
  const { label, count } = voronoi(w, h, cs, env.seed);
  const s = cellAverages(img, label, count);
  const out = newImage(w, h);
  const d = out.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const k = label[i] * 5, a = s[k + 3];
    if (!a) continue;
    d[i * 4] = s[k] / a; d[i * 4 + 1] = s[k + 1] / a; d[i * 4 + 2] = s[k + 2] / a; d[i * 4 + 3] = a / s[k + 4];
  }
  return out;
}

function pointillize(img, p, env) {
  const cs = Math.round(clamp(num(p.cellSize, 5), 3, 300));
  const { width: w, height: h } = img;
  const { label, dist, count } = voronoi(w, h, cs, env.seed);
  const s = cellAverages(img, label, count);
  const rand = rng((env.seed | 0) + 7919);
  const rad = new Float32Array(count), jit = new Float32Array(count * 3);
  for (let k = 0; k < count; k++) {
    rad[k] = cs * (0.42 + rand() * 0.2);
    const v = (rand() - 0.5) * 40;
    jit[k * 3] = v + (rand() - 0.5) * 16; jit[k * 3 + 1] = v + (rand() - 0.5) * 16; jit[k * 3 + 2] = v + (rand() - 0.5) * 16;
  }
  const [br, bg, bb] = hexToRgb(env.bg);
  const out = newImage(w, h);
  const d = out.data, src = img.data;
  for (let i = 0, n = w * h; i < n; i++) {
    const k = label[i], a = s[k * 5 + 3];
    const cov = clamp(rad[k] - dist[i] + 0.5, 0, 1);
    let r = br, g = bg, b = bb;
    if (a && cov > 0) {
      const cr = s[k * 5] / a + jit[k * 3], cg = s[k * 5 + 1] / a + jit[k * 3 + 1], cb = s[k * 5 + 2] / a + jit[k * 3 + 2];
      r = br + (cr - br) * cov; g = bg + (cg - bg) * cov; b = bb + (cb - bb) * cov;
    }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = src[i * 4 + 3];
  }
  return out;
}

function colorHalftone(img, p) {
  const maxR = clamp(num(p.maxRadius, 8), 4, 127);
  const angles = [num(p.angle1, 108), num(p.angle2, 162), num(p.angle3, 90)];
  const { width: w, height: h, data } = img;
  const n = w * h;
  const cs = 2 * maxR;
  const bl = blurredRGB(img, boxFn(Math.max(1, Math.round(maxR * 0.7))));
  const out = copyImage(img);
  const d = out.data;
  const k = 1.25 / Math.sqrt(Math.PI);
  for (let c = 0; c < 3; c++) {
    const P = bl[c];
    const a = (angles[c] * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const sampleAt = (x, y) => {
      const xi = clamp(Math.round(x), 0, w - 1), yi = clamp(Math.round(y), 0, h - 1);
      return P[yi * w + xi];
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x * ca + y * sa, v = -x * sa + y * ca;
        const iu = Math.floor(u / cs), iv = Math.floor(v / cs);
        let cov = 0;
        for (let j = iv - 1; j <= iv + 1; j++) for (let i = iu - 1; i <= iu + 1; i++) {
          const cu = (i + 0.5) * cs, cv = (j + 0.5) * cs;
          const px = cu * ca - cv * sa, py = cu * sa + cv * ca; // back to image space
          if (px < -cs || py < -cs || px > w + cs || py > h + cs) continue;
          // RGB mode (like PS): dot area is proportional to channel brightness
          const ink = sampleAt(px, py) / 255;
          if (ink <= 0) continue;
          const R = cs * Math.sqrt(ink) * k;
          const dd = Math.hypot(u - cu, v - cv);
          const cv2 = R - dd + 0.5;
          if (cv2 > cov) cov = cv2 >= 1 ? 1 : cv2;
          if (cov >= 1) break;
        }
        d[(y * w + x) * 4 + c] = 255 * cov;
      }
    }
  }
  return out;
}

// ===========================================================================
// Stylize
// ===========================================================================

function emboss(img, p) {
  const ang = (num(p.angle, 135) * Math.PI) / 180;
  const hgt = clamp(num(p.height, 3), 1, 10);
  const amt = clamp(num(p.amount, 100), 1, 500) / 100;
  const { width: w, height: h } = img;
  const f = toPremul(img.data);
  const lx = Math.cos(ang) * hgt * 0.5, ly = -Math.sin(ang) * hgt * 0.5;
  const out = copyImage(img);
  const d = out.data;
  const A = new Float64Array(4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    sampleBilinear(f, w, h, x - lx, y - ly, EDGE_CLAMP);
    A[0] = S4[0]; A[1] = S4[1]; A[2] = S4[2];
    sampleBilinear(f, w, h, x + lx, y + ly, EDGE_CLAMP);
    const o = (y * w + x) * 4;
    d[o] = 128 + (A[0] - S4[0]) * amt;
    d[o + 1] = 128 + (A[1] - S4[1]) * amt;
    d[o + 2] = 128 + (A[2] - S4[2]) * amt;
  }
  return out;
}

function sobelMag(P, w, h, x, y, step) {
  const xm = clamp(x - step, 0, w - 1), xp = clamp(x + step, 0, w - 1);
  const ym = clamp(y - step, 0, h - 1) * w, yp = clamp(y + step, 0, h - 1) * w, yc = y * w;
  const gx = (P[ym + xp] + 2 * P[yc + xp] + P[yp + xp]) - (P[ym + xm] + 2 * P[yc + xm] + P[yp + xm]);
  const gy = (P[yp + xm] + 2 * P[yp + x] + P[yp + xp]) - (P[ym + xm] + 2 * P[ym + x] + P[ym + xp]);
  return Math.sqrt(gx * gx + gy * gy);
}

function planesOf(img) {
  const n = img.width * img.height, d = img.data;
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) { out[0][i] = d[i * 4]; out[1][i] = d[i * 4 + 1]; out[2][i] = d[i * 4 + 2]; }
  return out;
}

function findEdges(img) {
  const { width: w, height: h } = img;
  const P = planesOf(img);
  const out = copyImage(img);
  const d = out.data;
  for (let c = 0; c < 3; c++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    d[(y * w + x) * 4 + c] = 255 - sobelMag(P[c], w, h, x, y, 1) / 3;
  }
  return out;
}

function solarize(img) {
  const out = copyImage(img);
  const d = out.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    for (let c = 0; c < 3; c++) { const v = d[i + c]; if (v > 127) d[i + c] = 255 - v; }
  }
  return out;
}

function glowingEdges(img, p) {
  const width = clamp(num(p.edgeWidth, 2), 1, 14);
  const bright = clamp(num(p.brightness, 6), 0, 20);
  const smooth = clamp(num(p.smoothness, 5), 1, 15);
  const { width: w, height: h } = img;
  const P = blurredRGB(img, gaussFn(smooth * 0.35));
  const step = Math.max(1, Math.round(width / 2));
  const out = copyImage(img);
  const d = out.data;
  const gain = (bright / 6) * (0.9 / step);
  const tmp = new Float32Array(w * h);
  for (let c = 0; c < 3; c++) {
    const E = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) E[y * w + x] = sobelMag(P[c], w, h, x, y, step) * gain;
    if (width > 2) gaussPlane(E, tmp, w, h, (width - 2) * 0.25);
    for (let i = 0; i < w * h; i++) d[i * 4 + c] = E[i];
  }
  return out;
}

// Kuwahara oil paint: pick the mean of the least-variance quadrant.
function oilPaint(img, p) {
  const sty = clamp(num(p.stylization, 2.5), 0.1, 10);
  const clean = clamp(num(p.cleanliness, 5), 0, 10);
  const shine = clamp(num(p.shine, 1), 0, 10);
  const { width: w, height: h } = img;
  const n = w * h;
  const q = Math.max(1, Math.round(sty * 1.2));
  const src = clean > 0 ? gaussianBlur(img, clean * 0.18) : img;
  const sd = src.data;
  const L = new Float32Array(n), L2 = new Float32Array(n);
  const [R, G, B] = planesOf(src);
  for (let i = 0; i < n; i++) { const l = lumOf(sd[i * 4], sd[i * 4 + 1], sd[i * 4 + 2]); L[i] = l; L2[i] = l * l; }
  const tmp = new Float32Array(n);
  for (const P of [L, L2, R, G, B]) boxPlane(P, tmp, w, h, q);
  const out = copyImage(img);
  const d = out.data;
  const lum = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ys = [clamp(y - q, 0, h - 1), clamp(y + q, 0, h - 1)];
    for (let x = 0; x < w; x++) {
      const xs = [clamp(x - q, 0, w - 1), clamp(x + q, 0, w - 1)];
      let best = 1e30, bk = 0;
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const k = ys[j] * w + xs[i];
        const v = L2[k] - L[k] * L[k];
        if (v < best) { best = v; bk = k; }
      }
      const o = (y * w + x) * 4;
      d[o] = R[bk]; d[o + 1] = G[bk]; d[o + 2] = B[bk];
      lum[y * w + x] = L[bk];
    }
  }
  if (shine > 0) {
    // brush relief lighting from the upper left
    const k = shine * 0.12;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const a = lum[clamp(y - 1, 0, h - 1) * w + clamp(x - 1, 0, w - 1)];
      const b = lum[clamp(y + 1, 0, h - 1) * w + clamp(x + 1, 0, w - 1)];
      const s = (b - a) * k;
      const o = (y * w + x) * 4;
      d[o] += s; d[o + 1] += s; d[o + 2] += s;
    }
  }
  return out;
}

function diffuse(img, p, env) {
  const mode = p.mode || 'normal';
  const { width: w, height: h, data } = img;
  const rand = rng(env.seed);
  const out = copyImage(img);
  const d = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    let q;
    if (mode === 'anisotropic') {
      const l0 = lumOf(data[o], data[o + 1], data[o + 2]);
      let best = 1e9;
      q = o;
      const start = (rand() * 8) | 0;
      for (let t = 0; t < 8; t++) {
        const k = (start + t) & 7;
        const dx = [1, 1, 0, -1, -1, -1, 0, 1][k], dy = [0, 1, 1, 1, 0, -1, -1, -1][k];
        const qq = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
        const dl = Math.abs(lumOf(data[qq], data[qq + 1], data[qq + 2]) - l0);
        if (dl < best) { best = dl; q = qq; }
      }
    } else {
      const dx = Math.round((rand() * 2 - 1) * 2), dy = Math.round((rand() * 2 - 1) * 2);
      q = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
      if (mode === 'darkenOnly' || mode === 'lightenOnly') {
        const l0 = lumOf(data[o], data[o + 1], data[o + 2]);
        const l1 = lumOf(data[q], data[q + 1], data[q + 2]);
        if (mode === 'darkenOnly' ? l1 >= l0 : l1 <= l0) q = o;
      }
    }
    d[o] = data[q]; d[o + 1] = data[q + 1]; d[o + 2] = data[q + 2]; d[o + 3] = data[q + 3];
  }
  return out;
}

function tiles(img, p, env) {
  const count = Math.round(clamp(num(p.tiles, 10), 1, 99));
  const maxOff = clamp(num(p.maxOffset, 10), 1, 99) / 100;
  const fill = p.fill || 'background';
  const { width: w, height: h, data } = img;
  const ts = Math.max(1, Math.floor(Math.min(w, h) / count));
  const out = newImage(w, h);
  const d = out.data;
  const fc = fill === 'foreground' ? hexToRgb(env.fg) : hexToRgb(env.bg);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (fill === 'inverse') { d[o] = 255 - data[o]; d[o + 1] = 255 - data[o + 1]; d[o + 2] = 255 - data[o + 2]; d[o + 3] = data[o + 3]; }
    else if (fill === 'unaltered') { d[o] = data[o]; d[o + 1] = data[o + 1]; d[o + 2] = data[o + 2]; d[o + 3] = data[o + 3]; }
    else { d[o] = fc[0]; d[o + 1] = fc[1]; d[o + 2] = fc[2]; d[o + 3] = 255; }
  }
  const rand = rng(env.seed);
  for (let by = 0; by < h; by += ts) for (let bx = 0; bx < w; bx += ts) {
    const ox = Math.round((rand() * 2 - 1) * maxOff * ts), oy = Math.round((rand() * 2 - 1) * maxOff * ts);
    const ex = Math.min(w, bx + ts), ey = Math.min(h, by + ts);
    for (let y = by; y < ey; y++) {
      const ty = y + oy;
      if (ty < 0 || ty >= h) continue;
      for (let x = bx; x < ex; x++) {
        const tx = x + ox;
        if (tx < 0 || tx >= w) continue;
        const s = (y * w + x) * 4, t = (ty * w + tx) * 4;
        d[t] = data[s]; d[t + 1] = data[s + 1]; d[t + 2] = data[s + 2]; d[t + 3] = data[s + 3];
      }
    }
  }
  return out;
}

// ===========================================================================
// Distort
// ===========================================================================

function ellipseInfo(w, h) {
  return { cx: (w - 1) / 2, cy: (h - 1) / 2, rx: w / 2, ry: h / 2 };
}

function twirl(img, p) {
  const ang = (clamp(num(p.angle, 50), -999, 999) * Math.PI) / 180;
  const { width: w, height: h } = img;
  const { cx, cy } = ellipseInfo(w, h);
  const R = Math.min(w, h) / 2;
  return remap(img, (x, y, P) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= R) { P[0] = x; P[1] = y; return; }
    const f = 1 - r / R;
    const a = ang * f * f;
    const c = Math.cos(a), s = Math.sin(a);
    P[0] = cx + dx * c - dy * s; P[1] = cy + dx * s + dy * c;
  });
}

function spherize(img, p) {
  const amt = clamp(num(p.amount, 100), -100, 100) / 100;
  const mode = p.mode || 'normal';
  const { width: w, height: h } = img;
  const { cx, cy, rx, ry } = ellipseInfo(w, h);
  const c = -amt * 0.5;
  return remap(img, (x, y, P) => {
    let nx = (x - cx) / rx, ny = (y - cy) / ry;
    if (mode === 'horizontal') {
      const r = Math.abs(nx);
      if (r < 1) nx = Math.sign(nx) * (r + c * (r - r * r * r));
      P[0] = cx + nx * rx; P[1] = y; return;
    }
    if (mode === 'vertical') {
      const r = Math.abs(ny);
      if (r < 1) ny = Math.sign(ny) * (r + c * (r - r * r * r));
      P[0] = x; P[1] = cy + ny * ry; return;
    }
    const r = Math.sqrt(nx * nx + ny * ny);
    if (r >= 1 || r === 0) { P[0] = x; P[1] = y; return; }
    const k = 1 + c * (1 - r * r);
    P[0] = cx + nx * k * rx; P[1] = cy + ny * k * ry;
  });
}

function pinch(img, p) {
  const amt = clamp(num(p.amount, 50), -100, 100) / 100;
  const { width: w, height: h } = img;
  const { cx, cy, rx, ry } = ellipseInfo(w, h);
  return remap(img, (x, y, P) => {
    const nx = (x - cx) / rx, ny = (y - cy) / ry;
    const r = Math.sqrt(nx * nx + ny * ny);
    if (r >= 1 || r === 0) { P[0] = x; P[1] = y; return; }
    const k = Math.pow(Math.sin((Math.PI / 2) * r), -amt);
    // limit so we don't sample outside the ellipse for strong pinches
    const kk = Math.min(k, 1 / r);
    P[0] = cx + nx * kk * rx; P[1] = cy + ny * kk * ry;
  });
}

function waveShape(type, t) {
  // t is phase in radians
  if (type === 'triangle') { const u = t / (2 * Math.PI); const f = u - Math.floor(u); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }
  if (type === 'square') return Math.sin(t) >= 0 ? 1 : -1;
  return Math.sin(t);
}

function wave(img, p, env) {
  const gens = Math.round(clamp(num(p.generators, 5), 1, 999));
  let wl0 = clamp(num(p.minWavelength, 10), 1, 998), wl1 = clamp(num(p.maxWavelength, 120), 2, 999);
  let am0 = clamp(num(p.minAmplitude, 5), 0, 998), am1 = clamp(num(p.maxAmplitude, 35), 1, 999);
  if (wl1 < wl0) [wl0, wl1] = [wl1, wl0];
  if (am1 < am0) [am0, am1] = [am1, am0];
  const sh = clamp(num(p.scaleH, 100), 0, 100) / 100, sv = clamp(num(p.scaleV, 100), 0, 100) / 100;
  const type = p.type || 'sine';
  const { width: w, height: h } = img;
  const rand = rng(env.seed);
  const dxRow = new Float32Array(h), dyCol = new Float32Array(w);
  const norm = 1 / gens; // average of generators: displacement bounded by max amplitude
  for (let g = 0; g < gens; g++) {
    const l1 = wl0 + rand() * (wl1 - wl0), a1 = am0 + rand() * (am1 - am0), ph1 = rand() * Math.PI * 2;
    const l2 = wl0 + rand() * (wl1 - wl0), a2 = am0 + rand() * (am1 - am0), ph2 = rand() * Math.PI * 2;
    for (let y = 0; y < h; y++) dxRow[y] += a1 * norm * sh * waveShape(type, (2 * Math.PI * y) / l1 + ph1);
    for (let x = 0; x < w; x++) dyCol[x] += a2 * norm * sv * waveShape(type, (2 * Math.PI * x) / l2 + ph2);
  }
  return remap(img, (x, y, P) => { P[0] = x + dxRow[y]; P[1] = y + dyCol[x]; }, p.undefinedAreas === 'wrap' ? EDGE_WRAP : EDGE_CLAMP);
}

// smooth 1-D value noise
function noise1D(rand, len, period) {
  const cells = Math.ceil(len / period) + 2;
  const v = new Float32Array(cells);
  for (let i = 0; i < cells; i++) v[i] = rand() * 2 - 1;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const f = i / period, k = Math.floor(f), t = f - k;
    const s = t * t * (3 - 2 * t);
    out[i] = v[k] + (v[k + 1] - v[k]) * s;
  }
  return out;
}

function ripple(img, p, env) {
  const amount = clamp(num(p.amount, 100), -999, 999) / 100;
  const size = p.size || 'medium';
  const lambda = size === 'small' ? 8 : size === 'large' ? 30 : 16;
  const { width: w, height: h } = img;
  const rand = rng(env.seed);
  const A = amount * lambda * 0.2;
  const phX = noise1D(rand, w, lambda * 3), phY = noise1D(rand, h, lambda * 3);
  const amX = noise1D(rand, w, lambda * 5), amY = noise1D(rand, h, lambda * 5);
  const k = (2 * Math.PI) / lambda;
  return remap(img, (x, y, P) => {
    P[0] = x + A * (0.75 + 0.25 * amX[x]) * Math.sin(y * k + phX[x] * 2.5);
    P[1] = y + A * (0.75 + 0.25 * amY[y]) * Math.sin(x * k + phY[y] * 2.5);
  });
}

function polarCoordinates(img, p) {
  const toPolar = p.mode !== 'polarToRect';
  const { width: w, height: h } = img;
  const cx = w / 2, cy = h / 2;
  const TAU = Math.PI * 2;
  if (toPolar) {
    // output is polar: top row of the source -> centre, angle -> x
    return remap(img, (x, y, P) => {
      const dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += TAU;
      P[0] = (a / TAU) * w - 0.5; P[1] = r * h - 0.5;
    }, EDGE_CLAMP);
  }
  return remap(img, (x, y, P) => {
    const a = ((x + 0.5) / w) * TAU, r = (y + 0.5) / h;
    P[0] = cx + r * cx * Math.sin(a) - 0.5; P[1] = cy - r * cy * Math.cos(a) - 0.5;
  }, EDGE_CLAMP);
}

function zigzag(img, p) {
  const amt = clamp(num(p.amount, 10), -100, 100) / 100;
  const ridges = clamp(num(p.ridges, 5), 1, 20);
  const style = p.style || 'pondRipples';
  const { width: w, height: h } = img;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const R = Math.min(w, h) / 2;
  const A = (amt * R) / ridges * 0.35;
  return remap(img, (x, y, P) => {
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r >= R || r === 0) { P[0] = x; P[1] = y; return; }
    const fade = 1 - r / R;
    const s = Math.sin((r / R) * ridges * Math.PI * 2) * A * fade;
    let nr = r, a = Math.atan2(dy, dx);
    if (style === 'aroundCenter') a += s / Math.max(r, 1);
    else if (style === 'outFromCenter') nr = r + s;
    else { nr = r + s * 0.7; a += (s * 0.7) / Math.max(r, 1); }
    P[0] = cx + nr * Math.cos(a); P[1] = cy + nr * Math.sin(a);
  });
}

// ===========================================================================
// Render
// ===========================================================================

// Fractal value noise in 0..1, normalised to full range.
function fbm(w, h, seed, cellX, cellY, persistence = 0.5) {
  const rand = rng(seed);
  const out = new Float32Array(w * h);
  let amp = 1, cx = cellX, cy = cellY;
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  while (cx >= 1 || cy >= 1) {
    const sx = Math.max(cx, 0.5), sy = Math.max(cy, 0.5);
    const gw = Math.ceil(w / sx) + 2, gh = Math.ceil(h / sy) + 2;
    const lat = new Float32Array(gw * gh);
    for (let i = 0; i < lat.length; i++) lat[i] = rand();
    const ox = rand() * sx, oy = rand() * sy;
    const ix = new Int32Array(w), tx = new Float32Array(w);
    for (let x = 0; x < w; x++) { const f = (x + ox) / sx; ix[x] = Math.floor(f); tx[x] = fade(f - ix[x]); }
    for (let y = 0; y < h; y++) {
      const f = (y + oy) / sy, iy = Math.floor(f), ty = fade(f - iy);
      const r0 = iy * gw, r1 = r0 + gw, row = y * w;
      for (let x = 0; x < w; x++) {
        const i0 = r0 + ix[x], i1 = r1 + ix[x], t = tx[x];
        const a = lat[i0] + (lat[i0 + 1] - lat[i0]) * t;
        const b = lat[i1] + (lat[i1 + 1] - lat[i1]) * t;
        out[row + x] += (a + (b - a) * ty) * amp;
      }
    }
    amp *= persistence; cx /= 2; cy /= 2;
  }
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < out.length; i++) { const v = out[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  const k = mx > mn ? 1 / (mx - mn) : 0;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mn) * k;
  return out;
}

function cloudsPlane(img, env) {
  return fbm(img.width, img.height, num(env.seed, 1), 256, 256, 0.5);
}

function clouds(img, p, env) {
  const N = cloudsPlane(img, env);
  const fg = hexToRgb(env.fg), bg = hexToRgb(env.bg);
  const out = newImage(img.width, img.height);
  const d = out.data;
  for (let i = 0; i < N.length; i++) {
    const t = N[i];
    d[i * 4] = fg[0] + (bg[0] - fg[0]) * t;
    d[i * 4 + 1] = fg[1] + (bg[1] - fg[1]) * t;
    d[i * 4 + 2] = fg[2] + (bg[2] - fg[2]) * t;
    d[i * 4 + 3] = 255;
  }
  return out;
}

function differenceClouds(img, p, env) {
  const cl = clouds(img, p, env).data;
  const out = copyImage(img);
  const d = out.data;
  for (let i = 0, n = d.length; i < n; i += 4) {
    d[i] = Math.abs(d[i] - cl[i]); d[i + 1] = Math.abs(d[i + 1] - cl[i + 1]); d[i + 2] = Math.abs(d[i + 2] - cl[i + 2]);
  }
  return out;
}

function fibers(img, p, env) {
  const variance = clamp(num(p.variance, 16), 1, 64);
  const strength = clamp(num(p.strength, 4), 1, 64);
  const { width: w, height: h } = img;
  // long vertical streaks: tiny horizontal cells, long vertical cells
  const cellY = Math.max(4, (512 / variance) * (0.5 + strength / 16));
  const N = fbm(w, h, num(env.seed, 1), 3, cellY, 0.55);
  const tmp = new Float32Array(w * h);
  // stretch along fibres (vertical box) for a woven look
  boxV(N, tmp, w, h, Math.max(1, Math.round(strength / 2)));
  N.set(tmp);
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N.length; i++) { if (N[i] < mn) mn = N[i]; if (N[i] > mx) mx = N[i]; }
  const k = mx > mn ? 1 / (mx - mn) : 0;
  const fg = hexToRgb(env.fg), bg = hexToRgb(env.bg);
  const out = newImage(w, h);
  const d = out.data;
  for (let i = 0; i < N.length; i++) {
    const t = (N[i] - mn) * k;
    d[i * 4] = fg[0] + (bg[0] - fg[0]) * t;
    d[i * 4 + 1] = fg[1] + (bg[1] - fg[1]) * t;
    d[i * 4 + 2] = fg[2] + (bg[2] - fg[2]) * t;
    d[i * 4 + 3] = 255;
  }
  return out;
}

// ===========================================================================
// Other
// ===========================================================================

function highPass(img, p) {
  const r = clamp(num(p.radius, 10), 0.1, 1000);
  const bl = blurredRGB(img, gaussFn(r));
  const out = copyImage(img);
  const d = out.data, s = img.data, n = img.width * img.height;
  for (let c = 0; c < 3; c++) {
    const B = bl[c];
    for (let i = 0; i < n; i++) d[i * 4 + c] = 128 + (s[i * 4 + c] - B[i]);
  }
  return out;
}

// van Herk / Gil-Werman 1-D min/max over a window of 2r+1, clamped edges.
function vhgw(line, n, r, isMax, out, pad, g, hb) {
  const k = 2 * r + 1, L = n + 2 * r;
  for (let i = 0; i < L; i++) { let j = i - r; j = j < 0 ? 0 : j >= n ? n - 1 : j; pad[i] = line[j]; }
  for (let s = 0; s < L; s += k) {
    const e = Math.min(L, s + k);
    g[s] = pad[s];
    for (let i = s + 1; i < e; i++) g[i] = isMax ? (pad[i] > g[i - 1] ? pad[i] : g[i - 1]) : (pad[i] < g[i - 1] ? pad[i] : g[i - 1]);
    hb[e - 1] = pad[e - 1];
    for (let i = e - 2; i >= s; i--) hb[i] = isMax ? (pad[i] > hb[i + 1] ? pad[i] : hb[i + 1]) : (pad[i] < hb[i + 1] ? pad[i] : hb[i + 1]);
  }
  for (let x = 0; x < n; x++) {
    const a = hb[x], b = g[x + k - 1];
    out[x] = isMax ? (a > b ? a : b) : (a < b ? a : b);
  }
}

function morph(img, r, isMax) {
  const { width: w, height: h, data } = img;
  r = Math.round(r);
  const out = copyImage(img);
  if (r <= 0) return out;
  const d = out.data;
  const maxLen = Math.max(w, h) + 2 * r + 2;
  const line = new Uint8Array(Math.max(w, h)), res = new Uint8Array(Math.max(w, h));
  const pad = new Uint8Array(maxLen), g = new Uint8Array(maxLen), hb = new Uint8Array(maxLen);
  const opaque = isOpaque(data);
  // transparent pixels should not contribute colour
  const src = new Uint8Array(data);
  if (!opaque) for (let i = 0; i < src.length; i += 4) if (src[i + 3] === 0) { const v = isMax ? 0 : 255; src[i] = src[i + 1] = src[i + 2] = v; }
  const work = new Uint8Array(src.length);
  for (let c = 0; c < 4; c++) {
    if (c === 3 && opaque) break;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) line[x] = src[(y * w + x) * 4 + c];
      vhgw(line, w, r, isMax, res, pad, g, hb);
      for (let x = 0; x < w; x++) work[(y * w + x) * 4 + c] = res[x];
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) line[y] = work[(y * w + x) * 4 + c];
      vhgw(line, h, r, isMax, res, pad, g, hb);
      for (let y = 0; y < h; y++) d[(y * w + x) * 4 + c] = res[y];
    }
  }
  return out;
}

function offset(img, p) {
  const ox = Math.round(num(p.horizontal, 0)), oy = Math.round(num(p.vertical, 0));
  const mode = p.undefinedAreas || 'wrap';
  const { width: w, height: h, data } = img;
  const out = newImage(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    let sy = y - oy;
    if (sy < 0 || sy >= h) {
      if (mode === 'transparent') continue;
      sy = mode === 'wrap' ? ((sy % h) + h) % h : clamp(sy, 0, h - 1);
    }
    for (let x = 0; x < w; x++) {
      let sx = x - ox;
      if (sx < 0 || sx >= w) {
        if (mode === 'transparent') continue;
        sx = mode === 'wrap' ? ((sx % w) + w) % w : clamp(sx, 0, w - 1);
      }
      const s = (sy * w + sx) * 4, t = (y * w + x) * 4;
      d[t] = data[s]; d[t + 1] = data[s + 1]; d[t + 2] = data[s + 2]; d[t + 3] = data[s + 3];
    }
  }
  return out;
}

// ===========================================================================
// Adjust (spatial adjustments)
// ===========================================================================

function shadowsHighlights(img, p) {
  const sA = clamp(num(p.shadows, 35), 0, 100) / 100;
  const hA = clamp(num(p.highlights, 0), 0, 100) / 100;
  const radius = clamp(num(p.radius, 30), 0, 2500);
  const { width: w, height: h, data } = img;
  const n = w * h;
  const out = copyImage(img);
  if (sA === 0 && hA === 0) return out;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = lumOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) / 255;
  const base = new Float32Array(L);
  if (radius > 0) gaussPlane(base, new Float32Array(n), w, h, radius * 0.5);
  const d = out.data;
  for (let i = 0; i < n; i++) {
    const l = L[i], b = base[i];
    let nl = l;
    if (sA > 0) {
      let ws = clamp((0.5 - b) / 0.5, 0, 1); ws = ws * ws * (3 - 2 * ws);
      const k = sA * ws;
      if (k > 0) nl = 1 - Math.pow(1 - nl, 1 + 3 * k);
    }
    if (hA > 0) {
      let wh = clamp((b - 0.5) / 0.5, 0, 1); wh = wh * wh * (3 - 2 * wh);
      const k = hA * wh;
      if (k > 0) nl = Math.pow(nl, 1 + 3 * k);
    }
    if (nl === l) continue;
    const o = i * 4;
    if (l > 0.004) {
      const ratio = nl / l;
      d[o] = data[o] * ratio; d[o + 1] = data[o + 1] * ratio; d[o + 2] = data[o + 2] * ratio;
    } else {
      const add = (nl - l) * 255;
      d[o] = data[o] + add; d[o + 1] = data[o + 1] + add; d[o + 2] = data[o + 2] + add;
    }
  }
  return out;
}

// ===========================================================================
// Registry
// ===========================================================================

export const FILTER_CATEGORIES = ['Blur', 'Distort', 'Noise', 'Pixelate', 'Render', 'Sharpen', 'Stylize', 'Other', 'Adjust'];

const R = (key, label, min, max, def, step = 1, unit = '') => ({ key, label, type: 'range', min, max, step, default: def, unit });
const SEL = (key, label, options, def) => ({ key, label, type: 'select', options: options.map(([value, label]) => ({ value, label })), default: def });
const CHK = (key, label, def) => ({ key, label, type: 'checkbox', default: def });
const ANG = (key, label, def) => ({ key, label, type: 'angle', min: -180, max: 180, default: def });

export const FILTERS = {
  // ---------------- Blur ----------------
  averageColor: { name: 'Average', category: 'Blur', params: [], run: (img) => averageColor(img) },
  blur: { name: 'Blur', category: 'Blur', params: [], run: (img) => blurImageWith(img, kernelPlane(new Float32Array([0.25, 0.5, 0.25]))) },
  blurMore: { name: 'Blur More', category: 'Blur', params: [], run: (img) => blurImageWith(img, gaussFn(1.4)) },
  boxBlur: {
    name: 'Box Blur…', category: 'Blur',
    params: [R('radius', 'Radius', 1, 999, 5, 1, 'px')],
    run: (img, p) => boxBlur(img, num(p.radius, 5)),
  },
  gaussianBlur: {
    name: 'Gaussian Blur…', category: 'Blur',
    params: [R('radius', 'Radius', 0.1, 250, 2, 0.1, 'px')],
    run: (img, p) => gaussianBlur(img, clamp(num(p.radius, 2), 0.1, 250)),
  },
  motionBlur: {
    name: 'Motion Blur…', category: 'Blur',
    params: [ANG('angle', 'Angle', 0), R('distance', 'Distance', 1, 2000, 10, 1, 'px')],
    run: (img, p) => motionBlur(img, p),
  },
  radialBlur: {
    name: 'Radial Blur…', category: 'Blur',
    params: [
      R('amount', 'Amount', 1, 100, 10),
      SEL('method', 'Blur Method', [['spin', 'Spin'], ['zoom', 'Zoom']], 'spin'),
      R('centerX', 'Center X', 0, 100, 50, 1, '%'),
      R('centerY', 'Center Y', 0, 100, 50, 1, '%'),
    ],
    run: (img, p) => radialBlur(img, p),
  },
  surfaceBlur: {
    name: 'Surface Blur…', category: 'Blur',
    params: [R('radius', 'Radius', 1, 100, 5, 1, 'px'), R('threshold', 'Threshold', 2, 255, 15, 1, 'levels')],
    run: (img, p) => surfaceBlur(img, p),
  },

  // ---------------- Distort ----------------
  pinch: { name: 'Pinch…', category: 'Distort', params: [R('amount', 'Amount', -100, 100, 50, 1, '%')], run: (img, p) => pinch(img, p) },
  polarCoordinates: {
    name: 'Polar Coordinates…', category: 'Distort',
    params: [SEL('mode', 'Mode', [['rectToPolar', 'Rectangular to Polar'], ['polarToRect', 'Polar to Rectangular']], 'rectToPolar')],
    run: (img, p) => polarCoordinates(img, p),
  },
  ripple: {
    name: 'Ripple…', category: 'Distort',
    params: [R('amount', 'Amount', -999, 999, 100, 1, '%'), SEL('size', 'Size', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'medium')],
    run: (img, p, env) => ripple(img, p, env),
  },
  spherize: {
    name: 'Spherize…', category: 'Distort',
    params: [R('amount', 'Amount', -100, 100, 100, 1, '%'), SEL('mode', 'Mode', [['normal', 'Normal'], ['horizontal', 'Horizontal only'], ['vertical', 'Vertical only']], 'normal')],
    run: (img, p) => spherize(img, p),
  },
  twirl: { name: 'Twirl…', category: 'Distort', params: [R('angle', 'Angle', -999, 999, 50, 1, '°')], run: (img, p) => twirl(img, p) },
  wave: {
    name: 'Wave…', category: 'Distort',
    params: [
      R('generators', 'Number of Generators', 1, 999, 5),
      R('minWavelength', 'Wavelength Min', 1, 998, 10),
      R('maxWavelength', 'Wavelength Max', 2, 999, 120),
      R('minAmplitude', 'Amplitude Min', 1, 998, 5),
      R('maxAmplitude', 'Amplitude Max', 2, 999, 35),
      R('scaleH', 'Scale Horiz.', 1, 100, 100, 1, '%'),
      R('scaleV', 'Scale Vert.', 1, 100, 100, 1, '%'),
      SEL('type', 'Type', [['sine', 'Sine'], ['triangle', 'Triangle'], ['square', 'Square']], 'sine'),
      SEL('undefinedAreas', 'Undefined Areas', [['wrap', 'Wrap Around'], ['repeat', 'Repeat Edge Pixels']], 'repeat'),
    ],
    run: (img, p, env) => wave(img, p, env),
  },
  zigzag: {
    name: 'ZigZag…', category: 'Distort',
    params: [
      R('amount', 'Amount', -100, 100, 10),
      R('ridges', 'Ridges', 1, 20, 5),
      SEL('style', 'Style', [['pondRipples', 'Pond ripples'], ['outFromCenter', 'Out from center'], ['aroundCenter', 'Around center']], 'pondRipples'),
    ],
    run: (img, p) => zigzag(img, p),
  },

  // ---------------- Noise ----------------
  addNoise: {
    name: 'Add Noise…', category: 'Noise',
    params: [
      R('amount', 'Amount', 0.1, 400, 12.5, 0.1, '%'),
      SEL('distribution', 'Distribution', [['uniform', 'Uniform'], ['gaussian', 'Gaussian']], 'uniform'),
      CHK('monochromatic', 'Monochromatic', false),
    ],
    run: (img, p, env) => addNoise(img, p, env),
  },
  despeckle: { name: 'Despeckle', category: 'Noise', params: [], run: (img) => despeckle(img) },
  dustAndScratches: {
    name: 'Dust & Scratches…', category: 'Noise',
    params: [R('radius', 'Radius', 1, 100, 1, 1, 'px'), R('threshold', 'Threshold', 0, 255, 0, 1, 'levels')],
    run: (img, p) => dustAndScratches(img, p),
  },
  median: { name: 'Median…', category: 'Noise', params: [R('radius', 'Radius', 1, 100, 1, 1, 'px')], run: (img, p) => median(img, p) },
  reduceNoise: {
    name: 'Reduce Noise…', category: 'Noise',
    params: [
      R('strength', 'Strength', 0, 10, 6),
      R('preserveDetails', 'Preserve Details', 0, 100, 60, 1, '%'),
      R('reduceColorNoise', 'Reduce Color Noise', 0, 100, 45, 1, '%'),
    ],
    run: (img, p) => reduceNoise(img, p),
  },

  // ---------------- Pixelate ----------------
  colorHalftone: {
    name: 'Color Halftone…', category: 'Pixelate',
    params: [
      R('maxRadius', 'Max. Radius', 4, 127, 8, 1, 'px'),
      R('angle1', 'Channel 1', -360, 360, 108, 1, '°'),
      R('angle2', 'Channel 2', -360, 360, 162, 1, '°'),
      R('angle3', 'Channel 3', -360, 360, 90, 1, '°'),
    ],
    run: (img, p) => colorHalftone(img, p),
  },
  crystallize: { name: 'Crystallize…', category: 'Pixelate', params: [R('cellSize', 'Cell Size', 3, 300, 10)], run: (img, p, env) => crystallize(img, p, env) },
  mosaic: { name: 'Mosaic…', category: 'Pixelate', params: [R('cellSize', 'Cell Size', 2, 200, 10, 1, 'square')], run: (img, p) => mosaic(img, p) },
  pointillize: { name: 'Pointillize…', category: 'Pixelate', params: [R('cellSize', 'Cell Size', 3, 300, 5)], run: (img, p, env) => pointillize(img, p, env) },

  // ---------------- Render ----------------
  clouds: { name: 'Clouds', category: 'Render', params: [], run: (img, p, env) => clouds(img, p, env) },
  differenceClouds: { name: 'Difference Clouds', category: 'Render', params: [], run: (img, p, env) => differenceClouds(img, p, env) },
  fibers: {
    name: 'Fibers…', category: 'Render',
    params: [R('variance', 'Variance', 1, 64, 16), R('strength', 'Strength', 1, 64, 4)],
    run: (img, p, env) => fibers(img, p, env),
  },

  // ---------------- Sharpen ----------------
  sharpen: { name: 'Sharpen', category: 'Sharpen', params: [], run: (img) => sharpenSimple(img, 0.6) },
  sharpenMore: { name: 'Sharpen More', category: 'Sharpen', params: [], run: (img) => sharpenSimple(img, 1.6) },
  smartSharpen: {
    name: 'Smart Sharpen…', category: 'Sharpen',
    params: [R('amount', 'Amount', 1, 500, 200, 1, '%'), R('radius', 'Radius', 0.1, 64, 1, 0.1, 'px'), R('reduceNoise', 'Reduce Noise', 0, 100, 10, 1, '%')],
    run: (img, p) => smartSharpen(img, p),
  },
  unsharpMask: {
    name: 'Unsharp Mask…', category: 'Sharpen',
    params: [R('amount', 'Amount', 1, 500, 100, 1, '%'), R('radius', 'Radius', 0.1, 1000, 1, 0.1, 'px'), R('threshold', 'Threshold', 0, 255, 0, 1, 'levels')],
    run: (img, p) => usmCore(img, clamp(num(p.radius, 1), 0.1, 1000), clamp(num(p.amount, 100), 1, 500) / 100, clamp(num(p.threshold, 0), 0, 255)),
  },

  // ---------------- Stylize ----------------
  diffuse: {
    name: 'Diffuse…', category: 'Stylize',
    params: [SEL('mode', 'Mode', [['normal', 'Normal'], ['darkenOnly', 'Darken Only'], ['lightenOnly', 'Lighten Only'], ['anisotropic', 'Anisotropic']], 'normal')],
    run: (img, p, env) => diffuse(img, p, env),
  },
  emboss: {
    name: 'Emboss…', category: 'Stylize',
    params: [ANG('angle', 'Angle', 135), R('height', 'Height', 1, 10, 3, 1, 'px'), R('amount', 'Amount', 1, 500, 100, 1, '%')],
    run: (img, p) => emboss(img, p),
  },
  findEdges: { name: 'Find Edges', category: 'Stylize', params: [], run: (img) => findEdges(img) },
  glowingEdges: {
    name: 'Glowing Edges…', category: 'Stylize',
    params: [R('edgeWidth', 'Edge Width', 1, 14, 2), R('brightness', 'Edge Brightness', 0, 20, 6), R('smoothness', 'Smoothness', 1, 15, 5)],
    run: (img, p) => glowingEdges(img, p),
  },
  oilPaint: {
    name: 'Oil Paint…', category: 'Stylize',
    params: [R('stylization', 'Stylization', 0.1, 10, 2.5, 0.1), R('cleanliness', 'Cleanliness', 0, 10, 5, 0.1), R('shine', 'Shine', 0, 10, 1, 0.1)],
    run: (img, p) => oilPaint(img, p),
  },
  solarize: { name: 'Solarize', category: 'Stylize', params: [], run: (img) => solarize(img) },
  tiles: {
    name: 'Tiles…', category: 'Stylize',
    params: [
      R('tiles', 'Number Of Tiles', 1, 99, 10),
      R('maxOffset', 'Maximum Offset', 1, 99, 10, 1, '%'),
      SEL('fill', 'Fill Empty Area With', [['background', 'Background Color'], ['foreground', 'Foreground Color'], ['inverse', 'Inverse Image'], ['unaltered', 'Unaltered Image']], 'background'),
    ],
    run: (img, p, env) => tiles(img, p, env),
  },

  // ---------------- Other ----------------
  highPass: { name: 'High Pass…', category: 'Other', params: [R('radius', 'Radius', 0.1, 1000, 10, 0.1, 'px')], run: (img, p) => highPass(img, p) },
  maximum: { name: 'Maximum…', category: 'Other', params: [R('radius', 'Radius', 1, 500, 1, 1, 'px')], run: (img, p) => morph(img, clamp(num(p.radius, 1), 1, 500), true) },
  minimum: { name: 'Minimum…', category: 'Other', params: [R('radius', 'Radius', 1, 500, 1, 1, 'px')], run: (img, p) => morph(img, clamp(num(p.radius, 1), 1, 500), false) },
  offset: {
    name: 'Offset…', category: 'Other',
    params: [
      R('horizontal', 'Horizontal', -30000, 30000, 0, 1, 'px right'),
      R('vertical', 'Vertical', -30000, 30000, 0, 1, 'px down'),
      SEL('undefinedAreas', 'Undefined Areas', [['transparent', 'Set to Transparent'], ['repeat', 'Repeat Edge Pixels'], ['wrap', 'Wrap Around']], 'wrap'),
    ],
    run: (img, p) => offset(img, p),
  },

  // ---------------- Adjust (spatial) ----------------
  shadowsHighlights: {
    name: 'Shadows/Highlights…', category: 'Adjust',
    params: [
      R('shadows', 'Shadows Amount', 0, 100, 35, 1, '%'),
      R('highlights', 'Highlights Amount', 0, 100, 0, 1, '%'),
      R('radius', 'Radius', 0, 2500, 30, 1, 'px'),
    ],
    run: (img, p) => shadowsHighlights(img, p),
  },
};

// Fill in default env + params for every filter run.
for (const key of Object.keys(FILTERS)) {
  const f = FILTERS[key];
  const raw = f.run;
  f.run = (img, p, env) => {
    const params = {};
    for (const s of f.params) params[s.key] = s.default;
    Object.assign(params, p || {});
    const e = Object.assign({ fg: '#000000', bg: '#ffffff', seed: 1 }, env || {});
    return raw(img, params, e);
  };
}

export function defaultFilterParams(key) {
  const f = FILTERS[key];
  const o = {};
  if (f) for (const s of f.params) o[s.key] = s.default;
  return o;
}
