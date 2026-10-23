import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { costOf, loadPrices, priceFor } from '../foreman/skills/dispatch/scripts/prices.mjs';
import { runMessage } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { sandbox, plannedSandbox, baseConfig, opencodeAgent, piAgent, apiAgent, seedRun, taskArgs, output, json, ROOT, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';

const prices = loadPrices(), usage = { input_tokens: 1000000, cached_input_tokens: 200000, output_tokens: 100000 };
const base = { agent_type: 'codex cli', model: 'provider/gpt-6.1-sol', usage, usage_scope: 'this_run' };
const unknown = { cost_usd: null, cost_source: 'unknown' };

test('四种协作方统一按 API 价格计费，工具报数不参与，旧来源重算', () => {
  for (const agent_type of ['codex cli', 'api', 'opencode cli', 'pi cli', 'opencode']) {
    assert.deepEqual(costOf({ agent_type, cost_usd: 0.125 }, prices), unknown);
    assert.deepEqual(costOf({ agent_type, cost_usd: 0 }, prices), unknown);
    assert.deepEqual(costOf({ ...base, agent_type, cost_usd: 99 }, prices), { cost_usd: 2.62, cost_source: 'api_price' });
  }
  assert.deepEqual(costOf(base, prices), { cost_usd: 2.62, cost_source: 'api_price' });
  for (const agent_type of ['codex cli', 'api', 'opencode cli', 'pi cli']) for (const patch of [
    { model: 'unpriced' }, { usage: null }, { usage: {} }, { usage_scope: 'session_total' },
  ]) assert.deepEqual(costOf({ ...base, agent_type, ...patch }, prices), unknown);
  for (const usage_scope of [null, undefined]) assert.deepEqual(costOf({ ...base, usage_scope }, prices), { cost_usd: 2.62, cost_source: 'api_price' });
  for (const cost_source of ['api_price', 'unknown']) {
    const stored = { cost_source, cost_usd: cost_source === 'unknown' ? null : 7 };
    assert.deepEqual(costOf({ ...base, ...stored }, null), stored);
  }
  for (const cost_source of ['reported', 'api', 'subscription']) {
    assert.deepEqual(costOf({ ...base, cost_source, cost_usd: 7 }, prices), { cost_usd: 2.62, cost_source: 'api_price' });
    assert.deepEqual(costOf({ ...base, cost_source, cost_usd: 7 }, null), unknown);
  }
  assert.deepEqual(costOf({ ...base, usage: { input_tokens: 0, output_tokens: 0 } }, prices), { cost_usd: 0, cost_source: 'api_price' });
  for (const host of [{ participant: 'host' }, { agent_type: 'host' }]) assert.deepEqual(costOf({ ...base, cost_source: 'api_price', cost_usd: 7, ...host }, prices), unknown);
  assert.deepEqual(costOf({ ...base, model: 'unpriced', cost_usd: 0.125 }, prices), unknown);
  assert.equal(loadPrices(), prices);
});

test('旧类型和缺失用量范围在 costOf、stats、终端中一致，续接默认不折算', async (t) => {
  const h = sandbox(t), records = [];
  for (const agent_type of [undefined, 'codex', 'openai-compatible']) for (const scope of [
    { mode: 'run' }, { mode: 'resume' }, { mode: 'resume', usage_scope: 'this_run' }, { mode: 'run', usage_scope: 'session_total' },
  ]) {
    const model = `gpt-6.1-sol-legacy-${records.length}`, meta = { agent_type, model, mode: scope.mode };
    const result = { usage, ...(scope.usage_scope ? { usage_scope: scope.usage_scope } : {}) };
    const source = (scope.usage_scope ?? (scope.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total'
      ? 'unknown' : 'api_price';
    seedRun(h, `legacy-${records.length}`, meta, result);
    assert.deepEqual(costOf({ ...meta, ...result }, prices), { cost_usd: source === 'unknown' ? null : 2.62, cost_source: source });
    records.push({ meta, result, source });
  }
  const rows = output(await h.bridge(['stats'])).rows;
  assert.equal(rows.length, records.length);
  for (const { meta, source } of records) {
    const row = rows.find((r) => r.model === meta.model);
    assert.deepEqual(row.cost_usd, { total: source === 'api_price' ? 2.62 : null, runs: source === 'api_price' ? 1 : 0, missing_runs: source === 'unknown' ? 1 : 0 });
    assert.deepEqual(Object.keys(row).filter((k) => k.startsWith('cost_')), ['cost_usd']);
  }
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/format.mjs')).href;
  const script = `import { usageLine } from ${JSON.stringify(url)}; console.log(JSON.stringify(${JSON.stringify(records)}.map(r => usageLine(r.result, r.meta))));`;
  for (const lang of ['zh', 'en']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...h.env, FOREMAN_LANG: lang }, encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).map((line) => line.match(/(?:cost \$|subscription ≈\$)[\d.]+/)?.[0] ?? null),
      records.map(({ source }) => source === 'unknown' ? null : 'cost $2.62'));
  }
});

