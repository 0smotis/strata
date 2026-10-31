// Brush engine and painting/retouching tools.
import { app } from '../state.js';
import { createCanvas, ctx2d, cloneCanvas, hexToRgb, clamp, rgbToHex } from '../util.js';
import { registerTool, targetNow, Surface, grayOf, opt } from './base.js';
import { toast, withBusy } from '../ui/common.js';
import { requestDraw } from '../view/viewport.js';
import { retouch } from '../engine/client.js';
import { magicWand } from '../doc/selection.js';

// ---------- brush tips ----------
const tipCache = new Map();
export function brushTip(size, hardness = 1, color = '#000000', { aliased = false, roundness = 100, angle = 0 } = {}) {
  size = Math.max(1, size);
  const key = [Math.round(size * 4) / 4, hardness.toFixed(2), color, aliased, roundness, angle].join('|');
  let t = tipCache.get(key);
  if (t) return t;
  const d = Math.ceil(size) + 2, c = createCanvas(d, d), g = ctx2d(c);
  const { r, g: gg, b } = hexToRgb(color);
  const id = g.createImageData(d, d), px = id.data, R = size / 2, cx = d / 2, cy = d / 2;
  const ry = roundness / 100, ca = Math.cos(-angle * Math.PI / 180), sa = Math.sin(-angle * Math.PI / 180);
  const h = clamp(hardness, 0, 1);
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    let dx = x + 0.5 - cx, dy = y + 0.5 - cy;
    const rx = dx * ca - dy * sa, ryy = (dx * sa + dy * ca) / Math.max(0.01, ry);
    const dist = Math.sqrt(rx * rx + ryy * ryy) / R;
    let a;
    if (aliased) a = dist <= 1 ? 1 : 0;
    else if (dist <= h) a = 1;
    else if (dist >= 1) a = Math.max(0, 1 - (dist - 1) * R); // 1px AA edge
    else { const tt = (dist - h) / (1 - h); a = 0.5 * (1 + Math.cos(Math.PI * tt)); }
    if (!aliased && h >= 0.999 && dist > 1 - 1 / R && dist < 1) a = Math.min(a, (1 - dist) * R + 0.5);
    const o = (y * d + x) * 4; px[o] = r; px[o + 1] = gg; px[o + 2] = b; px[o + 3] = clamp(a, 0, 1) * 255;
  }
  g.putImageData(id, 0, 0);
  t = { canvas: c, d };
  if (tipCache.size > 64) tipCache.delete(tipCache.keys().next().value);
  tipCache.set(key, t);
  return t;
}

function jitterColor(fg, bg, dyn) {
  const A = hexToRgb(fg), B = hexToRgb(bg), R = Math.random;
  let t = R() * (dyn.fgbgJitter || 0) / 100;
  let r = A.r + (B.r - A.r) * t, g = A.g + (B.g - A.g) * t, b = A.b + (B.b - A.b) * t;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  // hue / saturation / brightness jitter in HSV
  let h = 0, sat = mx ? (mx - mn) / mx : 0, v = mx / 255;
  if (mx !== mn) { if (mx === r) h = ((g - b) / (mx - mn)) % 6; else if (mx === g) h = (b - r) / (mx - mn) + 2; else h = (r - g) / (mx - mn) + 4; h *= 60; }
  h += (R() * 2 - 1) * (dyn.hueJitter || 0) / 100 * 180; sat = clamp(sat + (R() * 2 - 1) * (dyn.satJitter || 0) / 100, 0, 1); v = clamp(v + (R() * 2 - 1) * (dyn.brightJitter || 0) / 100, 0, 1);
  h = ((h % 360) + 360) % 360; const c = v * sat, xx = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const [rr, gg, bb] = h < 60 ? [c, xx, 0] : h < 120 ? [xx, c, 0] : h < 180 ? [0, c, xx] : h < 240 ? [0, xx, c] : h < 300 ? [xx, 0, c] : [c, 0, xx];
  return rgbToHex((rr + m) * 255, (gg + m) * 255, (bb + m) * 255);
}
// ---------- stroke path helper (spacing, smoothing, pressure) ----------
class StrokePath {
  constructor(o, onDab) { this.o = o; this.onDab = onDab; this.last = null; this.acc = 0; this.sm = null; }
  begin(p) { this.sm = { ...p }; this.last = { ...p }; this.acc = 0; this.onDab(p, 0); }
  to(p) {
    const s = clamp((this.o.smoothing || 0) / 100, 0, 0.95);
    if (s > 0) { this.sm.x += (p.x - this.sm.x) * (1 - s); this.sm.y += (p.y - this.sm.y) * (1 - s); this.sm.pressure = p.pressure; p = { ...this.sm }; }
    const a = this.last, dx = p.x - a.x, dy = p.y - a.y, dist = Math.hypot(dx, dy);
    const size = Math.max(1, this.o.size * (this.o.pressureSize ? (p.pressure ?? 1) : 1));
    const step = Math.max(0.5, size * (this.o.spacing ?? 25) / 100);
    let t = step - this.acc;
    if (dist < t) { this.acc += dist; this.last = p; return; }
    while (t <= dist) {
      const f = t / dist;
      this.onDab({ x: a.x + dx * f, y: a.y + dy * f, pressure: (a.pressure ?? 1) + ((p.pressure ?? 1) - (a.pressure ?? 1)) * f }, Math.atan2(dy, dx));
      t += step;
    }
    this.acc = dist - (t - step);
    this.last = p;
  }
}

