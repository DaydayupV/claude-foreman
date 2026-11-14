import { D as displayText, commandAction } from '../foreman/skills/dispatch/scripts/display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { plannedSandbox as sandbox, seedRun, baseConfig, codebuddyAgent, taskArgs, output, failed, ROOT, MESSAGES } from './helpers.mjs';
import { report, discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const D = { ...MESSAGES.en, ...displayText }; // 显示文字中英两个插件一样，用英文那一套
const SCRIPTS = path.join(ROOT, 'foreman/skills/dispatch/scripts');

const configure = (h, extra = {}, change = () => {}) => {
  const c = baseConfig();
  c.agents.cb = { ...codebuddyAgent(), ...extra };
  change(c);
  h.config(c);
  return c;
};
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
const argsOf = (call, flag) => { const i = call.args.indexOf(flag); return i < 0 ? null : call.args[i + 1] ?? null; };
let ids = 0;
const tool = (name, input, { result = 'synthetic output', isError = false, files } = {}) => {
  const call = { type: 'tool_use', id: `tool-${++ids}`, name, input };
  if (isError) call.is_error = true;
  return { call, step: files ? { files } : undefined, result };
};

test('配置：codebuddy cli 的模型写法、run_access 和执行授权', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  // 没写 run_access 时只有讨论和审查：和执行前排人的检查保持一致
  const cfg = output(await h.bridge(['config']));
  assert.equal(cfg.effective.agents.cb.type, 'codebuddy cli');
  assert.equal(cfg.effective.agents.cb.model, 'fake-1');
  assert.deepEqual(cfg.agents_status.cb.capabilities, { modes: ['review', 'discuss'], isolation: 'tools', reads_code: true, reads_images: false,
    native_schema: true, native_review: false, images: false, resume: true, command_start_events: false });
  // 写了 run_access 才能进执行格子
  configure(h, { run_access: 'edit' }, (c) => { c.modules.default.run.complex = [{ agent: 'cb' }]; });
  const withAccess = output(await h.bridge(['config']));
  assert.deepEqual(withAccess.agents_status.cb.capabilities.modes, ['run', 'review', 'discuss']);
  assert.equal(withAccess.agents_status.cb.run_access, 'edit');
  // 没写 run_access 却放进执行格子：派发时按 M.runAccessRequired 拒绝
  configure(h, {}, (c) => { c.modules.default.run.complex = [{ agent: 'cb' }]; });
  failed(await h.bridge(taskArgs(h), { input: '任务' }), M.runAccessRequired('cb', 'codebuddy cli'));
});

test('讨论：只读工具白名单、MCP 隔离、事件翻译、用量和费用', async (t) => {
  const h = sandbox(t);
  configure(h, { effort: 'high' }, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb', effort: 'high' }]; });
  // 两个工具调用各带一条 assistant（每条 10/3/5），最后一条 result 收结构化报告。
  const s = h.scenario({ tool_calls: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.txt' } },
    { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'x' } }] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }));
  const call = runs(s)[0];
  assert.equal(argsOf(call, '--tools'), 'Read,Glob,Grep,StructuredOutput');
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(argsOf(call, '--setting-sources'), 'user');
  assert.equal(argsOf(call, '--permission-mode'), 'dontAsk');
  assert.ok(!call.args.includes('-y'));
  assert.equal(argsOf(call, '--effort'), 'high');
  assert.equal(argsOf(call, '--output-format'), 'stream-json');
  assert.ok(argsOf(call, '--json-schema').includes('"position"'));
  assert.ok(call.stdin.includes('## 讨论规则'));
  assert.equal(r.status, 'done');
  assert.equal(r.readonly, 'tools');
  assert.equal(r.changes.available, false);
  assert.equal(r.changes.note, M.codebuddyNoChanges);
  // result.usage is the per-call total; assistant fragments are only a fallback.
  assert.deepEqual(r.usage, { input_tokens: 30, cached_input_tokens: 9, output_tokens: 15, reasoning_output_tokens: 0 });
  assert.equal(r.cost_usd, null);
  assert.equal(r.cost_source, 'unknown');
  const events = h.events(r.run_id);
  assert.ok(events.some((e) => e.type === 'thread.started' && e.thread_id === 'synthetic-codebuddy-session'));
  assert.ok(events.some((e) => e.type === 'item.completed' && e.item.type === 'agent_message'));
  // 工具调用翻译成读文件的命令行（看板和时间线共用）
  assert.ok(events.some((e) => e.type === 'item.completed' && e.item.category === 'read'));
  assert.ok(events.some((e) => e.type === 'item.completed' && e.item.category === 'search'));
  // The assistant fragments still expose the intermediate steps.
  const steps = events.filter((e) => e.type === 'step.usage');
  assert.equal(steps.length, 3);
  assert.equal(steps.at(-1).final, true);
  assert.equal(steps[0].final, undefined);
});

