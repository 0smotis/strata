// Properties-panel editors for adjustment layers (also reused by destructive Image › Adjustments dialogs)
import { app, cmd } from '../state.js';
import { el, $$, createCanvas, ctx2d, clamp, debounce } from '../util.js';
import { ICONS } from '../icons.js';
import { sliderRow, selectEl, checkEl, colorEl } from './common.js';
import { ADJUSTMENT_TYPES, defaultParams, curveLUT, histogram } from '../engine/adjust.js';
import { GRADIENT_PRESETS, gradientCSS } from '../doc/gradient.js';

const NAMES = Object.fromEntries(ADJUSTMENT_TYPES.map(a => [a.type, a.name.replace(/…$/, '')]));
export const adjName = (t) => NAMES[t] || t;

export const PHOTO_FILTERS = [['#ec8a00', 'Warming Filter (85)'], ['#fa9600', 'Warming Filter (LBA)'], ['#ebb113', 'Warming Filter (81)'], ['#006dff', 'Cooling Filter (80)'], ['#005dff', 'Cooling Filter (LBB)'], ['#00b5ff', 'Cooling Filter (82)'], ['#ea1a1a', 'Red'], ['#f38417', 'Orange'], ['#f9e31c', 'Yellow'], ['#19c919', 'Green'], ['#1dcbea', 'Cyan'], ['#1d35ea', 'Blue'], ['#9b1dea', 'Violet'], ['#e318e3', 'Magenta'], ['#ac7a33', 'Sepia'], ['#ff0000', 'Deep Red'], ['#0022cd', 'Deep Blue'], ['#008c00', 'Deep Emerald'], ['#ffd500', 'Deep Yellow'], ['#00c1b1', 'Underwater']];
const CURVE_PRESETS = {
  'Default': [[0, 0], [255, 255]], 'Color Negative (RGB)': null, 'Cross Process (RGB)': null,
  'Darker (RGB)': [[0, 0], [158, 115], [255, 255]], 'Increase Contrast (RGB)': [[0, 0], [64, 52], [191, 202], [255, 255]], 'Lighter (RGB)': [[0, 0], [100, 145], [255, 255]],
  'Linear Contrast (RGB)': [[0, 0], [64, 48], [191, 207], [255, 255]], 'Medium Contrast (RGB)': [[0, 0], [64, 56], [191, 199], [255, 255]], 'Negative (RGB)': [[0, 255], [255, 0]], 'Strong Contrast (RGB)': [[0, 0], [64, 38], [191, 217], [255, 255]],
};

// histogram of what's beneath the layer
function histBelow(doc, L) {
  const c = doc.flatten((l) => true);
  const s = Math.min(1, 400 / Math.max(c.width, c.height));
  const t = createCanvas(Math.max(1, c.width * s), Math.max(1, c.height * s)); ctx2d(t).drawImage(c, 0, 0, t.width, t.height);
  return histogram(ctx2d(t).getImageData(0, 0, t.width, t.height).data);
}
function drawHist(cv, h, ch = 'l', color = '#aaa') {
  const g = ctx2d(cv), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
  const arr = h[ch === 'rgb' ? 'l' : ch] || h.l; let max = 0; for (let i = 1; i < 255; i++) max = Math.max(max, arr[i]);
  g.fillStyle = color; for (let i = 0; i < 256; i++) { const v = Math.min(1, arr[i] / (max || 1)); g.fillRect(i / 256 * W, H - v * H, W / 256 + 0.5, v * H); }
}

