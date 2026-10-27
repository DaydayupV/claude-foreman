// Claude Code 的报告是已完成的记录，和外部席共用登记锁以固定提交顺序。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ENTRY, DISCUSS_SCHEMA, REVIEW_SCHEMA } from './config.mjs';
import { RUNS_ROOT, CLAUDE_SESSION, newRunDir, readRunsLocked } from './records.mjs';
import { readPlan, startCommands } from './plan.mjs';
import { validateReviewMaterial } from './review-scope.mjs';
import { validateSchema } from './runner.mjs';
import { M, die, need, readJson } from './util.mjs';

export async function cmdSubmit(o, load) {
  const plan = readPlan(need(o, 'plan'));
  if (!['discuss', 'review'].includes(plan.module) || !plan.host) die(M.submitNoHost(plan.plan_id));
  const file = path.resolve(need(o, 'report')), kind = plan.module;
  if (!fs.existsSync(file)) die(M.fileNotFound(file));
  const bytes = fs.readFileSync(file);
  let report, errors;
  try {
    report = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    errors = validateSchema(readJson(kind === 'discuss' ? DISCUSS_SCHEMA : REVIEW_SCHEMA), report);
  } catch (e) { errors = [e.message]; }
  if (errors.length) die(M.submitBadReport(file, M.answerKinds[kind], M.list(errors)));
  // 材料和配置与登记顺序无关，在锁外先查：外部审查席也是启动前校验材料。
  const max = kind === 'discuss' ? load(plan.cwd).dispatch.discuss_max_rounds : 1;
  if (kind === 'review') validateReviewMaterial({ ...plan.review, cwd: plan.cwd }, plan);
  const report_sha256 = createHash('sha256').update(bytes).digest('hex');
  const { id, dir, release } = await newRunDir({ plan: plan.plan_id });
  // 拒绝时删掉刚建的空记录目录，免得 status 把它算成读不出的记录。
  const refuse = (message) => { fs.rmSync(dir, { recursive: true, force: true }); die(message); };
  let result;
  try {
    // 和准入同样读：读不出的记录可能就是一份报告，跳过它会把轮次算错，所以直接拒绝。
    const { runs: all, unreadable } = readRunsLocked(id);
    if (unreadable.length) refuse(M.admissionUnreadable(M.list(unreadable)));
    const runs = all.filter((run) => run.meta.plan === plan.plan_id).sort((a, b) => a.id.localeCompare(b.id));
    const answers = runs.filter((run) => run.meta.participant === 'host');
    const round = Math.max(0, ...answers.map((run) => run.meta.round ?? 0)) + 1, parent = answers.at(-1)?.id ?? null;
    if (kind === 'discuss' && round > max) refuse(M.hostRoundsExceeded(plan.plan_id, answers.length, max));
    if (kind === 'review' && answers.length) refuse(M.hostReviewAlreadySubmitted(plan.plan_id, answers[0].id));
    const submitted_at = new Date().toISOString(), model = o.model ?? null;
    const common = { mode: 'submit', kind, module: kind, status: 'done', participant: 'host', agent: 'claude-code', agent_type: 'host',
      model, model_source: o.model != null ? 'self_reported' : null, plan: plan.plan_id, seat: 0, role: plan.host.role,
      round, parent, author: !!o.author, report_sha256, submitted_at };
    fs.writeFileSync(path.join(dir, 'report.json'), bytes);
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ run_id: id, ...common, report,
      usage: null, usage_scope: null, duration_s: null, errors: [], notes: [], warnings: [], run_dir: dir }, null, 2));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ id, ...common, group: plan.group, cwd: plan.cwd, level: plan.level,
      cell: plan.cell, title: null, ...(kind === 'review' ? { review_fingerprint: plan.review.fingerprint } : {}),
      claude_session: CLAUDE_SESSION, started_at: submitted_at, ended_at: submitted_at, pid: null, session_id: null }, null, 2));
    const resumable = round === 1 ? [] : plan.seats.flatMap((seat) => {
      const latest = runs.filter((run) => run.meta.participant !== 'host' && run.meta.seat === seat.seat).at(-1);
      return latest && (latest.meta.session_id || fs.existsSync(path.join(RUNS_ROOT, latest.id, 'messages.json')))
        // 模型写这一席上一轮实际用的（启动时可能用 --model 换过），没有记录时才用建计划时的
        ? [{ seat: seat.seat, agent: seat.agent, model: latest.meta.model ?? seat.model ?? null, run_id: latest.id,
          command: `node "${ENTRY}" resume --run ${latest.id} --level ${plan.level} --brief "${M.planPlaceholders.resume}"` }] : [];
    });
    const commands = round === 1 ? startCommands(plan) : resumable.map((seat) => seat.command);
    // 脚本不知道模型档位：后面几轮把能续接的每一席都列出来，并写明广度席不续接，由 Claude 按档位挑
    result = { run_id: id, plan: plan.plan_id, seat: 0, round, submitted_at, report_sha256, run_dir: dir, commands, guidance: M.submitGuidance(plan.module, round),
      ...(round > 1 ? { resumable: resumable.map(({ command, ...seat }) => seat), note: M.submitResumeNote } : {}) };
  } finally { release(); }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
