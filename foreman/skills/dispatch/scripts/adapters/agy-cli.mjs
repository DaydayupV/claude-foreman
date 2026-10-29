// Agy CLI：只读讨论和审查，全局守卫自检、stream-json 翻译、清单和 check。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../review-scope.mjs';
import { newRunDir, isCancelled, cancelSource, announceBoard } from '../records.mjs';
import { startRun, finishDiscussion, eventWriter, runLimits, reportWithRepair, spawnCli, validateSchema } from '../runner.mjs';
import { M, die, killTree, readAttachments, filesOutside, focusFiles, relativePath, closestMatches, sleep } from '../util.mjs';
import { D, modelLabel, toolLabel } from '../format.mjs';
import { defaultMaxParallel } from './parallel.mjs';
import { AGY_EFFORTS, splitAgyModel, agyFamilies, agyModelId } from './agy-models.mjs';
import { agyCommand, guardEnvironment, policyFor, prepareAgyRun, preflightAgy, scanProject, queryAgy, probeSandbox, workDir, removeWorkDir, timeLeft } from './agy-setup.mjs';
import { spawnSync } from 'node:child_process';

const capabilities = { modes: ['discuss', 'review'], isolation: 'tools', reads_code: true, reads_images: false, native_schema: false,
  native_review: false, images: false, resume: true, command_start_events: true };
const PROGRESS_MS = Number(process.env.FOREMAN_TEST_PROGRESS_MS) || 5000;
const modelProblem = (e) => e.code === 'agyModelMissing' ? M.agyModelMissing(e.args[0], closestMatches(e.args[0], e.args[1]).join(', '))
  : e.args ? M[e.code](...e.args) : e.message;
const usageOf = (u) => ({ input_tokens: (u.input_tokens || 0) + (u.cache_read_tokens || 0), cached_input_tokens: u.cache_read_tokens || 0,
  output_tokens: u.output_tokens || 0, reasoning_output_tokens: u.thinking_tokens || 0 });
// 1.4.8 的事件正文位于同名键里；下游只处理平铺对象，原始行仍用于留档。
function normalizeEvent(ev) {
  const body = ev?.[ev.event];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return { event: ev.event, ...body, conversation_id: ev.conversation_id ?? body.conversation_id };
}
function toolInfo(ev) {
  const raw = ev.tool_info?.error ?? ev.error;
  const error = (typeof raw === 'string' ? raw : raw?.message) || (ev.state === 'ERROR' ? 'tool failed' : null);
  const output = String(ev.tool_info?.output ?? '');
  return { args: ev.tool_info?.parameters || {}, output, error,
    exit_code: error ? 1 : Number(/^Command exited with code (-?\d+)\./.exec(output)?.[1] ?? 0) };
}
function agyArgs({ model, session, sandbox, runDir, addDirs = [] }) {
  return ['-p=', '--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model,
    '--dangerously-skip-permissions', '--disable-slash-commands', '--log-file', path.join(runDir, 'agy.log'),
    ...(sandbox ? ['--sandbox'] : []), ...(session ? ['--conversation', session] : []), ...addDirs.flatMap((d) => ['--add-dir', d])];
}

