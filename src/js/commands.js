// All application commands, the menu bar definition and keyboard shortcuts.
import { app, cmd, defineCommands, setActiveDoc } from './state.js';
import { el, $, createCanvas, ctx2d, cloneCanvas, alphaBounds, clamp, canvasToBlob, bytesToImage, hexToRgb } from './util.js';
import { toast, modal, confirmBox, promptBox, withBusy, showMenu, closeMenus, sliderRow, selectEl, checkEl, alertBox, status } from './ui/common.js';
import { Layer, newDocument, DEFAULT_EFFECTS, refreshVector, Document, smartFilterHooks } from './doc/document.js';
import { openBytes, savePsdBytes, exportBytes, basename, extname, canvasFromBytes } from './doc/io.js';
import { allSel, invertSel, featherCanvas, growSel, borderSel, smoothSel, selFromMask, selToMask, colorRange, magicWand, rectSel, combineSel } from './doc/selection.js';
import { fitOnScreen, setZoom, zoomStep, requestDraw, vp, fitFill } from './view/viewport.js';
import { setTool } from './ui/toolbar.js';
import { tools, rasterizeLayer, resolveTarget, Surface, docRect } from './tools/base.js';
import { startTransform, instantTransform } from './tools/transform.js';
import { cropDocument } from './tools/misc.js';
import { newDocDialog, imageSizeDialog, canvasSizeDialog, filterDialog, adjustmentDialog, colorPickerDialog, layerStyleDialog, liquifyDialog, preferencesDialog, exportDialog, shortcutsDialog } from './ui/dialogs.js';
import { FILTERS, FILTER_CATEGORIES, defaultFilterParams } from './engine/filters.js';
import { ADJUSTMENT_TYPES, defaultParams, applyAdjustment, autoTone, autoContrast, autoColor, equalize, desaturate } from './engine/adjust.js';
import { adjName } from './ui/adjui.js';
import { retouch } from './engine/client.js';
import { adjMenuItems } from './ui/panels.js';

const D = () => app.doc;
const hasDoc = () => !!app.doc;
const hasLayer = () => !!app.doc?.active;
const hasSel = () => !!app.doc?.selection;

// ---------- document management ----------
export function addDoc(doc) {
  doc.historyLimit = app.settings.historyStates || 50;
  app.docs.push(doc);
  bindDoc(doc);
  setActiveDoc(doc);
  requestAnimationFrame(() => fitOnScreen(doc));
  if (doc.importWarnings?.length) toast(doc.importWarnings.join(' '), '', 7000);
}
function bindDoc(doc) {
  doc.on('history', () => app.emit('doc-meta'));
  doc.on('resize', () => requestDraw());
  doc.on('render', () => { if (app.doc === doc) { requestDraw(); app.emit('render'); } });
  doc.on('selection', () => { if (app.doc === doc) app.emit('selection'); });
}
export async function closeDoc(doc, force = false) {
  if (!doc) return true;
  if (doc.dirty && !force) {
    setActiveDoc(doc);
    const r = await window.host.confirm({ message: `Save changes to the Strata document "${doc.name}" before closing?`, buttons: ['Yes', 'No', 'Cancel'], cancelId: 2 });
    if (r === 2) return false;
    if (r === 0 && !(await saveDoc(doc))) return false;
  }
  const i = app.docs.indexOf(doc);
  app.docs.splice(i, 1);
  if (app.transform) app.transform.cancel();
  setActiveDoc(app.docs[Math.min(i, app.docs.length - 1)] || null);
  return true;
}
async function openPaths(paths) {
  for (const p of paths) {
    const existing = app.docs.find(d => d.path === p);
    if (existing) { setActiveDoc(existing); continue; }
    try {
      await withBusy('Opening ' + basename(p) + '…', async () => {
        const bytes = await window.host.readFile(p);
        const doc = await openBytes(bytes, basename(p), p);
        addDoc(doc);
        app.recent = await window.host.addRecent(p);
      });
    } catch (e) { console.error(e); toast(`Could not open "${basename(p)}": ${e.message || e}`, 'err', 7000); }
  }
}
export { openPaths };
export async function saveDoc(doc, as = false) {
  if (doc.parentLink && !as) { const r = updateSmartParent(doc); if (r) return true; }
  let p = doc.path;
  const isPsd = p && /\.(psd|psb)$/i.test(p);
  if (!p || as || !isPsd) {
    const def = (doc.name || 'Untitled').replace(/\.[^.]+$/, '') + '.psd';
    p = await window.host.saveDialog({ title: 'Save As', defaultPath: (doc.path ? doc.path.replace(/[^\\/]+$/, '') : '') + def, filters: [{ name: 'Photoshop (*.psd)', extensions: ['psd'] }, { name: 'PNG', extensions: ['png'] }, { name: 'JPEG', extensions: ['jpg', 'jpeg'] }, { name: 'WebP', extensions: ['webp'] }] });
    if (!p) return false;
  }
  try {
    await withBusy('Saving…', async () => {
      const ext = extname(p);
      let bytes;
      if (ext === 'psd' || ext === 'psb') bytes = savePsdBytes(doc);
      else bytes = await exportBytes(doc, ext === 'jpg' ? 'jpeg' : ext, 0.92);
      await window.host.writeFile(p, bytes);
      if (ext === 'psd' || ext === 'psb') { doc.path = p; doc.name = basename(p); doc.dirty = false; }
      app.recent = await window.host.addRecent(p);
    });
    app.emit('doc-meta');
    status('Saved ' + basename(p));
    return true;
  } catch (e) { console.error(e); toast('Could not save: ' + (e.message || e), 'err', 7000); return false; }
}

// ---------- smart object contents ----------
export function updateSmartParent(doc) {
  const { doc: parent, layerId } = doc.parentLink;
  if (!app.docs.includes(parent)) { toast('The document containing this Smart Object is closed; use Save As to keep a copy.', 'err', 6000); return false; }
  const L = parent.find(layerId); if (!L || L.kind !== 'smart') { toast('The Smart Object layer no longer exists.', 'err'); return false; }
  const c = doc.render(true);
  const sx = L.smart.cache.width / c.width, sy = L.smart.cache.height / c.height;
  L.smart.cache = createCanvas(c.width, c.height); ctx2d(L.smart.cache).drawImage(c, 0, 0);
  if (sx !== 1 || sy !== 1) L.tx = [L.tx[0] * sx, L.tx[1] * sx, L.tx[2] * sy, L.tx[3] * sy, L.tx[4], L.tx[5]];
  L.smart.ver++; L.touch(true); parent.commit('Edit Contents', 'layers');
  doc.dirty = false; app.emit('doc-meta'); toast('Smart Object updated in ' + parent.name, 'ok', 2000);
  return true;
}

// ---------- action recording ----------
export function record(cmdName, ...args) { if (app.recording && app.recordStep) app.recordStep(cmdName, args); }

// ---------- helpers ----------
export function activePixelTarget(name, { allowMask = true } = {}) { return resolveTarget(D(), { allowMask, allowSelection: false, toolName: name }); }
export function selMaskFor(doc, w, h, ox, oy) { if (!doc.selection) return null; const c = createCanvas(w, h); ctx2d(c).drawImage(doc.selection, -ox, -oy); return c; }
export function blendWithSelection(doc, surf, resultCanvas) {
  const g = ctx2d(surf.canvas);
  const sel = selMaskFor(doc, surf.canvas.width, surf.canvas.height, surf.ox, surf.oy);
  g.globalCompositeOperation = 'copy'; g.drawImage(surf.orig, 0, 0); g.globalCompositeOperation = 'source-over';
  if (sel) {
    const r = cloneCanvas(resultCanvas), rg = ctx2d(r); rg.globalCompositeOperation = 'destination-in'; rg.drawImage(sel, 0, 0);
    // remove original inside selection then add result (keeps transparency changes)
    g.globalCompositeOperation = 'destination-out'; g.drawImage(sel, 0, 0); g.globalCompositeOperation = 'source-over';
    g.drawImage(r, 0, 0);
  } else { g.globalCompositeOperation = 'copy'; g.drawImage(resultCanvas, 0, 0); g.globalCompositeOperation = 'source-over'; }
  surf.changed();
}
export function imgOf(c) { const id = ctx2d(c).getImageData(0, 0, c.width, c.height); return { data: id.data, width: c.width, height: c.height }; }
export function canvasOfImg(img) { const c = createCanvas(img.width, img.height); ctx2d(c).putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer ? img.data : img.data), img.width, img.height), 0, 0); return c; }
export function cloneLayer(doc, L) {
  const s = doc.snapLayer(L);
  const re = (snap) => { const n = doc.restoreLayer(snap); n.id = 'L' + Math.random().toString(36).slice(2, 10); if (n.children) n.children = n.children.map(c => { const cs = doc.snapLayer(c); return re(cs); }); return n; };
  const n = re(s); n.name = L.name + ' copy'; n.locks = { ...n.locks, background: false, position: false };
  return n;
}
export function moveRaw(L, dx, dy) {
  if (L.children) L.children.forEach(c => moveRaw(c, dx, dy));
  else if (L.kind === 'text' || L.kind === 'shape' || L.kind === 'smart') { L.tx[4] += dx; L.tx[5] += dy; }
  else if (L.kind === 'pixel') { L.x += dx; L.y += dy; }
  if (L.vmask) for (const sp of L.vmask.subpaths) for (const p of sp.pts) for (const q of [p, p.in, p.out]) if (q) { q.x += dx; q.y += dy; }
  if (L.artboard) { L.artboard.x += dx; L.artboard.y += dy; }
  if (L.mask && L.mask.linked !== false) { L.mask.x += dx; L.mask.y += dy; L.maskRev++; }
  L.touch(L.kind === 'pixel');
}
export function boundsOf(doc, L) {
  if (L.children) { let b = null; for (const c of L.children) { const cb = boundsOf(doc, c); if (cb) b = b ? { x: Math.min(b.x, cb.x), y: Math.min(b.y, cb.y), w: Math.max(b.x + b.w, cb.x + cb.w) - Math.min(b.x, cb.x), h: Math.max(b.y + b.h, cb.y + cb.h) - Math.min(b.y, cb.y) } : cb; } return b; }
  if (L.kind === 'adjustment') return null;
  return L.bounds();
}
export function mergeInto(doc, layers, name) {
  const c = createCanvas(doc.width, doc.height);
  doc.renderList(layers, c, 'merge' + Math.random());
  const b = alphaBounds(c);
  const L = new Layer('pixel', { name });
  if (b) { L.canvas = createCanvas(b.w, b.h); ctx2d(L.canvas).drawImage(c, -b.x, -b.y); L.x = b.x; L.y = b.y; } else { L.canvas = createCanvas(doc.width, doc.height); }
  return L;
}
async function maskForSelection(doc, mode) {
  const L = doc.active; if (!L) return;
  if (L.locks.background) { toast('Could not add a layer mask because the Background layer is locked. Convert it to a normal layer first.', 'err'); return; }
  if (L.mask) { toast('This layer already has a mask.', 'err'); return; }
  const c = createCanvas(doc.width, doc.height), g = ctx2d(c);
  let def = 255;
  if (mode === 'revealSel' || (mode === 'auto' && doc.selection)) { def = 0; g.drawImage(doc.selection, 0, 0); }
  else if (mode === 'hideSel') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.globalCompositeOperation = 'destination-out'; g.drawImage(doc.selection, 0, 0); def = 0; }
  else if (mode === 'hide') { def = 0; }
  else { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  L.mask = { canvas: c, x: 0, y: 0, def, enabled: true, linked: true };
  L.maskRev++; L.touch();
  if (doc.selection && mode !== 'reveal' && mode !== 'hide') doc.setSelection(null);
  app.maskEdit = true; app.emit('maskedit');
  doc.commit('Add Layer Mask', 'mask');
}
function aiProgressRunner(label, fn) { return withBusy(label, (prog) => fn(prog)); }
async function ensureNonBackground(doc, L) { if (L.locks.background) { L.locks = { ...L.locks, background: false, position: false }; L.name = 'Layer 0'; } }

