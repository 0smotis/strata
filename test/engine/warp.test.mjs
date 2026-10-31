// Node tests for src/js/engine/warp.js
// Run: node test/engine/warp.test.mjs
import {
  makeImage, rasterizeTriangles, gridTris, buildPuppetMesh, PuppetSolver, homography, applyH, invertH,
  buildPerspectiveMap, renderPerspective, autoStraighten, enforceLocks, WARP_STYLES, warpStyleFn, presetNet,
  identityNet, fitWarpNet, evalNet, warpNetMesh, pickNet, dragNetSurface, resampleNet, triBoundary,
} from '../../src/js/engine/warp.js';

let failures = 0, passes = 0;
const check = (c, msg) => { if (c) passes++; else { failures++; console.log('  FAIL:', msg); } };
const section = (s) => console.log('-', s);
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

function img(w, h, fn) {
  const im = makeImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), o = (y * w + x) * 4; im.data[o] = c[0]; im.data[o + 1] = c[1]; im.data[o + 2] = c[2]; im.data[o + 3] = c.length > 3 ? c[3] : 255; }
  return im;
}
const photo = (w, h) => img(w, h, (x, y) => [(x * 7 + y * 3) % 256, (x * x + y) % 256, (y * 5) % 256]);
const blob = (w, h) => img(w, h, (x, y) => { const inside = (x - w * 0.35) ** 2 + (y - h * 0.5) ** 2 < (h * 0.3) ** 2 || (x > w * 0.5 && x < w * 0.9 && y > h * 0.42 && y < h * 0.58); return inside ? [200, 40, 40, 255] : [0, 0, 0, 0]; });
function maxDiff(a, b) { let m = 0; for (let i = 0; i < a.data.length; i++) m = Math.max(m, Math.abs(a.data[i] - b.data[i])); return m; }
function render(src, sol) { const out = makeImage(src.width, src.height); rasterizeTriangles(src, sol.q, sol.p, sol.tris, out, { order: sol.drawOrder(), triMask: sol.triMask }); return out; }

// ------------------------------------------------------------ rasterizer
section('rasterizer');
{
  const src = photo(64, 48), G = 8, n = (G + 1) * (G + 1), sp = new Float64Array(2 * n);
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) { sp[2 * (j * (G + 1) + i)] = i * 64 / G; sp[2 * (j * (G + 1) + i) + 1] = j * 48 / G; }
  const out = makeImage(64, 48); rasterizeTriangles(src, sp, sp, gridTris(G, G), out);
  check(maxDiff(src, out) === 0, 'identity grid render reproduces image exactly (got ' + maxDiff(src, out) + ')');
  // seams: translate by fractional offset, no pixel inside should be transparent
  const dp = sp.map((v, i) => v + (i & 1 ? 0.37 : 0.61));
  const o2 = makeImage(64, 48); rasterizeTriangles(src, sp, dp, gridTris(G, G), o2);
  let holes = 0; for (let y = 2; y < 46; y++) for (let x = 2; x < 62; x++) if (o2.data[(y * 64 + x) * 4 + 3] !== 255) holes++;
  check(holes === 0, 'no seams/holes between triangles (holes=' + holes + ')');
  // rotated grid (irrational coordinates) — still no holes and no double-hits (alpha 128 source)
  const semi = img(64, 48, () => [255, 255, 255, 128]);
  const a = 0.3, rp = sp.map((v, i) => { const k = i >> 1, x = sp[2 * k] - 32, y = sp[2 * k + 1] - 24; return i & 1 ? 24 + x * Math.sin(a) + y * Math.cos(a) : 32 + x * Math.cos(a) - y * Math.sin(a); });
  const o3 = makeImage(64, 48); rasterizeTriangles(semi, sp, rp, gridTris(G, G), o3, { aa: false });
  let bad = 0; for (let y = 18; y < 30; y++) for (let x = 26; x < 38; x++) if (Math.abs(o3.data[(y * 64 + x) * 4 + 3] - 128) > 1) bad++;
  check(bad === 0, 'rotated mesh: interior alpha exactly once (bad=' + bad + ')');
  check(triBoundary(gridTris(2, 2), 9).reduce((s, v) => s + v, 0) === 8, 'boundary edges of 2×2 grid = 8');
}