export function renderAdjustmentUI(w, d, L, ADJ_ICON, opts = {}) {
  const p = L.data.params, type = L.data.type;
  const live = opts.live || (() => { L.touch(); d.invalidate(); });
  const commitNow = opts.commit || (() => d.commit('Modify ' + adjName(type) + ' Layer', 'adjust'));
  const commit = debounce(commitNow, 300);
  const upd = () => { live(); commit(); };
  const rerender = () => { w.innerHTML = ''; renderAdjustmentUI(w, d, L, ADJ_ICON, opts); };
  if (!opts.noHeader) {
    w.append(el('h4', {}, el('span', { class: 'ico', html: ADJ_ICON?.[type] || ICONS.adjust, style: { width: '18px', height: '18px' } }), adjName(type)));
  }
  const S = (label, obj, k, min, max, step = 1, extra = {}) => sliderRow({ label, value: obj[k], min, max, step, ...extra, onInput: (v) => { obj[k] = v; live(); }, onChange: (v) => { obj[k] = v; upd(); } });
  const resetBtn = el('button', { class: 'btn', title: 'Reset to adjustment defaults', onclick: () => { L.data.params = defaultParams(type); upd(); rerender(); } }, 'Reset');
  const foot = () => w.append(el('div', { class: 'btnrow', style: { marginTop: '6px' } }, resetBtn, ...(opts.noLayerButtons ? [] : [
    el('button', { class: 'btn', title: 'Clip to layer below', onclick: () => cmd('toggleClip') }, L.clipped ? 'Unclip' : 'Clip to Layer'),
    el('button', { class: 'btn', title: 'Toggle layer visibility', onclick: () => { L.visible = !L.visible; L.touch(); d.commit(L.visible ? 'Show Layer' : 'Hide Layer', 'eye'); } }, L.visible ? 'Hide' : 'Show')])));

  switch (type) {
    case 'brightnessContrast':
      w.append(S('Brightness', p, 'brightness', -150, 150), S('Contrast', p, 'contrast', p.legacy ? -100 : -50, 100), checkEl('Use Legacy', p.legacy, (v) => { p.legacy = v; upd(); }));
      break;
    case 'levels': {
      let ch = 'rgb';
      const hist = histBelow(d, L);
      const sel = selectEl([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], ch, (v) => { ch = v; draw(); });
      const cv = el('canvas', { class: 'histo', width: 256, height: 90 });
      const tri = el('div', { class: 'lvl-tri' }), tb = el('span'), tg = el('span', { class: 'g' }), tw = el('span', { class: 'w' }); tri.append(tb, tg, tw);
      const ins = el('div', { class: 'grid2', style: { gridTemplateColumns: '1fr 1fr 1fr' } });
      const nb = el('input', { type: 'number', min: 0, max: 253 }), ng = el('input', { type: 'number', min: 0.01, max: 9.99, step: 0.01 }), nw = el('input', { type: 'number', min: 2, max: 255 });
      ins.append(nb, ng, nw);
      const out = el('div', { class: 'grid2' }); const ob = el('input', { type: 'number', min: 0, max: 255 }), ow = el('input', { type: 'number', min: 0, max: 255 }); out.append(el('label', {}, 'Output', ob), el('label', {}, '', ow));
      const outBar = el('div', { style: { height: '10px', background: 'linear-gradient(90deg,#000,#fff)', border: '1px solid #111' } });
      const draw = () => {
        const c = p.channels[ch];
        drawHist(cv, hist, ch, { rgb: '#bbb', r: '#e55', g: '#5d5', b: '#58f' }[ch]);
        const W = tri.getBoundingClientRect().width || 256;
        const gpos = c.inBlack + (c.inWhite - c.inBlack) * Math.pow(0.5, c.gamma);
        tb.style.left = c.inBlack / 255 * 100 + '%'; tw.style.left = c.inWhite / 255 * 100 + '%'; tg.style.left = gpos / 255 * 100 + '%';
        nb.value = c.inBlack; ng.value = c.gamma.toFixed(2); nw.value = c.inWhite; ob.value = c.outBlack; ow.value = c.outWhite;
      };
      const dragTri = (t, fn) => t.addEventListener('pointerdown', (e) => { e.preventDefault(); t.setPointerCapture(e.pointerId); const r = tri.getBoundingClientRect(); const mv = (ev) => { fn(clamp((ev.clientX - r.left) / r.width * 255, 0, 255)); draw(); live(); }; const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); upd(); }; t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); });
      dragTri(tb, (v) => { const c = p.channels[ch]; c.inBlack = Math.round(Math.min(v, c.inWhite - 2)); });
      dragTri(tw, (v) => { const c = p.channels[ch]; c.inWhite = Math.round(Math.max(v, c.inBlack + 2)); });
      dragTri(tg, (v) => { const c = p.channels[ch]; const f = clamp((v - c.inBlack) / (c.inWhite - c.inBlack), 0.01, 0.99); c.gamma = clamp(Math.log(f) / Math.log(0.5), 0.01, 9.99); });
      const num = (inp, k, f = Number) => { inp.onkeydown = (e) => e.stopPropagation(); inp.onchange = () => { p.channels[ch][k] = f(inp.value); draw(); upd(); }; };
      num(nb, 'inBlack'); num(ng, 'gamma'); num(nw, 'inWhite'); num(ob, 'outBlack'); num(ow, 'outWhite');
      w.append(el('div', { class: 'row' }, el('label', {}, 'Channel'), sel, el('button', { class: 'btn', onclick: () => { autoLevels(hist, p); draw(); upd(); } }, 'Auto')), cv, tri, ins, outBar, out);
      requestAnimationFrame(draw);
      break;
    }
    case 'curves': {
      let ch = 'rgb', dragIdx = -1;
      const hist = histBelow(d, L);
      const cv = el('canvas', { class: 'curve', width: 256, height: 256 });
      const sel = selectEl([['rgb', 'RGB'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']], ch, (v) => { ch = v; draw(); });
      const preset = selectEl([['', 'Custom'], ...Object.keys(CURVE_PRESETS).map(k => [k, k])], '', (v) => { if (!v) return; if (v === 'Color Negative (RGB)') { p.channels.rgb = [[0, 255], [255, 0]]; } else if (v === 'Cross Process (RGB)') { p.channels.r = [[0, 0], [64, 40], [191, 220], [255, 255]]; p.channels.g = [[0, 0], [64, 52], [191, 210], [255, 255]]; p.channels.b = [[0, 40], [255, 215]]; } else { p.channels = { rgb: JSON.parse(JSON.stringify(CURVE_PRESETS[v])), r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] }; } draw(); upd(); });
      const inp = el('input', { type: 'number', min: 0, max: 255, style: { width: '56px' } }), outp = el('input', { type: 'number', min: 0, max: 255, style: { width: '56px' } });
      let selIdx = -1;
      const draw = () => {
        const g = ctx2d(cv); g.clearRect(0, 0, 256, 256);
        g.globalAlpha = 0.35; drawHistInto(g, hist[ch === 'rgb' ? 'l' : ch]); g.globalAlpha = 1;
        g.strokeStyle = '#444'; g.lineWidth = 1; g.beginPath(); for (let k = 1; k < 4; k++) { g.moveTo(k * 64 + .5, 0); g.lineTo(k * 64 + .5, 256); g.moveTo(0, k * 64 + .5); g.lineTo(256, k * 64 + .5); } g.stroke();
        g.strokeStyle = '#555'; g.beginPath(); g.moveTo(0, 256); g.lineTo(256, 0); g.stroke();
        if (ch === 'rgb') for (const [c, col] of [['r', '#e55'], ['g', '#5d5'], ['b', '#58f']]) { const pts = p.channels[c]; if (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 255 && pts[1][1] === 255) continue; plot(g, curveLUT(pts), col); }
        plot(g, curveLUT(p.channels[ch]), { rgb: '#ddd', r: '#e55', g: '#5d5', b: '#58f' }[ch]);
        p.channels[ch].forEach(([x, y], k) => { g.fillStyle = k === selIdx ? '#fff' : '#222'; g.strokeStyle = '#ddd'; g.fillRect(x - 3, 255 - y - 3, 6, 6); g.strokeRect(x - 3.5, 255 - y - 3.5, 7, 7); });
        const sp = p.channels[ch][selIdx]; if (sp) { inp.value = sp[0]; outp.value = sp[1]; }
      };
      const pt = (e) => { const r = cv.getBoundingClientRect(); return [clamp(Math.round((e.clientX - r.left) / r.width * 255), 0, 255), clamp(Math.round(255 - (e.clientY - r.top) / r.height * 255), 0, 255)]; };
      cv.addEventListener('pointerdown', (e) => {
        const [x, y] = pt(e), pts = p.channels[ch];
        let k = pts.findIndex(q => Math.abs(q[0] - x) < 8 && Math.abs(q[1] - y) < 8);
        if (k < 0) { const lut = curveLUT(pts); pts.push([x, Math.abs(lut[x] - y) < 12 ? lut[x] : y]); pts.sort((a, b) => a[0] - b[0]); k = pts.findIndex(q => q[0] === x); }
        dragIdx = selIdx = k; cv.setPointerCapture(e.pointerId); draw(); live();
      });
      cv.addEventListener('pointermove', (e) => {
        if (dragIdx < 0) return; const pts = p.channels[ch]; let [x, y] = pt(e);
        const r = cv.getBoundingClientRect();
        const outside = e.clientX < r.left - 20 || e.clientX > r.right + 20 || e.clientY < r.top - 20 || e.clientY > r.bottom + 20;
        if (outside && pts.length > 2 && dragIdx > 0 && dragIdx < pts.length - 1) { pts.splice(dragIdx, 1); dragIdx = -1; selIdx = -1; draw(); live(); return; }
        const lo = dragIdx > 0 ? pts[dragIdx - 1][0] + 1 : 0, hi = dragIdx < pts.length - 1 ? pts[dragIdx + 1][0] - 1 : 255;
        pts[dragIdx] = [clamp(x, lo, hi), y]; draw(); live();
      });
      cv.addEventListener('pointerup', () => { if (dragIdx >= 0 || true) upd(); dragIdx = -1; });
      cv.addEventListener('dblclick', (e) => { const [x, y] = pt(e), pts = p.channels[ch]; const k = pts.findIndex(q => Math.abs(q[0] - x) < 8 && Math.abs(q[1] - y) < 8); if (k > 0 && k < pts.length - 1) { pts.splice(k, 1); selIdx = -1; draw(); upd(); } });
      for (const [i, j] of [[inp, 0], [outp, 1]]) { i.onkeydown = (e) => e.stopPropagation(); i.onchange = () => { const s = p.channels[ch][selIdx]; if (!s) return; s[j] = clamp(Number(i.value), 0, 255); p.channels[ch].sort((a, b) => a[0] - b[0]); draw(); upd(); }; }
      w.append(el('div', { class: 'row' }, el('label', {}, 'Preset'), preset), el('div', { class: 'row' }, el('label', {}, 'Channel'), sel, el('button', { class: 'btn', onclick: () => { autoCurves(hist, p); draw(); upd(); } }, 'Auto')), cv,
        el('div', { class: 'row' }, el('label', {}, 'Input'), inp, el('span', { class: 'muted' }, 'Output'), outp), el('div', { class: 'muted' }, 'Click to add points, drag off the graph or double-click to delete.'));
      requestAnimationFrame(draw);
      break;
    }
    case 'exposure': w.append(S('Exposure', p, 'exposure', -20, 20, 0.01), S('Offset', p, 'offset', -0.5, 0.5, 0.0001), S('Gamma Correction', p, 'gamma', 0.01, 9.99, 0.01)); break;
    case 'vibrance': w.append(S('Vibrance', p, 'vibrance', -100, 100), S('Saturation', p, 'saturation', -100, 100)); break;
    case 'hueSaturation': {
      const presets = { 'Default': [0, 0, 0, false], 'Cyanotype': [200, 25, 0, true], 'Increase Saturation': [0, 25, 0, false], 'Increase Saturation More': [0, 50, 0, false], 'Old Style': [33, 20, -15, true], 'Red Boost': [0, 30, 0, false], 'Sepia': [35, 25, 0, true], 'Strong Saturation': [0, 75, 0, false], 'Yellow Boost': [10, 20, 0, false] };
      w.append(el('div', { class: 'row' }, el('label', {}, 'Preset'), selectEl([['', 'Custom'], ...Object.keys(presets).map(k => [k, k])], '', (v) => { if (!v) return; const [h, s, l, c] = presets[v]; Object.assign(p, { hue: h, saturation: s, lightness: l, colorize: c }); upd(); rerender(); })));
      w.append(S('Hue', p, 'hue', p.colorize ? 0 : -180, p.colorize ? 360 : 180, 1, { gradient: 'linear-gradient(90deg,#0ff,#00f,#f0f,#f00,#ff0,#0f0,#0ff)' }), S('Saturation', p, 'saturation', p.colorize ? 0 : -100, 100, 1, { gradient: 'linear-gradient(90deg,#888,#f33)' }), S('Lightness', p, 'lightness', -100, 100, 1, { gradient: 'linear-gradient(90deg,#000,#888,#fff)' }));
      w.append(checkEl('Colorize', p.colorize, (v) => { p.colorize = v; if (v) { if (p.hue < 0) p.hue += 360; if (p.saturation <= 0) p.saturation = 25; } else { if (p.hue > 180) p.hue -= 360; } upd(); rerender(); }));
      break;
    }
    case 'colorBalance': {
      let tone = 'midtones';
      const box = el('div', {});
      const draw = () => { box.innerHTML = ''; const t = p[tone]; const mk = (k, a, b, g) => sliderRow({ label: a, value: t[k], min: -100, max: 100, gradient: g, onInput: (v) => { t[k] = v; live(); }, onChange: (v) => { t[k] = v; upd(); } }); box.append(mk(0, 'Cyan / Red', 0, 'linear-gradient(90deg,#0ff,#f00)'), mk(1, 'Magenta / Green', 0, 'linear-gradient(90deg,#f0f,#0f0)'), mk(2, 'Yellow / Blue', 0, 'linear-gradient(90deg,#ff0,#00f)')); };
      w.append(el('div', { class: 'row' }, el('label', {}, 'Tone'), selectEl([['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], tone, (v) => { tone = v; draw(); })), box, checkEl('Preserve Luminosity', p.preserveLuminosity, (v) => { p.preserveLuminosity = v; upd(); }));
      draw(); break;
    }
    case 'blackWhite': {
      const presets = { 'Default': [40, 60, 40, 60, 20, 80], 'Blue Filter': [0, 0, 0, 110, 110, 110], 'Darker': [5, 40, 30, 15, 0, 10], 'Green Filter': [-40, 120, 120, -50, -50, -50], 'High Contrast Blue Filter': [-50, -50, -50, 150, 150, 150], 'High Contrast Red Filter': [120, 120, -10, -50, -50, 120], 'Infrared': [-40, 235, 144, -68, -3, -107], 'Lighter': [55, 75, 55, 75, 35, 95], 'Maximum Black': [0, 0, 0, 0, 0, 0], 'Maximum White': [100, 100, 100, 100, 100, 100], 'Neutral Density': [128, 128, 100, 100, 128, 100], 'Red Filter': [120, 110, -10, -50, -50, 120], 'Yellow Filter': [120, 110, 40, -30, 0, 70] };
      w.append(el('div', { class: 'row' }, el('label', {}, 'Preset'), selectEl([['', 'Custom'], ...Object.keys(presets).map(k => [k, k])], '', (v) => { if (!v) return; const a = presets[v];['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas'].forEach((k, i) => p[k] = a[i]); upd(); rerender(); })));
      for (const [k, n, g] of [['reds', 'Reds', '#f33'], ['yellows', 'Yellows', '#ff3'], ['greens', 'Greens', '#3f3'], ['cyans', 'Cyans', '#3ff'], ['blues', 'Blues', '#33f'], ['magentas', 'Magentas', '#f3f']]) w.append(S(n, p, k, -200, 300, 1, { unit: '%', gradient: `linear-gradient(90deg,#000,${g})` }));
      w.append(checkEl('Tint', p.tint, (v) => { p.tint = v; upd(); rerender(); }));
      if (p.tint) w.append(S('Hue', p, 'tintHue', 0, 360), S('Saturation', p, 'tintSat', 0, 100, 1, { unit: '%' }));
      break;
    }
    case 'photoFilter': {
      const known = PHOTO_FILTERS.find(f => f[0] === p.color);
      w.append(el('div', { class: 'row' }, el('label', {}, 'Filter'), selectEl([...PHOTO_FILTERS, ['custom', 'Color…']], known ? p.color : 'custom', (v) => { if (v !== 'custom') { p.color = v; upd(); rerender(); } })));
      w.append(el('div', { class: 'row' }, el('label', {}, 'Color'), colorEl(p.color, (v) => { p.color = v; upd(); }, (v) => { p.color = v; live(); })));
      w.append(S('Density', p, 'density', 0, 100, 1, { unit: '%' }), checkEl('Preserve Luminosity', p.preserveLuminosity, (v) => { p.preserveLuminosity = v; upd(); }));
      break;
    }
    case 'channelMixer': {
      let out = p.monochrome ? 'gray' : 'red';
      const box = el('div', {});
      const draw = () => { box.innerHTML = ''; const o = p[out] || (p[out] = { r: 40, g: 40, b: 20, c: 0 }); for (const [k, n] of [['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['c', 'Constant']]) box.append(S(n, o, k, -200, 200, 1, { unit: '%' })); const tot = o.r + o.g + o.b; box.append(el('div', { class: 'muted' }, `Total: ${tot > 0 ? '+' : ''}${tot}%`)); };
      w.append(el('div', { class: 'row' }, el('label', {}, 'Output'), selectEl(p.monochrome ? [['gray', 'Gray']] : [['red', 'Red'], ['green', 'Green'], ['blue', 'Blue']], out, (v) => { out = v; draw(); })), box);
      w.append(checkEl('Monochrome', p.monochrome, (v) => { p.monochrome = v; if (v) p.gray = p.gray || { r: 40, g: 40, b: 20, c: 0 }; upd(); rerender(); }));
      draw(); break;
    }
    case 'invert': w.append(el('div', { class: 'muted' }, 'Invert has no settings.')); break;
    case 'posterize': w.append(S('Levels', p, 'levels', 2, 255)); break;
    case 'threshold': {
      const hist = histBelow(d, L); const cv = el('canvas', { class: 'histo', width: 256, height: 90 });
      w.append(cv, S('Threshold Level', p, 'level', 1, 255)); requestAnimationFrame(() => drawHist(cv, hist, 'l')); break;
    }
    case 'gradientMap': {
      const bar = el('div', { style: { height: '20px', border: '1px solid #111', background: gradientCSS(p.stops, app.fg, app.bg) } });
      const presets = GRADIENT_PRESETS.filter(g => Array.isArray(g.stops));
      w.append(el('div', { class: 'row' }, el('label', {}, 'Gradient'), selectEl([['', 'Custom'], ['fgbg', 'Foreground to Background'], ...presets.map((g, k) => [k, g.name])], '', (v) => { if (v === '') return; p.stops = v === 'fgbg' ? [{ pos: 0, color: app.fg }, { pos: 1, color: app.bg }] : JSON.parse(JSON.stringify(presets[v].stops)); upd(); rerender(); })), bar);
      const stopsRow = el('div', { class: 'btnrow' });
      p.stops.forEach((s, k) => stopsRow.append(colorEl(s.color, (v) => { s.color = v; upd(); rerender(); }, (v) => { s.color = v; live(); bar.style.background = gradientCSS(p.stops); })));
      w.append(el('div', { class: 'row' }, el('label', {}, 'Stops'), stopsRow), checkEl('Reverse', p.reverse, (v) => { p.reverse = v; upd(); }));
      break;
    }
    case 'selectiveColor': {
      let c = 'reds'; const box = el('div', {});
      const draw = () => { box.innerHTML = ''; const o = p.colors[c]; for (const [k, n, g] of [['c', 'Cyan', '#0ff'], ['m', 'Magenta', '#f0f'], ['y', 'Yellow', '#ff0'], ['k', 'Black', '#000']]) box.append(S(n, o, k, -100, 100, 1, { unit: '%' })); };
      w.append(el('div', { class: 'row' }, el('label', {}, 'Colors'), selectEl([['reds', 'Reds'], ['yellows', 'Yellows'], ['greens', 'Greens'], ['cyans', 'Cyans'], ['blues', 'Blues'], ['magentas', 'Magentas'], ['whites', 'Whites'], ['neutrals', 'Neutrals'], ['blacks', 'Blacks']], c, (v) => { c = v; draw(); })), box);
      w.append(el('div', { class: 'row' }, el('label', {}, 'Method'), selectEl([['relative', 'Relative'], ['absolute', 'Absolute']], p.method, (v) => { p.method = v; upd(); })));
      draw(); break;
    }
  }
  foot();
}
function plot(g, lut, col) { g.strokeStyle = col; g.lineWidth = 1.5; g.beginPath(); for (let x = 0; x < 256; x++) { const y = 255 - lut[x]; x ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
function drawHistInto(g, arr) { let max = 0; for (let i = 1; i < 255; i++) max = Math.max(max, arr[i]); g.fillStyle = '#888'; for (let i = 0; i < 256; i++) { const v = Math.min(1, arr[i] / (max || 1)); g.fillRect(i, 256 - v * 256, 1, v * 256); } }
function pctl(arr, f) { let tot = 0; for (const v of arr) tot += v; let acc = 0; for (let i = 0; i < 256; i++) { acc += arr[i]; if (acc >= tot * f) return i; } return 255; }
function autoLevels(h, p) { for (const [c, k] of [['r', 'r'], ['g', 'g'], ['b', 'b']]) { const lo = pctl(h[k], 0.001), hi = pctl(h[k], 0.999); p.channels[c] = { ...p.channels[c], inBlack: Math.min(lo, 250), inWhite: Math.max(hi, lo + 5) }; } }
function autoCurves(h, p) { for (const k of ['r', 'g', 'b']) { const lo = pctl(h[k], 0.001), hi = pctl(h[k], 0.999); p.channels[k] = [[lo, 0], [Math.max(hi, lo + 5), 255]]; } }
