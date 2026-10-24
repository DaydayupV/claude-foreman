import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { sandbox, seedRun, taskArgs, output, failed, poll, baseConfig, json, read, ROOT, BRIDGE, CODEX, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;
const url = (file) => pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts', file)).href;

test('findRun 读到空文件或半份 JSON 时稍等再读，一直读不出才抛出原错误', async (t) => {
  const h = sandbox(t), id = 'transient-meta', dir = seedRun(h, id), file = path.join(dir, 'meta.json');
  const expected = json(file);
  const script = h.write('meta-read.mjs', `import fs from 'node:fs';
import { initializeRecords, findRun } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/records.mjs')).href)};
initializeRecords(${JSON.stringify(baseConfig())});
const metaFile = ${JSON.stringify(file)}, mode = process.argv[2];
const read = fs.readFileSync, rm = fs.rmSync, content = read(metaFile, 'utf8');
let reads = 0;
process.on('exit', () => process.stderr.write('reads=' + reads + '\\n'));
fs.readFileSync = (file, ...args) => {
  if (file !== metaFile) return read(file, ...args);
  reads++;
  if (['EPERM', 'EACCES', 'EBUSY'].includes(mode)) throw Object.assign(new Error(mode), { code: mode });
  if (mode === 'gone') {
    if (reads === 1) { rm(${JSON.stringify(dir)}, { recursive: true }); return ''; }
    return read(file, ...args);
  }
  if (mode === 'short' && reads === 1) return '';
  return mode === 'always' || reads === 2 ? content.slice(0, Math.floor(content.length / 2)) : content;
};
console.log(JSON.stringify({ ...findRun(${JSON.stringify(id)}), reads }));`);
  for (const mode of ['short', 'always', 'EPERM', 'EACCES', 'EBUSY', 'gone']) await t.test(mode, async () => {
    const result = await h.start(script, [mode]).done;
    if (mode === 'short') {
      const r = output(result);
      assert.deepEqual(r.meta, expected); assert.equal(r.id, id); assert.equal(r.dir, dir); assert.equal(r.reads, 3);
    } else if (mode === 'always') {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /SyntaxError/);
      assert.equal(result.stderr.includes(M.runNotFound(id)), false, result.stderr);
      assert.ok(Number(/reads=(\d+)/.exec(result.stderr)?.[1]) > 1, result.stderr);
    } else {
      failed(result, mode === 'gone' ? M.runNotFound(id) : M.metaUnreadable(file));
      assert.equal(result.stderr.includes('\n    at '), false, result.stderr);
    }
  });
});

