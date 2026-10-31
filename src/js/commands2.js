// Paths, Smart Objects, Artboards, Image Modes, Actions and Timeline commands.
import { app, cmd, defineCommands, setActiveDoc } from './state.js';
import { el, createCanvas, ctx2d, cloneCanvas, alphaBounds, clamp, uid, canvasToBytes, hexToRgb } from './util.js';
import { toast, modal, confirmBox, promptBox, withBusy, sliderRow, selectEl, checkEl, alertBox, numField } from './ui/common.js';
import { Layer, Document, refreshVector } from './doc/document.js';
import { buildPath2D, clonePaths, selectionToSubpaths, newPathRecord, pathBounds, flatten, transformPaths } from './doc/paths.js';
import { featherCanvas, combineSel } from './doc/selection.js';
import { Surface, resolveTarget } from './tools/base.js';
import { bufferedStroke, StrokePath } from './tools/paint.js';
import { activePathRecord, pathTarget } from './tools/pen.js';
import { addDoc, cloneLayer, boundsOf, mergeInto, record, runFilter, runAdjustment, smartFromCanvas, smartFilterEdit, openPaths, imgOf, canvasOfImg } from './commands.js';
import { openBytes, exportBytes, basename } from './doc/io.js';
import { requestDraw, fitOnScreen } from './view/viewport.js';
import { setTool } from './ui/toolbar.js';
import { startTransform } from './tools/transform.js';
import { desaturate } from './engine/adjust.js';

const D = () => app.doc;
const hasDoc = () => !!app.doc;
const hasLayer = () => !!app.doc?.active;
const hasPath = () => !!(app.doc && activePathRecord(app.doc));
const pathOrShape = () => { const d = D(); if (!d) return null; const r = activePathRecord(d); if (r && r.subpaths.length) return r.subpaths; const L = d.active; if (L?.kind === 'shape') { const t = pathTarget(d); return t ? t.get() : null; } if (L?.vmask) return L.vmask.subpaths; return null; };

// ================= Paths =================
async function fillPath() {
  const d = D(), sp = pathOrShape(); if (!sp) { toast('There is no path to fill.', 'err'); return; }
  const t = await resolveTarget(d, { toolName: 'fill path', allowSelection: false }); if (!t) return;
  const s = new Surface(d, t), g = ctx2d(s.canvas);
  g.save(); g.translate(-s.ox, -s.oy); g.fillStyle = s.isMaskLike ? '#fff' : app.fg; g.fill(buildPath2D(sp), 'nonzero'); g.restore();
  s.commit('Fill Path', 'bucket'); record('fillPath');
}
async function strokePath(toolId = 'brush') {
  const d = D(), sp = pathOrShape(); if (!sp) { toast('There is no path to stroke.', 'err'); return; }
  const tool = app.tools[toolId] || app.tools.brush;
  const stroke = bufferedStroke(tool, null, { colorFn: () => app.fg, erase: toolId === 'eraser', aliased: toolId === 'pencil', name: 'Stroke Path' });
  if (!stroke) return;
  const o = app.opts[tool.id];
  const path = new StrokePath({ ...o, smoothing: 0 }, (p, a) => stroke.dab(p, a));
  for (const f of flatten(sp, 24)) {
    const pts = f.closed ? [...f.poly, f.poly[0]] : f.poly;
    path.begin({ ...pts[0], pressure: 1 }); for (const p of pts.slice(1)) path.to({ ...p, pressure: 1 });
  }
  await stroke.end(); record('strokePath', toolId);
}
function pathToSelection(feather = 0, mode = 'new') {
  const d = D(), sp = pathOrShape(); if (!sp) return;
  const c = createCanvas(d.width, d.height), g = ctx2d(c); g.fillStyle = '#fff'; g.fill(buildPath2D(sp), 'nonzero');
  d.setSelection(combineSel(d, feather > 0 ? featherCanvas(c, feather) : c, mode)); d.commit('Make Selection', 'marqueeRect'); record('pathToSelection', feather, mode);
}
async function selectionToPath(tol) {
  const d = D(); if (!d.selection) return;
  if (tol == null) { let v = 2; const r = await modal({ title: 'Make Work Path', body: sliderRow({ label: 'Tolerance:', value: 2, min: 0.5, max: 10, step: 0.5, unit: 'pixels', onInput: (x) => v = x }) }); if (!r) return; tol = v; }
  const sp = selectionToSubpaths(d.selection, tol);
  d.paths = (d.paths || []).filter(p => p.kind !== 'work');
  const rec = newPathRecord('Work Path', sp, 'work'); d.paths.push(rec); d.activePathId = rec.id;
  d.setSelection(null); d.commit('Make Work Path', 'pen'); d.emit('paths');
}
defineCommands({
  fillPath: { enabled: hasDoc, run: fillPath },
  strokePath: { enabled: hasDoc, run: (t) => strokePath(t) },
  strokePathDialog: { enabled: hasDoc, run: async () => { let t = 'brush'; const r = await modal({ title: 'Stroke Path', body: el('div', { class: 'row' }, el('label', {}, 'Tool:'), selectEl([['brush', 'Brush'], ['pencil', 'Pencil'], ['eraser', 'Eraser'], ['clone', 'Clone Stamp'], ['historyBrush', 'History Brush'], ['blurTool', 'Blur'], ['smudge', 'Smudge'], ['dodge', 'Dodge'], ['burn', 'Burn']], t, (v) => t = v)) }); if (r) strokePath(t); } },
  pathToSelection: { enabled: hasDoc, run: (f, m) => pathToSelection(f, m) },
  pathToSelectionDialog: { enabled: hasDoc, run: async () => { let f = 0, m = 'new'; const r = await modal({ title: 'Make Selection', body: el('div', {}, sliderRow({ label: 'Feather Radius:', value: 0, min: 0, max: 250, step: 0.1, unit: 'px', onInput: (v) => f = v }), el('div', { class: 'row' }, el('label', {}, 'Operation:'), selectEl([['new', 'New Selection'], ['add', 'Add to Selection'], ['subtract', 'Subtract from Selection'], ['intersect', 'Intersect with Selection']], m, (v) => m = v))) }); if (r) pathToSelection(f, m); } },
  selectionToPath: { enabled: () => !!D()?.selection, run: (t) => selectionToPath(t) },
  newPath: { enabled: hasDoc, run: () => { const d = D(); d.paths = d.paths || []; const rec = newPathRecord('Path ' + (d.paths.filter(p => p.kind !== 'work').length + 1)); d.paths.push(rec); d.activePathId = rec.id; d.commit('New Path', 'pen'); d.emit('paths'); setTool('pen'); app.opts.pen.mode = 'path'; app.emit('tool', 'pen'); } },
  savePath: { enabled: () => activePathRecord(D() || {})?.kind === 'work', run: async () => { const d = D(), r = activePathRecord(d); const n = await promptBox('Name:', 'Path ' + (d.paths.filter(p => p.kind !== 'work').length + 1), 'Save Path'); if (n == null) return; r.kind = 'saved'; r.name = n || r.name; d.commit('Save Path', 'pen'); d.emit('paths'); } },
  renamePath: { run: async (id) => { const d = D(), r = d.paths.find(p => p.id === id); if (!r) return; const n = await promptBox('Name:', r.name, 'Rename Path'); if (!n) return; r.name = n; if (r.kind === 'work') r.kind = 'saved'; d.commit('Rename Path', 'pen'); d.emit('paths'); } },
  duplicatePath: { enabled: hasPath, run: () => { const d = D(), r = activePathRecord(d); const n = newPathRecord(r.name + ' copy', clonePaths(r.subpaths)); d.paths.push(n); d.activePathId = n.id; d.commit('Duplicate Path', 'pen'); d.emit('paths'); } },
  deletePath: { enabled: hasPath, run: () => { const d = D(); d.paths = d.paths.filter(p => p.id !== d.activePathId); d.activePathId = null; d.commit('Delete Path', 'trash'); d.emit('paths'); } },
  selectPath: { run: (id) => { const d = D(); d.activePathId = id; d.emit('paths'); requestDraw(); } },
  addVectorMask: { enabled: hasLayer, run: (mode) => {
    const d = D(), L = d.active; if (L.locks.background) { toast('Convert the Background to a layer first.', 'err'); return; }
    if (L.vmask) { toast('This layer already has a vector mask.', 'err'); return; }
    const r = activePathRecord(d);
    const sp = mode !== 'reveal' && r && r.subpaths.length ? clonePaths(r.subpaths) : [{ closed: true, pts: [{ x: 0, y: 0 }, { x: d.width, y: 0 }, { x: d.width, y: d.height }, { x: 0, y: d.height }].map(p => ({ ...p, in: null, out: null, smooth: false })) }];
    if (mode === 'hide') sp.length = 0;
    L.vmask = { subpaths: sp, enabled: true }; L.touch(); d.commit('Add Vector Mask', 'mask');
  } },
  deleteVectorMask: { enabled: () => !!D()?.active?.vmask, run: () => { const d = D(); d.active.vmask = null; app.vmaskEdit = false; d.active.touch(); d.commit('Delete Vector Mask', 'trash'); } },
  toggleVectorMask: { enabled: () => !!D()?.active?.vmask, run: () => { const d = D(), v = d.active.vmask; v.enabled = v.enabled === false; d.active.touch(); d.commit(v.enabled ? 'Enable Vector Mask' : 'Disable Vector Mask', 'mask'); } },
  rasterizeVectorMask: { enabled: () => !!D()?.active?.vmask, run: () => {
    const d = D(), L = d.active; const c = createCanvas(d.width, d.height), g = ctx2d(c); g.fillStyle = '#fff'; g.fill(buildPath2D(L.vmask.subpaths));
    if (L.mask) { const m = d.maskAlpha(L, d.width, d.height); const mg = ctx2d(m); mg.globalCompositeOperation = 'destination-in'; mg.drawImage(c, 0, 0); L.mask = { ...L.mask, canvas: cloneCanvas(m), x: 0, y: 0, def: 0 }; }
    else L.mask = { canvas: c, x: 0, y: 0, def: 0, enabled: true, linked: true };
    L.vmask = null; L.maskRev++; L.touch(); d.commit('Rasterize Vector Mask', 'mask');
  } },
  editVectorMask: { enabled: () => !!D()?.active?.vmask, run: () => { app.vmaskEdit = true; app.maskEdit = false; app.emit('maskedit'); setTool('directSelect'); } },
});

