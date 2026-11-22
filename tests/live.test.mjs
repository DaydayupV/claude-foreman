import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { baseConfig, BRIDGE, ROOT, json, lines, poll, read, sandbox } from './helpers.mjs';

const brief = '  第一轮说明\n保留原文。\n';
const agentMessage = (text) => ({ type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
const ok = (r) => { assert.equal(r.code, 0, r.stderr); return r.stdout; };

async function printed(proc, pattern) {
  return poll(() => {
    const match = proc.stdout.match(pattern);
    if (!match && proc.child.exitCode !== null) assert.fail(`子进程已退出：${proc.stdout}\n${proc.stderr}`);
    return match;
  }, String(pattern));
}

async function start(h, turns, options = []) {
  const fake = h.scenario({ turns });
  const proc = h.startBridge(['live', 'start', '--level', 'complex', '--cwd', h.cwd, '--title', '实时测试',
    '--brief', h.write('brief.md', brief), ...options], { env: fake.env, timeout: 45000 });
  const [, id] = await printed(proc, /live events --run (live-\d{8}-\d{6}-[0-9a-f]{4})\r?\n/);
  const dir = path.join(h.home, '.claude', 'foreman', 'live', id);
  const cmd = (action, ...args) => h.bridge(['live', action, '--run', id, ...args]);
  return { proc, dir, id, cmd,
    events: (args = [], env = {}) => h.startBridge(['live', 'events', '--run', id, ...args], { env, timeout: 45000 }),
    requests: (method) => fake.calls().filter((c) => c.msg?.method === method),
    response: (rpcId) => fake.calls().find((c) => c.msg?.id === rpcId && Object.hasOwn(c.msg, 'result'))?.msg.result,
    log: () => lines(path.join(dir, 'live.jsonl')),
    async close() { ok(await cmd('close')); ok(await proc.done); },
  };
}

test('ask_foreman 通过 events 提问，回答回到原请求后完成这一轮', async (t) => {
  const h = sandbox(t), cfg = baseConfig();
  cfg.agents.codex.sandbox = { run: 'workspace-write' };
  cfg.modules.default.run.complex[0] = { agent: 'codex', model: 'cell-model', effort: 'high' };
  h.config(cfg);
  const ask = { question: '选哪个版本？', options: ['A', 'B'] }, final = '第一行\n' + '界'.repeat(205);
  const s = await start(h, [{ ask, items: [agentMessage('早先的消息'), agentMessage(final)] }], ['--agent', 'codex']);
  assert.deepEqual(s.proc.stdout.trimEnd().split(/\r?\n/), [
    `live started · cell-model high · Codex app-server · complex · run dir ${s.dir}`,
    `foreman: live events: node "${BRIDGE}" live events --run ${s.id}`,
  ]);
  const stream = s.events();
  await printed(stream, /#\d+ 提问 call=call-1：选哪个版本？（选项：A \/ B）\n/);
  assert.equal(s.response('server-request-1'), undefined);
  assert.equal(s.log().some((e) => e.type === 'turn_done'), false);
  const meta = JSON.parse(ok(await s.cmd('status')));
  assert.deepEqual(meta.pending_calls, ['call-1']);
  assert.equal(meta.current_turn, 'turn-1');
  assert.equal(meta.state, 'running');
  assert.equal(meta.last_seq, s.log().at(-1).seq);
  const init = s.requests('initialize')[0].msg.params;
  assert.deepEqual(init.clientInfo, { name: 'foreman', title: 'foreman live', version: json(path.join(ROOT, 'foreman/.claude-plugin/plugin.json')).version });
  assert.equal(init.capabilities.experimentalApi, true);
  const raw = lines(path.join(s.dir, 'app-server.jsonl'));
  assert.deepEqual(raw.filter((r) => r.dir === 'out').map((r) => r.msg.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.ok(raw.some((r) => r.dir === 'in' && r.msg.method === 'item/tool/call' && r.msg.id === 'server-request-1'));
  const params = s.requests('thread/start')[0].msg.params;
  assert.equal(params.cwd, h.cwd);
  assert.equal(params.model, 'cell-model');
  assert.deepEqual(params.config, { model_reasoning_effort: 'high' });
  assert.equal(params.sandbox, 'workspace-write');
  assert.equal(params.approvalPolicy, 'never');
  const [tool] = params.dynamicTools;
  assert.equal(tool.type, 'function');
  assert.equal(tool.name, 'ask_foreman');
  assert.deepEqual(tool.inputSchema.required, ['question']);
  assert.deepEqual(tool.inputSchema.properties.options.items, { type: 'string' });
  assert.deepEqual(s.requests('turn/start')[0].msg.params.input, [{ type: 'text', text: brief, text_elements: [] }]);
  assert.equal(read(path.join(s.dir, 'brief.md')), brief);
  assert.equal(ok(await s.cmd('answer', '--call', 'call-1', '--text', '选择 B')).trim(), '已把回答交给协作方');
  await printed(stream, /一轮结束 turn=turn-1 状态=completed：/);
  assert.deepEqual(s.response('server-request-1'), { contentItems: [{ type: 'inputText', text: '选择 B' }], success: true });
  const done = s.log().find((e) => e.type === 'turn_done');
  assert.equal(done.summary, final.slice(0, 200));
  assert.equal(read(done.file), final);
  assert.deepEqual(s.log().filter((e) => e.type === 'answered').map((e) => e.by), ['foreman']);
  await s.close();
  ok(await stream.done);
});

test('steer 带当前 turnId 和补充文字，轮次结束后拒绝插话', async (t) => {
  const s = await start(sandbox(t), [{ until_steer: true }]);
  assert.equal(ok(await s.cmd('steer', '--text', '也要保留原文')).trim(), '已插话');
  assert.deepEqual(s.requests('turn/steer')[0].msg.params, {
    threadId: 'thread-live', expectedTurnId: 'turn-1', input: [{ type: 'text', text: '也要保留原文', text_elements: [] }],
  });
  await poll(() => s.log().some((e) => e.type === 'turn_done'), '插话后完成');
  const r = await s.cmd('steer', '--text', '太晚了');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /现在没有进行中的一轮；要开新一轮用 live send/);
  assert.equal(s.requests('turn/steer').length, 1);
  await s.close();
});

test('send 在同一个 app-server 进程和 thread 上开第二轮', async (t) => {
  const h = sandbox(t), s = await start(h, [{ items: [agentMessage('首轮')] }, { items: [agentMessage('次轮')] }]);
  await poll(() => s.log().some((e) => e.type === 'turn_done'), '首轮完成');
  const second = '接着做。\n';
  assert.equal(ok(await s.cmd('send', '--brief', h.write('next.md', second))).trim(), '已开始新一轮 turn=turn-2');
  const calls = s.requests('turn/start');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pid, calls[1].pid);
  assert.equal(calls[0].pid, json(path.join(s.dir, 'meta.json')).app_server_pid);
  assert.deepEqual(calls.map((c) => c.msg.params.threadId), ['thread-live', 'thread-live']);
  assert.equal(calls[1].msg.params.input[0].text, second);
  await poll(() => s.log().filter((e) => e.type === 'turn_done').length === 2, '次轮完成');
  assert.equal(read(path.join(s.dir, 'last-message-turn-1.md')), '首轮');
  assert.equal(read(path.join(s.dir, 'last-message-turn-2.md')), '次轮');
  await s.close();
});

test('interrupt 打断进行中的一轮并推送 interrupted', async (t) => {
  const s = await start(sandbox(t), [{ hold: true }]), stream = s.events();
  assert.equal(ok(await s.cmd('interrupt')).trim(), '已请求打断');
  await printed(stream, /一轮结束 turn=turn-1 状态=interrupted/);
  assert.deepEqual(s.requests('turn/interrupt')[0].msg.params, { threadId: 'thread-live', turnId: 'turn-1' });
  await s.close();
  ok(await stream.done);
});

test('close 先打断再结束子进程和订阅，关闭后不再接受回答', async (t) => {
  const s = await start(sandbox(t), [{ hold: true }]);
  const stream = s.events(['--all'], { FOREMAN_LANG: 'en' });
  await printed(stream, /turn started turn=turn-1/);
  const pid = s.requests('turn/start')[0].pid;
  assert.equal(ok(await s.cmd('close')).trim(), '正在关闭');
  ok(await s.proc.done);
  assert.match(ok(await stream.done), /turn done turn=turn-1 status=interrupted:.*\n#\d+ closed: close\n$/);
  assert.equal(s.requests('turn/interrupt').length, 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const r = await s.cmd('answer', '--call', 'call-1', '--text', '已晚');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /已经结束，不能再发消息/);
});

test('app-server 中途崩溃，error 带退出码和 stderr 尾部，closed 标明原因', async (t) => {
  const h = sandbox(t), gate = path.join(h.cwd, 'crash');
  const s = await start(h, [{ wait_for: gate, crash: 17, stderr: 'before\nsynthetic crash\n' }]);
  const stream = s.events();
  h.write('crash', '');
  assert.equal((await s.proc.done).code, 1);
  const output = ok(await stream.done);
  assert.match(output, /#\d+ 出错：.*17.*synthetic crash/);
  assert.match(output, /#\d+ 已关闭：app_server_exit\n$/);
  assert.deepEqual(s.log().slice(-2).map((e) => e.type), ['error', 'closed']);
  assert.equal(read(path.join(s.dir, 'stderr.log')), 'before\nsynthetic crash\n');
});

test('events 默认只推需要主控处理的行，--all 补全，--after 按原序号续读', async (t) => {
  const h = sandbox(t), gate = path.join(h.cwd, 'items');
  const s = await start(h, [{ wait_for: gate, items: [agentMessage('第一行\n第二行'),
    { type: 'commandExecution', command: 'git status', exitCode: 0 }] }]);
  const stream = s.events(), all = s.events(['--all']);
  await printed(all, /本轮开始 turn=turn-1/);
  h.write('items', '');
  await printed(stream, /一轮结束/);
  await printed(all, /命令：git status（退出码 0）/);
  await s.close();
  const filtered = ok(await stream.done), full = ok(await all.done);
  assert.doesNotMatch(filtered, /消息：|命令：|本轮开始/);
  assert.match(full, /#3 消息：第一行 ⏎ 第二行\n#4 命令：/);
  const log = s.log();
  assert.deepEqual(log.map((e) => e.seq), log.map((_, i) => i + 1));
  assert.equal(full.trimEnd().split('\n').length, log.length);
  assert.equal(ok(await s.cmd('events', '--all', '--after', '3')), full.split('\n').slice(3).join('\n'));
  assert.equal(ok(await s.cmd('events', '--after', String(log.at(-1).seq))), '');
});

test('提问超时发送指定默认答复并推送带超时标记的 answered', async (t) => {
  const s = await start(sandbox(t), [{ ask: { question: '需要决定' }, items: [agentMessage('按假设继续了')] }],
    ['--answer-timeout-min', '0.02']);
  const stream = s.events(['--all']);
  await printed(stream, /已回答 call=call-1（超时，替主控回了默认答复）/);
  await printed(stream, /一轮结束 .*状态=completed/);
  assert.deepEqual(s.response('server-request-1'), { contentItems: [{ type: 'inputText',
    text: '主控暂时没有回答。按你最稳妥的理解继续，并在最后的回复里写明你做了哪些假设。' }], success: true });
  assert.equal(s.log().find((e) => e.type === 'answered').by, 'timeout');
  await s.close();
  ok(await stream.done);
});
