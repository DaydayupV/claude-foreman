import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, failed, baseConfig, seedRun, write, json, poll, opencodeAgent, MESSAGES } from './helpers.mjs';
import { readViewedImages } from '../foreman/skills/dispatch/scripts/image-calls.mjs';
import { formatUsd } from '../foreman/skills/dispatch/scripts/format.mjs';
import { discussion, review } from './fixtures/reports.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const raw = (payload, timestamp = new Date().toISOString()) => ({ timestamp, type: 'response_item', payload });
const viewed = (file, call_id = 'view-code') => raw({ type: 'custom_tool_call', name: 'exec', call_id,
  input: `const r = await tools.view_image({path:${JSON.stringify(file)}}); image(r.image_url);` });
const viewOutput = (call_id = 'view-code', image = true) => raw({ type: 'custom_tool_call_output', call_id,
  output: JSON.stringify([{ type: image ? 'input_image' : 'input_text', ...(image ? { image_url: 'data:image/png;base64,synthetic' } : { text: 'not found' }) }]) });
// 假 Codex 和调度进程都按测试环境的 TZ=UTC 算日期目录，这里也用 UTC，免得本地时间跨过零点时对不上。
const sessionFile = (h) => {
  const d = new Date();
  return path.join(h.env.CODEX_HOME, 'sessions', String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0'), 'rollout-synthetic-session.jsonl');
};

test('stale 在席位、计划行、status 和 watch 结束行显示，完整性判断不变', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.modules.review.complex[0].required = true; h.config(c); h.write('evidence.txt', 'before\n');
  const p = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'stale-group', '--seat', 'codex', '--target', 'files', '--file', 'evidence.txt']));
  const s = h.scenario({ files: { 'evidence.txt': 'changed by somebody else\n' } });
  const r = output(await h.bridge(['review', '--plan', p.plan_id, '--seat', 1, '--brief', '-', '--title', '材料审查'], { env: s.env }));
  assert.equal(r.stale, true); assert.equal(r.status, 'done'); assert.deepEqual(r.report, review);
  const state = output(await h.bridge(['status', '--plan', p.plan_id]));
  assert.equal(state.state, 'complete'); assert.equal(state.seats[0].stale, true);
  const detail = D.watchPlanStale(D.watchPlanSeat('codex', 1, null));
  for (const args of [['status'], ['status', '--group', p.group], ['watch', '--run', r.run_id], ['watch', '--run', r.run_id, '--verbose'], ['watch', '--group', p.group]]) {
    const display = await h.bridge(args); assert.equal(display.code, 0); assert.ok(display.stdout.includes(D.watchStale), display.stdout);
    if (args.includes('--group')) assert.ok(display.stdout.includes(D.watchPlanState(p.plan_id, 'complete', detail)), display.stdout);
    if (args[0] === 'status') assert.ok(display.stdout.includes(`材料审查 · ${D.watchStale}`));
  }
  const saved = json(p.file); saved.seats.push({ seat: 2, agent: 'second', role: null, required: true }); write(p.file, saved);
  const pending = await h.bridge(['status', '--group', p.group]);
  assert.ok(pending.stdout.includes(`${D.watchPlanNotStarted(D.watchPlanSeat('second', 2, null))}; ${detail}`));
  const english = await h.bridge(['status', '--group', p.group], { env: { FOREMAN_LANG: 'en' } });
  assert.ok(english.stdout.includes(`${MESSAGES.en.watchPlanNotStarted(MESSAGES.en.watchPlanSeat('second', 2, null))}; ${MESSAGES.en.watchPlanStale(MESSAGES.en.watchPlanSeat('codex', 1, null))}`));
  seedRun(h, 'latest-review', { module: 'review', mode: 'review', kind: 'review', plan: p.plan_id, seat: 1, started_at: new Date(Date.now() + 1000).toISOString() }, { status: 'done', report: review, stale: false });
  assert.equal(output(await h.bridge(['status', '--plan', p.plan_id])).seats[0].stale, false);
});

