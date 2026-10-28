import fs from 'node:fs';
import { splitAgyModel } from './adapters/agy-models.mjs';

let bundled;
export function loadModels(file) {
  if (file == null) return bundled === undefined ? (bundled = readModels(new URL('./models.json', import.meta.url))) : bundled;
  return readModels(file);
}
function readModels(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// 各家对同一个模型的写法：去掉提供方前缀（opencode-go/、openrouter 的 anthropic/、Bedrock 的 global.anthropic.），
// 空白换成连字符（展示名），版本后缀的 @、: 当成连字符（Vertex 的 claude-opus-5-5@20261001、Bedrock 的 …-v1:0），
// Claude 模型名里的小数版本号写成连字符（OpenRouter 的 claude-fable-5.1）。其他模型名里的点是名字的一部分，不动
export function modelKey(model) {
  let name = String(model ?? '').split('/').at(-1).toLowerCase().replace(/\s+/g, '-').replace(/^(?:[a-z0-9-]+\.)*anthropic\./, '').replace(/[@:]/g, '-');
  if (name.startsWith('claude-')) name = name.replace(/(\d)\.(\d)/g, '$1-$2');
  return name;
}

// 同一个模型的不同写法归成一个身份（"不同的基础模型"按它比较，stats 按它分行）。别名只记 models.json 里确认过的，
// 同价不等于同一个模型（Fable 和 Mythos 共用一条价格，是两个身份）；别名表每个身份表只编译一次
const compiled = new WeakMap();
export function modelIdentity(model, catalog = loadModels()) {
  const key = modelKey(model);
  if (!catalog?.models || Object.hasOwn(catalog.models, key)) return key;
  let aliases = compiled.get(catalog);
  if (!aliases) {
    aliases = new Map(Object.entries(catalog.models).flatMap(([id, info]) => (info.aliases ?? []).map((alias) => [alias, id])));
    compiled.set(catalog, aliases);
  }
  const family = splitAgyModel(key).family;
  return aliases.get(key) ?? (Object.hasOwn(catalog.models, family) ? family : aliases.get(family)) ?? key;
}

export function modelInfo(model, catalog = loadModels()) {
  const id = modelIdentity(model, catalog), info = catalog?.models?.[id];
  return { id, display: info?.display ?? model, family: info?.family ?? null, vendor: info?.vendor ?? null, known: !!info };
}
