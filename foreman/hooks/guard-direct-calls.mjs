#!/usr/bin/env node
// PreToolUse 钩子：拦下直接调用 codex exec / codex review / opencode run / pi / agy 跑模型的 Bash 和 PowerShell 命令，
// 要求改走 cli.mjs。退出码 2 会阻止这次调用，并把 stderr 的内容反馈给 Claude。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base, splitSegments, stripHeredocs, tokensOf } from './shell-words.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'skills', 'dispatch', 'scripts', 'cli.mjs');

const MESSAGES = {
  zh: `已拦截：不要直接调用 codex exec / codex review / opencode run / pi / agy。协作方的调用都必须通过 foreman 插件的脚本：
  node "${SCRIPT}" <run|discuss|review|resume|plan|submit|image> ...
用法见 foreman:dispatch skill。测试、验收和一次性问答也一样，只读问答用 discuss。
如果是脚本本身满足不了的需求（比如沙箱导致协作方无法运行），停下来把情况告诉用户，由用户决定，不要设法绕过。`,
  en: `Blocked: don't call codex exec / codex review / opencode run / pi / agy directly. Every call to an agent must go through the foreman-en plugin's script:
  node "${SCRIPT}" <run|discuss|review|resume|plan|submit|image> ...
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

// 重定向（2>&1、>out.txt、2> err.txt、<in.txt、PowerShell 的 *> $null）是 shell 的，不算程序的参数；只写了符号的，
// 后面那个词是文件名。带引号的词是普通参数（'>' 会原样传给程序），所以在去掉引号之前判断
const REDIRECT = /^(?:\d*|&|\*)(?:>>?|<)(.*)$/;
function dropRedirects(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^["']/.test(tokens[i]) ? null : REDIRECT.exec(tokens[i]);
    if (!m) out.push(tokens[i]);
    else if (!m[1]) i++;
  }
  return out;
}

// agy 的查询白名单不能掩盖后面的模型参数，-- 之后也一律视为提示词。
function agyRunsModel(words) {
  if (words.length === 1 && words[0] === '--version') return false;
  return !new Set(['models', 'agents', 'changelog', 'help']).has(words[0])
    || words.slice(1).some((w) => w === '--' || /^-(?:p|i).*$/.test(w) || /^--(?:print|prompt|input-format)(?:=|$)/.test(w));
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

// 只看每段命令开头真正被执行的程序，文字里提到调用不算。
function callsAgentDirectly(command) {
  for (const segment of splitSegments(stripHeredocs(command))) {
    const tokens = tokensOf(segment);
    let i = 0;
    while (i < tokens.length && /^\w+=/.test(tokens[i])) i++; // 跳过 VAR=value 前缀
    // 重定向可以紧贴在程序名后面（agy>out.txt -p hi）：先拆开，再认程序名
    const glued = /^([^'"<>]+?)((?:\d*|&|\*)?(?:>>?|<).*)$/.exec(tokens[i] || '');
    if (glued) tokens.splice(i, 1, glued[1], glued[2]);
    const first = base(tokens[i] || '');
    let rest;
    let opencode = false, pi = false, agy = false;
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
    else if (/^agy(\.exe|\.cmd|\.ps1)?$/.test(first)) { rest = tokens.slice(i + 1); agy = true; }
    else continue;
    const words = dropRedirects(rest).map((t) => t.replace(/^["']|["']$/g, ''));
    if (agy) { if (agyRunsModel(words)) return true; continue; }
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
