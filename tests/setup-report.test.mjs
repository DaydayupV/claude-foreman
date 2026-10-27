// setup 固定报告和旧配置提醒：所有 CLI 调用都在临时用户目录里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, apiAgent, opencodeAgent, piAgent, output, failed, write, read, ROOT, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const entry = (agent, effort = null, required = false) => ({ agent, ...(effort == null ? {} : { effort }), required });
const catalogs = {
  codex_catalog: { models: [
    { slug: 'fake-codex', supported_reasoning_levels: ['low', 'medium', 'high'].map((effort) => ({ effort })), default_reasoning_level: 'medium', context_window: 272000, visibility: 'list' },
    { slug: 'hidden', supported_reasoning_levels: [], visibility: 'hide' },
  ] },
  opencode_catalog: [
    { providerID: 'beta', id: 'z', variants: [], limit: { context: 1050000 }, cost: [{ input: 0, output: 0 }] },
    { providerID: 'beta', id: 'a', variants: [{ id: 'low' }], limit: { context: 1000000 }, cost: [{ input: 0.1, output: 2 }] },
    { providerID: 'alpha', id: 'pipe|model', variants: [], limit: { context: 262144 } },
    { providerID: 'beta', id: 'disabled', enabled: false },
  ],
  models: ['beta/z', 'beta/a', 'alpha/pipe|model'],
  pi_catalog: [{ provider: 'alpha', id: 'pi', contextWindow: 1000000, reasoning: false, cost: { input: 1, output: 3 } }],
  last_message: 'OK',
};
const sampleConfig = (url) => {
  const c = baseConfig();
  c.agents = { a: { ...c.agents.codex, sandbox: { discuss: 'read-only', review: 'read-only' } },
    b: { ...opencodeAgent(), model: 'beta/z', run_access: 'edit' }, c: { ...piAgent(), model: 'alpha/missing', run_access: 'shell' },
    d: apiAgent(url), e: apiAgent(url) };
  c.modules.discuss = { simple: 'claude code', normal: [entry('a'), entry('b')], complex: [entry('b'), entry('a')], seats: { normal: 2 } };
  c.modules.review = { simple: [entry('a', 'max', true), entry('b'), entry('c')], normal: [entry('b', null, true), entry('a'), entry('c')], complex: [entry('a'), entry('b'), entry('c')] };
  c.modules.run = { simple: 'claude code', normal: [entry('b', null, true)], complex: [entry('c', 'high')] };
  c.modules.image = { generate: [entry('a', 'low')], draw: null };
  return c;
};
const markdown = async (h, args, options, code = 0) => {
  const r = await h.bridge([...args, '--format', 'md'], options);
  assert.equal(r.code, code, r.stderr + r.stdout); assert.ok(r.stdout.startsWith('## ')); return r.stdout;
};
const has = (text, parts) => { for (const part of parts) assert.ok(text.includes(part), part + '\n' + text); };
const scripts = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const isolated = (h, code, options) => h.start(write(path.join(h.home, 'inspect.mjs'), code), [], options).done;
const urlOf = (file) => pathToFileURL(path.join(scripts, file)).href;

