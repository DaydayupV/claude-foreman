#!/usr/bin/env node
// PreToolUse 钩子：拦下直接调用 codex exec / codex review / opencode run / pi 的 Bash 和 PowerShell 命令，
// 要求改走 cli.mjs。退出码 2 会阻止这次调用，并把 stderr 的内容反馈给 Claude。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'skills', 'dispatch', 'scripts', 'cli.mjs');

const MESSAGES = {
  zh: `已拦截：不要直接调用 codex exec / codex review / opencode run / pi。协作方的调用都必须通过 foreman 插件的脚本：
  node "${SCRIPT}" <run|discuss|resume|review> ...
用法见 foreman:dispatch skill。测试、验收和一次性问答也一样，只读问答用 discuss。
如果是脚本本身满足不了的需求（比如沙箱导致协作方无法运行），停下来把情况告诉用户，由用户决定，不要设法绕过。`,
  en: `Blocked: don't call codex exec / codex review / opencode run / pi directly. Every call to an agent must go through the foreman-en plugin's script:
  node "${SCRIPT}" <run|discuss|resume|review> ...
See the foreman-en:dispatch skill. This applies to tests, checks and one-off questions too; use discuss for read-only questions.
If the script can't do what's needed (for example a sandbox stops an agent from running), stop and tell the user so they can decide. Don't look for a way around it.`,
};

const CODEX_SUBCOMMANDS = new Set(['exec', 'e', 'review']);
// pi 除了下面这些用法都会运行模型：查询类参数（要在 -- 之前），以及放在第一个位置的管理类子命令。
const PI_QUERY_FLAGS = new Set(['--version', '-v', '--help', '-h', '--list-models', '--export']);
const PI_ADMIN = new Set(['install', 'remove', 'uninstall', 'update', 'list', 'config', 'auth', 'mcp']);
// 带一个值的选项：值不能当成子命令或查询参数。
const PI_VALUE_OPTIONS = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt', '--mode', '--session', '--session-id',
  '--fork', '--session-dir', '--name', '-n', '--models', '--tools', '-t', '--exclude-tools', '-xt', '--thinking', '--extension', '-e', '--skill',
  '--prompt-template', '--theme', '--use-theme', '--tui-mode']);
const PI_ENTRY = /pi-coding-agent[\\/]dist[\\/](bundle[\\/])?cli\.js$/i;

function piRunsModel(words) {
  if (PI_ADMIN.has(words[0])) return false;
  for (let n = 0; n < words.length; n++) {
    const w = words[n];
    if (w === '--') return true; // 后面都是提示词
    if (PI_QUERY_FLAGS.has(w)) return false;
    if (PI_VALUE_OPTIONS.has(w)) n++;
  }
  return true;
}

// npx 先跳过它自己的选项（带值的连值一起跳过），再看要运行的包：-p / --package 可以写几次，
// 写了它们时第一个非选项参数是要执行的程序名，没写时它就是包名；-c / --call 后面是一整条要执行的命令。
const NPX_VALUE_OPTIONS = new Set(['--cache', '--registry', '--userconfig', '--prefix', '-w', '--workspace', '--node-options', '--loglevel', '--script-shell']);
function npxPackage(tokens, i) {
  const unquote = (s) => (s || '').replace(/^["']|["']$/g, '');
  const pkgs = [];
  for (let n = i + 1; n < tokens.length; n++) {
    const t = unquote(tokens[n]);
    if (t === '-p' || t === '--package') { pkgs.push(unquote(tokens[++n])); continue; }
    if (t.startsWith('--package=')) { pkgs.push(t.slice('--package='.length)); continue; }
    if (t === '-c' || t === '--call') return { pkgs, rest: tokens.length, call: unquote(tokens[n + 1]) };
    if (t.startsWith('--call=')) return { pkgs, rest: tokens.length, call: unquote(tokens[n].slice('--call='.length)) };
    if (NPX_VALUE_OPTIONS.has(t)) { n++; continue; }
    if (t.startsWith('-')) continue;
    return { pkgs: pkgs.length ? pkgs : [t], rest: n + 1 };
  }
  return { pkgs, rest: tokens.length };
}

const base = (p) => p.replace(/^["']|["']$/g, '').split(/[\\/]/).pop().toLowerCase();

// 按 ; | && || 和换行把命令拆成几段，引号里的分隔符不算。
function splitSegments(command) {
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || c === '\n' || (c === '&' && command[i + 1] === '&')) {
      segments.push(current);
      current = '';
      if ((c === '&' || c === '|') && command[i + 1] === c) i++;
    } else {
      current += c;
    }
  }
  segments.push(current);
  return segments;
}

// 命令替换 $( … ) 和 ` … ` 里的命令会执行：从会展开的正文里取出来，另起一行检查
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      if (j < 0) break;
      out.push(text.slice(i + 1, j)); i = j;
    } else if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') depth++; else if (text[j] === ')' && --depth === 0) break; }
      out.push(text.slice(i + 2, j)); i = j;
    }
  }
  return out;
}

