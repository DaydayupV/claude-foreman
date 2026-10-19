// 零依赖矢量化：把一个透明底的部件（RGBA）转成层叠的平涂 SVG（曲线路径），以及把这种 SVG 栅格化回来做检查。
// 做法：自适应减色 → 按颜色分连通块、碎块并进旁边的块 → 大块在下、小块在上层叠（每块补洞，和后画的块相邻处
// 多垫 1 像素，免得两块之间透出发丝缝）→ marching squares 取轮廓 → 找角点 → 角点之间用三次贝塞尔曲线拟合。
import * as P from './assets-pixels.mjs';
import * as S from './assets-shapes.mjs';

// 1. 减色：从一簇开始，反复把误差最大的一簇沿方差最大的 Lab 分量从均值处一分为二，
//    直到每簇 95% 的点离中心都在 tol 以内或簇数到 maxColors；再做几轮 k-means。返回每个像素的颜色号（透明为 -1）和每色的平均 RGB。
//    选颜色不用过渡像素：颜色介于某两个邻居之间（离两边都在 tol 以外，两边色差之和不超过两邻居之间色差的 1.2 倍），
//    描边和填色之间抗锯齿的过渡色就是这样，它们不单独成一色，归到最近的颜色。比两侧都深或都浅的细线像素不算过渡，
//    只出现在细线上的颜色也能选上；渐变和噪点的邻居色差小，照样参与。不是过渡的像素不到三成时用全部像素
export function quantize(buf, w, h, { tol = 7, maxColors = 32 } = {}) {
  const n = w * h, lab = new Float32Array(n * 3), solid = [];
  for (let p = 0; p < n; p++) if (buf[p * 4 + 3] >= 128) { const c = P.lab(buf[p * 4], buf[p * 4 + 1], buf[p * 4 + 2]); lab.set(c, p * 3); solid.push(p); }
  const index = new Int16Array(n).fill(-1);
  if (!solid.length) return { index, colors: [] };
  const d2 = (p, c) => (lab[p * 3] - c[0]) ** 2 + (lab[p * 3 + 1] - c[1]) ** 2 + (lab[p * 3 + 2] - c[2]) ** 2;
  const dpq = (p, q) => Math.hypot(lab[p * 3] - lab[q * 3], lab[p * 3 + 1] - lab[q * 3 + 1], lab[p * 3 + 2] - lab[q * 3 + 2]);
  const transitional = (p) => {
    const x = p % w, nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w].filter((q) => q >= 0 && q < n && buf[q * 4 + 3] >= 128);
    for (let i = 0; i < nb.length; i++) for (let j = i + 1; j < nb.length; j++) {
      const da = dpq(p, nb[i]), db = dpq(p, nb[j]);
      if (da >= tol && db >= tol && da + db <= 1.2 * dpq(nb[i], nb[j])) return true;
    }
    return false;
  };
  const flat = solid.filter((p) => !transitional(p));
  const base = flat.length >= Math.max(50, solid.length * 0.3) ? flat : solid, step = Math.max(1, Math.floor(base.length / 30000)), sample = base.filter((_, i) => i % step === 0);
  const stats = (pts) => {
    const m = [0, 0, 0];
    for (const p of pts) for (let k = 0; k < 3; k++) m[k] += lab[p * 3 + k];
    for (let k = 0; k < 3; k++) m[k] /= pts.length;
    const ds = pts.map((p) => d2(p, m)).sort((a, b) => a - b);
    return { pts, mean: m, p95: Math.sqrt(ds[Math.floor((ds.length - 1) * 0.95)]), sse: ds.reduce((a, b) => a + b, 0) };
  };
  let clusters = [stats(sample)];
  while (clusters.length < maxColors) {
    const open = clusters.filter((c) => c.p95 > tol && c.pts.length > 1);
    if (!open.length) break;
    const c = open.reduce((a, b) => (b.sse > a.sse ? b : a));
    const v = [0, 1, 2].map((k) => c.pts.reduce((a, p) => a + (lab[p * 3 + k] - c.mean[k]) ** 2, 0)), axis = v.indexOf(Math.max(...v));
    const lo = c.pts.filter((p) => lab[p * 3 + axis] < c.mean[axis]), hi = c.pts.filter((p) => lab[p * 3 + axis] >= c.mean[axis]);
    if (!lo.length || !hi.length) { c.p95 = 0; continue; }
    clusters = clusters.filter((x) => x !== c).concat([stats(lo), stats(hi)]);
  }
  let centers = clusters.map((c) => c.mean);
  const nearest = (p) => { let b = 0, bd = Infinity; centers.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; b = i; } }); return b; };
  for (let it = 0; it < 4; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const p of sample) { const i = nearest(p), a = acc[i]; for (let k = 0; k < 3; k++) a[k] += lab[p * 3 + k]; a[3]++; }
    centers = acc.map((a, i) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : centers[i]));
  }
  // 中心之间色差小于 0.8 × tol 的合成一种（一片橙色被分成两三种几乎一样的橙，拼成补丁，矢量化后边上会鼓包）
  for (let merged = true; merged && centers.length > 1;) {
    merged = false;
    for (let i = 0; i < centers.length && !merged; i++) for (let j = i + 1; j < centers.length && !merged; j++) {
      const a = centers[i], b = centers[j];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.8 * tol) { centers[i] = a.map((v, k) => (v + b[k]) / 2); centers.splice(j, 1); merged = true; }
    }
  }
  const rgb = centers.map(() => [0, 0, 0, 0]);
  for (const p of solid) { const i = nearest(p); index[p] = i; for (let k = 0; k < 3; k++) rgb[i][k] += buf[p * 4 + k]; rgb[i][3]++; }
  return { index, colors: rgb.map((a) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]].map(Math.round) : [0, 0, 0])) };
}

