// agy 全局守卫的安装、自检、启动标记和沙箱探针；所有改写与派出共用一把锁。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { acquireLock } from '../locks.mjs';
import { foremanStateDir, readRawConfig, ENTRY } from '../config.mjs';
import { RUNS_ROOT, readMeta, isRunning } from '../records.mjs';
import { M, binCommand, pathCommand, replaceFile, pidExists, retryBusy, processStartTimes, pathKey } from '../util.mjs';

const SOURCE = new URL('./agy-guard.mjs', import.meta.url);
const HASH = (s) => createHash('sha256').update(s).digest('hex');
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
let ownStartedAt;
const cmd = () => `node "${ENTRY}"`;
export const guardDir = () => path.join(os.homedir(), '.gemini', 'config');
const markerDir = () => path.join(foremanStateDir(), 'agy-markers');
export const guardEntry = () => ({ PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command:
  // Windows 上要写 .\：Claude Code 给子进程设了 NoDefaultCurrentDirectoryInExePath，cmd 不会在当前目录里找裸文件名。
  process.platform === 'win32' ? '.\\foreman-agy-guard.cmd' : './foreman-agy-guard.sh', timeout: 10 }] }] });

export function agyCommand(agent = {}) {
  if (agent.bin) return binCommand(agent.bin);
  const found = pathCommand(process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (path.isAbsolute(found.file)) return found;
  const local = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe');
  return process.platform === 'win32' && fs.existsSync(local) ? binCommand(local) : found;
}

// 第 4 节：只保留 agy 自己登录可能使用的 GEMINI_API_KEY，其他已知密钥不传给模型的 shell。
export function guardEnvironment(policy) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() === 'GEMINI_API_KEY'
    || !/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SSH_AUTH_SOCK|AWS_PROFILE|AWS_CONFIG_FILE|GOOGLE_APPLICATION_CREDENTIALS)/i.test(k)));
  env.FOREMAN_AGY_GUARD = JSON.stringify(policy);
  // 沙箱读不到 ~/.gitconfig，git 会直接报错退出；沙箱里的命令改读一个空的全局配置（放在沙箱能读的临时目录）。
  // 每次启动各用一个文件、每次清空重写：临时目录在沙箱里可写，共用一个文件会被上一轮的命令改掉。
  if (policy.sandbox) {
    const empty = gitConfigFor(policy);
    try { fs.writeFileSync(empty, ''); env.GIT_CONFIG_GLOBAL = empty; } catch { /* 写不了就照旧，git 命令会失败 */ }
  }
  return env;
}
const gitConfigFor = (policy) => path.join(os.tmpdir(), `foreman-agy-${policy.nonce}.gitconfig`);
export function policyFor({ cwd, addDirs = [], access = 'none', runDir, sandbox = false, probeCommands }) {
  return { root: cwd, add_dirs: addDirs, access, run_dir: runDir, log_file: path.join(runDir, 'agy.log'), nonce: randomUUID(),
    sandbox, sandbox_available: sandbox && access === 'read', ...(probeCommands ? { probe_commands: probeCommands } : {}) };
}