// ---------- compose scheduler ----------
let composeFn = null;
function scheduleCompose(fn) { composeFn = fn; }
(function loop() { requestAnimationFrame(loop); if (composeFn) { const f = composeFn; composeFn = null; f(); } })();

// ---------- generic buffered stroke ----------
// mode: 'paint' | 'erase' | 'clone'
function bufferedStroke(tool, i, { colorFn, sourceFn, onCommit, name, icon, erase = false, aliased = false, oOverride = null }) {
  const doc = app.doc, o = { ...opt(tool.id), ...(oOverride || {}) };
  const target = targetNow(doc, { toolName: tool.label.toLowerCase() });
  if (!target) return null;
  const surf = new Surface(doc, target);
  const base = cloneCanvas(surf.orig);
  const S = createCanvas(surf.canvas.width, surf.canvas.height), sg = ctx2d(S);
  const isBg = target.kind === 'layer' && target.layer.locks.background;
  const lockT = target.kind === 'layer' && (target.layer.locks.transparency || (erase && isBg));
  let bounds = null;
  const color = colorFn ? colorFn(surf) : '#000000';
  const stroke = {
    surf, S, base, o, target,
    dab(p, ang) {
      const dyn = o.dynamics || null;
      const count = dyn && dyn.scatterOn ? Math.max(1, Math.round((dyn.count || 1) * (1 - Math.random() * (dyn.countJitter || 0) / 100))) : 1;
      for (let ci = 0; ci < count; ci++) stroke.dab1(p, ang, dyn);
    },
    dab1(p, ang, dyn) {
      const pr = p.pressure ?? 1;
      const R = Math.random;
      let size = Math.max(1, o.size * (o.pressureSize ? pr : 1));
      let flow = (o.flow ?? 100) / 100 * (o.pressureOpacity ? pr : 1);
      let angle = o.angle ?? 0, round = o.roundness ?? 100, dcol = color, px = p.x, py = p.y;
      if (dyn) {
        if (dyn.shapeOn) {
          size *= 1 - R() * (dyn.sizeJitter || 0) / 100 * (1 - (dyn.minDiameter || 0) / 100); size = Math.max(1, size);
          angle += (R() * 2 - 1) * (dyn.angleJitter || 0) / 100 * 180; if (dyn.angleFollow) angle += ang * 180 / Math.PI;
          round = Math.max(Math.max(1, dyn.minRoundness || 25), round * (1 - R() * (dyn.roundnessJitter || 0) / 100));
        }
        if (dyn.scatterOn && dyn.scatter) { const sc = o.size * dyn.scatter / 100; const perp = ang + Math.PI / 2; const off = (R() * 2 - 1) * sc; px += Math.cos(perp) * off; py += Math.sin(perp) * off; if (dyn.bothAxes) { const off2 = (R() * 2 - 1) * sc; px += Math.cos(ang) * off2; py += Math.sin(ang) * off2; } }
        if (dyn.transferOn) flow *= 1 - R() * (dyn.flowJitter || 0) / 100;
        if (dyn.colorOn && !sourceFn) dcol = jitterColor(color, app.bg, dyn);
      }
      const x = px - surf.ox, y = py - surf.oy;
      let tip = brushTip(size, o.hardness ?? 1, sourceFn ? '#ffffff' : (dcol === color ? color : '#ffffff'), { aliased: aliased || o.aliased, roundness: Math.round(round), angle: Math.round(angle) });
      if (dcol !== color) { const t2 = createCanvas(tip.d, tip.d), tg = ctx2d(t2); tg.drawImage(tip.canvas, 0, 0); tg.globalCompositeOperation = 'source-in'; tg.fillStyle = dcol; tg.fillRect(0, 0, tip.d, tip.d); tip = { canvas: t2, d: tip.d }; }
      if (dyn && dyn.transferOn && dyn.opacityJitter) flow *= 1 - R() * dyn.opacityJitter / 100;
      const ax = aliased ? Math.round(x - tip.d / 2) : x - tip.d / 2, ay = aliased ? Math.round(y - tip.d / 2) : y - tip.d / 2;
      if (sourceFn) {
        const dab = createCanvas(tip.d, tip.d), dg = ctx2d(dab);
        sourceFn(dg, ax + surf.ox, ay + surf.oy, tip.d, p);
        dg.globalCompositeOperation = 'destination-in'; dg.drawImage(tip.canvas, 0, 0);
        sg.globalAlpha = flow; sg.drawImage(dab, ax, ay); sg.globalAlpha = 1;
      } else { sg.globalAlpha = flow; sg.drawImage(tip.canvas, ax, ay); sg.globalAlpha = 1; }
      const r = { x: Math.floor(ax), y: Math.floor(ay), w: tip.d + 1, h: tip.d + 1 };
      bounds = bounds ? { x: Math.min(bounds.x, r.x), y: Math.min(bounds.y, r.y), w: Math.max(bounds.x + bounds.w, r.x + r.w) - Math.min(bounds.x, r.x), h: Math.max(bounds.y + bounds.h, r.y + r.h) - Math.min(bounds.y, r.y) } : r;
      scheduleCompose(stroke.compose);
    },
    compose() {
      const g = ctx2d(surf.canvas);
      g.globalCompositeOperation = 'copy'; g.globalAlpha = 1; g.drawImage(base, 0, 0); g.globalCompositeOperation = 'source-over';
      let src = S;
      const sel = surf.selMask();
      if (sel) { src = createCanvas(S.width, S.height); const tg = ctx2d(src); tg.drawImage(S, 0, 0); tg.globalCompositeOperation = 'destination-in'; tg.drawImage(sel, 0, 0); }
      const op = (o.opacity ?? 100) / 100;
      if (surf.isMaskLike) {
        const gv = erase ? grayOf(app.bg) : grayOf(color);
        g.globalAlpha = op; g.globalCompositeOperation = 'destination-out'; g.drawImage(src, 0, 0);
        if (gv > 0) { // add white with alpha gv
          const w = createCanvas(S.width, S.height), wg = ctx2d(w); wg.drawImage(src, 0, 0); wg.globalCompositeOperation = 'source-in'; wg.fillStyle = '#fff'; wg.fillRect(0, 0, w.width, w.height);
          g.globalAlpha = op * gv; g.globalCompositeOperation = 'lighter'; g.drawImage(w, 0, 0);
        }
      } else if (erase) {
        if (isBg || target.layer.locks.transparency) {
          const w = createCanvas(S.width, S.height), wg = ctx2d(w); wg.drawImage(src, 0, 0); wg.globalCompositeOperation = 'source-in'; wg.fillStyle = app.bg; wg.fillRect(0, 0, w.width, w.height);
          g.globalAlpha = op; g.globalCompositeOperation = 'source-atop'; g.drawImage(w, 0, 0);
        } else { g.globalAlpha = op; g.globalCompositeOperation = 'destination-out'; g.drawImage(src, 0, 0); }
      } else {
        const modes = { normal: 'source-over', behind: 'destination-over', clear: 'destination-out', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', colorDodge: 'color-dodge', colorBurn: 'color-burn', hardLight: 'hard-light', softLight: 'soft-light', difference: 'difference', exclusion: 'exclusion', hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity', linearDodge: 'lighter' };
        let m = modes[o.mode || 'normal'] || 'source-over';
        if (lockT && m !== 'destination-out') {
          // keep original alpha: paint into a copy with source-atop semantics
          if (m === 'source-over') m = 'source-atop';
          else { const w = cloneCanvas(base), wg = ctx2d(w); wg.globalAlpha = op; wg.globalCompositeOperation = m; wg.drawImage(src, 0, 0); wg.globalCompositeOperation = 'destination-in'; wg.globalAlpha = 1; wg.drawImage(base, 0, 0); g.globalCompositeOperation = 'copy'; g.drawImage(w, 0, 0); g.globalCompositeOperation = 'source-over'; surf.changed(); return; }
        }
        g.globalAlpha = op; g.globalCompositeOperation = m; g.drawImage(src, 0, 0);
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      surf.changed();
    },
    async end() {
      composeFn = null; stroke.compose();
      if (onCommit) { try { await onCommit(stroke, bounds); } catch (e) { console.error(e); toast(e.message || String(e), 'err'); surf.cancel(); return; } }
      surf.commit(name || tool.label, icon || tool.icon);
    },
    get bounds() { return bounds; },
  };
  return stroke;
}

function strokeTool(def) {
  const t = {
    brushCursor() { const o = opt(t.id); return { size: o.size, hardness: o.hardness, crosshair: def.crosshair }; },
    lastPt: null,
    down(i) {
      if (def.altDown && i.alt) { def.altDown(i); return; }
      if (i.alt && def.altPick !== false && !def.altDown) { pickColor(i, false); t._picking = true; return; }
      t._picking = false;
      if (def.canStart && !def.canStart(i)) { t.stroke = null; return; }
      t.stroke = def.begin(t, i);
      if (!t.stroke) return;
      const o = opt(t.id);
      t.path = new StrokePath(o, (p, a) => t.stroke.dab(p, a));
      if (i.shift && t.lastPt) { t.path.begin(t.lastPt); t.path.to({ x: i.x, y: i.y, pressure: i.pressure }); }
      else t.path.begin({ x: i.x, y: i.y, pressure: i.pressure });
      if (o.airbrush) t._air = setInterval(() => { if (t.path && t.path.last) t.stroke.dab(t.path.last, 0); }, 60);
    },
    move(i) { if (t._picking) { pickColor(i, false); return; } if (!t.stroke) return; t.path.to({ x: i.x, y: i.y, pressure: i.pressure }); },
    async up(i) {
      clearInterval(t._air);
      if (t._picking) { t._picking = false; return; }
      if (!t.stroke) return;
      t.lastPt = { x: i.x, y: i.y, pressure: 1 };
      const s = t.stroke; t.stroke = null; t.path = null;
      await s.end();
    },
    ...def,
  };
  return t;
}

// ---------- eyedropper helper ----------
export function sampleColor(x, y, size = 1, layerOnly = false) {
  const d = app.doc;
  const src = layerOnly && d.active && d.active.canvas ? d.active : null;
  const c = src ? src.canvas : d.render();
  const ox = src ? src.x : 0, oy = src ? src.y : 0;
  const r = Math.floor((size - 1) / 2);
  const x0 = Math.floor(x) - ox - r, y0 = Math.floor(y) - oy - r, w = r * 2 + 1;
  if (x0 + w <= 0 || y0 + w <= 0 || x0 >= c.width || y0 >= c.height) return null;
  const id = ctx2d(c).getImageData(x0, y0, w, w).data;
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < id.length; i += 4) { const a = id[i + 3]; R += id[i] * a; G += id[i + 1] * a; B += id[i + 2] * a; A += a; }
  if (!A) return null;
  return rgbToHex(R / A, G / A, B / A);
}
export function pickColor(i, toBg) {
  const o = app.opts.eyedropper || {};
  const hex = sampleColor(i.x, i.y, o.sampleSize || 1, o.sample === 'current');
  if (!hex) return;
  if (toBg) app.bg = hex; else app.fg = hex;
  app.emit('colors');
}