test('config/check md 固定四张格子表、六种派法、权限和合并提醒，JSON 格式选择保持原输出', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{}], { models: ['fake-api', 'VOICE-TTS', 'embedding', 'asr', 'rerank', 'moderation'] });
  h.config(sampleConfig(api.url)); Object.assign(h.env, h.scenario(catalogs).env, { FOREMAN_TEST_MEMORY: '16,4' });
  const config = await markdown(h, ['config']);
  has(config, ['| 候选 | simple | normal | complex |', '| 候选 | 出图 generate | 手画 draw |',
    '| Claude Code | 不找外部模型 | — | — |', '| Claude Code | 自己做 | — | — |', '| （关掉） | — | 关掉 |', '| a | max ★ | 默认 | 默认 |',
    '| 讨论 simple | — | — | — | 不找外部模型 |', '| 讨论 normal | 2 | 2 | 0 | 2 个候选全上 |',
    '| 讨论 complex | 8 | 2 | 0 | 候选不够 8 个，2 个全上 |',
    '| 审查 simple | 1 | 3 | 1 | 只派必选的 a，其余 2 个候选在这一级用不上 |',
    '| 审查 normal | 2 | 3 | 1 | b，再从其余 2 个里挑 1 个 |', '| 审查 complex | 2 | 3 | 0 | 从 3 个候选里挑 2 个；剩下的候选可以做补漏席 |',
    '| a | codex cli | fake-codex | 讨论 N/C、审查 S/N/C、出图 | 不需要开启 |',
    'edit（只改项目里的文件，不能运行命令）', 'shell（还能运行命令，没有系统沙箱）',
    '- ℹ 2 个协作方没有用在任何格子里：d、e。', '- ⚠ d、e 的 API key 明文写在配置文件里', '- ⚠ c 开了 shell']);
  assert.equal(config.includes('| 检查 |'), false); assert.equal(config.includes('synthetic-test-key'), false);
  assert.equal((config.match(/^\| (讨论|审查) /gm) || []).length, 6);
  const check = await markdown(h, ['check'], undefined, 1);
  has(check, ['## 环境', M.reportEnvironmentOk, '| API key 环境变量 | 没有检测到（2 个 API 协作方的 key 写在配置文件里） |',
    '| 候选 | simple | normal | complex | 检查 |', '| 候选 | 出图 generate | 手画 draw | 检查 |', '| a | max ★ ⚠ | 默认 | 默认 | ⚠ |',
    '| b | 默认 | 默认 ★ | 默认 | ✅ |', '| c | 默认 | 默认 | 默认 | ❌ |', '- ❌ a：', '- ❌ c：', '- ❌ a 的 fake-codex 不支持 max：']);
  assert.equal(check.includes('- ❌ d：'), false); assert.equal(check.includes('synthetic-test-key'), false);
  for (const cmd of ['config', 'models']) assert.equal((await h.bridge([cmd])).stdout, (await h.bridge([cmd, '--format', 'json'])).stdout);
  const cfg = output(await h.bridge(['config']));
  assert.deepEqual(Object.keys(cfg), ['user_config', 'loaded_from', 'effective', 'agents_status', 'resolved_modules', 'closed_by_project', 'image_configured', 'runs_dir', 'watch_launcher', 'watch_launcher_ascii', 'preferences', 'environment', 'summary']);
  const before = output(await h.bridge(['check']), 1), after = output(await h.bridge(['check', '--format', 'json']), 1);
  for (const r of [before, after]) for (const agent of Object.values(r.agents)) delete agent.seconds;
  assert.deepEqual(before, after);
});

test('项目关掉的格子、显式 seats 展示、补漏轮和未配置图像', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only', review: 'read-only' };
  c.modules.run.normal = entry('codex'); h.config(c);
  h.write('.claude/foreman.json', { modules: { discuss: { seats: { normal: 4 } }, run: { normal: 'claude code' }, image: { generate: null } } });
  const md = await markdown(h, ['config', '--cwd', h.cwd]);
  has(md, ['| 讨论 simple | 2 |', '| 讨论 normal | 4 |', '| 讨论 complex | 8 |', '自己做（项目关掉）', '关掉（项目关掉）',
    '候选不够 2 个，1 个全上；补漏轮没有剩余模型，不做', '这些在用的模型不在价格表里，费用会显示为算不出：fake-codex']);
  delete c.modules.image; h.config(c);
  const noImage = await markdown(h, ['config']); has(noImage, ['图像\n\n图像两格还没配置。']); assert.equal(noImage.includes('出图 generate |'), false);
  c.modules.review.complex = [entry('codex'), entry('other')]; c.agents.other = { ...c.agents.codex }; h.config(c);
  has(await markdown(h, ['config']), ['2 个候选全上；补漏轮没有剩余模型，不做']);
});

