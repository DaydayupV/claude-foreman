import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLockSync } from '../foreman/skills/dispatch/scripts/locks.mjs';
import { sandbox, output, write, read, json, poll, ROOT, MESSAGES } from './helpers.mjs';

const url = (name) => JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', name)).href);
const dead = 2147483647;
const wait = `const wait = (file) => {
  const deadline = Date.now() + 8000;
  while (!fs.existsSync(file) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  if (!fs.existsSync(file)) throw new Error('等待测试放行超时');
};`;

test('两个进程同时回收死锁，暂停的旧读者不会删除新持有者的锁', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`;
  write(base, String(dead));
  const markers = Object.fromEntries(['deleting', 'contending', 'read', 'resume', 'resumeRead', 'waiting', 'first', 'second', 'release'].map((name) => [name, path.join(h.cwd, name)]));
  const script = h.write('config-lock-race.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)}, role = process.argv[2];
${wait}
const read = fs.readFileSync, write = fs.writeFileSync, remove = fs.rmSync, removed = []; let paused = false, reads = 0;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (role === 'second' && file === base && value === '${dead}' && ++reads === 2) {
    write(markers.read, ''); wait(markers.resumeRead);
  }
  if (role === 'second' && file === base && value !== '${dead}' && value !== String(process.pid)) write(markers.waiting, value);
  return value;
};
fs.writeFileSync = (file, ...args) => {
  try { return write(file, ...args); }
  catch (error) { if (role === 'second' && file === base + '.reap' && error.code === 'EEXIST') write(markers.contending, ''); throw error; }
};
fs.rmSync = (file, ...args) => {
  if (file === base) {
    if (role === 'first' && !paused) { paused = true; write(markers.deleting, ''); wait(markers.resume); }
    removed.push(Number(read(base, 'utf8')));
  }
  return remove(file, ...args);
};
const lock = acquireLockSync(base, { waitMs: 8000, busy: () => { throw new Error('busy'); } });
fs.writeFileSync(markers[role], String(process.pid));
if (role === 'first') wait(markers.release);
lock.release(); console.log(JSON.stringify({ pid: process.pid, removed }));`);
  const first = h.start(script, ['first']);
  await poll(() => fs.existsSync(markers.deleting), 'A 确认过期后在删除前暂停');
  assert.equal(json(`${base}.reap`).pid, first.child.pid);
  assert.equal(typeof json(`${base}.reap`).token, 'string');
  const second = h.start(script, ['second']);
  await poll(() => fs.existsSync(markers.read), 'B 被回收锁挡住，再次读到死锁后暂停');
  assert.equal(fs.existsSync(markers.contending), true);
  assert.equal(fs.existsSync(markers.second), false);
  assert.equal(read(base), String(dead));
  write(markers.resume, '');
  await poll(() => fs.existsSync(markers.first), 'A 删掉死锁并持有新锁');
  assert.equal(read(base), String(first.child.pid));
  write(markers.resumeRead, '');
  await poll(() => fs.existsSync(markers.waiting), 'B 带着旧读数恢复后等待 A 的活锁');
  assert.equal(fs.existsSync(markers.second), false);
  assert.equal(read(base), String(first.child.pid));
  write(markers.release, '');
  const [a, b] = (await Promise.all([first.done, second.done])).map((result) => output(result));
  assert.deepEqual(a.removed, [dead, a.pid]);
  assert.deepEqual(b.removed, [b.pid]);
  assert.equal(fs.existsSync(base), false);
  assert.equal(fs.existsSync(`${base}.reap`), false);
});

test('活持有者即使锁很旧也会等待，超时保留锁并报 configLockTimeout', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`, waiting = path.join(h.cwd, 'waiting');
  write(base, String(process.pid));
  const old = new Date('2000-01-01'); fs.utimesSync(base, old, old);
  const script = h.write('config-lock-wait.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
import { M } from ${url('util.mjs')};
const base = ${JSON.stringify(base)}, started = Date.now(), mode = process.argv[2];
const read = fs.readFileSync; let blocked;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (mode === 'wait' && file === base && value === String(process.ppid)) fs.writeFileSync(${JSON.stringify(waiting)}, '');
  return value;
};
try {
  const lock = acquireLockSync(base, { waitMs: mode === 'wait' ? 3000 : 150, busy: (owner) => { blocked = owner; throw new Error(M.configLockTimeout(base)); } });
  lock.release(); console.log(JSON.stringify({ acquired: true }));
} catch (error) { console.log(JSON.stringify({ message: error.message, ...blocked, elapsed: Date.now() - started })); }`);
  const timed = output(await h.start(script, ['timeout']).done);
  assert.equal(timed.message, MESSAGES.zh.configLockTimeout(base));
  assert.equal(timed.file, base); assert.equal(timed.pid, process.pid);
  assert.ok(timed.elapsed >= 150, JSON.stringify(timed));
  assert.equal(read(base), String(process.pid));
  assert.equal(fs.existsSync(`${base}.reap`), false);
  const child = h.start(script, ['wait']);
  await poll(() => fs.existsSync(waiting), '竞争者等待活持有者');
  assert.equal(read(base), String(process.pid));
  fs.rmSync(base);
  assert.deepEqual(output(await child.done), { acquired: true });
  assert.equal(fs.existsSync(base), false);
});

