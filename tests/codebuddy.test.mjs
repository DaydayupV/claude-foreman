import { D as displayText, commandAction } from '../foreman/skills/dispatch/scripts/display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { boundedList, gitBashPath } from '../foreman/skills/dispatch/scripts/adapters/codebuddy-cli.mjs';
import { outsideLinks } from '../foreman/skills/dispatch/scripts/util.mjs';
import { toolDecision } from '../foreman/skills/dispatch/scripts/adapters/codebuddy-guard.mjs';
import { plannedSandbox as sandbox, seedRun, baseConfig, codebuddyAgent, taskArgs, output, failed, ROOT, MESSAGES } from './helpers.mjs';
import { report, discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const D = { ...MESSAGES.en, ...displayText }; // 显示文字中英两个插件一样，用英文那一套
const SCRIPTS = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const GUARD = path.join(SCRIPTS, 'adapters/codebuddy-guard.mjs');

const configure = (h, extra = {}, change = () => {}) => {
  const c = baseConfig();
  c.agents.cb = { ...codebuddyAgent(), ...extra };
  change(c);
  h.config(c);
  return c;
};
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
const argsOf = (call, flag) => { const i = call.args.indexOf(flag); return i < 0 ? null : call.args[i + 1] ?? null; };
const assertGuard = (call, access, cwd, runsDir) => {
  const quote = value => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  const command = [process.execPath, GUARD, access, cwd, runsDir].map(quote).join(' ');
  assert.deepEqual(JSON.parse(argsOf(call, '--settings')), { hooks: {
    PreToolUse: [{ matcher: 'Read|Glob|Grep|Write|Edit|WebFetch', hooks: [{ type: 'command', command }] }],
  } });
};
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
  assert.equal(argsOf(call, '--tools'), 'Read,Glob,Grep,WebFetch,WebSearch,StructuredOutput');
  assert.equal(argsOf(call, '--allowedTools'), 'WebFetch,WebSearch');
  assert.ok(call.stdin.includes(M.opencodeDiscussFooter(h.cwd, '', true).split('\n')[2]));
  assert.ok(call.args.includes('--strict-mcp-config'));
  assert.equal(argsOf(call, '--setting-sources'), 'user');
  assert.equal(argsOf(call, '--permission-mode'), 'dontAsk');
  assertGuard(call, 'read', h.cwd, h.runs);
  assert.ok(!call.args.includes('-y'));
  assert.equal(argsOf(call, '--effort'), 'high');
  assert.equal(argsOf(call, '--output-format'), 'stream-json');
  assert.ok(argsOf(call, '--json-schema').includes('"position"'));
  assert.ok(call.stdin.includes('## 讨论规则'));
  assert.equal(r.status, 'done');
  assert.equal(r.readonly, 'tools');
  assert.equal(r.changes.available, false);
  assert.equal(r.changes.note, M.codebuddyNoChanges);
  // On a new session result.usage is also the first call's total.
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
  assert.equal(h.events(r.run_id).filter(e => e.type === 'step.usage').length, 1);
});

test('续接：没有 turnUsage 时忽略 session 总用量，只算本轮 assistant', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ resumed_result_usage: { input_tokens: 10000, cache_read_input_tokens: 5000, output_tokens: 900 } });
  const first = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '第一轮' }));
  const resumed = output(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-'], { env: s.env, input: '第二轮' }));
  assert.equal(argsOf(runs(s)[1], '--resume'), 'synthetic-codebuddy-session');
  assert.deepEqual(resumed.usage, first.usage);
  assert.equal(resumed.usage_scope, 'this_run');
});

test('用量：turnUsage 快照优先于 session 总量和 assistant 片段', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ result_usage: { input_tokens: 10000, output_tokens: 900 }, turn_usage: { input_tokens: 17, cache_read_input_tokens: 4, output_tokens: 8 } });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }));
  assert.deepEqual(r.usage, { input_tokens: 17, cached_input_tokens: 4, output_tokens: 8, reasoning_output_tokens: 0 });
});

