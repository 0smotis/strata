// File I/O: PSD (via ag-psd) and raster formats.
import { Document, Layer, refreshVector, DEFAULT_EFFECTS } from './document.js';
import { createCanvas, ctx2d, bytesToImage, canvasToBytes, hexToRgb, rgbToHex } from '../util.js';
import { fromPsdBlend, toPsdBlend } from './blend.js';
import { defaultParams } from '../engine/adjust.js';
import { toPsdPaths, fromPsdPaths, transformPaths, clonePaths, shapeToSubpaths as shapeSub } from './paths.js';

const psd = () => window.agPsd;
export const basename = (p) => String(p).split(/[\\/]/).pop();
export const extname = (p) => (basename(p).match(/\.([^.]+)$/) || [, ''])[1].toLowerCase();
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon' };

export async function openBytes(bytes, name, path) {
  const ext = extname(name);
  if (ext === 'psd' || ext === 'psb') return openPsd(bytes, name, path);
  const img = await bytesToImage(bytes, MIME[ext]);
  const w = img.width, h = img.height;
  const doc = new Document(w, h, { name, path });
  const L = doc.newPixelLayer('Background');
  ctx2d(L.canvas).drawImage(img, 0, 0);
  const hasAlpha = ['png', 'webp', 'gif', 'avif', 'svg', 'ico'].includes(ext) && imageHasAlpha(L.canvas);
  if (hasAlpha) L.name = 'Layer 0';
  else L.locks = { ...L.locks, background: true, position: true };
  doc.addLayer(L);
  doc.commit('Open', 'open'); doc.dirty = false;
  return doc;
}
export async function canvasFromBytes(bytes, name) {
  const img = await bytesToImage(bytes, MIME[extname(name)]);
  const c = createCanvas(img.width, img.height); ctx2d(c).drawImage(img, 0, 0); return c;
}
function imageHasAlpha(c) {
  const d = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 64) if (d[i] < 255) return true;
  return false;
}

// ----- PSD read -----
function grayToAlphaMask(src) {
  const c = createCanvas(src.width, src.height), g = ctx2d(c);
  g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = d[i]; d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = v; }
  g.putImageData(id, 0, 0); return c;
}
function alphaToGrayMask(src) {
  const c = createCanvas(src.width, src.height), g = ctx2d(c);
  g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = d[i + 3]; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  g.putImageData(id, 0, 0); return c;
}
const col = (c) => c ? rgbToHex(c.r ?? 0, c.g ?? 0, c.b ?? 0) : '#000000';
const unitVal = (v, d = 0) => (v == null ? d : typeof v === 'number' ? v : v.value ?? d);

