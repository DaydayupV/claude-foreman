// foreman 1.2.0 的 agy 守卫；正文 sha256: 45f5c1e1e85519f005b92f6ce2235208df19cb8996a1a3cf28da24e58c923328
// 只依赖 Node 内置模块，复制到用户目录后仍可独立运行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// read_file 实测会带 StartLine / EndLine 只读一段；agy 1.4.9 起有时还带 ByteOffset（从第几个字节读起）。
const READ_KEYS = ['Path', 'StartLine', 'EndLine', 'ByteOffset'];
const KEYS = { read_file: READ_KEYS, view_file: READ_KEYS, edit_file: ['Path', 'Target', 'Replacement'],
  write_file: ['Path', 'Content', 'Overwrite'], run_command: ['CommandLine', 'WaitMsBeforeAsync', 'toolSummary'] };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const deny = (reason) => ({ decision: 'deny', reason: `foreman guard: ${reason}` });
let matchedMarkers = [];

// 和 pi 一样展开符号链接、junction，以及尚不存在的最后几层路径。
function realPath(p) {
  const rest = [];
  for (let current = p; ; current = path.dirname(current)) {
    try { return path.join(fs.realpathSync.native(current), ...rest.reverse()); } catch {
      if (path.dirname(current) === current) return p;
      rest.push(path.basename(current));
    }
  }
}
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
function agyPath(value) {
  if (typeof value !== 'string' || !value) throw new Error('Path must be an absolute path');
  let p = value;
  // 第 4 节 / 0b-12：不接受 @、~、相对路径和 /c/ 等 shell 写法。
  if (/^file:\/\//i.test(p)) {
    if (!/^file:\/\/\//i.test(p)) throw new Error('Path must use file:///');
    p = fileURLToPath(p);
    if (!path.isAbsolute(p)) throw new Error('Path must be an absolute path');
  } else if (process.platform === 'win32' ? !/^[a-z]:[\\/]/i.test(p) && !/^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(p) : !p.startsWith('/')) {
    throw new Error('Path must be an absolute path');
  }
  // 第 4 节：设备路径、NT 命名空间和备用数据流不是文件路径白名单的一部分。
  if (p.includes('\0') || process.platform === 'win32' && (/^(?:\\\\|\/\/)[?.][\\/]/.test(p) || p.slice(2).includes(':'))) throw new Error('unsupported Path');
  return realPath(path.resolve(p));
}
function activeMarkers() {
  const dir = path.join(os.homedir(), '.claude', 'foreman', 'agy-markers');
  if (!fs.existsSync(dir)) return [];
  const active = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const full = path.join(dir, file), marker = JSON.parse(fs.readFileSync(full, 'utf8'));
    // 第 3.2 节：强制结束后不必等最长时限；EPERM 仍按进程活着处理。
    if (marker.pid) try { process.kill(marker.pid, 0); } catch (e) {
      if (e.code === 'ESRCH') { try { fs.rmSync(full, { force: true }); } catch { /* 清理不影响判断 */ } continue; }
    }
    if (Date.parse(marker.expires_at) > Date.now()) active.push(marker);
  }
  return active;
}
function decide(input, policy) {
  if (!policy) {
    const markers = activeMarkers();
    // 第 3.2 节：缺工作目录时不能用 ask 放过可能丢了策略的 foreman 进程。
    if (!Array.isArray(input.workspacePaths) || !input.workspacePaths.length || !input.workspacePaths.every((p) => typeof p === 'string' && p.trim())) {
      matchedMarkers = markers;
      return markers.length ? deny('a foreman run is active and this call has no workspace, so tools are blocked until it ends') : { decision: 'ask' };
    }
    const workspaces = input.workspacePaths.map((p) => realPath(path.resolve(p)));
    matchedMarkers = markers.filter((marker) => (marker.workspaces || [marker.cwd]).some((p) =>
      workspaces.some((w) => inside(realPath(p), w) || inside(w, realPath(p)))));
    const marker = matchedMarkers[0];
    // 第 3.2 节：丢失环境变量时，跳过权限不能把 ask 变成放行。
    return marker ? deny(`a foreman run in this folder has no policy (marker expires ${marker.expires_at}), so tools are blocked until it ends`) : { decision: 'ask' };
  }
  // 第 3.2 节：第一期只开放 none、read 和安装器专用的 probe 策略。
  if (!object(policy) || !['none', 'read', 'probe'].includes(policy.access) || !path.isAbsolute(policy.root || '')
    || !fs.statSync(policy.root).isDirectory() || !Array.isArray(policy.add_dirs)
    || !policy.add_dirs.every((p) => typeof p === 'string' && path.isAbsolute(p) && fs.statSync(p).isDirectory())
    || !path.isAbsolute(policy.run_dir || '') || !path.isAbsolute(policy.log_file || '') || !policy.nonce) return deny('invalid policy for this run');
  const tool = input.toolCall?.name, args = input.toolCall?.args;
  // 第 4 节：任务清单不执行命令，也不读写项目文件。
  if (tool === 'manage_task') return { decision: 'allow' };
  if (KEYS[tool]) {
    if (!object(args)) return deny('tool arguments must be an object');
    // 第 4 节：升级后出现新参数时，先拒绝再人工核对。
    const extra = Object.keys(args).find((k) => !KEYS[tool].includes(k));
    if (extra) return deny(`unexpected argument ${extra} for ${tool}`);
  }
  // 第 4 节：none 用于报告修复，只保留上面的任务清单例外。
  if (policy.access === 'none') return deny(`${tool} is not allowed in this run`);
  // 第 4 节：写工具留给第二期；子 agent、MCP、浏览器、联网、提问和未知工具均不放行。
  if (!['read_file', 'view_file', 'run_command'].includes(tool)) return deny(tool === 'ask_question'
    ? 'ask_question is not allowed in this run; put questions in the report' : `${tool} is not allowed in this run`);
  if (tool === 'run_command') {
    if (typeof args.CommandLine !== 'string' || !args.CommandLine.trim()) return deny('CommandLine must be a command string');
    // agy 在 Windows 上用 PowerShell 跑命令，输出按系统代码页编码；里面有中文路径时 agy 会把非 UTF-8 的字节
    // 原样发给模型接口，整轮报 400。放行时在命令前面把输出编码设成 UTF-8（第 12 节）。
    const allow = process.platform === 'win32'
      ? { decision: 'allow', overwrite: { CommandLine: `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${args.CommandLine}` } }
      : { decision: 'allow' };
    // 第 4 节：probe 仅放行 foreman 创建的精确命令，不能供模型任意执行。
    if (policy.access === 'probe') return policy.probe_commands?.includes(args.CommandLine) && policy.sandbox === true
      ? allow : deny('run_command is not allowed in this probe');
    // 第 4 节：探针成功、本次明确加 --sandbox、日志也确认启用，才允许只读 shell。
    if (policy.sandbox !== true || policy.sandbox_available !== true) return deny('run_command is not allowed in this run');
    const log = fs.readFileSync(policy.log_file, 'utf8');
    if (!/enabling terminal sandbox/i.test(log) || /(?:disabl\w*|unavailable|unsupported|fall\w*\s*back|fallback|not enabled|permission prompt).{0,80}sandbox|sandbox.{0,80}(?:disabl\w*|unavailable|unsupported|fall\w*\s*back|fallback|ask|prompt)/i.test(log)) return deny('terminal sandbox is not confirmed for this run');
    return allow;
  }
  const target = agyPath(args.Path);
  // 第 4 节：真实路径比较堵住符号链接和 junction 越界，add-dir 只扩展读取范围。
  if (![policy.root, ...policy.add_dirs].some((p) => inside(realPath(p), target))) return deny(`${args.Path} is outside the project directory`);
  return { decision: 'allow' };
}

