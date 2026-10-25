'use strict';
// 脉冲、文件名光点和说明框（世界坐标；文件名的字号按屏幕固定，像地图上的地名）。

// 直播里一件事第一次出现在页面上的时刻（毫秒），事件脉冲和文件名标签共用。事件要过一会儿才到页面（看板服务每秒推一次；
// Claude Code 的工具调用要等整条回复生成完才写进记录），按事件自己的时刻算，到的时候光束已经走了一半、文件名已经淡了，
// 所以直播时都从第一次看到起算，和节拍一样（04-life.js 的 BEAT）。连上服务时开头那一批（服务发 synced 之前，以及之后算的第一帧）
// 和晚到 SEEN.late 秒以上的返回 null（旧的，不放）。每帧第一次调用时更新连接状态，同一帧里再调用用同一个判断
const SEEN = { late: 120, map: new Map(), hello: undefined, synced: false, frame: null, old: true };
function seenAt(key, ts, t) {
  if (SEEN.frame !== t) {
    SEEN.frame = t;
    if (SEEN.hello !== B.hello) { SEEN.hello = B.hello; SEEN.map.clear(); SEEN.synced = false; }
    SEEN.old = !B.synced || !SEEN.synced;
    if (B.synced) SEEN.synced = true;
    for (const [k, v] of SEEN.map) if (v.ts <= t - SEEN.late * 1000) SEEN.map.delete(k);
  }
  if (!SEEN.map.has(key)) SEEN.map.set(key, { ts, at: SEEN.old || ts <= t - SEEN.late * 1000 ? null : t });
  return SEEN.map.get(key).at;
}

// 脉冲：Claude Code 派活（dir 1）、结果回来或被读取（dir -1）；产出（写文件、交报告、结束，out）。
// 没有 Claude Code 记录时，用任务的开始和结束代替派活和结果回来，交互光线照样有反应。
// 直播时从第一次看到起算（seenAt），回放照旧按事件的时刻。同一条车道同一类、同时出现的几件事只放一道：几道一样的光束叠在一起
// 会变成一条过亮的白条。直播里"同时"是同一帧第一次看到（Claude Code 一条回复里并行改的几个文件时刻各不相同，却一起到页面），
// 回放里是同一个时刻（Codex 一次报的几个文件改动）
function recentPulses(t) {
  const out = [], cc = B.laneById.get('cc'), live = B.clock.mode !== 'replay', once = new Set(), from = t - SEEN.late * 1000;
  const hasLinks = !!(cc && cc.events.some((e) => e.target && e.target.length));
  const add = (pulse, ts) => {
    let age = ageOf({ ts }, t);
    if (live ? ts <= from : age > FX_PULSE) return;
    const kind = `${pulse.lane}|${pulse.out ? 'out' : pulse.dir}`;
    let when = ts;
    if (live) {
      const at = seenAt(`p|${kind}|${ts}`, ts, t);
      if (at == null) return;
      when = at; age = (t - at) / 1000;
    }
    if (once.has(`${kind}|${when}`)) return;
    once.add(`${kind}|${when}`);
    if (age >= 0 && age <= FX_PULSE) out.push({ ...pulse, age });
  };
  for (const lane of B.lanes) {
    for (let i = lane.events.length - 1; i >= 0; i--) {
      const ev = lane.events[i];
      if (ev.ts > t) continue;
      if (live ? ev.ts <= from : ageOf(ev, t) > FX_PULSE) break;
      if (lane.id === 'cc' && ev.target) for (const id of ev.target) add({ lane: id, dir: ev.k === 'dispatch' ? 1 : -1 }, ev.ts);
      if (ev.k === 'edit' || ev.k === 'report' || ev.k === 'end') add({ lane: lane.id, out: true }, ev.ts);
    }
    if (!hasLinks && lane.id !== 'cc') for (const r of lane.runs) {
      if (r.started_at <= t) add({ lane: lane.id, dir: 1 }, r.started_at);
      if (r.ended_at != null && r.ended_at <= t) add({ lane: lane.id, dir: -1 }, r.ended_at);
    }
  }
  return out;
}

// 文件名标签：和脉冲一样，直播时从第一次看到起算（seenAt），晚到的改文件光束跑过去时也看得到改的是哪个文件
function recentLabels(t) {
  const list = [], live = B.clock.mode !== 'replay', from = t - SEEN.late * 1000;
  for (const lane of B.lanes) {
    for (let i = lane.events.length - 1; i >= 0; i--) {
      const ev = lane.events[i];
      if (ev.ts > t) continue;
      let age = ageOf(ev, t);
      if (live ? ev.ts <= from : age > FX_LIFE) break;
      if (!LABEL_KINDS.has(ev.k) || !ev.t) continue;
      if (live) { const at = seenAt(`l|${lane.id}|${ev.k}|${ev.ts}|${ev.t}`, ev.ts, t); if (at == null) continue; age = (t - at) / 1000; }
      if (age <= FX_LIFE) list.push({ ev, lane: lane.id, age });
    }
  }
  return list.sort((a, b) => a.age - b.age).slice(0, FX_MAX_LABELS);
}

