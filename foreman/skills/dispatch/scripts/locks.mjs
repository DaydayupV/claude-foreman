// 代号最大的是当前锁，只靠独占创建和建成后的代号核对判定归属。
// 释放留下 done 标记；只删自己过时的新文件和更低的代，避免按旧读数删掉新锁。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pidExists, retryBusy, sleep } from './util.mjs';

const noHardLinks = new Set();
// 文件系统确实不支持硬链接时报的错；EPERM / EACCES / EBUSY 在 Windows 上也可能只是目标正被删除，先当作暂时的。
const LINK_UNSUPPORTED = ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'], LINK_BUSY = ['EPERM', 'EACCES', 'EBUSY'];

const ownerOf = (file, format) => {
  try {
    const text = retryBusy(() => fs.readFileSync(file, 'utf8'));
    return format === 'pid' ? { pid: Number(text) } : JSON.parse(text);
  }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};
const stat = (file) => {
  try { return retryBusy(() => fs.statSync(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

function* acquireLegacy(base, token, deadline, busy, { format } = {}) {
  const reap = `${base}.reap`, content = JSON.stringify({ pid: process.pid, token });
  const legacyOwner = (file) => { const value = ownerOf(file, file === base ? format : undefined); return typeof value === 'number' ? { pid: value } : value; };
  const stale = (file) => {
    const pid = legacyOwner(file)?.pid;
    return (format === 'pid' ? Number.isInteger(pid) && pid > 0 : pid) ? !pidExists(pid)
      : Date.now() - (stat(file)?.mtimeMs ?? Date.now()) > (format === 'pid' ? 2000 : 10000);
  };
  const mine = (file) => ownerOf(file)?.token === token;
  let delay = 25;
  for (;;) {
    const final = Date.now() >= deadline;
    // 旧版用 Number(内容) 判断持有者，配置旧锁必须写纯 pid。
    try { retryBusy(() => fs.writeFileSync(base, format === 'pid' ? String(process.pid) : content, { flag: 'wx' })); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (final) busy({ file: base, pid: legacyOwner(base)?.pid ?? null });
      if (stale(base)) {
        let created = false;
        try {
          try { retryBusy(() => fs.writeFileSync(reap, content, { flag: 'wx' })); created = true; }
          catch (error) { if (error.code !== 'EEXIST') throw error; retryBusy(() => fs.rmSync(reap, { force: true }), () => stale(reap)); }
          if (mine(reap)) retryBusy(() => fs.rmSync(base, { force: true }), () => stale(base) && mine(reap));
          if (created) retryBusy(() => fs.rmSync(reap, { force: true }), () => mine(reap));
        } catch (error) { if (created) retryBusy(() => fs.rmSync(reap, { force: true })); throw error; }
      }
      yield delay; delay = Math.min(200, delay * 2);
    }
  }
}

function* acquire(base, { waitMs, busy, legacy = false }) {
  const dir = path.dirname(base), prefix = `${path.basename(base)}.`;
  const legacyBase = typeof legacy === 'object' ? legacy.base : typeof legacy === 'string' ? legacy : base;
  const format = legacy.format;
  const linkDir = path.resolve(dir);
  const token = randomUUID(), deadline = Date.now() + waitMs;
  const content = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
  const tmp = `${base}.${process.pid}.${token}.tmp`;
  const entries = () => retryBusy(() => fs.readdirSync(dir)).flatMap((name) => {
    const suffix = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    const match = /^([1-9][0-9]*)(\.done)?$/.exec(suffix);
    const temp = /^([1-9][0-9]*)\.[^.]+\.tmp$/.exec(suffix);
    return match ? [{ name, generation: BigInt(match[1]) }] : temp ? [{ name, pid: Number(temp[1]) }] : [];
  });
  const latest = (files) => files.reduce((g, entry) => entry.generation > g ? entry.generation : g, 0n);
  // 读失败仍按占用处理；残缺 JSON 与读失败分开，才可回收 wx 写到一半的残留。
  const generationOwner = (file) => { try { return ownerOf(file); } catch { return {}; } };
  const blocked = (file, owner = generationOwner(file)) => busy({ file, pid: owner?.pid ?? null });
  let delay = 25;
  for (;;) {
    // 到期后仍准许这一轮创建一次，三个失败出口都直接报 busy。
    const final = Date.now() >= deadline;
    const listed = entries(), g = latest(listed), current = `${base}.${g}`;
    const owner = g > 0n ? generationOwner(current) : null;
    // 内容残缺（没有硬链接时先建文件再写内容，写到一半）的锁，过了 10 秒、而且没有还活着的写入者（它的临时文件还在）才回收：
    // 写入者只是卡住了，恢复后会写完，不能被抢
    const writing = listed.some((entry) => entry.pid && pidExists(entry.pid));
    // 持有者还在（包括没权限探测的）就一直等；进程号被别的程序复用时也等到上限，由报错提示用户手工删锁，
    // 不拿墙钟时间去猜进程身份：时钟一跳就可能把活着的持有者误判成已复用。
    const vacant = g === 0n || owner === undefined || stat(`${current}.done`) || owner?.pid && !pidExists(owner.pid)
      || owner === null && !writing && Date.now() - (stat(current)?.mtimeMs ?? Date.now()) > 10000;
    if (!vacant) {
      if (final) blocked(current, owner);
      yield delay; delay = Math.min(200, delay * 2);
      continue;
    }
    const generation = g + 1n, file = `${base}.${generation}`;
    let created = false, released = false, legacyHeld = false;
    const release = () => {
      if (released) return;
      released = true;
      process.removeListener('exit', release);
      try {
        if (legacyHeld) retryBusy(() => fs.rmSync(legacyBase, { force: true }), () => {
          const owner = ownerOf(legacyBase, format);
          return format === 'pid' ? owner?.pid === process.pid : owner?.token === token;
        });
      } finally {
        if (created) {
          try { retryBusy(() => fs.writeFileSync(`${file}.done`, '', { flag: 'wx' })); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
      }
    };
    try {
      try {
        retryBusy(() => fs.writeFileSync(tmp, content, { flag: 'wx' }));
        // 暂时的错误短暂重试几次：EPERM 一直不消失才当作不支持硬链接，EACCES / EBUSY 一直不消失就算这一轮没抢到。
        for (let attempt = 0; !created && !noHardLinks.has(linkDir); attempt++) {
          try { fs.linkSync(tmp, file); created = true; }
          catch (error) {
            if (LINK_UNSUPPORTED.includes(error.code) || error.code === 'EPERM' && attempt >= 3) { noHardLinks.add(linkDir); break; }
            if (!LINK_BUSY.includes(error.code) || attempt >= 3) throw error;
            yield 25;
          }
        }
        if (!created) retryBusy(() => fs.writeFileSync(file, content, { flag: 'wx' }));
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST' && !LINK_BUSY.includes(error.code)) throw error;
      } finally { retryBusy(() => fs.rmSync(tmp, { force: true })); }
      if (!created) { if (final) blocked(file); yield delay; delay = Math.min(200, delay * 2); continue; }
      const after = entries();
      if (latest(after) > generation) {
        retryBusy(() => fs.rmSync(file, { force: true }));
        created = false;
        if (final) blocked(`${base}.${latest(after)}`);
        continue;
      }
      process.once('exit', release);
      // 清理旧代号和死进程的临时文件只是顺手做的：删不掉（Windows 上正被占用）就留给下一个拿锁的，不能让这次拿锁失败
      for (const entry of after) if (entry.generation < generation || entry.pid && !pidExists(entry.pid)) {
        try { retryBusy(() => fs.rmSync(path.join(dir, entry.name), { force: true })); } catch { /* 留给下一次 */ }
      }
      // 编号锁把新版本的回收者串行化，持有它之后才碰旧锁和 .reap。
      if (legacy) { yield* acquireLegacy(legacyBase, token, deadline, busy, { format }); legacyHeld = true; }
      return { release, file };
    } catch (error) { release(); throw error; }
  }
}

export async function acquireLock(base, options) {
  const steps = acquire(base, options);
  let step = steps.next();
  while (!step.done) { await sleep(step.value); step = steps.next(); }
  return step.value;
}

export function acquireLockSync(base, options) {
  const steps = acquire(base, options), pause = new Int32Array(new SharedArrayBuffer(4));
  let step = steps.next();
  while (!step.done) { Atomics.wait(pause, 0, 0, step.value); step = steps.next(); }
  return { release: step.value.release };
}
