/* core.js — 随机数、噪声、寻路等基础工具 */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  FS.mulberry32 = function (seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  FS.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };

  // 值噪声：返回函数 noise(x, y)，x∈[0,gw], y∈[0,gh]
  FS.makeNoise = function (rng, gw, gh) {
    const g = [];
    for (let i = 0; i < (gw + 1) * (gh + 1); i++) g.push(rng());
    return function (x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const s = (a, b) => g[Math.min(b, gh) * (gw + 1) + Math.min(a, gw)];
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return s(xi, yi) * (1 - u) * (1 - v) + s(xi + 1, yi) * u * (1 - v) +
             s(xi, yi + 1) * (1 - u) * v + s(xi + 1, yi + 1) * u * v;
    };
  };

  FS.bresenham = function (x0, y0, x1, y1) {
    const cells = [];
    let dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      cells.push({ x, y });
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return cells;
  };

  // A* 寻路，cost(i) 返回代价或 Infinity；返回索引数组或 null
  FS.astar = function (W, H, start, goal, cost) {
    if (start === goal) return [start];
    const gx = goal % W, gy = (goal / W) | 0;
    const h = (n) => {
      const dx = Math.abs((n % W) - gx), dy = Math.abs(((n / W) | 0) - gy);
      return Math.max(dx, dy) + 0.41 * Math.min(dx, dy);
    };
    const g = new Float64Array(W * H).fill(Infinity);
    const came = new Int32Array(W * H).fill(-1);
    const closed = new Uint8Array(W * H);
    g[start] = 0;
    const heap = [[h(start), start]];
    const push = (it) => {
      heap.push(it);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
      }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const cur = pop()[1];
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        const path = [];
        let n = cur;
        while (n !== -1) { path.push(n); n = came[n]; }
        return path.reverse();
      }
      const cx = cur % W, cy = (cur / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (closed[ni]) continue;
        const c = cost(ni);
        if (c === Infinity) continue;
        const step = (dx && dy) ? 1.4 : 1;
        const ng = g[cur] + c * step;
        if (ng < g[ni]) { g[ni] = ng; came[ni] = cur; push([ng + h(ni), ni]); }
      }
    }
    return null;
  };

  const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  FS.dirName = function (deg) { return DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]; };
})(window.FS);
