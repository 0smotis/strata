module.exports = async (win, OUT) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  await win.click('text=Web Large'); await win.waitForTimeout(500);
  await ev(async () => { const { rectSel } = await import('./js/doc/selection.js'); const d = app.doc; d.setSelection(rectSel(d, { x: 400, y: 250, w: 160, h: 120 })); });
  await ev(() => app.commands.generativeFill.run(''));
  await win.waitForTimeout(800);
  console.log(JSON.stringify(await ev(() => ({ sel: !!app.doc.selection, qm: app.doc.quickMask, tool: app.tool, tr: !!app.transform }))));
  await win.screenshot({ path: OUT + '/20.png' });
};
