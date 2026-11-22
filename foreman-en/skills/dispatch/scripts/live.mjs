import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { codexCommand } from './adapters/codex-cli.mjs';
import { ENTRY, foremanStateDir } from './config.mjs';
import { HERE, M, need, oneLine, pidExists, killTree, replaceFile, sleep } from './util.mjs';

const L = M.live;
const ackMs = 15000, startMs = 120000;
const attention = new Set(['question', 'turn_done', 'stalled', 'error', 'closed']);
const controls = ['answer', 'steer', 'send', 'interrupt', 'close'];
const now = () => new Date().toISOString();
const preview = (text) => Array.from(text).slice(0, 200).join('');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const input = (text) => [{ type: 'text', text, text_elements: [] }];

function atomicJson(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  replaceFile(file + '.tmp', file);
}

function sessionId() {
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  return `live-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
}

// Unix 套接字路径只有一百来个字节可用，会话目录可能很深，所以放在短的运行时目录里，用会话目录的哈希命名。
function endpoint(dir) {
  const name = 'foreman-live-' + createHash('sha256').update(dir).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? '\\\\.\\pipe\\' + name : path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), name + '.sock');
}

// npm 包装进程先退出时，taskkill /T 从它找不到整棵树：按父进程号找它留下的子进程，逐个结束。
// 只认在它活着期间创建的：进程号被别的程序复用后，那个程序新起的子进程不会被误杀。
function killOrphans(pid, sinceMs, untilMs) {
  const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const at = (ms) => `[DateTimeOffset]::Parse('${new Date(ms).toISOString()}').LocalDateTime`;
  spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    `$since = ${at(sinceMs - 1000)}; $until = ${at(untilMs + 1000)}
Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CreationDate -ge $since -and $_.CreationDate -le $until } | ForEach-Object { taskkill /pid $_.ProcessId /T /F | Out-Null }`],
  { windowsHide: true, timeout: 30000 });
}

function briefText(o) {
  const file = need(o, 'brief');
  if (file !== '-' && !fs.existsSync(file)) throw new Error(M.briefNotFound(path.resolve(file)));
  const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
  if (!text.trim()) throw new Error(M.emptyBrief);
  return text;
}

function minutes(o, key, fallback) {
  const n = Number(o[key] ?? fallback);
  if (!Number.isFinite(n) || n < 0) throw new Error(M.badArg('--' + key));
  return n;
}

function eventReader(dir) {
  const file = path.join(dir, 'live.jsonl'), decoder = new StringDecoder('utf8');
  let offset = 0, partial = '';
  return async (visit) => {
    const end = fs.statSync(file).size;
    if (offset === end) return;
    for await (const chunk of fs.createReadStream(file, { start: offset, end: end - 1 })) {
      offset += chunk.length;
      const lines = (partial + decoder.write(chunk)).split('\n');
      partial = lines.pop();
      for (const line of lines) visit(JSON.parse(line));
    }
  };
}

async function events(dir, id, o) {
  const after = Number(o.after ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error(M.badArg('--after'));
  const read = eventReader(dir);
  let closed = false;
  const show = (e) => {
    if (e.type === 'closed') closed = true;
    if (e.seq <= after || !o.all && !attention.has(e.type)) return;
    if (e.type === 'message') e.text = preview(e.text);
    process.stdout.write(`#${e.seq} ${oneLine(L.events[e.type](e))}\n`);
  };
  await read(show);
  if (closed) return;
  // 管道只推送唤醒字节；接通时再补读一次，覆盖第一次读日志与订阅之间的空隙。
  const socket = net.createConnection(endpoint(dir));
  try {
    for await (const wake of socket) {
      await read(show);
      if (closed) return;
    }
  } catch (e) {
    if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e.code)) throw e;
  } finally { socket.destroy(); }
  await read(show);
  if (!closed) throw new Error(L.ended(id));
}

