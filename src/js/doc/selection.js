// Selection helpers. A selection is a doc-sized canvas: white RGB, alpha = selection amount.
import { createCanvas, ctx2d, cloneCanvas, hexToRgb, clamp } from '../util.js';

export function blankSel(doc) { return createCanvas(doc.width, doc.height); }

export function shapeSel(doc, draw, feather = 0, antiAlias = true) {
  const c = blankSel(doc), g = ctx2d(c);
  g.imageSmoothingEnabled = antiAlias;
  g.fillStyle = '#fff';
  g.beginPath(); draw(g); g.fill();
  if (!antiAlias) hardenAlpha(c);
  return feather > 0 ? featherCanvas(c, feather) : c;
}
export const rectSel = (doc, r, feather, aa) => shapeSel(doc, g => g.rect(r.x, r.y, r.w, r.h), feather, aa);
export const ellipseSel = (doc, r, feather, aa = true) => shapeSel(doc, g => g.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2), feather, aa);
export const polySel = (doc, pts, feather, aa = true) => shapeSel(doc, g => { pts.forEach((p, i) => i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); }, feather, aa);

export function hardenAlpha(c, thr = 128) {
  const g = ctx2d(c), id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= thr ? 255 : 0;
  g.putImageData(id, 0, 0); return c;
}

export function featherCanvas(src, r) {
  if (r <= 0) return src;
  const pad = Math.ceil(r * 3);
  const c = createCanvas(src.width, src.height), g = ctx2d(c);
  g.filter = `blur(${r / 2}px)`; g.drawImage(src, 0, 0); g.filter = 'none';
  return c;
}

// Combine `next` into current selection by mode: new | add | subtract | intersect
export function combineSel(doc, next, mode = 'new') {
  const cur = doc.selection;
  if (mode === 'new' || !cur) {
    if (mode === 'subtract' || mode === 'intersect') return cur ? cloneCanvas(cur) : null;
    return next;
  }
  const c = cloneCanvas(cur), g = ctx2d(c);
  g.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
  g.drawImage(next, 0, 0);
  return c;
}

export function invertSel(doc) {
  const c = blankSel(doc), g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  if (doc.selection) { g.globalCompositeOperation = 'destination-out'; g.drawImage(doc.selection, 0, 0); }
  return c;
}
export function allSel(doc) { const c = blankSel(doc), g = ctx2d(c); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); return c; }

// From an alpha channel Uint8Array (doc-size)
export function selFromMask(doc, m) {
  const c = blankSel(doc), g = ctx2d(c), id = g.createImageData(doc.width, doc.height), d = id.data;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = m[i]; }
  g.putImageData(id, 0, 0); return c;
}
export function selToMask(c) {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data, m = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 3; i < m.length; i++, j += 4) m[i] = d[j];
  return m;
}

// Morphology on selection: expand (r>0) / contract (r<0) — square-ish via separable max/min on alpha
export function morphSel(c, r) {
  const w = c.width, h = c.height, m = selToMask(c), out = new Uint8Array(m.length), tmp = new Uint8Array(m.length);
  const R = Math.abs(Math.round(r)), grow = r > 0;
  const pick = grow ? Math.max : Math.min;
  // horizontal
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = m[y * w + x];
    for (let k = -R; k <= R; k++) { const xx = x + k; if (xx < 0 || xx >= w) { if (!grow) v = 0; continue; } v = pick(v, m[y * w + xx]); }
    tmp[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = tmp[y * w + x];
    for (let k = -R; k <= R; k++) { const yy = y + k; if (yy < 0 || yy >= h) { if (!grow) v = 0; continue; } v = pick(v, tmp[yy * w + x]); }
    out[y * w + x] = v;
  }
  return out;
}
// Faster circular expand/contract using blur+threshold (good for big radii)
export function growSel(doc, r) {
  const src = doc.selection; if (!src) return null;
  const R = Math.abs(r);
  if (R <= 6) return selFromMask(doc, morphSel(src, r));
  const b = createCanvas(doc.width, doc.height), g = ctx2d(b);
  g.filter = `blur(${R / 2}px)`; g.drawImage(src, 0, 0); g.filter = 'none';
  const id = g.getImageData(0, 0, doc.width, doc.height), d = id.data;
  const thr = r > 0 ? 8 : 247;
  for (let i = 3; i < d.length; i += 4) { const a = d[i]; d[i] = r > 0 ? (a > thr ? 255 : clamp(a * 255 / thr, 0, 255)) : (a >= thr ? 255 : 0); }
  g.putImageData(id, 0, 0); return b;
}
export function borderSel(doc, width) {
  const outer = growSel(doc, width / 2), inner = growSel(doc, -width / 2);
  if (!outer) return null;
  const g = ctx2d(outer); g.globalCompositeOperation = 'destination-out'; g.drawImage(inner, 0, 0);
  return outer;
}
export function smoothSel(doc, r) {
  const b = featherCanvas(doc.selection, r * 2);
  return hardenAlpha(b);
}

