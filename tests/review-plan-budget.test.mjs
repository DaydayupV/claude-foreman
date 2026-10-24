import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, hostArgs, baseConfig, apiAgent, ROOT, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
import { review } from './fixtures/reports.mjs';
import { API_BRIEF_RESERVE } from '../foreman/skills/dispatch/scripts/adapters/api.mjs';
import { MAX_MATERIAL_CHARS } from '../foreman/skills/dispatch/scripts/util.mjs';
import { MAX_REVIEW_CHARS } from '../foreman/skills/dispatch/scripts/review-scope.mjs';

for (const lang of ['zh', 'en']) test(`API 计划计入包装、附件和说明预留，边界内能启动（${lang}）`, async (t) => {
  const h = sandbox(t), api = await apiServer(t, [{ answer: review }]), c = baseConfig(), m = MESSAGES[lang];
  h.env.FOREMAN_LANG = lang; c.agents.api = apiAgent(api.url); c.modules.review.normal = [{ agent: 'api' }]; h.config(c);
  h.write('reference.txt', 'selected evidence\noutside selected lines\n'); h.initGit();
  const url = (name) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', name)).href;
  const source = `import fs from 'node:fs';
    import { apiReviewPrompt, API_BRIEF_RESERVE } from ${JSON.stringify(url('adapters/api.mjs'))};
    import { readAttachments } from ${JSON.stringify(url('util.mjs'))};
    const scope = JSON.parse(fs.readFileSync(0, 'utf8')), cwd = process.cwd();
    const { prompt, material } = apiReviewPrompt({ cwd, target: 'diff', scope, brief: '', files: readAttachments(['reference.txt:1-1'], cwd, true) });
    console.log(JSON.stringify({ total: prompt.length + API_BRIEF_RESERVE, materialChars: material.chars }));`;
  const inspect = async () => {
    const scope = output(await h.start(path.join(ROOT, 'tests/fixtures/review-scope.mjs'), [JSON.stringify({ cwd: h.cwd })]).done);
    return output(await h.start('--input-type=module', ['-e', source], { input: JSON.stringify(scope) }).done);
  };
  const args = ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'normal', '--group', 'api-budget', '--seat', 'api', '--file', 'reference.txt:1-1'];
  let length = MAX_MATERIAL_CHARS - API_BRIEF_RESERVE - 1000;
  h.write('source.txt', 'x'.repeat(length) + '\n');
  length += MAX_MATERIAL_CHARS - (await inspect()).total + 1;
  h.write('source.txt', 'x'.repeat(length) + '\n');
  const { total, materialChars } = await inspect();
  assert.ok(materialChars + API_BRIEF_RESERVE < MAX_MATERIAL_CHARS);
  assert.equal(total, MAX_MATERIAL_CHARS + 1);
  failed(await h.bridge(args), m.planReviewTooLarge(m.planReviewTooLargeSeat(1, 'api', total),
    { cli: MAX_REVIEW_CHARS, api: MAX_MATERIAL_CHARS, reserve: API_BRIEF_RESERVE }));
  assert.equal(fs.existsSync(path.join(h.runs, 'plans')), false);
  assert.equal(h.records().length, 0); assert.equal(api.requests.length, 0);

  h.write('source.txt', 'x'.repeat(length - 1) + '\n');
  const plan = output(await h.bridge(args)); output(await h.bridge(hostArgs(h, plan)));
  const run = output(await h.bridge(['review', '--plan', plan.plan_id, '--seat', '1', '--brief', '-', '--no-snapshot'], { input: 'b'.repeat(API_BRIEF_RESERVE) }));
  const prompt = api.requests[0].body.messages[1].content;
  assert.equal(prompt.length, MAX_MATERIAL_CHARS); assert.deepEqual(run.report, review);
  assert.ok(prompt.includes('1\tselected evidence')); assert.ok(!prompt.includes('outside selected lines'));
  assert.ok(prompt.includes('reference.txt\nsource.txt'));
});