// ================= Smart Objects =================
defineCommands({
  convertToSmart: { enabled: hasLayer, run: () => {
    const d = D(); const sel = d.all().filter(l => d.selectedIds.has(l.id) && !l.locks.background);
    if (!sel.length) { toast('Convert the Background to a layer first.', 'err'); return; }
    let b = null; for (const l of sel) { const lb = boundsOf(d, l); if (lb) b = b ? { x: Math.min(b.x, lb.x), y: Math.min(b.y, lb.y), w: Math.max(b.x + b.w, lb.x + lb.w) - Math.min(b.x, lb.x), h: Math.max(b.y + b.h, lb.y + lb.h) - Math.min(b.y, lb.y) } : lb; }
    if (!b) b = { x: 0, y: 0, w: d.width, h: d.height };
    const top = sel[sel.length - 1];
    const nd = new Document(b.w, b.h, { name: top.name + '.psb', resolution: d.resolution });
    nd.layers = sel.map(l => { const c = cloneLayer(d, l); c.name = l.name; return c; });
    const shift = (L) => { if (L.children) L.children.forEach(shift); if (L.kind === 'pixel') { L.x -= b.x; L.y -= b.y; } if (L.tx) { L.tx[4] -= b.x; L.tx[5] -= b.y; } if (L.mask) { L.mask.x -= b.x; L.mask.y -= b.y; } if (L.vmask) transformPaths(L.vmask.subpaths, (q) => ({ x: q.x - b.x, y: q.y - b.y })); L.touch(true); };
    nd.layers.forEach(shift);
    for (const l of nd.all()) if (l.kind === 'fill') refreshVector(l, nd);
    nd.activeId = nd.layers[nd.layers.length - 1].id; nd.commit('Open'); nd.dirty = false;
    const cache = cloneCanvas(nd.render(true));
    const S = new Layer('smart', { name: top.name, smart: { doc: nd, cache, ver: 1, name: top.name }, tx: [1, 0, 0, 1, b.x, b.y] });
    const p = d.parentList(top.id); p.list.splice(p.index + 1, 0, S);
    for (const l of sel) d.removeLayer(l.id);
    d.setActive(S.id); d.commit('Convert to Smart Object', 'layers');
  } },
  editContents: { enabled: () => D()?.active?.kind === 'smart', run: () => {
    const d = D(), L = d.active, nd = L.smart.doc;
    const open = app.docs.find(x => x === nd);
    nd.parentLink = { doc: d, layerId: L.id };
    if (open) { setActiveDoc(nd); return; }
    nd.name = (L.smart.name || L.name) + '.psb';
    addDoc(nd);
    toast('Edit the contents, then press Ctrl+S to update the Smart Object.', '', 5000);
  } },
  newSmartViaCopy: { enabled: () => D()?.active?.kind === 'smart', run: () => {
    const d = D(), L = d.active; const nd = new Document(L.smart.doc.width, L.smart.doc.height, { name: L.name + ' copy.psb' });
    nd.layers = L.smart.doc.layers.map(l => { const c = cloneLayer(L.smart.doc, l); c.name = l.name; return c; }); nd.activeId = nd.layers[nd.layers.length - 1]?.id; nd.commit('Open'); nd.dirty = false;
    const n = new Layer('smart', { name: L.name + ' copy', smart: { doc: nd, cache: cloneCanvas(L.smart.cache), ver: 1, name: L.name + ' copy' }, tx: [...L.tx], smartFilters: L.smartFilters ? JSON.parse(JSON.stringify(L.smartFilters)) : null });
    const p = d.parentList(L.id); p.list.splice(p.index + 1, 0, n); d.setActive(n.id); d.commit('New Smart Object via Copy', 'layers');
  } },
  replaceContents: { enabled: () => D()?.active?.kind === 'smart', run: async () => {
    const d = D(), L = d.active; const ps = await window.host.openDialog({ title: 'Replace Contents', multi: false }); if (!ps.length) return;
    const bytes = await window.host.readFile(ps[0]); const nd = await openBytes(bytes, basename(ps[0]));
    const c = nd.render(true); const sx = L.smart.cache.width / c.width, sy = L.smart.cache.height / c.height;
    L.smart = { doc: nd, cache: cloneCanvas(c), ver: (L.smart.ver || 1) + 1, name: basename(ps[0]).replace(/\.[^.]+$/, '') };
    L.tx = [L.tx[0] * sx, L.tx[1] * sx, L.tx[2] * sy, L.tx[3] * sy, L.tx[4], L.tx[5]]; L.touch(true); d.commit('Replace Contents', 'layers');
  } },
  exportContents: { enabled: () => D()?.active?.kind === 'smart', run: async () => {
    const L = D().active; const p = await window.host.saveDialog({ title: 'Export Contents', defaultPath: (L.smart.name || L.name) + '.psd', filters: [{ name: 'Photoshop', extensions: ['psd'] }, { name: 'PNG', extensions: ['png'] }] }); if (!p) return;
    const { savePsdBytes } = await import('./doc/io.js');
    await window.host.writeFile(p, /\.png$/i.test(p) ? await exportBytes(L.smart.doc, 'png') : savePsdBytes(L.smart.doc)); toast('Exported ' + basename(p), 'ok');
  } },
  resetTransform: { enabled: () => D()?.active?.kind === 'smart', run: () => { const d = D(), L = d.active, b = L.bounds(); const cx = b ? b.x + b.w / 2 : 0, cy = b ? b.y + b.h / 2 : 0; L.tx = [1, 0, 0, 1, Math.round(cx - L.smart.cache.width / 2), Math.round(cy - L.smart.cache.height / 2)]; L.touch(); d.commit('Reset Transform', 'transform'); } },
  toggleSmartFilters: { enabled: () => !!D()?.active?.smartFilters, run: () => { const d = D(), L = d.active; L.smartFiltersVisible = L.smartFiltersVisible === false; L.touch(); d.commit('Smart Filters Visibility', 'eye'); } },
  toggleSmartFilter: { run: (id, k) => { const d = D(), L = d.find(id); const f = L?.smartFilters?.[k]; if (!f) return; f.enabled = f.enabled === false; L.touch(); d.commit(f.enabled ? 'Show Filter' : 'Hide Filter', 'eye'); } },
  editSmartFilter: { run: (id, k) => { const d = D(), L = d.find(id); if (L) smartFilterEdit(d, L, k); } },
  deleteSmartFilter: { run: (id, k) => { const d = D(), L = d.find(id); if (!L?.smartFilters) return; L.smartFilters.splice(k, 1); if (!L.smartFilters.length) L.smartFilters = null; L.touch(); d.commit('Delete Smart Filter', 'trash'); } },
  clearSmartFilters: { enabled: () => !!D()?.active?.smartFilters, run: () => { const d = D(); d.active.smartFilters = null; d.active.filterMask = null; d.active.touch(); d.commit('Clear Smart Filters', 'trash'); } },
  smartFilterBlending: { run: async (id, k) => {
    const d = D(), L = d.find(id), f = L?.smartFilters?.[k]; if (!f) return;
    const old = { blend: f.blend, opacity: f.opacity };
    const live = () => { L.touch(); d.invalidate(); };
    const { BLEND_MODES } = await import('./doc/blend.js');
    const body = el('div', {}, el('div', { class: 'row' }, el('label', {}, 'Mode:'), selectEl(BLEND_MODES.map(m => m || null), f.blend || 'normal', (v) => { f.blend = v; live(); })), sliderRow({ label: 'Opacity:', value: f.opacity ?? 100, min: 0, max: 100, unit: '%', onInput: (v) => { f.opacity = v; live(); } }));
    if (!(await modal({ title: 'Blending Options (Smart Filter)', body }))) { Object.assign(f, old); live(); return; }
    d.commit('Smart Filter Blending', 'liquify');
  } },
  rasterizeSmart: { enabled: () => D()?.active?.kind === 'smart', run: () => cmd('rasterize') },
});

