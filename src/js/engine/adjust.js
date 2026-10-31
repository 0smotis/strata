// Strata — colour adjustments (pure math, no DOM). Works in Node and Web Workers.
// All functions operate on RGBA Uint8ClampedArray data (non-premultiplied) and
// leave the alpha channel untouched.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

export function hexToRgb(hex) {
  let s = String(hex || '#000000').trim().replace('#', '');
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s.slice(0, 6), 16);
  if (!isFinite(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------------------
// Menu + defaults
// ---------------------------------------------------------------------------

export const ADJUSTMENT_TYPES = [
  { type: 'brightnessContrast', name: 'Brightness/Contrast' },
  { type: 'levels', name: 'Levels' },
  { type: 'curves', name: 'Curves' },
  { type: 'exposure', name: 'Exposure' },
  { type: 'vibrance', name: 'Vibrance' },
  { type: 'hueSaturation', name: 'Hue/Saturation' },
  { type: 'colorBalance', name: 'Color Balance' },
  { type: 'blackWhite', name: 'Black & White' },
  { type: 'photoFilter', name: 'Photo Filter' },
  { type: 'channelMixer', name: 'Channel Mixer' },
  { type: 'invert', name: 'Invert' },
  { type: 'posterize', name: 'Posterize' },
  { type: 'threshold', name: 'Threshold' },
  { type: 'gradientMap', name: 'Gradient Map' },
  { type: 'selectiveColor', name: 'Selective Color' },
];

const lvl = () => ({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 });
const cmyk = () => ({ c: 0, m: 0, y: 0, k: 0 });

const DEFAULTS = {
  brightnessContrast: { brightness: 0, contrast: 0, legacy: false },
  levels: { channels: { rgb: lvl(), r: lvl(), g: lvl(), b: lvl() } },
  curves: {
    channels: {
      rgb: [[0, 0], [255, 255]],
      r: [[0, 0], [255, 255]],
      g: [[0, 0], [255, 255]],
      b: [[0, 0], [255, 255]],
    },
  },
  exposure: { exposure: 0, offset: 0, gamma: 1 },
  vibrance: { vibrance: 0, saturation: 0 },
  hueSaturation: { hue: 0, saturation: 0, lightness: 0, colorize: false },
  colorBalance: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true },
  blackWhite: { reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintHue: 42, tintSat: 20 },
  photoFilter: { color: '#ec8a00', density: 25, preserveLuminosity: true },
  channelMixer: {
    monochrome: false,
    red: { r: 100, g: 0, b: 0, c: 0 },
    green: { r: 0, g: 100, b: 0, c: 0 },
    blue: { r: 0, g: 0, b: 100, c: 0 },
  },
  invert: {},
  posterize: { levels: 4 },
  threshold: { level: 128 },
  gradientMap: { stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], reverse: false },
  selectiveColor: {
    method: 'relative',
    colors: {
      reds: cmyk(), yellows: cmyk(), greens: cmyk(), cyans: cmyk(), blues: cmyk(),
      magentas: cmyk(), whites: cmyk(), neutrals: cmyk(), blacks: cmyk(),
    },
  },
};

const deepCopy = (o) => JSON.parse(JSON.stringify(o));

export function defaultParams(type) {
  const d = DEFAULTS[type];
  return d ? deepCopy(d) : {};
}

// Merge user params over defaults (objects recursively, arrays/primitives replaced).
function merge(def, p) {
  if (p === undefined || p === null) return deepCopy(def);
  if (Array.isArray(def) || typeof def !== 'object' || def === null) return p;
  if (typeof p !== 'object' || Array.isArray(p)) return deepCopy(def);
  const out = {};
  for (const k of Object.keys(def)) out[k] = merge(def[k], p[k]);
  for (const k of Object.keys(p)) if (!(k in out)) out[k] = p[k];
  return out;
}

// ---------------------------------------------------------------------------
// LUT helpers
// ---------------------------------------------------------------------------

function identityLUT() {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = i;
  return l;
}

function lutFrom(fn) {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = Math.round(clamp255(fn(i)));
  return l;
}

