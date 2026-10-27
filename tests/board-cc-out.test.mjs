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
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

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

test('安静收起以后，后台任务交回、跑命令都不让框回来；空档之后有了回答才回来，只显示空档之后的', () => {
  const back = 2000 + 5 * minute;
  const ccLife = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'waiting' }, { ts: back, k: 'returned', t: 'completed' },
    { ts: back + 1000, k: 'cmd', t: 'cat out' }, { ts: back + 5000, k: 'msg', t: 'review is back' }]);
  assert.equal(ccLife(back + 500).phase, 'none');
  assert.equal(ccLife(back + 3000).phase, 'none');
  const shown = ccLife(back + 6000);
  assert.equal(shown.phase, 'show'); assert.equal(shown.from, 2000);
});

test('直播里产出的交接从页面拿到它的时刻算起：传过来花了零点几秒，交接不会被跳过', () => {
  const seat = (fields, events = []) => {
    const lane = { id: 'w', events, runs: [{ id: 'w', kind: 'exec', started_at: 0, ...fields }] };
    const context = vm.createContext({ B: { clock: { mode: 'live', speed: 1 }, life: [], runs: new Map(), laneById: new Map([['w', lane]]) },
      latest: (l) => l.runs[0], laneActive: () => false, seatLanes: () => [], performance: { now: () => 0 } });
    vm.runInContext(`${source}\nglobalThis.outLife = outLife;`, context);
    return (t) => context.outLife(lane, t);
  };
  // 任务 10000 结束，页面 10470 才知道：10500 时交接才过了 0.03 秒
  near(seat({ ended_at: 10000, ended_seen: 10470 })(10500).age, 0.03);
  near(seat({ ended_at: 10000 })(10500).age, 0.5);
  // 第一次改文件也一样；晚到 10 秒以上的（后台标签页）照记录时刻
  near(seat({}, [{ run: 'w', k: 'edit', ts: 5000, seen: 5400 }])(5500).age, 0.1);
  near(seat({ ended_at: 10000, ended_seen: 25000 })(25000).age, 15);
  // Claude Code 的产出框同理
  const ccLife = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'done', seen: 2450 }]);
  near(ccLife(2500).age, 0.05);
});

test('还在说话的一轮不收起；没到 3 分钟就来了下一条消息时照旧往上飞走', () => {
  const busy = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'a' }, { ts: 2000 + 2.5 * minute, k: 'cmd', t: 'ls' }]);
  assert.equal(busy(2000 + 4 * minute).phase, 'show');
  const handed = life([{ ts: 1000, k: 'prompt' }, { ts: 2000, k: 'msg', t: 'a' }, { ts: 2000 + minute, k: 'prompt' }]);
  const collapse = handed(2000 + minute + 500);
  assert.equal(collapse.phase, 'collapse'); assert.equal(collapse.kind, 'prompt');
});