async function runAgy(options) {
  let out;
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + (options.timeoutMs ?? 120000));
  // 第 5 节：只重试还没产生任何一步的账号校验断流；每次重启重新自检并写标记。
  for (let attempt = 0; attempt < 2; attempt++) {
    out = await runOnce({ ...options, deadline });
    if (attempt || out.steps || !/Eligibility check failed[\s\S]*EOF/i.test(out.stderrTail) || out.status !== 'failed') break;
    await sleep(Math.min(2000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) return { ...out, status: 'timeout' };
  }
  return out;
}
async function runOnce({ agent, model = agent.model, cwd, addDirs = [], access = 'read', runDir, prompt, timeoutMs = 120000,
  stallMin = 0, session, sandbox = false, probeCommands, onEvent, deadline = Date.now() + timeoutMs }) {
  const out = { status: null, code: null, errors: [], notes: [], text: '', stderrTail: '', steps: 0, tools: [], result: null };
  const policy = policyFor({ cwd, addDirs, access, runDir, sandbox, probeCommands });
  let prepared;
  try { prepared = await prepareAgyRun(agent, policy, deadline); out.notes.push(...prepared.notes); }
  catch (e) { return { ...out, status: e.code === 'ETIMEDOUT' || Date.now() >= deadline ? 'timeout' : 'failed', errors: [e.message] }; }
  timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) { prepared.cleanup(); return { ...out, status: 'timeout' }; }
  const decisions = path.join(runDir, 'agy-guard.jsonl');
  const before = fs.existsSync(decisions) ? fs.statSync(decisions).size : 0;
  // 日志属于这一次进程，不能借上一轮的启用行放行命令。
  fs.writeFileSync(policy.log_file, '');
  return new Promise((resolve) => {
    const running = new Map(), done = new Set();
    const { file, pre } = agyCommand(agent);
    const child = spawnCli(file, [...pre, ...agyArgs({ model, session, sandbox, runDir, addDirs })], {
      cwd, env: guardEnvironment(policy), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    }, { busy: () => running.size > 0, onInput: (line, min) => { out.errors.push(M.inputWaitDetected(min, line)); stop('needs_input'); } });
    const stop = (status) => { if (out.status) return; out.status = status; if (child.pid) killTree(child.pid); };
    const onSignal = () => stop('cancelled');
    const onExit = () => { if (child.pid && child.exitCode === null) killTree(child.pid); prepared.cleanup(); };
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal); process.once('exit', onExit);
    let buf = '', lastAt = Date.now(), tools = 0, returnedId;
    const record = (line) => {
      let ev;
      try { ev = normalizeEvent(JSON.parse(line)); } catch { return; }
      if (!ev) return;
      lastAt = Date.now();
      if (!(ev.event === 'step_update' && ev.state === 'ACTIVE' && ev.text_delta)) fs.appendFileSync(path.join(runDir, 'agy.jsonl'), line + '\n');
      if (ev.conversation_id) {
        returnedId = ev.conversation_id;
        if (session && returnedId !== session) out.errors.push(M.agyConversationChanged(session, returnedId));
      }
      if (ev.event === 'step_update') {
        out.steps++;
        if (ev.step_type === 'tool') {
          if (ev.state === 'ACTIVE') { running.set(ev.step_index, ev); tools++; }
          else if (!done.has(ev.step_index)) {
            if (!running.has(ev.step_index)) tools++;
            const start = running.get(ev.step_index);
            out.tools.push({ tool: ev.tool_name || start?.tool_name, ...toolInfo(ev), args: { ...start?.tool_info?.parameters, ...ev.tool_info?.parameters } });
            running.delete(ev.step_index);
            done.add(ev.step_index);
          }
        }
      }
      if (ev.event === 'result') { out.result = ev; out.text = ev.response || ''; }
      onEvent?.(ev);
    };
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { record(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (chunk) => { out.stderrTail = (out.stderrTail + chunk).slice(-4000); fs.appendFileSync(path.join(runDir, 'stderr.log'), chunk); });
    const timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    const poll = setInterval(() => {
      if (isCancelled(runDir)) stop('cancelled');
      else if (stallMin && !running.size && Date.now() - lastAt >= stallMin * 60000) stop('stalled');
    }, 1000);
    child.on('error', (e) => out.errors.push(e.message));
    child.on('close', (code) => {
      clearTimeout(timer); clearInterval(poll);
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); process.removeListener('exit', onExit);
      try {
        if (buf.trim()) record(buf);
        out.code = code;
        if (isCancelled(runDir)) out.status = 'cancelled';
        if (tools && (!fs.existsSync(decisions) || fs.statSync(decisions).size <= before)) out.errors.push(M.agyDecisionsMissing);
        const result = out.result;
        if (!result) out.errors.push(M.agyNoResult(out.stderrTail.trim()));
        else if (result.status !== 'SUCCESS') {
          const error = result.error || out.stderrTail || result.status, text = typeof error === 'string' ? error : JSON.stringify(error);
          // 实测 agy 有时在模型已经交回完整回复之后才报错（之后的一次请求被接口以 400 拒绝）：回复还在就照常采用，
          // 错误记进 notes，回复合不合格交给报告校验。
          if (out.text.trim()) { out.notes.push(M.agyErrorAfterReply(text)); out.lateError = true; }
          else out.errors.push(text);
        }
        else if (!out.text.trim()) out.errors.push(result.denied_actions?.length ? M.agyUncaughtDenial : M.agyEmptyReply);
        if (session && !returnedId) out.errors.push(M.agyConversationChanged(session, '?'));
        if (code !== 0 && !out.errors.length && !out.lateError) out.errors.push(M.exitCode(code, out.stderrTail.trim(), 'agy'));
        out.status ||= out.errors.length ? /RESOURCE_EXHAUSTED|quota|usage limit|insufficient quota/i.test(out.errors.join('\n') + out.stderrTail)
          && !/\b429\b|concurrency|rate.?limit/i.test(out.errors.join('\n') + out.stderrTail) ? 'quota_exhausted' : 'failed' : 'done';
        resolve(out);
      } finally { prepared.cleanup(); }
    });
    child.stdin.on('error', () => { /* 提前退出时忽略 EPIPE */ });
    child.stdin.end(JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } }) + '\n', 'utf8');
  });
}

