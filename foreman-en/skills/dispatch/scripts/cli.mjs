#!/usr/bin/env node
// 唯一入口：参数解析、子命令分发和适配器选择。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HERE, M, die, need, resolveDir, readBrief, isGitRepo, isAscii, agentTypeOf, closestMatches, pathKey, pidExists, sleep, LANGUAGE } from './util.mjs';

// 不带值的选项；其余选项都把下一个参数当作它的值。
const FLAGS = new Set(['uncommitted', 'no-snapshot', 'verbose', 'no-intro', 'snap', 'vector', 'allow-edge', 'author']);

// --help（或 -h）只打印这一条子命令的用法（assets 可以带动作），退出码 0。和 parseArgs 一样走一遍参数，
// 写在某个选项的值里的（比如 --title --help、--title -h）不算。
const isHelp = (arg) => arg === '--help' || arg === '-h';
function helpText([cmd, ...rest]) {
  if (isHelp(cmd)) return M.usage;
  const action = cmd === 'assets' && rest[0] && !rest[0].startsWith('-') ? rest.shift() : null;
  let asked = false;
  for (let i = 0; i < rest.length && !asked; i++) {
    asked = isHelp(rest[i]);
    if (rest[i].startsWith('--') && !FLAGS.has(rest[i].slice(2))) i++;
  }
  if (!asked) return null;
  if (cmd !== 'assets') return Object.hasOwn(M.help, cmd) ? M.help[cmd] : die(M.usage);
  return !action ? M.assetsUsage : Object.hasOwn(M.assetsActions, action) ? M.assetsHelp(action) : die(M.assetsUsage);
}
const HELP = helpText(process.argv.slice(2));
if (HELP) { process.stdout.write(`${HELP}\n`); process.exit(0); }

// 其余模块在 --help 之后才加载：config.mjs 一加载就会迁移旧版的配置和偏好文件，--help 不该写任何文件。
const { USER_CONFIG, USER_PREFS, PROJECT_PREFS, LEGACY_PROJECT_PREFS, DEFAULT_AGENT_PARALLEL, CLAUDE_CODE, cellList, eachEntry, mapCells, resolveAgentAlias, detectEnvironment, projectFile, loadConfig, resolveProfile, validatePlan, unknownAgentError } = await import('./config.mjs');
const { cmdPlan, readPlan } = await import('./plan.mjs');
const { buildSummary } = await import('./summary.mjs');
const { configReport, environmentReport, modelsReport } = await import('./report.mjs');
const records = await import('./records.mjs');
const { adapters } = await import('./adapters/index.mjs');
const { validateReviewMaterial } = await import('./review-scope.mjs');
const { cmdWatch } = await import('./watch.mjs');
const { cmdStatus, cmdCancel, cmdAwaitBusy } = await import('./status.mjs');
const { cmdAssets } = await import('./assets.mjs');
const { cmdJudge, cmdStats } = await import('./stats.mjs');
const { cmdSubmit } = await import('./submissions.mjs');

// 先加载配置，再迁移记录和重写启动器；这些步骤仍在解析参数之前完成。
// assets 例外：它只在本机处理图片，用不到配置和记录目录，所以两步都跳过，配置缺失或写坏了也照样能用。
const load = (cwd) => loadConfig(cwd, adapters);
const CONFIG = process.argv[2] === 'assets' ? null : load(null);
if (CONFIG) records.initializeRecords(CONFIG);
const { RUNS_ROOT, CLAUDE_SESSION, findRun, isRunning } = records; // 记录目录在 initializeRecords 之后才定下来

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { 'add-dir': [], track: [], scope: [], file: [], ...(cmd === 'plan' ? { seat: [] } : {}) };
  // assets 的第一个参数是动作（template、cut 等），不是选项。
  if (cmd === 'assets' && rest[0] && !rest[0].startsWith('--')) opts.action = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) die(M.badArg(a));
    const key = a.slice(2);
    if (FLAGS.has(key)) { opts[key] = true; continue; }
    const val = rest[++i];
    if (val === undefined) die(M.missingValue(a));
    if (key === 'add-dir' || key === 'track' || key === 'scope' || key === 'file' || key === 'seat' && cmd === 'plan') opts[key].push(val);
    else opts[key] = val;
  }
  return { cmd, opts };
}

