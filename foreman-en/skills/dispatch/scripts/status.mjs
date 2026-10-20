// 状态列表、终止任务和排队检查；会话统计由入口提供只读函数。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, UNFINISHED_STATUSES, requestCancel, listRuns, findRun, readMeta, isRunning, runEnd, runOutcome, groupRuns, groupSummary, describeActivity, saveMeta, metaWriteWarning } from './records.mjs';
import { M, die, need, pidAlive, killTree, sleep, modelOf, agentTypeOf, replaceFile } from './util.mjs';
import { D, C, padWidth, visibleWidth, modelLabel, clock, took, outcomeStyle, usageLine, paintPlanWord } from './format.mjs';
import { planStatus, describePlans } from './plan.mjs';

function cmdStatus(o, sessionStats) {
  if (o.plan) { process.stdout.write(JSON.stringify(planStatus(o.plan), null, 2) + '\n'); return; }
  if (o.run && o.group == null) {
    const run = findRun(o.run);
    const file = path.join(run.dir, 'result.json');
    if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8') + '\n');
    else {
      if (run.meta.status === 'running' && !pidAlive(run.meta.pid)) run.meta.status = 'interrupted';
      process.stdout.write(JSON.stringify({ ...run.meta, activity: describeActivity(run.dir) }, null, 2) + '\n');
    }
    return;
  }
  const grouped = o.group != null ? groupRuns(o.group) : null;
  const runs = grouped ? grouped.map((r) => r.id) : listRuns().slice(0, Number(o.limit) || 10);
  // 每个任务一行：编号、模式和等级（原词）、状态记号和状态词、模型标签、用时（运行中写 12:03），各列按显示宽度对齐；
  // 下面一行是运行中的活动情况，或者结束后的用量。颜色只给状态记号和状态词，模型和标题加粗，次要信息用暗色。
  const records = runs.flatMap((rid) => {
    const dir = path.join(RUNS_ROOT, rid);
    // meta.json 正被改写时会暂时读不出来，这一次先不列它。进程已退出、记录还是运行中的，交给 runOutcome 判断：
    // 它会先重读一次（多半是刚写完结果就退出了），还是运行中才算中断。
    const run = { dir, meta: readMeta(dir) };
    if (!run.meta) return [];
    const outcome = runOutcome(run);
    const m = run.meta;
    const { mark, color, word } = outcomeStyle(outcome);
    const r = outcome.result;
    const elapsed = runEnd(dir, m) - Date.parse(m.started_at);
    const image = m.module === 'image', mode = image && m.mode === 'run' ? 'image' : m.mode;
    const cells = [rid, mode, color(`${mark} ${word}`), image ? m.cell : m.level || '-', C.bold(modelLabel(m)),
      C.dim(outcome.running ? clock(elapsed) : took(r?.duration_s ?? elapsed / 1000))];
    const tail = `${m.group != null ? D.statusGroup(m.group) : ''}${m.round ? D.statusRound(m.round) : ''}${image ? D.statusRoute('①②③④'[m.route - 1]) : ''}${C.bold(m.title || '')}${r?.stale === true ? ` · ${D.watchStale}` : ''}  ${C.dim(`@ ${m.cwd}`)}`;
    let detail = '';
    if (outcome.running) {
      const a = describeActivity(dir);
      const last = sessionStats(m)?.last_request;
      detail = D.dots([D.statusActivity(a.idle_min ?? '-', a.step), last && D.lastRequestNow(last, D.tokenCount)]);
    } else detail = usageLine(r, m);
    return [{ cells, tail, detail }];
  });
  const widths = records.reduce((w, { cells }) => cells.map((c, i) => Math.max(w[i] || 0, visibleWidth(c))), []);
  const rows = records.map(({ cells, tail, detail }) => `${cells.map((c, i) => padWidth(c, widths[i])).join('  ')}  ${tail}${detail ? `\n    ${C.dim(`└ ${detail}`)}` : ''}`);
  // 额度是账号级的，取最近一次有记录的任务显示一行
  let quota = null;
  for (const rid of runs) {
    const m = readMeta(path.join(RUNS_ROOT, rid));
    quota = m && sessionStats(m)?.rate_limit;
    if (quota) break;
  }
  process.stdout.write(rows.length ? rows.join('\n') + '\n' + (quota ? `\n${D.rateLimit(quota)}\n` : '') : `${D.noRuns}\n`);
  if (grouped) process.stdout.write(`${[...describePlans(grouped).map((plan) => paintPlanWord(plan.text, plan.state)), groupSummary(grouped)].join('\n')}\n`);
}

