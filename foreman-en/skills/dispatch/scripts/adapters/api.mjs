// API：兼容 OpenAI 的流式请求、重试、材料、用量、配置校验和检查项。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ENTRY, DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { newRunDir, cancelSource } from '../records.mjs';
import { startRun, finishDiscussion, eventWriter, runLimits, watchCancellation, reportWithRepair, validateSchema } from '../runner.mjs';
import { M, die, isObject, readAttachments, MAX_MATERIAL_CHARS, modelOf } from '../util.mjs';
import { D, modelLabel } from '../format.mjs';

// 回答和报错里出现 key 时打码。key 太短时不替换，否则会把正文里的普通字母也换掉，弄坏 JSON 报告。
const redactKey = (s, key) => (key && key.length >= 8 ? s.replaceAll(key, '[REDACTED]') : s);

// 兼容 OpenAI 的接口各家缓存字段名不同：DeepSeek 是 prompt_cache_hit_tokens，OpenAI 是 prompt_tokens_details.cached_tokens。
const apiUsage = (u) => ({
  input_tokens: u?.prompt_tokens || 0,
  cached_input_tokens: u?.prompt_cache_hit_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0,
  output_tokens: u?.completion_tokens || 0,
  reasoning_output_tokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
});

// 配置里直接写的 api_key 优先（看得见，也不会被忘了删的旧环境变量顶替），没有再读 api_key_env 指向的环境变量。
const apiKeyOf = (agent) => (agent.api_key ? { key: agent.api_key, source: 'config' }
  : process.env[agent.api_key_env] ? { key: process.env[agent.api_key_env], source: 'env' } : { key: null, source: null });

const readonlyLevel = (agent, kind) => 'tools';