test('格子单独指定的模型写在推理强度后面，3 级审查首轮没用上的候选可做补漏席', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.other = { ...c.agents.codex }; c.agents.third = { ...c.agents.codex };
  c.modules.run.complex = [{ agent: 'codex', effort: 'max', model: 'cell-only-model' }];
  c.modules.review.complex = [entry('codex', 'max', true), entry('other', null, true), entry('third')]; h.config(c);
  const md = await markdown(h, ['config']);
  has(md, ['| codex | — | — | max · cell-only-model |', '| 审查 complex | 2 | 3 | 2 | 只派必选的 codex、other，其余 1 个候选可以做补漏席 |']);
  assert.equal(md.includes('| codex | max ★ · '), false);
});

test('自定义配置文件时，旧备份按它的文件名找', async (t) => {
  const h = sandbox(t), dir = path.dirname(h.userConfig), file = path.join(dir, 'my.json');
  write(file, JSON.stringify(baseConfig())); write(path.join(dir, 'my.json.setup-1.bak'), '{}'); write(path.join(dir, 'config.json.other.bak'), '{}');
  const cfg = output(await h.bridge(['config'], { env: { FOREMAN_CONFIG: file } }));
  assert.equal(cfg.user_config, file); assert.deepEqual(cfg.summary.warnings.find((w) => w.kind === 'old_backups').files, ['my.json.setup-1.bak']);
});

test('协作方没开执行权限、只读审计和旧代号提醒按图标呈现', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.oc = opencodeAgent(); h.config(c);
  write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), { old: 'gone' });
  const md = await markdown(h, ['config']);
  has(md, ['| oc | opencode cli | fake/model | 没用上 | 未开启（可以开启 edit 或 shell） |', '- ⚠ codex 做', '- ⚠ 旧代号 old']);
  assert.equal(md.includes('agent-aliases.json 里有'), false);
});

test('models md 分组排序、默认档、上下文、价格、过滤和类型匹配', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [], { models: ['fake-api', 'VOICE-TTS', 'embedding', 'asr', 'rerank', 'moderation'] });
  h.config(sampleConfig(api.url)); Object.assign(h.env, h.scenario(catalogs).env);
  const md = await markdown(h, ['models']);
  has(md, ['共 7 个：Codex 1 个、opencode 3 个、pi 1 个、API 2 个接口共 2 个。',
    '| fake-codex | low / **medium** / high | 272K | a |', '### opencode · beta（2 个）', '### opencode · alpha（1 个）',
    '| a | low | 1M | $0.1 / $2 |  |', '| z | — 只能不写 | 1.05M | 免费 | b |', '| pipe\\|model | — 只能不写 | 262K | — |  |',
    '### pi · alpha（1 个）', '| pi | off | 1M | $1 / $3 |  |', '| d | fake-api | — | d |', '| e | fake-api | — | e |', '另有 10 个语音、向量等非对话模型没列出。', M.reportModelsNext]);
  assert.ok(md.indexOf('| a | low') < md.indexOf('| z |')); assert.equal(/hidden|disabled|VOICE-TTS/.test(md), false);
  const json = output(await h.bridge(['models'])); json.agents.same = { type: 'api', model: 'fake-codex' };
  json.tools['pi cli'].ok = false; json.tools['pi cli'].error = 'synthetic|error';
  const rendered = await isolated(h, `import { modelsReport } from ${JSON.stringify(urlOf('report.mjs'))}; console.log(modelsReport(${JSON.stringify(json)}));`);
  has(rendered.stdout, ['| fake-codex | low / **medium** / high | 272K | a |', 'pi：读不到模型清单（synthetic|error）']);
  assert.equal(rendered.stdout.includes('### pi ·'), false);
  const failedCatalog = await markdown(h, ['models'], { env: h.scenario({}).env }); has(failedCatalog, ['Codex：读不到模型清单（synthetic: no model catalog）', 'opencode：读不到模型清单', 'pi：读不到模型清单']);
});

