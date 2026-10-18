// assets 子命令用到的像素运算：颜色距离、去背景、边缘反求、切部件、减色、缩小和画格子模板。只用 Node 内置能力。

// sRGB 0-255 → CIE Lab（D65）。
export function lab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), fy = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const fz = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
export const parseHex = (s) => /^#?[0-9a-f]{6}$/i.test(s.trim()) ? [0, 2, 4].map((i) => parseInt(s.trim().replace('#', '').slice(i, i + 2), 16)) : null;
export function nearest(l, labs) {
  let best = 0, bd = Infinity;
  labs.forEach((c, j) => { const d = dE(l, c); if (d < bd) { bd = d; best = j; } });
  return { index: best, distance: bd };
}

// 画布最外 4 像素一圈的中位色当底色，并给出这一圈有多少像素和它几乎一样（色差 < 6）。
export function borderKey(px, w, h, ring = 4) {
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= ring && y >= ring && x < w - ring && y < h - ring) continue;
    const i = (y * w + x) * 4; rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2]);
  }
  const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const key = [med(rs), med(gs), med(bs)], kl = lab(...key);
  let near = 0;
  for (let i = 0; i < rs.length; i++) if (dE(lab(rs[i], gs[i], bs[i]), kl) < 6) near++;
  return { key, uniform: near / rs.length };
}

// 按到底色的色差算 alpha：< inner 全透明，> outer 不透明，中间线性。global 处理所有像素；
// flood 只去掉和画布边缘连通的底色（白底时用，避免把主体内部的白色抠掉），也会走到抗锯齿边缘（< solid）。
export function keyAlpha(px, w, h, key, { inner = 10, outer = 34, solid = 70, flood = false } = {}) {
  const n = w * h, kl = lab(...key), dist = new Float32Array(n), alpha = new Uint8Array(n);
  for (let p = 0; p < n; p++) dist[p] = dE(lab(px[p * 4], px[p * 4 + 1], px[p * 4 + 2]), kl);
  const ramp = (d) => (d <= inner ? 0 : d >= outer ? 255 : Math.round(((d - inner) / (outer - inner)) * 255));
  if (!flood) { for (let p = 0; p < n; p++) alpha[p] = ramp(dist[p]); return { alpha, dist, reached: null }; }
  alpha.fill(255);
  const reached = new Uint8Array(n), stack = new Int32Array(n);
  let sp = 0;
  const push = (p) => { if (!reached[p] && dist[p] < solid) { reached[p] = 1; stack[sp++] = p; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp) {
    const p = stack[--sp];
    alpha[p] = ramp(dist[p]);
    if (dist[p] >= inner) continue; // 已经是边缘像素，不再往里走
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < n - w) push(p + w);
  }
  return { alpha, dist, reached };
}

// 去掉半透明边缘里混进来的底色：F = (C - (1 - a)K) / a，结果写进新的 RGBA。
export function despill(px, alpha, key) {
  const out = Buffer.from(px);
  for (let p = 0; p < alpha.length; p++) {
    const a = alpha[p] / 255, i = p * 4;
    out[i + 3] = alpha[p];
    if (a <= 0 || a >= 1) continue;
    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round((px[i + c] - (1 - a) * key[c]) / a)));
  }
  return out;
}

// 边缘反求：底色和实心色之间的像素取 radius 内最近的实心像素颜色 F，alpha 取 C 在 K→F 连线上的投影。
// 找不到实心邻居的像素保留原来的 alpha。flood 模式下只处理洪水走到的像素。
export function refineEdges(px, base, w, h, key, alpha, dist, { inner = 10, solid = 70, radius = 4, reached = null } = {}) {
  const out = Buffer.from(base);
  for (let p = 0; p < w * h; p++) {
    if (dist[p] <= inner || dist[p] >= solid || (reached && !reached[p])) continue;
    const x = p % w, y = (p / w) | 0;
    let best = -1, bd = Infinity;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx, d = dx * dx + dy * dy;
      if (dist[q] >= solid && d < bd) { bd = d; best = q; }
    }
    if (best < 0) continue;
    let num = 0, den = 0;
    for (let c = 0; c < 3; c++) { const fk = px[best * 4 + c] - key[c]; num += (px[p * 4 + c] - key[c]) * fk; den += fk * fk; }
    alpha[p] = Math.round(Math.max(0, Math.min(1, num / Math.max(1, den))) * 255);
    for (let c = 0; c < 3; c++) out[p * 4 + c] = px[best * 4 + c];
    out[p * 4 + 3] = alpha[p];
  }
  return out;
}

