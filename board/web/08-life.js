'use strict';
// 派发流程动效（世界坐标，画在光束上面）。都按记录里的时刻算"过去了几秒"，回放、停在某一刻都一样：
//  ① 建计划：Claude Code 产出框亮一圈，按席位顺序射出光点，把席位卡"拉"出来（卡片在光点到达时才淡入）
//  ② 准入闸：计划建好到 Claude Code 席交报告之间，刻度带入口有一道闸；报告封成六边形印记飞进产出框，闸随之打开
//  ③ 交叉挑错：上一轮各家的方案从产出框收回核心，褪成白色（匿名），再按各席续接的时刻分发出去
//  ④ 裁决：产出框里的观点变成光点，接受的汇进 Claude Code 产出框，部分接受的半亮，拒绝的落下散掉；一轮记完，产出框扫过一道光

const LIFE = { lead: 0.35, stagger: 0.18, comet: 0.9, seal: 0.9 };
const arriveAt = (i) => LIFE.lead + i * LIFE.stagger + LIFE.comet; // 第 i 席的光点到卡片时，离建计划过去几秒
const seatTint = (s) => (a) => rgba(avatarFor(s.model, null), a);
const rowOf = (L, plan, seat) => L.rows.get(seatLaneId(plan, seat));

// 字号按屏幕固定的小标签（深底）
function hudText(text, x, y, color, a, size = 10.5, align = 'center') {
  if (a <= 0.01) return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(1 / VIEW.k, 1 / VIEW.k); ctx.globalAlpha = Math.min(1, a);
  ctx.font = `${size}px ui-monospace, Consolas, monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = align;
  const w = ctx.measureText(text).width, left = align === 'right' ? -w : align === 'left' ? 0 : -w / 2;
  ctx.fillStyle = 'rgba(7,7,9,.8)'; ctx.fillRect(left - 6, -size * 0.85, w + 12, size * 1.7);
  ctx.fillStyle = color; ctx.fillText(text, 0, 0.5);
  ctx.restore();
}

// 一颗带尾巴的光点沿曲线走：u 是头的位置（0–1），尾巴往回拖
function comet(q, u, color, size = 2.4, tail = 9) {
  for (let k = tail; k >= 0; k--) {
    const uu = u - k * 0.028;
    if (uu < 0 || uu > 1) continue;
    const [x, y] = cubicAt(q, ease(uu));
    glowDot(x, y, size * (1 - k / (tail + 2)), color, (1 - k / (tail + 1)) * (k ? 0.55 : 1));
  }
}

function ring(x, y, u, color, r0 = 6, r1 = 34) {
  if (u < 0 || u > 1) return;
  ctx.strokeStyle = color(0.8 * (1 - u)); ctx.lineWidth = (1.6 - u) * FX.lw;
  ctx.beginPath(); ctx.arc(x, y, r0 + (r1 - r0) * ease(u), 0, 6.283); ctx.stroke();
}

// 刚建好计划时卡片和产出框的淡入（光点到达时才出现）：车道 id → { card, out } 两个 0–1 的系数
function arrivals(t) {
  const out = new Map();
  for (const p of plansAt(t)) {
    const age = secSince(p.ev.ts, t);
    if (age > arriveAt(p.seats.length) + 1) continue;
    p.seats.forEach((s, i) => out.set(seatLaneId(p.id, s.seat), { card: clamp01((age - arriveAt(i)) / 0.35), out: clamp01((age - arriveAt(i) - 0.3) / 0.35) }));
  }
  // 不是按计划第 1 轮拉出来的：没有计划的任务由 Claude Code 产出框射出的光点拉出来（drawDispatchBirth），
  // 讨论续接（离开后下一轮回来的）在交叉挑错的光点送到时淡入
  for (const e of dispatchEntries(t)) {
    if (out.has(e.lane.id)) continue;
    const lag = e.plan ? -0.15 : LIFE.comet;
    out.set(e.lane.id, { card: clamp01((e.age - lag) / 0.35), out: clamp01((e.age - lag - 0.3) / 0.35) });
  }
  return out;
}

// 最近两秒内进场、又不是按计划第 1 轮拉出来的席位
function dispatchEntries(t) {
  const list = [];
  for (const lane of B.lanes) {
    if (lane.id === 'cc') continue;
    const at = enteredAt(lane, t), r = runAt(lane, t);
    if (at == null || r.plan && (r.round || 1) === 1) continue;
    const age = secSince(at, t);
    if (age >= 0 && age < LIFE.comet + 1.2) list.push({ lane, age, plan: !!r.plan });
  }
  return list;
}

// 没有计划的任务：Claude Code 的产出框收成光点，射出一颗光点把这一席的卡片拉出来
function drawDispatchBirth(L, t) {
  const box = L.ccOut, sx = box.x + box.w / 2, sy = box.y + box.h / 2;
  for (const e of dispatchEntries(t)) {
    const row = L.rows.get(e.lane.id);
    if (e.plan || !row) continue;
    const c = row.card, ex = c.x + c.w, ey = c.y + c.h / 2, color = tintOf(e.lane.id);
    const q = [[sx, sy], [sx - 150, sy + 30], [ex + 220, ey], [ex, ey]], u = (e.age - LIFE.lead * 0.5) / LIFE.comet;
    if (u > 0 && u <= 1) { strokeCubic(q); ctx.strokeStyle = color(0.16 * (1 - u)); ctx.lineWidth = 1.2 * FX.lw; ctx.stroke(); comet(q, u, color); }
    ring(ex, ey, (u - 1) / 0.45, color);
  }
}

// 离开的组（结果都被 Claude Code 读走了）：卡片溶解成一团模型颜色的光点，先散开一点，再沿弧线飞进 Claude Code 卡片，
// 到的时候 Claude Code 卡片的入口亮一下
function drawLeave(L) {
  const cc = L.cc, port = [cc.x + cc.w, cc.y + cc.h * 0.5];
  let arrive = 0;
  for (const g of L.groups) {
    if (!g.leave || g.collapsed) continue;
    const k = clamp01(g.leave);
    for (const lane of g.lanes) {
      const row = L.rows.get(lane.id);
      if (!row || lane.ghost) continue;
      const c = row.card, color = tintOf(lane.id), rand = rng(hash(`leave|${lane.id}`));
      if (k < 0.25) { ctx.strokeStyle = color(0.8 * (1 - k / 0.25)); ctx.lineWidth = 1.5 * FX.lw; ctx.strokeRect(c.x, c.y, c.w, c.h); }
      for (let i = 0; i < 34; i++) {
        const x0 = c.x + rand() * c.w, y0 = c.y + rand() * c.h, delay = rand() * 0.3, s = 1.1 + rand() * 1.8, lift = 30 + rand() * 70;
        const sx = x0 + (rand() - 0.5) * 40, sy = y0 + (rand() - 0.5) * 30, flash = rand();
        const u = clamp01((k - delay) / (1 - delay)), e = ease(u);
        // 前 20% 原地散开，之后沿二次曲线飞向 Claude Code 卡片的入口（控制点在两头中间偏上，划出一道弧）
        const spread = clamp01(u / 0.2), fly = ease(clamp01((u - 0.2) / 0.8));
        const ax = x0 + (sx - x0) * spread, ay = y0 + (sy - y0) * spread, mx = (ax + port[0]) / 2, my = Math.min(ay, port[1]) - lift;
        const x = (1 - fly) ** 2 * ax + 2 * (1 - fly) * fly * mx + fly ** 2 * port[0], y = (1 - fly) ** 2 * ay + 2 * (1 - fly) * fly * my + fly ** 2 * port[1];
        const a = (0.5 + 0.5 * flash) * row.vis * (u < 1 ? 1 - 0.6 * e ** 4 : 0);
        if (a <= 0) continue;
        if (i % 5 === 0) glowDot(x, y, s * (1 - 0.4 * fly), color, a);
        else { ctx.fillStyle = i % 4 ? color(a) : HI(a); ctx.beginPath(); ctx.arc(x, y, s * (1 - 0.4 * fly) * FX.lw, 0, 6.283); ctx.fill(); }
      }
    }
    arrive = Math.max(arrive, k);
  }
  if (arrive > 0.6) ring(port[0], port[1], (arrive - 0.6) / 0.4, tintOf('cc'), 6, 40);
}

// ① 建计划
function drawPlanBirth(p, L, t) {
  // Claude Code 的产出框这时正缩成一颗大光点（08-outlife.js），光点从它中心射出去
  const age = secSince(p.ev.ts, t), box = L.ccOut;
  if (age < 0 || age > arriveAt(p.seats.length) + 0.8) return;
  hudText(TEXT.plan(p.module, p.ev.cell || '', p.seats.length), box.x + box.w / 2, box.y - 14, HI(0.95), clamp01(age / 0.2) * clamp01((arriveAt(p.seats.length) + 0.8 - age) / 0.6));
  p.seats.forEach((s, i) => {
    const row = rowOf(L, p.id, s.seat);
    if (!row) return;
    const c = row.card, ex = c.x + c.w, ey = c.y + c.h / 2, sx = box.x + box.w / 2, sy = box.y + box.h / 2;
    const q = [[sx, sy], [sx - 150, sy + 30], [ex + 220, ey], [ex, ey]], u = (age - LIFE.lead - i * LIFE.stagger) / LIFE.comet, color = seatTint(s);
    if (u > 0 && u <= 1) {
      strokeCubic(q); ctx.strokeStyle = color(0.16 * (1 - u)); ctx.lineWidth = 1.2 * FX.lw; ctx.stroke();
      comet(q, u, color);
    }
    ring(ex, ey, (u - 1) / 0.45, color);
  });
}

// ② 准入闸和 Claude Code 席的报告印记
function hexPath(x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](x + r * Math.cos(a), y + r * Math.sin(a)); }
  ctx.closePath();
}

function drawGate(p, L, t) {
  if (!p.ev.host) return;
  const h1 = p.hosts.find((h) => (h.round || 1) === 1), open = h1 ? secSince(h1.started_at, t) - LIFE.seal : -1;
  if (open > 1.2) return;
  const rows = p.seats.map((s) => rowOf(L, p.id, s.seat)).filter(Boolean);
  if (!rows.length) return;
  const last = rows[rows.length - 1].card, y0 = rows[0].card.y - 4, y1 = last.y + last.h + 4, x = L.band.x - 58, mid = (y0 + y1) / 2; // 刻度数字左边
  const fall = clamp01(secSince(p.ev.ts, t) / 0.6), u = open < 0 ? 0 : ease(clamp01(open / 1.2)), a = (open < 0 ? 0.55 + 0.2 * Math.sin(performance.now() / 300) : 1 - u) * fall;
  const half = (mid - y0) * fall, shift = u * (mid - y0);
  ctx.save();
  for (const [from, dir] of [[mid, -1], [mid, 1]]) {
    const top = from + dir * shift, bot = top + dir * half;
    // 两道竖栏（先画一遍宽而淡的当光晕）和横档
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bot); ctx.moveTo(x - 5, top); ctx.lineTo(x - 5, bot);
    ctx.strokeStyle = HI(a * 0.12); ctx.lineWidth = 6 * FX.lw; ctx.stroke();
    ctx.strokeStyle = HI(a * 0.85); ctx.lineWidth = 1.8 * FX.lw; ctx.stroke();
    ctx.strokeStyle = HI(a * 0.5); ctx.lineWidth = 1.2 * FX.lw; ctx.beginPath();
    for (let y = top; dir < 0 ? y > bot : y < bot; y += dir * 8) { ctx.moveTo(x - 9, y); ctx.lineTo(x + 4, y); }
    ctx.stroke();
  }
  if (open < 0) {
    ctx.fillStyle = 'rgba(7,7,9,.9)'; ctx.fillRect(x - 9, mid - 6, 14, 12);
    ctx.strokeStyle = HI(a); ctx.lineWidth = FX.lw; ctx.strokeRect(x - 7, mid - 2, 10, 8);
    ctx.beginPath(); ctx.arc(x - 2, mid - 2, 3, Math.PI, 0); ctx.stroke();
  }
  ctx.restore();
  hudText(open < 0 ? TEXT.gateWaiting : TEXT.gateOpen, x - 16, mid, HI(0.9), (open < 0 ? 1 : 1 - u) * fall, 10.5, 'right');
}

function drawSeal(h, L, t) {
  const age = secSince(h.started_at, t);
  if (age < 0 || age > LIFE.seal + 0.7) return;
  const cc = L.cc, box = L.ccOut, from = [cc.x + cc.w + 14, cc.y + cc.h * 0.3], to = [box.x + 14, box.y + box.h / 2], color = tintOf('cc');
  const q = [from, [from[0] + 180, from[1] - 220], [to[0] - 420, to[1] + 40], to];
  const grow = clamp01(age / 0.25), u = clamp01((age - 0.25) / (LIFE.seal - 0.25)), [x, y] = age < 0.25 ? from : cubicAt(q, ease(u));
  if (age <= LIFE.seal) {
    if (u > 0) { strokeCubic(q); ctx.strokeStyle = color(0.18 * (1 - u)); ctx.lineWidth = FX.lw; ctx.stroke(); }
    const r = 9 * ease(grow) * FX.lw;
    ctx.fillStyle = color(0.25); hexPath(x, y, r * 1.8); ctx.fill();
    ctx.fillStyle = 'rgba(10,10,12,.9)'; hexPath(x, y, r); ctx.fill();
    ctx.strokeStyle = color(1); ctx.lineWidth = 1.4 * FX.lw; hexPath(x, y, r); ctx.stroke();
    ctx.strokeStyle = HI(0.85); ctx.lineWidth = 0.7 * FX.lw;
    for (const k of [0.3, 0.55]) { ctx.beginPath(); ctx.arc(x, y + r * 0.15, r * k, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
    hudText(TEXT.hostSealed(h.round || 1), x, y - 22 * FX.lw, color(1), grow * (1 - u * 0.6));
  }
  ring(to[0], to[1], (age - LIFE.seal) / 0.6, color, 4, 26);
}

// ③ 交叉挑错：第 R 轮从 Claude Code 席交报告的时刻起算（没有就从最早续接的前一点起算）
function drawShuffle(p, L, t) {
  const c = L.core, speed = B.clock.mode === 'replay' ? B.clock.speed : 1;
  for (let R = 2; R <= p.round; R++) {
    const host = p.hosts.find((h) => (h.round || 1) === R), resumes = p.runs.filter((r) => (r.round || 1) === R);
    if (!resumes.length && !host) continue;
    const anchor = host ? host.started_at : Math.min(...resumes.map((r) => r.started_at)) - 2.4 * 1000 * speed, a = secSince(anchor, t);
    const arrive = resumes.map((r) => Math.max(2.4, (r.started_at - anchor) / 1000 / speed));
    if (a < 0 || a > Math.max(2.6, ...arrive) + 0.6) continue;
    // 来源：上一轮各席的方案已经被 Claude Code 读走了，所以都从 Claude Code 卡片出来（它自己的也匿名混进去）
    const src = p.seats.map(seatTint);
    if (p.ev.host) src.push(tintOf('cc'));
    const n = src.length, cc = L.cc, port = [cc.x + cc.w, cc.y + cc.h * 0.72];
    src.forEach((col, j) => {
      const q = [port, [port[0] + 120, port[1] + (j - n / 2) * 14], [c.cx - c.R * 0.35, c.cy + 40], [c.cx, c.cy]];
      const u = (a - j * 0.06) / 1.0;
      if (u > 0 && u < 1) comet(q, u, col, 2.2, 6);
      if (a >= 1 && a < 2.4) {
        const m = clamp01((a - 1) / 0.8), ang = (j / n) * 6.283 + (a - 1) * 3.2, rad = (16 + 10 * Math.sin(a * 2 + j)) * FX.lw;
        const x = c.cx + Math.cos(ang) * rad, y = c.cy + Math.sin(ang) * rad;
        glowDot(x, y, 2.2, col, 1 - m); glowDot(x, y, 2.2, HI, m);
      }
    });
    hudText(TEXT.crossCheck(R, String.fromCharCode(64 + n)), c.cx, c.cy - 44 * FX.lw, HI(0.95), clamp01((a - 0.9) / 0.3) * clamp01((Math.max(...arrive, 2.4) + 0.4 - a) / 0.5));
    resumes.forEach((r, i) => {
      const row = L.rows.get(r.lane || r.id);
      if (!row) return;
      const port = [row.card.x, row.card.y + row.card.h * 0.72], dep = arrive[i] - 0.8, u = (a - dep) / 0.8;
      const q = [[c.cx, c.cy], [c.cx + c.R * 0.45, c.cy], [port[0] - 160, port[1]], port];
      for (let k = 0; k < n - 1; k++) { const uu = u - k * 0.07; if (uu > 0 && uu < 1) { const [x, y] = cubicAt(q, ease(uu)); glowDot(x, y, k ? 1.6 : 2.3, HI, 1); } }
      ring(port[0], port[1], (u - 1) / 0.5, HI, 4, 22);
    });
  }
}

// ④ 裁决和决策记录：各席的方案已经在 Claude Code 手里，观点从 Claude Code 卡片顶上出发——
// 接受的带着那一席的颜色升进 Claude Code 的产出框（决策记录），部分接受的半亮，拒绝的走到半路落下散掉
function drawJudge(p, L, t) {
  const box = L.ccOut, cc = L.cc;
  let flash = 0;
  for (const v of p.verdicts) {
    const age = secSince(v.ts, t);
    if (age < 0 || age > 2.8) continue;
    const color = tintOf(v.lane), items = [...v.a.map(() => 'a'), ...v.p.map(() => 'p'), ...v.r.map(() => 'r')];
    items.forEach((kind, j) => {
      const u = (age - 0.1 - j * 0.09) / 1.1;
      if (u < 0 || u > 1) return;
      const sx = cc.x + 20 + (j * 19) % (cc.w - 40), tx = box.x + 14 + (j * 23) % (box.w - 28), ty = box.y + box.h / 2;
      const q = [[sx, cc.y], [sx, cc.y - Math.max(80, cc.y - box.y) * 0.8], [tx - 260, ty], [tx, ty]];
      if (kind === 'r') {
        if (u < 0.35) { comet(q, u, (a) => `rgba(150,150,160,${a})`, 1.6, 3); return; }
        const [x0, y0] = cubicAt(q, ease(0.35)), w = (u - 0.35) / 0.65;
        ctx.fillStyle = `rgba(150,150,160,${(0.8 * (1 - w)).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x0 + (j % 2 ? 1 : -1) * w * 16, y0 + ease(w) * 80, 1.8 * FX.lw * (1 - w * 0.5), 0, 6.283); ctx.fill();
        return;
      }
      comet(q, u, color, kind === 'a' ? 2.3 : 1.5, kind === 'a' ? 6 : 3);
      if (u > 0.92) flash = Math.max(flash, 1);
    });
  }
  if (flash) { ctx.strokeStyle = HI(0.5); ctx.lineWidth = 1.5 * FX.lw; ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4); }
  if (p.record == null) return;
  const a = secSince(p.record, t) - 1.2;
  if (a < 0 || a > 1.8) return;
  const x = box.x + box.w * ease(clamp01(a / 1.0)), fade = clamp01((1.8 - a) / 0.6);
  const g = ctx.createLinearGradient(x - 24, 0, x, 0);
  g.addColorStop(0, HI(0)); g.addColorStop(1, HI(0.35 * fade));
  ctx.fillStyle = g; ctx.fillRect(Math.max(box.x, x - 24), box.y, Math.min(24, x - box.x), box.h);
  ctx.strokeStyle = HI(0.9 * fade); ctx.lineWidth = 1.2 * FX.lw; ctx.beginPath(); ctx.moveTo(x, box.y - 3); ctx.lineTo(x, box.y + box.h + 3); ctx.stroke();
  hudText(TEXT.decisionWritten, box.x + box.w / 2, box.y - 14, HI(0.95), fade);
}

