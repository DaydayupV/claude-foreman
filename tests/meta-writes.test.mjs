import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { sandbox, seedRun, taskArgs, output, failed, poll, baseConfig, json, read, ROOT, BRIDGE, MESSAGES } from './helpers.mjs';
const M = MESSAGES.zh;

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
  if (mode === 'gone') {
    if (reads === 1) { rm(${JSON.stringify(dir)}, { recursive: true }); return ''; }
    return read(file, ...args);
  }
  if (mode === 'short' && reads === 1) return '';
  return mode === 'always' || reads === 2 ? content.slice(0, Math.floor(content.length / 2)) : content;
};
console.log(JSON.stringify({ ...findRun(${JSON.stringify(id)}), reads }));`);
  for (const mode of ['short', 'always', 'gone']) await t.test(mode, async () => {
    const result = await h.start(script, [mode]).done;
    if (mode === 'short') {
      const r = output(result);
      assert.deepEqual(r.meta, expected); assert.equal(r.id, id); assert.equal(r.dir, dir); assert.equal(r.reads, 3);
    } else if (mode === 'always') {
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, /SyntaxError/);
      assert.equal(result.stderr.includes(M.runNotFound(id)), false, result.stderr);
      assert.ok(Number(/reads=(\d+)/.exec(result.stderr)?.[1]) > 1, result.stderr);
    } else failed(result, M.runNotFound(id));
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
saveMeta(${JSON.stringify(dir)}, ${JSON.stringify(meta)});
console.log(JSON.stringify({ renames }));`);
  const r = output(await h.start(script).done);
  assert.equal(r.renames, 81);
  assert.deepEqual(json(path.join(dir, 'meta.json')), meta);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), []);
});

test('cancel 等待时 meta.json 读不出不算已停下，调度进程退出后不再等满就补写记录', async (t) => {
  const h = sandbox(t), id = 'unreadable-meta';
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { process.kill(sleeper.pid); } catch { /* 已结束 */ } });
  const dir = seedRun(h, id, { status: 'running', pid: sleeper.pid, ended_at: undefined });
  const started = Date.now();
  const handle = h.startBridge(['cancel', '--run', id], { env: { FOREMAN_TEST_CANCEL_WAIT_MS: '15000' } });
  await poll(() => fs.existsSync(path.join(dir, 'cancel')), '终止标记');
  // 记录读不出时调度进程还活着：cancel 不能当成已经停下
  fs.writeFileSync(path.join(dir, 'meta.json'), '{"id":');
  await pause(1200);
  assert.equal(handle.child.exitCode, null);
  process.kill(sleeper.pid);
  const out = output(await handle.done);
  assert.deepEqual(out, { run_id: id, ok: true, status: 'cancelled', forced: true });
  assert.ok(Date.now() - started < 10000, '调度进程退出后不应等满 15 秒');
  assert.equal(json(path.join(dir, 'meta.json')).status, 'cancelled');
  assert.equal(h.result(id).status, 'cancelled');
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
      seedRun(h, scene, { status: sleeper ? 'running' : 'interrupted', pid: sleeper?.pid ?? 0, ended_at: undefined });
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
