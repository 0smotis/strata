module.exports = async (win, OUT, errs) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  const shot = (n) => win.screenshot({ path: OUT + '/' + n + '.png' });
  const log = (...a) => console.log(...a);
  await ev(async () => {
    const { newDocument } = await import('./js/doc/document.js'); const { addDoc } = await import('./js/commands.js');
    const d = newDocument({ width: 1000, height: 700, name: 'tools.psd' }); const g = d.layers[0].canvas.getContext('2d');
    for (let y = 0; y < 700; y += 20) for (let x = 0; x < 1000; x += 20) { g.fillStyle = `hsl(${(x + y) / 6},60%,${40 + ((x / 20 + y / 20) % 2) * 20}%)`; g.fillRect(x, y, 20, 20); }
    d.layers[0].touch(true); d.history = []; d.hIndex = -1; d.commit('Open'); addDoc(d);
  });
  await win.waitForTimeout(500);
  const toS = (x, y) => ev(([x, y]) => { const v = app.doc.view, r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.left + (x - v.cx) * v.zoom + r.width / 2, y: r.top + (y - v.cy) * v.zoom + r.height / 2 }; }, [x, y]);
  const drag = async (tool, pts, mods = []) => {
    await ev((t) => app.commands.setTool.run(t), tool);
    const s = await Promise.all(pts.map(p => toS(p[0], p[1])));
    for (const m of mods) await win.keyboard.down(m);
    await win.mouse.move(s[0].x, s[0].y); await win.mouse.down();
    for (const p of s.slice(1)) await win.mouse.move(p.x, p.y, { steps: 6 });
    await win.mouse.up();
    for (const m of mods) await win.keyboard.up(m);
    await win.waitForTimeout(250);
    const h = await ev(() => app.doc.history[app.doc.hIndex].name);
    log(tool, '->', h);
  };
  const click = async (tool, x, y, mods = []) => { await ev((t) => app.commands.setTool.run(t), tool); const s = await toS(x, y); for (const m of mods) await win.keyboard.down(m); await win.mouse.click(s.x, s.y); for (const m of mods) await win.keyboard.up(m); await win.waitForTimeout(300); log(tool, 'click ->', await ev(() => app.doc.history[app.doc.hIndex].name)); };
  await drag('eraser', [[100, 100], [300, 120]]);
  await click('clone', 500, 300, ['Alt']);
  await drag('clone', [[200, 400], [300, 450]]);
  await click('heal', 600, 300, ['Alt']);
  await drag('heal', [[700, 500], [760, 520]]);
  await win.waitForTimeout(600);
  await drag('dodge', [[100, 500], [300, 520]]);
  await drag('burn', [[100, 560], [300, 580]]);
  await drag('sponge', [[100, 620], [300, 640]]);
  await drag('blurTool', [[500, 100], [700, 120]]);
  await drag('sharpenTool', [[500, 160], [700, 180]]);
  await drag('smudge', [[500, 220], [700, 240]]);
  await ev(() => app.commands.newLayer.run());
  await drag('gradient', [[0, 0], [1000, 700]]);
  await ev(() => { const d = app.doc; d.active.opacity = 0.4; d.active.touch(); });
  await click('bucket', 50, 50);
  await drag('lasso', [[100, 100], [300, 100], [300, 300], [100, 300]]);
  await ev(() => app.commands.setTool.run('polyLasso'));
  for (const [x, y] of [[400, 100], [600, 100], [500, 300]]) { const s = await toS(x, y); await win.mouse.click(s.x, s.y); }
  await win.keyboard.press('Enter'); log('poly ->', await ev(() => app.doc.history[app.doc.hIndex].name));
  await drag('quickSelect', [[150, 150], [250, 250]]);
  await drag('move', [[200, 200], [260, 240]]);
  await ev(() => app.commands.deselect.run());
  await drag('ellipseShape', [[600, 400], [800, 600]], ['Shift']);
  await drag('starShape', [[100, 400], [250, 550]]);
  await drag('lineShape', [[300, 600], [600, 650]]);
  await click('eyedropper', 500, 300);
  log('fg', await ev(() => app.fg));
  await drag('crop', [[0, 0], [100, 50]]);
  await win.keyboard.press('Enter'); await win.waitForTimeout(300); log('crop ->', await ev(() => [app.doc.width, app.doc.height, app.doc.history[app.doc.hIndex].name]));
  await shot('30-tools');
  // dialogs
  const dlg = async (name, fn) => { ev(fn); await win.waitForTimeout(700); await shot('31-' + name); await win.keyboard.press('Escape'); await win.waitForTimeout(250); };
  await dlg('newdoc', () => app.commands.newDoc.run());
  await dlg('imagesize', () => app.commands.imageSize.run());
  await dlg('canvassize', () => app.commands.canvasSize.run());
  await dlg('liquify', () => { const d = app.doc; d.setActive(d.layers[0].id); app.commands.liquify.run(); });
  await dlg('colorpicker', () => app.commands.pickColor.run('fg'));
  await dlg('prefs', () => app.commands.preferences.run());
  await dlg('export', () => app.commands.exportAs.run());
  await dlg('hue', () => app.commands.adjustment.run('hueSaturation'));
  // menus
  for (const m of ['File', 'Edit', 'Image', 'Layer', 'Select', 'Filter']) { await win.click(`#menubar .mi:text-is("${m}")`); await win.waitForTimeout(200); if (m === 'Filter' || m === 'Layer') await shot('32-menu-' + m); await win.keyboard.press('Escape'); await win.mouse.click(5, 300); }
  // all filters quick run without dialog on small doc
  const res = await ev(async () => {
    const { FILTERS } = await import('./js/engine/filters.js'); const out = [];
    const c = document.createElement('canvas'); c.width = 120; c.height = 90; const g = c.getContext('2d'); g.fillStyle = '#48c'; g.fillRect(0, 0, 120, 90); const img = g.getImageData(0, 0, 120, 90);
    for (const [k, f] of Object.entries(FILTERS)) { try { const p = {}; for (const s of f.params) p[s.key] = s.default; f.run({ data: img.data, width: 120, height: 90 }, p, { fg: '#000000', bg: '#ffffff', seed: 1 }); } catch (e) { out.push(k + ': ' + e.message); } }
    return out;
  });
  log('filter failures', JSON.stringify(res));
  // undo all the way & redo
  await ev(() => { const d = app.doc; d.goto(0); d.goto(d.history.length - 1); });
  log('history len', await ev(() => app.doc.history.length));
};
