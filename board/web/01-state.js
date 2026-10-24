'use strict';
// 数据和时钟：连服务（或读内嵌快照），把 run / ev 消息整理成车道；画面每帧按时钟从这里取数，不在这里画。

const Q = new URLSearchParams(location.search);
const BOARD_REPLAY = window.__BOARD_MODE__ === 'replay', LEGACY_REPLAY = Q.get('replay');
const LIVE_REPLAY_LINK = !BOARD_REPLAY && !window.__BOARD_FIXTURE__ && Q.get('demo') !== 'universe' && (Q.has('replay') || Q.has('from'));
if (LIVE_REPLAY_LINK) {
  // 老链接保留飞入目标，但不能让直播连接带上回放参数。
  Q.delete('replay'); Q.delete('from');
  const url = new URL(location.href); url.search = Q.toString(); history.replaceState(null, '', url);
}
const B = {
  params: {
    group: Q.get('group'), run: Q.get('run'), replay: Q.get('replay'), speed: Q.get('speed'), maxgap: Q.get('maxgap'),
    t: Q.has('t') ? Number(Q.get('t')) : null,
  },
  hello: null,
  runs: new Map(),        // run id → run 消息
  lanes: [],              // 按首次出现的先后
  laneById: new Map(),
  feed: [],               // 所有车道的事件，按时间，最多 FEED_MAX 条
  life: [],               // 派发计划和裁决事件，单独留着不丢（流程动效要从计划建起一直看到裁决）
  prompts: [],            // 用户每条消息的时刻（Claude Code 车道的 prompt 事件），单独留着不随车道事件裁掉：终端区按它分"最近一轮"
  total: 0,               // 收到的事件总数（含已丢掉的）
  connected: false,
  done: false,            // 回放已发完
  error: null,
  version: 0,             // 数据每变一次加一，面板据此决定要不要重画
  clock: { mode: 'live', start: 0, end: 0, speed: 1, perf0: 0, frozenAt: null },
};
// 统计用的事件不带正文，留得多一些；超出时这条车道的平均速度显示 —（分子分母不再覆盖同一段）
const FEED_MAX = 3000, LANE_EVENTS_MAX = 600, RATE_EVENTS_MAX = 20000;

// 现在是记录里的哪个时刻（毫秒）。直播用本机时间（服务在同一台机器上）；回放从连上那一刻起按倍速走；?t= 停在固定时刻。
function now() {
  const c = B.clock;
  if (c.frozenAt != null) return c.frozenAt;
  if (c.mode === 'replay') return Math.min(c.end, c.start + (performance.now() - c.perf0) * c.speed);
  return Date.now();
}

function reset() {
  B.runs.clear(); B.lanes = []; B.laneById.clear(); B.feed = []; B.life = []; B.prompts = []; B.total = 0; B.done = false; B.version++;
}

function onHello(h) {
  reset();
  B.hello = h;
  const c = B.clock;
  c.mode = h.mode;
  if (h.replay) Object.assign(c, { start: h.replay.start, end: h.replay.end, speed: h.replay.speed || 1 });
  c.perf0 = performance.now();
  // 从宇宙层飞进来时（replay=all&from=…），看板的时钟从宇宙层当时的时刻接着走，不从回放开头重来
  if (h.replay && B.params.from != null) c.start = Number(B.params.from);
  if (B.params.t != null) c.frozenAt = h.replay ? Math.min(h.replay.end, h.replay.start + B.params.t * 1000 * (h.replay.speed || 1)) : h.now;
}

function laneFor(id) {
  let lane = B.laneById.get(id);
  if (!lane) {
    lane = { id, idx: B.lanes.length, runs: [], events: [], rate_events: [], last: null, seed: hash(id) };
    B.lanes.push(lane);
    B.laneById.set(id, lane);
  }
  return lane;
}

function onRun(r) {
  B.runs.set(r.id, r);
  const lane = laneFor(r.lane || r.id);
  const at = lane.runs.findIndex((x) => x.id === r.id);
  if (at >= 0) lane.runs[at] = r; else lane.runs.push(r);
  lane.runs.sort((a, b) => a.started_at - b.started_at);
  B.version++;
  wake();
}

function onEv(ev, stats = true) {
  const lane = laneFor(ev.lane || B.runs.get(ev.run)?.lane || ev.run);
  ev.id = B.total++;
  insertByTs(lane.events, ev, LANE_EVENTS_MAX);
  // 展示缓存会截断；另存不含正文的统计边界，保证累计输出和生成时长覆盖同一段。
  if (B.clock.mode === 'live' && stats !== false) {
    const { run, ts, k, u, n, tot, end, usage_from, usage_to } = ev;
    insertByTs(lane.rate_events, { run, ts, k, u, n, tot, end, usage_from, usage_to }, RATE_EVENTS_MAX);
  }
  lane.ver = (lane.ver || 0) + 1;
  insertByTs(B.feed, ev, FEED_MAX);
  // 同一份计划的事件可能再发（内容变了、重连）：按计划 id 只留最新一份
  if (ev.k === 'fplan') B.life = B.life.filter((x) => !(x.k === 'fplan' && x.plan === ev.plan));
  if (ev.k === 'fplan' || ev.k === 'verdict') insertByTs(B.life, ev, Infinity);
  if (ev.k === 'prompt' && Number.isFinite(ev.ts) && !B.prompts.includes(ev.ts)) { B.prompts.push(ev.ts); B.prompts.sort((a, b) => a - b); }
  if (!lane.last || ev.ts >= lane.last.ts) lane.last = ev;
  B.version++;
  wake();
}

