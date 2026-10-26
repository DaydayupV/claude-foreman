import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, failed, seedRun, expected, normalize, json, write, poll, baseConfig, MESSAGES } from './helpers.mjs';
import { command, discussion } from './fixtures/reports.mjs';
import { liveGroup, frameOf, steadyClock } from './fixtures/watch-live.mjs';
import { wrapAtDots, createTimeline } from '../foreman/skills/dispatch/scripts/watch-timeline.mjs';
import { watchRecords } from './fixtures/watch.mjs';
import { textWidth, wrapWidth } from '../foreman/skills/dispatch/scripts/util.mjs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import * as Display from '../foreman/skills/dispatch/scripts/display.mjs';
import { createFeed, buildReplay, runMessage, normalize as normalizeEvent } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
const M = MESSAGES.zh;
import { D as displayText } from '../foreman/skills/dispatch/scripts/display.mjs';
const D = { ...MESSAGES.en, ...displayText }; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// 组视图里每席的身份行以席位号开头："1 ● gpt-6-astra max · Codex CLI    running <CLOCK>"
const seatHead = (mark) => new RegExp(`^\\d ${mark === '?' ? '\\?' : mark} `);

for (const size of ['100x30', '64x18']) test(`组视图实时面板按 ${size} 的终端排版：每席顶上是最近说的话，下面是折叠后的动作`, async (t) => {
  const h = sandbox(t);
  const { group } = liveGroup(h, process.pid);
  const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: size });
  const [width, height] = size.split('x').map(Number);
  assert.equal(frame.length, height);
  for (const line of frame) assert.ok(textWidth(line) < width, line);
  expected(`watch-live-${size}.txt`, `${steadyClock(frame).join('\n')}\n`);
  // 英文插件画出来一模一样
  assert.deepEqual(steadyClock(await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: size, FOREMAN_LANG: 'en' })), steadyClock(frame));
});

test('40 列的四席身份行都保留状态词和时钟，API 排队和回答时也一样', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  for (const [phase, event] of [[D.apiPhases.thinking, null], [D.apiPhases.queued, { type: 'api.queued' }], [D.apiPhases.answering, { type: 'api.content', total_chars: 3200 }]]) {
    if (event) fs.appendFileSync(path.join(h.runs, seats[3].id, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '40x30' });
    for (const line of frame) assert.ok(textWidth(line) < 40, line);
    const heads = steadyClock(frame).filter((line) => /^\d [●⋯] /.test(line));
    assert.equal(heads.length, 4);
    heads.forEach((head, i) => assert.ok(head.endsWith(`${i === 3 ? phase : 'running'} <CLOCK>`), head));
    // 排队用黄色的 ⋯
    if (phase === D.apiPhases.queued) assert.match(heads[3], /^4 ⋯ /);
  }
  seedRun(h, seats[0].id, { ...json(path.join(h.runs, seats[0].id, 'meta.json')), status: 'done', pid: 0 }, { status: 'done', duration_s: 3, stale: true, report: discussion });
  const finished = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '40x30' });
  const head = finished.find((line) => seatHead('✔').test(line));
  assert.match(head, /^1 ✔ .+ {2,}done 0:03$/);
  assert.ok(textWidth(head) < 40, head);
  // 材料变了不挤在身份行里，写在正文里（窄窗口里折成几行）
  assert.ok(finished.some((line) => line.startsWith(`    ⚠ ${D.watchStale.split(' ')[0]}`)), finished.join('\n'));
});

test('64 列先保留状态词和时钟，再截模型标签；身份行不写计数', async (t) => {
  const h = sandbox(t);
  const { group } = liveGroup(h, process.pid);
  const frame = steadyClock(await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '64x30' }));
  const heads = frame.filter((line) => seatHead('●').test(line));
  assert.equal(heads.length, 4);
  assert.match(heads[0], /^1 ● gpt-6-astra max · Codex CLI +running <CLOCK>$/);
  assert.match(heads[1], /^2 ● deepseek-v4\.1-flash max · Opencode CLI +running <CLOCK>$/);
  assert.match(heads[2], /^3 ● mimo-v2\.6-pro high · Pi CLI +running <CLOCK>$/);
  assert.match(heads[3], /^4 ● kimi-k2\.6 · API +thinking <CLOCK>$/);
});

test('needs_input 的长状态在 40 列不越界，44 列能保留时钟', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  seedRun(h, seats[0].id, { ...json(path.join(h.runs, seats[0].id, 'meta.json')), status: 'needs_input', pid: 0 }, { status: 'needs_input', duration_s: 3 });
  for (const cols of [40, 44]) {
    const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: `${cols}x30` });
    for (const line of frame) assert.ok(textWidth(line) <= cols - 1, line);
    const head = frame.find((line) => seatHead('?').test(line));
    assert.match(head, cols === 40 ? /^1 \? \S+ +waiting for an answer, stopped$/ : /^1 \? \S+ +waiting for an answer, stopped 0:03$/);
  }
});

test('30 列和 22 列的 API 排队、回答及 Codex 运行身份行都不越界', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  for (const [phase, event] of [[D.apiPhases.queued, { type: 'api.queued' }], [D.apiPhases.answering, { type: 'api.content', total_chars: 3200 }]]) {
    fs.appendFileSync(path.join(h.runs, seats[3].id, 'events.jsonl'), `${JSON.stringify(event)}\n`);
    for (const cols of [30, 22]) {
      const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: `${cols}x12` });
      for (const line of frame) assert.ok(textWidth(line) <= cols - 1, line);
      const heads = steadyClock(frame).filter((line) => /^\d [●⋯] /.test(line));
      assert.ok(heads.length >= 1);
      assert.match(heads[0], / running <CLOCK>$/);
    }
  }
});

test('22 列也不越界：单任务的时间线、角色模式的长角色名和组汇总的 run_id 行', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  seats.forEach((s, i) => { const file = path.join(h.runs, s.id, 'meta.json'); write(file, { ...json(file), role: `很长很长的角色名称第 ${i + 1} 位` }); });
  for (const args of [['watch', '--run', seats[0].id, '--no-intro'], ['watch', '--run', seats[3].id, '--no-intro'], ['watch', '--group', group, '--no-intro']]) {
    const frame = await frameOf(h, args, { FOREMAN_TEST_SCREEN: '22x20' });
    for (const line of frame) assert.ok(textWidth(line) <= 21, `${args.join(' ')}\n${line}`);
  }
  const r = sandbox(t);
  watchRecords(r);
  const out = await r.bridge(['watch', '--group', 'watch-group'], { env: { FOREMAN_TEST_SCREEN: '22x30' } });
  // 回看命令和 run_id 不截断（要能照着复制），只有它们可以超宽
  const ids = ['a', 'b', 'c', 'd'];
  for (const line of out.stdout.split('\n').filter((l) => !l.startsWith('node ') && !ids.includes(l.trim()))) assert.ok(textWidth(line) <= 21, line);
  for (const id of ids) assert.ok(out.stdout.split('\n').some((l) => l.trim() === id || l.endsWith(` ${id}`)), id);
});

test('角色模式的分工行只写角色；标题里带着角色的旧写法，标题行去掉角色，不当成拆分', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  const roles = ['架构师', '安全与可靠性红队', '极简派', '边界清单员'];
  seats.forEach((s, i) => { const file = path.join(h.runs, s.id, 'meta.json'); write(file, { ...json(file), role: roles[i], title: `多角色模式［${roles[i]}］` }); });
  const frame = (await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x40' })).map(plain);
  assert.match(frame[0], /^discuss · roles · complex +●4$/);
  for (const role of roles) assert.ok(frame.includes(`    ${role}`), frame.join('\n'));
  assert.ok(!frame.some((l) => l.includes('多角色模式')), frame.join('\n'));
  // 同一个标题加上不同角色时，标题行只写一次标题
  seats.forEach((s, i) => { const file = path.join(h.runs, s.id, 'meta.json'); write(file, { ...json(file), title: `登记锁重试［${roles[i]}］` }); });
  const again = (await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x40' })).map(plain);
  assert.match(again[0], /^discuss · roles · 登记锁重试 · complex +●4$/);
});

test('组视图里结束了的席位在结论下面写用量和 run_id，和单任务结尾一致；拍快照时写出来，不留一片空白', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  const usage = { input_tokens: 1200, cached_input_tokens: 300, output_tokens: 40 };
  seedRun(h, seats[0].id, { ...json(path.join(h.runs, seats[0].id, 'meta.json')), status: 'done', pid: 0 }, { status: 'done', duration_s: 3, usage, usage_scope: 'this_run', report: discussion });
  fs.appendFileSync(path.join(h.runs, seats[1].id, 'events.jsonl'), `${JSON.stringify({ type: 'foreman.snapshot', phase: 'start', ts: new Date().toISOString() })}\n`);
  const frame = (await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x40' })).map(plain);
  const start = frame.findIndex((l) => l.startsWith('1 ✔ '));
  const block = frame.slice(start, frame.findIndex((l, i) => i > start && l.startsWith('─')));
  assert.match(block.at(-1), new RegExp(`^ {4}tokens: in 1,200 .* +${seats[0].id}$`), block.join('\n'));
  assert.ok(frame.some((l) => l.includes(D.watchSnapshotShort)), frame.join('\n'));
  // 窄窗口放不下这句时换成更短的说法，不在单词中间截断
  const narrow = (await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '40x40' })).map(plain);
  assert.ok(narrow.some((l) => l.trim() === D.watchSnapshotTiny), narrow.join('\n'));
  const single = (await frameOf(h, ['watch', '--run', seats[1].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '160x16' })).map(plain);
  assert.ok(single.at(-1).includes(D.watchSnapshotStart.slice(0, 30)), single.at(-1));
  // 40 列时底行放不下整句，换成短的说法，不在单词中间截断
  const narrowSingle = (await frameOf(h, ['watch', '--run', seats[1].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '40x16' })).map(plain);
  assert.ok([D.watchSnapshotShort, D.watchSnapshotTiny, D.watchSnapshotMini].some((s) => narrowSingle.at(-1).includes(s)), narrowSingle.at(-1));
  assert.ok(!/snapsh…|snapsho…/.test(narrowSingle.at(-1)), narrowSingle.at(-1));
  // 拍完以后正文里不再留着这句；没有别的内容的席位写"进行中"
  const file = path.join(h.runs, seats[1].id, 'events.jsonl');
  fs.writeFileSync(file, [{ type: 'foreman.snapshot', phase: 'start' }, { type: 'foreman.snapshot', phase: 'done', seconds: 76 }].map((e) => JSON.stringify({ ...e, ts: new Date().toISOString() })).join('\n') + '\n');
  const after = (await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x40' })).map(plain);
  const seat2 = after.slice(after.findIndex((l) => l.startsWith('2 ● ')), after.findIndex((l) => l.startsWith('3 ● ')));
  assert.ok(!seat2.some((l) => l.includes(D.watchSnapshotShort)), seat2.join('\n'));
  assert.ok(seat2.includes(`    ${D.watchWorking}`), seat2.join('\n'));
});

