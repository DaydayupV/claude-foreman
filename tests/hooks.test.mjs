import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sandbox, output, write, seedRun, ROOT } from './helpers.mjs';

test('会话提醒首次使用并且不创建配置或迁移目录', async (t) => {
  const h = sandbox(t, { config: false });
  const r = output(await h.hook('session-reminder.mjs')).hookSpecificOutput;
  assert.equal(r.hookEventName, 'SessionStart');
  assert.ok(r.additionalContext.includes(`没有配置文件 ${h.userConfig}`));
  assert.ok(r.additionalContext.includes('/foreman:setup'));
  assert.ok(r.additionalContext.includes('foreman:dispatch'));
  assert.equal(fs.existsSync(path.join(h.home, '.claude/foreman')), false);
});

for (const legacy of [false, true]) {
  test(`会话提醒带上${legacy ? '旧位置' : '新位置'}偏好并说明项目优先与场景块替换`, async (t) => {
    const h = sandbox(t, { config: false });
    const configFile = legacy ? path.join(h.home, '.claude/codex-bridge.json') : h.userConfig;
    write(configFile, legacy ? { auto_dispatch: false } : { dispatch: { auto: false }, agents: { model: { type: 'codex cli' } } });
    const user = write(path.join(h.home, legacy ? '.claude/codex-bridge.md' : '.claude/foreman/preferences.md'), '合成用户偏好');
    const project = h.write(legacy ? '.claude/codex-bridge.md' : '.claude/foreman.md', '合成项目偏好');
    const context = output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext;
    assert.ok(context.includes('dispatch.auto 已关闭'));
    for (const [file, text, source] of [[user, '合成用户偏好', '用户'], [project, '合成项目偏好', '项目']]) {
      assert.ok(context.includes(`${source}偏好文件 ${file}`));
      assert.ok(context.includes(text));
    }
    assert.ok(context.includes('和用户偏好冲突时以它为准，场景块有就只用它的；同样只在插件的硬规则以内调整做法'));
    assert.ok(context.includes('必选、材料外发、只读、确认弹窗和席位上限不受偏好文件影响'));
    assert.ok(!context.includes('用户还没有用过本插件'));
    if (legacy) assert.equal(fs.existsSync(h.userConfig), false);
  });
}

test('英文偏好说明项目优先、场景块替换和硬规则，plans 不算未完成任务', async (t) => {
  const h = sandbox(t);
  const user = write(path.join(h.home, '.claude/foreman/preferences.md'), 'synthetic user preferences');
  const project = h.write('.claude/foreman.md', 'synthetic project preferences');
  write(path.join(h.runs, 'plans/20000101-plan.json'), { plan_id: '20000101-plan', status: 'timeout', cwd: h.cwd });
  const context = output(await h.start(path.join(ROOT, 'foreman-en/hooks/session-reminder.mjs'), [], { input: JSON.stringify({ cwd: h.cwd }) }).done).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(`User preference file ${user} (adjusts how things are done within the plugin's hard rules`));
  assert.ok(context.includes(`Project preference file ${project} (wins over the user preferences where they conflict, and its scene block, if any, replaces the user's; it too only adjusts things within the plugin's hard rules`));
  assert.ok(context.includes("required seats, sending material out, read-only, confirmation prompts and the seat limit can't be changed by preference files"));
  assert.ok(!context.includes('20000101-plan'));
});

