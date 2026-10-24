import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, taskArgs, output, read, MESSAGES } from './helpers.mjs';
import { report } from './fixtures/reports.mjs';
import { D, finalLines, changedFor, seatUsage } from '../foreman/skills/dispatch/scripts/display.mjs';

const M = MESSAGES.zh;
const changed = (paths) => ({ ...report, files_changed: paths.map((path) => ({ path, change: '合成写入' })) });
const event = (paths) => ({ type: 'item.completed', item: { type: 'file_change', changes: paths.map((path) => ({ path, kind: 'add' })) } });
const relative = (cwd, file) => path.relative(cwd, file).replaceAll('\\', '/');
const shown = (r, colors) => finalLines({ meta: r }, r, true, 1000, colors);

for (const snapshot of ['available', 'disabled', 'failed']) test(`工具写到工作目录外：${snapshot} 快照仍记录、警告并排除误导说明`, async (t) => {
  const h = sandbox(t), outside = path.join(h.home, 'projectan', 'written.txt');
  const rel = relative(h.cwd, outside);
  const s = h.scenario({ last_message: changed([rel]), steps: [{ files: { [outside]: 'outside\n' }, event: event([outside, rel]) }] });
  const r = output(await h.bridge(taskArgs(h, 'run', snapshot === 'disabled' ? ['--no-snapshot'] : []),
    { env: { ...s.env, ...(snapshot === 'failed' ? { PATH: h.home } : {}) } }));
  assert.equal(read(outside), 'outside\n');
  assert.equal(r.changes.available, snapshot === 'available');
  assert.deepEqual(r.changes.outside_cwd, [{ path: outside, by: 'agent', in_scope: false }]);
  assert.equal(r.changes.outside_cwd_total, 1);
  assert.deepEqual(r.warnings.filter((w) => w.includes('写到了工作目录之外')), [M.wroteOutsideCwd(r.model_shown, rel)]);
  assert.ok(!r.notes.some((n) => n.includes('报告改动了这些文件')), r.notes.join('\n'));
  assert.ok(shown(r).includes(`⚠ ${D.watchOutsideCwd(path.relative(h.cwd, outside), 0)}`));
  assert.ok(shown(r, { yellow: (s) => `<yellow>${s}</yellow>`, red: (s) => s }).some((s) => s.startsWith('<yellow>⚠</yellow> ')));
  // 外部文件另列，不改变快照内的改动计数和每席用量行。
  const { outside_cwd, outside_cwd_total, ...before } = r.changes;
  assert.equal(changedFor(r, r), changedFor({ ...r, changes: before }, r));
  assert.equal(seatUsage(r, r), seatUsage(r, { ...r, changes: before }));
});