// ---------- destructive filter / adjustment application ----------
export async function runFilter(key, params, { dialog = true } = {}) {
  const doc = D(), F = FILTERS[key]; if (!doc || !F) return;
  if (doc.active?.kind === 'smart') return smartFilterAdd(doc, doc.active, { type: 'filter', key, params: params || { ...defaultFilterParams(key), ...(app.filterMemory?.[key] || {}) } }, dialog && F.params.length ? (p, prev) => filterDialog(key, p, prev) : null);
  const t = await activePixelTarget(F.name.replace('…', '').toLowerCase()); if (!t) return;
  const surf = new Surface(doc, t);
  const env = { fg: app.fg, bg: app.bg, seed: (Math.random() * 1e9) | 0 };
  const srcImg = imgOf(surf.orig);
  const apply = (p) => {
    if (!p) { blendWithSelection(doc, surf, surf.orig); return; }
    const res = F.run(srcImg, p, env);
    blendWithSelection(doc, surf, canvasOfImg(res));
  };
  let p = params || { ...defaultFilterParams(key), ...(app.filterMemory?.[key] || {}) };
  if (dialog && F.params.length) {
    p = await filterDialog(key, p, apply);
    if (!p) { surf.cancel(); return; }
  }
  await withBusy(F.name.replace('…', '') + '…', async () => { await new Promise(r => setTimeout(r, 10)); apply(p); });
  app.filterMemory = { ...(app.filterMemory || {}), [key]: p };
  app.lastFilter = { key, params: p };
  surf.commit(F.name.replace('…', ''), 'liquify');
  record('filterApply', key, p);
}
export async function runAdjustment(type, params) {
  const doc = D(); if (!doc) return;
  if (doc.active?.kind === 'smart') return smartFilterAdd(doc, doc.active, { type: 'adjustment', adjType: type, params: params || defaultParams(type) }, params || type === 'invert' ? null : (p, prev) => adjustmentDialog(type, prev, p));
  const t = await activePixelTarget(adjName(type)); if (!t) return;
  const surf = new Surface(doc, t);
  const src = imgOf(surf.orig);
  const apply = (p) => { const d = new Uint8ClampedArray(src.data); applyAdjustment(d, type, p); blendWithSelection(doc, surf, canvasOfImg({ data: d, width: src.width, height: src.height })); };
  const noDialog = type === 'invert' || !!params;
  const p = params || (noDialog ? {} : await adjustmentDialog(type, apply));
  if (!p) { surf.cancel(); return; }
  apply(p);
  surf.commit(adjName(type), 'adjust');
  record('adjustmentApply', type, p);
}
async function runAuto(fn, name) {
  const doc = D(); const t = await activePixelTarget(name); if (!t) return;
  const surf = new Surface(doc, t), src = imgOf(surf.orig), d = new Uint8ClampedArray(src.data);
  fn(d); blendWithSelection(doc, surf, canvasOfImg({ data: d, width: src.width, height: src.height }));
  surf.commit(name, 'adjust');
}

// ---------- smart filters ----------
export async function smartFilterAdd(doc, L, entry, dialogFn) {
  L.smartFilters = L.smartFilters || [];
  entry = { enabled: true, opacity: 100, blend: 'normal', ...entry };
  L.smartFilters.push(entry);
  const name = entry.type === 'filter' ? FILTERS[entry.key].name.replace('…', '') : entry.type === 'adjustment' ? adjName(entry.adjType) : 'Camera Raw Filter';
  const live = (p) => { if (p) { entry.params = p; entry.enabled = true; } else entry.enabled = false; L.touch(); doc.invalidate(); };
  live(entry.params);
  if (dialogFn) {
    const r = await dialogFn(entry.params, live);
    if (!r) { L.smartFilters.pop(); if (!L.smartFilters.length) L.smartFilters = null; L.touch(); doc.invalidate(); return; }
    entry.params = r; entry.enabled = true;
  }
  L.touch(); doc.commit(name, 'liquify');
  if (entry.type === 'filter') app.lastFilter = { key: entry.key, params: entry.params };
  record(entry.type === 'filter' ? 'filterApply' : 'adjustmentApply', entry.type === 'filter' ? entry.key : entry.adjType, entry.params);
}
export async function smartFilterEdit(doc, L, idx) {
  const f = L.smartFilters[idx]; if (!f) return;
  const old = JSON.parse(JSON.stringify(f.params));
  const live = (p) => { f.params = p || old; L.touch(); doc.invalidate(); };
  let r;
  if (f.type === 'filter') r = await filterDialog(f.key, { ...f.params }, live);
  else if (f.type === 'adjustment') r = await adjustmentDialog(f.adjType, live, JSON.parse(JSON.stringify(f.params)));
  else if (f.type === 'cameraRaw' && app.cameraRaw) { const res = await app.cameraRaw.dialog(L.smart.cache, { settings: f.params }); r = res ? res.settings : null; }
  if (!r) { f.params = old; L.touch(); doc.invalidate(); return; }
  f.params = r; L.touch(); doc.commit('Edit Smart Filter', 'liquify');
}
smartFilterHooks.run = (canvas, f, doc) => {
  try {
    const img = imgOf(canvas);
    let out;
    if (f.type === 'filter') { const F = FILTERS[f.key]; if (!F) return null; out = F.run(img, f.params, { fg: app.fg, bg: app.bg, seed: 7 }); }
    else if (f.type === 'adjustment') { const d = new Uint8ClampedArray(img.data); applyAdjustment(d, f.adjType, f.params); out = { data: d, width: img.width, height: img.height }; }
    else if (f.type === 'cameraRaw' && app.cameraRaw?.apply) out = app.cameraRaw.apply(img, f.params);
    else return null;
    return canvasOfImg(out);
  } catch (e) { console.error('smart filter failed', e); return null; }
};