test('讨论：重复 stage id 只保留最新快照', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ result_usage: null, usage_updates: [
    { type: 'system', _meta: { 'codebuddy.ai/turnUsage': { kind: 'stage', stage: { id: 'stage-1', usage: { input_tokens: 4, output_tokens: 2 } } } } },
    { type: 'system', _meta: { 'codebuddy.ai/turnUsage': { kind: 'stage', stage: { id: 'stage-1', usage: { input_tokens: 7, output_tokens: 3 } } } } },
    { type: 'system', _meta: { 'codebuddy.ai/turnUsage': { kind: 'stage', stage: { id: 'stage-2', usage: { input_tokens: 5, output_tokens: 1 } } } } },
  ] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }));
  assert.deepEqual(r.usage, { input_tokens: 12, cached_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 0 });
});

test('讨论：没有最终用量快照时按 assistant message id 去重', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ assistant_id: 'same-message', result_usage: null, tool_calls: [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.txt' } },
    { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: 'b.txt' } },
  ] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }));
  assert.deepEqual(r.usage, { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 0 });
});

test('审查：补丁材料、只读工具，审查不能续接', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.review.normal = { agent: 'cb' }; });
  h.initGit(); h.write('source.txt', 'after\n');
  // 没拿到结构化输出（模型只写了文字）时，报告为 null，原样放进 last_message
  const s = h.scenario({ last_message: '未发现问题。', no_structured: true });
  const r = output(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-'], { env: s.env, input: '重点检查' }));
  const call = runs(s)[0];
  assert.equal(argsOf(call, '--tools'), 'Read,Glob,Grep,StructuredOutput');
  assert.ok(call.stdin.startsWith(M.opencodeReviewPrompt(h.cwd, M.reviewScopeUncommitted)));
  assert.ok(call.stdin.includes('+after'));
  assert.ok(call.stdin.includes(M.reviewKinds.diff));
  assert.equal(r.report, null);
  assert.equal(r.last_message, '未发现问题。');
  failed(await h.bridge(['resume', '--run', r.run_id, '--level', 'normal', '--brief', '-']), M.reviewNoResume);
});

test('审查：结构化输出收下报告，findings 为空也是合法结果', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.review.normal = { agent: 'cb' }; });
  h.initGit(); h.write('source.txt', 'after\n');
  const s = h.scenario({ structured: { verdict: 'issues_found', coverage: { checked: ['source.txt'], not_checked: [] }, unverified: [],
    findings: [{ id: 'F1', location: 'source.txt:1', issue: '问题', trigger: '任何时候', severity: 'high', evidence: '证据', suggestion: '改' }] } });
  const r = output(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-'], { env: s.env, input: '重点检查' }));
  assert.equal(r.report.verdict, 'issues_found');
  assert.equal(r.report.findings.length, 1);
});

