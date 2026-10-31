// Viewport: zoom/pan, drawing the composite, overlays (ants, guides, grid, tool UI), rulers, input dispatch.
import { $, ctx2d, createCanvas, clamp, fmtPct } from '../util.js';
import { app, cmd } from '../state.js';
import { antsPath } from '../doc/selection.js';

const ZOOMS = [0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.0625, 0.0833, 0.125, 0.1667, 0.25, 0.3333, 0.5, 0.6667, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32];

export const vp = {
  el: null, view: null, overlay: null, dpr: 1, w: 0, h: 0,
  antsOffset: 0, ants: null, antsRev: -1, antsDoc: null,
  spaceDown: false, hoverPt: null, pointerIn: false, drawQueued: false,
  checker: null, chanCache: null,
};

export function initViewport() {
  vp.el = $('#viewport'); vp.view = $('#view'); vp.overlay = $('#overlay');
  const ro = new ResizeObserver(() => resize()); ro.observe(vp.el);
  resize();
  setupInput();
  setInterval(() => { if (app.doc && app.doc.selection && app.showSelEdges) { vp.antsOffset = (vp.antsOffset + 1) % 8; drawOverlay(); } }, 90);
  app.on('render', requestDraw);
  app.on('selection', () => { vp.antsRev = -1; requestDraw(); });
  const tick = () => { requestAnimationFrame(tick); if (vp.drawQueued) { vp.drawQueued = false; drawAll(); } };
  requestAnimationFrame(tick);
}
export function requestDraw() { vp.drawQueued = true; }

function resize() {
  const r = vp.el.getBoundingClientRect();
  vp.dpr = window.devicePixelRatio || 1;
  vp.w = r.width; vp.h = r.height;
  for (const c of [vp.view, vp.overlay]) { c.width = Math.max(1, Math.round(r.width * vp.dpr)); c.height = Math.max(1, Math.round(r.height * vp.dpr)); }
  for (const id of ['#ruler-h', '#ruler-v']) { const c = $(id), rr = c.getBoundingClientRect(); c.width = Math.max(1, rr.width * vp.dpr); c.height = Math.max(1, rr.height * vp.dpr); }
  drawAll();
}

// ---------- coordinates ----------
export function toScreen(x, y, d = app.doc) { const v = d.view; return { x: (x - v.cx) * v.zoom + vp.w / 2, y: (y - v.cy) * v.zoom + vp.h / 2 }; }
export function toDoc(sx, sy, d = app.doc) { const v = d.view; return { x: (sx - vp.w / 2) / v.zoom + v.cx, y: (sy - vp.h / 2) / v.zoom + v.cy }; }
export function clientToLocal(e) { const r = vp.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

export function fitOnScreen(d = app.doc) {
  if (!d) return;
  const pad = 40, z = Math.min((vp.w - pad) / d.width, (vp.h - pad) / d.height);
  d.view.zoom = clamp(z > 1 ? Math.min(1, z) : z, 0.005, 64);
  if (z > 1) d.view.zoom = 1;
  d.view.cx = d.width / 2; d.view.cy = d.height / 2;
  viewChanged();
}
export function fitFill(d = app.doc) { if (!d) return; d.view.zoom = Math.min((vp.w - 40) / d.width, (vp.h - 40) / d.height); d.view.cx = d.width / 2; d.view.cy = d.height / 2; viewChanged(); }
export function setZoom(z, anchor) {
  const d = app.doc; if (!d) return;
  z = clamp(z, 0.005, 64);
  const a = anchor || { x: vp.w / 2, y: vp.h / 2 };
  const before = toDoc(a.x, a.y);
  d.view.zoom = z;
  const after = toDoc(a.x, a.y);
  d.view.cx += before.x - after.x; d.view.cy += before.y - after.y;
  viewChanged();
}
export function zoomStep(dir, anchor) {
  const d = app.doc; if (!d) return;
  const z = d.view.zoom;
  let nz = dir > 0 ? ZOOMS.find(s => s > z * 1.001) : [...ZOOMS].reverse().find(s => s < z * 0.999);
  setZoom(nz || z, anchor);
}
export function panBy(dx, dy) { const d = app.doc; if (!d) return; d.view.cx -= dx / d.view.zoom; d.view.cy -= dy / d.view.zoom; viewChanged(); }
export function viewChanged() { requestDraw(); app.emit('view'); }

// ---------- drawing ----------
function checkerPattern(g) {
  if (!vp.checker) {
    const s = 8 * vp.dpr, c = createCanvas(s * 2, s * 2), x = ctx2d(c);
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, s * 2, s * 2); x.fillStyle = '#cccccc'; x.fillRect(0, 0, s, s); x.fillRect(s, s, s, s);
    vp.checker = g.createPattern(c, 'repeat');
  }
  return vp.checker;
}

