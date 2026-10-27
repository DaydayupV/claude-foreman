#!/usr/bin/env node
// 把 LiveBench 网页复制的榜单导入模型档位表；只读取身份表，不依赖运行时模块。
//   node tools/import-livebench.mjs --input <文件> --date <YYYY-MM-DD> [--out <路径>] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'foreman/skills/dispatch/scripts');
const DIMENSIONS = { Agentic: 'agentic', Design: 'design', Coding: 'coding', 'Browser Use': 'browser', 'Data Analysis': 'data', Research: 'research', Reasoning: 'reasoning' };
const COST = 'Cost per Successful Task';
const COLUMNS = ['Overall', ...Object.keys(DIMENSIONS), COST];
const LABELS = { strong: '强', mid: '中', weak: '弱' };
const normalize = (name) => name.trim().replace(/\s+/g, ' ').toLowerCase();

function parseBoard(text) {
  const lines = text.split(/\r?\n/).map((text, i) => ({ text: text.trim(), line: i + 1 })).filter(({ text }) => text);
  let columns = COLUMNS;
  if (lines[0] && !lines[0].text.startsWith('▸')) {
    const header = lines.shift();
    const names = header.text.split(header.text.includes('|') ? '|' : /\t+| {2,}/).map((name) => name.trim()).filter(Boolean);
    columns = names.slice(1);
    if (names[0] !== 'Model' || [...columns].sort().join('|') !== [...COLUMNS].sort().join('|')) {
      throw new Error(`第 ${header.line} 行（表头）：列名应包含 Model、Overall、七项分数和 ${COST}`);
    }
  }
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const start = lines[i];
    const name = lines[i + 1]?.text;
    const fail = (line, reason) => { throw new Error(`第 ${line} 行（${name && !name.startsWith('▸') ? name : '未知模型'}）：${reason}`); };
    if (!/^▸\s*$/.test(start.text)) fail(start.line, '模型块须以 ▸ 开头');
    if (!name || name.startsWith('▸')) fail(start.line, '缺少模型名');
    i += 2;
    const open = lines[i]?.text === 'open';
    if (open) i++;
    const row = lines[i];
    if (!row || row.text.startsWith('▸')) fail(row?.line ?? start.line, '缺少分数');
    const fields = row.text.split(/\s+/);
    if (fields.length !== columns.length) fail(row.line, '应有综合分、七项分数和 $ 花费');
    const values = Object.fromEntries(columns.map((column, j) => {
      const value = column === COST ? fields[j].match(/^\$(\d+(?:\.\d+)?)$/)?.[1] : fields[j];
      if (!/^\d+(?:\.\d+)?$/.test(value ?? '')) fail(row.line, `无法解析 ${column}：${fields[j]}`);
      return [column, Number(value)];
    }));
    rows.push({ name, overall: values.Overall, scores: Object.fromEntries(Object.entries(DIMENSIONS).map(([column, dim]) => [dim, values[column]])), cost_per_task: values[COST], open });
    i++;
    if (lines[i] && !lines[i].text.startsWith('▸')) fail(lines[i].line, '分数行后应是下一个模型块');
  }
  if (!rows.length) throw new Error('第 1 行（未知模型）：没有模型块');
  return rows;
}

