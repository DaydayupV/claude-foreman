import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, plannedSandbox, ROOT, taskArgs, output, read, json, write, poll, seedRun, baseConfig, MESSAGES } from './helpers.mjs';
import { report, discussion } from './fixtures/reports.mjs';

const trackerUrl = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/tracker.mjs')).href;
const M = MESSAGES.zh;
const snapshotScript = (h, body) => String.raw`
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { makeTracker } from ${JSON.stringify(trackerUrl)};
const gitDir = ${JSON.stringify(path.join(h.runs, 'snapshot', '.shadow'))};
fs.mkdirSync(${JSON.stringify(path.join(h.runs, 'snapshot'))}, { recursive: true });
const tracker = makeTracker(${JSON.stringify(path.join(h.runs, 'snapshot'))}, process.cwd(), []);
const spawn = cp.spawnSync;
const names = (snap) => spawn('git', ['--git-dir', gitDir, 'ls-tree', '-rz', '--name-only', snap.tree], { encoding: 'utf8', windowsHide: true }).stdout.split('\0').filter(Boolean);
try { ${body} } finally { tracker.cleanup(); }
`;

test('另一个进程反复截断重写文件时，快照剔除 unstable，其他文件照常分块入树', async (t) => {
  const h = sandbox(t), hot = h.write('中文/热写.txt', 'initial\n'), tick = path.join(h.home, 'writer-tick');
  for (let i = 0; i < 501; i++) h.write(`stable/${i}.txt`, 'stable\n');
  const writer = h.start('-e', [`
    const fs = require('node:fs');
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const fd = fs.openSync(${JSON.stringify(hot)}, 'r+');
    (async () => { for (let i = 1; ; i++) {
      try {
        fs.ftruncateSync(fd, 0);
        await pause(1);
        fs.writeSync(fd, Buffer.alloc(4 * 1024 * 1024, i % 255), 0, 4 * 1024 * 1024, 0);
        fs.futimesSync(fd, new Date(), new Date(1700000000000 + i * 1000));
        fs.appendFileSync(${JSON.stringify(tick)}, '.');
      } catch (e) {
        // Git 在 Windows 上映射文件时可能暂时禁止截断（Node 报 UNKNOWN），写进程要继续施压。
        if (!['UNKNOWN', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      }
      await pause(1);
    } })();
  `]);
  await poll(() => fs.existsSync(tick) && fs.statSync(tick).size >= 2, '并发写入开始');
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    const batches = [];
    cp.spawnSync = (file, args, options) => {
      const result = spawn(file, args, options);
      if (file === 'git' && args.includes('add')) {
        const paths = options.input.split('\0').filter(Boolean);
        batches.push(paths.length);
        if (paths.includes('中文/热写.txt')) {
          // 等真实写进程完成下一轮，保证测试确实跨过改写窗口，不靠调度碰运气。
          const next = fs.statSync(${JSON.stringify(tick)}).size + 2;
          const deadline = Date.now() + 5000;
          while (fs.statSync(${JSON.stringify(tick)}).size < next && Date.now() < deadline)
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
        }
      }
      return result;
    };
    syncBuiltinESMExports();
    const snap = tracker.snap('before');
    console.log(JSON.stringify({ snap, names: names(snap), batches }));
  `)]).done);
  writer.stop();
  await writer.done;
  assert.equal(writer.stderr, '');
  assert.deepEqual(r.snap.unstable, ['中文/热写.txt']);
  assert.equal(r.names.length, 501);
  assert.ok(r.names.every((name) => name.startsWith('stable/')));
  assert.equal(Math.max(...r.batches), 500);
});

test('add 期间半文件继续写完时重拍；半文件事先停住且两端 stat 一致时无法识别', async (t) => {
  const h = sandbox(t), file = h.write('半文件.txt', 'half\n');
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    let adds = 0;
    cp.spawnSync = (bin, args, options) => {
      const result = spawn(bin, args, options);
      if (bin === 'git' && args.includes('add') && ++adds === 1) fs.writeFileSync(${JSON.stringify(file)}, 'complete content\n');
      return result;
    };
    syncBuiltinESMExports();
    const before = tracker.snap('before');
    const completed = spawn('git', ['--git-dir', gitDir, 'show', before.tree + ':半文件.txt'], { encoding: 'utf8', windowsHide: true }).stdout;
    fs.writeFileSync(${JSON.stringify(file)}, 'half\n');
    // stat 只能看到 add 两端；已经停住的半成品与正常文件无法区分，这个边界允许入树。
    const stopped = tracker.snap('stopped');
    const partial = spawn('git', ['--git-dir', gitDir, 'show', stopped.tree + ':半文件.txt'], { encoding: 'utf8', windowsHide: true }).stdout;
    console.log(JSON.stringify({ before, stopped, completed, partial, adds }));
  `)]).done);
  assert.deepEqual(r.before.unstable, []);
  assert.deepEqual(r.stopped.unstable, []);
  assert.equal(r.completed, 'complete content\n');
  assert.equal(r.partial, 'half\n');
  assert.equal(r.adds, 3);
});

