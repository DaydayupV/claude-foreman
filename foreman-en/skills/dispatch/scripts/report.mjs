// setup 的固定 Markdown：环境、总配置和本机模型清单，文字统一从 messages 取。
import { CLAUDE_CODE, LEVELS, cellList, readRawConfig, isSplit, seatsFor, gapFor } from './config.mjs';
import { M, isObject } from './util.mjs';

const dash = '—';
const escape = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows]
  .map((row) => `| ${row.map(escape).join(' | ')} |`).join('\n');
const report = (blocks) => blocks.join('\n\n') + '\n';
const modules = ['discuss', 'review', 'run', 'image'];
const entries = (summary) => modules.flatMap((module) => (module === 'image' ? ['generate', 'draw'] : LEVELS)
  .flatMap((cell) => cellList(summary.modules[module][cell])));
const checkMark = (ok, problem = false) => problem ? '⚠' : ok === true ? '✅' : ok === false ? '❌' : dash;

export const environmentReport = (checks, environment, agents) => {
  const issues = ['node', 'git', 'watch'].filter((key) => !checks[key].ok)
    .map((key) => `${key === 'node' ? '❌' : '⚠'} ${M.reportIssue(M.reportEnvironmentItems[key], checks[key].fix)}`);
  const { total_gb, available_gb, enough, web } = checks.memory;
  if (web && !enough) issues.push(`⚠ ${M.reportIssue(M.reportEnvironmentItems.web, M.fixWebLowMemory)}`);
  for (const [name, agent] of Object.entries(checks.agents)) {
    if (!checks.summary.agents[name].used_at.length) continue;
    if (agent.type === 'codex cli' && agent.sandbox?.checked.some((item) => item.ok === false)) issues.push(`⚠ ${M.reportIssue(M.reportCodexSandbox(name), agent.fix)}`);
    if (agent.type === 'agy cli' && agent.sandbox && !agent.sandbox.available) issues.push(`⚠ ${M.reportIssue(M.reportAgySandbox(name), agent.fix || (agent.sandbox.results?.layout === 'unavailable' ? M.fixAgySandboxLayout : M.fixAgySandbox))}`);
  }
  // 没有在用的 Codex 协作方、或者没查到沙箱（没装、没登录）时，不能说沙箱正常
  // 探测不了（这个版本的 Codex 不支持，ok 为 null）也不算测过
  const codexInUse = Object.entries(checks.agents).filter(([name, agent]) => agent.type === 'codex cli' && checks.summary.agents[name].used_at.length);
  const sandboxChecked = codexInUse.length > 0 && codexInUse.every(([, agent]) => agent.sandbox?.checked.length && agent.sandbox.checked.every((item) => item.ok === true));
  const { codex, opencode, pi, agy, api_keys } = environment;
  const agyInUse = Object.entries(checks.agents).find(([name, agent]) => agent.type === 'agy cli' && checks.summary.agents[name].used_at.length)?.[1];
  const quota = agyInUse?.quota?.groups.flatMap((g) => g.buckets.filter((b) => isObject(b) && Number.isFinite(b.remaining_fraction))
    .map((b) => `${g.name} ${M.reportAgyWindow(b.window) || b.name || b.window} ${Math.round(b.remaining_fraction * 100)}%`));
  const agyStatus = [agyInUse?.sandbox && (agyInUse.sandbox.available ? M.reportAgySandboxOk : M.reportAgySandboxOff), quota?.length && M.reportAgyQuota(M.list(quota))].filter(Boolean);
  const keys = Object.values(agents).filter((agent) => agent.type === 'api' && agent.api_key).length;
  return report([
    M.reportEnvironmentTitle, issues.length ? issues.join('\n\n') : sandboxChecked ? M.reportEnvironmentOk : M.reportEnvironmentOkNoSandbox,
    table(M.reportEnvironmentHeaders, [
      ['Codex', codex.found ? M.reportCodexInstalled(codex.logged_in) : M.reportNotInstalled],
      ['opencode', opencode.found ? M.reportModelsInstalled(opencode.models) : M.reportNotInstalled],
      ['pi', pi.found ? M.reportModelsInstalled(pi.models) : M.reportNotInstalled],
      ['agy', agy?.found ? [M.reportModelsInstalled(agy.models), ...agyStatus].join(' · ') : M.reportNotInstalled],
      [M.reportApiVariables, (api_keys.length ? M.reportVariablesFound(M.list(api_keys)) : M.reportNoVariables) + (keys ? M.reportConfigKeys(keys) : '')],
      [M.reportMemoryLabel, M.reportMemory(total_gb, available_gb)],
      [M.reportWebLabel, web ? enough ? M.reportWebOn : M.reportWebOnLow : enough ? M.reportWebOff : M.reportWebOffLow],
    ]),
  ]);
};

