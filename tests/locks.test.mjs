import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, write, json, poll, baseConfig, ROOT } from './helpers.mjs';

const url = (name) => JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', name)).href);
const wait = `const wait = async (file) => {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!fs.existsSync(file)) throw new Error('等待测试放行超时');
};`;

test('两个进程同时接管死锁，暂停的旧读者不能删掉新持有者', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'shared.lock');
  write(`${base}.1`, { pid: 2147483647, token: 'dead' });
  const markers = Object.fromEntries(['read', 'resume', 'waiting', 'first', 'second', 'release'].map((name) => [name, path.join(h.cwd, name)]));
  const script = h.write('race.mjs', `import fs from 'node:fs';
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)}, role = process.argv[2];
const read = fs.readFileSync; let paused = false;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (role === 'first' && file === base + '.1' && !paused) {
    paused = true; fs.writeFileSync(markers.read, '');
    const deadline = Date.now() + 10000;
    while (!fs.existsSync(markers.resume) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (!fs.existsSync(markers.resume)) throw new Error('等待旧读者放行超时');
  }
  if (role === 'first' && file === base + '.2') fs.writeFileSync(markers.waiting, '');
  return value;
};
const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(base, { waitMs: 8000, busy: () => { throw new Error('busy'); } });
fs.writeFileSync(markers[role], lock.file);
${wait}
if (role === 'second') await wait(markers.release);
lock.release(); console.log(JSON.stringify(lock.file));`);
  const first = h.start(script, ['first']);
  await poll(() => fs.existsSync(markers.read), '第一进程读到死锁后暂停');
  const second = h.start(script, ['second']);
  await poll(() => fs.existsSync(markers.second), '第二进程拿到第二代锁');
  const owner = json(`${base}.2`);
  assert.equal(owner.pid, second.child.pid);
  write(markers.resume, '');
  await poll(() => fs.existsSync(markers.waiting), '旧读者重新等待第二代锁');
  assert.equal(fs.existsSync(markers.first), false);
  assert.deepEqual(json(`${base}.2`), owner);
  write(markers.release, '');
  assert.deepEqual(await Promise.all([first.done, second.done]).then((runs) => runs.map((r) => output(r))), [`${base}.3`, `${base}.2`]);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('shared.lock.')), ['shared.lock.3', 'shared.lock.3.done']);
});

test('活持有者不按年龄被抢，等待上限后 busy 收到当前文件和 pid', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'live.lock'), ready = path.join(h.cwd, 'ready');
  const holder = h.write('holder.mjs', `import fs from 'node:fs';
const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 1000, busy: () => process.exit(1) });
fs.writeFileSync(${JSON.stringify(ready)}, lock.file); setInterval(() => {}, 1000);`);
  const active = h.start(holder);
  await poll(() => fs.existsSync(ready), '持有者拿到锁');
  const old = new Date('2000-01-01'); fs.utimesSync(`${base}.1`, old, old);
  const owner = json(`${base}.1`);
  const contender = h.write('busy.mjs', `const { acquireLock } = await import(${url('locks.mjs')});
const started = Date.now();
await acquireLock(${JSON.stringify(base)}, { waitMs: 150, busy: (owner) => {
  console.log(JSON.stringify({ ...owner, elapsed: Date.now() - started })); process.exit(3);
} }); process.exit(1);`);
  const r = output(await h.start(contender).done, 3);
  assert.equal(r.file, `${base}.1`); assert.equal(r.pid, active.child.pid);
  assert.ok(r.elapsed >= 150, JSON.stringify(r));
  assert.deepEqual(json(`${base}.1`), owner);
  assert.equal(fs.existsSync(`${base}.2`), false);
});

test('没权限探测（EPERM）时锁当成被占着，任务的 pidAlive 仍按进程不在算', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'admin.lock');
  const owner = { pid: process.pid, token: 'admin-owner', at: new Date(Date.now() - 10000).toISOString() };
  write(`${base}.1`, owner);
  const script = h.write('eperm.mjs', `import assert from 'node:assert/strict';
process.kill = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
const { pidAlive, pidExists } = await import(${url('util.mjs')});
assert.equal(pidAlive(${process.pid}), false); assert.equal(pidExists(${process.pid}), true);
const { acquireLock } = await import(${url('locks.mjs')});
await acquireLock(${JSON.stringify(base)}, { waitMs: 150, busy: (owner) => { console.log(JSON.stringify(owner)); process.exit(3); } });
process.exit(1);`);
  assert.deepEqual(output(await h.start(script).done, 3), { file: `${base}.1`, pid: process.pid });
  assert.deepEqual(json(`${base}.1`), owner); assert.equal(fs.existsSync(`${base}.2`), false);
});

