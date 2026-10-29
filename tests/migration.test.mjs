import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, read, write, baseConfig, BRIDGE, ROOT, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;

function legacy(h, meta = { status: 'done', pid: 0 }) {
  const root = path.join(h.home, '.claude/codex-runs');
  write(path.join(root, 'synthetic-old/meta.json'), { id: 'synthetic-old', ...meta });
  write(path.join(root, 'synthetic-old/result.json'), { status: 'done', summary: '合成旧记录' });
  write(path.join(root, 'watch.mjs'), '// synthetic old launcher\n');
  return root;
}

test('旧配置和偏好复制到新位置后补写 gap，旧文件与备份保留原文', async (t) => {
  const h = sandbox(t, { config: false }), c = baseConfig(); delete c.modules.default.review.gap; c.modules = c.modules.default;
  const oldConfig = write(path.join(h.home, '.claude/codex-bridge.json'), c);
  const oldPrefs = write(path.join(h.home, '.claude/codex-bridge.md'), '合成用户偏好\n');
  const configText = read(oldConfig), prefsText = read(oldPrefs);
  const r = await h.bridge(['config']);
  output(r);
  assert.deepEqual(JSON.parse(read(h.userConfig)).modules.default.review.gap, { simple: false, normal: false, complex: true });
  assert.equal(read(`${h.userConfig}.bak`), configText);
  assert.equal(read(path.join(h.home, '.claude/foreman/preferences.md')), prefsText);
  assert.equal(read(oldConfig), configText);
  assert.equal(read(oldPrefs), prefsText);
  assert.ok(r.stderr.includes(M.legacyConfigCopied(oldConfig, h.userConfig)));
  assert.ok(r.stderr.includes(M.legacyPrefsCopied(oldPrefs, path.join(h.home, '.claude/foreman/preferences.md'))));
  assert.ok(r.stderr.includes(M.configGapWritten(h.userConfig, `${h.userConfig}.bak`)));
  assert.ok(r.stderr.includes(M.configScenesWritten(h.userConfig, `${h.userConfig}.bak`)));
  assert.equal((await h.bridge(['config'])).stderr, '');
});

