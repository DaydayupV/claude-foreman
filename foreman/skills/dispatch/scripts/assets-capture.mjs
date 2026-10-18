// assets capture：用本机的 Chrome / Edge 无头模式按时刻截图（页面要支持 ?t=<秒> 停在某一时刻），再裁出 2 倍特写和对照拼图。
// assets playback：把一圈循环按帧截下来，统计不该动的区域有没有闪、首尾能不能接上、有没有突然跳一下，
// 写出能直接播放的 APNG 和翻页拼图，交给用户看实际播放。浏览器找不到时停下，说明怎么指定。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, encodeApng } from './png.mjs';
import * as P from './assets-pixels.mjs';
import { print, num, writePng, namedBoxes } from './assets-io.mjs';
import { M, die, need } from './util.mjs';

function findBrowser(o) {
  if (o.browser) return path.resolve(o.browser);
  if (process.env.FOREMAN_BROWSER) return process.env.FOREMAN_BROWSER;
  const env = (k) => process.env[k] || '';
  const list = process.platform === 'win32'
    ? [[env('ProgramFiles'), 'Google/Chrome/Application/chrome.exe'], [env('ProgramFiles(x86)'), 'Google/Chrome/Application/chrome.exe'], [env('LOCALAPPDATA'), 'Google/Chrome/Application/chrome.exe'],
      [env('ProgramFiles(x86)'), 'Microsoft/Edge/Application/msedge.exe'], [env('ProgramFiles'), 'Microsoft/Edge/Application/msedge.exe']].filter(([d]) => d).map(([d, f]) => path.join(d, f))
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].flatMap((n) => (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, n)));
  const found = list.find((f) => fs.existsSync(f));
  if (!found) die(M.assetsNoBrowser);
  return found;
}

const pageUrl = (u) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : pathToFileURL(path.resolve(u)).href);
// 时刻参数用 URL 对象设置：已有同名参数会被替换，#片段保持在最后
const atTime = (u, param, t) => { const url = new URL(u); url.searchParams.set(param, String(t)); return url.href; };
function size(o) {
  const m = /^(\d+)x(\d+)$/.exec(String(o.size || '960x540'));
  if (!m) die(M.assetsBadSize(o.size));
  return [Number(m[1]), Number(m[2])];
}

// 截一张：截图先写到系统临时目录（有的浏览器在非英文路径下不写文件），读回来；整张同一个颜色（页面还没画出来）时加长等待重截一次
function makeShooter(browser, [w, h], scale, wait) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-shot-'));
  const run = (url, waitMs, i) => {
    const file = path.join(tmp, `s${i}.png`), args = ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
      `--user-data-dir=${path.join(tmp, 'profile')}`, `--window-size=${w},${h}`, `--force-device-scale-factor=${scale}`, `--virtual-time-budget=${waitMs}`, `--screenshot=${file}`, url];
    const script = /\.[cm]?js$/i.test(browser);
    const r = spawnSync(script ? process.execPath : browser, script ? [browser, ...args] : args, { encoding: 'utf8', windowsHide: true, timeout: 90000 });
    if (!fs.existsSync(file)) throw new Error(M.assetsCaptureFailed(url, r.error?.message || (r.stderr || '').trim().split(/\r?\n/).slice(-2).join(' ') || `exit ${r.status}`));
    const img = decodePng(fs.readFileSync(file));
    fs.rmSync(file, { force: true });
    return img;
  };
  let n = 0;
  const blank = (img) => { const d = img.data, c = d.subarray(0, 3); for (let p = 0; p < d.length; p += 4 * 97) if (Math.abs(d[p] - c[0]) + Math.abs(d[p + 1] - c[1]) + Math.abs(d[p + 2] - c[2]) > 6) return false; return true; };
  return {
    shot(url) { let img = run(url, wait, n++), retried = false; if (blank(img)) { img = run(url, wait * 3, n++); retried = true; } return { img, retried, blank: blank(img) }; },
    done() { fs.rmSync(tmp, { recursive: true, force: true }); },
  };
}
const cropImg = (img, [x0, y0, x1, y1]) => {
  const X0 = Math.max(0, Math.round(x0)), Y0 = Math.max(0, Math.round(y0)), X1 = Math.min(img.width, Math.round(x1)), Y1 = Math.min(img.height, Math.round(y1)), cw = X1 - X0, ch = Y1 - Y0, b = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) img.data.copy(b, y * cw * 4, ((y + Y0) * img.width + X0) * 4, ((y + Y0) * img.width + X1) * 4);
  return { width: cw, height: ch, data: b };
};
// 网格拼图：每格缩到 cell 宽以内，cols 列
function grid(file, imgs, cell, cols) {
  const tiles = imgs.map((i) => P.downscale(i.data, i.width, i.height, cell, cell));
  const tw = Math.max(...tiles.map((t) => t.width)), th = Math.max(...tiles.map((t) => t.height)), rows = Math.ceil(tiles.length / cols);
  const W = cols * (tw + 6) + 6, H = rows * (th + 6) + 6, buf = Buffer.alloc(W * H * 4, 255);
  tiles.forEach((t, i) => P.composite(buf, W, H, t.data, t.width, t.height, 6 + (i % cols) * (tw + 6), 6 + Math.floor(i / cols) * (th + 6)));
  writePng(file, W, H, buf);
}
const label = (t) => String(+(+t).toFixed(3)).replace('.', '_');

