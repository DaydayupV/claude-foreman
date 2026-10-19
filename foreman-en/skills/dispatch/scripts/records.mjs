// 记录目录、启动登记锁、准入、活动状态和 watch 启动器。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENTRY, defaultRunsRoot, runsMovedNow, resolveAgentAlias, DEFAULT_AGENT_PARALLEL } from './config.mjs';
import { M, die, pidAlive, sleep, pathKey, clip, oneLine, plainCommand, retryBusy } from './util.mjs';

// 终止标记：cancel 命令和实时查看里按 x 时写进任务的记录目录，运行中的任务看到就停下。
const CANCEL_FILE = 'cancel';
// 没有正常结束的几种状态：会话开始的提醒会列出这样的执行任务，对它们运行 cancel 表示已经处理，不再提醒
const UNFINISHED_STATUSES = ['interrupted', 'quota_exhausted', 'stalled', 'timeout', 'needs_input'];

// 派活的 Claude 会话：Claude Code 运行命令时会带上会话 ID，记进任务元数据。
// 不同会话可能起了同一个组名（比如同一天讨论同一个话题），按组查看时只算同一会话派出的那一批。
const CLAUDE_SESSION = process.env.CLAUDE_CODE_SESSION_ID || null;


let RUNS_ROOT;

// 入口先加载配置，再搬记录目录和重写启动器，保持首次运行的副作用顺序。
function initializeRecords(config) {
  RUNS_ROOT = config.dispatch.runs_dir ? path.resolve(config.dispatch.runs_dir) : defaultRunsRoot();
  if (runsMovedNow) writeWatchLauncher();
}

const isCancelled = (dir) => fs.existsSync(path.join(dir, CANCEL_FILE));
// 终止标记里记下是谁要求终止的：cancel 命令（command）还是实时查看里按 x（watch），结果里照实写。
function requestCancel(dir, by) {
  fs.writeFileSync(path.join(dir, CANCEL_FILE), JSON.stringify({ at: new Date().toISOString(), by }));
}
// 没有标记返回 null；旧版本的标记只写了时间，返回 unknown。
function cancelSource(dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, CANCEL_FILE), 'utf8'); } catch { return null; }
  try { const { by } = JSON.parse(text); return ['command', 'watch'].includes(by) ? by : 'unknown'; } catch { return 'unknown'; }
}

// Microsoft Store 版的 Claude 桌面应用会把对 AppData\Roaming 的写入重定向到 AppData\Local\Packages\<应用>\LocalCache\Roaming：
// 应用里的进程按原路径能找到插件，终端面板里的进程不行。所以启动器里先写实际路径，再写原路径，用第一个存在的。
function writeWatchLauncher() {
  const self = ENTRY;
  let real = self;
  try { real = fs.realpathSync.native(self); } catch { /* 用原路径 */ }
  const launcher = `// 自动生成：转调 cli.mjs watch。按顺序用第一个存在的脚本路径（应用里外看到的路径可能不同）。
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const candidates = ${JSON.stringify([...new Set([real, self])])};
process.argv.splice(2, 0, 'watch');
await import(pathToFileURL(candidates.find((p) => fs.existsSync(p)) ?? candidates[0]).href);
`;
  try { fs.writeFileSync(path.join(RUNS_ROOT, 'watch.mjs'), launcher); } catch { /* 不影响主流程 */ }
}

