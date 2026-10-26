'use strict';
// token 速度和用量。各家记录用量的粒度都很粗，速度一律是估算（页面上写成 ≈）：
// - 有分段用量的：输出摊到上一份用量到这一份之间；同轮有分段时忽略整轮总量；
// - 流式字数（pi、API）：最后一份用量之后的字数增量 ÷ 4 当作 token；
// - 回放时还知道每个任务最后的总用量：没被上面两种算到的部分，摊到这个任务各个事件之间的空档上（"回放估算"）。
// 已知的局限：直播的估速只在命令执行期间暂停；pi、opencode 读文件、搜索这类工具没有开始事件，执行期间仍按样本估（通常只有几百毫秒）。

const WINDOW = 10000, SEG_MAX = 90000, GAP_MAX = 300000, CHARS_PER_TOKEN = 4;
const FINAL = new Map(); // run id → 回放结束时的 run 消息（总用量）
const FINAL_EV = new Map(); // 车道 id → 回放的全部事件（估算速度用，不随回放进度变化）
const SEG_RUN = new WeakMap(); // 分段归属供任务内去重和直播采样，不增加对外字段

// 画面仍用压缩时钟；统计窗口插值回原始时间，倍速只改变播放调度。
function recordTime(t) {
  const points = B.clock.mode === 'replay' ? B.hello?.replay?.time_map : null;
  if (!points?.length) return t;
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid][0] <= t) lo = mid + 1; else hi = mid; }
  const a = points[Math.max(0, lo - 1)], b = points[lo];
  return b && t >= a[0] ? a[1] + (t - a[0]) * (b[1] - a[1]) / (b[0] - a[0]) : a[1] + t - a[0];
}

// 回放：取一次结束时的快照，拿到每个任务最后的用量
function loadFinals() {
  if (window.__BOARD_FIXTURE__ || B.clock.mode !== 'replay' || loadFinals.started) return;
  loadFinals.started = true;
  const gen = loadFinals.gen, q = scopeQuery();
  // from 只对明细流有意义（从宇宙层当时的时刻接着放）；快照带上它会被回放服务拒绝
  q.delete('from');
  q.set('t', '100000000');
  fetch(`snapshot?${q}`).then((r) => r.json()).then((s) => {
    if (gen !== loadFinals.gen) return; // 回来时已经换了对话：丢掉
    for (const r of s.runs) FINAL.set(r.id, r);
    for (const ev of s.events) { const id = ev.lane || ev.run; if (!FINAL_EV.has(id)) FINAL_EV.set(id, []); FINAL_EV.get(id).push(ev); }
    for (const list of FINAL_EV.values()) list.sort((a, b) => a.ts - b.ts);
    for (const lane of B.lanes) lane.segs = null;
    // 补齐的是历史用量，不是输出加快：加速脉冲的基线从补齐后的速度重新算（08-surge.js）
    if (typeof SURGE !== 'undefined') SURGE.clear();
    B.version++;
  }).catch(() => {});
}

// 用量统一成 { input(未命中缓存), cached, cache_write, output }；v1 的 input 含缓存部分
function usageOf(r) {
  if (r?.usage_unattributed) return null;
  const u = r && r.usage;
  if (!u) return null;
  if ('cache_write' in u) return { input: u.input || 0, cached: u.cached || 0, cache_write: u.cache_write || 0, output: u.output || 0 };
  return { input: Math.max(0, (u.input || 0) - (u.cached || 0)), cached: u.cached || 0, cache_write: 0, output: u.output || 0 };
}

// 事件未保留命令 ID，按任务计数，所有并行命令结束才恢复生成。
// [from, to) 和命令时段有没有重叠。同一个任务的命令时段按开始时间排好、互不重叠（commandSpans 把嵌套的命令并成一段），
// 结束时间也就跟着有序：二分找最后一个在 to 之前开始的，看它是不是过了 from。逐个比较在命令多的长任务里是平方级
function overlapsCommand(spans, from, to) {
  let lo = 0, hi = spans.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (spans[mid].a < to) lo = mid + 1; else hi = mid; }
  return lo > 0 && spans[lo - 1].b > from;
}

