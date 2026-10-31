// Right-side panels: Color, Swatches, Properties, Adjustments, Layers, Channels, History
import { app, cmd } from '../state.js';
import { el, $, $$, createCanvas, ctx2d, clamp, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, debounce, rafThrottle } from '../util.js';
import { ICONS } from '../icons.js';
import { showMenu, selectEl, checkEl, sliderRow, numField, colorEl, toast, promptBox } from './common.js';
import { BLEND_MODES, BLEND_NAMES } from '../doc/blend.js';
import { ADJUSTMENT_TYPES, defaultParams, curveLUT, histogram } from '../engine/adjust.js';
import { GRADIENT_PRESETS, gradientCSS, resolveStops } from '../doc/gradient.js';
import { measureText } from '../doc/document.js';
import { renderAdjustmentUI } from './adjui.js';
import { buildPath2D } from '../doc/paths.js';
import { pathTarget } from '../tools/pen.js';
import { navigatorPanel, infoPanel, histogramPanel, brushSettingsPanel } from './panels2.js';
import { stepLabel, findAction, saveActions, selectFrame, syncFrame } from '../commands2.js';

const ADJ_ICON = {
  brightnessContrast: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="4.5"/><path d="M12 7.5v9" /><path d="M12 7.5a4.5 4.5 0 0 1 0 9z" fill="currentColor"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>',
  levels: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20V14l2-3 2 2 2-6 2 4 2-8 2 7 2-2 2 4 2 1v7z" opacity=".85"/></svg>',
  curves: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 21C9 21 9 3 21 3" /></svg>',
  exposure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 21L21 3" /><path d="M6 7h4M8 5v4M14 17h4"/></svg>',
  vibrance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 5l8 15 8-15z"/><path d="M8 9h8"/></svg>',
  hueSaturation: '<svg viewBox="0 0 24 24"><path d="M3 16h18v4H3z" fill="url(#hs)"/><defs><linearGradient id="hs"><stop offset="0" stop-color="#f00"/><stop offset=".33" stop-color="#0f0"/><stop offset=".66" stop-color="#00f"/><stop offset="1" stop-color="#f00"/></linearGradient></defs><path d="M5 13V5M12 13V8M19 13V4" stroke="currentColor" stroke-width="1.6"/></svg>',
  colorBalance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4v16M5 20h14M4 9l3-5 3 5a3 3 0 0 1-6 0zM14 9l3-5 3 5a3 3 0 0 1-6 0zM4 4h16"/></svg>',
  blackWhite: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 21L21 3v18z" fill="currentColor"/></svg>',
  photoFilter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="7" width="18" height="13" rx="1.5"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7l1.5-3h4l1.5 3"/></svg>',
  channelMixer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="9" cy="10" r="5"/><circle cx="15" cy="10" r="5"/><circle cx="12" cy="15" r="5"/></svg>',
  invert: ICONS.invert,
  posterize: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="6" height="18" opacity=".3"/><rect x="9" y="3" width="6" height="18" opacity=".6"/><rect x="15" y="3" width="6" height="18"/></svg>',
  threshold: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5 19c3-2 3-12 7-12s3 6 7 4V19z" fill="currentColor"/></svg>',
  gradientMap: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gm"><stop offset="0" stop-color="#222"/><stop offset="1" stop-color="#ddd"/></linearGradient></defs><rect x="3" y="7" width="18" height="10" fill="url(#gm)" stroke="currentColor"/></svg>',
  selectiveColor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="8" height="8" fill="#e33" stroke="none"/><rect x="13" y="3" width="8" height="8" fill="#3c3" stroke="none"/><rect x="3" y="13" width="8" height="8" fill="#36e" stroke="none"/><rect x="13" y="13" width="8" height="8"/></svg>',
};
export { ADJ_ICON };

// ---------- panel framework ----------
function panelGroup(tabs, { flex = false, height } = {}) {
  const g = el('div', { class: 'pgroup' + (flex ? ' flex' : ''), style: height ? { height: height + 'px', flex: 'none' } : {} });
  const tabBar = el('div', { class: 'ptabs' });
  const body = el('div', { class: 'pbody' });
  let cur = 0;
  const show = (k) => {
    cur = k;
    $$('.ptab', tabBar).forEach((t, j) => t.classList.toggle('on', j === k));
    if (body._cleanup) { try { body._cleanup(); } catch {} } body._cleanup = null; body._menu = null;
    body.innerHTML = ''; body.style.display = 'flex'; body.style.flexDirection = 'column';
    tabs[k].mount(body);
    g.dataset.tab = tabs[k].id;
  };
  tabs.forEach((t, k) => tabBar.append(el('div', { class: 'ptab', onclick: () => { if (cur === k && g.classList.contains('collapsed')) g.classList.remove('collapsed'); show(k); }, ondblclick: () => g.classList.toggle('collapsed') }, t.title)));
  tabBar.append(el('button', { class: 'ibtn pmenu', html: ICONS.more, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(body._menu ? body._menu() : tabs[cur].menu ? tabs[cur].menu() : [{ label: 'Close Tab Group', run: () => g.classList.add('collapsed') }], r.left - 180, r.bottom); } }));
  g.append(tabBar, body);
  if (!flex) {
    const rz = el('div', { class: 'vresize' });
    rz.addEventListener('pointerdown', (e) => { const h0 = g.getBoundingClientRect().height, y0 = e.clientY; const mv = (ev) => { g.style.height = clamp(h0 + ev.clientY - y0, 60, innerHeight - 200) + 'px'; g.style.flex = 'none'; }; const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); });
    g.append(rz);
  }
  g.show = (id) => { const k = tabs.findIndex(t => t.id === id); if (k >= 0) { g.classList.remove('collapsed'); show(k); } };
  g.current = () => tabs[cur].id;
  show(0);
  return g;
}

