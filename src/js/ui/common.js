// Shared UI widgets: menus, modals, toasts, progress, number fields
import { el, $, clamp } from '../util.js';
import { ICONS } from '../icons.js';
import { app, cmd } from '../state.js';

// ---------- toast ----------
export function toast(msg, kind = '', ms = 3500) {
  const t = el('div', { class: 'toast ' + kind }, msg);
  $('#toast-root').append(t);
  setTimeout(() => t.remove(), ms);
}
app.on('error', (e) => toast(String(e && e.message || e), 'err', 6000));

// ---------- progress ----------
export function progress(label, frac) {
  const p = $('#st-progress');
  if (label == null) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  p.querySelector('.label').textContent = label;
  p.querySelector('.bar span').style.width = (frac == null ? 30 : clamp(frac, 0, 1) * 100) + '%';
}
export async function withBusy(label, fn) {
  progress(label, null); document.body.style.cursor = 'progress';
  try { return await fn((f, l) => progress(l || label, f)); }
  finally { progress(null); document.body.style.cursor = ''; }
}
export function status(msg) { $('#st-msg').textContent = msg || ''; }

// ---------- menus ----------
// item: {label, cmd, args, key, check:fn|bool, enabled:fn, sub:[items]|fn, run:fn} | '-' | {header}
let openMenus = [];
let menuCloseCb = null;
export function closeMenus() { openMenus.forEach(m => m.remove()); openMenus = []; document.removeEventListener('pointerdown', outside, true); if (menuCloseCb) { const f = menuCloseCb; menuCloseCb = null; f(); } }
function outside(e) { if (!openMenus.some(m => m.contains(e.target))) { if (e.target.closest && e.target.closest('#menubar .mi')) return; closeMenus(); } }
function isEnabled(it) {
  if (it.enabled) return !!it.enabled();
  if (it.cmd && app.commands[it.cmd]?.enabled) return !!app.commands[it.cmd].enabled();
  return true;
}
export function showMenu(items, x, y, level = 0, onClose) {
  if (level === 0) { closeMenus(); menuCloseCb = onClose || null; }
  else { openMenus.slice(level).forEach(m => m.remove()); openMenus = openMenus.slice(0, level); }
  if (typeof items === 'function') items = items();
  const m = el('div', { class: 'menu' + (items.flyout ? ' flymenu' : '') });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.append(el('div', { class: 'sep' })); continue; }
    if (it.header) { m.append(el('div', { class: 'hdr' }, it.header)); continue; }
    const en = isEnabled(it);
    const checked = typeof it.check === 'function' ? it.check() : it.check;
    const row = el('div', { class: 'it' + (it.sub ? ' sub' : '') + (en ? '' : ' dis') + (checked ? ' chk' : '') + (it.cur ? ' cur' : '') });
    if (it.icon) row.append(el('span', { class: 'ico', html: ICONS[it.icon] || '' }));
    row.append(el('span', {}, it.label));
    if (it.key) row.append(el('span', { class: 'k' }, it.key));
    if (it.sub) {
      row.addEventListener('pointerenter', () => { if (!en) return; const r = row.getBoundingClientRect(); showMenu(it.sub, r.right - 2, r.top - 5, level + 1); });
    } else {
      row.addEventListener('pointerenter', () => { openMenus.slice(level + 1).forEach(mm => mm.remove()); openMenus = openMenus.slice(0, level + 1); });
      row.addEventListener('click', () => { if (!en) return; closeMenus(); if (it.run) it.run(); else if (it.cmd) cmd(it.cmd, ...(it.args || [])); });
    }
    m.append(row);
  }
  $('#menus').append(m);
  openMenus[level] = m;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  if (level === 0) setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  return m;
}
export const menuOpen = () => openMenus.length > 0;

// ---------- modals ----------
export function modal({ title, body, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }], width, onOpen, onKey, noBackdropClose = true, className = '' }) {
  return new Promise((resolve) => {
    const bg = el('div', { class: 'modal-bg' });
    const box = el('div', { class: 'modal ' + className, style: width ? { width: width + 'px' } : {} });
    const head = el('div', { class: 'mh' }, el('span', { class: 'grow' }, title || ''), el('button', { class: 'ibtn', html: ICONS.close, onclick: () => done(null) }));
    const mb = el('div', { class: 'mb' });
    if (body instanceof Node) mb.append(body); else if (body) mb.innerHTML = body;
    const mf = el('div', { class: 'mf' });
    const api = { close: (v) => done(v), box, body: mb, footer: mf };
    for (const b of buttons) {
      if (b === '-') { mf.append(el('span', { class: 'grow' })); continue; }
      if (b.node) { mf.append(b.node); continue; }
      const btn = el('button', { class: 'btn' + (b.primary ? ' primary' : ''), onclick: async () => { if (b.validate && !(await b.validate())) return; done(typeof b.value === 'function' ? b.value() : b.value); } }, b.label);
      mf.append(btn);
    }
    box.append(head, mb, mf);
    bg.append(box);
    $('#modal-root').append(bg);
    // drag
    let drag = null;
    head.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; const r = box.getBoundingClientRect(); drag = { x: e.clientX - r.left, y: e.clientY - r.top }; box.style.position = 'fixed'; box.style.margin = 0; head.setPointerCapture(e.pointerId); });
    head.addEventListener('pointermove', (e) => { if (!drag) return; box.style.left = (e.clientX - drag.x) + 'px'; box.style.top = (e.clientY - drag.y) + 'px'; });
    head.addEventListener('pointerup', () => drag = null);
    const key = (e) => {
      if (onKey && onKey(e, api)) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      if (e.key === 'Enter' && !(e.target && e.target.tagName === 'TEXTAREA')) {
        const p = buttons.find(b => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); (async () => { if (p.validate && !(await p.validate())) return; done(typeof p.value === 'function' ? p.value() : p.value); })(); }
      }
    };
    window.addEventListener('keydown', key, true);
    let closed = false;
    function done(v) { if (closed) return; closed = true; window.removeEventListener('keydown', key, true); bg.remove(); app.modalOpen = Math.max(0, (app.modalOpen || 1) - 1); resolve(v); }
    app.modalOpen = (app.modalOpen || 0) + 1;
    if (onOpen) onOpen(api);
    const f = box.querySelector('input,select,textarea'); if (f) setTimeout(() => { f.focus(); if (f.select) f.select(); }, 0);
  });
}
export async function alertBox(message, title = 'Strata') {
  return modal({ title, body: el('div', { class: 'note', style: { fontSize: '12px', color: 'var(--text)' } }, message), buttons: [{ label: 'OK', value: true, primary: true }] });
}
export async function confirmBox(message, okLabel = 'OK', title = 'Strata') {
  return modal({ title, body: el('div', { style: { maxWidth: '420px' } }, message), buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true }] });
}
export async function promptBox(label, value = '', title = 'Strata') {
  const inp = el('input', { type: 'text', value, style: { width: '320px' } });
  return modal({ title, body: el('div', { class: 'row' }, el('label', {}, label), inp), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => inp.value, primary: true }] });
}