async function executeApi(ctx) {
  const { cfg, agentName, agent, model, effort, level, cwd, brief, mode, opts } = ctx;
  const apiKey = apiKeyOf(agent).key;
  if (!apiKey) die(M.apiKeyMissing(agentName, agent.api_key_env));
  const modelShown = agent.extra_body?.model ?? model;
  const review = ctx.kind === 'review', target = ctx.reviewTarget, scope = ctx.reviewScope;
  const schemaText = fs.readFileSync(review ? REVIEW_SCHEMA : DISCUSS_SCHEMA, 'utf8');
  const schema = JSON.parse(schemaText);
  let history = [{ role: 'system', content: review ? M.apiReviewSystem(schemaText) : M.apiDiscussSystem(schemaText) }];
  if (ctx.parent) {
    const file = path.join(ctx.parentDir, 'messages.json');
    if (!fs.existsSync(file)) die(M.apiNoMessages(ctx.parent));
    history = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  const files = readAttachments(opts.file, cwd, true);
  let prompt = brief;
  if (review) {
    prompt = `${target === 'diff' && !scope ? M.reviewPromptPlain(cwd) : M.apiReviewPrompt[target](scope?.description)}\n\n${brief}`;
    if (scope?.target === 'diff') {
      const fileList = scope.files.map((f) => `- ${f.status} ${f.old_path ? `${f.old_path} → ` : ''}${f.path}`
        + (f.binary ? M.reviewFileBinary : '') + (f.too_large ? M.reviewFileTooLarge : '')).join('\n');
      const longest = (scope.patch.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 2);
      prompt += `\n\n${M.reviewMaterial(fileList, scope.patch, '`'.repeat(longest + 1))}`;
    }
  }
  if (!ctx.parent || files.length) {
    const git = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    const list = git.status === 0 ? git.stdout.split('\0').filter(Boolean) : [];
    if (list.length || files.length) prompt +=`\n\n${M.apiMaterials(list.slice(0, 300).join('\n'), list.length, files)}`;
  }
  if (prompt.length > MAX_MATERIAL_CHARS) die(review && target === 'diff' ? M.reviewTooLarge(prompt.length, MAX_MATERIAL_CHARS)
    : M.materialsTooLarge(prompt.length, MAX_MATERIAL_CHARS, M.list(files.map((f) => `${f.shown}: ${f.chars}`))));
  if (ctx.parent) prompt += `\n\n${M.apiResumeFooter}`;
  history = [...history, { role: 'user', content: prompt }];
  const { id, dir, release } = await newRunDir();
  const run = startRun({ ...ctx, readonly: readonlyLevel(agent, ctx.kind), id, dir, release, sessionId: null }, { modelShown });
  const { started, meta } = run;
  const { deadline, stallMin } = runLimits(ctx, started);
  const redact = (s) => redactKey(s, apiKey);
  const event = eventWriter(dir);
  fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(history, null, 2));
  process.stderr.write(`foreman: ${D.started(mode, modelLabel(meta), level, dir)}\n`);
  // 提醒 Claude 在后台启动排队检查：服务繁忙时好及时问用户要不要终止这一方
  if (cfg.dispatch.busy_ask_min > 0) {
    const target = meta.group != null ? `--group ${meta.group}` : `--run ${id}`;
    process.stderr.write(`foreman: ${M.busyHint(`node "${ENTRY}" await-busy ${target}`, cfg.dispatch.busy_ask_min)}\n`);
  }
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  let gotUsage = false;
  let completedRequests = 0, requestsWithUsage = 0;
  const notes = [];
  const warnings = [];
  const errors = [];
  // cancel 命令或实时查看里按 x 会在记录目录里留一个终止标记，看到就中止请求
  const cancel = new AbortController();
  const cancelCheck = watchCancellation(dir, () => cancel.abort());
  const cancelled = () => Object.assign(new Error('Cancelled by the user'), { kind: 'cancelled' });
  let attempt = 0;
  let retried = false;
  let formatRemoved = false;
  let last = '';
  let report = null;
  const request = async (messages) => {
    for (;;) {
      if (cancel.signal.aborted) throw cancelled();
      if (Date.now() >= deadline) {
        event({ type: 'api.error', kind: 'timeout', status: null, message: 'Run timed out' });
        throw Object.assign(new Error('Run timed out'), { kind: 'timeout' });
      }
      const body = { model, messages, stream: true, stream_options: { include_usage: true },
        ...(effort != null ? { reasoning_effort: effort } : {}), response_format: { type: 'json_object' }, ...agent.extra_body };
      if (formatRemoved) delete body.response_format;
      event({ type: 'api.request', attempt: ++attempt, model: body.model, effort: body.reasoning_effort ?? null });
      try {
        const reply = await chatStream({ url: agent.base_url, apiKey, body, timeoutMs: deadline - Date.now(), stallMs: stallMin * 60000, signal: cancel.signal,
          onEvent: (ev) => {
            if (ev.type === 'api.usage') {
              gotUsage = true;
              ev.usage = apiUsage(ev.usage);
              for (const key of Object.keys(usage)) usage[key] += ev.usage[key];
            }
            if (ev.text) ev.text = redact(ev.text);
            event(ev);
          },
        });
        completedRequests++;
        if (reply.usage) requestsWithUsage++;
        // 去掉 response_format 后成功了，才说明 400 是它引起的；模型名写错之类的 400 不该归到它头上。
        if (formatRemoved && !notes.includes(M.apiNoResponseFormat)) notes.push(M.apiNoResponseFormat);
        return reply;
      } catch (e) {
        event({ type: 'api.error', kind: e.kind, status: e.status ?? null, message: redact(e.message), ...(e.waited_s != null ? { waited_s: e.waited_s } : {}) });
        if (e.kind === 'bad_request' && body.response_format && !formatRemoved) {
          formatRemoved = true;
          event({ type: 'api.retry', reason: 'response_format', wait_s: 0 });
          continue;
        }
        if (!retried && ['network', 'rate_limit', 'server', 'stall', 'busy'].includes(e.kind)) {
          retried = true;
          const wait = e.kind === 'busy' ? 30 : 5; // 服务繁忙时隔久一点再排
          event({ type: 'api.retry', reason: e.kind, wait_s: wait });
          // 等待重试时也随时响应终止
          await new Promise((done) => {
            const t = setTimeout(done, Math.min(wait * 1000, Math.max(0, deadline - Date.now())));
            cancel.signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
          });
          continue;
        }
        throw Object.assign(e, { retried });
      }
    }
  };
  try {
    let messages = history;
    report = await reportWithRepair({
      schema, validate: validateSchema, allowQuestion: !review,
      request: async () => {
        const reply = await request(messages);
        last = redact(reply.content);
        if (reply.finishReason === 'length') {
          event({ type: 'api.error', kind: 'length', status: null, message: M.apiTruncated(agentName) });
          throw Object.assign(new Error(M.apiTruncated(agentName)), { kind: 'length' });
        }
        return { last };
      },
      onInvalid: () => warnings.push(M.reportInvalid(agentName, path.join(dir, 'last-message.txt'))),
      repair: (invalid) => {
        event({ type: 'api.repair', errors: invalid });
        messages = [...history, { role: 'assistant', content: last }, { role: 'user', content: M.reportRepairPrompt(invalid.join('\n')) }];
      },
    });
    meta.status = 'done';
  } catch (e) {
    meta.status = { balance: 'quota_exhausted', stall: 'stalled', timeout: 'timeout', cancelled: 'cancelled' }[e.kind] || 'failed';
    const message = redact(e.message);
    errors.push(e.kind === 'balance' ? M.apiBalance(agentName, message) : e.kind === 'length' ? message
      : e.kind === 'cancelled' ? M.runCancelled(modelOf(meta), cancelSource(dir))
      : e.kind === 'busy' ? M.apiBusy(agentName, M.duration(e.waited_s || 0), e.retried)
      : M.apiError(agentName, e.kind, e.status, message));
  }
  clearInterval(cancelCheck);
  const usageMissing = !gotUsage || requestsWithUsage < completedRequests;
  if (usageMissing && meta.status !== 'cancelled') notes.push(M.apiUsageMissing);
  fs.writeFileSync(path.join(dir, 'last-message.txt'), last);
  fs.writeFileSync(path.join(dir, 'messages.json'), JSON.stringify(last || meta.status === 'done' ? [...history, { role: 'assistant', content: last }] : history, null, 2));
  return finishDiscussion(run, { usage: gotUsage && (meta.status === 'cancelled' || !usageMissing) ? usage : null, errors, notes, warnings, report, last, files, changesNote: M.apiNoChanges });
}