test('失败批次拆开后保留健康文件，问题路径重试共用约 20 秒预算', async (t) => {
  const h = sandbox(t);
  h.write('healthy.txt', 'stable\n'); h.write('unreadable.txt', 'busy\n');
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    const now = Date.now;
    let elapsed = 0;
    const timeouts = [];
    Date.now = () => now() + elapsed;
    cp.spawnSync = (file, args, options) => {
      if (file === 'git' && args.includes('add') && options.input.split('\0').includes('unreadable.txt')) {
        timeouts.push(options.timeout);
        elapsed += 11000;
        return { status: 128, stdout: '', stderr: 'error: short read while indexing unreadable.txt' };
      }
      return spawn(file, args, options);
    };
    syncBuiltinESMExports();
    const snap = tracker.snap('before');
    console.log(JSON.stringify({ snap, names: names(snap), timeouts }));
  `)]).done);
  assert.deepEqual(r.snap.unstable, ['unreadable.txt']);
  assert.deepEqual(r.names, ['healthy.txt']);
  assert.equal(r.timeouts.length, 3);
  assert.ok(r.timeouts.at(-1) > 0 && r.timeouts.at(-1) <= 9000);
});

test('跨组跨会话和运行期间已结束的任务也标 group_run，只从主补丁剔除无本任务证据的文件', async (t) => {
  const h = sandbox(t), gate = path.join(h.home, 'release');
  const peer = { group: 'foreign', claude_session: 'another-session', status: 'running', pid: process.pid, ended_at: undefined };
  seedRun(h, '20000101-live', { ...peer, scope: ['other'] });
  const ended = seedRun(h, '20000101-ended', { ...peer, group: null, scope: ['ended'] });
  seedRun(h, '20000101-elsewhere', { ...peer, cwd: path.join(h.home, 'different-project'), scope: ['elsewhere'] });
  const s = h.scenario({ last_message: { ...report, files_changed: [{ path: 'other/reported.txt', change: 'reported' }] },
    steps: [{ wait_for: gate }, { event: { type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'other/event.txt', kind: 'add' }] } } }],
    files: { 'other/foreign.txt': 'peer\n', 'ended/foreign.txt': 'ended\n', 'other/event.txt': 'event\n',
      'other/reported.txt': 'reported\n', 'mine/unknown.txt': 'unknown\n', 'elsewhere/foreign.txt': 'elsewhere\n' } });
  const running = h.startBridge(taskArgs(h, 'run', ['--group', 'mine', '--scope', 'mine']), { env: s.env });
  await poll(() => s.calls().length, '模型开始执行');
  write(path.join(ended, 'meta.json'), { ...json(path.join(ended, 'meta.json')), status: 'done', ended_at: new Date().toISOString() });
  write(gate, 'go');
  const r = output(await running.done), files = Object.fromEntries(r.changes.files.map((f) => [f.path, f]));
  assert.equal(files['other/foreign.txt'].group_run, '20000101-live');
  assert.equal(files['ended/foreign.txt'].group_run, '20000101-ended');
  assert.equal(files['other/foreign.txt'].by, 'unknown');
  assert.equal(files['other/event.txt'].by, 'agent');
  assert.equal(files['other/reported.txt'].by, 'reported');
  assert.equal(files['elsewhere/foreign.txt'].group_run, undefined);
  assert.equal(r.changes.group_total, 2);
  const own = read(path.join(r.run_dir, 'diff.patch')), all = read(path.join(r.run_dir, 'diff.all.patch'));
  for (const name of ['other/foreign.txt', 'ended/foreign.txt']) { assert.ok(!own.includes(name)); assert.ok(all.includes(name)); }
  for (const name of ['other/event.txt', 'other/reported.txt', 'mine/unknown.txt', 'elsewhere/foreign.txt']) assert.ok(own.includes(name));
  assert.equal(r.changes.patch_bytes, Buffer.byteLength(own));
  assert.equal(r.changes.all_patch_bytes, Buffer.byteLength(all));
  assert.match(r.changes.shortstat, /4 files changed/);
  assert.match(r.changes.all_shortstat, /6 files changed/);
  assert.equal(r.changes.files_total, 6);
});

test('记录目录放在项目内时，显式 track 项目也不会把任一任务记录拍进快照', async (t) => {
  const h = sandbox(t), c = baseConfig();
  h.runs = path.join(h.cwd, '运行记录[测]'); c.dispatch.runs_dir = h.runs; h.config(c);
  h.write('source.txt', 'before\n'); h.write('运行记录[测]/peer/log.txt', 'before record\n');
  const s = h.scenario({ files: { 'source.txt': 'after\n', '运行记录[测]/peer/log.txt': 'after record\n', '运行记录[测]/peer/new.txt': 'new record\n' } });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--track', '.']), { env: s.env }));
  assert.deepEqual(r.changes.files.map((f) => f.path), ['source.txt']);
  assert.deepEqual(r.changes.large_files_changed, []);
  for (const name of ['diff.patch', 'diff.all.patch']) {
    const patch = read(path.join(r.run_dir, name));
    assert.match(patch, /-before\n\+after/);
    assert.ok(!patch.includes('运行记录') && !patch.includes('log.txt') && !patch.includes('meta.json'));
  }
});

test('快照存原始字节：项目改了 .gitattributes 的换行设置，没改过的 CRLF 文件不算改动', async (t) => {
  const h = sandbox(t);
  h.write('.gitattributes', '* text=auto eol=lf\n');
  h.write('fixtures/crlf.csv', 'a,b\r\nc,d\r\n');
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    const before = tracker.snap('before');
    fs.appendFileSync('.gitattributes', '*.csv -text\n');
    const after = tracker.snap('after');
    const patchFile = ${JSON.stringify(path.join(h.home, 'attributes.patch'))};
    const diff = tracker.diff(before, after, patchFile);
    const stored = spawn('git', ['--git-dir', gitDir, 'rev-parse', before.tree + ':fixtures/crlf.csv'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const raw = spawn('git', ['hash-object', '--no-filters', 'fixtures/crlf.csv'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    console.log(JSON.stringify({ files: diff.files, stored, raw }));
  `)]).done);
  assert.deepEqual(r.files, [{ status: 'M', path: '.gitattributes' }]);
  assert.equal(r.stored, r.raw);
});

