module.exports = async (win, OUT) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  await win.click('text=Web Large'); await win.waitForTimeout(400);
  await ev(() => { app.commands.setTool.run('brush'); const o = app.opts.brush; o.size = 40; o.hardness = 0.6; o.dynamics = { shapeOn: true, sizeJitter: 80, minDiameter: 10, angleJitter: 30, roundnessJitter: 50, minRoundness: 25, scatterOn: true, scatter: 200, count: 3, countJitter: 50, colorOn: true, fgbgJitter: 50, hueJitter: 30, satJitter: 0, brightJitter: 10, transferOn: true, opacityJitter: 40, flowJitter: 30 }; app.fg = '#e04020'; app.bg = '#2040e0'; app.emit('tool', 'brush'); app.emit('show-panel', 'brush'); });
  const b = await (await win.$('#viewport')).boundingBox();
  await win.mouse.move(b.x + 200, b.y + 300); await win.mouse.down();
  for (let i = 0; i < 40; i++) await win.mouse.move(b.x + 200 + i * 15, b.y + 300 + Math.sin(i / 4) * 80);
  await win.mouse.up(); await win.waitForTimeout(400);
  await ev(() => app.emit('show-panel', 'navigator')); await win.waitForTimeout(300);
  await win.screenshot({ path: OUT + '/50-dyn.png' });
  await ev(() => app.emit('show-panel', 'histogram')); await win.waitForTimeout(500);
  await win.screenshot({ path: OUT + '/51-hist.png' });
};