test('实时用量：同一消息先发零用量 thinking，随后工具片段补齐用量，只发送一次', async (t) => {
  const h = sandbox(t);
  configure(h, {}, c => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const s = h.scenario({ thinking_fragments: true, tool_calls: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.txt' } }] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }));
  const steps = h.events(r.run_id).filter(e => e.type === 'step.usage');
  assert.equal(steps.length, 2);
  assert.deepEqual(steps.map(e => e.usage.input_tokens), [10, 10]);
  assert.equal(steps[0].final, undefined);
  assert.equal(steps[1].final, true);
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
  assert.equal(argsOf(call, '--allowedTools'), null);
  assertGuard(call, 'read', h.cwd, h.runs);
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
  if (access === 'shell') {
    const settings = path.join(h.home, '.codebuddy/settings.json');
    fs.mkdirSync(path.dirname(settings));
    fs.writeFileSync(settings, JSON.stringify({ permissions: { deny: ['Edit(./private/**)'], ask: ['Write(./private/**)'] } }));
  }
  h.initGit();
  const editTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'StructuredOutput'];
  const shellTools = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'StructuredOutput'];
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
  assertGuard(call, access, h.cwd, h.runs);
  if (access === 'edit') {
    assert.equal(argsOf(call, '--permission-mode'), 'dontAsk');
    assert.equal(argsOf(call, '--allowedTools'), 'Write(./**),Edit(./**),WebFetch,WebSearch');
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

test('Windows：外部 junction 限制讨论、审查和 edit 的搜索，shell 保留搜索', { skip: process.platform !== 'win32' }, async (t) => {
  const h = sandbox(t);
  h.initGit();
  h.write('source.txt', 'after\n');
  const outside = path.join(h.home, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(h.cwd, 'nested'));
  fs.symlinkSync(outside, path.join(h.cwd, 'nested/linkdir'), 'junction');
  const cases = [
    ['discuss', 'edit', 'Read,WebFetch,WebSearch,StructuredOutput'],
    ['review', 'edit', 'Read,StructuredOutput'],
    ['run', 'edit', 'Read,Write,Edit,WebFetch,WebSearch,StructuredOutput'],
    ['run', 'shell', 'Read,Glob,Grep,Write,Edit,Bash,PowerShell,WebFetch,WebSearch,StructuredOutput'],
  ];
  for (const [mode, access, tools] of cases) {
    configure(h, { run_access: access }, c => { c.modules.default[mode].complex = { agent: 'cb' }; });
    const s = h.scenario(mode === 'run' ? { structured: report } : {}, mode + '-' + access);
    const extra = mode === 'discuss' ? ['--agent', 'cb'] : [];
    const r = output(await h.bridge(taskArgs(h, mode, extra), { env: s.env, input: '合成任务' }));
    const [call] = runs(s);
    assert.equal(argsOf(call, '--tools'), tools, mode);
    assert.equal(call.stdin.endsWith(M.codebuddyFileList('source.txt')), access !== 'shell', mode);
    assert.equal(r.notes.includes(M.codebuddyLinksNoSearch('nested/linkdir')), access !== 'shell', mode);
  }
});

test('Windows：内部 junction 保留搜索，外部 junction 仍可在无 Git 清单时运行', { skip: process.platform !== 'win32' }, async (t) => {
  const h = sandbox(t);
  configure(h, {}, c => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  fs.symlinkSync(h.cwd, path.join(h.cwd, 'internal'), 'junction');
  const s = h.scenario();
  const discuss = () => h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '合成议题' });
  const r = output(await discuss());
  assert.equal(argsOf(runs(s)[0], '--tools'), 'Read,Glob,Grep,WebFetch,WebSearch,StructuredOutput');
  assert.ok(!r.notes.includes(M.codebuddyLinksNoSearch('internal')));
  fs.mkdirSync(path.join(h.home, 'outside'));
  fs.symlinkSync(path.join(h.home, 'outside'), path.join(h.cwd, 'external'), 'junction');
  output(await discuss());
  assert.equal(argsOf(runs(s)[1], '--tools'), 'Read,WebFetch,WebSearch,StructuredOutput');
  assert.ok(runs(s)[1].stdin.endsWith(M.codebuddyFileList('')));
});

test('项目树扫描跳过 .git，并在超过条目上限时停止', (t) => {
  const h = sandbox(t);
  h.write('.git/ignored.txt', 'synthetic');
  h.write('nested/a.txt', 'synthetic');
  h.write('nested/b.txt', 'synthetic');
  assert.deepEqual(outsideLinks(h.cwd, 3), { links: [], capped: false });
  assert.deepEqual(outsideLinks(h.cwd, 2), { links: [], capped: true });
});

test('Windows：git 忽略的目录里的外部链接不影响搜索，ignoreGitIgnore 打开时照样算', { skip: process.platform !== 'win32' }, (t) => {
  const h = sandbox(t);
  const outside = path.join(h.home, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(h.cwd, 'vendor'));
  fs.symlinkSync(outside, path.join(h.cwd, 'vendor/linkdir'), 'junction');
  assert.deepEqual(outsideLinks(h.cwd, 100, [path.join(h.cwd, 'vendor')]), { links: [], capped: false });
  assert.deepEqual(outsideLinks(h.cwd, 100, []), { links: ['vendor/linkdir'], capped: false });
});

test('文件清单按字符预算截断，并写明列出了几个、一共几个', () => {
  const files = ['a.txt', 'b.txt', 'c.txt'];
  assert.equal(boundedList(files, 100), M.codebuddyFileList('a.txt\nb.txt\nc.txt'));
  assert.equal(boundedList(files, 12), `${M.codebuddyFileList('a.txt\nb.txt')}\n${M.codebuddyFileListTruncated(2, 3)}`);
});

test('Windows：钩子固定用找到的 Git Bash，找不到时拒绝启动；子进程不继承 CODEBUDDY_PLUGIN_DIRS', { skip: process.platform !== 'win32' }, async (t) => {
  const h = sandbox(t);
  configure(h, {}, c => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const bash = h.write('git/bin/bash.exe', 'synthetic');
  const capture = path.join(h.home, 'env.json');
  const s = h.scenario({ env_capture: capture });
  const discuss = (env) => h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: { ...s.env, ...env }, input: '合成议题' });
  output(await discuss({ CODEBUDDY_CODE_GIT_BASH_PATH: bash, CODEBUDDY_PLUGIN_DIRS: path.join(h.home, 'plugins'),
    CODEBUDDY_MAIN_AGENT_ENABLED: '1', CODEBUDDY_MAIN_AGENT_ALLOW_UNOPTED: '1', CODEBUDDY_MCP_CONFIG: '{}',
    CODEBUDDY_PROJECT_CONFIG_DIR: path.join(h.home, 'elsewhere') }));
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), { plugin_dirs: null, git_bash: path.resolve(bash),
    main_agent: '0', allow_unopted: null, mcp_config: null, project_config_dir: null });
  // 没有设置、PATH 上没有 git、Program Files 下也没有 Git 时拒绝启动，不启动 CodeBuddy。
  const empty = { CODEBUDDY_CODE_GIT_BASH_PATH: '', CLAUDE_CODE_GIT_BASH_PATH: '', PATH: path.join(h.home, 'no-tools'),
    ProgramW6432: path.join(h.home, 'pf'), ProgramFiles: path.join(h.home, 'pf'), 'ProgramFiles(x86)': path.join(h.home, 'pf') };
  assert.equal(gitBashPath(empty), null);
  const before = runs(s).length;
  const r = await discuss(empty);
  assert.ok(`${r.stdout}${r.stderr}`.includes(M.codebuddyNeedsGitBash), r.stdout + r.stderr);
  assert.equal(runs(s).length, before);
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
  assert.deepEqual(r.errors, []);
  assert.ok(!r.changes.files.some((file) => file.path === 'blocked.txt' && file.by === 'agent'));
});

