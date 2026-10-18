// assets 子命令：出图之后的确定性处理，不调用任何模型。
// template 画编号格子模板；cut 去背景、切部件、按格子命名、出 manifest 和对照拼图（--vector 再转 SVG）；
// check 重新读出 cut 的判定；diff 比较改图前后每一格的变化；setup 把矢量化要用的原生包装到用户目录。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import * as P from './assets-pixels.mjs';
import { USER_CONFIG } from './config.mjs';
import { M, die, need } from './util.mjs';

export const TOOLING_DIR = process.env.FOREMAN_TOOLING_DIR || path.join(path.dirname(USER_CONFIG), 'tooling');
const TOOLING_PACKAGES = ['@neplex/vectorizer@0.1.0', '@resvg/resvg-js@2.6.2'];
// image_gen 实际输出的几档尺寸（约 157 万像素）。
const ASPECTS = { '1:1': [1254, 1254], '3:2': [1536, 1024], '2:3': [1024, 1536], '3:1': [2172, 724] };
const GRAY = [154, 160, 166];

const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
const names = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-');
function num(o, key, fallback, int = false) {
  if (o[key] == null) return fallback;
  const v = Number(o[key]);
  if (!Number.isFinite(v) || v <= 0 || (int && !Number.isInteger(v))) die(M.assetsBadNumber(key, o[key]));
  return v;
}
function readImage(file) {
  try { const bytes = fs.readFileSync(file); return { ...decodePng(bytes), bytes }; } catch (e) { die(M.assetsBadImage(file, e.message)); }
}
function writePng(file, w, h, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng(w, h, data));
}
function readSlots(file, w, h) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(doc.slots)) throw new Error('no slots'); } catch (e) { die(M.assetsBadSlots(file, e.message)); }
  // 格子坐标按比例存，换算到实际图片尺寸，不假定出图尺寸和模板一样。
  return { file: path.resolve(file), slots: doc.slots.map((s) => ({ slot: s.slot, name: s.name ?? null, box: [s.box[0] * w, s.box[1] * h, s.box[2] * w, s.box[3] * h] })) };
}
const slotAt = (slots, box) => {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return slots.find((s) => cx >= s.box[0] && cx <= s.box[2] && cy >= s.box[1] && cy <= s.box[3])?.slot ?? null;
};

function cmdTemplate(o) {
  const out = path.resolve(need(o, 'out')), cols = num(o, 'cols', null, true), rows = num(o, 'rows', null, true);
  if (!cols || !rows) die(M.assetsUsage);
  const list = names(o.names);
  if (list.length > cols * rows) die(M.assetsTooManyNames(list.length, cols * rows));
  const aspect = o.aspect || (cols > rows ? '3:2' : rows > cols ? '2:3' : '1:1');
  if (!ASPECTS[aspect]) die(M.assetsBadAspect(aspect));
  const [w, h] = ASPECTS[aspect], gap = Math.round(Math.min(w, h) * 0.03);
  const cw = (w - gap * (cols + 1)) / cols, ch = (h - gap * (rows + 1)) / rows;
  const buf = Buffer.alloc(w * h * 4, 255), scale = Math.max(4, Math.round(Math.min(cw, ch) / 45)), slots = [];
  for (let i = 0; i < (list.length || cols * rows); i++) {
    const x = Math.round(gap + (i % cols) * (cw + gap)), y = Math.round(gap + Math.floor(i / cols) * (ch + gap));
    const x1 = Math.round(x + cw), y1 = Math.round(y + ch);
    P.dashedRect(buf, w, h, x, y, x1, y1, 4, 18, 12, GRAY);
    P.drawNumber(buf, w, h, i + 1, x + 4 * scale, y + 3 * scale, scale, GRAY);
    slots.push({ slot: i + 1, name: list[i] ?? null, box: [x / w, y / h, x1 / w, y1 / h].map((v) => +v.toFixed(5)) });
  }
  writePng(out, w, h, buf);
  const slotsFile = out.replace(/\.png$/i, '') + '.slots.json';
  fs.writeFileSync(slotsFile, JSON.stringify({ version: 1, image: path.basename(out), aspect, size: [w, h], cols, rows, slots }, null, 2) + '\n');
  print({ template: out, slots_file: slotsFile, aspect, size: [w, h], slots: slots.length, names: list });
}

