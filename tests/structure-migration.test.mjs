import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plannedSandbox as sandbox, output, failed, read, json, write, CODEX, OPENCODE, ROOT, baseConfig, seedRun, taskArgs, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;
const aliases = (h) => path.join(path.dirname(h.userConfig), 'agent-aliases.json');
const legacyConfig = () => JSON.parse(read(path.join(ROOT, 'tests/fixtures/legacy-config.json')));

test('真实结构迁移按模型改名并逐格保留模型和强度，备份和别名完整', async (t) => {
  const h = sandbox(t), old = legacyConfig();
  h.config(old);
  const original = read(h.userConfig);
  const r = await h.bridge(['config'], { env: { CODEX_BIN: CODEX } }), c = output(r);
  const map = { codex: 'gpt-6-astra', deepseek: 'deepseek-flash', kimi: 'kimi-k2.6', mimo: 'mimo-v2.6-pro' };
  assert.deepEqual(Object.keys(c.effective.agents), Object.values(map));
  assert.deepEqual(json(aliases(h)), map);
  assert.equal(read(`${h.userConfig}.bak`), original);
  for (const [name, agent] of Object.entries(old.agents)) {
    assert.equal(c.effective.agents[map[name]].type, name === 'codex' ? 'codex cli' : 'api');
    assert.equal(c.effective.agents[map[name]].model, agent.model);
  }
  for (const [mode, levels] of Object.entries(old.levels)) for (const [lv, entry] of Object.entries(levels)) {
    const expected = (item) => ({ agent: map[item.agent], model: old.agents[item.agent].model, effort: item.effort, required: false });
    assert.deepEqual(c.resolved_modules[mode][lv], entry === 'claude' ? 'claude code' : Array.isArray(entry) ? entry.map(expected) : [expected(entry)]);
  }
  assert.ok(r.stderr.includes(M.configStructureMigrated(h.userConfig, `${h.userConfig}.bak`, M.list(Object.entries(map).map(([a, b]) => `${a} → ${b}`)))));
  const next = await h.bridge(['config'], { env: { CODEX_BIN: CODEX } });
  assert.equal(next.stderr, '');
  assert.equal(json(h.userConfig).agents.codex, undefined);
});

test('旧部分等级先继承，模型覆盖拆分且清除覆盖字段', async (t) => {
  const h = sandbox(t);
  h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'base-model' } }, levels: {
    run: { normal: { model: 'run-model' }, complex: { agent: 'codex', model: 'explicit-model' } }, review: { complex: { model: 'review-model' } },
    discuss: { normal: { model: 'discussion-model' } },
  } });
  const c = output(await h.bridge(['config']));
  for (const [mode, lv, model, effort] of [['run', 'normal', 'run-model', 'high'], ['run', 'complex', 'explicit-model', 'max'], ['review', 'complex', 'review-model', 'max'], ['discuss', 'normal', 'discussion-model', 'high']]) {
    assert.deepEqual(c.resolved_modules[mode][lv][0], { agent: model, model, effort, required: false });
    assert.equal(c.effective.agents[model].bin, CODEX);
    assert.equal(c.effective.modules[mode][lv][0].model, undefined);
  }
  assert.deepEqual(c.resolved_modules.review.simple, [{ agent: 'base-model', model: 'base-model', effort: 'medium', required: false }]);
  seedRun(h, '20000101-split', { agent: 'codex', agent_type: 'codex', model: 'run-model', status: 'timeout' });
  const response = await h.bridge(['resume', '--run', '20000101-split', '--level', 'normal', '--agent', 'codex', '--brief', '-', '--no-snapshot']);
  const resumed = output(response);
  assert.equal(resumed.agent, 'run-model');
  assert.equal(resumed.model, 'run-model');
  assert.ok(response.stderr.includes(M.legacyAgentAlias('codex', 'run-model')));
});

test('同名配置合并，冲突按类型和序号区分，保留已按模型命名的代号', async (t) => {
  const h = sandbox(t), api = { type: 'openai-compatible', base_url: 'http://127.0.0.1:1', model: 'shared' };
  h.config({ agents: { first: { ...api, max_parallel: 2 }, shared: api, equal: { model: 'shared', base_url: api.base_url, type: api.type },
    other: { ...api, max_parallel: 3 }, oc: { type: 'opencode', bin: OPENCODE, model: 'vendor/shared' },
    codex: { type: 'codex', bin: CODEX, model: 'a/b:c' } },
    levels: { discuss: { normal: [{ agent: 'shared', effort: 'high' }, { agent: 'equal', effort: 'high' }] } } });
  const c = output(await h.bridge(['config'])), a = json(aliases(h));
  assert.equal(a.equal, 'shared');
  assert.equal(a.first, 'shared-api');
  assert.equal(a.other, 'shared-api-2');
  assert.equal(a.oc, 'shared-opencode');
  assert.equal(a.codex, 'a-b-c');
  assert.equal(a.shared, undefined);
  assert.equal(Object.keys(c.effective.agents).length, 5);
  assert.deepEqual(c.effective.modules.discuss.normal, [{ agent: 'shared', effort: 'high' }]);
});