// 同一份事件（没有新增）重复算命令时段很费：按数组缓存，条数或首尾变了才重算
const SPANS = new WeakMap();
function cachedSpans(events) {
  const hit = SPANS.get(events);
  if (hit && hit.n === events.length && hit.first === events[0] && hit.last === events.at(-1)) return hit.spans;
  const spans = commandSpans(events);
  SPANS.set(events, { n: events.length, first: events[0], last: events.at(-1), spans });
  return spans;
}
function commandSpans(events) {
  const spans = new Map(), counts = new Map();
  for (const ev of events) {
    const count = counts.get(ev.run) || 0;
    if (ev.k === 'cmd') {
      if (!count) {
        if (!spans.has(ev.run)) spans.set(ev.run, []);
        spans.get(ev.run).push({ a: ev.ts, b: Infinity });
      }
      counts.set(ev.run, count + 1);
    } else if (ev.k === 'cmd_done' && count > 0) {
      counts.set(ev.run, count - 1);
      if (count === 1) spans.get(ev.run).at(-1).b = ev.ts;
    }
  }
  return spans;
}

// 一条车道的输出分段：[{ a, b, tokens }]，a/b 是记录时间（毫秒）
function segments(lane) {
  const live = B.clock.mode === 'live';
  let events = FINAL_EV.get(lane.id) || (live ? lane.rate_events ?? lane.events : lane.events);
  const outputs = new Map(lane.runs.map((r) => [r.id, r.usage_unattributed ? 0 : FINAL.get(r.id)?.usage?.output ?? (r.ended_at != null ? r.usage?.output : null)]));
  const outputKey = JSON.stringify([...outputs]);
  // 分段还依赖车道上的任务（续接的任务会陆续出现），任务数变了也要重算
  const ver = `${FINAL_EV.has(lane.id) ? events.length : (lane.ver || 0)}|${lane.runs.length}`;
  // 最终用量晚于事件到达，上限更新后也要重算。
  if (lane.segs && lane.segsAt === ver && lane.segsUsage === outputKey) return lane.segs;
  if (!live) events = events.map((e) => ({ ...e, ts: e.original_ts ?? e.ts }));
  const segs = [];
  const lastUsage = new Map(), turnUsage = new Map(), usageSegs = new Map(), lastChars = {};
  const turns = new Map(), stepTurns = new Set();
  // 先看整轮，迟到的分段也能替换排在它前面的累计总量。
  for (const ev of events) {
    if (ev.k === 'turn') turns.set(ev.run, (turns.get(ev.run) || 0) + 1);
    else if (ev.k === 'usage' && !ev.tot && ev.u?.out != null) stepTurns.add(`${ev.run}:${turns.get(ev.run) || 0}`);
  }
  turns.clear();
  const usageEnds = new Map(events.filter((e) => e.k === 'usage' && e.u?.out != null).map((e) => [e.run, e.usage_to ?? e.ts]));
  const commands = cachedSpans(events);
  const byRun = new Map();
  for (const ev of events) if (ev.k !== 'usage') {
    if (!byRun.has(ev.run)) byRun.set(ev.run, []);
    byRun.get(ev.run).push(ev);
  }
  const counted = new Map(); // run id → 已经由分段用量或字数算到的 token
  const starts = new Map(lane.runs.map((r) => [r.id, !live ? r.original_started_at ?? r.started_at : r.started_at]));
  // 按任务内事件的空档摊开，去掉命令时间后，单个空档最多算 GAP_MAX。
  // 推理模型一次请求里可以长时间不出事件（只在想），按 60 秒截断会把生成时间算少、速度估高（实测一个 Codex 记录高 84%）；
  // 命令时间已经单独扣掉，这里只防真正的空闲（比如排队、等人），所以放宽到 5 分钟
  const spread = (run, a, b, tokens, est) => {
    if (!(tokens > 0) || !(b > a)) return;
    counted.set(run, (counted.get(run) || 0) + tokens);
    // 按任务分桶并直接定位区间，长会话不能为每份用量重新扫描全部历史。
    const own = byRun.get(run) || [], times = [a];
    let lo = 0, hi = own.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (own[mid].ts <= a) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < own.length && own[i].ts < b; i++) times.push(own[i].ts);
    times.push(b);
    const gaps = [];
    for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) gaps.push({ b: times[i], w: Math.min(times[i] - times[i - 1], GAP_MAX) });
    const runCommands = commands.get(run) || [];
    let active = gaps.filter((g) => !overlapsCommand(runCommands, g.b - g.w, g.b));
    if (!active.length) active = gaps; // 全被命令覆盖时仍保留原来的 token 摊分。
    if (est) {
      // 只补本任务未覆盖的区间；重叠分段按并集扣掉，其他任务不参与。
      const covered = segs.filter((s) => SEG_RUN.get(s) === run).sort((x, y) => x.a - y.a), uncovered = [];
      for (const g of active) {
        let a = g.b - g.w;
        for (const s of covered) {
          if (s.b <= a) continue;
          if (s.a >= g.b) break;
          if (s.a > a) uncovered.push({ b: s.a, w: s.a - a });
          a = Math.max(a, s.b);
        }
        if (a < g.b) uncovered.push({ b: g.b, w: g.b - a });
      }
      if (!uncovered.length && covered.length) {
        const total = covered.reduce((sum, s) => sum + s.tokens, 0);
        for (const s of covered) { s.tokens += tokens * s.tokens / total; s.est = true; }
        return;
      }
      active = uncovered;
    }
    const total = active.reduce((s, g) => s + g.w, 0);
    for (const g of active) {
      const s = { a: g.b - g.w, b: g.b, tokens: (tokens * g.w) / total, est };
      SEG_RUN.set(s, run); segs.push(s);
    }
  };
  for (const ev of events) {
    if (ev.k === 'turn') { turns.set(ev.run, (turns.get(ev.run) || 0) + 1); turnUsage.set(ev.run, 0); }
    else if (ev.k === 'usage' && ev.u && ev.u.out != null) {
      if (ev.tot && stepTurns.has(`${ev.run}:${turns.get(ev.run) || 0}`)) continue;
      const before = counted.get(ev.run) || 0, limit = outputs.get(ev.run);
      const tokens = ev.tot ? Math.max(0, Math.min(ev.u.out - (turnUsage.get(ev.run) || 0), limit == null ? Infinity : limit - before)) : ev.u.out;
      const end = ev.usage_to ?? ev.ts;
      const prev = lastUsage.get(ev.run) ?? ev.usage_from ?? (lane.id === 'cc' ? end - 20000 : starts.get(ev.run) ?? end - 20000);
      const previous = usageSegs.get(ev.run);
      if (tokens > 0 && end <= prev && previous?.length) {
        // 同时收到的用量共用上一份生成区间，不能丢 token 或制造极短分段。
        const duration = previous.reduce((n, s) => n + s.b - s.a, 0);
        for (const s of previous) s.tokens += tokens * (s.b - s.a) / duration;
        counted.set(ev.run, before + tokens);
      } else {
        const at = segs.length, from = end <= prev ? starts.get(ev.run) ?? end - 20000 : prev;
        spread(ev.run, lane.id === 'cc' ? Math.max(from, end - SEG_MAX) : from, end, tokens, false);
        if (segs.length > at) usageSegs.set(ev.run, segs.slice(at));
      }
      turnUsage.set(ev.run, (turnUsage.get(ev.run) || 0) + (counted.get(ev.run) || 0) - before);
      lastUsage.set(ev.run, Math.max(lastUsage.get(ev.run) ?? end, end));
    } else if ((ev.k === 'think' || ev.k === 'answer') && ev.n != null) {
      const key = `${ev.run}:${ev.k}`, prev = lastChars[key];
      // 用量覆盖此前的字数估算，跨过用量边界的字数也不带到下一段。
      if (prev && prev.ts >= (usageEnds.get(ev.run) ?? -Infinity) && ev.n > prev.n) spread(ev.run, prev.ts, ev.ts, (ev.n - prev.n) / CHARS_PER_TOKEN, false);
      lastChars[key] = { ts: ev.ts, n: ev.n };
    }
  }
  // 回放估算只补尚未覆盖的生成区间，全部覆盖时增加 token 而不增加时长。
  for (const r of lane.runs) {
    const f = usageOf(FINAL.get(r.id));
    if (!f) continue;
    const rest = f.output - (counted.get(r.id) || 0);
    const final = FINAL.get(r.id), end = final.original_ended_at ?? final.ended_at ?? r.original_ended_at ?? r.ended_at;
    if (rest > 0 && end != null) spread(r.id, starts.get(r.id), end, rest, true);
  }
  segs.sort((x, y) => x.a - y.a);
  lane.segs = segs;
  lane.segsAt = ver;
  lane.segsUsage = outputKey;
  return segs;
}

