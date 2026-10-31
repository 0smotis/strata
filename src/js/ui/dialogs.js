// Dialogs: New, Image Size, Canvas Size, filters, adjustments, Liquify, Layer Style, Color Picker, Preferences, Export
import { app, cmd } from '../state.js';
import { el, $, $$, createCanvas, ctx2d, cloneCanvas, clamp, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, rgbToLab, rgbToCmyk, debounce } from '../util.js';
import { ICONS } from '../icons.js';
import { modal, sliderRow, selectEl, checkEl, colorEl, numField, toast, withBusy } from './common.js';
import { FILTERS } from '../engine/filters.js';
import { defaultParams, applyAdjustment } from '../engine/adjust.js';
import { renderAdjustmentUI } from './adjui.js';
import { BLEND_MODES } from '../doc/blend.js';
import { DEFAULT_EFFECTS } from '../doc/document.js';
import { requestDraw } from '../view/viewport.js';

// ---------- New Document ----------
const PRESETS = {
  Recent: [],
  Photo: [['Landscape, 6 × 4 in', 1800, 1200, 300], ['Portrait, 4 × 6 in', 1200, 1800, 300], ['Landscape, 7 × 5 in', 2100, 1500, 300], ['Square, 5 × 5 in', 1500, 1500, 300], ['Landscape, 10 × 8 in', 3000, 2400, 300], ['Default Strata Size', 2100, 1500, 300]],
  Print: [['Letter', 2550, 3300, 300], ['Legal', 2550, 4200, 300], ['Tabloid', 3300, 5100, 300], ['A4', 2480, 3508, 300], ['A3', 3508, 4961, 300], ['A5', 1748, 2480, 300]],
  'Art & Illustration': [['Art Board 4K', 3840, 2160, 72], ['Comic Page', 1988, 3075, 300], ['Poster', 5400, 7200, 300], ['Grid 1000', 1000, 1000, 72]],
  'Web': [['Web Large', 1920, 1080, 72], ['Web Medium', 1440, 900, 72], ['Web Minimum', 1024, 768, 72], ['MacBook Pro 16', 3456, 2234, 72], ['Banner 728 × 90', 728, 90, 72]],
  'Mobile': [['iPhone 15 Pro', 1179, 2556, 72], ['Android 1080p', 1080, 1920, 72], ['iPad Pro 12.9', 2048, 2732, 72], ['Instagram Post', 1080, 1080, 72], ['Instagram Story', 1080, 1920, 72], ['YouTube Thumbnail', 1280, 720, 72]],
  'Film & Video': [['HDTV 1080p', 1920, 1080, 72], ['UHD 4K', 3840, 2160, 72], ['HDV 720p', 1280, 720, 72], ['DCI 4K', 4096, 2160, 72]],
};
export async function newDocDialog() {
  let recent = []; try { recent = JSON.parse(localStorage.getItem('strata.recentSizes') || '[]'); } catch {}
  PRESETS.Recent = recent.length ? recent : [['Default Strata Size', 2100, 1500, 300], ['Web Large', 1920, 1080, 72], ['Instagram Post', 1080, 1080, 72]];
  let cat = 'Recent';
  const name = el('input', { type: 'text', value: 'Untitled-' + (app.docs.length + 1) });
  const W = el('input', { type: 'number', value: 2100, min: 1, max: 30000 }), H = el('input', { type: 'number', value: 1500, min: 1, max: 30000 }), R = el('input', { type: 'number', value: 300, min: 1, max: 9999 });
  const bg = selectEl([['#ffffff', 'White'], ['#000000', 'Black'], ['bg', 'Background Color'], ['transparent', 'Transparent']], '#ffffff');
  const tabs = el('div', { class: 'tabsx' }), grid = el('div', { class: 'presets' });
  const draw = () => {
    tabs.innerHTML = ''; grid.innerHTML = '';
    for (const c of Object.keys(PRESETS)) tabs.append(el('span', { class: c === cat ? 'on' : '', onclick: () => { cat = c; draw(); } }, c));
    for (const [n, w, h, r] of PRESETS[cat]) {
      const s = 70 / Math.max(w, h);
      const card = el('div', { class: 'pre' }, el('div', { style: { height: '72px', display: 'grid', placeItems: 'center' } }, el('div', { class: 'shape', style: { width: w * s + 'px', height: h * s + 'px' } })), el('span', {}, n), el('small', {}, `${w} × ${h} px @ ${r} ppi`));
      card.onclick = () => { W.value = w; H.value = h; R.value = r; $$('.pre', grid).forEach(x => x.classList.remove('on')); card.classList.add('on'); };
      card.ondblclick = () => { card.onclick(); api.close(val()); };
      grid.append(card);
    }
  };
  let api;
  const swap = el('button', { class: 'ibtn', title: 'Swap width and height', html: ICONS.rotate, onclick: () => { const t = W.value; W.value = H.value; H.value = t; } });
  const side = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    el('div', { style: { fontWeight: 600 } }, 'Preset Details'), name,
    el('div', { class: 'row' }, el('label', {}, 'Width'), W, el('span', { class: 'muted' }, 'Pixels')),
    el('div', { class: 'row' }, el('label', {}, 'Height'), H, swap),
    el('div', { class: 'row' }, el('label', {}, 'Resolution'), R, el('span', { class: 'muted' }, 'Pixels/Inch')),
    el('div', { class: 'row' }, el('label', {}, 'Color Mode'), selectEl([['rgb', 'RGB Color'], ['gray', 'Grayscale']], 'rgb'), selectEl([['8', '8 bit']], '8')),
    el('div', { class: 'row' }, el('label', {}, 'Background'), bg));
  const body = el('div', { class: 'newdoc' }, el('div', {}, tabs, grid), side);
  draw();
  const val = () => {
    const w = clamp(Math.round(Number(W.value)), 1, 30000), h = clamp(Math.round(Number(H.value)), 1, 30000), r = Number(R.value) || 72;
    try { const rs = [['Custom', w, h, r], ...recent.filter(x => !(x[1] === w && x[2] === h))].slice(0, 9); localStorage.setItem('strata.recentSizes', JSON.stringify(rs)); } catch {}
    return { name: name.value || 'Untitled', width: w, height: h, resolution: r, background: bg.value === 'bg' ? app.bg : bg.value };
  };
  for (const i of [name, W, H, R]) i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); };
  return modal({ title: 'New Document', body, onOpen: (a) => api = a, buttons: [{ label: 'Close', value: null }, { label: 'Create', value: val, primary: true }] });
}