// 一行里写在引号外、注释前的 heredoc 开头：<<WORD、<<-WORD（结束行可以带制表符缩进）、<<'WORD'、<<"WORD"、<<\WORD。
// 分隔符加了引号或反斜杠的正文原样是文字（literal）；<<< 是 here-string，不算
function heredocsOf(line) {
  const found = [];
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (c !== '<' || line[i + 1] !== '<' || line[i + 2] === '<' || line[i - 1] === '<') continue;
    const m = /^<<(-?)\s*(?:(['"])([^'"]+)\2|\\([A-Za-z_][\w.-]*)|([A-Za-z_][\w.-]*))/.exec(line.slice(i));
    if (!m) { i++; continue; }
    found.push({ tabs: m[1] === '-', end: m[3] ?? m[4] ?? m[5], literal: m[3] != null || m[4] != null });
    i += m[0].length - 1;
  }
  return found;
}

// heredoc 和 PowerShell 的 here-string（@' … '@、@" … "@）里是写进文件的文字，不是要执行的命令：先去掉正文再拆段，
// 免得正文里的"| pi · …"这类表格被当成调用。会展开的正文（分隔符没加引号的 heredoc、@" … "@）里的命令替换照样检查
function stripHeredocs(command) {
  const text = command.replace(/@(['"])\r?\n([\s\S]*?)\r?\n\1@/g, (_, quote, body) => (quote === '"' ? ['""', ...substitutions(body)].join('\n') : "''"));
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    for (const { tabs, end, literal } of heredocsOf(lines[i])) {
      const body = [];
      while (i + 1 < lines.length) {
        const line = lines[++i].replace(/\r$/, '');
        if ((tabs ? line.replace(/^\t+/, '') : line) === end) break;
        body.push(line);
      }
      if (!literal) out.push(...substitutions(body.join('\n')));
    }
  }
  return out.join('\n');
}

// 只看每段命令开头真正被执行的程序，文字里提到调用不算。
function callsAgentDirectly(command) {
  for (const segment of splitSegments(stripHeredocs(command))) {
    // 引号可以出现在一个参数中间（--call="codex exec"），整段算一个参数。
    const tokens = segment.replace(/^[\s(`$&.]+/, '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i])) i++; // 跳过 VAR=value 前缀
    const first = base(tokens[i] || '');
    let rest;
    let opencode = false, pi = false;
    const npx = /^npx(\.cmd)?$/.test(first) ? npxPackage(tokens, i) : null;
    if (npx?.call && callsAgentDirectly(npx.call)) return true;
    const npxRuns = (pattern) => !!npx && npx.pkgs.some((pkg) => pattern.test(pkg));
    if (/^codex(\.exe|\.cmd|\.ps1)?$/.test(first)) rest = tokens.slice(i + 1);
    else if (/^node(\.exe)?$/.test(first) && base(tokens[i + 1] || '') === 'codex.js') rest = tokens.slice(i + 2);
    else if (npxRuns(/^(@openai\/codex|codex)(@.*)?$/)) rest = tokens.slice(npx.rest);
    else if (/^opencode(\.exe|\.cmd|\.ps1)?$/.test(first)) { rest = tokens.slice(i + 1); opencode = true; }
    else if (npxRuns(/^(opencode-ai|@opencode\/cli)(@.*)?$/)) { rest = tokens.slice(npx.rest); opencode = true; }
    else if (/^pi(\.exe|\.cmd|\.ps1)?$/.test(first)) { rest = tokens.slice(i + 1); pi = true; }
    else if (/^node(\.exe)?$/.test(first) && PI_ENTRY.test((tokens[i + 1] || '').replace(/^["']|["']$/g, ''))) { rest = tokens.slice(i + 2); pi = true; }
    else if (npxRuns(/^@earendil-works\/pi-coding-agent(@.*)?$/)) { rest = tokens.slice(npx.rest); pi = true; }
    else continue;
    const words = rest.map((t) => t.replace(/^["']|["']$/g, ''));
    if (pi) {
      if (piRunsModel(words)) return true;
      continue;
    }
    if (words.some((w) => w === '--help' || w === '-h')) continue;
    // session 等子命令后也可能出现名为 run 的参数。
    if (opencode ? words.find((w, n) => !w.startsWith('-') && words[n - 1] !== '--log-level') === 'run'
      : words.some((w) => CODEX_SUBCOMMANDS.has(w))) return true;
  }
  return false;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let command;
  try { command = JSON.parse(input).tool_input?.command; } catch { process.exit(0); }
  if (typeof command !== 'string' || !callsAgentDirectly(command)) process.exit(0);
  let language = 'zh';
  try { language = JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT), 'language.json'), 'utf8')).language; } catch { /* 用默认 */ }
  process.stderr.write((MESSAGES[language] || MESSAGES.zh) + '\n');
  process.exit(2);
});