test('缓存写入单独计价，不重复计普通输入，总输入小于缓存时最低按 0', () => {
  for (const agent_type of ['api', 'codex cli', 'opencode cli', 'pi cli']) {
    const cost_source = 'api_price';
    assert.deepEqual(costOf({ ...base, agent_type, usage: { ...usage, cache_write_input_tokens: 100000 } }, prices), { cost_usd: 2.67, cost_source });
    assert.deepEqual(costOf({ ...base, agent_type, usage: { input_tokens: 100, cached_input_tokens: 200, output_tokens: 0 } }, prices), { cost_usd: 0.00002, cost_source });
    assert.deepEqual(costOf({ ...base, agent_type, usage: { input_tokens: 100, cached_input_tokens: 200, cache_write_input_tokens: 100 } }, prices), { cost_usd: 0.00027, cost_source });
    assert.deepEqual(costOf({ ...base, agent_type, usage: { cache_write_input_tokens: 100000 } }, prices), { cost_usd: 0.25, cost_source });
  }
  assert.deepEqual(costOf({ ...base, model_shown: 'unpriced' }, prices), { cost_usd: 2.62, cost_source: 'api_price' });
});

test('新增官方价格精确匹配模型和提供方前缀，不被较短条目抢先', () => {
  for (const [model, input, cached, cache_write, output] of [
    ['deepseek-v4.1-flash', 0.3, 0.006, undefined, 1.2], ['glm-5.3-flash', 0.15, 0.03, undefined, 0.5],
    ['gemini-4-argon', 2, 0.1, undefined, 10], ['qwen3.8-flash', 0.15, 0.016, 0.2, 0.47], ['minimax-m3', 0.3, 0.06, undefined, 1.2],
  ]) for (const name of [model, `opencode-go/${model}`, `provider/${model.toUpperCase()}`]) {
    const rate = prices.models.find((p) => p.match.includes(model));
    assert.deepEqual(rate.match, [model]); assert.match(rate.source, /https:\/\/.*2026-10-23/);
    for (const [key, value] of Object.entries({ input, cached, cache_write, output })) {
      assert.equal(rate[key], value); if (value != null) assert.equal(priceFor(name, { [key]: 1e6 }, prices), value);
    }
  }
});

test('模型优先精确匹配，再取连字符前缀中最长的，拒绝相似型号', () => {
  for (const model of ['glm-5.3-flashx', 'minimax-m3.1-flash', 'other-gemini-4-argon']) {
    for (const name of [model, `provider/${model.toUpperCase()}`]) assert.equal(priceFor(name, { input: 1e6 }, prices), null);
  }
  assert.equal(priceFor('google/GEMINI-4-ARGON-contributor', { input: 1e6 }, prices), 2);
  assert.equal(priceFor('anthropic/claude-opus-5-5-20261001', { input: 1e6 }, prices), 4);
  const overlapping = { models: [
    { match: ['claude-sonnet-5', 'claude-opus-5'], input: 99, output: 0 },
    { match: ['claude-sonnet-5-5'], input: 2, output: 0 }, { match: ['claude-opus-5-5'], input: 4, output: 0 },
  ] };
  assert.equal(priceFor('claude-sonnet-5-5', { input: 1e6 }, overlapping), 2);
  assert.equal(priceFor('claude-opus-5-5-20261001', { input: 1e6 }, overlapping), 4);
});

