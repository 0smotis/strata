// Camera Raw Filter dialog (Filter › Camera Raw Filter…, Shift+Ctrl+A).
//   const r = await cameraRawDialog(srcCanvas, { settings? })  ->  null | { imageData: ImageData, settings }
// Preview runs in a module worker (engine/raw.worker.js) on a downscaled copy; zooming past the preview
// resolution renders the visible region at full resolution. OK renders the full image in the worker.
import { el, clamp, createCanvas, ctx2d } from '../util.js';
import { modal, toast, selectEl, checkEl, promptBox } from './common.js';
import { ICONS } from '../icons.js';
import { app } from '../state.js';
import {
  defaultRawSettings, normalizeRawSettings, mergeRawSettings, applyCameraRaw, autoRawSettings, autoWhiteBalance,
  rawHistogram, rawStages, toneFunction, curveSpline, neutralWhiteBalance,
  HSL_LABELS, HSL_HUES, WB_PRESETS, WB_LABELS, RAW_PRESETS,
} from '../engine/raw.js';

const PRESET_KEY = 'strata.rawPresets';
const UI_KEY = 'strata.rawUI';
const PREVIEW_MP = 1.2e6, DRAFT_MP = 0.3e6;

// ---------------------------------------------------------------- small helpers
const getP = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setP(o, path, v) { const ks = path.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) a = a[ks[i]]; a[ks[ks.length - 1]] = v; }
const clone = (o) => JSON.parse(JSON.stringify(o));
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const hsl = (h, s, l) => `hsl(${Math.round(((h % 360) + 360) % 360)},${s}%,${l}%)`;
const signed = (v, d = 0) => { const s = Number(v).toFixed(d); return v > 0 ? '+' + s : (Number(s) === 0 ? (0).toFixed(d) : s); };
const svg = (p, vb = '0 0 24 24') => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const IC = {
  edit: svg('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  presets: svg('<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>'),
  zoom: ICONS.zoom || svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/>'),
  hand: ICONS.hand || svg('<path d="M8 13V6a1.5 1.5 0 0 1 3 0v6"/>'),
  eye: svg('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  eyeOff: svg('<path d="M2 12s3.5-6 10-6c2 0 3.7.6 5.1 1.4M22 12s-3.5 6-10 6c-2 0-3.7-.6-5.1-1.4"/><path d="M4 20L20 4"/>'),
  chev: svg('<path d="M9 6l6 6-6 6"/>'),
  dropper: svg('<path d="M14.5 4.5l5 5M16 3l5 5-2 2-5-5zM13 8l-8 8v3h3l8-8"/>'),
  single: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/>'),
  side: svg('<rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/>'),
  split: svg('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M12 5v14"/>'),
  topbot: svg('<rect x="4" y="3" width="16" height="8" rx="1"/><rect x="4" y="13" width="16" height="8" rx="1"/>'),
  swap: svg('<path d="M7 7h11l-3-3M17 17H6l3 3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  undo: svg('<path d="M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-3"/>'),
  more: svg('<circle cx="6" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18" cy="12" r="1.2"/>'),
  warn: svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>'),
};

// slider gradients (ACR-style tracks)
const G = {
  temp: 'linear-gradient(90deg,#4f7fd8,#c9c9c9 50%,#e2c53e)',
  tint: 'linear-gradient(90deg,#46b04a,#c9c9c9 50%,#c454c4)',
  tone: 'linear-gradient(90deg,#141414,#e6e6e6)',
  sat: 'linear-gradient(90deg,#7c7c7c,#d14b4b,#d1c34b,#4bd165,#4bb9d1,#5a4bd1,#c74bd1)',
  hue: 'linear-gradient(90deg,#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)',
};
const hueRange = (h) => `linear-gradient(90deg,${hsl(h - 32, 75, 52)},${hsl(h, 80, 52)},${hsl(h + 32, 75, 52)})`;

// ---------------------------------------------------------------- engine client (worker w/ main-thread fallback)
function makeClient() {
  let worker = null, seq = 1;
  const pending = new Map();
  let local = null;
  try {
    worker = new Worker(new URL('../engine/raw.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id); if (!p) return;
      if (data.progress != null && !('ok' in data)) { p.onProgress && p.onProgress(data.progress); return; }
      pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error || 'Camera Raw failed'));
    };
    worker.onerror = (e) => { console.warn('raw worker error', e.message || e); for (const p of pending.values()) p.reject(new Error('Camera Raw worker crashed')); pending.clear(); worker = null; };
  } catch (e) { worker = null; }
  // main-thread fallback with the same API
  const runLocal = (op, args, onProgress) => {
    if (op === 'init') { local = { full: args.full, preview: args.preview || args.full, draft: args.draft || args.preview || args.full }; return { width: local.full.width }; }
    if (op === 'preview') { const src = args.which === 'draft' ? local.draft : local.preview; const t = performance.now(); const o = applyCameraRaw(src, args.settings, { scale: src.width / local.full.width, cache: true, view: args.view }); return { ...o, hist: rawHistogram(o), ms: performance.now() - t, which: args.which }; }
    if (op === 'region') { const o = applyCameraRaw(local.full, args.settings, { region: args.rect, guide: local.preview, cache: true, view: args.view }); return { ...o, x: Math.floor(args.rect.x), y: Math.floor(args.rect.y) }; }
    if (op === 'full') return applyCameraRaw(local.full, args.settings, { onProgress });
    if (op === 'auto') return { tone: autoRawSettings(local.preview), wb: autoWhiteBalance(local.preview) };
    throw new Error('unknown op ' + op);
  };
  return {
    call(op, args, onProgress, transfer = []) {
      if (!worker) return new Promise((res, rej) => setTimeout(() => { try { res(runLocal(op, args, onProgress)); } catch (e) { rej(e); } }, 0));
      const id = seq++;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); worker.postMessage({ id, op, args }, transfer); });
    },
    // keep a local copy for fallback in case the worker dies mid-session
    keepLocal(args) { local = { full: args.full, preview: args.preview, draft: args.draft }; },
    close() { if (worker) worker.terminate(); worker = null; pending.clear(); },
    get isWorker() { return !!worker; },
  };
}

