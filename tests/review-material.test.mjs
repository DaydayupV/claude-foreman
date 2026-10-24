import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { plannedSandbox as sandbox, output, read, baseConfig, opencodeAgent, piAgent, apiAgent, ROOT, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
import { review } from './fixtures/reports.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../foreman/skills/dispatch/scripts/review-scope.mjs';
import { MAX_MATERIAL_CHARS } from '../foreman/skills/dispatch/scripts/util.mjs';

const M = MESSAGES.zh;
const compute = async (h) => output(await h.start(path.join(ROOT, 'tests/fixtures/review-scope.mjs'), [JSON.stringify({ cwd: h.cwd })]).done);
const args = (h) => ['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-', '--no-snapshot'];
function configure(h, agent, api) {
  const c = baseConfig();
  c.agents.oc = opencodeAgent(); c.agents.pi = piAgent();
  if (api) c.agents.api = apiAgent(api.url);
  c.modules.review.normal = [{ agent }]; h.config(c);
}
const scopeOf = (files) => ({
  files: files.map(({ path, status = 'M', binary = false, too_large = false }) => ({ path, status, old_path: null, binary, too_large })),
  parts: files.map(({ patch, generated = false }) => ({ patch, generated })),
});

test('Git 属性标出生成文件，过滤补丁但保留完整补丁和原指纹输入', async (t) => {
  const h = sandbox(t);
  h.write('.gitattributes', read(path.join(ROOT, '.gitattributes'))
    + '\nset.txt linguist-generated\nfalse.txt linguist-generated=false\n"中文 generated.txt" linguist-generated=true\n');
  h.initGit();
  const generated = ['foreman/skills/dispatch/scripts/board/index.html', 'foreman-en/skills/dispatch/scripts/nested/tool.mjs',
    'foreman-en/hooks/test.mjs', 'set.txt', '中文 generated.txt'];
  const ordinary = ['foreman-en/skills/dispatch/scripts/language.json', 'foreman-en/skills/dispatch/scripts/nested/language.json',
    'foreman-en/hooks/test.txt', 'index.html', 'false.txt'];
  for (const file of [...generated, ...ordinary]) h.write(file, `contents of ${file}\n`);
  const scope = await compute(h), material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
  assert.deepEqual(scope.files.filter((_, i) => scope.parts[i].generated).map((f) => f.path).sort(), generated.sort());
  assert.equal(scope.parts.map((p) => p.patch).join(''), scope.patch);
  assert.equal(scope.fingerprint, createHash('sha256').update(scope.patch).update(JSON.stringify(scope.files)).digest('hex'));
  for (const file of generated) {
    assert.ok(material.fileList.includes(`- A ${file}${M.reviewFileGenerated}`));
    assert.ok(scope.patch.includes(`+contents of ${file}`));
    assert.ok(!material.patch.includes(`+contents of ${file}`));
  }
  for (const file of ordinary) assert.ok(material.patch.includes(`+contents of ${file}`));
  assert.equal(material.note, M.reviewMaterialNote(5, 0));
  const text = M.reviewMaterial(material.fileList, material.patch, material.fence, material.note);
  assert.ok(text.indexOf(material.note) < text.indexOf('### 文件清单'));
  h.write('set.txt', 'generated file changed again\n');
  const changed = await compute(h);
  assert.notEqual(changed.fingerprint, scope.fingerprint);
  assert.equal(reviewPatchText(changed, { budget: MAX_REVIEW_CHARS, readsFiles: true }).patch, material.patch);
  h.write('.git/info/attributes', '* -linguist-generated\n');
  const unfiltered = await compute(h);
  assert.ok(unfiltered.parts.every((p) => !p.generated));
  assert.equal(unfiltered.patch, changed.patch); assert.equal(unfiltered.fingerprint, changed.fingerprint);
  assert.deepEqual(unfiltered.files, changed.files);
});

test('读文件的审查方按预算保留补丁，余下给多段行号、删除和新文件提示', () => {
  const first = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+```first\n';
  const last = 'diff --git a/e.txt b/e.txt\n@@ -1 +1 @@\n-old\n+last\n';
  const scope = scopeOf([
    { path: 'a.txt', patch: first },
    { path: 'b.txt', patch: '@@ -3,2 +4,3 @@\n@@ -12 +15 @@\n' + 'b'.repeat(2000) },
    { path: 'c.txt', status: 'D', patch: '@@ -1,3 +0,0 @@\n' + 'c'.repeat(2000) },
    { path: 'd.txt', status: 'A', patch: '@@ -0,0 +1,3 @@\n' + 'd'.repeat(2000) },
    { path: 'e.txt', patch: last },
  ]);
  const material = reviewPatchText(scope, { budget: 600, readsFiles: true });
  assert.equal(material.patch, first + last);
  assert.ok(material.fileList.includes(`- M b.txt${M.reviewFileRanges('4-6, 15')}`));
  assert.ok(material.fileList.includes(`- D c.txt${M.reviewFileDeletedOmitted}`));
  assert.ok(material.fileList.includes(`- A d.txt${M.reviewFileNewOmitted}`));
  assert.equal(material.note, M.reviewMaterialNote(0, 3));
  assert.equal(material.fence, '````');
  assert.equal(material.chars, material.fileList.length + material.patch.length);
  assert.ok(material.chars <= 600); assert.equal(material.tooLarge, false);
  const full = reviewPatchText(scope, { budget: Infinity, readsFiles: false });
  assert.equal(reviewPatchText(scope, { budget: full.chars, readsFiles: true }).patch, full.patch);
  assert.equal(reviewPatchText(scope, { budget: full.chars, readsFiles: false }).tooLarge, false);
  const over = reviewPatchText(scope, { budget: full.chars - 1, readsFiles: false });
  assert.equal(over.tooLarge, true); assert.equal(over.patch, full.patch); assert.equal(over.note, '');
});

test('省略补丁的行号最多列 20 段，超过时写等', () => {
  const hunks = Array.from({ length: 21 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@\n`).join('');
  const scope = scopeOf([{ path: 'many.txt', patch: hunks + 'x'.repeat(2000) }]);
  const material = reviewPatchText(scope, { budget: 1000, readsFiles: true });
  const ranges = Array.from({ length: 20 }, (_, i) => `${i * 10 + 1}-${i * 10 + 2}`).join(', ') + ' 等';
  assert.equal(material.fileList, `- M many.txt${M.reviewFileRanges(ranges)}`);
  assert.equal(material.patch, ''); assert.ok(material.chars <= 1000);
});

