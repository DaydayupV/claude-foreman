import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { plannedSandbox as sandbox, output, failed, baseConfig, opencodeAgent, piAgent, apiAgent, read, json, write, poll, hostArgs, ROOT, MESSAGES } from './helpers.mjs';
import { review } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const schema = read(path.join(ROOT, 'foreman/skills/dispatch/schemas/review.schema.json'));
const args = (h, extra = []) => ['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-', '--no-snapshot', ...extra];
const planArgs = (h, extra = [], agent = 'codex') => ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'normal', '--group', 'review-group', '--seat', agent, ...extra];
const launch = (p, extra = []) => ['review', '--plan', p.plan_id, '--seat', '1', '--brief', '-', '--no-snapshot', ...extra];
function configure(h, agent = 'codex', api) {
  const c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only', review: 'read-only' };
  c.agents.oc = opencodeAgent(); c.agents.pi = piAgent();
  if (api) c.agents.api = apiAgent(api.url);
  c.modules.review.normal = [{ agent }]; h.config(c); return c;
}
const digest = (v) => createHash('sha256').update(v).digest('hex');

test('四种审查对象的参数错误在登记和调用前拒绝', async (t) => {
  const h = sandbox(t); configure(h); h.write('source.txt', 'evidence\n'); h.write('shot.PNG', Buffer.from([0, 1]));
  const cases = [
    [['--target', 'wrong'], M.reviewTargetChoices(M.list(['diff', 'files', 'claims', 'visual']))],
    ...['files', 'claims', 'visual'].flatMap((target) => [
      [['--target', target], M.reviewTargetNeedsFile(target)],
      ...[['--uncommitted'], ['--base', 'HEAD'], ['--commit', 'HEAD']].map((scope) => [
        ['--target', target, '--file', target === 'visual' ? 'shot.PNG' : 'source.txt', ...scope], M.reviewScopeDiffOnly]),
    ]),
    ...['source.txt', 'shot.PNG:1-2', 'missing.png', '.'].map((file) => [
      ['--target', 'visual', '--file', file], M.reviewVisualNotImage(file)]),
    [['--target', 'files', '--file', 'missing.txt'], M.fileNotFound(path.join(h.cwd, 'missing.txt'))],
    [['--target', 'claims', '--file', 'shot.PNG'], M.fileBinary(path.join(h.cwd, 'shot.PNG'))],
  ];
  for (const [extra, message] of cases) failed(await h.bridge(args(h, extra)), message);
  for (const target of ['files', 'claims', 'visual']) {
    const material = ['--target', target, '--file', target === 'visual' ? 'shot.PNG' : 'source.txt'];
    failed(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', ...material]), M.missingOpt('brief'));
    failed(await h.bridge(args(h, material), { input: '  ' }), M.emptyBrief);
  }
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0); assert.equal(h.calls().length, 0);
});

for (const target of ['files', 'claims']) for (const git of [true, false]) test(`${target} 审查能读${git ? '干净仓库' : '非 Git 目录'}，范围和整文件指纹正确`, async (t) => {
  const h = sandbox(t); configure(h);
  if (git) h.initGit(); else h.write('source.txt', 'before\n');
  const r = output(await h.bridge(args(h, ['--target', target, '--file', 'source.txt:1-1'])));
  const fingerprint = digest(JSON.stringify([['source.txt', [1, 1], digest(read(path.join(h.cwd, 'source.txt')))]]));
  assert.equal(r.review_target, target); assert.equal(r.stale, false); assert.deepEqual(r.report, review);
  assert.deepEqual(r.review_scope, { kind: target, description: M.reviewScopeTarget[target](1), base: null,
    merge_base: null, commit: null, files_total: 1, fingerprint });
  const scope = json(path.join(r.run_dir, 'review-scope.json'));
  assert.deepEqual(scope.files, [{ path: 'source.txt', range: [1, 1] }]); assert.equal(scope.patch, undefined);
  assert.equal(fs.existsSync(path.join(r.run_dir, 'review.patch')), false);
  assert.equal(json(path.join(r.run_dir, 'meta.json')).review_target, target);
  assert.ok(h.calls()[0].stdin.includes(M.focusFiles('- source.txt（第 1–1 行）')));
  assert.ok(h.calls()[0].stdin.includes(target === 'files' ? M.reviewPromptFiles(h.cwd) : M.reviewPromptClaims(h.cwd)));
});

