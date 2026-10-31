// E2E for the Neural Filters workspace. Run: xvfb-run -a node test/e2e/smoke.cjs test/e2e/neural.cjs
// Uses skimage sample photos copied to the scratchpad (falls back to synthetic images if missing).
const fs = require('fs');
const path = require('path');
const SCR = '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad';
const SH = process.env.NF_SHOTS || SCR + '/neural-shots';
const IMG = SCR + '/neural-imgs/';
fs.mkdirSync(SH, { recursive: true });

module.exports = async (win, OUT, errs) => {
  const ev = (f, a) => win.evaluate(f, a);
  const shot = (n) => win.screenshot({ path: SH + '/' + n + '.png' });
  const log = (...a) => console.log('[neural]', ...a);
  const url = (n) => fs.existsSync(IMG + n) ? 'data:image/png;base64,' + fs.readFileSync(IMG + n).toString('base64') : null;
  let fails = 0; const check = (c, m) => { if (!c) { fails++; log('FAIL', m); } else log('ok', m); };

  await ev(async () => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/neural.css'; document.head.append(l);
    window.NF = await import('./js/ui/neural.js'); window.NE = await import('./js/ai/neural.js');
    window.__load = async (u, fallback) => {
      const c = document.createElement('canvas'); c.getContext('2d', { willReadFrequently: true });
      if (!u) { c.width = 900; c.height = 600; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 0, 600); gr.addColorStop(0, '#6aa6e0'); gr.addColorStop(1, '#3d6b2e'); g.fillStyle = gr; g.fillRect(0, 0, 900, 600); g.fillStyle = '#d9a483'; g.beginPath(); g.ellipse(450, 300, 120, 160, 0, 0, 7); g.fill(); return c; }
      const im = new Image(); im.src = u; await im.decode(); c.width = im.width; c.height = im.height; c.getContext('2d').drawImage(im, 0, 0); return c;
    };
  });
  await win.waitForTimeout(300);
  const open = (src, extra = [], prep = null) => ev(async ([src, extra, prep]) => {
    const c = await __load(src);
    if (prep) (new Function('c', prep))(c);
    const layers = []; for (const [n, u] of extra) layers.push({ id: n, name: n, canvas: await __load(u) });
    window.__src = c; window.__res = undefined;
    window.__p = NF.neuralFiltersDialog(c, { layers }).then(r => { window.__res = r ? { output: r.output, w: r.width, h: r.height, mask: r.mask ? r.mask.length : 0, len: r.imageData.data.length, diff: (() => { const a = r.imageData.data; if (r.width !== c.width) return -1; const b = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4); })() } : null; return r; });
  }, [src, extra, prep]);
  const idle = async (t = 180000) => { await win.waitForTimeout(200); await win.waitForFunction(() => document.querySelector('.nf-stage')?.dataset.state === 'idle', null, { timeout: t }); await win.waitForTimeout(150); };
  const toggle = async (id) => { await win.click(`.nf-item[data-id=${id}] .nf-sw`); await idle(); };
  const select = async (id) => { await win.click(`.nf-item[data-id=${id}]`); await win.waitForTimeout(100); };
  const slider = async (key, v) => { await ev(([k, v]) => { const r = document.querySelector(`.nf-set [data-key="${k}"] input[type=range]`); r.value = v; r.dispatchEvent(new Event('input')); }, [key, v]); await idle(); };
  const clickText = async (sel, text) => { await win.click(`${sel}:has-text("${text}")`); await win.waitForTimeout(100); };
  const stats = (x, y, w, h) => ev(([x, y, w, h]) => { // preview canvas region (fractions) mean/var/chroma
    const c = document.querySelector('.nf-canvas'), g = c.getContext('2d'); const X = Math.round(x * c.width), Y = Math.round(y * c.height), Wd = Math.max(1, Math.round(w * c.width)), Hd = Math.max(1, Math.round(h * c.height));
    const d = g.getImageData(X, Y, Wd, Hd).data; let m = [0, 0, 0], v = 0, ch = 0, n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { m[0] += d[i]; m[1] += d[i + 1]; m[2] += d[i + 2]; }
    m = m.map(a => a / n); for (let i = 0; i < d.length; i += 4) { const l = d[i + 1] - m[1]; v += l * l; ch += Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 2] - d[i + 1]); }
    let hf = 0, k = 0; for (let y = 1; y < Hd - 1; y++) for (let x = 1; x < Wd - 1; x++) { const o = (y * Wd + x) * 4 + 1; hf += Math.abs(4 * d[o] - d[o - 4] - d[o + 4] - d[o - Wd * 4] - d[o + Wd * 4]); k++; }
    return { mean: m.map(Math.round), v: Math.round(v / n), hf: +(hf / Math.max(1, k)).toFixed(2), chroma: +(ch / n).toFixed(1), cw: c.width, ch: c.height };
  }, [x, y, w, h]);
  const setText = () => ev(() => document.querySelector('.nf-set').innerText);
  const finish = async (ok = true) => { if (ok) await win.click('.modal.nf-modal .mf .btn.primary'); else await win.keyboard.press('Escape'); await win.waitForFunction(() => window.__res !== undefined, null, { timeout: 300000 }); return ev(() => window.__res); };
  const clickCanvas = async (fx, fy, opts) => { const b = await (await win.$('.nf-canvas')).boundingBox(); await win.mouse.click(b.x + fx * b.width, b.y + fy * b.height, opts); await idle(); };

  // ===================== 1. Portrait: skin smoothing, before/after, model errors =====================
  log('--- astronaut: skin smoothing');
  await open(url('astronaut.png'));
  await idle();
  await shot('01-open');
  const face0 = await stats(0.405, 0.235, 0.04, 0.035);
  await toggle('skinSmoothing');
  await slider('blur', 100);
  const face1 = await stats(0.405, 0.235, 0.04, 0.035), suit1 = await stats(0.3, 0.75, 0.1, 0.1);
  await shot('02-skin-smoothing');
  check(face1.hf < face0.hf * 0.75, `skin smoothed (face detail ${face0.hf} -> ${face1.hf})`);
  await win.click('.nf-tools .ibtn[title^="Show original"]'); await idle();
  await shot('03-show-original');
  const face2 = await stats(0.405, 0.235, 0.04, 0.035);
  check(Math.abs(face2.hf - face0.hf) < 0.05, 'before/after toggle shows original');
  await win.click('.nf-tools .ibtn[title^="Show original"]'); await idle();
  // model-backed filters fail gracefully here (huggingface.co is blocked in the sandbox)
  log('--- depth blur (real model, expect graceful failure)');
  await select('depthBlur'); await toggle('depthBlur');
  await win.waitForFunction(() => /Could not download|failed to run/.test(document.querySelector('.nf-set').innerText), null, { timeout: 120000 }).catch(() => { });
  await idle();
  const dtext = await setText();
  check(/Could not download the Depth model/.test(dtext), 'depth error banner: ' + dtext.split('\n').find(l => /Could not|failed/.test(l)));
  await shot('04-depth-model-error');
  await toggle('depthBlur');
  log('--- super zoom (real model, expect graceful failure + fallback)');
  await select('superZoom'); await toggle('superZoom');
  await win.waitForFunction(() => /Could not download|failed to run/.test(document.querySelector('.nf-set').innerText), null, { timeout: 120000 }).catch(() => { });
  await idle();
  check(/Could not download the Super Zoom ×2 model/.test(await setText()), 'super zoom error banner');
  check(await ev(() => document.querySelector('.nf-out select').disabled && document.querySelector('.nf-out select').value === 'newDocument'), 'super zoom forces New Document');
  await shot('05-superzoom-model-error');
  await clickText('.nf-alert .btn', 'Use standard upscaling'); await idle();
  await shot('06-superzoom-fallback-100');
  await toggle('superZoom');
  check(await ev(() => !document.querySelector('.nf-out select').disabled), 'output re-enabled');
  // JPEG artifacts: AI model unavailable -> falls back to deblocking (info, not error)
  await select('jpegArtifacts'); await toggle('jpegArtifacts');
  await win.click('.nf-tools .ibtn[title^="100%"]'); await idle();
  check(/standard deblocking/.test(await setText()), 'jpeg falls back to standard deblocking');
  await toggle('jpegArtifacts');
  await win.click('.nf-tools .ibtn[title^="Fit"]'); await idle();
  await ev(() => { const s = document.querySelector('.nf-out select'); s.value = 'newLayerMasked'; s.dispatchEvent(new Event('change')); });
  let r = await finish(true);
  log('result', JSON.stringify(r));
  check(r && r.output === 'newLayerMasked' && r.mask === 512 * 512 && r.w === 512 && r.diff > 0.3, 'OK returns imageData + mask');

  // ===================== 2. Colorize (grayscale photo) =====================
  log('--- camera: colorize');
  await open(url('camera.png'));
  await idle();
  await select('colorize');
  const pick = async (fx, fy, col) => { await clickCanvas(fx, fy); await ev((c) => { const i = document.querySelector('.nf-set input[type=color]'); i.value = c; i.dispatchEvent(new Event('input')); }, col); await idle(); };
  await pick(0.5, 0.06, '#5b8fd6');   // sky
  await pick(0.15, 0.93, '#6d9a3c');  // grass
  await pick(0.85, 0.85, '#7da347');  // grass (right)
  await pick(0.42, 0.55, '#4a3326');  // coat
  await pick(0.505, 0.255, '#c98f6c');  // face
  const sky = await stats(0.4, 0.03, 0.2, 0.06), grass = await stats(0.05, 0.88, 0.2, 0.08);
  log('colorize sky', JSON.stringify(sky), 'grass', JSON.stringify(grass));
  check(sky.mean[2] > sky.mean[0] + 10, 'sky turned blue');
  check(grass.mean[1] > grass.mean[2] + 8, 'grass turned green');
  await shot('07-colorize-points');
  await ev(() => { const s = document.querySelector('.nf-set select'); s.value = 'sepia'; s.dispatchEvent(new Event('change')); });
  await idle();
  await shot('08-colorize-profile');
  await finish(false);

  // ===================== 3. Photo restoration on a damaged old photo =====================
  log('--- camera: restoration');
  const damage = `const g=c.getContext('2d');const d=g.getImageData(0,0,c.width,c.height);let s=3;const R=()=>((s=(s*1103515245+12345)>>>0)/4294967296);
    for(let i=0;i<d.data.length;i+=4){const v=d.data[i]*0.55+70+(R()-0.5)*26;d.data[i]=v+18;d.data[i+1]=v+8;d.data[i+2]=v-6;}g.putImageData(d,0,0);
    g.strokeStyle='rgba(250,250,245,.95)';for(let k=0;k<9;k++){g.lineWidth=1+R()*1.5;g.beginPath();let x=R()*c.width,y=0;g.moveTo(x,y);while(y<c.height){x+=(R()-0.5)*14;y+=20;g.lineTo(x,y);}g.stroke();}
    g.fillStyle='rgba(20,20,20,.9)';for(let k=0;k<120;k++){g.fillRect(R()*c.width,R()*c.height,1+R()*2,1+R()*2);}`;
  await open(url('camera.png'), [], damage);
  await idle();
  await shot('09-restoration-before');
  await select('photoRestoration'); await toggle('photoRestoration');
  await shot('10a-restoration-default');
  await slider('scratch', 80); await slider('noise', 50);
  await shot('10-restoration-after');
  await finish(false);

  // ===================== 4. JPEG artifacts =====================
  log('--- astronaut q=0.08 jpeg: artifacts removal');
  await ev(async (u) => { const c = await __load(u); const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.08)); const fr = new FileReader(); window.__jpg = await new Promise(r => { fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); }, url('astronaut.png'));
  await ev(async () => { const c = await __load(window.__jpg); window.__res = undefined; window.__p = NF.neuralFiltersDialog(c, {}).then(r => window.__res = r ? { w: r.width } : null); });
  await idle();
  await win.click('.nf-tools .ibtn[title^="100%"]'); await idle();
  await shot('11-jpeg-before-100');
  await select('jpegArtifacts'); await toggle('jpegArtifacts');
  await ev(() => { const s = document.querySelector('.nf-set select'); s.value = 'high'; s.dispatchEvent(new Event('change')); });
  await idle();
  await shot('12-jpeg-after-100');
  await finish(false);

  // ===================== 5. Harmonization + Color Transfer + Style =====================
  log('--- coffee: harmonization / color transfer / style');
  await open(url('coffee_big.png'), [['Cat layer', url('chelsea.png')], ['Sunset', null]]);
  await idle();
  await select('harmonization'); await toggle('harmonization');
  await slider('strength', 100);
  await shot('13-harmonization');
  await toggle('harmonization');
  await select('colorTransfer'); await toggle('colorTransfer');
  const ct0 = await stats(0, 0, 1, 1);
  await shot('14-color-transfer-preset');
  await clickText('.nf-presets .pz', 'Moody Blue'); await idle();
  const ct1 = await stats(0, 0, 1, 1);
  check(ct1.mean[2] > ct1.mean[0] && ct0.mean[0] > ct0.mean[2], `presets change palette ${ct0.mean} -> ${ct1.mean}`);
  await shot('15-color-transfer-moody');
  await clickText('.nf-seg button', 'Image file');
  const fi = await win.$('.nf-set input[type=file]');
  await fi.setInputFiles(IMG + 'chelsea.png'); await win.waitForTimeout(500); await idle();
  await shot('16-color-transfer-file');
  await toggle('colorTransfer');
  await select('styleTransfer'); await toggle('styleTransfer');
  await shot('17-style-painting');
  for (const s of ['Watercolor', 'Comic', 'Ink Drawing']) { await clickText('.nf-styles button', s); await idle(); await shot('18-style-' + s.split(' ')[0].toLowerCase()); }
  await toggle('styleTransfer');
  await finish(false);

  // ===================== 6. Mocked models: Depth Blur + Super Zoom inference paths =====================
  log('--- mocked models');
  await ev(() => {
    window.__mockCalls = { sr: 0, depth: 0 };
    NE.__setPipelineFactory(async (task, id, opts) => {
      opts.progress_callback && opts.progress_callback({ status: 'progress', file: 'model.onnx', loaded: 5e6, total: 1e7 });
      if (task === 'depth-estimation') return async (raw) => { // synthetic depth: cat (centre-right) near, background far
        __mockCalls.depth++; const w = raw.width, h = raw.height, d = new Float32Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const e = ((x - 0.56 * w) / (0.3 * w)) ** 2 + ((y - 0.55 * h) / (0.5 * h)) ** 2; d[y * w + x] = (e < 1 ? 0.9 : 0.15) + 0.1 * y / h; }
        return { predicted_depth: { data: d, dims: [h, w] }, depth: null };
      };
      return async (raw) => { // "super-resolution": bicubic ×scale, padded to multiple of 8 like Swin2SR
        __mockCalls.sr++; const s = /x4/.test(id) ? 4 : 2, im = NE.fromRaw(raw), up = NE.resizeBicubic(im, im.width * s, im.height * s);
        const pw = Math.ceil(raw.width / 8) * 8 * s, ph = Math.ceil(raw.height / 8) * 8 * s, rgb = new Uint8ClampedArray(pw * ph * 3);
        for (let y = 0; y < up.height; y++) for (let x = 0; x < up.width; x++) { const a = (y * up.width + x) * 4, b = (y * pw + x) * 3; rgb[b] = up.data[a]; rgb[b + 1] = up.data[a + 1]; rgb[b + 2] = up.data[a + 2]; }
        return { data: rgb, width: pw, height: ph, channels: 3 };
      };
    });
  });
  await open(url('chelsea_big.png'));
  await idle();
  await select('depthBlur'); await toggle('depthBlur');
  await slider('blurStrength', 80);
  await clickCanvas(0.56, 0.45); // focus on the cat
  const fd = await ev(() => document.querySelector('.nf-set [data-key="focalDistance"] input[type=number]').value);
  check(Number(fd) < 30, 'focal point sets focal distance from depth: ' + fd);
  const bg = await stats(0.02, 0.05, 0.12, 0.25), cat = await stats(0.5, 0.4, 0.1, 0.1);
  await shot('19-depth-blur-mock');
  await win.click('.nf-tools .ibtn[title^="Show original"]'); await idle();
  const bg0 = await stats(0.02, 0.05, 0.12, 0.25), cat0 = await stats(0.5, 0.4, 0.1, 0.1);
  await win.click('.nf-tools .ibtn[title^="Show original"]'); await idle();
  check(bg.hf < bg0.hf * 0.65 && cat.hf > cat0.hf * 0.85, `background blurred (${bg0.hf}->${bg.hf}), subject sharp (${cat0.hf}->${cat.hf})`);
  await slider('haze', 60); await slider('grain', 30);
  await shot('20-depth-blur-haze-grain');
  await ev(() => { const c = [...document.querySelectorAll('.nf-set label')].find(l => /depth map only/.test(l.textContent)).querySelector('input'); c.click(); });
  await idle(); await shot('21-depth-map-only');
  await ev(() => { const c = [...document.querySelectorAll('.nf-set label')].find(l => /depth map only/.test(l.textContent)).querySelector('input'); c.click(); });
  await slider('haze', 0); await slider('grain', 0);
  await select('superZoom'); await toggle('superZoom');
  await shot('22-superzoom-mock-100');
  await win.click('.nf-tools .ibtn[title^="Fit"]'); await idle();
  await shot('23-superzoom-fit');
  r = await finish(true);
  log('result', JSON.stringify(r), JSON.stringify(await ev(() => window.__mockCalls)));
  check(r && r.output === 'newDocument' && r.w === 1353 * 2 && r.h === 1800, 'super zoom result is 2× new document');
  await ev(() => NE.__setPipelineFactory(null));

  const known = /Depth model unavailable|Super Zoom|JPEG artifacts model unavailable|huggingface|Failed to load resource|ERR_|net::|WebGPU Context Provider|status of 404/;
  const unexpected = errs.filter(e => !known.test(e));
  log('console messages:', errs.length, 'unexpected:', unexpected.length);
  unexpected.forEach(e => log('  ', e.slice(0, 300)));
  log(fails ? `${fails} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
};
