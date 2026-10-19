import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { sandbox, output, failed, baseConfig, taskArgs, seedRun, write, json, ROOT, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;

test('同组 discuss 和 review 不查写入范围，exec 仍检查', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-exec', { group: 'scope-group', scope: ['src'], status: 'running', pid: process.pid });
  const scenario = h.scenario({ last_message: discussion });
  const args = ['--group', 'scope-group', '--scope', 'src', '--no-snapshot'];
  assert.equal(output(await h.bridge(taskArgs(h, 'discuss', args), { env: scenario.env })).kind, 'discuss');
  assert.equal(output(await h.bridge(taskArgs(h, 'review', args))).kind, 'review');
  failed(await h.bridge(taskArgs(h, 'run', args)), M.scopeOverlap('scope-group', '20000101-exec', ['src']));
  write(path.join(h.runs, '20000101-exec', 'meta.json'), { ...h.records().find((m) => m.id === '20000101-exec'), status: 'done' });
  for (const kind of ['discuss', 'review']) seedRun(h, `20000101-${kind}`, { kind, mode: kind, group: 'scope-group', scope: ['src'], status: 'running', pid: process.pid });
  const executed = output(await h.bridge(taskArgs(h, 'run', args))); assert.equal(executed.kind, 'exec');
  const script = h.write('owner.mjs', `import { initializeRecords, groupScopeOwner, writesFiles } from ${JSON.stringify(url('records.mjs'))};
initializeRecords(${JSON.stringify(baseConfig())});
console.log(JSON.stringify({ owner: groupScopeOwner({ id: ${JSON.stringify(executed.run_id)}, cwd: ${JSON.stringify(h.cwd)}, group: 'scope-group', claude_session: 'test-session' })('src/x'),
  writes: ['exec', 'discuss', 'review'].map((kind) => writesFiles({ kind })) }));`);
  // 已结束的 exec 仍能解释文件归属，review / discuss 不会夺走它。
  const owner = output(await h.start(script).done);
  assert.equal(owner.owner, '20000101-exec'); assert.deepEqual(owner.writes, [true, false, false]);
});

for (const legacy of [false, true]) test(`活着的登记锁不按年龄被抢（${legacy ? '旧 pid' : 'pid 和 token'}）`, async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock');
  write(lock, legacy ? String(process.pid) : { pid: process.pid, token: 'live-owner' });
  fs.utimesSync(lock, new Date('2000-01-01'), new Date('2000-01-01'));
  const handle = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']));
  await pause(750);
  assert.equal(h.records().length, 0); assert.equal(handle.child.exitCode, null);
  assert.equal(legacy ? Number(fs.readFileSync(lock, 'utf8')) : json(lock).token, legacy ? process.pid : 'live-owner');
  fs.rmSync(lock);
  output(await handle.done);
  assert.equal(h.records().length, 1); assert.equal(fs.existsSync(lock), false);
});

test('死进程的旧登记锁能回收，等满一分钟的活锁给出明确错误', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock');
  write(lock, '2147483647');
  output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
  write(lock, { pid: process.pid, token: 'other' });
  const script = h.write('lock-busy.mjs', `import { initializeRecords, newRunDir } from ${JSON.stringify(url('records.mjs'))};
initializeRecords(${JSON.stringify(baseConfig())});
let n = 0; Date.now = () => n++ ? 60000 : 0; await newRunDir();`);
  failed(await h.start(script).done, M.startLockBusy(lock, process.pid, 60));
  assert.equal(json(lock).token, 'other');
});

for (const content of ['', '{}', 'garbage']) test(`读不出持有者的旧登记锁会被清掉（${JSON.stringify(content)}）`, async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock');
  write(lock, content);
  fs.utimesSync(lock, new Date('2000-01-01'), new Date('2000-01-01'));
  output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
  assert.equal(h.records().length, 1); assert.equal(fs.existsSync(lock), false);
});

test('活进程持有清理锁时不回收残留登记锁，释放后任务登记', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), reap = `${lock}.reap`;
  write(lock, { pid: 2147483647, token: 'stale' }); write(reap, String(process.pid));
  const handle = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']));
  await pause(750);
  assert.equal(h.records().length, 0); assert.equal(handle.child.exitCode, null);
  assert.equal(json(lock).token, 'stale'); assert.equal(Number(fs.readFileSync(reap, 'utf8')), process.pid);
  fs.rmSync(reap);
  output(await handle.done);
  assert.equal(h.records().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(reap), false);
});

test('清理锁的持有者退出后清掉清理锁并完成登记', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), reap = `${lock}.reap`;
  write(lock, { pid: 2147483647, token: 'stale' }); write(reap, '2147483647');
  output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
  assert.equal(h.records().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(reap), false);
});

for (const content of ['', '{}', 'garbage']) test(`读不出持有者的旧清理锁会被清掉并完成登记（${JSON.stringify(content)}）`, async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), reap = `${lock}.reap`;
  write(lock, { pid: 2147483647, token: 'stale' }); write(reap, content);
  fs.utimesSync(reap, new Date('2000-01-01'), new Date('2000-01-01'));
  output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
  assert.equal(h.records().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(reap), false);
});

for (const onExit of [false, true]) test(`${onExit ? '退出清理' : '显式释放'}只删自己的 token`, async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock');
  const script = h.write('release.mjs', `import fs from 'node:fs';
import { initializeRecords, newRunDir } from ${JSON.stringify(url('records.mjs'))};
initializeRecords(${JSON.stringify(baseConfig())});
const run = await newRunDir(), lock = ${JSON.stringify(lock)}, owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'replacement' }));
${onExit ? '' : 'run.release();'}
console.log(JSON.stringify(owner));`);
  const owner = output(await h.start(script).done);
  assert.ok(Number.isInteger(owner.pid)); assert.match(owner.token, /^[a-f0-9-]{36}$/);
  assert.equal(json(lock).token, 'replacement');
});