function applyLUTs(data, lr, lg, lb) {
  for (let i = 0, n = data.length; i < n; i += 4) {
    data[i] = lr[data[i]];
    data[i + 1] = lg[data[i + 1]];
    data[i + 2] = lb[data[i + 2]];
  }
}

function compose(outer, inner) {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = outer[inner[i]];
  return l;
}

// Natural cubic spline through the control points (Photoshop's curve dialog
// behaves like a natural spline: smooth, may overshoot slightly, then clamps).
// Before the first / after the last point the curve extends flat.
export function curveLUT(points) {
  let pts = (Array.isArray(points) ? points : [])
    .map((p) => [Number(p[0]), Number(p[1])])
    .filter((p) => isFinite(p[0]) && isFinite(p[1]))
    .map((p) => [clamp(p[0], 0, 255), clamp(p[1], 0, 255)])
    .sort((a, b) => a[0] - b[0]);
  // drop duplicate x (keep last)
  const uniq = [];
  for (const p of pts) {
    if (uniq.length && Math.abs(uniq[uniq.length - 1][0] - p[0]) < 1e-6) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  pts = uniq;
  if (pts.length === 0) return identityLUT();
  if (pts.length === 1) {
    const v = Math.round(pts[0][1]);
    return new Uint8Array(256).fill(v);
  }
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  // second derivatives (natural boundary)
  const y2 = new Float64Array(n);
  const u = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
    const p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    const d = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
    u[i] = ((6 * d) / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
  }
  y2[n - 1] = 0;
  for (let k = n - 2; k >= 0; k--) y2[k] = y2[k] * y2[k + 1] + u[k];
  const lut = new Uint8Array(256);
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    let y;
    if (x <= xs[0]) y = ys[0];
    else if (x >= xs[n - 1]) y = ys[n - 1];
    else {
      while (seg < n - 2 && x > xs[seg + 1]) seg++;
      const h = xs[seg + 1] - xs[seg];
      const a = (xs[seg + 1] - x) / h;
      const b = (x - xs[seg]) / h;
      y = a * ys[seg] + b * ys[seg + 1] + ((a * a * a - a) * y2[seg] + (b * b * b - b) * y2[seg + 1]) * (h * h) / 6;
    }
    lut[x] = Math.round(clamp255(y));
  }
  return lut;
}

export function levelsLUT(ch) {
  const c = merge(lvl(), ch || {});
  const ib = clamp(num(c.inBlack, 0), 0, 255);
  let iw = clamp(num(c.inWhite, 255), 0, 255);
  if (iw <= ib) iw = ib + 1;
  const g = clamp(num(c.gamma, 1), 0.01, 9.99);
  const ob = clamp(num(c.outBlack, 0), 0, 255);
  const ow = clamp(num(c.outWhite, 255), 0, 255);
  const inv = 1 / g;
  return lutFrom((x) => {
    let v = clamp((x - ib) / (iw - ib), 0, 1);
    if (g !== 1) v = Math.pow(v, inv);
    return ob + v * (ow - ob);
  });
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const T = new Float64Array(3);

// HSL in 0..1
function rgb2hsl(r, g, b) {
  const max = r > g ? (r > b ? r : b) : g > b ? g : b;
  const min = r < g ? (r < b ? r : b) : g < b ? g : b;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 1e-9) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  T[0] = h; T[1] = s; T[2] = l;
}

