#!/usr/bin/env node
// PreToolUse 钩子：网页看板开着时，派出任务（cli.mjs 的 run、resume、discuss、review、image）前把看板链接直接显示给用户。
// 光靠 skill 让 Claude 先在回复里写链接不可靠（写链接的那句话常常只进了思考，没作为正文发出来），
// 这里用钩子的 systemMessage，由界面直接显示，不经过模型。
// 只提示，不拦命令；用户每发一条消息，派出任务时只显示一次（同一条消息里一起派出的几个任务只显示一次）。
// 同一个脚本也挂在 UserPromptSubmit 上：用户发新消息时清掉"已显示"的标记，那时什么都不输出（输出会被加进用户的消息）。
// 还挂在 Stop 上：桌面版把上面的 systemMessage 折在工具调用里，用户常常看不到，链接要靠 Claude 写进"已派出"那句话；
// 派出后同一轮接着干别的时，那句话又常常只写进思考。这一轮在后台派出过、正文里却没有看板链接时，拦下结束，让 Claude 补上。
// 命令识别认不全（包装脚本、上一条命令里赋值的变量等），所以 Stop 另有一条不看命令的兜底：
// 派出命令一运行就在 board-dispatched/<对话 id> 上留下时间（records.mjs 的 markDispatched，排队中的也有）；
// 这个时间落在这一轮里、整轮助手正文却一次看板链接都没有时，也拦下结束。
// （派出后用 PostToolUse 的 additionalContext 提醒试过：Claude 把它当成链接已经显示过了，连平常派出都不再写）

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base, splitSegments, stripHeredocs, tokensOf } from './shell-words.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'skills', 'dispatch', 'scripts', 'cli.mjs');
const USER_CONFIG = process.env.FOREMAN_CONFIG || path.join(os.homedir(), '.claude', 'foreman', 'config.json');
const DISPATCH = new Set(['run', 'resume', 'discuss', 'review', 'image']);
const MESSAGES = {
  zh: (url) => `网页看板：${url}`,
  en: (url) => `Web board: ${url}`,
};
// 要结束这一轮、正文里却还没写看板链接时拦下的理由（Stop 的 reason，Claude 照着补上再结束）
const STOP_REASONS = {
  zh: (url) => `foreman：这一轮在后台派出了任务，但回复正文里还没有告诉用户、附上看板链接。结束前先用一句话告诉用户"已派出：…"（派出没成功的话照实说明），句中附上 [网页看板](${url || '派出命令输出的 foreman: web board 那一行的地址'})，然后再结束这一轮。只写在思考里的不算，用户看不到；直接写这句话，不用向用户解释这条提示。`,
  en: (url) => `foreman: work was handed off in the background this turn, but your reply text hasn't told the user or given the board link. Before ending the turn, tell the user in one sentence that it was handed off (or, if the handoff failed, say so), with [web board](${url || 'the address on the handoff command\'s foreman: web board line'}) in that sentence. A sentence only in your thinking doesn't count, since the user can't see it; just write the sentence, without explaining this notice to the user.`,
};

