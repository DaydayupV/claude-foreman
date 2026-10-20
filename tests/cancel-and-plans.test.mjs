import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { processStartedAt } from '../foreman/skills/dispatch/scripts/util.mjs';
import { sandbox, taskArgs, output, failed, json, poll, write, read, BRIDGE, baseConfig, apiAgent, opencodeAgent, seedRun, MESSAGES } from './helpers.mjs';
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
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  const started = new Date();
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

test('结果已完成时优先于活进程号，cancel 不结束它，进程退出后才回写终态', async (t) => {
  const h = sandbox(t);
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  const written = { status: 'done', session_id: 'recovered-session', duration_s: 1, report: discussion, errors: [], notes: [] };
  const dir = seedRun(h, 'late-result', { status: 'running', pid: sleeper.pid, session_id: null, ended_at: undefined }, written);
  const file = path.join(dir, 'meta.json'), before = read(file);
  const list = await h.bridge(['status']);
  assert.equal(list.code, 0); assert.match(list.stdout, /late-result\s+run\s+✔ done/);
  assert.equal((await h.bridge(['watch', '--run', 'late-result'])).code, 0);
  assert.equal(read(file), before);
  const out = output(await h.bridge(['cancel', '--run', 'late-result'], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '300' } }));
  assert.deepEqual(out, { run_id: 'late-result', ok: false, status: 'done', note: M.cancelAlreadyEnded });
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
  assert.deepEqual(h.result('late-result'), written);
  assert.equal(read(file), before);
  assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
  process.kill(sleeper.pid);
  await poll(() => sleeper.exitCode !== null || sleeper.signalCode !== null, '无关进程退出');
  assert.deepEqual(output(await h.bridge(['cancel', '--run', 'late-result'])), out);
  const settled = json(file);
  assert.equal(settled.status, 'done'); assert.equal(settled.session_id, 'recovered-session');
  assert.equal(settled.ended_at, new Date(Date.parse(settled.started_at) + 1000).toISOString());
  assert.deepEqual(h.result('late-result'), written);
});

test('活进程比 started_at 晚 500 毫秒启动时，cancel 判成复用，不留终止标记也不结束进程', async (t) => {
  const h = sandbox(t), sleeper = h.start(h.write('unrelated.mjs', 'setInterval(() => {}, 1000);'));
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  const started = processStartedAt(sleeper.child.pid); assert.notEqual(started, null);
  const id = 'reused-pid', dir = seedRun(h, id, { status: 'running', pid: sleeper.child.pid, started_at: new Date(started - 500).toISOString(), ended_at: undefined });
  const began = Date.now();
  const r = output(await h.bridge(['cancel', '--run', id], { timeout: 10000 }));
  assert.deepEqual(r, { run_id: id, ok: true, status: 'interrupted', dismissed: true, note: M.cancelPidReused(sleeper.child.pid) });
  assert.ok(Date.now() - began < 10000, '不应等满 30 秒');
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
  assert.equal(fs.existsSync(path.join(dir, 'cancel')), false); assert.equal(fs.existsSync(path.join(dir, 'result.json')), false);
  const m = json(path.join(dir, 'meta.json'));
  assert.equal(m.status, 'interrupted'); assert.ok(Number.isFinite(Date.parse(m.dismissed_at)));
});