test('文件指纹保留附件顺序和行范围，选定行之外的变化也使指纹改变', async (t) => {
  const h = sandbox(t); configure(h); h.write('a.txt', 'one\ntwo\n'); h.write('b.txt', 'three\n');
  const run = async (files) => output(await h.bridge(args(h, ['--target', 'files', ...files.flatMap((f) => ['--file', f])]))).review_scope.fingerprint;
  const first = await run(['a.txt:1-1', 'b.txt']);
  assert.notEqual(first, await run(['b.txt', 'a.txt:1-1']));
  assert.notEqual(first, await run(['a.txt:1-2', 'b.txt']));
  h.write('a.txt', 'one\nchanged\n'); assert.notEqual(first, await run(['a.txt:1-1', 'b.txt']));
});

for (const agent of ['codex', 'oc', 'pi']) test(`${agent} 的 diff 审查列出重点文件并返回结构化报告`, async (t) => {
  const h = sandbox(t); configure(h, agent); h.initGit(); h.write('source.txt', 'changed\n');
  const r = output(await h.bridge(args(h, ['--file', 'source.txt'])));
  const call = h.calls().find((c) => ['run', 'exec'].includes(c.operation));
  assert.ok(call.stdin.includes(M.focusFiles('- source.txt'))); assert.ok(call.stdin.includes(M.reviewFooter));
  assert.deepEqual(r.report, review); assert.equal(r.last_message, undefined); assert.equal(r.stale, false);
  assert.equal(r.review_target, 'diff'); assert.equal(r.readonly, agent === 'codex' ? 'sandbox' : 'tools');
  if (agent === 'codex') {
    assert.ok(!call.args.includes('review'));
    assert.ok(call.args[call.args.indexOf('--output-schema') + 1].endsWith('review.schema.json'));
  } else assert.ok(call.stdin.endsWith(M.reviewSchemaFooter(schema) + '\n'));
});

test('Codex 只有无说明且无附件的 git diff 使用原生审查', async (t) => {
  const h = sandbox(t); configure(h); h.initGit(); h.write('source.txt', 'change\n');
  const base = ['review', '--cwd', h.cwd, '--level', 'normal', '--no-snapshot'];
  const plain = output(await h.bridge(base));
  assert.deepEqual(h.calls()[0].args.slice(0, 2), ['exec', 'review']); assert.equal(plain.report, null);
  assert.ok(!h.calls()[0].args.includes('--output-schema'));
  output(await h.bridge([...base, '--file', 'source.txt']));
  assert.ok(h.calls()[1].args.includes('--output-schema')); assert.ok(!h.calls()[1].args.includes('review'));
  const bad = h.scenario({ last_message: '{"verdict":"no_issues"}' });
  const r = output(await h.bridge(args(h), { env: bad.env }));
  assert.equal(r.report, null); assert.equal(r.last_message, '{"verdict":"no_issues"}'); assert.ok(r.warnings.includes(M.badReport));
});