// ------------------------------------------------------------ puppet mesh
section('puppet mesh');
{
  const op = buildPuppetMesh(photo(120, 80), { density: 'normal' });
  check(op && op.opaque, 'opaque image → opaque mesh');
  let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
  for (let i = 0; i < op.verts.length; i += 2) { minx = Math.min(minx, op.verts[i]); maxx = Math.max(maxx, op.verts[i]); miny = Math.min(miny, op.verts[i + 1]); maxy = Math.max(maxy, op.verts[i + 1]); }
  check(minx === 0 && maxx === 120 && miny === 0 && maxy === 80, 'opaque mesh spans whole image');
  const fewer = buildPuppetMesh(photo(120, 80), { density: 'fewer' }), more = buildPuppetMesh(photo(120, 80), { density: 'more' });
  check(fewer.verts.length < op.verts.length && op.verts.length < more.verts.length, `density ordering (${fewer.verts.length / 2} < ${op.verts.length / 2} < ${more.verts.length / 2})`);
  const b = blob(160, 100), bm = buildPuppetMesh(b, { density: 'normal', expansion: 2 });
  check(bm && !bm.opaque, 'transparent layer mesh built');
  // every opaque pixel is covered by some triangle
  const sol = new PuppetSolver(bm); let unc = 0;
  for (let y = 0; y < 100; y += 2) for (let x = 0; x < 160; x += 2) if (b.data[(y * 160 + x) * 4 + 3] > 8 && !sol.locate(x + 0.5, y + 0.5, true)) unc++;
  check(unc === 0, 'mesh covers all opaque pixels (uncovered=' + unc + ')');
  // transparent far-away region not meshed
  check(!sol.locate(155, 5, true), 'far transparent corner not meshed');
  const big = buildPuppetMesh(b, { density: 'normal', expansion: 20 });
  check(big.tris.length > bm.tris.length, 'larger expansion → larger mesh');
  check(buildPuppetMesh(img(10, 10, () => [0, 0, 0, 0])) === null, 'empty layer → null');
}