export function cmdCapture(o) {
  const url = pageUrl(need(o, 'url')), out = path.resolve(need(o, 'out')), param = o.param || 't';
  const times = String(need(o, 'times')).split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (!times.length || !times.every((t) => Number.isFinite(t) && t >= 0)) die(M.assetsBadTimes(o.times));
  const dims = size(o), scale = num(o, 'scale', 2), wait = num(o, 'wait', 1500, true), zooms = namedBoxes(o.zoom, M.assetsBadZoom);
  const browser = findBrowser(o), shooter = makeShooter(browser, dims, scale, wait), frames = [];
  let err;
  try {
    for (const [i, t] of times.entries()) {
      // 文件名带序号：四舍五入后相同的时刻也不会互相覆盖
      const { img, retried, blank } = shooter.shot(atTime(url, param, t)), name = `${String(i).padStart(2, '0')}-t${label(t)}`;
      writePng(path.join(out, `${name}.png`), img.width, img.height, img.data);
      const zs = zooms.map((z) => {
        const c = cropImg(img, z.box.map((v) => v * scale)), f = path.join(out, 'zoom', `${name}-${z.name}.png`);
        writePng(f, c.width, c.height, c.data);
        return { name: z.name, file: f };
      });
      frames.push({ t, file: path.join(out, `${name}.png`), size: [img.width, img.height], zooms: zs, ...(retried ? { retried } : {}), ...(blank ? { blank } : {}), img });
    }
  } catch (e) { err = e; } finally { shooter.done(); }
  if (err) die(err.message);
  grid(path.join(out, 'sheet.png'), frames.map((f) => f.img), 480, Math.min(3, frames.length));
  const result = { browser, url, size: dims, scale, frames: frames.map(({ img, ...f }) => f), sheet: path.join(out, 'sheet.png') };
  if (frames.some((f) => f.blank)) result.note = M.assetsCaptureBlank;
  fs.writeFileSync(path.join(out, 'capture.json'), JSON.stringify(result, null, 2) + '\n');
  print(result);
}

// 两帧之间的变化：每隔 2 个像素取样，Lab 色差的平均值和变化像素（> 10）的比例；box 给定时只看那一块
function delta(a, b, box) {
  const [x0, y0, x1, y1] = box ? box.map(Math.round) : [0, 0, a.width, a.height];
  let sum = 0, n = 0, changed = 0;
  for (let y = Math.max(0, y0); y < Math.min(a.height, y1); y += 2) for (let x = Math.max(0, x0); x < Math.min(a.width, x1); x += 2) {
    const p = (y * a.width + x) * 4, d = P.dE(P.lab(a.data[p], a.data[p + 1], a.data[p + 2]), P.lab(b.data[p], b.data[p + 1], b.data[p + 2]));
    sum += d; n++; if (d > 10) changed++;
  }
  return { mean_delta: +(sum / Math.max(1, n)).toFixed(2), changed: +(changed / Math.max(1, n)).toFixed(4) };
}

export function cmdPlayback(o) {
  const url = pageUrl(need(o, 'url')), out = path.resolve(need(o, 'out')), param = o.param || 't';
  const loop = num(o, 'loop', null), fps = num(o, 'fps', 12), dims = size(o), scale = num(o, 'scale', 1), wait = num(o, 'wait', 1500, true);
  if (!loop) die(M.assetsUsage);
  // 一圈均匀分成 count 段，最后一帧正好落在 loop 上，才能和第一帧比首尾
  const statics = namedBoxes(o.static, M.assetsBadZoom), count = Math.max(2, Math.round(loop * fps)), step = loop / count;
  const browser = findBrowser(o), shooter = makeShooter(browser, dims, scale, wait), frames = [];
  let blanks = 0, err;
  try {
    for (let i = 0; i <= count; i++) {
      const t = +(i * step).toFixed(4), { img, blank } = shooter.shot(atTime(url, param, t));
      if (blank) blanks++;
      writePng(path.join(out, 'frames', `f${String(i).padStart(3, '0')}.png`), img.width, img.height, img.data);
      frames.push({ t, img });
    }
  } catch (e) { err = e; } finally { shooter.done(); }
  if (err) die(err.message);
  const steps = frames.slice(0, -1).map((f, i) => ({ t: f.t, ...delta(f.img, frames[i + 1].img) }));
  const sorted = steps.map((s) => s.mean_delta).sort((a, b) => a - b), median = sorted[Math.floor(sorted.length / 2)];
  const jumps = steps.filter((s) => s.mean_delta > Math.max(3 * median, median + 2)).map((s) => ({ t: s.t, mean_delta: s.mean_delta }));
  const seam = delta(frames[0].img, frames[count].img);
  const regions = statics.map((r) => {
    const ch = frames.slice(0, -1).map((f, i) => delta(f.img, frames[i + 1].img, r.box.map((v) => v * scale)).changed);
    return { name: r.name, box: r.box, max_changed: Math.max(...ch), mean_changed: +(ch.reduce((a, b) => a + b, 0) / ch.length).toFixed(4) };
  });
  // 播放文件：一圈（不含和第一帧重复的最后一帧），缩到宽 --preview-width（默认 480）以内
  const pw = num(o, 'preview-width', 480, true);
  const small = frames.slice(0, -1).map((f) => P.downscale(f.img.data, f.img.width, f.img.height, pw, pw));
  fs.writeFileSync(path.join(out, 'playback.png'), encodeApng(small[0].width, small[0].height, small.map((s) => s.data), step * 1000));
  grid(path.join(out, 'flipbook.png'), frames.slice(0, -1).map((f) => f.img), 240, 6);
  const result = {
    browser, url, loop, fps: +(1 / step).toFixed(3), frames: count, size: dims, scale,
    seam, median_step: median, jumps, static: regions,
    files: { playback: path.join(out, 'playback.png'), flipbook: path.join(out, 'flipbook.png'), frames: path.join(out, 'frames') },
    ...(blanks ? { note: M.assetsCaptureBlank } : {}),
  };
  fs.writeFileSync(path.join(out, 'playback.json'), JSON.stringify(result, null, 2) + '\n');
  print(result);
}
