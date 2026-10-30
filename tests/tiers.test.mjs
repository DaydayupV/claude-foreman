import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadTiers, tierOf } from '../foreman/skills/dispatch/scripts/tiers.mjs';
import { sandbox, write, output, baseConfig, BRIDGE, MESSAGES } from './helpers.mjs';

const dimensions = ['agentic', 'design', 'coding', 'browser', 'data', 'research', 'reasoning'];
const scored = (overall, values) => ({ source: 'live', overall, scores: Object.fromEntries(dimensions.map((dim, i) => [dim, values[i]])) });
const fixture = () => ({
  schema_version: 1, as_of: '2026-10-27', thresholds: { strong: 84, mid: 75 }, dimensions,
  sources: {
    live: { name: 'LiveBench', url: 'https://livebench.ai', checked: '2026-10-27' },
    legacy: { name: 'Legacy', url: 'https://livebench.ai', checked: '2026-10-18' },
  },
  models: {
    'gpt-6-astra': { ...scored(84, [100, 85, 95, 60, 75, 70, 68]), open: false, cost_per_task: 4.548 },
    'gpt-6.1-sol': scored(90, [80, 70, 70, 70, 80, 60, 75]),
    'claude-opus-5-5': scored(86, [80, 70, 70, 80, 80, 60, 75]),
    'gemini-4-argon': scored(85, [70, 60, 60, 80, 80, 70, 70]),
    'deepseek-flash': scored(75, dimensions.map(() => 95)),
    'gpt-6-sol': scored(83.99, dimensions.map(() => 95)),
    'gpt-6-luna': scored(74.99, dimensions.map(() => 10)),
    'qwen3.8-flash': { source: 'legacy', tier: 'weak', strengths: ['coding', 'reasoning'], weaknesses: [{ dim: 'browser', level: 'weak' }] },
  },
});
function setup(t, cli = false) {
  const h = sandbox(t), scripts = path.join(h.home, 'scripts');
  if (cli) fs.cpSync(path.dirname(BRIDGE), scripts, { recursive: true, filter: (file) => path.basename(file) !== 'model-tiers.json' });
  const file = write(path.join(scripts, 'model-tiers.json'), fixture());
  return { h, tiers: loadTiers(file), run: (args, options) => h.start(path.join(scripts, 'cli.mjs'), args, options).done };
}

test('档位按 84、75 的边界划分，缺文件和未知模型均未评级', (t) => {
  const { h, tiers } = setup(t);
  for (const [name, tier] of [['gpt-6-astra', 'strong'], ['deepseek-flash', 'mid'], ['gpt-6-sol', 'mid'], ['gpt-6-luna', 'weak']]) {
    assert.equal(tierOf(name, { tiers }).tier, tier, name);
  }
  assert.deepEqual(tierOf('provider/Unknown Model', { tiers }), {
    id: 'unknown-model', display: 'provider/Unknown Model', family: null, rated: false, tier: null, overall: null,
    strengths: [], weaknesses: [], top: [], source: null, checked: null, open: null, cost_per_task: null,
  });
  assert.equal(loadTiers(path.join(h.home, 'missing.json')), null);
  assert.equal(tierOf('gpt-6-astra', { tiers: null }).rated, false);
  assert.equal(tierOf('gpt-6-astra', { tiers: null }).tier, null);
});

test('agy 完整 ID 按词表回查模型族，非档位后缀不拆，完整 ID 的评级优先', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(tierOf(`gemini-3.8-flash-${effort}`), tierOf('gemini-3.8-flash'));
  }
  const tiers = { sources: {}, models: { custom: { tier: 'mid' }, 'custom-high': { tier: 'strong' } } };
  assert.equal(tierOf('custom-low', { tiers, catalog: null }).tier, 'mid');
  assert.equal(tierOf('custom-high', { tiers, catalog: null }).tier, 'strong');
  assert.equal(tierOf('custom-high', { tiers, catalog: { models: { custom: { aliases: [] } } } }).tier, 'strong');
  assert.equal(tierOf('custom-thinking', { tiers, catalog: null }).rated, false);
});

