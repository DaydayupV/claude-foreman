'use strict';
// 车道事件 → 对话流的行，照 watch 的时间线：模型说的话是节点（◆），读、搜、改、命令挂在竖线下面，
// 两句话之间超过 3 个动作折叠成一行；最新的思考单独放在卡片底行。

const MAX_ACTIONS = 3;
const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || String(p || '');
const EDIT_MARKS = { update: '✎', write: '✎', add: '+', delete: '−' };

function editParts(t) {
  const m = /^(\w+)\s+(.*)$/.exec(String(t || ''));
  return m ? { kind: m[1], path: m[2] } : { kind: 'update', path: String(t || '') };
}

const laneModel = (id) => { const l = B.laneById.get(id); const r = l && l.runs[l.runs.length - 1]; return r ? shortModel(r.model) : id; };
const shortModel = (m) => String(m || '').split('/').pop();

const displayPoints = () => B.clock.mode === 'replay' ? B.hello?.replay?.time_map : null;
const currentRun = (lane, t) => lane.id === 'cc' ? latest(lane) : lane.runs.filter((r) => r.started_at <= t).at(-1);
const roundOf = (lane, t) => { const r = currentRun(lane, t); return r ? Display.roundOf(Display.displayRun(r).meta, new Map(lane.runs.map((x) => [x.id, x]))) : 1; };
function laneElapsed(lane, t, total = false) {
  const runs = lane.runs.filter((r) => r.started_at <= t && r.kind !== 'answer');
  const last = lane.events.filter((e) => e.run === 'cc' && e.ts <= t).at(-1);
  const activity = last ? last.original_ts ?? Display.recordedTime(last.ts, displayPoints()) : null;
  return (total ? runs : runs.slice(-1)).reduce((n, r) => n + Display.elapsedOf(r, t, displayPoints(), activity), 0);
}
function liveState(lane, r, t) {
  const state = { speech: null, thought: null, recent: [], kinds: {}, api: {} };
  const byAid = new Map();
  let seq = 0, command = null;
  for (const ev of lane.events) {
    if (ev.run !== r.id || ev.ts > t) continue;
    seq++;
    if (ev.k === 'req') state.api = { req: ev.original_ts ?? Display.recordedTime(ev.ts, displayPoints()) };
    else if (ev.k === 'queued') state.api.queued = true;
    else if (ev.k === 'think' || ev.k === 'answer') {
      state.api.queued = false; state.api.answering = ev.k === 'answer';
      if (ev.t) state.thought = { text: Display.thoughtLine(ev.t), seq };
    } else if (ev.k === 'msg') state.speech = { text: ev.t, seq };
    // 并行命令按编号配对；旧记录没有编号时仍挂到最近一条命令。
    else if (ev.k === 'cmd_done') { const action = ev.aid != null ? byAid.get(ev.aid) : command; if (action && ev.ok === false) action.tag = '✗ failed'; }
    else {
      const line = lineOf(ev);
      if (!line || !line.cls.startsWith('act') || ['end', 'report'].includes(ev.k)) continue;
      const kind = ({ cmd: 'command', read: 'read', search: 'search', web: 'search', edit: 'edit', image: 'image' })[ev.k] || 'other';
      const action = { kind, text: line.text };
      if (ev.k === 'cmd') { command = action; if (ev.aid != null) byAid.set(ev.aid, action); }
      state.recent.push(action); state.kinds[kind] = (state.kinds[kind] || 0) + 1;
    }
  }
  if (!state.api.req && r.queued && !state.speech && !state.recent.length) state.api.queued = true;
  return state;
}
// 已经结束的任务，状态只随"后来有没有续接"变：直播时按任务对象缓存（任务记录一更新，页面就换成新对象）。
// 正在跑的才需要扫这一轮的事件看是在排队、思考还是回答；结束了的不扫
const SEAT_STATES = new WeakMap();
function seatStatus(lane, r, t) {
  if (!r) return { style: Display.outcomeStyle({ status: 'not_started' }), right: ['not started'], kind: 'not_started' };
  const ended = r.ended_at != null && r.ended_at <= t, resumed = ended && lane.runs.some((x) => x.parent === r.id && x.started_at <= t);
  const cache = ended && B.clock.mode === 'live', hit = cache && SEAT_STATES.get(r);
  if (hit && hit.resumed === resumed) return hit.state;
  const run = Display.displayRun(r);
  const result = ended || r.kind === 'answer' ? run.result : { status: 'running' };
  const outcome = Display.resultOutcome(result, run.meta);
  outcome.resumed = resumed;
  const meta = { ...run.meta, started_at: r.original_started_at ?? Display.recordedTime(r.started_at, displayPoints()),
    ended_at: ended ? r.original_ended_at ?? Display.recordedTime(r.ended_at, displayPoints()) : null,
    submitted_at: r.submitted_at ?? r.original_started_at ?? run.meta.submitted_at };
  const state = Display.seatState(meta, result, outcome.running ? liveState(lane, r, t).api : {}, Display.recordedTime(t, displayPoints()), undefined, outcome);
  if (cache) SEAT_STATES.set(r, { resumed, state });
  return state;
}

