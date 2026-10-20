// 派发计划固定席位和审查材料，真正启动时再检查当前配置并登记任务。
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, USER_CONFIG, MODULE_CELLS, resolveAgentAlias, resolveProfile, validatePlan } from './config.mjs';
import { RUNS_ROOT, CLAUDE_SESSION, listRuns, readMeta, checkRunners, runOutcome } from './records.mjs';
import { validateReviewMaterial } from './review-scope.mjs';
import { M, die, need, resolveDir } from './util.mjs';
import { D } from './format.mjs';

// 读不到时返回 null，不退出进程：实时查看里计划文件被删了也要接着显示。
function loadPlan(id) {
  if (path.basename(id) !== id) return null;
  try { return JSON.parse(fs.readFileSync(path.join(RUNS_ROOT, 'plans', `${id}.json`), 'utf8')); }
  catch { return null; }
}
const readPlan = (id) => loadPlan(id) ?? die(M.planNotFound(id));

// 和 hooks/record-answers.mjs 的标记保持一致，只认图像路线弹窗。
const ROUTE_MARKER = /图像路线|image route/i;

// 最近一次路线弹窗必须已回答，并且明确选中了这份计划的路线。
function routeConfirmation(sessionId, route) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId || '')) die(M.routeNoSession);
  let text;
  try { text = fs.readFileSync(path.join(path.dirname(USER_CONFIG), 'answers', `${sessionId}.jsonl`), 'utf8'); }
  catch { die(M.routeNotAsked); }
  // 弹窗的先后按每个 tool_use_id 第一次出现的位置算：迟到或重复的回答不改顺序，钩子漏记了提问时由回答补上。
  // 没有 tool_use_id 的记录配不上对，各算一次弹窗。
  const groups = new Map();
  let latest = null;
  const marked = (q) => ROUTE_MARKER.test(q?.question || '') || ROUTE_MARKER.test(q?.header || '');
  text.split('\n').forEach((line, i) => {
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (!['asked', 'answered'].includes(record?.event) || !Array.isArray(record.questions) || !record.questions.some(marked)) return;
    const id = typeof record.tool_use_id === 'string' && record.tool_use_id ? record.tool_use_id : `#${i}`;
    if (!groups.has(id)) { groups.set(id, []); latest = id; }
    groups.get(id).push(record);
  });
  if (latest === null) die(M.routeNotAsked);
  // 同一次弹窗有几条回答时只认最后一条。
  const answered = groups.get(latest).filter((r) => r.event === 'answered').slice(-1);
  const replies = answered.flatMap((r) => r.questions.filter(marked).flatMap((q) => {
    const answer = r.answers?.[q.question];
    return typeof answer === 'string' && answer.trim() ? [{ r, q, answer }] : [];
  }));
  if (!replies.length) die(M.routeNotAnswered);
  const chosen = replies.flatMap(({ r, q, answer }) => {
    if (q.multiSelect === true) return [];
    const label = (Array.isArray(q.options) ? q.options : []).find((value) => typeof value === 'string' && value.trim() === answer.trim());
    const number = label && '①②③④'.indexOf(label.trim()[0]) + 1;
    return number ? [{ route: number, tool_use_id: r.tool_use_id ?? null, question: q.question, answer, answered_at: r.at }] : [];
  });
  if (!chosen.length) die(M.routeNotChosen(replies.map((r) => r.answer).join(' / ').slice(0, 80)));
  const match = chosen.find((r) => r.route === route);
  if (!match) die(M.routeMismatch(M.list([...new Set(chosen.map((r) => '①②③④'[r.route - 1]))]), route));
  const { route: _, ...confirmation } = match;
  return confirmation;
}

function cmdPlan(o, load, adapters) {
  if (o.module !== 'review' && (o.target != null || o.file.length || o.uncommitted || o.base != null || o.commit != null)) die(M.planReviewOnly);
  if (!Object.hasOwn(MODULE_CELLS, o.module)) die(M.planModuleChoices(M.list(Object.keys(MODULE_CELLS))));
  if (o.module === 'image') {
    if (o.route == null) die(M.planRouteRequired);
    if (!['1', '2', '3', '4'].includes(o.route)) die(M.planRouteChoices(o.route));
  } else if (o.route != null) die(M.planRouteImageOnly);
  if (!MODULE_CELLS[o.module].includes(o.cell)) die(M.planCellChoices(o.module, M.list(MODULE_CELLS[o.module])));
  const cwd = resolveDir(need(o, 'cwd')), group = need(o, 'group'), cfg = load(cwd);
  if (!o.seat.length) die(M.planNoSeats);
  const seats = o.seat.map((value, i) => {
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:=([^=]+))?$/.exec(value);
    if (!match || match[2] !== undefined && !match[2].trim()) die(M.badSeat(value));
    return { seat: i + 1, agent: resolveAgentAlias(match[1], cfg, true), role: match[2]?.trim() || null };
  });
  const plan = { module: o.module, cell: o.cell, seats, ...(o.module === 'image' ? { route: Number(o.route) } : {}) };
  if (o.module === 'review') {
    const material = validateReviewMaterial({ ...o, cwd });
    plan.review = { target: o.target || 'diff', file: o.file, uncommitted: (o.target || 'diff') === 'diff' && !o.base && !o.commit,
      base: o.base ?? null, commit: o.commit ?? null, fingerprint: material?.fingerprint ?? null };
  }
  const cell = validatePlan(cfg, plan, adapters);
  plan.seats = seats.map((seat) => {
    const profile = resolveProfile(cfg, { ...seat, module: o.module, cell: o.cell }, {}, adapters);
    return { ...seat, model: profile.model ?? null, effort: profile.effort, required: cell.required.includes(seat.agent) };
  });
  if (o.module === 'image') plan.route_confirmation = routeConfirmation(CLAUDE_SESSION, plan.route);
  Object.assign(plan, { created_at: new Date().toISOString(), claude_session: CLAUDE_SESSION, cwd,
    level: o.module === 'image' ? null : o.cell, group, required: cell.required, why: o.why ?? null });
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
  const commands = seats.map((seat) => `node "${ENTRY}" ${o.module} --plan ${plan.plan_id} --seat ${seat.seat} --brief "${brief}" --title "${placeholders.title}"${['run', 'image'].includes(o.module) ? ` --scope "${o.module === 'image' ? placeholders.outDir : placeholders.scope}"` : ''}`);
  process.stdout.write(JSON.stringify({ ...plan, file, commands }, null, 2) + '\n');
}