test('进程号被别的程序复用时不按时间猜身份，等到上限报 busy、保留锁，删掉锁文件后可接着用', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'reused.lock');
  const live = h.start('-e', ["console.log('ready'); setInterval(() => {}, 1000);"]);
  await poll(() => live.stdout.includes('ready'), '被复用的进程号确实存活');
  const owner = { pid: live.child.pid, token: 'previous-owner', at: '2000-01-01T00:00:00Z' };
  write(`${base}.1`, owner);
  const script = h.write('reused.mjs', `const { acquireLock } = await import(${url('locks.mjs')});
await acquireLock(${JSON.stringify(base)}, { waitMs: 1500, busy: (owner) => { console.log(JSON.stringify(owner)); process.exit(3); } });
process.exit(1);`);
  assert.deepEqual(output(await h.start(script).done, 3), { file: `${base}.1`, pid: live.child.pid });
  assert.deepEqual(json(`${base}.1`), owner); assert.equal(fs.existsSync(`${base}.2`), false);
  fs.rmSync(`${base}.1`);
  const again = h.write('again.mjs', `const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 1500, busy: () => process.exit(3) });
lock.release(); console.log(JSON.stringify(lock.file));`);
  assert.equal(output(await h.start(again).done), `${base}.1`);
});

test('硬链接暂时报 EACCES 时短暂重试后照样拿到，不当成不支持硬链接', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'busy-link.lock');
  const script = h.write('busy-link.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const link = fs.linkSync; let calls = 0;
fs.linkSync = (...args) => { calls++; if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EACCES' }); return link(...args); };
const write = fs.writeFileSync; let fallback = 0;
fs.writeFileSync = (file, ...args) => { if (String(file).endsWith('.lock.1')) fallback++; return write(file, ...args); };
const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 2000, busy: () => process.exit(3) });
assert.equal(calls, 3); assert.equal(fallback, 0);
lock.release(); console.log(JSON.stringify(lock.file));`);
  assert.equal(output(await h.start(script).done), `${base}.1`);
});

test('数字代号、done 清理和过时建锁复查，释放幂等且临时文件不残留', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'number.lock');
  for (const g of [2, 10]) write(`${base}.${g}`, { pid: 2147483647 });
  write(`${base}.2.done`, ''); write(`${base}.1.done`, '');
  const ignored = ['.reap', '.tmp', '.', '.+100', '.-100', '.0', '.1.5', '.100.done.tmp.extra'];
  for (const suffix of ignored) write(`${base}${suffix}`, { pid: process.pid });
  const script = h.write('generations.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const { acquireLock } = await import(${url('locks.mjs')});
const base = ${JSON.stringify(base)}, options = { waitMs: 2000, busy: () => { throw new Error('busy'); } };
const listeners = process.listenerCount('exit'), first = await acquireLock(base, options);
assert.equal(first.file, base + '.11'); first.release(); first.release();
assert.equal(process.listenerCount('exit'), listeners);
assert.equal(fs.existsSync(first.file), true); assert.equal(fs.existsSync(first.file + '.done'), true);
for (const suffix of ['.2', '.2.done', '.10', '.1.done']) assert.equal(fs.existsSync(base + suffix), false);
const second = await acquireLock(base, options);
assert.equal(second.file, base + '.12'); assert.equal(fs.existsSync(first.file), false); assert.equal(fs.existsSync(first.file + '.done'), false);
second.release();
const link = fs.linkSync; let injected = false;
fs.linkSync = (tmp, file) => {
  if (injected) { assert.equal(file, base + '.21'); assert.equal(fs.existsSync(base + '.13'), false); }
  link(tmp, file);
  if (!injected) {
    injected = true; assert.equal(file, base + '.13');
    fs.writeFileSync(base + '.20', JSON.stringify({ pid: process.pid, token: 'newer' }));
    fs.writeFileSync(base + '.20.done', '');
  }
};
const third = await acquireLock(base, options); third.release(); console.log(JSON.stringify(third.file));`);
  assert.equal(output(await h.start(script).done), `${base}.21`);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('number.lock')).sort(),
    [...ignored.map((suffix) => `number.lock${suffix}`), 'number.lock.21', 'number.lock.21.done'].sort());
});

