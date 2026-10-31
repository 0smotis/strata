// Move, Crop, Eyedropper, Hand, Zoom, Gradient, Paint Bucket, Type, Shapes
import { app, cmd } from '../state.js';
import { createCanvas, ctx2d, cloneCanvas, clamp, alphaBounds, rectIntersect } from '../util.js';
import { registerTool, opt, targetNow, Surface, docRect } from './base.js';
import { toast } from '../ui/common.js';
import { panBy, setZoom, zoomStep, toScreen, requestDraw, vp } from '../view/viewport.js';
import { pickColor } from './paint.js';
import { startTransform } from './transform.js';
import { Layer, measureText, textFont, refreshVector, mulTx } from '../doc/document.js';
import { renderGradient, resolveStops, GRADIENT_PRESETS } from '../doc/gradient.js';
import { magicWand } from '../doc/selection.js';
import { sampleImage } from './select.js';

// ---------- Move ----------
function pickLayerAt(doc, x, y, groups) {
  const list = [];
  const walk = (ls, top) => { for (let k = ls.length - 1; k >= 0; k--) { const l = ls[k]; if (!l.visible) continue; if (l.children) walk(l.children, top || l); else list.push([l, top || null]); } };
  walk(doc.layers, null);
  for (const [l, top] of list) {
    if (l.kind === 'adjustment') continue;
    const c = doc.layerContent(l); if (!c.canvas) continue;
    const px = Math.floor(x - c.x), py = Math.floor(y - c.y);
    if (px < 0 || py < 0 || px >= c.canvas.width || py >= c.canvas.height) continue;
    if (ctx2d(c.canvas).getImageData(px, py, 1, 1).data[3] > 10) return groups && top ? top : l;
  }
  return null;
}
function translateLayer(L, dx, dy) {
  if (L.children) { for (const c of L.children) translateLayer(c, dx, dy); }
  else if (L.kind === 'text' || L.kind === 'shape' || L.kind === 'smart') { L.tx = mulTx([1, 0, 0, 1, dx, dy], L.tx); }
  if (L.vmask) for (const sp of L.vmask.subpaths) for (const p of sp.pts) for (const q of [p, p.in, p.out]) if (q) { q.x += dx; q.y += dy; }
  if (L.artboard) { L.artboard.x += dx; L.artboard.y += dy; }
  else if (L.kind === 'pixel') { L.x += dx; L.y += dy; }
  if (L.mask && L.mask.linked !== false) { L.mask.x += dx; L.mask.y += dy; L.maskRev++; }
  L.touch(L.kind === 'pixel');
}
registerTool({
  id: 'move', label: 'Move Tool', icon: 'move', key: 'V', group: 'move', cursor: 'default',
  defaults: { autoSelect: false, autoTarget: 'layer', showTransform: false },
  down(i) {
    const doc = app.doc, o = opt('move');
    if (o.autoSelect || i.ctrl) { const hit = pickLayerAt(doc, i.x, i.y, o.autoTarget === 'group'); if (hit) doc.setActive(hit.id); }
    const L = doc.active; if (!L) return;
    if (L.locks.all || L.locks.position) { toast(L.locks.background ? 'Could not use the move tool because the layer is locked. Double-click the Background layer to convert it.' : 'Could not use the move tool because the layer is locked.', 'err'); return; }
    if (doc.selection && L.kind === 'pixel') {
      const tr = startTransform(doc, { copy: i.alt }); if (!tr) return;
      if (i.alt) { tr.rest = cloneCanvas(L.canvas); tr.preview(); }
      tr.drag = { type: 'move', p0: { x: i.x, y: i.y }, M0: [...tr.M], c0: tr.center() };
      this.tr = tr; return;
    }
    let targets = [...doc.selectedIds].map(id => doc.find(id)).filter(Boolean);
    if (!targets.includes(L)) targets = [L];
    if (i.alt) { // duplicate then move
      const dup = targets.map(t => cmd('duplicateLayerObj', t)).filter(Boolean);
      if (dup.length) targets = dup;
    }
    this.drag = { p0: { x: i.x, y: i.y }, targets, dx: 0, dy: 0 };
  },
  move(i) {
    if (this.tr) { this.tr.move(i); return; }
    const d = this.drag; if (!d) return;
    let dx = Math.round(i.x - d.p0.x), dy = Math.round(i.y - d.p0.y);
    if (i.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const ddx = dx - d.dx, ddy = dy - d.dy; if (!ddx && !ddy) return;
    for (const L of d.targets) translateLayer(L, ddx, ddy);
    d.dx = dx; d.dy = dy; app.doc.invalidate();
  },
  up() {
    if (this.tr) { const tr = this.tr; this.tr = null; tr.drag = null; tr.commit('Move'); return; }
    const d = this.drag; this.drag = null; if (!d) return;
    if (d.dx || d.dy) app.doc.commit('Move', 'move');
  },
  keydown(e) {
    const step = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!mv) return false;
    const doc = app.doc, L = doc.active; if (!L || L.locks.position || L.locks.all) return true;
    if (doc.selection && L.kind === 'pixel') { const tr = startTransform(doc); if (tr) { tr.M = mulTx([1, 0, 0, 1, mv[0], mv[1]], tr.M); tr.preview(); tr.commit('Nudge'); } return true; }
    for (const id of doc.selectedIds) { const l = doc.find(id); if (l) translateLayer(l, mv[0], mv[1]); }
    doc.commit('Nudge', 'move'); return true;
  },
});

