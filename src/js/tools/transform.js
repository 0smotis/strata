// Free Transform (Ctrl+T), Transform Selection, and instant flips/rotations.
import { app } from '../state.js';
import { createCanvas, ctx2d, cloneCanvas, alphaBounds, clamp } from '../util.js';
import { mulTx, invTx, applyTx, refreshVector } from '../doc/document.js';
import { toast } from '../ui/common.js';
import { requestDraw, refreshCursor } from '../view/viewport.js';

const T = (x, y) => [1, 0, 0, 1, x, y];
const S = (sx, sy) => [sx, 0, 0, sy, 0, 0];
const R = (a) => [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
const chain = (...ms) => ms.reduce((a, b) => mulTx(a, b));

export function startTransform(doc, { selectionOnly = false, silentFail = false } = {}) {
  if (app.transform) return app.transform;
  const L = doc.active;
  let kind, src, base, rest = null, layer = L;
  if (selectionOnly) {
    if (!doc.selection) { toast('There is no selection to transform.', 'err'); return null; }
    const b = doc.selBounds || alphaBounds(doc.selection);
    src = createCanvas(b.w, b.h); ctx2d(src).drawImage(doc.selection, -b.x, -b.y);
    kind = 'selection'; base = b; layer = null;
  } else {
    if (!L) { toast('There is no active layer.', 'err'); return null; }
    if (L.locks.all || L.locks.position) { toast(L.locks.background ? 'Could not complete the Free Transform command because the layer is locked (Background). Convert it to a regular layer first.' : 'Could not complete the Free Transform command because the layer is locked.', 'err'); return null; }
    if (L.kind === 'text' || L.kind === 'shape' || L.kind === 'smart') {
      kind = 'vector';
      const b = L.bounds() || { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height };
      base = b; src = null;
    } else if (L.kind === 'pixel') {
      kind = 'pixel';
      if (doc.selection) {
        // float the selected pixels
        const sb = doc.selBounds || alphaBounds(doc.selection);
        const full = createCanvas(doc.width, doc.height), fg = ctx2d(full);
        fg.drawImage(L.canvas, L.x, L.y); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(doc.selection, 0, 0);
        const b = alphaBounds(full);
        if (!b) { toast('Could not transform because the selected area is empty.', 'err'); return null; }
        src = createCanvas(b.w, b.h); ctx2d(src).drawImage(full, -b.x, -b.y);
        base = b;
        rest = cloneCanvas(L.canvas); const rg = ctx2d(rest);
        if (L.locks.background) { const fillC = createCanvas(doc.width, doc.height), fc = ctx2d(fillC); fc.fillStyle = app.bg; fc.fillRect(0, 0, doc.width, doc.height); fc.globalCompositeOperation = 'destination-in'; fc.drawImage(doc.selection, 0, 0); rg.drawImage(fillC, -L.x, -L.y); }
        else { rg.globalCompositeOperation = 'destination-out'; rg.drawImage(doc.selection, -L.x, -L.y); }
        kind = 'float';
      } else {
        const b = L.bounds();
        if (!b) { if (!silentFail) toast('Could not complete the Free Transform command because the layer is empty.', 'err'); return null; }
        src = createCanvas(b.w, b.h); ctx2d(src).drawImage(L.canvas, L.x - b.x, L.y - b.y);
        base = b;
      }
    } else { toast('Free Transform is not available for this layer type.', 'err'); return null; }
  }
  const tr = new Transformer(doc, { kind, layer, src, base, rest });
  app.transform = tr;
  app.emit('transform');
  tr.preview();
  return tr;
}

class Transformer {
  constructor(doc, { kind, layer, src, base, rest }) {
    Object.assign(this, { doc, kind, layer, src, base, rest });
    this.w = base.w; this.h = base.h;
    this.M0 = T(base.x, base.y); this.M = [...this.M0];
    this.tx0 = layer ? [...layer.tx] : null;
    this.origSel = doc.selection;
    this.interp = 'bicubic';
    this.drag = null;
  }
  corners() { return [[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]].map(([x, y]) => applyTx(this.M, x, y)); }
  handles() {
    const w = this.w, h = this.h;
    return [['nw', 0, 0], ['n', w / 2, 0], ['ne', w, 0], ['e', w, h / 2], ['se', w, h], ['s', w / 2, h], ['sw', 0, h], ['w', 0, h / 2]].map(([id, x, y]) => ({ id, lx: x, ly: y, ...applyTx(this.M, x, y) }));
  }
  center() { return applyTx(this.M, this.w / 2, this.h / 2); }
  angle() { return Math.atan2(this.M[1], this.M[0]); }
  scaleX() { return Math.hypot(this.M[0], this.M[1]); }
  scaleY() { return Math.sign(this.M[0] * this.M[3] - this.M[1] * this.M[2]) * Math.hypot(this.M[2], this.M[3]); }

  hit(i) {
    const z = this.doc.view.zoom, tol = 6 / z;
    for (const h of this.handles()) if (Math.abs(i.x - h.x) < tol && Math.abs(i.y - h.y) < tol) return { type: 'scale', h };
    const inv = invTx(this.M), l = applyTx(inv, i.x, i.y);
    if (l.x >= 0 && l.y >= 0 && l.x <= this.w && l.y <= this.h) return { type: 'move' };
    return { type: 'rotate' };
  }
  cursor(p) {
    if (!p) return 'default';
    const h = this.hit(p);
    if (h.type === 'move') return 'move';
    if (h.type === 'rotate') return 'alias';
    const a = this.angle() * 180 / Math.PI;
    const base = { n: 90, s: 90, e: 0, w: 0, ne: 45, sw: 45, nw: 135, se: 135 }[h.h.id];
    const ang = ((base - a) % 180 + 180) % 180;
    return ang < 22.5 || ang > 157.5 ? 'ew-resize' : ang < 67.5 ? 'nesw-resize' : ang < 112.5 ? 'ns-resize' : 'nwse-resize';
  }
  down(i) {
    const h = this.hit(i);
    this.drag = { ...h, p0: { x: i.x, y: i.y }, M0: [...this.M], c0: this.center() };
  }
  move(i) {
    const d = this.drag; if (!d) return;
    if (d.type === 'move') {
      let dx = i.x - d.p0.x, dy = i.y - d.p0.y;
      if (i.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      this.M = mulTx(T(dx, dy), d.M0);
    } else if (d.type === 'rotate') {
      const c = d.c0;
      let a = Math.atan2(i.y - c.y, i.x - c.x) - Math.atan2(d.p0.y - c.y, d.p0.x - c.x);
      if (i.shift) { const cur = Math.atan2(d.M0[1], d.M0[0]); const tgt = Math.round((cur + a) / (Math.PI / 12)) * (Math.PI / 12); a = tgt - cur; }
      this.M = chain(T(c.x, c.y), R(a), T(-c.x, -c.y), d.M0);
    } else {
      const inv = invTx(d.M0), l = applyTx(inv, i.x, i.y), h = d.h;
      const id = h.id, w = this.w, hh = this.h;
      const ax = i.alt ? w / 2 : (id.includes('w') ? w : id.includes('e') ? 0 : w / 2);
      const ay = i.alt ? hh / 2 : (id.includes('n') ? hh : id.includes('s') ? 0 : hh / 2);
      let sx = id.includes('e') || id.includes('w') ? (l.x - ax) / ((h.lx - ax) || 1) : 1;
      let sy = id.includes('n') || id.includes('s') ? (l.y - ay) / ((h.ly - ay) || 1) : 1;
      const corner = id.length === 2;
      const proportional = corner ? !i.shift : i.shift;
      if (proportional) {
        if (corner) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = Math.sign(sx || 1) * Math.abs(s); sy = Math.sign(sy || 1) * Math.abs(s); }
        else if (id === 'n' || id === 's') sx = Math.abs(sy); else sy = Math.abs(sx);
      }
      if (Math.abs(sx) < 1e-3) sx = 1e-3 * Math.sign(sx || 1); if (Math.abs(sy) < 1e-3) sy = 1e-3 * Math.sign(sy || 1);
      this.M = chain(d.M0, T(ax, ay), S(sx, sy), T(-ax, -ay));
    }
    this.preview();
  }
  up() { this.drag = null; app.emit('transform'); }

  setNumeric({ x, y, sx, sy, angle }) {
    const c = this.center();
    const cx = x ?? c.x, cy = y ?? c.y;
    const scx = sx ?? this.scaleX(), scy = sy ?? this.scaleY(), a = angle ?? this.angle();
    this.M = chain(T(cx, cy), R(a), S(scx, scy), T(-this.w / 2, -this.h / 2));
    this.preview(); app.emit('transform');
  }
  flip(axis) {
    const c = this.center();
    this.M = chain(T(c.x, c.y), axis === 'h' ? S(-1, 1) : S(1, -1), T(-c.x, -c.y), this.M);
    this.preview();
  }
  rotateBy(deg) {
    const c = this.center();
    this.M = chain(T(c.x, c.y), R(deg * Math.PI / 180), T(-c.x, -c.y), this.M);
    this.preview();
  }
  bounds() {
    const cs = this.corners(), xs = cs.map(p => p.x), ys = cs.map(p => p.y);
    const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
    return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
  }
  renderSrc(target, ox, oy, hq) {
    const g = ctx2d(target);
    g.save();
    g.imageSmoothingEnabled = this.interp !== 'nearest'; g.imageSmoothingQuality = hq ? 'high' : 'medium';
    const m = this.M; g.setTransform(m[0], m[1], m[2], m[3], m[4] - ox, m[5] - oy);
    g.drawImage(this.src, 0, 0);
    g.restore();
  }
  preview() {
    const doc = this.doc;
    if (this.kind === 'vector') {
      const L = this.layer;
      L.tx = chain(this.M, invTx(this.M0), this.tx0); L.touch();
    } else if (this.kind === 'selection') {
      const c = createCanvas(doc.width, doc.height); this.renderSrc(c, 0, 0, false);
      doc.selection = c; doc.selRev++; app.emit('selection');
    } else {
      const P = createCanvas(doc.width, doc.height);
      if (this.rest) ctx2d(P).drawImage(this.rest, this.layer.x, this.layer.y);
      this.renderSrc(P, 0, 0, false);
      doc.preview = { layerId: this.layer.id, canvas: P, x: 0, y: 0, ver: (doc.preview?.ver || 0) + 1 };
      if (this.kind === 'float') {
        const sc = createCanvas(doc.width, doc.height);
        const selSrc = createCanvas(this.w, this.h); ctx2d(selSrc).drawImage(this.origSel, -this.base.x, -this.base.y);
        const g = ctx2d(sc); const m = this.M; g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]); g.drawImage(selSrc, 0, 0);
        doc.selection = sc; doc.selRev++; app.emit('selection');
      }
    }
    doc.invalidate(); requestDraw();
  }
  commit(name) {
    const doc = this.doc;
    if (this.kind === 'vector') { /* tx already set */ this.layer.touch(true); }
    else if (this.kind === 'selection') { doc.setSelection(doc.selection); }
    else {
      const L = this.layer, b = this.bounds();
      const restB = this.rest ? { x: L.x, y: L.y, w: this.rest.width, h: this.rest.height } : null;
      const U = restB ? { x: Math.min(b.x, restB.x), y: Math.min(b.y, restB.y), w: Math.max(b.x + b.w, restB.x + restB.w) - Math.min(b.x, restB.x), h: Math.max(b.y + b.h, restB.y + restB.h) - Math.min(b.y, restB.y) } : b;
      const c = createCanvas(U.w, U.h);
      if (this.rest) ctx2d(c).drawImage(this.rest, restB.x - U.x, restB.y - U.y);
      this.renderSrc(c, U.x, U.y, true);
      L.canvas = c; L.x = U.x; L.y = U.y; L.touch(true);
      doc.preview = null;
      if (this.kind === 'float') doc.setSelection(doc.selection);
    }
    this.end();
    doc.commit(name || (this.kind === 'selection' ? 'Transform Selection' : 'Free Transform'), name ? 'move' : 'transform');
  }
  cancel() {
    const doc = this.doc;
    if (this.kind === 'vector') { this.layer.tx = this.tx0; this.layer.touch(); }
    else { doc.preview = null; }
    if (this.kind === 'selection' || this.kind === 'float') { doc.selection = this.origSel; doc.selRev++; app.emit('selection'); }
    this.end(); doc.invalidate();
  }
  end() { app.transform = null; app.emit('transform'); refreshCursor(); requestDraw(); }
  keydown(e) {
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    const step = e.shiftKey ? 10 : 1;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (mv) { this.M = mulTx(T(mv[0], mv[1]), this.M); this.preview(); app.emit('transform'); return true; }
    return false;
  }
  dblclick() { this.commit(); }
  overlay(g, v) {
    const cs = this.corners().map(p => v.toScreen(p.x, p.y));
    g.strokeStyle = '#2680eb'; g.lineWidth = 1; g.beginPath(); cs.forEach((p, k) => k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)); g.closePath(); g.stroke();
    for (const h of this.handles()) { const s = v.toScreen(h.x, h.y); g.fillStyle = '#fff'; g.fillRect(s.x - 4, s.y - 4, 8, 8); g.strokeRect(s.x - 4.5, s.y - 4.5, 9, 9); }
    const c = v.toScreen(this.center().x, this.center().y);
    g.beginPath(); g.arc(c.x, c.y, 4, 0, Math.PI * 2); g.strokeStyle = '#fff'; g.stroke(); g.beginPath(); g.moveTo(c.x - 7, c.y); g.lineTo(c.x + 7, c.y); g.moveTo(c.x, c.y - 7); g.lineTo(c.x, c.y + 7); g.strokeStyle = '#2680eb'; g.stroke();
    if (this.drag) {
      const txt = this.drag.type === 'rotate' ? `${(this.angle() * 180 / Math.PI).toFixed(1)}°` : this.drag.type === 'move' ? `ΔX: ${Math.round(this.center().x - this.drag.c0.x)} ΔY: ${Math.round(this.center().y - this.drag.c0.y)}` : `W: ${(Math.abs(this.scaleX()) * 100).toFixed(1)}%  H: ${(Math.abs(this.scaleY()) * 100).toFixed(1)}%`;
      const p = cs[2]; g.fillStyle = 'rgba(0,0,0,.75)'; g.font = '11px Segoe UI'; const tw = g.measureText(txt).width; g.fillRect(p.x + 10, p.y + 10, tw + 12, 20); g.fillStyle = '#fff'; g.fillText(txt, p.x + 16, p.y + 24);
    }
  }
}

export function instantTransform(doc, op) {
  const L = doc.active;
  if (L && L.kind === 'group') { toast('Transform the layers inside the group individually.', 'err'); return; }
  const tr = startTransform(doc, { silentFail: true });
  if (!tr) return;
  if (op === 'flipH') tr.flip('h'); else if (op === 'flipV') tr.flip('v');
  else if (op === 'rot90') tr.rotateBy(90); else if (op === 'rot-90') tr.rotateBy(-90); else if (op === 'rot180') tr.rotateBy(180);
  tr.commit();
}
