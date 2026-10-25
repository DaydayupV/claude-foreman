'use strict';
// 画布层，全部用世界坐标画，和卡片层同一个缩放平移：
// 核心网（token 的来源）、竖直刻度带、核心网 → 卡片的汇流线、Claude Code ↔ 席位穿过核心的交互光线、
// 席位 → 产出框的放射线带（上下和两边的框一样高）、Claude Code → 顶上产出框的弧线。

// cv 画弧线区（星云、尘埃、核心网、中心星系），ov 画其余的光线、刻度带和标签：切换时前者炸开、后者只淡入淡出
const FX = { cv: $('fx'), ov: { cv: $('fxo') }, web: null, webR: 0, layout: null, lw: 1, burst: null };
FX.ov.ctx = FX.ov.cv.getContext('2d');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// 宇宙层画在自己的画布上（08-uni-draw.js 里临时把 ctx 换过去），画星点、光晕的工具函数两边共用
let ctx = FX.cv.getContext('2d');
const UFX = { cv: $('ufx') };
UFX.ctx = UFX.cv.getContext('2d');
const FX_LIFE = 2.6, FX_PULSE = 2.4, FX_MAX_LABELS = 16;
const LABEL_KINDS = new Set(['read', 'edit', 'search', 'web', 'image']);
const HI = (a) => `rgba(245,245,248,${a})`; // 星光白
const tintOf = (laneId) => { const l = B.laneById.get(laneId), r = l && latest(l); const key = r ? avatarFor(r.model, r.agent_type) : 'claude'; return (a) => rgba(key, a); };
const ageOf = (ev, t) => (t - ev.ts) / 1000 / (B.clock.mode === 'replay' ? B.clock.speed : 1);
const ease = (u) => u * u * (3 - 2 * u);
const cubicAt = (c, u) => { const v = 1 - u; return [0, 1].map((i) => v * v * v * c[0][i] + 3 * v * v * u * c[1][i] + 3 * v * u * u * c[2][i] + u * u * u * c[3][i]); };
function strokeCubic(c) { ctx.beginPath(); ctx.moveTo(...c[0]); ctx.bezierCurveTo(...c[1], ...c[2], ...c[3]); }
function glowDot(x, y, r, color, a = 1) {
  r *= FX.lw;
  // 柔光进了辉光层（1/3 分辨率）会被摊薄，画得大一些、亮一些，放大合上去以后和原来的光晕差不多显眼
  const g = glowCtx(), soft = g !== ctx;
  g.fillStyle = color((soft ? 0.42 : 0.2) * a); g.beginPath(); g.arc(x, y, r * (soft ? 3.6 : 2.8), 0, 6.283); g.fill();
  ctx.fillStyle = HI(0.9 * a); ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
}

// ---- 辉光层 ----
// 看板的两层画布（弧线区、上面那层）画的时候，光点外面那圈柔光不直接画上去，先画进一张 1/3 分辨率的离屏画布；
// 整层画完后放大、用叠加（lighter）合上去：低分辨率放大自带柔边，再从它缩出一张 1/6 的叠一次，外面多一圈淡淡的光晕。
// 不用 ctx.filter 做模糊：冷着色器缓存时滤镜很慢（落地那一帧的已知问题就是速度曲线的阴影滤镜）。
// 宇宙层不经过这里，照旧直接画。?glow=0 关掉，用来对比和量帧
const GLOW = { off: Q.get('glow') === '0', on: false, a: { cv: document.createElement('canvas') }, b: { cv: document.createElement('canvas') } };
GLOW.a.ctx = GLOW.a.cv.getContext('2d'); GLOW.b.ctx = GLOW.b.cv.getContext('2d');
function glowBegin(target) {
  if (GLOW.off) return;
  const W = Math.ceil(target.canvas.width / 3), H = Math.ceil(target.canvas.height / 3);
  for (const [buf, w, h] of [[GLOW.a, W, H], [GLOW.b, Math.ceil(W / 2), Math.ceil(H / 2)]]) {
    if (buf.cv.width !== w || buf.cv.height !== h) { buf.cv.width = w; buf.cv.height = h; }
  }
  GLOW.a.ctx.setTransform(1, 0, 0, 1, 0, 0); GLOW.a.ctx.clearRect(0, 0, W, H);
  GLOW.on = true;
}
// 柔光画在哪：辉光层开着时是离屏画布（变换和透明度跟着当前画布走，缩成 1/3），否则就是当前画布
function glowCtx() {
  if (!GLOW.on) return ctx;
  const m = ctx.getTransform(), g = GLOW.a.ctx;
  g.setTransform(m.a / 3, m.b / 3, m.c / 3, m.d / 3, m.e / 3, m.f / 3);
  g.globalAlpha = ctx.globalAlpha;
  return g;
}
function glowFlush(target) {
  if (!GLOW.on) return;
  GLOW.on = false;
  const a = GLOW.a.cv, b = GLOW.b.cv;
  GLOW.b.ctx.setTransform(1, 0, 0, 1, 0, 0); GLOW.b.ctx.clearRect(0, 0, b.width, b.height);
  GLOW.b.ctx.drawImage(a, 0, 0, b.width, b.height);
  target.save();
  target.setTransform(1, 0, 0, 1, 0, 0); target.globalAlpha = 1; target.globalCompositeOperation = 'lighter';
  target.imageSmoothingEnabled = true; target.imageSmoothingQuality = 'high';
  target.drawImage(a, 0, 0, a.width * 3, a.height * 3);
  target.globalAlpha = 0.7; target.drawImage(b, 0, 0, b.width * 6, b.height * 6);
  target.restore();
}

