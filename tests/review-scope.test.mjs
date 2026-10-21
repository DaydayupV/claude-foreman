import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, write, ROOT, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const compute = (h, opts = {}) => h.start(path.join(ROOT, 'tests/fixtures/review-scope.mjs'), [JSON.stringify({ cwd: h.cwd, ...opts })]).done;
const commitAll = (h) => { h.git(['add', '.']); h.git(['commit', '--quiet', '-m', 'synthetic changes']); return h.git(['rev-parse', 'HEAD']); };

test('diff 指纹包含附件路径、行范围和完整内容，非 Git 目录仍返回 null', async (t) => {
  const h = sandbox(t);
  assert.equal(output(await compute(h, { file: ['missing.txt'] })), null);
  h.initGit(); h.write('source.txt', 'changed\n');
  const attachment = write(path.join(h.home, 'evidence.txt'), 'first\nsecond\n');
  write(path.join(h.home, 'copy.txt'), 'first\nsecond\n');
  const plain = output(await compute(h)), first = output(await compute(h, { file: ['../evidence.txt:1-1'] }));
  assert.notEqual(first.fingerprint, plain.fingerprint);
  assert.deepEqual({ ...first, fingerprint: plain.fingerprint }, plain);
  for (const file of ['../copy.txt:1-1', '../evidence.txt:1-2']) {
    assert.notEqual(output(await compute(h, { file: [file] })).fingerprint, first.fingerprint);
  }
  write(attachment, 'first\nchanged\n');
  const changed = output(await compute(h, { file: ['../evidence.txt:1-1'] }));
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(changed.patch, first.patch); assert.deepEqual(changed.files, first.files);
});

test('超过 1 MiB 的未跟踪文件只改内容也会改变指纹，不增加文件字段或补丁', async (t) => {
  const h = sandbox(t); h.initGit();
  const bytes = Buffer.alloc(1024 * 1024 + 1, 'x'), file = h.write('large.txt', bytes), stat = fs.statSync(file);
  const first = output(await compute(h));
  assert.deepEqual(first.files, [{ path: 'large.txt', status: 'A', binary: false, too_large: true, old_path: null }]);
  bytes[bytes.length - 1] = 121; write(file, bytes); fs.utimesSync(file, stat.atime, stat.mtime);
  const changed = output(await compute(h));
  assert.notEqual(changed.fingerprint, first.fingerprint);
  assert.equal(changed.patch, first.patch); assert.deepEqual(changed.files, first.files);
  bytes[bytes.length - 1] = 120; write(file, bytes);
  assert.equal(output(await compute(h)).fingerprint, first.fingerprint);
});

test('未提交范围合并暂存、未暂存和未跟踪文件，指纹稳定且不改索引', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('source.txt', 'staged\n'); h.write('staged.txt', 'staged only\n'); h.git(['add', '.']);
  h.write('source.txt', 'working\n'); h.write('中文 new.txt', '你好\n');
  const index = h.git(['ls-files', '--stage']), status = h.git(['status', '--porcelain']);
  const r = output(await compute(h)), again = output(await compute(h, { uncommitted: true }));
  assert.equal(r.kind, 'uncommitted'); assert.equal(r.description, M.reviewScopeUncommitted);
  assert.deepEqual([r.base, r.merge_base, r.commit], [null, null, null]);
  assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['source.txt', 'M'], ['staged.txt', 'A'], ['中文 new.txt', 'A']]);
  for (const text of ['-before', '+working', '+staged only', '+你好']) assert.ok(r.patch.includes(text), text);
  assert.ok(!r.patch.includes('+staged\n')); assert.ok(!r.patch.includes('\u001b['));
  assert.match(r.fingerprint, /^[a-f0-9]{64}$/); assert.equal(r.fingerprint, again.fingerprint);
  assert.equal(h.git(['ls-files', '--stage']), index); assert.equal(h.git(['status', '--porcelain']), status);
});