function atomic(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode }); replaceFile(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
function hooksFile(missing = false) {
  const file = path.join(guardDir(), 'hooks.json');
  if (missing && !fs.existsSync(file)) return {};
  let hooks;
  try { hooks = strictJson(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') throw new Error(M.agyGuardMissing(cmd()));
    throw new Error(M.agyInvalidHooks(file, e.message));
  }
  if (!object(hooks)) throw new Error(M.agyInvalidHooks(file, M.invalid.object));
  return hooks;
}
// 第 3.4 节：JSON.parse 会吞掉重名条目，不能靠它确认“恰好一个”守卫。
function strictJson(text) {
  const value = JSON.parse(text), stack = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    if (token === '{' || token === '[') stack.push({ keys: token === '{' ? new Set() : null, key: true });
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (stack.at(-1)) stack.at(-1).key = true; }
    else if (token.startsWith('"') && stack.at(-1)?.keys && stack.at(-1).key) {
      const frame = stack.at(-1), key = JSON.parse(token);
      if (frame.keys.has(key)) throw new Error(M.agyDuplicateKey(key));
      frame.keys.add(key); frame.key = false;
    }
  }
  return value;
}
function guardFiles() {
  const dir = guardDir(), script = path.join(dir, 'foreman-agy-guard.mjs');
  const node = process.execPath, shQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  // 第 3.1 节：cmd 启动器不依赖 PATH；缺依赖时普通会话 ask，foreman 会话 deny。
  const cmdText = `@echo off\r\nif not exist "${node}" goto missing\r\nif not exist "%~dp0foreman-agy-guard.mjs" goto missing\r\n"${node}" "%~dp0foreman-agy-guard.mjs"\r\nexit /b %errorlevel%\r\n:missing\r\nif defined FOREMAN_AGY_GUARD (\r\n  echo {"decision":"deny","reason":"foreman guard: node or guard script is missing"}\r\n) else (\r\n  echo {"decision":"ask"}\r\n)\r\nexit /b 0\r\n`;
  const shText = `#!/bin/sh\nif [ -x ${shQuote(node)} ] && [ -f ${shQuote(script)} ]; then\n  exec ${shQuote(node)} ${shQuote(script)}\nfi\nif [ "\$\{FOREMAN_AGY_GUARD+x\}" = x ]; then\n  printf '%s\\n' '{"decision":"deny","reason":"foreman guard: node or guard script is missing"}'\nelse\n  printf '%s\\n' '{"decision":"ask"}'\nfi\n`;
  return new Map([['foreman-agy-guard.mjs', fs.readFileSync(SOURCE)], ['foreman-agy-guard.cmd', cmdText], ['foreman-agy-guard.sh', shText]]);
}
function matchingFiles() {
  return [...guardFiles()].every(([file, text]) => {
    try { return HASH(fs.readFileSync(path.join(guardDir(), file))) === HASH(text); } catch { return false; }
  }) && fs.existsSync(process.execPath);
}
function writeFiles() {
  for (const [file, text] of guardFiles()) atomic(path.join(guardDir(), file), text, file.endsWith('.sh') ? 0o700 : 0o600);
}
function activeRuns() {
  const markers = fs.existsSync(markerDir()) ? fs.readdirSync(markerDir()).filter((f) => f.endsWith('.json')).map((file) =>
    JSON.parse(fs.readFileSync(path.join(markerDir(), file), 'utf8'))).filter((m) => Date.parse(m.expires_at) > Date.now() && pidExists(m.pid)) : [];
  const starts = processStartTimes(markers.filter((m) => m.started_at != null).map((m) => m.pid), { timeoutMs: 5000 });
  const current = markers.filter((m) => !(Number.isFinite(m.started_at) && starts.get(m.pid) != null && starts.get(m.pid) - m.started_at > 2000));
  // status 是只读的：不调 defaultRunsRoot()，它在旧安装上会把旧记录目录搬过来。
  const root = RUNS_ROOT || process.env.FOREMAN_RUNS_DIR || process.env.CODEX_RUNS_DIR || readRawConfig()?.dispatch?.runs_dir || path.join(foremanStateDir(), 'runs');
  const runs = fs.existsSync(root) ? fs.readdirSync(root).map((id) => ({ ...readMeta(path.join(root, id)), run_dir: path.join(root, id) }))
    .filter((m) => m.agent_type === 'agy cli' && isRunning(m)) : [];
  return [...new Map([...runs, ...current].map((m) => [m.run_dir, m])).values()];
}
function refuseActive(action, exceptDir) {
  const runs = activeRuns().filter((m) => m.run_dir !== exceptDir);
  if (runs.length) throw new Error(M.agyActiveRuns(runs.length, action) + '\n' + runs.map((r) => r.id || r.run_dir).join('\n'));
}
export function timeLeft(deadline, limit = Infinity) {
  const left = deadline - Date.now();
  if (left <= 0) throw Object.assign(new Error(M.agyTimeout), { code: 'ETIMEDOUT' });
  return Math.min(left, limit);
}
async function locked(fn, deadline = Infinity) {
  fs.mkdirSync(foremanStateDir(), { recursive: true });
  const lock = await acquireLock(path.join(foremanStateDir(), 'agy-guard.lock'), { waitMs: timeLeft(deadline, 60000),
    busy: ({ file }) => { timeLeft(deadline); throw new Error(M.agyLockBusy(file)); } });
  try { timeLeft(deadline); return await fn(); } finally { lock.release(); }
}