// ------------------------------------------------------------ ARAP
section('ARAP');
{
  const src = blob(160, 100), mesh = buildPuppetMesh(src, { density: 'normal' });
  const sol = new PuppetSolver(mesh);
  sol.addPin(40, 50); sol.addPin(120, 50); sol.addPin(60, 30);
  sol.solve(30);
  let md = 0; for (let i = 0; i < sol.p.length; i++) md = Math.max(md, Math.abs(sol.p[i] - sol.q[i]));
  check(md < 1e-3, 'pins not moved → mesh unchanged (max dev ' + md.toExponential(2) + ')');
  check(maxDiff(render(src, sol), src) <= 1, 'pins not moved → render == input');

  // rigid motion of all pins → whole mesh moves rigidly
  for (const mode of ['rigid', 'normal', 'distort']) {
    const s2 = new PuppetSolver(mesh); s2.setMode(mode);
    const pins = [[40, 50], [120, 50], [60, 30]].map(([x, y]) => s2.addPin(x, y));
    const a = 0.6, tx = 15, ty = -8, R = (x, y) => [80 + (x - 80) * Math.cos(a) - (y - 50) * Math.sin(a) + tx, 50 + (x - 80) * Math.sin(a) + (y - 50) * Math.cos(a) + ty];
    for (let st = 1; st <= 10; st++) { for (const p of pins) { const [rx, ry] = s2.pinRest(p), aa = a * st / 10, c = Math.cos(aa), s = Math.sin(aa); p.x = 80 + (rx - 80) * c - (ry - 50) * s + tx * st / 10; p.y = 50 + (rx - 80) * s + (ry - 50) * c + ty * st / 10; } s2.solve(10); }
    s2.solve(100);
    let err = 0; for (let i = 0; i < s2.n; i++) { const [X, Y] = R(s2.q[2 * i], s2.q[2 * i + 1]); err = Math.max(err, Math.hypot(X - s2.p[2 * i], Y - s2.p[2 * i + 1])); }
    check(err < 0.05, `${mode}: rigid pin motion → rigid mesh (max err ${err.toFixed(4)})`);
  }

  // single pin → pure translation
  {
    const s3 = new PuppetSolver(mesh), p = s3.addPin(50, 50); p.x += 20; p.y += 7; s3.solve(5);
    let err = 0; for (let i = 0; i < s3.n; i++) err = Math.max(err, Math.hypot(s3.p[2 * i] - s3.q[2 * i] - 20, s3.p[2 * i + 1] - s3.q[2 * i + 1] - 7));
    check(err < 1e-3, 'single pin drag translates (err ' + err.toExponential(2) + ')');
  }

  // dumbbell: two blocks joined by a thin neck. Pin block A in place, rotate block B's pins rigidly
  // about the neck → both blocks must stay rigid, the neck absorbs the bend.
  const dumb = img(170, 100, (x, y) => ((x >= 10 && x < 60 && y >= 20 && y < 80) || (x >= 60 && x < 80 && y >= 44 && y < 56) || (x >= 80 && x < 150 && y >= 20 && y < 80)) ? [90, 160, 220, 255] : [0, 0, 0, 0]);
  const dm = buildPuppetMesh(dumb, { density: 'more', expansion: 0 });
  const procrustes = (s, sel) => { // best rigid fit residual of selected vertices
    let n = 0, qx = 0, qy = 0, px = 0, py = 0;
    for (const i of sel) { qx += s.q[2 * i]; qy += s.q[2 * i + 1]; px += s.p[2 * i]; py += s.p[2 * i + 1]; n++; }
    qx /= n; qy /= n; px /= n; py /= n; let C = 0, S = 0;
    for (const i of sel) { const ex = s.q[2 * i] - qx, ey = s.q[2 * i + 1] - qy, fx = s.p[2 * i] - px, fy = s.p[2 * i + 1] - py; C += ex * fx + ey * fy; S += ex * fy - ey * fx; }
    const a = Math.atan2(S, C), c = Math.cos(a), sn = Math.sin(a); let e = 0;
    for (const i of sel) { const ex = s.q[2 * i] - qx, ey = s.q[2 * i + 1] - qy; e = Math.max(e, Math.hypot(px + c * ex - sn * ey - s.p[2 * i], py + sn * ex + c * ey - s.p[2 * i + 1])); }
    return e;
  };
  const bend = (mode) => {
    const s = new PuppetSolver(dm); s.setMode(mode);
    s.addPin(25, 35); s.addPin(45, 65); const b1 = s.addPin(100, 35), b2 = s.addPin(130, 65);
    const R = (x, y, a) => [70 + (x - 70) * Math.cos(a) - (y - 50) * Math.sin(a), 50 + (x - 70) * Math.sin(a) + (y - 50) * Math.cos(a)];
    for (const [pin, rx, ry] of [[b1, 100, 35], [b2, 130, 65]]) [pin.x, pin.y] = R(rx, ry, -Math.PI / 4);
    s.solve(200);
    const A = [], B = [];
    for (let i = 0; i < s.n; i++) { const x = s.q[2 * i], y = s.q[2 * i + 1]; if (x <= 55) A.push(i); else if (x >= 88) B.push(i); }
    return { a: procrustes(s, A), b: procrustes(s, B), flips: countFlips(s) };
  };
  const countFlips = (s) => { let f = 0; for (let t = 0; t < s.m; t++) { const [a, b, c] = [s.tris[3 * t], s.tris[3 * t + 1], s.tris[3 * t + 2]]; const ar = (P) => (P[2 * b] - P[2 * a]) * (P[2 * c + 1] - P[2 * a + 1]) - (P[2 * b + 1] - P[2 * a + 1]) * (P[2 * c] - P[2 * a]); if (Math.sign(ar(s.p)) !== Math.sign(ar(s.q))) f++; } return f; };
  for (const mode of ['rigid', 'normal', 'distort']) {
    const r = bend(mode);
    console.log(`    ${mode}: block A rigid-fit err ${r.a.toFixed(2)}px, block B ${r.b.toFixed(2)}px, flips ${r.flips}`);
    if (mode === 'rigid') { check(r.a < 1.5 && r.b < 1.5, 'rigid: blocks stay rigid while the neck bends'); check(r.flips === 0, 'rigid: no flipped triangles'); }
  }
  // stretching: rigid resists area change more than distort
  const stretchDev = (mode) => {
    const s = new PuppetSolver(dm); s.setMode(mode); s.addPin(25, 50); const t = s.addPin(140, 50); t.x += 40; s.solve(150);
    let dev = 0; for (let k = 0; k < s.m; k++) { const [a, b, c] = [s.tris[3 * k], s.tris[3 * k + 1], s.tris[3 * k + 2]]; const ar = (P) => (P[2 * b] - P[2 * a]) * (P[2 * c + 1] - P[2 * a + 1]) - (P[2 * b + 1] - P[2 * a + 1]) * (P[2 * c] - P[2 * a]); dev += Math.abs(ar(s.p) / ar(s.q) - 1); }
    return dev / s.m;
  };
  const dr = stretchDev('rigid'), dn = stretchDev('normal'), dd = stretchDev('distort');
  console.log(`    stretch mean area change: rigid ${dr.toFixed(3)} normal ${dn.toFixed(3)} distort ${dd.toFixed(3)}`);
  check(dr < dn && dn < dd, 'area change ordering rigid < normal < distort');

  // limbs separated by a narrow transparent gap must not be bridged by the mesh
  {
    const legs = img(200, 200, (x, y) => { x *= 2; y *= 2; return ((y < 80 && x > 40 && x < 160) || (y >= 80 && ((x > 60 && x < 92) || (x > 108 && x < 140)))) ? [40, 160, 90, 255] : [0, 0, 0, 0]; });
    const lm = buildPuppetMesh(legs, { density: 'fewer', expansion: 2 });
    check(lm.spacing > 8, 'mesh spacing (' + lm.spacing.toFixed(1) + ') larger than the 8px gap');
    const s = new PuppetSolver(lm); s.setMode('rigid');
    // structural: no vertex is shared between pieces covering the left leg and pieces covering the right leg
    let bridged = 0;
    const side = new Array(s.m).fill(0);
    for (let t = 0; t < s.m; t++) for (let y = 52; y < 100; y += 1) for (let x = 25; x < 75; x += 1) {
      if (!legs.data[(y * 200 + x) * 4 + 3]) continue;
      const loc = s.locate(x + 0.5, y + 0.5, true); if (loc && loc.tri === t) side[t] |= x < 50 ? 1 : 2;
    }
    const vside = new Uint8Array(s.n); for (let t = 0; t < s.m; t++) for (let k = 0; k < 3; k++) vside[s.tris[3 * t + k]] |= side[t];
    for (let t = 0; t < s.m; t++) if (side[t] === 3) bridged++;
    for (let i = 0; i < s.n; i++) if (vside[i] === 3 && s.q[2 * i + 1] > 56) bridged++;
    check(bridged === 0, 'no triangle/vertex bridges the gap between legs (' + bridged + ')');
    s.addPin(35, 36); s.addPin(50, 36); s.addPin(65, 36); s.addPin(38, 95); const foot = s.addPin(62, 95);
    foot.x += 25; foot.y -= 15; s.solve(150);
    let other = 0; for (let i = 0; i < s.n; i++) if (s.q[2 * i] > 30 && s.q[2 * i] < 46 && s.q[2 * i + 1] > 60) other = Math.max(other, Math.hypot(s.p[2 * i] - s.q[2 * i], s.p[2 * i + 1] - s.q[2 * i + 1]));
    check(other < 3, 'moving one leg leaves the other leg in place (moved ' + other.toFixed(2) + 'px)');
    let unc = 0; for (let y = 0; y < 200; y += 3) for (let x = 0; x < 200; x += 3) if (legs.data[(y * 200 + x) * 4 + 3] && !s.locate(x + 0.5, y + 0.5, true)) unc++;
    check(unc === 0, 'split mesh still covers every opaque pixel');
    const s0 = new PuppetSolver(lm); s0.addPin(50, 15); s0.addPin(38, 95); s0.solve(10);
    check(maxDiff(render(legs, s0), legs) <= 1, 'split mesh renders identity exactly (' + maxDiff(render(legs, s0), legs) + ')');
  }
  // fixed-rotation pin
  {
    const s5 = new PuppetSolver(mesh); s5.setMode('rigid');
    const p = s5.addPin(110, 50); s5.setPinAngle(p, Math.PI / 4); s5.solve(50);
    check(Math.abs(s5.rotationAt(p) - Math.PI / 4) < 0.02, 'fixed pin angle rotates the mesh (' + s5.rotationAt(p).toFixed(3) + ')');
  }
  // depth ordering
  {
    const s6 = new PuppetSolver(mesh); const p1 = s6.addPin(40, 50), p2 = s6.addPin(130, 50);
    check(s6.drawOrder() === null, 'no depth → natural order');
    p2.depth = 1; const ord = s6.drawOrder();
    check(ord && ord.length === s6.m, 'depth → full order');
    const lastT = ord[ord.length - 1]; const cx = (s6.q[2 * s6.tris[3 * lastT]] + s6.q[2 * s6.tris[3 * lastT + 1]] + s6.q[2 * s6.tris[3 * lastT + 2]]) / 3;
    check(cx > 85, 'forward pin region drawn last');
    void p1;
  }
}

