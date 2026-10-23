// 核实意见的去留，以及按基础模型和模块汇总本地实测记录。
import fs from 'node:fs';
import path from 'node:path';
import { RUNS_ROOT, listRuns, findRun, readMeta, checkRunners, isRunning, runOutcome, resultValid } from './records.mjs';
import { M, die, need, isObject, modelOf, agentTypeOf, replaceFile } from './util.mjs';
import { acquireLock } from './locks.mjs';
import { costOf, loadPrices } from './prices.mjs';

const MODULES = ['discuss', 'review', 'run', 'image'];
const VERDICTS = ['accept', 'partial', 'reject'];
const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
const split = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);
const print = (value) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function readRecord(dir, file) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { return null; }
}
function readVerdict(dir) {
  const value = readRecord(dir, 'verdict.json');
  return isObject(value?.items) && Object.values(value.items).every((item) =>
    isObject(item) && VERDICTS.includes(item.verdict) && (item.same_as == null ||
      Array.isArray(item.same_as) && item.same_as.every((link) => typeof link === 'string'))) ? value : null;
}
function moduleOf(meta) {
  if (meta.module) return meta.module;
  if (meta.kind) return { discuss: 'discuss', review: 'review', exec: 'run' }[meta.kind] || meta.mode;
  const parent = meta.mode === 'resume' && meta.parent && readMeta(path.join(RUNS_ROOT, meta.parent));
  return parent ? moduleOf(parent) : meta.mode;
}
function baseModel(meta, result) {
  return (meta.model || result?.model || meta.model_shown?.replace(/\s*(?:（[^）]*）|\([^)]*\))\s*$/, '') || 'unknown')
    .split('/').at(-1).trim().toLowerCase().replace(/\s+/g, '-') || 'unknown';
}
// 有计划时只按计划分组；旧记录还需同时对上任务组、Claude 会话和模块。
function peerKey(meta, module) {
  return meta.plan ? JSON.stringify(['plan', meta.plan]) : meta.group ?
    JSON.stringify(['group', meta.group, meta.claude_session ?? null, module]) : null;
}
const findingsOf = (result, module) => module === 'review' && Array.isArray(result?.report?.findings) ? result.report.findings.map((f) => f.id) : null;
function firstRun(run) {
  while (run.meta.parent) run = findRun(run.meta.parent);
  return run.id;
}
function checkId(id, run, ids) {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,31}$/.test(id)) die(M.judgeBadId(id));
  if (ids && !ids.includes(id)) die(M.judgeUnknownId(id, run, ids.length ? M.list(ids) : M.judgeNoIds));
}

async function lockVerdict(file) {
  const { release } = await acquireLock(`${file}.lock`, { waitMs: 5000, legacy: true, busy: ({ file: lock }) => die(M.judgeBusy(file, lock)) });
  return release;
}