const cellTable = (cfg, summary, module, checks) => {
  const cells = module === 'image' ? ['generate', 'draw'] : LEVELS;
  const headers = [M.reportCandidate, ...(module === 'image' ? M.reportImageColumns : cells), ...(checks ? [M.reportCheck] : [])];
  const values = cells.map((cell) => summary.modules[module][cell]), rows = [];
  const pseudo = (value, name, text) => {
    if (values.includes(value)) rows.push([name, ...cells.map((cell, i) => values[i] === value ? text : dash), ...(checks ? [dash] : [])]);
  };
  pseudo(CLAUDE_CODE, M.reportHost, module === 'run' ? M.reportHostRun : M.reportNoOutside);
  if (module === 'image') pseudo(null, M.reportOffRow, M.reportOff);
  const names = [...new Set(values.flatMap((value) => cellList(value).map((item) => item.agent)))];
  for (const name of names) {
    const items = values.map((value) => cellList(value).find((item) => item.agent === name));
    rows.push([name, ...items.map((item, i) => !item ? dash : (item.effort ?? M.reportDefault)
      + (item.model && item.model !== summary.agents[name]?.model ? ` · ${item.model}` : '') + (item.required ? ' ★' : '') + (item.problem ? ' ⚠' : '')),
    ...(checks ? [checkMark(checks[name]?.ok, items.some((item) => item?.problem))] : [])]);
  }
  return table(headers, rows);
};

const seatsTable = (cfg, summary) => {
  // 是否默认看原文，不把恰好等于默认值的显式配置误标为默认。
  const raw = cfg.sources.map((file) => readRawConfig(file));
  const rows = ['discuss', 'review'].flatMap((module) => LEVELS.map((cell) => {
    const label = `${M.reportModuleNames[module]} ${cell}`, value = summary.modules[module][cell];
    const split = isSplit(cfg, module, cell);
    // 场景和配置对不上时按配置里实际写的场景名列出，缺的值写 —，方便对照着改
    const written = ['seats', 'gap'].flatMap((field) => isObject(cfg.modules[module][field]?.[cell]) ? Object.keys(cfg.modules[module][field][cell]) : []);
    const scenes = [...cfg.scenes.names.filter((scene) => written.includes(scene)), ...new Set(written.filter((scene) => !cfg.scenes.names.includes(scene)))];
    const byScene = (fn) => split ? scenes.map((scene) => `${scene} ${fn(scene) ?? dash}`).join(' · ') : fn();
    const gapValue = module === 'review' ? byScene((scene) => { const on = gapFor(cfg, cell, scene); return on == null ? null : on ? M.reportGapOn : M.reportGapOff; }) : dash;
    if (value === CLAUDE_CODE) return [label, dash, gapValue, dash, dash, M.reportNoOutside];
    const candidates = [...new Map(cellList(value).map((item) => [item.agent, item])).values()];
    const required = candidates.filter((item) => item.required), n = candidates.length, r = required.length;
    const names = M.list(required.map((item) => item.agent));
    const practice = (scene) => {
      const s = seatsFor(cfg, module, cell, scene), gap = module === 'review' && gapFor(cfg, cell, scene);
      if (s == null) return dash;
      let text = n <= s ? (n === s ? M.reportAllCandidates(n) : M.reportFewerCandidates(s, n))
        : r === s ? (gap ? M.reportOnlyRequiredGap : M.reportOnlyRequired)(names, n - r)
          : r ? M.reportRequiredPlus(names, n - r, s - r) : M.reportPickCandidates(n, s);
      if (gap) text += n <= s ? M.reportNoGap : r === s ? '' : M.reportGapLeft;
      return text;
    };
    const explicit = raw.some((config) => Object.hasOwn(config?.modules?.[module]?.seats || {}, cell));
    return [label, `${byScene((scene) => seatsFor(cfg, module, cell, scene))}${explicit ? '' : M.reportDefaultSeats}`, gapValue, n, r,
      split ? scenes.map((scene) => `${scene}：${practice(scene)}`).join('；') : practice()];
  }));
  return table(M.reportSeatsHeaders, rows);
};

