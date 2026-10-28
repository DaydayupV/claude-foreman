// 状态列表、终止任务和排队检查；会话统计由入口提供只读函数。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, UNFINISHED_STATUSES, requestCancel, listRuns, findRun, readMeta, checkRunners, isRunning, runEnd, runOutcome, resumedRuns, groupRuns, groupSummary, describeActivity, saveMeta, metaWriteWarning, queuedRuns } from './records.mjs';
import { M, die, need, pidExists, processStartedAt, killTreeIfSame, sleep, modelOf, agentTypeOf, replaceFile } from './util.mjs';
import { D, C, padWidth, visibleWidth, modelLabel, clock, took, outcomeStyle, usageLine, outsideCwdText, paintPlanWord } from './format.mjs';
import { planStatus, describePlans } from './plan.mjs';
import { costOf, loadPrices } from './prices.mjs';

function cmdStatus(o, sessionStats) {
  if (o.plan) { process.stdout.write(JSON.stringify(planStatus(o.plan), null, 2) + '\n'); return; }
  if (o.run && o.group == null) {
    let run = findRun(o.run, { tolerateUnreadable: true });
    const file = path.join(run.dir, 'result.json');
    if (!run.meta) {
      let result;
      try { result = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 没有可读结果时保留原来的元数据报错 */ }
      if (result) {
        (result.warnings ??= []).push(M.metaUnreadableUsedResult(path.join(run.dir, 'meta.json')));
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      run = findRun(o.run);
    }
    if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8') + '\n');
    else {
      if (run.meta.status === 'running' && !isRunning(run.meta)) run.meta.status = 'interrupted';
      process.stdout.write(JSON.stringify({ ...run.meta, activity: describeActivity(run.dir) }, null, 2) + '\n');
    }
    return;
  }
  const grouped = o.group != null ? groupRuns(o.group) : null;
  const runs = grouped ? grouped.map((r) => r.id) : listRuns().slice(0, Number(o.limit) || 10);
  // 每个任务一行：编号、模式和等级（原词）、状态记号和状态词、模型标签、用时（运行中写 12:03），各列按显示宽度对齐；
  // 下面一行是运行中的活动情况，或者结束后的用量。颜色只给状态记号和状态词，模型和标题加粗，次要信息用暗色。
  let unreadable = 0;
  const loaded = runs.map((id) => {
    const dir = path.join(RUNS_ROOT, id);
    return { id, dir, meta: readMeta(dir) };
  });
  checkRunners(loaded.map((run) => run.meta));
  // 执行和图像的续接不记轮次，按续接链往回数（和实时查看一致）
  const metaOf = new Map(loaded.map((run) => [run.id, run.meta]));
  // 逐行显示和汇总计数（groupTally）用同一个判定：续接过的不再显示成交回问题或失败
  const resumedIds = resumedRuns(loaded, grouped?.all ?? loaded);
  const roundOf = (m) => {
    if (m.round != null || !m.parent) return m.round;
    let n = 1;
    for (let id = m.parent; id && n < 100; n++) id = (metaOf.get(id) ?? readMeta(path.join(RUNS_ROOT, id)))?.parent;
    return n;
  };
  const records = loaded.flatMap((run) => {
    const { id: rid, dir } = run;
    // meta.json 读不出来时计入末尾提示。进程已退出、记录还是运行中的，交给 runOutcome 判断：
    // 它会先重读一次（多半是刚写完结果就退出了），还是运行中才算中断。
    if (!run.meta) { unreadable++; return []; }
    const outcome = runOutcome(run);
    const m = run.meta;
    if (m.participant === 'host') return [{ cells: [rid, 'submit', D.hostSubmitted(new Date(m.submitted_at).toTimeString().slice(0, 5), m.round), m.level, C.bold(modelLabel(m)), ''], tail: `${D.statusGroup(m.group)}  ${C.dim(`@ ${m.cwd}`)}`, detail: '' }];
    const { mark, color, word } = outcomeStyle({ ...outcome, resumed: !outcome.running && !outcome.ok && resumedIds.has(rid) });
    const r = outcome.result;
    const elapsed = runEnd(dir, m) - Date.parse(m.started_at);
    const image = m.module === 'image', mode = image && m.mode === 'run' ? 'image' : m.mode;
    const cells = [rid, mode, color(`${mark} ${word}`), image ? m.cell : m.level || '-', C.bold(modelLabel(m)),
      C.dim(outcome.running ? clock(elapsed) : took(r?.duration_s ?? elapsed / 1000))];
    const tail = `${m.group != null ? D.statusGroup(m.group) : ''}${roundOf(m) ? D.statusRound(roundOf(m)) : ''}${image ? D.statusRoute('①②③④'[m.route - 1]) : ''}${C.bold(m.title || '')}${r?.stale === true ? ` · ${D.watchStale}` : ''}  ${C.dim(`@ ${m.cwd}`)}`;
    let detail = '';
    if (outcome.running) {
      const a = describeActivity(dir);
      const last = sessionStats(m)?.last_request;
      detail = D.dots([D.statusActivity(a.idle_min ?? '-', a.step), last && D.lastRequestNow(last, D.tokenCount)]);
    } else detail = usageLine(r, m);
    const outside = !outcome.running && outsideCwdText(r, m);
    return [{ cells, tail, detail, outside }];
  });
  const widths = records.reduce((w, { cells }) => cells.map((c, i) => Math.max(w[i] || 0, visibleWidth(c))), []);
  const rows = records.map(({ cells, tail, detail, outside }) => `${cells.map((c, i) => padWidth(c, widths[i])).join('  ')}  ${tail}${detail ? `\n    ${C.dim(`└ ${detail}`)}` : ''}${outside ? `\n    ${C.yellow(`⚠ ${outside}`)}` : ''}`);
  if (unreadable) rows.push(C.dim(D.statusUnreadable(unreadable)));
  // 额度是账号级的，取最近一次有记录的任务显示一行
  let quota = null;
  for (const rid of runs) {
    const m = readMeta(path.join(RUNS_ROOT, rid));
    quota = m && sessionStats(m)?.rate_limit;
    if (quota) break;
  }
  process.stdout.write(rows.length ? rows.join('\n') + '\n' + (quota ? `\n${D.rateLimit(quota)}\n` : '') : `${D.noRuns}\n`);
  if (grouped) process.stdout.write(`${[...describePlans(grouped).map((plan) => paintPlanWord(plan.text, plan.state)), groupSummary(grouped)].join('\n')}\n`);
  const queue = queuedRuns(o.group);
  if (queue.length) process.stdout.write(`\n${M.queueHeading}\n${queue.map((q) => M.queueRow(q.agent, q.position, q.title, q.claude_session,
    Math.max(0, (Date.now() - Date.parse(q.queued_at)) / 60000).toFixed(1))).join('\n')}\n`);
}

function sameRunner(meta) {
  // runner 登记时仍活着，复用的新进程一定更晚启动；ps 向下取整到秒，也不需要容差。
  const started = processStartedAt(meta.pid);
  return started === null ? null : started <= Date.parse(meta.started_at);
}

// 核对运行中的进程后留终止标记，等它自己收尾；30 秒后仍确认是同一个进程才强行结束、补写最简结果。
// 进程已退出或进程号被复用、没有结果的记为中断；其他未正常完成的任务只标记为已处理。
async function cmdCancel(o, sessionStats) {
  const run = findRun(need(o, 'run'));
  if (run.meta.participant === 'host') die(M.hostNoCancel(run.id));
  const print = (x) => process.stdout.write(`${JSON.stringify({ run_id: run.id, ...x }, null, 2)}\n`);
  const dismiss = (m, status, note) => {
    Object.assign(m, { status, dismissed_at: new Date().toISOString() });
    // 没写过结束时间的（调度进程被强行结束）补上最后一次活动的时间：看板按结束时间判断还在不在跑
    if (!m.ended_at) m.ended_at = new Date(runEnd(run.dir, m)).toISOString();
    const saved = saveMeta(run.dir, m, { final: true });
    print(saved ? { ok: true, status, dismissed: true, ...(note ? { note } : {}) } : { ok: false, status, error: metaWriteWarning(run.dir) });
  };
  const handleEnded = async (m, note) => {
    // 结果已落盘但 runner 还在重试元数据时，先等它收尾，免得 dismissed_at 被旧快照覆盖；磁盘上的元数据这一刻读不出也按还没写完算。
    const onDisk = UNFINISHED_STATUSES.includes(m.status) ? readMeta(run.dir, { settle: false }) : null;
    if (UNFINISHED_STATUSES.includes(m.status) && (!onDisk || onDisk.status === 'running') && pidExists(m.pid) && sameRunner(m) !== false) {
      const waitMs = Number(process.env.FOREMAN_TEST_CANCEL_WAIT_MS) || 20000;
      for (const until = Date.now() + waitMs; pidExists(m.pid) && Date.now() < until;) await sleep(Math.min(250, until - Date.now()));
      m = readMeta(run.dir) || m;
    }
    const status = m.status === 'running' ? 'interrupted' : m.status;
    if (!UNFINISHED_STATUSES.includes(status)) {
      if (!pidExists(m.pid) && readMeta(run.dir, { settle: false })?.status === 'running') saveMeta(run.dir, m);
      print({ ok: false, status, note: M.cancelAlreadyEnded });
      return;
    }
    dismiss(m, status, m.status === 'running' ? note : undefined);
  };
  // 判成进程号被复用后以重读的元数据为准（核对期间任务可能已经正常收尾）；一直读不出就不动记录，免得用旧快照把完成的任务改成中断。
  const handleReused = async (note) => {
    for (let i = 0; i < 8; i++) {
      const m = readMeta(run.dir);
      if (m) { await handleEnded(m, note); return; }
      await sleep(250);
    }
    print({ ok: false, status: 'running', error: M.metaUnreadable(path.join(run.dir, 'meta.json')) });
  };
  if (run.meta.status !== 'running' || !pidExists(run.meta.pid)) {
    await handleEnded(readMeta(run.dir) || run.meta);
    return;
  }
  if (sameRunner(run.meta) === false) { await handleReused(M.cancelPidReused(run.meta.pid)); return; }
  requestCancel(run.dir, 'command');
  const waitMs = Number(process.env.FOREMAN_TEST_CANCEL_WAIT_MS) || 30000;
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await sleep(Math.min(500, waitMs));
    const m = readMeta(run.dir);
    if (m && m.status !== 'running') { print({ ok: true, status: m.status }); return; }
    // 这一次读不出不等于已经停下：调度进程还活着就接着等，已经退出就不再等。
    if (!pidExists(run.meta.pid)) break;
  }
  // 确认它真的退出之后才动它的记录，免得和它自己的收尾交错。非 Windows 上只发 SIGTERM，等不到退出就再核对、发 SIGKILL。
  const pid = run.meta.pid;
  const exited = async () => { for (let i = 0; i < 20 && pidExists(pid); i++) await sleep(150); return !pidExists(pid); };
  let forced = false;
  if (pidExists(pid)) {
    const stopped = killTreeIfSame(pid, run.meta.started_at);
    if (stopped === 'other') { await handleReused(M.cancelPidReused(pid)); return; }
    if (stopped === null) { print({ ok: false, status: 'running', error: M.cancelUnverified(pid) }); return; }
    forced = true;
  }
  if (!(await exited()) && process.platform !== 'win32') {
    const same = sameRunner(run.meta);
    if (same === false) { await handleReused(M.cancelPidReused(pid)); return; }
    if (same === null) { print({ ok: false, status: 'running', error: M.cancelUnverified(pid) }); return; }
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退出 */ } }
  }
  if (!(await exited())) { print({ ok: false, status: 'running', error: M.cancelNotStopped(pid) }); return; }
  // 看磁盘上的元数据，不用结果兜底：被结束前自己收完了尾的，元数据已经写成结束状态，原样返回，
  // 这时结果正好读不出也不能再补写，免得把完成的任务改成已取消
  const m = readMeta(run.dir, { settle: false }) || run.meta;
  if (m.status !== 'running') { print({ ok: true, status: m.status }); return; }
  // 结果写好时元数据跟结果走；没有可读结果时，只有实际强行结束过才补最简结果。
  let written = null;
  try { written = JSON.parse(fs.readFileSync(path.join(run.dir, 'result.json'), 'utf8')); } catch { /* 没有结果，或者旧版本写了一半 */ }
  if (!forced && !written?.status) { dismiss(m, 'interrupted', M.cancelRunnerGone); return; }
  Object.assign(m, { status: written?.status ?? 'cancelled', ended_at: new Date().toISOString() });
  if (!written) writeForcedResult(run.dir, m, sessionStats);
  const saved = saveMeta(run.dir, m, { final: true });
  print({ ok: true, status: m.status, ...(forced ? { forced: true } : {}), ...(!saved ? { warning: metaWriteWarning(run.dir) } : {}) });
}

