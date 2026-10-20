// opencode CLI：代理权限与环境、事件翻译、会话导出和检查项。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { MAX_REVIEW_CHARS } from '../review-scope.mjs';
import { newRunDir, isCancelled, cancelSource } from '../records.mjs';
import { startRun, finishDiscussion, execute, eventWriter, runLimits, reportWithRepair, spawnCli, validateSchema } from '../runner.mjs';
import { M, LANGUAGE, die, isObject, binCommand, pathCommand, npmEntry, killTree, readAttachments, focusFiles, relativePath, closestMatches } from '../util.mjs';
import { D, modelLabel, toolLabel } from '../format.mjs';

function opencodeCommand(agent) {
  if (agent.bin) return binCommand(agent.bin);
  if (process.platform !== 'win32') return pathCommand('opencode', [path.join(os.homedir(), '.opencode', 'bin')]);
  return binCommand(npmEntry('@opencode', 'cli', 'bin', 'opencode.exe') || 'opencode.exe');
}

const OPENCODE_AGENT = 'foreman-discuss';
const RUN_ACCESS = ['edit', 'shell'];
const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'tools', reads_code: true, reads_images: false, native_schema: false, native_review: false, images: false, resume: true, command_start_events: false };

function opencodeEnv(agentId = OPENCODE_AGENT, access) {
  let config;
  try { config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); } catch { /* 无效配置由本次注入替代 */ }
  if (!isObject(config)) config = {};
  const descriptions = { 'foreman-discuss': 'Read-only code discussion for foreman', 'foreman-review': 'Read-only code review for foreman',
    'foreman-run': 'Hands-on work for foreman', 'foreman-repair': 'Report format repair for foreman' };
  const permission = { '*': 'deny' };
  if (agentId !== 'foreman-repair') Object.assign(permission, { read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  if (agentId === 'foreman-run') {
    permission.edit = 'allow';
    if (access === 'shell') permission.shell = 'allow';
  }
  const agent = { mode: 'primary', description: descriptions[agentId], permission };
  return { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, agent: { ...(isObject(config.agent) ? config.agent : {}), [agentId]: agent } }) };
}

