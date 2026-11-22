import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { codexCommand } from './adapters/codex-cli.mjs';
import { ENTRY, foremanStateDir } from './config.mjs';
import { HERE, M, need, oneLine, pidExists, killTree, replaceFile, sleep } from './util.mjs';

const L = M.live;
const ackMs = 15000;
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

function endpoint(dir) {
  return process.platform === 'win32' ? '\\\\.\\pipe\\foreman-live-' + createHash('sha256').update(dir).digest('hex').slice(0, 24)
    : path.join(dir, 'events.sock');
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

async function control(dir, meta, o) {
  if (meta.state === 'closed' || !pidExists(meta.pid)) throw new Error(L.ended(meta.id));
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}`, name = id + '.json';
  const cmd = { id, action: o.action };
  if (cmd.action === 'answer') cmd.call = need(o, 'call');
  if (['answer', 'steer', 'send'].includes(cmd.action)) {
    if ((o.text != null) === (o.brief != null)) throw new Error(M.help.live);
    cmd.text = o.text ?? briefText(o);
  }
  const ack = path.join(dir, 'acks', name);
  atomicJson(path.join(dir, 'inbox', name), cmd);
  const deadline = Date.now() + ackMs;
  while (!fs.existsSync(ack)) {
    if (Date.now() >= deadline) throw new Error(L.noAck(meta.id));
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
    thread_id: null, state: 'starting', current_turn: null, pending_calls: [], started_at: now(), ended_at: null, close_reason: null };
  const requests = new Map(), questions = new Map(), subscribers = new Set();
  const save = () => { meta.pending_calls = [...questions.keys()]; atomicJson(path.join(dir, 'meta.json'), meta); };
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
  const child = spawn(file, [...pre, 'app-server'], { cwd, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
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
      // 服务端不回这一条控制请求时，不能把后面的 close 永远堵在 inbox 里。
      if (deadline != null) timeout = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error(L.noAck(id)));
      }, Math.max(0, deadline - Date.now()));
    }).finally(() => clearTimeout(timeout));
  }
  const thread = () => ({ threadId: meta.thread_id });
  const interrupt = (deadline) => request('turn/interrupt', { ...thread(), turnId: meta.current_turn }, deadline);
  function shutdown(reason) {
    if (closing) return;
    closing = reason;
    const end = () => { if (!child.stdin.writableEnded) child.stdin.end(); };
    if (meta.current_turn) {
      interrupt().catch(end);
      setTimeout(end, 1000).unref();
    } else end();
    // 先让子进程读到 EOF 自行退出；卡住的 npm 包装器和它启动的 Codex 要一起结束。
    setTimeout(() => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      killTree(child.pid);
      if (process.platform === 'win32') child.kill();
      else setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
        }
      }, 1000).unref();
    }, 2000).unref();
  }
  function fail(e) {
    if (!closing) { emit('error', { message: e.message }); shutdown('error'); }
  }
  function begin(turn) {
    if (lastTurn === turn) return;
    lastTurn = turn; lastText = ''; idleSince = null;
    Object.assign(meta, { state: 'running', current_turn: turn });
    save(); emit('turn_started', { turn });
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
      lastTurn = turn.id; idleSince = Date.now();
      Object.assign(meta, { current_turn: null, state: 'idle' });
      save(); emit('turn_done', { turn: turn.id, status: turn.status, summary: preview(text), file });
      if (closing) child.stdin.end();
    }
    if (method === 'error') emit('error', { message: p.error.message });
    if (method === 'serverRequest/resolved') {
      for (const [call, q] of questions) if (q.id === p.requestId) questions.delete(call);
      save();
    }
  }

  function ask(id, call, source, question, options, deliver) {
    // 保存 RPC id 和回复方法，等主控给出答案才回复服务端的这一条请求。
    questions.set(call, { id, deliver, expires: Date.now() + answerTimeout * 60000 });
    save(); emit('question', { call, source, question, options });
  }
  function answer(call, text, by) {
    const q = questions.get(call);
    if (!q) throw new Error(L.noCall(call));
    q.deliver(text);
    questions.delete(call); lastTraffic = Date.now();
    save(); emit('answered', { call, by });
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
      const answers = Object.create(null);
      if (!p.questions.length) return reply({ answers });
      for (const q of p.questions) ask(id, `${p.itemId}:${q.id}`, 'request_user_input', q.question, q.options?.map((o) => o.label) ?? [], (text) => {
        answers[q.id] = { answers: [text] };
        if (Object.keys(answers).length === p.questions.length) reply({ answers });
      });
      return;
    }
    const denied = L.denied(method);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') reply({ decision: 'decline' });
    else if (method === 'item/permissions/requestApproval') reply({ permissions: {}, scope: 'turn' });
    else if (method === 'applyPatchApproval' || method === 'execCommandApproval') reply({ decision: { denied: { rejection: denied } } });
    else return write({ id, error: { code: -32601, message: 'Method not found: ' + method } });
    emit('error', { message: denied });
  }

  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      append('app-server.jsonl', { t: now(), dir: 'in', msg });
      lastTraffic = Date.now();
      if (msg.method) {
        if (msg.id != null) incomingRequest(msg);
        else notification(msg.method, msg.params);
      } else {
        const req = requests.get(msg.id);
        requests.delete(msg.id);
        if (msg.error) req?.reject(new Error(msg.error.message));
        else req?.resolve(msg.result);
      }
    } catch (e) { fail(e); }
  });

  async function act(cmd, deadline) {
    if (closing) throw new Error(L.ended(id));
    const turn = meta.current_turn;
    switch (cmd.action) {
      case 'answer': answer(cmd.call, cmd.text, 'foreman'); return L.answer;
      case 'send':
        if (meta.state !== 'idle') throw new Error(L.inProgress);
        return L.send(await startTurn(cmd.text, deadline));
      case 'steer':
        if (!turn) throw new Error(L.noTurn);
        await request('turn/steer', { ...thread(), expectedTurnId: turn, input: input(cmd.text) }, deadline);
        emit('steered', { turn }); return L.steer;
      case 'interrupt':
        if (!turn) throw new Error(L.noTurn);
        await interrupt(deadline); return L.interrupt;
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
        try { ack = { ok: true, message: await act(json(file), Number(name.split('-')[0]) + ackMs) }; }
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
  const exited = new Promise((resolve) => child.once('close', (code, sig) => {
    clearInterval(timer);
    if (!closing) {
      closing = 'app_server_exit';
      const tail = [spawnError, ...stderrTail.trimEnd().split(/\r?\n/).slice(-5)].filter(Boolean).join('\n');
      emit('error', { message: L.serverExit(code ?? sig, tail) });
    }
    for (const req of requests.values()) req.reject(new Error(L.ended(id)));
    requests.clear(); questions.clear();
    Object.assign(meta, { state: 'closed', current_turn: null, ended_at: now(), close_reason: closing });
    save(); emit('closed', { reason: closing });
    for (const socket of subscribers) socket.end();
    server.close();
    process.off('SIGINT', signal); process.off('SIGTERM', signal);
    if (['app_server_exit', 'error'].includes(closing)) process.exitCode = 1;
    resolve();
  }));
  try {
    await request('initialize', { clientInfo: { name: 'foreman', title: 'foreman live', version },
      capabilities: { experimentalApi: true, requestAttestation: false } });
    write({ method: 'initialized' });
    const res = await request('thread/start', { cwd, ...(model && { model }), approvalPolicy: agent.approval ?? 'never',
      ...(agent.sandbox?.run && { sandbox: agent.sandbox.run }), ...(effort != null && { config: { model_reasoning_effort: effort } }),
      developerInstructions: L.instructions, dynamicTools: [askForeman] });
    Object.assign(meta, { thread_id: res.thread.id, model: res.model, effort: res.reasoningEffort ?? effort });
    save(); emit('started', { thread_id: meta.thread_id, model: meta.model, effort: meta.effort });
    await startTurn(brief);
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
    const meta = json(file);
    if (o.action === 'events') return await events(dir, id, o);
    if (o.action === 'status') {
      let last_seq = 0;
      await eventReader(dir)((e) => { last_seq = e.seq; });
      process.stdout.write(JSON.stringify({ ...meta, last_seq }, null, 2) + '\n');
    } else await control(dir, meta, o);
  } catch (e) {
    process.stderr.write(`foreman: ${e.message}\n`);
    process.exitCode = 1;
  }
}