export async function manageGuard(action) {
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error(M.agyGuardUsage);
  return locked(() => {
    if (action === 'status') {
      const hooks = hooksFile(true), entry = hooks['foreman-guard'];
      return { installed: !!entry, valid: validEntry(entry) && Object.keys(hooks).length === 1 && matchingFiles(), dir: guardDir(), active: activeRuns() };
    }
    refuseActive(action);
    const hooks = hooksFile(true), file = path.join(guardDir(), 'hooks.json');
    if (action === 'uninstall' && !Object.hasOwn(hooks, 'foreman-guard')) {
      for (const name of guardFiles().keys()) fs.rmSync(path.join(guardDir(), name), { force: true });
      return { installed: false, dir: guardDir(), backup: null, message: M.agyNotInstalled };
    }
    fs.mkdirSync(guardDir(), { recursive: true });
    const backup = fs.existsSync(file) ? `${file}.${Date.now()}-${randomUUID()}.bak` : null;
    if (backup) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    if (action === 'install') {
      writeFiles();
      hooks['foreman-guard'] = guardEntry();
      atomic(file, JSON.stringify(hooks, null, 2) + '\n');
    } else {
      delete hooks['foreman-guard'];
      atomic(file, JSON.stringify(hooks, null, 2) + '\n');
      for (const name of guardFiles().keys()) fs.rmSync(path.join(guardDir(), name), { force: true });
    }
    return { installed: action === 'install', dir: guardDir(), backup, message: action === 'install'
      ? M.agyInstalled(guardDir(), backup) : M.agyUninstalled };
  });
}
function validEntry(entry) {
  if (!object(entry) || entry.enabled === false) return false;
  const { enabled, ...events } = entry;
  return (enabled === undefined || enabled === true) && isDeepStrictEqual(events, guardEntry());
}

// 第 3.4 节：静态检查必须先于任何会加载项目配置的 agy 进程。
export function scanProject(cwd, addDirs = []) {
  const seen = new Set(), notes = [];
  for (const start of [cwd, ...addDirs].flatMap((p) => [path.resolve(p), fs.realpathSync(p)])) {
    for (let dir = start; !seen.has(dir); dir = path.dirname(dir)) {
      seen.add(dir);
      const names = fs.readdirSync(dir);
      for (const name of names.filter((n) => ['.agents', '.agent', '_agents', '_agent'].includes(n.toLowerCase()))) {
        const root = path.join(dir, name), files = fs.readdirSync(root);
        for (const file of files) {
          const lower = file.toLowerCase(), full = path.join(root, file);
          const kind = lower === 'hooks.json' ? 'hooks' : lower === 'mcp_config.json' ? 'MCP'
            : lower === 'plugins.json' || lower === 'plugins' && fs.readdirSync(full).length ? 'plugin' : null;
          if (kind) throw new Error(M.agyProjectConfig(full, kind));
          if (lower === 'skills.json') notes.push(M.agySkills(full));
        }
      }
      for (const name of names.filter((n) => ['gemini.md', 'agents.md'].includes(n.toLowerCase()))) notes.push(M.agySkills(path.join(dir, name)));
      if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
    }
  }
  return notes;
}
function createMarker(policy, deadline) {
  const file = path.join(markerDir(), `${policy.nonce}.json`);
  // 查不到也缓存，避免每次查询和修复都重新启动系统工具。
  // 查询受这一轮总时限约束、最多 5 秒；查不到就不写 started_at（守卫对没有它的标记照旧拦截），下次再查。
  ownStartedAt ??= processStartTimes([process.pid], { timeoutMs: Math.max(1, Math.min(5000, deadline - Date.now())) }).get(process.pid) ?? undefined;
  atomic(file, JSON.stringify({ cwd: policy.root, workspaces: [policy.root, ...policy.add_dirs], expires_at: new Date(deadline).toISOString(),
    pid: process.pid, ...(ownStartedAt != null ? { started_at: ownStartedAt } : {}), run_dir: policy.run_dir }));
  const cleanup = () => {
    retryBusy(() => fs.rmSync(file, { force: true }));
    try { fs.rmSync(gitConfigFor(policy), { force: true }); } catch { /* 删不掉的留在临时目录，不影响下一轮（文件名带 nonce） */ }
    process.removeListener('exit', cleanup);
  };
  process.once('exit', cleanup);
  return cleanup;
}