test('.reap 的活持有者退出后能继续回收，删除重试会复查 pid 和 token', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`, reap = `${base}.reap`, waiting = path.join(h.cwd, 'waiting');
  const holder = h.start('-e', ["console.log('ready'); setInterval(() => {}, 1000);"]);
  await poll(() => holder.stdout.includes('ready'), '回收锁持有者启动');
  write(base, String(dead)); write(reap, { pid: holder.child.pid, token: 'old' });
  const script = h.write('config-lock-reap.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, reap = base + '.reap', mode = process.argv[2];
const read = fs.readFileSync, remove = fs.rmSync; let replaced = false;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (mode === 'recover' && file === reap) fs.writeFileSync(${JSON.stringify(waiting)}, '');
  return value;
};
fs.rmSync = (file, ...args) => {
  if (file === reap && mode !== 'recover' && !replaced) {
    replaced = true; fs.writeFileSync(reap, JSON.stringify({ pid: process.ppid, token: 'replacement' }));
    throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
  }
  return remove(file, ...args);
};
try {
  const lock = acquireLockSync(base, { waitMs: mode === 'stale-replaced' ? 150 : 4000, busy: () => { throw new Error('busy'); } });
  lock.release(); console.log(JSON.stringify({ acquired: true }));
} catch (error) { console.log(JSON.stringify({ message: error.message })); }`);
  const child = h.start(script, ['recover']);
  await poll(() => fs.existsSync(waiting), '竞争者等待活的 .reap 持有者');
  assert.equal(read(base), String(dead));
  assert.deepEqual(json(reap), { pid: holder.child.pid, token: 'old' });
  holder.stop(); await holder.done;
  assert.deepEqual(output(await child.done), { acquired: true });
  assert.equal(fs.existsSync(base), false); assert.equal(fs.existsSync(reap), false);
  for (const mode of ['stale-replaced', 'own-replaced']) {
    write(base, String(dead));
    if (mode === 'stale-replaced') write(reap, { pid: dead, token: 'dead' });
    else fs.rmSync(reap);
    const result = output(await h.start(script, [mode]).done);
    assert.deepEqual(json(reap), { pid: process.pid, token: 'replacement' });
    assert.deepEqual(result, mode === 'stale-replaced' ? { message: 'busy' } : { acquired: true });
    if (mode === 'stale-replaced') assert.equal(read(base), String(dead));
    else assert.equal(fs.existsSync(base), false);
  }
});

test('锁内容兼容旧版纯 pid 判断，释放只删自己的锁且异常退出会清理', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`, listeners = process.listenerCount('exit');
  const options = { waitMs: 1000, busy: () => { throw new Error('busy'); } };
  const first = acquireLockSync(base, options);
  assert.equal(read(base), String(process.pid));
  assert.match(read(base), /^[1-9][0-9]*$/);
  assert.equal(Number(read(base)), process.pid);
  assert.doesNotThrow(() => process.kill(Number(read(base)), 0));
  write(base, String(dead)); first.release(); first.release();
  assert.equal(read(base), String(dead));
  assert.equal(process.listenerCount('exit'), listeners);
  const second = acquireLockSync(base, options);
  first.release(); assert.equal(read(base), String(process.pid));
  second.release(); second.release();
  assert.equal(fs.existsSync(base), false);
  assert.equal(process.listenerCount('exit'), listeners);
  const script = h.write('config-lock-exit.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)};
acquireLockSync(base, { waitMs: 1000, busy: () => { throw new Error('busy'); } });
if (process.argv[2] === 'taken') fs.writeFileSync(base, String(process.ppid));
throw new Error('synthetic exit');`);
  for (const mode of ['own', 'taken']) {
    const result = await h.start(script, [mode]).done;
    assert.equal(result.code, 1); assert.ok(result.stderr.includes('synthetic exit'), result.stderr);
    if (mode === 'taken') assert.equal(read(base), String(process.pid));
    else assert.equal(fs.existsSync(base), false);
  }
});

test('无效 pid 的锁保留两秒宽限，过期后回收', (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`;
  write(base, 'broken');
  const options = { waitMs: 75, busy: () => { throw new Error(MESSAGES.zh.configLockTimeout(base)); } };
  assert.throws(() => acquireLockSync(base, options), { message: MESSAGES.zh.configLockTimeout(base) });
  assert.equal(read(base), 'broken');
  const old = new Date(Date.now() - 2100); fs.utimesSync(base, old, old);
  const lock = acquireLockSync(base, options);
  assert.equal(read(base), String(process.pid));
  lock.release();
  assert.equal(fs.existsSync(base), false); assert.equal(fs.existsSync(`${base}.reap`), false);
});