for (const agent of ['oc', 'pi', 'api']) for (const valid of [true, false]) test(`${agent} 审查报告修复一次，${valid ? '成功解析' : '不合格保留原文并警告'}`, async (t) => {
  const h = sandbox(t), api = agent === 'api' ? await apiServer(t, [{ answer: {} }, { answer: valid ? review : {} }]) : null;
  configure(h, agent, api); h.write('source.txt', 'evidence\n');
  const s = h.scenario({ calls: [{ last_message: {} }, { last_message: valid ? review : {} }] });
  const r = output(await h.bridge(args(h, ['--target', 'claims', '--file', 'source.txt']), { env: s.env }));
  const calls = api ? api.requests : s.calls().filter((c) => c.operation === 'run'); assert.equal(calls.length, 2);
  assert.equal(r.readonly, 'tools'); assert.deepEqual(r.questions, []);
  if (valid) { assert.deepEqual(r.report, review); assert.equal(r.last_message, undefined); }
  else {
    assert.equal(r.report, null); assert.equal(r.last_message, '{}');
    assert.ok(r.warnings.includes(M.reportInvalid(agent, path.join(r.run_dir, 'last-message.txt'))));
  }
  if (agent === 'oc') {
    assert.equal(calls[1].args[calls[1].args.indexOf('--agent') + 1], 'foreman-review');
    assert.deepEqual(JSON.parse(calls[1].env.OPENCODE_CONFIG_CONTENT).agent['foreman-review'].permission,
      { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  }
  if (agent === 'pi') assert.ok(calls[1].args.includes('--no-tools'));
});

for (const target of ['diff', 'files', 'claims']) test(`API ${target} 审查的配置、材料、系统提示和任务类型正确，不能续接`, async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: review }]); configure(h, 'api', api);
  if (target === 'diff') { h.initGit(); h.write('source.txt', 'change\n'); } else h.write('source.txt', 'evidence\n');
  const r = output(await h.bridge(args(h, ['--target', target, '--file', 'source.txt'])));
  const [system, user] = api.requests[0].body.messages;
  assert.equal(system.content, M.apiReviewSystem(schema)); assert.ok(user.content.startsWith(M.apiReviewPrompt[target](r.review_scope.description)));
  assert.ok(user.content.includes('1\t' + (target === 'diff' ? 'change' : 'evidence')));
  assert.equal(user.content.includes('diff --git'), target === 'diff');
  assert.equal(r.kind, 'review'); assert.equal(json(path.join(r.run_dir, 'meta.json')).kind, 'review');
  assert.equal(r.review_target, target); assert.deepEqual(r.report, review); assert.equal(r.readonly, 'tools');
  assert.equal(r.files[0].path, path.join(h.cwd, 'source.txt')); assert.equal(r.changes.note, M.apiNoChanges);
  failed(await h.bridge(['resume', '--run', r.run_id, '--brief', '-']), M.reviewNoResume);
});

test('API 非 Git 的 diff 沿用普通开头，材料超限在登记和请求前拒绝', async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: review }]); configure(h, 'api', api); h.write('source.txt', 'evidence\n');
  const r = output(await h.bridge(args(h, ['--file', 'source.txt'])));
  assert.equal(r.review_scope, null); assert.equal(r.stale, null);
  assert.ok(api.requests[0].body.messages[1].content.startsWith(M.reviewPromptPlain(h.cwd)));
  h.initGit(); h.write('source.txt', 'x'.repeat(300000));
  for (const target of ['diff', 'files', 'claims']) {
    const rejected = await h.bridge(args(h, ['--target', target, '--file', 'source.txt']));
    assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
    // diff 的材料在建计划时就按这一席的预算检查（单席 review 也走计划），files、claims 在启动时按整份材料检查
    assert.ok(rejected.stderr.includes(target === 'diff' ? '要审查的改动去掉生成文件后放不下这几席' : '材料共'), rejected.stderr);
  }
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 1); assert.equal(api.requests.length, 1);
});

