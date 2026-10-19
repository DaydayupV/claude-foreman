// assets layers：同源取件。所有图层都从定稿图上取，和定稿图同一画布、同一坐标，不缩放、不对齐；
// 背景板（去掉了会动主体的整张改图）只写回主体原来所在的范围，并按外圈的色差校色。
// 部件清单（JSON）：
//   { "pieces": [ { "name", "kind": "raster" | "vector", "lasso": [[x, y], …], "extendUnder": [{ "piece", "dist" }], "whole": true }, … ],
//     whole：套索里的像素全取、不看是不是主体，给静止的前景遮挡物用（比如柜台：它在背景板里也有，和定稿图一样）
//     "seams": [ [[x, y], …], … ],   定稿图里没有描边、由 Claude 定的接缝线（比如下巴），当作描边用
//     "line": 20 }                   描边的亮度上限
// 部件范围 = 套索（归哪个部件）× 和背景板不一样（是主体）× 被描边分开的区域（边缘干净）；描边归离它最近的部件。
// 套索按清单顺序先到先得。
import fs from 'node:fs';
import path from 'node:path';
import * as P from './assets-pixels.mjs';
import * as S from './assets-shapes.mjs';
import * as V from './assets-vector.mjs';
import { print, readImage, writePng } from './assets-io.mjs';
import { M, die, need } from './util.mjs';

const nb4 = (p, w, n) => { const x = p % w; return [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w].filter((q) => q >= 0 && q < n); };