// ---------- commands ----------
defineCommands({
  // File
  newDoc: { run: async () => { const o = await newDocDialog(); if (o) addDoc(newDocument(o)); } },
  open: { run: async () => { const ps = await window.host.openDialog({}); if (ps.length) await openPaths(ps); } },
  openRecent: { run: (p) => openPaths([p]) },
  clearRecent: { run: async () => { app.recent = await window.host.clearRecent(); app.emit('recent'); } },
  close: { enabled: hasDoc, run: () => closeDoc(D()) },
  closeAll: { enabled: hasDoc, run: async () => { for (const d of [...app.docs]) if (!(await closeDoc(d))) return; } },
  save: { enabled: hasDoc, run: () => saveDoc(D()) },
  saveAs: { enabled: hasDoc, run: () => saveDoc(D(), true) },
  revert: { enabled: () => !!D()?.path, run: async () => { const d = D(); if (!(await confirmBox('Revert to the last saved version? Unsaved changes will be lost.', 'Revert'))) return; const p = d.path; await closeDoc(d, true); await openPaths([p]); } },
  exportAs: { enabled: hasDoc, run: async () => {
    const d = D(), o = await exportDialog(d); if (!o) return;
    const ext = o.fmt === 'jpeg' ? 'jpg' : o.fmt;
    const p = await window.host.saveDialog({ title: 'Export As', defaultPath: d.name.replace(/\.[^.]+$/, '') + '.' + ext, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] }); if (!p) return;
    const bytes = await exportBytes(d, o.fmt, o.q, { width: Math.round(d.width * o.scale / 100), height: Math.round(d.height * o.scale / 100) });
    await window.host.writeFile(p, bytes); toast('Exported ' + basename(p), 'ok');
  } },
  quickExport: { enabled: hasDoc, run: async () => { const d = D(); const p = await window.host.saveDialog({ title: 'Quick Export as PNG', defaultPath: d.name.replace(/\.[^.]+$/, '') + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] }); if (!p) return; await window.host.writeFile(p, await exportBytes(d, 'png')); toast('Exported ' + basename(p), 'ok'); } },
  placeEmbedded: { enabled: hasDoc, run: async () => {
    const ps = await window.host.openDialog({ title: 'Place Embedded', multi: false }); if (!ps.length) return;
    const bytes = await window.host.readFile(ps[0]);
    let c;
    if (/\.(psd|psb)$/i.test(ps[0])) { const pd = await openBytes(bytes, basename(ps[0])); c = pd.render(true); } else c = await canvasFromBytes(bytes, ps[0]);
    placeCanvas(c, basename(ps[0]).replace(/\.[^.]+$/, ''));
  } },
  exit: { run: () => window.close() },

  // Edit
  undo: { enabled: () => D()?.hIndex > 0, run: () => { if (app.transform) { app.transform.cancel(); return; } D().undo(); } },
  redo: { enabled: () => D() && D().hIndex < D().history.length - 1, run: () => D().redo() },
  cut: { enabled: hasSel, run: () => copySel(true) },
  copy: { enabled: hasDoc, run: () => copySel(false) },
  copyMerged: { enabled: hasDoc, run: () => copySel(false, true) },
  paste: { run: () => pasteClip(false) },
  pasteInPlace: { run: () => pasteClip(true) },
  clear: { enabled: hasLayer, run: async () => {
    const d = D();
    if (!d.selection) { cmd('deleteLayer'); return; }
    const t = await activePixelTarget('clear'); if (!t) return;
    const s = new Surface(d, t), g = ctx2d(s.canvas);
    if (t.kind === 'layer' && t.layer.locks.background) { const f = createCanvas(d.width, d.height), fg = ctx2d(f); fg.fillStyle = app.bg; fg.fillRect(0, 0, d.width, d.height); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(d.selection, 0, 0); g.drawImage(f, -s.ox, -s.oy); }
    else { g.globalCompositeOperation = 'destination-out'; g.drawImage(d.selection, -s.ox, -s.oy); g.globalCompositeOperation = 'source-over'; }
    s.commit('Clear', 'eraser');
  } },
  fill: { enabled: hasLayer, run: (preset) => fillDialog(preset) },
  fillFg: { enabled: hasLayer, run: () => fillWith(app.fg, 100, 'normal', 'Fill') },
  fillBg: { enabled: hasLayer, run: () => fillWith(app.bg, 100, 'normal', 'Fill') },
  stroke: { enabled: hasSel, run: () => strokeDialog() },
  contentAwareFill: { enabled: hasSel, run: () => contentAware() },
  generativeFill: { enabled: hasSel, run: (prompt) => generativeFillCmd(prompt) },
  generativeExpand: { enabled: hasDoc, run: async () => {
    const d = D(), o = await canvasSizeDialog(d); if (!o) return;
    if (o.width <= d.width && o.height <= d.height) { toast('Choose a larger canvas size to expand into.', 'err'); return; }
    const ow = d.width, oh = d.height;
    d.resizeCanvas(o.width, o.height, o.ox, o.oy);
    d.commit('Canvas Size', 'crop');
    const c = createCanvas(d.width, d.height), g = ctx2d(c); g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); g.clearRect(o.ox + 2, o.oy + 2, ow - 4, oh - 4);
    d.setSelection(c);
    fitOnScreen(d);
    const prompt = await promptBox('Prompt (optional):', '', 'Generative Expand');
    if (prompt == null) return;
    await generativeFillCmd(prompt);
  } },
  freeTransform: { enabled: hasLayer, run: () => { if (app.tools.type.editing) app.tools.type.commitEdit(); startTransform(D()); } },
  transformOp: { enabled: hasLayer, run: (op) => instantTransform(D(), op) },
  transformSelection: { enabled: hasSel, run: () => startTransform(D(), { selectionOnly: true }) },
  preferences: { run: () => preferencesDialog() },
  shortcuts: { run: () => shortcutsDialog(SHORTCUT_HELP) },
  searchCommands: { run: () => { $('#cmd-search').focus(); } },

  // Image
  adjustment: { enabled: hasLayer, run: (t) => runAdjustment(t) },
  autoTone: { enabled: hasLayer, run: () => runAuto(autoTone, 'Auto Tone') },
  autoContrast: { enabled: hasLayer, run: () => runAuto(autoContrast, 'Auto Contrast') },
  autoColor: { enabled: hasLayer, run: () => runAuto(autoColor, 'Auto Color') },
  desaturate: { enabled: hasLayer, run: () => runAuto(desaturate, 'Desaturate') },
  equalize: { enabled: hasLayer, run: () => runAuto(equalize, 'Equalize') },
  imageSizeDirect: { enabled: hasDoc, run: (o) => { const d = D(); if (o.fit) { const s = Math.min(1, o.fit / Math.max(d.width, d.height)); o = { width: Math.round(d.width * s), height: Math.round(d.height * s), resolution: d.resolution, method: 'auto' }; } return doImageSize(d, o); } },
  imageSize: { enabled: hasDoc, run: async () => {
    const d = D(), o = await imageSizeDialog(d); if (!o) return;
    record('imageSizeApply', o);
    return doImageSize(d, o);
  } },
  _imageSizeOld: { run: async (d, o) => {
    d.resolution = o.resolution;
    if (o.method === 'none' || (o.width === d.width && o.height === d.height)) { d.commit('Image Size', 'crop'); return; }
    const sx = o.width / d.width, sy = o.height / d.height;
    await withBusy('Resizing…', async () => {
      const resample = (c, x, y) => { const nw = Math.max(1, Math.round(c.width * sx)), nh = Math.max(1, Math.round(c.height * sy)); const n = createCanvas(nw, nh), g = ctx2d(n); g.imageSmoothingEnabled = o.method !== 'nearest'; g.imageSmoothingQuality = o.method === 'bilinear' ? 'low' : 'high'; stepDown(g, c, nw, nh, o.method); return { canvas: n, x: Math.round(x * sx), y: Math.round(y * sy) }; };
      d.transformAll(resample, [sx, 0, 0, sy, 0, 0], o.width, o.height);
      for (const L of d.all()) if (L.kind === 'text') { L.tx = [L.tx[0], L.tx[1], L.tx[2], L.tx[3], L.tx[4], L.tx[5]]; L.touch(); }
    });
    d.commit('Image Size', 'crop'); fitOnScreen(d);
  } },
  canvasSize: { enabled: hasDoc, run: async () => { const d = D(), o = await canvasSizeDialog(d); if (!o) return; d.resizeCanvas(o.width, o.height, o.ox, o.oy, o.color); d.commit('Canvas Size', 'crop'); fitOnScreen(d); } },
  rotateCanvas: { enabled: hasDoc, run: (op) => {
    const d = D(), W = d.width, H = d.height;
    const m = { cw: [0, 1, -1, 0, H, 0], ccw: [0, -1, 1, 0, 0, W], r180: [-1, 0, 0, -1, W, H], flipH: [-1, 0, 0, 1, W, 0], flipV: [1, 0, 0, -1, 0, H] }[op];
    const swap = op === 'cw' || op === 'ccw';
    const fn = (c, x, y) => {
      const pts = [[x, y], [x + c.width, y], [x, y + c.height], [x + c.width, y + c.height]].map(([px, py]) => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]);
      const nx = Math.min(...pts.map(p => p[0])), ny = Math.min(...pts.map(p => p[1]));
      const n = createCanvas(swap ? c.height : c.width, swap ? c.width : c.height), g = ctx2d(n);
      g.setTransform(m[0], m[1], m[2], m[3], m[4] + m[0] * x + m[2] * y - nx, m[5] + m[1] * x + m[3] * y - ny); g.drawImage(c, 0, 0);
      return { canvas: n, x: Math.round(nx), y: Math.round(ny) };
    };
    d.transformAll(fn, m, swap ? H : W, swap ? W : H);
    d.commit({ cw: 'Rotate Canvas 90° CW', ccw: 'Rotate Canvas 90° CCW', r180: 'Rotate Canvas 180°', flipH: 'Flip Canvas Horizontal', flipV: 'Flip Canvas Vertical' }[op], 'rotate');
    fitOnScreen(d);
  } },
  cropToSelection: { enabled: hasSel, run: () => { const d = D(), b = d.selBounds || alphaBounds(d.selection); cropDocument(d, b, true); d.setSelection(null); fitOnScreen(d); } },
  trim: { enabled: hasDoc, run: () => { const d = D(); const b = alphaBounds(d.render(true), 0); if (!b) return; cropDocument(d, b, true); fitOnScreen(d); } },
  duplicateDoc: { enabled: hasDoc, run: () => { const d = D(), n = new Document(d.width, d.height, { name: d.name.replace(/\.[^.]+$/, '') + ' copy', resolution: d.resolution }); n.layers = d.layers.map(l => cloneLayer(d, l)); n.layers.forEach(l => l.name = l.name.replace(/ copy$/, '')); if (d.layers[0]?.locks.background) n.layers[0].locks = { ...d.layers[0].locks }; n.activeId = n.layers[n.layers.length - 1]?.id; n.commit('Duplicate', 'new'); addDoc(n); } },
  removeBackground: { enabled: hasLayer, run: async () => {
    const d = D(), L = d.active;
    if (!(L.kind === 'pixel' || L.isVector)) { toast('Select a pixel layer to remove its background.', 'err'); return; }
    if (L.mask) { toast('This layer already has a layer mask. Delete or apply it first.', 'err'); return; }
    await aiProgressRunner('Removing background…', async (prog) => {
      const m = await app.ai.selectSubject(d, { sampleAll: false, onProgress: prog }); if (!m) return;
      await ensureNonBackground(d, L);
      const c = selFromMask(d, m);
      L.mask = { canvas: c, x: 0, y: 0, def: 0, enabled: true, linked: true }; L.maskRev++; L.touch();
      d.commit('Remove Background', 'removeBg');
    });
  } },

  // Layer
  newLayer: { enabled: hasDoc, run: () => { const d = D(), L = d.newPixelLayer(); d.addLayer(L); d.commit('New Layer', 'layers'); } },
  newGroup: { enabled: hasDoc, run: () => { const d = D(), G = new Layer('group', { name: d.nextName('Group'), children: [] }); d.addLayer(G); d.commit('New Group', 'folder'); } },
  layerViaCopy: { enabled: hasLayer, run: () => layerVia(false) },
  layerViaCut: { enabled: hasSel, run: () => layerVia(true) },
  duplicateLayer: { enabled: hasLayer, run: () => { const d = D(); const ids = [...d.selectedIds]; let last; for (const id of ids) { const L = d.find(id); if (!L) continue; last = cmd('duplicateLayerObj', L, true); } if (last) d.setActive(last.id); d.commit('Duplicate Layer', 'layers'); } },
  duplicateLayerObj: { run: (L, noSelect) => { const d = D(), n = cloneLayer(d, L); const p = d.parentList(L.id); p.list.splice(p.index + 1, 0, n); if (!noSelect) d.setActive(n.id); d.invalidate(); return n; } },
  deleteLayer: { enabled: hasLayer, run: () => {
    const d = D(); const ids = [...d.selectedIds].filter(id => d.find(id)); if (!ids.length) return;
    if (d.all().filter(l => !l.children).length <= ids.length && d.layers.length <= 1 && !d.layers[0]?.children) { toast('A document must have at least one layer.', 'err'); return; }
    for (const id of ids) d.removeLayer(id);
    app.maskEdit = false; d.commit('Delete Layer', 'trash');
  } },
  convertBackground: { enabled: () => D()?.active?.locks.background, run: async () => { const d = D(), L = d.active; const n = await promptBox('Name:', 'Layer 0', 'New Layer'); if (n == null) return; L.locks = { ...L.locks, background: false, position: false }; L.name = n || 'Layer 0'; d.commit('Layer From Background', 'layers'); } },
  newFillLayer: { enabled: hasDoc, run: async (kind) => {
    const d = D();
    let data;
    if (kind === 'gradient') data = { fillType: 'gradient', stops: [{ pos: 0, color: app.fg }, { pos: 1, color: app.bg }], type: 'linear', angle: 90, scale: 100 };
    else { const c = await colorPickerDialog(app.fg, 'Pick a solid color:'); if (!c) return; data = { fillType: 'solid', color: c }; }
    const L = new Layer('fill', { name: d.nextName(kind === 'gradient' ? 'Gradient Fill' : 'Color Fill'), data });
    L.mask = maskFromSelOrFull(d); d.addLayer(L); if (d.selection) d.setSelection(null);
    d.commit('New Fill Layer', 'adjust'); app.emit('show-panel', 'properties');
  } },
  newAdjustmentLayer: { enabled: hasDoc, run: (type) => {
    const d = D();
    const L = new Layer('adjustment', { name: d.nextName(adjName(type)), data: { type, params: defaultParams(type) } });
    L.mask = maskFromSelOrFull(d); d.addLayer(L); if (d.selection) d.setSelection(null);
    app.maskEdit = false; app.emit('maskedit');
    d.commit('New ' + adjName(type) + ' Layer', 'adjust'); app.emit('show-panel', 'properties');
  } },
  addMask: { enabled: hasLayer, run: (mode = 'auto') => maskForSelection(D(), mode) },
  applyMask: { enabled: () => !!D()?.active?.mask, run: async () => {
    const d = D(), L = d.active;
    if (L.kind !== 'pixel') { if (!(await confirmBox('The layer must be rasterized to apply the mask. Continue?'))) return; rasterizeLayer(d, L); }
    const b = { x: L.x, y: L.y, w: L.canvas.width, h: L.canvas.height }, g = ctx2d(L.canvas);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(d.maskAlpha(L, b.w, b.h, b.x, b.y), 0, 0); g.globalCompositeOperation = 'source-over';
    L.mask = null; L.touch(true); app.maskEdit = false; app.emit('maskedit'); d.commit('Apply Layer Mask', 'mask');
  } },
  deleteMask: { enabled: () => !!D()?.active?.mask, run: () => { const d = D(); d.active.mask = null; d.active.touch(); app.maskEdit = false; app.emit('maskedit'); d.commit('Delete Layer Mask', 'trash'); } },
  toggleMask: { enabled: () => !!D()?.active?.mask, run: () => { const d = D(), m = d.active.mask; m.enabled = m.enabled === false; d.active.touch(); d.commit(m.enabled ? 'Enable Layer Mask' : 'Disable Layer Mask', 'mask'); } },
  invertMask: { enabled: () => !!D()?.active?.mask, run: () => { const d = D(), L = d.active, m = L.mask; const n = createCanvas(m.canvas.width, m.canvas.height), g = ctx2d(n); g.fillStyle = '#fff'; g.fillRect(0, 0, n.width, n.height); g.globalCompositeOperation = 'destination-out'; g.drawImage(m.canvas, 0, 0); m.canvas = n; m.def = 255 - m.def; L.maskRev++; L.touch(); d.commit('Invert', 'invert'); } },
  maskFeather: { enabled: () => !!D()?.active?.mask, run: async () => { const d = D(), L = d.active, m = L.mask; const r = await numPrompt('Feather Radius:', 5, 0.1, 1000, 'px'); if (r == null) return; const { ensureMaskCovers } = await import('./tools/base.js'); ensureMaskCovers(d, L); m.canvas = featherCanvas(m.canvas, r); L.maskRev++; L.touch(); d.commit('Feather Mask', 'feather'); } },
  maskFromSelection: { enabled: () => !!D()?.active?.mask && hasSel(), run: () => { const d = D(), L = d.active; L.mask = { ...L.mask, canvas: cloneCanvas(d.selection), x: 0, y: 0, def: 0 }; L.maskRev++; L.touch(); d.commit('Mask from Selection', 'mask'); } },
  loadMaskSelection: { enabled: () => !!D()?.active?.mask, run: () => { const d = D(), L = d.active; d.setSelection(d.maskAlpha(L, d.width, d.height)); d.commit('Load Selection', 'marqueeRect'); } },
  loadLayerSelection: { enabled: hasLayer, run: (id, mode = 'new') => { const d = D(), L = id ? d.find(id) : d.active; const c = d.renderLayerAlone(L, false); const s = createCanvas(d.width, d.height), g = ctx2d(s); g.drawImage(c, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); d.setSelection(combineSel(d, s, mode)); d.commit('Load Selection', 'marqueeRect'); } },
  toggleClip: { enabled: hasLayer, run: () => { const d = D(), L = d.active, p = d.parentList(L.id); if (!L.clipped && p.index === 0) { toast('There is no layer below to clip to.', 'err'); return; } L.clipped = !L.clipped; L.touch(); d.commit(L.clipped ? 'Create Clipping Mask' : 'Release Clipping Mask', 'layers'); } },
  layerStyle: { enabled: () => { const L = D()?.active; return !!L && !L.locks.background && L.kind !== 'adjustment'; }, run: (k) => { const d = D(), L = d.active; if (L.locks.background) { toast('Convert the Background to a layer to add layer styles.', 'err'); return; } layerStyleDialog(d, L, k || 'blending'); } },
  copyStyle: { enabled: () => !!D()?.active?.effects, run: () => { app.styleClip = JSON.parse(JSON.stringify(D().active.effects)); } },
  pasteStyle: { enabled: () => !!app.styleClip && hasLayer(), run: () => { const d = D(); for (const id of d.selectedIds) { const L = d.find(id); if (L && !L.locks.background) { L.effects = JSON.parse(JSON.stringify(app.styleClip)); L.touch(); } } d.commit('Paste Layer Style', 'fx'); } },
  clearStyle: { enabled: () => !!D()?.active?.effects, run: () => { const d = D(); d.active.effects = null; d.active.touch(); d.commit('Clear Layer Style', 'fx'); } },
  rasterizeStyle: { enabled: () => !!D()?.active?.effects, run: () => { const d = D(), L = d.active, n = mergeInto(d, [L], L.name); n.opacity = L.opacity; n.blend = L.blend; const p = d.parentList(L.id); p.list[p.index] = n; d.setActive(n.id); d.commit('Rasterize Layer Style', 'raster'); } },
  rasterize: { enabled: () => D()?.active?.isVector, run: () => { const d = D(); rasterizeLayer(d, d.active); d.commit('Rasterize Layer', 'raster'); } },
  arrange: { enabled: hasLayer, run: (dir) => {
    const d = D(), L = d.active, p = d.parentList(L.id), list = p.list, i = p.index;
    if (L.locks.background) return;
    let j = { front: list.length - 1, forward: i + 1, backward: i - 1, back: 0 }[dir];
    if (list[0]?.locks.background && list[0] !== L) j = Math.max(1, j);
    j = clamp(j, 0, list.length - 1); if (j === i) return;
    list.splice(i, 1); list.splice(j, 0, L); d.invalidate(); d.commit('Arrange Layer', 'layers');
  } },
  moveLayersTo: { run: (ids, targetId, where) => {
    const d = D(); const target = d.find(targetId); if (!target || ids.includes(targetId)) return;
    const moving = ids.map(id => d.find(id)).filter(l => l && !l.locks.background);
    const isAncestor = (a, b) => a.children && (a.children.includes(b) || a.children.some(c => isAncestor(c, b)));
    if (moving.some(m => isAncestor(m, target))) return;
    for (const m of moving) { const p = d.parentList(m.id); p.list.splice(p.index, 1); }
    if (where === 'into' && target.children) target.children.push(...moving.reverse());
    else { const p = d.parentList(target.id); let idx = where === 'above' ? p.index + 1 : p.index; if (p.list[0]?.locks.background && idx === 0) idx = 1; p.list.splice(idx, 0, ...moving.reverse()); }
    d.invalidate(); d.commit('Move Layers', 'layers');
  } },
  groupLayers: { enabled: hasLayer, run: () => {
    const d = D(); const sel = d.all().filter(l => d.selectedIds.has(l.id) && !l.locks.background); if (!sel.length) return;
    const first = sel[sel.length - 1]; const p = d.parentList(first.id);
    const G = new Layer('group', { name: d.nextName('Group'), children: [] });
    const ordered = d.all().filter(l => sel.includes(l));
    for (const l of ordered) { const pp = d.parentList(l.id); pp.list.splice(pp.index, 1); }
    G.children = ordered;
    const pp = d.parentList(p.list[Math.min(p.index, p.list.length - 1)]?.id) || { list: d.layers, index: d.layers.length - 1 };
    const insertList = p.list; insertList.splice(Math.min(p.index, insertList.length), 0, G);
    d.setActive(G.id); d.commit('Group Layers', 'folder');
  } },
  ungroup: { enabled: () => !!D()?.active?.children, run: () => { const d = D(), G = d.active, p = d.parentList(G.id); p.list.splice(p.index, 1, ...G.children); d.setActive(G.children[G.children.length - 1]?.id || null); d.commit('Ungroup Layers', 'folder'); } },
  mergeDown: { enabled: hasLayer, run: () => {
    const d = D();
    if (d.selectedIds.size > 1) { const sel = d.all().filter(l => d.selectedIds.has(l.id) && !l.children); const n = mergeInto(d, sel.map(l => Object.assign(Object.create(Object.getPrototypeOf(l)), l, { visible: true })), sel[sel.length - 1].name); const top = sel[sel.length - 1]; const p = d.parentList(top.id); p.list.splice(p.index + 1, 0, n); sel.forEach(l => d.removeLayer(l.id)); d.setActive(n.id); d.commit('Merge Layers', 'layers'); return; }
    const L = d.active, p = d.parentList(L.id); const below = p.list[p.index - 1];
    if (!below) { toast('Could not merge down because there is no layer below.', 'err'); return; }
    if (below.kind === 'adjustment' || !below.visible) { toast('Could not merge down because the layer below is ' + (below.visible ? 'an adjustment layer.' : 'hidden.'), 'err'); return; }
    const n = mergeInto(d, [below, L], below.name);
    if (below.locks.background) { const bg = createCanvas(d.width, d.height), g = ctx2d(bg); g.drawImage(n.canvas, n.x, n.y); n.canvas = bg; n.x = 0; n.y = 0; n.locks = { ...below.locks }; }
    p.list.splice(p.index - 1, 2, n); d.setActive(n.id); d.commit('Merge Down', 'layers');
  } },
  mergeVisible: { enabled: hasDoc, run: () => { const d = D(); const vis = d.layers.filter(l => l.visible); if (vis.length < 2) return; const n = mergeInto(d, vis, vis[0].name); if (vis[0].locks.background) { const bg = createCanvas(d.width, d.height); ctx2d(bg).drawImage(n.canvas, n.x, n.y); n.canvas = bg; n.x = 0; n.y = 0; n.locks = { ...vis[0].locks }; } const idx = d.layers.indexOf(vis[0]); d.layers = d.layers.filter(l => !l.visible); d.layers.splice(Math.min(idx, d.layers.length), 0, n); d.setActive(n.id); d.commit('Merge Visible', 'layers'); } },
  flatten: { enabled: hasDoc, run: async () => {
    const d = D();
    if (d.all().some(l => !l.visible && !l.children) && !(await confirmBox('Discard hidden layers?', 'OK'))) return;
    const c = createCanvas(d.width, d.height), g = ctx2d(c); g.fillStyle = '#fff'; g.fillRect(0, 0, d.width, d.height); g.drawImage(d.render(true), 0, 0);
    const L = new Layer('pixel', { name: 'Background', canvas: c }); L.locks = { ...L.locks, background: true, position: true };
    d.layers = [L]; d.setActive(L.id); app.maskEdit = false; d.commit('Flatten Image', 'layers');
  } },
  stampVisible: { enabled: hasDoc, run: () => { const d = D(), n = mergeInto(d, d.layers, d.nextName('Layer')); d.addLayer(n); d.commit('Stamp Visible', 'layers'); } },
  translateActive: { enabled: hasLayer, run: (dx, dy) => { const d = D(), L = d.active; if (L.locks.position) return; moveRaw(L, Math.round(dx), Math.round(dy)); d.invalidate(); d.commit('Move', 'move'); } },
  align: { enabled: hasLayer, run: (a) => {
    const d = D(); const ls = [...d.selectedIds].map(id => d.find(id)).filter(l => l && !l.locks.position);
    const ref = d.selection ? (d.selBounds || alphaBounds(d.selection)) : ls.length > 1 ? ls.map(l => boundsOf(d, l)).filter(Boolean).reduce((A, B) => ({ x: Math.min(A.x, B.x), y: Math.min(A.y, B.y), w: Math.max(A.x + A.w, B.x + B.w) - Math.min(A.x, B.x), h: Math.max(A.y + A.h, B.y + B.h) - Math.min(A.y, B.y) })) : { x: 0, y: 0, w: d.width, h: d.height };
    for (const l of ls) { const b = boundsOf(d, l); if (!b) continue; const dx = a === 'left' ? ref.x - b.x : a === 'right' ? ref.x + ref.w - b.x - b.w : a === 'hcenter' ? ref.x + ref.w / 2 - b.x - b.w / 2 : 0; const dy = a === 'top' ? ref.y - b.y : a === 'bottom' ? ref.y + ref.h - b.y - b.h : a === 'vcenter' ? ref.y + ref.h / 2 - b.y - b.h / 2 : 0; moveRaw(l, Math.round(dx), Math.round(dy)); }
    d.invalidate(); d.commit('Align', 'move');
  } },
  selectLayerRel: { enabled: hasLayer, run: (dir) => { const d = D(), flat = d.all(); const i = flat.findIndex(l => l.id === d.activeId); const n = flat[clamp(i + dir, 0, flat.length - 1)]; if (n) d.setActive(n.id); } },
  selectAllLayers: { enabled: hasDoc, run: () => { const d = D(); d.selectedIds = new Set(d.all().filter(l => !l.locks.background).map(l => l.id)); d.emit('layers'); } },
  pickVariant: { run: (id, k) => { const d = D(), L = d.find(id); if (!L?.generative) return; L.generative.index = k; L.canvas = cloneCanvas(L.generative.variants[k]); L.touch(true); d.commit('Generative Variation', 'sparkle'); } },
  generateMore: { run: async (id, prompt) => { const d = D(), L = d.find(id); if (!L?.generative) return; const G = L.generative; const m = d.maskAlpha(L, d.width, d.height); const prevSel = d.selection; d.selection = m; d.selBounds = alphaBounds(m); try { await withBusy('Generating…', async (prog) => { const r = await app.ai.generativeFill(d, prompt, { count: 3, onProgress: prog }); const off = { x: r.rect.x - L.x, y: r.rect.y - L.y }; for (const v of r.variants) { const c = createCanvas(L.canvas.width, L.canvas.height); ctx2d(c).drawImage(v, off.x, off.y); G.variants.push(c); } G.prompt = prompt; G.index = G.variants.length - 1; L.canvas = cloneCanvas(G.variants[G.index]); L.touch(true); }); } catch (e) { handleGenErr(e); } finally { d.selection = prevSel; d.selBounds = prevSel ? alphaBounds(prevSel) : null; } d.commit('Generate', 'sparkle'); } },

  // Select
  selectAll: { enabled: hasDoc, run: () => { const d = D(); d.setSelection(allSel(d)); d.commit('Select All', 'marqueeRect'); } },
  deselect: { enabled: hasSel, run: () => { const d = D(); d.setSelection(null); d.commit('Deselect', 'marqueeRect'); } },
  reselect: { enabled: () => !!D()?.lastSelection, run: () => { const d = D(); d.setSelection(cloneCanvas(d.lastSelection)); d.commit('Reselect', 'marqueeRect'); } },
  inverse: { enabled: hasSel, run: () => { const d = D(); d.setSelection(invertSel(d)); d.commit('Inverse', 'marqueeRect'); } },
  selectSubject: { enabled: hasDoc, run: async () => { const d = D(); await aiProgressRunner('Selecting subject…', async (prog) => { const m = await app.ai.selectSubject(d, { sampleAll: true, onProgress: prog }); if (!m) return; d.setSelection(selFromMask(d, m)); d.commit('Select Subject', 'subject'); }); } },
  selectSky: { enabled: hasDoc, run: async () => { const d = D(); await aiProgressRunner('Selecting sky…', async (prog) => { const m = await app.ai.selectSky(d, prog); if (!m) return; d.setSelection(selFromMask(d, m)); d.commit('Select Sky', 'sky'); }); } },
  colorRange: { enabled: hasDoc, run: () => colorRangeDialog() },
  modifySel: { enabled: hasSel, run: async (kind) => {
    const d = D();
    const spec = { border: ['Border', 'Width:', 10, 1, 200], smooth: ['Smooth Selection', 'Sample Radius:', 5, 1, 500], expand: ['Expand Selection', 'Expand By:', 5, 1, 500], contract: ['Contract Selection', 'Contract By:', 5, 1, 500], feather: ['Feather Selection', 'Feather Radius:', 5, 0.1, 1000] }[kind];
    const v = await numPrompt(spec[1], spec[2], spec[3], spec[4], 'pixels', spec[0]); if (v == null) return;
    const s = kind === 'border' ? borderSel(d, v) : kind === 'smooth' ? smoothSel(d, v) : kind === 'expand' ? growSel(d, v) : kind === 'contract' ? growSel(d, -v) : featherCanvas(d.selection, v);
    d.setSelection(s); d.commit(spec[0], 'marqueeRect');
  } },
  grow: { enabled: hasSel, run: () => growSimilar(true) },
  similar: { enabled: hasSel, run: () => growSimilar(false) },
  selectAndMask: { enabled: hasDoc, run: () => selectAndMaskDialog() },
  quickMask: { enabled: hasDoc, run: () => { const d = D(); d.quickMask = !d.quickMask; if (!d.quickMask && d.selection) d.setSelection(d.selection); d.invalidate(); app.emit('quickmask'); requestDraw(); } },

  // Filter
  filter: { enabled: hasLayer, run: (key) => runFilter(key) },
  lastFilter: { enabled: () => !!app.lastFilter && hasLayer(), run: () => runFilter(app.lastFilter.key, app.lastFilter.params, { dialog: false }) },
  liquify: { enabled: hasLayer, run: async () => {
    const d = D(); const t = await activePixelTarget('liquify', { allowMask: false }); if (!t) return;
    const surf = new Surface(d, t);
    const res = await liquifyDialog(surf.orig);
    if (!res) { surf.cancel(); return; }
    blendWithSelection(d, surf, canvasOfImg(res));
    surf.commit('Liquify', 'liquify');
  } },

  // View
  zoomIn: { enabled: hasDoc, run: () => zoomStep(1) },
  zoomOut: { enabled: hasDoc, run: () => zoomStep(-1) },
  fitOnScreen: { enabled: hasDoc, run: () => fitOnScreen() },
  fillScreen: { enabled: hasDoc, run: () => fitFill() },
  zoom100: { enabled: hasDoc, run: () => setZoom(1) },
  zoom200: { enabled: hasDoc, run: () => setZoom(2) },
  toggleRulers: { run: () => { app.showRulers = !app.showRulers; requestDraw(); } },
  toggleGrid: { run: () => { app.showGrid = !app.showGrid; requestDraw(); } },
  toggleGuides: { run: () => { app.showGuides = !app.showGuides; requestDraw(); } },
  toggleExtras: { run: () => { app.showSelEdges = !app.showSelEdges; requestDraw(); } },
  clearGuides: { enabled: () => D()?.guides.length > 0, run: () => { D().guides = []; requestDraw(); } },
  newGuide: { enabled: hasDoc, run: async () => { const v = await promptBox('Position (px), prefix with H for horizontal (e.g. H 200):', '100', 'New Guide'); if (!v) return; const h = /^h/i.test(v.trim()); const n = parseFloat(v.replace(/^[hv]\s*/i, '')); if (!isNaN(n)) { D().guides.push({ axis: h ? 'y' : 'x', pos: n }); requestDraw(); } } },
  channelView: { enabled: hasDoc, run: (ch) => { D().channelView = ch; D().invalidate(); requestDraw(); } },

  // Window / misc
  togglePanels: { run: () => { app.panelsHidden = !app.panelsHidden; $('#panels').classList.toggle('hidden', app.panelsHidden); $('#panel-resizer').classList.toggle('hidden', app.panelsHidden); $('#toolbar').classList.toggle('hidden', app.panelsHidden && app.fullHide); $('#optionsbar').classList.toggle('hidden', app.panelsHidden && app.fullHide); } },
  showPanel: { run: (id) => { if (app.panelsHidden) cmd('togglePanels'); app.emit('show-panel', id); } },
  setTool: { run: (id) => setTool(id) },
  pickColor: { run: async (which) => { const c = await colorPickerDialog(app[which], which === 'fg' ? 'Color Picker (Foreground Color)' : 'Color Picker (Background Color)'); if (c) { app[which] = c; app.emit('colors'); } } },
  swapColors: { run: () => { [app.fg, app.bg] = [app.bg, app.fg]; app.emit('colors'); } },
  defaultColors: { run: () => { app.fg = '#000000'; app.bg = '#ffffff'; app.emit('colors'); } },
  snapshot: { enabled: hasDoc, run: () => { const d = D(); d.snapshots = d.snapshots || []; const s = d.snapshot('Snapshot ' + (d.snapshots.length + 1)); const t = createCanvas(40, 30), comp = d.render(); const sc = Math.min(40 / d.width, 30 / d.height); ctx2d(t).drawImage(comp, (40 - d.width * sc) / 2, (30 - d.height * sc) / 2, d.width * sc, d.height * sc); s.thumb = t; d.snapshots.push(s); d.emit('history'); } },
  restoreSnapshot: { run: (s) => D().restoreSnapshot(s) },
  deleteHistoryState: { enabled: () => D()?.hIndex > 0, run: () => { const d = D(), k = d.hIndex; d.history.length = k; d.goto(k - 1); } },
  about: { run: async () => { const i = await window.host.info(); alertBox(el('div', {}, el('div', { style: { fontSize: '18px', fontWeight: 600, marginBottom: '6px' } }, 'Strata'), `Version ${i.version} · Electron ${i.electron}`, el('br'), 'A layered photo editor. Not affiliated with Adobe.', el('br'), el('br'), 'Open-source components: ag-psd (MIT), Transformers.js (Apache-2.0), ONNX Runtime Web (MIT). Optional AI models are downloaded from Hugging Face under their own licenses (RMBG-1.4 is for non-commercial use).'), 'About Strata'); } },
  devtools: { run: () => window.host.devtools() },
});

