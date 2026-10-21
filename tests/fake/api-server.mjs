import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { discussion } from '../fixtures/reports.mjs';

export async function apiServer(t, scenarios = [{}], { models } = {}) {
  const requests = [];
  const gates = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'GET' && req.url === '/models') {
      // 模型清单不计入 requests，不影响按序号挑选的对话剧本
      if (!models) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: models.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    const index = requests.length;
    requests.push({ url: req.url, method: req.method, body });
    if (req.url !== '/chat/completions') { res.writeHead(404).end(); return; }
    const scene = scenarios[index] || scenarios.at(-1);
    if (scene.status || (scene.reject_format && body.response_format)) {
      res.writeHead(scene.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: scene.message || 'response_format unsupported' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
    const data = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (scene.queued) res.write(': keep-alive\n\n');
    if (scene.gate) {
      await new Promise((resolve) => {
        gates.set(scene.gate, resolve);
        res.once('close', resolve);
      });
      gates.delete(scene.gate);
    }
    if (res.destroyed) return;
    for (const step of scene.steps || []) {
      if (step.delay_ms) await pause(step.delay_ms);
      if (step.comment) res.write(`: ${step.comment}\n\n`);
      if (step.data) data(step.data);
    }
    data({ choices: [{ delta: { reasoning_content: scene.reasoning ?? '合成思考' } }] });
    const answer = scene.answer ?? discussion;
    data({ choices: [{ delta: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }] });
    if (scene.disconnect) { res.end(); return; }
    data({ choices: [{ delta: {}, finish_reason: 'stop' }], ...(scene.usage === null ? {} : { usage: scene.usage || {
      prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 20 },
      completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 10 },
    } }) });
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const release of gates.values()) release();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, release: (name) => gates.get(name)?.() };
}