function channelCanvas(d, comp) {
  const ch = d.channelView;
  const key = d.id + ':' + ch + ':' + (d._compVer || 0);
  if (vp.chanCache && vp.chanCache.key === key) return vp.chanCache.canvas;
  const g = ctx2d(comp), id = g.getImageData(0, 0, comp.width, comp.height), px = id.data;
  const k = { r: 0, g: 1, b: 2 }[ch];
  for (let i = 0; i < px.length; i += 4) { const v = px[i + k]; px[i] = px[i + 1] = px[i + 2] = v; }
  const c = vp.chanCache?.canvas && vp.chanCache.canvas.width === comp.width && vp.chanCache.canvas.height === comp.height ? vp.chanCache.canvas : createCanvas(comp.width, comp.height);
  ctx2d(c).putImageData(id, 0, 0);
  vp.chanCache = { key, canvas: c };
  return c;
}

export function drawAll() {
  const g = ctx2d(vp.view, { alpha: false }), d = app.doc;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--pasteboard') || '#282828';
  g.fillRect(0, 0, vp.view.width, vp.view.height);
  if (d) {
    const wasDirty = d.renderDirty;
    const comp = d.render();
    if (wasDirty) d._compVer = (d._compVer || 0) + 1;
    const z = d.view.zoom, dpr = vp.dpr;
    const o = toScreen(0, 0);
    const x = o.x * dpr, y = o.y * dpr, w = d.width * z * dpr, h = d.height * z * dpr;
    g.save();
    g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 10;
    g.fillStyle = checkerPattern(g); g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    g.restore();
    g.imageSmoothingEnabled = z < 2;
    g.imageSmoothingQuality = z < 0.5 ? 'high' : 'medium';
    const src = d.channelView && d.channelView !== 'rgb' ? channelCanvas(d, comp) : comp;
    g.drawImage(src, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    if (d.quickMask) {
      const qm = createCanvas(d.width, d.height), q = ctx2d(qm);
      q.fillStyle = 'rgba(255,0,0,0.5)'; q.fillRect(0, 0, d.width, d.height);
      if (d.selection) { q.globalCompositeOperation = 'destination-out'; q.drawImage(d.selection, 0, 0); }
      g.drawImage(qm, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    }
    // mask view (Alt-click mask thumbnail)
    if (d.showMaskOf) {
      const L = d.find(d.showMaskOf);
      if (L && L.mask) {
        const m = createCanvas(d.width, d.height), mg = ctx2d(m);
        mg.fillStyle = '#000'; mg.fillRect(0, 0, d.width, d.height);
        const a = d.maskAlpha(L, d.width, d.height); mg.drawImage(a, 0, 0);
        g.drawImage(m, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
      }
    }
    // pixel grid at high zoom
    if (z >= 8) {
      g.strokeStyle = 'rgba(128,128,128,.35)'; g.lineWidth = 1; g.beginPath();
      const p0 = toDoc(0, 0), p1 = toDoc(vp.w, vp.h);
      for (let xx = Math.max(0, Math.floor(p0.x)); xx <= Math.min(d.width, Math.ceil(p1.x)); xx++) { const s = toScreen(xx, 0).x * dpr; g.moveTo(Math.round(s) + .5, Math.max(y, 0)); g.lineTo(Math.round(s) + .5, Math.min(y + h, vp.view.height)); }
      for (let yy = Math.max(0, Math.floor(p0.y)); yy <= Math.min(d.height, Math.ceil(p1.y)); yy++) { const s = toScreen(0, yy).y * dpr; g.moveTo(Math.max(x, 0), Math.round(s) + .5); g.lineTo(Math.min(x + w, vp.view.width), Math.round(s) + .5); }
      g.stroke();
    }
  }
  drawOverlay();
  drawRulers();
  updateStatus();
}

export function drawOverlay() {
  const g = ctx2d(vp.overlay), d = app.doc, dpr = vp.dpr;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, vp.overlay.width, vp.overlay.height);
  if (!d) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const z = d.view.zoom, o = toScreen(0, 0);
  // grid
  if (app.showGrid) {
    const step = app.settings.gridSize || 100, sub = app.settings.gridSub || 4;
    g.lineWidth = 1;
    for (let pass = 0; pass < 2; pass++) {
      const st = pass ? step : step / sub; if (st * z < 6) continue;
      g.strokeStyle = pass ? 'rgba(120,120,120,.75)' : 'rgba(120,120,120,.3)';
      g.beginPath();
      for (let x = 0; x <= d.width; x += st) { const s = Math.round(o.x + x * z) + .5; g.moveTo(s, o.y); g.lineTo(s, o.y + d.height * z); }
      for (let y = 0; y <= d.height; y += st) { const s = Math.round(o.y + y * z) + .5; g.moveTo(o.x, s); g.lineTo(o.x + d.width * z, s); }
      g.stroke();
    }
  }
  // guides
  if (app.showGuides && d.guides.length) {
    g.strokeStyle = '#26e0ff'; g.lineWidth = 1; g.beginPath();
    for (const gd of d.guides) {
      if (gd.axis === 'x') { const s = Math.round(o.x + gd.pos * z) + .5; g.moveTo(s, 0); g.lineTo(s, vp.h); }
      else { const s = Math.round(o.y + gd.pos * z) + .5; g.moveTo(0, s); g.lineTo(vp.w, s); }
    }
    g.stroke();
  }
  // artboard labels + frames
  for (const L of d.layers) if (L.artboard) {
    const a = toScreen(L.artboard.x, L.artboard.y), w = L.artboard.w * z, h = L.artboard.h * z;
    g.strokeStyle = d.activeId === L.id ? '#2680eb' : 'rgba(160,160,160,.6)'; g.lineWidth = 1; g.strokeRect(Math.round(a.x) + .5, Math.round(a.y) + .5, Math.round(w), Math.round(h));
    g.fillStyle = d.activeId === L.id ? '#5aa2ff' : '#bbb'; g.font = '11px Segoe UI, sans-serif'; g.fillText(L.name, a.x, a.y - 5);
  }
  // selected path outline (Paths panel) when not using a path tool
  if (app.tools && !['pen', 'freeformPen', 'addAnchor', 'deleteAnchor', 'convertPoint', 'pathSelect', 'directSelect'].includes(app.tool)) {
    const rec = (d.paths || []).find(p => p.id === d.activePathId);
    if (rec && rec.subpaths.length && app._buildPath2D) { g.save(); g.translate(o.x, o.y); g.scale(z, z); g.lineWidth = 1 / z; g.strokeStyle = '#2b7bff'; g.stroke(app._buildPath2D(rec.subpaths)); g.restore(); }
  }
  // marching ants
  if (d.selection && app.showSelEdges && !d.quickMask) {
    if (vp.antsRev !== d.selRev || vp.antsDoc !== d) { vp.ants = antsPath(d.selection); vp.antsRev = d.selRev; vp.antsDoc = d; }
    g.save();
    g.translate(o.x, o.y); g.scale(z, z);
    g.lineWidth = 1 / z;
    g.setLineDash([4 / z, 4 / z]);
    g.strokeStyle = '#fff'; g.lineDashOffset = -vp.antsOffset / z; g.stroke(vp.ants.path);
    g.strokeStyle = '#000'; g.lineDashOffset = (-vp.antsOffset + 4) / z; g.stroke(vp.ants.path);
    g.restore();
  }
  // tool overlay
  const t = app.tools && app.tools[app.tool];
  if (t && t.overlay) { g.save(); try { t.overlay(g, { z, o, toScreen, toDoc, d }); } catch (e) { console.error(e); } g.restore(); }
  if (app.transform && app.transform.overlay) { g.save(); app.transform.overlay(g, { z, o, toScreen, toDoc, d }); g.restore(); }
  // brush cursor
  if (vp.hoverPt && vp.pointerIn && t && t.brushCursor && !vp.spaceDown && !app.transform) {
    const r = t.brushCursor(); const s = toScreen(vp.hoverPt.x, vp.hoverPt.y);
    if (r && r.size * z >= 4) {
      g.lineWidth = 1;
      g.beginPath(); g.arc(s.x, s.y, r.size * z / 2, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(0,0,0,.8)'; g.stroke();
      g.beginPath(); g.arc(s.x, s.y, Math.max(0, r.size * z / 2 - 1), 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,.8)'; g.stroke();
      if (r.hardness != null && r.hardness < 1 && r.size * z > 16) { g.setLineDash([2, 3]); g.beginPath(); g.arc(s.x, s.y, r.size * z / 2 * Math.max(.05, r.hardness), 0, Math.PI * 2); g.strokeStyle = 'rgba(255,255,255,.5)'; g.stroke(); g.setLineDash([]); }
    } else { g.strokeStyle = '#fff'; g.lineWidth = 1; g.beginPath(); g.moveTo(s.x - 6, s.y); g.lineTo(s.x + 6, s.y); g.moveTo(s.x, s.y - 6); g.lineTo(s.x, s.y + 6); g.stroke(); g.strokeStyle = '#000'; g.strokeRect(s.x - .5, s.y - .5, 1, 1); }
    if (r && r.crosshair) { g.strokeStyle = '#000'; g.beginPath(); g.moveTo(s.x - 4, s.y); g.lineTo(s.x + 4, s.y); g.moveTo(s.x, s.y - 4); g.lineTo(s.x, s.y + 4); g.stroke(); }
  }
}

function drawRulers() {
  const wrap = $('#viewport-wrap'); if (!app.showRulers) { wrap.classList.remove('rulers'); return; }
  if (!wrap.classList.contains('rulers')) { wrap.classList.add('rulers'); setTimeout(resize, 0); return; }
  const d = app.doc;
  for (const axis of ['h', 'v']) {
    const c = $('#ruler-' + axis), g = ctx2d(c), dpr = vp.dpr;
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#353535'; g.fillRect(0, 0, c.width, c.height);
    if (!d) continue;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const z = d.view.zoom, len = axis === 'h' ? c.width / dpr : c.height / dpr;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
    const step = steps.find(s => s * z >= 60) || 10000;
    const o = toScreen(0, 0), origin = axis === 'h' ? o.x : o.y;
    g.strokeStyle = '#888'; g.fillStyle = '#aaa'; g.font = '9px Segoe UI, sans-serif'; g.lineWidth = 1; g.beginPath();
    const startV = Math.floor(-origin / z / step) * step;
    for (let v = startV; (v * z + origin) < len; v += step / 10) {
      const p = Math.round(v * z + origin) + .5, major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const half = !major && Math.abs((v / step) * 2 - Math.round((v / step) * 2)) < 1e-6;
      const tl = major ? 18 : half ? 7 : 4;
      if (axis === 'h') { g.moveTo(p, 18); g.lineTo(p, 18 - tl); if (major) g.fillText(String(Math.round(v)), p + 2, 9); }
      else { g.moveTo(18, p); g.lineTo(18 - tl, p); if (major) { g.save(); g.translate(9, p + 2); g.rotate(-Math.PI / 2); g.fillText(String(Math.round(v)), -g.measureText(String(Math.round(v))).width - 2, 0); g.restore(); } }
    }
    g.stroke();
    if (vp.hoverPt) { const s = toScreen(vp.hoverPt.x, vp.hoverPt.y); g.strokeStyle = '#2680eb'; g.beginPath(); if (axis === 'h') { g.moveTo(s.x + .5, 0); g.lineTo(s.x + .5, 18); } else { g.moveTo(0, s.y + .5); g.lineTo(18, s.y + .5); } g.stroke(); }
  }
}

function updateStatus() {
  const d = app.doc;
  $('#st-zoom').textContent = d ? fmtPct(d.view.zoom) : '';
  $('#st-info').textContent = d ? `${d.width} px × ${d.height} px (${d.resolution} ppi)` + (vp.hoverPt ? `   X: ${Math.floor(vp.hoverPt.x)}  Y: ${Math.floor(vp.hoverPt.y)}` : '') : '';
}

// ---------- input ----------
function evInfo(e) {
  const l = clientToLocal(e), p = toDoc(l.x, l.y);
  const pen = e.pointerType === 'pen';
  return { x: p.x, y: p.y, sx: l.x, sy: l.y, button: e.button, buttons: e.buttons, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, pressure: pen ? (e.pressure || 0) : 1, pen, e };
}
let active = null; // {tool, temp}
function currentTool() {
  if (vp.spaceDown) return app.tools[(app.keys && app.keys.ctrl) ? 'zoom' : 'hand'];
  return app.tools[app.tool];
}
function setCursor() {
  const t = currentTool();
  let c = 'default';
  if (t) c = typeof t.cursor === 'function' ? t.cursor(vp.hoverPt) : (t.cursor || 'default');
  if (t && t.brushCursor) c = 'none';
  if (app.transform) c = app.transform.cursor ? app.transform.cursor(vp.hoverPt) : 'default';
  vp.el.style.cursor = c;
}
export const refreshCursor = setCursor;

function setupInput() {
  const el = vp.el;
  el.addEventListener('pointerdown', (e) => {
    if (!app.doc) return;
    e.preventDefault();
    el.focus({ preventScroll: true });
    const info = evInfo(e);
    if (e.button === 1) { active = { tool: app.tools.hand, temp: true }; }
    else if (e.button === 2) return;
    else if (app.transform) { active = { tool: app.transform, temp: true }; }
    else active = { tool: currentTool() };
    // guide drag from existing guide with move tool or ctrl
    if (!app.transform && app.showGuides && (app.tool === 'move' || info.ctrl) && e.button === 0) {
      const gd = hitGuide(info);
      if (gd) { active = { tool: guideDragger(gd), temp: true }; }
    }
    if (!active.tool) return;
    el.setPointerCapture(e.pointerId);
    try { active.tool.down && active.tool.down(info); } catch (err) { console.error(err); app.emit('error', err); active = null; }
    requestDraw();
  });
  el.addEventListener('pointermove', (e) => {
    if (!app.doc) return;
    const info = evInfo(e);
    vp.hoverPt = { x: info.x, y: info.y }; vp.pointerIn = true;
    if (active && active.tool) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ce of (evs.length ? evs : [e])) { try { active.tool.move && active.tool.move(evInfo(ce)); } catch (err) { console.error(err); } }
      requestDraw();
    } else {
      const t = app.transform || currentTool();
      if (t && t.hover) t.hover(info);
      setCursor();
      drawOverlay();
      if (app.showRulers) drawRulers();
      updateStatus();
    }
  });
  const up = (e) => {
    if (!active) return;
    const info = evInfo(e);
    const a = active; active = null;
    try { a.tool.up && a.tool.up(info); } catch (err) { console.error(err); app.emit('error', err); }
    requestDraw(); setCursor();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', () => { vp.pointerIn = false; drawOverlay(); });
  el.addEventListener('pointerenter', () => { vp.pointerIn = true; setCursor(); });
  el.addEventListener('dblclick', (e) => { const t = currentTool(); if (t && t.dblclick) t.dblclick(evInfo(e)); else if (app.transform && app.transform.dblclick) app.transform.dblclick(evInfo(e)); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); const t = currentTool(); if (t && t.contextMenu) t.contextMenu(evInfo(e), e); else app.emit('canvas-context', e); });
  el.addEventListener('wheel', (e) => {
    if (!app.doc) return;
    e.preventDefault();
    const l = clientToLocal(e);
    if (e.ctrlKey || e.altKey || app.settings.wheelZoom) {
      const f = Math.exp(-e.deltaY * (e.ctrlKey && Math.abs(e.deltaY) < 50 ? 0.01 : 0.0025));
      setZoom(app.doc.view.zoom * f, l);
    } else if (e.shiftKey) panBy(-e.deltaY, 0);
    else panBy(-e.deltaX, -e.deltaY);
    vp.hoverPt = toDoc(l.x, l.y);
  }, { passive: false });
  // rulers → guides
  for (const [id, axis] of [['#ruler-h', 'y'], ['#ruler-v', 'x']]) {
    $(id).addEventListener('pointerdown', (e) => {
      if (!app.doc) return;
      const gd = { axis, pos: 0 }; app.doc.guides.push(gd);
      const mv = (ev) => { const l = clientToLocal(ev), p = toDoc(l.x, l.y); gd.pos = Math.round(axis === 'x' ? p.x : p.y); drawOverlay(); };
      const upx = (ev) => { removeEventListener('pointermove', mv); removeEventListener('pointerup', upx); const l = clientToLocal(ev); if (l.x < 0 || l.y < 0) app.doc.guides.splice(app.doc.guides.indexOf(gd), 1); drawOverlay(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', upx);
    });
  }
}
function hitGuide(info) {
  const d = app.doc, tol = 4 / d.view.zoom;
  return d.guides.find(g => Math.abs((g.axis === 'x' ? info.x : info.y) - g.pos) < tol);
}
function guideDragger(gd) {
  return {
    move(i) { gd.pos = Math.round(gd.axis === 'x' ? i.x : i.y); },
    up(i) { const d = app.doc; if (gd.pos < 0 || gd.pos > (gd.axis === 'x' ? d.width : d.height)) d.guides.splice(d.guides.indexOf(gd), 1); },
  };
}

export function setSpace(on) { if (vp.spaceDown === on) return; vp.spaceDown = on; setCursor(); drawOverlay(); }
