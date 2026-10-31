// Pen tools: Pen, Freeform Pen, Curvature-lite, Add/Delete Anchor, Convert Point, Path Selection, Direct Selection
import { app, cmd } from '../state.js';
import { registerTool, opt } from './base.js';
import { Layer, invTx, applyTx } from '../doc/document.js';
import { clonePaths, anchor, hitAnchor, hitHandle, hitSegment, splitSegment, insidePath, fitCurve, shapeToSubpaths, newPathRecord, buildPath2D, segCount, segment, bez } from '../doc/paths.js';
import { requestDraw } from '../view/viewport.js';
import { toast } from '../ui/common.js';

// ---------- path targets ----------
const mapPaths = (sp, m) => { const out = clonePaths(sp); for (const s of out) for (const p of s.pts) for (const q of [p, p.in, p.out]) if (q) { const a = applyTx(m, q.x, q.y); q.x = a.x; q.y = a.y; } return out; };
export function activePathRecord(doc) { return (doc.paths || []).find(p => p.id === doc.activePathId) || null; }
export function pathTarget(doc, { create = false } = {}) {
  const L = doc.active;
  if (L && L.kind === 'shape' && app.pathEditLayer !== false) {
    return {
      kind: 'shape', layer: L,
      get() { const d = L.data; const sp = d.shape === 'path' ? d.subpaths : shapeToSubpaths(d); return mapPaths(sp, L.tx); },
      set(sp) { const d = L.data; if (d.shape !== 'path') { d.shape = 'path'; } d.subpaths = mapPaths(sp, invTx(L.tx)); L.touch(); doc.invalidate(); },
      name: 'Edit Shape',
    };
  }
  if (L && L.vmask && app.vmaskEdit) return { kind: 'vmask', layer: L, get: () => clonePaths(L.vmask.subpaths), set(sp) { L.vmask.subpaths = clonePaths(sp); L.touch(); doc.invalidate(); }, name: 'Edit Vector Mask' };
  let rec = activePathRecord(doc);
  if (!rec && create) {
    doc.paths = (doc.paths || []).filter(p => p.kind !== 'work');
    rec = newPathRecord('Work Path', [], 'work'); doc.paths.push(rec); doc.activePathId = rec.id; doc.emit('paths');
  }
  if (!rec) return null;
  return { kind: 'path', rec, get: () => clonePaths(rec.subpaths), set(sp) { rec.subpaths = clonePaths(sp); doc.emit('paths'); requestDraw(); }, name: 'Edit Path' };
}

// ---------- drawing helpers ----------
const tolPx = (px = 5) => px / app.doc.view.zoom;
export function drawPathOverlay(g, v, sp, sel, opts = {}) {
  if (!sp || !sp.length) return;
  g.save();
  g.translate(v.o.x, v.o.y); g.scale(v.z, v.z);
  g.lineWidth = 1.25 / v.z; g.strokeStyle = opts.color || '#2b7bff';
  g.stroke(buildPath2D(sp));
  g.restore();
  const S = (p) => v.toScreen(p.x, p.y);
  sp.forEach((s, si) => s.pts.forEach((p, i) => {
    const key = si + ':' + i, isSel = sel && sel.has(key);
    const a = S(p);
    if (isSel || opts.showAllHandles) {
      g.strokeStyle = '#2b7bff'; g.lineWidth = 1;
      for (const h of ['in', 'out']) if (p[h]) { const b = S(p[h]); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.fillStyle = '#2b7bff'; g.beginPath(); g.arc(b.x, b.y, 3, 0, Math.PI * 2); g.fill(); }
    }
    if (opts.anchors !== false) { g.fillStyle = isSel ? '#2b7bff' : '#fff'; g.strokeStyle = '#2b7bff'; g.lineWidth = 1; g.fillRect(a.x - 3.5, a.y - 3.5, 7, 7); g.strokeRect(a.x - 3.5, a.y - 3.5, 7, 7); }
  }));
}
function snap45(a, p) { const dx = p.x - a.x, dy = p.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, l = Math.hypot(dx, dy); return { x: a.x + Math.cos(ang) * l, y: a.y + Math.sin(ang) * l }; }
function commitTarget(t, name) { app.doc.commit(name || t.name, 'pen'); }