async function executeAgy(ctx) {
  const { cwd, brief, opts } = ctx;
  if (ctx.parent && !ctx.sessionId) die(M.noSession(ctx.parent));
  ctx = { ...ctx, addDirs: ctx.addDirs || opts['add-dir'].map((d) => path.resolve(d)) };
  const review = ctx.kind === 'review', schemaText = fs.readFileSync(review ? REVIEW_SCHEMA : DISCUSS_SCHEMA, 'utf8');
  const files = readAttachments(opts.file, cwd, false), schema = JSON.parse(schemaText), outside = filesOutside(files, [cwd, ...ctx.addDirs]);
  if (outside.length) die(M.filesOutsideCwd(ctx.agentName, M.list(outside), true));
  let promptFor;
  if (review) {
    const scope = ctx.reviewScope, opening = { files: M.reviewPromptFiles, claims: M.reviewPromptClaims }[ctx.reviewTarget];
    const parts = opening ? [opening(cwd)] : [];
    if (brief) parts.push(brief);
    if (files.length) parts.push(focusFiles(files).trim());
    if (scope?.target === 'diff') {
      const material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
      if (material.tooLarge) die((scope.kind === 'commit' ? M.reviewCommitTooLarge : M.reviewTooLarge)(material.chars, MAX_REVIEW_CHARS));
      parts.push(M.reviewMaterial(material.fileList, material.patch, material.fence, material.note));
    }
    promptFor = (shell) => [M.agyReviewPrompt(cwd, scope?.description || ctx.reviewTarget, shell), ...parts, M.reviewFooter, M.reviewSchemaFooter(schemaText)].join('\n\n');
  } else promptFor = (shell) => `${brief}${focusFiles(files)}\n\n${ctx.parent ? M.opencodeResumeFooter : M.agyDiscussFooter(cwd, schemaText, shell)}\n`;
  const { id, dir, release } = await newRunDir(ctx);
  const run = startRun({ ...ctx, id, dir, release, readonly: 'tools' }, { sandbox: 'files-only' });
  const split = splitAgyModel(ctx.model);
  run.meta.model = run.meta.model_shown = run.meta.model_name = split.family;
  run.meta.effort = split.effort ?? (ctx.effort === 'default' ? null : ctx.effort);
  run.writeMeta();
  process.stderr.write(`foreman: ${D.started(ctx.mode, modelLabel(run.meta), ctx.level, dir)}\n`);
  announceBoard(ctx.cfg);
  return finishDiscussion(run, { ...await agySession(run, schema, promptFor), files, changesNote: M.agyNoChanges, sandbox: run.meta.sandbox });
}
async function agySession(run, schema, promptFor) {
  const { ctx, meta, writeMeta, started } = run, { dir, cwd, agent, model, effort, agentName, addDirs } = ctx;
  const split = splitAgyModel(model);
  ctx.model = meta.model;
  ctx.effort = meta.effort;
  const { deadline, stallMin } = runLimits(ctx, started), event = eventWriter(dir);
  const errors = [], notes = [], warnings = [], observed = { messages: [], questions: [] };
  let usage = null, pending = null, last = '', commands = 0, items = 0, repairing = false, nextPrompt = ctx.brief;
  let currentTools = new Map(), completed = new Set(), responses = new Map(), usageSteps = new Set(), progressAt = 0;
  const session = (ev) => {
    if (ev.conversation_id && !meta.session_id) { meta.session_id = ev.conversation_id; writeMeta(); event({ type: 'thread.started', thread_id: meta.session_id }); }
  };
  const translate = (ev) => {
    if (ev.event === 'init' || ev.event === 'result') session(ev);
    if (ev.event === 'result') for (const denial of ev.denied_actions || []) observed.questions.push({ source: 'permission_denied',
      question: typeof denial === 'string' ? denial : JSON.stringify(denial), detail: JSON.stringify(denial) });
    if (ev.event !== 'step_update') return;
    const key = ev.step_index;
    if (ev.step_type === 'agent_response') {
      const text = (responses.get(key) || '') + (ev.text_delta || '');
      responses.set(key, text);
      if (ev.state === 'ACTIVE' && ev.text_delta && Date.now() - progressAt >= PROGRESS_MS) {
        progressAt = Date.now(); event({ type: 'agy.progress', phase: 'answering', total_chars: text.length });
      }
      if (ev.state === 'DONE' && !usageSteps.has(key)) {
        usageSteps.add(key);
        const full = ev.text || text;
        if (full) { observed.messages.push(full); event({ type: 'item.completed', item: { type: 'agent_message', text: full } }); }
        if (ev.usage) {
          if (pending) event({ type: 'step.usage', usage: pending });
          pending = usageOf(ev.usage);
          usage ||= { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
          for (const [k, v] of Object.entries(pending)) usage[k] += v;
        }
      }
      return;
    }
    if (ev.step_type !== 'tool' || completed.has(key)) return;
    const info = toolInfo(ev), tool = ev.tool_name || currentTools.get(key)?.tool;
    if (!currentTools.has(key)) currentTools.set(key, { id: `agy-${++items}`, tool, args: info.args });
    const item = currentTools.get(key), args = { ...item.args, ...info.args };
    if (ev.state === 'ACTIVE') {
      if (tool === 'run_command') event({ type: 'item.started', item: { id: item.id, type: 'command_execution', tool, category: 'shell', command: args.CommandLine || '' } });
      return;
    }
    completed.add(key); currentTools.delete(key);
    const denial = /^tool call denied by pre-tool hook: foreman guard: (.*)/s.exec(String(info.error || info.output))?.[1];
    // 只读工具因为守卫不认识的参数被拦（agy 新版本加了参数）：用户没有什么可决定的，agy 会去掉参数重试，记成说明。
    const unknownArg = /^unexpected argument (\S+) for (read_file|view_file|run_command)$/.exec(denial?.trim() ?? '');
    if (unknownArg) notes.push(M.agyGuardUnknownArg(unknownArg[2], unknownArg[1]));
    else if (denial !== undefined) observed.questions.push({ source: 'permission_denied',
      question: `${tool} ${JSON.stringify(args)}`, detail: JSON.stringify({ tool, input: args }) });
    if (['edit_file', 'write_file'].includes(tool)) {
      event({ type: 'item.completed', item: { id: item.id, tool, type: 'file_change', category: 'edit', changes: [] } });
      return;
    }
    if (tool === 'run_command') commands++;
    const category = tool === 'run_command' ? 'shell' : 'read', target = args.Path;
    const shown = target ? relativePath(cwd, target) : '';
    event({ type: 'item.completed', item: { id: item.id, tool, type: 'command_execution', category,
      command: tool === 'run_command' ? args.CommandLine : `${tool}${shown ? ` ${shown}` : ''}`,
      ...(tool === 'run_command' ? {} : { label: toolLabel(category, tool, { path: shown }) }),
      exit_code: info.error ? 1 : info.exit_code ?? 0, aggregated_output: (info.error || info.output).slice(0, 2000) } });
  };
  let modelId = model;
  const lowLevel = (options) => runAgy({ agent, model: modelId, cwd, addDirs, deadline, ...options });
  let sandbox = false, ready = true;
  try {
    // 开头只做静态检查；每次模型请求（含探针、续接、修复）启动前再完整自检。
    notes.push(...await preflightAgy(policyFor({ cwd, addDirs, runDir: dir }), deadline));
    const version = queryAgy(agent, ['--version'], 60000, deadline);
    timeLeft(deadline);
    if (version.error || version.status !== 0) throw new Error(M.agyQueryFailed('--version', version.error?.message || version.stderr));
    const cat = agyCatalog(agent, deadline);
    modelId = cat.ok ? agyModelId(model, effort, cat.models) : split.effort || !effort || effort === 'default' ? model : `${model}-${effort}`;
    meta.agy_model_id = modelId;
    ctx.effort = meta.effort = splitAgyModel(modelId).effort;
    writeMeta();
    const probe = await probeSandbox({ agent, cwd, addDirs, version: version.stdout.trim(), run: lowLevel, deadline });
    timeLeft(deadline);
    sandbox = probe.available;
    meta.sandbox = sandbox ? 'agy-sandbox' : 'files-only';
    writeMeta();
    if (probe.tested) notes.push(M.agySandboxResult(probe.results));
    nextPrompt = promptFor(sandbox);
    if (!sandbox) {
      notes.push(M.agyNoSandbox);
      if (probe.results.layout === 'cross_volume') notes.push(M.agyNoShellCrossVolume);
      if (probe.results.network === 'host_offline') notes.push(M.agyNoShellOffline);
      const list = spawnSync('git', ['ls-files'], { cwd, encoding: 'utf8', windowsHide: true, timeout: timeLeft(deadline, 60000) });
      nextPrompt += `\n\n${M.agyFileList(list.status === 0 ? list.stdout.trim() : M.agyFileListUnavailable)}`;
    }
    timeLeft(deadline);
  } catch (e) { errors.push(modelProblem(e)); meta.status = e.code === 'ETIMEDOUT' || Date.now() >= deadline ? 'timeout' : 'failed'; ready = false; }
  fs.writeFileSync(path.join(dir, 'brief.md'), nextPrompt);
  const request = async () => {
    if (!ready) return null;
    if (isCancelled(dir)) { meta.status = 'cancelled'; return null; }
    if (Date.now() >= deadline) { meta.status = 'timeout'; return null; }
    currentTools = new Map(); completed = new Set(); responses = new Map(); usageSteps = new Set();
    const out = await lowLevel({ access: repairing ? 'none' : 'read', runDir: dir, session: meta.session_id, sandbox: !repairing && sandbox,
      prompt: nextPrompt, timeoutMs: deadline - Date.now(), stallMin, onEvent: translate });
    errors.push(...out.errors); notes.push(...out.notes);
    meta.status = out.status; last = out.text;
    return meta.status === 'done' ? { last, canRepair: !!meta.session_id } : null;
  };
  const report = await reportWithRepair({ schema, validate: validateSchema, request, allowQuestion: ctx.kind !== 'review',
    onInvalid: () => warnings.push(M.reportInvalid(agentName, path.join(dir, 'last-message.txt'))),
    repair: (invalid) => { repairing = true; nextPrompt = M.reportRepairPrompt(invalid.join('\n')); } });
  if (pending) event({ type: 'step.usage', usage: pending, final: true });
  if (meta.status === 'cancelled') errors.push(M.runCancelled(model, cancelSource(dir) ?? 'signal'));
  if (meta.status === 'stalled') errors.push(M.stalled(stallMin));
  if (meta.status === 'failed' && /rate.?limit|concurrency|too many requests|\b429\b/i.test(errors.join('\n'))) notes.push(M.rateLimited(model, 'agy'));
  fs.writeFileSync(path.join(dir, 'last-message.txt'), last);
  return { usage, errors, notes: [...new Set(notes)], warnings, report, last, commands, observed };
}

function agyCatalog(agent = {}, deadline) {
  const source = 'agy models', r = queryAgy(agent, ['models'], 60000, deadline);
  if (r.error || r.status !== 0) return { ok: false, source, models: [], error: r.error?.message || r.stderr || `exit ${r.status}` };
  const models = r.stdout.trim().split(/\r?\n/).filter((line) => line.includes('\t')).map((line) => {
    const [id, name] = line.split('\t');
    return id && name ? id : null;
  });
  return models.length && models.every(Boolean) ? { ok: true, source, models: agyFamilies(models).map((m) => ({ ...m, default_effort: null })), raw_ids: models, error: null }
    : { ok: false, source, models: [], error: M.agyCatalogInvalid };
}
async function checkAgy(name, agent, efforts = [], catalog = () => agyCatalog(agent), modes = [], cwd = process.cwd(), force = false) {
  const started = Date.now(), dir = workDir('check-');
  const out = { ok: false, type: 'agy cli', model: splitAgyModel(agent.model).family, version: null, model_listed: false, reply: null, error: null, fix: null, efforts: [], notes: [] };
  try {
    scanProject(cwd);
    const version = queryAgy(agent, ['--version']);
    if (version.error || version.status !== 0) throw new Error(M.agyQueryFailed('--version', version.error?.message || version.stderr));
    out.version = version.stdout.trim();
    const cat = catalog();
    if (!cat.ok) throw new Error(cat.error);
    out.efforts = efforts.map((e) => {
      const model = e.model || agent.model, supported = cat.models.find((m) => m.id === splitAgyModel(model).family)?.efforts ?? [];
      try { agyModelId(model, e.variant, cat.models); return { ...e, ok: true, supported }; }
      catch (error) { const problem = modelProblem(error); return { ...e, ok: false, supported, problem, error: problem }; }
    });
    out.model_listed = cat.models.some((m) => m.id === agent.model || Object.values(m.ids).includes(agent.model));
    if (!out.model_listed) throw new Error(M.agyModelMissing(agent.model, closestMatches(agent.model, cat.models.map((m) => m.id)).join(', ')));
    const selected = out.efforts.find((e) => e.ok);
    if (out.efforts.length && !selected) throw new Error(out.efforts[0].problem);
    const model = agyModelId(selected?.model || agent.model, selected?.variant, cat.models);
    out.notes.push(...await preflightAgy(policyFor({ cwd, runDir: dir }), Date.now() + 120000));
    const run = (options) => runAgy({ agent, model, cwd, ...options });
    out.sandbox = await probeSandbox({ agent, cwd, version: out.version, run, force });
    if (!out.sandbox.available) out.notes.push(M.agyNoSandbox);
    // 随机文件和 read_file 放行记录一起确认读取边界，不能只靠模型声称工具可用。
    const token = randomUUID(), file = path.join(dir, 'guard-check.txt');
    fs.writeFileSync(file, token);
    const reply = await run({ cwd: dir, access: 'read', runDir: dir, prompt: M.agyCheckPrompt(file), timeoutMs: 120000 });
    const contents = reply.text.replace(/\s/g, '');
    out.reply = contents.slice(0, 40);
    if (reply.status !== 'done') throw new Error(reply.errors.join('; '));
    if (contents !== token) throw new Error(M.agyQueryFailed('check', out.reply));
    const decisions = path.join(dir, 'agy-guard.jsonl');
    if (!fs.existsSync(decisions) || !fs.readFileSync(decisions, 'utf8').trim().split('\n').some((line) => {
      const decision = JSON.parse(line);
      return decision.tool === 'read_file' && decision.decision === 'allow';
    })) throw new Error(M.agyDecisionsMissing);
    const quota = queryAgy(agent, ['-p', '/quota', '--output-format', 'json']);
    if (quota.status !== 0 || quota.error) throw new Error(M.agyQueryFailed('/quota', quota.error?.message || quota.stderr));
    const body = JSON.parse(quota.stdout);
    if (body.command?.name !== 'usage' || !Array.isArray(body.command.data?.groups)
      || body.command.data.groups.some((g) => !Array.isArray(g.buckets))) throw new Error(M.agyQuotaInvalid);
    out.quota = body.command.data;
    if (out.quota.groups.some((g) => g.buckets.some((b) => b.remaining_fraction < 0.1))) out.notes.push(M.agyQuotaLow);
    out.ok = out.efforts.every((e) => e.ok);
  } catch (e) { out.error = modelProblem(e); out.fix = M.agyCheckFix(name); }
  finally { removeWorkDir(dir); }
  return { ...out, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
}
export default { type: 'agy cli', capabilities, defaultMaxParallel: defaultMaxParallel('agy cli'), readonlyLevel: () => 'tools', channel: M.channel.agy, efforts: ['default', ...AGY_EFFORTS],
  listModelsArgs: ['models'], validate: (agent, key, check, text) => {
    check(text(agent.model), `${key}.model`, M.invalid.modelName);
    check(agent.bin == null || text(agent.bin), `${key}.bin`, M.invalid.stringOrNull);
    check(agent.run_access === undefined, `${key}.run_access`, M.agyReadOnly);
  }, status: (agent) => { const { file, pre } = agyCommand(agent); return { bin: agent.bin || pre[0] || file }; },
  locate: agyCommand, query: queryAgy, catalog: agyCatalog, check: checkAgy, execute: executeAgy,
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); } };