for (const agent of ['oc', 'pi', 'api']) test(`visual 在单席、格外点名、计划和席位启动都拒绝 ${agent}`, async (t) => {
  const h = sandbox(t), api = await apiServer(t); const c = configure(h, agent, api); h.write('shot.PNG', Buffer.from([0, 1]));
  const material = ['--target', 'visual', '--file', 'shot.PNG'], message = M.readsImagesRequired(agent, c.agents[agent].type);
  failed(await h.bridge(args(h, material)), message); failed(await h.bridge(planArgs(h, material, agent)), message);
  c.modules.review.normal = 'claude code'; h.config(c);
  failed(await h.bridge(args(h, [...material, '--agent', agent])), message);
  configure(h); const p = output(await h.bridge(planArgs(h, material)));
  const plan = json(p.file); plan.seats[0] = { ...plan.seats[0], agent, model: c.agents[agent].model, effort: null };
  write(p.file, plan); c.modules.review.normal = [{ agent }]; h.config(c);
  failed(await h.bridge(launch(p)), message);
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0); assert.equal(h.calls().length, 0); assert.equal(api.requests.length, 0);
});

test('Codex visual 审查逐图提示，图片路径和能力可见，不把图片当文本', async (t) => {
  const h = sandbox(t); configure(h); h.write('shot.PNG', Buffer.from([0, 1]));
  const r = output(await h.bridge(args(h, ['--target', 'visual', '--file', 'shot.PNG'])));
  assert.ok(h.calls()[0].stdin.includes(M.reviewPromptVisual(h.cwd))); assert.ok(h.calls()[0].stdin.includes('- shot.PNG'));
  assert.equal(r.review_target, 'visual'); assert.equal(r.review_scope.kind, 'visual'); assert.equal(r.review_scope.files_total, 1);
  assert.equal(output(await h.bridge(['config'])).agents_status.codex.capabilities.reads_images, true);
});

test('审查计划固定材料和指纹，其他模块不能指定材料，空 diff 不写计划', async (t) => {
  const h = sandbox(t); configure(h); h.write('source.txt', 'evidence\n');
  for (const module of ['run', 'discuss']) for (const extra of [['--target', 'files'], ['--file', 'source.txt'], ['--uncommitted'], ['--base', 'HEAD'], ['--commit', 'HEAD']]) {
    failed(await h.bridge(planArgs(h, ['--module', module, ...extra])), M.planReviewOnly);
  }
  assert.equal(fs.existsSync(path.join(h.runs, 'plans')), false);
  const p = output(await h.bridge(planArgs(h, ['--target', 'files', '--file', 'source.txt:1-1'])));
  assert.deepEqual(p.review, { target: 'files', file: ['source.txt:1-1'], uncommitted: false, base: null, commit: null,
    fingerprint: digest(JSON.stringify([['source.txt', [1, 1], digest('evidence\n')]])) });
  assert.deepEqual(json(p.file).review, p.review); assert.ok(!p.commands[0].includes('--target')); assert.equal(h.records().length, 0);
  h.initGit(); const count = fs.readdirSync(path.dirname(p.file)).length;
  failed(await h.bridge(planArgs(h)), M.reviewEmpty(M.reviewScopeUncommitted));
  assert.equal(fs.readdirSync(path.dirname(p.file)).length, count);
});

test('席位启动拒绝材料覆盖和变化，原材料可启动，旧计划兼容 diff', async (t) => {
  const h = sandbox(t); configure(h); h.write('source.txt', 'original\n');
  const p = output(await h.bridge(planArgs(h, ['--target', 'files', '--file', 'source.txt'])));
  for (const flags of [['--target', 'diff'], ['--file', 'source.txt'], ['--uncommitted'], ['--base', 'HEAD'], ['--commit', 'HEAD']]) {
    failed(await h.bridge(launch(p, flags)), M.planMaterialFlags(p.plan_id));
  }
  h.write('source.txt', 'changed\n'); failed(await h.bridge(launch(p)), M.planMaterialChanged(p.plan_id));
  fs.unlinkSync(path.join(h.cwd, 'source.txt')); failed(await h.bridge(launch(p)), M.planMaterialChanged(p.plan_id));
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0); assert.equal(h.calls().length, 0);
  h.write('source.txt', 'original\n'); const r = output(await h.bridge(launch(p)));
  assert.equal(r.review_scope.fingerprint, p.review.fingerprint); assert.equal(r.stale, false);
  h.initGit(); h.write('source.txt', 'diff material\n');
  const old = output(await h.bridge(planArgs(h))); const saved = json(old.file); delete saved.review; delete saved.host; write(old.file, saved);
  const legacy = output(await h.bridge(launch(old))); assert.equal(legacy.review_target, 'diff'); assert.equal(legacy.stale, false);
});

