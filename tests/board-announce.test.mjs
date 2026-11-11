import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plannedSandbox as sandbox, taskArgs, output, failed, baseConfig, opencodeAgent, write, read, json, poll, stopBoard, seedRun, MESSAGES } from './helpers.mjs';
import { discussion } from './fixtures/reports.mjs';

const configure = (h, watch = {}) => {
  const c = baseConfig(); c.dispatch.watch = { terminal: false, web: true, ...watch }; h.config(c); return c;
};
const lockFile = (h) => path.join(h.runs, 'board.lock.json');
const fakeBoard = (h) => write(lockFile(h), { port: 4321, token: 'tok', pid: process.pid });
const launch = (h, options) => h.bridge(taskArgs(h, 'run', ['--no-snapshot']), options);
function announced(r, lang = 'zh') {
  const rows = r.stderr.split('\n'), at = rows.findIndex((line) => line.includes(' started · '));
  assert.ok(at >= 0, r.stderr);
  const [, mode, who, cell, mark] = /^foreman: (\w+) started · (.+) · (complex|effort set directly|generate)(?: · route ([①②③④]))? · run dir /.exec(rows[at]);
  assert.match(rows[at + 1], /^foreman: web board http:\/\/127\.0\.0\.1:\d+\//);
  const url = rows[at + 1].slice('foreman: web board '.length), m = MESSAGES[lang];
  assert.equal(rows[at + 2], `foreman: ${mark ? m.boardHandoffImage(mode, who, cell, mark, url) : m.boardHandoff(mode, who, cell === 'effort set directly' ? null : cell, url)}`);
  return { url, rows, at };
}

test('派出自行启动看板，按开工行给句子，续接用已续接；关闭时不启动也不提示', async (t) => {
  const h = sandbox(t), c = configure(h);
  // 派出命令一运行就留下这个对话的派出标记（钩子在一轮结束时看它），建计划不留
  const mark = path.join(path.dirname(h.userConfig), 'board-dispatched', 'test-session'), began = Date.now();
  output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'discuss', '--cell', 'complex', '--group', 'no-mark', '--seat', 'codex']));
  assert.equal(fs.existsSync(mark), false);
  try {
    const first = await launch(h), result = output(first), { url } = announced(first);
    assert.ok(fs.statSync(mark).mtimeMs >= began - 2000);
    assert.equal(result.board_url, url); assert.doesNotThrow(() => process.kill(json(lockFile(h)).pid, 0));
    const next = await h.bridge(['resume', '--run', result.run_id, '--level', 'complex', '--reason', 'answer', '--brief', '-', '--no-snapshot']);
    output(next); assert.equal(announced(next).url, url); assert.match(next.stderr, /已续接：/);
  } finally { await stopBoard(h); }
  c.dispatch.watch.web = false; h.config(c);
  const off = await launch(h); assert.equal(Object.hasOwn(output(off), 'board_url'), false);
  assert.doesNotMatch(off.stderr, /foreman: (web board |告诉用户|tell the user)/); assert.equal(fs.existsSync(lockFile(h)), false);
});

test('非 Codex、英文和图像路线都沿用开工行的模型标签', async (t) => {
  const h = sandbox(t), c = configure(h); fakeBoard(h);
  c.agents.oc = opencodeAgent(); c.modules.default.discuss.complex = [{ agent: 'oc', effort: 'high' }];
  c.modules.default.discuss.seats.complex = 1; h.config(c);
  for (const lang of ['zh', 'en']) {
    const s = h.scenario({ last_message: discussion }), r = await h.bridge(taskArgs(h, 'discuss'), { env: { ...s.env, FOREMAN_LANG: lang } });
    assert.equal(output(r).board_url, announced(r, lang).url);
  }
  h.scenario();
  c.dispatch.confirm = { image: 'auto' }; c.modules.default.image.generate = [{ agent: 'codex', effort: 'high', required: true }]; h.config(c);
  const plan = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'image', '--cell', 'generate', '--group', 'image-board', '--route', '1', '--route-auto', '合成路线', '--seat', 'codex']));
  const image = await h.bridge(['image', '--plan', plan.plan_id, '--seat', '1', '--scope', path.join(h.cwd, 'out'), '--brief', '-', '--no-snapshot']);
  output(image); announced(image); assert.match(image.stderr, /告诉用户.*generate 路线 ①/);
});

