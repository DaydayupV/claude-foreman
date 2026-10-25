import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptOf, toolsOf } from './claude-feed.mjs';
import { queuedRuns } from '../records.mjs';
import { resultOutcome } from '../display.mjs';
import { ms, transient, stat, json, newTail, readLines, append, runMessage, laneOf, settleRun,
  usageTotals, hostCost, costFields, createFeed, buildReplay, replayClock, usageReader, keepUsage } from './feed.mjs';

const keyOf = (cwd) => cwd ? cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '?';
// git worktree 归到主仓库：Claude Code 自己开的 .claude/worktrees/<名字> 看路径就知道（删掉以后也认得）；
// 别处的 worktree 看目录里的 .git 文件指向哪个仓库。每个目录只查一次
const roots = new Map();
export function projectRoot(cwd) {
  if (!cwd) return null;
  if (!roots.has(cwd)) {
    // Windows 路径不分大小写，.CLAUDE\WORKTREES 也要认
    let root = cwd.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/i)?.[1] ?? null;
    // 网络路径（\\server\share）不去读：连不上时同步读会卡住整个看板服务
    if (!root && !/^[\\/]{2}/.test(cwd)) {
      try {
        const gitdir = fs.readFileSync(path.join(cwd, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
        root = gitdir ? path.resolve(cwd, gitdir).match(/^(.*?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/i)?.[1] ?? null : null;
      } catch { /* .git 是目录（普通仓库）、不存在或读不了：就是这个目录本身 */ }
    }
    roots.set(cwd, root || cwd);
  }
  return roots.get(cwd);
}
// 对话的项目看它启动时的目录：之后 cd 到子目录或别的地方，记录里的 cwd 会跟着变，但对话还是那个项目的
const projectOf = (session) => projectRoot(session.root ?? session.cwd);
const list = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (!transient(e)) throw e; return []; } };