const brushOpts = { size: 30, hardness: 0, opacity: 100, flow: 100, mode: 'normal', smoothing: 10, spacing: 25, pressureSize: true, pressureOpacity: false, airbrush: false, roundness: 100, angle: 0 };

// ---------- Brush / Pencil / Eraser ----------
registerTool(strokeTool({
  id: 'brush', label: 'Brush Tool', icon: 'brush', key: 'B', group: 'brush', defaults: { ...brushOpts },
  begin(t, i) { return bufferedStroke(t, i, { colorFn: () => app.fg, name: 'Brush Tool' }); },
}));
registerTool(strokeTool({
  id: 'pencil', label: 'Pencil Tool', icon: 'pencil', key: 'B', group: 'brush', defaults: { ...brushOpts, size: 1, hardness: 1, smoothing: 0, spacing: 10, autoErase: false, pressureSize: false },
  begin(t, i) {
    let color = app.fg;
    if (opt('pencil').autoErase) { const c = sampleColor(i.x, i.y, 1, true); if (c && c.toLowerCase() === app.fg.toLowerCase()) color = app.bg; }
    return bufferedStroke(t, i, { colorFn: () => color, aliased: true, name: 'Pencil' });
  },
}));
registerTool(strokeTool({
  id: 'eraser', label: 'Eraser Tool', icon: 'eraser', key: 'E', group: 'eraser', defaults: { ...brushOpts, hardness: 1 },
  begin(t, i) { return bufferedStroke(t, i, { colorFn: () => '#000000', erase: true, name: 'Eraser' }); },
}));