// 方形膨胀（逐行、逐列各扫两遍）。
function dilate(mask, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0, last = -Infinity; x < w; x++) { if (mask[y * w + x]) last = x; if (x - last <= r) tmp[y * w + x] = 1; }
    for (let x = w - 1, last = Infinity; x >= 0; x--) { if (mask[y * w + x]) last = x; if (last - x <= r) tmp[y * w + x] = 1; }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0, last = -Infinity; y < h; y++) { if (tmp[y * w + x]) last = y; if (y - last <= r) out[y * w + x] = 1; }
    for (let y = h - 1, last = Infinity; y >= 0; y--) { if (tmp[y * w + x]) last = y; if (last - y <= r) out[y * w + x] = 1; }
  }
  return out;
}

// alpha ≥ threshold 的像素分成部件：相距不到 2×gap 像素的碎块算同一个；面积小于 minArea 的记为碎屑丢掉。
// 柔边素材把 threshold 调低，部件的范围才包括柔边。
// 返回按阅读顺序（先按行带，再从左到右）排好的部件和每个像素所属部件的 label。
export function splitParts(alpha, w, h, { gap = 6, minArea = 0, threshold = 128 } = {}) {
  const n = w * h, solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) solid[p] = alpha[p] >= threshold ? 1 : 0;
  const grown = dilate(solid, w, h, gap), label = new Int32Array(n).fill(-1), stack = new Int32Array(n), parts = [];
  for (let s = 0; s < n; s++) {
    if (!grown[s] || label[s] >= 0) continue;
    const id = parts.length;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    label[s] = id; stack[sp++] = s;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p / w) | 0;
      if (solid[p]) { area++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && grown[q] && label[q] < 0) { label[q] = id; stack[sp++] = q; }
      }
    }
    parts.push({ id, area, box: [x0, y0, x1, y1] });
  }
  const keep = parts.filter((p) => p.area > 0 && p.area >= minArea), specks = parts.filter((p) => p.area > 0 && p.area < minArea).length;
  keep.sort((a, b) => a.box[1] - b.box[1]);
  const rows = [];
  for (const p of keep) {
    const row = rows.find((r) => p.box[1] < r.bottom && p.box[3] > r.top);
    if (row) { row.items.push(p); row.top = Math.min(row.top, p.box[1]); row.bottom = Math.max(row.bottom, p.box[3]); }
    else rows.push({ top: p.box[1], bottom: p.box[3], items: [p] });
  }
  return { parts: rows.flatMap((r) => r.items.sort((a, b) => a.box[0] - b.box[0])), specks, label };
}