test('新增 Claude 模型按指定价格匹配，支持提供方和日期后缀', () => {
  for (const [model, input, cached, cache_write, output] of [
    ['claude-fable-5-1', 10, 0.25, 12.5, 50], ['claude-fable-5', 10, 1, 12.5, 50],
    ['claude-mythos-5', 10, 1, 12.5, 50], ['claude-sonnet-5', 2, 0.2, 2.5, 10], ['claude-haiku-5-5', 0.1, 0.01, 0.125, 0.5],
  ]) {
    const rate = prices.models.find((p) => p.match.includes(model));
    assert.ok(rate.source.startsWith('https://platform.claude.com/docs/en/about-claude/pricing'));
    for (const name of [model, `anthropic/${model.toUpperCase()}`, `${model}-20261023`]) {
      for (const [key, value] of Object.entries({ input, cached, cache_write, output })) assert.equal(priceFor(name, { [key]: 1e6 }, prices), value);
    }
  }
});

test('API extra_body.model 覆盖后按实际发送模型计价', async (t) => {
  const h = plannedSandbox(t), c = baseConfig(), api = await apiServer(t);
  c.agents.api = { ...apiAgent(api.url), model: 'unpriced-alias', extra_body: { model: 'gpt-6.1-sol' } };
  c.modules.discuss.complex = [{ agent: 'api' }]; c.modules.discuss.seats = { complex: 1 }; h.config(c);
  const result = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'api'])));
  assert.equal(api.requests[0].body.model, 'gpt-6.1-sol');
  assert.equal(result.model, 'unpriced-alias'); assert.equal(result.model_shown, 'gpt-6.1-sol');
  assert.equal(result.cost_source, 'api_price'); assert.equal(result.cost_usd, 0.000562);
  assert.equal(h.events(result.run_id).find((e) => e.type === 'api.usage').usage.cache_write_input_tokens, 0);
});

test('API 两种缓存写入字段保留到事件和任务结果，并按写入价计费', async (t) => {
  const h = plannedSandbox(t), c = baseConfig();
  const variants = [
    { prompt_tokens_details: { cached_tokens: 200000, cache_write_tokens: 100000 }, cache_creation_input_tokens: 999999 },
    { prompt_tokens_details: { cached_tokens: 200000 }, cache_creation_input_tokens: 100000 },
  ];
  const api = await apiServer(t, variants.map((v) => ({ usage: { prompt_tokens: 1000000, completion_tokens: 100000, ...v } })));
  c.agents.api = { ...apiAgent(api.url), model: 'gpt-6.1-sol' };
  c.modules.discuss.complex = [{ agent: 'api' }]; c.modules.discuss.seats = { complex: 1 }; h.config(c);
  for (const name of ['prompt_tokens_details.cache_write_tokens', 'cache_creation_input_tokens']) await t.test(name, async () => {
    const result = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'api'])));
    assert.equal(h.events(result.run_id).find((e) => e.type === 'api.usage').usage.cache_write_input_tokens, 100000);
    assert.equal(result.usage.cache_write_input_tokens, 100000);
    assert.equal(result.cost_source, 'api_price'); assert.equal(result.cost_usd, 2.67);
    assert.deepEqual(json(path.join(result.run_dir, 'result.json')), result);
  });
});

test('Codex 用量白名单保留已报告的缓存写入，并对续接扣除基线', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.model = 'gpt-6.1-sol'; h.config(c);
  const total = { ...usage, cache_write_input_tokens: 100000 };
  const first = h.scenario({ stats: { info: { total_token_usage: total } } }, 'first');
  const initial = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: first.env }));
  assert.equal(initial.usage.cache_write_input_tokens, 100000); assert.equal(initial.cost_usd, 2.67);
  const next = h.scenario({ stats: { info: { total_token_usage: Object.fromEntries(Object.entries(total).map(([k, v]) => [k, v * 2])) } } }, 'next');
  const resumed = output(await h.bridge(taskArgs(h, 'resume', ['--run', initial.run_id, '--no-snapshot']), { env: next.env }));
  assert.equal(resumed.usage.cache_write_input_tokens, 100000); assert.equal(resumed.usage_scope, 'this_run');
  assert.equal(resumed.cost_source, 'api_price'); assert.equal(resumed.cost_usd, 2.67);
  assert.deepEqual(json(path.join(resumed.run_dir, 'result.json')), resumed);
});

