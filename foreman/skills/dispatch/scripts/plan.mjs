// 派发计划固定席位和审查材料，真正启动时再检查当前配置并登记任务。
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, USER_CONFIG, MODULE_CELLS, resolveAgentAlias, resolveProfile, validatePlan } from './config.mjs';
import { RUNS_ROOT, CLAUDE_SESSION, listRuns, readMeta, checkRunners, runOutcome } from './records.mjs';
import { validateReviewMaterial, reviewPatchText, MAX_REVIEW_CHARS } from './review-scope.mjs';
import { M, die, need, resolveDir, readAttachments, MAX_MATERIAL_CHARS } from './util.mjs';
import { apiReviewPrompt, API_BRIEF_RESERVE } from './adapters/api.mjs';
import { D, outcomeStyle } from './format.mjs';
import { modelIdentity } from './models.mjs';

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
  if (o['host-role'] != null && !['discuss', 'review'].includes(o.module)) die(M.hostRoleOnly);
  if (o['count-why'] != null && !['discuss', 'review'].includes(o.module)) die(M.countWhyOnly);
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
  // 讨论和审查的 1 级不带角色（角色是 2、3 级的检查视角，见 references/seats.md）；补漏席不是角色
  if (['discuss', 'review'].includes(o.module) && o.cell === 'simple'
    && (o['host-role'] != null || seats.some((seat) => seat.role && !['补漏', 'gap'].includes(seat.role.toLowerCase())))) die(M.planRolesLevel1);
  const plan = { module: o.module, cell: o.cell, seats, seat_target: null, count_why: o['count-why'] ?? null,
    ...(o.module === 'image' ? { route: Number(o.route) } : {}) };
  if (['discuss', 'review'].includes(o.module)) plan.host = { seat: 0, role: o['host-role'] ?? null };
  let material;
  if (o.module === 'review') {
    material = validateReviewMaterial({ ...o, cwd });
    plan.review = { target: o.target || 'diff', file: o.file, uncommitted: (o.target || 'diff') === 'diff' && !o.base && !o.commit,
      base: o.base ?? null, commit: o.commit ?? null, fingerprint: material?.fingerprint ?? null };
  }
  const cell = validatePlan(cfg, plan, adapters);
  // 建计划时按各席运行时的材料预算检查，免得启动前被拒而一直等不到记录。
  if (material?.target === 'diff') {
    const max = { cli: MAX_REVIEW_CHARS, api: MAX_MATERIAL_CHARS, reserve: API_BRIEF_RESERVE };
    const tooLarge = seats.flatMap((seat) => {
      const type = cfg.agents[seat.agent].type;
      if (type === 'codex cli') return [];
      if (type === 'api') {
        const { prompt } = apiReviewPrompt({ cwd, target: 'diff', scope: material, brief: '', files: readAttachments(o.file, cwd, true) });
        const chars = prompt.length + max.reserve;
        return chars > max.api ? [M.planReviewTooLargeSeat(seat.seat, seat.agent, chars)] : [];
      }
      const { chars, tooLarge } = reviewPatchText(material, { budget: max.cli, readsFiles: true });
      return tooLarge ? [M.planReviewTooLargeSeat(seat.seat, seat.agent, chars)] : [];
    });
    if (tooLarge.length) die(M.planReviewTooLarge(M.list(tooLarge), max));
  }
  if (cell.outside_cell) plan.outside_cell = true;
  if (plan.host && !cell.outside_cell) {
    const configured = cfg.modules[o.module].seats[o.cell];
    const usable = new Set(cell.candidates.filter(({ agent }) => {
      const capabilities = adapters[cfg.agents[agent].type].capabilities;
      return capabilities.modes.includes(o.module) && (plan.review?.target !== 'visual' || capabilities.reads_images);
    }).map(({ agent }) => agent)).size;
    plan.seat_target = Math.min(configured, usable);
    const n = seats.filter((seat) => !(o.module === 'review' && o.cell === 'complex' && ['补漏', 'gap'].includes(seat.role?.trim().toLowerCase()))).length;
    if (n !== plan.seat_target && !plan.count_why?.trim()) die(M.planSeatCount(`modules.${o.module}.seats.${o.cell}`, configured, plan.seat_target, n));
  }
  plan.seats = seats.map((seat) => {
    const profile = resolveProfile(cfg, { ...seat, module: o.module, cell: o.cell, ...(plan.outside_cell ? { plan: true, outside_cell: true } : {}) }, {}, adapters);
    return { ...seat, model: profile.model ?? null, effort: profile.effort, required: cell.required.includes(seat.agent) };
  });
  // 补漏席要找前面各席都没用过的基础模型：同一个模型的各种写法（提供方前缀、Bedrock 写法、小数版本号、官方别名）只算一个
  if (o.module === 'review' && o.cell === 'complex') {
    const isGap = (seat) => ['补漏', 'gap'].includes(seat.role?.trim().toLowerCase());
    const base = (seat) => modelIdentity(seat.model ?? seat.agent);
    const used = new Set(plan.seats.filter((seat) => !isGap(seat)).map(base));
    for (const seat of plan.seats.filter(isGap)) if (used.has(base(seat))) die(M.gapSeatSameModel(seat.seat, base(seat)));
  }
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
  const commands = startCommands(plan);
  if (plan.host) commands.unshift(`node "${ENTRY}" submit --plan ${plan.plan_id} --report "${M.planPlaceholders.answer}" --model "${M.planPlaceholders.model}"`);
  // 讨论和审查的席位带了角色（补漏席不算）：启动前一定要弹窗让用户确认分配（硬规则 R4），写在下一步的最前面
  const roles = ['discuss', 'review'].includes(plan.module)
    && (!!plan.host?.role || plan.seats.some((seat) => seat.role && !['补漏', 'gap'].includes(seat.role.trim().toLowerCase())));
  process.stdout.write(JSON.stringify({ ...plan, file, commands, guidance: (roles ? M.planRolesFirst : '') + M.planGuidance(plan.module) }, null, 2) + '\n');
}