function dispatchProfile(o, module) {
  if (o.plan && o.seat == null) die(M.planNeedsSeat);
  if (o.seat != null && !o.plan) die(M.seatNeedsPlan);
  let seat = { module, cell: o.level };
  let plan;
  if (o.plan) {
    plan = readPlan(o.plan);
    if (!/^\d+$/.test(o.seat) || Number(o.seat) < 1 || Number(o.seat) > plan.seats.length) die(M.planSeatChoices(o.plan, plan.seats.length));
    if (plan.module !== module) die(M.planModuleMismatch(o.plan, plan.module, module));
    if (o.agent != null) die(M.planAgentFlag);
    if (o.level != null && o.level !== plan.cell) die(M.planLevelMismatch(o.plan, plan.cell, o.level));
    if (o.cwd != null && pathKey(path.resolve(o.cwd)) !== pathKey(plan.cwd)) die(M.planCwdMismatch(o.plan, plan.cwd));
    if (o.group != null && o.group !== plan.group) die(M.planGroupMismatch(o.plan, plan.group));
    o.cwd = plan.cwd;
    o.group = plan.group;
    if (module !== 'image') o.level = plan.cell;
    seat = { ...plan.seats[Number(o.seat) - 1], module, cell: plan.cell, plan: plan.plan_id, outside_cell: plan.outside_cell };
  }
  const cwd = resolveDir(need(o, 'cwd'));
  const cfg = load(cwd);
  // 席位数只在建计划时检查，配置调整后已有计划仍能启动。
  if (plan) validatePlan(cfg, plan, adapters);
  return { cwd, cfg, plan, profile: resolveProfile(cfg, seat, o, adapters) };
}

async function cmdRun(o) {
  const { cwd, cfg, profile } = dispatchProfile(o, 'run');
  if (o.group != null && !o.scope.length) die(M.groupNeedsScope);
  const addDirs = o['add-dir'].map(resolveDir);
  const brief = readBrief(o);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'run', kind: 'exec', cwd, brief, addDirs, title: o.title, opts: o });
}

// 图像席位沿执行流程启动，路线和格子固定在计划里。
async function cmdImage(o) {
  if (!o.plan) die(M.imageNeedsPlan);
  if (o.level != null) die(M.imageNoLevel);
  const { cwd, cfg, profile, plan } = dispatchProfile(o, 'image');
  if (!o.scope.length) die(M.imageNeedsScope);
  const addDirs = o['add-dir'].map(resolveDir);
  const brief = readBrief(o);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'run', kind: 'exec', step: profile.cell, route: plan.route, cwd, brief, addDirs, title: o.title, opts: o });
}

async function cmdDiscuss(o) {
  if (!o.plan) die(M.discussReviewNeedsPlan('discuss'));
  const { cwd, cfg, profile } = dispatchProfile(o, 'discuss');
  const brief = readBrief(o);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'discuss', kind: 'discuss', cwd, brief, title: o.title, round: 1, opts: o });
}

