import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, baseConfig, apiAgent, opencodeAgent, output, read, write, MESSAGES } from './helpers.mjs';

const blank = (file, missing = []) => ({ file, exists: false, created: false, added: [], missing, unwritten: [] });
const notes = (h, ...args) => h.bridge(['model-notes', ...args]).then(output);

for (const lang of ['zh', 'en']) test(`生成 ${lang} 模型特长，标题只写模型名，合并别名，按场景收录并填写 Claude 主持方默认值`, async (t) => {
  const h = sandbox(t), c = baseConfig(), m = MESSAGES[lang];
  const file = path.join(path.dirname(h.userConfig), 'models.md');
  const host = ['--host-model', 'anthropic/claude-sonnet-4.6'];
  h.env.FOREMAN_LANG = lang;
  c.agents.codex.model = 'deepseek-v4.1-flash-1017';
  c.agents.oc = { ...opencodeAgent(), model: 'go/deepseek-flash' };
  c.agents.scene = { ...apiAgent('http://127.0.0.1:9'), model: 'scene-only' };
  c.agents.idle = { ...c.agents.scene, model: 'unused-model' };
  c.modules.default.run.complex.unshift({ agent: 'self' });
  c.modules.default.review.normal = { agent: 'oc' };
  c.modules.draft = { discuss: { complex: { agent: 'scene' } } };
  h.config(c);
  h.write('.claude/foreman.json', { modules: { default: { discuss: { simple: { agent: 'idle' } } } } });

  const original = read(h.userConfig), ids = ['deepseek-flash', 'scene-only', 'claude-sonnet-4-6'];
  assert.deepEqual(await notes(h, ...host), blank(file, ids));
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await notes(h, '--write', ...host), {
    file, exists: true, created: true, added: ids, missing: [], unwritten: ids,
  });
  const text = read(file);
  assert.ok(text.startsWith(m.modelNotes.header + '\n\n'));
  assert.deepEqual(text.match(/^## .+$/gm), ['## deepseek-flash', '## scene-only', '## claude-sonnet-4-6']);
  const liveBench = lang === 'zh' ? '- LiveBench（2026-10-18）：弱档，长处 推理，短处 Agentic（很弱）'
    : '- LiveBench (2026-10-18): weak tier; strong in Reasoning; weak in Agentic (very weak)';
  assert.ok(text.includes([m.modelNotes.notRated, m.modelNotes.strengths, m.modelNotes.weaknesses].join('\n')));
  assert.ok(text.endsWith([liveBench, m.modelNotes.defaultLine(m.modelNotes.strengths, m.modelNotes.hostStrengths), m.modelNotes.weaknesses, ''].join('\n')), text);
  assert.equal(read(h.userConfig), original);
});

for (const lang of ['zh', 'en']) test(`${lang} 默认版本按系列填上插件自带的判断，Opus 主持方合并原来的分工，没改过的默认行不算写过`, async (t) => {
  const h = sandbox(t), c = baseConfig(), m = MESSAGES[lang].modelNotes;
  const file = path.join(path.dirname(h.userConfig), 'models.md');
  h.env.FOREMAN_LANG = lang;
  c.agents.codex.model = 'gpt-6.2-astra';
  for (const [agent, model] of [['sol', 'gpt-6.2-sol'], ['neon', 'gemini-4-neon-xhigh'], ['opus', 'claude-opus-4-8'], ['flash', 'deepseek-flash']]) {
    c.agents[agent] = { ...c.agents.codex, model };
  }
  c.modules.default.run.complex = ['codex', 'sol', 'neon', 'opus', 'flash'].map((agent) => ({ agent }));
  h.config(c);
  const ids = ['gpt-6.2-astra', 'gpt-6.2-sol', 'gemini-4-neon', 'claude-opus-4-8', 'deepseek-flash', 'claude-opus-5-5'];
  assert.deepEqual((await notes(h, '--write', '--host-model', 'claude-opus-5-5')).unwritten, ids);
  // 每节去掉标题和 LiveBench 那一行，只看擅长、短处两行
  const lines = () => Object.fromEntries(read(file).split(/^## /m).slice(1).map((block) => {
    const [heading, , ...rest] = block.trim().split('\n');
    return [heading, rest];
  }));
  const [gpt, gemini, opus] = m.defaults, both = (d) => [m.defaultLine(m.strengths, d.strengths), m.defaultLine(m.weaknesses, d.weaknesses)];
  assert.deepEqual(lines(), {
    'gpt-6.2-astra': both(gpt), 'gpt-6.2-sol': both(gpt), 'gemini-4-neon': both(gemini),
    'claude-opus-4-8': [m.defaultLine(m.strengths, opus.strengths), m.weaknesses],
    'deepseek-flash': [m.strengths, m.weaknesses],
    'claude-opus-5-5': [m.defaultLine(m.strengths, opus.host), m.weaknesses],
  });
  write(file, read(file).replace(both(gpt)[1], `${m.weaknesses} ${lang === 'zh' ? '实测不明显' : 'not seen here'}`));
  assert.deepEqual((await notes(h, '--host-model', 'claude-opus-5-5')).unwritten, ids.filter((id) => id !== 'gpt-6.2-astra'));
});