test('meta.json 改名一直失败时退回直接覆盖写，不抛错也不留临时文件', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'rename-blocked'), meta = { id: 'rename-blocked', status: 'done' };
  const script = h.write('meta-save.mjs', `import fs from 'node:fs';
import path from 'node:path';
import { saveMeta } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/skills/dispatch/scripts/records.mjs')).href)};
const rename = fs.renameSync;
let renames = 0;
// 别的程序占着 meta.json、只许写不许删：改名一直报 EPERM
fs.renameSync = (from, to, ...args) => {
  if (path.basename(to) !== 'meta.json') return rename(from, to, ...args);
  renames++;
  throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
};
const saved = saveMeta(${JSON.stringify(dir)}, ${JSON.stringify(meta)});
console.log(JSON.stringify({ renames, saved }));`);
  const r = output(await h.start(script).done);
  assert.equal(r.saved, true);
  assert.equal(r.renames, 81);
  assert.deepEqual(json(path.join(dir, 'meta.json')), meta);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('改名和覆盖都被占用时返回 false 并清理临时文件，后续完整写入和结束重试可以补上', async (t) => {
  for (const mode of ['运行中', '结束放弃', '结束恢复']) await t.test(mode, async (t) => {
    const h = sandbox(t), dir = seedRun(h, 'busy-meta'), file = path.join(dir, 'meta.json'), original = json(file);
    const script = h.write('busy-meta.mjs', `import fs from 'node:fs';
import path from 'node:path';
import { saveMeta, metaWriteWarning } from ${JSON.stringify(url('records.mjs'))};
const dir = ${JSON.stringify(dir)}, file = path.join(dir, 'meta.json'), mode = process.argv[2];
const rename = fs.renameSync, write = fs.writeFileSync;
let blocked = true, rounds = 0;
fs.renameSync = (from, to, ...args) => {
  if (to === file && blocked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return rename(from, to, ...args);
};
fs.writeFileSync = (target, ...args) => {
  if (target === file && blocked) {
    if (mode === '结束恢复' && ++rounds > 3) blocked = false;
    else throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  }
  return write(target, ...args);
};
const first = saveMeta(dir, { status: 'running', session_id: 'pending' }, { final: mode !== '运行中' });
const temps = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
const before = JSON.parse(fs.readFileSync(file, 'utf8')), warning = first ? null : metaWriteWarning(dir);
blocked = false;
const next = saveMeta(dir, { status: 'done', session_id: 'latest', complete: true });
console.log(JSON.stringify({ first, next, temps, before, warning, rounds }));`);
    const r = output(await h.start(script, [mode], { env: { FOREMAN_TEST_META_WAIT_MS: mode === '结束恢复' ? '12000' : '300' } }).done);
    assert.equal(r.first, mode === '结束恢复'); assert.equal(r.next, true); assert.deepEqual(r.temps, []);
    assert.deepEqual(r.before, mode === '结束恢复' ? { status: 'running', session_id: 'pending' } : original);
    assert.deepEqual(json(file), { status: 'done', session_id: 'latest', complete: true });
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    if (mode === '结束放弃') {
      const sec = Number(/^([\d.]+) /.exec(r.warning)?.[1]);
      assert.ok(sec >= 0.3); assert.equal(r.warning, M.metaWriteGaveUp(file, sec, 'EBUSY'));
      assert.equal(read(path.join(dir, 'stderr.log')), r.warning + '\n');
    } else assert.equal(fs.existsSync(path.join(dir, 'stderr.log')), false);
    if (mode === '结束恢复') assert.equal(r.rounds, 4);
  });
});

test('结果被占用或只写了一半时暂不采用，进程退出后完整结果的状态优先于旧元数据', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'old-meta', { status: 'running', pid: 2147483647, session_id: null, ended_at: undefined },
    { status: 'done', session_id: 'recovered-session', duration_s: 12 });
  const script = h.write('outcome.mjs', `import fs from 'node:fs';
import { runOutcome } from ${JSON.stringify(url('records.mjs'))};
const dir = ${JSON.stringify(dir)}, meta = ${JSON.stringify(json(path.join(dir, 'meta.json')))}, read = fs.readFileSync;
let mode, resultReads = 0;
fs.readFileSync = (file, ...args) => {
  if (file.endsWith('result.json')) {
    if (mode === '恢复可读' && !resultReads++) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    if (mode === '占用') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    if (mode === '半份') return '{"status":';
  }
  return read(file, ...args);
};
console.log(JSON.stringify(['占用', '半份', '完整', '恢复可读'].map((value) => { mode = value; const run = { dir, meta }; return { ...runOutcome(run), meta: run.meta }; })));`);
  const outcomes = output(await h.start(script).done);
  for (const o of outcomes.slice(0, 2)) { assert.equal(o.result, null); assert.equal(o.status, 'interrupted'); }
  assert.equal(outcomes[2].status, 'done'); assert.equal(outcomes[2].ok, false); assert.equal(outcomes[2].valid, false); assert.equal(outcomes[2].result.status, 'done');
  assert.equal(outcomes[2].meta.session_id, 'recovered-session');
  assert.equal(outcomes[2].meta.ended_at, new Date(Date.parse(outcomes[2].meta.started_at) + 12000).toISOString());
  assert.equal(outcomes[3].status, 'done'); assert.equal(outcomes[3].result.status, 'done');
  assert.equal(json(path.join(dir, 'meta.json')).status, 'running'); assert.equal(json(path.join(dir, 'meta.json')).session_id, null);
});