function doImageSize(d, o) { return app.commands._imageSizeOld.run(d, o); }
function maskFromSelOrFull(d) {
  const c = createCanvas(d.width, d.height), g = ctx2d(c);
  if (d.selection) { g.drawImage(d.selection, 0, 0); return { canvas: c, x: 0, y: 0, def: 0, enabled: true, linked: true }; }
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  return { canvas: c, x: 0, y: 0, def: 255, enabled: true, linked: true };
}
function stepDown(g, src, nw, nh, method) {
  // progressive downscale for quality when shrinking a lot
  let c = src, w = src.width, h = src.height;
  if (method !== 'nearest') while (w / 2 > nw && h / 2 > nh) { w = Math.round(w / 2); h = Math.round(h / 2); const t = createCanvas(w, h), tg = ctx2d(t); tg.imageSmoothingQuality = 'high'; tg.drawImage(c, 0, 0, w, h); c = t; }
  g.drawImage(c, 0, 0, nw, nh);
}
export async function numPrompt(label, value, min, max, unit, title = 'Strata') {
  let v = value;
  const r = await modal({ title, body: sliderRow({ label, value, min, max, step: min < 1 ? 0.1 : 1, unit, onInput: (x) => v = x, onChange: (x) => v = x }), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => v, primary: true }] });
  return r == null ? null : Number(r);
}
async function layerVia(cut) {
  const d = D(), L = d.active;
  if (L.kind !== 'pixel') { if (!d.selection) { cmd('duplicateLayer'); return; } toast('Rasterize the layer first.', 'err'); return; }
  if (!d.selection) { cmd('duplicateLayer'); return; }
  const c = createCanvas(d.width, d.height), g = ctx2d(c); g.drawImage(L.canvas, L.x, L.y); g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection, 0, 0);
  if (cut) { const lg = ctx2d(L.canvas); if (L.locks.background) { const f = createCanvas(d.width, d.height), fg = ctx2d(f); fg.fillStyle = app.bg; fg.fillRect(0, 0, d.width, d.height); fg.globalCompositeOperation = 'destination-in'; fg.drawImage(d.selection, 0, 0); lg.drawImage(f, -L.x, -L.y); } else { lg.globalCompositeOperation = 'destination-out'; lg.drawImage(d.selection, -L.x, -L.y); lg.globalCompositeOperation = 'source-over'; } L.touch(true); }
  const n = new Layer('pixel', { name: d.nextName('Layer'), canvas: c });
  d.addLayer(n); d.commit(cut ? 'Layer Via Cut' : 'Layer Via Copy', 'layers');
}
async function copySel(cut, merged = false) {
  const d = D(); let src;
  if (merged) src = d.render(true);
  else { const L = d.active; if (!L) return; const ct = d.layerContent(L); src = createCanvas(d.width, d.height); if (ct.canvas) ctx2d(src).drawImage(ct.canvas, ct.x, ct.y); }
  let b = { x: 0, y: 0, w: d.width, h: d.height };
  const c = cloneCanvas(src);
  if (d.selection) { const g = ctx2d(c); g.globalCompositeOperation = 'destination-in'; g.drawImage(d.selection, 0, 0); b = d.selBounds || alphaBounds(d.selection); }
  const out = createCanvas(b.w, b.h); ctx2d(out).drawImage(c, -b.x, -b.y);
  app.clipboard = { canvas: out, x: b.x, y: b.y };
  try { const blob = await canvasToBlob(out); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch (e) { console.warn('system clipboard write failed', e); }
  if (cut) cmd('clear');
}
async function pasteClip(inPlace) {
  let canvas = null, pos = null;
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) { const t = it.types.find(x => x.startsWith('image/')); if (t) { const blob = await it.getType(t); const im = await bytesToImage(new Uint8Array(await blob.arrayBuffer()), t); canvas = createCanvas(im.width, im.height); ctx2d(canvas).drawImage(im, 0, 0); break; } }
  } catch (e) { console.warn('clipboard read failed', e); }
  if (app.clipboard && (!canvas || (canvas.width === app.clipboard.canvas.width && canvas.height === app.clipboard.canvas.height))) { canvas = app.clipboard.canvas; pos = { x: app.clipboard.x, y: app.clipboard.y }; }
  if (!canvas) { toast('There is no image on the clipboard.', 'err'); return; }
  if (!app.doc) { const d = newDocument({ width: canvas.width, height: canvas.height, name: 'Untitled-' + (app.docs.length + 1), background: '#ffffff' }); addDoc(d); }
  const d = D();
  const L = new Layer('pixel', { name: d.nextName('Layer'), canvas: cloneCanvas(canvas) });
  if (inPlace && pos) { L.x = pos.x; L.y = pos.y; }
  else { const vc = d.view; const cx = d.selection ? (d.selBounds.x + d.selBounds.w / 2) : clamp(vc.cx, 0, d.width), cy = d.selection ? (d.selBounds.y + d.selBounds.h / 2) : clamp(vc.cy, 0, d.height); L.x = Math.round(cx - canvas.width / 2); L.y = Math.round(cy - canvas.height / 2); }
  d.addLayer(L); d.setSelection(null); d.commit('Paste', 'layers');
}
export function smartFromCanvas(doc, c, name) {
  const nd = new Document(c.width, c.height, { name: name + '.psb' });
  const nl = nd.newPixelLayer('Layer 0'); ctx2d(nl.canvas).drawImage(c, 0, 0); nd.layers = [nl]; nd.activeId = nl.id; nd.commit('Open'); nd.dirty = false;
  const cache = createCanvas(c.width, c.height); ctx2d(cache).drawImage(c, 0, 0);
  return new Layer('smart', { name, smart: { doc: nd, cache, ver: 1, name }, tx: [1, 0, 0, 1, 0, 0] });
}
function placeCanvas(c, name) {
  const d0 = D(), s0 = Math.min(1, d0.width / c.width, d0.height / c.height);
  const SL = smartFromCanvas(d0, c, name);
  SL.tx = [s0, 0, 0, s0, Math.round((d0.width - c.width * s0) / 2), Math.round((d0.height - c.height * s0) / 2)];
  d0.addLayer(SL); d0.commit('Place Embedded', 'layers');
  startTransform(d0);
  return;
  const d = D();
  const s = Math.min(1, d.width / c.width, d.height / c.height);
  const L = new Layer('pixel', { name });
  L.canvas = createCanvas(Math.round(c.width * s), Math.round(c.height * s));
  const g = ctx2d(L.canvas); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, L.canvas.width, L.canvas.height);
  L.x = Math.round((d.width - L.canvas.width) / 2); L.y = Math.round((d.height - L.canvas.height) / 2);
  d.addLayer(L); d.commit('Place Embedded', 'layers');
  startTransform(d);
}
export { placeCanvas };
async function fillWith(color, opacity, mode, name) {
  const d = D(); const t = await activePixelTarget('fill'); if (!t) return;
  const s = new Surface(d, t), g = ctx2d(s.canvas);
  const f = createCanvas(d.width, d.height), fg = ctx2d(f);
  fg.fillStyle = s.isMaskLike ? '#fff' : color; fg.fillRect(0, 0, d.width, d.height);
  if (d.selection) { fg.globalCompositeOperation = 'destination-in'; fg.drawImage(d.selection, 0, 0); }
  const lockT = t.kind === 'layer' && (t.layer.locks.transparency);
  const modes = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', color: 'color', luminosity: 'luminosity', behind: 'destination-over' };
  if (s.isMaskLike) { const gv = (0.299 * hexToRgb(color).r + 0.587 * hexToRgb(color).g + 0.114 * hexToRgb(color).b) / 255; g.globalAlpha = opacity / 100; g.globalCompositeOperation = 'destination-out'; g.drawImage(f, -s.ox, -s.oy); g.globalAlpha = opacity / 100 * gv; g.globalCompositeOperation = 'lighter'; g.drawImage(f, -s.ox, -s.oy); }
  else { g.globalAlpha = opacity / 100; g.globalCompositeOperation = lockT ? 'source-atop' : (modes[mode] || 'source-over'); g.drawImage(f, -s.ox, -s.oy); }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  s.commit(name, 'bucket');
}
async function fillDialog(preset) {
  let contents = preset || 'fg', opacity = 100, mode = 'normal';
  const body = el('div', {}, el('div', { class: 'row' }, el('label', {}, 'Contents:'), selectEl([['fg', 'Foreground Color'], ['bg', 'Background Color'], ['color', 'Color…'], ['content-aware', 'Content-Aware'], ['black', 'Black'], ['gray', '50% Gray'], ['white', 'White']], contents, (v) => contents = v)),
    el('div', { class: 'row' }, el('label', {}, 'Mode:'), selectEl([['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color', 'Color'], ['luminosity', 'Luminosity'], ['behind', 'Behind']], mode, (v) => mode = v)),
    sliderRow({ label: 'Opacity:', value: 100, min: 0, max: 100, unit: '%', onInput: (v) => opacity = v }));
  const r = await modal({ title: 'Fill', body }); if (!r) return;
  if (contents === 'content-aware') { if (!D().selection) { toast('Content-Aware fill needs a selection.', 'err'); return; } return contentAware(); }
  let color = { fg: app.fg, bg: app.bg, black: '#000000', gray: '#808080', white: '#ffffff' }[contents];
  if (contents === 'color') { color = await colorPickerDialog(app.fg, 'Choose a fill color:'); if (!color) return; }
  fillWith(color, opacity, mode, 'Fill');
}
async function strokeDialog() {
  let width = 3, color = app.fg, loc = 'center', opacity = 100;
  const body = el('div', {}, sliderRow({ label: 'Width:', value: 3, min: 1, max: 250, unit: 'px', onInput: (v) => width = v }), el('div', { class: 'row' }, el('label', {}, 'Color:'), Object.assign(el('input', { type: 'color', value: app.fg }), { oninput: (e) => color = e.target.value })),
    el('div', { class: 'row' }, el('label', {}, 'Location:'), selectEl([['inside', 'Inside'], ['center', 'Center'], ['outside', 'Outside']], loc, (v) => loc = v)), sliderRow({ label: 'Opacity:', value: 100, min: 0, max: 100, unit: '%', onInput: (v) => opacity = v }));
  if (!(await modal({ title: 'Stroke', body }))) return;
  const d = D(); const t = await activePixelTarget('stroke'); if (!t) return;
  const outer = growSel(d, loc === 'inside' ? 0.01 : loc === 'center' ? width / 2 : width) || d.selection;
  const inner = growSel(d, loc === 'inside' ? -width : loc === 'center' ? -width / 2 : 0.01) || createCanvas(1, 1);
  const ring = cloneCanvas(loc === 'inside' ? d.selection : outer), rg = ctx2d(ring); rg.globalCompositeOperation = 'destination-out'; rg.drawImage(loc === 'outside' ? d.selection : inner, 0, 0);
  rg.globalCompositeOperation = 'source-in'; rg.fillStyle = color; rg.fillRect(0, 0, ring.width, ring.height);
  const s = new Surface(d, t), g = ctx2d(s.canvas); g.globalAlpha = opacity / 100; g.drawImage(ring, -s.ox, -s.oy); g.globalAlpha = 1;
  s.commit('Stroke', 'brush');
}
async function contentAware() {
  const d = D(); const t = await activePixelTarget('content-aware fill', { allowMask: false }); if (!t) return;
  const s = new Surface(d, t);
  const b = d.selBounds || alphaBounds(d.selection);
  const W = s.canvas.width, H = s.canvas.height;
  const pad = Math.round(Math.max(64, Math.max(b.w, b.h) * 1.2));
  const r = { x: clamp(b.x - s.ox - pad, 0, W), y: clamp(b.y - s.oy - pad, 0, H) }; r.w = clamp(b.x - s.ox + b.w + pad, 0, W) - r.x; r.h = clamp(b.y - s.oy + b.h + pad, 0, H) - r.y;
  const img = ctx2d(s.orig).getImageData(r.x, r.y, r.w, r.h);
  const sc = createCanvas(r.w, r.h); ctx2d(sc).drawImage(d.selection, -(r.x + s.ox), -(r.y + s.oy));
  const sd = ctx2d(sc).getImageData(0, 0, r.w, r.h).data, mask = new Uint8Array(r.w * r.h); for (let i = 0; i < mask.length; i++) mask[i] = sd[i * 4 + 3];
  try {
    await withBusy('Content-Aware Fill…', async (prog) => {
      const res = await retouch('inpaint', { img: { data: img.data, width: r.w, height: r.h }, mask, opts: {} }, (f) => prog(f));
      ctx2d(s.canvas).putImageData(new ImageData(new Uint8ClampedArray(res), r.w, r.h), r.x, r.y);
    });
  } catch (e) { s.cancel(); throw e; }
  s.commit('Content-Aware Fill', 'patch');
}
function handleGenErr(e) {
  if (e.needsProvider) { modal({ title: 'Generative Fill', body: el('div', { class: 'note', style: { color: 'var(--text)', fontSize: '12px' } }, e.message), buttons: [{ label: 'Close', value: null }, { label: 'Open Preferences…', value: true, primary: true }] }).then(r => r && preferencesDialog()); return; }
  toast(e.message || String(e), 'err', 8000);
}
async function generativeFillCmd(prompt) {
  const d = D(); if (!d.selection) { toast('Make a selection first.', 'err'); return; }
  if (prompt == null) { prompt = await promptBox('Prompt (leave empty to remove/fill with surroundings):', '', 'Generative Fill'); if (prompt == null) return; }
  try {
    await withBusy('Generating…', async (prog) => {
      const r = await app.ai.generativeFill(d, prompt, { count: 3, onProgress: prog });
      const L = new Layer('pixel', { name: prompt ? prompt.slice(0, 40) : 'Generative Layer' });
      L.canvas = cloneCanvas(r.variants[0]); L.x = r.rect.x; L.y = r.rect.y;
      const m = featherCanvas(cloneCanvas(d.selection), 2);
      L.mask = { canvas: m, x: 0, y: 0, def: 0, enabled: true, linked: true };
      L.generative = { prompt, variants: r.variants, index: 0 };
      d.addLayer(L); d.setSelection(null);
      d.commit('Generative Fill', 'sparkle'); app.emit('show-panel', 'properties');
    });
  } catch (e) { handleGenErr(e); }
}
async function growSimilar(contiguous) {
  const d = D(); const comp = d.render(); const id = ctx2d(comp).getImageData(0, 0, d.width, d.height);
  const m = selToMask(d.selection); const acc = new Uint8Array(m.length);
  // sample a few seed points from the selection and union their wands
  const seeds = []; for (let i = 0; i < m.length && seeds.length < 400; i += Math.max(1, Math.floor(m.length / 4000))) if (m[i] > 127) seeds.push(i);
  const tol = app.opts.magicWand?.tolerance ?? 32;
  for (const s of seeds) { if (acc[s] && contiguous) continue; const w = magicWand(id, d.width, d.height, s % d.width, Math.floor(s / d.width), { tolerance: tol, contiguous, antiAlias: true }); for (let k = 0; k < w.length; k++) if (w[k] > acc[k]) acc[k] = w[k]; if (!contiguous) break; }
  for (let k = 0; k < m.length; k++) acc[k] = Math.max(acc[k], m[k]);
  d.setSelection(selFromMask(d, acc)); d.commit(contiguous ? 'Grow' : 'Similar', 'magicWand');
}
async function colorRangeDialog() {
  const d = D(); const comp = d.render(true); const s = Math.min(1, 240 / Math.max(d.width, d.height));
  const small = createCanvas(Math.max(1, Math.round(d.width * s)), Math.max(1, Math.round(d.height * s))); ctx2d(small).drawImage(comp, 0, 0, small.width, small.height);
  let color = app.fg, fuzz = 40, inv = false, mode = 'sampled';
  const pv = el('canvas', { width: small.width, height: small.height, style: { background: '#000', cursor: 'crosshair', border: '1px solid #111' } });
  const draw = () => {
    const id = ctx2d(small).getImageData(0, 0, small.width, small.height);
    const m = mode === 'sampled' ? colorRange(id, small.width, small.height, color, fuzz, inv) : toneRange(id, mode, inv);
    const g = ctx2d(pv), o = g.createImageData(small.width, small.height); for (let i = 0; i < m.length; i++) { o.data[i * 4] = o.data[i * 4 + 1] = o.data[i * 4 + 2] = m[i]; o.data[i * 4 + 3] = 255; } g.putImageData(o, 0, 0);
  };
  pv.onclick = (e) => { const r = pv.getBoundingClientRect(); const px = ctx2d(small).getImageData(Math.floor((e.clientX - r.left) * small.width / r.width), Math.floor((e.clientY - r.top) * small.height / r.height), 1, 1).data; color = '#' + [px[0], px[1], px[2]].map(v => v.toString(16).padStart(2, '0')).join(''); sw.style.background = color; draw(); };
  const sw = el('span', { style: { display: 'inline-block', width: '20px', height: '20px', background: color, border: '1px solid #888' } });
  const body = el('div', { style: { display: 'flex', gap: '14px' } }, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '280px' } },
    el('div', { class: 'row' }, el('label', {}, 'Select:'), selectEl([['sampled', 'Sampled Colors'], ['highlights', 'Highlights'], ['midtones', 'Midtones'], ['shadows', 'Shadows'], ['skin', 'Skin Tones']], mode, (v) => { mode = v; draw(); })),
    el('div', { class: 'row' }, el('label', {}, 'Color:'), sw, el('span', { class: 'muted' }, 'click preview to sample')),
    sliderRow({ label: 'Fuzziness:', value: fuzz, min: 0, max: 200, onInput: (v) => { fuzz = v; draw(); } }), checkEl('Invert', false, (v) => { inv = v; draw(); })), pv);
  draw();
  if (!(await modal({ title: 'Color Range', body }))) return;
  const id = ctx2d(comp).getImageData(0, 0, d.width, d.height);
  const m = mode === 'sampled' ? colorRange(id, d.width, d.height, color, fuzz, inv) : toneRange(id, mode, inv);
  d.setSelection(selFromMask(d, m)); d.commit('Color Range', 'magicWand');
}
function toneRange(img, mode, inv) {
  const d = img.data, out = new Uint8Array(d.length / 4);
  for (let i = 0; i < out.length; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    let v;
    if (mode === 'highlights') v = clamp((l - 0.6) / 0.25, 0, 1);
    else if (mode === 'shadows') v = clamp((0.4 - l) / 0.25, 0, 1);
    else if (mode === 'midtones') v = clamp(1 - Math.abs(l - 0.5) / 0.3, 0, 1);
    else { const isSkin = r > 95 && g > 40 && b > 20 && r > g && r > b && (r - Math.min(g, b)) > 15 && Math.abs(r - g) > 15; v = isSkin ? 1 : 0; }
    out[i] = (inv ? 1 - v : v) * 255;
  }
  return out;
}
async function selectAndMaskDialog() {
  const d = D();
  if (!d.selection) { const go = await confirmBox('Select and Mask works on a selection. Start with Select Subject?', 'Select Subject'); if (!go) return; await cmd('selectSubject'); if (!d.selection) return; }
  const orig = cloneCanvas(d.selection);
  let smooth = 0, feather = 0, contrast = 0, shift = 0, output = 'selection';
  const apply = () => {
    let c = cloneCanvas(orig);
    if (smooth > 0) { c = featherCanvas(c, smooth * 2); hardenSoft(c, 0.5); }
    if (shift) { d.selection = c; c = growSel(d, shift / 100 * 20) || c; }
    if (feather > 0) c = featherCanvas(c, feather);
    if (contrast > 0) hardenSoft(c, contrast / 100);
    d.selection = c; d.selRev++; app.emit('selection');
    return c;
  };
  const body = el('div', { style: { width: '380px' } },
    el('div', { class: 'note' }, 'Refine the selection edge. The canvas updates live.'),
    sliderRow({ label: 'Smooth', value: 0, min: 0, max: 100, onInput: (v) => { smooth = v; apply(); } }),
    sliderRow({ label: 'Feather', value: 0, min: 0, max: 250, step: 0.1, unit: 'px', onInput: (v) => { feather = v; apply(); } }),
    sliderRow({ label: 'Contrast', value: 0, min: 0, max: 100, unit: '%', onInput: (v) => { contrast = v; apply(); } }),
    sliderRow({ label: 'Shift Edge', value: 0, min: -100, max: 100, unit: '%', onInput: (v) => { shift = v; apply(); } }),
    el('div', { class: 'row' }, el('label', {}, 'Output To'), selectEl([['selection', 'Selection'], ['mask', 'Layer Mask'], ['newLayer', 'New Layer'], ['newLayerMask', 'New Layer with Layer Mask']], output, (v) => output = v)),
    el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => cmd('selectSubject') }, 'Select Subject')));
  const ok = await modal({ title: 'Select and Mask', body });
  if (!ok) { d.selection = orig; d.selRev++; app.emit('selection'); return; }
  const c = apply();
  d.setSelection(c);
  if (output === 'selection') d.commit('Select and Mask', 'marqueeRect');
  else if (output === 'mask') await maskForSelection(d, 'revealSel');
  else {
    const L = d.active; if (!L || L.kind !== 'pixel') { d.commit('Select and Mask', 'marqueeRect'); return; }
    const n = cloneLayer(d, L); n.name = L.name + ' copy';
    const p = d.parentList(L.id); p.list.splice(p.index + 1, 0, n); L.visible = false; L.touch(); d.setActive(n.id);
    if (output === 'newLayer') { const g = ctx2d(n.canvas); g.globalCompositeOperation = 'destination-in'; g.drawImage(c, -n.x, -n.y); n.touch(true); d.setSelection(null); d.commit('Select and Mask', 'marqueeRect'); }
    else { n.mask = { canvas: cloneCanvas(c), x: 0, y: 0, def: 0, enabled: true, linked: true }; n.maskRev++; d.setSelection(null); d.commit('Select and Mask', 'mask'); }
  }
}
function hardenSoft(c, k) { const g = ctx2d(c), id = g.getImageData(0, 0, c.width, c.height), d = id.data; const s = 1 + k * 8; for (let i = 3; i < d.length; i += 4) d[i] = clamp((d[i] / 255 - 0.5) * s * 255 + 127.5, 0, 255); g.putImageData(id, 0, 0); }