// ------------------------------------------------------------ homography / perspective
section('homography');
{
  const s = [[10, 20], [200, 15], [220, 180], [5, 160]], d = [[0, 0], [300, 40], [280, 260], [30, 220]];
  const H = homography(s, d);
  let e = 0; for (let i = 0; i < 4; i++) { const [x, y] = applyH(H, ...s[i]); e = Math.max(e, Math.abs(x - d[i][0]), Math.abs(y - d[i][1])); }
  check(e < 1e-8, 'homography maps corners exactly (' + e.toExponential(2) + ')');
  const Hi = invertH(H); const [x, y] = applyH(H, 77, 99), [bx, by] = applyH(Hi, x, y);
  check(near(bx, 77, 1e-8) && near(by, 99, 1e-8), 'inverse homography round-trips');
  // lines map to lines: midpoint of an edge stays on the dst edge
  const [mx, my] = applyH(H, (s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2);
  const cr = (d[1][0] - d[0][0]) * (my - d[0][1]) - (d[1][1] - d[0][1]) * (mx - d[0][0]);
  check(Math.abs(cr) < 1e-6, 'edge points stay on the edge');
}
section('perspective warp');
{
  const src = photo(120, 80);
  // identity
  const V = [[10, 10], [60, 10], [60, 70], [10, 70], [110, 15], [110, 65]];
  const planes = [[0, 1, 2, 3], [1, 4, 5, 2]];
  const id = buildPerspectiveMap(V, V.map(p => [...p]), planes);
  check(id.valid.length === 2, 'two valid planes');
  const o = renderPerspective(src, 1, id, makeImage(120, 80));
  check(maxDiff(o, src) <= 1, 'unwarped planes → identity render (diff ' + maxDiff(o, src) + ')');
  // warp: corners map exactly; shared edge continuous
  const D = V.map(p => [...p]); D[1] = [70, 0]; D[2] = [65, 75]; D[4] = [118, 30]; D[0] = [0, 5];
  const map = buildPerspectiveMap(V, D, planes);
  let ce = 0; for (const pl of planes) for (const i of pl) { const k = planes.indexOf(pl), r = map.planeMap(k, ...V[i]); ce = Math.max(ce, Math.hypot(r[0] - D[i][0], r[1] - D[i][1])); }
  check(ce < 1e-6, 'plane corners map exactly to warped corners (' + ce.toExponential(2) + ')');
  let seam = 0;
  for (let t = 0; t <= 1.0001; t += 0.05) { const x = 60, y = 10 + 60 * t, a = map.planeMap(0, x, y), b = map.planeMap(1, x, y); seam = Math.max(seam, Math.hypot(a[0] - b[0], a[1] - b[1])); }
  check(seam < 1e-6, 'shared edge maps identically from both planes (' + seam.toExponential(2) + ')');
  // continuity across the shared edge and from plane to outside region
  let jump = 0;
  for (let y = 12; y < 68; y += 4) { const a = map.mapPoint(60 - 1e-4, y), b = map.mapPoint(60 + 1e-4, y); jump = Math.max(jump, Math.hypot(a[0] - b[0], a[1] - b[1])); }
  for (let y = 12; y < 68; y += 4) { const a = map.mapPoint(10 + 1e-4, y), b = map.mapPoint(10 - 1e-4, y); jump = Math.max(jump, Math.hypot(a[0] - b[0], a[1] - b[1])); }
  check(jump < 0.01, 'map continuous across plane boundaries (' + jump.toExponential(2) + ')');
  // straighten
  const SV = [[0, 0], [100, 4], [6, 100], [100, 103]];
  const locks = autoStraighten(SV, [[0, 1], [0, 2], [1, 3], [2, 3]], 'both');
  check(locks.length === 4 && SV[0][0] === SV[2][0] && SV[0][1] === SV[1][1] && SV[1][0] === SV[3][0] && SV[2][1] === SV[3][1], 'auto straighten both');
  const L2 = [[0, 0], [5, 100]]; enforceLocks(L2, [{ a: 0, b: 1, axis: 'v' }], new Set([0]));
  check(L2[1][0] === 0 && L2[0][0] === 0, 'locks respect pinned vertex');
}

// ------------------------------------------------------------ bezier warp
section('bezier warp');
{
  const box = { x: 10, y: 5, w: 100, h: 60 };
  for (const N of [1, 3, 5]) {
    const net = identityNet(box, N); let e = 0;
    for (let j = 0; j <= 10; j++) for (let i = 0; i <= 10; i++) { const [x, y] = evalNet(net, N, i / 10, j / 10); e = Math.max(e, Math.abs(x - (10 + i * 10)), Math.abs(y - (5 + j * 6))); }
    check(e < 1e-9, `identity net N=${N} exact (${e.toExponential(2)})`);
  }
  const styles = WARP_STYLES.filter(Boolean).map(s => s[0]);
  check(styles.length === 16, '16 warp styles');
  for (const st of styles) {
    for (const vertical of [false, true]) {
      const net = presetNet(st, { bend: 0, vertical }, box), id = identityNet(box);
      let e = 0; for (let i = 0; i < net.length; i++) e = Math.max(e, Math.abs(net[i] - id[i]));
      if (e > 1e-9) check(false, `${st} bend 0 identity (${e})`); else passes++;
    }
    const bent = presetNet(st, { bend: 50 }, box), id = identityNet(box);
    let e = 0; for (let i = 0; i < bent.length; i++) e = Math.max(e, Math.abs(bent[i] - id[i]));
    if (st !== 'custom') check(e > 1, `${st} bend 50 deforms (${e.toFixed(2)})`);
  }
  // distortion alone works & corners follow a trapezoid
  const hd = warpStyleFn('arc', { bend: 0, hDist: 50 }, box);
  check(near(hd(0, 0)[1], 5 + 30 - 30 * 0.5) && near(hd(1, 0)[1], 5 + 30 - 30 * 1.5), 'horizontal distortion trapezoid');
  // arc bend sign: + bulges upward (corners lower than top-middle)
  const arc = warpStyleFn('arc', { bend: 50 }, box);
  check(arc(0, 0)[1] > arc(0.5, 0)[1], 'arc +bend bulges upward');
  // preset fit is close to the analytic function
  const fn = warpStyleFn('arch', { bend: 60 }, box), net = fitWarpNet(fn, 1); let fe = 0;
  for (let j = 0; j <= 8; j++) for (let i = 0; i <= 8; i++) { const a = fn(i / 8, j / 8), b = evalNet(net, 1, i / 8, j / 8); fe = Math.max(fe, Math.hypot(a[0] - b[0], a[1] - b[1])); }
  check(fe < 0.01, 'arch fits a single patch exactly (' + fe.toExponential(2) + ')');
  // identity render
  const src = photo(120, 80), b2 = { x: 0, y: 0, w: 120, h: 80 }, idn = identityNet(b2, 1), m = warpNetMesh(idn, 1, b2, 24);
  const out = makeImage(120, 80); rasterizeTriangles(src, m.sp, m.dp, m.tris, out);
  check(maxDiff(out, src) <= 1, 'identity warp render == input (' + maxDiff(out, src) + ')');
  // pick + drag surface
  const pk = pickNet(idn, 1, 30, 20);
  check(near(pk.u, 0.25, 1e-4) && near(pk.v, 0.25, 1e-4) && pk.dist < 1e-3, 'pickNet finds (u,v)');
  const dn = dragNetSurface(idn, 1, pk.u, pk.v, 10, -5), [nx, ny] = evalNet(dn, 1, pk.u, pk.v);
  check(near(nx, 40, 1e-6) && near(ny, 15, 1e-6), 'surface drag moves picked point exactly');
  const rs = resampleNet(presetNet('flag', { bend: 40 }, b2, 1), 1, 3);
  const [ax, ay] = evalNet(rs, 3, 0.4, 0.6), [bx, by] = evalNet(presetNet('flag', { bend: 40 }, b2, 1), 1, 0.4, 0.6);
  check(Math.hypot(ax - bx, ay - by) < 0.5, 'resample 1→3 patches preserves shape');
}

// ------------------------------------------------------------ perf
section('perf');
{
  const src = photo(1600, 1000);
  let t = performance.now(); const mesh = buildPuppetMesh(src, { density: 'more' }); const tm = performance.now() - t;
  const sol = new PuppetSolver(mesh); const pins = [[200, 200], [1400, 800], [800, 500]].map(([x, y]) => sol.addPin(x, y));
  pins[1].x += 150; pins[1].y -= 120;
  t = performance.now(); sol.solve(0); const tf = performance.now() - t;
  t = performance.now(); sol.iterate(20); const ti = (performance.now() - t) / 20;
  t = performance.now(); const out = render(src, sol); const tr = performance.now() - t;
  console.log(`    mesh ${mesh.verts.length / 2}v/${mesh.tris.length / 3}t ${tm.toFixed(0)}ms, factor+ASAP ${tf.toFixed(1)}ms, iter ${ti.toFixed(2)}ms, render 1600×1000 ${tr.toFixed(0)}ms`);
  check(ti < 20, 'ARAP iteration fast');
  void out;
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
