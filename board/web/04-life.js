'use strict';
// 派发流程：从派发计划、Claude Code 席报告、各席任务和裁决记录，算出每份计划此刻走到了哪一步。
// 组头上的进度条、还没启动的席位（虚影卡）、画布上的流程动效（08-life.js）都从这里取数。

const byStart = (a, b) => a.started_at - b.started_at;
// 记录里的某个时刻到 t 过去了几秒（屏幕上的秒：回放按倍速折算），流程动效都按它排时间
const secSince = (ts, t) => (t - ts) / 1000 / (B.clock.mode === 'replay' ? B.clock.speed : 1);

function plansAt(t) {
  const list = [];
  for (const ev of B.life) {
    if (ev.k !== 'fplan' || ev.ts > t) continue;
    const runs = [...B.runs.values()].filter((r) => r.plan === ev.plan && r.started_at <= t);
    const hosts = runs.filter((r) => r.kind === 'answer').sort(byStart), seats = runs.filter((r) => r.kind !== 'answer').sort(byStart);
    const verdicts = B.life.filter((v) => v.k === 'verdict' && v.plan === ev.plan && v.ts <= t);
    const round = Math.max(1, ...runs.map((r) => r.round || 1));
    // 每一步最近一次发生的时刻；此刻停在最近发生的那一步（同一时刻取后面的）
    const marks = [[0, ev.ts]];
    for (const h of hosts) marks.push([(h.round || 1) > 1 ? 3 : 1, h.started_at]);
    for (const r of seats) marks.push([(r.round || 1) > 1 ? 3 : 2, r.started_at]);
    for (const v of verdicts) marks.push([4, v.ts]);
    const record = recordAt(ev, runs, verdicts);
    if (record != null) marks.push([5, record]);
    const [stage] = marks.reduce((a, b) => (b[1] > a[1] || b[1] === a[1] && b[0] > a[0] ? b : a));
    list.push({ ev, id: ev.plan, group: ev.group, module: ev.module, seats: ev.seats || [], hosts, runs: seats, verdicts, round, stage, record });
  }
  return list;
}

// 决策记录写成的时刻：最近一轮里，每个外部席和 Claude Code 席都记过去留之后
function recordAt(ev, runs, verdicts) {
  if (!verdicts.length) return null;
  const round = Math.max(...verdicts.map((v) => v.round || 1));
  const need = runs.filter((r) => (r.round || 1) === round);
  const last = new Map();
  for (const v of verdicts) if ((v.round || 1) === round) last.set(v.run, Math.max(last.get(v.run) || 0, v.ts));
  return need.length && need.every((r) => last.has(r.id)) ? Math.max(...last.values()) : null;
}

// 计划里还没启动的席位，先占好位置画成虚影卡
function ghostLanes(t) {
  const out = [];
  for (const p of plansAt(t)) for (const s of p.seats) {
    if (p.runs.some((r) => r.seat === s.seat)) continue;
    if (!seatWaiting(p.id, s.seat, p.ev.ts, t)) continue;
    out.push({ id: `ghost:${p.id}:${s.seat}`, ghost: true, plan: p.id, group: p.group, seat: s, t0: p.ev.ts, runs: [], events: [], seed: hash(`${p.id}:${s.seat}`) });
  }
  return out;
}

// 席位在版面上的车道：启动了就是它的任务车道（第 2 轮续接在第 1 轮的车道上），没启动就是虚影
function seatLaneId(plan, seat) {
  for (const r of B.runs.values()) if (r.plan === plan && r.seat === seat && r.kind !== 'answer') return r.lane || r.id;
  return `ghost:${plan}:${seat}`;
}

// 席位在计划里的序号（决定拉出来的先后）；没有计划的车道排在后面
function seatOrder(lane) {
  if (lane.ghost) return lane.seat.seat;
  const r = lane.runs[0];
  return r && r.seat != null ? r.seat : 1e6;
}
const laneT0 = (lane) => (lane.ghost ? lane.t0 : lane.runs[0].started_at);

