// 配置路径、改名迁移、合并校验和任务等级选择；类型字段校验由调用方传入。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { HERE, M, notice, isObject, readJson, die, pidAlive, retryBusy, replaceFile, closestMatches } from './util.mjs';

const ENTRY = path.join(HERE, 'cli.mjs');
const SCHEMA = path.join(HERE, '..', 'schemas', 'report.schema.json');
const DISCUSS_SCHEMA = path.join(HERE, '..', 'schemas', 'discuss.schema.json');
const REVIEW_SCHEMA = path.join(HERE, '..', 'schemas', 'review.schema.json');

// 改名前（codex-bridge）用的位置，只用于迁移和兼容。
const LEGACY_CONFIG = process.env.CODEX_BRIDGE_CONFIG || path.join(os.homedir(), '.claude', 'codex-bridge.json');
const LEGACY_PREFS = path.join(path.dirname(LEGACY_CONFIG), 'codex-bridge.md');
const LEGACY_RUNS = path.join(os.homedir(), '.claude', 'codex-runs');
const LEGACY_PROJECT_CONFIG = path.join('.claude', 'codex-bridge.json');
const LEGACY_PROJECT_PREFS = path.join('.claude', 'codex-bridge.md');

// 环境变量改了名，旧名字还认，用到时提示一句（同一个进程只提示一次）。
const legacyEnvNoticed = new Set();
function envOf(name, legacy) {
  if (process.env[name]) return process.env[name];
  if (!process.env[legacy]) return undefined;
  if (!legacyEnvNoticed.has(legacy)) { legacyEnvNoticed.add(legacy); notice(M.legacyEnv(legacy, name)); }
  return process.env[legacy];
}

const HOME_DIR = path.join(os.homedir(), '.claude', 'foreman');
const CUSTOM_CONFIG = envOf('FOREMAN_CONFIG', 'CODEX_BRIDGE_CONFIG');
const USER_CONFIG = CUSTOM_CONFIG || path.join(HOME_DIR, 'config.json');
const USER_PREFS = path.join(path.dirname(USER_CONFIG), 'preferences.md');
const PROJECT_CONFIG = path.join('.claude', 'foreman.json');
const PROJECT_PREFS = path.join('.claude', 'foreman.md');

// 改名迁移：第一次运行时把旧配置和旧偏好复制到新位置，旧文件保留。用户用环境变量指定了配置路径时不动。
function migrateLegacyFiles() {
  if (CUSTOM_CONFIG) return;
  for (const [from, to, msg] of [[LEGACY_CONFIG, USER_CONFIG, M.legacyConfigCopied], [LEGACY_PREFS, USER_PREFS, M.legacyPrefsCopied]]) {
    if (fs.existsSync(to) || !fs.existsSync(from)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      notice(msg(from, to));
    } catch (e) { if (e.code !== 'EEXIST') notice(M.legacyCopyFailed(from, e.message)); } // 并发启动时别的进程先复制了
  }
}
migrateLegacyFiles();

// 项目里的文件还是旧名字时照常读取，提示改名，不改动项目里的文件。
function projectFile(cwd, current, legacy) {
  const file = path.join(cwd, current);
  const old = path.join(cwd, legacy);
  if (fs.existsSync(file) || !fs.existsSync(old)) return file;
  notice(M.projectLegacyName(old, file));
  return old;
}

const DEFAULT_AGENT_PARALLEL = 4;
const LEVELS = ['simple', 'normal', 'complex'];
const MODES = ['run', 'review', 'discuss'];
const CLAUDE_CODE = 'claude code';
const MODULE_CELLS = { discuss: LEVELS, run: LEVELS, review: LEVELS, image: ['generate', 'draw'] };
const ROUTE_CELLS = { 1: ['generate'], 2: ['generate', 'draw'], 3: ['generate', 'draw'], 4: ['draw'] };
// 出图声明和两项检测接口齐全，才可以接 generate 格子。
const canGenerate = (adapter) => adapter.capabilities.images === true && typeof adapter.images?.list === 'function' && typeof adapter.images?.calls === 'function';
const cellList = (value) => Array.isArray(value) ? value : isObject(value) ? [value] : [];
function eachCell(modules) {
  return Object.entries(MODULE_CELLS).flatMap(([module, cells]) => cells.filter((cell) => Object.hasOwn(modules?.[module] || {}, cell))
    .map((cell) => ({ module, cell, key: `modules.${module}.${cell}`, value: modules[module][cell] })));
}
function eachEntry(modules) {
  return eachCell(modules).flatMap(({ module, cell, key, value }) => cellList(value)
    .map((item, index) => ({ module, cell, key, index, at: `${key}[${index}]`, item })));
}
function mapCells(modules, fn) {
  const out = Object.fromEntries(Object.entries(modules).map(([module, cells]) => [module, isObject(cells) ? { ...cells } : cells]));
  for (const { module, cell, key, value } of eachCell(modules)) out[module][cell] = fn(value, { module, cell, key });
  return out;
}
const normalizeModules = (cfg) => !isObject(cfg.modules) || !isObject(cfg.agents) ? cfg : ({ ...cfg, modules: mapCells(cfg.modules, (value) => !isObject(value) && !Array.isArray(value) ? value
  : cellList(value).map((item) => isObject(item) ? { ...item, agent: resolveAgentAlias(item.agent, cfg) } : item)) });
const DEFAULT_CONFIG = {
  dispatch: { auto: true, watch: 'auto', intro: true, discuss_max_rounds: 2, timeout_min: 480, stall_min: 40, busy_ask_min: 2, max_seats: 6, runs_dir: null },
  agents: {},
  modules: { ...Object.fromEntries(MODES.map((mode) => [mode, Object.fromEntries(LEVELS.map((lv) => [lv, CLAUDE_CODE]))])), image: { generate: null, draw: null } },
};

