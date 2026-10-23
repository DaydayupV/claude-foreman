import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, json, write, baseConfig, poll, ROOT, BRIDGE, MESSAGES } from './helpers.mjs';
import { buildId } from '../foreman/skills/dispatch/scripts/board/build-id.mjs';

for (const lang of ['zh', 'en']) {
  test(`board 默认关闭时解释开启方法且不产生锁文件 (${lang})`, async (t) => {
    const h = sandbox(t), options = { env: { FOREMAN_LANG: lang } };
    assert.deepEqual(output(await h.bridge(['board'], options)), { enabled: false, message: MESSAGES[lang].boardOff });
    assert.equal(fs.existsSync(path.join(h.runs, 'board.lock.json')), false);
    assert.equal(h.calls().length, 0);
  });

  test(`board 帮助文字和总用法包含看板入口 (${lang})`, async (t) => {
    const h = sandbox(t, { config: false }), options = { env: { FOREMAN_LANG: lang } };
    const help = await h.bridge(['board', '--help'], options);
    assert.equal(help.code, 0, help.stderr);
    assert.equal(help.stdout, MESSAGES[lang].help.board + '\n');
    const usage = await h.bridge(['--help'], options);
    assert.equal(usage.code, 0, usage.stderr);
    assert.equal(usage.stdout, MESSAGES[lang].usage + '\n');
    assert.ok(usage.stdout.includes('|board|'));
    assert.equal(fs.existsSync(h.userConfig), false);
    assert.equal(fs.existsSync(path.join(h.runs, 'board.lock.json')), false);
  });
}

test('board 后台启动后可复用，支持当前对话与显式对话，并拒绝非法参数', async (t) => {
  const h = sandbox(t), c = baseConfig(), lockFile = path.join(h.runs, 'board.lock.json');
  c.dispatch.web = true;
  h.config(c);
  const noSession = { env: { CLAUDE_CODE_SESSION_ID: '' } };
  try {
    failed(await h.bridge(['board', '--session', '../bad']), MESSAGES.zh.badArg('--session ../bad'));
    assert.equal(fs.existsSync(lockFile), false);
    const first = output(await h.bridge(['board'], noSession));
    assert.equal(first.enabled, true);
    assert.equal(first.started, true);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/\?level=all&lang=zh$/);
    const lock = json(lockFile);
    assert.equal(lock.v, 1);
    assert.equal(lock.build, buildId(path.join(ROOT, 'foreman/skills/dispatch/scripts/board')));
    if (process.platform !== 'win32') assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
    const health = await fetch(new URL('health', first.url));
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, v: 1, pid: lock.pid, build: lock.build });
    assert.equal((await fetch(first.url)).status, 200);
    const second = output(await h.bridge(['board'], noSession));
    assert.deepEqual(second, { enabled: true, url: first.url, started: false });
    const current = output(await h.bridge(['board'], { env: { CLAUDE_CODE_SESSION_ID: 'current-session_1.x' } }));
    assert.deepEqual(current, { enabled: true, url: first.url + '&s=current-session_1.x', started: false });
    const picked = output(await h.bridge(['board', '--session', 'other-session_2.x']));
    assert.deepEqual(picked, { enabled: true, url: first.url + '&s=other-session_2.x', started: false });
    const encoded = output(await h.bridge(['board'], { env: { CLAUDE_CODE_SESSION_ID: 'session with/slash' } }));
    assert.equal(encoded.url, first.url + '&s=session%20with%2Fslash');
    const english = output(await h.bridge(['board'], { env: { FOREMAN_LANG: 'en', CLAUDE_CODE_SESSION_ID: '' } }));
    assert.deepEqual(english, { enabled: true, url: first.url.replace('&lang=zh', '&lang=en'), started: false });
    assert.deepEqual(json(lockFile), lock);
    for (const [lang, htmlLang] of [['en', 'en'], ['zh', 'zh-CN'], ['invalid', 'zh-CN']]) {
      const url = new URL(first.url);
      url.search = `?lang=${lang}`;
      const html = await (await fetch(url)).text();
      assert.ok(html.includes(`<html lang="${htmlLang}">`));
      assert.ok(html.includes(`window.__LANG__ = '${htmlLang === 'en' ? 'en' : 'zh'}';`));
    }
  } finally {
    if (fs.existsSync(lockFile)) {
      const lock = json(lockFile);
      process.kill(lock.pid);
      await poll(() => { try { process.kill(lock.pid, 0); return false; } catch { return true; } }, '看板服务退出');
      fs.rmSync(lockFile, { force: true });
    }
  }
});

test('macOS 内存是否够用只看总量，仍报告空闲内存', async (t) => {
  const h = sandbox(t);
  h.config({ dispatch: { web: true } });
  const script = write(path.join(h.home, 'darwin-check.mjs'), `
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.argv = [process.execPath, ${JSON.stringify(BRIDGE)}, 'check'];
    await import(${JSON.stringify(pathToFileURL(BRIDGE).href)});`);
  for (const [total, available, enough] of [[8, 0.5, true], [7.9, 4, false]]) {
    const result = output(await h.start(script, [], { env: { FOREMAN_TEST_MEMORY: `${total},${available}` } }).done);
    assert.deepEqual(result.memory, { total_gb: total, available_gb: available, enough, web: true });
    assert.equal(result.ok, true);
  }
});