const unquote = (s) => String(s ?? '').replace(/^["']|["']$/g, '');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const absolute = (p) => /^(?:[a-z]:[\\/]|[\\/])/i.test(p);
// 把引用换成同一条命令里赋过的字面值。没赋过值的引用（$HOME、${CLAUDE_PLUGIN_ROOT} 这类环境变量）原样留着：
// 路径后半段是字面的 dispatch/scripts/cli.mjs 时照样认得出。单引号里的不展开
const substituted = (s) => /\$\(|`/.test(s);
function expand(word, vars) {
  const value = unquote(word);
  return String(word).startsWith("'") ? value : value.replace(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (s, a, b) => vars[a || b] ?? s);
}

// 这条命令里有没有用 foreman 的 cli.mjs 派出任务；有的话返回它用的配置文件（命令里写了 FOREMAN_CONFIG 时用那份）
export function dispatchOf(command) {
  let config, cwd;
  const vars = Object.create(null);
  // 续行（Bash 行尾的 \、PowerShell 行尾的 `）接回同一行再拆段
  for (const segment of splitSegments(stripHeredocs(command).replace(/[\\`]\r?\n/g, ' '))) {
    const ps = /^\s*\$env:FOREMAN_CONFIG\s*=\s*("[^"]*"|'[^']*'|\S+)/i.exec(segment);
    if (ps) { config = unquote(ps[1]); continue; }
    const assignment = /^\s*\$([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(segment.trim());
    if (assignment) {
      // 值来自命令替换或表达式的变量不展开（记成 null，引用它的地方就认不出）
      const literal = /^("[^"]*"|'[^']*')\s*$/.test(assignment[2]) && !substituted(assignment[2]);
      vars[assignment[1]] = literal ? expand(assignment[2].trim(), vars) : null;
      continue;
    }
    const tokens = tokensOf(segment), env = {};
    let i = 0;
    const exported = tokens[i] === 'export';
    if (exported) i++;
    for (; i < tokens.length && /^\w+=/.test(tokens[i]); i++) {
      const at = tokens[i].indexOf('='), name = tokens[i].slice(0, at), value = tokens[i].slice(at + 1);
      env[name] = unquote(value);
      vars[name] = substituted(value) ? null : expand(value, vars);
    }
    if (exported) { config = env.FOREMAN_CONFIG ?? config; continue; }
    if (['cd', 'pushd', 'set-location'].includes(base(tokens[i] || ''))) {
      const dir = tokens[i + 1] && !substituted(tokens[i + 1]) ? expand(tokens[i + 1], vars) : null;
      cwd = dir && cwd && !absolute(dir) ? path.posix.join(cwd.replace(/\\/g, '/'), dir.replace(/\\/g, '/')) : dir;
      continue;
    }
    if (!/^node(\.exe)?$/.test(base(tokens[i] || ''))) continue;
    let script = expand(tokens[i + 1], vars);
    // 相对路径接到前面最近一次切换到的目录后面；没切换过目录的照原样判断
    if (!absolute(script) && cwd) script = path.posix.join(cwd.replace(/\\/g, '/'), script.replace(/\\/g, '/'));
    if (!/(?:^|[\\/])dispatch[\\/]scripts[\\/]cli\.mjs$/i.test(script) || !DISPATCH.has(tokens[i + 2])) continue;
    // 只看帮助开关本身；跟在 --title 这类选项后面的 --help 是选项的值，命令照样会派出
    if (tokens.some((t, k) => k > i + 2 && (t === '--help' || t === '-h') && !tokens[k - 1].startsWith('--'))) continue;
    return { config: env.FOREMAN_CONFIG ?? config };
  }
  return null;
}

// 网页看板开没开：只看用户配置的 dispatch.watch.web（旧写法是 dispatch.web）；和 cli.mjs 一样，项目配置改不了它
function webOn(configFile) {
  const user = readJson(configFile) || {}, watch = user.dispatch?.watch;
  return watch && typeof watch === 'object' ? watch.web === true : user.dispatch?.web === true;
}

// 看板地址由 board 子命令给：服务没在跑、锁是残留的、服务是旧版本时，它都会先处理好（不直接读锁文件，免得给出打不开的链接）
function boardUrl(configFile, session) {
  const r = spawnSync(process.execPath, [SCRIPT, 'board', ...(SAFE_ID.test(session || '') ? ['--session', session] : [])], {
    encoding: 'utf8', timeout: 12000, windowsHide: true, env: { ...process.env, FOREMAN_CONFIG: configFile },
  });
  try { return JSON.parse(r.stdout).url ?? null; } catch { return null; }
}

// 这条消息里已经显示过就不再显示。每个对话在 foreman 目录的 board-shown/ 下有一个标记文件 <对话 id>，用 wx 抢占：
// 一起派出、钩子同时运行的几个任务只有一个抢到；用户发下一条消息时（UserPromptSubmit）删掉它。
// 标记的位置只看钩子自己的环境（和 record-answers.mjs 一样），不看命令里写的 FOREMAN_CONFIG，两个时机找的是同一个文件。
// 返回 false 表示不显示，返回标记文件（或读写失败时的 true）表示显示
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHOWN_DIR = path.join(path.dirname(USER_CONFIG), 'board-shown');
function claimShow(session, now) {
  if (!SAFE_ID.test(session || '')) return true;
  const dir = SHOWN_DIR, file = path.join(dir, session);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return true; }
  try { fs.closeSync(fs.openSync(file, 'wx')); } catch (error) { return error.code !== 'EEXIST'; }
  // 顺手清掉一天前的标记
  try {
    for (const name of fs.readdirSync(dir)) {
      const other = path.join(dir, name);
      if (now - fs.statSync(other).mtimeMs > 24 * 3600000) fs.rmSync(other, { force: true });
    }
  } catch { /* 清不掉下次再清 */ }
  return file;
}

// 这一轮最后一次后台派出以后没写链接就返回那次派出；命令没认出时，再按派出标记兜底。
// 这一轮从记录里最后一条用户那边送来的消息（用户的话、完成通知这类，不算工具结果）算起。
// 每一轮结束都会跑：只读对话末尾 4 MB；看板关着、对话里又没出现过 cli.mjs 时不解析，直接结束。
const TAIL = 4 * 1024 * 1024;
const LINKED = /\[(?:网页看板|web board)\]\(http|http:\/\/127\.0\.0\.1:\d+\/\w+\/\?level=all/i;
// 这个对话最近一次运行派出命令的时间（毫秒），没派出过或读不到时为 null
function dispatchedAt(session) {
  if (!SAFE_ID.test(session || '')) return null;
  try { return fs.statSync(path.join(path.dirname(USER_CONFIG), 'board-dispatched', session)).mtimeMs; } catch { return null; }
}

export function unannounced(file, session) {
  // 看板关着时不看派出标记（按命令认的那条规则照旧，它用的可能是命令里写的另一份配置）
  const marked = webOn(USER_CONFIG) ? dispatchedAt(session) : null;
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  if (marked === null && !text.includes('cli.mjs')) return null;
  const rows = [];
  let first;
  for (const line of text.split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    first ??= row;
    if (!row.isSidechain && (row.type === 'assistant' || row.type === 'user')) rows.push(row);
  }
  let from = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const c = rows[i].message?.content;
    if (rows[i].type === 'user' && !rows[i].isMeta && (typeof c === 'string' || Array.isArray(c) && c.some((b) => b.type === 'text'))) { from = i + 1; break; }
  }
  const since = Date.parse((from ? rows[from - 1] : first)?.timestamp);
  let pending = null, linked = false;
  for (const row of rows.slice(from)) {
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
    for (const b of row.message.content) {
      if (b.type === 'text' && LINKED.test(b.text || '')) { pending = null; linked = true; }
      else if (b.type === 'tool_use' && ['Bash', 'PowerShell'].includes(b.name) && b.input?.run_in_background === true && typeof b.input.command === 'string') pending = dispatchOf(b.input.command) || pending;
    }
  }
  return pending || (!linked && marked !== null && marked >= since ? { config: USER_CONFIG } : null);
}

// 不是用户发的消息：后台任务的完成通知（<task-notification>）、桌面版通知其他会话的进展（<side-sessions-event>）、
// 拉取请求的检查结果（<ci-monitor-event>），以及只有 <system-reminder> 的提醒。别的会话发来的消息照样算新消息
const AUTOMATED = /^<(task-notification|side-sessions-event|ci-monitor-event)>/;
export function automatedPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const rest = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return !rest ? prompt.trim() !== '' : AUTOMATED.test(rest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let event;
    try { event = JSON.parse(input); } catch { process.exit(0); }
    // 用户发了新消息：清掉这个对话的标记，下次派出再显示。这时不输出任何东西。
    // 后台任务的完成通知这类自动送进来的消息也会触发 UserPromptSubmit，它们不算新消息
    if (event.hook_event_name === 'UserPromptSubmit') {
      if (SAFE_ID.test(event.session_id || '') && !automatedPrompt(event.prompt)) {
        try { fs.rmSync(path.join(SHOWN_DIR, event.session_id), { force: true }); } catch { /* 删不掉就等一天后清理 */ }
      }
      process.exit(0);
    }
    // 要结束这一轮（Stop）：命令或运行记录表明本轮派出过、却没写所需看板链接时，拦一次，让 Claude 补上再结束。
    // 拦过一次以后（stop_hook_active）不再拦，免得来回打转
    const stop = event.hook_event_name === 'Stop', command = event.tool_input?.command;
    const found = stop ? (event.stop_hook_active ? null : unannounced(event.transcript_path, event.session_id)) : typeof command === 'string' ? dispatchOf(command) : null;
    if (!found) process.exit(0);
    const configFile = found.config || USER_CONFIG;
    if (!webOn(configFile)) process.exit(0);
    let lang = 'zh';
    try { lang = JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT), 'language.json'), 'utf8')).language; } catch { /* 用默认 */ }
    if (stop) {
      process.stdout.write(JSON.stringify({ decision: 'block', reason: (STOP_REASONS[lang] || STOP_REASONS.zh)(boardUrl(configFile, event.session_id)) }));
      process.exit(0);
    }
    const claimed = claimShow(event.session_id, Date.now());
    if (!claimed) process.exit(0);
    const url = boardUrl(configFile, event.session_id);
    if (url) process.stdout.write(JSON.stringify({ systemMessage: (MESSAGES[lang] || MESSAGES.zh)(url) }));
    // 没拿到链接时删掉自己抢到的标记，下次派出照样显示
    else if (typeof claimed === 'string') { try { fs.rmSync(claimed, { force: true }); } catch { /* 下次照样试 */ } }
    process.exit(0);
  });
}
