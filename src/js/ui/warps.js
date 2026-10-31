// Edit › Puppet Warp, Edit › Perspective Warp, Edit › Transform › Warp — modal dialogs with a working
// canvas (zoom/pan), a tool column and an options column (same layout as Liquify).
// Each dialog resolves to an ImageData the size of the input canvas (transparent where nothing maps), or null.
import { el, $$, createCanvas, ctx2d, clamp, alphaBounds } from '../util.js';
import { ICONS } from '../icons.js';
import { modal, sliderRow, selectEl, checkEl, numField, toast } from './common.js';
import * as WP from '../engine/warp.js';

const I = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const WICONS = {
  pin: I('<circle cx="12" cy="9" r="4.5"/><circle cx="12" cy="9" r="1.4" fill="currentColor"/><path d="M12 13.5V21"/>'),
  layout: I('<path d="M4 6l7-2v15l-7-2zM11 4l9 3v10l-9 2"/><path d="M7.5 5v13M15.5 5.6v12.8M4 11.5h16" stroke-width="1" opacity=".7"/>'),
  pwarp: I('<path d="M3 5l8 1v13l-8 1zM11 6l10-3v18l-10-2"/><path d="M7 5.5v14M16 4.5v15" stroke-width="1" opacity=".7"/>'),
  vert: I('<path d="M7 4v16M12 4v16M17 4v16"/>'),
  horz: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  both: I('<path d="M7 4v16M17 4v16M4 8h16M4 16h16"/>'),
  fwd: I('<rect x="9" y="9" width="11" height="11" fill="currentColor" opacity=".9"/><rect x="4" y="4" width="11" height="11"/><path d="M14 3l3-1 1 3" stroke-width="1.3"/>'),
  back: I('<rect x="4" y="4" width="11" height="11" fill="currentColor" opacity=".9"/><rect x="9" y="9" width="11" height="11"/><path d="M6 21l-2-1 1-3" stroke-width="1.3"/>'),
  orientH: I('<path d="M3 15c3-5 15-5 18 0M3 19c3-5 15-5 18 0" /><path d="M3 15v4M21 15v4"/>'),
  orientV: I('<path d="M9 3c-5 3-5 15 0 18M5 3c-5 3-5 15 0 18" transform="translate(6 0)"/><path d="M11 3h4M11 21h4"/>'),
  reset: I('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 3v4h4"/>'),
  clear: I('<circle cx="12" cy="9" r="4.5"/><path d="M12 13.5V21M4 4l16 16"/>'),
};
const ico = (k) => WICONS[k] || ICONS[k] || '';

// ---------------------------------------------------------------- shared stage (zoom / pan / checker / present)
const PB = '#232323';
let checkerCanvas = null;
function checker(g) { if (!checkerCanvas) { checkerCanvas = createCanvas(16, 16); const c = ctx2d(checkerCanvas); c.fillStyle = '#fff'; c.fillRect(0, 0, 16, 16); c.fillStyle = '#cdcdcd'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8); } return g.createPattern(checkerCanvas, 'repeat'); }