// 并发上限按协作方算，任何任务（分不分组、哪个会话）都要在锁内登记并做准入检查，调用方用完 release。
async function newRunDir() {
  fs.mkdirSync(RUNS_ROOT, { recursive: true });
  // 登记和准入串行完成，避免随机后缀让后登记的任务排到前面。
  const lock = path.join(RUNS_ROOT, '.start.lock');
  const reap = `${lock}.reap`;
  const token = randomUUID(), started = Date.now();
  // 登记锁和清理锁的每次文件操作都经过 retryBusy：Windows 上别的进程正在删同一个锁文件时，新建和读取它会短暂报 EPERM。
  // 删除时把"还该删"的判断交给 retryBusy，每次重试前重新确认，免得删掉等待期间别的进程刚拿到的锁。
  const ownerOf = (file = lock) => {
    try {
      const value = JSON.parse(retryBusy(() => fs.readFileSync(file, 'utf8')));
      return typeof value === 'number' ? { pid: value } : value;
    } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e; }
  };
  const ageOf = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return 0; } };
  // 残留锁：持有者已退出；或者读不出持有者（写到一半被强杀，正常加锁时内容和文件一起写入）而且放了 10 秒以上。
  // 活持有者不按年龄抢锁，它可能只是暂停了。
  const stale = (file) => { const owner = ownerOf(file); return owner?.pid ? !pidAlive(owner.pid) : ageOf(file) > 10000; };
  const mine = (file) => ownerOf(file)?.token === token;
  for (;;) {
    try { retryBusy(() => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' })); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 回收残留锁要先拿到清理锁，删之前再确认清理锁还是自己的、登记锁还是残留的。别的回收者按旧读数删掉了
      // 自己的清理锁时，这里会看到 token 变了而放手，不会去删别人刚拿到的登记锁。清理锁本身残留时按同样的规则清掉。
      if (stale(lock)) {
        try { retryBusy(() => fs.writeFileSync(reap, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' })); }
        catch (e) { if (e.code !== 'EEXIST') throw e; retryBusy(() => fs.rmSync(reap, { force: true }), () => stale(reap)); }
        if (mine(reap)) {
          try { retryBusy(() => fs.rmSync(lock, { force: true }), () => stale(lock) && mine(reap)); }
          finally { retryBusy(() => fs.rmSync(reap, { force: true }), () => mine(reap)); }
        }
      }
      if (Date.now() - started >= 60000) die(M.startLockBusy(lock, ownerOf()?.pid ?? '?', 60));
      await sleep(25);
    }
  }
  const cleanup = () => { retryBusy(() => fs.rmSync(lock, { force: true }), () => ownerOf()?.token === token); };
  process.once('exit', cleanup);
  const release = () => { cleanup(); process.removeListener('exit', cleanup); };
  const previous = listRuns()[0] || '';
  let id;
  do {
    if (id) await sleep(10);
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
  } while (id <= previous);
  const dir = path.join(RUNS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  writeWatchLauncher();
  return { id, dir, release };
}

function listRuns() {
  if (!fs.existsSync(RUNS_ROOT)) return [];
  return fs.readdirSync(RUNS_ROOT)
    .filter((n) => fs.existsSync(path.join(RUNS_ROOT, n, 'meta.json')))
    .sort()
    .reverse();
}

function findRun(ref) {
  const id = ref === 'last' ? listRuns()[0] : ref;
  if (!id) die(M.noRuns);
  const dir = path.join(RUNS_ROOT, id);
  if (!fs.existsSync(path.join(dir, 'meta.json'))) die(M.runNotFound(ref));
  return { id, dir, meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) };
}

// 读 events.jsonl 末尾，给出最后活动时间和当前步骤，用来判断运行中的任务是活着还是卡住。
function describeActivity(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return { idle_min: null, step: M.noEvents };
  const st = fs.statSync(file);
  const len = Math.min(st.size, 256 * 1024);
  const chunk = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, chunk, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const lines = chunk.toString('utf8').split('\n').slice(len < st.size ? 1 : 0).filter((l) => l.trim());
  const running = new Map();
  let last = null;
  for (const l of lines) {
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    last = ev;
    if (ev.item?.type !== 'command_execution') continue;
    if (ev.type === 'item.started') running.set(ev.item.id, ev.item.command);
    else if (ev.type === 'item.completed') running.delete(ev.item.id);
  }
  let step;
  if (last?.type.startsWith('api.')) {
    step = last.type === 'api.request' ? M.stepApiWaiting
      : last.type === 'api.reasoning' ? M.stepApiThinking(last.total_chars)
      : last.type === 'api.content' ? M.stepApiAnswering(last.total_chars)
      : last.type === 'api.queued' ? M.stepApiQueued
      : last.type === 'api.retry' ? M.stepApiRetry(last.reason)
      : last.type === 'api.repair' ? M.stepApiRepair
      : last.type === 'api.error' ? last.message
      : last.type === 'api.usage' ? M.watchTokens(last.usage) : M.watchEnded('done');
  } else if (last?.type === 'pi.progress') step = last.phase === 'thinking' ? M.stepApiThinking(last.total_chars) : M.stepApiAnswering(last.total_chars);
  else if (last?.type === 'image.viewed') step = M.stepImageViewed(path.basename(last.path));
  else if (running.size) step = M.stepCommand(clip(oneLine(plainCommand([...running.values()].pop())), 160));
  else if (last?.item?.type === 'agent_message') step = M.stepSaid(clip(oneLine(last.item.text), 160));
  else if (last?.item?.type === 'file_change') step = M.stepFileChanged;
  else if (last?.type === 'image.generated') step = M.stepImageGenerated;
  else if (last?.type === 'item.completed' && last.item?.type === 'command_execution') step = M.stepCommandDone;
  else step = last ? M.stepLastEvent(`${last.type}${last.item?.type ? `/${last.item.type}` : ''}`) : M.noEvents;
  return { idle_min: Number(((Date.now() - st.mtimeMs) / 60000).toFixed(1)), step };
}

// 一个组的任务，只取同一会话派出的那一批：当前会话用过这个组名就取当前会话的，
// 否则（比如在终端里查看）跟最新派出的任务所在的会话。旧记录没有会话 ID，彼此算同一批。
function groupRuns(group, since = 0) {
  const runs = listRuns().map((id) => {
    const dir = path.join(RUNS_ROOT, id);
    return { id, dir, meta: readMeta(dir) };
  }).filter(({ meta }) => meta?.group === group && Date.parse(meta.started_at) >= since);
  if (!runs.length) return runs;
  const sessionOf = (run) => run.meta.claude_session ?? null;
  const newest = runs.reduce((a, b) => (Date.parse(b.meta.started_at) > Date.parse(a.meta.started_at) ? b : a));
  const batch = CLAUDE_SESSION && runs.some((run) => sessionOf(run) === CLAUDE_SESSION) ? CLAUDE_SESSION : sessionOf(newest);
  return runs.filter((run) => sessionOf(run) === batch);
}

const absolute = (cwd, file) => pathKey(path.resolve(cwd, file.replace(/\\/g, '/')).replace(/\\/g, '/')).replace(/\/$/, '');
const writesFiles = (meta) => meta?.kind === 'exec';

// 同组（同一个 Claude 会话）其他执行任务里，写入范围包含这个文件的那一个。归属未知的改动落在别人的范围里时，多半是那个任务改的。
function groupScopeOwner(meta) {
  if (meta.group == null) return () => null;
  const all = listRuns().map((id) => ({ id, meta: readMeta(path.join(RUNS_ROOT, id)) }));
  // 自己的续接链（上一轮、上上一轮……）和同一计划席位的其他轮次都是自己，不算同组的其他任务。
  const own = new Set([meta.id]);
  for (let parent = meta.parent; parent && !own.has(parent); parent = all.find((r) => r.id === parent)?.meta?.parent) own.add(parent);
  const sameSeat = (m) => meta.plan != null && m.plan === meta.plan && m.seat === meta.seat;
  const others = all.filter((r) => !own.has(r.id) && r.meta && !sameSeat(r.meta)
    && r.meta.group === meta.group && writesFiles(r.meta) && r.meta.claude_session === meta.claude_session);
  return (file) => {
    const a = absolute(meta.cwd, file);
    return others.find((r) => (r.meta.scope || []).some((s) => { const b = absolute(r.meta.cwd, s); return a === b || a.startsWith(`${b}/`); }))?.id ?? null;
  };
}

// 准入检查（在登记锁内）：同一协作方正在运行的任务不超过它的 max_parallel，所有组和会话都算，
// 因为服务商的限流和额度是按账号的；同组的执行任务写入范围不能重叠。
function checkAdmission(meta, cfg) {
  const runs = listRuns().filter((id) => id !== meta.id)
    .map((id) => { const dir = path.join(RUNS_ROOT, id); return { id, dir, meta: readMeta(dir) }; });
  if (meta.plan && meta.seat != null && !meta.parent) {
    const previous = runs.find((r) => r.meta && !r.meta.parent && r.meta.plan === meta.plan && r.meta.seat === meta.seat);
    if (previous) return M.seatAlreadyStarted(meta.plan, meta.seat, previous.id);
  }
  const running = runs.filter((r) => isRunning(r.meta));
  const limit = cfg.agents[meta.agent].max_parallel ?? DEFAULT_AGENT_PARALLEL;
  const same = running.filter((r) => resolveAgentAlias(r.meta.agent || 'codex', cfg) === meta.agent); // 旧记录没有 agent 字段，都是 Codex
  if (same.length >= limit) return M.agentFull(meta.agent, same.length, limit, M.list(same.map((r) => r.id)));
  if (meta.group == null || !writesFiles(meta)) return null;
  for (const other of running) {
    if (other.meta.group !== meta.group || !writesFiles(other.meta)) continue;
    // 比较用归一化的绝对路径，报错里显示派活时写的原样路径。
    const paths = meta.scope.filter((mine) => (other.meta.scope || []).some((file) => {
      const a = absolute(meta.cwd, mine);
      const b = absolute(other.meta.cwd, file);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }));
    if (paths.length) return M.scopeOverlap(meta.group, other.id, paths);
  }
  return null;
}

// 任务的结束时间。中断的任务没写结束时间，用记录文件最后修改的时间，也就是最后一次活动的时间。
function runEnd(dir, meta) {
  if (meta.ended_at) return Date.parse(meta.ended_at);
  if (isRunning(meta)) return Date.now();
  let last = 0;
  for (const file of ['events.jsonl', 'meta.json']) {
    try { last = Math.max(last, fs.statSync(path.join(dir, file)).mtimeMs); } catch { /* 没有这个文件 */ }
  }
  return last || Date.now();
}

function runOutcome(run) {
  // 手上的记录还是"运行中"、进程却已退出时，多半是刚写完结果就退出了，先重读一次再判断是不是中断
  if (run.meta.status === 'running' && !pidAlive(run.meta.pid)) run.meta = readMeta(run.dir) || run.meta;
  const m = run.meta;
  const running = isRunning(m);
  const status = m.status === 'running' && !running ? 'interrupted' : m.status;
  const file = path.join(run.dir, 'result.json');
  const result = !running && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  // 交回问题的任务已经正常结束，只是有事要 Claude 决定，不算失败
  const blocked = status === 'needs_input' || status === 'done' && (result?.needs_decision || result?.report?.status === 'blocked');
  const ok = !blocked && status === 'done' && (!result?.report?.status || result.report.status === 'completed');
  return { running, status, result, ok, blocked };
}

// 组里各状态的个数。交回问题或失败、但已经续接过的任务记作"已续接"，结果看续接的那一轮。
function groupTally(runs) {
  const resumedIds = new Set(runs.map((run) => run.meta.parent).filter(Boolean));
  const tally = { running: 0, ok: 0, blocked: 0, failed: 0, resumed: 0 };
  for (const run of runs) {
    const o = runOutcome(run);
    tally[o.running ? 'running' : o.ok ? 'ok' : resumedIds.has(run.id) ? 'resumed' : o.blocked ? 'blocked' : 'failed']++;
  }
  return tally;
}

function groupSummary(runs) {
  const t = groupTally(runs);
  return M.groupSummary(runs.length, t.running, t.ok, t.failed, t.blocked, t.resumed);
}

const readMeta = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; } };
const isRunning = (m) => m?.status === 'running' && pidAlive(m.pid);

export { RUNS_ROOT, initializeRecords, CANCEL_FILE, UNFINISHED_STATUSES, CLAUDE_SESSION, isCancelled, requestCancel, cancelSource, writeWatchLauncher, newRunDir, listRuns, findRun, describeActivity, groupRuns, checkAdmission, runEnd, runOutcome, groupTally, groupSummary, groupScopeOwner, absolute, readMeta, isRunning, writesFiles };
