import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, baseConfig, opencodeAgent, piAgent, apiAgent, taskArgs, read, json, write, poll, seedRun, MESSAGES } from './helpers.mjs';
import { discussion, review, report } from './fixtures/reports.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;

for (const agent of ['oc', 'pi', 'api']) for (const kind of ['discuss', 'review']) test(`${agent} 的${M.modeNames[kind]}只读等级为 tools`, async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: kind === 'review' ? review : discussion }]), c = baseConfig();
  Object.assign(c.agents, { oc: opencodeAgent(), pi: piAgent(), api: apiAgent(api.url) }); c.modules[kind].complex = [{ agent }]; h.config(c);
  h.write('source.txt', 'evidence\n'); const s = h.scenario({ last_message: kind === 'review' ? review : discussion });
  const r = output(await h.bridge(taskArgs(h, kind, kind === 'review' ? ['--target', 'files', '--file', 'source.txt'] : []), { env: s.env }));
  assert.equal(r.readonly, 'tools'); assert.equal(r.changes.available, false);
});

for (const kind of ['discuss', 'review']) for (const source of ['foreman', 'config.toml', 'workspace-write', 'danger-full-access', '未配置']) test(`Codex ${M.modeNames[kind]}的只读等级按 ${source} 判断`, async (t) => {
  const h = sandbox(t), c = baseConfig(), isSandbox = ['foreman', 'config.toml'].includes(source);
  if (source === 'foreman') { c.agents.codex.sandbox = { [kind]: 'read-only' }; write(path.join(h.env.CODEX_HOME, 'config.toml'), 'sandbox_mode = "danger-full-access"\n'); }
  else if (source === 'config.toml') write(path.join(h.env.CODEX_HOME, 'config.toml'), 'sandbox_mode = "read-only"\n');
  else if (source !== '未配置') c.agents.codex.sandbox = { [kind]: source };
  h.config(c); const s = h.scenario({ last_message: kind === 'review' ? review : discussion });
  const r = output(await h.bridge(taskArgs(h, kind, isSandbox ? ['--no-snapshot'] : []), { env: s.env }));
  assert.equal(r.readonly, isSandbox ? 'sandbox' : 'audited');
  if (kind === 'discuss') {
    const next = output(await h.bridge(['resume', '--run', r.run_id, '--level', 'complex', '--brief', '-', ...(isSandbox ? ['--no-snapshot'] : [])], { env: s.env }));
    assert.equal(next.readonly, r.readonly);
  }
});

for (const kind of ['discuss', 'review']) test(`audited ${M.modeNames[kind]}拒绝禁用快照，拍照失败不启动`, async (t) => {
  const h = sandbox(t);
  failed(await h.bridge(taskArgs(h, kind, ['--no-snapshot'])), M.auditedNoSnapshot(kind));
  assert.equal(h.records().length, 0); assert.equal(h.calls().length, 0);
  const r = output(await h.bridge(taskArgs(h, kind), { env: { PATH: h.home } }), 1);
  assert.equal(r.status, 'failed'); assert.equal(r.readonly, 'audited'); assert.equal(r.session_id, null);
  assert.equal(h.calls().length, 0); assert.equal(json(path.join(r.run_dir, 'meta.json')).status, 'failed');
  assert.ok(r.errors.some((e) => e.includes('拍不了快照就发现不了写入，所以没有开始')));
});

for (const kind of ['discuss', 'review']) for (const evidence of ['agent', 'reported']) test(`Codex ${M.modeNames[kind]}有 ${evidence} 写入证据就失败并保留意见`, async (t) => {
  const h = sandbox(t); h.write('source.txt', 'before\n');
  const last = evidence === 'reported' ? { ...report, files_changed: [{ path: 'source.txt', change: 'changed' }] } : kind === 'review' ? review : discussion;
  const s = h.scenario({ last_message: last, files: { 'source.txt': 'written\n' }, steps: evidence === 'agent' ? [
    { event: { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'source.txt', kind: 'update' }] } } },
  ] : [] });
  const r = output(await h.bridge(taskArgs(h, kind), { env: s.env }), 1);
  assert.equal(r.status, 'failed'); assert.equal(r.exit_code, 1); assert.equal(r.readonly, 'audited');
  assert.deepEqual(r.readonly_violation, [{ path: 'source.txt', by: evidence }]); assert.ok(r.errors.includes(M.readonlyViolated(kind, 1)));
  assert.equal(r.changes.files[0].by, evidence); assert.ok(read(path.join(r.run_dir, 'diff.patch')).includes('+written'));
  assert.equal(read(path.join(h.cwd, 'source.txt')), 'written\n');
  assert.ok(evidence === 'reported' ? r.last_message.includes('files_changed') : r.report);
  assert.equal(json(path.join(r.run_dir, 'meta.json')).status, 'failed');
});

test('sandbox 级别也检查写入证据，禁用快照时仍记录工具作证的违规', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only' }; h.config(c);
  const s = h.scenario({ last_message: discussion, files: { 'source.txt': 'written\n' }, steps: [
    { event: { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'source.txt', kind: 'add' }] } } },
  ] });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--no-snapshot']), { env: s.env }), 1);
  assert.equal(r.readonly, 'sandbox'); assert.deepEqual(r.readonly_violation, [{ path: 'source.txt', by: 'agent' }]); assert.deepEqual(r.report, discussion);
});

