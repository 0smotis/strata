// Neural Filters workspace (Filter › Neural Filters…): large preview + filter list grouped like Photoshop,
// per-filter settings, stacked filters, before/after, Output options.
import { el, $$, clamp, createCanvas, ctx2d } from '../util.js';
import { modal, selectEl, checkEl, toast } from './common.js';
import { ICONS } from '../icons.js';
import * as N from '../ai/neural.js';

const svg = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const GLYPH = {
  skinSmoothing: svg('<circle cx="12" cy="11" r="6.5"/><path d="M9.5 10h.01M14.5 10h.01M9.5 13.5c1.4 1.2 3.6 1.2 5 0"/><path d="M5 20c1.6-2 4.2-3 7-3s5.4 1 7 3"/>'),
  styleTransfer: svg('<path d="M4 20c3 0 5-2 5-4.5S7.5 12 9.5 11L19 3.5l1.5 1.5L13 14.5c-1 2-3.5 1.5-4.5 1"/><path d="M4 20c0-2 .5-3.5 2-4.5"/>'),
  colorTransfer: svg('<circle cx="8" cy="9" r="4"/><circle cx="16" cy="15" r="4"/><path d="M12 9h6l-2-2M12 15H6l2 2"/>'),
  colorize: svg('<path d="M12 3.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z"/><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5"/>'),
  harmonization: svg('<circle cx="9" cy="12" r="5.5"/><circle cx="15" cy="12" r="5.5"/>'),
  superZoom: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M10.5 8v5M8 10.5h5"/>'),
  depthBlur: svg('<circle cx="12" cy="12" r="8"/><path d="M12 4l3.5 6M20 12l-6.5 1M16 18.5L12 13M8 18.5l3-6M4 12h7M8 5.5l3 5.5"/>'),
  jpegArtifacts: svg('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16M12 4v16"/><path d="M15 15l3 3" stroke-dasharray="1 2"/>'),
  photoRestoration: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M6.5 16l4-4.5 3 3 2-2 2.5 3.5"/><path d="M15.5 8.5l.6 1.2 1.2.6-1.2.6-.6 1.2-.6-1.2-1.2-.6 1.2-.6z"/>'),
};
const TILE = {
  skinSmoothing: 'linear-gradient(135deg,#c9826b,#e8b293)', styleTransfer: 'linear-gradient(135deg,#7b3fa0,#e0628a)', colorTransfer: 'linear-gradient(135deg,#1f8f9c,#e69a4a)',
  colorize: 'linear-gradient(135deg,#3b7d3a,#d6b33c)', harmonization: 'linear-gradient(135deg,#4f5fd1,#9c5dd6)', superZoom: 'linear-gradient(135deg,#2366c9,#41a7e8)',
  depthBlur: 'linear-gradient(135deg,#2b4057,#7a98b3)', jpegArtifacts: 'linear-gradient(135deg,#5b5b5b,#8e8e8e)', photoRestoration: 'linear-gradient(135deg,#7a5a32,#c39c62)',
};
const CLOUD = svg('<path d="M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.5 4.3 4.3 0 0 0 7 18z"/><path d="M12 10.5v5M10 13.5l2 2 2-2"/>');
const WARN = svg('<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>');
const OKI = svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const INFO = svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>');
const COMPARE = svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M12 3v18"/><path d="M12 5h7a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 19h-7z" fill="currentColor" stroke="none" opacity=".45"/>');
const FIT = svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
const ONE = `<svg viewBox="0 0 24 24"><text x="12" y="17" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" font-family="Segoe UI, system-ui, sans-serif">1:1</text></svg>`;
const MAX_OUT_SIDE = 16384, MAX_OUT_AREA = 100e6;
const SWATCHES = ['#c8423b', '#e07b39', '#e8c547', '#8bb34a', '#3f8f4f', '#2e9aa3', '#3d6fc4', '#6a4bb6', '#b9568e', '#d9a07a', '#a9744f', '#6b4a35', '#7e8f9e', '#3a4a5c'];

const fnv = (img) => { // cheap content hash for caches
  let h = 2166136261 ^ img.width ^ (img.height << 16); const d = img.data, step = Math.max(1, (d.length / 4096) | 0) * 4 + 1;
  for (let i = 0; i < d.length; i += step) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + img.width + 'x' + img.height;
};
const asImg = (id) => ({ data: id.data, width: id.width, height: id.height });

/**
 * @param {HTMLCanvasElement} srcCanvas the active layer's pixels (document size)
 * @param {{layers?: {id, name, canvas}[]}} opts other layers, used as Harmonization / Color Transfer references
 * @returns {Promise<null | {imageData: ImageData, output: 'current'|'newLayer'|'newLayerMasked'|'newDocument', width, height, mask?: Uint8Array}>}
 */
