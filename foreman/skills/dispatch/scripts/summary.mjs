// 总配置情况：按模块、按协作方整理一遍，再列出值得注意的地方。config 和 check 共用；check 时带上检查结果。
import path from 'node:path';
import { USER_CONFIG, CLAUDE_CODE, cellList, mapCells, staleAliases, readRawConfig, readOldBackups } from './config.mjs';
import { M, isObject } from './util.mjs';
import { loadPrices, priceFor } from './prices.mjs';
import { tierOf } from './tiers.mjs';

// checks 是 check 输出里的 agents；没有时（config）各项的 ok 为 null。keepBackup 是不算旧备份的那个文件。
export function buildSummary(cfg, adapters, checks = null, keepBackup = null) {
  const agents = {}, warnings = [...cfg.project_warnings], models = new Map(), raw = readRawConfig();
  const userModules = raw?.modules?.default ? raw.modules : { default: raw?.modules || raw?.levels || {} };
  for (const [name, agent] of Object.entries(cfg.agents)) {
    agents[name] = { type: agent.type, model: agent.model ?? adapters[agent.type].status(agent).model ?? null, used_at: [],
      ...(agent.run_access ? { run_access: agent.run_access } : {}), ok: checks?.[name] ? checks[name].ok : null };
  }
  // 某一格用到的"模型 + 推理强度"在检查里不通过时，带上原因。
  const tried = (name) => [...(checks?.[name]?.variants || []), ...(checks?.[name]?.efforts || [])];
  const effortProblem = (name, model, effort) => tried(name).find((v) => v.model === model && v.variant === effort && v.ok === false)?.error ?? null;
  // 推理强度只在基本检查通过后才核对，所以有档位不通过，就说明协作方本身能用，只是那几格的档位有问题。
  const usable = (name) => !!checks?.[name] && (checks[name].ok || tried(name).some((v) => v.ok === false));
  const scene_modules = Object.fromEntries(Object.entries(cfg.scene_modules).map(([scene, modules]) => [scene, mapCells(modules, (entry, { module, cell }) => {
    if (entry === CLAUDE_CODE || entry === null) return entry;
    return cellList(entry).map((item, i) => {
      const project = cfg.project_config, own = project?.cells.includes(`${scene}.${module}.${cell}`);
      const inherited = scene !== 'default' && project?.cells.includes(`default.${module}.${cell}`);
      const written = scene === 'default' || own || !inherited && Object.hasOwn(userModules[scene]?.[module] || {}, cell);
      const at = `${own ? `${project.path}: ` : ''}modules.${scene}.${module}.${cell}[${i}]`;
      const info = agents[item.agent], model = item.model || info.model, effort = item.effort ?? null;
      if (written) info.used_at.push(at);
      if (model && written) {
        if (!models.has(model)) models.set(model, { model, used_at: [] });
        models.get(model).used_at.push(at);
      }
      const problem = effort == null ? null : effortProblem(item.agent, model, effort);
      const ok = !checks?.[item.agent] ? null : usable(item.agent) && !problem;
      return { agent: item.agent, type: info.type, model, effort, required: !!item.required, ok, ...(problem ? { problem } : {}) };
    });
  })]));
  const modules = scene_modules.default;
  for (const [name, info] of Object.entries(agents)) {
    if (!info.used_at.length) warnings.push({ kind: 'unused_agent', agent: name, message: M.warnUnusedAgent(name) });
    if (cfg.agents[name].api_key) warnings.push({ kind: 'plaintext_key', agent: name, message: M.warnPlaintextKey(name) });
    const locations = info.used_at.map((at) => at.slice(at.lastIndexOf('modules.')).replace(/^modules\.[^.]+\./, 'modules.'));
    const modes = ['review', 'discuss'].filter((mode) => locations.some((at) => at.startsWith(`modules.${mode}.`))
      && adapters[info.type].readonlyLevel(cfg.agents[name], mode) === 'audited');
    if (modes.length) warnings.push({ kind: 'readonly_audited', agent: name, modes,
      message: M.warnReadonlyAudited(name, M.list(modes.map((mode) => M.modeNames[mode]))) });
    if (info.run_access === 'shell' && locations.some((at) => at.startsWith('modules.run.') || at.startsWith('modules.image.draw['))) warnings.push({ kind: 'shell_access', agent: name, message: M.warnShellAccess(name) });
  }
  for (const { old, target, closest } of staleAliases(cfg)) {
    warnings.push({ kind: 'stale_alias', agent: old, message: M.warnStaleAlias(old, target, closest.length ? M.list(closest) : '') });
  }
  const prices = loadPrices();
  const unpriced = [...models.values()].filter(({ model }) => priceFor(model, { input: 0 }, prices) == null);
  const unrated = [...models.values()].filter(({ model }) => !tierOf(model).rated);
  if (unpriced.length) warnings.push({ kind: 'unpriced_models', models: unpriced, message: M.warnUnpricedModels(M.list(unpriced.map(({ model }) => model))) });
  if (unrated.length) warnings.push({ kind: 'unrated_models', models: unrated, message: M.warnUnratedModels(M.list(unrated.map(({ model }) => model))) });
  if (raw?.dispatch && Object.hasOwn(raw.dispatch, 'max_seats')) warnings.push({ kind: 'obsolete_max_seats', value: raw.dispatch.max_seats, message: M.reportObsoleteMaxSeats });
  if (raw && Object.hasOwn(raw, 'projects')) {
    const keys = Object.keys(raw.projects || {}), entries = {}, dropped = {};
    for (const dir of keys) {
      const entry = {}, removed = [];
      const clean = (value, at) => Array.isArray(value) ? value.map((v, i) => clean(v, `${at}[${i}]`)) : isObject(value)
        ? Object.fromEntries(Object.entries(value).filter(([key]) => { if (key !== 'api_key') return true; removed.push(`${at}.api_key`); return false; })
          .map(([key, v]) => [key, clean(v, `${at}.${key}`)])) : value;
      for (const [key, value] of Object.entries(raw.projects[dir] || {})) {
        if (key === 'modules') {
          const modules = clean(value, 'modules');
          entry.modules = !Object.keys(modules || {}).length || Object.keys(modules).some((key) => ['discuss', 'review', 'run', 'image'].includes(key)) ? { default: modules } : modules;
        } else if (key === 'dispatch' && isObject(value)) {
          entry.dispatch = clean(Object.fromEntries(Object.entries(value).filter(([field]) => {
            if (['discuss_max_rounds', 'timeout_min', 'stall_min', 'busy_ask_min'].includes(field)) return true;
            removed.push(`dispatch.${field}`); return false;
          })), 'dispatch');
        } else removed.push(key);
      }
      entries[dir] = entry;
      if (removed.length) dropped[dir] = removed;
    }
    warnings.push({ kind: 'obsolete_projects', keys, entries, dropped, message: M.obsoleteProjects(M.list(keys)) });
  }
  for (const [agent, info] of Object.entries(cfg.agents)) if (info.type === 'api' && info.api_key && info.api_key_env) {
    warnings.push({ kind: 'obsolete_key_env', agent, api_key_env: info.api_key_env, env_set: !!process.env[info.api_key_env], message: M.reportObsoleteKeyEnv(agent, info.api_key_env) });
  }
  const backups = readOldBackups(keepBackup);
  if (backups?.files.length) warnings.push({ kind: 'old_backups', ...backups, message: M.reportOldBackups(path.dirname(USER_CONFIG), backups.files.length, backups.contain_keys) });
  if (typeof raw?.levels === 'string') warnings.push({ kind: 'legacy_levels_note', message: M.reportLegacyLevelsNote });
  return { modules, scene_modules, agents, warnings };
}