test('只读任务的报告把工作目录本身（./）写进 files_changed 不算违规，没有快照时也一样；具体的文件照样算', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only' }; h.config(c);
  const root = { path: './', change: '整个目录' };
  const s = h.scenario({ last_message: { ...discussion, files_changed: [root] } });
  const r = output(await h.bridge(taskArgs(h, 'discuss', ['--no-snapshot']), { env: s.env }));
  assert.equal(r.status, 'done'); assert.deepEqual(r.readonly_violation, []);
  const named = h.scenario({ last_message: { ...discussion, files_changed: [root, { path: 'notes.md', change: '笔记' }] } }, 'named');
  const bad = output(await h.bridge(taskArgs(h, 'discuss', ['--no-snapshot']), { env: named.env }), 1);
  assert.equal(bad.status, 'failed'); assert.deepEqual(bad.readonly_violation, [{ path: 'notes.md', by: 'reported' }]);
});

test('沙箱挡下的写入（file_change 状态为 failed）不算违规，有没有快照都一样', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.codex.sandbox = { discuss: 'read-only' }; h.config(c);
  const change = (type, status) => ({ event: { type, item: { type: 'file_change', changes: [{ path: 'source.txt', kind: 'update' }], status } } });
  const s = h.scenario({ last_message: discussion, steps: [change('item.started', 'in_progress'), change('item.completed', 'failed')] });
  for (const extra of [[], ['--no-snapshot']]) {
    const r = output(await h.bridge(taskArgs(h, 'discuss', extra), { env: s.env }));
    assert.equal(r.status, 'done'); assert.deepEqual(r.readonly_violation, []); assert.deepEqual(r.errors, []);
  }
});

test('只有 unknown 的外部改动不算违规，审查材料变化照样标 stale', async (t) => {
  const h = sandbox(t); h.write('source.txt', 'before\n'); const gate = path.join(h.home, 'release');
  const s = h.scenario({ last_message: review, steps: [{ wait_for: gate }] });
  const running = h.startBridge(taskArgs(h, 'review', ['--target', 'files', '--file', 'source.txt']), { env: s.env });
  await poll(() => s.calls().length, '审查开始'); h.write('source.txt', 'external\n'); write(gate, 'go');
  const r = output(await running.done); assert.equal(r.status, 'done'); assert.equal(r.stale, true);
  assert.equal(r.changes.files[0].by, 'unknown'); assert.ok(!r.readonly_violation?.length); assert.deepEqual(r.errors, []);
  assert.ok(r.notes.includes(M.unattributedChanges(1)));
});

test('config 和 check 每方一条 audited 提醒，沙箱配置覆盖后不提醒', async (t) => {
  const h = sandbox(t); const c = baseConfig();
  for (const command of ['config', 'check']) {
    const r = output(await h.bridge([command]));
    const warnings = r.summary.warnings.filter((w) => w.kind === 'readonly_audited');
    assert.deepEqual(warnings, [{ kind: 'readonly_audited', agent: 'codex', modes: ['review', 'discuss'],
      message: M.warnReadonlyAudited('codex', M.list([M.modeNames.review, M.modeNames.discuss])) }]);
  }
  c.agents.codex.sandbox = { review: 'read-only', discuss: 'read-only' }; h.config(c);
  for (const command of ['config', 'check']) assert.ok(!output(await h.bridge([command])).summary.warnings.some((w) => w.kind === 'readonly_audited'));
});

// 显示文字中英两个插件一样，都是英文那一套
for (const lang of ['zh', 'en']) test(`watch 非 TTY 显示审查结论、问题和未验证项，组和详细视图沿用结论（${lang} 插件）`, async (t) => {
  const h = sandbox(t), m = MESSAGES.en, findings = ['high', 'medium', 'medium'].map((severity, i) => ({
    id: `F${i + 1}`, location: `source.txt:${i + 1}`, issue: 'missing guard', trigger: 'empty input', severity, evidence: 'empty path', suggestion: 'check first',
  }));
  const result = { status: 'done', exit_code: 0, duration_s: 1, report: { ...review, verdict: 'issues_found', findings, unverified: ['runtime unverified'] },
    warnings: [], errors: [], notes: [], questions: [] };
  seedRun(h, '20000101-review', { kind: 'review', mode: 'review', group: 'reviews' }, result,
    [{ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result.report) } }]);
  const conclusion = m.watchReview.issues_found(3, `${m.severityNames.high} 1 · ${m.severityNames.medium} 2`);
  const plain = await h.bridge(['watch', '--run', '20000101-review', '--no-intro'], { env: { FOREMAN_LANG: lang } });
  assert.equal(plain.code, 0); assert.ok(plain.stdout.includes(conclusion));
  for (const f of findings) assert.ok(plain.stdout.includes(m.watchFinding(f, m.severityNames[f.severity])));
  assert.ok(plain.stdout.includes(m.watchUnverified)); assert.ok(plain.stdout.includes('runtime unverified'));
  for (const flags of [['--run', '20000101-review', '--verbose'], ['--group', 'reviews']]) {
    const shown = await h.bridge(['watch', ...flags, '--no-intro'], { env: { FOREMAN_LANG: lang } });
    assert.equal(shown.code, 0); assert.ok(shown.stdout.includes(conclusion)); assert.ok(!shown.stdout.includes(m.watchOpinion(conclusion)));
  }
  for (const verdict of ['no_issues', 'incomplete']) {
    write(path.join(h.runs, '20000101-review', 'result.json'), { ...result, report: { ...review, verdict } });
    const shown = await h.bridge(['watch', '--run', '20000101-review', '--no-intro'], { env: { FOREMAN_LANG: lang } });
    assert.ok(shown.stdout.includes(m.watchReview[verdict](0, '')));
  }
});
