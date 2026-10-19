// 公共小工具、语言选择和显示用的模型信息。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGES } from './messages.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 输出语言由插件自带的 language.json 决定（中文插件 zh，英文插件 en），测试时可用环境变量 FOREMAN_LANG 覆盖。
const LANGUAGE = process.env.FOREMAN_LANG || process.env.CODEX_BRIDGE_LANG || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, 'language.json'), 'utf8')).language; } catch { return 'zh'; }
})();
const M = MESSAGES[LANGUAGE] || MESSAGES.zh;
const notice = (msg) => process.stderr.write(`foreman: ${msg}\n`);
// 语言要在提示文字之前确定，所以旧变量名的提示放到这里补上。
if (!process.env.FOREMAN_LANG && process.env.CODEX_BRIDGE_LANG) notice(M.legacyEnv('CODEX_BRIDGE_LANG', 'FOREMAN_LANG'));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { die(M.configBadJson(file, e.message)); }
}

function die(msg) {
  process.stderr.write(`foreman: ${msg}\n`);
  process.exit(2);
}

function need(o, key) {
  if (!o[key]) die(M.missingOpt(key));
  return o[key];
}

function resolveDir(p) {
  const dir = path.resolve(p);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) die(M.dirMissing(dir));
  return dir;
}

function readBrief(o, required = true) {
  if (!o.brief) {
    if (required) die(M.missingOpt('brief'));
    return '';
  }
  const text = o.brief === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(o.brief), 'utf8');
  if (required && !text.trim()) die(M.emptyBrief);
  return text.replace(/^﻿/, '').trim();
}

const MAX_MATERIAL_CHARS = 300000;

function readAttachments(specs, cwd, api) {
  return specs.map((spec) => {
    const match = /:(\d+)-(\d+)$/.exec(spec);
    const range = match ? [Number(match[1]), Number(match[2])] : null;
    if (range && (!range.every(Number.isSafeInteger) || range[0] < 1 || range[1] < range[0])) die(M.badFileRange(spec));
    const file = path.resolve(cwd, match ? spec.slice(0, match.index) : spec);
    if (!fs.existsSync(file)) die(M.fileNotFound(file));
    if (!fs.statSync(file).isFile()) die(M.fileBinary(file));
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) die(M.fileBinary(file));
    // 发出去的材料里写项目内的相对路径，不暴露本机目录结构，也省 token。
    const rel = relativePath(cwd, file);
    const attached = { path: file, shown: rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) ? file : rel, range };
    if (!api) return attached;
    const lines = bytes.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const first = range?.[0] || 1;
    const content = lines.slice(first - 1, range?.[1]).map((line, i) => `${first + i}\t${line}`).join('\n');
    const longest = (content.match(/`+/g) || []).reduce((n, s) => Math.max(n, s.length), 2);
    return { ...attached, content, chars: content.length, fence: '`'.repeat(longest + 1) };
  });
}

function focusFiles(files) {
  return files.length ? `\n\n${M.focusFiles(files.map((f) => `- ${f.shown}${f.range ? (LANGUAGE === 'en' ? ` (lines ${f.range[0]}–${f.range[1]})` : `（第 ${f.range[0]}–${f.range[1]} 行）`) : ''}`).join('\n'))}` : '';
}

const binCommand = (bin) => /\.[cm]?js$/i.test(bin) ? { file: process.execPath, pre: [bin] } : { file: bin, pre: [] };

function readImages(specs, cwd) {
  return specs.map((spec) => {
    const file = path.resolve(cwd, spec);
    if (/:\d+-\d+$/.test(spec) || !/\.(png|apng|jpe?g|gif|webp)$/i.test(spec)
      || !fs.existsSync(file) || !fs.statSync(file).isFile()) die(M.reviewVisualNotImage(spec));
    const rel = relativePath(cwd, file);
    return { path: file, shown: rel.startsWith('../') || rel === '..' || path.isAbsolute(rel) ? file : rel, range: null };
  });
}

function pathCommand(name, extraDirs = []) {
  // 图形界面的 PATH 可能不含常用安装目录；JS 入口用当前的 node，不依赖 PATH 里有 node。
  const home = os.homedir();
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.dirname(process.execPath),
    '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), ...extraDirs];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); } catch { continue; }
    let real = file;
    try { real = fs.realpathSync(file); } catch { /* 用原路径 */ }
    return /\.[cm]?js$/i.test(real) ? binCommand(real) : binCommand(file);
  }
  return binCommand(name);
}

function npmEntry(...parts) {
  const entry = (root) => path.join(root, ...parts);
  let file = entry(path.join(process.env.APPDATA || '', 'npm', 'node_modules'));
  if (!fs.existsSync(file)) {
    // 改过 npm prefix 或用 nvm 时不在默认位置，问 npm 要全局目录。
    const npm = spawnSync('npm root -g', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 30000 });
    file = npm.status === 0 && npm.stdout.trim() ? entry(npm.stdout.trim()) : '';
  }
  return file && fs.existsSync(file) ? file : null;
}

function isGitRepo(cwd) {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'true';
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  // codex 以独立进程组启动，负 pid 连同它起的子进程一起结束。
  else try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
}

// ---------- 改动追踪 ----------

function relativePath(cwd, file) {
  return path.relative(cwd, path.resolve(cwd, file.replace(/\\/g, '/'))).replace(/\\/g, '/') || '.';
}

const pathKey = (file) => process.platform === 'win32' ? file.toLowerCase() : file;

// Codex 断线后自动重连时会发 error 事件（"Reconnecting... 1/5 …"），这只是临时状况，不算失败。
const RECONNECT = /^Reconnecting\.\.\.\s*(\d+)\/(\d+)/;
const isReconnect = (msg) => RECONNECT.test(String(msg ?? ''));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s) => String(s ?? '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ⏎ ');