test('工具结果：保留拒绝原文和路径，API 错误对象转成 JSON', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, (c) => { c.modules.default.run.complex = { agent: 'cb' }; });
  const outside = path.join(h.home, 'outside.txt');
  const local = path.join(h.cwd, '.claude/config.json');
  const detail = 'PreToolUse:Edit hook blocked this tool call: foreman guard: path is in a protected location';
  const tail = 'Use a project file.';
  const denied = 'Permission to use Read has been denied.';
  const apiError = { message: 'synthetic API error', code: 'synthetic' };
  const s = h.scenario({ structured: report, result_errors: [apiError], tool_calls: [
    { type: 'tool_use', id: 'deny-edit', name: 'Edit', input: { file_path: local } },
    { type: 'tool_use', id: 'deny-read', name: 'Read', input: { file_path: '../outside.txt' } },
  ], tool_results: [
    { is_error: true, content: [{ type: 'text', text: detail }, { type: 'text', text: tail }] },
    { is_error: true, content: denied },
  ], denied: [{ id: 'deny-read', tool: 'Read' }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '执行' }));
  assert.deepEqual(r.questions, [
    { source: 'permission_denied', question: 'Edit (.claude/config.json)', options: [], recommendation: null, detail: `Edit (.claude/config.json): ${detail}\n${tail}` },
    { source: 'permission_denied', question: `Read (${outside})`, options: [], recommendation: null, detail: `Read (${outside}): ${denied}` },
  ]);
  assert.deepEqual(r.errors, [JSON.stringify(apiError)]);
  const edit = h.events(r.run_id).find(e => e.item?.id === 'deny-edit').item;
  assert.equal(edit.aggregated_output, detail + '\n' + tail);
  assert.deepEqual(edit.changes, []);
});