test('真实派活时快照的两条事件留在 events.jsonl 开头，协作方的事件接在后面，时间线里两句都在', async (t) => {
  const h = sandbox(t);
  const r = await h.bridge(taskArgs(h));
  assert.equal(r.code, 0, r.stderr);
  const run = JSON.parse(r.stdout);
  const events = fs.readFileSync(path.join(run.run_dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.slice(0, 2).map((e) => [e.type, e.phase]), [['foreman.snapshot', 'start'], ['foreman.snapshot', 'done']]);
  assert.ok(events.length > 2 && events.slice(2).every((e) => e.type !== 'foreman.snapshot'), JSON.stringify(events.map((e) => e.type)));
  const watched = await h.bridge(['watch', '--run', run.run_id]);
  assert.ok(watched.stdout.includes(D.watchSnapshotStart.slice(0, 30)) && watched.stdout.includes(D.watchSnapshotDone('0s')), watched.stdout);
});

test('窄窗口里折叠行也不越界、单复数正确；拍快照的提示不折叠', async (t) => {
  const h = sandbox(t);
  const ts = new Date().toISOString();
  const long = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 段说明`).join('\n');
  seedRun(h, '20000101-long', { status: 'running', pid: process.pid, ended_at: undefined }, null, [
    { type: 'foreman.snapshot', phase: 'start', ts }, { type: 'foreman.snapshot', phase: 'done', seconds: 68, ts },
    { type: 'item.completed', ts, item: { type: 'agent_message', text: long } },
  ]);
  const frame = (await frameOf(h, ['watch', '--run', '20000101-long', '--no-intro'], { FOREMAN_TEST_SCREEN: '40x60' })).map(plain);
  for (const line of frame) assert.ok(textWidth(line) <= 39, line);
  assert.ok(frame.some((l) => l.includes(`(${10} more lines;`.slice(0, 6))), frame.join('\n'));
  // 快照的提示折了好几行也写全，下一行接着写完成
  const text = frame.join('\n');
  assert.ok(!/Taking a snapshot[\s\S]*more line[\s\S]*Snapshot taken/.test(text), text);
  assert.ok(text.includes('minutes'), text);
  assert.equal(D.watchMoreLines(1), '(1 more line; add --verbose to see everything)');
  // 30 列放不下整句时只写还有几行，不在单词中间截断
  const tiny = (await frameOf(h, ['watch', '--run', '20000101-long', '--no-intro'], { FOREMAN_TEST_SCREEN: '30x60' })).map(plain);
  assert.ok(tiny.some((l) => l.trim().endsWith(D.watchMoreLinesShort(10))) && !tiny.some((l) => l.includes('add --')), tiny.join('\n'));
  // 单任务结尾的用量行在" · "处折行，行尾不挂分隔符
  const r = sandbox(t);
  watchRecords(r);
  const usage = (await r.bridge(['watch', '--run', 'a'], { env: { FOREMAN_TEST_SCREEN: '30x30' } })).stdout.split('\n').filter((l) => /^ {8}\S/.test(l));
  assert.ok(usage.length > 1 && usage.every((l) => !/[·/]$/.test(l.trim())), usage.join('\n'));
});

test('Claude Code 席的单席查看：没有事件时不画孤零零的竖线', async (t) => {
  const h = sandbox(t);
  seedRun(h, '20000101-host', { participant: 'host', mode: 'submit', kind: 'discuss', module: 'discuss', agent: 'claude-code', agent_type: 'host', model: 'host-model', submitted_at: new Date().toISOString(), round: 1 }, { status: 'done', report: discussion });
  const r = await h.bridge(['watch', '--run', '20000101-host']);
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n');
  const end = lines.findIndex((l) => l.includes('└'));
  assert.ok(end > 0 && !/^ +│\s*$/.test(lines[end - 1]), r.stdout);
});

test('直接输出时，一条命令迟迟没有结束，也不压着后面说的话', async (t) => {
  const h = sandbox(t);
  const ts = new Date().toISOString();
  seedRun(h, '20000101-stuck', { status: 'running', pid: process.pid, ended_at: undefined }, null, [
    { type: 'item.started', ts, item: { id: 'slow', type: 'command_execution', command: 'node slow.mjs' } },
    { type: 'item.completed', ts, item: { type: 'agent_message', text: '命令还在跑，先说一句' } },
  ]);
  const watch = h.startBridge(['watch', '--run', '20000101-stuck', '--no-intro']);
  await poll(() => watch.stdout.includes('命令还在跑，先说一句'), '没结束的命令之后的消息');
  assert.ok(watch.stdout.indexOf('$ node slow.mjs') < watch.stdout.indexOf('命令还在跑'), watch.stdout);
  watch.stop();
  await watch.done;
});

test('最终汇总的用量按分隔符折行，长改动说明在 83 列和 40 列都写全，run_id 靠右', async (t) => {
  const h = sandbox(t);
  watchRecords(h);
  for (const width of [83, 40]) {
    const r = await h.bridge(['watch', '--group', 'watch-group'], { env: { FOREMAN_TEST_SCREEN: `${width}x30` } });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split('\n');
    const start = lines.findIndex((line) => line.startsWith('✔ fake-codex high'));
    assert.ok(start >= 0, r.stdout);
    assert.match(lines[start], / done 0:03$/);
    assert.equal(lines[start + 1], '  合成a · complex');
    assert.equal(lines[start + 2], '  合成任务已完成');
    const usage = lines.slice(start + 3, lines.findIndex((line, i) => i > start && line.startsWith('─')));
    for (const line of usage) assert.ok(textWidth(line) < width && line.startsWith('  '), line);
    assert.equal(usage.join('\n').includes('…'), false);
    // 在分隔符处折行时那个" · "省掉，比较时都去掉
    const words = (s) => s.replaceAll(' · ', ' ').replace(/\s+/g, ' ').trim();
    assert.equal(words(usage.join(' ')).replace(/ a$/, ''), words(D.dots([D.watchChanged(1, 1, 1), 'tokens: in 120 (cached 25%) · out 40'])));
    assert.ok(usage.at(-1).endsWith(' a'), usage.join('\n'));
  }
});

test('实时面板只给状态上色：任务行和模型行加粗，模型行跟着状态变色，动作和思考摘要用暗色，说的话用默认色', async (t) => {
  const h = sandbox(t);
  const { group } = liveGroup(h, process.pid);
  const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x30', NO_COLOR: '' });
  assert.match(frame[0], /^\x1b\[1mdiscuss · panel · 合成讨论：登记锁原地重试 · complex\x1b\[0m +\x1b\[36m●4\x1b\[0m$/);
  // 计划进行中、没有缺口时不写计划行
  assert.equal(plain(frame[1]), '─'.repeat(99));
  assert.match(frame[2], /^\x1b\[2m1\x1b\[0m \x1b\[36m●\x1b\[0m \x1b\[1m\x1b\[36mgpt-6-astra max · Codex CLI\x1b\[0m\x1b\[0m +\x1b\[36mrunning\x1b\[0m\x1b\[2m \d+:\d\d\x1b\[0m$/);
  assert.ok(frame[3].startsWith('    ◆ 先看一下登记锁') && !frame[3].includes('\x1b['), frame[3]);
  for (const line of ['    \x1b[2mread tests/admission.test.mjs\x1b[0m', '    \x1b[2msearch **/*.lock\x1b[0m', `    \x1b[2m${D.watchThinking('删除挂起时 openSync 会报 EPERM，要确认重试的上限是多少。')}\x1b[0m`]) {
    assert.ok(frame.includes(line), line);
  }
  // 失败的命令在行尾标红
  assert.ok(frame.some((l) => l.includes('$ node --test tests/admission.test.mjs') && l.endsWith(`\x1b[31m✗ ${D.watchExitTag(1)}\x1b[0m`)), frame.join('\n'));
  // API 的思考原文不在面板里滚动，身份行右边只写思考了多久
  assert.match(plain(frame.find((l) => l.includes('kimi-k2.6 · API'))), /^4 ● kimi-k2\.6 · API +thinking \d+:\d\d$/);
  assert.ok(!frame.some((l) => l.includes('先确认登记锁的语义')));
});

test('组视图窗口不够高时先把正文压到每席一行，还放不下就翻看，底部写下面还有多少行', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  // 讨论各席标题不同时，标题行写"甲 / 乙"；只有拆开的执行任务才在每席的分工行写自己的标题
  seats.forEach((s, i) => { const file = path.join(h.runs, s.id, 'meta.json'); write(file, { ...json(file), title: `合成任务 ${i + 1}` }); });
  const four = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '64x18' });
  assert.ok(plain(four[0]).startsWith('discuss · panel · 合成任务 1 / 合成任务 2'), four[0]);
  for (const line of four) assert.ok(textWidth(line) < 64, line);
  assert.ok(!four.map(plain).some((line) => line.startsWith('    合成任务')), four.join('\n'));
  for (const n of [5, 6]) seedRun(h, `20000101-00000${n}-eeee`, { mode: 'discuss', kind: 'discuss', title: `合成任务 ${n}`, status: 'running', pid: process.pid, group, ended_at: undefined });
  const six = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '64x16' });
  assert.equal(six.length, 16);
  for (const line of six) assert.ok(textWidth(line) < 64, line);
  assert.match(plain(six.at(-1)), /^↓ \d+ more lines? below +1–6 open a seat · ↑↓ scroll · q quit$/);
});

test('组视图汇总最后写回看命令：说明一行，命令单独一行，记录目录带空格时给路径加引号，换上 run_id 就能运行', async (t) => {
  const h = sandbox(t);
  h.runs = path.join(h.home, 'my runs');
  const c = baseConfig();
  c.dispatch.runs_dir = h.runs;
  h.config(c);
  seedRun(h, '20000101-a', { group: 'spaced' }, { status: 'done', duration_s: 1 });
  const r = await h.bridge(['watch', '--group', 'spaced']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.trimEnd().endsWith(`${D.watchReplayOne('').trimEnd()}\nnode "${path.join(h.runs, 'watch.mjs')}" --run <run_id>`), r.stdout);
  assert.ok(r.stdout.includes(' 20000101-a\n'), r.stdout);
});

test('单任务的实时画面：顶部固定身份行和任务行，读文件和搜索照写，思考摘要在底部，失败的命令行尾标出', async (t) => {
  const h = sandbox(t);
  const { seats } = liveGroup(h, process.pid);
  const pi = steadyClock(await frameOf(h, ['watch', '--run', seats[2].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '120x16' }));
  assert.match(pi[0], /^● mimo-v2\.6-pro high · Pi CLI +running <CLOCK>$/);
  assert.equal(pi[1], '  discuss · 合成讨论：登记锁原地重试 · complex');
  assert.ok(pi.includes('      │   read foreman/skills/dispatch/scripts/records.mjs'));
  assert.ok(pi.includes('      │   search ls tests'));
  assert.ok(!pi.some((l) => l.includes('Checking the lock')));
  assert.match(pi.at(-1), new RegExp(`^⠋ ${D.watchThinking('删除挂起时 openSync 会报 EPERM，要确认重试的上限是多少。')} +↑↓ scroll · q quit$`));
  const codex = steadyClock(await frameOf(h, ['watch', '--run', seats[0].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '120x18' }));
  const failure = codex.findIndex((l) => l.startsWith('      │   $ node --test tests/admission.test.mjs'));
  assert.ok(failure > 0 && codex[failure].endsWith(`✗ ${D.watchExitTag(1)}`), codex.join('\n'));
  assert.equal(codex[failure + 1], `      │   ${D.watchFolded(D.foldKinds.command(2))}`);
});

test('status 表：状态词和用时写英文，中英两个插件一样；模式和等级写原词，模型标签写成"模型 强度 · 接入方式"，各列按显示宽度对齐', async (t) => {
  const h = sandbox(t);
  const usage = { input_tokens: 585000, cached_input_tokens: 503100, output_tokens: 19000 };
  seedRun(h, '20000101-a', { mode: 'discuss', kind: 'discuss', agent: 'oc', agent_type: 'opencode cli', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', title: '合成讨论' },
    { status: 'done', duration_s: 572, usage, usage_scope: 'this_run', last_request: { tokens: 81000, window: 486000 }, cost_usd: 0.066, cost_source: 'api_price', report: discussion });
  seedRun(h, '20000101-b', { status: 'failed' }, { status: 'failed', duration_s: 3 });
  seedRun(h, '20000101-c', {}, { status: 'done', needs_decision: true, duration_s: 61 });
  seedRun(h, '20000101-d', { status: 'running', pid: process.pid, ended_at: undefined }, null, [command('item.started')]);
  const r = await h.bridge(['status']);
  assert.equal(r.code, 0, r.stderr);
  // 运行中那一行的计时和最后活动时间会走，比对前换掉
  const steady = (s) => normalize(s, { [h.cwd]: '<CWD>' }).replace(/^(20000101-d .*?) \d+:\d\d /m, '$1 <CLOCK> ').replace(/last activity [\d.]+ min ago/, 'last activity <N> min ago');
  expected('status-list.txt', steady(r.stdout));
  // 英文插件显示得一模一样
  assert.equal(steady((await h.bridge(['status'], { env: { FOREMAN_LANG: 'en' } })).stdout), steady(r.stdout));
  // 终端里只给状态记号和状态词上色，模型和标题加粗，用时和用量用暗色
  const colored = await h.bridge(['status'], { env: { FOREMAN_TEST_SCREEN: '100x30', NO_COLOR: '' } });
  assert.ok(colored.stdout.includes('\x1b[32m✔ done\x1b[0m'), colored.stdout);
  assert.ok(colored.stdout.includes('\x1b[1mdeepseek-v4.1-flash max · Opencode CLI\x1b[0m'));
  assert.ok(colored.stdout.includes('\x1b[2mtook 9m 32s\x1b[0m'));
});

test('开工那一行中英两个插件都写 <模式> started · <模型> <强度> · <接入方式> · <等级> · run dir，用" · "分隔', async (t) => {
  const h = sandbox(t);
  for (const lang of ['zh', 'en']) {
    const r = await h.bridge(taskArgs(h), { env: { FOREMAN_LANG: lang } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes(`foreman: run started · fake-codex max · Codex CLI · complex · run dir ${JSON.parse(r.stdout).run_dir}\n`), r.stderr);
  }
});

test('网页看板开着、看板服务在跑时，开工那一行后面紧跟这个对话的看板地址；看板关着或服务没在跑时不给', async (t) => {
  const h = sandbox(t), config = baseConfig(), lock = path.join(h.runs, 'board.lock.json');
  const boardLine = (r) => r.stderr.split('\n').find((line) => line.startsWith('foreman: web board ')) ?? null;
  config.dispatch.watch = { terminal: true, web: true };
  h.config(config);
  // 没有锁文件，或者锁里的进程已经不在：不给
  assert.equal(boardLine(await h.bridge(taskArgs(h))), null);
  write(lock, { pid: 2 ** 22 + 7, port: 4321, token: 'deadbeef' });
  assert.equal(boardLine(await h.bridge(taskArgs(h))), null);
  // 服务在跑（锁里是活着的进程）：紧跟在开工那一行后面，带上这个对话的 id
  write(lock, { pid: process.pid, port: 4321, token: 'deadbeef' });
  const r = await h.bridge(taskArgs(h)), lines = r.stderr.split('\n');
  const at = lines.findIndex((line) => line.startsWith('foreman: run started · '));
  assert.equal(lines[at + 1], 'foreman: web board http://127.0.0.1:4321/deadbeef/?level=all&lang=zh&s=test-session');
  // 网页看板关着：不给
  config.dispatch.watch = { terminal: true, web: false };
  h.config(config);
  assert.equal(boardLine(await h.bridge(taskArgs(h))), null);
});

test('子命令认 --help 和 -h：只打印这一条的用法，退出码 0，不生成配置文件，也不迁移旧版的配置', async (t) => {
  const h = sandbox(t, { config: false });
  // 旧版 codex-bridge 的配置还在、新配置还没有：平常第一次运行就会复制过去，--help 不该动它
  const legacy = write(path.join(h.home, '.claude', 'codex-bridge.json'), baseConfig());
  for (const flag of ['--help', '-h']) {
    for (const cmd of Object.keys(M.help)) {
      const r = await h.bridge([cmd, flag]);
      assert.equal(r.code, 0, `${cmd} ${flag}`);
      assert.equal(r.stdout, `${M.help[cmd]}\n`, `${cmd} ${flag}`);
      assert.equal(r.stderr, '', `${cmd} ${flag}`);
    }
    assert.equal((await h.bridge(['plan', '--module', 'image', flag])).stdout, `${M.help.plan}\n`); // 跟在其他参数后面也认
    assert.equal((await h.bridge(['assets', flag])).stdout, `${M.assetsUsage}\n`);
    for (const action of Object.keys(M.assetsActions)) {
      const r = await h.bridge(['assets', action, flag]);
      assert.equal(r.code, 0, action);
      assert.equal(r.stdout, `${M.assetsHelp(action)}\n`, action);
    }
    const usage = await h.bridge([flag]);
    assert.equal(usage.code, 0, flag); assert.equal(usage.stdout, `${M.usage}\n`);
    assert.equal((await h.bridge(['watch', flag], { env: { FOREMAN_LANG: 'en' } })).stdout, `${MESSAGES.en.help.watch}\n`);
    failed(await h.bridge(['bogus', flag]), M.usage);
    failed(await h.bridge(['assets', 'bogus', flag]), M.assetsUsage);
  }
  // 总用法末尾指向各子命令自己的 --help，不再让人去翻 references/cli.md
  for (const usage of [M.usage, MESSAGES.en.usage]) assert.ok(usage.endsWith('--help (or -h)') || usage.endsWith('--help（或 -h）查看'), usage);
  for (const cmd of ['run', 'discuss', 'review', 'resume', 'image', 'plan', 'status', 'watch', 'cancel']) assert.ok(M.help[cmd], cmd);
  assert.equal(fs.existsSync(h.userConfig), false);
  assert.deepEqual(fs.readdirSync(path.dirname(legacy)), ['codex-bridge.json']);
  // 写在选项的值里的 --help、-h 不算：这是一个标题叫 --help 的普通派活，照常因为缺 --level 报错
  for (const flag of ['--help', '-h']) {
    const titled = await h.bridge(['run', '--cwd', h.cwd, '--title', flag, '--brief', '-']);
    assert.equal(titled.code, 2, flag);
    assert.ok(titled.stderr.includes(M.missingLevel('simple / normal / complex')), titled.stderr);
  }
});

test('折行时英文单词放得下一整行就不拆开，比一整行还长的才截断', () => {
  assert.deepEqual(wrapWidth('answer submitted by Claude Code; no usage recorded', 15), ['answer', 'submitted by', 'Claude Code; no', 'usage recorded']);
  assert.deepEqual(wrapWidth('last request 23k', 13), ['last request', '23k']);
  // 用量折行：没有 "/" 的段按整行宽度折，有 "/" 的才少两列、把 "/" 挪到下一行开头
  assert.deepEqual(wrapAtDots('answer submitted by Claude Code; no usage recorded', 17), ['answer submitted', 'by Claude Code;', 'no usage recorded']);
  assert.deepEqual(wrapAtDots('out 310 · last request 23k / window 486k', 21), ['out 310', 'last request 23k', '/ window 486k']);
  assert.deepEqual(wrapWidth('tokens: in 67k (cached 66%)', 13), ['tokens: in', '67k (cached', '66%)']);
  // 比一整行还长的单词才按字截断
  const long = wrapWidth('a supercalifragilisticexpialidocious word', 12);
  assert.ok(long.every((l) => textWidth(l) <= 12), long.join('|'));
  assert.equal(long.join('').replace(/\s/g, ''), 'asupercalifragilisticexpialidociousword');
});

// 在内存里执行真实构建入口，拦住唯一的写操作，避免改动由调度方构建的 index.html。
let builtPage;
function buildPage() {
  if (builtPage) return builtPage;
  const url = new URL('../board/build.mjs', import.meta.url);
  const source = fs.readFileSync(url, 'utf8').replace(/^import .*;\r?\n/gm, '').replaceAll('import.meta.url', 'buildUrl');
  vm.runInNewContext(source, { fs: { ...fs, writeFileSync(file, page) { assert.ok(file.endsWith('board' + path.sep + 'index.html')); builtPage = page; } },
    path, fileURLToPath, buildUrl: url.href, process: { cwd: () => '.' }, console: { log() {} } });
  new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(builtPage)[1]);
  return builtPage;
}
// 网页席位的身份行：状态记号（.mk）+ 模型名（b），和终端的一行对得上
const webSeatHead = (el) => `${el.querySelector('.mk').textContent} ${el.querySelector('b').textContent}`;
class DisplayElement {
  children = []; nodes = new Map(); dataset = {}; clientWidth = 161 * 6.6; clientHeight = 0; scrollHeight = 0;
  style = { setProperty() {} }; classes = new Set();
  classList = { add: (c) => this.classes.add(c), contains: (c) => this.classes.has(c), toggle: (c, on) => on ? this.classes.add(c) : this.classes.delete(c) };
  get firstChild() { return this.children[0]; } get lastChild() { return this.children.at(-1); }
  get textContent() { return this.text || this.children.map((x) => x.textContent).join(''); }
  set textContent(v) { this.text = String(v ?? ''); this.children = []; }
  set innerHTML(v) {
    this.text = ''; this.children = [];
    if (v.startsWith('<span class="av"')) this.children = Array.from({ length: 10 }, () => new DisplayElement());
    if (v.startsWith('<div class="tr th"')) { this.children = [new DisplayElement(), new DisplayElement(), new DisplayElement()]; this.nodes.set('.tbody', this.children[1]); this.nodes.set('.total', this.children[2]); }
  }
  querySelector(sel) {
    if (!this.nodes.has(sel)) { const el = new DisplayElement(); if (sel === '.use') el.children = [new DisplayElement(), new DisplayElement()]; this.nodes.set(sel, el); }
    return this.nodes.get(sel);
  }
  append(...xs) { for (const x of xs) { const el = typeof x === 'string' ? Object.assign(new DisplayElement(), { text: x }) : x; el.parent = this; this.children.push(el); } }
  insertBefore(el, before) { el.remove(); el.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, el); }
  replaceChildren(...xs) { this.children = []; this.append(...xs); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  addEventListener() {} getBoundingClientRect() { return { top: 0 }; }
}
function displayBoard(lang = 'zh') {
  const els = new Map(), el = (id) => { if (!els.has(id)) els.set(id, new DisplayElement()); return els.get(id); };
  const context = vm.createContext({ window: { __LANG__: lang, __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams,
    performance: { now: () => 0 }, innerHeight: 1000, ResizeObserver: class { observe() {} }, addEventListener() {}, wake() {}, document: { getElementById: el,
      createElement: () => new DisplayElement(), documentElement: {}, querySelector: () => null },
    worldEl: { dataset: { lod: 0 } }, avatarFor: () => 'claude', rgba: () => '', avatarSrc: () => '', look: () => ({ name: 'test' }),
    hash: () => 1, verdictCounts: () => null, reduceMotion: { matches: false }, FX_PULSE: 2.4, FX_LIFE: 2.6, FX_MAX_LABELS: 16, LABEL_KINDS: new Set(['read', 'edit', 'search', 'web', 'image']), ageOf: (ev, t) => (t - ev.ts) / 1000 });
  const page = buildPage(), shared = page.slice(page.indexOf('const Display ='), page.indexOf('// ---- 00-text.js'));
  const names = ['00-text', '01-state', '03-timeline', '04-life', '04-rates', '05-world', '06-states', '06-cards', '07-table', '07-terms', '08-surge', '08-labels'];
  const source = names.map((name) => fs.readFileSync(new URL(`../board/web/${name}.js`, import.meta.url), 'utf8')).join('\n');
  vm.runInContext(shared + source + '\nglobalThis.api = { Display, B, PANEL, conclusion, painted, outOfScope, onRun, onEv, groupColumn, fillGroup, fillSeat, fillHostSeat, laneStatus, seatStatus, laneElapsed, roundOf, fillCard, renderTable, renderTop, timeline, liveState, termUnits, renderDone, unitFinished, unitEnd, onBacklog, SETTLE, settleTerms, ccAway, CC_AWAY, viewAt, beatsAt, trackSurges, surgeAge, SURGE, recentPulses, recentLabels, fmtCost, outLook, OUT_HANDOFF };', context);
  return { ...context.api, el, context };
}

test('the cost column shows ? on a finished row whose cost is unknown (where the total\'s + comes from), and — while it runs', () => {
  const b = displayBoard();
  assert.equal(b.fmtCost(null, true), '?'); assert.equal(b.fmtCost(null, true, false), '—'); assert.equal(b.fmtCost(null), '—');
  assert.match(b.fmtCost(1.5, true), /^\$1\.5\d*\+$/);
});

test('构建内联可调用的纯显示函数，老格式 run 消息仍能渲染', () => {
  const b = displayBoard();
  assert.equal(b.Display.clock(65000), '1:05');
  // 一天以上写成天和小时：132:09:27 夹在分:秒中间分不清
  assert.equal(b.Display.clock(86399000), '23:59:59'); assert.equal(b.Display.clock(86400000), '1d 0h');
  assert.equal(b.Display.clock((132 * 3600 + 9 * 60 + 27) * 1000), '5d 12h');
  assert.equal(b.Display.D.conversation('test'), 'this conversation · test');
  assert.equal(b.Display.usageLine({}, { participant: 'host' }), D.watchHostNoUsage);
  const r = { id: 'legacy', model: 'old', kind: 'exec', started_at: 0, ended_at: 65000, status: 'done', report_head: 'old summary', usage: { input: 100, cached: 20, output: 3 } };
  b.onRun(r); const seat = new DisplayElement(); b.fillSeat(seat, b.B.lanes[0], 70000, 1);
  assert.equal(webSeatHead(seat), '✔ old · Codex CLI');
  assert.equal(seat.querySelector('.st').textContent, 'done 1:05');
  assert.deepEqual(Array.from(seat.fullLines, (l) => l.text), ['old summary']);
  assert.equal(seat.querySelector('.use').firstChild.textContent, 'changes not tracked · tokens: in 100 (cached 20%) · out 3');
});

test('同一记录在真实终端组汇总和两种语言的网页席位块中逐行一致', async (t) => {
  const h = sandbox(t), records = [], base = Date.now() - 3600000;
  const add = (id, meta, result) => {
    const dir = seedRun(h, id, { started_at: new Date(base).toISOString(), ended_at: new Date(base + 65000).toISOString(), ...meta }, result);
    records.push({ id, dir, meta: json(path.join(dir, 'meta.json')), result, tail: { state: {} } });
  };
  const usage = { input_tokens: 136000, cached_input_tokens: 69360, output_tokens: 1373 };
  const result = (report, extra = {}) => ({ status: 'done', duration_s: 65, report, usage, last_request: { tokens: 44000, window: 486000 }, output_tokens_per_s: 21.1,
    cost_usd: 0.798, cost_source: 'api_price', errors: ['Reconnecting... 1/5'], ...extra });
  add('20000101-000001-host', { group: 'discuss', kind: 'discuss', mode: 'discuss', participant: 'host', model: 'host-model', submitted_at: new Date(base + 65000).toISOString() }, result({ position: 'host position' }));
  add('20000101-000002-one', { group: 'discuss', kind: 'discuss', mode: 'discuss', model: 'one', plan: 'p', seat: 1 }, result({ position: 'full position\n' + 'evidence '.repeat(45) }, { stale: true, changes: { available: true, agent_total: 2 } }));
  add('20000101-000003-two', { group: 'discuss', kind: 'discuss', mode: 'discuss', model: 'two', plan: 'p', seat: 2 }, result({ position: 'second position' }));
  add('20000101-000004-part', { group: 'exec', model: 'part' }, result({ status: 'partial', summary: 'partial summary' }, { changes: { available: true, agent_total: 3 } }));
  add('20000101-000005-ask', { group: 'exec', model: 'ask' }, result({ status: 'blocked', summary: 'blocked summary', decision_requests: [{ question: 'which source?' }] }));
  add('20000101-000006-next', { group: 'exec', model: 'next', parent: '20000101-000005-ask' }, result({ status: 'blocked', summary: 'resumed summary', decision_requests: [{ question: 'confirm source?' }] }));
  add('20000101-000007-time', { group: 'exec', model: 'time', status: 'timeout' }, result(null, { status: 'timeout', errors: ['time limit reached'] }));
  add('20000101-000008-review', { group: 'review', kind: 'review', mode: 'review', model: 'review' }, result({ verdict: 'issues_found', findings: [{ id: 'R1', severity: 'high', location: 'src/a:1', issue: 'missing gate' }] }));
  add('20000101-000009-native', { group: 'review', kind: 'review', mode: 'review', model: 'native' }, result(null, { native_review: true, last_message: 'Native review conclusion\nFull plain text evidence.' }));
  const byId = new Map(records.map((r) => [r.id, r]));
  const messages = records.map((r) => runMessage(r, r.meta.participant === 'host' ? 'cc' : r.meta.parent || r.id, undefined, byId));
  for (const group of ['discuss', 'exec', 'review']) {
    const cli = await h.bridge(['watch', '--group', group, '--no-intro'], { env: { FOREMAN_TEST_SCREEN: '160x100', TZ: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    assert.equal(cli.code, 0, cli.stderr);
    for (const lang of ['zh', 'en']) {
      const b = displayBoard(lang); messages.forEach(b.onRun);
      const lanes = b.B.lanes.filter((l) => l.id !== 'cc' && l.runs[0].group === group);
      const col = b.groupColumn(group); b.fillGroup(col, { group, lanes }, Date.now());
      const out = cli.stdout.split('\n').map(plain), compact = (s) => s.replace(/\s+/g, ' ').trim();
      assert.ok(out.some((l) => l.startsWith(col.querySelector('header b').textContent)), cli.stdout);
      for (const [id, seat] of col.seats) {
        const identity = compact(webSeatHead(seat) + ' ' + seat.querySelector('.st').textContent);
        const at = out.findIndex((l) => compact(l) === identity);
        assert.ok(at >= 0, identity + '\n' + cli.stdout);
        const role = seat.querySelector('.role').textContent;
        const bodyAt = at + (role ? 2 : 1);
        if (role) assert.equal(compact(out[at + 1]), compact(role));
        assert.deepEqual(out.slice(bodyAt, bodyAt + seat.fullLines.length).map((l) => l.trim()), Array.from(seat.fullLines, (l) => plain(l.text).trim()), id);
        const after = bodyAt + seat.fullLines.length, end = out.findIndex((l, i) => i >= after && l.startsWith('─'));
        const usage = compact(out.slice(after, end).join(' ')).replaceAll(' · ', ' ');
        assert.equal(usage, compact(seat.querySelector('.use').firstChild.textContent + ' ' + seat.querySelector('.use').lastChild.textContent).replaceAll(' · ', ' '));
      }
      if (group === 'discuss') {
        const host = col.seats.get('host:20000101-000001-host');
        assert.equal(webSeatHead(host), '✔ host-model · Claude Code');
        assert.equal(host.querySelector('.use').firstChild.textContent, 'answer submitted by Claude Code · its tokens count for the whole conversation, not per seat');
      }
      if (group === 'exec') assert.equal(b.seatStatus(b.B.laneById.get('20000101-000005-ask'), messages.find((r) => r.id.endsWith('-ask')), Date.now()).style.word, 'resumed');
    }
  }
});

test('计划号码按数值排序，迟到的 2 号插回原位，排队派发启动后消失', async (t) => {
  const h = sandbox(t), group = 'late';
  const dir = seedRun(h, '20000101-000001-one', { group, plan: 'p', seat: 1 }, { status: 'done', report: { status: 'completed', summary: 'one' } });
  seedRun(h, '20000101-000002-three', { group, plan: 'p', seat: 3 }, { status: 'done', report: { status: 'completed', summary: 'three' } });
  const ticket = path.join(h.runs, '.state/queue/codex/1.json');
  write(ticket, { sequence: 1, pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(),
    agent: 'codex', group, claude_session: 'test-session', plan: 'p', seat: 2, title: 'late two', queued_at: new Date(Date.now() - 120000).toISOString() });
  const watch = h.startBridge(['watch', '--group', group, '--no-intro'], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: '140x40', FOREMAN_TEST_KEYS: '1' } });
  await poll(() => watch.stdout.includes('⋯ queued #1 late two · codex · waiting 2 min'), '终端显示派发排队');
  const feed = createFeed(h.runs), data = feed.read({ group }), b = displayBoard();
  data.runs.forEach(b.onRun); data.events.forEach(b.onEv);
  const col = b.groupColumn(group); b.fillGroup(col, b.termUnits(Date.now()).find((u) => u.group === group), Date.now());
  assert.match(col.querySelector('.dispatch-queue').textContent, /⋯ queued #1 late two · codex · waiting 2 min/);
  assert.ok(col.querySelector('.cnt').textContent.includes('⋯1'));
  seedRun(h, '20000101-000003-two', { group, plan: 'p', seat: 2 }, { status: 'done', report: { status: 'completed', summary: 'two' } });
  fs.unlinkSync(ticket);
  await poll(() => watch.stdout.includes('20000101-000003-two') && watch.stdout.includes(D.dashAllFinishedShort), '第二席启动并全部结束'); watch.child.stdin.write('q'); await watch.done;
  const summary = watch.stdout.slice(watch.stdout.lastIndexOf('\x1b[?1049l'));
  assert.ok(summary.indexOf('one') < summary.indexOf('two') && summary.indexOf('two') < summary.indexOf('three'), summary);
  assert.ok(!summary.includes('queued #'));
  const next = feed.read({ group }); next.runs.forEach(b.onRun); next.events.forEach(b.onEv);
  b.fillGroup(col, b.termUnits(Date.now()).find((u) => u.group === group), Date.now());
  assert.equal(col.querySelector('.dispatch-queue').textContent, '');
  const numbered = [1, 3, 2].map((seat) => ({ id: String(seat), meta: { plan: 'p', seat } }));
  const initial = b.Display.seatNumbers(numbered.slice(0, 2)), after = b.Display.seatNumbers(numbered, numbered, initial);
  assert.deepEqual([...after.runs.values()].sort((a, c) => a - c), [1, 2, 3]);
});

test('79 列的已结束终端面板折叠长结论，按席位号后仍能读全文', async (t) => {
  const h = sandbox(t), group = 'finished-fold';
  for (let i = 1; i <= 4; i++) seedRun(h, `20000101-00000${i}-seat`, { group, kind: 'discuss', mode: 'discuss', model: `model-${i}` },
    { status: 'done', report: { position: Array.from({ length: 12 }, (_, n) => `seat ${i} line ${n}`).join('\n') } });
  const watch = h.startBridge(['watch', '--group', group, '--no-intro'], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: '79x18', FOREMAN_TEST_KEYS: '1' } });
  await poll(() => watch.stdout.includes('… 8 more lines · press 1 to open'), '已结束面板压到四行并给出打开提示');
  watch.child.stdin.write('1'); await poll(() => watch.stdout.includes('seat 1 line 11'), '打开后显示完整结论');
  watch.child.stdin.write('q'); await watch.done;
  assert.equal(watch.stderr, '');
});

test('原生终端放不下时结论保留四行和展开提示，79 列底部优先保留按键；网页的已结束组照样显示完整结论', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i}`);
  assert.deepEqual(Display.collapseLines(lines, false, 'press 2 to open'), lines);
  assert.deepEqual(Display.collapseLines(lines, true, 'press 2 to open'), [...lines.slice(0, 4), '… 4 more lines · press 2 to open']);
  const foot = Display.dashFooter(`✔ ${D.dashAllFinished}`, D.dashKeys('1–8', false), 78, true);
  assert.equal(foot.left, '✔ all finished'); assert.equal(foot.keys, D.dashKeys('1–8', false));
  const b = displayBoard(), r = { id: 'fold', model: 'm', kind: 'discuss', group: 'g', status: 'done', started_at: 0, ended_at: 1000,
    display: { status: 'done', report: { position: lines.join('\n') } } };
  b.onRun(r); b.onEv({ run: r.id, ts: 1000, k: 'end', t: 'done' });
  const col = b.groupColumn('g'), box = col.querySelector('.seats'); box.clientHeight = 100; box.scrollHeight = 500;
  b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 2000);
  const seat = col.seats.get('fold'), term = seat.querySelector('.term');
  assert.equal(term.children.length, 8); // 8 行结论都在，没有收成四行加一行展开提示
  assert.ok(!term.children.some((li) => li.textContent.includes('more line')));
  assert.deepEqual(term.children.map((li) => li.textContent), Array.from(seat.fullLines, (l) => l.text));
});

test('部分完成、问题、续接、超时和排队共用状态词及计数，当前轮和累计用时分开', () => {
  const b = displayBoard(), r = (id, fields = {}) => ({ id, lane: 'first', model: 'model', kind: 'exec', status: 'done', started_at: 0, ended_at: 65000,
    display: { status: 'done', report: { status: 'partial', summary: 'partial' } }, ...fields });
  b.onRun(r('first')); const lane = b.B.lanes[0];
  assert.equal(b.laneStatus(lane, 70000).word, 'partly done'); assert.equal(b.laneStatus(lane, 70000).mark, '◐');
  b.onRun(r('next', { parent: 'first', started_at: 1000000, ended_at: 1035000, display: { status: 'done', report: { status: 'blocked', summary: 'asks' } } }));
  assert.equal(b.laneStatus(lane, 1040000).word, 'questions returned');
  assert.equal(b.seatStatus(lane, lane.runs[0], 1040000).style.word, 'resumed');
  assert.equal(b.roundOf(lane, 1040000), 2);
  assert.equal(b.laneElapsed(lane, 1040000), 35); assert.equal(b.laneElapsed(lane, 1040000, true), 100);
  const card = new DisplayElement(); b.fillCard(card, lane, 1040000); b.renderTable(1040000);
  assert.equal(card.querySelector('.st').textContent, '? questions returned 0:35');
  assert.equal(card.querySelector('.model').title, 'model · Codex CLI');
  assert.equal(b.el('usage').querySelector('.tbody').children[0].children[9].textContent, '1:40');
  assert.equal(Display.outcomeStyle(Display.resultOutcome({ status: 'timeout' })).word, 'timed out');
  assert.equal(Display.outcomeStyle(Display.resultOutcome({ status: 'cancelled' })).word, 'stopped');
  const queued = Display.seatState({ started_at: 0 }, { status: 'running' }, { queued: true, req: 0 }, 65000);
  assert.equal(queued.style.mark, '⋯'); assert.deepEqual(queued.right, ['queued', '1:05']);
  assert.equal(Display.countsText(['running', 'queued', 'ok', 'partial', 'blocked', 'resumed', 'failed'].map((kind) => ({ kind }))), '●1 ⋯1 ✔1 ◐1 ?1 ↪1 ✗1');
});

test('an output box grows out of the gathering dot: it starts small and transparent and is full size once the handoff ends', () => {
  const b = displayBoard(), at = (age) => b.outLook({ phase: 'show', age });
  b.context.ease = (u) => u * u * (3 - 2 * u); // 和 08-fx.js 的一样（这个测试没载入画布那几份脚本）
  assert.equal(at(0).a, 0); assert.equal(at(0).s, 0.2);
  const mid = at(b.OUT_HANDOFF / 2); assert.ok(mid.a > 0.4 && mid.a < 0.6 && mid.s > 0.2 && mid.s < 1);
  assert.equal(at(b.OUT_HANDOFF).a, 1); assert.equal(at(b.OUT_HANDOFF).s, 1);
});

test('the top bar says whole conversation on a chosen conversation and recent only on the latest-activity view', () => {
  const b = displayBoard();
  b.B.params = { ...b.B.params, session: 's' }; b.renderTop(0);
  assert.equal(b.el('scope').textContent, 'live · whole conversation');
  b.B.params = { ...b.B.params, session: null }; b.renderTop(0);
  assert.equal(b.el('scope').textContent, 'live · recent');
});

test('回放显示记录时间，18:23 不变成压缩后的 5:15；空闲 Claude Code 停在最后活动', () => {
  const b = displayBoard(), points = [[0, 0], [315000, 1103000]];
  b.B.clock.mode = 'replay'; b.B.hello = { replay: { time_map: points } };
  b.onRun({ id: 'long', kind: 'exec', model: 'model', status: 'cancelled', started_at: 0, ended_at: 315000, original_started_at: 0, original_ended_at: 1103000,
    display: { status: 'cancelled' } });
  const lane = b.B.lanes[0], card = new DisplayElement();
  b.fillCard(card, lane, 315000); b.renderTable(315000); b.renderTop(315000);
  assert.equal(card.querySelector('.st').textContent, '✗ stopped 18:23');
  assert.equal(b.el('usage').querySelector('.tbody').children[0].children[9].textContent, '18:23');
  assert.equal(b.el('clock').textContent.split(' · ')[0], new Date(1103000).toTimeString().slice(0, 8));
  b.context.U = { clock: { mode: 'replay', start: 0, end: 315000, speed: 1 }, hello: { replay: { time_map: points } } };
  b.context.uNow = () => 315000;
  vm.runInContext(fs.readFileSync(new URL('../board/web/07-uni-table.js', import.meta.url), 'utf8') + '\nrenderUniTop();', b.context);
  assert.equal(b.el('clock').textContent.split(' · ')[0], new Date(1103000).toTimeString().slice(0, 8));
  assert.equal(Display.clock(b.laneElapsed(lane, 157500) * 1000), '9:11');
  b.B.clock.mode = 'live';
  b.onRun({ id: 'cc', kind: 'host', status: 'idle', started_at: 0, ended_at: null }); b.onEv({ run: 'cc', ts: 40000, k: 'msg', t: 'last activity' });
  const cc = b.B.laneById.get('cc'); assert.equal(b.laneStatus(cc, 100000).word, 'idle'); assert.equal(b.laneStatus(cc, 100000).running, false);
  assert.equal(b.laneElapsed(cc, 100000), 40); assert.equal(b.laneElapsed(cc, 200000), 40);
});

test('run 显示字段保留结论、问题、上下文和异常，正文上限 4000 字、列表 30 且整体最多 64 KiB', () => {
  const long = 'x'.repeat(4500), many = Array.from({ length: 35 }, () => ({ id: 'R', severity: 'high', location: long, issue: long }));
  const r = runMessage({ id: 'bounded', meta: { kind: 'exec', model: 'm', parent: 'parent' }, tail: { state: {} }, result: {
    status: 'done', needs_decision: true, stale: true, report: { status: 'blocked', summary: long, verdict: 'issues_found', findings: many,
      decision_requests: many.map(() => ({ question: long, options: Array(35).fill(long) })) },
    questions: [{ source: 'decision_request', question: long }], errors: ['real error'], last_request: { tokens: 44000, window: 486000 }, output_tokens_per_s: 21.1,
    changes: { available: true, agent_total: 2, reported_total: 1, files_total: 3 } } }, 'root');
  assert.equal(r.report_head.length, 160); assert.equal(r.display.report.summary.length, 4000);
  assert.ok(r.display.report.findings.length <= 30 && r.display.report.findings.length > 0); assert.equal(r.display.report.findings[0].issue.length, 4000);
  assert.ok(r.display.report.decision_requests.length <= 30 && r.display.report.decision_requests.length > 0); assert.equal(r.display.report.decision_requests[0].options.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(r.display)) <= 65536); assert.equal(r.display.report.findings_counts.total, 35);
  assert.equal(r.display.questions[0].question.length, 4000); assert.deepEqual(r.display.last_request, { tokens: 44000, window: 486000 });
  assert.equal(r.display.output_tokens_per_s, 21.1); assert.equal(r.display.stale, true); assert.equal(r.display_round, 2);
  assert.deepEqual(r.display.errors, ['real error']); assert.equal(Display.changedFor(r.display, { kind: 'discuss' }), '3 files changed');
});

test('运行中说话、思考、读、搜、命令和重连提示在终端与网页使用同一正文', () => {
  const b = displayBoard(), r = { id: 'live', kind: 'exec', model: 'model', status: 'running', started_at: 0, ended_at: null };
  b.onRun(r); const lane = b.B.lanes[0], meta = { kind: 'exec', model: 'model', started_at: 0 }, tl = createTimeline(meta, (p) => p), state = {};
  const it = (type, fields) => ({ type: 'item.completed', ts: 1000, item: { id: type, type, ...fields } });
  const events = [it('agent_message', { text: 'Inspecting files.' }),
    it('command_execution', { id: 'read', category: 'read', label: 'src/main.mjs', exit_code: 0 }),
    it('command_execution', { id: 'search', category: 'search', label: 'token src', exit_code: 0 }),
    it('command_execution', { id: 'cmd', command: 'pwsh -Command "echo okay"', exit_code: 0 }),
    it('reasoning', { text: '**Checking the boundary**' }), { type: 'error', ts: 1000, message: 'Reconnecting... 1/5' }];
  for (const ev of events) { tl.show(ev); normalizeEvent(ev, { id: r.id, meta }, state).forEach(b.onEv); }
  const seat = new DisplayElement(); seat.querySelector('.term').clientWidth = 84 * 6.6;
  b.fillSeat(seat, lane, 2000, 1);
  // 网页的正文带和终端同样的颜色代码（03-timeline.js 的 TERM_C），去掉颜色后逐字一致
  assert.deepEqual(Array.from(seat.fullLines, (l) => plain(l.text)), Display.liveLines(tl.state, 8, 80));
});

test('终端区在 renderTerms 里先全部写完再集中量：放不下的已结束组不收起，贴底集中做，新栏宽度猜错时要求重画', () => {
  const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
  const b = displayBoard(), r = { id: 'fold', model: 'm', kind: 'discuss', group: 'g', status: 'done', started_at: 0, ended_at: 1000,
    display: { status: 'done', report: { position: lines.join('\n') } } };
  b.onRun(r); b.onEv({ run: r.id, ts: 1000, k: 'end', t: 'done' });
  const col = b.groupColumn('g'), box = col.querySelector('.seats'); box.clientHeight = 100; box.scrollHeight = 500;
  b.SETTLE.on = true; b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 2000); b.SETTLE.on = false;
  const term = col.seats.get('fold').querySelector('.term'), shown = term.children.length;
  assert.ok(shown > 5);
  term.scrollHeight = 321;
  assert.equal(b.settleTerms(), false); // 新栏先按猜的宽度折行，量出来不一样：下一帧重画
  assert.equal(term.children.length, shown); // 量完也不收成四行
  assert.equal(term.scrollTop, 321);
  b.SETTLE.on = true; b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 2000); b.SETTLE.on = false;
  assert.equal(b.settleTerms(), true); // 第二次用量到的宽度，不再重画
});

test('终端区保留已离场组，网页编号和排序按计划号码，刷新后和续接后不变', () => {
  const b = displayBoard(), r = (seat, fields = {}) => ({ id: String(seat), model: `model-${seat}`, kind: 'discuss', group: 'g', plan: 'p', seat, status: 'done',
    started_at: seat === 2 ? 3000 : seat * 1000, ended_at: 4000, report_head: 'done', ...fields });
  b.onRun(r(1)); b.onRun(r(3));
  const col = b.groupColumn('g'); b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 5000);
  b.onRun(r(2)); b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 5000);
  const order = () => col.querySelector('.seats').children.map((el) => el.querySelector('.no').textContent);
  assert.deepEqual(order(), ['1', '2', '3']);
  b.onRun(r(2, { id: '2-next', parent: '2', lane: '2', started_at: 6000, ended_at: 7000 }));
  b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 8000); assert.deepEqual(order(), ['1', '2', '3']);
  assert.equal(b.termUnits(8000, { groups: [] }).length, 1);
});