// ---------- Image Size ----------
export async function imageSizeDialog(doc) {
  const ratio = doc.width / doc.height;
  let constrain = true;
  const W = el('input', { type: 'number', value: doc.width, min: 1 }), H = el('input', { type: 'number', value: doc.height, min: 1 });
  const unit = selectEl([['px', 'Pixels'], ['pct', 'Percent']], 'px', (v) => { if (v === 'pct') { W.value = 100; H.value = 100; } else { W.value = doc.width; H.value = doc.height; } });
  const R = el('input', { type: 'number', value: doc.resolution });
  const res = selectEl([['auto', 'Automatic'], ['preserve', 'Preserve Details (enlargement)'], ['bicubicSmoother', 'Bicubic Smoother (enlargement)'], ['bicubicSharper', 'Bicubic Sharper (reduction)'], ['bicubic', 'Bicubic (smooth gradients)'], ['nearest', 'Nearest Neighbor (hard edges)'], ['bilinear', 'Bilinear']], 'auto');
  const resample = checkEl('Resample', true);
  const info = el('div', { class: 'muted' });
  const upd = () => { const [w, h] = vals(); info.textContent = `Image Size: ${(w * h * 4 / 1048576).toFixed(1)}M  (was ${(doc.width * doc.height * 4 / 1048576).toFixed(1)}M)  ·  ${w} × ${h} px`; };
  const vals = () => unit.value === 'pct' ? [Math.round(doc.width * W.value / 100), Math.round(doc.height * H.value / 100)] : [Math.round(Number(W.value)), Math.round(Number(H.value))];
  W.oninput = () => { if (constrain) H.value = unit.value === 'pct' ? W.value : Math.round(W.value / ratio); upd(); };
  H.oninput = () => { if (constrain) W.value = unit.value === 'pct' ? H.value : Math.round(H.value * ratio); upd(); };
  const link = el('button', { class: 'ibtn on', title: 'Constrain aspect ratio', html: ICONS.link, onclick: () => { constrain = !constrain; link.classList.toggle('on', constrain); } });
  for (const i of [W, H, R]) i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); };
  upd();
  const body = el('div', {}, info, el('div', { class: 'row' }, el('label', {}, 'Fit To:'), selectEl([['orig', 'Original Size'], ['1920', '1920 × 1080'], ['1280', '1280 × 720'], ['1024', '1024 × 768'], ['800', '800 × 600'], ['640', '640 × 480']], 'orig', (v) => { const m = { orig: [doc.width, doc.height], 1920: [1920, 1080], 1280: [1280, 720], 1024: [1024, 768], 800: [800, 600], 640: [640, 480] }[v]; unit.value = 'px'; const s = Math.min(m[0] / doc.width, m[1] / doc.height); W.value = Math.round(doc.width * (v === 'orig' ? 1 : s)); H.value = Math.round(doc.height * (v === 'orig' ? 1 : s)); upd(); })),
    el('div', { class: 'row' }, el('label', {}, 'Width:'), W, unit, link), el('div', { class: 'row' }, el('label', {}, 'Height:'), H),
    el('div', { class: 'row' }, el('label', {}, 'Resolution:'), R, el('span', { class: 'muted' }, 'Pixels/Inch')), el('div', { class: 'row' }, resample, res));
  const r = await modal({ title: 'Image Size', body, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => { const [w, h] = vals(); return { width: w, height: h, resolution: Number(R.value) || doc.resolution, method: resample.input.checked ? res.value : 'none' }; } }] });
  return r;
}

