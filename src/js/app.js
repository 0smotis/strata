// Strata — renderer entry
import { app, cmd, setActiveDoc } from './state.js';
import { el, $, $$, clamp, fmtPct } from './util.js';
import { ICONS } from './icons.js';
import { showMenu, closeMenus, menuOpen, toast } from './ui/common.js';
import { initViewport, requestDraw, setSpace, vp, toScreen, fitOnScreen } from './view/viewport.js';
import { tools } from './tools/base.js';
import './tools/paint.js';
import './tools/select.js';
import './tools/misc.js';
import './tools/pen.js';
import './tools/artboard.js';
import { loadFonts } from './tools/misc.js';
import { initToolbar, setTool, cycleKey } from './ui/toolbar.js';
import { initOptionsBar } from './ui/optionsbar.js';
import { initPanels } from './ui/panels.js';
import { MENUS, SHORTCUTS, openPaths, addDoc, allCommandEntries, placeCanvas } from './commands.js';
import { newDocument } from './doc/document.js';
import { canvasFromBytes } from './doc/io.js';
import './ai/ai.js';
import './commands2.js';
import './commands3.js';
import { initTimeline } from './ui/timeline.js';
import { buildPath2D } from './doc/paths.js';
app._buildPath2D = buildPath2D;

app.tools = tools;
window.app = app; // for debugging

// ---------- menu bar ----------
function initMenubar() {
  const bar = $('#menubar');
  let open = null;
  for (const [name, items] of MENUS) {
    const mi = el('div', { class: 'mi' }, name);
    const show = () => { const r = mi.getBoundingClientRect(); $$('.mi', bar).forEach(m => m.classList.remove('open')); mi.classList.add('open'); open = mi; showMenu(items, r.left, r.bottom, 0, () => { mi.classList.remove('open'); if (open === mi) open = null; }); };
    mi.addEventListener('pointerdown', (e) => { e.preventDefault(); if (open === mi) { closeMenus(); return; } show(); });
    mi.addEventListener('pointerenter', () => { if (open && open !== mi) show(); });
    bar.append(mi);
  }
}

// ---------- tabs ----------
function renderTabs() {
  const t = $('#tabs'); t.innerHTML = '';
  for (const d of app.docs) {
    const L = d.active;
    const title = `${d.name} @ ${fmtPct(d.view.zoom)} (${L ? L.name : ''}${app.maskEdit && L?.mask && d === app.doc ? ', Layer Mask' : ''}, RGB/8)${d.dirty ? '*' : ''}`;
    const tab = el('div', { class: 'tab' + (d === app.doc ? ' on' : ''), title: d.path || d.name, onclick: () => setActiveDoc(d), onauxclick: (e) => { if (e.button === 1) { setActiveDoc(d); cmd('close'); } } },
      el('span', { class: 'nm' }, title), el('span', { class: 'x', html: ICONS.close, onclick: (e) => { e.stopPropagation(); setActiveDoc(d); cmd('close'); } }));
    t.append(tab);
  }
  const d = app.doc;
  const wt = d ? `${d.name}${d.dirty ? '*' : ''} — Strata` : 'Strata';
  document.title = wt; window.host.setTitle(wt);
}