test('计划缺口、未交 Claude Code 席、补漏席和 stale 的文字由共用函数生成', async (t) => {
  const h = sandbox(t), group = 'plan-notes', id = '20000101-000001-plan';
  const plan = { plan_id: 'notes', module: 'review', group, host: { role: 'owner' }, created_at: new Date().toISOString(),
    seats: [{ seat: 1, agent: 'codex', required: true }, { seat: 2, agent: 'other', role: 'gap' }, { seat: 3, agent: 'required', required: true }] };
  write(path.join(h.runs, 'plans/notes.json'), plan);
  const result = { status: 'done', report: { verdict: 'no_issues' }, stale: true };
  const dir = seedRun(h, id, { group, plan: 'notes', seat: 1, kind: 'review', mode: 'review' }, result);
  const cli = await h.bridge(['watch', '--group', group, '--no-intro'], { env: { FOREMAN_TEST_SCREEN: '300x40' } });
  assert.equal(cli.code, 0, cli.stderr);
  const b = displayBoard(); b.onRun(runMessage({ id, dir, meta: json(path.join(dir, 'meta.json')), result, tail: { state: {} } }, id));
  b.onEv({ ...plan, run: 'cc', lane: 'cc', plan: 'notes', ts: Date.now() - 1000, k: 'fplan' });
  const col = b.groupColumn(group); b.fillGroup(col, { group, lanes: b.B.lanes.filter((l) => l.id !== 'cc') }, Date.now());
  const note = col.querySelector('.plan-notes').textContent;
  assert.ok(note.includes("Claude Code seat hasn't submitted")); assert.ok(note.includes('required seats not started yet'));
  assert.ok(note.includes('gap seat not finished') && note.includes('material changed during the review (stale)'));
  assert.ok(cli.stdout.includes(note), note + '\n' + cli.stdout);
});