// ---------- Canvas Size ----------
export async function canvasSizeDialog(doc) {
  let anchor = [1, 1], rel = false;
  const W = el('input', { type: 'number', value: doc.width }), H = el('input', { type: 'number', value: doc.height });
  const relC = checkEl('Relative', false, (v) => { rel = v; W.value = v ? 0 : doc.width; H.value = v ? 0 : doc.height; });
  const grid = el('div', { class: 'anchor-grid' });
  const drawGrid = () => { grid.innerHTML = ''; for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) grid.append(el('div', { class: x === anchor[0] && y === anchor[1] ? 'on' : '', onclick: () => { anchor = [x, y]; drawGrid(); } })); };
  drawGrid();
  const ext = selectEl([['bg', 'Background'], ['fg', 'Foreground'], ['#ffffff', 'White'], ['#000000', 'Black'], ['#808080', 'Gray']], 'bg');
  for (const i of [W, H]) i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); };
  const body = el('div', {}, el('div', { class: 'muted' }, `Current Size: ${doc.width} × ${doc.height} px`), el('div', { class: 'row' }, el('label', {}, 'Width:'), W, el('span', { class: 'muted' }, 'Pixels')), el('div', { class: 'row' }, el('label', {}, 'Height:'), H, el('span', { class: 'muted' }, 'Pixels')), relC, el('div', { class: 'row' }, el('label', {}, 'Anchor:'), grid), el('div', { class: 'row' }, el('label', {}, 'Canvas extension color:'), ext));
  return modal({ title: 'Canvas Size', body, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => {
    const w = rel ? doc.width + Number(W.value) : Number(W.value), h = rel ? doc.height + Number(H.value) : Number(H.value);
    const nw = clamp(Math.round(w), 1, 30000), nh = clamp(Math.round(h), 1, 30000);
    return { width: nw, height: nh, ox: Math.round((nw - doc.width) * anchor[0] / 2), oy: Math.round((nh - doc.height) * anchor[1] / 2), color: ext.value === 'bg' ? app.bg : ext.value === 'fg' ? app.fg : ext.value };
  } }] });
}

// ---------- Filter dialog with live canvas preview ----------
function paramControl(spec, p, onInput, onChange) {
  const t = spec.type || 'range';
  if (t === 'select') return el('div', { class: 'row' }, el('label', {}, spec.label), selectEl(spec.options.map(o => [o.value, o.label]), p[spec.key], (v) => { p[spec.key] = isNaN(Number(v)) || typeof spec.default === 'string' ? v : Number(v); onChange(); }));
  if (t === 'checkbox') return checkEl(spec.label, p[spec.key], (v) => { p[spec.key] = v; onChange(); });
  if (t === 'color') return el('div', { class: 'row' }, el('label', {}, spec.label), colorEl(p[spec.key], (v) => { p[spec.key] = v; onChange(); }));
  return sliderRow({ label: spec.label, value: p[spec.key], min: spec.min ?? -180, max: spec.max ?? 180, step: spec.step || 1, unit: spec.unit || (t === 'angle' ? '°' : ''), onInput: (v) => { p[spec.key] = v; onInput(); }, onChange: (v) => { p[spec.key] = v; onChange(); } });
}

export async function filterDialog(key, params, runPreview) {
  const F = FILTERS[key];
  const p = { ...params };
  let previewOn = true;
  const body = el('div', { style: { minWidth: '420px' } });
  const doPreview = debounce(() => { if (previewOn) runPreview(p); }, 120);
  for (const spec of F.params) body.append(paramControl(spec, p, doPreview, doPreview));
  const prev = checkEl('Preview', true, (v) => { previewOn = v; runPreview(v ? p : null); });
  setTimeout(() => runPreview(p), 0);
  const r = await modal({ title: F.name.replace('…', ''), body, buttons: [{ node: prev }, '-', { label: 'Cancel', value: null }, { label: 'OK', value: () => p, primary: true }] });
  return r;
}

// Destructive adjustment dialog (Image › Adjustments)
export async function adjustmentDialog(type, runPreview, initial) {
  const fake = { data: { type, params: initial || defaultParams(type) }, clipped: false, visible: true, touch() {} };
  const w = el('div', { class: 'props', style: { width: '360px', padding: 0 } });
  const fakeDoc = app.doc;
  const preview = debounce(() => runPreview(fake.data.params), 60);
  renderAdjustmentUI(w, fakeDoc, fake, null, { live: preview, commit: () => {}, noHeader: true, noLayerButtons: true });
  setTimeout(() => runPreview(fake.data.params), 0);
  return modal({ title: (await import('./adjui.js')).adjName(type), body: w, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => fake.data.params, primary: true }] });
}

