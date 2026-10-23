import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.join(here, 'universe');
const base = Date.parse('2026-10-22T09:00:00Z'), privateText = 'UNIVERSE_PRIVATE_SENTINEL_8D4A';
const iso = (sec) => new Date(base + sec * 1000).toISOString();
const write = (file, value, sec = 210) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  fs.utimesSync(target, new Date(iso(sec)), new Date(iso(sec)));
};
const agents = [
  ['gpt-6.1-sol-codex-cli', 'codex cli', 2, 'gpt-6.1-sol'],
  ['gpt-6-astra-codex-cli', 'codex cli', 4, 'gpt-6-astra'],
  ['gemini-4-argon-contributor', 'opencode cli', 4, 'opencode-go/gemini-4-argon-contributor'],
  ['deepseek-v4.1-flash', 'opencode cli', 4, 'opencode-go/deepseek-v4.1-flash'],
  ['glm-5.3-flash', 'opencode cli', 4, 'opencode-go/glm-5.3-flash'],
  ['mimo-v2.6-pro-pi-cli', 'pi cli', 4, 'xiaomi/mimo-v2.6-pro'],
  ['kimi-k2.6', 'api', 4, 'kimi-k2.6'],
];
const sessions = [
  ['roles', 'C:/demo-lab/roles', '讨论 skill 的角色分配', 5400, [[0, 10], [95, 125], [185, 200]]],
  ['split', 'D:/work/shop-api', '拆分导出脚本', 2400, [[20, 30], [125, 140]]],
  ['review', 'd:\\WORK\\shop-api\\', '审查缓存层改动', 7200, [[60, 75], [160, 180]]],
  ['solo', 'D:/work/shop-api', '修复优惠券舍入', 900, [[0, 8], [70, 85]]],
  ['mascot', 'O:/sites/blog', '首页吉祥物', 1800, [[15, 30], [105, 112], [175, 190]]],
  ['factor', 'D:/work/factor-lab', '动量因子研究', 3600, [[0, 35], [92, 100]]],
  ['readme', 'D:/work/factor-lab', '整理 README 措辞', 14400, []],
  ['star', 'c:\\DEMO-LAB\\roles\\', 'board 星图设计', 10800, [[5, 25], [50, 58], [140, 170]]],
  ['migrate', 'O:/sites/blog', '迁移评论数据', 6000, []],
].map(([name, cwd, title, age, think]) => ({ id: `demo-${name}`, name, cwd, title, age, think, rows: [], runs: [] }));
const folderOf = (cwd) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase().replace(/[^a-z0-9]/g, '-');
const row = (session, type, sec, content, extra = {}) => ({ type, timestamp: iso(sec), cwd: session.cwd, sessionId: session.id,
  isSidechain: false, message: { content, ...extra } });
const assistant = (session, sec, content, stop = null) => row(session, 'assistant', sec, content, {
  id: `${session.id}-${sec}`, model: 'claude-opus-5-5', stop_reason: stop,
  usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 40 },
});
const ask = (session, sec, id) => assistant(session, sec, [{ type: 'tool_use', id, name: 'AskUserQuestion',
  input: { questions: [{ header: '图像路线', question: privateText }] } }]);
const get = (name) => sessions.find((s) => s.name === name);

