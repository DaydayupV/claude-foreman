// 三种执行路径共用的登记、事件、取消、报告修复和结果落盘；快照执行使用适配器回调。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_SESSION, checkAdmission, groupScopeOwner, isCancelled } from './records.mjs';
import { makeTracker } from './tracker.mjs';
import { computeReviewScope } from './review-scope.mjs';
import { M, die, notice, relativePath, pathKey, whoOf, modelOf, replaceFile, killTree, looksLikeQuestion, looksLikeInputPrompt, looksLikeFinalQuestion, needsDecision } from './util.mjs';

const INPUT_WAIT_MIN = 3;

function spawnCli(file, args, options, { onInput, busy = () => false, onStderrLine = () => {} }) {
  const child = spawn(file, args, options);
  const waitMin = Number(process.env.FOREMAN_TEST_INPUT_WAIT_MIN) || INPUT_WAIT_MIN;
  let lastOutputAt = Date.now(), prompt = null;
  const buffers = { stdout: '', stderr: '' };
  const inspect = (line, stream) => {
    if (stream === 'stdout') {
      try { JSON.parse(line); return; } catch { /* 只检查非 JSON 输出 */ }
    }
    if (looksLikeInputPrompt(line)) prompt = { line: line.trim(), at: lastOutputAt };
  };
  for (const stream of ['stdout', 'stderr']) {
    child[stream].setEncoding('utf8');
    child[stream].on('data', (chunk) => {
      lastOutputAt = Date.now();
      buffers[stream] += chunk;
      let i;
      while ((i = buffers[stream].indexOf('\n')) >= 0) {
        const line = buffers[stream].slice(0, i).replace(/\r$/, '');
        buffers[stream] = buffers[stream].slice(i + 1);
        inspect(line, stream);
        if (stream === 'stderr') onStderrLine(line);
      }
    });
  }
  const timer = setInterval(() => {
    // 终端提示常不带换行；未收完整的 JSON 仍属于协议输出，不能当作终端提问。
    for (const stream of ['stdout', 'stderr']) {
      if (buffers[stream] && (stream === 'stderr' || !/^\s*(?:\{|\[(?!y\/n\]))/i.test(buffers[stream]))) inspect(buffers[stream], stream);
    }
    if (!prompt || Date.now() - Math.max(prompt.at, lastOutputAt) < waitMin * 60000 || busy()
      || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    clearInterval(timer);
    onInput(prompt.line, waitMin);
    killTree(child.pid);
  }, Math.min(1000, waitMin * 60000));
  child.once('close', () => {
    clearInterval(timer);
    if (buffers.stderr) onStderrLine(buffers.stderr);
  });
  return child;
}

function collectQuestions({ mode, kind, agent_type, report, last = '', messages = [], questions = [] }) {
  // 没有原生审查的 CLI（opencode、pi）审查时只交回文字，不按提问收集。
  const review = kind === 'review' && ['opencode cli', 'pi cli'].includes(agent_type);
  const permissions = new Set();
  const collected = questions.filter((q) => {
    if (q.source !== 'permission_denied') return true;
    const key = q.detail || q.question;
    if (permissions.has(key)) return false;
    permissions.add(key);
    return true;
  });
  if (kind === 'discuss') {
    for (const question of report?.open_questions || []) collected.push({ source: 'open_question', question });
  } else if (mode === 'run' || mode === 'resume') {
    for (const q of report?.decision_requests || []) collected.push({ source: 'decision_request', question: q.question,
      options: q.options, recommendation: q.recommendation, detail: q.why_it_matters });
  }
  for (const text of review ? [] : messages.slice(0, -1)) {
    if (looksLikeQuestion(text)) collected.push({ source: 'asked_mid_run', question: text.slice(0, 500) });
  }
  if (!review && !report && looksLikeFinalQuestion(last)) collected.push({ source: 'final_question', question: last.slice(0, 2000) });
  return collected.map((q) => ({ source: q.source, question: q.question ?? null, options: q.options ?? [],
    recommendation: q.recommendation ?? null, detail: q.detail ?? null }));
}

function startRun(ctx, { started = Date.now(), track = [], modelShown = ctx.model, modelName = modelShown, sandbox = null, atomic = true } = {}) {
  const { id, dir, cwd, model, mode, kind, level, effort, agentName, agent, opts } = ctx;
  const meta = {
    id, mode, kind, title: ctx.title || null, cwd, model, model_shown: modelShown, model_name: modelName, level, effort,
    module: ctx.module ?? (kind === 'exec' ? 'run' : kind), cell: ctx.cell ?? level,
    plan: ctx.plan ?? null, seat: ctx.seat ?? null, role: ctx.role ?? null,
    ...(ctx.outside_cell ? { outside_cell: true } : {}), ...(ctx.model_overridden ? { model_overridden: true } : {}),
    agent: agentName, agent_type: agent.type, sandbox, parent: ctx.parent || null,
    ...(kind === 'exec' && ctx.isolation === 'tools' ? { isolation: ctx.isolation, run_access: agent.run_access } : {}),
    track, group: opts.group ?? null, scope: opts.scope, round: ctx.round ?? null,
    started_at: new Date(started).toISOString(), status: 'running', pid: process.pid, session_id: ctx.sessionId || null,
    claude_session: CLAUDE_SESSION,
  };
  const writeMeta = () => {
    const file = path.join(dir, 'meta.json');
    // 同组任务会并发读取元数据，替换完整文件，避免把半份 JSON 当成没有记录。
    const target = atomic || meta.group != null ? `${file}.tmp` : file;
    fs.writeFileSync(target, JSON.stringify(meta, null, 2));
    if (target !== file) replaceFile(target, file);
  };
  let rejection;
  try {
    writeMeta();
    rejection = checkAdmission(meta, ctx.cfg);
    if (rejection) fs.rmSync(dir, { recursive: true });
  } finally { ctx.release(); }
  if (rejection) die(rejection);
  if (ctx.reviewScope) {
    const { patch, ...scope } = ctx.reviewScope;
    fs.writeFileSync(path.join(dir, 'review.patch'), patch);
    fs.writeFileSync(path.join(dir, 'review-scope.json'), JSON.stringify(scope, null, 2));
  }
  return { ctx, started, meta, writeMeta };
}

function finishRun(run, result, code = result.exit_code, observed = {}) {
  const { module, cell, plan, seat, role, outside_cell, model_overridden } = run.meta;
  Object.assign(result, { module, cell, plan, seat, role, ...(outside_cell ? { outside_cell: true } : {}), ...(model_overridden ? { model_overridden: true } : {}) });
  if (run.ctx.kind === 'review') {
    const scope = run.ctx.reviewScope;
    result.review_scope = scope ? { kind: scope.kind, description: scope.description, base: scope.base,
      merge_base: scope.merge_base, commit: scope.commit, files_total: scope.files.length, fingerprint: scope.fingerprint } : null;
    if (scope) {
      let after;
      try { after = computeReviewScope({ ...run.ctx.opts, cwd: run.ctx.cwd }).fingerprint; }
      catch (e) { result.warnings.push(e.message); }
      if (after !== scope.fingerprint) result.warnings.push(M.reviewScopeChanged);
    }
  }
  result.questions = collectQuestions({ ...result, ...observed, last: observed.last ?? result.last_message ?? '' });
  const decisions = result.questions.filter(needsDecision).length;
  result.needs_decision = decisions > 0;
  if (decisions) result.notes.push(M.needsDecisionNote(decisions));
  fs.writeFileSync(path.join(run.ctx.dir, 'result.json'), JSON.stringify(result, null, 2));
  run.writeMeta(); // 在 result.json 之后写，watch 看到状态变化时结果已经就绪
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = code;
  return result;
}

function finishDiscussion(run, { usage, cost, commands = 0, errors, notes, warnings, report, last, files, changesNote, observed = {} }) {
  const { ctx, meta, started } = run;
  const { id, dir, mode, cwd, agentName, agent, model, level, effort } = ctx;
  meta.ended_at = new Date().toISOString();
  return finishRun(run, {
    run_id: id, mode, kind: ctx.kind, status: meta.status, title: meta.title, cwd, track: [], group: meta.group, round: meta.round, scope: meta.scope,
    agent: agentName, agent_type: agent.type, model, model_shown: meta.model_shown, level, effort, sandbox: null, parent: meta.parent, session_id: meta.session_id,
    exit_code: meta.status === 'done' ? 0 : 1, duration_s: Math.round((Date.now() - started) / 1000), usage, usage_scope: 'this_run',
    ...(cost !== undefined ? { cost_usd: cost } : {}),
    last_request: null, rate_limit: null, quota_resets_at: null, commands_executed: commands, errors, notes, warnings, report,
    last_message: report ? undefined : last, changes: { available: false, note: changesNote },
    files: files.map(({ path, range, chars }) => ({ path, range, chars })), run_dir: dir,
  }, undefined, { ...observed, last });
}

function eventWriter(dir, stream) {
  return (ev) => {
    const line = JSON.stringify({ ...ev, ts: new Date().toISOString() }) + '\n';
    if (stream) stream.write(line);
    else fs.appendFileSync(path.join(dir, 'events.jsonl'), line);
  };
}

function runLimits(ctx, started) {
  const timeoutMin = Number(ctx.opts.timeout) || ctx.cfg.dispatch.timeout_min;
  return { timeoutMin, deadline: started + timeoutMin * 60000, stallMin: Number(ctx.opts.stall ?? ctx.cfg.dispatch.stall_min) };
}

// 保留各执行路径原有的终止策略，只共用一秒一次的标记检查。
const watchCancellation = (dir, cancel) => setInterval(() => { if (isCancelled(dir)) cancel(); }, 1000);

async function reportWithRepair({ request, schema, validate, repair, onInvalid }) {
  for (let attempt = 0; attempt <= 1; attempt++) {
    const reply = await request();
    if (!reply) return null;
    const parsed = parseReport(reply.last, schema, validate);
    if (!parsed.invalid.length) return parsed.report;
    if (looksLikeFinalQuestion(reply.last)) return null;
    if (attempt === 1 || reply.canRepair === false) { onInvalid(); return null; }
    repair(parsed.invalid);
  }
}

function parseReport(last, schema, validateSchema) {
  try {
    let value;
    try { value = JSON.parse(last); }
    catch {
      const stripped = last.trim().replace(/^```[^\n]*\n/, '').replace(/\n```$/, '');
      value = JSON.parse(stripped.slice(stripped.indexOf('{'), stripped.lastIndexOf('}') + 1));
    }
    const invalid = validateSchema(schema, value);
    return { report: invalid.length ? null : value, invalid };
  } catch { return { report: null, invalid: [last.trim() ? 'Reply is not valid JSON' : 'Reply is empty'] }; }
}

async function execute(ctx, { run: runAgent, stats: sessionStats = () => null, describe, schema, validate, capabilities }) {
  const { agentName, agent, model, mode, kind, id, dir, cwd, level, effort, args, prompt, opts, expectReport } = ctx;
  const { isolation } = capabilities;
  const snapshotRequired = kind === 'exec' && isolation !== 'os';
  const started = Date.now();
  const track = [...new Map(opts.track.map((file) => {
    const rel = relativePath(cwd, file);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) die(M.badArg(`--track ${file}`));
    return [pathKey(rel), rel];
  })).values()];
  const { sandbox, modelShown, modelName } = describe(ctx);
  const run = startRun({ ...ctx, isolation }, { started, track, sandbox, modelShown, modelName, atomic: false });
  const { meta, writeMeta } = run;
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${M.started(mode, whoOf(meta), level, dir)}\n`);
  if (snapshotRequired) notice(M.unsandboxedRun(agent.run_access));

  const warnings = [];
  const notes = [];
  if (snapshotRequired && ctx.parent && ctx.previousRunAccess !== agent.run_access) notes.push(M.runAccessChanged(ctx.previousRunAccess, agent.run_access));
  let tracker = null;
  let before = null;
  let snapshotError = null;
  if (!opts['no-snapshot']) {
    try { tracker = makeTracker(dir, cwd, track); before = tracker.snap('before'); }
    catch (e) {
      if (snapshotRequired) snapshotError = M.snapshotFailedNoStart(e.message);
      else warnings.push(M.trackingUnavailable(e.message));
      tracker?.cleanup(); tracker = null;
    }
  }

  const baseline = mode === 'resume' ? sessionStats(ctx.sessionId, meta.started_at)?.total_token_usage : {};
  const r = snapshotError ? { status: 'failed', code: 1, errors: [snapshotError], warnings: [], fileChanges: new Set(), images: [], commands: 0, usage: null, cost: null }
    : await runAgent({
      agent, args, cwd, prompt, runDir: dir,
      ...runLimits(ctx, started),
      run,
      sessionId: ctx.sessionId,
      onSession: (sid) => { meta.session_id = sid; writeMeta(); },
    });

  const lastFile = path.join(dir, 'last-message.txt');
  const last = fs.existsSync(lastFile) ? fs.readFileSync(lastFile, 'utf8').trim() : '';
  let report = r.report || null;
  if (!Object.hasOwn(r, 'report') && expectReport && last) {
    report = parseReport(last, schema, validate).report;
    if (!report && !looksLikeFinalQuestion(last)) warnings.push(M.badReport);
  }
  if (!report && last.length > 8000) notes.push(M.lastMessageTruncated(lastFile));
  notes.push(...(r.notes || []));

  const reported = (report?.files_changed || []).map((f) => relativePath(cwd, f.path));
  const agentPaths = new Set([...r.fileChanges].map((f) => pathKey(relativePath(cwd, f))));
  let changes = { available: false, agent_total: 0, reported_total: 0, unknown_total: 0 };
  if (tracker) {
    try { changes = { available: true, ...tracker.diff(before, tracker.snap('after'), path.join(dir, 'diff.patch')) }; }
    catch (e) { warnings.push(M.trackingFailed(e.message)); }
    finally { tracker.cleanup(); }
  }
  const tracked = [...(changes.files || []), ...(changes.large_files_changed || [])];
  // 归属分三种：agent 有工具事件作证据；reported 只有协作方在报告里自称改过（比如用脚本写的文件）；unknown 都没有，可能是别人改的。
  const reportedPaths = new Set(reported.map(pathKey));
  for (const file of tracked) {
    const key = pathKey(relativePath(cwd, file.path));
    file.by = agentPaths.has(key) ? 'agent' : reportedPaths.has(key) ? 'reported' : 'unknown';
  }
  changes.agent_total = tracked.filter((f) => f.by === 'agent').length;
  changes.reported_total = tracked.filter((f) => f.by === 'reported').length;
  changes.unknown_total = tracked.length - changes.agent_total - changes.reported_total;
  if (kind !== 'exec' && changes.agent_total + changes.reported_total) warnings.push(M.readonlyChanged(kind, changes.agent_total + changes.reported_total));
  const ownerOf = groupScopeOwner(meta);
  const groupOwned = tracked.filter((f) => f.by === 'unknown').map((f) => ({ f, owner: ownerOf(relativePath(cwd, f.path)) })).filter((x) => x.owner);
  for (const { f, owner } of groupOwned) f.group_run = owner;
  if (groupOwned.length) notes.push(M.groupScopeChanges(groupOwned.length, M.list([...new Set(groupOwned.map((x) => x.owner))])));
  if (changes.unknown_total > groupOwned.length) notes.push(M.unattributedChanges(changes.unknown_total - groupOwned.length));
  const trackedPaths = new Set(tracked.map((f) => pathKey(relativePath(cwd, f.path))));
  const untracked = [...new Map(reported.filter((f) => !trackedPaths.has(pathKey(f))).map((f) => [pathKey(f), f])).values()];
  if (untracked.length) notes.push(M.reportedNotTracked(untracked));

  // 重连之类的 error 事件不一定致命，成败以退出码为准，errors 照常汇报。
  const ok = r.status ? r.status === 'done' : r.code === 0 && !r.timedOut && !r.stalled && !r.needsInput;
  if (!ok && !r.errors.length) {
    // 参数错误等情况 codex 不产生事件，只在 stderr 留信息，把末尾几行带出来。
    const tail = String(r.stderrTail || '').trim().split('\n').slice(-5).join('\n');
    if (tail) r.errors.push(M.exitCode(r.code, tail));
  }
  const quotaExhausted = !ok && (r.quotaExhausted || r.errors.some((e) => /usage limit|quota/i.test(e)));
  meta.status = r.status || (ok ? 'done' : r.cancelled ? 'cancelled' : r.needsInput ? 'needs_input' : quotaExhausted ? 'quota_exhausted' : r.stalled ? 'stalled' : r.timedOut ? 'timeout' : 'failed');
  if (r.cancelled) r.errors = [M.runCancelled(modelOf(meta))];
  meta.session_id = r.sessionId || meta.session_id;
  meta.ended_at = new Date().toISOString();
  const stats = sessionStats(meta.session_id, meta.started_at);
  const total = stats?.total_token_usage || r.usage;
  const usage = total && (baseline ? Object.fromEntries(
    ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']
      .map((key) => [key, (total[key] || 0) - (baseline[key] || 0)]),
  ) : total);
  const resetsAt = stats?.rate_limit?.resets_at;
  const quotaResetsAt = resetsAt == null ? null : new Date(resetsAt * 1000).toISOString();
  if (quotaExhausted && !r.status) {
    const date = quotaResetsAt && new Date(quotaResetsAt);
    const pad = (n) => String(n).padStart(2, '0');
    const local = date && `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    r.errors.push(M.quotaExhausted(local));
  }

  const result = {
    agent: agentName, agent_type: agent.type,
    ...(snapshotRequired ? { isolation, run_access: agent.run_access } : {}),
    ...(r.cost !== undefined ? { cost_usd: r.cost } : {}),
    run_id: id,
    mode,
    kind,
    status: meta.status,
    title: meta.title,
    cwd,
    track,
    group: meta.group,
    round: meta.round,
    scope: meta.scope,
    model,
    model_shown: modelShown,
    level,
    effort,
    sandbox,
    parent: meta.parent,
    session_id: meta.session_id,
    exit_code: r.code,
    duration_s: Math.round((Date.now() - started) / 1000),
    usage,
    usage_scope: r.usage_scope ?? (total ? (baseline ? 'this_run' : 'session_total') : null),
    last_request: stats?.last_request || null,
    rate_limit: stats?.rate_limit || null,
    quota_resets_at: quotaResetsAt,
    commands_executed: r.commands,
    errors: r.errors,
    notes,
    warnings: [...warnings, ...r.warnings.filter((w) => !/^Under-development features enabled/.test(w))],
    report,
    last_message: report ? undefined : last.slice(0, 8000),
    changes: changes.available
      ? { ...changes, files: changes.files.slice(0, 300), files_total: changes.files.length, note: M.trackNote }
      : changes,
    generated_images: r.images.length ? r.images : undefined, // 只列这一轮生成的
    image_calls: r.imageCalls?.length ? r.imageCalls : undefined, // 每次出图实际传的参数，读自 Codex 会话记录
    run_dir: dir,
  };
  return finishRun(run, result, ok ? 0 : 1, { messages: r.messages, questions: r.questions, last });
}

export { startRun, finishRun, finishDiscussion, eventWriter, runLimits, watchCancellation, parseReport, reportWithRepair, execute, collectQuestions, spawnCli };

export function validateSchema(schema, value) {
  const errors = [];
  const check = (rule, item, at) => {
    const label = at || '$';
    const type = Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item;
    if (rule.type && type !== rule.type) { errors.push(`${label} must be ${rule.type}`); return; }
    if (rule.enum && !rule.enum.includes(item)) errors.push(`${label} must be one of ${rule.enum.join(', ')}`);
    if (type === 'object') {
      for (const key of rule.required || []) {
        if (!Object.hasOwn(item, key)) errors.push(`${at ? `${at}.` : ''}${key} is required`);
      }
      for (const [key, val] of Object.entries(item)) {
        const next = at ? `${at}.${key}` : key;
        if (Object.hasOwn(rule.properties || {}, key)) check(rule.properties[key], val, next);
        else if (rule.additionalProperties === false) errors.push(`${next} is not allowed`);
      }
    } else if (type === 'array' && rule.items) item.forEach((val, i) => check(rule.items, val, `${at}[${i}]`));
  };
  check(schema, value, '');
  return errors;
}
