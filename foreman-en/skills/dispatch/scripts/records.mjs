// 记录目录、启动登记锁、准入、活动状态和 watch 启动器。
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, defaultRunsRoot, runsMovedNow, resolveAgentAlias, agentMaxParallel } from './config.mjs';
import { M, die, notice, pidExists, processStartTimes, sleep, pathKey, clip, oneLine, plainCommand, retryBusy, replaceFile, PROFILE, profile, LANGUAGE } from './util.mjs';
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

// 网页看板的地址：直接进入这个对话（session 为空时进宇宙）
const boardUrl = (lock, session = CLAUDE_SESSION) =>
  `http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=${encodeURIComponent(LANGUAGE)}${session ? `&s=${encodeURIComponent(session)}` : ''}`;
// 派出时附带的看板地址：只读锁文件、看进程在不在，不等也不启动服务（钩子在派出前已经用 board 启动好了），没在跑就不给
function liveBoardUrl() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, 'board.lock.json'), 'utf8'));
    return lock.port > 0 && lock.token && Number.isInteger(lock.pid) && pidExists(lock.pid) ? boardUrl(lock) : null;
  } catch { return null; }
}
// 网页看板开着时紧接着开工行给出这个对话的看板地址：Claude Code 写"已派出"那句话时照着附上（钩子显示的那条在桌面版里是折起来的）。
// 各类协作方的开工行写在不同的地方，都调这一个
function announceBoard(cfg) {
  const board = cfg?.dispatch?.watch?.web ? liveBoardUrl() : null;
  if (board) process.stderr.write(`foreman: ${D.boardLine(board)}\n`);
}

