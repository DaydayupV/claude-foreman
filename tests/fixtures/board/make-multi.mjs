// 多组样例：在 10-18 那场讨论（fixtures/runs）之外，给同一个对话模拟加几组派发，刻度带里卡片多到放不下、要循环滚动：
//  - 单任务（没有组）：gpt-6.1-sol 整理角色卡模板
//  - 并发拆分的执行组（两份）：gpt-6.1-sol 实现角色路由、deepseek 补测试
//  - 审查组（三席 + Claude Code 席）：gpt-6-astra、gemini、glm 审角色分工的改动
// 这些任务和它们的事件都是编的，只用来看版面；写到 fixtures/runs-multi，可以重复运行。
// 用法：node tests/fixtures/board/make-multi.mjs，然后 node foreman/skills/dispatch/scripts/board/server.mjs --runs tests/fixtures/board/runs-multi --replay 00000000-0000-4000-8000-0000000d3e40 ...
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)), from = path.join(here, 'runs'), root = path.join(here, 'runs-multi');
const SESSION = '00000000-0000-4000-8000-0000000d3e40', CWD = 'C:\\demo-lab\\roles';
const iso = (s) => new Date(Date.parse(s)).toISOString(), plus = (s, sec) => new Date(Date.parse(s) + sec * 1000).toISOString();
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`); };

fs.rmSync(root, { recursive: true, force: true });
fs.cpSync(from, root, { recursive: true, filter: (p) => !p.endsWith('board.lock.json') });

// 一个任务的事件：steps 是 [秒, 种类, 内容]，种类 msg / think / cmd / edit / search；最后补一轮用量
function events(start, end, steps, usage) {
  const lines = [{ type: 'thread.started', thread_id: 'sim', ts: plus(start, 1) }, { type: 'turn.started', ts: plus(start, 1.2) }];
  steps.forEach(([sec, kind, text], i) => {
    const ts = plus(start, sec), id = `item_${i}`;
    if (kind === 'msg') lines.push({ type: 'item.completed', item: { id, type: 'agent_message', text }, ts });
    else if (kind === 'think') lines.push({ type: 'item.completed', item: { id, type: 'reasoning', text }, ts });
    else if (kind === 'search') lines.push({ type: 'item.completed', item: { id, type: 'web_search', query: text }, ts });
    else if (kind === 'edit') lines.push({ type: 'item.completed', item: { id, type: 'file_change', changes: [{ path: text.split(' ')[1], kind: text.split(' ')[0] }] }, ts });
    else {
      lines.push({ type: 'item.started', item: { id, type: 'command_execution', command: text, exit_code: null, status: 'in_progress' }, ts });
      lines.push({ type: 'item.completed', item: { id, type: 'command_execution', command: text, exit_code: 0, status: 'completed' }, ts: plus(start, sec + 2) });
    }
  });
  lines.push({ type: 'turn.completed', usage, ts: plus(end, -0.5) });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function run(id, meta, steps, result) {
  const usage = { input_tokens: result.inTok, cached_input_tokens: Math.round(result.inTok * 0.7), output_tokens: result.outTok };
  const full = { id, mode: meta.mode || 'run', kind: meta.kind || 'exec', cwd: CWD, claude_session: SESSION, status: 'done', pid: null, parent: null, round: 1, scope: [],
    model_shown: meta.model, model_name: meta.model, plan: null, seat: null, role: null, group: null, ...meta };
  write(path.join(root, id, 'meta.json'), full);
  write(path.join(root, id, 'events.jsonl'), events(meta.started_at, meta.ended_at, steps, usage));
  write(path.join(root, id, 'result.json'), { run_id: id, status: 'done', duration_s: (Date.parse(meta.ended_at) - Date.parse(meta.started_at)) / 1000, usage, ...result.extra });
}

// ---- 单任务 ----
run('20261018-215620-solo', { agent: 'gpt-6.1-sol-codex-cli', agent_type: 'codex cli', model: 'gpt-6.1-sol', level: 'normal', effort: 'max', title: '整理角色卡模板',
  started_at: iso('2026-10-18T13:56:20Z'), ended_at: iso('2026-10-18T13:59:40Z') }, [
  [3, 'msg', '先读现有的角色卡和偏好文件，再按讨论结论把模板统一成一份。'],
  [8, 'cmd', 'rg -n "角色卡" .agents/skills'], [16, 'cmd', 'Get-Content .agents/skills/roles/cards.md'],
  [40, 'think', '模板里要区分检查视角和工作包两种角色'],
  [70, 'edit', 'update .agents/skills/roles/cards.md'], [95, 'edit', 'add .agents/skills/roles/template.md'],
  [130, 'cmd', 'node scripts/check-cards.mjs'], [170, 'msg', '模板已统一，旧卡片都改成新格式，检查脚本通过。'],
], { inTok: 182000, outTok: 6400, extra: { report: { summary: '角色卡统一成一份模板，旧卡片迁移完毕，检查脚本通过' }, changes: { files: [{ path: '.agents/skills/roles/cards.md', kind: 'update' }, { path: '.agents/skills/roles/template.md', kind: 'add' }] } } });

// ---- 并发拆分的执行组 ----
const SPLIT = '20261018-215650-splt';
write(path.join(root, 'plans', `${SPLIT}.json`), { module: 'run', cell: 'normal', group: 'roles-split-1018', plan_id: SPLIT, created_at: iso('2026-10-18T13:56:50Z'), claude_session: SESSION, cwd: CWD,
  seats: [{ seat: 1, agent: 'gpt-6.1-sol-codex-cli', model: 'gpt-6.1-sol', role: '实现', required: false }, { seat: 2, agent: 'deepseek-v4.1-flash', model: 'opencode-go/deepseek-v4.1-flash', role: '测试', required: false }],
  why: '接口已定，实现和测试分开并行' });
run('20261018-215700-spl1', { agent: 'gpt-6.1-sol-codex-cli', agent_type: 'codex cli', model: 'gpt-6.1-sol', level: 'normal', effort: 'max', title: '实现角色路由', group: 'roles-split-1018', plan: SPLIT, seat: 1, role: '实现',
  started_at: iso('2026-10-18T13:57:00Z'), ended_at: iso('2026-10-18T14:00:30Z') }, [
  [4, 'msg', '按任务说明里的接口实现 routeRole，只改 router 目录。'], [10, 'cmd', 'Get-Content src/roles/router.py'],
  [45, 'edit', 'update src/roles/router.py'], [80, 'edit', 'add src/roles/mechanisms.py'], [120, 'cmd', 'python -m pytest tests/roles -q'],
  [190, 'msg', '路由按机制来源分三类，定向测试 14 项通过。'],
], { inTok: 240000, outTok: 9100, extra: { report: { summary: '路由按机制来源（行为、制度、风险补偿）分三类，定向测试通过' }, changes: { files: [{ path: 'src/roles/router.py', kind: 'update' }, { path: 'src/roles/mechanisms.py', kind: 'add' }] } } });
run('20261018-215704-spl2', { agent: 'deepseek-v4.1-flash', agent_type: 'opencode cli', model: 'opencode-go/deepseek-v4.1-flash', level: 'simple', effort: 'high', title: '补角色路由测试', group: 'roles-split-1018', plan: SPLIT, seat: 2, role: '测试',
  started_at: iso('2026-10-18T13:57:04Z'), ended_at: iso('2026-10-18T14:01:10Z') }, [
  [5, 'msg', '只写 tests/roles 下的测试，用任务说明里给的接口。'], [12, 'cmd', 'ls tests/roles'], [60, 'edit', 'add tests/roles/test_router.py'],
  [150, 'cmd', 'python -m pytest tests/roles -q'], [235, 'msg', '补了 9 个测试，覆盖三类机制和未知来源。'],
], { inTok: 96000, outTok: 4200, extra: { report: { summary: '补 9 个测试，覆盖三类机制来源和未知来源的兜底' }, changes: { files: [{ path: 'tests/roles/test_router.py', kind: 'add' }] } } });

// ---- 审查组（和讨论第 2 轮同时跑） ----
const REV = '20261018-220450-revw';
write(path.join(root, 'plans', `${REV}.json`), { module: 'review', cell: 'complex', group: 'roles-review-1018', plan_id: REV, created_at: iso('2026-10-18T14:04:50Z'), claude_session: SESSION, cwd: CWD,
  host: { seat: 0, role: null }, seat_target: 3, why: '改动涉及路由和测试，按 3 级审查',
  seats: [{ seat: 1, agent: 'gpt-6-astra-codex-cli', model: 'gpt-6-astra', role: null, required: true }, { seat: 2, agent: 'gemini-4-argon-contributor', model: 'opencode-go/gemini-4-argon-contributor', role: null, required: false }, { seat: 3, agent: 'glm-5.3-flash', model: 'opencode-go/glm-5.3-flash', role: null, required: false }] });
const host = { id: '20261018-220500-rhst', mode: 'submit', kind: 'review', module: 'review', status: 'done', participant: 'host', agent: 'claude-code', agent_type: 'host', model: 'claude-opus-5-5',
  plan: REV, seat: 0, role: null, round: 1, parent: null, group: 'roles-review-1018', cwd: CWD, level: 'complex', cell: 'complex', claude_session: SESSION,
  started_at: iso('2026-10-18T14:05:00Z'), ended_at: iso('2026-10-18T14:05:00Z'), submitted_at: iso('2026-10-18T14:05:00Z') };
write(path.join(root, host.id, 'meta.json'), host);
write(path.join(root, host.id, 'result.json'), { ...host, report: { verdict: 'changes_requested', findings: [{ severity: 'medium', location: 'src/roles/router.py', issue: '未知来源没有记日志' }] } });
const review = (id, seat, model, agent, agentType, start, end, findings) => run(id, { mode: 'review', kind: 'review', module: 'review', agent, agent_type: agentType, model, level: 'complex', effort: 'high',
  title: '审角色路由改动', group: 'roles-review-1018', plan: REV, seat, started_at: iso(start), ended_at: iso(end) }, [
  [4, 'msg', '先看 diff，再对照讨论结论检查机制分类。'], [9, 'cmd', 'git diff --stat'], [20, 'cmd', 'Get-Content src/roles/router.py'],
  [55, 'think', '未知来源的兜底分支是否会吞掉错误'], [90, 'cmd', 'python -m pytest tests/roles -q'], [150, 'msg', `找到 ${findings.length} 个问题。`],
], { inTok: 150000 + seat * 30000, outTok: 3000 + seat * 900, extra: { report: { verdict: findings.length ? 'changes_requested' : 'approve', findings } } });
review('20261018-220510-rev1', 1, 'gpt-6-astra', 'gpt-6-astra-codex-cli', 'codex cli', '2026-10-18T14:05:10Z', '2026-10-18T14:08:40Z',
  [{ severity: 'high', location: 'src/roles/router.py:42', issue: '未知来源直接归到行为类，结论会被带偏' }, { severity: 'low', location: 'tests/roles/test_router.py', issue: '缺少空输入的用例' }]);
review('20261018-220514-rev2', 2, 'opencode-go/gemini-4-argon-contributor', 'gemini-4-argon-contributor', 'opencode cli', '2026-10-18T14:05:14Z', '2026-10-18T14:10:20Z',
  [{ severity: 'medium', location: 'src/roles/mechanisms.py', issue: '风险补偿和制度类的边界没写清' }]);
review('20261018-220518-rev3', 3, 'opencode-go/glm-5.3-flash', 'glm-5.3-flash', 'opencode cli', '2026-10-18T14:05:18Z', '2026-10-18T14:07:30Z', []);
console.log('multi-group sample written to', root);
