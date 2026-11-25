// 盘点用户格子里用到的模型，并给 models.md 补上缺少的节，保留用户写过的原文。
import fs from 'node:fs';
import path from 'node:path';
import { USER_CONFIG, eachEntry } from './config.mjs';
import { adapters } from './adapters/index.mjs';
import { loadModels, modelIdentity, modelInfo, modelKey } from './models.mjs';
import { tierOf } from './tiers.mjs';
import { MESSAGES } from './messages.mjs';
import { M, replaceFile, retryBusy } from './util.mjs';

export const modelNotesFile = () => path.join(path.dirname(USER_CONFIG), 'models.md');

// 在用的模型：身份 ID → 它的各种写法（身份 ID、models.json 里的别名、配置里写的模型名），标题对上其中任意一种就算写的是它。
function usedModels(cfg, hostModel) {
  const models = new Map();
  const add = (model) => {
    if (!model) return;
    const id = modelIdentity(model);
    if (!models.has(id)) models.set(id, new Set([id, ...(loadModels()?.models?.[id]?.aliases ?? [])]));
    models.get(id).add(model);
  };
  for (const modules of Object.values(cfg.scene_modules)) for (const { item } of eachEntry(modules)) {
    const agent = cfg.agents[item.agent];
    add(item.model || agent.model || adapters[agent.type].status(agent).model);
  }
  add(hostModel);
  return models;
}

// 和读偏好文件一样，Windows 上别的进程短暂占用时重试；其余错误照常报出，免得把读不了的原文当成不存在而覆盖。
function readNotes(file) {
  try { return retryBusy(() => fs.readFileSync(file)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// 模型名切成段：在 - 和 _ 处、字母和数字的交界处切开；连续的纯数字段是一个版本号（claude-opus-4-5 的 4、5 合成 4.5）。
const VERSION = /^\d+(?:\.\d+)*$/;
function segments(name) {
  const out = [];
  let digits = false; // 上一段是不是纯数字段连成的
  for (const part of modelKey(name).split(/[-_]+/).flatMap((p) => p.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/))) {
    if (!part) continue;
    const integer = /^\d+$/.test(part);
    if (integer && digits) out[out.length - 1] += `.${part}`;
    else out.push(part);
    digits = integer;
  }
  return out;
}

// 标题里写出的每一段都按顺序出现在模型名里就算对上：词要相同，版本号按整段前缀比（5 对得上 5.5，对不上 4.5）。
function fits(term, name) {
  const want = segments(term), have = segments(name);
  let i = 0;
  for (const part of have) {
    const w = want[i];
    if (w === undefined) break;
    if (part === w || VERSION.test(w) && VERSION.test(part) && `${part}.`.startsWith(`${w}.`)) i++;
  }
  return want.length > 0 && i === want.length;
}

// 一个标题可以并列几个模型（中英文逗号、顿号隔开）；括号里的备注（里面的逗号也一样）、反引号和标题末尾的 # 不算。
const headingTerms = (heading) => heading.replace(/\s+#+\s*$/, '').replace(/[（(][^（()）]*[）)]/g, '').split(/[（(]/, 1)[0]
  .split(/[,，、]/).map((part) => part.replace(/`/g, '').trim()).filter(Boolean);
// 默认版本里的行：LiveBench 那一行、空着的擅长和短处，以及 Claude 主持方原样的默认擅长行。
const HOST_DEFAULTS = new Set(Object.values(MESSAGES).map((m) => m.modelNotes.hostStrengths));

function notesStatus(file, content, models) {
  const placeholder = /^(?:-\s+)?(?:LiveBench(?:[：:]|（| \()|(?:擅长：|短处：|Strengths:|Weaknesses:)$)/;
  const sections = (content?.toString('utf8') ?? '').replace(/^﻿/, '').split(/^## /m).slice(1).map((block) => {
    const [heading, ...lines] = block.split(/\r?\n/);
    return { terms: headingTerms(heading), written: lines.map((line) => line.trim()).some((line) => line && !placeholder.test(line) && !HOST_DEFAULTS.has(line)) };
  });
  const ids = [...models.keys()];
  const sectionsOf = (id) => sections.filter(({ terms }) => terms.some((term) => [...models.get(id)].some((name) => fits(term, name))));
  return { file, exists: content !== null, created: false, added: [],
    missing: ids.filter((id) => !sectionsOf(id).length),
    unwritten: ids.filter((id) => { const found = sectionsOf(id); return found.length > 0 && !found.some(({ written }) => written); }) };
}

export function modelNotesStatus(cfg, { hostModel } = {}) {
  const file = modelNotesFile();
  return notesStatus(file, readNotes(file), usedModels(cfg, hostModel));
}

function section(id, hostId) {
  const t = M.modelNotes, rating = tierOf(id);
  const strengths = M.list(rating.strengths.map((dim) => M.dimNames[dim]));
  const weaknesses = M.list(rating.weaknesses.map(({ dim, level }) => M.dimNames[dim] + (level === 'very_weak' ? t.veryWeak : '')));
  const liveBench = rating.rated ? t.liveBench(rating.checked, M.tierNames[rating.tier], strengths, weaknesses) : t.notRated;
  return [t.heading(id), liveBench,
    id === hostId && modelInfo(id).family === 'claude' ? t.hostStrengths : t.strengths, t.weaknesses].join('\n');
}

export function writeModelNotes(cfg, { hostModel } = {}) {
  const file = modelNotesFile(), models = usedModels(cfg, hostModel);
  const original = readNotes(file), status = notesStatus(file, original, models);
  if (status.exists && !status.missing.length) return status;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const text = original?.toString('utf8') ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = !text || /\r?\n[ \t]*\r?\n$/.test(text) ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  const prefix = status.exists ? separator : M.modelNotes.header + '\n\n';
  const hostId = modelIdentity(hostModel);
  const added = status.missing;
  const sections = added.map((id) => section(id, hostId) + '\n').join('\n');
  const next = Buffer.concat([original ?? Buffer.alloc(0), Buffer.from((prefix + sections).replaceAll('\n', eol))]);
  try {
    fs.writeFileSync(tmp, next);
    replaceFile(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { ...notesStatus(file, next, models), created: !status.exists, added };
}
