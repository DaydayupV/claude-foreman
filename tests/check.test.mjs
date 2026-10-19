import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, output, baseConfig, apiAgent, opencodeAgent, MESSAGES } from './helpers.mjs';
import { apiServer } from './fake/api-server.mjs';
const M = MESSAGES.zh;
const sandboxProbe = (mode, extra = []) => ['sandbox', ...extra, '-c', `sandbox_mode="${mode}"`, '--', ...(process.platform === 'win32' ? ['cmd', '/c', 'echo'] : ['echo']), 'foreman-sandbox-ok'];

for (const lang of ['zh', 'en']) {
  test(`check opencode 检查两个档位并报告拒绝项 (${lang})`, async (t) => {
    const h = sandbox(t), c = baseConfig(), messages = MESSAGES[lang];
    c.agents.oc = opencodeAgent();
    c.agents.oc.run_access = 'edit';
    c.modules.run.complex = { agent: 'oc', effort: 'low' };
    c.modules.review.normal = { agent: 'oc', effort: 'medium', model: 'fake/override' };
    h.config(c);
    const s = h.scenario({ reject_variants: ['medium'], last_message: 'OK' });
    const r = output(await h.bridge(['check', '--agent', 'oc'], { env: { ...s.env, FOREMAN_LANG: lang } }), 1);
    const error = 'Variant unavailable for fake/override: medium';
    assert.equal(r.ok, false);
    assert.equal(r.agents.oc.ok, false);
    assert.equal(r.agents.oc.error, error);
    assert.deepEqual(r.agents.oc.variants, [
      { model: 'fake/model', variant: 'low', used_at: ['modules.run.complex[0]'], ok: true, error: null },
      { model: 'fake/override', variant: 'medium', used_at: ['modules.review.normal[0]'], ok: false, error },
    ]);
    assert.equal(r.agents.oc.fix, messages.fixOpencodeVariant('oc', lang === 'en'
      ? 'medium (modules.review.normal[0])' : 'medium（modules.review.normal[0]）'));
    const calls = s.calls().filter((c) => c.operation === 'run');
    assert.deepEqual(calls.map((c) => c.args[c.args.indexOf('-m') + 1]), ['fake/model', 'fake/model#low', 'fake/override#medium']);
    assert.ok(calls.every((c) => c.stdin === 'Reply with the single word OK.'));
  });
}

test('check opencode 按模型和档位去重并保留所有等级位置', async (t) => {
  const h = sandbox(t), c = baseConfig(), usedAt = [];
  c.agents.oc = opencodeAgent();
  c.agents.oc.run_access = 'edit';
  for (const mode of ['discuss', 'run', 'review']) {
    for (const level of ['simple', 'normal', 'complex']) {
      const entry = { agent: 'oc', effort: 'high' };
      c.modules[mode][level] = mode === 'discuss' ? [{ agent: 'codex' }, entry] : entry;
      usedAt.push(`modules.${mode}.${level}${mode === 'discuss' ? '[1]' : '[0]'}`);
    }
  }
  c.modules.discuss.complex[1].model = 'fake/other';
  const overrideAt = usedAt.splice(usedAt.indexOf('modules.discuss.complex[1]'), 1)[0];
  h.config(c);
  const r = output(await h.bridge(['check', '--agent', 'oc']));
  assert.equal(r.agents.oc.ok, true);
  assert.deepEqual(r.agents.oc.variants, [
    { model: 'fake/model', variant: 'high', used_at: usedAt, ok: true, error: null },
    { model: 'fake/other', variant: 'high', used_at: [overrideAt], ok: true, error: null },
  ]);
  assert.deepEqual(h.calls().filter((c) => c.operation === 'run').map((c) => c.args[c.args.indexOf('-m') + 1]),
    ['fake/model', 'fake/model#high', 'fake/other#high']);
});

test('check opencode 没有配置档位时只发默认请求', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent();
  c.modules.review.simple = { agent: 'oc', effort: null };
  c.modules.discuss.normal = [{ agent: 'oc' }];
  h.config(c);
  const r = output(await h.bridge(['check', '--agent', 'oc']));
  assert.deepEqual(r.agents.oc.variants, []);
  assert.equal(h.calls().filter((c) => c.operation === 'run').length, 1);
});

test('check opencode 默认请求失败时不发档位请求', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.oc = opencodeAgent();
  c.modules.review.normal = { agent: 'oc', effort: 'high' };
  h.config(c);
  const s = h.scenario({ exit_code: 1, steps: [{ event: { type: 'error', error: { message: 'default failed' } } }] });
  const r = output(await h.bridge(['check', '--agent', 'oc'], { env: s.env }), 1);
  assert.equal(r.agents.oc.ok, false);
  assert.equal(r.agents.oc.error, 'default failed');
  assert.equal(r.agents.oc.fix, M.fixOpencodeRun('oc', 'default failed'));
  assert.deepEqual(r.agents.oc.variants, []);
  const calls = s.calls().filter((c) => c.operation === 'run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[calls[0].args.indexOf('-m') + 1], 'fake/model');
});

for (const loggedIn of [true, false]) {
  test(`check 识别 Codex ${loggedIn ? '已登录' : '未登录'}状态`, async (t) => {
    const h = sandbox(t), s = h.scenario({ logged_in: loggedIn });
    const r = output(await h.bridge(['check'], { env: s.env }), loggedIn ? 0 : 1);
    assert.equal(r.ok, loggedIn);
    assert.equal(r.agents.codex.ok, loggedIn);
    assert.equal(r.node.ok, true);
    assert.equal(r.git.ok, true);
    assert.equal(r.agents.codex.version, 'codex-cli synthetic-1.0');
    assert.equal(r.agents.codex.fix, loggedIn ? null : M.fixCodexLogin);
    // 已登录时还会读一次模型清单，核对配置的推理强度
    assert.deepEqual(s.calls().map((c) => c.args), loggedIn ? [['--version'], ['login', 'status'], ['debug', 'models'], sandboxProbe('read-only')] : [['--version'], ['login', 'status']]);
  });
}