// 不给 runs 时从全部记录里找这份计划的任务；实时查看传入组里的任务，免得每秒把全部记录读一遍。
function planStatus(id, runs = null, plan = readPlan(id)) {
  runs = (runs ?? listRuns().map((rid) => { const dir = path.join(RUNS_ROOT, rid); return { id: rid, dir, meta: readMeta(dir) }; }))
    .filter((run) => run.meta?.plan === id)
    .sort((a, b) => Date.parse(a.meta.started_at) - Date.parse(b.meta.started_at) || a.id.localeCompare(b.id));
  checkRunners(runs.map((run) => run.meta)); // 运行中的几席一次核对完
  const seats = plan.seats.map((seat) => {
    const rounds = runs.filter((run) => run.meta.seat === seat.seat), latest = rounds.at(-1);
    const outcome = latest && runOutcome(latest);
    const module = latest?.meta.module || (latest?.meta.kind === 'discuss' || latest?.meta.mode === 'discuss' ? 'discuss'
      : latest?.meta.kind === 'review' || latest?.meta.mode === 'review' ? 'review' : 'run');
    // 审查以结构化报告为准，没审完（incomplete）不算；没有报告时，只有 Codex 原生审查和第 2 期以前的旧记录的文字算数。
    const r = outcome?.result;
    const valid = outcome?.ok && (module !== 'review' ? !!r?.report : r?.report ? r.report.verdict !== 'incomplete'
      : !!r?.last_message?.trim() && (r.native_review || r.review_target === undefined));
    return { seat: seat.seat, agent: seat.agent, role: seat.role, required: seat.required,
      run_id: latest?.id ?? null, runs: rounds.map((run) => run.id), status: outcome?.status ?? 'not_started',
      ok: !latest || outcome.running ? null : !!valid, stale: module === 'review' ? r?.stale ?? null : null };
  });
  const required = seats.filter((seat) => seat.required);
  const ended = (seat) => seat.run_id !== null && seat.status !== 'running';
  const state = required.length ? required.every((seat) => seat.ok === true) ? 'complete'
    : required.some((seat) => ended(seat) && !seat.ok) ? 'incomplete' : 'pending'
    : seats.every(ended) ? seats.some((seat) => seat.ok) ? 'complete' : 'incomplete' : 'pending';
  // 补漏席还没交回有效结果（没启动、还在跑、失败或结果无效）都算没跑完。
  const gap = seats.filter((seat) => {
    const role = seat.role?.trim().toLowerCase();
    return (role === '补漏' || role === 'gap') && seat.ok !== true;
  });
  return { plan_id: id, module: plan.module, cell: plan.cell, ...(plan.module === 'image' ? { route: plan.route } : {}), group: plan.group, created_at: plan.created_at, state, seats,
    missing_required: required.filter((seat) => seat.ok !== true).map(({ seat, agent, status }) => ({ seat, agent, status })),
    gap_unfinished: gap.map(({ seat, agent, status }) => ({ seat, agent, status })) };
}

// 组里每份计划一行：完整、进行中还是不完整，缺了哪个必选。实时查看和 status --group 用；计划文件读不到的跳过。
function describePlans(runs) {
  return [...new Set(runs.map((run) => run.meta?.plan).filter(Boolean))].flatMap((id) => {
    const plan = loadPlan(id);
    if (!plan) return [];
    const { state, missing_required: missing, seats: statuses, gap_unfinished: gap } = planStatus(id, runs, plan);
    const seats = (list, label) => D.list(list.map((s) => D.watchPlanSeat(s.agent, s.seat, label(s))));
    const ended = missing.filter((s) => !['not_started', 'running'].includes(s.status));
    const waiting = missing.filter((s) => s.status === 'not_started');
    const detail = state === 'incomplete' && ended.length ? D.watchPlanMissing(seats(ended, (s) => (s.status === 'done' ? D.watchPlanNoResult : D.statusName(s.status))))
      : state === 'pending' && waiting.length ? D.watchPlanNotStarted(seats(waiting, () => null)) : '';
    const stale = statuses.filter((s) => s.stale === true);
    const details = [detail, stale.length ? D.watchPlanStale(seats(stale, () => null)) : '',
      gap.length ? D.watchPlanGap(seats(gap, (s) => (s.status === 'not_started' ? D.watchPlanGapNotStarted : s.status === 'done' ? D.watchPlanNoResult : D.statusName(s.status)))) : ''].filter(Boolean).join('; ');
    return [{ id, state, text: D.watchPlanState(id, state, details) }];
  });
}

export { cmdPlan, readPlan, planStatus, describePlans, routeConfirmation };
