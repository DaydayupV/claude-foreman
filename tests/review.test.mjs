import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plannedSandbox as sandbox, output, failed, read, json, baseConfig, opencodeAgent, ROOT, MESSAGES } from './helpers.mjs';
import { MAX_REVIEW_CHARS } from '../foreman/skills/dispatch/scripts/review-scope.mjs';
const M = MESSAGES.zh;
const configure = (h, agent = 'oc') => {
  const c = baseConfig(); c.agents.codex.sandbox = { review: 'read-only' }; c.agents.oc = opencodeAgent(); c.modules.review.normal = { agent }; h.config(c);
};
const args = (h, extra = []) => ['review', '--cwd', h.cwd, '--level', 'normal', '--no-snapshot', ...extra];

for (const lang of ['zh', 'en']) test(`opencode 审查注入只读 foreman-review，材料和正文落盘（${lang}）`, async (t) => {
  const h = sandbox(t); configure(h); h.initGit();
  const m = MESSAGES[lang], last = 'source.txt:1 这里会重复扣款，为什么没有检查？';
  h.write('source.txt', 'review change\n'); h.write('new.txt', '`````\ncontent\n');
  h.write('binary.bin', Buffer.from([0, 1])); h.write('large.txt', 'x'.repeat(1024 * 1024 + 1));
  const s = h.scenario({ last_message: last, steps: [{ event: { type: 'text', part: { text: 'please confirm context' } } }],
    export_messages: [{ type: 'assistant', tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 4 } }, cost: 0.25 },
      { type: 'assistant', created: 'old', tokens: { input: 1000 }, cost: 1 }, { type: 'assistant' }] }); // 最后一条是出错、没有 tokens 的回复
  const c = output(await h.bridge(['config']));
  assert.equal(c.effective.modules.review.normal[0].agent, 'oc');
  assert.deepEqual(c.agents_status.oc.capabilities.modes, ['review', 'discuss']); // 没写 run_access，不列 run
  const r = output(await h.bridge(args(h, ['--brief', '-']), { env: { ...s.env, FOREMAN_LANG: lang }, input: '重点检查重复扣款' }));
  const calls = s.calls().filter((c) => c.operation === 'run'), call = calls[0];
  assert.equal(calls.length, 2); assert.equal(call.args[call.args.indexOf('--agent') + 1], 'foreman-review');
  assert.equal(call.args[call.args.indexOf('--title') + 1], 'foreman review'); // 不带标题时 opencode 会另发请求起标题
  assert.equal(call.env.PWD, h.cwd);
  const permission = JSON.parse(call.env.OPENCODE_CONFIG_CONTENT).agent['foreman-review'].permission;
  assert.deepEqual(permission, { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  for (const tool of ['shell', 'bash', 'write', 'edit', 'question', 'external_directory']) assert.equal(permission[tool] ?? permission['*'], 'deny');
  const patch = read(path.join(r.run_dir, 'review.patch')), scope = json(path.join(r.run_dir, 'review-scope.json'));
  const fileList = [`- A binary.bin${m.reviewFileBinary}`, `- A large.txt${m.reviewFileTooLarge}`, '- A new.txt', '- M source.txt'].join('\n');
  assert.ok(call.stdin.startsWith(m.opencodeReviewPrompt(h.cwd, m.reviewScopeUncommitted)));
  assert.ok(call.stdin.includes('重点检查重复扣款'));
  assert.ok(call.stdin.includes(m.reviewMaterial(fileList, patch, '``````')));
  assert.ok(call.stdin.endsWith(m.reviewFooter + '\n\n' + m.reviewSchemaFooter(read(path.join(ROOT, 'foreman/skills/dispatch/schemas/review.schema.json'))) + '\n')); assert.ok(patch.includes('+review change'));
  assert.equal(read(path.join(r.run_dir, 'brief.md')), call.stdin);
  assert.equal(scope.patch, undefined); assert.equal(scope.files.length, 4);
  assert.deepEqual(r.review_scope, { kind: 'uncommitted', description: m.reviewScopeUncommitted, base: null,
    merge_base: null, commit: null, files_total: 4, fingerprint: scope.fingerprint });
  assert.equal(r.kind, 'review'); assert.equal(json(path.join(r.run_dir, 'meta.json')).kind, 'review');
  assert.equal(r.report, null); assert.equal(r.last_message, last); assert.equal(read(path.join(r.run_dir, 'last-message.txt')), last);
  assert.deepEqual(r.usage, { input_tokens: 17, cached_input_tokens: 3, cache_write_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 2 }); // 输出含推理
  assert.equal(r.cost_usd, null); assert.equal(r.cost_source, 'unknown'); assert.equal(r.reported_cost_usd, 0.25); assert.equal(r.session_id, 'synthetic-opencode-session');
  assert.deepEqual(r.questions, []); assert.equal(r.needs_decision, false); assert.ok(!r.warnings.includes(m.reviewScopeChanged));
  failed(await h.bridge(['resume', '--run', r.run_id, '--level', 'normal', '--brief', '-']), M.reviewNoResume);
});