// 调度进程没来得及写好结果就被强行结束了：补一份最简的结果。用量只能从协作方自己的会话记录里读（目前只有 Codex 有），读不到就是 null。
function writeForcedResult(dir, m, sessionStats) {
  const file = path.join(dir, 'result.json');
  let usage = null;
  try { usage = sessionStats(m)?.total_token_usage ?? null; } catch { /* 读不到会话记录就不记用量 */ }
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({
    run_id: m.id, mode: m.mode, kind: m.kind, status: 'cancelled', title: m.title ?? null, cwd: m.cwd,
    agent: m.agent, agent_type: m.agent_type, model: m.model, model_shown: m.model_shown, level: m.level, effort: m.effort,
    module: m.module ?? null, cell: m.cell ?? null, plan: m.plan ?? null, seat: m.seat ?? null, role: m.role ?? null,
    ...(m.module === 'image' ? { step: m.step, route: m.route } : {}),
    group: m.group ?? null, round: m.round ?? null, scope: m.scope ?? [], parent: m.parent ?? null, session_id: m.session_id ?? null,
    exit_code: null, duration_s: Math.round((Date.parse(m.ended_at) - Date.parse(m.started_at)) / 1000),
    usage, usage_scope: usage ? (m.mode === 'resume' ? 'session_total' : 'this_run') : null,
    ...costOf({ ...m, usage, usage_scope: usage ? (m.mode === 'resume' ? 'session_total' : 'this_run') : null }, loadPrices()),
    errors: [M.runCancelled(modelOf(m), 'command')], notes: [M.cancelForced, usage ? M.cancelledUsagePartial : M.cancelledUsageMissing],
    warnings: [], report: null, last_message: '', changes: { available: false }, questions: [], needs_decision: false, run_dir: dir,
  }, null, 2));
  replaceFile(`${file}.tmp`, file);
}

