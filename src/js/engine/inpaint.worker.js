// Module Web Worker wrapping the retouching engine.
//   new Worker(new URL('./inpaint.worker.js', import.meta.url), { type: 'module' })
// Request:  {id, op: 'inpaint'|'spotHeal'|'heal'|'findSourceOffset', args}
//   inpaint / spotHeal / findSourceOffset: args = {img: {data,width,height}, mask: Uint8Array, opts?}
//   heal:                                  args = {target, source, mask, opts?}
//   Any extra keys in args (e.g. mode, seed, sourceMask) are merged into opts.
// Replies:  {id, progress: 0..1}  (inpaint / spotHeal, throttled)
//           {id, ok: true, result}  result: Uint8ClampedArray (buffer transferred),
//                                    {data,x,y,width,height} when opts.returnRect, or {dx,dy,score}
//           {id, ok: false, error}
import { inpaint, spotHeal, heal, findSourceOffset } from './inpaint.js';

const asU8C = (d) => (d instanceof Uint8ClampedArray ? d : ArrayBuffer.isView(d) ? new Uint8ClampedArray(d.buffer, d.byteOffset, d.byteLength) : new Uint8ClampedArray(d));
const asU8 = (d) => (d == null ? d : d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
const asImg = (im) => (im ? { data: asU8C(im.data), width: im.width | 0, height: im.height | 0 } : im);

self.onmessage = ({ data }) => {
  const { id, op, args = {} } = data || {};
  try {
    const { img, mask, target, source, opts: o, ...rest } = args;
    const opts = { ...rest, ...(o || {}) };
    if (opts.sourceMask) opts.sourceMask = asU8(opts.sourceMask);
    if (opts.output) opts.output = asU8C(opts.output);
    let last = -1, lastT = 0;
    const onProgress = (f) => {
      const now = Date.now();
      if (f >= 1 || f - last >= 0.01 || now - lastT > 100) { last = f; lastT = now; self.postMessage({ id, progress: f }); }
    };
    let result;
    switch (op) {
      case 'inpaint': result = inpaint(asImg(img), asU8(mask), { ...opts, onProgress }); break;
      case 'spotHeal': result = spotHeal(asImg(img), asU8(mask), { ...opts, onProgress }); break;
      case 'heal': result = heal(asImg(target), asImg(source), asU8(mask), opts); break;
      case 'findSourceOffset': result = findSourceOffset(asImg(img), asU8(mask), opts); break;
      default: throw new Error(`inpaint.worker: unknown op "${op}"`);
    }
    const buf = result instanceof Uint8ClampedArray ? result.buffer : result && result.data instanceof Uint8ClampedArray ? result.data.buffer : null;
    const transfer = buf && !(typeof SharedArrayBuffer !== 'undefined' && buf instanceof SharedArrayBuffer) ? [buf] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && (e.stack || e.message)) || e) });
  }
};
