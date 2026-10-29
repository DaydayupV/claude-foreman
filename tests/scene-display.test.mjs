import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { sandbox, seedRun, write } from './helpers.mjs';
import { createFeed } from '../foreman/skills/dispatch/scripts/board/feed.mjs';
import { groupTask } from '../foreman/skills/dispatch/scripts/display.mjs';

const page = fs.readFileSync(new URL('../foreman/skills/dispatch/scripts/board/index.html', import.meta.url), 'utf8');
const shared = page.slice(page.indexOf('const Display ='), page.indexOf('// ---- 00-text.js'));
const sourceOf = (name) => page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))[0];

test('场景经 fplan 传到网页组标题和悬停，兼容旧计划与未启动席位', (t) => {
  const h = sandbox(t), now = Date.now();
  const why = '采用 <code> 规则';
  for (const [i, scene] of ['code', 'code', 'research', undefined].entries()) {
    const plan = `plan-${i}`;
    write(path.join(h.runs, 'plans', `${plan}.json`), { plan_id: plan, module: 'review', cell: 'complex', group: 'scenes',
      created_at: new Date(now - 1000).toISOString(), scene, scene_why: scene && why, seats: [{ seat: 1 }], required: [] });
    seedRun(h, `20000101-00000${i}-scene`, { module: 'review', kind: 'review', mode: 'review', level: 'complex', plan, seat: 1, group: 'scenes' });
  }
  const data = createFeed(h.runs).read({ session: 'test-session' }, now);
  let plans = data.events.filter((e) => e.k === 'fplan');
  assert.equal(plans.length, 4);
  assert.deepEqual(plans.filter((p) => p.scene).map((p) => p.scene).sort(), ['code', 'code', 'research']);
  assert.ok(plans.filter((p) => p.scene).every((p) => p.scene_why === why));
  new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(page)[1]);
  const element = () => ({ children: [], classList: { toggle() {} },
    replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); }, remove() {},
    insertBefore(node, before) {
      const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1);
      this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    } });
  const nodes = new Map(), col = { ...element(), seats: new Map(), querySelector(sel) {
    if (!nodes.has(sel)) nodes.set(sel, element());
    return nodes.get(sel);
  } };
  let runs;
  const context = vm.createContext({
    plansAt: () => plans.map((ev) => ({ id: ev.plan, module: ev.module, ev })),
    currentRun: (lane) => data.runs.find((r) => r.id === lane.id), roundOf: () => 1, laneStatus: () => ({ running: false }),
    groupSeats: () => ({ history: [], blocks: runs.map((r) => ({ id: r.id, host: r })), all: runs, plans,
      numbers: { runs: new Map() }, queue: [], states: [] }),
    setText: (el, text) => { el.textContent = text; }, seatShell: element, fillHostSeat() {}, loneGroup: () => false, document: { createElement: element }, B: { laneById: new Map() },
  });
  vm.runInContext(shared + sourceOf('groupHead') + '\n' + sourceOf('fillGroup') + '\nglobalThis.api = { Display, groupHead, fillGroup };', context);
  const web = context.api;
  runs = data.runs.map((r) => web.Display.displayRun(r));
  const head = web.groupHead(data.runs, now);
  assert.equal(head.title, groupTask(runs, plans).text);
  assert.match(head.title, /complex · (code, research|research, code)$/);
  assert.ok(head.sceneWhy.includes(`code: ${why}`) && head.sceneWhy.includes(`research: ${why}`));
  web.fillGroup(col, {}, now);
  assert.equal(col.querySelector('header b').textContent, head.title);
  assert.equal(col.querySelector('header b').title, head.sceneWhy);
  const ghosts = plans.map((p) => ({ ghost: true, plan: p.plan }));
  const pending = web.groupHead(ghosts, now);
  assert.match(pending.title, /review · planned · complex · (code, research|research, code)$/);
  assert.equal(pending.sceneWhy, head.sceneWhy);
  plans = plans.filter((p) => !p.scene);
  runs = runs.filter((r) => r.meta.plan === plans[0].plan);
  web.fillGroup(col, {}, now);
  assert.equal(col.querySelector('header b').textContent, groupTask(runs).text);
  assert.equal(col.querySelector('header b').title, '');
  assert.equal(web.groupHead(ghosts.filter((g) => g.plan === plans[0].plan), now).title, 'review · planned · complex');
});

test('组里无带场景计划时，终端和网页从任务 meta 取场景及理由，并优先使用计划', (t) => {
  const h = sandbox(t), why = '直派规则';
  seedRun(h, '20000101-000000-scene', { scene: 'code', scene_why: why, group: 'direct-scenes' });
  const data = createFeed(h.runs).read({ session: 'test-session' }, Date.now());
  assert.equal(data.runs[0].scene, 'code'); assert.equal(data.runs[0].scene_why, why);
  const context = vm.createContext(); vm.runInContext(shared + '\nglobalThis.Display = Display;', context);
  const runs = data.runs.map((r) => context.Display.displayRun(r));
  for (const plans of [[], [{ scene: null }], [{ scene: 'research', scene_why: '计划规则' }]]) {
    const terminal = groupTask(runs, plans), web = context.Display.groupTask(runs, plans);
    assert.equal(web.text, terminal.text); assert.equal(web.sceneWhy, terminal.sceneWhy);
    assert.ok(terminal.text.endsWith(plans.some((p) => p.scene) ? 'research' : 'code'));
  }
  assert.equal(groupTask(runs).sceneWhy, `code: ${why}`);
  const displaySource = fs.readFileSync(new URL('../foreman/skills/dispatch/scripts/display.mjs', import.meta.url), 'utf8');
  assert.equal(sourceOf('groupTask'), displaySource.match(/function groupTask\([\s\S]*?\n\}/)[0]);
});