// ---------- magic wand / color range ----------
export function magicWand(img, w, h, sx, sy, { tolerance = 32, contiguous = true, antiAlias = true } = {}) {
  sx = Math.floor(sx); sy = Math.floor(sy);
  const out = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return out;
  const d = img.data, o = (sy * w + sx) * 4;
  const r0 = d[o], g0 = d[o + 1], b0 = d[o + 2], a0 = d[o + 3];
  const tol = tolerance;
  const match = (i) => { const j = i * 4; return Math.abs(d[j] - r0) <= tol && Math.abs(d[j + 1] - g0) <= tol && Math.abs(d[j + 2] - b0) <= tol && Math.abs(d[j + 3] - a0) <= tol; };
  if (!contiguous) { for (let i = 0; i < w * h; i++) if (match(i)) out[i] = 255; }
  else {
    const stack = new Int32Array(w * h); let sp = 0; stack[sp++] = sy * w + sx; out[sy * w + sx] = 255;
    while (sp) {
      const i = stack[--sp], x = i % w, y = (i - x) / w;
      if (x > 0 && !out[i - 1] && match(i - 1)) { out[i - 1] = 255; stack[sp++] = i - 1; }
      if (x < w - 1 && !out[i + 1] && match(i + 1)) { out[i + 1] = 255; stack[sp++] = i + 1; }
      if (y > 0 && !out[i - w] && match(i - w)) { out[i - w] = 255; stack[sp++] = i - w; }
      if (y < h - 1 && !out[i + w] && match(i + w)) { out[i + w] = 255; stack[sp++] = i + w; }
    }
  }
  if (antiAlias) {
    // soften the edge by one pixel
    const s = new Uint8Array(out);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (out[i]) continue;
      const n = (out[i - 1] + out[i + 1] + out[i - w] + out[i + w]) / 4;
      if (n) s[i] = n * 0.5;
    }
    return s;
  }
  return out;
}

export function colorRange(img, w, h, hex, fuzziness = 40, invert = false) {
  const { r, g, b } = hexToRgb(hex), d = img.data, out = new Uint8Array(w * h);
  const f = Math.max(1, fuzziness) * 1.8;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const dist = Math.sqrt((d[j] - r) ** 2 + (d[j + 1] - g) ** 2 + (d[j + 2] - b) ** 2);
    let v = clamp(1 - (dist - f * 0.5) / f, 0, 1) * 255;
    out[i] = invert ? 255 - v : v;
  }
  return out;
}

// ---------- marching ants: boundary segments as Path2D in doc coords ----------
export function antsPath(c) {
  const w = c.width, h = c.height;
  const d = ctx2d(c).getImageData(0, 0, w, h).data;
  const ins = (x, y) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] >= 128;
  const p = new Path2D();
  let count = 0;
  for (let y = 0; y <= h; y++) {
    let run = -1, kind = 0;
    for (let x = 0; x <= w; x++) {
      const a = x < w ? ins(x, y - 1) : false, b = x < w ? ins(x, y) : false;
      const edge = x < w && a !== b ? 1 : 0;
      if (edge && run < 0) run = x;
      if (!edge && run >= 0) { p.moveTo(run, y); p.lineTo(x, y); run = -1; count++; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let run = -1;
    for (let y = 0; y <= h; y++) {
      const a = y < h ? ins(x - 1, y) : false, b = y < h ? ins(x, y) : false;
      const edge = y < h && a !== b;
      if (edge && run < 0) run = y;
      if (!edge && run >= 0) { p.moveTo(x, run); p.lineTo(x, y); run = -1; count++; }
    }
  }
  return { path: p, count };
}