// ================= Artboards =================
defineCommands({
  newArtboard: { enabled: hasDoc, run: async (rect) => {
    const d = D();
    if (!rect) {
      const used = d.layers.filter(l => l.artboard).map(l => l.artboard);
      const W = el('input', { type: 'number', value: d.width }), H = el('input', { type: 'number', value: d.height }), N = el('input', { type: 'text', value: 'Artboard ' + (used.length + 1) });
      for (const i of [W, H, N]) i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); };
      let bg = 'white';
      const r = await modal({ title: 'New Artboard', body: el('div', {}, el('div', { class: 'row' }, el('label', {}, 'Name:'), N), el('div', { class: 'row' }, el('label', {}, 'Width:'), W, el('span', { class: 'muted' }, 'px')), el('div', { class: 'row' }, el('label', {}, 'Height:'), H, el('span', { class: 'muted' }, 'px')), el('div', { class: 'row' }, el('label', {}, 'Background:'), selectEl([['white', 'White'], ['black', 'Black'], ['transparent', 'Transparent']], bg, (v) => bg = v))) });
      if (!r) return;
      const x = used.length ? Math.max(...used.map(a => a.x + a.w)) + 100 : 0;
      rect = { x, y: used.length ? Math.min(...used.map(a => a.y)) : 0, w: Math.max(1, Number(W.value)), h: Math.max(1, Number(H.value)), name: N.value, bg: { white: '#ffffff', black: '#000000', transparent: 'transparent' }[bg] };
    }
    const needW = Math.max(d.width, rect.x + rect.w), needH = Math.max(d.height, rect.y + rect.h);
    if (needW > d.width || needH > d.height) d.resizeCanvas(needW, needH, 0, 0);
    const G = new Layer('group', { name: rect.name || d.nextName('Artboard'), children: [], artboard: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h), bg: rect.bg ?? '#ffffff' } });
    G.blend = 'normal';
    d.layers.push(G); d.setActive(G.id); d.commit('New Artboard', 'artboard'); fitOnScreen(d);
  } },
  artboardFromLayers: { enabled: hasLayer, run: () => {
    const d = D(); const sel = d.all().filter(l => d.selectedIds.has(l.id) && !l.locks.background && !l.artboard);
    let b = null; for (const l of sel) { const lb = boundsOf(d, l); if (lb) b = b ? { x: Math.min(b.x, lb.x), y: Math.min(b.y, lb.y), w: Math.max(b.x + b.w, lb.x + lb.w) - Math.min(b.x, lb.x), h: Math.max(b.y + b.h, lb.y + lb.h) - Math.min(b.y, lb.y) } : lb; }
    if (!b) return;
    const G = new Layer('group', { name: d.nextName('Artboard'), children: [], artboard: { ...b, bg: 'transparent' } }); G.blend = 'normal';
    const top = sel[sel.length - 1], p = d.parentList(top.id);
    p.list.splice(p.index + 1, 0, G);
    for (const l of sel) { const pp = d.parentList(l.id); pp.list.splice(pp.index, 1); G.children.push(l); }
    d.setActive(G.id); d.commit('Artboard from Layers', 'artboard');
  } },
  exportArtboards: { enabled: () => !!D()?.all().some(l => l.artboard), run: async () => {
    const d = D(); const dir = await window.host.openDirDialog({ title: 'Export Artboards to Folder' }); if (!dir) return;
    let fmt = 'png';
    const boards = d.all().filter(l => l.artboard);
    await withBusy('Exporting artboards…', async (prog) => {
      let k = 0;
      for (const A of boards) {
        const full = d.renderLayerAlone(A, true), a = A.artboard;
        const c = createCanvas(a.w, a.h); ctx2d(c).drawImage(full, -a.x, -a.y);
        const p = await window.host.joinPath(dir, A.name.replace(/[\\/:*?"<>|]/g, '_') + '.' + fmt);
        await window.host.writeFile(p, await canvasToBytes(c, 'image/png'));
        prog(++k / boards.length);
      }
    });
    toast(`Exported ${boards.length} artboard${boards.length === 1 ? '' : 's'}`, 'ok');
  } },
});

// ================= Image Modes / proofing =================
function cmykProof(r, g, b) {
  // naive RGB → CMYK (with GCR + 300% ink limit) → RGB rendering intent approximation (SWOP-like gamut squeeze)
  let c = 1 - r / 255, m = 1 - g / 255, y = 1 - b / 255;
  const k = Math.min(c, m, y) * 0.85;
  c = (c - k) / (1 - k || 1); m = (m - k) / (1 - k || 1); y = (y - k) / (1 - k || 1);
  const tot = c + m + y + k; if (tot > 3) { const f = 3 / tot; c *= f; m *= f; y *= f; }
  // ink impurity: cyan absorbs some red/green, magenta some blue, yellow some green
  const R = (1 - c) * (1 - m * 0.08) * (1 - y * 0.02) * (1 - k), G = (1 - m) * (1 - c * 0.28) * (1 - y * 0.08) * (1 - k), B = (1 - y) * (1 - c * 0.12) * (1 - m * 0.42) * (1 - k);
  const paper = [0.95, 0.95, 0.93], blk = 0.08;
  return [255 * (blk + (paper[0] - blk) * R), 255 * (blk + (paper[1] - blk) * G), 255 * (blk + (paper[2] - blk) * B)];
}
export function postProcessComposite(doc, canvas) {
  const proof = (doc.mode === 'cmyk' || doc.proof) && !doc._noProof, gray = doc.mode === 'grayscale' || doc.mode === 'bitmap', gamut = doc.gamutWarning;
  if (!proof && !gray && !gamut) return canvas;
  const g = ctx2d(canvas), id = g.getImageData(0, 0, canvas.width, canvas.height), px = id.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    if (gray) { const l = 0.299 * r + 0.587 * gg + 0.114 * b; px[i] = px[i + 1] = px[i + 2] = l; continue; }
    const [R, G, B] = cmykProof(r, gg, b);
    if (gamut && (Math.abs(R - r) + Math.abs(G - gg) + Math.abs(B - b) > 70)) { px[i] = px[i + 1] = px[i + 2] = 128; continue; }
    if (proof) { px[i] = R; px[i + 1] = G; px[i + 2] = B; }
  }
  g.putImageData(id, 0, 0);
  return canvas;
}
function quantizeIndexed(canvas, colors, dither, palette) {
  const g = ctx2d(canvas), id = g.getImageData(0, 0, canvas.width, canvas.height), d = id.data, W = canvas.width;
  let pal;
  if (palette === 'web') { pal = []; for (let r = 0; r < 6; r++) for (let gg = 0; gg < 6; gg++) for (let b = 0; b < 6; b++) pal.push([r * 51, gg * 51, b * 51]); }
  else if (palette === 'uniform') { const n = Math.max(2, Math.round(Math.cbrt(colors))); pal = []; for (let r = 0; r < n; r++) for (let gg = 0; gg < n; gg++) for (let b = 0; b < n; b++) pal.push([r * 255 / (n - 1), gg * 255 / (n - 1), b * 255 / (n - 1)]); }
  else if (palette === 'gray') { pal = []; for (let k = 0; k < colors; k++) { const v = k * 255 / (colors - 1); pal.push([v, v, v]); } }
  else { // median cut
    const pts = []; const step = Math.max(1, Math.floor(d.length / 4 / 60000));
    for (let i = 0; i < d.length; i += 4 * step) pts.push([d[i], d[i + 1], d[i + 2]]);
    let boxes = [pts];
    while (boxes.length < colors) {
      boxes.sort((a, b) => b.length - a.length); const bx = boxes.shift(); if (bx.length < 2) { boxes.push(bx); break; }
      const rng = [0, 1, 2].map(c => { let lo = 255, hi = 0; for (const p of bx) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); } return hi - lo; });
      const c = rng.indexOf(Math.max(...rng)); bx.sort((a, b) => a[c] - b[c]); const mid = bx.length >> 1; boxes.push(bx.slice(0, mid), bx.slice(mid));
    }
    pal = boxes.filter(b => b.length).map(b => [0, 1, 2].map(c => b.reduce((s, p) => s + p[c], 0) / b.length));
  }
  const near = (r, gg, b) => { let best = 0, bd = 1e9; for (let k = 0; k < pal.length; k++) { const p = pal[k], dd = (p[0] - r) ** 2 + (p[1] - gg) ** 2 + (p[2] - b) ** 2; if (dd < bd) { bd = dd; best = k; } } return pal[best]; };
  const err = dither ? new Float32Array(d.length) : null;
  for (let i = 0; i < d.length; i += 4) {
    const r = clamp(d[i] + (err ? err[i] : 0), 0, 255), gg = clamp(d[i + 1] + (err ? err[i + 1] : 0), 0, 255), b = clamp(d[i + 2] + (err ? err[i + 2] : 0), 0, 255);
    const p = near(r, gg, b); d[i] = p[0]; d[i + 1] = p[1]; d[i + 2] = p[2];
    if (err) { const x = (i / 4) % W, e = [r - p[0], gg - p[1], b - p[2]]; const push = (o, f) => { if (o < 0 || o >= d.length) return; for (let c = 0; c < 3; c++) err[o + c] += e[c] * f; }; if (x < W - 1) push(i + 4, 7 / 16); if (x > 0) push(i + W * 4 - 4, 3 / 16); push(i + W * 4, 5 / 16); if (x < W - 1) push(i + W * 4 + 4, 1 / 16); }
  }
  g.putImageData(id, 0, 0);
  return pal.length;
}
async function setMode(mode) {
  const d = D(); if (d.mode === mode) return;
  const flattenIfNeeded = async (what) => { if (d.layers.length > 1 || d.layers[0]?.kind !== 'pixel') { if (!(await confirmBox(`Flatten image? ${what} requires a flattened image.`, 'Flatten'))) return false; await cmd('flatten'); } return true; };
  if (mode === 'grayscale') {
    if (!(await confirmBox('Discard color information?', 'Discard'))) return;
    for (const L of d.all()) if (L.kind === 'pixel' && L.canvas) { const id = ctx2d(L.canvas).getImageData(0, 0, L.canvas.width, L.canvas.height); desaturate(id.data); ctx2d(L.canvas).putImageData(id, 0, 0); L.touch(true); }
  } else if (mode === 'indexed') {
    if (!(await flattenIfNeeded('Indexed Color'))) return;
    let colors = 256, palette = 'local', dither = true;
    const r = await modal({ title: 'Indexed Color', body: el('div', {}, el('div', { class: 'row' }, el('label', {}, 'Palette:'), selectEl([['local', 'Local (Adaptive)'], ['web', 'Web'], ['uniform', 'Uniform'], ['gray', 'Grayscale']], palette, (v) => palette = v)), sliderRow({ label: 'Colors:', value: 256, min: 2, max: 256, onInput: (v) => colors = v }), checkEl('Dither (Diffusion)', true, (v) => dither = v)) });
    if (!r) return;
    const L = d.layers[0]; await withBusy('Converting…', async () => quantizeIndexed(L.canvas, colors, dither, palette)); L.touch(true);
  } else if (mode === 'bitmap') {
    if (d.mode !== 'grayscale') { toast('Convert the image to Grayscale first (Image › Mode › Grayscale), as in Photoshop.', 'err'); return; }
    if (!(await flattenIfNeeded('Bitmap'))) return;
    let method = 'diffusion', thr = 128;
    const r = await modal({ title: 'Bitmap', body: el('div', {}, el('div', { class: 'row' }, el('label', {}, 'Method:'), selectEl([['threshold', '50% Threshold'], ['diffusion', 'Diffusion Dither'], ['pattern', 'Pattern Dither']], method, (v) => method = v))) }); if (!r) return;
    const L = d.layers[0], g = ctx2d(L.canvas), id = g.getImageData(0, 0, L.canvas.width, L.canvas.height), px = id.data, W = L.canvas.width, err = new Float32Array(px.length / 4);
    const bayer = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    for (let i = 0; i < px.length; i += 4) {
      const k = i / 4, x = k % W, y = (k - x) / W; const v = px[i] + err[k];
      const t = method === 'pattern' ? (bayer[y % 4][x % 4] + 0.5) * 16 : thr;
      const o = v >= t ? 255 : 0; px[i] = px[i + 1] = px[i + 2] = o;
      if (method === 'diffusion') { const e = v - o; if (x < W - 1) err[k + 1] += e * 7 / 16; if (x > 0) err[k + W - 1] += e * 3 / 16; err[k + W] += e * 5 / 16; if (x < W - 1) err[k + W + 1] += e / 16; }
    }
    g.putImageData(id, 0, 0); L.touch(true);
  } else if (mode === 'cmyk') {
    if (!(await confirmBox('Strata edits in RGB. CMYK Color mode shows a soft-proof of how colors will reproduce in print (out-of-gamut colors are muted) and reports CMYK values in the color picker. Files are still saved as RGB. Continue?', 'Use CMYK Preview'))) return;
  }
  d.mode = mode; d.invalidate(); d.commit({ grayscale: 'Grayscale', indexed: 'Indexed Color', bitmap: 'Bitmap', cmyk: 'CMYK Color', rgb: 'RGB Color', lab: 'Lab Color' }[mode] || mode, 'adjust'); app.emit('doc-meta');
}
defineCommands({
  setMode: { enabled: hasDoc, run: (m) => setMode(m) },
  proofColors: { enabled: hasDoc, run: () => { const d = D(); d.proof = !d.proof; d.invalidate(); app.emit('doc-meta'); } },
  gamutWarning: { enabled: hasDoc, run: () => { const d = D(); d.gamutWarning = !d.gamutWarning; d.invalidate(); } },
  bitDepth: { run: (b) => { if (b !== 8) alertBox('Strata currently edits at 8 bits per channel. 16- and 32-bit PSDs and PNGs open fine but are converted to 8-bit (with dithering) when opened.', 'Bit Depth'); } },
});

