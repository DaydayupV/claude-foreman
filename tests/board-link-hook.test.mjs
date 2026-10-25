import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, json, poll, ROOT } from './helpers.mjs';

// 网页看板开着时，派出任务的命令运行前由钩子把看板链接直接显示给用户（board-link.mjs）
const { dispatchOf, automatedPrompt } = await import(pathToFileURL(path.join(ROOT, 'foreman/hooks/board-link.mjs')).href);
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

test('后台任务的完成通知、其他会话的进展、检查结果和只有提醒的消息不算用户发的新消息', () => {
  for (const prompt of ['<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>',
    '<system-reminder>\nThe session you started finished a turn.\n</system-reminder>\n<side-sessions-event>None of the sessions is working now.</side-sessions-event>',
    '<ci-monitor-event>checks passed</ci-monitor-event>', '<system-reminder>\nThe user started your proposal.\n</system-reminder>'])
    assert.equal(automatedPrompt(prompt), true, prompt);
  for (const prompt of ['继续', '<system-reminder>context</system-reminder>\n改成每发一条消息显示一次', '用 <task-notification> 这个标签做什么？',
    'Another Claude session sent a message:\n<cross-session-message from="local_x">开始第 2 阶段</cross-session-message>', '', undefined])
    assert.equal(automatedPrompt(prompt), false, String(prompt));
});

test('网页看板开着时显示带对话 id 的链接（服务没在跑就启动），用户每发一条消息只显示一次；关着时不显示', async (t) => {
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
    // 用户发了新消息（UserPromptSubmit）：钩子什么都不输出，只清掉这个对话的标记，下次派出又显示一次；别的对话不受影响
    const prompt = await h.hook('board-link.mjs', { cwd: h.cwd, session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '继续' });
    assert.equal(prompt.code, 0, prompt.stderr);
    assert.equal(prompt.stdout, '');
    assert.equal((await run('s2')).stdout, '');
    assert.match((await run('s1')).stdout, /&s=s1"/);
    assert.equal((await run('s1')).stdout, '');
    // 后台任务的完成通知也会触发 UserPromptSubmit：不算新消息，标记留着，这条消息里接着派出也不显示
    const notice = await h.hook('board-link.mjs', { cwd: h.cwd, session_id: 's1', hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>b1</task-id>\n</task-notification>' });
    assert.equal(notice.code, 0, notice.stderr); assert.equal(notice.stdout, '');
    assert.equal((await run('s1')).stdout, '');
    // 标记放在 foreman 目录里，不看命令里写的 FOREMAN_CONFIG：命令换了配置文件，这条消息里也不再显示
    const other = path.join(h.home, 'other-config.json');
    fs.copyFileSync(h.userConfig, other);
    const inline = { cwd: h.cwd, session_id: 's1', tool_input: { command: `FOREMAN_CONFIG="${other}" node "${cli}" run --level simple` } };
    assert.equal((await h.hook('board-link.mjs', inline)).stdout, '');
    assert.ok(fs.existsSync(path.join(path.dirname(h.userConfig), 'board-shown', 's1')));
    // 不是派出任务的命令不显示
    assert.equal((await h.hook('board-link.mjs', { cwd: h.cwd, session_id: 's3', tool_input: { command: `node "${cli}" status` } })).stdout, '');
    // 要结束这一轮（Stop）：这一轮在后台派出过、之后的正文里没有看板链接时拦一次，理由里带这个对话的链接；
    // 拦过一次（stop_hook_active）、正文里写了链接、这一轮没派出、派出是在前台跑的，都不拦
    const transcript = path.join(h.home, 'transcript.jsonl'), rows = [];
    const say = (role, content) => { rows.push(JSON.stringify({ type: role, message: { role, content } })); fs.writeFileSync(transcript, rows.join('\n') + '\n'); };
    const tool = (command, background) => say('assistant', [{ type: 'tool_use', id: `t${rows.length}`, name: 'Bash', input: { command, ...(background ? { run_in_background: true } : {}) } }]);
    const stop = (active = false) => h.hook('board-link.mjs', { cwd: h.cwd, session_id: 's1', hook_event_name: 'Stop', stop_hook_active: active, transcript_path: transcript });
    say('user', '派出去吧');
    tool(`node "${cli}" run --level simple --brief b.md`, true);
    say('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: b1' }]);
    say('assistant', [{ type: 'text', text: '我先做自己那一份。' }]);
    tool('node own.mjs');
    const blocked = await stop();
    assert.equal(blocked.code, 0, blocked.stderr);
    const out = JSON.parse(blocked.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.includes(`[网页看板](http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=zh&s=s1)`), out.reason);
    assert.equal((await stop(true)).stdout, '');
    say('assistant', [{ type: 'text', text: `已派出：gpt-6-astra low · [网页看板](http://127.0.0.1:${lock.port}/${lock.token}/?level=all&lang=zh&s=s1)` }]);
    assert.equal((await stop()).stdout, '');
    // 链接之后又派出一次、没再写：照样拦；新的一轮（完成通知唤醒）里没派出，不拦；前台跑的派出不拦
    tool(`node "${cli}" resume --run r1 --level simple`, true);
    assert.equal(JSON.parse((await stop()).stdout).decision, 'block');
    say('user', '<task-notification>\n<task-id>b1</task-id>\n</task-notification>');
    say('assistant', [{ type: 'text', text: '验收完了。' }]);
    assert.equal((await stop()).stdout, '');
    tool(`node "${cli}" run --level simple --brief c.md`);
    assert.equal((await stop()).stdout, '');
    config.dispatch.watch = { terminal: true, web: false };
    h.config(config);
    assert.equal((await run('s4')).stdout, '');
    tool(`node "${cli}" run --level simple --brief d.md`, true);
    assert.equal((await stop()).stdout, '');
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