test('会话 ID 写入被占用不影响 runner 完成，异常或直接退出也清理影子目录和监听', async (t) => {
  for (const mode of ['占用', '收尾异常', '构造异常', '直接退出']) await t.test(mode, async (t) => {
    const h = sandbox(t), marker = path.join(h.home, 'blocked'), lifecycle = path.join(h.home, 'tracker-exit');
    const preload = h.write('meta-preload.mjs', `import fs from 'node:fs';
import path from 'node:path';
const write = fs.writeFileSync, rename = fs.renameSync, read = fs.readFileSync, once = process.once, remove = process.removeListener;
let blocked, runDir, trackerExit;
process.once = function (event, listener) {
  if (event === 'exit' && runDir && fs.existsSync(path.join(runDir, '.shadow'))) { trackerExit = listener; fs.appendFileSync(${JSON.stringify(lifecycle)}, '登记\\n'); }
  return once.call(this, event, listener);
};
process.removeListener = function (event, listener) {
  if (event === 'exit' && listener === trackerExit) fs.appendFileSync(${JSON.stringify(lifecycle)}, '移除\\n');
  return remove.call(this, event, listener);
};
fs.writeFileSync = (file, data, ...args) => {
  if (typeof file === 'string' && /meta\\.json\\.\\d+\\.tmp$/.test(file)) {
    runDir = path.dirname(file);
    const m = JSON.parse(data); if (${JSON.stringify(mode)} === '占用' && m.status === 'running' && m.session_id) blocked = path.join(runDir, 'meta.json');
  }
  if (${JSON.stringify(mode)} === '构造异常' && typeof file === 'string' && file.endsWith(path.join('.shadow', 'info', 'exclude'))) throw new Error('合成构造异常');
  if (file === blocked) { write(${JSON.stringify(marker)}, 'EBUSY'); blocked = null; throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
  return write(file, data, ...args);
};
fs.renameSync = (from, to, ...args) => {
  if (to === blocked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return rename(from, to, ...args);
};
fs.readFileSync = (file, ...args) => {
  if (${JSON.stringify(mode)} === '直接退出' && typeof file === 'string' && path.basename(file) === 'last-message.txt') process.exit(130);
  if (${JSON.stringify(mode)} === '收尾异常' && typeof file === 'string' && path.basename(file) === 'last-message.txt') throw new Error('合成收尾异常');
  return read(file, ...args);
};`);
    const result = await h.bridge(taskArgs(h), { env: { NODE_OPTIONS: '--import ' + pathToFileURL(preload).href } });
    const meta = h.records()[0], dir = path.join(h.runs, meta.id);
    if (mode === '占用' || mode === '构造异常') {
      const r = output(result); assert.equal(r.status, 'done'); assert.equal(h.result(r.run_id).status, 'done');
      assert.equal(meta.status, 'done'); assert.equal(meta.session_id, 'synthetic-session');
      if (mode === '占用') assert.equal(read(marker), 'EBUSY');
      else { assert.equal(r.changes.available, false); assert.ok(r.warnings.some((w) => w.includes('合成构造异常'))); }
    } else if (mode === '直接退出') assert.equal(result.code, 130);
    else { assert.equal(result.code, 1); assert.match(result.stderr, /合成收尾异常/); }
    if (mode === '构造异常') assert.equal(fs.existsSync(lifecycle), false);
    else assert.equal(read(lifecycle), mode === '直接退出' ? '登记\n' : '登记\n移除\n');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(fs.existsSync(path.join(dir, '.shadow')), false);
  });
});

