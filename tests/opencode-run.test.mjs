import { D as displayText } from '../foreman/skills/dispatch/scripts/display.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { sandbox, baseConfig, opencodeAgent, apiAgent, taskArgs, output, failed, json, read, write, poll, seedRun, ROOT, MESSAGES } from './helpers.mjs';
import { report } from './fixtures/reports.mjs';
import { normalize } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
const M = MESSAGES.zh;
const D = { ...MESSAGES.en, ...displayText }; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const configure = (h, access = 'edit') => {
  const c = baseConfig();
  c.agents.oc = { ...opencodeAgent(), ...(access === undefined ? {} : { run_access: access }) };
  c.modules.run.complex = { agent: 'oc' };
  h.config(c);
  return c;
};
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
const tool = (name, input, files, status = 'completed') => ({ files,
  event: { type: 'tool_use', part: { tool: name, state: { status, input, output: 'synthetic output' } } } });
const permissions = (access) => ({ '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', edit: 'allow', ...(access === 'shell' ? { shell: 'allow' } : {}) });

test('opencode step_finish 在运行中写分段用量，缺 tokens 时跳过并保留当前步骤', async (t) => {
  const h = sandbox(t); configure(h); h.initGit();
  const gate = path.join(h.cwd, 'release');
  const s = h.scenario({ last_message: report, steps: [
    { event: { type: 'text', part: { text: 'working' } } },
    { event: { type: 'step_finish', part: { type: 'step-finish', reason: 'tool-calls', cost: 0.0037,
      tokens: { input: 3005, output: 41, reasoning: 6421, cache: { read: 768, write: 0 } } } } },
    { event: { type: 'step_finish', part: { reason: 'tool-calls' } } }, { wait_for: gate },
  ], export_messages: [{ type: 'assistant', tokens: { input: 10, output: 5 }, cost: 0.125 }] });
  const running = h.startBridge(taskArgs(h), { env: s.env }), meta = await h.running();
  const step = await poll(() => h.events(meta.id).find((e) => e.type === 'step.usage'), 'opencode 分段用量');
  assert.deepEqual(step.usage, { input_tokens: 3773, cached_input_tokens: 768, cache_write_input_tokens: 0, output_tokens: 6462, reasoning_output_tokens: 6421 });
  assert.ok(Number.isFinite(Date.parse(step.ts)));
  assert.equal(output(await h.bridge(['status', '--run', meta.id])).activity.step, D.stepSaid('working'));
  write(gate, 'release');
  const r = output(await running.done);
  assert.equal(h.events(meta.id).filter((e) => e.type === 'step.usage').length, 1);
  assert.deepEqual(r.usage, { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 });
  for (const flags of [[], ['--verbose']]) {
    const watched = await h.bridge(['watch', '--run', meta.id, ...flags]);
    assert.equal(watched.code, 0); assert.ok(!watched.stdout.includes('step.usage'));
  }
});

test('opencode stop 用量标记 final 并归一化为 end', async (t) => {
  const h = sandbox(t); configure(h); h.initGit();
  for (const reason of ['stop', 'tool-calls']) {
    const s = h.scenario({ last_message: report, step_finish: { reason, tokens: { input: 1, output: 2, reasoning: 3 } } }, reason);
    const r = output(await h.bridge(taskArgs(h), { env: s.env }));
    const step = h.events(r.run_id).find((e) => e.type === 'step.usage');
    assert.deepEqual(step.usage, { input_tokens: 1, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 3 });
    assert.equal(step.final, reason === 'stop' ? true : undefined);
    assert.equal(normalize(step, { id: r.run_id }, {})[0].end, reason === 'stop' ? 1 : undefined);
  }
});

