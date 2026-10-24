import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Claude Code 产出框的显隐（04-life.js 的 ccLife）：只加载这一个文件，车道和时钟用最小的替身
const source = fs.readFileSync(new URL('../board/web/04-life.js', import.meta.url), 'utf8');
function life(events) {
  const cc = { id: 'cc', events, runs: [{ id: 'cc', kind: 'host', started_at: 0 }] };
  const context = vm.createContext({
    B: { clock: { mode: 'live', speed: 1 }, life: [], runs: new Map(), laneById: new Map([['cc', cc]]) },
    latest: (lane) => lane.runs[0], laneActive: () => false, seatLanes: () => [], performance: { now: () => 0 },
  });
  vm.runInContext(`${source}\nglobalThis.ccLife = ccLife;`, context);
  return context.ccLife;
}
const minute = 60000;

test('Claude Code 的产出框在这一轮安静 3 分钟后就地收起，下一轮有输出时再出现', () => {
  const ccLife = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'done' }]);
  assert.equal(ccLife(2000 + 2 * minute).phase, 'show');
  // 最后一次动静在 2000：3 分钟后开始收起，就地散开（kind quiet，不往上飞）
  const collapsing = ccLife(2000 + 3 * minute + 500);
  assert.equal(collapsing.phase, 'collapse'); assert.equal(collapsing.kind, 'quiet');
  assert.equal(ccLife(2000 + 3 * minute + 5000).phase, 'none');
  // 已经收起的一段，下一条消息来时不再播一遍收起；新的一轮有输出时框回来
  const next = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'done' }, { ts: 2000 + 10 * minute, k: 'prompt' }, { ts: 2000 + 10 * minute + 1000, k: 'msg', t: 'again' }]);
  assert.equal(next(2000 + 10 * minute + 100).phase, 'none');
  assert.equal(next(2000 + 10 * minute + 3000).phase, 'show');
});

test('还在说话的一轮不收起；没到 3 分钟就来了下一条消息时照旧往上飞走', () => {
  const busy = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'a' }, { ts: 2000 + 2.5 * minute, k: 'cmd', t: 'ls' }]);
  assert.equal(busy(2000 + 4 * minute).phase, 'show');
  const handed = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'a' }, { ts: 2000 + minute, k: 'prompt' }]);
  const collapse = handed(2000 + minute + 500);
  assert.equal(collapse.phase, 'collapse'); assert.equal(collapse.kind, 'prompt');
});