test('会话写入和收尾写入都放弃后，续接从结果取会话，cancel 不误标记为已处理', async (t) => {
  const h = sandbox(t), s = h.scenario({ session_id: 'result-session' });
  const preload = h.write('stale-meta.mjs', `import fs from 'node:fs';
import path from 'node:path';
const write = fs.writeFileSync, rename = fs.renameSync;
fs.writeFileSync = (file, ...args) => {
  if (typeof file === 'string' && path.basename(file) === 'meta.json' && fs.existsSync(file)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return write(file, ...args);
};
fs.renameSync = (from, to, ...args) => {
  if (path.basename(to) === 'meta.json' && fs.existsSync(to)) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return rename(from, to, ...args);
};`);
  const first = output(await h.bridge(taskArgs(h, 'run', ['--no-snapshot']), { env: { ...s.env, NODE_OPTIONS: '--import ' + pathToFileURL(preload).href, FOREMAN_TEST_META_WAIT_MS: '300' } }));
  const file = path.join(first.run_dir, 'meta.json'), before = read(file);
  assert.equal(json(file).status, 'running'); assert.equal(json(file).session_id, null); assert.equal(h.result(first.run_id).session_id, 'result-session');
  const warning = read(path.join(first.run_dir, 'stderr.log')).trimEnd();
  assert.equal(first.warnings.at(-1), warning); assert.ok(warning.includes('放弃这次写入'));
  assert.equal(h.result(first.run_id).warnings.includes(warning), false);
  assert.deepEqual(output(await h.bridge(['cancel', '--run', first.run_id])), { run_id: first.run_id, ok: false, status: 'done', note: M.cancelAlreadyEnded });
  assert.notEqual(read(file), before); assert.equal(json(file).status, 'done'); assert.equal(json(file).session_id, 'result-session'); assert.equal(json(file).dismissed_at, undefined);
  const resumed = output(await h.bridge(['resume', '--run', first.run_id, '--brief', '-', '--level', 'complex', '--reason', 'rework', '--no-snapshot'], { env: s.env }));
  assert.equal(resumed.session_id, 'result-session'); assert.deepEqual(s.calls().at(-1).args.slice(-2), ['result-session', '-']);
  assert.deepEqual(s.calls().at(-1).args.slice(0, 2), ['exec', 'resume']);
});

test('讨论父链中元数据仍为运行中但结果已完成的轮次计入上限', async (t) => {
  const h = sandbox(t), cfg = baseConfig(); cfg.dispatch.discuss_max_rounds = 2; h.config(cfg);
  const meta = { kind: 'discuss', mode: 'discuss', status: 'running', pid: 2147483647, session_id: null, ended_at: undefined };
  const result = { status: 'done', session_id: 'discussion-session', duration_s: 1 };
  seedRun(h, 'round-root', meta, result); seedRun(h, 'round-next', { ...meta, parent: 'round-root' }, result);
  failed(await h.bridge(['resume', '--run', 'round-next', '--brief', '-', '--level', 'complex']), M.discussRoundsExceeded('round-root', 2, 2));
  assert.equal(h.calls().length, 0);
});

test('登记写入放弃就删除运行目录并释放锁，不启动协作方', async (t) => {
  const h = sandbox(t), marker = path.join(h.home, 'registration-meta');
  const preload = h.write('registration-blocked.mjs', `import fs from 'node:fs';
import path from 'node:path';
const write = fs.writeFileSync, rename = fs.renameSync;
fs.writeFileSync = (file, ...args) => {
  if (typeof file === 'string' && path.basename(file) === 'meta.json') throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return write(file, ...args);
};
fs.renameSync = (from, to, ...args) => {
  if (path.basename(to) === 'meta.json') { write(${JSON.stringify(marker)}, to); throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); }
  return rename(from, to, ...args);
};`);
  const r = await h.bridge(taskArgs(h), { env: { NODE_OPTIONS: '--import ' + pathToFileURL(preload).href, FOREMAN_TEST_META_WAIT_MS: '300' } });
  const file = read(marker), sec = Number(/foreman: ([\d.]+) 秒内/.exec(r.stderr)?.[1]);
  failed(r, M.metaWriteGaveUp(file, sec, 'EBUSY'));
  assert.equal(fs.existsSync(path.dirname(file)), false); assert.equal(fs.existsSync(path.join(h.runs, '.start.lock')), false);
  assert.equal(h.calls().length, 0);
});

