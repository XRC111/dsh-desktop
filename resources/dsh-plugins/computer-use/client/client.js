/**
 * computer use 的客户端注入 —— 把「正在操作本机」的状态报给外壳。
 *
 * 为什么需要：电脑上的注入工具（key_type / mouse_click …）跑在 dsh 子进程里，
 * 而抢焦点的是外壳的 Electron 窗口。两边必须联动：外壳知道「自动化进行中」，
 * 才好在窗口隐藏时**不把前台抢回去**（实测它约 10 秒会自己抢一次，导致输入落错窗口）。
 *
 * 做法：挂到宿主已有的任务状态通道（app:task-state）旁边，用独立通道上报，
 * 互不影响。拿不到外壳接口就安静跳过 —— 这个注入只做锦上添花，不能拖垮页面。
 */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/computer-use',
  factory: (require) => {
    var exports = {};
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    exports.name = 'dsh-desktop-computer-use';
    exports.inject = [];

    var IDLE_MS = 15000; // 最后一次操作后多久算「结束」

    exports.apply = function (ctx) {
      var bridge = (typeof window !== 'undefined' && window.dshDesktop) || null;
      if (!bridge || typeof bridge.reportComputerUseState !== 'function') {
        // 外壳没暴露（老版本 / 非桌面环境）：什么都不做
        return;
      }

      var timer = 0;
      var lastAction = '';

      function report(active, action) {
        try {
          bridge.reportComputerUseState({ active: active === true, action: action || '' });
        } catch (e) { /* 上报失败不影响页面 */ }

        if (timer) { clearTimeout(timer); timer = 0; }
        if (active) {
          // 自动化不会自己说「结束」，靠空闲超时兜底
          timer = setTimeout(function () {
            try { bridge.reportComputerUseState({ active: false, action: '' }); } catch (e) {}
          }, IDLE_MS);
        }
      }

      // 监听工具调用：宿主把每次工具执行广播出来时，我们标记「进行中」
      // 不同宿主的事件名可能不同，这里做最大兼容：几种常见命名都挂上。
      var events = ctx && ctx.events ? ctx.events : null;
      if (events && typeof events.on === 'function') {
        var names = ['tool/call', 'tool-call', 'tool/execute', 'tool/result'];
        for (var i = 0; i < names.length; i++) {
          try {
            events.on(names[i], function (payload) {
              var name = '';
              if (payload && typeof payload === 'object') {
                name = payload.name || (payload.tool && payload.tool.name) || '';
              }
              // 只关心 computer use 的那几个工具
              if (/^(screen_|mouse_|key_)/.test(String(name))) {
                var act = '';
                if (name === 'key_type') act = '正在输入文本';
                else if (name === 'key_press') act = '正在按键';
                else if (name === 'mouse_click') act = '正在点击';
                else if (name === 'screen_shot') act = '正在截图';
                else if (name === 'screen_elements') act = '正在识别界面元素';
                lastAction = act;
                report(true, act);
              }
            });
          } catch (e) { /* 某个事件名不存在就跳过 */ }
        }
      }
    };

    return exports;
  },
});
