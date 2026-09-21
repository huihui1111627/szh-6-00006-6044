/* 冒烟测试：在 Node 中加载推演引擎（不含渲染层），验证核心逻辑 */
global.window = {};
require('../js/core.js');
require('../js/terrain.js');
require('../js/fire.js');
require('../js/units.js');
require('../js/simulation.js');
require('../js/strategies.js');
const FS = global.window.FS;

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
}

// 1. 基础推演：火势蔓延且持续
const sim = new FS.Sim(20260922);
for (let i = 0; i < 120; i++) sim.step();
check('火势蔓延', sim.burnedCount() > 50, `120 tick 过火 ${sim.burnedCount()} 格`);
check('燃烧点存在', sim.burning.length > 0, `${sim.burning.length} 个燃烧点`);

// 2. 风向突变事件
const windBefore = { ...sim.wind };
for (let i = 0; i < 40; i++) sim.step();
check('风向突变事件触发', sim.wind.dir !== windBefore.dir, `t=160 风向 ${sim.wind.dir}°`);

// 3. 指令与机动
const u1 = sim.unit('U1');
const d0 = Math.hypot(u1.x - 40, u1.y - 32);
sim.issueOrder('U1', { kind: 'move', x: 40, y: 32 });
for (let i = 0; i < 80; i++) sim.step();
const d1 = Math.hypot(u1.x - 40, u1.y - 32);
check('地面队伍机动', d1 < d0, `距离 ${d0.toFixed(1)} → ${d1.toFixed(1)}`);

// 4. 隔离带规划与开设（新起推演，抢在火线到达前）
const simFb = new FS.Sim(20260922);
const ok = FS.planFirebreak(simFb, 'U3', 30, 4, 30, 16);
check('隔离带规划', ok);
for (let i = 0; i < 120; i++) simFb.step();
const built = simFb.terrain.firebreak.filter((v) => v === 2).length;
check('隔离带开设', built >= 10, `建成 ${built} 格`);

// 5. 道路封控与失效
sim.closeRoad(1);
check('道路封闭生效', sim.terrain.roadClosed[1] === true);
for (let i = 0; i < 60; i++) sim.step();
check('道路失效事件触发', Object.keys(sim.terrain.roadFailed).length > 0,
  `失效道路: ${Object.keys(sim.terrain.roadFailed).join(',')}`);

// 6. 告警机制：撤离（火线逼近）与重新确认（路线经过封闭道路）
const simA = new FS.Sim(20260922);
simA.issueOrder('U1', { kind: 'move', x: 60, y: 32 });   // 沿 R1 长途机动
for (let i = 0; i < 10; i++) simA.step();
simA.closeRoad(1);                                       // 封闭其途经道路
simA.step();
check('重新确认告警出现', simA.alerts.some((a) => a.level === 'confirm'),
  simA.alerts.map((a) => a.text).join(' / ') || '无告警');
const simE = new FS.Sim(20260922);
simE.issueOrder('U3', { kind: 'suppress', x: 20, y: 18 }); // 派往火场
let sawEvac = false;
for (let i = 0; i < 400 && !sawEvac; i++) {
  simE.step();
  if (simE.alerts.some((a) => a.level === 'evacuate')) sawEvac = true;
}
check('撤离告警出现', sawEvac);

// 7. 通信中断 → 现场状态偏离 → 恢复核对
const sim2 = new FS.Sim(20260922);
for (let i = 0; i < 100; i++) sim2.step();
sim2.issueOrder('U1', { kind: 'move', x: 40, y: 32 });   // 中断前下达，中断期间继续执行
sim2.setComms(true);
sim2.issueOrder('U2', { kind: 'move', x: 20, y: 32 });   // 应被暂存
check('中断期间指令暂存', sim2.outbox.length === 1);
for (let i = 0; i < 40; i++) sim2.step();
sim2.setComms(false);
check('恢复后待核对', sim2.pendingReconcile === true);
const diffs = sim2.discrepancies();
check('状态差异可检测', diffs.some((d) => d.diff),
  `差异项 ${diffs.filter((d) => d.diff).length}/${diffs.length}`);
sim2.reconcile(true);
check('核对后暂存指令下达', sim2.outbox.length === 0 && !sim2.pendingReconcile);

// 8. 三策略并行回放（相同起火条件，确定性）
const results = [];
for (const strat of FS.strategies) {
  const s = new FS.Sim(20260922);
  s.autoReconcile = true;
  s.script = strat.script;
  for (let i = 0; i < 600; i++) s.step();
  results.push({ id: strat.id, burned: s.burnedCount(), lost: s.metrics.targetsLost, evac: s.metrics.evacEvents });
}
console.log('策略对比:', JSON.stringify(results));
check('策略结果有区分度', new Set(results.map((r) => r.burned)).size > 1);
check('阻截策略优于无干预基线', results[0].burned < 1302 || results[1].burned < 1302,
  `基线 1302, A=${results[0].burned} B=${results[1].burned}`);

// 9. 确定性：同种子两次运行结果一致
const a = new FS.Sim(20260922), b = new FS.Sim(20260922);
for (let i = 0; i < 300; i++) { a.step(); b.step(); }
check('推演确定性', a.burnedCount() === b.burnedCount());

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
