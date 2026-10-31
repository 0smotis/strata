// Warp geometry engine (pure math, no DOM) for Puppet Warp, Perspective Warp and Transform › Warp.
//  - rasterizeTriangles: seam-free piecewise-affine texture mapping (premultiplied bilinear, AA on open edges)
//  - buildPuppetMesh + PuppetSolver: triangle mesh over opaque pixels + As-Rigid-As-Possible solver
//    (local/global ARAP, Liu et al. 2008 / Sorkine & Alexa 2007 style, prefactored profile Cholesky)
//  - homography / perspective plane mapping with continuity across shared plane edges
//  - bicubic Bézier warp nets (N×N patches), warp style presets, least-squares net fitting
// Images are ImageData-like: { data: Uint8ClampedArray RGBA, width, height }.

export const makeImage = (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });

// ================================================================ rasterizer
// Per-edge flag (3 per triangle): 1 when the edge belongs to a single triangle (mesh boundary).
export function triBoundary(tris, nv) {
  const m = tris.length / 3, cnt = new Map(), flags = new Uint8Array(m * 3);
  const key = (a, b) => (a < b ? a * nv + b : b * nv + a);
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const K = key(tris[3 * t + k], tris[3 * t + (k + 1) % 3]); cnt.set(K, (cnt.get(K) || 0) + 1); }
  for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) flags[3 * t + k] = cnt.get(key(tris[3 * t + k], tris[3 * t + (k + 1) % 3])) === 1 ? 1 : 0;
  return flags;
}

// Texture-map triangles: vertex i samples src at (sp[2i], sp[2i+1]) and lands at (dp[2i], dp[2i+1]) in out.
// Coordinates are continuous pixel space (pixel x covers [x, x+1)). Shared edges are partitioned exactly
// (canonical edge functions + tie rule), so there are no seams or double-hits; boundary edges get
// 1px box-filter antialiasing when opts.aa. Triangles are composited source-over in opts.order.
// opts.mask (Uint8Array W*H): pixels touched get 1; with opts.skipMask, already-marked pixels are skipped.
// opts.triMask[t] ({x0,y0,w,h,bits,step} in source cells; source px = cells*step/triMaskScale) restricts
// triangle t to the source pixels of its cells (puppet mesh pieces).
export function rasterizeTriangles(src, sp, dp, tris, out, opts = {}) {
  const aa = opts.aa !== false, order = opts.order || null, mask = opts.mask || null, skipMask = !!opts.skipMask;
  const bnd = aa ? (opts.boundary || triBoundary(tris, sp.length / 2)) : null;
  const sw = src.width, sh = src.height, sd = src.data, W = out.width, H = out.height, od = out.data;
  const clip = opts.clip, triMask = opts.triMask || null, tmS = opts.triMaskScale || 1;
  const CX0 = clip ? Math.max(0, Math.floor(clip.x0)) : 0, CY0 = clip ? Math.max(0, Math.floor(clip.y0)) : 0;
  const CX1 = clip ? Math.min(W - 1, Math.ceil(clip.x1) - 1) : W - 1, CY1 = clip ? Math.min(H - 1, Math.ceil(clip.y1) - 1) : H - 1;
  const m = tris.length / 3;
  const E = new Float64Array(18); // per edge: xl, yl, dx, dy, s, il
  const EB = new Uint8Array(3);
  for (let n = 0; n < m; n++) {
    const t = order ? order[n] : n;
    const i0 = tris[3 * t], i1 = tris[3 * t + 1], i2 = tris[3 * t + 2];
    const ax = dp[2 * i0], ay = dp[2 * i0 + 1], bx = dp[2 * i1], by = dp[2 * i1 + 1], cx = dp[2 * i2], cy = dp[2 * i2 + 1];
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!(Math.abs(area) > 1e-10)) continue;
    const ia = 1 / area, sg = area > 0 ? 1 : -1;
    const lbx = (cy - ay) * ia, lby = -(cx - ax) * ia, lb0 = (-ax * (cy - ay) + ay * (cx - ax)) * ia;
    const lcx = -(by - ay) * ia, lcy = (bx - ax) * ia, lc0 = (-(bx - ax) * ay + (by - ay) * ax) * ia;
    const sax = sp[2 * i0], say = sp[2 * i0 + 1];
    const dbx = sp[2 * i1] - sax, dby = sp[2 * i1 + 1] - say, dcx = sp[2 * i2] - sax, dcy = sp[2 * i2 + 1] - say;
    const Ax = lbx * dbx + lcx * dcx, Bx = lby * dbx + lcy * dcx, Cx = sax + lb0 * dbx + lc0 * dcx - 0.5;
    const Ay = lbx * dby + lcx * dcy, By = lby * dby + lcy * dcy, Cy = say + lb0 * dby + lc0 * dcy - 0.5;
    let anyB = 0;
    for (let k = 0; k < 3; k++) {
      const u = tris[3 * t + k], w = tris[3 * t + (k + 1) % 3];
      const lo = u < w ? u : w, hi = u < w ? w : u, o = k * 6;
      E[o] = dp[2 * lo]; E[o + 1] = dp[2 * lo + 1]; E[o + 2] = dp[2 * hi] - E[o]; E[o + 3] = dp[2 * hi + 1] - E[o + 1];
      E[o + 4] = u === lo ? sg : -sg; E[o + 5] = 1 / (Math.hypot(E[o + 2], E[o + 3]) || 1);
      EB[k] = bnd ? bnd[3 * t + k] : 0; anyB |= EB[k];
    }
    const tm = triMask ? triMask[t] : null, tmK = tm ? 1 / (tmS * tm.step) : 0;
    const pad = anyB ? 1 : 0;
    const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), miny = Math.min(ay, by, cy), maxy = Math.max(ay, by, cy);
    const x0 = Math.max(CX0, Math.ceil(minx - 0.5 - pad)), x1 = Math.min(CX1, Math.floor(maxx - 0.5 + pad));
    const y0 = Math.max(CY0, Math.ceil(miny - 0.5 - pad)), y1 = Math.min(CY1, Math.floor(maxy - 0.5 + pad));
    if (x0 > x1 || y0 > y1) continue;
    const xl0 = E[0], yl0 = E[1], dx0 = E[2], dy0 = E[3], s0 = E[4], il0 = E[5], b0 = EB[0];
    const xl1 = E[6], yl1 = E[7], dx1 = E[8], dy1 = E[9], s1 = E[10], il1 = E[11], b1 = EB[1];
    const xl2 = E[12], yl2 = E[13], dx2 = E[14], dy2 = E[15], s2 = E[16], il2 = E[17], b2 = EB[2];
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      const r0 = dx0 * (py - yl0), r1 = dx1 * (py - yl1), r2 = dx2 * (py - yl2);
      const rowOff = y * W;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        let cov = 1;
        const e0 = s0 * (r0 - dy0 * (px - xl0));
        if (b0) { const d = e0 * il0; if (d < -0.5) continue; if (d < 0.5) cov *= d + 0.5; } else if (e0 < 0 || (e0 === 0 && s0 < 0)) continue;
        const e1 = s1 * (r1 - dy1 * (px - xl1));
        if (b1) { const d = e1 * il1; if (d < -0.5) continue; if (d < 0.5) cov *= d + 0.5; } else if (e1 < 0 || (e1 === 0 && s1 < 0)) continue;
        const e2 = s2 * (r2 - dy2 * (px - xl2));
        if (b2) { const d = e2 * il2; if (d < -0.5) continue; if (d < 0.5) cov *= d + 0.5; } else if (e2 < 0 || (e2 === 0 && s2 < 0)) continue;
        const pi = rowOff + x;
        if (mask) { if (skipMask && mask[pi]) continue; mask[pi] = 1; }
        let sx = Ax * px + Bx * py + Cx, sy = Ay * px + By * py + Cy;
        if (sx < -1.5 || sy < -1.5 || sx > sw + 0.5 || sy > sh + 0.5) continue;
        if (tm) { const mx = Math.floor((sx + 0.5) * tmK) - tm.x0, my = Math.floor((sy + 0.5) * tmK) - tm.y0; if (mx < 0 || my < 0 || mx >= tm.w || my >= tm.h || !tm.bits[my * tm.w + mx]) continue; }
        sx = sx < 0 ? 0 : sx > sw - 1 ? sw - 1 : sx; sy = sy < 0 ? 0 : sy > sh - 1 ? sh - 1 : sy;
        const qx = sx | 0, qy = sy | 0, fx = sx - qx, fy = sy - qy;
        const qx1 = qx + 1 < sw ? qx + 1 : qx, qy1 = qy + 1 < sh ? qy + 1 : qy;
        const o00 = (qy * sw + qx) * 4, o10 = (qy * sw + qx1) * 4, o01 = (qy1 * sw + qx) * 4, o11 = (qy1 * sw + qx1) * 4;
        const w00 = (1 - fx) * (1 - fy) * sd[o00 + 3], w10 = fx * (1 - fy) * sd[o10 + 3], w01 = (1 - fx) * fy * sd[o01 + 3], w11 = fx * fy * sd[o11 + 3];
        const A = w00 + w10 + w01 + w11;
        if (A < 0.01) continue;
        const iA = 1 / A;
        const r = (sd[o00] * w00 + sd[o10] * w10 + sd[o01] * w01 + sd[o11] * w11) * iA;
        const g = (sd[o00 + 1] * w00 + sd[o10 + 1] * w10 + sd[o01 + 1] * w01 + sd[o11 + 1] * w11) * iA;
        const b = (sd[o00 + 2] * w00 + sd[o10 + 2] * w10 + sd[o01 + 2] * w01 + sd[o11 + 2] * w11) * iA;
        const sa = A * cov, oi = pi * 4, da = od[oi + 3];
        if (da === 0 || sa >= 254.5) { od[oi] = r; od[oi + 1] = g; od[oi + 2] = b; od[oi + 3] = sa; }
        else {
          const a1 = sa / 255, d1 = (da / 255) * (1 - a1), oa = a1 + d1, k = 1 / oa;
          od[oi] = (r * a1 + od[oi] * d1) * k; od[oi + 1] = (g * a1 + od[oi + 1] * d1) * k; od[oi + 2] = (b * a1 + od[oi + 2] * d1) * k; od[oi + 3] = oa * 255;
        }
      }
    }
  }
  return out;
}