test('强行结束前再次核对身份：进程号复用只标记中断，查不到启动时间就拒绝结束且不改记录', async (t) => {
  for (const reused of [true, false]) await t.test(reused ? '等待后复用' : '始终查不到', async (t) => {
    const h = sandbox(t), sleeper = h.start(h.write('still-alive.mjs', 'setInterval(() => {}, 1000);'));
    await new Promise((resolve) => sleeper.child.once('spawn', resolve));
    const started_at = new Date().toISOString(), id = 'verify-again';
    const dir = seedRun(h, id, { status: 'running', pid: sleeper.child.pid, started_at, ended_at: undefined });
    const file = path.join(dir, 'meta.json'), before = read(file), checked = path.join(h.home, 'kill-checked');
    const preload = h.write('process-identity.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
let queries = 0;
// 启动时间查询一次可以查几个进程号，每个一行"进程号 时间"
const startTimes = (file, args, time) => (String(file).toLowerCase().endsWith('powershell.exe')
  ? /-Id ([0-9,]+)/.exec(args[args.indexOf('-Command') + 1])[1] : args[args.indexOf('-p') + 1]).split(',').map((pid) => pid + ' ' + time).join(String.fromCharCode(10));
childProcess.spawnSync = (file, args, options) => {
  const powershell = String(file).toLowerCase().endsWith('powershell.exe');
  if (powershell || file === 'ps') {
    const killing = powershell ? args[args.indexOf('-Command') + 1].includes('taskkill.exe') : ++queries > 1;
    if (killing) {
      fs.writeFileSync(${JSON.stringify(checked)}, 'checked');
      if (${reused}) {
        const meta = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
        fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ ...meta, session_id: 'fresh-session' }));
      }
      // 查不到时没有输出：ps 非零退出时查到的行照样算数，所以"始终查不到"不能带时间
      if (!${reused}) return { status: 1, stdout: '' };
      return { status: 0, stdout: powershell ? 'other' : startTimes(file, args, ${JSON.stringify(new Date(Date.parse(started_at) + 60000).toISOString())}) };
    }
    return ${reused} ? { status: 0, stdout: startTimes(file, args, ${JSON.stringify(started_at)}) } : { status: 1, stdout: '' };
  }
  if (file === 'taskkill') throw new Error('不能结束未经核实的进程');
  return spawn(file, args, options);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    const r = output(await h.bridge(['cancel', '--run', id], { env: { NODE_OPTIONS: '--import ' + pathToFileURL(preload).href, FOREMAN_TEST_CANCEL_WAIT_MS: '50' } }));
    assert.deepEqual(r, reused ? { run_id: id, ok: true, status: 'interrupted', dismissed: true, note: M.cancelPidReused(sleeper.child.pid) }
      : { run_id: id, ok: false, status: 'running', error: M.cancelUnverified(sleeper.child.pid) });
    assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
    assert.equal(read(checked), 'checked', '强行结束应走 killTreeIfSame');
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), true); assert.equal(fs.existsSync(path.join(dir, 'result.json')), false);
    if (reused) { const m = json(file); assert.equal(m.status, 'interrupted'); assert.ok(m.dismissed_at); assert.equal(m.session_id, 'fresh-session'); }
    else assert.equal(read(file), before);
  });
});

test('身份核对期间已正常收尾时，入口和强行结束前都重读终态，不覆盖 session_id', async (t) => {
  for (const atEntry of [true, false]) await t.test(atEntry ? '入口核对' : '核对并结束', async (t) => {
    const h = sandbox(t), sleeper = h.start(h.write('finishes-during-check.mjs', 'setInterval(() => {}, 1000);'));
    await new Promise((resolve) => sleeper.child.once('spawn', resolve));
    const id = 'finished-during-check', started_at = new Date().toISOString();
    const dir = seedRun(h, id, { status: 'running', pid: sleeper.child.pid, started_at, ended_at: undefined, session_id: null });
    const file = path.join(dir, 'meta.json'), resultFile = path.join(dir, 'result.json');
    const meta = { ...json(file), status: 'done', session_id: 'finished-session', ended_at: started_at };
    const result = { status: 'done', session_id: 'finished-session', duration_s: 0 };
    const script = h.write('finish-on-check.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
let queries = 0;
// 启动时间查询一次可以查几个进程号，每个一行"进程号 时间"
const startTimes = (file, args, time) => (String(file).toLowerCase().endsWith('powershell.exe')
  ? /-Id ([0-9,]+)/.exec(args[args.indexOf('-Command') + 1])[1] : args[args.indexOf('-p') + 1]).split(',').map((pid) => pid + ' ' + time).join(String.fromCharCode(10));
childProcess.spawnSync = (file, args, options) => {
  if (String(file).toLowerCase().endsWith('powershell.exe') || file === 'ps') {
    const killing = args.includes('-Command') && args[args.indexOf('-Command') + 1].includes('taskkill.exe');
    if (++queries === ${atEntry ? 1 : 2}) {
      fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(${JSON.stringify(result)}));
      fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(${JSON.stringify(meta)}));
      return { status: 0, stdout: killing ? 'other' : startTimes(file, args, ${JSON.stringify(new Date(Date.parse(started_at) + 500).toISOString())}) };
    }
    return { status: 0, stdout: startTimes(file, args, ${JSON.stringify(started_at)}) };
  }
  if (file === 'taskkill') throw new Error('不能结束已经完成的任务');
  return spawn(file, args, options);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    const r = output(await h.start(script, ['cancel', '--run', id], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '50' } }).done);
    assert.deepEqual(r, { run_id: id, ok: false, status: 'done', note: M.cancelAlreadyEnded });
    assert.deepEqual(json(file), meta); assert.deepEqual(h.result(id), result);
    assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
    assert.equal(fs.existsSync(path.join(dir, 'cancel')), !atEntry);
  });
});