function readAdjustment(a) {
  if (!a) return null;
  const t = a.type;
  try {
    if (t === 'brightness/contrast') return { type: 'brightnessContrast', params: { brightness: a.brightness || 0, contrast: a.contrast || 0, legacy: !!a.useLegacy } };
    if (t === 'levels') {
      const ch = (c) => c ? { inBlack: c.shadowInput ?? 0, inWhite: c.highlightInput ?? 255, gamma: c.midtoneInput ?? 1, outBlack: c.shadowOutput ?? 0, outWhite: c.highlightOutput ?? 255 } : { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
      return { type: 'levels', params: { channels: { rgb: ch(a.rgb), r: ch(a.red), g: ch(a.green), b: ch(a.blue) } } };
    }
    if (t === 'curves') {
      const ch = (c) => c && c.length ? c.map(p => [p.input, p.output]) : [[0, 0], [255, 255]];
      return { type: 'curves', params: { channels: { rgb: ch(a.rgb), r: ch(a.red), g: ch(a.green), b: ch(a.blue) } } };
    }
    if (t === 'exposure') return { type: 'exposure', params: { exposure: a.exposure || 0, offset: a.offset || 0, gamma: a.gamma || 1 } };
    if (t === 'vibrance') return { type: 'vibrance', params: { vibrance: a.vibrance || 0, saturation: a.saturation || 0 } };
    if (t === 'hue/saturation') return { type: 'hueSaturation', params: { hue: a.master?.hue || 0, saturation: a.master?.saturation || 0, lightness: a.master?.lightness || 0, colorize: !!a.colorize } };
    if (t === 'color balance') {
      const tr = (c) => c ? [c.cyanRed || 0, c.magentaGreen || 0, c.yellowBlue || 0] : [0, 0, 0];
      return { type: 'colorBalance', params: { shadows: tr(a.shadows), midtones: tr(a.midtones), highlights: tr(a.highlights), preserveLuminosity: a.preserveLuminosity ?? true } };
    }
    if (t === 'black & white') return { type: 'blackWhite', params: { ...defaultParams('blackWhite'), reds: a.reds ?? 40, yellows: a.yellows ?? 60, greens: a.greens ?? 40, cyans: a.cyans ?? 60, blues: a.blues ?? 20, magentas: a.magentas ?? 80, tint: !!a.useTint } };
    if (t === 'photo filter') return { type: 'photoFilter', params: { color: a.color ? col(a.color) : '#ec8a00', density: a.density ?? 25, preserveLuminosity: a.preserveLuminosity ?? true } };
    if (t === 'invert') return { type: 'invert', params: {} };
    if (t === 'posterize') return { type: 'posterize', params: { levels: a.levels || 4 } };
    if (t === 'threshold') return { type: 'threshold', params: { level: a.level || 128 } };
    if (t === 'gradient map' && a.gradient?.colorStops) return { type: 'gradientMap', params: { stops: a.gradient.colorStops.map(s => ({ pos: s.location / 4096, color: col(s.color) })), reverse: !!a.reverse } };
  } catch (e) { console.warn('adjustment import failed', e); }
  return null;
}

function readEffects(fx) {
  if (!fx) return null;
  const E = DEFAULT_EFFECTS(); let any = false;
  const one = (v) => Array.isArray(v) ? v[0] : v;
  try {
    const ds = one(fx.dropShadow);
    if (ds) { any = true; Object.assign(E.dropShadow, { enabled: ds.enabled !== false, color: col(ds.color), opacity: Math.round((ds.opacity ?? 0.75) * 100), angle: ds.angle ?? 120, distance: unitVal(ds.distance, 5), size: unitVal(ds.size, 5), spread: unitVal(ds.choke, 0), blend: fromPsdBlend(ds.blendMode || 'multiply') }); }
    const st = one(fx.stroke);
    if (st) { any = true; Object.assign(E.stroke, { enabled: st.enabled !== false, color: col(st.color), opacity: Math.round((st.opacity ?? 1) * 100), size: unitVal(st.size, 3), position: st.position || 'outside' }); }
    const og = fx.outerGlow;
    if (og) { any = true; Object.assign(E.outerGlow, { enabled: og.enabled !== false, color: col(og.color), opacity: Math.round((og.opacity ?? 0.75) * 100), size: unitVal(og.size, 10), blend: fromPsdBlend(og.blendMode || 'screen') }); }
    const sf = one(fx.solidFill);
    if (sf) { any = true; Object.assign(E.colorOverlay, { enabled: sf.enabled !== false, color: col(sf.color), opacity: Math.round((sf.opacity ?? 1) * 100), blend: fromPsdBlend(sf.blendMode || 'normal') }); }
    const is = one(fx.innerShadow);
    if (is) { any = true; Object.assign(E.innerShadow, { enabled: is.enabled !== false, color: col(is.color), opacity: Math.round((is.opacity ?? 0.75) * 100), angle: is.angle ?? 120, distance: unitVal(is.distance, 5), size: unitVal(is.size, 5) }); }
  } catch (e) { console.warn(e); }
  return any ? E : null;
}

function readLayer(pl, doc, warnings) {
  const common = { name: pl.name || 'Layer', visible: !pl.hidden, opacity: pl.opacity ?? 1, fillOpacity: pl.fillOpacity ?? 1, blend: fromPsdBlend(pl.blendMode), clipped: !!pl.clipping, effects: readEffects(pl.effects) };
  let L;
  if (pl.children) {
    L = new Layer('group', { ...common, children: pl.children.map(c => readLayer(c, doc, warnings)).filter(Boolean), collapsed: !pl.opened });
    if (!pl.blendMode || pl.blendMode === 'pass through') L.blend = 'passThrough';
  } else if (pl.adjustment) {
    const a = readAdjustment(pl.adjustment);
    if (!a) {
      if (pl.adjustment.type === 'solid color' || pl.adjustment.type === 'solidColor') L = new Layer('fill', { ...common, data: { fillType: 'solid', color: col(pl.adjustment.color) } });
      else { warnings.add(`Unsupported adjustment "${pl.adjustment.type}" was skipped.`); return null; }
    } else L = new Layer('adjustment', { ...common, data: a });
  } else if (pl.text && pl.text.text != null && pl.text.style) {
    const s = pl.text.style || {};
    const tx = pl.text.transform ? [...pl.text.transform] : [1, 0, 0, 1, pl.left || 0, pl.top || 0];
    L = new Layer('text', {
      ...common, tx, data: {
        text: String(pl.text.text).replace(/\r/g, '\n'), font: s.font?.name || 'Arial', size: s.fontSize || 24, color: col(s.fillColor), bold: !!s.fauxBold, italic: !!s.fauxItalic,
        align: ({ center: 'center', right: 'right' })[pl.text.paragraphStyle?.justification] || 'left', tracking: s.tracking || 0, leading: s.autoLeading === false ? s.leading : 0,
      },
    });
    // keep PS's own raster for fidelity until the user edits the text
    if (pl.canvas) { L._psdRaster = { canvas: pl.canvas, x: pl.left || 0, y: pl.top || 0 }; }
  } else if (pl.vectorFill && pl.vectorMask && pl.vectorMask.paths?.length) {
    const vs = pl.vectorStroke || {};
    L = new Layer('shape', { ...common, tx: [1, 0, 0, 1, 0, 0], data: { shape: 'path', subpaths: fromPsdPaths(pl.vectorMask.paths), fill: vs.fillEnabled === false ? null : (pl.vectorFill.type === 'color' ? col(pl.vectorFill.color) : '#808080'), stroke: vs.strokeEnabled ? (vs.content?.type === 'color' ? col(vs.content.color) : '#000000') : null, strokeWidth: unitVal(vs.lineWidth, 1) } });
    if (pl.canvas) L._psdRaster = { canvas: pl.canvas, x: pl.left || 0, y: pl.top || 0 };
  } else {
    L = new Layer('pixel', { ...common });
    if (pl.canvas) { L.canvas = pl.canvas; L.x = pl.left || 0; L.y = pl.top || 0; }
    else { L.canvas = createCanvas(1, 1); }
    if (pl.placedLayer) L._placed = { ...pl.placedLayer };
  }
  if (pl.vectorMask && !pl.vectorFill && pl.vectorMask.paths?.length) L.vmask = { subpaths: fromPsdPaths(pl.vectorMask.paths), enabled: !pl.vectorMask.disable };
  if (pl.artboard && L.kind === 'group') { const r = pl.artboard.rect; L.artboard = { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top, bg: '#ffffff' }; L.blend = 'normal'; }
  if (pl.mask && pl.mask.canvas) {
    L.mask = { canvas: grayToAlphaMask(pl.mask.canvas), x: pl.mask.left || 0, y: pl.mask.top || 0, def: pl.mask.defaultColor ? 255 : 0, enabled: !pl.mask.disabled, linked: !pl.mask.positionRelativeToLayer };
  } else if (pl.mask && pl.mask.defaultColor === 0 && !pl.mask.canvas) {
    L.mask = { canvas: createCanvas(1, 1), x: 0, y: 0, def: 0, enabled: !pl.mask.disabled, linked: true };
  }
  return L;
}

export async function openPsd(bytes, name, path) {
  const _ = 0;
  const P = psd();
  const file = P.readPsd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { skipThumbnail: true, useImageData: false });
  const doc = new Document(file.width, file.height, { name, path });
  const warnings = new Set();
  if (file.colorMode != null && file.colorMode !== 3 && file.colorMode !== 1) warnings.add('This document is not RGB; it was converted to RGB.');
  if (file.bitsPerChannel && file.bitsPerChannel > 8) warnings.add(`${file.bitsPerChannel}-bit document was converted to 8 bits/channel.`);
  if (file.children && file.children.length) {
    doc.layers = file.children.map(c => readLayer(c, doc, warnings)).filter(Boolean);
  } else if (file.canvas) {
    const L = doc.newPixelLayer('Background'); ctx2d(L.canvas).drawImage(file.canvas, 0, 0); L.locks.background = true; L.locks.position = true; doc.layers = [L];
  }
  // Smart Objects: embedded files
  for (const L of doc.all()) {
    if (!L._placed) continue;
    const pli = L._placed; delete L._placed;
    const lf = (file.linkedFiles || []).find(f => f.id === (pli.id || pli.placed));
    if (!lf || !lf.data) continue;
    try {
      const nd = await openBytes(lf.data, lf.name || 'Embedded.psb');
      const W = nd.width, H = nd.height, t = pli.transform || [0, 0, W, 0, W, H, 0, H];
      const tx = [(t[2] - t[0]) / W, (t[3] - t[1]) / W, (t[6] - t[0]) / H, (t[7] - t[1]) / H, t[0], t[1]];
      const keep = { canvas: L.canvas, x: L.x, y: L.y };
      L.kind = 'smart'; L.smart = { doc: nd, cache: nd.render(true), ver: 1, name: (lf.name || L.name).replace(/\.[^.]+$/, '') }; L.tx = tx;
      nd.dirty = false;
      Object.assign(L, keep); L._vsig = JSON.stringify([L.tx, L.smart.ver, L.smartFilters, L.smartFiltersVisible, 0]);
    } catch (e) { console.warn('could not read embedded smart object', e); warnings.add('A Smart Object could not be read and was kept as pixels.'); }
  }
  for (const L of doc.all()) {
    if (L.isVector && !(L.kind === 'smart' && L._vsig)) {
      refreshVector(L, doc);
      if (L._psdRaster) { L.canvas = L._psdRaster.canvas; L.x = L._psdRaster.x; L.y = L._psdRaster.y; L._vsig = JSON.stringify([L.data, L.tx, 0]); delete L._psdRaster; }
    }
  }
  if (doc.layers.length === 1 && doc.layers[0].kind === 'pixel' && doc.layers[0].name === 'Background') { doc.layers[0].locks.background = true; doc.layers[0].locks.position = true; }
  const top = doc.layers[doc.layers.length - 1];
  doc.activeId = top ? top.id : null; doc.selectedIds = new Set(doc.activeId ? [doc.activeId] : []);
  if (file.imageResources?.resolutionInfo) doc.resolution = Math.round(file.imageResources.resolutionInfo.horizontalResolution || 72);
  doc.commit('Open', 'open'); doc.dirty = false;
  doc.importWarnings = [...warnings];
  return doc;
}