test('范围列出删除、改名、二进制、非 UTF-8 和过大新文件，禁用外部 diff 与 textconv', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('delete.txt', 'deleted content\n'); h.write('old.txt', 'rename me\n');
  h.write('binary.dat', Buffer.from([0, 1, 2])); h.write('encoded.txt', Buffer.from([0xff, 10]));
  h.write('.gitattributes', '*.txt diff=forbidden\n'); commitAll(h);
  h.git(['config', 'diff.external', 'must-not-run']); h.git(['config', 'diff.forbidden.command', 'must-not-run']);
  h.git(['config', 'diff.forbidden.textconv', 'must-not-run']); h.git(['config', 'color.ui', 'always']);
  h.git(['config', 'core.quotepath', 'true']);
  fs.unlinkSync(path.join(h.cwd, 'delete.txt')); h.git(['mv', 'old.txt', '改名.txt']);
  h.write('binary.dat', Buffer.from([0, 3, 4])); h.write('encoded.txt', Buffer.from([0xfe, 10]));
  h.write('new.bin', Buffer.from([0, 5, 6])); h.write('new-encoded.txt', Buffer.from([0xfe, 10]));
  h.write('large.txt', 'x'.repeat(1024 * 1024 + 1)); h.write('empty.txt', '');
  const r = output(await compute(h)), files = Object.fromEntries(r.files.map((f) => [f.path, f]));
  assert.equal(files['delete.txt'].status, 'D'); assert.ok(r.patch.includes('-deleted content'));
  assert.equal(files['改名.txt'].status, 'R'); assert.equal(files['改名.txt'].old_path, 'old.txt');
  assert.ok(r.patch.includes('rename from old.txt')); assert.ok(r.patch.includes('rename to 改名.txt'));
  for (const name of ['binary.dat', 'encoded.txt', 'new.bin', 'new-encoded.txt']) assert.equal(files[name].binary, true, name);
  assert.equal(files['large.txt'].too_large, true); assert.equal(files['empty.txt'].status, 'A');
  assert.ok(!r.patch.includes('x'.repeat(100))); assert.ok(!r.patch.includes('\ufffd')); assert.ok(!r.patch.includes('\u001b['));
});

test('无提交仓库把暂存、工作区和未跟踪文件全部视为新增', async (t) => {
  const h = sandbox(t); h.git(['init', '--quiet']); h.git(['config', 'core.autocrlf', 'false']);
  h.write('staged.txt', 'staged\n'); h.git(['add', '.']); h.write('staged.txt', 'working\n'); h.write('new.txt', 'new\n');
  const r = output(await compute(h));
  assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['new.txt', 'A'], ['staged.txt', 'A']]);
  assert.ok(r.patch.includes('+working')); assert.ok(r.patch.includes('+new')); assert.ok(!r.patch.includes('+staged'));
});

test('base 从分叉点到工作区，包含未提交改动但排除未跟踪文件', async (t) => {
  const h = sandbox(t), root = h.initGit(), branch = h.git(['branch', '--show-current']);
  h.git(['branch', 'base']); h.write('committed.txt', 'feature\n'); commitAll(h);
  h.git(['switch', '--quiet', 'base']); h.write('base-only.txt', 'base only\n'); const base = commitAll(h);
  h.git(['switch', '--quiet', branch]); h.write('source.txt', 'staged\n'); h.git(['add', 'source.txt']);
  h.write('source.txt', 'working\n'); h.write('untracked.txt', 'exclude me\n');
  const r = output(await compute(h, { base: 'base' }));
  assert.equal(r.kind, 'base'); assert.equal(r.base, base); assert.equal(r.merge_base, root); assert.equal(r.commit, null);
  assert.equal(r.description, M.reviewScopeBase('base', root));
  assert.deepEqual(r.files.map((f) => f.path), ['committed.txt', 'source.txt']);
  assert.ok(r.patch.includes('+working')); assert.ok(r.patch.includes('+feature')); assert.ok(!r.patch.includes('exclude me'));
});

test('base 不存在或没有共同祖先时明确报错', async (t) => {
  const h = sandbox(t); h.initGit();
  failed(await compute(h, { base: 'missing' }), M.baseNotFound('missing'));
  const orphan = h.git(['commit-tree', h.git(['write-tree']), '-m', 'unrelated root']);
  h.git(['branch', 'unrelated', orphan]);
  failed(await compute(h, { base: 'unrelated' }), M.baseNotFound('unrelated'));
});

test('根提交相对空树，合并提交只比较第一个父提交', async (t) => {
  const h = sandbox(t), root = h.initGit(), branch = h.git(['branch', '--show-current']);
  const first = output(await compute(h, { commit: root.slice(0, 8) }));
  assert.equal(first.commit, root); assert.equal(first.description, M.reviewScopeCommit(root));
  assert.deepEqual(first.files.map((f) => [f.path, f.status]), [['source.txt', 'A']]); assert.ok(first.patch.includes('+before'));
  h.git(['branch', 'side']); h.write('main.txt', 'first parent\n'); const parent = commitAll(h);
  h.git(['switch', '--quiet', 'side']); h.write('side.txt', 'merged change\n'); commitAll(h);
  h.git(['switch', '--quiet', branch]); h.git(['merge', '--quiet', '--no-ff', '-m', 'synthetic merge', 'side']);
  const merge = h.git(['rev-parse', 'HEAD']); h.write('source.txt', 'working excluded\n'); h.write('untracked.txt', 'excluded\n');
  assert.equal(h.git(['rev-parse', 'HEAD^1']), parent);
  const r = output(await compute(h, { commit: 'HEAD' }));
  assert.equal(r.kind, 'commit'); assert.equal(r.commit, merge); assert.deepEqual([r.base, r.merge_base], [null, null]);
  assert.deepEqual(r.files.map((f) => [f.path, f.status]), [['side.txt', 'A']]); assert.ok(r.patch.includes('+merged change'));
  assert.ok(!r.patch.includes('first parent')); assert.ok(!r.patch.includes('working excluded'));
});