test('同档中位数产生排序后的最多三项长短处，全表第一维度含并列', (t) => {
  const { tiers } = setup(t), info = tierOf('gpt-6-astra', { tiers });
  assert.deepEqual(info.strengths, ['coding', 'agentic', 'design']);
  assert.deepEqual(info.weaknesses, [{ dim: 'browser', level: 'very_weak' }, { dim: 'data', level: 'weak' }]);
  assert.deepEqual(info.top, ['agentic', 'coding']);
  assert.deepEqual(tierOf('gemini-4-argon', { tiers }).strengths, ['browser', 'research']);
  assert.equal(info.overall, 84);
  assert.equal(info.source, 'LiveBench'); assert.equal(info.checked, '2026-10-27');
  assert.equal(info.open, false); assert.equal(info.cost_per_task, 4.548);
  const weak = { ...tiers, models: { ...tiers.models, 'gpt-6-luna': scored(74.99, dimensions.map(() => 100)) } };
  assert.deepEqual(tierOf('gpt-6-astra', { tiers: weak }).strengths, info.strengths);
  assert.deepEqual(tierOf('gpt-6-astra', { tiers: weak }).top, ['agentic']);
  assert.equal(tierOf('opencode-go/deepseek-v4.1-flash-1017', { tiers }).id, 'deepseek-flash');
});

test('legacy 档位、长短处直接返回，综合分和 top 不补造', (t) => {
  const { tiers } = setup(t), legacy = tiers.models['qwen3.8-flash'];
  assert.deepEqual(tierOf('qwen3.8-flash', { tiers }), {
    id: 'qwen3.8-flash', display: 'Qwen3.8 Flash', family: 'qwen', rated: true, tier: legacy.tier, overall: null,
    strengths: legacy.strengths, weaknesses: legacy.weaknesses, top: [], source: 'Legacy', checked: '2026-10-18', open: null, cost_per_task: null,
  });
});

test('tiers 支持重复 --model、--all 排序、当前配置去重和项目覆盖，config 含 image 档位', async (t) => {
  const { h, tiers, run } = setup(t, true), c = baseConfig();
  c.agents.codex.model = 'gpt-6-astra';
  c.agents.unset = { ...c.agents.codex }; delete c.agents.unset.model;
  c.modules.default.discuss.complex = [{ agent: 'codex', model: 'opencode-go/deepseek-v4.1-flash-1017' }];
  c.modules.default.run.normal = [{ agent: 'unset' }];
  c.modules.default.image = { generate: [{ agent: 'codex', model: 'gpt-6.1-sol' }], draw: [{ agent: 'codex', model: 'qwen3.8-flash' }] };
  h.config(c);
  write(path.join(h.home, '.codex/config.toml'), 'model = "native-only"\n');
  const queried = output(await run(['tiers', '--model', 'claude-opus-5-5', '--model', 'unknown', '--format', 'json']));
  assert.deepEqual(queried, { as_of: tiers.as_of, thresholds: tiers.thresholds,
    models: ['claude-opus-5-5', 'unknown'].map((name) => ({ ...tierOf(name, { tiers }), name })) });
  const all = output(await run(['tiers', '--all']));
  assert.deepEqual(all.models.map(({ id }) => id), ['gpt-6.1-sol', 'claude-opus-5-5', 'gemini-4-argon', 'gpt-6-astra', 'gpt-6-sol', 'deepseek-flash', 'gpt-6-luna', 'qwen3.8-flash']);
  const current = output(await run(['tiers']));
  assert.deepEqual(current.models.map(({ name }) => name), ['gpt-6-astra', 'opencode-go/deepseek-v4.1-flash-1017', 'native-only', 'gpt-6.1-sol', 'qwen3.8-flash']);
  const config = output(await run(['config']));
  assert.deepEqual(config.resolved_modules.discuss.complex, [{ agent: 'codex', model: 'opencode-go/deepseek-v4.1-flash-1017', effort: null, required: false, tier: 'mid' }]);
  assert.equal(config.resolved_modules.run.complex[0].tier, 'strong');
  assert.deepEqual(config.resolved_modules.run.normal[0], { agent: 'unset', model: 'native-only', effort: null, required: false, tier: null });
  assert.equal(config.resolved_modules.image.generate[0].tier, 'strong');
  assert.equal(config.resolved_modules.image.draw[0].tier, 'weak');
  // 没写模型的协作方用 Codex 自己配置里的模型，它不在价格表和档位表里
  for (const kind of ['unpriced_models', 'unrated_models']) assert.deepEqual(config.summary.warnings.find((w) => w.kind === kind).models.map(({ model }) => model), ['native-only']);
  h.write('.claude/foreman.json', { modules: { default: { image: { draw: null } } } });
  assert.deepEqual(output(await run(['tiers', '--cwd', h.cwd])).models.map(({ name }) => name), current.models.slice(0, -1).map(({ name }) => name));
});

