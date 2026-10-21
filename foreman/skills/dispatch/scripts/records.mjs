// 记录目录、启动登记锁、准入、活动状态和 watch 启动器。
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, defaultRunsRoot, runsMovedNow, resolveAgentAlias, DEFAULT_AGENT_PARALLEL } from './config.mjs';
import { M, die, pidAlive, processStartTimes, sleep, pathKey, clip, oneLine, plainCommand, retryBusy, replaceFile } from './util.mjs';
import { D } from './format.mjs';
import { acquireLock } from './locks.mjs';

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
  // 进程身份在锁外预查，避免其他派活等 PowerShell；记下当时有哪些任务，准入时据此分辨新登记的。
  const ids = listRuns();
  listedBeforeLock = new Set(ids);
  checkRunners(ids.map((id) => readMeta(path.join(RUNS_ROOT, id))));
  // 登记和准入串行完成，避免随机后缀让后登记的任务排到前面。
  const { release } = await acquireLock(path.join(RUNS_ROOT, '.start.lock'), {
    waitMs: 60000, legacy: true, busy: ({ file, pid }) => die(M.startLockBusy(file, pid ?? '?', 60)),
  });
  const previous = listRuns().find((id) => /^\d{8}-\d{6}-/.test(id)) || '';
  let id;
  do {
    if (id) await sleep(10);
    let d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const time = () => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    // 时钟回拨时沿最新记录往前一秒，免得拿着登记锁一直等。
    if (time() < previous.slice(0, 15)) d = new Date(Number(previous.slice(0, 4)), Number(previous.slice(4, 6)) - 1,
      Number(previous.slice(6, 8)), Number(previous.slice(9, 11)), Number(previous.slice(11, 13)), Number(previous.slice(13, 15)) + 1);
    id = `${time()}-${Math.random().toString(36).slice(2, 6)}`;
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
  if (ref !== 'last' && (path.basename(ref) !== ref || ref === '.' || ref === '..')) die(M.runNotFound(ref));
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
  }).filter(({ meta }) => meta?.group === group);
  const recent = runs.filter(({ meta }) => Date.parse(meta.started_at) >= since);
  if (!recent.length) return Object.assign(recent, { all: runs });
  const sessionOf = (run) => run.meta.claude_session ?? null;
  const newest = recent.reduce((a, b) => (b.id > a.id ? b : a));
  const batch = CLAUDE_SESSION && recent.some((run) => sessionOf(run) === CLAUDE_SESSION) ? CLAUDE_SESSION : sessionOf(newest);
  // 计划跨会话算状态，展示仍按会话过滤，共用这次读取的记录。
  return Object.assign(recent.filter((run) => sessionOf(run) === batch), { all: runs });
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
// 登记锁内读全部记录：一时读不出的（正被替换、被占用）合计最多重读约 1 秒，仍读不出的列进 unreadable，由调用方拒绝。
function readRunsLocked(exceptId) {
  const runs = [], unreadable = [], deadline = Date.now() + 1000;
  for (const id of listRuns().filter((id) => id !== exceptId)) {
    const dir = path.join(RUNS_ROOT, id), file = path.join(dir, 'meta.json');
    for (;;) {
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 内容是 null、数字这类合法 JSON 但不是记录的，和读不出一样处理。
        if (!meta || typeof meta !== 'object') throw new Error('not a record');
        runs.push({ id, dir, meta: settleMeta(dir, meta) }); break;
      } catch (e) {
        if (e.code === 'ENOENT') break;
        if (Date.now() >= deadline) { unreadable.push(file); break; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  return { runs, unreadable };
}

function checkAdmission(meta, cfg) {
  const { runs, unreadable } = readRunsLocked(meta.id);
  if (unreadable.length) return M.admissionUnreadable(M.list(unreadable));
  if (['discuss', 'review'].includes(meta.kind) && meta.plan && meta.participant !== 'host') {
    // 不引入 plan.mjs，避免计划状态反过来引用记录时形成循环。计划文件被删了照样要查：这份计划交过答卷，就说明它有 Claude Code 席。
    const file = path.join(RUNS_ROOT, 'plans', `${meta.plan}.json`);
    let plan = null;
    try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') return M.planUnreadable(file); }
    const answers = runs.filter((run) => run.meta.plan === meta.plan && run.meta.participant === 'host');
    const round = meta.kind === 'review' ? 1 : meta.round ?? 1;
    // 按轮次核对，不按份数：同一轮多出来的答卷不能顶替下一轮的。
    if ((plan?.host || answers.length) && !answers.some((run) => (run.meta.round ?? 0) >= round)) return M.hostAnswerRequired(meta.plan, round);
  }
  // 拿锁前还没有的任务是之后才登记的，都是刚启动的 runner，直接算在运行；拿锁前就有、当时没核对上的
  // （元数据一时读不出、进程号刚被复用）很少见，才在锁内补查。
  const running = runs.filter((r) => isRunning(r.meta, { query: !listedBeforeLock || listedBeforeLock.has(r.id) }));
  if (meta.parent) {
    if (running.some((r) => r.id === meta.parent)) return M.resumeParentRunning(meta.parent);
    const child = runs.find((r) => r.meta.parent === meta.parent);
    if (child) return M.resumeNotLatest(meta.parent, child.id);
  }
  if (meta.plan && meta.seat != null && !meta.parent) {
    const previous = runs.filter((r) => r.meta.plan === meta.plan && r.meta.seat === meta.seat)
      .sort((a, b) => a.id.localeCompare(b.id));
    const active = running.find((r) => previous.includes(r));
    if (active) return M.seatRoundRunning(meta.plan, meta.seat, active.id);
    const valid = previous.find((run) => runOutcome(run).ok), latest = previous.at(-1);
    if (meta.module === 'review' || meta.kind === 'review' || meta.mode === 'review') {
      if (valid) return M.reviewSeatTaken(meta.plan, meta.seat, valid.id);
    } else if (latest && (valid || latest.meta.session_id || fs.existsSync(path.join(latest.dir, 'messages.json')))) {
      return M.seatAlreadyStarted(meta.plan, meta.seat, latest.id);
    }
  }
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
    try { files = fs.readdirSync(dir).filter((file) => file !== 'meta.json' && !file.startsWith('meta.json.') && file !== CANCEL_FILE && file !== 'verdict.json' && !file.startsWith('verdict.json.')); } // 去留可能在结束后很久才补记，不延长用时。
    catch { files = []; } // 目录刚被删掉
  }
  for (const file of files) {
    try { const st = fs.statSync(path.join(dir, file)); if (st.isFile()) last = Math.max(last, st.mtimeMs); } catch { /* 没有这个文件 */ }
  }
  return last || (meta.dismissed_at ? Date.parse(meta.started_at) : Date.now());
}

function resultValid(meta, result) {
  const module = meta.module || (meta.kind === 'discuss' || meta.mode === 'discuss' ? 'discuss'
    : meta.kind === 'review' || meta.mode === 'review' ? 'review' : 'run');
  if (module !== 'review') return !!result?.report;
  // 旧审查没有结构化报告；新审查只有原生 Codex 的非空正文能算结果。
  return result?.report ? result.report.verdict !== 'incomplete'
    : !!result?.last_message?.trim() && (!!result.native_review || result.review_target === undefined);
}

function runOutcome(run) {
  // 手上的记录还是"运行中"、runner 却已不在时，先重读一次，免得漏掉刚写好的结果。
  if (run.meta.status === 'running' && !isRunning(run.meta)) run.meta = readMeta(run.dir) || settleMeta(run.dir, run.meta);
  const m = run.meta;
  const running = isRunning(m);
  const file = path.join(run.dir, 'result.json');
  let result = null;
  if (!running) try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有结果、被占用或只写了一半 */ }
  // 结果可能在元数据兜底后才恢复可读，以这一次读到的状态为准。
  const status = m.status === 'running' && !running ? result?.status ?? 'interrupted' : m.status;
  // 交回问题的任务已经正常结束，只是有事要 Claude 决定，不算失败
  const blocked = status === 'needs_input' || status === 'done' && (result?.needs_decision || result?.report?.status === 'blocked');
  const valid = resultValid(m, result);
  const ok = !blocked && status === 'done' && valid && (!result?.report?.status || result.report.status === 'completed');
  return { running, status, result, valid, ok, blocked };
}

// 组里各状态的个数。交回问题或失败、但已经续接过的任务记作"已续接"，结果看续接的那一轮。
function groupTally(runs, all = runs.all ?? runs) {
  const resumedIds = new Set(all.map((run) => run.meta.parent).filter(Boolean));
  // 同一计划同一席重新启动过的，前面那几轮也算"已续接"，结果看最新的一轮。
  const seatOf = (run) => (run.meta.plan && run.meta.seat != null ? `${run.meta.plan}:${run.meta.seat}` : null);
  const latest = new Map();
  for (const run of all) if (seatOf(run) && !(latest.get(seatOf(run)) > run.id)) latest.set(seatOf(run), run.id);
  for (const run of runs) if (seatOf(run) && latest.get(seatOf(run)) > run.id) resumedIds.add(run.id);
  const tally = { running: 0, ok: 0, blocked: 0, failed: 0, resumed: 0 };
  for (const run of runs) {
    if (run.meta.participant === 'host') { tally.submitted = (tally.submitted || 0) + 1; continue; }
    const o = runOutcome(run);
    tally[o.running ? 'running' : o.ok ? 'ok' : resumedIds.has(run.id) ? 'resumed' : o.blocked ? 'blocked' : 'failed']++;
  }
  return tally;
}

function groupSummary(runs) {
  const t = groupTally(runs);
  return D.groupSummary(runs.length, t.running, t.ok, t.failed, t.blocked, t.resumed, t.submitted);
}

// settle 为 false 时原样返回磁盘上的内容，不用 result.json 兜底（cancel 要分清是元数据真写成了结束，还是只有结果写好了）
const readMeta = (dir, { settle = true } = {}) => {
  try { const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); return settle ? settleMeta(dir, meta) : meta; } catch { return null; }
};
const runnerChecks = new Map();
let listedBeforeLock = null;
const runnerKey = (m) => `${m.pid}|${m.started_at}`;
function runnerCheck(m) {
  const checked = runnerChecks.get(runnerKey(m));
  // 确认被复用后，原 runner 肯定已经不在了；其他结论每分钟重新核对。
  return checked && (checked.state === 'other' || Date.now() - checked.at < 60000) ? checked.state : null;
}