for (const access of ['edit', 'shell']) test(`执行（${access}）：工具白名单、改动归属、命令计数和 watch`, async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: access }, (c) => { c.modules.default.run.complex = { agent: 'cb' }; });
  h.initGit();
  const editTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'StructuredOutput'];
  const shellTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'PowerShell', 'StructuredOutput'];
  const calls = [
    { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'source.txt' } },
    { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(h.cwd, 'source.txt') } },
    { type: 'tool_use', id: 'w1', name: 'Write', input: { file_path: 'new.txt' } },
    ...(access === 'shell' ? [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } }] : []),
    { type: 'tool_use', id: 'g1', name: 'Grep', input: { pattern: 'export', path: h.cwd, glob: '*.js' } },
  ];
  const s = h.scenario({ tool_calls: calls, files: { 'source.txt': 'after\n', 'new.txt': 'new\n' }, structured: report });
  const execution = await h.bridge(taskArgs(h), { env: s.env, input: '合成执行任务' });
  const r = output(execution), call = runs(s)[0];
  assert.equal(call.args[call.args.indexOf('--tools') + 1], (access === 'shell' ? shellTools : editTools).join(','));
  if (access === 'edit') {
    assert.equal(argsOf(call, '--permission-mode'), 'acceptEdits');
    assert.equal(argsOf(call, '--allowedTools'), 'Write(./**),Edit(./**)');
    assert.ok(!call.args.includes('-y'));
  }
  if (access === 'shell') assert.ok(call.args.includes('-y'));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, report);
  assert.equal(r.isolation, 'tools');
  assert.equal(r.run_access, access);
  assert.ok(execution.stderr.includes(M.unsandboxedRun(access)));
  assert.equal(r.commands_executed, access === 'shell' ? 1 : 0);
  assert.deepEqual(r.changes.files.map((f) => [f.path, f.by]).sort(), [['new.txt', 'agent'], ['source.txt', 'agent']]);
  const actionIds = h.events(r.run_id).filter((e) => e.item?.category).map((e) => e.item.id);
  assert.equal(new Set(actionIds).size, actionIds.length);
  const watch = await h.bridge(['watch', '--run', r.run_id, '--verbose']);
  assert.equal(watch.code, 0);
  assert.ok(watch.stdout.includes(D.actionRead('source.txt')));
  // 执行命令在时间线上写成「▶ 命令」
  if (access === 'shell') {
    assert.ok(watch.stdout.includes('npm test'), watch.stdout);
    assert.equal(commandAction({ category: 'shell', command: 'npm test' }).text, '$ npm test');
  }
});

test('执行：失败的 Write 带调用 ID 和失败码，不获得改动归属', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, (c) => { c.modules.default.run.complex = { agent: 'cb' }; });
  h.initGit();
  const s = h.scenario({ tool_calls: [{ type: 'tool_use', id: 'write-failed', name: 'Write', input: { file_path: 'blocked.txt' } }],
    tool_results: [{ is_error: true, content: 'permission denied' }], structured: report });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '写文件' }));
  const item = h.events(r.run_id).find((e) => e.item?.id === 'write-failed');
  assert.equal(item.item.exit_code, 1);
  assert.deepEqual(item.item.changes, []);
  assert.ok(!r.changes.files.some((file) => file.path === 'blocked.txt' && file.by === 'agent'));
});

test('执行报告不合格时，同一会话、不给工具修复一次，用量累加', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, (c) => { c.modules.default.run.complex = { agent: 'cb' }; });
  const s = h.scenario({ calls: [{ last_message: 'not json', no_structured: true }, { structured: report }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '任务' }));
  assert.deepEqual(r.report, report);
  const [first, second] = runs(s);
  assert.equal(argsOf(first, '--tools'), 'Read,Glob,Grep,Write,Edit,StructuredOutput');
  assert.equal(argsOf(second, '--tools'), 'StructuredOutput');
  assert.equal(argsOf(second, '--resume'), 'synthetic-codebuddy-session');
  assert.equal(r.usage.output_tokens, 10);
});

test('出错、限流：codebuddy 以 0 退出也要按 result 的 is_error 判失败', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const discuss = (scenario) => h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: h.scenario(scenario).env, input: '议题' }).then((r) => ({ code: r.code, ...output(r, r.code) }));
  const limited = await discuss({ rate_limited: true, no_reply: true });
  assert.equal(limited.status, 'failed');
  assert.ok(limited.errors.some((e) => e.includes('429')));
  assert.ok(limited.notes.includes(M.rateLimited('fake-1', 'CodeBuddy CLI')));
  const apiError = await discuss({ no_reply: true, api_error: true, exit_code: 0 });
  assert.equal(apiError.status, 'failed');
  const unsigned = await discuss({ no_reply: true, exit_code: 1, stderr: 'synthetic: no API key\n' });
  assert.equal(unsigned.status, 'failed');
});

test('取消：运行中的 CodeBuddy 子进程会响应 cancel 标记', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ hold: true });
  const running = h.startBridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env });
  const meta = await h.running();
  const cancelled = await h.bridge(['cancel', '--run', meta.id]);
  assert.equal(output(cancelled, cancelled.code).status, 'cancelled');
  assert.equal(output(await running.done, 1).status, 'cancelled');
});