class Stage {
  constructor(src) {
    this.src = src; this.w = src.width; this.h = src.height;
    this.W = clamp(Math.floor(innerWidth - 480), 420, 1300); this.H = clamp(Math.floor(innerHeight - 170), 320, 920);
    this.canvas = el('canvas', { class: 'stage', width: this.W, height: this.H, tabindex: '-1' });
    this.g = ctx2d(this.canvas, { alpha: false });
    this.canvas.__stage = this; // view mapping, used by e2e tests
    this.full = ctx2d(src).getImageData(0, 0, this.w, this.h);
    this.levels = [{ img: this.full, s: 1 }];
    for (let s = 0.5; Math.max(this.w, this.h) * s * 2 > Math.min(this.W, this.H) * 0.5 && s > 1e-3; s /= 2) {
      const cw = Math.max(1, Math.round(this.w * s)), ch = Math.max(1, Math.round(this.h * s));
      const prev = this.levels[this.levels.length - 1], pc = createCanvas(prev.img.width, prev.img.height); ctx2d(pc).putImageData(prev.img, 0, 0);
      const c = createCanvas(cw, ch), g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(pc, 0, 0, cw, ch);
      this.levels.push({ img: g.getImageData(0, 0, cw, ch), s: cw / this.w });
    }
    this.buf = createCanvas(this.W, this.H); this.bg = ctx2d(this.buf); this.out = this.bg.createImageData(this.W, this.H);
    this.space = false; this.tool = null; this.pan = null; this.raf = 0;
    this.content = null; this.overlay = null; this.onDown = this.onMove = this.onUp = this.onHover = null;
    this.fit();
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (document.activeElement && document.activeElement !== c && document.activeElement.blur) document.activeElement.blur();
      c.setPointerCapture(e.pointerId);
      if (e.button === 1 || this.space || this.tool === 'hand') { this.pan = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy }; this.cursor(); return; }
      if (this.tool === 'zoom') { const p = this.local(e); this.zoomAt(p.x, p.y, e.altKey ? 1 / 1.5 : 1.5); return; }
      if (e.button !== 0) return;
      this.onDown && this.onDown(e, this.toImg(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (this.pan) { this.ox = this.pan.ox + e.clientX - this.pan.x; this.oy = this.pan.oy + e.clientY - this.pan.y; this.request(); return; }
      const p = this.toImg(e);
      if (e.buttons & 1) this.onMove && this.onMove(e, p); else this.onHover && this.onHover(e, p);
    });
    const up = (e) => { if (this.pan) { this.pan = null; this.cursor(); return; } this.onUp && this.onUp(e, this.toImg(e)); };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); const p = this.local(e); this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  fit() { const m = 36; this.z = Math.min(1, (this.W - 2 * m) / this.w, (this.H - 2 * m) / this.h); this.ox = (this.W - this.w * this.z) / 2; this.oy = (this.H - this.h * this.z) / 2; this.request(); }
  setZoom(z) { this.zoomAt(this.W / 2, this.H / 2, z / this.z); }
  zoomAt(sx, sy, f) { const z = clamp(this.z * f, 0.02, 32); const ix = (sx - this.ox) / this.z, iy = (sy - this.oy) / this.z; this.z = z; this.ox = sx - ix * z; this.oy = sy - iy * z; this.request(); }
  local(e) { const r = this.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * this.W / r.width, y: (e.clientY - r.top) * this.H / r.height }; }
  toImg(e) { const p = this.local(e); return { x: (p.x - this.ox) / this.z, y: (p.y - this.oy) / this.z, sx: p.x, sy: p.y }; }
  sx(x) { return x * this.z + this.ox; } sy(y) { return y * this.z + this.oy; }
  xf = (x, y) => [x * this.z + this.ox, y * this.z + this.oy];
  clip() { return { x0: this.ox, y0: this.oy, x1: this.ox + this.w * this.z, y1: this.oy + this.h * this.z }; }
  level() { let best = this.levels[0]; for (const l of this.levels) if (l.s >= this.z * 0.999) best = l; return best; }
  cursor(c) { if (c !== undefined) this.baseCursor = c; this.canvas.style.cursor = this.pan ? 'grabbing' : (this.space || this.tool === 'hand') ? 'grab' : this.tool === 'zoom' ? 'zoom-in' : (this.baseCursor || 'default'); }
  request() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.present(); }); }
  present() {
    const g = this.g, { W, H } = this;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = PB; g.fillRect(0, 0, W, H);
    const r = this.clip();
    g.fillStyle = checker(g); g.fillRect(Math.round(r.x0), Math.round(r.y0), Math.round(r.x1) - Math.round(r.x0), Math.round(r.y1) - Math.round(r.y0));
    if (this.content) {
      this.out.data.fill(0);
      const drew = this.content(this.out, this.level(), g);
      if (drew !== 'direct') { this.bg.putImageData(this.out, 0, 0); g.drawImage(this.buf, 0, 0); }
    }
    g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1; g.strokeRect(Math.round(r.x0) - 0.5, Math.round(r.y0) - 0.5, Math.round(r.x1) - Math.round(r.x0) + 1, Math.round(r.y1) - Math.round(r.y0) + 1);
    if (this.overlay) { g.save(); this.overlay(g); g.restore(); }
  }
  // common keys: Space (pan), Ctrl +/-/0/1 zoom. Returns true when handled.
  key(e) {
    if (e.key === ' ' && !e.repeat && e.target.tagName !== 'INPUT') { this.space = true; this.cursor(); e.preventDefault(); return true; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { this.zoomAt(this.W / 2, this.H / 2, 1.5); e.preventDefault(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { this.zoomAt(this.W / 2, this.H / 2, 1 / 1.5); e.preventDefault(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { this.fit(); e.preventDefault(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key === '1') { this.setZoom(1); e.preventDefault(); return true; }
    return false;
  }
  bindKeyUp() { const ku = (e) => { if (e.key === ' ') { this.space = false; this.cursor(); } }; addEventListener('keyup', ku, true); return () => removeEventListener('keyup', ku, true); }
}

// Tool column with exclusive buttons. tools: [[id, icon, title]]
function toolColumn(tools, cur, onPick) {
  const col = el('div', { class: 'tools' });
  const btns = tools.map(([id, icon, title]) => {
    const b = el('button', { class: 'ibtn' + (id === cur ? ' on' : ''), title, html: ico(icon), 'data-tool': id, onclick: () => set(id) });
    col.append(b); return b;
  });
  function set(id) { btns.forEach(b => b.classList.toggle('on', b.dataset.tool === id)); onPick(id); }
  col.set = set; return col;
}
const grp = (title, ...kids) => el('div', { class: 'grp' }, title ? el('div', { class: 'gt' }, title) : null, ...kids);
const row = (label, ...kids) => el('div', { class: 'row' }, el('label', {}, label), ...kids);
const ibtn = (icon, title, onclick, extra = '') => el('button', { class: 'ibtn' + extra, title, html: ico(icon), onclick });
const tbtn = (label, onclick, title) => el('button', { class: 'btn sm', title: title || label, onclick }, label);
// Common key filtering: don't treat keys typed into inputs as shortcuts; Enter in a field just applies it.
function fieldKey(e) {
  const t = e.target, tag = t && t.tagName;
  if (tag === 'INPUT' && t.type !== 'checkbox' && t.type !== 'range') { if (e.key === 'Enter') { t.blur(); t.dispatchEvent(new Event('change')); e.preventDefault(); return 'consumed'; } if (e.key !== 'Escape') return 'consumed'; }
  if (tag === 'SELECT' && /^(Arrow|Home|End|Page)/.test(e.key)) return 'consumed';
  return null;
}
function dot(g, x, y, r, fill, stroke = '#000', lw = 1) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); if (fill) { g.fillStyle = fill; g.fill(); } if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.stroke(); } }
function square(g, x, y, r, fill = '#fff', stroke = '#000') { g.fillStyle = fill; g.fillRect(x - r, y - r, 2 * r, 2 * r); g.lineWidth = 1; g.strokeStyle = stroke; g.strokeRect(x - r + 0.5, y - r + 0.5, 2 * r - 1, 2 * r - 1); }
const toImageData = (im) => new ImageData(im.data, im.width, im.height);

// ================================================================ Puppet Warp
export async function puppetWarpDialog(srcCanvas) {
  const st = new Stage(srcCanvas), full = st.full;
  const opts = { density: 'normal', expansion: 2, mode: 'normal', showMesh: true };
  let mesh = WP.buildPuppetMesh(full, opts);
  if (!mesh) { toast('Could not use Puppet Warp because the layer has no pixels.', 'err'); return null; }
  let sol, edges, bnd, order = null, sp, dp, sel = new Set(), drag = null, hover = null, hidePins = false, kDrag = 16, settle = 0, altDown = false;
  const setup = (m) => { mesh = m; sol = new WP.PuppetSolver(m); sol.setMode(opts.mode); edges = WP.meshEdges(m.tris, sol.n); bnd = WP.triBoundary(m.tris, sol.n); sp = new Float64Array(2 * sol.n); dp = new Float64Array(2 * sol.n); order = null; };
  setup(mesh);
  const info = el('div', { class: 'info' });
  const updInfo = () => { info.textContent = `${sol.pins.length} pin${sol.pins.length === 1 ? '' : 's'} · mesh ${sol.n} points / ${sol.m} triangles`; };
  // ---- solving
  const step = () => {
    const t0 = performance.now();
    if (opts.mode === 'distort') sol.solve(0); else sol.iterate(kDrag);
    const dt = performance.now() - t0;
    if (opts.mode !== 'distort' && dt > 0) kDrag = clamp(Math.floor(kDrag * 12 / dt), 4, 40);
    order = sol.drawOrder(); st.request();
  };
  const fresh = () => { sol.solve(30); order = sol.drawOrder(); startSettle(); st.request(); updInfo(); };
  const startSettle = () => { settle = 90; requestAnimationFrame(settleStep); };
  function settleStep() {
    if (settle <= 0 || drag || opts.mode === 'distort' || !sol.pins.length) return;
    const d = sol.iterate(8); settle -= 8; st.request();
    if (settle > 0 && d > 0.01) requestAnimationFrame(settleStep); else settle = 0;
  }
  // ---- render
  st.content = (out, lv) => {
    const z = st.z, ox = st.ox, oy = st.oy, s = lv.s, q = sol.q, p = sol.p;
    for (let i = 0; i < sol.n; i++) { sp[2 * i] = q[2 * i] * s; sp[2 * i + 1] = q[2 * i + 1] * s; dp[2 * i] = p[2 * i] * z + ox; dp[2 * i + 1] = p[2 * i + 1] * z + oy; }
    WP.rasterizeTriangles(lv.img, sp, dp, mesh.tris, out, { order, boundary: bnd, clip: st.clip(), triMask: mesh.triMask, triMaskScale: lv.s });
  };
  st.overlay = (g) => {
    if (hidePins) return;
    if (opts.showMesh) {
      g.beginPath();
      for (let k = 0; k < edges.length; k += 2) { const a = edges[k], b = edges[k + 1]; g.moveTo(dp[2 * a], dp[2 * a + 1]); g.lineTo(dp[2 * b], dp[2 * b + 1]); }
      g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.28)'; g.stroke(); g.strokeStyle = 'rgba(0,0,0,.42)'; g.lineWidth = 0.6; g.stroke();
    }
    for (const pin of sol.pins) {
      const x = st.sx(pin.x), y = st.sy(pin.y), on = sel.has(pin);
      dot(g, x, y, 5.5, pin === hover?.pin ? '#fff59a' : '#ffd200', '#000', 1.2);
      if (on) dot(g, x, y, 2.3, '#000', null);
      if (pin.angle != null) { g.beginPath(); g.arc(x, y, 9, -Math.PI / 2, -Math.PI / 2 + 1.2); g.strokeStyle = '#ffd200'; g.lineWidth = 1.5; g.stroke(); }
    }
    // Alt: rotation ring around the selected pin under the cursor
    const rp = (drag && drag.kind === 'rotate') ? drag.pin : (altDown && hover && hover.ring) ? hover.ring : null;
    if (rp) {
      const x = st.sx(rp.x), y = st.sy(rp.y), a = rp.angle != null ? rp.angle : sol.rotationAt(rp);
      g.setLineDash([4, 3]); dot(g, x, y, 34, null, 'rgba(255,255,255,.9)', 1.2); g.setLineDash([]);
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 34 * Math.cos(a), y + 34 * Math.sin(a)); g.strokeStyle = '#fff'; g.lineWidth = 1.2; g.stroke();
      g.font = '11px ' + getComputedStyle(document.body).fontFamily; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 3;
      const t = `${Math.round(a * 180 / Math.PI)}°`; g.strokeText(t, x + 40, y - 6); g.fillText(t, x + 40, y - 6);
    }
  };
  // ---- interaction
  const pinAt = (pt) => { let best = null, bd = 8; for (const pin of sol.pins) { const d = Math.hypot(st.sx(pin.x) - pt.sx, st.sy(pin.y) - pt.sy); if (d <= bd) { bd = d; best = pin; } } return best; };
  const ringAt = (pt) => { let best = null, bd = 60; for (const pin of sel) { const d = Math.hypot(st.sx(pin.x) - pt.sx, st.sy(pin.y) - pt.sy); if (d > 8 && d <= bd) { bd = d; best = pin; } } return best; };
  const removePins = (pins) => { for (const p of pins) { sol.removePin(p); sel.delete(p); } if (sol.pins.length) fresh(); else { sol.clearPins(); order = null; st.request(); updInfo(); } syncRot(); };
  st.onDown = (e, pt) => {
    const hit = pinAt(pt);
    if (e.altKey && hit) { removePins([hit]); return; }
    if (e.altKey) { const rp = ringAt(pt); if (rp) { drag = { kind: 'rotate', pin: rp, a0: rp.angle != null ? rp.angle : sol.rotationAt(rp), m0: Math.atan2(pt.y - rp.y, pt.x - rp.x) }; return; } }
    if (hit) {
      if (e.shiftKey) { sel.has(hit) ? sel.delete(hit) : sel.add(hit); } else if (!sel.has(hit)) { sel.clear(); sel.add(hit); }
    } else {
      const pin = sol.addPin(pt.x, pt.y, order);
      if (!pin) { if (!e.shiftKey) sel.clear(); syncRot(); st.request(); return; }
      if (!e.shiftKey) sel.clear(); sel.add(pin); fresh();
    }
    drag = { kind: 'move', x0: pt.x, y0: pt.y, start: [...sel].map(p => [p, p.x, p.y]) };
    syncRot(); st.request();
  };
  st.onMove = (e, pt) => {
    if (!drag) return;
    if (drag.kind === 'move') { for (const [p, x, y] of drag.start) { p.x = x + pt.x - drag.x0; p.y = y + pt.y - drag.y0; } }
    else { const a = drag.a0 + Math.atan2(pt.y - drag.pin.y, pt.x - drag.pin.x) - drag.m0; sol.setPinAngle(drag.pin, a); syncRot(); }
    step();
  };
  st.onUp = () => { if (drag) { drag = null; startSettle(); updInfo(); } };
  st.onHover = (e, pt) => { altDown = e.altKey; const p = pinAt(pt), r = !p && e.altKey ? ringAt(pt) : null; const h = p || r ? { pin: p, ring: r } : null; if ((h && h.pin) !== (hover && hover.pin) || (h && h.ring) !== (hover && hover.ring)) { hover = h; st.request(); } st.cursor(p ? (e.altKey ? 'not-allowed' : 'move') : r ? 'alias' : 'crosshair'); };
  st.cursor('crosshair');
  // ---- options
  const rotSel = selectEl([['auto', 'Auto'], ['fixed', 'Fixed']], 'auto', (v) => { for (const p of sel) sol.setPinAngle(p, v === 'fixed' ? (p.angle != null ? p.angle : sol.rotationAt(p)) : null); syncRot(); fresh(); });
  const rotNum = numField({ value: 0, min: -360, max: 360, step: 1, unit: '°', width: 54, onChange: (v) => { for (const p of sel) sol.setPinAngle(p, v * Math.PI / 180); rotSel.value = 'fixed'; fresh(); } });
  function syncRot() {
    const one = sel.size ? [...sel][0] : null;
    rotSel.disabled = !one; rotNum.input.disabled = !one;
    if (!one) { rotSel.value = 'auto'; rotNum.set(0); return; }
    rotSel.value = one.angle != null ? 'fixed' : 'auto';
    rotNum.set(Math.round((one.angle != null ? one.angle : sol.rotationAt(one)) * 180 / Math.PI)); // clockwise-positive, like Free Transform
  }
  const rebuild = () => {
    const m2 = WP.buildPuppetMesh(full, opts); if (!m2) { toast('The mesh would be empty with this Expansion.', 'err'); return; }
    const old = sol.pins.map(p => ({ r: sol.pinRest(p), x: p.x, y: p.y, angle: p.angle, depth: p.depth, s: sel.has(p) }));
    setup(m2); sel = new Set();
    for (const o of old) { const p = sol.addPinRest(o.r[0], o.r[1], o.x, o.y); if (!p) continue; p.depth = o.depth; if (o.angle != null) sol.setPinAngle(p, o.angle); if (o.s) sel.add(p); }
    fresh();
  };
  const depth = (d) => { if (!sel.size) return; for (const p of sel) p.depth += d; order = sol.drawOrder(); st.request(); };
  const tools = toolColumn([['pin', 'pin', 'Puppet Pin (click to add, drag to move, Alt-click to remove)'], ['hand', 'hand', 'Hand Tool (H / hold Space)'], ['zoom', 'zoom', 'Zoom Tool (Z, Alt-click to zoom out)']], 'pin', (id) => { st.tool = id === 'pin' ? null : id; st.cursor(); });
  const side = el('div', { class: 'side' },
    grp('Mesh',
      row('Mode:', selectEl([['rigid', 'Rigid'], ['normal', 'Normal'], ['distort', 'Distort']], opts.mode, (v) => { opts.mode = v; sol.setMode(v); fresh(); })),
      row('Density:', selectEl([['fewer', 'Fewer Points'], ['normal', 'Normal'], ['more', 'More Points']], opts.density, (v) => { opts.density = v; rebuild(); })),
      row('Expansion:', numField({ value: opts.expansion, min: -50, max: 100, step: 1, unit: 'px', width: 54, onChange: (v) => { opts.expansion = v; rebuild(); } })),
      checkEl('Show Mesh', true, (v) => { opts.showMesh = v; st.request(); })),
    grp('Pins',
      row('Pin Depth:', el('span', { class: 'seg' }, ibtn('fwd', 'Move pin depth forward (draw selected area in front)', () => depth(1)), ibtn('back', 'Move pin depth backward', () => depth(-1)))),
      row('Rotate:', rotSel, rotNum),
      el('div', { class: 'btnrow' }, tbtn('Remove All Pins', () => { sol.clearPins(); sel.clear(); order = null; st.request(); updInfo(); syncRot(); }), tbtn('Select All', () => { sol.pins.forEach(p => sel.add(p)); syncRot(); st.request(); }))),
    info,
    el('div', { class: 'hint' },
      el('div', {}, el('b', {}, 'Click'), ' on the mesh to add a pin; drag pins to warp.'),
      el('div', {}, el('b', {}, 'Shift-click'), ' adds pins to the selection.'),
      el('div', {}, el('b', {}, 'Alt-click'), ' a pin (or Delete) removes it.'),
      el('div', {}, el('b', {}, 'Alt-drag'), ' near a selected pin rotates around it.'),
      el('div', {}, el('b', {}, 'H'), ' hides pins & mesh while held · ', el('b', {}, 'Space'), ' pans · wheel zooms.')));
  syncRot(); updInfo();
  const releaseKeyUp = st.bindKeyUp();
  const keyUp2 = (e) => { if (e.key === 'h' || e.key === 'H') { hidePins = false; st.request(); } if (e.key === 'Alt') { altDown = false; st.request(); } };
  addEventListener('keyup', keyUp2, true);
  const r = await modal({
    title: 'Puppet Warp', className: 'wpx-modal', body: el('div', { class: 'wpx' }, tools, el('div', { class: 'stagewrap' }, st.canvas), side),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => setTimeout(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); st.present(); }, 20),
    onKey: (e) => {
      if (e.type !== 'keydown') return false;
      const fk = fieldKey(e); if (fk) return true;
      if (st.key(e)) return true;
      if (e.key === 'Alt') { altDown = true; e.preventDefault(); st.request(); return true; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.size) { removePins([...sel]); e.preventDefault(); return true; }
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'h') { if (!e.repeat) { hidePins = true; st.request(); } e.preventDefault(); return true; }
        if (k === 'z') { tools.set('zoom'); e.preventDefault(); return true; }
        if (k === 'p' || k === 'v') { tools.set('pin'); e.preventDefault(); return true; }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { sol.pins.forEach(p => sel.add(p)); syncRot(); st.request(); e.preventDefault(); return true; }
      return false;
    },
  });
  releaseKeyUp(); removeEventListener('keyup', keyUp2, true); settle = 0;
  if (!r) return null;
  // converge and render at full resolution
  if (sol.pins.length) { if (opts.mode === 'distort') sol.solve(0); else for (let i = 0; i < 25 && sol.iterate(8) > 0.003; i++); }
  const out = WP.makeImage(st.w, st.h);
  if (!sol.pins.length) out.data.set(full.data);
  else WP.rasterizeTriangles(full, sol.q, sol.p, mesh.tris, out, { order: sol.drawOrder(), boundary: bnd, triMask: mesh.triMask });
  return toImageData(out);
}

