// Opencode CLI：代理权限与环境、事件翻译、会话导出和检查项。
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../review-scope.mjs';
import { newRunDir, isCancelled, cancelSource, announceBoard } from '../records.mjs';
import { startRun, finishDiscussion, execute, eventWriter, runLimits, reportWithRepair, spawnCli, validateSchema } from '../runner.mjs';
import { M, LANGUAGE, die, isObject, binCommand, pathCommand, npmEntry, killTree, readAttachments, filesOutside, scanLinks, resolveRealPath, focusFiles, relativePath, closestMatches } from '../util.mjs';
import { D, modelLabel, toolLabel } from '../format.mjs';

function opencodeCommand(agent) {
  if (agent.bin) return binCommand(agent.bin);
  if (process.platform !== 'win32') return pathCommand('opencode', [path.join(os.homedir(), '.opencode', 'bin')]);
  return binCommand(npmEntry('@opencode', 'cli', 'bin', 'opencode.exe') || 'opencode.exe');
}

const OPENCODE_AGENT = 'foreman-discuss';
const AGENT_SUFFIX = randomBytes(4).toString('hex');
const RUN_ACCESS = ['edit', 'shell'];
const WRITE_SCAN_LIMIT = 300000;
const WRITE_RULES_BUDGET = 12000;
// 单个环境变量的长度上限（留了余量），以及注入代理里除链接规则以外的部分预留的长度。
const ENV_LIMIT = process.platform === 'win32' ? 32000 : 120000;
const FIXED_RULES_ROOM = 4000;
// 写进这些目录和文件，等于改 git 钩子、Claude Code 和各协作方的配置，之后会被执行；执行档不许写，项目里哪一层都一样。目录和 agy、CodeBuddy 的守卫保护的一致。
const PROTECTED_DIRS = ['.git', '.claude', '.opencode', '.codebuddy', '.gemini', '.agents', '.agent', '_agents', '_agent', '.pnpm', '.pnpm-store'];
const PROTECTED_FILES = ['opencode.json', 'opencode.jsonc'];
const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'tools', reads_code: true, reads_images: false, native_schema: false, native_review: false, images: false, resume: true, command_start_events: false };
const websearchByCwd = new Map();

function opencodeUserConfig() {
  const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}');
  return isObject(config) ? config : {};
}

