/* 交互控制：策略视图、地图操作、面板、弹窗、通信流程 */
(function (global) {
  'use strict';
  const U = global.U;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));

  function Controller() {
    const scen = SCEN.buildScenario();
    const main = FIRE_SIM.createSim(scen, '主策略', '基线');
    this.scen = scen;
    this.sims = [main];
    this.activeId = main.id;
    this.mode = 'default';       // default | break | closure
    this.playing = true;
    this.speed = 4;
    this.compare = false;
    this.selectedTeam = null;
    this.selectedTarget = null;
    this.draft = null;           // 拖画中的隔离带点
    this.hoverEdge = null;
    this.autoPaused = false;
    this.spotRng = new U.RngStream(scen.seed ^ 0x9e37);
  }

  Controller.prototype.get = function (id) {
    return this.sims.find(s => s.id === id);
  };
  Controller.prototype.active = function () {
    return this.get(this.activeId) || this.sims[0];
  };

  Controller.prototype.toast = function (msg, level) {
    const stack = $('#toastStack');
    const el = document.createElement('div');
    el.className = 'toast ' + (level || '');
    el.textContent = msg;
    stack.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 3200);
    setTimeout(() => el.remove(), 3600);
  };

  /* ----- 指令统一入口：通信中断时入队 ----- */
  Controller.prototype.dispatch = function (type, args, opts) {
    const sim = (opts && opts.sim) || this.active();
    if (sim.comm.down) {
      const q = FIRE_SIM.queueCommand(sim, type, args);
      this.toast('通信中断，指令已加入待确认队列', 'warn');
      this.renderCommVeil();
      return { ok: true, queued: true };
    }
    const res = FIRE_SIM.issueCommand(sim, type, args);
    if (!res.ok) this.toast(res.msg, 'danger');
    else if (opts && opts.okMsg) this.toast(opts.okMsg, 'ok');
    this.refreshPanels();
    return res;
  };

  /* ----- 时间推进（全部策略同步） ----- */
  Controller.prototype.tick = function () {
    if (!this.playing) return;
    const downBefore = this.sims.some(s => s.comm.down);
    this.sims.forEach(s => FIRE_SIM.step(s));
    // 中断期间统一切断：通信状态为全局（主策略中断则全部中断视图一致）
    const anyCrit = this.handleNewAlerts();
    if (anyCrit && !this.autoPaused && !downBefore) {
      // 危险等级2时自动暂停一次
      this.playing = false; this.autoPaused = true;
      $('#btnPlay').textContent = '▶ 播放';
      this.toast('出现必须撤离的队伍，推演已自动暂停', 'danger');
    }
    if (this.sims.some(s => s.comm.down)) this.renderCommVeil();
  };

  Controller.prototype.handleNewAlerts = function () {
    // 危险等级2的撤离告警，每条只触发一次自动暂停
    const seen = this._pauseAlerts = this._pauseAlerts || new Set();
    const sim = this.active();
    let crit = false;
    sim.alerts.forEach(a => {
      if (a.level !== 'crit' || !a.team) return;
      const key = sim.id + '|' + a.t + '|' + a.team + '|' + a.text.slice(0, 12);
      if (!seen.has(key)) { seen.add(key); crit = true; }
    });
    return crit;
  };


  /* ---------- 策略视图 ---------- */
  Controller.prototype.layoutViews = function () {
    const stack = $('#canvasStack');
    stack.innerHTML = '';
    const n = this.compare ? this.sims.length : 1;
    stack.className = 'canvas-stack ' + (n === 1 ? 'single' : n === 2 ? 'dual' : 'quad');
    const list = this.compare ? this.sims.slice(0, 4) : [this.active()];
    list.forEach(sim => {
      const view = document.createElement('div');
      view.className = 'strat-view' + (sim.id === this.activeId ? ' active' : '');
      view.dataset.sid = sim.id;
      view.innerHTML =
        '<div class="sv-head">' +
        '<span class="sv-name"></span><span class="sv-tag"></span>' +
        '<button class="sv-focus">设为操作对象</button></div>' +
        '<canvas width="' + sim.scen.W + '" height="' + sim.scen.H + '"></canvas>' +
        '<div class="sv-badges">' +
        '<span class="sv-badge">明火 <b class="b-active"></b></span>' +
        '<span class="sv-badge">过火 <b class="b-burned"></b></span>' +
        '<span class="sv-badge">目标损失 <b class="b-lost"></b></span>' +
        '<span class="sv-badge">撤离告警 <b class="b-evac"></b></span>' +
        '</div>' +
        '<div class="sv-veil hidden">通信中断</div>';
      $('.sv-name', view).textContent = sim.name;
      $('.sv-tag', view).textContent = sim.tag + ' · ' + sim.id;
      $('.sv-focus', view).classList.toggle('active-view', sim.id === this.activeId);
      $('.sv-focus', view).addEventListener('click', () => {
        this.activeId = sim.id; this.layoutViews(); this.refreshPanels();
      });
      this.bindCanvas(view, sim);
      stack.appendChild(view);
    });
  };

  Controller.prototype.renderViews = function () {
    $$('.strat-view').forEach(view => {
      const sim = this.get(view.dataset.sid);
      const cv = $('canvas', view);
      RENDER.render(sim, cv, {
        clock: sim.t,
        selectedTeam: sim.id === this.activeId ? this.selectedTeam : null,
        hoverEdge: sim.id === this.activeId ? this.hoverEdge : null,
        draft: sim.id === this.activeId && this.mode === 'break' ? (this.draft || []).map(p => p.slice()) : null,
        dim: sim.comm.down
      });
      $('.b-active', view).textContent = sim.metrics.activeCells + ' 格';
      $('.b-burned', view).textContent = sim.metrics.burned + ' 格';
      $('.b-lost', view).textContent = sim.metrics.lostValue;
      $('.b-evac', view).textContent = sim.metrics.evacAlarms;
      $('.sv-veil', view).classList.toggle('hidden', !sim.comm.down);
    });
    $('#clockTime').textContent = U.fmtClock(this.active().t);
    $('#clockState').textContent = this.active().comm.down ? '通信中断' : (this.playing ? '推演中' : '已暂停');
    $('#clockSpeed').textContent = this.speed + '×';
    this.renderAlertBanner();
  };

  Controller.prototype.renderAlertBanner = function () {
    const sim = this.active();
    const box = $('#alertBanner');
    const crit = sim.alerts.filter(a => a.level === 'crit' && a.t >= sim.t - 40).slice(-4);
    const warn = sim.alerts.filter(a => a.level === 'warn' && a.t >= sim.t - 30).slice(-2);
    const items = crit.concat(warn);
    if (!items.length) { box.className = 'hidden'; box.innerHTML = ''; return; }
    box.className = crit.length ? '' : 'warn-level';
    box.innerHTML = items.map(a =>
      '<div class="al-row"><span class="al-tag">' + (a.level === 'crit' ? '危险' : '警告') + '</span>' +
      '<span class="al-time">[' + U.fmtClock(a.t) + ']</span><span>' + a.text + '</span></div>'
    ).join('');
  };

  /* ---------- 画布坐标 ---------- */
  Controller.prototype.toGrid = function (cv, ev) {
    const r = cv.getBoundingClientRect();
    const gx = (ev.clientX - r.left) / r.width * cv.width;
    const gy = (ev.clientY - r.top) / r.height * cv.height;
    return { gx, gy };
  };

  Controller.prototype.bindCanvas = function (view, sim) {
    const cv = $('canvas', view);
    cv.addEventListener('mousemove', e => {
      if (sim.id !== this.activeId) return;
      const { gx, gy } = this.toGrid(cv, e);
      if (this.mode === 'break' && this.draft) {
        this.draft.push([Math.round(gx), Math.round(gy)]);
        if (this.draft.length > 220) this.draft.shift();
      } else {
        const edge = RENDER.pickEdge(sim, gx, gy);
        this.hoverEdge = edge ? edge.id : null;
        cv.style.cursor = edge && this.mode === 'closure' ? 'pointer' : 'default';
      }
    });
    cv.addEventListener('mousedown', e => {
      if (sim.id !== this.activeId) { this.activeId = sim.id; this.layoutViews(); return; }
      const { gx, gy } = this.toGrid(cv, e);
      if (this.mode === 'break') {
        this.draft = [[Math.round(gx), Math.round(gy)]];
        e.preventDefault();
        return;
      }
      if (this.mode === 'closure') {
        const edge = RENDER.pickEdge(sim, gx, gy);
        if (edge) this.toggleClosure(sim, edge);
        return;
      }
      this.onMapClick(sim, gx, gy);
    });
    window.addEventListener('mouseup', () => {
      if (this.mode === 'break' && this.draft && this.draft.length > 1) this.finishBreak(sim);
      else this.draft = null;
    });
  };

  Controller.prototype.toggleClosure = function (sim, edge) {
    if (sim.closedEdges.has(edge.id)) {
      this.dispatch('open_edge', { edge: edge.id }, { sim });
      this.toast('已解除该道路封闭', 'ok');
    } else {
      const na = sim.scen.road.nodes[edge.a], nb = sim.scen.road.nodes[edge.b];
      this.dispatch('close_edge', { edge: edge.id }, { sim, okMsg: '已封闭 ' + na.name + '↔' + nb.name });
    }
  };

  Controller.prototype.finishBreak = function (sim) {
    // 栅格化压缩为去重折线
    const raw = this.draft; this.draft = null;
    if (!raw || raw.length < 4) return;
    const pts = [];
    raw.forEach(p => {
      if (!pts.length || U.dist(pts[pts.length - 1][0], pts[pts.length - 1][1], p[0], p[1]) >= 1) {
        pts.push([U.clamp(p[0], 1, sim.scen.W - 2), U.clamp(p[1], 1, sim.scen.H - 2)]);
      }
    });
    if (pts.length < 4) { this.toast('隔离带太短', 'warn'); return; }
    // 不得压水/火点
    const bad = pts.some(([x, y]) => sim.scen.water[y * sim.scen.W + x] || FIRE_SIM.isBurning(sim, FIRE_SIM.idx(sim, x, y)));
    if (bad) { this.toast('隔离带不能穿越水面或明火', 'danger'); return; }
    const res = this.dispatch('add_break', { pts }, { sim });
    if (res.ok) {
      this.mode = 'default';
      $('#btnBreak').classList.remove('primary');
      $('#modeHint').textContent = '隔离带 ' + res.breakId + ' 已规划：可在力量面板派工程队开设，或点击隔离带指派';
      this._pendingBreak = res.breakId;
      this.refreshPanels();
    }
  };

  Controller.prototype.onMapClick = function (sim, gx, gy) {
    const tm = RENDER.pickTeam(sim, gx, gy);
    if (tm) { this.selectedTeam = tm.id; this.selectedTarget = null; this.showTeamPopup(sim, tm, gx, gy); this.refreshPanels(); return; }
    const tgt = RENDER.pickTarget(sim, gx, gy);
    if (tgt) { this.selectedTarget = tgt.id; this.selectedTeam = null; this.showTargetPopup(sim, tgt, gx, gy); this.refreshPanels(); return; }
    const brk = RENDER.pickBreak(sim, gx, gy);
    if (brk && !brk.done && (!this.selectedTeam || !(sim.teams.find(q => q.id === this.selectedTeam) || {}).work)) {
      this.showBreakPopup(sim, brk);
      return;
    }
    const node = RENDER.pickNode(sim.scen, gx, gy);
    if (node && this.selectedTeam) {
      const team = sim.teams.find(t => t.id === this.selectedTeam);
      const res = this.dispatch('move', { teamId: team.id, targetNodeId: node.id });
      if (res.ok) {
        this.toast(team.name + ' → ' + node.name + (res.queued ? '（待确认）' : ''), res.queued ? 'warn' : 'ok');
        $('#mapPopup').classList.add('hidden');
      }
      return;
    }
    // 点击明火：若选中直升机，则派吊桶
    const ci = FIRE_SIM.idx(sim, Math.round(gx), Math.round(gy));
    if (inGrid(sim, gx, gy) && FIRE_SIM.isBurning(sim, ci) && this.selectedTeam) {
      const team = sim.teams.find(t => t.id === this.selectedTeam);
      if (team.kind === 'air') {
        const wp = this.nearestWater(sim, gx, gy);
        this.dispatch('drop', { teamId: team.id, x: Math.round(gx), y: Math.round(gy), wpNodeId: wp.node });
        $('#mapPopup').classList.add('hidden');
        return;
      }
    }
    $('#mapPopup').classList.add('hidden');
  };

  function inGrid(sim, gx, gy) {
    return gx >= 0 && gy >= 0 && gx < sim.scen.W && gy < sim.scen.H;
  }

  Controller.prototype.nearestWater = function (sim, x, y) {
    let best = null, bd = Infinity;
    sim.scen.waterPoints.forEach(w => {
      const d = U.dist(x, y, w.x, w.y);
      if (d < bd) { bd = d; best = w; }
    });
    return best;
  };

  /* ---------- 地图气泡 ---------- */
  Controller.prototype.popupAt = function (gx, gy, html) {
    const view = $('.strat-view.active') || $('.strat-view');
    const cv = $('canvas', view);
    const r = cv.getBoundingClientRect();
    const pop = $('#mapPopup');
    pop.innerHTML = html;
    pop.classList.remove('hidden');
    const vr = view.getBoundingClientRect();
    let left = r.left - vr.left + gx / cv.width * r.width + 12;
    let top = r.top - vr.top + gy / cv.height * r.height + 12;
    requestAnimationFrame(() => {
      if (left + pop.offsetWidth > vr.width - 8) left = r.left - vr.left + gx / cv.width * r.width - pop.offsetWidth - 12;
      if (top + pop.offsetHeight > vr.height - 8) top -= pop.offsetHeight + 24;
      pop.style.left = left + 'px'; pop.style.top = top + 'px';
    });
  };

  Controller.prototype.showTeamPopup = function (sim, tm) {
    const nodeHere = FIRE_SIM.nearestNode(sim.scen, tm.x, tm.y);
    const taskTxt = tm.task ? taskSummary(tm.task, sim) : '待命';
    const nodes = Object.values(sim.scen.road.nodes).map(n =>
      '<button class="btn sm" data-go="' + n.id + '">' + n.name + '</button>').join('');
    const targets = sim.targets.map(t =>
      '<button class="btn sm" data-defend="' + t.id + '">' + t.name + '</button>').join('');
    let html =
      '<div class="mp-title">' + (tm.kind === 'air' ? '🚁' : '🚒') + ' ' + tm.name +
        '<span class="fc-sub">' + tm.role + (tm.aircraft ? ' · ' + tm.aircraft : '') + '</span></div>' +
      '<div class="mp-sub">位置 (' + tm.x.toFixed(0) + ',' + tm.y.toFixed(0) + ')' +
        (nodeHere ? ' · ' + nodeHere.name : ' · 离路') + (tm.personnel ? ' · ' + tm.personnel + ' 人' : '') + '</div>' +
      '<div>当前：' + taskTxt + '</div>' +
      '<div class="mp-actions">';
    if (tm.kind === 'ground') {
      html += '<div style="width:100%;font-size:11px;color:var(--txt-dim)">指定进入方向 / 机动：</div>' + nodes +
        '<div style="width:100%;font-size:11px;color:var(--txt-dim)">派往防护：</div>' + targets;
    } else {
      html += '<div style="width:100%;font-size:11px;color:var(--txt-dim)">点击地图明火点派吊桶，或派往防护：</div>' + targets +
        '<button class="btn sm" data-dropfire="1">最近火线洒水</button>';
    }
    html += '<button class="btn sm danger" data-evac="1">立即撤离</button>' +
      (tm.task ? '<button class="btn sm" data-cancel="1">取消任务</button>' : '') +
      '</div>';
    this.popupAt(tm.x, tm.y, html);
    popHandlers(this, sim, tm);
  };

  function popHandlers(app, sim, tm) {
    const pop = $('#mapPopup');
    $$('[data-go]', pop).forEach(b => b.onclick = () => {
      app.dispatch('move', { teamId: tm.id, targetNodeId: b.dataset.go });
      pop.classList.add('hidden');
    });
    $$('[data-defend]', pop).forEach(b => b.onclick = () => {
      app.dispatch('defend', { teamId: tm.id, targetId: b.dataset.defend });
      pop.classList.add('hidden');
    });
    const evacBtn = $('[data-evac]', pop);
    if (evacBtn) evacBtn.onclick = () => { app.dispatch('evac', { teamId: tm.id }); pop.classList.add('hidden'); };
    const cancelBtn = $('[data-cancel]', pop);
    if (cancelBtn) cancelBtn.onclick = () => { app.dispatch('cancel', { teamId: tm.id }); pop.classList.add('hidden'); };
    const drop = $('[data-dropfire]', pop);
    if (drop) drop.onclick = () => {
      const fire = FIRE_SIM.activeFireCells(sim)[0];
      if (!fire) { app.toast('当前无明火点', 'warn'); return; }
      const wp = app.nearestWater(sim, fire.x, fire.y);
      app.dispatch('drop', { teamId: tm.id, x: fire.x, y: fire.y, wpNodeId: wp.node });
      pop.classList.add('hidden');
    };
  }

  Controller.prototype.showTargetPopup = function (sim, tgt) {
    const defenders = sim.teams.filter(t => t.task && t.task.targetId === tgt.id).map(t => t.name).join('、') || '无';
    const html =
      '<div class="mp-title">🛡 ' + tgt.name + '</div>' +
      '<div class="mp-sub">' + tgt.desc + '</div>' +
      '<div>风险等级：<b>' + ['安全', '关注', '较高', '危急'][tgt.risk] + '</b>' +
      (tgt.eta != null ? ' · 预计 ' + tgt.eta + ' 分钟逼近' : '') + '</div>' +
      '<div>当前防护：' + defenders + '</div>' +
      '<div class="mp-actions">' +
      sim.teams.map(t => '<button class="btn sm" data-send="' + t.id + '">' + t.name + '</button>').join('') +
      '</div>';
    this.popupAt(tgt.x, tgt.y, html);
    $$('#mapPopup [data-send]').forEach(b => b.onclick = () => {
      this.dispatch('defend', { teamId: b.dataset.send, targetId: tgt.id });
      $('#mapPopup').classList.add('hidden');
    });
  };

  Controller.prototype.showBreakPopup = function (sim, brk) {
    const start = brk.pts[0];
    // 距离隔离带起点最近的道路节点作为进场点
    let entry = null, ed = Infinity;
    Object.values(sim.scen.road.nodes).forEach(n => {
      const d = U.dist(start[0], start[1], n.x, n.y);
      if (d < ed) { ed = d; entry = n; }
    });
    const builders = sim.teams.filter(t => t.work === 'build');
    const pct = Math.min(100, Math.round((brk.progress || 0) / brk.pts.length * 100));
    const html =
      '<div class="mp-title">✂ 隔离带 ' + brk.id + (brk.done ? '（已完成）' : '') + '</div>' +
      '<div class="mp-sub">长度 ' + brk.pts.length + ' 格 · 进度 ' + pct + '%</div>' +
      (brk.done ? '<div>该隔离带已贯通，正在阻断火线绕行。</div>' :
        '<div>建议进场节点：<b>' + entry.name + '</b></div>' +
        '<div class="mp-actions">' +
        builders.map(t => '<button class="btn sm primary" data-build="' + t.id + '">' + t.name + ' 前往开设</button>').join('') +
        '</div>');
    this.popupAt(start[0], start[1], html);
    $$('#mapPopup [data-build]').forEach(b => b.onclick = () => {
      const res = this.dispatch('assign_break', { teamId: b.dataset.build, breakId: brk.id, startNodeId: entry.id });
      if (res.ok) { $('#mapPopup').classList.add('hidden'); this.selectedTeam = b.dataset.build; }
    });
  };

  function taskSummary(t, sim) {
    if (!t) return '待命';
    const stateMap = { moving: '机动中', working: '作业中', done: '已完成', invalid: '⚠ 需重新确认' };
    let s = (t.detail || t.type) + ' · <span class="tstate">' + (stateMap[t.state] || t.state) + '</span>';
    if (t.state === 'invalid' && t.invalidReason) s += '<div style="color:var(--danger)">原因：' + t.invalidReason + '</div>';
    if (t.type === 'break') {
      const b = sim.breaks.find(q => q.id === t.breakId);
      const pct = b ? Math.min(100, Math.round(b.progress / b.pts.length * 100)) : 0;
      s += '<div class="fc-progress"><i style="width:' + pct + '%"></i></div>';
    }
    return s;
  }

  /* ---------- 侧边面板 ---------- */
  Controller.prototype.refreshPanels = function () {
    this.renderForces();
    this.renderTargets();
    this.renderStrategies();
    this.renderLog();
    $('#tabStratBadge').textContent = this.sims.length;
    $('#tabLogBadge').textContent = Math.min(this.active().log.length, 99);
  };

  Controller.prototype.renderForces = function () {
    const sim = this.active();
    const box = $('#forceList');
    $('#tabForceBadge').textContent = sim.teams.filter(t => t.task && t.task.state !== 'done').length;
    box.innerHTML = sim.teams.map(tm => {
      const t = tm.task;
      const alarmText = ['安全', '危险距离', '立即撤离'][tm.alarm];
      return '<div class="force-card' + (tm.id === this.selectedTeam ? ' selected' : '') + '" data-team="' + tm.id + '">' +
        '<div class="fc-head">' +
          '<div class="fc-badge ' + tm.kind + '">' + (tm.kind === 'air' ? '🚁' : '🚒') + '</div>' +
          '<div><div class="fc-name">' + tm.name + '</div>' +
          '<div class="fc-sub">' + tm.role + (tm.personnel ? ' · ' + tm.personnel + '人' : '') + '</div></div>' +
          '<span class="fc-alarm alarm-' + tm.alarm + '">' + alarmText + '</span>' +
        '</div>' +
        '<div class="fc-task' + (t && t.state === 'invalid' ? ' invalid' : '') + '">' +
          (t ? '<span class="tt">任务：</span>' + taskSummary(t, sim) : '<span class="tt">状态：待命</span>') +
        '</div>' +
        '<div class="fc-actions">' +
          (t && t.state === 'invalid'
            ? '<button class="btn sm primary" data-reconfirm="' + tm.id + '">重新确认</button>' +
              '<button class="btn sm danger" data-evac="' + tm.id + '">撤离</button>' +
              '<button class="btn sm" data-cancel="' + tm.id + '">取消</button>'
            : (t ? '<button class="btn sm" data-cancel="' + tm.id + '">取消任务</button>' : '') +
              '<button class="btn sm danger" data-evac="' + tm.id + '">撤离</button>') +
          '<button class="btn sm" data-locate="' + tm.id + '">定位</button>' +
        '</div>' +
      '</div>';
    }).join('');
    $$('#forceList [data-reconfirm]').forEach(b => b.onclick = () => this.reconfirm(b.dataset.reconfirm));
    $$('#forceList [data-evac]').forEach(b => b.onclick = () => this.dispatch('evac', { teamId: b.dataset.evac }));
    $$('#forceList [data-cancel]').forEach(b => b.onclick = () => this.dispatch('cancel', { teamId: b.dataset.cancel }));
    $$('#forceList [data-locate]').forEach(b => b.onclick = () => {
      this.selectedTeam = b.dataset.locate;
      const tm = sim.teams.find(t => t.id === b.dataset.locate);
      this.showTeamPopup(sim, tm);
    });
    $$('#forceList .force-card').forEach(c => c.onclick = (e) => {
      if (e.target.tagName === 'BUTTON') return;
      this.selectedTeam = c.dataset.team;
      const tm = sim.teams.find(t => t.id === c.dataset.team);
      this.showTeamPopup(sim, tm);
      this.renderForces();
    });
  };

  Controller.prototype.reconfirm = function (teamId) {
    const sim = this.active();
    const res = FIRE_SIM.reconfirmTask(sim, teamId);
    if (!res.ok) { this.toast(res.msg, 'danger'); return; }
    sim.log.push({ t: sim.t, tag: 'cmd', text: (sim.teams.find(t => t.id === teamId)).name + ' 任务重新确认成功' });
    this.toast('任务已按当前态势重新确认', 'ok');
    this.refreshPanels();
  };

  Controller.prototype.renderTargets = function () {
    const sim = this.active();
    const box = $('#targetList');
    $('#tabTargetBadge').textContent = sim.targets.filter(t => t.risk > 0).length;
    box.innerHTML = sim.targets.map(t => {
      const defs = sim.teams.filter(q => q.task && q.task.targetId === t.id);
      return '<div class="target-card" data-target="' + t.id + '">' +
        '<div class="tc-head"><div class="tc-name">🛡 ' + t.name + '</div>' +
        '<div class="tc-type">价值 ' + t.value + '</div>' +
        '<span class="tc-risk risk-' + t.risk + '">' + ['安全', '关注', '较高', '危急'][t.risk] + '</span></div>' +
        '<div class="tc-meta">' + t.desc + (t.eta != null ? ' · 火头预计 ' + t.eta + ' 分钟到达' : '') + '</div>' +
        '<div class="tc-meta">防护力量：' + (defs.map(d => d.name).join('、') || '无') + '</div>' +
        '<div class="tc-actions">' +
          sim.teams.map(q => '<button class="btn sm" data-send="' + q.id + '">' + q.name + '</button>').join('') +
        '</div></div>';
    }).join('');
    $$('#targetList [data-send]').forEach(b => b.onclick = () => {
      const card = b.closest('.target-card');
      this.dispatch('defend', { teamId: b.dataset.send, targetId: card.dataset.target });
    });
  };

  Controller.prototype.renderStrategies = function () {
    const box = $('#strategyList');
    box.innerHTML = this.sims.map((s, i) =>
      '<div class="strat-card' + (s.id === this.activeId ? ' selected' : '') + '" style="' +
        (s.id === this.activeId ? 'border-color:var(--accent)' : '') + '">' +
        '<div><div class="sc-name">' + s.name + '</div>' +
        '<div class="sc-meta">' + s.tag + ' · ' + U.fmtClock(s.t) +
        ' · 过火 ' + s.metrics.burned + ' 格</div></div>' +
        '<div class="sc-ctl">' +
        (this.sims.length > 1 ? '<button class="btn sm" data-drop="' + s.id + '"' +
          (s.id === this.sims[0].id ? ' disabled title="基线策略不可删除"' : '') + '>删除</button>' : '') +
        '<button class="btn sm primary" data-activate="' + s.id + '">操作</button>' +
        '</div></div>'
    ).join('') + '<div class="metrics-hint">相同起火条件（同种子、同气象事件），并行推演对比当前指标；绿色为该指标最优。</div>';
    $$('#strategyList [data-activate]').forEach(b => b.onclick = () => {
      this.activeId = b.dataset.activate;
      this.layoutViews(); this.refreshPanels();
    });
    $$('#strategyList [data-drop]').forEach(b => b.onclick = () => {
      if (b.disabled) return;
      this.sims = this.sims.filter(s => s.id !== b.dataset.drop);
      if (this.activeId === b.dataset.drop) this.activeId = this.sims[0].id;
      this.layoutViews(); this.refreshPanels();
    });
    this.renderMetrics();
  };

  Controller.prototype.renderMetrics = function () {
    const rows = [
      ['过火面积(格)', s => s.metrics.burned, 'min'],
      ['当前明火(格)', s => s.metrics.activeCells, 'min'],
      ['目标损失(价值)', s => s.metrics.lostValue, 'min'],
      ['撤离告警(次)', s => s.metrics.evacAlarms, 'min'],
      ['任务重确认(次)', s => s.metrics.rechecks, 'min'],
      ['隔离带完成(条)', s => s.metrics.breakBuilt, 'max'],
      ['洒水架次', s => s.metrics.drops, 'max']
    ];
    let html = '<table class="metrics"><thead><tr><th>指标</th>' +
      this.sims.map(s => '<th>' + s.tag + '</th>').join('') + '</tr></thead><tbody>';
    rows.forEach(([name, fn, dir]) => {
      const vals = this.sims.map(fn);
      const best = dir === 'min' ? Math.min(...vals) : Math.max(...vals);
      html += '<tr><td>' + name + '</td>' + vals.map(v =>
        '<td' + (this.sims.length > 1 && v === best ? ' style="color:var(--ok)"' : '') + '>' + v + '</td>').join('') + '</tr>';
    });
    html += '</tbody></table>';
    $('#metricsPanel').innerHTML = html;
  };

  Controller.prototype.renderLog = function () {
    const sim = this.active();
    const box = $('#cmdLog');
    if (!sim.log.length) { box.innerHTML = '<div class="recon-empty">暂无指令；选中队伍后点击道路节点可指定进入方向。</div>'; return; }
    box.innerHTML = sim.log.slice().reverse().map(l => {
      const tagName = { env: '气象', cmd: '指令', sys: '系统', danger: '失败' }[l.tag] || l.tag;
      return '<div class="log-row' + (l.pending ? ' pending' : '') + (l.tag === 'danger' ? ' invalid' : '') + '">' +
        '<span class="log-time">[' + U.fmtClock(l.t) + ']</span>' +
        '<span class="log-tag ' + l.tag + '">' + tagName + '</span>' + l.text + '</div>';
    }).join('');
  };

  Controller.prototype.forkStrategy = function () {
    if (this.sims.length >= 4) { this.toast('最多并行 4 个策略', 'warn'); return; }
    const src = this.active();
    const tags = ['方案B', '方案C', '方案D'];
    const copy = FIRE_SIM.cloneSim(src, src.name + '·分叉', tags[this.sims.length - 1] || ('分叉' + this.sims.length));
    this.sims.push(copy);
    this.activeId = copy.id;
    this.toast('已在 ' + U.fmtClock(src.t) + ' 分叉出新策略，可下达不同指令对比结果', 'ok');
    this.layoutViews(); this.refreshPanels();
  };

  Controller.prototype.reset = function () {
    const oldScen = this.scen;
    const scen = SCEN.buildScenario();
    this.scen = scen;
    const fresh = FIRE_SIM.createSim(scen, '主策略', '基线');
    this.sims = [fresh];
    this.activeId = fresh.id;
    this.playing = true; this.autoPaused = false;
    this.selectedTeam = null; this.selectedTarget = null;
    this.mode = 'default'; this.draft = null;
    this._seenAlerts = new Set();
    $('#btnPlay').textContent = '⏸ 暂停';
    $('#btnBreak').classList.remove('primary');
    $('#btnClosure').classList.remove('primary');
    $('#mapPopup').classList.add('hidden');
    $('#commVeil').classList.add('hidden');
    this.layoutViews(); this.refreshPanels();
    this.toast('已重置到起火时刻 T+00:00（同种子，结果可复现）', 'ok');
  };

  /* ---------- 模式 ---------- */
  Controller.prototype.setMode = function (mode) {
    this.mode = this.mode === mode ? 'default' : mode;
    $('#btnBreak').classList.toggle('primary', this.mode === 'break');
    $('#btnClosure').classList.toggle('primary', this.mode === 'closure');
    const hints = {
      default: '默认：点击队伍/目标查看详情；选中队伍后点击道路节点 = 指定进入方向',
      break: '在地图上按住拖画隔离带（避开水面与明火），松开后规划完成并可派工程队',
      closure: '点击道路边进行封闭/解封；在途队伍的任务会立即重新评估'
    };
    $('#modeHint').textContent = hints[this.mode];
    if (this.mode !== 'break') this.draft = null;
  };

  /* ---------- 风向弹窗 ---------- */
  Controller.prototype.openWind = function () {
    const sim = this.active();
    $('#windDir').value = sim.wind.dir;
    $('#windSpd').value = sim.wind.speed;
    this.updateWindDialog();
    $('#dlgWind').classList.remove('hidden');
  };
  Controller.prototype.updateWindDialog = function () {
    const dir = +$('#windDir').value, spd = +$('#windSpd').value;
    $('#windDirLabel').textContent = U.dirName(dir) + ' ' + dir + '°';
    $('#windSpdLabel').textContent = spd + ' m/s';
    const cv = $('#windDial'), ctx = cv.getContext('2d');
    const cx = 100, cy = 100;
    ctx.clearRect(0, 0, 200, 200);
    ctx.strokeStyle = '#2a3744'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, 72, 0, Math.PI * 2); ctx.stroke();
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4;
      ctx.fillStyle = '#8aa0b4'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(['北','东北','东','东南','南','西南','西','西北'][k],
        cx + Math.sin(a) * 58, cy + Math.cos(a) * 58 + 4);
    }
    const wd = dir * U.D2R;
    ctx.strokeStyle = '#4da3ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(wd) * 62, cy + Math.cos(wd) * 62); ctx.stroke();
    ctx.fillStyle = '#4da3ff';
    ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
  };
  Controller.prototype.applyWind = function () {
    const dir = +$('#windDir').value, spd = +$('#windSpd').value;
    // 风向为全局想定：施加到所有并行策略
    this.sims.forEach(s => FIRE_SIM.fireWindChange(s, dir, spd, '指挥员人工调整'));
    $('#dlgWind').classList.add('hidden');
    this.toast('气象变更已下达，在执行任务已自动复核', 'warn');
    this.refreshPanels();
  };

  /* ---------- 通信中断 ---------- */
  Controller.prototype.goCommDown = function () {
    this.sims.forEach(s => { if (!s.comm.down) FIRE_SIM.commsDown(s); });
    this.playing = true;
    $('#btnPlay').textContent = '⏸ 暂停';
    this.renderCommVeil();
  };

  Controller.prototype.renderCommVeil = function () {
    const sim = this.active();
    const veil = $('#commVeil');
    if (!sim.comm.down) { veil.classList.add('hidden'); return; }
    veil.classList.remove('hidden');
    $('#veilElapsed').textContent = Math.round(sim.t - sim.comm.since);
    const q = sim.comm.queued;
    $('#veilQueue').innerHTML = q.length
      ? q.map(c => '<li>[' + U.fmtClock(c.t) + '] ' + this.cmdLabel(c.type, c.args, sim) + '</li>').join('')
      : '<li class="empty">暂无待确认指令</li>';
  };

  Controller.prototype.cmdLabel = function (type, a, sim) {
    return FIRE_SIM_COMM_TEXT(type, a, sim);
  };

  Controller.prototype.goCommRestore = function () {
    // 全局恢复；飞火为各策略用同种子独立采样→但想保持“同一现场”，主策略采样后广播
    const main = this.sims[0];
    const gap = main.t - main.comm.since;
    let spot = null;
    if (gap >= 8) {
      const fire = FIRE_SIM.activeFireCells(main);
      if (fire.length) {
        const f = fire[Math.floor(this.spotRng.next() * fire.length)];
        const ang = this.spotRng.range(0, Math.PI * 2), d = this.spotRng.range(6, 11);
        const sx = U.clamp(Math.round(f.x + Math.cos(ang) * d), 1, main.scen.W - 2);
        const sy = U.clamp(Math.round(f.y + Math.sin(ang) * d), 1, main.scen.H - 2);
        spot = { x: sx, y: sy };
      }
    }
    this._reconBySim = {};
    this.sims.forEach((s, i) => {
      const rng = new U.RngStream(0xabc0 + i * 7 + Math.round(s.t));
      const recon = FIRE_SIM.commsRestore(s, rng, spot);
      this._reconBySim[s.id] = recon;
    });
    this.playing = false;
    $('#btnPlay').textContent = '▶ 播放';
    $('#commVeil').classList.add('hidden');
    this.showReconDialog();
    this.refreshPanels();
  };

  Controller.prototype.showReconDialog = function () {
    const sim = this.active();
    const recon = this._reconBySim[sim.id];
    if (!recon) return;
    $('#reconGap').textContent = '（模拟时长 ' + Math.round(recon.gap) + ' 分钟）';
    $('#reconEvac').innerHTML = recon.evac.length ? recon.evac.map(e =>
      '<div class="recon-item"><div class="ri-main"><b>' + e.name + '</b>' +
      '<div class="ri-sub">' + e.reasons.join('；') + '</div></div>' +
      '<button class="btn sm danger" data-recon-evac="' + e.teamId + '">撤离</button></div>').join('')
      : '<div class="recon-empty">无处于危险区域的队伍</div>';
    $('#reconTasks').innerHTML = recon.recheck.length ? recon.recheck.map(e =>
      '<div class="recon-item"><div class="ri-main"><b>' + e.name + '</b> · ' + e.detail +
      '<div class="ri-sub">' + e.reasons.join('；') + '</div></div>' +
      '<button class="btn sm primary" data-recon-recheck="' + e.teamId + '">重新确认</button></div>').join('')
      : '<div class="recon-empty">所有在执行任务与现场一致</div>';
    $('#reconQueued').innerHTML = recon.queued.length ? recon.queued.map((q, i) =>
      '<div class="recon-item"><div class="ri-main">[' + U.fmtClock(q.t) + '] ' +
        this.cmdLabel(q.type, q.args, sim) +
        (q.valid ? '' : '<div class="ri-sub" style="color:var(--danger)">已失效：' + q.reason + '</div>') +
      '</div>' +
      (q.valid ? '<button class="btn sm primary" data-recon-apply="' + i + '">下达</button>'
               : '<button class="btn sm" data-recon-drop="' + i + '">废弃</button>') +
      '</div>').join('')
      : '<div class="recon-empty">中断期间没有下达指令</div>';
    $('#reconDiscoveries').innerHTML = recon.discoveries.map(d =>
      '<div class="recon-item"><div class="ri-main">' + d.text + '</div></div>').join('');
    $('#dlgRecon').classList.remove('hidden');
    this.bindReconActions(sim, recon);
  };

  Controller.prototype.bindReconActions = function (sim, recon) {
    $$('#reconEvac [data-recon-evac]').forEach(b => b.onclick = () => {
      this.dispatch('evac', { teamId: b.dataset.reconEvac }, { sim });
      this._reconBySim[sim.id].evac = recon.evac.filter(e => e.teamId !== b.dataset.reconEvac);
      this.showReconDialog();
    });
    $$('#reconTasks [data-recon-recheck]').forEach(b => b.onclick = () => {
      const res = FIRE_SIM.reconfirmTask(sim, b.dataset.reconRecheck);
      this.toast(res.ok ? '任务已按新态势确认' : res.msg, res.ok ? 'ok' : 'danger');
      if (res.ok) recon.recheck = recon.recheck.filter(e => e.teamId !== b.dataset.reconRecheck);
      this.showReconDialog(); this.refreshPanels();
    });
    $$('#reconQueued [data-recon-apply]').forEach(b => b.onclick = () => {
      const i = +b.dataset.reconApply, q = recon.queued[i];
      const res = FIRE_SIM.issueCommand(sim, q.type, q.args);
      q.applied = res.ok;
      this.toast(res.ok ? '中断期指令已按恢复后态势下达' : res.msg, res.ok ? 'ok' : 'danger');
      recon.queued = recon.queued.filter((_, k) => k !== i);
      this.showReconDialog(); this.refreshPanels();
    });
    $$('#reconQueued [data-recon-drop]').forEach(b => b.onclick = () => {
      recon.queued = recon.queued.filter((_, k) => k !== +b.dataset.reconDrop);
      this.showReconDialog();
    });
  };

  Controller.prototype.evacAllFromRecon = function () {
    const sim = this.active(), recon = this._reconBySim[sim.id];
    recon.evac.slice().forEach(e => {
      FIRE_SIM.issueCommand(sim, 'evac', { teamId: e.teamId });
    });
    recon.evac = [];
    this.toast('已下令所有危险区域队伍撤离', 'ok');
    this.showReconDialog(); this.refreshPanels();
  };
  Controller.prototype.recheckAllFromRecon = function () {
    const sim = this.active(), recon = this._reconBySim[sim.id];
    recon.recheck.slice().forEach(e => {
      const r = FIRE_SIM.reconfirmTask(sim, e.teamId);
      if (r.ok) recon.recheck = recon.recheck.filter(q => q.teamId !== e.teamId);
    });
    this.showReconDialog(); this.refreshPanels();
  };
  Controller.prototype.discardQueuedFromRecon = function () {
    this._reconBySim[this.active().id].queued = [];
    this.showReconDialog();
  };
  Controller.prototype.closeRecon = function () {
    $('#dlgRecon').classList.add('hidden');
    this.refreshPanels();
  };

  function FIRE_SIM_COMM_TEXT(type, a, sim) {
    const nodeName = id => (sim.scen.road.nodes[id] || {}).name || id;
    const tgtName = id => (sim.targets.find(t => t.id === id) || {}).name || id;
    const who = a.teamId ? (sim.teams.find(t => t.id === a.teamId) || {}).name + '：' : '';
    switch (type) {
      case 'move': return who + '机动至 ' + nodeName(a.targetNodeId);
      case 'defend': return who + '防护 ' + tgtName(a.targetId);
      case 'drop': return who + '吊桶灭火';
      case 'evac': return who + '立即撤离';
      case 'cancel': return who + '取消任务';
      case 'close_edge': return '封闭道路 ' + a.edge;
      case 'open_edge': return '解封道路 ' + a.edge;
      case 'add_break': return '规划隔离带（' + a.pts.length + ' 格）';
      case 'assign_break': return who + '开设隔离带 ' + a.breakId;
      default: return type;
    }
  }

  global.APP = { Controller, $, $$ };
})(window);
