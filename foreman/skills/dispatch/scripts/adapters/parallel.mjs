// 各类协作方的默认并发上限。单独成文件、不 import 任何东西：config 和 records 都要用它，
// 从 adapters/index.mjs 取会形成循环引用（index → 各适配器 → config / records）。
export const DEFAULT_AGENT_PARALLEL = 4;
const BY_TYPE = { 'agy cli': 2 };

export const defaultMaxParallel = (type) => BY_TYPE[type] ?? DEFAULT_AGENT_PARALLEL;
export const agentMaxParallel = (agent) => agent?.max_parallel ?? defaultMaxParallel(agent?.type);
