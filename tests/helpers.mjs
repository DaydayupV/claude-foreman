import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
export { MESSAGES } from '../foreman/skills/dispatch/scripts/messages.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE = path.join(ROOT, 'foreman/skills/dispatch/scripts/cli.mjs');
export const CODEX = path.join(ROOT, 'tests/fake/codex.mjs');
export const OPENCODE = path.join(ROOT, 'tests/fake/opencode.mjs');
export const PI = path.join(ROOT, 'tests/fake/pi.mjs');
export const read = (file) => fs.readFileSync(file, 'utf8');
export const json = (file) => JSON.parse(read(file));
// 活动日志可能刚写了一部分，只读取以换行结束的完整记录。
export const lines = (file) => fs.existsSync(file) ? read(file).split('\n').slice(0, -1).filter(Boolean).map(JSON.parse) : [];
export function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
  return file;
}

export async function poll(check, description, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await pause(25);
  } while (Date.now() < deadline);
  assert.fail(`等待超时：${description}`);
}

const gitName = process.platform === 'win32' ? 'git.exe' : 'git';
const git = (process.env.PATH || '').split(path.delimiter)
  .map((dir) => path.join(dir.replace(/^"|"$/g, ''), gitName)).find(fs.existsSync);
assert.ok(git, '测试需要已有的 Git');

export const baseConfig = () => ({
  dispatch: { watch: 'off', timeout_min: 1, stall_min: 0, busy_ask_min: 0 },
  agents: { codex: { type: 'codex cli', bin: CODEX, model: 'fake-codex', max_parallel: 4 } },
  modules: {
    run: { simple: 'claude code', normal: 'claude code', complex: [{ agent: 'codex', effort: 'max' }] },
    review: { simple: [{ agent: 'codex', effort: 'medium' }], normal: [{ agent: 'codex', effort: 'high' }], complex: [{ agent: 'codex', effort: 'max' }] },
    discuss: { simple: [{ agent: 'codex', effort: 'medium' }], normal: [{ agent: 'codex', effort: 'high' }], complex: [{ agent: 'codex', effort: 'max' }] },
    image: { generate: null, draw: null },
  },
});

export const apiAgent = (url) => ({
  type: 'api', base_url: url, api_key: 'synthetic-test-key', model: 'fake-api',
});
export const opencodeAgent = () => ({ type: 'opencode cli', bin: OPENCODE, model: 'fake/model' });
export const piAgent = () => ({ type: 'pi cli', bin: PI, model: 'fake/model' });

