import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plannedSandbox as sandbox, taskArgs, output, json, read, baseConfig, opencodeAgent, apiAgent, seedRun, ROOT, MESSAGES } from './helpers.mjs';
import { report, discussion, command } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
import { looksLikeQuestion, looksLikeInputPrompt } from '../foreman/skills/dispatch/scripts/util.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const question = (source, text, extra = {}) => ({ source, question: text, options: [], recommendation: null, detail: null, ...extra });
const message = (tool, text) => tool === 'codex' ? { type: 'item.completed', item: { type: 'agent_message', text } } : { type: 'text', part: { text } };
const configure = (h, extra = {}) => {
  const c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only', review: 'read-only' }; Object.assign(c.agents, { oc: opencodeAgent(), ...extra });
  c.modules.discuss.complex = Object.keys(c.agents).map((agent) => ({ agent, effort: 'high' }));
  c.modules.discuss.seats = { complex: 1 };
  h.config(c);
};
const discussArgs = (h, agent) => taskArgs(h, 'discuss', ['--agent', agent, '--no-snapshot']);
const waitEnv = { FOREMAN_TEST_INPUT_WAIT_MIN: '0.005' };

test('提问与终端提示只识别指定样式', () => {
  for (const text of ['问题？  ', 'A?\n', '请确定', '请确认', '请选择', '请决定', '要不要', '是否需要我', '你希望', '您希望',
    'PLEASE CONFIRM', 'please choose', 'should I', 'do you want', 'would you like', 'which option']) assert.equal(looksLikeQuestion(text), true, text);
  for (const text of ['', '正在检查文件。', '我会继续。', 'Why? I have checked it.']) assert.equal(looksLikeQuestion(text), false, text);
  for (const text of ['(y/n)', '[y/N]', '[Y/n]', '(yes/no)', 'PRESS ENTER', 'press any key', 'continue?', 'proceed?', 'overwrite?',
    'approve?', 'allow?', 'select an option', 'enter a number', '是否继续', '请输入', '按回车']) assert.equal(looksLikeInputPrompt(text), true, text);
  for (const text of ['你希望怎么做？', 'Working on it', 'please confirm', 'Should I change this?']) assert.equal(looksLikeInputPrompt(text), false, text);
});