const queueTicket = (h, group, fields = {}) => write(path.join(h.runs, '.state/queue/codex/1.json'), {
  sequence: 1, pid: process.pid, pid_started_at: new Date(Math.ceil(performance.timeOrigin)).toISOString(),
  expires_at: new Date(Date.now() + 60000).toISOString(), queued_at: new Date(Date.now() - 120000).toISOString(),
  agent: 'codex', claude_session: 'test-session', group, plan: 'p', seat: 1, title: 'waiting seat', ...fields,
});
const readFrame = (watch, height) => {
  const part = watch.stdout.split('\x1b[1;1H').at(-1);
  const lines = `\x1b[1;1H${part}`.split(/\x1b\[\d+;1H\x1b\[2K/).slice(1).map((l) => plain(l.replace(/\x1b\[\d+;1H\x1b\[J$/, '')));
  return lines.length === height ? lines : null;
};
const boardSeats = (col) => col.querySelector('.seats').children.map((el) => [Number(el.querySelector('.no').textContent), el.querySelector('b').textContent.split(' ')[0]]);
const terminalSeats = (frame) => frame.flatMap((l) => { const m = /^(\d+) [✔●] (\S+)/.exec(l); return m ? [[Number(m[1]), m[2]]] : []; });

test('多计划各保留最新 Claude Code 席，撞号从全部声明席位重建；持续观看、重开及网页一致', async (t) => {
  const h = sandbox(t), group = 'plan-collision', base = Date.now() - 600000, records = [];
  for (const [i, id] of ['a', 'b'].entries()) write(path.join(h.runs, `plans/${id}.json`), {
    plan_id: id, group, module: 'discuss', cell: 'normal', created_at: new Date(base + i * 1000).toISOString(), host: {},
    seats: [1, 2].map((seat) => ({ seat, agent: 'codex' })),
  });
  const add = (suffix, plan, seat, model) => {
    const id = `20000101-00000${records.length + 1}-${suffix}`, result = { status: 'done', report: { position: model } };
    const dir = seedRun(h, id, { group, kind: 'discuss', mode: 'discuss', plan, seat, model, ...(seat === 0 ? { participant: 'host', submitted_at: base + 5000 } : {}),
      started_at: new Date(base + records.length * 10000).toISOString(), ended_at: new Date(base + 65000).toISOString() }, result);
    records.push({ id, dir, meta: json(path.join(dir, 'meta.json')), result, tail: { state: {} } });
  };
  add('host-old', 'a', 0, 'old-host'); add('one', 'a', 1, 'a-one'); add('other-one', 'b', 1, 'b-one');
  add('host-a', 'a', 0, 'host-a'); add('host-b', 'b', 0, 'host-b');
  const watch = h.startBridge(['watch', '--group', group, '--no-intro'], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: '160x60', FOREMAN_TEST_KEYS: '1' } });
  const frame = await poll(() => { const f = readFrame(watch, 60); return f?.some((l) => l.includes('host-b')) && f; }, '多计划都显示最新主持席');
  const feed = createFeed(h.runs), b = displayBoard(), col = b.groupColumn(group);
  const render = () => { const data = feed.read({ group }); data.runs.forEach(b.onRun); data.events.forEach(b.onEv); const u = b.termUnits(Date.now()).find((u) => u.group === group); b.fillGroup(col, u, Date.now()); return data; };
  render(); assert.deepEqual(boardSeats(col), terminalSeats(frame));
  assert.deepEqual(boardSeats(col), [[0, 'host-a'], [1, 'a-one'], [3, 'host-b'], [4, 'b-one']]);
  assert.equal(col.seats.size, 4); assert.ok(!frame.some((l) => l.includes('old-host')));
  add('late-two', 'a', 2, 'a-two'); render();
  const after = await poll(() => { const f = readFrame(watch, 60); return f?.some((l) => l.includes('2 ✔ a-two')) && f; }, '晚启动席仍占预留的 2 号');
  assert.deepEqual(boardSeats(col), terminalSeats(after));
  const reopened = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '160x60', FOREMAN_TEST_KEYS: '1' });
  assert.deepEqual(terminalSeats(reopened), terminalSeats(after));
  const fresh = displayBoard(), data = feed.read({ group }); data.runs.forEach(fresh.onRun); data.events.forEach(fresh.onEv);
  const freshCol = fresh.groupColumn(group); fresh.fillGroup(freshCol, fresh.termUnits(Date.now()).find((u) => u.group === group), Date.now());
  assert.deepEqual(boardSeats(freshCol), boardSeats(col));
  const runs = records.map((r) => ({ id: r.id, meta: r.meta })), plans = ['a', 'b'].map((id) => json(path.join(h.runs, `plans/${id}.json`)));
  assert.deepEqual([...Display.seatNumbers(Display.current(runs), runs, undefined, plans).runs], Array.from(b.Display.seatNumbers(Display.current(runs), runs, undefined, plans).runs, ([id, n]) => [id, n]));
  watch.child.stdin.write('q'); await watch.done; assert.equal(watch.stderr, '');
});