// Regular grid of (S+1)×(S+1) vertices → triangle index list (2 per cell, alternating diagonals).
export function gridTris(cols, rows) {
  const tris = new Int32Array(cols * rows * 6); let k = 0;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
    if ((i + j) & 1) { tris[k++] = a; tris[k++] = b; tris[k++] = d; tris[k++] = a; tris[k++] = d; tris[k++] = c; }
    else { tris[k++] = a; tris[k++] = b; tris[k++] = c; tris[k++] = b; tris[k++] = d; tris[k++] = c; }
  }
  return tris;
}

// ================================================================ puppet mesh
export const PUPPET_DENSITY = { fewer: 110, normal: 280, more: 700 };

// Triangle mesh over pixels with alpha > threshold (dilated/eroded by `expansion` px).
// Fully opaque images get a mesh exactly covering the image rectangle.
// Returns { verts: Float64Array (x,y)*, tris: Int32Array, spacing, opaque } or null when empty.
export function buildPuppetMesh(img, { density = 'normal', expansion = 2, threshold = 8, maxVerts = 3000 } = {}) {
  const W = img.width, H = img.height, d = img.data;
  let area = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > threshold) area++;
  if (!area) return null;
  const opaque = area === W * H;
  const target = PUPPET_DENSITY[density] || PUPPET_DENSITY.normal;
  let s = Math.sqrt(area / (target * 0.866));
  s = Math.max(s, Math.sqrt(area / (maxVerts * 0.866)), 3);
  s = Math.min(s, Math.max(4, Math.max(W, H) / 3));
  // coarse mask (max-pooled) with expansion
  const step = Math.max(1, Math.floor(s / 8)), cw = Math.ceil(W / step), ch = Math.ceil(H / step);
  let cell = new Uint8Array(cw * ch);
  if (opaque) cell.fill(1);
  else for (let y = 0; y < H; y++) { const cy = (y / step) | 0, ro = y * W; for (let x = 0; x < W; x++) if (d[(ro + x) * 4 + 3] > threshold) cell[cy * cw + ((x / step) | 0)] = 1; }
  if (!opaque && expansion) {
    const outside = expansion > 0;
    // chamfer distance (in px) from cells of the other class
    const dist = new Float32Array(cw * ch);
    const INF = 1e9, a = step, b = step * Math.SQRT2;
    for (let i = 0; i < dist.length; i++) dist[i] = (outside ? cell[i] : !cell[i]) ? 0 : INF;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = y * cw + x; let v = dist[i]; if (!v) continue;
      if (x > 0) v = Math.min(v, dist[i - 1] + a);
      if (y > 0) { v = Math.min(v, dist[i - cw] + a); if (x > 0) v = Math.min(v, dist[i - cw - 1] + b); if (x < cw - 1) v = Math.min(v, dist[i - cw + 1] + b); }
      if (!outside && (x === 0 || y === 0 || x === cw - 1 || y === ch - 1)) v = Math.min(v, a);
      dist[i] = v;
    }
    for (let y = ch - 1; y >= 0; y--) for (let x = cw - 1; x >= 0; x--) {
      const i = y * cw + x; let v = dist[i]; if (!v) continue;
      if (x < cw - 1) v = Math.min(v, dist[i + 1] + a);
      if (y < ch - 1) { v = Math.min(v, dist[i + cw] + a); if (x < cw - 1) v = Math.min(v, dist[i + cw + 1] + b); if (x > 0) v = Math.min(v, dist[i + cw - 1] + b); }
      dist[i] = v;
    }
    const nc = new Uint8Array(cw * ch), e = Math.abs(expansion);
    for (let i = 0; i < nc.length; i++) nc[i] = outside ? (cell[i] || dist[i] <= e ? 1 : 0) : (cell[i] && dist[i] > e ? 1 : 0);
    cell = nc;
  }
  // bounds of expanded cells
  let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (cell[y * cw + x]) { bx0 = Math.min(bx0, x * step); by0 = Math.min(by0, y * step); bx1 = Math.max(bx1, (x + 1) * step); by1 = Math.max(by1, (y + 1) * step); }
  if (bx1 <= bx0) return null;
  bx1 = Math.min(W, bx1); by1 = Math.min(H, by1);
  if (opaque) { bx0 = 0; by0 = 0; bx1 = W; by1 = H; }
  // triangular lattice aligned to the bounds
  const nrows = Math.max(1, Math.round((by1 - by0) / (s * 0.866))), hs = (by1 - by0) / nrows;
  const ncols = Math.max(1, Math.round((bx1 - bx0) / s)), sx = (bx1 - bx0) / ncols;
  const vx = [], vy = [], rows = [];
  for (let j = 0; j <= nrows; j++) {
    const y = by0 + j * hs, row = [];
    const add = (x) => { row.push(vx.length); vx.push(x); vy.push(y); };
    if (j & 1) { add(bx0); for (let k = 0; k < ncols; k++) add(bx0 + sx / 2 + k * sx); add(bx1); }
    else for (let k = 0; k <= ncols; k++) add(bx0 + k * sx);
    rows.push(row);
  }
  const T = [];
  for (let j = 0; j < nrows; j++) {
    const A = rows[j], B = rows[j + 1]; let i = 0, k = 0;
    while (i < A.length - 1 || k < B.length - 1) {
      const advA = k >= B.length - 1 || (i < A.length - 1 && vx[A[i + 1]] < vx[B[k + 1]] - 1e-9);
      if (advA) { T.push(A[i], B[k], A[i + 1]); i++; } else { T.push(A[i], B[k], B[k + 1]); k++; }
    }
  }
  // Opaque layers: the plain lattice. Otherwise every lattice triangle is split into "pieces", one per
  // connected component of mask cells inside it, and vertices are duplicated wherever the pieces around
  // them don't connect — so limbs separated by a transparent gap move independently (outline-conforming
  // behavior) even when one lattice triangle spans the gap. Pieces of split triangles carry a cell mask.
  if (opaque) {
    return { verts: Float64Array.from(vx.flatMap((x, i) => [x, vy[i]])), tris: Int32Array.from(T), spacing: Math.max(sx, hs / 0.866), opaque, triMask: null, step };
  }
  const hd = step * 0.7072, pieces = []; // {t (lattice tri index), cells: Set, mask}
  const triPieces = new Map(); // lattice tri → [piece idx]
  for (let t = 0; t < T.length / 3; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    const ax = vx[a], ay = vy[a], bx = vx[b], by = vy[b], cx = vx[c], cy = vy[c];
    const ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), sg = ar > 0 ? 1 : -1;
    const ed = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]].map(([x0, y0, x1, y1]) => { const L = Math.hypot(x1 - x0, y1 - y0) || 1; return [x0, y0, (x1 - x0) / L, (y1 - y0) / L]; });
    const gx0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - hd) / step)), gx1 = Math.min(cw - 1, Math.floor((Math.max(ax, bx, cx) + hd) / step));
    const gy0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - hd) / step)), gy1 = Math.min(ch - 1, Math.floor((Math.max(ay, by, cy) + hd) / step));
    const inside = new Set();
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
      if (!cell[gy * cw + gx]) continue;
      const px = (gx + 0.5) * step, py = (gy + 0.5) * step;
      let ok = true;
      for (const [x0, y0, ux, uy] of ed) if (sg * (ux * (py - y0) - uy * (px - x0)) < -hd) { ok = false; break; }
      if (ok) inside.add(gy * cw + gx);
    }
    if (!inside.size) continue;
    // local 8-connected components
    const list = [];
    for (const c0 of inside) {
      if (list.some(s => s.has(c0))) continue;
      const comp = new Set([c0]), st = [c0];
      while (st.length) {
        const q = st.pop(), qx = q % cw, qy = (q / cw) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx, ny = qy + dy, n = ny * cw + nx;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch || comp.has(n) || !inside.has(n)) continue;
          comp.add(n); st.push(n);
        }
      }
      list.push(comp);
    }
    triPieces.set(t, list.map(cells => { pieces.push({ t, cells, split: list.length > 1 }); return pieces.length - 1; }));
  }
  if (!pieces.length) return null;
  const touches = (A, B) => {
    const [S, L] = A.size < B.size ? [A, B] : [B, A];
    for (const c0 of S) { const x = c0 % cw, y = (c0 / cw) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < cw && ny < ch && L.has(ny * cw + nx)) return true; } }
    return false;
  };
  // per lattice vertex: union-find over the pieces of incident triangles whose cells touch
  const incident = Array.from({ length: vx.length }, () => []);
  for (const t of triPieces.keys()) for (let k = 0; k < 3; k++) incident[T[3 * t + k]].push(t);
  const vcopy = new Map(); // piece*3+k → new vertex index
  const nvx = [], nvy = [];
  for (let v = 0; v < vx.length; v++) {
    const ts = incident[v]; if (!ts.length) continue;
    const ps = ts.flatMap(t => triPieces.get(t)), par = new Map(ps.map(p => [p, p]));
    const find = (p) => { while (par.get(p) !== p) p = par.get(p); return p; };
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) {
      const t1 = ts[i], t2 = ts[j];
      for (const p1 of triPieces.get(t1)) for (const p2 of triPieces.get(t2)) if (find(p1) !== find(p2) && touches(pieces[p1].cells, pieces[p2].cells)) par.set(find(p1), find(p2));
    }
    const ids = new Map();
    for (const p of ps) {
      const r = find(p); if (!ids.has(r)) { ids.set(r, nvx.length); nvx.push(vx[v]); nvy.push(vy[v]); }
      const t = pieces[p].t, k = T[3 * t] === v ? 0 : T[3 * t + 1] === v ? 1 : 2;
      vcopy.set(p * 3 + k, ids.get(r));
    }
  }
  const tris = new Int32Array(pieces.length * 3), triMask = new Array(pieces.length).fill(null);
  pieces.forEach((pc, i) => {
    for (let k = 0; k < 3; k++) tris[3 * i + k] = vcopy.get(i * 3 + k);
    if (!pc.split) return;
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
    for (const c0 of pc.cells) { const x = c0 % cw, y = (c0 / cw) | 0; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, bits = new Uint8Array(w * h);
    for (const c0 of pc.cells) bits[(((c0 / cw) | 0) - y0) * w + (c0 % cw) - x0] = 1;
    triMask[i] = { x0, y0, w, h, bits, step };
  });
  const verts = new Float64Array(nvx.length * 2);
  for (let i = 0; i < nvx.length; i++) { verts[2 * i] = nvx[i]; verts[2 * i + 1] = nvy[i]; }
  return { verts, tris, spacing: Math.max(sx, hs / 0.866), opaque, triMask: triMask.some(Boolean) ? triMask : null, step };
}

