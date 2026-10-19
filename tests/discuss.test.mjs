import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, output, failed, poll, json, read, write, baseConfig, apiAgent, opencodeAgent, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;

function configure(h, agents) {
  const c = baseConfig(); Object.assign(c.agents, agents);
  c.modules.discuss.complex = Object.keys(c.agents).map((agent) => ({ agent, effort: 'high' }));
  h.config(c);
}
const discussArgs = (h, agent, extra = []) => taskArgs(h, 'discuss', ['--agent', agent, ...extra]);

test('Codex 讨论解析报告并传递只读规则和附件范围', async (t) => {
  const h = sandbox(t), s = h.scenario({ last_message: discussion });
  h.write('source.txt', 'first\nsecond\n');
  const r = output(await h.bridge(discussArgs(h, 'codex', ['--file', 'source.txt:2-2', '--no-snapshot']), { env: s.env }));
  assert.deepEqual(r.report, discussion);
  assert.equal(r.kind, 'discuss');
  assert.equal(r.round, 1);
  const call = s.calls()[0];
  assert.ok(call.args[call.args.indexOf('--output-schema') + 1].endsWith('discuss.schema.json'));
  assert.ok(call.stdin.includes('source.txt（第 2–2 行）'));
  assert.ok(call.stdin.includes(M.discussFooter(h.cwd)));
});

test('API 讨论发送附件行范围和项目清单，保存流式事件与用量', async (t) => {
  const h = sandbox(t), api = await apiServer(t);
  configure(h, { api: apiAgent(api.url) });
  h.initGit();
  h.write('source.txt', 'first\nsecond\nthird\n');
  const r = output(await h.bridge(discussArgs(h, 'api', ['--file', 'source.txt:2-3'])));
  assert.deepEqual(r.report, discussion);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.usage, { input_tokens: 100, cached_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 });
  assert.equal(r.usage_scope, 'this_run');
  assert.equal(r.changes.note, M.apiNoChanges);
  assert.deepEqual(r.files, [{ path: path.join(h.cwd, 'source.txt'), range: [2, 3], chars: 16 }]);
  const request = api.requests[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/chat/completions');
  assert.equal(request.body.model, 'fake-api');
  assert.equal(request.body.reasoning_effort, 'high');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  const prompt = request.body.messages[1].content;
  assert.ok(prompt.includes('git ls-files'));
  assert.ok(prompt.includes('source.txt'));
  assert.ok(prompt.includes('2\tsecond\n3\tthird'));
  assert.ok(!prompt.includes('1\tfirst'));
  assert.ok(!prompt.includes(h.home));
  const events = h.events(r.run_id);
  assert.deepEqual(events.map((e) => e.type), ['api.request', 'api.reasoning', 'api.content', 'api.usage', 'api.done']);
  assert.equal(events[1].text, '合成思考');
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
  assert.equal(json(path.join(r.run_dir, 'messages.json')).at(-1).content, JSON.stringify(discussion));
});

test('API 附件超过材料上限时拒绝请求', async (t) => {
  const h = sandbox(t), api = await apiServer(t);
  configure(h, { api: apiAgent(api.url) });
  h.write('large.txt', 'x'.repeat(300001));
  const r = await h.bridge(discussArgs(h, 'api', ['--file', 'large.txt']));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /超过上限 300000/);
  assert.match(r.stderr, /large.txt: 300003/);
  assert.equal(api.requests.length, 0);
  assert.equal(h.records().length, 0);
});

test('API 拒绝 response_format 后去掉该字段重试', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ reject_format: true }, {}]);
  configure(h, { api: apiAgent(api.url) });
  const r = output(await h.bridge(discussArgs(h, 'api')));
  assert.equal(api.requests.length, 2);
  assert.ok(api.requests[0].body.response_format);
  assert.equal(api.requests[1].body.response_format, undefined);
  assert.deepEqual(r.report, discussion);
  assert.ok(r.notes.includes(M.apiNoResponseFormat));
  assert.ok(h.events(r.run_id).some((e) => e.type === 'api.retry' && e.reason === 'response_format' && e.wait_s === 0));
});

test('API 非 JSON 报告只修复一次并累计两次用量', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: '合成的非 JSON 回答' }, {}]);
  configure(h, { api: apiAgent(api.url) });
  const r = output(await h.bridge(discussArgs(h, 'api')));
  assert.equal(api.requests.length, 2);
  assert.deepEqual(r.report, discussion);
  const messages = api.requests[1].body.messages;
  assert.equal(messages.at(-2).content, '合成的非 JSON 回答');
  assert.equal(messages.at(-1).content, M.reportRepairPrompt('Reply is not valid JSON'));
  assert.equal(h.events(r.run_id).filter((e) => e.type === 'api.repair').length, 1);
  assert.equal(r.usage.input_tokens, 200);
  assert.equal(r.usage.output_tokens, 80);
  assert.equal(json(path.join(r.run_dir, 'messages.json')).length, 3);
});