test('没有任何 run 的组也显示排队、保持等待；第一席开始后终端与网页一起替换排队行', async (t) => {
  const h = sandbox(t), group = 'queue-only', ticket = queueTicket(h, group);
  write(path.join(h.runs, 'plans/p.json'), { plan_id: 'p', group, module: 'run', cell: 'normal', created_at: Date.now() - 180000, seats: [{ seat: 1, agent: 'codex' }] });
  const feed = createFeed(h.runs), data = feed.read({ group }), b = displayBoard();
  assert.equal(data.runs.length, 0); assert.equal(data.events.find((e) => e.k === 'dispatch_queue').tickets.length, 1);
  data.events.forEach(b.onEv);
  const u = b.termUnits(Date.now()).find((u) => u.group === group), col = b.groupColumn(group); assert.ok(u); assert.equal(u.lanes.length, 0);
  b.fillGroup(col, u, Date.now()); assert.equal(col.seats.size, 0);
  const watch = h.startBridge(['watch', '--group', group, '--no-intro'], { keepStdin: true, env: { FOREMAN_TEST_SCREEN: '140x25', FOREMAN_TEST_KEYS: '1' } });
  const frame = await poll(() => { const f = readFrame(watch, 25); return f?.some((l) => l.startsWith('⋯ queued #1')) && f; }, '零席位时马上显示排队面板');
  assert.ok(frame.includes(col.querySelector('.dispatch-queue').textContent));
  assert.ok(frame[0].startsWith(col.querySelector('header b').textContent));
  assert.ok(!frame.some((l) => l.includes('all finished'))); assert.equal(watch.child.exitCode, null);
  const piped = h.startBridge(['watch', '--group', group, '--no-intro']);
  await poll(() => piped.stdout.includes('⋯ queued #1'), '重定向输出也跟踪纯排队'); assert.equal(piped.child.exitCode, null);
  seedRun(h, '20000101-000001-start', { group, plan: 'p', seat: 1, model: 'started', started_at: new Date().toISOString() }, { status: 'done', report: { status: 'completed', summary: 'started' } });
  const next = feed.read({ group }); next.runs.forEach(b.onRun); next.events.forEach(b.onEv); b.fillGroup(col, b.termUnits(Date.now()).find((u) => u.group === group), Date.now());
  assert.equal(col.querySelector('.dispatch-queue').textContent, ''); assert.deepEqual(boardSeats(col), [[1, 'started']]);
  const after = await poll(() => { const f = readFrame(watch, 25); return f?.some((l) => l.startsWith('1 ✔ started')) && f; }, '排队票据尚未删除但已登记时不再重复显示');
  assert.deepEqual(terminalSeats(after), boardSeats(col)); assert.ok(!after.some((l) => l.startsWith('⋯ queued #')));
  fs.unlinkSync(ticket); watch.child.stdin.write('q'); await watch.done;
  const result = await piped.done; assert.equal(result.code, 0, result.stderr); assert.equal(watch.stderr, '');
  const noPlan = displayBoard(); noPlan.onEv(data.events.find((e) => e.k === 'dispatch_queue'));
  assert.equal(noPlan.termUnits(Date.now()).find((u) => u.group === group).lanes.length, 0);
});