// ---------- Color Picker ----------
export async function colorPickerDialog(initial, title = 'Color Picker (Foreground Color)') {
  let { r, g, b } = hexToRgb(initial);
  let hsv = rgbToHsv(r, g, b);
  const sv = el('div', { class: 'sv' }), svc = el('div', { class: 'cur' }); sv.append(svc);
  const hue = el('div', { class: 'hue' }), hc = el('div', { class: 'cur' }); hue.append(hc);
  const newC = el('div'), oldC = el('div', { style: { background: initial }, title: 'Current — click to revert', onclick: () => { ({ r, g, b } = hexToRgb(initial)); hsv = rgbToHsv(r, g, b); upd(); } });
  const f = {}; const mk = (k, max) => { const i = el('input', { type: 'number', min: 0, max, style: { width: '52px' } }); i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); }; f[k] = i; return i; };
  const hex = el('input', { type: 'text', style: { width: '80px' } }); hex.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); };
  const lab = el('div', { class: 'muted' }), cmyk = el('div', { class: 'muted' });
  const fields = el('div', { class: 'fields' },
    el('label', {}, 'H:'), mk('h', 360), el('span', {}, '°'), el('label', {}, 'S:'), mk('s', 100), el('span', {}, '%'), el('label', {}, 'B:'), mk('v', 100), el('span', {}, '%'),
    el('label', {}, 'R:'), mk('r', 255), el('span'), el('label', {}, 'G:'), mk('g', 255), el('span'), el('label', {}, 'B:'), mk('b', 255), el('span'),
    el('label', {}, '#'), hex, el('span'));
  const webOnly = checkEl('Only Web Colors', false, () => upd());
  const swatch = el('div', { class: 'swatch2' }, el('div', { style: { height: '14px', textAlign: 'center', fontSize: '10px', color: 'var(--text2)' } }, 'new'), newC, oldC, el('div', { style: { height: '14px', textAlign: 'center', fontSize: '10px', color: 'var(--text2)' } }, 'current'));
  const body = el('div', { class: 'cpick' }, sv, hue, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, el('div', { style: { display: 'flex', gap: '12px' } }, swatch, fields), lab, cmyk, webOnly));
  const upd = (fromHsv) => {
    if (fromHsv) ({ r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v));
    if (webOnly.input.checked) { [r, g, b] = [r, g, b].map(v => Math.round(v / 51) * 51); }
    sv.style.background = `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h},100%,50%))`;
    svc.style.left = hsv.s / 100 * 256 + 'px'; svc.style.top = (1 - hsv.v / 100) * 256 + 'px'; hc.style.top = (1 - hsv.h / 360) * 256 + 'px';
    const hx = rgbToHex(r, g, b); newC.style.background = hx;
    const vals = { h: Math.round(hsv.h), s: Math.round(hsv.s), v: Math.round(hsv.v), r, g, b };
    for (const k in f) if (document.activeElement !== f[k]) f[k].value = vals[k];
    if (document.activeElement !== hex) hex.value = hx.slice(1);
    const L = rgbToLab(r, g, b); lab.textContent = `L: ${Math.round(L.L)}  a: ${Math.round(L.a)}  b: ${Math.round(L.b)}`;
    const c = rgbToCmyk(r, g, b); cmyk.textContent = `C: ${c.c}%  M: ${c.m}%  Y: ${c.y}%  K: ${c.k}%`;
  };
  const drag = (elm, fn) => elm.addEventListener('pointerdown', (e) => { elm.setPointerCapture(e.pointerId); fn(e); const mv = (ev) => fn(ev); const up = () => { elm.removeEventListener('pointermove', mv); elm.removeEventListener('pointerup', up); }; elm.addEventListener('pointermove', mv); elm.addEventListener('pointerup', up); });
  drag(sv, (e) => { const rr = sv.getBoundingClientRect(); hsv.s = clamp((e.clientX - rr.left) / rr.width * 100, 0, 100); hsv.v = clamp(100 - (e.clientY - rr.top) / rr.height * 100, 0, 100); upd(true); });
  drag(hue, (e) => { const rr = hue.getBoundingClientRect(); hsv.h = clamp((1 - (e.clientY - rr.top) / rr.height) * 360, 0, 359.9); upd(true); });
  for (const k of ['h', 's', 'v']) f[k].onchange = () => { hsv[k] = Number(f[k].value) || 0; upd(true); };
  for (const k of ['r', 'g', 'b']) f[k].onchange = () => { const v = clamp(Number(f[k].value) || 0, 0, 255); if (k === 'r') r = v; if (k === 'g') g = v; if (k === 'b') b = v; hsv = rgbToHsv(r, g, b); upd(); };
  hex.onchange = () => { if (/^[0-9a-f]{6}$/i.test(hex.value.replace('#', ''))) { ({ r, g, b } = hexToRgb(hex.value)); hsv = rgbToHsv(r, g, b); upd(); } };
  upd();
  const addSw = el('button', { class: 'btn', onclick: () => { app.swatches.push(rgbToHex(r, g, b)); try { localStorage.setItem('strata.swatches', JSON.stringify(app.swatches)); } catch {} app.emit('swatches'); toast('Added to Swatches', 'ok', 1200); } }, 'Add to Swatches');
  return modal({ title, body, buttons: [{ node: addSw }, '-', { label: 'Cancel', value: null }, { label: 'OK', value: () => rgbToHex(r, g, b), primary: true }] });
}

