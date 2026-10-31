// Blend modes: Photoshop names → canvas composite ops, with JS fallbacks for modes canvas lacks.
export const BLEND_MODES = [
  ['normal', 'Normal'], ['dissolve', 'Dissolve'], null,
  ['darken', 'Darken'], ['multiply', 'Multiply'], ['colorBurn', 'Color Burn'], ['linearBurn', 'Linear Burn'], ['darkerColor', 'Darker Color'], null,
  ['lighten', 'Lighten'], ['screen', 'Screen'], ['colorDodge', 'Color Dodge'], ['linearDodge', 'Linear Dodge (Add)'], ['lighterColor', 'Lighter Color'], null,
  ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], ['vividLight', 'Vivid Light'], ['linearLight', 'Linear Light'], ['pinLight', 'Pin Light'], ['hardMix', 'Hard Mix'], null,
  ['difference', 'Difference'], ['exclusion', 'Exclusion'], ['subtract', 'Subtract'], ['divide', 'Divide'], null,
  ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
export const BLEND_NAMES = Object.fromEntries(BLEND_MODES.filter(Boolean));
BLEND_NAMES.passThrough = 'Pass Through';

const NATIVE = {
  normal: 'source-over', darken: 'darken', multiply: 'multiply', colorBurn: 'color-burn', lighten: 'lighten', screen: 'screen',
  colorDodge: 'color-dodge', linearDodge: 'lighter', overlay: 'overlay', softLight: 'soft-light', hardLight: 'hard-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
export const nativeOp = (mode) => NATIVE[mode] || null;

// ag-psd blend mode names ↔ ours
const PSD_MAP = {
  'pass through': 'passThrough', normal: 'normal', dissolve: 'dissolve', darken: 'darken', multiply: 'multiply', 'color burn': 'colorBurn',
  'linear burn': 'linearBurn', 'darker color': 'darkerColor', lighten: 'lighten', screen: 'screen', 'color dodge': 'colorDodge',
  'linear dodge': 'linearDodge', 'lighter color': 'lighterColor', overlay: 'overlay', 'soft light': 'softLight', 'hard light': 'hardLight',
  'vivid light': 'vividLight', 'linear light': 'linearLight', 'pin light': 'pinLight', 'hard mix': 'hardMix', difference: 'difference',
  exclusion: 'exclusion', subtract: 'subtract', divide: 'divide', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};
export const fromPsdBlend = (m) => PSD_MAP[m] || 'normal';
export const toPsdBlend = (m) => Object.keys(PSD_MAP).find(k => PSD_MAP[k] === m) || 'normal';

const sep = {
  linearBurn: (b, s) => Math.max(0, b + s - 1),
  vividLight: (b, s) => s <= 0.5 ? (s === 0 ? 0 : Math.max(0, 1 - (1 - b) / (2 * s))) : (s === 1 ? 1 : Math.min(1, b / (2 * (1 - s)))),
  linearLight: (b, s) => Math.min(1, Math.max(0, b + 2 * s - 1)),
  pinLight: (b, s) => s <= 0.5 ? Math.min(b, 2 * s) : Math.max(b, 2 * s - 1),
  hardMix: (b, s) => (b + s >= 1 ? 1 : 0),
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? 1 : Math.min(1, b / s)),
};
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

// Composite src ImageData over dst ImageData (same size) with a non-native blend mode. opacity 0..1
export function blendPixels(dst, src, mode, opacity = 1) {
  const d = dst.data, s = src.data, n = d.length;
  const f = sep[mode];
  for (let i = 0; i < n; i += 4) {
    let as = s[i + 3] / 255 * opacity;
    if (as <= 0) continue;
    if (mode === 'dissolve') {
      if (Math.random() >= as) continue;
      d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255; continue;
    }
    const ab = d[i + 3] / 255;
    const Sr = s[i] / 255, Sg = s[i + 1] / 255, Sb = s[i + 2] / 255;
    const Br = d[i] / 255, Bg = d[i + 1] / 255, Bb = d[i + 2] / 255;
    let r, g, b;
    if (f) { r = f(Br, Sr); g = f(Bg, Sg); b = f(Bb, Sb); }
    else if (mode === 'darkerColor') { if (lum(Sr, Sg, Sb) < lum(Br, Bg, Bb)) { r = Sr; g = Sg; b = Sb; } else { r = Br; g = Bg; b = Bb; } }
    else if (mode === 'lighterColor') { if (lum(Sr, Sg, Sb) > lum(Br, Bg, Bb)) { r = Sr; g = Sg; b = Sb; } else { r = Br; g = Bg; b = Bb; } }
    else { r = Sr; g = Sg; b = Sb; }
    // mix with source by backdrop alpha (W3C compositing)
    r = (1 - ab) * Sr + ab * r; g = (1 - ab) * Sg + ab * g; b = (1 - ab) * Sb + ab * b;
    const ao = as + ab * (1 - as);
    d[i] = ((r * as + Br * ab * (1 - as)) / ao) * 255;
    d[i + 1] = ((g * as + Bg * ab * (1 - as)) / ao) * 255;
    d[i + 2] = ((b * as + Bb * ab * (1 - as)) / ao) * 255;
    d[i + 3] = ao * 255;
  }
}