test('同席旧记录不隐藏续接或重启的排队票据，只有排队之后开始的记录才隐藏', async (t) => {
  const h = sandbox(t), group = 'restart-queue', start = Date.now() - 600000;
  seedRun(h, '20000101-000001-old', { group, plan: 'p', seat: 1, started_at: new Date(start).toISOString() }, { status: 'done', report: { status: 'completed', summary: 'old' } });
  const ticket = queueTicket(h, group), feed = createFeed(h.runs), b = displayBoard(), col = b.groupColumn(group), data = feed.read({ group });
  data.runs.forEach(b.onRun); data.events.forEach(b.onEv); b.fillGroup(col, b.termUnits(Date.now()).find((u) => u.group === group), Date.now());
  const queue = col.querySelector('.dispatch-queue').textContent; assert.ok(queue.includes('queued #1'));
  const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '160x30', FOREMAN_TEST_KEYS: '1' });
  assert.ok(frame.includes(queue));
  assert.equal(Display.queuedStarted(json(ticket), [{ meta: { plan: 'p', seat: 1, started_at: start } }]), false);
  for (const parent of [undefined, '20000101-000001-old']) assert.equal(Display.queuedStarted(json(ticket), [{ meta: { plan: 'p', seat: 1, started_at: Date.now(), parent } }]), true);
});

test('完整审查数字在截取前统计，两边显示前 30 条并说明省略数量；旧字段不显示 undefined', () => {
  const findings = Array.from({ length: 37 }, (_, i) => ({ severity: ['high', 'medium', 'low'][i % 3], where: `a:${i}`, title: `issue ${i}` }));
  const result = { status: 'done', report: { verdict: 'issues_found', findings } }, meta = { kind: 'review', status: 'done', started_at: 0, ended_at: 1000 };
  const msg = runMessage({ id: 'review-many', meta, result, tail: { state: {} } }, 'review-many');
  assert.deepEqual(msg.display.report.findings_counts, { total: 37, high: 13, medium: 12, low: 12 });
  const expectedLines = Display.finalLines({ meta }, result, true, 157);
  assert.equal(expectedLines[0], '37 issues · high 13 · medium 12 · low 12');
  assert.equal(expectedLines.at(-1), '… 7 more findings'); assert.equal(expectedLines.length, 32);
  const b = displayBoard(); b.onRun(msg); const seat = new DisplayElement(); b.fillSeat(seat, b.B.lanes[0], 2000, 1);
  assert.deepEqual(Array.from(seat.fullLines, (l) => l.text), expectedLines);
  assert.equal(msg.display.report.findings[0].location, 'a:0'); assert.equal(msg.display.report.findings[0].issue, 'issue 0');
  assert.equal(msg.review.findings[0].where, msg.display.report.findings[0].location);
  const legacy = { ...msg }; delete legacy.display; b.onRun(legacy); b.fillSeat(seat, b.B.lanes[0], 2000, 1);
  assert.ok(seat.fullLines.some((l) => l.text === '[high] a:0: issue 0')); assert.ok(!seat.fullLines.some((l) => l.text.includes('undefined')));
});

test('display 限选项 10 条和 500 字、整体限制按 UTF-8 JSON；回放开头和宇宙摘要不带 display', () => {
  const make = (report, extra = {}) => runMessage({ id: 'size', meta: { kind: 'exec', status: 'done', started_at: 0, ended_at: 1000 }, tail: { state: {} },
    result: { status: 'done', report: { status: 'completed', summary: 'summary', ...report }, ...extra } }, 'size');
  const options = make({ decision_requests: [{ question: 'ask', options: Array(30).fill('a'.repeat(4000)) }] }, { review_target: { mode: 'scope' } });
  assert.equal(options.display.report.decision_requests[0].options.length, 10); assert.equal(options.display.report.decision_requests[0].options[0].length, 500);
  assert.deepEqual(options.display.review_target, { mode: 'scope' });
  const long = '\u0000中文'.repeat(2000), questions = Array.from({ length: 30 }, () => ({ source: 'decision_request', question: long, why_it_matters: long, recommendation: long, options: Array(30).fill(long) }));
  const big = make({ verdict: 'issues_found', summary: long, position: long, decision_requests: questions, open_issues: Array(30).fill(long), open_questions: Array(30).fill(long), unverified: Array(30).fill(long),
    findings: Array.from({ length: 45 }, () => ({ id: 'R', severity: 'high', location: long, issue: long })) }, { questions, last_message: long, errors: Array(30).fill(long), review_target: { paths: Array(30).fill(long) } });
  assert.ok(Buffer.byteLength(JSON.stringify(big.display)) <= 65536); assert.equal(big.display.report.status, 'completed');
  assert.ok(big.display.report.decision_requests.every((q) => q.options.length === 0));
  assert.deepEqual([big.display.report.unverified, big.display.report.open_issues, big.display.report.open_questions], [[], [], []]);
  assert.equal(Display.reviewConclusion(big.display.report), '45 issues · high 45');
  const replay = buildReplay({ runs: [options], events: [] }, {}, 2000);
  assert.ok(!('display' in replay.timeline.find((m) => m.event === 'run').data));
  assert.ok(replay.timeline.filter((m) => m.event === 'run').at(-1).data.display);
  const summary = runMessage({ id: 'index', meta: {}, result: { status: 'done', last_message: long }, tail: { state: {} } }, 'index', undefined, undefined, { display: false });
  assert.ok(!('display' in summary));
});

test('Claude Code 和无 agent_type 的老记录用共用接入标签，保留表格任务悬停说明', () => {
  const b = displayBoard();
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onRun({ id: 'old', kind: 'exec', model: 'legacy', title: 'task', group: 'g', status: 'done', started_at: 0, ended_at: 1000 });
  const card = new DisplayElement(); b.fillCard(card, b.B.laneById.get('cc'), 2000); b.renderTable(2000);
  assert.equal(card.querySelector('.model').title, 'opus · Claude Code');
  const rows = b.el('usage').querySelector('.tbody').children;
  // 组 g 前面有一行简短的组标题（类型 · 标题，右边是各状态的个数），车道行在它下面
  assert.equal(rows[0].children[1].textContent, 'opus · Claude Code'); assert.equal(rows[1].children[0].textContent, 'run · task'); assert.equal(rows[1].children[1].textContent, '✗1');
  assert.equal(rows[2].children[1].textContent, 'legacy · Codex CLI'); assert.equal(rows[2].children[1].title, 'task · g · old'); assert.equal(b.Display.agentTypeOf({}), 'codex cli');
});

test('打开和生成图片使用不同文字，组计数分段有对应状态 class 且文字仍一致', () => {
  const b = displayBoard(), r = { id: 'image', kind: 'exec', group: 'g', model: 'm', status: 'done', started_at: 0, ended_at: 1000,
    display: { status: 'done', report: { status: 'partial', summary: 'partial' } } };
  b.onRun(r);
  const tl = createTimeline({ kind: 'exec', started_at: 0 }, (p) => p);
  for (const type of ['image.generated', 'image.viewed']) {
    const raw = { type, ts: 1000, path: path.join('tmp', 'a.png') }; tl.show(raw);
    normalizeEvent(raw, { id: r.id, meta: {} }, {}).forEach(b.onEv);
  }
  const lines = b.timeline(b.B.lanes[0], 2000, { open: true }).map((l) => l.text);
  assert.ok(lines.includes('▣ Generated image a.png')); assert.ok(lines.includes('◉ Opened image a.png'));
  const terminal = tl.lines(160).map(plain).join('\n');
  assert.ok(terminal.includes('▣ Generated image a.png')); assert.ok(terminal.includes('◉ Opened image a.png'));
  const col = b.groupColumn('g'); b.fillGroup(col, { group: 'g', lanes: b.B.lanes }, 2000);
  assert.equal(col.querySelector('.cnt').textContent, '◐1'); assert.equal(col.querySelector('.cnt').children[0].className, 'partial');
  const states = ['running', 'ok', 'partial', 'blocked', 'queued', 'failed', 'resumed'].map((kind) => ({ kind }));
  assert.deepEqual(Display.countParts(states).map((p) => p.kind), Object.keys(Display.COUNT_MARKS));
  assert.equal(Display.countParts(states).map((p) => p.text).join(' '), Display.countsText(states));
});

test('问题和报错带原来的条数：列表截到 30 条以后摘要写"还有 N 条"，第一条报错保留', () => {
  const r = runMessage({ id: 'many', meta: { kind: 'exec', model: 'm' }, tail: { state: {} }, result: { status: 'failed', report: { status: 'blocked', summary: 's' },
    questions: Array.from({ length: 34 }, (_, i) => ({ source: 'decision_request', question: `Q${i}` })),
    errors: ['the real reason', ...Array.from({ length: 36 }, (_, i) => `E${i}`)] } }, 'root');
  assert.deepEqual([r.display.questions.length, r.display.questions_total, r.display.errors.length, r.display.errors_total], [30, 34, 30, 37]);
  assert.equal(r.display.errors[0], 'the real reason');
  const run = Display.displayRun(r), text = Display.finalLines(run, run.result, false, 200).join('\n');
  assert.ok(text.includes(Display.D.watchMoreQuestions(4)), text);
  assert.ok(text.includes(Display.D.watchMoreErrors(7)), text);
  // 有逐条问题时，大小超限先去掉不显示的 decision_requests，不把唯一的问题截短
  const long = 'z'.repeat(4000), big = runMessage({ id: 'big', meta: { kind: 'exec', model: 'm' }, tail: { state: {} }, result: { status: 'done', needs_decision: true,
    report: { status: 'blocked', summary: 's', decision_requests: Array.from({ length: 30 }, () => ({ question: long, why_it_matters: long })) },
    questions: [{ source: 'decision_request', question: long }] } }, 'root');
  assert.ok(Buffer.byteLength(JSON.stringify(big.display)) <= 65536);
  assert.equal(big.display.questions[0].question.length, 4000);
});

test('状态色调和终端的上色一一对应：运行中、完成、部分完成/交回问题/排队、失败、已续接和没开始', () => {
  const C = Object.fromEntries(['dim', 'bold', 'red', 'green', 'yellow', 'cyan'].map((k) => [k, (s) => `${k}:${s}`]));
  const colorOf = (style) => style.color('x').split(':')[0], expectTone = { cyan: 'run', green: 'ok', yellow: 'warn', red: 'bad', dim: 'dim' };
  const cases = { running: { running: true }, ok: { ok: true, status: 'done' }, blocked: { blocked: true, status: 'done' }, partial: { partial: true, status: 'done' },
    failed: { status: 'timed_out' }, resumed: { resumed: true }, not_started: { status: 'not_started' } };
  for (const [kind, outcome] of Object.entries(cases)) assert.equal(Display.toneOf(kind), expectTone[colorOf(Display.outcomeStyle(outcome, C))], kind);
  assert.equal(Display.toneOf('queued'), expectTone[colorOf(Display.liveStatus({ started_at: 0 }, { queued: true }, 0, C))]);
  assert.equal(Display.toneOf('whatever'), 'dim');
});

test('用量表和终端区一样排：Claude Code、正在跑的组、已结束的组（新的在前），组前一行简短标题和计数，组里按席位号', () => {
  const b = displayBoard();
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onRun({ id: 'old1', kind: 'exec', model: 'm1', title: 'old task', group: 'old', status: 'done', started_at: 0, ended_at: 1000, display: { status: 'done', report: { status: 'completed' } } });
  b.onRun({ id: 'live2', kind: 'review', model: 'm3', title: 'check', group: 'live', plan: 'p', seat: 2, status: 'running', started_at: 500, ended_at: null });
  b.onRun({ id: 'live1', kind: 'review', model: 'm2', title: 'check', group: 'live', plan: 'p', seat: 1, status: 'timed_out', started_at: 600, ended_at: 1500 });
  b.renderTable(2000);
  const rows = b.el('usage').querySelector('.tbody').children;
  const shown = rows.map((tr) => (String(tr.className).includes('gh') ? `# ${tr.children[0].textContent} | ${tr.children[1].children.map((i) => `${i.textContent}:${i.dataset.tone}`).join(' ')}` : tr.children[1].textContent));
  assert.deepEqual(shown, ['opus · Claude Code', '# review · check | ●1:run ✗1:bad', 'm2 · Codex CLI', 'm3 · Codex CLI', '# run · old task | ✔1:ok', 'm1 · Codex CLI']);
  // 状态列按色调上色
  assert.deepEqual([rows[2], rows[3], rows[5]].map((tr) => tr.children[2].dataset.tone), ['bad', 'run', 'ok']);
});