test('API 第二次报告仍不合法时保留原文并停止修复', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: 'bad' }]);
  configure(h, { api: apiAgent(api.url) });
  const r = output(await h.bridge(discussArgs(h, 'api')));
  assert.equal(api.requests.length, 2);
  assert.equal(r.report, null);
  assert.equal(r.last_message, 'bad');
  assert.equal(r.status, 'done');
  assert.deepEqual(r.warnings, [M.reportInvalid('api', path.join(r.run_dir, 'last-message.txt'))]);
});

for (const [status, resultStatus, message] of [[401, 'failed', 'synthetic unauthorized'], [402, 'quota_exhausted', 'synthetic balance']]) {
  test(`API ${status} 保存正确状态和提示`, async (t) => {
    const h = sandbox(t), api = await apiServer(t, [{ status, message }]);
    configure(h, { api: apiAgent(api.url) });
    const r = output(await h.bridge(discussArgs(h, 'api')), 1);
    assert.equal(r.status, resultStatus);
    assert.equal(api.requests.length, 1);
    assert.deepEqual(r.errors, [status === 402 ? M.apiBalance('api', message) : M.apiError('api', 'auth', 401, message)]);
    assert.ok(h.events(r.run_id).some((e) => e.type === 'api.error' && e.status === status));
  });
}

test('API 保活注释产生排队事件，放行后继续回答', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ queued: true, gate: 'queue' }]);
  configure(h, { api: apiAgent(api.url) });
  const running = h.startBridge(discussArgs(h, 'api'));
  const meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'api.queued'), '收到排队事件');
  assert.equal(output(await h.bridge(['status', '--run', meta.id])).activity.step, M.stepApiQueued);
  api.release('queue');
  const r = output(await running.done);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, discussion);
});

test('API 取消正在排队的请求并保存取消结果', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ queued: true, gate: 'cancel' }]);
  configure(h, { api: apiAgent(api.url) });
  const running = h.startBridge(discussArgs(h, 'api'));
  const meta = await h.running();
  await poll(() => h.events(meta.id).some((e) => e.type === 'api.queued'), '请求排队');
  assert.equal(output(await h.bridge(['cancel', '--run', meta.id])).status, 'cancelled');
  const r = output(await running.done, 1);
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(r.errors, [M.runCancelled('fake-api')]);
  assert.equal(api.requests.length, 1);
});

test('API 回答中途断开后重试一次且不拼接残缺回答', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: '{"position":"half', disconnect: true }, {}]);
  configure(h, { api: apiAgent(api.url) });
  const r = output(await h.bridge(discussArgs(h, 'api')));
  assert.equal(api.requests.length, 2);
  assert.deepEqual(r.report, discussion);
  assert.ok(h.events(r.run_id).some((e) => e.type === 'api.retry' && e.reason === 'network' && e.wait_s === 5));
  assert.equal(read(path.join(r.run_dir, 'last-message.txt')), JSON.stringify(discussion));
});

