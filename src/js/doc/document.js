// Document model: layers, masks, compositing, selection storage and snapshot-based history.
import { createCanvas, ctx2d, cloneCanvas, uid, Emitter, alphaBounds, hexToRgb, clamp } from '../util.js';
import { nativeOp, blendPixels } from './blend.js';
import { applyAdjustment, defaultParams } from '../engine/adjust.js';
import { renderGradient, resolveStops } from './gradient.js';
import { buildPath2D, pathBounds } from './paths.js';
export const smartFilterHooks = { run: null };
export const renderPost = { fn: null };

// ---------- temp canvas pool ----------
const pool = [];
function tmp(w, h) {
  let c = pool.pop();
  if (!c) c = createCanvas(w, h);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else ctx2d(c).clearRect(0, 0, w, h);
  const g = ctx2d(c); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.filter = 'none';
  return c;
}
function release(...cs) { for (const c of cs) if (c && pool.length < 12) pool.push(c); }

export const DEFAULT_EFFECTS = () => ({
  dropShadow: { enabled: false, color: '#000000', opacity: 75, angle: 120, distance: 8, spread: 0, size: 10, blend: 'multiply' },
  innerShadow: { enabled: false, color: '#000000', opacity: 75, angle: 120, distance: 5, size: 5, blend: 'multiply' },
  outerGlow: { enabled: false, color: '#ffffbe', opacity: 75, size: 10, spread: 0, blend: 'screen' },
  stroke: { enabled: false, color: '#ff0000', opacity: 100, size: 3, position: 'outside', blend: 'normal' },
  colorOverlay: { enabled: false, color: '#ff0000', opacity: 100, blend: 'normal' },
  gradientOverlay: { enabled: false, stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }], angle: 90, opacity: 100, blend: 'normal' },
});

// ---------- Layer ----------
export class Layer {
  constructor(kind, props = {}) {
    this.id = props.id || uid();
    this.kind = kind; // pixel | text | shape | fill | adjustment | group
    this.name = props.name || 'Layer';
    this.visible = props.visible ?? true;
    this.opacity = props.opacity ?? 1;
    this.fillOpacity = props.fillOpacity ?? 1;
    this.blend = props.blend || (kind === 'group' ? 'passThrough' : 'normal');
    this.locks = { pixels: false, position: false, transparency: false, all: false, ...(props.locks || {}) };
    this.clipped = props.clipped || false;
    this.colorTag = props.colorTag || null;
    this.effects = props.effects || null;
    this.canvas = props.canvas || null; // raster cache (pixel = data; vector = render cache)
    this.x = props.x || 0; this.y = props.y || 0;
    this.mask = props.mask || null; // {canvas (white+alpha), x, y, def: 0|255, enabled, linked}
    this.rev = 0; this.maskRev = 0; this.v = 0;
    this.children = kind === 'group' ? (props.children || []) : null;
    this.collapsed = props.collapsed || false;
    this.data = props.data || null; // kind-specific (text/shape/fill/adjustment props)
    this.tx = props.tx || [1, 0, 0, 1, 0, 0];
    this.generative = props.generative || null; // {prompt, variants:[canvas], index}
    this.vmask = props.vmask || null; // {subpaths (doc coords), enabled}
    this.smart = props.smart || null; // {doc, cache, ver, name}
    this.smartFilters = props.smartFilters || null;
    this.artboard = props.artboard || null; // {x,y,w,h,bg}
    if (kind === 'adjustment' && this.data && !this.data.params) this.data.params = defaultParams(this.data.type);
  }
  touch(pixels = false) { this.v++; if (pixels) this.rev++; }
  get isRasterEditable() { return this.kind === 'pixel'; }
  get isVector() { return this.kind === 'text' || this.kind === 'shape' || this.kind === 'fill' || this.kind === 'smart'; }
  bounds() {
    if (!this.canvas) return null;
    const b = alphaBounds(this.canvas);
    return b ? { x: b.x + this.x, y: b.y + this.y, w: b.w, h: b.h } : null;
  }
  // make the pixel canvas cover rect r (doc coords)
  ensureCovers(r) {
    if (!this.canvas) { this.canvas = createCanvas(r.w, r.h); this.x = r.x; this.y = r.y; return; }
    const x0 = Math.min(this.x, r.x), y0 = Math.min(this.y, r.y);
    const x1 = Math.max(this.x + this.canvas.width, r.x + r.w), y1 = Math.max(this.y + this.canvas.height, r.y + r.h);
    if (x0 === this.x && y0 === this.y && x1 === this.x + this.canvas.width && y1 === this.y + this.canvas.height) return;
    const c = createCanvas(x1 - x0, y1 - y0);
    ctx2d(c).drawImage(this.canvas, this.x - x0, this.y - y0);
    this.canvas = c; this.x = x0; this.y = y0;
  }
}