// ---------- Crop ----------
const RATIOS = { free: null, original: 'orig', '1:1': 1, '4:5': 4 / 5, '5:4': 5 / 4, '2:3': 2 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3 };
registerTool({
  id: 'crop', label: 'Crop Tool', icon: 'crop', key: 'C', group: 'crop', cursor: 'crosshair',
  defaults: { ratio: 'free', deleteCropped: true, overlay: 'thirds', customW: 0, customH: 0 },
  activate() { this.reset(); },
  deactivate() { this.r = null; },
  reset() { const d = app.doc; this.r = d ? { x: 0, y: 0, w: d.width, h: d.height } : null; requestDraw(); },
  ratio() { const o = opt('crop'); if (o.ratio === 'custom') return o.customW && o.customH ? o.customW / o.customH : null; const r = RATIOS[o.ratio]; return r === 'orig' ? app.doc.width / app.doc.height : r; },
  hit(i) {
    if (!this.r) return null; const r = this.r, z = app.doc.view.zoom, t = 8 / z;
    const hs = { nw: [r.x, r.y], n: [r.x + r.w / 2, r.y], ne: [r.x + r.w, r.y], e: [r.x + r.w, r.y + r.h / 2], se: [r.x + r.w, r.y + r.h], s: [r.x + r.w / 2, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, r.y + r.h / 2] };
    for (const [k, [x, y]] of Object.entries(hs)) if (Math.abs(i.x - x) < t && Math.abs(i.y - y) < t) return k;
    if (i.x > r.x && i.y > r.y && i.x < r.x + r.w && i.y < r.y + r.h) return 'move';
    return 'new';
  },
  cursor(p) { if (!p) return 'crosshair'; const h = this.hit(p); return { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' }[h] || 'crosshair'; },
  down(i) { if (!this.r) this.reset(); this.mode = this.hit(i); this.p0 = { x: i.x, y: i.y }; this.r0 = { ...this.r }; },
  move(i) {
    if (!this.mode) return;
    const r0 = this.r0, dx = i.x - this.p0.x, dy = i.y - this.p0.y, ar = i.shift ? (r0.w / r0.h) : this.ratio();
    let { x, y, w, h } = r0;
    if (this.mode === 'move') { x += dx; y += dy; }
    else if (this.mode === 'new') { x = Math.min(this.p0.x, i.x); y = Math.min(this.p0.y, i.y); w = Math.abs(dx); h = Math.abs(dy); if (ar) { h = w / ar; if (i.y < this.p0.y) y = this.p0.y - h; } }
    else {
      const m = this.mode;
      if (m.includes('e')) w = r0.w + dx; if (m.includes('w')) { x = r0.x + dx; w = r0.w - dx; }
      if (m.includes('s')) h = r0.h + dy; if (m.includes('n')) { y = r0.y + dy; h = r0.h - dy; }
      if (ar) { if (m === 'n' || m === 's') { const nw = h * ar; x -= (nw - w) / 2; w = nw; } else { const nh = w / ar; if (m.includes('n')) y = r0.y + r0.h - nh; else if (m === 'e' || m === 'w') y -= (nh - h) / 2; h = nh; } }
    }
    if (w < 0) { x += w; w = -w; } if (h < 0) { y += h; h = -h; }
    this.r = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  },
  up() { this.mode = null; app.emit('crop'); },
  dblclick() { this.commit(); },
  keydown(e) { if (e.key === 'Enter') { this.commit(); return true; } if (e.key === 'Escape') { this.reset(); return true; } return false; },
  commit() {
    const doc = app.doc, r = this.r; if (!r) return;
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
    if (x === 0 && y === 0 && w === doc.width && h === doc.height) return;
    cropDocument(doc, { x, y, w, h }, opt('crop').deleteCropped);
    this.reset();
  },
  overlay(g, v) {
    if (!this.r) return;
    const r = this.r, a = v.toScreen(r.x, r.y), w = r.w * v.z, h = r.h * v.z;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.beginPath(); g.rect(0, 0, vp.w, vp.h); g.rect(a.x, a.y, w, h); g.fill('evenodd');
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.strokeRect(Math.round(a.x) + .5, Math.round(a.y) + .5, Math.round(w), Math.round(h));
    if (opt('crop').overlay === 'thirds') { g.strokeStyle = 'rgba(255,255,255,.5)'; g.beginPath(); for (const f of [1 / 3, 2 / 3]) { g.moveTo(a.x + w * f, a.y); g.lineTo(a.x + w * f, a.y + h); g.moveTo(a.x, a.y + h * f); g.lineTo(a.x + w, a.y + h * f); } g.stroke(); }
    g.fillStyle = '#fff';
    const L = 14;
    for (const [hx, hy, sx, sy] of [[a.x, a.y, 1, 1], [a.x + w, a.y, -1, 1], [a.x, a.y + h, 1, -1], [a.x + w, a.y + h, -1, -1]]) { g.fillRect(hx - (sx < 0 ? 3 : 0), hy - (sy < 0 ? 3 : 0), L * sx, 3 * sy); g.fillRect(hx - (sx < 0 ? 3 : 0), hy - (sy < 0 ? 3 : 0), 3 * sx, L * sy); }
    for (const [hx, hy] of [[a.x + w / 2, a.y], [a.x + w / 2, a.y + h], [a.x, a.y + h / 2], [a.x + w, a.y + h / 2]]) g.fillRect(hx - 6, hy - 2, 12, 4);
    if (this.mode) { g.fillStyle = 'rgba(0,0,0,.75)'; g.fillRect(a.x + w + 8, a.y + h + 8, 80, 32); g.fillStyle = '#fff'; g.font = '11px Segoe UI'; g.fillText(`W: ${Math.round(r.w)} px`, a.x + w + 14, a.y + h + 21); g.fillText(`H: ${Math.round(r.h)} px`, a.x + w + 14, a.y + h + 34); }
  },
});
export function cropDocument(doc, r, deleteCropped = true) {
  doc.resizeCanvas(r.w, r.h, -r.x, -r.y);
  if (deleteCropped) {
    for (const L of doc.all()) {
      if (L.kind === 'pixel' && L.canvas) {
        const c = createCanvas(r.w, r.h); ctx2d(c).drawImage(L.canvas, L.x, L.y); L.canvas = c; L.x = 0; L.y = 0; L.touch(true);
      }
      if (L.mask) {
        const c = createCanvas(r.w, r.h), g = ctx2d(c);
        if (L.mask.def) { g.fillStyle = '#fff'; g.fillRect(0, 0, r.w, r.h); g.clearRect(L.mask.x, L.mask.y, L.mask.canvas.width, L.mask.canvas.height); }
        g.drawImage(L.mask.canvas, L.mask.x, L.mask.y); L.mask.canvas = c; L.mask.x = 0; L.mask.y = 0; L.maskRev++;
      }
    }
  }
  doc.commit('Crop', 'crop');
}

// ---------- Eyedropper ----------
registerTool({
  id: 'eyedropper', label: 'Eyedropper Tool', icon: 'eyedropper', key: 'I', group: 'eyedropper', cursor: 'crosshair',
  defaults: { sampleSize: 1, sample: 'all', showRing: true },
  down(i) { this.on = true; pickColor(i, i.alt); this.cur = i; },
  move(i) { if (this.on) { pickColor(i, i.alt); this.cur = i; } },
  up() { this.on = false; },
  overlay(g, v) {
    if (!this.on || !this.cur || !opt('eyedropper').showRing) return;
    const s = v.toScreen(this.cur.x, this.cur.y);
    g.lineWidth = 14; g.beginPath(); g.arc(s.x, s.y, 40, Math.PI, 2 * Math.PI); g.strokeStyle = app.fg; g.stroke();
    g.beginPath(); g.arc(s.x, s.y, 40, 0, Math.PI); g.strokeStyle = this.prev || '#888'; g.stroke();
    g.lineWidth = 1; g.strokeStyle = '#999'; g.beginPath(); g.arc(s.x, s.y, 47, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(s.x, s.y, 33, 0, Math.PI * 2); g.stroke();
  },
});

// ---------- Hand / Zoom ----------
registerTool({
  id: 'hand', label: 'Hand Tool', icon: 'hand', key: 'H', group: 'hand', cursor: 'grab', defaults: {},
  down(i) { this.last = { x: i.sx, y: i.sy }; vp.el.style.cursor = 'grabbing'; },
  move(i) { if (!this.last) return; panBy(i.sx - this.last.x, i.sy - this.last.y); this.last = { x: i.sx, y: i.sy }; },
  up() { this.last = null; },
  dblclick() { cmd('fitOnScreen'); },
});
registerTool({
  id: 'zoom', label: 'Zoom Tool', icon: 'zoom', key: 'Z', group: 'zoom', cursor: 'zoom-in', defaults: { scrubby: true },
  down(i) { this.p0 = { x: i.sx, y: i.sy }; this.z0 = app.doc.view.zoom; this.moved = false; this.alt = i.alt; },
  move(i) {
    if (!this.p0 || !opt('zoom').scrubby) return;
    const dx = i.sx - this.p0.x; if (Math.abs(dx) > 3) this.moved = true;
    if (this.moved) setZoom(this.z0 * Math.exp(dx / 150), this.p0);
  },
  up(i) { if (this.p0 && !this.moved) zoomStep(this.alt ? -1 : 1, { x: i.sx, y: i.sy }); this.p0 = null; },
  hover(i) { vp.el.style.cursor = i.alt ? 'zoom-out' : 'zoom-in'; },
  dblclick() { setZoom(1); },
});

// ---------- Gradient ----------
registerTool({
  id: 'gradient', label: 'Gradient Tool', icon: 'gradient', key: 'G', group: 'gradient', cursor: 'crosshair',
  defaults: { preset: 0, type: 'linear', mode: 'normal', opacity: 100, reverse: false, dither: true, transparency: true },
  down(i) {
    const doc = app.doc;
    const target = targetNow(doc, { toolName: 'gradient tool' }); if (!target) return;
    this.surf = new Surface(doc, target); this.base = cloneCanvas(this.surf.orig);
    this.p0 = { x: i.x, y: i.y }; this.p1 = { ...this.p0 };
  },
  move(i) {
    if (!this.p0) return;
    let p = { x: i.x, y: i.y };
    if (i.shift) { const dx = p.x - this.p0.x, dy = p.y - this.p0.y, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(dx, dy); p = { x: this.p0.x + Math.cos(a) * l, y: this.p0.y + Math.sin(a) * l }; }
    this.p1 = p; this.render(false);
  },
  render(final) {
    const o = opt('gradient'), s = this.surf, W = s.canvas.width, H = s.canvas.height;
    const preset = GRADIENT_PRESETS[o.preset] || GRADIENT_PRESETS[0];
    let stops = resolveStops(preset.stops, app.fg, app.bg);
    if (!o.transparency) stops = stops.map(x => ({ ...x, a: 1 }));
    if (s.isMaskLike) stops = stops.map(x => { const v = Math.round(0.299 * x.r + 0.587 * x.g + 0.114 * x.b); return { ...x, r: v, g: v, b: v }; });
    // render at reduced resolution while dragging for speed
    const scale = final ? 1 : Math.min(1, 900 / Math.max(W, H));
    const gw = Math.max(1, Math.round(W * scale)), gh = Math.max(1, Math.round(H * scale));
    const gc = createCanvas(gw, gh);
    const p0 = { x: (this.p0.x - s.ox) * scale, y: (this.p0.y - s.oy) * scale }, p1 = { x: (this.p1.x - s.ox) * scale, y: (this.p1.y - s.oy) * scale };
    renderGradient(ctx2d(gc), gw, gh, p0, p1, stops, o.type, o.reverse, o.dither && final);
    let G = gc;
    if (scale !== 1) { G = createCanvas(W, H); ctx2d(G).drawImage(gc, 0, 0, W, H); }
    if (s.isMaskLike) { // convert gray to alpha
      const id = ctx2d(G).getImageData(0, 0, W, H), d = id.data; for (let k = 0; k < d.length; k += 4) { d[k + 3] = d[k] * d[k + 3] / 255; d[k] = d[k + 1] = d[k + 2] = 255; } ctx2d(G).putImageData(id, 0, 0);
    }
    const sel = s.selMask(); if (sel) { const gg = ctx2d(G); gg.globalCompositeOperation = 'destination-in'; gg.drawImage(sel, 0, 0); }
    const g = ctx2d(s.canvas); g.globalCompositeOperation = 'copy'; g.drawImage(this.base, 0, 0);
    const modes = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', softLight: 'soft-light', darken: 'darken', lighten: 'lighten', difference: 'difference', color: 'color', luminosity: 'luminosity' };
    if (s.isMaskLike) { g.globalCompositeOperation = sel ? 'source-over' : 'copy'; g.globalAlpha = o.opacity / 100; g.drawImage(G, 0, 0); }
    else {
      const lockT = s.target.layer.locks.transparency;
      g.globalCompositeOperation = lockT ? 'source-atop' : (modes[o.mode] || 'source-over'); g.globalAlpha = o.opacity / 100; g.drawImage(G, 0, 0);
    }
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    s.changed();
  },
  up() {
    if (!this.p0) return;
    if (Math.hypot(this.p1.x - this.p0.x, this.p1.y - this.p0.y) < 1) { this.surf.cancel(); this.p0 = null; return; }
    this.render(true); this.surf.commit('Gradient', 'gradient'); this.p0 = null; this.surf = null;
  },
  overlay(g, v) {
    if (!this.p0) return;
    const a = v.toScreen(this.p0.x, this.p0.y), b = v.toScreen(this.p1.x, this.p1.y);
    g.strokeStyle = '#000'; g.lineWidth = 3; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    for (const p of [a, b]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(p.x, p.y, 4, 0, Math.PI * 2); g.fill(); g.strokeStyle = '#000'; g.stroke(); }
  },
});

// ---------- Paint bucket ----------
registerTool({
  id: 'bucket', label: 'Paint Bucket Tool', icon: 'bucket', key: 'G', group: 'gradient', cursor: 'crosshair',
  defaults: { mode: 'normal', opacity: 100, tolerance: 32, antiAlias: true, contiguous: true, sampleAll: false },
  down(i) {
    const doc = app.doc, o = opt('bucket');
    const target = targetNow(doc, { toolName: 'paint bucket' }); if (!target) return;
    const surf = new Surface(doc, target);
    const W = doc.width, H = doc.height;
    let s;
    if (o.sampleAll) s = sampleImage(doc, true);
    else { const c = createCanvas(W, H); ctx2d(c).drawImage(surf.canvas, surf.ox, surf.oy); s = { img: ctx2d(c).getImageData(0, 0, W, H), w: W, h: H }; }
    const m = magicWand(s.img, W, H, i.x, i.y, { tolerance: o.tolerance, contiguous: o.contiguous, antiAlias: o.antiAlias });
    const fc = createCanvas(W, H), fg = ctx2d(fc), id = fg.createImageData(W, H);
    const col = surf.isMaskLike ? '#ffffff' : app.fg;
    const r = parseInt(col.slice(1, 3), 16), gg = parseInt(col.slice(3, 5), 16), b = parseInt(col.slice(5, 7), 16);
    for (let k = 0; k < m.length; k++) { const j = k * 4; id.data[j] = r; id.data[j + 1] = gg; id.data[j + 2] = b; id.data[j + 3] = m[k]; }
    fg.putImageData(id, 0, 0);
    if (doc.selection) { fg.globalCompositeOperation = 'destination-in'; fg.drawImage(doc.selection, 0, 0); }
    const g = ctx2d(surf.canvas);
    const modes = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', color: 'color', behind: 'destination-over', clear: 'destination-out' };
    g.globalAlpha = o.opacity / 100;
    g.globalCompositeOperation = surf.isMaskLike && grayLum(app.fg) < 0.5 ? 'destination-out' : (target.kind === 'layer' && target.layer.locks.transparency ? 'source-atop' : (modes[o.mode] || 'source-over'));
    g.drawImage(fc, -surf.ox, -surf.oy);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    surf.commit('Paint Bucket', 'bucket');
  },
});
const grayLum = (hex) => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16 & 255) + 0.587 * (n >> 8 & 255) + 0.114 * (n & 255)) / 255; };

