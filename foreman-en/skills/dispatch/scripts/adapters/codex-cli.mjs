// Codex CLI：参数、进程事件、会话用量、生成图片和环境检查。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCHEMA, DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { newRunDir } from '../records.mjs';
import { execute, eventWriter, watchCancellation, spawnCli, validateSchema } from '../runner.mjs';
import { readImageCalls, missingReferences } from '../image-calls.mjs';
import { M, die, isObject, binCommand, pathCommand, npmEntry, killTree, isReconnect, readAttachments, readImages, focusFiles, closestMatches } from '../util.mjs';

const capabilities = { modes: ['run', 'review', 'discuss'], isolation: 'os', reads_code: true, reads_images: true, native_schema: true, native_review: true, images: true, resume: true, command_start_events: true };

// 模型、推理强度、沙箱、审批这几项 exec / resume / review 都接受 -m 和 -c。
function codexOptions(agent, { model, effort, mode }) {
  const args = [];
  if (model) args.push('-m', model);
  if (effort != null) args.push('-c', `model_reasoning_effort="${effort}"`);
  if (agent.sandbox?.[mode]) args.push('-c', `sandbox_mode="${agent.sandbox[mode]}"`);
  args.push('-c', `approval_policy="${agent.approval ?? 'never'}"`);
  return args;
}

function codexCommand(agent) {
  if (process.env.CODEX_BIN || agent?.bin) return binCommand(process.env.CODEX_BIN || agent.bin);
  if (process.platform !== 'win32') return pathCommand('codex');
  // Windows 的 npm 包装不能直接 spawn，改用包内入口，避开 shell 引号问题。
  return binCommand(npmEntry('@openai', 'codex', 'bin', 'codex.js') || 'codex.exe');
}