test('runner 四类协作方统一写 API 费用，opencode、pi 自报仅留档，主持席不计费', async (t) => {
  const h = plannedSandbox(t), c = baseConfig(), api = await apiServer(t);
  c.agents.codex.model = 'gpt-6.1-sol'; c.agents.pi = { ...piAgent(), model: 'provider/gpt-6.1-sol' };
  c.agents.oc = { ...opencodeAgent(), model: 'opencode-go/gpt-6.1-sol' }; c.agents.api = { ...apiAgent(api.url), model: 'kimi-k2.6' };
  c.modules.discuss.complex = [{ agent: 'pi' }, { agent: 'oc' }, { agent: 'api' }]; c.modules.discuss.seats = { complex: 1 }; h.config(c);
  const scene = h.scenario({ usage, export_messages: [{ type: 'assistant', tokens: { input: 700000, cache: { read: 200000, write: 100000 }, output: 100000 }, cost: 0.125 }] });
  const codex = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: scene.env }));
  const pi = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi'])));
  const oc = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'oc']), { env: scene.env }));
  const paid = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'api'])));
  c.agents.codex.model = 'unpriced'; h.config(c);
  const missing = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: scene.env }));
  for (const [result, source, cost] of [[codex, 'api_price', 2.62], [pi, 'api_price', 0.0000803], [oc, 'api_price', 2.67], [paid, 'api_price', 0.0002392], [missing, 'unknown', null]]) {
    assert.equal(result.cost_source, source); assert.equal(result.cost_usd, cost);
    assert.deepEqual(json(path.join(result.run_dir, 'result.json')), result);
  }
  assert.equal(oc.reported_cost_usd, 0.125); assert.equal(pi.reported_cost_usd, 0.25);
  assert.equal(oc.usage.cached_input_tokens, 200000); assert.equal(oc.usage.cache_write_input_tokens, 100000);
  assert.equal(pi.usage.cached_input_tokens, 3); assert.equal(pi.usage.cache_write_input_tokens, 4);
  const combined = output(await h.bridge(['stats'])).rows.find((r) => r.model === 'gpt-6.1-sol' && r.module === 'discuss');
  assert.deepEqual(combined.cost_usd, { total: 2.6700803, runs: 2, missing_runs: 0 });
  assert.equal(Object.hasOwn(codex.usage, 'cache_write_input_tokens'), false);
  for (const meta of h.records().filter((m) => m.participant === 'host')) {
    const result = json(path.join(h.runs, meta.id, 'result.json'));
    assert.equal(Object.hasOwn(result, 'cost_usd'), false); assert.equal(Object.hasOwn(result, 'cost_source'), false);
  }
});

test('stats 只有 API 费用总额，累计和仅自报费用计缺失，主持席不计缺失', async (t) => {
  const h = sandbox(t), meta = { model: base.model };
  seedRun(h, 'reported', { ...meta, agent_type: 'opencode cli' }, { cost_usd: 0.25 });
  seedRun(h, 'api', { ...meta, agent_type: 'api' }, { usage, usage_scope: 'this_run' });
  seedRun(h, 'subscription', meta, { usage, usage_scope: 'this_run' });
  seedRun(h, 'saved', meta, { cost_usd: 7, cost_source: 'subscription' });
  seedRun(h, 'cumulative', meta, { usage, usage_scope: 'session_total' });
  seedRun(h, 'host', { ...meta, participant: 'host' });
  seedRun(h, 'host-type', { agent_type: 'host', model: 'claude-code-host-type' });
  const rows = output(await h.bridge(['stats'])).rows, row = rows.find((r) => !r.participant), host = rows.find((r) => r.participant === 'host');
  assert.deepEqual(row.cost_usd, { total: 5.24, runs: 2, missing_runs: 3 });
  assert.deepEqual(Object.keys(row).filter((k) => k.startsWith('cost_')), ['cost_usd']);
  assert.deepEqual(host.cost_usd, { total: null, runs: 0, missing_runs: 0 });
  assert.deepEqual(Object.keys(host).filter((k) => k.startsWith('cost_')), ['cost_usd']);
  assert.deepEqual(rows.find((r) => r.model === 'claude-code-host-type').cost_usd, { total: null, runs: 0, missing_runs: 0 });
});

