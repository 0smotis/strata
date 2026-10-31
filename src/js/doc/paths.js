// Vector paths: model, geometry, hit testing, conversion to/from selections.
// A subpath: { closed: bool, pts: [{ x, y, in: {x,y}|null, out: {x,y}|null, smooth: bool }] }  (handles are absolute coords)
import { uid } from '../util.js';

export const clonePaths = (sp) => JSON.parse(JSON.stringify(sp || []));

export function anchor(x, y) { return { x, y, in: null, out: null, smooth: false }; }

export function buildPath2D(subpaths, tx) {
  const p = new Path2D();
  const T = tx ? (q) => ({ x: tx[0] * q.x + tx[2] * q.y + tx[4], y: tx[1] * q.x + tx[3] * q.y + tx[5] }) : (q) => q;
  for (const s of subpaths || []) {
    if (!s.pts.length) continue;
    const a0 = T(s.pts[0]); p.moveTo(a0.x, a0.y);
    const n = s.pts.length, segs = s.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = s.pts[i], b = s.pts[(i + 1) % n];
      const c1 = T(a.out || a), c2 = T(b.in || b), e = T(b);
      if (!a.out && !b.in) p.lineTo(e.x, e.y); else p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y);
    }
    if (s.closed) p.closePath();
  }
  return p;
}

export function bez(a, c1, c2, b, t) {
  const u = 1 - t;
  return { x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x, y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y };
}
export function segment(s, i) {
  const n = s.pts.length, a = s.pts[i], b = s.pts[(i + 1) % n];
  return [a, a.out || a, b.in || b, b];
}
export function segCount(s) { return s.closed ? s.pts.length : s.pts.length - 1; }

// Flatten to polylines (for bounds, hit tests, thumbnails)
export function flatten(subpaths, steps = 16) {
  const out = [];
  for (const s of subpaths || []) {
    const poly = [];
    if (!s.pts.length) continue;
    poly.push({ x: s.pts[0].x, y: s.pts[0].y });
    for (let i = 0; i < segCount(s); i++) {
      const [a, c1, c2, b] = segment(s, i);
      const curved = a.out || b.in;
      if (!curved) { poly.push({ x: b.x, y: b.y }); continue; }
      for (let k = 1; k <= steps; k++) poly.push(bez(a, c1, c2, b, k / steps));
    }
    out.push({ closed: s.closed, poly });
  }
  return out;
}
export function pathBounds(subpaths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of flatten(subpaths)) for (const p of f.poly) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Hit testing (tol in doc px)
export function hitAnchor(subpaths, x, y, tol) {
  for (let si = subpaths.length - 1; si >= 0; si--) { const s = subpaths[si]; for (let i = 0; i < s.pts.length; i++) if (Math.abs(s.pts[i].x - x) <= tol && Math.abs(s.pts[i].y - y) <= tol) return { si, i }; }
  return null;
}
export function hitHandle(subpaths, sel, x, y, tol) {
  for (const key of sel || []) {
    const [si, i] = key.split(':').map(Number), p = subpaths[si]?.pts[i]; if (!p) continue;
    for (const h of ['in', 'out']) if (p[h] && Math.abs(p[h].x - x) <= tol && Math.abs(p[h].y - y) <= tol) return { si, i, h };
  }
  return null;
}
export function hitSegment(subpaths, x, y, tol) {
  let best = null;
  subpaths.forEach((s, si) => {
    for (let i = 0; i < segCount(s); i++) {
      const [a, c1, c2, b] = segment(s, i);
      let prev = a;
      for (let k = 1; k <= 32; k++) {
        const t = k / 32, p = bez(a, c1, c2, b, t);
        const d = distToSeg(x, y, prev, p);
        if (d.dist <= tol && (!best || d.dist < best.dist)) best = { si, i, t: (k - 1 + d.t) / 32, dist: d.dist };
        prev = p;
      }
    }
  });
  return best;
}
function distToSeg(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L));
  return { dist: Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t)), t };
}
// Insert an anchor on segment i at parameter t (de Casteljau split keeps the curve shape)
export function splitSegment(s, i, t) {
  const n = s.pts.length, a = s.pts[i], b = s.pts[(i + 1) % n];
  const P0 = a, P1 = a.out || a, P2 = b.in || b, P3 = b;
  const L = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const A = L(P0, P1), B = L(P1, P2), C = L(P2, P3), D = L(A, B), E = L(B, C), F = L(D, E);
  const curved = a.out || b.in;
  const np = { x: F.x, y: F.y, in: curved ? D : null, out: curved ? E : null, smooth: !!curved };
  if (curved) { a.out = A; b.in = C; }
  s.pts.splice(i + 1, 0, np);
  return i + 1;
}
export function insidePath(subpaths, x, y) {
  const c = document.createElement('canvas').getContext('2d');
  return c.isPointInPath(buildPath2D(subpaths), x, y, 'nonzero');
}
export function transformPaths(subpaths, f) {
  for (const s of subpaths) for (const p of s.pts) { const a = f(p); p.x = a.x; p.y = a.y; if (p.in) Object.assign(p.in, f(p.in)); if (p.out) Object.assign(p.out, f(p.out)); }
  return subpaths;
}