function labelText(ev) {
  if (ev.k === 'edit') return `✎ ${baseName(editParts(ev.t).path)}`;
  if (ev.k === 'read' || ev.k === 'image') return baseName(ev.t);
  const s = String(ev.t).replace(/^https?:\/\//, '');
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

// 出生点：核心网里偏向目标卡片那一侧；第一次出现时选一个不和正在显示的文件名重叠的位置，之后记住（相对圆心、以半径为单位）
const LABEL_POS = new Map();
function labelSpot(key, side, others) {
  let spot = LABEL_POS.get(key);
  if (!spot) {
    const rand = rng(hash(key));
    for (let i = 0; i < 10; i++) {
      const ang = side + (rand() - 0.5) * 2.4, rad = 0.15 + rand() * 0.6;
      spot = { dx: Math.cos(ang) * rad, dy: Math.sin(ang) * rad };
      if (!others.some((o) => Math.abs(o.dx - spot.dx) < 0.4 && Math.abs(o.dy - spot.dy) < 0.07)) break;
    }
    LABEL_POS.set(key, spot);
    if (LABEL_POS.size > 300) LABEL_POS.delete(LABEL_POS.keys().next().value);
  }
  return spot;
}

function drawLabel(L, c, P, others) {
  const p = P.get(L.lane);
  if (!p) return;
  const side = Math.atan2(p.tok[1] - c.cy, p.tok[0] - c.cx);
  const spot = labelSpot(`${L.ev.run}|${L.ev.ts}|${L.ev.k}|${L.ev.t}`, side, others);
  if (L.age < 1.2) others.push(spot);
  const sx = c.cx + spot.dx * c.R, sy = c.cy + spot.dy * c.R;
  const color = tintOf(L.lane), a = L.age, edit = L.ev.k === 'edit', u1 = 1 / VIEW.k;
  if (a < 1.2 && sx < c.clipX) {
    const alpha = Math.min(1, a / 0.2) * (a > 0.9 ? 1 - (a - 0.9) / 0.3 : 1);
    const scale = (a > 0.9 ? 1 - ((a - 0.9) / 0.3) * 0.7 : 1) * u1, text = labelText(L.ev);
    ctx.save();
    ctx.translate(sx, sy); ctx.scale(scale, scale);
    ctx.font = `${edit ? '600 ' : ''}11px ui-monospace, Consolas, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    // 底色用这个文件所属模型的颜色（压在深底上，白字照样看得清），边框同色
    const w = ctx.measureText(text).width, x0 = -w / 2 - 5, bw = w + 10;
    ctx.fillStyle = `rgba(6,6,7,${0.82 * alpha})`; ctx.fillRect(x0, -8, bw, 16);
    ctx.fillStyle = color(0.42 * alpha); ctx.fillRect(x0, -8, bw, 16);
    ctx.strokeStyle = color(0.85 * alpha); ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, -7.5, bw - 1, 15);
    ctx.fillStyle = HI(alpha * 0.96);
    ctx.fillText(text, 0, 0.5);
    ctx.restore();
  }
  if (a > 0.9) {
    const u = Math.min(1, Math.max(0, (a - 1.05) / (FX_LIFE - 1.05)));
    const dx = p.tok[0] - sx, curve = [[sx, sy], [sx + dx * 0.35, sy], [p.tok[0] - dx * 0.3, p.tok[1]], p.tok];
    if (u < 1) { const [x, y] = cubicAt(curve, ease(u)); tintDot(x, y, edit ? 2.4 : 1.8, color); }
  }
}

// 文件名缩成的光点：整颗都是模型的颜色（外圈柔光、实心亮核，正中一点白）
function tintDot(x, y, r, color) {
  r *= FX.lw;
  ctx.fillStyle = color(0.28); ctx.beginPath(); ctx.arc(x, y, r * 3, 0, 6.283); ctx.fill();
  ctx.fillStyle = color(1); ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
  ctx.fillStyle = HI(0.75); ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, 6.283); ctx.fill();
}

// 说明框：Claude Code 续接几个席位（讨论第 2 轮交叉挑错）时，在核心网上方说明谁的方案交给了谁
function drawNotes(c, t) {
  // 有派发计划时交叉挑错由流程动效（08-life.js）画，这里只管没有计划记录的旧任务
  if (plansAt(t).some((p) => p.round > 1)) return;
  const cc = B.laneById.get('cc');
  const targets = [];
  let age = null;
  if (cc) for (let i = cc.events.length - 1; i >= 0; i--) {
    const ev = cc.events[i], a = ageOf(ev, t);
    if (a < 0) continue;
    if (a > 6) break;
    if (ev.k === 'dispatch' && /^resume\b/.test(ev.t || '') && ev.target) { targets.push(...ev.target); age = a; }
  }
  if (!targets.length) for (const lane of seatLanes(t)) for (const r of lane.runs) {
    const a = ageOf({ ts: r.started_at }, t);
    if ((r.round || 1) >= 2 && a >= 0 && a <= 6) { targets.push(lane.id); age = age == null ? a : Math.min(age, a); }
  }
  if (!targets.length) return;
  const round = Math.max(...targets.map((id) => latest(B.laneById.get(id))?.round || 2));
  const head = `ROUND ${round} · CROSS-CRITIQUE`, body = `anonymized round ${round - 1} plans → ${[...new Set(targets)].map(laneModel).join(', ')}`;
  ctx.save();
  ctx.globalAlpha = Math.min(1, age / 0.3, (6 - age) / 1.2);
  ctx.font = '8px ui-monospace, Consolas, monospace';
  const w = Math.min(c.clipX - 40, ctx.measureText(body).width + 16), x = Math.max(10, c.cx - w / 2), y = c.cy - c.R * 0.82;
  ctx.fillStyle = 'rgba(6,6,7,.9)'; ctx.fillRect(x, y, w, 28);
  ctx.strokeStyle = 'rgba(60,60,68,1)'; ctx.lineWidth = 0.6 * FX.lw; ctx.strokeRect(x, y, w, 28);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(92,92,102,1)'; ctx.font = '6px ui-monospace, Consolas, monospace'; ctx.fillText(head, x + 6, y + 8);
  ctx.fillStyle = HI(1); ctx.font = '8px ui-monospace, Consolas, monospace'; ctx.fillText(body, x + 6, y + 19, w - 12);
  ctx.restore();
}
