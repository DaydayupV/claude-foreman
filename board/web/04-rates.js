'use strict';
// token 速度和用量。各家记录用量的粒度都很粗，速度一律是估算（页面上写成 ≈）：
// - 有分段用量的（Claude Code 每条消息、Codex 每轮）：这段输出摊到上一段用量到这一段之间，最长算 90 秒；
// - 只有流式字数的（pi、API）：字数增量 ÷ 4 当作 token；
// - 回放时还知道每个任务最后的总用量：没被上面两种算到的部分，摊到这个任务各个事件之间的空档上（"回放估算"）。

const WINDOW = 10000, SEG_MAX = 90000, CHARS_PER_TOKEN = 4;
const FINAL = new Map(); // run id → 回放结束时的 run 消息（总用量）
const FINAL_EV = new Map(); // 车道 id → 回放的全部事件（估算速度用，不随回放进度变化）

// 回放：取一次结束时的快照，拿到每个任务最后的用量
function loadFinals() {
  if (window.__BOARD_FIXTURE__ || B.clock.mode !== 'replay' || loadFinals.started) return;
  loadFinals.started = true;
  const gen = loadFinals.gen, q = scopeQuery();
  q.set('t', '100000000');
  fetch(`snapshot?${q}`).then((r) => r.json()).then((s) => {
    if (gen !== loadFinals.gen) return; // 回来时已经换了对话：丢掉
    for (const r of s.runs) FINAL.set(r.id, r);
    for (const ev of s.events) { const id = ev.lane || ev.run; if (!FINAL_EV.has(id)) FINAL_EV.set(id, []); FINAL_EV.get(id).push(ev); }
    for (const list of FINAL_EV.values()) list.sort((a, b) => a.ts - b.ts);
    for (const lane of B.lanes) lane.segs = null;
    B.version++;
  }).catch(() => {});
}

// 用量统一成 { input(未命中缓存), cached, cache_write, output }；v1 的 input 含缓存部分
function usageOf(r) {
  const u = r && r.usage;
  if (!u) return null;
  if ('cache_write' in u) return { input: u.input || 0, cached: u.cached || 0, cache_write: u.cache_write || 0, output: u.output || 0 };
  return { input: Math.max(0, (u.input || 0) - (u.cached || 0)), cached: u.cached || 0, cache_write: 0, output: u.output || 0 };
}

// 一条车道的输出分段：[{ a, b, tokens }]，a/b 是记录时间（毫秒）
function segments(lane) {
  const events = FINAL_EV.get(lane.id) || lane.events;
  if (lane.segs && lane.segsAt === events.length) return lane.segs;
  const segs = [];
  const lastUsage = new Map(), lastChars = {};
  const counted = new Map(); // run id → 已经由分段用量或字数算到的 token
  const starts = new Map(lane.runs.map((r) => [r.id, r.started_at]));
  // 一段时间里的 token 按其中事件的空档摊开：模型在两次动作之间生成，单个空档最多算 60 秒（跑命令的长空档不会吃掉全部）
  const spread = (run, a, b, tokens, est) => {
    if (!(tokens > 0) || !(b > a)) return;
    counted.set(run, (counted.get(run) || 0) + tokens);
    const times = [a, ...events.filter((e) => e.run === run && e.k !== 'usage' && e.ts > a && e.ts < b).map((e) => e.ts), b];
    const gaps = [];
    for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) gaps.push({ b: times[i], w: Math.min(times[i] - times[i - 1], 60000) });
    const total = gaps.reduce((s, g) => s + g.w, 0);
    for (const g of gaps) segs.push({ a: g.b - g.w, b: g.b, tokens: (tokens * g.w) / total, est });
  };
  for (const ev of events) {
    if (ev.k === 'usage' && ev.u && ev.u.out != null) {
      // Claude Code 每条消息一份用量，最长算 90 秒；协作方一轮一份（Codex），从这一轮开始算起
      const prev = lastUsage.get(ev.run) ?? (lane.id === 'cc' ? ev.ts - 20000 : starts.get(ev.run) ?? ev.ts - 20000);
      spread(ev.run, lane.id === 'cc' ? Math.max(prev, ev.ts - SEG_MAX) : prev, ev.ts, ev.u.out, false);
      lastUsage.set(ev.run, ev.ts);
    } else if ((ev.k === 'think' || ev.k === 'answer') && ev.n != null) {
      const key = `${ev.run}:${ev.k}`, prev = lastChars[key];
      if (prev && ev.n > prev.n) spread(ev.run, prev.ts, ev.ts, (ev.n - prev.n) / CHARS_PER_TOKEN, false);
      lastChars[key] = { ts: ev.ts, n: ev.n };
    }
  }
  // 回放估算：最终总输出减去已经算到的，摊到这个任务从开始到结束的空档上
  for (const r of lane.runs) {
    const f = usageOf(FINAL.get(r.id));
    if (!f) continue;
    const rest = f.output - (counted.get(r.id) || 0);
    const end = FINAL.get(r.id).ended_at || r.ended_at;
    if (rest > 0 && end != null) spread(r.id, r.started_at, end, rest, true);
  }
  segs.sort((x, y) => x.a - y.a);
  lane.segs = segs;
  lane.segsAt = events.length;
  return segs;
}