test('上网：讨论里的 WebSearch、WebFetch 记成 web_search，审查的提示词不提上网', async (t) => {
  const h = sandbox(t);
  configure(h, {}, c => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; c.modules.default.review.normal = { agent: 'cb' }; });
  const s = h.scenario({ tool_calls: [
    { type: 'tool_use', id: 'ws', name: 'WebSearch', input: { query: 'codebuddy release notes' } },
    { type: 'tool_use', id: 'wf', name: 'WebFetch', input: { url: 'https://example.com/notes', prompt: 'summary' } },
  ] }, 'web-discuss');
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '合成议题' }));
  const web = h.events(r.run_id).filter(e => e.item?.type === 'web_search').map(e => e.item.query);
  assert.deepEqual(web, ['codebuddy release notes', 'https://example.com/notes']);
  h.initGit(); h.write('source.txt', 'after\n');
  const review = h.scenario({}, 'web-review');
  output(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-'], { env: review.env, input: '检查' }));
  const call = runs(review)[0];
  assert.ok(!call.stdin.includes(M.opencodeDiscussFooter(h.cwd, '', true).split('\n')[2]));
  assert.ok(!argsOf(call, '--tools').includes('Web'));
});

test('工具结果：成功的读取里引用了拒绝原话不算被拦；被拦的搜索在问题里写明模式', async (t) => {
  const h = sandbox(t);
  configure(h, {}, c => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const quoted = 'Error: PreToolUse:Write hook blocked this tool call: foreman guard: path is outside the project';
  const blocked = 'Error: PreToolUse:Glob hook blocked this tool call: foreman guard: path is outside the project';
  const s = h.scenario({ tool_calls: [
    { type: 'tool_use', id: 'read-doc', name: 'Read', input: { file_path: 'notes.md' } },
    { type: 'tool_use', id: 'glob-a', name: 'Glob', input: { pattern: '/etc/*.conf' } },
    { type: 'tool_use', id: 'glob-b', name: 'Glob', input: { pattern: '/var/*.log' } },
  ], tool_results: [
    { is_error: false, content: [{ type: 'text', text: quoted }] },
    { is_error: true, content: [{ type: 'text', text: blocked }] },
    { is_error: true, content: [{ type: 'text', text: blocked }] },
  ] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '合成议题' }));
  assert.deepEqual(r.questions.filter(q => q.source === 'permission_denied').map(q => q.question),
    ['Glob (pattern /etc/*.conf)', 'Glob (pattern /var/*.log)']);
  assert.equal(h.events(r.run_id).find(e => e.item?.id === 'read-doc').item.exit_code, 0);
});

test('执行报告不合格时，同一会话、不给工具修复一次，用量累加', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, (c) => { c.modules.default.run.complex = { agent: 'cb' }; });
  const s = h.scenario({ calls: [{ last_message: 'not json', no_structured: true }, { structured: report, result_usage: { input_tokens: 20, output_tokens: 10 } }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '任务' }));
  assert.deepEqual(r.report, report);
  const [first, second] = runs(s);
  assert.equal(argsOf(first, '--tools'), 'Read,Glob,Grep,Write,Edit,WebFetch,WebSearch,StructuredOutput');
  assert.equal(argsOf(second, '--tools'), 'StructuredOutput');
  assert.ok(!second.args.includes('--settings'));
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

test('额度用尽映射 quota_exhausted；超时会终止运行中的 CLI', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const quota = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: h.scenario({ quota_exhausted: true }).env, input: '议题' }), 1);
  assert.equal(quota.status, 'quota_exhausted');
  const timed = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb', '--timeout', '0.02']), { env: h.scenario({ hold: true }, 'timeout').env, input: '议题' }), 1);
  assert.equal(timed.status, 'timeout');
});

for (const [label, settings] of Object.entries({
  allow: { permissions: { allow: ['Read(~/outside/**)'] } },
  additionalDirectories: { permissions: { additionalDirectories: ['../outside'] } },
  hooks: { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo unsafe' }] }] } },
  pluginFlag: { enabledPlugins: { 'synthetic@fixture': true } },
  pluginState: { enabledPlugins: { 'synthetic@fixture': { enabled: true } } },
  malformed: '{broken',
})) test(`用户设置（${label}）：拒绝扩大目录边界，报错包含文件路径`, async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const file = path.join(h.home, '.codebuddy/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof settings === 'string' ? settings : JSON.stringify(settings));
  const s = h.scenario();
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), { env: s.env, input: '议题' }), 1);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(error => error.includes(file)), JSON.stringify(r.errors));
  if (settings.enabledPlugins) assert.ok(r.errors.some(error => error.includes('enabledPlugins')));
  assert.equal(runs(s).length, 0);
  const checked = output(await h.bridge(['check', '--agent', 'cb'], { env: s.env }), 1);
  assert.equal(checked.agents.cb.ok, false);
  assert.ok(checked.agents.cb.error.includes(file));
});