// 没配搜索服务时，无头运行一调用 websearch 就会整轮失败。
function opencodeWebsearchReady(agent, cwd) {
  if (websearchByCwd.has(cwd)) return websearchByCwd.get(cwd);
  let ready = false;
  try {
    // 无法注入的用户配置不能用于判断网页搜索权限。
    const config = opencodeUserConfig();
    const { file, pre } = opencodeCommand(agent);
    // 和 opencode run 一样把 PWD 设成项目目录：opencode 按 PWD 找项目里的配置。
    const r = spawnSync(file, [...pre, 'debug', 'config', '--standalone'], { cwd, env: { ...process.env, PWD: cwd }, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const documents = !r.error && r.status === 0 ? JSON.parse(r.stdout) : null;
    if (Array.isArray(documents)) {
      const websearch = [
        ...documents.filter((doc) => doc?.type === 'document').map((doc) => doc.info?.websearch),
        config.websearch,
      ].findLast((value) => value !== undefined);
      ready = isObject(websearch) && typeof websearch.provider === 'string' && websearch.provider.trim() !== '';
    }
  } catch { /* 读取失败时保持关闭 */ }
  websearchByCwd.set(cwd, ready);
  return ready;
}

// 代理名在每个进程加一个随机后缀，任何配置都事先写不出同名条目。同一份配置里同名的 agents、mode 条目，{env:}、{file:} 展开出来的名字，顶层 __proto__ 继承来的条目，都会顶掉插件写的代理和它的权限（opencode 2.3.2 实测）。
function opencodeAgentName(agentId) {
  return `${agentId}-${AGENT_SUFFIX}`;
}

function writePathPatterns(file) {
  // opencode 读配置时会把数字键排到默认允许规则前面，根下的纯数字路径用 * 后缀保住拒绝顺序。
  return [/^\d+$/.test(file) ? `${file}*` : file, `${file}/*`];
}

function safeWritePath(file) {
  // opencode 会展开规则开头的 ~ 和 $HOME，也会替换 {env:…}、{file:…}，这些名字写进规则就不再是原来的路径。
  while (file === '*' || file.startsWith('~') || /[{}]/.test(file) || file.includes('$HOME')
    || file.split('/').some((part) => ['__proto__', 'constructor', 'prototype'].includes(part))) {
    file = path.posix.dirname(file);
  }
  if (file === '.') throw new Error(M.opencodeUnsafeWriteRules());
  return file;
}

function gitWriteDirs(cwd) {
  const dirs = new Set(), worktrees = new Set(), root = fs.realpathSync.native(cwd);
  const inside = (target) => {
    const rel = path.relative(root, target);
    return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : rel.split(path.sep).join('/') || '.';
  };
  for (const args of [['--absolute-git-dir'], ['--git-common-dir'], ['--git-path', 'hooks']]) {
    const r = spawnSync('git', ['rev-parse', ...args], { cwd, timeout: 10000, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) break;
    const raw = r.stdout.replace(/\r?\n$/, ''), target = resolveRealPath(raw, cwd);
    if (target === null) throw new Error(M.opencodeGitPathUnresolved(raw));
    const rel = inside(target);
    if (rel !== null) dirs.add(rel);
  }
  // worktree_remove 按 edit 判断权限，按工具名拒绝管不住它；登记在项目里的工作树整个不许写。
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, timeout: 10000, encoding: 'utf8', windowsHide: true });
  if (list.status === 0) for (const line of list.stdout.split(/\r?\n/)) {
    if (!line.startsWith('worktree ')) continue;
    const target = resolveRealPath(line.slice('worktree '.length), cwd);
    const rel = target === null ? null : inside(target);
    // 用 --separate-git-dir 建的仓库，git 会把元数据目录也当成一个工作树列出来，它已经在 dirs 里了。
    if (rel !== null && rel !== '.' && !dirs.has(rel)) worktrees.add(rel);
  }
  return { dirs, worktrees };
}

// 规则太多时优先合并项最多的父目录，避免注入的配置过大。按组大小记索引，只更新受合并影响的组。
function boundWritePaths(paths, budget) {
  const counts = new Map();
  let size = 1; // 每条规则的长度计入一个逗号，首尾括号再净加一个字符。
  const count = (file, delta) => {
    for (const pattern of writePathPatterns(file)) {
      const before = counts.get(pattern) || 0, after = before + delta;
      if (after) counts.set(pattern, after);
      else counts.delete(pattern);
      if (!before || !after) size += delta * (JSON.stringify(pattern).length + ':"deny",'.length);
    }
  };
  for (const file of paths.keys()) count(file, 1);
  if (size <= budget) return;

  const children = new Map(), parentsBySize = [];
  let largest = 0;
  const group = (file) => {
    const parent = path.posix.dirname(file);
    if (parent === '.' || parent === '*') return;
    let siblings = children.get(parent);
    if (siblings) parentsBySize[siblings.length].delete(parent);
    else children.set(parent, siblings = []);
    siblings.push(file);
    (parentsBySize[siblings.length] ??= new Set()).add(parent);
    largest = Math.max(largest, siblings.length);
  };
  for (const file of paths.keys()) group(file);
  while (size > budget) {
    while (largest && !parentsBySize[largest].size) largest--;
    if (!largest) throw new Error(M.opencodeUnsafeWriteRules());
    const parents = parentsBySize[largest], parent = parents.values().next().value;
    parents.delete(parent);
    for (const child of children.get(parent)) {
      paths.delete(child);
      count(child, -1);
    }
    children.delete(parent);
    if (!paths.has(parent)) {
      count(parent, 1);
      group(parent);
    }
    paths.set(parent, true);
  }
}

function opencodeWriteRules(cwd) {
  const { links, unreadable, unscanned } = scanLinks(cwd, { limit: WRITE_SCAN_LIMIT });
  const edit = Object.create(null), paths = new Map(), gitBlocked = [];
  const deny = (file) => { for (const pattern of writePathPatterns(file)) edit[pattern] = 'deny'; };
  const add = (file, blocked) => {
    const safe = safeWritePath(file);
    paths.set(safe, blocked || safe !== file || paths.get(safe) === true);
  };
  for (const { path: file } of links) add(file, false);
  for (const dir of unreadable) add(dir, true);
  for (const dir of unscanned) add(dir, true);
  // 整份注入配置（加上用户自己的 OPENCODE_CONFIG_CONTENT）要装进一个环境变量：Windows 约 3.2 万字符，Linux 约 12.8 万字节。
  const userConfig = process.env.OPENCODE_CONFIG_CONTENT ?? '';
  const size = (text) => process.platform === 'win32' ? text.length : Buffer.byteLength(text);
  const budget = Math.min(WRITE_RULES_BUDGET, ENV_LIMIT - size(userConfig) - FIXED_RULES_ROOM);
  if (budget <= 0) throw new Error(M.opencodeConfigTooLarge(ENV_LIMIT));
  boundWritePaths(paths, budget);

  edit['*'] = 'allow';
  for (const name of PROTECTED_DIRS) { deny(name); deny(`*/${name}`); }
  for (const name of PROTECTED_FILES) { edit[name] = 'deny'; edit[`*/${name}`] = 'deny'; }
  for (const rule of ['/*', '..', '../*']) edit[rule] = 'deny';
  const git = gitWriteDirs(cwd);
  for (const dir of [...git.dirs, ...git.worktrees]) {
    const safe = safeWritePath(dir);
    deny(safe);
    if (safe !== dir || git.worktrees.has(dir)) gitBlocked.push(safe);
  }
  for (const file of paths.keys()) deny(file);
  // Windows 短名和 NTFS 流写法都能绕过仅用原名的规则。
  if (process.platform === 'win32') Object.assign(edit, { '*~*': 'deny', '*:*': 'deny' });
  if (size(userConfig) + size(JSON.stringify(edit)) + FIXED_RULES_ROOM > ENV_LIMIT) throw new Error(M.opencodeConfigTooLarge(ENV_LIMIT));
  const blocked = new Set(gitBlocked);
  for (const [file, wholeDirectory] of paths) if (wholeDirectory) blocked.add(file);
  return { edit, links: links.map((link) => link.path), blocked: [...blocked] };
}

function writeRuleList(paths) {
  const more = paths.length - 10;
  const rest = more > 0 ? (LANGUAGE === 'en' ? ` and ${more} more` : ` 等 ${more} 个`) : '';
  return M.list(paths.slice(0, 10)) + rest;
}

function opencodeEnv(agentId = OPENCODE_AGENT, access, web, edit) {
  let config = {};
  try { config = opencodeUserConfig(); } catch { /* 无效配置由本次注入替代 */ }
  const descriptions = { 'foreman-discuss': 'Read-only code discussion for foreman', 'foreman-review': 'Read-only code review for foreman',
    'foreman-run': 'Hands-on work for foreman', 'foreman-repair': 'Report format repair for foreman' };
  const permission = { '*': 'deny' };
  if (agentId !== 'foreman-repair') Object.assign(permission, { read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  if (web && [OPENCODE_AGENT, 'foreman-run'].includes(agentId)) {
    permission.webfetch = 'allow';
    if (web === true) permission.websearch = 'allow';
  }
  if (agentId === 'foreman-run') {
    permission.edit = edit;
    permission.worktree_remove = 'deny';
    permission.worktree_create = 'deny';
    if (access === 'shell') permission.shell = 'allow';
  }
  const agent = { mode: 'primary', description: descriptions[agentId], permission };
  // edit 档不能跑命令，但 opencode 写完文件会执行配置里的格式化命令，项目的 opencode.json 里的也算。formatter: false 能关掉它们，项目配置盖不过这一项（opencode 2.3.2 实测）。shell 档本来就能跑命令，照旧。
  const formatter = agentId === 'foreman-run' && access === 'edit' ? { formatter: false } : {};
  return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, ...formatter,
    agent: { ...(isObject(config.agent) ? config.agent : {}), [opencodeAgentName(agentId)]: agent } }) };
}

