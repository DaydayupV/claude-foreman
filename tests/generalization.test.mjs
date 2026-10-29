import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plannedSandbox as sandbox, output, failed, json, write, baseConfig, apiAgent, opencodeAgent, CODEX, OPENCODE, PI, ROOT, BRIDGE, MESSAGES, DEFAULT_SEATS } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
import { discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const modes = ['run', 'review', 'discuss'], levels = ['simple', 'normal', 'complex'];
const self = () => ({ ...Object.fromEntries(modes.map((mode) => [mode, Object.fromEntries(levels.map((lv) => [lv, 'claude code']))])), image: { generate: null, draw: null } });
const args = (h, mode, rest = []) => [mode, '--cwd', h.cwd, '--brief', '-', ...(mode === 'run' ? ['--no-snapshot'] : []), ...rest];

test('多个 Codex、无 Codex 和三类能力表，省略强度与缺失 gap 的配置', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents['second.1'] = { type: 'codex cli', bin: CODEX };
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.agents.oc = opencodeAgent();
  c.modules.default = { run: { complex: { agent: 'second.1' } }, discuss: { normal: [{ agent: 'api' }, { agent: 'oc' }] } };
  h.config(c);
  const out = output(await h.bridge(['config']));
  // oc 没写 run_access：派不了执行任务，能力里也不列 run
  for (const [name, isolation, reads, native, supported] of [['codex', 'os', true, true, modes], ['oc', 'tools', true, false, ['review', 'discuss']], ['api', 'none', false, false, ['discuss', 'review']]]) {
    assert.deepEqual(out.agents_status[name].capabilities, { modes: supported, isolation, reads_code: reads, reads_images: native, native_schema: native,
      native_review: native, images: native, resume: true, command_start_events: native });
  }
  assert.equal(out.codex, undefined);
  assert.deepEqual(out.resolved_modules.run.complex, [{ agent: 'second.1', model: null, effort: null, required: false, tier: null }]);
  assert.equal(out.resolved_modules.review.normal, 'claude code');
  h.config({ agents: { api: c.agents.api }, modules: { default: self() } });
  assert.deepEqual(Object.keys(output(await h.bridge(['config'])).effective.agents), ['api']);
  h.config({ agents: {} });
  const modules = self();
  for (const mode of ['discuss', 'review']) modules[mode].seats = DEFAULT_SEATS[mode];
  modules.review.gap = { simple: false, normal: false, complex: true };
  assert.deepEqual(output(await h.bridge(['config'])).effective.modules.default, modules);
});

test('协作方代号允许点号，拒绝保留字和非法首字符', async (t) => {
  const h = sandbox(t);
  for (const name of ['claude', 'claude code', '.bad', '-bad', 'with space']) {
    h.config({ agents: { [name]: { type: 'codex cli', bin: CODEX } } });
    failed(await h.bridge(['config']), M.configInvalid(`agents.${name}`, M.invalid.agentName));
  }
});

for (const mode of modes) test(`${mode} 的 Claude 等级、点名分派与 effort 选择`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules = { default: self() };
  h.config(c);
  const opts = mode === 'discuss' ? { env: h.scenario({ last_message: discussion }).env } : {};
  failed(await h.bridge(args(h, mode, ['--level', 'simple']), opts), mode === 'run' ? M.levelForClaude('simple') : M.discussReviewNeedsPlan(mode));
  failed(await h.bridge(args(h, mode, ['--level', 'simple', '--model', 'override']), opts), mode === 'run' ? M.levelForClaude('simple') : M.discussReviewNeedsPlan(mode));
  for (const [i, level] of levels.entries()) {
    const r = output(await h.bridge(args(h, mode, ['--level', level, '--agent', 'codex']), opts));
    assert.equal(r.effort, ['medium', 'high', 'max'][i]);
    assert.equal(r.agent_type, 'codex cli');
  }
  failed(await h.bridge(args(h, mode, ['--effort', 'low']), opts), mode === 'run' ? M.missingLevel('simple / normal / complex') : M.discussReviewNeedsPlan(mode));
  c.agents.second = { ...c.agents.codex };
  h.config(c);
  failed(await h.bridge(args(h, mode, ['--effort', 'high']), opts), mode === 'run' ? M.missingLevel('simple / normal / complex') : M.discussReviewNeedsPlan(mode));
  failed(await h.bridge(args(h, mode, ['--level', 'simple', '--effort', 'high']), opts), mode === 'run' ? M.levelForClaude('simple') : M.discussReviewNeedsPlan(mode));
  const entry = { agent: 'second' };
  c.modules.default[mode].normal = mode === 'discuss' ? [entry] : entry;
  h.config(c);
  const r = output(await h.bridge(args(h, mode, ['--level', 'normal', '--effort', 'low']), opts));
  assert.equal(r.agent, 'second');
  assert.equal(r.effort, 'low');
  const omitted = output(await h.bridge(args(h, mode, ['--level', 'normal']), opts));
  assert.equal(omitted.effort, null);
  assert.ok(!h.calls().filter((call) => call.operation === 'exec').at(-1).args.some((arg) => arg.includes('model_reasoning_effort')));
  h.config({ agents: {}, modules: { default: self() } });
  failed(await h.bridge(args(h, mode, ['--effort', 'high']), opts), mode === 'run' ? M.missingLevel('simple / normal / complex') : M.discussReviewNeedsPlan(mode));
});

