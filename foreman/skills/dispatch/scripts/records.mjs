// 记录目录、启动登记锁、准入、活动状态和 watch 启动器。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENTRY, defaultRunsRoot, runsMovedNow, resolveAgentAlias, DEFAULT_AGENT_PARALLEL } from './config.mjs';
import { M, die, pidAlive, sleep, pathKey, clip, oneLine, plainCommand, retryBusy, replaceFile } from './util.mjs';
import { D } from './format.mjs';

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

const pendingMetaWrites = new Map();

// 先写带进程号的临时文件再改名，避免并发读取拿到半份 JSON；改名被占用时退回直接覆盖。
// 覆盖也被占用就返回 false，下次调用用完整的 meta 补上；成功返回 true，并清掉未写入的标记。
// 结束写入最多等约 15 秒，每轮失败后等 250 毫秒；仍写不进就记到 stderr.log，所有失败都清理临时文件。
function saveMeta(dir, meta, { final = false } = {}) {
  const file = path.join(dir, 'meta.json'), tmp = `${file}.${process.pid}.tmp`;
  const started = Date.now(), waitMs = final ? Number(process.env.FOREMAN_TEST_META_WAIT_MS) || 15000 : 0;
  let retrying = false;
  try {
    const text = JSON.stringify(meta, null, 2);
    for (;;) {
      try {
        fs.writeFileSync(tmp, text);
        try {
          if (retrying) fs.renameSync(tmp, file);
          else replaceFile(tmp, file);
        }
        catch (e) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
          fs.writeFileSync(file, text);
        }
        pendingMetaWrites.delete(dir);
        return true;
      } catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        pendingMetaWrites.set(dir, { sec: Number(((Date.now() - started) / 1000).toFixed(1)), error: e.code || e.message });
        if (!final) return false;
        const remaining = waitMs - (Date.now() - started);
        if (remaining <= 0) {
          try { fs.appendFileSync(path.join(dir, 'stderr.log'), metaWriteWarning(dir) + '\n'); } catch { /* 日志写不进也不影响收尾 */ }
          return false;
        }
        // 后续改名单次尝试，避免每轮再叠加 replaceFile 的约两秒等待。
        retrying = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, remaining));
      }
    }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 临时文件删不掉也不影响任务 */ }
  }
}

function metaWriteWarning(dir) {
  const { sec, error } = pendingMetaWrites.get(dir);
  return M.metaWriteGaveUp(path.join(dir, 'meta.json'), sec, error);
}

// 收尾写不进元数据时，结果里的终态优先于进程号（可能已被复用），只补齐内存。
function settleMeta(dir, meta) {
  if (meta?.status !== 'running') return meta;
  const file = path.join(dir, 'result.json');
  if (!fs.existsSync(file)) return meta;
  let result;
  try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return meta; }
  if (!result?.status) return meta;
  const settled = { ...meta, status: result.status };
  if (!settled.session_id && result.session_id) settled.session_id = result.session_id;
  if (!settled.ended_at && Number.isFinite(result.duration_s)) {
    const ended = new Date(Date.parse(meta.started_at) + result.duration_s * 1000);
    if (Number.isFinite(ended.getTime())) settled.ended_at = ended.toISOString();
  }
  return settled;
}

