// Selection tools
import { app } from '../state.js';
import { ctx2d, createCanvas, clamp, cloneCanvas } from '../util.js';
import { registerTool, opt } from './base.js';
import { rectSel, ellipseSel, polySel, combineSel, magicWand, selFromMask, selToMask, featherCanvas } from '../doc/selection.js';
import { toast, withBusy } from '../ui/common.js';

const selDefaults = { mode: 'new', feather: 0, antiAlias: true, style: 'normal', ratioW: 1, ratioH: 1, fixedW: 64, fixedH: 64 };

function modeFor(i, toolId) {
  if (i.shift && i.alt) return 'intersect';
  if (i.shift) return 'add';
  if (i.alt) return 'subtract';
  return opt(toolId).mode || 'new';
}
function apply(doc, next, mode, name) {
  const s = combineSel(doc, next, mode);
  doc.setSelection(s);
  doc.commit(name, 'marqueeRect');
}
function insideSel(doc, x, y) {
  if (!doc.selection || x < 0 || y < 0 || x >= doc.width || y >= doc.height) return false;
  return ctx2d(doc.selection).getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3] > 127;
}

// drag selection outline
function selMover() {
  return {
    start(doc, i) { this.doc = doc; this.p0 = { x: i.x, y: i.y }; this.orig = doc.selection; this.dx = 0; this.dy = 0; },
    move(i) {
      this.dx = Math.round(i.x - this.p0.x); this.dy = Math.round(i.y - this.p0.y);
      const c = createCanvas(this.doc.width, this.doc.height); ctx2d(c).drawImage(this.orig, this.dx, this.dy);
      this.doc.selection = c; this.doc.selRev++; this.doc.selBounds = null; app.emit('selection');
    },
    up() { const s = this.doc.selection; this.doc.setSelection(s); if (this.dx || this.dy) this.doc.commit('Move Selection', 'move'); },
  };
}