// agy 启动时可能拉起一个后台更新进程（agy --bg-updater），工作目录就是这次的 cwd，几分钟内删不掉这个目录。
// 所以临时目录放在 foreman 自己的目录里，删不掉的留着，下次建临时目录时清掉一小时以前的。
const BUSY = ['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'];
export function workDir(prefix) {
  const root = path.join(foremanStateDir(), 'agy-work');
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    const old = path.join(root, name);
    try { if (Date.now() - fs.statSync(old).mtimeMs > 3600000) fs.rmSync(old, { recursive: true, force: true }); } catch { /* 还被占着，下次再清 */ }
  }
  return fs.mkdtempSync(path.join(root, prefix));
}
export function removeWorkDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { if (!BUSY.includes(e.code)) throw e; }
}

// 查询同样带策略和标记；cwd 只用空临时目录，不加载项目级配置。
export function queryAgy(agent, args, timeout = 60000, deadline = Date.now() + timeout) {
  deadline = Math.min(deadline, Date.now() + timeout);
  timeLeft(deadline);
  const dir = workDir('query-');
  try {
    const { file, pre } = agyCommand(agent);
    for (let attempt = 0; ; attempt++) {
      timeLeft(deadline);
      const policy = policyFor({ cwd: dir, runDir: dir }), cleanup = createMarker(policy, deadline);
      let result;
      try {
        result = spawnSync(file, [...pre, ...args], { cwd: dir, env: guardEnvironment(policy), input: '', encoding: 'utf8', windowsHide: true,
          timeout: timeLeft(deadline), maxBuffer: 16 * 1024 * 1024 });
      } finally { cleanup(); }
      // 查询的 JSON ERROR 也可能以 0 退出；纯文本的 version/models 不走这个分支。
      try {
        const body = JSON.parse(result.stdout);
        if (body.status === 'ERROR' && !result.error) result.error = new Error(body.error || body.status);
      } catch { /* 纯文本查询 */ }
      if (attempt || !/Eligibility check failed[\s\S]*EOF/i.test(`${result.stderr}\n${result.stdout}`) || Date.now() + 2000 >= deadline) return result;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  } finally { removeWorkDir(dir); }
}

function loadedHooks(text) {
  let body;
  try {
    body = strictJson(text);
  } catch { throw new Error(M.agyHooksListing); }
  // 实测 /hooks 的 response 仅供展示；完整名单和来源只认 command.data。
  if (body?.command?.name !== 'hooks' || !Array.isArray(body.command.data?.hooks)) throw new Error(M.agyHooksListing);
  const hooks = body.command.data.hooks;
  const others = hooks.filter((h) => typeof h?.name === 'string' && h.name !== 'foreman-guard').map((h) => h.name);
  if (others.length) throw new Error(M.agyOtherHooks(others.join(', ')));
  if (hooks.length !== 1) throw new Error(M.agyGuardInvalid);
  const hook = hooks[0];
  if (hook?.name !== 'foreman-guard' || hook.enabled !== true || typeof hook.source !== 'string' || !path.isAbsolute(hook.source)
    || !Array.isArray(hook.actions) || hook.actions.length !== 1) throw new Error(M.agyGuardInvalid);
  const key = (file) => { const real = fs.realpathSync.native(path.resolve(file)); return process.platform === 'win32' ? real.toLowerCase() : real; };
  try {
    if (key(hook.source) !== key(path.join(guardDir(), 'hooks.json'))) throw new Error(M.agyGuardInvalid);
  } catch { throw new Error(M.agyGuardInvalid); }
  const expected = { event: 'PreToolUse', matcher: '*', type: 'command', command: guardEntry().PreToolUse[0].hooks[0].command, timeout_seconds: 10 };
  if (!object(hook.actions[0]) || Object.entries(expected).some(([k, value]) => hook.actions[0][k] !== value)) throw new Error(M.agyGuardInvalid);
}
function checkGuardFiles(runDir) {
  const notes = [];
  const hooks = hooksFile();
  if (!hooks['foreman-guard']) throw new Error(M.agyGuardMissing(cmd()));
  const others = Object.keys(hooks).filter((name) => name !== 'foreman-guard');
  if (others.length) throw new Error(M.agyOtherHooks(others.join(', ')));
  if (!validEntry(hooks['foreman-guard'])) throw new Error(M.agyGuardInvalid);
  if (!matchingFiles()) {
    refuseActive('install', runDir);
    writeFiles();
    if (!matchingFiles()) throw new Error(M.agyGuardInvalid);
    notes.push(M.agyGuardRewritten);
  }
  return notes;
}
const guardSnapshot = () => HASH(Buffer.concat([fs.readFileSync(path.join(guardDir(), 'hooks.json')),
  ...[...guardFiles().keys()].map((file) => fs.readFileSync(path.join(guardDir(), file)))]));
export async function preflightAgy(policy, deadline) {
  timeLeft(deadline);
  const notes = scanProject(policy.root, policy.add_dirs);
  return locked(() => [...notes, ...checkGuardFiles(policy.run_dir)], deadline);
}
function globalMcpNotes() {
  const notes = [];
  const mcp = path.join(guardDir(), 'mcp_config.json');
  // 全局 MCP 只做提示（第 3.4 节）：agy 自己会留一个空文件，读不懂时也只提示、不拦派出。
  const text = fs.existsSync(mcp) ? fs.readFileSync(mcp, 'utf8') : '';
  if (text.trim()) {
    let data = null;
    try { data = JSON.parse(text); } catch { notes.push(M.agyGlobalMcp(mcp)); }
    const servers = Object.entries(data?.mcpServers || {}).filter(([, v]) => v?.disabled !== true && v?.enabled !== false).map(([k]) => k);
    if (servers.length) notes.push(M.agyGlobalMcp(servers.join(', ')));
  }
  return notes;
}
export async function prepareAgyRun(agent, policy, deadline) {
  timeLeft(deadline);
  const notes = scanProject(policy.root, policy.add_dirs);
  const { snapshot, cleanup } = await locked(() => {
    notes.push(...checkGuardFiles(policy.run_dir));
    return { snapshot: guardSnapshot(), cleanup: createMarker(policy, deadline) };
  }, deadline);
  try {
    // 第 3.4 节：网络查询不能占安装锁；回来再核对快照，防止查的期间配置被换掉。
    const result = queryAgy(agent, ['-p', '/hooks', '--output-format', 'json'], 60000, deadline);
    timeLeft(deadline);
    if (result.status !== 0 || result.error) throw new Error(M.agyQueryFailed('/hooks', result.error?.message || result.stderr));
    loadedHooks(result.stdout);
    await locked(() => {
      if (!matchingFiles() || guardSnapshot() !== snapshot) throw new Error(M.agyGuardInvalid);
    }, deadline);
    notes.push(...globalMcpNotes());
    timeLeft(deadline);
    return { notes, cleanup };
  } catch (e) { cleanup(); throw e; }
}

// 宿主对照和沙箱命令使用相同域名；两侧 DNS、HTTPS 都成功才足以排除普通断网。
export function networkControl(deadline) {
  const timeout = timeLeft(deadline, 5000);
  return new Promise((resolve) => {
    const result = { dns: false, https: false, error: null };
    const resolver = new dns.Resolver();
    let request, ended = false;
    const finish = (error) => {
      if (ended) return;
      ended = true; clearTimeout(timer);
      if (error) result.error = error.code || error.message;
      resolver.cancel();
      request?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ code: 'ETIMEDOUT' }), timeout);
    resolver.resolve4('example.com').then((addresses) => {
      if (ended) return;
      result.dns = true;
      // HTTPS 使用刚解析的地址，保留域名和 TLS 校验，不再发起无法取消的第二次 lookup。
      request = https.get('https://example.com', { lookup: (_host, options, callback) => options.all
        ? callback(null, addresses.map((address) => ({ address, family: 4 }))) : callback(null, addresses[0], 4) },
      (response) => { response.on('error', finish); response.resume(); result.https = true; finish(); });
      request.on('error', finish);
    }, finish);
  });
}

