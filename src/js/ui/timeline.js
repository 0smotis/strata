// Timeline panel (frame animation)
import { app, cmd } from '../state.js';
import { el, $, createCanvas, ctx2d, debounce } from '../util.js';
import { ICONS } from '../icons.js';
import { selectEl, showMenu } from './common.js';
import { selectFrame, applyFrame } from '../commands2.js';

const DELAYS = [[0, 'No delay'], [0.1, '0.1 sec'], [0.2, '0.2'], [0.5, '0.5'], [1, '1.0'], [2, '2.0'], [5, '5.0'], [10, '10.0']];
let thumbs = new Map();
function frameThumb(d, f, k) {
  const key = d.id + ':' + k + ':' + JSON.stringify(f.layers).length + ':' + (d._compVer || 0);
  if (thumbs.has(key)) return thumbs.get(key);
  const sc = Math.min(96 / d.width, 64 / d.height), c = createCanvas(Math.max(1, Math.round(d.width * sc)), Math.max(1, Math.round(d.height * sc)));
  d._applyingFrame = true;
  const saved = {}; for (const L of d.all()) saved[L.id] = { v: L.visible, o: L.opacity, x: L.x, y: L.y, tx: L.tx ? [...L.tx] : null };
  applyFrame(d, f); ctx2d(c).drawImage(d.flatten(), 0, 0, c.width, c.height); applyFrame(d, { layers: saved });
  d._applyingFrame = false;
  if (thumbs.size > 200) thumbs = new Map();
  thumbs.set(key, c); return c;
}
export function initTimeline() {
  const root = $('#timeline');
  const render = debounce(() => {
    const d = app.doc;
    root.innerHTML = '';
    const head = el('div', { class: 'tl-head' }, el('span', { class: 'ico', html: ICONS.filmstrip }), el('b', {}, 'Timeline'), el('span', { class: 'grow' }), el('button', { class: 'ibtn', title: 'Close', html: ICONS.close, onclick: () => root.classList.add('hidden') }));
    root.append(head);
    if (!d) { root.append(el('div', { class: 'tl-empty' }, 'Open a document to animate.')); return; }
    if (!d.frames) { root.append(el('div', { class: 'tl-empty' }, el('button', { class: 'btn primary', onclick: () => cmd('timelineCreate') }, 'Create Frame Animation'), el('button', { class: 'btn', onclick: () => cmd('framesFromLayers') }, 'Make Frames From Layers'))); return; }
    const strip = el('div', { class: 'tl-strip' });
    d.frames.forEach((f, k) => {
      const fr = el('div', { class: 'tl-frame' + (k === d.frameIndex ? ' on' : ''), onclick: () => selectFrame(d, k) }, el('div', { class: 'n' }, String(k + 1)), frameThumb(d, f, k));
      const sel = selectEl(DELAYS, DELAYS.some(x => x[0] === f.delay) ? f.delay : 'other', (v) => { cmd('frameDelay', k, Number(v)); });
      if (!DELAYS.some(x => x[0] === f.delay)) sel.append(el('option', { value: 'other', selected: true }, f.delay + ' sec'));
      sel.onclick = (e) => e.stopPropagation();
      fr.append(sel);
      fr.oncontextmenu = (e) => { e.preventDefault(); selectFrame(d, k); showMenu([{ label: 'New Frame', cmd: 'frameNew' }, { label: 'Delete Frame', cmd: 'frameDelete' }, { label: 'Tween…', cmd: 'frameTween' }, '-', { label: 'Make Frames From Layers', cmd: 'framesFromLayers' }, { label: 'Delete Animation', cmd: 'timelineDelete' }], e.clientX, e.clientY); };
      strip.append(fr);
    });
    const loop = selectEl([[0, 'Forever'], [1, 'Once'], [3, '3 times']], d.loop || 0, (v) => { d.loop = Number(v); });
    const playing = !!app._playTimer;
    const ctrls = el('div', { class: 'tl-ctrls' }, loop,
      el('button', { class: 'ibtn', title: 'Select first frame', html: ICONS.firstFrame, onclick: () => selectFrame(d, 0) }),
      el('button', { class: 'ibtn', title: 'Select previous frame', html: ICONS.prevFrame, onclick: () => selectFrame(d, (d.frameIndex - 1 + d.frames.length) % d.frames.length) }),
      el('button', { class: 'ibtn', title: playing ? 'Stop' : 'Play animation', html: playing ? ICONS.stop : ICONS.play, onclick: () => cmd('framePlay') }),
      el('button', { class: 'ibtn', title: 'Select next frame', html: ICONS.nextFrame, onclick: () => selectFrame(d, (d.frameIndex + 1) % d.frames.length) }),
      el('button', { class: 'ibtn', title: 'Tween animation frames', html: ICONS.tween, onclick: () => cmd('frameTween') }),
      el('button', { class: 'ibtn', title: 'Duplicate selected frame', html: ICONS.plus, onclick: () => cmd('frameNew') }),
      el('button', { class: 'ibtn', title: 'Delete selected frame', html: ICONS.trash, onclick: () => cmd('frameDelete') }),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn', onclick: () => cmd('exportGif') }, 'Export GIF…'), el('button', { class: 'btn', onclick: () => cmd('exportVideo') }, 'Render Video…'));
    root.append(strip, ctrls);
    const on = strip.querySelector('.on'); if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, 60);
  app.on('timeline', render); app.on('doc', render);
  app.on('show-timeline', () => { root.classList.remove('hidden'); render(); });
  app.commands.toggleTimeline = { run: () => { root.classList.toggle('hidden'); render(); } };
  render();
}
