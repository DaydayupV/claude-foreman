'use strict';
// 宇宙层的数据：本机所有对话的摘要、项目、协作方名额（PROTOCOL-v3 §5–§7）。
// 只存数据和"什么时候变的"，画面每帧按 uNow() 从这里取；?demo=universe 时由 02-uni-demo.js 喂数据，不连服务。

const U = {
  on: true, // 只有一个总前端：页面总带宇宙层，单个对话的看板是飞进去以后的样子
  demo: Q.get('demo') === 'universe',
  page: { ...B.params },  // 打开页面时的参数（速度、回放、定格时刻）；飞进对话时 B.params 会被换掉，这里留一份
  hello: null,
  projects: new Map(),    // key → project
  sessions: new Map(),    // id → summary
  agents: [],
  marks: new Map(),       // id → { born, state, stateAt, prev, runs: Map(run id → { born, ended }) }，给动效用的变化时刻
  version: 0,
  done: false,
  error: null,
  clock: { mode: 'live', start: 0, end: Infinity, speed: 1, perf0: 0, frozenAt: null },
};

// 宇宙层的"现在"（记录时间，毫秒）。和 now() 同一套规则，但用自己的时钟：飞进某个对话前，看板的时钟还没开始
function uNow() {
  const c = U.clock;
  if (c.frozenAt != null) return c.frozenAt;
  // 回放放完就停在末尾（和看板的 now() 一样），飞进去时两边的时钟才对得上
  if (c.mode === 'replay') return Math.min(c.end, c.start + (performance.now() - c.perf0) * c.speed);
  return Date.now();
}

function uHello(h) {
  U.hello = h;
  const c = U.clock;
  c.mode = h.mode;
  if (h.replay) Object.assign(c, { start: h.replay.start, end: h.replay.end ?? Infinity, speed: h.replay.speed || 1 });
  c.perf0 = performance.now();
  if (B.params.t != null) c.frozenAt = h.replay ? h.replay.start + B.params.t * 1000 * (h.replay.speed || 1) : h.now;
}

function uUniverse(u) {
  U.projects.clear(); U.sessions.clear(); U.marks.clear();
  for (const p of u.projects) U.projects.set(p.key, p);
  for (const s of u.sessions) uSession(s, true);
  U.agents = u.agents;
  U.loadedAt ??= performance.now(); // 第一份完整星图到了：之后还找不到要飞进去的对话，就提示它不在图上
  U.version++;
}

// 记下状态和运行的变化时刻；first 为真时是整份重来（刚连上），不算"新出现"，免得一打开满屏都在播出生动画
function uSession(s, first = false) {
  const t = uNow();
  let m = U.marks.get(s.id);
  if (!m) { m = { born: first ? -Infinity : t, state: s.state, stateAt: first ? -Infinity : t, prev: null, runs: new Map(), alert: s.alert?.run ?? null, alertAt: -Infinity }; U.marks.set(s.id, m); }
  if (m.state !== s.state) { m.prev = m.state; m.state = s.state; m.stateAt = t; }
  if ((s.alert?.run ?? null) !== m.alert) { m.alert = s.alert?.run ?? null; if (m.alert) m.alertAt = t; }
  const listed = new Set();
  for (const r of s.runs) {
    listed.add(r.id);
    let rm = m.runs.get(r.id);
    if (!rm) { rm = { born: first ? Math.min(t, r.started_at) : t, ended: null }; m.runs.set(r.id, rm); }
    if (r.ended_at != null && rm.ended == null) rm.ended = first ? r.ended_at : Math.max(t, r.ended_at);
  }
  for (const id of [...m.runs.keys()]) if (!listed.has(id)) m.runs.delete(id);
  U.sessions.set(s.id, s);
  if (!first) U.version++;
}

function uGone({ id }) { U.sessions.delete(id); U.marks.delete(id); U.version++; }
function uProject(p) { U.projects.set(p.key, p); U.version++; }
function uAgents({ agents }) { U.agents = agents; U.version++; }

function connectUniverse() {
  if (U.demo) return playDemo();
  const q = new URLSearchParams({ level: 'all' });
  // 给了回放范围（不管是 all 还是某个组、任务、对话）都回放整个宇宙，看板飞进去以后接着同一个时钟
  if (B.params.replay != null) q.set('replay', 'all');
  for (const k of ['speed', 'maxgap']) if (B.params[k] != null) q.set(k, B.params[k]);
  if (B.params.t != null) {
    q.set('t', String(B.params.t));
    fetch(`sessions?${q}`).then((r) => r.json()).then((u) => { uHello({ v: 3, level: 'all', mode: 'live', now: u.now, replay: null }); U.clock.frozenAt = u.now; uUniverse(u); })
      .catch((e) => { U.error = String(e); });
    return;
  }
  const es = new EventSource(`stream?${q}`);
  const on = (name, fn) => es.addEventListener(name, (e) => fn(JSON.parse(e.data)));
  on('hello', uHello);
  on('universe', uUniverse);
  on('session', (s) => uSession(s));
  on('session_gone', uGone);
  on('project', uProject);
  on('agents', uAgents);
  on('done', () => { U.done = true; U.version++; });
  es.onopen = () => { U.error = null; };
  es.onerror = () => { U.error = es.readyState === 2 ? 'closed' : 'reconnecting'; };
}

// 对话按项目归组，组内按最后活动时间排，给布局和列表用
function sessionsByProject() {
  const out = new Map();
  for (const s of U.sessions.values()) {
    if (!out.has(s.project)) out.set(s.project, []);
    out.get(s.project).push(s);
  }
  for (const list of out.values()) list.sort((a, b) => b.last_at - a.last_at);
  return out;
}
