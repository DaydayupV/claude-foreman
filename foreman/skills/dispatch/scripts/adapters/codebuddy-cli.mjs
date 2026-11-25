// CodeBuddy CLI：腾讯云代码助手的无头调用、原生 Schema 约束、工具权限隔离与事件流翻译。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SCHEMA, DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../review-scope.mjs';
import { RUNS_ROOT, newRunDir, isCancelled, cancelSource, announceBoard } from '../records.mjs';
import { startRun, finishDiscussion, execute, eventWriter, runLimits, reportWithRepair, spawnCli, validateSchema } from '../runner.mjs';
import { M, die, isObject, binCommand, pathCommand, npmEntry, killTree, readAttachments, filesOutside, focusFiles, relativePath, closestMatches } from '../util.mjs';
import { D, modelLabel, toolLabel } from '../format.mjs';
import { codebuddyConfigDir } from './codebuddy-guard.mjs';

// The npm package entry has no extension but is JavaScript; custom extensionless bins may be native executables.
function codebuddyCommand(agent = {}) {
  if (agent.bin) {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(agent.bin)) return binCommand(agent.bin);
    return nodeEntry(agent.bin) ? { file: process.execPath, pre: [agent.bin] } : binCommand(agent.bin);
  }
  const entry = npmEntry('@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');
  if (entry) return { file: process.execPath, pre: [entry] };
  return pathCommand('codebuddy');
}

function nodeEntry(file) {
  if (/\.[cm]?js$/i.test(file) || /(?:^|\/)@tencent-ai\/codebuddy-code\/bin\/codebuddy$/i.test(file.replaceAll('\\', '/'))) return true;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(256);
    const size = fs.readSync(fd, head, 0, head.length, 0);
    return /^#![^\r\n]*\bnode(?:\s|$)/.test(head.toString('utf8', 0, size).split('\n')[0]);
  } catch { return false; }
  finally { if (fd != null) fs.closeSync(fd); }
}

// An empty --setting-sources falls back to all scopes in 2.180.0. Keep user sign-in/settings,
// but refuse rules or hooks that could widen the project boundary before starting the CLI.
function unsafeUserSettings(configDir, access) {
  const file = path.join(configDir, 'settings.json');
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { return error.code === 'ENOENT' ? null : M.codebuddyUnsafeSettings(file, 'unreadable settings'); }
  const present = (value) => value != null && (Array.isArray(value) ? value.length > 0 : isObject(value) ? Object.keys(value).length > 0 : !!value);
  const rules = ['allow', 'additionalDirectories'].filter(key => present(settings?.permissions?.[key])).map(key => `permissions.${key}`);
  // Only edit emits allow, which would override the CLI's user deny/ask rules.
  if (access === 'edit') for (const key of ['deny', 'ask']) if (present(settings?.permissions?.[key])) rules.push(`permissions.${key}`);
  if (present(settings?.hooks)) rules.push('hooks');
  if (Object.values(settings?.enabledPlugins ?? {}).some(value => value === true || value?.enabled === true)) rules.push('enabledPlugins');
  return rules.length ? M.codebuddyUnsafeSettings(file, rules.join(', ')) : null;
}

const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const RUN_ACCESS = ['edit', 'shell'];
const SEARCH_SCAN_LIMIT = 100000;
// 工具白名单限定能调用哪些工具，PreToolUse 守卫检查读写路径。none 只出现在修报告格式时。
const TOOLS = { none: [], read: ['Read', 'Glob', 'Grep'] };
TOOLS.edit = [...TOOLS.read, 'Write', 'Edit'];
TOOLS.shell = [...TOOLS.edit, 'Bash', 'PowerShell'];
const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'tools', reads_code: true, reads_images: false, native_schema: true,
  native_review: false, images: false, resume: true, command_start_events: false };