test('opencode 注入只读代理、设置 PWD 并翻译工具事件和导出用量', async (t) => {
  const h = sandbox(t);
  configure(h, { oc: opencodeAgent() });
  const s = h.scenario({ steps: [
    { event: { type: 'reasoning', part: { text: '合成推理' } } },
    { event: { type: 'tool_use', part: { tool: 'read', state: { status: 'completed', input: { filePath: path.join(h.cwd, 'src/file.mjs') }, output: 'synthetic source' } } } },
  ], export_messages: [
    { type: 'assistant', created: 'old', tokens: { input: 9000, output: 9000 }, cost: 99 },
    { type: 'user', tokens: { input: 8000 }, cost: 88 },
    { type: 'assistant', tokens: { input: 100, output: 40, reasoning: 10, cache: { read: 20, write: 5 } }, cost: 0.125 },
    { type: 'assistant', tokens: { input: 30, output: 10, cache: { read: 2 } }, cost: 0.25 },
  ] });
  const r = output(await h.bridge(discussArgs(h, 'oc', ['--title', '合成讨论']), { env: { ...s.env, PWD: path.join(h.home, 'wrong'), OPENCODE_CONFIG_CONTENT: JSON.stringify({ theme: 'synthetic', agent: { existing: { mode: 'subagent' } } }) } }));
  assert.deepEqual(r.report, discussion);
  const call = s.calls()[0], config = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(call.cwd, h.cwd);
  assert.equal(call.env.PWD, h.cwd);
  assert.equal(config.theme, 'synthetic');
  assert.deepEqual(config.agent.existing, { mode: 'subagent' });
  assert.deepEqual(config.agent['foreman-discuss'], { mode: 'primary', description: 'Read-only code discussion for foreman', permission: { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' } });
  assert.deepEqual(call.args, ['run', '--standalone', '--format', 'json', '--agent', 'foreman-discuss', '-m', 'fake/model#high', '--title', '合成讨论']);
  assert.ok(call.stdin.includes('不能运行命令'));
  assert.ok(call.stdin.includes(h.cwd));
  assert.deepEqual(s.calls()[1].args, ['session', 'export', '--standalone', 'synthetic-opencode-session']);
  assert.deepEqual(r.usage, { input_tokens: 157, cached_input_tokens: 22, output_tokens: 50, reasoning_output_tokens: 10 });
  assert.equal(r.cost_usd, 0.375);
  assert.equal(r.commands_executed, 0);
  const events = h.events(r.run_id);
  assert.deepEqual(events.map((e) => e.type), ['thread.started', 'item.completed', 'item.completed', 'item.completed']);
  assert.deepEqual(events[2].item, { id: 'opencode-1', tool: 'read', category: 'read', type: 'command_execution', command: 'read src/file.mjs', exit_code: 0, aggregated_output: 'synthetic source' });
  assert.ok(!read(path.join(r.run_dir, 'opencode.jsonl')).includes('step_finish'));
  assert.equal(r.changes.note, M.opencodeNoChanges);
});

test('opencode 修复报告时续接同一会话且仍使用只读权限', async (t) => {
  const h = sandbox(t);
  configure(h, { oc: opencodeAgent() });
  const s = h.scenario({ calls: [{ last_message: 'not json' }, { last_message: discussion }] });
  const r = output(await h.bridge(discussArgs(h, 'oc'), { env: s.env }));
  const calls = s.calls().filter((c) => c.operation === 'run');
  assert.equal(calls.length, 2);
  assert.deepEqual(r.report, discussion);
  assert.ok(!calls[0].args.includes('--session'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--session') + 1], r.session_id);
  assert.equal(calls[1].stdin, M.reportRepairPrompt('Reply is not valid JSON'));
  assert.equal(calls[1].env.OPENCODE_CONFIG_CONTENT, calls[0].env.OPENCODE_CONFIG_CONTENT);
});

test('opencode 会话导出失败时保留报告并提示缺少用量', async (t) => {
  const h = sandbox(t);
  configure(h, { oc: opencodeAgent() });
  const s = h.scenario({ export_error: 'synthetic export failed' });
  const r = output(await h.bridge(discussArgs(h, 'oc'), { env: s.env }));
  assert.deepEqual(r.report, discussion);
  assert.equal(r.usage, null);
  assert.equal(r.cost_usd, null);
  assert.ok(r.notes[0].includes('synthetic export failed'));
  assert.ok(r.notes[0].includes('没有 token 统计'));
});

test('同组多方并发，await-busy 列出超过阈值的 API 参与方', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ queued: true, gate: 'busy' }]);
  configure(h, { api: apiAgent(api.url), oc: opencodeAgent() });
  const gate = path.join(h.home, 'release-tools');
  const s = h.scenario({ steps: [{ wait_for: gate }], last_message: discussion });
  const handles = ['codex', 'api', 'oc'].map((name) => h.startBridge(discussArgs(h, name, ['--group', 'discussion-group', '--no-snapshot']), { env: s.env }));
  await poll(() => h.records().filter((m) => m.status === 'running').length === 3, '同组所有参与方登记');
  const apiMeta = await h.running((m) => m.agent === 'api');
  await poll(() => h.events(apiMeta.id).some((e) => e.type === 'api.queued'), 'API 参与方排队');
  const busy = output(await h.bridge(['await-busy', '--group', 'discussion-group', '--after', '0.001']));
  assert.equal(busy.done, false);
  assert.equal(busy.busy.length, 1);
  assert.equal(busy.busy[0].run_id, apiMeta.id);
  assert.equal(busy.busy[0].agent, 'api');
  assert.equal(busy.busy[0].model, 'fake-api');
  assert.ok(busy.running.includes(apiMeta.id));
  write(gate, 'release');
  api.release('busy');
  const settled = await Promise.all(handles.map((p) => p.done));
  for (const r of settled) assert.equal(output(r).group, 'discussion-group');
  const finished = output(await h.bridge(['await-busy', '--group', 'discussion-group', '--after', '0.001']));
  assert.deepEqual(finished, { busy: [], running: [], done: true });
});
