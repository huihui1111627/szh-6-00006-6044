/* terrain.js — 山区地形、植被、道路、水源、保护目标生成（确定性，按种子） */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  FS.buildTerrain = function (rng) {
    const W = 72, H = 44;
    const n = W * H;
    const elev = new Float32Array(n);
    const baseFuel = new Float32Array(n);
    const moist = new Float32Array(n);
    const water = new Uint8Array(n);
    const road = new Int16Array(n);
    const firebreak = new Uint8Array(n);   // 0 无 1 计划 2 已建成
    const state = new Uint8Array(n);       // 0 未燃 1 燃烧 2 已燃/扑灭
    const burnTimer = new Int16Array(n);

    const n1 = FS.makeNoise(rng, 6, 4), n2 = FS.makeNoise(rng, 12, 9);
    const n3 = FS.makeNoise(rng, 18, 12), n4 = FS.makeNoise(rng, 10, 8);

    let mn = Infinity, mx = -Infinity;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, nx = x / W, ny = y / H;
      let e = 0.55 * n1(nx * 6, ny * 4) + 0.3 * n2(nx * 12, ny * 9) + 0.15 * n3(nx * 18, ny * 12);
      e += 0.3 * Math.exp(-Math.pow((x - 6) / 9, 2));        // 西侧山脊
      e += 0.15 * Math.exp(-Math.pow((x - 64) / 12, 2));     // 东侧丘陵
      elev[i] = e;
      if (e < mn) mn = e; if (e > mx) mx = e;
    }
    for (let i = 0; i < n; i++) elev[i] = (elev[i] - mn) / (mx - mn);

    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, nx = x / W, ny = y / H;
      const v = n4(nx * 10, ny * 8);
      baseFuel[i] = v > 0.45 ? 0.6 + 0.4 * ((v - 0.45) / 0.55) : 0.25 + 0.25 * (v / 0.45);
      moist[i] = 0.25 + 0.25 * n3(nx * 18, ny * 12);
    }

    // 湖泊 + 河道
    const waterCells = [];
    const setWater = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const i = y * W + x;
      if (!water[i]) { water[i] = 1; waterCells.push({ x, y }); }
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = (x - 52) / 5, dy = (y - 27) / 4;
      if (dx * dx + dy * dy <= 1) setWater(x, y);
    }
    for (let y = 30; y < H; y++) {
      const cx = 52 + Math.round(1.5 * Math.sin(y * 0.5));
      setWater(cx, y); setWater(cx + 1, y);
    }

    // 道路网（折线栅格化，id 从 1 开始）
    const roads = {
      1: { name: 'R1 山谷主干道', pts: [[2, 32], [60, 32]] },
      2: { name: 'R2 北线盘山路', pts: [[10, 32], [10, 8], [40, 8]] },
      3: { name: 'R3 机场联络线', pts: [[40, 32], [45, 30]] },
      4: { name: 'R4 村庄支线',   pts: [[40, 8], [46, 10]] },
    };
    for (const id of Object.keys(roads)) {
      const pts = roads[id].pts;
      for (let k = 0; k < pts.length - 1; k++) {
        for (const c of FS.bresenham(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1])) {
          const i = c.y * W + c.x;
          if (c.x >= 0 && c.y >= 0 && c.x < W && c.y < H) { road[i] = +id; water[i] = 0; }
        }
      }
    }

    // 近水湿润
    for (const wc of waterCells) {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = wc.x + dx, y = wc.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        moist[i] = Math.min(0.9, moist[i] + 0.35);
      }
    }
    for (let i = 0; i < n; i++) if (water[i]) baseFuel[i] = 0;

    // 起火点周边保证可燃
    const ignition = { x: 14, y: 16 };
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = ignition.x + dx, y = ignition.y + dy, i = y * W + x;
      if (x >= 0 && y >= 0 && x < W && y < H && !water[i] && !road[i])
        baseFuel[i] = Math.max(baseFuel[i], 0.75);
    }

    const targets = [
      { id: 'T1', name: '村庄A', x: 47, y: 11, risk: '低', lost: false },
      { id: 'T2', name: '通信站', x: 30, y: 6,  risk: '低', lost: false },
      { id: 'T3', name: '村庄B', x: 58, y: 35, risk: '低', lost: false },
      { id: 'T4', name: '油库',   x: 18, y: 38, risk: '低', lost: false },
    ];
    const safePoints = [
      { x: 4, y: 32, name: '西集结点' },
      { x: 60, y: 32, name: '东集结点' },
      { x: 38, y: 8,  name: '北集结点' },
    ];

    return {
      W, H, elev, baseFuel, moist, water, waterCells, road, roads,
      roadClosed: {}, roadFailed: {},
      firebreak, state, burnTimer,
      targets, safePoints, helipad: { x: 45, y: 30 }, ignition,
    };
  };
})(window.FS);