// ----- PSD write -----
function writeAdjustment(d) {
  const p = d.params;
  switch (d.type) {
    case 'brightnessContrast': return { type: 'brightness/contrast', brightness: p.brightness, contrast: p.contrast, useLegacy: !!p.legacy };
    case 'levels': { const ch = (c) => ({ shadowInput: c.inBlack, highlightInput: c.inWhite, midtoneInput: c.gamma, shadowOutput: c.outBlack, highlightOutput: c.outWhite }); return { type: 'levels', rgb: ch(p.channels.rgb), red: ch(p.channels.r), green: ch(p.channels.g), blue: ch(p.channels.b) }; }
    case 'curves': { const ch = (c) => c.map(([x, y]) => ({ input: x, output: y })); return { type: 'curves', rgb: ch(p.channels.rgb), red: ch(p.channels.r), green: ch(p.channels.g), blue: ch(p.channels.b) }; }
    case 'exposure': return { type: 'exposure', exposure: p.exposure, offset: p.offset, gamma: p.gamma };
    case 'vibrance': return { type: 'vibrance', vibrance: p.vibrance, saturation: p.saturation };
    case 'hueSaturation': return { type: 'hue/saturation', master: { hue: p.hue, saturation: p.saturation, lightness: p.lightness }, colorize: !!p.colorize };
    case 'colorBalance': { const tr = (a) => ({ cyanRed: a[0], magentaGreen: a[1], yellowBlue: a[2] }); return { type: 'color balance', shadows: tr(p.shadows), midtones: tr(p.midtones), highlights: tr(p.highlights), preserveLuminosity: p.preserveLuminosity }; }
    case 'blackWhite': return { type: 'black & white', reds: p.reds, yellows: p.yellows, greens: p.greens, cyans: p.cyans, blues: p.blues, magentas: p.magentas, useTint: p.tint };
    case 'photoFilter': return { type: 'photo filter', color: hexToRgb(p.color), density: p.density, preserveLuminosity: p.preserveLuminosity };
    case 'invert': return { type: 'invert' };
    case 'posterize': return { type: 'posterize', levels: p.levels };
    case 'threshold': return { type: 'threshold', level: p.level };
  }
  return null;
}