if (path.dirname(root) !== here) throw new Error('board: invalid fixture directory');
fs.rmSync(root, { recursive: true, force: true });
write('config.json', { agents: Object.fromEntries(agents.map(([id, type, max_parallel]) => [id, { type, max_parallel }])) });
for (const session of sessions) {
  session.rows.push(row(session, 'user', -session.age, `${session.title}\n${privateText}`));
  if (session.name !== 'star') session.rows.push({ type: 'custom-title', timestamp: iso(-session.age), customTitle: session.title });
  session.rows.push(assistant(session, -session.age + 1, [{ type: 'text', text: privateText }], 'end_turn'));
  for (const [i, [start, end]] of session.think.entries()) {
    if (i === 0 && session.name !== 'star') session.rows.push(row(session, 'user', start, `${session.title}\n${privateText}`));
    session.rows.push(assistant(session, start + 0.1, [{ type: 'thinking', thinking: privateText }]));
    session.rows.push(assistant(session, end, [{ type: 'text', text: privateText }], 'end_turn'));
  }
}
const mascot = get('mascot');
mascot.rows.push(ask(mascot, 30, 'route-first'));
mascot.rows.push(row(mascot, 'user', 105, [{ type: 'tool_result', tool_use_id: 'route-first', content: privateText }]));
mascot.rows.push(ask(mascot, 190.1, 'route-final'));
const readme = get('readme');
readme.rows.push(assistant(readme, -10800, [{ type: 'text', text: privateText }], 'end_turn'));
const migrate = get('migrate');
migrate.rows.push(row(migrate, 'user', -2400, `${migrate.title}\n${privateText}`));
migrate.rows.push(assistant(migrate, -2399, [{ type: 'text', text: privateText }], 'end_turn'));