test('opencode 审查材料超限时改成给行号照常启动，Codex 没有该上限', async (t) => {
  const h = sandbox(t); configure(h); h.initGit(); h.write('source.txt', 'x'.repeat(MAX_REVIEW_CHARS) + '\n');
  const r = await h.bridge(args(h));
  assert.equal(r.code, 0, r.stderr); assert.ok(h.calls().length >= 1);
  configure(h, 'codex');
  const native = output(await h.bridge(args(h)));
  assert.equal(native.review_scope.files_total, 1); assert.ok(read(path.join(native.run_dir, 'review.patch')).length > MAX_REVIEW_CHARS);
});

test('opencode 非 Git 审查必须有 brief，不附材料且 review_scope 为 null', async (t) => {
  const h = sandbox(t); configure(h);
  failed(await h.bridge(args(h)), M.missingOpt('brief')); assert.equal(h.calls().length, 0);
  const s = h.scenario({ last_message: '未发现问题' });
  const r = output(await h.bridge(args(h, ['--brief', '-']), { env: s.env, input: '审查 source.txt' }));
  assert.equal(r.review_scope, null);
  assert.equal(s.calls()[0].stdin, `${M.reviewPromptPlain(h.cwd)}\n\n审查 source.txt\n\n${M.reviewFooter}\n\n${M.reviewSchemaFooter(read(path.join(ROOT, 'foreman/skills/dispatch/schemas/review.schema.json')))}\n`);
  assert.equal(r.last_message, '未发现问题'); assert.equal(r.report, null);
  assert.equal(fs.existsSync(path.join(r.run_dir, 'review.patch')), false);
});

test('空范围拒绝 Codex 原生、带重点和 opencode 审查，不启动协作方', async (t) => {
  const h = sandbox(t); h.initGit();
  for (const [agent, extra] of [['codex', []], ['codex', ['--brief', '-']], ['oc', []]]) {
    configure(h, agent);
    failed(await h.bridge(args(h, extra)), M.reviewEmpty(M.reviewScopeUncommitted));
  }
  h.git(['commit', '--quiet', '--allow-empty', '-m', 'empty change']);
  const sha = h.git(['rev-parse', 'HEAD']);
  failed(await h.bridge(args(h, ['--base', 'HEAD'])), M.reviewEmpty(M.reviewScopeBase('HEAD', sha)));
  failed(await h.bridge(args(h, ['--commit', 'HEAD'])), M.reviewEmpty(M.reviewScopeCommit(sha)));
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 0);
});

test('审查期间改动变化时 Codex 和 opencode 都保留初始材料并警告', async (t) => {
  for (const agent of ['codex', 'oc']) {
    const h = sandbox(t); configure(h, agent); h.initGit(); h.write('source.txt', 'initial change\n');
    const s = h.scenario({ last_message: '未发现问题', files: { 'source.txt': 'changed while reviewing\n' } });
    const r = output(await h.bridge(args(h), { env: s.env }));
    assert.ok(r.warnings.includes(M.reviewScopeChanged));
    const patch = read(path.join(r.run_dir, 'review.patch'));
    assert.ok(patch.includes('+initial change')); assert.ok(!patch.includes('changed while reviewing'));
    assert.equal(r.review_scope.fingerprint, json(path.join(r.run_dir, 'review-scope.json')).fingerprint);
  }
});

test('opencode 审查仅收集权限拒绝和终端输入提示，正文按 schema 修复一次', async (t) => {
  const h = sandbox(t); configure(h);
  const denied = h.scenario({ last_message: 'please confirm the missing guard?', steps: [
    { event: { type: 'text', part: { text: 'Should this be retried?' } } },
    { event: { type: 'tool_use', part: { tool: 'bash', state: { status: 'error', input: { command: 'git diff' }, error: 'permission denied' } } } },
  ] });
  const r = output(await h.bridge(args(h, ['--brief', '-']), { env: denied.env }));
  assert.deepEqual(r.questions.map((q) => q.source), ['permission_denied']); assert.equal(r.report, null);
  assert.equal(denied.calls().filter((c) => c.operation === 'run').length, 2);
  const input = h.scenario({ hold: true, steps: [{ stderr: 'Continue? (y/n)\n' }] }, 'input');
  const waiting = output(await h.bridge(args(h, ['--brief', '-']), { env: { ...input.env, FOREMAN_TEST_INPUT_WAIT_MIN: '0.005' } }), 1);
  assert.equal(waiting.status, 'needs_input'); assert.deepEqual(waiting.questions.map((q) => q.source), ['input_prompt']);
});

test('opencode 被厂商限流时，结果里提示稍后再试、不要同时给同一个账号派多个任务', async (t) => {
  const h = sandbox(t); configure(h); h.initGit();
  h.write('source.txt', 'review change\n');
  const s = h.scenario({ rate_limited: true });
  const r = output(await h.bridge(args(h, ['--brief', '-']), { env: s.env, input: '重点' }), 1);
  assert.equal(r.status, 'failed');
  assert.ok(r.notes.includes(M.rateLimited('fake/model', 'opencode')));
});
