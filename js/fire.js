/* fire.js — 火势蔓延模型：按风向/坡度/湿度计算蔓延时延，调度点燃（火线自然绕行障碍） */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  // 点燃某格，并按蔓延时延调度邻格点燃
  FS.igniteCell = function (sim, i) {
    const t = sim.terrain, W = t.W, H = t.H;
    if (t.state[i] !== 0) return;
    t.state[i] = 1;
    t.burnTimer[i] = 8 + Math.floor(sim.effFuel(i) * 10);
    const x = i % W, y = (i / W) | 0;
    const wdir = (sim.wind.dir * Math.PI) / 180;
    const wx = Math.sin(wdir), wy = -Math.cos(wdir);   // 罗盘方位：0=北，90=东
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (t.state[ni] !== 0) continue;
      const f = sim.effFuel(ni);
      if (f <= 0) continue;
      const len = Math.hypot(dx, dy);
      const align = (dx * wx + dy * wy) / len;          // 与风向对齐度
      const slope = t.elev[ni] - t.elev[i];             // 上坡蔓延更快
      const base = align > 0.7 ? 5 : align > 0.3 ? 6 : align > -0.3 ? 9 : align > -0.7 ? 12 : 15;
      const delay = base * (1.25 - 0.5 * f) * (1 + 0.8 * t.moist[ni]) *
                    FS.clamp(1 - 0.8 * slope, 0.5, 1.6);
      let q = 0.88 * f * (1 - 0.45 * t.moist[ni]);
      if (align < -0.5) q *= 0.7;
      if (sim.rng() < FS.clamp(q, 0, 0.95)) {
        sim.fireQueue.push({ t: sim.t + Math.max(1, Math.round(delay)), i: ni });
      }
    }
    // 飞火：下风方向跳跃点燃
    if (sim.rng() < 0.004 * (sim.wind.speed / 8)) {
      const d = 2 + Math.floor(sim.rng() * 3);
      const nx = Math.round(x + wx * d), ny = Math.round(y + wy * d);
      if (nx >= 0 && ny >= 0 && nx < W && ny < H) {
        const ni = ny * W + nx;
        if (t.state[ni] === 0 && sim.effFuel(ni) > 0.3) {
          sim.fireQueue.push({ t: sim.t + 2, i: ni });
        }
      }
    }
  };

  FS.stepFire = function (sim) {
    const t = sim.terrain;
    const rest = [];
    for (const q of sim.fireQueue) {
      if (q.t > sim.t) { rest.push(q); continue; }
      if (t.state[q.i] === 0 && sim.effFuel(q.i) > 0) FS.igniteCell(sim, q.i);
    }
    sim.fireQueue = rest;
    for (let i = 0; i < t.state.length; i++) {
      if (t.state[i] === 1 && --t.burnTimer[i] <= 0) t.state[i] = 2;
    }
  };

  FS.collectBurning = function (sim) {
    const t = sim.terrain, out = [];
    for (let i = 0; i < t.state.length; i++) {
      if (t.state[i] === 1) out.push({ x: i % t.W, y: (i / t.W) | 0, i });
    }
    return out;
  };

  FS.burningWithin = function (sim, x, y, r) {
    const out = [];
    for (const b of sim.burning) {
      if (Math.hypot(b.x - x, b.y - y) <= r) out.push(b.i);
    }
    return out;
  };

  FS.nearestBurning = function (sim, x, y, maxR) {
    let best = null, bd = maxR == null ? Infinity : maxR;
    for (const b of sim.burning) {
      const d = Math.hypot(b.x - x, b.y - y);
      if (d < bd) { bd = d; best = b; }
    }
    return best ? { x: best.x, y: best.y, i: best.i, d: bd } : null;
  };

  FS.nearestBurningDist = function (sim, x, y) {
    const b = FS.nearestBurning(sim, x, y, null);
    return b ? b.d : null;
  };
})(window.FS);