// 核心网：三层长弧线和散点，建一次 Path2D，每帧旋转。每层的弧线分进六个桶：一半留白，另一半按当前各模型的颜色上色，像一团星云
const WEB_BUCKETS = 6;
function buildWeb(R) {
  const rand = rng(20261022);
  const layer = (count, rMin, rMax, specks) => {
    const paths = Array.from({ length: WEB_BUCKETS }, () => new Path2D()), dots = [];
    for (let i = 0; i < count; i++) {
      const p = paths[rand() < 0.5 ? 0 : 1 + Math.floor(rand() * (WEB_BUCKETS - 1))];
      const a1 = rand() * Math.PI * 2, a2 = a1 + 1.1 + rand() * 2.3, r = R * (rMin + rand() * (rMax - rMin));
      const x1 = r * Math.cos(a1), y1 = r * Math.sin(a1), x2 = r * Math.cos(a2), y2 = r * Math.sin(a2), bend = (rand() - 0.5) * 0.9;
      p.moveTo(x1, y1);
      p.quadraticCurveTo((x1 + x2) / 2 - (y2 - y1) * bend, (y1 + y2) / 2 + (x2 - x1) * bend, x2, y2);
    }
    for (let i = 0; i < specks; i++) { const a = rand() * 6.283, r = R * Math.sqrt(rand()); dots.push([r * Math.cos(a), r * Math.sin(a)]); }
    return { paths, dots };
  };
  FX.web = [[layer(170, 0.55, 1, 90), 0.15, 0.55, 0.008], [layer(120, 0.4, 0.9, 60), 0.27, 0.5, -0.013], [layer(46, 0.25, 0.7, 30), 0.4, 0.7, 0.02]];
  FX.webR = R;
}

// 当前出场的模型（Claude Code 和各席）的颜色，核心网和星云按它上色
function webPalette() {
  const keys = [...new Set(B.lanes.filter((l) => l.runs.length).map((l) => { const r = latest(l); return avatarFor(r.model, r.agent_type); }))];
  return Object.assign(keys.map((k) => (a) => rgba(k, a)), { key: keys.join('|') });
}
// 星系的星点按它上色：Claude Code 加上此刻正在跑的席位，和宇宙里小星系的规则一样（08-uni-galaxy.js 的 drawGalaxyOf）。
// 在不在跑用 drawFx 这一帧已经算好的活跃程度（live），不再逐条车道重算状态
function starPalette(t, lanes, live) {
  const keys = new Set(['claude']);
  for (const lane of lanes) if (lane.id !== 'cc' && live.get(lane.id) > 0.5) { const r = currentRun(lane, t); if (r) keys.add(avatarFor(r.model, r.agent_type)); }
  return [...keys].map((k) => (a) => rgba(k, a));
}