// 并发上限按协作方算，任何任务（分不分组、哪个会话）都要在锁内登记并做准入检查，调用方用完 release。
async function newRunDir(ctx) {
  fs.mkdirSync(path.join(RUNS_ROOT, '.locks'), { recursive: true });
  const candidate = ctx?.cfg ? { ...ctx, agent: ctx.agentName, group: ctx.opts.group ?? null, scope: ctx.opts.scope } : null;
  const timeout = Number(ctx?.opts?.['queue-timeout'] ?? 60);
  let ticket = null, position = null, queuedBegan = 0;
  const cleanup = () => {
    if (ticket) {
      if (PROFILE) profile('queue-wait', queuedBegan);
      retryBusy(() => fs.rmSync(ticket.file, { force: true })); ticket = null;
    }
    process.removeListener('exit', cleanup);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  };
  const interrupt = () => { cleanup(); process.exit(130); }, terminate = () => { cleanup(); process.exit(143); };
  const expired = () => ticket && Date.now() - Date.parse(ticket.queued_at) >= timeout * 60000;
  try {
    for (;;) {
      let began = PROFILE ? performance.now() : 0;
      const state = activeState(), ids = state?.active ?? (ctx ? [] : listRuns());
      listedBeforeLock = new Set(ids);
      const metas = ids.map((id) => readMeta(path.join(RUNS_ROOT, id)));
      const head = candidate && queueTickets(candidate.agent)[0];
      if (PROFILE) profile('outside-scan', began);
      // 只补查可能挡住自己的队首，和活动进程合并在锁外查询，不逐票起 PowerShell。
      checkRunners(head && head.pid !== process.pid ? [...metas, ticketOwner(head)] : metas);
      if (PROFILE) began = performance.now();
      const { release: unlock } = await acquireLock(path.join(RUNS_ROOT, '.locks', '.start.lock'), {
        waitMs: ticket ? Math.max(0, Math.min(60000, timeout * 60000 - (Date.now() - Date.parse(ticket.queued_at)))) : 60000,
        legacy: path.join(RUNS_ROOT, '.start.lock'), busy: ({ file, pid }) => die(expired()
          ? M.queueTimeout(candidate.agent, timeout) : M.startLockBusy(file, pid ?? '?', 60)),
      });
      if (PROFILE) profile('lock-wait', began);
      const release = PROFILE ? () => { const at = performance.now(); unlock(); profile('lock-release', at); } : unlock;
      let handedOff = false;
      try {
        if (expired()) { release(); cleanup(); die(M.queueTimeout(candidate.agent, timeout)); }
        registrationContext = ctx;
        if (ctx) {
          if (PROFILE) began = performance.now();
          const loaded = readRunsLocked(null, ctx);
          const rejection = candidate ? admission(candidate, ctx.cfg, loaded, true) : loaded.unreadable.length && M.admissionUnreadable(M.list(loaded.unreadable));
          if (PROFILE) profile('locked-admission', began);
          if (typeof rejection === 'string') { release(); die(rejection); }
          if (candidate) {
            const waiting = queueTickets(candidate.agent, true);
            // 自己的票据一时读不出时还在原位：只有文件确实没了（被回收）才算丢了
            if (ticket && !waiting.some((q) => q.sequence === ticket.sequence && (q.unreadable || q.pid === process.pid)) && !fs.existsSync(ticket.file)) {
              const message = expired() ? M.queueTimeout(candidate.agent, timeout) : M.queueLost(candidate.agent);
              release(); cleanup(); die(message);
            }
            if (rejection || waiting.length) {
              if (timeout === 0) { release(); die(rejection?.message ?? M.queueAhead(candidate.agent)); }
              if (!ticket) {
                const dir = queueDir(candidate.agent), sequenceFile = path.join(dir, '.sequence.json');
                const sequence = Math.max(readSequence(sequenceFile), waiting.lastSequence ?? 0) + 1;
                atomicJson(sequenceFile, sequence);
                const now = Date.now();
                ticket = { sequence, pid: process.pid, agent: candidate.agent, claude_session: CLAUDE_SESSION,
                  group: candidate.group, plan: ctx.plan ?? null, seat: ctx.seat ?? null, title: ctx.title ?? null,
                  queued_at: new Date(now).toISOString(), expires_at: new Date(now + timeout * 60000).toISOString(),
                  pid_started_at: new Date(performance.timeOrigin).toISOString(), file: path.join(dir, `${sequence}.json`) };
                atomicJson(ticket.file, ticket);
                if (PROFILE) queuedBegan = performance.now();
                process.once('exit', cleanup); process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
                waiting.push(ticket);
              }
              const next = waiting.findIndex((q) => q.sequence === ticket.sequence) + 1;
              if (rejection || next !== 1) {
                const remaining = Math.max(1, Math.round((Date.parse(ticket.expires_at) - Date.now()) / 60000));
                if (next !== position) notice(M.queuePosition(candidate.agent, agentMaxParallel(ctx.cfg.agents[candidate.agent]), next, remaining));
                position = next;
                continue;
              }
            }
          }
        }
        if (PROFILE) began = performance.now();
        const previous = ctx ? latestDirectoryId : latestId(fs.readdirSync(RUNS_ROOT));
        const { id, dir } = createRunDir(previous);
        if (PROFILE) profile('locked-create', began);
        handedOff = true;
        return { id, dir, release: () => {
          cleanup(); release();
        } };
      } finally {
        if (!handedOff) release();
        if (ticket && !handedOff) await sleep(Math.min(1000, Math.max(0, timeout * 60000 - (Date.now() - Date.parse(ticket.queued_at)))));
      }
    }
  } catch (error) { cleanup(); throw error; }
}

const runId = (id) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);
const latestId = (ids) => ids.reduce((last, id) => runId(id) && id > last ? id : last, '');