// 4 邻接连通块：返回每个像素的块号和每块的 { color, area }
function components(index, w, h) {
  const n = w * h, label = new Int32Array(n).fill(-1), comps = [], stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (index[s] < 0 || label[s] >= 0) continue;
    const id = comps.length, col = index[s];
    let sp = 0, area = 0;
    label[s] = id; stack[sp++] = s;
    while (sp) {
      const p = stack[--sp], x = p % w; area++;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < n && label[q] < 0 && index[q] === col) { label[q] = id; stack[sp++] = q; }
    }
    comps.push({ color: col, area });
  }
  return { label, comps };
}

// 2. 碎块（面积 < minArea）改成邻居里颜色最接近的那种；细条（没有一个上下左右都同色的内部像素）只有颜色介于两侧之间时
//    才并（那是抗锯齿过渡带），比两侧都深或都浅的是真的细线，留着；四周只有透明的碎块去掉。
//    从小到大逐个处理，每块都按邻居当前的颜色决定：先并过去的块会和邻居同色，后面的邻居看到同色就不再动，
//    不会出现两块互相并向对方、只是交换了颜色。最多做三轮，没有变化就停
function mergeSpeckles(index, w, h, minArea, labs, tol) {
  const n = w * h, dist = (a, b) => Math.hypot(labs[a][0] - labs[b][0], labs[a][1] - labs[b][1], labs[a][2] - labs[b][2]);
  for (let pass = 0; pass < 3; pass++) {
    const { label, comps } = components(index, w, h);
    comps.forEach((c, id) => { c.id = id; c.px = []; c.inner = 0; });
    for (let p = 0; p < n; p++) {
      const id = label[p]; if (id < 0) continue;
      comps[id].px.push(p);
      const x = p % w;
      if (x > 0 && x < w - 1 && p >= w && p < n - w && label[p - 1] === id && label[p + 1] === id && label[p - w] === id && label[p + w] === id) comps[id].inner++;
    }
    let changed = 0;
    for (const c of comps.filter((c) => c.area < minArea || c.inner === 0).sort((a, b) => a.area - b.area || a.id - b.id)) {
      const col = index[c.px[0]], votes = new Map();
      let opaque = false;
      for (const p of c.px) {
        const x = p % w;
        for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
          if (q < 0 || q >= n || label[q] === c.id || index[q] < 0) continue;
          opaque = true;
          if (index[q] !== col) votes.set(index[q], (votes.get(index[q]) || 0) + 1);
        }
      }
      let to = null;
      if (!opaque) { if (c.area < minArea) to = -1; }
      else if (votes.size) {   // 邻居都已同色时这块已经和它们连成一片，不用动
        const ranked = [...votes].sort((a, b) => b[1] - a[1]), A = ranked[0][0], B = ranked[1]?.[0];
        if (c.area < minArea) to = ranked.reduce((best, [k]) => (dist(k, col) < dist(best, col) ? k : best), A);
        else if (B != null ? dist(A, col) + dist(col, B) <= 1.2 * dist(A, B) : dist(A, col) < 2.5 * tol) to = B != null && dist(B, col) < dist(A, col) ? B : A;
      }
      if (to === null) continue;
      for (const p of c.px) index[p] = to;
      changed++;
    }
    if (!changed) return;
  }
}