function drawCore(c, intensity, pal) {
  if (!FX.web || FX.webR !== c.R) buildWeb(c.R);
  const sec = performance.now() / 1000;
  ctx.save();
  ctx.beginPath(); ctx.rect(c.cx - c.R * 2, c.cy - c.R * 1.5, c.clipX - (c.cx - c.R * 2), c.R * 3); ctx.clip();
  for (const [i, [{ paths, dots }, alpha, width, speed]] of FX.web.entries()) {
    ctx.save();
    ctx.translate(c.cx, c.cy);
    // 炸开时各层带着多转的角度甩出来，越往后越慢；线条先亮再回落到平常（FX.burst，见 burstOf）
    // 节拍让线条亮一下：乘在亮度上，对话正忙、输出强度已经很高时也看得出来
    const b = FX.burst, boost = (b ? 1 + 1.6 * b.boost : 1) * (1 + 1.2 * (FX.beat?.env || 0));
    ctx.rotate(Math.sin(sec * speed) * 0.35 + sec * speed * 0.2 + Math.sign(speed) * (FX.kick || 0) * Math.abs(speed) / 0.02 + (b ? Math.sign(speed) * 2.4 * b.spin : 0));
    // 最外面那层是远景：平时贴预先画好的半分辨率图（看着虚、远），炸开时照常一条条画
    if (i === 0 && !b && farLayer(c.R, FX.web[0], pal)) {
      ctx.globalAlpha = Math.min(1, ctx.globalAlpha * (0.6 + 0.4 * intensity) * FAR.dim * boost);
      ctx.drawImage(FAR.cv, -FAR.half, -FAR.half, FAR.half * 2, FAR.half * 2);
      ctx.restore();
      continue;
    }
    ctx.lineWidth = width * FX.lw;
    paths.forEach((p, j) => {
      const col = j && pal.length ? pal[(j - 1) % pal.length] : HI;
      ctx.strokeStyle = col(alpha * (j && pal.length ? 1.6 : 1) * (0.6 + 0.4 * intensity) * boost); ctx.stroke(p);
    });
    ctx.fillStyle = HI(0.5);
    const d = 1.3 * FX.lw;
    for (const [x, y] of dots) ctx.fillRect(x, y, d, d);
    ctx.restore();
  }
  ctx.restore();
}

// 远景层：核心网最外面一层（弧线最多、最淡）预先画成一张图，每帧只按当前角度贴上去。
// 按屏幕分辨率的一半画，放大贴上去自带柔边，看着在后面、有景深；比每帧描 170 条弧线省。
// 出场模型的颜色变了、或者缩放档位变了（线宽和分辨率跟着变）才重画；亮度随输出强弱的变化在贴图时乘上去
const FAR = { cv: document.createElement('canvas'), key: '', half: 0, dim: 0.85 };
FAR.ctx = FAR.cv.getContext('2d');
function farLayer(R, [{ paths, dots }, alpha, width], pal) {
  const dpr = devicePixelRatio || 1, s = Math.min(1.2, Math.max(0.15, 0.5 * VIEW.k * dpr));
  const key = `${R}|${pal.key}|${Math.round(Math.log(s) / Math.log(1.5))}|${Math.round(Math.log(FX.lw) / Math.log(1.3))}`;
  if (FAR.key === key) return true;
  const size = Math.ceil(2 * R * 1.05 * s), g = FAR.ctx;
  if (size > 4096) return false;
  FAR.cv.width = FAR.cv.height = size; FAR.half = size / 2 / s; FAR.key = key;
  g.setTransform(s, 0, 0, s, size / 2, size / 2);
  g.lineWidth = width * FX.lw;
  paths.forEach((p, j) => { g.strokeStyle = (j && pal.length ? pal[(j - 1) % pal.length] : HI)(alpha * (j && pal.length ? 1.6 : 1)); g.stroke(p); });
  g.fillStyle = HI(0.5);
  const d = 1.3 * FX.lw;
  for (const [x, y] of dots) g.fillRect(x, y, d, d);
  return true;
}

