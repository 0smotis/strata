// Promise wrapper around the inpainting worker (falls back to main thread if workers fail).
let worker = null, seq = 1;
const pending = new Map();
function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./inpaint.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const p = pending.get(data.id); if (!p) return;
      if (data.progress != null && !('ok' in data)) { p.onProgress && p.onProgress(data.progress); return; }
      pending.delete(data.id);
      data.ok ? p.resolve(data.result) : p.reject(new Error(data.error || 'Retouch failed'));
    };
    worker.onerror = (e) => { console.error('inpaint worker error', e); for (const p of pending.values()) p.reject(new Error('Retouch worker crashed')); pending.clear(); worker = null; };
  } catch (e) { console.warn('worker unavailable', e); worker = null; }
  return worker;
}
export async function retouch(op, args, onProgress) {
  const w = getWorker();
  if (!w) { const m = await import('./inpaint.js'); const fn = { inpaint: m.inpaint, spotHeal: m.spotHeal, heal: m.heal, findSourceOffset: m.findSourceOffset }[op]; return op === 'heal' ? fn(args.target, args.source, args.mask, args.opts) : fn(args.img, args.mask, args.opts); }
  const id = seq++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    const transfer = [];
    w.postMessage({ id, op, args }, transfer);
  });
}