// ---------- vector rendering ----------
function applyTx(m, x, y) { return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }; }
export function txBounds(m, x0, y0, x1, y1) {
  const pts = [applyTx(m, x0, y0), applyTx(m, x1, y0), applyTx(m, x0, y1), applyTx(m, x1, y1)];
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)), x2: Math.ceil(Math.max(...xs)), y2: Math.ceil(Math.max(...ys)) };
}
export function textFont(t) { return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : (t.weight ? t.weight + ' ' : '')}${t.size}px "${t.font}", sans-serif`; }
export function measureText(t) {
  const c = ctx2d(createCanvas(1, 1));
  c.font = textFont(t);
  try { c.letterSpacing = (t.tracking || 0) / 1000 * t.size + 'px'; } catch {}
  const lines = String(t.text ?? '').split('\n');
  const lead = t.leading || t.size * 1.2;
  let w = 0, asc = t.size * 0.8, desc = t.size * 0.25;
  const widths = lines.map(l => { const m = c.measureText(l || ' '); asc = Math.max(asc, m.actualBoundingBoxAscent || 0); desc = Math.max(desc, m.actualBoundingBoxDescent || 0); return m.width; });
  w = Math.max(1, ...widths);
  const ox = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0;
  return { lines, widths, lead, asc, desc, x0: ox - 2, y0: -asc - 2, x1: ox + w + 2, y1: (lines.length - 1) * lead + desc + 2, w };
}
function renderText(L) {
  const t = L.data, m = measureText(t);
  const b = txBounds(L.tx, m.x0, m.y0, m.x1, m.y1);
  const c = createCanvas(b.x2 - b.x + 2, b.y2 - b.y + 2), g = ctx2d(c);
  g.setTransform(L.tx[0], L.tx[1], L.tx[2], L.tx[3], L.tx[4] - b.x, L.tx[5] - b.y);
  g.font = textFont(t); try { g.letterSpacing = (t.tracking || 0) / 1000 * t.size + 'px'; } catch {}
  g.textAlign = t.align || 'left'; g.textBaseline = 'alphabetic'; g.fillStyle = t.color || '#000';
  m.lines.forEach((line, i) => {
    g.fillText(line, 0, i * m.lead);
    if (t.underline) { const w = m.widths[i], ox = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0; g.fillRect(ox, i * m.lead + t.size * 0.1, w, Math.max(1, t.size / 15)); }
    if (t.strike) { const w = m.widths[i], ox = t.align === 'center' ? -w / 2 : t.align === 'right' ? -w : 0; g.fillRect(ox, i * m.lead - t.size * 0.3, w, Math.max(1, t.size / 15)); }
  });
  L.canvas = c; L.x = b.x; L.y = b.y;
}
export function shapePath(g, s) {
  g.beginPath();
  const { w, h } = s;
  if (s.shape === 'ellipse') g.ellipse(w / 2, h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  else if (s.shape === 'line') { g.moveTo(0, 0); g.lineTo(w, h); }
  else if (s.shape === 'polygon' || s.shape === 'star') {
    const n = Math.max(3, s.sides || 5), cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    const star = s.shape === 'star', k = star ? n * 2 : n;
    for (let i = 0; i < k; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / k, f = star && i % 2 ? (s.inner ?? 0.5) : 1;
      const x = cx + Math.cos(a) * rx * f, y = cy + Math.sin(a) * ry * f;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
  } else if (s.radius > 0 && g.roundRect) g.roundRect(Math.min(0, w), Math.min(0, h), Math.abs(w), Math.abs(h), Math.min(s.radius, Math.abs(w) / 2, Math.abs(h) / 2));
  else g.rect(Math.min(0, w), Math.min(0, h), Math.abs(w), Math.abs(h));
}
function renderShape(L) {
  const s = L.data, sw = s.stroke ? (s.strokeWidth || 1) : 0, pad = sw + 2;
  const isPath = s.shape === 'path';
  const lb = isPath ? (pathBounds(s.subpaths) || { x: 0, y: 0, w: 1, h: 1 }) : { x: Math.min(0, s.w), y: Math.min(0, s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
  const b = txBounds(L.tx, lb.x - pad, lb.y - pad, lb.x + lb.w + pad, lb.y + lb.h + pad);
  const c = createCanvas(Math.min(30000, b.x2 - b.x + 1), Math.min(30000, b.y2 - b.y + 1)), g = ctx2d(c);
  g.setTransform(L.tx[0], L.tx[1], L.tx[2], L.tx[3], L.tx[4] - b.x, L.tx[5] - b.y);
  const P = isPath ? buildPath2D(s.subpaths) : (shapePath(g, s), null);
  const openOnly = isPath && s.subpaths.every(sp => !sp.closed);
  if (s.fill && s.shape !== 'line' && !openOnly) { g.fillStyle = s.fill; P ? g.fill(P, s.fillRule || 'nonzero') : g.fill(); }
  if (s.stroke || s.shape === 'line' || (openOnly && !s.stroke)) {
    g.strokeStyle = s.stroke || s.fill || '#000'; g.lineWidth = Math.max(1, sw || s.lineWeight || 2); g.lineJoin = s.lineJoin || 'round'; g.lineCap = s.shape === 'line' ? 'round' : (s.lineCap || 'butt');
    if (s.dash) g.setLineDash([g.lineWidth * 2, g.lineWidth * 2]);
    P ? g.stroke(P) : g.stroke();
  }
  L.canvas = c; L.x = b.x; L.y = b.y;
}
function renderSmart(L, doc) {
  const sm = L.smart, src = sm.cache;
  const b = txBounds(L.tx, 0, 0, src.width, src.height);
  const W = Math.max(1, Math.min(30000, b.x2 - b.x)), H = Math.max(1, Math.min(30000, b.y2 - b.y));
  let c = createCanvas(W, H); const g = ctx2d(c);
  g.imageSmoothingQuality = 'high';
  g.setTransform(L.tx[0], L.tx[1], L.tx[2], L.tx[3], L.tx[4] - b.x, L.tx[5] - b.y);
  g.drawImage(src, 0, 0);
  const on = (L.smartFilters || []).filter(f => f.enabled !== false);
  if (on.length && smartFilterHooks.run && L.smartFiltersVisible !== false) {
    // smart filters operate on a doc-sized region so blurs etc. extend naturally
    const pad = 0;
    let res = c;
    for (const f of on) {
      const before = res;
      const after = smartFilterHooks.run(before, f, doc);
      if (!after) continue;
      if ((f.opacity ?? 100) < 100 || (f.blend && f.blend !== 'normal')) {
        const m = cloneCanvas(before), mg = ctx2d(m); mg.globalAlpha = (f.opacity ?? 100) / 100; mg.globalCompositeOperation = f.blend === 'normal' || !f.blend ? 'source-over' : (nativeOp(f.blend) || 'source-over'); mg.drawImage(after, 0, 0); res = m;
      } else res = after;
    }
    if (L.filterMask) { // smart filter mask: blend filtered over unfiltered
      const m = cloneCanvas(res), mg = ctx2d(m); mg.globalCompositeOperation = 'destination-in'; mg.drawImage(L.filterMask.canvas, L.filterMask.x - b.x, L.filterMask.y - b.y);
      const base = cloneCanvas(c), bg = ctx2d(base); bg.globalCompositeOperation = 'destination-out'; bg.drawImage(L.filterMask.canvas, L.filterMask.x - b.x, L.filterMask.y - b.y); bg.globalCompositeOperation = 'source-over'; bg.drawImage(m, 0, 0);
      res = base;
    }
    c = res;
  }
  L.canvas = c; L.x = b.x; L.y = b.y;
}
function renderFill(L, doc) {
  const c = createCanvas(doc.width, doc.height), g = ctx2d(c), f = L.data;
  if (f.fillType === 'gradient') {
    const a = (f.angle ?? 90) * Math.PI / 180, cx = doc.width / 2, cy = doc.height / 2;
    const len = (Math.abs(Math.cos(a)) * doc.width + Math.abs(Math.sin(a)) * doc.height) / 2 * (f.scale ?? 100) / 100;
    const p0 = { x: cx - Math.cos(a) * len, y: cy + Math.sin(a) * len }, p1 = { x: cx + Math.cos(a) * len, y: cy - Math.sin(a) * len };
    renderGradient(g, doc.width, doc.height, f.type === 'radial' ? { x: cx, y: cy } : p0, p1, resolveStops(f.stops, '#000', '#fff'), f.type || 'linear', f.reverse);
  } else { g.fillStyle = f.color || '#ffffff'; g.fillRect(0, 0, doc.width, doc.height); }
  L.canvas = c; L.x = 0; L.y = 0;
}
export function refreshVector(L, doc) {
  if (L.kind === 'text') renderText(L);
  else if (L.kind === 'shape') renderShape(L);
  else if (L.kind === 'fill') renderFill(L, doc);
  else if (L.kind === 'smart') renderSmart(L, doc);
  L._vsig = vsig(L, doc);
}
const vsig = (L, doc) => L.kind === 'smart' ? JSON.stringify([L.tx, L.smart.ver, L.smartFilters, L.smartFiltersVisible, L.filterMask ? L.maskRev + ':' + (L.filterMaskRev || 0) : 0]) : JSON.stringify([L.data, L.tx, L.kind === 'fill' ? [doc.width, doc.height] : 0]);

// ---------- effect helpers ----------
function silhouette(src, color, spread = 0) {
  const c = tmp(src.width, src.height), g = ctx2d(c);
  if (spread > 0) {
    const n = Math.min(48, Math.max(8, Math.ceil(spread * 2.5)));
    for (let r = spread; r > 0; r -= Math.max(1, spread / 3)) for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; g.drawImage(src, Math.cos(a) * r, Math.sin(a) * r); }
  }
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
  return c;
}
function blurred(src, r) {
  if (r <= 0.3) return src;
  const c = tmp(src.width, src.height), g = ctx2d(c);
  g.filter = `blur(${r}px)`; g.drawImage(src, 0, 0); g.filter = 'none';
  return c;
}

// ---------- Document ----------
export class Document extends Emitter {
  constructor(w, h, opts = {}) {
    super();
    this.id = uid();
    this.width = w; this.height = h;
    this.name = opts.name || 'Untitled-1';
    this.path = opts.path || null;
    this.resolution = opts.resolution || 72;
    this.layers = []; // bottom → top
    this.activeId = null;
    this.selectedIds = new Set();
    this.selection = null; // canvas (white+alpha), doc size
    this.selRev = 0;
    this.lastSelection = null;
    this.guides = [];
    this.dirty = false;
    this.view = { zoom: 1, cx: w / 2, cy: h / 2 };
    this.history = []; this.hIndex = -1; this.bitmapCache = new Map();
    this.composite = createCanvas(w, h);
    this._adjCache = new Map();
    this.renderDirty = true;
    this.preview = null; // {layerId, canvas, x, y} temporary override used by live previews/strokes
    this.quickMask = false;
    this.channelView = 'rgb';
    this.paths = []; this.activePathId = null; this.mode = 'rgb'; this.frames = null;
  }

  // ----- tree helpers -----
  *walk(list = this.layers, parent = null) { for (const l of list) { yield [l, parent, list]; if (l.children) yield* this.walk(l.children, l); } }
  all() { return [...this.walk()].map(x => x[0]); }
  find(id) { for (const [l] of this.walk()) if (l.id === id) return l; return null; }
  parentList(id) { for (const [l, p, list] of this.walk()) if (l.id === id) return { list, parent: p, index: list.indexOf(l) }; return null; }
  get active() { return this.find(this.activeId); }
  setActive(id, additive = false) {
    this.activeId = id;
    if (!additive) this.selectedIds = new Set(id ? [id] : []); else if (id) this.selectedIds.add(id);
    this.emit('layers');
  }
  flatList() { return this.all(); }

  addLayer(layer, { above = this.activeId, select = true } = {}) {
    let target = above ? this.parentList(above) : null;
    if (target) target.list.splice(target.index + 1, 0, layer);
    else this.layers.push(layer);
    if (layer.isVector) refreshVector(layer, this);
    if (select) this.setActive(layer.id);
    this.invalidate();
    return layer;
  }
  removeLayer(id) {
    const p = this.parentList(id); if (!p) return;
    p.list.splice(p.index, 1);
    if (this.activeId === id) {
      const next = p.list[Math.min(p.index, p.list.length - 1)] || p.parent || this.layers[this.layers.length - 1];
      this.setActive(next ? next.id : null);
    }
    this.invalidate();
  }
  newPixelLayer(name, opts = {}) {
    const L = new Layer('pixel', { name: name || this.nextName('Layer'), canvas: createCanvas(this.width, this.height), ...opts });
    return L;
  }
  nextName(base) {
    let n = 1; const names = new Set(this.all().map(l => l.name));
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  invalidate() { this.renderDirty = true; this.emit('render'); }

  // ----- compositing -----
  maskAlpha(L, w, h, ox = 0, oy = 0) {
    // returns canvas w×h (doc region starting at ox,oy) whose alpha = mask
    const m = L.mask, c = tmp(w, h), g = ctx2d(c);
    if (m.def) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.globalCompositeOperation = 'destination-out'; g.fillRect(m.x - ox, m.y - oy, m.canvas.width, m.canvas.height); g.globalCompositeOperation = 'source-over'; }
    g.drawImage(m.canvas, m.x - ox, m.y - oy);
    return c;
  }

  vmaskAlpha(L, w, h) {
    const c = tmp(w, h), g = ctx2d(c);
    g.fillStyle = '#fff'; g.fill(buildPath2D(L.vmask.subpaths), 'nonzero');
    return c;
  }
  layerContent(L) {
    // canvas, x, y for the layer content (respecting live preview)
    if (this.preview && this.preview.layerId === L.id) return this.preview;
    if (L.isVector && L._vsig !== vsig(L, this)) refreshVector(L, this);
    return { canvas: L.canvas, x: L.x, y: L.y };
  }

  render(force = false) {
    if (!this.renderDirty && !force) return this.composite;
    const W = this.width, H = this.height;
    if (this.composite.width !== W || this.composite.height !== H) { this.composite.width = W; this.composite.height = H; }
    const g = ctx2d(this.composite);
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);
    this._sigParts = [];
    this.renderList(this.layers, this.composite, '');
    if (renderPost.fn) renderPost.fn(this, this.composite);
    this.renderDirty = false;
    // drop stale adjustment cache entries
    if (this._adjCache.size > 12) { const keys = [...this._adjCache.keys()]; for (const k of keys.slice(0, keys.length - 12)) this._adjCache.delete(k); }
    return this.composite;
  }

  layerSig(L) {
    let s = L.id + ':' + L.v + ':' + L.rev + ':' + L.maskRev + ':' + (L.visible ? 1 : 0);
    if (this.preview && this.preview.layerId === L.id) s += ':p' + (this.preview.ver || 0);
    if (L.children) s += '[' + L.children.map(c => this.layerSig(c)).join(',') + ']';
    return s;
  }

  renderList(list, target, sigPrefix) {
    const W = this.width, H = this.height;
    let clipBase = null, clipBaseVisible = true;
    let sig = sigPrefix;
    for (let i = 0; i < list.length; i++) {
      const L = list[i];
      const lsig = this.layerSig(L);
      if (!L.clipped) { if (clipBase) { release(clipBase); clipBase = null; } clipBaseVisible = L.visible; }
      if (!L.visible || (L.clipped && !clipBaseVisible)) { sig += '|' + lsig; continue; }
      const clipTo = L.clipped ? clipBase : null;
      const isBaseNext = !L.clipped && list[i + 1] && list[i + 1].clipped;

      if (L.kind === 'adjustment') {
        const key = sig + '#' + lsig + JSON.stringify(L.data.params) + W + 'x' + H;
        let adj = this._adjCache.get(key);
        if (!adj) {
          const tg = ctx2d(target);
          const id = tg.getImageData(0, 0, W, H);
          applyAdjustment(id.data, L.data.type, L.data.params);
          adj = createCanvas(W, H); ctx2d(adj).putImageData(id, 0, 0);
          this._adjCache.set(key, adj);
        }
        const a = tmp(W, H), ag = ctx2d(a);
        ag.drawImage(adj, 0, 0);
        if (L.mask && L.mask.enabled !== false) { ag.globalCompositeOperation = 'destination-in'; const m = this.maskAlpha(L, W, H); ag.drawImage(m, 0, 0); release(m); }
        if (L.vmask && L.vmask.enabled !== false) { ag.globalCompositeOperation = 'destination-in'; const m = this.vmaskAlpha(L, W, H); ag.drawImage(m, 0, 0); release(m); }
        if (clipTo) { ag.globalCompositeOperation = 'destination-in'; ag.drawImage(clipTo, 0, 0); }
        this.drawBlended(target, a, L.blend, L.opacity * L.fillOpacity);
        release(a);
        if (isBaseNext) { clipBase = tmp(W, H); ctx2d(clipBase).fillRect(0, 0, W, H); }
        sig += '|' + lsig;
        continue;
      }

      let T;
      if (L.kind === 'group') {
        if (L.blend === 'passThrough' && L.opacity >= 1 && !L.mask && !clipTo && !isBaseNext) {
          this.renderList(L.children, target, sig + '>');
          sig += '|' + lsig; continue;
        }
        T = tmp(W, H);
        this.renderList(L.children, T, sig + '>' + L.id);
      } else {
        const ct = this.layerContent(L);
        if (!ct.canvas) { sig += '|' + lsig; continue; }
        T = tmp(W, H);
        ctx2d(T).drawImage(ct.canvas, ct.x, ct.y);
      }
      const tg = ctx2d(T);
      if (L.mask && L.mask.enabled !== false) { tg.globalCompositeOperation = 'destination-in'; const m = this.maskAlpha(L, W, H); tg.drawImage(m, 0, 0); release(m); tg.globalCompositeOperation = 'source-over'; }
      if (L.vmask && L.vmask.enabled !== false) { tg.globalCompositeOperation = 'destination-in'; const m = this.vmaskAlpha(L, W, H); tg.drawImage(m, 0, 0); release(m); tg.globalCompositeOperation = 'source-over'; }
      if (L.artboard) { tg.globalCompositeOperation = 'destination-in'; tg.fillRect(L.artboard.x, L.artboard.y, L.artboard.w, L.artboard.h); tg.globalCompositeOperation = 'destination-over'; if (L.artboard.bg && L.artboard.bg !== 'transparent') { tg.fillStyle = L.artboard.bg; tg.fillRect(L.artboard.x, L.artboard.y, L.artboard.w, L.artboard.h); } tg.globalCompositeOperation = 'source-over'; }
      if (clipTo) { tg.globalCompositeOperation = 'destination-in'; tg.drawImage(clipTo, 0, 0); tg.globalCompositeOperation = 'source-over'; }
      if (isBaseNext) { clipBase = tmp(W, H); ctx2d(clipBase).drawImage(T, 0, 0); }

      const fx = L.effects;
      const op = L.opacity;
      if (fx) {
        const ds = fx.dropShadow, og = fx.outerGlow, st = fx.stroke;
        if (ds?.enabled) {
          const a = ds.angle * Math.PI / 180;
          const s = silhouette(T, ds.color, ds.size * (ds.spread || 0) / 100); const b = blurred(s, ds.size / 2);
          const sh = tmp(W, H); ctx2d(sh).drawImage(b, -Math.cos(a) * ds.distance, Math.sin(a) * ds.distance);
          this.drawBlended(target, sh, ds.blend, op * ds.opacity / 100); release(s, sh); if (b !== s) release(b);
        }
        if (og?.enabled) {
          const s = silhouette(T, og.color, og.size * (og.spread || 0) / 100); const b = blurred(s, og.size / 2);
          this.drawBlended(target, b, og.blend, op * og.opacity / 100); release(s); if (b !== s) release(b);
        }
        if (st?.enabled && st.position !== 'inside') {
          const s = silhouette(T, st.color, st.position === 'center' ? st.size / 2 : st.size);
          this.drawBlended(target, s, st.blend || 'normal', op * st.opacity / 100); release(s);
        }
      }
      // Layer body (fill opacity)
      this.drawBlended(target, T, L.blend === 'passThrough' ? 'normal' : L.blend, op * (L.kind === 'group' ? 1 : L.fillOpacity));
      if (fx) {
        const co = fx.colorOverlay, go = fx.gradientOverlay, is = fx.innerShadow, st = fx.stroke;
        if (go?.enabled) {
          const gc = tmp(W, H), gg = ctx2d(gc); const a = go.angle * Math.PI / 180, cx = W / 2, cy = H / 2, len = (Math.abs(Math.cos(a)) * W + Math.abs(Math.sin(a)) * H) / 2;
          renderGradient(gg, W, H, { x: cx - Math.cos(a) * len, y: cy + Math.sin(a) * len }, { x: cx + Math.cos(a) * len, y: cy - Math.sin(a) * len }, resolveStops(go.stops, '#000', '#fff'), 'linear');
          gg.globalCompositeOperation = 'destination-in'; gg.drawImage(T, 0, 0);
          this.drawBlended(target, gc, go.blend, op * go.opacity / 100); release(gc);
        }
        if (co?.enabled) { const s = silhouette(T, co.color); ctx2d(s).globalCompositeOperation = 'destination-in'; ctx2d(s).drawImage(T, 0, 0); this.drawBlended(target, s, co.blend, op * co.opacity / 100); release(s); }
        if (is?.enabled) {
          const a = is.angle * Math.PI / 180, inv = tmp(W, H), ig = ctx2d(inv);
          ig.fillStyle = is.color; ig.fillRect(0, 0, W, H); ig.globalCompositeOperation = 'destination-out'; ig.drawImage(T, -Math.cos(a) * is.distance, Math.sin(a) * is.distance);
          const b = blurred(inv, is.size / 2); const r = tmp(W, H), rg = ctx2d(r); rg.drawImage(b, 0, 0); rg.globalCompositeOperation = 'destination-in'; rg.drawImage(T, 0, 0);
          this.drawBlended(target, r, is.blend, op * is.opacity / 100); release(inv, r); if (b !== inv) release(b);
        }
        if (st?.enabled && st.position === 'inside') {
          const inv = tmp(W, H), ig = ctx2d(inv); ig.fillStyle = '#000'; ig.fillRect(0, 0, W, H); ig.globalCompositeOperation = 'destination-out'; ig.drawImage(T, 0, 0);
          const s = silhouette(inv, st.color, st.size); const sg = ctx2d(s); sg.globalCompositeOperation = 'destination-in'; sg.drawImage(T, 0, 0);
          this.drawBlended(target, s, 'normal', op * st.opacity / 100); release(inv, s);
        }
      }
      release(T);
      sig += '|' + lsig;
    }
    if (clipBase) release(clipBase);
  }

  drawBlended(target, src, mode, opacity) {
    if (opacity <= 0) return;
    const g = ctx2d(target);
    const op = nativeOp(mode);
    if (op) { g.globalAlpha = clamp(opacity, 0, 1); g.globalCompositeOperation = op; g.drawImage(src, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; return; }
    const W = target.width, H = target.height;
    const dst = g.getImageData(0, 0, W, H), s = ctx2d(src).getImageData(0, 0, W, H);
    blendPixels(dst, s, mode, opacity);
    g.putImageData(dst, 0, 0);
  }

  // Render a single layer (with its mask) into a doc-size canvas — used for "sample current layer", thumbnails, merges.
  renderLayerAlone(L, withEffects = true) {
    const c = createCanvas(this.width, this.height);
    const saveP = this.preview; this.preview = saveP && saveP.layerId === L.id ? saveP : null;
    const clone = Object.assign(Object.create(Object.getPrototypeOf(L)), L, { clipped: false, visible: true, effects: withEffects ? L.effects : null, opacity: 1 });
    if (clone.blend === 'passThrough') clone.blend = 'normal';
    this.renderList([clone], c, 'alone');
    this.preview = saveP;
    return c;
  }

  // Flattened pixels of everything (doc size) — optional exclude function
  flatten(filter) {
    const c = createCanvas(this.width, this.height);
    const pick = (list) => list.filter(l => !filter || filter(l)).map(l => l.children ? Object.assign(Object.create(Object.getPrototypeOf(l)), l, { children: pick(l.children) }) : l);
    this.renderList(pick(this.layers), c, 'flat' + Math.random());
    return c;
  }

  // ----- selection -----
  setSelection(canvas, record = true) {
    if (canvas) {
      const b = alphaBounds(canvas);
      if (!b) canvas = null;
      this.selBounds = b;
    } else this.selBounds = null;
    if (this.selection && !canvas) this.lastSelection = this.selection;
    this.selection = canvas; this.selRev++;
    this.emit('selection');
  }
  selectionMaskData() { // Uint8Array doc-size or null
    if (!this.selection) return null;
    const d = ctx2d(this.selection).getImageData(0, 0, this.width, this.height).data;
    const m = new Uint8Array(this.width * this.height);
    for (let i = 0, j = 3; i < m.length; i++, j += 4) m[i] = d[j];
    return m;
  }

  // ----- history -----
  snapLayer(L) {
    const s = { id: L.id, kind: L.kind, name: L.name, visible: L.visible, opacity: L.opacity, fillOpacity: L.fillOpacity, blend: L.blend, locks: { ...L.locks }, clipped: L.clipped,
      colorTag: L.colorTag, effects: L.effects ? JSON.parse(JSON.stringify(L.effects)) : null, x: L.x, y: L.y, rev: L.rev, maskRev: L.maskRev, collapsed: L.collapsed,
      data: L.data ? JSON.parse(JSON.stringify(L.data)) : null, tx: [...L.tx], generative: L.generative, vmask: L.vmask ? JSON.parse(JSON.stringify(L.vmask)) : null,
      smart: L.smart ? { doc: L.smart.doc, cacheKey: this.cacheBitmap('smart:' + L.id + ':' + L.smart.ver, L.smart.cache), ver: L.smart.ver, name: L.smart.name, linkedPath: L.smart.linkedPath } : null,
      smartFilters: L.smartFilters ? JSON.parse(JSON.stringify(L.smartFilters)) : null, smartFiltersVisible: L.smartFiltersVisible, artboard: L.artboard ? { ...L.artboard } : null,
      filterMask: L.filterMask ? { key: this.cacheBitmap('fm:' + L.id + ':' + (L.filterMaskRev || 0), L.filterMask.canvas), x: L.filterMask.x, y: L.filterMask.y } : null, filterMaskRev: L.filterMaskRev || 0 };
    if (L.kind === 'pixel' && L.canvas) {
      const key = L.id + ':' + L.rev + ':' + L.canvas.width + 'x' + L.canvas.height;
      if (!this.bitmapCache.has(key)) this.bitmapCache.set(key, cloneCanvas(L.canvas));
      s.bitmap = key;
    }
    if (L.mask) {
      const key = L.id + ':m' + L.maskRev + ':' + L.mask.canvas.width + 'x' + L.mask.canvas.height;
      if (!this.bitmapCache.has(key)) this.bitmapCache.set(key, cloneCanvas(L.mask.canvas));
      s.mask = { key, x: L.mask.x, y: L.mask.y, def: L.mask.def, enabled: L.mask.enabled, linked: L.mask.linked };
    }
    if (L.children) s.children = L.children.map(c => this.snapLayer(c));
    return s;
  }
  restoreLayer(s) {
    const L = new Layer(s.kind, { ...s, children: s.children ? s.children.map(c => this.restoreLayer(c)) : null, canvas: null, mask: null,
      data: s.data ? JSON.parse(JSON.stringify(s.data)) : null, effects: s.effects ? JSON.parse(JSON.stringify(s.effects)) : null, locks: { ...s.locks }, tx: [...s.tx] });
    L.rev = s.rev; L.maskRev = s.maskRev; L.v = Math.floor(Math.random() * 1e9);
    if (s.bitmap) L.canvas = cloneCanvas(this.bitmapCache.get(s.bitmap));
    if (s.smart) L.smart = { doc: s.smart.doc, cache: this.bitmapCache.get(s.smart.cacheKey), ver: s.smart.ver, name: s.smart.name, linkedPath: s.smart.linkedPath };
    L.vmask = s.vmask ? JSON.parse(JSON.stringify(s.vmask)) : null;
    L.smartFilters = s.smartFilters ? JSON.parse(JSON.stringify(s.smartFilters)) : null;
    L.artboard = s.artboard ? { ...s.artboard } : null;
    if (s.filterMask) L.filterMask = { canvas: cloneCanvas(this.bitmapCache.get(s.filterMask.key)), x: s.filterMask.x, y: s.filterMask.y };
    if (s.mask) L.mask = { canvas: cloneCanvas(this.bitmapCache.get(s.mask.key)), x: s.mask.x, y: s.mask.y, def: s.mask.def, enabled: s.mask.enabled, linked: s.mask.linked };
    if (L.isVector) refreshVector(L, this);
    return L;
  }
  cacheBitmap(key, canvas) { if (!this.bitmapCache.has(key)) this.bitmapCache.set(key, cloneCanvas(canvas)); return key; }
  snapshot(name, icon) {
    const snap = { name, icon, w: this.width, h: this.height, layers: this.layers.map(l => this.snapLayer(l)), activeId: this.activeId, guides: [...this.guides], paths: JSON.parse(JSON.stringify(this.paths || [])), activePathId: this.activePathId, mode: this.mode, frames: this.frames ? JSON.parse(JSON.stringify(this.frames)) : null };
    if (this.selection) {
      const key = 'sel:' + this.selRev;
      if (!this.bitmapCache.has(key)) this.bitmapCache.set(key, cloneCanvas(this.selection));
      snap.sel = key;
    }
    return snap;
  }
  commit(name, icon) {
    this.history.length = this.hIndex + 1;
    this.history.push(this.snapshot(name, icon));
    const LIMIT = this.historyLimit || 50;
    if (this.history.length > LIMIT) this.history.splice(1, this.history.length - LIMIT); // keep the first (Open) state
    this.hIndex = this.history.length - 1;
    if (this.history.length > 1) this.dirty = true;
    this.gcBitmaps();
    this.invalidate();
    this.emit('history'); this.emit('layers');
  }
  gcBitmaps() {
    const used = new Set();
    const mark = (ls) => { for (const s of ls) { if (s.bitmap) used.add(s.bitmap); if (s.mask) used.add(s.mask.key); if (s.smart) used.add(s.smart.cacheKey); if (s.filterMask) used.add(s.filterMask.key); if (s.children) mark(s.children); } };
    for (const h of [...this.history, ...(this.snapshots || [])]) { mark(h.layers); if (h.sel) used.add(h.sel); }
    for (const k of this.bitmapCache.keys()) if (!used.has(k)) this.bitmapCache.delete(k);
  }
  goto(index) {
    if (index < 0 || index >= this.history.length) return;
    const s = this.history[index];
    this.hIndex = index;
    this.width = s.w; this.height = s.h;
    this.layers = s.layers.map(l => this.restoreLayer(l));
    this.activeId = this.find(s.activeId) ? s.activeId : (this.layers[this.layers.length - 1]?.id || null);
    this.selectedIds = new Set(this.activeId ? [this.activeId] : []);
    this.guides = [...(s.guides || [])];
    this.paths = JSON.parse(JSON.stringify(s.paths || [])); this.activePathId = s.activePathId; this.mode = s.mode || 'rgb'; if (s.frames) this.frames = JSON.parse(JSON.stringify(s.frames));
    this.emit('paths');
    this.selection = s.sel ? cloneCanvas(this.bitmapCache.get(s.sel)) : null;
    this.selBounds = this.selection ? alphaBounds(this.selection) : null;
    this.selRev++;
    this.preview = null;
    this._adjCache.clear();
    this.dirty = index > 0;
    this.invalidate();
    this.emit('history'); this.emit('layers'); this.emit('selection'); this.emit('resize');
  }
  restoreSnapshot(s, name) {
    this.width = s.w; this.height = s.h;
    this.layers = s.layers.map(l => this.restoreLayer(l));
    this.activeId = this.find(s.activeId) ? s.activeId : (this.layers[this.layers.length - 1]?.id || null);
    this.selectedIds = new Set(this.activeId ? [this.activeId] : []);
    this.selection = s.sel ? cloneCanvas(this.bitmapCache.get(s.sel)) : null; this.selRev++;
    this._adjCache.clear();
    this.commit(name || s.name, 'snapshot');
    this.emit('resize'); this.emit('selection');
  }
  undo() { if (this.hIndex > 0) this.goto(this.hIndex - 1); }
  redo() { if (this.hIndex < this.history.length - 1) this.goto(this.hIndex + 1); }

  // ----- whole-document geometry ops -----
  resizeCanvas(nw, nh, ox, oy, fillBg) {
    for (const L of this.all()) {
      if (L.kind === 'pixel' || L.kind === 'text' || L.kind === 'shape' || L.kind === 'smart') { L.x += ox; L.y += oy; L.tx[4] += ox; L.tx[5] += oy; }
      if (L.vmask) for (const sp of L.vmask.subpaths) for (const p of sp.pts) { p.x += ox; p.y += oy; if (p.in) { p.in.x += ox; p.in.y += oy; } if (p.out) { p.out.x += ox; p.out.y += oy; } }
      if (L.artboard) { L.artboard.x += ox; L.artboard.y += oy; }
      if (L.mask) { L.mask.x += ox; L.mask.y += oy; }
      L.touch(true);
    }
    this.width = nw; this.height = nh;
    for (const L of this.all()) if (L.kind === 'fill') refreshVector(L, this);
    if (fillBg) {
      const bgL = this.layers[0];
      if (bgL && bgL.kind === 'pixel' && bgL.locks.background) {
        bgL.ensureCovers({ x: 0, y: 0, w: nw, h: nh });
        const g = ctx2d(bgL.canvas); g.globalCompositeOperation = 'destination-over'; g.fillStyle = fillBg; g.fillRect(0, 0, bgL.canvas.width, bgL.canvas.height); g.globalCompositeOperation = 'source-over';
      }
    }
    this.guides = this.guides.map(gd => ({ ...gd, pos: gd.pos + (gd.axis === 'x' ? ox : oy) }));
    this.setSelection(null);
    this.emit('resize'); this.invalidate();
  }
  // Apply a function (canvas,x,y)→{canvas,x,y} to all raster content and masks; vectors get matrix transform
  transformAll(fnRaster, matrix, nw, nh) {
    for (const L of this.all()) {
      if (L.kind === 'pixel' && L.canvas) { const r = fnRaster(L.canvas, L.x, L.y); L.canvas = r.canvas; L.x = r.x; L.y = r.y; L.touch(true); }
      if ((L.kind === 'text' || L.kind === 'shape' || L.kind === 'smart') && matrix) { L.tx = mulTx(matrix, L.tx); L.touch(); }
      if (L.vmask && matrix) for (const sp of L.vmask.subpaths) for (const p of sp.pts) for (const q of [p, p.in, p.out]) if (q) { const a = applyTx(matrix, q.x, q.y); q.x = a.x; q.y = a.y; }
      if (L.mask) { const r = fnRaster(L.mask.canvas, L.mask.x, L.mask.y); L.mask.canvas = r.canvas; L.mask.x = r.x; L.mask.y = r.y; L.maskRev++; }
    }
    this.width = nw; this.height = nh;
    for (const L of this.all()) if (L.kind === 'fill') { refreshVector(L, this); }
    this.setSelection(null);
    this.emit('resize'); this.invalidate();
  }
}

export function mulTx(a, b) { // a ∘ b
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function invTx(m) {
  const det = m[0] * m[3] - m[1] * m[2] || 1e-9;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export { applyTx };

export function newDocument({ width, height, name, background = '#ffffff', resolution = 72 }) {
  const d = new Document(width, height, { name, resolution });
  if (background === 'transparent') {
    d.addLayer(d.newPixelLayer('Layer 1'), { select: true });
  } else {
    const L = d.newPixelLayer('Background');
    const g = ctx2d(L.canvas); g.fillStyle = background; g.fillRect(0, 0, width, height);
    L.locks = { ...L.locks, background: true, position: true };
    d.addLayer(L);
  }
  d.commit('New', 'new');
  d.dirty = false;
  return d;
}