test('四类旧配置提醒有结构化字段，追加在原提醒之后，只读且不泄漏 key', async (t) => {
  const h = sandbox(t), c = baseConfig(), dir = path.dirname(h.userConfig);
  c.dispatch.max_seats = 9; c.levels = 'old plugin note'; c.agents.api = { ...apiAgent('http://127.0.0.1:9'), api_key_env: 'SYNTHETIC_API_KEY' }; h.config(c);
  write(path.join(dir, 'config.json.first.bak'), '{"api_key":"synthetic-backup-secret"}');
  write(path.join(dir, 'config.json.second.bak-2026'), '{}'); fs.utimesSync(path.join(dir, 'config.json.first.bak'), 1, 1);
  write(path.join(dir, 'other.bak'), '{}'); write(path.join(dir, 'config.json.txt'), '{}');
  write(path.join(dir, 'agent-aliases.json'), { old: 'codex', codex: 'ignored' });
  const original = read(h.userConfig), originalAliases = read(path.join(dir, 'agent-aliases.json'));
  const r = await h.bridge(['config']), cfg = output(r), warnings = cfg.summary.warnings;
  assert.deepEqual(warnings.slice(-4).map((w) => w.kind), ['obsolete_max_seats', 'obsolete_key_env', 'old_backups', 'legacy_levels_note']);
  assert.equal(warnings.at(-4).value, 9); assert.deepEqual(warnings.at(-3), { kind: 'obsolete_key_env', agent: 'api', api_key_env: 'SYNTHETIC_API_KEY', env_set: false, message: M.reportObsoleteKeyEnv('api', 'SYNTHETIC_API_KEY') });
  assert.deepEqual(warnings.at(-2).files, ['config.json.first.bak', 'config.json.second.bak-2026']); assert.equal(warnings.at(-2).contain_keys, true);
  // 对照表也管项目配置里的旧代号和已完成旧任务的续接，不当成可删的残留。
  assert.equal(warnings.some((w) => w.kind === 'old_aliases'), false);
  assert.equal(cfg.effective.dispatch.max_seats, undefined); assert.equal(r.stdout.includes('synthetic-test-key'), false); assert.equal(r.stdout.includes('synthetic-backup-secret'), false);
  const withEnv = output(await h.bridge(['config'], { env: { SYNTHETIC_API_KEY: 'synthetic-env-secret' } })); assert.equal(withEnv.summary.warnings.find((w) => w.kind === 'obsolete_key_env').env_set, true);
  const md = await markdown(h, ['config']); for (const w of warnings.slice(-4)) has(md, [`- ℹ ${w.message}`]);
  assert.equal(read(h.userConfig), original); assert.equal(read(path.join(dir, 'agent-aliases.json')), originalAliases);
});

test('旧配置提醒不触发的分支，以及检测读取失败时跳过', async (t) => {
  const h = sandbox(t), dir = path.dirname(h.userConfig), c = baseConfig();
  c.agents.api = { type: 'api', base_url: 'http://127.0.0.1:9', model: 'fake-api', api_key_env: 'ONLY_ENV' }; h.config(c);
  write(path.join(dir, 'agent-aliases.json'), {}); write(path.join(dir, 'config.json.txt'), '{}');
  const kinds = (cfg) => cfg.summary.warnings.map((w) => w.kind);
  const absent = kinds(output(await h.bridge(['config'])));
  for (const kind of ['obsolete_max_seats', 'obsolete_key_env', 'old_backups', 'legacy_levels_note']) assert.equal(absent.includes(kind), false);
  write(path.join(dir, 'config.json.clean.bak'), '{}'); assert.equal(output(await h.bridge(['config'])).summary.warnings.find((w) => w.kind === 'old_backups').contain_keys, false);
  const result = await isolated(h, `import { readRawConfig, readOldBackups } from ${JSON.stringify(urlOf('config.mjs'))};
    import fs from 'node:fs'; const read = fs.readFileSync; fs.readFileSync = (file, ...args) => { if (String(file).endsWith('.bak') || String(file).endsWith('agent-aliases.json')) throw Error('synthetic read failure'); return read(file, ...args); };
    console.log(JSON.stringify([readRawConfig(${JSON.stringify(dir)}), readOldBackups()]));`);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), [null, null]);
});