// 裁决汇总：某个席位（车道）到 t 为止接受、部分接受、拒绝各几条
function verdictCounts(laneId, t) {
  // 只算最近一轮的那个任务；它的去留可能分几次记下
  const mine = B.life.filter((v) => v.k === 'verdict' && v.lane === laneId && v.ts <= t);
  if (!mine.length) return null;
  const run = mine.reduce((a, b) => (b.ts > a.ts ? b : a)).run, c = { a: 0, p: 0, r: 0, round: 1 };
  for (const v of mine) if (v.run === run) { c.a += v.a.length; c.p += v.p.length; c.r += v.r.length; c.round = v.round || 1; }
  return c;
}

// ---- 产出框的显隐 ----
// 先只有光点往产出框的位置汇聚（gather）；有了实际输出（改了文件、或任务交回结果），光团展开成框（show）；
// 被 Claude Code 读走后收成一颗大光点飞走（collapse），之后不显示（gone），直到下一轮任务再从头汇聚。
// 各阶段的 age 是屏幕秒，grow 是汇聚了多久（0–1，按记录时间，一分钟左右接近满）。
const OUT_MIN_SHOW = 1.6; // 框至少完整显示这么多屏幕秒才收起（结果一交回马上被读走时也看得到）
const OUT_COLLAPSE = 1.4;

function lifeState(E, O, read, t) {
  if (O === Infinity) return { phase: 'gather', from: E, grow: 1 - Math.exp(-(t - E) / 60000) };
  if (read === Infinity) return { phase: 'show', from: E, age: secSince(O, t) };
  const c = secSince(read, t) - Math.max(0, OUT_MIN_SHOW - secSince(O, read));
  if (c < 0) return { phase: 'show', from: E, age: secSince(O, t) };
  return c < OUT_COLLAPSE ? { phase: 'collapse', from: E, to: read, age: c } : { phase: 'gone', from: E };
}

// 席位：以它最近一次任务为准；实际输出 = 第一次改文件或任务结束；读走 = 结束后 Claude Code 第一次取结果（或给它记了裁决）
// 某次任务到 t 为止：第一次有实际输出的时刻 O，被 Claude Code 读走的时刻 read（都没有就是 Infinity）
function outTimes(lane, r, t) {
  const ended = r.ended_at != null && r.ended_at <= t;
  let O = ended ? r.ended_at : Infinity, read = Infinity;
  for (const e of lane.events) if (e.run === r.id && e.k === 'edit' && e.ts <= t) { O = Math.min(O, e.ts); break; }
  if (ended) {
    const cc = B.laneById.get('cc');
    if (cc) for (const e of cc.events) if (e.k === 'collect' && e.ts >= r.ended_at && e.ts <= t && (e.target || []).includes(lane.id)) { read = e.ts; break; }
    for (const v of B.life) if (v.k === 'verdict' && v.run === r.id && v.ts <= t) read = Math.min(read, v.ts);
  }
  return { O, read };
}
const runAt = (lane, t) => { const runs = lane.runs.filter((r) => r.started_at <= t); return runs[runs.length - 1]; };

function outLife(lane, t) {
  if (lane.ghost) return { phase: 'none' };
  const r = runAt(lane, t);
  if (!r) return { phase: 'none' };
  const { O, read } = outTimes(lane, r, t);
  return { ...lifeState(r.started_at, O, read, t), run: r };
}

// ---- 席位进出刻度带 ----
// 刻度带里只放正在干活、或者结果还没被读走的席位：一次任务的结果被 Claude Code 读走、产出框收起之后这一席就离开；
// 一直没被读的（比如没有 Claude Code 记录），结束 LEAVE_GRACE 之后也离开。下一轮任务启动时再回来。
// 一个组里所有席位都要离开时整组才离开，离开时整组溶解成光点飞进 Claude Code（LEAVE_ANIM 屏幕秒），下面的组滑上来补位。
const LEAVE_GRACE = 10 * 60000; // 记录时间
const LEAVE_ANIM = 1.4; // 光点要飞到 Claude Code 卡片，比原地飘散长一些
const recMs = (sec) => sec * 1000 * (B.clock.mode === 'replay' ? B.clock.speed : 1); // 屏幕秒 → 记录毫秒

// 这次任务的这一席什么时候离开（记录时间，还定不下来就是 Infinity）
function leaveAt(lane, r, t) {
  if (!r || r.ended_at == null || r.ended_at > t) return Infinity;
  const { O, read } = outTimes(lane, r, t);
  if (read === Infinity) return r.ended_at + LEAVE_GRACE;
  return read + recMs(Math.max(0, OUT_MIN_SHOW - secSince(O, read)) + OUT_COLLAPSE);
}