function marquee(id, label, icon, shape) {
  registerTool({
    id, label, icon, key: 'M', group: 'marquee', cursor: 'crosshair', defaults: { ...selDefaults },
    down(i) {
      const doc = app.doc;
      this.mode = modeFor(i, id);
      this.mover = null;
      if (this.mode === 'new' && !i.shift && !i.alt && insideSel(doc, i.x, i.y) && shape !== 'row' && shape !== 'col') { this.mover = selMover(); this.mover.start(doc, i); return; }
      this.p0 = { x: i.x, y: i.y }; this.p1 = { ...this.p0 }; this.dragging = true; this.moved = false;
      if (shape === 'row' || shape === 'col') { this.up(i); }
    },
    move(i) {
      if (this.mover) return this.mover.move(i);
      if (!this.dragging) return;
      if (this._space) { // reposition while drawing with space
      }
      this.p1 = { x: i.x, y: i.y }; this.shift = i.shift; this.alt = i.alt;
      if (Math.hypot(i.sx - (this._sx ?? i.sx), 0) > 0) {}
      this.moved = true;
    },
    rect() {
      const o = opt(id);
      let { p0, p1 } = this;
      let w = p1.x - p0.x, h = p1.y - p0.y;
      if (o.style === 'fixedRatio') { const r = o.ratioW / o.ratioH; if (Math.abs(w) / r > Math.abs(h)) h = Math.sign(h || 1) * Math.abs(w) / r; else w = Math.sign(w || 1) * Math.abs(h) * r; }
      else if (o.style === 'fixedSize') { w = o.fixedW; h = o.fixedH; return { x: Math.round(p1.x - w / 2), y: Math.round(p1.y - h / 2), w, h }; }
      if (this.shift && this.mode !== 'add') { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      let x = p0.x, y = p0.y;
      if (this.alt && this.mode !== 'subtract') { x -= w; y -= h; w *= 2; h *= 2; }
      const r = { x: Math.round(Math.min(x, x + w)), y: Math.round(Math.min(y, y + h)), w: Math.round(Math.abs(w)), h: Math.round(Math.abs(h)) };
      return r;
    },
    up(i) {
      const doc = app.doc;
      if (this.mover) { this.mover.up(i); this.mover = null; return; }
      if (!this.p0) return;
      this.dragging = false;
      const o = opt(id);
      if (shape === 'row') { apply(doc, rectSel(doc, { x: 0, y: Math.floor(i.y), w: doc.width, h: 1 }, 0, false), this.mode, 'Single Row Marquee'); this.p0 = null; return; }
      if (shape === 'col') { apply(doc, rectSel(doc, { x: Math.floor(i.x), y: 0, w: 1, h: doc.height }, 0, false), this.mode, 'Single Column Marquee'); this.p0 = null; return; }
      const r = this.rect();
      this.p0 = null;
      if ((r.w < 1 || r.h < 1 || !this.moved) && o.style !== 'fixedSize') {
        if (this.mode === 'new' && doc.selection) { doc.setSelection(null); doc.commit('Deselect', 'marqueeRect'); }
        return;
      }
      const s = shape === 'ellipse' ? ellipseSel(doc, r, o.feather, o.antiAlias) : rectSel(doc, r, o.feather, true);
      apply(doc, s, this.mode, shape === 'ellipse' ? 'Elliptical Marquee' : 'Rectangular Marquee');
    },
    overlay(g, v) {
      if (!this.p0 || !this.dragging) return;
      const r = this.rect(), a = v.toScreen(r.x, r.y), w = r.w * v.z, h = r.h * v.z;
      g.lineWidth = 1; g.setLineDash([4, 4]);
      for (const [c, off] of [['#fff', 0], ['#000', 4]]) {
        g.strokeStyle = c; g.lineDashOffset = off; g.beginPath();
        if (shape === 'ellipse') g.ellipse(a.x + w / 2, a.y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); else g.rect(Math.round(a.x) + .5, Math.round(a.y) + .5, Math.round(w), Math.round(h));
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(a.x + w + 8, a.y + h + 8, 74, 32); g.fillStyle = '#fff'; g.font = '11px Segoe UI'; g.fillText(`W: ${r.w} px`, a.x + w + 14, a.y + h + 21); g.fillText(`H: ${r.h} px`, a.x + w + 14, a.y + h + 34);
    },
  });
}
marquee('marqueeRect', 'Rectangular Marquee Tool', 'marqueeRect', 'rect');
marquee('marqueeEllipse', 'Elliptical Marquee Tool', 'marqueeEllipse', 'ellipse');
marquee('marqueeRow', 'Single Row Marquee Tool', 'marqueeRow', 'row');
marquee('marqueeCol', 'Single Column Marquee Tool', 'marqueeCol', 'col');

// ---------- Lasso ----------
registerTool({
  id: 'lasso', label: 'Lasso Tool', icon: 'lasso', key: 'L', group: 'lasso', cursor: 'crosshair', defaults: { mode: 'new', feather: 0, antiAlias: true },
  down(i) {
    const doc = app.doc; this.mode = modeFor(i, 'lasso');
    if (this.mode === 'new' && insideSel(doc, i.x, i.y)) { this.mover = selMover(); this.mover.start(doc, i); return; }
    this.pts = [{ x: i.x, y: i.y }];
  },
  move(i) { if (this.mover) return this.mover.move(i); if (!this.pts) return; const l = this.pts[this.pts.length - 1]; if (Math.hypot(i.x - l.x, i.y - l.y) * app.doc.view.zoom > 1.5) this.pts.push({ x: i.x, y: i.y }); },
  up() {
    const doc = app.doc;
    if (this.mover) { this.mover.up(); this.mover = null; return; }
    const pts = this.pts; this.pts = null; if (!pts) return;
    if (pts.length < 3) { if (this.mode === 'new' && doc.selection) { doc.setSelection(null); doc.commit('Deselect'); } return; }
    const o = opt('lasso');
    apply(doc, polySel(doc, pts, o.feather, o.antiAlias), this.mode, 'Lasso');
  },
  overlay(g, v) { if (!this.pts) return; drawPoly(g, v, this.pts, false); },
});
function drawPoly(g, v, pts, open, extra) {
  g.lineWidth = 1;
  for (const [c, off] of [['#fff', 0], ['#000', 4]]) {
    g.setLineDash([4, 4]); g.lineDashOffset = off; g.strokeStyle = c; g.beginPath();
    pts.forEach((p, k) => { const s = v.toScreen(p.x, p.y); k ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); });
    if (extra) { const s = v.toScreen(extra.x, extra.y); g.lineTo(s.x, s.y); }
    g.stroke();
  }
  g.setLineDash([]);
}
registerTool({
  id: 'polyLasso', label: 'Polygonal Lasso Tool', icon: 'polyLasso', key: 'L', group: 'lasso', cursor: 'crosshair', defaults: { mode: 'new', feather: 0, antiAlias: true },
  down(i) {
    if (!this.pts) { this.mode = modeFor(i, 'polyLasso'); this.pts = [{ x: i.x, y: i.y }]; }
    else {
      const f = this.pts[0];
      if (this.pts.length > 2 && Math.hypot(i.x - f.x, i.y - f.y) * app.doc.view.zoom < 8) return this.finish();
      let p = { x: i.x, y: i.y };
      if (i.shift) p = snap45(this.pts[this.pts.length - 1], p);
      this.pts.push(p);
    }
  },
  hover(i) { this.cur = i.shift && this.pts ? snap45(this.pts[this.pts.length - 1], i) : { x: i.x, y: i.y }; },
  move(i) { this.cur = { x: i.x, y: i.y }; },
  dblclick() { this.finish(); },
  keydown(e) {
    if (!this.pts) return false;
    if (e.key === 'Enter') { this.finish(); return true; }
    if (e.key === 'Escape') { this.pts = null; return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); if (!this.pts.length) this.pts = null; return true; }
    return false;
  },
  finish() {
    const doc = app.doc, pts = this.pts; this.pts = null;
    if (!pts || pts.length < 3) return;
    const o = opt('polyLasso');
    apply(doc, polySel(doc, pts, o.feather, o.antiAlias), this.mode, 'Polygonal Lasso');
  },
  deactivate() { this.pts = null; },
  overlay(g, v) { if (!this.pts) return; drawPoly(g, v, this.pts, true, this.cur); },
});
function snap45(a, p) {
  const dx = p.x - a.x, dy = p.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
}

