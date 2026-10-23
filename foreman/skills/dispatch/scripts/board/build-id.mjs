import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function buildId(dir) {
  const hash = createHash('sha256');
  for (const file of ['index.html', 'server.mjs', 'feed.mjs', 'claude-feed.mjs', 'universe.mjs', '../prices.mjs', '../prices.json', 'lock.mjs']) {
    try { hash.update(fs.readFileSync(path.join(dir, file))); } catch { /* 缺失文件不参与版本计算 */ }
  }
  return hash.digest('hex').slice(0, 16);
}
