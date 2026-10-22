#!/usr/bin/env node
// 从参考图生成 watch 启动动画的头像数据（foreman/skills/dispatch/scripts/watch-avatars.mjs）。
//
//   node tools/make-avatars.mjs [参考图=名单 ...] [--cell 11.6] [--cols 5] [--preview 预览.png] [--cards tools/avatars/cards]
//
// 参考图是黑底的像素头像，按行排列，每行 --cols 个，下面可以有名牌（会自动跳过）。
// 名单按顺序给每个头像起名，逗号分隔，写 - 的跳过；几张参考图取出的头像合在一起输出。
// 不给参考图时用默认的两张：source.webp 取前九个和 ???，source-grok.webp 只取第十个 Grok。
// --cell 是原图里一个像素格的边长（px），自动估计容易被大一倍的周期带偏，所以要手动给。
// 每个头像取两种尺寸：大 48×48（按半格取样）、中 36×36（按 2/3 格取样），都是正方形画布，
// 水平居中、底边对齐，空处透明；每种尺寸压成不超过 32 色的调色板。
// --cards 把每个角色留档成三张图：<名字>.png 是参考图上的原始卡片（带名牌），<名字>-48.png、<名字>-36.png
// 是实际用的两种尺寸放大 8 倍。角色说明见 tools/avatars/README.md。
// 解码图片用 Windows 自带的 WIC（通过 PowerShell），所以只能在 Windows 上运行。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const AVATAR_DIR = path.join(ROOT, 'tools', 'avatars');
const DEFAULT_SHEETS = [
  `${path.join(AVATAR_DIR, 'source.webp')}=claude,chatgpt,gemini,deepseek,mimo,glm,kimi,qwen,minimax,unknown`,
  `${path.join(AVATAR_DIR, 'source-grok.webp')}=-,-,-,-,-,-,-,-,-,grok`,
];
const sheetArgs = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const SHEETS = (sheetArgs.length ? sheetArgs : DEFAULT_SHEETS).map((a) => {
  const at = a.lastIndexOf('=');
  return { file: path.resolve(a.slice(0, at)), names: a.slice(at + 1).split(',') };
});
const CELL = Number(opt('cell', '11.6'));
const COLS = Number(opt('cols', '5'));
const OUT = path.join(ROOT, 'foreman', 'skills', 'dispatch', 'scripts', 'watch-avatars.mjs');
const SIZES = { L: { step: 2, n: 48 }, M: { step: 1.5, n: 36 } };
const MAX_COLORS = 32;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'; // '.' 表示透明

// ---- 解码成 BGRA ----
const ps = `Add-Type -AssemblyName PresentationCore
$fs = [System.IO.File]::OpenRead($env:AVATAR_SRC)
$dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($fs, 'PreservePixelFormat', 'OnLoad')
$bmp = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap($dec.Frames[0], [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
$buf = New-Object byte[] ($bmp.PixelWidth * $bmp.PixelHeight * 4)
$bmp.CopyPixels($buf, $bmp.PixelWidth * 4, 0)
[System.IO.File]::WriteAllBytes($env:AVATAR_RAW, $buf)
$fs.Close()
"$($bmp.PixelWidth) $($bmp.PixelHeight)"`;
let W, H, buf;
function decode(source) {
  const raw = path.join(os.tmpdir(), `foreman-avatars-${process.pid}.bgra`);
  const dec = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, AVATAR_SRC: source, AVATAR_RAW: raw } });
  if (dec.status !== 0) { console.error(dec.stderr || dec.stdout); process.exit(1); }
  [W, H] = dec.stdout.trim().split(/\s+/).map(Number);
  buf = fs.readFileSync(raw);
  fs.rmSync(raw, { force: true });
}
const px = (x, y) => { const i = (y * W + x) * 4; return [buf[i + 2], buf[i + 1], buf[i]]; };
const lit = (x, y) => Math.max(...px(x, y)) > 30;
const isBg = (p) => Math.max(...p) < 22;

// ---- 找头像：先按行分带（矮的是名牌，跳过），每带按列数在最空的列切开 ----
function findBoxes() {
  const rowN = Array.from({ length: H }, (_, y) => { let n = 0; for (let x = 0; x < W; x++) if (lit(x, y)) n++; return n; });
  const bands = [];
  for (let y = 0, s = -1; y <= H; y++) {
    const on = y < H && rowN[y] > 3;
    if (on && s < 0) s = y;
    if (!on && s >= 0) { bands.push([s, y - 1]); s = -1; }
  }
  const tallest = Math.max(...bands.map(([a, b]) => b - a));
  const boxes = [];
  for (const [y0, y1] of bands.filter(([a, b]) => b - a > tallest * 0.5)) {
    const colN = Array.from({ length: W }, (_, x) => { let n = 0; for (let y = y0; y <= y1; y++) if (lit(x, y)) n++; return n; });
    let left = 0; while (!colN[left]) left++;
    let right = W - 1; while (!colN[right]) right--;
    const cuts = [left];
    for (let k = 1; k < COLS; k++) {
      const e = Math.round(left + (k * (right - left)) / COLS);
      let best = e;
      for (let x = e - Math.round(CELL * 4); x <= e + Math.round(CELL * 4); x++) if (colN[x] < colN[best]) best = x;
      cuts.push(best);
    }
    cuts.push(right + 1);
    // 整张卡片（头像加下面的名牌）留档用：横向到相邻的切口，纵向到紧跟着的矮带的底边
    const label = bands.find(([a, b]) => a > y1 && b - a <= tallest * 0.5);
    for (let k = 0; k < COLS; k++) {
      let x0 = cuts[k], x1 = cuts[k + 1] - 1;
      const card = { x0, x1, y0, y1: label ? label[1] : y1 };
      while (!colN[x0]) x0++;
      while (!colN[x1]) x1--;
      boxes.push({ x0, x1, y0, y1, card });
    }
  }
  return boxes;
}

