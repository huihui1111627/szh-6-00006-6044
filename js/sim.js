/* 推演引擎：火势、通行、任务、失效复核、通信中断与对账、指标 */
(function (global) {
  'use strict';
  const U = global.U;

  const DT = 1;                    // 每步 1 分钟
  const GROUND_DANGER = 3.2;      // 地面队距明火危险半径（格）
  const GROUND_CRIT = 1.4;
  const AIR_DANGER = 1.2;         // 航线贴着火点判定
  const TASK_RECHECK = 10;        // 任务复核周期（分钟）

  /* ---------- 道路寻路 ---------- */
  function shortestPath(scen, fromNode, toNode, closedSet) {
    const road = scen.road;
    if (!fromNode || !toNode) return null;
    const key = (e) => e.id;
    const pq = [[0, fromNode, null, null]];
    const done = new Map();
    let guard = 0;
    while (pq.length && guard++ < 2000) {
      pq.sort((a, b) => a[0] - b[0]);
      const [g, id, pe, pn] = pq.shift();
      if (done.has(id)) continue;
      done.set(id, { cost: g, edge: pe, prev: pn });
      if (id === toNode) break;
      (road.adj[id] || []).forEach(e => {
        if (closedSet && closedSet.has(key(e))) return;
        const nb = road.otherEnd(e, id);
        if (!done.has(nb)) pq.push([g + road.edgeLen(e), nb, e, id]);
      });
    }
    const end = done.get(toNode);
    if (!end) return null;
    const edges = [];
    let cur = toNode;
    while (cur !== fromNode) {
      const rec = done.get(cur);
      if (!rec || !rec.edge) return null;
      edges.unshift(rec.edge);
      cur = rec.prev;
    }
    return { edges, dist: end.cost };
  }

  // 路径（由若干道路边拼出的折线），pos 沿格坐标推进
  function buildPath(scen, edgeList) {
    const road = scen.road;
    // 直接从边的 cells 拼接，保持行进方向
    const segs = [];
    let total = 0;
    edgeList.forEach((e, i) => {
      const nFrom = i === 0 ? null : edgeList[i - 1];
      let cells = e.cells;
      if (i > 0) {
        const prev = nFrom;
        const startNode = (prev.a === e.a || prev.b === e.a) ? e.a : e.b;
        const na = road.nodes[startNode], nb = road.nodes[road.otherEnd(e, startNode)];
        if (cells.length && U.dist(cells[0][0], cells[0][1], na.x, na.y) >
            U.dist(cells[cells.length - 1][0], cells[cells.length - 1][1], na.x, na.y)) {
          cells = cells.slice().reverse();
        }
      }
      // 去掉与上一段重合的首点
      cells.forEach((c, j) => {
        if (segs.length && j === 0 && segs[segs.length - 1][0] === c[0] && segs[segs.length - 1][1] === c[1]) return;
        segs.push(c);
      });
    });
    for (let i = 1; i < segs.length; i++) total += U.dist(segs[i - 1][0], segs[i - 1][1], segs[i][0], segs[i][1]);
    return { pts: segs, total, traveled: 0 };
  }

  function nearestSafeNode(scen, x, y, closedSet, fireCells) {
    let best = null, bestD = Infinity;
    Object.values(scen.road.nodes).forEach(n => {
      const d = U.dist(x, y, n.x, n.y);
      let safe = true;
      fireCells.forEach(fx => {
        if (U.dist(n.x, n.y, fx.x, fx.y) < 6) safe = false;
      });
      if (safe && d < bestD) { bestD = d; best = n; }
    });
    return best;
  }

  /* ---------- 模拟状态 ---------- */
  function createSim(scen, name, tag) {
    const sim = {
      id: 'S' + Math.random().toString(36).slice(2, 8),
      name: name || '主策略',
      tag: tag || '基线',
      t: 0,
      scen,
      // 火情：ign = 点燃时刻(分钟)，burn = 已烧时长，wet = 湿度（0-1）
      ign: new Float32Array(scen.W * scen.H).fill(-1),
      burn: new Float32Array(scen.W * scen.H),
      wet: new Float32Array(scen.W * scen.H),
      breaks: [],            // {id, pts:[ [x,y]... ], done, progress, closed}
      breakCells: new Uint8Array(scen.W * scen.H),
      closedEdges: new Set(),
      teams: scen.teams.map(t => ({
        id: t.id, name: t.name, kind: t.kind, role: t.role, work: t.work,
        x: t.x, y: t.y, node: t.node || null, homeNode: t.node || null,
        speed: t.speed, power: t.power, personnel: t.personnel || null,
        aircraft: t.aircraft || null,
        task: null, alarm: 0, evacuating: false,
        plannedNode: t.node || null, plannedTask: null, drift: null
      })),
      targets: scen.targets.map(tt => ({
        id: tt.id, name: tt.name, x: tt.x, y: tt.y, radius: tt.radius,
        value: tt.value, node: tt.node, risk: 0, lost: false, riskPeak: 0,
        plannedRisk: 0
      })),
      log: [],
      alerts: [],
      metrics: { burned: 0, burnedPeak: 0, lostValue: 0, evacAlarms: 0,
                rechecks: 0, drops: 0, breakBuilt: 0, activeCells: 0 },
      wind: { dir: scen.wind.dir, speed: scen.wind.speed },
      firedWindEvents: new Set(),
      rng: new U.RngStream(scen.seed ^ 0x51f1a),
      taskSeq: 0, breakSeq: 0,
      // 通信
      comm: { down: false, since: -1, queued: [], lastReport: null, recon: null }
    };
    const ig = scen.ignition;
    sim.ign[ig.y * scen.W + ig.x] = 0;
    return sim;
  }

  const idx = (sim, x, y) => y * sim.scen.W + x;
  const inMap = (scen, x, y) => x >= 1 && y >= 1 && x < scen.W - 1 && y < scen.H - 1;

  function isBurning(sim, i) {
    const ign = sim.ign[i];
    if (ign < 0) return false;
    return sim.t - ign < burnLifeAdj(sim, i);
  }
  function isBurned(sim, i) {
    const ign = sim.ign[i];
    if (ign < 0) return false;
    return sim.t - ign >= burnLifeAdj(sim, i);
  }
  function burnLife(sim, i) {
    const f = sim.scen.fuel[i];
    return 8 + f * 18;
  }
  function activeFireCells(sim) {
    const out = [];
    for (let y = 0; y < sim.scen.H; y++) {
      for (let x = 0; x < sim.scen.W; x++) {
        const i = y * sim.scen.W + x;
        if (isBurning(sim, i)) out.push({ x, y });
      }
    }
    return out;
  }


  /* ---------- 火势 ---------- */
  const NB = [[1,0],[-1,0],[0,1],[0,-1]];

  function spreadProb(sim, cx, cy, nx, ny) {
    const scen = sim.scen;
    const i2 = ny * scen.W + nx;
    if (sim.ign[i2] >= 0) return 0;
    if (scen.water[i2] || sim.breakCells[i2]) return 0;
    const f = scen.fuel[i2];
    if (f < 0.06) return 0;
    const i1 = cy * scen.W + cx;
    // 坡度：上坡加速
    const dz = scen.elev[i2] - scen.elev[i1];
    let p = 0.04 + f * 0.08;
    p *= 1 + U.clamp(dz * 1.4, -0.5, 0.85);
    // 风：沿传播方向的投影
    const wdir = sim.wind.dir * U.D2R;
    const wvx = Math.sin(wdir), wvy = Math.cos(wdir);
    let dx = nx - cx, dy = ny - cy;
    const dl = Math.hypot(dx, dy); dx /= dl; dy /= dl;
    const proj = dx * wvx + dy * wvy;
    const wf = sim.wind.speed / 10;
    p *= 1 + proj * wf * 1.2;
    // 湿度抑制引燃
    p *= 1 - sim.wet[i2] * 0.9;
    // 道路裸地：穿过但慢
    if (scen.road.cellEdge.has(nx + ',' + ny)) p *= 0.65;
    return U.clamp(p, 0, 0.9);
  }

  function spreadStep(sim) {
    const scen = sim.scen;
    const light = [];
    for (let y = 1; y < scen.H - 1; y++) {
      for (let x = 1; x < scen.W - 1; x++) {
        const i = y * scen.W + x;
        if (!isBurning(sim, i)) continue;
        for (const [ddx, ddy] of NB) {
          const nx = x + ddx, ny = y + ddy;
          if (sim.ign[ny * scen.W + nx] >= 0) continue;
          const p = spreadProb(sim, x, y, nx, ny);
          if (p > 0 && sim.rng.next() < p) light.push(nx + scen.W * ny);
        }
      }
    }
    light.forEach(i => { if (sim.ign[i] < 0) sim.ign[i] = sim.t + DT; });
  }

  function updateBurn(sim) {
    const scen = sim.scen;
    let active = 0, burned = 0;
    for (let i = 0; i < scen.W * scen.H; i++) {
      if (sim.wet[i] > 0) sim.wet[i] = Math.max(0, sim.wet[i] - 0.012 * DT);
      if (sim.ign[i] < 0) continue;
      if (isBurning(sim, i)) {
        active++;
        // 扑打消耗燃烧寿命
        sim.burn[i] += 0; // 占位，寿命由 ign 直接推算
      } else {
        burned++;
      }
    }
    sim.metrics.activeCells = active;
    sim.metrics.burned = burned;
  }

  // 地面队在火点作业：缩短燃烧寿命（通过记录 suppress 累计）
  // 用 wet 无法表达寿命，故用独立数组 suppressBonus
  function ensureSuppress(sim) {
    if (!sim.suppress) sim.suppress = new Float32Array(sim.scen.W * sim.scen.H);
  }

  function suppressionStep(sim) {
    ensureSuppress(sim);
    const scen = sim.scen;
    sim.teams.forEach(tm => {
      if (tm.kind !== 'ground' || !tm.task || tm.task.type !== 'defend') return;
      const t = tm.task;
      if (t.state !== 'working') return;
      const radius = 3.1;
      for (let y = Math.max(0, Math.floor(tm.y - radius)); y <= Math.min(scen.H - 1, tm.y + radius); y++) {
        for (let x = Math.max(0, Math.floor(tm.x - radius)); x <= Math.min(scen.W - 1, tm.x + radius); x++) {
          if (U.dist(x, y, tm.x, tm.y) > radius) continue;
          const i = y * scen.W + x;
          if (isBurning(sim, i)) sim.suppress[i] += tm.power * 0.55 * DT;
          else if (sim.ign[i] < 0) sim.wet[i] = Math.min(1, sim.wet[i] + 0.05 * tm.power * DT);
        }
      }
    });
    // suppress 累计等效为“提前熄灭”：修正 isBurning 判定由 burnLifeAdj 使用
  }

  function burnLifeAdj(sim, i) {
    return Math.max(1.2, burnLife(sim, i) - (sim.suppress ? sim.suppress[i] : 0));
  }

  /* ---------- 任务 ---------- */
  function edgeBlocked(sim, e) {
    if (sim.closedEdges.has(e.id)) return true;
    let burnN = 0;
    for (const [x, y] of e.cells) {
      const i = idx(sim, x, y);
      if (isBurning(sim, i)) burnN++;
    }
    return burnN >= 3;
  }

  // 地面：从当前所在道路节点到目标节点（若不在节点上，取最近节点）
  function nearestNode(scen, x, y) {
    let best = null, bd = Infinity;
    Object.values(scen.road.nodes).forEach(n => {
      const d = U.dist(x, y, n.x, n.y);
      if (d < bd) { bd = d; best = n; }
    });
    return best && bd < 6 ? best : null;
  }

  function groundRoute(sim, fromNodeId, toNodeId) {
    const r = shortestPath(sim.scen, fromNodeId, toNodeId, sim.closedEdges);
    if (!r) return null;
    // 路径边不得穿越当前明火段
    for (const e of r.edges) { if (edgeBlocked(sim, e)) return null; }
    return r;
  }

  function assignMove(sim, teamId, targetNodeId, opts) {
    opts = opts || {};
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm) return { ok: false, msg: '没有该队伍' };
    const scen = sim.scen;
    if (tm.kind === 'air') {
      const to = scen.road.nodes[targetNodeId];
      const d = U.dist(tm.x, tm.y, to.x, to.y);
      tm.task = {
        id: ++sim.taskSeq, kind: 'move', type: 'airMove',
        targetNode: targetNodeId, state: 'moving',
        fromX: tm.x, fromY: tm.y, toX: to.x, toY: to.y,
        dist: d, traveled: 0, phase: 'out', recheckAt: sim.t + TASK_RECHECK,
        detail: opts.detail || ('机动至 ' + to.name)
      };
      return { ok: true };
    }
    const from = tm.node || (nearestNode(scen, tm.x, tm.y) || {}).id;
    if (!from) return { ok: false, msg: '队伍不在可通行道路上' };
    const r = groundRoute(sim, from, targetNodeId);
    if (!r) {
      return { ok: false, msg: '通往 ' + scen.road.nodes[targetNodeId].name + ' 的道路已封闭或被火切断' };
    }
    const path = buildPath(scen, r.edges);
    tm.task = {
      id: ++sim.taskSeq, kind: 'move', type: 'groundMove',
      targetNode: targetNodeId, state: 'moving',
      edges: r.edges.map(e => e.id), path, seg: 0,
      recheckAt: sim.t + TASK_RECHECK,
      detail: opts.detail || ('沿道路机动至 ' + scen.road.nodes[targetNodeId].name)
    };
    return { ok: true };
  }

  // 工程队开隔离带：先机动到起点节点，再离路作业
  function assignBreak(sim, teamId, brk, startNodeId) {
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm || tm.work !== 'build') return { ok: false, msg: '仅工程队可开设隔离带' };
    const from = tm.node || (nearestNode(sim.scen, tm.x, tm.y) || {}).id;
    if (!from) return { ok: false, msg: '工程队当前不在道路上' };
    const r = groundRoute(sim, from, startNodeId);
    if (!r) return { ok: false, msg: '进场道路不可通行，无法开设隔离带' };
    tm.task = {
      id: ++sim.taskSeq, kind: 'build', type: 'break',
      breakId: brk.id, state: 'moving',
      edges: r.edges.map(e => e.id), path: buildPath(sim.scen, r.edges), seg: 0,
      entryNode: startNodeId, recheckAt: sim.t + TASK_RECHECK,
      detail: '机动后开设隔离带（' + brk.pts.length + ' 格）'
    };
    return { ok: true };
  }

  // 守点
  function assignDefend(sim, teamId, targetId) {
    const tm = sim.teams.find(t => t.id === teamId);
    const tgt = sim.targets.find(t => t.id === targetId);
    if (!tm || !tgt) return { ok: false, msg: '目标无效' };
    const res = assignMove(sim, teamId, tgt.node, { detail: '前往防护 ' + tgt.name });
    if (!res.ok) return res;
    tm.task.kind = 'defend';
    tm.task.type = tm.kind === 'air' ? 'airDefend' : 'groundDefend';
    tm.task.targetId = targetId;
    tm.task.state = 'moving';
    if (tm.kind === 'ground') tm.task.detail = '机动至 ' + tgt.name + ' 组织防护';
    else tm.task.detail = '空中巡护 ' + tgt.name;
    return { ok: true };
  }

  // 直升机吊桶：水源-火线往返若干架次
  function assignDrop(sim, teamId, tx, ty, wpNodeId) {
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm || tm.kind !== 'air') return { ok: false, msg: '仅直升机可吊桶灭火' };
    const wp = sim.scen.road.nodes[wpNodeId];
    tm.task = {
      id: ++sim.taskSeq, kind: 'drop', type: 'drop',
      state: 'moving', phase: 'toFire', recheckAt: sim.t + TASK_RECHECK,
      load: 0, cycles: 0, maxCycles: 6,
      homeX: tm.x, homeY: tm.y,
      wpX: wp.x, wpY: wp.y, wpNode: wpNodeId,
      fireX: tx, fireY: ty,
      legFromX: tm.x, legFromY: tm.y, legToX: tx, legToY: ty,
      legDist: U.dist(tm.x, tm.y, tx, ty), legTraveled: 0,
      detail: '吊桶压制 (' + Math.round(tx) + ',' + Math.round(ty) + ')'
    };
    return { ok: true };
  }

  // 撤离：地面去最近安全节点，直升机回最近停机坪
  function assignEvac(sim, teamId) {
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm) return { ok: false, msg: '没有该队伍' };
    tm.evacuating = true;
    if (tm.kind === 'air') {
      const pads = ['westHeli', 'eastHeli'].map(id => sim.scen.road.nodes[id]);
      const pad = pads.reduce((a, b) =>
        U.dist(tm.x, tm.y, a.x, a.y) < U.dist(tm.x, tm.y, b.x, b.y) ? a : b);
      return assignMove(sim, teamId, pad.id, { detail: '返航撤离至 ' + pad.name });
    }
    const fire = activeFireCells(sim);
    let best = null, bd = Infinity;
    Object.values(sim.scen.road.nodes).forEach(n => {
      const onFire = fire.some(f => U.dist(n.x, n.y, f.x, f.y) < 5);
      if (onFire) return;
      const d = U.dist(tm.x, tm.y, n.x, n.y);
      if (d < bd) { bd = d; best = n; }
    });
    if (!best) return { ok: false, msg: '周边道路节点均不安全' };
    const res = assignMove(sim, teamId, best.id, { detail: '紧急撤离至 ' + best.name });
    if (res.ok) { tm.task.kind = 'evac'; tm.task.evac = true; }
    return res;
  }

  function cancelTask(sim, teamId) {
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm || !tm.task) return { ok: false, msg: '该队伍无在执行任务' };
    tm.task = null; tm.evacuating = false;
    return { ok: true };
  }

  function edgeAtCell(sim, x, y) {
    const id = sim.scen.road.cellEdge.get(Math.round(x) + ',' + Math.round(y));
    return id || null;
  }

  function remainingRouteEdges(sim, tm) {
    const t = tm.task;
    if (!t.edges) return [];
    const path = t.path;
    const segNow = Math.min(t.seg || 0, path.pts.length - 1);
    const ids = new Set();
    for (let i = segNow; i < path.pts.length; i++) {
      const eid = edgeAtCell(sim, path.pts[i][0], path.pts[i][1]);
      if (eid) ids.add(eid);
    }
    t.edges.forEach(id => ids.add(id)); // 保守保留全部规划边，再由位置裁剪
    // 去掉已经明显走在身后的边：用当前点到边中点距离判定
    const cur = { x: tm.x, y: tm.y };
    return Array.from(ids).filter(id => {
      const e = sim.scen.road.edges.find(ed => ed.id === id);
      if (!e) return false;
      const a = sim.scen.road.nodes[e.a], b = sim.scen.road.nodes[e.b];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      return U.dist(cur.x, cur.y, mx, my) < 60;
    });
  }

  /* ---------- 任务推进 ---------- */
  function followPath(tm, path, minutes) {
    let move = tm.speed * minutes;
    let seg = tm.task.seg || 0;
    while (move > 0 && seg < path.pts.length - 1) {
      const a = path.pts[seg], b = path.pts[seg + 1];
      const segLen = U.dist(a[0], a[1], b[0], b[1]);
      const adv = move;
      if (adv >= segLen) {
        move -= segLen; seg++;
      } else {
        const r = adv / segLen;
        tm.x = a[0] + (b[0] - a[0]) * r;
        tm.y = a[1] + (b[1] - a[1]) * r;
        move = 0;
      }
    }
    tm.task.seg = seg;
    if (seg >= path.pts.length - 1) {
      const end = path.pts[path.pts.length - 1];
      tm.x = end[0]; tm.y = end[1];
      return true;
    }
    return false;
  }

  function pathCrossesFire(sim, pts) {
    for (const [x, y] of pts) {
      const i = idx(sim, x, y);
      if (isBurning(sim, i)) return true;
    }
    return false;
  }

  function airLegCrossesFire(sim, ax, ay, bx, by) {
    const cells = U.rasterLine(ax, ay, bx, by);
    for (const [x, y] of cells) {
      if (!inMap(sim.scen, x, y)) continue;
      if (isBurning(sim, idx(sim, x, y))) return true;
    }
    return false;
  }

  function invalidate(sim, tm, reason) {
    if (!tm.task) return;
    if (tm.task.state === 'invalid') return;
    tm.task.state = 'invalid';
    tm.task.invalidReason = reason;
    sim.metrics.rechecks++;
    sim.alerts.push({
      level: 'crit', t: sim.t, team: tm.id,
      text: tm.name + ' 任务《' + (tm.task.detail || tm.task.type) + '》不可执行：' + reason + '，需重新确认'
    });
  }

  function checkGroundTask(sim, tm) {
    const t = tm.task;
    // 后续道路边被封/烧断（按当前位置剩余路段判断）
    const remain = remainingRouteEdges(sim, tm);
    for (const eid of remain) {
      const e = sim.scen.road.edges.find(ed => ed.id === eid);
      if (e && edgeBlocked(sim, e)) { invalidate(sim, tm, '前进道路封闭或被火线切断'); return false; }
    }
    // 离路作业点被火吞没
    if (t.breakId) {
      const brk = sim.breaks.find(b => b.id === t.breakId);
      if (brk && brk.pts.some(([x, y]) => isBurning(sim, idx(sim, x, y)))) {
        invalidate(sim, tm, '隔离带作业段已起火'); return false;
      }
    }
    return true;
  }

  function nearestFireDist(sim, x, y) {
    let bd = Infinity;
    for (let yy = 0; yy < sim.scen.H; yy++) {
      for (let xx = 0; xx < sim.scen.W; xx++) {
        if (isBurning(sim, idx(sim, xx, yy))) {
          const d = U.dist(x, y, xx, yy);
          if (d < bd) bd = d;
        }
      }
    }
    return bd;
  }

  function updateAlarms(sim) {
    sim.teams.forEach(tm => {
      if (tm.kind !== 'ground') return;
      const d = nearestFireDist(sim, tm.x, tm.y);
      const lvl = d < GROUND_CRIT ? 2 : d < GROUND_DANGER ? 1 : 0;
      if (lvl > tm.alarm) {
        if (lvl === 2) {
          sim.metrics.evacAlarms++;
          sim.alerts.push({
            level: 'crit', t: sim.t, team: tm.id,
            text: tm.name + ' 距火线仅 ' + d.toFixed(1) + ' 格，必须立即撤离'
          });
        } else if (lvl === 1) {
          sim.alerts.push({
            level: 'warn', t: sim.t, team: tm.id,
            text: tm.name + ' 进入危险距离（' + d.toFixed(1) + ' 格），任务需关注'
          });
        }
      }
      tm.alarm = lvl;
    });
  }

  function tickTeams(sim) {
    const scen = sim.scen;
    sim.teams.forEach(tm => {
      const t = tm.task;
      if (!t) return;
      if (t.state === 'invalid' || t.state === 'done') return;

      // 周期性复核
      if (sim.t >= (t.recheckAt || 0)) {
        t.recheckAt = sim.t + TASK_RECHECK;
        if (tm.kind === 'ground') checkGroundTask(sim, tm);
        if (tm.kind === 'air' && t.state !== 'invalid') {
          if (airLegCrossesFire(sim, t.legFromX ?? tm.x, t.legFromY ?? tm.y, t.legToX ?? tm.x, t.legToY ?? tm.y)) {
            invalidate(sim, tm, '空中航线穿越强对流/明火烟柱');
          }
        }
        if (t.state === 'invalid') return;
      }

      if (t.type === 'groundMove' || (t.state === 'moving' && t.path)) {
        const arrived = followPath(tm, t.path, DT);
        if (arrived) {
          const endNode = scen.road.nodes[t.targetNode || t.entryNode];
          if (endNode) { tm.x = endNode.x; tm.y = endNode.y; tm.node = endNode.id; }
          if (t.kind === 'build' && t.type === 'break') { t.state = 'working'; t.progress = 0; }
          else if (t.kind === 'defend' && t.type === 'groundDefend') { t.state = 'working'; }
          else { t.state = 'done'; }
        }
        return;
      }

      if (t.type === 'break' && t.state === 'working') {
        const brk = sim.breaks.find(b => b.id === t.breakId);
        if (!brk) { t.state = 'done'; return; }
        // 起点贴近隔离带首点
        if (brk.progress === 0) {
          tm.x = brk.pts[0][0]; tm.y = brk.pts[0][1]; tm.node = null;
        }
        const speedCells = 1.6;
        brk.progress = Math.min(brk.pts.length, (brk.progress || 0) + speedCells * DT);
        const k = Math.floor(brk.progress);
        for (let i = 0; i <= k && i < brk.pts.length; i++) {
          const [x, y] = brk.pts[i];
          sim.breakCells[idx(sim, x, y)] = 1;
          if (i < brk.pts.length) { tm.x = brk.pts[Math.min(k, brk.pts.length - 1)][0]; tm.y = brk.pts[Math.min(k, brk.pts.length - 1)][1]; }
        }
        if (brk.progress >= brk.pts.length) {
          brk.done = true; sim.metrics.breakBuilt++;
          t.state = 'done';
          sim.alerts.push({ level: 'info', t: sim.t, team: tm.id, text: tm.name + ' 已完成隔离带开设（' + brk.pts.length + ' 格）' });
        }
        return;
      }

      if (t.type === 'groundDefend' && t.state === 'working') {
        const tgt = sim.targets.find(q => q.id === t.targetId);
        if (tgt) { tm.x = tgt.x; tm.y = tgt.y; }
        return;
      }

      if (tm.kind === 'air') tickAir(sim, tm);
    });
  }

  function setAirLeg(tm, fx, fy, tx, ty) {
    tm.task.legFromX = fx; tm.task.legFromY = fy;
    tm.task.legToX = tx; tm.task.legToY = ty;
    tm.task.legDist = U.dist(fx, fy, tx, ty);
    tm.task.legTraveled = 0;
  }

  function tickAir(sim, tm) {
    const t = tm.task;
    // 空中直线推进
    if (t.type === 'airMove') {
      t.traveled += tm.speed * DT;
      const r = Math.min(1, t.traveled / t.dist);
      tm.x = t.fromX + (t.toX - t.fromX) * r;
      tm.y = t.fromY + (t.toY - t.fromY) * r;
      if (r >= 1) { t.state = t.kind === 'defend' ? 'working' : 'done'; tm.node = t.targetNode; }
      return;
    }
    if (t.type === 'airDefend' && t.state === 'working') {
      const tgt = sim.targets.find(q => q.id === t.targetId);
      if (tgt) {
        tm.x = tgt.x + 5 * Math.sin(sim.t / 2); tm.y = tgt.y - 4 + 2 * Math.cos(sim.t / 3);
      }
      return;
    }
    if (t.type === 'drop') {
      t.legTraveled += tm.speed * DT;
      let r = t.legDist ? Math.min(1, t.legTraveled / t.legDist) : 1;
      tm.x = t.legFromX + (t.legToX - t.legFromX) * r;
      tm.y = t.legFromY + (t.legToY - t.legFromY) * r;
      if (r < 1) return;
      // 到达航段终点
      if (t.phase === 'toFire') {
        // 洒水：以目标为中心
        applyDrop(sim, t.fireX, t.fireY, tm.power);
        sim.metrics.drops++;
        t.cycles++;
        sim.alerts.push({ level: 'info', t: sim.t, team: tm.id, text: tm.name + ' 第 ' + t.cycles + ' 架次洒水完成' });
        if (t.cycles >= t.maxCycles) { t.state = 'done'; return; }
        t.phase = 'toWater'; setAirLeg(tm, t.fireX, t.fireY, t.wpX, t.wpY);
      } else {
        t.phase = 'toFire'; setAirLeg(tm, t.wpX, t.wpY, t.fireX, t.fireY);
      }
    }
  }

  function applyDrop(sim, cx, cy, power) {
    const radius = 3.4;
    for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(sim.scen.H - 1, cy + radius); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(sim.scen.W - 1, cx + radius); x++) {
        const d = U.dist(x, y, cx, cy);
        if (d > radius) continue;
        const i = idx(sim, x, y);
        const w = (1 - d / radius) * 0.9 * power;
        sim.wet[i] = Math.min(1, sim.wet[i] + w);
        if (sim.suppress && isBurning(sim, i)) sim.suppress[i] += w * 6;
      }
    }
  }

  /* ---------- 保护目标风险 ---------- */
  function updateTargets(sim) {
    const scen = sim.scen;
    // 估计火线沿当前风向下的推进速度（格/分），用于 ETA
    const wf = sim.wind.speed / 10;
    const vSpread = 0.16 * (1 + wf * 1.2);
    sim.targets.forEach(tgt => {
      let bd = Infinity, nearest = null;
      for (let y = 0; y < scen.H; y++) {
        for (let x = 0; x < scen.W; x++) {
          if (!isBurning(sim, idx(sim, x, y))) continue;
          const d = U.dist(x, y, tgt.x, tgt.y) - tgt.radius;
          if (d < bd) { bd = d; nearest = [x, y]; }
        }
      }
      if (!nearest) { tgt.risk = 0; return; }
      // 风向是否把最近火点吹向目标
      const wdir = sim.wind.dir * U.D2R;
      const wvx = Math.sin(wdir), wvy = Math.cos(wdir);
      let dx = tgt.x - nearest[0], dy = tgt.y - nearest[1];
      const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
      const aligned = dx * wvx + dy * wvy;
      const v = vSpread * (0.5 + Math.max(0, aligned));
      const eta = v > 0.01 ? bd / v : 999;
      let risk;
      if (bd <= 0) risk = 3;
      else if (eta < 20) risk = 3;
      else if (eta < 45) risk = 2;
      else if (eta < 90 || aligned > 0.3) risk = 1;
      else risk = 0;
      const defended = sim.teams.some(tm =>
        tm.task && tm.task.state === 'working' && tm.task.targetId === tgt.id);
      if (defended && risk > 0) risk = Math.max(0, risk - 1);
      tgt.eta = eta === 999 ? null : Math.round(eta);
      tgt.risk = risk;
      tgt.riskPeak = Math.max(tgt.riskPeak || 0, risk);
      if (bd <= 0 && !tgt.lost) {
        tgt.lost = true;
        sim.metrics.lostValue += tgt.value;
        sim.alerts.push({ level: 'crit', t: sim.t, target: tgt.id,
          text: '保护目标【' + tgt.name + '】已被火侵入，损失等级 ' + tgt.value });
      }
    });
  }

  /* ---------- 环境事件 ---------- */
  function fireWindChange(sim, dir, speed, reason) {
    sim.wind.dir = dir; sim.wind.speed = speed;
    sim.alerts.push({ level: 'warn', t: sim.t, text: '风向突变：' + U.dirName(dir) + '风 ' + speed + ' m/s' + (reason ? '（' + reason + '）' : '') + '，所有在执行任务自动复核' });
    sim.log.push({ t: sim.t, tag: 'env', text: '气象变更 → ' + U.dirName(dir) + '风 ' + speed + ' m/s' + (reason ? '，' + reason : '') });
    sim.teams.forEach(tm => {
      if (!tm.task || tm.task.state === 'invalid' || tm.task.state === 'done') return;
      if (tm.kind === 'ground' && tm.task.edges) {
        for (const eid of remainingRouteEdges(sim, tm)) {
          const e = sim.scen.road.edges.find(ed => ed.id === eid);
          if (e && edgeBlocked(sim, e)) { invalidate(sim, tm, '风变后前进道路被新火线切断'); break; }
        }
      }
      if (tm.kind === 'air') {
        tm.task.recheckAt = Math.min(tm.task.recheckAt || sim.t, sim.t);
      }
    });
  }

  function igniteSpot(sim, x, y) {
    if (!inMap(sim.scen, x, y)) return false;
    const i = idx(sim, x, y);
    if (sim.scen.water[i] || sim.breakCells[i] || sim.ign[i] >= 0) return false;
    if (sim.scen.fuel[i] < 0.15) return false;
    sim.ign[i] = sim.t;
    return true;
  }

  function envEvents(sim) {
    const scen = sim.scen;
    (scen.windEvents || []).forEach((ev, k) => {
      if (!sim.firedWindEvents.has(k) && sim.t >= ev.t) {
        sim.firedWindEvents.add(k);
        fireWindChange(sim, ev.dir, ev.speed, ev.name);
      }
    });
  }

  /* ---------- 隔离带 ---------- */
  function addBreak(sim, pts) {
    const brk = {
      id: 'B' + (++sim.breakSeq), pts, done: false, progress: 0,
      length: pts.length, createdAt: sim.t
    };
    sim.breaks.push(brk);
    return brk;
  }

  /* ---------- 主步进 ---------- */
  function step(sim) {
    ensureSuppress(sim);
    sim.t += DT;
    envEvents(sim);
    suppressionStep(sim);
    spreadStep(sim);
    tickTeams(sim);
    updateAlarms(sim);
    updateTargets(sim);
    updateBurn(sim);
    sim.alerts = sim.alerts.filter(a => a.t >= sim.t - 40);
  }

  function advance(sim, minutes) {
    for (let i = 0; i < minutes; i++) step(sim);
  }

  /* ---------- 指令派发 ---------- */
  const COMMANDS = {};

  COMMANDS.close_edge = (sim, a) => {
    const e = typeof a.edge === 'string'
      ? sim.scen.road.edges.find(ed => ed.id === a.edge)
      : sim.scen.road.edgeOf(a.a, a.b);
    if (!e) return { ok: false, msg: '道路不存在' };
    sim.closedEdges.add(e.id);
    sim.log.push({ t: sim.t, tag: 'cmd', text: '封闭道路：' + roadName(sim, e) });
    // 立即影响在途地面任务
    sim.teams.forEach(tm => {
      if (tm.task && tm.task.edges && tm.task.state !== 'invalid' && tm.task.state !== 'done' && tm.kind === 'ground') {
        if (remainingRouteEdges(sim, tm).includes(e.id)) {
          invalidate(sim, tm, '道路被指挥封闭，需改变进入方向');
        }
      }
    });
    return { ok: true };
  };
  COMMANDS.open_edge = (sim, a) => {
    sim.closedEdges.delete(a.edge);
    sim.log.push({ t: sim.t, tag: 'cmd', text: '解除道路封闭：' + a.edge });
    return { ok: true };
  };
  COMMANDS.add_break = (sim, a) => {
    if (!a.pts || a.pts.length < 4) return { ok: false, msg: '隔离带过短' };
    const brk = addBreak(sim, a.pts);
    sim.log.push({ t: sim.t, tag: 'cmd', text: '规划隔离带 ' + brk.id + '（' + brk.pts.length + ' 格）' });
    return { ok: true, breakId: brk.id };
  };
  COMMANDS.assign_break = (sim, a) => {
    const brk = sim.breaks.find(b => b.id === a.breakId);
    if (!brk) return { ok: false, msg: '隔离带不存在' };
    return assignBreak(sim, a.teamId, brk, a.startNodeId);
  };
  COMMANDS.move = (sim, a) => assignMove(sim, a.teamId, a.targetNodeId);
  COMMANDS.defend = (sim, a) => assignDefend(sim, a.teamId, a.targetId);
  COMMANDS.drop = (sim, a) => assignDrop(sim, a.teamId, a.x, a.y, a.wpNodeId);
  COMMANDS.evac = (sim, a) => assignEvac(sim, a.teamId);
  COMMANDS.cancel = (sim, a) => cancelTask(sim, a.teamId);

  function roadName(sim, e) {
    const na = sim.scen.road.nodes[e.a], nb = sim.scen.road.nodes[e.b];
    return na.name + ' ↔ ' + nb.name;
  }

  function issueCommand(sim, type, args) {
    const fn = COMMANDS[type];
    if (!fn) return { ok: false, msg: '未知指令' };
    const res = fn(sim, args || {});
    if (res.ok && !res.noLog) {
      const tm = sim.teams.find(t => t.id === (args && args.teamId));
      const who = tm ? tm.name + '：' : '';
      sim.log.push({ t: sim.t, tag: 'cmd', text: who + cmdText(type, args, sim) });
    }
    if (!res.ok) {
      sim.log.push({ t: sim.t, tag: 'danger', text: '指令未执行：' + res.msg });
    }
    return res;
  }

  function cmdText(type, a, sim) {
    const nodeName = id => (sim.scen.road.nodes[id] || {}).name || id;
    const tgtName = id => (sim.targets.find(t => t.id === id) || {}).name || id;
    switch (type) {
      case 'move': return '机动至 ' + nodeName(a.targetNodeId);
      case 'defend': return '防护目标 ' + tgtName(a.targetId);
      case 'drop': return '吊桶灭火 (' + Math.round(a.x) + ',' + Math.round(a.y) + ')';
      case 'evac': return '立即撤离';
      case 'cancel': return '取消当前任务';
      case 'assign_break': return '开设隔离带 ' + a.breakId;
      default: return type;
    }
  }

  // 不改动状态的指令预检（通信恢复后核对队列）
  function validateCommand(sim, type, a) {
    const tm = a.teamId ? sim.teams.find(t => t.id === a.teamId) : null;
    if (type === 'close_edge' || type === 'open_edge' || type === 'cancel' || type === 'evac') return { ok: true };
    if (type === 'add_break') return (a.pts && a.pts.length >= 4) ? { ok: true } : { ok: false, msg: '隔离带已失效' };
    if (!tm) return { ok: false, msg: '队伍不存在' };
    if (type === 'move' || type === 'defend') {
      const nodeId = type === 'defend' ? sim.targets.find(t => t.id === a.targetId).node : a.targetNodeId;
      const from = tm.node || (nearestNode(sim.scen, tm.x, tm.y) || {}).id;
      if (!from) return { ok: false, msg: tm.name + ' 已不在道路上' };
      const r = groundRoute(sim, from, nodeId);
      return r ? { ok: true } : { ok: false, msg: '道路封闭或被火切断，无法到达' };
    }
    if (type === 'drop') return tm.kind === 'air' ? { ok: true } : { ok: false, msg: '非空中力量' };
    if (type === 'assign_break') {
      if (tm.work !== 'build') return { ok: false, msg: '非工程队' };
      const from = tm.node || (nearestNode(sim.scen, tm.x, tm.y) || {}).id;
      if (!from) return { ok: false, msg: '工程队已脱离道路' };
      return groundRoute(sim, from, a.startNodeId) ? { ok: true } : { ok: false, msg: '进场道路不可通行' };
    }
    return { ok: false, msg: '未知指令' };
  }

  /* ---------- 重新确认 ---------- */
  function reconfirmTask(sim, teamId) {
    const tm = sim.teams.find(t => t.id === teamId);
    if (!tm || !tm.task || tm.task.state !== 'invalid') return { ok: false, msg: '无需重新确认' };
    const t = tm.task;
    const from = tm.node || (nearestNode(sim.scen, tm.x, tm.y) || {}).id;
    if (tm.kind === 'ground') {
      if (!from) return { ok: false, msg: tm.name + ' 脱离道路网，需先撤离归建' };
      const dest = t.type === 'break' ? t.entryNode : t.targetNode;
      const r = groundRoute(sim, from, dest);
      if (!r) return { ok: false, msg: '仍无可通行路线，请改向或撤离' };
      t.edges = r.edges.map(e => e.id); t.path = buildPath(sim.scen, r.edges); t.seg = 0;
      t.state = 'moving'; t.invalidReason = null; t.recheckAt = sim.t + TASK_RECHECK;
      sim.log.push({ t: sim.t, tag: 'cmd', text: tm.name + ' 任务已重新确认，沿新路线继续执行' });
      return { ok: true };
    }
    if (t.type === 'drop') {
      setAirLeg(tm, tm.x, tm.y, t.phase === 'toWater' ? t.wpX : t.fireX,
        t.phase === 'toWater' ? t.wpY : t.fireY);
      t.state = 'moving'; t.invalidReason = null; t.recheckAt = sim.t + TASK_RECHECK;
      return { ok: true };
    }
    if (t.type === 'airMove' || t.type === 'airDefend') {
      const to = sim.scen.road.nodes[t.targetNode];
      t.fromX = tm.x; t.fromY = tm.y; t.toX = to.x; t.toY = to.y;
      t.dist = U.dist(tm.x, tm.y, to.x, to.y); t.traveled = 0;
      t.state = 'moving'; t.invalidReason = null; t.recheckAt = sim.t + TASK_RECHECK;
      return { ok: true };
    }
    return { ok: false, msg: '无法自动重新确认' };
  }

  /* ---------- 通信中断 / 恢复对账 ---------- */
  function commsDown(sim) {
    if (sim.comm.down) return;
    sim.comm.down = true;
    sim.comm.since = sim.t;
    sim.comm.queued = [];
    sim.comm.lastReport = {
      t: sim.t,
      teams: sim.teams.map(tm => ({
        id: tm.id, x: tm.x, y: tm.y, node: tm.node,
        task: tm.task ? {
          id: tm.task.id, type: tm.task.type, state: tm.task.state,
          detail: tm.task.detail, kind: tm.task.kind,
          edges: tm.task.edges ? tm.task.edges.slice() : null,
          targetId: tm.task.targetId || null, breakId: tm.task.breakId || null,
          targetNode: tm.task.targetNode || null, entryNode: tm.task.entryNode || null,
          cycles: tm.task.cycles || 0, phase: tm.task.phase || null,
          seg: tm.task.seg || 0
        } : null
      }))
    };
    sim.log.push({ t: sim.t, tag: 'sys', text: '与前方失去通信联络，态势停留在 T+' + sim.t + ' 分钟' });
  }

  function queueCommand(sim, type, args) {
    const entry = { t: sim.t, type, args: U.deepClone(args) };
    sim.comm.queued.push(entry);
    sim.log.push({ t: sim.t, tag: 'env', text: '通信中断，指令进入待确认队列：' + cmdText(type, args, sim) });
    return entry;
  }

  // 应用现场偏差（真实世界继续演化造成的计划-实况差）
  function applyFieldDrift(sim, gapRng, spot) {
    const discoveries = [];
    const driftByTeam = {};
    sim.teams.forEach(tm => {
      if (tm.kind !== 'ground') { driftByTeam[tm.id] = null; return; }
      // 执行地面任务的队伍继续推进了一段，位置偏离指挥所认知
      if (tm.task && (tm.task.state === 'moving' || tm.task.state === 'working')) {
        const mag = gapRng.range(1.2, 3.4);
        let nx = tm.x + gapRng.range(-mag, mag);
        let ny = tm.y + gapRng.range(-mag, mag);
        nx = U.clamp(nx, 0, sim.scen.W - 1); ny = U.clamp(ny, 0, sim.scen.H - 1);
        if (sim.scen.water[Math.round(ny) * sim.scen.W + Math.round(nx)]) { ny -= 2; }
        driftByTeam[tm.id] = { fromX: tm.x, fromY: tm.y, x: nx, y: ny };
        tm.x = nx; tm.y = ny;
        if (tm.node && U.dist(nx, ny,
            sim.scen.road.nodes[tm.node].x, sim.scen.road.nodes[tm.node].y) > 5) tm.node = null;
      } else driftByTeam[tm.id] = null;
    });
    if (spot && spot.x != null && igniteSpot(sim, spot.x, spot.y)) {
      discoveries.push({ type: 'spot', x: spot.x, y: spot.y,
        text: '火点东南侧出现飞火新火点 (' + spot.x + ',' + spot.y + ')' });
      sim.log.push({ t: sim.t, tag: 'danger', text: '通信中断期间出现飞火新火点' });
    }
    discoveries.push({ type: 'drift',
      text: '中断 ' + Math.round(sim.t - sim.comm.since) + ' 分钟，现场队伍位置与原计划出现偏差' });
    return { driftByTeam, discoveries };
  }

  function commsRestore(sim, gapRng, spot) {
    if (!sim.comm.down) return null;
    const gap = sim.t - sim.comm.since;
    const drift = applyFieldDrift(sim, gapRng, spot);
    const report = sim.comm.lastReport;

    // 需要撤离的队伍：危险等级 2 或正在起火段作业
    const evac = [];
    sim.teams.forEach(tm => {
      if (tm.kind !== 'ground') return;
      const d = nearestFireDist(sim, tm.x, tm.y);
      const reasons = [];
      if (d < GROUND_CRIT) reasons.push('距火线 ' + d.toFixed(1) + ' 格');
      if (tm.task && tm.task.state === 'invalid') reasons.push('任务已不可执行');
      if (reasons.length) evac.push({ teamId: tm.id, name: tm.name, dist: d, reasons });
    });

    // 需要重新确认的任务：invalid，或计划位置与现场不符（脱路/节点变更）
    const recheck = [];
    sim.teams.forEach(tm => {
      if (!tm.task || tm.task.state === 'done') return;
      const planned = report.teams.find(q => q.id === tm.id);
      const reasons = [];
      if (tm.task.state === 'invalid') reasons.push(tm.task.invalidReason || '任务已失效');
      if (tm.kind === 'ground' && !tm.node && (tm.task.edges || tm.task.type === 'groundMove')) {
        reasons.push('现场位置已偏离计划路线，无法确认到达节点');
      }
      if (planned && planned.task && Math.abs((planned.task.seg || 0) - (tm.task.seg || 0)) > 6) {
        reasons.push('实际推进进度与计划不一致');
      }
      if (reasons.length) {
        if (tm.task.state !== 'invalid') {
          tm.task.state = 'invalid';
          tm.task.invalidReason = reasons[0];
          sim.metrics.rechecks++;
        }
        recheck.push({ teamId: tm.id, name: tm.name,
          detail: tm.task.detail || tm.task.type, reasons });
      }
    });

    // 待确认指令逐条按恢复后实况复核
    const queued = sim.comm.queued.map(q => {
      const v = validateCommand(sim, q.type, q.args);
      return Object.assign({}, q, { valid: v.ok, reason: v.ok ? null : v.msg });
    });

    sim.comm.down = false;
    sim.comm.recon = { gap, evac, recheck, queued, discoveries: drift.discoveries, applied: false };
    sim.log.push({ t: sim.t, tag: 'sys', text: '通信恢复，中断 ' + Math.round(gap) + ' 分钟，生成现场对账结果' });
    return sim.comm.recon;
  }

  function applyQueuedCommand(sim, queuedIndex) {
    const recon = sim.comm.recon;
    const q = recon.queued[queuedIndex];
    if (!q || q.applied) return { ok: false, msg: '指令不存在' };
    const res = issueCommand(sim, q.type, q.args);
    q.applied = res.ok;
    return res;
  }

  /* ---------- 克隆（分叉策略） ---------- */
  function cloneSim(sim, name, tag) {
    const copy = createSim(sim.scen, name, tag);
    copy.t = sim.t;
    copy.ign = new Float32Array(sim.ign);
    copy.burn = new Float32Array(sim.burn);
    copy.wet = new Float32Array(sim.wet);
    copy.breakCells = new Uint8Array(sim.breakCells);
    copy.breaks = U.deepClone(sim.breaks);
    copy.closedEdges = new Set(sim.closedEdges);
    copy.teams = U.deepClone(sim.teams);
    copy.targets = U.deepClone(sim.targets);
    copy.log = U.deepClone(sim.log);
    copy.metrics = U.deepClone(sim.metrics);
    copy.wind = { dir: sim.wind.dir, speed: sim.wind.speed };
    copy.suppress = sim.suppress ? new Float32Array(sim.suppress) : undefined;
    copy.rng = new U.RngStream(sim.rng.state);
    copy.taskSeq = sim.taskSeq; copy.breakSeq = sim.breakSeq;
    copy.comm = U.deepClone(sim.comm);
    return copy;
  }

  global.FIRE_SIM = {
    DT, GROUND_DANGER, GROUND_CRIT, AIR_DANGER, TASK_RECHECK,
    shortestPath, buildPath, nearestSafeNode,
    createSim, idx, inMap, isBurning, isBurned, burnLife, activeFireCells,
    nearestFireDist,
    step, advance, addBreak,
    issueCommand, validateCommand, queueCommand,
    reconfirmTask,
    commsDown, commsRestore, applyQueuedCommand,
    fireWindChange, igniteSpot,
    cloneSim,
    edgeBlocked, nearestNode, groundRoute,
    COMMANDS
  };
})(window);