test('残缺或读失败的锁不按年龄接管，目录快照中的本体被删后仍递增代号', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'partial.lock');
  const script = h.write('partial.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const { acquireLock } = await import(${url('locks.mjs')});
const base = ${JSON.stringify(base)}, mode = process.argv[2], read = fs.readFileSync, list = fs.readdirSync, link = fs.linkSync;
let scans = 0, missing = true; const started = Date.now();
fs.readdirSync = (...args) => { scans++; return list(...args); };
fs.readFileSync = (file, ...args) => {
  if (mode === 'io' && file === base + '.1') throw Object.assign(new Error('read failed'), { code: 'EIO' });
  if (mode === 'gone' && file === base + '.1' && missing) {
    missing = false; fs.rmSync(file); throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  }
  return read(file, ...args);
};
fs.linkSync = (...args) => { assert.equal(mode, 'gone'); assert.equal(scans, 1); return link(...args); };
const lock = await acquireLock(base, { waitMs: 150, busy: (owner) => {
  assert.ok(['young', 'old', 'io'].includes(mode)); assert.equal(owner.file, base + '.1'); assert.equal(owner.pid, null);
  assert.ok(Date.now() - started >= 150); console.log(JSON.stringify('busy')); process.exit(3);
} });
lock.release(); console.log(JSON.stringify(lock.file));`);
  write(`${base}.1`, '{');
  assert.equal(output(await h.start(script, ['young']).done, 3), 'busy');
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('partial.lock.')), ['partial.lock.1']);
  const old = new Date(Date.now() - 11000); fs.utimesSync(`${base}.1`, old, old);
  assert.equal(output(await h.start(script, ['old']).done, 3), 'busy');
  assert.equal(output(await h.start(script, ['io']).done, 3), 'busy');
  assert.equal(fs.readFileSync(`${base}.1`, 'utf8'), '{');
  assert.equal(output(await h.start(script, ['gone']).done), `${base}.2`);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('partial.lock.')), ['partial.lock.2', 'partial.lock.2.done']);
});

for (const mode of ['exit', 'kill']) test(`持有者 ${mode} 后下一进程能接管`, async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'exit.lock'), ready = path.join(h.cwd, 'ready'), finish = path.join(h.cwd, 'finish');
  const script = h.write('exit.mjs', `import fs from 'node:fs';
const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 1000, busy: () => process.exit(1) });
fs.writeFileSync(${JSON.stringify(ready)}, lock.file);
${wait}
await wait(${JSON.stringify(finish)}); process.exit(0);`);
  const holder = h.start(script);
  await poll(() => fs.existsSync(ready), '退出前持有锁');
  if (mode === 'kill') holder.stop(); else write(finish, '');
  const ended = await holder.done;
  if (mode === 'exit') assert.equal(ended.code, 0, ended.stderr);
  assert.equal(fs.existsSync(`${base}.1`), true);
  assert.equal(fs.existsSync(`${base}.1.done`), mode === 'exit');
  const next = h.write('next.mjs', `const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 1000, busy: () => process.exit(1) });
lock.release(); console.log(JSON.stringify(lock.file));`);
  assert.equal(output(await h.start(next).done), `${base}.2`);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('exit.lock.')), ['exit.lock.2', 'exit.lock.2.done']);
});

test('登记先等旧版活锁，持有者退出后接管并先释放旧路径', async (t) => {
  const h = sandbox(t), base = path.join(h.runs, '.start.lock'), waiting = path.join(h.cwd, 'waiting');
  write(base, { pid: process.pid, token: 'legacy' });
  const script = h.write('legacy.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = fs.readFileSync, write = fs.writeFileSync, base = ${JSON.stringify(base)};
fs.readFileSync = (file, ...args) => {
  if (file === base) write(${JSON.stringify(waiting)}, '');
  return read(file, ...args);
};
fs.writeFileSync = (file, ...args) => {
  if (file === base + '.1.done') assert.equal(fs.existsSync(base), false);
  return write(file, ...args);
};
const { initializeRecords, newRunDir } = await import(${url('records.mjs')});
initializeRecords(${JSON.stringify(baseConfig())});
const run = await newRunDir(); run.release(); console.log(JSON.stringify(run.id));`);
  const pending = h.start(script);
  await poll(() => fs.existsSync(waiting), '新版在旧版锁外等候');
  assert.equal(pending.child.exitCode, null); assert.equal(pending.stdout, '');
  assert.equal(json(base).token, 'legacy');
  assert.equal(fs.existsSync(`${base}.1.done`), false);
  write(base, { pid: 2147483647, token: 'dead-legacy' });
  assert.match(output(await pending.done), /^\d{8}-\d{6}-/);
  assert.equal(fs.existsSync(base), false);
  assert.deepEqual(fs.readdirSync(h.runs).filter((name) => name.startsWith('.start.lock')), ['.start.lock.1', '.start.lock.1.done']);
});