// Mesh edges (unique pairs) for overlay drawing.
export function meshEdges(tris, nv) {
  const seen = new Set(), out = [];
  for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = tris[t + k], b = tris[t + (k + 1) % 3], K = a < b ? a * nv + b : b * nv + a;
    if (!seen.has(K)) { seen.add(K); out.push(a, b); }
  }
  return Int32Array.from(out);
}

// ================================================================ ARAP solver
// Igarashi et al. 2005 style two-stage solve, done with prefactored sparse systems:
//  1. As-Similar-As-Possible: exact linear least squares over (x,y) jointly (per-triangle similarity
//     eliminated in closed form) — handles large rotations in one solve, deterministic given the pins.
//  2. As-Rigid-As-Possible refinement: local (per-triangle rotation fit) / global (Laplacian solve)
//     iterations starting from (1). Rigid: rotation only; Normal: partial scale; Distort: stage 1 only.
// Pins are barycentric soft constraints (weight PIN_W) so they can sit anywhere inside a triangle.
const PIN_W = 1e5, REG_MU = 1e-7, FIX_W = 20;
function bary(P, tris, t, x, y) {
  const a = tris[3 * t], b = tris[3 * t + 1], c = tris[3 * t + 2];
  const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1], cx = P[2 * c], cy = P[2 * c + 1];
  const ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(ar) < 1e-12) return null;
  const l1 = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / ar, l2 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / ar;
  return [1 - l1 - l2, l1, l2];
}
// Symmetric positive definite matrix in skyline (profile) storage + in-place Cholesky.
export class ProfileCholesky {
  constructor(n, first) {
    this.n = n; this.first = first; this.off = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.off[i + 1] = this.off[i] + (i - first[i] + 1);
    this.a = new Float64Array(this.off[n]);
  }
  add(i, j, v) { if (i < j) { const t = i; i = j; j = t; } this.a[this.off[i] + j - this.first[i]] += v; }
  factor() {
    const { n, first, off, a } = this;
    for (let i = 0; i < n; i++) {
      const fi = first[i], oi = off[i] - fi;
      for (let j = fi; j <= i; j++) {
        const fj = first[j], oj = off[j] - fj; let s = a[oi + j];
        for (let k = Math.max(fi, fj); k < j; k++) s -= a[oi + k] * a[oj + k];
        if (j < i) a[oi + j] = s / a[oj + j]; else a[oi + i] = Math.sqrt(Math.max(s, 1e-12));
      }
    }
    return this;
  }
  solve(b) {
    const { n, first, off, a } = this;
    for (let i = 0; i < n; i++) { const fi = first[i], oi = off[i] - fi; let s = b[i]; for (let k = fi; k < i; k++) s -= a[oi + k] * b[k]; b[i] = s / a[oi + i]; }
    for (let i = n - 1; i >= 0; i--) { const fi = first[i], oi = off[i] - fi, x = b[i] / a[oi + i]; b[i] = x; for (let k = fi; k < i; k++) b[k] -= a[oi + k] * x; }
    return b;
  }
}