// Magic eraser: click to erase similar pixels
registerTool({
  id: 'magicEraser', label: 'Magic Eraser Tool', icon: 'magicEraser', key: 'E', group: 'eraser', cursor: 'crosshair',
  defaults: { tolerance: 32, antiAlias: true, contiguous: true, opacity: 100, sampleAll: false },
  down(i) {
    const doc = app.doc, o = opt('magicEraser');
    const target = targetNow(doc, { allowMask: false, allowSelection: false, toolName: 'magic eraser' }); if (!target) return;
    const L = target.layer;
    if (L.locks.background) { L.locks.background = false; L.locks.position = false; L.name = 'Layer 0'; }
    const surf = new Surface(doc, target);
    const src = o.sampleAll ? doc.render() : surf.canvas;
    const W = src.width, H = src.height, sx = o.sampleAll ? i.x : i.x - surf.ox, sy = o.sampleAll ? i.y : i.y - surf.oy;
    const m = magicWand(ctx2d(src).getImageData(0, 0, W, H), W, H, sx, sy, { tolerance: o.tolerance, contiguous: o.contiguous, antiAlias: o.antiAlias });
    const mc = createCanvas(W, H), mg = ctx2d(mc), id = mg.createImageData(W, H);
    for (let k = 0; k < m.length; k++) id.data[k * 4 + 3] = m[k];
    mg.putImageData(id, 0, 0);
    const g = ctx2d(surf.canvas);
    const sel = surf.selMask(); if (sel) { mg.globalCompositeOperation = 'destination-in'; mg.drawImage(sel, o.sampleAll ? surf.ox : 0, o.sampleAll ? surf.oy : 0); }
    g.globalAlpha = o.opacity / 100; g.globalCompositeOperation = 'destination-out';
    g.drawImage(mc, o.sampleAll ? -surf.ox : 0, o.sampleAll ? -surf.oy : 0);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    surf.commit('Magic Eraser', 'magicEraser');
  },
});

// ---------- Clone Stamp / History Brush ----------
app.cloneSource = null; // {x, y, layerId}
registerTool(strokeTool({
  id: 'clone', label: 'Clone Stamp Tool', icon: 'clone', key: 'S', group: 'clone', crosshair: true,
  defaults: { ...brushOpts, hardness: 0.5, aligned: true, sample: 'current' },
  altDown(i) { app.cloneSource = { x: i.x, y: i.y, set: true }; app.cloneOffset = null; toast('Clone source set', 'ok', 1200); },
  canStart() { if (!app.cloneSource) { toast('Alt-click to define a source point for the Clone Stamp.', 'err'); return false; } return true; },
  begin(t, i) {
    const o = opt('clone'), doc = app.doc;
    if (!o.aligned || !app.cloneOffset || app.cloneSource.set) { app.cloneOffset = { dx: app.cloneSource.x - i.x, dy: app.cloneSource.y - i.y }; app.cloneSource.set = false; }
    const off = app.cloneOffset;
    const target = targetNow(doc, { toolName: 'clone stamp' }); if (!target) return null;
    const srcCanvas = o.sample === 'all' ? doc.render(true) : (target.kind === 'layer' ? cloneCanvas(target.layer.canvas) : null);
    const sox = o.sample === 'all' ? 0 : target.kind === 'layer' ? target.layer.x : 0, soy = o.sample === 'all' ? 0 : target.kind === 'layer' ? target.layer.y : 0;
    const src = srcCanvas || doc.render(true);
    t._srcInfo = { off };
    return bufferedStroke(t, i, {
      sourceFn: (dg, dx0, dy0) => { dg.drawImage(src, -(dx0 + off.dx - sox), -(dy0 + off.dy - soy)); },
      name: 'Clone Stamp',
    });
  },
  overlay(g, v) {
    if (!app.cloneSource || !app.cloneOffset || !this.stroke || !this.path?.last) return;
    const p = this.path.last, s = v.toScreen(p.x + app.cloneOffset.dx, p.y + app.cloneOffset.dy);
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(s.x - 6, s.y); g.lineTo(s.x + 6, s.y); g.moveTo(s.x, s.y - 6); g.lineTo(s.x, s.y + 6); g.stroke();
  },
}));