// ---------- home screen ----------
function renderHome() {
  const h = $('#home');
  if (app.docs.length) { h.classList.add('hidden'); return; }
  h.classList.remove('hidden');
  const quick = [['Default Strata Size', 2100, 1500, 300], ['Letter', 2550, 3300, 300], ['Web Large', 1920, 1080, 72], ['Instagram Post', 1080, 1080, 72], ['Instagram Story', 1080, 1920, 72], ['UHD 4K', 3840, 2160, 72]];
  h.innerHTML = '';
  const side = el('div', { class: 'side' },
    el('button', { class: 'btn primary', onclick: () => cmd('newDoc') }, el('span', { class: 'ico', html: ICONS.newFile }), 'New file'),
    el('button', { class: 'btn', onclick: () => cmd('open') }, el('span', { class: 'ico', html: ICONS.open }), 'Open'),
    el('div', { style: { height: '20px' } }),
    el('button', { class: 'btn quiet', onclick: () => cmd('preferences') }, el('span', { class: 'ico', html: ICONS.settings }), 'Preferences'),
    el('button', { class: 'btn quiet', onclick: () => cmd('shortcuts') }, el('span', { class: 'ico', html: ICONS.info }), 'Keyboard shortcuts'));
  const mainCol = el('div', {}, el('h1', {}, 'Welcome to Strata'),
    el('h2', {}, 'Start a new file fast'),
    el('div', { class: 'quick' }, ...quick.map(([n, w, hh, r]) => { const s = 64 / Math.max(w, hh); return el('div', { class: 'qp', onclick: () => addDoc(newDocument({ width: w, height: hh, resolution: r, name: 'Untitled-' + (app.docs.length + 1) })) }, el('div', { class: 'shape' }, el('div', { style: { width: w * s + 'px', height: hh * s + 'px' } })), el('span', {}, n), el('small', {}, `${w} × ${hh} px`)); })),
    el('h2', {}, 'Recent'),
    app.recent.length ? el('div', { class: 'recent' }, ...app.recent.slice(0, 12).map(p => el('div', { class: 'r', onclick: () => openPaths([p]) }, el('span', { class: 'ico', html: ICONS.newFile }), p.split(/[\\/]/).pop(), el('small', {}, p.replace(/[^\\/]+$/, ''))))) : el('div', { style: { color: 'var(--text3)' } }, 'Files you open will show up here.'),
    el('div', { class: 'drop' }, 'Drag and drop images or PSDs anywhere to open them'));
  h.append(el('div', { class: 'home' }, side, mainCol));
}