// Claude 桌面版的对话列表：桌面版给每个对话存一份元数据（<数据目录>/claude-code-sessions/<组织>/<账号>/local_*.json，
// 里面有 cliSessionId 和 isArchived；删掉的对话留一个 deleted_<id> 文件）。在桌面版里归档或删掉的对话，宇宙里也不列，
// 和桌面版的对话列表一致。只读这两个字段；找不到这些文件（只用命令行、格式变了）就全部照列。
// 数据目录：插件装在桌面版里时就在插件路径的上面几层（…/Claude-Data/claude_xxx/rpm/…），
// 另外看各系统的默认位置（Windows 的 %APPDATA%\Claude 和商店版的 %LOCALAPPDATA%\Claude-Data\*，macOS、Linux 的 Claude 目录）
export function desktopRoots() {
  const out = [], add = (dir) => { const p = path.join(dir, 'claude-code-sessions'); if (!out.includes(p) && stat(p)?.isDirectory()) out.push(p); };
  for (let dir = path.dirname(fileURLToPath(import.meta.url)), i = 0; i < 12; i++) { add(dir); const up = path.dirname(dir); if (up === dir) break; dir = up; }
  const home = os.homedir(), local = process.env.LOCALAPPDATA;
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'Claude'));
  if (local) for (const d of list(path.join(local, 'Claude-Data')).filter((d) => d.isDirectory())) add(path.join(local, 'Claude-Data', d.name));
  add(path.join(home, 'Library', 'Application Support', 'Claude'));
  add(path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude'));
  return out;
}
// 桌面版对话的元数据：归档或删掉的对话（hidden，Claude Code 会话 id 的集合），以及先前的对话记录归到哪个对话（aliases：旧 id → 现在的 id）。
// 桌面版重启或恢复对话时，Claude Code 会换一个会话 id、另起一份对话记录，旧 id 记在 priorCliSessionIds 里；
// 不合起来的话，同一个对话会在星图上出现两次，旧记录里派出的任务也看不到了。归档的对话连同先前的记录一起隐藏。
// 每 5 秒（真实时钟）重列一次目录，元数据文件没变就不重读
export function desktopSessions(roots, clock = Date.now) {
  // cache：元数据文件 → 上次读到的结果；byDir：目录 → 上次从它得出的隐藏 id。
  // 一时读不了（被占用、没权限）的目录和文件沿用上次的结果，不让已归档的对话闪回来
  const cache = new Map(), byDir = new Map();
  const listed = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (!transient(e)) throw e; return null; } };
  let at = -Infinity, state = { hidden: new Set(), aliases: new Map() };
  return () => {
    if (!roots.length || clock() - at < 5000) return state;
    at = clock();
    const next = new Set(), aliases = new Map(), dirs = new Set();
    const merge = (found) => { found.hidden.forEach((id) => next.add(id)); for (const [prior, id] of found.aliases) aliases.set(prior, id); };
    const reuse = (prefix) => { for (const [dir, found] of byDir) if (dir === prefix || dir.startsWith(prefix + path.sep)) { dirs.add(dir); merge(found); } };
    const subdirs = (dir) => { const all = listed(dir); if (!all) reuse(dir); return (all || []).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); };
    for (const root of roots) for (const org of subdirs(root)) for (const dir of subdirs(org)) {
      const entries = listed(dir);
      if (!entries) { reuse(dir); continue; }
      const found = { hidden: new Set(), aliases: new Map() };
      for (const entry of entries) {
        if (entry.name.startsWith('deleted_')) { found.hidden.add(entry.name.slice(8)); continue; }
        if (!entry.isFile() || !/^local_.+\.json$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name), st = stat(file);
        const sig = st && `${st.size}:${st.mtimeMs}`;
        if (sig && cache.get(file)?.sig !== sig) {
          const value = json(file);
          // 正在写的文件读出来是坏的：沿用上次读到的
          if (value) cache.set(file, { sig, cli: typeof value.cliSessionId === 'string' ? value.cliSessionId : null, archived: value.isArchived === true,
            prior: Array.isArray(value.priorCliSessionIds) ? value.priorCliSessionIds.filter((id) => typeof id === 'string' && id !== value.cliSessionId) : [] });
        }
        const item = cache.get(file);
        if (!item?.cli) continue;
        if (item.archived) for (const id of [item.cli, ...item.prior]) found.hidden.add(id);
        else for (const id of item.prior) found.aliases.set(id, item.cli);
      }
      byDir.set(dir, found); dirs.add(dir);
      merge(found);
      const present = new Set(entries.map((e) => path.join(dir, e.name)));
      for (const file of cache.keys()) if (path.dirname(file) === dir && !present.has(file)) cache.delete(file);
    }
    for (const dir of byDir.keys()) if (!dirs.has(dir)) { byDir.delete(dir); for (const file of cache.keys()) if (path.dirname(file) === dir) cache.delete(file); }
    state = { hidden: next, aliases };
    return state;
  };
}
// 只要隐藏的那部分
export function desktopHidden(roots, clock = Date.now) {
  const read = desktopSessions(roots, clock);
  return () => read().hidden;
}
const runKeys = ['id', 'lane', 'kind', 'agent', 'model', 'group', 'plan', 'seat', 'role', 'title', 'status', 'started_at', 'ended_at', 'queued'];
const pickRun = (run) => Object.fromEntries(runKeys.map((key) => [key, run[key]]));
// 这个对话用过哪些模型、各输出了多少（星图里星系的星云按它上色，页面上的 08-uni-galaxy.js）：同一个协作方和模型合在一起，按输出量排，留前六个
function modelMix(runs) {
  const by = new Map();
  for (const r of runs) {
    if (r.kind === 'answer' || !r.model) continue;
    const key = `${r.agent ?? ''}|${r.model}`, m = by.get(key) || { agent: r.agent ?? null, model: r.model, out: 0, running: false };
    m.out += r.usage?.output ?? r.usage?.output_tokens ?? 0; m.running ||= r.status === 'running';
    by.set(key, m);
  }
  return [...by.values()].sort((a, b) => b.out - a.out).slice(0, 6);
}
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
  return { id, file, folder, tail: newTail(), title: null, firstPrompt: null, model: null, cwd: null, root: null,
    started_at: null, last_at: null, last: null, promptAt: -Infinity, cwdAt: -Infinity, rootAt: Infinity, modelAt: -Infinity, tools: new Map(), usage: new Map() };
}
function addEntry(session, entry) {
  if (entry.title != null) session.title = entry.title;
  const at = entry.at;
  if (!Number.isFinite(at)) return;
  session.started_at = Math.min(session.started_at ?? at, at);
  if (session.last_at == null || at >= session.last_at) { session.last_at = at; session.last = { type: entry.type, stop: entry.stop }; }
  if (entry.cwd && at >= session.cwdAt) { session.cwd = entry.cwd; session.cwdAt = at; }
  if (entry.cwd && at < session.rootAt) { session.root = entry.cwd; session.rootAt = at; }
  if (entry.type === 'assistant' && entry.model && at >= session.modelAt) { session.model = entry.model; session.modelAt = at; }
  if (entry.prompt) { session.firstPrompt ??= entry.firstPrompt; session.promptAt = Math.max(session.promptAt, at); }
  for (const tool of entry.uses || []) session.tools.set(tool.id, { tool: tool.tool, since: at, header: tool.header });
  for (const id of entry.results || []) session.tools.delete(id);
  if (entry.usage) session.usage.set(entry.usage.id, entry.usage);
  else if (entry.messageId) session.usage.delete(entry.messageId);
}
function readSession(session) {
  // 未打开的对话只留累计值、用量去重键和未回答工具，不保留记录或消息正文；边读边累计，不攒成数组
  const read = readLines(session.file, session.tail, (row) => { const entry = entryOf(row); if (entry) addEntry(session, entry); }, (tail) => {
    // 在新文件的第一行累计前清空旧状态，空文件也必须清空。
    session = { ...newSession(session.id, session.file, session.folder), tail };
  });
  session.tail = read.tail;
  return session;
}
function queueOf(raw, state) {
  if (raw.type?.startsWith('api.')) { state.queued = raw.type === 'api.queued'; state.since = state.queued ? ms(raw.ts) : null; }
  else if (raw.type === 'pi.progress' || raw.type?.startsWith('item.')) { state.queued = false; state.since = null; }
}
export function stateOf(session, runs, now, queued = []) {
  const tools = [...session.tools.values()], waiting = tools.find((t) => ['AskUserQuestion', 'ExitPlanMode'].includes(t.tool)) || null;
  // 等待用户优先于派发；end_turn 只关闭最近消息带来的思考状态。
  const state = waiting ? 'waiting' : queued.length || runs.some((r) => r.status === 'running') ? 'dispatching'
    : now - session.last_at < 90000 && !(session.last?.type === 'assistant' && session.last.stop === 'end_turn')
      || tools.some((t) => now - t.since < 600000) ? 'thinking' : 'idle';
  return { state, waiting };
}
// 输入和输出都明确是 0（一次请求都没完成）；没报用量的不算（和 board/web/04-rates.js 同一条规则）
// 宇宙表的问题点：同一个组里前后相隔不超过这么久的任务算同一批（见 summaryOf 的 batchStart）
const BATCH_GAP = 10 * 60000;
const zeroUsage = (u) => !!u && u.input === 0 && u.output === 0 && Object.values(u).every((v) => v === 0 || v == null);
// 星图里一行是这个对话的全部（和飞进去的看板同一个口径）：派过的任务、Claude Code 的用量和费用都不按时间窗口截；
// 时间窗口只决定哪些对话列出来
function summaryOf(session, all, now, prices, meter, waiting = []) {
  const own = all.filter((r) => r.session === session.id && !r.host);
  const queued = waiting.filter((q) => q.claude_session === session.id);
  // 同一席后来又有了新一轮（同一条车道上续接的，或同一份计划同一席重新启动的；重启的任务不一定带 parent，车道会换）
  const unitOf = (r) => r.group ?? r.plan ?? r.lane ?? r.id, laneOf = (r) => r.lane ?? r.id;
  const sameSeat = (a, b) => laneOf(a) === laneOf(b) || a.plan != null && a.seat != null && a.plan === b.plan && a.seat === b.seat;
  const superseded = (r) => own.some((x) => x !== r && x.started_at > r.started_at && sameSeat(x, r));
  // 没做成、但已经续接或重启过的不算失败（和 status 的"已续接"一样），比如取消以后又续接成功的
  // 正常结束却没交回合格报告的（no_result）和看板一样按失败算
  const failed = (r) => r.status !== 'running' && (r.status !== 'done' || r.no_result);
  const counts = { running: 0, done: 0, failed: 0 };
  for (const run of own) {
    const kind = run.status === 'running' ? 'running' : !failed(run) ? 'done' : superseded(run) ? null : 'failed';
    if (kind) counts[kind]++;
  }
  const runs = own.filter((r) => r.status === 'running' || r.ended_at >= now - 600000)
    .sort((a, b) => b.started_at - a.started_at || a.id.localeCompare(b.id)).slice(0, 16).map(meter?.pick ?? pickRun);
  const usage = meter ? null : [...session.usage.values()], costs = [...own];
  if (meter ? meter.count : usage.length) {
    const priced = {}, cost = meter ? meter.cost : hostCost(usage, prices, priced);
    costs.push(costFields(cost, cost == null ? 'unknown' : 'api_price'));
    // 有的消息算不出价：能算的照算，另外记一笔未知，费用后面带 +
    if (cost != null && (meter ? meter.partial : priced.partial)) costs.push(costFields(null, 'unknown'));
  }
  const cost = costs.some((c) => c.cost_usd != null) ? costs.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0) : null;
  const failure = own.filter((r) => failed(r) && r.ended_at != null && r.ended_at >= now - 1800000 && !superseded(r))
    .sort((a, b) => b.ended_at - a.ended_at)[0];
  const alert = failure && session.promptAt <= failure.ended_at ? { kind: failure.no_result ? 'no_result' : failure.status, run: failure.id, model: failure.model, at: failure.ended_at } : null;
  // 还在进行的组里出了问题的席位（超时、失败、被停止……），宇宙表的状态列每席画一个点；
  // 后来又有了新一轮的不算（superseded）。整组都结束以后不再列
  const live = new Set(own.filter((r) => r.status === 'running' || queued.some((q) => q.group != null
    ? q.group === r.group : q.plan != null && q.plan === r.plan)).map(unitOf));
  // 每个还在进行的组现在这一批从哪里开始：从还在跑的任务和排队票往前接，前后相隔不超过 BATCH_GAP 的都算同一批。
  // 只列这一批里出了问题的席位：同一个对话很久以后又用了同一个组名时，旧的失败不再亮；进行中用户又发了消息、
  // 或者失败以后过一会儿又在同组派了新的，这一批的失败照样亮
  const batchStart = new Map(), ticketOf = (q, r) => (q.group != null ? q.group === r.group : q.plan != null && q.plan === r.plan);
  for (const unit of live) {
    const runs = own.filter((r) => unitOf(r) === unit);
    const tickets = queued.filter((q) => runs.some((r) => ticketOf(q, r)) && Number.isFinite(ms(q.queued_at)));
    let start = Math.min(...runs.filter((r) => r.status === 'running').map((r) => r.started_at), ...tickets.map((q) => ms(q.queued_at)));
    const ended = runs.filter((r) => r.status !== 'running' && r.ended_at != null);
    for (let grew = true; grew;) { grew = false; for (const r of ended) if (r.ended_at >= start - BATCH_GAP && r.started_at < start) { start = r.started_at; grew = true; } }
    batchStart.set(unit, start);
  }
  // 超过 12 个时留最新的 12 个，仍按结束的先后排
  const issues = own.filter((r) => failed(r) && r.ended_at != null && r.ended_at >= (batchStart.get(unitOf(r)) ?? Infinity) && live.has(unitOf(r))
    && !superseded(r))
    .sort((a, b) => b.ended_at - a.ended_at).slice(0, 12).reverse().map((r) => ({ status: r.no_result ? 'no_result' : r.status, run: r.id, model: r.model }));
  const state = stateOf(session, runs, now, queued);
  return { id: session.id, project: keyOf(projectOf(session)), cwd: session.cwd, title: session.title ?? session.firstPrompt, model: session.model,
    // prompt_at：最近一条用户消息的时间，宇宙列表里进行中的对话按它排（新的在上），不随动静跳来跳去
    state: state.state, waiting: state.waiting, started_at: session.started_at, last_at: session.last_at, prompt_at: Number.isFinite(session.promptAt) ? session.promptAt : null, runs, counts,
    // 还在跑的运行没有费用、有的模型不在价格表里：能算的照样加起来，另外标出不完整，不让整份变成未知；
    // 用量明确记成全 0 的（一次请求都没完成）没有可算的费用，不算不完整（和单对话视图同一条规则）
    usage: meter ? meter.totals : usageTotals(usage), cost_usd: cost, cost_partial: costs.some((c) => c.cost_usd == null && !zeroUsage(c.usage)), alert, issues,
    models: modelMix(own) };
}