test('环境故障逐项输出 fix，API 变量只显示名字，未使用 Codex 的沙箱失败不计入', async (t) => {
  const h = sandbox(t), broken = await h.bridge(['check', '--format', 'md'], { env: h.scenario({ sandbox_broken: true }).env });
  assert.equal(broken.code, 1); has(broken.stdout, ['⚠ Codex 沙箱（codex）：', 'windows sandbox failed']); assert.equal(broken.stdout.includes(M.reportEnvironmentOk), false);
  const cfg = output(await h.bridge(['config'])), checks = { node: { ok: false, fix: 'node fix' }, git: { ok: false, fix: 'git fix' }, watch: { ok: false, fix: 'watch fix' },
    memory: { total_gb: 16, available_gb: 4, enough: true, web: false },
    agents: { codex: { type: 'codex cli', fix: 'unused sandbox', sandbox: { checked: [{ ok: false }] } } }, summary: { agents: { codex: { used_at: [] } } } };
  const env = { codex: { found: true, logged_in: false }, opencode: { found: false }, pi: { found: false }, api_keys: ['KIMI_API_KEY', 'MIMO_API_KEY'] };
  const r = await isolated(h, `import { environmentReport } from ${JSON.stringify(urlOf('report.mjs'))}; console.log(environmentReport(${JSON.stringify(checks)}, ${JSON.stringify(env)}, ${JSON.stringify(cfg.effective.agents)}));`);
  has(r.stdout, ['❌ Node.js：node fix', '⚠ Git：git fix', '⚠ 实时查看：watch fix', '| Codex | 已安装，没登录 |', '| opencode | 没装 |', '检测到 KIMI_API_KEY、MIMO_API_KEY']); assert.equal(r.stdout.includes('unused sandbox'), false);
});

test('没有在用的 Codex 协作方时，环境一节不说沙箱正常', async (t) => {
  const h = sandbox(t), c = baseConfig();
  for (const module of ['discuss', 'run', 'review']) for (const cell of ['simple', 'normal', 'complex']) c.modules[module][cell] = 'claude code';
  c.modules.image = { generate: null, draw: null }; h.config(c);
  const r = await h.bridge(['check', '--format', 'md'], { env: { FOREMAN_LANG: 'en', FOREMAN_TEST_MEMORY: '16,4' } }); assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith('## Environment\n\n' + MESSAGES.en.reportEnvironmentOkNoSandbox), r.stdout.slice(0, 200));
});

test('英文完整环境输出和非法 format；check 成功仍退出 0', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.discuss.simple = 'claude code'; h.config(c);
  const r = await h.bridge(['check', '--format', 'md'], { env: { FOREMAN_LANG: 'en', FOREMAN_TEST_MEMORY: '16,4' } }); assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.split('\n\n## Configuration')[0], '## Environment\n\n✅ Node.js, Git, the live view and the Codex sandbox all work.\n\n| Tool | Status |\n| --- | --- |\n| Codex | installed, logged in |\n| opencode | not installed |\n| pi | not installed |\n| API key variables | none found |\n| Memory | 16 GB in total, 4 GB available now |\n| Web board | off (enough memory to turn it on) |');
  has(r.stdout, ['**Cells**', '| Candidate | simple | normal | complex | Check |', '| Claude Code | no outside model', '**Seats and required agents**', '**Agents**', '**Notes**']);
  for (const cmd of ['config', 'check', 'models']) failed(await h.bridge([cmd, '--format', 'yaml']), M.reportFormatInvalid);
  failed(await h.bridge(['models', '--format', 'xml'], { env: { FOREMAN_LANG: 'en' } }), MESSAGES.en.reportFormatInvalid);
});
