import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { sandbox, taskArgs, output, failed, json, poll, write, baseConfig, apiAgent, opencodeAgent, seedRun, MESSAGES } from './helpers.mjs';
import { sessionStats, usage, discussion } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套

test('取消的来源照实写：cancel 命令、实时查看里按 x、旧版的终止标记', async (t) => {
  const h = sandbox(t);
  for (const [by, marker] of [['command', null], ['watch', JSON.stringify({ at: new Date().toISOString(), by: 'watch' })], ['unknown', new Date().toISOString()]]) {
    const s = h.scenario({ hold: true }, `hold-${by}`);
    const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env });
    const meta = await h.running();
    await poll(() => s.calls().length, '假 codex 启动');
    if (marker) fs.writeFileSync(path.join(h.runs, meta.id, 'cancel'), marker);
    else assert.deepEqual(output(await h.bridge(['cancel', '--run', meta.id])), { run_id: meta.id, ok: true, status: 'cancelled' });
    const r = output(await running.done, 1);
    assert.equal(r.status, 'cancelled');
    assert.deepEqual(r.errors, [M.runCancelled('fake-codex', by)]);
    if (!marker) assert.equal(json(path.join(r.run_dir, 'cancel')).by, 'command');
  }
  assert.equal(M.runCancelled('m', 'command'), 'm 已被 cancel 命令终止');
  assert.equal(M.runCancelled('m', 'watch'), 'm 已被用户在实时查看里终止');
  assert.equal(M.runCancelled('m', 'unknown'), 'm 已终止');
  assert.equal(MESSAGES.en.runCancelled('m', 'command'), 'm was stopped by the cancel command');
});

test('取消时记下已经产生的用量：有完成的请求就照记并说明没算进行中的那次，一次都没完成时为 null 并说明', async (t) => {
  const h = sandbox(t);
  for (const stats of [sessionStats, null]) {
    const s = h.scenario({ hold: true, session_id: stats ? 'with-stats' : 'no-stats', ...(stats ? { stats } : {}) }, stats ? 'with-stats' : 'no-stats');
    const running = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env });
    const meta = await h.running();
    await poll(() => s.calls().length, '假 codex 启动');
    output(await h.bridge(['cancel', '--run', meta.id]));
    const r = output(await running.done, 1);
    if (stats) {
      assert.deepEqual(r.usage, usage);
      assert.ok(r.notes.includes(M.cancelledUsagePartial));
    } else {
      assert.equal(r.usage, null); assert.equal(r.usage_scope, null);
      assert.ok(r.notes.includes(M.cancelledUsageMissing));
    }
  }
  const api = await apiServer(t, [{ queued: true, gate: 'cancel' }]);
  const c = baseConfig(); c.agents.api = apiAgent(api.url);
  c.modules.discuss.complex = [{ agent: 'api' }]; h.config(c);
  const running = h.startBridge(['discuss', '--cwd', h.cwd, '--level', 'complex', '--brief', '-']);
  const meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'api.queued'), '请求排队');
  output(await h.bridge(['cancel', '--run', meta.id]));
  const r = output(await running.done, 1);
  assert.equal(r.usage, null);
  assert.ok(r.notes.includes(M.cancelledUsageMissing));
});

test('调度进程没在时限内停下时，cancel 强行结束它并补写结果，带上会话记录里的用量', async (t) => {
  const h = sandbox(t);
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  const started = new Date(Date.now() - 60000);
  seedRun(h, 'forced-run', { status: 'running', pid: sleeper.pid, ended_at: undefined, session_id: 'forced-session', started_at: started.toISOString() });
  const day = new Date(), pad = (n) => String(n).padStart(2, '0');
  write(path.join(h.home, '.codex', 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()), 'rollout-forced-session.jsonl'),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', ...sessionStats } }) + '\n');
  const out = output(await h.bridge(['cancel', '--run', 'forced-run'], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '300' } }));
  assert.deepEqual(out, { run_id: 'forced-run', ok: true, status: 'cancelled', forced: true });
  await poll(() => sleeper.exitCode !== null || sleeper.signalCode !== null, '被强行结束的进程退出');
  const r = h.result('forced-run');
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.usage, usage); assert.equal(r.usage_scope, 'this_run');
  assert.deepEqual(r.errors, [M.runCancelled('fake-codex', 'command')]);
  assert.deepEqual(r.notes, [M.cancelForced, M.cancelledUsagePartial]);
  assert.equal(json(path.join(h.runs, 'forced-run', 'meta.json')).status, 'cancelled');
});

const planConfig = (h) => {
  const c = baseConfig(); c.agents.oc = opencodeAgent();
  c.modules.discuss.complex = [{ agent: 'codex', effort: 'max', required: true }, { agent: 'oc' }];
  h.config(c);
};
const makePlan = async (h, group) => output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'discuss', '--cell', 'complex', '--group', group, '--seat', 'codex', '--seat', 'oc']));
const seat = (h, id, plan, n, agent, status, result) => seedRun(h, id, { mode: 'discuss', kind: 'discuss', module: 'discuss', cell: 'complex', plan: plan.plan_id, seat: n,
  group: plan.group, agent, agent_type: agent === 'oc' ? 'opencode cli' : 'codex cli', model: agent === 'oc' ? 'fake/model' : 'fake-codex', status }, result);

