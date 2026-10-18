// 二值蒙版和轮廓：距离变换、腐蚀膨胀、去碎块、羽化、洪水填充、k-means，以及等值线描边和折线化简（patch、trace 用）。
// mask 都是 Uint8Array（0/1），宽 w 高 h。

// 每个像素到最近的 mask 像素的距离（两遍 3-4 chamfer，单位约等于像素）。
export function distanceTo(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) d[p] = mask[p] ? 0 : INF;
  const relax = (p, q, c) => { if (d[q] + c < d[p]) d[p] = d[q] + c; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x > 0) relax(p, p - 1, 3);
    if (y > 0) { relax(p, p - w, 3); if (x > 0) relax(p, p - w - 1, 4); if (x < w - 1) relax(p, p - w + 1, 4); }
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x;
    if (x < w - 1) relax(p, p + 1, 3);
    if (y < h - 1) { relax(p, p + w, 3); if (x < w - 1) relax(p, p + w + 1, 4); if (x > 0) relax(p, p + w - 1, 4); }
  }
  for (let p = 0; p < w * h; p++) d[p] /= 3;
  return d;
}
export function grow(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const d = distanceTo(mask, w, h), out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = d[p] <= r ? 1 : 0;
  return out;
}
export function shrink(mask, w, h, r) {
  if (r <= 0) return Uint8Array.from(mask);
  const inv = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
  const g = grow(inv, w, h, r), out = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) out[p] = g[p] ? 0 : 1;
  return out;
}

// 去掉面积小于 min 的连通块（4 邻接），返回新蒙版和去掉的块数。
export function dropSmall(mask, w, h, min) {
  const out = Uint8Array.from(mask), seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let dropped = 0;
  for (let s = 0; s < w * h; s++) {
    if (!out[s] || seen[s]) continue;
    const comp = [];
    let sp = 0;
    seen[s] = 1; stack[sp++] = s;
    while (sp) {
      const p = stack[--sp], x = p % w;
      comp.push(p);
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) if (q >= 0 && q < w * h && out[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
    }
    if (comp.length < min) { for (const p of comp) out[p] = 0; dropped++; }
  }
  return { mask: out, dropped };
}

// 羽化：蒙版里面是 1，外面按距离线性降到 f 像素处为 0。
export function feather(mask, w, h, f) {
  const d = distanceTo(mask, w, h), a = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) a[p] = mask[p] ? 1 : f > 0 ? Math.max(0, 1 - d[p] / f) : 0;
  return a;
}

// 从 seed 出发的洪水填充：和种子颜色的 Lab 色差小于 tol，且 ok(p) 为真（比如不是描边），限制在 box 里。
export function floodFill(labImg, w, h, seed, tol, box, ok = () => true) {
  // 框先和图像求交；种子不在框里就什么都不填
  const bx0 = Math.max(0, box[0]), by0 = Math.max(0, box[1]), bx1 = Math.min(w, box[2]), by1 = Math.min(h, box[3]), out = new Uint8Array(w * h), stack = [];
  if (seed[0] < bx0 || seed[1] < by0 || seed[0] >= bx1 || seed[1] >= by1) return out;
  const s = seed[1] * w + seed[0], L = labImg[s * 3], A = labImg[s * 3 + 1], B = labImg[s * 3 + 2];
  const near = (p) => Math.hypot(labImg[p * 3] - L, labImg[p * 3 + 1] - A, labImg[p * 3 + 2] - B) < tol && ok(p);
  if (!near(s)) return out;
  out[s] = 1; stack.push(s);
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p - x) / w;
    for (const [qx, qy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (qx < bx0 || qy < by0 || qx >= bx1 || qy >= by1) continue;
      const q = qy * w + qx;
      if (!out[q] && near(q)) { out[q] = 1; stack.push(q); }
    }
  }
  return out;
}

