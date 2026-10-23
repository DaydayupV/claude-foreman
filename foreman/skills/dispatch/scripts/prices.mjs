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

export function priceFor(model, usage, prices) {
  const name = modelKey(model);
  const entries = prices?.models.flatMap((rate) => rate.match.map((s) => ({ rate, match: s.toLowerCase() }))) ?? [];
  // 先精确匹配，版本后缀只认连字符边界，并优先最长模型名。
  const rate = entries.find((p) => name === p.match)?.rate
    ?? entries.filter((p) => name.startsWith(`${p.match}-`)).sort((a, b) => b.match.length - a.match.length)[0]?.rate;
  if (!rate || !usage) return null;
  return ((usage.input ?? 0) * rate.input + (usage.cached ?? 0) * (rate.cached ?? rate.input)
    + (usage.cache_write ?? 0) * (rate.cache_write ?? rate.input) + (usage.output ?? 0) * rate.output) / 1e6;
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
