import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sandbox, output, seedRun, baseConfig, ROOT } from './helpers.mjs';

const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;
async function sleeper(h) {
  const handle = h.start('-e', ['setInterval(() => {}, 1000)']);
  await once(handle.child, 'spawn');
  return handle.child.pid;
}

async function inspect(h, source) {
  return output(await h.start('--input-type=module', ['-e', `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
let queries = 0;
const queryLocks = [];
childProcess.spawnSync = (...args) => { queries++; queryLocks.push(fs.existsSync(${JSON.stringify(path.join(h.runs, '.start.lock'))})); return spawn(...args); };
syncBuiltinESMExports();
const { processStartTimes, processStartedAt } = await import(${JSON.stringify(url('util.mjs'))});
const { checkRunners, isRunning, initializeRecords, newRunDir, checkAdmission, runOutcome, readMeta } = await import(${JSON.stringify(url('records.mjs'))});
${source}
`]).done);
}

test('processStartTimes 一次查询多个真实进程，缺失进程为 null，单进程接口保持一致', async (t) => {
  const h = sandbox(t, { config: false }), pid = await sleeper(h);
  const r = await inspect(h, `
const before = Date.now(), began = performance.now();
const times = processStartTimes([${process.pid}, ${pid}, 2147483647, ${pid}]);
const ms = performance.now() - began;
assert.equal(queries, 1);
assert.equal(times.size, 3);
assert.equal(times.get(2147483647), null);
assert.ok(Number.isFinite(times.get(${process.pid})));
assert.ok(times.get(${pid}) <= before);
assert.equal(processStartedAt(${pid}), times.get(${pid}));
assert.equal(processStartedAt(0), null);
assert.equal(processStartTimes([]).size, 0);
assert.equal(queries, 2);
console.log(JSON.stringify({ ms }));`);
  assert.equal(fs.existsSync(path.join(h.home, '.claude/foreman')), false);
  t.diagnostic(`${process.platform} processStartTimes: ${r.ms.toFixed(1)} ms`);
});

test('isRunning 首次自行查询，重复判断复用缓存，无候选时不查询', async (t) => {
  const h = sandbox(t), pid = await sleeper(h), started = new Date().toISOString();
  const r = await inspect(h, `
const current = { status: 'running', pid: ${pid}, started_at: ${JSON.stringify(started)} };
const old = { ...current, started_at: new Date(Date.now() - 3600000).toISOString() };
checkRunners([null, { ...current, status: 'done' }, { ...current, pid: 2147483647 }]);
assert.equal(queries, 0);
assert.equal(isRunning(null), false);
assert.equal(isRunning(current), true);
assert.equal(queries, 1);
checkRunners([current, old]);
assert.equal(queries, 2);
for (let i = 0; i < 10; i++) {
  assert.equal(isRunning({ ...current }), true);
  assert.equal(isRunning({ ...old }), false);
}
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 2);
});

test('same 和 unknown 缓存 60 秒后重新查询，other 永久有效', async (t) => {
  const h = sandbox(t), pid = await sleeper(h), started = new Date().toISOString();
  const r = await inspect(h, `
const current = { status: 'running', pid: ${pid}, started_at: ${JSON.stringify(started)} };
const old = { ...current, started_at: new Date(Date.now() - 3600000).toISOString() };
const unknown = { ...current, started_at: 'invalid-date' };
checkRunners([current, old, unknown]);
assert.equal(queries, 1);
const now = Date.now, at = now();
try {
  Date.now = () => at + 59000;
  checkRunners([current, old, unknown]);
  assert.equal(queries, 1);
  Date.now = () => at + 61000;
  assert.equal(isRunning(old), false);
  assert.equal(queries, 1);
  checkRunners([current, unknown]);
  assert.equal(queries, 2);
  assert.equal(isRunning(current), true);
  assert.equal(isRunning(unknown), true);
} finally { Date.now = now; }
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 2);
});