// 一组的离开进度：0 = 还在，0–1 = 正在溶解，>= 1 = 已经离开（不再排版）。计划里还没启动的虚影席在时算还在
function groupLeave(lanes, t) {
  if (!lanes.length || lanes.some((l) => l.ghost)) return 0;
  let when = -Infinity;
  for (const lane of lanes) when = Math.max(when, leaveAt(lane, runAt(lane, t), t));
  return when <= t ? secSince(when, t) / LEAVE_ANIM : 0;
}

// 一组此刻在刻度带上显示哪些席位：这一批里启动过的，加上结果还没被读走的；计划里还没启动的虚影席照常显示。
// 一批 = 组里的任务一个接一个、中间没有一刻全部停下的一段。全部停下以后再续接就是新的一批，
// 只有新一批里启动的席位回来（比如返工只续接了两席，早就结束的第三席不跟着回来；讨论第 2 轮不续接的广度席也一样）
function bandLanes(lanes, t) {
  const runs = lanes.flatMap((l) => (l.ghost ? [] : l.runs.filter((r) => r.started_at <= t && r.kind !== 'answer'))).sort(byStart);
  let busy = -Infinity, from = -Infinity;
  for (const r of runs) {
    if (r.started_at > busy) from = busy;
    busy = Math.max(busy, r.ended_at != null && r.ended_at <= t ? r.ended_at : Infinity);
  }
  return lanes.filter((l) => l.ghost || runAt(l, t).started_at > from || leaveAt(l, runAt(l, t), t) > t);
}

// 一席这一次是什么时候"进来"的：第一次任务启动，或者离开之后下一轮任务启动；一直在的返回 null（不播进场）
function enteredAt(lane, t) {
  const runs = lane.runs.filter((r) => r.started_at <= t), r = runs[runs.length - 1];
  if (!r) return null;
  const prev = runs[runs.length - 2];
  return !prev || leaveAt(lane, prev, r.started_at) <= r.started_at ? r.started_at : null;
}