async function cmdJudge(o) {
  const options = Object.fromEntries([...VERDICTS, 'same', 'clear'].map((key) => [key, split(o[key])]));
  if (!Object.values(options).some((ids) => ids.length)) die(M.judgeNothing);
  const run = findRun(need(o, 'run')), { meta } = run;
  if (isRunning(meta)) die(M.judgeRunning(run.id));
  const module = moduleOf(meta);
  if (!['review', 'discuss'].includes(module)) die(M.judgeModule(run.id, module));
  const ids = findingsOf(readRecord(run.dir, 'result.json'), module);
  const changes = new Map(), links = new Map(), cleared = new Set(options.clear);
  for (const id of cleared) checkId(id);
  for (const verdict of VERDICTS) for (const id of options[verdict]) {
    if (cleared.has(id)) die(M.judgeClearConflict(id));
    checkId(id, run.id, ids);
    if (changes.has(id) && changes.get(id) !== verdict) die(M.judgeConflict(id));
    changes.set(id, verdict);
  }
  for (const value of options.same) {
    const match = /^([^=:\s]+)=([^=:\s]+):([^=:\s]+)$/.exec(value);
    if (!match) die(M.judgeBadSame(value));
    const [, id, ref, otherId] = match;
    if (cleared.has(id)) die(M.judgeClearConflict(id));
    checkId(id, run.id, ids);
    const other = findRun(ref), otherModule = moduleOf(other.meta);
    if (other.id === run.id) die(M.judgeSameSelf(value));
    if (!peerKey(meta, module) || peerKey(meta, module) !== peerKey(other.meta, otherModule)) die(M.judgeSameNotPeer(value, other.id));
    if (meta.plan ? meta.seat === other.meta.seat : firstRun(run) === firstRun(other)) die(M.judgeSameSeat(value, other.id));
    if (isRunning(other.meta)) die(M.judgeSameRunning(value, other.id));
    checkId(otherId, other.id, findingsOf(readRecord(other.dir, 'result.json'), otherModule));
    if (!links.has(id)) links.set(id, new Set());
    links.get(id).add(`${other.id}:${otherId}`);
  }
  const file = path.join(run.dir, 'verdict.json'), tmp = `${file}.${process.pid}.tmp`, release = await lockVerdict(file);
  try {
    const items = { ...readVerdict(run.dir)?.items }, at = new Date().toISOString();
    const recorded = Object.keys(items);
    for (const id of cleared) if (!recorded.includes(id)) die(M.judgeClearUnknown(id, run.id, recorded.length ? M.list(recorded) : M.judgeNoIds));
    for (const id of cleared) delete items[id];
    for (const id of links.keys()) if (!changes.has(id) && !VERDICTS.includes(items[id]?.verdict)) die(M.judgeSameUnjudged(id));
    for (const [id, verdict] of changes) items[id] = { ...items[id], verdict, at };
    for (const [id, same] of links) items[id] = { verdict: items[id].verdict, same_as: [...same], at };
    const value = { run_id: run.id, module, plan: meta.plan ?? null, seat: meta.seat ?? null,
      group: meta.group ?? null, claude_session: meta.claude_session ?? null,
      agent: meta.agent ?? null, model: modelOf(meta), updated_at: at, items };
    const hasItems = Object.keys(items).length > 0;
    if (hasItems) {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      replaceFile(tmp, file);
    } else fs.rmSync(file, { force: true });
    print({ file: hasItems ? file : null, ...value, ...(o.clear == null ? {} : { cleared: [...cleared] }),
      unjudged: ids ? ids.filter((id) => !VERDICTS.includes(items[id]?.verdict)) : null });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } finally { release(); }
  }
}

function seatChains(runs, totals) {
  const byId = new Map(runs.map((run) => [run.id, run])), chains = new Map();
  for (const run of runs) {
    if (!run.meta) continue;
    let root = run;
    while (root.meta.parent) {
      const parent = byId.get(root.meta.parent);
      if (parent?.meta) root = parent;
      else {
        // 目录还在但祖先不可读时，不能把后代另算一个席位。
        if (parent || fs.existsSync(path.join(RUNS_ROOT, root.meta.parent))) { totals.unreadable++; root = null; }
        break;
      }
    }
    if (!root) continue;
    const key = root.meta.plan && root.meta.seat != null ? JSON.stringify([root.meta.plan, root.meta.seat]) : root.id;
    if (!chains.has(key)) chains.set(key, { root, module: moduleOf(root.meta), rounds: [] });
    const chain = chains.get(key);
    if (root.id < chain.root.id) Object.assign(chain, { root, module: moduleOf(root.meta) });
    chain.rounds.push(run);
  }
  for (const chain of chains.values()) {
    chain.rounds.sort((a, b) => a.id.localeCompare(b.id));
    for (const run of chain.rounds) run.root = chain.root.id;
  }
  return [...chains.values()];
}
function durationOf({ meta, result }) {
  if (Number.isFinite(result?.duration_s)) return result.duration_s;
  const start = Date.parse(meta.started_at), end = Date.parse(meta.ended_at);
  return Number.isFinite(start) && Number.isFinite(end) ? (end - start) / 1000 : null;
}
function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

