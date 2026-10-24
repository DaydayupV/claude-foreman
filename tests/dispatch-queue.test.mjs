import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, baseConfig, seedRun, write, json, poll, taskArgs, output, failed, MESSAGES, BRIDGE } from './helpers.mjs';
import { pathToFileURL } from 'node:url';

const M = MESSAGES.zh;
const activeId = '20000101-000000-0001';
const tickets = (h) => {
  const dir = path.join(h.runs, '.state/queue/codex');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n)).map((n) => ({ ...json(path.join(dir, n)), file: path.join(dir, n) })).sort((a, b) => a.sequence - b.sequence) : [];
};
function full(h, limit = 1, extra = {}) {
  const cfg = baseConfig(); cfg.agents.codex.max_parallel = limit; h.config(cfg);
  return seedRun(h, activeId, { status: 'running', pid: process.pid, ...extra });
}
const finish = (dir) => write(path.join(dir, 'meta.json'), { ...json(path.join(dir, 'meta.json')), status: 'done' });
const args = (h, title, extra = []) => taskArgs(h, 'run', ['--no-snapshot', '--title', title, ...extra]);

test('两个同时派出的进程只争到一个余位，已有队列先拿空位，新派发不能插队', async (t) => {
  const h = sandbox(t), dir = full(h, 2);
  const gates = [0, 1, 2].map((i) => path.join(h.home, `gate-${i}`));
  const scenarios = gates.map((gate, i) => h.scenario({ steps: [{ wait_for: gate }] }, `fifo-${i}`));
  const handles = [0, 1].map((i) => h.startBridge(args(h, `fifo-${i}`), { env: scenarios[i].env }));
  await poll(() => tickets(h).length === 1, '后来的派发排队');
  const admitted = await h.running((m) => m.id !== activeId), waiting = tickets(h)[0];
  assert.notEqual(admitted.title, waiting.title); assert.equal(waiting.sequence, 1);
  const first = Number(admitted.title.at(-1)), second = 1 - first;
  assert.equal(handles[second].child.exitCode, null);
  await poll(() => handles[second].stderr.includes(M.queuePosition('codex', 2, 1, 60)), '位次提示');
  finish(dir);
  const third = h.startBridge(args(h, 'fifo-2'), { env: scenarios[2].env });
  await poll(() => h.records().some((m) => m.title === `fifo-${second}`) && tickets(h).some((q) => q.title === 'fifo-2'), '队首先登记，后来者等下一空位');
  assert.equal(h.records().some((m) => m.title === 'fifo-2'), false);
  write(gates[first], 'go'); output(await handles[first].done);
  await h.running((m) => m.title === 'fifo-2');
  write(gates[second], 'go'); write(gates[2], 'go');
  const secondResult = output(await handles[second].done), thirdResult = output(await third.done);
  assert.ok(admitted.id < secondResult.run_id && secondResult.run_id < thirdResult.run_id);
  assert.equal(tickets(h).length, 0);
});

test('排队进程被强制杀掉后，下一个持锁者清掉死票据，后面的人顶上', async (t) => {
  const h = sandbox(t), dir = full(h);
  const first = h.startBridge(args(h, 'killed'));
  await poll(() => tickets(h).length === 1, '第一张票据');
  const dead = tickets(h)[0]; first.stop(); await first.done;
  assert.equal(fs.existsSync(dead.file), true);
  const next = h.startBridge(args(h, 'next'));
  // 只读一次票据列表：连读两次时中间可能变了，第二次读到空列表会直接报错而不是接着等
  await poll(() => { const list = tickets(h); return list.length === 1 && list[0].title === 'next'; }, '死票据被回收');
  assert.equal(fs.existsSync(dead.file), false); assert.ok(tickets(h)[0].sequence > dead.sequence);
  // 票据先落盘、位次提示随后才写到 stderr：等提示出现，不能看到票据就断言
  await poll(() => next.stderr.includes(M.queuePosition('codex', 1, 1, 60)), '位次提示');
  finish(dir); output(await next.done); assert.equal(tickets(h).length, 0);
});