function hue2c(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hsl2rgb(h, s, l) {
  if (s <= 0) { T[0] = T[1] = T[2] = l; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  T[0] = hue2c(p, q, h + 1 / 3);
  T[1] = hue2c(p, q, h);
  T[2] = hue2c(p, q, h - 1 / 3);
}

// W3C/Adobe blend-mode SetLum with ClipColor (values 0..255, writes T)
function setLum(r, g, b, lum) {
  const d = lum - (0.3 * r + 0.59 * g + 0.11 * b);
  r += d; g += d; b += d;
  const l = 0.3 * r + 0.59 * g + 0.11 * b;
  const n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) {
    const k = l / (l - n || 1e-9);
    r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
  }
  if (x > 255) {
    const k = (255 - l) / (x - l || 1e-9);
    r = l + (r - l) * k; g = l + (g - l) * k; b = l + (b - l) * k;
  }
  T[0] = r; T[1] = g; T[2] = b;
}

const srgbToLin = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linToSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

// ---------------------------------------------------------------------------
// Individual adjustments
// ---------------------------------------------------------------------------

function brightnessContrastLUT(p) {
  const b = clamp(num(p.brightness, 0), -150, 150);
  const legacy = !!p.legacy;
  const c = clamp(num(p.contrast, 0), legacy ? -100 : -50, 100);
  if (legacy) {
    const f = c >= 0 ? (c >= 100 ? 1e6 : 100 / (100 - c)) : (100 + c) / 100;
    return lutFrom((x) => (x - 127.5) * f + 127.5 + b);
  }
  // Modern: brightness is an endpoint-preserving midtone curve, contrast an
  // endpoint-preserving S-curve (no hard clipping, like PS CS3+).
  const mid = 0.5 + (b / 150) * 0.3;
  const g = Math.log(mid) / Math.log(0.5);
  const k = (c / 100) * 2.5;
  const tk = Math.tanh(k);
  return lutFrom((x) => {
    let v = x / 255;
    if (b !== 0) v = Math.pow(v, g);
    if (c > 0) v = 0.5 + (0.5 * Math.tanh(k * (v - 0.5) * 2)) / tk;
    else if (c < 0) v = 0.5 + (v - 0.5) * (1 + c / 100);
    return v * 255;
  });
}

function levelsAdj(data, p) {
  const ch = p.channels || {};
  const m = levelsLUT(ch.rgb);
  applyLUTs(data, compose(m, levelsLUT(ch.r)), compose(m, levelsLUT(ch.g)), compose(m, levelsLUT(ch.b)));
}

function curvesAdj(data, p) {
  const ch = p.channels || {};
  const m = curveLUT(ch.rgb);
  applyLUTs(data, compose(m, curveLUT(ch.r)), compose(m, curveLUT(ch.g)), compose(m, curveLUT(ch.b)));
}

function exposureLUT(p) {
  const e = clamp(num(p.exposure, 0), -20, 20);
  const o = clamp(num(p.offset, 0), -0.5, 0.5);
  const g = clamp(num(p.gamma, 1), 0.01, 9.99);
  const mul = Math.pow(2, e);
  return lutFrom((x) => {
    let v = srgbToLin(x / 255) * mul + o;
    if (v <= 0) return 0;
    if (g !== 1) v = Math.pow(v, 1 / g);
    return linToSrgb(clamp(v, 0, 1)) * 255;
  });
}

function vibranceAdj(data, p) {
  const V = clamp(num(p.vibrance, 0), -100, 100) / 100;
  const S = clamp(num(p.saturation, 0), -100, 100) / 100;
  if (V === 0 && S === 0) return;
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === min) continue;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = (max - min) / max;
    let f = 1 + (S > 0 ? S * 0.85 : S);
    if (V !== 0) {
      // skin protection: hues around orange (r > g > b)
      let skin = 0;
      if (r >= g && g >= b) {
        const h = (g - b) / (max - min); // 0 = red, 1 = yellow
        skin = h > 0.15 && h < 0.75 ? 1 - Math.abs(h - 0.45) / 0.3 : 0;
        skin = clamp(skin, 0, 1);
      }
      const ns = 1 - sat;
      if (V > 0) f *= 1 + V * 1.6 * ns * ns * (1 - 0.6 * skin);
      else f *= 1 + V * (0.4 + 0.6 * ns);
    }
    if (f < 0) f = 0;
    if (f > 1) {
      // gamut-safe: never clip, scale back so the colour stays in range
      let fmax = f;
      const dr = r - lum, dg = g - lum, db = b - lum;
      if (dr > 0) fmax = Math.min(fmax, (255 - lum) / dr); else if (dr < 0) fmax = Math.min(fmax, lum / -dr);
      if (dg > 0) fmax = Math.min(fmax, (255 - lum) / dg); else if (dg < 0) fmax = Math.min(fmax, lum / -dg);
      if (db > 0) fmax = Math.min(fmax, (255 - lum) / db); else if (db < 0) fmax = Math.min(fmax, lum / -db);
      f = Math.max(1, fmax);
    }
    data[i] = lum + (r - lum) * f;
    data[i + 1] = lum + (g - lum) * f;
    data[i + 2] = lum + (b - lum) * f;
  }
}