// 费用按金额大小保留足够精度，零不带小数。
const formatUsd = (n) => n === 0 ? '0' : n < 0.01 ? n.toPrecision(2) : n < 1 ? n.toFixed(3) : n.toFixed(2);

// status 和 watch 共用同一行用量与费用，只有费用时也照常显示。
function usageLine(result, meta) {
  return [result?.usage ? M.tokenSummary(result.usage, result.last_request ?? result.context, M.tokenCount,
    (result.usage_scope ?? (meta?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total') : '',
  result?.cost_usd != null ? M.costUsd(formatUsd(result.cost_usd)) : ''].filter(Boolean).join(' · ');
}

function looksLikeQuestion(text) {
  // 只认末尾问号或明确请人决定的说法，普通进度说明不算提问。
  return /[?？]$/.test(text.trimEnd()) || /请确定|请确认|请选择|请决定|要不要|是否需要我|你希望|您希望|please confirm|please choose|should I|do you want|would you like|which option/i.test(text);
}

function looksLikeInputPrompt(line) {
  // 只认原始终端输出中明确的确认、按键和输入提示，不用于模型消息。
  return /\(y\/n\)|\[y\/n\]|\(yes\/no\)|press enter|press any key|\b(?:continue|proceed|overwrite|approve|allow)\?|select an option|enter a number|是否继续|请输入|按回车/i.test(line);
}

// 最终回答是不是一个问题，而不是格式不对的报告：看起来像 JSON 的一律当格式问题，照常修复；
// 否则最后一行以问号结尾，或者整段不长、又有明确请人决定的说法，才算问题。
function looksLikeFinalQuestion(text) {
  const t = String(text ?? '').trim();
  if (!t || /^(```|\{)/.test(t)) return false;
  const lastLine = t.split('\n').map((x) => x.trim()).filter(Boolean).pop() || '';
  return /[?？]$/.test(lastLine) || (t.length <= 800 && looksLikeQuestion(t));
}

// 名字写错时找最接近的候选：先看"/"后面那段是否相同（opencode 的提供方前缀写错），再看包含关系，最后按编辑距离。
function closestMatches(name, candidates, limit = 3) {
  const target = String(name ?? '').toLowerCase();
  if (!target) return [];
  const tail = (s) => s.slice(s.lastIndexOf('/') + 1);
  const distance = (a, b) => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row;
    }
    return prev[b.length];
  };
  // 只是大小写不同的排在最前面：名字区分大小写，这正是最需要提示的写法。
  const scored = [...new Set(candidates)].filter((c) => c && c !== String(name)).map((c) => {
    const lower = c.toLowerCase();
    if (lower === target) return [c, -1];
    if (tail(lower) === tail(target)) return [c, 0];
    if (lower.includes(target) || target.includes(lower)) return [c, 1];
    const d = distance(lower, target);
    return d <= Math.max(2, Math.floor(target.length * 0.25)) ? [c, 2 + d] : null;
  }).filter(Boolean);
  return scored.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([c]) => c);
}

const needsDecision = (q) => ['decision_request', 'permission_denied', 'final_question', 'input_prompt'].includes(q.source);

// 按 POSIX shell 规则拆分命令行；引号不配对时返回 null。
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

// 桌面版的终端面板只接受 ASCII 命令；记录目录路径里有非 ASCII 字符时，实时查看的命令发不出去
const isAscii = (s) => /^[ -~]*$/.test(s);
// 界面上以模型为主，接入方式作附注；旧记录没有 agent_type 和 model_name，都是 Codex CLI。
const modelOf = (m) => m?.model || m?.model_name || m?.model_shown || '?';
const agentTypeOf = (m) => ({ codex: 'codex cli', opencode: 'opencode cli', 'openai-compatible': 'api' })[m?.agent_type] || m?.agent_type || 'codex cli';
const CHANNEL_KEY = { api: 'api', 'opencode cli': 'opencode', 'pi cli': 'pi' };
const whoOf = (m) => M.who(modelOf(m), M.channel[CHANNEL_KEY[agentTypeOf(m)] || 'codex'], m?.effort, !m?.model && !!m?.model_name && agentTypeOf(m) === 'codex cli');

// 用改名替换文件。Windows 上目标文件正被别的进程读取时（watch、status、并发登记都会读 meta.json），
// 改名会报 EPERM / EACCES / EBUSY，稍等再试；最多等约 2 秒。
function replaceFile(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); }
    catch (e) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code) || i >= 80) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

// 终端里中日韩字符和全角符号占两格，按显示宽度截断和换行，避免折行错位。
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
            if (j > 0 && k - j < Math.min(40, width / 2)) k = j;
          }
        } else if (WORD.test(ch) && WORD.test(chars[k - 1] || '')) {
          // 英文单词不拆开，整个带到下一行（超过半行的长单词照常截断）
          let j = k;
          while (j > 0 && WORD.test(chars[j - 1])) j--;
          if (j > 0 && k - j < Math.min(40, width / 2)) k = j;
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

export { replaceFile, HERE, LANGUAGE, M, notice, isObject, readJson, die, need, resolveDir, readBrief, MAX_MATERIAL_CHARS, readAttachments, readImages, focusFiles, binCommand, pathCommand, npmEntry, isGitRepo, pidAlive, killTree, relativePath, pathKey, RECONNECT, isReconnect, sleep, clip, oneLine, formatUsd, usageLine, plainCommand, isAscii, modelOf, whoOf, agentTypeOf, looksLikeQuestion, looksLikeInputPrompt, looksLikeFinalQuestion, needsDecision, closestMatches, charWidth, textWidth, fitWidth, wrapWidth };