// 竖直刻度带：半透明深底、两侧各一条双线导轨、发光的刻度、来回扫的亮线；组头和卡片都在带里。
// 带子上下伸出屏幕、两头渐隐；卡片滚动时刻度跟着走，像一卷胶片
function vfade(b, rgb, a, edge = 0.16) {
  const g = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
  g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(edge, `rgba(${rgb},${a})`); g.addColorStop(1 - edge, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
  return g;
}
// a：展开程度（0–1，见 08-life.js 的 bandReveal）；没展开完时从中间往上下打开
function drawBand(b, t, a = 1) {
  if (a <= 0.01) return;
  ctx.save();
  if (a < 1) {
    const mid = b.y + b.h / 2, h = b.h * ease(a);
    ctx.globalAlpha = Math.min(1, a * 1.5);
    ctx.beginPath(); ctx.rect(b.x - 20, mid - h / 2, b.w + 40, h); ctx.clip();
  }
  // 深底：横向两边稍亮，竖向两头渐隐（先横向渐变填，再用竖向渐变的透明度叠一次）
  ctx.fillStyle = vfade(b, '9,9,11', 0.85); ctx.fillRect(b.x, b.y, b.w, b.h);
  // 双线导轨：外线亮、内线暗
  ctx.lineWidth = FX.lw;
  ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y + b.h); ctx.moveTo(b.x + b.w, b.y); ctx.lineTo(b.x + b.w, b.y + b.h);
  ctx.strokeStyle = vfade(b, '215,215,225', 0.55); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(b.x + 3.5, b.y); ctx.lineTo(b.x + 3.5, b.y + b.h); ctx.moveTo(b.x + b.w - 3.5, b.y); ctx.lineTo(b.x + b.w - 3.5, b.y + b.h);
  ctx.strokeStyle = vfade(b, '200,200,212', 0.16); ctx.lineWidth = 0.6 * FX.lw; ctx.stroke();
  // 刻度：先画一遍宽而淡的当光晕，再画细线；滚动时跟着卡片一起往上走
  const shift = REEL.overflow ? ((REEL.s % 30) + 30) % 30 : 0;
  ctx.beginPath();
  for (let y = b.y - shift, i = 0; y <= b.y + b.h; y += 6, i++) {
    if (y < b.y) continue;
    const len = i % 5 ? 3 : 8;
    ctx.moveTo(b.x, y); ctx.lineTo(b.x + len, y); ctx.moveTo(b.x + b.w - len, y); ctx.lineTo(b.x + b.w, y);
  }
  ctx.strokeStyle = vfade(b, '225,225,235', 0.1); ctx.lineWidth = 2.4 * FX.lw; ctx.stroke();
  ctx.strokeStyle = vfade(b, '215,215,225', 0.45); ctx.lineWidth = 0.6 * FX.lw; ctx.stroke();
  const p = 0.2 + 0.6 * (Math.sin(performance.now() / 2600) + 1) / 2, sy = b.y + p * b.h;
  const grad = ctx.createLinearGradient(0, sy - 30, 0, sy + 30);
  grad.addColorStop(0, HI(0)); grad.addColorStop(0.5, HI(0.05)); grad.addColorStop(1, HI(0));
  ctx.fillStyle = grad; ctx.fillRect(b.x, sy - 30, b.w, 60);
  ctx.strokeStyle = HI(0.55); ctx.lineWidth = 1.2 * FX.lw;
  ctx.beginPath(); ctx.moveTo(b.x, sy); ctx.lineTo(b.x + 16, sy); ctx.moveTo(b.x + b.w - 16, sy); ctx.lineTo(b.x + b.w, sy); ctx.stroke();
  ctx.restore();
}

// 卡片接口（世界坐标）：token 在左边（Claude Code 在右边）上部，交互在下部；折叠起来的组落在组头上
function portsOf(L) {
  const P = new Map(), c = L.cc;
  // Claude Code 卡片离场时（L.ccAway），连到它的光线跟着淡掉
  P.set('cc', { tok: [c.x + c.w, c.y + c.h * 0.3], link: [c.x + c.w, c.y + c.h * 0.72], out: [c.x + c.w * 0.65, c.y], card: c, vis: 1 - (L.ccAway || 0) });
  for (const g of L.groups) for (const lane of g.lanes) {
    const row = L.rows.get(lane.id);
    if (row) P.set(lane.id, { tok: [row.card.x, row.card.y + row.card.h * 0.3], link: [row.card.x, row.card.y + row.card.h * 0.72], card: row.card, outbox: row.out, visible: true, vis: row.vis });
    else P.set(lane.id, { tok: [L.band.x, g.head.y + 5], link: [L.band.x, g.head.y + 5], visible: false, vis: g.vis });
  }
  return P;
}