registerTool(strokeTool({
  id: 'historyBrush', label: 'History Brush Tool', icon: 'historyBrush', key: 'Y', group: 'historyBrush', defaults: { ...brushOpts },
  begin(t, i) {
    const doc = app.doc, target = targetNow(doc, { allowMask: false, allowSelection: false, toolName: 'history brush' }); if (!target) return null;
    const snap = doc.history[clamp(app.historySource ?? 0, 0, doc.history.length - 1)];
    const find = (ls) => { for (const s of ls) { if (s.id === target.layer.id) return s; if (s.children) { const r = find(s.children); if (r) return r; } } return null; };
    const s = find(snap.layers);
    if (!s || !s.bitmap) { toast('Could not use the history brush because the history state does not contain a corresponding layer.', 'err'); return null; }
    const src = doc.bitmapCache.get(s.bitmap), sx = s.x, sy = s.y;
    return bufferedStroke(t, i, { sourceFn: (dg, dx0, dy0) => dg.drawImage(src, sx - dx0, sy - dy0), name: 'History Brush' });
  },
}));

// ---------- Healing brush ----------
function regionData(c, r) { return ctx2d(c).getImageData(r.x, r.y, r.w, r.h); }
function clampRect(r, w, h) { const x = Math.max(0, r.x), y = Math.max(0, r.y); return { x, y, w: Math.max(1, Math.min(w, r.x + r.w) - x), h: Math.max(1, Math.min(h, r.y + r.h) - y) }; }

registerTool(strokeTool({
  id: 'heal', label: 'Healing Brush Tool', icon: 'heal', key: 'J', group: 'heal', crosshair: true,
  defaults: { ...brushOpts, hardness: 1, aligned: true, sample: 'current', diffusion: 5 },
  altDown(i) { app.cloneSource = { x: i.x, y: i.y, set: true }; app.cloneOffset = null; toast('Healing source set', 'ok', 1200); },
  canStart() { if (!app.cloneSource) { toast('Alt-click to define a source point for the Healing Brush.', 'err'); return false; } return true; },
  begin(t, i) {
    const o = opt('heal'), doc = app.doc;
    if (!o.aligned || !app.cloneOffset || app.cloneSource.set) { app.cloneOffset = { dx: app.cloneSource.x - i.x, dy: app.cloneSource.y - i.y }; app.cloneSource.set = false; }
    const off = app.cloneOffset;
    const target = targetNow(doc, { allowMask: false, allowSelection: false, toolName: 'healing brush' }); if (!target) return null;
    const L = target.layer;
    const src = o.sample === 'all' ? doc.render(true) : cloneCanvas(L.canvas), sox = o.sample === 'all' ? 0 : L.x, soy = o.sample === 'all' ? 0 : L.y;
    return bufferedStroke(t, i, {
      sourceFn: (dg, dx0, dy0) => dg.drawImage(src, -(dx0 + off.dx - sox), -(dy0 + off.dy - soy)),
      name: 'Healing Brush',
      onCommit: async (s, b) => {
        if (!b) return;
        const W = s.surf.canvas.width, H = s.surf.canvas.height, r = clampRect({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }, W, H);
        const tgt = regionData(s.base, r), sm = regionData(s.S, r).data;
        const sc = createCanvas(r.w, r.h); ctx2d(sc).drawImage(src, -(r.x + s.surf.ox + off.dx - sox), -(r.y + s.surf.oy + off.dy - soy));
        const srcImg = ctx2d(sc).getImageData(0, 0, r.w, r.h);
        const mask = new Uint8Array(r.w * r.h); for (let k = 0; k < mask.length; k++) mask[k] = sm[k * 4 + 3];
        const res = await retouch('heal', { target: { data: tgt.data, width: r.w, height: r.h }, source: { data: srcImg.data, width: r.w, height: r.h }, mask, opts: { diffusion: o.diffusion } });
        ctx2d(s.surf.canvas).putImageData(new ImageData(new Uint8ClampedArray(res), r.w, r.h), r.x, r.y);
      },
    });
  },
}));

