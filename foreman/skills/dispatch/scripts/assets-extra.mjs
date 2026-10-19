// assets patch：从改图里只取变了的区域，做成叠在原图上的羽化补丁（眨眼、张嘴这类局部变体）。
// assets trace：照参考图描出一个部件：从种子点圈出部件，分成描边、底色、阴影，输出参考图坐标的 SVG，给手画部分做底稿。
import fs from 'node:fs';
import path from 'node:path';
import * as P from './assets-pixels.mjs';
import * as S from './assets-shapes.mjs';
import * as V from './assets-vector.mjs';
import { print, num, readImage, writePng, boxes } from './assets-io.mjs';
import { M, die, need } from './util.mjs';

const over = (d, p, bg) => P.lab(...[0, 1, 2].map((c) => d[p * 4 + c] * (d[p * 4 + 3] / 255) + bg * (1 - d[p * 4 + 3] / 255)));

// 三格对照图：每格缩到宽 640 以内
function sheet(file, w, h, panels) {
  const tiles = panels.map((d) => P.downscale(d, w, h, 640, 640));
  const W = tiles.reduce((a, t) => a + t.width + 8, 8), H = Math.max(...tiles.map((t) => t.height)) + 16, buf = Buffer.alloc(W * H * 4, 255);
  let x = 8;
  for (const t of tiles) { P.composite(buf, W, H, t.data, t.width, t.height, x, 8); x += t.width + 8; }
  writePng(file, W, H, buf);
}

export function cmdPatch(o) {
  const baseFile = path.resolve(need(o, 'base')), varFile = path.resolve(need(o, 'variant')), out = path.resolve(need(o, 'out'));
  const base = readImage(baseFile), variant = readImage(varFile), { width: w, height: h } = base;
  const threshold = num(o, 'threshold', 14), minArea = num(o, 'min-area', 40), grow = num(o, 'grow', 3), fth = num(o, 'feather', 6);
  const int0 = (k, d) => { const v = o[k] == null ? d : Number(o[k]); if (!Number.isInteger(v) || v < 0) die(M.assetsBadNumber(k, o[k])); return v; };
  const open = int0('open', 2), edge = int0('edge', 6), keep = boxes(o.keep, M.assetsBadRegion);
  // 改图常被放大、挪位：先对回原图（缩放限制在 0.5–2 倍）。改图本来就该和原图同一画布，
  // 所以对齐结果拿不准、或者不比原位好出三成时，就按原位用（改动的区域本身会拉高对齐的分数）
  // 原始的对齐结果另外留着（measured），重出门槛看它：按原位用了，不等于改图没被挪动
  const measured = P.alignPiece(base, variant, { minScale: 0.5, maxScale: 2 });
  if (!measured) die(M.assetsAlignEmpty(varFile));
  let a = measured;
  if (variant.width === w && variant.height === h) {
    let sum = 0, n = 0;
    for (let p = 0; p < w * h; p += 3) {
      if (variant.data[p * 4 + 3] < 200) continue;
      const d = base.data[p * 4 + 3] < 128 ? 40 : Math.min(40, P.dE(P.lab(variant.data[p * 4], variant.data[p * 4 + 1], variant.data[p * 4 + 2]), P.lab(base.data[p * 4], base.data[p * 4 + 1], base.data[p * 4 + 2])));
      sum += d; n++;
    }
    const still = n ? sum / n : 40;
    if (a.ambiguous || a.mean_delta > 0.7 * still) a = { scale: 1, offset: [0, 0], mean_delta: still, ambiguous: false, kept: true };
  }
  const aligned = P.placeScaled(variant.data, variant.width, variant.height, w, h, a.scale, a.offset[0], a.offset[1]);
  // 变化：黑底、白底各比一次取大的；离原图外轮廓 edge 像素以内的不算（改图后外轮廓常整圈错开几像素，局部变体都在里面）；
  // 再做 open 像素的开运算去掉轮廓的细微位移，去掉小碎块，给了 keep 框就只留框里的
  let changed = new Uint8Array(w * h), raw = 0;
  for (let p = 0; p < w * h; p++) {
    if (base.data[p * 4 + 3] < 128 && aligned[p * 4 + 3] < 128) continue;
    const d = Math.max(P.dE(over(base.data, p, 0), over(aligned, p, 0)), P.dE(over(base.data, p, 255), over(aligned, p, 255)));
    if (d > threshold) { changed[p] = 1; raw++; }
  }
  let inner = null;
  if (edge) {
    const solid = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) solid[p] = base.data[p * 4 + 3] >= 128 ? 1 : 0;
    inner = S.shrink(solid, w, h, edge);
    for (let p = 0; p < w * h; p++) if (!inner[p]) changed[p] = 0;
  }
  changed = S.grow(S.shrink(changed, w, h, open), w, h, open);
  if (keep.length) for (let p = 0; p < w * h; p++) {
    const x = p % w, y = (p - x) / w;
    if (!keep.some(([x0, y0, x1, y1]) => x >= x0 && y >= y0 && x < x1 && y < y1)) changed[p] = 0;
  }
  const { mask, dropped } = S.dropSmall(changed, w, h, minArea);
  const alpha = S.feather(S.grow(mask, w, h, grow), w, h, fth);
  // 外扩和羽化不能把排除掉的外轮廓一圈又带回来
  if (inner) for (let p = 0; p < w * h; p++) if (!inner[p]) alpha[p] = 0;
  const patch = Buffer.alloc(w * h * 4), preview = Buffer.from(base.data), check = Buffer.from(base.data);
  let kept = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let p = 0; p < w * h; p++) {
    if (mask[p]) kept++;
    if (alpha[p] <= 0) continue;
    const x = p % w, y = (p - x) / w;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    for (let c = 0; c < 3; c++) patch[p * 4 + c] = aligned[p * 4 + c];
    patch[p * 4 + 3] = Math.round(aligned[p * 4 + 3] * alpha[p]);
    if (mask[p]) { check[p * 4] = 235; check[p * 4 + 1] = 40; check[p * 4 + 2] = 40; check[p * 4 + 3] = 255; }
  }
  P.composite(preview, w, h, patch, w, h, 0, 0);
  writePng(path.join(out, 'patch.png'), w, h, patch);
  writePng(path.join(out, 'preview.png'), w, h, preview);
  sheet(path.join(out, 'check.png'), w, h, [base.data, preview, check]);
  const result = {
    base: baseFile, variant: varFile,
    align: {
      scale: +a.scale.toFixed(4), offset: a.offset.map((v) => +v.toFixed(1)), mean_delta: +a.mean_delta.toFixed(2), ambiguous: a.ambiguous, ...(a.kept ? { kept_in_place: true } : {}),
      measured: { scale: +measured.scale.toFixed(4), offset: measured.offset.map((v) => +v.toFixed(1)), ambiguous: !!measured.ambiguous },
    },
    changed_pixels: raw, patch_pixels: kept, dropped_specks: dropped, box: kept ? [x0, y0, x1 + 1, y1 + 1] : null,
    files: { patch: path.join(out, 'patch.png'), preview: path.join(out, 'preview.png'), check: path.join(out, 'check.png') },
    ...(kept ? {} : { note: M.assetsPatchEmpty }),
  };
  fs.writeFileSync(path.join(out, 'patch.json'), JSON.stringify(result, null, 2) + '\n');
  print(result);
}