// ---------- form helpers ----------
// Scrubby number field: label drag changes value
export function numField({ label, value, min = -Infinity, max = Infinity, step = 1, unit = '', width = 52, onInput, onChange, decimals }) {
  const inp = el('input', { type: 'number', value, min, max, step, style: { width: width + 'px' } });
  const fix = (v) => { v = clamp(Number(v), min, max); if (decimals != null) v = Number(v.toFixed(decimals)); return v; };
  inp.addEventListener('input', () => { if (inp.value !== '' && !isNaN(inp.value)) onInput && onInput(fix(inp.value)); });
  inp.addEventListener('change', () => { const v = fix(inp.value); inp.value = v; onChange ? onChange(v) : onInput && onInput(v); });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { inp.blur(); } e.stopPropagation(); });
  const lab = el('label', { class: 'scrub numfield' }, label ? el('span', {}, label) : null, inp, unit ? el('span', { class: 'u' }, unit) : null);
  if (label) {
    const sp = lab.querySelector('span');
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault(); const x0 = e.clientX, v0 = Number(inp.value) || 0;
      const mv = (ev) => { const v = fix(v0 + Math.round((ev.clientX - x0) / (ev.shiftKey ? 0.5 : 2)) * step * (ev.shiftKey ? 10 : 1)); inp.value = v; onInput && onInput(v); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); onChange && onChange(Number(inp.value)); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
  }
  lab.input = inp;
  lab.set = (v) => { inp.value = v; };
  return lab;
}
// Slider + number row
export function sliderRow({ label, value, min, max, step = 1, unit = '', onInput, onChange, gradient }) {
  const num = el('input', { type: 'number', value, min, max, step });
  const rng = el('input', { type: 'range', value, min, max, step });
  const fire = (v, final) => { v = clamp(Number(v), min, max); num.value = v; rng.value = v; (final && onChange ? onChange : onInput)?.(v); if (final && !onChange) {} };
  rng.addEventListener('input', () => fire(rng.value));
  rng.addEventListener('change', () => fire(rng.value, true));
  num.addEventListener('input', () => { if (num.value !== '' && !isNaN(num.value)) { rng.value = num.value; onInput && onInput(clamp(Number(num.value), min, max)); } });
  num.addEventListener('change', () => fire(num.value, true));
  num.addEventListener('keydown', (e) => e.stopPropagation());
  rng.addEventListener('dblclick', () => { /* reset handled by caller */ });
  const row = el('div', { class: 'row' }, el('label', {}, label), rng, num, unit ? el('span', { class: 'muted' }, unit) : null);
  row.set = (v) => { num.value = v; rng.value = v; };
  if (gradient) { const g = el('div', { class: 'slider-grad', style: { background: gradient } }); const wrap = el('div', {}, row, g); wrap.set = row.set; return wrap; }
  return row;
}
export function selectEl(options, value, onChange) {
  const s = el('select', {});
  for (const o of options) {
    if (o == null) { const op = el('option', { disabled: true }, '──────────'); s.append(op); continue; }
    const [v, l] = Array.isArray(o) ? o : [o.value, o.label];
    s.append(el('option', { value: v, selected: String(v) === String(value) }, l));
  }
  s.addEventListener('change', () => onChange && onChange(s.value));
  s.addEventListener('keydown', (e) => e.stopPropagation());
  return s;
}
export function checkEl(label, value, onChange) {
  const c = el('input', { type: 'checkbox', checked: !!value });
  c.addEventListener('change', () => onChange && onChange(c.checked));
  const l = el('label', {}, c, label); l.input = c; return l;
}
export function colorEl(value, onChange, onInput) {
  const c = el('input', { type: 'color', value });
  c.addEventListener('input', () => onInput && onInput(c.value));
  c.addEventListener('change', () => onChange && onChange(c.value));
  return c;
}
