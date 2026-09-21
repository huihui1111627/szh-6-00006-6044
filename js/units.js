/* units.js — 地面队伍与直升机：机动、扑打、开设隔离带、吊桶灭火 */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  FS.makeUnits = function () {
    const mk = (o) => Object.assign({
      path: null, pathI: 0, task: null, alert: null, reasons: [],
      dismissed: false, buildProg: 0, cool: 0, hstate: null,
      reported: null, _prevAlert: null,
    }, o);
    return [
      mk({ id: 'U1', name: '消防一队', type: 'ground', x: 4,  y: 32 }),
      mk({ id: 'U2', name: '消防二队', type: 'ground', x: 9,  y: 32 }),
      mk({ id: 'U3', name: '消防三队', type: 'ground', x: 30, y: 8 }),
      mk({ id: 'H1', name: '直-8直升机', type: 'heli', x: 45, y: 30 }),
    ];
  };

  // 沿路径前进，返回是否走完
  function advance(sim, u) {
    if (!u.path || u.pathI >= u.path.length) { u.path = null; return true; }
    const wp = u.path[u.pathI];
    const cur = sim.idx(Math.round(u.x), Math.round(u.y));
    const sp = sim.terrain.road[cur] ? 1.2 : 0.5;
    const dx = wp.x - u.x, dy = wp.y - u.y, d = Math.hypot(dx, dy);
    if (d <= sp) { u.x = wp.x; u.y = wp.y; u.pathI++; }
    else { u.x += (dx / d) * sp; u.y += (dy / d) * sp; }
    if (u.pathI >= u.path.length) { u.path = null; return true; }
    return false;
  }

  function flyTo(u, tx, ty, sp) {
    const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
    if (d <= sp) { u.x = tx; u.y = ty; return true; }
    u.x += (dx / d) * sp; u.y += (dy / d) * sp;
    return false;
  }

  function nearestWater(sim, x, y) {
    let best = null, bd = Infinity;
    for (const c of sim.terrain.waterCells) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  function dropWater(sim, cx, cy) {
    const t = sim.terrain;
    let n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= t.W || y >= t.H) continue;
      const i = y * t.W + x;
      if (t.state[i] === 1) { t.state[i] = 2; n++; }
    }
    sim.metrics.suppressed += n;
  }

  function stepHeli(sim, u) {
    const task = u.task;
    if (!task || task.kind !== 'patrol') return;
    const SP = 2.6;
    if (!u.hstate) u.hstate = 'toFire';
    if (u.hstate === 'toFire') {
      if (flyTo(u, task.fx, task.fy, SP)) {
        dropWater(sim, Math.round(task.fx), Math.round(task.fy));
        // 重新锁定最近火头（火势绕行后跟随）
        const nb = FS.nearestBurning(sim, task.fx, task.fy, 20) || FS.nearestBurning(sim, task.fx, task.fy, null);
        if (!nb) {
          u.task = null; u.hstate = null;
          sim.log(`${u.name}：火场已无明火，返航待命`);
          return;
        }
        task.fx = nb.x; task.fy = nb.y;
        u.hstate = 'toWater';
      }
    } else if (u.hstate === 'toWater') {
      const w = nearestWater(sim, u.x, u.y);
      if (w && flyTo(u, w.x, w.y, SP)) { u.hstate = 'load'; u.cool = 2; }
    } else if (u.hstate === 'load') {
      if (--u.cool <= 0) u.hstate = 'toFire';
    }
  }

  function stepGround(sim, u) {
    const task = u.task;
    if (!task) return;
    if (task.kind === 'move' || task.kind === 'evacuate') {
      if (advance(sim, u)) {
        u.task = null;
        sim.log(task.kind === 'evacuate' ? `${u.name} 已抵达安全集结点` : `${u.name} 已到达指定位置`);
      }
      return;
    }
    if (task.kind === 'suppress') {
      if (u.path) { advance(sim, u); return; }
      if (u.cool > 0) { u.cool--; return; }
      const cells = FS.burningWithin(sim, u.x, u.y, 3).slice(0, 4);
      if (cells.length) {
        for (const i of cells) sim.terrain.state[i] = 2;
        sim.metrics.suppressed += cells.length;
        u.cool = 2;
        return;
      }
      const near = FS.nearestBurning(sim, u.x, u.y, 8);
      if (near) sim.planPath(u, near.x, near.y);
      else if (Math.hypot(u.x - task.x, u.y - task.y) > 1.5) sim.planPath(u, task.x, task.y);
      return;
    }
    if (task.kind === 'firebreak') {
      const next = task.cells.find((c) => sim.terrain.firebreak[sim.idx(c.x, c.y)] === 1);
      if (!next) {
        u.task = null;
        sim.log(`${u.name} 完成隔离带开设（${task.cells.length} 格）`);
        return;
      }
      if (Math.hypot(u.x - next.x, u.y - next.y) > 1.2) {
        if (!u.path) sim.planPath(u, next.x, next.y);
        if (u.path) advance(sim, u);
      } else if (++u.buildProg >= 1) {
        sim.terrain.firebreak[sim.idx(next.x, next.y)] = 2;
        sim.markDirty();
        u.buildProg = 0;
      }
    }
  }

  FS.stepUnits = function (sim) {
    for (const u of sim.units) {
      if (u.type === 'heli') stepHeli(sim, u);
      else stepGround(sim, u);
    }
  };

  // 规划一条隔离带并指派队伍开设（火势到此会绕行）
  FS.planFirebreak = function (sim, unitId, x0, y0, x1, y1) {
    const t = sim.terrain;
    const cells = FS.bresenhamSafe(x0, y0, x1, y1, t.W, t.H).filter((c) => {
      const i = c.y * t.W + c.x;
      return !t.water[i] && !t.road[i] && t.state[i] === 0 && t.firebreak[i] === 0;
    });
    if (!cells.length) { sim.log('隔离带规划失败：所选区域不可开设'); return false; }
    for (const c of cells) t.firebreak[c.y * t.W + c.x] = 1;
    sim.markDirty();
    sim.issueOrder(unitId, { kind: 'firebreak', cells });
    return true;
  };

  FS.bresenhamSafe = function (x0, y0, x1, y1, W, H) {
    x0 = FS.clamp(x0, 0, W - 1); x1 = FS.clamp(x1, 0, W - 1);
    y0 = FS.clamp(y0, 0, H - 1); y1 = FS.clamp(y1, 0, H - 1);
    return FS.bresenham(x0, y0, x1, y1);
  };
})(window.FS);