// ================================================================ Perspective Warp
export async function perspectiveWarpDialog(srcCanvas) {
  const st = new Stage(srcCanvas), full = st.full;
  // vertices: {x,y} layout (source) position, {wx,wy} warped position. planes: [v0,v1,v2,v3] (vertex objects)
  let verts = [], planes = [], locks = [], mode = 'layout', selPlane = null, drag = null, hover = null, snapTo = null, hideGrid = false, mapCache = null;
  const SNAP = 14;
  const lx = (v) => (mode === 'layout' ? v.x : v.wx), ly = (v) => (mode === 'layout' ? v.y : v.wy);
  const invalidate = () => { mapCache = null; st.request(); updUI(); };
  const buildMap = () => {
    if (mapCache) return mapCache;
    const idx = new Map(verts.map((v, i) => [v, i]));
    mapCache = WP.buildPerspectiveMap(verts.map(v => [v.x, v.y]), verts.map(v => [v.wx, v.wy]), planes.map(p => p.map(v => idx.get(v))));
    return mapCache;
  };
  const planeValid = (p, warped) => WP.quadValid(p.map(v => warped ? [v.wx, v.wy] : [v.x, v.y]));
  const uniqEdges = () => { const m = new Map(); for (const p of planes) for (let k = 0; k < 4; k++) { const a = p[k], b = p[(k + 1) % 4], K = verts.indexOf(a) < verts.indexOf(b) ? [a, b] : [b, a]; const key = verts.indexOf(K[0]) + ',' + verts.indexOf(K[1]); if (!m.has(key)) m.set(key, { a: K[0], b: K[1], n: 0 }); m.get(key).n++; } return [...m.values()]; };
  const lockOf = (a, b) => locks.find(l => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  const applyLocks = (moved) => {
    if (!locks.length) return;
    const V = verts.map(v => [v.wx, v.wy]), id = new Map(verts.map((v, i) => [v, i]));
    WP.enforceLocks(V, locks.map(l => ({ a: id.get(l.a), b: id.get(l.b), axis: l.axis })), moved ? new Set([id.get(moved)]) : null);
    verts.forEach((v, i) => { v.wx = V[i][0]; v.wy = V[i][1]; });
  };
  // ---- render
  st.content = (out, lv, g) => {
    if (mode === 'layout' || !planes.length) {
      g.save(); g.imageSmoothingQuality = 'high'; const r = st.clip(); g.beginPath(); g.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); g.clip();
      g.drawImage(srcCanvas, st.ox, st.oy, st.w * st.z, st.h * st.z); g.restore(); return 'direct';
    }
    WP.renderPerspective(lv.img, lv.s, buildMap(), out, { xf: st.xf, planeGrid: 24, cell: Math.max(2, 14 / st.z), clip: st.clip() });
  };
  st.overlay = (g) => {
    const P = (v) => [st.sx(lx(v)), st.sy(ly(v))];
    const shared = new Set(uniqEdges().filter(e => e.n > 1).map(e => e.a.id + ':' + e.b.id));
    if (!hideGrid) for (const p of planes) {
      const q = p.map(P), ok = planeValid(p, mode === 'warp');
      // inner grid lines (projective)
      const H = WP.homography([[0, 0], [1, 0], [1, 1], [0, 1]], q);
      if (H && ok) {
        g.beginPath();
        for (let k = 1; k < 4; k++) { let a = WP.applyH(H, k / 4, 0), b = WP.applyH(H, k / 4, 1); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); a = WP.applyH(H, 0, k / 4); b = WP.applyH(H, 1, k / 4); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
        g.strokeStyle = ok ? 'rgba(60,150,255,.55)' : 'rgba(255,60,60,.6)'; g.lineWidth = 1; g.stroke();
      }
      if (p === selPlane && mode === 'layout') { g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fillStyle = 'rgba(38,128,235,.12)'; g.fill(); }
      for (let k = 0; k < 4; k++) {
        const a = p[k], b = p[(k + 1) % 4], [x0, y0] = q[k], [x1, y1] = q[(k + 1) % 4];
        const lk = lockOf(a, b), sh = shared.has(a.id + ':' + b.id) || shared.has(b.id + ':' + a.id);
        const hv = hover && hover.edge && ((hover.edge[0] === a && hover.edge[1] === b) || (hover.edge[0] === b && hover.edge[1] === a));
        g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1);
        g.strokeStyle = !ok ? '#ff4040' : lk ? '#ffd200' : hv ? '#fff' : sh ? '#3ee0ff' : '#2a8bff'; g.lineWidth = lk || sh || hv ? 2.2 : 1.5; g.stroke();
      }
    }
    for (const v of verts) {
      const [x, y] = P(v), on = (hover && hover.vert === v) || (drag && drag.vert === v);
      dot(g, x, y, on ? 5.5 : 4.5, on ? '#fff' : '#e8f1ff', '#0b3f8a', 1.4);
      if (snapTo && snapTo === v) dot(g, x, y, 9, null, '#3ee0ff', 2);
    }
    if (drag && drag.kind === 'new') {
      const { x0, y0, x1, y1 } = drag; g.setLineDash([5, 4]); g.strokeStyle = '#2a8bff'; g.lineWidth = 1.5;
      g.strokeRect(st.sx(Math.min(x0, x1)), st.sy(Math.min(y0, y1)), Math.abs(x1 - x0) * st.z, Math.abs(y1 - y0) * st.z); g.setLineDash([]);
    }
  };
  // ---- hit testing (screen px)
  const vertAt = (pt, excl) => { let best = null, bd = 8; for (const v of verts) { if (excl && excl(v)) continue; const d = Math.hypot(st.sx(lx(v)) - pt.sx, st.sy(ly(v)) - pt.sy); if (d <= bd) { bd = d; best = v; } } return best; };
  const edgeAt = (pt) => {
    let best = null, bd = 6;
    for (const p of planes) for (let k = 0; k < 4; k++) {
      const a = p[k], b = p[(k + 1) % 4], ax = st.sx(lx(a)), ay = st.sy(ly(a)), bx = st.sx(lx(b)), by = st.sy(ly(b));
      const dx = bx - ax, dy = by - ay, t = clamp(((pt.sx - ax) * dx + (pt.sy - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
      if (t < 0.08 || t > 0.92) continue;
      const d = Math.hypot(ax + t * dx - pt.sx, ay + t * dy - pt.sy); if (d < bd) { bd = d; best = [a, b]; }
    }
    return best;
  };
  const planeAt = (pt) => { for (let i = planes.length - 1; i >= 0; i--) { const q = planes[i].map(v => [lx(v), ly(v)]); if (pointInQuad(q, pt.x, pt.y)) return planes[i]; } return null; };
  let vid = 1;
  const newVert = (x, y) => { const v = { id: vid++, x, y, wx: x, wy: y }; verts.push(v); return v; };
  const mergeVert = (from, into) => {
    if (from === into) return;
    for (const p of planes) for (let k = 0; k < 4; k++) if (p[k] === from) p[k] = into;
    for (const l of locks) { if (l.a === from) l.a = into; if (l.b === from) l.b = into; }
    locks = locks.filter(l => l.a !== l.b);
    verts = verts.filter(v => v !== from);
    // a plane must not use the same vertex twice
    planes = planes.filter(p => new Set(p).size === 4);
  };
  const snapCandidate = (v, pt) => {
    const own = new Set(planes.filter(p => p.includes(v)).flat());
    return vertAt(pt, (u) => u === v || own.has(u));
  };
  const gc = () => { const used = new Set(planes.flat()); verts = verts.filter(v => used.has(v)); locks = locks.filter(l => used.has(l.a) && used.has(l.b)); };
  st.onDown = (e, pt) => {
    if (mode === 'layout') {
      const v = vertAt(pt);
      if (v) { drag = { kind: 'vert', vert: v }; return; }
      const p = planeAt(pt);
      if (p) { selPlane = p; drag = { kind: 'plane', plane: p, x0: pt.x, y0: pt.y, start: p.map(u => [u, u.x, u.y]) }; st.request(); return; }
      selPlane = null; drag = { kind: 'new', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y }; st.request();
    } else {
      const v = vertAt(pt);
      if (v) { drag = { kind: 'vert', vert: v }; return; }
      const ed = edgeAt(pt);
      if (ed && e.shiftKey) {
        const l = lockOf(ed[0], ed[1]);
        if (l) locks = locks.filter(x => x !== l);
        else { const dx = Math.abs(ed[1].wx - ed[0].wx), dy = Math.abs(ed[1].wy - ed[0].wy); locks.push({ a: ed[0], b: ed[1], axis: dx < dy ? 'v' : 'h' }); applyLocks(null); }
        invalidate();
      }
    }
  };
  st.onMove = (e, pt) => {
    if (!drag) return;
    if (drag.kind === 'new') { drag.x1 = pt.x; drag.y1 = pt.y; st.request(); return; }
    if (drag.kind === 'plane') { for (const [u, x, y] of drag.start) { u.x = u.wx = x + pt.x - drag.x0; u.y = u.wy = y + pt.y - drag.y0; } invalidate(); return; }
    const v = drag.vert;
    if (mode === 'layout') { v.x = v.wx = pt.x; v.y = v.wy = pt.y; snapTo = snapCandidate(v, pt); if (snapTo) { v.x = v.wx = snapTo.x; v.y = v.wy = snapTo.y; } }
    else { v.wx = pt.x; v.wy = pt.y; applyLocks(v); }
    invalidate();
  };
  st.onUp = (e, pt) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'new') {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if ((x1 - x0) * st.z < 12 || (y1 - y0) * st.z < 12) { st.request(); return; }
      const q = [newVert(x0, y0), newVert(x1, y0), newVert(x1, y1), newVert(x0, y1)];
      planes.push(q); selPlane = q;
      // join: corners close to existing vertices are merged (shared edges stay continuous)
      const used = new Set();
      for (let k = 0; k < 4; k++) {
        const v = q[k], sp = { sx: st.sx(v.x), sy: st.sy(v.y) };
        let best = null, bd = SNAP * 1.6;
        for (const u of verts) { if (q.includes(u) || used.has(u)) continue; const dd = Math.hypot(st.sx(u.x) - sp.sx, st.sy(u.y) - sp.sy); if (dd < bd) { bd = dd; best = u; } }
        if (best) { used.add(best); mergeVert(v, best); }
      }
      if (!planes.includes(q)) selPlane = planes[planes.length - 1] || null;
    } else if (d.kind === 'vert' && mode === 'layout' && snapTo) { mergeVert(d.vert, snapTo); }
    snapTo = null; gc(); invalidate();
  };
  st.onHover = (e, pt) => {
    const v = vertAt(pt), ed = !v && mode === 'warp' ? edgeAt(pt) : null;
    const h = v ? { vert: v } : ed ? { edge: ed } : null;
    const same = (h && hover && h.vert === hover.vert && (h.edge && hover.edge ? h.edge[0] === hover.edge[0] && h.edge[1] === hover.edge[1] : h.edge === hover.edge)) || (!h && !hover);
    if (!same) { hover = h; st.request(); }
    st.cursor(v ? 'move' : ed ? (e.shiftKey ? 'pointer' : 'default') : mode === 'layout' ? (planeAt(pt) ? 'move' : 'crosshair') : 'default');
  };
  st.cursor('crosshair');
  // ---- options
  const modeSeg = el('span', { class: 'seg modes' });
  const mbtn = (id, label, icon) => el('button', { class: 'ibtn wide', 'data-mode': id, title: label + (id === 'layout' ? ' (L)' : ' (W)'), onclick: () => setMode(id), html: ico(icon) + `<span>${label}</span>` });
  modeSeg.append(mbtn('layout', 'Layout', 'layout'), mbtn('warp', 'Warp', 'pwarp'));
  const layoutBox = el('div', { class: 'grp' }, el('div', { class: 'gt' }, 'Layout'),
    el('div', { class: 'note' }, 'Drag to draw a plane, then move its corners onto the edges of the architecture. Planes whose corners land near another plane snap and join along the shared edge.'),
    el('div', { class: 'btnrow' }, tbtn('Delete Plane', () => delPlane(), 'Delete the selected plane (Delete)'), tbtn('Clear All', () => { planes = []; verts = []; locks = []; selPlane = null; invalidate(); })));
  const warpBox = el('div', { class: 'grp' }, el('div', { class: 'gt' }, 'Warp'),
    el('div', { class: 'note' }, 'Drag corners to change the perspective. Shift-click an edge to straighten it and keep it straight.'),
    el('div', { class: 'btnrow icons' },
      ibtn('vert', 'Automatically straighten near vertical line segments', () => autoS('v')),
      ibtn('horz', 'Automatically level near horizontal line segments', () => autoS('h')),
      ibtn('both', 'Automatically straighten and level both horizontal and vertical line segments', () => autoS('both'))),
    el('div', { class: 'btnrow' }, tbtn('Remove Warp', () => { for (const v of verts) { v.wx = v.x; v.wy = v.y; } locks = []; invalidate(); }), tbtn('Unlock Edges', () => { locks = []; invalidate(); })));
  const info = el('div', { class: 'info' });
  const tools = toolColumn([['edit', 'pwarp', 'Perspective Warp (edit planes)'], ['hand', 'hand', 'Hand Tool (hold Space)'], ['zoom', 'zoom', 'Zoom Tool (Z, Alt-click to zoom out)']], 'edit', (id) => { st.tool = id === 'edit' ? null : id; st.cursor(); });
  const side = el('div', { class: 'side' }, grp('Mode', modeSeg), layoutBox, warpBox, checkEl('Show Grid (H)', true, (v) => { hideGrid = !v; st.request(); }), info,
    el('div', { class: 'hint' }, el('div', {}, el('b', {}, 'L'), ' / ', el('b', {}, 'W'), ' switch Layout / Warp mode.'), el('div', {}, el('b', {}, 'Space'), ' pans · wheel zooms · ', el('b', {}, 'Ctrl+0'), ' fits.')));
  const gridChk = side.querySelector('input[type=checkbox]');
  function autoS(which) {
    const E = uniqEdges(), id = new Map(verts.map((v, i) => [v, i])), V = verts.map(v => [v.wx, v.wy]);
    const nl = WP.autoStraighten(V, E.map(e => [id.get(e.a), id.get(e.b)]), which);
    for (const l of nl) { const a = verts[l.a], b = verts[l.b]; if (!lockOf(a, b)) locks.push({ a, b, axis: l.axis }); }
    verts.forEach((v, i) => { v.wx = V[i][0]; v.wy = V[i][1]; }); applyLocks(null); invalidate();
  }
  function delPlane() { if (!selPlane || mode !== 'layout') return; planes = planes.filter(p => p !== selPlane); selPlane = null; gc(); invalidate(); }
  function setMode(m) {
    if (m === 'warp' && !planes.length) { toast('Draw at least one plane in Layout mode first.'); m = 'layout'; }
    mode = m; selPlane = null; hover = null;
    $$('button[data-mode]', modeSeg).forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
    layoutBox.classList.toggle('dim', mode !== 'layout'); warpBox.classList.toggle('dim', mode !== 'warp');
    invalidate();
  }
  function updUI() {
    const bad = planes.filter(p => !planeValid(p, mode === 'warp')).length;
    info.textContent = `${planes.length} plane${planes.length === 1 ? '' : 's'}${locks.length ? ` · ${locks.length} straightened edge${locks.length === 1 ? '' : 's'}` : ''}${bad ? ` · ${bad} invalid (red)` : ''}`;
  }
  setMode('layout');
  const releaseKeyUp = st.bindKeyUp();
  const r = await modal({
    title: 'Perspective Warp', className: 'wpx-modal', body: el('div', { class: 'wpx' }, tools, el('div', { class: 'stagewrap' }, st.canvas), side),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => setTimeout(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); st.present(); }, 20),
    onKey: (e) => {
      const fk = fieldKey(e); if (fk) return true;
      if (st.key(e)) return true;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      if (k === 'l') { setMode('layout'); e.preventDefault(); return true; }
      if (k === 'w') { setMode('warp'); e.preventDefault(); return true; }
      if (k === 'h') { hideGrid = !hideGrid; gridChk.checked = !hideGrid; st.request(); e.preventDefault(); return true; }
      if (k === 'z') { tools.set('zoom'); e.preventDefault(); return true; }
      if (k === 'delete' || k === 'backspace') { delPlane(); e.preventDefault(); return true; }
      return false;
    },
  });
  releaseKeyUp();
  if (!r) return null;
  const out = WP.makeImage(st.w, st.h), map = buildMap();
  if (!map.valid.length) out.data.set(full.data);
  else WP.renderPerspective(full, 1, map, out, { planeGrid: 64, cell: 6 });
  return toImageData(out);
}
function pointInQuad(q, x, y) {
  let ins = false;
  for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; }
  return ins;
}