export async function neuralFiltersDialog(srcCanvas, { layers = [] } = {}) {
  const W = srcCanvas.width, H = srcCanvas.height;
  const srcImg = asImg(ctx2d(srcCanvas).getImageData(0, 0, W, H));
  const DW = Math.max(980, Math.min(1560, innerWidth - 64)), DH = Math.max(600, Math.min(960, innerHeight - 64));
  const PANEL = 590, TOOLS = 40, stageW = DW - PANEL - TOOLS - 2, stageH = DH - 37 - 50;
  const fs = Math.min(1, (stageW - 48) / W, (stageH - 48) / H);
  const pw = Math.max(1, Math.round(W * fs)), ph = Math.max(1, Math.round(H * fs));
  const prevCanvas = createCanvas(pw, ph); { const g = ctx2d(prevCanvas); g.imageSmoothingQuality = 'high'; g.drawImage(srcCanvas, 0, 0, pw, ph); }
  const previewImg = asImg(ctx2d(prevCanvas).getImageData(0, 0, pw, ph));
  const refLayers = layers.filter(l => l && l.canvas && l.canvas !== srcCanvas);

  const IDS = N.STACK_ORDER;
  const st = { enabled: new Set(), params: {}, selected: 'skinSmoothing', showOriginal: false, view: 'fit', center: { x: W / 2, y: H / 2 }, output: 'newLayer', models: {}, closedGroups: new Set(), selPoint: -1, fileRef: null };
  for (const id of IDS) st.params[id] = N.defaultNeuralParams(id);
  st.params.harmonization.ref = refLayers[0] ? String(refLayers[0].id) : '';
  st.params.colorTransfer.ref = 'preset:goldenHour';
  let closed = false, finalRunning = false;

  // ---------- DOM ----------
  const view = el('canvas', { class: 'nf-canvas' });
  const marks = el('div', { class: 'nf-marks' });
  const badge = el('div', { class: 'nf-badge' });
  const zoomLbl = el('div', { class: 'nf-zoomlbl' });
  const busy = el('div', { class: 'nf-busy hidden' }, el('div', { class: 'nf-spin' }), el('span', { class: 'lbl' }), el('div', { class: 'bar' }, el('span')));
  const navC = el('canvas'); const navVp = el('div', { class: 'vp' }); const nav = el('div', { class: 'nf-nav hidden', title: 'Navigator — click to move the 100% view' }, navC, navVp);
  const stage = el('div', { class: 'nf-stage', style: { width: stageW + 'px', height: stageH + 'px' } }, view, marks, badge, zoomLbl, nav, busy);
  const tb = (icon, title, fn) => el('button', { class: 'ibtn', title, html: icon, onclick: fn });
  const bFit = tb(FIT, 'Fit on screen (Ctrl+0)', () => setView('fit')), b100 = tb(ONE, '100% (Ctrl+1)', () => setView('100'));
  const bCmp = tb(COMPARE, 'Show original (\\)', () => { st.showOriginal = !st.showOriginal; syncTools(); schedule(0); });
  const tools = el('div', { class: 'nf-tools' }, tb(ICONS.hand, 'Hand — drag the preview (at 100%)', () => setView('100')), tb(ICONS.zoom, 'Zoom — toggle Fit / 100%', () => setView(st.view === 'fit' ? '100' : 'fit')), el('div', { class: 'sep' }), bFit, b100, el('div', { class: 'sep' }), bCmp);
  const list = el('div', { class: 'nf-list' });
  const set = el('div', { class: 'nf-set' });
  const panel = el('div', { class: 'nf-panel' },
    el('div', { class: 'nf-phead' }, el('span', { class: 'ttl' }, 'Neural Filters'), el('div', { class: 'tabs' }, el('span', { class: 'on' }, 'All filters'))),
    el('div', { class: 'nf-cols' }, list, set));
  const root = el('div', { class: 'nf', style: { width: DW + 'px', height: (DH - 87) + 'px' } }, tools, stage, panel);
  const outSel = selectEl([['current', 'Current Layer'], ['newLayer', 'New Layer'], ['newLayerMasked', 'New Layer Masked'], ['newDocument', 'New Document']], st.output, (v) => { st.output = v; });
  const outNote = el('span', { class: 'nf-foot-note' });
  const cmpChk = checkEl('Show original', false, (v) => { st.showOriginal = v; syncTools(); schedule(0); });

  // ---------- helpers ----------
  const P = (id) => st.params[id];
  const isOn = (id) => st.enabled.has(id);
  const stackList = () => IDS.filter(id => id !== 'superZoom' && isOn(id)).map(id => ({ id, params: P(id) }));
  const szScale = () => (isOn('superZoom') ? (Number(P('superZoom').scale) === 4 ? 4 : 2) : 1);
  let gen = 0;
  const schedule = (() => { let t = 0; return (ms = 70) => { clearTimeout(t); t = setTimeout(render, ms); }; })();

  function setModel(key, state, msg = '', frac = null) {
    st.models[key] = { state, msg, frac };
    if (state === 'loading' || state === 'running') showBusy(msg || 'Loading model…', frac);
    refreshListStatus();
    if (state === 'error' || state === 'ready') renderSettings();
  }
  let busyT = 0;
  function showBusy(label, frac) {
    if (label == null) { clearTimeout(busyT); busyT = 0; busy.classList.add('hidden'); return; }
    busy.querySelector('.lbl').textContent = label;
    const bar = busy.querySelector('.bar'); bar.classList.toggle('indet', frac == null); bar.firstChild.style.width = (frac == null ? 0 : clamp(frac, 0, 1) * 100) + '%';
    if (busy.classList.contains('hidden') && !busyT) busyT = setTimeout(() => { busyT = 0; busy.classList.remove('hidden'); }, 140);
  }

  // ---------- models ----------
  let depthMap = null, depthPromise = null;
  function ensureDepth() {
    if (depthMap) return Promise.resolve(depthMap);
    if (st.models.depth?.state === 'error') return Promise.resolve(null);
    if (!depthPromise) depthPromise = (async () => {
      setModel('depth', 'loading', 'Loading Depth model…');
      try {
        const est = await N.loadDepthEstimator((f, l) => setModel('depth', 'loading', l, f));
        setModel('depth', 'running', 'Estimating depth…');
        const s = Math.min(1, 640 / Math.max(W, H)), dw = Math.max(1, Math.round(W * s)), dh = Math.max(1, Math.round(H * s));
        const c = createCanvas(dw, dh), g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(srcCanvas, 0, 0, dw, dh);
        depthMap = await est(asImg(g.getImageData(0, 0, dw, dh)));
        setModel('depth', 'ready');
        if (P('depthBlur').focalPoint) focalFromPoint();
        return depthMap;
      } catch (e) { console.warn('Depth model unavailable:', e.cause || e); setModel('depth', 'error', e.message); return null; }
      finally { depthPromise = null; }
    })();
    return depthPromise;
  }
  function depthAt(x, y) { // full-res coords -> 0..1 (1 = near), 5×5 average
    const dm = depthMap; if (!dm) return null;
    const cx = Math.round(x / W * dm.width), cy = Math.round(y / H * dm.height); let s = 0, c = 0;
    for (let yy = cy - 2; yy <= cy + 2; yy++) for (let xx = cx - 2; xx <= cx + 2; xx++) if (xx >= 0 && yy >= 0 && xx < dm.width && yy < dm.height) { s += dm.data[yy * dm.width + xx]; c++; }
    return c ? s / c : null;
  }
  const depthCache = new Map();
  function depthFor(region, img) {
    if (!depthMap) return null;
    const w = img.width, h = img.height, key = [region.x, region.y, region.w, region.h, w, h].map(Math.round).join(',');
    if (depthCache.has(key)) return depthCache.get(key);
    const sx = depthMap.width / W, sy = depthMap.height / H;
    const D = N.samplePlane(depthMap.data, depthMap.width, depthMap.height, region.x * sx, region.y * sy, region.w * sx, region.h * sy, w, h);
    const n = w * h, Y = new Float32Array(n), d = img.data;
    for (let i = 0; i < n; i++) Y[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    const q = N.guidedFilter(Y, D, w, h, Math.max(2, Math.round(Math.max(w, h) / 140)), 2e-3); // snap depth edges to image edges
    for (let i = 0; i < n; i++) q[i] = clamp(q[i], 0, 1);
    if (depthCache.size > 6) depthCache.clear();
    depthCache.set(key, q); return q;
  }
  const upscalers = {};
  async function getUpscaler(kind) {
    if (upscalers[kind]) return upscalers[kind];
    if (st.models[kind]?.state === 'error') return null;
    setModel(kind, 'loading', `Loading ${N.NEURAL_MODELS[kind].label} model…`);
    try { const u = await N.loadUpscaler(kind, (f, l) => setModel(kind, 'loading', l, f)); setModel(kind, 'ready'); return (upscalers[kind] = u); }
    catch (e) { console.warn(N.NEURAL_MODELS[kind].label + ' model unavailable:', e.cause || e); setModel(kind, 'error', e.message); return null; }
  }
  const aiCache = new Map();
  const cacheGet = (k) => aiCache.get(k), cachePut = (k, v) => { if (aiCache.size > 8) aiCache.delete(aiCache.keys().next().value); aiCache.set(k, v); };
  function aiJpegFn(abort, onP) {
    return async (img) => {
      if (P('jpegArtifacts').useAI === false) return null;
      const key = 'jpeg:' + fnv(img); if (cacheGet(key)) return cacheGet(key);
      const u = await getUpscaler('jpeg'); if (!u) return null;
      const out = await N.tiledUpscale(img, 4, u, { tile: 128, pad: 16, outScale: 1, abort, onProgress: (f) => (onP || showBusy)('Removing JPEG artifacts (AI)…', f) });
      cachePut(key, out); return out;
    };
  }

  // ---------- references ----------
  const refCache = new Map();
  function canvasStats(key, c) {
    if (refCache.has(key)) return refCache.get(key);
    const s = Math.min(1, 384 / Math.max(c.width, c.height)), w = Math.max(1, Math.round(c.width * s)), h = Math.max(1, Math.round(c.height * s));
    const t = createCanvas(w, h), g = ctx2d(t); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, h);
    const r = N.labStats(asImg(g.getImageData(0, 0, w, h))); refCache.set(key, r); return r;
  }
  function refStats(id, p) {
    const ref = String(p.ref || '');
    if (id === 'harmonization') { const L = refLayers.find(l => String(l.id) === ref); return L ? canvasStats('layer:' + L.id, L.canvas) : null; }
    if (ref.startsWith('preset:')) { const k = ref.slice(7); if (!refCache.has(ref) && N.COLOR_PRESETS[k]) refCache.set(ref, N.paletteStats(N.COLOR_PRESETS[k].colors)); return refCache.get(ref) || null; }
    if (ref.startsWith('layer:')) { const L = refLayers.find(l => 'layer:' + l.id === ref); return L ? canvasStats(ref, L.canvas) : null; }
    if (ref === 'file' && st.fileRef) return canvasStats('file:' + st.fileRef.stamp, st.fileRef.canvas);
    return null;
  }
  const makeCtx = (o) => ({ fullW: W, fullH: H, seed: 7, refStats, ...o });

  // ---------- render ----------
  let geom = { kind: 'fit', s: fs, ox: 0, oy: 0, w: pw, h: ph };
  let fitStatsKey = '', fitStats = null;
  const paramsKey = () => JSON.stringify(stackList()) + '|' + (depthMap ? 'd' : '') + (st.fileRef?.stamp || '');
  function viewRect() { // 100%: visible region (full-res) + margin for filter context
    const s = szScale(), cw = Math.min(W, Math.ceil(stageW / s)), ch = Math.min(H, Math.ceil(stageH / s));
    st.center.x = clamp(st.center.x, cw / 2, W - cw / 2); st.center.y = clamp(st.center.y, ch / 2, H - ch / 2);
    const x = Math.round(st.center.x - cw / 2), y = Math.round(st.center.y - ch / 2);
    const m = 40, mx0 = Math.max(0, x - m), my0 = Math.max(0, y - m), mx1 = Math.min(W, x + cw + m), my1 = Math.min(H, y + ch + m);
    return { x, y, w: cw, h: ch, s, pad: { x: mx0, y: my0, w: mx1 - mx0, h: my1 - my0 } };
  }
  async function render() {
    if (closed || finalRunning) return;
    const my = ++gen, stale = () => my !== gen || closed;
    stage.dataset.state = 'busy';
    const stack = stackList(), sz = isOn('superZoom');
    try {
      if (isOn('depthBlur')) await ensureDepth();
      if (stale()) return;
      let out;
      if (st.view === 'fit') {
        geom = { kind: 'fit', s: fs, x: 0, y: 0, w: pw, h: ph };
        if (st.showOriginal || !stack.length) out = previewImg;
        else {
          showBusy('Rendering preview…', null);
          const ctx = makeCtx({ scale: fs, region: { x: 0, y: 0, w: W, h: H }, abort: stale, depth: (img) => depthFor({ x: 0, y: 0, w: W, h: H }, img) });
          const r = await N.runStack(previewImg, stack, ctx, null, () => { });
          fitStats = r.stats; fitStatsKey = paramsKey();
          out = r.img;
        }
      } else {
        const vr = viewRect(); geom = { kind: '100', s: vr.s, x: vr.x, y: vr.y, w: vr.w * vr.s, h: vr.h * vr.s };
        const crop = N.cropImg(srcImg, vr.pad.x, vr.pad.y, vr.pad.w, vr.pad.h);
        let res = crop;
        if (!st.showOriginal && stack.length) {
          showBusy('Rendering preview…', null);
          if (fitStatsKey !== paramsKey()) { // global statistics come from the whole frame (proxy run)
            const fctx = makeCtx({ scale: fs, region: { x: 0, y: 0, w: W, h: H }, abort: stale, depth: (img) => depthFor({ x: 0, y: 0, w: W, h: H }, img) });
            const r = await N.runStack(previewImg, stack, fctx, null, () => { }); fitStats = r.stats; fitStatsKey = paramsKey();
          }
          const ctx = makeCtx({ scale: 1, region: vr.pad, abort: stale, depth: (img) => depthFor(vr.pad, img), aiJpeg: aiJpegFn(stale) });
          res = (await N.runStack(crop, stack, ctx, fitStats, () => { })).img;
        }
        if (stale()) return;
        if (sz && !st.showOriginal) res = await superZoomPreview(res, stale);
        else if (sz) res = N.resizeBicubic(res, res.width * vr.s, res.height * vr.s);
        if (stale()) return;
        const s = vr.s; out = N.cropImg(res, (vr.x - vr.pad.x) * s, (vr.y - vr.pad.y) * s, vr.w * s, vr.h * s);
      }
      if (stale()) return;
      draw(out);
    } catch (e) {
      if (!e.cancelled && !stale()) { console.error(e); toast('Neural Filters: ' + (e.message || e), 'err', 5000); }
    } finally { if (my === gen) { showBusy(null); stage.dataset.state = 'idle'; } }
  }
  async function superZoomPreview(img, stale) {
    const p = P('superZoom'), plan = N.superZoomPlan(p);
    const key = 'sz:' + plan.model + ':' + plan.scale + ':' + (p.fallback ? 'f' : 'ai') + ':' + fnv(img);
    let up = cacheGet(key);
    if (!up) {
      const u = p.fallback ? null : await getUpscaler(plan.model);
      if (stale()) return img;
      if (!u && !p.fallback) return N.resizeBicubic(img, img.width * plan.scale, img.height * plan.scale); // banner explains
      up = await N.runSuperZoom(img, { ...p, enhance: false, noise: 0, sharpen: 0 }, u, { abort: stale, onProgress: (f) => showBusy(`Super Zoom ×${plan.scale}…`, f) });
      cachePut(key, up);
    }
    return N.superZoomPost(up, p);
  }
  function draw(out) {
    view.width = out.width; view.height = out.height;
    ctx2d(view).putImageData(new ImageData(out.data, out.width, out.height), 0, 0);
    const l = Math.round((stageW - out.width) / 2), t = Math.round((stageH - out.height) / 2);
    Object.assign(view.style, { left: l + 'px', top: t + 'px', width: out.width + 'px', height: out.height + 'px' });
    Object.assign(marks.style, { left: l + 'px', top: t + 'px', width: out.width + 'px', height: out.height + 'px' });
    geom.left = l; geom.top = t;
    drawMarks(); drawBadges(); drawNav();
  }
  const fullToView = (x, y) => geom.kind === 'fit' ? [x * fs, y * fs] : [(x - geom.x) * geom.s, (y - geom.y) * geom.s];
  const viewToFull = (px, py) => geom.kind === 'fit' ? [px / fs, py / fs] : [geom.x + px / geom.s, geom.y + py / geom.s];
  function drawMarks() {
    marks.textContent = '';
    if (st.showOriginal) return;
    if (st.selected === 'depthBlur' && isOn('depthBlur') && P('depthBlur').focalPoint) {
      const fp = P('depthBlur').focalPoint, [x, y] = fullToView(fp.x * W, fp.y * H);
      marks.append(el('div', { class: 'nf-focal', style: { left: x + 'px', top: y + 'px' } }, el('span')));
    }
    if (st.selected === 'colorize') P('colorize').points.forEach((q, i) => {
      const [x, y] = fullToView(q.x * W, q.y * H);
      const m = el('div', { class: 'nf-mark' + (i === st.selPoint ? ' sel' : ''), title: 'Drag to move · Alt+click or right-click to remove', style: { left: x + 'px', top: y + 'px', background: q.color } });
      m.dataset.i = i; marks.append(m);
    });
  }
  function drawBadges() {
    badge.textContent = '';
    if (st.showOriginal) badge.append(el('span', { class: 'orig' }, 'Original'));
    else { const on = IDS.filter(isOn); if (on.length) badge.append(el('span', {}, on.map(id => N.NEURAL_FILTERS[id].name).join('  ›  '))); }
    if (isOn('superZoom')) { const s = szScale(); badge.append(el('span', {}, `Output ${W * s} × ${H * s} px`)); if (st.view === 'fit' && !st.showOriginal) badge.append(el('span', {}, 'Switch to 100% to preview Super Zoom detail')); }
    zoomLbl.textContent = st.view === 'fit' ? `Fit · ${Math.round(fs * 100)}%` : `${100 * szScale()}%`;
  }
  function drawNav() {
    nav.classList.toggle('hidden', st.view !== '100');
    if (st.view !== '100') return;
    const s = Math.min(150 / W, 110 / H), nw = Math.max(1, Math.round(W * s)), nh = Math.max(1, Math.round(H * s));
    if (navC.width !== nw || navC.height !== nh) { navC.width = nw; navC.height = nh; const g = ctx2d(navC); g.imageSmoothingQuality = 'high'; g.drawImage(prevCanvas, 0, 0, nw, nh); }
    const vr = viewRect(); Object.assign(navVp.style, { left: vr.x * s + 'px', top: vr.y * s + 'px', width: Math.max(4, vr.w * s) + 'px', height: Math.max(4, vr.h * s) + 'px' });
  }
  nav.addEventListener('pointerdown', (e) => {
    e.stopPropagation(); nav.setPointerCapture(e.pointerId);
    const mv = (ev) => { const r = navC.getBoundingClientRect(); st.center.x = (ev.clientX - r.left) / r.width * W; st.center.y = (ev.clientY - r.top) / r.height * H; drawNav(); schedule(40); };
    mv(e); nav.onpointermove = mv; nav.onpointerup = () => { nav.onpointermove = null; };
  });
  function setView(v) { st.view = v; syncTools(); schedule(0); }
  function syncTools() {
    bFit.classList.toggle('on', st.view === 'fit'); b100.classList.toggle('on', st.view === '100'); bCmp.classList.toggle('on', st.showOriginal);
    cmpChk.input.checked = st.showOriginal;
    stage.classList.toggle('pan', st.view === '100');
    stage.classList.toggle('pick', (st.selected === 'depthBlur' && isOn('depthBlur')) || st.selected === 'colorize');
  }

  // ---------- stage interaction: click = focal point / colorize point, drag = pan, drag marker = move ----------
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
  stage.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || e.target.closest('.nf-nav')) return;
    const markEl = e.target.closest('.nf-mark');
    const pts = P('colorize').points;
    if (markEl) {
      const i = Number(markEl.dataset.i);
      if (e.altKey || e.button === 2) { pts.splice(i, 1); st.selPoint = -1; renderSettings(); schedule(); drawMarks(); return; }
      st.selPoint = i; stage.setPointerCapture(e.pointerId);
      const r = view.getBoundingClientRect();
      stage.onpointermove = (ev) => { const [fx, fy] = viewToFull(ev.clientX - r.left, ev.clientY - r.top); pts[i].x = clamp(fx / W, 0, 1); pts[i].y = clamp(fy / H, 0, 1); drawMarks(); schedule(120); };
      stage.onpointerup = () => { stage.onpointermove = stage.onpointerup = null; renderSettings(); };
      drawMarks(); return;
    }
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY, c0 = { ...st.center }; let moved = false;
    stage.setPointerCapture(e.pointerId);
    stage.onpointermove = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) { moved = true; if (st.view === '100') stage.classList.add('panning'); }
      if (moved && st.view === '100') { st.center.x = c0.x - (ev.clientX - x0) / geom.s; st.center.y = c0.y - (ev.clientY - y0) / geom.s; drawNav(); view.style.transform = `translate(${ev.clientX - x0}px, ${ev.clientY - y0}px)`; schedule(90); }
    };
    stage.onpointerup = (ev) => {
      stage.onpointermove = stage.onpointerup = null; stage.classList.remove('panning');
      if (moved) { setTimeout(() => { view.style.transform = ''; }, 0); schedule(0); return; }
      const r = view.getBoundingClientRect(); if (ev.clientX < r.left || ev.clientY < r.top || ev.clientX > r.right || ev.clientY > r.bottom) return;
      const [fx, fy] = viewToFull(ev.clientX - r.left, ev.clientY - r.top);
      if (st.selected === 'depthBlur') { enable('depthBlur', true); P('depthBlur').focalPoint = { x: clamp(fx / W, 0, 1), y: clamp(fy / H, 0, 1) }; focalFromPoint(); renderSettings(); schedule(0); }
      else if (st.selected === 'colorize') { enable('colorize', true); pts.push({ x: clamp(fx / W, 0, 1), y: clamp(fy / H, 0, 1), color: P('colorize').color }); st.selPoint = pts.length - 1; renderSettings(); schedule(0); }
    };
  });
  function focalFromPoint() {
    const fp = P('depthBlur').focalPoint; if (!fp) return;
    const d = depthAt(fp.x * W, fp.y * H); if (d == null) return;
    P('depthBlur').focalDistance = Math.round((1 - d) * 100);
    const s = set.querySelector('[data-key="focalDistance"]'); if (s && s.setVal) s.setVal(P('depthBlur').focalDistance);
  }

  // ---------- filter list ----------
  const switches = {};
  function enable(id, on) {
    if (on) st.enabled.add(id); else st.enabled.delete(id);
    if (switches[id]) switches[id].forEach(s => s.classList.toggle('on', on));
    if (id === 'superZoom') syncOutput();
    if (on && id === 'superZoom' && st.view === 'fit') st.view = '100';
    if (on) N.NEURAL_FILTERS[id].model && prefetch(id);
    set.classList.toggle('off', !isOn(st.selected));
    syncTools(); refreshListStatus();
  }
  function prefetch(id) { if (id === 'depthBlur') ensureDepth().then(() => schedule(0)); }
  function swEl(id) {
    const s = el('div', { class: 'nf-sw' + (isOn(id) ? ' on' : ''), role: 'switch', title: 'Turn filter on/off' });
    s.addEventListener('click', (e) => { e.stopPropagation(); enable(id, !isOn(id)); if (st.selected !== id) select(id); schedule(0); });
    (switches[id] ||= []).push(s); return s;
  }
  function modelKeyFor(id) {
    if (id === 'depthBlur') return 'depth';
    if (id === 'jpegArtifacts') return 'jpeg';
    if (id === 'superZoom') return N.superZoomPlan(P('superZoom')).model;
    return null;
  }
  const itemStatus = {};
  function buildList() {
    list.textContent = '';
    for (const g of N.NEURAL_GROUPS) {
      const ids = IDS.filter(id => N.NEURAL_FILTERS[id].group === g);
      const head = el('div', { class: 'nf-grp' + (st.closedGroups.has(g) ? ' closed' : ''), html: ICONS.chevronDown }, g);
      head.addEventListener('click', () => { st.closedGroups.has(g) ? st.closedGroups.delete(g) : st.closedGroups.add(g); buildList(); });
      list.append(head);
      if (st.closedGroups.has(g)) continue;
      for (const id of ids) {
        const F = N.NEURAL_FILTERS[id];
        const sub = F.model ? (F.optionalModel ? 'AI model optional' : 'AI model') : (id === 'colorize' ? 'Guided · no AI model' : 'No download needed');
        const stt = el('span', { class: 'st' }); itemStatus[id] = stt;
        const it = el('div', { class: 'nf-item' + (st.selected === id ? ' sel' : ''), 'data-id': id },
          el('div', { class: 'thumb', style: { background: TILE[id] }, html: GLYPH[id] }),
          el('div', { class: 'nm' }, F.name, el('small', {}, sub)), stt, swEl(id));
        it.addEventListener('click', () => select(id));
        list.append(it);
      }
    }
    refreshListStatus();
  }
  function refreshListStatus() {
    for (const id of IDS) {
      const s = itemStatus[id]; if (!s) continue;
      const k = modelKeyFor(id), m = k && st.models[k];
      if (!k) { s.innerHTML = ''; s.className = 'st'; s.title = ''; continue; }
      if (m?.state === 'error') { s.innerHTML = WARN; s.className = 'st err'; s.title = m.msg; }
      else if (m?.state === 'ready') { s.innerHTML = OKI; s.className = 'st ok'; s.title = 'Model loaded'; }
      else { s.innerHTML = CLOUD; s.className = 'st'; s.title = 'Model downloads on first use (' + N.NEURAL_MODELS[k].size + ')'; }
    }
  }
  function select(id) {
    st.selected = id; st.selPoint = -1;
    $$('.nf-item', list).forEach(n => n.classList.toggle('sel', n.dataset.id === id));
    renderSettings(); syncTools(); drawMarks();
  }

  // ---------- settings ----------
  function slider(id, spec) {
    const p = P(id), bi = spec.min < 0, cls = { cyanRed: 'cr', magentaGreen: 'mg', yellowBlue: 'yb' }[spec.key] || '';
    const num = el('input', { type: 'number', value: p[spec.key], min: spec.min, max: spec.max, step: 1 });
    const rng = el('input', { type: 'range', value: p[spec.key], min: spec.min, max: spec.max, step: 1 });
    const wrap = el('div', { class: 'nf-sl ctl' + (bi ? ' bi' : '') + (cls ? ' ' + cls : ''), 'data-key': spec.key },
      el('div', { class: 'top' }, el('span', { class: 'l' }, spec.label), spec.right ? el('span', { class: 'r' }, spec.right) : null, num), rng);
    const setv = (v, live) => { v = clamp(Math.round(Number(v) || 0), spec.min, spec.max); p[spec.key] = v; num.value = v; rng.value = v; if (!isOn(id)) enable(id, true); schedule(live ? 110 : 30); };
    rng.addEventListener('input', () => setv(rng.value, true));
    rng.addEventListener('dblclick', () => setv(spec.default));
    num.addEventListener('change', () => setv(num.value));
    num.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.setVal = (v) => { num.value = v; rng.value = v; };
    return wrap;
  }
  const change = (id) => { if (!isOn(id)) enable(id, true); schedule(0); };
  function control(id, spec) {
    const p = P(id);
    switch (spec.type) {
      case 'range': return slider(id, spec);
      case 'header': return el('h5', {}, spec.label);
      case 'check': { const c = checkEl(spec.label, p[spec.key], (v) => { p[spec.key] = v; change(id); if (id === 'superZoom') renderSettings(); }); c.classList.add('ctl'); return c; }
      case 'select': return el('div', { class: 'nf-row ctl' }, el('span', { class: 'l' }, spec.label), selectEl(spec.options, p[spec.key], (v) => { p[spec.key] = v; change(id); }));
      case 'seg': {
        const sg = el('div', { class: 'nf-seg' });
        for (const [v, l] of spec.options) sg.append(el('button', { class: String(p[spec.key]) === String(v) ? 'on' : '', onclick: () => { p[spec.key] = v; change(id); renderSettings(); drawBadges(); } }, l));
        return el('div', { class: 'nf-row ctl' }, el('span', { class: 'l' }, spec.label), sg);
      }
      case 'styles': {
        const g = el('div', { class: 'nf-styles' });
        for (const [v, l] of spec.options) g.append(el('button', { class: p[spec.key] === v ? 'on' : '', onclick: () => { p[spec.key] = v; change(id); renderSettings(); } }, l));
        return el('div', { class: 'ctl', style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, el('span', {}, spec.label), g);
      }
      case 'layerRef': {
        if (!refLayers.length) return el('div', { class: 'nf-alert info', html: INFO }, el('div', {}, 'Harmonization needs a reference: add another layer to the document (e.g. the background you are compositing onto), then reopen Neural Filters.'));
        return el('div', { class: 'nf-row ctl' }, el('span', { class: 'l' }, 'Select layer'), selectEl(refLayers.map(l => [String(l.id), l.name || 'Layer']), p.ref, (v) => { p.ref = v; change(id); }));
      }
      case 'colorRef': return colorRefUI(id);
      case 'points': return pointsUI();
      case 'focal': return focalUI();
    }
    return null;
  }
  function colorRefUI(id) {
    const p = P(id), ref = String(p.ref), kind = ref.startsWith('preset:') ? 'preset' : ref.startsWith('layer:') ? 'layer' : 'file';
    const box = el('div', { class: 'ctl', style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    const sg = el('div', { class: 'nf-seg' });
    const go = (k) => { if (k === 'preset') p.ref = 'preset:goldenHour'; else if (k === 'layer') p.ref = refLayers[0] ? 'layer:' + refLayers[0].id : 'layer:'; else p.ref = 'file'; change(id); renderSettings(); };
    [['preset', 'Presets'], ['layer', 'Layer'], ['file', 'Image file']].forEach(([k, l]) => sg.append(el('button', { class: kind === k ? 'on' : '', onclick: () => go(k) }, l)));
    box.append(el('div', { class: 'nf-row' }, el('span', { class: 'l' }, 'Reference'), sg));
    if (kind === 'preset') {
      const g = el('div', { class: 'nf-presets' });
      for (const [k, v] of Object.entries(N.COLOR_PRESETS)) {
        const cols = v.colors.map(c => `rgb(${c[0]},${c[1]},${c[2]})`);
        g.append(el('div', { class: 'pz' + (ref === 'preset:' + k ? ' on' : ''), onclick: () => { p.ref = 'preset:' + k; change(id); renderSettings(); } }, el('div', { style: { background: `linear-gradient(135deg, ${cols.join(',')})` } }), v.label));
      }
      box.append(g);
    } else if (kind === 'layer') {
      if (!refLayers.length) box.append(el('div', { class: 'note' }, 'No other layers in this document.'));
      else box.append(el('div', { class: 'nf-row' }, el('span', { class: 'l' }, 'Select layer'), selectEl(refLayers.map(l => ['layer:' + l.id, l.name || 'Layer']), ref, (v) => { p.ref = v; change(id); })));
    } else {
      const inp = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        try {
          const bmp = await createImageBitmap(f);
          const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height)), c = createCanvas(bmp.width * s, bmp.height * s), g = ctx2d(c); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, c.width, c.height);
          st.fileRef = { canvas: c, name: f.name, stamp: Date.now() }; p.ref = 'file'; change(id); renderSettings();
        } catch (e) { toast('Could not open that image: ' + (e.message || e), 'err'); }
      });
      const th = el('canvas', { width: 72, height: 54 });
      if (st.fileRef) { const g = ctx2d(th), c = st.fileRef.canvas, s = Math.min(72 / c.width, 54 / c.height); g.drawImage(c, (72 - c.width * s) / 2, (54 - c.height * s) / 2, c.width * s, c.height * s); }
      box.append(inp, el('div', { class: 'nf-refthumb' }, th, el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } }, el('button', { class: 'btn', onclick: () => inp.click() }, st.fileRef ? 'Replace image…' : 'Choose image…'), el('span', { class: 'note' }, st.fileRef ? st.fileRef.name : 'PNG, JPEG or WebP'))));
    }
    return box;
  }
  function pointsUI() {
    const p = P('colorize'), pts = p.points;
    const col = el('input', { type: 'color', value: p.color });
    const setColor = (v) => { p.color = v; col.value = v; if (st.selPoint >= 0 && pts[st.selPoint]) { pts[st.selPoint].color = v; change('colorize'); drawMarks(); renderSettings(); } };
    col.addEventListener('input', () => setColor(col.value));
    const sw = el('div', { class: 'nf-swatches' }, SWATCHES.map(c => el('span', { style: { background: c }, title: c, onclick: () => setColor(c) })));
    const pl = el('div', { class: 'nf-pts' });
    pts.forEach((q, i) => {
      const d = el('div', { class: 'nf-pt' + (i === st.selPoint ? ' sel' : ''), style: { background: q.color }, title: 'Focus point ' + (i + 1), onclick: () => { st.selPoint = i; p.color = q.color; renderSettings(); drawMarks(); } }, el('b', { title: 'Remove', onclick: (e) => { e.stopPropagation(); pts.splice(i, 1); st.selPoint = -1; change('colorize'); renderSettings(); drawMarks(); } }, '×'));
      pl.append(d);
    });
    if (pts.length) pl.append(el('button', { class: 'btn', style: { height: '22px', fontSize: '11px' }, onclick: () => { pts.length = 0; st.selPoint = -1; change('colorize'); renderSettings(); drawMarks(); } }, 'Clear all'));
    return el('div', { class: 'ctl', style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
      el('div', { class: 'nf-row' }, el('span', { class: 'l' }, 'Focus color'), col, sw),
      el('div', { class: 'note' }, pts.length ? `${pts.length} focus point${pts.length > 1 ? 's' : ''}. Click the image to add more; choose a color to recolor the selected point; drag to move; Alt+click removes.` : 'Click on the image to add a focus point, then choose its color.'),
      pl);
  }
  function focalUI() {
    const fp = P('depthBlur').focalPoint;
    return el('div', { class: 'ctl', style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
      el('div', { class: 'nf-row' }, el('span', { class: 'l' }, 'Focal point'), el('span', { class: 'note', style: { flex: 1 } }, fp ? `${Math.round(fp.x * W)}, ${Math.round(fp.y * H)} px` : 'Click the preview to focus on a point'),
        fp ? el('button', { class: 'btn', style: { height: '22px', fontSize: '11px' }, onclick: () => { P('depthBlur').focalPoint = null; renderSettings(); drawMarks(); } }, 'Clear') : null));
  }
  function modelInfo(id) {
    const F = N.NEURAL_FILTERS[id], k = modelKeyFor(id), out = [];
    if (!k) { out.push(el('span', { class: 'tag noai', html: OKI }, id === 'colorize' ? 'Guided by you — no AI model' : 'Runs locally — no download')); return out; }
    const M = N.NEURAL_MODELS[k], m = st.models[k];
    out.push(el('span', { class: 'tag ai', html: CLOUD, title: M.id + (M.alt ? ' (fallback ' + M.alt + ')' : '') }, `AI model · ${M.id.split('/')[1]} · ${M.size}`));
    if (m?.state === 'error') {
      const retry = el('button', { class: 'btn', onclick: () => { delete st.models[k]; N.resetModelError(k); upscalers[k] = null; renderSettings(); refreshListStatus(); if (k === 'depth') ensureDepth().then(() => schedule(0)); else schedule(0); } }, 'Retry');
      const acts = el('div', { class: 'acts' }, retry);
      let msg = m.msg;
      if (id === 'jpegArtifacts') msg += ' Using standard deblocking instead.';
      if (id === 'superZoom') {
        if (P('superZoom').fallback) msg = 'AI model unavailable — using standard (bicubic) upscaling.';
        else acts.append(el('button', { class: 'btn', onclick: () => { P('superZoom').fallback = true; renderSettings(); schedule(0); } }, 'Use standard upscaling'));
      }
      if (id === 'depthBlur') msg += ' Depth Blur needs the depth model to work.';
      out.push(el('div', { class: 'nf-alert' + (id === 'jpegArtifacts' || P('superZoom').fallback && id === 'superZoom' ? ' info' : ''), html: WARN }, el('div', {}, msg, acts)));
    } else if (id === 'jpegArtifacts' && P(id).useAI !== false && st.view === 'fit') {
      out.push(el('div', { class: 'note' }, 'At Fit zoom the preview uses fast deblocking; zoom to 100% to preview the AI result. The AI model is always used for the final output when available.'));
    } else if (m?.state === 'loading') out.push(el('div', { class: 'note' }, m.msg || 'Loading model…'));
    return out;
  }
  function renderSettings() {
    const id = st.selected, F = N.NEURAL_FILTERS[id];
    set.textContent = ''; set.scrollTop = 0;
    set.classList.toggle('off', !isOn(id));
    set.append(el('h3', {}, F.name, swEl(id)), el('div', { class: 'desc' }, F.desc), ...modelInfo(id));
    for (const spec of F.params) { const c = control(id, spec); if (c) set.append(c); }
    if (id === 'superZoom') {
      const s = szScale() > 1 ? szScale() : (Number(P(id).scale) === 4 ? 4 : 2), ow = W * s, oh = H * s, ok = ow <= MAX_OUT_SIDE && oh <= MAX_OUT_SIDE && ow * oh <= MAX_OUT_AREA;
      set.append(el('div', { class: ok ? 'note' : 'nf-alert', html: ok ? '' : WARN }, el('div', {}, `Output size: ${ow} × ${oh} px` + (ok ? ' (new document)' : ` — too large. Maximum is ${MAX_OUT_SIDE} px per side and ${MAX_OUT_AREA / 1e6} megapixels; choose ×2 or crop the image first.`))));
    }
    if (id === 'skinSmoothing') set.append(el('div', { class: 'note' }, 'Smoothing is limited to skin-toned areas. Use “New Layer Masked” output to refine where it applies.'));
  }
  function syncOutput() {
    const sz = isOn('superZoom');
    outSel.disabled = sz;
    outSel.value = sz ? 'newDocument' : st.output;
    outNote.textContent = sz ? 'Super Zoom always outputs a new document' : '';
  }

  // ---------- final ----------
  async function runFinal(onP) {
    const stack = stackList(), sz = isOn('superZoom');
    if (!stack.length && !sz) return null;
    const abort = () => closed;
    if (isOn('depthBlur')) { onP('Estimating depth…', null); await ensureDepth(); }
    const ctx = makeCtx({ scale: 1, region: { x: 0, y: 0, w: W, h: H }, abort, depth: (img) => depthFor({ x: 0, y: 0, w: W, h: H }, img), aiJpeg: aiJpegFn(abort, (l, f) => onP(l, f)) });
    let img = srcImg;
    if (stack.length) img = (await N.runStack(srcImg, stack, ctx, null, (f, name) => onP(`Applying ${name}…`, f * (sz ? 0.4 : 1)))).img;
    if (sz) {
      const p = P('superZoom'), plan = N.superZoomPlan(p);
      const u = p.fallback ? null : await getUpscaler(plan.model);
      if (!u && !p.fallback) throw Object.assign(new Error('The Super Zoom model is unavailable. Choose “Use standard upscaling” in Super Zoom, or turn Super Zoom off.'), { user: true });
      img = await N.runSuperZoom(img, p, u, { abort, onProgress: (f) => onP(`Super Zoom ×${plan.scale}…`, 0.4 + f * 0.6) });
    }
    const output = sz ? 'newDocument' : st.output;
    const res = { imageData: new ImageData(img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data), img.width, img.height), output, width: img.width, height: img.height };
    if (output === 'newLayerMasked' && img.width === W && img.height === H) res.mask = N.changeMask(srcImg, img);
    return res;
  }

  // ---------- assemble ----------
  buildList(); renderSettings(); syncTools(); syncOutput();
  let result = null;
  const okBtn = {
    label: 'OK', primary: true, value: () => result,
    validate: async () => {
      if (finalRunning) return false;
      if (isOn('superZoom')) { const s = szScale(); if (W * s > MAX_OUT_SIDE || H * s > MAX_OUT_SIDE || W * H * s * s > MAX_OUT_AREA) { toast('Super Zoom output would be too large.', 'err'); return false; } }
      finalRunning = true; gen++;
      const ov = el('div', { class: 'nf-final' }, el('div', { class: 'box' }, el('b', {}, 'Applying Neural Filters'), el('span', { class: 'lbl' }, 'Starting…'), el('div', { class: 'bar' }, el('span'))));
      root.style.position = 'relative'; root.append(ov);
      const onP = (l, f) => { ov.querySelector('.lbl').textContent = l; ov.querySelector('.bar span').style.width = (f == null ? 15 : clamp(f, 0, 1) * 100) + '%'; };
      try { result = await runFinal(onP); return !closed; }
      catch (e) { if (!e.cancelled) { console.error(e); toast(e.message || String(e), 'err', 6000); } return false; }
      finally { finalRunning = false; ov.remove(); }
    },
  };
  const r = await modal({
    title: 'Neural Filters', body: root, className: 'nf-modal', width: DW,
    buttons: [{ node: cmpChk }, { node: el('span', { style: { width: '14px' } }) }, { node: el('div', { class: 'nf-out' }, 'Output', outSel) }, { node: outNote }, '-', { label: 'Cancel', value: null }, okBtn],
    onOpen: () => { setTimeout(() => schedule(0), 0); },
    onKey: (e) => {
      if (e.target && (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox')) return false;
      if (e.key === '\\') { st.showOriginal = !st.showOriginal; syncTools(); schedule(0); return true; }
      if ((e.ctrlKey || e.metaKey) && (e.key === '0' || e.key === '1')) { e.preventDefault(); setView(e.key === '0' ? 'fit' : '100'); return true; }
      return false;
    },
  });
  closed = true; gen++;
  return r || null;
}