test('--queue-timeout 0 立即拒绝，不写票据；中文和英文提示都说明自动排队', async (t) => {
  const h = sandbox(t); full(h);
  failed(await h.bridge(args(h, 'no-wait', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, activeId));
  failed(await h.bridge(args(h, 'no-wait', ['--queue-timeout', '0']), { env: { FOREMAN_LANG: 'en' } }), MESSAGES.en.agentFull('codex', 1, 1, activeId));
  assert.equal(tickets(h).length, 0); assert.equal(h.calls().length, 0);
});

test('排队到期退出码 2 并清票据，计时包含排队；未开启计时没有计时输出', async (t) => {
  const h = sandbox(t); full(h);
  const r = await h.bridge(args(h, 'timeout', ['--queue-timeout', '0.025']), { env: { FOREMAN_PROFILE: '1' } });
  failed(r, M.queueTimeout('codex', 0.025)); assert.equal(tickets(h).length, 0);
  assert.ok(r.stderr.includes(M.queuePosition('codex', 1, 1, 1)), r.stderr);
  assert.match(r.stderr, /foreman-profile queue-wait [\d.]+/); assert.equal(h.records().length, 1);
  t.diagnostic(r.stderr.match(/foreman-profile queue-wait [\d.]+/)[0]);
  const quick = await h.bridge(args(h, 'no-profile', ['--queue-timeout', '0']));
  assert.equal(quick.stderr.includes('foreman-profile'), false);
});

test('名额已满时范围重叠仍立即拒绝，不进入队列', async (t) => {
  const h = sandbox(t); full(h, 1, { group: 'same', scope: ['src'] });
  failed(await h.bridge(args(h, 'overlap', ['--group', 'same', '--scope', 'src/child'])), M.scopeOverlap('same', activeId, ['src/child']));
  assert.equal(tickets(h).length, 0); assert.equal(h.calls().length, 0);
});

for (const damage of ['missing', 'json', 'shape']) test(`活动集合 ${damage} 时全量重建，准入结论相同`, async (t) => {
  const h = sandbox(t); full(h);
  const command = args(h, 'rebuild', ['--queue-timeout', '0']), expected = M.agentFull('codex', 1, 1, activeId);
  failed(await h.bridge(command), expected);
  const file = path.join(h.runs, '.state/active.json');
  if (damage === 'missing') fs.rmSync(file); else write(file, damage === 'json' ? '{broken' : { version: 1, high_water: '', active: 'bad' });
  failed(await h.bridge(command), expected);
  assert.deepEqual(json(file).active, [activeId]); assert.equal(json(file).high_water, activeId);
});

test('旧版本只写 meta 的新任务仍占名额，已结束的历史 meta 损坏不影响准入', async (t) => {
  const h = sandbox(t), cfg = baseConfig(); cfg.agents.codex.max_parallel = 1; h.config(cfg);
  const archived = seedRun(h, activeId);
  output(await h.bridge(args(h, 'warm')));
  write(path.join(archived, 'meta.json'), '{bad archive');
  const legacyId = '29990101-000000-abcd';
  const legacy = seedRun(h, legacyId, { status: 'running', pid: process.pid });
  fs.rmSync(path.join(legacy, 'events.jsonl'));
  assert.deepEqual(fs.readdirSync(legacy), ['meta.json']);
  failed(await h.bridge(args(h, 'legacy', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, legacyId));
  assert.deepEqual(json(path.join(h.runs, '.state/active.json')).active, [legacyId]);
  write(path.join(legacy, 'meta.json'), '{bad active');
  failed(await h.bridge(args(h, 'unreadable', ['--queue-timeout', '0'])), M.admissionUnreadable(M.list([path.join(legacy, 'meta.json')])));
});

test('status 按协作方显示位次、标题、会话和等待时长，--group 只列本组', async (t) => {
  const h = sandbox(t); full(h);
  const handles = [];
  for (const group of ['alpha', 'beta']) {
    handles.push(h.startBridge(args(h, `queued-${group}`, ['--group', group, '--scope', group]), { env: { CLAUDE_CODE_SESSION_ID: `session-${group}` } }));
    await poll(() => tickets(h).length === handles.length, '按顺序领票');
  }
  const all = await h.bridge(['status']); assert.equal(all.code, 0, all.stderr);
  for (const word of [M.queueHeading, 'codex', '第 1 位', '第 2 位', 'queued-alpha', 'queued-beta', 'session-alpha', 'session-beta', '已排']) assert.ok(all.stdout.includes(word), word);
  const grouped = await h.bridge(['status', '--group', 'beta']); assert.equal(grouped.code, 0, grouped.stderr);
  assert.ok(grouped.stdout.includes('queued-beta')); assert.ok(grouped.stdout.includes('第 2 位')); assert.equal(grouped.stdout.includes('queued-alpha'), false);
  handles[0].stop(); await handles[0].done;
  await poll(() => handles[1].stderr.includes(M.queuePosition('codex', 1, 1, 60)), '前一位退出后提示新位次');
  for (const handle of handles) handle.stop(); await Promise.all(handles.map((handle) => handle.done));
});

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) test(`${signal} 处理器退出时清掉自己的票据`, async (t) => {
  const h = sandbox(t); full(h);
  const gate = path.join(h.home, 'signal');
  const script = h.write('signal.mjs', `import fs from 'node:fs';
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.emit(${JSON.stringify(signal)}); } }, 25);
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const handle = h.start(script, args(h, signal));
  await poll(() => tickets(h).length === 1, '信号到来前已经排队'); write(gate, 'go');
  const r = await handle.done; assert.equal(r.code, code, r.stderr);
  assert.equal(tickets(h).length, 0); assert.equal(h.calls().length, 0);
});

const ticketFile = (h, n) => path.join(h.runs, '.state', 'queue', 'codex', `${n}.json`);
function seedTicket(h, n, values = {}) {
  const now = Date.now();
  return write(ticketFile(h, n), { sequence: n, agent: 'codex', pid: process.pid,
    pid_started_at: new Date(performance.timeOrigin).toISOString(), claude_session: 'ticket-session',
    group: null, plan: null, seat: null, title: `ticket-${n}`, queued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 3600000).toISOString(), ...values });
}

test('低于水位的目录后来出现，补入名额、范围、计划和续接索引；旧缓存重建 seen', async (t) => {
  const h = sandbox(t), cfg = baseConfig(); cfg.agents.codex.max_parallel = 1; h.config(cfg);
  seedRun(h, '29990101-000000-zzzz');
  output(await h.bridge(args(h, 'warm-seen')));
  const file = path.join(h.runs, '.state', 'active.json'), before = json(file);
  const late = '20000101-000000-0002'; assert.ok(late < before.high_water);
  seedRun(h, late, { status: 'running', pid: process.pid, group: 'restored', scope: ['src'],
    plan: 'restored-plan', seat: 2, parent: 'restored-parent' });
  failed(await h.bridge(args(h, 'late', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, late));
  const state = json(file);
  assert.ok(state.seen.includes(late)); assert.ok(state.active.includes(late));
  assert.deepEqual(state.plans['restored-plan:2'], [late]); assert.deepEqual(state.children['restored-parent'], [late]);
  failed(await h.bridge(args(h, 'scope', ['--group', 'restored', '--scope', 'src/a'])), M.scopeOverlap('restored', late, ['src/a']));
  write(file, { ...state, version: 1, seen: undefined, active: [] });
  failed(await h.bridge(args(h, 'old-state', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, late));
  assert.equal(json(file).version, 2); assert.ok(json(file).seen.includes(late));
});

test('已经看到的空目录稍后写入 meta，仍重新读取并占用名额', async (t) => {
  const h = sandbox(t), dir = full(h), late = '19990101-000000-aaaa';
  fs.mkdirSync(path.join(h.runs, late), { recursive: true });
  failed(await h.bridge(args(h, 'empty-first', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, activeId));
  assert.equal(json(path.join(h.runs, '.state', 'active.json')).seen.includes(late), false);
  finish(dir); seedRun(h, late, { status: 'running', pid: process.pid });
  failed(await h.bridge(args(h, 'meta-later', ['--queue-timeout', '0'])), M.agentFull('codex', 1, 1, late));
});

test('EPERM 且启动时间不可查时，不放出名额；status 和 cancel 保留运行状态', async (t) => {
  const h = sandbox(t), pid = 2147483646; full(h, 1, { pid });
  const preload = h.write('eperm.mjs', `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const kill = process.kill, spawn = cp.spawnSync;
process.kill = (pid, signal) => { if (pid === ${pid} && signal === 0) throw Object.assign(new Error('denied'), { code: 'EPERM' }); return kill(pid, signal); };
cp.spawnSync = (cmd, ...args) => /(?:powershell(?:\\.exe)?|ps)$/i.test(String(cmd)) ? { status: 1, stdout: '', stderr: '' } : spawn(cmd, ...args);
syncBuiltinESMExports();`);
  const env = { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`, FOREMAN_TEST_CANCEL_WAIT_MS: '1' };
  for (let i = 0; i < 2; i++) failed(await h.bridge(args(h, 'protected', ['--queue-timeout', '0']), { env }), M.agentFull('codex', 1, 1, activeId));
  assert.deepEqual(json(path.join(h.runs, '.state', 'active.json')).active, [activeId]);
  assert.equal(output(await h.bridge(['status', '--run', activeId], { env })).status, 'running');
  const cancelled = output(await h.bridge(['cancel', '--run', activeId], { env }));
  assert.equal(cancelled.ok, false); assert.equal(cancelled.status, 'running'); assert.equal(cancelled.error, M.cancelUnverified(pid));
  assert.equal(json(path.join(h.runs, activeId, 'meta.json')).status, 'running'); assert.equal(h.calls().length, 0);
});

test('过期和死票据不展示；宽限后回收过期票据，只有挡路的队首才核验 pid 复用', async (t) => {
  const h = sandbox(t), dir = full(h), now = Date.now();
  const old = seedTicket(h, 1, { title: 'expired-old', expires_at: new Date(now - 61000).toISOString() });
  const grace = seedTicket(h, 2, { title: 'expired-grace', expires_at: new Date(now - 10000).toISOString() });
  const dead = seedTicket(h, 3, { title: 'dead-owner', pid: 2147483647 });
  const head = seedTicket(h, 4, { title: 'live-head' });
  const reused = seedTicket(h, 5, { title: 'reused-owner', pid_started_at: '2000-01-01T00:00:00.000Z' });
  const status = await h.bridge(['status']); assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes('live-head'));
  for (const title of ['expired-old', 'expired-grace', 'dead-owner', 'reused-owner']) assert.equal(status.stdout.includes(title), false, status.stdout);
  const handle = h.startBridge(args(h, 'after-head'));
  await poll(() => fs.existsSync(ticketFile(h, 6)), '新派发已排队');
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(dead), false); assert.equal(fs.existsSync(grace), true);
  assert.equal(fs.existsSync(reused), true);
  const own = json(ticketFile(h, 6));
  assert.equal(Date.parse(own.expires_at) - Date.parse(own.queued_at), 3600000);
  assert.ok(Number.isFinite(Date.parse(own.pid_started_at)));
  fs.rmSync(head);
  await poll(() => !fs.existsSync(reused) && handle.stderr.includes(M.queuePosition('codex', 1, 1, 60)), '复用 pid 的票据升为队首后回收');
  finish(dir); output(await handle.done); assert.equal(fs.existsSync(ticketFile(h, 6)), false);
});