function startCommands(plan) {
  const p = M.planPlaceholders, module = plan.module;
  const brief = module === 'discuss' ? p.topic : module === 'review' ? p.review : p.brief;
  return plan.seats.map((seat) => `node "${ENTRY}" ${module} --plan ${plan.plan_id} --seat ${seat.seat} --brief "${brief}" --title "${p.title}"${['run', 'image'].includes(module) ? ` --scope "${module === 'image' ? p.outDir : p.scope}"` : ''}`);
}

// 不给 runs 时从全部记录里找这份计划的任务；实时查看传入组里的任务，免得每秒把全部记录读一遍。
function planStatus(id, runs = null, plan = readPlan(id)) {
  runs = (runs ?? listRuns().map((rid) => { const dir = path.join(RUNS_ROOT, rid); return { id: rid, dir, meta: readMeta(dir) }; }))
    .filter((run) => run.meta?.plan === id)
    .sort((a, b) => a.id.localeCompare(b.id));
  checkRunners(runs.map((run) => run.meta)); // 运行中的几席一次核对完
  const labels = new Map();
  const seats = plan.seats.map((seat) => {
    const rounds = runs.filter((run) => run.meta.seat === seat.seat), latest = rounds.at(-1);
    const outcome = latest && runOutcome(latest);
    if (outcome) labels.set(seat.seat, outcomeStyle(outcome).word);
    const r = outcome?.result;
    return { seat: seat.seat, agent: seat.agent, role: seat.role, required: plan.required ? plan.required.includes(seat.agent) : seat.required,
      run_id: latest?.id ?? null, runs: rounds.map((run) => run.id), status: outcome?.status ?? 'not_started',
      ok: !latest || outcome.running ? null : outcome.ok, stale: plan.module === 'review' ? r?.stale ?? null : null };
  });
  const required = seats.filter((seat) => seat.required);
  const needed = ['run', 'image'].includes(plan.module) ? seats : required;
  const ended = (seat) => seat.run_id !== null && seat.status !== 'running';
  let state = needed.length ? needed.every((seat) => seat.ok === true) ? 'complete'
    : needed.some((seat) => ended(seat) && !seat.ok) ? 'incomplete' : 'pending'
    : seats.every(ended) ? seats.some((seat) => seat.ok) ? 'complete' : 'incomplete' : 'pending';
  // 补漏席还没交回有效结果（没启动、还在跑、失败或结果无效）都算没跑完。
  const gap = seats.filter((seat) => {
    const role = seat.role?.trim().toLowerCase();
    return (role === '补漏' || role === 'gap') && seat.ok !== true;
  });
  const missing = needed.filter((seat) => seat.ok !== true).map(({ seat, agent, status }) => ({ seat, agent, status, label: labels.get(seat) ?? D.statusName(status) }));
  let host;
  if (plan.host) {
    const answers = runs.filter((run) => run.meta.participant === 'host');
    const external = runs.filter((run) => run.meta.participant !== 'host');
    const first = answers[0]?.meta.submitted_at;
    host = { seat: 0, role: plan.host.role, status: answers.length ? 'submitted' : 'missing',
      rounds: answers.map(({ id: run_id, meta: m }) => ({ round: m.round, run_id, submitted_at: m.submitted_at, report_sha256: m.report_sha256, model: m.model, author: m.author })),
      before_external_start: !external.length ? null : !!first && Date.parse(first) < Math.min(...external.map((run) => Date.parse(run.meta.started_at))) };
    if (!answers.length) {
      if (state === 'complete') state = 'pending';
      missing.unshift({ seat: 0, agent: 'claude-code', status: 'not_submitted', label: D.hostNotSubmitted });
    }
  }
  return { plan_id: id, module: plan.module, cell: plan.cell, ...(plan.module === 'image' ? { route: plan.route } : {}), group: plan.group, created_at: plan.created_at, state, seats,
    seat_target: plan.seat_target ?? null, count_why: plan.count_why ?? null,
    ...(host ? { host } : {}), missing,
    missing_required: required.filter((seat) => seat.ok !== true).map(({ seat, agent, status }) => ({ seat, agent, status })),
    gap_unfinished: gap.map(({ seat, agent, status }) => ({ seat, agent, status })),
    // state 只看要交回有效结果的席位：complete 时非必选的席位可能还在跑，单独列出来，免得以为全都结束了
    running: seats.filter((seat) => seat.status === 'running').map(({ seat, agent }) => ({ seat, agent })) };
}