test('Windows 上计划目录比较忽略路径大小写', { skip: process.platform !== 'win32' }, async (t) => {
  const h = sandbox(t); configure(h); h.write('source.txt', 'evidence\n');
  const p = output(await h.bridge(planArgs(h, ['--target', 'files', '--file', 'source.txt'])));
  const r = output(await h.bridge(launch(p, ['--cwd', h.cwd.toUpperCase()])));
  assert.equal(r.review_scope.fingerprint, p.review.fingerprint); assert.equal(r.stale, false);
});

test('diff 计划拒绝附件变化，审查结束时也复核补丁之外的附件', async (t) => {
  const h = sandbox(t); configure(h); h.initGit(); h.write('source.txt', 'change\n');
  const attachment = write(path.join(h.home, 'evidence.txt'), 'first\noriginal\n');
  const p = output(await h.bridge(planArgs(h, ['--file', '../evidence.txt:1-1'])));
  write(attachment, 'first\nchanged\n');
  failed(await h.bridge(launch(p)), M.planMaterialChanged(p.plan_id));
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0); assert.equal(h.calls().length, 0);
  write(attachment, 'first\noriginal\n');
  const gate = path.join(h.home, 'release'), s = h.scenario({ steps: [{ wait_for: gate }] });
  const running = h.startBridge(launch(p), { env: s.env }); await poll(() => s.calls().length, '审查开始');
  write(attachment, 'first\nchanged\n'); write(gate, 'go');
  const r = output(await running.done);
  assert.equal(r.stale, true); assert.ok(r.warnings.includes(M.reviewScopeChanged)); assert.deepEqual(r.report, review);
});

for (const scope of ['uncommitted', 'base', 'commit']) test(`diff 计划保存 ${scope} 参数并用同一份材料启动`, async (t) => {
  const h = sandbox(t); configure(h); const sha = h.initGit(); h.write('source.txt', 'change\n');
  const flags = scope === 'uncommitted' ? ['--uncommitted'] : [`--${scope}`, scope === 'base' ? 'HEAD' : sha];
  const p = output(await h.bridge(planArgs(h, flags)));
  assert.equal(p.review.target, 'diff'); assert.equal(p.review.uncommitted, scope === 'uncommitted');
  assert.equal(p.review.base, scope === 'base' ? 'HEAD' : null); assert.equal(p.review.commit, scope === 'commit' ? sha : null);
  assert.match(p.review.fingerprint, /^[a-f0-9]{64}$/);
  const r = output(await h.bridge(launch(p)));
  assert.equal(r.review_scope.fingerprint, p.review.fingerprint); assert.equal(r.review_scope.kind, scope); assert.equal(r.stale, false);
});

test('diff 计划的改动被撤回后拒绝席位，非 Git 计划没有指纹', async (t) => {
  const h = sandbox(t); configure(h);
  const plain = output(await h.bridge(planArgs(h))); assert.equal(plain.review.fingerprint, null);
  const r = output(await h.bridge(launch(plain))); assert.equal(r.stale, null);
  h.initGit(); h.write('source.txt', 'change\n'); const p = output(await h.bridge(planArgs(h)));
  h.write('source.txt', 'before\n'); failed(await h.bridge(launch(p)), M.planMaterialChanged(p.plan_id));
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 1); assert.equal(h.calls().length, 1);
});