// ================= Actions =================
const RECORDABLE = new Set(['newLayer', 'duplicateLayer', 'deleteLayer', 'mergeDown', 'mergeVisible', 'flatten', 'stampVisible', 'selectAll', 'deselect', 'inverse', 'reselect', 'autoTone', 'autoContrast', 'autoColor', 'desaturate', 'equalize', 'rotateCanvas', 'transformOp', 'layerViaCopy', 'layerViaCut', 'groupLayers', 'ungroup', 'toggleClip', 'addMask', 'applyMask', 'invertMask', 'convertToSmart', 'selectSubject', 'selectSky', 'removeBackground', 'newAdjustmentLayer', 'fillFg', 'fillBg', 'contentAwareFill', 'cropToSelection', 'trim', 'convertBackground', 'arrange', 'swapColors', 'defaultColors', 'setMode', 'fillPath', 'strokePath', 'pathToSelection', 'setColor', 'filterApply', 'adjustmentApply', 'imageSizeApply', 'canvasSizeApply', 'gaussianQuick', 'saveAndClose', 'exportPng', 'exportJpeg', 'setLayerOpacity', 'setLayerBlend', 'modifySelApply']);
const STEP_NAMES = { filterApply: (a) => (window.__FILTERS?.[a[0]]?.name || a[0]).replace('…', ''), adjustmentApply: (a) => a[0], imageSizeApply: () => 'Image Size', canvasSizeApply: () => 'Canvas Size', setColor: (a) => `Set ${a[0] === 'fg' ? 'Foreground' : 'Background'} Color`, exportPng: () => 'Export PNG', exportJpeg: () => 'Export JPEG', setLayerOpacity: (a) => `Set Layer Opacity ${a[0]}%`, setLayerBlend: (a) => `Set Layer Blending ${a[0]}`, modifySelApply: (a) => `${a[0][0].toUpperCase() + a[0].slice(1)} Selection ${a[1]}px` };
export function stepLabel(s) { const f = STEP_NAMES[s.cmd]; if (f) return f(s.args || []); const c = app.commands[s.cmd]; return (s.cmd.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase())) + (s.args && s.args.length ? ' (' + s.args.map(a => typeof a === 'object' ? '…' : a).join(', ') + ')' : ''); }