// ---------- Layer Style ----------
const FX_NAMES = { blending: 'Blending Options', dropShadow: 'Drop Shadow', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow', stroke: 'Stroke', colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay' };
export async function layerStyleDialog(doc, L, start = 'blending') {
  const orig = { effects: L.effects ? JSON.parse(JSON.stringify(L.effects)) : null, opacity: L.opacity, fillOpacity: L.fillOpacity, blend: L.blend };
  if (!L.effects) L.effects = DEFAULT_EFFECTS();
  const fx = L.effects;
  if (start !== 'blending' && fx[start] && !orig.effects?.[start]?.enabled) fx[start].enabled = true;
  let cur = start;
  const live = () => { L.touch(); doc.invalidate(); };
  const left = el('div', { style: { width: '180px', display: 'flex', flexDirection: 'column', gap: '2px', borderRight: '1px solid var(--line)', paddingRight: '10px' } });
  const right = el('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '360px' } });
  const drawLeft = () => {
    left.innerHTML = '';
    for (const k of Object.keys(FX_NAMES)) {
      const row = el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', borderRadius: '3px', background: k === cur ? 'var(--bg5)' : '' } });
      if (k !== 'blending') { const c = el('input', { type: 'checkbox', checked: fx[k].enabled }); c.onclick = (e) => { e.stopPropagation(); fx[k].enabled = c.checked; live(); }; row.append(c); }
      row.append(el('span', {}, FX_NAMES[k]));
      row.onclick = () => { cur = k; if (k !== 'blending' && !fx[k].enabled) { fx[k].enabled = true; live(); } drawLeft(); drawRight(); };
      left.append(row);
    }
  };
  const blendSel = (obj, k) => selectEl(BLEND_MODES.map(m => m || null), obj[k], (v) => { obj[k] = v; live(); });
  const S = (label, obj, k, min, max, unit = '') => sliderRow({ label, value: obj[k], min, max, unit, onInput: (v) => { obj[k] = v; live(); } });
  const C = (label, obj, k) => el('div', { class: 'row' }, el('label', {}, label), colorEl(obj[k], (v) => { obj[k] = v; live(); }, (v) => { obj[k] = v; live(); }));
  const drawRight = () => {
    right.innerHTML = '';
    right.append(el('div', { style: { fontWeight: 600 } }, FX_NAMES[cur]));
    if (cur === 'blending') {
      right.append(el('div', { class: 'row' }, el('label', {}, 'Blend Mode'), selectEl(BLEND_MODES.map(m => m || null), L.blend, (v) => { L.blend = v; live(); })),
        sliderRow({ label: 'Opacity', value: Math.round(L.opacity * 100), min: 0, max: 100, unit: '%', onInput: (v) => { L.opacity = v / 100; live(); } }),
        sliderRow({ label: 'Fill Opacity', value: Math.round(L.fillOpacity * 100), min: 0, max: 100, unit: '%', onInput: (v) => { L.fillOpacity = v / 100; live(); } }));
      return;
    }
    const o = fx[cur];
    if (cur === 'dropShadow' || cur === 'innerShadow') right.append(el('div', { class: 'row' }, el('label', {}, 'Blend Mode'), blendSel(o, 'blend')), C('Color', o, 'color'), S('Opacity', o, 'opacity', 0, 100, '%'), S('Angle', o, 'angle', -180, 180, '°'), S('Distance', o, 'distance', 0, 1000, 'px'), ...(cur === 'dropShadow' ? [S('Spread', o, 'spread', 0, 100, '%')] : []), S('Size', o, 'size', 0, 250, 'px'));
    if (cur === 'outerGlow') right.append(el('div', { class: 'row' }, el('label', {}, 'Blend Mode'), blendSel(o, 'blend')), C('Color', o, 'color'), S('Opacity', o, 'opacity', 0, 100, '%'), S('Spread', o, 'spread', 0, 100, '%'), S('Size', o, 'size', 0, 250, 'px'));
    if (cur === 'stroke') right.append(S('Size', o, 'size', 1, 250, 'px'), el('div', { class: 'row' }, el('label', {}, 'Position'), selectEl([['outside', 'Outside'], ['inside', 'Inside'], ['center', 'Center']], o.position, (v) => { o.position = v; live(); })), S('Opacity', o, 'opacity', 0, 100, '%'), C('Color', o, 'color'));
    if (cur === 'colorOverlay') right.append(el('div', { class: 'row' }, el('label', {}, 'Blend Mode'), blendSel(o, 'blend')), C('Color', o, 'color'), S('Opacity', o, 'opacity', 0, 100, '%'));
    if (cur === 'gradientOverlay') right.append(el('div', { class: 'row' }, el('label', {}, 'Blend Mode'), blendSel(o, 'blend')), S('Opacity', o, 'opacity', 0, 100, '%'), C('From', o.stops[0], 'color'), C('To', o.stops[o.stops.length - 1], 'color'), S('Angle', o, 'angle', -180, 180, '°'));
  };
  drawLeft(); drawRight(); live();
  const r = await modal({ title: 'Layer Style', body: el('div', { style: { display: 'flex', gap: '14px' } }, left, right), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] });
  if (!r) { L.effects = orig.effects; L.opacity = orig.opacity; L.fillOpacity = orig.fillOpacity; L.blend = orig.blend; live(); return false; }
  if (!Object.values(L.effects).some(f => f.enabled)) L.effects = null;
  doc.commit('Layer Style', 'fx');
  return true;
}