test('状态跟随 FOREMAN_CONFIG，忽略项目覆盖，只在文末追加缺少的节并保留每个原字节', async (t) => {
  const h = sandbox(t), c = baseConfig(), custom = path.join(h.home, 'settings', 'custom.json');
  const file = path.join(path.dirname(custom), 'models.md');
  h.env.FOREMAN_CONFIG = custom;
  c.agents.codex.model = 'deepseek-v4.1-flash-1017';
  c.modules.default.run = {
    simple: { agent: 'codex', model: 'gpt-6-astra' },
    normal: { agent: 'codex', model: 'glm-5.3' },
    complex: { agent: 'codex', model: 'gpt-6.1-sol' },
  };
  write(custom, c);
  h.write('.claude/foreman.json', { modules: { default: { run: { complex: { agent: 'codex', model: 'project-only' } } } } });
  const config = () => h.bridge(['config', '--cwd', h.cwd]).then(output);
  const before = await config();
  assert.deepEqual(before.model_notes, { file, exists: false, missing: ['deepseek-flash', 'gpt-6-astra', 'glm-5.3', 'gpt-6.1-sol'], unwritten: [] });
  assert.deepEqual(before.summary.warnings.find(({ kind }) => kind === 'models_doc_missing'),
    { kind: 'models_doc_missing', file, message: MESSAGES.zh.modelsDocMissing(file) });
  assert.equal(before.resolved_modules.run.complex[0].model, 'project-only');
  const original = Buffer.from([
    '\uFEFF# 我的模型经验', '', '## deepseek-v4.1-flash-1017（自定义）', '- LiveBench（2026-10-10）：中档', '- 擅长：', '- 短处：',
    '', '## gpt-6-astra (Custom)', '- LiveBench: not rated', '- Strengths:', '- Weaknesses:',
    '', '## glm-5.3 (Custom)', '- Strengths: 项目实测笔记',
  ].join('\r\n'));
  write(file, original);
  const status = await notes(h);
  assert.deepEqual(status, { file, exists: true, created: false, added: [], missing: ['gpt-6.1-sol'], unwritten: ['deepseek-flash', 'gpt-6-astra'] });
  const current = await config();
  assert.deepEqual(current.model_notes, { file, exists: true, missing: status.missing, unwritten: status.unwritten });
  assert.equal(current.summary.warnings.some(({ kind }) => kind === 'models_doc_missing'), false);
  assert.deepEqual(fs.readFileSync(file), original);

  const host = ['--host-model', 'unlisted-host'];
  const written = await notes(h, '--write', ...host);
  assert.deepEqual(written, { file, exists: true, created: false, added: ['gpt-6.1-sol', 'unlisted-host'], missing: [],
    unwritten: ['deepseek-flash', 'gpt-6-astra', 'gpt-6.1-sol', 'unlisted-host'] });
  const appended = fs.readFileSync(file);
  assert.deepEqual(appended.subarray(0, original.length), original);
  assert.match(appended.subarray(original.length).toString(), /^\r\n\r\n## gpt-6\.1-sol\r\n/);
  assert.ok(read(file).endsWith('## unlisted-host\r\n- LiveBench：未评级\r\n- 擅长：\r\n- 短处：\r\n'));
  assert.deepEqual(await notes(h, '--write', ...host), { ...written, added: [] });
  assert.deepEqual(fs.readFileSync(file), appended);
});

test('标题里的模型 ID 带反引号或紧跟半角括号时也能认出', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.codex.model = 'gpt-6-astra';
  c.agents.other = { ...c.agents.codex, model: 'glm-5.3' };
  c.modules.default.run.complex = [{ agent: 'codex' }, { agent: 'other' }];
  h.config(c);
  write(path.join(path.dirname(h.userConfig), 'models.md'), '## `gpt-6-astra`（Codex CLI）\n- 擅长：后端\n\n## glm-5.3(Codex CLI)\n- 擅长：前端\n');
  const status = await notes(h);
  assert.deepEqual([status.missing, status.unwritten], [[], []]);
});

