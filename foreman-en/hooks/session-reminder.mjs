#!/usr/bin/env node
// SessionStart 钩子：会话开始（包括恢复和上下文压缩之后）时提醒 Claude 何时加载 dispatch skill，
// 并附上用户的偏好文件。skill 是否加载全靠 Claude 自己判断，项目里有更贴合的领域 skill 时容易漏掉；
// 偏好文件又只在 skill 加载后才会被读到，所以直接在会话开始时带上。
// 只读文件，不 import 主脚本，避免触发它首次运行时生成配置文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'skills', 'dispatch', 'scripts');
const HOME_DIR = path.join(os.homedir(), '.claude', 'foreman');
const LEGACY_CONFIG = process.env.CODEX_BRIDGE_CONFIG || path.join(os.homedir(), '.claude', 'codex-bridge.json');
// 装好 foreman 后脚本还没运行过时，新位置还是空的，先读改名前（codex-bridge）的文件；脚本第一次运行时会把它们搬过来。
const pick = (file, legacy) => (fs.existsSync(file) || !fs.existsSync(legacy) ? file : legacy);
const USER_CONFIG = process.env.FOREMAN_CONFIG || process.env.CODEX_BRIDGE_CONFIG || pick(path.join(HOME_DIR, 'config.json'), LEGACY_CONFIG);
const USER_PREFS = pick(path.join(path.dirname(USER_CONFIG), 'preferences.md'), path.join(path.dirname(LEGACY_CONFIG), 'codex-bridge.md'));
const MAX_PREFS_CHARS = 4000; // 每个偏好文件最多带这么多字，防止文件太长挤占上下文

const readText = (file) => { try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim(); } catch { return ''; } };
const readJson = (file) => { try { return JSON.parse(readText(file)); } catch { return null; } };