function rateSample(lane, runs, t) {
  const ids = new Set(runs.map((r) => r.id));
  let tokens = 0, ms = 0;
  for (const s of segments(lane)) {
    if (s.est || s.b > t || !ids.has(SEG_RUN.get(s))) continue;
    tokens += s.tokens; ms += s.b - s.a;
  }
  return { tokens, ms };
}

// 直播在最近一份用量之后只补速度，不回填分段、总量或平均速度。
// 车道上每个在跑的任务从哪一刻起按实时估速算（最后一个回合开始或最后一次用量以后），和问的是哪个时刻无关：
// 事件（车道的事件版本号 lane.ver、条数和首尾）和任务都没变就沿用，速度曲线每个点都要问一次。没有起点（还没开始回合、这一轮已经交了总数、起点之后有字数估算）的不列
const LIVE_STARTS = new WeakMap();
function liveStarts(lane, rateEvents) {
  const hit = LIVE_STARTS.get(lane);
  if (hit && hit.events === rateEvents && hit.ver === lane.ver && hit.n === rateEvents.length && hit.first === rateEvents[0] && hit.last === rateEvents.at(-1)
    && hit.runs === lane.runs.length) return hit.map;
  const map = new Map();
  for (const r of lane.runs) {
    if (r.status !== 'running') continue;
    const events = rateEvents.filter((e) => e.run === r.id);
    const at = events.findLastIndex((e) => e.k === 'turn'), turn = events[at], usage = events.findLast((e) => e.k === 'usage' && e.u?.out != null);
    // 结束标记可能不在末条用量，迟到的分段不能重新开启估速。
    if (!turn || events.slice(at + 1).some((e) => e.k === 'usage' && (e.tot || e.end))) continue;
    const from = Math.max(turn.ts, usage?.ts ?? -Infinity);
    if (events.some((e) => e.ts >= from && (e.k === 'think' || e.k === 'answer') && e.n != null)) continue;
    map.set(r.id, from);
  }
  LIVE_STARTS.set(lane, { events: rateEvents, ver: lane.ver, n: rateEvents.length, first: rateEvents[0], last: rateEvents.at(-1), runs: lane.runs.length, map });
  return map;
}