test('tiers Markdown、帮助及覆盖告警使用插件语言，告警不改变 check.ok', async (t) => {
  const { h, run } = setup(t, true), c = baseConfig();
  c.agents.codex.model = 'gpt-6-astra';
  c.agents.unused = { ...c.agents.codex, model: 'unused-unknown' };
  c.modules.default.discuss.simple = [{ agent: 'codex', model: 'unknown-a' }];
  c.modules.default.review.normal = [{ agent: 'codex', model: 'unknown-a' }];
  c.modules.default.review.complex = [{ agent: 'codex', model: 'unknown-b' }];
  c.modules.default.image.draw = [{ agent: 'codex', model: 'gpt-5.5' }];
  h.config(c);
  const models = [
    { model: 'unknown-a', used_at: ['modules.default.discuss.simple[0]', 'modules.default.review.normal[0]'] },
    { model: 'unknown-b', used_at: ['modules.default.review.complex[0]'] },
  ];
  for (const lang of ['zh', 'en']) {
    const M = MESSAGES[lang], options = { env: { FOREMAN_LANG: lang } };
    const md = await run(['tiers', '--model', 'gpt-6-astra', '--model', 'qwen3.8-flash', '--model', 'unknown', '--format', 'md'], options);
    assert.equal(md.code, 0, md.stderr);
    assert.ok(md.stdout.startsWith(`| ${M.tierHeaders.join(' | ')} |\n`));
    assert.ok(md.stdout.includes(`| GPT-6 Astra | ${M.tierNames.strong} | 84 | ${M.list(['coding', 'agentic', 'design'].map((dim) => M.dimNames[dim]))} | ${M.list([M.tierWeakness(M.dimNames.browser, 'very_weak'), M.tierWeakness(M.dimNames.data, 'weak')])} | LiveBench 2026-10-27 |`));
    assert.ok(md.stdout.includes(`| ${M.tierLegacySource('Legacy', '2026-10-18')} |`)); // qwen3.8-flash 是旧档位表沿用的条目
    assert.ok(md.stdout.includes(`| unknown | ${M.tierNames.unrated} | — | — | — | — |`));
    assert.equal((await run(['tiers', '--help'], options)).stdout, M.help.tiers + '\n');
    assert.ok((await run(['--help'], options)).stdout.includes('|tiers|'));
    const config = output(await run(['config'], options)), check = output(await run(['check', '--agent', 'codex'], options));
    assert.equal(check.ok, true);
    const unpriced = { kind: 'unpriced_models', models, message: M.warnUnpricedModels(M.list(models.map(({ model }) => model))) };
    const unratedModels = [...models, { model: 'gpt-5.5', used_at: ['modules.default.image.draw[0]'] }];
    const unrated = { kind: 'unrated_models', models: unratedModels, message: M.warnUnratedModels(M.list(unratedModels.map(({ model }) => model))) };
    for (const result of [config, check]) assert.deepEqual(result.summary.warnings.filter(({ kind }) => ['unpriced_models', 'unrated_models'].includes(kind)), [unpriced, unrated]);
  }
  h.config({ ...c, modules: baseConfig().modules });
  const clean = output(await run(['config']));
  assert.ok(!clean.summary.warnings.some(({ kind }) => ['unpriced_models', 'unrated_models'].includes(kind)));
});

test("差值按一位小数取整后再比较，恰好差 5 分算长处、差 15 分算很弱", () => {
  const tiers = { ...fixture(), models: {
    a: scored(80, [10, 10, 54.1, 10, 10, 10, 10]), b: scored(80, [10, 10, 59.1, 10, 10, 10, 10]), c: scored(80, [10, 10, 64.1, 10, 10, 10, 10]),
    d: scored(60, [10, 10, 49.1, 10, 10, 10, 10]), e: scored(60, [10, 10, 64.1, 10, 10, 10, 10]), f: scored(60, [10, 10, 79.1, 10, 10, 10, 10]),
  } };
  const catalog = { models: Object.fromEntries("abcdef".split("").map((id) => [id, { display: id, aliases: [] }])) };
  assert.ok(tierOf("c", { tiers, catalog }).strengths.includes("coding"));
  assert.deepEqual(tierOf("d", { tiers, catalog }).weaknesses.find(({ dim }) => dim === "coding"), { dim: "coding", level: "very_weak" });
});