async function control(dir, id, o) {
  const cmd = { action: o.action };
  if (cmd.action === 'answer') cmd.call = need(o, 'call');
  if (['answer', 'steer', 'send'].includes(cmd.action)) {
    if ((o.text != null) === (o.brief != null)) throw new Error(M.help.live);
    cmd.text = o.text ?? briefText(o);
  }
  // 读完说明（可能在等 stdin）以后再看会话状态、定截止时刻：插话和打断记下针对的是哪一轮，轮次变了中转就拒绝。
  const meta = json(path.join(dir, 'meta.json'));
  if (meta.state === 'closed' || !pidExists(meta.pid)) throw new Error(L.ended(id));
  if (['steer', 'interrupt'].includes(cmd.action)) cmd.turn = meta.current_turn;
  Object.assign(cmd, { id: `${Date.now()}-${randomBytes(6).toString('hex')}`, deadline: Date.now() + ackMs });
  const name = cmd.id + '.json', ack = path.join(dir, 'acks', name);
  atomicJson(path.join(dir, 'inbox', name), cmd);
  // 中转按 cmd.deadline 判断过期；这边多等几秒，免得它刚好在截止时写出的应答被错过。
  while (!fs.existsSync(ack)) {
    if (Date.now() >= cmd.deadline + 3000) throw new Error(L.noAck(id));
    await sleep(50);
  }
  const reply = json(ack);
  if (!reply.ok) throw new Error(reply.error);
  process.stdout.write(reply.message + '\n');
}

const askForeman = {
  type: 'function', name: 'ask_foreman', description: L.toolDescription,
  inputSchema: { type: 'object', properties: {
    question: { type: 'string', description: L.questionDescription },
    options: { type: 'array', items: { type: 'string' }, description: L.optionsDescription },
  }, required: ['question'], additionalProperties: false },
};