test('看板老来源重新计价，新来源保留，不输出自报和拆分费用', () => {
  const run = { id: 'synthetic', meta: { ...base, usage: null }, tail: { state: {} } };
  for (const [result, source, cost] of [
    [{ usage, usage_scope: 'this_run' }, 'api_price', 2.62],
    [{ agent_type: 'api', usage, usage_scope: 'this_run' }, 'api_price', 2.62],
    [{ agent_type: 'opencode cli', cost_usd: 0.25 }, 'unknown', null],
    [{ usage, usage_scope: 'session_total' }, 'unknown', null],
    [{ cost_source: 'api', cost_usd: 7 }, 'unknown', null],
    [{ cost_source: 'api', cost_usd: 7, usage }, 'api_price', 2.62],
    [{ cost_source: 'api_price', cost_usd: 7 }, 'api_price', 7],
  ]) {
    const message = runMessage({ ...run, result: { ...result, reported_cost_usd: 99 } }, run.id, prices);
    assert.equal(message.cost_source, source); assert.equal(message.cost_usd, cost);
    assert.equal(Object.hasOwn(message, 'cost_paid_usd'), false);
    assert.equal(Object.hasOwn(message, 'cost_subscription_usd'), false);
    assert.equal(Object.hasOwn(message, 'reported_cost_usd'), false);
  }
});

test('终端只显示 cost，中英两个插件一样写英文，未知费用隐藏，stats 说明使用约定原文', (t) => {
  const h = sandbox(t), url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/format.mjs')).href;
  const script = `import { usageLine } from ${JSON.stringify(url)}; console.log(JSON.stringify(['api_price','reported','api','subscription','unknown'].map(cost_source => usageLine({ cost_source, cost_usd: 0.125 }))));`;
  // 终端的用量行和状态词一样，中英两个插件都用英文那一套
  for (const lang of ['zh', 'en']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...h.env, FOREMAN_LANG: lang }, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['cost $0.125', '', '', '', '']);
  }
  assert.equal(MESSAGES.en.costUsd('0.12'), 'cost $0.12');
  assert.equal(MESSAGES.en.costUsd.length, 1);
  assert.ok(MESSAGES.zh.statsNotes.includes('费用（cost_usd）一律按模型官方 API 价格计算（插件自带的价格表 prices.json），和实际扣费不一定相同：Codex、Claude Code 用订阅时不按 token 扣钱，opencode、pi 的实际扣费以它们自己的账单为准。价格表里没有的模型算不出费用，计入 missing_runs。'));
  assert.ok(MESSAGES.en.statsNotes.includes("Cost (cost_usd) is always computed from each model's official API price (the plugin's price table, prices.json) and may differ from what you're actually charged: Codex and Claude Code on a subscription aren't charged per token, and opencode and pi bill through their own accounts. Models missing from the price table have no cost and count in missing_runs."));
});

test('续接相减得出负的用量时不计价，记为未知', () => {
  for (const field of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    for (const agent_type of ['codex cli', 'api', 'opencode cli', 'pi cli']) assert.deepEqual(costOf({ ...base, agent_type, usage: { ...usage, [field]: -10 } }, prices), unknown, field);
  }
});

test('各家对同一模型的写法都能匹配到价格，Claude 价格按官方页面', () => {
  const cached = (m) => priceFor(m, { cached: 1e6 }, prices);
  for (const [model, price] of [
    ['claude-opus-5-5@20261001', 0.2], ['anthropic.claude-opus-5-5-20261001-v1:0', 0.2],
    ['amazon-bedrock/global.anthropic.claude-fable-5-1', 0.25], ['anthropic/claude-fable-5.1', 0.25],
    ['claude-mythos-5-1', 0.25], ['claude-mythos-5', 1], ['claude-sonnet-5-5', 0.1], ['claude-sonnet-5', 0.2],
    ['opencode-go/glm-5.3-flash', 0.03], ['gpt-6.1-sol', 0.1],
  ]) assert.equal(cached(model), price, model);
  for (const model of ['glm-5.3-flashx', 'minimax-m3.1-flash', 'other-claude-opus-5-5']) assert.equal(cached(model), null, model);
});

test('amounts carry no floating-point tail and repeated lookups reuse the compiled table', () => {
  const table = { models: [{ match: ['m'], input: 1.1, cached: 0.11, output: 3.3 }] };
  for (let i = 1; i <= 500; i++) {
    const cost = priceFor('m', { input: i * 7, cached: i * 13, output: i * 3 }, table);
    assert.ok(!/\.\d{11,}/.test(String(cost)), String(cost));
  }
  assert.equal(priceFor('provider/m-2026', { output: 1e6 }, table), 3.3);
  assert.equal(priceFor('other', { output: 1 }, table), null);
});