// ---------- Pen ----------
registerTool({
  id: 'pen', label: 'Pen Tool', icon: 'pen', key: 'P', group: 'pen', cursor: 'crosshair',
  defaults: { mode: 'shape', autoAddDelete: true, rubberBand: true, fill: null, stroke: null, strokeWidth: 3 },
  activate() { this.drawing = null; },
  deactivate() { this.finish(); },
  startShapeLayer(doc) {
    const o = opt('pen');
    const L = new Layer('shape', { name: doc.nextName('Shape'), tx: [1, 0, 0, 1, 0, 0], data: { shape: 'path', subpaths: [], fill: o.fill || app.fg, stroke: o.stroke, strokeWidth: o.strokeWidth } });
    doc.addLayer(L);
    return L;
  },
  down(i) {
    const doc = app.doc, o = opt('pen');
    if (i.ctrl) { this.finish(); return; } // Ctrl-click: end path
    let p = { x: i.x, y: i.y };
    if (this.drawing) {
      const t = this.drawing.t, sp = t.get(), s = sp[this.drawing.si];
      const first = s.pts[0], last = s.pts[s.pts.length - 1];
      if (i.shift) p = snap45(last, p);
      if (s.pts.length > 1 && Math.abs(first.x - i.x) < tolPx(6) && Math.abs(first.y - i.y) < tolPx(6)) {
        s.closed = true; t.set(sp); this.drag = { closing: true, si: this.drawing.si }; return;
      }
      s.pts.push(anchor(p.x, p.y)); t.set(sp);
      this.drag = { si: this.drawing.si, i: s.pts.length - 1, start: p };
      return;
    }
    // not drawing: auto add/delete on the visible target
    const existing = pathTarget(doc);
    if (o.autoAddDelete && existing) {
      const sp = existing.get();
      const ha = hitAnchor(sp, i.x, i.y, tolPx(5));
      if (ha && !i.alt) { sp[ha.si].pts.splice(ha.i, 1); if (sp[ha.si].pts.length < 2) sp.splice(ha.si, 1); existing.set(sp); commitTarget(existing, 'Delete Anchor Point'); return; }
      if (ha && i.alt) { convertAnchor(existing, ha); return; }
      const hs = hitSegment(sp, i.x, i.y, tolPx(4));
      if (hs) { splitSegment(sp[hs.si], hs.i, hs.t); existing.set(sp); commitTarget(existing, 'Add Anchor Point'); return; }
    }
    // start a new subpath
    let t;
    if (o.mode === 'shape') {
      const L = doc.active;
      if (!(L && L.kind === 'shape' && L.data.shape === 'path' && this.continueLayer === L.id)) { const nl = this.startShapeLayer(doc); this.continueLayer = nl.id; }
      t = pathTarget(doc);
    } else {
      app.pathEditLayer = false;
      t = pathTarget(doc, { create: true });
      app.pathEditLayer = true;
      const rec = t.rec; const tt = t; t = { ...tt, get: () => clonePaths(rec.subpaths) };
    }
    const sp = t.get(); sp.push({ closed: false, pts: [anchor(p.x, p.y)] });
    t.set(sp);
    this.drawing = { t, si: sp.length - 1 };
    this.drag = { si: sp.length - 1, i: 0, start: p };
  },
  move(i) {
    if (!this.drag || !this.drawing) return;
    const t = this.drawing.t, sp = t.get();
    if (this.drag.closing) { const s = sp[this.drag.si], a = s.pts[0]; const d = { x: i.x - a.x, y: i.y - a.y }; if (Math.hypot(d.x, d.y) > tolPx(2)) { a.out = { x: a.x + d.x, y: a.y + d.y }; a.in = { x: a.x - d.x, y: a.y - d.y }; a.smooth = true; } t.set(sp); return; }
    const s = sp[this.drag.si], a = s.pts[this.drag.i];
    let q = { x: i.x, y: i.y }; if (i.shift) q = snap45(a, q);
    if (Math.hypot(q.x - a.x, q.y - a.y) > tolPx(2)) { a.out = { x: q.x, y: q.y }; a.in = { x: 2 * a.x - q.x, y: 2 * a.y - q.y }; a.smooth = true; }
    t.set(sp);
  },
  up() {
    if (!this.drag) return;
    const closing = this.drag.closing; this.drag = null;
    if (closing) { const t = this.drawing.t; this.drawing = null; commitTarget(t, t.kind === 'shape' ? 'Shape' : 'Close Path'); this.continueLayer = null; }
  },
  hover(i) { this.hoverPt = { x: i.x, y: i.y, shift: i.shift }; },
  finish() {
    if (!this.drawing) return;
    const t = this.drawing.t; this.drawing = null; this.drag = null; this.continueLayer = null;
    const sp = t.get(); const last = sp[sp.length - 1];
    if (last && last.pts.length < 2) { sp.pop(); t.set(sp); if (t.kind === 'shape' && !sp.length) { app.doc.removeLayer(t.layer.id); return; } }
    commitTarget(t, t.kind === 'shape' ? 'Shape' : 'Pen');
  },
  keydown(e) {
    if (!this.drawing) return false;
    if (e.key === 'Enter' || e.key === 'Escape') { this.finish(); return true; }
    if (e.key === 'Backspace' || e.key === 'Delete') { const t = this.drawing.t, sp = t.get(), s = sp[this.drawing.si]; s.pts.pop(); if (!s.pts.length) { sp.pop(); this.drawing = null; } t.set(sp); return true; }
    return false;
  },
  overlay(g, v) {
    const doc = app.doc, t = this.drawing ? this.drawing.t : pathTarget(doc); if (!t) return;
    const sp = t.get();
    const sel = new Set(); if (this.drawing) { const s = sp[this.drawing.si]; if (s) sel.add(this.drawing.si + ':' + (s.pts.length - 1)); }
    drawPathOverlay(g, v, sp, sel);
    if (this.drawing && opt('pen').rubberBand && this.hoverPt && !this.drag) {
      const s = sp[this.drawing.si]; if (!s || s.closed) return; const a = s.pts[s.pts.length - 1]; let b = this.hoverPt; if (b.shift) b = snap45(a, b);
      const A = v.toScreen(a.x, a.y), B = v.toScreen(b.x, b.y), C = a.out ? v.toScreen(a.out.x, a.out.y) : A;
      g.strokeStyle = 'rgba(43,123,255,.8)'; g.lineWidth = 1; g.beginPath(); g.moveTo(A.x, A.y); g.bezierCurveTo(C.x, C.y, B.x, B.y, B.x, B.y); g.stroke();
    }
  },
  cursor(p) {
    if (!p || this.drawing) { if (this.drawing && p) { const s = this.drawing.t.get()[this.drawing.si]; if (s && s.pts.length > 1 && Math.abs(s.pts[0].x - p.x) < tolPx(6) && Math.abs(s.pts[0].y - p.y) < tolPx(6)) return 'cell'; } return 'crosshair'; }
    return 'crosshair';
  },
});

