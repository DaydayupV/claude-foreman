import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, output, failed, baseConfig, apiAgent, opencodeAgent, piAgent, write, json, taskArgs, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const configArgs = (h) => ['config', '--cwd', h.cwd];

test('项目保留用户顺序和必选，忽略模型及其他字段，解析旧代号', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.second = { ...c.agents.codex }; c.agents.third = { ...c.agents.codex };
  c.modules.review.complex = [{ agent: 'codex', effort: 'high', required: true, model: 'user-model' }, { agent: 'second', effort: 'medium' }, { agent: 'third' }];
  h.config(c);
  write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), { old: 'codex' });
  h.write('.claude/foreman.json', { modules: { review: { complex: [
    { agent: 'second', required: true }, { agent: 'old', required: false, effort: 'low', model: 'unsafe', extra: 1 }, { agent: 'missing' },
  ] } } });
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.deepEqual(out.effective.modules.review.complex, [{ agent: 'codex', effort: 'low', required: true, model: 'user-model' }, { agent: 'second', effort: 'medium' }]);
  for (const name of ['codex', 'second']) assert.ok(r.stderr.includes(M.projectRequiredChanged('modules.review.complex', name)));
  for (const field of ['model', 'extra', 'missing']) assert.ok(r.stderr.includes(M.projectAgentDropped(field, 'modules.review.complex')));
  h.write('.claude/foreman.json', { modules: { review: { complex: [{ agent: 'second' }] } } });
  failed(await h.bridge(configArgs(h)), M.projectRequiredDropped('modules.review.complex', 'codex'));
  h.write('.claude/foreman.json', { modules: { review: { complex: 'claude code' } } });
  assert.deepEqual(output(await h.bridge(configArgs(h))).closed_by_project, ['review.complex']);
});

for (const [field, user, project, expected] of [
  ['timeout_min', 5, 9, 5], ['timeout_min', 5, 2, 2],
  ...['stall_min', 'busy_ask_min'].flatMap((field) => [[field, 4, 0, 4], [field, 4, 8, 4], [field, 4, 2, 2], [field, 0, 2, 2], [field, 0, 0, 0]]),
]) test(`项目时长收紧 ${field} ${user} → ${project}`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.dispatch[field] = user; h.config(c);
  h.write('.claude/foreman.json', { dispatch: { [field]: project } });
  const r = await h.bridge(configArgs(h));
  assert.equal(output(r).effective.dispatch[field], expected);
  assert.equal(r.stderr.includes(M.projectLooser(`dispatch.${field}`, project, user)), expected !== project);
});

for (const [field, value] of [['timeout_min', 0], ['stall_min', -1], ['busy_ask_min', '2']]) test(`项目先校验 dispatch.${field}`, async (t) => {
  const h = sandbox(t); h.write('.claude/foreman.json', { dispatch: { [field]: value } });
  failed(await h.bridge(configArgs(h)), M.configInvalid(`dispatch.${field}`, M.invalid.minutes));
});

test('项目配置里的 dispatch.max_seats 不再生效，提示已忽略', async (t) => {
  const h = sandbox(t); h.write('.claude/foreman.json', { dispatch: { max_seats: 1 } });
  const r = await h.bridge(configArgs(h));
  assert.equal(Object.hasOwn(output(r).effective.dispatch, 'max_seats'), false);
  assert.ok(r.stderr.includes(M.projectIgnored('dispatch.max_seats')));
});