async function start(o, { dispatchProfile }) {
  const { cwd, cfg, profile } = dispatchProfile({ cwd: o.cwd, level: o.level, agent: o.agent }, 'run');
  const { agent, agentName, model, effort, level } = profile;
  if (profile.outside_cell) throw new Error(M.agentNotInLevel(agentName, `modules.run.${level}`, '—'));
  if (agent.type !== 'codex cli') throw new Error(L.notCodex(agentName, agent.type));
  const title = need(o, 'title'), brief = briefText(o);
  const idle = minutes(o, 'idle-min', 30), stall = minutes(o, 'stall-min', cfg.dispatch.stall_min);
  const answerTimeout = minutes(o, 'answer-timeout-min', 30);
  const version = json(path.join(HERE, '../../../.claude-plugin/plugin.json')).version;
  const { file, pre } = codexCommand(agent);
  const id = sessionId(), root = path.join(foremanStateDir(), 'live'), dir = path.join(root, id);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const sub of ['inbox', 'acks']) fs.mkdirSync(path.join(dir, sub));
  for (const name of ['live.jsonl', 'app-server.jsonl', 'stderr.log']) fs.writeFileSync(path.join(dir, name), '');
  fs.writeFileSync(path.join(dir, 'brief.md'), brief);
  const meta = { id, cwd, title, level, agent: agentName, model, effort, pid: process.pid, app_server_pid: null,
    thread_id: null, state: 'starting', current_turn: null, pending_calls: [], last_seq: 0, started_at: now(), ended_at: null, close_reason: null };
  const requests = new Map(), questions = new Map(), subscribers = new Set();
  // meta 和 last_seq 一起写：状态变化先 emit 再 save，status 读到的快照里，待答提问一定不晚于 last_seq。
  const save = () => { Object.assign(meta, { pending_calls: [...questions.keys()], last_seq: seq }); atomicJson(path.join(dir, 'meta.json'), meta); };
  const append = (name, row) => fs.appendFileSync(path.join(dir, name), JSON.stringify(row) + '\n');
  let seq = 0, rpcId = 0, closing = null, lastTraffic = Date.now(), idleSince = null;
  let lastTurn = null, lastText = '', stderrTail = '', spawnError = '', scanning = false;
  const emit = (type, fields) => {
    append('live.jsonl', { seq: ++seq, t: now(), type, ...fields });
    for (const socket of subscribers) socket.write('.');
  };
  const server = net.createServer((socket) => {
    socket.unref();
    subscribers.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => subscribers.delete(socket));
    socket.write('.');
  });
  await once(server.listen(endpoint(dir)), 'listening');
  const childStarted = Date.now();
  const child = spawn(file, [...pre, 'app-server'], { cwd, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
  let childClosed = false, childExited = null;
  meta.app_server_pid = child.pid ?? null;
  save();
  child.stderr.setEncoding('utf8').on('data', (s) => {
    fs.appendFileSync(path.join(dir, 'stderr.log'), s);
    stderrTail = (stderrTail + s).slice(-4096);
  });
  child.on('error', (e) => { spawnError = e.message; });
  child.stdin.on('error', (e) => { spawnError = e.message; });

  function write(msg) {
    msg = { jsonrpc: '2.0', ...msg };
    append('app-server.jsonl', { t: now(), dir: 'out', msg });
    child.stdin.write(JSON.stringify(msg) + '\n');
  }
  function request(method, params, deadline) {
    let timeout;
    return new Promise((resolve, reject) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) return reject(new Error(L.ended(id)));
      const requestId = ++rpcId;
      requests.set(requestId, { resolve, reject });
      write({ id: requestId, method, params });
      // 服务端不回这一条请求时，不能把后面的 close 永远堵在 inbox 里；请求已经发出，结果只能算未知。
      if (deadline != null) {
        const seconds = Math.max(1, Math.round((deadline - Date.now()) / 1000));
        timeout = setTimeout(() => {
          requests.delete(requestId);
          reject(new Error(L.noReply(method, seconds)));
        }, Math.max(0, deadline - Date.now()));
      }
    }).finally(() => clearTimeout(timeout));
  }
  const thread = () => ({ threadId: meta.thread_id });
  const interrupt = (turnId, deadline) => request('turn/interrupt', { ...thread(), turnId }, deadline);
  // 结束 app-server 和它起的所有进程。包装进程还活着时按树结束；已经退出时找它留下的子进程。
  // 非 Windows 下 app-server 自成进程组，组长退出后组还在，按组发信号就够了。
  function reap() {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      if (child.exitCode === null && child.signalCode === null) { killTree(child.pid); child.kill(); }
      else killOrphans(child.pid, childStarted, childExited ?? Date.now());
      return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* 组已经没了 */ }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 组已经没了 */ } }, 1000).unref();
  }
  // 留下的子进程可能还拿着 stdio 管道，close 事件会一直等不到：清理后直接断开管道，让收尾照常走完。
  function forceClose() {
    if (childClosed) return;
    reap();
    for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
  }
  function shutdown(reason) {
    if (closing) return;
    closing = reason;
    const end = () => { if (!child.stdin.writableEnded) child.stdin.end(); };
    if (meta.current_turn) {
      interrupt(meta.current_turn).catch(end);
      setTimeout(end, 1000).unref();
    } else end();
    // 先让子进程读到 EOF 自行退出，2 秒还没走完就结束整棵进程树，再过 3 秒断开管道。
    setTimeout(() => { if (!childClosed) reap(); }, 2000).unref();
    setTimeout(forceClose, 5000).unref();
  }
  function fail(e) {
    if (!closing) { emit('error', { message: e.message }); shutdown('error'); }
  }
  function begin(turn) {
    if (lastTurn === turn) return;
    lastTurn = turn; lastText = ''; idleSince = null;
    Object.assign(meta, { state: 'running', current_turn: turn });
    emit('turn_started', { turn }); save();
  }
  async function startTurn(text, deadline) {
    idleSince = null;
    try {
      const { turn } = await request('turn/start', { ...thread(), input: input(text) }, deadline);
      // 回包与通知可能在同一批 stdout 里；已经结束的这一轮不能重新变成 running。
      begin(turn.id);
      return turn.id;
    } finally { if (meta.state === 'idle' && idleSince == null) idleSince = Date.now(); }
  }

  function notification(method, p) {
    if (p?.threadId && p.threadId !== meta.thread_id) return;
    if (method === 'turn/started') begin(p.turn.id);
    if (method === 'item/completed') {
      const { item, turnId: turn } = p;
      if (item.type === 'agentMessage') { lastText = item.text; emit('message', { turn, text: item.text }); }
      if (item.type === 'commandExecution') emit('command', { turn, command: item.command, exit_code: item.exitCode });
      if (item.type === 'fileChange') emit('file_change', { turn, paths: item.changes.map((c) => c.path) });
    }
    if (method === 'turn/completed') {
      const { turn } = p;
      const text = turn.items?.findLast((item) => item.type === 'agentMessage')?.text ?? lastText;
      const file = path.join(dir, `last-message-${encodeURIComponent(turn.id)}.md`);
      fs.writeFileSync(file, text);
      questions.clear();
      lastTurn = turn.id;
      const done = () => {
        idleSince = Date.now();
        Object.assign(meta, { current_turn: null, state: 'idle' });
        emit('turn_done', { turn: turn.id, status: turn.status, summary: preview(text), file, error: turn.error?.message ?? null });
        save();
      };
      if (closing) { done(); child.stdin.end(); }
      else if (turn.status === 'interrupted') {
        // 打断只停下这一轮，它已经起的命令还在跑；清掉这个 thread 的后台终端以后才算空闲，才能开下一轮。
        Object.assign(meta, { current_turn: null, state: 'stopping' });
        save();
        request('thread/backgroundTerminals/clean', thread(), Date.now() + ackMs)
          .catch((e) => emit('error', { message: L.cleanFailed(e.message) }))
          .finally(() => { if (!closing) done(); });
      } else done();
    }
    // willRetry 的错误 Codex 会自己重试，只记下来，不唤醒主控。
    if (method === 'error') emit(p.willRetry ? 'retry' : 'error', { message: p.error.message });
    if (method === 'serverRequest/resolved') {
      for (const [call, q] of questions) if (q.id === p.requestId) questions.delete(call);
      save();
    }
  }

  function ask(id, call, source, question, options, deliver) {
    // 保存 RPC id 和回复方法，等主控给出答案才回复服务端的这一条请求。
    questions.set(call, { id, deliver, expires: Date.now() + answerTimeout * 60000 });
    emit('question', { call, source, question, options }); save();
  }
  function answer(call, text, by) {
    const q = questions.get(call);
    if (!q) throw new Error(L.noCall(call));
    q.deliver(text);
    questions.delete(call); lastTraffic = Date.now();
    emit('answered', { call, by }); save();
  }
  function incomingRequest({ id, method, params: p }) {
    const reply = (result) => write({ id, result });
    const toolReply = (text, success) => reply({ contentItems: [{ type: 'inputText', text }], success });
    if (method === 'item/tool/call') {
      if (p.tool !== 'ask_foreman' || p.namespace != null || typeof p.arguments?.question !== 'string'
        || p.arguments.options != null && !Array.isArray(p.arguments.options)) return toolReply(L.unknownTool(p.tool), false);
      return ask(id, p.callId, 'ask_foreman', p.arguments.question, p.arguments.options ?? [], (text) => toolReply(text, true));
    }
    if (method === 'item/tool/requestUserInput') {
      // 协议没要求问题 id 唯一：同一个 id 只问第一次出现的那道，答案按去重后的数量收齐再回复。
      const unique = new Map();
      for (const q of p.questions) if (!unique.has(q.id)) unique.set(q.id, q);
      const answers = Object.create(null);
      const finish = () => { if (Object.keys(answers).length === unique.size) reply({ answers }); };
      for (const q of unique.values()) {
        const call = `${p.itemId}:${q.id}`;
        // 保密问题不经过实时会话：答案会落进 inbox 和协议日志，直接回绝。
        if (q.isSecret) { answers[q.id] = { answers: [L.secretReply] }; emit('answered', { call, by: 'secret' }); continue; }
        ask(id, call, 'request_user_input', q.question, q.options?.map((o) => o.label) ?? [], (text) => {
          answers[q.id] = { answers: [text] };
          finish();
        });
      }
      return finish();
    }
    const denied = L.denied(method);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') reply({ decision: 'decline' });
    else if (method === 'item/permissions/requestApproval') reply({ permissions: {}, scope: 'turn' });
    else if (method === 'applyPatchApproval' || method === 'execCommandApproval') reply({ decision: { denied: { rejection: denied } } });
    else return write({ id, error: { code: -32601, message: 'Method not found: ' + method } });
    emit('error', { message: denied });
  }

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    lastTraffic = Date.now();
    let msg;
    try { msg = JSON.parse(line); } catch { return emit('error', { message: L.badLine(preview(line)) }); }
    append('app-server.jsonl', { t: now(), dir: 'in', msg });
    // app-server 是实验接口，字段可能变：单条消息处理失败只报出来，不关会话；服务端的请求回一个错误，免得它一直等。
    try {
      if (msg.method) {
        if (msg.id != null) incomingRequest(msg);
        else notification(msg.method, msg.params);
      } else {
        const req = requests.get(msg.id);
        requests.delete(msg.id);
        if (msg.error) req?.reject(new Error(msg.error.message));
        else req?.resolve(msg.result);
      }
    } catch (e) {
      if (msg.method && msg.id != null) write({ id: msg.id, error: { code: -32603, message: e.message } });
      emit('error', { message: L.badMessage(msg.method ?? 'response', e.message) });
    }
  });

  async function act(cmd) {
    if (closing) throw new Error(L.ended(id));
    // 调用方 15 秒后就不等了，过期的命令再执行，它重试时就会重复。
    if (Date.now() > cmd.deadline) throw new Error(L.expired);
    const { deadline } = cmd;
    if (['steer', 'interrupt'].includes(cmd.action)) {
      if (!cmd.turn) throw new Error(meta.state === 'stopping' ? L.stopping : L.noTurn);
      if (cmd.turn !== meta.current_turn) throw new Error(L.turnChanged(cmd.turn));
    }
    switch (cmd.action) {
      case 'answer': answer(cmd.call, cmd.text, 'foreman'); return L.answer;
      case 'send':
        if (meta.state === 'stopping') throw new Error(L.stopping);
        if (meta.state !== 'idle') throw new Error(L.inProgress);
        return L.send(await startTurn(cmd.text, deadline));
      case 'steer':
        await request('turn/steer', { ...thread(), expectedTurnId: cmd.turn, input: input(cmd.text) }, deadline);
        emit('steered', { turn: cmd.turn }); return L.steer;
      case 'interrupt':
        await interrupt(cmd.turn, deadline); return L.interrupt;
      case 'close': shutdown('close'); return L.close;
      default: throw new Error(M.badArg(cmd.action));
    }
  }
  async function inbox() {
    if (scanning) return;
    scanning = true;
    try {
      // Windows 的目录通知可能漏报；只取原子改名后出现的 .json，按投递顺序逐个应答。
      for (const name of fs.readdirSync(path.join(dir, 'inbox')).filter((n) => n.endsWith('.json')).sort()) {
        const file = path.join(dir, 'inbox', name);
        let ack;
        try { ack = { ok: true, message: await act(json(file)) }; }
        catch (e) { ack = { ok: false, error: e.message }; }
        atomicJson(path.join(dir, 'acks', name), ack);
        fs.unlinkSync(file);
      }
    } finally { scanning = false; }
  }
  const timer = setInterval(() => {
    inbox().catch(fail);
    if (closing) return;
    const t = Date.now();
    for (const [call, q] of questions) if (t >= q.expires) answer(call, L.timeoutReply, 'timeout');
    if (idleSince != null && t - idleSince >= idle * 60000) shutdown('idle');
    if (stall && meta.current_turn && !questions.size && t - lastTraffic >= stall * 60000) {
      emit('stalled', { minutes: stall }); lastTraffic = t;
    }
  }, 250);
  const signal = () => shutdown('signal');
  process.on('SIGINT', signal); process.on('SIGTERM', signal);
  // 包装进程退出了、它起的进程还拿着管道时 close 迟迟不来：2 秒后清理留下的进程并断开管道。
  child.once('exit', () => { childExited = Date.now(); setTimeout(forceClose, 2000).unref(); });
  const exited = new Promise((resolve) => child.once('close', (code, sig) => {
    childClosed = true;
    clearInterval(timer);
    if (!closing) {
      closing = 'app_server_exit';
      const tail = [spawnError, ...stderrTail.trimEnd().split(/\r?\n/).slice(-5)].filter(Boolean).join('\n');
      emit('error', { message: L.serverExit(code ?? sig, tail) });
    }
    for (const req of requests.values()) req.reject(new Error(L.ended(id)));
    requests.clear(); questions.clear();
    Object.assign(meta, { state: 'closed', current_turn: null, ended_at: now(), close_reason: closing });
    emit('closed', { reason: closing }); save();
    for (const socket of subscribers) socket.end();
    server.close();
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    if (['app_server_exit', 'error'].includes(closing)) process.exitCode = 1;
    resolve();
  }));
  try {
    // 启动的三步各给 2 分钟：app-server 活着却不回话时，不能一直挂着、连会话 id 都不告诉调用方。
    await request('initialize', { clientInfo: { name: 'foreman', title: 'foreman live', version },
      capabilities: { experimentalApi: true, requestAttestation: false } }, Date.now() + startMs);
    write({ method: 'initialized' });
    const res = await request('thread/start', { cwd, ...(model && { model }), approvalPolicy: agent.approval ?? 'never',
      ...(agent.sandbox?.run && { sandbox: agent.sandbox.run }), ...(effort != null && { config: { model_reasoning_effort: effort } }),
      developerInstructions: L.instructions, dynamicTools: [askForeman] }, Date.now() + startMs);
    Object.assign(meta, { thread_id: res.thread.id, model: res.model, effort: res.reasoningEffort ?? effort });
    emit('started', { thread_id: meta.thread_id, model: meta.model, effort: meta.effort }); save();
    await startTurn(brief, Date.now() + startMs);
    process.stdout.write(L.startLine(meta.model, meta.effort ?? '—', level, dir) + '\n' + L.eventsLine(ENTRY, id) + '\n');
  } catch (e) {
    fail(e);
    process.stderr.write(`foreman: ${e.message}\n${L.eventsLine(ENTRY, id)}\n`);
  }
  await exited;
}

export async function cmdLive(o, deps) {
  try {
    if (o.action === 'start') return await start(o, deps);
    if (![...controls, 'events', 'status'].includes(o.action)) throw new Error(M.help.live);
    const id = need(o, 'run'), dir = path.join(foremanStateDir(), 'live', id), file = path.join(dir, 'meta.json');
    if (!/^live-\d{8}-\d{6}-[0-9a-f]{4}$/.test(id) || !fs.existsSync(file)) throw new Error(L.notFound(id));
    if (o.action === 'events') return await events(dir, id, o);
    // meta.json 里的 last_seq 和状态是同一次写入的快照，不另读日志尾部，免得续订时跳过还没看到的提问。
    if (o.action === 'status') process.stdout.write(JSON.stringify(json(file), null, 2) + '\n');
    else await control(dir, id, o);
  } catch (e) {
    process.stderr.write(`foreman: ${e.message}\n`);
    process.exitCode = 1;
  }
}