// 被不透明像素围住、面积小于 minArea 的透明小洞（抠底在描边里留下的针眼）填成周围最多的颜色
function fillPinholes(index, w, h, minArea) {
  const n = w * h, seen = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0 || seen[s]) continue;
    const comp = [], stack = [s], votes = new Map();
    let border = false;
    seen[s] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      comp.push(p);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n) continue;
        if (index[q] >= 0) votes.set(index[q], (votes.get(index[q]) || 0) + 1);
        else if (!seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (border || comp.length >= minArea || !votes.size) continue;
    const col = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    for (const p of comp) index[p] = col;
  }
}

// 3. 曲线拟合（Schneider）：一段折线用尽量少的三次贝塞尔曲线拟合，最大误差不超过 err 像素
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1], len = (a) => Math.hypot(a[0], a[1]), unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const bez = (c, t) => { const u = 1 - t; return add(add(mul(c[0], u * u * u), mul(c[1], 3 * u * u * t)), add(mul(c[2], 3 * u * t * t), mul(c[3], t * t * t))); };
function fitSegment(pts, t1, t2, err, out) {
  const p0 = pts[0], pN = pts[pts.length - 1], ch = sub(pN, p0), cl = len(ch) || 1;
  // 只有两个点、或者沿线总长不到 1.5 像素（角上的小斜边）的段直接用直线；点都在弦 0.5 像素以内时也用直线。
  // 看沿线长度不看弦长：两个角点挨着时，绕一圈的那一段首尾也挨着，弦很短但不是直线
  let arc = 0;
  for (let i = 1; i < pts.length; i++) arc += len(sub(pts[i], pts[i - 1]));
  if (pts.length === 2 || arc <= 1.5 || (len(ch) > 1 && pts.every((p) => Math.abs((p[0] - p0[0]) * ch[1] - (p[1] - p0[1]) * ch[0]) / cl <= Math.min(0.5, err)))) { out.push({ line: [p0, pN] }); return; }
  let u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  u = u.map((x) => x / (u[u.length - 1] || 1));
  const generate = (u) => {
    const A = u.map((t) => [mul(t1, 3 * (1 - t) ** 2 * t), mul(t2, 3 * (1 - t) * t * t)]);
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    const p0 = pts[0], p3 = pts[pts.length - 1];
    u.forEach((t, i) => {
      c00 += dot(A[i][0], A[i][0]); c01 += dot(A[i][0], A[i][1]); c11 += dot(A[i][1], A[i][1]);
      const b = (1 - t) ** 3 + 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t + t ** 3;
      const tmp = sub(pts[i], add(mul(p0, b), mul(p3, c)));
      x0 += dot(A[i][0], tmp); x1 += dot(A[i][1], tmp);
    });
    const det = c00 * c11 - c01 * c01, seg = len(sub(p3, p0));
    let a1 = det ? (x0 * c11 - x1 * c01) / det : 0, a2 = det ? (c00 * x1 - c01 * x0) / det : 0;
    if (a1 < seg * 1e-3 || a2 < seg * 1e-3) a1 = a2 = seg / 3;   // 退化时用弦长的三分之一
    return [p0, add(p0, mul(t1, a1)), add(p3, mul(t2, a2)), p3];
  };
  const maxErr = (c, u) => { let m = 0, at = Math.floor(pts.length / 2); u.forEach((t, i) => { const d = len(sub(bez(c, t), pts[i])); if (d > m) { m = d; at = i; } }); return [m, at]; };
  let c = generate(u), [e, at] = maxErr(c, u);
  for (let it = 0; e > err && e < err * 4 && it < 4; it++) {   // 牛顿法改参数再试
    u = u.map((t, i) => {
      const d = sub(bez(c, t), pts[i]), q1 = [0, 1, 2].map((k) => mul(sub(c[k + 1], c[k]), 3)), q2 = [0, 1].map((k) => mul(sub(q1[k + 1], q1[k]), 2));
      const b1 = add(add(mul(q1[0], (1 - t) ** 2), mul(q1[1], 2 * (1 - t) * t)), mul(q1[2], t * t)), b2 = add(mul(q2[0], 1 - t), mul(q2[1], t));
      const den = dot(b1, b1) + dot(d, b2);
      return den ? Math.min(1, Math.max(0, t - dot(d, b1) / den)) : t;
    });
    c = generate(u); [e, at] = maxErr(c, u);
  }
  if (e <= err) { out.push(c); return; }
  at = Math.min(pts.length - 2, Math.max(1, at));
  const tc = unit(sub(pts[at - 1], pts[at + 1]));
  fitSegment(pts.slice(0, at + 1), t1, tc, err, out);
  fitSegment(pts.slice(at), mul(tc, -1), t2, err, out);
}

