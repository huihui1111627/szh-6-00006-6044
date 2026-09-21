/* strategies.js — 相同起火条件下的三套并行推演策略脚本 */
window.FS = window.FS || {};
(function (FS) {
  'use strict';

  FS.strategies = [
    {
      id: 'A', name: '策略A · 地面分段阻截',
      desc: '三支地面队伍在火场东侧 x=30 一线分段并行开设隔离带，直升机压制火头。风向突变后未做预案调整，南侧暴露。',
      script: [
        { t: 2, fn: (s) => FS.planFirebreak(s, 'U3', 30, 4, 30, 16) },
        { t: 2, fn: (s) => FS.planFirebreak(s, 'U1', 30, 17, 30, 28) },
        { t: 2, fn: (s) => FS.planFirebreak(s, 'U2', 30, 29, 30, 40) },
        { t: 2, fn: (s) => s.issueOrder('H1', { kind: 'patrol', fx: 20, fy: 16 }) },
      ],
    },
    {
      id: 'B', name: '策略B · 空地协同封控',
      desc: '直升机全程压制火头，一三队西侧设障、二队南侧迂回扑打；提前封闭北线盘山路，风向突变后迅速在南侧补设隔离带。',
      script: [
        { t: 2,   fn: (s) => s.issueOrder('H1', { kind: 'patrol', fx: 20, fy: 16 }) },
        { t: 2,   fn: (s) => FS.planFirebreak(s, 'U3', 28, 6, 28, 18) },
        { t: 2,   fn: (s) => FS.planFirebreak(s, 'U1', 28, 19, 28, 30) },
        { t: 8,   fn: (s) => s.issueOrder('U2', { kind: 'suppress', x: 20, y: 24 }) },
        { t: 100, fn: (s) => s.closeRoad(2) },
        { t: 155, fn: (s) => FS.planFirebreak(s, 'U1', 12, 30, 34, 30) },
        { t: 155, fn: (s) => s.issueOrder('U2', { kind: 'suppress', x: 22, y: 28 }) },
      ],
    },
    {
      id: 'C', name: '策略C · 重点目标保卫',
      desc: '放弃正面硬拼，围绕油库与通信站/村庄方向开设保卫隔离带，直升机重点防卫保护目标，三队迟滞火头后撤离。',
      script: [
        { t: 2,   fn: (s) => FS.planFirebreak(s, 'U1', 10, 34, 26, 34) },
        { t: 2,   fn: (s) => FS.planFirebreak(s, 'U2', 36, 2, 36, 20) },
        { t: 8,   fn: (s) => s.issueOrder('U3', { kind: 'suppress', x: 22, y: 16 }) },
        { t: 2,   fn: (s) => s.issueOrder('H1', { kind: 'patrol', fx: 26, fy: 12 }) },
        { t: 160, fn: (s) => s.issueOrder('U3', { kind: 'evacuate' }) },
      ],
    },
  ];
})(window.FS);