test('check 找不到指定 Codex 时提示安装且不调用真实 CLI', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.codex.bin = path.join(h.home, 'missing-codex.exe');
  h.config(c);
  const r = output(await h.bridge(['check']), 1);
  assert.equal(r.ok, false);
  assert.equal(r.agents.codex.version, null);
  assert.equal(r.agents.codex.login, null);
  assert.equal(r.agents.codex.fix, M.fixCodexMissing);
  assert.equal(h.calls().length, 0);
});

for (const status of [200, 401]) {
  test(`check 报告 API ${status === 200 ? '可连通' : '认证失败'}且未被等级引用时不改变总体结果`, async (t) => {
    const h = sandbox(t), api = await apiServer(t, [status === 200 ? { answer: 'OK' } : { status, message: 'synthetic auth' }]);
    const c = baseConfig();
    c.agents.api = apiAgent(api.url);
    h.config(c);
    const r = output(await h.bridge(['check', '--agent', 'api']));
    assert.equal(r.ok, true);
    assert.equal(r.agents.api.ok, status === 200);
    assert.equal(api.requests.length, 1);
    assert.equal(api.requests[0].body.messages[0].content, 'Reply with the single word OK.');
    if (status === 200) {
      assert.equal(r.agents.api.reply, 'OK');
      assert.equal(r.agents.api.usage.input_tokens, 100);
    }
    else {
      assert.equal(r.agents.api.error, 'auth 401: synthetic auth');
      assert.equal(r.agents.api.fix, M.fixApiAuth('api', 'config'));
    }
  });
}

for (const listed of [true, false]) {
  test(`check 检查 opencode 模型${listed ? '存在' : '不存在'}于 models`, async (t) => {
    const h = sandbox(t), c = baseConfig();
    c.agents.oc = opencodeAgent();
    h.config(c);
    const s = h.scenario({ models: listed ? ['fake/other', 'fake/model'] : ['fake/other'], last_message: 'OK' });
    const r = output(await h.bridge(['check', '--agent', 'oc'], { env: s.env }));
    assert.equal(r.ok, true);
    assert.equal(r.agents.oc.ok, listed);
    assert.equal(r.agents.oc.model_listed, listed);
    assert.equal(r.agents.oc.version, 'synthetic-opencode-1.0');
    const calls = s.calls().filter((c) => c.tool === 'opencode');
    assert.deepEqual(calls.slice(0, 2).map((c) => c.args), [['--version'], ['models']]);
    if (listed) {
      assert.equal(r.agents.oc.reply, 'OK');
      assert.equal(calls[2].stdin, 'Reply with the single word OK.');
    }
    else {
      assert.equal(r.agents.oc.fix, M.fixOpencodeModel('oc', 'fake/model'));
      assert.equal(calls.length, 2);
    }
  });
}

test('check 不调模型地探测 Codex 沙箱：坏了判不通过并给出修法，Windows 上顺带试 unelevated', async (t) => {
  const h = sandbox(t), c = baseConfig();
  c.agents.codex.sandbox = { run: 'workspace-write', review: null, discuss: 'danger-full-access' };
  h.config(c);
  const broken = h.scenario({ sandbox_broken: true, unelevated_ok: true });
  const r = output(await h.bridge(['check'], { env: broken.env }), 1), codex = r.agents.codex;
  const win = process.platform === 'win32';
  assert.equal(codex.ok, false);
  // 执行用 workspace-write，审查没写、按只读探测，讨论是 danger-full-access 不探测
  assert.deepEqual(codex.sandbox.checked.map((x) => [x.mode, x.used_in, x.ok]), [['workspace-write', ['run'], false], ['read-only', ['review'], false]]);
  assert.equal(codex.sandbox.unelevated_ok, win ? true : null);
  const error = 'windows sandbox failed: helper_unknown_error: setup refresh had errors';
  assert.equal(codex.fix, M.fixCodexSandbox('codex', error, M.list([M.modeNames.run, M.modeNames.review]), win ? true : null));
  assert.ok(!broken.calls().some((x) => x.operation === 'exec'));
  if (win) assert.ok(broken.calls().some((x) => x.operation === 'sandbox' && x.args.includes('windows.sandbox="unelevated"')));
  const fine = output(await h.bridge(['check'], { env: h.scenario({}).env }));
  assert.equal(fine.agents.codex.ok, true);
  assert.ok(fine.agents.codex.sandbox.checked.every((x) => x.ok === true));
  // Codex 自己配了 danger-full-access、foreman 没另配时，不进沙箱，不用探测
  c.agents.codex.sandbox = { run: null, review: null, discuss: null }; h.config(c);
  fs.mkdirSync(path.join(h.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(h.home, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n\n[windows]\nsandbox = "elevated"\n');
  const skipped = h.scenario({ sandbox_broken: true });
  const probes = () => skipped.calls().filter((x) => x.operation === 'sandbox').length, before = probes(); // 调用记录按沙箱累计
  const r2 = output(await h.bridge(['check'], { env: skipped.env }));
  assert.equal(r2.agents.codex.sandbox, undefined);
  assert.equal(probes(), before);
});
