import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { plannedSandbox as sandbox, output, failed, baseConfig, taskArgs, seedRun, write, json, poll, ROOT, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;

test('同组 discuss 和 review 不查写入范围，exec 仍检查', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-exec', { group: 'scope-group', scope: ['src'], status: 'running', pid: process.pid });
  const scenario = h.scenario({ last_message: discussion });
  const args = ['--group', 'scope-group', '--scope', 'src'];
  assert.equal(output(await h.bridge(taskArgs(h, 'discuss', args), { env: scenario.env })).kind, 'discuss');
  assert.equal(output(await h.bridge(taskArgs(h, 'review', args))).kind, 'review');
  failed(await h.bridge(taskArgs(h, 'run', args)), M.scopeOverlap('scope-group', '20000101-exec', ['src']));
  write(path.join(h.runs, '20000101-exec', 'meta.json'), { ...h.records().find((m) => m.id === '20000101-exec'), status: 'done' });
  for (const kind of ['discuss', 'review']) seedRun(h, `20000101-${kind}`, { kind, mode: kind, group: 'scope-group', scope: ['src'], status: 'running', pid: process.pid });
  const executed = output(await h.bridge(taskArgs(h, 'run', args))); assert.equal(executed.kind, 'exec');
  const execStart = h.records().find((m) => m.id === '20000101-exec').started_at;
  const script = h.write('owner.mjs', `import { initializeRecords, groupScopeOwner, writesFiles } from ${JSON.stringify(url('records.mjs'))};
initializeRecords(${JSON.stringify(baseConfig())});
const owner = (started_at) => groupScopeOwner({ id: ${JSON.stringify(executed.run_id)}, cwd: ${JSON.stringify(h.cwd)}, group: 'scope-group', claude_session: 'test-session', started_at })('src/x');
console.log(JSON.stringify({ overlapping: owner(${JSON.stringify(execStart)}), later: owner(new Date().toISOString()),
  writes: ['exec', 'discuss', 'review'].map((kind) => writesFiles({ kind })) }));`);
  // 运行时间有重叠的 exec 能解释文件归属，review / discuss 不会夺走它；在这个任务开始之前就结束的 exec 不认领。
  const owner = output(await h.start(script).done);
  assert.equal(owner.overlapping, '20000101-exec'); assert.equal(owner.later, null); assert.deepEqual(owner.writes, [true, false, false]);
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

test('兼容登记锁和旧代文件正被删除时报 EPERM、EACCES、EBUSY 只是稍等再试，一直报错才抛出原错误', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), previous = `${lock}.1`;
  const script = h.write('lock-transient.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
import { initializeRecords, newRunDir } from ${JSON.stringify(url('records.mjs'))};
initializeRecords(${JSON.stringify(baseConfig())});
const lock = ${JSON.stringify(lock)}, previous = lock + '.1', mode = process.argv[2];
const errors = { writeFileSync: [['EPERM'], ['EBUSY']], readFileSync: [['EACCES'], ['EPERM']], rmSync: [['EBUSY'], ['EPERM']] };
const calls = Object.fromEntries(Object.keys(errors).map((name) => [name, [0, 0]]));
const originals = Object.fromEntries(Object.keys(errors).map((name) => [name, fs[name]]));
let newcomer = null;
for (const name of Object.keys(errors)) {
  fs[name] = (file, ...args) => {
    const i = [lock, previous].indexOf(file);
    if (i !== -1) {
      const n = calls[name][i]++;
      // 删残留登记锁第一次失败时，别的回收者已经删掉了它、又有新的持有者拿到了锁：重试不能删掉这把新锁。
      if (mode === 'replaced' && name === 'rmSync' && i === 0 && n === 0) {
        originals.rmSync(lock, { force: true });
        originals.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'newcomer' }));
        newcomer = new Promise((resolve) => setTimeout(() => {
          let owner = null;
          try { owner = JSON.parse(originals.readFileSync(lock, 'utf8')).token; } catch { /* 已经被删掉 */ }
          originals.rmSync(lock, { force: true });
          resolve(owner);
        }, 50));
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      const code = mode === 'always' && name === 'writeFileSync' && i === 0 ? 'EPERM'
        : mode === 'cleanup' && name === 'rmSync' && i === 0 ? 'EACCES' : mode === 'short' ? errors[name][i][n] : null;
      if (code) throw Object.assign(new Error(code), { code });
    }
    return originals[name](file, ...args);
  };
}
// 回收时的错误要是被吞掉，会一直等到 60 秒报占锁；假时钟让这条路一开始就走到 60 秒检查。
if (mode === 'cleanup') Date.now = () => calls.rmSync[0] ? 60000 : 0;
const run = await newRunDir();
assert.equal(fs.existsSync(previous), mode !== 'short');
const owner = await newcomer;
const before = [calls.readFileSync[0], calls.rmSync[0]];
errors.readFileSync[0][before[0]] = 'EPERM'; errors.rmSync[0][before[1]] = 'EACCES';
run.release();
console.log(JSON.stringify({ dir: run.dir, calls, owner, release: [calls.readFileSync[0] - before[0], calls.rmSync[0] - before[1]] }));`);
  fs.mkdirSync(h.runs, { recursive: true });
  for (const mode of ['short', 'always', 'cleanup', 'replaced']) await t.test(mode, async () => {
    for (const name of fs.readdirSync(h.runs).filter((name) => name.startsWith('.start.lock'))) fs.rmSync(path.join(h.runs, name), { force: true });
    if (mode !== 'always') write(lock, { pid: 2147483647, token: 'stale' });
    if (mode === 'short') write(previous, { pid: 2147483647, token: 'stale-generation' });
    const result = await h.start(script, [mode], { timeout: 15000 }).done;
    if (mode === 'short' || mode === 'replaced') {
      const r = output(result);
      assert.equal(fs.statSync(r.dir).isDirectory(), true); assert.equal(fs.existsSync(lock), false);
      // release 时每次删除前都重新读一次锁确认是自己的：读 3 次（含一次失败），删 2 次（含一次失败）。
      if (mode === 'short') { assert.deepEqual(r.release, [3, 2]); assert.equal(r.calls.rmSync[1], 2); assert.ok(r.calls.readFileSync[1] >= 2); }
      else assert.equal(r.owner, 'newcomer');
    } else {
      assert.equal(result.code, 1, result.stderr); assert.match(result.stderr, mode === 'always' ? /EPERM/ : /EACCES/);
      assert.equal(result.stderr.includes(M.startLockBusy(lock, mode === 'always' ? '?' : 2147483647, 60)), false);
    }
  });
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

test('活进程持有代际锁时不回收残留兼容锁，释放后任务登记', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), previous = `${lock}.1`;
  write(lock, { pid: 2147483647, token: 'stale' }); write(previous, { pid: process.pid });
  const handle = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']));
  await pause(750);
  assert.equal(h.records().length, 0); assert.equal(handle.child.exitCode, null);
  assert.equal(json(lock).token, 'stale'); assert.equal(json(previous).pid, process.pid);
  write(`${previous}.done`, '');
  output(await handle.done);
  assert.equal(h.records().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(previous), false); assert.equal(fs.existsSync(`${previous}.done`), false);
});

test('代际锁持有者退出后仍等旧清理锁，清理锁退出后接管并完成登记', async (t) => {
  const h = sandbox(t), lock = path.join(h.runs, '.start.lock'), previous = `${lock}.1`, reap = `${lock}.reap`;
  write(lock, { pid: 2147483647, token: 'stale' }); write(previous, { pid: 2147483647 }); write(reap, String(process.pid));
  const pending = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']));
  await poll(() => fs.existsSync(`${lock}.2`), '拿到新代后等旧清理锁');
  assert.equal(h.records().length, 0); assert.equal(pending.child.exitCode, null);
  assert.equal(json(lock).token, 'stale'); assert.equal(Number(fs.readFileSync(reap, 'utf8')), process.pid);
  write(reap, '2147483647');
  output(await pending.done);
  assert.equal(h.records().length, 1);
  assert.equal(fs.existsSync(lock), false); assert.equal(fs.existsSync(previous), false); assert.equal(fs.existsSync(reap), false);
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
