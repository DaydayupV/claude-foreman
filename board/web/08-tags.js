'use strict';
// 光束区里的状态标签：每个席位的粒子流中间一个小 HUD 标签，写着它此刻在做什么和速度。
// 字号按屏幕固定（像地图上的地名）；有新动作时亮一下，运行中保持半亮，结束后几秒内淡出。

const TAG_KINDS = new Set(['read', 'search', 'web', 'edit', 'cmd', 'msg', 'think', 'answer', 'report', 'queued', 'error', 'end', 'plan', 'image']);
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function tagText(ev) {
  const t = ev.t || '';
  switch (ev.k) {
    case 'read': return `▸ reading ${baseName(t)}`;
    case 'search': return `⌕ ${t}`;
    case 'web': return `⌁ ${t.replace(/^https?:\/\//, '')}`;
    case 'edit': return `✎ editing ${baseName(editParts(t).path)}`;
    case 'cmd': return `$ ${t}`;
    case 'msg': return `◆ ${t}`;
    case 'think': return '✻ thinking';
    case 'answer': return `✎ writing answer · ${ev.n || 0} chars`;
    case 'report': return '◆ report submitted';
    case 'queued': return '… queued at provider';
    case 'error': return `✗ ${t}`;
    case 'end': return `● finished · ${t}`;
    case 'plan': return `plan ${t}`;
    case 'image': return `▣ ${baseName(t)}`;
    default: return '';
  }
}

function drawTags(L, t, rates) {
  for (const [id, row] of L.rows) {
    const lane = B.laneById.get(id);
    if (!lane || !latest(lane)) continue;
    // 只看这一轮任务的事件（续接回来时不再显示上一轮的"finished"）
    let ev = null;
    const cur = runAt(lane, t);
    for (let i = lane.events.length - 1; i >= 0; i--) { const e = lane.events[i]; if (e.ts <= t && TAG_KINDS.has(e.k) && (!cur || e.run === cur.id)) { ev = e; break; } }
    if (!ev) continue;
    const active = laneActive(lane, t), age = ageOf(ev, t);
    const alpha = (active ? 0.55 + 0.45 * Math.max(0, 1 - age / 2.5) : Math.max(0, 1 - age / 4)) * row.vis * (L.arrive?.get(id)?.card ?? 1) * (1 - (row.leave || 0));
    if (alpha <= 0.01) continue;
    const rate = rates.get(id) || 0;
    const text = clipText(tagText(ev), 40) + (active && rate >= 1 ? `  ·  ≈ ${Math.round(rate)} tok/s` : '');
    const color = tintOf(id), s = 1 / VIEW.k;
    const x = (row.card.x + row.card.w + row.out.x) / 2, y = row.card.y + row.card.h / 2;
    ctx.save();
    ctx.translate(x, y); ctx.scale(s, s); ctx.globalAlpha = alpha;
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    const w = ctx.measureText(text).width + 22, h = 18, x0 = -w / 2, y0 = -h / 2, cs = 5;
    ctx.fillStyle = 'rgba(7,7,9,.8)'; ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = 'rgba(170,170,182,.18)'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 1, h - 1);
    // 四角括号（模型颜色）
    ctx.strokeStyle = color(0.85); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x0 + w, y0, -1, 1], [x0, y0 + h, 1, -1], [x0 + w, y0 + h, -1, -1]]) {
      ctx.moveTo(cx + dx * cs, cy + 0.5 * dy); ctx.lineTo(cx + 0.5 * dx, cy + 0.5 * dy); ctx.lineTo(cx + 0.5 * dx, cy + dy * cs);
    }
    ctx.stroke();
    ctx.fillStyle = color(1); ctx.beginPath(); ctx.arc(x0 + 9, 0, 2.2, 0, 6.283); ctx.fill();
    ctx.fillStyle = HI(0.95); ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, x0 + 16, 0.5);
    ctx.restore();
  }
}
