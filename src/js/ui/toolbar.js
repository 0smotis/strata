// Left toolbar with flyout groups
import { app, cmd } from '../state.js';
import { el, $ } from '../util.js';
import { ICONS } from '../icons.js';
import { showMenu } from './common.js';
import { tools } from '../tools/base.js';
import { refreshCursor, requestDraw } from '../view/viewport.js';

export const TOOL_GROUPS = [
  ['move', 'artboardTool'], ['marqueeRect', 'marqueeEllipse', 'marqueeRow', 'marqueeCol'], ['lasso', 'polyLasso'], ['objectSelect', 'quickSelect', 'magicWand'],
  ['crop'], ['eyedropper'], '-',
  ['spotHeal', 'removeTool', 'heal', 'redEye'], ['brush', 'pencil'], ['clone'], ['historyBrush'], ['eraser', 'magicEraser'], ['gradient', 'bucket'],
  ['blurTool', 'sharpenTool', 'smudge'], ['dodge', 'burn', 'sponge'], '-',
  ['pen', 'freeformPen', 'addAnchor', 'deleteAnchor', 'convertPoint'], ['type'], ['pathSelect', 'directSelect'], ['rectShape', 'ellipseShape', 'triangleShape', 'polygonShape', 'starShape', 'lineShape'], '-',
  ['hand'], ['zoom'],
];
export const groupOf = (id) => TOOL_GROUPS.find(g => Array.isArray(g) && g.includes(id));

export function setTool(id) {
  if (!tools[id]) return;
  const prev = tools[app.tool];
  if (app.tool === id) return;
  if (prev && prev.deactivate) prev.deactivate();
  app.tool = id;
  const g = groupOf(id); if (g) app.toolMemory[g[0]] = id;
  if (tools[id].activate) tools[id].activate();
  app.emit('tool', id);
  refreshCursor(); requestDraw();
}
export function cycleKey(key, shift) {
  const groups = TOOL_GROUPS.filter(g => Array.isArray(g) && g.some(id => tools[id] && tools[id].key === key));
  if (!groups.length) return false;
  const cur = app.tool;
  const inGroup = groups.find(g => g.includes(cur));
  if (inGroup && shift) {
    const ids = inGroup.filter(id => tools[id].key === key);
    setTool(ids[(ids.indexOf(cur) + 1) % ids.length]);
  } else if (!inGroup) {
    const g = groups[0]; setTool(app.toolMemory[g[0]] || g.find(id => tools[id].key === key));
  } else if (groups.length > 1 && shift) { /* handled above */ }
  return true;
}

export function initToolbar() {
  const bar = $('#toolbar');
  const render = () => {
    bar.innerHTML = '';
    for (const g of TOOL_GROUPS) {
      if (g === '-') { bar.append(el('div', { class: 'tsep' })); continue; }
      const curId = g.includes(app.tool) ? app.tool : (app.toolMemory[g[0]] || g[0]);
      const t = tools[curId]; if (!t) continue;
      const b = el('div', { class: 'tb' + (g.includes(app.tool) ? ' on' : '') + (g.length > 1 ? ' flyout' : ''), title: `${t.label}${t.key ? ` (${t.key})` : ''}`, html: ICONS[t.icon] || ICONS.more });
      let timer;
      const fly = () => {
        const r = b.getBoundingClientRect();
        const items = g.map(id => ({ label: tools[id].label, key: tools[id].key, icon: tools[id].icon, cur: id === curId, run: () => setTool(id) }));
        items.flyout = true;
        showMenu(items, r.right + 2, r.top);
      };
      b.addEventListener('pointerdown', (e) => { if (e.button === 0 && g.length > 1) timer = setTimeout(fly, 450); });
      b.addEventListener('pointerup', () => clearTimeout(timer));
      b.addEventListener('click', () => setTool(curId));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); if (g.length > 1) fly(); });
      bar.append(b);
    }
    bar.append(el('div', { class: 'tsep' }));
    const colors = el('div', { class: 'colors' },
      el('div', { class: 'fg', style: { background: app.fg }, title: 'Set foreground color', onclick: () => cmd('pickColor', 'fg') }),
      el('div', { class: 'bg', style: { background: app.bg }, title: 'Set background color', onclick: () => cmd('pickColor', 'bg') }),
      el('div', { class: 'swap', html: ICONS.swap, title: 'Switch Foreground and Background Colors (X)', onclick: () => cmd('swapColors') }),
      el('div', { class: 'def', title: 'Default Foreground and Background Colors (D)', onclick: () => cmd('defaultColors') }));
    bar.append(colors);
    bar.append(el('div', { class: 'tb' + (app.doc?.quickMask ? ' on' : ''), title: 'Edit in Quick Mask Mode (Q)', html: ICONS.quickMask, onclick: () => cmd('quickMask') }));
    bar.append(el('div', { class: 'tb', title: 'Change Screen Mode (F)', html: ICONS.screenMode, onclick: () => cmd('togglePanels') }));
  };
  render();
  app.on('tool', render); app.on('colors', render); app.on('doc', render); app.on('quickmask', render);
}
