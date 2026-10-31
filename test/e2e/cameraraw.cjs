// E2E flow for the Camera Raw Filter dialog.
// Run: xvfb-run -a node test/e2e/smoke.cjs test/e2e/cameraraw.cjs
// Screenshots go to $RAW_SHOTS (default: scratchpad/raw-shots).
const fs = require('fs');
const SH = process.env.RAW_SHOTS || '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad/raw-shots';

module.exports = async (win, OUT, errs) => {
  fs.mkdirSync(SH, { recursive: true });
  const ev = (f, ...a) => win.evaluate(f, ...a);
  const shot = (n) => win.screenshot({ path: SH + '/' + n + '.png' });
  const wait = (ms) => win.waitForTimeout(ms);
  const log = (...a) => console.log('[raw]', ...a);
  let fails = 0;
  const check = (c, m) => { if (!c) { fails++; console.log('[raw] FAIL:', m); } else console.log('[raw] ok:', m); };

  // ---- document with a photo-like scene
  await ev(async () => {
    const { newDocument } = await import('./js/doc/document.js');
    const { addDoc } = await import('./js/commands.js');
    const W = 1800, H = 1200;
    const d = newDocument({ width: W, height: H, name: 'raw-test.psd' });
    const c = d.layers[0].canvas, g = c.getContext('2d');
    let gr = g.createLinearGradient(0, 0, 0, H * 0.6); gr.addColorStop(0, '#3d78c4'); gr.addColorStop(1, '#bcd7ef'); g.fillStyle = gr; g.fillRect(0, 0, W, H * 0.6);
    gr = g.createLinearGradient(0, H * 0.6, 0, H); gr.addColorStop(0, '#5b7d36'); gr.addColorStop(1, '#203414'); g.fillStyle = gr; g.fillRect(0, H * 0.6, W, H * 0.4);
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) { g.fillStyle = `rgba(${30 + rnd() * 70},${70 + rnd() * 90},${20 + rnd() * 40},.55)`; g.fillRect(rnd() * W, H * 0.6 + rnd() * H * 0.4, 2 + rnd() * 3, 4 + rnd() * 8); }
    g.fillStyle = '#fff8e8'; g.beginPath(); g.arc(W * 0.78, H * 0.18, 70, 0, 7); g.fill();
    g.fillStyle = '#d23a2f'; g.beginPath(); g.arc(W * 0.33, H * 0.62, 150, 0, 7); g.fill();
    g.fillStyle = '#f2c230'; g.fillRect(W * 0.52, H * 0.5, 220, 160);
    g.fillStyle = '#7a3bbf'; g.fillRect(W * 0.52 + 240, H * 0.5, 120, 160);
    g.fillStyle = '#111'; g.font = 'bold 64px sans-serif'; g.fillText('STRATA RAW', 80, 120);
    for (let x = 0; x < W; x += 60) { g.fillStyle = x % 120 ? '#222' : '#ddd'; g.fillRect(x, H - 40, 60, 40); }
    d.layers[0].touch(true); d.history = []; d.hIndex = -1; d.commit('Open');
    addDoc(d);
  });
  await wait(500);
  await ev(() => { localStorage.removeItem('strata.rawUI'); localStorage.removeItem('strata.rawPresets'); });
  await ev(() => { if (!document.querySelector('link[href="css/cameraraw.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/cameraraw.css'; document.head.append(l); } });

  const open = (settings) => ev(async (settings) => {
    const m = await import('./js/ui/cameraraw.js');
    window.__crRes = undefined; window.__crT = performance.now();
    m.cameraRawDialog(app.doc.render(true), settings ? { settings } : {}).then((r) => {
      if (!r) { window.__crRes = null; return; }
      const d = r.imageData.data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      window.__crRes = { w: r.imageData.width, h: r.imageData.height, isImageData: r.imageData instanceof ImageData, mean: s / (d.length / 4) / 3, settings: r.settings, ms: performance.now() - window.__crT };
    }).catch((e) => { window.__crRes = { error: String(e) }; });
  }, settings || null);
  const viewMean = () => ev(() => {
    const v = document.querySelector('.cr-canvas'), c = document.createElement('canvas'); c.width = v.width; c.height = v.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0);
    const d = g.getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.3), Math.round(c.width * 0.4), Math.round(c.height * 0.4)).data;
    let s = 0, sat = 0; for (let i = 0; i < d.length; i += 4) { s += d[i] + d[i + 1] + d[i + 2]; sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); }
    return { mean: s / (d.length / 4) / 3, sat: sat / (d.length / 4) };
  });
  const setSlider = (path, v) => ev(([p, v]) => {
    const r = document.querySelector(`.cr-sl[data-path="${p}"] input[type=range]`); if (!r) return false;
    r.value = v; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); return true;
  }, [path, v]);
  const openSection = (title) => ev((t) => {
    const h = [...document.querySelectorAll('.cr-shead')].find((x) => x.querySelector('.cr-stitle').textContent === t);
    if (!h) return false; if (!h.parentElement.classList.contains('open')) h.click(); h.scrollIntoView({ block: 'start' }); return true;
  }, title);
  const settle = async () => { for (let i = 0; i < 40; i++) { await wait(120); const b = await ev(() => document.querySelector('.cr-spin')?.classList.contains('hidden')); if (b) break; } await wait(100); };

  // ---- open
  const t0 = Date.now();
  await open();
  await wait(400); await settle();
  log('open+first preview ms', Date.now() - t0);
  check(await ev(() => !!document.querySelector('.modal.cr .cr-canvas')), 'dialog opened');
  await shot('01-open');
  const m0 = await viewMean();

  // ---- basic sliders update the preview
  check(await setSlider('exposure', 1), 'exposure slider exists');
  await settle();
  const m1 = await viewMean();
  check(m1.mean > m0.mean + 10, `exposure +1 brightens preview (${m0.mean.toFixed(1)} -> ${m1.mean.toFixed(1)})`);
  await setSlider('exposure', 0); await setSlider('saturation', -100); await settle();
  const m2 = await viewMean();
  check(m2.sat < 3, `saturation -100 greys the preview (sat ${m2.sat.toFixed(1)})`);
  await setSlider('saturation', 0);
  for (const [p, v] of [['temperature', 25], ['highlights', -60], ['shadows', 45], ['clarity', 30], ['vibrance', 35], ['contrast', 15], ['dehaze', 10]]) await setSlider(p, v);
  await settle();
  await shot('02-basic-edits');
  const vals = await ev(() => ['temperature', 'highlights', 'exposure'].map((p) => document.querySelector(`.cr-sl[data-path="${p}"] .cr-val`).value));
  check(vals[0] === '+25' && vals[1] === '-60' && vals[2] === '0.00', 'value fields show formatted values ' + vals.join(' '));
  check(await ev(() => document.querySelector('.modal.cr select').value) !== undefined, 'selects present');
  check(await ev(() => [...document.querySelectorAll('.cr-shead')][0].querySelector('.cr-dot').classList.contains('on')), 'Basic edited dot');
  const wb = await ev(() => { const s = [...document.querySelectorAll('.cr-sec')][0].querySelector('select'); return s.value; });
  check(wb === 'custom', 'moving Temperature sets WB to Custom (' + wb + ')');

  // ---- histogram + clipping warnings
  await win.keyboard.press('o'); await win.keyboard.press('u'); await wait(200);
  check(await ev(() => document.querySelector('.cr-tri.hi').classList.contains('on') && document.querySelector('.cr-tri.lo').classList.contains('on')), 'U/O toggle clipping warnings');
  await setSlider('exposure', 2.5); await settle(); await shot('03-clipping'); await setSlider('exposure', 0);
  await win.keyboard.press('o'); await win.keyboard.press('u'); await settle();

  // ---- sections
  for (const [t, n] of [['Curve', '04-curve'], ['Detail', '05-detail'], ['Color Mixer', '06-mixer'], ['Color Grading', '07-grading'], ['Optics', '08-optics'], ['Geometry', '09-geometry'], ['Effects', '10-effects']]) {
    check(await openSection(t), 'section ' + t);
    await wait(250);
    if (t === 'Curve') {
      // drag the parametric curve in the highlights region
      const box = await (await win.$('.cr-curvewrap canvas')).boundingBox();
      await win.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.2); await win.mouse.down(); await win.mouse.move(box.x + box.width * 0.88, box.y + box.height * 0.1, { steps: 4 }); await win.mouse.up();
      await settle();
      check(await ev(() => Number(document.querySelector('.cr-sl[data-path="parametric.highlights"] .cr-val').value) > 0), 'dragging parametric curve sets Highlights');
      await shot(n + 'a');
      await ev(() => document.querySelector('.cr-cm.w').click());
      await win.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6); await settle();
      check(await ev(() => document.querySelector('.cr-pointnote span').textContent.startsWith('Input')), 'click adds point to point curve');
      await win.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6); await win.mouse.down(); await win.mouse.move(box.x + box.width * 0.32, box.y + box.height * 0.52, { steps: 3 }); await win.mouse.up();
      await settle();
    }
    if (t === 'Detail') { await setSlider('sharpen.amount', 60); await setSlider('noise.color', 25); }
    if (t === 'Color Mixer') {
      await ev(() => [...document.querySelectorAll('.cr-tabs button')].find((b) => b.textContent === 'Saturation').click());
      await setSlider('hsl.saturation.5', -40); await setSlider('hsl.saturation.0', 30);
    }
    if (t === 'Color Grading') {
      const wh = await win.$$('.cr-wheel'); check(wh.length === 3, '3-way shows 3 wheels');
      const b = await wh[1].boundingBox(); // shadows
      await win.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5); await win.mouse.down(); await win.mouse.move(b.x + b.width * 0.25, b.y + b.height * 0.32, { steps: 4 }); await win.mouse.up();
      await settle();
    }
    if (t === 'Optics') { await setSlider('optics.vignette', 20); }
    if (t === 'Geometry') { await setSlider('geometry.rotate', 3); await ev(() => [...document.querySelectorAll('.cr-checks label')].find((l) => l.textContent.includes('Show grid')).click()); }
    if (t === 'Effects') { await setSlider('effects.vignetteAmount', -35); await setSlider('effects.grainAmount', 25); }
    await settle();
    await shot(n);
  }
  const st = await ev(() => document.querySelectorAll('.cr-dot.on').length);
  check(st >= 7, 'edited dots on most sections (' + st + ')');
  await ev(() => [...document.querySelectorAll('.cr-checks label')].find((l) => l.textContent.includes('Show grid')).click());
  // grading single view
  await openSection('Color Grading');
  await ev(() => [...document.querySelectorAll('.cr-gtabs button')].find((b) => b.title === 'Global').click()); await wait(200);
  check(await ev(() => document.querySelectorAll('.cr-wheel').length === 1 && !!document.querySelector('.cr-sl[data-path="grading.global.hue"]')), 'single grading view');
  await setSlider('grading.global.sat', 15); await setSlider('grading.global.hue', 40);
  await shot('11-grading-global');

  // ---- before/after
  await ev(() => document.activeElement && document.activeElement.blur());
  await win.keyboard.press('q'); await settle(); await shot('12-side-by-side');
  check(await ev(() => document.querySelector('.cr-root').dataset.mode) === 'side', 'Q -> side by side');
  await win.keyboard.press('q'); await settle(); await shot('13-split');
  await win.keyboard.press('q'); await settle(); await shot('14-topbottom');
  await win.keyboard.press('q'); await settle();
  check(await ev(() => document.querySelector('.cr-root').dataset.mode) === 'single', 'Q cycles back to single');
  const aft = await viewMean();
  await win.keyboard.press('\\'); await wait(200);
  const bef = await viewMean();
  check(Math.abs(aft.mean - bef.mean) > 1 || Math.abs(aft.sat - bef.sat) > 1, `\\ toggles before (after ${aft.mean.toFixed(1)}/${aft.sat.toFixed(1)}, before ${bef.mean.toFixed(1)}/${bef.sat.toFixed(1)})`);
  check(await ev(() => !document.querySelector('.cr-badge.l').classList.contains('hidden')), 'Before badge shown');
  await shot('15-before');
  await win.keyboard.press('\\'); await wait(200);

  // ---- zoom 100% (full-res region render)
  await win.keyboard.press('Control+Alt+0'); await settle(); await wait(500); await settle();
  const zl = await ev(() => document.querySelector('.cr-zoomlbl').textContent);
  check(zl === '100%', 'Ctrl+Alt+0 -> 100% (' + zl + ')');
  check(await ev(() => document.querySelector('.cr-note') && document.querySelector('.cr-note').classList.contains('hidden')), 'detail warning hidden at 100%');
  await shot('16-zoom100');
  // pan with drag
  const vb = await (await win.$('.cr-canvas')).boundingBox();
  await win.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2); await win.mouse.down(); await win.mouse.move(vb.x + vb.width / 2 - 200, vb.y + vb.height / 2 - 120, { steps: 6 }); await win.mouse.up();
  await settle(); await wait(300); await settle(); await shot('17-zoom100-panned');
  await win.keyboard.press('Control+0'); await settle();
  check(await ev(() => document.querySelector('.cr-zoomsel').value) === 'fit', 'Ctrl+0 -> fit');

  // ---- Alt-drag on Whites shows the clipping (threshold) view
  await openSection('Basic');
  const wr = await (await win.$('.cr-sl[data-path="whites"] input[type=range]')).boundingBox();
  await win.mouse.move(wr.x + wr.width / 2, wr.y + wr.height / 2);
  await win.keyboard.down('Alt'); await win.mouse.down(); await win.mouse.move(wr.x + wr.width * 0.8, wr.y + wr.height / 2, { steps: 4 }); await settle();
  const th = await viewMean(); await shot('16b-alt-whites');
  await win.mouse.up(); await win.keyboard.up('Alt'); await settle();
  const nm = await viewMean();
  check(th.mean < nm.mean * 0.6, `Alt-drag Whites shows clipping view (${th.mean.toFixed(1)} vs normal ${nm.mean.toFixed(1)})`);
  await setSlider('whites', 0); await settle();
  // ---- White Balance tool: click the blue sky -> warmer temperature
  await ev(() => document.activeElement && document.activeElement.blur());
  const tBefore = await ev(() => Number(document.querySelector('.cr-sl[data-path="temperature"] .cr-val').value));
  await win.keyboard.press('i'); await wait(100);
  const cb = await (await win.$('.cr-canvas')).boundingBox();
  await win.mouse.click(cb.x + cb.width * 0.5, cb.y + cb.height * 0.22); await settle();
  const tAfter = await ev(() => Number(document.querySelector('.cr-sl[data-path="temperature"] .cr-val').value));
  check(tAfter > tBefore + 10, `WB tool on blue sky warms (${tBefore} -> ${tAfter})`);
  await shot('16c-wb-tool');
  await win.keyboard.press('Control+z'); await win.keyboard.press('h'); await settle();
  // ---- Ctrl+wheel zoom
  await win.mouse.move(cb.x + cb.width * 0.4, cb.y + cb.height * 0.5);
  await win.keyboard.down('Control'); await win.mouse.wheel(0, -400); await win.keyboard.up('Control'); await settle();
  const zw = await ev(() => parseFloat(document.querySelector('.cr-zoomlbl').textContent));
  check(zw > 70, 'Ctrl+wheel zooms in (' + zw + '%)');
  await win.keyboard.press('Control+0'); await settle();

  // ---- alt: cancel becomes reset
  await win.keyboard.down('Alt'); await wait(100);
  check(await ev(() => document.querySelector('.cr-cancel').textContent) === 'Reset', 'Alt turns Cancel into Reset');
  await win.keyboard.up('Alt'); await wait(100);
  check(await ev(() => document.querySelector('.cr-cancel').textContent) === 'Cancel', 'releasing Alt restores Cancel');

  // ---- undo / redo
  const hueVal = () => ev(() => document.querySelector('.cr-sl[data-path="grading.global.hue"] .cr-val').value);
  await setSlider('grading.global.hue', 40); await setSlider('grading.global.hue', 77); await ev(() => document.activeElement && document.activeElement.blur());
  const h0 = await hueVal();
  await win.keyboard.press('Control+z'); await wait(250);
  const h1 = await hueVal();
  await win.keyboard.press('Control+Shift+z'); await wait(250);
  const h2 = await hueVal();
  check(h0 === '77' && h1 === '40' && h2 === '77', `Ctrl+Z / Ctrl+Shift+Z undo + redo (${h0} -> ${h1} -> ${h2})`);

  // ---- B&W toggle (V)
  const col = await viewMean();
  await win.keyboard.press('v'); await settle();
  const bw = await viewMean(); check(bw.sat < col.sat * 0.35, `V converts to B&W (sat ${col.sat.toFixed(1)} -> ${bw.sat.toFixed(1)}; colour grading still tints)`);
  await openSection('Color Mixer'); await wait(150);
  check(await ev(() => !!document.querySelector('.cr-sl[data-path="bwMix.5"]')), 'mixer becomes B&W Mix');
  await shot('18-bw');
  await win.keyboard.press('v'); await settle();

  // ---- presets pane
  await ev(() => document.querySelector('.cr-rail [data-id=presets]').click()); await wait(300);
  check(await ev(() => document.querySelectorAll('.cr-preset').length) >= 6, 'built-in presets listed');
  const pv = await win.$$('.cr-preset');
  const hb = await pv[1].boundingBox(); await win.mouse.move(hb.x + 40, hb.y + 10); await settle(); await shot('19-presets-hover');
  await pv[1].click(); await settle();
  check(await ev(() => document.querySelector('.cr-sl[data-path="vibrance"] .cr-val').value) === '+35', 'Vivid preset applied (vibrance +35)');
  // save a user preset (promptBox nested modal)
  await ev(() => { localStorage.removeItem('strata.rawPresets'); document.querySelector('.cr-presets .cr-edithead .ibtn').click(); });
  await wait(300);
  await win.keyboard.press('Control+a'); await win.keyboard.type('E2E Look'); await win.keyboard.press('Enter'); await wait(300);
  const saved = await ev(() => JSON.parse(localStorage.getItem('strata.rawPresets') || '[]'));
  check(saved.length === 1 && saved[0].name === 'E2E Look' && saved[0].settings.vibrance === 35, 'user preset saved to localStorage');
  check(await ev(() => !!document.querySelector('.modal.cr')), 'dialog still open after nested prompt');
  await shot('20-presets-saved');
  await ev(() => document.querySelector('.cr-rail [data-id=edit]').click()); await wait(200);

  // ---- OK -> full res render
  const tOk = Date.now();
  await ev(() => document.querySelector('.cr-ok').click());
  await wait(150); await shot('21-applying');
  for (let i = 0; i < 100; i++) { await wait(150); if (await ev(() => window.__crRes !== undefined)) break; }
  const res = await ev(() => window.__crRes);
  log('OK render ms', Date.now() - tOk, JSON.stringify(res && { w: res.w, h: res.h, mean: res.mean && res.mean.toFixed(1), keys: res.settings && Object.keys(res.settings).length }));
  check(res && res.isImageData && res.w === 1800 && res.h === 1200, 'OK returns full-size ImageData');
  check(res && res.settings && res.settings.vibrance === 35 && res.settings.effects, 'OK returns settings');
  check(await ev(() => !document.querySelector('.modal.cr')), 'dialog closed');

  // ---- reopen with previous settings, then cancel with Escape
  await open(res.settings); await wait(300); await settle();
  check(await ev(() => document.querySelector('.cr-sl[data-path="vibrance"] .cr-val').value) === '+35', 'opts.settings restores previous settings');
  await shot('22-reopen');
  await win.keyboard.press('Escape'); await wait(300);
  check(await ev(() => window.__crRes) === null && await ev(() => !document.querySelector('.modal.cr')), 'Escape cancels (null)');

  // ---- tiny / transparent canvas edge case
  const edge = await ev(async () => {
    const m = await import('./js/ui/cameraraw.js');
    const c = document.createElement('canvas'); c.width = 3; c.height = 2; const g = c.getContext('2d'); g.fillStyle = 'rgba(255,0,0,.5)'; g.fillRect(0, 0, 2, 2);
    const p = m.cameraRawDialog(c, { settings: { exposure: 1 } });
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector('.cr-ok').click();
    const r = await p; return r && [r.imageData.width, r.imageData.height, r.imageData.data[3], r.imageData.data[11]];
  });
  check(edge && edge[0] === 3 && edge[1] === 2 && edge[2] === 128 && edge[3] === 0, 'tiny canvas with alpha works ' + JSON.stringify(edge));
  // ---- the module worker itself loads and runs (not just the main-thread fallback)
  const wk = await ev(() => new Promise((res) => {
    const w = new Worker(new URL('./js/engine/raw.worker.js', location.href), { type: 'module' });
    const img = { data: new Uint8ClampedArray([100, 100, 100, 255, 200, 50, 50, 255]), width: 2, height: 1 };
    let prog = 0;
    w.onmessage = ({ data }) => { if ('progress' in data && !('ok' in data)) { prog++; return; } w.terminate(); res(data.ok ? { px: Array.from(data.result.data), prog } : { error: data.error }); };
    w.onerror = (e) => res({ error: String(e.message || e) });
    w.postMessage({ id: 1, op: 'apply', args: { img, settings: { exposure: 1 } } });
  }));
  check(wk && wk.px && wk.px[0] > 120 && wk.px[3] === 255 && wk.prog > 0, 'raw.worker.js runs as a module worker ' + JSON.stringify(wk));
  log(fails ? `${fails} FAILURES` : 'ALL CHECKS PASSED');
};