// 只在迁移时使用旧默认值，还原逐字段继承后的实际配置。
const CODEX_LEVEL_FALLBACK = Object.fromEntries(LEVELS.map((lv, i) => [lv, { agent: 'codex', effort: ['medium', 'high', 'max'][i] }]));
const LEGACY_DEFAULT_CONFIG = {
  ...DEFAULT_CONFIG,
  agents: { codex: { type: 'codex', bin: null, model: null, max_parallel: 4, sandbox: { run: null, review: null, discuss: null }, approval: null } },
  modules: { run: { simple: 'claude', normal: 'claude', complex: CODEX_LEVEL_FALLBACK.complex },
    review: CODEX_LEVEL_FALLBACK, discuss: Object.fromEntries(LEVELS.map((lv) => [lv, [CODEX_LEVEL_FALLBACK[lv]]])) },
};
const OLD_TYPES = { codex: 'codex cli', opencode: 'opencode cli', 'openai-compatible': 'api' };
const migratedConfigs = new Map();
let memoryAliases = {};
const aliasesFile = path.join(path.dirname(USER_CONFIG), 'agent-aliases.json');
const readAgentAliases = () => ({ ...(readJson(aliasesFile) || {}), ...memoryAliases });

function resolveAgentAlias(name, cfg, announce = false) {
  const aliases = readAgentAliases(), seen = new Set();
  let resolved = name;
  while (!Object.hasOwn(cfg.agents, resolved) && aliases[resolved] && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = aliases[resolved];
  }
  if (announce && resolved !== name) notice(M.legacyAgentAlias(name, resolved));
  return resolved;
}

function staleAliases(cfg) {
  return Object.keys(readAgentAliases()).filter((old) => !Object.hasOwn(cfg.agents, old)).map((old) => [old, resolveAgentAlias(old, cfg)])
    .filter(([, target]) => !Object.hasOwn(cfg.agents, target))
    .map(([old, target]) => ({ old, target, closest: closestMatches(target, Object.keys(cfg.agents)) }));
}

// 代号写错时，提示里带上最接近的代号。
const unknownAgentError = (key, name, cfg) => {
  const near = closestMatches(name, Object.keys(cfg.agents));
  return (key === '--agent' ? M.unknownAgentFlag(name) : M.unknownAgent(key, name)) + (near.length ? M.closestHint(M.list(near)) : '');
};

function mergeConfig(base, extra) {
  const out = { ...base };
  for (const k of ['dispatch', 'agents', 'modules']) {
    if (!extra || !(k in extra)) continue;
    const v = extra[k];
    out[k] = isObject(v) ? { ...base[k], ...v } : v;
    if (k === 'modules' && isObject(v)) {
      for (const { module, cell, value } of eachCell(base.modules)) {
        if (isObject(out.modules[module]) && !Object.hasOwn(out.modules[module], cell)) out.modules[module] = { ...out.modules[module], [cell]: value };
      }
    }
    if (k === 'agents' && isObject(v)) {
      for (const [name, value] of Object.entries(v)) {
        out[k][name] = isObject(value) ? { ...base[k]?.[name], ...value } : value;
        if (k === 'agents' && isObject(value?.sandbox)) out[k][name].sandbox = { ...base[k]?.[name]?.sandbox, ...value.sandbox };
      }
    }
  }
  return out;
}

function migrateConfig(config, file, base, project) {
  if (!isObject(config)) die(M.configInvalid(file, M.invalid.object));
  // 改写成 modules 时 levels 留成一行说明（见 migrateStructure），它和 modules 同时出现是正常的，读的时候跳过。
  const note = typeof config.levels === 'string' && Object.hasOwn(config, 'modules') ? config.levels : null;
  const hasLevels = Object.hasOwn(config, 'levels') && note === null;
  if (hasLevels && Object.hasOwn(config, 'modules')) die(M.configBothFormats(file));
  if (hasLevels && !isObject(config.levels)) die(M.configInvalid('levels', M.invalid.object));
  const { levels, ...current } = config;
  if (hasLevels) current.modules = levels;
  const oldKeys = ['auto_dispatch', 'watch', 'discuss_max_rounds', 'codex_bin', 'model', 'max_parallel', 'sandbox', 'approval', 'timeout_min', 'stall_min', 'runs_dir'];
  const old = oldKeys.some((key) => Object.hasOwn(config, key))
    || Object.values(config.agents || {}).some((a) => Object.hasOwn(OLD_TYPES, a?.type))
    || eachCell(current.modules).some(({ value }) => value === 'claude')
    || hasLevels && eachEntry(current.modules).some(({ item }) => isObject(item) && !Object.hasOwn(item, 'agent'));
  const codexName = project ? resolveAgentAlias('codex', base) : 'codex';
  const legacy = { dispatch: {}, agents: { [codexName]: project ? {} : { type: 'codex' } } };
  for (const key of oldKeys) {
    if (!Object.hasOwn(config, key)) continue;
    if (['model', 'max_parallel', 'sandbox', 'approval', 'codex_bin'].includes(key)) legacy.agents[codexName][key === 'codex_bin' ? 'bin' : key] = config[key];
    else legacy.dispatch[key === 'auto_dispatch' ? 'auto' : key] = config[key];
  }
  let result = old ? mergeConfig(legacy, current) : current;
  for (const key of oldKeys) delete result[key];
  if (isObject(result.modules)) result.modules = mapCells(result.modules, (value, { module, cell }) => {
    if (value === 'claude') return CLAUDE_CODE;
    if (!isObject(value) && !Array.isArray(value)) return value;
    if (old && !Object.hasOwn(config, 'modules') && module !== 'discuss' && isObject(value)) {
      const target = resolveAgentAlias(value.agent ?? codexName, base);
      const prev = cellList(base.modules?.[module]?.[cell]).find((item) => resolveAgentAlias(item.agent, base) === target) || CODEX_LEVEL_FALLBACK[cell];
      return [{ ...prev, ...value, agent: value.agent ?? codexName }];
    }
    if (old && isObject(value) && !Object.hasOwn(value, 'agent')) {
      const list = cellList(base.modules?.[module]?.[cell]);
      const prev = list.find((item) => resolveAgentAlias(item?.agent, base) === codexName);
      const merged = { ...(prev || CODEX_LEVEL_FALLBACK[cell]), ...value, agent: codexName };
      if (module === 'discuss') return prev ? list.map((item) => item === prev ? merged : item) : [merged, ...list];
      return [merged];
    }
    return cellList(value).map((item) => {
      if (!old || !isObject(item) || Object.hasOwn(item, 'agent')) return item;
      const converted = { agent: codexName, ...item };
      if (!project && converted.model === null) delete converted.model;
      return converted;
    });
  });
  if (old && !project) result = mergeConfig(Object.hasOwn(config, 'modules') ? DEFAULT_CONFIG : LEGACY_DEFAULT_CONFIG, result);
  if (old && isObject(result.modules)) result.modules = mapCells(result.modules, (value) => value === 'claude' ? CLAUDE_CODE : isObject(value) ? [value] : value);
  if (project && (old || hasLevels)) notice(M.projectOldFormat(file));
  return { config: result, old, modules: hasLevels, note };
}

