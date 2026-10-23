import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createFeed, buildReplay, snapshotAt, imagesOf } from './feed.mjs';
import { loadPrices } from '../prices.mjs';
import { createUniverse, universeChanges, universeAt } from './universe.mjs';
import { buildId } from './build-id.mjs';
import { retryFile, removeLock } from './lock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// 页面语言跟插件走（scripts/language.json：中文插件 zh、英文插件 en），测试时可用 FOREMAN_LANG 覆盖，和 util.mjs 一样
const LANG = process.env.FOREMAN_LANG || (() => { try { return JSON.parse(fs.readFileSync(path.join(here, '..', 'language.json'), 'utf8')).language; } catch { return 'zh'; } })();
const keys = ['runs', 'port', 'idle-min', 'group', 'run', 'replay', 'speed', 'maxgap', 'transcript', 'session', 'claude-dir', 'lead', 'tail', 'prices', 'window-h', 'config'];
let lockFile, owner, ownerRaw, server, runsRoot, build;
const short = (e) => String(e.message || e).replace(/\s+/g, ' ');
function readLock() {
  let raw, mtime;
  try { raw = retryFile(() => fs.readFileSync(lockFile, 'utf8')); mtime = fs.statSync(lockFile).mtimeMs; }
  catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`cannot read lock file ${lockFile}: ${short(e)}`); }
  let value;
  try { value = JSON.parse(raw); } catch { /* 新建后尚未写完的锁也走宽限期 */ }
  return { raw, mtime, value };
}
// 锁还是不是自己的：被别人回收后锁不在了就重新认领；已经换成别人的锁就返回 false，由调用方退出。
// 服务忙过 15 秒会被接管，恢复后靠这个保证同一时刻只剩一个服务。
function holdsLock() {
  let current;
  try { current = readLock(); } catch { return true; } // 读不到锁时不贸然退出
  if (current?.raw === ownerRaw) return true;
  if (!current) {
    try {
      const fd = retryFile(() => fs.openSync(lockFile, 'wx', 0o600));
      try { fs.writeFileSync(fd, ownerRaw); } finally { fs.closeSync(fd); }
      return true;
    } catch (e) { if (e.code !== 'EEXIST') return true; }
  }
  return false;
}
function quitLostLock() {
  process.stderr.write('board: another board server took over the lock; exiting\n');
  ownerRaw = undefined; // 锁已经是别人的，退出时不去动它
  server?.close();
  process.exit(0);
}
function cleanup() {
  try { removeLock(lockFile, ownerRaw); } catch (e) { process.stderr.write(`board: ${short(e)}\n`); }
}
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
function health(lock, timeout) {
  return new Promise((resolve) => {
    if (!Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 || !/^[a-f0-9]{32}$/.test(lock.token)) return resolve('wait');
    const req = http.get({ hostname: '127.0.0.1', port: lock.port, path: `/${lock.token}/health` }, (res) => {
      let body = '';
      res.setEncoding('utf8'); res.on('data', (s) => { body += s; });
      res.on('end', () => { try { const value = JSON.parse(body); finish(res.statusCode === 200 && value.ok === true && value.v === 1 && value.pid === lock.pid ? 'ok' : 'wait'); } catch { finish('wait'); } });
      res.on('error', () => finish('wait'));
    });
    const timer = setTimeout(() => { req.destroy(); finish('wait'); }, timeout);
    const finish = (ok) => { clearTimeout(timer); resolve(ok); };
    req.on('error', (e) => finish(e.code === 'ECONNREFUSED' ? 'refused' : 'wait'));
  });
}
async function claim() {
  let waitingFor, deadline;
  for (;;) {
    let fd;
    try { fd = retryFile(() => fs.openSync(lockFile, 'wx', 0o600)); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (fd !== undefined) {
      owner = { v: 1, pid: process.pid, port: 0, token: randomBytes(16).toString('hex'), started_at: new Date().toISOString(), build };
      ownerRaw = JSON.stringify(owner);
      process.once('exit', cleanup);
      try { fs.writeFileSync(fd, ownerRaw); } finally { fs.closeSync(fd); }
      return null;
    }
    const existing = readLock();
    if (!existing) continue;
    if (!existing.value) {
      if (Date.now() - existing.mtime >= 3000) removeLock(lockFile, existing.raw);
    } else if (!alive(existing.value.pid)) removeLock(lockFile, existing.raw);
    else {
      const identity = `${existing.value.pid}:${existing.value.token}`;
      if (waitingFor !== identity) { waitingFor = identity; deadline = Date.now() + 15000; }
      // 超时可能只是同步读取阻塞；只有拒绝连接才立即回收活 pid 的锁。
      const state = await health(existing.value, Math.max(1, Math.min(1000, deadline - Date.now())));
      if (state === 'ok') return existing.value;
      if (state === 'refused' || Date.now() >= deadline) removeLock(lockFile, existing.raw);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function scopeOptions(values) {
  if (['group', 'run', 'replay'].filter((key) => values[key] != null).length > 1) throw new Error('choose one scope');
  const scope = {};
  for (const key of ['group', 'run', 'replay']) if (values[key] != null) scope[key] = values[key];
  if (values.session != null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(values.session) || values.session.includes('..')) throw new Error('invalid session');
    if (values.group != null || values.run != null) throw new Error('choose one scope');
    scope.session = values.session;
  }
  if (values.from != null) { scope.from = Number(values.from); if (!Number.isFinite(scope.from)) throw new Error('invalid replay time'); }
  scope.speed = Number(values.speed ?? 1); scope.maxgap = Number(values.maxgap ?? 20);
  if (!Number.isFinite(scope.speed) || scope.speed <= 0 || !Number.isFinite(scope.maxgap) || scope.maxgap < 0) throw new Error('invalid replay timing');
  return scope;
}
const hello = (data, now) => ({ v: 3, mode: 'live', scope: data.scope, now, replay: null });
const backlog = (events) => events.length <= 200 ? events : events.some((ev) => ev.k === 'start') ? [events.find((ev) => ev.k === 'start'), ...events.filter((ev) => ev.k !== 'start').slice(-199)] : events.slice(-200);

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])) });
  scopeOptions({ ...values, session: undefined });
  const port = Number(values.port ?? 0), idleMs = Number(values['idle-min'] ?? 5) * 60000;
  const windowH = Number(values['window-h'] ?? 24), configFile = values.config || path.join(os.homedir(), '.claude', 'foreman', 'config.json');
  if (!Number.isFinite(windowH) || windowH < 0) throw new Error('invalid window');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(idleMs) || idleMs < 0) throw new Error('invalid port or idle timeout');
  let configured;
  if (!values.runs) {
    const legacyConfig = path.join(os.homedir(), '.claude', 'foreman', 'config.json');
    try { configured = JSON.parse(fs.readFileSync(legacyConfig, 'utf8')).dispatch?.runs_dir; }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read config file ${legacyConfig}: ${short(e)}`); }
  }
  const root = runsRoot = path.resolve(values.runs || configured || path.join(os.homedir(), '.claude', 'foreman', 'runs'));
  let directory = false;
  try { directory = fs.statSync(root).isDirectory(); } catch { /* 统一报目录不存在 */ }
  if (!directory) throw new Error(`runs directory not found: ${root}`);
  lockFile = path.join(root, 'board.lock.json');
  build = buildId(here);
  const reused = await claim();
  const query = new URLSearchParams();
  if (values.group == null && values.run == null && (values.replay == null || values.replay === 'all')) query.set('level', 'all');
  for (const key of ['group', 'run', 'replay', 'speed', 'maxgap']) if (values[key] != null) query.set(key, values[key]);
  const address = (lock) => `board: http://127.0.0.1:${lock.port}/${lock.token}/?${query}`;
  if (reused) { process.stdout.write(`${address(reused)} (reused pid ${reused.pid})\n`); return; }

  const options = { transcript: values.transcript, session: values.session, claudeDir: values['claude-dir'] || path.join(os.homedir(), '.claude', 'projects'),
    lead: Number(values.lead ?? 10), tail: Number(values.tail ?? 5), prices: loadPrices(values.prices || path.join(here, '../prices.json')) };
  const feed = createFeed(root, options), universe = createUniverse({ ...options, runs: root, config: configFile, windowH }), clients = new Set(), replays = new Map();
  const allReplay = (scope, now, refresh = false) => {
    const key = `${scope.speed}:${scope.maxgap}`;
    const replay = refresh || !replays.has(key) ? universe.replay(scope, now) : replays.get(key);
    replays.delete(key); replays.set(key, replay);
    if (replays.size > 2) replays.delete(replays.keys().next().value);
    return replay;
  };
  let poll = null, idleSince = feed.hasRunning(Date.now()) ? null : Date.now();
  const send = (client, event, data) => client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const liveUpdate = (client, data) => {
    for (const run of data.runs) {
      const text = JSON.stringify(run), previous = client.seen.get(run.id), revision = data.revisions[run.id];
      if (previous?.text !== text || previous?.revision !== revision) send(client, 'run', run);
      const events = data.events.filter((ev) => ev.run === run.id), version = data.versions[run.id];
      const keyOf = (ev) => ev.messageId || JSON.stringify({ ...ev, target: undefined });
      const links = run.id === 'cc' ? new Map(events.map((ev) => [keyOf(ev), ev.target])) : null;
      if (!previous) send(client, 'backlog', { run: run.id, events: backlog(events) });
      else if (links) for (const ev of events) {
        const key = keyOf(ev);
        if (previous.version !== version || !previous.links.has(key)) send(client, 'ev', ev);
        else if (ev.target?.length && JSON.stringify(previous.links.get(key)) !== JSON.stringify(ev.target)) send(client, 'ev_link', { run: 'cc', ts: ev.ts, k: ev.k, target: ev.target });
      }
      else for (const ev of events.slice(previous.version === version ? previous.count : 0)) send(client, 'ev', ev);
      client.seen.set(run.id, { text, count: events.length, version, revision, links });
    }
  };
  const universeUpdate = (client, data) => {
    if (!client.universe) send(client, 'universe', data);
    else for (const message of universeChanges(client.universe, data)) send(client, message.event, message.data);
    client.universe = data;
  };
  const updatePolling = () => {
    const needed = [...clients].some((c) => c.scope.replay == null);
    feed.watch(needed);
    if (!needed && poll) { clearInterval(poll); poll = null; }
    if (needed && !poll) poll = setInterval(() => {
      try {
        const scopes = new Map(), now = Date.now();
        for (const client of clients) if (client.scope.replay == null) {
          if (client.all) {
            if (!scopes.has('all')) scopes.set('all', universe.read(now));
            universeUpdate(client, scopes.get('all')); continue;
          }
          const key = JSON.stringify(client.scope);
          if (!scopes.has(key)) scopes.set(key, feed.read(client.scope, now));
          liveUpdate(client, scopes.get(key));
        }
      } catch (e) { process.stderr.write(`board: ${short(e)}\n`); }
    }, 1000);
  };
  const play = (client, replay, opened) => {
    let i = 0;
    const next = () => {
      if (client.res.destroyed) return;
      const due = (m) => opened + (m.time - (client.scope.from ?? replay.hello.replay.start)) / replay.hello.replay.speed;
      while (i < replay.timeline.length) {
        const time = due(replay.timeline[i]);
        if (!Number.isFinite(time)) { i++; continue; }
        if (time > Date.now()) break;
        const message = replay.timeline[i++]; send(client, message.event, message.data);
      }
      if (i < replay.timeline.length) client.timer = setTimeout(next, Math.max(0, due(replay.timeline[i]) - Date.now()));
      else { client.timer = null; send(client, 'done', {}); }
    };
    next();
  };
  server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    const end = (status, type, body = '') => { res.writeHead(status, type ? { 'Content-Type': type } : {}); res.end(req.method === 'HEAD' ? undefined : body); };
    if (![`127.0.0.1:${owner.port}`, `localhost:${owner.port}`].includes(req.headers.host)) return end(403);
    if (!['GET', 'HEAD'].includes(req.method)) return end(405);
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${owner.port}`); } catch { return end(400); }
    const prefix = `/${owner.token}/`;
    if (!url.pathname.startsWith(prefix)) return end(404);
    const route = url.pathname.slice(prefix.length);
    try {
      if (!route) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: 'self'; base-uri 'none'; form-action 'none'");
        let html;
        try { html = fs.readFileSync(path.join(here, 'index.html'), 'utf8'); }
        catch (e) { if (e.code !== 'ENOENT') throw e; html = '<!doctype html><title>Foreman board</title><p>Board page is not built yet.</p>'; }
        const requested = url.searchParams.get('lang'), lang = ['zh', 'en'].includes(requested) ? requested : LANG;
        html = html.replace(/<html lang="(?:zh-CN|en)">/, `<html lang="${lang === 'en' ? 'en' : 'zh-CN'}">`)
          .replace(/window\.__LANG__ = '(?:zh|en)';/, `window.__LANG__ = '${lang === 'en' ? 'en' : 'zh'}';`);
        return end(200, 'text/html; charset=utf-8', html);
      }
      if (route === 'health') {
        // 只供测试：模拟同步读记录阻塞第一次健康检查。
        if (process.env.FOREMAN_TEST_BOARD_STALL_MS) {
          const ms = Number(process.env.FOREMAN_TEST_BOARD_STALL_MS);
          delete process.env.FOREMAN_TEST_BOARD_STALL_MS;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
        }
        return end(200, 'application/json', JSON.stringify({ ok: true, v: 1, pid: process.pid, build }));
      }
      // 出图任务的缩略图：只收任务 id 和序号，图片路径取自这个任务自己的记录（imagesOf），只给图片文件
      if (route === 'image') {
        const id = url.searchParams.get('run') || '', n = Number(url.searchParams.get('n'));
        if (!/^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id) || !Number.isInteger(n) || n < 0) return end(400);
        const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(root, id, name), 'utf8')); } catch { return null; } };
        const file = imagesOf(read('meta.json'), read('result.json'))[n];
        let st = null;
        try { st = file ? fs.statSync(file) : null; } catch { /* 文件已经不在了 */ }
        if (!st?.isFile() || st.size > 15e6) return end(404);
        const ext = path.extname(file).slice(1).toLowerCase(), type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
        return end(200, type, req.method === 'HEAD' ? '' : fs.readFileSync(file));
      }
      if (!['stream', 'snapshot', 'sessions'].includes(route)) return end(404);
      let scope;
      try { scope = scopeOptions(Object.fromEntries(url.searchParams)); } catch { return end(400); }
      if (route === 'snapshot' && url.searchParams.get('level') === 'all') return end(400);
      if (req.method === 'HEAD') return end(200, route === 'stream' ? 'text/event-stream' : 'application/json');
      const opened = Date.now(), all = route === 'sessions' || url.searchParams.get('level') === 'all';
      if (all && scope.replay != null && scope.replay !== 'all') return end(400);
      const shared = scope.replay === 'all' ? allReplay(scope, opened, route === 'stream' && all) : null;
      const data = all ? null : shared ? null : feed.read(scope, opened);
      const replay = shared ? all ? shared : shared.detail(scope.session) : scope.replay != null ? buildReplay(data, scope, opened) : null;
      if (shared && !replay) return end(404);
      if (route === 'sessions') {
        const t = url.searchParams.has('t') ? Number(url.searchParams.get('t')) : Infinity;
        if (t < 0 || !Number.isFinite(t) && t !== Infinity) return end(400);
        return end(200, 'application/json', JSON.stringify(shared ? universeAt(shared, t) : universe.read(opened)));
      }
      if (route === 'snapshot') {
        const t = url.searchParams.has('t') ? Number(url.searchParams.get('t')) : Infinity;
        if (replay && (!Number.isFinite(t) && t !== Infinity || t < 0)) return end(400);
        const snapshot = replay ? snapshotAt(replay, t) : { hello: hello(data, opened), runs: data.runs,
          events: data.runs.flatMap((run) => backlog(data.events.filter((ev) => ev.run === run.id))) };
        return end(200, 'application/json', JSON.stringify(snapshot));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.flushHeaders();
      const client = { res, scope, all, seen: new Map(), timer: null };
      clients.add(client); idleSince = Date.now();
      res.once('close', () => { clearTimeout(client.timer); clients.delete(client); if (!clients.size) idleSince = Date.now(); updatePolling(); });
      send(client, 'hello', replay?.hello || (all ? universe.hello(opened) : hello(data, opened)));
      if (replay) { if (all) send(client, 'universe', replay.initial); play(client, replay, opened); }
      else if (all) universeUpdate(client, universe.read(opened)); else liveUpdate(client, data);
      updatePolling();
    } catch (e) {
      process.stderr.write(`board: ${short(e)}\n`);
      if (res.headersSent) res.destroy(); else end(500);
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  owner.port = server.address().port;
  const raw = JSON.stringify(owner), temp = `${lockFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  // 认领后到这里通常只有几毫秒；卡了太久被别人接管时不能把别人的锁覆盖掉
  if (!holdsLock()) quitLostLock();
  try {
    fs.writeFileSync(temp, raw, { flag: 'wx', mode: 0o600 });
    retryFile(() => fs.renameSync(temp, lockFile));
    ownerRaw = raw;
  } finally { retryFile(() => fs.rmSync(temp, { force: true })); }
  fs.rmSync(path.join(root, 'board.err'), { force: true });
  process.stdout.write(`${address(owner)}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => process.exit(0));
  setInterval(() => {
    if (!holdsLock()) quitLostLock();
    const now = Date.now();
    for (const client of clients) client.res.write(': ping\n\n');
    try {
      if (clients.size || feed.hasRunning(now)) idleSince = null;
      else if (idleSince == null) idleSince = now;
      else if (now - idleSince >= idleMs) process.exit(0);
    } catch (e) { process.stderr.write(`board: ${short(e)}\n`); }
  }, Number(process.env.FOREMAN_TEST_BOARD_TICK_MS) || 15000); // 变量只给测试缩短自查间隔
}

main().catch((e) => {
  process.stderr.write(`board: ${short(e)}\n`);
  if (runsRoot) {
    // 带上 pid：board 子命令只采信自己启动的那个进程写的错误
    try { fs.writeFileSync(path.join(runsRoot, 'board.err'), JSON.stringify({ pid: process.pid, error: short(e) }) + '\n', { mode: 0o600 }); } catch { /* 记录目录不可写时保留 stderr */ }
  }
  server?.close(); process.exitCode = 1;
});