function countUnique(groups) {
  const modelKey = (row) => JSON.stringify([row.participant === 'host', row.model]);
  for (const runs of groups.values()) {
    if (new Set(runs.map((run) => modelKey(run.row))).size < 2) continue;
    const roots = new Map(runs.map((run) => [run.id, run.root]));
    const entries = new Map();
    for (const run of runs) {
      run.row.unique ??= 0;
      run.row.unique_basis_runs++;
      for (const [id, item] of Object.entries(run.verdict.items)) {
        if (item.verdict === 'reject') continue;
        // 同一席位沿用观点编号，跨轮重复的成立意见只算一个问题。
        const key = `${run.root}:${id}`;
        if (!entries.has(key)) entries.set(key, { rows: new Set(), links: new Set() });
        const entry = entries.get(key);
        entry.rows.add(run.row);
        for (const link of item.same_as || []) {
          const [other, point] = link.split(':');
          if (roots.has(other)) entry.links.add(`${roots.get(other)}:${point}`);
        }
      }
    }
    const parents = new Map([...entries.keys()].map((key) => [key, key]));
    function find(key) {
      const parent = parents.get(key);
      if (parent !== key) parents.set(key, find(parent));
      return parents.get(key);
    }
    for (const [key, { links }] of entries) for (const link of links) {
      if (entries.has(link)) parents.set(find(key), find(link));
    }
    const issues = new Map();
    for (const [key, { rows }] of entries) {
      const root = find(key);
      if (!issues.has(root)) issues.set(root, new Map());
      for (const row of rows) issues.get(root).set(modelKey(row), row);
    }
    for (const models of issues.values()) if (models.size === 1) models.values().next().value.unique++;
  }
}

