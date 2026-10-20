import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, piAgent, taskArgs, output, failed, read, seedRun, ROOT, PI, MESSAGES } from './helpers.mjs';
import { report, discussion } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const SCRIPTS = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const GUARD = path.join(SCRIPTS, 'adapters/pi-guard.mjs');
const ISOLATE = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-mcp', '--no-approve', '--offline'];
const catalog = [
  { provider: 'fake', id: 'model', name: 'Fake Model', reasoning: true, thinkingLevelMap: { minimal: null, medium: null, max: 'max' }, contextWindow: 1000, cost: { input: 1, output: 2 } },
  { provider: 'fake', id: 'plain', reasoning: false, contextWindow: 500 },
];
const supported = ['off', 'low', 'high', 'max'];
const configure = (h, extra = {}, change = () => {}) => {
  const c = baseConfig();
  c.agents.pi = { ...piAgent(), ...extra };
  change(c);
  h.config(c);
  return c;
};
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
let ids = 0;
const tool = (name, args, { result = 'synthetic output', isError = false, files } = {}) => {
  const id = `call-${++ids}`;
  return [{ event: { type: 'tool_execution_start', toolCallId: id, toolName: name, args } },
    { files, event: { type: 'tool_execution_end', toolCallId: id, toolName: name, result: { content: [{ type: 'text', text: result }] }, isError } }];
};
const policies = (file) => read(file).trim().split('\n').map((line) => JSON.parse(line));

test('配置：pi cli 的模型写法、run_access、推理强度和执行授权', async (t) => {
  const h = sandbox(t), c = configure(h, { model: 'nomodel' });
  failed(await h.bridge(['config']), M.configInvalid('agents.pi.model', M.invalid.piModel));
  c.agents.pi = { ...piAgent(), run_access: 'all' }; h.config(c);
  failed(await h.bridge(['config']), M.configInvalid('agents.pi.run_access', M.invalid.runAccess));
  c.agents.pi = piAgent(); c.modules.run.complex = { agent: 'pi' }; h.config(c);
  failed(await h.bridge(['config']), M.runAccessRequired('pi', 'pi cli'));
  c.modules.run.complex = { agent: 'pi', effort: 'turbo' }; c.agents.pi.run_access = 'edit'; h.config(c);
  failed(await h.bridge(['config']), M.configInvalid('modules.run.complex[0].effort', 'off / minimal / low / medium / high / xhigh / max'));
  c.modules.run.complex = { agent: 'pi', effort: 'high' }; h.config(c);
  const r = output(await h.bridge(['config']));
  assert.deepEqual(r.agents_status.pi.capabilities.modes, ['run', 'review', 'discuss']);
  assert.equal(r.agents_status.pi.bin, PI);
  assert.equal(r.agents_status.pi.run_access, 'edit');
});

test('讨论：只读工具和守卫、隔离参数、事件翻译、用量和费用', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.discuss.complex = [{ agent: 'pi', effort: 'high' }]; });
  const guardFile = path.join(h.home, 'guard.log');
  const s = h.scenario({ guard_file: guardFile, steps: [...tool('read', { path: path.join(h.cwd, 'src/file.mjs') }), ...tool('grep', { pattern: 'todo', path: 'src' })] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi', '--title', '合成讨论']), { env: s.env, input: '合成议题' }));
  assert.deepEqual(r.report, discussion);
  assert.equal(r.agent_type, 'pi cli');
  const call = runs(s)[0];
  assert.deepEqual(call.args, ['--mode', 'json', '--model', 'fake/model', ...ISOLATE, '-e', GUARD, '--thinking', 'high', '--tools', 'read,grep,find,ls', '--name', '合成讨论']);
  assert.deepEqual(policies(guardFile), [{ root: h.cwd, access: 'read' }]);
  assert.ok(call.stdin.startsWith('合成议题'));
  assert.ok(call.stdin.includes('不能运行命令'));
  assert.deepEqual(r.usage, { input_tokens: 17, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2 });
  assert.equal(r.cost_usd, 0.25);
  assert.equal(r.session_id, 'synthetic-pi-session');
  assert.equal(r.changes.note, M.piNoChanges);
  const events = h.events(r.run_id);
  assert.deepEqual(events.map((e) => e.item?.type ?? e.type), ['thread.started', 'command_execution', 'command_execution', 'reasoning', 'agent_message']);
  assert.equal(events[1].item.command, 'read src/file.mjs');
  assert.equal(events[2].item.command, 'grep todo src');
  const logged = read(path.join(r.run_dir, 'pi.jsonl'));
  for (const type of ['message_update', 'message_start', 'turn_end', 'agent_end']) assert.ok(!logged.includes(`"type":"${type}"`), type);
  assert.ok(logged.includes('"type":"tool_execution_end"'));
  const resumed = output(await h.bridge(['resume', '--run', r.run_id, '--brief', '-', '--level', 'complex'], { env: s.env, input: '第二轮' }));
  assert.ok(runs(s)[1].args.includes('--session'));
  assert.equal(runs(s)[1].args[runs(s)[1].args.indexOf('--session') + 1], 'synthetic-pi-session');
  assert.ok(runs(s)[1].stdin.includes(M.opencodeResumeFooter));
  assert.equal(resumed.status, 'done');
});