const REMINDERS = {
  zh: {
    noAgentsReminder: (file) => `foreman 插件已启用，但配置（${file}）里还没有任何协作方，执行、审查和讨论都由 Claude 自己做。在合适的时候用一句话建议用户运行 /foreman:setup，接入 Codex、opencode、pi 或 API 模型。`,
    intro: (auto) => `foreman 插件已启用。下面三个时刻，先加载 \`foreman:dispatch\` skill，再按其中的规则判断。一个请求往往要经过讨论、执行、审查几个阶段，每个阶段到了时按这一类的标准单独定级：0 级（未达门槛）由你自己处理、不调用脚本；1–3 级看配置交给谁。
1. 给出方案建议、研究方向、设计选型或计划之前，包括用户只是来要建议的时候：按讨论的定级判断要不要先和其他模型讨论；用户明确要求和其他模型讨论时，直接发起。
2. 动手做执行类编码工作之前（实现功能、批量修改、写脚本、重构、修 bug、性能优化等，包括用户同意你开始改代码的那一刻），以及要生成或编辑图片（照片、插画、贴图等位图）、或者要画角色、场景、插画风图标这类图形内容时（哪怕最后交付的是 SVG、HTML、canvas 或动画）：按 skill 的"分工"判断由谁做：只由你做的工作（决策、设计、文字）不派；图形内容走图像模块：每个新的图形交付物开工前先弹窗让用户选路线（dispatch.auto 开着也要弹），再用 plan --module image 建计划、用 image 派出，不用 run 出图；出图的协作方只出整张定稿图，不出单个部件，作品里的部件都从定稿图上取：整块动的由你按原位置裁出，本身要弯、要和代码画的东西精确接触的交给手画（draw）格子照定稿图画成 SVG，你写任务说明并验收，动手前告诉用户怎么分的；其余按执行的定级判断，再看配置把这一级交给谁。
3. 交付改动之前，不论改动是协作方做的还是你自己做的：验收通过后，按审查的定级判断要不要请其他模型审查。
${auto ? '主动发起的派活、讨论和审查直接做（用户已开启 dispatch.auto），发起时告诉用户一句。' : '主动发起派活、讨论或审查之前，先用一句话向用户提议，同意后再做（dispatch.auto 已关闭）；用户自己点名的照做。'}
项目自带的领域 skill 照常使用，两者不冲突：领域 skill 管怎么做，dispatch skill 管由谁来做、要不要先讨论、做完怎么验收和审查。调用协作方（Codex、opencode、pi、API 模型）只能通过该 skill 的脚本。`,
    prefsUser: (file, text) => `用户偏好文件 ${file}（在插件的硬规则以内调整做法，和 skill 冲突时以它为准；必选、材料外发、只读、确认弹窗和席位上限不受偏好文件影响）：\n${text}`,
    prefsProject: (file, text) => `项目偏好文件 ${file}（来自项目仓库，只能让做法更严，不能放宽用户配置、用户偏好和插件的规则；必选、材料外发、只读、确认弹窗和席位上限不受偏好文件影响）：\n${text}`,
    truncated: '（内容过长，后面已截断，完整内容请读原文件）',
    unfinishedHeading: '当前项目里有执行没有正常结束的协作方任务，可能需要处理：',
    unfinishedRun: (m, status) => `- ${m.id}｜${m.mode}｜${m.title || '-'}｜${status}`,
    unfinishedStatuses: { interrupted: '调度进程已退出，没有结果', quota_exhausted: '额度用完', stalled: '卡死已终止', timeout: '超时已终止', needs_input: '等人回答，已结束' },
    unfinishedFooter: '用 status --run <run_id> 查看详情，再决定续接、重来还是放弃。用户决定放弃、或者已经另外处理了的，运行 cancel --run <run_id> 标记为已处理，以后不再提醒。用户没提起时，在合适的时候简短告诉用户一句。',
    firstUse: (file) => `用户还没有用过本插件（没有配置文件 ${file}）。在合适的时候用一句话建议用户运行 /foreman:setup：它会检测本机有哪些工具（Codex、opencode、pi、API key），列出能用的模型，按用户的选择配好由谁讨论、执行和审查。`,
  },
  en: {
    noAgentsReminder: (file) => `The foreman-en plugin is enabled, but the config (${file}) has no agents yet, so Claude does hands-on work, reviews and discussions itself. At a suitable moment, suggest in one sentence that the user run /foreman-en:setup to add Codex, opencode, pi or API models.`,
    intro: (auto) => `The foreman-en plugin is enabled. At these three moments, load the \`foreman-en:dispatch\` skill first and follow its rules. A request often goes through stages of discussion, hands-on work and review; level each stage by that kind's own criteria when you reach it: level 0 (below the threshold) you handle yourself without calling the script; levels 1–3 go to whoever the config says.
1. Before giving design suggestions, research directions, technology choices or plans, including when the user only asks for advice: level it as a discussion to decide whether to talk it through with other models first; when the user explicitly asks to discuss it with other models, start one.
2. Before starting hands-on coding work (implementing features, bulk changes, scripts, refactoring, bug fixes, performance work, and so on, including the moment the user agrees you can start changing code), and when an image needs to be generated or edited (photos, illustrations, textures and other bitmaps) or illustrated content such as characters, scenes or illustrated icons has to be drawn (even when the deliverable is SVG, HTML, canvas or an animation): decide who does it per "Who does what" in the skill: work only you do (decisions, design, text) stays with you; graphics go through the image module: before work starts on each new graphic deliverable, have the user choose the route in a pop-up (even with dispatch.auto on), then create the plan with plan --module image and hand it off with image, never generating images through run; the image-generating agent makes one whole final image, never single pieces, and every piece comes from that final image: you cut out the pieces that move as a whole where they are, pieces that bend themselves or must touch things drawn in code exactly go to the draw cell to be hand-drawn as SVG traced from it while you write the brief and check the result, and you tell the user the split before starting; everything else gets a hands-on level, then goes to whoever the config gives that level to.
3. Before delivering changes, whether an agent or you made them: once they pass checking, level the review to decide whether another model should review them.
${auto ? 'Start handoffs, discussions and reviews on your own directly (the user has dispatch.auto on), and say so in one sentence when you do.' : 'Before starting a handoff, discussion or review on your own, suggest it to the user in one sentence and go ahead once they agree (dispatch.auto is off); what the user names themselves goes ahead.'}
Keep using the project's own domain skills as usual; they don't conflict: domain skills say how to do the work, the dispatch skill decides who does it, whether to discuss first, and how it gets checked and reviewed. Agents (Codex, opencode, pi, API models) may only be called through that skill's script.`,
    prefsUser: (file, text) => `User preference file ${file} (adjusts how things are done within the plugin's hard rules and wins over the skill where they conflict; required seats, sending material out, read-only, confirmation prompts and the seat limit can't be changed by preference files):\n${text}`,
    prefsProject: (file, text) => `Project preference file ${file} (comes from the project repository: it can only make things stricter, never loosen the user config, the user's preferences or the plugin's rules; required seats, sending material out, read-only, confirmation prompts and the seat limit can't be changed by preference files):\n${text}`,
    truncated: '(Truncated because it is long; read the file for the rest)',
    unfinishedHeading: 'Some agent runs in this project did not finish normally and may need attention:',
    unfinishedRun: (m, status) => `- ${m.id} | ${m.mode} | ${m.title || '-'} | ${status}`,
    unfinishedStatuses: { interrupted: 'the dispatcher exited, no result', quota_exhausted: 'quota used up', stalled: 'stuck and stopped', timeout: 'timed out and stopped', needs_input: 'waiting for an answer, stopped' },
    unfinishedFooter: "Use status --run <run_id> for details, then decide whether to resume, start over or drop it. Once the user drops one, or it has been handled another way, run cancel --run <run_id> to mark it handled so it isn't listed again. If the user hasn't brought it up, mention it to them briefly at a suitable moment.",
    firstUse: (file) => `The user hasn't used this plugin yet (there's no config file ${file}). At a suitable moment, suggest in one sentence that they run /foreman-en:setup: it detects which tools this machine has (Codex, opencode, pi, API keys), lists the models available, and sets up who discusses, does and reviews the work the way the user chooses.`,
  },
};