function cmdStats(o, statsOf) {
  if (o.module != null && !MODULES.includes(o.module)) die(M.statsBadModule(o.module, M.list(MODULES)));
  const since = o.since == null ? null : Number(o.since);
  if (since != null && (!Number.isFinite(since) || since <= 0)) die(M.statsBadSince(o.since));
  const cutoff = since == null ? null : Date.now() - since * 86400000;
  const prices = loadPrices();
  const totals = { runs: 0, seats: 0, judged_runs: 0, running_skipped: 0, unreadable: 0, unreadable_verdicts: 0 };
  const loaded = listRuns().map((id) => { const dir = path.join(RUNS_ROOT, id); return { id, dir, meta: readMeta(dir) }; });
  checkRunners(loaded.map((run) => run.meta)); // 停在 running 的几条一次核对完，不逐条启动查询
  const runs = loaded.map(({ id, dir, meta }) => {
    const running = isRunning(meta);
    if (!meta) totals.unreadable++;
    if (running) totals.running_skipped++;
    return { id, dir, meta, running, result: meta && !running ? readRecord(dir, 'result.json') : null };
  });
  const rows = new Map(), seatTimes = new Map(), groups = new Map();
  const rowFor = (meta, result, module) => {
    const host = meta.participant === 'host', model = host ? meta.model ?? 'claude-code' : baseModel(meta, result);
    const key = JSON.stringify([host, model, module]);
    if (!rows.has(key)) {
      const row = { model, module, ...(host ? { participant: 'host', self_judged: true } : {}), seats: 0, runs: 0, findings_reported: module === 'review' ? 0 : null,
        judged_runs: 0, judged: 0, accepted: 0, partial: 0, rejected: 0, unique: null, unique_basis_runs: 0,
        rework: ['run', 'image'].includes(module) ? { seats: 0, reworked: 0, rate: null } : null,
        duration_s: { total: 0, median_per_seat: null, missing_runs: 0 },
        tokens: { input: null, cached_input: null, output: null, runs: 0, missing_runs: 0 },
        cost_usd: { total: null, runs: 0, missing_runs: 0 } };
      rows.set(key, row);
      seatTimes.set(row, []);
    }
    return rows.get(key);
  };
  for (const { root, module, rounds } of seatChains(runs, totals)) {
    if (root.running || o.module != null && module !== o.module || cutoff != null && !(Date.parse(root.meta.started_at) >= cutoff)) continue;
    totals.seats++;
    totals.runs += rounds.filter((run) => !run.running).length;
    const rootRow = rowFor(root.meta, root.result, module);
    rootRow.seats++;
    if (rootRow.rework) {
      rootRow.rework.seats++;
      if (rounds.some((run) => {
        if (run.running) return false;
        const parent = rounds.find((p) => p.id === run.meta.parent);
        if (!parent) return false;
        const outcome = runOutcome(parent);
        return outcome.status === 'done' && resultValid(parent.meta, outcome.result) && !outcome.blocked;
      })) rootRow.rework.reworked++;
    }
    const host = root.meta.participant === 'host', durations = host ? [] : rounds.map(durationOf);
    if (!host && !rounds.some((run) => run.running) && durations.every((n) => n != null)) seatTimes.get(rootRow).push(durations.reduce((sum, n) => sum + n, 0));
    let cumulative = [0, 0, 0];
    for (const [i, run] of rounds.entries()) {
      // 同一席重启的那一轮是新会话，会话累计用量从零算起。
      if (!run.meta.parent) cumulative = [0, 0, 0];
      if (run.running) continue;
      const { meta, result } = run, row = rowFor(meta, result, module);
      run.row = row;
      row.runs++;
      if (!host) {
        if (durations[i] == null) row.duration_s.missing_runs++;
        else row.duration_s.total += durations[i];
        let usage = result?.usage, scope = result?.usage_scope ?? (meta.mode === 'resume' ? 'session_total' : 'this_run');
        // 只有这条续接链的最后一轮（后面没有接着它续的）能从会话记录补读用量。
        if (usage == null && agentTypeOf(meta) === 'codex cli' && meta.session_id && !rounds.some((other) => other.meta.parent === run.id)) {
          usage = statsOf(meta)?.total_token_usage;
          scope = 'session_total';
        }
        if (usage != null) {
          // 会话累计值先扣掉之前各轮；累计倒退时这轮缺失，但仍以新累计值为下一轮基线。
          const values = TOKEN_FIELDS.map((key) => usage[key] ?? 0);
          usage = scope === 'session_total' ? values.map((n, j) => n - cumulative[j]) : values;
          cumulative = scope === 'session_total' ? values : cumulative.map((n, j) => n + values[j]);
          if (usage.some((n) => n < 0)) usage = null;
        }
        if (usage == null) row.tokens.missing_runs++;
        else {
          for (const [j, key] of ['input', 'cached_input', 'output'].entries()) row.tokens[key] = (row.tokens[key] ?? 0) + usage[j];
          row.tokens.runs++;
        }
        const cost = costOf({ ...meta, ...result, agent_type: agentTypeOf(meta) }, prices);
        if (cost.cost_source === 'unknown') {
          if (agentTypeOf(meta) !== 'host') row.cost_usd.missing_runs++;
        }
        else {
          row.cost_usd.total = (row.cost_usd.total ?? 0) + cost.cost_usd;
          row.cost_usd.runs++;
        }
      }
      const findings = findingsOf(result, module);
      if (findings) row.findings_reported += findings.length;
      const hasVerdict = fs.existsSync(path.join(run.dir, 'verdict.json'));
      run.verdict = hasVerdict ? readVerdict(run.dir) : findings?.length === 0 && result?.report?.verdict === 'no_issues' ? { items: {} } : null;
      if (!run.verdict) {
        if (hasVerdict) totals.unreadable_verdicts++;
        continue;
      }
      totals.judged_runs++;
      row.judged_runs++;
      for (const { verdict } of Object.values(run.verdict.items)) {
        row.judged++;
        row[{ accept: 'accepted', partial: 'partial', reject: 'rejected' }[verdict]]++;
      }
      const key = peerKey(meta, module);
      if (key) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(run);
      }
    }
  }
  countUnique(groups);
  for (const row of rows.values()) {
    row.duration_s.median_per_seat = median(seatTimes.get(row));
    if (row.rework?.seats) row.rework.rate = Number((row.rework.reworked / row.rework.seats).toFixed(2));
  }
  print({ runs_dir: RUNS_ROOT, module: o.module ?? null, since_days: since, generated_at: new Date().toISOString(), totals,
    rows: [...rows.values()].sort((a, b) => MODULES.indexOf(a.module) - MODULES.indexOf(b.module) || b.seats - a.seats || a.model.localeCompare(b.model)),
    notes: M.statsNotes });
}

export { cmdJudge, cmdStats };
