import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, baseConfig, apiAgent, opencodeAgent, MESSAGES, CODEX, taskArgs } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;

const level = (effort) => ({ effort, description: '' });
const codexCatalog = { models: [
  { slug: 'fake-codex', display_name: 'Fake Codex', description: '合成模型', default_reasoning_level: 'medium',
    supported_reasoning_levels: ['low', 'medium', 'high'].map(level), visibility: 'list', context_window: 1000 },
  { slug: 'fake-hidden', display_name: 'Hidden', description: null, default_reasoning_level: 'low',
    supported_reasoning_levels: [level('low')], visibility: 'hide', context_window: 500 },
] };
const opencodeCatalog = [
  // id 是 -m 里写的名字，modelID 是底层模型名，两者可以不同
  { providerID: 'fake', id: 'model', modelID: 'model-2026', name: 'Fake Model', variants: [{ id: 'low' }, { id: 'high' }],
    limit: { context: 2000 }, cost: [{ input: 1, output: 2 }], status: 'active', enabled: true },
  { providerID: 'right', modelID: 'thing', name: 'Thing', variants: [], limit: { context: 3000 }, cost: [], status: 'active', enabled: true },
];
const runCalls = (s) => s.calls().filter((c) => c.tool === 'opencode' && c.operation === 'run').map((c) => c.args[c.args.indexOf('-m') + 1]);

test('models 列出 Codex、opencode 和 API 的清单，并核对配置里的模型', async (t) => {
  const h = sandbox(t), c = baseConfig(), api = await apiServer(t, [{}], { models: ['fake-api', 'other-api'] });
  c.agents.oc = { ...opencodeAgent(), model: 'wrong/thing' };
  c.agents.api = apiAgent(api.url);
  c.agents.codex2 = { ...c.agents.codex, bin: [path.dirname(CODEX), '..', 'fake', 'codex.mjs'].join(path.sep) };
  h.config(c);
  const s = h.scenario({ codex_catalog: codexCatalog, opencode_catalog: opencodeCatalog });
  const r = output(await h.bridge(['models'], { env: s.env }));
  assert.equal(s.calls().filter((call) => call.tool === 'codex' && call.operation === 'catalog').length, 2);
  assert.equal(r.agents.codex2.listed, true);
  assert.equal(r.tools['codex cli'].ok, true);
  assert.deepEqual(r.tools['codex cli'].models, [
    { id: 'fake-codex', name: 'Fake Codex', efforts: ['low', 'medium', 'high'], default_effort: 'medium', context: 1000, description: '合成模型', hidden: false },
    { id: 'fake-hidden', name: 'Hidden', efforts: ['low'], default_effort: 'low', context: 500, description: null, hidden: true },
  ]);
  assert.deepEqual(r.tools['opencode cli'].models, [
    { id: 'fake/model', name: 'Fake Model', efforts: ['low', 'high'], default_effort: null, context: 2000, cost: { input: 1, output: 2 }, status: 'active', enabled: true },
    { id: 'right/thing', name: 'Thing', efforts: [], default_effort: null, context: 3000, cost: null, status: 'active', enabled: true },
  ]);
  assert.equal(r.api.api.ok, true);
  assert.deepEqual(r.api.api.models.map((m) => [m.id, m.efforts]), [['fake-api', null], ['other-api', null]]);
  assert.deepEqual(r.agents.codex, { type: 'codex cli', model: 'fake-codex', listed: true, efforts: ['low', 'medium', 'high'], closest: [] });
  assert.deepEqual(r.agents.oc, { type: 'opencode cli', model: 'wrong/thing', listed: false, efforts: null, closest: ['right/thing'] });
  assert.deepEqual(r.agents.api, { type: 'api', model: 'fake-api', listed: true, efforts: null, closest: [] });
  assert.equal(api.requests.length, 0);
});

test('models 读不到清单时如实报告，不影响其他工具', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent();
  h.config(c);
  const s = h.scenario({ opencode_catalog: opencodeCatalog });
  const r = output(await h.bridge(['models'], { env: s.env }));
  assert.equal(r.tools['codex cli'].ok, false);
  assert.equal(r.tools['codex cli'].error, 'synthetic: no model catalog');
  assert.equal(r.tools['opencode cli'].ok, true);
  assert.deepEqual(r.agents.codex, { type: 'codex cli', model: 'fake-codex', listed: null, efforts: null, closest: [] });
  assert.equal(r.agents.oc.listed, true);
});