// 一个闭合轮廓：去重、平滑台阶、找角点（前后约 3 像素方向的夹角超过 corner 度），角点之间分段拟合
function fitLoop(poly, err, corner, passes = 3) {
  let pts = poly.filter((p, i) => i === 0 || len(sub(p, poly[i - 1])) > 1e-6);
  const n = pts.length;
  if (n < 8) return { line: pts };
  const at = (i) => pts[((i % n) + n) % n], K = 3;
  const turn = pts.map((_, i) => { const a = unit(sub(at(i), at(i - K))), b = unit(sub(at(i + K), at(i))); return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI; });
  let corners = [];
  for (let i = 0; i < n; i++) if (turn[i] > corner && [1, 2].every((k) => turn[i] >= turn[(i + k) % n] && turn[i] >= turn[(i - k + n) % n])) corners.push(i);
  // 台阶平滑（角点不动）：三轮 1-2-1 平均
  const isCorner = new Uint8Array(n); corners.forEach((i) => { isCorner[i] = 1; });
  for (let pass = 0; pass < passes; pass++) pts = pts.map((p, i) => (isCorner[i] ? p : mul(add(add(at(i - 1), mul(p, 2)), at(i + 1)), 0.25)));
  // 没有角点时人为切成两段；只有一个角点时在它对面加一个切点（一段首尾重合的轮廓没法拟合）
  if (!corners.length) corners = [0, Math.floor(n / 2)];
  else if (corners.length === 1) corners = [corners[0], (corners[0] + Math.floor(n / 2)) % n].sort((a, b) => a - b);
  const tangentAt = (i, dir) => unit(dir > 0 ? sub(at(i + 2), at(i)) : sub(at(i - 2), at(i)));
  const curves = [];
  corners.forEach((c0, k) => {
    const c1 = corners[(k + 1) % corners.length], seg = [];
    for (let i = c0; ; i++) { seg.push(at(i)); if ((i % n) === c1 && seg.length > 1) break; if (seg.length > n + 1) break; }
    const smooth0 = !isCorner[c0], smooth1 = !isCorner[c1];   // 没有角点时人为切的两处，切线取前后对称方向，接得平滑
    const t1 = smooth0 ? unit(sub(at(c0 + 1), at(c0 - 1))) : tangentAt(c0, 1);
    const t2 = smooth1 ? unit(sub(at(c1 - 1), at(c1 + 1))) : tangentAt(c1, -1);
    fitSegment(seg, t1, t2, err, curves);
  });
  // 拟合后面积不到原来的一半或者方向反了（1 像素宽的细长轮廓两边都被判成直线时会压成零面积），退回折线：
  // 先按 0.25 像素化简（比两边相距的一半还小，不会再压扁），化简后仍然塌了才用全部的点
  const a0 = signedArea(pts), collapsed = (poly) => { const a = signedArea(poly); return Math.sign(a) !== Math.sign(a0) || Math.abs(a) < 0.5 * Math.abs(a0); };
  if (collapsed(curves.flatMap((c) => (c.line ? [c.line[0]] : [0, 0.25, 0.5, 0.75].map((t) => bez(c, t)))))) {
    const simple = S.simplify(pts, 0.25);
    return { line: simple.length >= 3 && !collapsed(simple) ? simple : pts };
  }
  return { curves };
}