const usedIn = (used) => {
  const labels = ['discuss', 'review', 'run'].flatMap((module) => {
    const levels = LEVELS.filter((cell) => used.some((at) => at.startsWith(`modules.${module}.${cell}[`)));
    return levels.length ? [`${M.reportModuleNames[module]} ${levels.map((cell) => cell[0].toUpperCase()).join('/')}`] : [];
  });
  for (const cell of ['generate', 'draw']) if (used.some((at) => at.startsWith(`modules.image.${cell}[`))) labels.push(M.reportModuleNames[cell]);
  return labels.length ? M.list(labels) : M.reportUnused;
};
const runAccess = (agent) => agent.type === 'api' ? dash : agent.type === 'agy cli' ? M.agyReadOnly : agent.type === 'codex cli' ? M.reportAccessCodex
  : agent.run_access === 'edit' ? M.reportAccessEdit : agent.run_access === 'shell' ? M.reportAccessShell : M.reportAccessOff;

const notes = (summary, checks) => {
  const rows = [], problems = entries(summary).filter((item) => item.problem);
  if (checks) for (const [name, info] of Object.entries(summary.agents)) {
    if (info.used_at.length && checks[name]?.ok === false) rows.push(`- ❌ ${M.reportIssue(name, checks[name].fix)}`);
  }
  const seenProblems = new Set();
  for (const item of problems) {
    const key = JSON.stringify([item.agent, item.model, item.effort, item.problem]);
    if (seenProblems.has(key)) continue;
    seenProblems.add(key);
    rows.push(`- ❌ ${M.reportEffortProblem(item.agent, item.model, item.effort ?? M.reportDefault, item.problem)}`);
  }
  const merged = new Set();
  for (const warning of summary.warnings) {
    if (['unused_agent', 'plaintext_key'].includes(warning.kind)) {
      if (merged.has(warning.kind)) continue;
      merged.add(warning.kind);
      const names = summary.warnings.filter((w) => w.kind === warning.kind).map((w) => w.agent);
      rows.push(warning.kind === 'unused_agent' ? `- ℹ ${M.reportUnusedAgents(names.length, M.list(names))}` : `- ⚠ ${M.reportPlaintextKeys(M.list(names))}`);
    } else {
      const icon = warning.kind === 'scenes_mismatch' ? '❌' : ['readonly_audited', 'shell_access', 'stale_alias', 'host_seat_infeasible'].includes(warning.kind) ? '⚠' : 'ℹ';
      rows.push(`- ${icon} ${M.reportSentence(warning.message)}`);
    }
  }
  return rows.length ? rows.join('\n') : M.reportNoNotes;
};

export const configReport = (cfg, summary, checks = null) => {
  const blocks = [M.reportConfigTitle, `${M.reportCellsTitle}　${M.reportCellsIntro}`];
  if (cfg.project_config) blocks.splice(1, 0, M.reportProjectConfig(cfg.project_config.path, M.list(cfg.project_config.cells)));
  for (const module of modules) blocks.push(M.reportModuleNames[module], module === 'image' && !cfg.image_configured
    ? M.reportImageUnconfigured : cellTable(cfg, summary, module, checks));
  blocks.push(M.reportSeatsTitle, seatsTable(cfg, summary), M.reportSeatsNotes.map((text) => `- ${text}`).join('\n'), M.reportAgentsTitle);
  const problems = entries(summary).filter((item) => item.problem);
  blocks.push(table([...M.reportAgentsHeaders, ...(checks ? [M.reportCheck] : [])], Object.entries(summary.agents).map(([name, info]) => [
    name, info.type, info.model ?? dash, usedIn(info.used_at), runAccess(info),
    ...(checks ? [checkMark(checks[name]?.ok, problems.some((item) => item.agent === name))] : []),
  ])), M.reportNotesTitle, notes(summary, checks));
  return report(blocks);
};