test('check 按 Codex 清单核对推理强度，不支持的档位判不通过且不发执行请求', async (t) => {
  const h = sandbox(t), s = h.scenario({ codex_catalog: codexCatalog });
  const r = output(await h.bridge(['check'], { env: s.env }), 1);
  const codex = r.agents.codex, supported = M.list(['low', 'medium', 'high']);
  const maxAt = ['modules.discuss.complex[0]', 'modules.run.complex[0]', 'modules.review.complex[0]'];
  assert.equal(r.ok, false);
  assert.equal(codex.ok, false);
  assert.deepEqual(codex.catalog, { ok: true });
  assert.deepEqual(codex.efforts.find((e) => e.variant === 'max'),
    { model: 'fake-codex', variant: 'max', used_at: maxAt, ok: false, error: M.effortNotInCatalog('max', supported) });
  assert.ok(codex.efforts.filter((e) => e.variant !== 'max').every((e) => e.ok === true && e.error === null));
  assert.equal(codex.fix, M.fixEffortUnsupported('codex', M.effortAt('max', M.list(maxAt), 'fake-codex', supported)));
  assert.ok(!s.calls().some((call) => call.operation === 'exec'));
});

test('check Codex 模型不在清单里或读不到清单时只提示，不判失败', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.codex.model = 'fake-other';
  h.config(c);
  const listed = output(await h.bridge(['check'], { env: h.scenario({ codex_catalog: codexCatalog }).env }));
  assert.equal(listed.agents.codex.ok, true);
  assert.equal(listed.agents.codex.model_note, M.modelNotInCatalog('fake-other', ''));
  assert.ok(listed.agents.codex.efforts.every((e) => e.ok === null && e.error === M.modelNotInCatalog('fake-other')));
  const missing = output(await h.bridge(['check'], { env: h.scenario({}).env }));
  assert.equal(missing.agents.codex.ok, true);
  assert.deepEqual(missing.agents.codex.catalog, { ok: false, error: 'synthetic: no model catalog' });
  assert.deepEqual(missing.agents.codex.efforts, []);
});

test('check opencode 清单里没有的档位不发请求，修正提示列出支持的档位', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent();
  c.modules.review.simple = { agent: 'oc', effort: 'high' };
  c.modules.review.normal = { agent: 'oc', effort: 'medium' };
  c.modules.review.complex = { agent: 'oc', effort: 'default' };
  c.agents.oc2 = { ...opencodeAgent(), model: 'right/thing' };
  c.modules.discuss.simple = [{ agent: 'oc2', effort: 'default' }];
  h.config(c);
  const s = h.scenario({ opencode_catalog: opencodeCatalog, last_message: 'OK' });
  const r = output(await h.bridge(['check', '--agent', 'oc'], { env: s.env }), 1);
  const supported = ['low', 'high'];
  assert.equal(r.agents.oc.ok, false);
  assert.deepEqual(r.agents.oc.variants, [
    { model: 'fake/model', variant: 'high', used_at: ['modules.review.simple[0]'], ok: true, error: null, supported },
    { model: 'fake/model', variant: 'medium', used_at: ['modules.review.normal[0]'], ok: false, error: M.effortNotInCatalog('medium', M.list(supported)), supported },
    { model: 'fake/model', variant: 'default', used_at: ['modules.review.complex[0]'], ok: true, error: null, supported },
  ]);
  assert.equal(r.agents.oc.fix, M.fixEffortUnsupported('oc', M.effortAt('medium', 'modules.review.normal[0]', 'fake/model', M.list(supported))));
  assert.deepEqual(runCalls(s), ['fake/model', 'fake/model#high']);
  assert.ok(s.calls().filter((c) => c.operation === 'run').every((c) => c.args[c.args.indexOf('--title') + 1] === 'foreman check'));
  const before = runCalls(s).length; // 调用记录按沙箱累计
  const empty = h.scenario({ opencode_catalog: opencodeCatalog, last_message: 'OK', models: ['fake/model', 'right/thing'] });
  const r2 = output(await h.bridge(['check', '--agent', 'oc2'], { env: empty.env }));
  assert.equal(r2.agents.oc2.ok, true);
  assert.deepEqual(r2.agents.oc2.variants, [{ model: 'right/thing', variant: 'default', used_at: ['modules.discuss.simple[0]'], ok: true, error: null, supported: [] }]);
  assert.deepEqual(runCalls(empty).slice(before), ['right/thing']);
});

test('check opencode 清单里有的档位请求失败时转告真实报错，不说档位不支持', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent();
  c.modules.review.simple = { agent: 'oc', effort: 'high' };
  c.modules.review.normal = { agent: 'oc', effort: 'medium' };
  h.config(c);
  const s = h.scenario({ opencode_catalog: opencodeCatalog, reject_variants: ['high'], last_message: 'OK' });
  const r = output(await h.bridge(['check', '--agent', 'oc'], { env: s.env }), 1);
  const error = 'Variant unavailable for fake/model: high', supported = ['low', 'high'];
  assert.equal(r.agents.oc.ok, false);
  assert.equal(r.agents.oc.error, error);
  assert.equal(r.agents.oc.fix, [
    M.fixEffortUnsupported('oc', M.effortAt('medium', 'modules.review.normal[0]', 'fake/model', M.list(supported))),
    M.fixOpencodeVariantFailed('oc', 'high（modules.review.simple[0]）', error),
  ].join('；'));
});