// 只有 --vector 时才加载用户目录里的原生包；没装就在动手之前停下。
function loadTooling() {
  try {
    const req = createRequire(path.join(TOOLING_DIR, 'index.js'));
    return { vectorizer: req('@neplex/vectorizer'), resvg: req('@resvg/resvg-js') };
  } catch { die(M.assetsToolingMissing(TOOLING_DIR)); }
}

async function vectorizePart(tool, png, w, h, part, palette) {
  const { vectorize, ColorMode, Hierarchical, PathSimplifyMode } = tool.vectorizer;
  let svg = await vectorize(png, {
    colorMode: ColorMode.Color, hierarchical: Hierarchical.Stacked, filterSpeckle: 4, colorPrecision: palette ? 8 : 6,
    layerDifference: 16, mode: PathSimplifyMode.Spline, cornerThreshold: 60, lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45, pathPrecision: 2,
  });
  // 矢量化会把一簇颜色取平均；吸附色板时把每个 fill 放回色板里的准确颜色。
  if (palette) {
    const labs = palette.map((c) => P.lab(...c));
    svg = svg.replace(/fill="#([0-9A-Fa-f]{6})"/g, (_, h6) => `fill="${P.hex(palette[P.nearest(P.lab(...P.parseHex(h6)), labs).index])}"`);
  }
  const rendered = new tool.resvg.Resvg(svg, { fitTo: { mode: 'width', value: w } }).render();
  const rp = rendered.pixels;
  let inter = 0, union = 0, err = 0, cnt = 0;
  for (let p = 0; p < w * h; p++) {
    const a = part[p * 4 + 3] >= 128, b = rp[p * 4 + 3] >= 128;
    if (a || b) union++;
    if (a && b) {
      inter++;
      if (part[p * 4 + 3] === 255 && rp[p * 4 + 3] === 255) { err += P.dE(P.lab(part[p * 4], part[p * 4 + 1], part[p * 4 + 2]), P.lab(rp[p * 4], rp[p * 4 + 1], rp[p * 4 + 2])); cnt++; }
    }
  }
  return { svg, render: Buffer.from(rp), paths: (svg.match(/<path/g) || []).length, iou: +(inter / Math.max(1, union)).toFixed(4), color_error: +(err / Math.max(1, cnt)).toFixed(2) };
}