test('中文路径及 5 MB 前后阈值保留原有大小文件语义', async (t) => {
  const h = sandbox(t), size = 5 * 1024 * 1024;
  h.write('中文/阈下.bin', Buffer.alloc(size - 1));
  h.write('中文/等于.bin', Buffer.alloc(size));
  h.write('中文/阈上.bin', Buffer.alloc(size + 1));
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    const before = tracker.snap('before');
    fs.writeFileSync('中文/阈下.bin', Buffer.alloc(${size - 1}, 1));
    fs.writeFileSync('中文/等于.bin', Buffer.alloc(${size}, 1));
    fs.writeFileSync('中文/阈上.bin', Buffer.alloc(${size + 2}, 1));
    const after = tracker.snap('after');
    const diff = tracker.diff(before, after, ${JSON.stringify(path.join(h.home, 'threshold.patch'))});
    console.log(JSON.stringify({ before, after, diff, names: names(before) }));
  `)]).done);
  assert.deepEqual(r.before.unstable, []); assert.deepEqual(r.after.unstable, []);
  assert.deepEqual(new Set(r.names), new Set(['中文/阈下.bin', '中文/等于.bin']));
  assert.deepEqual(Object.keys(r.before.large), ['中文/阈上.bin']);
  assert.deepEqual(new Set(r.diff.files.map((f) => f.path)), new Set(['中文/阈下.bin', '中文/等于.bin']));
  assert.deepEqual(r.diff.large_files_changed, [{ status: 'M', path: '中文/阈上.bin' }]);
});

for (const kind of ['run', 'discuss']) test(`${kind} 基线不稳定时披露盲区，audited 拒绝开始`, async (t) => {
  const h = kind === 'run' ? sandbox(t) : plannedSandbox(t), hot = h.write('src/不稳定.txt', 'stable bytes but unreadable stat\n');
  const preload = write(path.join(h.home, 'unreadable-stat.mjs'), `import fs from 'node:fs';
const stat = fs.statSync;
fs.statSync = (file, ...args) => {
  if (file === ${JSON.stringify(hot)}) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  return stat(file, ...args);
};`);
  const s = h.scenario({ last_message: { ...(kind === 'run' ? report : discussion), files_changed: [{ path: 'src/', change: 'reported write' }] } });
  const r = output(await h.bridge(taskArgs(h, kind, ['--track', 'src']), { env: { ...s.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }), kind === 'run' ? 0 : 1);
  assert.equal(r.changes.available, kind === 'run');
  // incomplete 只表示 60 秒用完；拍不稳的文件只进 unstable_files，只读审计照样拒绝开始（下面 discuss 没有调用模型）
  assert.equal(r.changes.incomplete, undefined);
  assert.deepEqual(r.changes.unstable_files, (kind === 'run' ? ['before', 'after'] : ['before']).map((phase) => ({ path: 'src/不稳定.txt', phase })));
  assert.ok(r.notes.includes(M.unstableFiles(['src/不稳定.txt'], 'before')));
  if (kind === 'run') assert.ok(r.notes.includes(M.unstableFiles(['src/不稳定.txt'], 'after')));
  assert.equal(s.calls().length, kind === 'run' ? 1 : 0);
  if (kind === 'discuss') {
    assert.equal(r.readonly, 'audited'); assert.equal(r.status, 'failed');
    assert.equal(r.not_started, true);
    assert.deepEqual(r.readonly_violation, []);
  }
});

for (const phase of ['before', 'after']) test(`只在 ${phase} 不稳定的大小文件不产生 A/D，也不进入补丁或统计`, async (t) => {
  const h = sandbox(t), small = h.write('不可靠.txt', 'exists throughout\n'), large = h.write('不可靠大文件.bin', Buffer.alloc(5 * 1024 * 1024 + 1));
  h.write('healthy.txt', 'before\n');
  const preload = write(path.join(h.home, 'one-sided.mjs'), `import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let phase = '';
const stat = fs.statSync, spawn = cp.spawnSync;
cp.spawnSync = (file, args, options) => {
  const label = /index-(before|after)$/.exec(options?.env?.GIT_INDEX_FILE || '');
  if (label) phase = label[1];
  return spawn(file, args, options);
};
fs.statSync = (file, ...args) => {
  if (phase === ${JSON.stringify(phase)} && ${JSON.stringify([small, large])}.includes(file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  return stat(file, ...args);
};
syncBuiltinESMExports();`);
  const s = h.scenario({ files: { 'healthy.txt': 'after\n' } });
  const r = output(await h.bridge(taskArgs(h), { env: { ...s.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }));
  assert.deepEqual(r.changes.files, [{ status: 'M', path: 'healthy.txt', by: 'unknown' }]);
  assert.deepEqual(r.changes.large_files_changed, []);
  assert.deepEqual(new Set(r.changes.unstable_files.map((f) => `${f.phase}:${f.path}`)), new Set([`${phase}:不可靠.txt`, `${phase}:不可靠大文件.bin`]));
  assert.equal(r.changes.files_total, 1); assert.equal(r.changes.unknown_total, 1);
  assert.match(r.changes.shortstat, /1 file changed/); assert.equal(r.changes.shortstat, r.changes.all_shortstat);
  for (const name of ['diff.patch', 'diff.all.patch']) {
    const patch = read(path.join(r.run_dir, name));
    assert.ok(!patch.includes('不可靠')); assert.match(patch, /-before\n\+after/);
    assert.equal(Buffer.byteLength(patch), name === 'diff.patch' ? r.changes.patch_bytes : r.changes.all_patch_bytes);
  }
});

test('本任务 scope/track 也覆盖，或多个并发任务覆盖时保留 unknown 和主补丁，并列出路径', async (t) => {
  const h = sandbox(t), peer = { status: 'running', pid: process.pid, ended_at: undefined, claude_session: 'foreign' };
  seedRun(h, '20000101-first', { ...peer, group: 'foreign-a', scope: ['src', 'tracked', 'ambiguous', 'src-other'] });
  seedRun(h, '20000101-second', { ...peer, group: 'foreign-b', scope: ['ambiguous'] });
  const paths = ['ambiguous/shared.txt', 'src/mine.txt', 'tracked/mine.txt'];
  const s = h.scenario({ files: Object.fromEntries([...paths, 'src-other/peer.txt', 'loose.txt'].map((p) => [p, 'changed\n'])) });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--group', 'own', '--scope', 'src', '--track', 'tracked']), { env: s.env }));
  const own = read(path.join(r.run_dir, 'diff.patch')), all = read(path.join(r.run_dir, 'diff.all.patch'));
  for (const p of [...paths, 'loose.txt']) {
    const f = r.changes.files.find((f) => f.path === p);
    assert.equal(f.by, 'unknown'); assert.equal(f.group_run, undefined); assert.ok(own.includes(p));
  }
  assert.equal(r.changes.files.find((f) => f.path === 'src-other/peer.txt').group_run, '20000101-first');
  assert.ok(!own.includes('src-other/peer.txt')); assert.ok(all.includes('src-other/peer.txt'));
  assert.ok(r.notes.includes(M.ambiguousScopeChanges(paths)));
  assert.equal(r.changes.group_total, 1); assert.equal(r.changes.unknown_total, 5);
});

test('60 秒总截止时间约束首次 add；到期不再调用 git，保留已确认批次并逐路径披露剩余文件', async (t) => {
  const h = sandbox(t);
  for (let i = 0; i < 1002; i++) h.write(`files/${String(i).padStart(4, '0')}.txt`, 'stable\n');
  const r = output(await h.start('-e', [snapshotScript(h, String.raw`
    const now = Date.now();
    let elapsed = 0;
    const timeouts = [];
    let callsAfterDeadline = 0;
    Date.now = () => now + elapsed;
    cp.spawnSync = (file, args, options) => {
      if (file === 'git' && elapsed >= 60000) callsAfterDeadline++;
      if (file === 'git' && args.includes('add')) {
        timeouts.push(options.timeout);
        if (timeouts.length === 1) { const result = spawn(file, args, options); elapsed = 55000; return result; }
        elapsed += options.timeout + 1;
        return { status: 128, stdout: '', stderr: 'deadline expired' };
      }
      return spawn(file, args, options);
    };
    syncBuiltinESMExports();
    const snap = tracker.snap('before');
    console.log(JSON.stringify({ snap, names: names(snap), timeouts, callsAfterDeadline }));
  `)]).done);
  assert.equal(r.snap.timed_out, true); assert.equal(r.snap.incomplete, true);
  assert.equal(r.names.length, 500); assert.equal(r.snap.unstable.length, 502);
  assert.ok(r.names.every((p) => !r.snap.unstable.includes(p)));
  assert.equal(r.timeouts.length, 2); assert.ok(r.timeouts[1] > 0 && r.timeouts[1] <= 5000);
  assert.equal(r.callsAfterDeadline, 0);
});

for (const [kind, phase] of [['run', 'before'], ['discuss', 'before'], ['discuss', 'after']]) test(`${kind} ${phase} 快照到总时限时披露覆盖缺口，audited 拒绝不完整审计且正确记录 not_started`, async (t) => {
  const h = kind === 'run' ? sandbox(t) : plannedSandbox(t);
  h.write('src/file.txt', 'before\n');
  const preload = write(path.join(h.home, 'deadline.mjs'), `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const now = Date.now, spawn = cp.spawnSync;
let elapsed = 0;
Date.now = () => now() + elapsed;
cp.spawnSync = (file, args, options) => {
  const result = spawn(file, args, options);
  if (file === 'git' && args.includes('add') && options.env.GIT_INDEX_FILE.endsWith('index-${phase}')) elapsed += 60001;
  return result;
};
syncBuiltinESMExports();`);
  const s = h.scenario({ last_message: { ...(kind === 'run' ? report : discussion), files_changed: [{ path: 'src/', change: 'reported write' }] } });
  const r = output(await h.bridge(taskArgs(h, kind, ['--track', 'src']), { env: { ...s.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }), kind === 'run' ? 0 : 1);
  assert.equal(r.changes.incomplete, true);
  assert.deepEqual(r.changes.unstable_files, [{ path: 'src/file.txt', phase }]);
  assert.ok(r.notes.includes(M.snapshotDeadlineNote(phase)));
  const notStarted = kind === 'discuss' && phase === 'before';
  assert.equal(r.not_started, notStarted ? true : undefined);
  assert.equal(h.result(r.run_id).not_started, r.not_started);
  assert.equal(s.calls().length, notStarted ? 0 : 1);
  if (kind === 'discuss') {
    assert.equal(r.readonly, 'audited'); assert.equal(r.status, 'failed');
    assert.ok(r.errors.includes(notStarted ? M.auditedSnapshotFailed(M.snapshotIncomplete) : M.auditedSnapshotIncomplete));
    assert.deepEqual(r.readonly_violation, notStarted ? [] : [{ path: 'src', by: 'reported' }]);
  }
});

test('25 小时前的活动任务不漏掉，历史重叠按实际结束判断，并跳过缺 cwd 的旧记录', async (t) => {
  const h = sandbox(t), now = Date.now(), old = new Date(now - 26 * 3600000).toISOString();
  const live = '20000101-000000-1111', ended = '20000101-000000-2222', early = '20000101-000000-3333';
  seedRun(h, live, { started_at: old, status: 'running', pid: process.pid, ended_at: undefined, scope: ['peer'] });
  seedRun(h, ended, { started_at: old, ended_at: new Date(now - 100).toISOString() });
  seedRun(h, early, { started_at: old, ended_at: new Date(now - 120000).toISOString() });
  seedRun(h, 'legacy-no-cwd', { cwd: undefined });
  const state = { version: 2, high_water: early, active: [live, ended, early], seen: [live, ended, early], plans: {}, children: {} };
  const activeFile = write(path.join(h.runs, '.state', 'active.json'), state);
  const url = pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/records.mjs')).href;
  const r = output(await h.start('-e', [`import fs from 'node:fs';
import { initializeRecords, concurrentExecRuns } from ${JSON.stringify(url)};
initializeRecords({ dispatch: { runs_dir: ${JSON.stringify(h.runs)} } });
const meta = { id: 'current', cwd: process.cwd(), started_at: ${JSON.stringify(new Date(now - 60000).toISOString())} };
const start = concurrentExecRuns(meta);
fs.writeFileSync(${JSON.stringify(activeFile)}, JSON.stringify({ ...${JSON.stringify(state)}, active: [] }));
const file = ${JSON.stringify(path.join(h.runs, live, 'meta.json'))};
fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), status: 'done', ended_at: new Date().toISOString() }));
console.log(JSON.stringify({ start: start.map((r) => r.id).sort(), end: concurrentExecRuns(meta, start).map((r) => r.id).sort() }));`]).done);
  assert.deepEqual(r.start, [live, ended]); assert.deepEqual(r.end, [live, ended]);
});

test('开工时活动集合里的旧 id 任务，期间结束并移出活动集合后仍参与补丁归属', async (t) => {
  const h = sandbox(t), id = '20000101-000000-aaaa', gate = path.join(h.home, 'finish-peer');
  const peerDir = seedRun(h, id, { status: 'running', pid: process.pid, ended_at: undefined, scope: ['peer'], group: 'foreign' });
  const activeFile = write(path.join(h.runs, '.state', 'active.json'), { version: 2, high_water: id, active: [id], seen: [id], plans: {}, children: {} });
  const s = h.scenario({ steps: [{ wait_for: gate }], files: { 'peer/foreign.txt': 'peer\n' } });
  const running = h.startBridge(taskArgs(h, 'run', ['--scope', 'mine']), { env: s.env });
  await poll(() => s.calls().length, '协作方开始');
  write(path.join(peerDir, 'meta.json'), { ...json(path.join(peerDir, 'meta.json')), status: 'done', ended_at: new Date().toISOString() });
  const state = json(activeFile); write(activeFile, { ...state, active: state.active.filter((other) => other !== id) });
  write(gate, 'go');
  const r = output(await running.done);
  assert.equal(r.changes.files[0].group_run, id);
  assert.equal(read(path.join(r.run_dir, 'diff.patch')), '');
  assert.ok(read(path.join(r.run_dir, 'diff.all.patch')).includes('peer/foreign.txt'));
});

test('同一席的原轮和续接轮（或同席重启）算一个任务，文件记到最新一轮，不判成分不清', async (t) => {
  const h = sandbox(t), peer = { status: 'running', pid: process.pid, ended_at: undefined, claude_session: 'foreign', group: 'peer', agent: 'peer-agent' }; // 别的协作方，不占本任务协作方的名额
  seedRun(h, '20000101-1-root', { ...peer, scope: ['chain'] });
  seedRun(h, '20000101-2-resume', { ...peer, scope: ['chain'], parent: '20000101-1-root', mode: 'resume' });
  seedRun(h, '20000101-seat-a', { ...peer, scope: ['seat'], plan: 'peer-plan', seat: 2 });
  seedRun(h, '20000101-seat-b', { ...peer, scope: ['seat'], plan: 'peer-plan', seat: 2 });
  const s = h.scenario({ files: { 'chain/x.txt': 'x\n', 'seat/y.txt': 'y\n' } });
  const r = output(await h.bridge(taskArgs(h, 'run', ['--group', 'own', '--scope', 'mine']), { env: s.env }));
  const files = Object.fromEntries(r.changes.files.map((f) => [f.path, f]));
  assert.equal(files['chain/x.txt'].group_run, '20000101-2-resume');
  assert.equal(files['seat/y.txt'].group_run, '20000101-seat-b');
  const own = read(path.join(r.run_dir, 'diff.patch'));
  assert.ok(!own.includes('chain/x.txt') && !own.includes('seat/y.txt'), own);
  assert.ok(!r.notes.some((n) => n.includes('chain/x.txt')), r.notes.join('\n'));
  assert.equal(r.changes.group_total, 2);
});