// 私有服务才会读取本次注入的代理配置，也能随 run 一起终止。
const opencodeArgs = (model, effort, agentId = OPENCODE_AGENT) =>
  ['run', '--standalone', '--format', 'json', '--agent', opencodeAgentName(agentId), '-m', `${model}${effort != null ? `#${effort}` : ''}`];

function permissionQuestions(actions, lines, cwd) {
  // 路径按工作目录解析：项目里的显示相对路径，项目外的显示绝对路径（模型常给出一长串 ../）。
  const relative = (value) => {
    if (typeof value !== 'string' || !value) return value;
    const abs = path.resolve(cwd, value), rel = relativePath(cwd, abs);
    return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) ? abs : rel;
  };
  const pathKeys = new Set(['path', 'filePath', 'file', 'directory']);
  const replacer = (key, value) => (pathKeys.has(key) ? relative(value) : value);
  const details = (tool, input) => JSON.stringify({ tool, input }, replacer);
  const questions = actions.map(({ tool, state }) => ({ source: 'permission_denied',
    question: `${tool} ${JSON.stringify(state.input || {}, replacer)}`,
    detail: details(tool, state.input || {}) }));
  for (const line of lines) {
    const operation = /permission requested:\s*(.+?);\s*auto-rejecting/i.exec(line)?.[1];
    if (!operation) continue;
    const match = /^(\S+)\s*\((.*)\)$/.exec(operation);
    const tool = match?.[1] || operation, target = relative(match?.[2] || '');
    // 同一次拒绝可能同时出现在 stderr 和工具结果里，优先保留带完整参数的工具结果。
    if (questions.some((q) => q.detail === details(tool, target ? { path: target } : {})
      || (target && (tool === 'external_directory' || JSON.parse(q.detail).tool === tool)
        && q.detail.includes(JSON.stringify(target).slice(1, -1).replace(/\*.*$/, ''))))) continue;
    questions.push({ source: 'permission_denied', question: target ? `${tool} (${target})` : tool,
      detail: details(tool, target ? { path: target } : {}) });
  }
  return [...new Map(questions.map((q) => [q.detail, q])).values()];
}