const num = (v) => { const r = Math.round(v * 10) / 10; return (Object.is(r, -0) ? 0 : r).toString(); };
function loopData(loop) {
  if (loop.line) return 'M' + loop.line.map((p) => `${num(p[0])} ${num(p[1])}`).join('L') + 'Z';
  const c = loop.curves;
  const first = c[0].line ? c[0].line[0] : c[0][0];
  return `M${num(first[0])} ${num(first[1])}` + c.map((b) => (b.line ? `L${num(b.line[1][0])} ${num(b.line[1][1])}` : `C${[b[1], b[2], b[3]].map((p) => `${num(p[0])} ${num(p[1])}`).join(' ')}`)).join('') + 'Z';
}

export function curvePaths(layers, simplify, reach) {
  if (simplify <= 0) return layers.map((p) => S.pathData(p));
  const err = Math.min(0.3, simplify);
  const loops = layers.map((polys) => polys.map((poly) => {
    const raw = [];
    let carry = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], d = len(sub(b, a));
      for (let t = carry; t < d; t++) raw.push(add(a, mul(sub(b, a), t / d)));
      carry = ((carry - d) % 1 + 1) % 1;
    }
    const n = raw.length, at = (i) => raw[(i + n) % n];
    // 同一弧长滤波保留平行边的间距，不依赖各层折线顶点。
    const smooth = n < 8 ? raw : raw.map((p, i) => {
      const q = [0, 0];
      let total = 0;
      for (let j = -6; j <= 6; j++) { const weight = Math.exp(-j * j / 6); total += weight; for (let k = 0; k < 2; k++) q[k] += at(i + j)[k] * weight; }
      return mul(q, 1 / total);
    });
    return { raw, smooth, poly };
  }));
  const gridOf = (polys) => {
    const grid = new Map();
    for (const loop of polys) loop.raw.forEach((p, i) => {
      const key = Math.floor(p[0] / 4) + ',' + Math.floor(p[1] / 4);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push({ loop, i });
    });
    return grid;
  };
  const tangent = (l, i) => unit(sub(l.smooth[(i + 2) % l.raw.length], l.smooth[(i - 2 + l.raw.length) % l.raw.length]));
  const nearby = (grid, p, radius) => {
    const result = [], r = Math.ceil(radius / 4), x = Math.floor(p[0] / 4), y = Math.floor(p[1] / 4);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) for (const q of grid.get((x + dx) + ',' + (y + dy)) || []) result.push(q);
    return result;
  };
  const outer = gridOf(loops[0]);
  for (const loop of loops[1]) {
    const pairs = loop.raw.map((p, i) => {
      let best = null, dist = reach + 2;
      const t = tangent(loop, i);
      for (const q of nearby(outer, p, dist)) {
        const raw = q.loop.raw[q.i], d = len(sub(p, raw)), qt = tangent(q.loop, q.i);
        if (d >= dist || Math.abs(dot(t, qt)) < 0.9) continue;
        const normal = [-qt[1], qt[0]], width = dot(sub(p, raw), normal);
        if (Math.abs(width) < 0.5 || Math.abs(dot(sub(p, raw), qt)) > 1) continue;
        best = { q, normal, width }; dist = d;
      }
      return best;
    });
    // 外沿闭环必须共用平滑几何，否则无描边的部件会露出黑缝。
    loop.inner = pairs.every((p) => !p) && !loop.raw.some((p) => nearby(outer, p, reach + 2).some((q) => len(sub(p, q.loop.raw[q.i])) <= reach + 2));
    loop.smooth = loop.smooth.map((p, i) => {
      const pair = pairs[i];
      if (!pair) return p;
      const widths = [];
      for (let j = -10; j <= 10; j++) { const b = pairs[(i + j + pairs.length) % pairs.length]; if (b && b.width * pair.width > 0) widths.push(b.width); }
      widths.sort((a, b) => a - b);
      const target = add(pair.q.loop.smooth[pair.q.i], mul(pair.normal, widths[widths.length >> 1]));
      const delta = sub(target, p);
      return add(p, mul(delta, Math.min(1, 0.5 / (len(delta) || 1))));
    });
  }
  // 阴影碰到底色外沿时沿用同一位移，免得阴影又把描边盖薄。
  const base = gridOf(loops[1]);
  for (const layer of loops.slice(2)) for (const loop of layer) loop.smooth = loop.smooth.map((p, i) => {
    let best = null, dist = 0.8;
    for (const q of nearby(base, loop.raw[i], dist)) {
      const d = len(sub(loop.raw[i], q.loop.raw[q.i]));
      if (d < dist && Math.abs(dot(tangent(loop, i), tangent(q.loop, q.i))) > 0.9) { best = q; dist = d; }
    }
    return best ? add(loop.raw[i], sub(best.loop.smooth[best.i], best.loop.raw[best.i])) : p;
  });
  return loops.map((layer) => layer.map((l) => {
    if (l.inner) return S.pathData([S.simplify(l.poly, simplify)]);
    return loopData(fitLoop(l.smooth, err, 90, 0));
  }).join(' '));
}
const signedArea = (poly) => poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;