// CodeBuddy 在 Windows 上搜索时会跟随链接，工具钩子只能检查搜索起点。
export function outsideLinks(root, limit = SEARCH_SCAN_LIMIT) {
  const realRoot = fs.realpathSync.native(root);
  const dirs = [realRoot], links = [];
  let visited = 0;
  while (dirs.length) {
    const dir = dirs.pop();
    let entries;
    // A folder foreman can't list can't be searched by CodeBuddy either (same account), so skip it.
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.toLowerCase() === '.git') continue;
      if (++visited > limit) return { links, capped: true };
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target;
        try { target = fs.realpathSync.native(file); } catch { continue; }
        const rel = path.relative(realRoot, target);
        if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) links.push(relativePath(realRoot, file));
      } else if (entry.isDirectory()) dirs.push(file);
    }
  }
  return { links, capped: false };
}

// --json-schema 只在结构化输出工具可用时才生效：不把它放进白名单，模型拿不到这个工具，只会把 JSON 写在正文里。
function codebuddyArgs({ model, effort, access, session, schema, ephemeral = false, cwd, search = true }) {
  const args = ['-p', '--output-format', 'stream-json', '--strict-mcp-config', '--setting-sources', 'user'];
  if (model) args.push('--model', model);
  if (effort != null && effort !== 'default') args.push('--effort', effort);
  if (schema) args.push('--json-schema', typeof schema === 'string' ? schema : JSON.stringify(schema));
  const tools = (TOOLS[access] ?? TOOLS.read).filter(tool => search || (tool !== 'Grep' && tool !== 'Glob'));
  args.push('--tools', [...new Set([...tools, ...(schema ? ['StructuredOutput'] : [])])].join(','));
  if (access === 'shell') args.push('-y');
  else args.push('--permission-mode', 'dontAsk');
  if (access === 'edit') args.push('--allowedTools', 'Write(./**),Edit(./**)');
  if (access !== 'none') {
    const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
    const guard = fileURLToPath(new URL('./codebuddy-guard.mjs', import.meta.url));
    const command = [process.execPath, guard, access, cwd, path.resolve(RUNS_ROOT)].map(quote).join(' ');
    args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read|Glob|Grep|Write|Edit', hooks: [{ type: 'command', command }] }] } }));
  }
  if (session) args.push('--resume', session);
  if (ephemeral) args.push('--no-session-persistence');
  return args;
}