test('身份核对期间已正常收尾、之后元数据一直读不出时，cancel 不动记录并报错', async (t) => {
  const h = sandbox(t), sleeper = h.start(h.write('finishes-then-locked.mjs', 'setInterval(() => {}, 1000);'));
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  const id = 'finished-then-locked', started_at = new Date().toISOString();
  const dir = seedRun(h, id, { status: 'running', pid: sleeper.child.pid, started_at, ended_at: undefined, session_id: null });
  const file = path.join(dir, 'meta.json'), resultFile = path.join(dir, 'result.json');
  const meta = { ...json(file), status: 'done', session_id: 'finished-session', ended_at: started_at };
  const result = { status: 'done', session_id: 'finished-session', duration_s: 0 };
  const script = h.write('finish-then-lock.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync, read = fs.readFileSync;
let locked = false;
// 启动时间查询一次可以查几个进程号，每个一行"进程号 时间"
const startTimes = (file, args, time) => (String(file).toLowerCase().endsWith('powershell.exe')
  ? /-Id ([0-9,]+)/.exec(args[args.indexOf('-Command') + 1])[1] : args[args.indexOf('-p') + 1]).split(',').map((pid) => pid + ' ' + time).join(String.fromCharCode(10));
fs.readFileSync = (target, ...args) => {
  if (locked && String(target) === ${JSON.stringify(file)}) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  return read(target, ...args);
};
childProcess.spawnSync = (target, args, options) => {
  if (String(target).toLowerCase().endsWith('powershell.exe') || target === 'ps') {
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(${JSON.stringify(result)}));
    fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(${JSON.stringify(meta)}));
    locked = true;
    return { status: 0, stdout: startTimes(target, args, ${JSON.stringify(new Date(Date.parse(started_at) + 500).toISOString())}) };
  }
  return spawn(target, args, options);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const r = output(await h.start(script, ['cancel', '--run', id]).done);
  assert.deepEqual(r, { run_id: id, ok: false, status: 'running', error: M.metaUnreadable(file) });
  assert.deepEqual(json(file), meta); assert.deepEqual(h.result(id), result);
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
});

test('结果为 timeout 而元数据仍 running 时，cancel 等 runner 收尾退出后再标记已处理（磁盘上的元数据一时读不出也等）', async (t) => {
  for (const busyOnce of [false, true]) await t.test(busyOnce ? '元数据一时读不出' : '元数据读得出', async (t) => {
    const h = sandbox(t), sleeper = h.start(h.write('retrying-finish.mjs', 'setInterval(() => {}, 1000);'));
    await new Promise((resolve) => sleeper.child.once('spawn', resolve));
    const id = 'dismiss-after-finish', started_at = new Date().toISOString();
    const result = { status: 'timeout', session_id: 'finished-session', duration_s: 1 };
    const dir = seedRun(h, id, { status: 'running', pid: sleeper.child.pid, started_at, ended_at: undefined, session_id: null }, result);
    const file = path.join(dir, 'meta.json'), waiting = path.join(h.home, 'waiting-for-finish');
    // 入口依次读三次 meta.json：findRun、按结果补齐的那次、看磁盘原样的那次；第三次报 EBUSY 时也要等 runner 收尾
    const script = h.write('observe-finish-wait.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync, read = fs.readFileSync;
let reads = 0;
fs.readFileSync = (target, ...args) => {
  if (${busyOnce} && String(target) === ${JSON.stringify(file)} && ++reads === 3) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
  return read(target, ...args);
};
childProcess.spawnSync = (target, args, options) => {
  const result = spawn(target, args, options);
  if (String(target).toLowerCase().endsWith('powershell.exe') || target === 'ps') fs.writeFileSync(${JSON.stringify(waiting)}, 'waiting');
  return result;
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    const cancel = h.start(script, ['cancel', '--run', id], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '5000' } });
    await poll(() => fs.existsSync(waiting), 'cancel 开始等待收尾');
    await pause(300);
    assert.equal(cancel.child.exitCode, null); assert.equal(json(file).dismissed_at, undefined);
    const finished = { ...json(file), status: 'timeout', session_id: 'finished-session', ended_at: new Date().toISOString() };
    write(file, finished);
    sleeper.stop(); await sleeper.done;
    assert.deepEqual(output(await cancel.done), { run_id: id, ok: true, status: 'timeout', dismissed: true });
    const settled = json(file);
    assert.ok(Number.isFinite(Date.parse(settled.dismissed_at)));
    assert.deepEqual({ ...settled, dismissed_at: undefined }, { ...finished, dismissed_at: undefined });
    assert.deepEqual(h.result(id), result); assert.equal(fs.existsSync(path.join(dir, 'cancel')), false);
  });
});

test('强行结束时结果只写了一半，换成补写的最简结果，之后 status 照常读', async (t) => {
  const h = sandbox(t);
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  seedRun(h, 'half-result', { status: 'running', pid: sleeper.pid, started_at: new Date().toISOString(), ended_at: undefined, group: 'half' });
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
