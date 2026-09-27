// 注入到 Harness 页面（main world）：把「任务在不在跑」告诉桌面外壳。
//
// 为什么要从页面里观察：任务状态（正在生成/空闲）只存在于 Harness 的前端运行时，
// 主进程没有任何 API 能拿到它。不改 Harness 源码的前提下，唯一可行的办法是在页面里
// 观察它的表现（页面上会出现「停止生成」这类按钮，以及流式输出的 DOM 变化），
// 然后通过 preload 桥上报给主进程，由主进程驱动托盘与通知。
//
// 判定策略（宁可少报，不可误报——误报会让托盘一直显示「运行中」）：
//   1. 主信号：出现「停止」语义的按钮（生成中才有）；
//   2. 辅助信号：会话区域出现流式光标/加载指示器。
// 两条取或，并做去抖（连续 N 次采样一致才切换），避免 UI 抖动造成状态跳变。
//
// 本脚本由桌面外壳在 dom-ready 时注入，自身幂等。
(() => {
  if (window.__dshDesktopTaskReporter) return;

  const bridge = window.dshDesktop;
  if (!bridge || typeof bridge.reportTaskState !== 'function') return;

  function featureOn(id) {
    try {
      if (typeof bridge.isFeatureEnabled !== 'function') return true;
      return !!bridge.isFeatureEnabled(id);
    } catch (e) { return true; }
  }
  if (!featureOn('trayStatus') && !featureOn('taskNotify')) return;

  // 过了所有前置检查才认领：标记只代表「监听真的装上了」，
  // 开关关掉时保持未认领，下次注入（开关打开后）仍能生效。
  window.__dshDesktopTaskReporter = true;

  // 生成中会出现的按钮文案（中英都给，跟随界面语言）
  const STOP_WORDS = ['停止生成', '停止', 'Stop generating', 'Stop', 'Cancel'];

  function hasStopButton() {
    const btns = document.querySelectorAll('button,[role="button"]');
    for (const b of btns) {
      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).trim();
      if (!label) continue;
      for (const w of STOP_WORDS) {
        // 只在短标签上匹配，避免把正文里的「停止」误当成按钮
        if (label.length <= 12 && label.indexOf(w) !== -1) return true;
      }
    }
    return false;
  }

  function hasStreamingIndicator() {
    // Harness 流式输出时的光标/加载指示（类名带 cursor / streaming / loading 语义）
    return !!document.querySelector(
      '[class*="cursor"],[class*="streaming"],[class*="Streaming"],' +
      '[data-streaming="true"],[class*="thinking"],[class*="Thinking"]',
    );
  }

  let reported = null;
  let streak = 0;
  let pending = null;
  const DEBOUNCE = 3; // 连续 3 次采样一致才切换（采样 1s → 最长 3s 延迟，够快也不抖）

  function sample() {
    const busy = hasStopButton() || hasStreamingIndicator();
    if (busy === pending) streak += 1;
    else { pending = busy; streak = 1; }
    if (streak >= DEBOUNCE && pending !== reported) {
      reported = pending;
      try { bridge.reportTaskState({ running: reported }); } catch (e) { /* 忽略 */ }
    }
  }

  setInterval(sample, 1000);
  // 页面刚打开时立刻采一次，别让托盘停在「未知」
  setTimeout(sample, 400);

  // 页面卸载时告诉主进程「不再是运行中」，避免托盘卡在运行态
  window.addEventListener('beforeunload', () => {
    try { bridge.reportTaskState({ running: false, unloading: true }); } catch (e) { /* 忽略 */ }
  });
})();
