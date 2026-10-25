#!/usr/bin/env node
// PreToolUse 钩子：网页看板开着时，派出任务（cli.mjs 的 run、resume、discuss、review、image）前把看板链接直接显示给用户。
// 光靠 skill 让 Claude 先在回复里写链接不可靠（写链接的那句话常常只进了思考，没作为正文发出来），
// 这里用钩子的 systemMessage，由界面直接显示，不经过模型。
// 只提示，不拦命令；用户每发一条消息，派出任务时只显示一次（同一条消息里一起派出的几个任务只显示一次）。
// 同一个脚本也挂在 UserPromptSubmit 上：用户发新消息时清掉"已显示"的标记，那时什么都不输出（输出会被加进用户的消息）。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { base, splitSegments, stripHeredocs, tokensOf } from './shell-words.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'skills', 'dispatch', 'scripts', 'cli.mjs');
const DISPATCH = new Set(['run', 'resume', 'discuss', 'review', 'image']);
const MESSAGES = {
  zh: (url) => `网页看板：${url}`,
  en: (url) => `Web board: ${url}`,
};

const unquote = (s) => String(s ?? '').replace(/^["']|["']$/g, '');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// 这条命令里有没有用 foreman 的 cli.mjs 派出任务；有的话返回它用的配置文件（命令里写了 FOREMAN_CONFIG 时用那份）
export function dispatchOf(command) {
  let config;
  // 续行（Bash 行尾的 \、PowerShell 行尾的 `）接回同一行再拆段
  for (const segment of splitSegments(stripHeredocs(command).replace(/[\\`]\r?\n/g, ' '))) {
    const ps = /^\s*\$env:FOREMAN_CONFIG\s*=\s*("[^"]*"|'[^']*'|\S+)/i.exec(segment);
    if (ps) { config = unquote(ps[1]); continue; }
    const tokens = tokensOf(segment), env = {};
    let i = 0;
    if (tokens[i] === 'export' && /^FOREMAN_CONFIG=/.test(tokens[i + 1] || '')) { config = unquote(tokens[i + 1].slice('FOREMAN_CONFIG='.length)); continue; }
    for (; i < tokens.length && /^\w+=/.test(tokens[i]); i++) env[tokens[i].split('=')[0]] = unquote(tokens[i].slice(tokens[i].indexOf('=') + 1));
    if (!/^node(\.exe)?$/.test(base(tokens[i] || ''))) continue;
    const script = unquote(tokens[i + 1]);
    if (!/[\\/]dispatch[\\/]scripts[\\/]cli\.mjs$/i.test(script) || !DISPATCH.has(tokens[i + 2])) continue;
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
const SHOWN_DIR = path.join(process.env.FOREMAN_CONFIG ? path.dirname(process.env.FOREMAN_CONFIG) : path.join(os.homedir(), '.claude', 'foreman'), 'board-shown');
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let event;
    try { event = JSON.parse(input); } catch { process.exit(0); }
    // 用户发了新消息：清掉这个对话的标记，下次派出再显示。这时不输出任何东西
    if (event.hook_event_name === 'UserPromptSubmit') {
      if (SAFE_ID.test(event.session_id || '')) { try { fs.rmSync(path.join(SHOWN_DIR, event.session_id), { force: true }); } catch { /* 删不掉就等一天后清理 */ } }
      process.exit(0);
    }
    const command = event.tool_input?.command, found = typeof command === 'string' ? dispatchOf(command) : null;
    if (!found) process.exit(0);
    const configFile = found.config || process.env.FOREMAN_CONFIG || path.join(os.homedir(), '.claude', 'foreman', 'config.json');
    const claimed = webOn(configFile) && claimShow(event.session_id, Date.now());
    if (!claimed) process.exit(0);
    let lang = 'zh';
    try { lang = JSON.parse(fs.readFileSync(path.join(path.dirname(SCRIPT), 'language.json'), 'utf8')).language; } catch { /* 用默认 */ }
    const url = boardUrl(configFile, event.session_id);
    if (url) process.stdout.write(JSON.stringify({ systemMessage: (MESSAGES[lang] || MESSAGES.zh)(url) }));
    // 没拿到链接时删掉自己抢到的标记，下次派出照样显示
    else if (typeof claimed === 'string') { try { fs.rmSync(claimed, { force: true }); } catch { /* 下次照样试 */ } }
    process.exit(0);
  });
}
