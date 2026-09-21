/* 通用工具：确定性随机、值噪声、几何辅助、格式化 */
(function (global) {
  'use strict';

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 可保存/恢复状态的确定性随机源
  function RngStream(seed) {
    let state = seed >>> 0;
    return {
      next() {
        state |= 0; state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      },
      range(lo, hi) { return lo + this.next() * (hi - lo); },
      int(lo, hi) { return Math.floor(this.range(lo, hi + 1)); },
      get state() { return state; },
      set state(v) { state = v >>> 0; }
    };
  }

  // 平滑值噪声（双线性 + smoothstep），用于地形
  function makeValueNoise(seed) {
    const rng = mulberry32(seed);
    const lattice = new Map();
    function hash(ix, iy) { return ix * 73856093 ^ iy * 19349663; }
    function latticeVal(ix, iy) {
      const key = ix + ',' + iy;
      let v = lattice.get(key);
      if (v === undefined) {
        const r = mulberry32((hash(ix, iy) ^ seed) >>> 0);
        v = r();
        lattice.set(key, v);
      }
      return v;
    }
    const smooth = (t) => t * t * (3 - 2 * t);
    return function noise(x, y) {
      const x0 = Math.floor(x), y0 = Math.floor(y);
      const fx = smooth(x - x0), fy = smooth(y - y0);
      const v00 = latticeVal(x0, y0), v10 = latticeVal(x0 + 1, y0);
      const v01 = latticeVal(x0, y0 + 1), v11 = latticeVal(x0 + 1, y0 + 1);
      const top = v00 + (v10 - v00) * fx;
      const bot = v01 + (v11 - v01) * fx;
      return top + (bot - top) * fy;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Bresenham 线段栅格化，返回格点数组
  function rasterLine(x0, y0, x1, y1) {
    const pts = [];
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0, guard = 0;
    while (guard++ < 5000) {
      pts.push([x, y]);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return pts;
  }

  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

  // 点到线段距离
  function distPointSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // 角度（弧度）：dir 为风吹去方向，0=北，90=东，180=南，270=西
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  function dirName(deg) {
    const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return names[Math.round(((deg % 360) / 45)) % 8];
  }

  function fmtClock(tMin) {
    const t = Math.max(0, Math.round(tMin));
    const h = Math.floor(t / 60), m = t % 60;
    return 'T+' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  function deepClone(obj) {
    if (typeof structuredClone === 'function') return structuredClone(obj);
    return JSON.parse(JSON.stringify(obj));
  }

  // 每格移动耗时（分钟），speed cells/min；返回 null 表示不可通行
  function moveMinutes(cells, speed) { return cells / speed; }

  global.U = {
    mulberry32, RngStream, makeValueNoise, clamp, lerp,
    rasterLine, dist, dist2, distPointSeg,
    D2R, R2D, dirName, fmtClock, deepClone, moveMinutes
  };
})(window);