function runOpencode({ agent, args, cwd, prompt = '', timeoutMs, stallMin = 0, runDir, onEvent, agentId, web, edit }) {
  return new Promise((resolve) => {
    const { file, pre } = opencodeCommand(agent);
    const out = { code: null, status: null, stdout: '', stderrTail: '', text: '', errors: [], recovered: [], events: 0, messages: [], questions: [] };
    const denied = [], stderrLines = [], eventErrors = [];
    let stopped = false, endedOnText = false;
    // opencode 按环境变量 PWD 认工作目录，不看进程真实的 cwd；PWD 是从调用方的 shell 继承来的，可能指向别的目录。
    const child = spawnCli(file, [...pre, ...args], { cwd, env: { ...opencodeEnv(agentId, agent.run_access, web, edit), PWD: cwd }, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, {
      onStderrLine: (line) => { if (/permission requested:/i.test(line)) stderrLines.push(line); },
      onInput: (line, min) => {
        out.status = 'needs_input';
        out.questions.push({ source: 'input_prompt', question: line });
        out.errors.push(M.inputWaitDetected(min, line));
      },
    });
    const stop = (status) => { if (out.status) return; out.status = status; if (child.pid) killTree(child.pid); };
    const onSignal = () => stop('cancelled');
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let lastEventAt = Date.now();
    let buf = '';
    const record = (line) => {
      if (runDir) fs.appendFileSync(path.join(runDir, 'opencode.jsonl'), line + '\n');
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!isObject(ev) || !ev.type) return;
      lastEventAt = Date.now();
      out.events++;
      if (ev.type === 'text') { out.text = ev.part?.text || ''; out.messages.push(out.text); }
      if (ev.type === 'tool_use' && ev.part?.state?.status === 'error'
        && /permission|rejected|not allowed/i.test(JSON.stringify(ev.part.state.error || ev.part.state.output || ''))) denied.push(ev.part);
      if (ev.type === 'step_finish') stopped = ev.part?.reason === 'stop';
      // 出错重试后，有时最后一步写完回复就退出、不发 step_finish（20261021-030953-7ce3），所以记下事件流是不是以一段写完的回复结尾。
      endedOnText = ev.type === 'text' && ev.part?.time?.end != null;
      if (ev.type === 'error') {
        stopped = false;
        eventErrors.push(ev.error?.message || ev.error?.type || JSON.stringify(ev));
      }
      onEvent?.(ev);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onEvent) out.stdout += chunk;
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { record(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      out.stderrTail = (out.stderrTail + chunk).slice(-4000);
      if (runDir) fs.appendFileSync(path.join(runDir, 'stderr.log'), chunk);
    });
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    const poll = setInterval(() => {
      if (runDir && isCancelled(runDir)) stop('cancelled');
      else if (stallMin && Date.now() - lastEventAt >= stallMin * 60000) stop('stalled');
    }, 1000);
    child.on('error', (e) => out.errors.push(e.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (buf.trim()) record(buf);
      out.questions.push(...permissionQuestions(denied, stderrLines, cwd));
      out.code = code;
      if (runDir && isCancelled(runDir)) out.status = 'cancelled';
      // 最后一次 step_finish 是 stop、或者最后一个事件是写完的回复，且后面没有 error，才算恢复，CLI 此时仍可能以 1 退出。
      // 回复只是报告残片时，照常走一次格式修复。
      (stopped || endedOnText ? out.recovered : out.errors).push(...eventErrors);
      out.status ||= out.errors.some((e) => /usage limit|quota|insufficient balance/i.test(e)) ? 'quota_exhausted'
        : (code === 0 || out.recovered.length > 0) && !out.errors.length ? 'done' : 'failed';
      if (!out.events && out.status === 'failed') out.errors.push(M.exitCode(code, out.stderrTail.trim().split(/\r?\n/).slice(-6).join('\n'), 'opencode'));
      resolve(out);
    });
    child.stdin.on('error', () => { /* 提前退出时忽略 EPIPE */ });
    child.stdin.end(prompt, 'utf8');
  });
}

const readonlyLevel = (agent, kind) => 'tools';