// 切换中弧线区怎么画：以星系亮核此刻的位置为中心，按炸开的进度 p 缩放（先快后慢），带着多转的角度和更亮的线条
function burstOf(T) {
  const p = reduceMotion.matches ? 1 : T.p;
  const s = 1 - Math.pow(1 - p, 4);
  return { p, s, wx: (T.cx - VIEW.tx) / VIEW.k, wy: (T.cy - VIEW.ty) / VIEW.k, spin: Math.pow(1 - s, 2), boost: Math.pow(1 - p, 2) };
}
// 炸开的一瞬：亮核处一团白光很快散开；底下一团暖色的光散得慢一些，把星系亮核的橙色交给弧线区的中心（飞出时倒过来，收拢成亮核）
function drawFlash(b, R) {
  const glow = (a, r, inner) => {
    if (a < 0.01) return;
    const g = ctx.createRadialGradient(b.wx, b.wy, 0, b.wx, b.wy, r);
    g.addColorStop(0, inner(a)); g.addColorStop(0.3, rgba('claude', 0.5 * a)); g.addColorStop(1, rgba('claude', 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.wx, b.wy, r, 0, 6.283); ctx.fill();
  };
  const on = b.p <= 0 ? 0 : Math.min(1, b.p * 20);
  glow(0.7 * on * Math.exp(-b.p * 2.4), R * 0.32 * (0.45 + 0.55 * b.s), (a) => rgba('claude', a));
  glow(0.9 * on * Math.exp(-b.p * 6), R * (0.1 + 0.5 * b.s), HI);
}
function sizeCanvas(cv, w, h, dpr) {
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = `${w}px`; cv.style.height = `${h}px`;
  }
}

function drawFx(t, L) {
  const dpr = devicePixelRatio || 1, { cw: w, ch: h } = viewBox(), T = FLYFX;
  sizeCanvas(FX.cv, w, h, dpr); sizeCanvas(FX.ov.cv, w, h, dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const fit = fitGoal();
  // 看板的星空跟着界面一起淡入（宇宙层有自己的星空）
  if (T) ctx.globalAlpha = T.rest;
  drawStars(w, h, fit);
  ctx.globalAlpha = 1;
  ctx.setTransform(dpr * VIEW.k, 0, 0, dpr * VIEW.k, dpr * VIEW.tx, dpr * VIEW.ty);
  FX.layout = L;
  FX.lw = Math.pow(fit.k / VIEW.k, 0.6);
  const P = portsOf(L);
  const lanes = [B.laneById.get('cc'), ...seatLanes(t)].filter((l) => l && latest(l) && P.has(l.id));
  const rates = new Map(lanes.map((l) => [l.id, rateAt(l, t)]));
  const total = smooth('total', glow([...rates.values()].reduce((a, b) => a + b, 0)));
  // 节拍（04-life.js 的 beatsAt）：再算上输出突然加快（08-surge.js）；转动被推一把按屏幕时间累加，减少动态效果时不推
  const beat = FX.beat = beatsAt(t), ms = performance.now(), dt = Math.min(0.1, (ms - (FX.kickAt || ms)) / 1000);
  for (const lane of lanes) { const age = surgeAge(lane.id); if (age != null && age < BEAT.window) { const e = 0.45 * Math.exp(-age * BEAT.decay); beat.env = Math.max(beat.env, e); beat.lanes.set(lane.id, Math.max(beat.lanes.get(lane.id) || 0, e)); } }
  FX.kickAt = ms;
  if (!reduceMotion.matches) FX.kick = (FX.kick || 0) + dt * 1.0 * beat.env;
  // 每个模型的活跃程度（0–1）平滑过渡，互联网光线和输出通道共用
  const live = new Map(lanes.map((l) => [l.id, smooth(`live|${l.id}`, laneActive(l, t) ? 1 : 0)]));
  // 刻度带的展开程度也平滑（最后一组离开时慢慢收起）
  const pal = webPalette(), bandA = smooth('band', bandReveal(L, t));
  // 刻度带没出现时，核心网和星系按本来的圆形完整画（不在刻度带左边切掉）；刻度带展开时一起收回去
  // 切换中跟着界面一起：界面淡出时弧线区先恢复成完整的圆再收拢，淡入时才在刻度带左边切掉（不然收拢的圆上会有一道硬边）
  L.core.clipX += (1 - (T ? bandA * T.rest : bandA)) * L.core.R * 1.3;
  // 弧线区：切换中以星系亮核为中心按炸开的进度缩放；线宽和散点不跟着缩到看不见，小的时候是一团细亮的丝
  const burst = T ? burstOf(T) : null, lw = FX.lw;
  if (!burst || burst.s > 0.002) {
    glowBegin(ctx);
    ctx.save();
    if (burst) {
      ctx.translate(burst.wx, burst.wy); ctx.scale(burst.s, burst.s); ctx.translate(-L.core.cx, -L.core.cy);
      FX.burst = burst; FX.lw = lw * Math.pow(burst.s, -0.7);
    }
    try {
      drawNebula(L, P, t, rates, pal);
      drawDust(L);
      drawCore(L.core, total, pal);
      drawGalaxy(L.core, total, starPalette(t, lanes, live));
    } finally { ctx.restore(); FX.burst = null; FX.lw = lw; glowFlush(ctx); }
  }
  if (burst) drawFlash(burst, L.core.R);
  // 其余的画在上面那层画布上，切换时整层淡入淡出（applyShare）
  const base = ctx;
  ctx = FX.ov.ctx;
  try {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * VIEW.k, 0, 0, dpr * VIEW.k, dpr * VIEW.tx, dpr * VIEW.ty);
    glowBegin(ctx);
    drawOverlay(t, L, P, lanes, rates, live, bandA, burst);
  } finally { glowFlush(ctx); ctx = base; }
}

