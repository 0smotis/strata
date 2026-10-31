// Navigator, Info, Histogram panels
import { app } from '../state.js';
import { el, createCanvas, ctx2d, debounce, clamp, rgbToHex, rgbToCmyk, rgbToHsv, rgbToLab } from '../util.js';
import { vp, toDoc, setZoom, viewChanged, requestDraw } from '../view/viewport.js';
import { histogram } from '../engine/adjust.js';

export function navigatorPanel(body) {
  const cv = el('canvas', { style: { display: 'block', margin: '8px auto', maxWidth: 'calc(100% - 16px)', cursor: 'pointer', background: '#222' } });
  const zoom = el('input', { type: 'range', min: -460, max: 346, step: 1, style: { flex: 1 } });
  const pct = el('span', { style: { width: '54px', textAlign: 'right', color: 'var(--text2)' } });
  body.append(cv, el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '0 10px 8px' } }, pct, zoom));
  let img = null, s = 1;
  const drawThumb = debounce(() => { const d = app.doc; if (!d) { ctx2d(cv).clearRect(0, 0, cv.width, cv.height); return; } const W = Math.max(60, body.clientWidth - 16), H = 112; s = Math.min(W / d.width, H / d.height); cv.width = Math.round(d.width * s); cv.height = Math.round(d.height * s); img = createCanvas(cv.width, cv.height); ctx2d(img).drawImage(d.render(), 0, 0, cv.width, cv.height); drawRect(); }, 150);
  const drawRect = () => {
    const d = app.doc; if (!d || !img) return;
    const g = ctx2d(cv); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0);
    const a = toDoc(0, 0), b = toDoc(vp.w, vp.h);
    g.strokeStyle = '#ff2b2b'; g.lineWidth = 2; g.strokeRect(a.x * s, a.y * s, (b.x - a.x) * s, (b.y - a.y) * s);
    zoom.value = Math.round(Math.log(d.view.zoom) * 100); pct.textContent = (d.view.zoom * 100).toFixed(d.view.zoom < 1 ? 1 : 0) + '%';
  };
  const pan = (e) => { const d = app.doc; if (!d) return; const r = cv.getBoundingClientRect(); d.view.cx = clamp((e.clientX - r.left) / r.width * d.width, 0, d.width); d.view.cy = clamp((e.clientY - r.top) / r.height * d.height, 0, d.height); viewChanged(); };
  cv.addEventListener('pointerdown', (e) => { cv.setPointerCapture(e.pointerId); pan(e); const mv = (ev) => pan(ev), up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); }; cv.addEventListener('pointermove', mv); cv.addEventListener('pointerup', up); });
  zoom.oninput = () => setZoom(Math.exp(zoom.value / 100));
  drawThumb();
  const offs = [app.on('doc', drawThumb), app.on('render', drawThumb), app.on('view', drawRect)];
  body._cleanup = () => offs.forEach(f => f());
}