export class PuppetSolver {
  constructor(mesh) {
    this.q = Float64Array.from(mesh.verts); this.p = Float64Array.from(mesh.verts);
    this.tris = mesh.tris; this.n = this.q.length / 2; this.m = this.tris.length / 3; this.spacing = mesh.spacing;
    this.triMask = mesh.triMask || null;
    this.mode = 'normal'; this.pins = []; this.dirty = true; this._pid = 1;
    this.T = new Float64Array(this.m * 2);
    const par = Int32Array.from({ length: this.n }, (_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    for (let t = 0; t < this.m; t++) { const a = find(this.tris[3 * t]), b = find(this.tris[3 * t + 1]); par[b] = a; const c = find(this.tris[3 * t + 2]); par[c] = a; }
    this.comp = Int32Array.from({ length: this.n }, (_, i) => find(i));
    this._flaps();
    this.centroid = new Float64Array(this.m * 2);
    for (let t = 0; t < this.m; t++) for (let k = 0; k < 3; k++) { const v = this.tris[3 * t + k]; this.centroid[2 * t] += this.q[2 * v] / 3; this.centroid[2 * t + 1] += this.q[2 * v + 1] / 3; }
  }
  // Parts attached to the rest of their component only through a single vertex ("flaps", e.g. thin
  // anti-aliased fringes) have a free rotation; they rigidly follow the triangle they hang from.
  _flaps() {
    const tr = this.tris, m = this.m, nv = this.n, par = Int32Array.from({ length: m }, (_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const em = new Map();
    for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) {
      const a = tr[3 * t + k], b = tr[3 * t + (k + 1) % 3], K = a < b ? a * nv + b : b * nv + a;
      if (em.has(K)) par[find(t)] = find(em.get(K)); else em.set(K, t);
    }
    const ec = Int32Array.from({ length: m }, (_, t) => find(t)), size = new Map();
    for (let t = 0; t < m; t++) size.set(ec[t], (size.get(ec[t]) || 0) + 1);
    const inc = Array.from({ length: nv }, () => []);
    for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) inc[tr[3 * t + k]].push(t);
    this.flaps = []; this.edgeComp = ec;
    if (size.size < 2) return;
    // BFS from the largest edge-component of each vertex-component through hinge vertices
    const done = new Set(), roots = new Map();
    for (const [c, n] of size) { const vc = this.comp[tr[3 * c]]; if (!roots.has(vc) || n > size.get(roots.get(vc))) roots.set(vc, c); }
    const trisOf = new Map(); for (let t = 0; t < m; t++) (trisOf.get(ec[t]) || trisOf.set(ec[t], []).get(ec[t])).push(t);
    for (const root of roots.values()) {
      const queue = [root]; done.add(root);
      while (queue.length) {
        const c = queue.shift();
        for (const t of trisOf.get(c)) for (let k = 0; k < 3; k++) {
          const h = tr[3 * t + k];
          for (const t2 of inc[h]) {
            const c2 = ec[t2]; if (done.has(c2)) continue;
            done.add(c2); queue.push(c2);
            const vs = new Set(); for (const u of trisOf.get(c2)) for (let j = 0; j < 3; j++) if (tr[3 * u + j] !== h) vs.add(tr[3 * u + j]);
            this.flaps.push({ comp: c2, h, anchor: t, verts: Int32Array.from(vs) });
          }
        }
      }
    }
  }
  _applyFlaps() {
    if (!this.flaps.length) return;
    const pinnedEC = new Set(this.pins.map(p => this.edgeComp[p.tri]));
    const { q, p, tris: tr } = this;
    for (const f of this.flaps) {
      if (pinnedEC.has(f.comp)) continue;
      const t = f.anchor; let C = 0, S = 0, L2 = 0;
      for (let e = 0; e < 3; e++) {
        const i = tr[3 * t + e], j = tr[3 * t + (e + 1) % 3];
        const ex = q[2 * j] - q[2 * i], ey = q[2 * j + 1] - q[2 * i + 1], fx = p[2 * j] - p[2 * i], fy = p[2 * j + 1] - p[2 * i + 1];
        C += ex * fx + ey * fy; S += ex * fy - ey * fx; L2 += ex * ex + ey * ey;
      }
      const r = Math.hypot(C, S); if (!(r > 1e-12) || !(L2 > 0)) continue;
      const sc = this.mode === 'rigid' ? 1 : this.mode === 'distort' ? r / L2 : Math.sqrt(r / L2);
      const c = C / r * sc, s = S / r * sc, h = f.h, hx = q[2 * h], hy = q[2 * h + 1], px = p[2 * h], py = p[2 * h + 1];
      for (const v of f.verts) { const dx = q[2 * v] - hx, dy = q[2 * v + 1] - hy; p[2 * v] = px + c * dx - s * dy; p[2 * v + 1] = py + s * dx + c * dy; }
    }
  }
  setMode(mode) { this.mode = mode; }
  // Locate (x,y) on the mesh (current or rest configuration); the topmost triangle in `order` wins.
  // Pieces of a split lattice triangle overlap; prefer the one whose cells contain the (rest) point.
  locate(x, y, rest = false, order = null, tol = 1e-7) {
    const P = rest ? this.q : this.p; let first = null;
    for (let n = this.m - 1; n >= 0; n--) {
      const t = order ? order[n] : n, b = bary(P, this.tris, t, x, y);
      if (!(b && b[0] >= -tol && b[1] >= -tol && b[2] >= -tol)) continue;
      const tm = this.triMask && this.triMask[t];
      if (!tm) return { tri: t, b };
      let rx = 0, ry = 0; for (let k = 0; k < 3; k++) { const v = this.tris[3 * t + k]; rx += b[k] * this.q[2 * v]; ry += b[k] * this.q[2 * v + 1]; }
      const mx = Math.floor(rx / tm.step) - tm.x0, my = Math.floor(ry / tm.step) - tm.y0;
      if (mx >= 0 && my >= 0 && mx < tm.w && my < tm.h && tm.bits[my * tm.w + mx]) return { tri: t, b };
      if (!first) first = { tri: t, b };
    }
    return first;
  }
  addPin(x, y, order) {
    const loc = this.locate(x, y, false, order); if (!loc) return null;
    const pin = { id: this._pid++, tri: loc.tri, b: loc.b, x, y, angle: null, depth: 0 };
    this.pins.push(pin); this.dirty = true; return pin;
  }
  // Pin anchored at a rest-space position (re-meshing). Target defaults to the rest position.
  addPinRest(rx, ry, x = rx, y = ry) {
    let loc = this.locate(rx, ry, true, null, 1e-4);
    if (!loc) { let bd = Infinity; for (let t = 0; t < this.m; t++) { const d = (this.centroid[2 * t] - rx) ** 2 + (this.centroid[2 * t + 1] - ry) ** 2; if (d < bd) { bd = d; loc = { tri: t, b: [1 / 3, 1 / 3, 1 / 3] }; } } }
    if (!loc) return null;
    const pin = { id: this._pid++, tri: loc.tri, b: loc.b, x, y, angle: null, depth: 0 };
    this.pins.push(pin); this.dirty = true; return pin;
  }
  removePin(pin) { const i = this.pins.indexOf(pin); if (i >= 0) { this.pins.splice(i, 1); this.dirty = true; } }
  clearPins() { this.pins = []; this.dirty = true; this.p.set(this.q); }
  pinRest(pin) { return this._at(this.q, pin); }
  pinCurrent(pin) { return this._at(this.p, pin); }
  _at(P, pin) { let x = 0, y = 0; for (let k = 0; k < 3; k++) { const v = this.tris[3 * pin.tri + k]; x += pin.b[k] * P[2 * v]; y += pin.b[k] * P[2 * v + 1]; } return [x, y]; }
  // Current local rotation (radians) of the mesh at a pin.
  rotationAt(pin) {
    const t = pin.tri, tr = this.tris; let C = 0, S = 0;
    for (let k = 0; k < 3; k++) {
      const i = tr[3 * t + k], j = tr[3 * t + (k + 1) % 3];
      const ex = this.q[2 * j] - this.q[2 * i], ey = this.q[2 * j + 1] - this.q[2 * i + 1], fx = this.p[2 * j] - this.p[2 * i], fy = this.p[2 * j + 1] - this.p[2 * i + 1];
      C += ex * fx + ey * fy; S += ex * fy - ey * fx;
    }
    return Math.atan2(S, C);
  }
  // Fix the rotation of the mesh around a pin (radians, relative to rest), or null for automatic.
  setPinAngle(pin, a) { if ((pin.angle == null) !== (a == null)) this.dirty = true; pin.angle = a; this._fixed = null; }
  _fixedTris() {
    if (this._fixed) return this._fixed;
    // influence radius of a fixed pin rotation: independent of mesh density
    if (!this._diag) { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < this.n; i++) { x0 = Math.min(x0, this.q[2 * i]); x1 = Math.max(x1, this.q[2 * i]); y0 = Math.min(y0, this.q[2 * i + 1]); y1 = Math.max(y1, this.q[2 * i + 1]); } this._diag = Math.hypot(x1 - x0, y1 - y0); }
    const f = new Float64Array(this.m).fill(NaN), R = Math.max(this.spacing * 1.6, this._diag * 0.05);
    for (const pin of this.pins) {
      if (pin.angle == null) continue;
      const [px, py] = this.pinRest(pin);
      for (let t = 0; t < this.m; t++) if (t === pin.tri || Math.hypot(this.centroid[2 * t] - px, this.centroid[2 * t + 1] - py) < R) f[t] = pin.angle;
    }
    return (this._fixed = f);
  }
  _factor() {
    this.dirty = false; this._fixed = null;
    const n = this.n, tr = this.tris, m = this.m;
    const pinned = new Set(this.pins.map(p => this.comp[tr[3 * p.tri]]));
    const vi = new Int32Array(n).fill(-1); let nv = 0;
    for (let i = 0; i < n; i++) if (pinned.has(this.comp[i])) vi[i] = nv++;
    this.vi = vi; this.nv = nv;
    if (!nv) return;
    const fixed = this._fixedTris();
    // profiles
    const f1 = Int32Array.from({ length: nv }, (_, i) => i), f2 = Int32Array.from({ length: 2 * nv }, (_, i) => i & ~1);
    for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) {
      const a = vi[tr[3 * t + k]], b = vi[tr[3 * t + l]]; if (a < 0 || a <= b) continue;
      if (b < f1[a]) f1[a] = b; if (2 * b < f2[2 * a]) { f2[2 * a] = 2 * b; f2[2 * a + 1] = 2 * b; }
    }
    const L = new ProfileCholesky(nv, f1), Q = new ProfileCholesky(2 * nv, f2);
    const loc = new Int32Array(3), c = new Float64Array(6), s = new Float64Array(6);
    for (let t = 0; t < m; t++) {
      if (vi[tr[3 * t]] < 0) continue;
      for (let k = 0; k < 3; k++) loc[k] = vi[tr[3 * t + k]];
      c.fill(0); s.fill(0); let L2 = 0;
      const lapW = 1 + REG_MU + (Number.isNaN(fixed[t]) ? 0 : FIX_W);
      for (let k = 0; k < 3; k++) {
        const i = tr[3 * t + k], j = tr[3 * t + (k + 1) % 3], a = loc[k], b = loc[(k + 1) % 3], ki = k, kj = (k + 1) % 3;
        const ex = this.q[2 * j] - this.q[2 * i], ey = this.q[2 * j + 1] - this.q[2 * i + 1];
        L.add(a, a, 1); L.add(b, b, 1); L.add(a, b, -1);
        for (let d = 0; d < 2; d++) { Q.add(2 * a + d, 2 * a + d, lapW); Q.add(2 * b + d, 2 * b + d, lapW); Q.add(2 * a + d, 2 * b + d, -lapW); }
        c[2 * kj] += ex; c[2 * ki] -= ex; c[2 * kj + 1] += ey; c[2 * ki + 1] -= ey;
        s[2 * kj + 1] += ex; s[2 * ki + 1] -= ex; s[2 * kj] -= ey; s[2 * ki] += ey;
        L2 += ex * ex + ey * ey;
      }
      if (L2 > 0) for (let r = 0; r < 6; r++) for (let q = 0; q <= r; q++) {
        const v = -(c[r] * c[q] + s[r] * s[q]) / L2; if (!v) continue;
        const R = 2 * loc[r >> 1] + (r & 1), C = 2 * loc[q >> 1] + (q & 1);
        if (R === C) Q.add(R, C, v); else Q.add(R, C, v); // each unordered pair once (q<r) or diagonal
      }
    }
    for (const p of this.pins) for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) {
      const a = vi[tr[3 * p.tri + k]], b = vi[tr[3 * p.tri + l]]; if (a < b) continue;
      const w = PIN_W * p.b[k] * p.b[l];
      L.add(a, b, w); Q.add(2 * a, 2 * b, w); Q.add(2 * a + 1, 2 * b + 1, w);
    }
    this.L = L.factor(); this.Q = Q.factor();
    this.bx = new Float64Array(nv); this.by = new Float64Array(nv); this.bq = new Float64Array(2 * nv);
  }
  // Stage 1: exact As-Similar-As-Possible solve.
  _asap() {
    const { q, p, tris: tr, vi, bq, m } = this, fixed = this._fixedTris();
    bq.fill(0);
    for (let t = 0; t < m; t++) {
      if (vi[tr[3 * t]] < 0) continue;
      const fa = fixed[t], isF = !Number.isNaN(fa), c = isF ? Math.cos(fa) : 1, s = isF ? Math.sin(fa) : 0;
      for (let k = 0; k < 3; k++) {
        const i = tr[3 * t + k], j = tr[3 * t + (k + 1) % 3], a = vi[i], b = vi[j];
        const ex = q[2 * j] - q[2 * i], ey = q[2 * j + 1] - q[2 * i + 1];
        let vx = REG_MU * ex, vy = REG_MU * ey;
        if (isF) { vx += FIX_W * (c * ex - s * ey); vy += FIX_W * (s * ex + c * ey); }
        bq[2 * b] += vx; bq[2 * b + 1] += vy; bq[2 * a] -= vx; bq[2 * a + 1] -= vy;
      }
    }
    for (const pin of this.pins) for (let k = 0; k < 3; k++) { const a = vi[tr[3 * pin.tri + k]]; bq[2 * a] += PIN_W * pin.b[k] * pin.x; bq[2 * a + 1] += PIN_W * pin.b[k] * pin.y; }
    this.Q.solve(bq);
    for (let i = 0; i < this.n; i++) { const a = vi[i]; if (a >= 0) { p[2 * i] = bq[2 * a]; p[2 * i + 1] = bq[2 * a + 1]; } }
  }
  // Full solve from the pins: ASAP, then k ARAP iterations (Rigid/Normal). Deterministic given pins.
  solve(k = 20) {
    if (!this.pins.length) { this.p.set(this.q); return 0; }
    if (this.dirty) this._factor();
    if (!this.nv) return 0;
    this._asap();
    if (this.mode === 'distort') { this._applyFlaps(); return 0; }
    return this.iterate(k);
  }
  // Continue ARAP local/global refinement from the current state. Returns max displacement of the last step.
  iterate(k = 1) {
    if (!this.pins.length) return 0;
    if (this.dirty) { this._factor(); if (this.nv) this._asap(); }
    if (!this.nv || this.mode === 'distort') return 0;
    const { q, p, tris: tr, T, vi, bx, by } = this, m = this.m;
    const fixed = this._fixedTris(), mode = this.mode;
    let maxd = 0;
    for (let it = 0; it < k; it++) {
      for (let t = 0; t < m; t++) {
        if (vi[tr[3 * t]] < 0) continue;
        if (!Number.isNaN(fixed[t])) { T[2 * t] = Math.cos(fixed[t]); T[2 * t + 1] = Math.sin(fixed[t]); continue; }
        let C = 0, S = 0, L2 = 0;
        for (let e = 0; e < 3; e++) {
          const i = tr[3 * t + e], j = tr[3 * t + (e + 1) % 3];
          const ex = q[2 * j] - q[2 * i], ey = q[2 * j + 1] - q[2 * i + 1], fx = p[2 * j] - p[2 * i], fy = p[2 * j + 1] - p[2 * i + 1];
          C += ex * fx + ey * fy; S += ex * fy - ey * fx; L2 += ex * ex + ey * ey;
        }
        const r = Math.hypot(C, S);
        let c = 1, s = 0; if (r > 1e-12) { c = C / r; s = S / r; }
        const sc = mode === 'rigid' || !(L2 > 0) ? 1 : Math.sqrt(Math.min(4, Math.max(0.25, r / L2)));
        T[2 * t] = c * sc; T[2 * t + 1] = s * sc;
      }
      bx.fill(0); by.fill(0);
      for (let t = 0; t < m; t++) {
        if (vi[tr[3 * t]] < 0) continue;
        const c = T[2 * t], s = T[2 * t + 1];
        for (let e = 0; e < 3; e++) {
          const i = tr[3 * t + e], j = tr[3 * t + (e + 1) % 3];
          const ex = q[2 * j] - q[2 * i], ey = q[2 * j + 1] - q[2 * i + 1], vx = c * ex - s * ey, vy = s * ex + c * ey;
          bx[vi[j]] += vx; by[vi[j]] += vy; bx[vi[i]] -= vx; by[vi[i]] -= vy;
        }
      }
      for (const pin of this.pins) for (let e = 0; e < 3; e++) { const a = vi[tr[3 * pin.tri + e]]; bx[a] += PIN_W * pin.b[e] * pin.x; by[a] += PIN_W * pin.b[e] * pin.y; }
      this.L.solve(bx); this.L.solve(by);
      maxd = 0;
      for (let i = 0; i < this.n; i++) { const a = vi[i]; if (a < 0) continue; const dx = bx[a] - p[2 * i], dy = by[a] - p[2 * i + 1], dd = dx * dx + dy * dy; if (dd > maxd) maxd = dd; p[2 * i] = bx[a]; p[2 * i + 1] = by[a]; }
      this._applyFlaps();
    }
    return Math.sqrt(maxd);
  }
  // Triangle draw order honoring pin depth (null when all depths are 0): nearest pin (rest space) decides.
  drawOrder() {
    if (!this.pins.some(p => p.depth)) return null;
    const rp = this.pins.map(p => this.pinRest(p)), dep = new Float64Array(this.m);
    for (let t = 0; t < this.m; t++) {
      const cx = this.centroid[2 * t], cy = this.centroid[2 * t + 1]; let bd = Infinity, best = 0;
      for (let i = 0; i < rp.length; i++) { const dd = (rp[i][0] - cx) ** 2 + (rp[i][1] - cy) ** 2; if (dd < bd) { bd = dd; best = i; } }
      dep[t] = this.pins[best].depth;
    }
    return Int32Array.from({ length: this.m }, (_, i) => i).sort((a, b) => dep[a] - dep[b] || a - b);
  }
}

