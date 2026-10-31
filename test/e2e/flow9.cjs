module.exports = async (win, OUT) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  await win.click('text=Web Large'); await win.waitForTimeout(400);
  await ev(() => { const g = app.doc.layers[0].canvas.getContext('2d'); const gr = g.createLinearGradient(0,0,1920,1080); gr.addColorStop(0,'#c96'); gr.addColorStop(1,'#346'); g.fillStyle = gr; g.fillRect(0,0,1920,1080); app.doc.layers[0].touch(true); });
  ev(() => app.commands.neuralFilters.run()); await win.waitForTimeout(2000);
  await win.screenshot({ path: OUT + '/70-neural.png' });
  await win.keyboard.press('Escape'); await win.waitForTimeout(500);
  console.log('neural closed ok', await ev(() => !!document.querySelector('.modal-bg')));
};