async function executeOpencode(ctx) {
  const { model, agent, level, cwd, brief, mode, opts } = ctx;
  if (ctx.parent && !ctx.sessionId) die(M.noSession(ctx.parent));
  const review = ctx.kind === 'review', exec = ctx.kind === 'exec';
  const agentId = review ? 'foreman-review' : exec ? 'foreman-run' : OPENCODE_AGENT;
  const schemaText = fs.readFileSync(review ? REVIEW_SCHEMA : exec ? SCHEMA : DISCUSS_SCHEMA, 'utf8');
  const schema = JSON.parse(schemaText);
  const files = readAttachments(opts.file, cwd, false), outside = filesOutside(files, [cwd]);
  if (outside.length) die(M.filesOutsideCwd(ctx.agentName, M.list(outside), false));
  const discussWeb = !review && !exec && (opencodeWebsearchReady(agent, cwd) || 'read');
  let prompt;
  if (review) {
    const scope = ctx.reviewScope;
    const opening = { files: M.reviewPromptFiles, claims: M.reviewPromptClaims }[ctx.reviewTarget];
    const parts = [opening ? opening(cwd) : scope ? M.opencodeReviewPrompt(cwd, scope.description) : M.reviewPromptPlain(cwd)];
    if (brief) parts.push(brief);
    if (files.length) parts.push(focusFiles(files).trim());
    if (scope?.target === 'diff') {
      const material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
      if (material.tooLarge) die((scope.kind === 'commit' ? M.reviewCommitTooLarge : M.reviewTooLarge)(material.chars, MAX_REVIEW_CHARS));
      parts.push(M.reviewMaterial(material.fileList, material.patch, material.fence, material.note));
    }
    prompt = [...parts, M.reviewFooter(ctx.reviewTarget), M.reviewSchemaFooter(schemaText)].join('\n\n') + '\n';
  } else if (exec) prompt = ctx.parent
    ? `${brief}${focusFiles(files)}\n\n${M.resumeFooter}\n\n${M.opencodeRunResumeFooter}\n`
    : `${brief}\n\n${M.footer(cwd, ctx.addDirs || [], true)}\n\n${M.opencodeRunFooter(schemaText, agent.run_access, true)}\n`;
  else prompt = `${brief}${focusFiles(files)}\n\n${ctx.parent ? M.opencodeResumeFooter : M.opencodeDiscussFooter(cwd, schemaText, discussWeb)}\n`;
  const { id, dir, release } = await newRunDir(ctx);
  const context = { ...ctx, ...(exec ? {} : { readonly: readonlyLevel(agent, ctx.kind) }), id, dir, release, prompt };
  if (exec) return execute(context, {
    capabilities, describe: () => ({ sandbox: null, modelShown: model, modelName: model }),
    run: ({ run }) => opencodeSession(run, schema, agentId),
  });
  const run = startRun(context);
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${D.started(mode, modelLabel(run.meta), level, dir)}\n`);
  announceBoard(ctx.cfg, mode, modelLabel(run.meta), level);
  return finishDiscussion(run, { ...await opencodeSession(run, schema, agentId, discussWeb), files, changesNote: M.opencodeNoChanges });
}

async function opencodeSession(run, schema, agentId, web) {
  const { ctx, started, meta, writeMeta } = run;
  const { dir, agentName, agent, model, effort, cwd, prompt } = ctx;
  const exec = ctx.kind === 'exec';
  const limits = runLimits(ctx, started), { deadline } = limits;
  const stallMin = exec && agent.run_access === 'shell' && !capabilities.command_start_events ? 0 : limits.stallMin;
  const event = eventWriter(dir);
  // events.jsonl 只追加：开工前 runner 已经记下了拍快照的事件，不能清掉
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '');
  for (const file of ['opencode.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, file), '');
  const errors = [], warnings = [], notes = [];
  let writeRules;
  if (exec) {
    try { writeRules = opencodeWriteRules(cwd); }
    catch (error) {
      // 预检就拒绝启动，模型一次也没调用：标成没启动，统计里不算这一席。
      return { status: 'failed', code: 1, errors: [error.message], warnings, fileChanges: new Set(), images: [], commands: 0, usage: null, cost: null, not_started: true };
    }
    if (writeRules.links.length) notes.push(M.opencodeLinksDenied(writeRuleList(writeRules.links)));
    if (writeRules.blocked.length) notes.push(M.opencodeWriteBlocked(writeRuleList(writeRules.blocked)));
    web = opencodeWebsearchReady(agent, cwd) || 'read';
  }
  const recovered = new Set();
  const observed = { messages: [], questions: [] };
  let repairing = false;
  const fileChanges = new Set();
  let commands = 0, items = 0, seenSession = false, last = '', report = null;
  const sentUsage = {};
  let lastUsageAt = null, pendingStepAt = null, usageTo = started;
  // 翻译成 Codex 的事件形状，让 watch 和 status 共用现有的时间线、命令和报告显示。
  const translate = (ev) => {
    if (ev.sessionID && !seenSession) {
      seenSession = true;
      meta.session_id = ev.sessionID;
      writeMeta();
      event({ type: 'thread.started', thread_id: ev.sessionID });
    }
    // 修复请求仍可能没有 step_finish，最早未结算的生成起点必须保留。
    if (ev.type === 'step_start') pendingStepAt ??= Date.now();
    if (ev.type === 'reasoning' || ev.type === 'text') {
      if (ev.type === 'text') last = ev.part?.text || '';
      event({ type: 'item.completed', item: { type: ev.type === 'reasoning' ? 'reasoning' : 'agent_message', text: ev.part?.text || '' } });
    } else if (ev.type === 'step_finish' && ev.part?.tokens) {
      const t = ev.part.tokens;
      const usage = {
        input_tokens: (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0),
        cached_input_tokens: t.cache?.read || 0,
        ...(t.cache?.write != null ? { cache_write_input_tokens: t.cache.write } : {}),
        output_tokens: (t.output || 0) + (t.reasoning || 0), reasoning_output_tokens: t.reasoning || 0,
      };
      for (const [key, value] of Object.entries(usage)) sentUsage[key] = (sentUsage[key] || 0) + value;
      lastUsageAt = Date.now();
      event({ type: 'step.usage', ...(ev.part.reason === 'stop' ? { final: true } : {}), usage });
      pendingStepAt = null;
    } else if (ev.type === 'tool_use') {
      const { tool, state = {} } = ev.part || {};
      const input = state.input || {};
      const id = `opencode-${++items}`;
      if ((tool === 'websearch' || tool === 'webfetch') && state.status === 'completed') {
        event({ type: 'item.completed', item: { id, type: 'web_search', query: tool === 'websearch' ? input.query : input.url } });
        return;
      }
      const target = input.filePath || input.path;
      const category = ['edit', 'write'].includes(tool) || (typeof target === 'string' && /edit|write|patch/i.test(tool)) ? 'edit'
        : ['shell', 'bash'].includes(tool) ? 'shell' : ['grep', 'glob', 'list', 'search'].includes(tool) ? 'search' : 'read';
      const item = { id, tool, category };
      if (category === 'edit') {
        const changes = typeof target === 'string' && state.status === 'completed' ? [{ path: target, kind: tool === 'write' ? 'add' : 'update' }] : [];
        for (const change of changes) fileChanges.add(change.path);
        event({ type: 'item.completed', item: { ...item, type: 'file_change', changes } });
        return;
      }
      const shown = (value) => (path.isAbsolute(String(value)) ? relativePath(cwd, String(value)) : String(value));
      const params = ['filePath', 'path', 'pattern', 'include'].filter((k) => input[k] != null).map((k) => (k === 'filePath' || k === 'path' ? shown(input[k]) : String(input[k])));
      if (category === 'shell') commands++;
      const label = category === 'shell' ? {} : { label: toolLabel(category, tool, { pattern: input.pattern, glob: input.include, path: target == null ? null : shown(target) }) };
      event({ type: 'item.completed', item: { ...item, type: 'command_execution', command: category === 'shell' ? String(input.command || '') : [tool, ...params].join(' '), ...label,
        exit_code: state.status === 'completed' ? 0 : 1, aggregated_output: String(state.output || state.error || '').slice(0, 2000) } });
    } else if (ev.type === 'error') event({ type: 'error', message: ev.error?.message || ev.error?.type || JSON.stringify(ev) });
  };
  let nextPrompt = prompt;
  const request = async () => {
    if (isCancelled(dir)) { meta.status = 'cancelled'; return null; }
    if (Date.now() >= deadline) { meta.status = 'timeout'; return null; }
    const currentAgent = repairing && exec ? 'foreman-repair' : agentId;
    const args = opencodeArgs(model, effort, currentAgent);
    if (meta.session_id) args.push('--session', meta.session_id);
    // 总是带标题：不带时 opencode 会另发一个请求让模型起标题，和主请求同时占用账号的并发名额（Moonshot 等只允许 1 个时会被 429 拒绝）。
    args.push('--title', meta.title || `foreman ${ctx.kind}`);
    const out = await runOpencode({ agent, args, cwd, agentId: currentAgent, prompt: nextPrompt, runDir: dir, onEvent: translate,
      timeoutMs: deadline - Date.now(), stallMin, web: !repairing && web, edit: !repairing ? writeRules?.edit : undefined });
    usageTo = Date.now();
    errors.push(...out.errors);
    for (const error of out.recovered) recovered.add(error);
    for (const q of out.questions) {
      if (web === 'read' && q.source === 'permission_denied' && JSON.parse(q.detail).tool === 'websearch') {
        if (!notes.includes(M.opencodeWebsearchUnconfigured)) notes.push(M.opencodeWebsearchUnconfigured);
      } else observed.questions.push(q);
    }
    if (!repairing) observed.messages = out.messages;
    meta.status = out.status;
    return meta.status === 'done' ? { last, canRepair: !!meta.session_id } : null;
  };
  report = await reportWithRepair({
    schema, validate: validateSchema, request, allowQuestion: ctx.kind !== 'review',
    onInvalid: () => warnings.push(M.reportInvalid(agentName, path.join(dir, 'last-message.txt'))),
    repair: (invalid) => { repairing = true; nextPrompt = M.reportRepairPrompt(invalid.join('\n')); },
  });
  // 恢复过的错误只在最后正常结束时算作提示；取消、超时或之后又失败的，照实放进 errors。
  if (recovered.size && meta.status === 'done') notes.push(M.opencodeRecovered([...recovered].join('; ')));
  else errors.unshift(...recovered);
  if (meta.status === 'cancelled') errors.push(M.runCancelled(model, cancelSource(dir) ?? 'signal'));
  if (meta.status === 'stalled') errors.push(M.stalled(stallMin));
  if (meta.status === 'failed' && errors.some((e) => /rate.?limit|concurrency|too many requests|\b429\b/i.test(e))) notes.push(M.rateLimited(model, 'opencode'));
  let usage = null, cost = null;
  if (meta.session_id) {
    // 按开始时间汇总导出，包含压缩和格式修复；统一按主模型计价。
    const exported = await runOpencode({ agent, args: ['session', 'export', '--standalone', meta.session_id], cwd, timeoutMs: 60000 });
    try {
      if (exported.status !== 'done') throw new Error(exported.errors.join('; ') || exported.stderrTail || exported.status);
      const messages = JSON.parse(exported.stdout).messages.filter((m) => m.time.created >= started
        && (m.type === 'assistant' || m.type === 'compaction' && m.tokens != null));
      usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
      cost = 0;
      for (const m of messages) {
        const t = m.tokens || {}; // 出错的那条回复没有 tokens
        usage.input_tokens += (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
        usage.cached_input_tokens += t.cache?.read || 0;
        if (t.cache?.write != null) usage.cache_write_input_tokens = (usage.cache_write_input_tokens ?? 0) + t.cache.write;
        usage.output_tokens += (t.output || 0) + (t.reasoning || 0);
        usage.reasoning_output_tokens += t.reasoning || 0;
        cost += m.cost || 0;
      }
    } catch (e) { usage = null; cost = null; notes.push(M.opencodeExportFailed(e.message)); }
  }
  if (usage) {
    const rest = Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, Math.max(0, value - (sentUsage[key] || 0))]));
    const from = lastUsageAt ?? pendingStepAt ?? started;
    // 末步可能没有 step_finish；用真实结束时刻补齐，避免把导出耗时算进生成区间。
    if (Object.values(rest).some((n) => n > 0)) event({ type: 'step.usage', final: true, usage: rest,
      usage_from: from, usage_to: Math.max(usageTo, from + 1) });
  }
  fs.writeFileSync(path.join(dir, 'last-message.txt'), last);
  return { usage, usage_scope: 'this_run', cost, commands, errors, notes, warnings, report, last, observed,
    status: meta.status, code: meta.status === 'done' ? 0 : 1, sessionId: meta.session_id,
    fileChanges, images: [], messages: observed.messages, questions: observed.questions };
}

// 本机 opencode 能用的模型清单，含每个模型的 variant（推理强度）、上下文、价格。读不到时返回 ok: false。
function opencodeCatalog(agent = {}) {
  const { file, pre } = opencodeCommand(agent);
  const r = spawnSync(file, [...pre, 'api', 'GET', '/api/model'], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  try {
    if (r.error || r.status !== 0) throw new Error(r.error?.message || (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`);
    const models = JSON.parse(r.stdout).data.map((m) => ({
      // id 是 -m 里写的名字（可能是别名），modelID 是发给厂商的底层模型名，两者可以不同。
      id: `${m.providerID}/${m.id ?? m.modelID}`, name: m.name || m.id || m.modelID, efforts: (m.variants || []).map((v) => v.id),
      default_effort: null, context: m.limit?.context ?? null, cost: m.cost?.[0] ? { input: m.cost[0].input, output: m.cost[0].output } : null,
      status: m.status ?? null, enabled: m.enabled !== false,
    }));
    return { ok: true, source: 'opencode api GET /api/model', models, error: null };
  } catch (e) { return { ok: false, source: 'opencode api GET /api/model', models: [], error: e.message }; }
}