// 服务端从头重读了某个任务的记录（文件被替换、截短后重写）：先丢掉这个任务以前的事件，再收新的
function onBacklog(b) {
  if (b.reset) {
    const keep = (ev) => ev.run !== b.run;
    for (const lane of B.lanes) if (lane.events.some((ev) => !keep(ev)) || lane.rate_events.some((ev) => !keep(ev))) {
      lane.events = lane.events.filter(keep); lane.ver = (lane.ver || 0) + 1;
      lane.rate_events = lane.rate_events.filter(keep);
      lane.last = lane.events.reduce((last, ev) => (!last || ev.ts >= last.ts ? ev : last), null);
    }
    B.feed = B.feed.filter(keep); B.life = B.life.filter(keep);
    if (b.run === 'cc') B.prompts = [];
    B.version++;
  }
  b.events.forEach((ev) => onEv(ev, !b.rate_events));
  if (b.rate_events) replaceRateHistory(b.run, b.rate_events);
}

function replaceRateHistory(run, events) {
  const lane = laneFor(B.runs.get(run)?.lane || run);
  lane.rate_events = lane.rate_events.filter((ev) => ev.run !== run);
  for (const ev of events) insertByTs(lane.rate_events, ev, RATE_EVENTS_MAX);
  lane.ver = (lane.ver || 0) + 1; B.version++;
  wake();
}

// 直播里派发事件先到、目标任务后出现时，服务端补发一次 ev_link：给原来那条事件补上 target
function onEvLink(l) {
  const lane = B.laneById.get(B.runs.get(l.run)?.lane || l.run), ev = lane?.events.find((e) => e.ts === l.ts && e.k === l.k);
  if (!ev) return;
  ev.target = l.target;
  B.version++;
  wake();
}

// 事件基本按时间到达，偶尔有先后颠倒（多个任务的回填），从尾部往前找插入点
function insertByTs(list, ev, max) {
  let i = list.length;
  while (i > 0 && list[i - 1].ts > ev.ts) i--;
  list.splice(i, 0, ev);
  if (list.length > max) list.splice(0, list.length - max);
}

function loadSnapshot(s) {
  onHello(s.hello);
  if (B.params.t == null && s.hello.replay) B.clock.frozenAt = s.hello.replay.end; // 内嵌快照没给 t 时停在末尾
  for (const r of s.runs) onRun(r);
  for (const ev of s.events) onEv(ev, !s.rate_events);
  if (s.rate_events) for (const r of s.runs) replaceRateHistory(r.id, s.rate_events.filter((ev) => ev.run === r.id));
  B.connected = true;
}

function scopeQuery() {
  const p = new URLSearchParams();
  for (const k of ['group', 'run', 'replay', 'session', 'from', 'speed', 'maxgap']) if (B.params[k]) p.set(k, B.params[k]);
  return p;
}

const STREAM_STUCK_MS = 8000, STREAM_ASK_MS = 2000;
let streamsReleased = false;
// 同主机连接被别的标签页占满时不一定触发 error，初次连接和断线重连都要计时。
function watchStream(state, es) {
  const wait = () => {
    // 2 秒还没连上：多半是同一浏览器的连接被别的看板标签页占满了，请后台的那些让出来（09-main.js）
    if (es.readyState === 0 && state.askTimer == null) state.askTimer = setTimeout(() => { state.askTimer = null; if (es.readyState === 0 && typeof askForStream === 'function') askForStream(); }, STREAM_ASK_MS);
    if (es.readyState !== 0 || state.stuckTimer != null || state.stuckNoticed) return;
    state.stuckTimer = setTimeout(() => {
      state.stuckTimer = null;
      if (es.readyState !== 0) return;
      state.stuckNoticed = true; showNotice(TEXT.streamStuck);
      // 再问一下服务：直接被拒（网络错误）说明服务已经退出，换成一直留着的提示；超时多半是连接被别的标签页占满，原提示不变
      if (typeof AbortSignal === 'function' && typeof AbortSignal.timeout === 'function') {
        fetch('health', { signal: AbortSignal.timeout(3000) }).catch((e) => { if (e?.name === 'TypeError' && es.readyState === 0) showNotice(TEXT.boardGone, true); });
      }
    }, STREAM_STUCK_MS);
  };
  es.addEventListener('open', () => { clearTimeout(state.stuckTimer); clearTimeout(state.askTimer); state.stuckTimer = state.askTimer = null; state.stuckNoticed = false; });
  es.addEventListener('error', wait);
  wait();
}

function connect() {
  if (window.__BOARD_FIXTURE__) return loadSnapshot(window.__BOARD_FIXTURE__);
  const q = scopeQuery();
  if (B.params.t != null) {
    // 截图用：一次取完，不开长连接（无头浏览器的虚拟时间会被长连接卡住）
    q.set('t', String(B.params.t));
    fetch(`snapshot?${q}`).then((r) => r.json()).then(loadSnapshot).catch((e) => { B.error = String(e); });
    return;
  }
  if (B.es || streamsReleased) return;
  const es = new EventSource(`stream?${q}`);
  B.es = es;
  watchStream(B, es);
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('hello', onHello);
  on('run', onRun);
  on('ev', onEv);
  on('ev_link', onEvLink);
  on('backlog', onBacklog);
  on('done', () => { B.done = true; B.version++; });
  es.onopen = () => { B.connected = true; B.error = null; };
  es.onerror = () => { B.connected = false; B.error = es.readyState === 2 ? 'closed' : 'reconnecting'; };
}

// 换看的对话之前关掉原来的数据流（宇宙层同一时刻只挂一个完整看板）
function disconnect() {
  if (B.es) { B.es.close(); B.es = null; }
  clearTimeout(B.stuckTimer); B.stuckTimer = null; B.stuckNoticed = false;
  B.connected = false; B.error = null;
}

// 字符串 → 32 位种子；同一车道每次画出来一样
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