test('opencode 未授权时不能执行、API 不能执行，Claude 等级点名时不传强度', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: discussion }, { answer: discussion }]), c = baseConfig();
  c.agents = { oc: opencodeAgent(), api: apiAgent(api.url) };
  c.modules = { default: self() };
  for (const name of ['oc', 'api']) {
    h.config(c);
    const r = output(await h.bridge(args(h, 'discuss', ['--level', 'simple', '--agent', name])));
    assert.equal(r.effort, null);
    for (const mode of ['run']) {
      h.config(c);
      const error = name === 'oc' ? M.runAccessRequired(name, 'opencode cli') : M.modeNotSupported(name, c.agents[name].type, mode, M.list(['discuss', 'review']));
      failed(await h.bridge(args(h, mode, ['--level', 'simple', '--agent', name])), error);
      h.config({ ...c, modules: { default: { [mode]: { normal: { agent: name } } } } });
      failed(await h.bridge(['config']), error);
    }
    h.config({ ...c, modules: { default: { discuss: { normal: [{ agent: name }] } } } });
    assert.equal(output(await h.bridge(args(h, 'discuss', ['--level', 'normal']))).effort, null);
  }
  assert.ok(api.requests.every((r) => !Object.hasOwn(r.body, 'reasoning_effort')));
  assert.ok(h.calls().filter((r) => r.tool === 'opencode' && r.operation === 'run').every((r) => r.args[r.args.indexOf('-m') + 1] === 'fake/model'));
});

test('讨论多参与方需要选择，未知代号和非法 Codex 强度被拒绝', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.second = { ...c.agents.codex };
  c.modules.default.discuss.normal.push({ agent: 'second' });
  h.config(c);
  failed(await h.bridge(args(h, 'discuss', ['--level', 'normal'])), M.discussReviewNeedsPlan('discuss'));
  failed(await h.bridge(args(h, 'discuss', ['--level', 'normal', '--effort', 'low'])), M.discussReviewNeedsPlan('discuss'));
  failed(await h.bridge(args(h, 'run', ['--effort', 'high', '--agent', 'missing'])), M.unknownAgentFlag('missing'));
  failed(await h.bridge(args(h, 'run', ['--level', 'complex', '--effort', 'invalid', '--agent', 'codex'])), M.effortChoices('low / medium / high / xhigh / max / ultra'));
  for (const effort of [null, 'invalid']) {
    c.modules.default.run.complex[0].effort = effort;
    h.config(c);
    failed(await h.bridge(['config']), M.configInvalid('modules.default.run.complex[0].effort', M.invalid.effortValue(effort, 'low / medium / high / xhigh / max / ultra')));
  }
});