test('相对配置目录以 foreman 的 cwd 解析，预检和子进程使用同一路径', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.default.discuss.complex = [{ agent: 'cb' }]; });
  const custom = path.join(h.home, 'custom-codebuddy');
  fs.mkdirSync(custom);
  const file = path.join(custom, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ permissions: { additionalDirectories: ['/outside'] } }));
  const capture = path.join(h.home, 'config-dir.txt');
  const s = h.scenario({ config_dir_capture: capture });
  const options = { cwd: h.home, env: { ...s.env, CODEBUDDY_CONFIG_DIR: path.basename(custom) }, input: '议题' };
  const discuss = () => h.bridge(taskArgs(h, 'discuss', ['--agent', 'cb']), options);
  const refused = output(await discuss(), 1);
  assert.ok(refused.errors.some(error => error.includes(file)));
  assert.equal(runs(s).length, 0);
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: [], additionalDirectories: [], deny: ['Read(./secret)'] }, hooks: {},
    enabledPlugins: { disabled: false, disabledWithState: { enabled: false } }, trustedDirectories: [h.home] }));
  assert.equal(output(await discuss()).status, 'done');
  assert.equal(runs(s)[0].cwd, h.cwd);
  assert.equal(fs.readFileSync(capture, 'utf8'), custom);
});