// ---------- shapes → paths ----------
const K = 0.5522847498;
export function shapeToSubpaths(s) {
  const { w, h } = s;
  if (s.shape === 'ellipse') {
    const cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    const pts = [
      { x: cx, y: cy - ry, in: { x: cx - rx * K, y: cy - ry }, out: { x: cx + rx * K, y: cy - ry }, smooth: true },
      { x: cx + rx, y: cy, in: { x: cx + rx, y: cy - ry * K }, out: { x: cx + rx, y: cy + ry * K }, smooth: true },
      { x: cx, y: cy + ry, in: { x: cx + rx * K, y: cy + ry }, out: { x: cx - rx * K, y: cy + ry }, smooth: true },
      { x: cx - rx, y: cy, in: { x: cx - rx, y: cy + ry * K }, out: { x: cx - rx, y: cy - ry * K }, smooth: true },
    ];
    return [{ closed: true, pts }];
  }
  if (s.shape === 'line') return [{ closed: false, pts: [anchor(0, 0), anchor(w, h)] }];
  if (s.shape === 'polygon' || s.shape === 'star') {
    const n = Math.max(3, s.sides || 5), star = s.shape === 'star', k = star ? n * 2 : n, pts = [];
    for (let i = 0; i < k; i++) { const a = -Math.PI / 2 + i * 2 * Math.PI / k, f = star && i % 2 ? (s.inner ?? 0.5) : 1; pts.push(anchor(w / 2 + Math.cos(a) * w / 2 * f, h / 2 + Math.sin(a) * h / 2 * f)); }
    return [{ closed: true, pts }];
  }
  const r = Math.min(s.radius || 0, Math.abs(w) / 2, Math.abs(h) / 2);
  if (r <= 0) return [{ closed: true, pts: [anchor(0, 0), anchor(w, 0), anchor(w, h), anchor(0, h)] }];
  const c = r * K;
  return [{ closed: true, pts: [
    { x: r, y: 0, in: { x: r - c, y: 0 }, out: null }, { x: w - r, y: 0, in: null, out: { x: w - r + c, y: 0 } },
    { x: w, y: r, in: { x: w, y: r - c }, out: null }, { x: w, y: h - r, in: null, out: { x: w, y: h - r + c } },
    { x: w - r, y: h, in: { x: w - r + c, y: h }, out: null }, { x: r, y: h, in: null, out: { x: r - c, y: h } },
    { x: 0, y: h - r, in: { x: 0, y: h - r + c }, out: null }, { x: 0, y: r, in: null, out: { x: 0, y: r - c } },
  ].map(p => ({ smooth: false, ...p })) }];
}

