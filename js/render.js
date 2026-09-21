/* render.js — 地图与态势渲染（地形缓存 + 动态叠加） */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  const RISK_COLOR = { 低: '#4caf50', 中: '#ffc107', 高: '#ff9800', 极高: '#f44336' };
  const FIRE_COLORS = ['#ff6d00', '#ffab00', '#e64a19', '#ffd54f'];

  function getBase(sim, cell) {
    sim._baseCache = sim._baseCache || {};
    const hit = sim._baseCache[cell];
    if (hit && hit.ver === sim._baseVer) return hit.canvas;
    const cv = document.createElement('canvas');
    cv.width = sim.terrain.W * cell;
    cv.height = sim.terrain.H * cell;
    drawBase(cv.getContext('2d'), sim, cell);
    sim._baseCache[cell] = { ver: sim._baseVer, canvas: cv };
    return cv;
  }

  function drawBase(ctx, sim, cell) {
    const t = sim.terrain, W = t.W, H = t.H;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = t.elev[i];
      let r = 46 + e * 70, g = 62 + e * 44, b = 44 + e * 44;
      const f = t.baseFuel[i];
      r += (24 - r) * f * 0.55; g += (96 - g) * f * 0.55; b += (40 - b) * f * 0.55;
      if (t.water[i]) { r = 47; g = 111; b = 159; }
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect(x * cell, y * cell, cell, cell);
      const rid = t.road[i];
      if (rid) {
        ctx.fillStyle = t.roadFailed[rid] ? '#3d1414' : t.roadClosed[rid] ? '#7a2a2a' : '#8f8f8f';
        const m = cell * 0.22;
        ctx.fillRect(x * cell + m / 2, y * cell + m / 2, cell - m, cell - m);
        if (t.roadFailed[rid] || t.roadClosed[rid]) {
          ctx.strokeStyle = t.roadFailed[rid] ? '#ff5252' : '#ff8a80';
          ctx.lineWidth = 1;
          ctx.strokeRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
        }
      }
      if (t.firebreak[i] === 1) {
        ctx.fillStyle = 'rgba(201,162,39,0.6)';
        ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      } else if (t.firebreak[i] === 2) {
        ctx.fillStyle = '#6e4a2a';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    // 集结点
    ctx.fillStyle = '#66bb6a';
    for (const sp of t.safePoints) {
      ctx.beginPath();
      ctx.moveTo(sp.x * cell + cell / 2, sp.y * cell + 1);
      ctx.lineTo(sp.x * cell + cell - 1, sp.y * cell + cell - 1);
      ctx.lineTo(sp.x * cell + 1, sp.y * cell + cell - 1);
      ctx.closePath(); ctx.fill();
    }
    // 直升机坪
    const hp = t.helipad;
    ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = Math.max(1, cell / 8);
    ctx.strokeRect(hp.x * cell + 1, hp.y * cell + 1, cell - 2, cell - 2);
    if (cell >= 8) {
      ctx.fillStyle = '#4fc3f7';
      ctx.font = `${cell * 0.7}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('H', hp.x * cell + cell / 2, hp.y * cell + cell / 2);
    }
  }

  FS.render = function (ctx, sim, cell, opts) {
    opts = opts || {};
    const t = sim.terrain, W = t.W, H = t.H;
    ctx.drawImage(getBase(sim, cell), 0, 0);

    // 火场状态
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (t.state[i] === 1) {
        ctx.fillStyle = FIRE_COLORS[(x * 7 + y * 13 + sim.t) % FIRE_COLORS.length];
        ctx.fillRect(x * cell, y * cell, cell, cell);
      } else if (t.state[i] === 2) {
        ctx.fillStyle = 'rgba(22,18,15,0.85)';
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    // 保护目标
    for (const tg of t.targets) {
      const cx = tg.x * cell + cell / 2, cy = tg.y * cell + cell / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = tg.lost ? '#424242' : RISK_COLOR[tg.risk];
      ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
      if (cell >= 10) {
        ctx.fillStyle = tg.lost ? '#ef5350' : '#fff';
        ctx.font = `${cell * 0.62}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(tg.lost ? `${tg.name}✕` : tg.name, cx, cy - cell * 0.7);
      }
    }

    // 隔离带规划预览
    if (opts.preview && opts.preview.length) {
      ctx.fillStyle = 'rgba(255,235,59,0.55)';
      for (const c of opts.preview) ctx.fillRect(c.x * cell + 1, c.y * cell + 1, cell - 2, cell - 2);
    }

    // 选中队伍的路径
    const sel = opts.selected ? sim.unit(opts.selected) : null;
    if (sel && sel.path) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(sel.x * cell + cell / 2, sel.y * cell + cell / 2);
      for (let k = sel.pathI; k < sel.path.length; k++) {
        ctx.lineTo(sel.path[k].x * cell + cell / 2, sel.path[k].y * cell + cell / 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 救援力量
    for (const u of sim.units) {
      // 通信中断时：灰色幽灵 = 指挥所最后已知位置
      if (sim.commsDown && opts.main && u.reported) {
        const gx = u.reported.x * cell + cell / 2, gy = u.reported.y * cell + cell / 2;
        ctx.globalAlpha = 0.4;
        ctx.fillStyle = '#9e9e9e';
        ctx.fillRect(gx - cell * 0.45, gy - cell * 0.45, cell * 0.9, cell * 0.9);
        ctx.globalAlpha = 1;
        if (cell >= 10) {
          ctx.fillStyle = '#bdbdbd';
          ctx.font = `${cell * 0.5}px sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'top';
          ctx.fillText('最后已知', gx, gy + cell * 0.55);
        }
      }
      const cx = u.x * cell + cell / 2, cy = u.y * cell + cell / 2;
      const color = u.alert === 'evacuate' ? '#d32f2f' : u.alert === 'confirm' ? '#f9a825'
        : u.type === 'heli' ? '#0277bd' : '#2e7d32';
      if (u.alert) {
        const rr = cell * (0.9 + 0.25 * Math.sin(sim.t / 3));
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = u.alert === 'evacuate' ? '#ff1744' : '#ffc107';
        ctx.lineWidth = 2; ctx.stroke();
      }
      if (u.type === 'heli') {
        ctx.beginPath(); ctx.arc(cx, cy, cell * 0.55, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - cell * 0.5, cy); ctx.lineTo(cx + cell * 0.5, cy);
        ctx.moveTo(cx, cy - cell * 0.5); ctx.lineTo(cx, cy + cell * 0.5);
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(cx - cell * 0.5, cy - cell * 0.5, cell, cell);
        ctx.strokeStyle = sel === u ? '#ffeb3b' : '#fff';
        ctx.lineWidth = sel === u ? 2.5 : 1;
        ctx.strokeRect(cx - cell * 0.5, cy - cell * 0.5, cell, cell);
      }
      if (cell >= 10) {
        ctx.fillStyle = '#fff';
        ctx.font = `${cell * 0.55}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(u.name + (sim.commsDown && opts.main ? '（失联）' : ''), cx, cy + cell * 0.7);
      }
    }
  };
})(window.FS);
