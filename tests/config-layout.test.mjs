import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatConfigText, isOneLine } from '../foreman/skills/dispatch/scripts/config-layout.mjs';
import { sandbox, output, failed, read, json, write, poll, BRIDGE, CODEX, MESSAGES } from './helpers.mjs';

const sample = {
  dispatch: { watch: { terminal: false, web: false } },
  modules: {
    default: {
      run: { simple: 'claude code', complex: [{ agent: 'gpt-6.1-sol-codex-cli', effort: 'high' }] },
      review: {
        normal: [{ agent: 'gpt-6-astra-codex-cli', effort: 'high', required: true }, { agent: 'gpt-6.1-sol-codex-cli', effort: 'high' }],
        complex: [{ agent: 'gpt-6-astra-codex-cli', effort: 'max', required: true }, { agent: 'gemini-3.8-flash-agy-cli', effort: 'high' }],
        seats: { normal: 3, complex: 6 }, gap: { normal: true, complex: true },
      },
      image: { generate: null, draw: null },
    },
    writing: { run: { normal: 'claude code' } },
  },
};
const expected = `{
  "dispatch": {
    "watch": {
      "terminal": false,
      "web": false
    }
  },
  "modules": {
    "default": {
      "run": {
        "simple": "claude code",
        "complex": [
          { "agent": "gpt-6.1-sol-codex-cli", "effort": "high" }
        ]
      },
      "review": {
        "normal": [
          { "agent": "gpt-6-astra-codex-cli", "effort": "high", "required": true },
          { "agent": "gpt-6.1-sol-codex-cli", "effort": "high" }
        ],
        "complex": [
          { "agent": "gpt-6-astra-codex-cli", "effort": "max", "required": true },
          { "agent": "gemini-3.8-flash-agy-cli", "effort": "high" }
        ],
        "seats": { "normal": 3, "complex": 6 },
        "gap": { "normal": true, "complex": true }
      },
      "image": { "generate": null, "draw": null }
    },
    "writing": {
      "run": { "normal": "claude code" }
    }
  }
}
`;

test('样例逐字一致：default、场景、字符串格子、null 图像格子、候选、seats 和 gap', () => {
  assert.equal(formatConfigText(sample), expected);
});

test('不同配置深相等往返，嵌套元素展开，只有顶层 modules 使用一项一行', () => {
  const outside = { agents: { x: { type: 'codex cli', model: 'x' } }, dispatch: { modules: sample.modules } };
  assert.equal(formatConfigText(outside), JSON.stringify(outside, null, 2) + '\n');
  const nested = { modules: { list: [{ agent: 'x', extra: { required: true } }, ['a', 'b'], {}, [], null, 3, false] } };
  assert.ok(formatConfigText(nested).includes('    "list": [\n      {\n        "agent": "x",'));
  assert.ok(formatConfigText(nested).includes('      [\n        "a",\n        "b"\n      ],\n      {},\n      [],'));
  for (const value of [sample, outside, nested, {}, { modules: {} }, { modules: [], text: '引号 "、\\、\n' },
    JSON.parse('{"modules":{"2":{"normal":[]},"1":{"normal":null},"__proto__":{"agent":"x"}}}')]) {
    const text = formatConfigText(value);
    assert.deepEqual(JSON.parse(text), value);
    assert.equal(formatConfigText(JSON.parse(text)), text);
  }
});

test('isOneLine 忽略开头 BOM 和换行差异，保留末尾换行要求，坏 JSON 返回 null', () => {
  assert.equal(isOneLine(expected), true);
  assert.equal(isOneLine('\uFEFF' + expected.replace(/\n/g, '\r\n')), true);
  assert.equal(isOneLine(expected.replace(/\n/g, '\r')), true);
  for (const text of [JSON.stringify(sample, null, 2) + '\n', expected.trimEnd(), expected + '\n']) assert.equal(isOneLine(text), false);
  assert.equal(isOneLine('\uFEFF{broken'), null);
});