// ---------- Type ----------
export const FALLBACK_FONTS = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact', 'Ink Free', 'Lucida Console', 'Lucida Sans Unicode', 'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black', 'Segoe UI Light', 'Segoe UI Semibold', 'Sitka Text', 'Sylfaen', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
app.fonts = [...FALLBACK_FONTS];
export async function loadFonts() {
  try {
    if (window.queryLocalFonts) {
      const fs = await window.queryLocalFonts();
      const fam = [...new Set(fs.map(f => f.family))].sort((a, b) => a.localeCompare(b));
      if (fam.length) { app.fonts = fam; app.emit('fonts'); }
    }
  } catch (e) { console.warn('font list unavailable', e); }
}

const editor = () => document.getElementById('text-editor');
registerTool({
  id: 'type', label: 'Horizontal Type Tool', icon: 'type', key: 'T', group: 'type', cursor: 'text',
  defaults: { font: 'Arial', size: 72, bold: false, italic: false, align: 'left', color: null, tracking: 0, leading: 0, underline: false },
  down(i) {
    const doc = app.doc;
    if (this.editing) { const L = this.editing.layer; const b = L.bounds(); if (b && i.x >= b.x - 4 && i.y >= b.y - 4 && i.x <= b.x + b.w + 4 && i.y <= b.y + b.h + 4) return; this.commitEdit(); return; }
    // hit existing text layer
    const hit = doc.all().slice().reverse().find(l => l.kind === 'text' && l.visible && (() => { const b = l.bounds(); return b && i.x >= b.x && i.y >= b.y && i.x <= b.x + b.w && i.y <= b.y + b.h; })());
    if (hit) { doc.setActive(hit.id); this.beginEdit(hit, false); return; }
    const o = opt('type');
    const L = new Layer('text', { name: 'Layer', tx: [1, 0, 0, 1, Math.round(i.x), Math.round(i.y)], data: { text: '', font: o.font, size: o.size, color: o.color || app.fg, bold: o.bold, italic: o.italic, align: o.align, tracking: o.tracking, leading: o.leading, underline: o.underline } });
    doc.addLayer(L);
    this.beginEdit(L, true);
  },
  beginEdit(L, isNew) {
    const ed = editor();
    this.editing = { layer: L, isNew, orig: JSON.stringify(L.data) };
    ed.textContent = L.data.text;
    ed.classList.add('on');
    this.place();
    ed.oninput = () => { L.data.text = ed.innerText.replace(/\n$/, ''); L.touch(); app.doc.invalidate(); if (!L.userNamed) L.name = (L.data.text.split('\n')[0] || 'Layer').slice(0, 40); app.doc.emit('layers'); };
    ed.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); this.commitEdit(); }
    };
    ed.focus(); setTimeout(() => { ed.focus(); const r = document.createRange(); r.selectNodeContents(ed); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, 0);
    this._onView = app.on('view', () => this.place());
    app.emit('transform');
  },
  place() {
    if (!this.editing) return;
    const L = this.editing.layer, t = L.data, z = app.doc.view.zoom, ed = editor();
    const s = toScreen(L.tx[4], L.tx[5]), sc = Math.hypot(L.tx[0], L.tx[1]);
    const lead = (t.leading || t.size * 1.2) * z * sc, fs = t.size * z * sc;
    ed.style.font = textFont({ ...t, size: fs });
    ed.style.lineHeight = lead + 'px';
    ed.style.letterSpacing = (t.tracking || 0) / 1000 * fs + 'px';
    ed.style.textAlign = t.align || 'left';
    ed.style.left = s.x + 'px';
    ed.style.top = (s.y - lead / 2 - fs * 0.33) + 'px';
    ed.style.transform = t.align === 'center' ? 'translateX(-50%)' : t.align === 'right' ? 'translateX(-100%)' : 'none';
  },
  commitEdit() {
    const ed = editor(), doc = app.doc;
    if (!this.editing) return;
    const { layer: L, isNew, orig } = this.editing;
    this.editing = null; ed.classList.remove('on'); ed.oninput = null; ed.onkeydown = null; ed.blur();
    if (this._onView) { this._onView(); this._onView = null; }
    if (!L.data.text.trim()) { doc.removeLayer(L.id); if (!isNew) doc.commit('Delete Layer'); }
    else if (isNew || JSON.stringify(L.data) !== orig) doc.commit(isNew ? 'Type Layer' : 'Edit Type Layer', 'type');
    doc.invalidate(); app.emit('transform');
    vp.el.focus();
  },
  deactivate() { this.commitEdit(); },
  keydown(e) { return !!this.editing; },
});
app.on('typeopt', (k, v) => { const t = app.tools?.type; const L = t?.editing?.layer || (app.doc?.active?.kind === 'text' ? app.doc.active : null); if (!L) return; L.data[k] = v; L.touch(); app.doc.invalidate(); if (t?.editing) t.place(); else app.doc.commit('Character Change', 'type'); });