let input = {}, policy = null, result;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (Object.hasOwn(process.env, 'FOREMAN_AGY_GUARD')) policy = JSON.parse(process.env.FOREMAN_AGY_GUARD);
  if (Object.hasOwn(process.env, 'FOREMAN_AGY_GUARD') && !policy) throw new Error('invalid policy for this run');
  result = decide(input, policy);
} catch (e) {
  // 第 3.1 / 3.2 节：读不到策略、标记或工具输入时不猜测放行。
  result = deny(e.message);
}
// 命中启动标记的拒绝来自别的 agy 进程，记到单独的文件里，不能算作这次运行的守卫生效证据（第 3.2 节）。
const recordFile = policy ? 'agy-guard.jsonl' : 'agy-guard-stray.jsonl';
for (const recordDir of new Set(policy ? [policy.run_dir] : matchedMarkers.map((m) => m.run_dir))) {
  if (!recordDir || !path.isAbsolute(recordDir) || !['allow', 'deny'].includes(result.decision)) continue;
  try { fs.appendFileSync(path.join(recordDir, recordFile), JSON.stringify({ t: new Date().toISOString(), tool: input.toolCall?.name ?? null,
    decision: result.decision, reason: result.reason ?? null }) + '\n'); }
  // 第 3.2 节：写不出决定记录时不能执行工具。
  catch { result = deny('cannot record the guard decision'); }
}
process.stdout.write(JSON.stringify(result) + '\n');