function convertAnchor(t, ha) {
  const sp = t.get(), p = sp[ha.si].pts[ha.i];
  if (p.in || p.out) { p.in = null; p.out = null; p.smooth = false; }
  else { const s = sp[ha.si], n = s.pts.length, prev = s.pts[(ha.i - 1 + n) % n], next = s.pts[(ha.i + 1) % n]; const dx = (next.x - prev.x) / 6, dy = (next.y - prev.y) / 6; p.in = { x: p.x - dx, y: p.y - dy }; p.out = { x: p.x + dx, y: p.y + dy }; p.smooth = true; }
  t.set(sp); commitTarget(t, 'Convert Point');
}

// ---------- Freeform Pen ----------
registerTool({
  id: 'freeformPen', label: 'Freeform Pen Tool', icon: 'penFree', key: 'P', group: 'pen', cursor: 'crosshair',
  defaults: { mode: 'shape', fit: 2 },
  down(i) { this.pts = [{ x: i.x, y: i.y }]; },
  move(i) { if (this.pts) { const l = this.pts[this.pts.length - 1]; if (Math.hypot(i.x - l.x, i.y - l.y) * app.doc.view.zoom > 2) this.pts.push({ x: i.x, y: i.y }); } },
  up() {
    const pts = this.pts; this.pts = null; if (!pts || pts.length < 3) return;
    const doc = app.doc, o = opt('freeformPen');
    const first = pts[0], last = pts[pts.length - 1];
    const closed = Math.hypot(first.x - last.x, first.y - last.y) * doc.view.zoom < 10;
    const sub = fitCurve(pts, Math.max(0.5, o.fit) / Math.min(1, doc.view.zoom), closed);
    let t;
    if (o.mode === 'shape') { const pen = app.tools.pen; pen.startShapeLayer(doc); t = pathTarget(doc); }
    else { app.pathEditLayer = false; t = pathTarget(doc, { create: true }); app.pathEditLayer = true; }
    const sp = t.get(); sp.push(sub); t.set(sp);
    commitTarget(t, 'Freeform Pen');
  },
  overlay(g, v) {
    if (this.pts) { g.strokeStyle = '#2b7bff'; g.lineWidth = 1; g.beginPath(); this.pts.forEach((p, k) => { const s = v.toScreen(p.x, p.y); k ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y); }); g.stroke(); }
    const t = pathTarget(app.doc); if (t) drawPathOverlay(g, v, t.get(), null, { anchors: false });
  },
});

