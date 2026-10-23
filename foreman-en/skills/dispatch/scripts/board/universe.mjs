import fs from 'node:fs';
import path from 'node:path';
import { promptOf, toolsOf } from './claude-feed.mjs';
import { ms, transient, stat, json, newTail, readLines, runMessage, laneOf, settleRun,
  usageTotals, hostCost, costFields, createFeed, buildReplay, replayClock } from './feed.mjs';

const keyOf = (cwd) => cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '?';
const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (!transient(e)) throw e; return []; } };
const runKeys = ['id', 'lane', 'kind', 'agent', 'model', 'group', 'plan', 'seat', 'role', 'title', 'status', 'started_at', 'ended_at', 'queued'];
const pickRun = (run) => Object.fromEntries(runKeys.map((key) => [key, run[key]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function entryOf(row) {
  if (row.isSidechain || !['user', 'assistant', 'custom-title'].includes(row.type)) return null;
  if (row.type === 'custom-title') return { type: row.type, at: ms(row.timestamp), title: row.customTitle, cwd: row.cwd };
  const at = ms(row.timestamp);
  if (!Number.isFinite(at)) return null;
  const message = row.message || {}, u = message.usage, tools = toolsOf(row), prompt = promptOf(row);
  return { type: row.type, at, cwd: row.cwd, model: message.model, stop: message.stop_reason,
    prompt: !!prompt, firstPrompt: prompt?.slice(0, 60), ...tools,
    messageId: row.type === 'assistant' ? message.id : null,
    usage: row.type === 'assistant' && message.id && u ? { id: message.id, ts: at, t: message.model,
      u: { in: u.input_tokens ?? null, cached: u.cache_read_input_tokens ?? null, cache_write: u.cache_creation_input_tokens ?? null, out: u.output_tokens ?? null } } : null };
}
function newSession(id, file, folder) {
  return { id, file, folder, tail: newTail(), title: null, firstPrompt: null, model: null, cwd: null,
    started_at: null, last_at: null, last: null, promptAt: -Infinity, cwdAt: -Infinity, modelAt: -Infinity, tools: new Map(), usage: new Map() };
}
function addEntry(session, entry) {
  if (entry.title != null) session.title = entry.title;
  const at = entry.at;
  if (!Number.isFinite(at)) return;
  session.started_at = Math.min(session.started_at ?? at, at);
  if (session.last_at == null || at >= session.last_at) { session.last_at = at; session.last = { type: entry.type, stop: entry.stop }; }
  if (entry.cwd && at >= session.cwdAt) { session.cwd = entry.cwd; session.cwdAt = at; }
  if (entry.type === 'assistant' && entry.model && at >= session.modelAt) { session.model = entry.model; session.modelAt = at; }
  if (entry.prompt) { session.firstPrompt ??= entry.firstPrompt; session.promptAt = Math.max(session.promptAt, at); }
  for (const tool of entry.uses || []) session.tools.set(tool.id, { tool: tool.tool, since: at, header: tool.header });
  for (const id of entry.results || []) session.tools.delete(id);
  if (entry.usage) session.usage.set(entry.usage.id, entry.usage);
  else if (entry.messageId) session.usage.delete(entry.messageId);
}
function readSession(session) {
  // 文件被截短（重写）时从头再来；要在读之前判断，读的同时就在往 session 里累计
  const st = stat(session.file);
  if (st && session.tail.offset > st.size) session = { ...newSession(session.id, session.file, session.folder), tail: newTail(session.tail.version + 1) };
  // 未打开的对话只留累计值、用量去重键和未回答工具，不保留记录或消息正文；边读边累计，不攒成数组
  const target = session;
  session.tail = readLines(session.file, session.tail, (row) => { const entry = entryOf(row); if (entry) addEntry(target, entry); }).tail;
  return session;
}
function queueOf(raw, state) {
  if (raw.type?.startsWith('api.')) { state.queued = raw.type === 'api.queued'; state.since = state.queued ? ms(raw.ts) : null; }
  else if (raw.type === 'pi.progress' || raw.type?.startsWith('item.')) { state.queued = false; state.since = null; }
}
export function stateOf(session, runs, now) {
  const tools = [...session.tools.values()], waiting = tools.find((t) => ['AskUserQuestion', 'ExitPlanMode'].includes(t.tool)) || null;
  // 等待用户优先于派发；end_turn 只关闭最近消息带来的思考状态。
  const state = waiting ? 'waiting' : runs.some((r) => r.status === 'running') ? 'dispatching'
    : now - session.last_at < 90000 && !(session.last?.type === 'assistant' && session.last.stop === 'end_turn')
      || tools.some((t) => now - t.since < 600000) ? 'thinking' : 'idle';
  return { state, waiting };
}
function summaryOf(session, all, now, hours, prices) {
  const cutoff = now - hours * 3600000, own = all.filter((r) => r.session === session.id && !r.host);
  const counted = own.filter((r) => r.started_at >= cutoff), counts = { running: 0, done: 0, failed: 0 };
  for (const run of counted) counts[run.status === 'running' ? 'running' : run.status === 'done' ? 'done' : 'failed']++;
  const runs = own.filter((r) => r.status === 'running' || r.ended_at >= now - 600000)
    .sort((a, b) => b.started_at - a.started_at || a.id.localeCompare(b.id)).slice(0, 16).map(pickRun);
  const usage = [...session.usage.values()].filter((u) => u.ts >= cutoff), costs = [...counted];
  if (usage.length) { const cost = hostCost(usage, prices); costs.push(costFields(cost, cost == null ? 'unknown' : 'api_price')); }
  const cost = costs.some((c) => c.cost_usd != null) ? costs.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0) : null;
  const failure = own.filter((r) => r.status !== 'running' && r.status !== 'done' && r.ended_at != null && r.ended_at >= now - 1800000)
    .sort((a, b) => b.ended_at - a.ended_at)[0];
  const alert = failure && session.promptAt <= failure.ended_at ? { kind: failure.status, run: failure.id, model: failure.model, at: failure.ended_at } : null;
  return { id: session.id, project: keyOf(session.cwd), cwd: session.cwd, title: session.title ?? session.firstPrompt, model: session.model,
    ...stateOf(session, runs, now), started_at: session.started_at, last_at: session.last_at, runs, counts,
    // 还在跑的运行没有费用、有的模型不在价格表里：能算的照样加起来，另外标出不完整，不让整份变成未知
    usage: usageTotals(usage), cost_usd: cost, cost_partial: costs.some((c) => c.cost_usd == null), alert };
}
export function agentSlots(config, runs) {
  const agents = new Map(config.map((agent) => [agent.id, { ...agent, running: [], queued: [] }]));
  for (const run of [...runs].sort((a, b) => a.id.localeCompare(b.id))) if (!run.host && run.status === 'running' && run.agent) {
    if (!agents.has(run.agent)) agents.set(run.agent, { id: run.agent, type: null, max_parallel: 4, running: [], queued: [] });
    const agent = agents.get(run.agent), slot = { run: run.id, session: run.session ?? null };
    agent.running.push(slot);
    if (run.queued) agent.queued.push({ ...slot, since: run.since });
  }
  return [...config.map((a) => agents.get(a.id)), ...[...agents.values()].filter((a) => !config.some((c) => c.id === a.id)).sort((a, b) => a.id.localeCompare(b.id))];
}
function projectsOf(sessions, older, folders) {
  const projects = new Map();
  const put = (cwd) => {
    const key = keyOf(cwd);
    if (!projects.has(key)) projects.set(key, { key, cwd, name: cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').at(-1) : '(unknown)', older: 0 });
    return projects.get(key);
  };
  for (const session of sessions) put(session.cwd);
  for (const [folder, count] of older) put(folders.get(folder)?.cwd ?? null).older += count;
  return [...projects.values()];
}
function readCwd(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(65536), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    for (const line of bytes.subarray(0, count).toString('utf8').split('\n')) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row?.cwd === 'string' && row.cwd) return row.cwd;
    }
    return null;
  } catch (e) { if (!transient(e)) throw e; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function universeChanges(previous, next) {
  const messages = [], emit = (event, data) => messages.push({ event, data });
  for (const session of previous.sessions) if (!next.sessions.some((s) => s.id === session.id)) emit('session_gone', { id: session.id });
  for (const project of next.projects) if (!same(previous.projects.find((p) => p.key === project.key), project)) emit('project', project);
  for (const session of next.sessions) if (!same(previous.sessions.find((s) => s.id === session.id), session)) emit('session', session);
  if (!same(previous.agents, next.agents)) emit('agents', { agents: next.agents });
  return messages;
}

export function createUniverse(options) {
  const hours = options.windowH ?? 24, sessions = new Map(), runs = new Map(), folders = new Map();
  const listings = new Map();
  let dirs = [], listedAt = -Infinity;
  let config;
  try { config = JSON.parse(fs.readFileSync(options.config, 'utf8')); } catch { /* 读不到配置就视为没有 */ }
  config = Object.entries(config?.agents || {}).map(([id, value]) => ({ id, type: value.type ?? null, max_parallel: value.max_parallel ?? 4 }));
  const readRuns = () => {
    const names = new Set(list(options.runs).filter((d) => d.isDirectory() && d.name !== 'plans').map((d) => d.name));
    for (const id of runs.keys()) if (!names.has(id)) runs.delete(id);
    for (const id of names) {
      // 已经结束、结果也读到了的运行不会再变：之后的轮询不再逐个查它的文件（真实运行目录有几百上千个）
      if (runs.get(id)?.settled) continue;
      const run = runs.get(id) || { id, dir: path.join(options.runs, id), signatures: {}, tail: newTail() };
      for (const name of ['meta', 'result']) {
        const file = path.join(run.dir, `${name}.json`), st = stat(file), signature = st && `${st.size}:${st.mtimeMs}`;
        if (signature && signature !== run.signatures[name]) {
          const value = json(file);
          if (value) { run[name] = name === 'result' ? Object.fromEntries(['status', 'duration_s', 'usage', 'usage_scope', 'cost_usd', 'cost_source', 'model', 'agent_type'].filter((k) => k in value).map((k) => [k, value[k]])) : value; run.signatures[name] = signature; }
        }
      }
      if (!run.meta) continue;
      settleRun(run);
      // 排队状态只对还在跑的运行有意义，结束了的不读事件流
      if (run.meta.status === 'running') {
        const read = readLines(path.join(run.dir, 'events.jsonl'), run.tail); run.tail = read.tail;
        for (const raw of read.lines) if (Number.isFinite(ms(raw.ts))) queueOf(raw, run.tail.state);
      } else run.tail.state.queued = false;
      run.settled = run.meta.status !== 'running' && (run.result != null || run.meta.participant === 'host');
      run.message = null;
      runs.set(id, run);
    }
    return [...runs.values()].map((run) => run.message ??= { ...runMessage(run, laneOf(run, runs), options.prices),
      session: run.meta.claude_session, host: run.meta.participant === 'host', since: run.tail.state.since ?? null });
  };
  const read = (now = options.now?.() ?? Date.now()) => {
    const cutoff = now - hours * 3600000, found = new Set(), older = new Map();
    if (now - listedAt >= 2000) {
      dirs = list(options.claudeDir).filter((d) => d.isDirectory()).map((d) => path.join(options.claudeDir, d.name)); listedAt = now;
      for (const dir of listings.keys()) if (!dirs.includes(dir)) { listings.delete(dir); folders.delete(dir); }
    }
    for (const dir of dirs) {
      const st = stat(dir);
      let project = listings.get(dir), refreshed = false;
      // Windows 的目录修改时间按十几毫秒的时钟刻度更新，紧挨着的两次改动常常是同一个值：
      // 目录最近 2 秒（真实时钟）内被改过就每次都重列，安静的目录才只看修改时间
      if (st && (!project || project.mtime !== st.mtimeMs || Date.now() - st.mtimeMs < 2000 || now - project.at >= 30000)) {
        const files = new Map();
        for (const name of list(dir).filter((d) => d.isFile() && d.name.endsWith('.jsonl')).map((d) => d.name)) {
          const file = path.join(dir, name), info = stat(file), previous = project?.files.get(file);
          if (info) files.set(file, { id: name.slice(0, -6), file, mtime: info.mtimeMs, head: previous?.head });
          else if (previous) files.set(file, previous);
        }
        project = { mtime: st.mtimeMs, at: now, files }; listings.set(dir, project); refreshed = true;
      }
      if (!project) continue;
      let active = false;
      // 旧文件的 mtime 留到目录重列时再查，直播只尾读窗口内的已知文件。
      for (const item of project.files.values()) {
        const { id, file } = item;
        if (item.mtime >= cutoff && !refreshed) {
          const info = stat(file);
          if (!info) { if (sessions.has(id)) found.add(id); continue; }
          item.mtime = info.mtimeMs;
        }
        if (item.mtime < cutoff) { older.set(dir, (older.get(dir) || 0) + 1); continue; }
        active = true;
        let session = sessions.get(id) || newSession(id, file, dir);
        session = readSession(session); sessions.set(id, session); found.add(id);
        const known = folders.get(dir);
        if (session.cwd && (!known || session.cwdAt >= known.at)) folders.set(dir, { cwd: session.cwd, at: session.cwdAt });
        if (session.last_at != null && session.last_at < cutoff) older.set(dir, (older.get(dir) || 0) + 1);
        for (const [key, usage] of session.usage) if (usage.ts < cutoff) session.usage.delete(key);
      }
      if (!active && project.files.size) {
        const latest = [...project.files.values()].sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))[0];
        if (latest.mtime >= cutoff) continue;
        if (latest.head?.mtime !== latest.mtime) {
          const cwd = readCwd(latest.file);
          if (cwd !== undefined) latest.head = { mtime: latest.mtime, cwd };
        }
        if (latest.head) folders.set(dir, { cwd: latest.head.cwd, at: -Infinity });
      }
    }
    for (const id of sessions.keys()) if (!found.has(id)) sessions.delete(id);
    const all = readRuns(), selected = [...sessions.values()].filter((s) => s.last_at != null && s.last_at >= cutoff).sort((a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id)).slice(0, 200);
    const summaries = selected.map((s) => summaryOf(s, all, now, hours, options.prices));
    return { v: 3, now, window_h: hours, projects: projectsOf([...selected].sort((a, b) => b.cwdAt - a.cwdAt), older, folders), sessions: summaries, agents: agentSlots(config, all) };
  };
  const hello = (now, replay = null) => ({ v: 3, level: 'all', mode: replay ? 'replay' : 'live', now, window_h: hours, replay });
  const replay = (params = {}, now = options.now?.() ?? Date.now()) => {
    const indexed = read(now), sources = [], times = [], files = new Map(), runIds = new Map();
    for (const summary of indexed.sessions) {
      const session = sessions.get(summary.id); files.set(session.id, session.file);
      let prompted = false;
      for (const row of readLines(session.file, newTail()).lines) {
        const entry = entryOf(row);
        if (!entry) continue;
        entry.at ??= summary.started_at;
        if (!Number.isFinite(entry.at)) continue;
        if (prompted) delete entry.firstPrompt;
        prompted ||= entry.prompt;
        sources.push({ time: entry.at, id: session.id, entry }); times.push(entry.at);
      }
      // 回放只临时展开一个对话来收集明细时刻，正文不会留进宇宙时间线。
      const data = createFeed(options.runs, { ...options, transcript: session.file }).read({ session: session.id, replay: session.id }, now);
      runIds.set(session.id, new Set(data.runs.filter((r) => r.id !== 'cc').map((r) => r.id)));
      times.push(...buildReplay(data, { maxgap: Number.MAX_VALUE }, now).timeline.map((m) => m.time));
      for (const run of data.runs.filter((r) => r.id !== 'cc' && r.kind !== 'answer' && Number.isFinite(r.started_at))) {
        const final = { ...run, session: session.id, host: false, since: null };
        sources.push({ time: run.started_at, run: { ...final, status: 'running', ended_at: null, usage: null, ...costFields(null, 'unknown'), queued: false } });
        if (Number.isFinite(run.ended_at)) sources.push({ time: run.ended_at, run: final });
        const state = {};
        for (const raw of readLines(path.join(options.runs, run.id, 'events.jsonl'), newTail()).lines) {
          const before = { ...state }; queueOf(raw, state);
          if (!same(before, state) && Number.isFinite(ms(raw.ts))) sources.push({ time: ms(raw.ts), queue: { id: run.id, ...state } });
        }
      }
    }
    times.push(...sources.map((s) => s.time));
    const clock = replayClock(times, params, now), active = new Map(), running = new Map();
    const steps = new Map();
    for (const source of sources) {
      const original = source.time;
      source.time = clock.map(source.time);
      if (!steps.has(original)) steps.set(original, { time: source.time, original, sources: [] });
      steps.get(original).sources.push(source);
      if (source.entry) { source.entry.at = source.time; if (source.entry.usage) source.entry.usage.ts = source.time; }
      if (source.run) for (const key of ['started_at', 'ended_at']) if (source.run[key] != null) source.run[key] = clock.map(source.run[key]);
      if (source.queue?.since != null) source.queue.since = clock.map(source.queue.since);
    }
    const initial = { v: 3, now: clock.replay.start, window_h: hours,
      projects: indexed.projects.filter((p) => !indexed.sessions.some((s) => s.project === p.key)), sessions: [], agents: agentSlots(config, []) }, timeline = [];
    const ticks = new Set();
    for (const source of sources) for (const delay of [90000, 600000, 600001, 1800001, hours * 3600000 + 1]) if (source.time + delay <= clock.replay.end) ticks.add(source.time + delay);
    const schedule = [...steps.values(), ...[...ticks].map((time) => ({ time, original: Infinity, sources: [] }))].sort((a, b) => a.time - b.time || a.original - b.original);
    let previous = initial;
    for (const step of schedule) {
      const at = step.time;
      for (const source of step.sources) {
        if (source.entry) {
          if (!active.has(source.id)) active.set(source.id, newSession(source.id));
          addEntry(active.get(source.id), source.entry);
        } else if (source.run) running.set(source.run.id, source.run);
        else if (running.has(source.queue.id)) Object.assign(running.get(source.queue.id), { queued: !!source.queue.queued, since: source.queue.since });
      }
      const summaries = [...active.values()].filter((s) => s.last_at >= at - hours * 3600000)
        .sort((a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id)).map((s) => summaryOf(s, [...running.values()], at, hours, options.prices));
      const next = { ...initial, now: at, projects: projectsOf([...active.values()].sort((a, b) => b.cwdAt - a.cwdAt), new Map(), new Map()).map((p) => ({ ...p,
        older: (indexed.projects.find((old) => old.key === p.key)?.older ?? 0) + [...active.values()].filter((s) => keyOf(s.cwd) === p.key && s.last_at < at - hours * 3600000).length })),
        sessions: summaries, agents: agentSlots(config, [...running.values()]) };
      for (const message of universeChanges(previous, next)) timeline.push({ time: at, ...message });
      previous = next;
    }
    const result = { hello: hello(now, clock.replay), initial, timeline, clock,
      detail(id) {
        if (!files.has(id)) return null;
        const data = createFeed(options.runs, { ...options, transcript: files.get(id) }).read({ session: id, replay: 'all' }, now);
        data.runs = data.runs.filter((r) => r.id === 'cc' || runIds.get(id).has(r.id));
        data.events = data.events.filter((e) => e.run === 'cc' || runIds.get(id).has(e.run));
        return buildReplay(data, { clock }, now);
      } };
    return result;
  };
  return { read, hello, replay };
}

export function universeAt(replay, t = Infinity) {
  // 和看板的 ?t= 一样，超过回放末尾就停在末尾，两边定格在同一刻
  const at = Math.min(replay.hello.replay.end, replay.hello.replay.start + t * 1000 * replay.hello.replay.speed);
  const sessions = new Map(), projects = new Map(replay.initial.projects.map((p) => [p.key, p]));
  let agents = replay.initial.agents;
  for (const message of replay.timeline) {
    if (message.time > at) break;
    if (message.event === 'session') sessions.set(message.data.id, message.data);
    else if (message.event === 'session_gone') sessions.delete(message.data.id);
    else if (message.event === 'project') projects.set(message.data.key, message.data);
    else if (message.event === 'agents') agents = message.data.agents;
  }
  return { ...replay.initial, now: at, sessions: [...sessions.values()].sort((a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id)), projects: [...projects.values()], agents };
}