// ================================================================ homographies
// 3×3 row-major (h33 = 1) projective map taking the 4 src points to the 4 dst points ([[x,y]×4]).
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
  }
  const h = solveDense(A, b); if (!h) return null;
  return Float64Array.of(h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1);
}
function solveDense(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C; if (Math.abs(det) < 1e-15) return null;
  const inv = Float64Array.of(A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d);
  for (let k = 0; k < 9; k++) inv[k] /= det;
  const s = inv[8]; if (Math.abs(s) > 1e-15) for (let k = 0; k < 9; k++) inv[k] /= s;
  return inv;
}
export function mulH(A, B) {
  const C = new Float64Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
}
const UNIT = [[0, 0], [1, 0], [1, 1], [0, 1]];
// True when the quad (4 points) is convex, non-degenerate and consistently oriented.
export function quadValid(q) {
  let sg = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const s = Math.sign(cr); if (!sg) sg = s; else if (s !== sg) return false;
  }
  return true;
}

// ================================================================ perspective warp
// Build the mapping for Perspective Warp. srcV/dstV: [[x,y]] layout & warped vertex positions;
// planes: [[i0,i1,i2,i3]] vertex indices (corners in order). Planes sharing an edge (same 2 vertices)
// get a blended correction so the image is continuous across the seam.
export function buildPerspectiveMap(srcV, dstV, planes) {
  const P = [];
  for (const pl of planes) {
    const sq = pl.map(i => srcV[i]), dq = pl.map(i => dstV[i]);
    if (!quadValid(sq) || !quadValid(dq)) { P.push(null); continue; }
    const Qs = homography(UNIT, sq), Qd = homography(UNIT, dq); if (!Qs || !Qd) { P.push(null); continue; }
    const Qsi = invertH(Qs); if (!Qsi) { P.push(null); continue; }
    P.push({ idx: pl, Qs, Qd, Qsi, H: mulH(Qd, Qsi), shared: [null, null, null, null], sq });
  }
  const ek = (a, b) => (a < b ? a + ',' + b : b + ',' + a), emap = new Map();
  P.forEach((p, k) => { if (p) for (let e = 0; e < 4; e++) { const K = ek(p.idx[e], p.idx[(e + 1) % 4]); (emap.get(K) || emap.set(K, []).get(K)).push([k, e]); } });
  for (const list of emap.values()) if (list.length >= 2) {
    const [[k1, e1], [k2, e2]] = list; P[k1].shared[e1] = k2; P[k2].shared[e2] = k1;
  }
  // plane k map at source point (x,y) with plane params (u,v) (may be outside [0,1] for extrapolation)
  const edgePt = (p, e, u, v) => e === 0 ? applyH(p.Qs, u, 0) : e === 1 ? applyH(p.Qs, 1, v) : e === 2 ? applyH(p.Qs, u, 1) : applyH(p.Qs, 0, v);
  const fall = (e, u, v) => { const f = e === 0 ? 1 - v : e === 1 ? u : e === 2 ? v : 1 - u; const c = f < 0 ? 0 : f > 1 ? 1 : f; return c * c * (3 - 2 * c); };
  function planeMap(k, x, y) {
    const p = P[k], [u, v] = applyH(p.Qsi, x, y);
    let [X, Y] = applyH(p.Qd, u, v);
    for (let e = 0; e < 4; e++) {
      const m = p.shared[e]; if (m == null) continue;
      const f = fall(e, u, v); if (!f) continue;
      const [ex, ey] = edgePt(p, e, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v)));
      const [ax, ay] = applyH(p.H, ex, ey), [bx, by] = applyH(P[m].H, ex, ey);
      X += f * 0.5 * (bx - ax); Y += f * 0.5 * (by - ay);
    }
    return [X, Y, u, v];
  }
  const valid = P.map((p, k) => (p ? k : -1)).filter(k => k >= 0);
  function inside(k, x, y) { const [u, v] = applyH(P[k].Qsi, x, y); return u >= 0 && u <= 1 && v >= 0 && v <= 1; }
  function nearestOnQuad(q, x, y) {
    let bd = Infinity, bx = x, by = y;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = q[i], [cx, cy] = q[(i + 1) % 4], dx = cx - ax, dy = cy - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const px = ax + t * dx, py = ay + t * dy, dd = (px - x) ** 2 + (py - y) ** 2;
      if (dd < bd) { bd = dd; bx = px; by = py; }
    }
    return [bx, by, Math.sqrt(bd)];
  }
  function mapPoint(x, y) {
    if (!valid.length) return [x, y];
    for (const k of valid) if (inside(k, x, y)) { const r = planeMap(k, x, y); return [r[0], r[1]]; }
    let sx = 0, sy = 0, sw = 0;
    for (const k of valid) {
      const [cx, cy, d] = nearestOnQuad(P[k].sq, x, y);
      const h = 0.5, m0 = planeMap(k, cx, cy), mx = planeMap(k, cx + h, cy), my = planeMap(k, cx, cy + h);
      const jxx = (mx[0] - m0[0]) / h, jyx = (mx[1] - m0[1]) / h, jxy = (my[0] - m0[0]) / h, jyy = (my[1] - m0[1]) / h;
      const vx = m0[0] + jxx * (x - cx) + jxy * (y - cy), vy = m0[1] + jyx * (x - cx) + jyy * (y - cy);
      const w = 1 / Math.max(d * d, 1e-9);
      sx += w * vx; sy += w * vy; sw += w;
    }
    return [sx / sw, sy / sw];
  }
  return { planes: P, valid, planeMap, mapPoint, inside };
}

