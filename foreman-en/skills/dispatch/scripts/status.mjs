// 状态列表、终止任务和排队检查；会话统计由入口提供只读函数。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, CANCEL_FILE, UNFINISHED_STATUSES, listRuns, findRun, readMeta, isRunning, runEnd, runOutcome, groupRuns, groupSummary, describeActivity } from './records.mjs';
import { M, die, need, pidAlive, killTree, sleep, modelOf, whoOf, agentTypeOf } from './util.mjs';
import { planStatus } from './plan.mjs';

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
  const rows = runs.map((rid) => {
    const dir = path.join(RUNS_ROOT, rid);
    const m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (m.status === 'running' && !pidAlive(m.pid)) m.status = 'interrupted';
    const mins = ((runEnd(dir, m) - Date.parse(m.started_at)) / 60000).toFixed(1);
    const { result: r, blocked } = runOutcome({ dir, meta: m });
    const label = blocked ? `? ${M.statusName(m.status === 'needs_input' ? 'needs_input' : 'blocked')}` : m.status;
    const status = blocked && process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[33m${label}\x1b[0m` : label;
    let row = `${rid}  ${m.mode.padEnd(6)}  ${status.padEnd(11)}  ${(m.level || '-').padEnd(7)}  ${whoOf(m)}  ${mins.padStart(6)}min  ${m.group != null ? M.statusGroup(m.group) : ''}${m.round ? M.statusRound(m.round) : ''}${m.title || ''}  @ ${m.cwd}`;
    if (m.status === 'running') {
      const a = describeActivity(dir);
      const last = sessionStats(m)?.last_request;
      row += `\n    └ ${M.statusActivity(a.idle_min ?? '-', a.step)}${last ? M.lastRequestNow(last, M.tokenCount) : ''}`;
    } else {
      if (r?.usage) row += `\n    └ ${M.tokenSummary(r.usage, r.last_request ?? r.context, M.tokenCount, (r.usage_scope ?? (m?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total')}`;
    }
    return row;
  });
  // 额度是账号级的，取最近一次有记录的任务显示一行
  let quota = null;
  for (const rid of runs) {
    const m = readMeta(path.join(RUNS_ROOT, rid));
    quota = m && sessionStats(m)?.rate_limit;
    if (quota) break;
  }
  process.stdout.write(rows.length ? rows.join('\n') + '\n' + (quota ? `\n${M.rateLimit(quota)}\n` : '') : `${M.noRuns}\n`);
  if (grouped) process.stdout.write(`${groupSummary(grouped)}\n`);
}

// 终止一个正在运行的任务：先留终止标记，让它自己停下、写好结果；10 秒内没停（比如旧版本的脚本）就直接结束进程。
// 已经结束、没正常完成的任务，标记为已处理。
async function cmdCancel(o) {
  const run = findRun(need(o, 'run'));
  const print = (x) => process.stdout.write(`${JSON.stringify({ run_id: run.id, ...x }, null, 2)}\n`);
  if (!isRunning(run.meta)) {
    const status = run.meta.status === 'running' ? 'interrupted' : run.meta.status;
    if (!UNFINISHED_STATUSES.includes(status)) { print({ ok: false, status }); return; }
    const m = readMeta(run.dir) || run.meta;
    m.dismissed_at = new Date().toISOString();
    fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify(m, null, 2));
    print({ ok: true, status, dismissed: true });
    return;
  }
  fs.writeFileSync(path.join(run.dir, CANCEL_FILE), new Date().toISOString());
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const m = readMeta(run.dir);
    if (!isRunning(m)) { print({ ok: true, status: m?.status }); return; }
  }
  killTree(run.meta.pid);
  const m = readMeta(run.dir) || run.meta;
  Object.assign(m, { status: 'cancelled', ended_at: new Date().toISOString() });
  fs.writeFileSync(path.join(run.dir, 'meta.json'), JSON.stringify(m, null, 2));
  print({ ok: true, status: 'cancelled', forced: true });
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
