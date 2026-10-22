import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, failed, seedRun, expected, normalize, json, write, poll, baseConfig, MESSAGES } from './helpers.mjs';
import { command, discussion } from './fixtures/reports.mjs';
import { liveGroup, frameOf, steadyClock } from './fixtures/watch-live.mjs';
import { watchRecords } from './fixtures/watch.mjs';
import { textWidth, wrapWidth } from '../foreman/skills/dispatch/scripts/util.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
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
  assert.match(heads[1], /^2 ● deepseek-v4\.1-flash max · opencode CLI +running <CLOCK>$/);
  assert.match(heads[2], /^3 ● mimo-v2\.6-pro high · pi CLI +running <CLOCK>$/);
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
  assert.equal(MESSAGES.en.watchMoreLines(1), '(1 more line; add --verbose to see everything)');
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
  assert.match(pi[0], /^● mimo-v2\.6-pro high · pi CLI +running <CLOCK>$/);
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
    { status: 'done', duration_s: 572, usage, usage_scope: 'this_run', last_request: { tokens: 81000, window: 486000 }, cost_usd: 0.066, report: discussion });
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
  assert.ok(colored.stdout.includes('\x1b[1mdeepseek-v4.1-flash max · opencode CLI\x1b[0m'));
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
  assert.deepEqual(wrapWidth('tokens: in 67k (cached 66%)', 13), ['tokens: in', '67k (cached', '66%)']);
  // 比一整行还长的单词才按字截断
  const long = wrapWidth('a supercalifragilisticexpialidocious word', 12);
  assert.ok(long.every((l) => textWidth(l) <= 12), long.join('|'));
  assert.equal(long.join('').replace(/\s/g, ''), 'asupercalifragilisticexpialidociousword');
});