test('cancel 等待期间进程退出而元数据未更新时采用结果状态', async (t) => {
  const h = sandbox(t), sleeper = h.start(h.write('wait-cancel.mjs', 'setInterval(() => {}, 1000);'));
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  const dir = seedRun(h, 'completed-while-waiting', { status: 'running', pid: sleeper.child.pid, started_at: new Date().toISOString() });
  const handle = h.startBridge(['cancel', '--run', 'completed-while-waiting']);
  await poll(() => fs.existsSync(path.join(dir, 'cancel')), 'cancel 开始等待');
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'done', session_id: 'finished' }));
  sleeper.stop(); await sleeper.done;
  assert.deepEqual(output(await handle.done), { run_id: 'completed-while-waiting', ok: true, status: 'done' });
  assert.equal(json(path.join(dir, 'meta.json')).dismissed_at, undefined);
});

test('cancel 第一次读不出结果、再读才读到时，以再读的为准，不把完成的任务标记为已处理', async (t) => {
  const h = sandbox(t), dir = seedRun(h, 'result-late', { status: 'running', pid: 2147483647 }, { status: 'done' });
  const resultFile = path.join(dir, 'result.json');
  // findRun 兜底时 result.json 正被占着，cancel 再读一次元数据时已经读得出
  const preload = h.write('result-late.mjs', `import fs from 'node:fs';
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(resultFile)} && !reads++) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return read(file, ...args);
};`);
  const out = output(await h.bridge(['cancel', '--run', 'result-late'], { env: { NODE_OPTIONS: '--import ' + pathToFileURL(preload).href } }));
  assert.deepEqual(out, { run_id: 'result-late', ok: false, status: 'done', note: M.cancelAlreadyEnded });
  assert.equal(json(path.join(dir, 'meta.json')).dismissed_at, undefined);
});

test('强行结束前一刻调度进程自己收完了尾、结果正被占着时，cancel 照原样返回，不改成已取消', async (t) => {
  const h = sandbox(t), sleeper = h.start(h.write('finishing.mjs', 'setInterval(() => {}, 1000);'));
  await new Promise((resolve) => sleeper.child.once('spawn', resolve));
  const written = { status: 'done', session_id: 'finished' };
  const dir = seedRun(h, 'finished-at-kill', { status: 'done', pid: sleeper.child.pid, started_at: new Date().toISOString() }, written);
  const metaFile = path.join(dir, 'meta.json'), resultFile = path.join(dir, 'result.json');
  // 调度进程活着时 meta.json 读出来还是运行中（它在被结束的那一刻才写完终态）；result.json 一直被占着
  const preload = h.write('finished-at-kill.mjs', `import fs from 'node:fs';
const read = fs.readFileSync, pid = ${sleeper.child.pid};
const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(resultFile)}) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  const text = read(file, ...args);
  return file === ${JSON.stringify(metaFile)} && alive() ? String(text).replace('"status": "done"', '"status": "running"') : text;
};`);
  const out = output(await h.bridge(['cancel', '--run', 'finished-at-kill'], { env: { NODE_OPTIONS: '--import ' + pathToFileURL(preload).href, FOREMAN_TEST_CANCEL_WAIT_MS: '300' } }));
  assert.deepEqual(out, { run_id: 'finished-at-kill', ok: true, status: 'done' });
  assert.deepEqual(h.result('finished-at-kill'), written);
  assert.equal(json(metaFile).status, 'done');
});