export function infoPanel(body) {
  const box = el('div', { style: { padding: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', fontFamily: 'Consolas, monospace', fontSize: '11px' } });
  body.append(box);
  const render = () => {
    const d = app.doc; box.innerHTML = ''; if (!d) return;
    const p = vp.hoverPt; let rgb = null;
    if (p && p.x >= 0 && p.y >= 0 && p.x < d.width && p.y < d.height) { const px = ctx2d(d.render()).getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data; rgb = { r: px[0], g: px[1], b: px[2], a: px[3] }; }
    const cm = rgb ? rgbToCmyk(rgb.r, rgb.g, rgb.b) : null, hsv = rgb ? rgbToHsv(rgb.r, rgb.g, rgb.b) : null;
    const blk = (title, rows) => el('div', {}, el('div', { style: { color: 'var(--text3)', marginBottom: '3px' } }, title), ...rows.map(([k, v]) => el('div', {}, el('span', { style: { display: 'inline-block', width: '22px', color: 'var(--text2)' } }, k), v)));
    box.append(
      blk('RGB', rgb ? [['R:', rgb.r], ['G:', rgb.g], ['B:', rgb.b], ['#', rgbToHex(rgb).slice(1)]] : [['R:', ''], ['G:', ''], ['B:', '']]),
      blk('CMYK', cm ? [['C:', cm.c + '%'], ['M:', cm.m + '%'], ['Y:', cm.y + '%'], ['K:', cm.k + '%']] : [['C:', ''], ['M:', ''], ['Y:', ''], ['K:', '']]),
      blk('Position', [['X:', p ? Math.floor(p.x) : ''], ['Y:', p ? Math.floor(p.y) : '']]),
      blk('Selection', d.selBounds ? [['W:', d.selBounds.w], ['H:', d.selBounds.h]] : [['W:', ''], ['H:', '']]),
      blk('HSB', hsv ? [['H:', Math.round(hsv.h) + '°'], ['S:', Math.round(hsv.s) + '%'], ['B:', Math.round(hsv.v) + '%']] : [['H:', ''], ['S:', ''], ['B:', '']]),
      blk('Document', [['', `${d.width}×${d.height}`], ['', `${(d.width * d.height * 4 / 1048576).toFixed(1)} MB`], ['', (d.mode || 'rgb').toUpperCase() + '/8']]));
  };
  const throttled = debounce(render, 30);
  render();
  const v = document.getElementById('viewport'); v.addEventListener('pointermove', throttled);
  const offs = [app.on('doc', render), app.on('selection', render)];
  body._cleanup = () => { v.removeEventListener('pointermove', throttled); offs.forEach(f => f()); };
}

export function histogramPanel(body) {
  let ch = 'rgb';
  const sel = el('select', { style: { margin: '8px 10px 0' } }, ...[['rgb', 'Colors'], ['l', 'Luminosity'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']].map(([v, l]) => el('option', { value: v }, l)));
  sel.onchange = () => { ch = sel.value; render(); }; sel.onkeydown = (e) => e.stopPropagation();
  const cv = el('canvas', { width: 256, height: 110, style: { display: 'block', width: 'calc(100% - 20px)', height: '110px', margin: '8px 10px', background: '#1f1f1f', border: '1px solid #111' } });
  const stats = el('div', { style: { padding: '0 10px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', fontSize: '11px', color: 'var(--text2)' } });
  body.append(sel, cv, stats);
  const render = debounce(() => {
    const d = app.doc, g = ctx2d(cv); g.clearRect(0, 0, 256, 110); stats.innerHTML = ''; if (!d) return;
    const c = d.render(), s = Math.min(1, 512 / Math.max(c.width, c.height)), t = createCanvas(Math.max(1, c.width * s), Math.max(1, c.height * s)); ctx2d(t).drawImage(c, 0, 0, t.width, t.height);
    const h = histogram(ctx2d(t).getImageData(0, 0, t.width, t.height).data);
    const draw = (arr, col, mode) => { let mx = 0; for (let i = 0; i < 256; i++) mx = Math.max(mx, arr[i]); g.fillStyle = col; g.globalCompositeOperation = mode; for (let i = 0; i < 256; i++) { const v = arr[i] / (mx || 1) * 108; g.fillRect(i, 110 - v, 1, v); } };
    if (ch === 'rgb') { draw(h.r, '#e33', 'lighter'); draw(h.g, '#3c3', 'lighter'); draw(h.b, '#36f', 'lighter'); }
    else draw(h[ch], ch === 'l' ? '#ccc' : { r: '#e33', g: '#3c3', b: '#36f' }[ch], 'source-over');
    g.globalCompositeOperation = 'source-over';
    const arr = h[ch === 'rgb' ? 'l' : ch]; let n = 0, sum = 0, sq = 0; for (let i = 0; i < 256; i++) { n += arr[i]; sum += i * arr[i]; sq += i * i * arr[i]; }
    const mean = sum / (n || 1), sd = Math.sqrt(Math.max(0, sq / (n || 1) - mean * mean)); let acc = 0, med = 0; for (let i = 0; i < 256; i++) { acc += arr[i]; if (acc >= n / 2) { med = i; break; } }
    for (const [k, v] of [['Mean:', mean.toFixed(2)], ['Std Dev:', sd.toFixed(2)], ['Median:', med], ['Pixels:', Math.round(n / (s * s)).toLocaleString()]]) stats.append(el('span', {}, k + ' ' + v));
  }, 250);
  render();
  const offs = [app.on('doc', render), app.on('render', render)];
  body._cleanup = () => offs.forEach(f => f());
}

// ---------- Brush Settings ----------
import { sliderRow, checkEl } from './common.js';
import { brushTip } from '../tools/paint.js';
export function brushSettingsPanel(body) {
  const wrap = el('div', { class: 'props' }); body.append(wrap);
  const render = () => {
    wrap.innerHTML = '';
    const id = app.tool, o = app.opts[id];
    if (!o || o.size == null || o.hardness == null) { wrap.append(el('div', { class: 'muted' }, 'Select a painting tool (Brush, Pencil, Eraser, Clone Stamp, History Brush…) to edit its brush settings.')); return; }
    const dyn = o.dynamics || (o.dynamics = { shapeOn: false, sizeJitter: 0, minDiameter: 0, angleJitter: 0, angleFollow: false, roundnessJitter: 0, minRoundness: 25, scatterOn: false, scatter: 0, bothAxes: false, count: 1, countJitter: 0, colorOn: false, fgbgJitter: 0, hueJitter: 0, satJitter: 0, brightJitter: 0, transferOn: false, opacityJitter: 0, flowJitter: 0 });
    const save = () => { try { localStorage.setItem('strata.opts', JSON.stringify(app.opts)); } catch {} drawPreview(); app.emit('opts', id, 'dyn'); };
    const S = (label, obj, k, min, max, unit = '%', scale = 1) => sliderRow({ label, value: Math.round(obj[k] * scale), min, max, unit, onInput: (v) => { obj[k] = v / scale; save(); } });
    const section = (title, key, ...rows) => { const box = el('div', { style: { display: dyn[key] ? 'flex' : 'none', flexDirection: 'column', gap: '6px', paddingLeft: '8px' } }, ...rows); const c = checkEl(title, dyn[key], (v) => { dyn[key] = v; box.style.display = v ? 'flex' : 'none'; save(); }); c.style.fontWeight = '600'; return [c, box]; };
    const prev = el('canvas', { width: 280, height: 70, style: { width: '100%', height: '70px', background: '#fff', border: '1px solid #111' } });
    wrap.append(el('h4', {}, 'Brush Tip Shape'), S('Size', o, 'size', 1, 1000, 'px'), S('Hardness', o, 'hardness', 0, 100, '%', 100), S('Spacing', o, 'spacing', 1, 300), S('Angle', o, 'angle', -180, 180, '°'), S('Roundness', o, 'roundness', 1, 100),
      ...section('Shape Dynamics', 'shapeOn', S('Size Jitter', dyn, 'sizeJitter', 0, 100), S('Minimum Diameter', dyn, 'minDiameter', 0, 100), S('Angle Jitter', dyn, 'angleJitter', 0, 100), checkEl('Angle follows direction', dyn.angleFollow, (v) => { dyn.angleFollow = v; save(); }), S('Roundness Jitter', dyn, 'roundnessJitter', 0, 100), S('Minimum Roundness', dyn, 'minRoundness', 1, 100)),
      ...section('Scattering', 'scatterOn', S('Scatter', dyn, 'scatter', 0, 1000), checkEl('Both Axes', dyn.bothAxes, (v) => { dyn.bothAxes = v; save(); }), S('Count', dyn, 'count', 1, 16, ''), S('Count Jitter', dyn, 'countJitter', 0, 100)),
      ...section('Color Dynamics', 'colorOn', S('Foreground/Background Jitter', dyn, 'fgbgJitter', 0, 100), S('Hue Jitter', dyn, 'hueJitter', 0, 100), S('Saturation Jitter', dyn, 'satJitter', 0, 100), S('Brightness Jitter', dyn, 'brightJitter', 0, 100)),
      ...section('Transfer', 'transferOn', S('Opacity Jitter', dyn, 'opacityJitter', 0, 100), S('Flow Jitter', dyn, 'flowJitter', 0, 100)),
      checkEl('Smoothing', (o.smoothing || 0) > 0, (v) => { o.smoothing = v ? 10 : 0; save(); }), checkEl('Build-up (Airbrush)', !!o.airbrush, (v) => { o.airbrush = v; save(); }),
      el('h4', {}, 'Preview'), prev);
    function drawPreview() {
      const g = ctx2d(prev); g.globalCompositeOperation = 'source-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, 280, 70);
      const sz = Math.min(o.size, 40), step = Math.max(1, sz * (o.spacing || 25) / 100);
      for (let x = 20; x < 260; x += step) {
        const y = 35 + Math.sin(x / 40) * 15; let s = sz, ang = o.angle || 0, rd = o.roundness || 100, px = x, py = y;
        if (dyn.shapeOn) { s *= 1 - Math.random() * dyn.sizeJitter / 100 * (1 - dyn.minDiameter / 100); ang += (Math.random() * 2 - 1) * dyn.angleJitter / 100 * 180; rd = Math.max(dyn.minRoundness, rd * (1 - Math.random() * dyn.roundnessJitter / 100)); }
        if (dyn.scatterOn) py += (Math.random() * 2 - 1) * sz * dyn.scatter / 100 * 0.5;
        const t = brushTip(Math.max(1, s), o.hardness, '#000000', { roundness: Math.round(rd), angle: Math.round(ang) });
        g.globalAlpha = (o.flow ?? 100) / 100 * (dyn.transferOn ? 1 - Math.random() * dyn.flowJitter / 100 : 1); g.drawImage(t.canvas, px - t.d / 2, py - t.d / 2);
      }
      g.globalAlpha = 1;
    }
    drawPreview();
  };
  render();
  const offs = [app.on('tool', render)];
  body._cleanup = () => offs.forEach(f => f());
}