// ---------- Color ----------
function colorPanel(body) {
  let target = 'fg';
  const sv = el('div', { class: 'sv' }), svCur = el('div', { class: 'cur' }); sv.append(svCur);
  const hue = el('div', { class: 'hue' }), hueCur = el('div', { class: 'cur' }); hue.append(hueCur);
  const fgbg = el('div', { style: { position: 'relative', width: '40px', height: '40px', flex: 'none' } });
  const fgS = el('div', { style: { position: 'absolute', left: 0, top: 0, width: '26px', height: '26px', border: '1px solid #ddd', zIndex: 2 } });
  const bgS = el('div', { style: { position: 'absolute', left: '12px', top: '12px', width: '26px', height: '26px', border: '1px solid #ddd' } });
  fgbg.append(fgS, bgS);
  fgS.onclick = () => { target = 'fg'; upd(); }; bgS.onclick = () => { target = 'bg'; upd(); };
  fgS.ondblclick = () => cmd('pickColor', 'fg'); bgS.ondblclick = () => cmd('pickColor', 'bg');
  const wrap = el('div', { class: 'colorp' }, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, fgbg), sv, hue);
  const hexIn = el('input', { type: 'text', style: { width: '100%' } });
  const fields = { r: el('input', { type: 'number', min: 0, max: 255 }), g: el('input', { type: 'number', min: 0, max: 255 }), b: el('input', { type: 'number', min: 0, max: 255 }) };
  const fRow = el('div', { class: 'colorp-fields' }, el('label', {}, 'R', fields.r), el('label', {}, 'G', fields.g), el('label', {}, 'B', fields.b), el('label', {}, '#', hexIn));
  body.append(wrap, fRow);
  let hsv = rgbToHsv(...Object.values(hexToRgb(app[target])));
  const setColor = (hex, keepHsv) => { app[target] = hex; if (!keepHsv) hsv = rgbToHsv(...Object.values(hexToRgb(hex))); app.emit('colors'); };
  const upd = () => {
    const c = hexToRgb(app[target]);
    const cur = rgbToHsv(c.r, c.g, c.b);
    if (rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)) !== app[target]) hsv = cur;
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h},100%,50%))`;
    svCur.style.left = hsv.s + '%'; svCur.style.top = (100 - hsv.v) + '%';
    hueCur.style.top = (1 - hsv.h / 360) * 100 + '%';
    fgS.style.background = app.fg; bgS.style.background = app.bg;
    fgS.style.outline = target === 'fg' ? '2px solid var(--accent)' : 'none'; bgS.style.outline = target === 'bg' ? '2px solid var(--accent)' : 'none';
    if (document.activeElement !== hexIn) hexIn.value = app[target].slice(1);
    for (const k of 'rgb') if (document.activeElement !== fields[k]) fields[k].value = c[k];
  };
  const drag = (elm, fn) => elm.addEventListener('pointerdown', (e) => { elm.setPointerCapture(e.pointerId); fn(e); const mv = (ev) => fn(ev); const up = () => { elm.removeEventListener('pointermove', mv); elm.removeEventListener('pointerup', up); }; elm.addEventListener('pointermove', mv); elm.addEventListener('pointerup', up); });
  drag(sv, (e) => { const r = sv.getBoundingClientRect(); hsv.s = clamp((e.clientX - r.left) / r.width * 100, 0, 100); hsv.v = clamp(100 - (e.clientY - r.top) / r.height * 100, 0, 100); setColor(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)), true); });
  drag(hue, (e) => { const r = hue.getBoundingClientRect(); hsv.h = clamp((1 - (e.clientY - r.top) / r.height) * 360, 0, 359.9); setColor(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)), true); });
  hexIn.addEventListener('change', () => { const v = hexIn.value.replace('#', ''); if (/^[0-9a-f]{6}$/i.test(v)) setColor('#' + v.toLowerCase()); });
  for (const k of 'rgb') fields[k].addEventListener('change', () => { const c = hexToRgb(app[target]); c[k] = clamp(Number(fields[k].value) || 0, 0, 255); setColor(rgbToHex(c)); });
  for (const i of [hexIn, ...Object.values(fields)]) i.addEventListener('keydown', e => e.stopPropagation());
  upd();
  const off = app.on('colors', upd);
  body._cleanup = off;
}

// ---------- Swatches ----------
const DEFAULT_SWATCHES = {
  'RGB': ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
  'Grayscale': ['#ffffff', '#e6e6e6', '#cccccc', '#b3b3b3', '#999999', '#808080', '#666666', '#4d4d4d', '#333333', '#1a1a1a', '#000000'],
  'Pastel': ['#f69679', '#f9ad81', '#fdc68a', '#fff79a', '#c4df9b', '#a3d39c', '#82ca9d', '#7bcdc8', '#6ecff6', '#7ea7d8', '#8493ca', '#8882be', '#a187be', '#bc8dbf', '#f49ac2', '#f6989d'],
  'Light': ['#f26c4f', '#f68e55', '#fbaf5c', '#fff467', '#acd372', '#7cc576', '#3bb878', '#1abbb4', '#00bff3', '#438ccb', '#5574b9', '#605ca8', '#855fa8', '#a763a8', '#f06ea9', '#f26d7d'],
  'Pure': ['#ed1c24', '#f26522', '#f7941d', '#fff200', '#8dc73f', '#39b54a', '#00a651', '#00a99d', '#00aeef', '#0072bc', '#0054a6', '#2e3192', '#662d91', '#92278f', '#ec008c', '#ed145b'],
  'Dark': ['#9e0b0f', '#a0410d', '#a36209', '#aba000', '#598527', '#1a7b30', '#007236', '#00746b', '#0076a3', '#004b80', '#003471', '#1b1464', '#440e62', '#630460', '#9e005d', '#9e0039'],
  'Skin Tones': ['#ffdbac', '#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e', '#ffe0bd', '#ffcd94', '#eac086', '#c58c85'],
};
function swatchesPanel(body) {
  const render = () => {
    body.innerHTML = '';
    const recent = (app.recentColors || []).slice(0, 18);
    if (recent.length) { body.append(el('div', { class: 'sw-group' }, 'Recently used')); const g = el('div', { class: 'swgrid' }); recent.forEach(c => g.append(sw(c))); body.append(g); }
    const custom = app.swatches || [];
    if (custom.length) { body.append(el('div', { class: 'sw-group' }, 'Custom')); const g = el('div', { class: 'swgrid' }); custom.forEach((c, k) => { const s = sw(c); s.oncontextmenu = (e) => { e.preventDefault(); custom.splice(k, 1); saveSw(); render(); }; g.append(s); }); body.append(g); }
    for (const [name, list] of Object.entries(DEFAULT_SWATCHES)) { body.append(el('div', { class: 'sw-group' }, name)); const g = el('div', { class: 'swgrid' }); list.forEach(c => g.append(sw(c))); body.append(g); }
  };
  const sw = (c) => el('div', { class: 'sw', title: c + ' — click: foreground, Alt+click: background', style: { background: c }, onclick: (e) => { if (e.altKey) app.bg = c; else app.fg = c; app.emit('colors'); } });
  const saveSw = () => { try { localStorage.setItem('strata.swatches', JSON.stringify(app.swatches)); } catch {} };
  render();
  body._menu = () => [{ label: 'New Swatch from Foreground', run: () => { app.swatches.push(app.fg); saveSw(); render(); } }];
  const off = app.on('swatches', render); body._cleanup = off;
}

// ---------- Layers ----------
const thumbCache = new WeakMap();
function layerThumb(doc, L, w = 32, h = 28) {
  const key = L.v + ':' + L.rev + ':' + (doc.preview?.layerId === L.id ? doc.preview.ver : 0) + ':' + doc.width + 'x' + doc.height;
  const cached = thumbCache.get(L);
  if (cached && cached.key === key) return cached.canvas;
  const s = Math.min(w / doc.width, h / doc.height), tw = Math.max(1, Math.round(doc.width * s)), th = Math.max(1, Math.round(doc.height * s));
  const c = createCanvas(tw, th), g = ctx2d(c);
  g.fillStyle = '#fff'; g.fillRect(0, 0, tw, th);
  g.fillStyle = '#ddd'; for (let y = 0; y < th; y += 4) for (let x = (y / 4 % 2) * 4; x < tw; x += 8) g.fillRect(x, y, 4, 4);
  const ct = doc.layerContent(L);
  if (ct.canvas) { g.imageSmoothingQuality = 'medium'; g.drawImage(ct.canvas, ct.x * s, ct.y * s, ct.canvas.width * s, ct.canvas.height * s); }
  thumbCache.set(L, { key, canvas: c });
  return c;
}
function maskThumb(doc, L, w = 32, h = 28) {
  const key = 'm' + L.maskRev + ':' + doc.width;
  const cached = thumbCache.get(L.mask);
  if (cached && cached.key === key) return cached.canvas;
  const s = Math.min(w / doc.width, h / doc.height), tw = Math.max(1, Math.round(doc.width * s)), th = Math.max(1, Math.round(doc.height * s));
  const c = createCanvas(tw, th), g = ctx2d(c);
  g.fillStyle = '#000'; g.fillRect(0, 0, tw, th);
  const a = doc.maskAlpha(L, doc.width, doc.height); g.drawImage(a, 0, 0, tw, th);
  thumbCache.set(L.mask, { key, canvas: c });
  return c;
}

function layersPanel(body) {
  const head = el('div', { class: 'lyr-head' });
  const list = el('div', { class: 'lyr-list' });
  const foot = el('div', { class: 'pfoot' });
  body.append(head, list, foot);
  const doc = () => app.doc;
  let dragId = null;

  const blendSel = el('select', { style: { flex: 1 } });
  for (const m of [['passThrough', 'Pass Through'], ...BLEND_MODES]) { if (!m) { blendSel.append(el('option', { disabled: true }, '─────────')); continue; } blendSel.append(el('option', { value: m[0] }, m[1])); }
  blendSel.onchange = () => { const L = doc()?.active; if (!L) return; for (const id of doc().selectedIds) { const l = doc().find(id); if (l) { l.blend = blendSel.value === 'passThrough' && !l.children ? 'normal' : blendSel.value; l.touch(); } } doc().commit('Blending Change', 'layers'); };
  blendSel.onkeydown = (e) => e.stopPropagation();
  const opacity = numField({ label: 'Opacity:', value: 100, min: 0, max: 100, unit: '%', width: 44, onInput: (v) => { const L = doc()?.active; if (L) { L.opacity = v / 100; L.touch(); doc().invalidate(); } }, onChange: (v) => { const L = doc()?.active; if (L) { L.opacity = v / 100; L.touch(); doc().commit('Opacity Change', 'layers'); } } });
  const fill = numField({ label: 'Fill:', value: 100, min: 0, max: 100, unit: '%', width: 44, onInput: (v) => { const L = doc()?.active; if (L) { L.fillOpacity = v / 100; L.touch(); doc().invalidate(); } }, onChange: (v) => { const L = doc()?.active; if (L) { L.fillOpacity = v / 100; L.touch(); doc().commit('Fill Opacity Change', 'layers'); } } });
  const lockBtn = (k, icon, title) => el('button', { class: 'ibtn', title, html: ICONS[icon], onclick: () => { const L = doc()?.active; if (!L || L.locks.background) return; L.locks[k] = !L.locks[k]; doc().commit('Lock Change', 'lock'); } });
  const locks = el('div', { class: 'locks' }, lockBtn('transparency', 'lockTransparent', 'Lock transparent pixels'), lockBtn('pixels', 'lockPixels', 'Lock image pixels'), lockBtn('position', 'lockPosition', 'Lock position'), lockBtn('all', 'lock', 'Lock all'));
  const filterIn = el('input', { type: 'search', placeholder: 'Filter layers', style: { flex: 1, height: '20px' } });
  filterIn.oninput = () => render(); filterIn.onkeydown = (e) => e.stopPropagation();
  head.append(el('div', { class: 'row' }, el('span', { class: 'ico', style: { width: '14px', color: 'var(--text3)' }, html: ICONS.search }), filterIn), el('div', { class: 'row' }, blendSel, opacity), el('div', { class: 'row' }, el('label', {}, 'Lock:'), locks, el('span', { class: 'grow' }), fill));

  const fbtn = (icon, title, fn) => el('button', { class: 'ibtn', title, html: ICONS[icon], onclick: fn });
  foot.append(
    fbtn('link', 'Link layers', () => toast('Layer linking: select multiple layers with Ctrl/Shift-click to move them together.')),
    fbtn('fx', 'Add a layer style', (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(['dropShadow', 'innerShadow', 'outerGlow', 'stroke', 'colorOverlay', 'gradientOverlay'].map(k => ({ label: { dropShadow: 'Drop Shadow…', innerShadow: 'Inner Shadow…', outerGlow: 'Outer Glow…', stroke: 'Stroke…', colorOverlay: 'Color Overlay…', gradientOverlay: 'Gradient Overlay…' }[k], run: () => cmd('layerStyle', k) })).concat(['-', { label: 'Blending Options…', run: () => cmd('layerStyle', 'blending') }]), r.left, r.top - 200); }),
    fbtn('mask', 'Add layer mask', () => cmd('addMask')),
    fbtn('adjust', 'Create new fill or adjustment layer', (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(adjMenuItems(), r.left, r.top - 420); }),
    fbtn('folder', 'Create a new group', () => cmd('newGroup')),
    fbtn('plus', 'Create a new layer', () => cmd('newLayer')),
    fbtn('trash', 'Delete layer', () => cmd('deleteLayer')),
  );

  const syncHead = () => {
    const L = doc()?.active;
    blendSel.disabled = !L; blendSel.value = L ? L.blend : 'normal';
    opacity.set(L ? Math.round(L.opacity * 100) : 100); fill.set(L ? Math.round(L.fillOpacity * 100) : 100);
    const ks = ['transparency', 'pixels', 'position', 'all'];
    $$('button', locks).forEach((b, k) => b.classList.toggle('on', !!(L && (L.locks[ks[k]] || (L.locks.background && k !== 1)))));
  };

  const render = rafThrottle(() => {
    const d = doc();
    list.innerHTML = '';
    syncHead();
    if (!d) return;
    const q = filterIn.value.trim().toLowerCase();
    const rows = [];
    const walk = (ls, depth) => {
      for (let k = ls.length - 1; k >= 0; k--) {
        const L = ls[k];
        if (!q || L.name.toLowerCase().includes(q) || L.children) rows.push([L, depth]);
        if (L.children && !L.collapsed) walk(L.children, depth + 1);
      }
    };
    walk(d.layers, 0);
    for (const [L, depth] of rows) list.append(row(d, L, depth), ...fxRows(d, L, depth), ...sfRows(d, L, depth));
  });

  function row(d, L, depth) {
    const r = el('div', { class: 'lyr' + (d.selectedIds.has(L.id) ? ' sel' : '') + (d.activeId === L.id ? ' act' : ''), draggable: true });
    r.dataset.id = L.id;
    const vis = el('div', { class: 'vis' + (L.visible ? '' : ' off'), html: ICONS.eye, title: 'Indicates layer visibility (Alt-click to show only this layer)' });
    vis.onclick = (e) => {
      e.stopPropagation();
      if (e.altKey) { const others = d.all().filter(x => x !== L && !x.children); const anyOn = others.some(x => x.visible); others.forEach(x => { x.visible = !anyOn; x.touch(); }); L.visible = true; }
      else L.visible = !L.visible;
      L.touch(); d.commit(L.visible ? 'Show Layer' : 'Hide Layer', 'eye');
    };
    r.append(vis);
    r.append(el('div', { style: { width: (depth * 16 + (L.clipped ? 14 : 0)) + 'px', flex: 'none' } }));
    if (L.clipped) r.append(el('div', { class: 'clipmark', style: { marginLeft: '-14px' }, html: '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M3 1v6h6M7 5l2 2-2 2"/></svg>' }));
    if (L.children) {
      const tw = el('div', { class: 'tw', html: L.collapsed ? ICONS.chevronRight : ICONS.chevronDown });
      tw.onclick = (e) => { e.stopPropagation(); L.collapsed = !L.collapsed; render(); };
      r.append(tw);
    }
    const thumb = el('div', { class: 'thumb' + (!app.maskEdit && d.activeId === L.id && L.mask ? ' on' : '') });
    if (L.children) { thumb.classList.add('ico'); thumb.innerHTML = ICONS.folder; }
    else if (L.kind === 'adjustment') { thumb.classList.add('ico'); thumb.innerHTML = ADJ_ICON[L.data.type] || ICONS.adjust; thumb.title = 'Double-click to edit adjustment'; }
    else if (L.kind === 'fill' && L.data.fillType === 'solid') { thumb.style.background = L.data.color; }
    else if (L.kind === 'smart') { thumb.append(layerThumb(d, L)); thumb.append(el('span', { style: { position: 'absolute', right: '0', bottom: '0', width: '11px', height: '11px', background: '#2b2b2b', color: '#ddd', display: 'grid', placeItems: 'center' }, html: '<svg viewBox="0 0 12 12" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1" y="1" width="10" height="10"/><path d="M7 11V7h4"/></svg>' })); thumb.title = 'Smart Object — double-click to edit contents'; }
    else if (L.artboard) { thumb.classList.add('ico'); thumb.innerHTML = ICONS.artboard; }
    else if (L.kind === 'text') { thumb.classList.add('ico'); thumb.innerHTML = '<span style="font:600 18px Georgia,serif;color:#ddd">T</span>'; }
    else thumb.append(layerThumb(d, L));
    thumb.onclick = (e) => { if (L.mask && d.activeId === L.id) { app.maskEdit = false; app.emit('maskedit'); render(); } };
    thumb.ondblclick = (e) => { e.stopPropagation(); if (L.kind === 'smart') { cmd('editContents'); return; } if (L.kind === 'adjustment' || L.kind === 'fill' || L.kind === 'shape' || L.kind === 'text') app.emit('show-panel', 'properties'); else if (L.kind === 'pixel') cmd('layerStyle', 'blending'); };
    r.append(thumb);
    if (L.mask) {
      r.append(el('div', { class: 'chain', html: L.mask.linked !== false ? ICONS.link : '', title: 'Link layer and mask', onclick: (e) => { e.stopPropagation(); L.mask.linked = L.mask.linked === false; render(); } }));
      const mt = el('div', { class: 'thumb' + (app.maskEdit && d.activeId === L.id ? ' on' : ''), title: 'Layer mask — Alt-click to view, Shift-click to disable', style: { background: '#000' } });
      mt.append(maskThumb(d, L));
      if (L.mask.enabled === false) mt.append(el('div', { style: { position: 'absolute', inset: 0, background: 'linear-gradient(to top right, transparent 46%, #e33 47%, #e33 53%, transparent 54%)' } }));
      mt.onclick = (e) => {
        e.stopPropagation();
        if (e.shiftKey) { L.mask.enabled = L.mask.enabled === false; L.touch(); d.commit(L.mask.enabled ? 'Enable Layer Mask' : 'Disable Layer Mask', 'mask'); return; }
        if (e.altKey) { d.showMaskOf = d.showMaskOf === L.id ? null : L.id; d.invalidate(); return; }
        d.setActive(L.id); app.maskEdit = true; app.emit('maskedit'); render();
      };
      mt.ondblclick = (e) => { e.stopPropagation(); app.emit('show-panel', 'properties'); };
      r.append(mt);
    }
    if (L.vmask) {
      const vt = el('div', { class: 'thumb' + (app.vmaskEdit && d.activeId === L.id ? ' on' : ''), title: 'Vector mask — click to edit with the path tools, Shift-click to disable', style: { background: '#888' } });
      const c = createCanvas(32, 28), g = ctx2d(c), sc = Math.min(32 / d.width, 28 / d.height); g.fillStyle = '#555'; g.fillRect(0, 0, 32, 28); g.save(); g.translate((32 - d.width * sc) / 2, (28 - d.height * sc) / 2); g.scale(sc, sc); g.fillStyle = '#fff'; g.fill(buildPath2D(L.vmask.subpaths)); g.restore(); vt.append(c);
      if (L.vmask.enabled === false) vt.append(el('div', { style: { position: 'absolute', inset: 0, background: 'linear-gradient(to top right, transparent 46%, #e33 47%, #e33 53%, transparent 54%)' } }));
      vt.onclick = (e) => { e.stopPropagation(); if (e.shiftKey) { cmd('toggleVectorMask'); return; } d.setActive(L.id); app.vmaskEdit = !app.vmaskEdit; app.maskEdit = false; app.emit('maskedit'); render(); };
      r.append(vt);
    }
    const nm = el('div', { class: 'nm', style: L.kind === 'group' ? {} : {} }, L.name);
    nm.ondblclick = (e) => {
      e.stopPropagation();
      if (L.locks.background) { cmd('convertBackground'); return; }
      const inp = el('input', { type: 'text', value: L.name });
      nm.innerHTML = ''; nm.append(inp); inp.focus(); inp.select();
      const fin = (ok) => { if (ok && inp.value.trim() && inp.value !== L.name) { L.name = inp.value.trim(); L.userNamed = true; d.commit('Rename Layer', 'layers'); } else render(); };
      inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') fin(true); if (ev.key === 'Escape') fin(false); };
      inp.onblur = () => fin(true);
    };
    r.append(nm);
    const badges = el('div', { class: 'badges' });
    if (L.effects && Object.values(L.effects).some(f => f.enabled)) badges.append(el('span', { html: ICONS.fx, style: { width: '16px', display: 'inline-flex' } }));
    if (L.locks.all || L.locks.background || L.locks.pixels || L.locks.position || L.locks.transparency) badges.append(el('span', { html: ICONS.lock, style: { display: 'inline-flex', opacity: L.locks.all || L.locks.background ? 1 : .5 } }));
    if (L.generative) badges.append(el('span', { html: ICONS.sparkle, title: 'Generative layer', style: { display: 'inline-flex' } }));
    r.append(badges);
    r.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) { if (d.selectedIds.has(L.id) && d.selectedIds.size > 1) { d.selectedIds.delete(L.id); if (d.activeId === L.id) d.activeId = [...d.selectedIds][0]; d.emit('layers'); } else d.setActive(L.id, true); }
      else if (e.shiftKey && d.activeId) { const flat = d.all(); const a = flat.findIndex(x => x.id === d.activeId), b = flat.findIndex(x => x.id === L.id); const [lo, hi] = a < b ? [a, b] : [b, a]; for (let k = lo; k <= hi; k++) d.selectedIds.add(flat[k].id); d.activeId = L.id; d.emit('layers'); }
      else { if (app.maskEdit && !L.mask) app.maskEdit = false; d.setActive(L.id); }
      app.emit('layers-sel');
    };
    r.ondblclick = (e) => { if (e.target === r || e.target.classList.contains('badges')) cmd('layerStyle', 'blending'); };
    r.oncontextmenu = (e) => { e.preventDefault(); if (!d.selectedIds.has(L.id)) d.setActive(L.id); showMenu(layerContextMenu(L), e.clientX, e.clientY); };
    // drag & drop
    r.ondragstart = (e) => { dragId = L.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', L.id); };
    r.ondragover = (e) => {
      if (!dragId || dragId === L.id) return; e.preventDefault();
      const rr = r.getBoundingClientRect(), f = (e.clientY - rr.top) / rr.height;
      r.classList.remove('drop-above', 'drop-below', 'drop-into');
      r.classList.add(L.children && f > 0.3 && f < 0.7 ? 'drop-into' : f < 0.5 ? 'drop-above' : 'drop-below');
    };
    r.ondragleave = () => r.classList.remove('drop-above', 'drop-below', 'drop-into');
    r.ondrop = (e) => {
      e.preventDefault();
      const where = r.classList.contains('drop-into') ? 'into' : r.classList.contains('drop-above') ? 'above' : 'below';
      r.classList.remove('drop-above', 'drop-below', 'drop-into');
      const ids = d.selectedIds.has(dragId) ? [...d.selectedIds] : [dragId]; dragId = null;
      cmd('moveLayersTo', ids, L.id, where);
    };
    r.ondragend = () => { dragId = null; };
    return r;
  }
  function sfRows(d, L, depth) {
    if (!L.smartFilters || !L.smartFilters.length) return [];
    const names = (f) => f.type === 'filter' ? (FILTER_NAMES[f.key] || f.key).replace('…', '') : f.type === 'adjustment' ? ADJ_NAMES[f.adjType] || f.adjType : 'Camera Raw Filter';
    const head = el('div', { class: 'lyr-fx', style: { paddingLeft: (64 + depth * 16) + 'px' } }, el('div', { class: 'vis', html: L.smartFiltersVisible === false ? '' : ICONS.eye, onclick: (e) => { e.stopPropagation(); cmd('toggleSmartFilters'); } }), 'Smart Filters');
    const out = [head];
    L.smartFilters.slice().reverse().forEach((f, rk) => {
      const k = L.smartFilters.length - 1 - rk;
      const row = el('div', { class: 'lyr-fx', style: { paddingLeft: (72 + depth * 16) + 'px' }, title: 'Double-click to edit', ondblclick: () => { d.setActive(L.id); cmd('editSmartFilter', L.id, k); } },
        el('div', { class: 'vis', html: f.enabled === false ? '' : ICONS.eye, onclick: (e) => { e.stopPropagation(); cmd('toggleSmartFilter', L.id, k); } }), names(f),
        el('span', { class: 'grow' }), el('span', { class: 'ico', style: { width: '13px', height: '13px', marginRight: '8px', opacity: .7 }, title: 'Blending options', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h6"/></svg>', onclick: (e) => { e.stopPropagation(); cmd('smartFilterBlending', L.id, k); } }));
      row.oncontextmenu = (e) => { e.preventDefault(); showMenu([{ label: 'Edit Smart Filter…', run: () => cmd('editSmartFilter', L.id, k) }, { label: 'Edit Smart Filter Blending Options…', run: () => cmd('smartFilterBlending', L.id, k) }, { label: f.enabled === false ? 'Enable Smart Filter' : 'Disable Smart Filter', run: () => cmd('toggleSmartFilter', L.id, k) }, '-', { label: 'Delete Smart Filter', run: () => cmd('deleteSmartFilter', L.id, k) }, { label: 'Clear Smart Filters', run: () => { d.setActive(L.id); cmd('clearSmartFilters'); } }], e.clientX, e.clientY); };
      out.push(row);
    });
    return out;
  }
  function fxRows(d, L, depth) {
    if (!L.effects) return [];
    const names = { dropShadow: 'Drop Shadow', innerShadow: 'Inner Shadow', outerGlow: 'Outer Glow', stroke: 'Stroke', colorOverlay: 'Color Overlay', gradientOverlay: 'Gradient Overlay' };
    const on = Object.entries(L.effects).filter(([, v]) => v.enabled || v._shown);
    if (!on.length) return [];
    const out = [el('div', { class: 'lyr-fx', style: { paddingLeft: (64 + depth * 16) + 'px' } }, 'Effects')];
    for (const [k, v] of on) {
      const vis = el('div', { class: 'vis', html: v.enabled ? ICONS.eye : '' });
      vis.onclick = (e) => { e.stopPropagation(); v.enabled = !v.enabled; v._shown = true; L.touch(); d.commit('Layer Style', 'fx'); };
      out.push(el('div', { class: 'lyr-fx', style: { paddingLeft: (72 + depth * 16) + 'px' }, ondblclick: () => cmd('layerStyle', k) }, vis, names[k]));
    }
    return out;
  }
  render();
  const offs = [app.on('doc', render), app.on('layers-changed', render), app.on('maskedit', render)];
  let docOff = null;
  const bindDoc = () => { if (docOff) docOff(); const d = doc(); if (!d) return; const a = d.on('layers', render), b = d.on('history', render); const c = d.on('render', debounce(render, 250)); docOff = () => { a(); b(); c(); }; };
  bindDoc(); offs.push(app.on('doc', bindDoc));
  body._cleanup = () => { offs.forEach(f => f()); docOff && docOff(); };
  body._menu = () => layerContextMenu(doc()?.active);
}

export function adjMenuItems() {
  return [
    { label: 'Solid Color…', cmd: 'newFillLayer', args: ['solid'] }, { label: 'Gradient…', cmd: 'newFillLayer', args: ['gradient'] }, '-',
    ...ADJUSTMENT_TYPES.map((a, k) => ({ label: a.name.replace(/…?$/, '…'), cmd: 'newAdjustmentLayer', args: [a.type] })),
  ];
}
export function layerContextMenu(L) {
  if (!L) return [{ label: 'New Layer', cmd: 'newLayer' }];
  return [
    { label: 'Blending Options…', run: () => cmd('layerStyle', 'blending') }, '-',
    { label: 'Duplicate Layer…', cmd: 'duplicateLayer' }, { label: 'Delete Layer', cmd: 'deleteLayer' }, '-',
    { label: 'Group from Layers…', cmd: 'groupLayers' }, ...(L.children ? [{ label: 'Ungroup Layers', cmd: 'ungroup' }] : []),
    ...(L.locks.background ? [{ label: 'Layer from Background…', cmd: 'convertBackground' }] : []),
    { label: 'Convert to Smart Object', cmd: 'convertToSmart' }, ...(L.kind === 'smart' ? [{ label: 'Edit Contents', cmd: 'editContents' }, { label: 'New Smart Object via Copy', cmd: 'newSmartViaCopy' }, { label: 'Replace Contents…', cmd: 'replaceContents' }, { label: 'Export Contents…', cmd: 'exportContents' }, { label: 'Reset Transform', cmd: 'resetTransform' }] : []), '-',
    { label: 'Artboard from Layers…', cmd: 'artboardFromLayers' },
    ...(L.isVector ? [{ label: L.kind === 'text' ? 'Rasterize Type' : 'Rasterize Layer', cmd: 'rasterize' }] : []),
    ...(L.effects ? [{ label: 'Rasterize Layer Style', cmd: 'rasterizeStyle' }] : []),
    L.mask ? { label: 'Disable Layer Mask', cmd: 'toggleMask' } : { label: 'Add Layer Mask', cmd: 'addMask' },
    L.vmask ? { label: 'Rasterize Vector Mask', cmd: 'rasterizeVectorMask' } : { label: 'Add Vector Mask', cmd: 'addVectorMask' }, ...(L.vmask ? [{ label: 'Delete Vector Mask', cmd: 'deleteVectorMask' }, { label: L.vmask.enabled === false ? 'Enable Vector Mask' : 'Disable Vector Mask', cmd: 'toggleVectorMask' }] : []),
    ...(L.mask ? [{ label: 'Apply Layer Mask', cmd: 'applyMask' }, { label: 'Delete Layer Mask', cmd: 'deleteMask' }] : []),
    { label: L.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask', cmd: 'toggleClip' }, '-',
    ...(L.effects ? [{ label: 'Copy Layer Style', cmd: 'copyStyle' }] : []), { label: 'Paste Layer Style', cmd: 'pasteStyle' }, ...(L.effects ? [{ label: 'Clear Layer Style', cmd: 'clearStyle' }] : []), '-',
    { label: 'Merge Down', cmd: 'mergeDown' }, { label: 'Merge Visible', cmd: 'mergeVisible' }, { label: 'Flatten Image', cmd: 'flatten' }, '-',
    { label: 'Color', sub: [['none', 'No Color'], ['#e04a4a', 'Red'], ['#e8913a', 'Orange'], ['#e7d23d', 'Yellow'], ['#5fbf4a', 'Green'], ['#4a8be0', 'Blue'], ['#9a5ce0', 'Violet'], ['#8a8a8a', 'Gray']].map(([c, n]) => ({ label: n, run: () => { L.colorTag = c === 'none' ? null : c; app.doc.commit('Layer Color', 'layers'); } })) },
    '-', { label: 'Remove Background', cmd: 'removeBackground' }, { label: 'Select Subject', cmd: 'selectSubject' },
  ];
}

// ---------- Adjustments panel ----------
function adjustmentsPanel(body) {
  body.append(el('div', { style: { padding: '8px 10px 0', color: 'var(--text2)' } }, 'Add an adjustment'));
  const g = el('div', { class: 'adjgrid' });
  for (const a of ADJUSTMENT_TYPES) g.append(el('button', { class: 'ibtn', title: a.name, html: ADJ_ICON[a.type] || ICONS.adjust, onclick: () => cmd('newAdjustmentLayer', a.type) }));
  body.append(g);
  body.append(el('div', { style: { padding: '4px 10px', color: 'var(--text2)' } }, 'Fill layers'));
  const g2 = el('div', { class: 'adjgrid' });
  g2.append(el('button', { class: 'ibtn', title: 'Solid Color', html: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor"/></svg>', onclick: () => cmd('newFillLayer', 'solid') }));
  g2.append(el('button', { class: 'ibtn', title: 'Gradient', html: ICONS.gradient, onclick: () => cmd('newFillLayer', 'gradient') }));
  body.append(g2);
}

// ---------- Properties ----------
function propertiesPanel(body) {
  const wrap = el('div', { class: 'props' });
  body.append(wrap);
  let lastKey = '';
  const render = (force) => {
    const d = app.doc, L = d?.active;
    const key = (d?.id || '') + ':' + (L?.id || '') + ':' + (L?.kind || '') + ':' + app.maskEdit + ':' + (L?.data?.type || '') + ':' + (L?.generative ? L.generative.variants.length + ':' + L.generative.index : '') + (L?.mask ? 'm' : '');
    if (!force && key === lastKey) return;
    lastKey = key;
    wrap.innerHTML = '';
    if (!d) { wrap.append(el('div', { class: 'muted' }, 'No properties')); return; }
    if (!L) return docProps(wrap, d);
    if (app.maskEdit && L.mask) return maskProps(wrap, d, L);
    if (L.kind === 'adjustment') return renderAdjustmentUI(wrap, d, L, ADJ_ICON);
    if (L.kind === 'text') return textProps(wrap, d, L);
    if (L.kind === 'shape') return shapeProps(wrap, d, L);
    if (L.kind === 'fill') return fillProps(wrap, d, L);
    if (L.kind === 'smart') return smartProps(wrap, d, L);
    if (L.generative) genProps(wrap, d, L);
    return pixelProps(wrap, d, L);
  };
  render(true);
  const offs = [app.on('doc', () => render(true)), app.on('maskedit', () => render(true)), app.on('layers-sel', () => render())];
  let docOff;
  const bind = () => { docOff && docOff(); const d = app.doc; if (!d) return; const a = d.on('layers', () => render()), b = d.on('history', () => render(true)), c = d.on('resize', () => render(true)); docOff = () => { a(); b(); c(); }; };
  bind(); offs.push(app.on('doc', bind));
  body._cleanup = () => { offs.forEach(f => f()); docOff && docOff(); };
}
const h4 = (icon, t) => el('h4', {}, icon ? el('span', { class: 'ico', html: icon, style: { width: '16px', height: '16px' } }) : null, t);
function docProps(w, d) {
  w.append(h4(ICONS.newFile, 'Document'));
  w.append(el('div', { class: 'grid2' }, el('label', {}, 'W', el('input', { type: 'text', value: d.width + ' px', disabled: true })), el('label', {}, 'H', el('input', { type: 'text', value: d.height + ' px', disabled: true }))));
  w.append(el('div', { class: 'row' }, el('label', {}, 'Resolution'), el('span', {}, d.resolution + ' pixels/inch')));
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => cmd('imageSize') }, 'Image Size'), el('button', { class: 'btn', onclick: () => cmd('canvasSize') }, 'Canvas Size'), el('button', { class: 'btn', onclick: () => cmd('setTool', 'crop') }, 'Crop')));
}
function transformRows(w, d, L) {
  const b = L.bounds() || { x: 0, y: 0, w: 0, h: 0 };
  w.append(h4(ICONS.transform, 'Transform'));
  const move = (dx, dy) => { cmd('translateActive', dx, dy); };
  w.append(el('div', { class: 'grid2' },
    el('label', {}, 'W', el('input', { type: 'text', value: b.w + ' px', disabled: true })), el('label', {}, 'H', el('input', { type: 'text', value: b.h + ' px', disabled: true })),
    numField({ label: 'X', value: b.x, width: 70, unit: 'px', onChange: (v) => move(v - b.x, 0) }), numField({ label: 'Y', value: b.y, width: 70, unit: 'px', onChange: (v) => move(0, v - b.y) })));
  w.append(el('div', { class: 'btnrow' },
    el('button', { class: 'ibtn', title: 'Flip Horizontal', html: ICONS.flipH, onclick: () => cmd('transformOp', 'flipH') }),
    el('button', { class: 'ibtn', title: 'Flip Vertical', html: ICONS.flipV, onclick: () => cmd('transformOp', 'flipV') }),
    el('button', { class: 'ibtn', title: 'Rotate 90° Clockwise', html: ICONS.rotate, onclick: () => cmd('transformOp', 'rot90') }),
    el('button', { class: 'btn', onclick: () => cmd('freeTransform') }, 'Free Transform')));
}
function pixelProps(w, d, L) {
  w.append(h4(ICONS.layers, L.kind === 'group' ? 'Group' : 'Pixel Layer'));
  if (L.kind !== 'group') transformRows(w, d, L);
  w.append(h4(ICONS.sparkle, 'Quick Actions'));
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => cmd('removeBackground') }, 'Remove Background'), el('button', { class: 'btn', onclick: () => cmd('selectSubject') }, 'Select Subject')));
}
function smartProps(w, d, L) {
  w.append(h4(ICONS.smart, 'Embedded Smart Object'));
  w.append(el('div', { class: 'muted' }, `${L.smart.name || L.name} — ${L.smart.cache.width} × ${L.smart.cache.height} px`));
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', onclick: () => cmd('editContents') }, 'Edit Contents'), el('button', { class: 'btn', onclick: () => cmd('replaceContents') }, 'Replace…'), el('button', { class: 'btn', onclick: () => cmd('resetTransform') }, 'Reset Transform')));
  const sx = Math.hypot(L.tx[0], L.tx[1]), sy = Math.hypot(L.tx[2], L.tx[3]), ang = Math.atan2(L.tx[1], L.tx[0]) * 180 / Math.PI;
  w.append(el('div', { class: 'muted' }, `Scale ${(sx * 100).toFixed(1)}% × ${(sy * 100).toFixed(1)}%, angle ${ang.toFixed(1)}°`));
  transformRows(w, d, L);
  if (L.smartFilters?.length) w.append(h4(ICONS.liquify, 'Smart Filters'), el('div', { class: 'muted' }, L.smartFilters.length + ' filter(s) — double-click a filter in the Layers panel to edit it.'));
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => cmd('rasterizeSmart') }, 'Convert to Layers / Rasterize')));
}
function maskProps(w, d, L) {
  w.append(h4(ICONS.mask, 'Layer Mask'));
  w.append(el('div', { class: 'btnrow' },
    el('button', { class: 'btn', onclick: () => cmd('invertMask') }, 'Invert'),
    el('button', { class: 'btn', onclick: () => cmd('maskFeather') }, 'Feather…'),
    el('button', { class: 'btn', onclick: () => cmd('maskFromSelection') }, 'Selection → Mask'),
    el('button', { class: 'btn', onclick: () => cmd('loadMaskSelection') }, 'Mask → Selection')));
  w.append(el('div', { class: 'btnrow' },
    el('button', { class: 'btn', onclick: () => cmd('applyMask') }, 'Apply'),
    el('button', { class: 'btn', onclick: () => cmd('toggleMask') }, L.mask.enabled === false ? 'Enable' : 'Disable'),
    el('button', { class: 'btn', onclick: () => cmd('deleteMask') }, 'Delete')));
  w.append(el('div', { class: 'muted' }, 'Paint with black to hide, white to reveal. Click the layer thumbnail to go back to editing pixels.'));
}
function textProps(w, d, L) {
  const t = L.data;
  const commit = debounce(() => { L.touch(); d.commit('Character Change', 'type'); }, 350);
  const ch = (k, v) => { t[k] = v; L.touch(); d.invalidate(); commit(); };
  w.append(h4(ICONS.type, 'Character'));
  const fontSel = selectEl(app.fonts.map(f => [f, f]), t.font, (v) => ch('font', v)); fontSel.style.width = '100%';
  w.append(fontSel);
  w.append(el('div', { class: 'grid2' },
    numField({ label: 'Size', value: t.size, min: 1, max: 5000, unit: 'px', width: 60, onInput: (v) => ch('size', v) }),
    numField({ label: 'Leading', value: t.leading || 0, min: 0, max: 5000, unit: 'px', width: 60, onInput: (v) => ch('leading', v) }),
    numField({ label: 'Tracking', value: t.tracking || 0, min: -1000, max: 10000, width: 60, onInput: (v) => ch('tracking', v) }),
    el('label', {}, 'Color', colorEl(t.color, (v) => ch('color', v), (v) => { t.color = v; L.touch(); d.invalidate(); }))));
  const tb = (k, label, title) => el('button', { class: 'btn' + (t[k] ? ' primary' : ''), title, onclick: () => { ch(k, !t[k]); app.emit('layers-sel'); w.parentNode && propsRefresh(); } }, label);
  w.append(el('div', { class: 'btnrow' }, tb('bold', 'B', 'Faux Bold'), tb('italic', 'I', 'Faux Italic'), tb('underline', 'U', 'Underline'), tb('strike', 'S', 'Strikethrough'),
    ...['left', 'center', 'right'].map(a => el('button', { class: 'ibtn' + ((t.align || 'left') === a ? ' on' : ''), html: ICONS['text' + a[0].toUpperCase() + a.slice(1)], onclick: () => { ch('align', a); propsRefresh(); } }))));
  const ta = el('textarea', { rows: 3, style: { width: '100%', resize: 'vertical' } }); ta.value = t.text;
  ta.oninput = () => { t.text = ta.value; if (!L.userNamed) L.name = (ta.value.split('\n')[0] || 'Layer').slice(0, 40); L.touch(); d.invalidate(); commit(); d.emit('layers'); };
  ta.onkeydown = (e) => e.stopPropagation();
  w.append(h4(null, 'Text'), ta);
  transformRows(w, d, L);
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn', onclick: () => cmd('rasterize') }, 'Rasterize Type Layer')));
}
let propsRefresh = () => {};
function shapeProps(w, d, L) {
  const s = L.data;
  const commit = debounce(() => d.commit('Shape Properties', 'rect'), 350);
  const ch = (k, v) => { s[k] = v; L.touch(); d.invalidate(); commit(); };
  w.append(h4(ICONS.rect, 'Shape Properties'));
  if (s.shape !== 'path') w.append(el('div', { class: 'grid2' }, numField({ label: 'W', value: Math.round(Math.abs(s.w)), min: 1, max: 30000, unit: 'px', width: 64, onChange: (v) => ch('w', v * Math.sign(s.w || 1)) }), numField({ label: 'H', value: Math.round(Math.abs(s.h)), min: 1, max: 30000, unit: 'px', width: 64, onChange: (v) => ch('h', v * Math.sign(s.h || 1)) })));
  w.append(el('div', { class: 'row' }, el('label', {}, 'Fill'), colorEl(s.fill || '#000000', (v) => ch('fill', v), (v) => { s.fill = v; L.touch(); d.invalidate(); }), checkEl('None', !s.fill, (v) => ch('fill', v ? null : app.fg))));
  w.append(el('div', { class: 'row' }, el('label', {}, 'Stroke'), colorEl(s.stroke || '#000000', (v) => ch('stroke', v), (v) => { s.stroke = v; L.touch(); d.invalidate(); }), checkEl('None', !s.stroke, (v) => ch('stroke', v ? null : '#000000'))));
  w.append(sliderRow({ label: 'Stroke width', value: s.strokeWidth || 0, min: 0, max: 200, onInput: (v) => { s.strokeWidth = v; L.touch(); d.invalidate(); }, onChange: (v) => ch('strokeWidth', v) }));
  if (s.shape === 'rect') w.append(sliderRow({ label: 'Corner radius', value: s.radius || 0, min: 0, max: 1000, onInput: (v) => { s.radius = v; L.touch(); d.invalidate(); }, onChange: (v) => ch('radius', v) }));
  if (s.shape === 'polygon' || s.shape === 'star') w.append(sliderRow({ label: s.shape === 'star' ? 'Points' : 'Sides', value: s.sides || 5, min: 3, max: 64, onInput: (v) => { s.sides = v; L.touch(); d.invalidate(); }, onChange: (v) => ch('sides', v) }));
  if (s.shape === 'star') w.append(sliderRow({ label: 'Indent', value: Math.round((s.inner ?? .5) * 100), min: 1, max: 99, unit: '%', onInput: (v) => { s.inner = v / 100; L.touch(); d.invalidate(); }, onChange: (v) => ch('inner', v / 100) }));
  transformRows(w, d, L);
}
function fillProps(w, d, L) {
  const f = L.data;
  const commit = debounce(() => d.commit('Fill Layer', 'adjust'), 350);
  const ch = (k, v) => { f[k] = v; L.touch(); d.invalidate(); commit(); };
  w.append(h4(null, f.fillType === 'gradient' ? 'Gradient Fill' : 'Solid Color Fill'));
  if (f.fillType === 'gradient') {
    w.append(el('div', { class: 'row' }, el('label', {}, 'Gradient'), selectEl(GRADIENT_PRESETS.map((g, k) => [k, g.name]), f.preset ?? 2, (v) => { f.preset = Number(v); const p = GRADIENT_PRESETS[v]; ch('stops', p.stops === 'fgbg' ? [{ pos: 0, color: app.fg }, { pos: 1, color: app.bg }] : p.stops === 'fgtrans' ? [{ pos: 0, color: app.fg }, { pos: 1, color: app.fg, alpha: 0 }] : p.stops); })));
    w.append(el('div', { class: 'row' }, el('label', {}, 'Style'), selectEl([['linear', 'Linear'], ['radial', 'Radial'], ['angle', 'Angle'], ['reflected', 'Reflected'], ['diamond', 'Diamond']], f.type || 'linear', (v) => ch('type', v))));
    w.append(sliderRow({ label: 'Angle', value: f.angle ?? 90, min: -180, max: 180, unit: '°', onInput: (v) => { f.angle = v; L.touch(); d.invalidate(); }, onChange: (v) => ch('angle', v) }));
    w.append(sliderRow({ label: 'Scale', value: f.scale ?? 100, min: 10, max: 150, unit: '%', onInput: (v) => { f.scale = v; L.touch(); d.invalidate(); }, onChange: (v) => ch('scale', v) }));
    w.append(checkEl('Reverse', f.reverse, (v) => ch('reverse', v)));
  } else w.append(el('div', { class: 'row' }, el('label', {}, 'Color'), colorEl(f.color, (v) => ch('color', v), (v) => { f.color = v; L.touch(); d.invalidate(); })));
}
function genProps(w, d, L) {
  const G = L.generative;
  w.append(h4(ICONS.sparkle, 'Generative Layer'));
  const ta = el('textarea', { rows: 2, style: { width: '100%' }, placeholder: 'Describe what to generate (optional)' }); ta.value = G.prompt || '';
  ta.onkeydown = (e) => e.stopPropagation();
  w.append(ta);
  w.append(el('div', { class: 'btnrow' }, el('button', { class: 'btn primary', onclick: () => cmd('generateMore', L.id, ta.value) }, 'Generate')));
  const v = el('div', { class: 'variants' });
  G.variants.forEach((c, k) => { const t = createCanvas(90, 90), g = ctx2d(t); const s = Math.max(90 / c.width, 90 / c.height); g.drawImage(c, (90 - c.width * s) / 2, (90 - c.height * s) / 2, c.width * s, c.height * s); t.className = k === G.index ? 'on' : ''; t.title = 'Variation ' + (k + 1); t.onclick = () => cmd('pickVariant', L.id, k); v.append(t); });
  w.append(el('div', { class: 'muted' }, `Variations (${G.variants.length})`), v);
}

// ---------- Channels ----------
function channelsPanel(body) {
  const list = el('div', { class: 'chan' }); body.append(list);
  const render = debounce(() => {
    const d = app.doc; list.innerHTML = ''; if (!d) return;
    const comp = d.render();
    const s = Math.min(34 / d.width, 30 / d.height), tw = Math.max(1, Math.round(d.width * s)), th = Math.max(1, Math.round(d.height * s));
    const small = createCanvas(tw, th); ctx2d(small).drawImage(comp, 0, 0, tw, th);
    const px = ctx2d(small).getImageData(0, 0, tw, th);
    const mk = (ch) => { const c = createCanvas(tw, th), id = new ImageData(new Uint8ClampedArray(px.data), tw, th), k = { r: 0, g: 1, b: 2 }[ch]; if (k != null) for (let i = 0; i < id.data.length; i += 4) { const v = id.data[i + k]; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; } ctx2d(c).putImageData(id, 0, 0); return c; };
    for (const [ch, name, key] of [['rgb', 'RGB', 'Ctrl+2'], ['r', 'Red', 'Ctrl+3'], ['g', 'Green', 'Ctrl+4'], ['b', 'Blue', 'Ctrl+5']]) {
      const row = el('div', { class: 'it' + ((d.channelView || 'rgb') === ch ? ' on' : ''), onclick: () => { d.channelView = ch; d.invalidate(); render(); } }, el('div', { class: 'vis', style: { width: '26px', display: 'grid', placeItems: 'center' }, html: ICONS.eye }), mk(ch), el('span', {}, name), el('span', { class: 'k' }, key));
      list.append(row);
    }
    if (d.selection) {
      const c = createCanvas(tw, th), g = ctx2d(c); g.fillStyle = '#000'; g.fillRect(0, 0, tw, th); g.drawImage(d.selection, 0, 0, tw, th);
      list.append(el('div', { class: 'it' }, el('div', { style: { width: '26px' } }), c, el('span', {}, 'Selection')));
    }
  }, 200);
  render();
  const offs = [app.on('doc', render), app.on('render', render), app.on('selection', render)];
  body._cleanup = () => offs.forEach(f => f());
}

// ---------- Paths ----------
function pathsPanel(body) {
  const list = el('div', { class: 'chan' }); body.append(list);
  const fb = (icon, title, c, ...a) => el('button', { class: 'ibtn', title, html: ICONS[icon], onclick: () => cmd(c, ...a) });
  body.append(el('div', { class: 'pfoot' }, fb('bucket', 'Fill path with foreground color', 'fillPath'), fb('brush', 'Stroke path with brush', 'strokePath', 'brush'), fb('marqueeEllipse', 'Load path as a selection', 'pathToSelection'), fb('paths', 'Make work path from selection', 'selectionToPath', 2), fb('mask', 'Add a vector mask', 'addVectorMask'), fb('plus', 'Create new path', 'newPath'), fb('trash', 'Delete path', 'deletePath')));
  const render = () => {
    const d = app.doc; list.innerHTML = ''; if (!d) return;
    const rows = [...(d.paths || [])];
    const L = d.active;
    if (L && L.kind === 'shape') rows.unshift({ id: '__shape', name: L.name + ' Shape Path', temp: true, subpaths: null, layer: L });
    if (L && L.vmask) rows.unshift({ id: '__vmask', name: L.name + ' Vector Mask', temp: true, subpaths: L.vmask.subpaths });
    for (const p of rows) {
      const c = createCanvas(34, 30), g = ctx2d(c), sc = Math.min(34 / d.width, 30 / d.height);
      g.fillStyle = '#fff'; g.fillRect(0, 0, 34, 30); g.save(); g.translate((34 - d.width * sc) / 2, (30 - d.height * sc) / 2); g.scale(sc, sc);
      const sp = p.subpaths || (p.layer ? pathTarget(d)?.get() : null);
      if (sp) { g.fillStyle = '#777'; g.fill(buildPath2D(sp)); g.lineWidth = 1 / sc; g.strokeStyle = '#333'; g.stroke(buildPath2D(sp)); }
      g.restore();
      const row = el('div', { class: 'it' + (d.activePathId === p.id ? ' on' : ''), onclick: () => { if (!p.temp) cmd('selectPath', p.id); } }, el('div', { style: { width: '8px' } }), c, el('span', { style: { fontStyle: p.kind === 'work' || p.temp ? 'italic' : 'normal' } }, p.name));
      row.ondblclick = () => { if (!p.temp) cmd(p.kind === 'work' ? 'savePath' : 'renamePath', p.id); };
      row.oncontextmenu = (e) => { e.preventDefault(); if (p.temp) return; cmd('selectPath', p.id); showMenu([{ label: 'Save Path…', cmd: 'savePath' }, { label: 'Duplicate Path', cmd: 'duplicatePath' }, { label: 'Delete Path', cmd: 'deletePath' }, '-', { label: 'Make Selection…', cmd: 'pathToSelectionDialog' }, { label: 'Fill Path', cmd: 'fillPath' }, { label: 'Stroke Path…', cmd: 'strokePathDialog' }, '-', { label: 'Add Vector Mask to Layer', cmd: 'addVectorMask' }], e.clientX, e.clientY); };
      list.append(row);
    }
    if (!rows.length) list.append(el('div', { style: { padding: '12px', color: 'var(--text3)' } }, 'No paths. Draw with the Pen tool (P) in Path mode, or make a work path from a selection.'));
  };
  render();
  let off; const bind = () => { off && off(); const d = app.doc; render(); if (!d) return; const a = d.on('paths', render), b = d.on('history', render), c = d.on('layers', render); off = () => { a(); b(); c(); }; };
  bind(); const o2 = app.on('doc', bind);
  body._cleanup = () => { off && off(); o2(); };
  body.addEventListener('click', (e) => { if (e.target === body || e.target === list) { const d = app.doc; if (d) { d.activePathId = null; d.emit('paths'); } } });
}

// ---------- Actions ----------
function actionsPanel(body) {
  const list = el('div', { class: 'hist', style: { flex: 1, overflow: 'auto' } }); body.append(list);
  const fb = (icon, title, fn, cls = '') => el('button', { class: 'ibtn ' + cls, title, html: ICONS[icon], onclick: fn });
  const foot = el('div', { class: 'pfoot' });
  body.append(foot);
  const open = app._openActions || (app._openActions = new Set(['set-default']));
  const render = () => {
    list.innerHTML = ''; foot.innerHTML = '';
    foot.append(fb('stop', 'Stop playing/recording', () => cmd('actionStop')), fb('record', 'Begin recording', () => cmd('actionRecord'), app.recording ? 'on' : ''), fb('play', 'Play selection', () => cmd('actionPlay')), el('span', { class: 'grow' }), fb('folder', 'Create new set', () => cmd('actionNewSet')), fb('plus', 'Create new action', () => cmd('actionNew')), fb('trash', 'Delete', () => cmd('actionDelete')));
    if (app.recording) foot.querySelector('.on').style.color = '#ff5050';
    for (const set of app.actionSets) {
      const so = open.has(set.id);
      list.append(el('div', { class: 'it', onclick: () => { so ? open.delete(set.id) : open.add(set.id); app.selectedSet = set.id; render(); } }, el('span', { class: 'ico', html: so ? ICONS.chevronDown : ICONS.chevronRight }), el('span', { class: 'ico', html: ICONS.folder }), set.name));
      if (!so) continue;
      for (const a of set.actions) {
        const ao = open.has(a.id);
        const row = el('div', { class: 'it' + (app.selectedAction === a.id ? ' on' : ''), style: { paddingLeft: '22px' }, onclick: () => { app.selectedAction = a.id; app.selectedSet = set.id; render(); }, ondblclick: async () => { const { promptBox } = await import('./common.js'); const n = await promptBox('Name:', a.name, 'Action Options'); if (n) { a.name = n; saveActions(); } } },
          el('span', { class: 'ico', html: ao ? ICONS.chevronDown : ICONS.chevronRight, onclick: (e) => { e.stopPropagation(); ao ? open.delete(a.id) : open.add(a.id); render(); } }), el('span', {}, a.name), el('span', { class: 'grow' }), app.recording === a.id ? el('span', { style: { color: '#ff5050', fontSize: '10px' } }, '● REC') : null);
        list.append(row);
        if (!ao) continue;
        a.steps.forEach((st, k) => {
          const chk = el('input', { type: 'checkbox', checked: st.on !== false, onclick: (e) => { e.stopPropagation(); st.on = chk.checked; saveActions(); } });
          const srow = el('div', { class: 'it', style: { paddingLeft: '44px', height: '22px', fontSize: '11px', color: 'var(--text2)' }, ondblclick: () => cmd('actionPlay', a.id, k) }, chk, stepLabel(st));
          srow.oncontextmenu = (e) => { e.preventDefault(); showMenu([{ label: 'Play This Step', run: () => cmd('actionPlay', a.id, k) }, { label: 'Delete Step', run: () => { a.steps.splice(k, 1); saveActions(); } }, { label: 'Move Up', enabled: () => k > 0, run: () => { a.steps.splice(k - 1, 0, a.steps.splice(k, 1)[0]); saveActions(); } }], e.clientX, e.clientY); };
          list.append(srow);
        });
      }
    }
  };
  render();
  const off = app.on('actions', render);
  body._cleanup = off;
  body._menu = () => [{ label: 'New Action…', cmd: 'actionNew' }, { label: 'New Set…', cmd: 'actionNewSet' }, { label: 'Duplicate', cmd: 'actionDuplicate' }, { label: 'Delete', cmd: 'actionDelete' }, '-', { label: 'Start Recording', cmd: 'actionRecord' }, { label: 'Stop Recording', cmd: 'actionStop' }, { label: 'Play', cmd: 'actionPlay' }, '-', { label: 'Batch…', cmd: 'batch' }, '-', { label: 'Load Actions…', cmd: 'actionsImport' }, { label: 'Save Actions…', cmd: 'actionsExport' }, { label: 'Reset Actions', cmd: 'actionsReset' }];
}

// ---------- History ----------
const HIST_ICON = { new: 'newFile', open: 'open' };
function historyPanel(body) {
  const list = el('div', { class: 'hist' }); body.append(list);
  const foot = el('div', { class: 'pfoot' }, el('button', { class: 'ibtn', title: 'Create new snapshot', html: ICONS.camera, onclick: () => cmd('snapshot') }), el('button', { class: 'ibtn', title: 'Delete current state', html: ICONS.trash, onclick: () => cmd('deleteHistoryState') }));
  body.append(foot);
  const render = () => {
    const d = app.doc; list.innerHTML = ''; if (!d) return;
    for (const s of (d.snapshots || [])) {
      const c = s.thumb;
      list.append(el('div', { class: 'snap', onclick: () => cmd('restoreSnapshot', s) }, el('div', { class: 'vis', style: { width: '16px' }, html: app.historySourceSnap === s ? ICONS.historyBrush : '' }), c, el('span', {}, s.name)));
    }
    d.history.forEach((h, k) => {
      const src = el('span', { class: 'ico', title: 'Set the source for the history brush', html: (app.historySource ?? 0) === k ? ICONS.historyBrush : '', style: { width: '16px', cursor: 'pointer' } });
      src.onclick = (e) => { e.stopPropagation(); app.historySource = k; render(); };
      const it = el('div', { class: 'it' + (k === d.hIndex ? ' on' : '') + (k > d.hIndex ? ' future' : ''), onclick: () => d.goto(k) }, src, el('span', { class: 'ico', html: ICONS[HIST_ICON[h.icon] || h.icon] || ICONS.history }), h.name);
      list.append(it);
    });
    const on = list.querySelector('.it.on'); if (on) on.scrollIntoView({ block: 'nearest' });
  };
  render();
  let off;
  const bind = () => { off && off(); const d = app.doc; render(); if (!d) return; off = d.on('history', render); };
  bind();
  const o2 = app.on('doc', bind);
  body._cleanup = () => { off && off(); o2(); };
}

// ---------- init ----------
const mountWrap = (fn) => (body) => { fn(body); };
export function initPanels() {
  const root = $('#panels');
  const g1 = panelGroup([{ id: 'color', title: 'Color', mount: colorPanel }, { id: 'swatches', title: 'Swatches', mount: swatchesPanel }, { id: 'navigator', title: 'Navigator', mount: navigatorPanel }, { id: 'info', title: 'Info', mount: infoPanel }, { id: 'histogram', title: 'Histogram', mount: histogramPanel }], { height: 205 });
  const g2 = panelGroup([{ id: 'properties', title: 'Properties', mount: propertiesPanel }, { id: 'adjustments', title: 'Adjustments', mount: adjustmentsPanel }, { id: 'brush', title: 'Brush Settings', mount: brushSettingsPanel }], { height: 300 });
  const g3 = panelGroup([{ id: 'layers', title: 'Layers', mount: layersPanel, menu: () => layerContextMenu(app.doc?.active) }, { id: 'channels', title: 'Channels', mount: channelsPanel }, { id: 'paths', title: 'Paths', mount: pathsPanel }, { id: 'history', title: 'History', mount: historyPanel }, { id: 'actions', title: 'Actions', mount: actionsPanel, menu: () => app._actionsMenu?.() }], { flex: true });
  root.append(g1, g2, g3);
  // cleanup previous mounts on tab switch
  app.on('show-panel', (id) => { for (const g of [g1, g2, g3]) g.show(id); });
  // panel width resize
  const rz = $('#panel-resizer');
  rz.addEventListener('pointerdown', (e) => { const w0 = root.getBoundingClientRect().width, x0 = e.clientX; const mv = (ev) => { root.style.width = clamp(w0 - (ev.clientX - x0), 220, 560) + 'px'; }; const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); }; addEventListener('pointermove', mv); addEventListener('pointerup', up); });
  try { app.swatches = JSON.parse(localStorage.getItem('strata.swatches') || '[]'); } catch { app.swatches = []; }
  // recent colors
  let lastFg = app.fg;
  app.on('colors', debounce(() => { if (app.fg !== lastFg) { lastFg = app.fg; app.recentColors = [app.fg, ...(app.recentColors || []).filter(c => c !== app.fg)].slice(0, 18); } }, 600));
  propsRefresh = () => app.emit('props-refresh');
  app.on('props-refresh', () => { if (g2.current() === 'properties') g2.show('properties'); });
  app.on('newAdjustment', () => g2.show('properties'));
}

import { FILTERS as __F } from '../engine/filters.js';
import { ADJUSTMENT_TYPES as __A } from '../engine/adjust.js';
const FILTER_NAMES = Object.fromEntries(Object.entries(__F).map(([k, f]) => [k, f.name]));
const ADJ_NAMES = Object.fromEntries(__A.map(a => [a.type, a.name.replace('…', '')]));
