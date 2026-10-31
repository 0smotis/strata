// Module Web Worker wrapping the Camera Raw engine (raw.js).
//   new Worker(new URL('./raw.worker.js', import.meta.url), { type: 'module' })
// Request: {id, op, args}
//   init:    args = {full, preview, draft?}   images {data,width,height}; buffers may be transferred.
//            Keeps them for the session (preview/draft are downscaled copies of full).
//   preview: args = {settings, which?: 'preview'|'draft', view?}
//            -> {data,width,height, hist:{r,g,b,l}, ms, which}
//   region:  args = {settings, rect:{x,y,width,height}}  (full-res coords; low-freq guides from preview)
//            -> {data,width,height,x,y, ms}
//   full:    args = {settings}                -> {data,width,height}   (progress replies)
//   auto:    args = {}                         -> {tone: autoRawSettings(preview), wb: autoWhiteBalance(preview)}
//   apply:   args = {img, settings, opts?}     -> {data,width,height}   (stateless, for other callers)
// Replies:  {id, progress: 0..1}  (full / apply, throttled)
//           {id, ok: true, result}   (pixel buffers transferred)
//           {id, ok: false, error}
import { applyCameraRaw, autoRawSettings, autoWhiteBalance, rawHistogram } from './raw.js';

const asU8C = (d) => (d instanceof Uint8ClampedArray ? d : ArrayBuffer.isView(d) ? new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength) : new Uint8ClampedArray(d));
const asImg = (im) => (im ? { data: asU8C(im.data), width: im.width | 0, height: im.height | 0 } : null);

const state = { full: null, preview: null, draft: null };

function progressFn(id) {
  let last = -1, lastT = 0;
  return (f) => {
    const now = Date.now();
    if (f >= 1 || f - last >= 0.02 || now - lastT > 120) { last = f; lastT = now; self.postMessage({ id, progress: f }); }
  };
}
const xfer = (...bufs) => bufs.filter((b) => b && !(typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer));

self.onmessage = ({ data }) => {
  const { id, op, args = {} } = data || {};
  try {
    let result, transfer = [];
    const t0 = performance.now();
    switch (op) {
      case 'init': {
        state.full = asImg(args.full);
        state.preview = asImg(args.preview) || state.full;
        state.draft = asImg(args.draft) || state.preview;
        result = { width: state.full.width, height: state.full.height };
        break;
      }
      case 'preview': {
        const src = args.which === 'draft' ? state.draft : state.preview;
        if (!src) throw new Error('raw.worker: not initialised');
        const out = applyCameraRaw(src, args.settings, { scale: src.width / state.full.width, cache: true, view: args.view });
        const hist = rawHistogram(out);
        result = { data: out.data, width: out.width, height: out.height, hist, ms: performance.now() - t0, which: args.which || 'preview' };
        transfer = xfer(out.data.buffer, hist.r.buffer, hist.g.buffer, hist.b.buffer, hist.l.buffer);
        break;
      }
      case 'region': {
        if (!state.full) throw new Error('raw.worker: not initialised');
        const r = args.rect;
        const out = applyCameraRaw(state.full, args.settings, { region: r, guide: state.preview, scale: 1, cache: true, view: args.view });
        result = { data: out.data, width: out.width, height: out.height, x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)), ms: performance.now() - t0 };
        transfer = xfer(out.data.buffer);
        break;
      }
      case 'full': {
        if (!state.full) throw new Error('raw.worker: not initialised');
        const out = applyCameraRaw(state.full, args.settings, { scale: 1, onProgress: progressFn(id) });
        result = { data: out.data, width: out.width, height: out.height, ms: performance.now() - t0 };
        transfer = xfer(out.data.buffer);
        break;
      }
      case 'auto': {
        const src = state.preview || asImg(args.img);
        result = { tone: autoRawSettings(src), wb: autoWhiteBalance(src) };
        break;
      }
      case 'apply': {
        const out = applyCameraRaw(asImg(args.img), args.settings, { ...(args.opts || {}), onProgress: progressFn(id) });
        result = { data: out.data, width: out.width, height: out.height };
        transfer = xfer(out.data.buffer);
        break;
      }
      default: throw new Error(`raw.worker: unknown op "${op}"`);
    }
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && (e.stack || e.message)) || e) });
  }
};