// ---------- simplification / fitting ----------
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  let idx = -1, max = 0; const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) { const d = distToSeg(pts[i].x, pts[i].y, a, b).dist; if (d > max) { max = d; idx = i; } }
  if (max <= eps) return [a, b];
  return [...rdp(pts.slice(0, idx + 1), eps).slice(0, -1), ...rdp(pts.slice(idx), eps)];
}
// Freeform: simplify then add Catmull-Rom derived handles (smooth curves)
export function fitCurve(raw, eps = 2.5, closed = false) {
  const p = rdp(raw, eps);
  const pts = p.map(q => anchor(q.x, q.y));
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    if ((!closed && (i === 0 || i === n - 1))) continue;
    const tx = (next.x - prev.x) / 6, ty = (next.y - prev.y) / 6;
    pts[i].in = { x: pts[i].x - tx, y: pts[i].y - ty }; pts[i].out = { x: pts[i].x + tx, y: pts[i].y + ty }; pts[i].smooth = true;
  }
  return { closed, pts };
}

// Trace the selection (alpha ≥ 128) into closed polygon subpaths, simplified with tolerance
export function selectionToSubpaths(selCanvas, tolerance = 2) {
  const w = selCanvas.width, h = selCanvas.height;
  // work at reduced resolution for big selections
  const s = Math.min(1, 1500 / Math.max(w, h));
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(selCanvas, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  const ins = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= 128;
  // directed boundary edges with inside on the right (clockwise in screen coords)
  const edges = new Map(); const key = (x, y) => y * (W + 1) + x;
  const add = (x0, y0, x1, y1) => { const k = key(x0, y0); (edges.get(k) || edges.set(k, []).get(k)).push([x1, y1]); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!ins(x, y)) continue;
    if (!ins(x, y - 1)) add(x, y, x + 1, y);
    if (!ins(x + 1, y)) add(x + 1, y, x + 1, y + 1);
    if (!ins(x, y + 1)) add(x + 1, y + 1, x, y + 1);
    if (!ins(x - 1, y)) add(x, y + 1, x, y);
  }
  const loops = [];
  for (const [k0, list] of edges) {
    while (list.length) {
      let x = k0 % (W + 1), y = Math.floor(k0 / (W + 1));
      const poly = [{ x, y }];
      let [nx, ny] = list.pop();
      let guard = 0;
      while (!(nx === poly[0].x && ny === poly[0].y) && guard++ < 4e6) {
        poly.push({ x: nx, y: ny });
        const l = edges.get(key(nx, ny)); if (!l || !l.length) break;
        [nx, ny] = l.pop();
      }
      if (poly.length > 3) loops.push(poly);
    }
  }
  return loops.map(poly => {
    const simp = rdp([...poly, poly[0]], tolerance * s).slice(0, -1);
    return { closed: true, pts: simp.map(p => anchor(p.x / s, p.y / s)) };
  }).filter(sp => sp.pts.length >= 3);
}

export function newPathRecord(name, subpaths = [], kind = 'saved') { return { id: uid(), name, kind, subpaths }; }

// ---------- ag-psd conversion ----------
export function toPsdPaths(subpaths) {
  return subpaths.map(s => ({
    open: !s.closed, operation: 'combine',
    knots: s.pts.map(p => ({ linked: !!p.smooth, points: [(p.in || p).x, (p.in || p).y, p.x, p.y, (p.out || p).x, (p.out || p).y] })),
  }));
}
export function fromPsdPaths(paths) {
  return (paths || []).map(ps => ({
    closed: !ps.open,
    pts: (ps.knots || []).map(k => { const [ix, iy, x, y, ox, oy] = k.points; const hasIn = Math.hypot(ix - x, iy - y) > 0.01, hasOut = Math.hypot(ox - x, oy - y) > 0.01; return { x, y, in: hasIn ? { x: ix, y: iy } : null, out: hasOut ? { x: ox, y: oy } : null, smooth: !!k.linked }; }),
  })).filter(s => s.pts.length);
}