function writeLayer(L, doc, ctx = {}) {
  const out = { name: L.name, hidden: !L.visible, opacity: L.opacity, fillOpacity: L.fillOpacity, blendMode: toPsdBlend(L.blend === 'passThrough' ? 'passThrough' : L.blend), clipping: L.clipped };
  if (L.kind === 'group') {
    out.children = L.children.map(c => writeLayer(c, doc, ctx)).filter(Boolean);
    out.opened = !L.collapsed;
    if (L.blend === 'passThrough') out.blendMode = 'pass through';
  } else if (L.kind === 'adjustment') {
    const a = writeAdjustment(L.data);
    if (!a) return null; // unsupported in PSD writer; skip (warned in caller)
    out.adjustment = a;
  } else {
    const ct = doc.layerContent(L);
    if (ct.canvas) { out.canvas = ct.canvas; out.left = Math.round(ct.x); out.top = Math.round(ct.y); }
    if (L.kind === 'shape') {
      const s = L.data;
      const sp = transformPaths(clonePaths(s.shape === 'path' ? s.subpaths : shapeSub(s)), (q) => ({ x: L.tx[0] * q.x + L.tx[2] * q.y + L.tx[4], y: L.tx[1] * q.x + L.tx[3] * q.y + L.tx[5] }));
      out.vectorMask = { paths: toPsdPaths(sp) };
      out.vectorFill = { type: 'color', color: hexToRgb(s.fill || '#000000') };
      out.vectorStroke = { strokeEnabled: !!s.stroke, fillEnabled: !!s.fill, lineWidth: { units: 'Pixels', value: s.strokeWidth || 1 }, content: { type: 'color', color: hexToRgb(s.stroke || '#000000') }, lineAlignment: 'center', lineCapType: 'butt', lineJoinType: 'round', opacity: 1 };
    }
    if (L.kind === 'smart' && ctx.linked) {
      try {
        const id = (crypto.randomUUID ? crypto.randomUUID() : '20953ddb-9391-11ec-b4f1-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0'));
        const data = savePsdBytes(L.smart.doc);
        ctx.linked.push({ id, name: (L.smart.name || L.name) + '.psb', type: '8BPS', creator: '8BIM', data });
        const W = L.smart.cache.width, H = L.smart.cache.height, m = L.tx;
        const P = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
        out.placedLayer = { id, placed: id, type: 'raster', transform: [...P(0, 0), ...P(W, 0), ...P(W, H), ...P(0, H)], width: W, height: H };
      } catch (e) { console.warn('smart object embed failed', e); }
    }
    if (L.kind === 'text') {
      const t = L.data;
      out.text = { text: t.text, transform: [...L.tx], style: { font: { name: t.font }, fontSize: t.size, fillColor: hexToRgb(t.color), fauxBold: !!t.bold, fauxItalic: !!t.italic, tracking: t.tracking || 0 }, paragraphStyle: { justification: t.align || 'left' } };
    }
  }
  if (L.vmask && L.kind !== 'shape') out.vectorMask = { paths: toPsdPaths(L.vmask.subpaths), disable: L.vmask.enabled === false };
  if (L.artboard) out.artboard = { rect: { left: L.artboard.x, top: L.artboard.y, right: L.artboard.x + L.artboard.w, bottom: L.artboard.y + L.artboard.h } };
  if (L.mask) {
    out.mask = { canvas: alphaToGrayMask(L.mask.canvas), left: L.mask.x, top: L.mask.y, defaultColor: L.mask.def, disabled: L.mask.enabled === false };
  }
  const fx = L.effects;
  if (fx) {
    const e = {};
    const px = (v) => ({ units: 'Pixels', value: v });
    if (fx.dropShadow.enabled) e.dropShadow = [{ enabled: true, color: hexToRgb(fx.dropShadow.color), opacity: fx.dropShadow.opacity / 100, angle: fx.dropShadow.angle, distance: px(fx.dropShadow.distance), size: px(fx.dropShadow.size), blendMode: toPsdBlend(fx.dropShadow.blend) }];
    if (fx.stroke.enabled) e.stroke = [{ enabled: true, color: hexToRgb(fx.stroke.color), opacity: fx.stroke.opacity / 100, size: px(fx.stroke.size), position: fx.stroke.position, fillType: 'color', blendMode: 'normal' }];
    if (fx.outerGlow.enabled) e.outerGlow = { enabled: true, color: hexToRgb(fx.outerGlow.color), opacity: fx.outerGlow.opacity / 100, size: px(fx.outerGlow.size), blendMode: toPsdBlend(fx.outerGlow.blend) };
    if (fx.colorOverlay.enabled) e.solidFill = [{ enabled: true, color: hexToRgb(fx.colorOverlay.color), opacity: fx.colorOverlay.opacity / 100, blendMode: toPsdBlend(fx.colorOverlay.blend) }];
    if (Object.keys(e).length) out.effects = e;
  }
  return out;
}