test('check opencode 模型写错提供方前缀时提示最接近的写法', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = { ...opencodeAgent(), model: 'wrong/model' };
  h.config(c);
  const s = h.scenario({ models: ['fake/model', 'other/thing'] });
  const r = output(await h.bridge(['check', '--agent', 'oc'], { env: s.env }));
  assert.equal(r.agents.oc.model_listed, false);
  assert.equal(r.agents.oc.fix, M.fixOpencodeModel('oc', 'wrong/model') + M.closestHint('fake/model'));
});

test('levels 里代号写错时，报错带上最接近的代号', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.modules.discuss.simple = [{ agent: 'codexx', effort: 'medium' }];
  h.config(c);
  failed(await h.bridge(['config']), M.unknownAgent('modules.discuss.simple[0]', 'codexx') + M.closestHint('codex'));
  c.modules.discuss.simple = [{ agent: 'Codex', effort: 'medium' }];
  h.config(c);
  failed(await h.bridge(['config']), M.unknownAgent('modules.discuss.simple[0]', 'Codex') + M.closestHint('codex'));
});

test('--agent 写错时先提示最接近的代号，不报和等级不符', async (t) => {
  const h = sandbox(t), hint = M.unknownAgentFlag('codexx') + M.closestHint('codex');
  failed(await h.bridge(taskArgs(h, 'run', ['--level', 'simple', '--agent', 'codexx'])), hint);
  failed(await h.bridge(taskArgs(h, 'run', ['--agent', 'codexx'])), hint);
});

test('config 输出总表：按等级、按协作方，以及没用到的协作方、明文 key、shell 权限和失效的旧代号', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.api = apiAgent('http://127.0.0.1:9');
  c.agents.oc = { ...opencodeAgent(), run_access: 'shell' };
  c.modules.run.normal = { agent: 'oc' };
  h.config(c);
  fs.writeFileSync(path.join(h.home, '.claude/foreman/agent-aliases.json'), JSON.stringify({ old: 'gone', codex2: 'codex' }));
  const { summary } = output(await h.bridge(['config']));
  assert.equal(summary.modules.run.simple, 'claude code');
  assert.deepEqual(summary.modules.run.normal, [{ agent: 'oc', type: 'opencode cli', model: 'fake/model', effort: null, required: false, ok: null }]);
  assert.deepEqual(summary.modules.review.simple, [{ agent: 'codex', type: 'codex cli', model: 'fake-codex', effort: 'medium', required: false, ok: null }]);
  assert.deepEqual(summary.agents.codex.used_at, ['modules.discuss.simple[0]', 'modules.discuss.normal[0]', 'modules.discuss.complex[0]',
    'modules.run.complex[0]', 'modules.review.simple[0]', 'modules.review.normal[0]', 'modules.review.complex[0]']);
  assert.deepEqual(summary.agents.oc, { type: 'opencode cli', model: 'fake/model', used_at: ['modules.run.normal[0]'], run_access: 'shell', ok: null });
  assert.deepEqual(summary.agents.api.used_at, []);
  assert.deepEqual(summary.warnings, [
    { kind: 'readonly_audited', agent: 'codex', modes: ['review', 'discuss'], message: M.warnReadonlyAudited('codex', M.list([M.modeNames.review, M.modeNames.discuss])) },
    { kind: 'unused_agent', agent: 'api', message: M.warnUnusedAgent('api') },
    { kind: 'plaintext_key', agent: 'api', message: M.warnPlaintextKey('api') },
    { kind: 'shell_access', agent: 'oc', message: M.warnShellAccess('oc') },
    { kind: 'stale_alias', agent: 'old', message: M.warnStaleAlias('old', 'gone', '') },
  ]);
});

test('check 的总表带上检查结果，档位不支持的格子写明原因，其余格子照常可用', async (t) => {
  const h = sandbox(t), s = h.scenario({ codex_catalog: codexCatalog });
  const { summary } = output(await h.bridge(['check'], { env: s.env }), 1);
  assert.deepEqual(summary.modules.run.complex, [{ agent: 'codex', type: 'codex cli', model: 'fake-codex', effort: 'max', required: false, ok: false,
    problem: M.effortNotInCatalog('max', M.list(['low', 'medium', 'high'])) }]);
  assert.equal(summary.modules.review.simple[0].ok, true);
  assert.equal(summary.modules.discuss.normal[0].ok, true);
  assert.equal(summary.agents.codex.ok, false);
});