// 读 Codex 的 config.toml 里的一个字符串值：不给表名时只看第一个 [表] 之前的顶层键。读不到返回 null。
function codexConfigValue(key, table = null) {
  const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const part = table == null ? text.split(/^\s*\[/m)[0] : (text.split(new RegExp(`^\\s*\\[${table}\\]\\s*$`, 'm'))[1] || '').split(/^\s*\[/m)[0];
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(part)?.[1] || null;
}

// 没配置模型时从 Codex 的配置读出实际模型名，只用于显示，让用户知道用的是哪个模型。
const codexConfigModel = () => codexConfigValue('model');

function readonlyLevel(agent, kind) {
  // 只按这次实际生效的沙箱分级，未声明时不能假定 Codex 会启用只读沙箱。
  return (agent.sandbox?.[kind] || codexConfigValue('sandbox_mode')) === 'read-only' ? 'sandbox' : 'audited';
}

// Codex 的沙箱启动不了命令时的报错（Windows 沙箱设置坏了最常见）；只在命令失败时匹配，避免误判正常输出。
const SANDBOX_ERROR = /windows sandbox failed|helper_unknown_error|setup refresh had errors|failed to create unified exec process|sandbox (?:setup )?(?:failed|error)/i;
const SANDBOX_MARK = 'foreman-sandbox-ok';

// 用 codex sandbox 在沙箱里跑一条 echo，不调用模型。ok 为 null 表示这个版本的 Codex 没法这样探测。
function probeSandbox(agent, mode, extra = []) {
  const { file, pre } = codexCommand(agent);
  const command = process.platform === 'win32' ? ['cmd', '/c', 'echo', SANDBOX_MARK] : ['echo', SANDBOX_MARK];
  const r = spawnSync(file, [...pre, 'sandbox', ...extra, '-c', `sandbox_mode="${mode}"`, '--', ...command],
    { encoding: 'utf8', windowsHide: true, timeout: 60000, cwd: os.tmpdir() });
  if ((r.stdout || '').includes(SANDBOX_MARK)) return { ok: true, error: null };
  const error = r.error?.message || (r.stderr || '').trim().split(/\r?\n/).pop() || `exit ${r.status}`;
  return { ok: /unrecognized subcommand|unexpected argument|invalid value/i.test(error) ? null : false, error };
}

// 这个协作方在各类任务里实际用的沙箱：foreman 配置里写了就用它，否则用 Codex 自己的 sandbox_mode。
// danger-full-access 不进沙箱，不用探测；都没写时按只读探测，沙箱本身坏了任何模式都起不来。
function checkSandbox(agent, modes) {
  const configured = codexConfigValue('sandbox_mode');
  const byMode = new Map();
  for (const mode of modes) {
    const value = agent.sandbox?.[mode] || configured || null;
    if (value === 'danger-full-access') continue;
    const key = value || 'read-only';
    byMode.set(key, [...(byMode.get(key) || []), mode]);
  }
  if (!byMode.size) return null;
  const checked = [...byMode].map(([mode, used_in]) => ({ mode, used_in, ...probeSandbox(agent, mode) }));
  const windows = process.platform === 'win32' ? codexConfigValue('sandbox', 'windows') : null;
  // Windows 默认的 elevated 沙箱要先以管理员身份完成设置，坏了的时候 unelevated 往往还能用，顺带试一下。
  const unelevated = process.platform === 'win32' && windows !== 'unelevated' && checked.some((c) => c.ok === false)
    ? probeSandbox(agent, checked.find((c) => c.ok === false).mode, ['-c', 'windows.sandbox="unelevated"']).ok : null;
  return { checked, windows_sandbox: windows, unelevated_ok: unelevated };
}

// Codex 内置 image_gen 出的图存在 <CODEX_HOME>/generated_images/<会话 id>/ 下，按生成先后返回完整路径。
function generatedImages(sessionId) {
  if (!sessionId) return [];
  const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images', sessionId);
  try {
    return fs.readdirSync(dir).map((f) => path.join(dir, f))
      .map((file) => [file, fs.statSync(file).mtimeMs]).sort((a, b) => a[1] - b[1]).map(([file]) => file);
  } catch { return []; }
}

function runCodex({ agent, args, cwd, prompt, runDir, timeoutMin, stallMin, sessionId, onSession }) {
  return new Promise((resolve) => {
    const { file, pre } = codexCommand(agent);
    const events = fs.createWriteStream(path.join(runDir, 'events.jsonl'));
    const errLog = fs.createWriteStream(path.join(runDir, 'stderr.log'));
    const event = eventWriter(runDir, events);
    const out = { code: null, sessionId: null, usage: null, errors: [], warnings: [], notes: [], sandboxError: null, fileChanges: new Set(), images: [], imageCalls: [], quotaExhausted: false, timedOut: false, stalled: false, cancelled: false, commands: 0, messages: [], questions: [] };
    const startedAt = Date.now();
    const runningCommands = new Set();
    let lastEventAt = Date.now();
    const child = spawnCli(file, [...pre, ...args], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    }, {
      busy: () => runningCommands.size > 0,
      onInput: (line, min) => {
        out.needsInput = true;
        out.questions.push({ source: 'input_prompt', question: line });
        out.errors.push(M.inputWaitDetected(min, line));
      },
    });

    const onSignal = () => { killTree(child.pid); process.exit(130); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    let buf = '';
    const handle = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return null; }
      lastEventAt = Date.now();
      // 只认写完的改动：沙箱挡下的补丁也会有 file_change 事件，状态是 failed。
      if (ev.type === 'item.completed' && ev.item?.type === 'file_change' && ev.item.status !== 'failed') {
        for (const change of ev.item.changes || []) out.fileChanges.add(change.path);
      }
      if (ev.item?.type === 'command_execution') {
        if (ev.type === 'item.started') runningCommands.add(ev.item.id);
        else if (ev.type === 'item.completed') runningCommands.delete(ev.item.id);
      }
      if (ev.type === 'thread.started') { out.sessionId = ev.thread_id; onSession?.(ev.thread_id); }
      else if (ev.type === 'turn.completed') out.usage = ev.usage;
      else if (ev.type === 'turn.failed') out.errors.push(ev.error?.message || JSON.stringify(ev));
      else if (ev.type === 'error') (isReconnect(ev.message) ? out.warnings : out.errors).push(ev.message || JSON.stringify(ev));
      else if (ev.type === 'item.completed' && ev.item?.type === 'error') out.warnings.push(ev.item.message);
      else if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
        out.commands++;
        const failed = ev.item.exit_code !== 0 && SANDBOX_ERROR.exec(String(ev.item.aggregated_output || ''));
        if (failed && !out.sandboxError) out.sandboxError = String(ev.item.aggregated_output).trim().split(/\r?\n/).find((l) => SANDBOX_ERROR.test(l)).slice(0, 300);
      }
      else if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') out.messages.push(ev.item.text || '');
      return ev;
    };
    // 每个事件记下收到的时间，watch 回放时也能显示时间线
    const record = (line) => {
      const ev = handle(line);
      if (ev) event(ev);
      else events.write(`${line}\n`);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { record(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.pipe(errLog);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      const text = (out.stderrTail || '') + c;
      if (/usage limit|quota/i.test(text)) out.quotaExhausted = true;
      out.stderrTail = text.slice(-4000);
    });

    const timer = setTimeout(() => { out.timedOut = true; killTree(child.pid); }, timeoutMin * 60000);
    const stallCheck = setInterval(() => {
      if (!stallMin || runningCommands.size || Date.now() - lastEventAt < stallMin * 60000) return;
      out.stalled = true;
      out.errors.push(M.stalled(stallMin));
      clearInterval(stallCheck);
      killTree(child.pid);
    }, 30000);
    // cancel 命令或实时查看里按 x 会在记录目录里留一个终止标记
    const cancelCheck = watchCancellation(runDir, () => {
      out.cancelled = true;
      clearInterval(cancelCheck);
      killTree(child.pid);
    });
    // exec --json 里没有出图事件：定时查看图片目录，新图记成 image.generated 事件给 watch 显示。
    // 续接时目录里已有的是上一轮的图，不算。
    const seenImages = new Set(generatedImages(sessionId));
    const scanImages = () => {
      for (const image of generatedImages(out.sessionId || sessionId)) {
        if (seenImages.has(image)) continue;
        seenImages.add(image);
        out.images.push(image);
        lastEventAt = Date.now();
        event({ type: 'image.generated', path: image });
      }
    };
    const imageCheck = setInterval(scanImages, 2000);
    const finish = (code) => {
      clearTimeout(timer);
      clearInterval(stallCheck);
      clearInterval(cancelCheck);
      clearInterval(imageCheck);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      if (buf.trim()) record(buf);
      scanImages();
      // 出了图、或者任务说明提到 image_gen 或参考图时，从会话记录读出每次出图的参数（会话记录可能很大，其他任务不读）。
      // 续接时会话记录里还有前几轮的调用，只取这一轮开始之后的（留 2 秒余量）。
      const file = (out.images.length || /image_gen|referenced_image_paths/.test(prompt)) && sessionFile(out.sessionId || sessionId, startedAt);
      out.imageCalls = file ? readImageCalls(file, startedAt - 2000) : [];
      // 只有任务说明里真的给了参考图（参数名后面跟着非空的路径数组，中间可以换行）才算要求传参考图；
      // "不传 referenced_image_paths"这类只提到参数名的写法、空数组都不算，否则全新出图也会被误报。
      if (/referenced_image_paths["'`]?\s*(?::|=|设为|改为|传入|为|set to|to)?\s*\[\s*["'`]/i.test(prompt) && missingReferences(out.imageCalls)) out.warnings.push(M.imageRefsMissing);
      // 沙箱坏了时 Codex 照样正常结束，只在报告里说命令起不来；提示 Claude 这不是任务本身的问题。
      if (out.sandboxError) out.notes.push(M.codexSandboxFailed(out.sandboxError));
      events.end();
      errLog.end();
      out.code = code;
      resolve(out);
    };
    child.on('error', (e) => { out.errors.push(M.spawnFailed(e.message)); finish(-1); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* codex 提前退出时忽略 EPIPE */ });
    child.stdin.end(prompt, 'utf8');
  });
}

// Codex 的会话记录按开始日期放在 sessions/年/月/日 下；续接的会话还在最初那天的目录里，所以从开始日期往前找。
function sessionFile(sessionId, startedAt) {
  if (!sessionId) return null;
  const root = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  const day = new Date(startedAt || Date.now());
  for (let i = -1; i <= 60; i++) {
    const d = new Date(day.getTime() - i * 86400000);
    const dir = path.join(root, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try {
      const file = fs.readdirSync(dir).find((f) => f.includes(sessionId));
      if (file) return path.join(dir, file);
    } catch { /* 没有这天的目录 */ }
  }
  return null;
}

// 从 Codex 自己的会话记录里读最后一次 token 统计：累计用量、最近一次请求、窗口和额度。
// exec --json 只在结尾给一次总用量，这些数只有会话记录里有。找不到就返回 null。
function codexSessionStats(sessionId, startedAt) {
  const file = sessionFile(sessionId, startedAt);
  if (!file) return null;
  const st = fs.statSync(file);
  const len = Math.min(st.size, 1024 * 1024);
  const chunk = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, chunk, 0, len, st.size - len); } finally { fs.closeSync(fd); }
  const lines = chunk.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    let p;
    try { p = JSON.parse(lines[i]).payload; } catch { continue; }
    const last = p?.info?.last_token_usage;
    const rl = p?.rate_limits?.primary;
    return {
      total_token_usage: p?.info?.total_token_usage || null,
      last_request: last && p.info.model_context_window ? { tokens: last.total_tokens ?? last.input_tokens, window: p.info.model_context_window } : null,
      rate_limit: rl ? { used_percent: rl.used_percent, window_minutes: rl.window_minutes, resets_at: rl.resets_at } : null,
    };
  }
  return null;
}