async function cmdResume(o) {
  const parent = findRun(need(o, 'run'));
  if (parent.meta.participant === 'host') die(M.hostNoResume(parent.id));
  if (isRunning(parent.meta)) die(M.resumeParentRunning(parent.id));
  if (o.group != null && o.group !== (parent.meta.group ?? null)) die(M.resumeGroupFixed(parent.meta.group ?? null));
  const addDirs = [...new Map([...(parent.meta.add_dir || []), ...o['add-dir'].map(resolveDir)].map((dir) => [pathKey(dir), dir])).values()];
  // 旧续接没记模块，沿祖先辨认任务类型。
  let origin = parent.meta;
  while (!origin.module && !origin.kind && origin.mode === 'resume' && origin.parent) origin = findRun(origin.parent).meta;
  const module = origin.module || ({ discuss: 'discuss', review: 'review', exec: 'run' }[origin.kind] || origin.mode);
  const image = module === 'image';
  if (image && o.level != null) die(M.imageNoLevel);
  o.track = [...(parent.meta.track || []), ...o.track];
  o.group ??= parent.meta.group ?? null;
  if (!o.scope.length) o.scope = parent.meta.scope || [];
  const kind = module === 'review' ? 'review' : module === 'discuss' ? 'discuss' : 'exec';
  if (kind === 'review') die(M.reviewNoResume);
  adapters[agentTypeOf(parent.meta)].validateResume?.(parent);
  const discuss = kind === 'discuss';
  if (o.group != null && !discuss && !o.scope.length) die(M.groupNeedsScope);
  let round = null;
  if (discuss) {
    const max = CONFIG.dispatch.discuss_max_rounds;
    if (!Number.isInteger(max) || max < 1) die(M.badDiscussMaxRounds);
    // 沿续接链往回数已经完成的轮次；卡死或失败后的续接仍算同一轮。
    let done = 0;
    let rootId = parent.id;
    for (let rid = parent.id, m = parent.meta; m; rid = m.parent, m = m.parent ? findRun(m.parent).meta : null) {
      if (m.status === 'done') done++;
      rootId = rid;
    }
    round = done + 1;
    if (round > max) die(M.discussRoundsExceeded(rootId, done, max));
  }
  const cfg = load(parent.meta.cwd);
  const brief = readBrief(o);
  // 什么模型都没配置时沿用上一轮记录的模型，同一会话不中途换模型。
  const profile = resolveProfile(cfg, { module: image ? 'image' : discuss ? 'discuss' : 'run', cell: image ? parent.meta.cell : undefined, plan: parent.meta.plan, seat: parent.meta.seat, role: parent.meta.role, outside_cell: parent.meta.outside_cell }, o, adapters, parent.meta.model, parent.meta.agent || 'codex', parent.meta.cell ?? parent.meta.level);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'resume', kind, cwd: parent.meta.cwd, brief, addDirs,
    ...(image ? { step: parent.meta.step, route: parent.meta.route } : {}),
    title: o.title || parent.meta.title, parent: parent.id, parentDir: parent.dir, sessionId: parent.meta.session_id,
    previousRunAccess: parent.meta.run_access, round, opts: o });
}

async function cmdReview(o) {
  if (!o.plan) die(M.discussReviewNeedsPlan('review'));
  if (o.plan && (o.target != null || o.file.length || o.uncommitted || o.base != null || o.commit != null)) die(M.planMaterialFlags(o.plan));
  const { cwd, cfg, profile, plan } = dispatchProfile(o, 'review');
  if (plan) Object.assign(o, plan.review || { target: 'diff', file: [], uncommitted: true, base: null, commit: null });
  const target = o.target || 'diff';
  const reviewScope = validateReviewMaterial({ ...o, cwd }, plan);
  if (target === 'visual' && !adapters[profile.agent.type].capabilities.reads_images) die(M.readsImagesRequired(profile.agentName, profile.agent.type));
  const git = isGitRepo(cwd);
  const brief = readBrief(o, target !== 'diff' || !git);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'review', kind: 'review', cwd, brief, git, reviewTarget: target, reviewScope, title: o.title, opts: o });
}

