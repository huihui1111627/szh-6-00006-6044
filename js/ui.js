/* ui.js — 主界面：时间控制、操作模式、告警处置、通信恢复核对、策略并行回放 */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  const SEED = 20260922;
  const CELL = 14, CMP_CELL = 7, CMP_END = 600;
  const SPEEDS = [1, 2, 4];

  FS.initUI = function () {
    const sim = new FS.Sim(SEED);
    const canvas = document.getElementById('map');
    canvas.width = sim.terrain.W * CELL;
    canvas.height = sim.terrain.H * CELL;
    const ctx = canvas.getContext('2d');

    let mode = 'inspect';
    let selected = null;
    let playing = false, speedIdx = 0;
    let dragStart = null, dragCur = null;
    let modalOpen = false;

    const $ = (id) => document.getElementById(id);
    const mainView = $('mainView'), compareView = $('compareView');

    /* ================= 主视图渲染与推进 ================= */
    let last = performance.now(), acc = 0, panelTick = 0, cmpAcc = 0;

    function frame(ts) {
      requestAnimationFrame(frame);
      const dt = ts - last; last = ts;
      if (compareView.hidden) {
        if (playing && !modalOpen) {
          acc += dt;
          const stepMs = 200 / SPEEDS[speedIdx];
          while (acc > stepMs) { acc -= stepMs; sim.step(); panelTick++; }
        }
        if (panelTick >= 3 || sim.pendingReconcile) { updatePanels(); panelTick = 0; }
        if (sim.pendingReconcile && !modalOpen) openReconModal();
        FS.render(ctx, sim, CELL, { main: true, selected, preview: previewCells() });
      } else if (cmp) {
        if (cmp.playing && cmp.t < CMP_END) {
          cmpAcc += dt;
          while (cmpAcc > 120) {
            cmpAcc -= 120;
            if (cmp.t >= CMP_END) break;
            cmp.t++;
            for (const c of cmp.sims) c.sim.step();
          }
          $('cmpSlider').value = cmp.t;
          updateCmpMetrics();
        }
        for (const c of cmp.sims) FS.render(c.ctx, c.sim, CMP_CELL, {});
        $('cmpClock').textContent = clock(cmp.t);
      }
    }

    const clock = (t) => `T+${String((t / 60) | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;

    function previewCells() {
      if (!dragStart || !dragCur) return null;
      return FS.bresenhamSafe(dragStart.x, dragStart.y, dragCur.x, dragCur.y, sim.terrain.W, sim.terrain.H);
    }

    /* ================= 面板 ================= */
    function updatePanels() {
      $('clock').textContent = clock(sim.t);
      $('windArrow').style.transform = `rotate(${sim.wind.dir - 90}deg)`;
      $('windText').textContent = `${FS.dirName(sim.wind.dir)}风 ${sim.wind.speed.toFixed(1)} m/s`;
      const comms = $('commsState');
      comms.textContent = sim.commsDown ? `中断（暂存指令 ${sim.outbox.length} 条）` : '正常';
      comms.className = sim.commsDown ? 'bad' : 'good';
      $('evCommsDown').disabled = sim.commsDown;
      $('evCommsUp').disabled = !sim.commsDown;

      $('situation').innerHTML =
        `<div>过火面积：<b>${sim.burnedAreaHa().toFixed(1)}</b> ha</div>` +
        `<div>火线强度：<b>${sim.burning.length}</b> 个燃烧点</div>` +
        `<div>目标受损：<b>${sim.metrics.targetsLost}</b> / ${sim.terrain.targets.length}</div>` +
        sim.terrain.targets.map((tg) =>
          `<div class="tgt"><span class="dot" style="background:${riskColor(tg)}"></span>${tg.name}：${tg.lost ? '已受损' : '风险 ' + tg.risk}</div>`).join('');

      const ap = $('alerts');
      if (!sim.alerts.length) {
        ap.innerHTML = '<div class="ok">当前无待处置告警</div>';
      } else {
        ap.innerHTML = sim.alerts.map((a, k) =>
          `<div class="alert ${a.level}"><div>${a.text}</div><div class="ops">` +
          (a.level === 'evacuate'
            ? `<button data-act="evac" data-id="${a.unit.id}">立即撤离</button>`
            : `<button data-act="replan" data-id="${a.unit.id}">重新规划</button>` +
              `<button data-act="dismiss" data-id="${a.unit.id}">确认继续</button>`) +
          `</div></div>`).join('');
      }

      $('units').innerHTML = sim.units.map((u) => {
        const badge = u.alert === 'evacuate' ? '<span class="badge evac">需撤离</span>'
          : u.alert === 'confirm' ? '<span class="badge conf">需重新确认</span>'
          : u.task ? '<span class="badge run">执行中</span>' : '<span class="badge">待命</span>';
        const entry = u.type === 'ground'
          ? `<select data-entry="${u.id}"><option value="">进入方向…</option>` +
            `<option value="N">北侧进入</option><option value="S">南侧进入</option>` +
            `<option value="E">东侧进入</option><option value="W">西侧进入</option></select>` +
            `<button data-act="evac" data-id="${u.id}">撤离</button>` : '';
        return `<div class="unit ${selected === u.id ? 'sel' : ''}" data-unit="${u.id}">` +
          `<div><b>${u.name}</b>${badge}</div>` +
          `<div class="task">任务：${sim.taskDesc(u.task)}${sim.commsDown ? '（通信中断，状态未更新）' : ''}</div>` +
          `<div class="ops">${entry}</div></div>`;
      }).join('');

      $('log').innerHTML = sim.logs.slice(-40).reverse()
        .map((l) => `<div><span class="lt">${clock(l.t)}</span> ${l.msg}</div>`).join('');
    }

    function riskColor(tg) {
      return tg.lost ? '#616161' : { 低: '#4caf50', 中: '#ffc107', 高: '#ff9800', 极高: '#f44336' }[tg.risk];
    }

    /* ================= 通信恢复核对 ================= */
    function openReconModal() {
      modalOpen = true;
      const rows = sim.discrepancies().map((d) => {
        const u = d.unit;
        const plan = `(${u.reported.x.toFixed(0)},${u.reported.y.toFixed(0)}) ${u.reported.task}`;
        const actual = `(${u.x.toFixed(0)},${u.y.toFixed(0)}) ${sim.taskDesc(u.task)}`;
        return `<tr class="${d.diff ? 'diff' : ''}"><td>${u.name}</td><td>${plan}</td><td>${actual}</td>` +
          `<td>${d.diff ? (d.moved ? '位置偏离 ' : '') + (d.taskDiff ? '任务不一致' : '') : '一致'}</td></tr>`;
      }).join('');
      $('reconTable').innerHTML =
        '<tr><th>力量</th><th>原计划/最后已知</th><th>现场实际</th><th>差异</th></tr>' + rows;
      $('reconOutbox').textContent = `通信中断期间暂存指令 ${sim.outbox.length} 条`;
      $('commsModal').hidden = false;
    }

    $('reconSync').onclick = () => { sim.reconcile(true); modalOpen = false; $('commsModal').hidden = true; updatePanels(); };
    $('reconDrop').onclick = () => { sim.reconcile(false); modalOpen = false; $('commsModal').hidden = true; updatePanels(); };

    /* ================= 工具栏 ================= */
    $('btnPlay').onclick = () => {
      playing = !playing;
      $('btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 播放';
    };
    $('btnSpeed').onclick = () => {
      speedIdx = (speedIdx + 1) % SPEEDS.length;
      $('btnSpeed').textContent = SPEEDS[speedIdx] + '×';
    };
    $('btnReset').onclick = () => {
      sim.reset(); selected = null; playing = false;
      $('btnPlay').textContent = '▶ 播放';
      updatePanels();
    };
    document.querySelectorAll('.mode').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.mode').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        mode = b.dataset.mode;
        $('hint').textContent = {
          inspect: '查看/指挥：点击队伍选中，再点击地图下达机动/扑打指令（直升机为吊桶灭火点）',
          firebreak: '拖设隔离带：在地图上按住拖动划线，松开后自动指派最近队伍开设',
          road: '道路封控：点击道路进行封闭/解封（塌方道路不可恢复）',
        }[mode];
      };
    });
    $('evWind').onclick = () => { sim.manualWind(); updatePanels(); };
    $('evRoad').onclick = () => { sim.manualRoadFail(); updatePanels(); };
    $('evCommsDown').onclick = () => { sim.setComms(true); updatePanels(); };
    $('evCommsUp').onclick = () => { sim.setComms(false); updatePanels(); };

    /* ================= 地图交互 ================= */
    function cellOf(e) {
      const r = canvas.getBoundingClientRect();
      return {
        x: FS.clamp(Math.floor((e.clientX - r.left) / CELL), 0, sim.terrain.W - 1),
        y: FS.clamp(Math.floor((e.clientY - r.top) / CELL), 0, sim.terrain.H - 1),
      };
    }

    canvas.addEventListener('mousedown', (e) => {
      if (mode === 'firebreak') dragStart = cellOf(e);
    });
    canvas.addEventListener('mousemove', (e) => {
      const c = cellOf(e);
      if (dragStart) dragCur = c;
      const i = sim.idx(c.x, c.y);
      const t = sim.terrain;
      const st = t.state[i] === 1 ? '燃烧中' : t.state[i] === 2 ? '已烧' : t.water[i] ? '水源' : '未燃';
      $('cellInfo').textContent =
        `(${c.x},${c.y}) 海拔${(t.elev[i] * 1000) | 0}m 植被${(t.baseFuel[i] * 100) | 0}% ` +
        `${st}${t.road[i] ? ' ' + t.roads[t.road[i]].name : ''}`;
    });
    canvas.addEventListener('mouseup', (e) => {
      const c = cellOf(e);
      if (mode === 'firebreak' && dragStart) {
        const mid = { x: (dragStart.x + c.x) / 2, y: (dragStart.y + c.y) / 2 };
        let best = null, bd = Infinity;
        for (const u of sim.units) {
          if (u.type !== 'ground') continue;
          const d = Math.hypot(u.x - mid.x, u.y - mid.y) + (u.task ? 20 : 0);
          if (d < bd) { bd = d; best = u; }
        }
        if (best) FS.planFirebreak(sim, best.id, dragStart.x, dragStart.y, c.x, c.y);
        dragStart = dragCur = null;
      } else if (mode === 'road') {
        const r = sim.terrain.road[sim.idx(c.x, c.y)];
        if (r) sim.toggleRoad(r);
      } else if (mode === 'inspect') {
        const u = sim.units.find((u) => Math.hypot(u.x - c.x, u.y - c.y) < 1.4);
        if (u) selected = u.id;
        else if (selected) {
          const su = sim.unit(selected);
          if (su.type === 'heli') sim.issueOrder(su.id, { kind: 'patrol', fx: c.x, fy: c.y });
          else sim.issueOrder(su.id, { kind: 'suppress', x: c.x, y: c.y });
        }
      }
      updatePanels();
    });

    /* ================= 侧栏操作 ================= */
    $('sidebar').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const row = e.target.closest('.unit');
      if (b && b.dataset.act === 'evac') sim.evacuate(b.dataset.id);
      else if (b && b.dataset.act === 'replan') {
        const u = sim.unit(b.dataset.id);
        if (u && u.task) sim.applyOrder(u, u.task);
      } else if (b && b.dataset.act === 'dismiss') {
        const u = sim.unit(b.dataset.id);
        if (u) u.dismissed = true;
      } else if (row) selected = row.dataset.unit;
      updatePanels();
    });
    $('sidebar').addEventListener('change', (e) => {
      const s = e.target.closest('select[data-entry]');
      if (s && s.value) {
        sim.entryOrder(sim.unit(s.dataset.entry), s.value);
        s.value = '';
        updatePanels();
      }
    });

    /* ================= 策略并行回放 ================= */
    let cmp = null;
    function buildCompare() {
      const grid = $('cmpGrid');
      cmp = { t: 0, playing: false, sims: [] };
      for (const strat of FS.strategies) {
        const s = new FS.Sim(SEED);
        s.autoReconcile = true;
        s.script = strat.script;
        const card = document.createElement('div');
        card.className = 'cmpCard';
        card.innerHTML = `<h4>${strat.name}</h4><canvas></canvas><div class="cmpMetrics"></div><p>${strat.desc}</p>`;
        const cv = card.querySelector('canvas');
        cv.width = s.terrain.W * CMP_CELL;
        cv.height = s.terrain.H * CMP_CELL;
        grid.appendChild(card);
        cmp.sims.push({ strat, sim: s, ctx: cv.getContext('2d'), metrics: card.querySelector('.cmpMetrics') });
      }
      $('cmpPlay').onclick = () => {
        cmp.playing = !cmp.playing;
        $('cmpPlay').textContent = cmp.playing ? '⏸ 暂停' : '▶ 回放';
      };
      $('cmpReset').onclick = () => { cmp.t = 0; cmp.playing = false; $('cmpPlay').textContent = '▶ 回放'; resyncCmp(); };
      $('cmpSlider').onchange = () => { cmp.t = +$('cmpSlider').value; resyncCmp(); };
      resyncCmp();
    }

    function resyncCmp() {
      for (const c of cmp.sims) {
        c.sim.reset();
        while (c.sim.t < cmp.t) c.sim.step();
      }
      $('cmpSlider').value = cmp.t;
      updateCmpMetrics();
    }

    function updateCmpMetrics() {
      for (const c of cmp.sims) {
        const s = c.sim;
        c.metrics.innerHTML =
          `<span>过火 <b>${s.burnedAreaHa().toFixed(1)}</b> ha</span>` +
          `<span>目标受损 <b>${s.metrics.targetsLost}</b></span>` +
          `<span>撤离告警 <b>${s.metrics.evacEvents}</b></span>` +
          `<span>重新确认 <b>${s.metrics.confirmEvents}</b></span>`;
      }
    }

    $('viewMain').onclick = () => {
      compareView.hidden = true; mainView.hidden = false;
      $('viewMain').classList.add('active'); $('viewCompare').classList.remove('active');
    };
    $('viewCompare').onclick = () => {
      if (!cmp) buildCompare();
      mainView.hidden = true; compareView.hidden = false;
      $('viewCompare').classList.add('active'); $('viewMain').classList.remove('active');
    };

    $('hint').textContent = '查看/指挥：点击队伍选中，再点击地图下达机动/扑打指令（直升机为吊桶灭火点）';
    updatePanels();
    requestAnimationFrame(frame);
  };
})(window.FS);