// 用量保留在结尾，JSON 报告只在完成时显示，避免重复正文。
function lineOf(ev) {
  const t = ev.t || '';
  switch (ev.k) {
    case 'prompt': return { cls: 'user', text: t };
    case 'msg': return { cls: 'node', text: t };
    case 'report': return null;
    case 'end': return { cls: ev.t === 'done' ? 'node' : 'node bad', text: Display.D.statusName(t) };
    case 'cmd': return { cls: 'act', text: Display.commandAction({ command: t, plain: true }).text, cmd: true, kind: 'command' };
    case 'read': case 'search': return { cls: 'act', text: Display.commandAction({ category: ev.k, label: t }).text, kind: ev.k };
    case 'web': return { cls: 'act', text: `◎ ${t}`, kind: 'search' };
    case 'edit': { const e = editParts(t); return { cls: 'act', text: `${EDIT_MARKS[e.kind] || '✎'} ${e.path}`, kind: 'edit' }; }
    case 'plan': return { cls: 'node', text: `◇ plan ${t}` };
    case 'image': return { cls: 'act', text: ev.viewed ? `◉ ${Display.D.watchImageViewed(t)}` : `▣ ${Display.D.watchImage(t)}`, kind: 'image' };
    case 'req': { const r = B.runs.get(ev.run); return { cls: 'node', text: Display.D.watchApiRequest(t, r?.effort, ev.n) }; }
    case 'queued': return { cls: 'node', text: `⋯ ${Display.D.watchApiQueued}` };
    case 'retry': return { cls: 'act bad', text: `⚠ ${Display.D.watchApiRetry(t)}` };
    case 'error': { const a = Display.errorAction(t); return { cls: 'act bad', text: `${a.mark} ${a.text}` }; }
    case 'tool': return { cls: 'act', text: `· ${t}` };
    case 'dispatch': return { cls: 'act link', text: `⇢ ${t}${targets(ev)}` };
    case 'collect': return { cls: 'act link', text: `⇠ ${t || 'read results'}${targets(ev)}` };
    case 'returned': return { cls: 'act link', text: `⇠ result back${targets(ev)}` };
    default: return null;
  }
}
const targets = (ev) => (ev.target && ev.target.length ? ` → ${ev.target.map(laneModel).join(', ')}` : '');