function hueSatAdj(data, p) {
  const light = clamp(num(p.lightness, 0), -100, 100) / 100;
  if (p.colorize) {
    const H = ((((num(p.hue, 0) % 360) + 360) % 360) / 360);
    const Sat = clamp(num(p.saturation, 25), 0, 100) / 100;
    for (let i = 0, n = data.length; i < n; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      let L = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
      if (light > 0) L = L + (1 - L) * light;
      else if (light < 0) L = L * (1 + light);
      hsl2rgb(H, Sat, L);
      data[i] = T[0] * 255; data[i + 1] = T[1] * 255; data[i + 2] = T[2] * 255;
    }
    return;
  }
  const hue = clamp(num(p.hue, 0), -180, 180) / 360;
  const sat = clamp(num(p.saturation, 0), -100, 100) / 100;
  if (hue === 0 && sat === 0 && light === 0) return;
  for (let i = 0, n = data.length; i < n; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    if (hue !== 0 && !(r === g && g === b)) {
      rgb2hsl(r / 255, g / 255, b / 255);
      let h = T[0] + hue;
      if (h < 0) h += 1; else if (h >= 1) h -= 1;
      hsl2rgb(h, T[1], T[2]);
      r = T[0] * 255; g = T[1] * 255; b = T[2] * 255;
    }
    if (sat !== 0) {
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const delta = (max - min) / 255;
      if (delta > 1e-6) {
        const value = (max + min) / 255;
        const L = (value / 2) * 255;
        const S = value < 1 ? delta / value : delta / (2 - value);
        if (sat > 0) {
          let a = sat + S >= 1 ? S : 1 - sat;
          a = 1 / a - 1;
          r = r + (r - L) * a; g = g + (g - L) * a; b = b + (b - L) * a;
        } else {
          r = L + (r - L) * (1 + sat); g = L + (g - L) * (1 + sat); b = L + (b - L) * (1 + sat);
        }
      }
    }
    if (light > 0) {
      r = r + (255 - r) * light; g = g + (255 - g) * light; b = b + (255 - b) * light;
    } else if (light < 0) {
      r *= 1 + light; g *= 1 + light; b *= 1 + light;
    }
    data[i] = r; data[i + 1] = g; data[i + 2] = b;
  }
}

function colorBalanceAdj(data, p) {
  const sh = (p.shadows || [0, 0, 0]).map((v) => clamp(num(v, 0), -100, 100));
  const md = (p.midtones || [0, 0, 0]).map((v) => clamp(num(v, 0), -100, 100));
  const hl = (p.highlights || [0, 0, 0]).map((v) => clamp(num(v, 0), -100, 100));
  if ([...sh, ...md, ...hl].every((v) => v === 0)) return;
  // transfer curves (classic GIMP/PS-like colour balance)
  const hiAdd = new Float64Array(256), shSub = new Float64Array(256), mid = new Float64Array(256);
  const shAdd = new Float64Array(256), hiSub = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const a = 1.075 - 1 / (i / 16 + 1);
    hiAdd[i] = a; shSub[255 - i] = a;
    const m = 0.667 * (1 - ((i - 127) / 127) ** 2);
    mid[i] = m; shAdd[i] = m; hiSub[i] = m;
  }
  const luts = [0, 1, 2].map((c) => lutFrom((x) => {
    let v = x;
    v = clamp255(v + sh[c] * (sh[c] > 0 ? shAdd : shSub)[Math.round(v)]);
    v = clamp255(v + md[c] * mid[Math.round(v)]);
    v = clamp255(v + hl[c] * (hl[c] > 0 ? hiAdd : hiSub)[Math.round(v)]);
    return v;
  }));
  const preserve = p.preserveLuminosity !== false;
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let nr = luts[0][r], ng = luts[1][g], nb = luts[2][b];
    if (preserve) {
      const L0 = (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
      rgb2hsl(nr / 255, ng / 255, nb / 255);
      hsl2rgb(T[0], T[1], L0);
      nr = T[0] * 255; ng = T[1] * 255; nb = T[2] * 255;
    }
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
}

