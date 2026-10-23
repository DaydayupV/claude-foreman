'use strict';
// 统一平滑：光路的显隐、亮度、宽度和终点不再按开/关直接切换，而是每帧往目标值靠过去（约 0.8 秒走完九成）。
// 时间突然跳的时候（?t= 停在固定时刻、刚打开页面、回放跳时间、画布停画了一阵）直接取目标值，截图和定位不受影响。

const SMOOTH = { vals: new Map(), lastT: null, lastMs: 0, k: 1 };

// 流动和旋转的相位按帧累加（速度 × 这一帧隔了多久）。直接用"时间 × 当前速度"的话，
// 时间是几千秒，速度稍微变小相位就往回退一大截，看上去就是倒流、倒转
const FLOW = new Map();
function flowPhase(key, speed) {
  const ms = performance.now(), f = FLOW.get(key);
  if (!f) { FLOW.set(key, { ms, p: 0 }); return 0; }
  f.p += speed * Math.min(0.1, (ms - f.ms) / 1000); // 画布停画了一阵再回来时不跳
  f.ms = ms;
  return f.p;
}
const SMOOTH_TAU = 0.35; // 秒：时间常数，越大过渡越慢

// 每次画画布前调用：按这一帧和上一帧隔了多久算靠拢的比例
function smoothFrame(t) {
  const ms = performance.now(), dt = SMOOTH.lastMs ? (ms - SMOOTH.lastMs) / 1000 : Infinity;
  // 记录时间走得和墙上时间对不上（不是连续播放），或者两帧隔太久，就当成跳了
  const jump = SMOOTH.lastT == null || B.clock.frozenAt != null || dt > 0.5 || Math.abs(secSince(SMOOTH.lastT, t) - dt) > 1;
  SMOOTH.k = jump ? 1 : 1 - Math.exp(-dt / SMOOTH_TAU);
  SMOOTH.lastT = t;
  SMOOTH.lastMs = ms;
}

// key 这个量的平滑值。第一次出现时从 from 开始（显隐类默认从 0 淡入；位置类传目标值本身，免得从原点飞过来）
function smooth(key, target, from = 0) {
  const v = SMOOTH.vals.has(key) ? SMOOTH.vals.get(key) : SMOOTH.k >= 1 ? target : from;
  const next = SMOOTH.k >= 1 ? target : v + (target - v) * SMOOTH.k;
  SMOOTH.vals.set(key, Math.abs(next - target) < 1e-4 ? target : next);
  return next;
}

// 位置：和 smooth 一样往目标靠，但一下跳得比 snap 还远的（刻度带绕圈时从顶上回到底下）直接到位
function smoothY(key, y, snap) {
  const v = SMOOTH.vals.get(key);
  if (v != null && Math.abs(v - y) > snap) { SMOOTH.vals.set(key, y); return y; }
  return smooth(key, y, y);
}

// 输出通道的终点（光团和输出框之间切换时）平滑挪过去。按相对产出框的位置平滑：刻度带滚动时框在动，
// 按绝对坐标平滑会拖在后面，卡片从顶上绕回底下时还会横扫过整个屏幕
function smoothTarget(id, tg, box) {
  const dx = smooth(`tgx|${id}`, tg.x - box.x, tg.x - box.x), dy = smooth(`tgy|${id}`, tg.y - box.y, tg.y - box.y);
  return { ...tg, x: box.x + dx, y: box.y + dy, half: smooth(`tgh|${id}`, tg.half, tg.half) };
}