// 组里每份计划一行，列出还没交回有效结果的席位；计划文件读不到的跳过。
function describePlans(runs, all = runs.all ?? runs) {
  return [...new Set(runs.map((run) => run.meta?.plan).filter(Boolean))].flatMap((id) => {
    const plan = loadPlan(id);
    if (!plan) return [];
    const { state, missing, seats: statuses, gap_unfinished: gap } = planStatus(id, all, plan);
    const seats = (list, label) => D.list(list.map((s) => D.watchPlanSeat(s.agent, s.seat, label(s))));
    const ended = missing.filter((s) => !['not_started', 'running', 'not_submitted'].includes(s.status));
    const waiting = missing.filter((s) => s.status === 'not_started');
    const detail = state === 'incomplete' && ended.length ? D.watchPlanMissing(seats(ended, (s) => s.label))
      : state === 'pending' && waiting.length ? D.watchPlanNotStarted(seats(waiting, () => null)) : '';
    const stale = statuses.filter((s) => s.stale === true);
    const gapLabel = (s) => {
      if (s.status === 'not_started') return D.watchPlanGapNotStarted;
      const seat = statuses.find((seat) => seat.seat === s.seat);
      return outcomeStyle(runOutcome(all.find((run) => run.id === seat.run_id))).word;
    };
    const details = [missing.some((s) => s.status === 'not_submitted') ? D.hostNotSubmitted : '', detail, stale.length ? D.watchPlanStale(seats(stale, () => null)) : '',
      gap.length ? D.watchPlanGap(seats(gap, gapLabel)) : ''].filter(Boolean).join('; ');
    return [{ id, state, details, text: D.watchPlanState(id, state, details) }];
  });
}

export { cmdPlan, readPlan, loadPlan, startCommands, planStatus, describePlans, routeConfirmation };