for (const model of ['toml-model', null]) test(`Codex 未写模型时${model ? '使用 TOML 顶层模型命名' : '保留原代号'}`, async (t) => {
  const h = sandbox(t);
  write(path.join(h.env.CODEX_HOME, 'config.toml'), `${model ? `model = '${model}'\n` : ''}[profiles.test]\nmodel = 'ignored'\n`);
  h.config({ agents: { codex: { type: 'codex', bin: CODEX } } });
  const c = output(await h.bridge(['config']));
  assert.deepEqual(Object.keys(c.effective.agents), [model || 'codex']);
  assert.equal(c.resolved_modules.review.simple[0].model, model);
});

test('项目旧代号与部分字段只在内存转换，别名跨迁移合并', async (t) => {
  const h = sandbox(t);
  h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'first' } } });
  output(await h.bridge(['config']));
  const next = json(h.userConfig);
  next.agents.first.type = 'codex';
  next.agents.first.model = 'second';
  h.config(next);
  const project = h.write('.claude/foreman.json', { levels: { review: { normal: { agent: 'codex', effort: 'low' }, complex: { effort: 'high' } } } });
  const before = read(project), c = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.equal(c.resolved_modules.review.normal[0].agent, 'second');
  assert.equal(c.resolved_modules.review.normal[0].effort, 'low');
  assert.equal(c.resolved_modules.review.complex[0].effort, 'high');
  assert.equal(read(project), before);
  assert.equal(fs.existsSync(`${project}.bak`), false);
  assert.deepEqual(json(aliases(h)), { codex: 'first', first: 'second' });
});

test('结构迁移并发只备份和提示一次，验证失败不覆盖原文件', async (t) => {
  const h = sandbox(t);
  h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'parallel' } } });
  const original = read(h.userConfig), results = await Promise.all(Array.from({ length: 4 }, () => h.bridge(['config'])));
  for (const r of results) assert.deepEqual(Object.keys(output(r).effective.agents), ['parallel']);
  assert.equal(results.filter((r) => r.stderr.includes('改成新写法')).length, 1);
  assert.equal(read(`${h.userConfig}.bak`), original);
  assert.deepEqual(json(aliases(h)), { codex: 'parallel' });
  const unwritable = sandbox(t);
  unwritable.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'memory-only' } } });
  const retained = read(unwritable.userConfig);
  fs.mkdirSync(`${unwritable.userConfig}.structure.lock`);
  const memory = await unwritable.bridge(['config']);
  assert.equal(output(memory).resolved_modules.review.normal[0].agent, 'memory-only');
  assert.ok(memory.stderr.includes('本次在内存里按新结构读取'));
  assert.equal(read(unwritable.userConfig), retained);
  const bad = sandbox(t);
  bad.config({ agents: { codex: { type: 'codex', bin: CODEX } }, levels: { review: { normal: { effort: 'invalid' } } } });
  const before = read(bad.userConfig), r = await bad.bridge(['config']);
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes('本次在内存里按新结构读取'));
  assert.equal(read(bad.userConfig), before);
  assert.equal(fs.existsSync(`${bad.userConfig}.bak`), false);
});