test('看图解析支持代码与函数调用、未知路径、成功失败未结束和 since 过滤', (t) => {
  const h = sandbox(t), at = new Date().toISOString(), first = path.join(h.cwd, '第一张.png');
  const records = [viewed('old.png', 'old'), viewOutput('old'), viewed(first), viewOutput(),
    raw({ type: 'custom_tool_call', name: 'exec', call_id: 'variable', input: 'await tools.view_image({path: imagePath});' }, at), viewOutput('variable', false),
    raw({ type: 'function_call', name: 'tools.view_image', call_id: 'direct', arguments: JSON.stringify({ path: 'direct.png' }) }, at),
    raw({ type: 'function_call_output', call_id: 'direct', output: [{ type: 'input_image' }] }, at),
    raw({ type: 'function_call', name: 'view_image', call_id: 'pending', arguments: '{}' }, at),
    raw({ type: 'custom_tool_call', name: 'exec', call_id: 'only-text', input: `const text = 'tools.view_image({path:"not-a-call.png"})'; // tools.view_image({path:"comment.png"})` }, at)];
  records[0].timestamp = '2000-01-01T00:00:00Z'; records[1].timestamp = '2000-01-01T00:00:00Z';
  const file = write(path.join(h.home, 'views.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const result = readViewedImages(file, Date.parse(at) - 1000);
  assert.deepEqual(result.map(({ path, ok }) => ({ path, ok })), [{ path: first, ok: true }, { path: 'unknown', ok: false }, { path: 'direct.png', ok: true }, { path: 'unknown', ok: null }]);
  assert.ok(result.every((r) => Number.isFinite(Date.parse(r.at))));
});

test('看图按同一 call_id 的调用及图片数累计，纯文字输出不抹掉成功结果', (t) => {
  const h = sandbox(t), state = {}, file = path.join(h.home, 'counts.jsonl');
  const two = raw({ type: 'custom_tool_call', name: 'exec', call_id: 'two', input: 'await tools.view_image({path:"a.png"}); await tools.view_image({path:"b.png"});' });
  write(file, [two, viewOutput('two'), viewed('one.png', 'one'), viewOutput('one'), viewOutput('one', false)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(readViewedImages(file, 0, state).map((r) => r.ok), [null, null, true]);
  fs.appendFileSync(file, [viewed('c.png', 'two'), viewOutput('two')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const merged = readViewedImages(file, 0, state);
  assert.deepEqual(merged.map((r) => r.path), ['a.png', 'b.png', 'one.png', 'c.png']);
  assert.deepEqual(merged.map((r) => r.ok), [null, null, true, null]);
  fs.appendFileSync(file, JSON.stringify(viewOutput('two')) + '\n');
  assert.deepEqual(readViewedImages(file, 0, state).map((r) => r.ok), [true, true, true, true]);
});

test('看图输出先到时跨增量读取保存计数，收尾解析没有换行的末行', (t) => {
  const h = sandbox(t), state = {}, file = write(path.join(h.home, 'early-output.jsonl'), JSON.stringify(viewOutput()) + '\n');
  assert.deepEqual(readViewedImages(file, 0, state), []);
  fs.appendFileSync(file, JSON.stringify(viewed('late-call.png')));
  assert.deepEqual(readViewedImages(file, 0, state), []);
  assert.deepEqual(readViewedImages(file, 0, state, true).map(({ path, ok }) => ({ path, ok })), [{ path: 'late-call.png', ok: true }]);
});

test('Codex 收尾把无换行的最后一次看图写进结果和事件', async (t) => {
  const h = sandbox(t), picture = path.join(h.cwd, 'last.png');
  const s = h.scenario({ rollout_no_newline: true, rollout: [viewOutput(), viewed(picture)].map(({ timestamp, ...r }) => r) });
  const r = output(await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot'], { env: s.env }));
  assert.deepEqual(r.viewed_images, [{ path: picture, ok: true }]);
  assert.deepEqual(h.events(r.run_id).filter((e) => e.type === 'image.viewed').map((e) => e.path), [picture]);
});

test('apply_patch 补丁中的看图和出图代码不记为工具调用', async (t) => {
  const h = sandbox(t), s = h.scenario({ rollout: [{ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'patch',
    input: '*** Begin Patch\n*** Add File: example.mjs\n+await tools.view_image({path:"x.png"});\n+await tools.image_gen__imagegen({transparent_background:true});\n*** End Patch' } }] });
  const r = output(await h.bridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot'], { env: s.env, input: '修改 image_gen 调用代码' }));
  assert.equal(r.viewed_images, undefined); assert.equal(r.image_calls, undefined);
  assert.ok(!h.events(r.run_id).some((e) => e.type === 'image.viewed'));
});

test('会话文件在扫描后被删时任务照常结束并保留 result.json', async (t) => {
  const h = sandbox(t), picture = path.join(h.cwd, 'deleted-log.png'), file = sessionFile(h);
  const s = h.scenario({ steps: [{ wait_for: path.join(h.cwd, 'release') }] });
  const running = h.startBridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot'], { env: s.env });
  const meta = await h.running(); await poll(() => h.calls().some((c) => c.operation === 'exec'), '假工具开始');
  write(file, [viewed(picture), viewOutput()].map((r) => JSON.stringify(r)).join('\n') + '\n');
  await poll(() => h.events(meta.id).some((e) => e.type === 'image.viewed'), '首次看图扫描');
  fs.unlinkSync(file); await new Promise((resolve) => setTimeout(resolve, 2200)); h.write('release', 'go');
  const r = output(await running.done);
  assert.equal(r.status, 'done'); assert.deepEqual(r.viewed_images, [{ path: picture, ok: true }]);
  assert.deepEqual(json(path.join(r.run_dir, 'result.json')), r);
});

test('运行中增量采集 view_image，事件、活动步骤、时间线和续接只含本轮', async (t) => {
  const h = sandbox(t), picture = path.join(h.cwd, 'login-button.png'), file = sessionFile(h);
  const s = h.scenario({ hold: true });
  const running = h.startBridge(['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--no-snapshot', '--group', 'views', '--scope', 'out'], { env: s.env });
  const meta = await h.running();
  await poll(() => h.calls().some((c) => c.operation === 'exec'), '假工具开始');
  write(file, JSON.stringify(viewed(picture)) + '\n');
  await poll(() => h.events(meta.id).some((e) => e.type === 'image.viewed'), '看图实时事件');
  assert.equal(output(await h.bridge(['status', '--run', meta.id])).activity.step, D.stepImageViewed('login-button.png'));
  fs.appendFileSync(file, JSON.stringify(viewOutput()) + '\n');
  output(await h.bridge(['cancel', '--run', meta.id]));
  const result = output(await running.done, 1);
  assert.deepEqual(result.viewed_images, [{ path: picture, ok: true }]);
  assert.equal(result.commands_executed, 0); assert.equal(result.generated_images, undefined);
  assert.deepEqual(h.events(meta.id).filter((e) => e.type === 'image.viewed').map((e) => e.path), [picture]);
  const timeline = await h.bridge(['watch', '--run', meta.id]);
  assert.ok(timeline.stdout.includes(`│   ◉ ${D.watchImageViewed('login-button.png')}`), timeline.stdout);
  const verbose = await h.bridge(['watch', '--run', meta.id, '--verbose']);
  assert.ok(verbose.stdout.includes(`◉ ${D.watchImageViewed(picture)}`));
  const nextPicture = path.join(h.cwd, 'next.png');
  const resume = h.scenario({ append_rollout: true, rollout: [viewed(nextPicture, 'next-view'), viewOutput('next-view')].map(({ timestamp, ...r }) => r) }, 'resume-views');
  const next = output(await h.bridge(['resume', '--run', meta.id, '--level', 'complex', '--brief', '-', '--no-snapshot'], { env: resume.env }));
  assert.deepEqual(next.viewed_images, [{ path: nextPicture, ok: true }]);
  assert.deepEqual(h.events(next.run_id).filter((e) => e.type === 'image.viewed').map((e) => e.path), [nextPicture]);
});

test('opencode 费用在 status、watch 两种结束用量和组汇总显示，费用单独存在也显示', async (t) => {
  const h = sandbox(t), c = baseConfig(); c.agents.oc = opencodeAgent(); c.modules.discuss.complex = [{ agent: 'oc' }]; h.config(c);
  const s = h.scenario({ last_message: discussion, export_messages: [{ type: 'assistant', tokens: { input: 10, output: 5 }, cost: 0.00138 }] });
  const r = output(await h.bridge(['discuss', '--cwd', h.cwd, '--level', 'complex', '--brief', '-', '--group', 'cost-group'], { env: s.env }));
  assert.equal(r.cost_usd, 0.00138);
  for (const args of [['status'], ['watch', '--run', r.run_id], ['watch', '--run', r.run_id, '--verbose'], ['watch', '--group', 'cost-group']]) {
    const display = await h.bridge(args); assert.equal(display.code, 0);
    assert.ok(display.stdout.split('\n').some((s) => s.includes('token') && s.endsWith(` · ${D.costUsd('0.0014')}`)), display.stdout);
  }
  seedRun(h, 'cost-only', { group: 'cost-only' }, { status: 'done', duration_s: 1, usage: null, cost_usd: 0, errors: [] });
  for (const args of [['status', '--group', 'cost-only'], ['watch', '--run', 'cost-only'], ['watch', '--run', 'cost-only', '--verbose'], ['watch', '--group', 'cost-only']]) {
    const display = await h.bridge(args); assert.ok(display.stdout.includes(D.costUsd('0')), display.stdout); assert.ok(!display.stdout.includes('token'));
  }
  assert.deepEqual([0, 0.001, 0.00138, 0.125, 1.234].map(formatUsd), ['0', '0.0010', '0.0014', '0.125', '1.23']);
});

test('审查计划保存实际默认未提交范围，旧 false 计划启动仍审未提交改动', async (t) => {
  const h = sandbox(t); h.initGit(); h.write('source.txt', 'after\n');
  const args = ['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'review-default', '--seat', 'codex'];
  const p = output(await h.bridge(args)); assert.equal(p.review.uncommitted, true);
  const saved = json(p.file); saved.review.uncommitted = false; write(p.file, saved);
  const r = output(await h.bridge(['review', '--plan', p.plan_id, '--seat', 1, '--brief', '-']));
  assert.equal(r.review_scope.kind, 'uncommitted'); assert.equal(r.stale, false);
  assert.equal(output(await h.bridge([...args, '--base', 'HEAD'])).review.uncommitted, false);
  assert.equal(output(await h.bridge([...args, '--commit', 'HEAD'])).review.uncommitted, false);
});

test('项目关格的派出和续接错误仅在显式 --agent 时提点名', async (t) => {
  const h = sandbox(t); h.write('.claude/foreman.json', { modules: { run: { complex: 'claude code' } } });
  seedRun(h, 'parent', { module: 'run', cell: 'complex' });
  for (const args of [['run', '--cwd', h.cwd, '--level', 'complex', '--brief', '-'], ['resume', '--run', 'parent', '--level', 'complex', '--brief', '-']]) {
    for (const named of [false, true]) {
      const r = await h.bridge([...args, ...(named ? ['--agent', 'codex'] : [])]);
      failed(r, M.cellClosedByProject('modules.run.complex', named)); assert.equal(r.stderr.includes('--agent'), named);
    }
  }
});

test('看图读取一次读不满时读到文件末尾，收尾时没写完的末行留到下次', (t) => {
  const h = sandbox(t), file = path.join(h.home, 'short.jsonl');
  write(file, [viewed('short.png', 'short'), viewOutput('short')].map((r) => JSON.stringify(r)).join('\n'));
  const readSync = fs.readSync;
  fs.readSync = (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, Math.min(length, 25), position);
  try { assert.deepEqual(readViewedImages(file, 0, {}, true).map(({ path, ok }) => ({ path, ok })), [{ path: 'short.png', ok: true }]); }
  finally { fs.readSync = readSync; }
  const state = {}, partial = JSON.stringify(viewed('later.png', 'later'));
  write(file, partial.slice(0, 40));
  assert.deepEqual(readViewedImages(file, 0, state, true), []);
  fs.appendFileSync(file, `${partial.slice(40)}\n`);
  assert.deepEqual(readViewedImages(file, 0, state).map((r) => r.path), ['later.png']);
});