// Claude Code 卡片离场（04-life.js 的 ccAway）：前 40% 卡片缩小淡掉，中心聚起一颗光点；后 60% 光点拖着尾巴沿弧线飞进
// 弧线区中央的亮核，到的时候亮核那里散开一圈。回来时倒着放：亮核亮一圈，光点飞到卡片的位置，再长成卡片
function drawCcAway(L) {
  const k = L.ccAway || 0;
  if (k <= 0 || k >= 1) return;
  const c = L.cc, sx = c.x + c.w / 2, sy = c.y + c.h / 2, ex = L.core.cx, ey = L.core.cy, color = tintOf('cc');
  const shrink = clamp01(k / 0.4), fly = clamp01((k - 0.4) / 0.6);
  if (fly <= 0) { glowDot(sx, sy, 1.6 + 2.4 * shrink, color, shrink); return; }
  // 离开时从卡片飞向亮核，回来时从亮核飞向卡片：尾巴总在头的后面
  const out = [[sx, sy], [sx + 70, sy - 110], [ex - 140, ey - 90], [ex, ey]];
  const q = L.ccLeaving ? out : [...out].reverse(), u = L.ccLeaving ? fly : 1 - fly;
  comet(q, u, color, 4 - 1.6 * fly, 12);
  ring(ex, ey, (L.ccLeaving ? fly - 0.8 : 1 - fly) / 0.2, color, 4, 46);
}