// ---------- Liquify ----------
export async function liquifyDialog(srcCanvas) {
  const maxD = Math.min(innerWidth - 360, innerHeight - 200, 900);
  const s = Math.min(1, maxD / Math.max(srcCanvas.width, srcCanvas.height));
  const W = Math.max(1, Math.round(srcCanvas.width * s)), H = Math.max(1, Math.round(srcCanvas.height * s));
  const small = createCanvas(W, H); ctx2d(small).drawImage(srcCanvas, 0, 0, W, H);
  const src = ctx2d(small).getImageData(0, 0, W, H);
  const dx = new Float32Array(W * H), dy = new Float32Array(W * H), frozen = new Uint8Array(W * H);
  const stage = el('canvas', { class: 'stage', width: W, height: H });
  const g = ctx2d(stage); const out = g.createImageData(W, H);
  let tool = 'warp', size = 100, pressure = 50, rate = 80, showMask = true;
  const render = () => {
    const sd = src.data, od = out.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = y * W + x, sx = clamp(x + dx[k], 0, W - 1), sy = clamp(y + dy[k], 0, H - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
      for (let c = 0; c < 4; c++) { const a = sd[(y0 * W + x0) * 4 + c], b = sd[(y0 * W + x1) * 4 + c], cc = sd[(y1 * W + x0) * 4 + c], d = sd[(y1 * W + x1) * 4 + c]; od[k * 4 + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy; }
      if (showMask && frozen[k]) { od[k * 4] = od[k * 4] * 0.5 + 127; od[k * 4 + 1] *= 0.5; od[k * 4 + 2] *= 0.5; }
    }
    g.putImageData(out, 0, 0);
    if (hover) { g.strokeStyle = '#fff'; g.beginPath(); g.arc(hover.x, hover.y, size * s / 2, 0, Math.PI * 2); g.stroke(); g.strokeStyle = '#000'; g.beginPath(); g.arc(hover.x, hover.y, size * s / 2 + 1, 0, Math.PI * 2); g.stroke(); }
  };
  let hover = null, last = null, down = false, raf = 0;
  const sched = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
  const apply = (x, y, mx, my) => {
    const R = size * s / 2, P = pressure / 100;
    for (let yy = Math.max(0, Math.floor(y - R)); yy < Math.min(H, Math.ceil(y + R)); yy++) for (let xx = Math.max(0, Math.floor(x - R)); xx < Math.min(W, Math.ceil(x + R)); xx++) {
      const d = Math.hypot(xx - x, yy - y) / R; if (d >= 1) continue;
      const k = yy * W + xx; if (frozen[k] && tool !== 'thaw') continue;
      const f = (1 - d * d) ** 2 * P;
      if (tool === 'warp') { dx[k] -= mx * f; dy[k] -= my * f; }
      else if (tool === 'reconstruct') { dx[k] *= 1 - f * 0.3; dy[k] *= 1 - f * 0.3; }
      else if (tool === 'pucker' || tool === 'bloat') { const sgn = tool === 'pucker' ? 1 : -1; dx[k] += (xx - x) * f * 0.06 * sgn * rate / 50; dy[k] += (yy - y) * f * 0.06 * sgn * rate / 50; }
      else if (tool === 'twirl' || tool === 'twirlL') { const a = f * 0.08 * (tool === 'twirl' ? 1 : -1) * rate / 50, rx = xx - x, ry = yy - y; dx[k] += rx * Math.cos(a) - ry * Math.sin(a) - rx; dy[k] += rx * Math.sin(a) + ry * Math.cos(a) - ry; }
      else if (tool === 'freeze') frozen[k] = 1; else if (tool === 'thaw') frozen[k] = 0;
    }
  };
  const pos = (e) => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };
  let timer;
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); down = true; last = pos(e); apply(last.x, last.y, 0, 0); sched(); if (tool !== 'warp') timer = setInterval(() => { if (hover) { apply(hover.x, hover.y, 0, 0); sched(); } }, 40); });
  stage.addEventListener('pointermove', (e) => { hover = pos(e); if (down) { const p = hover; apply(p.x, p.y, p.x - last.x, p.y - last.y); last = p; } sched(); });
  stage.addEventListener('pointerup', () => { down = false; clearInterval(timer); });
  stage.addEventListener('pointerleave', () => { hover = null; sched(); });
  const tb = (id, icon, title) => el('button', { class: 'ibtn' + (tool === id ? ' on' : ''), title, html: ICONS[icon], onclick: (e) => { tool = id; $$('.liq .tools .ibtn').forEach(b => b.classList.remove('on')); e.currentTarget.classList.add('on'); } });
  const tools = el('div', { class: 'tools' }, tb('warp', 'liquify', 'Forward Warp Tool (W)'), tb('reconstruct', 'reconstruct', 'Reconstruct Tool (R)'), tb('twirl', 'twirl', 'Twirl Clockwise Tool (C)'), tb('pucker', 'pucker', 'Pucker Tool (S)'), tb('bloat', 'bloat', 'Bloat Tool (B)'), tb('freeze', 'freeze', 'Freeze Mask Tool (F)'), tb('thaw', 'thaw', 'Thaw Mask Tool (D)'));
  const side = el('div', { class: 'side' },
    el('div', { style: { fontWeight: 600 } }, 'Brush Tool Options'),
    sliderRow({ label: 'Size', value: size, min: 1, max: 1500, onInput: (v) => size = v }), sliderRow({ label: 'Pressure', value: pressure, min: 1, max: 100, onInput: (v) => pressure = v }), sliderRow({ label: 'Rate', value: rate, min: 0, max: 100, onInput: (v) => rate = v }),
    checkEl('Show Mask', true, (v) => { showMask = v; sched(); }),
    el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => { dx.fill(0); dy.fill(0); sched(); } }, 'Restore All'), el('button', { class: 'btn', onclick: () => { frozen.fill(0); sched(); } }, 'None (mask)')));
  render();
  const r = await modal({ title: 'Liquify', body: el('div', { class: 'liq' }, tools, el('div', {}, stage), side), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }],
    onKey: (e) => { const m = { w: 'warp', r: 'reconstruct', c: 'twirl', s: 'pucker', b: 'bloat', f: 'freeze', d: 'thaw' }[e.key.toLowerCase()]; if (m && !e.ctrlKey && e.target.tagName !== 'INPUT') { tool = m; return true; } if (e.key === '[' || e.key === ']') { size = clamp(size + (e.key === ']' ? 10 : -10), 1, 1500); sched(); return true; } return false; } });
  if (!r) return null;
  // apply displacement at full resolution
  const FW = srcCanvas.width, FH = srcCanvas.height;
  const full = ctx2d(srcCanvas).getImageData(0, 0, FW, FH), fo = new ImageData(FW, FH), sd = full.data, od = fo.data;
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const sx0 = x * s, sy0 = y * s;
    const ix = clamp(Math.floor(sx0), 0, W - 1), iy = clamp(Math.floor(sy0), 0, H - 1), ix1 = Math.min(W - 1, ix + 1), iy1 = Math.min(H - 1, iy + 1), fx = sx0 - ix, fy = sy0 - iy;
    const bil = (a) => (a[iy * W + ix] * (1 - fx) + a[iy * W + ix1] * fx) * (1 - fy) + (a[iy1 * W + ix] * (1 - fx) + a[iy1 * W + ix1] * fx) * fy;
    const sx = clamp(x + bil(dx) / s, 0, FW - 1), sy = clamp(y + bil(dy) / s, 0, FH - 1);
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(FW - 1, x0 + 1), y1 = Math.min(FH - 1, y0 + 1), ffx = sx - x0, ffy = sy - y0, k = (y * FW + x) * 4;
    for (let c = 0; c < 4; c++) { const a = sd[(y0 * FW + x0) * 4 + c], b = sd[(y0 * FW + x1) * 4 + c], cc = sd[(y1 * FW + x0) * 4 + c], d = sd[(y1 * FW + x1) * 4 + c]; od[k + c] = (a * (1 - ffx) + b * ffx) * (1 - ffy) + (cc * (1 - ffx) + d * ffx) * ffy; }
  }
  return fo;
}