test('审查：补丁材料、只读工具，审查不能续接', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.review.normal = { agent: 'pi' }; });
  h.initGit(); h.write('source.txt', 'after\n');
  const s = h.scenario({ last_message: '未发现问题。' });
  const r = output(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-'], { env: s.env, input: '重点检查' }));
  const call = runs(s)[0];
  assert.deepEqual(call.args.slice(call.args.indexOf('--tools'), call.args.indexOf('--tools') + 2), ['--tools', 'read,grep,find,ls']);
  assert.equal(call.args[call.args.indexOf('--name') + 1], 'foreman review');
  assert.ok(call.stdin.startsWith(M.opencodeReviewPrompt(h.cwd, M.reviewScopeUncommitted)));
  assert.ok(call.stdin.includes('+after'));
  assert.equal(r.report, null);
  assert.equal(r.last_message, '未发现问题。');
  failed(await h.bridge(['resume', '--run', r.run_id, '--level', 'normal', '--brief', '-']), M.reviewNoResume);
});

for (const access of ['edit', 'shell']) test(`执行（${access}）：工具、守卫策略、改动归属、被挡的操作、命令计数和 watch`, async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: access }, (c) => { c.modules.run.complex = { agent: 'pi' }; });
  h.initGit();
  const guardFile = path.join(h.home, 'guard.log');
  const s = h.scenario({ guard_file: guardFile, last_message: JSON.stringify(report), steps: [
    ...tool('read', { path: 'source.txt' }),
    ...tool('edit', { path: path.join(h.cwd, 'source.txt') }, { files: { 'source.txt': 'after\n' } }),
    ...tool('write', { path: 'new.txt' }, { files: { 'new.txt': 'new\n' } }),
    ...tool('write', { path: '../outside.txt' }, { isError: true, result: 'foreman guard: ../outside.txt is outside the project directory' }),
    ...(access === 'shell' ? tool('bash', { command: 'npm test' }, { result: 'ok' }) : []),
  ] });
  const execution = await h.bridge(taskArgs(h), { env: s.env, input: '合成执行任务' });
  const r = output(execution), call = runs(s)[0];
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, report);
  assert.equal(r.isolation, 'tools'); assert.equal(r.run_access, access);
  assert.ok(execution.stderr.includes(M.unsandboxedRun(access)));
  assert.equal(call.args[call.args.indexOf('--tools') + 1], access === 'shell' ? 'read,grep,find,ls,edit,write,bash' : 'read,grep,find,ls,edit,write');
  assert.deepEqual(policies(guardFile), [{ root: h.cwd, access }]);
  assert.equal(r.commands_executed, access === 'shell' ? 1 : 0);
  assert.deepEqual(r.changes.files.map((f) => [f.path, f.by]).sort(), [['new.txt', 'agent'], ['source.txt', 'agent']]);
  assert.deepEqual(r.questions.filter((q) => q.source === 'permission_denied').map((q) => q.question), [`write ${JSON.stringify({ path: path.resolve(h.cwd, '../outside.txt') })}`]);
  const events = h.events(r.run_id);
  assert.equal(events.some((e) => e.type === 'item.started' && e.item.command === 'npm test'), access === 'shell');
  const watch = await h.bridge(['watch', '--run', r.run_id]);
  assert.equal(watch.code, 0);
  assert.ok(watch.stdout.includes(D.actionRead('source.txt')) && !watch.stdout.includes('$ read'));
  if (access === 'shell') assert.ok(watch.stdout.includes('$ npm test'));
});