// Render a perspective warp: planes exactly (fine projective grid each), then the rest of the image
// through the extrapolated map. `xf(x,y)` optionally post-transforms dst coords (preview view transform).
export function renderPerspective(src, srcScale, map, out, { xf = null, planeGrid = 32, cell = 12, clip } = {}) {
  const W = out.width, H = out.height, mask = new Uint8Array(W * H);
  const sw = src.width / srcScale, sh = src.height / srcScale; // source size in layout (full-res) units
  const put = (dp, i, X, Y) => { if (xf) { const r = xf(X, Y); dp[2 * i] = r[0]; dp[2 * i + 1] = r[1]; } else { dp[2 * i] = X; dp[2 * i + 1] = Y; } };
  const G = planeGrid, tris = gridTris(G, G);
  for (const k of map.valid) {
    const p = map.planes[k], n = (G + 1) * (G + 1), sp = new Float64Array(2 * n), dp = new Float64Array(2 * n);
    for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
      const id = j * (G + 1) + i, [x, y] = applyH(p.Qs, i / G, j / G), r = map.planeMap(k, x, y);
      sp[2 * id] = x * srcScale; sp[2 * id + 1] = y * srcScale; put(dp, id, r[0], r[1]);
    }
    rasterizeTriangles(src, sp, dp, tris, out, { aa: false, mask, clip });
  }
  const cols = Math.max(2, Math.min(220, Math.ceil(sw / cell))), rows = Math.max(2, Math.min(220, Math.ceil(sh / cell)));
  const n = (cols + 1) * (rows + 1), sp = new Float64Array(2 * n), dp = new Float64Array(2 * n);
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) {
    const id = j * (cols + 1) + i, x = (i / cols) * sw, y = (j / rows) * sh, r = map.mapPoint(x, y);
    sp[2 * id] = x * srcScale; sp[2 * id + 1] = y * srcScale; put(dp, id, r[0], r[1]);
  }
  rasterizeTriangles(src, sp, dp, gridTris(cols, rows), out, { aa: true, mask, skipMask: true, clip });
  return out;
}