test('opencode 末步缺 step_finish 时从导出补齐各项用量并保留生成区间', async (t) => {
  const h = sandbox(t); configure(h); h.initGit();
  const s = h.scenario({ last_message: report, steps: [
    { event: { type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 70, output: 60, reasoning: 40, cache: { read: 10, write: 5 } } } } },
    { event: { type: 'step_start' } }, { delay_ms: 40 },
  ], export_messages: [{ type: 'assistant', tokens: { input: 120, output: 140, reasoning: 80, cache: { read: 20, write: 8 } } }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  const raw = read(path.join(r.run_dir, 'opencode.jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(raw.filter((e) => e.type === 'step_start').length, 2);
  assert.equal(raw.filter((e) => e.type === 'step_finish').length, 1);
  const steps = h.events(r.run_id).filter((e) => e.type === 'step.usage'), final = steps.at(-1);
  assert.equal(steps.length, 2); assert.equal(final.final, true);
  assert.deepEqual(final.usage, { input_tokens: 63, cached_input_tokens: 10, cache_write_input_tokens: 3, output_tokens: 120, reasoning_output_tokens: 40 });
  for (const key of Object.keys(r.usage)) assert.equal(steps.reduce((n, e) => n + (e.usage[key] || 0), 0), r.usage[key]);
  assert.ok(final.usage_from <= Date.parse(steps[0].ts));
  assert.ok(final.usage_to > final.usage_from); assert.ok(final.usage_to <= Date.parse(final.ts));
  const ev = normalize(final, { id: r.run_id }, {})[0];
  assert.equal(ev.end, 1); assert.equal(ev.usage_from, final.usage_from); assert.equal(ev.usage_to, final.usage_to);
});

test('opencode 原请求和修复请求都缺 step_finish 时保留最早起点，同毫秒补量仍有区间', async () => {
  const source = read(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters/opencode-cli.mjs'));
  const session = source.slice(source.indexOf('async function opencodeSession('), source.indexOf('// 本机 opencode'));
  for (const durations of [[10000, 1000], [0]]) {
    let clock = 0, requests = 0; const events = [];
    const context = vm.createContext({ path, Date: class extends Date { static now() { return clock; } },
      fs: { appendFileSync() {}, writeFileSync() {} }, capabilities: {}, M: { reportRepairPrompt: () => 'repair' },
      isCancelled: () => false, runLimits: () => ({ deadline: 100000, stallMin: 0 }), validateSchema() {},
      eventWriter: () => (ev) => events.push(ev), opencodeArgs: () => ['run'],
      reportWithRepair: async ({ request, repair }) => {
        let result;
        for (let i = 0; i < durations.length; i++) { if (i) repair(['invalid']); result = await request(); }
        return result;
      },
      runOpencode: async ({ args, onEvent }) => {
        if (args[0] === 'session') return { status: 'done', stdout: JSON.stringify({ messages: [
          { type: 'assistant', time: { created: 0 }, tokens: { output: durations.length === 2 ? 1100 : 1 } },
        ] }) };
        onEvent({ type: 'step_start', sessionID: 'synthetic' }); clock += durations[requests++];
        onEvent({ type: 'text', part: { text: requests === 1 ? 'invalid' : '{}' } });
        return { status: 'done', errors: [], recovered: [], messages: [], questions: [] };
      } });
    vm.runInContext(`${session}\nglobalThis.runSession = opencodeSession;`, context);
    await context.runSession({ started: 0, ctx: { dir: 'synthetic', agent: {}, kind: 'exec', model: 'model' }, meta: {}, writeMeta() {} }, {}, 'foreman-run');
    const usage = events.filter((ev) => ev.type === 'step.usage');
    assert.equal(requests, durations.length); assert.equal(usage.length, 1); assert.equal(usage[0].final, true);
    assert.equal(usage[0].usage_from, 0);
    assert.equal(usage[0].usage_to, durations.length === 2 ? 11000 : 1);
    assert.equal(usage[0].usage.output_tokens, durations.length === 2 ? 1100 : 1);
    if (durations.length === 2) assert.equal(usage[0].usage.output_tokens / ((usage[0].usage_to - usage[0].usage_from) / 1000), 100);
  }
});

test('run_access 只校验 opencode，config 展示权限和执行能力', async (t) => {
  const h = sandbox(t), c = configure(h);
  for (const value of [null, '', 'all', true, 1]) {
    c.agents.oc.run_access = value; h.config(c);
    failed(await h.bridge(['config']), M.configInvalid('agents.oc.run_access', M.invalid.runAccess));
  }
  c.agents.codex.run_access = 'ignored';
  c.agents.api = { ...apiAgent('http://127.0.0.1:1'), run_access: 'ignored' };
  for (const value of ['edit', 'shell', undefined]) {
    c.agents.oc.run_access = value;
    c.modules.run.complex = value ? { agent: 'oc' } : 'claude code'; h.config(c);
    const r = output(await h.bridge(['config']));
    assert.equal(r.agents_status.oc.run_access, value ?? null);
    // 没写 run_access 时派不了执行任务，能力里也不列 run
    assert.deepEqual(r.agents_status.oc.capabilities.modes, value ? ['run', 'review', 'discuss'] : ['review', 'discuss']);
    assert.equal(r.agents_status.codex.run_access, undefined);
  }
});

test('opencode 执行和续接需要用户授权，项目配置不能开启执行', async (t) => {
  const h = sandbox(t), c = configure(h);
  delete c.agents.oc.run_access; h.config(c);
  failed(await h.bridge(['config']), M.runAccessRequired('oc', 'opencode cli'));
  c.modules.run.complex = 'claude code'; h.config(c);
  h.write('.claude/foreman.json', { agents: { oc: { run_access: 'shell' } }, modules: { run: { complex: { agent: 'oc' } } } });
  const r = output(await h.bridge(['config', '--cwd', h.cwd]));
  assert.equal(r.agents_status.oc.run_access, null);
  assert.equal(r.effective.modules.run.complex, 'claude code');
  failed(await h.bridge(taskArgs(h, 'run', ['--agent', 'oc'])), M.runAccessRequired('oc', 'opencode cli'));
  seedRun(h, 'previous-exec', { agent: 'oc', agent_type: 'opencode cli', run_access: 'edit' });
  failed(await h.bridge(['resume', '--run', 'previous-exec', '--level', 'complex', '--brief', '-', '--agent', 'oc']), M.runAccessRequired('oc', 'opencode cli'));
  assert.equal(h.calls().filter((c) => ['run', 'exec'].includes(c.operation)).length, 0, JSON.stringify(h.calls()));
});

for (const access of ['edit', 'shell']) test(`opencode ${access} 执行：权限、归属、报告、用量及 watch 时间线`, async (t) => {
  const h = sandbox(t); configure(h, access); h.initGit();
  const changed = { ...report, files_changed: [{ path: 'reported.txt', change: '模型自报' }] };
  const edits = [['edit', 'source.txt'], ['write', 'write.txt'], ['custom_edit', 'edit.txt'], ['custom_write', 'custom.txt'], ['apply_patch', 'patch.txt']];
  const s = h.scenario({ last_message: `\`\`\`json\n${JSON.stringify(changed)}\n\`\`\``, files: { 'unknown.txt': 'unknown', 'reported.txt': 'claim' }, steps: [
    tool('read', { filePath: path.join(h.cwd, 'source.txt') }), tool('grep', { pattern: 'before' }),
    ...edits.map(([name, file], i) => tool(name, { [i % 2 ? 'path' : 'filePath']: path.join(h.cwd, file) }, { [file]: 'after\n' })),
    tool('edit', { path: 'denied.txt' }, { 'denied.txt': 'outside actor' }, 'error'),
    ...(access === 'shell' ? [tool('shell', { command: 'node --version' }), tool('bash', { command: 'npm test' })] : []),
    tool('grep', { path: h.cwd, pattern: 'export', include: '*.js' }), tool('list', { path: h.cwd }),
  ], export_messages: [{ type: 'assistant', tokens: { input: 10, output: 5 }, cost: 0.125 }] });
  const execution = await h.bridge(taskArgs(h), { env: s.env, input: '合成执行任务' });
  const r = output(execution), call = runs(s)[0], config = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, changed);
  assert.equal(r.isolation, 'tools'); assert.equal(r.run_access, access); assert.equal(r.sandbox, null);
  assert.equal(r.cost_usd, null); assert.equal(r.cost_source, 'unknown'); assert.equal(r.reported_cost_usd, 0.125); assert.equal(r.usage_scope, 'this_run');
  assert.equal(Object.hasOwn(r.usage, 'cache_write_input_tokens'), false);
  assert.equal(r.commands_executed, access === 'shell' ? 2 : 0);
  assert.equal(r.session_id, 'synthetic-opencode-session');
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
  assert.equal(json(path.join(r.run_dir, 'meta.json')).run_access, access);
  assert.deepEqual(Object.keys(config.agent), ['foreman-run']);
  assert.deepEqual(config.agent['foreman-run'].permission, permissions(access));
  assert.ok(call.args.includes('--standalone'));
  assert.ok(execution.stderr.includes(M.unsandboxedRun(access)));
  assert.ok(call.stdin.includes(M.footer(h.cwd, [])));
  const schema = read(path.join(ROOT, 'foreman/skills/dispatch/schemas/report.schema.json'));
  assert.ok(call.stdin.includes(M.opencodeRunFooter(schema, access)));
  assert.equal(r.changes.agent_total, edits.length); assert.equal(r.changes.reported_total, 1); assert.equal(r.changes.unknown_total, 2);
  for (const f of r.changes.files) assert.equal(f.by, edits.some(([, name]) => name === f.path) ? 'agent' : f.path === 'reported.txt' ? 'reported' : 'unknown');
  assert.match(read(path.join(r.run_dir, 'diff.patch')), /-before\n\+after/);
  assert.equal(fs.existsSync(path.join(r.run_dir, 'review.patch')), false);
  const items = h.events(r.run_id).filter((e) => e.item?.tool).map((e) => e.item);
  assert.equal(items[0].category, 'read'); assert.equal(items[1].category, 'search');
  for (const item of items.filter((i) => i.category === 'edit')) assert.equal(item.type, 'file_change');
  assert.deepEqual(items.filter((i) => i.category === 'shell').map((i) => i.command), access === 'shell' ? ['node --version', 'npm test'] : []);
  for (const extra of [[], ['--verbose']]) {
    const watch = await h.bridge(['watch', '--run', r.run_id, ...extra]);
    assert.equal(watch.code, 0); assert.match(watch.stdout, /✎.*source.txt/);
    // 读文件和搜索不算命令：写成"读 …""搜索 …"，不加 $
    assert.ok(watch.stdout.includes(D.actionRead('source.txt')));
    assert.ok(watch.stdout.includes(D.actionSearch('before')));
    // 搜索先写模式，再写 glob 过滤和路径；没有模式时写工具名（和 pi 一致）。简洁显示会折叠一部分，看详细模式
    if (extra.length) assert.ok(watch.stdout.includes(D.actionSearch('export *.js .')) && watch.stdout.includes(D.actionSearch('list .')), watch.stdout);
    assert.ok(!watch.stdout.includes('$ read') && !watch.stdout.includes('$ grep'));
    if (access === 'shell') assert.ok(watch.stdout.includes('node --version'));
  }
});

test('opencode 输出包含推理，压缩请求用量计入本轮并按主模型计价', async (t) => {
  const h = sandbox(t), c = configure(h); c.agents.oc.model = 'provider/gpt-6.1-sol'; h.config(c); h.initGit();
  // opencode 2.1.1 的压缩消息直接带 tokens，失败请求的用量也已消耗。
  const compaction = { type: 'compaction', status: 'completed', reason: 'auto', summary: '合成摘要',
    model: { providerID: 'anthropic', modelID: 'claude-haiku-5-5' }, tokens: { input: 100, output: 20, reasoning: 7, cache: { read: 30, write: 40 } }, cost: 0.25 };
  const s = h.scenario({ last_message: JSON.stringify(report), export_messages: [
    { type: 'assistant', tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }, cost: 0.125 },
    compaction,
    { type: 'compaction', status: 'failed', reason: 'auto', error: { type: 'compaction.failed', message: '合成失败' },
      tokens: { input: 50, output: 4, reasoning: 1, cache: { read: 5, write: 6 } }, cost: 0.5 },
    { ...compaction, created: 'old' }, { type: 'assistant', created: 'old', tokens: { input: 9000, output: 9000 }, cost: 99 },
    { type: 'compaction', status: 'running', reason: 'auto', summary: '', cost: 99 },
    { type: 'user', tokens: { input: 9000 }, cost: 99 },
  ] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.deepEqual(r.usage, { input_tokens: 248, cached_input_tokens: 38, cache_write_input_tokens: 50, output_tokens: 39, reasoning_output_tokens: 10 });
  assert.equal(r.usage_scope, 'this_run'); assert.equal(r.model, 'provider/gpt-6.1-sol');
  assert.equal(r.cost_source, 'api_price'); assert.equal(r.cost_usd, 0.0008388); assert.equal(r.reported_cost_usd, 0.875);
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
});

for (const access of ['edit', 'shell']) test(`opencode ${access} 报告只修复一次，同会话 foreman-repair 无任何工具`, async (t) => {
  const h = sandbox(t); configure(h, access);
  const s = h.scenario({ calls: [
    { last_message: 'not json', steps: [tool('write', { path: 'once.txt' }, { 'once.txt': 'once' })] },
    { last_message: report, expected_agent: 'foreman-repair' },
  ] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env })), calls = runs(s);
  assert.equal(calls.length, 2); assert.deepEqual(r.report, report);
  assert.equal(calls[1].args[calls[1].args.indexOf('--session') + 1], r.session_id);
  assert.equal(calls[1].stdin, M.reportRepairPrompt('Reply is not valid JSON'));
  assert.deepEqual(JSON.parse(calls[1].env.OPENCODE_CONFIG_CONTENT).agent, {
    'foreman-repair': { mode: 'primary', description: 'Report format repair for foreman', permission: { '*': 'deny' } },
  });
  assert.deepEqual(r.changes.files, [{ status: 'A', path: 'once.txt', by: 'agent' }]);
});

test('opencode 修复仍不合格只警告，最终提问不修复', async (t) => {
  const h = sandbox(t); configure(h);
  for (const last of ['not json', '你希望选择哪一个？']) {
    const s = h.scenario({ last_message: last }, last === 'not json' ? 'invalid' : 'question');
    const r = output(await h.bridge(taskArgs(h), { env: s.env }));
    assert.equal(r.status, 'done'); assert.equal(r.report, null);
    assert.equal(r.last_message, last);
    assert.equal(runs(s).length, last === 'not json' ? 2 : 1);
    if (last === 'not json') assert.deepEqual(r.warnings, [M.reportInvalid('oc', path.join(r.run_dir, 'last-message.txt'))]);
    else { assert.equal(r.questions[0].source, 'final_question'); assert.equal(r.needs_decision, true); assert.deepEqual(r.warnings, []); }
  }
});

test('opencode 禁止 no-snapshot，快照失败不启动，Codex 保持可执行', async (t) => {
  const h = sandbox(t); configure(h);
  failed(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])), M.snapshotRequired);
  assert.equal(h.records().length, 0);
  const s = h.scenario({ last_message: report });
  const noGit = { ...s.env, PATH: h.home };
  const r = output(await h.bridge(taskArgs(h), { env: noGit }), 1);
  assert.equal(r.status, 'failed'); assert.equal(r.session_id, null); assert.equal(r.cost_usd, null);
  assert.equal(s.calls().length, 0); assert.equal(r.changes.available, false);
  assert.ok(r.errors[0].startsWith('拍改动快照失败（'));
  assert.ok(r.errors[0].endsWith('没有系统沙箱时不能在追踪不到改动的情况下执行，已取消'));
  assert.equal(json(path.join(r.run_dir, 'meta.json')).status, 'failed');
  h.config(baseConfig());
  const codex = output(await h.bridge(taskArgs(h), { env: noGit }));
  assert.equal(codex.status, 'done'); assert.equal(codex.changes.available, false);
  assert.ok(codex.warnings.some((w) => w.startsWith('改动追踪不可用：')));
});