function runCodebuddy({ agent, args, access, cwd, prompt = '', timeoutMs = 120000, stallMin = 0, runDir, onEvent }) {
  return new Promise((resolve) => {
    const { file, pre } = codebuddyCommand(agent);
    const out = { code: null, status: null, stdout: '', stderrTail: '', text: '', errors: [], events: 0, messages: [], questions: [],
      usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 }, cost: 0,
      structured: null, sessionId: null, isError: false };
    const configDir = codebuddyConfigDir();
    const settingsError = access == null ? null : unsafeUserSettings(configDir, access);
    if (settingsError) { out.status = 'failed'; out.errors.push(settingsError); resolve(out); return; }
    const assistantUsage = new Map(), usageStages = new Map();
    let usageSnapshot = null, anonymousUsageId = 0, stopped = false, child;
    const deadline = Date.now() + Math.max(1, timeoutMs);
    const refreshUsage = () => {
      const values = usageSnapshot ? [usageSnapshot] : usageStages.size ? [...usageStages.values()] : [...assistantUsage.values()];
      for (const key of Object.keys(out.usage)) delete out.usage[key];
      Object.assign(out.usage, sumUsage(values));
    };
    const stop = (status) => {
      if (stopped) return;
      stopped = true;
      out.status = status;
      if (child?.pid) killTree(child.pid);
    };
    const onSignal = () => stop('cancelled');
    const env = { ...process.env, CODEBUDDY_CONFIG_DIR: configDir };
    child = spawnCli(file, [...pre, ...args], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' }, {
      onInput: (line, min) => {
        out.questions.push({ source: 'input_prompt', question: line });
        out.errors.push(M.inputWaitDetected(min, line));
        stop('needs_input');
      },
    });
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    let lastEventAt = Date.now();
    let buf = '';
    const record = (line) => {
      line = line.replace(/\r$/, '');
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!isObject(ev) || !ev.type) return;
      if (runDir) fs.appendFileSync(path.join(runDir, 'codebuddy.jsonl'), line + '\n');
      lastEventAt = Date.now();
      out.events++;
      if (ev.session_id && !out.sessionId) out.sessionId = ev.session_id;
      if (ev.type === 'assistant') {
        const blocks = ev.message?.content || [];
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
        if (text) { out.text = text; out.messages.push(text); }
        // Stream fragments may repeat the same message id; keep the latest usage for that message.
        const u = ev.message?.usage;
        if (u) {
          assistantUsage.set(ev.message?.id || 'anonymous-' + (++anonymousUsageId), u);
          refreshUsage();
        }
      } else if (ev.type === 'result') {
        out.isError = ev.is_error === true || (ev.subtype != null && ev.subtype !== 'success');
        if (isObject(ev.structured_output)) out.structured = ev.structured_output;
        // result.usage is session-cumulative; on resume only per-turn events or
        // assistant messages belong to this call (including report-repair rounds).
        if (!args.includes('--resume') && isObject(ev.usage)) {
          usageSnapshot = ev.usage;
          refreshUsage();
        }
        const errors = Array.isArray(ev.errors) ? ev.errors : ev.errors == null ? [] : [ev.errors];
        for (const message of errors) out.errors.push(typeof message === 'string' ? message : JSON.stringify(message));
      }
      const turnUsage = usageFromEvent(ev);
      if (turnUsage?.kind === 'stage') usageStages.set(turnUsage.id, turnUsage.usage);
      if (turnUsage?.kind === 'snapshot') usageSnapshot = turnUsage.usage;
      if (turnUsage) refreshUsage();
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
    const timer = setTimeout(() => stop('timeout'), Math.max(1, deadline - Date.now()));
    const poll = setInterval(() => {
      if (runDir && isCancelled(runDir)) stop('cancelled');
      else if (stallMin && Date.now() - lastEventAt >= stallMin * 60000) stop('stalled');
    }, 1000);
    child.on('error', (e) => { out.errors.push(e.message); stop('failed'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(poll);
      if (buf.trim()) record(buf.trim());
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      out.code = code;
      if (runDir && isCancelled(runDir)) out.status = 'cancelled';
      else if (!out.status && Date.now() >= deadline) out.status = 'timeout';
      // 模型报错时 codebuddy 也以 0 退出，要看 result 事件的 is_error。
      out.status ||= out.isError || code !== 0 ? 'failed' : 'done';
      const failure = out.errors.join('\n') + '\n' + out.stderrTail + '\n' + out.messages.join('\n');
      if (out.status === 'failed' && /RESOURCE_EXHAUSTED|quota(?:\s+|_)?(?:exhausted|exceeded)|usage limit|insufficient quota/i.test(failure)
        && !/\b429\b|rate.?limit|concurrency/i.test(failure)) out.status = 'quota_exhausted';
      resolve(out);
    });
    child.stdin.on('error', () => { /* 提前退出时忽略 EPIPE */ });
    child.stdin.end(prompt, 'utf8');
  });
}

function addUsage(total, u = {}) {
  const cached = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  total.input_tokens += u.input_tokens ?? (cached + write);
  total.cached_input_tokens += cached;
  if (write) total.cache_write_input_tokens = (total.cache_write_input_tokens ?? 0) + write;
  total.output_tokens += u.output_tokens || 0;
}

function sumUsage(values) {
  const total = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const value of values) addUsage(total, value);
  return total;
}

function usageFromEvent(ev) {
  const payload = ev._meta?.['codebuddy.ai/turnUsage'];
  if (payload?.kind === 'stage' && payload.stage?.id) return { kind: 'stage', id: payload.stage.id, usage: payload.stage.usage || {} };
  if (payload?.kind === 'snapshot' && payload.total?.usage) return { kind: 'snapshot', usage: payload.total.usage };
  if (ev.type === 'usage_update') {
    if (ev.kind === 'stage' && ev.stage?.id) return { kind: 'stage', id: ev.stage.id, usage: ev.stage.usage || {} };
    if (ev.kind === 'snapshot' && ev.total?.usage) return { kind: 'snapshot', usage: ev.total.usage };
  }
  return null;
}