test('Windows 真实只读共享占用 meta.json 时任务继续运行，释放后完整收尾', async (t) => {
  if (process.platform !== 'win32') { t.skip('仅 Windows 支持文件共享占用'); return; }
  const h = sandbox(t), gate = path.join(h.home, 'release-session');
  // 假 codex 先发会话 ID 再执行 steps，包装入口先执行同一剧本的等待，保证占用已建立。
  const bin = h.write('gated-codex.mjs', `import fs from 'node:fs';
import { replay } from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'tests/fake/common.mjs')).href)};
if (process.argv[2] === 'exec') await replay(JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8')).steps);
await import(${JSON.stringify(pathToFileURL(CODEX).href)});`);
  const cfg = baseConfig(); cfg.agents.codex.bin = bin; h.config(cfg);
  const s = h.scenario({ session_id: 'locked-session', steps: [{ wait_for: gate }] });
  const handle = h.startBridge(taskArgs(h), { env: s.env });
  const meta = await h.running(), dir = path.join(h.runs, meta.id), file = path.join(dir, 'meta.json');
  const started = Date.now(), command = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $held = [IO.File]::Open('${file.replaceAll("'", "''")}','Open','Read','Read'); try { [Console]::WriteLine('已占住'); Start-Sleep -Milliseconds 4000 } finally { $held.Dispose() }`;
  const holder = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { env: h.env, windowsHide: true });
  let stdout = '', stderr = '';
  holder.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
  holder.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const closed = new Promise((resolve, reject) => { holder.once('error', reject); holder.once('close', resolve); });
  try {
    await poll(() => stdout.includes('已占住'), 'PowerShell 已占住 meta.json');
    assert.equal(json(file).session_id, null); fs.writeFileSync(gate, '');
    const r = output(await handle.done); assert.equal(r.status, 'done'); assert.equal(h.result(r.run_id).status, 'done');
    assert.equal(await closed, 0, stderr); assert.equal(json(file).status, 'done'); assert.equal(json(file).session_id, 'locked-session');
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(fs.existsSync(path.join(dir, '.shadow')), false);
    t.diagnostic(`真实占用及收尾耗时 ${Date.now() - started} ms（占用 4000 ms）`);
  } finally { if (holder.exitCode === null && holder.signalCode === null) holder.kill(); await closed; }
});

test('cancel 等待时 meta.json 读不出不算已停下，进程自行退出后只标记中断，不补写结果', async (t) => {
  const h = sandbox(t), id = 'unreadable-meta';
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  await new Promise((resolve) => sleeper.once('spawn', resolve));
  const dir = seedRun(h, id, { status: 'running', pid: sleeper.pid, started_at: new Date().toISOString(), ended_at: undefined });
  const started = Date.now();
  const handle = h.startBridge(['cancel', '--run', id], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '15000' } });
  await poll(() => fs.existsSync(path.join(dir, 'cancel')), '终止标记');
  // 记录读不出时调度进程还活着：cancel 不能当成已经停下
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"id":');
  await pause(1200);
  assert.equal(handle.child.exitCode, null);
  process.kill(sleeper.pid);
  const out = output(await handle.done);
  assert.deepEqual(out, { run_id: id, ok: true, status: 'interrupted', dismissed: true, note: M.cancelRunnerGone });
  assert.ok(Date.now() - started < 10000, '调度进程退出后不应等满 15 秒');
  const m = json(path.join(dir, 'meta.json'));
  assert.equal(m.status, 'interrupted'); assert.ok(Number.isFinite(Date.parse(m.dismissed_at)));
  assert.equal(fs.existsSync(path.join(dir, 'result.json')), false);
});