test('check：版本、清单、最小请求，推理强度按清单核对', async (t) => {
  const h = sandbox(t);
  configure(h, { effort: 'high' }, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb', effort: 'high' }]; });
  const s = h.scenario({ models: ['fake-1', 'fake-2'] });
  const r = await h.bridge(['check', '--agent', 'cb'], { env: s.env });
  const out = output(r, r.code);
  assert.equal(out.agents.cb.type, 'codebuddy cli');
  assert.equal(out.agents.cb.version, '2.180.0');
  assert.equal(out.agents.cb.model_listed, true);
  assert.equal(out.agents.cb.reply, 'OK');
  assert.deepEqual(out.agents.cb.efforts.map((e) => [e.variant, e.ok]), [['high', true]]);
  // 依次是 --version、--help、最小真实请求；最小请求只给只读工具
  const list = s.calls();
  assert.deepEqual(list.map((c) => c.operation), ['version', 'help', 'run']);
  const probe = list.at(-1);
  assert.ok(probe.args.includes('--no-session-persistence'));
  assert.equal(argsOf(probe, '--tools'), 'Read,Glob,Grep');
  // 配置里的模型不在清单里：报出最接近的写法，不通过
  configure(h, { model: 'fake-9' }, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const missing = output(await h.bridge(['check', '--agent', 'cb'], { env: h.scenario({ models: ['fake-1', 'fake-2'] }).env }), 1);
  assert.equal(missing.agents.cb.model_listed, false);
  assert.ok(missing.agents.cb.fix.includes('fake-9'));
  assert.ok(missing.agents.cb.fix.includes('fake-1'));
});

test('models 列出 codebuddy 的清单并核对配置', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.run.complex = 'claude code'; });
  const s = h.scenario({ models: ['fake-1', 'fake-2'] });
  const r = await h.bridge(['models'], { env: s.env });
  const out = output(r, r.code);
  assert.equal(out.tools['codebuddy cli'].ok, true);
  assert.deepEqual(out.tools['codebuddy cli'].models.map((m) => m.id), ['fake-1', 'fake-2']);
  assert.equal(out.agents.cb.listed, true);
  const md = await h.bridge(['models', '--format', 'md'], { env: s.env });
  assert.equal(md.code, 0, md.stderr);
  assert.ok(md.stdout.includes(M.reportCodebuddyTitle), md.stdout);
  assert.ok(md.stdout.includes('CodeBuddy 2'), md.stdout);
});

test('拦截钩子：拦下直接用 codebuddy 跑任务，放行查询和管理子命令', async (t) => {
  const h = sandbox(t);
  for (const command of ['codebuddy -p "review the diff"', 'cbc -p hi', 'codebuddy --model fake-1 hi', 'codebuddy --append-system-prompt "--help" -p hi', 'npx @tencent-ai/codebuddy-code -p hi',
    'node "$APPDATA/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" -p hi', 'codebuddy > out.txt -p hi'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 2, command);
  for (const command of ['codebuddy --version', 'codebuddy --help', 'cbc config set -g theme dark', 'codebuddy update', 'codebuddy mcp list', 'cbc model.mps -solve', 'echo codebuddy -p hi'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 0, command);
});

test('status 和看板认得 codebuddy 这个接入方式', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-cb', { agent: 'cb', agent_type: 'codebuddy cli', model: 'fake-1', effort: 'high', module: 'discuss', mode: 'discuss', kind: 'discuss', title: '合成讨论' },
    { status: 'done', duration_s: 12, report: discussion });
  const r = await h.bridge(['status']);
  assert.equal(r.code, 0, r.stderr);
  // 模型标签写「模型 强度 · 接入方式」，接入方式不是 Codex 的兜底
  assert.ok(r.stdout.includes('fake-1 high · CodeBuddy CLI'), r.stdout);
  assert.equal(D.channel.codebuddy, 'CodeBuddy CLI');
  // 排队检查把 codebuddy 当外部协作方，不按"能自己看 CLI 输出"的 Codex 处理
  const waiting = await h.bridge(['await-busy', '--run', '20000101-cb']);
  assert.equal(waiting.code, 0, waiting.stderr);
});