// ---------- contextual task bar ----------
function renderTaskbar() {
  const tb = $('#taskbar'), d = app.doc;
  if (!d || app.transform || app.modalOpen || app.settings.taskbar === false) { tb.classList.add('hidden'); return; }
  if (tb.contains(document.activeElement)) return;
  tb.innerHTML = '';
  const B = (label, icon, fn, cls = '') => el('button', { class: 'btn ' + cls, onclick: fn }, icon ? el('span', { class: 'ico', html: ICONS[icon] }) : null, label);
  if (d.selection) {
    const inp = el('input', { class: 'prompt', placeholder: 'Describe what to generate (optional)', onkeydown: (e) => { e.stopPropagation(); if (e.key === 'Enter') cmd('generativeFill', inp.value); if (e.key === 'Escape') inp.blur(); } });
    tb.append(el('div', { class: 'drag-h' }), B('Generative Fill', 'sparkle', () => { if (tb.dataset.prompt) cmd('generativeFill', inp.value); else { tb.dataset.prompt = '1'; renderTaskbar(); } }, 'gen'));
    if (tb.dataset.prompt) { tb.innerHTML = ''; tb.append(el('div', { class: 'drag-h' }), inp, B('Generate', 'sparkle', () => cmd('generativeFill', inp.value), 'gen'), el('button', { class: 'ibtn', title: 'Back', html: ICONS.close, onclick: () => { delete tb.dataset.prompt; renderTaskbar(); } })); setTimeout(() => inp.focus(), 0); }
    else tb.append(el('button', { class: 'ibtn', title: 'Modify selection', html: ICONS.feather, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([{ label: 'Feather…', cmd: 'modifySel', args: ['feather'] }, { label: 'Expand…', cmd: 'modifySel', args: ['expand'] }, { label: 'Contract…', cmd: 'modifySel', args: ['contract'] }, { label: 'Smooth…', cmd: 'modifySel', args: ['smooth'] }, { label: 'Border…', cmd: 'modifySel', args: ['border'] }, '-', { label: 'Select and Mask…', cmd: 'selectAndMask' }], r.left, r.bottom + 4); } }),
      el('button', { class: 'ibtn', title: 'Invert selection', html: ICONS.invert, onclick: () => cmd('inverse') }),
      el('button', { class: 'ibtn', title: 'Create mask from selection', html: ICONS.mask, onclick: () => cmd('addMask', 'revealSel') }),
      el('button', { class: 'ibtn', title: 'Fill selection', html: ICONS.bucket, onclick: () => cmd('fill') }),
      el('button', { class: 'ibtn', title: 'Content-Aware Fill', html: ICONS.patch, onclick: () => cmd('contentAwareFill') }),
      el('button', { class: 'ibtn', title: 'Transform selection', html: ICONS.transform, onclick: () => cmd('transformSelection') }),
      el('button', { class: 'ibtn', title: 'Deselect', html: ICONS.close, onclick: () => cmd('deselect') }));
  } else {
    delete tb.dataset.prompt;
    const L = d.active;
    if (L && L.kind === 'pixel' && !['brush', 'pencil', 'eraser', 'clone', 'heal', 'spotHeal', 'removeTool'].includes(app.tool)) tb.append(el('div', { class: 'drag-h' }), B('Select subject', 'subject', () => cmd('selectSubject')), B('Remove background', 'removeBg', () => cmd('removeBackground')), el('button', { class: 'ibtn', title: 'More', html: ICONS.more, onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu([{ label: 'Select Sky', cmd: 'selectSky' }, { label: 'Add Adjustment', sub: () => [{ label: 'Curves…', cmd: 'newAdjustmentLayer', args: ['curves'] }, { label: 'Levels…', cmd: 'newAdjustmentLayer', args: ['levels'] }, { label: 'Hue/Saturation…', cmd: 'newAdjustmentLayer', args: ['hueSaturation'] }, { label: 'Black & White…', cmd: 'newAdjustmentLayer', args: ['blackWhite'] }] }, { label: 'Free Transform', cmd: 'freeTransform' }], r.left, r.bottom + 4); } }));
    else { tb.classList.add('hidden'); return; }
  }
  tb.classList.remove('hidden');
  positionTaskbar();
}
let tbPos = null;
function positionTaskbar() {
  const tb = $('#taskbar'), d = app.doc; if (!d || tb.classList.contains('hidden')) return;
  if (tbPos) { tb.style.left = tbPos.x + 'px'; tb.style.top = tbPos.y + 'px'; return; }
  const r = tb.getBoundingClientRect();
  let x, y;
  if (d.selection && d.selBounds) { const a = toScreen(d.selBounds.x + d.selBounds.w / 2, d.selBounds.y + d.selBounds.h); x = a.x - r.width / 2; y = a.y + 14; }
  else { const a = toScreen(d.width / 2, d.height); x = a.x - r.width / 2; y = a.y + 14; }
  tb.style.left = clamp(x, 8, vp.w - r.width - 8) + 'px'; tb.style.top = clamp(y, 8, vp.h - r.height - 8) + 'px';
}
function initTaskbarDrag() {
  const tb = $('#taskbar');
  tb.addEventListener('pointerdown', (e) => {
    if (!e.target.classList.contains('drag-h')) return;
    e.preventDefault(); const r = tb.getBoundingClientRect(), pr = vp.el.getBoundingClientRect(); const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const mv = (ev) => { tbPos = { x: ev.clientX - pr.left - ox, y: ev.clientY - pr.top - oy }; positionTaskbar(); };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  tb.addEventListener('pointerdown', (e) => e.stopPropagation());
  tb.addEventListener('dblclick', (e) => { if (e.target.classList.contains('drag-h')) { tbPos = null; positionTaskbar(); } });
}

// ---------- keyboard ----------
function keyName(e) {
  let k = e.key.toLowerCase();
  if (k === ' ') k = 'space'; if (k === '+') k = '+';
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl'); if (e.altKey) parts.push('alt'); if (e.shiftKey) parts.push('shift');
  // normalise shifted symbols
  if (e.code === 'BracketLeft') k = '['; if (e.code === 'BracketRight') k = ']'; if (e.code === 'Equal') k = e.shiftKey && (e.ctrlKey) ? '+' : '='; if (e.code === 'Minus') k = '-';
  if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  if (e.code === 'Quote') k = "'"; if (e.code === 'Semicolon') k = ';';
  parts.push(k);
  return parts.join('+');
}
function isTyping(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
function initKeys() {
  app.keys = {};
  window.addEventListener('keydown', (e) => {
    app.keys.ctrl = e.ctrlKey; app.keys.alt = e.altKey; app.keys.shift = e.shiftKey;
    if (app.modalOpen) return;
    if (isTyping(e)) return;
    if (menuOpen() && e.key === 'Escape') { closeMenus(); return; }
    const k = keyName(e);
    if (e.key === 'Alt') e.preventDefault();
    if (k === 'space' || e.code === 'Space') { if (!e.repeat) setSpace(true); e.preventDefault(); return; }
    // transform / tool key handlers first
    if (app.transform && app.transform.keydown && app.transform.keydown(e)) { e.preventDefault(); return; }
    const t = tools[app.tool];
    if (t && t.keydown && t.keydown(e)) { e.preventDefault(); return; }
    if (k === 'f12' && !e.ctrlKey && app.doc?.path == null) { cmd('devtools'); e.preventDefault(); return; }
    if (k === 'ctrl+shift+i' && e.altKey) return;
    // brush size / hardness
    const o = app.opts[app.tool];
    if (o && o.size != null && (e.code === 'BracketLeft' || e.code === 'BracketRight') && !e.ctrlKey && !e.altKey) {
      const up = e.code === 'BracketRight';
      if (e.shiftKey && o.hardness != null) o.hardness = clamp(Math.round((o.hardness + (up ? 0.25 : -0.25)) * 4) / 4, 0, 1);
      else { const s = o.size, step = s < 10 ? 1 : s < 50 ? 5 : s < 100 ? 10 : s < 300 ? 25 : 50; o.size = clamp(s + (up ? step : -step), 1, 5000); }
      app.emit('tool', app.tool); requestDraw(); e.preventDefault(); return;
    }
    // opacity via number keys
    if (o && o.opacity != null && /^\d$/.test(e.key) && !e.ctrlKey && !e.altKey) {
      const n = Number(e.key); const now = Date.now();
      if (app._lastDigit && now - app._lastDigit.t < 400) o.opacity = clamp(app._lastDigit.n * 10 + n, 1, 100); else o.opacity = n === 0 ? 100 : n * 10;
      app._lastDigit = { n, t: now }; app.emit('tool', app.tool); e.preventDefault(); return;
    }
    const c = SHORTCUTS[k];
    if (c) { e.preventDefault(); if (Array.isArray(c)) cmd(c[0], ...c.slice(1)); else cmd(c); return; }
    if (k === 'enter' || k === 'escape') { if (app.doc?.selection && k === 'escape' && !app.transform) {} return; }
    if (!e.ctrlKey && !e.altKey && e.key.length === 1 && cycleKey(e.key.toUpperCase(), e.shiftKey)) { e.preventDefault(); return; }
  });
  window.addEventListener('keyup', (e) => {
    app.keys.ctrl = e.ctrlKey; app.keys.alt = e.altKey; app.keys.shift = e.shiftKey;
    if (e.code === 'Space') setSpace(false);
  });
  window.addEventListener('blur', () => setSpace(false));
}

// ---------- command search ----------
function initSearch() {
  const inp = $('#cmd-search');
  let entries = null, list = null;
  const close = () => { list?.remove(); list = null; };
  inp.addEventListener('focus', () => { entries = allCommandEntries(); });
  inp.addEventListener('input', () => {
    close();
    const q = inp.value.trim().toLowerCase(); if (!q) return;
    const hits = entries.filter(e => (e.label + ' ' + e.path).toLowerCase().includes(q)).slice(0, 14);
    const toolHits = Object.values(tools).filter(t => t.label.toLowerCase().includes(q)).slice(0, 5);
    const r = inp.getBoundingClientRect();
    list = el('div', { class: 'menu', style: { left: r.left + 'px', top: r.bottom + 4 + 'px', width: '340px', position: 'fixed', pointerEvents: 'auto' } });
    for (const t of toolHits) list.append(el('div', { class: 'it', onclick: () => { setTool(t.id); inp.value = ''; close(); inp.blur(); } }, el('span', { class: 'ico', html: ICONS[t.icon] }), t.label, el('span', { class: 'k' }, 'Tool')));
    for (const h of hits) list.append(el('div', { class: 'it', onclick: () => { inp.value = ''; close(); inp.blur(); h.it.run ? h.it.run() : cmd(h.it.cmd, ...(h.it.args || [])); } }, h.label, el('span', { class: 'k' }, h.path)));
    if (!hits.length && !toolHits.length) list.append(el('div', { class: 'it dis' }, 'No results'));
    $('#menus').append(list);
  });
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { inp.value = ''; close(); inp.blur(); } if (e.key === 'Enter' && list) { const f = list.querySelector('.it:not(.dis)'); f && f.click(); } });
  inp.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- drag & drop ----------
function initDrop() {
  addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
  addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    const paths = files.map(f => window.host.pathForFile(f)).filter(Boolean);
    const overCanvas = app.doc && vp.el.contains(e.target);
    if (overCanvas && !/\.(psd|psb)$/i.test(paths[0] || '')) { // place into document
      for (const f of files) { const bytes = new Uint8Array(await f.arrayBuffer()); const c = await canvasFromBytes(bytes, f.name); placeCanvas(c, f.name.replace(/\.[^.]+$/, '')); }
      return;
    }
    if (paths.length) openPaths(paths);
  });
}