function renameAgentsByModel(config, adapters) {
  const agents = {}, aliases = {};
  const nameOf = (name, agent) => {
    let model = agent.model || (agent.type === 'codex cli' ? adapters[agent.type].status(agent).model : null);
    if (!model) return name;
    if (agent.type === 'opencode cli' || agent.type === 'pi cli') model = model.split('/').at(-1);
    let id = model.replace(/[^A-Za-z0-9._-]/g, '-');
    if (!/^[A-Za-z0-9]/.test(id)) id = `agent-${id}`;
    if (id === 'claude') id += '-agent';
    return id;
  };
  const add = (name, agent) => {
    const base = nameOf(name, agent), suffix = { 'codex cli': 'codex', 'opencode cli': 'opencode', 'pi cli': 'pi', api: 'api' }[agent.type];
    let id = base;
    for (let n = 1; Object.hasOwn(agents, id); n++) {
      if (isDeepStrictEqual(agents[id], agent)) return id;
      id = `${base}-${suffix}${n > 1 ? `-${n}` : ''}`;
    }
    agents[id] = agent;
    return id;
  };
  // 已按模型命名的代号优先保留，避免被前面同名但不同配置的协作方占用。
  const entries = Object.entries(config.agents).sort(([a, x], [b, y]) => Number(nameOf(b, y) === b) - Number(nameOf(a, x) === a));
  for (const [name, agent] of entries) aliases[name] = add(name, agent);
  const convert = (item) => {
    if (!isObject(item)) return item;
    const original = config.agents[item.agent];
    const { model, ...rest } = item;
    return { ...rest, agent: model && original ? add(item.agent, { ...original, model }) : aliases[item.agent] || item.agent };
  };
  config.modules = mapCells(config.modules, (value) => value === CLAUDE_CODE || value === null ? value
    : cellList(value).map(convert).filter((item, i, list) => !list.slice(0, i).some((prev) => isDeepStrictEqual(prev, item))));
  return { config: { ...config, agents }, aliases: Object.fromEntries(Object.entries(aliases).filter(([a, b]) => a !== b)) };
}