const readonlyLevel = () => 'tools';

async function executeCodebuddy(ctx) {
  const { model, agent, level, cwd, brief, mode, opts } = ctx;
  if (opts['add-dir']?.length || ctx.addDirs?.length) die(M.codebuddyNoAddDir(ctx.agentName));
  if (ctx.parent && !ctx.sessionId) die(M.noSession(ctx.parent));
  const review = ctx.kind === 'review', exec = ctx.kind === 'exec';
  const schemaText = fs.readFileSync(review ? REVIEW_SCHEMA : exec ? SCHEMA : DISCUSS_SCHEMA, 'utf8');
  const schema = JSON.parse(schemaText);
  const files = readAttachments(opts.file, cwd, false), outside = filesOutside(files, [cwd]);
  if (outside.length) die(M.filesOutsideCwd(ctx.agentName, M.list(outside), false));
  const access = exec ? agent.run_access : 'read';
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
    : `${brief}\n\n${M.footer(cwd, [])}\n\n${M.opencodeRunFooter(schemaText, access)}\n`;
  else prompt = `${brief}${focusFiles(files)}\n\n${ctx.parent ? M.opencodeResumeFooter : M.opencodeDiscussFooter(cwd, schemaText)}\n`;

  let searchNote;
  if (process.platform === 'win32' && (access === 'read' || access === 'edit')) {
    const { links, capped } = outsideLinks(cwd);
    if (capped) searchNote = M.codebuddySearchScanCapped(SEARCH_SCAN_LIMIT);
    else if (links.length) searchNote = M.codebuddyLinksNoSearch(M.list(links.slice(0, 3)));
    if (searchNote) {
      const list = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
      prompt += '\n\n' + M.codebuddyFileList(list.status === 0 ? list.stdout.trim() : '');
    }
  }

  const { id, dir, release } = await newRunDir(ctx);
  const context = { ...ctx, ...(exec ? {} : { readonly: readonlyLevel(agent, ctx.kind) }), id, dir, release, prompt, searchNote };
  if (exec) return execute(context, {
    capabilities,
    describe: () => ({ sandbox: null, modelShown: model, modelName: model }),
    run: ({ run }) => codebuddySession(run, schema, access),
  });
  const run = startRun(context);
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${D.started(mode, modelLabel(run.meta), level, dir)}\n`);
  announceBoard(ctx.cfg, mode, modelLabel(run.meta), level);
  return finishDiscussion(run, { ...await codebuddySession(run, schema, access), files, changesNote: M.codebuddyNoChanges });
}

async function codebuddySession(run, schema, access) {
  const { ctx, started, meta, writeMeta } = run;
  const { dir, agentName, agent, model, effort, cwd, prompt, searchNote } = ctx;
  const { deadline, stallMin } = runLimits(ctx, started);
  const event = eventWriter(dir);
  fs.appendFileSync(path.join(dir, 'events.jsonl'), '');
  for (const file of ['codebuddy.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, file), '');
  const errors = [], warnings = [], notes = searchNote ? [searchNote] : [];
  const observed = { messages: [], questions: [] };
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  const fileChanges = new Set();
  const pendingTools = new Map(), deniedTools = new Set();
  const emittedUsage = new Set(), pendingUsage = new Map();
  let anonymousToolId = 0, anonymousStepId = 0;
  let cost = 0, commands = 0, repairing = false, last = '';

  const addDenial = (id, tool, input, detail) => {
    if (id && deniedTools.has(id)) return;
    if (id) deniedTools.add(id);
    const value = input?.file_path || input?.path || input?.notebook_path;
    let question = tool;
    if (typeof value === 'string' && value) {
      const fromHome = value === '~' || /^~[\\/]/.test(value);
      const absolute = fromHome ? path.resolve(os.homedir(), value.slice(2)) : path.resolve(cwd, value);
      const relative = relativePath(cwd, absolute);
      question += ` (${relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? absolute : relative})`;
    }
    // The runner merges permission questions by detail, so keep the tool and path in it:
    // the same guard reason for two different files stays two questions.
    observed.questions.push({ source: 'permission_denied', question, detail: `${question}: ${detail}` });
  };

  const completeTool = (id, call, result, detail = null) => {
    const input = call.input || {};
    const resultText = Array.isArray(result?.content)
      ? result.content.flatMap(block => typeof block?.text === 'string' ? [block.text] : []).join('\n')
      : String(result?.content ?? '');
    if (detail === null && (resultText.includes('hook blocked this tool call') || resultText.includes(`Permission to use ${call.name} has been denied`))) detail = resultText;
    const denied = detail !== null;
    if (denied) addDenial(id, call.name, input, detail);
    const exitCode = denied ? 1 : Number.isInteger(result?.exit_code) ? result.exit_code : !result || result.is_error ? 1 : 0;
    const succeeded = !denied && result != null && result.is_error !== true && exitCode === 0;
    const target = input.file_path || input.path || input.notebook_path;
    if (call.name === 'Write' || call.name === 'Edit' || call.name === 'NotebookEdit') {
      const changes = succeeded && typeof target === 'string'
        ? [{ path: target, kind: call.name === 'Write' ? 'add' : 'update' }]
        : [];
      for (const change of changes) fileChanges.add(change.path);
      event({ type: 'item.completed', item: { id, category: 'edit', type: 'file_change', changes, exit_code: exitCode,
        aggregated_output: resultText.slice(0, 2000) } });
      return;
    }
    if ((call.name === 'Bash' || call.name === 'PowerShell') && !denied) commands++;
    const shown = (value) => (path.isAbsolute(String(value)) ? relativePath(cwd, String(value)) : String(value));
    if (call.name === 'Bash' || call.name === 'PowerShell') {
      event({ type: 'item.completed', item: { id, type: 'command_execution', category: 'shell', command: String(input.command || ''),
        exit_code: exitCode, aggregated_output: resultText.slice(0, 2000) } });
      return;
    }
    const args = ['pattern', 'path', 'glob'].filter((key) => input[key] != null)
      .map((key) => (key === 'path' ? shown(input[key]) : String(input[key])));
    const category = call.name === 'Grep' || call.name === 'Glob' ? 'search' : 'read';
    event({ type: 'item.completed', item: { id, type: 'command_execution', category,
      command: [call.name, ...args].join(' '),
      label: toolLabel(category, call.name, { pattern: input.pattern, glob: input.glob, path: target == null ? null : shown(target) }),
      exit_code: exitCode, aggregated_output: resultText.slice(0, 2000) } });
  };

  const finishPendingTools = () => {
    for (const [id, call] of pendingTools) completeTool(id, call, null);
    pendingTools.clear();
  };

  // Thinking fragments in 2.180.0 carry zero usage; the later tool/text fragment
  // with the same id has the final numbers. Emit only after that message ends.
  const flushUsage = (except) => {
    for (const [id, value] of pendingUsage) {
      if (id === except) continue;
      pendingUsage.delete(id);
      if (emittedUsage.has(id)) continue;
      emittedUsage.add(id);
      event({ type: 'step.usage', ...(value.tools ? {} : { final: true }), usage: sumUsage([value.usage]) });
    }
  };

  const translate = (ev) => {
    if (ev.session_id && !meta.session_id) {
      meta.session_id = ev.session_id;
      writeMeta();
      event({ type: 'thread.started', thread_id: ev.session_id });
    }
    if (ev.type === 'assistant') {
      const blocks = ev.message?.content || [];
      const usageId = ev.message?.id || `anonymous-${++anonymousStepId}`;
      flushUsage(usageId);
      for (const block of blocks) {
        if (block.type === 'thinking' && block.thinking) event({ type: 'item.completed', item: { type: 'reasoning', text: block.thinking } });
        if (block.type === 'text' && block.text) { last = block.text; event({ type: 'item.completed', item: { type: 'agent_message', text: block.text } }); }
        if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
          const id = String(block.id ?? `codebuddy-${++anonymousToolId}`);
          pendingTools.set(id, { name: block.name, input: block.input || {} });
        }
      }
      const u = ev.message?.usage;
      if (u) pendingUsage.set(usageId, { usage: u, tools: pendingUsage.get(usageId)?.tools || blocks.some(b => b.type === 'tool_use') });
    } else if (ev.type === 'user') {
      flushUsage();
      for (const result of ev.message?.content || []) {
        if (result.type !== 'tool_result') continue;
        const id = String(result.tool_use_id ?? '');
        const call = pendingTools.get(id);
        if (!call) continue;
        pendingTools.delete(id);
        completeTool(id, call, result);
      }
    } else if (ev.type === 'result') {
      flushUsage();
      for (const denial of ev.permission_denials || []) {
        const id = String(denial.tool_use_id || '');
        const call = pendingTools.get(id);
        const detail = denial.reason ?? JSON.stringify(denial);
        if (call) {
          pendingTools.delete(id);
          completeTool(id, call, null, detail);
        } else addDenial(id, denial.tool_name || denial.tool || 'denied', denial.tool_input, detail);
      }
    }
  };

  let nextPrompt = prompt;
  const request = async () => {
    if (isCancelled(dir)) { meta.status = 'cancelled'; return null; }
    if (Date.now() >= deadline) { meta.status = 'timeout'; return null; }
    // 修报告格式时沿用同一个会话，但不给任何读文件的工具。
    const current = repairing ? 'none' : access;
    emittedUsage.clear();
    pendingUsage.clear();
    const out = await runCodebuddy({ agent, args: codebuddyArgs({ model, effort, access: current, session: meta.session_id, schema, cwd, search: !searchNote }),
      access: current, cwd, prompt: nextPrompt, runDir: dir, onEvent: translate, timeoutMs: deadline - Date.now(), stallMin });
    flushUsage();
    finishPendingTools();
    errors.push(...out.errors);
    observed.questions.push(...out.questions);
    if (!repairing) observed.messages = out.messages;
    for (const [key, value] of Object.entries(out.usage)) usage[key] = (usage[key] ?? 0) + value;
    cost += out.cost;
    meta.status = out.status;
    if (out.structured) last = JSON.stringify(out.structured);
    return meta.status === 'done' ? { last, canRepair: !!meta.session_id } : null;
  };

  const report = await reportWithRepair({
    schema, validate: validateSchema, request, allowQuestion: ctx.kind !== 'review',
    onInvalid: () => warnings.push(M.reportInvalid(agentName, path.join(dir, 'last-message.txt'))),
    repair: (invalid) => { repairing = true; nextPrompt = M.reportRepairPrompt(invalid.join('\n')); },
  });
  if (meta.status === 'cancelled') errors.push(M.runCancelled(model, cancelSource(dir) ?? 'signal'));
  if (meta.status === 'stalled') errors.push(M.stalled(stallMin));
  if (meta.status === 'failed' && errors.some((e) => /rate.?limit|concurrency|too many requests|\b429\b/i.test(e))) notes.push(M.rateLimited(model, 'CodeBuddy CLI'));
  fs.writeFileSync(path.join(dir, 'last-message.txt'), report ? JSON.stringify(report, null, 2) : last);
  return { usage: meta.session_id || usage.input_tokens ? usage : null, usage_scope: 'this_run', cost, commands, errors, notes, warnings, report,
    last: report ? JSON.stringify(report) : last, observed, status: meta.status, code: meta.status === 'done' ? 0 : 1,
    sessionId: meta.session_id, fileChanges, images: [], messages: observed.messages, questions: observed.questions };
}

// 本机能用哪些模型：从 --help 的 "Currently supported:" 里读，不发模型请求。
function codebuddyCatalog(agent = {}) {
  const { file, pre } = codebuddyCommand(agent);
  const source = 'codebuddy --help';
  const env = { ...process.env, CODEBUDDY_CONFIG_DIR: codebuddyConfigDir() };
  const r = spawnSync(file, [...pre, '--help'], { env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  try {
    if (r.error) throw r.error;
    const match = /Currently supported:\s*\(([^)]+)\)/i.exec(r.stdout || '');
    if (!match) throw new Error('没有从 codebuddy --help 找到可用模型清单');
    const models = match[1].split(',').map((id) => id.trim()).filter(Boolean).map((id) => ({ id, name: id, efforts: LEVELS, default_effort: null, context: null }));
    return { ok: true, source, models, error: null };
  } catch (e) { return { ok: false, source, models: [], error: e.message }; }
}

async function checkCodebuddyAgent(name, agent, efforts = [], catalog = () => codebuddyCatalog(agent), _modes, cwd = process.cwd()) {
  const started = Date.now();
  const out = { ok: false, type: 'codebuddy cli', model: agent.model, version: null, model_listed: false, seconds: null, reply: null, error: null, fix: null, efforts: [] };
  const call = (args, access, prompt) => runCodebuddy({ agent, args, access, cwd, prompt });
  const failed = (result) => result.errors.join('; ') || result.stderrTail.trim() || result.status;
  const finish = () => ({ ...out, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) });
  const version = await call(['--version']);
  if (version.status !== 'done') { out.error = failed(version); out.fix = M.fixCodebuddyMissing(name); return finish(); }
  out.version = version.stdout.trim();
  const cat = catalog(agent);
  if (!cat.ok) { out.error = cat.error; out.fix = M.fixCodebuddyCatalog(name, cat.error); return finish(); }
  out.model_listed = cat.models.some((m) => m.id === agent.model);
  if (!out.model_listed) {
    const near = closestMatches(agent.model, cat.models.map((m) => m.id));
    out.fix = M.fixCodebuddyModel(name, agent.model) + (near.length ? M.closestHint(M.list(near)) : '');
    return finish();
  }
  const reply = await call(codebuddyArgs({ model: agent.model, effort: null, access: 'read', ephemeral: true, cwd }), 'read', 'Reply with the single word OK.');
  out.ok = reply.status === 'done';
  out.reply = reply.text.trim().slice(0, 40);
  if (!out.ok) { out.error = failed(reply); out.fix = M.fixCodebuddyRun(name, out.error); return finish(); }
  for (const item of efforts) {
    const ok = item.variant === 'default' || LEVELS.includes(item.variant);
    out.efforts.push({ ...item, ok, error: ok ? null : M.fixEffortUnsupported(name, M.list([`${item.variant}（${M.list(item.used_at)}）`])), supported: LEVELS });
  }
  const unsupported = out.efforts.filter((e) => !e.ok);
  if (unsupported.length) { out.ok = false; out.error = unsupported[0].error; out.fix = unsupported[0].error; }
  return finish();
}

function validate(agent, key, check, text) {
  const why = M.invalid;
  check(text(agent.model), `${key}.model`, why.modelName);
  check(agent.bin == null || text(agent.bin), `${key}.bin`, why.stringOrNull);
  check(agent.run_access === undefined || RUN_ACCESS.includes(agent.run_access), `${key}.run_access`, why.runAccess);
}

export default {
  type: 'codebuddy cli',
  capabilities,
  readonlyLevel,
  channel: M.channel.codebuddy,
  efforts: LEVELS,
  listModelsArgs: ['--help'],
  validate,
  status: (agent) => {
    const { file, pre } = codebuddyCommand(agent);
    return { bin: agent.bin || pre[0] || file, run_access: agent.run_access ?? null, model: agent.model ?? null };
  },
  check: checkCodebuddyAgent,
  catalog: codebuddyCatalog,
  locate: codebuddyCommand,
  execute: executeCodebuddy,
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
};