test('结果和两种 status 只在输出加实时地址，磁盘记录不带地址，status 不启动服务', async (t) => {
  const h = sandbox(t), c = configure(h); fakeBoard(h);
  const r = output(await launch(h)), url = r.board_url;
  assert.deepEqual(Object.keys(r).slice(0, 2), ['run_id', 'board_url']);
  for (const file of ['result.json', 'meta.json']) assert.equal(Object.hasOwn(json(path.join(h.runs, r.run_id, file)), 'board_url'), false);
  const plan = output(await h.bridge(['plan', '--cwd', h.cwd, '--module', 'discuss', '--cell', 'complex', '--group', 'status-board', '--seat', 'codex']));
  const targets = [['--run', r.run_id], ['--plan', plan.plan_id]];
  for (const args of targets) assert.equal(output(await h.bridge(['status', ...args])).board_url, url);
  assert.deepEqual(Object.keys(output(await h.bridge(['status', '--run', r.run_id]))).slice(0, 2), ['run_id', 'board_url']);
  seedRun(h, 'live', { status: 'running', pid: process.pid });
  assert.equal(output(await h.bridge(['status', '--run', 'live'])).board_url, url);
  const gate = path.join(h.home, 'finish'), s = h.scenario({ steps: [{ wait_for: gate }] });
  const pending = h.startBridge(taskArgs(h, 'run', ['--no-snapshot']), { env: s.env });
  await poll(() => pending.stderr.includes('foreman: web board '), '派出已读到地址');
  fs.rmSync(lockFile(h)); write(gate, 'go'); assert.equal(Object.hasOwn(output(await pending.done), 'board_url'), false);
  for (const args of targets) assert.equal(Object.hasOwn(output(await h.bridge(['status', ...args])), 'board_url'), false);
  assert.equal(fs.existsSync(lockFile(h)), false);
  fakeBoard(h); c.dispatch.watch.web = false; h.config(c);
  assert.equal(Object.hasOwn(output(await launch(h)), 'board_url'), false);
  for (const args of targets) assert.equal(Object.hasOwn(output(await h.bridge(['status', ...args])), 'board_url'), false);
  c.dispatch.watch.web = true; h.config(c); write(path.join(h.runs, r.run_id, 'meta.json'), '{');
  assert.equal(output(await h.bridge(['status', '--run', r.run_id])).board_url, url);
});

test('web_open 每个安全对话只打开一次，清理旧标记；缺省、关闭、无对话和项目配置不打开', async (t) => {
  const h = sandbox(t), c = configure(h, { web_open: true }); fakeBoard(h);
  const opened = path.join(h.home, 'opened'), dir = path.join(path.dirname(h.userConfig), 'board-opened');
  h.env.FOREMAN_TEST_OPEN = opened;
  const old = write(path.join(dir, 'old-session'), ''); fs.utimesSync(old, 0, 0);
  const first = await launch(h), { url, rows, at } = announced(first); output(first);
  assert.equal(rows[at + 3], `foreman: ${MESSAGES.zh.boardOpened}`); assert.equal(fs.existsSync(old), false);
  // 同一个对话再派出不再打开，但会刷新标记的时间：还在派活的对话不会被当成闲置清掉
  const own = path.join(dir, 'test-session'), twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600000);
  fs.utimesSync(own, twoDaysAgo, twoDaysAgo);
  const second = await launch(h); output(second); assert.ok(!second.stderr.includes(MESSAGES.zh.boardOpened));
  assert.equal(read(opened), `${url}\n`);
  assert.ok(Date.now() - fs.statSync(own).mtimeMs < 60000);
  for (const session of ['next.session-2', '', '../unsafe']) {
    h.env.CLAUDE_CODE_SESSION_ID = session; output(await launch(h));
  }
  assert.deepEqual(read(opened).trimEnd().split('\n'), [url, url.replace('s=test-session', 's=next.session-2')]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['next.session-2', 'test-session']);
  for (const enabled of [undefined, false]) {
    if (enabled === undefined) delete c.dispatch.watch.web_open; else c.dispatch.watch.web_open = enabled;
    h.config(c); h.env.CLAUDE_CODE_SESSION_ID = `off-${enabled}`; h.env.FOREMAN_TEST_OPEN = path.join(h.home, `opened-${enabled}`);
    output(await launch(h)); assert.equal(fs.existsSync(h.env.FOREMAN_TEST_OPEN), false);
  }
  delete c.dispatch.watch.web_open; h.config(c); h.env.CLAUDE_CODE_SESSION_ID = 'project-only';
  h.write('.claude/foreman.json', { dispatch: { watch: { terminal: false, web: true, web_open: true } } });
  output(await launch(h)); assert.equal(fs.existsSync(h.env.FOREMAN_TEST_OPEN), false);
  assert.equal(Object.hasOwn(output(await h.bridge(['config', '--cwd', h.cwd])).effective.dispatch.watch, 'web_open'), false);
});

test('web_open 可选且必须为布尔值，额外键仍报 watchShape，加载不补写开关', async (t) => {
  const h = sandbox(t); configure(h); const before = read(h.userConfig);
  output(await h.bridge(['config'])); assert.equal(read(h.userConfig), before);
  assert.equal(MESSAGES.zh.boardHandoff('run', 'model', null, 'url'), '告诉用户（写进回复正文；几个任务一起派出时合成一句，链接写一次）：已派出：model · [网页看板](url)');
  assert.equal(MESSAGES.en.boardHandoff('resume', 'model', null, 'url'), 'tell the user (in your reply text; for several handoffs at once, one sentence with the link once): Resumed: model · [web board](url)');
  h.env.FOREMAN_TEST_OPEN = path.join(h.home, 'never-open');
  for (const lang of ['zh', 'en']) for (const watch of [{ web_open: 'yes' }, { web_open: true, extra: false }]) {
    configure(h, watch); failed(await h.bridge(['config'], { env: { FOREMAN_LANG: lang } }), MESSAGES[lang].watchShape);
  }
});