// 照参考图描出一个部件：种子点按颜色相近（tolerance）洪水填充出填色（不越过深色描边和 box），离填色 outline 像素以内的
// 深色像素算描边，填色分成 colors 种。返回 { svg, area, layers: [{ name, color, paths, points }] }，坐标是参考图坐标；
// area 为 0 表示种子点没圈到东西。cmdTrace 只负责读参数、写文件和对照图
export function tracePiece(img, { seeds, box, tolerance = 30, colors = 2, outline = 4, dark = 25, simplify = 0.8 }) {
  const { width: w, height: h } = img;
  const L = P.labImage(img.data, w, h);
  const isDark = (p) => L[p * 3] < dark && img.data[p * 4 + 3] >= 128;
  // 部件的填色区域：各种子的洪水填充（不越过描边和 box），合在一起
  const region = new Uint8Array(w * h);
  for (const s of seeds) { const r = S.floodFill(L, w, h, s, tolerance, box, (p) => !isDark(p) && img.data[p * 4 + 3] >= 128); for (let p = 0; p < w * h; p++) if (r[p]) region[p] = 1; }
  let area = 0;
  for (let p = 0; p < w * h; p++) area += region[p];
  if (!area) return { svg: '', area: 0, layers: [] };
  // 描边：离填色区域 outline 像素以内的深色像素（包括区域里面的细线）；轮廓 = 填色 + 描边，补上 1 像素的小缝
  const nearRegion = S.grow(region, w, h, outline), line = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (nearRegion[p] && !region[p] && isDark(p)) line[p] = 1;
  const union = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) union[p] = region[p] || line[p] ? 1 : 0;
  const silhouette = S.shrink(S.grow(union, w, h, 1), w, h, 1);
  // 填色分成 colors 种（亮的是底色，其余是阴影），各自的平均颜色
  const idx = [], pts = [];
  for (let p = 0; p < w * h; p++) if (region[p]) { idx.push(p); pts.push([L[p * 3], L[p * 3 + 1], L[p * 3 + 2]]); }
  const { centers, assign } = S.kmeans(pts, Math.min(colors, pts.length));
  const order = centers.map((c, i) => i).sort((a, b) => centers[b][0] - centers[a][0]);
  const rank = new Int32Array(centers.length);
  order.forEach((ci, r) => { rank[ci] = r; });
  const mean = (list) => { const t = [0, 0, 0]; for (const p of list) for (let c = 0; c < 3; c++) t[c] += img.data[p * 4 + c]; return P.hex(t.map((v) => v / Math.max(1, list.length))); };
  const toneOf = new Int32Array(w * h).fill(-1);
  idx.forEach((p, i) => { toneOf[p] = rank[assign[i]]; });
  const linePx = [];
  for (let p = 0; p < w * h; p++) if (line[p]) linePx.push(p);
  // 图层：轮廓填描边色，上面盖整块底色，再按深浅盖各层阴影；内部的细线是填色里的洞，露出下面的描边色
  const layers = [{ name: 'outline', color: linePx.length ? mean(linePx) : mean(idx), mask: silhouette }];
  for (let r = 0; r < order.length; r++) {
    const mask = new Uint8Array(w * h), list = [];
    for (let p = 0; p < w * h; p++) if (toneOf[p] >= r) { mask[p] = 1; if (toneOf[p] === r) list.push(p); }
    layers.push({ name: r === 0 ? 'base' : `shadow${r}`, color: mean(list), mask });
  }
  const polys = layers.map((l) => S.contours(l.mask, w, h).filter((p) => S.simplify(p, simplify).length >= 3));
  const paths = V.curvePaths(polys, simplify, outline);
  const svgLayers = layers.map((l, i) => ({ name: l.name, color: l.color, polys: polys[i], d: paths[i] }));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n` +
    svgLayers.map((l) => `  <path id="${l.name}" fill="${l.color}" fill-rule="evenodd" d="${l.d}"/>`).join('\n') + '\n</svg>\n';
  return { svg, area, layers: svgLayers.map((l) => ({ name: l.name, color: l.color, paths: l.polys.length, points: (l.d.match(/-?\d+(?:\.\d+)?/g) || []).length / 2 })) };
}

export function cmdTrace(o) {
  const file = path.resolve(need(o, 'image')), out = path.resolve(need(o, 'out')), img = readImage(file), { width: w, height: h } = img;
  const seeds = String(need(o, 'seed')).split(';').map((s) => s.trim()).filter(Boolean).map((s) => {
    const v = s.split(',').map(Number);
    if (v.length !== 2 || !v.every(Number.isInteger) || v[0] < 0 || v[1] < 0 || v[0] >= w || v[1] >= h) die(M.assetsBadSeed(s));
    return v;
  });
  const box = o.box ? boxes(o.box, M.assetsBadRegion)[0] : [0, 0, w, h];
  for (const s of seeds) if (s[0] < box[0] || s[1] < box[1] || s[0] >= box[2] || s[1] >= box[3]) die(M.assetsBadSeed(s.join(',')));
  const tol = num(o, 'tolerance', 30);
  const t = tracePiece(img, { seeds, box, tolerance: tol, colors: num(o, 'colors', 2, true), outline: num(o, 'outline', 4), dark: num(o, 'dark', 25), simplify: num(o, 'simplify', 0.8) });
  if (!t.area) die(M.assetsTraceEmpty(seeds.map((s) => s.join(',')).join(';')));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'trace.svg'), t.svg);
  // 对照图：原图 / 描出来的平涂（按最终 SVG 画回来，化简丢掉的细节也看得出）/ 两者叠在一起
  const flat = V.render(t.svg, w, h);
  const [bx0, by0, bx1, by1] = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(w, box[2]), Math.min(h, box[3])];
  const crop = (d) => { const cw = bx1 - bx0, ch = by1 - by0, b = Buffer.alloc(cw * ch * 4); for (let y = 0; y < ch; y++) d.copy(b, y * cw * 4, ((y + by0) * w + bx0) * 4, ((y + by0) * w + bx1) * 4); return b; };
  const mixed = Buffer.from(img.data);
  P.composite(mixed, w, h, flat, w, h, 0, 0);
  sheet(path.join(out, 'check.png'), bx1 - bx0, by1 - by0, [crop(img.data), crop(flat), crop(mixed)]);
  const result = { image: file, seeds, box, tolerance: tol, layers: t.layers, area: t.area, files: { svg: path.join(out, 'trace.svg'), check: path.join(out, 'check.png') } };
  fs.writeFileSync(path.join(out, 'trace.json'), JSON.stringify(result, null, 2) + '\n');
  print(result);
}