async function checkOpencodeAgent(name, agent, variants = [], catalog = () => opencodeCatalog(agent)) {
  const started = Date.now();
  const out = { ok: false, type: 'opencode cli', model: agent.model, version: null, model_listed: false, seconds: null, reply: null, error: null, fix: null, variants: [] };
  const call = (args, timeoutMs = 60000, prompt = '') => runOpencode({ agent, args, cwd: process.cwd(), timeoutMs, prompt });
  const failed = (result) => result.errors.join('; ') || result.stderrTail.trim() || result.status;
  const finish = () => ({ ...out, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  const version = await call(['--version']);
  if (version.status !== 'done') { out.error = failed(version); out.fix = M.fixOpencodeMissing(name); return finish(); }
  out.version = version.stdout.trim();
  const models = await call(['models']);
  out.model_listed = models.status === 'done' && models.stdout.split(/\s+/).includes(agent.model);
  if (!out.model_listed) {
    out.error = models.status === 'done' ? null : failed(models);
    const near = closestMatches(agent.model, models.stdout.split(/\s+/).filter((s) => s.includes('/')));
    out.fix = M.fixOpencodeModel(name, agent.model) + (near.length ? M.closestHint(M.list(near)) : '');
    return finish();
  }
  const reply = await call([...opencodeArgs(agent.model, null), '--title', 'foreman check'], 120000, 'Reply with the single word OK.');
  out.ok = reply.status === 'done';
  out.reply = reply.text.trim().slice(0, 40);
  if (!out.ok) { out.error = failed(reply); out.fix = M.fixOpencodeRun(name, out.error); return finish(); }
  // 先按清单核对，清单里没有的档位不用发请求；清单读不到或清单里有的，再发一个小请求实测。
  const cat = variants.length ? catalog() : null;
  for (const variant of variants) {
    const listed = cat?.ok ? cat.models.find((m) => m.id === variant.model) : null;
    // "default" 在 opencode 里就是不指定档位，和上面的默认请求一样，不用再试。
    if (variant.variant === 'default') {
      out.variants.push({ ...variant, ok: true, error: null, ...(listed ? { supported: listed.efforts } : {}) });
      continue;
    }
    if (listed && !listed.efforts.includes(variant.variant)) {
      out.variants.push({ ...variant, ok: false, error: M.effortNotInCatalog(variant.variant, listed.efforts.length ? M.list(listed.efforts) : M.noEfforts), supported: listed.efforts });
      continue;
    }
    const result = await call([...opencodeArgs(variant.model, variant.variant), '--title', 'foreman check'], 120000, 'Reply with the single word OK.');
    const ok = result.status === 'done';
    out.variants.push({ ...variant, ok, error: ok ? null : failed(result), ...(listed ? { supported: listed.efforts } : {}) });
  }
  const unavailable = out.variants.filter((v) => !v.ok);
  if (unavailable.length) {
    out.ok = false;
    out.error = unavailable[0].error;
    const where = (v) => LANGUAGE === 'en' ? `${v.variant} (${M.list(v.used_at)})` : `${v.variant}（${M.list(v.used_at)}）`;
    // 清单里没有的档位：告诉用户能写哪些。清单里有、请求却失败的：档位没写错，转告真实的报错。
    // 读不到清单的：默认请求能通、只有带档位的失败，多半是档位不支持。
    const notListed = unavailable.filter((v) => v.supported && !v.supported.includes(v.variant));
    const listedFailed = unavailable.filter((v) => v.supported?.includes(v.variant));
    const unknown = unavailable.filter((v) => !v.supported);
    out.fix = [
      notListed.length && M.fixEffortUnsupported(name, M.list(notListed.map((v) => M.effortAt(v.variant, M.list(v.used_at), v.model, v.supported.length ? M.list(v.supported) : M.noEfforts)))),
      listedFailed.length && M.fixOpencodeVariantFailed(name, M.list(listedFailed.map(where)), listedFailed[0].error),
      unknown.length && M.fixOpencodeVariant(name, M.list(unknown.map(where))),
    ].filter(Boolean).join(LANGUAGE === 'en' ? '; ' : '；');
  }
  return finish();
}

function validate(agent, key, check, text) {
  const why = M.invalid;
  check(text(agent.model) && agent.model.includes('/'), `${key}.model`, why.opencodeModel);
  check(agent.bin == null || text(agent.bin), `${key}.bin`, why.stringOrNull);
  check(agent.run_access === undefined || RUN_ACCESS.includes(agent.run_access), `${key}.run_access`, why.runAccess);
}

export default {
  type: 'opencode cli', capabilities, readonlyLevel, channel: M.channel.opencode,
  validate,
  status: (agent) => ({ bin: agent.bin || opencodeCommand(agent).file, run_access: agent.run_access ?? null }),
  check: checkOpencodeAgent,
  catalog: opencodeCatalog,
  locate: opencodeCommand,
  execute: executeOpencode,
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
};