// ---------- Spot healing / Remove tool (mask strokes) ----------
function maskStrokeTool(def) {
  return strokeTool({
    ...def, altPick: false,
    begin(t, i) {
      const doc = app.doc;
      const target = targetNow(doc, { allowMask: false, allowSelection: false, toolName: def.label.toLowerCase() }); if (!target) return null;
      const s = bufferedStroke(t, i, {
        colorFn: () => def.tint, name: def.label.replace(' Tool', ''), icon: def.icon, oOverride: { opacity: def.previewOpacity ?? 50, mode: 'normal' },
        onCommit: async (st, b) => {
          // restore base then fill hole
          const g = ctx2d(st.surf.canvas); g.globalCompositeOperation = 'copy'; g.drawImage(st.base, 0, 0); g.globalCompositeOperation = 'source-over';
          if (!b) return;
          await def.fill(st, b, t);
        },
      });
      return s;
    },
  });
}

async function fillHole(st, b, { sampleAll, mode, ai }) {
  const doc = app.doc, L = st.target.layer, W = st.surf.canvas.width, H = st.surf.canvas.height;
  const size = Math.max(b.w, b.h);
  const pad = Math.max(48, Math.round(size * 1.5));
  const r = clampRect({ x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 }, W, H);
  let srcC = st.base;
  if (sampleAll) { srcC = createCanvas(W, H); ctx2d(srcC).drawImage(st.base, 0, 0); ctx2d(srcC).drawImage(doc.flatten(), -L.x, -L.y); }
  const img = regionData(srcC, r), sm = regionData(st.S, r).data;
  const mask = new Uint8Array(r.w * r.h);
  for (let k = 0; k < mask.length; k++) mask[k] = sm[k * 4 + 3] > 8 ? 255 : 0;
  // slightly dilate the mask so edges are covered
  let res;
  if (ai) res = await ai(img, mask, r);
  else res = await retouch(mode === 'inpaint' ? 'inpaint' : 'spotHeal', { img: { data: img.data, width: r.w, height: r.h }, mask, opts: { mode } });
  const out = new ImageData(new Uint8ClampedArray(res), r.w, r.h);
  // write only hole pixels into the layer (keeps layer transparency elsewhere)
  const cur = regionData(st.surf.canvas, r);
  for (let k = 0; k < mask.length; k++) if (mask[k]) { const j = k * 4; cur.data[j] = out.data[j]; cur.data[j + 1] = out.data[j + 1]; cur.data[j + 2] = out.data[j + 2]; cur.data[j + 3] = Math.max(cur.data[j + 3], out.data[j + 3]); }
  ctx2d(st.surf.canvas).putImageData(cur, r.x, r.y);
}

registerTool(maskStrokeTool({
  id: 'spotHeal', label: 'Spot Healing Brush Tool', icon: 'spotHeal', key: 'J', group: 'heal', tint: '#808080', previewOpacity: 55,
  defaults: { size: 40, hardness: 1, spacing: 15, smoothing: 0, flow: 100, opacity: 100, type: 'content-aware', sampleAll: false, pressureSize: false },
  async fill(st, b) { const o = opt('spotHeal'); await withBusy('Healing…', () => fillHole(st, b, { sampleAll: o.sampleAll, mode: o.type })); },
}));
registerTool(maskStrokeTool({
  id: 'removeTool', label: 'Remove Tool', icon: 'removeTool', key: 'J', group: 'heal', tint: '#e8358a', previewOpacity: 55,
  defaults: { size: 60, hardness: 1, spacing: 15, smoothing: 0, flow: 100, opacity: 100, sampleAll: true, useAI: true, pressureSize: false },
  async fill(st, b) {
    const o = opt('removeTool');
    await withBusy('Removing…', async (prog) => {
      const ai = o.useAI && app.ai ? (img, mask, r) => app.ai.removeObject(img, mask, prog) : null;
      await fillHole(st, b, { sampleAll: o.sampleAll, mode: 'inpaint', ai });
    });
  },
}));

// Red eye: drag/click a box
registerTool({
  id: 'redEye', label: 'Red Eye Tool', icon: 'redEye', key: 'J', group: 'heal', cursor: 'crosshair', defaults: { pupil: 50, darken: 50 },
  down(i) { this.p0 = { x: i.x, y: i.y }; this.p1 = { ...this.p0 }; },
  move(i) { this.p1 = { x: i.x, y: i.y }; },
  up() {
    const doc = app.doc, o = opt('redEye');
    const target = targetNow(doc, { allowMask: false, allowSelection: false, toolName: 'red eye tool' }); if (!target) { this.p0 = null; return; }
    let { p0, p1 } = this; this.p0 = null;
    let r = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) };
    if (r.w < 4) r = { x: p0.x - 25, y: p0.y - 25, w: 50, h: 50 };
    const surf = new Surface(doc, target), W = surf.canvas.width, H = surf.canvas.height;
    const rr = clampRect({ x: Math.round(r.x - surf.ox), y: Math.round(r.y - surf.oy), w: Math.round(r.w), h: Math.round(r.h) }, W, H);
    const id = regionData(surf.canvas, rr), d = id.data, cx = rr.w / 2, cy = rr.h / 2, rad = Math.max(cx, cy) * (0.5 + o.pupil / 200);
    let n = 0;
    for (let y = 0; y < rr.h; y++) for (let x = 0; x < rr.w; x++) {
      const k = (y * rr.w + x) * 4, R = d[k], G = d[k + 1], B = d[k + 2];
      const redness = R - Math.max(G, B);
      const dist = Math.hypot(x - cx, y - cy) / rad;
      if (redness > 30 && R > 60 && dist < 1.1) {
        const f = clamp((redness - 30) / 60, 0, 1) * clamp((1.1 - dist) * 4, 0, 1);
        const v = (G + B) / 2 * (1 - o.darken / 100 * 0.8);
        d[k] = R + (v - R) * f; d[k + 1] = G + (v - G) * f * 0.5; d[k + 2] = B + (v - B) * f * 0.5; n++;
      }
    }
    ctx2d(surf.canvas).putImageData(id, rr.x, rr.y);
    if (!n) { surf.cancel(); toast('No red eye found in that area.'); return; }
    surf.commit('Red Eye Tool', 'redEye');
  },
  overlay(g, v) { if (!this.p0) return; const a = v.toScreen(this.p0.x, this.p0.y), b = v.toScreen(this.p1.x, this.p1.y); g.strokeStyle = '#fff'; g.setLineDash([4, 4]); g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); },
});