test('平铺写法的旧配置缺 gap 时只备份补写一次，改写失败在内存补齐并清理锁；场景写法缺 gap 按全关、不改写', async (t) => {
  {
    const h = sandbox(t), c = baseConfig(); delete c.modules.default.review.gap; h.config(c);
    const before = read(h.userConfig), r = await h.bridge(['config']);
    assert.deepEqual(output(r).resolved_modules.review.gap, { simple: false, normal: false, complex: false });
    assert.equal(r.stderr, ''); assert.equal(read(h.userConfig), before);
  }
  for (const denied of [false, true]) {
    const h = sandbox(t), c = baseConfig(); delete c.modules.default.review.gap; c.modules = c.modules.default; h.config(c);
    const original = read(h.userConfig);
    const file = h.write('gap-migrate.mjs', `import fs from 'node:fs';
import { loadConfig } from ${JSON.stringify(url('config.mjs'))};
import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
const rename = fs.renameSync;
if (${denied}) fs.renameSync = (from, to) => {
  if (to === ${JSON.stringify(h.userConfig)}) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  return rename(from, to);
};
console.log(JSON.stringify([loadConfig(null, adapters), loadConfig(null, adapters)]));`);
    const r = await h.start(file).done, [first, second] = output(r);
    assert.deepEqual(first, second);
    assert.deepEqual(first.modules.review.gap, { simple: false, normal: false, complex: true });
    assert.equal(read(`${h.userConfig}.bak`), original);
    if (denied) {
      assert.equal(read(h.userConfig), original);
      assert.equal(r.stderr, `foreman: ${M.configMigrateFailed(h.userConfig, 'EACCES')}\n`);
    } else {
      assert.ok(r.stderr.includes(M.configGapWritten(h.userConfig, `${h.userConfig}.bak`)), r.stderr);
      assert.ok(r.stderr.includes(M.configScenesWritten(h.userConfig, `${h.userConfig}.bak`)), r.stderr);
      assert.deepEqual(JSON.parse(read(h.userConfig)).modules.default.review.gap, first.modules.review.gap);
      assert.equal((await h.bridge(['config'])).stderr, '');
    }
    assert.equal(fs.readdirSync(path.dirname(h.userConfig)).some((name) => name.endsWith('.lock') || name.endsWith('.tmp')), false);
  }
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

test('记录目录搬迁锁正被删除时报 EPERM、EACCES、EBUSY 只是稍等再试，删残留锁和释放时都不会删掉别的进程拿到的锁', async (t) => {
  for (const mode of ['short', 'always', 'replaced', 'taken']) await t.test(mode, async (t) => {
    const h = sandbox(t), old = legacy(h), lock = path.join(h.home, '.claude/foreman/.migrate.lock');
    const original = ['synthetic-old/meta.json', 'synthetic-old/result.json', 'watch.mjs'].map((file) => [file, read(path.join(old, file))]);
    if (mode === 'short' || mode === 'replaced') write(lock, '2147483647');
    const script = h.write('migration-lock-transient.mjs', `import fs from 'node:fs';
import { defaultRunsRoot } from ${JSON.stringify(url('config.mjs'))};
const lock = ${JSON.stringify(lock)}, mode = process.argv[2], newcomer = String(process.ppid);
const calls = { writeFileSync: 0, readFileSync: 0, rmSync: 0 }, errors = [];
const originals = Object.fromEntries(Object.keys(calls).map((name) => [name, fs[name]]));
if (mode === 'short' || mode === 'replaced') Atomics.wait = () => 'timed-out';
for (const name of Object.keys(calls)) {
  fs[name] = (file, ...args) => {
    if (file === lock) {
      const n = calls[name]++;
      // 删残留锁第一次失败时，新持有者已经拿到锁并搬完目录。
      if (mode === 'replaced' && name === 'rmSync' && n === 0) {
        originals.rmSync(lock, { force: true }); originals.writeFileSync(lock, newcomer);
        fs.renameSync(${JSON.stringify(old)}, ${JSON.stringify(h.runs)});
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      if ((mode === 'always' && name === 'writeFileSync') || (mode === 'short' && n % 2 === 0)) {
        const code = mode === 'always' ? 'EPERM' : ['EPERM', 'EACCES', 'EBUSY'][errors.length % 3];
        errors.push([name, code]); throw Object.assign(new Error(code), { code });
      }
    }
    return originals[name](file, ...args);
  };
}
// 持有锁期间别的进程拿走了锁（写进了它的 pid）：释放时要留给它。
if (mode === 'taken') { const rename = fs.renameSync; fs.renameSync = (...args) => { originals.writeFileSync(lock, newcomer); return rename(...args); }; }
console.log(JSON.stringify({ root: defaultRunsRoot(), calls, errors }));`);
    const result = await h.start(script, [mode], { timeout: 15000 }).done, r = output(result);
    if (mode === 'always') {
      assert.equal(r.root, old);
      assert.ok(result.stderr.includes(M.runsMoveFailed(old, 'EPERM')), result.stderr);
      for (const [file, text] of original) assert.equal(read(path.join(old, file)), text);
      assert.deepEqual(fs.readdirSync(old).sort(), ['synthetic-old', 'watch.mjs']);
      assert.deepEqual(fs.readdirSync(path.join(old, 'synthetic-old')).sort(), ['meta.json', 'result.json']);
      assert.ok(r.calls.writeFileSync > 1, JSON.stringify(r.calls));
      return;
    }
    assert.equal(r.root, h.runs);
    if (mode === 'replaced') {
      assert.equal(fs.existsSync(lock), true); assert.equal(read(lock), String(process.pid));
      return;
    }
    assert.ok(result.stderr.includes(M.runsMoved(old, h.runs)), result.stderr);
    assert.equal(result.stderr.includes(M.runsMoveFailed(old, '').split('（')[0]), false);
    assert.equal(fs.existsSync(old), false);
    for (const [file, text] of original) assert.equal(read(path.join(h.runs, file)), text);
    if (mode === 'taken') { assert.equal(read(lock), String(process.pid)); return; }
    assert.equal(fs.existsSync(lock), false);
    for (const name of Object.keys(r.calls)) assert.ok(r.errors.some(([fn]) => fn === name), name);
    assert.deepEqual([...new Set(r.errors.map(([, code]) => code))].sort(), ['EACCES', 'EBUSY', 'EPERM']);
  });
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
  assert.equal(c.effective.modules.default.review.normal[0].effort, 'low');
  assert.deepEqual(c.loaded_from, [h.userConfig, config]);
  assert.deepEqual(c.preferences[1], { file: prefs, exists: true });
  for (const [old, name] of [[config, 'foreman.json'], [prefs, 'foreman.md']]) {
    assert.ok(r.stderr.includes(M.projectLegacyName(old, path.join(h.cwd, '.claude', name))));
    assert.ok(fs.existsSync(old));
  }
  assert.equal(fs.existsSync(path.join(h.cwd, '.claude/foreman.json')), false);
});
