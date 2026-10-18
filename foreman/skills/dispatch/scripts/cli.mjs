#!/usr/bin/env node
// 唯一入口：参数解析、子命令分发和适配器选择。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { USER_CONFIG, USER_PREFS, PROJECT_PREFS, LEGACY_PROJECT_PREFS, DEFAULT_AGENT_PARALLEL, CLAUDE_CODE, resolveAgentAlias, detectEnvironment, projectFile, loadConfig, pickProfile, unknownAgentError } from './config.mjs';
import { buildSummary } from './summary.mjs';
import { RUNS_ROOT, initializeRecords, findRun, readMeta } from './records.mjs';
import { adapters } from './adapters/index.mjs';
import { computeReviewScope } from './review-scope.mjs';
import { cmdWatch } from './watch.mjs';
import { cmdStatus, cmdCancel, cmdAwaitBusy } from './status.mjs';
import { cmdAssets } from './assets.mjs';
import { M, die, need, resolveDir, readBrief, isGitRepo, isAscii, agentTypeOf, closestMatches } from './util.mjs';

// 先加载配置，再迁移记录和重写启动器；这些步骤仍在解析参数之前完成。
const load = (cwd) => loadConfig(cwd, adapters);
const CONFIG = load(null);
initializeRecords(CONFIG);

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { 'add-dir': [], track: [], scope: [], file: [] };
  // assets 的第一个参数是动作（template、cut 等），不是选项。
  if (cmd === 'assets' && rest[0] && !rest[0].startsWith('--')) opts.action = rest.shift();
  const flags = new Set(['uncommitted', 'no-snapshot', 'verbose', 'no-intro', 'snap', 'vector', 'allow-edge']);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) die(M.badArg(a));
    const key = a.slice(2);
    if (flags.has(key)) { opts[key] = true; continue; }
    const val = rest[++i];
    if (val === undefined) die(M.missingValue(a));
    if (key === 'add-dir' || key === 'track' || key === 'scope' || key === 'file') opts[key].push(val);
    else opts[key] = val;
  }
  return { cmd, opts };
}

async function cmdRun(o) {
  if (o.group != null && !o.scope.length) die(M.groupNeedsScope);
  const cwd = resolveDir(need(o, 'cwd'));
  const cfg = load(cwd);
  const addDirs = o['add-dir'].map(resolveDir);
  const brief = readBrief(o);
  const profile = pickProfile(cfg, o, 'run', adapters);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'run', kind: 'exec', cwd, brief, addDirs, title: o.title, opts: o });
}

async function cmdDiscuss(o) {
  const cwd = resolveDir(need(o, 'cwd'));
  const cfg = load(cwd);
  const brief = readBrief(o);
  const profile = pickProfile(cfg, o, 'discuss', adapters);
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'discuss', kind: 'discuss', cwd, brief, title: o.title, round: 1, opts: o });
}

async function cmdResume(o) {
  const parent = findRun(need(o, 'run'));
  o.track = [...(parent.meta.track || []), ...o.track];
  o.group ??= parent.meta.group ?? null;
  if (!o.scope.length) o.scope = parent.meta.scope || [];
  const kind = parent.meta.kind || (parent.meta.mode === 'review' ? 'review' : 'exec');
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
    for (let rid = parent.id, m = parent.meta; m; rid = m.parent, m = m.parent ? readMeta(path.join(RUNS_ROOT, m.parent)) : null) {
      if (m.status === 'done') done++;
      rootId = rid;
    }
    round = done + 1;
    if (round > max) die(M.discussRoundsExceeded(rootId, done, max));
  }
  const cfg = load(parent.meta.cwd);
  const brief = readBrief(o);
  // 什么模型都没配置时沿用上一轮记录的模型，同一会话不中途换模型。
  const profile = pickProfile(cfg, o, discuss ? 'discuss' : 'run', adapters, parent.meta.model, parent.meta.agent || 'codex');
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'resume', kind, cwd: parent.meta.cwd, brief,
    title: o.title || parent.meta.title, parent: parent.id, parentDir: parent.dir, sessionId: parent.meta.session_id,
    previousRunAccess: parent.meta.run_access, round, opts: o });
}

async function cmdReview(o) {
  const cwd = resolveDir(need(o, 'cwd'));
  const cfg = load(cwd);
  const profile = pickProfile(cfg, o, 'review', adapters);
  const git = isGitRepo(cwd);
  const brief = readBrief(o, !git);
  let reviewScope = null;
  if (git) {
    try { reviewScope = computeReviewScope({ ...o, cwd }); } catch (e) { die(e.message); }
    if (!reviewScope.files.length) die(M.reviewEmpty(reviewScope.description));
  }
  return adapters[profile.agent.type].execute({ cfg, ...profile, mode: 'review', kind: 'review', cwd, brief, git, reviewScope, title: o.title, opts: o });
}