test('结构迁移锁正被删除时报 EPERM、EACCES、EBUSY 只是稍等再试，删残留锁和释放时都不会删掉别的进程拿到的锁', async (t) => {
  for (const mode of ['short', 'always', 'replaced', 'taken']) await t.test(mode, async (t) => {
    const h = sandbox(t), lock = `${h.userConfig}.structure.lock`;
    h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'parallel' } } });
    const original = read(h.userConfig);
    if (mode === 'short' || mode === 'replaced') write(lock, '2147483647');
    const script = h.write('structure-lock-transient.mjs', `import fs from 'node:fs';
import { loadConfig } from ${JSON.stringify(url('config.mjs'))};
import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
const lock = ${JSON.stringify(lock)}, mode = process.argv[2], newcomer = String(process.ppid);
const calls = { writeFileSync: 0, readFileSync: 0, rmSync: 0 }, errors = [];
const originals = Object.fromEntries(Object.keys(calls).map((name) => [name, fs[name]]));
let ownerReads = 0, removedNew = 0;
for (const name of Object.keys(calls)) {
  fs[name] = (file, ...args) => {
    if (file === lock) {
      const n = calls[name]++;
      if (mode === 'replaced' && name === 'rmSync') {
        // 删残留锁第一次失败时，新持有者已经拿到了锁，重试前要重新确认。
        if (n === 0) {
          originals.rmSync(lock, { force: true }); originals.writeFileSync(lock, newcomer);
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
        if (originals.readFileSync(lock, 'utf8') === newcomer) removedNew++;
      }
      if ((mode === 'always' && name === 'writeFileSync') || (mode === 'short' && n % 2 === 0)) {
        const code = mode === 'always' ? 'EPERM' : ['EPERM', 'EACCES', 'EBUSY'][errors.length % 3];
        errors.push([name, code]); throw Object.assign(new Error(code), { code });
      }
    }
    const value = originals[name](file, ...args);
    if (file === lock && mode === 'replaced' && name === 'readFileSync' && value === newcomer && ++ownerReads === 3) originals.rmSync(lock, { force: true });
    return value;
  };
}
// 持有锁期间别的进程拿走了锁（写进了它的 pid）：释放时要留给它。
if (mode === 'taken') { const copy = fs.copyFileSync; fs.copyFileSync = (...args) => { originals.writeFileSync(lock, newcomer); return copy(...args); }; }
loadConfig(null, adapters);
console.log(JSON.stringify({ calls, errors, removedNew }));`);
    const result = await h.start(script, [mode], { timeout: 15000 }).done, r = output(result);
    if (mode === 'always') {
      assert.ok(result.stderr.includes(M.configMigrateFailed(h.userConfig, 'EPERM')), result.stderr);
      assert.equal(read(h.userConfig), original); assert.equal(fs.existsSync(`${h.userConfig}.bak`), false);
      assert.ok(r.calls.writeFileSync > 1, JSON.stringify(r.calls));
      return;
    }
    if (mode === 'replaced') assert.equal(r.removedNew, 0);
    assert.deepEqual(Object.keys(json(h.userConfig).agents), ['parallel']);
    assert.ok(fs.existsSync(`${h.userConfig}.bak`));
    assert.ok(result.stderr.includes(M.configStructureMigrated(h.userConfig, `${h.userConfig}.bak`, M.list(['codex → parallel']))), result.stderr);
    assert.equal(result.stderr.includes('本次在内存里按新结构读取'), false);
    if (mode === 'taken') assert.equal(read(lock), String(process.pid));
    else assert.equal(fs.existsSync(lock), false);
    if (mode === 'short') {
      for (const name of Object.keys(r.calls)) assert.ok(r.errors.some(([fn]) => fn === name), name);
      assert.deepEqual([...new Set(r.errors.map(([, code]) => code))].sort(), ['EACCES', 'EBUSY', 'EPERM']);
    }
  });
});

test('旧类型和旧代号在 status、watch、resume 及并发准入中继续可用', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: discussion }]);
  const old = { agents: { codex: { type: 'codex', bin: CODEX, model: 'renamed', max_parallel: 1 },
    oc: { type: 'opencode', bin: OPENCODE, model: 'fake/model' },
    api: { type: 'openai-compatible', base_url: api.url, model: 'remote', api_key: 'synthetic-test-key' } },
    levels: { discuss: { complex: [{ agent: 'oc', effort: null }, { agent: 'api', effort: null }] } } };
  h.config(old);
  output(await h.bridge(['config']));
  for (const [id, type, name, kind] of [['20000101-oldest', undefined, undefined, 'exec'], ['20000101-codex', 'codex', 'codex', 'exec'], ['20000101-oc', 'opencode', 'oc', 'discuss'], ['20000101-api', 'openai-compatible', 'api', 'discuss']]) {
    const dir = seedRun(h, id, { agent: name, agent_type: type, kind, mode: kind === 'exec' ? 'run' : 'discuss', status: 'timeout' });
    if (name === 'api') write(path.join(dir, 'messages.json'), [{ role: 'user', content: 'old discussion' }]);
    assert.equal(output(await h.bridge(['status', '--run', id])).agent_type, type);
    const watch = await h.bridge(['watch', '--run', id, '--verbose']);
    assert.equal(watch.code, 0, watch.stderr);
    assert.ok(watch.stdout.includes(type === 'opencode' ? 'opencode CLI' : type === 'openai-compatible' ? 'API' : 'Codex CLI'));
    const r = output(await h.bridge(['resume', '--run', id, '--level', 'complex', '--brief', '-', '--no-snapshot']));
    assert.equal(r.agent, name === 'oc' ? 'model' : name === 'api' ? 'remote' : 'renamed');
    assert.equal(r.agent_type, type === 'opencode' ? 'opencode cli' : type === 'openai-compatible' ? 'api' : 'codex cli');
  }
  const explicit = await h.bridge(taskArgs(h, 'run', ['--agent', 'codex', '--no-snapshot']));
  assert.equal(output(explicit).agent, 'renamed');
  assert.ok(explicit.stderr.includes(M.legacyAgentAlias('codex', 'renamed')));
  seedRun(h, '20000101-active', { agent: 'codex', agent_type: 'codex', status: 'running', pid: process.pid });
  failed(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--queue-timeout', '0'])), M.agentFull('renamed', 1, 1, '20000101-active'));
  const list = await h.bridge(['status']);
  assert.equal(list.code, 0, list.stderr);
  for (const channel of ['Codex CLI', 'opencode CLI', 'API']) assert.ok(list.stdout.includes(channel));
});