for (const lang of ['zh', 'en']) test(`自己的票据消失后明确退出，空出的名额也不绕过队列（${lang}）`, async (t) => {
  const h = sandbox(t), dir = full(h), handle = h.startBridge(args(h, 'lost'), { env: { FOREMAN_LANG: lang } });
  await poll(() => fs.existsSync(ticketFile(h, 1)), '自己的票据');
  fs.rmSync(ticketFile(h, 1)); finish(dir);
  const r = await handle.done; failed(r, MESSAGES[lang].queueLost('codex'));
  assert.equal(h.calls().length, 0); assert.equal(h.records().length, 1); assert.equal(r.stderr.includes('第 0 位'), false);
});

for (const damage of ['json', 'shape', 'busy']) test(`损坏票据按年龄处理，序号 ${damage} 时按所有文件名最大序号重建`, async (t) => {
  const h = sandbox(t); full(h); seedTicket(h, 40, { title: 'valid-head' });
  const old = write(ticketFile(h, 49), '{old'), fresh = write(ticketFile(h, 50), damage === 'shape' ? null : '{fresh');
  const aged = new Date(Date.now() - 61000); fs.utimesSync(old, aged, aged);
  const sequence = path.join(path.dirname(fresh), '.sequence.json');
  write(sequence, damage === 'json' ? '{bad' : damage === 'shape' ? { bad: true } : 1);
  const preload = h.write('sequence-busy.mjs', `import fs from 'node:fs'; const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => { if (file === ${JSON.stringify(sequence)}) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return read(file, ...args); };`);
  const handle = h.startBridge(args(h, 'rebuilt-sequence'), damage === 'busy' ? { env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } } : {});
  await poll(() => fs.existsSync(ticketFile(h, 51)) && handle.stderr.includes(M.queuePosition('codex', 1, 2, 60)), '序号重建并正常排队');
  assert.equal(json(sequence), 51); assert.equal(json(ticketFile(h, 51)).sequence, 51);
  assert.equal(fs.existsSync(old), false); assert.equal(fs.existsSync(fresh), true);
  const status = await h.bridge(['status']); assert.equal(status.code, 0, status.stderr);
  assert.ok(status.stdout.includes('valid-head')); assert.ok(status.stdout.includes('rebuilt-sequence'));
  handle.stop(); await handle.done;
});

