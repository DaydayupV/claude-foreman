// 代号最大的是当前锁，只靠独占创建和建成后的代号核对判定归属。
// 释放留下 done 标记；只删自己过时的新文件和更低的代，避免按旧读数删掉新锁。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pidExists, retryBusy, sleep } from './util.mjs';

const noHardLinks = new Set();
// 文件系统确实不支持硬链接时报的错；EPERM / EACCES / EBUSY 在 Windows 上也可能只是目标正被删除，先当作暂时的。
const LINK_UNSUPPORTED = ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'], LINK_BUSY = ['EPERM', 'EACCES', 'EBUSY'];

const ownerOf = (file) => {
  try { return JSON.parse(retryBusy(() => fs.readFileSync(file, 'utf8'))); }
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
// 旧路径仍按 HEAD 的清理锁协议回收，和旧版共用同一套互斥。
async function acquireLegacy(base, token, deadline, busy) {
  const reap = `${base}.reap`, content = JSON.stringify({ pid: process.pid, token });
  const legacyOwner = (file) => { const value = ownerOf(file); return typeof value === 'number' ? { pid: value } : value; };
  const stale = (file) => {
    const owner = legacyOwner(file);
    return owner?.pid ? !pidExists(owner.pid) : Date.now() - (stat(file)?.mtimeMs ?? Date.now()) > 10000;
  };
  const mine = (file) => ownerOf(file)?.token === token;
  for (;;) {
    const final = Date.now() >= deadline;
    try { retryBusy(() => fs.writeFileSync(base, content, { flag: 'wx' })); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (final) busy({ file: base, pid: legacyOwner(base)?.pid ?? null });
      if (stale(base)) {
        try { retryBusy(() => fs.writeFileSync(reap, content, { flag: 'wx' })); }
        catch (error) { if (error.code !== 'EEXIST') throw error; retryBusy(() => fs.rmSync(reap, { force: true }), () => stale(reap)); }
        if (mine(reap)) {
          try { retryBusy(() => fs.rmSync(base, { force: true }), () => stale(base) && mine(reap)); }
          finally { retryBusy(() => fs.rmSync(reap, { force: true }), () => mine(reap)); }
        }
      }
      await sleep(25);
    }
  }
}

export async function acquireLock(base, { waitMs, busy, legacy = false }) {
  const dir = path.dirname(base), prefix = `${path.basename(base)}.`;
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
  // 代号锁读取失败也按占用处理，旧协议仍保留原来的读错误。
  const generationOwner = (file) => { try { return ownerOf(file); } catch { return null; } };
  const blocked = (file, owner = generationOwner(file)) => busy({ file, pid: owner?.pid ?? null });
  for (;;) {
    // 到期后仍准许这一轮创建一次，三个失败出口都直接报 busy。
    const final = Date.now() >= deadline;
    const g = latest(entries()), current = `${base}.${g}`;
    const owner = g > 0n ? generationOwner(current) : null;
    // 持有者还在（包括没权限探测的）就一直等；进程号被别的程序复用时也等到上限，由报错提示用户手工删锁，
    // 不拿墙钟时间去猜进程身份：时钟一跳就可能把活着的持有者误判成已复用。
    const vacant = g === 0n || owner === undefined || stat(`${current}.done`) || owner?.pid && !pidExists(owner.pid);
    if (!vacant) {
      if (final) blocked(current, owner);
      await sleep(25);
      continue;
    }
    const generation = g + 1n, file = `${base}.${generation}`;
    let created = false;
    try {
      retryBusy(() => fs.writeFileSync(tmp, content, { flag: 'wx' }));
      // 暂时的错误短暂重试几次：EPERM 一直不消失才当作不支持硬链接，EACCES / EBUSY 一直不消失就算这一轮没抢到。
      for (let attempt = 0; !created && !noHardLinks.has(linkDir); attempt++) {
        try { fs.linkSync(tmp, file); created = true; }
        catch (error) {
          if (LINK_UNSUPPORTED.includes(error.code) || error.code === 'EPERM' && attempt >= 3) { noHardLinks.add(linkDir); break; }
          if (!LINK_BUSY.includes(error.code) || attempt >= 3) throw error;
          await sleep(25);
        }
      }
      if (!created) retryBusy(() => fs.writeFileSync(file, content, { flag: 'wx' }));
      created = true;
    } catch (error) {
      if (error.code !== 'EEXIST' && !LINK_BUSY.includes(error.code)) throw error;
    } finally { retryBusy(() => fs.rmSync(tmp, { force: true })); }
    if (!created) { if (final) blocked(file); continue; }
    const after = entries();
    if (latest(after) > generation) {
      retryBusy(() => fs.rmSync(file, { force: true }));
      if (final) blocked(`${base}.${latest(after)}`);
      continue;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      process.removeListener('exit', release);
      try { if (legacy) retryBusy(() => fs.rmSync(base, { force: true }), () => ownerOf(base)?.token === token); }
      finally {
        try { retryBusy(() => fs.writeFileSync(`${file}.done`, '', { flag: 'wx' })); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    };
    process.once('exit', release);
    try {
      for (const entry of after) if (entry.generation < generation || entry.pid && !pidExists(entry.pid)) retryBusy(() => fs.rmSync(path.join(dir, entry.name), { force: true }));
      if (legacy) await acquireLegacy(base, token, deadline, busy);
      return { release, file };
    } catch (error) { release(); throw error; }
  }
}