function liveRate(lane, t, win = WINDOW) {
  if (B.clock.mode !== 'live' || B.clock.frozenAt != null || lane.id === 'cc') return 0;
  // 先看 t 时有没有在跑的任务：速度曲线对每个点都调一次，结束了的车道不必再扫事件
  const open = lane.runs.filter((r) => r.status === 'running' && r.started_at <= t && (r.ended_at == null || r.ended_at > t));
  if (!open.length) return 0;
  const rateEvents = lane.rate_events ?? lane.events, commands = cachedSpans(rateEvents), starts = liveStarts(lane, rateEvents);
  let rate = 0;
  for (const r of open) {
    const from = starts.get(r.id);
    if (from == null || from > t) continue;
    const busy = commands.get(r.id) || [];
    if (busy.some((c) => c.a <= t && c.b > t)) continue;
    const sample = rateSample(lane, lane.runs.filter((x) => x.model === r.model && x.started_at <= t), t);
    if (!sample.ms && r.model) {
      for (const other of B.lanes) {
        if (other === lane) continue;
        const peer = rateSample(other, other.runs.filter((x) => x.model === r.model && x.started_at <= t), t);
        sample.tokens += peer.tokens; sample.ms += peer.ms;
      }
    }
    if (!sample.ms) continue;
    const a = Math.max(from, t - win);
    let active = t - a;
    for (const c of busy) active -= Math.max(0, Math.min(c.b, t) - Math.max(c.a, a));
    rate += (sample.tokens / (sample.ms / 1000)) * active / win;
  }
  return rate;
}

