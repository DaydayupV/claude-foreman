// 盘点用户格子里用到的模型，并给 models.md 补上缺少的节，保留用户写过的原文。
import fs from 'node:fs';
import path from 'node:path';
import { USER_CONFIG, eachEntry } from './config.mjs';
import { adapters } from './adapters/index.mjs';
import { modelIdentity, modelInfo } from './models.mjs';
import { tierOf } from './tiers.mjs';
import { M, replaceFile, retryBusy } from './util.mjs';

export const modelNotesFile = () => path.join(path.dirname(USER_CONFIG), 'models.md');

function usedModels(cfg, hostModel) {
  const models = new Map();
  const add = (model, channel) => {
    if (!model) return;
    const id = modelIdentity(model);
    if (!models.has(id)) models.set(id, new Set());
    models.get(id).add(channel);
  };
  for (const modules of Object.values(cfg.scene_modules)) for (const { item } of eachEntry(modules)) {
    const agent = cfg.agents[item.agent], adapter = adapters[agent.type];
    add(item.model || agent.model || adapter.status(agent).model, adapter.channel);
  }
  add(hostModel, M.reportHost);
  return models;
}

// 和读偏好文件一样，Windows 上别的进程短暂占用时重试；其余错误照常报出，免得把读不了的原文当成不存在而覆盖。
function readNotes(file) {
  try { return retryBusy(() => fs.readFileSync(file)); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function notesStatus(file, content, models) {
  const sections = new Map();
  const placeholder = /^(?:-\s+)?(?:LiveBench(?:[：:]|（| \()|(?:擅长：|短处：|Strengths:|Weaknesses:)$)/;
  for (const block of (content?.toString('utf8') ?? '').replace(/^\uFEFF/, '').split(/^## /m).slice(1)) {
    const [heading, ...lines] = block.split(/\r?\n/);
    const id = modelIdentity(heading.trim().split(/[\s（(]/, 1)[0].replace(/^`+|`+$/g, ''));
    const written = lines.map((line) => line.trim()).some((line) => line && !placeholder.test(line));
    sections.set(id, sections.get(id) || written);
  }
  const ids = [...models.keys()];
  return { file, exists: content !== null, created: false, added: [],
    missing: ids.filter((id) => !sections.has(id)), unwritten: ids.filter((id) => sections.get(id) === false) };
}

export function modelNotesStatus(cfg, { hostModel } = {}) {
  const file = modelNotesFile();
  return notesStatus(file, readNotes(file), usedModels(cfg, hostModel));
}

function section(id, channels, hostId) {
  const t = M.modelNotes, rating = tierOf(id);
  const strengths = M.list(rating.strengths.map((dim) => M.dimNames[dim]));
  const weaknesses = M.list(rating.weaknesses.map(({ dim, level }) => M.dimNames[dim] + (level === 'very_weak' ? t.veryWeak : '')));
  const liveBench = rating.rated ? t.liveBench(rating.checked, M.tierNames[rating.tier], strengths, weaknesses) : t.notRated;
  return [t.heading(id, M.list([...channels])), liveBench,
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
  const sections = added.map((id) => section(id, models.get(id), hostId) + '\n').join('\n');
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
