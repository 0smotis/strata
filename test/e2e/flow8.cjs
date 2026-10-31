module.exports = async (win, OUT) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  await win.click('text=Web Large'); await win.waitForTimeout(400);
  await ev(() => { const g = app.doc.layers[0].canvas.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(600, 300, 600, 400); app.doc.layers[0].touch(true); app.commands.layerViaCopy.run(); });
  for (const c of ['warpTransform', 'puppetWarp', 'perspectiveWarp']) {
    ev((c) => app.commands[c].run(), c); await win.waitForTimeout(1500);
    await win.screenshot({ path: OUT + '/60-' + c + '.png' });
    await win.keyboard.press('Enter'); await win.waitForTimeout(1500);
    console.log(c, await ev(() => app.doc.history[app.doc.hIndex].name));
  }
};
