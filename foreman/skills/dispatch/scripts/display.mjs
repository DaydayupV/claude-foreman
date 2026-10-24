// 终端实时查看和网页看板共用的显示规则；这里只放纯函数和英文显示文字，网页构建时内联进页面
const GAP_ROLE = /^(补漏|gap)$/i;
const D = {
  conversation: (title) => title ? `this conversation · ${title}` : 'this conversation',
  watchImageHead: (mode, title, cell, mark) => `${mode} · ${title} · ${cell} · route ${mark}`,
  watchImageViewed: (file) => `Opened image ${file}`,
  watchStale: 'material changed during the review (stale)',
  watchNoUsage: 'no usage reported by the provider for this round',
  watchOutsideCwd: (shown, more) => `wrote outside the working directory: ${shown}${more ? ` and ${more} more` : ''}`,
  costUsd: (text) => `cost $${text}`,
  // 整轮平均速度包含命令和等待，与终端原有口径一致。
  outputSpeed: (n, partial) => `run avg ${n} tok/s${partial ? ' (partial usage)' : ''}`,
  list: (items) => items.join(', '),
  retryReasons: { network: 'Connection dropped', rate_limit: 'Rate limited', server: 'Server error', stall: 'No data for too long', response_format: "The API doesn't accept response_format", busy: 'Service busy; dropped after queuing too long' },
  watchApiRequest: (model, effort, attempt) => `Request sent: model ${model}, effort ${effort ?? 'default'}${attempt > 1 ? ` (attempt ${attempt})` : ''}`,
  watchApiAnswering: 'Writing the answer',
  watchApiRetry: (reason, s) => `${D.retryReasons[reason] ?? `Request failed (${reason})`}, ${s ? `retrying in ${s}s` : 'retrying now'}`,
  watchApiRepair: (errors) => `Report not in the required format, asking for a fix: ${errors}`,
  watchApiQueued: "Service busy; the request is queued and hasn't started",
  apiPhases: { thinking: 'thinking', answering: 'writing the answer', queued: 'queued' },
  watchApiQueuedLive: (time) => `${D.apiPhases.queued} ${time} (service busy)`,
  watchApiDequeued: (duration) => `Started after ${duration} in the queue`,
  watchApiDropped: (duration) => `Dropped by the server after ${duration} in the queue (service busy)`,
  watchRound: (n) => `round ${n}`,
  groupModes: { panel: 'panel', roles: 'roles', split: 'split' },
  dashKeysShort: (range, queued) => `${queued ? 'x stop · ' : ''}${range ? `${range} · ` : ''}↑↓ · q`,
  dashKeys: (range, queued, twoDigits = false) => `${queued ? 'x stop queued · ' : ''}${range ? `${range} open a seat${twoDigits ? ' (600ms for 2nd digit)' : ''} · ` : ''}↑↓ scroll · q quit`,
  statusResumed: 'resumed',
  dashAbove: (n) => `↑ ${n} more line${n === 1 ? '' : 's'} above`,
  dashBelow: (n) => `↓ ${n} more line${n === 1 ? '' : 's'} below`,
  dashAllFinished: 'all finished · q leaves and keeps the summary in this tab',
  dashAllFinishedShort: 'all finished',
  seatKeys: 'Esc back to the group · ↑↓ scroll · q quit',
  watchFinishedKeys: 'g top · ↑↓ scroll · q quit',
  watchFinishedNote: 'finished · q leaves and keeps the record in this tab',
  // 窄窗口先省略 run_id，保留跟随续接的按键提示。
  watchContinued: (id) => `↪ resumed as ${id} · press n to follow`,
  watchContinuedShort: '↪ resumed · press n to follow',
  watchContinuedTiny: '↪ resumed · press n',
  watchContinuedOut: (id) => `↪ resumed as ${id}`,
  watchAnswerSubmitted: (round) => `report submitted (round ${round})`,
  watchReplayOne: (command) => `replay a seat: ${command}`,
  dashCancelConfirm: (models) => `Press x again to stop ${models}, or any other key to cancel`,
  channel: { codex: 'Codex CLI', api: 'API', opencode: 'opencode CLI', pi: 'pi CLI' },
  modelLabel: (model, channel, effort, fromConfig) => `${model}${effort ? ` ${effort}` : ''} · ${channel}${fromConfig ? ' · model from Codex config' : ''}`,
  watchReview: {
    issues_found: (n, parts) => `${n} issue${n === 1 ? '' : 's'}${parts ? ` · ${parts}` : ''}`,
    no_issues: () => 'no issues',
    incomplete: (n) => `review incomplete${n ? ` · ${n} issue${n === 1 ? '' : 's'} so far` : ''}`,
  },
  severityNames: { high: 'high', medium: 'medium', low: 'low' },
  watchFinding: (f, severity) => `${f.id ? `${f.id} ` : ''}[${severity}] ${f.location ?? f.where}: ${f.issue ?? f.title}`,
  watchMoreFindings: (n) => `… ${n} more findings`,
  watchMoreQueued: (n) => `⋯ ${n} more waiting in the queue`,
  watchMoreQuestions: (n) => `… ${n} more question${n === 1 ? '' : 's'} (open the run's result for all of them)`,
  watchMoreErrors: (n) => `… ${n} more error${n === 1 ? '' : 's'} (open the run's result for all of them)`,
  watchUnverified: 'Not verified',
  dots: (parts) => parts.filter(Boolean).join(' · '),
  tokenCount: (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e4 ? Math.round(n / 1e3) >= 1000 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k` : Number(n).toLocaleString('en-US')),
  tokenSummary: (u, last, fmt, sessionTotal) => D.dots([
    `tokens: in ${fmt(u.input_tokens)} (cached ${u.input_tokens ? Math.round((u.cached_input_tokens / u.input_tokens) * 100) : 0}%)`,
    `out ${fmt(u.output_tokens)}${sessionTotal ? ' (session total)' : ''}`,
    last && D.lastRequestNow(last, fmt)]),
  lastRequestNow: (last, fmt) => `last request ${fmt(last.tokens)} / window ${fmt(last.window)}`,
  watchFallback: 'No run in progress; showing the most recent one:',
  watchWaiting: 'Waiting for a run to start…',
  watchHeaderLines: (mode, title, level, cwd, dir, model) => [`${mode} · ${title}${level ? ` · level ${level}` : ''}`, ...(model ? [`Model ${model}`] : []), `Working dir ${cwd}`, `Run dir ${dir}`],
  statusNames: { running: 'running', done: 'done', submitted: 'submitted', completed: 'done', partial: 'partly done', blocked: 'questions returned', needs_input: 'waiting for an answer, stopped', failed: 'failed', stalled: 'stalled, stopped', timeout: 'timed out', quota_exhausted: 'out of quota', interrupted: 'interrupted', cancelled: 'stopped', no_result: 'no valid result', not_started: 'not started' },
  statusName: (s) => D.statusNames[s] ?? s,
  duration: (sec) => {
    const s = Math.round(sec), m = Math.floor(s / 60);
    return s < 60 ? `${s}s` : m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  },
  took: (duration) => `took ${duration}`,
  watchSession: (id) => `Session ${id}`,
  watchTurnFailed: (msg) => `Turn failed: ${msg}`,
  watchTokens: (u) => `tokens: in ${D.tokenCount(u.input_tokens)} (cached ${D.tokenCount(u.cached_input_tokens)}) · out ${D.tokenCount(u.output_tokens)}`,
  watchOpinion: (text) => `Position: ${text}`,
  watchReport: (status, summary) => `Report: ${status} · ${summary}`,
  watchExit: (code, tail) => `exit code ${code}${tail ? ` → ${tail}` : ''}`,
  fileKinds: { add: 'added', update: 'changed', delete: 'deleted' },
  // 读文件和搜索单独计数，免得混进命令数量。
  actionRead: (file) => `read ${file}`,
  actionSearch: (query) => `search ${query}`,
  watchChanged: (n, unknown, group) => `${n} file${n === 1 ? '' : 's'} changed${unknown || group ? `, plus ${D.list([unknown && `${unknown} of unknown origin`, group && `${group} from other runs in the group`].filter(Boolean))}` : ''}`,
  watchNotTracked: 'changes not tracked',
  watchInterrupted: 'The dispatcher process has exited; the run may have been interrupted',
  watchEnded: (status) => `Finished: ${D.statusName(status)}`,
  watchMoreLines: (n) => `(${n} more line${n === 1 ? '' : 's'}; add --verbose to see everything)`,
  watchMoreLinesShort: (n) => `(${n} more line${n === 1 ? '' : 's'})`,
  watchSnapshotShort: 'taking a snapshot of the working folder…',
  watchSnapshotTiny: 'taking a snapshot…',
  watchSnapshotMini: 'snapshot…',
  watchGroupSettling: 'Every run in this group has finished; checking for a few seconds whether more are about to start…',
  watchGroupSettlingKey: '(q to skip)',
  watchPlan: (done, total, next) => `plan ${done}/${total}${next ? ` · next: ${next}` : ''}`,
  watchImage: (file) => `Generated image ${file}`,
  // 按动作种类折叠，保留读、搜、命令的区别。
  foldKinds: { command: (n) => `+${n} command${n === 1 ? '' : 's'}`, read: (n) => `+${n} read${n === 1 ? '' : 's'}`, search: (n) => `+${n} search${n === 1 ? '' : 'es'}`, edit: (n) => `+${n} change${n === 1 ? '' : 's'}`, image: (n) => `+${n} image${n === 1 ? '' : 's'}`, other: (n) => `+${n} message${n === 1 ? '' : 's'}` },
  watchFolded: (parts) => `… ${parts}`,
  watchExitTag: (code) => `exit ${code}`,
  watchNoMatch: 'no match',
  watchFiles: (n, names) => `${n} files · ${names}`,
  watchSnapshotStart: 'Taking a snapshot of the working folder to track changes; a large folder can take a few minutes',
  watchSnapshotDone: (duration) => `Snapshot taken in ${duration}`,
  watchHostNoUsage: 'answer submitted by Claude Code · its tokens count for the whole conversation, not per seat',
  watchWorking: 'working…',
  watchReconnect: (n, total) => `Connection dropped, reconnecting (${n}/${total})`,
  watchApiThought: (duration, n) => `Thought for ${duration} (${n} characters), now writing the answer`,
  watchThinking: (text) => `thinking: ${text}`,
  watchKeys: '↑↓ scroll · q quit',
  watchKeysQueued: '↑↓ scroll · x stop · q quit',
  watchCancelConfirm: (model) => `Press x again to stop ${model}, or any other key to cancel`,
  watchCancelSent: 'Asked it to stop; waiting…',
  planStates: { complete: 'complete', pending: 'in progress', incomplete: 'incomplete' },
  hostNotSubmitted: "Claude Code seat hasn't submitted",
  watchPlanMissing: (list) => `missing required: ${list}`,
  watchPlanNotStarted: (list) => `required seats not started yet: ${list}`,
  watchPlanSeat: (agent, seat, label) => `${agent} (seat ${seat}${label ? `, ${label}` : ''})`,
  watchPlanStale: (list) => `material changed during the review (stale): ${list}`,
  watchPlanGap: (list) => `gap seat not finished: ${list}`,
  watchScrolled: (n) => `scrolled back ${n} lines, End to jump to the latest`,
  watchDetached: 'Stopped watching; the run keeps going',
  watchOpenIssues: 'Open issues',
  watchDecisions: 'Questions to decide (Claude decides, then resumes)',
  watchDeniedPrefix: 'Denied action: ',
  watchInputPromptPrefix: 'Waiting for input: ',
  watchAskedMidRun: 'Asked mid-run (no one answered; it carried on with its own judgement)',
  watchRecommendation: (text) => `Recommended: ${text}`,
};

const oneLine = (s) => String(s ?? '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ⏎ ');
const needsDecision = (q) => ['decision_request', 'permission_denied', 'final_question', 'input_prompt'].includes(q.source);
function shellSplit(s) {
  const args = [];
  let cur = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/\s/.test(ch)) { if (cur !== null) args.push(cur); cur = null; continue; }
    cur ??= '';
    if (ch === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j);
      i = j;
    } else if (ch === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) i++;
        cur += s[i];
      }
      if (i >= s.length) return null;
    } else if (ch === '\\' && i + 1 < s.length) {
      cur += s[++i];
    } else cur += ch;
  }
  if (cur !== null) args.push(cur);
  return args;
}

function plainCommand(cmd) {
  // Codex 记录的命令是按 shell 规则转义后的整行，比如 "...powershell.exe" -Command "<实际命令>"。
  // 先按规则还原，再去掉外壳，只留实际命令。
  const args = shellSplit(String(cmd ?? ''));
  if (args?.length >= 3 && /(?:^|[\\/])(?:powershell|pwsh|bash|sh|zsh|cmd)(?:\.exe)?$/i.test(args[0]) && /^(?:-Command|-l?c|\/c)$/i.test(args.at(-2))) return args.at(-1);
  const m = /^"?[^"]*?(?:powershell|pwsh|bash|cmd)(?:\.exe)?"?\s+(?:-Command|-l?c|\/c)\s+([\s\S]*)$/i.exec(cmd);
  let inner = m ? m[1] : cmd;
  if (/^(["'])[\s\S]*\1$/.test(inner)) inner = inner.slice(1, -1);
  return inner.replace(/\\(["\\])/g, '$1'); // 记录里的命令转义过反斜杠和引号
}


const modelOf = (m) => m?.model || m?.model_name || m?.model_shown || '?';
const agentTypeOf = (m) => m?.participant === 'host' ? 'host' : ({ codex: 'codex cli', opencode: 'opencode cli', 'openai-compatible': 'api' })[m?.agent_type] || m?.agent_type || 'codex cli';


const charWidth = (ch) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1);
const textWidth = (s) => [...s].reduce((w, ch) => w + charWidth(ch), 0);

function fitWidth(s, width) {
  if (textWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    if (w + charWidth(ch) > width - 1) break;
    out += ch;
    w += charWidth(ch);
  }
  return `${out}…`;
}

const NO_LINE_START = /[、，。．！？：；）】』」》〉’”…—,.!?:;)\]}%]/;
const NO_LINE_END = /[（【『「《〈‘“([{]/;
const WORD = /[A-Za-z0-9_\-./\\]/; // 英文单词、文件名和路径，折行时不拆开

function wrapWidth(s, width) {
  const lines = [];
  for (const para of String(s).replace(/\r/g, '').split('\n')) {
    let line = '';
    let w = 0;
    for (const ch of para) {
      if (w + charWidth(ch) > width) {
        const chars = [...line];
        let k = chars.length;
        if (NO_LINE_START.test(ch)) {
          // 逗号、句号这类标点不放在行首：把上一行末尾的字（连同它后面的标点）一起带到下一行。
          while (k > 0 && NO_LINE_START.test(chars[k - 1])) k--;
          k = k > 1 ? k - 1 : chars.length;
          if (WORD.test(chars[k] || '')) { // 带走的是英文单词的末尾时，整个单词一起带走
            let j = k;
            while (j > 0 && WORD.test(chars[j - 1])) j--;
            if (j > 0 && k - j < width) k = j;
          }
        } else if (WORD.test(ch) && WORD.test(chars[k - 1] || '')) {
          // 英文单词不拆开，整个带到下一行；比一整行还长的单词才在下一行照常截断
          let j = k;
          while (j > 0 && WORD.test(chars[j - 1])) j--;
          if (j > 0 && k - j < width) k = j;
        }
        while (k > 1 && NO_LINE_END.test(chars[k - 1])) k--; // 开引号、开括号不留在行尾
        const carry = chars.splice(k).join('');
        lines.push(chars.join('').trimEnd());
        line = carry;
        w = textWidth(carry);
        if (ch === ' ' && !line) continue; // 行首不留空格
      }
      line += ch;
      w += charWidth(ch);
    }
    lines.push(line);
  }
  return lines;
}

const plain = (s) => s;
const unpainted = Object.fromEntries(['dim', 'bold', 'red', 'green', 'yellow', 'cyan'].map((k) => [k, plain]));
const visibleWidth = (s) => textWidth(s.replace(/\x1b\[[0-9;]*m/g, ''));
const shortModel = (model) => String(model).slice(String(model).lastIndexOf('/') + 1) || String(model);
const fullModel = (m) => (modelOf(m).includes('/') ? modelOf(m) : null);
// 模型标签：<模型> <强度> · <接入方式>，没有推理强度时只写模型。旧记录没有 agent_type 和 model_name，都是 Codex CLI。
// Claude Code 席写 <自报的模型> · Claude Code。开工那一行（source）另外注明模型来自 Codex 配置。
const CHANNEL_KEY = { api: 'api', 'opencode cli': 'opencode', 'pi cli': 'pi' };
const modelLabel = (m, { source = false } = {}) => (agentTypeOf(m) === 'host' ? D.dots([m.model, 'Claude Code'])
  : D.modelLabel(shortModel(modelOf(m)), D.channel[CHANNEL_KEY[agentTypeOf(m)] || 'codex'], m?.effort,
    source && !m?.model && !!m?.model_name && agentTypeOf(m) === 'codex cli'));

// 任务属于哪个模块；旧记录没有 module，按 kind 和模式推断
const moduleOf = (m) => m?.module ?? (m?.kind === 'exec' ? 'run' : m?.kind ?? m?.mode);
// 任务行：<模块> · [<模式> · ]<标题> · <等级>[ · round N]；图像任务用格子和路线代替等级
const taskLine = (m, { mode = null, title = m?.title, round = m?.round } = {}) => D.dots([moduleOf(m), mode, title && oneLine(title),
  ...(moduleOf(m) === 'image' ? [m?.cell, m?.route && `route ${'①②③④'[m.route - 1]}`] : [m?.level]), round > 1 && D.watchRound(round)]);
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};
const took = (sec) => (Number.isFinite(sec) ? D.took(D.duration(sec)) : ''); // 旧记录可能没有用时，就不写

// 执行顺利结束时以报告里的状态为准（完成、部分完成、交回问题……）
const shownStatus = (status, r) => (status === 'done' ? r?.needs_decision ? 'blocked' : r?.report?.status || status : status);
// 部分完成仍有可用交付，不能和失败共用红色的叉号。
function outcomeStyle(o, C = unpainted) {
  if (o.resumed) return { mark: '↪', color: C.dim, word: D.statusResumed };
  if (o.status === 'not_started') return { mark: '○', color: C.dim, word: D.statusName('not_started') };
  const style = o.running ? { mark: '●', color: C.cyan } : o.ok ? { mark: '✔', color: C.green } : o.blocked ? { mark: '?', color: C.yellow } : o.partial ? { mark: '◐', color: C.yellow } : { mark: '✗', color: C.red };
  return { ...style, word: D.statusName(o.running ? 'running' : o.status === 'done' && !o.blocked && o.valid === false ? 'no_result' : shownStatus(o.status, o.result)) };
}

const agentTotal = (c) => (c?.agent_total == null && c?.codex_total == null ? undefined : (c.agent_total ?? c.codex_total) + (c.reported_total || 0));
const groupTotal = (c) => c?.group_total ?? [...(c?.files || []), ...(c?.large_files_changed || [])].filter((f) => f?.group_run).length;
function changedText(c) {
  if (!c?.available) return D.watchNotTracked;
  const mine = agentTotal(c);
  if (mine == null) return D.watchChanged(c.files_total, 0, 0); // 旧记录没有归属信息，按全部改动算
  const group = groupTotal(c);
  return D.watchChanged(mine, Math.max(0, (c.unknown_total || 0) - group), group);
}
// 讨论和审查本来只读，只有真的改了文件才显示改动数（那是越界，要提醒）。
const changedFor = (r, m) => (m?.kind === 'exec' || agentTotal(r?.changes) ? changedText(r?.changes) : null);

// 写到工作目录外、又不在写入范围里的文件，按显示用的写法（终端、网页的 ⚠ 行和网页卡片的 ⚠N 共用）
function outsideFiles(r, m) {
  const files = m?.kind === 'exec' ? (r?.changes?.outside_cwd || []).filter((f) => f.in_scope === false) : [];
  if (!files.length) return [];
  // 网页也用这段纯显示逻辑，不能依赖 Node 的 path；保留上级目录和原有路径分隔符。
  const cwd = m.cwd ?? r.cwd ?? '', windows = /^[A-Za-z]:|^\\\\/.test(cwd), sep = cwd.includes('\\') ? '\\' : '/';
  const base = cwd ? cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/') : [];
  // 根（盘符，或网络共享的 //服务器/共享名）不同的不写成相对路径：../ 回不到另一个盘或另一台服务器
  const rootOf = (p) => { const s = p.replace(/\\/g, '/'), unc = /^\/\/[^/]+\/[^/]+/.exec(s); return (unc ? unc[0] : /^[A-Za-z]:/.exec(s)?.[0] ?? (s.startsWith('/') ? '/' : '')).toLowerCase(); };
  const relative = (file) => {
    if (!cwd || rootOf(file) !== rootOf(cwd)) return file;
    const parts = file.replace(/\\/g, '/').split('/');
    let i = 0;
    while (i < base.length && i < parts.length && (windows ? base[i].toLowerCase() === parts[i].toLowerCase() : base[i] === parts[i])) i++;
    // 要往上退两级以上的写绝对路径：一长串 ../ 看不出是哪里
    return i && base.length - i <= 2 ? [...base.slice(i).map(() => '..'), ...parts.slice(i)].join(sep) : file;
  };
  return files.map((f) => relative(f.path));
}
function outsideCwdText(r, m) {
  const files = outsideFiles(r, m);
  if (!files.length) return null;
  return D.watchOutsideCwd(D.list(files.slice(0, 3)), Math.max(0, files.length - 3));
}

const formatUsd = (n) => (n === 0 ? '0' : n < 0.01 ? n.toPrecision(2) : n < 1 ? n.toFixed(3) : n.toFixed(2));
function usageLine(result, meta) {
  if (meta?.participant === 'host') return D.watchHostNoUsage;
  const cost = result || {};
  // 一次请求都没完成的轮次，有的接入方式记成全 0：和没记一样，写"没有用量"
  const parts = [result?.usage && Object.values(result.usage).some((v) => Number(v) > 0) ? D.tokenSummary(result.usage, result.last_request ?? result.context, D.tokenCount,
    (result.usage_scope ?? (meta?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total') : '',
  // 取消、超时、卡死的轮次只记到最后一次完成的请求，速度偏低，标出来
  result?.output_tokens_per_s != null ? D.outputSpeed(result.output_tokens_per_s, ['cancelled', 'timeout', 'stalled'].includes(result.status)) : '',
  cost.cost_usd != null && cost.cost_source !== 'unknown' ? D.costUsd(formatUsd(cost.cost_usd)) : ''].filter(Boolean);
  // 结束了却什么用量都没有（一次请求都没完成、厂商没报）：写明没报，结果的 notes 里有原因
  if (!parts.length && result?.status && result.status !== 'running' && !result.usage_unattributed && !result.not_started) return D.watchNoUsage;
  return parts.join(' · ');
}

function toolLabel(category, tool, { pattern, glob, path: where } = {}) {
  const has = (x) => x != null && x !== '';
  if (category === 'read') return has(where) ? String(where) : tool;
  return [has(pattern) ? pattern : has(glob) ? glob : tool, has(pattern) ? glob : null, where].filter(has).map(String).join(' ');
}

// 工具调用怎么显示：opencode 和 pi 的读文件、搜索（category 为 read 或 search）写成"读 …""搜索 …"，不算命令、不加 $。
function commandAction(it) {
  if (it.category === 'read' || it.category === 'search') {
    // 旧记录没有 label，从命令里去掉工具名
    const text = oneLine(it.label ?? it.command);
    const rest = it.label != null ? text : it.tool && text === it.tool ? '.' : it.tool && text.startsWith(`${it.tool} `) ? text.slice(it.tool.length + 1) : text;
    return { kind: it.category, text: it.category === 'read' ? D.actionRead(rest) : D.actionSearch(rest) };
  }
  return { kind: 'command', text: `$ ${oneLine(it.plain ? it.command : plainCommand(it.command))}` };
}
function errorAction(message) {
  const reconnect = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)/.exec(message || '');
  return { mark: reconnect ? '⚠' : '✗', text: reconnect ? D.watchReconnect(reconnect[1], reconnect[2]) : oneLine(message) };
}
// 折叠起来的动作按种类计数，比如"… +12 commands, +3 reads"
const foldText = (counts) => D.watchFolded(D.list(Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => D.foldKinds[kind](n))));

// 思考摘要只取第一行，去掉 Markdown 的加粗
const thoughtLine = (text) => oneLine(String(text ?? '').trim().split('\n').find((l) => l.trim()) || '').replace(/\*\*/g, '');

function wrapAtDots(text, width) {
  const lines = [];
  for (const part of text.split(' · ')) {
    const last = lines.length - 1;
    if (last >= 0 && textWidth(`${lines[last]} · ${part}`) <= width) { lines[last] += ` · ${part}`; continue; }
    if (textWidth(part) <= width) { lines.push(part); continue; }
    const pieces = wrapWidth(part, Math.max(4, part.includes('/') ? width - 2 : width));
    for (let i = 0; i < pieces.length - 1; i++) {
      if (/\s*\/$/.test(pieces[i])) { pieces[i] = pieces[i].replace(/\s*\/$/, ''); pieces[i + 1] = `/ ${pieces[i + 1]}`; }
    }
    lines.push(...pieces);
  }
  return lines;
}

// 成功的任务不再列出临时的重连提示；旧记录把它记成了错误
const realErrors = (r, ok) => (r?.errors || []).filter((e) => !(ok && /^Reconnecting\.\.\.\s*\d+\/\d+/.test(String(e))));
// 结果里没有用时的旧记录，按元数据的开始和结束时间算
const durationOf = (r, m) => r?.duration_s ?? (timeOf(m?.ended_at) - timeOf(m?.started_at)) / 1000;

const reviewFinding = (f) => ({ ...f, location: f.location ?? f.where, issue: f.issue ?? f.title });
const reviewCounts = (findings = []) => ({ total: findings.length,
  ...Object.fromEntries(['high', 'medium', 'low'].map((s) => [s, findings.filter((f) => f.severity === s).length])) });
function reviewConclusion(report) {
  if (!D.watchReview[report?.verdict]) return null;
  const counts = report.findings_counts ?? reviewCounts(report.findings);
  const parts = ['high', 'medium', 'low'].map((severity) => {
    const n = counts[severity];
    return n ? `${D.severityNames[severity]} ${n}` : null;
  }).filter(Boolean).join(' · ');
  return D.watchReview[report.verdict](counts.total, parts);
}

function finalLines(run, r, ok, inner, C = unpainted) {
  const report = r?.report;
  const out = [];
  const wrap = (text) => wrapWidth(String(text).trim(), inner);
  // 带记号的一段：记号上色，续行缩进两格，按缩进后的宽度折行
  const marked = (mark, color, text) => wrapWidth(oneLine(text), Math.max(4, inner - 2)).map((l, i) => (i ? `  ${l}` : `${color(mark)} ${l}`));
  const conclusion = reviewConclusion(report);
  if (conclusion) {
    out.push(...wrap(conclusion));
    const findings = (report.findings || []).slice(0, 30);
    for (const f of findings) out.push(...wrap(D.watchFinding(f, D.severityNames[f.severity])));
    const omitted = (report.findings_counts?.total ?? report.findings?.length ?? 0) - findings.length;
    if (omitted > 0) out.push(...wrap(D.watchMoreFindings(omitted)));
  } else if (report?.position || report?.summary) out.push(...wrap(report.position || report.summary));
  else if (!report && moduleOf(run.meta) === 'review' && r?.status === 'done' && resultOutcome(r, run.meta).valid) out.push(...wrap(r.last_message));
  const asked = r?.questions?.filter(needsDecision) ?? report?.decision_requests ?? [];
  for (const q of asked) out.push(...marked('?', C.yellow, q.question));
  // 看板的消息超过大小上限时问题和报错可能被裁过：按原来的条数写还有几条（终端读的是完整结果，不会出现）
  const moreAsked = (r?.questions ? r.questions_total : report?.decision_requests_total) - (r?.questions ?? report?.decision_requests ?? []).length;
  if (moreAsked > 0) out.push(...marked('?', C.yellow, D.watchMoreQuestions(moreAsked)));
  const changed = run.meta.kind !== 'exec' && changedFor(r, run.meta); // 讨论和审查只有越界写了文件才有
  if (changed) out.push(...marked('⚠', C.yellow, changed));
  const outside = outsideCwdText(r, run.meta);
  if (outside) out.push(...marked('⚠', C.yellow, outside));
  if (r?.stale === true) out.push(...marked('⚠', C.yellow, D.watchStale));
  const [mark, color] = r?.status === 'needs_input' ? ['?', C.yellow] : ['✗', C.red];
  const secondary = ['timeout', 'cancelled'].includes(r?.status);
  // 次要的报错整行暗色：记号不单独上色，否则记号后的颜色复位会让后面的文字变回正常亮度
  realErrors(r, ok).forEach((e, i) => out.push(...(secondary && i > 0 ? marked('·', plain, e).map((l) => C.dim(l)) : marked(mark, color, e))));
  const moreErrors = (r?.errors_total ?? 0) - (r?.errors?.length ?? 0);
  if (moreErrors > 0) out.push(...marked(mark, color, D.watchMoreErrors(moreErrors)));
  return out;
}

// 运行中的正文：最近说的一段话（◆）、比它新的思考摘要，下面是最近的动作，放不下的折叠成一行计数
function liveLines(state, rows, inner, C = unpainted) {
  if (rows <= 0) return [];
  const speech = state.speech ? wrapWidth(state.speech.text, inner - 2).filter((l) => l.trim()) : [];
  const thought = state.thought && (!state.speech || state.thought.seq > state.speech.seq) ? state.thought : null;
  const acting = state.recent.length ? 1 : 0;
  const thinking = thought && Math.min(2, speech.length) + 1 + acting <= rows ? 1 : 0;
  const speechRows = Math.min(speech.length, rows >= 8 ? 3 : 2, Math.max(speech.length ? 1 : 0, rows - thinking - acting));
  const top = speech.slice(0, speechRows).map((l, i) => {
    const last = i === speechRows - 1 && speech.length > speechRows;
    const joint = /[\w,.;:)]$/.test(l) || /^\w/.test(speech[i + 1] || '') ? ' ' : ''; // 在英文单词处折开的，接回去时补上空格
    return `${i ? '  ' : '◆ '}${last ? fitWidth(`${l}${joint}${speech[i + 1]}`, inner - 2) : l}`;
  });
  if (thinking) top.push(C.dim(fitWidth(D.watchThinking(thought.text), inner)));
  const room = rows - top.length;
  if (room <= 0 || !state.recent.length) return top;
  // 一条动作：记号、暗色的文字，行尾是失败或没搜到的标记
  const line = (a, width = inner) => {
    const tag = a.tag ? `  ${a.tag}` : '';
    const head = a.mark ? `${a.mark[1](a.mark[0])} ` : '';
    // 放不下时有更短的说法就用短的（比如拍快照的提示），免得在单词中间截断
    const room = Math.max(4, width - visibleWidth(head) - visibleWidth(tag));
    const text = fitWidth(a.alt && textWidth(a.text) > room ? a.alt : a.text, room);
    return head + (a.color || C.dim)(text) + (tag ? ' '.repeat(Math.max(0, width - visibleWidth(head) - textWidth(text) - visibleWidth(tag))) + tag : '');
  };
  const total = Object.values(state.kinds).reduce((n, k) => n + k, 0);
  if (total <= room) return [...top, ...state.recent.slice(-room).map((a) => line(a))];
  const shown = state.recent.slice(state.recent.length - Math.max(1, room - 1));
  const hidden = { ...state.kinds };
  for (const a of shown) hidden[a.kind]--;
  // 只剩一行时，折叠计数和最新一条写在同一行
  const fold = foldText(hidden);
  if (room === 1) return [...top, inner - textWidth(fold) - 3 >= 8 ? `${C.dim(`${fold} · `)}${line(shown[0], inner - textWidth(fold) - 3)}` : C.dim(fitWidth(fold, inner))];
  return [...top, C.dim(fitWidth(fold, inner)), ...shown.map((a) => line(a))];
}

const withoutRole = (title, role) => {
  const rest = role ? title.replace(new RegExp(`\\s*[［\\[（(【]\\s*${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[］\\]）)】]\\s*`), '').trim() : title;
  return /^(多角色模式|role mode)$/i.test(rest) ? '' : rest;
};
function seatLine(m, { title = false, width = Infinity } = {}, C = unpainted) {
  const parts = [[m.role, C.bold], [title && m.title, C.bold], [title && m.level, plain], [moduleOf(m) === 'image' && m.cell, plain], [m.author && 'author', C.dim]]
    .filter(([text]) => text).map(([text, style]) => ({ text: oneLine(String(text)), style }));
  if (!parts.length) return null;
  const total = () => textWidth(parts.map((p) => p.text).join(' · '));
  for (const p of [...parts].filter((x) => x.style === C.bold).sort((a, b) => textWidth(b.text) - textWidth(a.text))) {
    if (total() <= width) break;
    p.text = fitWidth(p.text, Math.max(4, textWidth(p.text) - (total() - width)));
  }
  if (total() > width) return C.dim(fitWidth(parts.map((p) => p.text).join(' · '), Math.max(1, width)));
  return parts.map((p) => p.style(p.text)).join(C.dim(' · '));
}

function groupTask(all, plans = [], queue = []) {
  const seats = all.filter((run) => run.meta.participant !== 'host').map((run) => run.meta);
  const metas = seats.length ? seats : all.length ? all.map((run) => run.meta) : queue.map((q) => {
    const plan = plans.find((p) => (p.plan_id ?? p.plan) === q.plan);
    return { ...q, module: plan?.module ?? 'run', level: plan?.level ?? plan?.cell };
  });
  const module = moduleOf(metas[0]);
  const roles = all.some((run) => run.meta.role && !GAP_ROLE.test(run.meta.role));
  const mode = module === 'run' ? (metas.length > 1 ? D.groupModes.split : null)
    : module === 'discuss' || module === 'review' ? D.groupModes[roles ? 'roles' : 'panel'] : null;
  const same = (key) => (new Set(metas.map((m) => m[key] ?? null)).size === 1 ? metas[0]?.[key] : null);
  const titles = [...new Set(metas.map((m) => withoutRole(oneLine(m.title || ''), m.role)).filter(Boolean))];
  const round = same('round');
  return { split: module === 'run' && titles.length > 1, text: taskLine({ ...metas[0], level: same('level'), cell: same('cell') }, { mode, title: titles.join(' / '), round }),
    // 简短的组标题（网页用量表的组行）：只写类型和标题
    short: D.dots([moduleOf(metas[0]), titles.length && oneLine(titles.join(' / '))]) };
}

// 只算查看画面的计划提示；准入和登记仍由 plan.mjs/records.mjs 负责。
function planNotes(plans, all) {
  return plans.map((plan) => {
    const id = plan.plan_id ?? plan.plan;
    const runs = all.filter((r) => r.meta.plan === id).sort((a, b) => a.id.localeCompare(b.id));
    const seats = plan.seats.map((s) => {
      const run = runs.filter((r) => r.meta.seat === s.seat).at(-1), o = run?.outcome;
      return { ...s, required: plan.required ? plan.required.includes(s.agent) : s.required,
        status: o?.status ?? 'not_started', ok: !o || o.running ? null : o.ok,
        stale: plan.module === 'review' && o?.result?.stale === true, label: o ? outcomeStyle(o).word : D.statusName('not_started') };
    });
    const needed = ['run', 'image'].includes(plan.module) ? seats : seats.filter((s) => s.required);
    const ended = (s) => !['not_started', 'running'].includes(s.status);
    let state = needed.length ? needed.every((s) => s.ok === true) ? 'complete'
      : needed.some((s) => ended(s) && !s.ok) ? 'incomplete' : 'pending'
      : seats.every(ended) ? seats.some((s) => s.ok) ? 'complete' : 'incomplete' : 'pending';
    const missing = needed.filter((s) => s.ok !== true), stopped = missing.filter(ended), waiting = missing.filter((s) => s.status === 'not_started');
    const labels = (list, detail = false) => D.list(list.map((s) => D.watchPlanSeat(s.agent, s.seat, detail ? s.label : null)));
    const host = plan.host && !runs.some((r) => r.meta.participant === 'host');
    if (host && state === 'complete') state = 'pending';
    const detail = state === 'incomplete' && stopped.length ? D.watchPlanMissing(labels(stopped, true))
      : state === 'pending' && waiting.length ? D.watchPlanNotStarted(labels(waiting)) : '';
    const stale = seats.filter((s) => s.stale), gap = seats.filter((s) => GAP_ROLE.test(s.role?.trim() || '') && s.ok !== true);
    const details = [host && D.hostNotSubmitted, detail, stale.length && D.watchPlanStale(labels(stale)), gap.length && D.watchPlanGap(labels(gap, true))].filter(Boolean).join('; ');
    return { id, state, details, line: `${state === 'incomplete' ? '✗' : '⚠'} ${D.dots([D.planStates[state], details])}` };
  });
}

// 续接和同席重启都由最新轮次代替
function current(runs, all = runs.all ?? runs) {
  const children = new Map(), latest = new Map(), seen = new Set();
  const seatOf = (run) => (run.meta.plan && (run.meta.seat != null || run.meta.participant === 'host') ? `${run.meta.plan}:${run.meta.participant === 'host' ? 0 : run.meta.seat}` : null);
  for (const run of all) {
    const parent = run.meta.parent;
    if (parent && (!children.has(parent) || run.id > children.get(parent).id)) children.set(parent, run);
    const seat = seatOf(run);
    if (seat && (!latest.has(seat) || run.id > latest.get(seat).id)) latest.set(seat, run);
  }
  return runs.flatMap((run) => {
    if (seatOf(run)) run = latest.get(seatOf(run));
    else while (children.has(run.id)) run = children.get(run.id);
    if (seen.has(run.id)) return [];
    seen.add(run.id);
    return [run];
  });
}

// 按计划创建顺序预留全部声明席位，重建和持续观看才能得到相同号码。
function seatNumbers(runs, all = runs, previous, plans = []) {
  const seats = new Map(), numbers = new Map(), used = new Set();
  const byId = new Map(all.map((r) => [r.id, r])), declared = new Map();
  for (const p of plans) declared.set(p.plan_id ?? p.plan, { at: timeOf(p.created_at ?? p.original_ts ?? p.ts), seats: new Set([...(p.host ? [0] : []), ...(p.seats || []).map((s) => s.seat)]) });
  for (const r of all) if (r.meta.plan) {
    const m = r.meta;
    if (!declared.has(m.plan)) declared.set(m.plan, { at: timeOf(m.started_at), seats: new Set() });
    const p = declared.get(m.plan);
    if (m.participant === 'host') p.seats.add(0);
    else if (m.seat != null) p.seats.add(m.seat);
    if (!plans.some((p) => (p.plan_id ?? p.plan) === m.plan)) p.at = Math.min(p.at, timeOf(m.started_at));
  }
  const reserved = new Set([...declared.values()].flatMap((p) => [...p.seats]));
  const take = (key, preferred) => {
    let n = preferred;
    if (n == null || used.has(n)) for (n = 1; used.has(n) || reserved.has(n); n++);
    seats.set(key, n); used.add(n);
  };
  for (const [id, p] of [...declared].sort(([a, x], [b, y]) => (x.at - y.at) || a.localeCompare(b)))
    for (const n of [...p.seats].sort((a, b) => a - b)) take(`${id}:${n}`, n);
  const first = (run) => {
    const seen = new Set();
    while (byId.has(run.meta.parent) && !seen.has(run.id)) { seen.add(run.id); run = byId.get(run.meta.parent); }
    return run;
  };
  const ordered = [...new Map([...all, ...runs].map((r) => [r.id, r])).values()].sort((a, b) => timeOf(first(a).meta.started_at) - timeOf(first(b).meta.started_at) || first(a).id.localeCompare(first(b).id));
  for (const run of ordered.filter((r) => r.meta.participant === 'host' && !r.meta.plan)) take(run.id, 0);
  // 无计划的旧续接链曾缺祖先时，恢复祖先不能把已经可用的数字快捷键换掉。
  for (const run of ordered) if (!run.meta.plan && previous?.runs.has(run.id)) {
    const key = first(run).id, n = previous.runs.get(run.id);
    if (!seats.has(key) && !used.has(n) && !reserved.has(n)) take(key, n);
  }
  for (const run of ordered) {
    const m = run.meta, root = first(run), seat = m.participant === 'host' ? 0 : m.seat;
    const key = m.plan && seat != null ? `${m.plan}:${seat}` : root.id;
    // 祖先暂时读不到时才沿用已见号码；完整记录的重建不依赖观看历史。
    if (!seats.has(key)) take(key, root.meta.parent && !byId.has(root.meta.parent) ? previous?.runs.get(run.id) ?? previous?.runs.get(root.meta.parent) : null);
    numbers.set(run.id, seats.get(key));
  }
  return { seats, runs: numbers };
}

function roundOf(meta, byId) {
  if (meta.round != null || !meta.parent) return meta.round ?? 1;
  let n = 1;
  for (let id = meta.parent; id && n < 100; n++) id = (byId.get(id)?.meta ?? byId.get(id))?.parent;
  return n;
}

function resultOutcome(r, meta = r) {
  const status = r?.status ?? meta?.status;
  const blocked = status === 'needs_input' || status === 'done' && (!!r?.needs_decision || r?.report?.status === 'blocked');
  const valid = r?.valid ?? (moduleOf(meta) === 'review'
    ? r?.report ? r.report.verdict !== 'incomplete' : !!r?.last_message?.trim() && (!!r.native_review || r.review_target === undefined)
    : !!r?.report);
  const partial = !blocked && status === 'done' && r?.report?.status === 'partial';
  return { running: status === 'running', status, result: r, blocked, valid, partial,
    ok: !blocked && valid && status === 'done' && (!r?.report?.status || r.report.status === 'completed') };
}

const hhmm = (t) => (t != null ? new Date(t).toTimeString().slice(0, 5) : '     ');
const timeOf = (t) => typeof t === 'number' ? t : Date.parse(t);
function liveStatus(meta, api, now, C = unpainted) {
  const queued = api.queued, word = api.req != null || queued ? D.apiPhases[queued ? 'queued' : api.answering ? 'answering' : 'thinking'] : D.statusName('running');
  return { mark: queued ? '⋯' : '●', color: queued ? C.yellow : C.cyan, word,
    right: [word, clock(now - timeOf(api.req ?? meta.started_at))] };
}

function seatState(meta, result, api, now, C = unpainted, outcome = resultOutcome(result, meta)) {
  if (meta.participant === 'host') return { style: { mark: '✔', color: C.green, word: D.statusName('submitted') },
    right: [D.statusName('submitted'), hhmm(meta.submitted_at)], kind: 'ok' };
  if (outcome.running) {
    const style = liveStatus(meta, api, now, C);
    return { style, right: style.right, kind: api.queued ? 'queued' : 'running', running: true };
  }
  const style = outcomeStyle(outcome, C), sec = durationOf(result, meta);
  return { style, right: [style.word, Number.isFinite(sec) ? clock(sec * 1000) : null],
    kind: outcome.resumed ? 'resumed' : outcome.ok ? 'ok' : outcome.blocked ? 'blocked' : outcome.partial ? 'partial' : 'failed' };
}
// 各状态的色调，和终端的上色一致（运行中、完成、部分完成/交回问题/排队、失败、已续接和没开始）；网页按色调取同一组颜色
const TONES = { running: 'run', queued: 'warn', ok: 'ok', partial: 'warn', blocked: 'warn', resumed: 'dim', not_started: 'dim', failed: 'bad' };
const toneOf = (kind) => TONES[kind] || 'dim';
const COUNT_MARKS = { running: '●', queued: '⋯', ok: '✔', partial: '◐', blocked: '?', resumed: '↪', failed: '✗' };
const countParts = (states) => Object.entries(COUNT_MARKS).flatMap(([kind, mark]) => {
  const n = states.filter((s) => s.kind === kind).length;
  return n ? [{ kind, text: `${mark}${n}` }] : [];
});
const countsText = (states) => countParts(states).map((p) => p.text).join(' ');

const seatUsage = (meta, result, usage = usageLine(result, meta)) => meta.participant === 'host' ? D.watchHostNoUsage
  : D.dots([meta.kind === 'exec' && changedFor(result, meta), usage]);
const queuedLine = (q, now) => `⋯ queued #${q.position} ${oneLine(q.title || '-')} · ${q.agent || q.model || '?'} · waiting ${Math.max(0, Math.round((now - timeOf(q.queued_at)) / 60000))} min`;
const queuedStarted = (q, runs) => runs.some((r) => {
  const m = r.meta ?? r;
  return q.plan && m.plan === q.plan && m.seat === q.seat && timeOf(m.original_started_at ?? m.started_at) >= timeOf(q.queued_at);
});
const collapseLines = (lines, collapse, opener) => collapse && lines.length > 4
  ? [...lines.slice(0, 4), `… ${lines.length - 4} more line${lines.length - 4 === 1 ? '' : 's'} · ${opener}`] : lines;
function dashFooter(left, keys, width, done = false, shortKeys = null) {
  let room = width - textWidth(keys) - 2;
  if (done && textWidth(left) > room) left = left.replace(D.dashAllFinished, D.dashAllFinishedShort);
  // 还放不下就换短的按键说明，先保住左边（"下面还有 N 行"这类位置提示）
  if (shortKeys && textWidth(left) > room) { keys = shortKeys; room = width - textWidth(keys) - 2; }
  if (room < 8 && left) return { left: fitWidth(left, width), keys: '', gap: '' };
  left = fitWidth(left, Math.max(0, room));
  keys = fitWidth(keys, width);
  return { left, keys, gap: ' '.repeat(Math.max(0, width - textWidth(left) - textWidth(keys))) };
}

// 新消息保留终端用的原始字段；旧消息从现有摘要恢复，缺少的信息自然不显示。
function displayRun(r) {
  const host = r.kind === 'answer' || r.participant === 'host';
  const meta = { ...r, model: r.display_model ?? r.model, kind: host ? 'discuss' : r.kind === 'image' ? 'exec' : r.kind,
    module: r.module ?? (r.kind === 'exec' ? 'run' : r.kind), participant: host ? 'host' : r.participant,
    submitted_at: r.submitted_at ?? r.started_at, round: r.display_round ?? r.round };
  const u = r.usage;
  const result = r.display ?? { status: r.status, duration_s: r.duration_s,
    report: r.review ? { verdict: r.review.verdict, findings: r.review.findings.map((f) => ({ severity: f.severity, location: f.where, issue: f.title })) }
      : r.report_head ? { [r.kind === 'discuss' ? 'position' : 'summary']: r.report_head } : null,
    usage: u ? { input_tokens: 'cache_write' in u ? (u.input || 0) + (u.cached || 0) + (u.cache_write || 0) : u.input,
      cached_input_tokens: u.cached, output_tokens: u.output } : null, usage_scope: r.usage_scope, cost_usd: r.cost_usd, cost_source: r.cost_source };
  return { id: r.id, meta, result };
}

// 原始时间只用于文字和用时，不改变回放的播放调度及速度统计。
function recordedTime(t, points) {
  if (!points?.length) return t;
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid][0] <= t) lo = mid + 1; else hi = mid; }
  const a = points[Math.max(0, lo - 1)], b = points[lo];
  return b && t >= a[0] ? a[1] + (t - a[0]) * (b[1] - a[1]) / (b[0] - a[0]) : a[1] + t - a[0];
}
function elapsedOf(r, t, points, lastActivity) {
  const ended = r.ended_at != null && r.ended_at <= t;
  const start = r.original_started_at ?? recordedTime(r.started_at, points);
  const end = ended ? r.original_ended_at ?? recordedTime(r.ended_at, points)
    : r.status === 'idle' && lastActivity != null ? lastActivity : recordedTime(t, points);
  return Math.max(0, ended && r.duration_s != null ? r.duration_s : (end - start) / 1000);
}

export { D, seatLine, shortModel, fullModel, modelLabel, agentTypeOf, moduleOf, taskLine, clock, took, shownStatus, outcomeStyle, agentTotal, changedText, changedFor, outsideCwdText, outsideFiles,
  formatUsd, usageLine, toolLabel, commandAction, errorAction, foldText, thoughtLine, wrapAtDots, realErrors, durationOf, reviewFinding, reviewCounts, reviewConclusion, finalLines, liveLines,
  groupTask, current, planNotes, seatNumbers, roundOf, resultOutcome, liveStatus, seatState, toneOf, COUNT_MARKS, countParts, countsText, seatUsage, queuedLine, queuedStarted, collapseLines, dashFooter,
  displayRun, recordedTime, elapsedOf, textWidth, fitWidth, wrapWidth };

