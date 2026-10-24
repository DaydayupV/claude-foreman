import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const FILES = ['index.html', 'server.mjs', 'stream-worker.js', 'feed.mjs', 'claude-feed.mjs', 'universe.mjs', '../prices.mjs', '../prices.json', 'lock.mjs'];

export function buildId(dir) {
  const hash = createHash('sha256');
  for (const file of FILES) {
    try { hash.update(fs.readFileSync(path.join(dir, file))); } catch { /* 缺失文件不参与版本计算 */ }
  }
  return hash.digest('hex').slice(0, 16);
}

// 同一批文件的大小和修改时间：服务每次自查时比一下，变了才重算 buildId（不用每次都读 2 MB 的页面）
export function buildStamp(dir) {
  return FILES.map((file) => {
    try { const st = fs.statSync(path.join(dir, file)); return `${st.size}:${st.mtimeMs}`; } catch { return '-'; }
  }).join(' ');
}
