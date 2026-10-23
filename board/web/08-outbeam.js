'use strict';
// 产出光路（卡片 → 产出框）的几种样式。光路由两条边界曲线 E0、E1 围成（卡片一端宽、产出框一端窄），
// 各样式在这个形状里画；只有对话活跃时才流动，产出事件（ages）让一道亮带从卡片扫到产出框。

const OUT_STYLES = [
  ['fibers', '光纤'], ['particles', '粒子流'], ['tube', '光管'], ['curtain', '光幕'], ['rays', '放射线'],
];
// 选定的样式是粒子流；URL 里的 out= 仍可临时换成别的样式做对比
const OUT = { style: new URLSearchParams(location.search).get('out') || 'particles' };

const lerp2 = (a, b, v) => [a[0] + (b[0] - a[0]) * v, a[1] + (b[1] - a[1]) * v];
const lerpCurve = (E0, E1, v) => E0.map((p, i) => lerp2(p, E1[i], v));
const at = (E0, E1, u, v) => lerp2(cubicAt(E0, u), cubicAt(E1, u), v);

function tracePath(E0, E1, n = 28) {
  ctx.beginPath();
  for (let i = 0; i <= n; i++) { const [x, y] = cubicAt(E0, i / n); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
  for (let i = n; i >= 0; i--) { const [x, y] = cubicAt(E1, i / n); ctx.lineTo(x, y); }
  ctx.closePath();
}

function drawOutBeam(E0, E1, color, I, live, seed, ages) {
  const style = OUT.style, act = 0.2 + (0.3 + 0.5 * I) * live, sec = performance.now() / 1000, flow = flowPhase(`out|${seed}`, 0.18 + 0.5 * I);
  const a0 = E0[0], a1 = E0[3];
  ctx.save();
  if (style === 'rays') {
    const paths = [];
    for (let i = 0; i < 13; i++) paths.push(lerpCurve(E0, E1, (i + 0.5) / 13));
    drawCone(paths, color, I, live, seed, []);
  } else if (style === 'fibers') {
    // 五条光纤：最外两条贴着边，中间三条；柔光 + 细线，活跃时光点沿纤维走
    for (let f = 0; f < 5; f++) {
      const q = lerpCurve(E0, E1, f / 4);
      const g = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
      g.addColorStop(0, HI(0.2 + 0.35 * act)); g.addColorStop(0.5, color(0.12 + 0.3 * act)); g.addColorStop(1, color(0.3 + 0.45 * act));
      strokeCubic(q);
      ctx.strokeStyle = color(0.05 + 0.1 * act); ctx.lineWidth = 4 * FX.lw; ctx.stroke();
      ctx.strokeStyle = g; ctx.lineWidth = 1.1 * FX.lw; ctx.stroke();
      if (live) for (let j = 0; j < 2; j++) {
        const u = ((flow * (0.8 + f * 0.07) + f * 0.21 + j * 0.5) % 1);
        const [x, y] = cubicAt(q, u);
        glowDot(x, y, 1.6 + 0.8 * I, color, Math.min(1, u * 6, (1 - u) * 6));
      }
    }
  } else if (style === 'particles') {
    // 星河：通道里几条像核心网那样的细弧线（慢慢起伏、互相交错），上面漂着放慢的光点；没有输出时整条通道不画
    // 有多少：强度定粒子数，边界上那一颗按小数部分半透明；整条通道再乘上活跃程度和"有没有输出"，淡入淡出而不是整批出现
    const rand = rng(seed), want = 20 + 32 * I, pres = clamp01(I / 0.06) * live, n = pres > 0.005 ? Math.ceil(want) : 0, drift = flowPhase(`cloud|${seed}`, 0.05 + 0.14 * I);
    const ga = ctx.globalAlpha;
    ctx.globalAlpha = ga * pres;
    if (n) {
      const g = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
      g.addColorStop(0, HI(0.08 + 0.2 * I)); g.addColorStop(0.5, color(0.12 + 0.26 * I)); g.addColorStop(1, color(0.16 + 0.34 * I));
      ctx.strokeStyle = g; ctx.lineWidth = 0.8 * FX.lw;
      // 起伏按通道宽度的比例算（在两条边之间的位置 v 上摆动），通道横着展开（Claude Code 从卡片顶边出来）也一样起伏
      for (let f = 0; f < 9; f++) {
        const v = (f + 0.5) / 9, v1 = v + 0.45 * Math.sin(sec * 0.45 + f * 1.7), v2 = v + 0.6 * Math.sin(sec * 0.36 + f * 2.9);
        strokeCubic([lerp2(E0[0], E1[0], v), lerp2(E0[1], E1[1], v1), lerp2(E0[2], E1[2], v2), lerp2(E0[3], E1[3], v)]);
        ctx.stroke();
      }
    }
    for (let i = 0; i < n; i++) {
      const v = 0.08 + rand() * 0.84, ph = rand(), sp = 0.6 + rand() * 0.8;
      const u = (drift * sp + ph) % 1, [x, y] = at(E0, E1, u, v + Math.sin(sec * 2 + ph * 9) * 0.03);
      const a = Math.min(1, u * 5, (1 - u) * 5) * (0.5 + 0.5 * act) * clamp01(want - i);
      ctx.fillStyle = i % 3 ? color(0.85 * a) : HI(0.9 * a);
      const r = (1.3 + rand() * 1.3) * FX.lw;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      // 每三颗里有一颗带柔光，远看也看得出在流动
      if (i % 3 === 0) { ctx.fillStyle = color(0.18 * a); ctx.beginPath(); ctx.arc(x, y, r * 3, 0, 6.283); ctx.fill(); }
    }
    ctx.globalAlpha = ga;
  } else if (style === 'tube') {
    // 光管：一道柔和的锥形光，中间一条亮芯，活跃时光点沿亮芯流动
    tracePath(E0, E1);
    const g = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
    g.addColorStop(0, HI(0.03 + 0.05 * act)); g.addColorStop(0.5, color(0.04 + 0.06 * act)); g.addColorStop(1, color(0.1 + 0.14 * act));
    ctx.fillStyle = g; ctx.fill();
    const core = lerpCurve(E0, E1, 0.5);
    strokeCubic(core);
    ctx.strokeStyle = color(0.08 + 0.16 * act); ctx.lineWidth = 7 * FX.lw; ctx.stroke();
    ctx.strokeStyle = HI(0.25 + 0.5 * act); ctx.lineWidth = 1.2 * FX.lw; ctx.stroke();
    if (live) for (let j = 0; j < 3; j++) {
      const u = (flow + j / 3) % 1, [x, y] = cubicAt(core, u);
      glowDot(x, y, 2 + I, color, Math.min(1, u * 6, (1 - u) * 6));
    }
  } else if (style === 'curtain') {
    // 光幕：渐变填充的漏斗，边缘两条细线；活跃时一道光泽从卡片扫向产出框
    tracePath(E0, E1);
    const g = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
    g.addColorStop(0, HI(0.06 + 0.06 * act)); g.addColorStop(0.6, color(0.06 + 0.1 * act)); g.addColorStop(1, color(0.14 + 0.2 * act));
    ctx.fillStyle = g; ctx.fill();
    if (live) {
      const s = (flow * 0.8) % 1, sh = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
      sh.addColorStop(Math.max(0, s - 0.12), HI(0)); sh.addColorStop(s, HI(0.12 + 0.18 * I)); sh.addColorStop(Math.min(1, s + 0.12), HI(0));
      ctx.fillStyle = sh; ctx.fill();
    }
    ctx.strokeStyle = color(0.25 + 0.35 * act); ctx.lineWidth = 0.8 * FX.lw;
    strokeCubic(E0); ctx.stroke(); strokeCubic(E1); ctx.stroke();
  }
  // 产出脉冲：从卡片走到产出框；粒子流里是一列亮光点，其他样式是一道横跨光路的亮带
  for (const age of ages) {
    const u = ease(Math.min(1, age / 1.3)), a = 1 - Math.min(1, age / 1.3);
    if (style === 'particles') {
      for (let j = 0; j < 9; j++) { const [x, y] = at(E0, E1, u, (j + 0.5) / 9); glowDot(x, y, 1.8, color, a); }
      continue;
    }
    const [x0, y0] = cubicAt(E0, u), [x1, y1] = cubicAt(E1, u);
    ctx.strokeStyle = HI(0.9 * a); ctx.lineWidth = 1.8 * FX.lw;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}