function findRun(ref, { tolerateUnreadable = false } = {}) {
  const id = ref === 'last' ? listRuns()[0] : ref;
  if (!id) die(M.noRuns);
  const dir = path.join(RUNS_ROOT, id);
  const file = path.join(dir, 'meta.json');
  if (!fs.existsSync(file)) die(M.runNotFound(ref));
  // 旧版插件共用记录目录，仍可能直接覆盖写（saveMeta 的退路也是）：解析失败时每 25 毫秒再读一次，约 1 秒后仍读不出就抛原错误。
  // 读文件本身被占用时 retryBusy 另等最多约 2 秒，所以最坏约 3 秒。
  for (const deadline = Date.now() + 1000; ;) {
    try { return { id, dir, meta: settleMeta(dir, JSON.parse(retryBusy(() => fs.readFileSync(file, 'utf8')))) }; }
    catch (e) {
      if (e.code === 'ENOENT') die(M.runNotFound(ref));
      if (tolerateUnreadable && (['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || e instanceof SyntaxError && Date.now() >= deadline)) return { id, dir, meta: null };
      if (['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) die(M.metaUnreadable(file));
      if (!(e instanceof SyntaxError) || Date.now() >= deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// 读 events.jsonl 末尾，给出最后活动时间和当前步骤，用来判断运行中的任务是活着还是卡住。
function describeActivity(dir) {
  const file = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(file)) return { idle_min: null, step: D.noEvents };
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
    step = last.type === 'api.request' ? D.stepApiWaiting
      : last.type === 'api.reasoning' ? D.stepApiThinking(last.total_chars)
      : last.type === 'api.content' ? D.stepApiAnswering(last.total_chars)
      : last.type === 'api.queued' ? D.stepApiQueued
      : last.type === 'api.retry' ? D.stepApiRetry(last.reason)
      : last.type === 'api.repair' ? D.stepApiRepair
      : last.type === 'api.error' ? last.message
      : last.type === 'api.usage' ? D.watchTokens(last.usage) : D.watchEnded('done');
  } else if (last?.type === 'pi.progress') step = last.phase === 'thinking' ? D.stepApiThinking(last.total_chars) : D.stepApiAnswering(last.total_chars);
  else if (last?.type === 'image.viewed') step = D.stepImageViewed(path.basename(last.path));
  else if (running.size) step = D.stepCommand(clip(oneLine(plainCommand([...running.values()].pop())), 160));
  else if (last?.item?.type === 'agent_message') step = D.stepSaid(clip(oneLine(last.item.text), 160));
  else if (last?.item?.type === 'file_change') step = D.stepFileChanged;
  else if (last?.type === 'image.generated') step = D.stepImageGenerated;
  else if (last?.type === 'item.completed' && last.item?.type === 'command_execution') {
    // opencode 和 pi 的读文件、搜索不算命令
    step = last.item.category === 'read' ? D.stepReadDone : last.item.category === 'search' ? D.stepSearchDone : D.stepCommandDone;
  }
  else step = last ? D.stepLastEvent(`${last.type}${last.item?.type ? `/${last.item.type}` : ''}`) : D.noEvents;
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
// 只算运行时间和这个任务有重叠的：区间是 [started_at, ended_at]，还在跑的算到现在，旧记录没有 ended_at 的按 runEnd 算。
// 这个任务开始之前就已经结束的同组任务，改不了这段时间里的文件，不认领。
function groupScopeOwner(meta) {
  if (meta.group == null) return () => null;
  const all = listRuns().map((id) => ({ id, meta: readMeta(path.join(RUNS_ROOT, id)) }));
  // 自己的续接链（上一轮、上上一轮……）和同一计划席位的其他轮次都是自己，不算同组的其他任务。
  const own = new Set([meta.id]);
  for (let parent = meta.parent; parent && !own.has(parent); parent = all.find((r) => r.id === parent)?.meta?.parent) own.add(parent);
  const sameSeat = (m) => meta.plan != null && m.plan === meta.plan && m.seat === meta.seat;
  const start = Date.parse(meta.started_at), end = meta.ended_at ? Date.parse(meta.ended_at) : Date.now();
  const overlaps = (r) => Date.parse(r.meta.started_at) <= end && runEnd(path.join(RUNS_ROOT, r.id), r.meta) >= start;
  const others = all.filter((r) => !own.has(r.id) && r.meta && !sameSeat(r.meta)
    && r.meta.group === meta.group && writesFiles(r.meta) && r.meta.claude_session === meta.claude_session && overlaps(r));
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

// 中断任务用最后活动时间；标记已处理会改写元数据，需排除它、临时文件和终止标记。
function runEnd(dir, meta) {
  if (meta.ended_at) return Date.parse(meta.ended_at);
  if (isRunning(meta)) return Date.now();
  let last = 0;
  let files = ['events.jsonl', 'meta.json'];
  if (meta.dismissed_at) {
    try { files = fs.readdirSync(dir).filter((file) => file !== 'meta.json' && !file.startsWith('meta.json.') && file !== CANCEL_FILE); }
    catch { files = []; } // 目录刚被删掉
  }
  for (const file of files) {
    try { const st = fs.statSync(path.join(dir, file)); if (st.isFile()) last = Math.max(last, st.mtimeMs); } catch { /* 没有这个文件 */ }
  }
  return last || (meta.dismissed_at ? Date.parse(meta.started_at) : Date.now());
}

function runOutcome(run) {
  // 手上的记录还是"运行中"、进程却已退出时，多半是刚写完结果就退出了，先重读一次再判断是不是中断
  if (run.meta.status === 'running' && !pidAlive(run.meta.pid)) run.meta = readMeta(run.dir) || settleMeta(run.dir, run.meta);
  const m = run.meta;
  const running = isRunning(m);
  const file = path.join(run.dir, 'result.json');
  let result = null;
  if (!running) try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有结果、被占用或只写了一半 */ }
  // 结果可能在元数据兜底后才恢复可读，以这一次读到的状态为准。
  const status = m.status === 'running' && !running ? result?.status ?? 'interrupted' : m.status;
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
  return D.groupSummary(runs.length, t.running, t.ok, t.failed, t.blocked, t.resumed);
}

// settle 为 false 时原样返回磁盘上的内容，不用 result.json 兜底（cancel 要分清是元数据真写成了结束，还是只有结果写好了）
const readMeta = (dir, { settle = true } = {}) => {
  try { const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); return settle ? settleMeta(dir, meta) : meta; } catch { return null; }
};
const isRunning = (m) => m?.status === 'running' && pidAlive(m.pid);

export { RUNS_ROOT, initializeRecords, CANCEL_FILE, UNFINISHED_STATUSES, CLAUDE_SESSION, isCancelled, requestCancel, cancelSource, writeWatchLauncher, newRunDir, listRuns, saveMeta, metaWriteWarning, settleMeta, findRun, describeActivity, groupRuns, checkAdmission, runEnd, runOutcome, groupTally, groupSummary, groupScopeOwner, absolute, readMeta, isRunning, writesFiles };
