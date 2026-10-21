import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { spawn } from 'node:child_process';

// 剧本里内容写成 null 表示删掉这个文件。
export function write(file, content) {
  if (content === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
export async function setup(tool, operation, args) {
  const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const records = fs.existsSync(script.capture) ? fs.readFileSync(script.capture, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const index = records.filter((r) => r.tool === tool && r.operation === operation).length;
  const selected = script.calls?.[index] || {};
  const scenario = { ...script, ...selected };
  const record = { tool, operation, args, stdin: input, cwd: process.cwd(), pid: process.pid,
    env: Object.fromEntries(['OPENCODE_CONFIG_CONTENT', 'PWD', 'HOME', 'USERPROFILE', 'CODEX_HOME', 'APPDATA'].map((key) => [key, process.env[key] ?? null])) };
  fs.appendFileSync(script.capture, JSON.stringify(record) + '\n');
  return { scenario, input, index };
}
export async function replay(steps = [], cwd = process.cwd()) {
  for (const step of steps) {
    if (step.delay_ms) await pause(step.delay_ms);
    if (step.wait_for) {
      const deadline = Date.now() + 45000;
      while (!fs.existsSync(step.wait_for)) {
        if (Date.now() > deadline) throw new Error('假工具等待放行超时');
        await pause(25);
      }
    }
    for (const [name, content] of Object.entries(step.files || {})) write(path.resolve(cwd, name), content);
    if (step.child_pid_file) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
      write(step.child_pid_file, String(child.pid));
    }
    if (step.stderr) process.stderr.write(step.stderr);
    if (step.stdout) process.stdout.write(step.stdout);
    if (step.event) process.stdout.write(JSON.stringify(step.event) + '\n');
  }
}
export async function finish(scenario) {
  if (scenario.stderr) process.stderr.write(scenario.stderr);
  if (scenario.hold) await new Promise(() => { setInterval(() => {}, 1000); });
  process.exitCode = scenario.exit_code || 0;
}
