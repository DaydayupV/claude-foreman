'use strict';
// 光束（世界坐标）。

// 互联网光线：起点在核心网中心周围一圈（0.15R–0.45R）里随机，先朝外弯出去，再拐向卡片的 token 接口
// （Claude Code 从右边进、席位从左边进）。起点一端透明、渐渐融进白色弧线，越靠近卡片越显出卡片的颜色。
// 只有对话正在活跃进行时才流动，token/s 越快越亮、流得越快；不活跃时是一道静止的暗线。
// surge：这条车道输出突然加快后的屏幕秒数（08-surge.js），有的话一道亮光沿每条线从弧线区走到卡片
function drawBundle(c, lane, p, I, live, surge = null) {
  const rand = rng(hash(`bundle|${lane.id}`)), k = (p.visible === false ? 0.45 : 1) * (0.45 + 0.55 * live);
  const side = p.tok[0] < c.cx ? 1 : -1; // 卡片在左边时，线从卡片右侧进来
  const color = tintOf(lane.id), flow = flowPhase(`bundle|${lane.id}`, 10 + 70 * I);
  ctx.save();
  for (let i = 0; i < 10; i++) {
    const a0 = rand() * Math.PI * 2, r0 = c.R * (0.15 + rand() * 0.3);
    const sx = c.cx + Math.cos(a0) * r0, sy = c.cy + Math.sin(a0) * r0;
    const a = a0 + (rand() - 0.5) * 1.8, out = c.R * (0.18 + rand() * 0.25);
    const ex = p.tok[0], ey = p.tok[1] + (rand() - 0.5) * 8;
    const q = [[sx, sy], [sx + Math.cos(a) * out, sy + Math.sin(a) * out], [ex + side * (60 + rand() * 120), ey + (rand() - 0.5) * 50], [ex, ey]];
    const g = ctx.createLinearGradient(sx, sy, ex, ey);
    g.addColorStop(0, HI(0)); g.addColorStop(0.3, HI(0.12 * k)); g.addColorStop(0.7, color((0.22 + 0.35 * I) * k)); g.addColorStop(1, color((0.4 + 0.45 * I) * k));
    strokeCubic(q);
    ctx.strokeStyle = g; ctx.lineWidth = 0.9 * FX.lw; ctx.stroke();
    if (surge != null) { drawSurgeAlong(q, surge, color, surgeK(lane.id) * k); strokeCubic(q); }
    if (live > 0.01) {
      // 流动的光点随活跃程度淡入淡出
      const d = ctx.createLinearGradient(sx, sy, ex, ey);
      d.addColorStop(0, HI(0)); d.addColorStop(0.35, HI((0.15 + 0.3 * I) * live)); d.addColorStop(1, HI((0.35 + 0.6 * I) * live));
      ctx.lineDashOffset = -(flow + i * 7 + (lane.seed % 50));
      if (LOOK.dots) {
        // 圆形光点：长度几乎为零的虚线段配圆头，外面再叠一圈同色柔光
        ctx.lineCap = 'round'; ctx.setLineDash([0.01, 22 * FX.lw]);
        const gl = ctx.createLinearGradient(sx, sy, ex, ey);
        gl.addColorStop(0, color(0)); gl.addColorStop(0.4, color((0.08 + 0.12 * I) * k * live)); gl.addColorStop(1, color((0.18 + 0.25 * I) * k * live));
        ctx.strokeStyle = gl; ctx.lineWidth = (5 + 2 * I) * FX.lw; ctx.stroke();
        ctx.strokeStyle = d; ctx.lineWidth = (1.9 + 0.8 * I) * FX.lw; ctx.stroke();
        ctx.lineCap = 'butt';
      } else {
        ctx.setLineDash([4 * FX.lw, 24 * FX.lw]);
        ctx.strokeStyle = d; ctx.lineWidth = (1.3 + 0.6 * I) * FX.lw; ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// 一束从宽到窄的光：from 一侧的点列到 to 一侧的点列一一对应连线（paths 给出每条线的三次贝塞尔）。
// 底下一层淡光，上面一束细线，再叠流动的光段和闪烁的亮块；pulses 里的产出事件让一道亮带沿光束走过去
function drawCone(paths, color, I, live, seed, pulseAges) {
  const sec = performance.now() / 1000, rand = rng(seed), act = live ? 0.45 + 0.55 * I : 0.25;
  ctx.save();
  // 细线：近卡片一端亮、中间淡下去，到产出框收拢时又亮起来
  const [a0, a1] = [paths[0][0], paths[0][3]];
  const grad = ctx.createLinearGradient(a0[0], a0[1], a1[0], a1[1]);
  grad.addColorStop(0, HI(0.12 + 0.3 * act)); grad.addColorStop(0.45, color(0.03 + 0.08 * act)); grad.addColorStop(1, color(0.12 + 0.3 * act));
  ctx.strokeStyle = grad; ctx.lineWidth = 0.9 * FX.lw;
  ctx.beginPath();
  for (const q of paths) { ctx.moveTo(...q[0]); ctx.bezierCurveTo(...q[1], ...q[2], ...q[3]); }
  ctx.stroke();
  // 流动的光段：只在对话活跃时流，越活跃越亮越快
  const flow = flowPhase(`cone|${seed}`, 14 + 80 * I);
  ctx.lineWidth = 1.9 * FX.lw;
  for (let i = 0; i < paths.length && live; i++) {
    const len = 8 + rand() * 20, gap = 50 + rand() * 90, ph = rand() * 200;
    ctx.setLineDash([len * FX.lw, gap * FX.lw]);
    ctx.lineDashOffset = -(flow * (0.7 + rand() * 0.6) + ph);
    ctx.strokeStyle = i % 3 ? color(0.3 + 0.6 * act) : HI(0.35 + 0.6 * act);
    strokeCubic(paths[i]); ctx.stroke();
  }
  ctx.setLineDash([]);
  // 闪烁的亮块（上一版光束里零星的亮块），也只在活跃时出现
  ctx.lineWidth = 2.4 * FX.lw;
  for (let i = 0; i < (live ? 3 + 6 * I : 0); i++) {
    const q = paths[Math.floor(rand() * paths.length)], u = 0.1 + rand() * 0.75, ph = rand() * 6.28;
    if (Math.sin(sec * 3.1 + ph * 3) < -0.1) continue;
    const [x1, y1] = cubicAt(q, u), [x2, y2] = cubicAt(q, Math.min(1, u + 0.03));
    ctx.strokeStyle = color(0.75); ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  // 产出脉冲：一道亮带从卡片走到产出框
  for (const age of pulseAges) {
    const u = ease(Math.min(1, age / 1.3)), a = 1 - Math.min(1, age / 1.3);
    ctx.beginPath();
    paths.forEach((q, i) => { const [x, y] = cubicAt(q, u); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = HI(0.9 * a); ctx.lineWidth = 1.6 * FX.lw; ctx.stroke();
  }
  ctx.restore();
}

// 席位卡片 → 产出框：卡片右边（宽）收拢到产出框左边（窄）；输出越快通道越宽（最快时和卡片一样高），样式见 08-outbeam.js
// Codex 这类只在一轮结束时报用量的席位，运行中速度算不出来；最近 20 秒（记录时间）有动作就按最窄的通道算
function recentlyBusy(lane, t) {
  for (let i = lane.events.length - 1; i >= 0; i--) { const e = lane.events[i]; if (e.ts <= t) return t - e.ts < 20000 && laneStatus(lane, t).running; }
  return false;
}
function drawRibbon(lane, p, t, rate, pulses, live) {
  const I = smooth(`rI|${lane.id}`, Math.max(glow(rate), recentlyBusy(lane, t) ? 0.22 : 0));
  // 框还没出现时通道收进那团汇聚的光（08-outlife.js）
  const tg = smoothTarget(lane.id, outTarget(p.outbox, outLife(lane, t)), p.outbox), c = p.card, x0 = c.x + c.w + 1, x1 = tg.x, mid = (x0 + x1) / 2, wf = 0.08 + 0.92 * Math.pow(I, 1.4);
  const cy = c.y + c.h / 2, hc = (c.h / 2 - 3) * wf, oy = tg.y, ho = tg.box ? tg.half * (0.35 + 0.65 * wf) : tg.half;
  const E0 = [[x0, cy - hc], [mid, cy - hc], [mid, oy - ho], [x1, oy - ho]];
  const E1 = [[x0, cy + hc], [mid, cy + hc], [mid, oy + ho], [x1, oy + ho]];
  const ages = pulses.filter((q) => q.lane === lane.id && q.out).map((q) => q.age);
  drawOutBeam(E0, E1, tintOf(lane.id), I, live, hash(`cone|${lane.id}`), ages);
}

// Claude Code → 产出列最上面的框：从卡片顶边（宽）弯上去，收拢到框的左边（窄）
// 和席位通道一样，输出越快越宽：卡片顶边上占的宽度、产出框一端的高度都按速度缩放
function drawCCOut(cc, box, pulses, rate, live, t) {
  const c = cc.card, tg = smoothTarget('cc', outTarget(box, ccLife(t)), box), I = smooth('rI|cc', glow(rate)), wf = 0.08 + 0.92 * Math.pow(I, 1.4);
  const half = tg.box ? tg.half * (0.35 + 0.65 * wf) : tg.half;
  const edge = (f) => {
    const s = 0.5 + (f - 0.5) * wf, xa = c.x + 6 + (c.w - 12) * s, yb = tg.y + (f - 0.5) * 2 * half, lift = Math.max(60, c.y - box.y) * (0.75 + 0.25 * (1 - s));
    return [[xa, c.y], [xa, c.y - lift], [tg.x - 260 + 40 * s, yb], [tg.x, yb]];
  };
  const ages = pulses.filter((q) => q.lane === 'cc' && q.out).map((q) => q.age);
  drawOutBeam(edge(0), edge(1), tintOf('cc'), I, live, hash('cone|cc'), ages);
}

// Claude Code ↔ 席位：穿过核心网的交互光线，只按真实事件亮：派活时光点从 Claude Code 出发，结果回来或被读取时从席位回来；
// 平时只是一道静止的暗线（席位还在运行时稍亮一点）
function drawLink(c, lane, cc, p, t, pulses) {
  const curve = [cc.link, [c.cx + c.R * 0.15, cc.link[1] + (p.link[1] - cc.link[1]) * 0.2], [c.cx + c.R * 0.5, p.link[1]], p.link];
  const color = tintOf(lane.id), mine = pulses.filter((x) => x.lane === lane.id && x.dir);
  const boost = Math.max(0, ...mine.map((x) => 1 - x.age / FX_PULSE)), base = 0.07 + 0.15 * smooth(`run|${lane.id}`, laneStatus(lane, t).running ? 1 : 0), k = p.visible === false ? 0.5 : 1;
  ctx.save();
  strokeCubic(curve);
  ctx.strokeStyle = color((0.05 + 0.3 * boost) * k); ctx.lineWidth = (2 + 4 * boost) * FX.lw; ctx.stroke();
  const back = mine.some((x) => x.dir < 0 && x.age < 1.6);
  if (LOOK.dots) {
    // 平时一条静止的细线；派活、收结果时沿线流过一串圆形光点
    ctx.strokeStyle = HI(base * 0.6 * k); ctx.lineWidth = 0.6 * FX.lw; ctx.stroke();
    if (boost > 0) {
      ctx.lineCap = 'round'; ctx.setLineDash([0.01, 12 * FX.lw]);
      ctx.lineDashOffset = ((back ? 1 : -1) * performance.now() / 45) * FX.lw;
      ctx.strokeStyle = HI(0.75 * boost * k); ctx.lineWidth = 1.9 * FX.lw; ctx.stroke();
      ctx.lineCap = 'butt';
    }
  } else {
    ctx.setLineDash([5 * FX.lw, 7 * FX.lw]);
    ctx.lineDashOffset = boost > 0 ? ((back ? 1 : -1) * performance.now() / 45) * FX.lw : 0;
    ctx.strokeStyle = HI((base + 0.6 * boost) * k); ctx.lineWidth = 0.8 * FX.lw; ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const x of mine) for (let j = 0; j < 3; j++) {
    const u = (x.age - j * 0.12) / 1.8;
    if (u < 0 || u > 1) continue;
    const [px, py] = cubicAt(curve, x.dir > 0 ? ease(u) : 1 - ease(u));
    glowDot(px, py, j ? 1.7 : 2.4, x.dir > 0 ? tintOf('cc') : color, Math.min(1, (1 - u) * 4));
  }
  ctx.restore();
}