test('已结束的组：用户最后一条消息之后结束的展开成栏，之前的折成一行（费用含所有轮次），点过的按点的来', () => {
  const b = displayBoard(), t = 300000;
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onEv({ lane: 'cc', run: 'cc', ts: 50000, k: 'prompt', t: 'next round' });
  b.onRun({ id: 'old1', kind: 'exec', model: 'm1', title: 'old task', group: 'old', status: 'done', started_at: 0, ended_at: 10000, cost_usd: 0.1, display: { status: 'done', report: { status: 'partial' } } });
  b.onRun({ id: 'old2', lane: 'old1', parent: 'old1', kind: 'exec', model: 'm1', title: 'old task', group: 'old', status: 'done', started_at: 20000, ended_at: 40000, cost_usd: 0.05, display: { status: 'done', report: { status: 'completed' } } });
  b.onRun({ id: 'new1', kind: 'exec', model: 'm2', title: 'new task', group: 'new', status: 'done', started_at: 60000, ended_at: 90000, cost_usd: 0.2, display: { status: 'done', report: { status: 'completed' } } });
  const done = b.termUnits(t).filter((u) => b.unitFinished(u, t)).sort((x, y) => b.unitEnd(y, t) - b.unitEnd(x, t));
  const box = b.el('termdone'), render = () => { b.renderDone(done, t, new Set()); const [sub, row, lines] = box.children; return { sub: sub.textContent, open: row.children.map((c) => c.dataset.lane), closed: lines.children.map((l) => l.textContent) }; };
  let shown = render();
  assert.equal(shown.sub, 'finished · 2');
  assert.deepEqual(shown.open, ['group:new']);
  // 折起来的一行：标题和计数跟展开后的栏头一样，费用两轮相加
  assert.deepEqual(shown.closed, [`▸ run · old task · ✔1 · ended ${new Date(40000).toTimeString().slice(0, 5)} · $0.15`]);
  // 用户点开旧的、收起新的
  b.PANEL.fold.set('group:old', true); b.PANEL.fold.set('group:new', false);
  shown = render();
  assert.deepEqual(shown.open, ['group:old']);
  assert.equal(shown.closed.length, 1); assert.match(shown.closed[0], /^▸ run · new task · ✔1 · ended /);
});

test('小修：超时后的其余报错写成次要的；底部放不下时换短按键；单复数；只有费用的用量行；没报用量的写明', () => {
  const run = Display.displayRun({ id: 'r', kind: 'exec', model: 'm', status: 'timeout', started_at: 0, ended_at: 1000 });
  const lines = Display.finalLines(run, { status: 'timeout', errors: ['hit the 1-minute limit', 'codex exit 1: mcp worker quit'] }, false, 120);
  assert.ok(lines.some((l) => l.startsWith('✗ hit the 1-minute limit')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('· codex exit 1')), lines.join('\n'));
  const keys = Display.D.dashKeys('1–13', false, true), short = Display.D.dashKeysShort('1–13', false);
  const foot = Display.dashFooter('✔ all finished · ↓ 13 more lines below', keys, 79, true, short);
  assert.equal(foot.keys, short); assert.match(foot.left, /13 more lines below/);
  assert.match(Display.collapseLines(['a', 'b', 'c', 'd', 'e'], true, 'click').at(-1), /… 1 more line · click/);
  assert.equal(Display.usageLine({ status: 'failed', cost_usd: 0.01, cost_source: 'api_price' }, {}), 'cost $0.010');
  assert.equal(Display.usageLine({ status: 'failed' }, {}), Display.D.watchNoUsage);
  assert.equal(Display.usageLine({ status: 'running' }, {}), '');
});

test('审查修正：网络共享的根不同就写绝对路径；用户消息的时刻不随车道事件裁掉', () => {
  const run = (cwd) => Display.displayRun({ id: 'r', kind: 'exec', model: 'm', status: 'done', started_at: 0, ended_at: 1, cwd });
  const outside = (cwd, path) => Display.outsideCwdText({ cwd, changes: { outside_cwd: [{ path, by: 'agent', in_scope: false }] } }, run(cwd).meta);
  assert.match(outside('//serverA/share/project', '//serverB/share/file.txt'), /\/\/serverB\/share\/file\.txt/);
  assert.match(outside('//serverA/share/project', '//serverA/other/x.txt'), /\/\/serverA\/other\/x\.txt/);
  assert.match(outside('C:\\work\\project', 'C:\\work\\other\\x.txt'), /\.\.\\other\\x\.txt/);
  assert.match(outside('C:\\work\\project', 'D:\\x.txt'), /D:\\x\.txt/);
  const b = displayBoard();
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onEv({ lane: 'cc', run: 'cc', ts: 1000, k: 'prompt', t: 'go' });
  for (let i = 0; i < 700; i++) b.onEv({ lane: 'cc', run: 'cc', ts: 2000 + i, k: 'msg', t: `m${i}` });
  assert.equal(b.B.laneById.get('cc').events.some((e) => e.k === 'prompt'), false);
  assert.deepEqual([...b.B.prompts], [1000]);
});

test('补审修正：对话记录重置后用户消息的时刻按新记录重建；折起来那一行有没算全的费用时带 +', () => {
  const b = displayBoard(), t = 300000;
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onEv({ lane: 'cc', run: 'cc', ts: 100, k: 'prompt', t: 'a' }); b.onEv({ lane: 'cc', run: 'cc', ts: 300, k: 'prompt', t: 'b' });
  b.onBacklog({ run: 'cc', reset: true, events: [{ lane: 'cc', run: 'cc', ts: 100, k: 'prompt', t: 'a' }] });
  assert.deepEqual([...b.B.prompts], [100]);
  b.onRun({ id: 'x1', kind: 'exec', model: 'm', title: 'priced', group: 'g', status: 'done', started_at: 0, ended_at: 50, cost_usd: 0.1, display: { status: 'done', report: { status: 'completed' } } });
  b.onRun({ id: 'x2', lane: 'x1', parent: 'x1', kind: 'exec', model: 'm', title: 'priced', group: 'g', status: 'done', started_at: 60, ended_at: 90, cost_usd: null, display: { status: 'done', report: { status: 'completed' } } });
  const done = b.termUnits(t).filter((u) => b.unitFinished(u, t));
  b.renderDone(done, t, new Set());
  const [, , lines] = b.el('termdone').children;
  assert.match(lines.children[0].textContent, /\$0\.10\+$/);
});

test('卡片的 ⚠N 结束后也算写到工作目录外、又不在范围里的文件；进行中照旧只看范围外的编辑', () => {
  const b = displayBoard();
  const r = { id: 'r', lane: 'r', kind: 'exec', model: 'm', status: 'done', started_at: 0, ended_at: 1000, scope: ['src'],
    display: { status: 'done', changes: { outside_cwd: [{ path: 'O:\\bench.txt', in_scope: false }, { path: 'O:\\ok.txt', in_scope: true }] }, cwd: 'O:\\w' } };
  const lane = { id: 'r', runs: [r], events: [{ run: 'r', ts: 500, k: 'edit', t: 'edit docs/x.md' }, { run: 'r', ts: 600, k: 'edit', t: 'edit src/a.mjs' }] };
  assert.deepEqual([...b.outOfScope(lane, r, 2000)], ['..\\bench.txt', 'docs/x.md']);
  assert.deepEqual([...b.outOfScope(lane, r, 800)], ['docs/x.md']);
  // 没写范围的任务也标出写到工作目录外的
  assert.deepEqual([...b.outOfScope(lane, { ...r, scope: [] }, 2000)], ['..\\bench.txt']);
});

test('单任务查看：超时以后只有第一条报错是原因，其余用 · 标（和分组查看、网页一致）', () => {
  const tl = createTimeline({ kind: 'exec', model: 'm', started_at: 0 }, (p) => p);
  tl.finish({ status: 'timeout', duration_s: 60, errors: ['hit the 1-minute limit', 'codex exit 1: mcp worker quit'] }, { kind: 'exec', model: 'm', started_at: 0 });
  const text = tl.lines(120).map(plain).join('\n');
  assert.match(text, /✗ hit the 1-minute limit/); assert.match(text, /· codex exit 1: mcp worker quit/); assert.doesNotMatch(text, /✗ codex exit 1/);
});

test('网页终端区的结论和错误按终端的颜色上色：原因红、次要报错暗、越界黄，拆成带色的片段', () => {
  const b = displayBoard();
  const r = { id: 'r', lane: 'r', kind: 'exec', model: 'm', status: 'timeout', started_at: 0, ended_at: 1000, cwd: 'O:\\w',
    display: { status: 'timeout', errors: ['hit the 1-minute limit', 'codex exit 1'], changes: { outside_cwd: [{ path: 'O:\\x.txt', in_scope: false }] }, cwd: 'O:\\w' } };
  const lines = b.conclusion(r, 120).map((l) => l.text);
  assert.ok(lines.some((l) => l.startsWith('\x1b[31m✗\x1b[0m') && plain(l).includes('hit the 1-minute limit')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('\x1b[2m') && plain(l).startsWith('· codex exit 1')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('\x1b[33m⚠\x1b[0m')), lines.join('\n'));
  const parts = b.painted(lines.find((l) => plain(l).includes('hit the 1-minute limit')));
  assert.equal(parts[0].className, 'c-bad'); assert.equal(parts[0].textContent, '✗');
  assert.deepEqual([...b.painted('no colors')], ['no colors']);
});

test('整个对话闲下来时 Claude Code 卡片离场（进度 0→1），重新活跃时倒着回来；刚打开时直接停在当时的样子，中途反过来从当前进度接着放', () => {
  const b = displayBoard();
  let clock = 0;
  b.context.performance.now = () => clock;
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'idle', started_at: 0 });
  b.onEv({ run: 'cc', ts: 1000, k: 'msg', t: 'done' });
  const cc = b.B.laneById.get('cc'), quiet = 30 * 60000, empty = { groups: [] };
  // 刚打开：已经闲下来，直接算离开了，不放动画；刻度带里还有组时不离开
  assert.equal(b.ccAway(empty, quiet), 1);
  assert.equal(b.ccAway({ groups: [{}] }, quiet), 1); // 刻度带里有了组：状态翻转，从完全离开开始倒着回来
  clock = 800; assert.ok(Math.abs(b.ccAway({ groups: [{}] }, quiet) - 0.5) < 1e-9);
  // 中途又闲下来：从当前进度（0.5）接着往离开的方向放
  assert.ok(Math.abs(b.ccAway(empty, quiet) - 0.5) < 1e-9);
  clock = 1600; assert.ok(Math.abs(b.ccAway(empty, quiet) - 1) < 1e-9);
  // Claude Code 重新活跃（状态不是 idle）：倒着回来，放完是 0
  cc.runs[0].status = 'running';
  assert.equal(b.ccAway(empty, quiet), 1);
  clock = 1600 + 1600; assert.equal(b.ccAway(empty, quiet), 0);
  assert.equal(b.CC_AWAY.away, false);
  // 闲了很久、看板上没有 Claude Code 记录的对话：刻度带空着就算离开，打开时直接停在离开的样子
  const old = displayBoard();
  assert.equal(old.ccAway({ groups: [] }, quiet), 1);
  assert.equal(old.ccAway({ groups: [{}] }, quiet), 1); // 有了席位就回来（从离开的样子开始倒放）
});

test('镜头按对数插值缩放、绕不动点缩放（滚轮下那一点始终不动），缩放不变时直接平移', () => {
  const b = displayBoard(), a = { k: 1, tx: 0, ty: 0 };
  // 以屏幕 (300, 200) 为中心放大 4 倍：目标里这一点下面还是同一个世界坐标
  const goal = { k: 4, tx: 300 - (300 - 0) * 4, ty: 200 - (200 - 0) * 4 };
  for (const u of [0.1, 0.5, 0.9]) {
    const v = b.viewAt(a, goal, u), worldX = (300 - v.tx) / v.k, worldY = (200 - v.ty) / v.k;
    assert.ok(Math.abs(worldX - 300) < 1e-9 && Math.abs(worldY - 200) < 1e-9, `u=${u}`);
  }
  // 一半的时候是几何平均（放大 4 倍走到一半是 2 倍，不是 2.5 倍）
  assert.ok(Math.abs(b.viewAt(a, goal, 0.5).k - 2) < 1e-9);
  assert.ok(Math.abs(b.viewAt(a, goal, 1).k - 4) < 1e-9);
  // 缩放一样：直接平移
  assert.deepEqual({ ...b.viewAt({ k: 2, tx: 0, ty: 0 }, { k: 2, tx: 100, ty: -50 }, 0.25) }, { k: 2, tx: 25, ty: -12.5 });
});

test('节拍取真实事件：派出最强，回一句话最轻；0.8 秒内不比上一下强的并掉（只算整体那一下），各车道照样记；1.2 秒以前的不算', () => {
  // 回放里按记录时刻算
  const b = displayBoard(), t = 100000;
  Object.assign(b.B.clock, { mode: 'replay', speed: 1 });
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  b.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'running', started_at: t - 500, ended_at: null });
  b.onEv({ run: 'cc', ts: t - 200, k: 'msg', t: 'started' });
  b.onEv({ run: 'cc', ts: t - 5000, k: 'msg', t: 'old' });
  const near = (x, y) => Math.abs(x - y) < 1e-9, at = (s, age) => s * Math.exp(-age * 4.5);
  let beat = b.beatsAt(t);
  // 派出那一下（0.5 秒前）算整体；0.3 秒后那句话更轻，并掉，只让 Claude Code 自己的光路变宽；5 秒前那句不算
  assert.ok(near(beat.env, at(0.9, 0.5)), String(beat.env));
  assert.ok(near(beat.lanes.get('seat'), at(0.9, 0.5)));
  assert.ok(near(beat.lanes.get('cc'), at(0.45, 0.2)));
  // 交回结果离派出不到 0.8 秒、又不比它强：整体也并掉；过了 1.2 秒都不算
  b.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'done', started_at: t - 500, ended_at: t - 100 });
  beat = b.beatsAt(t);
  assert.ok(near(beat.env, at(0.9, 0.5))); assert.ok(near(beat.lanes.get('seat'), at(0.8, 0.1)));
  beat = b.beatsAt(t + 2000);
  assert.equal(beat.env, 0); assert.equal(beat.lanes.size, 0);
  // 更强的一下离上一下再近也照算：先回一句话，0.2 秒后派出
  const c = displayBoard();
  Object.assign(c.B.clock, { mode: 'replay', speed: 1 });
  c.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  c.onEv({ run: 'cc', ts: t - 300, k: 'msg', t: 'on it' });
  c.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'running', started_at: t - 100, ended_at: null });
  assert.ok(near(c.beatsAt(t).env, at(0.9, 0.1)));
});

