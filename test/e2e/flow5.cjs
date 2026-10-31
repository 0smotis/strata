module.exports = async (win) => {
  const r = await win.evaluate(async () => {
    const T = await import('./vendor/transformers/transformers.min.js');
    const ort = await import('./vendor/ort/ort.all.min.mjs');
    return { tf: typeof T.AutoModel, raw: typeof T.RawImage, ort: typeof ort.InferenceSession, coi: self.crossOriginIsolated, gpu: !!navigator.gpu };
  });
  console.log(JSON.stringify(r));
  await win.click('text=Web Large'); await win.waitForTimeout(400);
  await win.evaluate(() => app.commands.selectSubject.run());
  await win.waitForTimeout(1500);
  console.log(await win.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')));
};
