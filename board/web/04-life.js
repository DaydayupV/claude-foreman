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
// 一个组里所有席位都要离开时整组才离开，离开时整组溶解成光点（LEAVE_ANIM 屏幕秒），下面的组滑上来补位。
const LEAVE_GRACE = 10 * 60000; // 记录时间
const LEAVE_ANIM = 0.9;
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
  // 刚交出去的上一段：有过输出就先播收起的动画
  if (prev && last.kind) {
    const O = firstOut(prev.ts, last.ts), age = secSince(last.ts, t) - Math.max(0, OUT_MIN_SHOW - secSince(O, last.ts));
    if (O < last.ts && age < OUT_COLLAPSE) return { phase: age < 0 ? 'show' : 'collapse', from: prev.ts, to: last.ts, age: age < 0 ? 9 : age, kind: last.kind };
  }
  const O = firstOut(last.ts, t);
  if (O === Infinity) return laneActive(cc, t) ? { phase: 'gather', from: last.ts, grow: 1 - Math.exp(-(t - last.ts) / 60000) } : { phase: 'none', from: last.ts };
  return { phase: 'show', from: last.ts, age: secSince(O, t) };
}

// 框的透明度和缩放：展开时从光团里长出来，收起时缩回一颗光点
function outLook(life) {
  if (life.phase === 'show') { const m = clamp01(life.age / 0.45); return { a: m, s: 0.35 + 0.65 * ease(m) }; }
  if (life.phase === 'collapse') { const m = clamp01(life.age / 0.35); return { a: 1 - m, s: 1 - 0.8 * m }; }
  return { a: 0, s: 0.35 };
}