function cmdConfig(o) {
  const cfg = load(o.cwd ? resolveDir(o.cwd) : null);
  const { sources, closed_by_project, image_configured, ...effective } = cfg;
  // opencode、pi 没写 run_access 时派不了执行任务：列出的能力和派发时的检查保持一致，免得按 modes 挑人挑到派不出去的
  const capabilitiesOf = (agent) => {
    const c = adapters[agent.type].capabilities;
    return c.isolation === 'tools' && !agent.run_access ? { ...c, modes: c.modes.filter((mode) => mode !== 'run') } : c;
  };
  const agents_status = Object.fromEntries(Object.entries(effective.agents).map(([name, agent]) => [name, {
    type: agent.type, capabilities: capabilitiesOf(agent), model: agent.model || null, max_parallel: agent.max_parallel ?? DEFAULT_AGENT_PARALLEL,
    ...adapters[agent.type].status(agent),
  }]));
  const resolved = (entry) => ({ agent: entry.agent, model: entry.model || agents_status[entry.agent].model, effort: entry.effort ?? null, required: !!entry.required });
  const resolved_modules = mapCells(effective.modules, (value) => value === CLAUDE_CODE || value === null ? value : cellList(value).map(resolved));
  // 配置里写的 key 不打印出来。
  const shown = structuredClone(effective);
  for (const agent of Object.values(shown.agents)) if (agent.api_key) agent.api_key = M.keyHidden;
  const result = {
    user_config: USER_CONFIG,
    loaded_from: sources,
    effective: shown,
    agents_status,
    resolved_modules,
    closed_by_project,
    image_configured,
    runs_dir: RUNS_ROOT,
    watch_launcher: path.join(RUNS_ROOT, 'watch.mjs'),
    watch_launcher_ascii: isAscii(path.join(RUNS_ROOT, 'watch.mjs')),
    preferences: [USER_PREFS, ...(o.cwd ? [projectFile(resolveDir(o.cwd), PROJECT_PREFS, LEGACY_PROJECT_PREFS)] : [])]
      .map((file) => ({ file, exists: fs.existsSync(file) })),
    environment: detectEnvironment(adapters, effective.agents),
    summary: buildSummary(effective, adapters),
  };
  process.stdout.write(o.format === 'md' ? configReport(cfg, result.summary) : JSON.stringify(result, null, 2) + '\n');
}

