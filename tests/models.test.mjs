import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { loadModels, modelKey, modelIdentity, modelInfo } from '../foreman/skills/dispatch/scripts/models.mjs';
import { loadPrices, priceFor, modelKey as priceKey, modelIdentity as priceIdentity } from '../foreman/skills/dispatch/scripts/prices.mjs';
import { ROOT, sandbox, write } from './helpers.mjs';

const catalog = loadModels(), prices = loadPrices();

test('身份表的键和别名都是规范写法，别名唯一且不与其他身份冲突', () => {
  const aliases = new Set(), ids = new Set(Object.keys(catalog.models));
  for (const [id, info] of Object.entries(catalog.models)) {
    assert.equal(modelKey(id), id);
    for (const alias of info.aliases) {
      assert.equal(modelKey(alias), alias);
      assert.ok(!aliases.has(alias), `重复别名：${alias}`);
      assert.ok(!ids.has(alias) || alias === id, `别名与身份冲突：${alias}`);
      aliases.add(alias);
      assert.equal(modelIdentity(alias), id);
    }
  }
});

test('价格表所有 match 都有身份，起始配置模型都有身份和价格', () => {
  const names = new Set(Object.entries(catalog.models).flatMap(([id, info]) => [id, ...info.aliases]));
  const knownExceptions = {}; // 当前没有身份表外的价格名称；以后有例外时须在这里说明原因。
  for (const name of prices.models.flatMap((entry) => entry.match)) {
    assert.ok(names.has(name) || knownExceptions[name], `价格名称未收录：${name}`);
  }
  assert.equal(Object.hasOwn(prices, 'aliases'), false);
  const source = fs.readFileSync(path.join(ROOT, 'foreman/skills/dispatch/scripts/config.mjs'), 'utf8');
  const starters = runInNewContext(source.match(/const API_STARTERS = (\[[\s\S]*?\n\]);/)[1]);
  for (const name of [...starters.map(([, , , model]) => model), 'gpt-6.1-sol', 'gpt-6-astra']) {
    assert.equal(modelInfo(name).known, true, name);
    assert.notEqual(priceFor(name, { input: 1e6 }, prices), null, name);
  }
});

test('模型身份统一前缀、Claude 版本和空白，Fable 与 Mythos 保持独立', () => {
  assert.equal(priceKey, modelKey);
  assert.equal(priceIdentity, modelIdentity);
  for (const [name, id] of [
    ['opencode-go/deepseek-v4.1-flash-1017', 'deepseek-flash'],
    ['claude-fable-5.1', 'claude-fable-5-1'],
    ['gemini-4-argon-contributor', 'gemini-4-argon'],
    ['provider/Claude\tFable  5.1', 'claude-fable-5-1'],
    ['gemini-3.8-flash-high', 'gemini-3.8-flash'],
    ['gemini-3.8-flash-low', 'gemini-3.8-flash'],
    ['gpt-oss-120b-medium', 'gpt-oss-120b'],
  ]) assert.equal(modelIdentity(name), id);
  assert.notEqual(modelIdentity('claude-fable-5.1'), modelIdentity('claude-mythos-5.1'));
  assert.equal(modelIdentity('kimi-k3.1-pro-highspeed'), modelIdentity('kimi-k3.1-pro'));
  assert.equal(priceFor('kimi-k3.1-pro-highspeed', { input: 1e6 }, prices), 4);
  assert.equal(priceFor('kimi-k3.1-pro', { input: 1e6 }, prices), 2);
  for (const [family, full] of [['gemini-3.8-flash', 'gemini-3.8-flash-high'], ['gpt-oss-120b', 'gpt-oss-120b-medium']]) {
    assert.equal(priceFor(family, { input: 1e6, output: 1e6 }, prices), priceFor(full, { input: 1e6, output: 1e6 }, prices));
  }
});

test('身份表按需加载，modelInfo 保留未知模型原名', (t) => {
  const h = sandbox(t);
  assert.equal(loadModels(), catalog);
  const custom = loadModels(write(path.join(h.home, 'models.json'), { models: {
    custom: { display: 'Custom', family: 'custom', vendor: 'example', aliases: ['custom-fast'] },
  } }));
  assert.deepEqual(modelInfo('provider/CUSTOM-FAST', custom), { id: 'custom', display: 'Custom', family: 'custom', vendor: 'example', known: true });
  assert.deepEqual(modelInfo('provider/Unknown Model', custom), { id: 'unknown-model', display: 'provider/Unknown Model', family: null, vendor: null, known: false });
  assert.equal(loadModels(path.join(h.home, 'missing.json')), null);
  assert.equal(modelIdentity('provider/CUSTOM-FAST', null), 'custom-fast');
});