test('opencode shell 静默时不判卡死，edit 按 stall_min 终止', async (t) => {
  const shell = sandbox(t), edit = sandbox(t);
  for (const [h, access] of [[shell, 'shell'], [edit, 'edit']]) {
    const c = configure(h, access); c.dispatch.stall_min = 0.001; h.config(c);
  }
  const gate = path.join(shell.home, 'release'), ss = shell.scenario({ last_message: report, steps: [{ wait_for: gate }] });
  const running = shell.startBridge(taskArgs(shell), { env: ss.env });
  const meta = await shell.running(); await poll(() => runs(ss).length, 'shell 已启动');
  const es = edit.scenario({ hold: true });
  const stalled = output(await edit.bridge(taskArgs(edit), { env: es.env }), 1);
  assert.equal(stalled.status, 'stalled'); assert.ok(stalled.errors.includes(M.stalled(0.001)));
  assert.equal(output(await shell.bridge(['status', '--run', meta.id])).status, 'running');
  write(gate, 'release'); assert.equal(output(await running.done).status, 'done');
});

test('opencode 续接同一会话和组范围 track，权限变化记入 notes', async (t) => {
  const h = sandbox(t), c = configure(h);
  h.write('.gitignore', 'ignored.txt\n'); h.write('ignored.txt', 'before');
  const s = h.scenario({ last_message: report });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--group', 'work', '--scope', 'src', '--track', 'ignored.txt']), { env: s.env }));
  // 续接只能接最新的一轮，每次都接上一轮
  const resume = (run) => ['resume', '--run', run.run_id, '--level', 'complex', '--brief', '-'];
  const same = output(await h.bridge(resume(first), { env: s.env }));
  assert.equal(same.run_access, 'edit'); assert.equal(same.session_id, first.session_id); assert.deepEqual(same.notes, []);
  c.agents.oc.run_access = 'shell'; h.config(c);
  const second = output(await h.bridge(resume(same), { env: s.env, input: '续接合成任务' }));
  assert.equal(second.session_id, first.session_id); assert.equal(second.run_access, 'shell');
  assert.equal(second.group, 'work'); assert.deepEqual(second.scope, ['src']); assert.deepEqual(second.track, ['ignored.txt']);
  assert.ok(second.notes.includes(M.runAccessChanged('edit', 'shell')));
  const call = runs(s).at(-1);
  assert.equal(call.args[call.args.indexOf('--session') + 1], first.session_id);
  assert.deepEqual(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT).agent['foreman-run'].permission, permissions('shell'));
  assert.equal(call.stdin, `续接合成任务\n\n${M.resumeFooter}\n\n${M.opencodeRunResumeFooter}\n`);
  failed(await h.bridge([...resume(second), '--no-snapshot']), M.snapshotRequired);
});

