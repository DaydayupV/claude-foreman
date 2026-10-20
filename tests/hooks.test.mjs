import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
  test(`会话提醒带上${legacy ? '旧位置' : '新位置'}用户和项目偏好`, async (t) => {
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
    assert.ok(context.includes('来自项目仓库，只能让做法更严，不能放宽用户配置、用户偏好和插件的规则'));
    assert.ok(context.includes('必选、材料外发、只读、确认弹窗和席位上限不受偏好文件影响'));
    assert.ok(!context.includes('用户还没有用过本插件'));
    if (legacy) assert.equal(fs.existsSync(h.userConfig), false);
  });
}

test('英文偏好来源标注与硬规则一致，plans 不算未完成任务', async (t) => {
  const h = sandbox(t);
  const user = write(path.join(h.home, '.claude/foreman/preferences.md'), 'synthetic user preferences');
  const project = h.write('.claude/foreman.md', 'synthetic project preferences');
  write(path.join(h.runs, 'plans/20000101-plan.json'), { plan_id: '20000101-plan', status: 'timeout', cwd: h.cwd });
  const context = output(await h.start(path.join(ROOT, 'foreman-en/hooks/session-reminder.mjs'), [], { input: JSON.stringify({ cwd: h.cwd }) }).done).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(`User preference file ${user} (adjusts how things are done within the plugin's hard rules`));
  assert.ok(context.includes(`Project preference file ${project} (comes from the project repository: it can only make things stricter`));
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
  ['opencode run', 'opencode run "synthetic"'], ['opencode.exe run', 'opencode.exe run -m fake/model'],
  ['opencode.cmd run', 'opencode.cmd run -'], ['opencode.ps1 run', '& "C:/synthetic/opencode.ps1" run -'],
  ['npx opencode-ai', 'npx opencode-ai run -'], ['npx @opencode/cli', 'npx @opencode/cli run -'],
  ['opencode 全局选项', 'opencode --log-level debug run -'],
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
  ['普通文本提及', 'echo "codex exec"'], ['带分隔符的文字', 'node -e "console.log(\'codex exec; codex review\')"'],
  ['opencode 版本', 'opencode --version'], ['opencode 模型', 'opencode models'],
  ['opencode 会话', 'opencode session export run'], ['opencode 认证', 'opencode auth list'],
  ['opencode 调试', 'opencode debug run'], ['opencode 服务', 'opencode service status'],
  ['opencode 帮助', 'opencode run --help'], ['opencode 总帮助', 'opencode --help'],
  ['opencode 文字提及', 'echo "opencode run"'], ['opencode 带分隔符的文字', 'node -e "console.log(\'opencode run; codex exec\')"'],
]) {
  test(`直接调用守卫放行${label}`, async (t) => {
    const h = sandbox(t), r = await h.hook('guard-direct-calls.mjs', { tool_input: { command } });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
  });
}