// 私有服务才会读取本次注入的代理配置，也能随 run 一起终止。
const opencodeArgs = (model, effort, agentId = OPENCODE_AGENT) => ['run', '--standalone', '--format', 'json', '--agent', agentId, '-m', `${model}${effort != null ? `#${effort}` : ''}`];

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

function runOpencode({ agent, args, cwd, prompt = '', timeoutMs, stallMin = 0, runDir, onEvent, agentId }) {
  return new Promise((resolve) => {
    const { file, pre } = opencodeCommand(agent);
    const out = { code: null, status: null, stdout: '', stderrTail: '', text: '', errors: [], recovered: [], events: 0, messages: [], questions: [] };
    const denied = [], stderrLines = [], eventErrors = [];
    let stopped = false;
    // opencode 按环境变量 PWD 认工作目录，不看进程真实的 cwd；PWD 是从调用方的 shell 继承来的，可能指向别的目录。
    const child = spawnCli(file, [...pre, ...args], { cwd, env: { ...opencodeEnv(agentId, agent.run_access), PWD: cwd }, windowsHide: true,
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
      // 最后一次 step_finish 是 stop 且后面没有 error 才算恢复，CLI 此时仍可能以 1 退出。
      (stopped ? out.recovered : out.errors).push(...eventErrors);
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
  const files = readAttachments(opts.file, cwd, false);
  let prompt;
  if (review) {
    const scope = ctx.reviewScope;
    const opening = { files: M.reviewPromptFiles, claims: M.reviewPromptClaims }[ctx.reviewTarget];
    const parts = [opening ? opening(cwd) : scope ? M.opencodeReviewPrompt(cwd, scope.description) : M.reviewPromptPlain(cwd)];
    if (brief) parts.push(brief);
    if (files.length) parts.push(focusFiles(files).trim());
    if (scope?.target === 'diff') {
      const fileList = scope.files.map((f) => `- ${f.status} ${f.old_path ? `${f.old_path} → ` : ''}${f.path}`
        + (f.binary ? M.reviewFileBinary : '') + (f.too_large ? M.reviewFileTooLarge : '')).join('\n');
      const chars = fileList.length + scope.patch.length;
      if (chars > MAX_REVIEW_CHARS) die(M.reviewTooLarge(chars, MAX_REVIEW_CHARS));
      const longest = (scope.patch.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 2);
      parts.push(M.reviewMaterial(fileList, scope.patch, '`'.repeat(longest + 1)));
    }
    prompt = [...parts, M.reviewFooter, M.reviewSchemaFooter(schemaText)].join('\n\n') + '\n';
  } else if (exec) prompt = ctx.parent
    ? `${brief}${focusFiles(files)}\n\n${M.resumeFooter}\n\n${M.opencodeRunResumeFooter}\n`
    : `${brief}\n\n${M.footer(cwd, ctx.addDirs || [])}\n\n${M.opencodeRunFooter(schemaText, agent.run_access)}\n`;
  else prompt = `${brief}${focusFiles(files)}\n\n${ctx.parent ? M.opencodeResumeFooter : M.opencodeDiscussFooter(cwd, schemaText)}\n`;
  const { id, dir, release } = await newRunDir();
  const context = { ...ctx, ...(exec ? {} : { readonly: readonlyLevel(agent, ctx.kind) }), id, dir, release, prompt };
  if (exec) return execute(context, {
    capabilities, describe: () => ({ sandbox: null, modelShown: model, modelName: model }),
    run: ({ run }) => opencodeSession(run, schema, agentId),
  });
  const run = startRun(context);
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${D.started(mode, modelLabel(run.meta), level, dir)}\n`);
  return finishDiscussion(run, { ...await opencodeSession(run, schema, agentId), files, changesNote: M.opencodeNoChanges });
}

async function opencodeSession(run, schema, agentId) {
  const { ctx, started, meta, writeMeta } = run;
  const { dir, agentName, agent, model, effort, cwd, prompt } = ctx;
  const exec = ctx.kind === 'exec';
  const limits = runLimits(ctx, started), { deadline } = limits;
  const stallMin = exec && agent.run_access === 'shell' && !capabilities.command_start_events ? 0 : limits.stallMin;
  const event = eventWriter(dir);
  for (const file of ['events.jsonl', 'opencode.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, file), '');
  const errors = [], warnings = [], notes = [];
  const recovered = new Set();
  const observed = { messages: [], questions: [] };
  let repairing = false;
  const fileChanges = new Set();
  let commands = 0, items = 0, seenSession = false, last = '', report = null;
  // 翻译成 Codex 的事件形状，让 watch 和 status 共用现有的时间线、命令和报告显示。
  const translate = (ev) => {
    if (ev.sessionID && !seenSession) {
      seenSession = true;
      meta.session_id = ev.sessionID;
      writeMeta();
      event({ type: 'thread.started', thread_id: ev.sessionID });
    }
    if (ev.type === 'reasoning' || ev.type === 'text') {
      if (ev.type === 'text') last = ev.part?.text || '';
      event({ type: 'item.completed', item: { type: ev.type === 'reasoning' ? 'reasoning' : 'agent_message', text: ev.part?.text || '' } });
    } else if (ev.type === 'tool_use') {
      const { tool, state = {} } = ev.part || {};
      const input = state.input || {};
      const target = input.filePath || input.path;
      const category = ['edit', 'write'].includes(tool) || (typeof target === 'string' && /edit|write|patch/i.test(tool)) ? 'edit'
        : ['shell', 'bash'].includes(tool) ? 'shell' : ['grep', 'glob', 'list', 'search'].includes(tool) ? 'search' : 'read';
      const item = { id: `opencode-${++items}`, tool, category };
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
      timeoutMs: deadline - Date.now(), stallMin });
    errors.push(...out.errors);
    for (const error of out.recovered) recovered.add(error);
    observed.questions.push(...out.questions);
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
    // 最后一步没有 step_finish，用会话导出按开始时间过滤，包含同一轮的格式修复。
    const exported = await runOpencode({ agent, args: ['session', 'export', '--standalone', meta.session_id], cwd, timeoutMs: 60000 });
    try {
      if (exported.status !== 'done') throw new Error(exported.errors.join('; ') || exported.stderrTail || exported.status);
      const messages = JSON.parse(exported.stdout).messages.filter((m) => m.type === 'assistant' && m.time.created >= started);
      usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
      cost = 0;
      for (const m of messages) {
        const t = m.tokens || {}; // 出错的那条回复没有 tokens
        usage.input_tokens += (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
        usage.cached_input_tokens += t.cache?.read || 0;
        usage.output_tokens += t.output || 0;
        usage.reasoning_output_tokens += t.reasoning || 0;
        cost += m.cost || 0;
      }
    } catch (e) { usage = null; cost = null; notes.push(M.opencodeExportFailed(e.message)); }
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
