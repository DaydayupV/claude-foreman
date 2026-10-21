import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { plannedSandbox as sandbox, baseConfig, opencodeAgent, taskArgs, output, read, lines, MESSAGES } from './helpers.mjs';
import { review } from './fixtures/reports.mjs';
import { opencodeRetry } from './fixtures/opencode-retry.mjs';
import { opencodeRetryNoFinish } from './fixtures/opencode-retry-nofinish.mjs';
const M = MESSAGES.zh;
const transportError = 'Timed out waiting for response data';
const error = (message = transportError) => ({ type: 'error', error: { type: 'provider.transport', message } });
const finish = (reason) => ({ type: 'step_finish', part: { reason } });
const replay = (events = opencodeRetry) => ({ no_final: true, exit_code: 1, steps: events.map((event) => ({ event })) });
const runs = (s) => s.calls().filter((c) => c.operation === 'run');
const configure = (h) => {
  const c = baseConfig();
  c.agents.oc = opencodeAgent();
  c.modules.review.complex = { agent: 'oc' };
  h.config(c);
  h.write('calc.js', 'module.exports = {};\n');
};
const reviewArgs = (h) => taskArgs(h, 'review', ['--agent', 'oc', '--file', 'calc.js']);

test('审查回放 mpxt：退出码 1 的已恢复错误允许同会话修复，修复调用也可恢复且提示去重', async (t) => {
  const h = sandbox(t); configure(h);
  const complete = { ...review, coverage: { checked: ['calc.js 的完整修复报告'], not_checked: [] } };
  const s = h.scenario({ calls: [replay(), {
    steps: [{ event: error() }, { event: error('quota exhausted') }],
    last_message: complete, step_finish: { reason: 'stop' }, exit_code: 1,
  }] });
  const r = output(await h.bridge(reviewArgs(h), { env: s.env })), calls = runs(s);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('--session'), false);
  assert.equal(calls[1].args[calls[1].args.indexOf('--session') + 1], r.session_id);
  assert.equal(calls[1].stdin, M.reportRepairPrompt('Reply is not valid JSON'));
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, complete);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.notes, [M.opencodeRecovered(`${transportError}; quota exhausted`)]);
  assert.equal(read(path.join(r.run_dir, 'last-message.txt')), JSON.stringify(complete));
  assert.deepEqual(lines(path.join(r.run_dir, 'opencode.jsonl')).slice(1, opencodeRetry.length + 1), opencodeRetry);
});

test('审查回放 mpxt：修复后仍不合格维持 done、空报告和警告，不再发第三次请求', async (t) => {
  const h = sandbox(t); configure(h);
  const last = '修复后仍不是 JSON';
  const s = h.scenario({ calls: [replay(), { last_message: last }] });
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }));
  assert.equal(runs(s).length, 2);
  assert.equal(r.status, 'done');
  assert.equal(r.report, null);
  assert.equal(r.last_message, last);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, [M.reportInvalid('oc', path.join(r.run_dir, 'last-message.txt'))]);
  assert.deepEqual(r.notes, [M.opencodeRecovered(transportError)]);
});

test('审查错误后没有正常结束：最后事件是 error 时失败且不修复', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario(replay(opencodeRetry.slice(0, 14)));
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, [transportError, transportError]);
  assert.deepEqual(r.notes, []);
  assert.equal(r.report, null);
  assert.equal(runs(s).length, 1);
});

test('审查最后一次 stop 后又出 error：全部错误仍未恢复且不修复', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario(replay([...opencodeRetry, error('stop 后的错误')]));
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, [transportError, transportError, 'stop 后的错误']);
  assert.deepEqual(r.notes, []);
  assert.equal(runs(s).length, 1);
});

for (const reason of ['tool-calls', 'length']) test(`审查最后一次结束为 ${reason}：此前有 stop 也不能恢复错误`, async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario(replay([...opencodeRetry, finish(reason)]));
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, [transportError, transportError]);
  assert.deepEqual(r.notes, []);
  assert.equal(runs(s).length, 1);
});

test('审查没有 error 但退出码非零：即使以 stop 结束也仍失败', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ last_message: review, step_finish: { reason: 'stop' }, exit_code: 1 });
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.notes, []);
  assert.equal(r.report, null);
  assert.equal(runs(s).length, 1);
});

test('审查回放 mpxt 后修复调用失败：恢复过的错误并回 errors，不写恢复提示', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario({ calls: [replay(), { no_final: true, exit_code: 1, steps: [{ event: error('修复时上游 401') }] }] });
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(runs(s).length, 2);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, [transportError, '修复时上游 401']);
  assert.deepEqual(r.notes, []);
  assert.equal(r.report, null);
});

test('审查回放 7ce3：重试后写完报告就退出、没有 step_finish，也算恢复，直接收下报告', async (t) => {
  const h = sandbox(t); configure(h);
  const s = h.scenario(replay(opencodeRetryNoFinish));
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }));
  assert.equal(runs(s).length, 1);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, JSON.parse(opencodeRetryNoFinish.at(-1).part.text));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.notes, [M.opencodeRecovered(transportError)]);
});

test('审查重试后以写完的报告残片结尾：算恢复，照常修复一次', async (t) => {
  const h = sandbox(t); configure(h);
  const fragment = { type: 'text', part: { text: '{"verdict":"issues_found","findings":[', time: { start: 1, end: 2 } } };
  const s = h.scenario({ calls: [replay([...opencodeRetryNoFinish.slice(0, -1), fragment]), { last_message: review }] });
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }));
  assert.equal(runs(s).length, 2);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.report, review);
  assert.deepEqual(r.notes, [M.opencodeRecovered(transportError)]);
});

test('审查重试后最后一段回复没写完（没有 time.end）：仍然失败、不修复', async (t) => {
  const h = sandbox(t); configure(h);
  const unfinished = { type: 'text', part: { text: opencodeRetryNoFinish.at(-1).part.text } };
  const s = h.scenario(replay([...opencodeRetryNoFinish.slice(0, -1), unfinished]));
  const r = output(await h.bridge(reviewArgs(h), { env: s.env }), 1);
  assert.equal(r.status, 'failed');
  assert.deepEqual(r.errors, [transportError]);
  assert.deepEqual(r.notes, []);
  assert.equal(runs(s).length, 1);
});
