// Global app state singleton
import { Emitter } from './util.js';

export const app = new Emitter();
Object.assign(app, {
  docs: [],
  doc: null,
  fg: '#000000',
  bg: '#ffffff',
  tool: 'move',
  toolMemory: {}, // group → last used tool id
  opts: {},       // per-tool options
  settings: {},
  commands: {},
  recent: [],
  swatches: [],
  maskEdit: false, // painting targets the active layer's mask
  showRulers: false, showGrid: false, showGuides: true, showSelEdges: true, snap: true,
  panelsHidden: false,
  lastFilter: null,
  clipboard: null,
  brushPresets: [],
});

export function cmd(name, ...args) {
  const c = app.commands[name];
  if (!c) { console.warn('Unknown command', name); return; }
  if (c.enabled && !c.enabled()) return;
  try {
    const r = c.run(...args);
    if (r && r.catch) r.catch(err => { console.error(err); app.emit('error', err); });
    return r;
  } catch (err) { console.error(err); app.emit('error', err); }
}
export function defineCommands(obj) { Object.assign(app.commands, obj); }
export function setActiveDoc(d) { app.doc = d; app.emit('doc', d); }
