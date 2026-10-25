import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plannedSandbox as sandbox, taskArgs, output, failed, json, read, MESSAGES } from './helpers.mjs';
import { discussion, usage, sessionStats } from './fixtures/reports.mjs';
const M = MESSAGES.zh;

test('续接使用上一轮会话并沿用组、范围和 track，用量只算新增', async (t) => {
  const h = sandbox(t), s = h.scenario({ session_id: 'session-resume', calls: [
    { stats: sessionStats, images: ['first.png'], rollout_prompt: true },
    { stats: { ...sessionStats, info: { ...sessionStats.info, total_token_usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v * 2])) } }, images: ['second.png'] },
  ] });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--group', 'resume-group', '--scope', 'src', '--track', 'ignored.txt', '--no-snapshot']), { env: s.env }));
  const second = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--reason', 'rework', '--track', './ignored.txt', '--no-snapshot'], { env: s.env, input: '继续合成任务' }));
  assert.equal(second.mode, 'resume');
  assert.equal(second.parent, first.run_id);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.group, 'resume-group');
  assert.deepEqual(second.scope, ['src']);
  assert.deepEqual(second.track, ['ignored.txt']);
  assert.deepEqual(second.usage, usage);
  assert.equal(second.usage_scope, 'this_run');
  assert.deepEqual(second.generated_images, [path.join(h.env.CODEX_HOME, 'generated_images/session-resume/second.png')]);
  const call = s.calls()[1];
  assert.deepEqual(call.args.slice(0, 2), ['exec', 'resume']);
  assert.deepEqual(call.args.slice(-2), ['session-resume', '-']);
  assert.equal(call.cwd, h.cwd);
  assert.ok(call.stdin.includes(M.resumeFooter));
  assert.ok(!call.stdin.includes('合成测试任务')); // 上一轮有用量：协作方的会话里有原来的说明，不再补发
  assert.ok(!second.notes.includes(M.resumeUnsentNote));
  assert.equal(json(path.join(second.run_dir, 'meta.json')).parent, first.run_id);
});

test('上一轮的说明没进 Codex 的会话（刚派出就停了）：续接把当时发出的说明补在新说明前面；连着几轮没进也只补一份，进了就不补', async (t) => {
  const meta = { type: 'session_meta', payload: { id: 'session-unsent' } };
  const h = sandbox(t), s = h.scenario({ session_id: 'session-unsent', calls: [{ rollout: [meta] }, { rollout: [meta] }, { rollout_prompt: true }, {}] });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  const resume = (run, input) => h.bridge(['resume', '--run', run, '--brief', '-', '--level', 'complex', '--reason', 'recover', '--no-snapshot'], { env: s.env, input });
  const count = (text, word) => text.split(word).length - 1;
  const second = output(await resume(first.run_id, '第二轮说明'));
  const call = s.calls()[1].stdin;
  assert.ok(call.startsWith('（调度方提示：上一轮在你收到任务说明之前就停了'));
  assert.ok(call.indexOf('合成测试任务') < call.indexOf('## 这次续接的说明') && call.indexOf('## 这次续接的说明') < call.indexOf('第二轮说明'));
  assert.ok(call.includes('## 固定约束（调度方自动附加）'));
  assert.ok(second.notes.includes(M.resumeUnsentNote));
  // 第二轮也没进会话：第三轮补发第二轮发出的那份（里面已经含第一轮），原说明只出现一次
  const third = output(await resume(second.run_id, '第三轮说明'));
  const again = s.calls()[2].stdin;
  assert.equal(count(again, '合成测试任务'), 1); assert.equal(count(again, '第二轮说明'), 1);
  assert.ok(again.indexOf('第二轮说明') < again.lastIndexOf('第三轮说明'));
  // 第三轮进了会话：第四轮不补发
  const fourth = output(await resume(third.run_id, '第四轮说明'));
  const last = s.calls()[3].stdin;
  assert.ok(!last.includes('调度方提示：上一轮在你收到任务说明之前就停了') && !last.includes('第三轮说明'));
  assert.ok(!fourth.notes.includes(M.resumeUnsentNote));
});