async function cmdBoard(o) {
  if (o.session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.session)) die(M.badArg(`--session ${o.session}`));
  const cfg = load(null);
  if (!cfg.dispatch.web) {
    process.stdout.write(JSON.stringify({ enabled: false, message: M.boardOff }, null, 2) + '\n');
    return;
  }
  const boardDir = path.join(HERE, 'board');
  if (o.replay != null) {
    const { createInterface } = await import('node:readline');
    const args = [path.join(boardDir, 'server.mjs'), '--replay', o.replay, '--runs', RUNS_ROOT, '--config', USER_CONFIG, '--idle-min', '10'];
    for (const key of ['speed', 'maxgap']) if (o[key] != null) args.push(`--${key}`, o[key]);
    let child, reply;
    try {
      fs.mkdirSync(RUNS_ROOT, { recursive: true });
      child = spawn(process.execPath, args, { cwd: boardDir, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      reply = await new Promise((resolve) => {
        const lines = createInterface({ input: child.stdout });
        const finish = (value) => { clearTimeout(timer); lines.close(); child.stdout.destroy(); child.unref(); resolve(value); };
        const timer = setTimeout(() => finish({ error: 'timed out after 120 seconds' }), 120000);
        child.once('error', (error) => finish({ error: error.message }));
        child.once('close', (code) => finish({ error: `exit code ${code}` }));
        lines.once('line', (line) => {
          try { finish(JSON.parse(line)); } catch { finish({ error: 'invalid startup response' }); }
        });
      });
    } catch (error) { child?.kill(); die(M.boardStartFailed(error.message)); }
    if (reply.error) {
      child.kill();
      if (reply.code === 'NOT_FOUND') die(M.boardReplayNotFound(o.replay));
      if (reply.code === 'REPLAY_TOO_LARGE') die(M.boardReplayTooLarge((reply.bytes / 1024 ** 2).toFixed(1), (reply.limit / 1024 ** 2).toFixed(1)));
      die(M.boardStartFailed(reply.error));
    }
    try {
      const response = await fetch(new URL('health', reply.url), { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      process.stdout.write(JSON.stringify({ enabled: true, url: reply.url, started: true, replay: { target: o.replay, sessions: data.sessions } }, null, 2) + '\n');
    } catch (error) { child.kill(); die(M.boardStartFailed(error.message)); }
    return;
  }
  const [{ buildId }, { removeLock }] = await Promise.all([import('./board/build-id.mjs'), import('./board/lock.mjs')]);
  const build = buildId(boardDir);
  const lockFile = path.join(RUNS_ROOT, 'board.lock.json'), errFile = path.join(RUNS_ROOT, 'board.err');
  let reason = 'health check failed';
  // 只采信这次启动的子进程写下的 board.err（按 pid 认），别的尝试留下的不算
  const fail = (fallback, childPid) => {
    let message = fallback;
    try {
      const err = JSON.parse(fs.readFileSync(errFile, 'utf8'));
      if (childPid && err.pid === childPid && err.error) message = err.error;
    } catch { /* 没有这次的服务端错误时用退出原因 */ }
    die(M.boardStartFailed(message));
  };
  const reclaim = (raw) => { try { removeLock(lockFile, raw); } catch (error) { fail(error.message); } };
  const liveBoard = async (timeout = 1000) => {
    let raw, lock;
    try { raw = fs.readFileSync(lockFile, 'utf8'); lock = JSON.parse(raw); }
    catch (error) { reason = error.message; return { state: 'absent' }; }
    if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || !pidExists(lock.pid)) return { state: 'absent' };
    try {
      if (lock.port > 0) {
        const response = await fetch(`http://127.0.0.1:${lock.port}/${lock.token}/health`, { signal: AbortSignal.timeout(timeout) });
        const health = await response.json();
        if (response.ok && health.ok === true && health.v === 1 && health.pid === lock.pid) return { state: 'ready', lock, raw, build: health.build };
        reason = 'health check failed';
      }
    } catch (error) {
      reason = error.message;
      if (error.cause?.code === 'ECONNREFUSED') return { state: 'absent' };
    }
    return { state: 'wait', lock, raw };
  };
  const existingDeadline = Date.now() + 15000;
  let found = await liveBoard(5000);
  while (found.state === 'wait' && Date.now() < existingDeadline) {
    await sleep(100);
    found = await liveBoard(Math.max(1, Math.min(1000, existingDeadline - Date.now())));
  }
  // 等了 15 秒还没回应就接管；原来的服务恢复后发现锁不是自己的会自行退出
  if (found.state === 'wait') reclaim(found.raw);
  let lock = found.state === 'ready' ? found.lock : null;
  if (lock && found.build !== build) {
    try { process.kill(lock.pid); } catch (error) { if (error.code !== 'ESRCH') fail(error.message); }
    // POSIX 上旧服务正忙时信号要等同步读取结束才处理，和接管一样最多等 15 秒；
    // Windows 上 kill 是强制结束，旧服务来不及自己删锁，所以只等进程退出，锁由下面回收
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && pidExists(lock.pid)) await sleep(100);
    if (pidExists(lock.pid)) fail(`old board server (pid ${lock.pid}) did not exit`);
    reclaim(found.raw);
    lock = null;
  }
  const started = !lock;
  if (!lock) {
    let spawnError, exited, child;
    try {
      fs.mkdirSync(RUNS_ROOT, { recursive: true });
      fs.rmSync(errFile, { force: true });
      // Windows 上必须脱离调用方控制台，否则后续命令的 Ctrl+C 会把看板一起停掉。
      child = spawn(process.execPath, [path.join(boardDir, 'server.mjs'), '--runs', RUNS_ROOT, '--config', USER_CONFIG, '--idle-min', '30'], {
        cwd: boardDir, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code) => { exited = `exit code ${code}`; });
      child.unref();
    } catch (error) { fail(error.message); }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      found = await liveBoard(Math.max(1, Math.min(1000, deadline - Date.now())));
      lock = found.state === 'ready' ? found.lock : null;
      if (lock) break;
      if (spawnError || exited) fail(spawnError?.message || exited, child.pid);
      await sleep(Math.max(0, Math.min(100, deadline - Date.now())));
    }
    if (!lock) fail(reason, child.pid);
  }
  const session = o.session ?? CLAUDE_SESSION;
  const url = `http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=${encodeURIComponent(LANGUAGE)}${session ? `&s=${encodeURIComponent(session)}` : ''}`;
  process.stdout.write(JSON.stringify({ enabled: true, url, started }, null, 2) + '\n');
}