test('观察到退出后清除缓存，isRunning 和 checkRunners 都会重新查询复用的进程号', async (t) => {
  const h = sandbox(t), pid = await sleeper(h);
  const r = await inspect(h, `
for (const [i, observe] of [isRunning, (m) => checkRunners([m])].entries()) {
  const meta = { status: 'running', pid: ${pid}, started_at: new Date(Date.now() + i).toISOString() };
  const before = queries, kill = process.kill;
  assert.equal(isRunning(meta), true);
  assert.equal(queries, before + 1);
  let alive = false;
  process.kill = (pid, ...args) => {
    if (pid === meta.pid && !alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    return kill(pid, ...args);
  };
  try {
    const observed = observe(meta);
    if (i === 0) assert.equal(observed, false);
    assert.equal(queries, before + 1);
    alive = true;
    assert.equal(isRunning(meta), true);
    assert.equal(queries, before + 2);
  } finally { process.kill = kill; }
}
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 4);
});

test('newRunDir 在锁外预查，准入不查询，旧记录不占名额，预查后登记的 runner 仍占名额', async (t) => {
  const h = sandbox(t), pid = await sleeper(h), cfg = baseConfig();
  cfg.agents.codex.max_parallel = 1;
  const dir = seedRun(h, '20000101-old-runner', { status: 'running', pid, started_at: new Date(Date.now() - 3600000).toISOString() });
  const candidate = { id: 'new-run', agent: 'codex', cwd: h.cwd };
  const r = await inspect(h, `
const cfg = ${JSON.stringify(cfg)};
initializeRecords(cfg);
const run = await newRunDir();
try {
  assert.equal(queries, 1);
  assert.deepEqual(queryLocks, [false]);
  assert.equal(fs.existsSync(${JSON.stringify(path.join(h.runs, '.start.lock'))}), true);
  const candidate = { ...${JSON.stringify(candidate)}, id: run.id };
  assert.equal(checkAdmission(candidate, cfg), null);
  const late = { ...readMeta(${JSON.stringify(dir)}), id: '20000101-late-runner', started_at: new Date().toISOString() };
  const lateDir = ${JSON.stringify(h.runs)} + '/' + late.id;
  fs.mkdirSync(lateDir);
  fs.writeFileSync(lateDir + '/meta.json', JSON.stringify(late));
  assert.equal(isRunning(late, { query: false }), true);
  assert.equal(typeof checkAdmission(candidate, cfg), 'string');
  assert.equal(queries, 1);
} finally { run.release(); }
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 1);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test('runOutcome 将复用进程号且无结果的旧记录记为 interrupted，并重读刚收尾的元数据', async (t) => {
  const h = sandbox(t), pid = await sleeper(h);
  const dir = seedRun(h, 'outcome-reused', { status: 'running', pid, started_at: new Date(Date.now() - 3600000).toISOString() });
  const r = await inspect(h, `
const dir = ${JSON.stringify(dir)}, meta = readMeta(dir), run = { dir, meta };
assert.equal(runOutcome(run).status, 'interrupted');
assert.equal(readMeta(dir).status, 'running');
fs.writeFileSync(dir + '/meta.json', JSON.stringify({ ...meta, status: 'done', session_id: 'finished-session' }));
fs.writeFileSync(dir + '/result.json', JSON.stringify({ status: 'done', report: { status: 'completed' } }));
assert.equal(runOutcome(run).ok, true);
assert.equal(run.meta.session_id, 'finished-session');
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 1);
});

test('确认复用后进程号消失再出现，查不到启动时间也不算回运行中', async (t) => {
  const h = sandbox(t), pid = await sleeper(h);
  const r = await inspect(h, `
const old = { status: 'running', pid: ${pid}, started_at: new Date(Date.now() - 3600000).toISOString() };
assert.equal(isRunning(old), false);
assert.equal(queries, 1);
const kill = process.kill;
let alive = false;
process.kill = (pid, ...args) => {
  if (pid === old.pid && !alive) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  return kill(pid, ...args);
};
try {
  assert.equal(isRunning(old), false);
  alive = true;
  assert.equal(isRunning(old), false);
  assert.equal(queries, 1);
} finally { process.kill = kill; }
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 1);
});

test('拿锁前就有、当时元数据读不出的旧记录，准入时在锁内补查', async (t) => {
  const h = sandbox(t), pid = await sleeper(h), cfg = baseConfig();
  cfg.agents.codex.max_parallel = 1;
  const dir = seedRun(h, '20000101-unreadable-old', { status: 'running', pid, started_at: new Date(Date.now() - 3600000).toISOString() });
  const r = await inspect(h, `
const cfg = ${JSON.stringify(cfg)};
initializeRecords(cfg);
const file = ${JSON.stringify(path.join(dir, 'meta.json'))}, read = fs.readFileSync;
let blocked = true;
fs.readFileSync = (target, ...args) => {
  if (blocked && String(target) === file) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return read(target, ...args);
};
const run = await newRunDir();
try {
  assert.equal(queries, 0);
  blocked = false;
  assert.equal(checkAdmission({ id: run.id, agent: 'codex', cwd: ${JSON.stringify(h.cwd)} }, cfg), null);
  assert.deepEqual(queryLocks, [true]);
} finally { run.release(); fs.readFileSync = read; }
console.log(JSON.stringify({ queries }));`);
  assert.equal(r.queries, 1);
});
