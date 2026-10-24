import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 刻度带上一组显示哪些席位（04-life.js 的 bandLanes）：只加载这一个文件，车道和时钟用最小的替身
const source = fs.readFileSync(new URL('../board/web/04-life.js', import.meta.url), 'utf8');
const minute = 60000;
function band(lanes, collects) {
  const cc = { id: 'cc', events: collects.map(([ts, target]) => ({ ts, k: 'collect', target })), runs: [] };
  const context = vm.createContext({
    B: { clock: { mode: 'live', speed: 1 }, life: [], runs: new Map(), laneById: new Map([['cc', cc]]) },
    latest: (lane) => lane.runs[lane.runs.length - 1], laneActive: () => false, seatLanes: () => [], performance: { now: () => 0 },
  });
  vm.runInContext(`${source}\nglobalThis.bandLanes = bandLanes;`, context);
  return (t) => context.bandLanes(lanes, t).map((l) => l.id);
}
const run = (id, started, ended) => ({ id, started_at: started, ended_at: ended });
const lane = (id, ...runs) => ({ id, runs, events: [] });

test('返工只续接了两席时，早就结束的第三席不跟着回到刻度带', () => {
  const back = 30 * minute;
  const lanes = [lane('parse', run('p1', 0, 4 * minute), run('p2', back, null)),
    lane('infer', run('i1', 0, 3 * minute)),
    lane('render', run('r1', 0, 5 * minute), run('r2', back + 5000, null))];
  const at = band(lanes, [[5 * minute + 1000, ['parse', 'infer', 'render']]]);
  // 第一批：先结束、结果也读走了的 infer 还跟着组留在带上
  assert.deepEqual(at(4 * minute + 30000), ['parse', 'infer', 'render']);
  assert.deepEqual(at(back + 10000), ['parse', 'render']);
});

test('上一批结果还没读走的席位照常显示；新一批里续接的席位在上一席还在跑时启动，也算同一批', () => {
  const lanes = [lane('a', run('a1', 0, 2 * minute), run('a2', 20 * minute, null)),
    lane('b', run('b1', 0, 3 * minute)),
    lane('c', run('c1', 0, 3 * minute), run('c2', 21 * minute, 22 * minute))];
  // b 的结果一直没被读走：结束 10 分钟以内还在
  const at = band(lanes, [[4 * minute, ['a', 'c']], [23 * minute, ['c']]]);
  assert.deepEqual(at(12 * minute), ['a', 'b', 'c']);
  assert.deepEqual(at(20 * minute + 1000), ['a']);
  assert.deepEqual(at(21 * minute + 1000), ['a', 'c']);
  // c2 在 a2 还在跑时启动又结束、结果读走：仍是这一批
  assert.deepEqual(at(25 * minute), ['a', 'c']);
});
