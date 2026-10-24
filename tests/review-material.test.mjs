import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { plannedSandbox as sandbox, output, read, baseConfig, opencodeAgent, piAgent, apiAgent, ROOT, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
import { review } from './fixtures/reports.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../foreman/skills/dispatch/scripts/review-scope.mjs';
import { MAX_MATERIAL_CHARS } from '../foreman/skills/dispatch/scripts/util.mjs';

const M = MESSAGES.zh;
const compute = async (h, options = {}) => output(await h.start(path.join(ROOT, 'tests/fixtures/review-scope.mjs'), [JSON.stringify({ cwd: h.cwd, ...options })]).done);
const args = (h) => ['review', '--cwd', h.cwd, '--level', 'normal', '--brief', '-', '--no-snapshot'];
function configure(h, agent, api) {
  const c = baseConfig();
  c.agents.oc = opencodeAgent(); c.agents.pi = piAgent();
  if (api) c.agents.api = apiAgent(api.url);
  c.modules.review.normal = [{ agent }]; h.config(c);
}
const scopeOf = (files, kind = 'uncommitted') => ({
  kind,
  files: files.map(({ path, status = 'M', binary = false, too_large = false }) => ({ path, status, old_path: null, binary, too_large })),
  parts: files.map(({ patch, generated = false }) => ({ patch, generated })),
});

test('只有 uncommitted 和 base 能按行号省略补丁，commit 超限保留补丁并返回 tooLarge', () => {
  for (const kind of ['uncommitted', 'base', 'commit']) {
    const scope = scopeOf([{ path: 'source.txt', patch: '@@ -3,2 +4,3 @@\n' + 'x'.repeat(2000) }], kind);
    const material = reviewPatchText(scope, { budget: 300, readsFiles: true });
    assert.equal(material.tooLarge, kind === 'commit');
    if (kind === 'commit') {
      assert.equal(material.patch, scope.parts[0].patch); assert.equal(material.note, '');
      assert.equal(material.fileList, '- M source.txt');
      assert.equal(reviewPatchText(scope, { budget: material.chars, readsFiles: true }).tooLarge, false);
    } else {
      assert.equal(material.patch, '');
      assert.equal(material.fileList, `- M source.txt${M.reviewFileRanges('4-6')}`);
    }
  }
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

test('省略补丁的行号跳过纯删除段，最多列 20 段，超过时写等', () => {
  const hunks = '@@ -1,3 +0,0 @@\n' + Array.from({ length: 21 }, (_, i) => `@@ -${i * 10 + 1},2 +${i * 10 + 1},2 @@\n`).join('');
  const scope = scopeOf([{ path: 'many.txt', patch: hunks + 'x'.repeat(2000) }]);
  const material = reviewPatchText(scope, { budget: 1000, readsFiles: true });
  const ranges = Array.from({ length: 20 }, (_, i) => `${i * 10 + 1}-${i * 10 + 2}`).join(', ') + ' 等';
  assert.equal(material.fileList, `- M many.txt${M.reviewFileRanges(ranges)}`);
  assert.equal(material.patch, ''); assert.ok(material.chars <= 1000);
});

test('无改动段和纯删除段用文件说明，混合段只给有效的新侧行号（中英文）', async (t) => {
  const h = sandbox(t), name = 'source-' + 'x'.repeat(100) + '.txt';
  const header = `diff --git a/${name} b/${name}\n`;
  const scopes = [
    scopeOf([{ path: name, status: 'R', patch: `diff --git a/old.txt b/${name}\nsimilarity index 100%\nrename from old.txt\nrename to ${name}\n` }]),
    scopeOf([{ path: name, patch: header + 'old mode 100644\nnew mode 100755\n' }]),
    scopeOf([{ path: name, patch: header + '@@ -1,3 +0,0 @@\n-one\n-two\n-three\n' }]),
    scopeOf([{ path: name, patch: header + '@@ -10,3 +9,0 @@\n-one\n-two\n-three\n' }]),
    scopeOf([{ path: name, patch: header + '@@ -10,3 +9,0 @@\n-one\n-two\n-three\n@@ -20 +17 @@\n-old\n+new\n' }]),
  ];
  const source = `import fs from 'node:fs';
    import { reviewPatchText } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/review-scope.mjs')).href)};
    import { M } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/util.mjs')).href)};
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(0, 'utf8')).map((scope) => reviewPatchText(scope,
      { budget: scope.files[0].path.length + 5 + M.reviewFileOmitted.length, readsFiles: true }))));`;
  for (const lang of ['zh', 'en']) {
    const materials = output(await h.start('--input-type=module', ['-e', source], { env: { FOREMAN_LANG: lang }, input: JSON.stringify(scopes) }).done);
    const m = MESSAGES[lang];
    for (const [i, material] of materials.entries()) {
      assert.equal(material.patch, ''); assert.equal(material.tooLarge, false);
      assert.equal(material.fileList, `- ${i === 0 ? 'R' : 'M'} ${name}${i === 4 ? m.reviewFileRanges('17') : m.reviewFileOmitted}`);
      assert.ok(!material.fileList.includes(m.reviewFileRanges('')));
    }
  }
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

for (const agent of ['oc', 'pi']) test(`${agent} 的历史提交超限时拒绝，不能指向当前工作区的另一个版本`, async (t) => {
  const h = sandbox(t); configure(h, agent); h.initGit();
  h.write('source.txt', 'const DONE_SHOWN = 20;\n' + 'historical\n'.repeat(25000));
  h.git(['add', 'source.txt']); h.git(['commit', '--quiet', '-m', 'synthetic historical change']);
  const sha = h.git(['rev-parse', 'HEAD']); h.write('source.txt', 'const currentOnly = true;\n');
  const scope = await compute(h, { commit: sha });
  assert.ok(scope.patch.includes('+const DONE_SHOWN = 20;')); assert.ok(!scope.patch.includes('currentOnly'));
  const material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
  assert.equal(material.tooLarge, true); assert.equal(material.patch, scope.patch);
  const source = `import fs from 'node:fs';
    import adapter from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters', agent === 'oc' ? 'opencode-cli.mjs' : 'pi-cli.mjs')).href)};
    await adapter.execute({ kind: 'review', reviewTarget: 'diff', reviewScope: JSON.parse(fs.readFileSync(0, 'utf8')),
      cwd: process.cwd(), agent: {}, opts: { file: [] }, brief: '' });`;
  const rejected = await h.start('--input-type=module', ['-e', source], { input: JSON.stringify({ ...scope, target: 'diff' }) }).done;
  assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
  // 已经在按提交审：不再建议按提交分开审
  assert.ok(rejected.stderr.includes(M.reviewCommitTooLarge(material.chars, MAX_REVIEW_CHARS)), rejected.stderr);
  assert.equal(h.calls().length, 0); assert.equal(h.records().filter((m) => m.participant !== 'host').length, 0);
});

for (const agent of ['oc', 'pi']) test(`${agent} 的清单本身或清单加行号超限时拒绝，不启动审查方`, async (t) => {
  const h = sandbox(t), file = agent === 'oc' ? 'opencode-cli.mjs' : 'pi-cli.mjs';
  const source = `import fs from 'node:fs';
    import adapter from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters', file)).href)};
    await adapter.execute({ kind: 'review', reviewTarget: 'diff', reviewScope: JSON.parse(fs.readFileSync(0, 'utf8')),
      cwd: process.cwd(), agent: {}, opts: { file: [] }, brief: '' });`;
  const scopes = [
    scopeOf(Array.from({ length: 5000 }, (_, i) => ({ path: `${'long-directory/'.repeat(3)}file-${i}.txt`, patch: '' }))),
    scopeOf(Array.from({ length: 6000 }, (_, i) => ({ path: `file-${i}.txt`, patch: '@@ -1 +1 @@\n-old\n+' + 'x'.repeat(200) + '\n' }))),
  ];
  for (const scope of scopes) {
    const material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
    assert.equal(material.patch, ''); assert.equal(material.tooLarge, true); assert.ok(material.fileList.length > MAX_REVIEW_CHARS);
    const rejected = await h.start('--input-type=module', ['-e', source], { input: JSON.stringify({ ...scope, target: 'diff' }) }).done;
    assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
    assert.ok(rejected.stderr.includes(M.reviewTooLarge(material.chars, MAX_REVIEW_CHARS)), rejected.stderr);
  }
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 0);
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
  h.write('generated.txt', 'baseline\n');
  const source = `import fs from 'node:fs';
    import adapter from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/adapters/api.mjs')).href)};
    const { scope, brief } = JSON.parse(fs.readFileSync(0, 'utf8'));
    await adapter.execute({ kind: 'review', reviewTarget: 'diff', reviewScope: scope, cwd: process.cwd(),
      agent: { api_key: 'synthetic-test-key' }, opts: { file: [] }, brief });`;
  for (const [length, brief, patchesTooLarge] of [[MAX_MATERIAL_CHARS + 1, 'focus', true], [MAX_MATERIAL_CHARS - 1500, 'focus'.repeat(1000), false]]) {
    h.write('source.txt', 'y'.repeat(length) + '\n');
    const scope = await compute(h), material = reviewPatchText(scope, { budget: MAX_MATERIAL_CHARS, readsFiles: false });
    assert.equal(material.tooLarge, patchesTooLarge);
    for (const kind of patchesTooLarge ? ['uncommitted', 'commit'] : ['uncommitted']) {
      const rejected = await h.start('--input-type=module', ['-e', source], { env: { FOREMAN_LANG: lang }, input: JSON.stringify({ scope: { ...scope, kind }, brief }) }).done;
      assert.equal(rejected.code, 2); assert.equal(rejected.stdout, '');
      if (patchesTooLarge) {
        assert.ok(rejected.stderr.includes(m[kind === 'commit' ? 'reviewCommitTooLarge' : 'reviewTooLarge'](material.chars, MAX_MATERIAL_CHARS)), rejected.stderr);
        assert.ok(rejected.stderr.includes('Codex'));
        if (kind === 'commit') assert.doesNotMatch(rejected.stderr, /--(?:commit|file)\b/);
        else assert.ok(rejected.stderr.includes('--commit'));
      } else {
        const total = Number((lang === 'zh' ? /共 (\d+) 字符/ : /material is (\d+) characters/).exec(rejected.stderr)?.[1]);
        assert.ok(total > MAX_MATERIAL_CHARS, rejected.stderr);
        assert.ok(rejected.stderr.includes(m.materialsTooLarge(total, MAX_MATERIAL_CHARS, '')), rejected.stderr);
      }
      assert.doesNotMatch(rejected.stderr, /opencode|\bpi\b/);
    }
  }
  assert.equal(api.requests.length, 1);
  assert.equal(h.records().filter((m) => m.participant !== 'host').length, 1);
});