test('执行报告不合格时，同一会话、不开任何工具修复一次，用量累加', async (t) => {
  const h = sandbox(t);
  configure(h, { run_access: 'edit' }, (c) => { c.modules.run.complex = { agent: 'pi' }; });
  const guardFile = path.join(h.home, 'guard.log');
  const s = h.scenario({ guard_file: guardFile, calls: [{ last_message: 'not json' }, { last_message: JSON.stringify(report) }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env, input: '任务' }));
  assert.deepEqual(r.report, report);
  const [first, second] = runs(s);
  assert.ok(first.args.includes('--tools'));
  assert.ok(second.args.includes('--no-tools'));
  assert.equal(second.args[second.args.indexOf('--session') + 1], 'synthetic-pi-session');
  assert.deepEqual(policies(guardFile).map((p) => p.access), ['edit', 'none']);
  assert.equal(r.usage.output_tokens, 10);
  assert.equal(r.cost_usd, 0.5);
});

test('出错、限流、截断、自动重试和推理强度被 pi 改掉', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.discuss.complex = [{ agent: 'pi', effort: 'high' }]; });
  const discuss = (scenario, code = 0) => h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: h.scenario(scenario).env, input: '议题' }).then((r) => output(r, code));
  const broken = await discuss({ stop_reason: 'error', error_message: 'synthetic broken' }, 1);
  assert.equal(broken.status, 'failed'); assert.ok(broken.errors.includes('synthetic broken'));
  const limited = await discuss({ rate_limited: true }, 1);
  assert.ok(limited.notes.includes(M.rateLimited('fake/model', 'pi')));
  const cut = await discuss({ stop_reason: 'length', last_message: '{"position":' }, 1);
  assert.ok(cut.errors.includes(M.piStopLength));
  const retried = await discuss({ retry_first: true });
  assert.equal(retried.status, 'done');
  assert.ok(h.events(retried.run_id).some((e) => e.type === 'error' && e.message === M.piRetrying(1, 3, 'synthetic overloaded')));
  const changed = await discuss({ thinking_level: 'max' });
  assert.ok(changed.notes.includes(M.piEffortChanged('high', 'max')));
  const compacted = await discuss({ steps: [{ event: { type: 'compaction_end', reason: 'threshold', result: { summary: 's', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } }, aborted: false, willRetry: false } }] });
  assert.equal(compacted.usage.input_tokens, 117); assert.equal(compacted.cost_usd, 0.75);
  const unsigned = await discuss({ no_reply: true, exit_code: 1, stderr: 'synthetic: no API key for deepseek\n' }, 1);
  assert.equal(unsigned.status, 'failed');
  assert.ok(unsigned.errors.some((e) => e.includes('synthetic: no API key for deepseek')));
});

test('check：版本、清单、最小请求；推理强度只按清单核对，写明会被改成哪一档', async (t) => {
  const h = sandbox(t), c = configure(h, {}, (cfg) => {
    cfg.modules.discuss.simple = [{ agent: 'pi', effort: 'medium' }];
    cfg.modules.discuss.normal = [{ agent: 'pi', effort: 'high' }];
  });
  const s = h.scenario({ pi_catalog: catalog, last_message: 'OK' });
  const r = output(await h.bridge(['check', '--agent', 'pi'], { env: s.env }), 1), pi = r.agents.pi, list = M.list(supported);
  assert.equal(pi.ok, false); assert.equal(pi.model_listed, true); assert.equal(pi.reply, 'OK'); assert.equal(pi.version, '1.3.0');
  assert.deepEqual(pi.efforts, [
    { model: 'fake/model', variant: 'medium', used_at: ['modules.discuss.simple[0]'], ok: false, error: M.piEffortClamped('medium', 'high', list), supported },
    { model: 'fake/model', variant: 'high', used_at: ['modules.discuss.normal[0]'], ok: true, error: null, supported },
  ]);
  assert.equal(pi.fix, M.fixEffortUnsupported('pi', M.effortAt('medium', 'modules.discuss.simple[0]', 'fake/model', list)));
  const call = runs(s);
  assert.equal(call.length, 1);
  assert.ok(call[0].args.includes('--no-session') && call[0].args.includes('--no-tools') && !call[0].args.includes('--thinking'));
  c.modules.discuss.simple = [{ agent: 'pi', model: 'fake/plain', effort: 'high' }];
  c.modules.discuss.normal = [{ agent: 'pi', model: 'fake/none', effort: 'high' }];
  h.config(c);
  const overridden = output(await h.bridge(['check', '--agent', 'pi'], { env: s.env }), 1).agents.pi;
  assert.deepEqual(overridden.efforts.map((e) => [e.model, e.ok, e.error]), [
    ['fake/plain', false, M.piEffortClamped('high', 'off', 'off')], ['fake/none', false, M.modelNotInCatalog('fake/none')]]);
  c.agents.pi.model = 'fake/modle'; h.config(c);
  const typo = output(await h.bridge(['check', '--agent', 'pi'], { env: s.env }), 1).agents.pi;
  assert.equal(typo.model_listed, false);
  assert.equal(typo.fix, M.fixPiModel('pi', 'fake/modle') + M.closestHint('fake/model'));
  const missing = output(await h.bridge(['check', '--agent', 'pi'], { env: h.scenario({}).env }), 1).agents.pi;
  assert.equal(missing.fix, M.fixPiCatalog('pi', 'synthetic: no model catalog'));
});