test('scope 声明内的工作目录外写入只说明不在快照里', async (t) => {
  const h = sandbox(t), files = ['../allowed/one.txt', '../allowed/two.txt'];
  const s = h.scenario({ last_message: changed(files), steps: [{ event: event(files), files: Object.fromEntries(files.map((f) => [f, 'allowed\n'])) }] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--scope', '../allowed']), { env: s.env }));
  assert.deepEqual(r.changes.outside_cwd, files.map((f) => ({ path: path.resolve(h.cwd, f), by: 'agent', in_scope: true })));
  assert.equal(r.changes.outside_cwd_total, 2);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.notes.includes(M.outsideCwdInScope(r.model_shown, M.list(files))));
  assert.ok(!r.notes.some((n) => n.includes('报告改动了这些文件')));
  assert.ok(!shown(r).some((s) => s.includes('⚠')));
});

test('只有报告声称的目录外写入标 reported，范围前缀不能误认同名目录', async (t) => {
  const h = sandbox(t), file = '../allowed-typo/written.txt';
  const s = h.scenario({ last_message: changed([file, path.resolve(h.cwd, file)]), files: { [file]: 'reported\n' } });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--scope', '../allowed']), { env: s.env }));
  assert.deepEqual(r.changes.outside_cwd, [{ path: path.resolve(h.cwd, file), by: 'reported', in_scope: false }]);
  assert.equal(r.changes.outside_cwd_total, 1);
  assert.deepEqual(r.warnings, [M.wroteOutsideCwd(r.model_shown, file)]);
  assert.ok(!r.notes.some((n) => n.includes('报告改动了这些文件')));
});

test('没有工作目录外写入时不添加字段，旧结果的显示保持不变', async (t) => {
  const h = sandbox(t), s = h.scenario({ last_message: changed(['inside.txt']), steps: [{ event: event(['inside.txt']), files: { 'inside.txt': 'inside\n' } }] });
  const r = output(await h.bridge(taskArgs(h), { env: s.env }));
  assert.ok(!Object.hasOwn(r.changes, 'outside_cwd'));
  assert.ok(!Object.hasOwn(r.changes, 'outside_cwd_total'));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(shown(r), [report.summary]);
});

test('外部路径最多列 30 条但保留完整条数，前 3 条之后显示省略数', async (t) => {
  const h = sandbox(t), files = Array.from({ length: 32 }, (_, i) => `../outside/${i}.txt`);
  const s = h.scenario({ last_message: changed(files), steps: [{ event: event(files) }] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  assert.equal(r.changes.outside_cwd.length, 30);
  assert.equal(r.changes.outside_cwd_total, 32);
  assert.equal(r.warnings.length, 1);
  assert.ok(!r.notes.some((n) => n.includes('报告改动了这些文件')));
  assert.ok(shown(r).includes(`⚠ ${D.watchOutsideCwd(D.list(files.slice(0, 3).map((f) => path.relative(h.cwd, path.resolve(h.cwd, f)))), 27)}`));
  const mixed = [...files.map((f) => f.replace('../outside/', '../allowed/')), '../wrong.txt'];
  const next = h.scenario({ last_message: changed(mixed), steps: [{ event: event(mixed) }] });
  const limited = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot', '--scope', '../allowed']), { env: next.env }));
  assert.equal(limited.changes.outside_cwd.length, 30);
  assert.equal(limited.changes.outside_cwd_total, 33);
  assert.deepEqual(limited.changes.outside_cwd[0], { path: path.resolve(h.cwd, '../wrong.txt'), by: 'agent', in_scope: false });
  assert.ok(shown(limited).includes(`⚠ ${D.watchOutsideCwd(path.relative(h.cwd, path.resolve(h.cwd, '../wrong.txt')), 0)}`));
});

test('显示保留 Windows 的上级路径和其他盘绝对路径，只提示范围外的执行写入', () => {
  const r = { kind: 'exec', cwd: 'O:\\project\\.claude\\worktrees\\task', changes: { outside_cwd: [
    { path: 'O:\\projectan\\wrong.txt', by: 'agent', in_scope: false },
    { path: 'C:\\other\\written.txt', by: 'reported', in_scope: false },
    { path: 'O:\\allowed\\yes.txt', by: 'agent', in_scope: true },
  ] } };
  assert.deepEqual(shown(r), [`⚠ ${D.watchOutsideCwd('..\\..\\..\\..\\projectan\\wrong.txt, C:\\other\\written.txt', 0)}`]);
  assert.deepEqual(shown({ ...r, cwd: undefined }), [`⚠ ${D.watchOutsideCwd('O:\\projectan\\wrong.txt, C:\\other\\written.txt', 0)}`]);
  assert.deepEqual(shown({ ...r, kind: 'review' }), []);
});

test('补审修正：自称写到别处的路径按报告原文记录；说明文字里的路径最多列 30 条并写总数', async (t) => {
  const h = sandbox(t), far = path.join(h.home, 'elsewhere', 'deep', 'x.txt');
  const one = h.scenario({ last_message: changed([far]) });
  const r1 = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: one.env }));
  assert.deepEqual(r1.changes.outside_cwd, [{ path: far, by: 'reported', in_scope: false }]);
  const many = Array.from({ length: 35 }, (_, i) => path.join(h.home, 'many', `f${i}.txt`));
  const s = h.scenario({ last_message: changed([]), steps: [{ event: event(many) }] });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env }));
  assert.equal(r.changes.outside_cwd.length, 30); assert.equal(r.changes.outside_cwd_total, 35);
  const warning = r.warnings.find((w) => w.includes('写到了工作目录之外'));
  assert.ok(warning.includes('等 35 个。'), warning); assert.equal(warning.split('、').length, 30);
});
