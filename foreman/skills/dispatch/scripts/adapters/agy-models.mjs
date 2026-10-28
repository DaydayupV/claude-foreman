// agy 把推理强度写在模型 ID 后缀里；配置和记录使用拆开的模型族、档位。
export const AGY_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function splitAgyModel(id) {
  const at = id.lastIndexOf('-'), effort = id.slice(at + 1);
  return at >= 0 && AGY_EFFORTS.includes(effort) ? { family: id.slice(0, at), effort } : { family: id, effort: null };
}

export function agyFamilies(ids) {
  const families = new Map();
  for (const id of ids) {
    const { family, effort } = splitAgyModel(id);
    if (!families.has(family)) families.set(family, { id: family, efforts: [], ids: {} });
    if (effort) families.get(family).ids[effort] = id;
    else families.get(family).plain = id;
  }
  return [...families.values()].map((family) => ({ ...family, efforts: AGY_EFFORTS.filter((e) => Object.hasOwn(family.ids, e)) }));
}

// 纯函数保留错误键和参数，适配器在显示时换成当前语言。
const fail = (code, args, message) => { throw Object.assign(new Error(message), { code, args }); };
export function agyModelId(model, effort, families) {
  const full = families.find((f) => Object.values(f.ids).includes(model));
  if (full) {
    if (!effort || effort === 'default') return model;
    fail('agyEffortFullId', [model, effort, full.id], `agy 的 model 已经写了带档位的完整 ID（${model}），不能再写 effort（${effort}）：把 model 改成 ${full.id}，档位写进 effort。`);
  }
  const family = families.find((f) => f.id === model);
  if (!family) {
    const ids = families.map((f) => f.id);
    fail('agyModelMissing', [model, ids], `agy models 里没有 ${model}，最接近的模型：${ids.join(', ')}。`);
  }
  const levels = family.efforts.join(' / ');
  if (!effort || effort === 'default') {
    if (family.plain) return family.plain;
    if (!family.efforts.length) return model;
    if (family.efforts.length === 1) return family.ids[family.efforts[0]];
    fail('agyEffortMissing', [model, levels], `agy 的 ${model} 有几档推理强度（${levels}），要在格子里写 effort。`);
  }
  if (!Object.hasOwn(family.ids, effort)) fail('agyEffortUnknown', [model, effort, levels], `agy 没有 ${model} 的 ${effort} 档；能选的：${levels || '没有可选档位，effort 不写'}。`);
  return family.ids[effort];
}
