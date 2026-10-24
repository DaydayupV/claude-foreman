import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, write, json, read, output, failed, poll, seedRun, ROOT, MESSAGES } from './helpers.mjs';
import { removeLock } from '../foreman/skills/dispatch/scripts/board/lock.mjs';
import { buildId } from '../foreman/skills/dispatch/scripts/board/build-id.mjs';
import { createFeed } from '../foreman/skills/dispatch/scripts/board/feed.mjs';

const boardDir = path.join(ROOT, 'foreman/skills/dispatch/scripts/board');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function withBoard(t, run) {
  const h = sandbox(t), cfg = baseConfig(), children = [];
  cfg.dispatch.web = true; h.config(cfg);
  fs.mkdirSync(h.runs, { recursive: true });
  const lockFile = path.join(h.runs, 'board.lock.json');
  try { await run(h, children, lockFile); }
  finally {
    let lock;
    try { lock = json(lockFile); } catch { /* 写坏的测试锁没有 pid */ }
    for (const child of children) child.stop();
    if (Number.isInteger(lock?.pid) && lock.pid > 0 && lock.pid !== process.pid && alive(lock.pid)) process.kill(lock.pid);
    await Promise.allSettled(children.map((child) => child.done));
    if (lock?.pid && lock.pid !== process.pid) await poll(() => !alive(lock.pid), '看板服务退出');
    fs.rmSync(lockFile, { force: true });
  }
}
function startServer(h, children, options = {}, script = path.join(boardDir, 'server.mjs'), extra = []) {
  const child = h.start(script, ['--runs', h.runs, '--config', h.userConfig, '--claude-dir', path.join(h.home, 'synthetic-projects'), '--idle-min', '30', ...extra], { timeout: 30000, ...options });
  children.push(child);
  return child;
}
const ready = (child) => poll(() => child.stdout.includes('board: http://'), '看板开始监听');

test('buildId 按固定文件内容计算，跳过缺失文件且不受插件语言影响', (t) => {
  const h = sandbox(t), dir = path.join(h.home, 'build');
  write(path.join(dir, 'index.html'), 'page');
  assert.equal(buildId(dir), createHash('sha256').update('page').digest('hex').slice(0, 16));
  write(path.join(dir, 'language.json'), { language: 'en' });
  const before = buildId(dir);
  assert.equal(buildId(dir), before);
  write(path.join(dir, 'server.mjs'), 'server');
  assert.equal(buildId(dir), createHash('sha256').update('pageserver').digest('hex').slice(0, 16));
  assert.notEqual(buildId(dir), before);
  const withServer = buildId(dir);
  write(path.join(dir, '../prices.json'), 'rates');
  assert.equal(buildId(dir), createHash('sha256').update('pageserverrates').digest('hex').slice(0, 16));
  assert.notEqual(buildId(dir), withServer);
});

test('交错回收误取新锁时放回，放回时已有更新锁也不覆盖', (t) => {
  const h = sandbox(t), file = path.join(h.runs, 'board.lock.json');
  fs.mkdirSync(h.runs, { recursive: true });
  for (const newer of [false, true]) {
    write(file, 'old');
    let interleaved = false;
    const rename = fs.renameSync, link = fs.linkSync;
    const renameMock = t.mock.method(fs, 'renameSync', (from, to) => {
      if (from === file && !interleaved) {
        interleaved = true;
        assert.equal(removeLock(file, 'old'), true);
        write(file, 'new');
      }
      return rename(from, to);
    });
    const linkMock = t.mock.method(fs, 'linkSync', (from, to) => {
      if (newer) write(file, 'newer');
      return link(from, to);
    });
    try {
      assert.equal(removeLock(file, 'old'), false);
      assert.equal(read(file), newer ? 'newer' : 'new');
      assert.deepEqual(fs.readdirSync(h.runs), ['board.lock.json']);
    } finally { renameMock.mock.restore(); linkMock.mock.restore(); }
  }
});