test('decision_request 与 asked_mid_run 汇总，最终报告不算中途提问', async (t) => {
  const h = sandbox(t), mid = `请确认${'甲'.repeat(600)}`;
  const ask = { question: '选择范围', options: ['甲', '乙'], recommendation: '甲', why_it_matters: '影响执行范围' };
  const s = h.scenario({ last_message: { ...report, summary: '请确认报告', decision_requests: [ask] }, steps: [
    { event: message('codex', mid) }, { event: message('codex', '继续检查文件。') },
  ] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  assert.deepEqual(r.questions, [question('decision_request', ask.question, { options: ask.options, recommendation: '甲', detail: ask.why_it_matters }),
    question('asked_mid_run', mid.slice(0, 500))]);
  assert.equal(r.needs_decision, true);
  assert.deepEqual(r.notes, [M.needsDecisionNote(1)]);
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
});

test('Codex 四个入口默认 never，显式 approval 覆盖默认值', async (t) => {
  for (const approval of [undefined, 'on-request']) {
    const h = sandbox(t), c = baseConfig();
    c.agents.codex.sandbox = { discuss: 'read-only', review: 'read-only' };
    if (approval) c.agents.codex.approval = approval;
    h.config(c);
    const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
    const resumed = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--no-snapshot']));
    const reviewed = output(await h.bridge(taskArgs(h, 'review', ['--no-snapshot'])));
    const s = h.scenario({ last_message: { ...discussion, open_questions: [] } }, 'discuss');
    const discussed = output(await h.bridge(discussArgs(h, 'codex'), { env: s.env }));
    for (const r of [first, resumed, reviewed, discussed]) {
      assert.deepEqual(r.questions, []);
      assert.equal(r.needs_decision, false);
    }
    for (const call of [...h.calls(), ...s.calls()]) {
      assert.deepEqual(call.args.filter((x) => x.startsWith('approval_policy=')), [`approval_policy="${approval || 'never'}"`]);
    }
  }
});

for (const tool of ['codex', 'oc', 'api']) {
  test(`${tool} 最终回答是问题时不修复，保留 done 和 final_question`, async (t) => {
    const h = sandbox(t), answer = `${'问题内容'.repeat(600)}，你希望选哪一个？`;
    const api = tool === 'api' ? await apiServer(t, [{ answer }]) : null;
    configure(h, api ? { api: apiAgent(api.url) } : {});
    const s = h.scenario({ last_message: answer });
    const r = output(await h.bridge(discussArgs(h, tool), { env: s.env }));
    assert.equal(r.status, 'done');
    assert.equal(r.report, null);
    assert.deepEqual(r.questions, [question('final_question', answer.slice(0, 2000))]);
    assert.equal(r.needs_decision, true);
    assert.deepEqual(r.notes, [M.needsDecisionNote(1)]);
    assert.equal(api ? api.requests.length : s.calls().filter((c) => c.operation !== 'export').length, 1);
    assert.ok(!h.events(r.run_id).some((e) => e.type === 'api.repair'));
  });

  test(`${tool} open_question 只收集不要求决定，续接仍保留统一字段`, async (t) => {
    const h = sandbox(t), api = tool === 'api' ? await apiServer(t) : null;
    configure(h, api ? { api: apiAgent(api.url) } : {});
    const s = h.scenario({ last_message: discussion });
    const first = output(await h.bridge(discussArgs(h, tool), { env: s.env }));
    const second = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--no-snapshot'], { env: s.env }));
    for (const r of [first, second]) {
      assert.deepEqual(r.questions, [question('open_question', discussion.open_questions[0])]);
      assert.equal(r.needs_decision, false);
    }
    const w = await h.bridge(['watch', '--run', first.run_id]);
    assert.ok(w.stdout.includes(D.watchOpenIssues));
    assert.equal(w.stdout.split(discussion.open_questions[0]).length - 1, 1);
    assert.ok(!w.stdout.includes(D.watchDecisions));
  });
}

test('opencode 收集权限拒绝并跨 stderr 去重，项目内路径相对、项目外路径绝对，question 被拒绝', async (t) => {
  const h = sandbox(t); configure(h);
  const outside = path.join(h.home, 'outside/file.txt');
  const denied = { type: 'tool_use', part: { tool: 'read', state: { status: 'error', input: { filePath: outside },
    error: JSON.stringify({ error: { type: 'permission.rejected', message: 'This non-interactive run cannot ask the user for permission, so the request was rejected. Continue without this action.' } }) } } };
  const textDenied = { type: 'tool_use', part: { tool: 'write', state: { status: 'error', input: { path: path.join(h.cwd, 'file.txt') }, error: 'not allowed' } } };
  const log = `! permission requested: external_directory (${path.join(h.home, 'outside/*')}); auto-rejecting\n`;
  const s = h.scenario({ steps: [{ stderr: log }, { event: denied }, { event: denied }, { event: textDenied },
    { stderr: '! permission requested: bash (npm test); auto-rejecting\n' },
    { event: { type: 'tool_use', part: { tool: 'read', state: { status: 'error', error: 'ENOENT' } } } },
  ] });
  const r = output(await h.bridge(discussArgs(h, 'oc'), { env: s.env }));
  const permissions = r.questions.filter((q) => q.source === 'permission_denied');
  assert.equal(permissions.length, 3);
  assert.deepEqual(JSON.parse(permissions[0].detail), { tool: 'read', input: { filePath: outside } });
  assert.deepEqual(JSON.parse(permissions[1].detail), { tool: 'write', input: { path: 'file.txt' } });
  assert.ok(permissions[2].question.includes('bash'));
  assert.ok(!JSON.stringify(permissions[1]).includes(h.home));
  assert.equal(r.needs_decision, true);
  assert.ok(r.notes.includes(M.needsDecisionNote(3)));
  const permission = JSON.parse(s.calls()[0].env.OPENCODE_CONFIG_CONTENT).agent['foreman-discuss'].permission;
  assert.equal(permission.question ?? permission['*'], 'deny');
  assert.ok(!Object.entries(permission).some(([name, value]) => name === 'question' && value === 'allow'));
});

test('opencode asked_mid_run 排除最终回答及报告修复阶段', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ calls: [
    { steps: [{ event: message('oc', '你希望选择哪项？') }], last_message: 'not json' },
    { steps: [{ event: message('oc', 'please confirm repair') }], last_message: { ...discussion, position: 'please confirm final report' } },
  ] });
  const r = output(await h.bridge(discussArgs(h, 'oc'), { env: s.env }));
  assert.equal(s.calls().filter((c) => c.operation === 'run').length, 2);
  assert.deepEqual(r.questions.filter((q) => q.source === 'asked_mid_run'), [question('asked_mid_run', '你希望选择哪项？')]);
  assert.equal(r.needs_decision, false);
});