// ---- 格子的相位：在 CELL 附近找让格子边界落在颜色突变处最多的周期和起点 ----
function edgeScore(b, axis, p, ph) {
  let s = 0, n = 0;
  const len = axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0;
  for (let t = ph; t < len; t += p) {
    const k = Math.round(t);
    if (k < 1) continue;
    for (let o = axis === 'x' ? b.y0 : b.x0; o <= (axis === 'x' ? b.y1 : b.x1); o += 2) {
      const [a, c] = axis === 'x' ? [px(b.x0 + k, o), px(b.x0 + k - 1, o)] : [px(o, b.y0 + k), px(o, b.y0 + k - 1)];
      s += Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1]) + Math.abs(a[2] - c[2]);
    }
    n++;
  }
  return s / n;
}
function fit(b, axis) {
  let best = null;
  for (let p = CELL - 0.4; p <= CELL + 0.4; p += 0.02) for (let ph = 0; ph < p; ph += 0.25) {
    const sc = edgeScore(b, axis, p, ph);
    if (!best || sc > best.sc) best = { p, ph, sc };
  }
  return best;
}

// ---- 取样成 n×n：大尺寸取格心的中位数（保留锐利的边），中尺寸取整格平均（抗锯齿） ----
const median = (v) => (v.sort((a, b) => a - b), v[v.length >> 1]);
const mean = (v) => Math.round(v.reduce((a, c) => a + c, 0) / v.length);
function sample(b, fx, fy, step, n) {
  const sharp = step >= 2, lo = sharp ? 0.3 : 0.05, hi = sharp ? 0.7 : 0.95, agg = sharp ? median : mean;
  const cx = fx.p / step, cy = fy.p / step, ox = b.x0 + fx.ph, oy = b.y0 + fy.ph;
  const sx = ox + Math.round(((b.x0 + b.x1 + 1) / 2 - (n * cx) / 2 - ox) / cx) * cx; // 水平居中
  const sy = oy + Math.round((b.y1 + 1 - n * cy - oy) / cy) * cy; // 底边对齐
  return Array.from({ length: n }, (_, j) => Array.from({ length: n }, (_, i) => {
    const rs = [], gs = [], bs = [];
    let bg = 0;
    for (let y = Math.ceil(sy + (j + lo) * cy); y <= sy + (j + hi) * cy; y++) {
      for (let x = Math.ceil(sx + (i + lo) * cx); x <= sx + (i + hi) * cx; x++) {
        const p = x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 ? px(x, y) : null;
        if (!p || isBg(p)) { bg++; continue; }
        rs.push(p[0]); gs.push(p[1]); bs.push(p[2]);
      }
    }
    return rs.length > bg ? [agg(rs), agg(gs), agg(bs)] : null;
  }));
}

// ---- 减色：k-means，起点按亮度排序后均匀挑，结果稳定可复现 ----
function quantize(grid) {
  const colors = grid.flat().filter(Boolean);
  const key = (c) => c.join(',');
  const uniq = [...new Map(colors.map((c) => [key(c), c])).values()].sort((a, b) => a[0] * 3 + a[1] * 6 + a[2] - (b[0] * 3 + b[1] * 6 + b[2]));
  const k = Math.min(MAX_COLORS, uniq.length);
  let centers = Array.from({ length: k }, (_, i) => uniq[Math.floor(((i + 0.5) * uniq.length) / k)]);
  const dist = (a, b) => (a[0] - b[0]) ** 2 * 2 + (a[1] - b[1]) ** 2 * 4 + (a[2] - b[2]) ** 2 * 3;
  const nearest = (c) => { let bi = 0; for (let i = 1; i < centers.length; i++) if (dist(c, centers[i]) < dist(c, centers[bi])) bi = i; return bi; };
  for (let it = 0; it < 12; it++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (const c of colors) { const s = sums[nearest(c)]; s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++; }
    centers = centers.map((c, i) => (sums[i][3] ? sums[i].slice(0, 3).map((v) => Math.round(v / sums[i][3])) : c));
  }
  const palette = centers.map((c) => c.map((v) => v.toString(16).padStart(2, '0')).join(''));
  const rows = grid.map((row) => row.map((c) => (c ? ALPHABET[nearest(c)] : '.')).join(''));
  return { palette, rows, preview: grid.map((row) => row.map((c) => (c ? centers[nearest(c)] : null))) };
}