function drawLife(L, t) {
  drawDispatchBirth(L, t);
  drawLeave(L);
  drawCcAway(L);
  for (const p of plansAt(t)) {
    drawGate(p, L, t);
    drawPlanBirth(p, L, t);
    for (const h of p.hosts) drawSeal(h, L, t);
    drawShuffle(p, L, t);
    drawJudge(p, L, t);
  }
}

// 刻度带跟着席位卡出现：没有派出任何席位时不画；第一张卡快到时从中间往上下展开（0–1）。
// 按计划拉出来的卡以光点到达的时刻为准，没有计划记录的任务以它启动的时刻为准
function bandReveal(L, t) {
  if (!L.rows.size) return 0;
  let a = 0;
  for (const g of L.groups) for (const lane of g.lanes) {
    const run = lane.ghost ? null : lane.runs[0], planId = lane.ghost ? lane.plan : run && run.plan;
    const ev = planId && B.life.find((e) => e.k === 'fplan' && e.plan === planId);
    const i = ev ? (ev.seats || []).findIndex((s) => s.seat === (lane.ghost ? lane.seat.seat : run.seat)) : -1;
    const since = ev && i >= 0 ? secSince(ev.ts, t) - arriveAt(i) + 0.45 : secSince(laneT0(lane), t);
    a = Math.max(a, clamp01(since / 0.45));
    if (a >= 1) return 1;
  }
  return a;
}