// ---------------------------------------------------------------- main
export async function cameraRawDialog(srcCanvas, opts = {}) {
  const FW = srcCanvas.width, FH = srcCanvas.height;
  if (!FW || !FH) return null;
  const DEF = defaultRawSettings();
  let S = normalizeRawSettings(opts.settings || {});
  const ui = Object.assign({ open: { basic: true, curve: false, detail: false, mixer: false, grading: false, optics: false, geometry: false, effects: false }, mixerTab: 'hue', gradeTab: '3way', curveMode: 'parametric' }, lsGet(UI_KEY, {}));
  const hidden = new Set(); // panel groups toggled off with the eye icon
  // ---------- images
  const mkScaled = (mp) => { const k = Math.min(1, Math.sqrt(mp / (FW * FH))); const c = createCanvas(Math.max(1, Math.round(FW * k)), Math.max(1, Math.round(FH * k))); const g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(srcCanvas, 0, 0, c.width, c.height); return c; };
  const prevC = mkScaled(PREVIEW_MP), draftC = mkScaled(DRAFT_MP);
  const prevScale = prevC.width / FW;
  const prevData = ctx2d(prevC).getImageData(0, 0, prevC.width, prevC.height);
  const afterC = createCanvas(prevC.width, prevC.height); ctx2d(afterC).drawImage(prevC, 0, 0);
  let afterData = ctx2d(afterC).getImageData(0, 0, afterC.width, afterC.height);
  let region = null; // {canvas, x, y, w, h, rev, data}
  const client = makeClient();
  {
    const full = ctx2d(srcCanvas).getImageData(0, 0, FW, FH);
    const pv = ctx2d(prevC).getImageData(0, 0, prevC.width, prevC.height), dr = ctx2d(draftC).getImageData(0, 0, draftC.width, draftC.height);
    const args = { full: { data: full.data, width: FW, height: FH }, preview: { data: pv.data, width: pv.width, height: pv.height }, draft: { data: dr.data, width: dr.width, height: dr.height } };
    client.keepLocal(args);
    client.call('init', args).catch(() => {});
  }

  // ---------- state
  let rev = 0, busy = false, queued = false, dragging = false, lastMs = 0, regionBusy = false, closed = false, rendering = false;
  let view = { fit: true, zoom: 1, cx: FW / 2, cy: FH / 2 };
  let mode = 'single', showBefore = false, splitPos = 0.5;
  let clipLo = false, clipHi = false, altView = null, altDown = false, spaceDown = false, tool = 'hand', wbTool = false, showGrid = false, hoverPresetSettings = null;
  let hist = null;
  const undo = [clone(S)]; let undoIx = 0;
  const syncs = [];

  const effective = () => {
    let e = hoverPresetSettings ? hoverPresetSettings : S;
    if (!hidden.size) return e;
    e = clone(e);
    const groups = { basic: ['wb', 'temperature', 'tint', 'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'texture', 'clarity', 'dehaze', 'vibrance', 'saturation'], curve: ['parametric', 'pointCurve'], detail: ['sharpen', 'noise'], mixer: ['hsl', 'bwMix'], grading: ['grading'], optics: ['optics'], geometry: ['geometry'], effects: ['effects'] };
    for (const g of hidden) for (const k of groups[g]) e[k] = clone(DEF[k]);
    return e;
  };

  // ---------- DOM skeleton
  const canvas = el('canvas', { class: 'cr-canvas' });
  const vctx = canvas.getContext('2d');
  const badgeL = el('div', { class: 'cr-badge l' }), badgeR = el('div', { class: 'cr-badge r' });
  const spinner = el('div', { class: 'cr-spin hidden' });
  const progressBox = el('div', { class: 'cr-progress hidden' }, el('div', { class: 'lbl' }, 'Applying Camera Raw…'), el('div', { class: 'bar' }, el('span')));
  const viewEl = el('div', { class: 'cr-view', tabindex: '-1' }, canvas, badgeL, badgeR, spinner, progressBox);
  const histC = el('canvas', { class: 'cr-histo', width: 300, height: 120 });
  const triLo = el('button', { class: 'cr-tri lo', title: 'Shadow clipping warning (U)', onclick: () => { clipLo = !clipLo; drawHisto(); draw(); } });
  const triHi = el('button', { class: 'cr-tri hi', title: 'Highlight clipping warning (O)', onclick: () => { clipHi = !clipHi; drawHisto(); draw(); } });
  const readout = el('div', { class: 'cr-readout' }, el('span', {}, 'R'), el('b', {}, '–'), el('span', {}, 'G'), el('b', {}, '–'), el('span', {}, 'B'), el('b', {}, '–'));
  const info = el('div', { class: 'cr-info' }, `${FW} × ${FH} px`, el('span', { class: 'grow' }), el('span', { class: 'cr-mp' }, `${(FW * FH / 1e6).toFixed(1)} MP`));
  const histBox = el('div', { class: 'cr-histbox' }, el('div', { class: 'cr-hwrap' }, histC, triLo, triHi), readout, info);
  const scroll = el('div', { class: 'cr-scroll' });
  const presetsPane = el('div', { class: 'cr-scroll cr-presets hidden' });
  const railBtn = (id, icon, title, fn) => el('button', { class: 'ibtn', 'data-id': id, title, html: icon, onclick: fn });
  const rail = el('div', { class: 'cr-rail' },
    railBtn('edit', IC.edit, 'Edit (E)', () => showPane('edit')),
    railBtn('presets', IC.presets, 'Presets (Shift+P)', () => showPane('presets')),
    el('div', { class: 'grow' }),
    railBtn('zoom', IC.zoom, 'Zoom tool (Z) — double-click: 100%', () => setTool('zoom')),
    railBtn('hand', IC.hand, 'Hand tool (H) — double-click: Fit', () => setTool('hand')));
  rail.querySelector('[data-id=zoom]').addEventListener('dblclick', () => zoomTo(1));
  rail.querySelector('[data-id=hand]').addEventListener('dblclick', () => fitView());
  const side = el('div', { class: 'cr-side' }, histBox, el('div', { class: 'cr-panes' }, scroll, presetsPane));
  // footer
  const zoomSel = selectEl([['fit', 'Fit in View'], ['fill', 'Fill in View'], null, ['0.0625', '6.25%'], ['0.125', '12.5%'], ['0.25', '25%'], ['0.333', '33.3%'], ['0.5', '50%'], ['0.667', '66.7%'], ['1', '100%'], ['2', '200%'], ['3', '300%'], ['4', '400%'], ['8', '800%']], 'fit', (v) => { if (v === 'fit') fitView(); else if (v === 'fill') fillView(); else zoomTo(Number(v)); });
  zoomSel.classList.add('cr-zoomsel');
  const zoomLbl = el('span', { class: 'cr-zoomlbl' });
  const zb = (d) => el('button', { class: 'ibtn cr-zb', title: d > 0 ? 'Zoom in (Ctrl+=)' : 'Zoom out (Ctrl+-)', onclick: () => zoomStep(d) }, d > 0 ? '+' : '−');
  const modeBtn = (m, icon, title) => el('button', { class: 'ibtn', 'data-mode': m, title, html: icon, onclick: () => setMode(m) });
  const modes = el('div', { class: 'cr-modes' },
    modeBtn('single', IC.single, 'Single view'), modeBtn('side', IC.side, 'Before/After Left/Right'), modeBtn('split', IC.split, 'Before/After Left/Right Split'), modeBtn('topbot', IC.topbot, 'Before/After Top/Bottom'),
    el('span', { class: 'cr-vsep' }),
    el('button', { class: 'ibtn', 'data-id': 'before', title: 'Toggle Before/After (\\ or P) — Cycle views (Q / Y)', html: IC.swap, onclick: () => toggleBefore() }));
  const cancelBtn = el('button', { class: 'btn cr-cancel', onclick: () => { if (rendering) return; if (altDown) resetAll(); else api.close(null); } }, 'Cancel');
  const okBtn = el('button', { class: 'btn primary cr-ok', onclick: () => commitOK() }, 'OK');
  const footLeft = el('div', { class: 'cr-footl' }, zoomSel, zb(-1), zoomLbl, zb(1), el('span', { class: 'cr-vsep' }), modes);
  const root = el('div', { class: 'cr-root' },
    el('div', { class: 'cr-top' }, el('span', { class: 'cr-title' }, 'Camera Raw Filter'), el('span', { class: 'cr-sub' }, opts.name || ''), el('span', { class: 'grow' }),
      el('button', { class: 'ibtn', title: 'Undo (Ctrl+Z)', html: IC.undo, onclick: () => doUndo(-1) }),
      el('button', { class: 'ibtn', title: 'Cancel', html: IC.close, onclick: () => { if (!rendering) api.close(null); } })),
    el('div', { class: 'cr-main' }, viewEl, side, rail));
  let api = null;

  // ---------------------------------------------------------------- controls
  const commit = () => {
    const snap = clone(S);
    if (JSON.stringify(snap) === JSON.stringify(undo[undoIx])) return;
    undo.length = undoIx + 1; undo.push(snap); undoIx = undo.length - 1; if (undo.length > 100) { undo.shift(); undoIx--; }
  };
  const changed = (final = true) => { rev++; syncDots(); request(); if (final) commit(); };
  const syncAll = () => { syncs.forEach((f) => f()); syncDots(); };
  function doUndo(d) { const ni = clamp(undoIx + d, 0, undo.length - 1); if (ni === undoIx) return; undoIx = ni; S = clone(undo[undoIx]); rev++; syncAll(); request(); }
  function resetAll() { const t = S.treatment; S = defaultRawSettings(); S.treatment = 'color'; void t; hidden.clear(); rebuildEdit(); changed(); toast('Reset to defaults', '', 1200); }

  // slider factory
  function slider(o) {
    const { path, label, min, max, step = 1, fmt, track, alt, disabled } = o;
    const def = o.def != null ? o.def : getP(DEF, path);
    const f = fmt || ((v) => (min < 0 ? signed(v, step < 1 ? (step < 0.1 ? 2 : 1) : 0) : Number(v).toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)));
    const rng = el('input', { type: 'range', min, max, step, value: getP(S, path) });
    const val = el('input', { type: 'text', class: 'cr-val', value: f(getP(S, path)), spellcheck: false });
    const lab = el('label', { title: 'Double-click to reset' }, label);
    const row = el('div', { class: 'cr-sl' + (track ? ' grad' : '') }, el('div', { class: 'cr-sl-top' }, lab, val), el('div', { class: 'cr-track' }, rng));
    if (track) row.querySelector('.cr-track').style.setProperty('--track', typeof track === 'function' ? track() : track);
    const set = (v, final) => {
      v = clamp(Number(v), min, max); if (!isFinite(v)) return;
      setP(S, path, v); val.value = f(v); rng.value = v;
      if (o.onSet) o.onSet(v);
      changed(final);
    };
    rng.addEventListener('input', () => set(rng.value, false));
    rng.addEventListener('change', () => { set(rng.value, true); });
    rng.addEventListener('pointerdown', (e) => {
      dragging = true;
      if (alt && (e.altKey || altDown)) { altView = alt; }
      const up = () => { dragging = false; if (altView) { altView = null; rev++; request(); } removeEventListener('pointerup', up, true); request(); };
      addEventListener('pointerup', up, true);
    });
    rng.addEventListener('dblclick', () => set(def, true));
    lab.addEventListener('dblclick', () => set(def, true));
    val.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { set(parseFloat(String(val.value).replace('−', '-')) || 0, true); val.blur(); }
      else if (e.key === 'Escape') { val.value = f(getP(S, path)); val.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); set(getP(S, path) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1), true); }
    });
    val.addEventListener('blur', () => { val.value = f(getP(S, path)); });
    val.addEventListener('focus', () => setTimeout(() => val.select(), 0));
    // scrubby label (drag left/right)
    lab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x0 = e.clientX, v0 = getP(S, path); let moved = false; dragging = true;
      const mv = (ev) => { const dx = ev.clientX - x0; if (Math.abs(dx) > 2) moved = true; if (moved) set(v0 + Math.round(dx / (ev.shiftKey ? 0.5 : 2)) * step * (ev.shiftKey ? 5 : 1), false); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); dragging = false; if (moved) { commit(); request(); } };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    row.sync = () => {
      const v = getP(S, path); rng.value = v; if (document.activeElement !== val) val.value = f(v);
      if (typeof track === 'function') row.querySelector('.cr-track').style.setProperty('--track', track());
      row.classList.toggle('dis', !!(disabled && disabled()));
    };
    row.sync();
    syncs.push(row.sync);
    row.dataset.path = path;
    return row;
  }
  const sep = () => el('div', { class: 'cr-sep' });
  const sub = (t, extra) => el('div', { class: 'cr-subhead' }, el('span', {}, t), extra || null);

  // collapsible section
  const sections = {};
  function section(id, title, build) {
    const body = el('div', { class: 'cr-sbody' });
    const eye = el('button', { class: 'ibtn cr-eye', title: 'Toggle panel visibility', html: IC.eye });
    const dot = el('span', { class: 'cr-dot', title: 'Edited' });
    const head = el('div', { class: 'cr-shead' }, el('span', { class: 'cr-chev', html: IC.chev }), el('span', { class: 'cr-stitle' }, title), dot, el('span', { class: 'grow' }), eye);
    const sec = el('div', { class: 'cr-sec' + (ui.open[id] ? ' open' : '') }, head, body);
    let built = false;
    const ensure = () => { if (!built && ui.open[id]) { built = true; build(body); } };
    head.addEventListener('click', (e) => {
      if (e.target.closest('.cr-eye')) return;
      if (e.altKey) { for (const k of Object.keys(ui.open)) ui.open[k] = k === id; Object.values(sections).forEach((s) => s.refresh()); }
      else { ui.open[id] = !ui.open[id]; sec.classList.toggle('open', ui.open[id]); ensure(); }
      lsSet(UI_KEY, ui);
    });
    eye.addEventListener('click', () => { if (hidden.has(id)) hidden.delete(id); else hidden.add(id); eye.innerHTML = hidden.has(id) ? IC.eyeOff : IC.eye; sec.classList.toggle('hid', hidden.has(id)); rev++; request(); });
    sections[id] = { sec, dot, refresh: () => { sec.classList.toggle('open', !!ui.open[id]); ensure(); }, rebuild: () => { body.innerHTML = ''; built = false; ensure(); } };
    ensure();
    return sec;
  }
  function syncDots() {
    const st = rawStages(S);
    const on = { basic: st.linear || st.hs || st.dehaze || st.clarity || st.texture || st.sat || !!(S.contrast || S.whites || S.blacks), curve: !!(S.parametric.highlights || S.parametric.lights || S.parametric.darks || S.parametric.shadows) || ['rgb', 'red', 'green', 'blue'].some((c) => S.pointCurve[c].some((p) => p[0] !== p[1])), detail: st.detail, mixer: st.hsl || (S.treatment === 'bw' && S.bwMix.some((v) => v)), grading: st.grading, optics: st.lensVig || st.defringe || !!S.optics.distortion, geometry: st.geometry && !(S.optics.distortion && !(S.geometry.vertical || S.geometry.horizontal || S.geometry.rotate || S.geometry.aspect || S.geometry.scale !== 100 || S.geometry.offsetX || S.geometry.offsetY)), effects: st.effects };
    for (const [k, s] of Object.entries(sections)) s.dot.classList.toggle('on', !!on[k]);
    bwBtn.classList.toggle('on', S.treatment === 'bw');
    profSel.value = S.treatment;
  }

  // ---------------------------------------------------------------- Edit pane
  const bwBtn = el('button', { class: 'btn cr-small', title: 'Convert to black & white (V)', onclick: () => toggleBW() }, 'B&W');
  const autoBtn = el('button', { class: 'btn cr-small', title: 'Auto tone (Ctrl+U)', onclick: () => doAuto() }, 'Auto');
  const profSel = selectEl([['color', 'Color'], ['bw', 'Monochrome']], S.treatment, (v) => { S.treatment = v; sections.mixer && sections.mixer.rebuild(); changed(); });
  function toggleBW() { S.treatment = S.treatment === 'bw' ? 'color' : 'bw'; sections.mixer.rebuild(); syncAll(); changed(); }
  async function doAuto() {
    const r = await client.call('auto', {});
    Object.assign(S, r.tone); syncAll(); changed(); toast('Auto tone applied', '', 1200);
  }
  async function doAutoWB() { const r = await client.call('auto', {}); S.wb = 'auto'; S.temperature = r.wb.temperature; S.tint = r.wb.tint; syncAll(); changed(); }
  function rebuildEdit() {
    scroll.innerHTML = ''; syncs.length = 0;
    for (const k of Object.keys(sections)) delete sections[k];
    scroll.append(
      el('div', { class: 'cr-edithead' }, el('span', { class: 'cr-h' }, 'Edit'), el('span', { class: 'grow' }), autoBtn, bwBtn),
      el('div', { class: 'cr-profile' }, el('label', {}, 'Profile'), profSel),
      section('basic', 'Basic', buildBasic), section('curve', 'Curve', buildCurve), section('detail', 'Detail', buildDetail),
      section('mixer', 'Color Mixer', buildMixer), section('grading', 'Color Grading', buildGrading), section('optics', 'Optics', buildOptics),
      section('geometry', 'Geometry', buildGeometry), section('effects', 'Effects', buildEffects));
    syncDots();
  }
  // ---------- Basic
  function buildBasic(b) {
    const wbSel = selectEl(WB_LABELS, S.wb, (v) => {
      S.wb = v;
      if (v === 'auto') { doAutoWB(); return; }
      if (WB_PRESETS[v]) { S.temperature = WB_PRESETS[v].temperature; S.tint = WB_PRESETS[v].tint; }
      syncAll(); changed();
    });
    const dropper = el('button', { class: 'ibtn cr-dropper', title: 'White Balance tool (I) — click something neutral', html: IC.dropper, onclick: () => setWBTool(!wbTool) });
    syncs.push(() => { wbSel.value = S.wb; dropper.classList.toggle('on', wbTool); });
    const toCustom = () => { if (S.wb !== 'custom') { S.wb = 'custom'; wbSel.value = 'custom'; } };
    b.append(
      el('div', { class: 'cr-row' }, el('label', {}, 'White Balance'), wbSel, dropper),
      slider({ path: 'temperature', label: 'Temperature', min: -100, max: 100, track: G.temp, onSet: toCustom }),
      slider({ path: 'tint', label: 'Tint', min: -100, max: 100, track: G.tint, onSet: toCustom }),
      sep(),
      slider({ path: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.05, track: G.tone, alt: 'hi', fmt: (v) => signed(v, 2) }),
      slider({ path: 'contrast', label: 'Contrast', min: -100, max: 100 }),
      sep(),
      slider({ path: 'highlights', label: 'Highlights', min: -100, max: 100, track: G.tone, alt: 'hi' }),
      slider({ path: 'shadows', label: 'Shadows', min: -100, max: 100, track: G.tone, alt: 'lo' }),
      slider({ path: 'whites', label: 'Whites', min: -100, max: 100, track: G.tone, alt: 'hi' }),
      slider({ path: 'blacks', label: 'Blacks', min: -100, max: 100, track: G.tone, alt: 'lo' }),
      sep(),
      slider({ path: 'texture', label: 'Texture', min: -100, max: 100 }),
      slider({ path: 'clarity', label: 'Clarity', min: -100, max: 100 }),
      slider({ path: 'dehaze', label: 'Dehaze', min: -100, max: 100 }),
      sep(),
      slider({ path: 'vibrance', label: 'Vibrance', min: -100, max: 100, track: G.sat, disabled: () => S.treatment === 'bw' }),
      slider({ path: 'saturation', label: 'Saturation', min: -100, max: 100, track: G.sat, disabled: () => S.treatment === 'bw' }));
  }
  // ---------- Curve
  function buildCurve(b) {
    const modesRow = el('div', { class: 'cr-curvemodes' });
    const CM = [['parametric', 'Parametric curve', 'p'], ['rgb', 'Point curve', 'w'], ['red', 'Red channel', 'r'], ['green', 'Green channel', 'g'], ['blue', 'Blue channel', 'b']];
    for (const [m, t, c] of CM) modesRow.append(el('button', { class: 'cr-cm ' + c + (ui.curveMode === m ? ' on' : ''), title: t, 'data-m': m, onclick: () => { ui.curveMode = m; lsSet(UI_KEY, ui); modesRow.querySelectorAll('.cr-cm').forEach((x) => x.classList.toggle('on', x.dataset.m === m)); paramBox.classList.toggle('hidden', m !== 'parametric'); pointNote.classList.toggle('hidden', m === 'parametric'); drawCurve(); } }));
    const cv = el('canvas', { class: 'cr-curve', width: 512, height: 512 });
    const cg = cv.getContext('2d');
    const splitBar = el('div', { class: 'cr-splitbar' });
    const handles = [1, 2, 3].map((i) => { const hd = el('span', { class: 'cr-sh', title: 'Region split (double-click to reset)' }); splitBar.append(hd); return hd; });
    const paramBox = el('div', { class: ui.curveMode === 'parametric' ? '' : 'hidden' }, splitBar,
      slider({ path: 'parametric.highlights', label: 'Highlights', min: -100, max: 100, onSet: () => drawCurve() }),
      slider({ path: 'parametric.lights', label: 'Lights', min: -100, max: 100, onSet: () => drawCurve() }),
      slider({ path: 'parametric.darks', label: 'Darks', min: -100, max: 100, onSet: () => drawCurve() }),
      slider({ path: 'parametric.shadows', label: 'Shadows', min: -100, max: 100, onSet: () => drawCurve() }));
    const ioLbl = el('span', { class: 'muted' });
    const pointNote = el('div', { class: 'cr-pointnote' + (ui.curveMode === 'parametric' ? ' hidden' : '') }, ioLbl, el('span', { class: 'grow' }), el('button', { class: 'btn cr-small', onclick: () => { S.pointCurve[ui.curveMode] = [[0, 0], [255, 255]]; sel = -1; drawCurve(); changed(); } }, 'Reset Channel'));
    b.append(modesRow, el('div', { class: 'cr-curvewrap' }, cv), paramBox, pointNote);
    const placeHandles = () => { const P = S.parametric; [P.split1, P.split2, P.split3].forEach((v, i) => { handles[i].style.left = v + '%'; }); };
    handles.forEach((hd, i) => {
      const key = 'split' + (i + 1);
      hd.addEventListener('pointerdown', (e) => {
        e.preventDefault(); hd.setPointerCapture(e.pointerId); dragging = true;
        const r = splitBar.getBoundingClientRect();
        const mv = (ev) => { const v = Math.round(clamp((ev.clientX - r.left) / r.width * 100, 5, 95)); const P = S.parametric; const lo = i === 0 ? 5 : P['split' + i] + 5, hi = i === 2 ? 95 : P['split' + (i + 2)] - 5; P[key] = clamp(v, lo, hi); placeHandles(); drawCurve(); changed(false); };
        const up = () => { hd.removeEventListener('pointermove', mv); hd.removeEventListener('pointerup', up); dragging = false; commit(); request(); };
        hd.addEventListener('pointermove', mv); hd.addEventListener('pointerup', up);
      });
      hd.addEventListener('dblclick', () => { S.parametric[key] = [25, 50, 75][i]; placeHandles(); drawCurve(); changed(); });
    });
    let sel = -1;
    function drawCurve() {
      const W = cv.width, H = cv.height, m = ui.curveMode;
      cg.clearRect(0, 0, W, H);
      cg.fillStyle = '#1d1d1d'; cg.fillRect(0, 0, W, H);
      if (hist) {
        const a = m === 'red' ? hist.r : m === 'green' ? hist.g : m === 'blue' ? hist.b : hist.l;
        let mx = 1; const sorted = Array.from(a).sort((x, y) => x - y); mx = Math.max(1, sorted[250] * 1.15);
        cg.fillStyle = m === 'red' ? 'rgba(220,70,70,.28)' : m === 'green' ? 'rgba(70,200,90,.28)' : m === 'blue' ? 'rgba(80,120,240,.3)' : 'rgba(200,200,200,.18)';
        cg.beginPath(); cg.moveTo(0, H);
        for (let i = 0; i < 256; i++) cg.lineTo(i / 255 * W, H - Math.min(1, a[i] / mx) * H * 0.9);
        cg.lineTo(W, H); cg.fill();
      }
      cg.strokeStyle = '#3a3a3a'; cg.lineWidth = 1;
      for (let i = 1; i < 4; i++) { cg.beginPath(); cg.moveTo(i * W / 4, 0); cg.lineTo(i * W / 4, H); cg.moveTo(0, i * H / 4); cg.lineTo(W, i * H / 4); cg.stroke(); }
      if (m === 'parametric') {
        const P = S.parametric;
        cg.fillStyle = 'rgba(255,255,255,.035)';
        [P.split1, P.split3].forEach((v, i) => { if (i === 0) cg.fillRect(0, 0, v / 100 * W, H); else cg.fillRect(v / 100 * W, 0, W, H); });
        cg.strokeStyle = '#555'; cg.setLineDash([4, 4]); cg.beginPath(); cg.moveTo(0, H); cg.lineTo(W, 0); cg.stroke(); cg.setLineDash([]);
        const tf = toneFunction({ ...defaultRawSettings(), parametric: P });
        cg.strokeStyle = '#e8e8e8'; cg.lineWidth = 2; cg.beginPath();
        for (let x = 0; x <= 255; x++) { const y = tf(x / 255); x ? cg.lineTo(x / 255 * W, H - y * H) : cg.moveTo(0, H - y * H); }
        cg.stroke();
        placeHandles();
      } else {
        const pts = S.pointCurve[m];
        const col = m === 'red' ? '#ff5a5a' : m === 'green' ? '#5ad46a' : m === 'blue' ? '#6a8cff' : '#e8e8e8';
        cg.strokeStyle = '#555'; cg.setLineDash([4, 4]); cg.beginPath(); cg.moveTo(0, H); cg.lineTo(W, 0); cg.stroke(); cg.setLineDash([]);
        const f = curveSpline(pts);
        cg.strokeStyle = col; cg.lineWidth = 2; cg.beginPath();
        for (let x = 0; x <= 255; x++) { const y = f(x / 255); x ? cg.lineTo(x / 255 * W, H - y * H) : cg.moveTo(0, H - y * H); }
        cg.stroke();
        pts.forEach((p, i) => { cg.fillStyle = i === sel ? col : '#1d1d1d'; cg.strokeStyle = col; cg.lineWidth = 2; cg.beginPath(); cg.rect(p[0] / 255 * W - 7, H - p[1] / 255 * H - 7, 14, 14); cg.fill(); cg.stroke(); });
        ioLbl.textContent = sel >= 0 && pts[sel] ? `Input ${Math.round(pts[sel][0])}  Output ${Math.round(pts[sel][1])}` : 'Click to add points';
      }
    }
    const toCurve = (e) => { const r = cv.getBoundingClientRect(); return [clamp((e.clientX - r.left) / r.width * 255, 0, 255), clamp(255 - (e.clientY - r.top) / r.height * 255, 0, 255), (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
    cv.addEventListener('pointerdown', (e) => {
      const m = ui.curveMode; cv.setPointerCapture(e.pointerId); dragging = true;
      if (m === 'parametric') {
        const P = S.parametric, [x] = toCurve(e), xp = x / 255 * 100;
        const key = xp < P.split1 ? 'shadows' : xp < P.split2 ? 'darks' : xp < P.split3 ? 'lights' : 'highlights';
        const y0 = e.clientY, v0 = P[key];
        const mv = (ev) => { P[key] = clamp(Math.round(v0 + (y0 - ev.clientY) * 0.8), -100, 100); syncAll(); drawCurve(); changed(false); };
        const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); dragging = false; commit(); request(); };
        cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
        return;
      }
      const pts = S.pointCurve[m], [x, y] = toCurve(e);
      sel = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 12);
      if (sel < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); sel = pts.findIndex((p) => p[0] === x && p[1] === y); }
      drawCurve(); changed(false);
      const mv = (ev) => {
        const [nx, ny, fx, fy] = toCurve(ev), p = pts[sel]; if (!p) return;
        const out = fx < -0.12 || fx > 1.12 || fy < -0.12 || fy > 1.12;
        if (out && sel > 0 && sel < pts.length - 1) { pts.splice(sel, 1); sel = -1; drawCurve(); changed(false); return; }
        const lo = sel > 0 ? pts[sel - 1][0] + 1 : 0, hi = sel < pts.length - 1 ? pts[sel + 1][0] - 1 : 255;
        p[0] = clamp(nx, lo, hi); p[1] = ny; drawCurve(); changed(false);
      };
      const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); dragging = false; commit(); request(); };
      cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up);
    });
    cv.addEventListener('dblclick', (e) => {
      const m = ui.curveMode; if (m === 'parametric') return;
      const pts = S.pointCurve[m], [x, y] = toCurve(e), i = pts.findIndex((p) => Math.hypot(p[0] - x, p[1] - y) < 12);
      if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); sel = -1; drawCurve(); changed(); }
    });
    cv.tabIndex = 0;
    cv.addEventListener('keydown', (e) => { const m = ui.curveMode; if ((e.key === 'Delete' || e.key === 'Backspace') && m !== 'parametric' && sel > 0 && sel < S.pointCurve[m].length - 1) { S.pointCurve[m].splice(sel, 1); sel = -1; drawCurve(); changed(); e.stopPropagation(); } });
    syncs.push(drawCurve);
    curveRedraw = drawCurve;
    drawCurve();
  }
  let curveRedraw = null;
  // ---------- Detail
  function buildDetail(b) {
    const warn = el('div', { class: 'cr-note' }, el('span', { html: IC.warn }), 'Zoom preview to 100% or larger to see an accurate preview of sharpening and noise reduction.');
    syncs.push(() => warn.classList.toggle('hidden', curZoom() >= 0.99));
    detailWarn = warn;
    const sh = () => S.sharpen.amount === 0, ln = () => S.noise.luminance === 0, cn = () => S.noise.color === 0;
    b.append(warn,
      slider({ path: 'sharpen.amount', label: 'Sharpening', min: 0, max: 150 }),
      slider({ path: 'sharpen.radius', label: 'Radius', min: 0.5, max: 3, step: 0.1, disabled: sh }),
      slider({ path: 'sharpen.detail', label: 'Detail', min: 0, max: 100, disabled: sh }),
      slider({ path: 'sharpen.masking', label: 'Masking', min: 0, max: 100, disabled: sh, alt: 'sharpMask' }),
      el('div', { class: 'cr-hint' }, 'Alt-drag Masking to preview the edge mask.'),
      sep(),
      slider({ path: 'noise.luminance', label: 'Noise Reduction', min: 0, max: 100 }),
      slider({ path: 'noise.lumDetail', label: 'Detail', min: 0, max: 100, disabled: ln }),
      slider({ path: 'noise.lumContrast', label: 'Contrast', min: 0, max: 100, disabled: ln }),
      sep(),
      slider({ path: 'noise.color', label: 'Color Noise Reduction', min: 0, max: 100 }),
      slider({ path: 'noise.colorDetail', label: 'Detail', min: 0, max: 100, disabled: cn }),
      slider({ path: 'noise.colorSmoothness', label: 'Smoothness', min: 0, max: 100, disabled: cn }));
  }
  let detailWarn = null;
  // ---------- Color Mixer
  function buildMixer(b) {
    if (S.treatment === 'bw') {
      b.append(sub('B&W Mix', el('button', { class: 'btn cr-small', onclick: () => { S.bwMix = [0, 0, 0, 0, 0, 0, 0, 0]; syncAll(); changed(); } }, 'Default')),
        ...HSL_LABELS.map((l, i) => slider({ path: 'bwMix.' + i, label: l, min: -100, max: 100, track: `linear-gradient(90deg,#111,${hsl(HSL_HUES[i], 70, 50)},#eee)` })));
      return;
    }
    const tabs = el('div', { class: 'cr-tabs' });
    const box = el('div', { class: 'cr-mixbox' });
    const TABS = [['hue', 'Hue'], ['saturation', 'Saturation'], ['luminance', 'Luminance'], ['all', 'All']];
    const draw = () => {
      tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.t === ui.mixerTab));
      box.innerHTML = '';
      const kinds = ui.mixerTab === 'all' ? ['hue', 'saturation', 'luminance'] : [ui.mixerTab];
      for (const kind of kinds) {
        if (ui.mixerTab === 'all') box.append(sub(kind[0].toUpperCase() + kind.slice(1)));
        HSL_LABELS.forEach((l, i) => {
          const h = HSL_HUES[i];
          const track = kind === 'hue' ? hueRange(h) : kind === 'saturation' ? `linear-gradient(90deg,#808080,${hsl(h, 85, 50)})` : `linear-gradient(90deg,#0d0d0d,${hsl(h, 70, 48)},#f2f2f2)`;
          box.append(slider({ path: `hsl.${kind}.${i}`, label: l, min: -100, max: 100, track }));
        });
      }
    };
    for (const [t, l] of TABS) tabs.append(el('button', { 'data-t': t, onclick: () => { ui.mixerTab = t; lsSet(UI_KEY, ui); draw(); } }, l));
    b.append(el('div', { class: 'cr-row' }, el('label', {}, 'Mixer'), selectEl([['hsl', 'HSL']], 'hsl'), el('span', { class: 'grow' }), el('button', { class: 'btn cr-small', title: 'Reset all colour mixer values', onclick: () => { S.hsl = clone(DEF.hsl); draw(); changed(); } }, 'Reset')), tabs, box);
    draw();
  }
  // ---------- Color Grading
  function wheel(region, size) {
    const c = el('canvas', { class: 'cr-wheel', width: size * 2, height: size * 2, style: { width: size + 'px', height: size + 'px' } });
    const g = c.getContext('2d');
    const base = (() => {
      const N = size * 2, im = g.createImageData(N, N), R = N / 2 - 3;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const dx = x - N / 2 + 0.5, dy = y - N / 2 + 0.5, r = Math.hypot(dx, dy) / R, o = (y * N + x) * 4;
        if (r > 1.02) continue;
        const h = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360, s = Math.min(1, r);
        const cc = hsv(h, s * 0.85, 0.42 + 0.33 * s);
        const a = clamp((1.02 - r) * R, 0, 1);
        im.data[o] = cc[0]; im.data[o + 1] = cc[1]; im.data[o + 2] = cc[2]; im.data[o + 3] = 255 * a;
      }
      return im;
    })();
    const draw = () => {
      const N = size * 2, R = N / 2 - 3, gr = S.grading[region];
      g.putImageData(base, 0, 0);
      g.strokeStyle = 'rgba(0,0,0,.35)'; g.lineWidth = 1; g.beginPath(); g.moveTo(N / 2, 6); g.lineTo(N / 2, N - 6); g.moveTo(6, N / 2); g.lineTo(N - 6, N / 2); g.stroke();
      const a = gr.hue * Math.PI / 180, rr = gr.sat / 100 * R, x = N / 2 + Math.cos(a) * rr, y = N / 2 - Math.sin(a) * rr;
      g.lineWidth = 3; g.strokeStyle = '#fff'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 1.5; g.strokeStyle = '#000'; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.stroke();
    };
    const pick = (e, lockHue) => {
      const r = c.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
      const R = r.width / 2 - 1.5, gr = S.grading[region];
      const sat = Math.round(clamp(Math.hypot(dx, dy) / R * 100, 0, 100));
      if (!lockHue) gr.hue = Math.round((Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360);
      gr.sat = sat; syncAll(); changed(false);
    };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId); dragging = true; const lock = e.shiftKey && S.grading[region].sat > 0; pick(e, lock);
      const mv = (ev) => pick(ev, lock), up = () => { c.removeEventListener('pointermove', mv); c.removeEventListener('pointerup', up); dragging = false; commit(); request(); };
      c.addEventListener('pointermove', mv); c.addEventListener('pointerup', up);
    });
    c.addEventListener('dblclick', () => { S.grading[region].hue = 0; S.grading[region].sat = 0; syncAll(); changed(); });
    c.title = 'Drag to set hue and saturation (Shift: saturation only, double-click to reset)';
    syncs.push(draw); draw();
    return c;
  }
  function buildGrading(b) {
    const tabs = el('div', { class: 'cr-gtabs' });
    const box = el('div', { class: 'cr-gradebox' });
    const T = [['3way', '3-Way', 'conic-gradient(#555 0 33%,#888 0 66%,#bbb 0)'], ['shadows', 'Shadows', 'radial-gradient(#222,#222)'], ['midtones', 'Midtones', 'radial-gradient(#777,#777)'], ['highlights', 'Highlights', 'radial-gradient(#ddd,#ddd)'], ['global', 'Global', 'conic-gradient(#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)']];
    const lumTrack = 'linear-gradient(90deg,#111,#eee)';
    const satTrack = (r) => () => `linear-gradient(90deg,#808080,${hsl(S.grading[r].hue, 85, 50)})`;
    const draw = () => {
      tabs.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.t === ui.gradeTab));
      box.innerHTML = '';
      const t = ui.gradeTab;
      if (t === '3way') {
        const cell = (r, l) => el('div', { class: 'cr-wcell' }, el('div', { class: 'cr-wlbl' }, l), wheel(r, 104), slider({ path: `grading.${r}.lum`, label: 'Luminance', min: -100, max: 100, track: lumTrack }));
        box.append(el('div', { class: 'cr-wtop' }, cell('midtones', 'Midtones')), el('div', { class: 'cr-wbot' }, cell('shadows', 'Shadows'), cell('highlights', 'Highlights')));
      } else {
        box.append(el('div', { class: 'cr-wbig' }, wheel(t, 168)),
          slider({ path: `grading.${t}.hue`, label: 'Hue', min: 0, max: 359, track: G.hue, fmt: (v) => String(Math.round(v)) }),
          slider({ path: `grading.${t}.sat`, label: 'Saturation', min: 0, max: 100, track: satTrack(t) }),
          slider({ path: `grading.${t}.lum`, label: 'Luminance', min: -100, max: 100, track: lumTrack }));
      }
      box.append(sep(), slider({ path: 'grading.blending', label: 'Blending', min: 0, max: 100 }), slider({ path: 'grading.balance', label: 'Balance', min: -100, max: 100 }));
    };
    for (const [t, l, bg] of T) tabs.append(el('button', { 'data-t': t, title: l, onclick: () => { ui.gradeTab = t; lsSet(UI_KEY, ui); draw(); } }, el('span', { class: 'cr-gdot', style: { background: bg } }), el('span', {}, l)));
    b.append(el('div', { class: 'cr-row' }, el('label', {}, 'Adjust')), tabs, box);
    draw();
  }
  // ---------- Optics
  function buildOptics(b) {
    b.append(sub('Distortion & Vignette'),
      slider({ path: 'optics.distortion', label: 'Distortion', min: -100, max: 100 }),
      slider({ path: 'optics.vignette', label: 'Vignette', min: -100, max: 100, track: G.tone }),
      slider({ path: 'optics.vignetteMidpoint', label: 'Midpoint', min: 0, max: 100, disabled: () => !S.optics.vignette }),
      sep(), sub('Defringe'),
      slider({ path: 'optics.defringePurple', label: 'Purple Amount', min: 0, max: 20, track: 'linear-gradient(90deg,#666,#a24fd0)' }),
      slider({ path: 'optics.defringeGreen', label: 'Green Amount', min: 0, max: 20, track: 'linear-gradient(90deg,#666,#5fbf4a)' }));
  }
  // ---------- Geometry
  function buildGeometry(b) {
    const fillSel = selectEl([['transparent', 'Transparent'], ['edge', 'Extend edges']], S.geometry.fill, (v) => { S.geometry.fill = v; changed(); });
    const con = checkEl('Constrain crop', S.geometry.constrain, (v) => { S.geometry.constrain = v; changed(); });
    const grid = checkEl('Show grid', showGrid, (v) => { showGrid = v; draw(); });
    syncs.push(() => { fillSel.value = S.geometry.fill; con.input.checked = S.geometry.constrain; });
    b.append(sub('Manual Transformations', el('button', { class: 'btn cr-small', onclick: () => { S.geometry = clone(DEF.geometry); syncAll(); changed(); } }, 'Reset')),
      slider({ path: 'geometry.vertical', label: 'Vertical', min: -100, max: 100 }),
      slider({ path: 'geometry.horizontal', label: 'Horizontal', min: -100, max: 100 }),
      slider({ path: 'geometry.rotate', label: 'Rotate', min: -10, max: 10, step: 0.1, fmt: (v) => signed(v, 1) }),
      slider({ path: 'geometry.aspect', label: 'Aspect', min: -100, max: 100 }),
      slider({ path: 'geometry.scale', label: 'Scale', min: 50, max: 150 }),
      slider({ path: 'geometry.offsetX', label: 'Offset X', min: -100, max: 100 }),
      slider({ path: 'geometry.offsetY', label: 'Offset Y', min: -100, max: 100 }),
      el('div', { class: 'cr-checks' }, con, grid), el('div', { class: 'cr-row' }, el('label', {}, 'Fill'), fillSel));
  }
  // ---------- Effects
  function buildEffects(b) {
    const styleSel = selectEl([['highlight', 'Highlight Priority'], ['color', 'Color Priority'], ['paint', 'Paint Overlay']], S.effects.vignetteStyle, (v) => { S.effects.vignetteStyle = v; syncAll(); changed(); });
    syncs.push(() => { styleSel.value = S.effects.vignetteStyle; });
    const ng = () => !S.effects.grainAmount, nv = () => !S.effects.vignetteAmount;
    b.append(sub('Grain'),
      slider({ path: 'effects.grainAmount', label: 'Grain', min: 0, max: 100 }),
      slider({ path: 'effects.grainSize', label: 'Size', min: 0, max: 100, disabled: ng }),
      slider({ path: 'effects.grainRoughness', label: 'Roughness', min: 0, max: 100, disabled: ng }),
      sep(), sub('Vignette'),
      el('div', { class: 'cr-row' }, el('label', {}, 'Style'), styleSel),
      slider({ path: 'effects.vignetteAmount', label: 'Vignette', min: -100, max: 100, track: G.tone }),
      slider({ path: 'effects.vignetteMidpoint', label: 'Midpoint', min: 0, max: 100, disabled: nv }),
      slider({ path: 'effects.vignetteRoundness', label: 'Roundness', min: -100, max: 100, disabled: nv }),
      slider({ path: 'effects.vignetteFeather', label: 'Feather', min: 0, max: 100, disabled: nv }),
      slider({ path: 'effects.vignetteHighlights', label: 'Highlights', min: 0, max: 100, disabled: () => !(S.effects.vignetteAmount < 0 && S.effects.vignetteStyle === 'highlight') }));
  }

  // ---------------------------------------------------------------- Presets pane
  const userPresets = () => { const v = lsGet(PRESET_KEY, []); return Array.isArray(v) ? v.filter((p) => p && p.name && p.settings) : []; };
  function presetSettings(p) { return p.auto ? null : mergeRawSettings(S, p.settings); }
  async function applyPreset(p) {
    hoverPresetSettings = null;
    if (p.auto) { await doAuto(); return; }
    S = normalizeRawSettings(mergeRawSettings(S, p.settings)); rebuildEdit(); changed(); toast(`Preset “${p.name}” applied`, '', 1200);
  }
  function diffFromDefault(s) {
    const out = {}, d = defaultRawSettings();
    for (const k of Object.keys(d)) if (JSON.stringify(s[k]) !== JSON.stringify(d[k]) && k !== 'version') out[k] = clone(s[k]);
    return out;
  }
  async function savePreset() {
    const diff = diffFromDefault(S);
    if (!Object.keys(diff).length) { toast('Nothing to save — all settings are at their defaults', '', 2200); return; }
    const name = await promptBox('Preset name', 'My Preset', 'Create Preset');
    if (!name || !String(name).trim()) return;
    const list = userPresets().filter((p) => p.name !== name.trim());
    list.push({ name: name.trim(), settings: diff, created: Date.now() });
    lsSet(PRESET_KEY, list); buildPresets(); toast(`Saved preset “${name.trim()}”`, 'ok', 1500);
  }
  function buildPresets() {
    presetsPane.innerHTML = '';
    const row = (p, user) => {
      const r = el('div', { class: 'cr-preset', title: p.auto ? 'Auto tone' : 'Hover to preview, click to apply' }, thumbFor(p), el('span', { class: 'grow' }, p.name));
      if (user) r.append(el('button', { class: 'ibtn cr-pdel', title: 'Delete preset', html: IC.trash, onclick: (e) => { e.stopPropagation(); lsSet(PRESET_KEY, userPresets().filter((q) => q.name !== p.name)); buildPresets(); } }));
      r.addEventListener('click', () => applyPreset(p));
      r.addEventListener('pointerenter', () => { const s = presetSettings(p); if (s) { hoverPresetSettings = normalizeRawSettings(s); rev++; request(); } });
      r.addEventListener('pointerleave', () => { if (hoverPresetSettings) { hoverPresetSettings = null; rev++; request(); } });
      return r;
    };
    presetsPane.append(el('div', { class: 'cr-edithead' }, el('span', { class: 'cr-h' }, 'Presets'), el('span', { class: 'grow' }), el('button', { class: 'ibtn', title: 'Create preset from current settings', html: IC.plus, onclick: savePreset })));
    presetsPane.append(el('div', { class: 'cr-pgroup' }, 'Built-in'), ...RAW_PRESETS.map((p) => row(p, false)));
    const up = userPresets();
    presetsPane.append(el('div', { class: 'cr-pgroup' }, 'User Presets'));
    if (up.length) presetsPane.append(...up.map((p) => row(p, true)));
    else presetsPane.append(el('div', { class: 'cr-hint pad' }, 'No user presets yet. Use + to save the current settings.'));
  }
  // tiny live thumbnails: each preset rendered on a ~72 px copy of the image (main thread, a few ms total)
  let thumbSrc = null;
  const thumbFor = (p) => {
    if (!thumbSrc) {
      const k = Math.min(72 / FW, 48 / FH), c = createCanvas(Math.max(1, Math.round(FW * k)), Math.max(1, Math.round(FH * k)));
      const g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(prevC, 0, 0, c.width, c.height);
      const id = g.getImageData(0, 0, c.width, c.height); thumbSrc = { data: id.data, width: id.width, height: id.height };
    }
    const cv = el('canvas', { class: 'cr-pthumb', width: thumbSrc.width, height: thumbSrc.height });
    try {
      const st = p.auto ? mergeRawSettings(S, autoRawSettings(thumbSrc)) : mergeRawSettings(S, p.settings);
      const o = applyCameraRaw(thumbSrc, st, { scale: thumbSrc.width / FW });
      ctx2d(cv).putImageData(new ImageData(o.data, o.width, o.height), 0, 0);
    } catch (e) { /* thumbnail is cosmetic */ }
    return cv;
  };
  function showPane(which) {
    scroll.classList.toggle('hidden', which !== 'edit'); presetsPane.classList.toggle('hidden', which !== 'presets');
    rail.querySelectorAll('[data-id=edit],[data-id=presets]').forEach((x) => x.classList.toggle('on', x.dataset.id === which));
    if (which === 'presets') buildPresets();
  }

  // ---------------------------------------------------------------- rendering requests
  async function request() {
    if (closed) return;
    if (busy) { queued = true; return; }
    busy = true; queued = false; spinner.classList.toggle('hidden', false);
    const myRev = rev;
    const which = dragging && lastMs > 70 ? 'draft' : 'preview';
    const view = altView === 'sharpMask' ? 'sharpenMask' : undefined;
    try {
      const r = await client.call('preview', { settings: effective(), which, view });
      if (closed) return;
      lastMs = which === 'draft' ? Math.max(lastMs, r.ms * 2.5) : r.ms;
      if (which === 'preview' || !queued) {
        const id = new ImageData(new Uint8ClampedArray(r.data.buffer || r.data), r.width, r.height);
        if (afterC.width !== r.width || afterC.height !== r.height) { afterC.width = r.width; afterC.height = r.height; }
        ctx2d(afterC).putImageData(id, 0, 0); afterData = id;
        if (!view) { hist = r.hist; drawHisto(); if (curveRedraw && ui.open.curve) curveRedraw(); }
        clipCache = null; altCache = null;
        draw();
      }
      busy = false;
      if (queued || rev !== myRev || (which === 'draft' && !dragging)) { request(); return; }
      spinner.classList.add('hidden');
      scheduleRegion();
    } catch (e) {
      busy = false; spinner.classList.add('hidden');
      if (!closed) { console.warn(e); toast('Camera Raw preview failed: ' + e.message, 'err', 4000); }
    }
  }
  let regionTimer = 0;
  function scheduleRegion() { clearTimeout(regionTimer); regionTimer = setTimeout(renderRegion, 90); }
  function neededRegion() {
    const z = curZoom();
    if (z <= prevScale * 1.4 && !(altView === 'sharpMask')) return null;
    const panes = paneRects(); let vr = null;
    for (const p of panes) {
      const T = paneTransform(p);
      const x0 = clamp(Math.floor((p.x - T.ox) / T.z) - 2, 0, FW), y0 = clamp(Math.floor((p.y - T.oy) / T.z) - 2, 0, FH);
      const x1 = clamp(Math.ceil((p.x + p.w - T.ox) / T.z) + 2, 0, FW), y1 = clamp(Math.ceil((p.y + p.h - T.oy) / T.z) + 2, 0, FH);
      if (x1 <= x0 || y1 <= y0) continue;
      vr = vr ? { x: Math.min(vr.x, x0), y: Math.min(vr.y, y0), x1: Math.max(vr.x1, x1), y1: Math.max(vr.y1, y1) } : { x: x0, y: y0, x1, y1 };
    }
    if (!vr) return null;
    const w = vr.x1 - vr.x, h = vr.y1 - vr.y;
    if (w * h > 3.2e6) return null;
    return { x: vr.x, y: vr.y, width: w, height: h };
  }
  async function renderRegion() {
    if (closed || busy || regionBusy) return;
    const rect = neededRegion();
    if (!rect) { if (region) { region = null; draw(); } return; }
    if (region && region.rev === rev && region.x <= rect.x && region.y <= rect.y && region.x + region.w >= rect.x + rect.width && region.y + region.h >= rect.y + rect.height && region.view === altView) return;
    regionBusy = true; const myRev = rev; spinner.classList.remove('hidden');
    try {
      const r = await client.call('region', { settings: effective(), rect, view: altView === 'sharpMask' ? 'sharpenMask' : undefined });
      if (closed) return;
      const c = region && region.canvas.width === r.width && region.canvas.height === r.height ? region.canvas : createCanvas(r.width, r.height);
      const id = new ImageData(new Uint8ClampedArray(r.data.buffer || r.data), r.width, r.height);
      ctx2d(c).putImageData(id, 0, 0);
      region = { canvas: c, data: id, x: r.x, y: r.y, w: r.width, h: r.height, rev: myRev, view: altView, clip: null };
      draw();
    } catch (e) { console.warn('region render failed', e); }
    regionBusy = false; spinner.classList.add('hidden');
    if (rev !== myRev || !busy) { const nr = neededRegion(); if (nr && (rev !== myRev || !region || nr.x < region.x || nr.y < region.y || nr.x + nr.width > region.x + region.w || nr.y + nr.height > region.y + region.h)) scheduleRegion(); }
  }

  // ---------------------------------------------------------------- view geometry + drawing
  const dpr = () => window.devicePixelRatio || 1;
  function paneRects() {
    const W = canvas.width, H = canvas.height, gap = Math.round(4 * dpr());
    if (mode === 'side') return [{ x: 0, y: 0, w: (W - gap) / 2, h: H, which: 'before' }, { x: (W + gap) / 2, y: 0, w: (W - gap) / 2, h: H, which: 'after' }];
    if (mode === 'topbot') return [{ x: 0, y: 0, w: W, h: (H - gap) / 2, which: 'before' }, { x: 0, y: (H + gap) / 2, w: W, h: (H - gap) / 2, which: 'after' }];
    return [{ x: 0, y: 0, w: W, h: H, which: mode === 'split' ? 'split' : showBefore ? 'before' : 'after' }];
  }
  const fitZoomFor = (p, fill) => { const pad = 16 * dpr(); const z = (fill ? Math.max : Math.min)((p.w - pad * 2) / FW, (p.h - pad * 2) / FH); return Math.max(0.005, z); };
  function curZoom() { if (view.fit === true) return fitZoomFor(paneRects()[0]); if (view.fit === 'fill') return fitZoomFor(paneRects()[0], true); return view.zoom; }
  function paneTransform(p) {
    const z = curZoom();
    const fitted = view.fit === true || (FW * z <= p.w && FH * z <= p.h);
    const cx = fitted ? FW / 2 : clamp(view.cx, Math.min(FW / 2, p.w / 2 / z), Math.max(FW / 2, FW - p.w / 2 / z));
    const cy = fitted ? FH / 2 : clamp(view.cy, Math.min(FH / 2, p.h / 2 / z), Math.max(FH / 2, FH - p.h / 2 / z));
    return { z, ox: p.x + p.w / 2 - cx * z, oy: p.y + p.h / 2 - cy * z, cx, cy };
  }
  let checker = null;
  function checkerPattern() {
    if (checker) return checker;
    const c = createCanvas(16, 16), g = ctx2d(c); g.fillStyle = '#cfcfcf'; g.fillRect(0, 0, 16, 16); g.fillStyle = '#fff'; g.fillRect(0, 0, 8, 8); g.fillRect(8, 8, 8, 8);
    return (checker = vctx.createPattern(c, 'repeat'));
  }
  let clipCache = null, altCache = null;
  function clipOverlay(id) {
    const c = createCanvas(id.width, id.height), g = ctx2d(c), o = g.createImageData(id.width, id.height), d = id.data, od = o.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      if (clipHi && d[i] >= 255 && d[i + 1] >= 255 && d[i + 2] >= 255) { od[i] = 255; od[i + 3] = 255; }
      else if (clipHi && (d[i] >= 255 || d[i + 1] >= 255 || d[i + 2] >= 255)) { od[i] = 255; od[i + 1] = 60; od[i + 2] = 60; od[i + 3] = 150; }
      else if (clipLo && d[i] <= 0 && d[i + 1] <= 0 && d[i + 2] <= 0) { od[i + 2] = 255; od[i + 1] = 60; od[i + 3] = 255; }
    }
    g.putImageData(o, 0, 0); return c;
  }
  function altThreshold(id, kind) {
    const c = createCanvas(id.width, id.height), g = ctx2d(c), o = g.createImageData(id.width, id.height), d = id.data, od = o.data;
    for (let i = 0; i < d.length; i += 4) {
      if (kind === 'hi') { od[i] = d[i] >= 254 ? 255 : 0; od[i + 1] = d[i + 1] >= 254 ? 255 : 0; od[i + 2] = d[i + 2] >= 254 ? 255 : 0; }
      else { od[i] = d[i] <= 1 ? 0 : 255; od[i + 1] = d[i + 1] <= 1 ? 0 : 255; od[i + 2] = d[i + 2] <= 1 ? 0 : 255; }
      od[i + 3] = 255;
    }
    g.putImageData(o, 0, 0); return c;
  }
  function drawImageAt(g, img, T, sx, sy, sw, sh, dxF, dyF, dwF, dhF) {
    // draw `img` (covering full-res rect dxF,dyF,dwF,dhF) under transform T
    g.drawImage(img, sx, sy, sw, sh, T.ox + dxF * T.z, T.oy + dyF * T.z, dwF * T.z, dhF * T.z);
  }
  function drawPane(p, which) {
    const g = vctx, T = paneTransform(p);
    g.save(); g.beginPath(); g.rect(p.x, p.y, p.w, p.h); g.clip();
    const ix = T.ox, iy = T.oy, iw = FW * T.z, ih = FH * T.z;
    g.fillStyle = checkerPattern(); g.fillRect(ix, iy, iw, ih);
    g.imageSmoothingEnabled = T.z < 2; g.imageSmoothingQuality = 'high';
    const drawSide = (w, clipR) => {
      g.save();
      if (clipR) { g.beginPath(); g.rect(clipR.x, clipR.y, clipR.w, clipR.h); g.clip(); }
      if (w === 'before') {
        if (T.z > prevScale * 1.2) g.drawImage(srcCanvas, ix, iy, iw, ih); else g.drawImage(prevC, ix, iy, iw, ih);
      } else {
        let src = afterC;
        if (altView === 'hi' || altView === 'lo') src = altCache && altCache.kind === altView ? altCache.c : (altCache = { kind: altView, c: altThreshold(afterData, altView) }).c;
        g.drawImage(src, ix, iy, iw, ih);
        if (region && region.rev === rev && region.view === altView && !(altView === 'hi' || altView === 'lo')) drawImageAt(g, region.canvas, T, 0, 0, region.w, region.h, region.x, region.y, region.w, region.h);
        if ((clipHi || clipLo) && !altView) {
          if (!clipCache) clipCache = clipOverlay(afterData);
          g.drawImage(clipCache, ix, iy, iw, ih);
          if (region && region.rev === rev && T.z > prevScale * 1.4) { if (!region.clip) region.clip = clipOverlay(region.data); drawImageAt(g, region.clip, T, 0, 0, region.w, region.h, region.x, region.y, region.w, region.h); }
        }
      }
      g.restore();
    };
    if (which === 'split') {
      const sx = ix + iw * splitPos;
      drawSide('before', { x: p.x, y: p.y, w: sx - p.x, h: p.h });
      drawSide('after', { x: sx, y: p.y, w: p.x + p.w - sx, h: p.h });
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 * dpr(); g.beginPath(); g.moveTo(sx, Math.max(p.y, iy)); g.lineTo(sx, Math.min(p.y + p.h, iy + ih)); g.stroke();
      g.fillStyle = '#fff'; g.beginPath(); g.arc(sx, clamp(iy + ih / 2, p.y + 20, p.y + p.h - 20), 6 * dpr(), 0, Math.PI * 2); g.fill();
    } else drawSide(which);
    if (showGrid && which !== 'before') {
      g.strokeStyle = 'rgba(255,255,255,.28)'; g.lineWidth = 1; const n = 12;
      for (let i = 1; i < n; i++) { const x = Math.round(ix + iw * i / n) + 0.5, y = Math.round(iy + ih * i / n) + 0.5; g.beginPath(); g.moveTo(x, iy); g.lineTo(x, iy + ih); g.moveTo(ix, y); g.lineTo(ix + iw, y); g.stroke(); }
    }
    g.restore();
    return T;
  }
  function draw() {
    if (closed) return;
    const g = vctx;
    g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, canvas.width, canvas.height);
    const panes = paneRects();
    for (const p of panes) drawPane(p, p.which);
    // badges
    const z = curZoom();
    badgeL.classList.add('hidden'); badgeR.classList.add('hidden');
    if (mode === 'side' || mode === 'topbot' || mode === 'split') { badgeL.textContent = 'Before'; badgeR.textContent = 'After'; badgeL.classList.remove('hidden'); badgeR.classList.remove('hidden'); root.dataset.mode = mode; }
    else if (showBefore) { badgeL.textContent = 'Before'; badgeL.classList.remove('hidden'); root.dataset.mode = 'single'; }
    else root.dataset.mode = 'single';
    zoomLbl.textContent = (Math.round(z * 1000) / 10) + '%';
    zoomSel.value = view.fit === true ? 'fit' : view.fit === 'fill' ? 'fill' : ([...zoomSel.options].find((o) => Math.abs(Number(o.value) - z) < 0.002)?.value || zoomSel.value);
    modes.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    modes.querySelector('[data-id=before]').classList.toggle('on', showBefore);
    if (detailWarn) detailWarn.classList.toggle('hidden', z >= 0.99);
    const nr = neededRegion();
    if (nr && (!region || region.rev !== rev)) scheduleRegion();
  }
  function drawHisto() {
    const g = histC.getContext('2d'), W = histC.width, H = histC.height;
    g.clearRect(0, 0, W, H); g.fillStyle = '#1a1a1a'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#2c2c2c'; g.lineWidth = 1;
    for (let i = 1; i < 4; i++) { const x = Math.round(i * W / 4) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    if (!hist) return;
    const all = [];
    for (const k of ['r', 'g', 'b']) for (let i = 1; i < 255; i++) all.push(hist[k][i]);
    all.sort((a, b) => a - b);
    const mx = Math.max(1, all[Math.floor(all.length * 0.995)] * 1.1);
    g.globalCompositeOperation = 'lighter';
    const col = { r: 'rgba(225,60,60,.85)', g: 'rgba(60,200,80,.85)', b: 'rgba(70,110,255,.9)' };
    for (const k of ['r', 'g', 'b']) {
      g.fillStyle = col[k]; g.beginPath(); g.moveTo(0, H);
      for (let i = 0; i < 256; i++) { const v = Math.min(1, hist[k][i] / mx); g.lineTo(i / 255 * W, H - v * (H - 4)); }
      g.lineTo(W, H); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    const tot = hist.l.reduce((a, b) => a + b, 0) || 1;
    const cl = (i) => ['r', 'g', 'b'].map((k) => hist[k][i] / tot > 0.0003);
    const colorOf = ([r, gg, b]) => (r && gg && b ? '#fff' : r || gg || b ? `rgb(${r ? 235 : 40},${gg ? 220 : 40},${b ? 255 : 40})` : '#4a4a4a');
    triLo.style.setProperty('--c', colorOf(cl(0))); triHi.style.setProperty('--c', colorOf(cl(255)));
    triLo.classList.toggle('on', clipLo); triHi.classList.toggle('on', clipHi);
  }

  // ---------------------------------------------------------------- view interaction
  function setMode(m) { mode = m; if (m !== 'single') showBefore = false; region = null; draw(); scheduleRegion(); }
  function toggleBefore() { if (mode !== 'single') { mode = 'single'; showBefore = true; } else showBefore = !showBefore; draw(); }
  function cycleMode() { const order = ['single', 'side', 'split', 'topbot']; setMode(order[(order.indexOf(mode) + 1) % order.length]); }
  function fitView() { view.fit = true; region = null; draw(); }
  function fillView() { view.fit = 'fill'; view.cx = FW / 2; view.cy = FH / 2; draw(); }
  function zoomTo(z, at) {
    const old = curZoom(), p = paneRects()[0], T = paneTransform(p);
    let fx = view.fit ? FW / 2 : view.cx, fy = view.fit ? FH / 2 : view.cy;
    if (at) { // keep the full-res point under the cursor fixed
      const px = (at.x - T.ox) / T.z, py = (at.y - T.oy) / T.z, nz = z;
      fx = px - (at.x - p.x - p.w / 2) / nz; fy = py - (at.y - p.y - p.h / 2) / nz;
    } else if (view.fit) { fx = T.cx; fy = T.cy; }
    void old;
    view = { fit: false, zoom: clamp(z, 0.02, 16), cx: fx, cy: fy };
    draw();
  }
  const STEPS = [0.0625, 0.125, 0.25, 0.333, 0.5, 0.667, 1, 2, 3, 4, 6, 8, 12, 16];
  function zoomStep(d, at) { const z = curZoom(); const nz = d > 0 ? STEPS.find((s) => s > z * 1.01) || 16 : [...STEPS].reverse().find((s) => s < z * 0.99) || 0.0625; zoomTo(nz, at); }
  function setTool(t) { tool = t; wbTool = false; rail.querySelectorAll('[data-id=zoom],[data-id=hand]').forEach((x) => x.classList.toggle('on', x.dataset.id === t)); updateCursor(); syncAll(); }
  function setWBTool(on) { wbTool = on; updateCursor(); syncAll(); }
  function updateCursor() { viewEl.style.cursor = wbTool ? 'crosshair' : spaceDown || tool === 'hand' ? (curZoom() > fitZoomFor(paneRects()[0]) * 1.01 ? 'grab' : 'zoom-in') : tool === 'zoom' ? (altDown ? 'zoom-out' : 'zoom-in') : 'default'; }
  const evPos = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * dpr(), y: (e.clientY - r.top) * dpr() }; };
  const paneAt = (pt) => paneRects().find((p) => pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y && pt.y <= p.y + p.h) || paneRects()[0];
  canvas.addEventListener('pointerdown', (e) => {
    if (rendering || e.button !== 0) return;
    const pt = evPos(e), p = paneAt(pt), T = paneTransform(p);
    if (wbTool) {
      const fx = (pt.x - T.ox) / T.z, fy = (pt.y - T.oy) / T.z;
      if (fx < 0 || fy < 0 || fx >= FW || fy >= FH) return;
      const d = prevData.data, pw = prevData.width, ph = prevData.height, cx = Math.floor(fx * prevScale), cy = Math.floor(fy * prevScale);
      let r = 0, gg = 0, b = 0, n = 0;
      for (let y = Math.max(0, cy - 2); y <= Math.min(ph - 1, cy + 2); y++) for (let x = Math.max(0, cx - 2); x <= Math.min(pw - 1, cx + 2); x++) { const i = (y * pw + x) * 4; r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
      const wb = neutralWhiteBalance(r / n, gg / n, b / n);
      S.wb = 'custom'; S.temperature = wb.temperature; S.tint = wb.tint; syncAll(); changed();
      return;
    }
    if (mode === 'split') {
      const sx = T.ox + FW * T.z * splitPos;
      if (Math.abs(pt.x - sx) < 10 * dpr()) {
        canvas.setPointerCapture(e.pointerId);
        const mv = (ev) => { const q = evPos(ev); splitPos = clamp((q.x - T.ox) / (FW * T.z), 0, 1); draw(); };
        const up = () => { canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up); };
        canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerup', up);
        return;
      }
    }
    if (tool === 'zoom' && !spaceDown) { if (e.altKey) zoomStep(-1, pt); else zoomStep(1, pt); return; }
    // hand: drag pans; a click without drag toggles Fit <-> 100% (like Camera Raw)
    canvas.setPointerCapture(e.pointerId);
    const x0 = e.clientX, y0 = e.clientY, c0 = { x: T.cx, y: T.cy }; let moved = false;
    if (view.fit) view = { fit: false, zoom: curZoom(), cx: T.cx, cy: T.cy };
    viewEl.style.cursor = 'grabbing';
    const mv = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!moved && Math.hypot(dx, dy) < 3) return; moved = true;
      view.cx = c0.x - dx * dpr() / T.z; view.cy = c0.y - dy * dpr() / T.z; draw();
    };
    const up = () => {
      canvas.removeEventListener('pointermove', mv); canvas.removeEventListener('pointerup', up);
      if (!moved) { if (curZoom() > fitZoomFor(paneRects()[0]) * 1.01) fitView(); else zoomTo(1, pt); }
      else { const q = paneTransform(p); view.cx = q.cx; view.cy = q.cy; draw(); }
      updateCursor();
    };
    canvas.addEventListener('pointermove', mv); canvas.addEventListener('pointerup', up);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = evPos(e);
    if (e.ctrlKey || e.altKey || e.metaKey) { const z = curZoom() * Math.pow(1.0015, -e.deltaY); zoomTo(z, pt); return; }
    if (view.fit === true) return;
    const T = paneTransform(paneAt(pt)); view.cx = T.cx + e.deltaX * dpr() / T.z * (e.shiftKey ? 0 : 1) + (e.shiftKey ? e.deltaY * dpr() / T.z : 0); view.cy = T.cy + (e.shiftKey ? 0 : e.deltaY * dpr() / T.z); draw();
  }, { passive: false });
  canvas.addEventListener('pointermove', (e) => {
    const pt = evPos(e), T = paneTransform(paneAt(pt));
    const fx = Math.floor((pt.x - T.ox) / T.z), fy = Math.floor((pt.y - T.oy) / T.z);
    const vals = readout.querySelectorAll('b');
    if (fx < 0 || fy < 0 || fx >= FW || fy >= FH) { vals.forEach((v) => v.textContent = '–'); return; }
    let px = null;
    if (region && region.rev === rev && fx >= region.x && fy >= region.y && fx < region.x + region.w && fy < region.y + region.h) { const i = ((fy - region.y) * region.w + (fx - region.x)) * 4; px = region.data.data.subarray(i, i + 3); }
    else { const ax = Math.min(afterData.width - 1, Math.floor(fx * afterData.width / FW)), ay = Math.min(afterData.height - 1, Math.floor(fy * afterData.height / FH)); const i = (ay * afterData.width + ax) * 4; px = afterData.data.subarray(i, i + 3); }
    vals[0].textContent = px[0]; vals[1].textContent = px[1]; vals[2].textContent = px[2];
  });
  canvas.addEventListener('pointerleave', () => readout.querySelectorAll('b').forEach((v) => v.textContent = '–'));
  const ro = new ResizeObserver(() => {
    const r = viewEl.getBoundingClientRect(), d = dpr();
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; checker = null; draw(); }
    const hr = histC.getBoundingClientRect(); if (hr.width && Math.round(hr.width * d) !== histC.width) { histC.width = Math.round(hr.width * d); histC.height = Math.round(hr.height * d); drawHisto(); }
  });

  // ---------------------------------------------------------------- keyboard
  const typing = (e) => { const t = e.target; return t && ((t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'); };
  function onKey(e, m) {
    if ((app?.modalOpen || 0) > myLevel) return true; // a nested dialog (e.g. preset name) owns the keyboard
    if (rendering) { e.preventDefault(); e.stopPropagation(); return true; }
    if (e.key === 'Alt') { setAlt(true); e.preventDefault(); return true; }
    if (e.key === 'Enter' && !typing(e)) { e.preventDefault(); e.stopPropagation(); commitOK(); return true; }
    if (e.key === 'Escape') {
      if (typing(e)) { e.target.blur(); e.preventDefault(); e.stopPropagation(); return true; }
      if (wbTool) { setWBTool(false); e.stopPropagation(); return true; }
      return false;
    }
    if (typing(e)) return true;
    const k = e.key.toLowerCase(), ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl && k === 'z') doUndo(e.shiftKey ? 1 : -1);
    else if (ctrl && k === 'y') doUndo(1);
    else if (ctrl && k === 'u') { if (e.shiftKey) doAutoWB(); else doAuto(); }
    else if (ctrl && (k === '0')) { if (e.altKey) zoomTo(1); else fitView(); }
    else if (ctrl && k === '1') zoomTo(1);
    else if (ctrl && (k === '=' || k === '+')) zoomStep(1);
    else if (ctrl && (k === '-' || k === '_')) zoomStep(-1);
    else if (ctrl) handled = false;
    else if (k === '\\' || k === 'p') { if (e.shiftKey && k === 'p') showPane('presets'); else toggleBefore(); }
    else if (k === 'q' || k === 'y') cycleMode();
    else if (k === 'u') { clipLo = !clipLo; clipCache = null; region && (region.clip = null); drawHisto(); draw(); }
    else if (k === 'o') { clipHi = !clipHi; clipCache = null; region && (region.clip = null); drawHisto(); draw(); }
    else if (k === 'z') setTool('zoom');
    else if (k === 'h') setTool('hand');
    else if (k === 'i') setWBTool(!wbTool);
    else if (k === 'v') toggleBW();
    else if (k === 'e') showPane('edit');
    else if (k === ' ') { if (!spaceDown) { spaceDown = true; updateCursor(); } }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    return true; // never let other modal defaults run for plain keys
  }
  function setAlt(v) { if (altDown === v) return; altDown = v; cancelBtn.textContent = v ? 'Reset' : 'Cancel'; cancelBtn.classList.toggle('reset', v); updateCursor(); }
  const keyup = (e) => { if (e.key === 'Alt') setAlt(false); if (e.key === ' ') { spaceDown = false; updateCursor(); } };
  const blur = () => { setAlt(false); spaceDown = false; };

  // ---------------------------------------------------------------- OK (full-res render)
  let resolveResult = null;
  async function commitOK() {
    if (rendering) return;
    rendering = true; okBtn.disabled = true; cancelBtn.disabled = true;
    progressBox.classList.remove('hidden'); const bar = progressBox.querySelector('.bar span'); bar.style.width = '0%';
    const settings = normalizeRawSettings(effective());
    try {
      const t0 = performance.now();
      const r = await client.call('full', { settings }, (f) => { bar.style.width = Math.round(f * 100) + '%'; });
      const data = new Uint8ClampedArray(r.data.buffer || r.data);
      resolveResult = { imageData: new ImageData(data, r.width, r.height), settings };
      void t0;
      api.close(true);
    } catch (e) {
      rendering = false; okBtn.disabled = false; cancelBtn.disabled = false; progressBox.classList.add('hidden');
      toast('Camera Raw failed: ' + e.message, 'err', 6000);
    }
  }

  // ---------------------------------------------------------------- open
  const myLevel = (app?.modalOpen || 0) + 1;
  rebuildEdit(); showPane('edit'); setTool('hand');
  const res = await modal({
    title: 'Camera Raw Filter', body: root, className: 'cr', buttons: [{ node: footLeft }, '-', { node: cancelBtn }, { node: okBtn }],
    onOpen: (a) => {
      api = a;
      addEventListener('keyup', keyup, true); addEventListener('blur', blur);
      ro.observe(viewEl); ro.observe(histC);
      setTimeout(() => { if (document.activeElement && api.box.contains(document.activeElement)) document.activeElement.blur(); viewEl.focus({ preventScroll: true }); }, 40);
      requestAnimationFrame(() => { draw(); request(); });
    },
    onKey,
  });
  closed = true;
  ro.disconnect(); removeEventListener('keyup', keyup, true); removeEventListener('blur', blur);
  clearTimeout(regionTimer);
  client.close();
  if (!res || !resolveResult) return null;
  return resolveResult;
}

function hsv(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0]; else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c]; else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