test('显式 bin：npm 无扩展入口和 node shebang 用 node，原生文件直接启动', async (t) => {
  const h = sandbox(t);
  const { default: adapter } = await import(pathToFileURL(path.join(SCRIPTS, 'adapters/codebuddy-cli.mjs')));
  const entry = path.join(h.home, 'node_modules/@tencent-ai/codebuddy-code/bin/codebuddy');
  assert.deepEqual(adapter.locate({ bin: entry }), { file: process.execPath, pre: [entry] });
  const shebang = path.join(h.home, 'custom-codebuddy');
  fs.writeFileSync(shebang, '#!/usr/bin/env node\nconsole.log("ok");\n');
  assert.deepEqual(adapter.locate({ bin: shebang }), { file: process.execPath, pre: [shebang] });
  const native = path.join(h.home, 'native-codebuddy');
  fs.writeFileSync(native, Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  assert.deepEqual(adapter.locate({ bin: native }), { file: native, pre: [] });
});

const fileTool = (tool_name, file_path) => ({ tool_name, tool_input: { file_path } });
const OUTSIDE = 'foreman guard: path is outside the project';
const PROTECTED = 'foreman guard: path is in a protected location (.git, .codebuddy, .claude, or foreman or CodeBuddy settings)';
const AMBIGUOUS = 'foreman guard: path has a . or .. segment or a name ending in a dot or space; use a plain path inside the project';
const UNRESOLVED = 'foreman guard: cannot resolve the path safely';

test('守卫决定表：三档的文件工具权限和歧义路径', (t) => {
  const h = sandbox(t);
  t.mock.method(os, 'homedir', () => h.home);
  const outside = path.join(h.home, 'outside.txt');
  const plain = 'foreman guard: use a plain path; @ references, file: URLs and /c/-style drive paths are not allowed';
  const notAllowed = 'foreman guard: this tool is not allowed in this run';
  const deny = reason => ({ decision: 'deny', reason });
  const undecided = { decision: null, reason: null };
  for (const mode of ['read', 'edit', 'shell']) {
    for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit']) {
      const search = tool === 'Glob' || tool === 'Grep', write = tool === 'Write' || tool === 'Edit';
      const decide = value => toolDecision(mode, h.cwd, search
        ? { tool_name: tool, tool_input: { path: value, pattern: '**/*.txt' } }
        : fileTool(tool, value), { runsDir: h.runs });
      const allowed = !write || mode === 'shell' ? undecided : mode === 'edit' ? { decision: 'allow', reason: 'project-local edit' } : deny(notAllowed);
      assert.deepEqual(decide('nested/new.txt'), allowed);
      assert.deepEqual(decide(outside), deny(write && mode === 'read' ? notAllowed : OUTSIDE));
      assert.deepEqual(decide('nested/../new.txt'), deny(AMBIGUOUS));
      assert.deepEqual(decide('./new.txt'), write ? deny(AMBIGUOUS) : undecided);
      assert.deepEqual(decide('.ClAuDe/new.txt'), write ? deny(mode === 'read' ? notAllowed : PROTECTED) : undecided);
      for (const value of ['@../outside.txt', 'file:../outside.txt', 'FILE://outside.txt', 'nul\0.txt',
        ...(process.platform === 'win32' ? ['/c/outside.txt'] : [])]) assert.deepEqual(decide(value), deny(plain));
      if (search) assert.deepEqual(decide(undefined), undecided);
      if (!write) for (const value of ['~', '~/outside.txt']) assert.deepEqual(decide(value), deny(OUTSIDE));
      if (write && process.platform === 'win32') {
        for (const value of ['name./new.txt', 'name /new.txt']) assert.deepEqual(decide(value), deny(AMBIGUOUS));
      }
    }
    const glob = pattern => toolDecision(mode, h.cwd, { tool_name: 'Glob', tool_input: { pattern } }, { runsDir: h.runs });
    assert.deepEqual(glob(path.join(h.home, '*.txt')), deny(OUTSIDE));
    assert.deepEqual(glob('nested/../*.txt'), deny(AMBIGUOUS));
    assert.deepEqual(glob('{src/**,/etc/**}'), deny(OUTSIDE));
    // Grep 的 glob 过滤条件和 Glob 的模式一样检查；Grep 的 pattern 是正则，不当路径看。
    const grep = filter => toolDecision(mode, h.cwd, { tool_name: 'Grep', tool_input: { pattern: '../x', glob: filter } }, { runsDir: h.runs });
    assert.deepEqual(grep('src/**/*.js'), { decision: null, reason: null });
    assert.deepEqual(grep(path.join(h.home, '**/*')), deny(OUTSIDE));
    assert.deepEqual(grep('{*.js,/etc/*}'), deny(OUTSIDE));
    assert.deepEqual(grep('../outside/**'), deny(AMBIGUOUS));
    // WebFetch 只能取网页，file: 网址会被拒（它能读本机文件）。网页由守卫放行（-p 的 dontAsk 下 --allowedTools 放行不了它），
    // shell 档本来就全放行，守卫不表态；用户自己的设置对 WebFetch 写了 deny 或 ask 时也不表态，交给 CodeBuddy 按用户的规则处理。
    const configDir = path.join(h.home, `cb-config-${mode}`);
    const fetch = (url, dir = configDir) => toolDecision(mode, h.cwd, { tool_name: 'WebFetch', tool_input: { url, prompt: 'summary' } }, { runsDir: h.runs, configDir: dir });
    const approved = mode === 'shell' ? { decision: null, reason: null } : { decision: 'allow', reason: 'web page' };
    assert.deepEqual(fetch('https://example.com/page'), approved);
    assert.deepEqual(fetch('http://example.com/'), approved);
    for (const url of [pathToFileURL(path.join(h.home, 'secret.txt')).href, 'ftp://example.com/x', '']) {
      assert.deepEqual(fetch(url), deny('foreman guard: only http and https web pages can be fetched'), url);
    }
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({ permissions: { deny: ['WebFetch(domain:example.com)'] } }));
    assert.deepEqual(fetch('https://example.com/page'), { decision: null, reason: null });
  }
});

test('守卫：真实路径、junction、坏链接和项目根别名', (t) => {
  const h = sandbox(t);
  const options = { runsDir: h.runs }, decide = file => toolDecision('edit', h.cwd, fileTool('Write', file), options);
  assert.equal(decide('new.txt').decision, 'allow');
  assert.equal(decide(path.join(h.cwd, 'nested/new.txt')).decision, 'allow');
  assert.equal(decide('../outside.txt').reason, AMBIGUOUS);
  assert.equal(decide(path.join(h.home, 'outside.txt')).reason, OUTSIDE);
  assert.equal(decide('.git/config').reason, PROTECTED);
  assert.equal(decide('.codebuddy/settings.json').reason, PROTECTED);
  assert.equal(decide('').reason, UNRESOLVED);
  assert.equal(toolDecision('edit', null, fileTool('Write', 'new.txt'), options).reason, UNRESOLVED);
  const outside = path.join(h.home, 'outside');
  fs.mkdirSync(outside);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(outside, path.join(h.cwd, 'escape'), linkType);
  assert.equal(decide('escape/new.txt').reason, OUTSIDE);
  assert.equal(toolDecision('read', h.cwd, fileTool('Read', 'escape/new.txt'), options).reason, OUTSIDE);
  fs.mkdirSync(path.join(h.cwd, '.codebuddy'));
  fs.symlinkSync(path.join(h.cwd, '.codebuddy'), path.join(h.cwd, 'settings-alias'), linkType);
  assert.equal(decide('settings-alias/settings.json').reason, PROTECTED);
  fs.symlinkSync(path.join(h.home, 'not-created'), path.join(h.cwd, 'dangling'), linkType);
  assert.equal(decide('dangling/new.txt').decision, 'deny');
  const rootLink = path.join(h.home, 'project-link');
  fs.symlinkSync(h.cwd, rootLink, linkType);
  assert.equal(toolDecision('edit', rootLink, fileTool('Write', path.join(h.cwd, 'new/deep/file.txt')), options).decision, 'allow');
});

