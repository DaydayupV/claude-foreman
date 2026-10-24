import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const state = fs.readFileSync(new URL('../board/web/01-state.js', import.meta.url), 'utf8');
const rates = fs.readFileSync(new URL('../board/web/04-rates.js', import.meta.url), 'utf8');
function board() {
  const context = vm.createContext({ window: { __BOARD_FIXTURE__: true }, location: { search: '' }, URLSearchParams,
    performance: { now: () => 0 }, wake() {} });
  vm.runInContext(`${state}\n${rates}\nglobalThis.api = { B, onHello, onRun, onEv, onBacklog, loadSnapshot, laneStats, segments, RATE_EVENTS_MAX };`, context);
  return context.api;
}
async function collect(address, b, stop, onFrame = () => {}) {
  const response = await fetch(`${address}stream?session=s`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder(), frames = []; let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(raw)?.[1], data = /^data: (.+)$/m.exec(raw)?.[1];
        if (!data) continue;
        const frame = { event, data: JSON.parse(data) }; frames.push(frame);
        ({ hello: b.onHello, run: b.onRun, ev: b.onEv, backlog: b.onBacklog })[event]?.(frame.data);
        onFrame(frame, frames);
        if (stop(frame, frames)) return frames;
      }
    }
  } finally { await reader.cancel(); }
  return frames;
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-rate-backlog-'));
  let child, closed;
  t.after(async () => {
    if (child) { if (child.exitCode == null && child.signalCode == null) child.kill(); await closed; }
    assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true });
  });
  const runs = path.join(root, 'runs'), claudeDir = path.join(root, 'claude'), config = path.join(root, 'config.json');
  const transcript = path.join(claudeDir, 'project', 's.jsonl'), dir = path.join(runs, 'work'), base = Date.now() - 1300000;
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(config, '{}');
  const usage = (n) => ({ input_tokens: n, output_tokens: n, cached_input_tokens: 0, cache_write_input_tokens: 0 });
  const work = (count, tokens) => {
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ status: 'done', kind: 'exec', model: 'synthetic', agent_type: 'codex cli',
      claude_session: 's', started_at: base, ended_at: base + count * 1000 }));
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ usage_scope: 'this_run', usage: usage(count * tokens) }));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), [JSON.stringify({ type: 'turn.started', ts: base }), ...Array.from({ length: count }, (_, i) =>
      JSON.stringify({ type: 'step.usage', ts: base + (i + 1) * 1000, usage: usage(tokens) }))].join('\n') + '\n');
  };
  const assistant = (i, out = 10) => ({ type: 'assistant', sessionId: 's', timestamp: new Date(base + i * 1000).toISOString(),
    message: { id: `m${i}`, model: 'synthetic', content: [], usage: { input_tokens: out, output_tokens: out } } });
  work(1200, 10);
  fs.writeFileSync(transcript, [{ type: 'user', timestamp: new Date(base).toISOString(), cwd: root, message: { content: 'synthetic' } },
    ...Array.from({ length: 500 }, (_, i) => assistant(i + 1))].map((row) => JSON.stringify(row)).join('\n') + '\n');
  child = spawn(process.execPath, [fileURLToPath(new URL('../foreman/skills/dispatch/scripts/board/server.mjs', import.meta.url)),
    '--runs', runs, '--claude-dir', claudeDir, '--config', config, '--prices', fileURLToPath(new URL('./fixtures/board/prices-test.json', import.meta.url))],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, '.codex') } });
  closed = once(child, 'close'); let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text; });
  const address = await new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8').on('data', (text) => { buffer += text; const url = /board: (http:\/\/\S+?)\?/.exec(buffer)?.[1]; if (url) resolve(url); });
    child.once('error', reject); child.once('close', () => reject(new Error(stderr || 'server exited')));
  });
  return { root, dir, transcript, base, address, work, assistant };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('serialized snapshots and SSE restore compact statistics across refresh, reconnect and backlog reset', { timeout: 15000 }, async (t) => {
  const f = await fixture(t), b = board();
  const snapshot = async () => { const res = await fetch(`${f.address}snapshot?session=s`); assert.equal(res.status, 200); return res.json(); };
  for (let i = 0; i < 2; i++) {
    const data = await snapshot();
    for (const id of ['work', 'cc']) assert.equal(data.events.filter((ev) => ev.run === id).length, 200);
    assert.equal(data.rate_events.filter((ev) => ev.run === 'work').length, 1203);
    assert.equal(data.rate_events.filter((ev) => ev.run === 'cc').length, 501);
    const allowed = new Set(['run', 'ts', 'k', 'u', 'n', 'tot', 'end', 'usage_from', 'usage_to']);
    assert.ok(data.rate_events.every((ev) => Object.keys(ev).every((key) => allowed.has(key))));
    b.loadSnapshot(data); near(b.laneStats(b.B.laneById.get('work'), Date.now()).avg, 10);
    assert.ok(b.laneStats(b.B.laneById.get('cc'), Date.now()).avg > 0);
    assert.equal(b.B.laneById.get('work').rate_events.length, 1203);
  }
  const ready = (_frame, frames) => new Set(frames.filter((m) => m.event === 'backlog').map((m) => m.data.run)).size === 2;
  for (let i = 0; i < 2; i++) {
    await collect(f.address, b, ready);
    near(b.laneStats(b.B.laneById.get('work'), Date.now()).avg, 10);
    assert.equal(b.B.laneById.get('work').rate_events.length, 1203);
  }
  let rewritten = false;
  const frames = await collect(f.address, b, (_m, list) => list.some((m) => m.event === 'backlog' && m.data.reset)
    && list.some((m) => m.event === 'run' && m.data.id === 'cc' && m.data.usage.output === 5990), (_m, list) => {
    if (!rewritten && ready(_m, list)) {
      rewritten = true; f.work(1200, 20);
      const row = f.assistant(500, 1000); row.timestamp = new Date(f.base + 550000).toISOString();
      fs.appendFileSync(f.transcript, JSON.stringify(row) + '\n');
    }
  });
  const reset = frames.find((m) => m.event === 'backlog' && m.data.reset);
  assert.equal(reset.data.events.length, 200); assert.equal(reset.data.rate_events.length, 1203);
  near(b.laneStats(b.B.laneById.get('work'), Date.now()).avg, 20);
  const cc = b.B.laneById.get('cc'), stats = b.laneStats(cc, Date.now());
  assert.equal(frames.filter((m) => m.event === 'ev' && m.data.k === 'usage').length, 0);
  assert.equal(stats.output, 5990);
  near(stats.avg, 5990 / (b.segments(cc).reduce((n, s) => n + s.b - s.a, 0) / 1000));
  f.work(20005, 1);
  const limited = await snapshot(); b.loadSnapshot(limited);
  assert.equal(limited.rate_events.filter((ev) => ev.run === 'work').length, b.RATE_EVENTS_MAX);
  assert.equal(b.B.laneById.get('work').rate_events.length, b.RATE_EVENTS_MAX);
  assert.equal(b.laneStats(b.B.laneById.get('work'), f.base + 20005000).avg, null);
});
