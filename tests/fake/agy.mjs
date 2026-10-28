import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setup, replay, finish } from './common.mjs';
import { discussion, review } from '../fixtures/reports.mjs';

const args = process.argv.slice(2), value = (key) => args[args.indexOf(key) + 1];
let policy;
try { policy = JSON.parse(process.env.FOREMAN_AGY_GUARD); } catch { /* 测丢失策略 */ }
const operation = args.includes('--version') ? 'version' : args[0] === 'models' ? 'catalog'
  : args.includes('/hooks') ? 'hooks' : args.includes('/quota') ? 'quota' : policy?.access === 'probe' ? 'probe' : 'run';
const { scenario: s, input } = await setup('agy', operation, args);
const sid = s.conversation_id || (args.includes('--conversation') ? value('--conversation') : 'synthetic-agy-session');
const emit = (event, body) => console.log(JSON.stringify({ event, ...(event === 'init' ? { conversation_id: sid } : {}), [event]: body }));
if (s.guard_file) fs.appendFileSync(s.guard_file, JSON.stringify({ operation, policy, sandbox: args.includes('--sandbox'),
  env: Object.fromEntries(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK'].map((k) => [k, process.env[k] ?? null])) }) + '\n');
await replay([{ files: s[`${operation}_ready`] ? { [s[`${operation}_ready`]]: 'ready' } : undefined },
  { delay_ms: s[`${operation}_delay_ms`], wait_for: s[`${operation}_wait_for`] }]);
const globalDir = path.join(os.homedir(), '.gemini', 'config');
const parse = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
function projectHooks() {
  const hooks = [], seen = new Set();
  for (const start of [process.cwd(), ...args.flatMap((a, i) => a === '--add-dir' ? [args[i + 1]] : [])]) {
    for (let dir = start; !seen.has(dir); dir = path.dirname(dir)) {
      seen.add(dir);
      for (const name of fs.readdirSync(dir).filter((n) => ['.agents', '.agent', '_agents', '_agent'].includes(n.toLowerCase()))) {
        const root = path.join(dir, name);
        for (const file of fs.readdirSync(root).filter((n) => n.toLowerCase() === 'hooks.json')) hooks.push({ dir: root, hooks: parse(path.join(root, file)) });
        const plugins = path.join(root, 'plugins');
        if (fs.existsSync(plugins)) for (const p of fs.readdirSync(plugins)) {
          const folder = path.join(plugins, p);
          hooks.push({ dir: folder, hooks: parse(path.join(folder, 'hooks.json')) });
        }
      }
      if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) break;
    }
  }
  return hooks;
}
const sources = () => [...projectHooks(), { dir: globalDir, hooks: parse(path.join(globalDir, 'hooks.json')) },
  { dir: path.join(globalDir, 'plugins/synthetic'), hooks: s.plugin_hooks || {} }];
function listedHooks() {
  return sources().flatMap(({ dir, hooks }) => Object.entries(hooks).map(([name, def]) => ({ name, enabled: def.enabled !== false,
    source: path.join(dir, 'hooks.json'), actions: Object.entries(def).filter(([event]) => event !== 'enabled').flatMap(([event, groups]) =>
      groups.flatMap((group) => (group.hooks || [group]).map((hook) => ({ event, ...(group.matcher === undefined ? {} : { matcher: group.matcher }),
        type: hook.type || 'command', command: hook.command, timeout_seconds: hook.timeout ?? 30 })))) })));
}
function callHooks(tool, toolArgs) {
  if (s.skip_hooks) return { decision: 'allow' };
  const env = { ...process.env };
  if (s.drop_guard_env) delete env.FOREMAN_AGY_GUARD;
  for (const source of sources()) for (const def of Object.values(source.hooks)) {
    if (def.enabled === false) continue;
    for (const group of def.PreToolUse || []) {
      if (group.matcher && group.matcher !== '*' && !new RegExp(`^(?:${group.matcher})$`).test(tool)) continue;
      for (const hook of group.hooks) {
        // 真正执行安装到临时 HOME 的启动器，不能在假工具里重写守卫判断。
        const r = spawnSync(process.platform === 'win32' ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh',
          process.platform === 'win32' ? ['/d', '/s', '/c', hook.command] : ['-c', hook.command], {
            // Claude Code 给子进程设了 NoDefaultCurrentDirectoryInExePath，真实 agy 运行钩子时也带着它。
            cwd: source.dir, env: { ...env, NoDefaultCurrentDirectoryInExePath: '1' }, encoding: 'utf8', input: JSON.stringify({ toolCall: { name: tool, args: toolArgs },
              workspacePaths: [process.cwd().replaceAll('\\', '/')], stepIdx: step, conversationId: sid, modelName: value('--model'),
              artifactDirectoryPath: path.join(os.homedir(), '.gemini/antigravity-cli/brain', sid), transcriptPath: path.join(os.homedir(), 'synthetic-transcript.jsonl'), lastUserInput: input }),
            timeout: (hook.timeout || 30) * 1000, windowsHide: true });
        let result;
        try { result = JSON.parse(r.stdout); } catch { result = { decision: 'deny', reason: 'invalid hook response' }; }
        if (r.status !== 0 || r.error) return { decision: 'deny', reason: 'hook failed' };
        if (result.decision === 'deny' || !['allow', 'ask'].includes(result.decision)) return result;
      }
    }
  }
  return { decision: 'allow' };
}
let step = 0;
function probeOutput(command) {
  const encoded = /Buffer\.from\('([^']+)'/.exec(command)?.[1];
  const code = encoded ? Buffer.from(encoded, 'base64').toString() : '';
  const prefix = /FOREMAN_AGY_PROBE:[^"']+:/g.exec(code)?.[0];
  const name = /name:["']([^"']+)["']/.exec(code)?.[1];
  if (!prefix || !name) throw new Error('假 agy 无法解析探针命令');
  const result = name === 'environment' ? s.env_visible !== false
    : s.probe_errors?.[name] || (s.sandbox === false ? 'allowed' : name === 'network' ? 'error:EPERM' : 'sandbox_denied');
  return prefix + JSON.stringify({ name, value: result });
}
async function toolCall(name, toolArgs = {}, options = {}) {
  const idx = ++step;
  const shown = name === 'run_command' ? { ...toolArgs, CommandLine: toolArgs.CommandLine.slice(0, 512) } : toolArgs;
  emit('step_update', { conversation_id: sid, step_index: idx, step_type: 'tool', state: 'ACTIVE', tool_name: name, tool_info: { name, parameters: shown } });
  await replay(options.before || []);
  const decision = callHooks(name, toolArgs);
  let output = options.output || '', error = null, contents;
  if (decision.decision === 'deny') error = `tool call denied by pre-tool hook: ${decision.reason}`;
  else {
    try {
      if (name === 'read_file' || name === 'view_file') {
        contents = fs.readFileSync(/^file:\/\//.test(toolArgs.Path) ? new URL(toolArgs.Path) : toolArgs.Path, 'utf8');
        output = `${contents.split('\n').length - Number(contents.endsWith('\n'))} lines, ${Buffer.byteLength(contents)} bytes`;
      }
      if (name === 'write_file') { fs.mkdirSync(path.dirname(toolArgs.Path), { recursive: true }); fs.writeFileSync(toolArgs.Path, toolArgs.Content); }
      if (name === 'edit_file') fs.writeFileSync(toolArgs.Path, fs.readFileSync(toolArgs.Path, 'utf8').replaceAll(toolArgs.Target, toolArgs.Replacement));
      if (operation === 'probe' && name === 'run_command') output = probeOutput(toolArgs.CommandLine);
      for (const [file, content] of Object.entries(options.files || {})) fs.writeFileSync(path.resolve(file), content);
    } catch (e) { error = e.message; }
  }
  if (!error && name === 'run_command') output = `Command exited with code ${options.exit_code ?? 0}.\n\nCommand output:\n${output}\r\n`;
  const parameters = name === 'run_command' ? { CommandLine: shown.CommandLine } : shown;
  emit('step_update', { conversation_id: sid, step_index: idx, step_type: 'tool', state: error ? 'ERROR' : 'DONE', tool_name: name,
    tool_info: { name, parameters, ...(error ? { error: { type: 'TOOL_ERROR', message: error } } : { output }) } });
  return { contents, error };
}
const pending = new Map();
async function scripted(entry) {
  const body = entry.event?.event === 'step_update' ? entry.event.step_update : null;
  if (body?.step_type !== 'tool') return replay([entry]);
  step = Math.max(step, body.step_index);
  if (body.state === 'ACTIVE') {
    await replay([entry]);
    pending.set(body.step_index, callHooks(body.tool_name, body.tool_info?.parameters || {}));
    return;
  }
  const decision = pending.get(body.step_index) || callHooks(body.tool_name, body.tool_info?.parameters || {});
  pending.delete(body.step_index);
  if (decision.decision !== 'deny') return replay([entry]);
  const event = structuredClone(entry.event);
  event.step_update.state = 'ERROR';
  event.step_update.tool_info.error = { type: 'TOOL_ERROR', message: `tool call denied by pre-tool hook: ${decision.reason}` };
  delete event.step_update.tool_info.output;
  return replay([{ ...entry, event, files: undefined }]);
}
if (s.eligibility_error) {
  const error = 'Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF';
  const body = { conversation_id: '', status: 'ERROR', response: '', error };
  if (['run', 'probe'].includes(operation)) emit('result', body); else console.log(JSON.stringify(body));
  process.stderr.write(`Error: ${error}\n`); process.exitCode = s.exit_code ?? 0;
} else if (operation === 'version') console.log(s.version || '1.4.8');
else if (operation === 'catalog') {
  console.log('Fetching available models...');
  for (const m of s.agy_catalog || ['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low',
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'].map((id) => ({ id, name: id }))) console.log(`${m.id}\t${m.name}`);
} else if (operation === 'hooks') {
  const hooks = listedHooks();
  console.log(s.hooks_output ?? JSON.stringify({ conversation_id: '', status: 'SUCCESS', duration_seconds: 0, num_turns: 0, usage: {},
    response: hooks.flatMap((hook) => hook.actions.map((a) => [hook.name, hook.enabled ? 'enabled' : 'disabled', a.event, a.matcher || '', a.type, a.command].join('\t'))).join('\n') + '\n',
    command: { name: 'hooks', data: { hooks } } }));
} else if (operation === 'quota') console.log(JSON.stringify(s.quota || { conversation_id: '', status: 'SUCCESS', response: 'Gemini\tweekly\t90%\n',
  command: { name: 'usage', data: { groups: [{ name: 'Gemini', buckets: [
    { name: 'Gemini', window: 'weekly', remaining_fraction: 0.9, reset_time: '2026-11-02T00:00:00Z' },
    { name: 'Gemini', window: '5h', remaining_fraction: 0.8, reset_time: '2026-10-28T10:00:00Z' } ] }] } } }));
else {
  if (s.invalid_model) {
    emit('result', { conversation_id: sid, status: 'ERROR', error: 'invalid model: synthetic-model', response: '' });
    process.stderr.write('error: invalid model\n'); process.exitCode = 1;
  } else {
    if (!s.no_init) emit('init', { model: value('--model'), cwd: process.cwd(), tools: [], permission_mode: 'always-proceed' });
    if (args.includes('--log-file')) fs.appendFileSync(value('--log-file'), s.sandbox_log ?? (args.includes('--sandbox') && s.sandbox !== false
      ? 'Print mode: enabling terminal sandbox for this session\n' : ''));
    const prompt = JSON.parse(input.trim()).message.content;
    let checkReply;
    if (operation === 'probe') for (const command of policy.probe_commands) await toolCall('run_command', { CommandLine: command });
    else {
      const checkPrefix = 'Use read_file to read this file and reply with its exact contents only, nothing else: ';
      if (prompt.startsWith(checkPrefix) && !s.no_check_tool) {
        const checked = await toolCall(s.check_tool || 'read_file', { Path: prompt.slice(checkPrefix.length) });
        checkReply = checked.error ? 'check read failed' : s.check_whitespace ? checked.contents.split('').join(' \n') : checked.contents;
      }
      for (const entry of s.steps || []) {
        if (entry.tool) await toolCall(entry.tool.name, entry.tool.args, entry);
        else await scripted(entry);
      }
    }
    if ((operation === 'probe' || !s.hold) && (operation === 'probe' || !s.no_reply)) {
      const report = s.last_message ?? checkReply ?? (operation === 'probe' ? 'OK'
        : prompt.includes('"verdict"') ? review : discussion);
      const text = typeof report === 'string' ? report : JSON.stringify(report);
      const idx = ++step;
      emit('step_update', { conversation_id: sid, step_index: idx, step_type: 'agent_response', state: 'ACTIVE', text_delta: text });
      if (!s.no_completed) emit('step_update', { conversation_id: sid, step_index: idx, step_type: 'agent_response', state: 'DONE', text_delta: '\n',
        usage: s.agy_usage || { input_tokens: 10, cache_read_tokens: 3, output_tokens: 5, thinking_tokens: 2 } });
      if (!s.no_result) emit('result', { conversation_id: sid, status: s.result_status || 'SUCCESS', error: s.result_error,
        response: text ? text + '\n' : '', denied_actions: s.denied_actions || [], usage: s.result_usage || { input_tokens: 9999 } });
    }
    await finish(operation === 'probe' ? { ...s, hold: false } : s);
  }
}