function checkRunners(metas) {
  const pending = metas.filter((m) => isRunning(m, { query: false }) && !runnerCheck(m));
  if (!pending.length) return;
  const times = processStartTimes(pending.map((m) => m.pid));
  const at = Date.now();
  for (const m of pending) {
    const started = times.get(m.pid), recorded = Date.parse(m.started_at);
    const state = started == null || !Number.isFinite(recorded) ? 'unknown' : started > recorded ? 'other' : 'same';
    runnerChecks.set(runnerKey(m), { state, at });
  }
}

function isRunning(m, { query = true } = {}) {
  if (m?.status !== 'running') return false;
  if (!pidAlive(m.pid)) {
    // 已确认被复用的结论保留：原 runner 不会再回来，之后再查不到启动时间也不能把它算回运行中。
    if (runnerChecks.get(runnerKey(m))?.state !== 'other') runnerChecks.delete(runnerKey(m));
    return false;
  }
  if (query && !runnerCheck(m)) checkRunners([m]);
  return runnerCheck(m) !== 'other';
}

export { RUNS_ROOT, initializeRecords, CANCEL_FILE, UNFINISHED_STATUSES, CLAUDE_SESSION, isCancelled, requestCancel, cancelSource, writeWatchLauncher, newRunDir, listRuns, saveMeta, metaWriteWarning, settleMeta, findRun, describeActivity, groupRuns, checkAdmission, readRunsLocked, runEnd, runOutcome, resultValid, groupTally, groupSummary, groupScopeOwner, absolute, readMeta, checkRunners, isRunning, writesFiles };
