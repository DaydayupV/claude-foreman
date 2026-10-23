import fs from 'node:fs';

export function loadPrices(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function priceFor(model, usage, prices) {
  const name = String(model ?? '').split('/').at(-1).toLowerCase();
  const rate = prices?.models.find((p) => p.match.some((s) => name.includes(s.toLowerCase())));
  if (!rate || !usage) return null;
  return ((usage.input ?? 0) * rate.input + (usage.cached ?? 0) * (rate.cached ?? rate.input)
    + (usage.cache_write ?? 0) * (rate.cache_write ?? rate.input) + (usage.output ?? 0) * rate.output) / 1e6;
}