for (const name of ['.start.lock', 'verdict.json.lock']) test(`${name} 的 legacy 选项等待活锁和活清理锁，回收残留后退出按序释放`, async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, name), waiting = path.join(h.cwd, 'waiting'), reaping = path.join(h.cwd, 'reaping');
  write(base, { pid: process.pid, token: 'legacy-owner' });
  const script = h.write('legacy-option.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const read = fs.readFileSync, write = fs.writeFileSync, base = ${JSON.stringify(base)};
fs.readFileSync = (file, ...args) => {
  if (file === base) write(${JSON.stringify(waiting)}, '');
  return read(file, ...args);
};
fs.writeFileSync = (file, ...args) => {
  if (file === base + '.reap') write(${JSON.stringify(reaping)}, '');
  if (file === base + '.1.done') assert.equal(fs.existsSync(base), false);
  return write(file, ...args);
};
const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(base, { waitMs: 5000, legacy: true, busy: () => { throw new Error('busy'); } });
console.log(JSON.stringify(lock.file)); process.exit(0);`);
  const pending = h.start(script);
  await poll(() => fs.existsSync(waiting), '等旧路径的活持有者');
  assert.equal(pending.child.exitCode, null); assert.equal(pending.stdout, '');
  assert.equal(json(base).token, 'legacy-owner');
  write(`${base}.reap`, { pid: process.pid, token: 'legacy-reaper' });
  write(base, { pid: 2147483647, token: 'dead-owner' });
  await poll(() => fs.existsSync(reaping), '等旧协议的活清理锁');
  assert.equal(pending.child.exitCode, null); assert.equal(pending.stdout, '');
  assert.equal(json(base).token, 'dead-owner'); assert.equal(json(`${base}.reap`).token, 'legacy-reaper');
  write(`${base}.reap`, { pid: 2147483647, token: 'dead-reaper' });
  assert.equal(output(await pending.done), `${base}.1`);
  assert.equal(fs.existsSync(base), false); assert.equal(fs.existsSync(`${base}.reap`), false);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((file) => file.startsWith(`${name}.`)), [`${name}.1`, `${name}.1.done`]);
});

test('超过上限后只做最后一轮，EEXIST 和更高代号都会报 busy，空锁仍可拿到', async (t) => {
  const h = sandbox(t);
  const script = h.write('deadline.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const { acquireLock } = await import(${url('locks.mjs')});
const mode = process.argv[2], base = process.argv[3], link = fs.linkSync;
let clock = 0, attempts = 0; Date.now = () => clock;
fs.linkSync = (tmp, file) => {
  attempts++; clock += 6;
  if (mode === 'eexist' || mode === 'last-free' && attempts === 1) {
    if (mode === 'last-free') clock = 20;
    throw Object.assign(new Error('exists'), { code: 'EEXIST' });
  }
  link(tmp, file);
  if (mode === 'higher') fs.writeFileSync(base + '.' + (BigInt(file.slice(base.length + 1)) + 2n), JSON.stringify({ pid: 2147483647 }));
};
const lock = await acquireLock(base, { waitMs: mode === 'empty' ? 0 : 10, busy: (owner) => {
  assert.ok(['eexist', 'higher'].includes(mode)); assert.equal(attempts, 3);
  console.log(JSON.stringify(owner)); process.exit(3);
} });
assert.ok(['empty', 'last-free'].includes(mode)); assert.equal(attempts, mode === 'empty' ? 1 : 2);
lock.release(); console.log(JSON.stringify(lock.file));`);
  for (const mode of ['eexist', 'higher', 'last-free', 'empty']) await t.test(mode, async () => {
    const base = path.join(h.cwd, `${mode}.lock`), failed = ['eexist', 'higher'].includes(mode);
    const r = output(await h.start(script, [mode, base]).done, failed ? 3 : 0);
    if (failed) assert.deepEqual(r, { file: `${base}.${mode === 'eexist' ? 1 : 9}`, pid: mode === 'eexist' ? null : 2147483647 });
    else assert.equal(r, `${base}.1`);
    if (mode === 'higher') for (const g of [1, 4, 7]) assert.equal(fs.existsSync(`${base}.${g}`), false);
    assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith(`${mode}.lock.`) && name.endsWith('.tmp')), []);
  });
});