test('会话提醒列出未正常结束的执行任务，取消后不再列出', async (t) => {
  const h = sandbox(t);
  for (const status of ['timeout', 'stalled', 'quota_exhausted', 'interrupted']) seedRun(h, `exec-${status}`, { status });
  seedRun(h, 'ignored-discuss', { kind: 'discuss', mode: 'discuss', status: 'timeout' });
  seedRun(h, 'ignored-cancelled', { status: 'cancelled' });
  seedRun(h, 'ignored-other-project', { status: 'timeout', cwd: path.join(h.home, 'other-project') });
  seedRun(h, 'ignored-old', { status: 'timeout', started_at: new Date(Date.now() - 8 * 86400000).toISOString() });
  const context = () => h.hook('session-reminder.mjs').then((r) => output(r).hookSpecificOutput.additionalContext);
  const before = await context();
  for (const status of ['timeout', 'stalled', 'quota_exhausted', 'interrupted']) assert.ok(before.includes(`exec-${status}`));
  assert.ok(!before.includes('ignored-'));
  const result = output(await h.bridge(['cancel', '--run', 'exec-timeout']));
  assert.equal(result.dismissed, true);
  const after = await context();
  assert.ok(!after.includes('exec-timeout'));
  assert.ok(after.includes('exec-stalled'));
});

test('会话提醒以已退出任务的结果为准，没有结果仍提醒中断', async (t) => {
  const h = sandbox(t), meta = { status: 'running', pid: 2147483647 };
  seedRun(h, 'completed-result', meta, { status: 'done' }); seedRun(h, 'missing-result', meta);
  const context = output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext;
  assert.equal(context.includes('completed-result'), false);
  assert.ok(context.includes('missing-result｜run｜合成任务｜调度进程已退出，没有结果'));
});

