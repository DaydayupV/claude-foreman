import fs from 'node:fs';
import { loadModels, modelKey, modelInfo } from './models.mjs';
import { splitAgyModel } from './adapters/agy-models.mjs';

let bundled;
export function loadTiers(file) {
  if (file == null) return bundled === undefined ? (bundled = readTiers(new URL('./model-tiers.json', import.meta.url))) : bundled;
  return readTiers(file);
}
function readTiers(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const tierFor = (overall, thresholds) => overall >= thresholds.strong ? 'strong' : overall >= thresholds.mid ? 'mid' : 'weak';
const compiled = new WeakMap();
function comparisonOf(tiers) {
  let result = compiled.get(tiers);
  if (result) return result;
  const scored = Object.values(tiers.models).filter((entry) => entry.scores);
  const medians = { strong: {}, mid: {}, weak: {} }, top = {};
  for (const dim of tiers.dimensions) {
    top[dim] = Math.max(...scored.map((entry) => entry.scores[dim]).filter(Number.isFinite));
    for (const tier of Object.keys(medians)) {
      // 长短处只和同档模型的中位数比；旧表没有分数的条目不参与。
      const values = scored.filter((entry) => tierFor(entry.overall, tiers.thresholds) === tier)
        .map((entry) => entry.scores[dim]).filter(Number.isFinite).sort((a, b) => a - b);
      const mid = Math.floor(values.length / 2);
      if (values.length) medians[tier][dim] = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
    }
  }
  result = { medians, top };
  compiled.set(tiers, result);
  return result;
}

export function tierOf(model, { tiers = loadTiers(), catalog = loadModels() } = {}) {
  let info = modelInfo(model, catalog);
  if (tiers?.models?.[modelKey(model)]) info = { ...info, id: modelKey(model) };
  else if (!tiers?.models?.[info.id]) {
    const base = modelInfo(splitAgyModel(info.id).family, catalog);
    if (tiers?.models?.[base.id]) info = base;
  }
  const { id, display, family } = info, entry = tiers?.models?.[id];
  const result = { id, display, family, rated: !!entry, tier: null, overall: null, strengths: [], weaknesses: [], top: [],
    source: null, checked: null, open: null, cost_per_task: null };
  if (!entry) return result;
  const source = tiers.sources[entry.source];
  Object.assign(result, { source: source?.name ?? null, checked: source?.checked ?? null,
    open: entry.open ?? null, cost_per_task: entry.cost_per_task ?? null });
  if (!entry.scores) return { ...result, tier: entry.tier, strengths: entry.strengths ?? [], weaknesses: entry.weaknesses ?? [] };
  const tier = tierFor(entry.overall, tiers.thresholds), comparison = comparisonOf(tiers);
  const deltas = tiers.dimensions.filter((dim) => Number.isFinite(entry.scores[dim]) && comparison.medians[tier][dim] != null)
    .map((dim) => ({ dim, delta: Math.round((entry.scores[dim] - comparison.medians[tier][dim]) * 10) / 10 }));
  return { ...result, tier, overall: entry.overall,
    strengths: deltas.filter(({ delta }) => delta >= 5).sort((a, b) => b.delta - a.delta).slice(0, 3).map(({ dim }) => dim),
    weaknesses: deltas.filter(({ delta }) => delta <= -5).sort((a, b) => a.delta - b.delta).slice(0, 3)
      .map(({ dim, delta }) => ({ dim, level: delta <= -15 ? 'very_weak' : 'weak' })),
    top: tiers.dimensions.filter((dim) => entry.scores[dim] === comparison.top[dim]),
  };
}