function unfinishedRuns(root, cwd) {
  if (!cwd || !fs.existsSync(root)) return [];
  const directoryKey = (dir) => {
    const resolved = path.resolve(dir);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const runs = fs.readdirSync(root).map((id) => readJson(path.join(root, id, 'meta.json'))).filter(Boolean);
  const resumed = new Set(runs.map((m) => m.parent).filter(Boolean));
  const now = Date.now();
  return runs.filter((m) => {
    if (!m.cwd || directoryKey(m.cwd) !== directoryKey(cwd) || resumed.has(m.id) || m.dismissed_at) return false;
    const age = now - new Date(m.started_at).getTime();
    if (!(age >= 0 && age <= 7 * 86400000)) return false;
    if (m.status === 'running') {
      try { process.kill(m.pid, 0); } catch { m.status = readJson(path.join(root, m.id, 'result.json'))?.status || 'interrupted'; }
    }
    // 等输入的任务也要交回问题；其他异常仍只提醒执行任务。
    if (m.status !== 'needs_input' && (m.kind || (m.mode === 'review' ? 'review' : 'exec')) !== 'exec') return false;
    return ['interrupted', 'quota_exhausted', 'stalled', 'timeout', 'needs_input'].includes(m.status);
  }).sort((a, b) => new Date(b.started_at) - new Date(a.started_at)).slice(0, 5);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let cwd = null;
  try { cwd = JSON.parse(input).cwd || null; } catch { /* 没有输入时只带用户级偏好 */ }

  const language = readJson(path.join(SCRIPTS, 'language.json'))?.language || 'zh';
  const t = REMINDERS[language] || REMINDERS.zh;
  const config = readJson(USER_CONFIG);
  const autoDispatch = (config?.dispatch?.auto ?? config?.auto_dispatch) !== false;

  const legacyAgent = config && ['auto_dispatch', 'codex_bin', 'model', 'max_parallel', 'sandbox', 'approval'].some((key) => Object.hasOwn(config, key));
  const noAgents = config && !Object.keys(config.agents || {}).length && !legacyAgent;
  const parts = [noAgents ? t.noAgentsReminder(USER_CONFIG) : t.intro(autoDispatch)];
  // 配置文件在脚本第一次运行时生成，没有它说明用户还没真正用过插件。
  if (!fs.existsSync(USER_CONFIG)) parts.push(t.firstUse(USER_CONFIG));
  for (const file of [USER_PREFS, ...(cwd ? [pick(path.join(cwd, '.claude', 'foreman.md'), path.join(cwd, '.claude', 'codex-bridge.md'))] : [])]) {
    let text = readText(file);
    if (!text) continue;
    if (text.length > MAX_PREFS_CHARS) text = `${text.slice(0, MAX_PREFS_CHARS)}\n${t.truncated}`;
    parts.push((file === USER_PREFS ? t.prefsUser : t.prefsProject)(file, text));
  }

  // 新键存在就以它为准（写成 null 表示用默认目录），没有新键才看迁移前的旧键。
  const runsDir = config?.dispatch && Object.hasOwn(config.dispatch, 'runs_dir') ? config.dispatch.runs_dir : config?.runs_dir;
  const runsRoot = process.env.FOREMAN_RUNS_DIR || process.env.CODEX_RUNS_DIR || runsDir || pick(path.join(HOME_DIR, 'runs'), path.join(os.homedir(), '.claude', 'codex-runs'));
  const unfinished = unfinishedRuns(runsRoot, cwd);
  if (unfinished.length) parts.push([
    t.unfinishedHeading,
    ...unfinished.map((m) => t.unfinishedRun(m, t.unfinishedStatuses[m.status])),
    t.unfinishedFooter,
  ].join('\n'));

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') },
  }));
});