test('check 无协作方、未引用失败和已引用失败，以及只检查指定协作方', async (t) => {
  const h = sandbox(t), c = baseConfig();
  h.config({ agents: {} });
  assert.equal(output(await h.bridge(['check'])).ok, true);
  c.agents.api = { ...apiAgent('http://127.0.0.1:1'), api_key: '' };
  c.agents.broken = { type: 'codex cli', bin: path.join(h.home, 'missing.exe') };
  h.config(c);
  let r = output(await h.bridge(['check']));
  assert.equal(r.codex, undefined);
  assert.equal(r.agents.broken.ok, false);
  assert.equal(r.agents.api.ok, false);
  assert.equal(r.agents.codex.type, 'codex cli');
  const before = h.calls().length;
  r = output(await h.bridge(['check', '--agent', 'api']));
  assert.deepEqual(Object.keys(r.agents), ['api']);
  assert.equal(h.calls().length, before);
  c.modules.default.discuss.normal = [{ agent: 'api' }];
  h.config(c);
  assert.equal(output(await h.bridge(['check']), 1).ok, false);
  assert.equal(output(await h.bridge(['check', '--agent', 'api']), 1).ok, false);
});

test('项目整格替换候选、必选、模型和强度，可以打开格子并延长时长', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.second = { ...c.agents.codex };
  c.agents.api = apiAgent('http://127.0.0.1:1');
  c.modules.default.discuss.normal = [{ agent: 'codex', effort: 'high', required: true }, { agent: 'api', effort: null }];
  h.config(c);
  h.write('.claude/foreman.json', { modules: { default: { run: { complex: { agent: 'second' } } } } });
  let replaced = await h.bridge(['config', '--cwd', h.cwd]);
  assert.deepEqual(output(replaced).effective.modules.default.run.complex, [{ agent: 'second' }]);
  assert.equal(replaced.stderr, '');
  h.write('.claude/foreman.json', { agents: { codex: { model: 'ignored-model' } }, dispatch: { discuss_max_rounds: 5, timeout_min: 2, stall_min: 3, busy_ask_min: 4, auto: false }, modules: { default: {
    run: { simple: { agent: 'codex' } }, review: { simple: 'claude code', normal: { agent: 'codex', effort: 'low', model: 'project-model' }, complex: { agent: 'codex' } },
    discuss: { simple: 'claude code', normal: [{ agent: 'api', effort: 'low', model: 'project-model' }, { agent: 'second', required: true }] },
  } } });
  const r = await h.bridge(['config', '--cwd', h.cwd]), out = output(r).effective;
  assert.equal(out.agents.codex.model, 'fake-codex');
  assert.equal(out.dispatch.auto, true);
  assert.deepEqual([out.dispatch.discuss_max_rounds, out.dispatch.timeout_min, out.dispatch.stall_min, out.dispatch.busy_ask_min], [5, 2, 3, 4]);
  assert.deepEqual(out.modules.default.run, { ...c.modules.default.run, simple: [{ agent: 'codex' }] });
  assert.equal(out.modules.default.review.simple, 'claude code');
  assert.deepEqual(out.modules.default.review.normal, [{ agent: 'codex', effort: 'low', model: 'project-model' }]);
  assert.deepEqual(out.modules.default.review.complex, [{ agent: 'codex' }]);
  assert.deepEqual(out.modules.default.discuss.normal, [{ agent: 'api', effort: 'low', model: 'project-model' }, { agent: 'second', required: true }]);
  assert.equal(r.stderr, `foreman: ${M.projectIgnored(M.list(['agents', 'dispatch.auto']))}\n`);
  h.write('.claude/foreman.json', { modules: { default: { discuss: { normal: [{ agent: 'second' }] } } } });
  replaced = await h.bridge(['config', '--cwd', h.cwd]);
  assert.deepEqual(output(replaced).effective.modules.default.discuss.normal, [{ agent: 'second' }]);
  assert.equal(replaced.stderr, '');
});

