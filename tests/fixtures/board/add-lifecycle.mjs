// 给 10-18 那场讨论的样例补上流程记录：那时 foreman 还没有派发计划、Claude Code 席报告和裁决记录，
// 这里按对话记录补一份：计划建在写完议题之后（21:40:20），Claude Code 席报告在各席启动前十来秒交，
// 第 2 轮的报告在写完续接说明之后交；裁决在写结论之前。时刻比实际流程略早，好让 12 倍速回放里看得清每一步。
// 观点编号和去留是样例数据，不是当时的真实裁决。可以重复运行，结果一样。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runs');
const PLAN = '20261018-214020-skrl', GROUP = 'skills-roles-1018', SESSION = '00000000-0000-4000-8000-0000000d3e40', CWD = 'C:\\demo-lab\\roles';
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); };
const remove = (p) => fs.rmSync(path.join(root, p), { recursive: true, force: true });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const at = (iso, plus = 0) => new Date(Date.parse(iso) + plus * 1000).toISOString();

// 第 1 轮五席按启动顺序就是座位号；第 2 轮是同一席的续接
const round1 = ['20261018-214057-66bi', '20261018-214101-vuja', '20261018-214105-okqr', '20261018-214109-bwbm', '20261018-214113-2oya'];
const round2 = ['20261018-220232-au95', '20261018-220236-0tve', '20261018-220240-sa9g', '20261018-220244-aaag', '20261018-220248-zqhm'];
// 换过时刻的旧补录记录先删掉
for (const old of ['plans/20261018-214053-skrl.json', '20261018-214055-host', '20261018-220225-host']) remove(old);
const seats = round1.map((id, i) => {
  const m = read(path.join(root, id, 'meta.json'));
  return { seat: i + 1, agent: m.agent, role: null, model: m.model, effort: m.effort ?? null, required: i === 0 };
});

write(path.join(root, 'plans', `${PLAN}.json`), {
  module: 'discuss', cell: 'normal', seats, seat_target: 5, host: { seat: 0, role: null },
  created_at: '2026-10-18T13:40:20.500Z', claude_session: SESSION, cwd: CWD, level: 'normal', group: GROUP,
  required: [seats[0].agent], why: '五个不同的基础模型各出一份角色分工方案；gpt-6-astra 必选', plan_id: PLAN,
});

for (const [n, ids] of [[1, round1], [2, round2]]) ids.forEach((id, i) => {
  const file = path.join(root, id, 'meta.json'), m = read(file);
  write(file, { ...m, plan: PLAN, seat: i + 1, round: n });
});

// Claude Code 席：每轮在外部席启动之前先交报告
for (const [n, id, time, position] of [
  [1, '20261018-214045-host', '2026-10-18T13:40:45.200Z', '按研究流程分角色：机制构思、实证核查、风险审计三类，各自带检查清单'],
  [2, '20261018-220216-host', '2026-10-18T14:02:16.400Z', '机制构思要拆，但按机制来源拆（行为、制度、风险补偿），不按职业身份拆'],
]) {
  const meta = { run_id: id, id, mode: 'submit', kind: 'discuss', module: 'discuss', status: 'done', participant: 'host', agent: 'claude-code', agent_type: 'host',
    model: 'claude-opus-5-5', model_source: 'self_reported', plan: PLAN, seat: 0, role: null, round: n, parent: n === 2 ? '20261018-214045-host' : null, author: true,
    report_sha256: `sample${n}`, submitted_at: time, group: GROUP, cwd: CWD, level: 'normal', cell: 'normal', title: null, claude_session: SESSION,
    started_at: time, ended_at: time, pid: null, session_id: null };
  write(path.join(root, id, 'meta.json'), meta);
  write(path.join(root, id, 'result.json'), { ...meta, report: { position, options: [], critiques: [], open_questions: [], confidence: 'medium' } });
}

// 裁决：每席几条观点，接受 / 部分接受 / 拒绝的比例按座位错开；第 1 轮在 21:55 写结论之前，第 2 轮在 22:09 之前
const pattern = ['accept', 'accept', 'partial', 'reject', 'accept', 'reject', 'accept', 'partial'];
let next = 1;
for (const [ids, time] of [[round1, '2026-10-18T13:55:20.000Z'], [round2, '2026-10-18T14:09:15.000Z']]) ids.forEach((id, i) => {
  const count = 3 + ((i * 3 + ids.length) % 4), items = {}, when = at(time, i * 3);
  for (let k = 0; k < count; k++) items[`P${next++}`] = { verdict: pattern[(i + k * 3) % pattern.length], at: when };
  const m = read(path.join(root, id, 'meta.json'));
  write(path.join(root, id, 'verdict.json'), { run_id: id, module: 'discuss', plan: PLAN, seat: i + 1, group: GROUP, claude_session: SESSION,
    agent: m.agent, model: m.model, updated_at: when, items });
});
// Claude Code 席自己的观点也记去留（自评）
write(path.join(root, '20261018-214045-host', 'verdict.json'), { run_id: '20261018-214045-host', module: 'discuss', plan: PLAN, seat: 0, group: GROUP,
  updated_at: '2026-10-18T13:55:35.000Z', items: { P40: { verdict: 'accept', at: '2026-10-18T13:55:35.000Z' }, P41: { verdict: 'partial', at: '2026-10-18T13:55:35.000Z' }, P42: { verdict: 'reject', at: '2026-10-18T13:55:35.000Z' } } });
write(path.join(root, '20261018-220216-host', 'verdict.json'), { run_id: '20261018-220216-host', module: 'discuss', plan: PLAN, seat: 0, group: GROUP,
  updated_at: '2026-10-18T14:09:30.000Z', items: { P43: { verdict: 'accept', at: '2026-10-18T14:09:30.000Z' }, P44: { verdict: 'accept', at: '2026-10-18T14:09:30.000Z' } } });
console.log('plan, 2 host reports, 12 verdicts written under', root);