// 时刻 t 前 WINDOW 内的平均输出速度（token/秒）
function rateAt(lane, t, win = WINDOW) {
  let tokens = 0;
  for (const s of segments(lane)) {
    if (s.a >= t) break;
    const lo = Math.max(s.a, t - win), hi = Math.min(s.b, t);
    if (hi > lo) tokens += (s.tokens * (hi - lo)) / (s.b - s.a);
  }
  return tokens / (win / 1000);
}

// 最近 span 毫秒的速度曲线，n 个点
function sparkline(lane, t, span = 120000, n = 40) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(rateAt(lane, t - (i * span) / n, span / n * 2));
  return out;
}

// 一条车道到时刻 t 的统计：已结束的任务用最终用量，进行中的按分段估到 t
function laneStats(lane, t) {
  const sum = { input: 0, cached: 0, cache_write: 0, output: 0 };
  let cost = 0, costKnown = false, costEquiv = false, est = false;
  let gen = 0, first = null, last = null, running = false;
  for (const r of lane.runs) {
    if (r.started_at > t) continue;
    first = Math.min(first ?? r.started_at, r.started_at);
    const ended = r.ended_at != null && r.ended_at <= t;
    last = Math.max(last ?? 0, ended ? r.ended_at : t);
    if (!ended) running = true;
    // Claude Code 的 run 消息随每条消息的用量更新，进行中也能直接用
    const live = r.kind === 'host';
    const u = ended || live ? usageOf(r) || (ended ? usageOf(FINAL.get(r.id)) : null) : null;
    if (u) for (const k in sum) sum[k] += u[k];
    const c = ended ? (r.cost_usd ?? FINAL.get(r.id)?.cost_usd) : live ? r.cost_usd : null;
    if (c != null) { cost += c; costKnown = true; if ((r.cost_source || FINAL.get(r.id)?.cost_source) === 'api_equiv') costEquiv = true; }
  }
  // 进行中的输出：分段里 t 之前的部分
  let liveOut = 0;
  for (const s of segments(lane)) {
    if (s.a >= t) break;
    const runOpen = lane.runs.some((r) => r.started_at <= s.b && (r.ended_at == null || r.ended_at > t));
    if (!runOpen) continue;
    liveOut += (s.tokens * (Math.min(s.b, t) - s.a)) / (s.b - s.a);
    if (s.est) est = true;
  }
  for (const s of segments(lane)) { if (s.a >= t) break; gen += Math.min(s.b, t) - s.a; if (s.est) est = true; }
  const hostLive = lane.runs.some((r) => r.kind === 'host');
  const out = sum.output + (running && !hostLive ? liveOut : 0);
  return {
    ...sum, output: out, cost: costKnown ? cost : null, costEquiv, est, running,
    rate: rateAt(lane, t), avg: gen > 0 ? out / (gen / 1000) : null,
    elapsed: first != null ? (last - first) / 1000 : 0,
  };
}

// 速度 → 光束亮度 0..1（对数，10 tok/s 约 0.35，150 tok/s 到顶）
const glow = (rate) => Math.max(0, Math.min(1, Math.log1p(rate) / Math.log1p(150)));
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
