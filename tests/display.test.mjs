import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, taskArgs, failed, seedRun, expected, normalize, json, write, baseConfig, MESSAGES } from './helpers.mjs';
import { command } from './fixtures/reports.mjs';
import { liveGroup, frameOf, steadyClock } from './fixtures/watch-live.mjs';
import { textWidth } from '../foreman/skills/dispatch/scripts/util.mjs';
const M = MESSAGES.zh;
const D = MESSAGES.en; // 实时查看、status 和开工那一行的显示文字中英两个插件一样，用英文那一套
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

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

test('实时面板只给状态记号和状态词上色：模型名、标题和组名加粗，动作、计数和思考摘要用暗色，说的话用默认色', async (t) => {
  const h = sandbox(t);
  const { group } = liveGroup(h, process.pid);
  const frame = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '100x30', NO_COLOR: '' });
  assert.match(frame[0], /^\x1b\[1mGroup live-group · 合成讨论：登记锁原地重试 · 4 runs\x1b\[0m +\x1b\[36mrunning 4\x1b\[0m$/);
  assert.equal(frame[1], 'Plan 20000101-000000-plan: \x1b[36min progress\x1b[0m');
  assert.match(frame[3], /^\x1b\[36m●\x1b\[0m \x1b\[1mgpt-6-astra · Codex CLI · effort max\x1b\[0m +\x1b\[36mrunning\x1b\[0m\x1b\[2m \d+:\d\d · commands 6\x1b\[0m$/);
  assert.ok(frame[4].startsWith('  ◆ 先看一下登记锁') && !frame[4].includes('\x1b['), frame[4]);
  for (const line of ['  \x1b[2mread tests/admission.test.mjs\x1b[0m', '  \x1b[2msearch **/*.lock\x1b[0m', `  \x1b[2m${D.watchThinking('删除挂起时 openSync 会报 EPERM，要确认重试的上限是多少。')}\x1b[0m`]) {
    assert.ok(frame.includes(line), line);
  }
  // API 的思考原文不在面板里滚动，标题右侧写思考了多久、收到多少字
  assert.match(plain(frame.find((l) => l.includes('kimi-k2.6 · API'))), /effort default +thinking \d+:\d\d · 3,200 characters so far$/);
  assert.ok(!frame.some((l) => l.includes('先确认登记锁的语义')));
});

test('组视图窗口不够高时先压缩正文，连各块的标题都放不下时，最后一行写还有几个任务没显示', async (t) => {
  const h = sandbox(t);
  const { group, seats } = liveGroup(h, process.pid);
  // 标题各不相同时每块多一行标题：64x18 放不下正文，四块的模型和标题照样都在
  seats.forEach((s, i) => { const file = path.join(h.runs, s.id, 'meta.json'); write(file, { ...json(file), title: `合成任务 ${i + 1}` }); });
  const four = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '64x18' });
  for (const model of ['gpt-6-astra', 'deepseek-v4.1-flash', 'mimo-v2.6-pro', 'kimi-k2.6']) assert.ok(four.some((l) => l.startsWith(`● ${model} · `)), model);
  for (const i of [1, 2, 3, 4]) assert.ok(four.includes(`  合成任务 ${i}`), four.join('\n'));
  assert.ok(!four.some((l) => l.startsWith('…')));
  for (const n of [5, 6]) seedRun(h, `20000101-00000${n}-eeee`, { mode: 'discuss', kind: 'discuss', title: `合成任务 ${n}`, status: 'running', pid: process.pid, group, ended_at: undefined });
  const six = await frameOf(h, ['watch', '--group', group, '--no-intro'], { FOREMAN_TEST_SCREEN: '64x16' });
  assert.equal(six.length, 16);
  assert.equal(six.at(-2), D.dashHidden(2), six.join('\n'));
});

test('组视图汇总的回看命令：记录目录带空格时给路径加引号，整行复制就能运行', async (t) => {
  const h = sandbox(t);
  h.runs = path.join(h.home, 'my runs');
  const c = baseConfig();
  c.dispatch.runs_dir = h.runs;
  h.config(c);
  seedRun(h, '20000101-a', { group: 'spaced' }, { status: 'done', duration_s: 1 });
  const r = await h.bridge(['watch', '--group', 'spaced']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(D.watchReplay(`node "${path.join(h.runs, 'watch.mjs')}" --run 20000101-a`)), r.stdout);
});

test('时间线的实时画面：读文件和搜索不算命令，思考摘要只留最近一条的第一行，折叠行跟在失败的命令后面', async (t) => {
  const h = sandbox(t);
  const { seats } = liveGroup(h, process.pid);
  const pi = steadyClock(await frameOf(h, ['watch', '--run', seats[2].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '120x16' }));
  assert.ok(pi[0].endsWith('┌ mimo-v2.6-pro · pi CLI · effort high'), pi[0]);
  assert.ok(pi.includes('      │ Model xiaomi/mimo-v2.6-pro'));
  assert.ok(pi.includes('      │   read foreman/skills/dispatch/scripts/records.mjs'));
  assert.ok(pi.includes('      │   search tests'));
  assert.deepEqual(pi.filter((l) => l.includes(D.watchThinking(''))), [`      │   ${D.watchThinking('删除挂起时 openSync 会报 EPERM，要确认重试的上限是多少。')}`]);
  assert.match(pi.at(-1), /^⠋ mimo-v2\.6-pro · running <CLOCK> · reads 1 · searches 1 +↑↓ scroll · q quit$/);
  const codex = steadyClock(await frameOf(h, ['watch', '--run', seats[0].id, '--no-intro'], { FOREMAN_TEST_SCREEN: '120x18' }));
  const failure = codex.indexOf(`      │     ✗ ${D.watchExit(1, 'not ok 3 - 登记锁正被删除')}`);
  assert.ok(failure > 0, codex.join('\n'));
  assert.equal(codex[failure - 1], '      │   $ node --test tests/admission.test.mjs');
  assert.equal(codex[failure + 1], `      │   ${D.watchFolded(D.foldKinds.command(2), true)}`);
  assert.match(codex.at(-1), /^⠋ gpt-6-astra · running <CLOCK> · commands 6 · \$ rg -n retryBusy/);
});

test('status 表：状态词和用时写英文，中英两个插件一样；模式和等级写原词，模型标签去掉提供方前缀，各列按显示宽度对齐', async (t) => {
  const h = sandbox(t);
  const usage = { input_tokens: 585000, cached_input_tokens: 503100, output_tokens: 19000 };
  seedRun(h, '20000101-a', { mode: 'discuss', kind: 'discuss', agent: 'oc', agent_type: 'opencode cli', model: 'opencode-go/deepseek-v4.1-flash', effort: 'max', title: '合成讨论' },
    { status: 'done', duration_s: 572, usage, usage_scope: 'this_run', last_request: { tokens: 81000, window: 486000 }, cost_usd: 0.066 });
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
  assert.ok(colored.stdout.includes('\x1b[1mdeepseek-v4.1-flash · opencode CLI · effort max\x1b[0m'));
  assert.ok(colored.stdout.includes('\x1b[2mtook 9m 32s\x1b[0m'));
});

test('开工那一行中英两个插件都写 <模式> started · <模型> · <接入方式> · effort · level · run dir，用" · "分隔', async (t) => {
  const h = sandbox(t);
  for (const lang of ['zh', 'en']) {
    const r = await h.bridge(taskArgs(h), { env: { FOREMAN_LANG: lang } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stderr.includes(`foreman: run started · fake-codex · Codex CLI · effort max · level complex · run dir ${JSON.parse(r.stdout).run_dir}\n`), r.stderr);
  }
});

test('子命令认 --help：只打印这一条的用法，退出码 0，不生成配置文件，也不迁移旧版的配置', async (t) => {
  const h = sandbox(t, { config: false });
  // 旧版 codex-bridge 的配置还在、新配置还没有：平常第一次运行就会复制过去，--help 不该动它
  const legacy = write(path.join(h.home, '.claude', 'codex-bridge.json'), baseConfig());
  for (const cmd of Object.keys(M.help)) {
    const r = await h.bridge([cmd, '--help']);
    assert.equal(r.code, 0, cmd);
    assert.equal(r.stdout, `${M.help[cmd]}\n`, cmd);
    assert.equal(r.stderr, '', cmd);
  }
  for (const cmd of ['run', 'discuss', 'review', 'resume', 'image', 'plan', 'status', 'watch', 'cancel']) assert.ok(M.help[cmd], cmd);
  assert.equal((await h.bridge(['plan', '--module', 'image', '--help'])).stdout, `${M.help.plan}\n`); // 跟在其他参数后面也认
  assert.equal((await h.bridge(['assets', '--help'])).stdout, `${M.assetsUsage}\n`);
  for (const action of Object.keys(M.assetsActions)) {
    const r = await h.bridge(['assets', action, '--help']);
    assert.equal(r.code, 0, action);
    assert.equal(r.stdout, `${M.assetsHelp(action)}\n`, action);
  }
  assert.equal((await h.bridge(['--help'])).stdout, `${M.usage}\n`);
  assert.equal((await h.bridge(['watch', '--help'], { env: { FOREMAN_LANG: 'en' } })).stdout, `${MESSAGES.en.help.watch}\n`);
  failed(await h.bridge(['bogus', '--help']), M.usage);
  failed(await h.bridge(['assets', 'bogus', '--help']), M.assetsUsage);
  assert.equal(fs.existsSync(h.userConfig), false);
  assert.deepEqual(fs.readdirSync(path.dirname(legacy)), ['codex-bridge.json']);
  // 写在选项的值里的 --help 不算：这是一个标题叫 --help 的普通派活，照常因为缺 --level 报错
  const titled = await h.bridge(['run', '--cwd', h.cwd, '--title', '--help', '--brief', '-']);
  assert.equal(titled.code, 2);
  assert.ok(titled.stderr.includes(M.missingLevel('simple / normal / complex')), titled.stderr);
});