test('直播里节拍从页面第一次看到事件起算：连上时开头那一批不算，之后新到的晚得再多也照样最亮', () => {
  const b = displayBoard(), t = 100000, at = (s, age) => s * Math.exp(-age * 4.5), near = (x, y) => Math.abs(x - y) < 1e-9;
  b.B.clock.mode = 'live';
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  // 刚连上、开头那一批还没收完（服务还没发 synced）：0.3 秒前的一句回话是旧的，收完以后也不再算
  b.onEv({ run: 'cc', ts: t - 300, k: 'msg', t: 'before open' });
  assert.equal(b.beatsAt(t).env, 0);
  b.B.synced = true;
  assert.equal(b.beatsAt(t + 50).env, 0);
  // 开头那一批和 synced 一起到、中间没画过一帧：收完以后第一次算时，已经在的也是旧的
  const c = displayBoard();
  c.B.clock.mode = 'live';
  c.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  c.onEv({ run: 'cc', ts: t - 300, k: 'msg', t: 'before open' });
  c.B.synced = true;
  assert.equal(c.beatsAt(t).env, 0);
  c.onEv({ run: 'cc', ts: t + 100, k: 'msg', t: 'after open' });
  assert.ok(near(c.beatsAt(t + 100).env, 0.45));
  // 0.6 秒前派出、现在才送到：从现在起算，正是最亮的时候；0.3 秒后按看到的时刻衰减
  b.onRun({ id: 'late', model: 'm', kind: 'exec', status: 'running', started_at: t + 100 - 600, ended_at: null });
  assert.ok(near(b.beatsAt(t + 100).env, 0.9));
  assert.ok(near(b.beatsAt(t + 400).env, at(0.9, 0.3)));
  // 工具调用前的那句话要等工具调用生成完才写进记录，晚了 14 秒才到：照样满值；晚了 150 秒的不算
  const t2 = t + 3000;
  b.onEv({ run: 'cc', ts: t2 - 14000, k: 'msg', t: 'slow write' });
  assert.ok(near(b.beatsAt(t2).env, 0.45));
  b.onRun({ id: 'old', model: 'm', kind: 'exec', status: 'running', started_at: t2 - 150000, ended_at: null });
  assert.equal(b.beatsAt(t2).lanes.get('old'), undefined);
  // 重连（新的 hello，又是开头那一批）：这时到的又都算旧的
  const t3 = t2 + 3000;
  Object.assign(b.B, { hello: { v: 3 }, synced: false });
  b.onRun({ id: 'again', model: 'm', kind: 'exec', status: 'running', started_at: t3 - 200, ended_at: null });
  assert.equal(b.beatsAt(t3).env, 0);
});

test('席位的加速脉冲按报上来的分段用量放：连上时已有的不放，之后每到一份放一次，6 秒内只放一次，整轮总数不算；Claude Code 照旧看速度', () => {
  const b = displayBoard(), t = 100000, clock = { ms: 0 }, near = (x, y) => Math.abs(x - y) < 1e-9;
  b.context.performance.now = () => clock.ms;
  b.B.clock.mode = 'live';
  b.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'running', started_at: t - 60000, ended_at: null });
  b.onEv({ run: 'seat', ts: t - 30000, k: 'usage', u: { out: 300 } });
  const rates = new Map([['seat', 0]]), step = (at, ms = 16, quiet = false) => { clock.ms += ms; b.trackSurges(rates, quiet, at); };
  // 开头那一批：已有的用量不放；和 synced 一起到、中间没画过一帧的也不放
  step(t);
  b.onEv({ run: 'seat', ts: t - 1000, k: 'usage', u: { out: 300 } });
  b.B.synced = true;
  step(t);
  assert.equal(b.surgeAge('seat'), null);
  // 新到一份：放，强度按 token 数（600 以上是满的）
  b.onEv({ run: 'seat', ts: t - 500, k: 'usage', u: { out: 900 } });
  step(t);
  assert.equal(b.surgeAge('seat'), 0); assert.equal(b.SURGE.get('seat').k, 1);
  // 2 秒后又到一份：6 秒内不再放
  b.onEv({ run: 'seat', ts: t + 1500, k: 'usage', u: { out: 300 } });
  step(t + 2000, 2000);
  assert.ok(near(b.surgeAge('seat'), 2));
  // 整轮总数不是一次请求，不放；切换动画中到的不放，过后也不补
  b.onEv({ run: 'seat', ts: t + 8000, k: 'usage', tot: 1, u: { out: 5000 } });
  step(t + 9000, 7000);
  assert.equal(b.surgeAge('seat'), null);
  b.onEv({ run: 'seat', ts: t + 9500, k: 'usage', u: { out: 100 } });
  step(t + 10000, 16, true); step(t + 10000);
  assert.equal(b.surgeAge('seat'), null);
  b.onEv({ run: 'seat', ts: t + 11000, k: 'usage', u: { out: 120 } });
  step(t + 11000);
  assert.equal(b.surgeAge('seat'), 0); assert.ok(near(b.SURGE.get('seat').k, 0.55 + 0.45 * 0.2));
  // 重连（新的 hello）：开头那一批里的用量又是旧的，不放
  Object.assign(b.B, { hello: { v: 3 }, synced: false });
  b.onEv({ run: 'seat', ts: t + 19000, k: 'usage', u: { out: 300 } });
  step(t + 20000, 7000);
  b.B.synced = true;
  step(t + 20000);
  assert.equal(b.surgeAge('seat'), null);
  // Claude Code，以及还没有分段用量的席位（旧记录只有整轮总数）：速度一下子高出平均一截才放
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  b.onRun({ id: 'old', model: 'm', kind: 'exec', status: 'running', started_at: t, ended_at: null });
  b.onEv({ run: 'old', ts: t + 1000, k: 'usage', tot: 1, u: { out: 900 } });
  const rate = (r) => new Map([['cc', r], ['old', r]]);
  clock.ms += 16; b.trackSurges(rate(5), false, t + 11000);
  // 刚建的条目头 4 秒不按速度放
  clock.ms += 16; b.trackSurges(rate(60), false, t + 11000);
  assert.equal(b.surgeAge('cc'), null);
  clock.ms += 5000; b.trackSurges(rate(5), false, t + 11000);
  clock.ms += 16; b.trackSurges(rate(12), false, t + 11000);
  assert.equal(b.surgeAge('cc'), null); assert.equal(b.surgeAge('old'), null);
  clock.ms += 16; b.trackSurges(rate(60), false, t + 11000);
  assert.equal(b.surgeAge('cc'), 0); assert.equal(b.surgeAge('old'), 0);
});

test('直播里光路上的事件脉冲从页面第一次看到事件起算：连上时开头那一批不放，晚到的照样从头走，太晚的不放；同一车道同一时刻的几件事只放一次', () => {
  const b = displayBoard(), t = 100000, near = (x, y) => Math.abs(x - y) < 1e-9;
  b.B.clock.mode = 'live';
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  b.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'running', started_at: t - 60000, ended_at: null });
  b.onEv({ run: 'cc', ts: t - 500, k: 'dispatch', t: 'run x', target: ['seat'] });
  b.onEv({ run: 'seat', ts: t - 400, k: 'edit', t: 'update a' });
  // 开头那一批：synced 之前、之后算的第一帧都不放
  assert.equal(b.recentPulses(t).length, 0);
  b.B.synced = true;
  assert.equal(b.recentPulses(t + 16).length, 0);
  // 一次改了三个文件、晚了 3 秒才到：从现在起算，只有一道
  for (const name of ['a', 'b', 'c']) b.onEv({ run: 'seat', ts: t - 2900, k: 'edit', t: `update ${name}` });
  assert.equal(JSON.stringify(b.recentPulses(t + 100).map((p) => [p.lane, !!p.out, p.age])), JSON.stringify([['seat', true, 0]]));
  assert.ok(near(b.recentPulses(t + 600)[0].age, 0.5));
  // Claude Code 晚到的派出：交互光线上的光点也从现在起走
  b.onEv({ run: 'cc', ts: t - 300, k: 'dispatch', t: 'run y', target: ['seat'] });
  assert.equal(JSON.stringify(b.recentPulses(t + 700).filter((p) => p.dir).map((p) => [p.lane, p.dir, p.age])), JSON.stringify([['seat', 1, 0]]));
  // 晚了 2 分钟以上的不放
  b.onEv({ run: 'seat', ts: t + 700 - 130000, k: 'end' });
  assert.ok(!b.recentPulses(t + 800).some((p) => p.out && p.age === 0));
  // Claude Code 一条回复里并行改的两个文件：时刻不同，同一帧一起到，也只放一道；文件名标签同样从第一次看到起算
  b.onEv({ run: 'cc', ts: t - 3000, k: 'edit', t: 'update src/x.mjs' });
  b.onEv({ run: 'cc', ts: t - 1000, k: 'edit', t: 'update src/y.mjs' });
  assert.equal(b.recentPulses(t + 900).filter((p) => p.lane === 'cc' && p.out).length, 1);
  assert.equal(JSON.stringify(b.recentLabels(t + 900).filter((l) => l.lane === 'cc').map((l) => l.age)), JSON.stringify([0, 0]));
  // 回放照旧按事件的时刻，同一时刻的几件事也只放一次
  const c = displayBoard();
  Object.assign(c.B.clock, { mode: 'replay', speed: 1 });
  c.onRun({ id: 'seat', model: 'm', kind: 'exec', status: 'running', started_at: t - 60000, ended_at: null });
  for (const name of ['a', 'b']) c.onEv({ run: 'seat', ts: t - 400, k: 'edit', t: `update ${name}` });
  assert.equal(JSON.stringify(c.recentPulses(t).map((p) => [p.lane, !!p.out, p.age])), JSON.stringify([['seat', true, 0.4]]));
});

test('断开一阵再连上，补回来的用量让速度一下子回来，不算加快；之后真的加快照常放', () => {
  const b = displayBoard(), clock = { ms: 0 };
  b.context.performance.now = () => clock.ms;
  b.B.clock.mode = 'live'; b.B.synced = true;
  b.onRun({ id: 'cc', lane: 'cc', kind: 'host', agent_type: 'host', model: 'opus', status: 'running', started_at: 0 });
  const go = (rate, ms = 16) => { clock.ms += ms; b.trackSurges(new Map([['cc', rate]]), false, 1000); };
  go(2); go(2, 5000);
  Object.assign(b.B, { hello: { v: 2 }, synced: false });
  go(40);
  b.B.synced = true;
  go(40); go(40);
  assert.equal(b.surgeAge('cc'), null);
  go(100);
  assert.equal(b.surgeAge('cc'), 0);
});

test('星云配色按输出量开平方定分量：Claude Code 最多占四成，席位最多四种，同一种颜色合在一起；只用过 Claude Code 时全是它', () => {
  const src = fs.readFileSync(new URL('../board/web/08-cosmos.js', import.meta.url), 'utf8'), at = src.indexOf('function nebulaMix(');
  const mix = vm.runInNewContext(`(${src.slice(at, src.indexOf('\n}\n', at) + 2)})`);
  const near = (x, y) => Math.abs(x - y) < 1e-9, w = (list) => list.map((m) => `${m.key}:${m.w.toFixed(3)}${m.running ? '*' : ''}`).join(' ');
  assert.equal(w(mix([], 5000, true)), 'claude:1.000*');
  // Claude Code 输出多得多，也最多占四成
  assert.equal(w(mix([{ key: 'qwen', out: 100 }], 10000, false)), 'claude:0.400 qwen:0.600');
  // 开平方：400 和 100 的输出分到 2:1；Claude Code 几乎没输出时分量很小
  const two = mix([{ key: 'qwen', out: 400, running: true }, { key: 'deepseek', out: 100 }], 1, false);
  assert.equal(w(two), 'claude:0.032 qwen:0.645* deepseek:0.323');
  assert.ok(near(two.reduce((s, m) => s + m.w, 0), 1));
  // 同一种颜色合在一起（两个 Qwen 席位、用 Claude 模型的席位并进 Claude Code），席位最多留四种
  const many = mix([{ key: 'qwen', out: 100 }, { key: 'qwen', out: 100 }, { key: 'claude', out: 900 }, { key: 'glm', out: 81 }, { key: 'kimi', out: 64 }, { key: 'grok', out: 49 }, { key: 'mimo', out: 36 }], 0, false);
  assert.equal(many.map((m) => m.key).join(' '), 'claude qwen glm kimi grok');
  // 同一种颜色先把输出加起来再开平方（两个 Qwen 席各 100，和一个 200 的一样），任务多的模型不会因为任务多就占得多
  assert.equal(w(mix([{ key: 'qwen', out: 100 }, { key: 'qwen', out: 100 }, { key: 'glm', out: 200 }], 0, false)), w(mix([{ key: 'qwen', out: 200 }, { key: 'glm', out: 200 }], 0, false)));
  // 正在跑、还没有输出的模型，分量至少是最多那种的六成
  assert.equal(w(mix([{ key: 'deepseek', out: 10000 }, { key: 'minimax', out: 0, running: true }], 0, false)), 'claude:0.006 deepseek:0.621 minimax:0.373*');
});
