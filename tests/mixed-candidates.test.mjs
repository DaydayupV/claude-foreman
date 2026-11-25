import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, output, failed, json, read, write, ROOT, MESSAGES } from './helpers.mjs';

const M = MESSAGES.zh;
const host = { agent: 'claude code', host: true };
const scripts = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const url = (file) => pathToFileURL(path.join(scripts, file)).href;
const run = (h, level, ...extra) => ['run', '--cwd', h.cwd, '--level', level, '--brief', '-', '--no-snapshot', ...extra];
const plan = (h, agent) => ['plan', '--cwd', h.cwd, '--module', 'run', '--cell', 'complex', '--group', 'mixed', '--seat', agent];

test('混合候选保留顺序和外部档位，单个主持方对象和整格 self 按主持方处理', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.default.discuss.simple = 'self';
  c.modules.default.review.simple = 'self';
  c.modules.default.run = { simple: 'self', normal: { agent: 'self' }, complex: [{ agent: 'codex', effort: 'low' }, { agent: 'self' }] };
  c.modules.draft = { run: { complex: [{ agent: 'claude code' }, { agent: 'codex', effort: 'high', required: true }] } };
  h.config(c);
  write(path.join(path.dirname(h.userConfig), 'preferences.md'), '<!-- foreman:scenes -->\n- **draft**：合成场景\n<!-- /foreman:scenes -->\n');

  const original = read(h.userConfig), result = output(await h.bridge(['config']));
  assert.deepEqual(result.resolved_modules.run, {
    simple: 'claude code', normal: 'claude code',
    complex: [{ agent: 'codex', model: 'fake-codex', effort: 'low', required: false, tier: null }, host],
  });
  assert.equal(result.resolved_modules.discuss.simple, 'claude code');
  assert.equal(result.resolved_modules.review.simple, 'claude code');
  assert.deepEqual(result.resolved_scenes.draft.run.complex, [host, { agent: 'codex', model: 'fake-codex', effort: 'high', required: true, tier: null }]);
  assert.deepEqual(result.summary.modules.run.complex[1], host);
  assert.equal(Object.hasOwn(result.summary.agents, 'claude code'), false);
  assert.equal(read(h.userConfig), original);

  const inspect = h.write('resolve-host.mjs', `import { loadConfig, resolveCell } from ${JSON.stringify(url('config.mjs'))};
import { adapters } from ${JSON.stringify(url('adapters/index.mjs'))};
const cfg = loadConfig(null, adapters);
console.log(JSON.stringify(['normal', 'complex'].map((cell) => resolveCell(cfg, 'run', cell))));`);
  const [closed, mixed] = output(await h.start(inspect).done);
  assert.deepEqual([closed.closed, closed.candidates, mixed.closed, mixed.candidates, mixed.required],
    [true, [], false, [{ agent: 'codex', effort: 'low', required: false }, host], []]);

  const md = await h.bridge(['config', '--format', 'md']);
  assert.equal(md.code, 0, md.stderr);
  assert.ok(md.stdout.includes('| Claude Code（主持方） | — | — | 候选 |'), md.stdout);
  assert.ok(md.stdout.includes('Claude Code（主持方）、codex · high ★'), md.stdout);
  assert.deepEqual(output(await h.bridge(['tiers'])).models.map(({ name }) => name), ['fake-codex']);
});

test('校验拒绝其他模块的主持方条目、条目多余字段、重复和保留代号', async (t) => {
  const h = sandbox(t);
  for (const [module, cell] of [['discuss', 'simple'], ['review', 'normal'], ['image', 'generate']]) {
    const c = baseConfig();
    c.modules.default[module][cell] = [{ agent: 'self' }];
    h.config(c);
    failed(await h.bridge(['config']), M.hostEntryModule(`modules.default.${module}.${cell}`));
  }
  const c = baseConfig(), key = 'modules.default.run.simple';
  c.modules.default.image.draw = 'self';
  h.config(c);
  failed(await h.bridge(['config']), M.configInvalid('modules.default.image.draw', M.invalid.imageCandidates));
  c.modules.default.image.draw = null;
  c.modules.default.run.simple = { agent: 'self', effort: 'low', model: 'example', required: false, extra: null };
  h.config(c);
  failed(await h.bridge(['config']), M.hostEntryFields(key, 'effort、model、required、extra'));
  c.modules.default.run.simple = [{ agent: 'claude code' }, { agent: 'self' }];
  h.config(c);
  failed(await h.bridge(['config']), M.hostEntryDuplicate(key));
  c.modules.default.run.simple = 'self';
  c.agents.self = { ...c.agents.codex };
  h.config(c);
  failed(await h.bridge(['config']), M.configInvalid('agents.self', M.invalid.agentName));
});

test('单席只从外部候选自动选，run 和 plan 拒绝派主持方', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.other = { ...c.agents.codex, model: 'other-model' };
  c.modules.default.run = {
    simple: [{ agent: 'self' }],
    normal: [{ agent: 'claude code' }, { agent: 'codex' }],
    complex: [{ agent: 'self' }, { agent: 'codex' }, { agent: 'other', effort: 'high', required: true }],
  };
  h.config(c);
  for (const name of ['claude code', 'self']) {
    failed(await h.bridge(run(h, 'normal', '--agent', name)), M.hostNotDispatchable);
    failed(await h.bridge(plan(h, name)), M.hostNotDispatchable);
  }
  failed(await h.bridge(run(h, 'simple')), M.levelForClaude('simple'));
  assert.deepEqual(h.records(), []);
  assert.equal(fs.existsSync(path.join(h.runs, 'plans')), false);

  assert.equal(output(await h.bridge(run(h, 'normal'))).agent, 'codex');
  assert.equal(output(await h.bridge(run(h, 'complex'))).agent, 'other');
  const p = output(await h.bridge(plan(h, 'other')));
  assert.deepEqual(p.seats, [{ seat: 1, agent: 'other', role: null, model: 'other-model', effort: 'high', required: true }]);
  assert.equal(p.host, undefined);
});

test('外部候选手写了 host 字段时照常是外部候选', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.default.run.normal = [{ agent: 'codex', host: true }];
  c.modules.default.run.complex = [{ agent: 'codex', host: true }];
  h.config(c);
  assert.equal(output(await h.bridge(run(h, 'normal'))).agent, 'codex');
  assert.deepEqual(output(await h.bridge(plan(h, 'codex'))).seats.map(({ agent }) => agent), ['codex']);
});

test('已有迁移写出规范主持方代号，layout 保留原写法、内容和键顺序', async (t) => {
  const h = sandbox(t);
  for (const cmd of ['config', 'layout']) {
    const c = baseConfig();
    if (cmd === 'config') c.dispatch.watch = 'off';
    c.modules.default.discuss.simple = 'self';
    c.modules.default.run.complex = [{ agent: 'self' }, { agent: 'codex' }];
    c.modules.draft = { run: { normal: { agent: 'self' } } };
    h.config(c);
    const original = read(h.userConfig), result = output(await h.bridge([cmd]));
    const saved = json(h.userConfig);
    if (cmd === 'config') {
      assert.equal(saved.modules.default.discuss.simple, 'claude code');
      assert.deepEqual(saved.modules.default.run.complex, [{ agent: 'claude code' }, { agent: 'codex' }]);
      assert.equal(saved.modules.draft.run.normal, 'claude code');
    } else {
      assert.equal(result.files[0].changed, true);
      assert.equal(JSON.stringify(saved), JSON.stringify(JSON.parse(original)));
    }
    assert.equal(read(cmd === 'layout' ? result.files[0].backup : `${h.userConfig}.bak`), original);
  }
});
