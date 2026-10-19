// 派发计划只描述席位，真正启动时再检查当前配置并登记任务。
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, LEVELS, resolveAgentAlias, resolveProfile, validatePlan } from './config.mjs';
import { RUNS_ROOT, CLAUDE_SESSION, listRuns, readMeta, runOutcome } from './records.mjs';
import { M, die, need, resolveDir } from './util.mjs';

function readPlan(id) {
  if (path.basename(id) !== id) die(M.planNotFound(id));
  try { return JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, 'plans', `${id}.json`), 'utf8')); }
  catch { die(M.planNotFound(id)); }
}

function cmdPlan(o, load, adapters) {
  if (o.module === 'image') die(M.planImageLater);
  if (!['discuss', 'run', 'review'].includes(o.module)) die(M.planModuleChoices(M.list(['discuss', 'run', 'review'])));
  if (!LEVELS.includes(o.cell)) die(M.planCellChoices(o.module, M.list(LEVELS)));
  const cwd = resolveDir(need(o, 'cwd')), group = need(o, 'group'), cfg = load(cwd);
  if (!o.seat.length) die(M.planNoSeats);
  const seats = o.seat.map((value, i) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:=([^=]+))?$/.exec(value);
    if (!match || match[2] !== undefined && !match[2].trim()) die(M.badSeat(value));
    return { seat: i + 1, agent: resolveAgentAlias(match[1], cfg, true), role: match[2]?.trim() || null };
  });
  const plan = { module: o.module, cell: o.cell, seats };
  const cell = validatePlan(cfg, plan, adapters);
  plan.seats = seats.map((seat) => {
    const profile = resolveProfile(cfg, { ...seat, module: o.module, cell: o.cell }, {}, adapters);
    return { ...seat, model: profile.model ?? null, effort: profile.effort, required: cell.required.includes(seat.agent) };
  });
  Object.assign(plan, { created_at: new Date().toISOString(), claude_session: CLAUDE_SESSION, cwd,
    level: o.cell, group, required: cell.required, why: o.why ?? null });
  const dir = path.join(RUNS_ROOT, 'plans');
  fs.mkdirSync(dir, { recursive: true });
  let file;
  for (;;) {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    plan.plan_id = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
    file = path.join(dir, `${plan.plan_id}.json`);
    try { fs.writeFileSync(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const placeholders = M.planPlaceholders;
  const brief = o.module === 'discuss' ? placeholders.topic : o.module === 'review' ? placeholders.review : placeholders.brief;
  const commands = seats.map((seat) => `node "${ENTRY}" ${o.module} --plan ${plan.plan_id} --seat ${seat.seat} --brief "${brief}" --title "${placeholders.title}"${o.module === 'run' ? ` --scope "${placeholders.scope}"` : ''}`);
  process.stdout.write(JSON.stringify({ ...plan, file, commands }, null, 2) + '\n');
}

function planStatus(id) {
  const plan = readPlan(id);
  const runs = listRuns().map((id) => { const dir = path.join(RUNS_ROOT, id); return { id, dir, meta: readMeta(dir) }; })
    .filter((run) => run.meta?.plan === id)
    .sort((a, b) => Date.parse(a.meta.started_at) - Date.parse(b.meta.started_at) || a.id.localeCompare(b.id));
  const seats = plan.seats.map((seat) => {
    const rounds = runs.filter((run) => run.meta.seat === seat.seat), latest = rounds.at(-1);
    const outcome = latest && runOutcome(latest);
    const module = latest?.meta.module || (latest?.meta.kind === 'discuss' || latest?.meta.mode === 'discuss' ? 'discuss'
      : latest?.meta.kind === 'review' || latest?.meta.mode === 'review' ? 'review' : 'run');
    const valid = outcome?.ok && (outcome.result?.report || module === 'review' && outcome.result?.last_message?.trim());
    return { seat: seat.seat, agent: seat.agent, role: seat.role, required: seat.required,
      run_id: latest?.id ?? null, runs: rounds.map((run) => run.id), status: outcome?.status ?? 'not_started',
      ok: !latest || outcome.running ? null : !!valid };
  });
  const required = seats.filter((seat) => seat.required);
  const ended = (seat) => seat.run_id !== null && seat.status !== 'running';
  const state = required.length ? required.every((seat) => seat.ok === true) ? 'complete'
    : required.some((seat) => ended(seat) && !seat.ok) ? 'incomplete' : 'pending'
    : seats.every(ended) ? seats.some((seat) => seat.ok) ? 'complete' : 'incomplete' : 'pending';
  return { plan_id: id, module: plan.module, cell: plan.cell, group: plan.group, created_at: plan.created_at, state, seats,
    missing_required: required.filter((seat) => seat.ok !== true).map(({ seat, agent, status }) => ({ seat, agent, status })) };
}

export { cmdPlan, readPlan, planStatus };
