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
  write(`${base}.reap`, { pid: dead, token: 'dead-reaper' });
  write(`${base}.gen.1`, { pid: dead, token: 'dead-generation' });
  const markers = Object.fromEntries(['deleting', 'read', 'resume', 'resumeRead', 'waiting', 'first', 'second', 'release'].map((name) => [name, path.join(h.cwd, name)]));
  const script = h.write('config-lock-race.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)}, role = process.argv[2];
${wait}
const read = fs.readFileSync, write = fs.writeFileSync, remove = fs.rmSync, removed = []; let paused = false, legacyReads = 0;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (role === 'second' && file === base + '.gen.1' && !paused) {
    paused = true;
    write(markers.read, ''); wait(markers.resumeRead);
  }
  if (role === 'second' && file === base + '.gen.2') write(markers.waiting, JSON.stringify({ legacyReads }));
  if (file === base || file === base + '.reap') legacyReads++;
  return value;
};
fs.rmSync = (file, ...args) => {
  if (file === base) {
    if (role === 'first' && !paused) { paused = true; write(markers.deleting, ''); wait(markers.resume); }
    removed.push(Number(read(base, 'utf8')));
  }
  return remove(file, ...args);
};
const lock = acquireLockSync(base + '.gen', { waitMs: 8000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
fs.writeFileSync(base + '.critical', '', { flag: 'wx' });
fs.writeFileSync(markers[role], String(process.pid));
if (role === 'first') wait(markers.release);
fs.rmSync(base + '.critical');
lock.release(); console.log(JSON.stringify({ pid: process.pid, removed }));`);
  const second = h.start(script, ['second']);
  await poll(() => fs.existsSync(markers.read), 'B 读到死进程的编号锁后暂停');
  const first = h.start(script, ['first']);
  await poll(() => fs.existsSync(markers.deleting), 'A 确认过期后在删除前暂停');
  const reaper = json(`${base}.reap`);
  assert.equal(reaper.pid, first.child.pid);
  assert.equal(typeof reaper.token, 'string');
  assert.equal(fs.existsSync(markers.second), false);
  assert.equal(read(base), String(dead));
  write(markers.resumeRead, '');
  await poll(() => fs.existsSync(markers.waiting), 'B 带着旧读数恢复后被 A 的编号锁挡住');
  assert.deepEqual(json(markers.waiting), { legacyReads: 0 });
  assert.deepEqual(json(`${base}.reap`), reaper);
  write(markers.resume, '');
  await poll(() => fs.existsSync(markers.first), 'A 删掉死锁并持有新锁');
  assert.equal(read(base), String(first.child.pid));
  assert.equal(fs.existsSync(markers.second), false);
  assert.equal(read(base), String(first.child.pid));
  write(markers.release, '');
  const [a, b] = (await Promise.all([first.done, second.done])).map((result) => output(result));
  assert.deepEqual(a.removed, [dead, a.pid]);
  assert.deepEqual(b.removed, [b.pid]);
  assert.equal(fs.existsSync(base), false);
  assert.equal(fs.existsSync(`${base}.reap`), false);
});

test('主锁和 .reap 都已过期，暂停的回收者始终由编号锁挡住另一个回收者', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`;
  write(base, String(dead)); write(`${base}.reap`, { pid: dead, token: 'dead-reaper' });
  const markers = Object.fromEntries(['stale', 'resume', 'waiting', 'first', 'second', 'release'].map((name) => [name, path.join(h.cwd, name)]));
  const script = h.write('dead-reap-race.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)}, role = process.argv[2];
${wait}
const read = fs.readFileSync, remove = fs.rmSync; let paused = false, legacyReads = 0;
fs.readFileSync = (file, ...args) => {
  const value = read(file, ...args);
  if (file === base || file === base + '.reap') legacyReads++;
  if (role === 'second' && file === base + '.gen.1') fs.writeFileSync(markers.waiting, JSON.stringify({ legacyReads }));
  return value;
};
fs.rmSync = (file, ...args) => {
  if (role === 'first' && file === base + '.reap' && !paused) {
    paused = true; fs.writeFileSync(markers.stale, ''); wait(markers.resume);
  }
  return remove(file, ...args);
};
const lock = acquireLockSync(base + '.gen', { waitMs: 8000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
fs.writeFileSync(base + '.critical', '', { flag: 'wx' });
fs.writeFileSync(markers[role], String(process.pid));
if (role === 'first') wait(markers.release);
fs.rmSync(base + '.critical');
lock.release(); console.log(JSON.stringify(true));`);
  const first = h.start(script, ['first']);
  await poll(() => fs.existsSync(markers.stale), 'A 已判断旧 .reap 过期，在删除前暂停');
  const second = h.start(script, ['second']);
  await poll(() => fs.existsSync(markers.waiting), 'B 被 A 的编号锁挡住');
  assert.deepEqual(json(markers.waiting), { legacyReads: 0 });
  assert.deepEqual(json(`${base}.reap`), { pid: dead, token: 'dead-reaper' });
  assert.equal(read(base), String(dead));
  assert.equal(fs.existsSync(markers.second), false);
  write(markers.resume, '');
  await poll(() => fs.existsSync(markers.first), 'A 回收两个死锁后拿到主锁');
  assert.equal(read(base), String(first.child.pid));
  assert.equal(fs.existsSync(markers.second), false);
  write(markers.release, '');
  for (const result of await Promise.all([first.done, second.done])) assert.equal(output(result), true);
  assert.equal(fs.existsSync(base), false); assert.equal(fs.existsSync(`${base}.reap`), false);
});

test('.reap 建成后归属读取持续 EPERM，两个入口都清理残留并允许活进程外的下一进程拿锁', async (t) => {
  const h = sandbox(t);
  for (const mode of ['sync', 'async']) {
    const base = `${h.userConfig}.${mode}.structure.lock`, ready = path.join(h.cwd, `${mode}-failed`), finish = path.join(h.cwd, `${mode}-finish`);
    write(base, String(dead));
    const script = h.write(`${mode}-reap-eperm.mjs`, `import fs from 'node:fs';
import assert from 'node:assert/strict';
import { acquireLock, acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, read = fs.readFileSync, write = fs.writeFileSync;
let created = false, reads = 0;
fs.writeFileSync = (file, ...args) => { const value = write(file, ...args); if (file === base + '.reap') created = true; return value; };
fs.readFileSync = (file, ...args) => {
  if (file === base + '.reap' && created) { reads++; throw Object.assign(new Error('denied'), { code: 'EPERM' }); }
  return read(file, ...args);
};
const listeners = process.listenerCount('exit'), options = { waitMs: 5000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } };
try {
  if (${JSON.stringify(mode)} === 'sync') acquireLockSync(base + '.gen', options);
  else await acquireLock(base + '.gen', options);
  assert.fail('应抛出归属读取错误');
} catch (error) { assert.equal(error.code, 'EPERM'); }
assert.ok(reads >= 81); assert.equal(fs.existsSync(base + '.reap'), false);
assert.equal(fs.existsSync(base + '.gen.1.done'), true);
assert.equal(process.listenerCount('exit'), listeners);
fs.writeFileSync(${JSON.stringify(ready)}, '');
${wait}
wait(${JSON.stringify(finish)}); console.log(JSON.stringify(true));`);
    const failed = h.start(script);
    await poll(() => fs.existsSync(ready), `${mode} 入口清理失败的 .reap`);
    assert.equal(failed.child.exitCode, null);
    assert.equal(fs.existsSync(`${base}.reap`), false);
    const next = h.write(`${mode}-after-eperm.mjs`, `import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)};
const lock = acquireLockSync(base + '.gen', { waitMs: 1000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
lock.release(); console.log(JSON.stringify(true));`);
    assert.equal(output(await h.start(next).done), true);
    assert.equal(fs.existsSync(`${base}.gen.2.done`), true);
    assert.equal(fs.existsSync(base), false);
    assert.equal(failed.child.exitCode, null);
    write(finish, ''); assert.equal(output(await failed.done), true);
  }
});

test('纯 pid 的旧协议进程与新版双向互斥，旧进程能识别新版的活持有者', async (t) => {
  const h = sandbox(t), base = `${h.userConfig}.structure.lock`;
  const markers = Object.fromEntries(['old', 'oldRelease', 'waiting', 'new', 'newRelease'].map((name) => [name, path.join(h.cwd, name)]));
  const oldScript = h.write('old-config-lock.mjs', `import fs from 'node:fs';
import assert from 'node:assert/strict';
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)};
${wait}
if (process.argv[2] === 'probe') {
  assert.throws(() => fs.writeFileSync(base, String(process.pid), { flag: 'wx' }), { code: 'EEXIST' });
  const text = fs.readFileSync(base, 'utf8'), pid = Number(text);
  assert.match(text, /^[1-9][0-9]*$/); process.kill(pid, 0);
  console.log(JSON.stringify({ pid, text }));
} else {
  fs.writeFileSync(base, String(process.pid), { flag: 'wx' });
  fs.writeFileSync(markers.old, ''); wait(markers.oldRelease);
  if (Number(fs.readFileSync(base, 'utf8')) === process.pid) fs.rmSync(base);
  console.log(JSON.stringify(true));
}`);
  const newScript = h.write('new-config-lock.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)}, markers = ${JSON.stringify(markers)}, read = fs.readFileSync;
${wait}
fs.readFileSync = (file, ...args) => { const value = read(file, ...args); if (file === base) fs.writeFileSync(markers.waiting, ''); return value; };
const lock = acquireLockSync(base + '.gen', { waitMs: 8000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
fs.writeFileSync(markers.new, ''); wait(markers.newRelease);
lock.release(); console.log(JSON.stringify(true));`);
  const old = h.start(oldScript);
  await poll(() => fs.existsSync(markers.old), '旧协议用 wx 拿到纯 pid 锁');
  const pending = h.start(newScript);
  await poll(() => fs.existsSync(markers.waiting), '新版等待旧协议持有者');
  assert.equal(read(base), String(old.child.pid));
  assert.equal(fs.existsSync(markers.new), false);
  write(markers.oldRelease, ''); assert.equal(output(await old.done), true);
  await poll(() => fs.existsSync(markers.new), '旧进程释放后新版拿到锁');
  const before = read(base), ancient = new Date('2000-01-01'); fs.utimesSync(base, ancient, ancient);
  assert.deepEqual(output(await h.start(oldScript, ['probe']).done), { pid: pending.child.pid, text: String(pending.child.pid) });
  assert.equal(read(base), before);
  write(markers.newRelease, ''); assert.equal(output(await pending.done), true);
  assert.equal(fs.existsSync(base), false);
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
  const lock = acquireLockSync(base + '.gen', { waitMs: mode === 'wait' ? 3000 : 150, legacy: { base, format: 'pid' }, busy: (owner) => { blocked = owner; throw new Error(M.configLockTimeout(owner.file, owner.pid)); } });
  lock.release(); console.log(JSON.stringify({ acquired: true }));
} catch (error) { console.log(JSON.stringify({ message: error.message, ...blocked, elapsed: Date.now() - started })); }`);
  const timed = output(await h.start(script, ['timeout']).done);
  assert.equal(timed.message, MESSAGES.zh.configLockTimeout(base, process.pid));
  assert.ok(timed.message.includes(`pid ${process.pid}`) && timed.message.includes('删掉这个文件'), timed.message);
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
  const lock = acquireLockSync(base + '.gen', { waitMs: mode === 'stale-replaced' ? 150 : 4000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
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
  const options = { waitMs: 1000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } };
  const first = acquireLockSync(`${base}.gen`, options);
  assert.equal(read(base), String(process.pid));
  assert.match(read(base), /^[1-9][0-9]*$/);
  assert.equal(Number(read(base)), process.pid);
  assert.doesNotThrow(() => process.kill(Number(read(base)), 0));
  write(base, String(dead)); first.release(); first.release();
  assert.equal(read(base), String(dead));
  assert.equal(process.listenerCount('exit'), listeners);
  const second = acquireLockSync(`${base}.gen`, options);
  first.release(); assert.equal(read(base), String(process.pid));
  second.release(); second.release();
  assert.equal(fs.existsSync(base), false);
  assert.equal(process.listenerCount('exit'), listeners);
  const script = h.write('config-lock-exit.mjs', `import fs from 'node:fs';
import { acquireLockSync } from ${url('locks.mjs')};
const base = ${JSON.stringify(base)};
acquireLockSync(base + '.gen', { waitMs: 1000, legacy: { base, format: 'pid' }, busy: () => { throw new Error('busy'); } });
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
  const options = { waitMs: 75, legacy: { base, format: 'pid' }, busy: () => { throw new Error(MESSAGES.zh.configLockTimeout(base)); } };
  assert.throws(() => acquireLockSync(`${base}.gen`, options), { message: MESSAGES.zh.configLockTimeout(base) });
  assert.equal(read(base), 'broken');
  const old = new Date(Date.now() - 2100); fs.utimesSync(base, old, old);
  const lock = acquireLockSync(`${base}.gen`, options);
  assert.equal(read(base), String(process.pid));
  lock.release();
  assert.equal(fs.existsSync(base), false); assert.equal(fs.existsSync(`${base}.reap`), false);
});

test('旧锁写进去后才报错（关闭时 EIO），释放时照样按归属删掉，进程活着也能再拿到锁', (t) => {
  const h = sandbox(t);
  for (const format of ['pid', 'json']) {
    const dir = path.join(h.home, `lock-eio-${format}`); fs.mkdirSync(dir, { recursive: true });
    const base = path.join(dir, 'config.json.structure.lock'), legacy = format === 'pid' ? { base, format: 'pid' } : base;
    const busy = () => { throw new Error('busy'); };
    const write = fs.writeFileSync;
    let failed = false;
    fs.writeFileSync = (file, ...rest) => {
      const out = write(file, ...rest);
      if (file === base && !failed) { failed = true; throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO' }); }
      return out;
    };
    try { assert.throws(() => acquireLockSync(`${base}.gen`, { waitMs: 200, legacy, busy }), { code: 'EIO' }); }
    finally { fs.writeFileSync = write; }
    assert.equal(failed, true);
    assert.equal(fs.existsSync(base), false, format);
    const again = acquireLockSync(`${base}.gen`, { waitMs: 200, legacy, busy });
    assert.equal(fs.existsSync(base), true);
    again.release();
    assert.equal(fs.existsSync(base), false);
  }
});
