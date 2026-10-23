import fs from 'node:fs';

// 插件自带的价格表只读一次：终端实时查看每次重画用量行都要用到
let bundled;
export function loadPrices(file) {
  if (file == null) return bundled === undefined ? (bundled = readPrices(new URL('./prices.json', import.meta.url))) : bundled;
  return readPrices(file);
}
function readPrices(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// 各家对同一个模型的写法：去掉提供方前缀（opencode-go/、openrouter 的 anthropic/、Bedrock 的 global.anthropic.），
// 版本后缀的 @、: 当成连字符（Vertex 的 claude-opus-5-5@20261001、Bedrock 的 …-v1:0），
// Claude 模型名里的小数版本号写成连字符（OpenRouter 的 claude-fable-5.1）。其他模型名里的点是名字的一部分，不动
export function modelKey(model) {
  let name = String(model ?? '').split('/').at(-1).toLowerCase().replace(/^(?:[a-z0-9-]+\.)*anthropic\./, '').replace(/[@:]/g, '-');
  if (name.startsWith('claude-')) name = name.replace(/(\d)\.(\d)/g, '$1-$2');
  return name;
}

// 同一个模型的不同写法归成一个身份（"不同的基础模型"按它比较，stats 按它分行）：modelKey 处理提供方前缀和版本写法，
// 价格表的 aliases 只记官方说明是同一个模型的别名（同价不等于同一个模型，比如 Fable 和 Mythos 共用一条价格）
export function modelIdentity(model, prices = loadPrices()) {
  const key = modelKey(model);
  return prices?.aliases?.[key] ?? key;
}

// 每张价格表只编译一次，模型名查到的价格也记住：看板每秒要给每条用量查价，每次重建匹配表会占掉大半 CPU
const compiled = new WeakMap();
function rateOf(model, prices) {
  if (!prices?.models) return null;
  let table = compiled.get(prices);
  if (!table) {
    table = { entries: prices.models.flatMap((rate) => rate.match.map((s) => ({ rate, match: s.toLowerCase() }))), names: new Map() };
    compiled.set(prices, table);
  }
  const name = modelKey(model);
  if (!table.names.has(name)) {
    // 先精确匹配，版本后缀只认连字符边界，并优先最长模型名。
    table.names.set(name, table.entries.find((p) => name === p.match)?.rate
      ?? table.entries.filter((p) => name.startsWith(`${p.match}-`)).sort((a, b) => b.match.length - a.match.length)[0]?.rate ?? null);
  }
  return table.names.get(name);
}

// 金额留到 1e-10 美元：浮点乘除的尾巴（0.43190959999999995）不写进记录
const usd = (value) => Math.round(value * 1e10) / 1e10;

export function priceFor(model, usage, prices) {
  const rate = rateOf(model, prices);
  if (!rate || !usage) return null;
  return usd(((usage.input ?? 0) * rate.input + (usage.cached ?? 0) * (rate.cached ?? rate.input)
    + (usage.cache_write ?? 0) * (rate.cache_write ?? rate.input) + (usage.output ?? 0) * rate.output) / 1e6);
}

export function costOf(result, prices) {
  const unknown = { cost_usd: null, cost_source: 'unknown' };
  // Claude Code 席自己提交的报告不计费用。
  if (result.participant === 'host' || result.agent_type === 'host') return unknown;
  if (['api_price', 'unknown'].includes(result.cost_source)) return { cost_usd: result.cost_usd ?? null, cost_source: result.cost_source };
  const { usage } = result;
  // 和 util.mjs 的 agentTypeOf 保持一致，看板单独加载时不引入终端依赖。
  const agent_type = ({ codex: 'codex cli', opencode: 'opencode cli', 'openai-compatible': 'api' })[result.agent_type] || result.agent_type || 'codex cli';
  const usage_scope = result.usage_scope ?? (result.mode === 'resume' ? 'session_total' : 'this_run');
  if (['api', 'codex cli', 'opencode cli', 'pi cli'].includes(agent_type) && usage_scope === 'this_run'
    && usage && [usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens, usage.output_tokens].some((n) => n != null)
    // 续接相减时会话累计倒退会得出负数：这轮用量不可信，不计价（和 stats 的处理一致）
    && !Object.values(usage).some((n) => n < 0)) {
    const model = agent_type === 'api' ? result.model_shown || result.model : result.model || result.model_name || result.model_shown;
    // 输入扣除缓存命中和写入，最低按 0，避免重复计费。
    const cost = priceFor(model, {
      input: Math.max(0, (usage.input_tokens ?? 0) - (usage.cached_input_tokens ?? 0) - (usage.cache_write_input_tokens ?? 0)),
      cached: usage.cached_input_tokens, cache_write: usage.cache_write_input_tokens, output: usage.output_tokens,
    }, prices);
    if (cost != null) return { cost_usd: cost, cost_source: 'api_price' };
  }
  return unknown;
}
