/* simulation.js — 推演引擎：事件、指令、可行性评估、通信中断/恢复 */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  class Sim {
    constructor(seed) { this.seed = seed; this.script = []; this.reset(); }

    reset() {
      this.rng = FS.mulberry32(this.seed);
      this.terrain = FS.buildTerrain(this.rng);
      this.t = 0;
      this.wind = { dir: 90, speed: 5 };          // 初始：偏东风 5m/s
      this.units = FS.makeUnits();
      this.commsDown = false;
      this.pendingReconcile = false;
      this.autoReconcile = false;
      this.outbox = [];
      this.logs = [];
      this.alerts = [];
      this._baseVer = 0;
      this.fireQueue = [];
      this.metrics = { evacEvents: 0, confirmEvents: 0, targetsLost: 0, suppressed: 0 };
      this.events = [
        { t: 150, type: 'wind', dir: 175, speed: 8.5 },
        { t: 260, type: 'roadFail', road: 2 },
        { t: 330, type: 'commsDown' },
        { t: 430, type: 'commsUp' },
      ];
      for (const s of this.script) s.fired = false;
      const ig = this.terrain.ignition;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.ignite(ig.x + dx, ig.y + dy);
      this.burning = FS.collectBurning(this);
      this.syncReported();
      this.log('推演开始：起火点已确认，初期风向偏东');
    }

    idx(x, y) { return y * this.terrain.W + x; }
    markDirty() { this._baseVer++; }
    unit(id) { return this.units.find((u) => u.id === id); }

    ignite(x, y) {
      FS.igniteCell(this, this.idx(x, y));
    }

    effFuel(i) {
      const t = this.terrain;
      if (t.water[i] || t.firebreak[i] === 2) return 0;
      let f = t.baseFuel[i];
      if (t.road[i]) f *= 0.12;
      return f;
    }

    log(msg) {
      this.logs.push({ t: this.t, msg });
      if (this.logs.length > 300) this.logs.shift();
    }

    step() {
      this.t++;
      for (const e of this.events) {
        if (!e.fired && this.t >= e.t) { e.fired = true; this.fireEvent(e); }
      }
      for (const s of this.script) {
        if (!s.fired && this.t >= s.t) { s.fired = true; s.fn(this); }
      }
      FS.stepFire(this);
      this.burning = FS.collectBurning(this);
      FS.stepUnits(this);
      this.assess();
      if (!this.commsDown) this.syncReported();
    }

    /* ---------- 事件 ---------- */
    fireEvent(e) {
      if (e.type === 'wind') {
        this.wind.dir = e.dir; this.wind.speed = e.speed;
        this.log(`⚠ 风向突变：转${FS.dirName(e.dir)}风，风速 ${e.speed} m/s，已下达的行动需重新评估`);
      } else if (e.type === 'roadFail') {
        this.terrain.roadFailed[e.road] = true;
        this.markDirty();
        this.log(`⚠ ${this.terrain.roads[e.road].name} 塌方失效，相关路线不可通行`);
      } else if (e.type === 'commsDown') {
        this.setComms(true);
      } else if (e.type === 'commsUp') {
        this.setComms(false);
      }
    }

    manualWind() {
      const d = this.wind.dir + (this.rng() < 0.5 ? -1 : 1) * (60 + this.rng() * 60);
      this.wind.dir = ((d % 360) + 360) % 360;
      this.wind.speed = 7 + this.rng() * 3;
      this.log(`⚠ 风向突变：转${FS.dirName(this.wind.dir)}风，风速 ${this.wind.speed.toFixed(1)} m/s`);
    }

    manualRoadFail() {
      const ids = Object.keys(this.terrain.roads).map(Number)
        .filter((id) => !this.terrain.roadFailed[id]);
      if (!ids.length) return;
      const id = ids[Math.floor(this.rng() * ids.length)];
      this.terrain.roadFailed[id] = true;
      this.markDirty();
      this.log(`⚠ ${this.terrain.roads[id].name} 塌方失效，相关路线不可通行`);
    }

    setComms(down) {
      if (down === this.commsDown) return;
      this.commsDown = down;
      if (down) this.log('✖ 通信中断：与现场力量失去联系，指令将暂存待下达');
      else {
        this.log('✔ 通信恢复：现场状态可能与原计划不一致，请核对');
        if (this.autoReconcile) this.reconcile(true);
        else this.pendingReconcile = true;
      }
    }

    /* ---------- 指令 ---------- */
    issueOrder(unitId, task) {
      const u = this.unit(unitId);
      if (!u) return;
      if (this.commsDown) {
        this.outbox.push({ unitId, task });
        this.log(`通信中断：指令「${this.taskDesc(task)}」已暂存（${u.name}）`);
        return 'queued';
      }
      this.applyOrder(u, task);
      return 'ok';
    }

    applyOrder(u, task) {
      if (task.kind === 'evacuate') {
        const sp = this.nearestSafePoint(u.x, u.y);
        task = Object.assign({}, task, { x: sp.x, y: sp.y });
      }
      u.task = task;
      u.alert = null; u.reasons = []; u.dismissed = false;
      u.path = null; u.hstate = null;
      if (task.x != null && u.type === 'ground') this.planPath(u, task.x, task.y);
      this.log(`${u.name} 接受指令：${this.taskDesc(task)}`);
    }

    planPath(u, tx, ty) {
      const W = this.terrain.W;
      const start = this.idx(Math.round(u.x), Math.round(u.y));
      let goal = this.idx(tx, ty);
      let path = FS.astar(W, this.terrain.H, start, goal, (i) => this.groundCost(i));
      if (!path) {
        // 目标不可达时，在周边寻找可达点
        outer:
        for (let r = 1; r <= 4; r++) {
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const nx = tx + dx, ny = ty + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= this.terrain.H) continue;
            if (this.groundCost(ny * W + nx) === Infinity) continue;
            path = FS.astar(W, this.terrain.H, start, ny * W + nx, (i) => this.groundCost(i));
            if (path) break outer;
          }
        }
      }
      if (!path) {
        u.alert = 'confirm';
        u.reasons = ['无法规划到达路线'];
        return false;
      }
      u.path = path.map((i) => ({ x: i % W, y: (i / W) | 0 }));
      u.pathI = 0;
      return true;
    }

    groundCost(i) {
      const t = this.terrain;
      if (t.water[i] || t.state[i] === 1) return Infinity;
      if (t.firebreak[i] === 2) return 25;
      const r = t.road[i];
      if (r) {
        if (t.roadClosed[r] || t.roadFailed[r]) return Infinity;
        return 1;
      }
      return t.state[i] === 2 ? 4 : 6;
    }

    toggleRoad(id) {
      const t = this.terrain;
      if (t.roadFailed[id]) { this.log(`${t.roads[id].name} 已塌方，无法恢复通行`); return; }
      t.roadClosed[id] = !t.roadClosed[id];
      this.markDirty();
      this.log(t.roadClosed[id] ? `已封闭 ${t.roads[id].name}` : `已解封 ${t.roads[id].name}`);
    }

    closeRoad(id) {
      const t = this.terrain;
      if (!t.roadClosed[id]) { t.roadClosed[id] = true; this.markDirty(); this.log(`已封闭 ${t.roads[id].name}`); }
    }

    evacuate(unitId) {
      this.issueOrder(unitId, { kind: 'evacuate' });
    }

    // 调整灭火力量进入方向：绕至火场指定侧接近
    entryOrder(u, dir) {
      const c = this.fireCentroid();
      if (!c) return;
      const off = { N: [0, -12], S: [0, 12], E: [14, 0], W: [-14, 0] }[dir];
      let tx = FS.clamp(Math.round(c.x + off[0]), 1, this.terrain.W - 2);
      let ty = FS.clamp(Math.round(c.y + off[1]), 1, this.terrain.H - 2);
      const snap = this.nearestRoadCell(tx, ty, 12);
      if (snap) { tx = snap.x; ty = snap.y; }
      const names = { N: '北', S: '南', E: '东', W: '西' };
      this.issueOrder(u.id, { kind: 'move', x: tx, y: ty, desc: `从${names[dir]}侧进入火场` });
    }

    nearestRoadCell(x, y, maxR) {
      const t = this.terrain;
      let best = null, bd = Infinity;
      for (let dy = -maxR; dy <= maxR; dy++) for (let dx = -maxR; dx <= maxR; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= t.W || ny >= t.H) continue;
        const i = ny * t.W + nx;
        if (!t.road[i] || t.roadClosed[t.road[i]] || t.roadFailed[t.road[i]]) continue;
        const d = Math.hypot(dx, dy);
        if (d < bd) { bd = d; best = { x: nx, y: ny }; }
      }
      return best;
    }

    nearestSafePoint(x, y) {
      let best = this.terrain.safePoints[0], bd = Infinity;
      for (const sp of this.terrain.safePoints) {
        const d = Math.hypot(sp.x - x, sp.y - y);
        if (d < bd) { bd = d; best = sp; }
      }
      return best;
    }

    fireCentroid() {
      if (!this.burning.length) return null;
      let sx = 0, sy = 0;
      for (const b of this.burning) { sx += b.x; sy += b.y; }
      return { x: sx / this.burning.length, y: sy / this.burning.length };
    }

    /* ---------- 可行性评估：撤离 / 重新确认 ---------- */
    assess() {
      const t = this.terrain;
      this.alerts = [];
      for (const u of this.units) {
        u.alert = null; u.reasons = [];
        if (u.type === 'ground') {
          if (FS.burningWithin(this, u.x, u.y, 5).length) {
            u.alert = 'evacuate';
            u.reasons.push('位于火线蔓延危险区');
          }
          const tk = u.task;
          if (tk) {
            if (u.path && u.path.some((p) => {
              const r = t.road[this.idx(p.x, p.y)];
              return r && (t.roadClosed[r] || t.roadFailed[r]);
            })) {
              if (!u.alert) u.alert = 'confirm';
              u.reasons.push('行进路线经过封闭/失效道路');
            }
            if ((tk.kind === 'suppress' || tk.kind === 'move') && tk.x != null &&
                t.state[this.idx(tk.x, tk.y)] !== 0) {
              if (!u.alert) u.alert = 'confirm';
              u.reasons.push('任务目标区域已卷入火场');
            }
            if (tk.kind === 'firebreak' &&
                tk.cells.some((c) => t.state[this.idx(c.x, c.y)] !== 0)) {
              if (!u.alert) u.alert = 'confirm';
              u.reasons.push('隔离带计划线已被火线突破');
            }
          }
          if (u.alert === 'confirm' && u.dismissed) u.alert = null;
        }
        if (u.alert === 'evacuate' && u._prevAlert !== 'evacuate') this.metrics.evacEvents++;
        if (u.alert === 'confirm' && u._prevAlert !== 'confirm') this.metrics.confirmEvents++;
        u._prevAlert = u.alert;
        if (u.alert === 'evacuate') {
          this.alerts.push({ unit: u, level: 'evacuate', text: `${u.name}：${u.reasons.join('；')}，建议立即撤离` });
        } else if (u.alert === 'confirm') {
          this.alerts.push({ unit: u, level: 'confirm', text: `${u.name}：${u.reasons.join('；')}，任务需重新确认` });
        }
      }
      for (const tg of t.targets) {
        const d = FS.nearestBurningDist(this, tg.x, tg.y);
        tg.risk = d == null ? '低' : d < 4 ? '极高' : d < 8 ? '高' : d < 14 ? '中' : '低';
        if (!tg.lost && t.state[this.idx(tg.x, tg.y)] !== 0) {
          tg.lost = true;
          this.metrics.targetsLost++;
          this.log(`⚠ 保护目标「${tg.name}」已受损`);
        }
      }
    }

    /* ---------- 通信中断 / 恢复 ---------- */
    syncReported() {
      for (const u of this.units) {
        u.reported = { x: u.x, y: u.y, task: this.taskDesc(u.task) };
      }
    }

    discrepancies() {
      return this.units.map((u) => {
        const moved = Math.hypot(u.reported.x - u.x, u.reported.y - u.y) > 2;
        const taskDiff = u.reported.task !== this.taskDesc(u.task);
        return { unit: u, moved, taskDiff, diff: moved || taskDiff };
      });
    }

    reconcile(deliver) {
      this.syncReported();
      const n = this.outbox.length;
      if (deliver) {
        for (const o of this.outbox) this.applyOrder(this.unit(o.unitId), o.task);
      }
      this.outbox = [];
      this.pendingReconcile = false;
      this.log(`通信恢复处理完成：状态已同步，${deliver ? `已下达暂存指令 ${n} 条` : `作废暂存指令 ${n} 条`}`);
    }

    /* ---------- 展示辅助 ---------- */
    taskDesc(tk) {
      if (!tk) return '待命';
      switch (tk.kind) {
        case 'move': return tk.desc || `机动至 (${tk.x},${tk.y})`;
        case 'evacuate': return '撤离至安全集结点';
        case 'suppress': return `扑打火线 (${tk.x},${tk.y})`;
        case 'firebreak': return `开设隔离带（${tk.cells.length} 格）`;
        case 'patrol': return `吊桶灭火 (${tk.fx},${tk.fy})`;
        default: return tk.kind;
      }
    }

    burnedCount() {
      let n = 0;
      for (let i = 0; i < this.terrain.state.length; i++) if (this.terrain.state[i] !== 0) n++;
      return n;
    }

    burnedAreaHa() { return this.burnedCount() * 0.36; }   // 每格约 60m×60m
  }

  FS.Sim = Sim;
})(window.FS);