function equalReplay(a, b) {
  if (typeof a === 'number' && !Number.isFinite(a)) a = null;
  if (typeof b === 'number' && !Number.isFinite(b)) b = null;
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => equalReplay(a[key], b[key]));
}
function replayMeter(prices, pick) {
  let totals = usageTotals([]), sum = 0, unknown = 0, count = 0, dirty = false;
  const costs = new WeakMap(), fields = [['in', 'input'], ['cached', 'cached'], ['cache_write', 'cache_write'], ['out', 'output']];
  const add = (usage) => {
    for (const [key, name] of fields) {
      if (usage.u[key] != null) totals[name] = (totals[name] ?? 0) + usage.u[key];
    }
    const cost = costs.get(usage); sum += cost ?? 0; unknown += cost == null ? 1 : 0; count++;
  };
  return {
    entry(session, entry) {
      const id = entry.usage?.id ?? entry.messageId;
      if (id && session.usage.has(id)) dirty = true;
      addEntry(session, entry);
      if (entry.usage) { costs.set(entry.usage, hostCost([entry.usage], prices)); if (!dirty) add(entry.usage); }
    },
    at(session) {
      // 替换消息时按 Map 原序重加，避免减法改变原有浮点结果。
      if (dirty) {
        totals = usageTotals([]); sum = 0; unknown = 0; count = 0;
        for (const usage of session.usage.values()) add(usage);
        dirty = false;
      }
      return { totals: { ...totals }, cost: count && unknown < count ? sum : null, partial: unknown > 0, count, pick };
    },
  };
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
  for (const session of sessions) put(projectOf(session));
  for (const [folder, count] of older) put(projectRoot(folders.get(folder)?.cwd ?? null)).older += count;
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
  const desktop = options.desktop ?? desktopSessions(options.desktopRoots ?? []);
  const listings = new Map();
  // 先前的对话记录超出了时间窗口、不在 sessions 里的，用量另外读（服务端和看板共用这个读取器的缓存）
  const transcriptUsage = options.transcriptUsage ?? usageReader();
  // 每个对话的用量合计和费用：对话记录读到哪儿没变就沿用，不每一拍都把全部消息重算一遍
  const sums = new Map();
  const meterOf = (session) => {
    let hit = sums.get(session.id);
    if (hit?.sig !== session.sig) {
      const list = [...session.usage.values()], priced = {}, cost = list.length ? hostCost(list, options.prices, priced) : null;
      hit = { sig: session.sig, meter: { totals: usageTotals(list), cost, partial: !!priced.partial, count: list.length, pick: pickRun } };
      sums.set(session.id, hit);
    }
    return hit.meter;
  };
  let dirs = [], listedAt = -Infinity;
  let runNames = new Set(), runsScannedAt = -Infinity;
  let config;
  try { config = JSON.parse(fs.readFileSync(options.config, 'utf8')); } catch { /* 读不到配置就视为没有 */ }
  // 只列四个模块（讨论、执行、审查、图像）的格子里用到的协作方；别的协作方只在它正在跑时出现（agentSlots 会补上）。
  // 老配置没有 modules 时照旧全列
  const inModules = new Set();
  const collect = (v) => { if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') { if (typeof v.agent === 'string') inModules.add(v.agent); else Object.values(v).forEach(collect); } };
  collect(config?.modules);
  config = Object.entries(config?.agents || {}).filter(([id]) => !inModules.size || inModules.has(id))
    .map(([id, value]) => ({ id, type: value.type ?? null, max_parallel: value.max_parallel ?? 4 }));
  const readRuns = (now) => {
    const names = new Set(list(options.runs).filter((d) => d.isDirectory() && d.name !== 'plans').map((d) => d.name));
    const full = now - runsScannedAt >= 30000 || names.size !== runNames.size || [...names].some((id) => !runNames.has(id));
    if (full) { runNames = names; runsScannedAt = now; }
    for (const id of runs.keys()) if (!names.has(id)) runs.delete(id);
    for (const id of names) {
      // 缺结果的结束任务也会冻结；目录变化或每三十秒补查一次，捡回迟到的结果。
      if (runs.get(id)?.settled && (runs.get(id).result != null || !full)) continue;
      const run = runs.get(id) || { id, dir: path.join(options.runs, id), signatures: {}, tail: newTail() };
      for (const name of ['meta', 'result']) {
        const file = path.join(run.dir, `${name}.json`), st = stat(file), signature = st && `${st.size}:${st.mtimeMs}`;
        if (signature && signature !== run.signatures[name]) {
          const value = json(file);
          // 结果只留几项；报告本身不留，只留它算出的有没有交回合格报告（valid），星图按它把没交回的算失败
          if (value) { run[name] = name === 'result' ? { ...Object.fromEntries(['status', 'duration_s', 'usage', 'usage_scope', 'cost_usd', 'cost_source', 'model', 'agent_type', 'needs_decision'].filter((k) => k in value).map((k) => [k, value[k]])), valid: resultOutcome(value, run.meta).valid } : value; run.signatures[name] = signature; }
        }
      }
      if (!run.meta) continue;
      settleRun(run);
      // 排队状态只对还在跑的运行有意义，结束了的不读事件流
      if (run.meta.status === 'running') {
        const read = readLines(path.join(run.dir, 'events.jsonl'), run.tail); run.tail = read.tail;
        for (const raw of read.lines) if (Number.isFinite(ms(raw.ts))) queueOf(raw, run.tail.state);
      } else run.tail.state.queued = false;
      const ended = ms(run.meta.ended_at);
      run.settled = run.meta.status !== 'running' && (run.result != null || run.meta.participant === 'host' || ended != null && now - ended > 300000);
      run.message = null;
      runs.set(id, run);
    }
    return [...runs.values()].map((run) => {
      // 基线结果可能迟到，累计用量不能沿用缺基线时缓存的消息。
      if (run.result?.usage_scope === 'session_total') run.message = null;
      return run.message ??= { ...runMessage(run, laneOf(run, runs), options.prices, runs, { display: false }),
        session: run.meta.claude_session, host: run.meta.participant === 'host', since: run.tail.state.since ?? null };
    });
  };
  const read = (now = options.now?.() ?? Date.now()) => {
    const cutoff = now - hours * 3600000, found = new Set(), older = new Map(), oldFiles = new Map();
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
        if (item.mtime < cutoff) { older.set(dir, (older.get(dir) || 0) + 1); oldFiles.set(id, file); continue; }
        active = true;
        let session = sessions.get(id) || newSession(id, file, dir);
        session = readSession(session); sessions.set(id, session); found.add(id);
        const known = folders.get(dir);
        // 文件夹按对话启动时的目录命名，旧对话的计数跟着启动目录走
        if (session.root && (!known || session.cwdAt >= known.at)) folders.set(dir, { cwd: session.root, at: session.cwdAt });
        if (session.last_at != null && session.last_at < cutoff) older.set(dir, (older.get(dir) || 0) + 1);
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
    const { hidden, aliases } = desktop();
    // 同一个对话先前的对话记录（桌面版重启、恢复后换了会话 id）并进现在的那一份：不单独列，它派出的任务和 Claude Code 的用量
    // 算到现在这个对话上（用量按消息 id 去重，几份记录之间抄过来的消息不重算，抄过来时用量写成 0 的那份不算，见 keepUsage）。先前的记录超出时间窗口的也算（星图一行是对话的全部）。
    // 现在那一份还没有（还没写出来、超出时间窗口）时照常单独列
    const merged = new Map();
    for (const [prior, id] of aliases) if ((sessions.has(prior) || oldFiles.has(prior)) && sessions.get(id)?.last_at != null) merged.set(prior, id);
    const view = (session) => {
      const priors = [...merged].filter(([, id]) => id === session.id).map(([prior]) => prior);
      const sig = [session, ...priors.map((p) => sessions.get(p))].map((x) => x ? `${x.tail.version}:${x.tail.offset}:${x.usage.size}` : 'old').join('|');
      if (!priors.length) return { ...session, sig };
      const usage = new Map();
      let started = session.started_at ?? Infinity;
      for (const prior of priors) {
        const known = sessions.get(prior);
        for (const entry of known ? known.usage.values() : transcriptUsage(oldFiles.get(prior))) { keepUsage(usage, entry); if (entry.ts < started) started = entry.ts; }
        if (known?.started_at != null) started = Math.min(started, known.started_at);
      }
      for (const entry of session.usage.values()) keepUsage(usage, entry);
      return { ...session, usage, sig, started_at: Number.isFinite(started) ? started : session.started_at };
    };
    // 排队目录一时读不了（别的进程正在建、删票据，或者被占用）：这一拍按没有票据算，不让整份星图读不出来
    let waiting = [];
    try { waiting = queuedRuns(null, options.runs); } catch { /* 下一拍再读 */ }
    const all = readRuns(now).map((r) => merged.has(r.session) ? { ...r, session: merged.get(r.session) } : r);
    const selected = [...sessions.values()].filter((s) => s.last_at != null && s.last_at >= cutoff && !hidden.has(s.id) && !merged.has(s.id)).sort((a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id)).slice(0, 200);
    const summaries = selected.map((s) => { const v = view(s); return summaryOf(v, all, now, options.prices, meterOf(v), waiting); });
    for (const id of sums.keys()) if (!sessions.has(id)) sums.delete(id);
    return { v: 3, now, window_h: hours, projects: projectsOf([...selected].sort((a, b) => b.cwdAt - a.cwdAt), older, folders), sessions: summaries,
      // 名额和对话列表同一个口径：桌面版里归档、删掉的对话，它的任务不占"同时运行"的格子（不然点了飞不进去）
      agents: agentSlots(config, hidden.size ? all.filter((r) => !hidden.has(r.session)) : all) };
  };
  const hello = (now, replay = null) => ({ v: 3, level: 'all', mode: replay ? 'replay' : 'live', now, window_h: hours, replay });
  const replay = (params = {}, now = options.now?.() ?? Date.now()) => {
    // 回放在独立的调试进程里构建，慢一点不卡直播。真实的长对话常有一百多 MB：112 MB 的真实对话 2.1 秒、峰值 380 MB；
    // 用量特别密的合成对话最慢，32 MiB 约十秒。256 MiB 覆盖现有的真实对话，又不至于把内存撑爆
    const limit = options.replayLimitBytes ?? 256 * 1048576, cutoff = now - hours * 3600000;
    const wanted = params.sessions == null ? null : new Set(params.sessions), files = new Map(), older = new Map(), knownFolders = new Map();
    const indexed = new Map(), entries = new Map(), queues = new Map(), oldHeads = [];
    let bytes = 0;
    const check = () => { if (bytes > limit) throw Object.assign(new Error('replay too large'), { code: 'REPLAY_TOO_LARGE', bytes, limit }); };
    for (const folder of list(options.claudeDir).filter((d) => d.isDirectory())) {
      const dir = path.join(options.claudeDir, folder.name), old = [];
      let active = false;
      for (const name of list(dir).filter((d) => d.isFile() && d.name.endsWith('.jsonl'))) {
        const id = name.name.slice(0, -6);
        if (wanted && !wanted.has(id)) continue;
        const file = path.join(dir, name.name), st = stat(file);
        if (!st) continue;
        if (!wanted && st.mtimeMs < cutoff) { older.set(dir, (older.get(dir) || 0) + 1); old.push({ file, at: st.mtimeMs }); continue; }
        active = true; files.set(id, file); bytes += st.size;
      }
      if (!active && old.length) oldHeads.push([dir, old.sort((a, b) => b.at - a.at || a.file.localeCompare(b.file))[0].file]);
    }
    const dataById = createFeed(options.runs, options).replay(files, now, (runs) => {
      // 构建时还会读裁决和派发计划：一起算进构建量，同一份计划只算一次
      const plans = new Set();
      for (const run of runs) {
        for (const name of ['meta.json', 'result.json', 'events.jsonl', 'verdict.json']) bytes += stat(path.join(run.dir, name))?.size ?? 0;
        if (typeof run.meta?.plan === 'string') plans.add(run.meta.plan);
      }
      for (const plan of plans) bytes += stat(path.join(options.runs, 'plans', `${plan}.json`))?.size ?? 0;
      check();
      for (const [dir, file] of oldHeads) knownFolders.set(dir, { cwd: readCwd(file), at: -Infinity });
    }, (id, file, records) => {
      const session = newSession(id, file, path.dirname(file)), own = [];
      for (const row of records) { const entry = entryOf(row); if (entry) { addEntry(session, entry); own.push(entry); } }
      const known = knownFolders.get(session.folder);
      if (session.root && (!known || session.cwdAt >= known.at)) knownFolders.set(session.folder, { cwd: session.root, at: session.cwdAt });
      if (!wanted && session.last_at != null && session.last_at < cutoff) older.set(session.folder, (older.get(session.folder) || 0) + 1);
      if (session.last_at == null || !wanted && session.last_at < cutoff) return false;
      indexed.set(id, session); entries.set(id, own); return true;
    }, (run, raw) => {
      if (!queues.has(run.id)) queues.set(run.id, { state: {}, sources: [] });
      const queue = queues.get(run.id), before = { ...queue.state }; queueOf(raw, queue.state);
      if (!equalReplay(before, queue.state) && Number.isFinite(ms(raw.ts))) queue.sources.push({ time: ms(raw.ts), queue: { id: run.id, ...queue.state } });
    });
    const selected = [...indexed.values()].sort((a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id)).slice(0, wanted ? Infinity : 200);
    const projects = projectsOf([...selected].sort((a, b) => b.cwdAt - a.cwdAt), older, knownFolders), sources = [], times = [];
    for (const session of selected) {
      let prompted = false;
      for (const entry of entries.get(session.id)) {
        entry.at ??= session.started_at;
        if (!Number.isFinite(entry.at)) continue;
        if (prompted) delete entry.firstPrompt;
        prompted ||= entry.prompt;
        sources.push({ time: entry.at, id: session.id, entry });
      }
      const data = dataById.get(session.id), invalid = new Set(data.runs.filter((r) => !Number.isFinite(r.started_at)).map((r) => r.id));
      for (const run of data.runs) if (!invalid.has(run.id)) { times.push(run.started_at); times.push(run.kind === 'host' ? data.hostEnd : run.ended_at); }
      for (const event of data.events) if (!invalid.has(event.run)) times.push(event.ts);
      for (const run of data.runs.filter((r) => r.id !== 'cc' && r.kind !== 'answer' && Number.isFinite(r.started_at))) {
        const { display, ...summary } = run;
        const final = { ...summary, session: session.id, host: false, since: null };
        sources.push({ time: run.started_at, id: session.id, run: { ...final, status: 'running', ended_at: null, usage: null, ...costFields(null, 'unknown'), queued: false } });
        if (Number.isFinite(run.ended_at)) sources.push({ time: run.ended_at, id: session.id, run: final });
        for (const source of queues.get(run.id)?.sources || []) sources.push({ ...source, id: session.id });
      }
    }
    const selectedIds = new Set(selected.map((s) => s.id));
    for (const id of dataById.keys()) if (!selectedIds.has(id)) dataById.delete(id);
    for (const session of selected) session.usage.clear();
    append(times, sources.map((s) => s.time));
    const clock = replayClock(times, params, now), active = new Map(), running = new Map(), ownRuns = new Map(), meters = new Map();
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
      projects: projects.filter((p) => !selected.some((s) => keyOf(projectOf(s)) === p.key)), sessions: [], agents: agentSlots(config, []) }, timeline = [];
    const ticks = new Map();
    for (const source of sources) for (const delay of [90000, 600000, 600001, 1800001, hours * 3600000 + 1]) if (source.time + delay <= clock.replay.end) {
      const time = source.time + delay;
      if (!ticks.has(time)) ticks.set(time, new Set());
      ticks.get(time).add(source.id);
    }
    const schedule = [...steps.values(), ...[...ticks].map(([time, dirty]) => ({ time, original: Infinity, sources: [], dirty }))].sort((a, b) => a.time - b.time || a.original - b.original);
    const deadlines = schedule.filter((step) => step.dirty);
    let expired = 0;
    steps.clear(); ticks.clear(); entries.clear(); indexed.clear(); queues.clear(); sources.length = 0; times.length = 0;
    const summaries = new Map(), projectState = new Map(initial.projects.map((p) => [p.key, p])), agentRuns = new Map();
    // 摘要里的任务字段未变就共享，避免每条对话记录都复制同一组席位。
    const picked = new WeakMap(), pick = (run) => { if (!picked.has(run)) picked.set(run, pickRun(run)); return picked.get(run); };
    let agents = initial.agents;
    const order = (a, b) => b.last_at - a.last_at || a.id.localeCompare(b.id);
    for (const step of schedule) {
      const at = step.time, dirty = new Set(step.dirty), dirtyAgents = new Set();
      // 压缩时钟可能落在小数毫秒；严格大于阈值的失效要赶上下一步，不能等 +1 ms tick。
      while (expired < deadlines.length && deadlines[expired].time - 1 < at) {
        for (const id of deadlines[expired].dirty) dirty.add(id);
        deadlines[expired++] = null;
      }
      let projectsDirty = false;
      for (const source of step.sources) {
        dirty.add(source.id);
        if (source.entry) {
          if (!active.has(source.id)) { active.set(source.id, newSession(source.id)); meters.set(source.id, replayMeter(options.prices, pick)); projectsDirty = true; }
          const session = active.get(source.id), root = projectOf(session);
          meters.get(source.id).entry(session, source.entry);
          if (root !== projectOf(session) || projectState.get(keyOf(projectOf(session)))?.cwd !== projectOf(session)) projectsDirty = true;
        } else {
          let run = source.run ?? running.get(source.queue.id);
          if (!run) continue;
          if (!source.run) run = { ...run, queued: !!source.queue.queued, since: source.queue.since };
          running.set(run.id, run);
          if (!ownRuns.has(source.id)) ownRuns.set(source.id, new Map());
          ownRuns.get(source.id).set(run.id, run);
          if (run.agent) {
            dirtyAgents.add(run.agent);
            if (!agentRuns.has(run.agent)) agentRuns.set(run.agent, new Map());
            agentRuns.get(run.agent).set(run.id, run);
          }
        }
      }
      const changed = [], gone = [];
      for (const id of dirty) {
        const session = active.get(id), before = summaries.get(id);
        if (!session) continue;
        if (session.last_at < at - hours * 3600000) { if (before) { gone.push(before); summaries.delete(id); projectsDirty = true; } continue; }
        if (!before) projectsDirty = true;
        const next = summaryOf(session, [...(ownRuns.get(id)?.values() || [])], at, options.prices, meters.get(id).at(session));
        if (before) for (const key of ['runs', 'counts', 'usage', 'waiting', 'alert']) if (equalReplay(before[key], next[key])) next[key] = before[key];
        if (!equalReplay(before, next)) { summaries.set(id, next); changed.push(next); }
      }
      for (const session of gone.sort(order)) timeline.push({ time: at, event: 'session_gone', data: { id: session.id } });
      if (projectsDirty) {
        const next = projectsOf([...active.values()].sort((a, b) => b.cwdAt - a.cwdAt), new Map(), new Map());
        for (const project of next) {
          project.older = (projects.find((p) => p.key === project.key)?.older ?? 0) + [...active.values()].filter((s) => keyOf(projectOf(s)) === project.key && s.last_at < at - hours * 3600000).length;
          if (!equalReplay(projectState.get(project.key), project)) timeline.push({ time: at, event: 'project', data: project });
        }
        projectState.clear(); for (const project of next) projectState.set(project.key, project);
      }
      for (const session of changed.sort(order)) timeline.push({ time: at, event: 'session', data: session });
      if (dirtyAgents.size) {
        const next = new Map(agents.map((a) => [a.id, a]));
        for (const id of dirtyAgents) {
          const configured = config.find((a) => a.id === id), own = [...agentRuns.get(id).values()].filter((r) => r.status === 'running');
          if (!configured && !own.length) next.delete(id);
          else next.set(id, agentSlots([configured ?? { id, type: null, max_parallel: 4 }], own)[0]);
        }
        const ordered = [...config.map((a) => next.get(a.id)), ...[...next.values()].filter((a) => !config.some((c) => c.id === a.id)).sort((a, b) => a.id.localeCompare(b.id))];
        if (!equalReplay(agents, ordered)) { agents = ordered; timeline.push({ time: at, event: 'agents', data: { agents } }); }
      }
      // 已播放的来源不再需要，及时释放，避免和最终时间线同时占满内存。
      step.sources.length = 0; step.dirty = null;
    }
    const details = new Map();
    const result = { hello: hello(now, clock.replay), initial, timeline, clock,
      detail(id) {
        if (!dataById.has(id)) return null;
        if (!details.has(id)) details.set(id, buildReplay(dataById.get(id), { clock }, now));
        return details.get(id);
      } };
    return result;
  };
  // 星图已经读过的对话记录里 Claude Code 每条消息的用量（看板算先前记录的用量时借用）；没读过的给 null
  const usageOf = (id) => sessions.has(id) ? [...sessions.get(id).usage.values()] : null;
  return { read, hello, replay, usageOf };
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