function blackWhiteAdj(data, p) {
  const w = {
    r: clamp(num(p.reds, 40), -200, 300) / 100,
    y: clamp(num(p.yellows, 60), -200, 300) / 100,
    g: clamp(num(p.greens, 40), -200, 300) / 100,
    c: clamp(num(p.cyans, 60), -200, 300) / 100,
    b: clamp(num(p.blues, 20), -200, 300) / 100,
    m: clamp(num(p.magentas, 80), -200, 300) / 100,
  };
  const tint = !!p.tint;
  const th = ((((num(p.tintHue, 42) % 360) + 360) % 360) / 360);
  const ts = clamp(num(p.tintSat, 20), 0, 100) / 100;
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let gray;
    // primary = max channel, secondary = mix of max and mid
    if (r >= g && r >= b) {
      if (g >= b) gray = b + (g - b) * w.y + (r - g) * w.r; // red-yellow
      else gray = g + (b - g) * w.m + (r - b) * w.r; // red-magenta
    } else if (g >= r && g >= b) {
      if (r >= b) gray = b + (r - b) * w.y + (g - r) * w.g; // green-yellow
      else gray = r + (b - r) * w.c + (g - b) * w.g; // green-cyan
    } else {
      if (g >= r) gray = r + (g - r) * w.c + (b - g) * w.b; // blue-cyan
      else gray = g + (r - g) * w.m + (b - r) * w.b; // blue-magenta
    }
    gray = clamp255(gray);
    if (tint) {
      hsl2rgb(th, ts, gray / 255);
      data[i] = T[0] * 255; data[i + 1] = T[1] * 255; data[i + 2] = T[2] * 255;
    } else {
      data[i] = data[i + 1] = data[i + 2] = gray;
    }
  }
}

function photoFilterAdj(data, p) {
  const [fr, fg, fb] = hexToRgb(p.color);
  const d = clamp(num(p.density, 25), 0, 100) / 100;
  if (d === 0) return;
  const mr = 1 - d + d * (fr / 255), mg = 1 - d + d * (fg / 255), mb = 1 - d + d * (fb / 255);
  const preserve = p.preserveLuminosity !== false;
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let nr = r * mr, ng = g * mg, nb = b * mb;
    if (preserve) {
      setLum(nr, ng, nb, 0.3 * r + 0.59 * g + 0.11 * b);
      nr = T[0]; ng = T[1]; nb = T[2];
    }
    data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
  }
}

function channelMixerAdj(data, p) {
  const get = (o, d) => ({
    r: clamp(num(o && o.r, d.r), -200, 200) / 100,
    g: clamp(num(o && o.g, d.g), -200, 200) / 100,
    b: clamp(num(o && o.b, d.b), -200, 200) / 100,
    c: (clamp(num(o && o.c, d.c), -200, 200) / 100) * 255,
  });
  const R = get(p.red, { r: 1e2, g: 0, b: 0, c: 0 });
  if (p.monochrome) {
    const M = p.gray ? get(p.gray, { r: 40, g: 40, b: 20, c: 0 }) : R;
    for (let i = 0, n = data.length; i < n; i += 4) {
      const v = data[i] * M.r + data[i + 1] * M.g + data[i + 2] * M.b + M.c;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    return;
  }
  const G = get(p.green, { r: 0, g: 100, b: 0, c: 0 });
  const B = get(p.blue, { r: 0, g: 0, b: 100, c: 0 });
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i] = r * R.r + g * R.g + b * R.b + R.c;
    data[i + 1] = r * G.r + g * G.g + b * G.b + G.c;
    data[i + 2] = r * B.r + g * B.g + b * B.b + B.c;
  }
}

function posterizeLUT(p) {
  const n = Math.round(clamp(num(p.levels, 4), 2, 255));
  return lutFrom((x) => Math.round((Math.min(n - 1, Math.floor((x * n) / 256)) * 255) / (n - 1)));
}

function thresholdAdj(data, p) {
  const t = clamp(num(p.level, 128), 1, 255);
  for (let i = 0, n = data.length; i < n; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = l >= t - 0.5 ? 255 : 0;
  }
}