test('递归监听不可用时回退扫描，仍能发现新记录', (t) => {
  const h = sandbox(t), feed = createFeed(h.runs);
  fs.mkdirSync(h.runs, { recursive: true });
  const mock = t.mock.method(fs, 'watch', () => { throw Object.assign(new Error('unsupported'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' }); });
  try {
    assert.doesNotThrow(() => feed.watch(true));
    assert.equal(feed.read({}).runs.length, 0);
    const id = '20261023-090000-test';
    seedRun(h, id);
    assert.equal(feed.read({ run: id }).runs[0].id, id);
  } finally { feed.watch(false); mock.mock.restore(); }
});

test('服务阻塞超过 5 秒时 board 和第二个服务都复用原锁', { timeout: 18000 }, (t) => withBoard(t, async (h, children, lockFile) => {
  const server = startServer(h, children, { env: { FOREMAN_TEST_BOARD_STALL_MS: '6500' } });
  await ready(server);
  const original = read(lockFile), pid = json(lockFile).pid;
  const command = h.bridge(['board']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = startServer(h, children);
  const result = output(await command);
  assert.equal(result.started, false);
  assert.equal((await second.done).code, 0, second.stderr);
  assert.ok(second.stdout.includes(`reused pid ${pid}`));
  assert.equal(read(lockFile), original);
  assert.equal(json(lockFile).pid, server.child.pid);
}));

for (const [raw, age] of [['', 4000], ['{"v":1,"pid":', 4000], ['{', 0]]) {
  test(`写坏的锁自动恢复（内容 ${JSON.stringify(raw)}，已过 ${age} ms）`, (t) => withBoard(t, async (h, children, lockFile) => {
    write(lockFile, raw);
    fs.utimesSync(lockFile, new Date(Date.now() - age), new Date(Date.now() - age));
    const started = Date.now();
    const result = output(await h.bridge(['board']));
    assert.equal(result.started, true);
    assert.equal((await fetch(new URL('health', result.url))).status, 200);
    if (!age) assert.ok(Date.now() - started >= 2700, '新坏锁保留三秒宽限期');
    assert.match(json(lockFile).build, /^[a-f0-9]{16}$/);
  }));
}

test('pid 已退出的锁，以及活 pid 但拒绝连接的锁都能立即回收', (t) => withBoard(t, async (h, children, lockFile) => {
  const departed = h.start(write(path.join(h.home, 'departed.mjs'), 'process.exit(0);'));
  await departed.done;
  write(lockFile, { v: 1, pid: departed.child.pid, port: 12345, token: 'a'.repeat(32) });
  const first = startServer(h, children);
  await ready(first);
  assert.equal(json(lockFile).pid, first.child.pid);
  first.stop(); await first.done;
  const probe = http.createServer();
  let port;
  try {
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    port = probe.address().port;
  } finally { await new Promise((resolve) => probe.close(resolve)); }
  write(lockFile, { v: 1, pid: process.pid, port, token: 'b'.repeat(32) });
  const started = Date.now(), second = startServer(h, children);
  await ready(second);
  assert.ok(Date.now() - started < 5000);
  assert.equal(json(lockFile).pid, second.child.pid);
}));

test('畸形请求返回 400 且服务仍可响应 health', (t) => withBoard(t, async (h) => {
  const board = output(await h.bridge(['board'])), url = new URL(board.url);
  const status = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: url.port, path: '//[' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 400);
  assert.equal((await fetch(new URL('health', url))).status, 200);
}));

test('build 不同的旧服务被结束并替换，链接随之改变', (t) => withBoard(t, async (h, children, lockFile) => {
  const oldDir = path.join(h.home, 'old-scripts/board');
  // 保留旧服务的实际依赖树，避免共用显示模块新增后只复制入口导致启动失败。
  fs.cpSync(path.dirname(boardDir), path.dirname(oldDir), { recursive: true });
  write(path.join(oldDir, 'index.html'), '<html lang="zh-CN">old</html>');
  // 旧版服务没有 shutdown 接口（POST 回 405）：board 退回按 pid 结束它
  const serverFile = path.join(oldDir, 'server.mjs');
  fs.writeFileSync(serverFile, fs.readFileSync(serverFile, 'utf8').replaceAll("route === 'shutdown'", "route === 'no-shutdown'"));
  const old = startServer(h, children, {}, path.join(oldDir, 'server.mjs'));
  await ready(old);
  const previous = json(lockFile);
  assert.notEqual(previous.build, buildId(boardDir));
  const result = output(await h.bridge(['board']));
  await old.done;
  assert.equal(result.started, true);
  assert.ok(old.child.exitCode !== null || old.child.signalCode !== null);
  assert.notEqual(new URL(result.url).pathname, `/${previous.token}/`);
  assert.notEqual(json(lockFile).pid, previous.pid);
  assert.equal(json(lockFile).build, buildId(boardDir));
}));

test('启动错误写入 board.err 并快速报告，成功重启后删除错误文件', (t) => withBoard(t, async (h) => {
  const preload = write(path.join(h.home, 'fail-board.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    if (path.basename(process.argv[1]) === 'server.mjs') {
      const open = fs.openSync;
      fs.openSync = (file, flags, ...rest) => {
        if (file === ${JSON.stringify(path.join(h.runs, 'board.lock.json'))} && flags === 'wx') throw new Error('synthetic startup failure\\nsecond line');
        return open(file, flags, ...rest);
      };
    }`);
  const started = Date.now();
  const result = await h.bridge(['board'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  const errFile = path.join(h.runs, 'board.err'), err = json(errFile);
  assert.equal(err.error, 'synthetic startup failure second line');
  assert.ok(Number.isInteger(err.pid) && err.pid !== process.pid);
  failed(result, MESSAGES.zh.boardStartFailed(err.error));
  assert.ok(Date.now() - started < 5000);
  assert.equal(output(await h.bridge(['board'])).started, true);
  assert.equal(fs.existsSync(errFile), false);
}));

test('锁被换成别的服务的锁时，原服务在自查时退出且不动新锁', (t) => withBoard(t, async (h, children, lockFile) => {
  const server = startServer(h, children, { env: { FOREMAN_TEST_BOARD_TICK_MS: '200' } });
  await ready(server);
  const other = JSON.stringify({ v: 1, pid: process.pid, port: 1, token: 'f'.repeat(32), started_at: new Date().toISOString(), build: 'x' });
  write(lockFile, other);
  await server.done;
  assert.match(server.stderr, /another board server took over the lock/);
  assert.equal(read(lockFile), other);
}));

test('锁被删掉时，服务在自查时重新认领同一份锁', (t) => withBoard(t, async (h, children, lockFile) => {
  const server = startServer(h, children, { env: { FOREMAN_TEST_BOARD_TICK_MS: '200' } });
  await ready(server);
  const before = read(lockFile);
  fs.rmSync(lockFile);
  await poll(() => fs.existsSync(lockFile) && read(lockFile) === before, '看板重新认领锁');
  assert.equal(server.child.exitCode, null);
}));

test('放回锁时不支持硬链接就改名放回，不留临时文件', (t) => {
  const h = sandbox(t), file = path.join(h.runs, 'board.lock.json');
  fs.mkdirSync(h.runs, { recursive: true });
  write(file, 'live');
  const linkMock = t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('no hard links'), { code: 'EPERM' }); });
  try {
    assert.equal(removeLock(file, 'stale'), false);
    assert.equal(read(file), 'live');
    assert.deepEqual(fs.readdirSync(h.runs), ['board.lock.json']);
  } finally { linkMock.mock.restore(); }
});

test('别的启动尝试留下的 board.err 不会盖住这次失败的原因', (t) => withBoard(t, async (h) => {
  const preload = write(path.join(h.home, 'crash-board.mjs'), `
    import path from 'node:path';
    if (path.basename(process.argv[1]) === 'server.mjs') process.exit(7);`);
  write(path.join(h.runs, 'board.err'), JSON.stringify({ pid: 1, error: 'previous attempt error' }) + '\n');
  const result = await h.bridge(['board'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  failed(result, MESSAGES.zh.boardStartFailed('exit code 7'));
}));

test('插件文件被换掉或删掉后，服务在自查时退出并删掉自己的锁；只是重写同样的内容不退出', (t) => withBoard(t, async (h, children, lockFile) => {
  for (const change of ['replace', 'remove']) {
    const dir = path.join(h.home, `plugin-${change}/scripts/board`);
    fs.cpSync(path.dirname(boardDir), path.dirname(dir), { recursive: true });
    const server = startServer(h, children, { env: { FOREMAN_TEST_BOARD_TICK_MS: '100' } }, path.join(dir, 'server.mjs'));
    await ready(server);
    // 修改时间变了、内容没变：重算 buildId 后照旧
    const page = fs.readFileSync(path.join(dir, 'index.html'));
    fs.writeFileSync(path.join(dir, 'index.html'), page);
    fs.utimesSync(path.join(dir, 'index.html'), new Date(), new Date(Date.now() + 5000));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(server.child.exitCode, null);
    if (change === 'replace') write(path.join(dir, 'index.html'), '<html lang="zh-CN">new</html>');
    else fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    await server.done;
    assert.match(server.stderr, /plugin files were removed or replaced/);
    assert.equal(fs.existsSync(lockFile), false);
  }
}));

for (const lang of ['zh', 'en']) test(`board --stop 关掉直播服务；没在运行时如实说明；dispatch.web 关掉后照样能关 (${lang})`, (t) => withBoard(t, async (h, children, lockFile) => {
  const options = { env: { FOREMAN_LANG: lang } }, notRunning = { stopped: false, message: MESSAGES[lang].boardNotRunning };
  assert.deepEqual(output(await h.bridge(['board', '--stop'], options)), notRunning);
  failed(await h.bridge(['board', '--stop', '--replay', 'all'], options), MESSAGES[lang].badArg('--replay'));
  assert.equal(output(await h.bridge(['board'], options)).started, true);
  const lock = json(lockFile), cfg = baseConfig();
  cfg.dispatch.web = false; h.config(cfg);
  assert.deepEqual(output(await h.bridge(['board', '--stop'], options)), { stopped: true, pid: lock.pid });
  assert.equal(alive(lock.pid), false);
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(output(await h.bridge(['board', '--stop'], options)), notRunning);
}));

test('board --stop 不结束健康检查对不上的进程', (t) => withBoard(t, async (h, children, lockFile) => {
  // 锁里的 pid 是测试进程自己（活着，但不是看板服务）：健康检查连不上端口，不能结束它
  const lock = { v: 1, pid: process.pid, port: 1, token: 'e'.repeat(32), started_at: new Date().toISOString(), build: 'x' };
  write(lockFile, lock);
  const result = await h.bridge(['board', '--stop']);
  assert.ok([0, 2].includes(result.code), result.stderr);
  if (result.code === 2) failed(result, MESSAGES.zh.boardStopUnverified(process.pid));
  else assert.deepEqual(output(result), { stopped: false, message: MESSAGES.zh.boardNotRunning });
  assert.equal(alive(process.pid), true);
  fs.rmSync(lockFile, { force: true });
}));

test('board 启动的服务把工作目录放在记录目录，不占着插件目录', (t) => withBoard(t, async (h) => {
  const out = path.join(h.home, 'board-cwd.txt');
  const preload = write(path.join(h.home, 'cwd-board.mjs'), `
    import fs from 'node:fs';
    import path from 'node:path';
    if (path.basename(process.argv[1]) === 'server.mjs') fs.writeFileSync(${JSON.stringify(out)}, process.cwd());`);
  assert.equal(output(await h.bridge(['board'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } })).started, true);
  assert.equal(path.resolve(read(out)), path.resolve(h.runs));
}));

test('shutdown 只收带令牌的 POST，服务回应后自己退出并删掉锁', (t) => withBoard(t, async (h, children, lockFile) => {
  const server = startServer(h, children);
  await ready(server);
  const lock = json(lockFile), base = `http://127.0.0.1:${lock.port}/${lock.token}/`;
  assert.equal((await fetch(base + 'shutdown')).status, 405);
  assert.equal((await fetch(base + 'health', { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${lock.port}/${'0'.repeat(32)}/shutdown`, { method: 'POST' })).status, 404);
  assert.equal(server.child.exitCode, null);
  const response = await fetch(base + 'shutdown', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, pid: lock.pid });
  await server.done;
  assert.equal(server.child.exitCode, 0);
  assert.equal(fs.existsSync(lockFile), false);
}));

test('启动途中插件文件被换掉（算 buildId 时），第一次自查就退出', (t) => withBoard(t, async (h, children) => {
  const dir = path.join(h.home, 'plugin-midstart/scripts/board'), page = path.join(dir, 'index.html');
  fs.cpSync(path.dirname(boardDir), path.dirname(dir), { recursive: true });
  // 第一次读页面算 buildId 时，磁盘上的页面已经换成新的，读到的还是旧内容
  const preload = write(path.join(h.home, 'swap-board.mjs'), `
    import fs from 'node:fs';
    const page = ${JSON.stringify(page)}, read = fs.readFileSync;
    let swapped = false;
    fs.readFileSync = (file, ...rest) => {
      if (!swapped && file === page) { swapped = true; const old = read(file, ...rest); fs.writeFileSync(page, '<html lang="zh-CN">new</html>'); return old; }
      return read(file, ...rest);
    };`);
  const server = startServer(h, children, { env: { FOREMAN_TEST_BOARD_TICK_MS: '100', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }, path.join(dir, 'server.mjs'));
  await server.done;
  assert.match(server.stderr, /plugin files were removed or replaced/);
}));
