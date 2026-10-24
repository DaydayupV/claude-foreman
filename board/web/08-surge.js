'use strict';
// 输出突然加快时的脉冲：弧线区中心先闪一圈，一道亮光沿这条车道的汇流线从弧线区传到卡片，再沿光带从卡片传到产出框。
// 判断加快：每条车道的速度和它最近几秒的平均（指数平滑，约 4 秒）比，一下子高出一截（高出 60% 以上、至少多 15 tok/s）
// 就算一次加速；同一条车道 6 秒内只放一次。速度从 0 起步也算（开始出字时亮一下）。切换动画中、要求减少动效时不放。
const SURGE = new Map(); // 车道 id → { base: 平滑后的速度, at: 上次更新（屏幕秒）, t0: 这次脉冲开始（屏幕秒）, k: 强度 0.4–1 }
const SURGE_CORE = 0.45, SURGE_BUNDLE = 1.05, SURGE_RIBBON = 1.3;
const SURGE_TOTAL = SURGE_BUNDLE + SURGE_RIBBON;

function trackSurges(rates, quiet) {
  const now = performance.now() / 1000;
  for (const [id, rate] of rates) {
    let s = SURGE.get(id);
    if (!s) { SURGE.set(id, { base: rate, at: now, t0: -Infinity, k: 0 }); continue; }
    const dt = Math.min(1, Math.max(0, now - s.at));
    s.at = now;
    if (!quiet && !reduceMotion.matches && rate > s.base * 1.6 && rate - s.base >= 15 && now - s.t0 > 6) {
      s.t0 = now; s.k = 0.4 + 0.6 * clamp01((rate - s.base) / 80);
    }
    s.base += (rate - s.base) * (1 - Math.exp(-dt / 4));
  }
  for (const id of [...SURGE.keys()]) if (!rates.has(id)) SURGE.delete(id);
}
// 这条车道的脉冲走了多少屏幕秒；没有正在走的返回 null
function surgeAge(id) {
  const s = SURGE.get(id);
  if (!s) return null;
  const age = performance.now() / 1000 - s.t0;
  return age >= 0 && age < SURGE_TOTAL ? age : null;
}
const surgeK = (id) => SURGE.get(id)?.k ?? 0;

// ① 弧线区中心闪一下：一团车道颜色的光，外面一圈往外扩
function drawSurgeCore(c, id, age) {
  const u = age / SURGE_CORE, k = surgeK(id), color = tintOf(id);
  if (u >= 1) return;
  const r = c.R * (0.12 + 0.3 * ease(u)), g = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, r);
  g.addColorStop(0, HI(0.55 * k * (1 - u))); g.addColorStop(0.35, color(0.35 * k * (1 - u))); g.addColorStop(1, color(0));
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.cx, c.cy, r, 0, 6.283); ctx.fill();
  ring(c.cx, c.cy, u, color, c.R * 0.08, c.R * 0.55);
}
// ② 汇流线上的亮光：沿一条曲线从弧线区（u = 0）走到卡片（u = 1），拖一小段尾巴
function drawSurgeAlong(q, age, color, k) {
  const u = ease(clamp01((age - SURGE_CORE * 0.4) / (SURGE_BUNDLE - SURGE_CORE * 0.4)));
  if (u <= 0 || u >= 1) return;
  ctx.beginPath();
  for (let j = 0; j <= 6; j++) { const [x, y] = cubicAt(q, Math.max(0, u - 0.08 + j * 0.08 / 6)); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  ctx.strokeStyle = HI(0.85 * k * (1 - 0.3 * u)); ctx.lineWidth = 1.7 * FX.lw; ctx.stroke();
  const [hx, hy] = cubicAt(q, u);
  glowDot(hx, hy, 2.2, color, k);
}
// ③ 卡片到产出框：交给光带自己的脉冲（drawCone 的 pulseAges），这里换算成光带上的时刻
function surgePulses(lanes) {
  const out = [];
  for (const lane of lanes) {
    const age = surgeAge(lane.id);
    if (age != null && age > SURGE_BUNDLE) out.push({ lane: lane.id, out: true, age: age - SURGE_BUNDLE });
  }
  return out;
}