export function savePsdBytes(doc) {
  const P = psd();
  doc._noProof = true; let composite; try { composite = createCanvas(doc.width, doc.height); ctx2d(composite).drawImage(doc.render(true), 0, 0); } finally { doc._noProof = false; doc.invalidate(); }
  const wctx = { linked: [] };
  const file = {
    width: doc.width, height: doc.height,
    canvas: composite,
    children: doc.layers.map(L => writeLayer(L, doc, wctx)).filter(Boolean),
    imageResources: { resolutionInfo: { horizontalResolution: doc.resolution, horizontalResolutionUnit: 'PPI', widthUnit: 'Inches', verticalResolution: doc.resolution, verticalResolutionUnit: 'PPI', heightUnit: 'Inches' } },
  };
  if (wctx.linked.length) file.linkedFiles = wctx.linked;
  let buf;
  try { buf = P.writePsd(file, { invalidateTextLayers: true, generateThumbnail: true, trimImageData: true }); }
  catch (e) { console.warn('PSD write with smart objects failed, retrying flattened smart objects', e); delete file.linkedFiles; const strip = (ls) => ls.forEach(l => { delete l.placedLayer; if (l.children) strip(l.children); }); strip(file.children); buf = P.writePsd(file, { invalidateTextLayers: true, generateThumbnail: true, trimImageData: true }); }
  return new Uint8Array(buf);
}

export async function exportBytes(doc, format = 'png', quality = 0.92, opts = {}) {
  doc._noProof = true; let c; try { c = doc.render(true); } finally { doc._noProof = false; doc.invalidate(); }
  if (opts.width && opts.height && (opts.width !== c.width || opts.height !== c.height)) {
    const s = createCanvas(opts.width, opts.height), g = ctx2d(s); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, opts.width, opts.height); c = s;
  }
  if (format === 'jpeg' || format === 'jpg') {
    const s = createCanvas(c.width, c.height), g = ctx2d(s); g.fillStyle = opts.matte || '#ffffff'; g.fillRect(0, 0, s.width, s.height); g.drawImage(c, 0, 0); c = s;
    return canvasToBytes(c, 'image/jpeg', quality);
  }
  if (format === 'webp') return canvasToBytes(c, 'image/webp', quality);
  return canvasToBytes(c, 'image/png');
}