// 多边形（偶奇规则）里的像素中心
function polygonMask(poly, w, h) {
  const m = new Uint8Array(w * h);
  const ys = poly.map((p) => p[1]), y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > yc) !== (yj > yc)) xs.push(xi + (yc - yi) / (yj - yi) * (xj - xi)); }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) m[y * w + x] = 1;
  }
  return m;
}
// 折线画成 2 像素宽的线
function polylineMask(lines, w, h) {
  const m = new Uint8Array(w * h);
  for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let k = 0; k <= n; k++) { const x = Math.round(ax + (bx - ax) * k / n), y = Math.round(ay + (by - ay) * k / n); for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) { const X = x + dx, Y = y + dy; if (X >= 0 && Y >= 0 && X < w && Y < h) m[Y * w + X] = 1; } }
  }
  return m;
}
// 不是描边的像素按 4 邻接分区
function regions(line, w, h) {
  const n = w * h, label = new Int32Array(n).fill(-1), list = [], stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (line[s] || label[s] >= 0) continue;
    const id = list.length, px = [];
    let sp = 0; label[s] = id; stack[sp++] = s;
    while (sp) { const p = stack[--sp]; px.push(p); for (const q of nb4(p, w, n)) if (!line[q] && label[q] < 0) { label[q] = id; stack[sp++] = q; } }
    list.push({ id, px });
  }
  return { label, list };
}
// 背景板校色：主体范围外面一圈量出逐点的差（色差 < 10 的点，避开描边错位），pull-push 平滑插值铺满主体范围
function correctPlate(ref, plate, area, w, h, dE) {
  const n = w * h, ring = S.grow(area, w, h, 4), w0 = new Float32Array(n), d0 = [0, 1, 2].map(() => new Float32Array(n));
  for (let p = 0; p < n; p++) if (ring[p] && !area[p] && dE[p] < 10) { w0[p] = 1; for (let c = 0; c < 3; c++) d0[c][p] = ref[p * 4 + c] - plate[p * 4 + c]; }
  // 一直聚合到 1×1：粗层里没有采样的格子不能当成零修正，主体大时中心那几格会这样
  const levels = [{ w: w0, d: d0, W: w, H: h }];
  while (levels[levels.length - 1].W > 1 || levels[levels.length - 1].H > 1) {
    const a = levels[levels.length - 1], w2 = Math.ceil(a.W / 2), h2 = Math.ceil(a.H / 2), lw = new Float32Array(w2 * h2), ld = [0, 1, 2].map(() => new Float32Array(w2 * h2));
    for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) { const i = y * a.W + x, j = (y >> 1) * w2 + (x >> 1); if (!a.w[i]) continue; lw[j] += a.w[i]; for (let c = 0; c < 3; c++) ld[c][j] += a.d[c][i] * a.w[i]; }
    for (let j = 0; j < w2 * h2; j++) if (lw[j]) { for (let c = 0; c < 3; c++) ld[c][j] /= lw[j]; lw[j] = Math.min(1, lw[j]); }
    levels.push({ w: lw, d: ld, W: w2, H: h2 });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const a = levels[l], b = levels[l + 1];
    for (let y = 0; y < a.H; y++) for (let x = 0; x < a.W; x++) {
      const i = y * a.W + x; if (a.w[i] >= 1) continue;
      const fx = Math.min(b.W - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(b.H - 1, Math.max(0, (y - 0.5) / 2)), x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(b.W - 1, x0 + 1), y1 = Math.min(b.H - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      for (let c = 0; c < 3; c++) { const D = b.d[c], v = (D[y0 * b.W + x0] * (1 - tx) + D[y0 * b.W + x1] * tx) * (1 - ty) + (D[y1 * b.W + x0] * (1 - tx) + D[y1 * b.W + x1] * tx) * ty; a.d[c][i] = a.d[c][i] * a.w[i] + v * (1 - a.w[i]); }
      a.w[i] = 1;
    }
  }
  const out = Buffer.from(plate);
  for (let p = 0; p < n; p++) if (area[p]) for (let c = 0; c < 3; c++) out[p * 4 + c] = Math.max(0, Math.min(255, Math.round(plate[p * 4 + c] + d0[c][p])));
  return out;
}

export function buildLayers(ref, plateImg, cfg) {
  const { width: w, height: h } = ref, n = w * h, L = P.labImage(ref.data, w, h);
  // 1. 背景板对回定稿图（拿不准或不比原位好就按原位），逐像素色差；"是主体"的门槛 = 背景板噪声（主体以外色差的中位数）的 3 倍，至少 4。
  //    原始的对齐结果另外留着（measured），重出门槛看它：按原位用了，不等于背景板没被挪动
  const measured = P.alignPiece(ref, plateImg, { minScale: 0.95, maxScale: 1.05 });
  let a = measured;
  const inPlace = plateImg.width === w && plateImg.height === h;
  const sample = (img) => { let s = 0, k = 0; const Lp = P.labImage(img, w, h); for (let p = 0; p < n; p += 7) { s += Math.min(40, Math.hypot(L[p * 3] - Lp[p * 3], L[p * 3 + 1] - Lp[p * 3 + 1], L[p * 3 + 2] - Lp[p * 3 + 2])); k++; } return s / k; };
  let plate = P.placeScaled(plateImg.data, plateImg.width, plateImg.height, w, h, a?.scale ?? 1, a?.offset[0] ?? 0, a?.offset[1] ?? 0);
  if (inPlace && (!a || a.ambiguous || sample(plate) >= 0.95 * sample(plateImg.data))) { plate = Buffer.from(plateImg.data); a = { scale: 1, offset: [0, 0], kept_in_place: true }; }
  const deltaOf = (img) => { const Li = P.labImage(img, w, h), d = new Float32Array(n); for (let p = 0; p < n; p++) d[p] = Math.hypot(L[p * 3] - Li[p * 3], L[p * 3 + 1] - Li[p * 3 + 1], L[p * 3 + 2] - Li[p * 3 + 2]); return d; };
  // 背景板在主体附近重画时会整片偏一点色（实测黑板偏了约 7），比判断主体的门槛还高。先用所有套索的并集当主体的大致范围，
  // 按它外面一圈的色差给背景板校色，再算色差
  const roughArea = new Uint8Array(n);
  for (const pc of cfg.pieces) if (!pc.whole) { const m = polygonMask(pc.lasso, w, h); for (let p = 0; p < n; p++) if (m[p]) roughArea[p] = 1; }
  // 第 5 步给静止层校色时也从这张没校过的背景板算起，不在校过的上面再校一遍
  const plate0 = plate, dE0 = deltaOf(plate0);
  plate = correctPlate(ref.data, plate0, S.grow(roughArea, w, h, 4), w, h, dE0);
  const dE = deltaOf(plate), away = S.grow(roughArea, w, h, 8), bg = [];
  for (let p = 0; p < n; p += 13) if (!away[p]) bg.push(dE[p]);
  bg.sort((x, y) => x - y);
  const noise = bg.length ? bg[bg.length >> 1] : 0, tol = Math.max(4, 3 * noise);
  // 2. 描边：亮度低于 cfg.line 的像素去掉大块深色（填色），加上接缝线，再做 1 像素闭运算接上细断口
  let line = new Uint8Array(n);
  for (let p = 0; p < n; p++) line[p] = L[p * 3] < (cfg.line ?? 20) ? 1 : 0;
  const blobs = S.grow(S.shrink(line, w, h, 3), w, h, 3);
  for (let p = 0; p < n; p++) if (blobs[p]) line[p] = 0;
  line = S.shrink(S.grow(line, w, h, 1), w, h, 1);
  const seam = polylineMask(cfg.seams || [], w, h);
  for (let p = 0; p < n; p++) if (seam[p]) line[p] = 1;
  const seg = regions(line, w, h);
  // 3. 部件：套索里的区域按块判断，块里色差的中位数超过 tol 就是主体（逐像素判断会被背景板的噪声搅乱）；
  //    区域大半在套索里时整块一起判断（套索画得粗，切到部件边上一点不要紧）；块里和背景板一样的成片区域（≥ 40 像素）去掉。
  //    夹在描边之间、四周只挨着这个部件和描边的小块（≤ 500 像素，比如围裙下摆和同色后柜台之间的阴影条），色差小也算进来
  // 色差中位数不到门槛两倍的块记成拿不准（背景板在主体附近重画过的背景也会落在这个范围），报告给 Claude 看对照图核对
  const masks = {}, taken = new Uint8Array(n), uncertain = [];
  for (const pc of cfg.pieces) {
    const inside = polygonMask(pc.lasso, w, h), m = new Uint8Array(n), seen = new Uint8Array(n), small = [];
    if (pc.whole) {
      for (let p = 0; p < n; p++) if (inside[p] && !taken[p]) { m[p] = 1; taken[p] = 1; }
      masks[pc.name] = m;
      continue;
    }
    for (const r of seg.list) {
      let k = 0;
      for (const p of r.px) k += inside[p];
      if (!k) continue;
      const whole = k * 2 >= r.px.length, ok = (p) => (whole || inside[p]) && !taken[p];
      for (const s0 of r.px) {
        if (seen[s0] || !ok(s0)) continue;
        const comp = [s0], st = [s0];
        seen[s0] = 1;
        while (st.length) { const p = st.pop(); for (const q of nb4(p, w, n)) if (!seen[q] && !line[q] && seg.label[q] === r.id && ok(q)) { seen[q] = 1; st.push(q); comp.push(q); } }
        const med = comp.map((p) => dE[p]).sort((x, y) => x - y)[comp.length >> 1];
        if (med <= tol) { if (comp.length <= 500) small.push(comp); continue; }
        const bg = new Uint8Array(comp.length), at = new Map(comp.map((p, i) => [p, i]));
        for (let i = 0; i < comp.length; i++) {
          if (bg[i] || dE[comp[i]] > tol) continue;
          const grp = [i], st2 = [i]; bg[i] = 2;
          while (st2.length) { const j = st2.pop(); for (const q of nb4(comp[j], w, n)) { const t = at.get(q); if (t !== undefined && !bg[t] && dE[q] <= tol) { bg[t] = 2; st2.push(t); grp.push(t); } } }
          for (const j of grp) bg[j] = grp.length >= 40 ? 1 : 3;
        }
        comp.forEach((p, i) => { if (bg[i] !== 1) m[p] = 1; });
        if (med < 2 * tol && comp.length >= 40) {
          let x0 = w, y0 = h, x1 = -1, y1 = -1;
          for (const p of comp) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          uncertain.push({ piece: pc.name, box: [x0, y0, x1 + 1, y1 + 1], pixels: comp.length, median_delta: +med.toFixed(1) });
        }
      }
    }
    for (const comp of small) if (comp.every((p) => nb4(p, w, n).every((q) => line[q] || m[q] || comp.includes(q)))) for (const p of comp) m[p] = 1;
    masks[pc.name] = m;
    for (let p = 0; p < n; p++) if (m[p]) taken[p] = 1;
  }
  // 4. 描边归部件：是主体的描边像素（含 2 像素以内的抗锯齿边）归离它最近的部件（5 像素以内）
  const drawn = S.grow(line, w, h, 2), names = cfg.pieces.map((pc) => pc.name), dist = names.map((nm) => S.distanceTo(masks[nm], w, h));
  for (let p = 0; p < n; p++) {
    if (taken[p] || dE[p] <= tol || !(line[p] || (drawn[p] && L[p * 3] < 50))) continue;
    let best = -1, bd = 5 + 1e-6;
    names.forEach((nm, i) => { if (!cfg.pieces[i].whole && dist[i][p] < bd) { bd = dist[i][p]; best = i; } });
    if (best >= 0) masks[names[best]][p] = 1;
  }
  // 前景遮挡物（whole）不是主体：它在背景板里本来就有，不用换
  const subject = new Uint8Array(n);
  for (const pc of cfg.pieces) if (!pc.whole) for (let p = 0; p < n; p++) if (masks[pc.name][p]) subject[p] = 1;
  // 5. 静止层：定稿图，主体范围外扩 5 像素里换成校过色的背景板
  const area = S.grow(subject, w, h, 5), corrected = correctPlate(ref.data, plate0, area, w, h, dE0), still = Buffer.from(ref.data);
  for (let p = 0; p < n; p++) if (area[p]) for (let c = 0; c < 3; c++) still[p * 4 + c] = corrected[p * 4 + c];
  // 6. 部件：位图按原画布裁出，下层部件顺着平涂色往上层部件下面延长 dist 像素（只从填色往外延，不延描边）；矢量部件转成路径
  const pieces = {};
  for (const pc of cfg.pieces) {
    const m = Uint8Array.from(masks[pc.name]), rgba = Buffer.alloc(n * 4);
    for (let p = 0; p < n; p++) if (m[p]) { ref.data.copy(rgba, p * 4, p * 4, p * 4 + 3); rgba[p * 4 + 3] = 255; }
    let added = 0;
    // 两个部件之间的描边有一半归下层，平涂色要穿过下层自己的这段描边往下延：描边在 carry 里带上填色往外传，本身不改色。
    // 新增的像素只写在上层部件真正盖住的地方，不然会露在背景上
    for (const ext of pc.extendUnder || []) {
      const upper = masks[ext.piece], near = S.grow(upper, w, h, 2), src = new Uint8Array(n), carry = Buffer.from(rgba);
      for (let p = 0; p < n; p++) src[p] = m[p] && !line[p] ? 1 : 0;
      for (let step = 0; step < ext.dist; step++) {
        const next = [];
        for (let p = 0; p < n; p++) if (!src[p] && (m[p] ? line[p] && near[p] : upper[p])) { const q = nb4(p, w, n).find((t) => src[t]); if (q !== undefined) next.push([p, q]); }
        if (!next.length) break;
        for (const [p, q] of next) { carry.copy(carry, p * 4, q * 4, q * 4 + 4); src[p] = 1; if (!m[p]) { m[p] = 1; carry.copy(rgba, p * 4, p * 4, p * 4 + 4); added++; } }
      }
    }
    pieces[pc.name] = { kind: pc.kind === 'vector' ? 'vector' : 'raster', mask: m, rgba, extended: added, pixels: masks[pc.name].reduce((s, v) => s + v, 0) };
    if (pc.kind === 'vector') pieces[pc.name].svg = V.vectorize(rgba, w, h).svg;
  }
  // 7. 自检：静止层上按顺序叠回各部件（不含延长段），和定稿图差得多的像素数
  const back = Buffer.from(still);
  for (const nm of names) for (let p = 0; p < n; p++) if (masks[nm][p]) ref.data.copy(back, p * 4, p * 4, p * 4 + 3);
  let backDiff = 0;
  for (let p = 0; p < n; p++) if (Math.abs(back[p * 4] - ref.data[p * 4]) + Math.abs(back[p * 4 + 1] - ref.data[p * 4 + 1]) + Math.abs(back[p * 4 + 2] - ref.data[p * 4 + 2]) > 30) backDiff++;
  const r4 = (v) => +v.toFixed(4), r1 = (v) => +v.toFixed(1);
  const plateInfo = {
    scale: r4(a.scale), offset: a.offset.map(r1), kept_in_place: !!a.kept_in_place,
    measured: measured ? { scale: r4(measured.scale), offset: measured.offset.map(r1), ambiguous: !!measured.ambiguous } : null,
    noise: +noise.toFixed(2), tol: +tol.toFixed(2),
  };
  return { uncertain, still, pieces, plate: plateInfo, reassembled_diff_px: backDiff, line, masks };
}

function cropOut(rgba, mask, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let p = 0; p < w * h; p++) if (mask[p]) { const x = p % w, y = (p / w) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, b = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) rgba.copy(b, y * cw * 4, ((y + y0) * w + x0) * 4, ((y + y0) * w + x1 + 1) * 4);
  return { x: x0, y: y0, w: cw, h: ch, data: b };
}