// 厂商接口列出的模型 ID。兼容 OpenAI 的接口一般都有 /models，但不给推理强度，那部分要查厂商文档。
async function apiCatalog(agent) {
  const { key } = apiKeyOf(agent);
  const source = `GET ${agent.base_url.replace(/\/+$/, '')}/models`;
  if (!key) return { ok: false, source, models: [], error: M.apiKeyMissing('', agent.api_key_env) };
  try {
    const response = await fetch(`${agent.base_url.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = (body.data || body.models || []).map((m) => ({ id: m.id ?? m.name, name: m.id ?? m.name, efforts: null, default_effort: null, context: m.context_length ?? null }));
    return { ok: true, source, models, error: null };
  } catch (e) { return { ok: false, source, models: [], error: redactKey(e.message, key) }; }
}

async function checkApiAgent(name, agent) {
  const { key: apiKey, source } = apiKeyOf(agent);
  const out = { ok: false, model: agent.model, base_url: agent.base_url, api_key_env: agent.api_key_env ?? null, key_set: !!apiKey, key_source: source };
  if (!apiKey) return { ...out, fix: M.fixApiKey(name, agent.api_key_env) };
  const started = Date.now();
  try {
    const reply = await chatStream({
      url: agent.base_url, apiKey, timeoutMs: 120000, stallMs: 60000,
      body: { model: agent.model, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], stream: true, stream_options: { include_usage: true }, ...agent.extra_body },
    });
    return { ...out, ok: true, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), reply: redactKey(reply.content, apiKey).trim().slice(0, 40), usage: apiUsage(reply.usage), fix: null };
  } catch (e) {
    const fix = { auth: M.fixApiAuth(name, source, agent.api_key_env), balance: M.fixApiBalance, bad_request: M.fixApiRequest(name), network: M.fixApiNetwork(agent.base_url), busy: M.fixApiBusy }[e.kind] || M.fixApiRetry;
    return { ...out, error: `${e.kind}${e.status ? ` ${e.status}` : ''}: ${redactKey(e.message, apiKey)}`, fix };
  }
}


function apiError(kind, message, status) {
  return Object.assign(new Error(message), { kind, status });
}

export async function chatStream({ url, apiKey, body, timeoutMs, stallMs, signal, onEvent = () => {} }) {
  const controller = new AbortController();
  let abortKind = null;
  const abort = (kind) => { abortKind ??= kind; controller.abort(); };
  // 调用方要求终止（用户取消）
  if (signal?.aborted) abort('cancelled');
  else signal?.addEventListener('abort', () => abort('cancelled'), { once: true });
  const timeout = setTimeout(() => abort('timeout'), timeoutMs);
  let stall;
  const activity = () => {
    clearTimeout(stall);
    if (stallMs > 0) stall = setTimeout(() => abort('stall'), stallMs);
  };
  activity();
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = null;
  let completed = false;
  // 服务繁忙时，请求会先在服务端排队：连接保持着，只有保活注释行（": keep-alive"），没有数据。
  const startedAt = Date.now();
  let gotData = false;
  let keepalives = 0;
  let queuedEventAt = 0;
  let pendingContent = '';
  let pendingReasoning = '';
  const flush = () => {
    if (pendingReasoning) onEvent({ type: 'api.reasoning', text: pendingReasoning, total_chars: reasoning.length });
    if (pendingContent) onEvent({ type: 'api.content', text: pendingContent, total_chars: content.length });
    pendingReasoning = pendingContent = '';
  };
  const batches = setInterval(flush, 1000);
  let reader;
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    activity(); // 收到响应头也算有动静，卡死只按之后的数据间隔算
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    if (!response.ok) {
      const status = response.status;
      const kind = status === 401 || status === 403 ? 'auth' : status === 402 ? 'balance'
        : status === 429 ? 'rate_limit' : status >= 500 ? 'server' : 'bad_request';
      let text = '';
      // 错误体只用来补充说明；读不完（超时、断开）时仍按状态码分类，不能被当成卡死或网络故障。
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          activity();
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch { /* 用已经读到的部分 */ }
      let message;
      try { message = JSON.parse(text).error?.message; } catch { /* 非 JSON 错误只保留短摘要 */ }
      throw apiError(kind, message || text.slice(0, 500) || `HTTP ${status}`, status);
    }
    let buffer = '';
    let data = [];
    let ended = false;
    const dispatch = () => {
      if (!data.length) return;
      const text = data.join('\n');
      data = [];
      if (!text.trim()) return; // SSE 规范里 data 为空的事件不派发
      gotData = true;
      if (text.trim() === '[DONE]') { ended = true; return; }
      let event;
      try { event = JSON.parse(text); }
      catch { throw apiError('network', 'Invalid JSON in SSE data'); }
      if (event.error) throw apiError('server', event.error.message || 'Stream error');
      const choice = event.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) { reasoning += delta.reasoning_content; pendingReasoning += delta.reasoning_content; }
      if (delta?.content) {
        // 首段回答及时展示，后续按批次写事件。
        const first = !content;
        content += delta.content;
        pendingContent += delta.content;
        if (first) flush();
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (event.usage) usage = event.usage;
      if (pendingContent.length + pendingReasoning.length >= 2000) flush();
    };
    const line = (text) => {
      if (!text) dispatch();
      else if (text.startsWith('data:')) data.push(text.slice(5).replace(/^ /, ''));
      else if (text.startsWith(':') && !gotData) {
        keepalives++;
        // 还在排队：第一次马上报，之后每 30 秒报一次
        if (Date.now() - queuedEventAt >= 30000) {
          queuedEventAt = Date.now();
          onEvent({ type: 'api.queued', waited_s: Math.round((Date.now() - startedAt) / 1000) });
        }
      }
    };
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer) line(buffer.replace(/\r$/, ''));
        // 连接断在最后半行时，已经收到 finish_reason 就说明回答完整，残缺的尾巴不算错，免得整次重试。
        try { dispatch(); } catch (e) { if (!finishReason) throw e; }
        if (!ended && !finishReason) throw apiError('network', 'Stream ended before completion');
        break;
      }
      activity();
      buffer += decoder.decode(value, { stream: true });
      let i;
      while (!ended && (i = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, i).replace(/\r$/, ''));
        buffer = buffer.slice(i + 1);
      }
    }
    flush();
    completed = true;
    return { content, reasoning, usage, finishReason };
  } catch (error) {
    if (abortKind === 'cancelled') throw apiError('cancelled', 'Cancelled by the user');
    // 只收到过保活信号就断了或超时了：请求一直在服务端排队，没开始处理。
    if (!gotData && keepalives && (!error.kind || error.kind === 'network')) {
      const waited = Math.round((Date.now() - startedAt) / 1000);
      throw Object.assign(apiError('busy', abortKind === 'timeout' ? 'Still queued when the time limit was reached' : `Dropped by the server after ${waited}s in its queue`), { waited_s: waited });
    }
    if (error.kind) throw error;
    if (abortKind) throw apiError(abortKind, abortKind === 'stall' ? 'No bytes received within the stall limit' : 'Request timed out');
    // fetch / undici 的连接、headers 和 body 超时都按网络故障处理。
    throw apiError('network', error.message);
  } finally {
    clearTimeout(timeout);
    clearTimeout(stall);
    clearInterval(batches);
    // 先关连接，后面写事件出错也不会把连接留着。
    if (reader) await reader.cancel().catch(() => {});
    flush();
    if (usage) onEvent({ type: 'api.usage', usage });
    if (completed) onEvent({ type: 'api.done', finish_reason: finishReason });
  }
}


function validate(agent, key, check, text) {
  const why = M.invalid;
  for (const field of ['base_url', 'model']) check(text(agent[field]), `${key}.${field}`, why.nonEmpty);
  // api_key 写成空字符串表示还没填；没有 key 的协作方被选去讨论时才报错。
  check(agent.api_key === undefined || typeof agent.api_key === 'string', `${key}.api_key`, why.apiKeyText);
  check(agent.api_key_env === undefined || text(agent.api_key_env), `${key}.api_key_env`, why.nonEmpty);
  check(agent.extra_body === undefined || isObject(agent.extra_body), `${key}.extra_body`, why.object);
}

export default {
  type: 'api', capabilities: { modes: ['discuss', 'review'], isolation: 'none', reads_code: false, reads_images: false, native_schema: false, native_review: false, images: false, resume: true, command_start_events: false }, readonlyLevel, channel: M.channel.api,
  validate,
  status: (agent) => ({ api_key_env: agent.api_key_env ?? null, key_set: !!apiKeyOf(agent).key, key_source: apiKeyOf(agent).source }),
  check: checkApiAgent,
  catalog: apiCatalog,
  execute: executeApi,
};