test('项目只降低有顺序的 Codex 和 pi 强度，未写强度时不能加', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.pi = piAgent();
  c.modules.discuss.complex = [{ agent: 'codex', effort: 'high' }, { agent: 'pi', effort: 'high' }];
  c.modules.discuss.simple = [{ agent: 'codex' }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { discuss: { complex: [{ agent: 'pi', effort: 'low' }, { agent: 'codex', effort: 'low' }], simple: [{ agent: 'codex', effort: 'medium' }] } } });
  let r = await h.bridge(configArgs(h)), out = output(r);
  assert.deepEqual(out.effective.modules.discuss.complex, [{ agent: 'codex', effort: 'low' }, { agent: 'pi', effort: 'low' }]);
  assert.deepEqual(out.effective.modules.discuss.simple, [{ agent: 'codex' }]);
  assert.ok(r.stderr.includes(M.projectEffortNoBase('modules.discuss.simple', 'codex')));
  h.write('.claude/foreman.json', { modules: { discuss: { complex: [{ agent: 'pi', effort: 'max' }, { agent: 'codex', effort: 'max' }] } } });
  r = await h.bridge(configArgs(h)); out = output(r);
  assert.deepEqual(out.effective.modules.discuss.complex, c.modules.discuss.complex);
  for (const agent of ['codex', 'pi']) assert.ok(r.stderr.includes(M.projectEffortRaised('modules.discuss.complex', agent, 'max', 'high')));
});

for (const type of ['opencode cli', 'api']) test(`项目不能改 ${type} 强度`, async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.remote = type === 'api' ? apiAgent('http://127.0.0.1:1') : opencodeAgent();
  c.modules.discuss.normal = [{ agent: 'remote', effort: 'high' }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { discuss: { normal: { agent: 'remote', effort: 'low' } } } });
  const r = await h.bridge(configArgs(h));
  assert.deepEqual(output(r).effective.modules.discuss.normal, c.modules.discuss.normal);
  assert.ok(r.stderr.includes(M.projectEffortUnordered('modules.discuss.normal', 'remote', type)));
});

for (const [module, cell] of [['discuss', 'normal'], ['run', 'complex'], ['review', 'normal'], ['image', 'generate'], ['image', 'draw']]) test(`项目过滤空格子报错 ${module}.${cell}`, async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules[module][cell] = [{ agent: 'codex' }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { [module]: { [cell]: { agent: 'missing' } } } });
  failed(await h.bridge(configArgs(h)), M.projectLevelEmpty(`modules.${module}.${cell}`));
});

test('用户关闭的格子项目不能打开，image 也只能收紧并可整格关闭', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.image.draw = [{ agent: 'codex', effort: 'high', required: true }]; h.config(c);
  h.write('.claude/foreman.json', { modules: { run: { simple: [{ agent: 'codex' }] }, image: { generate: [{ agent: 'codex' }], draw: null } } });
  const r = await h.bridge(configArgs(h)), out = output(r);
  assert.equal(out.effective.modules.run.simple, 'claude code');
  assert.deepEqual(out.effective.modules.image, { generate: null, draw: null });
  assert.deepEqual(out.closed_by_project, ['image.draw']);
  for (const key of ['modules.run.simple', 'modules.image.generate']) {
    assert.ok(r.stderr.includes(M.projectCellOpened(key)));
    assert.ok(!r.stderr.includes(M.projectAgentDropped('codex', key)));
  }
});

test('用户的 Claude 格子可点名，项目关掉后点名和续接均拒绝', async (t) => {
  const h = sandbox(t);
  const outside = output(await h.bridge(['run', '--cwd', h.cwd, '--level', 'simple', '--agent', 'codex', '--brief', '-', '--no-snapshot']));
  assert.equal(outside.outside_cell, true);
  assert.equal(json(path.join(h.runs, outside.run_id, 'meta.json')).outside_cell, true);
  // 点名派出的任务续接时沿用上一轮的协作方，不用再写 --agent
  const again = output(await h.bridge(['resume', '--run', outside.run_id, '--level', 'simple', '--brief', '-', '--reason', 'rework']));
  assert.equal(again.agent, 'codex'); assert.equal(again.outside_cell, true);
  const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot'])));
  h.write('.claude/foreman.json', { modules: { run: { complex: 'claude code' } } });
  failed(await h.bridge(taskArgs(h, 'run', ['--agent', 'codex', '--no-snapshot'])), M.cellClosedByProject('modules.run.complex'));
  failed(await h.bridge(['resume', '--run', first.run_id, '--level', 'complex', '--agent', 'codex', '--brief', '-', '--reason', 'rework']), M.cellClosedByProject('modules.run.complex'));
});