test('layout 改写用户和项目配置、备份原文并保留权限，重复运行不动文件', async (t) => {
  const h = sandbox(t);
  h.config(sample);
  const projectValue = { dispatch: { watch: 'off' }, modules: { review: sample.modules.default.review } };
  const project = h.write('.claude/foreman.json', projectValue);
  const aliases = write(path.join(path.dirname(h.userConfig), 'agent-aliases.json'), '{broken');
  fs.chmodSync(h.userConfig, 0o600);
  const files = [h.userConfig, project], originals = files.map(read), mode = fs.statSync(h.userConfig).mode & 0o777;
  // 原地改写：文件本身不换，Windows 上单独设的访问控制和属主随文件保留
  const ids = files.map((file) => fs.statSync(file).ino);
  const result = output(await h.bridge(['layout', '--cwd', h.cwd]));
  assert.equal(result.files.length, 2);
  for (const [i, item] of result.files.entries()) {
    assert.deepEqual(item, { file: files[i], kind: i ? 'project' : 'user', one_line: false, changed: true, backup: item.backup });
    assert.ok(item.backup.startsWith(`${files[i]}.layout-`));
    assert.match(item.backup, /\.layout-\d{8}-\d{6}\.bak$/);
    assert.equal(read(item.backup), originals[i]);
    assert.equal(isOneLine(read(files[i])), true);
  }
  assert.deepEqual(json(h.userConfig), sample);
  assert.deepEqual(json(project), projectValue);
  assert.equal(read(h.userConfig), expected);
  assert.equal(fs.statSync(h.userConfig).mode & 0o777, mode);
  assert.deepEqual(files.map((file) => fs.statSync(file).ino), ids);
  const times = files.map((file) => fs.statSync(file).mtimeMs);
  assert.deepEqual(output(await h.bridge(['layout', '--cwd', h.cwd])), {
    files: files.map((file, i) => ({ file, kind: i ? 'project' : 'user', one_line: true, changed: false, backup: null })),
  });
  assert.deepEqual(files.map((file) => fs.statSync(file).mtimeMs), times);
  assert.equal(read(aliases), '{broken');
  assert.equal(fs.existsSync(h.runs), false);
  for (const file of files) assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.layout-')).length, 1);
});

test('layout --check 只报告改写前状态，不写配置、备份或锁', async (t) => {
  const h = sandbox(t);
  h.config(sample);
  const project = h.write('.claude/foreman.json', '\uFEFF' + expected.replace(/\n/g, '\r\n'));
  const files = [h.userConfig, project], originals = files.map(read);
  const dirs = files.map((file) => fs.readdirSync(path.dirname(file)));
  assert.deepEqual(output(await h.bridge(['layout', '--cwd', h.cwd, '--check'])), {
    files: files.map((file, i) => ({ file, kind: i ? 'project' : 'user', one_line: !!i, changed: false, backup: null })),
  });
  assert.deepEqual(files.map(read), originals);
  assert.deepEqual(files.map((file) => fs.readdirSync(path.dirname(file))), dirs);
});

test('layout --no-backup 使用 FOREMAN_CONFIG，缺少项目配置时跳过，不留备份', async (t) => {
  const h = sandbox(t), original = read(h.userConfig);
  const value = { levels: { run: { normal: 'claude' } }, modules: { review: sample.modules.default.review } };
  const custom = write(path.join(h.home, 'custom/foreman.json'), value);
  assert.deepEqual(output(await h.bridge(['layout', '--cwd', h.cwd, '--no-backup'], { env: { FOREMAN_CONFIG: custom } })), {
    files: [{ file: custom, kind: 'user', one_line: false, changed: true, backup: null }],
  });
  assert.deepEqual(json(custom), value);
  assert.deepEqual(fs.readdirSync(path.dirname(custom)), ['foreman.json']);
  assert.equal(read(h.userConfig), original);
});