const data = {};
const previews = [];
const cards = [];
const cardsDir = opt('cards');
const crop = ({ x0, x1, y0, y1 }) => {
  const w = x1 - x0 + 1, h = y1 - y0 + 1, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.set([...px(x0 + x, y0 + y), 255], (y * w + x) * 4);
  return { w, h, rgba: out };
};
for (const { file, names } of SHEETS) {
  decode(file);
  const boxes = findBoxes();
  if (boxes.length < names.length) { console.error(`${path.basename(file)} 只找到 ${boxes.length} 个头像，名单有 ${names.length} 个`); process.exit(1); }
  names.forEach((name, i) => {
    if (name === '-') return;
    const b = boxes[i], fx = fit(b, 'x'), fy = fit(b, 'y');
    data[name] = {};
    const card = { name, sheet: path.basename(file), slot: i + 1, grids: {} };
    for (const [size, { step, n }] of Object.entries(SIZES)) {
      const q = quantize(sample(b, fx, fy, step, n));
      data[name][size] = { palette: q.palette, rows: q.rows };
      card.grids[n] = q.preview;
      if (size === 'L') previews.push(q.preview);
    }
    if (cardsDir) card.original = crop(b.card);
    cards.push(card);
    console.log(`${name}: 格子 ${fx.p.toFixed(2)}×${fy.p.toFixed(2)} px，大 ${data[name].L.palette.length} 色，中 ${data[name].M.palette.length} 色`);
  });
}

const body = Object.entries(data).map(([name, sizes]) => `  ${name}: {\n${Object.entries(sizes).map(([size, { palette, rows }]) => `    ${size}: {\n      palette: ${JSON.stringify(palette)},\n      rows: [\n${rows.map((r) => `        '${r}',`).join('\n')}\n      ],\n    },`).join('\n')}\n  },`).join('\n');
fs.writeFileSync(OUT, `// 自动生成，不要手改：node tools/make-avatars.mjs（参考图在 tools/avatars/）
// watch 启动动画的像素头像。每个头像有大（48×48）、中（36×36）两种尺寸，
// rows 里每个字符是 palette 的下标（${ALPHABET.slice(0, 10)}…），'.' 是透明。
export const AVATAR_ALPHABET = '${ALPHABET}';
export const AVATARS = {
${body}
};
`);
console.log(`已写入 ${path.relative(ROOT, OUT)}`);

// ---- PNG：RGBA，8 位 ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(type), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function writePng(file, w, h, rgba) {
  const rawRows = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(rawRows, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rawRows)), chunk('IEND', Buffer.alloc(0))]));
}
// 像素网格放大 S 倍画到画布的 (ox, oy)，透明处留给画布的底色
function paint(img, PW, grid, ox, oy, S) {
  grid.forEach((row, j) => row.forEach((p, i) => {
    if (!p) return;
    for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) img.set([...p, 255], (((oy + j) * S + dy) * PW + (ox + i) * S + dx) * 4);
  }));
}

// ---- 可选：把大尺寸拼成一张放大 4 倍的 PNG，方便肉眼核对 ----
const previewFile = opt('preview');
if (previewFile) {
  const S = 4, cw = 50, PW = cw * COLS * S, PH = cw * Math.ceil(previews.length / COLS) * S, img = Buffer.alloc(PW * PH * 4);
  for (let k = 0; k < PW * PH; k++) img.set([24, 24, 24, 255], k * 4);
  previews.forEach((g, c) => {
    for (let j = 0; j < 48; j++) for (let i = 0; i < 48; i++) for (let dy = 0; dy < S; dy++) for (let dx = 0; dx < S; dx++) img.set([0, 0, 0, 255], ((((Math.floor(c / COLS) * cw) + j) * S + dy) * PW + ((c % COLS) * cw + i) * S + dx) * 4);
    paint(img, PW, g, (c % COLS) * cw, Math.floor(c / COLS) * cw, S);
  });
  writePng(previewFile, PW, PH, img);
  console.log(`预览：${previewFile}`);
}

// ---- 可选：留档每个角色的卡片：参考图上的原始卡片，和放大 8 倍的大、中两种头像（铺启动动画的深色底） ----
if (cardsDir) {
  fs.mkdirSync(cardsDir, { recursive: true });
  const S = 8;
  for (const { name, original, grids } of cards) {
    writePng(path.join(cardsDir, `${name}.png`), original.w, original.h, original.rgba);
    for (const [n, grid] of Object.entries(grids)) {
      const PW = n * S, img = Buffer.alloc(PW * PW * 4);
      for (let k = 0; k < PW * PW; k++) img.set([16, 16, 22, 255], k * 4);
      paint(img, PW, grid, 0, 0, S);
      writePng(path.join(cardsDir, `${name}-${n}.png`), PW, PW, img);
    }
  }
  console.log(`卡片：${cardsDir}（${cards.map((c) => `${c.name}=${c.sheet}#${c.slot}`).join('，')}）`);
}