// ---------- Magic wand ----------
export function sampleImage(doc, sampleAll) {
  if (sampleAll || !doc.active || !doc.active.canvas) { const c = doc.render(); return { img: ctx2d(c).getImageData(0, 0, doc.width, doc.height), ox: 0, oy: 0, w: doc.width, h: doc.height }; }
  const L = doc.active, c = createCanvas(doc.width, doc.height); ctx2d(c).drawImage(doc.layerContent(L).canvas, L.x, L.y);
  return { img: ctx2d(c).getImageData(0, 0, doc.width, doc.height), ox: 0, oy: 0, w: doc.width, h: doc.height };
}
registerTool({
  id: 'magicWand', label: 'Magic Wand Tool', icon: 'magicWand', key: 'W', group: 'quickSelect', cursor: 'crosshair',
  defaults: { mode: 'new', tolerance: 32, antiAlias: true, contiguous: true, sampleAll: false },
  down(i) {
    const doc = app.doc, o = opt('magicWand'), mode = modeFor(i, 'magicWand');
    const s = sampleImage(doc, o.sampleAll);
    const m = magicWand(s.img, s.w, s.h, i.x, i.y, { tolerance: o.tolerance, contiguous: o.contiguous, antiAlias: o.antiAlias });
    apply(doc, selFromMask(doc, m), mode, 'Magic Wand');
  },
});