// 主函数：返回 { svg, paths, colors }。opts：tol 减色的色差、maxColors、minArea 碎块面积、err 拟合误差（像素）、corner 角点角度
export function vectorize(buf, w, h, { tol = 7, maxColors = 32, minArea = 12, err = 0.6, corner = 60 } = {}) {
  const { index, colors } = quantize(buf, w, h, { tol, maxColors });
  fillPinholes(index, w, h, minArea);
  mergeSpeckles(index, w, h, minArea, colors.map((c) => P.lab(...c)), tol);
  const { label, comps } = components(index, w, h);
  // 每块补洞后的面积决定层叠顺序：大的先画；补洞的部分本来就属于后画的块，会被盖住
  comps.forEach((c, id) => { c.id = id; c.box = [w, h, -1, -1]; });
  for (let p = 0; p < w * h; p++) { const id = label[p]; if (id < 0) continue; const b = comps[id].box, x = p % w, y = (p / w) | 0; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  for (const c of comps) {
    const [x0, y0, x1, y1] = c.box, bw = x1 - x0 + 3, bh = y1 - y0 + 3, m = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (label[y * w + x] === c.id) m[(y - y0 + 1) * bw + x - x0 + 1] = 1;
    c.local = { x0: x0 - 1, y0: y0 - 1, bw, bh, m };
    // 补洞：从框边走不到的、被别的颜色占着的地方（透明的洞不补）
    const out = new Uint8Array(bw * bh), st = [];
    for (let x = 0; x < bw; x++) st.push(x, (bh - 1) * bw + x); for (let y = 0; y < bh; y++) st.push(y * bw, y * bw + bw - 1);
    while (st.length) { const p = st.pop(); if (out[p] || m[p]) continue; out[p] = 1; const x = p % bw; if (x > 0) st.push(p - 1); if (x < bw - 1) st.push(p + 1); if (p >= bw) st.push(p - bw); if (p < bw * bh - bw) st.push(p + bw); }
    c.filled = 0;
    for (let p = 0; p < bw * bh; p++) {
      if (out[p]) continue;
      const gx = (p % bw) + c.local.x0, gy = ((p / bw) | 0) + c.local.y0;
      if (m[p] || (gx >= 0 && gy >= 0 && gx < w && gy < h && label[gy * w + gx] >= 0)) { m[p] = 1; c.filled++; }
    }
  }
  const order = [...comps].sort((a, b) => b.filled - a.filled), rank = new Int32Array(comps.length);
  order.forEach((c, r) => { rank[c.id] = r; });
  const parts = [];
  for (const c of order) {
    const { x0, y0, bw, bh, m } = c.local, ext = Uint8Array.from(m);
    // 和后画的块相邻的地方往外垫 1 像素（那里会被后画的块盖住）
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
      const gx = x + x0, gy = y + y0, q = gy * w + gx;
      if (m[y * bw + x] || gx < 0 || gy < 0 || gx >= w || gy >= h || label[q] < 0 || rank[label[q]] <= rank[c.id]) continue;
      if (m[y * bw + x - 1] || m[y * bw + x + 1] || m[(y - 1) * bw + x] || m[(y + 1) * bw + x]) ext[y * bw + x] = 1;
    }
    // 所有轮廓转成实心在走向左手边：第一段的中点往左法线方向挪 0.5 像素，落在实心像素上就不用反过来。
    // 这样外轮廓和洞的方向自然相反，nonzero 规则下洞留空，同色的两层合成一条路径、互相重叠也不会挖出洞
    const solidLeft = (g) => {
      let k = 0;
      while (k < g.length - 1 && len(sub(g[k + 1], g[k])) < 0.1) k++;
      const a = g[k], b = g[(k + 1) % g.length], d = unit(sub(b, a)), qx = (a[0] + b[0]) / 2 - d[1] * 0.5, qy = (a[1] + b[1]) / 2 + d[0] * 0.5;
      const lx = Math.floor(qx - x0), ly = Math.floor(qy - y0);
      return lx >= 0 && ly >= 0 && lx < bw && ly < bh && ext[ly * bw + lx] === 1;
    };
    const loops = S.contours(ext, bw, bh).map((poly) => poly.map(([x, y]) => [x + x0, y + y0])).filter((g) => Math.abs(signedArea(g)) >= 1)
      .map((g) => (solidLeft(g) ? g : g.slice().reverse()));
    if (!loops.length) continue;
    const d = loops.map((g) => loopData(fitLoop(g, err, corner))).join('');
    const fill = P.hex(colors[c.color]);
    const last = parts[parts.length - 1];
    if (last && last.fill === fill) last.d += d; else parts.push({ fill, d });   // 相邻两层同色就合成一条路径
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` + parts.map((p) => `<path fill="${p.fill}" d="${p.d}"/>`).join('') + '</svg>';
  return { svg, paths: parts.length, colors: colors.length };
}

// 把 SVG 画回 RGBA（按像素中心采样，不做抗锯齿），用来量轮廓重合度和颜色误差。
// 认 M/L/C/Z 命令和 <path> 上任意顺序的 fill、fill-rule（默认 nonzero，也认 evenodd），vectorize 和 trace 写出的 SVG 都能画
export function render(svg, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (const m of svg.matchAll(/<path\b([^>]*)\/>/g)) {
    const attr = (k) => (m[1].match(new RegExp(`\\b${k}="([^"]*)"`)) || [])[1], fill = attr('fill'), d = attr('d');
    if (!fill || !d || !/^#[0-9a-fA-F]{6}$/.test(fill)) continue;
    const col = P.parseHex(fill), evenodd = attr('fill-rule') === 'evenodd', edges = [];
    for (const sp of d.split('Z').filter((s) => s.trim())) {
      const tok = sp.match(/[MLC]|-?\d*\.?\d+/g), pts = [];
      let cmd = null, cur = null;
      for (let i = 0; i < tok.length;) {
        if (/[MLC]/.test(tok[i])) { cmd = tok[i++]; continue; }
        if (cmd === 'C') {
          const c = [cur, [+tok[i], +tok[i + 1]], [+tok[i + 2], +tok[i + 3]], [+tok[i + 4], +tok[i + 5]]]; i += 6;
          const steps = Math.max(2, Math.min(32, Math.ceil((len(sub(c[1], c[0])) + len(sub(c[2], c[1])) + len(sub(c[3], c[2]))) / 3)));
          for (let k = 1; k <= steps; k++) pts.push(bez(c, k / steps));
          cur = c[3];
        } else { cur = [+tok[i], +tok[i + 1]]; i += 2; pts.push(cur); }
      }
      for (let i = 0; i < pts.length; i++) edges.push([pts[i], pts[(i + 1) % pts.length]]);
    }
    for (let y = 0; y < h; y++) {
      const yc = y + 0.5, xs = [];
      for (const [a, b] of edges) if ((a[1] <= yc) !== (b[1] <= yc)) xs.push([a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]), b[1] > a[1] ? 1 : -1]);
      xs.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let k = 0; k + 1 < xs.length; k++) {
        wind += evenodd ? 1 : xs[k][1];
        if (evenodd ? wind % 2 === 0 : !wind) continue;
        for (let x = Math.max(0, Math.ceil(xs[k][0] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1][0] - 0.5)); x++) { const q = (y * w + x) * 4; out[q] = col[0]; out[q + 1] = col[1]; out[q + 2] = col[2]; out[q + 3] = 255; }
      }
    }
  }
  return out;
}