// 时刻 t 前 WINDOW 内的平均输出速度（token/秒）
function rateAt(lane, t, win = WINDOW) {
  return recordRate(lane, recordTime(t), win);
}

function recordRate(lane, t, win = WINDOW) {
  let tokens = 0;
  for (const s of segments(lane)) {
    if (s.a >= t) break;
    const lo = Math.max(s.a, t - win), hi = Math.min(s.b, t);
    if (hi > lo) tokens += (s.tokens * (hi - lo)) / (s.b - s.a);
  }
  return tokens / (win / 1000) + liveRate(lane, t, win);
}

// 速度曲线：从这条车道第一轮开始到最后一轮结束（还在跑的画到现在），n 个点。结束以后曲线停住，
// 画的是它在这个对话里的全部时长；每个点取它之前两格宽的平均速度
// 结束了的车道曲线是定住的：算一次缓存起来。曲线只由速度分段决定（结束的车道没有实时估速），
// 分段重算了（事件、补发重置、最终用量、回放的最终快照有变化，见 segments 的缓存条件）曲线就跟着重算
const SPARKS = new WeakMap();
function sparkline(lane, t, n = 40) {
  const replay = B.clock.mode === 'replay', at = (r, k) => (replay ? r[`original_${k}`] ?? r[k] : r[k]);
  t = recordTime(t);
  const runs = lane.runs.filter((r) => r.kind !== 'answer' && at(r, 'started_at') <= t);
  if (!runs.length) return new Array(n).fill(0);
  let start = Math.min(...runs.map((r) => at(r, 'started_at')));
  // 直播时曲线从有速度数据的地方画起：Claude Code 那一行从对话开头算起，但桌面版重启前的先前记录只算了用量、
  // 没有速度明细，那几天整段画成 0 会让人以为什么都没做
  if (!replay) { let first = Infinity; for (const s of segments(lane)) if (s.a < first) first = s.a; if (first > start && first < t) start = first; }
  const open = runs.some((r) => at(r, 'ended_at') == null || at(r, 'ended_at') > t);
  const end = open ? t : Math.max(...runs.map((r) => at(r, 'ended_at'))), step = Math.max(1, end - start) / n;
  const segs = open ? null : segments(lane), key = open ? null : `${n}|${start}|${end}|${runs.length}|${replay}`, hit = SPARKS.get(lane);
  if (key && hit?.key === key && hit.segs === segs) return hit.out;
  const out = [];
  for (let i = 1; i <= n; i++) out.push(recordRate(lane, start + i * step, Math.max(1000, step * 2)));
  if (key) SPARKS.set(lane, { key, segs, out });
  return out;
}

// 用量明确记成全 0（一次请求都没完成）：没有可算的费用。输入和输出都明确是 0（没报的缓存字段可以是 null）才算；
// 没报用量的（整个是 null，或者输入、输出是 null）不算在内。要看原始的用量，不能看补过 0 的
const zeroUsage = (u) => !!u && u.input === 0 && u.output === 0 && Object.values(u).every((v) => v === 0 || v == null);

