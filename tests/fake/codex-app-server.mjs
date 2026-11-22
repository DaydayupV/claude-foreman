import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { replay } from './common.mjs';

// common.setup 会等 stdin 关闭；长连接按帧写 capture，才能在它等待回答时检查收到的请求。
const script = JSON.parse(fs.readFileSync(process.env.FAKE_SCENARIO, 'utf8'));
const args = process.argv.slice(2), threadId = 'thread-live';
let count = 0, active = null, pending = null;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const notify = (method, params) => send({ method, params });

function finish(turn, status = turn.spec.status ?? 'completed') {
  if (active !== turn) return;
  if (status === 'failed') turn.data.error = { message: turn.spec.error, codexErrorInfo: null, additionalDetails: null };
  if (status !== 'interrupted') {
    for (const [i, item] of (turn.spec.items ?? []).entries()) {
      const completed = { id: 'item-' + i, ...item };
      turn.data.items.push(completed);
      notify('item/completed', { threadId, turnId: turn.data.id, item: completed, completedAtMs: Date.now() });
    }
  }
  Object.assign(turn.data, { status, completedAt: Math.floor(Date.now() / 1000) });
  notify('turn/completed', { threadId, turn: turn.data });
  active = null; pending = null;
}

async function play(turn) {
  const { spec, data } = turn;
  if (spec.wait_for) await replay([{ wait_for: spec.wait_for }]);
  if (active !== turn) return;
  for (const n of spec.notify ?? []) notify(n.method, { threadId, turnId: data.id, ...n.params });
  if (spec.orphan) {
    // 留下一个拿着同一组 stdio 的子进程再退出：模拟包装进程先走、Codex 还活着。
    // Windows 上 Node 的子进程默认随父进程的作业对象一起结束，要 detached 才留得下；其他平台留在同一个进程组里。
    const left = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', detached: process.platform === 'win32' });
    fs.appendFileSync(script.capture, JSON.stringify({ orphan: left.pid }) + '\n');
    process.exit(spec.orphan);
  }
  if (spec.crash) {
    process.stderr.write(spec.stderr, () => process.exit(spec.crash));
    return;
  }
  if (spec.ask) {
    pending = 'server-request-' + count;
    send({ id: pending, method: 'item/tool/call', params: { threadId, turnId: data.id, callId: 'call-' + count,
      namespace: null, tool: 'ask_foreman', arguments: spec.ask } });
  } else if (spec.user_input) {
    pending = 'server-request-' + count;
    send({ id: pending, method: 'item/tool/requestUserInput', params: { threadId, turnId: data.id, itemId: 'item-ui',
      questions: spec.user_input, isBlocking: true, autoResolutionMs: null } });
  } else if (!spec.hold && !spec.until_steer) finish(turn);
}

for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const msg = JSON.parse(line);
  fs.appendFileSync(script.capture, JSON.stringify({ tool: 'codex', operation: 'app-server', args, cwd: process.cwd(), pid: process.pid, msg }) + '\n');
  const { id, method, params } = msg;
  const reply = (result) => send({ id, result });
  if (method === 'initialize') {
    reply({ userAgent: 'synthetic', codexHome: process.env.CODEX_HOME,
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix', platformOs: process.platform });
  } else if (method === 'initialized') {
    continue;
  } else if (method === 'thread/start') {
    reply({ thread: { id: threadId }, model: params.model ?? 'fake-default', reasoningEffort: params.config?.model_reasoning_effort ?? null });
  } else if (method === 'turn/start') {
    if (active || params.threadId !== threadId) throw new Error('假 app-server 收到重叠的轮次或错误的 threadId');
    const data = { id: 'turn-' + ++count, rootTurnId: null, items: [], itemsView: 'full', status: 'inProgress',
      error: null, startedAt: Math.floor(Date.now() / 1000), completedAt: null, durationMs: null };
    active = { data, spec: script.turns[count - 1] };
    reply({ turn: data });
    notify('turn/started', { threadId, turn: data });
    void play(active);
  } else if (method === 'turn/steer' || method === 'turn/interrupt') {
    if (!active || params.threadId !== threadId || (params.expectedTurnId ?? params.turnId) !== active.data.id) {
      send({ id, error: { code: -32602, message: 'unexpected turn' } });
      continue;
    }
    if (method === 'turn/interrupt') { reply({}); finish(active, 'interrupted'); }
    else {
      reply({ turnId: active.data.id });
      if (active.spec.until_steer) finish(active);
    }
  } else if (method === 'thread/backgroundTerminals/clean') {
    reply({});
  } else if (!method && pending != null && id === pending) {
    finish(active);
  } else if (method) send({ id, error: { code: -32601, message: 'Method not found' } });
}