function cmdConfig(o) {
  const { sources, ...effective } = load(o.cwd ? resolveDir(o.cwd) : null);
  const agents_status = Object.fromEntries(Object.entries(effective.agents).map(([name, agent]) => [name, {
    type: agent.type, capabilities: adapters[agent.type].capabilities, model: agent.model || null, max_parallel: agent.max_parallel ?? DEFAULT_AGENT_PARALLEL,
    ...adapters[agent.type].status(agent),
  }]));
  const resolved = (entry) => ({ agent: entry.agent, model: entry.model || agents_status[entry.agent].model, effort: entry.effort ?? null });
  const resolved_levels = Object.fromEntries(Object.entries(effective.levels).map(([mode, levels]) => [mode,
    Object.fromEntries(Object.entries(levels).map(([lv, entry]) => [lv, entry === CLAUDE_CODE ? entry : Array.isArray(entry) ? entry.map(resolved) : resolved(entry)])),
  ]));
  // 配置里写的 key 不打印出来。
  const shown = structuredClone(effective);
  for (const agent of Object.values(shown.agents)) if (agent.api_key) agent.api_key = M.keyHidden;
  process.stdout.write(JSON.stringify({
    user_config: USER_CONFIG,
    loaded_from: sources,
    effective: shown,
    agents_status,
    resolved_levels,
    runs_dir: RUNS_ROOT,
    watch_launcher: path.join(RUNS_ROOT, 'watch.mjs'),
    watch_launcher_ascii: isAscii(path.join(RUNS_ROOT, 'watch.mjs')),
    preferences: [USER_PREFS, ...(o.cwd ? [projectFile(resolveDir(o.cwd), PROJECT_PREFS, LEGACY_PROJECT_PREFS)] : [])]
      .map((file) => ({ file, exists: fs.existsSync(file) })),
    environment: detectEnvironment(adapters, effective.agents),
    summary: buildSummary(effective, adapters),
  }, null, 2) + '\n');
}

// 所有协作方都报告，仅被等级引用的协作方影响总体结果。
async function cmdCheck(o) {
  const cfg = load(null);
  if (o.agent) o.agent = resolveAgentAlias(o.agent, cfg, true);
  if (o.agent && !Object.hasOwn(cfg.agents, o.agent)) die(unknownAgentError('--agent', o.agent, cfg));
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const gitVersion = git.status === 0 ? git.stdout.trim() : null;
  const [major, minor] = (/(\d+)\.(\d+)/.exec(gitVersion || '') || []).slice(1).map(Number);
  const gitOk = major > 2 || (major === 2 && minor >= 25);
  const result = {
    ok: nodeOk,
    node: { ok: nodeOk, version: process.version, fix: nodeOk ? null : M.fixNode(process.version) },
    git: { ok: gitOk, version: gitVersion, fix: gitOk ? null : M.fixGit(gitVersion) },
    // 只影响桌面版终端面板里的实时查看，不计入总体结果
    watch: { ok: isAscii(path.join(RUNS_ROOT, 'watch.mjs')), launcher: path.join(RUNS_ROOT, 'watch.mjs'), fix: isAscii(path.join(RUNS_ROOT, 'watch.mjs')) ? null : M.fixLauncherNotAscii },
    agents: {},
  };
  const variants = new Map();
  for (const [mode, levels] of Object.entries(cfg.levels)) {
    for (const [level, entry] of Object.entries(levels)) {
      const items = Array.isArray(entry) ? entry : [entry];
      for (const [index, item] of items.entries()) {
        if (item === CLAUDE_CODE || item.effort == null) continue;
        const model = item.model || cfg.agents[item.agent].model;
        const usedAt = `levels.${mode}.${level}${Array.isArray(entry) ? `[${index}]` : ''}`;
        if (!variants.has(item.agent)) variants.set(item.agent, []);
        const list = variants.get(item.agent);
        const existing = list.find((v) => v.model === model && v.variant === item.effort);
        if (existing) existing.used_at.push(usedAt);
        else list.push({ model, variant: item.effort, used_at: [usedAt] });
      }
    }
  }
  // 每个协作方被哪几类任务用到（Codex 按这个探测沙箱）。
  const usedModes = new Map();
  for (const [mode, levels] of Object.entries(cfg.levels)) {
    for (const entry of Object.values(levels)) {
      for (const item of entry === CLAUDE_CODE ? [] : Array.isArray(entry) ? entry : [entry]) usedModes.set(item.agent, new Set([...(usedModes.get(item.agent) || []), mode]));
    }
  }
  // 只在要核对推理强度时才读清单。
  const readCatalog = catalogReader();
  for (const [name, agent] of Object.entries(cfg.agents)) {
    if (!o.agent || o.agent === name) result.agents[name] = { ...await adapters[agent.type].check(name, agent, variants.get(name) || [], () => readCatalog(agent), [...(usedModes.get(name) || [])]), type: agent.type };
  }
  const referenced = new Set(Object.values(cfg.levels).flatMap((levels) => Object.values(levels).flatMap((entry) => entry === CLAUDE_CODE ? [] : (Array.isArray(entry) ? entry : [entry]).map((item) => item.agent))));
  result.ok = nodeOk && Object.entries(result.agents).every(([name, agent]) => !referenced.has(name) || agent.ok);
  result.summary = buildSummary(cfg, adapters, result.agents);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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
async function cmdModels() {
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
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
// 新建任务组时组名只用 ASCII：实时查看要把它写进终端命令，桌面版的终端面板只接受 ASCII 命令。
if (['run', 'discuss', 'resume'].includes(cmd) && opts.group != null && !/^[A-Za-z0-9._-]{1,64}$/.test(opts.group)) die(M.badGroupName(opts.group));
const commands = { run: cmdRun, discuss: cmdDiscuss, resume: cmdResume, review: cmdReview, status: (o) => cmdStatus(o, (meta) => adapters[agentTypeOf(meta)]?.stats?.(meta.session_id, meta.started_at)), watch: (o) => cmdWatch(o, load), config: cmdConfig, check: cmdCheck, models: cmdModels, cancel: cmdCancel, 'await-busy': (o) => cmdAwaitBusy(o, CONFIG), assets: cmdAssets };
if (!commands[cmd]) die(M.usage);
await commands[cmd](opts);