test('二进制、非 UTF-8 和超过 1 MiB 的未跟踪文件仍只列说明，指纹仍跟踪大文件', async (t) => {
  const h = sandbox(t); h.initGit();
  h.write('binary.bin', Buffer.from([0, 1, 2])); h.write('encoded.txt', Buffer.from([0xff, 10]));
  const large = 'x'.repeat(1024 * 1024 + 1); h.write('large.txt', large); h.write('source.txt', 'changed\n');
  const scope = await compute(h), material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: false });
  assert.ok(material.fileList.includes(`- A binary.bin${M.reviewFileBinary}`));
  assert.ok(material.fileList.includes(`- A encoded.txt${M.reviewFileBinary}`));
  assert.ok(material.fileList.includes(`- A large.txt${M.reviewFileTooLarge}`));
  // 二进制只有几行补丁头，和改动前一样照旧放进来；超过 1 MiB 的没有补丁文本
  assert.ok(material.patch.includes('binary.bin')); assert.ok(material.patch.includes('encoded.txt'));
  assert.ok(!material.patch.includes('large.txt')); assert.ok(material.patch.includes('+changed'));
  const hashes = [['large.txt', createHash('sha256').update(large).digest('hex')]];
  assert.equal(scope.fingerprint, createHash('sha256').update(scope.patch).update(JSON.stringify(scope.files)).update(JSON.stringify(hashes)).digest('hex'));
  assert.equal(material.tooLarge, false); assert.equal(material.note, '');
});

