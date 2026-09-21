/* 想定场景：固定起火条件（同种子可复现），道路为拓扑图，供多策略共享 */
(function (global) {
  'use strict';
  const U = global.U;

  const W = 96, H = 70;
  const SEED = 20260512;

  function fbm(noise, x, y, oct) {
    let v = 0, amp = 0.5, freq = 1, sum = 0;
    for (let i = 0; i < oct; i++) {
      v += amp * noise(x * freq, y * freq);
      sum += amp; amp *= 0.5; freq *= 2.1;
    }
    return v / sum;
  }

  function buildScenario() {
    const noise = U.makeValueNoise(SEED);

    // 高程：北部与中部为山区，山脊沿西北-东南
    const elev = new Float32Array(W * H);
    const fuel = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const nx = x / W, ny = y / H;
        let e = fbm(noise, nx * 3.2, ny * 3.2, 4);
        // 山体抬升：北高南低，叠加一道斜脊
        const ridge = 0.78 - ny * 0.9 + 0.22 * Math.exp(-Math.abs((ny - 0.28) - 0.55 * nx) * 3.2);
        e = U.clamp(e * 0.7 + ridge * 0.62, 0, 1);
        elev[y * W + x] = e;
        // 可燃物：高海拔裸岩少，沟谷与中坡最密
        let f = fbm(noise, nx * 5 + 9, ny * 5 + 3, 3);
        f = U.clamp(f * 0.55 + (e > 0.25 && e < 0.8 ? 0.5 : 0.12), 0, 1);
        fuel[y * W + x] = f;
      }
    }

    const water = new Uint8Array(W * H);
    const waterFill = (x, y) => {
      if (x >= 0 && y >= 0 && x < W && y < H) water[y * W + x] = 1;
    };

    // 西河：南部边界附近，阻断西侧南北联系
    const riverPts = [[-1, 60], [12, 58], [26, 57], [40, 55], [50, 56]];
    for (let i = 0; i < riverPts.length - 1; i++) {
      const seg = U.rasterLine(riverPts[i][0], riverPts[i][1], riverPts[i + 1][0], riverPts[i + 1][1]);
      seg.forEach(([x, y]) => {
        for (let ddx = -1; ddx <= 1; ddx++) for (let ddy = -1; ddy <= 1; ddy++) waterFill(x + ddx, y + ddy);
      });
    }
    // 东湖（直升机取水点）
    const lake = { x: 80, y: 24, rx: 6.5, ry: 5.2 };
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = (x - lake.x) ** 2 / lake.rx ** 2 + (y - lake.y) ** 2 / lake.ry ** 2;
        if (d <= 1) { waterFill(x, y); fuel[y * W + x] = 0; }
      }
    }

    // 道路拓扑（节点为真实可通行点：集结地、路口、村寺营地、停机坪/取水点）
    const nodes = {};
    function node(id, x, y, name) { nodes[id] = { id, x, y, name: name || id }; }
    node('westBase', 4, 18, '前进指挥所');
    node('westHeli', 6, 8, '西停机坪');
    node('wRiver', 14, 46, '西河道取水点');
    node('j1', 17, 22, '1号路口');
    node('j2', 29, 28, '2号路口');
    node('j3', 45, 33, '3号路口');
    node('j4', 64, 24, '4号路口');
    node('village', 56, 41, '云岭村');
    node('camp', 70, 49, '山坳营地');
    node('temple', 84, 30, '回龙古寺');
    node('wLake', 73, 15, '东湖取水点');
    node('eastHeli', 89, 12, '东停机坪');

    const edgeDefs = [
      ['westBase', 'westHeli'],
      ['westBase', 'wRiver'],
      ['westBase', 'j1'],
      ['j1', 'j2'],
      ['j2', 'j3'],
      ['j3', 'j4'],
      ['j3', 'village'],
      ['village', 'camp'],
      ['j4', 'temple'],
      ['j4', 'wLake'],
      ['j4', 'eastHeli'],
      ['temple', 'eastHeli']
    ];
    const edges = edgeDefs.map(([a, b], i) => {
      const na = nodes[a], nb = nodes[b];
      const cells = U.rasterLine(na.x, na.y, nb.x, nb.y)
        .filter(([x, y]) => x >= 0 && y >= 0 && x < W && y < H && !water[y * W + x]);
      return { id: 'e' + i, a, b, cells };
    });
    const cellEdge = new Map();
    edges.forEach(e => e.cells.forEach(([x, y]) => {
      const k = x + ',' + y;
      if (!cellEdge.has(k)) cellEdge.set(k, e.id);
    }));

    const adj = {};
    edges.forEach(e => {
      (adj[e.a] = adj[e.a] || []).push(e);
      (adj[e.b] = adj[e.b] || []).push(e);
    });

    function edgeOf(a, b) {
      return edges.find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    }
    function otherEnd(edge, nodeId) { return edge.a === nodeId ? edge.b : edge.a; }
    function edgeLen(e) {
      const p = nodes[e.a], q = nodes[e.b];
      return Math.hypot(p.x - q.x, p.y - q.y);
    }

    // 救援力量（初始部署）
    const teams = [
      { id: 'G1', name: '地面一队', kind: 'ground', role: '扑打队', x: 4, y: 18, node: 'westBase',
        speed: 2.2, work: 'suppress', power: 0.55, personnel: 22 },
      { id: 'G3', name: '地面三队', kind: 'ground', role: '工程队', x: 4, y: 18, node: 'westBase',
        speed: 2.0, work: 'build', power: 1, personnel: 16 },
      { id: 'G2', name: '地面二队', kind: 'ground', role: '守点队', x: 56, y: 41, node: 'village',
        speed: 2.2, work: 'defend', power: 0.6, personnel: 18 },
      { id: 'H1', name: '直升机甲', kind: 'air', role: '吊桶灭火', x: 6, y: 8, node: 'westHeli',
        speed: 14, work: 'drop', power: 1, aircraft: 'M-26' },
      { id: 'H2', name: '直升机乙', kind: 'air', role: '吊桶灭火', x: 89, y: 12, node: 'eastHeli',
        speed: 14, work: 'drop', power: 0.85, aircraft: 'K-32' }
    ];

    // 保护目标
    const targets = [
      { id: 'T1', name: '云岭村', x: 56, y: 41, radius: 4, value: 5, node: 'village',
        desc: '村民 320 人，已开始转移' },
      { id: 'T2', name: '回龙古寺', x: 84, y: 30, radius: 3, value: 3, node: 'temple',
        desc: '明清木构建筑群，国保单位' },
      { id: 'T3', name: '山坳营地', x: 70, y: 49, radius: 3, value: 2, node: 'camp',
        desc: '后勤油料堆场，含抢险装备库' }
    ];

    // 水源点（供直升机往返取水）
    const waterPoints = [
      { id: 'WP1', name: '东湖', x: 73, y: 15, node: 'wLake' },
      { id: 'WP2', name: '西河', x: 14, y: 46, node: 'wRiver' }
    ];

    return {
      W, H, seed: SEED,
      elev, fuel, water, lake,
      road: { nodes, edges, adj, cellEdge, edgeOf, otherEnd, edgeLen },
      teams, targets, waterPoints,
      ignition: { x: 34, y: 14 },
      wind: { dir: 180, speed: 6 },
      windEvents: [{ t: 90, dir: 40, speed: 8, fired: false, name: '冷锋过境，风向突转东北风并加大' }],
      spotEvent: { tMin: 28, tMax: 75 },
      presetBreaks: []
    };
  }

  global.SCEN = { buildScenario };
})(window);
