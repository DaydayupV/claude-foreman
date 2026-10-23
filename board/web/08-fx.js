'use strict';
// 画布层，全部用世界坐标画，和卡片层同一个缩放平移：
// 核心网（token 的来源）、竖直刻度带、核心网 → 卡片的汇流线、Claude Code ↔ 席位穿过核心的交互光线、
// 席位 → 产出框的放射线带（上下和两边的框一样高）、Claude Code → 顶上产出框的弧线。

const FX = { cv: $('fx'), web: null, webR: 0, layout: null, lw: 1 };
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
  ctx.fillStyle = color(0.2 * a); ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, 6.283); ctx.fill();
  ctx.fillStyle = HI(0.9 * a); ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
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
  return keys.map((k) => (a) => rgba(k, a));
}

function drawCore(c, intensity, pal) {
  if (!FX.web || FX.webR !== c.R) buildWeb(c.R);
  const sec = performance.now() / 1000;
  ctx.save();
  ctx.beginPath(); ctx.rect(c.cx - c.R * 2, c.cy - c.R * 1.5, c.clipX - (c.cx - c.R * 2), c.R * 3); ctx.clip();
  for (const [{ paths, dots }, alpha, width, speed] of FX.web) {
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate(Math.sin(sec * speed) * 0.35 + sec * speed * 0.2);
    ctx.lineWidth = width * FX.lw;
    paths.forEach((p, j) => {
      const col = j && pal.length ? pal[(j - 1) % pal.length] : HI;
      ctx.strokeStyle = col(alpha * (j && pal.length ? 1.6 : 1) * (0.6 + 0.4 * intensity)); ctx.stroke(p);
    });
    ctx.fillStyle = HI(0.5);
    const d = 1.3 * FX.lw;
    for (const [x, y] of dots) ctx.fillRect(x, y, d, d);
    ctx.restore();
  }
  ctx.restore();
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
  P.set('cc', { tok: [c.x + c.w, c.y + c.h * 0.3], link: [c.x + c.w, c.y + c.h * 0.72], out: [c.x + c.w * 0.65, c.y], card: c });
  for (const g of L.groups) for (const lane of g.lanes) {
    const row = L.rows.get(lane.id);
    if (row) P.set(lane.id, { tok: [row.card.x, row.card.y + row.card.h * 0.3], link: [row.card.x, row.card.y + row.card.h * 0.72], card: row.card, outbox: row.out, visible: true, vis: row.vis });
    else P.set(lane.id, { tok: [L.band.x, g.head.y + 5], link: [L.band.x, g.head.y + 5], visible: false, vis: g.vis });
  }
  return P;
}

function drawFx(t, L) {
  const dpr = devicePixelRatio || 1, w = viewEl.clientWidth, h = viewEl.clientHeight;
  if (FX.cv.width !== Math.round(w * dpr) || FX.cv.height !== Math.round(h * dpr)) {
    FX.cv.width = Math.round(w * dpr); FX.cv.height = Math.round(h * dpr);
    FX.cv.style.width = `${w}px`; FX.cv.style.height = `${h}px`;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const fit = fitGoal();
  drawStars(w, h, fit);
  ctx.setTransform(dpr * VIEW.k, 0, 0, dpr * VIEW.k, dpr * VIEW.tx, dpr * VIEW.ty);
  FX.layout = L;
  FX.lw = Math.pow(fit.k / VIEW.k, 0.6);
  const P = portsOf(L);
  const lanes = [B.laneById.get('cc'), ...seatLanes(t)].filter((l) => l && latest(l) && P.has(l.id));
  const rates = new Map(lanes.map((l) => [l.id, rateAt(l, t)]));
  const total = smooth('total', glow([...rates.values()].reduce((a, b) => a + b, 0)));
  // 每个模型的活跃程度（0–1）平滑过渡，互联网光线和输出通道共用
  const live = new Map(lanes.map((l) => [l.id, smooth(`live|${l.id}`, laneActive(l, t) ? 1 : 0)]));
  // 刻度带的展开程度也平滑（最后一组离开时慢慢收起）
  const pal = webPalette(), bandA = smooth('band', bandReveal(L, t));
  // 刻度带没出现时，核心网和星系按本来的圆形完整画（不在刻度带左边切掉）；刻度带展开时一起收回去
  L.core.clipX += (1 - bandA) * L.core.R * 1.3;
  drawNebula(L, P, t, rates, pal);
  drawDust(L);
  drawCore(L.core, total, pal);
  drawGalaxy(L.core, total);
  const pulses = recentPulses(t);
  // 滚到刻度带两头的席位跟着渐隐，它的光线也一起淡掉
  // 还没被光点拉到的卡片、正在离开的组，光线也跟着淡入淡出
  L.arrive = arrivals(t);
  const fadeOf = (id) => (P.get(id).vis ?? 1) * (L.arrive.get(id)?.card ?? 1) * (1 - (L.rows.get(id)?.leave || 0));
  const each = (fn) => { for (const lane of lanes) { const v = fadeOf(lane.id); if (v < 0.02) continue; ctx.globalAlpha = v; fn(lane); } ctx.globalAlpha = 1; };
  each((lane) => drawBundle(L.core, lane, P.get(lane.id), smooth(`bI|${lane.id}`, glow(rates.get(lane.id) || 0)), live.get(lane.id)));
  drawBand(L.band, t, bandA);
  each((lane) => { if (lane.id !== 'cc' && P.get(lane.id).visible) drawRibbon(lane, P.get(lane.id), t, rates.get(lane.id) || 0, pulses, live.get(lane.id)); });
  drawCCOut(P.get('cc'), L.ccOut, pulses, rates.get('cc') || 0, live.get('cc') || 0, t);
  drawOutLife(L, P, t);
  drawStates(L, t);
  drawTags(L, t, rates);
  each((lane) => { if (lane.id !== 'cc') drawLink(L.core, lane, P.get('cc'), P.get(lane.id), t, pulses); });
  drawLife(L, t);
  const others = [];
  for (const lab of recentLabels(t).reverse()) drawLabel(lab, L.core, P, others);
  drawNotes(L.core, t);
}
