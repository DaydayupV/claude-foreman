import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// watch.mjs 只给 cli.mjs 引用：直接运行时要说清楚该用哪个入口，不能一声不响地退出
test('running scripts/watch.mjs directly explains which launcher to use and exits 2', () => {
  const file = fileURLToPath(new URL('../foreman/skills/dispatch/scripts/watch.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [file, '--group', 'g'], { encoding: 'utf8', env: { ...process.env, FOREMAN_LANG: 'en' }, windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /running it directly does nothing/);
  assert.match(r.stderr, /watch\.mjs" --group <group>/);
  assert.equal(r.stdout, '');
});