function migrateStructure(config, file, base, project, adapters) {
  if (!project && migratedConfigs.has(file)) return migratedConfigs.get(file);
  const converted = migrateConfig(config, file, base, project);
  if (project) return converted.config;
  if (!converted.old && !converted.modules) return config;
  let result = structuredClone(converted.config);
  if (converted.old && isObject(config.agents) && !Object.hasOwn(config.agents, 'codex')
    && !eachEntry(result.modules).some(({ item }) => item?.agent === 'codex')) delete result.agents.codex;
  for (const agent of Object.values(result.agents || {})) if (Object.hasOwn(OLD_TYPES, agent?.type)) agent.type = OLD_TYPES[agent.type];
  let renamed = { aliases: {} };
  const lock = `${file}.structure.lock`, tmp = `${file}.${process.pid}.tmp`, aliasTmp = `${aliasesFile}.${process.pid}.tmp`;
  // 锁文件的每次新建、读取和删除都经过 retryBusy：Windows 上别的进程正在删同一个锁文件时，这些操作会短暂报 EPERM。
  // 删除时把"还该删"的判断（持有者已退出、或者是自己的）交给 retryBusy，每次重试前重新确认，免得删掉等待期间别的进程刚拿到的锁。
  const ownerOf = () => {
    try { return Number(retryBusy(() => fs.readFileSync(lock, 'utf8'))); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const mine = () => ownerOf() === process.pid;
  const stale = () => { const pid = ownerOf(); return !!pid && !pidAlive(pid); };
  let locked = false;
  try {
    if (converted.old) { renamed = renameAgentsByModel(result, adapters); result = renamed.config; }
    validateConfig(normalizeModules(mergeConfig(DEFAULT_CONFIG, result)), adapters, (msg) => { throw new Error(msg); });
    for (;;) {
      try { retryBusy(() => fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })); locked = true; break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const owner = ownerOf();
        if (owner === null) continue;
        if (owner && !pidAlive(owner)) retryBusy(() => fs.rmSync(lock, { force: true }), stale);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    const current = readJson(file);
    if (!isDeepStrictEqual(current, config)) {
      retryBusy(() => fs.rmSync(lock, { force: true }), mine);
      locked = false;
      return migrateStructure(current, file, base, false, adapters);
    }
    let bak = `${file}.bak`;
    if (fs.existsSync(bak)) bak += `-${Date.now()}-${process.pid}`;
    fs.copyFileSync(file, bak, fs.constants.COPYFILE_EXCL);
    if (Object.keys(renamed.aliases).length) {
      const aliases = { ...readAgentAliases(), ...renamed.aliases };
      fs.writeFileSync(aliasTmp, JSON.stringify(aliases, null, 2) + '\n', { flag: 'wx' });
      replaceFile(aliasTmp, aliasesFile);
    }
    // 旧版插件只认 levels 对象，缺了 levels 会悄悄把九格都当成 "claude code"。改写后的文件只写 modules，
    // 所以每次改写都把 levels 留成一行说明，旧版读到字符串就报错退出；文件里原来有说明就沿用。
    const { modules, ...rest } = result;
    result = { ...rest, levels: converted.note || M.levelsNote, modules };
    fs.writeFileSync(tmp, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    replaceFile(tmp, file);
    if (converted.old) notice(M.configStructureMigrated(file, bak, M.list(Object.entries(renamed.aliases).map(([a, b]) => `${a} → ${b}`))));
    if (converted.modules) notice(M.configModulesMigrated(file, bak));
  } catch (e) {
    notice(M.configMigrateFailed(file, e.message));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(aliasTmp, { force: true });
    if (locked) retryBusy(() => fs.rmSync(lock, { force: true }), mine);
  }
  memoryAliases = { ...memoryAliases, ...renamed.aliases };
  migratedConfigs.set(file, result);
  return result;
}

function validateConfig(cfg, adapters, fail = die) {
  const why = M.invalid;
  const check = (ok, key, reason) => { if (!ok) fail(M.configInvalid(key, reason)); };
  const text = (v) => typeof v === 'string' && !!v.trim();
  for (const key of ['dispatch', 'agents', 'modules']) check(isObject(cfg[key]), key, why.object);
  check(typeof cfg.dispatch.auto === 'boolean', 'dispatch.auto', why.boolean);
  check(['auto', 'off'].includes(cfg.dispatch.watch), 'dispatch.watch', why.watch);
  check(typeof cfg.dispatch.intro === 'boolean', 'dispatch.intro', why.boolean);
  check(Number.isInteger(cfg.dispatch.discuss_max_rounds) && cfg.dispatch.discuss_max_rounds >= 1, 'dispatch.discuss_max_rounds', why.positiveInt);
  check(Number.isInteger(cfg.dispatch.max_seats) && cfg.dispatch.max_seats >= 1, 'dispatch.max_seats', why.positiveInt);
  for (const key of ['timeout_min', 'stall_min', 'busy_ask_min']) check(Number.isFinite(cfg.dispatch[key]) && (key === 'timeout_min' ? cfg.dispatch[key] > 0 : cfg.dispatch[key] >= 0), `dispatch.${key}`, why.minutes);
  check(cfg.dispatch.runs_dir === null || text(cfg.dispatch.runs_dir), 'dispatch.runs_dir', why.pathOrNull);
  for (const [name, agent] of Object.entries(cfg.agents)) {
    const key = `agents.${name}`;
    check(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !['claude', CLAUDE_CODE].includes(name), key, why.agentName);
    check(isObject(agent), key, why.object);
    check(Object.hasOwn(adapters, agent.type), `${key}.type`, why.agentType);
    check(agent.model == null || (text(agent.model) && agent.model !== CLAUDE_CODE), `${key}.model`, why.modelName);
    check(agent.max_parallel === undefined || (Number.isInteger(agent.max_parallel) && agent.max_parallel >= 1), `${key}.max_parallel`, why.positiveInt);
    adapters[agent.type].validate(agent, key, check, text);
  }
  validateModuleKeys(cfg.modules, check);
  for (const { module, cell, key, value } of eachCell(cfg.modules)) {
    validateCell(value, module, key, check);
    const seen = new Set();
    for (const [i, item] of cellList(value).entries()) {
      const at = `${key}[${i}]`;
      check(isObject(item), at, M.levelEntryChoices);
      check(text(item.agent), `${at}.agent`, why.agentRef);
      if (!Object.hasOwn(cfg.agents, item.agent)) fail(unknownAgentError(at, item.agent, cfg));
      const agent = cfg.agents[item.agent], adapter = adapters[agent.type];
      check(!seen.has(item.agent), at, why.duplicate);
      seen.add(item.agent);
      if (module === 'image' && cell === 'generate') check(canGenerate(adapter), `${at}.agent`, M.imagesNotSupported(item.agent, agent.type));
      else {
        const mode = module === 'image' ? 'run' : module;
        check(adapter.capabilities.modes.includes(mode), `${at}.agent`, M.modeNotSupported(item.agent, agent.type, mode, M.list(adapter.capabilities.modes)));
        if (mode === 'run' && adapter.capabilities.isolation === 'tools') check(!!agent.run_access, `${at}.agent`, M.runAccessRequired(item.agent, agent.type));
      }
      check(item.model == null || (text(item.model) && item.model !== CLAUDE_CODE), `${at}.model`, why.modelName);
      check(item.effort === undefined || (adapter.efforts ? adapter.efforts.includes(item.effort) : item.effort === null || text(item.effort)), `${at}.effort`, adapter.efforts?.join(' / ') || why.apiEffort);
      check(item.required === undefined || typeof item.required === 'boolean', `${at}.required`, why.boolean);
    }
    if (module === 'run' || module === 'image') check(cellList(value).filter((item) => item.required).length <= 1, key, why.oneRequired);
  }
}

function validateModuleKeys(modules, check) {
  check(isObject(modules), 'modules', M.invalid.object);
  for (const [module, cells] of Object.entries(modules)) {
    check(Object.hasOwn(MODULE_CELLS, module), `modules.${module}`, M.invalid.module);
    check(isObject(cells), `modules.${module}`, M.invalid.object);
    for (const cell of Object.keys(cells)) check(MODULE_CELLS[module].includes(cell), `modules.${module}.${cell}`, module === 'image' ? M.invalid.imageCell : M.invalid.level);
  }
}

function validateCell(value, module, key, check) {
  if (value === (module === 'image' ? null : CLAUDE_CODE)) return;
  check((Array.isArray(value) || isObject(value)) && cellList(value).length > 0, key, module === 'image' ? M.invalid.imageCandidates : M.invalid.candidates);
}

function projectConfig(cfg, project, adapters) {
  const allowed = {}, ignored = [];
  const check = (ok, key, reason) => { if (!ok) die(M.configInvalid(key, reason)); };
  for (const [key, value] of Object.entries(project)) {
    if (key === 'dispatch' && isObject(value)) {
      allowed.dispatch = {};
      for (const [field, val] of Object.entries(value)) {
        if (!['timeout_min', 'stall_min', 'busy_ask_min', 'max_seats'].includes(field)) { ignored.push(`dispatch.${field}`); continue; }
        const at = `dispatch.${field}`, user = cfg.dispatch[field];
        check(field === 'max_seats' ? Number.isInteger(val) && val >= 1 : Number.isFinite(val) && (field === 'timeout_min' ? val > 0 : val >= 0), at, field === 'max_seats' ? M.invalid.positiveInt : M.invalid.minutes);
        const disabled = field === 'stall_min' || field === 'busy_ask_min';
        const looser = disabled ? user > 0 && (val === 0 || val > user) : val > user;
        if (looser) notice(M.projectLooser(at, val, user));
        allowed.dispatch[field] = looser ? user : val;
      }
    } else if (key === 'modules') {
      validateModuleKeys(value, check);
      allowed.modules = mapCells(value, (entry, { module, cell, key: at }) => {
        validateCell(entry, module, at, check);
        const original = cfg.modules[module][cell];
        if (entry === CLAUDE_CODE || entry === null) { cfg.closed_by_project.push(`${module}.${cell}`); return entry; }
        if (original === CLAUDE_CODE || original === null) { notice(M.projectCellOpened(at)); return original; }
        const seen = new Set();
        const kept = cellList(entry).flatMap((item, i) => {
          const pos = `${at}[${i}]`;
          check(isObject(item), pos, M.levelEntryChoices);
          check(typeof item.agent === 'string' && !!item.agent.trim(), `${pos}.agent`, M.invalid.agentRef);
          check(item.required === undefined || typeof item.required === 'boolean', `${pos}.required`, M.invalid.boolean);
          const name = resolveAgentAlias(item.agent, cfg), prev = cellList(original).find((p) => p.agent === name);
          check(!seen.has(name), pos, M.invalid.duplicate);
          seen.add(name);
          const agent = cfg.agents[name], adapter = adapters[agent?.type];
          if (adapter) check(item.effort === undefined || (adapter.efforts ? adapter.efforts.includes(item.effort) : item.effort === null || typeof item.effort === 'string' && !!item.effort.trim()), `${pos}.effort`, adapter.efforts?.join(' / ') || M.invalid.apiEffort);
          if (!prev) { notice(M.projectAgentDropped(item.agent, at)); return []; }
          for (const field of Object.keys(item)) if (!['agent', 'effort', 'required'].includes(field)) notice(M.projectAgentDropped(field, at));
          if (Object.hasOwn(item, 'required') && item.required !== !!prev.required) notice(M.projectRequiredChanged(at, name));
          const next = { ...prev };
          if (Object.hasOwn(item, 'effort') && item.effort !== prev.effort) {
            if (prev.effort === undefined) notice(M.projectEffortNoBase(at, name));
            else if (!['codex cli', 'pi cli'].includes(agent.type)) notice(M.projectEffortUnordered(at, name, agent.type));
            else if (adapter.efforts.indexOf(item.effort) > adapter.efforts.indexOf(prev.effort)) notice(M.projectEffortRaised(at, name, item.effort, prev.effort));
            else next.effort = item.effort;
          }
          return [next];
        });
        const missing = cellList(original).filter((item) => item.required && !kept.some((p) => p.agent === item.agent));
        if (missing.length && kept.length) die(M.projectRequiredDropped(at, M.list(missing.map((item) => item.agent))));
        if (!kept.length) die(M.projectLevelEmpty(at));
        return cellList(original).flatMap((item) => kept.filter((p) => p.agent === item.agent));
      });
    } else ignored.push(key);
  }
  if (ignored.length) notice(M.projectIgnored(M.list(ignored)));
  return allowed;
}

function detectEnvironment(adapters, agents = {}) {
  const commands = {}, started = {};
  const call = (type, args) => {
    if (!commands[type]) {
      started[type] = Date.now();
      commands[type] = adapters[type].locate(Object.values(agents).find((a) => a.type === type) || {});
    }
    const timeout = 30000 - (Date.now() - started[type]);
    if (timeout <= 0) return { status: null };
    const { file, pre } = commands[type];
    return spawnSync(file, [...pre, ...args], { encoding: 'utf8', windowsHide: true, timeout });
  };
  const version = call('codex cli', ['--version']), found = !version.error && version.status === 0;
  const login = found ? call('codex cli', ['login', 'status']) : null;
  const oc = call('opencode cli', ['--version']), ocFound = !oc.error && oc.status === 0;
  const models = ocFound ? call('opencode cli', ['models']) : null;
  const pi = call('pi cli', ['--version']), piFound = !pi.error && pi.status === 0;
  const piModels = piFound ? call('pi cli', adapters['pi cli'].listModelsArgs) : null;
  return { codex: { found, logged_in: !!login && !login.error && login.status === 0 && /logged in/i.test(`${login.stdout}${login.stderr}`) && !/not logged in/i.test(`${login.stdout}${login.stderr}`) },
    opencode: { found: ocFound, models: models?.status === 0 ? new Set(models.stdout.split(/\s+/).filter((s) => s.includes('/'))).size : 0 },
    // pi --list-models 输出一张表：第一行是表头，之后每行一个模型。
    pi: { found: piFound, models: piModels?.status === 0 ? Math.max(0, piModels.stdout.trim().split(/\r?\n/).filter(Boolean).length - 1) : 0 },
    api_keys: ['DEEPSEEK_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_API_KEY', 'MIMO_API_KEY'].filter((key) => !!process.env[key]) };
}

const API_STARTERS = [
  ['DeepSeek', ['DEEPSEEK_API_KEY'], 'https://api.deepseek.com', 'deepseek-v4-pro'],
  ['Kimi', ['KIMI_API_KEY', 'MOONSHOT_API_KEY'], 'https://api.moonshot.cn/v1', 'kimi-k2.6'],
  ['MiMo', ['MIMO_API_KEY'], 'https://api.xiaomimimo.com/v1', 'mimo-v2.6-pro'],
];
function buildStarterConfig(environment) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  if (environment.codex.found && environment.codex.logged_in) {
    for (const model of ['gpt-6.1-sol', 'gpt-6-astra']) cfg.agents[model] = { type: 'codex cli', model };
    cfg.modules.run.complex = [{ agent: 'gpt-6.1-sol', effort: 'max' }];
    for (const [i, lv] of LEVELS.entries()) {
      const entry = { agent: i === 2 ? 'gpt-6-astra' : 'gpt-6.1-sol', effort: ['medium', 'high', 'max'][i] };
      cfg.modules.review[lv] = [{ ...entry }];
      cfg.modules.discuss[lv] = [{ ...entry }];
    }
    cfg.modules.image.generate = [{ agent: 'gpt-6.1-sol', effort: 'medium' }];
    cfg.modules.image.draw = [{ agent: 'gpt-6-astra', effort: 'max' }];
  }
  for (const [, keys, base_url, model] of API_STARTERS) {
    const api_key_env = keys.find((key) => environment.api_keys.includes(key));
    if (api_key_env) cfg.agents[model] = { type: 'api', base_url, model, api_key_env };
  }
  return cfg;
}

function loadConfig(cwd, adapters) {
  const sources = [];
  let cfg = DEFAULT_CONFIG;
  if (!fs.existsSync(USER_CONFIG)) {
    try {
      const environment = detectEnvironment(adapters), starter = buildStarterConfig(environment);
      fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
      fs.writeFileSync(USER_CONFIG, JSON.stringify(starter, null, 2) + '\n', { flag: 'wx' });
      let parts = environment.codex.logged_in ? M.starterCodex('gpt-6.1-sol', 'gpt-6-astra') : M.starterNoCodex;
      if (environment.opencode.models) parts += M.starterOpencode(environment.opencode.models);
      if (environment.pi.models) parts += M.starterPi(environment.pi.models);
      const names = API_STARTERS.filter(([, , , model]) => starter.agents[model]).map(([name]) => name);
      if (names.length) parts += M.starterApi(M.list(names));
      notice(M.starterCreated(USER_CONFIG, parts + M.starterNext));
    } catch (e) { if (e.code !== 'EEXIST') notice(M.starterFailed(USER_CONFIG, e.message)); }
  }
  const user = readJson(USER_CONFIG);
  let imageConfigured = false;
  if (user) {
    const migrated = migrateStructure(user, USER_CONFIG, LEGACY_DEFAULT_CONFIG, false, adapters);
    imageConfigured = isObject(migrated.modules?.image);
    cfg = mergeConfig(cfg, migrated); sources.push(USER_CONFIG);
  }
  cfg = normalizeModules(cfg);
  validateConfig(cfg, adapters);
  cfg = { ...cfg, closed_by_project: [] };
  if (cwd) {
    const file = projectFile(cwd, PROJECT_CONFIG, LEGACY_PROJECT_CONFIG), project = readJson(file);
    if (project) { cfg = mergeConfig(cfg, projectConfig(cfg, migrateStructure(project, file, cfg, true, adapters), adapters)); sources.push(file); }
  }
  const runsDir = envOf('FOREMAN_RUNS_DIR', 'CODEX_RUNS_DIR');
  if (runsDir) cfg = mergeConfig(cfg, { dispatch: { runs_dir: runsDir } });
  validateConfig(cfg, adapters);
  return { ...cfg, sources, image_configured: imageConfigured };
}


// 默认的记录目录。改名前的记录在 ~/.claude/codex-runs，第一次运行时整个搬过来。
// 几个进程可能同时启动（比如同时发起讨论），用锁保证只搬一次；旧目录里还有任务在跑就先不搬，这次继续用旧目录。
let runsMovedNow = false;
function defaultRunsRoot() {
  const target = path.join(HOME_DIR, 'runs');
  if (fs.existsSync(target) || !fs.existsSync(LEGACY_RUNS)) return target;
  const lock = path.join(HOME_DIR, '.migrate.lock');
  // 锁文件的操作同样都经过 retryBusy（见 migrateStructure）：删残留锁时每次重试前确认持有者没换过，删自己的锁时确认还是自己的。
  const ownerOf = () => {
    try { return retryBusy(() => fs.readFileSync(lock, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  };
  const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    for (let waited = 0; ; waited += 50) {
      try { retryBusy(() => fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (waited > 15000) { // 持有者被强杀留下的锁
          const owner = ownerOf();
          if (owner !== null) retryBusy(() => fs.rmSync(lock, { force: true }), () => ownerOf() === owner);
        }
        wait(50);
        if (fs.existsSync(target)) return target; // 别的进程已经搬完
      }
    }
  } catch (e) { notice(M.runsMoveFailed(LEGACY_RUNS, e.message)); return LEGACY_RUNS; }
  try {
    if (fs.existsSync(target)) return target;
    const running = fs.readdirSync(LEGACY_RUNS).some((id) => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(LEGACY_RUNS, id, 'meta.json'), 'utf8'));
        return m.status === 'running' && pidAlive(m.pid);
      } catch { return false; }
    });
    if (running) { notice(M.runsMoveDeferred(LEGACY_RUNS)); return LEGACY_RUNS; }
    fs.renameSync(LEGACY_RUNS, target);
    runsMovedNow = true;
    notice(M.runsMoved(LEGACY_RUNS, target));
    return target;
  } catch (e) {
    notice(M.runsMoveFailed(LEGACY_RUNS, e.message));
    return fs.existsSync(target) ? target : LEGACY_RUNS;
  } finally { retryBusy(() => fs.rmSync(lock, { force: true }), () => ownerOf() === String(process.pid)); }
}

function resolveCell(cfg, module, cell) {
  if (!Object.hasOwn(MODULE_CELLS, module)) die(M.planModuleChoices(M.list(Object.keys(MODULE_CELLS))));
  if (!MODULE_CELLS[module].includes(cell) || !Object.hasOwn(cfg.modules[module], cell)) die(M.planCellChoices(module, M.list(MODULE_CELLS[module])));
  const key = `modules.${module}.${cell}`, value = cfg.modules[module][cell];
  const candidates = cellList(value).map((item) => ({ ...item, agent: resolveAgentAlias(item.agent, cfg), required: !!item.required }));
  return { module, cell, key, closed: value === CLAUDE_CODE || value === null,
    closedByProject: (cfg.closed_by_project || []).includes(`${module}.${cell}`), candidates,
    required: candidates.filter((item) => item.required).map((item) => item.agent) };
}

function validatePlan(cfg, plan, adapters) {
  if (plan.module === 'image') {
    if (plan.route == null) die(M.planRouteRequired);
    if (!Object.hasOwn(ROUTE_CELLS, plan.route)) die(M.planRouteChoices(plan.route));
    if (!ROUTE_CELLS[plan.route].includes(plan.cell)) die(M.planRouteCell('①②③④'[plan.route - 1], plan.cell, M.routeUses[plan.route]));
  } else if (plan.route != null) die(M.planRouteImageOnly);
  const cell = resolveCell(cfg, plan.module, plan.cell);
  if (cell.closedByProject) die(M.planCellClosedByProject(cell.key));
  if (cell.closed) die(M.planCellClosed(cell.key));
  const names = cell.candidates.map((item) => item.agent);
  for (const seat of plan.seats) {
    if (plan.module === 'image' && plan.cell === 'generate' && seat.role) die(M.generateNoRoles);
    const name = resolveAgentAlias(seat.agent, cfg);
    if (!names.includes(name)) die(M.agentNotInLevel(name, cell.key, M.list(names)));
    const agent = cfg.agents[name], adapter = adapters[agent.type];
    const candidate = cell.candidates.find((item) => item.agent === name);
    if (Object.hasOwn(seat, 'model') && seat.model !== (candidate.model || agent.model || null)
      || Object.hasOwn(seat, 'effort') && seat.effort !== (candidate.effort ?? null)) die(M.planSeatChanged(plan.plan_id, seat.seat, cell.key));
    const mode = plan.module === 'image' ? 'run' : plan.module;
    if (plan.module === 'image' && plan.cell === 'generate') {
      if (!canGenerate(adapter)) die(M.imagesNotSupported(name, agent.type));
    } else if (!adapter.capabilities.modes.includes(mode)) die(M.modeNotSupported(name, agent.type, mode, M.list(adapter.capabilities.modes)));
    if (plan.review?.target === 'visual' && !adapter.capabilities.reads_images) die(M.readsImagesRequired(name, agent.type));
    if (mode === 'run' && (plan.module !== 'image' || plan.cell === 'draw') && adapter.capabilities.isolation === 'tools' && !agent.run_access) die(M.runAccessRequired(name, agent.type));
  }
  const missing = cell.required.filter((name) => !plan.seats.some((seat) => resolveAgentAlias(seat.agent, cfg) === name));
  if (missing.length) die(M.planMissingRequired(cell.key, M.list(missing)));
  if (plan.required) {
    const planned = new Set(plan.required.map((name) => resolveAgentAlias(name, cfg)));
    if (planned.size !== cell.required.length || cell.required.some((name) => !planned.has(name))) die(M.planRequiredChanged(plan.plan_id, cell.key));
  }
  if (plan.seats.length > cfg.dispatch.max_seats) die(M.planTooManySeats(plan.seats.length, cfg.dispatch.max_seats));
  return cell;
}

function resolveProfile(cfg, seat, o, adapters, fallbackModel = null, parentAgent = null, parentCell = null) {
  let requested = o.agent && resolveAgentAlias(o.agent, cfg);
  const legacyRequested = requested && requested !== o.agent;
  parentAgent = parentAgent && resolveAgentAlias(parentAgent, cfg);
  // 旧等级的模型覆盖已拆成独立协作方，续接要找同一连接配置下的原模型。
  if (parentAgent && fallbackModel && cfg.agents[parentAgent]?.model !== fallbackModel) {
    const source = cfg.agents[parentAgent];
    const matches = Object.keys(cfg.agents).filter((name) => cfg.agents[name].model === fallbackModel
      && isDeepStrictEqual({ ...cfg.agents[name], model: null }, { ...source, model: null }));
    if (matches.length === 1) {
      if (requested === parentAgent) requested = matches[0];
      parentAgent = matches[0];
    }
  }
  if (legacyRequested) notice(M.legacyAgentAlias(o.agent, requested));
  if (parentAgent && requested && requested !== parentAgent) die(M.resumeAgentMismatch(requested, parentAgent));
  if (requested && !Object.hasOwn(cfg.agents, requested)) die(unknownAgentError('--agent', requested, cfg));
  const image = seat.module === 'image';
  if (image && o.level != null) die(M.imageNoLevel);
  const level = image ? seat.cell ?? parentCell : o.level || seat.cell;
  if (!image && !level) die(M.missingLevel(LEVELS.join(' / ')));
  if (!image && !LEVELS.includes(level)) die(M.levelChoices(LEVELS.join(' / ')));
  if (parentAgent && parentCell !== level && seat.plan) die(M.resumePlanCellChanged(seat.plan, parentCell, level));
  const cell = resolveCell(cfg, seat.module, level), names = M.list(cell.candidates.map((item) => item.agent));
  const selected = parentAgent || (seat.agent && resolveAgentAlias(seat.agent, cfg)) || requested;
  let entry, outside = false;
  if (cell.closed) {
    if (cell.closedByProject) die(M.cellClosedByProject(cell.key, o.agent != null));
    if (image) die(M.imageCellClosed(cell.key));
    if (!requested) die(seat.module === 'run' ? M.levelForClaude(level) : M.levelIsClaude(cell.key));
    const adapter = adapters[cfg.agents[requested]?.type];
    entry = { agent: requested, effort: adapter?.defaultEffort?.(level) ?? null };
    outside = true;
  } else {
    const single = !image && (parentAgent ? parentCell !== level : !seat.seat);
    if (parentAgent && !cell.candidates.some((item) => item.agent === parentAgent)) die(M.resumeAgentNotInCell(parentAgent, cell.key, names));
    if (single && cell.required.length > 1) die(M.severalRequired(cell.key, M.list(cell.required)));
    entry = selected ? cell.candidates.find((item) => item.agent === selected)
      : cell.candidates.length === 1 ? cell.candidates[0] : cell.required.length === 1 ? cell.candidates.find((item) => item.required) : null;
    if (!entry) die(selected ? M.agentNotInLevel(selected, cell.key, names) : M.agentRequired(cell.key, names));
    if (single) {
      const others = cell.required.filter((name) => name !== entry.agent);
      if (others.length) die(parentAgent ? M.resumeOtherRequired(cell.key, entry.agent, M.list(others)) : M.otherRequired(cell.key, entry.agent, M.list(others)));
      // 单席也校验整份计划，不能从另一条派发路径绕过必选。
      validatePlan(cfg, { module: seat.module, cell: level, seats: [{ agent: entry.agent }] }, adapters);
    }
  }
  if (!Object.hasOwn(cfg.agents, entry.agent)) die(unknownAgentError('--agent', entry.agent, cfg));
  const agent = cfg.agents[entry.agent], adapter = adapters[agent.type];
  const effort = o.effort ?? (Object.hasOwn(seat, 'effort') ? seat.effort : entry.effort);
  const mode = image ? 'run' : seat.module;
  if (image && level === 'generate') {
    if (!canGenerate(adapter)) die(M.imagesNotSupported(entry.agent, agent.type));
  } else if (!adapter.capabilities.modes.includes(mode)) die(M.modeNotSupported(entry.agent, agent.type, mode, M.list(adapter.capabilities.modes)));
  if (mode === 'run' && (!image || level === 'draw') && adapter.capabilities.isolation === 'tools' && !agent.run_access) die(M.runAccessRequired(entry.agent, agent.type));
  if (mode === 'run' && adapter.capabilities.isolation !== 'os' && o['no-snapshot']) die(M.snapshotRequired);
  if (effort !== undefined && effort !== null && adapter.efforts && !adapter.efforts.includes(effort)) die(M.effortChoices(adapter.efforts.join(' / ')));
  const base = entry.model || agent.model || fallbackModel;
  const model = o.model || base;
  if (o.model && ['opencode cli', 'pi cli'].includes(agent.type) && (!base?.includes('/') || !model.includes('/') || model.split('/')[0] !== base.split('/')[0])) die(M.modelVendorChanged(entry.agent, model, base));
  return { level: image ? null : level, agentName: entry.agent, agent, model, effort: effort ?? null, module: seat.module, cell: level,
    plan: seat.plan ?? null, seat: seat.seat ?? null, role: seat.role ?? null,
    ...(outside ? { outside_cell: true } : {}), ...(o.model && model !== base ? { model_overridden: true } : {}) };
}

export { ENTRY, SCHEMA, DISCUSS_SCHEMA, REVIEW_SCHEMA, USER_CONFIG, USER_PREFS, PROJECT_PREFS, LEGACY_PROJECT_PREFS, DEFAULT_AGENT_PARALLEL, DEFAULT_CONFIG, CLAUDE_CODE, LEVELS,
  MODULE_CELLS, ROUTE_CELLS, canGenerate, cellList, eachCell, eachEntry, mapCells, resolveCell, validatePlan, resolveProfile, projectFile, loadConfig, defaultRunsRoot, runsMovedNow,
  readAgentAliases, resolveAgentAlias, migrateStructure, renameAgentsByModel, detectEnvironment, buildStarterConfig, staleAliases, unknownAgentError };
