module.exports = async (win, OUT, errs) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  const shot = (n) => win.screenshot({ path: OUT + '/' + n + '.png' });
  const log = (...a) => console.log(...a);
  const H = () => ev(() => app.doc.history[app.doc.hIndex].name);
  await ev(async () => {
    const { newDocument } = await import('./js/doc/document.js'); const { addDoc } = await import('./js/commands.js');
    const d = newDocument({ width: 1000, height: 700, name: 'new.psd' }); const g = d.layers[0].canvas.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 1000, 700); gr.addColorStop(0, '#f5d76e'); gr.addColorStop(1, '#3a7bd5'); g.fillStyle = gr; g.fillRect(0, 0, 1000, 700);
    d.layers[0].touch(true); d.history = []; d.hIndex = -1; d.commit('Open'); addDoc(d);
  });
  await win.waitForTimeout(500);
  const toS = (x, y) => ev(([x, y]) => { const v = app.doc.view, r = document.querySelector('#viewport').getBoundingClientRect(); return { x: r.left + (x - v.cx) * v.zoom + r.width / 2, y: r.top + (y - v.cy) * v.zoom + r.height / 2 }; }, [x, y]);
  const clickAt = async (x, y) => { const s = await toS(x, y); await win.mouse.click(s.x, s.y); };
  const dragAt = async (pts) => { const s = await Promise.all(pts.map(p => toS(p[0], p[1]))); await win.mouse.move(s[0].x, s[0].y); await win.mouse.down(); for (const p of s.slice(1)) await win.mouse.move(p.x, p.y, { steps: 5 }); await win.mouse.up(); };
  // --- Pen: shape mode with curves
  await ev(() => { app.commands.setTool.run('pen'); app.opts.pen.mode = 'shape'; app.fg = '#d63a3a'; });
  await clickAt(100, 100); await dragAt([[300, 80], [380, 160]]); await clickAt(300, 300); await clickAt(100, 100);
  log('pen shape ->', await H(), JSON.stringify(await ev(() => ({ kind: app.doc.active.kind, shape: app.doc.active.data.shape, n: app.doc.active.data.subpaths[0].pts.length, closed: app.doc.active.data.subpaths[0].closed }))));
  // direct select drag anchor
  await ev(() => app.commands.setTool.run('directSelect'));
  await dragAt([[300, 300], [340, 360]]);
  log('direct ->', await H());
  // --- Pen: path mode
  await ev(() => { app.opts.pen.mode = 'path'; app.commands.setTool.run('pen'); app.doc.setActive(app.doc.layers[0].id); });
  await clickAt(500, 400); await clickAt(800, 400); await clickAt(800, 650); await clickAt(500, 650); await clickAt(500, 400);
  log('pen path ->', await H(), JSON.stringify(await ev(() => app.doc.paths.map(p => p.name + ':' + p.subpaths.length))));
  await ev(() => app.emit('show-panel', 'paths'));
  await ev(() => app.commands.pathToSelection.run());
  log('path->sel', await H(), JSON.stringify(await ev(() => app.doc.selBounds)));
  await ev(() => app.commands.selectionToPath.run(2));
  log('sel->path', await H());
  await ev(() => app.commands.newLayer.run());
  await ev(() => app.commands.fillPath.run());
  await ev(() => app.commands.strokePath.run('brush'));
  log('fill/stroke', await H());
  await ev(() => app.commands.addVectorMask.run('path'));
  log('vmask', await H(), await ev(() => !!app.doc.active.vmask));
  await shot('40-pen');
  // --- Smart objects
  await ev(() => { const d = app.doc; d.setActive(d.layers[0].id); app.commands.layerViaCopy.run(); });
  await ev(() => app.commands.convertToSmart.run());
  log('smart', await H(), await ev(() => app.doc.active.kind));
  await ev(() => app.commands.filterApply.run('gaussianBlur', { radius: 8 }));
  log('smart filter', await H(), JSON.stringify(await ev(() => app.doc.active.smartFilters)));
  await ev(() => app.commands.adjustmentApply.run('hueSaturation', { hue: 90, saturation: 0, lightness: 0, colorize: false }));
  await ev(() => { app.commands.setTool.run('move'); app.commands.freeTransform.run(); const t = app.transform; t.setNumeric({ sx: 0.5, sy: 0.5, angle: 0.3 }); t.commit(); });
  log('smart transform', await H());
  await ev(() => app.emit('show-panel', 'layers'));
  await win.waitForTimeout(400); await shot('41-smart');
  await ev(() => app.commands.editContents.run());
  await win.waitForTimeout(400);
  log('editing', await ev(() => app.doc.name), await ev(() => app.docs.length));
  await ev(() => { const d = app.doc; const L = d.layers[0]; const g = L.canvas.getContext('2d'); g.fillStyle = '#00ff00'; g.fillRect(0, 0, 300, 300); L.touch(true); d.commit('paint'); });
  await ev(() => app.commands.save.run());
  await win.waitForTimeout(400);
  log('after save contents', await ev(() => app.docs.map(d => d.name + ':' + d.history[d.hIndex].name).join(' | ')));
  await ev(() => { app.commands.close.run(); });
  await win.waitForTimeout(300);
  // --- PSD roundtrip with new things
  log('psd', JSON.stringify(await ev(async () => { const { savePsdBytes, openBytes } = await import('./js/doc/io.js'); const b = savePsdBytes(app.doc); const d2 = await openBytes(b, 'x.psd'); return d2.all().map(l => l.kind + (l.vmask ? '[v]' : '')); })));
  // --- Artboards
  await ev(() => app.commands.newArtboard.run({ x: 1050, y: 0, w: 400, h: 300, name: 'Phone', bg: '#ffffff' }));
  log('artboard', await H(), await ev(() => [app.doc.width, app.doc.height]));
  // --- Modes
  await ev(() => app.commands.proofColors.run());
  await win.waitForTimeout(300); await shot('42-proof');
  await ev(() => app.commands.proofColors.run());
  // --- Actions record + play
  await ev(() => { app.selectedAction = null; });
  await ev(async () => { app.actionSets[0].actions.push({ id: 'test1', name: 'Test', steps: [] }); app.recording = 'test1'; });
  await ev(() => app.commands.newLayer.run());
  await ev(() => app.commands.adjustmentApply.run('invert', {}));
  await ev(() => app.commands.selectAll.run());
  await ev(() => app.commands.actionStop.run());
  log('recorded', JSON.stringify(await ev(() => app.actionSets[0].actions.find(a => a.id === 'test1').steps.map(s => s.cmd))));
  const before = await ev(() => app.doc.history.length);
  await ev(() => app.commands.actionPlay.run('test1'));
  log('played', (await ev(() => app.doc.history.length)) - before, 'steps');
  await ev(() => app.emit('show-panel', 'actions')); await win.waitForTimeout(300); await shot('43-actions');
  // --- Timeline
  await ev(() => app.commands.framesFromLayers.run());
  await ev(() => app.commands.toggleTimeline.run());
  await win.waitForTimeout(500); await shot('44-timeline');
  log('frames', await ev(() => app.doc.frames.length));
  const gif = await ev(async () => { const { GIFEncoder, quantize, applyPalette } = await import('./vendor/gifenc.js'); const e = GIFEncoder(); const c = document.createElement('canvas'); c.width = 20; c.height = 20; const id = c.getContext('2d').getImageData(0, 0, 20, 20); const p = quantize(id.data, 16); e.writeFrame(applyPalette(id.data, p), 20, 20, { palette: p }); e.finish(); return e.bytes().length; });
  log('gif bytes', gif);
};
