#!/usr/bin/env node
// 把两个插件共用的文件从中文插件同步到英文插件，并检查两个插件的版本号一致。
//
//   node tools/sync-shared.mjs          同步
//   node tools/sync-shared.mjs --check  只检查，不一致时退出码为 1（适合提交前或 CI 里跑）
//
// 共用文件以 foreman/ 为准，改脚本时只改那一份。各插件自己的 language.json、hooks.json、
// SKILL.md、命令说明和 schema 不同步。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'foreman');
const TARGET = path.join(ROOT, 'foreman-en');
function sharedFiles(root) {
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(rel) : entry.name === 'language.json' ? [] : [rel];
  });
  return [...walk('skills/dispatch/scripts'),
    ...fs.readdirSync(path.join(root, 'hooks')).filter((name) => name.endsWith('.mjs')).map((name) => `hooks/${name}`)];
}

const SHARED = sharedFiles(SOURCE);

const check = process.argv.includes('--check');
let problems = 0;

for (const rel of SHARED) {
  const src = fs.readFileSync(path.join(SOURCE, rel));
  const dest = path.join(TARGET, rel);
  const same = fs.existsSync(dest) && fs.readFileSync(dest).equals(src);
  if (same) continue;
  if (check) {
    console.log(`不一致：${rel}`);
    problems++;
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, src);
    console.log(`已同步：${rel}`);
  }
}

// 入口拆分后，目标插件里多出的旧脚本也要移除；只检查时列出来。
for (const rel of sharedFiles(TARGET).filter((rel) => !SHARED.includes(rel))) {
  if (check) {
    console.log(`多余文件：${rel}`);
    problems++;
  } else {
    fs.rmSync(path.join(TARGET, rel));
    console.log(`已同步：${rel}`);
  }
}

const version = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')).version;
if (version(SOURCE) !== version(TARGET)) {
  console.log(`版本号不一致：foreman ${version(SOURCE)}，foreman-en ${version(TARGET)}`);
  problems++;
}

// schema 的描述文字分中英文，不同步；只检查两边的结构（字段、类型、枚举、必填项）一致。
const SCHEMAS = ['report.schema.json', 'discuss.schema.json', 'review.schema.json'];
const shape = (node) => {
  if (Array.isArray(node)) return node.map(shape);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'description').map(([k, v]) => [k, shape(v)]));
};
for (const name of SCHEMAS) {
  const read = (dir) => shape(JSON.parse(fs.readFileSync(path.join(dir, 'skills', 'dispatch', 'schemas', name), 'utf8')));
  if (JSON.stringify(read(SOURCE)) !== JSON.stringify(read(TARGET))) {
    console.log(`schema 结构不一致：${name}（英文版需要手动对照修改）`);
    problems++;
  }
}

if (problems) process.exit(1);
console.log(check ? '两个插件的共用文件、schema 结构和版本号一致' : '同步完成');