test('会话提醒批量识别复用进程号的旧 running，保留当前 runner 且不回写记录', async (t) => {
  const h = sandbox(t), sleeper = h.start('-e', ['setInterval(() => {}, 1000)']);
  await once(sleeper.child, 'spawn');
  const meta = { status: 'running', pid: sleeper.child.pid, ended_at: undefined };
  const started_at = new Date(Date.now() - 3600000).toISOString();
  const dirs = ['old-runner-a', 'old-runner-b'].map((id) => seedRun(h, id, { ...meta, started_at }));
  seedRun(h, 'current-runner', { ...meta, started_at: new Date().toISOString() });
  seedRun(h, 'finished-runner', { ...meta, started_at }, { status: 'done' });
  seedRun(h, 'other-project-runner', { ...meta, started_at, cwd: path.join(h.home, 'other') });
  const before = dirs.map((dir) => fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const context = output(await h.hook('session-reminder.mjs', { cwd: h.cwd }, { timeout: 10000 })).hookSpecificOutput.additionalContext;
  for (const id of ['old-runner-a', 'old-runner-b']) assert.ok(context.includes(`${id}｜run｜合成任务｜调度进程已退出，没有结果`));
  for (const id of ['current-runner', 'finished-runner', 'other-project-runner']) assert.equal(context.includes(id), false);
  assert.deepEqual(dirs.map((dir) => fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), before);
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
});

test('会话提醒以 3000 毫秒查询，查询失败仍输出其余提醒', async (t) => {
  const h = sandbox(t), sleeper = h.start('-e', ['setInterval(() => {}, 1000)']);
  await once(sleeper.child, 'spawn');
  seedRun(h, 'query-timeout', { status: 'running', pid: sleeper.child.pid, started_at: new Date(Date.now() - 3600000).toISOString() });
  seedRun(h, 'already-interrupted', { status: 'interrupted' });
  const capture = path.join(h.home, 'query-timeouts.json');
  const script = h.write('hook-timeout.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync, timeouts = [];
childProcess.spawnSync = (...args) => {
  timeouts.push(args[2].timeout);
  fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify(timeouts));
  const result = spawn(...args);
  // 保留真实查询输出模拟超时，不实际等满超时。
  return { ...result, error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/hooks/session-reminder.mjs')).href)});`);
  const r = output(await h.start(script, [], { input: JSON.stringify({ cwd: h.cwd }), timeout: 10000 }).done);
  const context = r.hookSpecificOutput.additionalContext;
  assert.deepEqual(JSON.parse(fs.readFileSync(capture, 'utf8')), [3000]);
  assert.ok(context.includes('foreman:dispatch'));
  assert.ok(context.includes('already-interrupted'));
  assert.equal(context.includes('query-timeout｜'), false);
  assert.doesNotThrow(() => process.kill(sleeper.child.pid, 0));
});

test('会话提醒优先采用活进程号对应记录的中断结果，不回写元数据', async (t) => {
  const h = sandbox(t), id = 'interrupted-with-live-pid';
  const dir = seedRun(h, id, { status: 'running', pid: process.pid }, { status: 'interrupted' });
  seedRun(h, 'done-with-live-pid', { status: 'running', pid: process.pid }, { status: 'done' });
  const file = path.join(dir, 'meta.json'), before = fs.readFileSync(file, 'utf8');
  const context = output(await h.hook('session-reminder.mjs')).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(`${id}｜run｜合成任务｜调度进程已退出，没有结果`));
  assert.equal(context.includes('done-with-live-pid'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

for (const [label, command] of [
  ['codex exec', 'codex exec "synthetic"'], ['codex review', 'codex review --uncommitted'],
  ['node codex.js exec', 'node "C:/synthetic/bin/codex.js" exec -'], ['npx Codex', 'npx @openai/codex exec -'],
  ['npx -y Codex', 'npx -y @openai/codex exec -'], ['npx -p Codex', 'npx -p @openai/codex codex exec -'],
  ['opencode run', 'opencode run "synthetic"'], ['opencode.exe run', 'opencode.exe run -m fake/model'],
  ['opencode.cmd run', 'opencode.cmd run -'], ['opencode.ps1 run', '& "C:/synthetic/opencode.ps1" run -'],
  ['npx opencode-ai', 'npx opencode-ai run -'], ['npx @opencode/cli', 'npx @opencode/cli run -'],
  ['npx --yes opencode-ai', 'npx --yes opencode-ai run "synthetic"'],
  ['npx --package 后带 --yes', 'npx --package=opencode-ai --yes opencode run task'],
  ['npx -p 后带 -y', 'npx -p opencode-ai -y opencode run task'],
  ['npx 带值的选项', 'npx --package=opencode-ai --cache C:/cache opencode run task'],
  ['npx 写了几个 -p', 'npx -p opencode-ai -p other-package opencode run task'],
  ['npx --registry 后的包名', 'npx --registry https://registry.example @openai/codex exec -'],
  ['npx -c 整条命令', 'npx -c "codex exec -"'], ['npx --call= 整条命令', 'npx --call="opencode run task"'],
  ['opencode 全局选项', 'opencode --log-level debug run -'],
  ['heredoc 之后的调用', "cat > notes.md <<'EOF'\n| pi · deepseek |\nEOF\npi -p hello"],
  ['bash here-string 不算 heredoc', 'cat <<<EOF\npi -p hello'],
  ['引号里的 << 不算 heredoc', 'echo "<<EOF"\ncodex exec "check"'],
  ['注释里的 << 不算 heredoc', 'ls # see <<EOF\nopencode run task'],
  ['会展开的 heredoc 里的命令替换', 'cat <<EOF\n$(codex exec "check")\nEOF'],
  ['会展开的 heredoc 里的反引号', 'cat <<-END\n\t`pi -p hello`\n\tEND'],
  ['PowerShell 双引号 here-string 里的子表达式', 'Set-Content a.md @"\n$(codex exec "check")\n"@'],
]) {
  test(`直接调用守卫拦截 ${label}`, async (t) => {
    const h = sandbox(t), r = await h.hook('guard-direct-calls.mjs', { tool_input: { command } });
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('已拦截：不要直接调用 codex exec / codex review'));
    assert.ok(r.stderr.includes('foreman:dispatch'));
    assert.ok(r.stderr.includes('cli.mjs'));
  });
}

for (const [label, command] of [
  ['版本查询', 'codex --version'], ['登录状态', 'codex login status'],
  ['npx Codex 帮助', 'npx -y @openai/codex --help'], ['npx -c 别的命令', 'npx -c "echo hi"'],
  ['普通文本提及', 'echo "codex exec"'], ['带分隔符的文字', 'node -e "console.log(\'codex exec; codex review\')"'],
  ['opencode 版本', 'opencode --version'], ['opencode 模型', 'opencode models'],
  ['opencode 会话', 'opencode session export run'], ['opencode 认证', 'opencode auth list'],
  ['opencode 调试', 'opencode debug run'], ['opencode 服务', 'opencode service status'],
  ['opencode 帮助', 'opencode run --help'], ['opencode 总帮助', 'opencode --help'],
  ['opencode 文字提及', 'echo "opencode run"'], ['opencode 带分隔符的文字', 'node -e "console.log(\'opencode run; codex exec\')"'],
  ['heredoc 正文里的表格', "cat >> notes.md <<'EOF'\n| 席 | 协作方 |\n| 2 | pi · deepseek-flash |\ncodex exec 只是文字\nEOF"],
  ['<<- 带缩进的结束行', 'cat <<-END > a.txt\n\topencode run x\n\tEND'],
  ['PowerShell here-string', "Set-Content a.md @'\n| pi · deepseek |\n'@"],
  ['<<\\WORD 的正文原样是文字', 'cat <<\\EOF > a.md\n| pi · deepseek |\n$(codex exec "x")\nEOF'],
  ['加了引号的 heredoc 里的命令替换不执行', "cat <<'EOF' > a.md\n$(codex exec \"x\")\nEOF"],
  ['PowerShell 双引号 here-string 里没有子表达式', 'Set-Content a.md @"\n| pi · deepseek |\n"@'],
]) {
  test(`直接调用守卫放行${label}`, async (t) => {
    const h = sandbox(t), r = await h.hook('guard-direct-calls.mjs', { tool_input: { command } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
}

test('agy 的查询带上 shell 重定向照样放行，重定向不掩盖模型参数', async (t) => {
  const h = sandbox(t);
  for (const command of ['agy --version 2>&1', 'agy --version 2>&1 | head -2', 'agy --version > v.txt', 'agy --version 2> err.txt', 'agy models >models.txt 2>&1',
    'agy --version *> $null', 'agy --version *>&1', 'agy models *>$null', 'agy>v.txt --version'])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 0, command);
  // 带引号的 '>' 是传给程序的普通参数，不能当成重定向把后面的模型参数吞掉；紧贴程序名的重定向也要先拆开再认程序
  for (const command of ['agy --version 2>&1 -p hi', 'agy -p hi 2>&1', 'agy > out.txt', 'agy models > m.txt -p hi',
    "agy models '>' -p hi", 'agy help ">" --prompt hi', 'agy --version "*>" -p hi', 'agy>out.txt -p hi', 'agy>out.txt',
    'codex>log.txt exec hi', 'opencode>o.txt run hi', 'opencode run > o.txt hi', '"agy">out.txt -p hi', "'agy'>out.txt -p hi"])
    assert.equal((await h.hook('guard-direct-calls.mjs', { tool_input: { command } })).code, 2, command);
});

test('会话提醒核对期间任务写好结果时以结果为准，不误报中断', async (t) => {
  const h = sandbox(t), sleeper = h.start('-e', ['setInterval(() => {}, 1000)']);
  await once(sleeper.child, 'spawn');
  const dir = seedRun(h, 'finished-during-query', { status: 'running', pid: sleeper.child.pid, started_at: new Date(Date.now() - 3600000).toISOString() });
  const script = h.write('hook-finish-during-query.mjs', `import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  // 查询期间 runner 写好结果退出，进程号又被别的程序占着
  fs.writeFileSync(${JSON.stringify(path.join(dir, 'result.json'))}, JSON.stringify({ status: 'done' }));
  return spawn(...args);
};
syncBuiltinESMExports();
await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'foreman/hooks/session-reminder.mjs')).href)});`);
  const r = output(await h.start(script, [], { input: JSON.stringify({ cwd: h.cwd }), timeout: 10000 }).done);
  assert.equal(r.hookSpecificOutput.additionalContext.includes('finished-during-query'), false);
});
