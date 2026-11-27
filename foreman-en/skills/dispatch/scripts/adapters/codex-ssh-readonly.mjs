// Move only read-only Codex jobs from a Windows SSH service session to the
// same user's interactive desktop. Both sides communicate over a one-shot pipe.
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
const encoded = (s) => Buffer.from(s, 'utf16le').toString('base64');

const taskName = (id) => 'ClaudeForeman-ReadOnly-' + id;
function powershell(script) {
  return spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script)],
    { encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
function removeTask(id) {
  powershell('Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue -TaskName ' + quote(taskName(id)));
}

function startTask(id, token) {
  const launch = '& ' + [process.execPath, self, '--worker', id, token].map(quote).join(' ') +
    "; Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue -TaskName " + quote(taskName(id));
  const r = powershell([
    '$u = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
    '$principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
    '$action = New-ScheduledTaskAction -Execute ' + quote(ps) + ' -Argument ' +
      quote('-WindowStyle Hidden -NoProfile -NonInteractive -EncodedCommand ' + encoded(launch)),
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)',
    '$name = ' + quote(taskName(id)),
    'Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null',
    'Start-ScheduledTask -TaskName $name',
  ].join('; '));
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr.trim() || 'Unable to start the desktop task');
}


const pipe = (id) => '\\\\.\\pipe\\' + taskName(id);
const frame = (socket, value) => socket.write(JSON.stringify(value) + '\n');
function assertReadonly(args) {
  if (!['sandbox', 'exec'].includes(args[0]) || !args.includes('sandbox_mode="read-only"')) {
    throw new Error('Expected a Foreman read-only Codex invocation');
  }
}

async function worker(id, token) {
  if (!/^[\da-f-]{36}$/.test(id)) throw new Error('Invalid job id');
  const server = net.createServer();
  server.listen(pipe(id));
  await once(server, 'listening');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let socket;
  try { [socket] = await once(server, 'connection', { signal: controller.signal }); }
  finally { clearTimeout(timer); server.close(); }
  socket.setTimeout(5000, () => socket.destroy());
  socket.on('error', () => {});
  const lines = readline.createInterface({ input: socket });
  const next = once(lines, 'line');
  frame(socket, { proof: createHash('sha256').update(token).digest('hex') });
  const [line] = await next;
  const { command, args, cwd, env, stdin, secret } = JSON.parse(line);
  if (secret !== token) { socket.destroy(); throw new Error('Invalid worker handshake'); }
  socket.setTimeout(0);
  assertReadonly(args);
  const child = spawn(command.file, [...command.pre, ...args], { cwd, env: { ...process.env, ...env }, windowsHide: true });
  const stop = () => {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true });
    }
  };
  socket.on('error', stop);
  socket.once('close', stop);
  child.stdin.on('error', () => {});
  child.stdin.end(Buffer.from(stdin, 'base64'));
  async function forward(stream, channel) {
    for await (const chunk of stream) {
      if (socket.destroyed) return;
      if (!frame(socket, { [channel]: chunk.toString('base64') })) await once(socket, 'drain');
    }
  }
  try {
    const [[code]] = await Promise.all([once(child, 'close'), forward(child.stdout, 'stdout'), forward(child.stderr, 'stderr')]);
    socket.end(JSON.stringify({ code: code ?? 1 }) + '\n');
  } catch (e) {
    stop();
    if (!socket.destroyed) socket.end(JSON.stringify({ error: e.message }) + '\n');
  } finally { lines.close(); }
}

async function client(command, args) {
  assertReadonly(args);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const id = randomUUID(), token = randomUUID();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SSH_|SESSIONNAME$)/i.test(key)) delete env[key];
  let socket;
  try {
    startTask(id, token);
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      socket = net.connect(pipe(id));
      try { await once(socket, 'connect'); break; }
      catch (e) {
        socket.destroy();
        if (e.code !== 'ENOENT' && e.code !== 'EBUSY') throw e;
        await delay(100);
      }
    }
    if (!socket || socket.destroyed) throw new Error('No logged-in Windows desktop worker is available');
    socket.setTimeout(5000, () => socket.destroy());
    let authenticated = false;
    for await (const line of readline.createInterface({ input: socket, crlfDelay: Infinity })) {
      const message = JSON.parse(line);
      if (!authenticated) {
        if (message.proof !== createHash('sha256').update(token).digest('hex')) throw new Error('Invalid worker handshake');
        authenticated = true;
        socket.setTimeout(0);
        frame(socket, { secret: token, command, args, cwd: process.cwd(), env, stdin: Buffer.concat(chunks).toString('base64') });
      } else if (message.error) throw new Error(message.error);
      else if (Number.isInteger(message.code)) return message.code;
      else {
        const channel = Object.hasOwn(message, 'stdout') ? 'stdout' : 'stderr';
        if (!process[channel].write(Buffer.from(message[channel], 'base64'))) await once(process[channel], 'drain');
      }
    }
    throw new Error('Desktop worker closed before reporting an exit code');
  } finally {
    socket?.destroy();
    removeTask(id);
  }
}
const [, , mode, ...args] = process.argv;
try {
  if (mode === '--worker') await worker(...args);
  else process.exitCode = await client(JSON.parse(mode), args);
} catch (e) {
  console.error('Foreman read-only desktop worker:', e.message);
  process.exitCode = 1;
}
