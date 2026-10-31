// Tool options bar (context-sensitive)
import { app, cmd } from '../state.js';
import { el, $, clamp } from '../util.js';
import { ICONS } from '../icons.js';
import { tools } from '../tools/base.js';
import { selectEl, checkEl, numField, showMenu, colorEl } from './common.js';
import { GRADIENT_PRESETS, gradientCSS } from '../doc/gradient.js';
import { BLEND_MODES } from '../doc/blend.js';

const o = (id) => app.opts[id];
const set = (id, k, v) => { app.opts[id][k] = v; app.emit('opts', id, k); saveOpts(); };
let saveT; function saveOpts() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('strata.opts', JSON.stringify(app.opts)); } catch {} }, 400); }

const sep = () => el('div', { class: 'sepv' });
const lbl = (t, ...k) => el('label', {}, t, ...k);
function num(id, k, label, min, max, unit = '', w = 48, step = 1) {
  return numField({ label, value: o(id)[k], min, max, step, unit, width: w, onInput: (v) => set(id, k, v) });
}
function pct(id, k, label) { return num(id, k, label, 0, 100, '%', 44); }
function chk(id, k, label) { return checkEl(label, o(id)[k], (v) => set(id, k, v)); }
function sel(id, k, options, label) { const s = selectEl(options, o(id)[k], (v) => set(id, k, isNaN(v) || v === '' ? v : (typeof o(id)[k] === 'number' ? Number(v) : v))); return label ? lbl(label, s) : s; }
function seg(id, k, opts) {
  const w = el('div', { class: 'seg' });
  for (const [v, icon, title] of opts) {
    const b = el('button', { class: 'ibtn' + (o(id)[k] === v ? ' on' : ''), title, html: ICONS[icon] || icon, onclick: () => { set(id, k, v); render(); } });
    w.append(b);
  }
  return w;
}
const brushModes = [['normal', 'Normal'], ['behind', 'Behind'], ['clear', 'Clear'], null, ['darken', 'Darken'], ['multiply', 'Multiply'], ['colorBurn', 'Color Burn'], null, ['lighten', 'Lighten'], ['screen', 'Screen'], ['colorDodge', 'Color Dodge'], ['linearDodge', 'Linear Dodge (Add)'], null, ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['hardLight', 'Hard Light'], null, ['difference', 'Difference'], ['exclusion', 'Exclusion'], null, ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity']];

function brushPicker(id) {
  const t = o(id);
  const b = el('button', { class: 'btn quiet', style: { padding: '0 6px', gap: '4px' }, title: 'Brush preset picker' }, el('span', { class: 'ico', html: ICONS.brushPreset }), String(Math.round(t.size)), el('span', { class: 'ico', style: { width: '10px' }, html: ICONS.chevronDown }));
  b.onclick = () => {
    const r = b.getBoundingClientRect();
    const pop = el('div', { class: 'slidepop', style: { left: r.left + 'px', top: r.bottom + 4 + 'px', width: '260px' } });
    const mk = (label, k, min, max, unit, scale = 1) => {
      const v = el('input', { type: 'range', min, max, value: t[k] * scale, style: { width: '100%' } });
      const n = el('span', { style: { width: '50px', textAlign: 'right' } }, Math.round(t[k] * scale) + unit);
      v.oninput = () => { set(id, k, Number(v.value) / scale); n.textContent = v.value + unit; b.childNodes[1].textContent = String(Math.round(o(id).size)); };
      return el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' } }, el('span', { style: { width: '60px', color: 'var(--text2)' } }, label), v, n);
    };
    pop.append(mk('Size', 'size', 1, 1000, ' px'));
    if (t.hardness != null) pop.append(mk('Hardness', 'hardness', 0, 100, '%', 100));
    if (t.spacing != null) pop.append(mk('Spacing', 'spacing', 1, 200, '%'));
    if (t.roundness != null) pop.append(mk('Roundness', 'roundness', 1, 100, '%'));
    if (t.angle != null) pop.append(mk('Angle', 'angle', -180, 180, '°'));
    const presets = el('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: '4px', marginTop: '8px' } });
    for (const [sz, hd] of [[5, 1], [9, 1], [13, 1], [19, 1], [30, 1], [45, 1], [9, 0], [13, 0], [19, 0], [30, 0], [60, 0], [100, 0], [200, 0], [300, 0], [500, 0]]) {
      const c = el('div', { title: `${sz}px ${hd ? 'hard' : 'soft'}`, style: { height: '36px', display: 'grid', placeItems: 'center', background: 'var(--bg1)', borderRadius: '3px', fontSize: '10px' } });
      const dot = el('div', { style: { width: Math.min(24, 6 + sz / 8) + 'px', height: Math.min(24, 6 + sz / 8) + 'px', borderRadius: '50%', background: hd ? '#ddd' : 'radial-gradient(#ddd, transparent 70%)' } });
      c.append(dot, el('span', { style: { color: 'var(--text3)', marginTop: '-6px' } }, sz));
      c.onclick = () => { set(id, 'size', sz); set(id, 'hardness', hd); pop.remove(); render(); };
      presets.append(c);
    }
    pop.append(presets);
    document.body.append(pop);
    const close = (e) => { if (!pop.contains(e.target) && e.target !== b) { pop.remove(); removeEventListener('pointerdown', close, true); render(); } };
    setTimeout(() => addEventListener('pointerdown', close, true), 0);
  };
  return b;
}
function selModes(id) {
  return seg(id, 'mode', [['new', '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14"/></svg>', 'New selection'], ['add', '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="11" height="11"/><rect x="10" y="10" width="11" height="11"/></svg>', 'Add to selection (Shift)'], ['subtract', '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="11" fill="currentColor"/><rect x="10" y="10" width="11" height="11" fill="#353535" stroke="currentColor"/></svg>', 'Subtract from selection (Alt)'], ['intersect', '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="11" height="11" fill="none" stroke="currentColor"/><rect x="10" y="10" width="11" height="11" fill="none" stroke="currentColor"/><rect x="10" y="10" width="4" height="4" fill="currentColor"/></svg>', 'Intersect with selection (Shift+Alt)']]);
}
const selActions = () => [el('button', { class: 'btn', onclick: () => cmd('selectSubject') }, el('span', { class: 'ico', html: ICONS.subject }), 'Select Subject'), el('button', { class: 'btn', onclick: () => cmd('selectAndMask') }, 'Select and Mask…')];

function transformBar(tr) {
  const c = tr.center();
  const f = (label, val, unit, apply, dec = 1) => numField({ label, value: Number(val.toFixed(dec)), step: dec ? 0.1 : 1, width: 58, unit, onChange: apply });
  return [
    el('div', { class: 'tool-ico', html: ICONS.transform }),
    f('X:', c.x, 'px', (v) => tr.setNumeric({ x: v })), f('Y:', c.y, 'px', (v) => tr.setNumeric({ y: v })), sep(),
    f('W:', tr.scaleX() * 100, '%', (v) => tr.setNumeric({ sx: v / 100 })), f('H:', tr.scaleY() * 100, '%', (v) => tr.setNumeric({ sy: v / 100 })), sep(),
    f('∠', tr.angle() * 180 / Math.PI, '°', (v) => tr.setNumeric({ angle: v * Math.PI / 180 })), sep(),
    lbl('Interpolation:', selectEl([['bicubic', 'Bicubic Automatic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest Neighbor']], tr.interp, (v) => { tr.interp = v; tr.preview(); })),
    el('span', { class: 'grow' }),
    el('button', { class: 'ibtn', title: 'Flip Horizontal', html: ICONS.flipH, onclick: () => tr.flip('h') }),
    el('button', { class: 'ibtn', title: 'Flip Vertical', html: ICONS.flipV, onclick: () => tr.flip('v') }),
    el('button', { class: 'ibtn', title: 'Rotate 90° Clockwise', html: ICONS.rotate, onclick: () => tr.rotateBy(90) }), sep(),
    el('button', { class: 'ibtn', title: 'Cancel transform (Esc)', html: ICONS.cancel, onclick: () => tr.cancel() }),
    el('button', { class: 'ibtn', title: 'Commit transform (Enter)', html: ICONS.check, onclick: () => tr.commit() }),
  ];
}

const builders = {
  move: (id) => [chk(id, 'autoSelect', 'Auto-Select:'), sel(id, 'autoTarget', [['layer', 'Layer'], ['group', 'Group']]), sep(),
    ...[['alignLeft', 'left'], ['alignCenterH', 'hcenter'], ['alignRight', 'right'], ['alignTop', 'top'], ['alignMiddleV', 'vcenter'], ['alignBottom', 'bottom']].map(([ic, a]) => el('button', { class: 'ibtn', title: 'Align ' + a, html: ICONS[ic], onclick: () => cmd('align', a) })),
    sep(), el('button', { class: 'btn quiet', onclick: () => cmd('freeTransform') }, el('span', { class: 'ico', html: ICONS.transform }), 'Transform')],
  marqueeRect: (id) => [selModes(id), sep(), num(id, 'feather', 'Feather:', 0, 1000, 'px'), chk(id, 'antiAlias', 'Anti-alias'), sep(), sel(id, 'style', [['normal', 'Normal'], ['fixedRatio', 'Fixed Ratio'], ['fixedSize', 'Fixed Size']], 'Style:'),
    ...(o(id).style === 'fixedRatio' ? [num(id, 'ratioW', 'W:', 0.01, 1000, '', 40, .01), num(id, 'ratioH', 'H:', 0.01, 1000, '', 40, .01)] : o(id).style === 'fixedSize' ? [num(id, 'fixedW', 'W:', 1, 30000, 'px'), num(id, 'fixedH', 'H:', 1, 30000, 'px')] : []), sep(), ...selActions()],
  lasso: (id) => [selModes(id), sep(), num(id, 'feather', 'Feather:', 0, 1000, 'px'), chk(id, 'antiAlias', 'Anti-alias'), sep(), ...selActions()],
  magicWand: (id) => [selModes(id), sep(), num(id, 'tolerance', 'Tolerance:', 0, 255, ''), chk(id, 'antiAlias', 'Anti-alias'), chk(id, 'contiguous', 'Contiguous'), chk(id, 'sampleAll', 'Sample All Layers'), sep(), ...selActions()],
  quickSelect: (id) => [seg(id, 'mode', [['new', '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>', 'New selection'], ['add', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/><path d="M17 15v6M14 18h6"/></svg>', 'Add to selection'], ['subtract', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6"/><path d="M14 18h6"/></svg>', 'Subtract from selection']]), sep(), brushPicker(id), chk(id, 'sampleAll', 'Sample All Layers'), chk(id, 'enhanceEdge', 'Enhance Edge'), sep(), ...selActions()],
  objectSelect: (id) => [selModes(id), sep(), sel(id, 'drawMode', [['rect', 'Rectangle'], ['lasso', 'Lasso']], 'Mode:'), chk(id, 'sampleAll', 'Sample All Layers'), sep(), ...selActions()],
  crop: (id) => [sel(id, 'ratio', [['free', 'Ratio'], ['original', 'Original Ratio'], ['1:1', '1 : 1 (Square)'], ['4:5', '4 : 5 (8 : 10)'], ['5:4', '5 : 4'], ['2:3', '2 : 3 (4 : 6)'], ['3:2', '3 : 2'], ['4:3', '4 : 3'], ['16:9', '16 : 9'], ['9:16', '9 : 16'], ['custom', 'Custom…']]),
    ...(o(id).ratio === 'custom' ? [num(id, 'customW', '', 0, 100000, '', 50), el('span', {}, '×'), num(id, 'customH', '', 0, 100000, '', 50)] : []),
    el('button', { class: 'btn quiet', onclick: () => tools.crop.reset() }, 'Clear'), sep(), sel(id, 'overlay', [['thirds', 'Rule of Thirds'], ['none', 'Never Show Overlay']]), chk(id, 'deleteCropped', 'Delete Cropped Pixels'),
    el('span', { class: 'grow' }), el('button', { class: 'ibtn', title: 'Cancel (Esc)', html: ICONS.cancel, onclick: () => tools.crop.reset() }), el('button', { class: 'ibtn', title: 'Commit (Enter)', html: ICONS.check, onclick: () => tools.crop.commit() })],
  eyedropper: (id) => [sel(id, 'sampleSize', [[1, 'Point Sample'], [3, '3 by 3 Average'], [5, '5 by 5 Average'], [11, '11 by 11 Average'], [31, '31 by 31 Average'], [51, '51 by 51 Average'], [101, '101 by 101 Average']], 'Sample Size:'), sel(id, 'sample', [['current', 'Current Layer'], ['all', 'All Layers']], 'Sample:'), chk(id, 'showRing', 'Show Sampling Ring')],
  brush: (id) => [brushPicker(id), sep(), sel(id, 'mode', brushModes, 'Mode:'), pct(id, 'opacity', 'Opacity:'), btnToggle(id, 'pressureOpacity', 'pressure', 'Always use Pressure for Opacity'), pct(id, 'flow', 'Flow:'), btnToggle(id, 'airbrush', 'airbrush', 'Enable airbrush-style build-up effects'), pct(id, 'smoothing', 'Smoothing:'), num(id, 'angle', '∠', -180, 180, '°', 44), btnToggle(id, 'pressureSize', 'pressure', 'Always use Pressure for Size')],
  pencil: (id) => [brushPicker(id), sep(), sel(id, 'mode', brushModes, 'Mode:'), pct(id, 'opacity', 'Opacity:'), pct(id, 'smoothing', 'Smoothing:'), chk(id, 'autoErase', 'Auto Erase'), btnToggle(id, 'pressureSize', 'pressure', 'Always use Pressure for Size')],
  eraser: (id) => [brushPicker(id), sep(), pct(id, 'opacity', 'Opacity:'), pct(id, 'flow', 'Flow:'), pct(id, 'smoothing', 'Smoothing:'), btnToggle(id, 'pressureSize', 'pressure', 'Always use Pressure for Size')],
  magicEraser: (id) => [num(id, 'tolerance', 'Tolerance:', 0, 255, ''), chk(id, 'antiAlias', 'Anti-alias'), chk(id, 'contiguous', 'Contiguous'), chk(id, 'sampleAll', 'Sample All Layers'), pct(id, 'opacity', 'Opacity:')],
  clone: (id) => [brushPicker(id), sep(), sel(id, 'mode', brushModes, 'Mode:'), pct(id, 'opacity', 'Opacity:'), pct(id, 'flow', 'Flow:'), chk(id, 'aligned', 'Aligned'), sel(id, 'sample', [['current', 'Current Layer'], ['all', 'All Layers']], 'Sample:')],
  historyBrush: (id) => [brushPicker(id), sep(), sel(id, 'mode', brushModes, 'Mode:'), pct(id, 'opacity', 'Opacity:'), pct(id, 'flow', 'Flow:'), el('span', { class: 'muted', style: { color: 'var(--text3)' } }, 'Source: set in History panel')],
  heal: (id) => [brushPicker(id), sep(), chk(id, 'aligned', 'Aligned'), sel(id, 'sample', [['current', 'Current Layer'], ['all', 'All Layers']], 'Sample:'), num(id, 'diffusion', 'Diffusion:', 1, 7, '')],
  spotHeal: (id) => [brushPicker(id), sep(), lbl('Type:'), seg(id, 'type', [['content-aware', '<span style="font-size:11px;padding:0 6px">Content-Aware</span>', 'Content-Aware'], ['texture', '<span style="font-size:11px;padding:0 6px">Create Texture</span>', 'Create Texture'], ['proximity', '<span style="font-size:11px;padding:0 6px">Proximity Match</span>', 'Proximity Match']]), chk(id, 'sampleAll', 'Sample All Layers')],
  removeTool: (id) => [brushPicker(id), sep(), chk(id, 'sampleAll', 'Sample All Layers'), chk(id, 'useAI', 'Use AI (LaMa) when available'), el('span', { style: { color: 'var(--text3)' } }, 'Paint over distractions; release to remove')],
  redEye: (id) => [pct(id, 'pupil', 'Pupil Size:'), pct(id, 'darken', 'Darken Amount:')],
  gradient: (id) => [gradPicker(id), sep(), seg(id, 'type', [['linear', gradIcon('linear'), 'Linear'], ['radial', gradIcon('radial'), 'Radial'], ['angle', gradIcon('angle'), 'Angle'], ['reflected', gradIcon('reflected'), 'Reflected'], ['diamond', gradIcon('diamond'), 'Diamond']]), sep(), sel(id, 'mode', [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['softLight', 'Soft Light'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['difference', 'Difference'], ['color', 'Color'], ['luminosity', 'Luminosity']], 'Mode:'), pct(id, 'opacity', 'Opacity:'), chk(id, 'reverse', 'Reverse'), chk(id, 'dither', 'Dither'), chk(id, 'transparency', 'Transparency')],
  bucket: (id) => [sel(id, 'mode', [['normal', 'Normal'], ['behind', 'Behind'], ['clear', 'Clear'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'], ['color', 'Color']], 'Mode:'), pct(id, 'opacity', 'Opacity:'), num(id, 'tolerance', 'Tolerance:', 0, 255, ''), chk(id, 'antiAlias', 'Anti-alias'), chk(id, 'contiguous', 'Contiguous'), chk(id, 'sampleAll', 'All Layers')],
  blurTool: (id) => [brushPicker(id), sep(), pct(id, 'strength', 'Strength:'), chk(id, 'sampleAll', 'Sample All Layers')],
  sharpenTool: (id) => [brushPicker(id), sep(), pct(id, 'strength', 'Strength:'), chk(id, 'protectDetail', 'Protect Detail')],
  smudge: (id) => [brushPicker(id), sep(), pct(id, 'strength', 'Strength:'), chk(id, 'fingerPainting', 'Finger Painting')],
  dodge: (id) => [brushPicker(id), sep(), sel(id, 'range', [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], 'Range:'), pct(id, 'exposure', 'Exposure:'), chk(id, 'protectTones', 'Protect Tones')],
  sponge: (id) => [brushPicker(id), sep(), sel(id, 'spongeMode', [['desaturate', 'Desaturate'], ['saturate', 'Saturate']], 'Mode:'), pct(id, 'flow', 'Flow:'), chk(id, 'vibrance', 'Vibrance')],
  type: (id) => {
    const t = o(id); const L = app.doc?.active?.kind === 'text' ? app.doc.active : null; const d = L ? L.data : t;
    const fontSel = selectEl(app.fonts.map(f => [f, f]), d.font, (v) => { set(id, 'font', v); app.emit('typeopt', 'font', v); });
    fontSel.style.width = '170px';
    const style = selectEl([['r', 'Regular'], ['b', 'Bold'], ['i', 'Italic'], ['bi', 'Bold Italic']], (d.bold ? 'b' : '') + (d.italic ? 'i' : '') || 'r', (v) => { const b = v.includes('b'), it = v.includes('i'); set(id, 'bold', b); set(id, 'italic', it); app.emit('typeopt', 'bold', b); app.emit('typeopt', 'italic', it); });
    const size = numField({ label: '', value: d.size, min: 1, max: 5000, unit: 'px', width: 56, onChange: (v) => { set(id, 'size', v); app.emit('typeopt', 'size', v); } });
    const al = (a, ic) => el('button', { class: 'ibtn' + ((d.align || 'left') === a ? ' on' : ''), html: ICONS[ic], title: 'Align ' + a, onclick: () => { set(id, 'align', a); app.emit('typeopt', 'align', a); render(); } });
    const col = colorEl(d.color || app.fg, (v) => { set(id, 'color', v); app.emit('typeopt', 'color', v); });
    const editing = tools.type.editing;
    return [fontSel, style, size, sep(), al('left', 'textLeft'), al('center', 'textCenter'), al('right', 'textRight'), sep(), lbl('Color:', col), numField({ label: 'Tracking:', value: d.tracking || 0, min: -1000, max: 10000, width: 50, onChange: (v) => { set(id, 'tracking', v); app.emit('typeopt', 'tracking', v); } }),
      el('span', { class: 'grow' }), ...(editing ? [el('button', { class: 'ibtn', html: ICONS.cancel, title: 'Cancel', onclick: () => { const ed = tools.type.editing; if (ed) { ed.layer.data = JSON.parse(ed.orig); tools.type.commitEdit(); } } }), el('button', { class: 'ibtn', html: ICONS.check, title: 'Commit (Ctrl+Enter)', onclick: () => tools.type.commitEdit() })] : [])];
  },
  rectShape: (id) => shapeBar(id), ellipseShape: (id) => shapeBar(id), triangleShape: (id) => shapeBar(id), polygonShape: (id) => shapeBar(id), starShape: (id) => shapeBar(id),
  lineShape: (id) => [lbl('Stroke:', colorEl(o(id).fill || app.fg, (v) => set(id, 'fill', v))), num(id, 'lineWeight', 'Weight:', 1, 1000, 'px')],
  hand: () => [el('button', { class: 'btn', onclick: () => cmd('zoom100') }, '100%'), el('button', { class: 'btn', onclick: () => cmd('fitOnScreen') }, 'Fit Screen'), el('button', { class: 'btn', onclick: () => cmd('fillScreen') }, 'Fill Screen')],
  zoom: (id) => [el('button', { class: 'ibtn', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6M10.5 7.5v6"/></svg>', title: 'Zoom in', onclick: () => cmd('zoomIn') }), el('button', { class: 'ibtn', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/></svg>', title: 'Zoom out', onclick: () => cmd('zoomOut') }), chk(id, 'scrubby', 'Scrubby Zoom'), sep(), el('button', { class: 'btn', onclick: () => cmd('zoom100') }, '100%'), el('button', { class: 'btn', onclick: () => cmd('fitOnScreen') }, 'Fit Screen'), el('button', { class: 'btn', onclick: () => cmd('fillScreen') }, 'Fill Screen')],
};
const penMode = (id) => sel(id, 'mode', [['shape', 'Shape'], ['path', 'Path']]);
const pathOps = () => [el('span', { style: { color: 'var(--text2)' } }, 'Make:'), el('button', { class: 'btn', onclick: () => cmd('pathToSelectionDialog') }, 'Selection…'), el('button', { class: 'btn', onclick: () => cmd('addVectorMask', 'path') }, 'Mask'), el('button', { class: 'btn', onclick: () => cmd('fillPath') }, 'Fill'), el('button', { class: 'btn', onclick: () => cmd('strokePathDialog') }, 'Stroke…')];
const penShapeOpts = (id) => o(id).mode === 'shape' ? [lbl('Fill:'), colorEl(o(id).fill || app.fg, (v) => set(id, 'fill', v)), lbl('Stroke:'), colorEl(o(id).stroke || '#000000', (v) => set(id, 'stroke', v)), checkEl('', !!o(id).stroke, (v) => set(id, 'stroke', v ? (o(id).stroke || '#000000') : null)), num(id, 'strokeWidth', '', 0, 1000, 'px', 44)] : pathOps();
builders.pen = (id) => [penMode(id), sep(), ...penShapeOpts(id), sep(), chk(id, 'rubberBand', 'Rubber Band'), chk(id, 'autoAddDelete', 'Auto Add/Delete')];
builders.freeformPen = (id) => [penMode(id), sep(), num(id, 'fit', 'Curve Fit:', 0.5, 10, 'px', 44, 0.5), sep(), ...pathOps()];
builders.addAnchor = () => [el('span', { style: { color: 'var(--text2)' } }, 'Click a path segment to add an anchor point.')];
builders.deleteAnchor = () => [el('span', { style: { color: 'var(--text2)' } }, 'Click an anchor point to delete it.')];
builders.convertPoint = () => [el('span', { style: { color: 'var(--text2)' } }, 'Click an anchor to toggle smooth/corner, drag a handle to break it.')];
builders.pathSelect = () => [...pathOps(), sep(), el('span', { style: { color: 'var(--text2)' } }, 'Alt-drag duplicates a path. Delete removes it.')];
builders.directSelect = () => [...pathOps(), sep(), el('span', { style: { color: 'var(--text2)' } }, 'Drag anchors/handles. Alt-drag a handle breaks the curve.')];
builders.artboardTool = (id) => [lbl('Background:'), sel(id, 'bg', [['#ffffff', 'White'], ['#000000', 'Black'], ['transparent', 'Transparent']]), sep(), el('button', { class: 'btn', onclick: () => cmd('newArtboard') }, 'New Artboard…'), el('button', { class: 'btn', onclick: () => cmd('artboardFromLayers') }, 'From Layers'), el('button', { class: 'btn', onclick: () => cmd('exportArtboards') }, 'Export Artboards…')];
builders.marqueeEllipse = builders.marqueeRect; builders.marqueeRow = (id) => [selModes(id)]; builders.marqueeCol = builders.marqueeRow; builders.polyLasso = builders.lasso; builders.burn = builders.dodge;

function shapeBar(id) {
  const t = o(id);
  const fill = el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } }, lbl('Fill:'), colorEl(t.fill || app.fg, (v) => set(id, 'fill', v)), checkEl('None', t.noFill, (v) => set(id, 'noFill', v)));
  const stroke = el('div', { style: { display: 'flex', alignItems: 'center', gap: '4px' } }, lbl('Stroke:'), colorEl(t.stroke || '#000000', (v) => set(id, 'stroke', v)), checkEl('', !!t.stroke, (v) => set(id, 'stroke', v ? (t.stroke || '#000000') : null)));
  const extra = id === 'rectShape' ? [num(id, 'radius', 'Radius:', 0, 5000, 'px')] : id === 'polygonShape' ? [num(id, 'sides', 'Sides:', 3, 100, '')] : id === 'starShape' ? [num(id, 'sides', 'Points:', 3, 100, ''), num(id, 'inner', 'Indent:', 1, 99, '%')] : [];
  return [lbl('Shape'), sep(), fill, stroke, num(id, 'strokeWidth', '', 0, 1000, 'px', 44), sep(), ...extra];
}
function btnToggle(id, k, icon, title) { const b = el('button', { class: 'ibtn' + (o(id)[k] ? ' on' : ''), title, html: ICONS[icon] }); b.onclick = () => { set(id, k, !o(id)[k]); b.classList.toggle('on', o(id)[k]); }; return b; }
function gradIcon(type) {
  const css = { linear: 'linear-gradient(90deg,#000,#fff)', radial: 'radial-gradient(#fff,#000)', angle: 'conic-gradient(#fff,#000)', reflected: 'linear-gradient(90deg,#000,#fff,#000)', diamond: 'radial-gradient(closest-side,#fff,#000)' }[type];
  return `<span style="display:block;width:16px;height:16px;border:1px solid #888;background:${css}${type === 'diamond' ? ';transform:rotate(45deg) scale(.75)' : ''}"></span>`;
}
function gradPicker(id) {
  const p = GRADIENT_PRESETS[o(id).preset] || GRADIENT_PRESETS[0];
  const b = el('button', { class: 'btn quiet', style: { padding: '0 4px' }, title: 'Gradient preset' }, el('span', { style: { display: 'block', width: '110px', height: '18px', border: '1px solid #888', background: gradientCSS(p.stops, app.fg, app.bg) } }), el('span', { class: 'ico', style: { width: '10px' }, html: ICONS.chevronDown }));
  b.onclick = () => { const r = b.getBoundingClientRect(); showMenu(GRADIENT_PRESETS.map((g, k) => ({ label: g.name, check: k === o(id).preset, run: () => { set(id, 'preset', k); render(); } })), r.left, r.bottom + 2); };
  return b;
}

let rootEl;
export function render() {
  rootEl = rootEl || $('#optionsbar');
  rootEl.innerHTML = '';
  if (app.transform && app.transform.setNumeric) { rootEl.append(...transformBar(app.transform)); return; }
  const id = app.tool, t = tools[id]; if (!t) return;
  rootEl.append(el('div', { class: 'tool-ico', title: t.label, html: ICONS[t.icon] || '' }));
  const b = builders[id];
  if (b) rootEl.append(...b(id).filter(Boolean));
}
export function initOptionsBar() {
  try { const s = JSON.parse(localStorage.getItem('strata.opts') || '{}'); for (const k in s) if (app.opts[k]) Object.assign(app.opts[k], s[k]); } catch {}
  render();
  app.on('tool', render); app.on('transform', render); app.on('colors', () => { if (['gradient', 'type', 'rectShape', 'ellipseShape', 'lineShape'].includes(app.tool)) render(); });
  app.on('fonts', () => { if (app.tool === 'type') render(); });
  app.on('opts', (id, k) => { if (k === 'style' || k === 'ratio' || k === 'mode') render(); });
  app.on('layers-sel', () => { if (app.tool === 'type') render(); });
}
