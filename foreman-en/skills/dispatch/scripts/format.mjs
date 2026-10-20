// 实时查看、status 和开工那一行共用的显示格式：颜色、模型标签、状态记号和状态词、用时、用量、动作和折叠。
// 这三处的字段（状态词、用时、计数、模型标签、用量、标签和提示）中英两个插件都用英文那一套 D，显示成一样；
// 模型和 Claude 写的内容照原文显示，报错和其他提示仍按插件的语言。
import path from 'node:path';
import { MESSAGES } from './messages.mjs';
import { modelOf, agentTypeOf, oneLine, plainCommand, textWidth, fitWidth } from './util.mjs';

const D = MESSAGES.en;

// 测试用 FOREMAN_TEST_SCREEN=<宽>x<高> 把输出当成这么大的终端：画实时画面，也照常判断要不要上色。
const TEST_SCREEN = /^(\d+)x(\d+)$/.exec(process.env.FOREMAN_TEST_SCREEN || '');
const termCols = () => (TEST_SCREEN ? Number(TEST_SCREEN[1]) : process.stdout.columns || 100);
const termRows = () => (TEST_SCREEN ? Number(TEST_SCREEN[2]) : process.stdout.rows || 30);

// 颜色只有一条规则：只给状态记号和状态词上色（运行中青、完成绿、交回问题和等人回答黄、其余没做成的红），
// 提醒类的记号（⚠ ⋯）用黄色；标题和模型名用默认色加粗；次要信息（路径、用量、提示、时间、动作）用暗色。
const useColor = (process.stdout.isTTY || !!TEST_SCREEN) && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor && s !== '' ? `\x1b[${code}m${s}\x1b[0m` : s);
const C = { dim: paint('2'), bold: paint('1'), red: paint('31'), green: paint('32'), yellow: paint('33'), cyan: paint('36') };
const plain = (s) => s;
const visibleWidth = (s) => textWidth(s.replace(/\x1b\[[0-9;]*m/g, ''));
// 按显示宽度补空格（中日韩字符占两格，颜色代码不占），用来对齐 status 的各列
const padWidth = (s, width) => s + ' '.repeat(Math.max(0, width - visibleWidth(s)));

// 模型名去掉"提供方/"前缀；带前缀的完整写法放进时间线开头的详细信息行。
const shortModel = (model) => String(model).slice(String(model).lastIndexOf('/') + 1) || String(model);
const fullModel = (m) => (modelOf(m).includes('/') ? modelOf(m) : null);
// 模型标签：<模型> · <接入方式> · 推理强度 <强度>。旧记录没有 agent_type 和 model_name，都是 Codex CLI。
const CHANNEL_KEY = { api: 'api', 'opencode cli': 'opencode', 'pi cli': 'pi' };
const modelLabel = (m) => D.modelLabel(shortModel(modelOf(m)), D.channel[CHANNEL_KEY[agentTypeOf(m)] || 'codex'], m?.effort,
  !m?.model && !!m?.model_name && agentTypeOf(m) === 'codex cli');

// 运行中的计时写成 12:03，结束后写"用时 19 分 18 秒"
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
};
const took = (sec) => (Number.isFinite(sec) ? D.took(D.duration(sec)) : ''); // 旧记录可能没有用时，就不写

// 执行顺利结束时以报告里的状态为准（完成、部分完成、交回问题……）
const shownStatus = (status, r) => (status === 'done' ? r?.needs_decision ? 'blocked' : r?.report?.status || status : status);
// o 是 runOutcome 的结果：运行中 ●、完成 ✔、交回问题和等人回答 ?，其余 ✗
function outcomeStyle(o) {
  const style = o.running ? { mark: '●', color: C.cyan } : o.ok ? { mark: '✔', color: C.green } : o.blocked ? { mark: '?', color: C.yellow } : { mark: '✗', color: C.red };
  return { ...style, word: D.statusName(o.running ? 'running' : shownStatus(o.status, o.result)) };
}

// 改动数包括有证据的和协作方自报的；改名前的记录里叫 codex_total。落在同组其他任务写入范围里的（group_run）不算归属未知。
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

// 费用按金额大小保留足够精度，零不带小数。status 和 watch 共用同一行用量与费用，只有费用时也照常显示。
const formatUsd = (n) => (n === 0 ? '0' : n < 0.01 ? n.toPrecision(2) : n < 1 ? n.toFixed(3) : n.toFixed(2));
function usageLine(result, meta) {
  return [result?.usage ? D.tokenSummary(result.usage, result.last_request ?? result.context, D.tokenCount,
    (result.usage_scope ?? (meta?.mode === 'resume' ? 'session_total' : 'this_run')) === 'session_total') : '',
  result?.cost_usd != null ? D.costUsd(formatUsd(result.cost_usd)) : ''].filter(Boolean).join(' · ');
}

// 工具调用怎么显示：opencode 和 pi 的读文件、搜索（category 为 read 或 search）写成"读 …""搜索 …"，不算命令、不加 $。
function commandAction(it) {
  if (it.category === 'read' || it.category === 'search') {
    const text = oneLine(it.command);
    const rest = it.tool && text === it.tool ? '.' : it.tool && text.startsWith(`${it.tool} `) ? text.slice(it.tool.length + 1) : text;
    return { kind: it.category, text: it.category === 'read' ? D.actionRead(rest) : D.actionSearch(rest) };
  }
  return { kind: 'command', text: `$ ${oneLine(plainCommand(it.command))}` };
}
// 折叠起来的动作按种类计数，比如"… 另有 12 条命令、3 次读文件"
const foldText = (counts, hint = true) => D.watchFolded(D.list(Object.entries(counts).filter(([, n]) => n > 0).map(([kind, n]) => D.foldKinds[kind](n))), hint);

// 思考摘要只取第一行，去掉 Markdown 的加粗
const thoughtLine = (text) => oneLine(String(text ?? '').trim().split('\n').find((l) => l.trim()) || '').replace(/\*\*/g, '');

// 计划那一行只给状态词上色："计划 <id>："用默认色，完整绿、不完整红、进行中青
const PLAN_COLOR = { complete: C.green, incomplete: C.red, pending: C.cyan };
const paintPlanWord = (line, state) => line.replace(D.planStates[state], (word) => (PLAN_COLOR[state] || plain)(word));

// 组视图结束后的汇总里，每一席下面写一行回看命令；路径里有空格或 shell 特殊字符时加双引号，整行复制就能运行
const shellPath = (p) => (/[\s"'`$&|;<>()]/.test(p) ? `"${p}"` : p);
const replayCommand = (runsRoot, id) => D.watchReplay(`node ${shellPath(path.join(runsRoot, 'watch.mjs'))} --run ${id}`);

export { D, TEST_SCREEN, termCols, termRows, useColor, C, plain, visibleWidth, padWidth, shortModel, fullModel, modelLabel, clock, took,
  shownStatus, outcomeStyle, agentTotal, changedText, changedFor, formatUsd, usageLine, commandAction, foldText, thoughtLine, paintPlanWord, replayCommand };
