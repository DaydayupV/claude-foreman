'use strict';
// 模块状态的画布动效（卡片上的边框和颜色在 06-states.js / board.css）：
//  排队等服务：三颗琥珀光点绕着卡片边框转；
//  失败（失败、额度用完、卡死、中断）：结束那一刻从卡片中心炸开一圈红色冲击波，带几颗火星；
//  被取消：灰色星尘从卡片上往上飘散。

const ST_AMBER = (a) => `rgba(255,186,90,${a})`, ST_RED = (a) => `rgba(255,92,80,${a})`, ST_GREY = (a) => `rgba(170,170,182,${a})`;
const FAIL_SEC = 1.8, CANCEL_SEC = 2.6, GAP_SEC = 1.6;

// 卡片边框上的一点：u 从 0 到 1 绕一圈
function perimeter(b, u) {
  const p = 2 * (b.w + b.h), d = (((u % 1) + 1) % 1) * p;
  if (d < b.w) return [b.x + d, b.y];
  if (d < b.w + b.h) return [b.x + b.w, b.y + d - b.w];
  if (d < 2 * b.w + b.h) return [b.x + b.w - (d - b.w - b.h), b.y + b.h];
  return [b.x, b.y + b.h - (d - 2 * b.w - b.h)];
}

function drawGapLaunch(L, lane, r, row, t) {
  const age = secSince(r.started_at, t);
  if (age < 0 || age >= GAP_SEC) return;
  const p = plansAt(t).find((x) => x.id === r.plan);
  if (!p) return;
  // 席位都在刻度带同一列里，卡片又在画布上层：从各席卡片右侧出发，往右绕出一段弧，再从右侧汇进补漏席
  const to = [row.card.x + row.card.w, row.card.y + row.card.h / 2], color = tintOf(lane.id);
  for (const s of p.seats) {
    if (s.seat === r.seat) continue;
    const from = L.rows.get(seatLaneId(p.id, s.seat));
    if (!from) continue;
    const a = [from.card.x + from.card.w, from.card.y + from.card.h / 2], reach = 70 + Math.abs(a[1] - to[1]) * 0.25;
    for (let k = 0; k < 7; k++) {
      const u = clamp01(age / GAP_SEC * 1.3 - k * 0.035), e = ease(u);
      if (u <= 0 || u >= 1) continue;
      const x = a[0] + (to[0] - a[0]) * e + Math.sin(e * Math.PI) * reach, y = a[1] + (to[1] - a[1]) * e;
      glowDot(x, y, 3.2 - k * 0.35, color, 1 - k * 0.13);
    }
  }
  if (age > GAP_SEC * 0.75) ring(to[0] - row.card.w / 2, to[1], (age - GAP_SEC * 0.75) / (GAP_SEC * 0.25), color, 8, 70);
}

function drawStates(L, t) {
  const sec = performance.now() / 1000;
  for (const g of L.groups) for (const lane of g.lanes) {
    if (lane.ghost) continue;
    const row = L.rows.get(lane.id);
    if (!row || row.vis < 0.02) continue;
    const live = lane.runs.filter((x) => x.started_at <= t && x.kind !== 'answer'), r = live[live.length - 1], fate = fateAt(lane, r, t);
    if (r && GAP_ROLE.test(r.role || '') && fate !== 'queued') drawGapLaunch(L, lane, r, row, t);
    if (!fate || fate === 'running' || fate === 'done') continue;
    const b = row.card, cx = b.x + b.w / 2, cy = b.y + b.h / 2, rand = rng(lane.seed);
    ctx.globalAlpha = row.vis * (1 - (row.leave || 0));
    if (fate === 'queued') {
      for (let i = 0; i < 3; i++) {
        const [x, y] = perimeter(b, sec * 0.12 + i / 3);
        glowDot(x, y, 2.4, ST_AMBER, 0.95);
      }
    } else if (fate === 'failed') {
      const age = secSince(r.ended_at, t);
      if (age >= 0 && age < FAIL_SEC) {
        const u = age / FAIL_SEC, e = ease(Math.min(1, u * 1.4));
        ctx.lineWidth = (2.4 - 2 * u) * FX.lw; ctx.strokeStyle = ST_RED(0.85 * (1 - u));
        ctx.beginPath(); ctx.ellipse(cx, cy, b.w * (0.3 + 0.9 * e), b.h * (0.3 + 0.9 * e), 0, 0, 6.283); ctx.stroke();
        for (let i = 0; i < 12; i++) {
          const a = rand() * 6.283, d = (20 + rand() * 70) * e;
          glowDot(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, 1 + rand(), ST_RED, 1 - u);
        }
      }
    } else if (fate === 'cancelled') {
      const age = secSince(r.ended_at, t);
      if (age >= 0 && age < CANCEL_SEC) {
        const u = age / CANCEL_SEC;
        for (let i = 0; i < 22; i++) {
          const x0 = b.x + rand() * b.w, y0 = b.y + rand() * b.h, rise = (18 + rand() * 40) * ease(u), sway = Math.sin(sec * (0.8 + rand()) + i) * 6 * u;
          glowDot(x0 + sway, y0 - rise, 0.8 + rand() * 0.8, ST_GREY, (1 - u) * (0.4 + 0.6 * rand()));
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}