// ---------- Updates ----------
export function updateStatusText(st) {
  if (!st) return '';
  const r = { dev: 'Updates are off when running from source.', portable: 'This copy was unzipped rather than installed. Install Strata with Strata-Setup.exe to get automatic updates.', 'no-token': 'Paste a read-only GitHub token below to turn on updates.' };
  if (st.state === 'unavailable') return r[st.reason] || 'Updates are unavailable.';
  return { idle: `Version ${st.current || st.version || ''} — updates on (${st.feed || '0smotis/strata'}).`, checking: 'Checking for updates…', current: `You're up to date (${st.version || st.current}).`, available: `Version ${st.version} is available.`, downloading: `Downloading ${st.version || 'update'}… ${st.percent || 0}%`, ready: `Version ${st.version} is ready — restart Strata to install it.`, error: st.message || 'Update check failed.' }[st.state] || '';
}
function updatesBox() {
  const status = el('div', { class: 'note', style: { color: 'var(--text)' } }, 'Checking…');
  const tok = el('input', { type: 'password', placeholder: 'github_pat_… (read-only, Contents: Read on 0smotis/strata)', style: { flex: 1, minWidth: '280px' } });
  tok.onkeydown = (e) => { if (e.key !== 'Escape') e.stopPropagation(); };
  const refresh = async () => { const st = await window.host.updates.status(); status.textContent = updateStatusText(st) + (st.hasToken ? '  (token saved)' : ''); installBtn.style.display = st.state === 'ready' ? '' : 'none'; };
  const saveBtn = el('button', { class: 'btn', onclick: async () => { try { await window.host.updates.setToken(tok.value); tok.value = ''; toast('Update token saved', 'ok', 1500); refresh(); } catch (e) { toast(e.message, 'err'); } } }, 'Save Token');
  const clearBtn = el('button', { class: 'btn quiet', onclick: async () => { await window.host.updates.setToken(''); refresh(); } }, 'Remove');
  const checkBtn = el('button', { class: 'btn', onclick: async () => { status.textContent = 'Checking for updates…'; await window.host.updates.check(); setTimeout(refresh, 600); } }, 'Check for Updates');
  const installBtn = el('button', { class: 'btn primary', style: { display: 'none' }, onclick: () => window.host.updates.install() }, 'Restart and Update');
  const auto = checkEl('Download updates automatically', app.settings.updateAuto !== false, async (v) => { app.settings.updateAuto = v; await window.host.updates.setAuto(v); });
  refresh();
  const off = (s) => refresh(); window.host.on('updates:status', off);
  return el('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, status, el('div', { class: 'row' }, el('label', {}, 'GitHub token'), tok), el('div', { class: 'btnrow', style: { display: 'flex', gap: '6px' } }, saveBtn, clearBtn, checkBtn, installBtn), auto);
}

// ---------- Preferences ----------
export async function preferencesDialog() {
  const s = { ...app.settings };
  const sec = (t) => el('div', { style: { fontWeight: 600, marginTop: '6px' } }, t);
  const txt = (k, ph, type = 'text') => { const i = el('input', { type, value: s[k] || '', placeholder: ph, style: { flex: 1, minWidth: '280px' } }); i.oninput = () => s[k] = i.value; i.onkeydown = (e) => { if (e.key !== 'Enter' && e.key !== 'Escape') e.stopPropagation(); }; return i; };
  const provider = selectEl([['none', 'None (blank prompt → Content-Aware fill only)'], ['a1111', 'Local Stable Diffusion (AUTOMATIC1111 / Forge API)'], ['stability', 'Stability AI (API key)'], ['openai', 'OpenAI Images (API key)']], s.genProvider || 'none', (v) => s.genProvider = v);
  const body = el('div', { style: { width: '560px' } },
    sec('General'),
    el('div', { class: 'row' }, el('label', {}, 'History States'), numField({ value: s.historyStates || 50, min: 5, max: 1000, width: 70, onChange: (v) => s.historyStates = v })),
    checkEl('Zoom with scroll wheel', !!s.wheelZoom, (v) => s.wheelZoom = v),
    el('div', { class: 'row' }, el('label', {}, 'Grid every'), numField({ value: s.gridSize || 100, min: 2, max: 5000, unit: 'px', width: 70, onChange: (v) => s.gridSize = v }), el('span', { class: 'muted' }, 'Subdivisions'), numField({ value: s.gridSub || 4, min: 1, max: 100, width: 50, onChange: (v) => s.gridSub = v })),
    sec('Generative AI (Generative Fill / Expand)'),
    el('div', { class: 'row' }, el('label', {}, 'Provider'), provider),
    el('div', { class: 'row' }, el('label', {}, 'SD server URL'), txt('a1111Url', 'http://127.0.0.1:7860')),
    el('div', { class: 'row' }, el('label', {}, 'Stability key'), txt('stabilityKey', 'sk-…', 'password')),
    el('div', { class: 'row' }, el('label', {}, 'OpenAI key'), txt('openaiKey', 'sk-…', 'password')),
    el('div', { class: 'row' }, el('label', {}, 'OpenAI model'), txt('openaiModel', 'gpt-image-1')),
    el('div', { class: 'row' }, el('label', {}, 'Negative prompt'), txt('negativePrompt', 'blurry, low quality, watermark, text')),
    el('div', { class: 'note' }, 'API keys are encrypted with your Windows account (DPAPI) and only sent to the provider you pick. Local AI tools (Select Subject, Remove Background, Select Sky, Remove Tool) run entirely on your PC; their models download once on first use (~40–200 MB each).'),
    sec('Updates'),
    updatesBox(),
    sec('Local AI models'),
    el('div', { class: 'row' }, el('label', {}, 'Subject model'), selectEl([['briaai/RMBG-1.4', 'RMBG-1.4 (best quality, non-commercial license)'], ['Xenova/modnet', 'MODNet (portraits, Apache-2.0)']], s.subjectModel || 'briaai/RMBG-1.4', (v) => s.subjectModel = v)),
    checkEl('Use GPU (WebGPU) for AI when available', s.useGPU !== false, (v) => s.useGPU = v),
  );
  const r = await modal({ title: 'Preferences', body, buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] });
  if (!r) return;
  app.settings = s;
  await window.host.setSettings(s);
  for (const d of app.docs) d.historyLimit = s.historyStates || 50;
  toast('Preferences saved', 'ok', 1500);
  requestDraw();
}