// Claude Code：用户每发一条消息、每建一份派发计划，算把这一段的产出交出去了（kind 记下是哪一种，动画不同）；
// 实际输出 = 这一段里第一条给用户的话、第一次改文件或交 Claude Code 席报告
const CC_OUT_KINDS = new Set(['msg', 'edit']);
// Claude Code 的产出框没有人"读走"：这一轮安静 CC_QUIET（记录时间）以后就地收起（化成光点散开），下一轮有输出时再出现
const CC_QUIET = 3 * 60000;
// Claude Code 车道在 before 之前最后一次有动静的时刻
function ccLastAct(cc, before) {
  for (let i = cc.events.length - 1; i >= 0; i--) if (cc.events[i].ts < before) return cc.events[i].ts;
  return -Infinity;
}
function ccLife(t) {
  const cc = B.laneById.get('cc');
  if (!cc || !latest(cc)) return { phase: 'none' };
  const bounds = [{ ts: latest(cc).started_at, kind: null }];
  for (const e of cc.events) if (e.k === 'prompt' && e.ts <= t) bounds.push({ ts: e.ts, kind: 'prompt' });
  for (const e of B.life) if (e.k === 'fplan' && e.ts <= t) bounds.push({ ts: e.ts, kind: 'plan', plan: e.plan });
  // 没有计划直接派出去的任务也一样：产出框收成光点，拉出那一席（08-life.js 的 drawDispatchBirth）
  for (const r of B.runs.values()) if (!r.plan && r.kind !== 'answer' && r.kind !== 'host' && r.started_at <= t) bounds.push({ ts: r.started_at, kind: 'plan' });
  bounds.sort((a, b) => a.ts - b.ts);
  const firstOut = (from, to) => {
    let O = Infinity;
    for (const e of cc.events) if (e.ts > from && e.ts <= to && CC_OUT_KINDS.has(e.k)) { O = e.ts; break; }
    // Claude Code 席报告：等封好的印记飞进来（约 0.9 屏幕秒）才算有了输出
    const sealMs = 900 * (B.clock.mode === 'replay' ? B.clock.speed : 1);
    for (const r of cc.runs) if (r.kind === 'answer' && r.started_at > from && r.started_at + sealMs <= to) O = Math.min(O, r.started_at + sealMs);
    return O;
  };
  const last = bounds[bounds.length - 1], prev = bounds[bounds.length - 2];
  // 刚交出去的上一段：有过输出就先播收起的动画（上一段已经因为安静收起了就不再播）
  if (prev && last.kind) {
    const O = firstOut(prev.ts, last.ts), age = secSince(last.ts, t) - Math.max(0, OUT_MIN_SHOW - secSince(O, last.ts));
    const quietBefore = ccLastAct(cc, last.ts) + CC_QUIET < last.ts;
    if (O < last.ts && !quietBefore && age < OUT_COLLAPSE) return { phase: age < 0 ? 'show' : 'collapse', from: prev.ts, to: last.ts, age: age < 0 ? 9 : age, kind: last.kind };
  }
  const O = firstOut(last.ts, t);
  if (O === Infinity) return laneActive(cc, t) ? { phase: 'gather', from: last.ts, grow: 1 - Math.exp(-(t - last.ts) / 60000) } : { phase: 'none', from: last.ts };
  // 这一轮已经安静了一阵：框就地收起，收完就不再显示
  const quietAt = ccLastAct(cc, t + 1) + CC_QUIET;
  if (quietAt < t) {
    const age = secSince(quietAt, t);
    return age < OUT_COLLAPSE ? { phase: 'collapse', from: last.ts, to: t, age, kind: 'quiet' } : { phase: 'none', from: last.ts };
  }
  // 安静收起以后又有了动静：等空档之后真有了输出（回答、改文件）框才回来，只显示空档之后的；
  // 后台任务交回、跑命令这些不算输出
  const gap = ccQuietGap(cc, last.ts, t);
  if (gap) {
    const after = firstOut(gap.since, t);
    if (after === Infinity) return laneActive(cc, t) ? { phase: 'gather', from: gap.since, grow: 1 - Math.exp(-(t - gap.until) / 60000) } : { phase: 'none', from: last.ts };
    return { phase: 'show', from: gap.since, age: secSince(after, t) };
  }
  return { phase: 'show', from: last.ts, age: secSince(O, t) };
}
// 这一段（from 之后）里最近一次安静满 CC_QUIET、后来又有了动静的空档：since 是空档前最后一次动静，until 是空档后的第一次；没有为 null
function ccQuietGap(cc, from, t) {
  let prev = null, gap = null;
  for (const e of cc.events) {
    if (e.ts <= from) continue;
    if (e.ts > t) break;
    if (prev != null && e.ts - prev >= CC_QUIET) gap = { since: prev, until: e.ts };
    prev = e.ts;
  }
  return gap;
}

// 框的透明度和缩放：展开时从光团里长出来，收起时缩回一颗光点
function outLook(life) {
  if (life.phase === 'show') { const m = clamp01(life.age / 0.45); return { a: m, s: 0.35 + 0.65 * ease(m) }; }
  if (life.phase === 'collapse') { const m = clamp01(life.age / 0.35); return { a: 1 - m, s: 1 - 0.8 * m }; }
  return { a: 0, s: 0.35 };
}

// ---- Claude Code 卡片离场 ----
// 整个对话闲下来（Claude Code 是 idle、刻度带里一张席位卡都没有、它的产出框也已经收起）时，卡片缩成一颗光点、
// 沿弧线飞进弧线区中央的亮核；重新活跃时倒着放：光点从亮核飞回来，长成卡片（08-life.js 的 drawCcAway）。
// 返回 0–1：0 = 卡片在，1 = 已经离开。动画按屏幕时间放，中途反过来时从当前的进度接着倒放；
// 刚打开页面或换了对话时直接停在那时的样子，不放动画。回放里 Claude Code 一直算 active，不会离开
const CC_AWAY_ANIM = 1.6; // 屏幕秒：前 40% 卡片缩成光点，后 60% 光点飞进亮核
const CC_AWAY = { lane: null, away: false, at: -Infinity };
function ccAway(L, t) {
  // 看板只读最近一段时间的 Claude Code 记录：闲了很久的对话没有这条车道，也算闲下来了（不然卡片一直挂着"还没有记录"）
  const cc = B.laneById.get('cc'), quiet = !cc || !latest(cc) || !laneStatus(cc, t).running && ccLife(t).phase === 'none';
  const want = !L.groups.length && quiet;
  const now = performance.now(), dur = CC_AWAY_ANIM * 1000, u = clamp01((now - CC_AWAY.at) / dur);
  if (CC_AWAY.lane !== cc) Object.assign(CC_AWAY, { lane: cc, away: want, at: -Infinity });
  else if (want !== CC_AWAY.away) Object.assign(CC_AWAY, { away: want, at: now - (1 - u) * dur });
  const p = clamp01((now - CC_AWAY.at) / dur);
  return CC_AWAY.away ? p : 1 - p;
}