export function gradientLUT(stops, reverse) {
  let s = (Array.isArray(stops) && stops.length ? stops : DEFAULTS.gradientMap.stops)
    .map((o) => ({ pos: clamp(num(o.pos, 0), 0, 1), rgb: hexToRgb(o.color) }))
    .sort((a, b) => a.pos - b.pos);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    let t = i / 255;
    if (reverse) t = 1 - t;
    let c;
    if (t <= s[0].pos) c = s[0].rgb;
    else if (t >= s[s.length - 1].pos) c = s[s.length - 1].rgb;
    else {
      let k = 0;
      while (k < s.length - 2 && t > s[k + 1].pos) k++;
      const a = s[k], b = s[k + 1];
      const f = b.pos > a.pos ? (t - a.pos) / (b.pos - a.pos) : 0;
      c = [0, 1, 2].map((j) => a.rgb[j] + (b.rgb[j] - a.rgb[j]) * f);
    }
    lut[i * 3] = Math.round(c[0]); lut[i * 3 + 1] = Math.round(c[1]); lut[i * 3 + 2] = Math.round(c[2]);
  }
  return lut;
}

function gradientMapAdj(data, p) {
  const lut = gradientLUT(p.stops, !!p.reverse);
  for (let i = 0, n = data.length; i < n; i += 4) {
    const l = Math.round(0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2]) * 3;
    data[i] = lut[l]; data[i + 1] = lut[l + 1]; data[i + 2] = lut[l + 2];
  }
}

const SC_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];

function selectiveColorAdj(data, p) {
  const rel = p.method !== 'absolute';
  const cols = p.colors || {};
  // per range: [c,m,y,k] in -1..1
  const A = SC_RANGES.map((k) => {
    const o = cols[k] || {};
    return [o.c, o.m, o.y, o.k].map((v) => clamp(num(v, 0), -100, 100) / 100);
  });
  const active = A.map((a) => a.some((v) => v !== 0));
  if (!active.some(Boolean)) return;
  const adj = (v, c, k) => ((-1 - c) * k - c) * (rel ? 1 - v : 1);
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const mid = r + g + b - max - min;
    let dr = 0, dg = 0, db = 0;
    const add = (ri, w) => {
      if (w <= 0 || !active[ri]) return;
      const a = A[ri];
      dr += w * adj(r, a[0], a[3]);
      dg += w * adj(g, a[1], a[3]);
      db += w * adj(b, a[2], a[3]);
    };
    if (max > mid) {
      const ri = max === r ? 0 : max === g ? 2 : 4; // reds, greens, blues
      add(ri, max - mid);
    }
    if (mid > min) {
      const ri = min === b ? 1 : min === r ? 3 : 5; // yellows, cyans, magentas
      add(ri, mid - min);
    }
    if (min > 0.5) add(6, (min - 0.5) * 2);
    add(7, 1 - (Math.abs(max - 0.5) + Math.abs(min - 0.5)));
    if (max < 0.5) add(8, (0.5 - max) * 2);
    data[i] = (r + dr) * 255;
    data[i + 1] = (g + dg) * 255;
    data[i + 2] = (b + db) * 255;
  }
}

// ---------------------------------------------------------------------------
// Public dispatcher
// ---------------------------------------------------------------------------

