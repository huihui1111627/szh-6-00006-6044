/* 启动：接线顶栏/弹窗/标签页，主时钟循环 */
(function () {
  'use strict';
  const $ = APP.$, $$ = APP.$$;
  const app = new APP.Controller();

  app.layoutViews();
  app.refreshPanels();

  let acc = 0, last = performance.now();
  function loop(now) {
    const dtMs = now - last; last = now;
    if (app.playing) {
      acc += dtMs * app.speed;
      // 固定 125ms 一个模拟步；speed 档对累积时间做倍率，单帧最多补 4 步
      let steps = 0;
      while (acc >= 125 && steps < 4) {
        app.tick();
        acc -= 125;
        steps++;
      }
      if (steps >= 4) acc = 0;
    }
    app.renderViews();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 顶栏
  $('#btnPlay').onclick = () => {
    app.playing = !app.playing; app.autoPaused = false;
    $('#btnPlay').textContent = app.playing ? '⏸ 暂停' : '▶ 播放';
  };
  $('#btnStep').onclick = () => { app.playing = false; $('#btnPlay').textContent = '▶ 播放'; app.tick(); };
  $('#selSpeed').onchange = e => { app.speed = +e.target.value; };
  $('#btnReset').onclick = () => app.reset();

  $('#btnBreak').onclick = () => app.setMode('break');
  $('#btnClosure').onclick = () => app.setMode('closure');

  $('#btnFork').onclick = () => app.forkStrategy();
  $('#btnCompare').onclick = () => {
    app.compare = !app.compare;
    $('#btnCompare').classList.toggle('primary', app.compare);
    if (!app.compare && app.sims.length > 1) app.compare = true;
    app.layoutViews(); app.refreshPanels();
  };

  // 风向
  $('#btnWind').onclick = () => app.openWind();
  $('#windDir').oninput = () => app.updateWindDialog();
  $('#windSpd').oninput = () => app.updateWindDialog();
  $$('#dlgWind .wind-presets button').forEach(b => b.onclick = () => {
    $('#windDir').value = b.dataset.dir; app.updateWindDialog();
  });
  $('#windCancel').onclick = () => $('#dlgWind').classList.add('hidden');
  $('#windApply').onclick = () => app.applyWind();

  // 通信
  $('#btnComm').onclick = () => app.goCommDown();
  $('#btnCommRestore').onclick = () => app.goCommRestore();

  // 对账弹窗
  $('#reconEvacAll').onclick = () => app.evacAllFromRecon();
  $('#reconRecheckAll').onclick = () => app.recheckAllFromRecon();
  $('#reconDiscardQueue').onclick = () => app.discardQueuedFromRecon();
  $('#reconClose').onclick = () => app.closeRecon();

  // 标签页
  $$('.tabs .tab').forEach(t => t.onclick = () => {
    $$('.tabs .tab').forEach(q => q.classList.remove('active'));
    t.classList.add('active');
    $$('.tab-body').forEach(b => b.classList.toggle('hidden', b.dataset.tab !== t.dataset.tab));
  });

  // 点空白关闭气泡
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $('#mapPopup').classList.add('hidden');
      $('#dlgWind').classList.add('hidden');
      if (app.mode !== 'default') app.setMode('default');
    }
    if (e.key === ' ') { e.preventDefault(); $('#btnPlay').click(); }
  });

  // 新用户引导提示
  setTimeout(() => app.toast('操作：选中队伍 → 点道路节点改进入方向；✂ 拖画隔离带；🚧 封路；📵 可演练通信中断', ''), 600);
})();
