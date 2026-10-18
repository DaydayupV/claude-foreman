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

// 整张图转成 Lab（每像素 3 个数）。
export function labImage(data, w, h) {
  const out = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) { const c = lab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]); out[p * 3] = c[0]; out[p * 3 + 1] = c[1]; out[p * 3 + 2] = c[2]; }
  return out;
}

// 把部件图对回参考图：找等比缩放 s 和平移 (tx, ty)。坐标约定和 placeScaled、SVG 的 translate(tx ty) scale(s) 一致：
// 部件像素 (x, y) 覆盖参考图的 [tx + s·x, tx + s·(x+1)) × [ty + s·y, ty + s·(y+1))，中心在 (tx + s·(x+0.5), ty + s·(y+0.5))。
// 打分看部件不透明像素和参考图同一处的色差，每点截到 CAP，补画的、被挡住的少数区域不会把结果拉偏。
// 部件缩小后塞进一片同色区域里也会"吻合"，所以分数差不多时偏向更大的缩放（BIAS：缩放翻倍分数减 0.3），
// 这样会落在部件边缘开始对不上之前的最大尺寸，也就是原来的大小；真正拿不准时标 ambiguous。
// 先在缩小的参考图上粗搜，再在原图上细搜；缩放始终限制在 [minScale, maxScale] 里。
const CAP = 40, BIAS = 0.3;
const biased = (c) => c.cost - BIAS * Math.log2(c.s);
export function alignPiece(ref, piece, { minScale = 0.25, maxScale = 4 } = {}) {
  const { width: pw0, height: ph0, data: pd } = piece;
  const inside = [];
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let p = 0; p < pw0 * ph0; p++) if (pd[p * 4 + 3] >= 200) {
    inside.push(p);
    const x = p % pw0, y = (p - x) / pw0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!inside.length) return null;
  // 从实际的像素集合里等间隔抽样，细线、贴边的部件也一定有样本
  const pick = (list, n) => {
    const step = Math.max(1, list.length / n), out = [];
    for (let i = 0; i < list.length; i += step) {
      const p = list[Math.floor(i)], x = p % pw0, y = (p - x) / pw0;
      out.push([x + 0.5, y + 0.5, ...lab(pd[p * 4], pd[p * 4 + 1], pd[p * 4 + 2])]);
    }
    return out;
  };
  const coarse = pick(inside, 220), fine = pick(inside, 1500);
  const pw = x1 - x0 + 1, ph = y1 - y0 + 1;

  const alphaOf = (img) => { const a = new Uint8Array(img.width * img.height); for (let p = 0; p < a.length; p++) a[p] = img.data[p * 4 + 3]; return a; };
  // 打分：样本落到 refL（宽 rw、高 rh，坐标是原图坐标乘 k）；limit 用于提前退出
  const score = (refL, refA, rw, rh, k, S, s, tx, ty, limit = Infinity) => {
    let sum = 0;
    const stop = limit * S.length;
    for (const [x, y, L, A, B] of S) {
      const X = Math.floor((tx + s * x) * k), Y = Math.floor((ty + s * y) * k);
      let d = CAP;
      if (X >= 0 && Y >= 0 && X < rw && Y < rh && refA[Y * rw + X] >= 128) {
        const o = (Y * rw + X) * 3, dl = L - refL[o], da = A - refL[o + 1], db = B - refL[o + 2];
        d = Math.sqrt(Math.min(CAP * CAP, dl * dl + da * da + db * db));
      }
      sum += d;
      if (sum > stop) return Infinity;
    }
    return sum / S.length;
  };

  // 缩放范围：用户给的上下限是硬约束；在此之内再排除缩到不足 8 像素、放大到超过参考图 1.5 倍的情况
  const lo = Math.max(minScale, 8 / Math.max(pw, ph)), hi = Math.min(maxScale, 1.5 * Math.min(ref.width / pw, ref.height / ph));
  const sLo = lo <= hi ? lo : minScale, sHi = lo <= hi ? hi : maxScale;
  const clamp = (s) => Math.min(maxScale, Math.max(minScale, s));

  // 粗搜：参考图缩到长边 320，缩放按对数分 40 档，平移步长 3 个工作像素
  const k = Math.min(1, 320 / Math.max(ref.width, ref.height));
  const small = downscale(ref.data, ref.width, ref.height, ref.width * k, ref.height * k);
  const kx = small.width / ref.width, sL = labImage(small.data, small.width, small.height), sA = alphaOf(small);
  const top = [];
  const keep = (c) => { top.push(c); top.sort((a, b) => biased(a) - biased(b)); if (top.length > 6) top.pop(); };
  const steps = sHi > sLo ? 40 : 1;
  for (let i = 0; i < steps; i++) {
    const s = steps > 1 ? sLo * (sHi / sLo) ** (i / (steps - 1)) : sLo, step = 3 / kx;
    for (let ty = -(y0 + ph / 2) * s; ty <= ref.height - (y0 + ph / 2) * s; ty += step) {
      for (let tx = -(x0 + pw / 2) * s; tx <= ref.width - (x0 + pw / 2) * s; tx += step) {
        // 提前退出的门槛换算回未加偏置的分数
        const cost = score(sL, sA, small.width, small.height, kx, coarse, s, tx, ty, top.length === 6 ? biased(top[5]) + BIAS * Math.log2(s) : Infinity);
        if (cost < Infinity) keep({ s, tx, ty, cost });
      }
    }
  }
  if (!top.length) return null;

  // 细搜：原图分辨率，缩放 ±4%、平移 ±1 个粗搜步长，再逐级缩小范围
  const fL = labImage(ref.data, ref.width, ref.height), fA = alphaOf(ref);
  const results = top.map((c) => {
    let cur = { ...c, cost: score(fL, fA, ref.width, ref.height, 1, fine, c.s, c.tx, c.ty) };
    for (const [ds, dt, n] of [[0.04, 3 / kx, 4], [0.008, 1.5, 3], [0.002, 0.5, 2]]) {
      const base = { ...cur };
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) for (let e = -n; e <= n; e++) {
        const s = clamp(base.s * (1 + ds * a / n)), tx = base.tx + dt * b / n, ty = base.ty + dt * e / n;
        const cost = score(fL, fA, ref.width, ref.height, 1, fine, s, tx, ty, biased(cur) + BIAS * Math.log2(s));
        if (cost < Infinity && biased({ s, cost }) < biased(cur)) cur = { s, tx, ty, cost };
      }
    }
    return cur;
  }).sort((a, b) => biased(a) - biased(b));
  const best = results[0];
  // 拿不准：另一个明显不同的变换（缩放差 10% 以上，或位置差出部件尺寸的一成）分数差不多；或者结果顶在缩放范围的边上
  const far = (c) => Math.abs(Math.log(c.s / best.s)) > Math.log(1.1) || Math.hypot(c.tx + c.s * (x0 + pw / 2) - best.tx - best.s * (x0 + pw / 2), c.ty + c.s * (y0 + ph / 2) - best.ty - best.s * (y0 + ph / 2)) > 0.1 * best.s * Math.max(pw, ph);
  const rival = results.slice(1).find((c) => far(c) && c.cost <= best.cost * 1.1 + 0.5);
  const atBound = (sHi > sLo) && (best.s <= sLo * 1.02 || best.s >= sHi / 1.02);

  // 区域打分：落在给定矩形（参考图像素）里的全部部件像素的平均色差和吻合比例
  const center = (x, y) => [Math.floor(best.tx + best.s * (x + 0.5)), Math.floor(best.ty + best.s * (y + 0.5))];
  const region = ([rx0, ry0, rx1, ry1]) => {
    let sum = 0, n = 0, ok = 0;
    for (const p of inside) {
      const x = p % pw0, y = (p - x) / pw0, [X, Y] = center(x, y);
      if (X < rx0 || Y < ry0 || X >= rx1 || Y >= ry1 || X < 0 || Y < 0 || X >= ref.width || Y >= ref.height) continue;
      let d = CAP;
      if (fA[Y * ref.width + X] >= 128) { const o = (Y * ref.width + X) * 3, c = lab(pd[p * 4], pd[p * 4 + 1], pd[p * 4 + 2]); d = Math.min(CAP, Math.hypot(c[0] - fL[o], c[1] - fL[o + 1], c[2] - fL[o + 2])); }
      sum += d; n++; if (d < 10) ok++;
    }
    return { pixels: n, mean_delta: n ? +(sum / n).toFixed(2) : null, matched: n ? +(ok / n).toFixed(3) : null };
  };
  let ok = 0;
  for (const [x, y, L, A, B] of fine) {
    const X = Math.floor(best.tx + best.s * x), Y = Math.floor(best.ty + best.s * y);
    if (X >= 0 && Y >= 0 && X < ref.width && Y < ref.height && fA[Y * ref.width + X] >= 128) {
      const o = (Y * ref.width + X) * 3;
      if (Math.hypot(L - fL[o], A - fL[o + 1], B - fL[o + 2]) < 10) ok++;
    }
  }
  return { scale: best.s, offset: [best.tx, best.ty], mean_delta: best.cost, matched: ok / fine.length, ambiguous: Boolean(rival || atBound), region };
}