for (const scenario of ['nothing', 'codex', 'opencode', 'pi', 'api', 'all', 'logged-out', 'empty-models']) test(`环境检测和初始配置显式关闭补漏：${scenario}`, async (t) => {
  const h = sandbox(t, { config: false }), codex = ['codex', 'all', 'logged-out'].includes(scenario), oc = ['opencode', 'all', 'empty-models'].includes(scenario), pi = ['pi', 'all'].includes(scenario);
  const available = codex && scenario !== 'logged-out', keys = ['api', 'all'].includes(scenario) ? ['DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'MIMO_API_KEY'] : [];
  const s = h.scenario({ logged_in: available, models: scenario === 'empty-models' ? [] : ['fake/model', 'fake/second'],
    pi_catalog: [{ provider: 'fake', id: 'model' }, { provider: 'fake', id: 'second' }, { provider: 'fake', id: 'third' }] });
  const adapterUrl = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters/index.mjs')).href;
  const script = h.write('detect.mjs', `import { adapters } from ${JSON.stringify(adapterUrl)};
adapters['codex cli'].locate = () => ({ file: ${JSON.stringify(codex ? process.execPath : path.join(h.home, 'missing-codex.exe'))}, pre: ${JSON.stringify(codex ? [CODEX] : [])} });
adapters['opencode cli'].locate = () => ({ file: ${JSON.stringify(oc ? process.execPath : path.join(h.home, 'missing-opencode.exe'))}, pre: ${JSON.stringify(oc ? [OPENCODE] : [])} });
adapters['pi cli'].locate = () => ({ file: ${JSON.stringify(pi ? process.execPath : path.join(h.home, 'missing-pi.exe'))}, pre: ${JSON.stringify(pi ? [PI] : [])} });
adapters['agy cli'].locate = () => ({ file: ${JSON.stringify(path.join(h.home, 'missing-agy.exe'))}, pre: [] });
process.argv.splice(2, 0, 'config');
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const env = { ...s.env, ...Object.fromEntries(keys.map((key) => [key, 'synthetic-key'])) };
  const r = await h.start(script, [], { env }).done, c = output(r), cfg = json(h.userConfig);
  assert.equal(c.image_configured, true);
  assert.deepEqual(c.environment, { codex: { found: codex, logged_in: available }, opencode: { found: oc, models: oc && scenario !== 'empty-models' ? 2 : 0 }, pi: { found: pi, models: pi ? 3 : 0 }, agy: { found: false, models: 0 }, api_keys: keys });
  assert.deepEqual(Object.keys(cfg.agents), [...(available ? ['gpt-6.1-sol', 'gpt-6-astra'] : []), ...(keys.length ? ['deepseek-v4-pro', 'kimi-k2.6', 'mimo-v2.6-pro'] : [])]);
  assert.equal(cfg.modules.default.run.simple, 'claude code');
  assert.equal(cfg.modules.default.run.normal, 'claude code');
  if (available) {
    assert.deepEqual(cfg.modules.default.run.complex, [{ agent: 'gpt-6.1-sol', effort: 'max' }]);
    for (const [i, lv] of levels.entries()) {
      const item = { agent: i === 2 ? 'gpt-6-astra' : 'gpt-6.1-sol', effort: ['medium', 'high', 'max'][i] };
      assert.deepEqual(cfg.modules.default.review[lv], [item]);
      assert.deepEqual(cfg.modules.default.discuss[lv], [item]);
    }
    assert.deepEqual(cfg.modules.default.image, { generate: [{ agent: 'gpt-6.1-sol', effort: 'medium' }], draw: [{ agent: 'gpt-6-astra', effort: 'max' }] });
  } else {
    const expected = self();
    for (const module of ['discuss', 'review']) expected[module].seats = DEFAULT_SEATS[module];
    expected.review.gap = { simple: false, normal: false, complex: false };
    assert.deepEqual(cfg.modules.default, expected);
  }
  for (const module of ['discuss', 'review']) assert.deepEqual(cfg.modules.default[module].seats, DEFAULT_SEATS[module]);
  assert.deepEqual(cfg.modules.default.review.gap, { simple: false, normal: false, complex: false });
  assert.equal(Object.hasOwn(cfg.dispatch, 'max_seats'), false);
  if (keys.length) assert.equal(cfg.agents['kimi-k2.6'].api_key_env, 'KIMI_API_KEY');
  let parts = available ? M.starterCodex('gpt-6.1-sol', 'gpt-6-astra') : M.starterNoCodex;
  if (oc && scenario !== 'empty-models') parts += M.starterOpencode(2);
  if (pi) parts += M.starterPi(3);
  if (keys.length) parts += M.starterApi('DeepSeek、Kimi、MiMo');
  assert.ok(r.stderr.includes(M.starterCreated(h.userConfig, parts + M.starterNext)));
  const before = s.calls().length;
  output(await h.start(script, [], { env }).done);
  assert.ok(s.calls().every((call) => ['version', 'login', 'models', 'list-models'].includes(call.operation)));
  if (codex || oc || pi) assert.ok(s.calls().length > before);
  // 列模型前 pi 会加载扩展，环境检测也要带隔离参数
  for (const call of s.calls().filter((c) => c.tool === 'pi' && c.operation === 'list-models')) assert.ok(call.args.includes('--no-extensions') && call.args.includes('--no-approve'));
});

test('只设置 MOONSHOT_API_KEY 生成一个 Kimi，配置输出不泄露 key', async (t) => {
  const h = sandbox(t, { config: false });
  const r = await h.bridge(['config'], { env: { MOONSHOT_API_KEY: 'synthetic-moonshot-key' } }), c = output(r);
  assert.deepEqual(Object.keys(c.effective.agents), ['kimi-k2.6']);
  assert.equal(c.effective.agents['kimi-k2.6'].api_key_env, 'MOONSHOT_API_KEY');
  assert.ok(!r.stdout.includes('synthetic-moonshot-key'));
});

test('环境检测在 30 秒截止，opencode models 超时按无可用模型处理', async (t) => {
  const h = sandbox(t), s = h.scenario({ models_delay_ms: 35000 });
  const scripts = path.join(ROOT, 'foreman/skills/dispatch/scripts');
  const probe = h.write('timeout.mjs', `import { adapters } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'adapters/index.mjs')).href)};
