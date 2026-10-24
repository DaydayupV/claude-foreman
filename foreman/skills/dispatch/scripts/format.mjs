// 实时查看、status 和开工那一行共用的显示格式：颜色、模型标签、状态记号和状态词、用时、用量、动作和折叠。
// 这三处的字段（状态词、用时、计数、模型标签、用量、标签和提示）中英两个插件都用英文那一套 D，显示成一样；
// 模型和 Claude 写的内容照原文显示，报错和其他提示仍按插件的语言。
import path from 'node:path';
import { MESSAGES } from './messages.mjs';
import { textWidth, fitWidth } from './util.mjs';
import { costOf, loadPrices } from './prices.mjs';

import { D as displayText, seatLine as displaySeatLine, shortModel, fullModel, modelLabel, moduleOf, taskLine, clock, took, shownStatus,
  outcomeStyle as displayOutcomeStyle, agentTotal, changedText, changedFor, outsideCwdText, formatUsd, usageLine as displayUsageLine,
  toolLabel, commandAction, foldText, thoughtLine } from './display.mjs';
const D = { ...MESSAGES.en, ...displayText };

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

// 身份行下面的分工行：角色、并发拆分这一份的标题（都加粗）和等级、图像的格子；Claude Code 席审自己写的东西时加暗色的 author。
// 放不下 width 时先截标题和角色，再整行截短
const seatLine = (m, options) => displaySeatLine(m, options, C);

const outcomeStyle = (o) => displayOutcomeStyle(o, C);

// 身份行：[暗色席位号] 记号 <模型标签>，整行按状态上色加粗，右边是状态：状态词上色，时钟和补充暗色。
// right 是 [状态词, 时钟, 补充]；窗口窄时先截模型标签，再去掉补充和时钟，最后才截状态词
function identityLine(m, style, right, width, no = null) {
  const lead = no != null ? `${C.dim(String(no))} ` : '';
  const leadW = no != null ? String(no).length + 3 : 2;
  const [word = '', ...rest] = right.filter(Boolean);
  const textOf = (list) => [word, list.join(' · ')].filter(Boolean).join(' ');
  let extra = rest;
  while (extra.length && leadW + 4 + textWidth(textOf(extra)) > width) extra = extra.slice(0, -1); // 模型标签至少留 4 列
  let text = textOf(extra);
  if (leadW + textWidth(text) > width - 1) text = fitWidth(text, Math.max(1, width - 1 - leadW));
  const head = text.startsWith(word) ? word : text;
  const painted = text ? style.color(head) + C.dim(text.slice(head.length)) : '';
  const room = width - leadW - textWidth(text) - (text ? 2 : 0);
  const label = room >= 1 ? fitWidth(modelLabel(m), room) : '';
  const gap = ' '.repeat(Math.max(text && label ? 2 : 0, width - leadW - textWidth(label) - textWidth(text)));
  return `${lead}${style.color(style.mark)} ${label ? C.bold(style.color(label)) : ''}${text ? gap + painted : ''}`;
}

// 定价依赖本地价格表；纯显示函数只接收算好的费用。
const usageLine = (result, meta) => displayUsageLine({ ...result, ...costOf({ ...meta, ...result }, loadPrices()) }, meta);

// 计划那一行只给状态词上色："计划 <id>："用默认色，完整绿、不完整红、进行中青
const PLAN_COLOR = { complete: C.green, incomplete: C.red, pending: C.cyan };
const paintPlanWord = (line, state) => line.replace(D.planStates[state], (word) => (PLAN_COLOR[state] || plain)(word));

// 组视图结束后的汇总最后写一行回看某一席的命令；路径里有空格或 shell 特殊字符时加双引号，换上 run_id 就能运行
const shellPath = (p) => (/[\s"'`$&|;<>()]/.test(p) ? `"${p}"` : p);
const replayCommand = (runsRoot) => D.watchReplayOne(`node ${shellPath(path.join(runsRoot, 'watch.mjs'))} --run <run_id>`);

export { D, TEST_SCREEN, termCols, termRows, useColor, C, plain, visibleWidth, padWidth, shortModel, fullModel, modelLabel, moduleOf, taskLine, seatLine, identityLine, clock, took,
  shownStatus, outcomeStyle, agentTotal, changedText, changedFor, outsideCwdText, formatUsd, usageLine, toolLabel, commandAction, foldText, thoughtLine, paintPlanWord, replayCommand };
