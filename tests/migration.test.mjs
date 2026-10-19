import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, read, write, baseConfig, BRIDGE, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;

function legacy(h, meta = { status: 'done', pid: 0 }) {
  const root = path.join(h.home, '.claude/codex-runs');
  write(path.join(root, 'synthetic-old/meta.json'), { id: 'synthetic-old', ...meta });
  write(path.join(root, 'synthetic-old/result.json'), { status: 'done', summary: '合成旧记录' });
  write(path.join(root, 'watch.mjs'), '// synthetic old launcher\n');
  return root;
}

test('旧配置和旧偏好在第一次运行时复制到新位置，旧文件保留', async (t) => {
  const h = sandbox(t, { config: false });
  const oldConfig = write(path.join(h.home, '.claude/codex-bridge.json'), baseConfig());
  const oldPrefs = write(path.join(h.home, '.claude/codex-bridge.md'), '合成用户偏好\n');
  const configText = read(oldConfig), prefsText = read(oldPrefs);
  const r = await h.bridge(['config']);
  output(r);
  assert.equal(read(h.userConfig), configText);
  assert.equal(read(path.join(h.home, '.claude/foreman/preferences.md')), prefsText);
  assert.equal(read(oldConfig), configText);
  assert.equal(read(oldPrefs), prefsText);
  assert.ok(r.stderr.includes(M.legacyConfigCopied(oldConfig, h.userConfig)));
  assert.ok(r.stderr.includes(M.legacyPrefsCopied(oldPrefs, path.join(h.home, '.claude/foreman/preferences.md'))));
  assert.equal((await h.bridge(['config'])).stderr, '');
});

test('旧记录目录整体迁移并重写 watch 启动器', async (t) => {
  const h = sandbox(t), old = legacy(h);
  const original = read(path.join(old, 'synthetic-old/result.json'));
  const r = await h.bridge(['config']);
  assert.equal(output(r).runs_dir, h.runs);
  assert.equal(fs.existsSync(old), false);
  assert.equal(read(path.join(h.runs, 'synthetic-old/result.json')), original);
  assert.ok(read(path.join(h.runs, 'watch.mjs')).includes(JSON.stringify(BRIDGE)));
  assert.ok(r.stderr.includes(M.runsMoved(old, h.runs)));
  assert.equal(fs.existsSync(path.join(h.home, '.claude/foreman/.migrate.lock')), false);
});

test('旧目录里有活着的任务时延后迁移', async (t) => {
  const h = sandbox(t), old = legacy(h, { status: 'running', pid: process.pid });
  const r = await h.bridge(['config']);
  assert.equal(output(r).runs_dir, old);
  assert.ok(r.stderr.includes(M.runsMoveDeferred(old)));
  assert.equal(fs.existsSync(h.runs), false);
  assert.equal(read(path.join(old, 'watch.mjs')), '// synthetic old launcher\n');
});

test('四个进程同时启动只迁移一次且记录完整', async (t) => {
  const h = sandbox(t), old = legacy(h);
  const results = await Promise.all(Array.from({ length: 4 }, () => h.bridge(['config'])));
  for (const r of results) assert.equal(output(r).runs_dir, h.runs);
  assert.equal(results.filter((r) => r.stderr.includes(M.runsMoved(old, h.runs))).length, 1);
  assert.deepEqual(fs.readdirSync(h.runs).sort(), ['synthetic-old', 'watch.mjs']);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(h.home, '.claude/foreman/.migrate.lock')), false);
});

for (const source of ['配置', '环境变量']) {
  test(`用户通过${source}指定记录目录时不搬旧目录`, async (t) => {
    const h = sandbox(t), old = legacy(h), custom = path.join(h.home, 'custom-runs');
    const env = {};
    if (source === '配置') {
      const c = baseConfig();
      c.dispatch.runs_dir = custom;
      h.config(c);
    }
    else env.FOREMAN_RUNS_DIR = custom;
    assert.equal(output(await h.bridge(['config'], { env })).runs_dir, custom);
    assert.ok(fs.existsSync(path.join(old, 'synthetic-old/result.json')));
    assert.equal(fs.existsSync(h.runs), false);
  });
}

test('旧环境变量仍生效并提示改名', async (t) => {
  const h = sandbox(t, { config: false });
  const customConfig = write(path.join(h.home, 'legacy-env.json'), baseConfig());
  const customRuns = path.join(h.home, 'legacy-env-runs');
  const r = await h.bridge(['config'], { env: { CODEX_BRIDGE_CONFIG: customConfig, CODEX_RUNS_DIR: customRuns } });
  const c = output(r);
  assert.equal(c.user_config, customConfig);
  assert.equal(c.runs_dir, customRuns);
  assert.equal(fs.existsSync(h.userConfig), false);
  for (const [old, current] of [['CODEX_BRIDGE_CONFIG', 'FOREMAN_CONFIG'], ['CODEX_RUNS_DIR', 'FOREMAN_RUNS_DIR']]) {
    assert.equal(r.stderr.split(M.legacyEnv(old, current)).length - 1, 1);
  }
});

test('旧语言环境变量生效时也提示改名', async (t) => {
  const h = sandbox(t);
  const r = await h.bridge(['unknown-command'], { env: { FOREMAN_LANG: '', CODEX_BRIDGE_LANG: 'en' } });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes(MESSAGES.en.usage));
  assert.ok(r.stderr.includes(MESSAGES.en.legacyEnv('CODEX_BRIDGE_LANG', 'FOREMAN_LANG')));
});

test('项目里的旧配置和偏好文件名照常读取并提示改名', async (t) => {
  const h = sandbox(t);
  const config = h.write('.claude/codex-bridge.json', { levels: { review: { normal: { agent: 'codex', effort: 'low' } } } });
  const prefs = h.write('.claude/codex-bridge.md', '合成项目偏好');
  const r = await h.bridge(['config', '--cwd', h.cwd]), c = output(r);
  assert.equal(c.effective.modules.review.normal[0].effort, 'low');
  assert.deepEqual(c.loaded_from, [h.userConfig, config]);
  assert.deepEqual(c.preferences[1], { file: prefs, exists: true });
  for (const [old, name] of [[config, 'foreman.json'], [prefs, 'foreman.md']]) {
    assert.ok(r.stderr.includes(M.projectLegacyName(old, path.join(h.cwd, '.claude', name))));
    assert.ok(fs.existsSync(old));
  }
  assert.equal(fs.existsSync(path.join(h.cwd, '.claude/foreman.json')), false);
});