// ---------- direct tools: blur / sharpen / smudge / dodge / burn / sponge ----------
function directTool(def) {
  return strokeTool({
    ...def,
    begin(t, i) {
      const doc = app.doc, o = opt(t.id);
      const target = targetNow(doc, { toolName: def.label.toLowerCase() }); if (!target) return null;
      const surf = new Surface(doc, target);
      const base = cloneCanvas(surf.orig);
      const R = surf.canvas; // modify directly
      const sel = surf.selMask();
      const work = sel ? cloneCanvas(base) : R;
      const sampleSrc = o.sampleAll && target.kind === 'layer' ? (() => { const c = createCanvas(R.width, R.height); ctx2d(c).drawImage(doc.flatten(), -surf.ox, -surf.oy); return c; })() : null;
      const st = {
        surf, state: {},
        dab(p, ang) {
          const pr = p.pressure ?? 1, size = Math.max(2, o.size * (o.pressureSize ? pr : 1));
          const x = p.x - surf.ox, y = p.y - surf.oy, rad = size / 2;
          const rect = clampRect({ x: Math.floor(x - rad - 1), y: Math.floor(y - rad - 1), w: Math.ceil(size + 3), h: Math.ceil(size + 3) }, work.width, work.height);
          if (rect.w <= 1 || rect.h <= 1) return;
          const tip = brushTip(size, o.hardness ?? 0.5, '#ffffff');
          const tg = createCanvas(rect.w, rect.h); ctx2d(tg).drawImage(tip.canvas, x - tip.d / 2 - rect.x, y - tip.d / 2 - rect.y);
          const ta = ctx2d(tg).getImageData(0, 0, rect.w, rect.h).data;
          def.apply({ work, rect, ta, o, x, y, p, state: st.state, sampleSrc, ang, pr });
          scheduleCompose(st.compose);
        },
        compose() {
          if (sel) { const g = ctx2d(R); g.globalCompositeOperation = 'copy'; g.drawImage(base, 0, 0); g.globalCompositeOperation = 'source-over'; const m = cloneCanvas(work), mg = ctx2d(m); mg.globalCompositeOperation = 'destination-in'; mg.drawImage(sel, 0, 0); g.drawImage(m, 0, 0); }
          surf.changed();
        },
        async end() { composeFn = null; st.compose(); surf.commit(def.label.replace(' Tool', ''), def.icon); },
      };
      return st;
    },
  });
}
const strength = (o) => (o.strength ?? o.exposure ?? 50) / 100;

registerTool(directTool({
  id: 'blurTool', label: 'Blur Tool', icon: 'blurTool', group: 'blurTool', defaults: { size: 40, hardness: 0, strength: 50, spacing: 25, smoothing: 0, mode: 'normal', sampleAll: false, pressureSize: false },
  apply({ work, rect, ta, o }) {
    const g = ctx2d(work), src = createCanvas(rect.w, rect.h), sg = ctx2d(src);
    const b = Math.max(1, o.size / 12) * (0.5 + strength(o));
    sg.filter = `blur(${b}px)`; sg.drawImage(work, -rect.x, -rect.y); sg.filter = 'none';
    const orig = g.getImageData(rect.x, rect.y, rect.w, rect.h), bl = sg.getImageData(0, 0, rect.w, rect.h).data, d = orig.data, s = strength(o);
    for (let k = 0; k < d.length; k += 4) { const a = ta[k + 3] / 255 * s; if (!a) continue; d[k] += (bl[k] - d[k]) * a; d[k + 1] += (bl[k + 1] - d[k + 1]) * a; d[k + 2] += (bl[k + 2] - d[k + 2]) * a; d[k + 3] += (bl[k + 3] - d[k + 3]) * a; }
    g.putImageData(orig, rect.x, rect.y);
  },
}));
registerTool(directTool({
  id: 'sharpenTool', label: 'Sharpen Tool', icon: 'sharpenTool', group: 'blurTool', defaults: { size: 40, hardness: 0, strength: 50, spacing: 30, smoothing: 0, protectDetail: true, sampleAll: false, pressureSize: false },
  apply({ work, rect, ta, o, state }) {
    const g = ctx2d(work), id = g.getImageData(rect.x, rect.y, rect.w, rect.h), d = id.data, src = new Uint8ClampedArray(d), w = rect.w, h = rect.h;
    const s = strength(o) * 0.35;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const k = (y * w + x) * 4, a = ta[k + 3] / 255 * s; if (!a) continue;
      for (let c = 0; c < 3; c++) {
        const v = src[k + c], lap = 4 * v - src[k + c - 4] - src[k + c + 4] - src[k + c - w * 4] - src[k + c + w * 4];
        d[k + c] = v + lap * a * (o.protectDetail ? 0.6 : 1);
      }
    }
    g.putImageData(id, rect.x, rect.y);
  },
}));
registerTool(directTool({
  id: 'smudge', label: 'Smudge Tool', icon: 'smudge', group: 'blurTool', defaults: { size: 40, hardness: 0, strength: 50, spacing: 10, smoothing: 0, fingerPainting: false, sampleAll: false, pressureSize: false },
  apply({ work, rect, ta, o, state }) {
    const g = ctx2d(work), id = g.getImageData(rect.x, rect.y, rect.w, rect.h), d = id.data;
    const s = strength(o);
    if (!state.finger || state.finger.length !== d.length) {
      state.finger = new Float32Array(d.length);
      if (o.fingerPainting) { const { r, g: gg, b } = hexToRgb(app.fg); for (let k = 0; k < d.length; k += 4) { state.finger[k] = r; state.finger[k + 1] = gg; state.finger[k + 2] = b; state.finger[k + 3] = 255; } }
      else for (let k = 0; k < d.length; k++) state.finger[k] = d[k];
      g.putImageData(id, rect.x, rect.y); return;
    }
    const f = state.finger;
    for (let k = 0; k < d.length; k += 4) {
      const a = ta[k + 3] / 255 * s; if (!a) { for (let c = 0; c < 4; c++) f[k + c] = d[k + c]; continue; }
      for (let c = 0; c < 4; c++) { const nv = d[k + c] + (f[k + c] - d[k + c]) * a; d[k + c] = nv; f[k + c] = nv; }
    }
    g.putImageData(id, rect.x, rect.y);
  },
}));