// ---------- Quick selection ----------
registerTool({
  id: 'quickSelect', label: 'Quick Selection Tool', icon: 'quickSelect', key: 'W', group: 'quickSelect',
  defaults: { mode: 'add', size: 30, sampleAll: false, enhanceEdge: true },
  brushCursor() { return { size: opt('quickSelect').size, crosshair: true }; },
  down(i) {
    const doc = app.doc, o = opt('quickSelect');
    this.sub = i.alt || o.mode === 'subtract';
    this.src = sampleImage(doc, o.sampleAll);
    this.acc = new Uint8Array(doc.width * doc.height);
    if (!doc.selection || (o.mode === 'new' && !i.shift)) this.base = null; else this.base = cloneCanvas(doc.selection);
    this.seeds = []; this.stats = { r: 0, g: 0, b: 0, rr: 0, gg: 0, bb: 0, n: 0 };
    this.last = null; this.paint(i);
  },
  move(i) { if (!this.acc) return; this.paint(i); },
  paint(i) {
    const doc = app.doc, o = opt('quickSelect'), W = doc.width, H = doc.height, d = this.src.img.data, R = o.size / 2;
    const pts = [];
    if (this.last) { const dist = Math.hypot(i.x - this.last.x, i.y - this.last.y), n = Math.max(1, Math.ceil(dist / (R / 2))); for (let k = 1; k <= n; k++) pts.push({ x: this.last.x + (i.x - this.last.x) * k / n, y: this.last.y + (i.y - this.last.y) * k / n }); }
    else pts.push({ x: i.x, y: i.y });
    this.last = { x: i.x, y: i.y };
    const st = this.stats, stack = [];
    for (const p of pts) {
      for (let y = Math.max(0, Math.floor(p.y - R)); y < Math.min(H, Math.ceil(p.y + R)); y++) for (let x = Math.max(0, Math.floor(p.x - R)); x < Math.min(W, Math.ceil(p.x + R)); x++) {
        if ((x - p.x) ** 2 + (y - p.y) ** 2 > R * R) continue;
        const k = y * W + x; if (this.acc[k]) continue;
        const j = k * 4; st.r += d[j]; st.g += d[j + 1]; st.b += d[j + 2]; st.rr += d[j] * d[j]; st.gg += d[j + 1] * d[j + 1]; st.bb += d[j + 2] * d[j + 2]; st.n++;
        this.acc[k] = 255; stack.push(k);
      }
    }
    // region grow around the brush within a window, using color statistics + gradient barrier
    const n = st.n || 1, mr = st.r / n, mg = st.g / n, mb = st.b / n;
    const sd = Math.sqrt(Math.max(0, (st.rr / n - mr * mr) + (st.gg / n - mg * mg) + (st.bb / n - mb * mb)));
    const tol = clamp(sd * 1.6 + 18, 22, 90);
    const win = R * 3.5, cx = i.x, cy = i.y;
    let guard = 0;
    while (stack.length && guard++ < 400000) {
      const k = stack.pop(), x = k % W, y = (k - x) / W;
      for (const nb of [k - 1, k + 1, k - W, k + W]) {
        if (nb < 0 || nb >= W * H || this.acc[nb]) continue;
        const nx = nb % W, ny = (nb - nx) / W; if (Math.abs(nx - x) > 1) continue;
        if (Math.abs(nx - cx) > win || Math.abs(ny - cy) > win) continue;
        const j = nb * 4, jj = k * 4;
        const dist = Math.sqrt((d[j] - mr) ** 2 + (d[j + 1] - mg) ** 2 + (d[j + 2] - mb) ** 2);
        const edge = Math.abs(d[j] - d[jj]) + Math.abs(d[j + 1] - d[jj + 1]) + Math.abs(d[j + 2] - d[jj + 2]);
        if (dist < tol && edge < tol * 1.2) { this.acc[nb] = 255; stack.push(nb); }
      }
    }
    const sel = selFromMask(doc, this.acc);
    let res;
    if (this.base) { res = cloneCanvas(this.base); const g = ctx2d(res); g.globalCompositeOperation = this.sub ? 'destination-out' : 'source-over'; g.drawImage(sel, 0, 0); }
    else res = this.sub ? null : sel;
    doc.selection = res; doc.selRev++; app.emit('selection');
  },
  up() {
    const doc = app.doc; if (!this.acc) return; this.acc = null;
    let s = doc.selection;
    if (s && opt('quickSelect').enhanceEdge) { s = featherCanvas(s, 1.2); }
    doc.setSelection(s); doc.commit('Quick Selection', 'quickSelect');
  },
});

// ---------- Object selection (AI) ----------
registerTool({
  id: 'objectSelect', label: 'Object Selection Tool', icon: 'objectSelect', key: 'W', group: 'quickSelect', cursor: 'crosshair',
  defaults: { mode: 'new', drawMode: 'rect', sampleAll: true, hover: false },
  down(i) { this.mode = modeFor(i, 'objectSelect'); this.p0 = { x: i.x, y: i.y }; this.p1 = { ...this.p0 }; this.pts = [this.p0]; },
  move(i) { if (!this.p0) return; this.p1 = { x: i.x, y: i.y }; if (opt('objectSelect').drawMode === 'lasso') this.pts.push(this.p1); },
  async up(i) {
    const doc = app.doc, o = opt('objectSelect'); if (!this.p0) return;
    let r = { x: Math.min(this.p0.x, this.p1.x), y: Math.min(this.p0.y, this.p1.y), w: Math.abs(this.p1.x - this.p0.x), h: Math.abs(this.p1.y - this.p0.y) };
    const pts = this.pts; this.p0 = null;
    if (o.drawMode === 'lasso') { const xs = pts.map(p => p.x), ys = pts.map(p => p.y); r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    if (!app.ai) { toast('AI features are not available.', 'err'); return; }
    if (r.w < 4 || r.h < 4) { r = null; }
    await withBusy('Selecting object…', async (prog) => {
      const mask = await app.ai.selectSubject(doc, { region: r, sampleAll: o.sampleAll, onProgress: prog });
      if (!mask) return;
      if (o.drawMode === 'lasso' && pts.length > 2) { const lim = selToMask(polySel(doc, pts, 0, true)); for (let k = 0; k < mask.length; k++) mask[k] = Math.min(mask[k], Math.min(255, lim[k] * 4)); }
      apply(doc, selFromMask(doc, mask), this.mode, 'Object Selection');
    });
  },
  overlay(g, v) {
    if (!this.p0) return;
    if (opt('objectSelect').drawMode === 'lasso') return drawPoly(g, v, this.pts, false);
    const a = v.toScreen(this.p0.x, this.p0.y), b = v.toScreen(this.p1.x, this.p1.y);
    g.setLineDash([4, 4]); g.strokeStyle = '#fff'; g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); g.setLineDash([]);
  },
});
