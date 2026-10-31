// Artboard tool
import { app, cmd } from '../state.js';
import { registerTool } from './base.js';
registerTool({
  id: 'artboardTool', label: 'Artboard Tool', icon: 'artboard', key: 'V', group: 'move', cursor: 'crosshair', defaults: { bg: '#ffffff' },
  down(i) { this.p0 = { x: Math.round(i.x), y: Math.round(i.y) }; this.p1 = { ...this.p0 }; },
  move(i) { if (this.p0) this.p1 = { x: Math.round(i.x), y: Math.round(i.y) }; },
  up() {
    if (!this.p0) return; const a = this.p0, b = this.p1; this.p0 = null;
    const r = { x: Math.max(0, Math.min(a.x, b.x)), y: Math.max(0, Math.min(a.y, b.y)), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    if (r.w < 8 || r.h < 8) return;
    cmd('newArtboard', { ...r, name: app.doc.nextName('Artboard'), bg: app.opts.artboardTool.bg });
  },
  overlay(g, v) { if (!this.p0) return; const a = v.toScreen(this.p0.x, this.p0.y), b = v.toScreen(this.p1.x, this.p1.y); g.strokeStyle = '#2680eb'; g.lineWidth = 1; g.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); },
});