test('标题可以只写一部分或并列几个模型，版本号按前缀比，补节只补哪一节都对不上的模型', async (t) => {
  const h = sandbox(t), c = baseConfig();
  const file = path.join(path.dirname(h.userConfig), 'models.md');
  c.agents.codex.model = 'deepseek-v4.1-flash';
  c.agents.opus = { ...c.agents.codex, model: 'claude-opus-5-5' };
  c.agents.old = { ...c.agents.codex, model: 'claude-opus-4-5' };
  c.agents.fable = { ...c.agents.codex, model: 'claude-fable-5-2' };
  c.agents.gpt = { ...c.agents.codex, model: 'gpt-6.1-sol' };
  c.modules.default.run.complex = ['codex', 'opus', 'old', 'fable', 'gpt'].map((agent) => ({ agent }));
  h.config(c);
  write(file, '## deepseek-flash, kimi\n- 擅长：快\n\n## claude-opus-5、claude-fable\n- 短处：贵\n\n## qwen，gpt-6-sol（备注）\n- 擅长：\n');
  const status = await notes(h);
  assert.deepEqual([status.missing, status.unwritten], [['claude-opus-4-5'], ['gpt-6.1-sol']]);
  const written = await notes(h, '--write');
  assert.deepEqual([written.added, written.missing], [['claude-opus-4-5'], []]);
  assert.deepEqual(read(file).match(/^## .+$/gm), ['## deepseek-flash, kimi', '## claude-opus-5、claude-fable', '## qwen，gpt-6-sol（备注）', '## claude-opus-4-5']);
  write(file, '## Claude Opus 4.5\n- 擅长：稳\n\n## gpt\n- 短处：啰嗦\n');
  assert.deepEqual((await notes(h)).missing, ['deepseek-flash', 'claude-opus-5-5', 'claude-fable-5-2']);
});

test('括号备注里的逗号、标题末尾的 #、多段版本号和数字后面的符号都按规则处理', async (t) => {
  const h = sandbox(t), c = baseConfig();
  const file = path.join(path.dirname(h.userConfig), 'models.md');
  c.agents.codex.model = 'glm-5.3';
  c.agents.opus = { ...c.agents.codex, model: 'claude-opus-5.5.1' };
  c.agents.acme = { ...c.agents.codex, model: 'acme-s1+' };
  c.agents.sonnet = { ...c.agents.codex, model: 'claude-sonnet-4-6' };
  c.modules.default.run.complex = ['codex', 'opus', 'acme', 'sonnet'].map((agent) => ({ agent }));
  h.config(c);
  write(file, '## deepseek-flash (benchmarks, glm, local)\n- 擅长：快\n\n## claude-opus-5.5.1\n- 擅长：稳\n\n## acme-s1\n- 擅长：便宜\n\n## claude-sonnet-4-6 ##\n- 短处：慢\n');
  assert.deepEqual((await notes(h)).missing, ['glm-5.3', 'acme-s1+']);
});
