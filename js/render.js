/* 渲染：静态地形离屏缓存 + 每帧态势绘制 + 命中检测 */
(function (global) {
  'use strict';
  const U = global.U;

  const COLORS = {
    road: '#6d5a3c', roadClosed: '#c4463a',
    ground: '#4da3ff', air: '#b07dff',
    target: '#3fce7e', targetLost: '#ff5d5d',
    breakDone: '#e8d9a0', breakPlan: 'rgba(232,217,160,.55)'
  };

  function mix(a, b, t) {
    const pa = [parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)];
    const pb = [parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)];
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return `rgb(${r},${g},${bl})`;
  }

  function buildBaseLayer(scen) {
    const cv = document.createElement('canvas');
    cv.width = scen.W; cv.height = scen.H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(scen.W, scen.H);
    for (let y = 0; y < scen.H; y++) {
      for (let x = 0; x < scen.W; x++) {
        const i = y * scen.W + x;
        let r, g, b;
        if (scen.water[i]) { r = 32; g = 96; b = 168; }
        else {
          const e = scen.elev[i], f = scen.fuel[i];
          // 低海拔沟谷偏褐绿，高海拔岩石灰
          const rock = U.clamp((e - 0.55) / 0.45, 0, 1);
          r = 26 + e * 46 + rock * 60;
          g = 40 + f * 55 + e * 30 - rock * 18;
          b = 28 + e * 34 - rock * 30;
        }
        const o = i * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // 等高线（浅色细线，每 0.12）
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    ctx.lineWidth = 0.4;
    for (let lvl = 0.2; lvl < 0.95; lvl += 0.16) {
      ctx.beginPath();
      for (let y = 1; y < scen.H - 1; y++) {
        for (let x = 1; x < scen.W - 1; x++) {
          const v = scen.elev[y * scen.W + x];
          const v2 = scen.elev[y * scen.W + x + 1];
          if ((v - lvl) * (v2 - lvl) < 0) { ctx.moveTo(x + .5, y + .5); ctx.lineTo(x + 1.2, y + .5); }
        }
      }
      ctx.stroke();
    }
    return cv;
  }

  function drawRoads(ctx, sim, hoverEdge) {
    const scen = sim.scen;
    scen.road.edges.forEach(e => {
      const closed = sim.closedEdges.has(e.id);
      const na = scen.road.nodes[e.a], nb = scen.road.nodes[e.b];
      ctx.strokeStyle = closed ? 'rgba(196,70,58,.9)' : 'rgba(120,98,66,.85)';
      ctx.lineWidth = closed ? 1.4 : 1.7;
      ctx.setLineDash(closed ? [2.2, 1.8] : []);
      ctx.beginPath();
      ctx.moveTo(na.x + .5, na.y + .5);
      ctx.lineTo(nb.x + .5, nb.y + .5);
      ctx.stroke();
      ctx.setLineDash([]);
      if (hoverEdge === e.id) {
        ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(na.x, na.y); ctx.lineTo(nb.x, nb.y); ctx.stroke();
      }
    });
    // 节点
    Object.values(scen.road.nodes).forEach(n => {
      ctx.fillStyle = '#0d1117';
      ctx.beginPath(); ctx.arc(n.x + .5, n.y + .5, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(219,228,238,.75)'; ctx.lineWidth = .8; ctx.stroke();
    });
  }

  function drawLabels(ctx, sim) {
    const scen = sim.scen;
    ctx.textAlign = 'center';
    Object.values(scen.road.nodes).forEach(n => {
      if (['westBase','village','temple','camp','westHeli','eastHeli'].includes(n.id) || n.id.startsWith('j')) {
        const fs = n.id.startsWith('j') ? 3 : 3.6;
        ctx.font = 'bold ' + fs + 'px sans-serif';
        const w = ctx.measureText(n.name).width + 1.6;
        ctx.fillStyle = 'rgba(5,8,11,.78)';
        ctx.fillRect(n.x + 2.4 - w / 2, n.y - 6.2, w, fs + 1);
        ctx.fillStyle = n.id.startsWith('j') ? 'rgba(170,186,202,.9)' : '#f0f4f8';
        ctx.fillText(n.name, n.x + 2.4, n.y - fs + .6);
      }
    });
  }


  function drawFire(ctx, sim) {
    const scen = sim.scen;
    // 过火地表（暗色烧焦）
    for (let y = 0; y < scen.H; y++) {
      for (let x = 0; x < scen.W; x++) {
        const i = y * scen.W + x;
        if (sim.ign[i] < 0) continue;
        if (FIRE_SIM.isBurning(sim, i)) continue;
        ctx.fillStyle = 'rgba(30,22,18,.55)';
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // 明火：前缘橙，内部红
    for (let y = 0; y < scen.H; y++) {
      for (let x = 0; x < scen.W; x++) {
        const i = y * scen.W + x;
        if (!FIRE_SIM.isBurning(sim, i)) continue;
        const age = sim.t - sim.ign[i];
        const life = FIRE_SIM.burnLife(sim, i) - (sim.suppress ? sim.suppress[i] : 0);
        const heat = U.clamp(1 - age / Math.max(1, life), 0, 1);
        const flicker = 0.82 + 0.18 * Math.sin(sim.t * 3 + (i % 17));
        const r = Math.round(255 * flicker);
        const g = Math.round((60 + heat * 130) * flicker);
        ctx.fillStyle = `rgba(${r},${g},30,.95)`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    // 湿化区域（蓝雾，仅显示明显的）
    for (let y = 0; y < scen.H; y++) {
      for (let x = 0; x < scen.W; x++) {
        const w = sim.wet[y * scen.W + x];
        if (w > 0.25) {
          ctx.fillStyle = `rgba(80,150,255,${(w * .35).toFixed(2)})`;
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
  }

  function drawBreaks(ctx, sim, draft) {
    sim.breaks.forEach(b => {
      if (!b.pts.length) return;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = b.done ? 'rgba(232,217,160,.95)' : 'rgba(232,217,160,.4)';
      ctx.lineWidth = b.done ? 1.6 : 1.1;
      ctx.setLineDash(b.done ? [] : [1.6, 1.4]);
      ctx.beginPath();
      b.pts.forEach(([x, y], k) => k ? ctx.lineTo(x + .5, y + .5) : ctx.moveTo(x + .5, y + .5));
      ctx.stroke();
      ctx.setLineDash([]);
    });
    if (draft && draft.length > 1) {
      ctx.strokeStyle = '#ffe9a3'; ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 1.4]);
      ctx.beginPath();
      draft.forEach(([x, y], k) => k ? ctx.lineTo(x + .5, y + .5) : ctx.moveTo(x + .5, y + .5));
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function triangle(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * .9, y + r * .7);
    ctx.lineTo(x - r * .9, y + r * .7);
    ctx.closePath(); ctx.fill();
  }

  function drawTeams(ctx, sim, selectedTeam, tNow) {
    sim.teams.forEach(tm => {
      const x = tm.x + .5, y = tm.y + .5;
      // 任务航迹（空中）
      if (tm.kind === 'air' && tm.task && (tm.task.type === 'drop')) {
        const t = tm.task;
        ctx.strokeStyle = 'rgba(176,125,255,.4)'; ctx.lineWidth = .5;
        ctx.setLineDash([1.2, 1.4]);
        ctx.beginPath();
        ctx.moveTo(t.legFromX, t.legFromY); ctx.lineTo(t.legToX, t.legToY); ctx.stroke();
        ctx.setLineDash([]);
      }
      if (tm.kind === 'air') {
        // 直升机小图标：菱形 + 旋翼
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = tm.id === selectedTeam ? '#fff' : COLORS.air;
        ctx.beginPath(); ctx.moveTo(0, -2.4); ctx.lineTo(2.1, 0); ctx.lineTo(0, 2.4); ctx.lineTo(-2.1, 0); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = .5;
        const flap = Math.sin(tNow * 1.5) * 1.6;
        ctx.beginPath(); ctx.moveTo(-3.1, flap * .2); ctx.lineTo(3.1, -flap * .2); ctx.stroke();
        ctx.restore();
      } else {
        const col = tm.alarm === 2 ? '#ff5d5d' : tm.alarm === 1 ? '#f2b53d' : COLORS.ground;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = tm.id === selectedTeam ? '#fff' : 'rgba(255,255,255,.6)';
        ctx.lineWidth = tm.id === selectedTeam ? 1.1 : .6; ctx.stroke();
        if (tm.task && tm.task.state === 'invalid') {
          ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = .8;
          ctx.beginPath(); ctx.arc(x, y, 3.8, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // 编号
      ctx.font = 'bold 2.6px sans-serif'; ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(5,8,11,.7)';
      ctx.fillText(tm.id, x + 3, y - 2.2);
      ctx.fillStyle = '#fff';
      ctx.fillText(tm.id, x + 2.8, y - 2.4);
    });
  }

  function drawTargets(ctx, sim) {
    sim.targets.forEach(t => {
      const col = t.lost ? COLORS.targetLost : ['#3fce7e', '#9cd94f', '#ffb13d', '#ff5d5d'][t.risk];
      ctx.save();
      ctx.translate(t.x + .5, t.y + .5);
      // 风险光圈
      if (t.risk > 0) {
        ctx.strokeStyle = col + '';
        ctx.globalAlpha = .5;
        ctx.beginPath(); ctx.arc(0, 0, t.radius + 1.6 + Math.sin(sim.t) * .4, 0, Math.PI * 2);
        ctx.lineWidth = .5; ctx.stroke(); ctx.globalAlpha = 1;
      }
      ctx.fillStyle = col;
      ctx.strokeStyle = '#0d1117'; ctx.lineWidth = .7;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + k * Math.PI / 3;
        const px = Math.cos(a) * 3.6, py = Math.sin(a) * 3.6;
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#0d1117'; ctx.font = 'bold 3px sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('护', 0, 1.1);
      ctx.restore();
      ctx.font = 'bold 3px sans-serif'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(5,8,11,.6)'; const w = ctx.measureText(t.name).width + 2;
      ctx.fillRect(t.x + .5 - w / 2, t.y - 7.6, w, 3.8);
      ctx.fillStyle = '#e8eef5'; ctx.fillText(t.name, t.x + .5, t.y - 4.8);
    });
  }

  function drawIgnition(ctx, sim) {
    const ig = sim.scen.ignition;
    if (sim.t > 4) return;
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = .6;
    ctx.beginPath(); ctx.arc(ig.x + .5, ig.y + .5, 4 + sim.t * .4, 0, Math.PI * 2); ctx.stroke();
  }

  function drawWind(ctx, sim) {
    const x = sim.scen.W - 9, y = 8;
    ctx.fillStyle = 'rgba(13,17,23,.8)';
    ctx.fillRect(x - 6.5, y - 6.5, 13, 12);
    ctx.strokeStyle = '#37444f'; ctx.lineWidth = .5;
    ctx.strokeRect(x - 6.5, y - 6.5, 13, 12);
    const a = sim.wind.dir * U.D2R;
    const vx = Math.sin(a), vy = Math.cos(a);
    ctx.strokeStyle = '#9fd0ff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - vx * 3.2, y - vy * 3.2); ctx.lineTo(x + vx * 3.2, y + vy * 3.2); ctx.stroke();
    const hx = x + vx * 3.2, hy = y + vy * 3.2;
    const px1 = hx - vx * 2 + vy * 1.3, py1 = hy - vy * 2 - vx * 1.3;
    const px2 = hx - vx * 2 - vy * 1.3, py2 = hy - vy * 2 + vx * 1.3;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(px1, py1); ctx.moveTo(hx, hy); ctx.lineTo(px2, py2); ctx.stroke();
    ctx.fillStyle = '#9fd0ff'; ctx.font = '2.6px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(U.dirName(sim.wind.dir) + ' ' + sim.wind.speed + 'm/s', x, y + 5);
  }

  function render(sim, cv, opts) {
    opts = opts || {};
    const ctx = cv.getContext('2d');
    const scen = sim.scen;
    ctx.imageSmoothingEnabled = false;
    cv.style.imageRendering = 'pixelated';
    if (!cv._base || cv._baseSeed !== scen.seed) {
      cv._base = buildBaseLayer(scen); cv._baseSeed = scen.seed;
    }
    ctx.clearRect(0, 0, scen.W, scen.H);
    ctx.drawImage(cv._base, 0, 0);
    drawRoads(ctx, sim, opts.hoverEdge);
    drawBreaks(ctx, sim, opts.draft);
    drawFire(ctx, sim);
    drawTargets(ctx, sim);
    drawTeams(ctx, sim, opts.selectedTeam, opts.clock || 0);
    drawIgnition(ctx, sim);
    drawLabels(ctx, sim);
    drawWind(ctx, sim);
    if (opts.dim) {
      ctx.fillStyle = 'rgba(8,11,15,.55)';
      ctx.fillRect(0, 0, scen.W, scen.H);
    }
  }

  /* ---------- 命中检测（格坐标） ---------- */
  function pickTeam(sim, gx, gy) {
    let best = null, bd = 4.2;
    sim.teams.forEach(tm => {
      const d = U.dist(gx, gy, tm.x, tm.y);
      if (d < bd) { bd = d; best = tm; }
    });
    return best;
  }
  function pickTarget(sim, gx, gy) {
    let best = null, bd = 5;
    sim.targets.forEach(t => {
      const d = U.dist(gx, gy, t.x, t.y);
      if (d < bd) { bd = d; best = t; }
    });
    return best;
  }
  function pickNode(scen, gx, gy) {
    let best = null, bd = 3.2;
    Object.values(scen.road.nodes).forEach(n => {
      const d = U.dist(gx, gy, n.x, n.y);
      if (d < bd) { bd = d; best = n; }
    });
    return best;
  }
  function pickEdge(sim, gx, gy) {
    let best = null, bd = 1.8;
    sim.scen.road.edges.forEach(e => {
      const a = sim.scen.road.nodes[e.a], b = sim.scen.road.nodes[e.b];
      const d = U.distPointSeg(gx, gy, a.x, a.y, b.x, b.y);
      if (d < bd) { bd = d; best = e; }
    });
    return best;
  }

  function pickBreak(sim, gx, gy) {
    let best = null, bd = 3;
    sim.breaks.forEach(b => {
      for (const [x, y] of b.pts) {
        const d = U.dist(gx, gy, x, y);
        if (d < bd) { bd = d; best = b; }
      }
    });
    return best;
  }

  global.RENDER = { buildBaseLayer, drawRoads, drawLabels, render, pickBreak, pickTeam, pickTarget, pickNode, pickEdge, COLORS };
})(window);