// ---------- boot ----------
async function boot() {
  try { app.settings = await window.host.getSettings(); } catch { app.settings = {}; }
  try { app.recent = await window.host.getRecent(); } catch { app.recent = []; }
  initViewport();
  initMenubar();
  initToolbar();
  initOptionsBar();
  initPanels();
  initKeys();
  initSearch();
  initDrop();
  initTaskbarDrag();
  initTimeline();
  $('#title-search .ico-s').innerHTML = ICONS.search;
  app.on('doc', () => { renderTabs(); renderHome(); renderTaskbar(); requestDraw(); app.maskEdit = app.maskEdit && !!app.doc?.active?.mask; });
  app.on('doc-meta', renderTabs);
  app.on('view', () => { renderTabs(); positionTaskbar(); });
  app.on('selection', () => { tbPos = null; renderTaskbar(); });
  app.on('transform', renderTaskbar);
  app.on('tool', renderTaskbar);
  app.on('recent', renderHome);
  let boundDoc = null, off = [];
  app.on('doc', (d) => { off.forEach(f => f()); off = []; boundDoc = d; if (!d) return; off.push(d.on('layers', () => { renderTabs(); renderTaskbar(); app.emit('layers-sel'); }), d.on('history', () => { renderTabs(); renderTaskbar(); })); });
  renderHome(); renderTabs();
  window.host.on('open-files', (ps) => openPaths(ps));
  let shownReady = null;
  window.host.on('updates:status', (st) => {
    if (st.state !== 'ready' || shownReady === st.version) return; shownReady = st.version;
    const t = el('div', { class: 'toast ok', style: { display: 'flex', alignItems: 'center', gap: '10px' } }, `Strata ${st.version} is ready to install.`, el('button', { class: 'btn primary', onclick: () => window.host.updates.install() }, 'Restart Now'), el('button', { class: 'btn quiet', onclick: () => t.remove() }, 'Later'));
    $('#toast-root').append(t);
  });
  window.host.on('request-close', async () => { for (const d of [...app.docs]) { if (!(await cmd('close'))) return; } window.host.closeConfirmed(); });
  window.addEventListener('error', (e) => console.error(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
  loadFonts();
  setTool('move');
}
boot();
