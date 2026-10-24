import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, json, poll, ROOT } from './helpers.mjs';

// 网页看板开着时，派出任务的命令运行前由钩子把看板链接直接显示给用户（board-link.mjs）
const { dispatchOf } = await import(pathToFileURL(path.join(ROOT, 'foreman/hooks/board-link.mjs')).href);
const cli = 'C:/x/plugin/skills/dispatch/scripts/cli.mjs';

test('认出用 cli.mjs 派出任务的命令和命令里写的 FOREMAN_CONFIG', () => {
  assert.deepEqual(dispatchOf(`node "${cli}" run --cwd . --level simple`), { config: undefined });
  assert.deepEqual(dispatchOf(`cd proj && node ${cli} resume --run x --reason rework`), { config: undefined });
  assert.deepEqual(dispatchOf(`FOREMAN_CONFIG=/tmp/c.json node "${cli}" discuss --plan p --seat 1`), { config: '/tmp/c.json' });
  assert.deepEqual(dispatchOf(`$env:FOREMAN_CONFIG = 'C:\\t\\c.json'; & node "${cli}" review --plan p --seat 1`), { config: 'C:\\t\\c.json' });
  assert.deepEqual(dispatchOf(`export FOREMAN_CONFIG="/c.json"\nnode ${cli} image --plan p --seat 1`), { config: '/c.json' });
  // 带空格的路径、续行、作为选项值的 --help
  assert.deepEqual(dispatchOf(`$env:FOREMAN_CONFIG = 'C:\\Users\\Jane Doe\\c.json'; & node "${cli}" run`), { config: 'C:\\Users\\Jane Doe\\c.json' });
  assert.deepEqual(dispatchOf(`FOREMAN_CONFIG="/a b/c.json" node "${cli}" run`), { config: '/a b/c.json' });
  assert.deepEqual(dispatchOf(`node \\\n  "${cli}" run --level simple`), { config: undefined });
  assert.deepEqual(dispatchOf(`node \`\r\n  "${cli}" \`\r\n  resume --run x`), { config: undefined });
  assert.deepEqual(dispatchOf(`node "${cli}" run --title --help --level simple`), { config: undefined });
  for (const command of [`node "${cli}" plan --module run`, `node "${cli}" board`, `node "${cli}" run --help`, `node "${cli}" run --level simple -h`, `node other/cli.mjs run`,
    `cat <<'EOF'\nnode ${cli} run\nEOF`, `echo "node ${cli} run"`]) assert.equal(dispatchOf(command), null, command);
});

test('网页看板开着时显示带对话 id 的链接（服务没在跑就启动），3 分钟内同一个对话只显示一次；关着时不显示', async (t) => {
  const h = sandbox(t), config = baseConfig(), lockFile = path.join(h.runs, 'board.lock.json');
  config.dispatch.watch = { terminal: true, web: true };
  h.config(config);
  const run = (session) => h.hook('board-link.mjs', { cwd: h.cwd, session_id: session, tool_input: { command: `node "${cli}" run --level simple` } });
  try {
    const first = await run('s1');
    assert.equal(first.code, 0, first.stderr);
    const lock = json(lockFile);
    assert.deepEqual(JSON.parse(first.stdout), { systemMessage: `网页看板：http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=zh&s=s1` });
    assert.equal((await fetch(`http://127.0.0.1:${lock.port}/${lock.token}/health`)).status, 200);
    assert.equal((await run('s1')).stdout, '');
    assert.match((await run('s2')).stdout, /&s=s2"/);
    assert.deepEqual(json(lockFile), lock);
    // 一起派出、钩子同时运行时只显示一次
    const together = await Promise.all([run('s6'), run('s6'), run('s6')]);
    assert.equal(together.filter((r) => r.stdout).length, 1);
    // 3 分钟以后再派出又显示：把 s1 的标记挪成很早以前那一段的
    const shown = path.join(h.runs, 'board-shown'), [marker] = fs.readdirSync(shown).filter((name) => name.startsWith('s1.'));
    fs.renameSync(path.join(shown, marker), path.join(shown, `s1.${Number(marker.slice(3)) - 5}`));
    assert.match((await run('s1')).stdout, /&s=s1"/);
    assert.equal((await run('s1')).stdout, '');
    // 不是派出任务的命令不显示
    assert.equal((await h.hook('board-link.mjs', { cwd: h.cwd, session_id: 's3', tool_input: { command: `node "${cli}" status` } })).stdout, '');
    config.dispatch.watch = { terminal: true, web: false };
    h.config(config);
    assert.equal((await run('s4')).stdout, '');
    // 和 cli.mjs 一样，项目配置关不掉网页看板
    config.dispatch.watch = { terminal: true, web: true };
    h.config(config); h.write('.claude/foreman.json', { dispatch: { watch: { web: false } } });
    assert.match((await run('s5')).stdout, /&s=s5"/);
  } finally {
    if (fs.existsSync(lockFile)) {
      const { pid } = json(lockFile);
      process.kill(pid);
      await poll(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, '看板服务退出');
      fs.rmSync(lockFile, { force: true });
    }
  }
});