// ---------- Add / Delete / Convert ----------
registerTool({
  id: 'addAnchor', label: 'Add Anchor Point Tool', icon: 'penAdd', key: 'P', group: 'pen', cursor: 'crosshair', defaults: {},
  down(i) { const t = pathTarget(app.doc); if (!t) return; const sp = t.get(); const hs = hitSegment(sp, i.x, i.y, tolPx(5)); if (!hs) return; splitSegment(sp[hs.si], hs.i, hs.t); t.set(sp); commitTarget(t, 'Add Anchor Point'); },
  overlay(g, v) { const t = pathTarget(app.doc); if (t) drawPathOverlay(g, v, t.get(), null); },
});
registerTool({
  id: 'deleteAnchor', label: 'Delete Anchor Point Tool', icon: 'penDelete', key: 'P', group: 'pen', cursor: 'crosshair', defaults: {},
  down(i) { const t = pathTarget(app.doc); if (!t) return; const sp = t.get(); const ha = hitAnchor(sp, i.x, i.y, tolPx(5)); if (!ha) return; sp[ha.si].pts.splice(ha.i, 1); if (sp[ha.si].pts.length < 2) sp.splice(ha.si, 1); t.set(sp); commitTarget(t, 'Delete Anchor Point'); },
  overlay(g, v) { const t = pathTarget(app.doc); if (t) drawPathOverlay(g, v, t.get(), null); },
});
registerTool({
  id: 'convertPoint', label: 'Convert Point Tool', icon: 'convertPoint', key: 'P', group: 'pen', cursor: 'default', defaults: {},
  down(i) {
    const t = pathTarget(app.doc); if (!t) return; const sp = t.get();
    const all = new Set(sp.flatMap((s, si) => s.pts.map((_, k) => si + ':' + k)));
    const hh = hitHandle(sp, all, i.x, i.y, tolPx(5));
    if (hh) { this.drag = { t, kind: 'handle', ...hh }; sp[hh.si].pts[hh.i].smooth = false; t.set(sp); return; }
    const ha = hitAnchor(sp, i.x, i.y, tolPx(5)); if (!ha) return;
    this.drag = { t, kind: 'anchor', ...ha, moved: false };
  },
  move(i) {
    const d = this.drag; if (!d) return; const sp = d.t.get(), p = sp[d.si].pts[d.i];
    if (d.kind === 'handle') { p[d.h] = { x: i.x, y: i.y }; }
    else { d.moved = true; p.out = { x: i.x, y: i.y }; p.in = { x: 2 * p.x - i.x, y: 2 * p.y - i.y }; p.smooth = true; }
    d.t.set(sp);
  },
  up() { const d = this.drag; this.drag = null; if (!d) return; if (d.kind === 'anchor' && !d.moved) { convertAnchor(d.t, d); return; } commitTarget(d.t, 'Convert Point'); },
  overlay(g, v) { const t = pathTarget(app.doc); if (t) { const sp = t.get(); drawPathOverlay(g, v, sp, new Set(sp.flatMap((s, si) => s.pts.map((_, k) => si + ':' + k)))); } },
});