// 读文件出错（被占用、没权限）和内容损坏是两回事：读不出的票据照样占位次，放多久都不删，后来的人不能越过它
test('一时读不出的票据照样占位次，不删除、不被越过', async (t) => {
  const h = sandbox(t); full(h); seedTicket(h, 40, { title: 'valid-head' });
  const busy = seedTicket(h, 45, { title: 'busy-ticket' }), aged = new Date(Date.now() - 120000);
  fs.utimesSync(busy, aged, aged);
  const preload = h.write('ticket-busy.mjs', `import fs from 'node:fs'; const read = fs.readFileSync;
fs.readFileSync = (file, ...args) => { if (file === ${JSON.stringify(busy)}) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return read(file, ...args); };`);
  const handle = h.startBridge(args(h, 'behind-busy'), { env: { NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } });
  await poll(() => handle.stderr.includes(M.queuePosition('codex', 1, 3, 60)), '排在读不出的票据后面');
  assert.equal(fs.existsSync(busy), true);
  handle.stop(); await handle.done;
});

for (const lang of ['zh', 'en']) test(`位次变化显示剩余分钟数（${lang}）`, async (t) => {
  const h = sandbox(t), dir = full(h), head = seedTicket(h, 1);
  const clock = h.write('clock.json', '0');
  const preload = h.write('remaining.mjs', `import fs from 'node:fs'; const now = Date.now;
Date.now = () => now() + Number(fs.readFileSync(${JSON.stringify(clock)}, 'utf8'));`);
  const handle = h.startBridge(args(h, 'remaining', ['--queue-timeout', '10']), { env: {
    FOREMAN_LANG: lang, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` } });
  await poll(() => handle.stderr.includes(MESSAGES[lang].queuePosition('codex', 1, 2, 10)), '初始剩余时间');
  write(clock, '120000'); fs.rmSync(head);
  await poll(() => handle.stderr.includes(MESSAGES[lang].queuePosition('codex', 1, 1, 8)), '已等两分钟后更新剩余时间');
  finish(dir); output(await handle.done);
});