defineCommands({
  filterApply: { run: (key, p) => runFilter(key, p, { dialog: false }) },
  adjustmentApply: { run: (type, p) => runAdjustment(type, p) },
  imageSizeApply: { run: (o) => cmd('imageSizeDirect', o) },
  setColor: { run: (which, hex) => { app[which] = hex; app.emit('colors'); } },
  setLayerOpacity: { enabled: hasLayer, run: (v) => { const d = D(); d.active.opacity = v / 100; d.active.touch(); d.commit('Opacity Change', 'layers'); } },
  setLayerBlend: { enabled: hasLayer, run: (m) => { const d = D(); d.active.blend = m; d.active.touch(); d.commit('Blending Change', 'layers'); } },
  exportPng: { enabled: hasDoc, run: async (dir) => { const d = D(); const base = (d.name || 'Untitled').replace(/\.[^.]+$/, ''); const p = dir ? await window.host.joinPath(dir, base + '.png') : await window.host.saveDialog({ defaultPath: base + '.png', filters: [{ name: 'PNG', extensions: ['png'] }] }); if (p) await window.host.writeFile(p, await exportBytes(d, 'png')); } },
  exportJpeg: { enabled: hasDoc, run: async (dir, q = 0.9) => { const d = D(); const base = (d.name || 'Untitled').replace(/\.[^.]+$/, ''); const p = dir ? await window.host.joinPath(dir, base + '.jpg') : await window.host.saveDialog({ defaultPath: base + '.jpg', filters: [{ name: 'JPEG', extensions: ['jpg'] }] }); if (p) await window.host.writeFile(p, await exportBytes(d, 'jpeg', q)); } },
});