// ---------- Shapes ----------
function shapeTool(id, label, icon, shape) {
  registerTool({
    id, label, icon, key: 'U', group: 'shape', cursor: 'crosshair',
    defaults: { fill: null, stroke: null, strokeWidth: 3, radius: id === 'roundRect' ? 20 : 0, sides: 5, inner: 50, lineWeight: 4, noFill: false },
    down(i) {
      const o = opt(id);
      this.p0 = { x: i.x, y: i.y }; this.p1 = { ...this.p0 };
      const fill = o.noFill ? null : (o.fill || app.fg);
      this.L = new Layer('shape', { name: app.doc.nextName({ rect: 'Rectangle', ellipse: 'Ellipse', polygon: 'Polygon', star: 'Star', line: 'Line', triangle: 'Triangle' }[shape] || 'Shape'), tx: [1, 0, 0, 1, i.x, i.y],
        data: { shape: shape === 'triangle' ? 'polygon' : shape, w: 1, h: 1, fill: shape === 'line' ? null : fill, stroke: shape === 'line' ? (o.fill || app.fg) : o.stroke, strokeWidth: shape === 'line' ? o.lineWeight : o.strokeWidth, radius: o.radius, sides: shape === 'triangle' ? 3 : o.sides, inner: o.inner / 100 } });
      app.doc.addLayer(this.L);
    },
    move(i) {
      if (!this.L) return;
      let w = i.x - this.p0.x, h = i.y - this.p0.y;
      if (i.shift) { if (shape === 'line') { const a = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(w, h); w = Math.cos(a) * l; h = Math.sin(a) * l; } else { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; } }
      let x = this.p0.x, y = this.p0.y;
      if (i.alt && shape !== 'line') { x -= w; y -= h; w *= 2; h *= 2; }
      if (shape === 'line') { this.L.tx = [1, 0, 0, 1, x, y]; this.L.data.w = w; this.L.data.h = h; }
      else { this.L.tx = [1, 0, 0, 1, Math.min(x, x + w), Math.min(y, y + h)]; this.L.data.w = Math.abs(w); this.L.data.h = Math.abs(h); }
      this.L.touch(); app.doc.invalidate();
    },
    up() {
      const L = this.L; this.L = null; if (!L) return;
      if (Math.abs(L.data.w) < 2 && Math.abs(L.data.h) < 2) {
        if (shape === 'line') { app.doc.removeLayer(L.id); return; }
        L.data.w = L.data.h = 100; L.touch();
      }
      app.doc.commit(L.name.replace(/ \d+$/, '') + ' Tool', icon);
    },
  });
}
shapeTool('rectShape', 'Rectangle Tool', 'rect', 'rect');
shapeTool('ellipseShape', 'Ellipse Tool', 'ellipse', 'ellipse');
shapeTool('triangleShape', 'Triangle Tool', 'triangle', 'triangle');
shapeTool('polygonShape', 'Polygon Tool', 'polygon', 'polygon');
shapeTool('starShape', 'Star Tool', 'star', 'star');
shapeTool('lineShape', 'Line Tool', 'line', 'line');
