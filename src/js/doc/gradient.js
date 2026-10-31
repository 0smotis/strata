// Gradient rendering shared by the Gradient tool, gradient fill layers and Gradient Map UI.
import { hexToRgb, clamp } from '../util.js';

export const GRADIENT_PRESETS = [
  { name: 'Foreground to Background', stops: 'fgbg' },
  { name: 'Foreground to Transparent', stops: 'fgtrans' },
  { name: 'Black, White', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] },
  { name: 'Spectrum', stops: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'].map((c, i, a) => ({ pos: i / (a.length - 1), color: c })) },
  { name: 'Sunset', stops: [{ pos: 0, color: '#2b1055' }, { pos: 0.5, color: '#d53369' }, { pos: 1, color: '#ffcc70' }] },
  { name: 'Ocean', stops: [{ pos: 0, color: '#0f2027' }, { pos: 0.5, color: '#2c5364' }, { pos: 1, color: '#7fdbda' }] },
  { name: 'Copper', stops: [{ pos: 0, color: '#3b1f0f' }, { pos: 0.45, color: '#b87333' }, { pos: 0.7, color: '#f3c19b' }, { pos: 1, color: '#6b3b1d' }] },
  { name: 'Chrome', stops: [{ pos: 0, color: '#2f2f2f' }, { pos: 0.35, color: '#f5f5f5' }, { pos: 0.5, color: '#5a5a5a' }, { pos: 0.65, color: '#dcdcdc' }, { pos: 1, color: '#3a3a3a' }] },
];

// Resolve stops → [{pos, r,g,b,a}]
export function resolveStops(stops, fg, bg) {
  if (stops === 'fgbg') stops = [{ pos: 0, color: fg }, { pos: 1, color: bg }];
  else if (stops === 'fgtrans') stops = [{ pos: 0, color: fg }, { pos: 1, color: fg, alpha: 0 }];
  return [...stops].sort((a, b) => a.pos - b.pos).map(s => ({ pos: s.pos, ...hexToRgb(s.color), a: s.alpha ?? 1 }));
}

export function gradientLUT(stops, reverse = false) {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 0; i < 256; i++) {
    let t = i / 255; if (reverse) t = 1 - t;
    let k = 0; while (k < stops.length - 1 && stops[k + 1].pos < t) k++;
    const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
    const span = b.pos - a.pos, f = span > 0 ? clamp((t - a.pos) / span, 0, 1) : 0;
    const q = t <= stops[0].pos ? 0 : t >= stops[stops.length - 1].pos ? 1 : f;
    const A = t <= stops[0].pos ? stops[0] : a, B = t >= stops[stops.length - 1].pos ? stops[stops.length - 1] : b;
    lut[i * 4] = A.r + (B.r - A.r) * q; lut[i * 4 + 1] = A.g + (B.g - A.g) * q; lut[i * 4 + 2] = A.b + (B.b - A.b) * q; lut[i * 4 + 3] = (A.a + (B.a - A.a) * q) * 255;
  }
  return lut;
}

// Render a gradient into ctx (w×h) from p0 to p1. type: linear|radial|angle|reflected|diamond
export function renderGradient(ctx, w, h, p0, p1, stops, type = 'linear', reverse = false, dither = true) {
  const lut = gradientLUT(stops, reverse);
  const img = ctx.createImageData(w, h), d = img.data;
  const dx = p1.x - p0.x, dy = p1.y - p0.y, L2 = dx * dx + dy * dy || 1, L = Math.sqrt(L2);
  const ang0 = Math.atan2(dy, dx);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - p0.x, py = y + 0.5 - p0.y;
      let t;
      if (type === 'radial') t = Math.sqrt(px * px + py * py) / L;
      else if (type === 'angle') { let a = Math.atan2(py, px) - ang0; a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); t = 1 - a / (2 * Math.PI); }
      else if (type === 'reflected') t = Math.abs((px * dx + py * dy) / L2);
      else if (type === 'diamond') { const u = (px * dx + py * dy) / L2, v = (-px * dy + py * dx) / L2; t = Math.abs(u) + Math.abs(v); }
      else t = (px * dx + py * dy) / L2;
      let k = clamp(t, 0, 1) * 255;
      if (dither) k += (Math.random() - 0.5) * 0.9;
      k = clamp(Math.round(k), 0, 255) * 4;
      const o = (y * w + x) * 4;
      d[o] = lut[k]; d[o + 1] = lut[k + 1]; d[o + 2] = lut[k + 2]; d[o + 3] = lut[k + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function gradientCSS(stops, fg = '#000', bg = '#fff') {
  const s = resolveStops(stops, fg, bg);
  return 'linear-gradient(90deg,' + s.map(x => `rgba(${x.r},${x.g},${x.b},${x.a}) ${x.pos * 100}%`).join(',') + ')';
}