function createRunDir(previous) {
  let d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const time = () => `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  // 同秒递增后缀，时钟回拨或后缀用尽时进一秒，不在锁内碰运气等随机数。
  if (time() <= previous.slice(0, 15)) {
    const next = time() < previous.slice(0, 15) ? 36 ** 4 : parseInt(previous.slice(16), 36) + 1;
    d = new Date(Number(previous.slice(0, 4)), Number(previous.slice(4, 6)) - 1,
      Number(previous.slice(6, 8)), Number(previous.slice(9, 11)), Number(previous.slice(11, 13)), Number(previous.slice(13, 15)));
    if (next >= 36 ** 4) { d.setSeconds(d.getSeconds() + 1); suffix = '0000'; }
    else suffix = next.toString(36).padStart(4, '0');
  }
  const id = `${time()}-${suffix}`;
  const dir = path.join(RUNS_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  writeWatchLauncher();
  return { id, dir };
}

function listRuns(skip) {
  if (!fs.existsSync(RUNS_ROOT)) return [];
  return fs.readdirSync(RUNS_ROOT)
    .filter((n) => !skip?.has(n) && fs.existsSync(path.join(RUNS_ROOT, n, 'meta.json')))
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
    if (ev.type === 'step.usage') continue;
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
  } else if (last?.type === 'pi.progress' || last?.type === 'agy.progress') step = last.phase === 'thinking' ? D.stepApiThinking(last.total_chars) : D.stepApiAnswering(last.total_chars);
  else if (last?.type === 'image.viewed') step = D.stepImageViewed(path.basename(last.path));
  else if (last?.type === 'foreman.snapshot' && last.phase === 'start') step = D.stepSnapshot;
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
// 组名登记后不再改：实时查看每秒都要找一遍组里的任务，别的组的记录读到一次就记下、以后跳过（上千条记录全读一遍要几百毫秒）。
const otherGroups = new Map(); // 组名 → 不属于它的 run id
function groupRuns(group, since = 0) {
  if (!otherGroups.has(group)) otherGroups.set(group, new Set());
  const skip = otherGroups.get(group);
  const runs = listRuns(skip).map((id) => {
    const dir = path.join(RUNS_ROOT, id), meta = readMeta(dir);
    if (meta && meta.group !== group) skip.add(id);
    return { id, dir, meta };
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

let registrationContext, lockedState, latestDirectoryId;
const stateFile = () => path.join(RUNS_ROOT, '.state', 'active.json');
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  replaceFile(tmp, file);
}

function activeState() {
  try {
    const value = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const ids = (v) => Array.isArray(v) && v.every((id) => typeof id === 'string' && id.length > 0 && path.basename(id) === id && id !== '.' && id !== '..');
    const index = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(ids);
    return value?.version === 2 && (value.high_water === '' || typeof value.high_water === 'string' && runId(value.high_water))
      && ids(value.seen) && ids(value.active) && index(value.plans) && index(value.children) ? value : null;
  } catch { return null; }
}

function remember(state, id, meta) {
  const seat = meta.plan == null ? null : `${meta.plan}:${meta.participant === 'host' ? 0 : meta.seat}`;
  for (const [index, key] of [[state.plans, seat], [state.children, meta.parent]]) {
    if (key == null) continue;
    const ids = index[key] ??= [];
    if (!ids.includes(id)) ids.push(id);
  }
}

export function registerRun(dir, meta, cfg) {
  if (!saveMeta(dir, meta)) return metaWriteWarning(dir);
  if (!registrationContext?.cfg) return checkAdmission(meta, cfg);
  lockedState.active.push(meta.id);
  lockedState.seen.push(meta.id);
  lockedState.high_water = latestId([lockedState.high_water, meta.id]);
  remember(lockedState, meta.id, meta);
  atomicJson(stateFile(), lockedState);
  return null;
}

const queueDir = (agent, root = RUNS_ROOT) => path.join(root, '.state', 'queue', encodeURIComponent(agent));
const readSequence = (file) => {
  try { const n = JSON.parse(fs.readFileSync(file, 'utf8')); return Number.isSafeInteger(n) && n >= 0 ? n : 0; }
  catch { return 0; }
};
// Node 起点是系统进程启动时间的上界；沿用 runner 的“更晚启动才确认复用”，兼容 ps 的秒精度。
const ticketOwner = (ticket) => ({ status: 'running', pid: ticket.pid, started_at: ticket.pid_started_at ?? ticket.queued_at, ticket: true });
function queueTickets(agent, clean = false, root = RUNS_ROOT) {
  const dir = queueDir(agent, root), tickets = [];
  const now = Date.now();
  let lastSequence = 0;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  for (const name of names.filter((name) => /^\d+\.json$/.test(name))) {
    const file = path.join(dir, name);
    lastSequence = Math.max(lastSequence, Number(name.slice(0, -5)));
    let ticket, text;
    try { text = retryBusy(() => fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code === 'ENOENT') continue; // 刚被主人或别的检查者删掉
      // 一时读不出（被杀毒软件占用、没权限）：当作还在排队，占住位次，不删、也不让后面的人越过它
      tickets.push({ sequence: Number(name.slice(0, -5)), file, unreadable: true });
      continue;
    }
    try {
      ticket = JSON.parse(text);
      if (!ticket || !Number.isInteger(ticket.pid) || ticket.pid <= 0 || !Number.isFinite(Date.parse(ticket.queued_at))
        || ticket.expires_at != null && !Number.isFinite(Date.parse(ticket.expires_at))
        || ticket.pid_started_at != null && !Number.isFinite(Date.parse(ticket.pid_started_at))) throw new Error('not a ticket');
    } catch {
      // 原子发布失败或旧版半写的票据先跳过，老坏文件由持锁者清理。
      let old = false;
      try { old = now - fs.statSync(file).mtimeMs > 60000; } catch { /* 无法确认年龄就不删 */ }
      if (clean && old) retryBusy(() => fs.rmSync(file, { force: true }));
      continue;
    }
    const expires = Date.parse(ticket.expires_at);
    if (!pidExists(ticket.pid) || now - expires > 60000) {
      if (clean) retryBusy(() => fs.rmSync(file, { force: true }));
      continue;
    }
    if (now >= expires) continue;
    tickets.push({ ...ticket, file, sequence: Number(name.slice(0, -5)) });
  }
  tickets.sort((a, b) => a.sequence - b.sequence);
  while (tickets.length && !tickets[0].unreadable && !isRunning(ticketOwner(tickets[0]), { query: false })) {
    const dead = tickets.shift();
    if (clean) retryBusy(() => fs.rmSync(dead.file, { force: true }));
  }
  return Object.assign(tickets, { lastSequence });
}

export function queuedRuns(group, root = RUNS_ROOT) {
  const dir = path.join(root, '.state', 'queue');
  let agents;
  try { agents = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const queues = agents.map((name) => queueTickets(decodeURIComponent(name), false, root));
  // status 是按需读取，一次批量核验展示项；派发等待循环只核验队首。
  checkRunners(queues.flat().map(ticketOwner));
  // 读不出的票据照样占位次，但没有标题可显示，只计进位次
  return queues.flatMap((tickets) => tickets.filter((ticket) => ticket.unreadable || isRunning(ticketOwner(ticket), { query: false }))
    .map((ticket, i) => ({ ...ticket, position: i + 1 })).filter((ticket) => !ticket.unreadable))
    .filter((ticket) => group == null || ticket.group === group);
}

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

// 改动归属要看同目录所有并行执行任务；准入和按组查看仍保留各自原来的边界。
// 运行 id 里带着开始时刻（本地时间）；不是这种格式的返回 null
const idTime = (id) => {
  const p = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  return p ? new Date(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]).getTime() : null;
};
export function concurrentExecRuns(meta, previous = []) {
  // 近期记录之外合并活动项和开工时见过的任务，长任务结束并移出活动集合后也不会漏掉。
  const since = Date.parse(meta.started_at) - UNVERIFIED_LIMIT_MS;
  const names = fs.readdirSync(RUNS_ROOT).filter((id) => {
    const at = idTime(id);
    return at == null ? !id.startsWith('.') && id !== 'plans' && !id.includes('.') : !(at < since);
  });
  const ids = new Set([...names, ...(activeState()?.active ?? []), ...previous.map((r) => r.id)]);
  const all = [...ids].map((id) => ({ id, meta: readMeta(path.join(RUNS_ROOT, id)) }));
  const own = new Set([meta.id]);
  for (let parent = meta.parent; parent && !own.has(parent); parent = all.find((r) => r.id === parent)?.meta?.parent) own.add(parent);
  const sameSeat = (m) => meta.plan != null && m.plan === meta.plan && m.seat === meta.seat;
  const start = Date.parse(meta.started_at), end = meta.ended_at ? Date.parse(meta.ended_at) : Date.now();
  return all.filter((r) => r.meta?.cwd && !own.has(r.id) && !sameSeat(r.meta) && writesFiles(r.meta)
    && absolute(r.meta.cwd, '.') === absolute(meta.cwd, '.')
    && Date.parse(r.meta.started_at) <= end && runEnd(path.join(RUNS_ROOT, r.id), r.meta) >= start);
}

// 准入检查（在登记锁内）：同一协作方正在运行的任务不超过它的 max_parallel，所有组和会话都算，
// 因为服务商的限流和额度是按账号的；同组的执行任务写入范围不能重叠。
// 历史计划和续接关系留索引，避免结束任务移出活动集合后，席位与最新轮次的检查丢失。
// save 为 false 时只读：选哪些记录和锁内一样，但不写回活动索引（锁外的预检用）
function readRunsLocked(exceptId, context = registrationContext, { save = true } = {}) {
  const cached = context ? activeState() : null;
  const names = cached ? fs.readdirSync(RUNS_ROOT).filter((id) => !id.startsWith('.') && !['plans', 'watch.mjs'].includes(id)) : listRuns();
  const state = cached ?? { version: 2, high_water: '', seen: [], active: [], plans: {}, children: {} };
  const seen = new Set(state.seen);
  const descendants = new Set(context?.parent ? [context.parent] : []);
  for (const id of descendants) for (const child of state.children[id] ?? []) descendants.add(child);
  const history = !context?.plan ? [] : context.cfg
    ? [...(state.plans[`${context.plan}:0`] ?? []), ...(state.plans[`${context.plan}:${context.seat}`] ?? [])]
    : Object.entries(state.plans).filter(([key]) => key.startsWith(`${context.plan}:`)).flatMap(([, ids]) => ids);
  // 恢复的记录和旧版随机后缀都可能低于水位，只按是否见过目录发现新增项。
  const ids = cached ? [...new Set([...state.active, ...names.filter((id) => !seen.has(id)),
    ...history, ...descendants])] : names;
  const runs = [], unreadable = [], deadline = Date.now() + 1000;
  for (const id of ids.filter((id) => id !== exceptId)) {
    const dir = path.join(RUNS_ROOT, id), file = path.join(dir, 'meta.json');
    for (;;) {
      try {
        const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
        // 内容是 null、数字这类合法 JSON 但不是记录的，和读不出一样处理。
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new Error('not a record');
        runs.push({ id, dir, meta: settleMeta(dir, meta) }); break;
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break;
        if (Date.now() >= deadline) { unreadable.push(file); break; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  if (context && save && !unreadable.length) {
    const active = new Set(state.active);
    for (const { id, meta } of runs) {
      remember(state, id, meta);
      if (isRunning(meta, { query: false })) active.add(id); else active.delete(id);
    }
    const readIds = new Set(runs.map((r) => r.id));
    for (const id of ids) if (id !== exceptId && !readIds.has(id)) active.delete(id);
    latestDirectoryId = latestId([state.high_water, ...names]);
    // 没读到 meta 的新目录暂不记入 seen，避免稍后登记的报告被永久漏掉。
    state.seen = names.filter((id) => seen.has(id) || readIds.has(id));
    state.active = [...active]; state.high_water = latestId([state.high_water, ...runs.map((r) => r.id)]);
    lockedState = state;
    atomicJson(stateFile(), state);
  }
  return { runs, unreadable };
}

function checkAdmission(meta, cfg) {
  const began = PROFILE ? performance.now() : 0;
  try { return admission(meta, cfg); }
  finally { if (PROFILE) profile('locked-admission', began); }
}

// 锁外的预检：启动计划席位前先报准入问题（Claude Code 席没提交、这一席已经跑过等），再去读说明文件。
// 读的记录和锁内一样（活动索引里的、新目录、这份计划和父任务链的），和这次启动无关的旧记录坏了不挡；
// 先一次查完运行中任务的进程身份，免得逐个起 PowerShell；名额满了不在这里拒绝，交给登记时排队
function precheckAdmission(meta, cfg) {
  const read = readRunsLocked(meta.id, { plan: meta.plan, seat: meta.seat, parent: meta.parent, cfg }, { save: false });
  checkRunners(read.runs.map((run) => run.meta));
  return admission(meta, cfg, read, true);
}

function admission(meta, cfg, { runs, unreadable } = readRunsLocked(meta.id), queue = false) {
  if (unreadable.length) return M.admissionUnreadable(M.list(unreadable));
  if (['discuss', 'review'].includes(meta.kind) && meta.plan && meta.participant !== 'host') {
    // 不引入 plan.mjs，避免计划状态反过来引用记录时形成循环。计划文件被删了照样要查：这份计划提交过报告，就说明它有 Claude Code 席。
    const file = path.join(RUNS_ROOT, 'plans', `${meta.plan}.json`);
    let plan = null;
    try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') return M.planUnreadable(file); }
    const answers = runs.filter((run) => run.meta.plan === meta.plan && run.meta.participant === 'host');
    const round = meta.kind === 'review' ? 1 : meta.round ?? 1;
    // 按轮次核对，不按份数：同一轮多出来的报告不能顶替下一轮的。
    if ((plan?.host || answers.length) && !answers.some((run) => (run.meta.round ?? 0) >= round)) return M.hostAnswerRequired(meta.plan, round);
  }
  // 新发现的任务尚未核对进程身份，保守算运行中；锁外见过但没核对上的，才在锁内补查。
  const running = runs.filter((r) => isRunning(r.meta, { query: !listedBeforeLock || listedBeforeLock.has(r.id) }));
  if (meta.parent) {
    if (running.some((r) => r.id === meta.parent)) return M.resumeParentRunning(meta.parent);
    let child = runs.find((r) => r.meta.parent === meta.parent);
    if (child) {
      const seen = new Set([meta.parent]);
      while (!seen.has(child.id)) {
        seen.add(child.id);
        const next = runs.find((r) => r.meta.parent === child.id);
        if (!next) break;
        child = next;
      }
      return M.resumeNotLatest(meta.parent, child.id);
    }
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
      return M.seatAlreadyStarted(meta.plan, meta.seat, latest.id, meta.module === 'discuss' || meta.kind === 'discuss');
    }
  }
  for (const other of meta.group != null && writesFiles(meta) ? running : []) {
    if (other.meta.group !== meta.group || !writesFiles(other.meta)) continue;
    // 比较用归一化的绝对路径，报错里显示派活时写的原样路径。
    const paths = meta.scope.filter((mine) => (other.meta.scope || []).some((file) => {
      const a = absolute(meta.cwd, mine);
      const b = absolute(other.meta.cwd, file);
      return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    }));
    if (paths.length) return M.scopeOverlap(meta.group, other.id, paths);
  }
  const limit = agentMaxParallel(cfg.agents[meta.agent]);
  const same = running.filter((r) => resolveAgentAlias(r.meta.agent || 'codex', cfg) === meta.agent); // 旧记录没有 agent 字段，都是 Codex
  if (same.length >= limit) {
    const message = M.agentFull(meta.agent, same.length, limit, M.list(same.map((r) => r.id)));
    return queue ? { message } : message;
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
  // 部分完成仍有可用的交付，不算失败
  const partial = !blocked && status === 'done' && result?.report?.status === 'partial';
  return { running, status, result, valid, ok, blocked, partial };
}

// 有声明就按声明统计，旧续接沿用原推断；不一致只提示，不改判。
function resumeVerdict(meta, parentOutcome) {
  const reason = meta.resume_reason, inferred = !reason;
  const rework = inferred ? parentOutcome.status === 'done' && parentOutcome.valid && !parentOutcome.blocked : reason === 'rework';
  let mismatch = null;
  if (!inferred) {
    if (reason === 'answer' && !parentOutcome.blocked && !parentOutcome.result?.questions?.length) mismatch = 'answer';
    if (reason === 'recover' && parentOutcome.status === 'done' && parentOutcome.valid) mismatch = 'recover';
    if (reason === 'rework' && !parentOutcome.valid) mismatch = 'rework';
  }
  return { rework, inferred, mismatch };
}

// 已经续接过的任务：被别的任务续接的，以及同一计划同一席后来又重新启动过的（结果看最新的一轮）。
function resumedRuns(runs, all = runs.all ?? runs) {
  const resumedIds = new Set(all.map((run) => run.meta?.parent).filter(Boolean));
  const seatOf = (run) => (run.meta?.plan && run.meta.seat != null ? `${run.meta.plan}:${run.meta.seat}` : null);
  const latest = new Map();
  for (const run of all) if (seatOf(run) && !(latest.get(seatOf(run)) > run.id)) latest.set(seatOf(run), run.id);
  for (const run of runs) if (seatOf(run) && latest.get(seatOf(run)) > run.id) resumedIds.add(run.id);
  return resumedIds;
}

// 组里各状态的个数。交回问题或失败、但已经续接过的任务记作"已续接"，结果看续接的那一轮。
function groupTally(runs, all = runs.all ?? runs) {
  const resumedIds = resumedRuns(runs, all);
  const tally = { running: 0, ok: 0, blocked: 0, failed: 0, resumed: 0 };
  for (const run of runs) {
    if (run.meta.participant === 'host') { tally.submitted = (tally.submitted || 0) + 1; continue; }
    const o = runOutcome(run);
    const kind = o.running ? 'running' : o.ok ? 'ok' : resumedIds.has(run.id) ? 'resumed' : o.blocked ? 'blocked' : o.partial ? 'partial' : 'failed';
    tally[kind] = (tally[kind] || 0) + 1;
  }
  return tally;
}

function groupSummary(runs) {
  const t = groupTally(runs);
  return D.groupSummary(runs.length, t.running, t.ok, t.failed, t.blocked, t.resumed, t.submitted, t.partial);
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
  if (!pidExists(m.pid)) {
    // 已确认被复用的结论保留：原 runner 不会再回来，之后再查不到启动时间也不能把它算回运行中。
    if (runnerChecks.get(runnerKey(m))?.state !== 'other') runnerChecks.delete(runnerKey(m));
    return false;
  }
  if (query && !runnerCheck(m)) checkRunners([m]);
  const state = runnerCheck(m);
  // 进程号还在、却核对不了身份（查不到启动时间，比如复用这个进程号的是没权限查看的进程）：保守算在运行，
  // 但不能永远占着名额。任务开始超过 25 小时（比任何合理的 --timeout 都长）还核对不了，就当已经结束；票据有自己的到期时间，不走这条
  if (state === 'unknown' && !m.ticket && Date.now() - Date.parse(m.started_at) > UNVERIFIED_LIMIT_MS) return false;
  return state !== 'other';
}
const UNVERIFIED_LIMIT_MS = 25 * 3600000;

export { RUNS_ROOT, boardUrl, liveBoardUrl, announceBoard, initializeRecords, CANCEL_FILE, UNFINISHED_STATUSES, CLAUDE_SESSION, isCancelled, requestCancel, cancelSource, writeWatchLauncher, newRunDir, listRuns, saveMeta, metaWriteWarning, settleMeta, findRun, describeActivity, groupRuns, checkAdmission, precheckAdmission, readRunsLocked, runEnd, runOutcome, resumeVerdict, resultValid, resumedRuns, groupTally, groupSummary, groupScopeOwner, absolute, readMeta, checkRunners, isRunning, writesFiles };