// ---------- menu bar ----------
const filterMenu = () => {
  const cats = {};
  for (const [k, f] of Object.entries(FILTERS)) { if (f.category === 'Adjust') continue; (cats[f.category] ||= []).push({ label: f.name, cmd: 'filter', args: [k] }); }
  return [
    { label: app.lastFilter ? 'Last Filter: ' + FILTERS[app.lastFilter.key].name.replace('…', '') : 'Last Filter', cmd: 'lastFilter', key: 'Alt+Ctrl+F' }, '-',
    { label: 'Convert for Smart Filters', cmd: 'convertForSmartFilters' }, '-',
    { label: 'Neural Filters…', cmd: 'neuralFilters', icon: 'sparkle' }, '-',
    { label: 'Camera Raw Filter…', cmd: 'cameraRaw', key: 'Shift+Ctrl+A' }, { label: 'Liquify…', cmd: 'liquify', key: 'Shift+Ctrl+X' }, '-',
    ...FILTER_CATEGORIES.filter(c => cats[c]).map(c => ({ label: c, sub: cats[c].sort((a, b) => a.label.localeCompare(b.label)) })),
  ];
};
const adjustSub = () => [
  ...ADJUSTMENT_TYPES.map(a => ({ label: a.name.replace(/…?$/, a.type === 'invert' ? '' : '…'), cmd: 'adjustment', args: [a.type], key: { levels: 'Ctrl+L', curves: 'Ctrl+M', hueSaturation: 'Ctrl+U', colorBalance: 'Ctrl+B', blackWhite: 'Alt+Shift+Ctrl+B', invert: 'Ctrl+I' }[a.type] })),
  '-', { label: 'Shadows/Highlights…', cmd: 'filter', args: ['shadowsHighlights'] }, { label: 'Desaturate', cmd: 'desaturate', key: 'Shift+Ctrl+U' }, { label: 'Equalize', cmd: 'equalize' },
];
export const MENUS = [
  ['File', () => [
    { label: 'New…', cmd: 'newDoc', key: 'Ctrl+N' }, { label: 'Open…', cmd: 'open', key: 'Ctrl+O' },
    { label: 'Open Recent', sub: () => app.recent.length ? [...app.recent.map(p => ({ label: basename(p), run: () => cmd('openRecent', p) })), '-', { label: 'Clear Recent File List', cmd: 'clearRecent' }] : [{ label: '(none)', enabled: () => false }] }, '-',
    { label: 'Close', cmd: 'close', key: 'Ctrl+W' }, { label: 'Close All', cmd: 'closeAll', key: 'Alt+Ctrl+W' }, { label: 'Save', cmd: 'save', key: 'Ctrl+S' }, { label: 'Save As…', cmd: 'saveAs', key: 'Shift+Ctrl+S' }, { label: 'Revert', cmd: 'revert', key: 'F12' }, '-',
    { label: 'Export', sub: [{ label: 'Quick Export as PNG', cmd: 'quickExport' }, { label: 'Export As…', cmd: 'exportAs', key: 'Alt+Shift+Ctrl+W' }, '-', { label: 'Artboards to Files…', cmd: 'exportArtboards' }, { label: 'Animated GIF…', cmd: 'exportGif' }, { label: 'Render Video…', cmd: 'exportVideo' }] },
    { label: 'Automate', sub: [{ label: 'Batch…', cmd: 'batch' }] }, '-',
    { label: 'Place Embedded…', cmd: 'placeEmbedded' }, '-', { label: 'Exit', cmd: 'exit', key: 'Ctrl+Q' }]],
  ['Edit', () => [
    { label: 'Undo ' + (D()?.history[D().hIndex]?.name || ''), cmd: 'undo', key: 'Ctrl+Z' }, { label: 'Redo ' + (D()?.history[D()?.hIndex + 1]?.name || ''), cmd: 'redo', key: 'Shift+Ctrl+Z' }, '-',
    { label: 'Cut', cmd: 'cut', key: 'Ctrl+X' }, { label: 'Copy', cmd: 'copy', key: 'Ctrl+C' }, { label: 'Copy Merged', cmd: 'copyMerged', key: 'Shift+Ctrl+C' }, { label: 'Paste', cmd: 'paste', key: 'Ctrl+V' }, { label: 'Paste in Place', cmd: 'pasteInPlace', key: 'Shift+Ctrl+V' }, { label: 'Clear', cmd: 'clear', key: 'Delete' }, '-',
    { label: 'Generative Fill…', cmd: 'generativeFill', icon: 'sparkle' }, { label: 'Generative Expand…', cmd: 'generativeExpand' }, { label: 'Content-Aware Fill…', cmd: 'contentAwareFill' }, '-',
    { label: 'Fill…', cmd: 'fill', key: 'Shift+F5' }, { label: 'Stroke…', cmd: 'stroke' }, '-',
    { label: 'Puppet Warp', cmd: 'puppetWarp' }, { label: 'Perspective Warp', cmd: 'perspectiveWarp' },
    { label: 'Free Transform', cmd: 'freeTransform', key: 'Ctrl+T' },
    { label: 'Transform', sub: [{ label: 'Rotate 180°', cmd: 'transformOp', args: ['rot180'] }, { label: 'Rotate 90° Clockwise', cmd: 'transformOp', args: ['rot90'] }, { label: 'Rotate 90° Counter Clockwise', cmd: 'transformOp', args: ['rot-90'] }, '-', { label: 'Flip Horizontal', cmd: 'transformOp', args: ['flipH'] }, { label: 'Flip Vertical', cmd: 'transformOp', args: ['flipV'] }, '-', { label: 'Warp', cmd: 'warpTransform' }] }, '-', { label: 'Define Brush Preset…', enabled: () => false }, '-',
    { label: 'Keyboard Shortcuts…', cmd: 'shortcuts', key: 'Alt+Shift+Ctrl+K' }, { label: 'Preferences…', cmd: 'preferences', key: 'Ctrl+K' }]],
  ['Image', () => [
    { label: 'Mode', sub: () => [['bitmap', 'Bitmap…'], ['grayscale', 'Grayscale'], ['indexed', 'Indexed Color…'], ['rgb', 'RGB Color'], ['cmyk', 'CMYK Color (soft proof)'], ['lab', 'Lab Color']].map(([m, n]) => ({ label: n, check: () => (D()?.mode || 'rgb') === m, cmd: 'setMode', args: [m], enabled: () => !!D() && m !== 'lab' })).concat(['-', { label: '8 Bits/Channel', check: true, cmd: 'bitDepth', args: [8] }, { label: '16 Bits/Channel', cmd: 'bitDepth', args: [16] }, { label: '32 Bits/Channel', cmd: 'bitDepth', args: [32] }]) },
    { label: 'Adjustments', sub: adjustSub }, '-',
    { label: 'Auto Tone', cmd: 'autoTone', key: 'Shift+Ctrl+L' }, { label: 'Auto Contrast', cmd: 'autoContrast', key: 'Alt+Shift+Ctrl+L' }, { label: 'Auto Color', cmd: 'autoColor', key: 'Shift+Ctrl+B' }, '-',
    { label: 'Image Size…', cmd: 'imageSize', key: 'Alt+Ctrl+I' }, { label: 'Canvas Size…', cmd: 'canvasSize', key: 'Alt+Ctrl+C' },
    { label: 'Image Rotation', sub: [{ label: '180°', cmd: 'rotateCanvas', args: ['r180'] }, { label: '90° Clockwise', cmd: 'rotateCanvas', args: ['cw'] }, { label: '90° Counter Clockwise', cmd: 'rotateCanvas', args: ['ccw'] }, '-', { label: 'Flip Canvas Horizontal', cmd: 'rotateCanvas', args: ['flipH'] }, { label: 'Flip Canvas Vertical', cmd: 'rotateCanvas', args: ['flipV'] }] },
    { label: 'Crop', cmd: 'cropToSelection' }, { label: 'Trim…', cmd: 'trim' }, '-', { label: 'Duplicate…', cmd: 'duplicateDoc' }, '-', { label: 'Remove Background', cmd: 'removeBackground', icon: 'removeBg' }]],
  ['Layer', () => [
    { label: 'New', sub: [{ label: 'Layer…', cmd: 'newLayer', key: 'Shift+Ctrl+N' }, { label: 'Artboard…', cmd: 'newArtboard' }, { label: 'Artboard from Layers…', cmd: 'artboardFromLayers' }, { label: 'Layer from Background…', cmd: 'convertBackground' }, { label: 'Group…', cmd: 'newGroup' }, { label: 'Group from Layers…', cmd: 'groupLayers', key: 'Ctrl+G' }, '-', { label: 'Layer via Copy', cmd: 'layerViaCopy', key: 'Ctrl+J' }, { label: 'Layer via Cut', cmd: 'layerViaCut', key: 'Shift+Ctrl+J' }] },
    { label: 'Duplicate Layer…', cmd: 'duplicateLayer' }, { label: 'Delete', sub: [{ label: 'Layer', cmd: 'deleteLayer' }] }, '-',
    { label: 'Layer Style', sub: [{ label: 'Blending Options…', cmd: 'layerStyle', args: ['blending'] }, '-', { label: 'Drop Shadow…', cmd: 'layerStyle', args: ['dropShadow'] }, { label: 'Inner Shadow…', cmd: 'layerStyle', args: ['innerShadow'] }, { label: 'Outer Glow…', cmd: 'layerStyle', args: ['outerGlow'] }, { label: 'Stroke…', cmd: 'layerStyle', args: ['stroke'] }, { label: 'Color Overlay…', cmd: 'layerStyle', args: ['colorOverlay'] }, { label: 'Gradient Overlay…', cmd: 'layerStyle', args: ['gradientOverlay'] }, '-', { label: 'Copy Layer Style', cmd: 'copyStyle' }, { label: 'Paste Layer Style', cmd: 'pasteStyle' }, { label: 'Clear Layer Style', cmd: 'clearStyle' }] }, '-',
    { label: 'New Fill Layer', sub: [{ label: 'Solid Color…', cmd: 'newFillLayer', args: ['solid'] }, { label: 'Gradient…', cmd: 'newFillLayer', args: ['gradient'] }] },
    { label: 'New Adjustment Layer', sub: () => ADJUSTMENT_TYPES.map(a => ({ label: a.name.replace(/…?$/, '…'), cmd: 'newAdjustmentLayer', args: [a.type] })) }, '-',
    { label: 'Layer Mask', sub: [{ label: 'Reveal All', cmd: 'addMask', args: ['reveal'] }, { label: 'Hide All', cmd: 'addMask', args: ['hide'] }, { label: 'Reveal Selection', cmd: 'addMask', args: ['revealSel'], enabled: () => hasSel() && hasLayer() }, { label: 'Hide Selection', cmd: 'addMask', args: ['hideSel'], enabled: () => hasSel() && hasLayer() }, '-', { label: 'Delete', cmd: 'deleteMask' }, { label: 'Apply', cmd: 'applyMask' }, '-', { label: 'Disable / Enable', cmd: 'toggleMask' }, { label: 'Invert', cmd: 'invertMask' }] },
    { label: 'Vector Mask', sub: [{ label: 'Reveal All', cmd: 'addVectorMask', args: ['reveal'] }, { label: 'Hide All', cmd: 'addVectorMask', args: ['hide'] }, { label: 'Current Path', cmd: 'addVectorMask', args: ['path'] }, '-', { label: 'Delete', cmd: 'deleteVectorMask' }, { label: 'Disable / Enable', cmd: 'toggleVectorMask' }, { label: 'Edit with Path Tools', cmd: 'editVectorMask' }] },
    { label: 'Create Clipping Mask', cmd: 'toggleClip', key: 'Alt+Ctrl+G' }, '-',
    { label: 'Smart Objects', sub: [{ label: 'Convert to Smart Object', cmd: 'convertToSmart' }, '-', { label: 'New Smart Object via Copy', cmd: 'newSmartViaCopy' }, { label: 'Edit Contents', cmd: 'editContents' }, { label: 'Export Contents…', cmd: 'exportContents' }, { label: 'Replace Contents…', cmd: 'replaceContents' }, { label: 'Reset Transform', cmd: 'resetTransform' }, '-', { label: 'Rasterize', cmd: 'rasterizeSmart' }] }, '-',
    { label: 'Group Layers', cmd: 'groupLayers', key: 'Ctrl+G' }, { label: 'Ungroup Layers', cmd: 'ungroup', key: 'Shift+Ctrl+G' }, '-',
    { label: 'Arrange', sub: [{ label: 'Bring to Front', cmd: 'arrange', args: ['front'], key: 'Shift+Ctrl+]' }, { label: 'Bring Forward', cmd: 'arrange', args: ['forward'], key: 'Ctrl+]' }, { label: 'Send Backward', cmd: 'arrange', args: ['backward'], key: 'Ctrl+[' }, { label: 'Send to Back', cmd: 'arrange', args: ['back'], key: 'Shift+Ctrl+[' }] },
    { label: 'Align', sub: [['left', 'Left Edges'], ['hcenter', 'Horizontal Centers'], ['right', 'Right Edges'], ['top', 'Top Edges'], ['vcenter', 'Vertical Centers'], ['bottom', 'Bottom Edges']].map(([a, n]) => ({ label: n, cmd: 'align', args: [a] })) }, '-',
    { label: 'Rasterize', sub: [{ label: 'Layer', cmd: 'rasterize' }, { label: 'Layer Style', cmd: 'rasterizeStyle' }] }, '-',
    { label: 'Merge Down', cmd: 'mergeDown', key: 'Ctrl+E' }, { label: 'Merge Visible', cmd: 'mergeVisible', key: 'Shift+Ctrl+E' }, { label: 'Stamp Visible', cmd: 'stampVisible', key: 'Alt+Shift+Ctrl+E' }, { label: 'Flatten Image', cmd: 'flatten' }]],
  ['Type', () => [{ label: 'Rasterize Type Layer', cmd: 'rasterize', enabled: () => D()?.active?.kind === 'text' }, { label: 'Character Properties', run: () => cmd('showPanel', 'properties') }, '-', { label: 'Horizontal Type Tool', run: () => setTool('type'), key: 'T' }]],
  ['Select', () => [
    { label: 'All', cmd: 'selectAll', key: 'Ctrl+A' }, { label: 'Deselect', cmd: 'deselect', key: 'Ctrl+D' }, { label: 'Reselect', cmd: 'reselect', key: 'Shift+Ctrl+D' }, { label: 'Inverse', cmd: 'inverse', key: 'Shift+Ctrl+I' }, '-',
    { label: 'All Layers', cmd: 'selectAllLayers', key: 'Alt+Ctrl+A' }, '-',
    { label: 'Color Range…', cmd: 'colorRange' }, { label: 'Subject', cmd: 'selectSubject', icon: 'subject' }, { label: 'Sky', cmd: 'selectSky', icon: 'sky' }, '-',
    { label: 'Select and Mask…', cmd: 'selectAndMask', key: 'Alt+Ctrl+R' },
    { label: 'Modify', sub: [{ label: 'Border…', cmd: 'modifySel', args: ['border'] }, { label: 'Smooth…', cmd: 'modifySel', args: ['smooth'] }, { label: 'Expand…', cmd: 'modifySel', args: ['expand'] }, { label: 'Contract…', cmd: 'modifySel', args: ['contract'] }, { label: 'Feather…', cmd: 'modifySel', args: ['feather'], key: 'Shift+F6' }] },
    { label: 'Grow', cmd: 'grow' }, { label: 'Similar', cmd: 'similar' }, '-', { label: 'Transform Selection', cmd: 'transformSelection' }, '-',
    { label: 'Edit in Quick Mask Mode', cmd: 'quickMask', key: 'Q', check: () => !!D()?.quickMask }, { label: 'Load Selection from Layer', cmd: 'loadLayerSelection' }]],
  ['Filter', filterMenu],
  ['View', () => [
    { label: 'Zoom In', cmd: 'zoomIn', key: 'Ctrl++' }, { label: 'Zoom Out', cmd: 'zoomOut', key: 'Ctrl+-' }, { label: 'Fit on Screen', cmd: 'fitOnScreen', key: 'Ctrl+0' }, { label: 'Fill Screen', cmd: 'fillScreen' }, { label: '100%', cmd: 'zoom100', key: 'Ctrl+1' }, { label: '200%', cmd: 'zoom200' }, '-',
    { label: 'Channel', sub: [['rgb', 'RGB', 'Ctrl+2'], ['r', 'Red', 'Ctrl+3'], ['g', 'Green', 'Ctrl+4'], ['b', 'Blue', 'Ctrl+5']].map(([c, n, k]) => ({ label: n, key: k, cmd: 'channelView', args: [c], check: () => (D()?.channelView || 'rgb') === c })) }, '-',
    { label: 'Proof Colors', cmd: 'proofColors', key: 'Ctrl+Y', check: () => !!D()?.proof || D()?.mode === 'cmyk' }, { label: 'Gamut Warning', cmd: 'gamutWarning', key: 'Shift+Ctrl+Y', check: () => !!D()?.gamutWarning }, '-',
    { label: 'Extras', cmd: 'toggleExtras', key: 'Ctrl+H', check: () => app.showSelEdges }, { label: 'Rulers', cmd: 'toggleRulers', key: 'Ctrl+R', check: () => app.showRulers },
    { label: 'Show', sub: [{ label: 'Grid', cmd: 'toggleGrid', key: "Ctrl+'", check: () => app.showGrid }, { label: 'Guides', cmd: 'toggleGuides', key: 'Ctrl+;', check: () => app.showGuides }] },
    { label: 'New Guide…', cmd: 'newGuide' }, { label: 'Clear Guides', cmd: 'clearGuides' }]],
  ['Window', () => [
    ...[['actions', 'Actions', 'Alt+F9'], ['adjustments', 'Adjustments'], ['brush', 'Brush Settings', 'F5'], ['channels', 'Channels'], ['color', 'Color'], ['histogram', 'Histogram'], ['history', 'History'], ['info', 'Info', 'F8'], ['layers', 'Layers', 'F7'], ['navigator', 'Navigator'], ['paths', 'Paths'], ['properties', 'Properties'], ['swatches', 'Swatches']].map(([id, n, k]) => ({ label: n, key: k, cmd: 'showPanel', args: [id] })), { label: 'Timeline', cmd: 'toggleTimeline' },
    '-', { label: 'Hide Panels', cmd: 'togglePanels', key: 'Tab', check: () => app.panelsHidden },
    '-', ...app.docs.map(d => ({ label: d.name, check: () => d === app.doc, run: () => setActiveDoc(d) }))]],
  ['Help', () => [{ label: 'About Strata', cmd: 'about' }, { label: 'Check for Updates…', run: async () => { const st = await window.host.updates.status(); if (st.state === 'unavailable') { preferencesDialog(); return; } toast('Checking for updates…', '', 1500); const r = await window.host.updates.check(); const { updateStatusText } = await import('./ui/dialogs.js'); toast(updateStatusText({ ...r, current: st.current }), r.state === 'error' ? 'err' : 'ok', 5000); } }, '-', { label: 'Open Log File', run: () => window.host.openLog() }, { label: 'Restart in Safe Mode (no GPU)', run: async () => { await window.host.setSafeMode(true); window.host.relaunch(); } }, { label: 'Restart with GPU (leave Safe Mode)', run: async () => { await window.host.setSafeMode(false); window.host.relaunch(); } }, { label: 'Keyboard Shortcuts…', cmd: 'shortcuts' }, '-', { label: 'Toggle Developer Tools', cmd: 'devtools', key: 'F12' }]],
];