test('任一配置解析失败，都不改写或备份任何配置', async (t) => {
  for (const kind of ['user', 'project']) await t.test(kind, async (t) => {
    const h = sandbox(t), project = h.write('.claude/foreman.json', sample);
    const file = kind === 'user' ? h.userConfig : project;
    write(file, '\uFEFF{broken');
    const files = [h.userConfig, project], originals = files.map(read);
    const dirs = files.map((file) => fs.readdirSync(path.dirname(file)));
    failed(await h.bridge(['layout', '--cwd', h.cwd]), file);
    assert.deepEqual(files.map(read), originals);
    assert.deepEqual(files.map((file) => fs.readdirSync(path.dirname(file))), dirs);
  });
});

test('layout 使用迁移的写锁，备份重名时保留旧备份并追加时间和 pid', async (t) => {
  const h = sandbox(t), original = read(h.userConfig), lock = `${h.userConfig}.structure.lock`;
  // 备份名用本地时间；测试的子进程时区是 UTC（helpers.mjs 的 TZ），所以固定的那一刻就是 03:04:05
  const collision = write(`${h.userConfig}.layout-20000102-030405.bak`, '已有备份');
  write(lock, String(process.pid));
  const script = h.write('layout-lock.mjs', `import fs from 'node:fs';
const RealDate = Date;
globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2000-01-02T03:04:05Z'])); } };
const write = fs.writeFileSync;
fs.writeFileSync = (file, ...args) => { if (file === ${JSON.stringify(lock)}) process.stderr.write('layout-lock\\n'); return write(file, ...args); };
process.argv = [process.execPath, ${JSON.stringify(BRIDGE)}, 'layout'];
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  const child = h.start(script);
  await poll(() => child.stderr.includes('layout-lock'), '等待配置写锁');
  assert.equal(read(h.userConfig), original);
  assert.equal(read(lock), String(process.pid));
  fs.rmSync(lock);
  const result = output(await child.done).files[0];
  assert.ok(result.backup.startsWith(`${collision}-`));
  assert.match(result.backup.slice(collision.length), /^-\d+-\d+$/);
  assert.equal(read(collision), '已有备份');
  assert.equal(read(result.backup), original);
  assert.equal(fs.existsSync(lock), false);
});

test('读回内容不一致或无法解析时恢复原文，并按指定语言报 layoutMismatch', async (t) => {
  for (const [lang, corrupt] of [['zh', '{"changed":true}'], ['en', '{broken']]) await t.test(lang, async (t) => {
    const h = sandbox(t);
    h.config('\uFEFF' + JSON.stringify(sample, null, 2).replace(/\n/g, '\r\n') + '\r\n');
    const original = read(h.userConfig);
    // 第一次原地写完、关闭文件时把它改坏，模拟读回内容不一致
    const script = h.write('layout-mismatch.mjs', `import fs from 'node:fs';
const open = fs.openSync, close = fs.closeSync, target = ${JSON.stringify(h.userConfig)};
let fd = null, corrupted = false;
fs.openSync = (file, flags, ...rest) => { const n = open(file, flags, ...rest); if (file === target && flags === 'r+' && !corrupted) fd = n; return n; };
fs.closeSync = (n) => { close(n); if (n === fd) { fd = null; corrupted = true; fs.writeFileSync(target, ${JSON.stringify(corrupt)}); } };
process.argv = [process.execPath, ${JSON.stringify(BRIDGE)}, 'layout'];
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    failed(await h.start(script, [], { env: { FOREMAN_LANG: lang } }).done, MESSAGES[lang].layoutMismatch(h.userConfig));
    assert.equal(read(h.userConfig), original);
    const names = fs.readdirSync(path.dirname(h.userConfig));
    assert.equal(names.filter((name) => name.includes('.layout-')).length, 1);
    assert.ok(names.every((name) => !name.endsWith('.tmp') && !name.endsWith('.lock')));
  });
});