let sequence = 0;
// planAt：这一席属于哪个时刻建的计划（默认就是它启动的时刻）；补漏席比同计划的其他席晚启动
function run(session, kind, group, start, end, agent, role = null, status = 'done', parent = null, seat = null, planAt = start) {
  const time = iso(start).slice(11, 19).replaceAll(':', ''), id = `20261022-${time}-${String(++sequence).padStart(4, '0')}`;
  const known = agents.find((a) => a[0] === agent), model = known?.[3] ?? 'unpriced-fixture-model';
  const plan = group ? `plan-${group}-${planAt}` : null, meta = { id, mode: kind === 'exec' ? 'run' : kind, kind,
    module: kind === 'image' ? 'image' : kind === 'review' ? 'review' : 'run', agent, agent_type: known?.[1] ?? 'api',
    model, model_shown: model, cwd: session.cwd, claude_session: session.id, title: session.title,
    status, pid: null, parent, group, plan, seat, role, round: parent ? 2 : 1, started_at: iso(start), ended_at: iso(end) };
  const events = [
    { type: 'api.request', ts: iso(start), model, attempt: 1 },
    { type: 'item.completed', ts: iso(start + 1), item: { id: 'think', type: 'reasoning', text: privateText } },
    { type: 'item.started', ts: iso(start + 2), item: { id: 'read', type: 'command_execution', category: 'read', label: 'src/demo.mjs' } },
    { type: 'item.completed', ts: iso(start + 3), item: { id: 'read', type: 'command_execution', category: 'read', label: 'src/demo.mjs' } },
  ];
  if (session.name === 'factor') events.push({ type: 'api.queued', ts: iso(35.2) }, { type: 'api.request', ts: iso(60), model, attempt: 1 });
  events.push({ type: status === 'done' ? 'turn.completed' : 'api.error', ts: iso(end),
    ...(status === 'done' ? { usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 80 } } : { message: privateText }) });
  events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  write(`runs/${id}/meta.json`, meta, end);
  write(`runs/${id}/events.jsonl`, events.map((e) => JSON.stringify(e)).join('\n') + '\n', end);
  write(`runs/${id}/result.json`, { run_id: id, status, duration_s: end - start, cost_usd: 0.02,
    usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 80 }, last_message: privateText,
    report: kind === 'review' ? { verdict: 'approve', findings: [] } : { summary: privateText, position: privateText } }, end);
  write(`runs/${id}/verdict.json`, { updated_at: iso(end), items: { summary: { at: iso(end), verdict: 'accept' } } }, end);
  if (plan) {
    session.runs.push({ id, meta });
    const seats = session.runs.filter((r) => r.meta.plan === plan).map((r) => ({ seat: r.meta.seat, agent: r.meta.agent, model: r.meta.model, role: r.meta.role, required: false }));
    write(`runs/plans/${plan}.json`, { plan_id: plan, created_at: iso(planAt - 1), module: meta.mode, cell: 'normal', group,
      claude_session: session.id, cwd: session.cwd, why: '合成派发计划', seats }, planAt - 1);
  }
  session.rows.push(assistant(session, start - 0.1, [{ type: 'tool_use', id: `dispatch-${id}`, name: 'Bash', input: {
    command: `node "C:/demo/cli.mjs" ${meta.mode} --agent ${agent}${plan ? ` --plan ${plan} --seat ${seat}` : ''}`, run_in_background: true } }]));
  session.rows.push(row(session, 'user', start, [{ type: 'tool_result', tool_use_id: `dispatch-${id}`, content: `Command running in background with ID: task${sequence}` }]));
  return id;
}
const roles = get('roles'), roleAgents = [1, 2, 3, 5, 4], first = [];
for (const [i, agent] of roleAgents.entries()) first.push(run(roles, 'discuss', 'skills-roles-1018', 10, [88, 72, 80, 95, 76][i], agents[agent][0], ['架构', '用户体验', '反方', '成本', '综合对照'][i], 'done', null, i + 1));
for (const [i, agent] of roleAgents.entries()) run(roles, 'discuss', 'skills-roles-1018', 125, [178, 162, 170, 185, 166][i], agents[agent][0], null, 'done', first[i], i + 1);
run(get('split'), 'exec', 'roles-split-1018', 30, 110, agents[0][0], '实现', 'done', null, 1);
run(get('split'), 'exec', 'roles-split-1018', 30, 125, agents[3][0], '测试', 'done', null, 2);
for (const [i, agent] of [1, 2, 4].entries()) run(get('review'), 'review', 'roles-review-1018', 75, [140, 150, 160][i], agents[agent][0], null, 'done', null, i + 1);
// 3 级审查的补漏席：建计划时就列进去，其他三席结束、去重以后才启动
run(get('review'), 'review', 'roles-review-1018', 165, 185, agents[3][0], '补漏', 'done', null, 4, 75);
run(get('solo'), 'exec', null, 8, 70, agents[0][0]);
run(mascot, 'image', null, 112, 175, agents[0][0]);
run(get('factor'), 'discuss', 'factor-q-1022', 35, 90, agents[6][0], null, 'quota_exhausted', null, 1);
run(get('star'), 'exec', null, 145, 169, 'fixture-unconfigured-agent');
run(migrate, 'exec', null, -2600, -2500, agents[0][0], null, 'failed');
const host = '20261022-090120-host';
write(`runs/${host}/meta.json`, { id: host, participant: 'host', kind: 'review', status: 'done', claude_session: 'demo-review',
  agent: 'claude-code', model: 'claude-opus-5-5', started_at: iso(80), ended_at: iso(80) }, 80);
write(`runs/${host}/events.jsonl`, '', 80);
write(`runs/${host}/result.json`, { cost_usd: 0, report: { verdict: 'approve', findings: [] } }, 80);

for (const session of sessions) {
  session.rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  write(`claude/${folderOf(session.cwd)}/${session.id}.jsonl`, session.rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
    Math.max(...session.rows.map((r) => (Date.parse(r.timestamp) - base) / 1000)));
}
write(`claude/${folderOf(roles.cwd)}/subagents/agent-demo.jsonl`, `${JSON.stringify(row(roles, 'user', 200, privateText))}\n`, 200);
write(`claude/${folderOf(roles.cwd)}/demo-older.jsonl`, `${JSON.stringify(row(roles, 'user', -90000, privateText))}\n`, -90000);
function stamp(dir) {
  for (const child of fs.readdirSync(dir, { withFileTypes: true })) if (child.isDirectory()) stamp(path.join(dir, child.name));
  fs.utimesSync(dir, new Date(iso(210)), new Date(iso(210)));
}
stamp(root);
process.stdout.write(`board: universe sample written to ${root}\n`);