function sameVolume(a, b) {
  return pathKey(path.parse(fs.realpathSync(a)).root) === pathKey(path.parse(fs.realpathSync(b)).root) && fs.statSync(a).dev === fs.statSync(b).dev;
}
// 第 4 节：版本、系统版本和项目卷共同构成缓存身份，升级后重新测。
export async function probeSandbox({ agent, cwd, addDirs = [], version, run, force = false, deadline = Date.now() + 120000 }) {
  timeLeft(deadline);
  const cacheFile = path.join(foremanStateDir(), 'agy-sandbox.json');
  const key = JSON.stringify([version, process.platform, os.release(), path.parse(fs.realpathSync(cwd)).root, fs.statSync(cwd).dev]);
  if (addDirs.some((dir) => !sameVolume(cwd, dir))) return { key, available: false, results: { layout: 'cross_volume' }, at: new Date().toISOString() };
  const contains = (root, dir) => {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
    return !rel || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  // 第 4 节：canary 必须确实在边界外；主目录或临时目录被整个当作项目时不能借缓存放行 shell。
  if ([cwd, ...addDirs].some((root) => contains(root, foremanStateDir()) || contains(root, os.homedir()))
    || contains(os.tmpdir(), foremanStateDir())) return { key, available: false, results: { layout: 'unavailable' }, at: new Date().toISOString() };
  // 按缓存键分条存：不同磁盘上的项目交替派出时，不会互相冲掉对方的结论、每次重测。
  const readStore = () => {
    try { const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); return object(data.entries) ? data : { entries: {} }; }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; return { entries: {} }; }
  };
  // 缓存写不进去时一般只是少省一次探针；但留下的旧结论是"可用"、而这次要撤销它时，不能让下一轮继续借它放行命令。
  const keepNoStalePositive = (e) => {
    if (readStore().entries[key]?.available === true) throw new Error(M.agyCacheStale(cacheFile, e.message));
  };
  let cache;
  if (force) {
    try { await locked(() => {
      const store = readStore();
      if (store.entries[key]) {
        delete store.entries[key];
        atomic(cacheFile, JSON.stringify(store, null, 2) + '\n');
      }
    }, deadline); }
    catch (e) { if (e.code === 'ETIMEDOUT') throw e; keepNoStalePositive(e); }
  }
  else cache = readStore().entries[key];
  // 旧缓存没有宿主网络对照，不能继续用来证明沙箱禁网。
  if (cache?.results?.network_control && !(cache.available === false && Date.parse(cache.at) < Date.now() - 86400000)) return cache;
  const before = await networkControl(deadline);
  timeLeft(deadline);
  if (!before.dns || !before.https) return { key, available: false,
    results: { network: 'host_offline', network_control: { before } }, at: new Date().toISOString(), tested: true };
  const nonce = randomUUID(), dir = fs.mkdtempSync(path.join(foremanStateDir(), 'agy-probe-'));
  const inside = path.join(cwd, `.foreman-agy-probe-${nonce}`), outside = path.join(dir, 'outside'), home = path.join(os.homedir(), `.foreman-agy-probe-${nonce}`);
  const prefix = `FOREMAN_AGY_PROBE:${nonce}:`, canary = `foreman ${nonce}`;
  const tasks = { write_project: `fs.writeFileSync(${JSON.stringify(inside)}, 'changed')`, write_outside: `fs.writeFileSync(${JSON.stringify(outside)}, 'changed')`,
    read_home: `fs.readFileSync(${JSON.stringify(home)}, 'utf8')` };
  const commands = Object.entries(tasks).map(([name, op]) => {
    const code = `const fs=require('node:fs');let value;try{${op};value='allowed'}catch(e){value=['EACCES','EPERM'].includes(e.code)?'sandbox_denied':'error:'+e.code}console.log(${JSON.stringify(prefix)}+JSON.stringify({name:${JSON.stringify(name)},value}))`;
    return probeCommand(code);
  });
  commands.push(probeCommand(`require('node:https').get('https://example.com',r=>{r.resume();console.log(${JSON.stringify(prefix)}+JSON.stringify({name:'network',value:'allowed'}))}).on('error',e=>console.log(${JSON.stringify(prefix)}+JSON.stringify({name:'network',value:'error:'+e.code}))).setTimeout(5000,function(){this.destroy(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'}))})`));
  commands.push(probeCommand(`console.log(${JSON.stringify(prefix)}+JSON.stringify({name:'environment',value:!!process.env.FOREMAN_AGY_GUARD}))`));
  try {
    // 项目目录不可写（只读挂载、ACL）时放不了探针文件：按沙箱没确认处理，不给 shell、不写缓存，讨论照常走只读文件。
    try { for (const file of [inside, outside, home]) fs.writeFileSync(file, canary, { flag: 'wx' }); }
    catch (e) { return { key, available: false, results: { canary: `error:${e.code || e.message}` }, at: new Date().toISOString(), tested: true }; }
    const out = await run({ access: 'probe', runDir: dir, sandbox: true, probeCommands: commands,
      prompt: M.agyProbePrompt(commands), timeoutMs: timeLeft(deadline, 120000), deadline });
    timeLeft(deadline);
    const after = await networkControl(deadline);
    timeLeft(deadline);
    const results = {};
    for (const item of out.tools || []) {
      // stream-json 会把 CommandLine 截到约 512 个字符，不能按命令原文匹配；守卫只放行这几条原样的命令，
      // 输出里带本次随机 nonce 的前缀就足以说明出自哪条探针。
      if (item.tool !== 'run_command' || item.error) continue;
      for (const line of item.output.split(/\r?\n/)) if (line.startsWith(prefix)) {
        const data = JSON.parse(line.slice(prefix.length));
        results[data.name] = data.value;
      }
    }
    const networkError = results.network;
    results.network_control = { before, after };
    if (/^error:(EPERM|EACCES)$/.test(networkError)) results.network = 'sandbox_denied';
    else if (/^error:(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)$/.test(networkError)) {
      results.network = [before, after].every((c) => c.dns && c.https) ? 'sandbox_denied' : 'unconfirmed';
    }
    // 超时、连接被重置这类说不清是沙箱慢还是网络抖动的错误：这次不给 shell，也不写缓存，下次重测。
    else if (networkError?.startsWith('error:')) results.network = 'unconfirmed';
    if (networkError) results.network_error = networkError;
    const unchanged = [inside, outside, home].every((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8') === canary);
    // environment 只记录环境变量可见性，不参与可用判定；完整探针仍要求它返回。
    cache = { key, available: out.status === 'done' && unchanged && ['write_project', 'write_outside', 'read_home', 'network'].every((n) => results[n] === 'sandbox_denied'),
      results, at: new Date().toISOString() };
    // 探针这一轮没跑完（断流、钩子出错、模型没照做）时结论不可靠：这次按没有沙箱处理，但不写缓存，下次再测。
    const complete = out.status === 'done' && ['write_project', 'write_outside', 'read_home', 'network', 'environment'].every((n) => n in results);
    if (results.network !== 'unconfirmed' && (complete || !unchanged)) {
      // 缓存只是省下一次探针；锁忙不影响本次结论，但总时限仍要生效。
      try { await locked(() => {
        const store = readStore();
        store.entries[key] = cache;
        atomic(cacheFile, JSON.stringify(store, null, 2) + '\n');
      }, deadline); }
      catch (e) { if (e.code === 'ETIMEDOUT') throw e; if (!cache.available) keepNoStalePositive(e); }
    }
    return { ...cache, tested: true };
  } finally {
    for (const file of [inside, home]) fs.rmSync(file, { force: true });
    removeWorkDir(dir);
  }
}
function probeCommand(code) {
  const encoded = Buffer.from(code).toString('base64');
  // agy 在 Windows 上用 PowerShell 跑 run_command，带引号的程序路径要用 & 调用，否则是语法错误。
  return `${process.platform === 'win32' ? '& ' : ''}"${process.execPath}" -e "eval(Buffer.from('${encoded}','base64').toString())"`;
}