for (const tool of ['codex', 'oc']) {
  test(`${tool} 终端输入看门狗结束进程树、提醒并允许 resume`, async (t) => {
    const h = sandbox(t); configure(h);
    const childPid = path.join(h.home, 'child.pid');
    const s = h.scenario({ hold: true, steps: [{ child_pid_file: childPid },
      tool === 'codex' ? { stdout: 'Continue? (y/n)' } : { stderr: 'Continue? (y/n)\n' }] });
    const args = tool === 'codex' ? taskArgs(h, 'run', ['--no-snapshot']) : discussArgs(h, tool);
    const r = output(await h.bridge(args, { env: { ...s.env, ...waitEnv } }), 1);
    assert.equal(r.status, 'needs_input');
    assert.deepEqual(r.questions, [question('input_prompt', 'Continue? (y/n)')]);
    assert.equal(r.needs_decision, true);
    assert.deepEqual(r.errors, [M.inputWaitDetected(0.005, 'Continue? (y/n)')]);
    assert.equal(json(path.join(r.run_dir, 'meta.json')).status, 'needs_input');
    for (const pid of [s.calls()[0].pid, Number(read(childPid))]) assert.throws(() => process.kill(pid, 0));
    const context = output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext;
    assert.ok(context.includes(r.run_id));
    assert.ok(context.includes('等人回答，已结束')); // 会话提醒是给 Claude 的提示，跟着插件的语言
    const w = await h.bridge(['watch', '--run', r.run_id]);
    assert.ok(w.stdout.includes(`? ${D.statusName('needs_input')}`));
    assert.ok(w.stdout.includes(`${D.watchInputPromptPrefix}Continue? (y/n)`));
    assert.ok(!w.stdout.includes('✗'));
    const next = h.scenario({ last_message: tool === 'codex' ? report : discussion }, 'resume');
    const resumed = output(await h.bridge(['resume', '--run', r.run_id, '--brief', '-', '--level', 'complex', '--no-snapshot'], { env: next.env }));
    assert.equal(resumed.session_id, r.session_id);
    assert.equal(resumed.status, 'done');
    assert.ok(!output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext.includes(r.run_id));
  });

  test(`${tool} 模型提问后静默不触发输入看门狗`, async (t) => {
    const h = sandbox(t); configure(h);
    const s = h.scenario({ steps: [{ event: message(tool, 'Should I continue? (y/n)') }, { delay_ms: 1000 }], last_message: discussion });
    const r = output(await h.bridge(discussArgs(h, tool), { env: { ...s.env, ...waitEnv } }));
    assert.equal(r.status, 'done');
    assert.deepEqual(r.questions.filter((q) => q.source !== 'open_question'), [question('asked_mid_run', 'Should I continue? (y/n)')]);
    assert.equal(r.needs_decision, false);
  });
}

test('输入看门狗遇到新输出重新计时，Codex 命令执行中不终止', async (t) => {
  for (const busy of [false, true]) {
    const h = sandbox(t);
    const steps = busy ? [{ stdout: 'Continue? (y/n)\n' }, { event: command('item.started') }, { delay_ms: 1000 }, { event: command() }]
      : [{ stdout: 'Continue? (y/n)\n' }, ...Array.from({ length: 5 }, () => ({ delay_ms: 150, stderr: 'working\n' }))];
    const s = h.scenario({ steps });
    const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: { ...s.env, ...waitEnv } }));
    assert.equal(r.status, 'done');
    assert.deepEqual(r.questions, []);
  }
});