import { detectEnvironment } from ${JSON.stringify(pathToFileURL(path.join(scripts, 'config.mjs')).href)};
adapters['codex cli'].locate = () => ({ file: ${JSON.stringify(path.join(h.home, 'missing.exe'))}, pre: [] });
adapters['opencode cli'].locate = () => ({ file: process.execPath, pre: [${JSON.stringify(OPENCODE)}] });
console.log(JSON.stringify(detectEnvironment(adapters)));`);
  const r = output(await h.start(probe, [], { env: s.env, timeout: 40000 }).done);
  assert.deepEqual(r.opencode, { found: true, models: 0 });
  assert.deepEqual(s.calls().map((call) => call.operation), ['version', 'models']);
});

test('无协作方的中英文会话提醒只建议 setup，并读取旧位置配置', async (t) => {
  for (const lang of ['foreman', 'foreman-en']) for (const old of [false, true]) {
    const h = sandbox(t, { config: false }), file = old ? path.join(h.home, '.claude/codex-bridge.json') : h.userConfig;
    write(file, { agents: {}, modules: { default: self() } });
    const hook = path.join(ROOT, lang, 'hooks/session-reminder.mjs');
    const context = output(await h.start(hook, [], { input: JSON.stringify({ cwd: h.cwd }) }).done).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(`/${lang}:setup`));
    assert.ok(context.includes(file));
    assert.ok(!context.includes(':dispatch'));
    if (old) assert.equal(fs.existsSync(h.userConfig), false);
  }
});

test('续接到 "claude code" 的等级时必须给等级并点名，推理强度只做覆盖', async (t) => {
  const h = sandbox(t);
  h.config(baseConfig());
  const first = output(await h.bridge(args(h, 'run', ['--level', 'complex'])));
  const resume = ['resume', '--run', first.run_id, '--brief', '-', '--reason', 'rework', '--no-snapshot'];
  failed(await h.bridge([...resume, '--level', 'normal']), M.levelForClaude('normal'));
  const named = output(await h.bridge([...resume, '--level', 'normal', '--agent', 'codex']));
  assert.equal(named.agent, 'codex');
  assert.equal(named.effort, 'high');
  failed(await h.bridge(['resume', '--run', named.run_id, '--brief', '-', '--reason', 'rework', '--no-snapshot', '--effort', 'low']), M.missingLevel('simple / normal / complex'));
  // 续接只能接最新的一轮，所以从 named 接着续
  assert.equal(output(await h.bridge(['resume', '--run', named.run_id, '--brief', '-', '--reason', 'rework', '--no-snapshot', '--level', 'normal', '--agent', 'codex', '--effort', 'low'])).effort, 'low');
});