async function cmdCut(o) {
  const file = path.resolve(need(o, 'image')), outDir = path.resolve(need(o, 'out'));
  const tool = o.vector ? loadTooling() : null;
  const img = readImage(file), { width: w, height: h, data: px } = img, n = w * h;
  const template = o.slots ? readSlots(o.slots, w, h) : null;
  // 名字优先用 --names（有模板时第 N 个名字对应第 N 格），否则用模板里写的名字。
  // 名字就是文件名：先清理、按小写去重（Windows 文件名不分大小写），命名和核对都用这一份。
  const given = names(o.names), raw = given.length ? given : template ? template.slots.map((s) => s.name) : [];
  const expected = [], expectedKeys = new Set();
  for (const x of raw) {
    if (!x) { expected.push(null); continue; }
    const base = safeName(x);
    let name = base;
    for (let k = 2; expectedKeys.has(name.toLowerCase()); k++) name = `${base}-${k}`;
    expectedKeys.add(name.toLowerCase());
    expected.push(name);
  }
  const list = expected.filter(Boolean);
  const nameAt = (slot, i) => (template ? expected[slot - 1] : expected[i]);
  const palette = o.palette ? names(o.palette).map((c) => P.parseHex(c) || die(M.assetsBadColor(c))) : null;
  if (o.matte != null && !['hard', 'soft'].includes(o.matte)) die(M.assetsUsage);
  const report = { version: 1, image: file, image_sha256: crypto.createHash('sha256').update(img.bytes).digest('hex'), size: [w, h] };

  // 1. 透明度：图里本来就有透明就清理它，否则按底色抠。
  let alpha = new Uint8Array(n), cut, transparentBefore = 0;
  for (let p = 0; p < n; p++) if (px[p * 4 + 3] < 250) transparentBefore++;
  if (img.hasAlpha && transparentBefore / n > 0.01) {
    // image_gen 的透明是后期抠的：实心像素是 253–254，边外有一圈 alpha < 48 的杂色光晕。hard 两头归整；soft 保留柔边，只去掉几乎看不见的。
    const matte = o.matte === 'soft' ? 'soft' : 'hard';
    let halo = 0;
    cut = Buffer.from(px);
    for (let p = 0; p < n; p++) {
      const a = px[p * 4 + 3];
      if (a > 0 && a < 48) halo++;
      alpha[p] = matte === 'soft' ? (a < 8 ? 0 : a) : a < 48 ? 0 : a >= 250 ? 255 : a;
      cut[p * 4 + 3] = alpha[p];
    }
    Object.assign(report, { method: 'alpha', matte, halo: +(halo / n).toFixed(4) });
  } else {
    const border = P.borderKey(px, w, h);
    const key = o.key && o.key !== 'auto' ? P.parseHex(o.key) || die(M.assetsBadColor(o.key)) : border.key;
    const kl = P.lab(...key), flood = kl[0] > 85 && Math.hypot(kl[1], kl[2]) < 12; // 白或浅灰底只去掉和边缘连通的部分
    const k = P.keyAlpha(px, w, h, key, { flood });
    alpha = k.alpha;
    cut = P.refineEdges(px, P.despill(px, alpha, key), w, h, key, alpha, k.dist, { reached: k.reached });
    const bg = [];
    for (let p = 0; p < n; p += 7) if (alpha[p] === 0) bg.push(k.dist[p]);
    bg.sort((a, b) => a - b);
    Object.assign(report, { method: flood ? 'key-flood' : 'key', key: P.hex(key), border_uniform: +border.uniform.toFixed(3), background_p99: +(bg[Math.floor(bg.length * 0.99)] ?? 0).toFixed(2) });
  }
  let transparent = 0, partial = 0, boundary = 0;
  for (let p = 0; p < n; p++) {
    if (alpha[p] === 0) transparent++;
    else if (alpha[p] < 255) partial++;
    const x = p % w;
    if (alpha[p] >= 128 && ((x > 0 && alpha[p - 1] < 128) || (x < w - 1 && alpha[p + 1] < 128) || (p >= w && alpha[p - w] < 128) || (p < n - w && alpha[p + w] < 128))) boundary++;
  }
  report.transparent = +(transparent / n).toFixed(3);
  report.edge_width = +(partial / Math.max(1, boundary)).toFixed(2);
  if (o.colors) report.colors = P.quantize(cut, num(o, 'colors', 0, true)).map(P.hex);
  if (palette && o.snap) P.snapToPalette(cut, palette);
  writePng(path.join(outDir, 'alpha.png'), w, h, cut);

  // 2. 切部件，有模板时按格子合并、命名。
  const { parts, specks, label } = P.splitParts(alpha, w, h, { gap: num(o, 'gap', 6), minArea: Math.round(num(o, 'min-area', 0.0004) * n), threshold: report.matte === 'soft' ? 8 : 128 });
  let items = parts.map((p) => ({ ...p, ids: new Set([p.id]), slot: template ? slotAt(template.slots, p.box) : null }));
  const merged = new Set();
  if (template) {
    const bySlot = new Map();
    for (const it of items) {
      if (it.slot === null) continue;
      const g = bySlot.get(it.slot);
      if (!g) { bySlot.set(it.slot, it); continue; }
      g.ids.add(it.id); g.area += it.area; it.merged = true; merged.add(it.slot);
      g.box = [Math.min(g.box[0], it.box[0]), Math.min(g.box[1], it.box[1]), Math.max(g.box[2], it.box[2]), Math.max(g.box[3], it.box[3])];
    }
    items = items.filter((it) => !it.merged).sort((a, b) => (a.slot ?? 1e9) - (b.slot ?? 1e9));
  }
  // 名单里的名字每个只给一个部件；没名字的部件用 slot-N / part-NN，避开名单里的名字和已用的名字。
  const taken = new Set();
  const nameOf = (it, i) => {
    const want = it.slot || !template ? nameAt(it.slot, i) : null;
    if (want && !taken.has(want.toLowerCase())) { taken.add(want.toLowerCase()); return want; }
    const base = want || (it.slot ? `slot-${it.slot}` : `part-${String(i + 1).padStart(2, '0')}`);
    let name = base;
    for (let k = 2; taken.has(name.toLowerCase()) || expectedKeys.has(name.toLowerCase()); k++) name = `${base}-${k}`;
    taken.add(name.toLowerCase());
    return name;
  };

  // 3. 每个部件裁出来（四周留 2 像素），可选矢量化。
  report.parts = [];
  const tiles = [], layers = [], paletteLabs = palette?.map((c) => P.lab(...c));
  for (const [i, it] of items.entries()) {
    const name = nameOf(it, i), [x0, y0, x1, y1] = it.box, bx = Math.max(0, x0 - 2), by = Math.max(0, y0 - 2);
    const bw = Math.min(w - 1, x1 + 2) - bx + 1, bh = Math.min(h - 1, y1 + 2) - by + 1, buf = Buffer.alloc(bw * bh * 4);
    const bins = new Map();
    let opaque = 0, onPalette = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const p = (by + y) * w + bx + x, q = (y * bw + x) * 4;
      if (!it.ids.has(label[p])) continue;
      cut.copy(buf, q, p * 4, p * 4 + 4);
      if (buf[q + 3] !== 255) continue;
      opaque++;
      const bin = ((buf[q] >> 4) << 8) | ((buf[q + 1] >> 4) << 4) | (buf[q + 2] >> 4);
      bins.set(bin, (bins.get(bin) || 0) + 1);
      if (palette && P.nearest(P.lab(buf[q], buf[q + 1], buf[q + 2]), paletteLabs).distance < 10) onPalette++;
    }
    // 4 位色阶里覆盖 95% 实心像素要几种颜色：越少越平，越好矢量化。
    let acc = 0, colors95 = 0;
    for (const c of [...bins.values()].sort((a, b) => b - a)) { acc += c; colors95++; if (acc >= opaque * 0.95) break; }
    const png = encodePng(bw, bh, buf), rel = `parts/${name}.png`;
    fs.mkdirSync(path.join(outDir, 'parts'), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), png);
    const row = { name, slot: it.slot, file: rel, crop: [bx, by, bw, bh], area: it.area, colors95, touches_edge: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1 };
    if (palette) row.on_palette = +(onPalette / Math.max(1, opaque)).toFixed(3);
    let render = null;
    if (tool) {
      const v = await vectorizePart(tool, png, bw, bh, buf, palette && o.snap ? palette : null);
      fs.writeFileSync(path.join(outDir, `parts/${name}.svg`), v.svg);
      Object.assign(row, { svg: `parts/${name}.svg`, paths: v.paths, iou: v.iou, color_error: v.color_error });
      render = v.render;
      layers.push(`<g id="${name}" transform="translate(${bx} ${by})">${v.svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</g>`);
    }
    tiles.push({ label: it.slot ?? i + 1, imgs: [buf, render].filter(Boolean), w: bw, h: bh });
    report.parts.push(row);
  }
  if (layers.length) fs.writeFileSync(path.join(outDir, 'layers.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${layers.join('\n')}\n</svg>\n`);
  writeSheet(path.join(outDir, 'sheet.png'), tiles);

  // 4. 判定：fail 要返工，needs_review 由 Claude 看图决定。
  const checks = [], add = (id, status, detail) => checks.push({ id, status, detail });
  const got = report.parts.map((p) => p.name), gotKeys = new Set(got.map((x) => x.toLowerCase()));
  if (!got.length) add('parts', 'fail', M.assetsCheck.empty);
  if (list.length) {
    const missing = list.filter((x) => !gotKeys.has(x.toLowerCase())), extra = got.filter((x) => !expectedKeys.has(x.toLowerCase())).length;
    add('names', missing.length || extra ? 'fail' : 'pass', missing.length || extra ? M.assetsCheck.names(missing, extra) : M.assetsCheck.namesOk(list.length));
  } else if (got.length) add('names', 'pass', M.assetsCheck.count(got.length));
  const outside = items.filter((it) => template && it.slot === null).length;
  if (outside) add('slots', 'fail', M.assetsCheck.outside(outside));
  if (merged.size) add('merged', 'needs_review', M.assetsCheck.merged([...merged].sort((a, b) => a - b)));
  const edge = report.parts.filter((p) => p.touches_edge).map((p) => p.name);
  if (edge.length) add('edge', o['allow-edge'] ? 'needs_review' : 'fail', M.assetsCheck.edge(edge));
  if (report.transparent < 0.05) add('transparency', 'fail', M.assetsCheck.noTransparency((report.transparent * 100).toFixed(1)));
  if (report.background_p99 > 6) add('background', 'needs_review', M.assetsCheck.background(report.background_p99));
  if (specks) add('specks', 'needs_review', M.assetsCheck.specks(specks));
  const loose = report.parts.filter((p) => p.iou != null && p.iou < 0.95).map((p) => p.name);
  if (loose.length) add('vector', 'needs_review', M.assetsCheck.vector(loose));
  report.checks = checks;
  report.ok = !checks.some((c) => c.status === 'fail');
  report.outputs = { dir: outDir, alpha: 'alpha.png', sheet: tiles.length ? 'sheet.png' : null, manifest: 'manifest.json', layers: layers.length ? 'layers.svg' : null };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({
    version: 1, source: { file, sha256: report.image_sha256, size: [w, h] }, template: template?.file ?? null,
    // crop 是部件在源图上的位置 [x, y, 宽, 高]；组装时的位置要另外确定，这里不猜。
    parts: report.parts.map((p) => ({ id: p.name, slot: p.slot, file: p.file, svg: p.svg ?? null, crop: p.crop })),
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  print(report);
}

// 对照拼图：每个部件一格（有 SVG 时左边原图、右边 SVG 渲染），棋盘格底，左上角是格子编号。
function writeSheet(file, tiles) {
  if (!tiles.length) return;
  const cell = 220, pad = 12, per = Math.max(...tiles.map((t) => t.imgs.length)), cols = Math.min(4, tiles.length), rows = Math.ceil(tiles.length / cols);
  const W = cols * (cell * per + pad) + pad, H = rows * (cell + pad) + pad, buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((x >> 4) + (y >> 4)) & 1 ? 205 : 245, o = (y * W + x) * 4;
    buf[o] = buf[o + 1] = buf[o + 2] = v; buf[o + 3] = 255;
  }
  tiles.forEach((t, i) => {
    const cx = pad + (i % cols) * (cell * per + pad), cy = pad + Math.floor(i / cols) * (cell + pad);
    t.imgs.forEach((img, j) => {
      const s = P.downscale(img, t.w, t.h, cell - 8, cell - 28);
      P.composite(buf, W, H, s.data, s.width, s.height, cx + j * cell + Math.round((cell - s.width) / 2), cy + 24 + Math.round((cell - 28 - s.height) / 2));
    });
    P.fillRect(buf, W, H, cx, cy, cx + 6 * 3 * String(t.label).length + 6, cy + 27, [255, 255, 255]);
    P.drawNumber(buf, W, H, t.label, cx + 3, cy + 3, 3, [34, 34, 34]);
  });
  writePng(file, W, H, buf);
}

function cmdCheck(o) {
  const dir = path.resolve(need(o, 'dir')), file = path.join(dir, 'report.json');
  if (!fs.existsSync(file)) die(M.assetsNoReport(dir));
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  print({ ok: r.ok, checks: r.checks, parts: r.parts.map((p) => ({ name: p.name, slot: p.slot, file: p.file })) });
  process.exitCode = r.ok ? 0 : 1;
}

// 改图前后逐格比较。两张图分别叠到黑底和白底上比，取较大的色差：透明像素底下的杂色不算，透明度的变化（部件被删掉）算。
function cmdDiff(o) {
  const a = readImage(path.resolve(need(o, 'before'))), b = readImage(path.resolve(need(o, 'after')));
  if (a.width !== b.width || a.height !== b.height) die(M.assetsSizeMismatch(`${a.width}x${a.height}`, `${b.width}x${b.height}`));
  const { width: w, height: h } = a;
  const over = (d, p, bg) => P.lab(...[0, 1, 2].map((c) => d[p * 4 + c] * (d[p * 4 + 3] / 255) + bg * (1 - d[p * 4 + 3] / 255)));
  const measure = (box) => {
    let sum = 0, cnt = 0, changed = 0;
    for (let y = Math.max(0, Math.floor(box[1])); y < Math.min(h, Math.ceil(box[3])); y++) for (let x = Math.max(0, Math.floor(box[0])); x < Math.min(w, Math.ceil(box[2])); x++) {
      const p = y * w + x, d = Math.max(P.dE(over(a.data, p, 0), over(b.data, p, 0)), P.dE(over(a.data, p, 255), over(b.data, p, 255)));
      sum += d; cnt++; if (d > 10) changed++;
    }
    return { mean_delta: +(sum / Math.max(1, cnt)).toFixed(2), changed: +(changed / Math.max(1, cnt)).toFixed(3) };
  };
  const slots = o.slots ? readSlots(o.slots, w, h).slots : [];
  print({ size: [w, h], overall: measure([0, 0, w, h]), slots: slots.map((s) => ({ slot: s.slot, name: s.name, ...measure(s.box) })) });
}

// 用 node 自带的 npm 装到用户目录；Windows 上 npm.cmd 不能直接 spawn，优先找 node 旁边的 npm-cli.js。
function cmdSetup() {
  fs.mkdirSync(TOOLING_DIR, { recursive: true });
  const pkg = path.join(TOOLING_DIR, 'package.json');
  if (!fs.existsSync(pkg)) fs.writeFileSync(pkg, JSON.stringify({ name: 'foreman-tooling', private: true }, null, 2) + '\n');
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const args = ['install', '--no-audit', '--no-fund', '--prefix', TOOLING_DIR, ...TOOLING_PACKAGES];
  const r = fs.existsSync(cli)
    ? spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, timeout: 600000 })
    : spawnSync('npm', args.map((a) => (process.platform === 'win32' ? `"${a}"` : a)), { encoding: 'utf8', windowsHide: true, timeout: 600000, shell: process.platform === 'win32' });
  const ok = r.status === 0;
  print({ ok, dir: TOOLING_DIR, packages: TOOLING_PACKAGES, message: ok ? M.assetsSetupDone(TOOLING_DIR) : M.assetsSetupFailed(r.error?.message || (r.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ')) });
  process.exitCode = ok ? 0 : 1;
}

export async function cmdAssets(o) {
  const actions = { template: cmdTemplate, cut: cmdCut, check: cmdCheck, diff: cmdDiff, setup: cmdSetup };
  if (!actions[o.action]) die(M.assetsUsage);
  await actions[o.action](o);
}