// Edge straightening for Perspective Warp. V: [[x,y]] (mutated). edges: [[a,b]].
// Returns the list of new locks [{a,b,axis:'v'|'h'}] for edges within maxDeg of vertical / horizontal.
export function autoStraighten(V, edges, which = 'both', maxDeg = 20) {
  const locks = [], tol = Math.tan(maxDeg * Math.PI / 180);
  for (const [a, b] of edges) {
    const dx = V[b][0] - V[a][0], dy = V[b][1] - V[a][1];
    if ((which === 'v' || which === 'both') && Math.abs(dx) <= tol * Math.abs(dy)) locks.push({ a, b, axis: 'v' });
    else if ((which === 'h' || which === 'both') && Math.abs(dy) <= tol * Math.abs(dx)) locks.push({ a, b, axis: 'h' });
  }
  enforceLocks(V, locks);
  return locks;
}
// Make locked edges exactly vertical/horizontal. Vertices in `pinned` (Set) keep their position.
export function enforceLocks(V, locks, pinned = null, passes = 30) {
  for (let it = 0; it < passes; it++) {
    let ch = 0;
    for (const { a, b, axis } of locks) {
      const c = axis === 'v' ? 0 : 1, pa = pinned && pinned.has(a), pb = pinned && pinned.has(b);
      if (pa && pb) continue;
      const t = pa ? V[a][c] : pb ? V[b][c] : (V[a][c] + V[b][c]) / 2;
      ch = Math.max(ch, Math.abs(V[a][c] - t), Math.abs(V[b][c] - t));
      V[a][c] = t; V[b][c] = t;
    }
    if (ch < 1e-6) break;
  }
  return V;
}