// ---------- Export As ----------
export async function exportDialog(doc) {
  let fmt = 'png', q = 92, scale = 100;
  const prevBox = el('div', { class: 'preview-box', style: { width: '320px', height: '240px' } });
  const cv = el('canvas'); prevBox.append(cv);
  const sizeInfo = el('div', { class: 'muted' });
  const comp = doc.render(true);
  const upd = debounce(async () => {
    const w = Math.max(1, Math.round(doc.width * scale / 100)), h = Math.max(1, Math.round(doc.height * scale / 100));
    const { exportBytes } = await import('../doc/io.js');
    const bytes = await exportBytes(doc, fmt, q / 100, { width: w, height: h });
    sizeInfo.textContent = `${w} × ${h} px · ${(bytes.length / 1024).toFixed(1)} KB`;
    const img = await createImageBitmap(new Blob([bytes]));
    cv.width = img.width; cv.height = img.height; ctx2d(cv).drawImage(img, 0, 0);
  }, 150);
  const qRow = sliderRow({ label: 'Quality', value: q, min: 1, max: 100, unit: '%', onInput: (v) => { q = v; upd(); } });
  const body = el('div', { style: { display: 'flex', gap: '16px' } }, prevBox, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', width: '300px' } },
    el('div', { class: 'row' }, el('label', {}, 'Format'), selectEl([['png', 'PNG'], ['jpeg', 'JPG'], ['webp', 'WebP']], fmt, (v) => { fmt = v; qRow.style.display = v === 'png' ? 'none' : ''; upd(); })), qRow,
    sliderRow({ label: 'Scale', value: scale, min: 5, max: 400, unit: '%', onInput: (v) => { scale = v; upd(); } }), sizeInfo));
  qRow.style.display = 'none';
  upd();
  return modal({ title: 'Export As', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Export…', value: () => ({ fmt, q: q / 100, scale }), primary: true }] });
}

export async function shortcutsDialog(list) {
  const t = el('div', { class: 'kbd-table' });
  for (const [k, d] of list) t.append(el('span', {}, d), el('span', {}, el('kbd', {}, k)));
  return modal({ title: 'Keyboard Shortcuts', body: t, buttons: [{ label: 'Close', value: true, primary: true }] });
}