// ---------- shortcuts ----------
export const SHORTCUTS = {
  'ctrl+n': 'newDoc', 'ctrl+o': 'open', 'ctrl+w': 'close', 'ctrl+alt+w': 'closeAll', 'ctrl+s': 'save', 'ctrl+shift+s': 'saveAs', 'ctrl+alt+shift+w': 'exportAs', 'ctrl+q': 'exit', 'f12': 'revert',
  'ctrl+z': 'undo', 'ctrl+shift+z': 'redo', 'ctrl+y': 'proofColors', 'ctrl+shift+y': 'gamutWarning', 'alt+f9': ['showPanel', 'actions'], 'ctrl+shift+a': 'cameraRaw', 'ctrl+alt+z': 'undo',
  'ctrl+x': 'cut', 'ctrl+c': 'copy', 'ctrl+shift+c': 'copyMerged', 'ctrl+v': 'paste', 'ctrl+shift+v': 'pasteInPlace', 'delete': 'clear', 'backspace': 'clear',
  'shift+f5': 'fill', 'shift+backspace': 'fill', 'alt+backspace': 'fillFg', 'ctrl+backspace': 'fillBg', 'alt+delete': 'fillFg', 'ctrl+delete': 'fillBg',
  'ctrl+t': 'freeTransform', 'ctrl+k': 'preferences', 'ctrl+alt+shift+k': 'shortcuts', 'ctrl+f': 'searchCommands',
  'ctrl+l': ['adjustment', 'levels'], 'ctrl+m': ['adjustment', 'curves'], 'ctrl+u': ['adjustment', 'hueSaturation'], 'ctrl+b': ['adjustment', 'colorBalance'], 'ctrl+alt+shift+b': ['adjustment', 'blackWhite'], 'ctrl+i': ['adjustment', 'invert'], 'ctrl+shift+u': 'desaturate',
  'ctrl+shift+l': 'autoTone', 'ctrl+alt+shift+l': 'autoContrast', 'ctrl+shift+b': 'autoColor', 'ctrl+alt+i': 'imageSize', 'ctrl+alt+c': 'canvasSize',
  'ctrl+shift+n': 'newLayer', 'ctrl+alt+shift+n': 'newLayer', 'ctrl+j': 'layerViaCopy', 'ctrl+shift+j': 'layerViaCut', 'ctrl+g': 'groupLayers', 'ctrl+shift+g': 'ungroup', 'ctrl+alt+g': 'toggleClip',
  'ctrl+e': 'mergeDown', 'ctrl+shift+e': 'mergeVisible', 'ctrl+alt+shift+e': 'stampVisible', 'ctrl+]': ['arrange', 'forward'], 'ctrl+[': ['arrange', 'backward'], 'ctrl+shift+]': ['arrange', 'front'], 'ctrl+shift+[': ['arrange', 'back'],
  'alt+[': ['selectLayerRel', -1], 'alt+]': ['selectLayerRel', 1],
  'ctrl+a': 'selectAll', 'ctrl+d': 'deselect', 'ctrl+shift+d': 'reselect', 'ctrl+shift+i': 'inverse', 'ctrl+alt+a': 'selectAllLayers', 'shift+f6': ['modifySel', 'feather'], 'ctrl+alt+r': 'selectAndMask',
  'ctrl+alt+f': 'lastFilter', 'ctrl+shift+x': 'liquify',
  'ctrl+=': 'zoomIn', 'ctrl++': 'zoomIn', 'ctrl+-': 'zoomOut', 'ctrl+0': 'fitOnScreen', 'ctrl+1': 'zoom100', 'ctrl+alt+0': 'zoom100',
  'ctrl+r': 'toggleRulers', "ctrl+'": 'toggleGrid', 'ctrl+;': 'toggleGuides', 'ctrl+h': 'toggleExtras',
  'ctrl+2': ['channelView', 'rgb'], 'ctrl+3': ['channelView', 'r'], 'ctrl+4': ['channelView', 'g'], 'ctrl+5': ['channelView', 'b'],
  'tab': 'togglePanels', 'f7': ['showPanel', 'layers'], 'f8': ['showPanel', 'info'], 'f5': ['showPanel', 'brush'], 'x': 'swapColors', 'd': 'defaultColors', 'q': 'quickMask', 'f': 'togglePanels', 'f1': 'shortcuts',
};
const SHORTCUT_HELP = [
  ['V', 'Move'], ['M', 'Marquee'], ['L', 'Lasso'], ['W', 'Object / Quick Selection / Magic Wand'], ['C', 'Crop'], ['I', 'Eyedropper'], ['J', 'Healing / Remove'], ['B', 'Brush / Pencil'], ['S', 'Clone Stamp'], ['Y', 'History Brush'], ['E', 'Eraser'], ['G', 'Gradient / Paint Bucket'], ['O', 'Dodge / Burn / Sponge'], ['T', 'Type'], ['U', 'Shapes'], ['H', 'Hand'], ['Z', 'Zoom'], ['Shift + tool key', 'Cycle tools in a group'],
  ['Space (hold)', 'Hand tool'], ['[ / ]', 'Brush size'], ['Shift+[ / ]', 'Brush hardness'], ['0–9', 'Tool opacity'], ['Alt (painting)', 'Eyedropper'], ['Alt+click (clone/heal)', 'Set source'], ['X / D', 'Swap / default colors'], ['Q', 'Quick Mask'], ['Tab', 'Hide panels'],
  ...Object.entries(SHORTCUTS).filter(([k, v]) => k.includes('ctrl')).map(([k, v]) => [k.replace(/\b\w/g, c => c.toUpperCase()), Array.isArray(v) ? `${v[0]} ${v[1]}` : v]),
];

// command search
export function allCommandEntries() {
  const out = [];
  const walk = (items, path) => { for (const it of (typeof items === 'function' ? items() : items)) { if (!it || it === '-' || it.header) continue; if (it.sub) walk(it.sub, [...path, it.label]); else out.push({ label: it.label, path: path.join(' › '), it }); } };
  for (const [name, fn] of MENUS) walk(fn, [name]);
  return out;
}