function validate(agent, key, check, text) {
  const why = M.invalid;
  for (const field of ['bin', 'approval']) check(agent[field] == null || text(agent[field]), `${key}.${field}`, why.stringOrNull);
  check(agent.sandbox == null || isObject(agent.sandbox), `${key}.sandbox`, why.object);
  for (const [mode, value] of Object.entries(agent.sandbox || {})) check(['run', 'review', 'discuss'].includes(mode) && (value === null || ['read-only', 'workspace-write', 'danger-full-access'].includes(value)), `${key}.sandbox.${mode}`, why.sandbox);
}

// 本机 Codex 的模型清单：每个模型支持的推理强度、默认档位、上下文窗口。读不到时返回 ok: false，不影响其他检查。
function codexCatalog(agent = {}) {
  const { file, pre } = codexCommand(agent);
  const r = spawnSync(file, [...pre, 'debug', 'models'], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  try {
    if (r.error || r.status !== 0) throw new Error(r.error?.message || (r.stderr || '').trim().split('\n').pop() || `exit ${r.status}`);
    const models = JSON.parse(r.stdout).models.map((m) => ({
      id: m.slug, name: m.display_name || m.slug, efforts: (m.supported_reasoning_levels || []).map((e) => e.effort),
      default_effort: m.default_reasoning_level ?? null, context: m.context_window ?? null, description: m.description || null,
      hidden: m.visibility !== 'list',
    }));
    return { ok: true, source: 'codex debug models', models, error: null };
  } catch (e) { return { ok: false, source: 'codex debug models', models: [], error: e.message }; }
}

// 配置的推理强度按清单核对，不发请求；清单读不到或模型不在清单里时只提示，不判失败。
function codexEfforts(name, agent, efforts, catalog) {
  if (!efforts.length && agent.model == null) return {};
  const cat = catalog();
  if (!cat.ok) return { catalog: { ok: false, error: cat.error }, efforts: [] };
  const out = { catalog: { ok: true }, efforts: [] }, unsupported = [];
  for (const item of efforts) {
    const model = cat.models.find((m) => m.id === item.model);
    if (!model) { out.efforts.push({ ...item, ok: null, error: M.modelNotInCatalog(item.model) }); continue; }
    const ok = model.efforts.includes(item.variant);
    out.efforts.push({ ...item, ok, error: ok ? null : M.effortNotInCatalog(item.variant, M.list(model.efforts)) });
    if (!ok) unsupported.push({ ...item, supported: model.efforts });
  }
  const own = agent.model && cat.models.some((m) => m.id === agent.model);
  if (agent.model && !own) out.model_note = M.modelNotInCatalog(agent.model, M.list(closestMatches(agent.model, cat.models.map((m) => m.id))));
  if (unsupported.length) out.unsupported = unsupported;
  return out;
}

function checkCodex(name, agent, efforts = [], catalog = () => codexCatalog(agent), modes = []) {
  const { file, pre } = codexCommand(agent);
  const codex = (args) => spawnSync(file, [...pre, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const version = codex(['--version']);
  const installed = !version.error && version.status === 0;
  const login = installed ? codex(['login', 'status']) : null;
  const loginText = login ? `${login.stdout}${login.stderr}`.trim() : null;
  const loggedIn = !!login && login.status === 0 && !/not logged in/i.test(loginText);
  const out = {
    ok: installed && loggedIn, version: installed ? version.stdout.trim() : null, login: loginText,
    model: agent.model || codexConfigModel(),
    fix: !installed ? M.fixCodexMissing : loggedIn ? null : M.fixCodexLogin,
  };
  if (!out.ok) return out;
  const { unsupported, ...checked } = codexEfforts(name, agent, efforts.map((e) => ({ ...e, model: e.model || out.model })), catalog);
  Object.assign(out, checked);
  if (unsupported) {
    out.ok = false;
    out.fix = M.fixEffortUnsupported(name, M.list(unsupported.map((u) => M.effortAt(u.variant, M.list(u.used_at), u.model, M.list(u.supported)))));
  }
  const sandbox = checkSandbox(agent, modes);
  if (sandbox) {
    out.sandbox = sandbox;
    const broken = sandbox.checked.filter((c) => c.ok === false);
    if (broken.length) {
      out.ok = false;
      out.fix = [out.fix, M.fixCodexSandbox(name, broken[0].error, M.list(broken.flatMap((c) => c.used_in).map((m) => M.modeNames[m])), sandbox.unelevated_ok)].filter(Boolean).join('\n');
    }
  }
  return out;
}

async function executeCodex(ctx) {
  const { agent, model, effort, cwd, mode, kind, brief, opts: o, addDirs = [], git } = ctx;
  const readonly = kind === 'exec' ? undefined : readonlyLevel(agent, kind);
  if (readonly === 'audited' && o['no-snapshot']) die(M.auditedNoSnapshot(kind));
  const files = ctx.reviewTarget === 'visual' ? readImages(o.file, cwd)
    : mode !== 'run' ? readAttachments(o.file, cwd, false) : [];
  const nativeReview = kind === 'review' && git && ctx.reviewTarget === 'diff' && !brief && !files.length;
  const { id, dir, release } = await newRunDir();
  const last = path.join(dir, 'last-message.txt');
  let args, prompt;
  if (mode === 'run') {
    args = ['exec', '--json', '--skip-git-repo-check', ...codexOptions(agent, { model, effort, mode: 'run' }),
      '-C', cwd, '--output-schema', SCHEMA, '-o', last];
    for (const d of addDirs) args.push('--add-dir', d);
    args.push('-');
    prompt = `${brief}\n\n${M.footer(cwd, addDirs)}\n`;
  } else if (mode === 'discuss') {
    args = ['exec', '--json', '--skip-git-repo-check', ...codexOptions(agent, { model, effort, mode: 'discuss' }),
      '-C', cwd, '--output-schema', DISCUSS_SCHEMA, '-o', last, '-'];
    prompt = `${brief}${focusFiles(files)}\n\n${M.discussFooter(cwd)}\n`;
  } else if (mode === 'resume') {
    const discuss = kind === 'discuss';
    args = ['exec', 'resume', '--json', '--skip-git-repo-check', ...codexOptions(agent, { model, effort, mode: discuss ? 'discuss' : 'run' }),
      '--output-schema', discuss ? DISCUSS_SCHEMA : SCHEMA, '-o', last, ctx.sessionId, '-'];
    prompt = `${brief}${focusFiles(files)}\n\n${discuss ? M.discussResumeFooter : M.resumeFooter}\n`;
  } else {
    const codexOpts = codexOptions(agent, { model, effort, mode: 'review' });
    if (nativeReview) {
      // 原生审查不能附加说明或重点文件，只有无附件的 git diff 审查使用它。
      args = ['exec', 'review', '--json', ...codexOpts, '-o', last];
      if (o.base) args.push('--base', o.base);
      else if (o.commit) args.push('--commit', o.commit);
      else args.push('--uncommitted');
      if (o.title) args.push('--title', o.title);
      prompt = '';
    } else {
      args = ['exec', '--json', '--skip-git-repo-check', ...codexOpts, '-C', cwd, '--output-schema', REVIEW_SCHEMA, '-o', last, '-'];
      const opening = { files: M.reviewPromptFiles, claims: M.reviewPromptClaims, visual: M.reviewPromptVisual }[ctx.reviewTarget];
      prompt = `${opening ? opening(cwd) : git ? M.reviewPromptGit(cwd, ctx.reviewScope.description) : M.reviewPromptPlain(cwd)}\n\n${brief}${focusFiles(files)}\n\n${M.reviewFooter}\n`;
    }
  }
  return execute({ ...ctx, readonly, nativeReview, id, dir, release, args, prompt, expectReport: !nativeReview }, {
    capabilities, run: runCodex, stats: codexSessionStats,
    schema: JSON.parse(fs.readFileSync(kind === 'discuss' ? DISCUSS_SCHEMA : kind === 'review' ? REVIEW_SCHEMA : SCHEMA, 'utf8')), validate: validateSchema,
    describe: () => {
      const sandbox = agent.sandbox?.[kind === 'exec' ? 'run' : kind] || null;
      // model 为 null 时实际模型由 Codex 配置决定，model_shown 是给人看的实际模型名。
      const modelShown = model || M.modelFromCodex(codexConfigModel() || M.unknownModel);
      return { sandbox, modelShown, modelName: model || codexConfigModel() || null };
    },
  });
}

export default {
  type: 'codex cli', capabilities, readonlyLevel,
  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  defaultEffort: (level) => ({ simple: 'medium', normal: 'high', complex: 'max' })[level], channel: M.channel.codex,
  validate,
  status: (agent) => ({ model: agent.model || codexConfigModel(), bin: codexCommand(agent).file }),
  check: checkCodex,
  catalog: codexCatalog,
  execute: executeCodex,
  validateResume: (parent) => { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
  locate: codexCommand,
  stats: codexSessionStats,
};