test('只剩 done 时仍沿最大代号递增，并清理死进程临时文件、保留活进程文件', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'orphan.lock');
  write(`${base}.17.done`, '');
  const dead = `${base}.2147483647.dead-token.tmp`, live = `${base}.${process.pid}.live-token.tmp`;
  write(dead, '{'); write(live, '{');
  const unrelated = `${base}.2147483647.token.tmp.extra`; write(unrelated, 'keep');
  const script = h.write('orphan.mjs', `const { acquireLock } = await import(${url('locks.mjs')});
const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 1000, busy: () => { throw new Error('busy'); } });
lock.release(); console.log(JSON.stringify(lock.file));`);
  assert.equal(output(await h.start(script).done), `${base}.18`);
  assert.equal(fs.existsSync(`${base}.17.done`), false); assert.equal(fs.existsSync(dead), false);
  assert.equal(fs.readFileSync(live, 'utf8'), '{'); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('orphan.lock.')).sort(),
    ['orphan.lock.18', 'orphan.lock.18.done', path.basename(live), path.basename(unrelated)].sort());
});

test('八个进程同时抢锁，临界区读改写计数不丢失', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'count.lock'), count = path.join(h.cwd, 'count.json'), start = path.join(h.cwd, 'start');
  write(count, 0);
  const script = h.write('count.mjs', `import fs from 'node:fs';
const { acquireLock } = await import(${url('locks.mjs')});
${wait}
fs.writeFileSync(process.argv[2], ''); await wait(${JSON.stringify(start)});
for (let i = 0; i < 3; i++) {
  const lock = await acquireLock(${JSON.stringify(base)}, { waitMs: 8000, busy: () => { throw new Error('busy'); } });
  try {
    fs.writeFileSync(${JSON.stringify(`${base}.critical`)}, '', { flag: 'wx' });
    const n = JSON.parse(fs.readFileSync(${JSON.stringify(count)}, 'utf8'));
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(${JSON.stringify(count)}, JSON.stringify(n + 1));
    fs.rmSync(${JSON.stringify(`${base}.critical`)});
  } finally { lock.release(); }
}
console.log(JSON.stringify(true));`);
  const ready = Array.from({ length: 8 }, (_, i) => path.join(h.cwd, `ready-${i}`));
  const workers = ready.map((file) => h.start(script, [file]));
  await poll(() => ready.every((file) => fs.existsSync(file)), '八个进程在起点会合');
  write(start, '');
  for (const result of await Promise.all(workers.map((worker) => worker.done))) assert.equal(output(result), true);
  assert.equal(json(count), 24);
  assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('count.lock.')), ['count.lock.24', 'count.lock.24.done']);
});

test('硬链接不支持时退回 wx（EPERM 先重试几次），目录缓存避免第二次重试，失败也清掉临时文件', async (t) => {
  const h = sandbox(t), base = path.join(h.cwd, 'fallback.lock');
  const script = h.write('fallback.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const { acquireLock } = await import(${url('locks.mjs')});
const code = process.argv[2]; let calls = 0;
fs.linkSync = () => { calls++; throw Object.assign(new Error(code), { code }); };
try {
  const options = { waitMs: 1000, busy: () => { throw new Error('busy'); } };
  const lock = await acquireLock(${JSON.stringify(base)}, options);
  // EPERM 在 Windows 上也可能只是暂时的，先重试几次才当作不支持
  const tries = code === 'EPERM' ? 4 : 1;
  assert.notEqual(code, 'EIO'); assert.equal(calls, tries); lock.release();
  const second = await acquireLock(${JSON.stringify(base)}, options);
  assert.equal(calls, tries); second.release(); console.log(JSON.stringify(second.file));
} catch (error) { assert.equal(code, 'EIO'); assert.equal(error.code, code); console.log(JSON.stringify(null)); }`);
  for (const [i, code] of ['ENOTSUP', 'EXDEV', 'ENOSYS', 'EPERM', 'EOPNOTSUPP', 'EIO'].entries()) {
    const r = output(await h.start(script, [code]).done);
    assert.equal(r, code === 'EIO' ? null : `${base}.${2 * (i + 1)}`);
    assert.deepEqual(fs.readdirSync(h.cwd).filter((name) => name.startsWith('fallback.lock.')), [`fallback.lock.${2 * Math.min(i + 1, 5)}`, `fallback.lock.${2 * Math.min(i + 1, 5)}.done`]);
  }
});