// API 协作方这次请求排队了多少秒：最近一次 api.request 之后收到过 api.queued、还没收到思考或回答。不在排队返回 null。
function queuedSeconds(dir) {
  const file = path.join(dir, 'events.jsonl');
  let text;
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 512 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  let request = null;
  let queued = false;
  for (const line of text.split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'api.request') { request = ev; queued = false; }
    else if (ev.type === 'api.queued') queued = true;
    else if (ev.type === 'api.reasoning' || ev.type === 'api.content' || ev.type === 'api.error') queued = false;
  }
  return request && queued ? Math.round((Date.now() - Date.parse(request.ts)) / 1000) : null;
}

// 在后台盯着一组或一个任务：有 API 协作方排队超过 --after 分钟就退出，列出是哪几个；全部结束也退出。
// Claude 收到它退出的通知后，按输出决定要不要问用户终止排队的那一方。
async function cmdAwaitBusy(o, config, load) {
  if (o.group == null && !o.run) die(M.missingOpt('group'));
  if (o.after != null && !(Number(o.after) > 0)) die(M.badAfter(config.dispatch.busy_ask_min));
  const thresholds = new Map();
  const afterOf = (run) => {
    if (o.after != null) return Number(o.after);
    const cwd = run.meta.cwd;
    if (!thresholds.has(cwd)) thresholds.set(cwd, (load ? load(cwd) : config).dispatch.busy_ask_min);
    return thresholds.get(cwd);
  };
  const print = (x) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
  const pick = () => (o.group != null ? groupRuns(o.group, Date.now() - 86400000) : [findRun(o.run)]);
  // 刚派出的任务可能还没登记，最多等 30 秒
  for (let waited = 0; o.group != null && !pick().length; waited += 1000) {
    if (waited >= 30000) { print({ busy: [], running: [], done: true }); return; }
    await sleep(1000);
  }
  for (;;) {
    const runs = pick();
    if (o.after == null && runs.every((run) => !(afterOf(run) > 0))) {
      print({ busy: [], running: [], done: true, disabled: true }); return;
    }
    checkRunners(runs.map((run) => run.meta));
    const running = runs.filter((run) => isRunning(run.meta) && !['opencode cli', 'pi cli', 'agy cli'].includes(agentTypeOf(run.meta)));
    const busy = running.map((run) => ({ run, s: queuedSeconds(run.dir), after: afterOf(run) }))
      .filter((x) => x.after > 0 && x.s != null && x.s >= x.after * 60);
    if (busy.length || !running.length) {
      print({
        busy: busy.map(({ run, s }) => ({ run_id: run.id, agent: run.meta.agent, model: modelOf(run.meta), queued_min: Number((s / 60).toFixed(1)) })),
        running: running.map((run) => run.id),
        done: !running.length,
      });
      return;
    }
    await sleep(3000);
  }
}

export { cmdStatus, cmdCancel, cmdAwaitBusy };