test('组视图和 status --group 写出计划完不完整、缺了哪个必选', async (t) => {
  const h = sandbox(t); planConfig(h);
  const incomplete = await makePlan(h, 'plan-incomplete');
  seat(h, '20000101-a', incomplete, 1, 'codex', 'cancelled', { status: 'cancelled', errors: [M.runCancelled('fake-codex', 'command')] });
  seat(h, '20000101-b', incomplete, 2, 'oc', 'done', { status: 'done', report: discussion });
  const line = D.watchPlanState(incomplete.plan_id, 'incomplete', D.watchPlanMissing(D.watchPlanSeat('codex', 1, D.statusName('cancelled'))));
  const watched = await h.bridge(['watch', '--group', 'plan-incomplete']);
  assert.equal(watched.code, 0); assert.ok(watched.stdout.includes(line), watched.stdout);
  const status = await h.bridge(['status', '--group', 'plan-incomplete']);
  assert.ok(status.stdout.includes(line), status.stdout);

  const pending = await makePlan(h, 'plan-pending');
  seat(h, '20000102-a', pending, 2, 'oc', 'done', { status: 'done', report: discussion });
  const waiting = await h.bridge(['status', '--group', 'plan-pending']);
  assert.ok(waiting.stdout.includes(D.watchPlanState(pending.plan_id, 'pending', D.watchPlanNotStarted(D.watchPlanSeat('codex', 1, null)))), waiting.stdout);

  const complete = await makePlan(h, 'plan-complete');
  seat(h, '20000103-a', complete, 1, 'codex', 'done', { status: 'done', report: discussion });
  const done = await h.bridge(['status', '--group', 'plan-complete']);
  assert.ok(done.stdout.includes(D.watchPlanState(complete.plan_id, 'complete', '')), done.stdout);
});

test('项目配置关掉的格子，建计划和启动席位都说明是项目配置关的', async (t) => {
  const h = sandbox(t); planConfig(h);
  const p = await makePlan(h, 'closed-later');
  h.write('.claude/foreman.json', { modules: { discuss: { complex: 'claude code' } } });
  failed(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'discuss', '--cell', 'complex', '--group', 'closed-now', '--seat', 'codex']), M.planCellClosedByProject('modules.discuss.complex'));
  failed(await h.bridge(['discuss', '--plan', p.plan_id, '--seat', '1', '--brief', '-']), M.planCellClosedByProject('modules.discuss.complex'));
  failed(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'simple', '--group', 'user-closed', '--seat', 'codex']), M.planCellClosed('modules.run.simple'));
  assert.equal(h.records().length, 0);
});

test('强行结束时调度进程已经写好结果，不覆盖它，元数据跟结果走', async (t) => {
  const h = sandbox(t);
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  const written = { status: 'done', report: discussion, errors: [], notes: [] };
  seedRun(h, 'late-result', { status: 'running', pid: sleeper.pid, ended_at: undefined }, written);
  const out = output(await h.bridge(['cancel', '--run', 'late-result'], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '300' } }));
  assert.deepEqual(out, { run_id: 'late-result', ok: true, status: 'done', forced: true });
  assert.deepEqual(h.result('late-result'), written);
  assert.equal(json(path.join(h.runs, 'late-result', 'meta.json')).status, 'done');
});

test('强行结束时结果只写了一半，换成补写的最简结果，之后 status 照常读', async (t) => {
  const h = sandbox(t);
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  seedRun(h, 'half-result', { status: 'running', pid: sleeper.pid, ended_at: undefined, group: 'half' });
  fs.writeFileSync(path.join(h.runs, 'half-result', 'result.json'), '{"status":"do');
  const out = output(await h.bridge(['cancel', '--run', 'half-result'], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '300' } }));
  assert.deepEqual(out, { run_id: 'half-result', ok: true, status: 'cancelled', forced: true });
  const r = h.result('half-result');
  assert.equal(r.status, 'cancelled'); assert.deepEqual(r.errors, [M.runCancelled('fake-codex', 'command')]);
  assert.equal(fs.existsSync(path.join(h.runs, 'half-result', 'result.json.tmp')), false);
  assert.equal((await h.bridge(['status', '--group', 'half'])).code, 0);
});

test('计划状态里的审查：没审完或格式不合格的不算有效，Codex 原生审查和旧记录的文字算', async (t) => {
  const h = sandbox(t); const c = baseConfig(); c.agents.oc = opencodeAgent();
  c.modules.review.complex = [{ agent: 'codex', effort: 'max', required: true }, { agent: 'oc' }]; h.config(c);
  h.write('source.txt', 'evidence\n');
  const review = { verdict: 'no_issues', findings: [], coverage: { checked: ['source.txt'], not_checked: [] }, unverified: [] };
  const cases = [
    ['incomplete', { report: { ...review, verdict: 'incomplete' }, review_target: 'files' }, 'incomplete'],
    ['bad-format', { report: null, last_message: '{}', review_target: 'files', native_review: false }, 'incomplete'],
    ['native', { report: null, last_message: 'No issues found.', review_target: 'diff', native_review: true }, 'complete'],
    ['legacy', { report: null, last_message: '未发现问题' }, 'complete'],
    ['finished', { report: review, review_target: 'files' }, 'complete'],
  ];
  for (const [name, result, state] of cases) {
    const p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', `review-${name}`,
      '--seat', 'codex', '--target', 'files', '--file', 'source.txt']));
    seedRun(h, `20000104-${name}`, { mode: 'review', kind: 'review', module: 'review', cell: 'complex', plan: p.plan_id, seat: 1, group: p.group },
      { status: 'done', ...result });
    assert.equal(output(await h.bridge(['status', '--plan', p.plan_id])).state, state, name);
  }
});
