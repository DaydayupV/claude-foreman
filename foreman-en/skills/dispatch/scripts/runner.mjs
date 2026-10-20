// 三种执行路径共用的登记、事件、取消、报告修复和结果落盘；快照执行使用适配器回调。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { CLAUDE_SESSION, checkAdmission, groupScopeOwner, absolute, isCancelled, cancelSource, saveMeta } from './records.mjs';
import { makeTracker } from './tracker.mjs';
import { computeReviewMaterial, computeReviewScope } from './review-scope.mjs';
import { M, die, notice, relativePath, pathKey, modelOf, replaceFile, killTree, looksLikeQuestion, looksLikeInputPrompt, looksLikeFinalQuestion, needsDecision } from './util.mjs';
import { D, modelLabel } from './format.mjs';

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
  const review = kind === 'review';
  const permissions = new Set();
  const collected = questions.filter((q) => {
    if (review && ['asked_mid_run', 'final_question'].includes(q.source)) return false;
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

function startRun(ctx, { started = Date.now(), track = [], modelShown = ctx.model, modelName = modelShown, sandbox = null } = {}) {
  const { id, dir, cwd, model, mode, kind, level, effort, agentName, agent, opts } = ctx;
  const meta = {
    id, mode, kind, title: ctx.title || null, cwd, model, model_shown: modelShown, model_name: modelName, level, effort,
    module: ctx.module ?? (kind === 'exec' ? 'run' : kind), cell: ctx.cell ?? level,
    ...(ctx.module === 'image' ? { step: ctx.step, route: ctx.route } : {}),
    plan: ctx.plan ?? null, seat: ctx.seat ?? null, role: ctx.role ?? null,
    ...(ctx.outside_cell ? { outside_cell: true } : {}), ...(ctx.model_overridden ? { model_overridden: true } : {}),
    agent: agentName, agent_type: agent.type, sandbox, parent: ctx.parent || null,
    ...(kind === 'review' ? { review_target: ctx.reviewTarget } : {}),
    ...(kind === 'exec' && ctx.isolation === 'tools' ? { isolation: ctx.isolation, run_access: agent.run_access } : {}),
    track, group: opts.group ?? null, scope: opts.scope, round: ctx.round ?? null,
    started_at: new Date(started).toISOString(), status: 'running', pid: process.pid, session_id: ctx.sessionId || null,
    claude_session: CLAUDE_SESSION,
  };
  const writeMeta = () => saveMeta(dir, meta);
  let rejection;
  try {
    writeMeta();
    rejection = checkAdmission(meta, ctx.cfg);
    if (rejection) fs.rmSync(dir, { recursive: true });
  } finally { ctx.release(); }
  if (rejection) die(rejection);
  if (ctx.reviewScope) {
    const { patch, ...scope } = ctx.reviewScope;
    if (scope.target === 'diff') fs.writeFileSync(path.join(dir, 'review.patch'), patch);
    fs.writeFileSync(path.join(dir, 'review-scope.json'), JSON.stringify(scope, null, 2));
  }
  return { ctx, started, meta, writeMeta };
}

function finishRun(run, result, code = result.exit_code, observed = {}) {
  const { module, cell, plan, seat, role, outside_cell, model_overridden } = run.meta;
  Object.assign(result, { module, cell, plan, seat, role, ...(outside_cell ? { outside_cell: true } : {}), ...(model_overridden ? { model_overridden: true } : {}) });
  if (module === 'image') Object.assign(result, { step: run.meta.step, route: run.meta.route });
  if (run.ctx.kind !== 'exec') {
    result.readonly = run.ctx.readonly;
    if (result.readonly_violation?.length) {
      result.status = run.meta.status = 'failed';
      result.exit_code = code = 1;
      result.errors.push(M.readonlyViolated(run.ctx.kind, result.readonly_violation.length));
    }
  }
  if (run.ctx.kind === 'review') {
    const scope = run.ctx.reviewScope;
    result.review_target = run.ctx.reviewTarget;
    result.native_review = !!run.ctx.nativeReview;
    result.stale = null;
    result.review_scope = scope ? { kind: scope.kind, description: scope.description, base: scope.base,
      merge_base: scope.merge_base, commit: scope.commit, files_total: scope.files.length, fingerprint: scope.fingerprint } : null;
    if (scope) {
      let after;
      // 结束时材料可能已被删掉，不能调用会 die 的附件校验，否则结果无法落盘。
      try {
        const options = { ...run.ctx.opts, cwd: run.ctx.cwd };
        after = (scope.target === 'diff' ? computeReviewScope(options) : computeReviewMaterial(options)).fingerprint;
      }
      catch (e) { result.warnings.push(e.message); }
      result.stale = after !== scope.fingerprint;
      if (result.stale) result.warnings.push(M.reviewScopeChanged);
    }
  }
  // 取消时只记得到已经完成的请求的用量：正在进行的那次请求，厂商不报用量。一次都没完成时记为 null，不写成 0。
  if (result.status === 'cancelled') {
    const spent = !!result.usage && Object.values(result.usage).some((n) => n > 0);
    if (!spent) Object.assign(result, { usage: null, usage_scope: null });
    result.notes.push(spent ? M.cancelledUsagePartial : M.cancelledUsageMissing);
  }
  result.questions = collectQuestions({ ...result, ...observed, last: observed.last ?? result.last_message ?? '' });
  const decisions = result.questions.filter(needsDecision).length;
  result.needs_decision = decisions > 0;
  if (decisions) result.notes.push(M.needsDecisionNote(decisions));
  // 先写临时文件再改名：调度进程被强行结束时，不会留下写了一半的结果。
  const resultFile = path.join(run.ctx.dir, 'result.json');
  fs.writeFileSync(`${resultFile}.tmp`, JSON.stringify(result, null, 2));
  replaceFile(`${resultFile}.tmp`, resultFile);
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

// 排除续接前已有的图片，每张新图只发一次事件并累计本轮结果。
function imageScanner({ images, previousSessionId, emit }) {
  const seen = new Set(images.list(previousSessionId)), generated = [];
  return {
    scan(sessionId) {
      for (const file of images.list(sessionId)) {
        if (seen.has(file)) continue;
        seen.add(file);
        generated.push(file);
        emit({ type: 'image.generated', path: file });
      }
      return generated;
    },
  };
}

function runLimits(ctx, started) {
  const timeoutMin = Number(ctx.opts.timeout) || ctx.cfg.dispatch.timeout_min;
  return { timeoutMin, deadline: started + timeoutMin * 60000, stallMin: Number(ctx.opts.stall ?? ctx.cfg.dispatch.stall_min) };
}

// 保留各执行路径原有的终止策略，只共用一秒一次的标记检查。
const watchCancellation = (dir, cancel) => setInterval(() => { if (isCancelled(dir)) cancel(); }, 1000);

async function reportWithRepair({ request, schema, validate, repair, onInvalid, allowQuestion = true }) {
  for (let attempt = 0; attempt <= 1; attempt++) {
    const reply = await request();
    if (!reply) return null;
    const parsed = parseReport(reply.last, schema, validate);
    if (!parsed.invalid.length) return parsed.report;
    if (allowQuestion && looksLikeFinalQuestion(reply.last)) return null;
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

// SVG 分块读取并保留边界重叠，找到位图标签就停，读不到的文件跳过。
function svgEmbedsBitmap(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(1024 * 1024);
    let tail = '';
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) return false;
      const text = tail + chunk.toString('utf8', 0, bytes);
      if (/<image/i.test(text)) return true;
      tail = text.slice(-5);
    }
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function execute(ctx, { run: runAgent, stats: sessionStats = () => null, describe, schema, validate, capabilities }) {
  const { agentName, agent, model, mode, kind, id, dir, cwd, level, effort, args, prompt, opts, expectReport } = ctx;
  const { isolation } = capabilities;
  const snapshotRequired = kind === 'exec' && isolation !== 'os';
  const audited = ctx.readonly === 'audited';
  const started = Date.now();
  // 图像输出目录常被 .gitignore 忽略，改动追踪看不到：项目内、本身被忽略的 scope 并入快照（续接共用此入口）。
  // 工作目录本身和没被忽略的目录不并入，否则 node_modules 这类目录会被整个拍进快照。
  const imageScopes = ctx.module === 'image' ? opts.scope.filter((file) => {
    const rel = relativePath(cwd, file);
    if (rel === '.' || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return false;
    // 退出码 0 表示至少一个写法被忽略；带斜杠的写法让只写了 "out/" 的规则也能对上还不存在的目录。
    return spawnSync('git', ['check-ignore', '--', rel, `${rel}/`], { cwd, windowsHide: true }).status === 0;
  }) : [];
  const track = [...new Map([...opts.track, ...imageScopes].map((file) => {
    const rel = relativePath(cwd, file);
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) die(M.badArg(`--track ${file}`));
    return [pathKey(rel), rel];
  })).values()];
  const { sandbox, modelShown, modelName } = describe(ctx);
  const run = startRun({ ...ctx, isolation }, { started, track, sandbox, modelShown, modelName });
  const { meta, writeMeta } = run;
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  process.stderr.write(`foreman: ${ctx.module === 'image' ? D.startedImage(mode === 'resume' ? 'resume' : 'image', modelLabel(meta), ctx.cell, '①②③④'[ctx.route - 1], dir) : D.started(mode, modelLabel(meta), level, dir)}\n`);
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
      if (audited) snapshotError = M.auditedSnapshotFailed(e.message);
      else if (snapshotRequired) snapshotError = M.snapshotFailedNoStart(e.message);
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
    if (!report && (kind === 'review' || !looksLikeFinalQuestion(last))) warnings.push(M.badReport);
  }
  if (!report && last.length > 8000) notes.push(M.lastMessageTruncated(lastFile));
  notes.push(...(r.notes || []));

  const claimed = report?.files_changed || (kind !== 'exec' ? parseReport(last, {}, validateSchema).report?.files_changed : null);
  // 报告里写成目录的（以 / 结尾，或者在磁盘上是目录）按前缀算：目录下被追踪的文件都算它自称改过的。工作目录本身和工作目录外的不算。
  const claims = (Array.isArray(claimed) ? claimed : []).filter((f) => typeof f?.path === 'string').map((f) => {
    const rel = relativePath(cwd, f.path);
    const inside = rel !== '.' && rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
    let dir = /[\\/]$/.test(f.path);
    if (!dir && inside) try { dir = fs.statSync(path.resolve(cwd, rel)).isDirectory(); } catch { /* 不存在的按文件算 */ }
    return { rel, key: pathKey(rel), dir: dir && inside, root: rel === '.' };
  });
  const reported = claims.map((c) => c.rel);
  const underClaimedDir = (key) => claims.some((c) => c.dir && key.startsWith(`${c.key}/`));
  const agentPaths = new Set([...r.fileChanges].map((f) => pathKey(relativePath(cwd, f))));
  let changes = { available: false, agent_total: 0, reported_total: 0, unknown_total: 0 };
  if (tracker) {
    try { changes = { available: true, ...tracker.diff(before, tracker.snap('after'), path.join(dir, 'diff.patch')) }; }
    catch (e) { warnings.push(M.trackingFailed(e.message)); }
    finally { tracker.cleanup(); }
  }
  const tracked = [...(changes.files || []), ...(changes.large_files_changed || [])];
  // 归属分三种：agent 有工具事件作证据；reported 只有协作方在报告里自称改过（比如用脚本写的文件）；unknown 都没有，可能是别人改的。
  const reportedPaths = new Set(claims.map((c) => c.key));
  for (const file of tracked) {
    const key = pathKey(relativePath(cwd, file.path));
    file.by = agentPaths.has(key) ? 'agent' : reportedPaths.has(key) || underClaimedDir(key) ? 'reported' : 'unknown';
  }
  changes.agent_total = tracked.filter((f) => f.by === 'agent').length;
  changes.reported_total = tracked.filter((f) => f.by === 'reported').length;
  changes.unknown_total = tracked.length - changes.agent_total - changes.reported_total;
  const ownerOf = groupScopeOwner(meta);
  const groupOwned = tracked.filter((f) => f.by === 'unknown').map((f) => ({ f, owner: ownerOf(relativePath(cwd, f.path)) })).filter((x) => x.owner);
  for (const { f, owner } of groupOwned) f.group_run = owner;
  changes.group_total = groupOwned.length;
  if (groupOwned.length) notes.push(M.groupScopeChanges(groupOwned.length, M.list([...new Set(groupOwned.map((x) => x.owner))])));
  if (changes.unknown_total > groupOwned.length) notes.push(M.unattributedChanges(changes.unknown_total - groupOwned.length));
  // 自称改过、却没追踪到的：文件看它本身，目录看前缀下有没有被追踪的文件；工作目录本身不算一条自称的改动
  const trackedKeys = tracked.map((f) => pathKey(relativePath(cwd, f.path)));
  const untracked = [...new Map(claims.filter((c) => !c.root && !trackedKeys.includes(c.key) && !(c.dir && trackedKeys.some((k) => k.startsWith(`${c.key}/`))))
    .map((c) => [c.key, c.rel])).values()];
  if (untracked.length) notes.push(M.reportedNotTracked(untracked));

  if (kind === 'exec' && ctx.module !== 'image' && r.images.length) warnings.push(M.imageOutsideModule);
  if (ctx.module === 'image' && ctx.cell === 'draw') {
    const mark = '①②③④'[ctx.route - 1];
    if (ctx.route === 4 && r.images.length) warnings.push(M.vectorRouteImages(mark));
    if ([3, 4].includes(ctx.route)) {
      const untrackedScope = opts.scope.some((scope) => { const rel = relativePath(cwd, scope); return rel === '..' || rel.startsWith('../') || path.isAbsolute(rel); });
      if (!changes.available || untrackedScope) notes.push(M.vectorCheckPartial(mark));
      const own = tracked.filter((f) => ['A', 'M'].includes(f.status) && (f.by === 'agent' || f.by === 'reported'
        || f.by === 'unknown' && !f.group_run && opts.scope.some((scope) => {
          const file = absolute(cwd, f.path), root = absolute(cwd, scope);
          return file === root || file.startsWith(`${root}/`);
        }))).map((f) => f.path);
      const files = new Map([...own, ...r.fileChanges, ...reported].filter((file) => /\.svg$/i.test(file)).map((file) => [absolute(cwd, file), file]));
      const embeds = [...files.values()].filter((file) => svgEmbedsBitmap(path.resolve(cwd, file))).map((file) => relativePath(cwd, file));
      if (embeds.length) warnings.push(M.vectorEmbedsBitmap(mark, M.list(embeds)));
    }
  }

  // 重连之类的 error 事件不一定致命，成败以退出码为准，errors 照常汇报。
  const ok = r.status ? r.status === 'done' : r.code === 0 && !r.timedOut && !r.stalled && !r.needsInput;
  if (!ok && !r.errors.length) {
    // 参数错误等情况 codex 不产生事件，只在 stderr 留信息，把末尾几行带出来。
    const tail = String(r.stderrTail || '').trim().split('\n').slice(-5).join('\n');
    if (tail) r.errors.push(M.exitCode(r.code, tail));
  }
  const quotaExhausted = !ok && (r.quotaExhausted || r.errors.some((e) => /usage limit|quota/i.test(e)));
  meta.status = r.status || (ok ? 'done' : r.cancelled ? 'cancelled' : r.needsInput ? 'needs_input' : quotaExhausted ? 'quota_exhausted' : r.stalled ? 'stalled' : r.timedOut ? 'timeout' : 'failed');
  if (r.cancelled) r.errors = [M.runCancelled(modelOf(meta), cancelSource(dir))];
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
    // 拍了快照时以实际改动的归属为准，自报但没改动的不算；完成的写文件事件在快照外（比如被忽略的文件）也算。没有快照时只能看事件和自报。
    ...(kind !== 'exec' ? { readonly_violation: [...new Map([
      ...(changes.available ? tracked.filter((f) => f.by !== 'unknown').map(({ path, by }) => [pathKey(relativePath(cwd, path)), { path: relativePath(cwd, path), by }])
        : claims.filter((c) => !c.root).map((c) => [c.key, { path: c.rel, by: 'reported' }])),
      ...[...r.fileChanges].map((path) => [pathKey(relativePath(cwd, path)), { path: relativePath(cwd, path), by: 'agent' }]),
    ]).values()] } : {}),
    last_message: report ? undefined : last.slice(0, 8000),
    changes: changes.available
      ? { ...changes, files: changes.files.slice(0, 300), files_total: changes.files.length, note: M.trackNote }
      : changes,
    generated_images: r.images.length ? r.images : undefined, // 只列这一轮生成的
    image_calls: r.imageCalls?.length ? r.imageCalls : undefined, // 每次出图实际传的参数，读自 Codex 会话记录
    viewed_images: r.viewedImages?.length ? r.viewedImages : undefined,
    run_dir: dir,
  };
  return finishRun(run, result, ok ? 0 : 1, { messages: r.messages, questions: r.questions, last });
}

export { startRun, finishRun, finishDiscussion, eventWriter, imageScanner, runLimits, watchCancellation, parseReport, reportWithRepair, execute, collectQuestions, spawnCli };

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
