import path from 'node:path';
import { seedRun, write, poll } from '../helpers.mjs';

// 一场还在进行的四方讨论：Codex 先说了一段话再跑了六条命令（有一条失败），opencode 只读文件和搜索，
// pi 说过一句话、后来又有两条思考摘要，API 正在思考。pid 用一个活着的进程（测试进程自己），任务就算在运行。
export function liveGroup(h, pid) {
  const group = 'live-group';
  const start = Date.now() - 60000;
  const at = (seconds) => new Date(start + seconds * 1000).toISOString();
  const done = (id, command, extra = {}) => ({ type: 'item.completed', ts: at(5), item: { id, type: 'command_execution', command, exit_code: 0, aggregated_output: '', ...extra } });
  const say = (text, seconds = 2) => ({ type: 'item.completed', ts: at(seconds), item: { type: 'agent_message', text } });
  const think = (text, seconds) => ({ type: 'item.completed', ts: at(seconds), item: { type: 'reasoning', text } });
  const tool = (id, name, category, command) => done(id, command, { tool: name, category });
  const plan = '20000101-000000-plan';
  const seats = [
    { id: '20000101-000001-aaaa', agent: 'gpt-6-astra-codex-cli', type: 'codex cli', model: 'gpt-6-astra', effort: 'max', events: [
      say('先看一下登记锁现在怎么加锁、怎么回收残留锁，再对照 Windows 上删除挂起时报 EPERM 的时机，判断重试应该放在哪一层。'),
      done('c1', 'rg -n "start.lock" foreman/skills/dispatch/scripts'), done('c2', 'git log --oneline -5'),
      done('c3', 'sed -n 50,110p foreman/skills/dispatch/scripts/records.mjs'),
      done('c4', 'node --test tests/admission.test.mjs', { exit_code: 1, aggregated_output: 'not ok 3 - 登记锁正被删除\n' }),
      done('c5', 'git diff --stat'), done('c6', 'rg -n retryBusy foreman/skills/dispatch/scripts')] },
    { id: '20000101-000002-bbbb', agent: 'deepseek-v4.1-flash', type: 'opencode cli', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', events: [
      tool('o1', 'read', 'read', 'read foreman/skills/dispatch/scripts/records.mjs'), tool('o2', 'grep', 'search', 'grep retryBusy foreman'),
      tool('o3', 'read', 'read', 'read foreman/skills/dispatch/scripts/util.mjs'), tool('o4', 'glob', 'search', 'glob **/*.lock'),
      tool('o5', 'read', 'read', 'read tests/admission.test.mjs')] },
    { id: '20000101-000003-cccc', agent: 'mimo-v2.6-pro-pi-cli', type: 'pi cli', model: 'xiaomi/mimo-v2.6-pro', effort: 'high', events: [
      say('我先读登记锁的代码，再看测试。'), think('**Checking the lock**\n\nThe lock file is created with flag wx.', 3),
      tool('p1', 'read', 'read', 'read foreman/skills/dispatch/scripts/records.mjs'), tool('p2', 'ls', 'search', 'ls tests'),
      think('删除挂起时 openSync 会报 EPERM，要确认重试的上限是多少。\n第二段不显示。', 6)] },
    { id: '20000101-000004-dddd', agent: 'kimi-k2.6-api', type: 'api', model: 'kimi-k2.6', effort: null, events: [
      { type: 'api.request', ts: at(1), attempt: 1, model: 'kimi-k2.6', effort: null },
      { type: 'api.reasoning', ts: at(4), text: '先确认登记锁的语义', total_chars: 3200 }] },
  ];
  seats.forEach((s, i) => seedRun(h, s.id, {
    mode: 'discuss', kind: 'discuss', title: '合成讨论：登记锁原地重试', agent: s.agent, agent_type: s.type, model: s.model, effort: s.effort,
    status: 'running', pid, group, plan, seat: i + 1, started_at: at(0), ended_at: undefined,
  }, null, s.events));
  write(path.join(h.runs, 'plans', `${plan}.json`), {
    plan_id: plan, module: 'discuss', cell: 'complex', group, cwd: h.cwd, claude_session: 'test-session', created_at: at(0),
    seats: seats.map((s, i) => ({ seat: i + 1, agent: s.agent, role: null, model: s.model, effort: s.effort, required: i === 0 })),
    required: [seats[0].agent],
  });
  return { group, seats, plan };
}

// 实时画面每帧逐行写成"\x1b[<行>;1H\x1b[2K<内容>"：取第一帧（第二帧开始画时第一帧已经写完），拆回每一行。
export async function frameOf(h, args, env) {
  const run = h.startBridge(args, { env });
  const frame = await poll(() => { const parts = run.stdout.split('\x1b[1;1H'); return parts.length > 2 ? parts[1] : null; }, '实时画面的第一帧');
  run.stop();
  await run.done;
  return `\x1b[1;1H${frame}`.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1).map((line) => line.replace(/\x1b\[\d+;1H\x1b\[J$/, ''));
}

// 运行中的计时会走，比对前换成 <CLOCK>
export const steadyClock = (lines) => lines.map((line) => line.replace(/(running|thinking|writing the answer|queued) \d+:\d{2}/g, '$1 <CLOCK>'));