test('守卫：保护目录的链接目标、gitdir 和 foreman 记录，并拒绝硬链接写入', (t) => {
  const h = sandbox(t);
  const options = { runsDir: path.join(h.cwd, 'run-records') };
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const local = path.join(h.cwd, 'settings-target'), external = path.join(h.home, 'settings-alias');
  fs.mkdirSync(local);
  fs.symlinkSync(local, external, linkType);
  fs.symlinkSync(external, path.join(h.cwd, '.CLAUDE'), linkType);
  h.write('.git', 'gitdir: git-metadata\r\n');
  fs.linkSync(h.write('local.txt', 'synthetic'), path.join(h.home, 'linked.txt'));
  for (const mode of ['edit', 'shell']) {
    const decide = file => toolDecision(mode, h.cwd, fileTool('Edit', file), options);
    for (const file of ['.claude/settings.json', '.CLAUDE/settings.json', 'settings-target/settings.json', 'git-metadata/index', 'run-records/meta.json']) {
      assert.deepEqual(decide(file), { decision: 'deny', reason: PROTECTED }, file);
    }
    assert.deepEqual(decide('local.txt'), { decision: 'deny', reason: 'foreman guard: file has other hard links; it may change a file outside the project' });
  }
  assert.equal(toolDecision('read', h.cwd, fileTool('Read', 'local.txt'), options).decision, null);
});

test('守卫：Windows UNC 路径在文件系统调用之前拒绝', { skip: process.platform !== 'win32' }, (t) => {
  const h = sandbox(t);
  const fail = () => assert.fail('UNC rejection must precede filesystem calls');
  const mocks = [t.mock.method(fs.realpathSync, 'native', fail),
    ...['lstatSync', 'statSync', 'readdirSync', 'readlinkSync', 'readFileSync'].map(name => t.mock.method(fs, name, fail))];
  for (const mode of ['read', 'edit', 'shell']) for (const name of ['Read', 'Write']) {
    for (const file of ['\\\\synthetic-server\\share\\file.txt', '//synthetic-server/share/file.txt']) {
      assert.deepEqual(toolDecision(mode, h.cwd, fileTool(name, file), { runsDir: h.runs }),
        { decision: 'deny', reason: 'foreman guard: path is on a network share' });
    }
  }
  for (const fn of mocks) assert.equal(fn.mock.callCount(), 0);
});

test('守卫进程：安全读取不输出，输入错误和配置目录写入输出 deny', async (t) => {
  const h = sandbox(t);
  const configDir = path.join(h.cwd, 'custom-settings');
  const run = (mode, input) => h.start(GUARD, [mode, h.cwd, h.runs], { input, env: { CODEBUDDY_CONFIG_DIR: configDir } }).done;
  const allowed = await run('read', JSON.stringify(fileTool('Read', 'a.txt')));
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout, '');
  for (const [mode, input, reason] of [['read', '{broken', UNRESOLVED], ['shell', JSON.stringify(fileTool('Write', 'custom-settings/settings.json')), PROTECTED]]) {
    const denial = output(await run(mode, input));
    assert.deepEqual(denial.hookSpecificOutput, { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason });
  }
});