const context = (n) => n == null ? dash : n >= 1000000 ? `${Number((n / 1000000).toFixed(2))}M` : `${Math.round(n / 1000)}K`;
const price = (cost) => !cost || cost.input == null || cost.output == null ? dash : cost.input === 0 && cost.output === 0
  ? M.reportFree : `$${cost.input} / $${cost.output}`;
const efforts = (model) => model.efforts?.length ? [...(model.plain ? [dash] : []),
  ...model.efforts.map((effort) => effort === model.default_effort ? `**${effort}**` : effort)].join(' / ') : M.reportNoEffort;

export const modelsReport = (catalog) => {
  const tools = ['codex cli', 'opencode cli', 'pi cli', 'agy cli'];
  const visible = Object.fromEntries(tools.map((type) => [type, catalog.tools[type]?.ok ? catalog.tools[type].models.filter((model) =>
    type === 'codex cli' ? !model.hidden : type !== 'opencode cli' || model.enabled !== false) : []]));
  const api = Object.entries(catalog.api), nonChat = (model) => /tts|asr|embedding|rerank|moderation/i.test(model.id);
  const apiRows = api.flatMap(([name, cat]) => cat.ok ? cat.models.filter((model) => !nonChat(model)).map((model) => [name, model]) : []);
  const omitted = api.reduce((n, [, cat]) => n + (cat.ok ? cat.models.filter(nonChat).length : 0), 0);
  const counts = tools.map((type) => visible[type].length), apiCount = apiRows.length;
  const blocks = [M.reportModelsTitle, M.reportModelsTotal(counts.reduce((a, b) => a + b, apiCount), ...counts.slice(0, 3), api.length, apiCount, counts[3]) + M.reportModelsJoin + M.reportModelsIntro];
  const configured = (type, model) => M.list(Object.entries(catalog.agents).filter(([, agent]) => agent.type === type
    && (agent.model === model.id || type === 'agy cli' && Object.values(model.ids).includes(agent.model))).map(([name]) => name));
  for (const type of tools) {
    const cat = catalog.tools[type], tool = type === 'codex cli' ? 'Codex' : type.split(' ')[0];
    if (!cat) continue;
    // 工具根本没装（Node 启动它时报 spawn … ENOENT）时直接说没装；启动以后读文件出的 ENOENT 等其他错误照写原因
    if (!cat.ok) { blocks.push(/\bspawn(?:Sync)? \S+ ENOENT\b/.test(cat.error ?? '') ? M.reportCatalogMissing(tool) : M.reportCatalogError(tool, cat.error)); continue; }
    if (type === 'agy cli') {
      blocks.push(M.reportAgyTitle, table(M.reportModelHeaders, visible[type].map((model) => [model.id, efforts(model), context(model.context), configured(type, model)])));
      continue;
    }
    if (type === 'codex cli') {
      blocks.push(M.reportCodexTitle, table(M.reportModelHeaders, visible[type].map((model) => [model.id, efforts(model), context(model.context), configured(type, model)])));
      continue;
    }
    const groups = new Map();
    for (const model of visible[type]) {
      const provider = model.id.split('/')[0];
      if (!groups.has(provider)) groups.set(provider, []);
      groups.get(provider).push(model);
    }
    for (const [provider, models] of groups) blocks.push(M.reportProviderTitle(tool, provider, models.length),
      table([...M.reportModelHeaders.slice(0, 3), M.reportPrice, M.reportModelHeaders[3]], [...models].sort((a, b) => a.id.localeCompare(b.id)).map((model) => [
        model.id.slice(provider.length + 1), efforts(model), context(model.context), price(model.cost), configured(type, model),
      ])));
  }
  if (api.some(([, cat]) => cat.ok)) blocks.push(M.reportApiTitle, table(M.reportApiHeaders, apiRows.map(([name, model]) => [name, model.id, context(model.context), catalog.agents[name]?.model === model.id ? name : ''])));
  if (omitted) blocks.push(M.reportNonChat(omitted));
  for (const [name, cat] of api) if (!cat.ok) blocks.push(M.reportCatalogError(name, cat.error));
  blocks.push(M.reportModelsNext);
  return report(blocks);
};