// opencode、pi 能自己读文件：补丁超过上限时不再拒绝，放不下的文件改成给行号（细节见 review-material.test.mjs）
for (const agent of ['oc', 'pi']) test(`${agent} 的 diff 补丁超限时照常启动，改成给行号`, async (t) => {
  const h = sandbox(t); configure(h, agent); h.initGit(); h.write('source.txt', 'x'.repeat(200001));
  const r = await h.bridge(args(h)); assert.equal(r.code, 0, r.stderr);
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 1); assert.ok(h.calls().length >= 1);
});

for (const change of ['修改', '删除', 'Git 错误']) test(`审查结束时${change}材料不会丢失结果，stale 和原始错误如实记录`, async (t) => {
  const h = sandbox(t); configure(h); h.initGit(); h.write('source.txt', 'original\n');
  const target = change === 'Git 错误' ? 'diff' : 'files';
  const p = output(await h.bridge(planArgs(h, ['--target', target, '--file', 'source.txt'])));
  const gate = path.join(h.home, 'release'); const s = h.scenario({ steps: [{ wait_for: gate }] });
  const running = h.startBridge(launch(p), { env: s.env }); await poll(() => s.calls().length, '审查开始');
  if (change === '修改') h.write('source.txt', 'changed\n');
  else if (change === '删除') fs.unlinkSync(path.join(h.cwd, 'source.txt'));
  else write(path.join(h.cwd, '.git/index'), Buffer.from([0]));
  write(gate, 'go'); const r = output(await running.done);
  assert.equal(r.stale, true); assert.ok(r.warnings.includes(M.reviewScopeChanged)); assert.deepEqual(r.report, review);
  if (change === '删除') assert.ok(r.warnings.some((w) => w.includes('ENOENT')));
  if (change === 'Git 错误') assert.ok(r.warnings.some((w) => w.includes('index file smaller than expected')));
  assert.equal(json(path.join(r.run_dir, 'result.json')).stale, true);
});

test('Codex 审查忽略中途和最终提问，格式不合格仍保留原文', async (t) => {
  const h = sandbox(t); configure(h); h.write('source.txt', 'evidence\n');
  const s = h.scenario({ last_message: 'Should I continue?', steps: [
    { event: { type: 'item.completed', item: { type: 'agent_message', text: 'Please confirm scope?' } } },
    { event: { type: 'item.completed', item: { type: 'command_execution', command: 'read', exit_code: 1, aggregated_output: 'permission denied' } } },
  ] });
  const r = output(await h.bridge(args(h, ['--target', 'files', '--file', 'source.txt']), { env: s.env }));
  assert.ok(!r.questions.some((q) => ['asked_mid_run', 'final_question'].includes(q.source)));
  assert.equal(r.last_message, 'Should I continue?'); assert.ok(r.warnings.includes(M.badReport));
});

test('项目目录外的审查文件：有 opencode 席时建计划就拒绝，只有 Codex 时照常；opencode 讨论带外部文件也拒绝', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.oc = opencodeAgent();
  c.modules.review.normal = [{ agent: 'codex' }, { agent: 'oc' }]; c.modules.discuss.normal = [{ agent: 'oc' }]; h.config(c);
  const outside = write(path.join(h.home, 'outside', 'notes.patch'), 'diff\n'), inside = h.write('notes.md', '材料\n');
  const plan = (seats, file) => ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'normal', '--group', 'outside', '--target', 'files', '--file', file,
    ...seats.flatMap((seat) => ['--seat', seat]), '--count-why', '测试'];
  failed(await h.bridge(plan(['codex', 'oc'], outside)), MESSAGES.zh.planFilesOutsideCwd('oc', outside));
  output(await h.bridge(plan(['codex'], outside)));
  output(await h.bridge(plan(['codex', 'oc'], inside)));
  const d = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'discuss', '--cell', 'normal', '--group', 'outside-d', '--seat', 'oc']));
  output(await h.bridge(hostArgs(h, d)));
  failed(await h.bridge(['discuss', '--plan', d.plan_id, '--seat', '1', '--brief', '-', '--file', outside]), MESSAGES.zh.filesOutsideCwd('oc', outside, false));
});