// Lab 点的 k-means，初值取亮度的分位点（结果可复现）；返回中心和每个点的类别。
export function kmeans(points, k, iters = 12) {
  const order = points.map((p, i) => i).sort((a, b) => points[a][0] - points[b][0]);
  let C = Array.from({ length: k }, (_, i) => points[order[Math.floor(((i + 0.5) / k) * (order.length - 1))]].slice(0, 3));
  const assign = new Int32Array(points.length);
  const d = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  for (let it = 0; it < iters; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => { let b = 0; for (let j = 1; j < k; j++) if (d(p, C[j]) < d(p, C[b])) b = j; assign[i] = b; acc[b][0] += p[0]; acc[b][1] += p[1]; acc[b][2] += p[2]; acc[b][3]++; });
    C = acc.map((a, j) => (a[3] ? [a[0] / a[3], a[1] / a[3], a[2] / a[3]] : C[j]));
  }
  return { centers: C, assign };
}

// 等值线：直接在 0/1 蒙版上用 marching squares 取 0.5 处的边界（坐标是像素中心，即 x+0.5），连成闭合折线。
// 不先做模糊：模糊会把 1 像素宽的细线（填色里的洞）填掉；锯齿交给 simplify 去平。
export function contours(mask, w, h) {
  const W = w + 2, H = h + 2, f = new Float32Array(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    f[(y + 1) * W + x + 1] = mask[y * w + x] ? 1 : 0;
  }
  const v = (x, y) => f[y * W + x], segs = [];
  const lerp = (a, b, va, vb) => a + (0.5 - va) / (vb - va) * (b - a);
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = v(x, y), b = v(x + 1, y), c = v(x + 1, y + 1), d = v(x, y + 1);
    const idx = (a > 0.5 ? 8 : 0) | (b > 0.5 ? 4 : 0) | (c > 0.5 ? 2 : 0) | (d > 0.5 ? 1 : 0);
    if (idx === 0 || idx === 15) continue;
    const top = [lerp(x, x + 1, a, b), y], right = [x + 1, lerp(y, y + 1, b, c)], bottom = [lerp(x, x + 1, d, c), y + 1], left = [x, lerp(y, y + 1, a, d)];
    const mid = (a + b + c + d) / 4 > 0.5;
    const cases = { 1: [[left, bottom]], 2: [[bottom, right]], 3: [[left, right]], 4: [[top, right]], 5: mid ? [[left, top], [bottom, right]] : [[left, bottom], [top, right]], 6: [[top, bottom]], 7: [[left, top]], 8: [[left, top]], 9: [[top, bottom]], 10: mid ? [[top, right], [left, bottom]] : [[top, left], [bottom, right]], 11: [[top, right]], 12: [[left, right]], 13: [[bottom, right]], 14: [[left, bottom]] };
    for (const s of cases[idx]) segs.push(s);
  }
  // 按端点连成折线；坐标换回原图（减去 1 格补边，再加 0.5 到像素中心）
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`, ends = new Map();
  segs.forEach((s, i) => { for (const e of [0, 1]) { const k = key(s[e]); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Uint8Array(segs.length), polys = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const poly = [segs[i][0], segs[i][1]];
    for (;;) {
      const last = poly[poly.length - 1], next = (ends.get(key(last)) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next];
      poly.push(key(s[0]) === key(last) ? s[1] : s[0]);
    }
    if (poly.length > 3) polys.push(poly.map(([x, y]) => [x - 0.5, y - 0.5]));
  }
  return polys;
}

// 闭合折线的 Douglas–Peucker 化简（eps 像素）。
export function simplify(poly, eps) {
  if (poly.length < 5 || eps <= 0) return poly;
  const dp = (pts) => {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
    let far = 0, at = 0;
    for (let i = 1; i < pts.length - 1; i++) { const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / L; if (d > far) { far = d; at = i; } }
    if (far <= eps) return [a, b];
    return [...dp(pts.slice(0, at + 1)).slice(0, -1), ...dp(pts.slice(at))];
  };
  const half = Math.floor(poly.length / 2);
  return [...dp(poly.slice(0, half + 1)).slice(0, -1), ...dp([...poly.slice(half), poly[0]]).slice(0, -1)];
}

export const pathData = (polys, dx = 0, dy = 0) => polys.map((p) => 'M' + p.map(([x, y]) => `${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`).join(' L') + ' Z').join(' ');

// 把闭合折线按奇偶规则填到 w×h 的蒙版上（和 SVG 的 fill-rule="evenodd" 一致），用来让对照图反映最终的 SVG。
export function rasterize(polys, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5, xs = [];
    for (const poly of polys) for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
      if ((y1 <= yc) !== (y2 <= yc)) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) out[y * w + x] = 1;
  }
  return out;
}