// 上面那层：核心网到卡片的汇流线、刻度带、席位到产出框的光带、产出框、状态、标签、交互光线。
// 切换中（burst）弧线区在亮核此刻的位置、按炸开的进度缩放：连到弧线区的光线（汇流线、交互光线）和核心附近的标签
// 都以这个位置和大小为准，跟着弧线区移动、被拉长，和滚动刻度带时一样一直粘在弧线区上
function drawOverlay(t, L, P, lanes, rates, live, bandA, burst = null) {
  const core = burst ? { ...L.core, cx: burst.wx, cy: burst.wy, R: L.core.R * Math.max(0.05, burst.s) } : L.core;
  // 输出突然加快的脉冲（08-surge.js）：切换中、定格（?t=）时不放
  trackSurges(rates, !!burst || B.params.t != null);
  const pulses = [...recentPulses(t), ...surgePulses(lanes)];
  // 滚到刻度带两头的席位跟着渐隐，它的光线也一起淡掉
  // 还没被光点拉到的卡片、正在离开的组，光线也跟着淡入淡出
  L.arrive = arrivals(t);
  const fadeOf = (id) => (P.get(id).vis ?? 1) * (L.arrive.get(id)?.card ?? 1) * (1 - (L.rows.get(id)?.leave || 0)) * dimOf(id);
  const each = (fn) => { for (const lane of lanes) { const v = fadeOf(lane.id); if (v < 0.02) continue; ctx.globalAlpha = v; fn(lane); } ctx.globalAlpha = 1; };
  each((lane) => drawBundle(core, lane, P.get(lane.id), smooth(`bI|${lane.id}`, glow(rates.get(lane.id) || 0)), live.get(lane.id), surgeAge(lane.id)));
  each((lane) => { const age = surgeAge(lane.id); if (age != null && age < SURGE_CORE) drawSurgeCore(core, lane.id, age); });
  drawBand(L.band, t, bandA);
  each((lane) => { if (lane.id !== 'cc' && P.get(lane.id).visible) drawRibbon(lane, P.get(lane.id), t, rates.get(lane.id) || 0, pulses, live.get(lane.id)); });
  ctx.globalAlpha = P.get('cc').vis;
  drawCCOut(P.get('cc'), L.ccOut, pulses, rates.get('cc') || 0, live.get('cc') || 0, t);
  ctx.globalAlpha = 1;
  drawOutLife(L, P, t);
  drawStates(L, t);
  drawTags(L, t, rates);
  each((lane) => { if (lane.id !== 'cc') drawLink(core, lane, P.get('cc'), P.get(lane.id), t, pulses); });
  drawLife(L, t);
  const others = [];
  for (const lab of recentLabels(t).reverse()) drawLabel(lab, core, P, others);
  drawNotes(core, t);
}
