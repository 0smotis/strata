// Shared tool infrastructure: paint targets/surfaces, locks, rasterize prompts, tool registry.
import { app } from '../state.js';
import { createCanvas, ctx2d, cloneCanvas, hexToRgb } from '../util.js';
import { toast, confirmBox } from '../ui/common.js';
import { refreshVector } from '../doc/document.js';

export const tools = {};
export function registerTool(t) { tools[t.id] = t; app.opts[t.id] = { ...(t.defaults || {}), ...(app.opts[t.id] || {}) }; }
export const opt = (id) => app.opts[id];

export class ToolError extends Error {}

// Convert vector layer to pixels (after confirming).
export async function ensureRaster(L, what = 'this tool') {
  if (L.kind === 'pixel') return true;
  if (L.kind === 'text' || L.kind === 'shape' || L.kind === 'fill' || L.kind === 'smart') {
    const nm = { text: 'type', shape: 'shape', fill: 'fill', smart: 'Smart Object' }[L.kind];
    const ok = await confirmBox(L.kind === 'smart' ? 'This Smart Object must be rasterized before proceeding. Its contents and Smart Filters will no longer be editable. Rasterize the Smart Object?' : `This ${nm} layer must be rasterized before proceeding. Its ${nm === 'type' ? 'text' : 'vector'} will no longer be editable. Rasterize the ${nm} layer?`, 'OK');
    if (!ok) return false;
    rasterizeLayer(app.doc, L);
    app.doc.commit('Rasterize Layer', 'raster');
    return true;
  }
  return false;
}
export function rasterizeLayer(doc, L) {
  if (L.isVector) refreshVector(L, doc);
  L.kind = 'pixel'; L.data = null; L.tx = [1, 0, 0, 1, 0, 0]; L.smart = null; L.smartFilters = null; L.filterMask = null; L.touch(true);
  doc.emit('layers'); doc.invalidate();
}

export function docRect(doc) { return { x: 0, y: 0, w: doc.width, h: doc.height }; }

export function ensureMaskCovers(doc, L) {
  const m = L.mask, r = docRect(doc);
  const x0 = Math.min(m.x, 0), y0 = Math.min(m.y, 0), x1 = Math.max(m.x + m.canvas.width, r.w), y1 = Math.max(m.y + m.canvas.height, r.h);
  if (x0 === m.x && y0 === m.y && x1 === m.x + m.canvas.width && y1 === m.y + m.canvas.height) return;
  const c = createCanvas(x1 - x0, y1 - y0), g = ctx2d(c);
  if (m.def) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.clearRect(m.x - x0, m.y - y0, m.canvas.width, m.canvas.height); }
  g.drawImage(m.canvas, m.x - x0, m.y - y0);
  m.canvas = c; m.x = x0; m.y = y0;
}

// Resolve what painting tools should modify.
export function paintTarget(doc, { allowMask = true, allowSelection = true, toolName = 'tool' } = {}) {
  if (doc.quickMask && allowSelection) return { kind: 'selection' };
  const L = doc.active;
  if (!L) throw new ToolError('Could not complete your request because there is no active layer.');
  if (L.locks.all) throw new ToolError(`Could not use the ${toolName} because the layer is locked.`);
  if (allowMask && L.mask && (app.maskEdit || L.kind === 'adjustment' || L.kind === 'fill')) return { kind: 'mask', layer: L };
  if (L.kind === 'group') throw new ToolError(`Could not use the ${toolName} because the target layer is a group.`);
  if (L.kind === 'adjustment') throw new ToolError(`Could not use the ${toolName} because the target is not pixels. Add a layer mask to paint on it.`);
  if (L.locks.pixels) throw new ToolError(`Could not use the ${toolName} because the layer is locked.`);
  if (L.kind !== 'pixel') return { kind: 'needsRaster', layer: L };
  return { kind: 'layer', layer: L };
}

// Prepare a target, handling rasterize prompts. Returns target or null.
export async function resolveTarget(doc, opts) {
  try {
    let t = paintTarget(doc, opts);
    if (t.kind === 'needsRaster') { if (!(await ensureRaster(t.layer))) return null; t = paintTarget(doc, opts); }
    return t;
  } catch (e) { if (e instanceof ToolError) { toast(e.message, 'err'); return null; } throw e; }
}
// synchronous variant used at pointerdown; returns null and triggers async prompt for vectors
export function targetNow(doc, opts) {
  try {
    const t = paintTarget(doc, opts);
    if (t.kind === 'needsRaster') { ensureRaster(t.layer); return null; }
    return t;
  } catch (e) { if (e instanceof ToolError) { toast(e.message, 'err'); return null; } throw e; }
}

// A Surface swaps a working copy into the target and supports commit/cancel.
export class Surface {
  constructor(doc, target) {
    this.doc = doc; this.target = target;
    if (target.kind === 'layer') {
      const L = target.layer;
      L.ensureCovers(docRect(doc));
      this.orig = L.canvas; this.ox = L.x; this.oy = L.y;
    } else if (target.kind === 'mask') {
      ensureMaskCovers(doc, target.layer);
      const m = target.layer.mask; this.orig = m.canvas; this.ox = m.x; this.oy = m.y;
    } else {
      this.orig = doc.selection || createCanvas(doc.width, doc.height); this.ox = 0; this.oy = 0;
    }
    this.canvas = cloneCanvas(this.orig);
    this.install(this.canvas);
  }
  get isMaskLike() { return this.target.kind !== 'layer'; }
  install(c) {
    const t = this.target;
    if (t.kind === 'layer') { t.layer.canvas = c; t.layer.touch(); }
    else if (t.kind === 'mask') { t.layer.mask.canvas = c; t.layer.maskRev++; t.layer.touch(); }
    else { this.doc.selection = c; this.doc.selRev++; }
    this.doc.invalidate();
  }
  changed() {
    const t = this.target;
    if (t.kind === 'layer') t.layer.touch(); else if (t.kind === 'mask') { t.layer.touch(); }
    else this.doc.selRev++;
    this.doc.invalidate();
  }
  commit(name, icon) {
    const t = this.target;
    if (t.kind === 'layer') t.layer.touch(true);
    else if (t.kind === 'mask') { t.layer.maskRev++; t.layer.touch(); }
    else this.doc.setSelection(this.canvas);
    this.doc.commit(name, icon);
  }
  cancel() { this.install(this.orig); if (this.target.kind === 'selection') this.doc.setSelection(this.orig === this.doc.selection ? this.orig : this.orig); }
  // selection mask in surface coords (or null)
  selMask() {
    const d = this.doc;
    if (!d.selection || this.target.kind === 'selection') return null;
    if (this._sel && this._selRev === d.selRev) return this._sel;
    const c = createCanvas(this.canvas.width, this.canvas.height);
    ctx2d(c).drawImage(d.selection, -this.ox, -this.oy);
    this._sel = c; this._selRev = d.selRev;
    return c;
  }
}

export function grayOf(hex) { const { r, g, b } = hexToRgb(hex); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; }