// ================================================================ Transform › Warp
const GRIDS = [['1', 'Default'], ['3', '3 x 3'], ['4', '4 x 4'], ['5', '5 x 5']];
export async function warpTransformDialog(srcCanvas) {
  const st = new Stage(srcCanvas), full = st.full;
  const ab = alphaBounds(srcCanvas, 0);
  if (!ab) { toast('Could not complete the Warp command because the layer is empty.', 'err'); return null; }
  const box = { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
  const P = { style: 'custom', bend: 50, hDist: 0, vDist: 0, vertical: false };
  let N = 1, net = WP.identityNet(box, N), drag = null, hover = null, hideGrid = false;
  const M = () => WP.netSize(N);
  const apply = () => { if (P.style !== 'custom') net = WP.presetNet(P.style, P, box, N); st.request(); syncUI(); };
  // ---- render
  st.content = (out, lv) => {
    const S = clamp(Math.round(Math.max(box.w, box.h) * st.z / 7), 12, 96);
    const m = WP.warpNetMesh(net, N, box, S, lv.s, st.xf);
    WP.rasterizeTriangles(lv.img, m.sp, m.dp, m.tris, out, { clip: st.clip() });
  };
  const ctrlPts = () => { // visible control points: [{i (net index), kind}]
    const m = M(), pts = [];
    for (let r = 0; r < m; r++) for (let c = 0; c < m; c++) {
      const ar = r % 3 === 0, ac = c % 3 === 0;
      if (ar && ac) pts.push({ i: r * m + c, kind: 'anchor', r, c });
      else if (ar || ac) pts.push({ i: r * m + c, kind: 'handle', r, c, anchor: ar ? r * m + (c % 3 === 1 ? c - 1 : c + 1) : (r % 3 === 1 ? r - 1 : r + 1) * m + c });
      else if (N === 1) pts.push({ i: r * m + c, kind: 'inner', r, c });
    }
    return pts;
  };
  const bendHandle = () => { const [x, y] = WP.evalNet(net, N, P.vertical ? 0 : 0.5, P.vertical ? 0.5 : 0); return [x, y]; };
  st.overlay = (g) => {
    if (hideGrid) return;
    const S = (x, y) => [st.sx(x), st.sy(y)];
    // grid curves
    const lines = N === 1 ? [0, 1 / 3, 2 / 3, 1] : Array.from({ length: N + 1 }, (_, k) => k / N);
    g.beginPath();
    for (const t of lines) {
      for (let k = 0; k <= 40; k++) { const [x, y] = S(...WP.evalNet(net, N, k / 40, t)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
      for (let k = 0; k <= 40; k++) { const [x, y] = S(...WP.evalNet(net, N, t, k / 40)); k ? g.lineTo(x, y) : g.moveTo(x, y); }
    }
    g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 2; g.stroke(); g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 1; g.stroke();
    if (P.style !== 'custom') { const [x, y] = S(...bendHandle()); square(g, x, y, 4.5, hover && hover.kind === 'bend' ? '#cfe3ff' : '#fff', '#000'); return; }
    const pts = ctrlPts();
    g.beginPath();
    for (const p of pts) if (p.kind === 'handle') { const [x, y] = S(net[2 * p.i], net[2 * p.i + 1]), [ax, ay] = S(net[2 * p.anchor], net[2 * p.anchor + 1]); g.moveTo(ax, ay); g.lineTo(x, y); }
    g.strokeStyle = '#1d6fd0'; g.lineWidth = 1; g.stroke();
    for (const p of pts) {
      const [x, y] = S(net[2 * p.i], net[2 * p.i + 1]), hv = (hover && hover.i === p.i) || (drag && drag.i === p.i);
      if (p.kind === 'anchor') square(g, x, y, 4, hv ? '#cfe3ff' : '#fff', '#000');
      else if (p.kind === 'handle') dot(g, x, y, 3.5, hv ? '#cfe3ff' : '#fff', '#1d6fd0', 1.2);
      else dot(g, x, y, 3, hv ? '#cfe3ff' : 'rgba(255,255,255,.85)', '#000', 1);
    }
  };
  // ---- interaction
  const hitPoint = (pt) => {
    if (P.style !== 'custom') { const [x, y] = bendHandle(); return Math.hypot(st.sx(x) - pt.sx, st.sy(y) - pt.sy) <= 8 ? { kind: 'bend' } : null; }
    let best = null, bd = 7;
    const pts = ctrlPts(); pts.sort((a, b) => (a.kind === 'inner') - (b.kind === 'inner'));
    for (const p of pts) { const d = Math.hypot(st.sx(net[2 * p.i]) - pt.sx, st.sy(net[2 * p.i + 1]) - pt.sy); if (d < bd - (p.kind === 'inner' ? 0.01 : 0.5)) { bd = d; best = p; } }
    return best;
  };
  const toCustom = () => { if (P.style !== 'custom') { P.style = 'custom'; syncUI(); } };
  st.onDown = (e, pt) => {
    const h = hitPoint(pt);
    if (h && h.kind === 'bend') { drag = { kind: 'bend', x0: pt.x, y0: pt.y, b0: P.bend }; return; }
    if (h) { drag = { ...h, x0: pt.x, y0: pt.y, net0: Float64Array.from(net) }; return; }
    const pk = WP.pickNet(net, N, pt.x, pt.y);
    if (pk.dist * st.z <= 3) { toCustom(); drag = { kind: 'surface', u: pk.u, v: pk.v, x0: pt.x, y0: pt.y, net0: Float64Array.from(net) }; }
  };
  st.onMove = (e, pt) => {
    if (!drag) return;
    const dx = pt.x - drag.x0, dy = pt.y - drag.y0;
    if (drag.kind === 'bend') { P.bend = Math.round(clamp(drag.b0 + (P.vertical ? -dx / box.w : -dy / box.h) * 200, -100, 100)); apply(); return; }
    const m = M(), n0 = drag.net0;
    if (drag.kind === 'surface') net = WP.dragNetSurface(n0, N, drag.u, drag.v, dx, dy);
    else {
      net = Float64Array.from(n0);
      const mv = (i) => { net[2 * i] = n0[2 * i] + dx; net[2 * i + 1] = n0[2 * i + 1] + dy; };
      if (drag.kind === 'anchor') { for (let r = drag.r - 1; r <= drag.r + 1; r++) for (let c = drag.c - 1; c <= drag.c + 1; c++) if (r >= 0 && c >= 0 && r < m && c < m) mv(r * m + c); }
      else {
        mv(drag.i);
        if (drag.kind === 'handle' && !e.altKey) { // keep the opposite handle of interior anchors collinear (smooth)
          const a = drag.anchor, ar = Math.floor(a / m), ac = a % m, opR = 2 * ar - drag.r, opC = 2 * ac - drag.c;
          if (opR >= 0 && opC >= 0 && opR < m && opC < m && (opR !== drag.r || opC !== drag.c)) {
            const o = opR * m + opC, ax = n0[2 * a], ay = n0[2 * a + 1], len = Math.hypot(n0[2 * o] - ax, n0[2 * o + 1] - ay);
            const hx = net[2 * drag.i] - ax, hy = net[2 * drag.i + 1] - ay, hl = Math.hypot(hx, hy) || 1;
            net[2 * o] = ax - hx / hl * len; net[2 * o + 1] = ay - hy / hl * len;
          }
        }
      }
    }
    toCustom(); st.request();
  };
  st.onUp = () => { drag = null; };
  st.onHover = (e, pt) => {
    const h = hitPoint(pt), was = hover; hover = h;
    if ((h && h.i) !== (was && was.i) || (h && h.kind) !== (was && was.kind)) st.request();
    st.cursor(h ? 'move' : P.style === 'custom' && WP.pickNet(net, N, pt.x, pt.y, 24).dist * st.z <= 3 ? 'grab' : 'default');
  };
  st.cursor('default');
  // ---- options
  const styleSel = selectEl(WP.WARP_STYLES, P.style, (v) => { const was = P.style; P.style = v; if (v === 'custom') { syncUI(); return; } if (was === 'custom') P.bend = P.bend || 50; apply(); });
  const bendR = sliderRow({ label: 'Bend:', value: P.bend, min: -100, max: 100, unit: '%', onInput: (v) => { P.bend = v; apply(); } });
  const hR = sliderRow({ label: 'H Distort:', value: 0, min: -100, max: 100, unit: '%', onInput: (v) => { P.hDist = v; apply(); } });
  const vR = sliderRow({ label: 'V Distort:', value: 0, min: -100, max: 100, unit: '%', onInput: (v) => { P.vDist = v; apply(); } });
  const oriH = ibtn('orientH', 'Horizontal warp orientation', () => { P.vertical = false; apply(); }), oriV = ibtn('orientV', 'Vertical warp orientation', () => { P.vertical = true; apply(); });
  const gridSel = selectEl(GRIDS, '1', (v) => { const n2 = Number(v); net = P.style === 'custom' ? WP.resampleNet(net, N, n2) : WP.presetNet(P.style, P, box, n2); N = n2; st.request(); syncUI(); });
  function syncUI() {
    styleSel.value = P.style; gridSel.value = String(N);
    const custom = P.style === 'custom';
    for (const r of [bendR, hR, vR]) r.querySelectorAll('input').forEach(i => (i.disabled = custom));
    bendR.set(P.bend); hR.set(P.hDist); vR.set(P.vDist);
    oriH.classList.toggle('on', !P.vertical); oriV.classList.toggle('on', P.vertical); oriH.disabled = oriV.disabled = custom;
  }
  const tools = toolColumn([['warp', 'warp', 'Warp (drag points, handles or the mesh)'], ['hand', 'hand', 'Hand Tool (hold Space)'], ['zoom', 'zoom', 'Zoom Tool (Z, Alt-click to zoom out)']], 'warp', (id) => { st.tool = id === 'warp' ? null : id; st.cursor(); });
  const side = el('div', { class: 'side' },
    grp('Warp', row('Warp:', styleSel), row('Orientation:', el('span', { class: 'seg' }, oriH, oriV)), bendR, hR, vR),
    grp('Grid', row('Grid:', gridSel), el('div', { class: 'btnrow' }, tbtn('Reset', () => { P.style = 'custom'; P.bend = 50; P.hDist = P.vDist = 0; net = WP.identityNet(box, N); st.request(); syncUI(); }, 'Remove the warp'))),
    checkEl('Show Grid (H)', true, (v) => { hideGrid = !v; st.request(); }),
    el('div', { class: 'hint' },
      el('div', {}, 'Drag a ', el('b', {}, 'corner point'), ', a ', el('b', {}, 'handle'), ' or any part of the ', el('b', {}, 'mesh'), ' to reshape (switches to Custom).'),
      el('div', {}, 'With a style, drag the square handle to change the bend.'),
      el('div', {}, el('b', {}, 'Alt'), '-drag a handle to break its symmetry.')));
  const gridChk = side.querySelectorAll('input[type=checkbox]')[0];
  syncUI();
  const releaseKeyUp = st.bindKeyUp();
  const r = await modal({
    title: 'Warp', className: 'wpx-modal', body: el('div', { class: 'wpx' }, tools, el('div', { class: 'stagewrap' }, st.canvas), side),
    buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onOpen: () => setTimeout(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); st.present(); }, 20),
    onKey: (e) => {
      const fk = fieldKey(e); if (fk) return true;
      if (st.key(e)) return true;
      if (e.ctrlKey || e.metaKey || e.altKey) return false;
      const k = e.key.toLowerCase();
      if (k === 'h') { hideGrid = !hideGrid; gridChk.checked = !hideGrid; st.request(); e.preventDefault(); return true; }
      if (k === 'z') { tools.set('zoom'); e.preventDefault(); return true; }
      return false;
    },
  });
  releaseKeyUp();
  if (!r) return null;
  const out = WP.makeImage(st.w, st.h);
  const S = clamp(Math.ceil(Math.max(box.w, box.h) / 4), 32, 320);
  const m = WP.warpNetMesh(net, N, box, S, 1);
  WP.rasterizeTriangles(full, m.sp, m.dp, m.tris, out);
  return toImageData(out);
}