test('首次生成和迁移改写的配置文件都已经是一项一行', async (t) => {
  for (const kind of ['starter', 'migration']) await t.test(kind, async (t) => {
    const h = sandbox(t, { config: false });
    if (kind === 'migration') h.config({ agents: { codex: { type: 'codex', bin: CODEX, model: 'migrated' } } });
    output(await h.bridge(['config']));
    assert.equal(isOneLine(read(h.userConfig)), true);
  });
});

test('layout 中英文帮助和总帮助列出新命令，不触发旧文件迁移', async (t) => {
  const h = sandbox(t, { config: false });
  write(path.join(h.home, '.claude/codex-bridge.json'), sample);
  for (const lang of ['zh', 'en']) {
    const r = await h.bridge(['layout', '--check', '--no-backup', '--help'], { env: { FOREMAN_LANG: lang } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, MESSAGES[lang].help.layout + '\n');
    const usage = await h.bridge(['--help'], { env: { FOREMAN_LANG: lang } });
    assert.equal(usage.stdout, MESSAGES[lang].usage + '\n');
    assert.ok(usage.stdout.includes('|layout|'));
  }
  assert.equal(fs.existsSync(h.userConfig), false);
});

test('layout 认项目里的旧文件名 .claude/codex-bridge.json', async (t) => {
  const h = sandbox(t);
  h.config(sample);
  output(await h.bridge(['layout']));
  const legacy = h.write('.claude/codex-bridge.json', { modules: { default: { review: sample.modules.default.review } } });
  const result = output(await h.bridge(['layout', '--cwd', h.cwd, '--no-backup']));
  assert.deepEqual(result.files[1], { file: legacy, kind: 'project', one_line: false, changed: true, backup: null });
  assert.equal(isOneLine(read(legacy)), true);
});

test('用户配置还不存在时说明先生成，不建任何文件', async (t) => {
  for (const lang of ['zh', 'en']) await t.test(lang, async (t) => {
    const h = sandbox(t), missing = path.join(h.home, 'nowhere', 'config.json');
    failed(await h.bridge(['layout'], { env: { FOREMAN_CONFIG: missing, FOREMAN_LANG: lang } }), MESSAGES[lang].layoutNoConfig(missing));
    assert.equal(fs.existsSync(path.dirname(missing)), false);
  });
});

test('原地写到一半出错时写回原文；写回也失败时说出备份在哪里', async (t) => {
  for (const [name, failures] of [['截断第一次出错', 1], ['截断一直出错', Infinity]]) await t.test(name, async (t) => {
    const h = sandbox(t);
    h.config(JSON.stringify(sample, null, 2) + '\n');
    const original = read(h.userConfig);
    const script = h.write('layout-eio.mjs', `import fs from 'node:fs';
const truncate = fs.ftruncateSync;
let left = ${failures === Infinity ? 'Infinity' : failures};
fs.ftruncateSync = (fd, len) => { if (left-- > 0) throw Object.assign(new Error('EIO: i/o error, ftruncate'), { code: 'EIO' }); return truncate(fd, len); };
process.argv = [process.execPath, ${JSON.stringify(BRIDGE)}, 'layout'];
await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
    const r = await h.start(script).done;
    const backup = fs.readdirSync(path.dirname(h.userConfig)).find((n) => n.includes('.layout-'));
    assert.ok(backup);
    assert.equal(read(path.join(path.dirname(h.userConfig), backup)), original);
    if (failures === 1) {
      failed(r, MESSAGES.zh.layoutWriteFailed(h.userConfig, 'EIO: i/o error, ftruncate'));
      assert.equal(read(h.userConfig), original);
    } else {
      failed(r, MESSAGES.zh.layoutRestoreFailed(h.userConfig, path.join(path.dirname(h.userConfig), backup)));
    }
  });
});