// 整张图共用一套 k 色板（Lab 里的 k-means，固定种子），再把每个可见像素换成最近的颜色。
// 共用色板让同一种颜色在各部件里保持一致。返回色板（sRGB）。
export function quantize(buf, k, iters = 8) {
  const n = buf.length / 4, step = Math.max(1, Math.floor(n / 20000)), pts = [];
  for (let p = 0; p < n; p += step) if (buf[p * 4 + 3] >= 128) pts.push(lab(buf[p * 4], buf[p * 4 + 1], buf[p * 4 + 2]));
  if (pts.length <= k) return [];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const centers = [pts[Math.floor(rnd() * pts.length)]];
  while (centers.length < k) {
    const d = pts.map((q) => nearest(q, centers).distance ** 2), sum = d.reduce((a, b) => a + b, 0);
    let r = rnd() * sum, i = 0;
    while (r > d[i] && i < d.length - 1) r -= d[i++];
    centers.push(pts[i]);
  }
  for (let it = 0; it < iters; it++) {
    const acc = centers.map(() => [0, 0, 0, 0]);
    for (const q of pts) { const a = acc[nearest(q, centers).index]; a[0] += q[0]; a[1] += q[1]; a[2] += q[2]; a[3]++; }
    acc.forEach((a, j) => { if (a[3]) centers[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  // 每个颜色用实际归到它的像素的平均 sRGB，避免 Lab 来回换算的偏差。
  const assign = new Int16Array(n).fill(-1), sums = centers.map(() => [0, 0, 0, 0]);
  for (let p = 0; p < n; p++) {
    if (buf[p * 4 + 3] === 0) continue;
    const j = nearest(lab(buf[p * 4], buf[p * 4 + 1], buf[p * 4 + 2]), centers).index;
    assign[p] = j;
    for (let c = 0; c < 3; c++) sums[j][c] += buf[p * 4 + c];
    sums[j][3]++;
  }
  const rgb = sums.map((s) => s.slice(0, 3).map((v) => Math.round(v / Math.max(1, s[3]))));
  for (let p = 0; p < n; p++) if (assign[p] >= 0) for (let c = 0; c < 3; c++) buf[p * 4 + c] = rgb[assign[p]][c];
  return rgb.filter((_, j) => sums[j][3]);
}

// 把每个可见像素换成色板里最近的颜色（--snap）。
export function snapToPalette(buf, palette) {
  const labs = palette.map((c) => lab(...c));
  for (let p = 0; p < buf.length; p += 4) {
    if (buf[p + 3] === 0) continue;
    const c = palette[nearest(lab(buf[p], buf[p + 1], buf[p + 2]), labs).index];
    buf[p] = c[0]; buf[p + 1] = c[1]; buf[p + 2] = c[2];
  }
}

// 按比例缩小到能放进 maxW×maxH（区域平均，按 alpha 加权），只缩不放。
export function downscale(src, w, h, maxW, maxH) {
  const s = Math.min(1, maxW / w, maxH / h), W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s)), out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    const x0 = Math.floor(X / s), x1 = Math.min(w, Math.max(x0 + 1, Math.floor((X + 1) / s)));
    const y0 = Math.floor(Y / s), y1 = Math.min(h, Math.max(y0 + 1, Math.floor((Y + 1) / s)));
    let r = 0, g = 0, b = 0, a = 0, cnt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, al = src[i + 3];
      r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; cnt++;
    }
    const o = (Y * W + X) * 4;
    if (a) { out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; }
    out[o + 3] = a / cnt;
  }
  return { data: out, width: W, height: H };
}

// 在 dst（宽 dw）的 (dx, dy) 处按 alpha 叠上 src。
export function composite(dst, dw, dh, src, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const X = dx + x, Y = dy + y;
    if (X < 0 || Y < 0 || X >= dw || Y >= dh) continue;
    const i = (y * sw + x) * 4, o = (Y * dw + X) * 4, a = src[i + 3] / 255;
    for (let c = 0; c < 3; c++) dst[o + c] = Math.round(src[i + c] * a + dst[o + c] * (1 - a));
    dst[o + 3] = Math.max(dst[o + 3], src[i + 3]);
  }
}

export function fillRect(buf, w, h, x0, y0, x1, y1, rgb) {
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
    const o = (y * w + x) * 4; buf[o] = rgb[0]; buf[o + 1] = rgb[1]; buf[o + 2] = rgb[2]; buf[o + 3] = 255;
  }
}

// 5×7 点阵数字，用来在格子模板和对照拼图上写编号（不依赖字体）。
const DIGITS = ['01110100011001110101110011000101110', '00100011000010000100001000010001110', '01110100010000100010001000100011111',
  '11111000100010000010000011000101110', '00010001100101010010111110001000010', '11111100001111000001000011000101110',
  '00110010001000011110100011000101110', '11111000010001000100010000100001000', '01110100011000101110100011000101110',
  '01110100011000101111000010001001100'];
export function drawNumber(buf, w, h, n, x, y, scale, rgb) {
  for (const [k, ch] of [...String(n)].entries()) {
    const bits = DIGITS[+ch], ox = x + k * 6 * scale;
    for (let i = 0; i < 35; i++) if (bits[i] === '1') fillRect(buf, w, h, ox + (i % 5) * scale, y + Math.floor(i / 5) * scale, ox + (i % 5 + 1) * scale, y + (Math.floor(i / 5) + 1) * scale, rgb);
  }
}

// 虚线矩形框：线宽 t，实线 dash、空白 gap。
export function dashedRect(buf, w, h, x0, y0, x1, y1, t, dash, gap, rgb) {
  for (let s = x0; s < x1; s += dash + gap) {
    fillRect(buf, w, h, s, y0, Math.min(s + dash, x1), y0 + t, rgb);
    fillRect(buf, w, h, s, y1 - t, Math.min(s + dash, x1), y1, rgb);
  }
  for (let s = y0; s < y1; s += dash + gap) {
    fillRect(buf, w, h, x0, s, x0 + t, Math.min(s + dash, y1), rgb);
    fillRect(buf, w, h, x1 - t, s, x1, Math.min(s + dash, y1), rgb);
  }
}