// ================================================================ bezier warp
export const WARP_STYLES = [
  ['custom', 'Custom'], null, ['arc', 'Arc'], ['arcLower', 'Arc Lower'], ['arcUpper', 'Arc Upper'], ['arch', 'Arch'], ['bulge', 'Bulge'],
  ['shellLower', 'Shell Lower'], ['shellUpper', 'Shell Upper'], null, ['flag', 'Flag'], ['wave', 'Wave'], ['fish', 'Fish'], ['rise', 'Rise'], null,
  ['fisheye', 'Fisheye'], ['inflate', 'Inflate'], ['squeeze', 'Squeeze'], ['twist', 'Twist'],
];
const B3 = (t) => { const s = 1 - t; return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t]; };
const PAR = (t) => 1 - (2 * t - 1) ** 2;
// Local (box-relative) warp of the point (u,v) ∈ [0,1]² for a horizontal-orientation style.
function styleLocal(style, u, v, b, w, h) {
  let x = u * w, y = v * h;
  if (!b) return [x, y];
  const P = PAR(u), Pv = PAR(v), TAU = Math.PI * 2;
  switch (style) {
    case 'arc': {
      const th = b * Math.PI * 0.6; if (Math.abs(th) < 1e-6) break;
      const R0 = w / th, k = Math.min(1, (0.7 * Math.abs(R0)) / h), phi = (u - 0.5) * th, r = R0 - y * k; // k: don't collapse tall boxes
      return [w / 2 + r * Math.sin(phi), R0 - r * Math.cos(phi)];
    }
    case 'arcLower': y += v * b * h * 0.5 * P; x += (u - 0.5) * w * b * 0.25 * v; break;
    case 'arcUpper': y -= (1 - v) * b * h * 0.5 * P; x += (u - 0.5) * w * b * 0.25 * (1 - v); break;
    case 'arch': y -= b * h * 0.5 * P; break;
    case 'bulge': y += (2 * v - 1) * b * h * 0.35 * P; break;
    case 'shellLower': y += b * h * 0.45 * P * v; x -= (u - 0.5) * w * b * 0.5 * (1 - v); break;
    case 'shellUpper': y -= b * h * 0.45 * P * (1 - v); x -= (u - 0.5) * w * b * 0.5 * v; break;
    case 'flag': y += b * h * 0.25 * Math.sin(TAU * u); break;
    case 'wave': y += b * h * 0.25 * Math.sin(TAU * u) * (1 - 1.6 * v); x += b * w * 0.04 * Math.sin(TAU * v); break;
    case 'fish': y += (v - 0.5) * h * b * 0.7 * Math.sin(TAU * u); break;
    case 'rise': y -= b * h * 0.5 * Math.sin(Math.PI * (u - 0.5)); break;
    case 'fisheye': { const r2 = ((2 * u - 1) ** 2 + (2 * v - 1) ** 2) / 2, f = b * 0.55 * (1 - r2); x += (u - 0.5) * w * f * P; y += (v - 0.5) * h * f * 2.2 * P; break; }
    case 'inflate': x += (2 * u - 1) * b * w * 0.22 * Pv; y += (2 * v - 1) * b * h * 0.22 * P; break;
    case 'squeeze': x -= (2 * u - 1) * b * w * 0.25 * Pv; y += (2 * v - 1) * b * h * 0.25 * P; break;
    case 'twist': {
      const r = Math.min(1, Math.sqrt(((2 * u - 1) ** 2 + (2 * v - 1) ** 2) / 2)), a = b * Math.PI * 0.5 * (1 - r) ** 2;
      const dx = x - w / 2, dy = y - h / 2, c = Math.cos(a), s = Math.sin(a);
      return [w / 2 + dx * c - dy * s, h / 2 + dx * s + dy * c];
    }
  }
  return [x, y];
}
// Point function for a warp style. params: { bend, hDist, vDist (percent, -100..100), vertical (bool) }.
export function warpStyleFn(style, { bend = 0, hDist = 0, vDist = 0, vertical = false } = {}, box) {
  const w = box.w, h = box.h, b = Math.max(-1, Math.min(1, bend / 100));
  const hd = Math.max(-0.98, Math.min(0.98, hDist / 100)), vd = Math.max(-0.98, Math.min(0.98, vDist / 100));
  let D = null;
  if (hd || vd) {
    const cx = w / 2, cy = h / 2;
    D = homography([[0, 0], [w, 0], [w, h], [0, h]], [
      [cx - (w / 2) * (1 - vd), cy - (h / 2) * (1 - hd)], [cx + (w / 2) * (1 - vd), cy - (h / 2) * (1 + hd)],
      [cx + (w / 2) * (1 + vd), cy + (h / 2) * (1 + hd)], [cx - (w / 2) * (1 + vd), cy + (h / 2) * (1 - hd)]]);
  }
  return (u, v) => {
    let x, y;
    if (style === 'custom' || !b) { x = u * w; y = v * h; }
    else if (vertical) { const r = styleLocal(style, v, u, b, h, w); x = r[1]; y = r[0]; }
    else [x, y] = styleLocal(style, u, v, b, w, h);
    if (D) [x, y] = applyH(D, x, y);
    return [box.x + x, box.y + y];
  };
}
// Least-squares pseudo-inverse of the 7-sample Bernstein matrix (4×7).
const FIT_M = 7, FIT_PINV = (() => {
  const B = Array.from({ length: FIT_M }, (_, a) => B3(a / (FIT_M - 1)));
  const BtB = [0, 1, 2, 3].map(i => [0, 1, 2, 3].map(j => B.reduce((s, r) => s + r[i] * r[j], 0)));
  const inv = inv4(BtB);
  return [0, 1, 2, 3].map(i => B.map(r => [0, 1, 2, 3].reduce((s, j) => s + inv[i][j] * r[j], 0)));
})();
function inv4(M) {
  const n = 4, A = M.map((r, i) => [...r, ...[0, 1, 2, 3].map(j => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c]; for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
    for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k]; }
  }
  return A.map(r => r.slice(n));
}
export const netSize = (N) => 3 * N + 1;
// Fit an N×N-patch bicubic Bézier net to fn(u,v) → [x,y]. Returns Float64Array(M*M*2), M = 3N+1, row-major (row = v).
export function fitWarpNet(fn, N = 1) {
  const M = netSize(N), acc = new Float64Array(M * M * 2), cnt = new Float64Array(M * M);
  const S = Array.from({ length: FIT_M }, () => new Float64Array(FIT_M * 2));
  for (let pj = 0; pj < N; pj++) for (let pi = 0; pi < N; pi++) {
    for (let b = 0; b < FIT_M; b++) for (let a = 0; a < FIT_M; a++) { const r = fn((pi + a / (FIT_M - 1)) / N, (pj + b / (FIT_M - 1)) / N); S[b][2 * a] = r[0]; S[b][2 * a + 1] = r[1]; }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let x = 0, y = 0;
      for (let b = 0; b < FIT_M; b++) { const wr = FIT_PINV[r][b]; if (!wr) continue; for (let a = 0; a < FIT_M; a++) { const w = wr * FIT_PINV[c][a]; x += w * S[b][2 * a]; y += w * S[b][2 * a + 1]; } }
      const id = (pj * 3 + r) * M + (pi * 3 + c);
      acc[2 * id] += x; acc[2 * id + 1] += y; cnt[id]++;
    }
  }
  for (let i = 0; i < M * M; i++) { acc[2 * i] /= cnt[i]; acc[2 * i + 1] /= cnt[i]; }
  // anchors interpolate exactly
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) { const r = fn(i / N, j / N), id = (j * 3) * M + i * 3; acc[2 * id] = r[0]; acc[2 * id + 1] = r[1]; }
  return acc;
}
export const identityNet = (box, N = 1) => fitWarpNet((u, v) => [box.x + u * box.w, box.y + v * box.h], N);
export const presetNet = (style, params, box, N = 1) => fitWarpNet(warpStyleFn(style, params, box), N);
// Indices + weights of the 16 control points influencing (u,v).
export function netBasis(N, u, v) {
  const M = netSize(N);
  const pi = Math.min(N - 1, Math.max(0, Math.floor(u * N))), pj = Math.min(N - 1, Math.max(0, Math.floor(v * N)));
  const bu = B3(u * N - pi), bv = B3(v * N - pj), idx = new Int32Array(16), w = new Float64Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { idx[r * 4 + c] = (pj * 3 + r) * M + pi * 3 + c; w[r * 4 + c] = bv[r] * bu[c]; }
  return { idx, w };
}
export function evalNet(net, N, u, v) {
  const { idx, w } = netBasis(N, u, v); let x = 0, y = 0;
  for (let k = 0; k < 16; k++) { x += w[k] * net[2 * idx[k]]; y += w[k] * net[2 * idx[k] + 1]; }
  return [x, y];
}
// Re-express a net with a different patch count (least squares on the current surface).
export const resampleNet = (net, N, N2) => (N === N2 ? Float64Array.from(net) : fitWarpNet((u, v) => evalNet(net, N, u, v), N2));
// Triangle mesh for rendering a warp net: source = box grid, dest = surface. xf post-transforms dst.
export function warpNetMesh(net, N, box, S = 64, srcScale = 1, xf = null) {
  const n = (S + 1) * (S + 1), sp = new Float64Array(2 * n), dp = new Float64Array(2 * n), M = netSize(N);
  // separable Bernstein bases per column / row (patch index + 4 weights)
  const pa = new Int32Array(S + 1), wa = new Float64Array(4 * (S + 1));
  for (let i = 0; i <= S; i++) { const t = (i / S) * N, p = Math.min(N - 1, Math.floor(t)); pa[i] = p; wa.set(B3(t - p), 4 * i); }
  for (let j = 0; j <= S; j++) for (let i = 0; i <= S; i++) {
    const id = j * (S + 1) + i, u = i / S, v = j / S;
    sp[2 * id] = (box.x + u * box.w) * srcScale; sp[2 * id + 1] = (box.y + v * box.h) * srcScale;
    let x = 0, y = 0;
    for (let r = 0; r < 4; r++) {
      const wr = wa[4 * j + r], row = (pa[j] * 3 + r) * M + pa[i] * 3;
      for (let c = 0; c < 4; c++) { const w = wr * wa[4 * i + c], k = 2 * (row + c); x += w * net[k]; y += w * net[k + 1]; }
    }
    if (xf) [x, y] = xf(x, y);
    dp[2 * id] = x; dp[2 * id + 1] = y;
  }
  return { sp, dp, tris: gridTris(S, S) };
}
// Find (u,v) whose surface point is nearest to (x,y). Returns {u,v,dist}.
export function pickNet(net, N, x, y, G = 48) {
  let bu = 0, bv = 0, bd = Infinity;
  for (let j = 0; j <= G; j++) for (let i = 0; i <= G; i++) {
    const [px, py] = evalNet(net, N, i / G, j / G), d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd) { bd = d; bu = i / G; bv = j / G; }
  }
  // Gauss-Newton refinement
  for (let it = 0; it < 8; it++) {
    const h = 1e-4, [px, py] = evalNet(net, N, bu, bv), [ax, ay] = evalNet(net, N, Math.min(1, bu + h), bv), [cx, cy] = evalNet(net, N, bu, Math.min(1, bv + h));
    const hu = Math.min(1, bu + h) - bu || -h, hv = Math.min(1, bv + h) - bv || -h;
    const j11 = (ax - px) / hu, j21 = (ay - py) / hu, j12 = (cx - px) / hv, j22 = (cy - py) / hv, det = j11 * j22 - j12 * j21;
    if (Math.abs(det) < 1e-9) break;
    const rx = x - px, ry = y - py;
    bu = Math.min(1, Math.max(0, bu + (j22 * rx - j12 * ry) / det)); bv = Math.min(1, Math.max(0, bv + (-j21 * rx + j11 * ry) / det));
  }
  const [px, py] = evalNet(net, N, bu, bv);
  return { u: bu, v: bv, dist: Math.hypot(px - x, py - y) };
}
// Move the surface point at (u,v) by (dx,dy) with the least-norm change of its control points.
export function dragNetSurface(net0, N, u, v, dx, dy) {
  const net = Float64Array.from(net0), { idx, w } = netBasis(N, u, v);
  let s = 0; for (let k = 0; k < 16; k++) s += w[k] * w[k];
  if (s < 1e-12) return net;
  for (let k = 0; k < 16; k++) { net[2 * idx[k]] += (w[k] / s) * dx; net[2 * idx[k] + 1] += (w[k] / s) * dy; }
  return net;
}