test('models 列出 pi 的清单，推理强度按 pi 的规则算', async (t) => {
  const h = sandbox(t);
  configure(h);
  const r = output(await h.bridge(['models'], { env: h.scenario({ pi_catalog: catalog }).env }));
  assert.deepEqual(r.tools['pi cli'].models, [
    { id: 'fake/model', name: 'Fake Model', efforts: supported, default_effort: null, context: 1000, cost: { input: 1, output: 2 } },
    { id: 'fake/plain', name: 'plain', efforts: ['off'], default_effort: null, context: 500, cost: null },
  ]);
  assert.deepEqual(r.agents.pi, { type: 'pi cli', model: 'fake/model', listed: true, efforts: supported, closest: [] });
});

test('守卫扩展：按档位放行工具，文件工具的路径不能出项目目录', async (t) => {
  const { default: guard } = await import(pathToFileURL(GUARD).href);
  const root = path.join(path.parse(process.cwd()).root, 'project');
  const decide = async (access, toolName, input = {}) => {
    const saved = process.env.FOREMAN_PI_GUARD;
    process.env.FOREMAN_PI_GUARD = access === null ? '' : JSON.stringify({ root, access });
    let handler;
    guard({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
    process.env.FOREMAN_PI_GUARD = saved ?? '';
    const result = await handler({ type: 'tool_call', toolName, toolCallId: 'x', input });
    return result?.block ? result.reason : 'allowed';
  };
  assert.match(await decide(null, 'read', { path: 'a.txt' }), /no policy/);
  assert.equal(await decide('read', 'read', { path: 'src/a.txt' }), 'allowed');
  assert.equal(await decide('read', 'grep', { pattern: 'x' }), 'allowed');
  assert.match(await decide('read', 'read', { path: '../secret.txt' }), /outside the project/);
  assert.match(await decide('read', 'ls', { path: path.join(path.parse(root).root, 'elsewhere') }), /outside the project/);
  assert.match(await decide('read', 'edit', { path: 'a.txt' }), /not allowed/);
  assert.match(await decide('read', 'bash', { command: 'ls' }), /not allowed/);
  assert.equal(await decide('edit', 'write', { path: 'new.txt' }), 'allowed');
  assert.match(await decide('edit', 'write', { path: '../new.txt' }), /outside the project/);
  assert.match(await decide('edit', 'bash', { command: 'ls' }), /not allowed/);
  assert.equal(await decide('shell', 'bash', { command: 'cat ../anything' }), 'allowed');
  assert.match(await decide('shell', 'edit', { path: '../x' }), /outside the project/);
  assert.match(await decide('none', 'read', { path: 'a.txt' }), /not allowed/);
  assert.match(await decide('read', 'mcp__server__tool', {}), /not allowed/);
  // 和 pi 一样解析：开头的 @ 去掉、~ 展开、file:// 地址、Windows 上 /c/… 写法
  assert.equal(await decide('read', 'read', { path: '@src/a.txt' }), 'allowed');
  assert.match(await decide('read', 'read', { path: '@../outside.txt' }), /outside the project/);
  assert.match(await decide('read', 'read', { path: '~/secret.txt' }), /outside the project/);
  assert.match(await decide('read', 'read', { path: pathToFileURL(path.join(os.tmpdir(), 'x.txt')).href }), /outside the project/);
  if (process.platform === 'win32') assert.match(await decide('read', 'read', { path: '/c/Windows/win.ini' }), /outside the project/);
  assert.match(await decide('read', 'read', { path: 42 }), /must be a path string/);
});

test('守卫扩展：项目里的符号链接或 junction 指向外面时，按真实路径挡下', async (t) => {
  const { default: guard } = await import(pathToFileURL(GUARD).href);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-guard-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project'), outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const saved = process.env.FOREMAN_PI_GUARD;
  process.env.FOREMAN_PI_GUARD = JSON.stringify({ root, access: 'edit' });
  let handler;
  guard({ on: (name, fn) => { if (name === 'tool_call') handler = fn; } });
  process.env.FOREMAN_PI_GUARD = saved ?? '';
  const decide = async (toolName, input) => (await handler({ type: 'tool_call', toolName, toolCallId: 'x', input }))?.reason ?? 'allowed';
  assert.match(await decide('read', { path: 'link/secret.txt' }), /outside the project/);
  assert.match(await decide('write', { path: 'link/new/file.txt' }), /outside the project/);
  assert.equal(await decide('write', { path: 'src/new/file.txt' }), 'allowed');
  assert.equal(await decide('read', { path: path.join(root, 'src') }), 'allowed');
});

test('拦截钩子：拦下直接用 pi 跑任务，放行查询、管理子命令和文字提及', () => {
  const hook = path.join(ROOT, 'foreman/hooks/guard-direct-calls.mjs');
  const blocked = (command) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' }).status === 2;
  for (const command of ['pi -p "hi"', 'pi --mode json "x"', 'cd a && pi', 'pi --model deepseek/x "fix it"', 'npx @earendil-works/pi-coding-agent -p hi',
    'node C:/x/pi-coding-agent/dist/bundle/cli.js --mode rpc', 'pi.cmd -p hi', 'pi --name list -p "fix source"', 'pi --name --version -p "fix"', 'pi -p -- --version', 'pi -p -- --help',
    'npx --yes @earendil-works/pi-coding-agent -p hi', 'npx -p @earendil-works/pi-coding-agent pi -p hi']) assert.equal(blocked(command), true, command);
  for (const command of ['pi --version', 'pi -v', 'pi --help', 'pi --list-models deepseek', 'pi auth check --provider deepseek', 'pi update', 'pi list',
    'echo pi -p hi', 'git commit -m "pi -p"', 'pip install x', 'node tests/pi-coding-agent.test.mjs', 'pi --model x --list-models']) assert.equal(blocked(command), false, command);
});

test('流式输出期间定期写进度，status 显示思考或回答了多少字，watch 照常', async (t) => {
  const h = sandbox(t);
  configure(h, {}, (c) => { c.modules.discuss.complex = [{ agent: 'pi' }]; });
  const delta = (type, text) => ({ delay_ms: 5, event: { type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, delta: text } } });
  const s = h.scenario({ steps: [{ event: { type: 'message_start', message: { role: 'assistant' } } }, delta('thinking_delta', 'abcd'), delta('thinking_delta', 'efgh'), delta('text_delta', 'xyz')] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--agent', 'pi']), { env: { ...s.env, FOREMAN_TEST_PROGRESS_MS: '1' }, input: '议题' }));
  const progress = h.events(r.run_id).filter((e) => e.type === 'pi.progress');
  assert.deepEqual(progress.map((e) => [e.phase, e.total_chars]), [['thinking', 4], ['thinking', 8], ['answering', 3]]);
  assert.equal((await h.bridge(['watch', '--run', r.run_id])).code, 0);
  seedRun(h, '20000101-thinking', { agent: 'pi', agent_type: 'pi cli', status: 'running', pid: process.pid }, null, [{ type: 'pi.progress', phase: 'thinking', total_chars: 42 }]);
  assert.equal(output(await h.bridge(['status', '--run', '20000101-thinking'])).activity.step, D.stepApiThinking(42));
});