const DEFAULT_ACTIONS = [{ id: 'set-default', name: 'Default Actions', actions: [
  { id: 'a1', name: 'Sepia Toning (layer)', steps: [{ cmd: 'duplicateLayer', args: [] }, { cmd: 'desaturate', args: [] }, { cmd: 'adjustmentApply', args: ['photoFilter', { color: '#ac7a33', density: 60, preserveLuminosity: true }] }] },
  { id: 'a2', name: 'Black & White Punch', steps: [{ cmd: 'newAdjustmentLayer', args: ['blackWhite'] }, { cmd: 'newAdjustmentLayer', args: ['curves'] }, { cmd: 'adjustmentApply', args: ['brightnessContrast', { brightness: 0, contrast: 35, legacy: false }] }] },
  { id: 'a3', name: 'Soften (Gaussian 4px)', steps: [{ cmd: 'layerViaCopy', args: [] }, { cmd: 'filterApply', args: ['gaussianBlur', { radius: 4 }] }, { cmd: 'setLayerOpacity', args: [50] }] },
  { id: 'a4', name: 'Auto Fix', steps: [{ cmd: 'autoTone', args: [] }, { cmd: 'autoColor', args: [] }, { cmd: 'filterApply', args: ['unsharpMask', { amount: 60, radius: 1, threshold: 2 }] }] },
  { id: 'a5', name: 'Cut Out Subject', steps: [{ cmd: 'selectSubject', args: [] }, { cmd: 'layerViaCopy', args: [] }] },
  { id: 'a6', name: 'Web Ready 1920 JPEG', steps: [{ cmd: 'flatten', args: [] }, { cmd: 'imageSizeApply', args: [{ fit: 1920 }] }, { cmd: 'exportJpeg', args: [] }] },
] }];
function loadActions() { try { const s = JSON.parse(localStorage.getItem('strata.actions') || 'null'); app.actionSets = s && s.length ? s : JSON.parse(JSON.stringify(DEFAULT_ACTIONS)); } catch { app.actionSets = JSON.parse(JSON.stringify(DEFAULT_ACTIONS)); } }
export function saveActions() { try { localStorage.setItem('strata.actions', JSON.stringify(app.actionSets)); } catch {} app.emit('actions'); }
loadActions();
app.recordStep = (name, args) => {
  if (!app.recording || !RECORDABLE.has(name)) return;
  const a = findAction(app.recording); if (!a) return;
  a.steps.push({ cmd: name, args: JSON.parse(JSON.stringify(args || [])), on: true });
  saveActions();
};
export function findAction(id) { for (const s of app.actionSets) for (const a of s.actions) if (a.id === id) return a; return null; }
// wrap cmd() so simple commands get recorded automatically
const origRun = {};
for (const name of RECORDABLE) {
  const c = app.commands[name]; if (!c || origRun[name]) continue;
  origRun[name] = c.run;
  if (['filterApply', 'adjustmentApply'].includes(name)) continue; // recorded by their implementations
  c.run = (...args) => { const r = origRun[name](...args); if (!app._playing) app.recordStep(name, args); return r; };
}
export async function playAction(id, { stepIndex } = {}) {
  const a = findAction(id); if (!a) return;
  if (!D() && a.steps[0]?.cmd !== 'newDoc') { toast('Open a document first.', 'err'); return; }
  app._playing = true;
  try {
    const steps = stepIndex != null ? [a.steps[stepIndex]] : a.steps;
    for (const s of steps) {
      if (s.on === false) continue;
      const c = app.commands[s.cmd]; if (!c) { toast('Unknown step: ' + s.cmd, 'err'); continue; }
      if (c.enabled && !c.enabled()) continue;
      await c.run(...(s.args || []));
      await new Promise(r => setTimeout(r, 0));
    }
  } finally { app._playing = false; }
}
defineCommands({
  actionPlay: { run: (id, k) => playAction(id || app.selectedAction, { stepIndex: k }) },
  actionRecord: { run: async (id) => { if (!id) id = app.selectedAction; if (!id || !findAction(id)) { await cmd('actionNew'); id = app.selectedAction; } app.recording = id; app.emit('actions'); } },
  actionStop: { run: () => { app.recording = null; app.emit('actions'); } },
  actionNew: { run: async () => { const n = await promptBox('Name:', 'Action ' + (app.actionSets.reduce((s, x) => s + x.actions.length, 0) + 1), 'New Action'); if (n == null) return; const set = app.actionSets.find(s => s.id === app.selectedSet) || app.actionSets[0]; const a = { id: uid(), name: n || 'Action', steps: [] }; set.actions.push(a); app.selectedAction = a.id; saveActions(); app.recording = a.id; app.emit('actions'); } },
  actionNewSet: { run: async () => { const n = await promptBox('Name:', 'Set ' + (app.actionSets.length + 1), 'New Set'); if (!n) return; app.actionSets.push({ id: uid(), name: n, actions: [] }); saveActions(); } },
  actionDelete: { run: () => { const id = app.selectedAction; for (const s of app.actionSets) { const i = s.actions.findIndex(a => a.id === id); if (i >= 0) s.actions.splice(i, 1); } app.selectedAction = null; saveActions(); } },
  actionDuplicate: { run: () => { const a = findAction(app.selectedAction); if (!a) return; for (const s of app.actionSets) if (s.actions.includes(a)) { const c = JSON.parse(JSON.stringify(a)); c.id = uid(); c.name += ' copy'; s.actions.push(c); } saveActions(); } },
  actionsReset: { run: async () => { if (!(await confirmBox('Replace all actions with the default set?', 'Reset'))) return; app.actionSets = JSON.parse(JSON.stringify(DEFAULT_ACTIONS)); saveActions(); } },
  actionsExport: { run: async () => { const p = await window.host.saveDialog({ defaultPath: 'Strata Actions.json', filters: [{ name: 'Actions', extensions: ['json'] }] }); if (p) await window.host.writeFile(p, new TextEncoder().encode(JSON.stringify(app.actionSets, null, 2))); } },
  actionsImport: { run: async () => { const ps = await window.host.openDialog({ multi: false, filters: [{ name: 'Actions', extensions: ['json'] }] }); if (!ps.length) return; try { const sets = JSON.parse(new TextDecoder().decode(await window.host.readFile(ps[0]))); for (const s of sets) { s.id = uid(); app.actionSets.push(s); } saveActions(); } catch (e) { toast('Not a valid actions file.', 'err'); } } },
  batch: { run: async () => {
    const all = app.actionSets.flatMap(s => s.actions.map(a => [a.id, s.name + ' › ' + a.name]));
    let act = app.selectedAction || all[0]?.[0], src = null, dst = null, fmt = 'jpeg';
    const srcBtn = el('button', { class: 'btn' }, 'Choose…'), dstBtn = el('button', { class: 'btn' }, 'Choose…'), srcL = el('span', { class: 'muted' }, 'No folder'), dstL = el('span', { class: 'muted' }, 'No folder');
    srcBtn.onclick = async () => { const d = await window.host.openDirDialog({ title: 'Source Folder' }); if (d) { src = d; srcL.textContent = d; } };
    dstBtn.onclick = async () => { const d = await window.host.openDirDialog({ title: 'Destination Folder' }); if (d) { dst = d; dstL.textContent = d; } };
    const r = await modal({ title: 'Batch', body: el('div', { style: { width: '520px' } }, el('div', { class: 'row' }, el('label', {}, 'Action:'), selectEl(all, act, (v) => act = v)), el('div', { class: 'row' }, el('label', {}, 'Source:'), srcBtn, srcL), el('div', { class: 'row' }, el('label', {}, 'Destination:'), dstBtn, dstL), el('div', { class: 'row' }, el('label', {}, 'Save as:'), selectEl([['jpeg', 'JPEG'], ['png', 'PNG'], ['psd', 'Photoshop']], fmt, (v) => fmt = v))) });
    if (!r || !src || !dst || !act) return;
    const files = await window.host.listDir(src, ['jpg', 'jpeg', 'png', 'webp', 'psd', 'bmp', 'gif']);
    let ok = 0;
    await withBusy('Batch…', async (prog) => {
      for (const f of files) {
        try {
          const doc = await openBytes(await window.host.readFile(f), basename(f), f); addDoc(doc);
          await playAction(act);
          const base = basename(f).replace(/\.[^.]+$/, '');
          const out = await window.host.joinPath(dst, base + '.' + (fmt === 'jpeg' ? 'jpg' : fmt));
          const { savePsdBytes } = await import('./doc/io.js');
          await window.host.writeFile(out, fmt === 'psd' ? savePsdBytes(app.doc) : await exportBytes(app.doc, fmt, 0.92));
          app.doc.dirty = false; await cmd('close'); ok++;
        } catch (e) { console.error(e); }
        prog(ok / files.length, `Batch ${ok}/${files.length}`);
      }
    });
    toast(`Batch processed ${ok} of ${files.length} files`, 'ok', 5000);
  } },
});