for (const rule of ['deny', 'ask']) test(`edit 守卫不会覆盖用户 ${rule} 规则`, async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, c => { c.modules.default.run.complex = [{ agent: 'cb' }]; });
  const file = path.join(h.home, '.codebuddy/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { [rule]: ['Edit(./private/**)'] } }));
  const s = h.scenario();
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '任务' }), 1);
  assert.equal(r.status, 'failed');
  assert.ok(r.errors.some(error => error.includes(file) && error.includes(`permissions.${rule}`)));
  assert.equal(runs(s).length, 0);
});

test('check：版本、清单、最小请求，推理强度按清单核对', async (t) => {
  const h = sandbox(t);
  const cwd = path.join(h.cwd, 'check project'), runsDir = path.join(h.home, 'check-runs');
  fs.mkdirSync(cwd);
  configure(h, { effort: 'high' }, (c) => {
    c.modules.default.discuss.complex = [{ agent: 'cb', effort: 'high' }];
    c.dispatch.runs_dir = runsDir;
  });
  const s = h.scenario({ models: ['fake-1', 'fake-2'] });
  const r = await h.bridge(['check', '--agent', 'cb', '--cwd', cwd], { env: s.env });
  const out = output(r, r.code);
  assert.equal(out.agents.cb.type, 'codebuddy cli');
  assert.equal(out.agents.cb.version, '2.180.0');
  assert.equal(out.agents.cb.model_listed, true);
  assert.equal(out.agents.cb.reply, 'OK');
  assert.deepEqual(out.agents.cb.efforts.map((e) => [e.variant, e.ok]), [['high', true]]);
  // 依次是 --version、--help、最小真实请求；最小请求不给任何工具，所以也不注入守卫
  const list = s.calls();
  assert.deepEqual(list.map((c) => c.operation), ['version', 'help', 'run']);
  const probe = list.at(-1);
  assert.ok(probe.args.includes('--no-session-persistence'));
  assert.equal(argsOf(probe, '--tools'), '');
  assert.equal(probe.cwd, cwd);
  assert.ok(!probe.args.includes('--settings'));
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
    'node "$APPDATA/npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" -p hi', 'codebuddy > out.txt -p hi',
    "codebuddy model.lp --append-system-prompt '-solve' -p", "cbc model.lp --append-system-prompt '-solve' -p",
    'codebuddy model.lp -solve', 'npx @tencent-ai/codebuddy-code model.lp -solve',
    'node /npm/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy model.lp -solve', 'cbc -- "run a task"',
    'cbc "review this diff"', 'cbc model.mps -py hi', 'cbc model.mps --model fake-1', 'cbc -import'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 2, command);
  for (const command of ['codebuddy --version', 'codebuddy --help', 'codebuddy -c --help', 'cbc config set -g theme dark', 'codebuddy update', 'codebuddy mcp list',
    'cbc model.mps -solve', 'cbc -import model.mps -solve', 'cbc model.mps.gz -solve', 'echo codebuddy -p hi',
    'cbc model.mps -preprocess off -solve', 'cbc model.mps -presolve on -priority off -pivot fullDantzig -solve',
    'cbc model.LP.bz2 -ratioGap 0.01 -solve', 'cbc -import model.data -solve',
    'codebuddy --resume --help', 'codebuddy --worktree --help', 'codebuddy -r --help', 'codebuddy -w --help'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 0, command);
});

test('拦截钩子：PATH 上的 cbc 是 CodeBuddy 的启动脚本时不再按求解器放行，是求解器程序时照常放行', async (t) => {
  const h = sandbox(t);
  const hook = (command, dir) => h.hook('guard-direct-calls.mjs', { tool_input: { command } },
    { env: { PATH: [dir, process.env.PATH].join(path.delimiter) } });
  // npm 装的 cbc 是一个很小的文本启动脚本，里面写着 codebuddy-code 的入口。
  const shim = path.join(h.home, 'npm-bin');
  h.write('npm-bin/cbc', '#!/bin/sh\nexec node "$basedir/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy" "$@"\n');
  assert.equal((await hook('cbc model.mps -solve', shim)).code, 2);
  assert.equal((await hook('cbc -import model.mps -solve', shim)).code, 2);
  // COIN-OR CBC 是一个大的二进制程序。
  const solver = path.join(h.home, 'solver-bin');
  fs.mkdirSync(solver);
  fs.writeFileSync(path.join(solver, process.platform === 'win32' ? 'cbc.exe' : 'cbc'), Buffer.alloc(70000, 1));
  assert.equal((await hook('cbc model.mps -solve', solver)).code, 0);
  assert.equal((await hook('cbc "review this diff"', solver)).code, 2);
});

test('讨论、审查和执行带 --add-dir 时直接报错', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'shell' }, (c) => {
    c.modules.default.discuss.complex = [{ agent: 'cb' }];
    c.modules.default.review.normal = { agent: 'cb' };
    c.modules.default.run.complex = { agent: 'cb' };
  });
  h.initGit(); h.write('source.txt', 'after\n');
  const s = h.scenario();
  for (const args of [taskArgs(h), taskArgs(h, 'discuss', ['--agent', 'cb']), ['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-']]) {
    failed(await h.bridge([...args, '--add-dir', h.home], { env: s.env }), M.codebuddyNoAddDir('cb'));
  }
  assert.equal(runs(s).length, 0);
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