// ---- 节拍 ----
// 用真实发生的事当节拍（不放假的节奏）：每一下产生一个很快衰减的强度，弧线区的亮核闪一下、核心网的转动被推一把、
// 相关的光路短暂变宽（08-fx.js 的 drawFx 和 08-beams.js 用）。派出和交回最明显，读走结果、记下裁决次之，Claude Code 回一句话最轻。
// 按记录时间算，回放、暂停、拖动时间线时和直播一样；几下叠在一起取最大值，离上一下不到 0.8 屏幕秒、又不比它强的就并掉
// （同一次派出既有 Claude Code 的派出动作、又有那一席的任务启动，只算一下），事件密时不会一直闪。
// 直播里事件要过一会儿才送到页面（看板服务每秒推一次，晚 0.2–1 秒），按记录时刻算的话到的时候已经暗了：
// 直播时一下从页面第一次看到它起算，到的时候正好最亮；第一次看到时已经过去 BEAT.late 秒以上的不算（刚打开页面时的旧事件）。
// 回放照旧按记录时刻。返回 { env: 整体强度 0–1, lanes: 车道 id → 这条车道的强度 }
const BEAT = { window: 1.2, decay: 4.5, merge: 0.8, late: 1.5, seen: new Map(), kinds: { dispatch: 0.9, result: 0.8, collect: 0.6, verdict: 0.6, msg: 0.45 } };
function beatsAt(t) {
  const live = B.clock.mode !== 'replay', from = t - recMs(BEAT.window + (live ? BEAT.late : 0)), list = [];
  const add = (ts, kind, lanes) => {
    if (!(ts > from && ts <= t)) return;
    let at = ts;
    if (live) {
      const key = `${kind}|${lanes[0]}|${ts}`;
      if (!BEAT.seen.has(key)) BEAT.seen.set(key, { ts, at: t - ts > recMs(BEAT.late) ? -Infinity : t });
      at = BEAT.seen.get(key).at;
    }
    if (at > t - recMs(BEAT.window)) list.push({ ts: at, s: BEAT.kinds[kind], lanes });
  };
  for (const [key, v] of BEAT.seen) if (v.ts < t - recMs(10)) BEAT.seen.delete(key);
  const cc = B.laneById.get('cc');
  if (cc) for (let i = cc.events.length - 1; i >= 0 && cc.events[i].ts > from; i--) {
    const e = cc.events[i];
    if (e.k === 'msg') add(e.ts, 'msg', ['cc']);
    else if (e.k === 'dispatch' || e.k === 'collect') add(e.ts, e.k, ['cc', ...(e.target || [])]);
  }
  for (const lane of B.lanes) {
    if (lane.id === 'cc' || lane.ghost) continue;
    for (const r of lane.runs) { if (r.kind === 'answer') continue; add(r.started_at, 'dispatch', [lane.id]); if (r.ended_at != null) add(r.ended_at, 'result', [lane.id]); }
  }
  for (const v of B.life) if (v.k === 'verdict' && v.lane) add(v.ts, 'verdict', [v.lane]);
  list.sort((a, b) => a.ts - b.ts);
  const out = { env: 0, lanes: new Map() };
  let last = -Infinity, lastS = 0;
  for (const b of list) {
    // 各条车道自己的光路照样跟着每一下变宽；并掉的只是整体那一下闪
    const e = b.s * Math.exp(-secSince(b.ts, t) * BEAT.decay);
    for (const id of b.lanes) out.lanes.set(id, Math.max(out.lanes.get(id) || 0, e));
    if (secSince(last, b.ts) < BEAT.merge && b.s <= lastS) continue;
    last = b.ts; lastS = b.s;
    out.env = Math.max(out.env, e);
  }
  return out;
}