test('输入看门狗识别无换行的方括号提示，不把残缺 JSON 当终端提示', async (t) => {
  for (const partialJson of [false, true]) {
    const h = sandbox(t);
    const s = h.scenario({ hold: true, steps: [{ stdout: partialJson
      ? '{"type":"item.completed","item":{"type":"agent_message","text":"Continue? (y/n)'
      : '[y/N]' }] });
    const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--timeout', '0.025']), { env: { ...s.env, ...waitEnv } }), 1);
    assert.equal(r.status, partialJson ? 'timeout' : 'needs_input');
    assert.deepEqual(r.questions, partialJson ? [] : [question('input_prompt', '[y/N]')]);
  }
});

test('watch 分类显示六种问题，status 与组计数将 needs_input 计入交回问题', async (t) => {
  const h = sandbox(t);
  const questions = ['decision_request', 'permission_denied', 'final_question', 'input_prompt', 'asked_mid_run', 'open_question'].map((source) => question(source, `${source} 合成问题`));
  const r = { status: 'done', duration_s: 1, needs_decision: true, questions, report: { ...discussion, open_questions: [questions.at(-1).question] }, errors: [] };
  seedRun(h, 'questions', { group: 'questions', kind: 'discuss' }, r);
  seedRun(h, 'input', { group: 'questions', status: 'needs_input' }, { ...r, status: 'needs_input', errors: [M.inputWaitDetected(3, 'Continue? (y/n)')] });
  const w = await h.bridge(['watch', '--run', 'questions']);
  for (const text of [D.watchDecisions, D.watchDeniedPrefix, D.watchInputPromptPrefix, D.watchAskedMidRun, D.watchOpenIssues, ...questions.map((q) => q.question)]) assert.ok(w.stdout.includes(text), text);
  assert.equal(w.stdout.split(questions.at(-1).question).length - 1, 1);
  assert.ok(w.stdout.includes(`? ${D.statusName('blocked')}`));
  const status = await h.bridge(['status', '--group', 'questions']);
  assert.ok(status.stdout.includes(`? ${D.statusName('needs_input')}`));
  assert.ok(status.stdout.includes(`? ${D.statusName('blocked')}`));
  assert.ok(status.stdout.endsWith(`${D.groupSummary(2, 0, 0, 0, 2)}\n`));
  const group = await h.bridge(['watch', '--group', 'questions']);
  // 组视图标题行右边的计数：交回问题和等人回答都记作 ?
  assert.match(group.stdout.split('\n')[1], / \?2$/, group.stdout);
  assert.ok(!group.stdout.includes('✗'));
  const english = output(await h.start(path.join(ROOT, 'foreman-en/hooks/session-reminder.mjs'), [], { input: JSON.stringify({ cwd: h.cwd }) }).done);
  assert.ok(english.hookSpecificOutput.additionalContext.includes('waiting for an answer, stopped'));
  assert.equal(output(await h.bridge(['cancel', '--run', 'input'])).dismissed, true);
});

for (const [label, broken] of [['像 JSON', '{"position": "你希望先做哪一步？"'], ['长篇分析', `${'分析内容，要不要另说。'.repeat(100)}
结论：先做第一步。`]]) {
  test(`api 最终回答是${label}但只是格式不对时照常修复，不算 final_question`, async (t) => {
    const h = sandbox(t), api = await apiServer(t, [{ answer: broken }, { answer: JSON.stringify(discussion) }]);
    configure(h, { api: apiAgent(api.url) });
    const r = output(await h.bridge(discussArgs(h, 'api')));
    assert.equal(r.status, 'done');
    assert.deepEqual(r.report, discussion);
    assert.equal(api.requests.length, 2);
    assert.ok(!r.questions.some((q) => q.source === 'final_question'));
  });
}