// 所有协作方都报告，仅被等级引用的协作方影响总体结果。
async function cmdCheck(o) {
  const cfg = load(o.cwd ? resolveDir(o.cwd) : null);
  if (o.agent) o.agent = resolveAgentAlias(o.agent, cfg, true);
  if (o.agent && !Object.hasOwn(cfg.agents, o.agent)) die(unknownAgentError('--agent', o.agent, cfg));
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const gitVersion = git.status === 0 ? git.stdout.trim() : null;
  const [major, minor] = (/(\d+)\.(\d+)/.exec(gitVersion || '') || []).slice(1).map(Number);
  const gitOk = major > 2 || (major === 2 && minor >= 25);
  const [total_gb, available_gb] = (process.env.FOREMAN_TEST_MEMORY
    ? process.env.FOREMAN_TEST_MEMORY.split(',').map(Number)
    : [os.totalmem() / 1024 ** 3, os.freemem() / 1024 ** 3]).map((gb) => Math.round(gb * 10) / 10);
  const result = {
    ok: nodeOk,
    node: { ok: nodeOk, version: process.version, fix: nodeOk ? null : M.fixNode(process.version) },
    git: { ok: gitOk, version: gitVersion, fix: gitOk ? null : M.fixGit(gitVersion) },
    // 只影响桌面版终端面板里的实时查看，不计入总体结果
    watch: { ok: isAscii(path.join(RUNS_ROOT, 'watch.mjs')), launcher: path.join(RUNS_ROOT, 'watch.mjs'), fix: isAscii(path.join(RUNS_ROOT, 'watch.mjs')) ? null : M.fixLauncherNotAscii },
    memory: { total_gb, available_gb, enough: total_gb >= 8 && (process.platform === 'darwin' || available_gb >= 2), web: cfg.dispatch.web },
    agents: {},
  };
  const variants = new Map(), usedModes = new Map();
  for (const { module, at, item } of eachEntry(cfg.modules)) {
    const mode = module === 'image' ? 'run' : module;
    usedModes.set(item.agent, new Set([...(usedModes.get(item.agent) || []), mode]));
    if (item.effort == null) continue;
    const model = item.model || cfg.agents[item.agent].model;
    if (!variants.has(item.agent)) variants.set(item.agent, []);
    const list = variants.get(item.agent);
    const existing = list.find((v) => v.model === model && v.variant === item.effort);
    if (existing) existing.used_at.push(at);
    else list.push({ model, variant: item.effort, used_at: [at] });
  }
  // 只在要核对推理强度时才读清单。
  const readCatalog = catalogReader();
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (!o.agent || o.agent === name) result.agents[name] = { ...await adapters[agent.type].check(name, agent, variants.get(name) || [], () => readCatalog(agent), [...(usedModes.get(name) || [])]), type: agent.type };
  }
  const referenced = new Set(eachEntry(cfg.modules).map(({ item }) => item.agent));
  result.ok = nodeOk && Object.entries(result.agents).every(([name, agent]) => !referenced.has(name) || agent.ok);
  result.summary = buildSummary(cfg, adapters, result.agents);
  process.stdout.write(o.format === 'md'
    ? environmentReport(result, detectEnvironment(adapters, cfg.agents), cfg.agents) + '\n' + configReport(cfg, result.summary, result.agents)
    : JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}