test('讨论续接到轮数上限后拒绝再开一轮', async (t) => {
  const h = sandbox(t), s = h.scenario({ last_message: discussion });
  const first = output(await h.bridge(taskArgs(h, 'discuss', []), { env: s.env }));
  const args = (id) => ['resume', '--run', id, '--brief', '-', '--level', 'complex'];
  const second = output(await h.bridge(args(first.run_id), { env: s.env }));
  assert.equal(first.round, 1);
  assert.equal(second.round, 2);
  assert.equal(second.kind, 'discuss');
  failed(await h.bridge(args(second.run_id), { env: s.env }), M.discussRoundsExceeded(first.run_id, 2, 2));
  assert.equal(s.calls().length, 2);
});

for (const scope of ['uncommitted', 'base', 'commit']) {
  test(`没有审查重点时使用原生 exec review --${scope}`, async (t) => {
    const h = sandbox(t), sha = h.initGit(), s = h.scenario({ last_message: '合成审查通过' });
    h.write('source.txt', 'working change\n');
    const value = scope === 'commit' ? sha : 'HEAD';
    const range = scope === 'uncommitted' ? ['--uncommitted'] : [`--${scope}`, value];
    const r = output(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal', '--title', '合成审查', ...range], { env: s.env }));
    const call = s.calls()[0];
    assert.deepEqual(call.args.slice(0, 2), ['exec', 'review']);
    assert.ok(call.args.includes(`--${scope}`));
    if (scope !== 'uncommitted') assert.equal(call.args[call.args.indexOf(`--${scope}`) + 1], value);
    assert.equal(call.stdin, '');
    assert.equal(call.cwd, h.cwd);
    assert.equal(r.kind, 'review');
    assert.equal(r.report, null);
    assert.equal(r.last_message, '合成审查通过');
    const recorded = json(path.join(r.run_dir, 'review-scope.json'));
    assert.equal(recorded.kind, scope);
    assert.equal(recorded.patch, undefined);
    assert.equal(r.review_scope.fingerprint, recorded.fingerprint);
    assert.equal(r.review_scope.files_total, recorded.files.length);
    assert.ok(read(path.join(r.run_dir, 'review.patch')).includes(scope === 'commit' ? '+before' : '+working change'));
  });
}

for (const scope of ['uncommitted', 'base', 'commit']) {
  test(`有审查重点时普通 exec 提示词包含 ${scope} 范围`, async (t) => {
    const h = sandbox(t), sha = h.initGit();
    h.write('source.txt', 'working change\n');
    const range = scope === 'uncommitted' ? [] : [`--${scope}`, scope === 'commit' ? sha.slice(0, 8) : 'HEAD'];
    const r = output(await h.bridge(taskArgs(h, 'review', [...range]), { input: '检查边界条件' }));
    const call = h.calls()[0];
    assert.equal(call.args[0], 'exec');
    assert.ok(!call.args.includes('review'));
    const expectedScope = scope === 'uncommitted' ? M.reviewScopeUncommitted : scope === 'base' ? M.reviewScopeBase('HEAD', sha) : M.reviewScopeCommit(sha);
    assert.ok(call.stdin.includes(M.reviewPromptGit(h.cwd, expectedScope)));
    assert.ok(call.stdin.includes('检查边界条件'));
    assert.ok(call.stdin.includes(M.reviewFooter));
    assert.equal(r.review_scope.description, expectedScope);
    assert.equal(r.review_scope.fingerprint, json(path.join(r.run_dir, 'review-scope.json')).fingerprint);
    assert.ok(read(path.join(r.run_dir, 'review.patch')).includes('diff --git'));
  });
}

test('非 Git 目录审查要求说明并使用普通 exec', async (t) => {
  const h = sandbox(t);
  failed(await h.bridge(['review', '--cwd', h.cwd, '--level', 'normal']), M.missingOpt('brief'));
  const r = output(await h.bridge(taskArgs(h, 'review', []), { input: '检查 source.txt' }));
  assert.equal(r.review_scope, null);
  const call = h.calls()[0];
  assert.ok(!call.args.includes('review'));
  assert.ok(call.stdin.includes(M.reviewPromptPlain(h.cwd)));
  assert.ok(call.stdin.includes('检查 source.txt'));
});