// 一条车道到时刻 t 的统计：已结束的任务用最终用量，进行中的按分段估到 t
function laneStats(lane, t) {
  const replay = B.clock.mode === 'replay', runs = replay ? lane.runs.map((r) => ({ ...r,
    started_at: r.original_started_at ?? r.started_at, ended_at: r.original_ended_at ?? r.ended_at })) : lane.runs;
  t = recordTime(t);
  const sum = { input: 0, cached: 0, cache_write: 0, output: 0 };
  let cost = 0, costKnown = false, costPartial = false, est = false, usage_unattributed = false;
  let gen = 0, first = null, last = null, running = false;
  for (const r of runs) {
    if (r.started_at > t) continue;
    if (r.usage_unattributed) usage_unattributed = true;
    first = Math.min(first ?? r.started_at, r.started_at);
    const ended = r.ended_at != null && r.ended_at <= t;
    last = Math.max(last ?? 0, ended ? r.ended_at : t);
    if (!ended) running = true;
    // Claude Code 的 run 消息随每条消息的用量更新，进行中也能直接用
    const live = r.kind === 'host';
    const u = ended || live ? usageOf(r) || (ended ? usageOf(FINAL.get(r.id)) : null) : null;
    if (u) for (const k in sum) sum[k] += u[k];
    const c = ended ? (r.cost_usd ?? FINAL.get(r.id)?.cost_usd) : live ? r.cost_usd : null;
    // 费用后面的 +：还有没算进来的费用，和宇宙视图同一条规则。还在跑的任务还没有费用；结束了却算不出价的；
    // Claude Code 车道有用量却没有费用（模型不在价格表里；它一直在进行中）。结束了、用量明确记成全 0 的（一次请求都没完成）没有可算的，
    // Claude Code 席自己提交的报告按规则不计费，这两种不算；用量没报（null）的照样算不全
    if (c == null && r.kind !== 'answer' && (live ? Object.values(r.usage || {}).some((v) => v) : !ended || !zeroUsage(r.usage ?? FINAL.get(r.id)?.usage))) costPartial = true;
    // 费用一律按官方 API 价格（服务端算好），这里只是加起来
    if (c != null) { costKnown = true; cost += c; }
    // Claude Code 车道有的消息算不出价：能算的照加，费用后面带 +
    if (r.cost_partial) costPartial = true;
  }
  // 进行中的输出：分段里 t 之前的部分
  let liveOut = 0;
  for (const s of segments(lane)) {
    if (s.a >= t) break;
    const runOpen = runs.some((r) => r.id === SEG_RUN.get(s) && r.started_at <= s.b && (r.ended_at == null || r.ended_at > t));
    if (!runOpen) continue;
    liveOut += (s.tokens * (Math.min(s.b, t) - s.a)) / (s.b - s.a);
    if (s.est) est = true;
  }
  const covered = new Map(), ends = new Map();
  for (const s of segments(lane)) {
    if (s.a >= t) break;
    const ms = Math.min(s.b, t) - s.a, run = SEG_RUN.get(s);
    // 回放的字数分段也可能重叠，同一任务的生成时长只取并集。
    if (replay) {
      gen += Math.max(0, Math.min(s.b, t) - Math.max(s.a, ends.get(run) ?? -Infinity));
      ends.set(run, Math.max(ends.get(run) ?? -Infinity, Math.min(s.b, t)));
    } else gen += ms;
    covered.set(run, (covered.get(run) || 0) + s.tokens * ms / (s.b - s.a));
    if (s.est) est = true;
  }
  const hostLive = lane.runs.some((r) => r.kind === 'host');
  const out = sum.output + (running && !hostLive ? liveOut : 0);
  // 最终输出没有完整分段时，不能拿总输出除以局部生成时长。
  // Claude Code 的同消息用量会原位修订，未替换的事件只用于估时，不能据此判覆盖失败。
  const complete = B.clock.mode !== 'live' || lane.id === 'cc' || lane.runs.every((r) => {
    if (r.started_at > t || !(r.ended_at != null && r.ended_at <= t || r.kind === 'host')) return true;
    const u = usageOf(r), tokens = covered.get(r.id) || 0;
    return u ? Math.abs(u.output - tokens) <= 1e-6 * Math.max(1, u.output) : tokens === 0;
  });
  if (liveRate(lane, t) > 0) est = true;
  return {
    ...sum, output: usage_unattributed ? null : out, usage_unattributed, cost: costKnown ? cost : null, costPartial, est, running,
    rate: recordRate(lane, t), avg: gen > 0 && complete && !usage_unattributed ? out / (gen / 1000) : null,
    elapsed: first != null ? (last - first) / 1000 : 0,
  };
}

// 速度 → 光束亮度 0..1（对数，10 tok/s 约 0.35，150 tok/s 到顶）
const glow = (rate) => Math.max(0, Math.min(1, Math.log1p(rate) / Math.log1p(150)));
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
