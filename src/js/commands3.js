// Camera Raw Filter, Puppet/Perspective/Warp transforms, Neural Filters — integration commands.
import { app, cmd, defineCommands } from './state.js';
import { createCanvas, ctx2d, cloneCanvas, alphaBounds } from './util.js';
import { toast, withBusy } from './ui/common.js';
import { Layer, Document } from './doc/document.js';
import { Surface, resolveTarget } from './tools/base.js';
import { blendWithSelection, canvasOfImg, smartFilterAdd, addDoc, record } from './commands.js';

const D = () => app.doc;
const hasLayer = () => !!app.doc?.active;

async function pixelSurface(name) {
  const d = D(); const t = await resolveTarget(d, { allowMask: false, allowSelection: false, toolName: name }); if (!t) return null;
  return new Surface(d, t);
}
function imageDataToCanvas(id) { const c = createCanvas(id.width, id.height); ctx2d(c).putImageData(id instanceof ImageData ? id : new ImageData(new Uint8ClampedArray(id.data), id.width, id.height), 0, 0); return c; }

// Camera Raw
async function loadRaw() {
  const ui = await import('./ui/cameraraw.js');
  let eng = null; try { eng = await import('./engine/raw.js'); } catch {}
  app.cameraRaw = { dialog: ui.cameraRawDialog, apply: eng ? eng.applyCameraRaw : null };
  return app.cameraRaw;
}
loadRaw().catch(() => {});
async function cameraRaw() {
  const d = D(); const raw = await loadRaw();
  const L = d.active;
  if (L?.kind === 'smart') {
    return smartFilterAdd(d, L, { type: 'cameraRaw', params: null }, async (p, live) => { const r = await raw.dialog(L.smart.cache, {}); return r ? r.settings : null; });
  }
  const s = await pixelSurface('Camera Raw Filter'); if (!s) return;
  const r = await raw.dialog(s.orig, {});
  if (!r) { s.cancel(); return; }
  blendWithSelection(d, s, imageDataToCanvas(r.imageData));
  s.commit('Camera Raw Filter', 'liquify');
}

// Warps
async function warpCmd(kind) {
  const d = D(), m = await import('./ui/warps.js');
  const fn = { puppet: m.puppetWarpDialog, perspective: m.perspectiveWarpDialog, warp: m.warpTransformDialog }[kind];
  const name = { puppet: 'Puppet Warp', perspective: 'Perspective Warp', warp: 'Warp' }[kind];
  const L = d.active;
  if (L && L.kind === 'smart' && kind === 'warp') { /* warp on smart objects: rasterize-free by baking into contents copy */ }
  const s = await pixelSurface(name.toLowerCase()); if (!s) return;
  const res = await fn(s.orig);
  if (!res) { s.cancel(); return; }
  const g = ctx2d(s.canvas); g.globalCompositeOperation = 'copy'; g.drawImage(imageDataToCanvas(res), 0, 0); g.globalCompositeOperation = 'source-over';
  s.changed(); s.commit(name, 'warp');
}

// Neural Filters
async function neuralFilters() {
  const d = D(), m = await import('./ui/neural.js');
  const L = d.active;
  if (!L) { toast('Select a layer first.', 'err'); return; }
  let src;
  if (L.kind === 'pixel') { src = createCanvas(d.width, d.height); ctx2d(src).drawImage(L.canvas, L.x, L.y); }
  else src = d.renderLayerAlone(L, false);
  const layers = d.all().filter(l => l !== L && !l.children && l.kind !== 'adjustment' && l.visible).map(l => ({ id: l.id, name: l.name, canvas: d.renderLayerAlone(l, false) }));
  const r = await m.neuralFiltersDialog(src, { layers });
  if (!r) return;
  const out = imageDataToCanvas(r.imageData);
  if (r.output === 'newDocument' || r.width !== d.width || r.height !== d.height) {
    const nd = new Document(out.width, out.height, { name: d.name.replace(/\.[^.]+$/, '') + ' (Neural).psd', resolution: d.resolution });
    const nl = nd.newPixelLayer('Layer 0'); ctx2d(nl.canvas).drawImage(out, 0, 0); nd.layers = [nl]; nd.activeId = nl.id; nd.commit('Neural Filters', 'sparkle');
    addDoc(nd); return;
  }
  if (r.output === 'current' && L.kind === 'pixel') {
    const s = new Surface(d, { kind: 'layer', layer: L });
    const g = ctx2d(s.canvas); g.globalCompositeOperation = 'copy'; g.drawImage(out, -s.ox, -s.oy); g.globalCompositeOperation = 'source-over';
    s.commit('Neural Filters', 'sparkle'); return;
  }
  const n = new Layer('pixel', { name: L.name + ' (Neural Filters)' });
  const b = alphaBounds(out) || { x: 0, y: 0, w: d.width, h: d.height };
  n.canvas = createCanvas(b.w, b.h); ctx2d(n.canvas).drawImage(out, -b.x, -b.y); n.x = b.x; n.y = b.y;
  if (r.output === 'newLayerMasked') {
    const mc = createCanvas(d.width, d.height), mg = ctx2d(mc);
    if (r.mask && r.mask.length === d.width * d.height) { const id = mg.createImageData(d.width, d.height); for (let i = 0; i < r.mask.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = r.mask[i]; } mg.putImageData(id, 0, 0); n.mask = { canvas: mc, x: 0, y: 0, def: 0, enabled: true, linked: true }; }
    else { mg.fillStyle = '#fff'; mg.fillRect(0, 0, d.width, d.height); n.mask = { canvas: mc, x: 0, y: 0, def: 255, enabled: true, linked: true }; }
  }
  d.addLayer(n); d.commit('Neural Filters', 'sparkle');
}

defineCommands({
  cameraRaw: { enabled: hasLayer, run: () => cameraRaw() },
  puppetWarp: { enabled: hasLayer, run: () => warpCmd('puppet') },
  perspectiveWarp: { enabled: hasLayer, run: () => warpCmd('perspective') },
  warpTransform: { enabled: hasLayer, run: () => warpCmd('warp') },
  neuralFilters: { enabled: hasLayer, run: () => neuralFilters() },
  convertForSmartFilters: { enabled: hasLayer, run: () => { if (D().active.kind !== 'smart') cmd('convertToSmart'); } },
});
