import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// dispatch skill 拆成核心加 references 以后的静态检查：核心不再涨回去，引用的文件都在，中英两版文件对得上。
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = ['foreman', 'foreman-en'];
// 核心每次触发都整份载入，按 token 估算定上限（中文约 0.87 token/字，英文约 0.33 token/字符），约 8k token
const CORE_BUDGET = { foreman: 9000, 'foreman-en': 24000 };
// 拆分前的节名，现在都已移到 references 里，不该再被引用
const STALE = ['"附：调用方式"', '"附：配置"', '"返工与失败"', '"一、方案阶段', '"五、审查"', '"三、执行', '"四、验收', '"实时查看"一节', '"一格有多个候选时"',
  '"Appendix: ', '"Rework and failure"', '"1. Settling', '"5. Review"', '"3. Hands-on', '"4. Checking', '"When a cell has several candidates"'];

const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? (e.name === 'node_modules' || e.name === 'board' ? [] : files(p)) : /\.(md|mjs)$/.test(e.name) ? [p] : [];
});
const referenceDir = (plugin) => path.join(REPO, plugin, 'skills', 'dispatch', 'references');

test('dispatch 核心不超过预算', () => {
  for (const plugin of PLUGINS) {
    const size = fs.readFileSync(path.join(REPO, plugin, 'skills', 'dispatch', 'SKILL.md'), 'utf8').length;
    assert.ok(size <= CORE_BUDGET[plugin], `${plugin} 的 SKILL.md 有 ${size} 字符，超过 ${CORE_BUDGET[plugin]}`);
  }
});

test('中英两版的 references 是同一组文件', () => {
  const list = (plugin) => fs.readdirSync(referenceDir(plugin)).sort();
  assert.deepEqual(list('foreman-en'), list('foreman'));
});

test('引用到的 references 文件都存在，也不再引用拆分前的节名', () => {
  for (const plugin of PLUGINS) {
    const existing = new Set(fs.readdirSync(referenceDir(plugin)));
    for (const file of [...files(path.join(REPO, plugin, 'skills')), ...files(path.join(REPO, plugin, 'hooks'))]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [, name] of text.matchAll(/references\/([\w.-]+\.md)/g)) assert.ok(existing.has(name), `${path.relative(REPO, file)} 引用了不存在的 references/${name}`);
      for (const stale of STALE) assert.ok(!text.includes(stale), `${path.relative(REPO, file)} 还在引用旧节名 ${stale}`);
    }
  }
});