export function applyAdjustment(data, type, params) {
  const def = DEFAULTS[type];
  if (!def) throw new Error('Unknown adjustment type: ' + type);
  const p = merge(def, params || {});
  switch (type) {
    case 'brightnessContrast': {
      if (p.brightness === 0 && p.contrast === 0) return data;
      const l = brightnessContrastLUT(p);
      applyLUTs(data, l, l, l);
      break;
    }
    case 'levels': levelsAdj(data, p); break;
    case 'curves': curvesAdj(data, p); break;
    case 'exposure': {
      if (p.exposure === 0 && p.offset === 0 && p.gamma === 1) return data;
      const l = exposureLUT(p);
      applyLUTs(data, l, l, l);
      break;
    }
    case 'vibrance': vibranceAdj(data, p); break;
    case 'hueSaturation': hueSatAdj(data, p); break;
    case 'colorBalance': colorBalanceAdj(data, p); break;
    case 'blackWhite': blackWhiteAdj(data, p); break;
    case 'photoFilter': photoFilterAdj(data, p); break;
    case 'channelMixer': channelMixerAdj(data, p); break;
    case 'invert': {
      const l = lutFrom((x) => 255 - x);
      applyLUTs(data, l, l, l);
      break;
    }
    case 'posterize': {
      const l = posterizeLUT(p);
      applyLUTs(data, l, l, l);
      break;
    }
    case 'threshold': thresholdAdj(data, p); break;
    case 'gradientMap': gradientMapAdj(data, p); break;
    case 'selectiveColor': selectiveColorAdj(data, p); break;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Histogram + destructive auto commands
// ---------------------------------------------------------------------------

export function histogram(data) {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  for (let i = 0, n = data.length; i < n; i += 4) {
    if (data[i + 3] === 0) continue;
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    l[Math.round(0.3 * R + 0.59 * G + 0.11 * B)]++;
  }
  return { r, g, b, l };
}

function clipBounds(h, clipFrac) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += h[i];
  if (total === 0) return [0, 255];
  const clip = total * clipFrac;
  let lo = 0, acc = 0;
  for (; lo < 255; lo++) { acc += h[lo]; if (acc > clip) break; }
  let hi = 255; acc = 0;
  for (; hi > 0; hi--) { acc += h[hi]; if (acc > clip) break; }
  if (hi <= lo) return [0, 255];
  return [lo, hi];
}

const stretchLUT = (lo, hi) => lutFrom((x) => ((x - lo) * 255) / (hi - lo));

export function autoTone(data) {
  const h = histogram(data);
  const [rl, rh] = clipBounds(h.r, 0.001), [gl, gh] = clipBounds(h.g, 0.001), [bl, bh] = clipBounds(h.b, 0.001);
  applyLUTs(data, stretchLUT(rl, rh), stretchLUT(gl, gh), stretchLUT(bl, bh));
  return data;
}

export function autoContrast(data) {
  const h = histogram(data);
  const [lo, hi] = clipBounds(h.l, 0.001);
  const l = stretchLUT(lo, hi);
  applyLUTs(data, l, l, l);
  return data;
}

export function autoColor(data) {
  autoTone(data);
  // neutralize midtones: per-channel gamma so the mean midtone colour is gray
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0, n = data.length; i < n; i += 4) {
    if (data[i + 3] === 0) continue;
    const L = 0.3 * data[i] + 0.59 * data[i + 1] + 0.11 * data[i + 2];
    if (L < 64 || L > 192) continue;
    sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; cnt++;
  }
  if (cnt < 16) return data;
  const mr = sr / cnt / 255, mg = sg / cnt / 255, mb = sb / cnt / 255;
  const target = 0.3 * mr + 0.59 * mg + 0.11 * mb;
  const gl = (m) => {
    if (m <= 0.01 || m >= 0.99) return identityLUT();
    let gamma = Math.log(target) / Math.log(m);
    gamma = clamp(gamma, 0.5, 2); // keep it gentle like PS
    return lutFrom((x) => Math.pow(x / 255, gamma) * 255);
  };
  applyLUTs(data, gl(mr), gl(mg), gl(mb));
  return data;
}

export function equalize(data) {
  const h = new Float64Array(256);
  let total = 0;
  for (let i = 0, n = data.length; i < n; i += 4) {
    if (data[i + 3] === 0) continue;
    h[data[i]]++; h[data[i + 1]]++; h[data[i + 2]]++;
    total += 3;
  }
  if (!total) return data;
  let first = 0;
  while (first < 255 && h[first] === 0) first++;
  const cdf0 = h[first];
  const lut = new Uint8Array(256);
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    lut[i] = total === cdf0 ? i : Math.round(clamp(((acc - cdf0) / (total - cdf0)) * 255, 0, 255));
  }
  applyLUTs(data, lut, lut, lut);
  return data;
}

export function desaturate(data) {
  for (let i = 0, n = data.length; i < n; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    data[i] = data[i + 1] = data[i + 2] = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  }
  return data;
}