export function cmdLayers(o) {
  const ref = readImage(path.resolve(need(o, 'ref'))), plate = readImage(path.resolve(need(o, 'plate'))), out = path.resolve(need(o, 'out'));
  const file = path.resolve(need(o, 'pieces'));
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(M.assetsLayersBadConfig(file, e.message)); }
  if (!Array.isArray(cfg.pieces) || !cfg.pieces.length) die(M.assetsLayersBadConfig(file, 'pieces'));
  // 名字就是文件名和清单的键：只用字母、数字、- 和 _，不重名（不分大小写），不占用 static
  const names = cfg.pieces.map((pc) => String(pc.name ?? '').toLowerCase());
  for (const [i, pc] of cfg.pieces.entries()) {
    const bad = typeof pc.name !== 'string' || !/^[A-Za-z0-9_-]+$/.test(pc.name) || names[i] === 'static' || names.indexOf(names[i]) !== i
      || !Array.isArray(pc.lasso) || pc.lasso.length < 3
      || (pc.extendUnder || []).some((e) => !cfg.pieces.some((o) => o !== pc && o.name === e.piece) || !(e.dist > 0));
    if (bad) die(M.assetsLayersBadConfig(file, pc.name || 'name'));
  }
  const { width: w, height: h } = ref;
  const r = buildLayers(ref, plate, cfg), manifest = { size: [w, h], plate: r.plate, reassembled_diff_px: r.reassembled_diff_px, uncertain: r.uncertain, layers: {} };
  fs.mkdirSync(out, { recursive: true });
  writePng(path.join(out, 'static.png'), w, h, r.still);
  manifest.layers.static = { file: 'static.png', x: 0, y: 0, w, h };
  for (const pc of cfg.pieces) {
    const it = r.pieces[pc.name];
    if (!it.pixels) die(M.assetsLayersEmpty(pc.name));
    const c = cropOut(it.rgba, it.mask, w, h);
    // 位图按包围框裁；SVG 用整张画布的坐标，所以位置写整张画布，包围框另记在 box
    const row = it.kind === 'vector' ? { kind: it.kind, x: 0, y: 0, w, h, box: [c.x, c.y, c.w, c.h] } : { kind: it.kind, x: c.x, y: c.y, w: c.w, h: c.h };
    Object.assign(row, { pixels: it.pixels, extended: it.extended });
    if (it.kind === 'vector') { fs.writeFileSync(path.join(out, `${pc.name}.svg`), it.svg); row.file = `${pc.name}.svg`; row.paths = (it.svg.match(/<path/g) || []).length; }
    else { writePng(path.join(out, `${pc.name}.png`), c.w, c.h, c.data); row.file = `${pc.name}.png`; }
    manifest.layers[pc.name] = row;
  }
  // 对照图：各部件上色叠在定稿图上，延长段颜色更浅，拿不准的块画品红框
  const colors = [[230, 60, 60], [60, 140, 230], [60, 190, 90], [220, 170, 40], [170, 80, 200], [40, 190, 200]], vis = Buffer.from(ref.data);
  cfg.pieces.forEach((pc, i) => { const it = r.pieces[pc.name], col = colors[i % colors.length]; for (let p = 0; p < w * h; p++) if (it.mask[p]) { const k = r.masks[pc.name][p] ? 0.55 : 0.3; for (let c = 0; c < 3; c++) vis[p * 4 + c] = Math.round(vis[p * 4 + c] * (1 - k) + col[c] * k); } });
  // 拿不准的块画品红框
  for (const u of r.uncertain) { const [x0, y0, x1, y1] = u.box; for (let x = x0; x < x1; x++) for (const y of [y0, y1 - 1]) vis.set([255, 0, 255, 255], (y * w + x) * 4); for (let y = y0; y < y1; y++) for (const x of [x0, x1 - 1]) vis.set([255, 0, 255, 255], (y * w + x) * 4); }
  writePng(path.join(out, 'check.png'), w, h, vis);
  fs.writeFileSync(path.join(out, 'layers.json'), JSON.stringify(manifest, null, 2) + '\n');
  // 页面用 file:// 打开时读不了 JSON，同样的内容也写成一个脚本
  fs.writeFileSync(path.join(out, 'layers.js'), `// 由 assets layers 生成：图层位置是定稿图坐标\nwindow.LAYERS = ${JSON.stringify(manifest.layers)};\n`);
  print({ ...manifest, files: { dir: out, check: path.join(out, 'check.png'), json: path.join(out, 'layers.json') } });
}
