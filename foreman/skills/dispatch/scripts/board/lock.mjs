// 看板单例锁的文件操作：服务端认领和 board 子命令回收残留锁共用。
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

// Windows 上别的进程正读着锁文件时改名、删除会短暂失败，重试几次
export function retryFile(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code) || i >= 8) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// 只回收内容和 expected 完全一样的锁：先改名到唯一的临时名再核对，避免删掉别人刚写的新锁
export function removeLock(file, expected) {
  if (expected === undefined) return false;
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try { retryFile(() => fs.renameSync(file, temp)); }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  let same = false;
  try {
    same = fs.readFileSync(temp, 'utf8') === expected;
    if (!same) {
      // link 只在原位置为空时放回，不能覆盖另一进程刚建立的锁。原位置已经有新锁（EEXIST）时，
      // 被移走的那份锁的服务会在下一次自查时发现锁不是自己的而退出（server.mjs 的 holdsLock）。
      // 不支持硬链接的盘（exFAT、网络盘）上 link 会失败，这时原位置还空着就改名放回。
      try { retryFile(() => fs.linkSync(temp, file)); }
      catch (e) { if (e.code !== 'EEXIST' && !fs.existsSync(file)) retryFile(() => fs.renameSync(temp, file)); }
    }
    return same;
  } finally { retryFile(() => fs.rmSync(temp, { force: true })); }
}