// 对话流：到时刻 t 为止的行。open 为真时返回全部，否则只要最后 limit 行。
function timeline(lane, t, { open = false, limit = 6 } = {}) {
  const byAid = new Map(), entries = [];
  let lastCmd = null;
  // 并行命令按轮次和编号配对；旧记录没有编号时保留最近命令的老做法。
  // 先配对再折叠，上一段折起后才收到的失败也能露出来。
  for (const ev of lane.events) {
    if (ev.ts > t) break;
    if (ev.k === 'cmd_done') {
      const command = ev.aid != null ? byAid.get(`${ev.run}:${ev.aid}`) : lastCmd;
      if (command && ev.ok === false) { command.text += '  ✗ failed'; command.cls += ' bad'; }
      continue;
    }
    const line = lineOf(ev);
    if (line?.cmd) { lastCmd = line; if (ev.aid != null) byAid.set(`${ev.run}:${ev.aid}`, line); }
    entries.push({ ev, line });
  }
  const lines = [];
  let block = [];
  const flush = (closed) => {
    if (block.length > MAX_ACTIONS) {
      // 已经过去的一段留前几条（和 watch 一样），正在进行的一段留最新几条
      const kept = closed ? block.slice(0, MAX_ACTIONS) : block.slice(-MAX_ACTIONS);
      const folded = closed ? block.slice(MAX_ACTIONS) : block.slice(0, -MAX_ACTIONS), foldedLines = [];
      let counts = {};
      const pushFold = () => { if (Object.keys(counts).length) foldedLines.push({ cls: 'act fold', text: Display.foldText(counts) }); };
      // 和终端一样，失败动作单独显示，前后的折叠各自计数。
      for (const line of folded) {
        if (line.cmd && line.cls.includes(' bad')) { pushFold(); foldedLines.push(line); counts = {}; }
        else counts[line.kind || 'other'] = (counts[line.kind || 'other'] || 0) + 1;
      }
      pushFold();
      lines.push(...(closed ? [...kept, ...foldedLines] : [...foldedLines, ...kept]));
    } else lines.push(...block);
    block = [];
  };
  for (const { ev, line } of entries) {
    if (ev.k === 'end') {
      const r = lane.runs.find((r) => r.id === ev.run);
      if (r) {
        flush(true);
        const st = seatStatus(lane, r, t), run = Display.displayRun(r);
        lines.push({ ts: ev.original_ts ?? Display.recordedTime(ev.ts, displayPoints()), cls: 'node', text: `└ ${st.style.mark} ${st.right.filter(Boolean).join(' ')}` });
        const usage = Display.usageLine(run.result, run.meta);
        if (usage) lines.push({ cls: 'act', text: usage });
        lines.push(...conclusion(r));
        continue;
      }
    }
    if (!line) continue;
    line.ts = ev.original_ts ?? Display.recordedTime(ev.ts, displayPoints());
    if (line.cls.startsWith('act')) block.push(line);
    else { flush(true); lines.push(line); }
  }
  flush(false);
  return open ? lines : lines.slice(-limit);
}

// 终端区的颜色和终端一致：用和 format.mjs 一样的颜色代码调 display.mjs，fillTerm（06-cards.js）再把颜色代码换成带色的片段
const TERM_C = Object.fromEntries([['dim', '2'], ['bold', '1'], ['red', '31'], ['green', '32'], ['yellow', '33'], ['cyan', '36']]
  .map(([key, code]) => [key, (s) => (s === '' ? s : `\x1b[${code}m${s}\x1b[0m`)]));
function conclusion(r, width = Infinity) {
  const run = Display.displayRun(r), o = Display.resultOutcome(run.result, run.meta);
  return Display.finalLines(run, run.result, run.meta.participant === 'host' || o.ok || o.partial, width, TERM_C)
    .map((text) => ({ ts: r.original_ended_at ?? r.ended_at, cls: 'plain', text }));
}

// 卡片底行：最新的思考或正在写的回答，过了 90 秒（记录时间）就不再显示
function thinkingLine(lane, t) {
  for (let i = lane.events.length - 1; i >= 0; i--) {
    const ev = lane.events[i];
    if (ev.ts > t) continue;
    if (t - ev.ts > 90000) return '';
    if (ev.k === 'think') return ev.t ? `✻ ${ev.t}` : '✻ thinking…';
    if (ev.k === 'answer') return `✎ writing answer · ${ev.n || 0} chars`;
    if (ev.k === 'msg' || ev.k === 'end' || ev.k === 'report') return '';
  }
  return '';
}

// 计划里还没启动的席位：排着队、或者计划刚建好（30 分钟内）且从没排过队时画成虚影；
// 排过队又离开了队列（取消、过期、派发失败）或者放了很久还没人启动，就不再画，免得这一组永远留在画面上
const PLAN_IDLE = 30 * 60000; // 记录时间
function seatWaiting(plan, seat, since, t) {
  const tickets = (ev) => (ev.tickets || []).some((q) => q.plan === plan && (seat == null || q.seat === seat));
  const snaps = (B.laneById.get('dispatch_queue')?.events || []).filter((e) => e.ts <= t);
  if (snaps.length && tickets(snaps.at(-1))) return true;
  return !snaps.some(tickets) && t - since < PLAN_IDLE;
}
// 一份计划还要不要占终端区：有任何任务（包括 Claude Code 席的报告），或者还有席位在等
function planAlive(ev, t) {
  if ([...B.runs.values()].some((r) => r.plan === ev.plan && r.started_at <= t)) return true;
  return seatWaiting(ev.plan, null, ev.ts, t);
}