test('opencode 执行准入仍拦截同组 scope 重叠', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ hold: true });
  const running = h.startBridge(taskArgs(h, 'run', ['--group', 'same', '--scope', 'src']), { env: s.env });
  const meta = await h.running(); await poll(() => runs(s).length, 'opencode 已启动');
  const rejected = await h.bridge(taskArgs(h, 'run', ['--group', 'same', '--scope', 'src/file.mjs']), { env: s.env });
  assert.equal(rejected.code, 2); assert.ok(rejected.stderr.includes(M.scopeOverlap('same', meta.id, ['src/file.mjs'])));
  assert.equal(runs(s).length, 1);
  assert.equal(output(await h.bridge(['cancel', '--run', meta.id])).status, 'cancelled');
  assert.equal(output(await running.done, 1).status, 'cancelled');
});

test('opencode 执行保留总超时、额度和输入看门狗状态', async (t) => {
  const h = sandbox(t); configure(h, 'shell');
  for (const [status, scenario, extra, env] of [
    ['timeout', { hold: true }, ['--timeout', '0.04'], {}],
    ['quota_exhausted', { steps: [{ event: { type: 'error', error: { message: 'quota exhausted' } } }], exit_code: 1 }, [], {}],
    ['needs_input', { hold: true, stderr: 'Continue? [y/n]' }, [], { FOREMAN_TEST_INPUT_WAIT_MIN: '0.001' }],
  ]) {
    const s = h.scenario(scenario, status);
    const r = output(await h.bridge(taskArgs(h, 'run', extra), { env: { ...s.env, ...env } }), 1);
    assert.equal(r.status, status); assert.equal(runs(s).length, 1);
    if (status === 'needs_input') assert.equal(r.questions[0].source, 'input_prompt');
  }
});