function main() {
  const { values: args } = parseArgs({ options: { input: { type: 'string' }, date: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  if (!args.input || !/^\d{4}-\d{2}-\d{2}$/.test(args.date ?? '')) {
    throw new Error('用法：node tools/import-livebench.mjs --input <文件> --date <YYYY-MM-DD> [--out <路径>] [--dry-run]');
  }
  const out = path.resolve(args.out ?? path.join(SCRIPTS, 'model-tiers.json'));
  const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {
    thresholds: { strong: 84, mid: 75 }, dimensions: Object.values(DIMENSIONS), sources: {}, models: {},
  };
  // 旧榜单会覆盖较新的分数、让 as_of 倒退，所以不导入比现有数据更早的榜单
  if (old.as_of && args.date < old.as_of) throw new Error(`--date ${args.date} 早于现有数据的日期 ${old.as_of}，不导入`);
  const orphans = Object.entries(old.models).filter(([, model]) => !old.sources?.[model.source]).map(([id, model]) => `${id}（${model.source}）`);
  if (orphans.length) throw new Error(`${out} 里这些条目的来源在 sources 里没有，先补上再导入：${orphans.join('、')}`);
  const catalog = JSON.parse(fs.readFileSync(path.join(SCRIPTS, 'models.json'), 'utf8')).models;
  const names = new Map(Object.entries(catalog).flatMap(([id, model]) => [model.display, ...(model.board_names ?? [])].map((name) => [normalize(name), id])));
  const source = `livebench-${args.date}`;
  const tier = (overall) => overall >= old.thresholds.strong ? 'strong' : overall >= old.thresholds.mid ? 'mid' : 'weak';
  const models = { ...old.models };
  const matched = new Set();
  const added = [], updated = [], removed = [], unknown = [];
  for (const { name, ...entry } of parseBoard(fs.readFileSync(args.input, 'utf8'))) {
    const id = names.get(normalize(name));
    if (!id) { unknown.push(name); continue; }
    const model = { source, ...entry };
    const previous = old.models[id];
    const label = LABELS[tier(model.overall)];
    if (!previous) added.push(`${id}  ${model.overall}  ${label}`);
    else if (JSON.stringify(previous) !== JSON.stringify(model)) {
      const changed = (previous.tier ?? tier(previous.overall)) !== tier(model.overall);
      updated.push(`${id}  ${previous.overall ?? LABELS[previous.tier]} → ${model.overall}  ${label}${changed ? '（档位变化）' : ''}`);
    }
    models[id] = model;
    matched.add(id);
  }
  for (const [id, model] of Object.entries(old.models)) {
    if (!matched.has(id) && model.source.startsWith('livebench-') && old.sources[model.source].checked < args.date) {
      delete models[id];
      removed.push(id);
    }
  }
  // 来源分组后再排序，使同一份榜单重复导入时文件不变。
  const sources = [...new Set(Object.values(models).map((model) => model.source))].filter((key) => key !== source)
    .sort((a, b) => Number(a.startsWith('legacy-')) - Number(b.startsWith('legacy-')) || b.localeCompare(a));
  sources.unshift(source);
  const sorted = Object.fromEntries(Object.entries(models).sort(([aId, a], [bId, b]) =>
    sources.indexOf(a.source) - sources.indexOf(b.source) || (a.source.startsWith('legacy-') ? aId.localeCompare(bId) : b.overall - a.overall || aId.localeCompare(bId))));
  const data = {
    schema_version: 1,
    as_of: args.date,
    thresholds: old.thresholds,
    dimensions: old.dimensions,
    sources: Object.fromEntries([...new Set(Object.values(sorted).map((model) => model.source))].map((key) =>
      [key, key === source ? { name: 'LiveBench', url: 'https://livebench.ai', checked: args.date } : old.sources[key]])),
    models: sorted,
  };
  const body = Object.entries(data).map(([key, value]) => {
    const json = ['sources', 'models'].includes(key)
      ? `{\n${Object.entries(value).map(([id, entry]) => `    ${JSON.stringify(id)}: ${JSON.stringify(entry)}`).join(',\n')}\n  }`
      : JSON.stringify(value);
    return `  "${key}": ${json}`;
  }).join(',\n');
  if (!args['dry-run']) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `{\n${body}\n}\n`);
  }
  for (const [title, rows] of [['新增：', added], ['更新：', updated], ['榜上已没有（已删除）：', removed], ['对不上的名字（没写入）：', unknown]]) {
    if (!rows.length) continue;
    console.log(`${title}\n${rows.join('\n')}`);
    if (rows === unknown) console.log('要收录就在 models.json 里加这个模型（或给已有模型加 board_names）');
    console.log();
  }
  console.log(args['dry-run'] ? '只预览，没有写入文件' : `已写入 ${out}`);
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