// 同一种工具、同一个可执行文件的清单只读一次，用这个可执行文件的协作方共用。
function catalogReader() {
  const catalogs = new Map();
  return (agent) => {
    const key = `${agent.type}\0${agent.bin ?? ''}`;
    if (!catalogs.has(key)) catalogs.set(key, adapters[agent.type].catalog(agent));
    return catalogs.get(key);
  };
}

// 本机能用的模型和推理强度清单：Codex、opencode 和 pi 读本机清单，API 读厂商的 /models（不含推理强度）。
async function cmdModels(o) {
  const cfg = load(null);
  const out = { tools: {}, api: {}, agents: {} };
  const readCatalog = catalogReader();
  for (const type of ['codex cli', 'opencode cli', 'pi cli']) {
    out.tools[type] = readCatalog(Object.values(cfg.agents).find((a) => a.type === type) || { type });
  }
  for (const [name, agent] of Object.entries(cfg.agents)) if (agent.type === 'api') out.api[name] = await adapters.api.catalog(agent);
  // 配置里每个协作方的模型在不在它自己那个可执行文件的清单里，在的话支持哪些推理强度；不在的给出最接近的写法。
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const cat = agent.type === 'api' ? out.api[name] : readCatalog(agent);
    const model = agent.model ?? adapters[agent.type].status(agent).model ?? null;
    const found = cat.ok ? cat.models.find((m) => m.id === model) : null;
    out.agents[name] = { type: agent.type, model, listed: cat.ok && model ? !!found : null, efforts: found?.efforts ?? null,
      closest: cat.ok && model && !found ? closestMatches(model, cat.models.map((m) => m.id)) : [] };
  }
  process.stdout.write(o.format === 'md' ? modelsReport(out) : JSON.stringify(out, null, 2) + '\n');
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
// 上限一天：再大的数会让到期时刻超出 Date 的范围
if (opts['queue-timeout'] !== undefined && (!Number.isFinite(Number(opts['queue-timeout'])) || Number(opts['queue-timeout']) < 0 || Number(opts['queue-timeout']) > 1440)) die(M.queueTimeoutInvalid);
if (['config', 'check', 'models'].includes(cmd) && opts.format !== undefined && !['json', 'md'].includes(opts.format)) die(M.reportFormatInvalid);
// 新建任务组时组名只用 ASCII：实时查看要把它写进终端命令，桌面版的终端面板只接受 ASCII 命令。
if (['run', 'discuss', 'resume', 'review', 'image', 'plan'].includes(cmd) && opts.group != null && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.group)) die(M.badGroupName(opts.group));
const statsOf = (meta) => adapters[agentTypeOf(meta)]?.stats?.(meta.session_id, meta.started_at);
const commands = { run: cmdRun, discuss: cmdDiscuss, resume: cmdResume, review: cmdReview, image: cmdImage, plan: (o) => cmdPlan(o, load, adapters), submit: (o) => cmdSubmit(o, load), judge: cmdJudge, stats: (o) => cmdStats(o, statsOf), status: (o) => cmdStatus(o, statsOf), watch: (o) => cmdWatch(o, load), board: cmdBoard, config: cmdConfig, check: cmdCheck, models: cmdModels, cancel: (o) => cmdCancel(o, statsOf), 'await-busy': (o) => cmdAwaitBusy(o, CONFIG, load), assets: cmdAssets };
if (!commands[cmd]) die(M.usage);
await commands[cmd](opts);