// ================= Timeline (frame animation) =================
function captureFrame(d) {
  const f = { delay: 0.1, layers: {} };
  for (const L of d.all()) f.layers[L.id] = { v: L.visible, o: L.opacity, x: L.x, y: L.y, tx: L.tx ? [...L.tx] : null };
  return f;
}
export function applyFrame(d, f) {
  for (const L of d.all()) {
    const s = f.layers[L.id]; if (!s) { continue; }
    L.visible = s.v; L.opacity = s.o;
    if (L.kind === 'pixel' && (L.x !== s.x || L.y !== s.y)) { L.x = s.x; L.y = s.y; }
    if (s.tx && L.tx && L.kind !== 'pixel') L.tx = [...s.tx];
    L.touch();
  }
  d.invalidate();
}
export function syncFrame(d) { if (!d.frames || d.frameIndex == null || d._applyingFrame) return; const f = d.frames[d.frameIndex]; if (!f) return; const nf = captureFrame(d); nf.delay = f.delay; d.frames[d.frameIndex] = nf; }
export function selectFrame(d, k) { d.frameIndex = clamp(k, 0, d.frames.length - 1); d._applyingFrame = true; applyFrame(d, d.frames[d.frameIndex]); d._applyingFrame = false; app.emit('timeline'); }
function renderFrame(d, f) { d._applyingFrame = true; const saved = captureFrame(d); applyFrame(d, f); const c = cloneCanvas(d.render(true)); applyFrame(d, saved); d._applyingFrame = false; d.invalidate(); return c; }
defineCommands({
  timelineCreate: { enabled: hasDoc, run: () => { const d = D(); if (!d.frames) { d.frames = [captureFrame(d)]; d.frameIndex = 0; d.loop = 0; d.commit('Create Frame Animation', 'history'); } app.emit('show-timeline'); app.emit('timeline'); } },
  frameNew: { enabled: () => !!D()?.frames, run: () => { const d = D(); syncFrame(d); const f = captureFrame(d); f.delay = d.frames[d.frameIndex].delay; d.frames.splice(d.frameIndex + 1, 0, f); d.frameIndex++; d.commit('Duplicate Frame', 'history'); app.emit('timeline'); } },
  frameDelete: { enabled: () => D()?.frames?.length > 1, run: () => { const d = D(); d.frames.splice(d.frameIndex, 1); selectFrame(d, Math.min(d.frameIndex, d.frames.length - 1)); d.commit('Delete Frame', 'trash'); } },
  frameDelay: { run: (k, v) => { const d = D(); d.frames[k].delay = v; app.emit('timeline'); } },
  framesFromLayers: { enabled: hasDoc, run: () => {
    const d = D(); const ls = d.layers.filter(l => !l.locks.background && !l.children);
    const bg = d.layers.find(l => l.locks.background);
    d.frames = ls.map(L => { const f = captureFrame(d); for (const id in f.layers) f.layers[id].v = (id === L.id) || (bg && id === bg.id); return f; });
    if (!d.frames.length) d.frames = [captureFrame(d)];
    selectFrame(d, 0); d.commit('Make Frames From Layers', 'history');
  } },
  frameTween: { enabled: () => D()?.frames?.length > 1, run: async () => {
    const d = D(); let n = 5;
    const r = await modal({ title: 'Tween', body: el('div', {}, el('div', { class: 'muted' }, 'Tween from the selected frame to the next frame.'), sliderRow({ label: 'Frames to Add:', value: 5, min: 1, max: 60, onInput: (v) => n = v })) }); if (!r) return;
    const a = d.frames[d.frameIndex], b = d.frames[(d.frameIndex + 1) % d.frames.length]; const out = [];
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1), f = { delay: a.delay, layers: {} };
      for (const id in a.layers) { const A = a.layers[id], B = b.layers[id] || A; const vis = A.v || B.v; f.layers[id] = { v: vis, o: (A.v ? A.o : 0) * (1 - t) + (B.v ? B.o : 0) * t, x: Math.round(A.x + (B.x - A.x) * t), y: Math.round(A.y + (B.y - A.y) * t), tx: A.tx && B.tx ? A.tx.map((v, i) => v + (B.tx[i] - v) * t) : A.tx }; }
      out.push(f);
    }
    d.frames.splice(d.frameIndex + 1, 0, ...out); d.commit('Tween', 'history'); app.emit('timeline');
  } },
  framePlay: { enabled: () => !!D()?.frames, run: () => {
    const d = D(); if (app._playTimer) { clearTimeout(app._playTimer); app._playTimer = null; app.emit('timeline'); return; }
    let loops = 0;
    const step = () => { let k = d.frameIndex + 1; if (k >= d.frames.length) { k = 0; loops++; if (d.loop && loops >= d.loop) { app._playTimer = null; app.emit('timeline'); return; } } selectFrame(d, k); app._playTimer = setTimeout(step, Math.max(20, d.frames[k].delay * 1000)); };
    app._playTimer = setTimeout(step, d.frames[d.frameIndex].delay * 1000); app.emit('timeline');
  } },
  exportGif: { enabled: () => !!D(), run: async () => {
    const d = D(); if (!d.frames) cmd('timelineCreate');
    const p = await window.host.saveDialog({ title: 'Export Animated GIF', defaultPath: d.name.replace(/\.[^.]+$/, '') + '.gif', filters: [{ name: 'GIF', extensions: ['gif'] }] }); if (!p) return;
    await withBusy('Encoding GIF…', async (prog) => {
      const { GIFEncoder, quantize, applyPalette } = await import('../vendor/gifenc.js');
      syncFrame(d); const enc = GIFEncoder();
      for (let k = 0; k < d.frames.length; k++) {
        const c = renderFrame(d, d.frames[k]); const id = ctx2d(c).getImageData(0, 0, c.width, c.height);
        const pal = quantize(id.data, 256, { format: 'rgba4444', oneBitAlpha: true }); const idx = applyPalette(id.data, pal, 'rgba4444');
        const ti = pal.findIndex(c => c[3] === 0);
        enc.writeFrame(idx, c.width, c.height, { palette: pal, delay: Math.round(d.frames[k].delay * 1000), repeat: d.loop ? d.loop : 0, transparent: ti >= 0, transparentIndex: Math.max(0, ti) });
        prog((k + 1) / d.frames.length); await new Promise(r => setTimeout(r, 0));
      }
      enc.finish(); await window.host.writeFile(p, enc.bytes());
    });
    toast('Exported ' + basename(p), 'ok');
  } },
  exportVideo: { enabled: () => !!D()?.frames, run: async () => {
    const d = D(); const p = await window.host.saveDialog({ title: 'Render Video', defaultPath: d.name.replace(/\.[^.]+$/, '') + '.webm', filters: [{ name: 'WebM Video', extensions: ['webm'] }] }); if (!p) return;
    await withBusy('Rendering video…', async (prog) => {
      syncFrame(d);
      const c = createCanvas(d.width - (d.width % 2), d.height - (d.height % 2)), g = ctx2d(c);
      const stream = c.captureStream(30); const rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm', videoBitsPerSecond: 12e6 });
      const chunks = []; rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise(r => rec.onstop = r);
      rec.start();
      const loops = d.loop || 1;
      for (let L = 0; L < loops; L++) for (let k = 0; k < d.frames.length; k++) { const fc = renderFrame(d, d.frames[k]); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(fc, 0, 0); await new Promise(r => setTimeout(r, Math.max(34, d.frames[k].delay * 1000))); prog((L * d.frames.length + k + 1) / (loops * d.frames.length)); }
      rec.stop(); await done;
      await window.host.writeFile(p, new Uint8Array(await new Blob(chunks).arrayBuffer()));
    });
    toast('Rendered ' + basename(p), 'ok');
  } },
  timelineDelete: { enabled: () => !!D()?.frames, run: () => { const d = D(); d.frames = null; d.frameIndex = null; d.commit('Delete Animation', 'trash'); app.emit('timeline'); } },
});
import { renderPost } from './doc/document.js';
renderPost.fn = postProcessComposite;
app.on('doc', (d) => { if (d && !d._frameHook) { d._frameHook = true; d.on('history', () => { if (!d._applyingFrame && d.frames) syncFrame(d); app.emit('timeline'); }); } app.emit('timeline'); });
