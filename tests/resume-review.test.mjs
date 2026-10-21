import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plannedSandbox as sandbox, taskArgs, output, failed, json, read, MESSAGES } from './helpers.mjs';
import { discussion, usage, sessionStats } from './fixtures/reports.mjs';
const M = MESSAGES.zh;

test('续接使用上一轮会话并沿用组、范围和 track，用量只算新增', async (t) => {
  const h = sandbox(t), s = h.scenario({ session_id: 'session-resume', calls: [
    { stats: sessionStats, images: ['first.png'] },
    { stats: { ...sessionStats, info: { ...sessionStats.info, total_token_usage: Object.fromEntries(Object.entries(usage).map(([k, v]) => [k, v * 2])) } }, images: ['second.png'] },
  ] });
  const first = output(await h.bridge(taskArgs(h, 'run', ['--group', 'resume-group', '--scope', 'src', '--track', 'ignored.txt', '--no-snapshot']), { env: s.env }));
  const second = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--track', './ignored.txt', '--no-snapshot'], { env: s.env, input: '继续合成任务' }));
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
  assert.equal(json(path.join(second.run_dir, 'meta.json')).parent, first.run_id);
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