export function sandbox(t, { config = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-test-'));
  const cwd = path.join(home, 'project');
  const userConfig = path.join(home, '.claude/foreman/config.json');
  const runs = path.join(home, '.claude/foreman/runs');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.codex'));
  // 只继承系统启动所需变量，PATH 不带 npm、真实 CLI 或用户脚本目录。
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    PATH: [path.dirname(git), process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin:/bin'].join(path.delimiter),
    USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), APPDATA: home,
    LOCALAPPDATA: home, TMP: home, TEMP: home, TMPDIR: home,
    FOREMAN_LANG: 'zh', TZ: 'UTC', CLAUDE_CODE_SESSION_ID: 'test-session', NO_COLOR: '1', TERM: 'dumb',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_TERMINAL_PROMPT: '0',
  });
  const active = new Set();
  const stop = (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { env, windowsHide: true });
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  };
  const start = (script, args = [], options = {}) => {
    const child = spawn(process.execPath, [script, ...args.map(String)], {
      cwd: options.cwd || cwd, env: { ...env, ...options.env }, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s; });
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
    child.stdin.on('error', () => {});
    let expired = false;
    const timer = setTimeout(() => { expired = true; stop(child); }, options.timeout || 20000);
    const done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        active.delete(handle);
        if (expired) reject(new Error(`子进程超时：${args.join(' ')}\n${stderr}`));
        else resolve({ code, signal, stdout, stderr });
      });
    });
    const handle = { child, done, stop: () => stop(child), get stdout() { return stdout; }, get stderr() { return stderr; } };
    active.add(handle);
    done.catch(() => {});
    child.stdin.end(options.input ?? '合成测试任务');
    return handle;
  };
  const h = {
    home, cwd, userConfig, runs, env, start,
    config(value = baseConfig()) { write(userConfig, value); return value; },
    write(rel, value) { return write(path.join(cwd, rel), value); },
    startBridge(args, options) { return start(BRIDGE, args, options); },
    bridge(args, options) { return start(BRIDGE, args, options).done; },
    hook(name, input = { cwd }, options = {}) {
      return start(path.join(ROOT, 'foreman/hooks', name), [], { ...options, input: JSON.stringify(input) }).done;
    },
    scenario(value = {}, name = 'scenario') {
      const file = path.join(home, `${name}.json`), capture = path.join(home, `${name}.calls.jsonl`);
      write(file, { capture, ...value });
      return { file, capture, env: { FAKE_SCENARIO: file }, calls: () => lines(capture) };
    },
    git(args) {
      const r = spawnSync(git, args, { cwd, env, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, r.stderr || r.error?.message);
      return r.stdout.trim();
    },
    initGit() {
      h.git(['init', '--quiet']);
      h.git(['config', 'user.name', 'Synthetic Test']);
      h.git(['config', 'user.email', 'test@example.invalid']);
      h.git(['config', 'core.autocrlf', 'false']);
      h.write('source.txt', 'before\n');
      h.git(['add', '.']);
      h.git(['commit', '--quiet', '-m', 'synthetic baseline']);
      return h.git(['rev-parse', 'HEAD']);
    },
    records() {
      if (!fs.existsSync(h.runs)) return [];
      return fs.readdirSync(h.runs).flatMap((id) => {
        const file = path.join(h.runs, id, 'meta.json');
        if (!fs.existsSync(file)) return [];
        try { return [json(file)]; } catch (e) { if (e instanceof SyntaxError) return []; throw e; }
      });
    },
    async running(predicate = () => true) {
      return poll(() => h.records().find((m) => m.status === 'running' && predicate(m)), '任务登记');
    },
    events(id) { return lines(path.join(h.runs, id, 'events.jsonl')); },
    result(id) { return json(path.join(h.runs, id, 'result.json')); },
  };
  const scenario = h.scenario();
  env.FAKE_SCENARIO = scenario.file;
  h.calls = scenario.calls;
  if (config) h.config();
  t.after(async () => {
    const children = [...active];
    for (const handle of children) handle.stop();
    await Promise.allSettled(children.map((handle) => handle.done));
    assert.equal(path.dirname(home), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('foreman-test-'));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  });
  return h;
}

export function output(r, code = 0) {
  assert.equal(r.code, code, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
export function failed(r, message) {
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(message), r.stderr);
  assert.equal(r.stdout, '');
}
export function normalize(text, replacements = {}) {
  let result = text.replace(/\r\n/g, '\n').replaceAll('\\', '/');
  for (const [from, to] of Object.entries(replacements).sort(([a], [b]) => b.length - a.length)) {
    result = result.replaceAll(from.replaceAll('\\', '/'), to);
  }
  return result;
}
export function expected(name, actual, replacements = {}) {
  assert.equal(normalize(actual, replacements), read(path.join(ROOT, 'tests/expected', name)).replace(/\r\n/g, '\n'));
}
export const taskArgs = (h, mode = 'run', extra = []) => [mode, '--cwd', h.cwd, '--level', 'complex', '--brief', '-', ...extra];

export function seedRun(h, id, meta = {}, result = null, events = []) {
  const dir = path.join(h.runs, id);
  const start = new Date(Date.now() - 60000).toISOString();
  write(path.join(dir, 'meta.json'), {
    id, mode: 'run', kind: 'exec', cwd: h.cwd, title: '合成任务', agent: 'codex', agent_type: 'codex cli',
    model: 'fake-codex', level: 'complex', effort: 'high', status: 'done', pid: 0,
    group: null, track: [], scope: [], parent: null, session_id: 'synthetic-session',
    started_at: start, ended_at: start, claude_session: 'test-session', ...meta,
  });
  if (result) write(path.join(dir, 'result.json'), result);
  write(path.join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}