function toneWeight(range, l) {
  if (range === 'shadows') return clamp(1 - l / 0.6, 0, 1) ** 1.2;
  if (range === 'highlights') return clamp((l - 0.4) / 0.6, 0, 1) ** 1.2;
  return 1 - Math.abs(l - 0.5) * 2 * 0.85;
}
registerTool(directTool({
  id: 'dodge', label: 'Dodge Tool', icon: 'dodge', key: 'O', group: 'dodge', defaults: { size: 60, hardness: 0, exposure: 50, range: 'midtones', protectTones: true, spacing: 25, smoothing: 0, pressureSize: false },
  apply({ work, rect, ta, o }) { tone(work, rect, ta, o, +1); },
}));
registerTool(directTool({
  id: 'burn', label: 'Burn Tool', icon: 'burn', key: 'O', group: 'dodge', defaults: { size: 60, hardness: 0, exposure: 50, range: 'midtones', protectTones: true, spacing: 25, smoothing: 0, pressureSize: false },
  apply({ work, rect, ta, o }) { tone(work, rect, ta, o, -1); },
}));
function tone(work, rect, ta, o, dir) {
  const g = ctx2d(work), id = g.getImageData(rect.x, rect.y, rect.w, rect.h), d = id.data, e = (o.exposure ?? 50) / 100 * 0.12;
  for (let k = 0; k < d.length; k += 4) {
    const a = ta[k + 3] / 255; if (!a) continue;
    const r = d[k] / 255, gg = d[k + 1] / 255, b = d[k + 2] / 255, l = 0.299 * r + 0.587 * gg + 0.114 * b;
    const w = toneWeight(o.range, l) * a * e;
    for (let c = 0; c < 3; c++) {
      const v = d[k + c] / 255;
      let nv = dir > 0 ? v + (1 - v) * w * (o.protectTones ? 0.9 : 1.2) : v - v * w * (o.protectTones ? 0.9 : 1.2);
      if (o.protectTones) nv = v + (nv - v) * (dir > 0 ? (1 - l * 0.3) : (0.7 + l * 0.3));
      d[k + c] = nv * 255;
    }
  }
  g.putImageData(id, rect.x, rect.y);
}
registerTool(directTool({
  id: 'sponge', label: 'Sponge Tool', icon: 'sponge', key: 'O', group: 'dodge', defaults: { size: 60, hardness: 0, flow: 50, spongeMode: 'desaturate', vibrance: true, spacing: 25, smoothing: 0, pressureSize: false },
  apply({ work, rect, ta, o }) {
    const g = ctx2d(work), id = g.getImageData(rect.x, rect.y, rect.w, rect.h), d = id.data, f = (o.flow ?? 50) / 100 * 0.15, dir = o.spongeMode === 'saturate' ? 1 : -1;
    for (let k = 0; k < d.length; k += 4) {
      const a = ta[k + 3] / 255; if (!a) continue;
      const r = d[k], gg = d[k + 1], b = d[k + 2], l = 0.299 * r + 0.587 * gg + 0.114 * b;
      const sat = (Math.max(r, gg, b) - Math.min(r, gg, b)) / 255;
      let amt = dir * f * a;
      if (o.vibrance && dir > 0) amt *= (1 - sat);
      d[k] = clamp(l + (r - l) * (1 + amt), 0, 255); d[k + 1] = clamp(l + (gg - l) * (1 + amt), 0, 255); d[k + 2] = clamp(l + (b - l) * (1 + amt), 0, 255);
    }
    g.putImageData(id, rect.x, rect.y);
  },
}));

export { bufferedStroke, StrokePath };
