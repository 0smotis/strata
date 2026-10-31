// E2E: Puppet Warp, Perspective Warp, Transform › Warp dialogs driven with real mouse/keyboard events.
// Run: xvfb-run -a node test/e2e/smoke.cjs test/e2e/warps.cjs
const fs = require('fs');
const SHOTS = process.env.WARP_SHOTS || '/tmp/claude-0/-home-claude/c8d4b7a6-6aff-57b5-a6bd-b2fe5a1f8788/scratchpad/warp-shots';
fs.mkdirSync(SHOTS, { recursive: true });

module.exports = async (win, OUT, errs) => {
  const ev = (f, ...a) => win.evaluate(f, ...a);
  const shot = async (n) => { await win.waitForTimeout(120); await win.screenshot({ path: SHOTS + '/' + n + '.png' }); };
  const log = (...a) => console.log('[warps]', ...a);
  const ok = (c, m) => { if (!c) { errs.push('assert: ' + m); console.log('  FAIL', m); } else console.log('  ok', m); };
  const M = win.mouse, K = win.keyboard;

  win.on('response', (r) => { if (r.status() >= 400) console.log('[warps] HTTP', r.status(), r.url()); });
  await ev(() => new Promise((res) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/warps.css'; l.onload = res; document.head.append(l);
  }));
  // test images
  await ev(() => {
    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d', { willReadFrequently: true }); return c; };
    // 1) transparent layer: a simple figure
    const fig = mk(700, 520), g = fig.getContext('2d');
    g.fillStyle = '#e0533d'; g.strokeStyle = '#7a1f12'; g.lineWidth = 4;
    g.beginPath(); g.arc(350, 110, 55, 0, 7); g.fill(); g.stroke();                 // head
    g.fillStyle = '#3d7be0'; g.fillRect(300, 165, 100, 170); g.strokeRect(300, 165, 100, 170); // torso
    g.fillStyle = '#f2b134'; g.fillRect(400, 180, 200, 36); g.strokeRect(400, 180, 200, 36);  // right arm
    g.fillRect(100, 180, 200, 36); g.strokeRect(100, 180, 200, 36);                          // left arm
    g.fillStyle = '#2f9e5b'; g.fillRect(305, 335, 38, 160); g.strokeRect(305, 335, 38, 160); g.fillRect(357, 335, 38, 160); g.strokeRect(357, 335, 38, 160); // legs
    g.fillStyle = '#fff'; g.font = 'bold 40px sans-serif'; g.fillText('S', 337, 265);
    // 2) opaque "photo" with grid
    const ph = mk(900, 600), p = ph.getContext('2d');
    const gr = p.createLinearGradient(0, 0, 900, 600); gr.addColorStop(0, '#2b5f9e'); gr.addColorStop(0.5, '#e8c45a'); gr.addColorStop(1, '#a0322a'); p.fillStyle = gr; p.fillRect(0, 0, 900, 600);
    p.strokeStyle = 'rgba(255,255,255,.85)'; p.lineWidth = 2; for (let x = 0; x <= 900; x += 50) { p.beginPath(); p.moveTo(x, 0); p.lineTo(x, 600); p.stroke(); } for (let y = 0; y <= 600; y += 50) { p.beginPath(); p.moveTo(0, y); p.lineTo(900, y); p.stroke(); }
    p.fillStyle = '#111'; p.font = 'bold 120px serif'; p.fillText('STRATA', 220, 340);
    // 3) "building" for perspective: two facades in perspective
    const bd = mk(1000, 640), b = bd.getContext('2d');
    b.fillStyle = '#9cc8ec'; b.fillRect(0, 0, 1000, 640); b.fillStyle = '#6b8e4e'; b.fillRect(0, 520, 1000, 120);
    const face = (q, col, nx, ny) => { b.fillStyle = col; b.beginPath(); q.forEach(([x, y], i) => i ? b.lineTo(x, y) : b.moveTo(x, y)); b.closePath(); b.fill(); b.strokeStyle = '#333'; b.lineWidth = 3; b.stroke();
      const L = (a, c, t) => [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]; b.strokeStyle = '#2a2a2a'; b.lineWidth = 2;
      for (let i = 1; i < nx; i++) { const t = i / nx, A = L(q[0], q[1], t), B = L(q[3], q[2], t); b.beginPath(); b.moveTo(...A); b.lineTo(...B); b.stroke(); }
      for (let j = 1; j < ny; j++) { const t = j / ny, A = L(q[0], q[3], t), B = L(q[1], q[2], t); b.beginPath(); b.moveTo(...A); b.lineTo(...B); b.stroke(); } };
    face([[200, 150], [520, 220], [520, 560], [200, 520]], '#d9b48a', 6, 6); // left facade
    face([[520, 220], [860, 120], [860, 540], [520, 560]], '#c78f62', 7, 6); // right facade
    window.__T = { fig, ph, bd };
  });
  const stageInfo = () => ev(() => { const c = document.querySelector('.wpx canvas.stage'); const s = c.__stage, r = c.getBoundingClientRect(); return { z: s.z, ox: s.ox, oy: s.oy, left: r.left, top: r.top, sw: r.width / s.W }; });
  let S;
  const P = (x, y) => ({ x: S.left + (x * S.z + S.ox) * S.sw, y: S.top + (y * S.z + S.oy) * S.sw });
  const drag = async (a, b, steps = 12, mods = []) => { for (const k of mods) await K.down(k); await M.move(a.x, a.y); await M.down(); await M.move(b.x, b.y, { steps }); await M.up(); for (const k of mods) await K.up(k); };
  const click = async (a, mods = []) => { for (const k of mods) await K.down(k); await M.click(a.x, a.y); for (const k of mods) await K.up(k); };
  const saveResult = (name) => ev(async (name) => {
    const r = await window.__res; if (!r) return null;
    const c = document.createElement('canvas'); c.width = r.width; c.height = r.height; c.getContext('2d').putImageData(r, 0, 0);
    let a = 0, n = 0; for (let i = 3; i < r.data.length; i += 4) { if (r.data[i]) n++; a += r.data[i]; }
    return { url: c.toDataURL('image/png'), w: r.width, h: r.height, opaque: n, name };
  }, name);
  const writePng = (r, n) => fs.writeFileSync(SHOTS + '/' + n + '.png', Buffer.from(r.url.split(',')[1], 'base64'));
  const open = async (fn, img) => { await ev(async ([fn, img]) => { const m = await import('./js/ui/warps.js'); window.__res = m[fn](window.__T[img]); }, [fn, img]); await win.waitForTimeout(500); S = await stageInfo(); };

  // ====================================================== Puppet Warp (transparent figure)
  log('puppet warp');
  await open('puppetWarpDialog', 'fig');
  await shot('p01-open-mesh');
  // pins: both feet, hips, neck, right hand, left hand
  for (const [x, y] of [[324, 480], [376, 480], [350, 300], [350, 175], [585, 198], [115, 198]]) await click(P(x, y));
  await shot('p02-pins');
  // raise the right arm (hand up) and lower the left
  await drag(P(585, 198), P(520, 40), 16);
  await drag(P(115, 198), P(170, 380), 16);
  await win.waitForTimeout(400);
  await shot('p03-arms');
  // bend a leg sideways
  await drag(P(376, 480), P(470, 455), 12);
  await win.waitForTimeout(400);
  await shot('p04-leg');
  // alt-click to remove the hip pin then re-add; Delete key removes selected
  await click(P(350, 300), ['Alt']);
  let np = await ev(() => document.querySelector('.wpx .info').textContent);
  ok(/5 pins/.test(np), 'alt-click removed a pin: ' + np);
  await click(P(350, 300)); await K.press('Delete');
  np = await ev(() => document.querySelector('.wpx .info').textContent);
  ok(/5 pins/.test(np), 'add + Delete key: ' + np);
  // rotate: select neck pin, alt-drag around it
  await click(P(350, 175));
  await K.down('Alt'); await M.move(P(350 + 40 / S.z, 175).x, P(0, 175).y); await M.down(); await M.move(P(350, 175 + 40 / S.z).x, P(350, 175 + 40 / S.z).y, { steps: 10 }); await M.up(); await K.up('Alt');
  await win.waitForTimeout(400);
  await shot('p05-rotate');
  const rot = await ev(() => [...document.querySelectorAll('.wpx .side select')].map(s => s.value));
  ok(rot.includes('fixed'), 'alt-drag sets fixed rotation: ' + rot.join(','));
  // mode switch + density change keep pins
  await ev(() => { const s = [...document.querySelectorAll('.wpx .side select')]; s[0].value = 'rigid'; s[0].dispatchEvent(new Event('change')); s[1].value = 'more'; s[1].dispatchEvent(new Event('change')); });
  await win.waitForTimeout(500);
  np = await ev(() => document.querySelector('.wpx .info').textContent);
  ok(/5 pins/.test(np), 'density change keeps pins: ' + np);
  await shot('p06-rigid-more');
  // pin depth forward on the raised hand, wheel zoom + space pan
  S = await stageInfo();
  await click(P(520, 40));
  await ev(() => document.querySelector('.wpx button[title^="Move pin depth forward"]').click());
  const z0 = (await stageInfo()).z;
  await M.move(P(350, 250).x, P(350, 250).y); await M.wheel(0, -240); await win.waitForTimeout(150);
  const z1 = (await stageInfo()).z; ok(z1 > z0 * 1.2, `wheel zooms in (${z0.toFixed(3)} → ${z1.toFixed(3)})`);
  S = await stageInfo(); const sp0 = P(350, 250);
  await K.down(' '); await M.move(sp0.x, sp0.y); await M.down(); await M.move(sp0.x - 120, sp0.y - 60, { steps: 5 }); await M.up(); await K.up(' ');
  const S2 = await stageInfo(); ok(Math.abs(S2.ox - S.ox + 120) < 2, 'space-drag pans');
  await shot('p06b-zoomed');
  await K.press('Control+0'); await win.waitForTimeout(100); S = await stageInfo();
  // hide mesh
  await ev(() => { const c = document.querySelector('.wpx .side input[type=checkbox]'); c.click(); });
  await shot('p07-nomesh');
  await K.press('Enter');
  let res = await saveResult('puppet');
  ok(res && res.w === 700 && res.h === 520, 'puppet result size matches input');
  if (res) writePng(res, 'p08-result');
  ok(await ev(() => !document.querySelector('.wpx')), 'dialog closed on Enter');

  // Esc cancels
  await open('puppetWarpDialog', 'fig');
  await click(P(350, 300)); await K.press('Escape');
  ok((await ev(async () => (await window.__res) === null)), 'Escape cancels puppet warp');

  // ====================================================== Puppet Warp (opaque photo)
  log('puppet warp opaque');
  await open('puppetWarpDialog', 'ph');
  for (const [x, y] of [[100, 100], [800, 100], [100, 500], [800, 500], [450, 300]]) await click(P(x, y));
  await drag(P(450, 300), P(560, 200), 14);
  await win.waitForTimeout(400);
  await shot('p10-photo');
  await K.press('Enter');
  res = await saveResult('puppet-photo'); if (res) writePng(res, 'p11-photo-result');
  ok(res && res.opaque > 900 * 600 * 0.85, 'opaque photo stays (mostly) opaque: ' + (res && res.opaque));

  // ====================================================== Perspective Warp
  log('perspective warp');
  await open('perspectiveWarpDialog', 'bd');
  // draw two planes roughly over the facades; second one starts near first's right edge (snap/join)
  await drag(P(200, 150), P(520, 540), 10);
  // adjust corners of plane 1 onto the facade
  await drag(P(520, 150), P(520, 220), 6); await drag(P(200, 540), P(200, 520), 6); await drag(P(520, 540), P(520, 560), 6);
  await drag(P(536, 236), P(860, 560), 10); // second plane: corners near existing vertices snap & merge
  await drag(P(860, 236), P(860, 120), 6); await drag(P(860, 560), P(860, 540), 6);
  await win.waitForTimeout(200);
  await shot('w01-layout');
  let inf = await ev(() => document.querySelector('.wpx .info').textContent);
  ok(/2 planes/.test(inf), 'two planes: ' + inf);
  await K.press('w');
  await win.waitForTimeout(200);
  await shot('w02-warpmode');
  // flatten: drag corners to make a frontal view
  await drag(P(200, 150), P(150, 150), 8); await drag(P(200, 520), P(150, 560), 8);
  await drag(P(860, 120), P(900, 150), 8); await drag(P(860, 540), P(900, 560), 8);
  await drag(P(520, 220), P(520, 150), 8);
  await win.waitForTimeout(300);
  await shot('w03-warped');
  // shift-click an edge to straighten it, then auto-straighten all
  await click(P(150 + 0.5 * (520 - 150), 150 + 0.5 * (150 - 150)), ['Shift']);
  await ev(() => document.querySelector('.wpx button[title^="Automatically straighten and level"]').click());
  await win.waitForTimeout(300);
  await shot('w04-straight');
  inf = await ev(() => document.querySelector('.wpx .info').textContent);
  ok(/straightened/.test(inf), 'straightened edges: ' + inf);
  await K.press('Enter');
  res = await saveResult('persp'); if (res) writePng(res, 'w05-result');
  ok(res && res.w === 1000 && res.h === 640, 'perspective result size');

  // ====================================================== Transform › Warp
  log('warp transform');
  await open('warpTransformDialog', 'ph');
  await shot('t01-open');
  // preset: Arc 50%
  await ev(() => { const s = document.querySelector('.wpx .side select'); s.value = 'arc'; s.dispatchEvent(new Event('change')); });
  await win.waitForTimeout(200); await shot('t02-arc');
  // drag the bend handle down (reduces / negative bend)
  await drag(P(450, 0), P(450, 120), 8);
  const bend = await ev(() => document.querySelector('.wpx .side input[type=number]').value);
  ok(Number(bend) < 50, 'bend handle drag changes bend: ' + bend);
  await shot('t03-arc-drag');
  for (const st of ['flag', 'fisheye', 'twist', 'shellLower', 'squeeze']) {
    await ev((st) => { const s = document.querySelector('.wpx .side select'); s.value = st; s.dispatchEvent(new Event('change')); const n = document.querySelector('.wpx .side input[type=number]'); n.value = 50; n.dispatchEvent(new Event('change')); }, st);
    await win.waitForTimeout(150); await shot('t04-' + st);
  }
  // vertical orientation + distortion
  await ev(() => { const s = document.querySelector('.wpx .side select'); s.value = 'arc'; s.dispatchEvent(new Event('change')); document.querySelector('.wpx button[title="Vertical warp orientation"]').click(); const r = document.querySelectorAll('.wpx .side input[type=range]'); r[1].value = 40; r[1].dispatchEvent(new Event('input')); });
  await win.waitForTimeout(200); await shot('t05-arc-vertical-hdist');
  // custom: reset, then drag a corner, a handle and the mesh surface
  await ev(() => [...document.querySelectorAll('.wpx button')].find(b => b.textContent === 'Reset').click());
  await drag(P(900, 0), P(820, 80), 8);            // top-right corner
  await drag(P(300, 600), P(260, 700), 8);         // bottom handle (1/3)
  await drag(P(450, 300), P(470, 230), 8);         // mesh surface
  const sty = await ev(() => document.querySelector('.wpx .side select').value);
  ok(sty === 'custom', 'direct manipulation = custom style');
  await shot('t06-custom');
  await ev(() => { const s = document.querySelectorAll('.wpx .side select')[1]; s.value = '4'; s.dispatchEvent(new Event('change')); });
  await win.waitForTimeout(150);
  await drag(P(450, 300), P(420, 340), 8);
  await shot('t07-grid4');
  await K.press('Enter');
  res = await saveResult('warp'); if (res) writePng(res, 't08-result');
  ok(res && res.w === 900 && res.h === 600, 'warp result size');

  // warp on transparent figure (bounds = content)
  await open('warpTransformDialog', 'fig');
  await ev(() => { const s = document.querySelector('.wpx .side select'); s.value = 'bulge'; s.dispatchEvent(new Event('change')); });
  await win.waitForTimeout(150); await shot('t09-fig-bulge');
  await K.press('Enter');
  res = await saveResult('warpfig'); if (res) writePng(res, 't10-fig-result');
  ok(res && res.w === 700, 'warp on transparent layer');
  // ====================================================== performance (large photo)
  log('perf 4000x3000');
  await ev(() => { const c = document.createElement('canvas'); c.width = 4000; c.height = 3000; const g = c.getContext('2d', { willReadFrequently: true }); const gr = g.createLinearGradient(0, 0, 4000, 3000); gr.addColorStop(0, '#264'); gr.addColorStop(1, '#fa4'); g.fillStyle = gr; g.fillRect(0, 0, 4000, 3000); window.__T.big = c; });
  let t0 = Date.now(); await open('puppetWarpDialog', 'big'); const tOpen = Date.now() - t0;
  for (const [x, y] of [[500, 500], [3500, 500], [2000, 2500], [2000, 1500]]) await click(P(x, y));
  const perf = await ev(() => { const s = document.querySelector('.wpx canvas.stage').__stage; const t = performance.now(); for (let i = 0; i < 5; i++) s.present(); return (performance.now() - t) / 5; });
  t0 = Date.now(); await drag(P(2000, 1500), P(2400, 1200), 30); const tDrag = (Date.now() - t0) / 30;
  t0 = Date.now(); await K.press('Enter'); await ev(async () => { await window.__res; }); const tFinal = Date.now() - t0;
  log(`puppet 4000x3000: open ${tOpen}ms, preview frame ${perf.toFixed(1)}ms, drag step ~${tDrag.toFixed(0)}ms, final ${tFinal}ms`);
  t0 = Date.now(); await open('warpTransformDialog', 'big');
  await ev(() => { const s = document.querySelector('.wpx .side select'); s.value = 'flag'; s.dispatchEvent(new Event('change')); });
  const wperf = await ev(() => { const s = document.querySelector('.wpx canvas.stage').__stage; const t = performance.now(); for (let i = 0; i < 5; i++) s.present(); return (performance.now() - t) / 5; });
  t0 = Date.now(); await K.press('Enter'); await ev(async () => { await window.__res; }); const wFinal = Date.now() - t0;
  log(`warp 4000x3000: preview frame ${wperf.toFixed(1)}ms, final ${wFinal}ms`);
  await open('perspectiveWarpDialog', 'big');
  await drag(P(500, 500), P(2000, 2500), 6); await drag(P(2000 + 30 / S.z, 500 + 30 / S.z), P(3500, 2500), 6); await K.press('w');
  await drag(P(3500, 500), P(3300, 800), 6);
  const pperf = await ev(() => { const s = document.querySelector('.wpx canvas.stage').__stage; const t = performance.now(); for (let i = 0; i < 5; i++) s.present(); return (performance.now() - t) / 5; });
  t0 = Date.now(); await K.press('Enter'); await ev(async () => { await window.__res; }); const pFinal = Date.now() - t0;
  log(`perspective 4000x3000: preview frame ${pperf.toFixed(1)}ms, final ${pFinal}ms`);
  log('done');
};