// 终止一个正在运行的任务：先留终止标记，让它自己停下、写好结果（收尾要拍快照、读用量，大仓库会慢一些）；
// 30 秒内没停（比如旧版本的脚本或者卡住了）就直接结束进程，补写一份最简结果。
// 已经结束、没正常完成的任务，标记为已处理。
async function cmdCancel(o, sessionStats) {
  const run = findRun(need(o, 'run'));
  const print = (x) => process.stdout.write(`${JSON.stringify({ run_id: run.id, ...x }, null, 2)}\n`);
  if (!isRunning(run.meta)) {
    // 以再读一次的为准：上一次读的时候 result.json 可能正被占着，已经完成的任务还显示成运行中
    const m = readMeta(run.dir) || run.meta;
    const status = m.status === 'running' ? 'interrupted' : m.status;
    if (!UNFINISHED_STATUSES.includes(status)) { print({ ok: false, status }); return; }
    m.dismissed_at = new Date().toISOString();
    const saved = saveMeta(run.dir, m, { final: true });
    print(saved ? { ok: true, status, dismissed: true } : { ok: false, status, error: metaWriteWarning(run.dir) });
    return;
  }
  requestCancel(run.dir, 'command');
  const waitMs = Number(process.env.FOREMAN_TEST_CANCEL_WAIT_MS) || 30000;
  for (const until = Date.now() + waitMs; Date.now() < until;) {
    await sleep(Math.min(500, waitMs));
    const m = readMeta(run.dir);
    if (m && m.status !== 'running') { print({ ok: true, status: m.status }); return; }
    // 这一次读不出不等于已经停下：调度进程还活着就接着等，已经退出就不再等，按下面强行结束的收尾补写记录
    if (!pidAlive(run.meta.pid)) break;
  }
  // 确认它真的退出之后才动它的记录，免得和它自己的收尾交错。非 Windows 上 killTree 只发 SIGTERM，等不到退出就再发 SIGKILL。
  const pid = run.meta.pid;
  const exited = async () => { for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(150); return !pidAlive(pid); };
  if (pidAlive(pid)) killTree(pid); // 已经退出的进程号可能被别的进程复用，不能再结束它
  if (!(await exited()) && process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退出 */ } }
  }
  if (!(await exited())) { print({ ok: false, status: 'running', error: M.cancelNotStopped(pid) }); return; }
  // 看磁盘上的元数据，不用结果兜底：被结束前自己收完了尾的，元数据已经写成结束状态，原样返回，
  // 这时结果正好读不出也不能再补写，免得把完成的任务改成已取消
  const m = readMeta(run.dir, { settle: false }) || run.meta;
  if (m.status !== 'running') { print({ ok: true, status: m.status }); return; }
  // 结果已经写好、只差元数据时，元数据跟结果走；没有结果或者结果读不出来，补一份最简结果。
  let written = null;
  try { written = JSON.parse(fs.readFileSync(path.join(run.dir, 'result.json'), 'utf8')); } catch { /* 没有结果，或者旧版本写了一半 */ }
  Object.assign(m, { status: written?.status ?? 'cancelled', ended_at: new Date().toISOString() });
  if (!written) writeForcedResult(run.dir, m, sessionStats);
  const saved = saveMeta(run.dir, m, { final: true });
  print({ ok: true, status: m.status, forced: true, ...(!saved ? { warning: metaWriteWarning(run.dir) } : {}) });
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
async function cmdAwaitBusy(o, config) {
  if (o.group == null && !o.run) die(M.missingOpt('group'));
  if (o.after != null && !(Number(o.after) > 0)) die(M.badAfter(config.dispatch.busy_ask_min));
  const after = Number(o.after ?? config.dispatch.busy_ask_min);
  const print = (x) => process.stdout.write(`${JSON.stringify(x, null, 2)}\n`);
  if (!(after > 0)) { print({ busy: [], running: [], done: true, disabled: true }); return; }
  const pick = () => (o.group != null ? groupRuns(o.group, Date.now() - 86400000) : [findRun(o.run)]);
  // 刚派出的任务可能还没登记，最多等 30 秒
  for (let waited = 0; o.group != null && !pick().length; waited += 1000) {
    if (waited >= 30000) { print({ busy: [], running: [], done: true }); return; }
    await sleep(1000);
  }
  for (;;) {
    const running = pick().filter((run) => isRunning(run.meta) && !['opencode cli', 'pi cli'].includes(agentTypeOf(run.meta)));
    const busy = running.map((run) => ({ run, s: queuedSeconds(run.dir) })).filter((x) => x.s != null && x.s >= after * 60);
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