test('cancel 的结束写入被占用时，标记已处理返回错误，强行结束仍返回成功并带警告', async (t) => {
  for (const forced of [false, true]) await t.test(forced ? '强行结束' : '标记已处理', async (t) => {
    const h = sandbox(t), sleeper = forced ? h.start(h.write('sleeper.mjs', 'setInterval(() => {}, 1000);')) : null;
    if (sleeper) await new Promise((resolve) => sleeper.child.once('spawn', resolve));
    const id = 'blocked-cancel', dir = seedRun(h, id, { status: forced ? 'running' : 'interrupted', pid: sleeper?.child.pid ?? 0, started_at: new Date().toISOString() });
    const script = h.write('cancel-blocked.mjs', `import fs from 'node:fs';
const file = ${JSON.stringify(path.join(dir, 'meta.json'))}, write = fs.writeFileSync, rename = fs.renameSync;
fs.writeFileSync = (target, ...args) => {
  if (target === file) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return write(target, ...args);
};
fs.renameSync = (from, to, ...args) => {
  if (to === file) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
  return rename(from, to, ...args);
};
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    const r = output(await h.start(script, ['cancel', '--run', id], { env: { FOREMAN_TEST_META_WAIT_MS: '300', FOREMAN_TEST_CANCEL_WAIT_MS: '50' } }).done);
    const warning = read(path.join(dir, 'stderr.log')).trimEnd();
    assert.deepEqual(r, forced ? { run_id: id, ok: true, status: 'cancelled', forced: true, warning }
      : { run_id: id, ok: false, status: 'interrupted', error: warning });
    assert.equal(json(path.join(dir, 'meta.json')).status, forced ? 'running' : 'interrupted');
    if (forced) { assert.equal(h.result(id).status, 'cancelled'); assert.notEqual((await sleeper.done).code, 0); }
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
  });
});

test('meta.json 一律先写临时文件再改名，并发读不会读到半份（执行、cancel 标记已处理、强行结束）', async (t) => {
  for (const scene of ['run', 'dismissed', 'forced']) await t.test(scene, async (t) => {
    const h = sandbox(t), log = path.join(h.home, 'direct-meta-writes.log'), sampled = path.join(h.home, 'reader-sampled');
    const script = h.write('slow-meta-writes.mjs', `import fs from 'node:fs';
import path from 'node:path';
// 退出前等测试进程至少读到过一次完整的 meta.json，免得它没轮到调度就错过整个运行过程。
process.on('exit', () => {
  for (let i = 0; i < 1000 && !fs.existsSync(${JSON.stringify(sampled)}); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
});
const write = fs.writeFileSync;
fs.writeFileSync = (file, data, ...args) => {
  const name = typeof file === 'string' ? path.basename(file) : '';
  if (name === 'meta.json' || name.startsWith('meta.json.')) {
    if (name === 'meta.json') fs.appendFileSync(${JSON.stringify(log)}, file + '\\n');
    write(file, data.slice(0, Math.floor(data.length / 2)), ...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return write(file, data, ...args);
};
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    let args = taskArgs(h, 'run', ['--no-snapshot']);
    if (scene !== 'run') {
      const sleeper = scene === 'forced' ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }) : null;
      if (sleeper) t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
      if (sleeper) await new Promise((resolve) => sleeper.once('spawn', resolve));
      seedRun(h, scene, { status: sleeper ? 'running' : 'interrupted', pid: sleeper?.pid ?? 0, started_at: new Date().toISOString(), ended_at: undefined });
      args = ['cancel', '--run', scene];
    }
    const handle = h.start(script, args, { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '300' } });
    let finished = false, complete = 0, syntaxErrors = 0;
    handle.done.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      const entries = fs.existsSync(h.runs) ? fs.readdirSync(h.runs, { withFileTypes: true }) : [];
      for (const entry of entries.filter((e) => e.isDirectory())) {
        try { JSON.parse(fs.readFileSync(path.join(h.runs, entry.name, 'meta.json'), 'utf8')); if (!complete++) fs.writeFileSync(sampled, ''); }
        catch (e) {
          if (e instanceof SyntaxError) syntaxErrors++;
          else if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        }
      }
      await pause(5);
    }
    const r = output(await handle.done);
    if (scene === 'run') assert.equal(r.status, 'done');
    else { assert.equal(r.ok, true); assert.equal(r[scene], true); }
    assert.ok(complete > 0, '运行中应读到完整的 meta.json');
    const direct = fs.existsSync(log) ? read(log) : '';
    assert.equal(syntaxErrors, 0, `并发读取发生 ${syntaxErrors} 次 SyntaxError；直接覆盖写：${direct}`);
    assert.equal(direct, '', '不应直接覆盖 meta.json');
    for (const entry of fs.readdirSync(h.runs, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      assert.deepEqual(fs.readdirSync(path.join(h.runs, entry.name)).filter((name) => /^meta\.json\..*\.tmp$/.test(name)), []);
    }
  });
});