// ---------- Path Selection / Direct Selection ----------
function selectionTool(id, label, icon, direct) {
  registerTool({
    id, label, icon, key: 'A', group: 'pathSelect', cursor: 'default', defaults: {},
    activate() { this.sel = new Set(); },
    down(i) {
      const doc = app.doc;
      let t = pathTarget(doc);
      // Ctrl/auto: pick a shape layer under the cursor if nothing editable
      if (!t || (!direct && t.kind === 'shape' && !insidePath(t.get(), i.x, i.y) && !hitSegment(t.get(), i.x, i.y, tolPx(4)))) {
        const hit = doc.all().slice().reverse().find(l => l.visible && l.kind === 'shape' && (() => { const b = l.bounds(); return b && i.x >= b.x && i.y >= b.y && i.x <= b.x + b.w && i.y <= b.y + b.h; })());
        if (hit) { doc.setActive(hit.id); t = pathTarget(doc); }
      }
      if (!t) return;
      this.sel = this.sel || new Set();
      const sp = t.get();
      if (direct) {
        const hh = hitHandle(sp, this.sel, i.x, i.y, tolPx(5));
        if (hh) { this.drag = { t, kind: 'handle', ...hh, p0: { x: i.x, y: i.y }, alt: i.alt }; return; }
        const ha = hitAnchor(sp, i.x, i.y, tolPx(5));
        if (ha) { const k = ha.si + ':' + ha.i; if (i.shift) { this.sel.has(k) ? this.sel.delete(k) : this.sel.add(k); } else if (!this.sel.has(k)) this.sel = new Set([k]); this.drag = { t, kind: 'anchors', p0: { x: i.x, y: i.y }, orig: sp }; return; }
        const hs = hitSegment(sp, i.x, i.y, tolPx(4));
        if (hs) { const n = sp[hs.si].pts.length; this.sel = new Set([hs.si + ':' + hs.i, hs.si + ':' + ((hs.i + 1) % n)]); this.drag = { t, kind: 'anchors', p0: { x: i.x, y: i.y }, orig: sp }; return; }
        this.sel = i.shift ? this.sel : new Set(); this.marq = { t, a: { x: i.x, y: i.y }, b: { x: i.x, y: i.y } };
      } else {
        // whole subpath under cursor
        let si = -1;
        sp.forEach((s, k) => { if (insidePath([s], i.x, i.y) || hitSegment([s], i.x, i.y, tolPx(4))) si = k; });
        if (si < 0) { this.sel = new Set(); this.marq = { t, a: { x: i.x, y: i.y }, b: { x: i.x, y: i.y } }; return; }
        if (i.alt) { sp.push(clonePaths([sp[si]])[0]); si = sp.length - 1; t.set(sp); }
        this.sel = new Set(sp[si].pts.map((_, k) => si + ':' + k));
        this.drag = { t, kind: 'anchors', p0: { x: i.x, y: i.y }, orig: t.get(), dup: i.alt };
      }
    },
    move(i) {
      if (this.marq) { this.marq.b = { x: i.x, y: i.y }; return; }
      const d = this.drag; if (!d) return;
      const dx = i.x - d.p0.x, dy = i.y - d.p0.y;
      if (d.kind === 'handle') {
        const sp = d.t.get(), p = sp[d.si].pts[d.i];
        p[d.h] = { x: i.x, y: i.y };
        const o = d.h === 'in' ? 'out' : 'in';
        if (p.smooth && p[o] && !d.alt) { const len = Math.hypot(p[o].x - p.x, p[o].y - p.y), ang = Math.atan2(p.y - i.y, p.x - i.x); p[o] = { x: p.x + Math.cos(ang) * len, y: p.y + Math.sin(ang) * len }; }
        if (d.alt) p.smooth = false;
        d.t.set(sp); d.moved = true; return;
      }
      const sp = clonePaths(d.orig);
      for (const k of this.sel) { const [si, pi] = k.split(':').map(Number); const p = sp[si]?.pts[pi]; if (!p) continue; for (const q of [p, p.in, p.out]) if (q) { q.x += dx; q.y += dy; } }
      d.t.set(sp); d.moved = true;
    },
    up() {
      if (this.marq) {
        const { t, a, b } = this.marq; this.marq = null; const sp = t.get();
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
        sp.forEach((s, si) => s.pts.forEach((p, k) => { if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) { if (direct) this.sel.add(si + ':' + k); else s.pts.forEach((_, kk) => this.sel.add(si + ':' + kk)); } }));
        return;
      }
      const d = this.drag; this.drag = null;
      if (d && d.moved) commitTarget(d.t, direct ? 'Direct Selection' : 'Path Selection');
    },
    keydown(e) {
      if (!this.sel || !this.sel.size) return false;
      const t = pathTarget(app.doc); if (!t) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const sp = t.get();
        const bySub = {}; for (const k of this.sel) { const [si, pi] = k.split(':').map(Number); (bySub[si] ||= []).push(pi); }
        for (const si of Object.keys(bySub).map(Number).sort((a, b) => b - a)) {
          const s = sp[si]; if (!s) continue;
          if (!direct || bySub[si].length >= s.pts.length) sp.splice(si, 1);
          else { for (const pi of bySub[si].sort((a, b) => b - a)) s.pts.splice(pi, 1); if (s.pts.length < 2) sp.splice(si, 1); }
        }
        this.sel = new Set(); t.set(sp); commitTarget(t, 'Delete Anchor Point'); return true;
      }
      const step = e.shiftKey ? 10 : 1, mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (mv) { const sp = t.get(); for (const k of this.sel) { const [si, pi] = k.split(':').map(Number); const p = sp[si]?.pts[pi]; if (p) for (const q of [p, p.in, p.out]) if (q) { q.x += mv[0]; q.y += mv[1]; } } t.set(sp); commitTarget(t, 'Nudge'); return true; }
      return false;
    },
    overlay(g, v) {
      const t = pathTarget(app.doc); if (!t) return;
      drawPathOverlay(g, v, t.get(), this.sel || new Set(), { anchors: direct || (this.sel && this.sel.size > 0) });
      if (this.marq) { const a = v.toScreen(this.marq.a.x, this.marq.a.y), b = v.toScreen(this.marq.b.x, this.marq.b.y); g.setLineDash([3, 3]); g.strokeStyle = '#fff'; g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); g.setLineDash([]); }
    },
  });
}
selectionTool('pathSelect', 'Path Selection Tool', 'pathSelect', false);
selectionTool('directSelect', 'Direct Selection Tool', 'directSelect', true);