for (const agent of ['oc', 'pi']) for (const lang of ['zh', 'en']) test(`${agent} 超过 20 万字符仍启动并给行号（${lang}）`, async (t) => {
  const h = sandbox(t); configure(h, agent); h.initGit();
  h.write('source.txt', 'x'.repeat(MAX_REVIEW_CHARS + 1) + '\n');
  const r = output(await h.bridge(args(h), { env: { FOREMAN_LANG: lang } }));
  const m = MESSAGES[lang], call = h.calls().find((c) => c.operation === 'run');
  assert.deepEqual(r.report, review); assert.equal(r.stale, false);
  assert.ok(call.stdin.includes(`- M source.txt${m.reviewFileRanges('1')}`));
  assert.ok(call.stdin.includes(m.reviewMaterialNote(0, 1)));
  assert.ok(!call.stdin.includes('x'.repeat(100))); assert.ok(call.stdin.length < MAX_REVIEW_CHARS);
  assert.ok(read(path.join(r.run_dir, 'review.patch')).length > MAX_REVIEW_CHARS);
  if (agent === 'oc') {
    assert.deepEqual(JSON.parse(call.env.OPENCODE_CONFIG_CONTENT).agent['foreman-review'].permission,
      { '*': 'deny', read: 'allow', grep: 'allow', glob: 'allow', list: 'allow' });
  } else {
    assert.equal(call.args[call.args.indexOf('--tools') + 1], 'read,grep,find,ls');
  }
});

for (const lang of ['zh', 'en']) test(`API 去掉生成文件后能审，剩余材料或整份提示超限才拒绝（${lang}）`, async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: review }]); configure(h, 'api', api);
  h.write('.gitattributes', 'generated.txt linguist-generated=true\n'); h.write('generated.txt', 'baseline\n'); h.initGit();
  h.write('generated.txt', 'generated ' + 'x'.repeat(MAX_MATERIAL_CHARS * 8 + 1) + '\n'); h.write('source.txt', 'small change\n');
  const scope = await compute(h);
  assert.ok(scope.patch.length > MAX_MATERIAL_CHARS);
  const r = output(await h.bridge(args(h), { env: { FOREMAN_LANG: lang } }));
  const m = MESSAGES[lang], prompt = api.requests[0].body.messages[1].content;
  assert.deepEqual(r.report, review); assert.ok(prompt.length <= MAX_MATERIAL_CHARS);
  assert.ok(prompt.includes(`- M generated.txt${m.reviewFileGenerated}`));
  assert.ok(prompt.includes(m.reviewMaterialNote(1, 0))); assert.ok(prompt.includes('+small change'));
  assert.ok(!prompt.includes('x'.repeat(100)));
  for (const [length, brief, patchesTooLarge] of [[MAX_MATERIAL_CHARS + 1, 'focus', true], [MAX_MATERIAL_CHARS - 1500, 'focus'.repeat(1000), false]]) {
    h.write('source.txt', 'y'.repeat(length) + '\n');
    assert.equal(reviewPatchText(await compute(h), { budget: MAX_MATERIAL_CHARS, readsFiles: false }).tooLarge, patchesTooLarge);
    const rejected = await h.bridge(args(h), { env: { FOREMAN_LANG: lang }, input: brief });
    assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
    const chars = Number((lang === 'zh' ? /仍有 (\d+) 字符/ : /still come to (\d+) characters/).exec(rejected.stderr)?.[1]);
    assert.ok(chars > MAX_MATERIAL_CHARS, rejected.stderr);
    assert.ok(rejected.stderr.includes(m.reviewTooLarge(chars, MAX_MATERIAL_CHARS)), rejected.stderr);
    assert.ok(rejected.stderr.includes('--commit')); assert.ok(rejected.stderr.includes('Codex')); assert.ok(rejected.stderr.includes('opencode')); assert.ok(rejected.stderr.includes('pi'));
  }
  assert.equal(api.requests.length, 1);
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 1);
});