// 把 src 按 s、(tx, ty) 双线性缩放后画到 w×h 的透明画布上（预乘 alpha，边缘不发黑）。
export function placeScaled(src, sw, sh, w, h, s, tx, ty) {
  const out = Buffer.alloc(w * h * 4);
  const X0 = Math.max(0, Math.floor(tx)), Y0 = Math.max(0, Math.floor(ty)), X1 = Math.min(w, Math.ceil(tx + s * sw)), Y1 = Math.min(h, Math.ceil(ty + s * sh));
  for (let Y = Y0; Y < Y1; Y++) for (let X = X0; X < X1; X++) {
    const fx = (X + 0.5 - tx) / s - 0.5, fy = (Y + 0.5 - ty) / s - 0.5, ix = Math.floor(fx), iy = Math.floor(fy), ax = fx - ix, ay = fy - iy;
    const acc = [0, 0, 0, 0];
    for (const [dx, dy, wgt] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]]) {
      const x = ix + dx, y = iy + dy;
      if (x < 0 || y < 0 || x >= sw || y >= sh || !wgt) continue;
      const i = (y * sw + x) * 4, a = src[i + 3] * wgt;
      acc[0] += src[i] * a; acc[1] += src[i + 1] * a; acc[2] += src[i + 2] * a; acc[3] += a;
    }
    const o = (Y * w + X) * 4;
    if (acc[3] > 0) { out[o] = Math.round(acc[0] / acc[3]); out[o + 1] = Math.round(acc[1] / acc[3]); out[o + 2] = Math.round(acc[2] / acc[3]); }
    out[o + 3] = Math.round(acc[3]);
  }
  return out;
}
