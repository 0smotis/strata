module.exports = async (win, OUT) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  await win.click('text=Web Large'); await win.waitForTimeout(400);
  await ev(() => { const g = app.doc.layers[0].canvas.getContext('2d'); const gr = g.createLinearGradient(0,0,1920,1080); gr.addColorStop(0,'#c96'); gr.addColorStop(1,'#346'); g.fillStyle = gr; g.fillRect(0,0,1920,1080); app.doc.layers[0].touch(true); });
  ev(() => app.commands.cameraRaw.run()); await win.waitForTimeout(2500);
  await win.screenshot({ path: OUT + '/80-raw.png' });
  await win.keyboard.press('Enter'); await win.waitForTimeout(4000);
  console.log('raw pixel ->', await ev(() => app.doc.history[app.doc.hIndex].name));
  await ev(() => { app.commands.layerViaCopy.run(); app.commands.convertToSmart.run(); });
  ev(() => app.commands.cameraRaw.run()); await win.waitForTimeout(2500);
  await win.keyboard.press('Enter'); await win.waitForTimeout(4000);
  console.log('raw smart ->', await ev(() => app.doc.history[app.doc.hIndex].name), JSON.stringify(await ev(() => (app.doc.active.smartFilters || []).map(f => f.type + ':' + !!f.params))));
};
