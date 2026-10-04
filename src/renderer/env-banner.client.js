/**
 * 环境依赖告警横幅（注入 dsh 页面主世界运行）。
 *
 * 与更新横幅（update-banner.client.js）同族，但只做一件事：把外壳体检出的
 * **环境不满足**项显示出来，并给出可操作的修法。
 *
 * 目前唯一来源是 PowerShell 版本过低（见 src/main/env-check.ts 的长注释）：
 * Windows 7 出厂自带 PowerShell 2.0，而 Harness 的命令执行器前导用了
 * [Type]::new(...)（PowerShell 5.0 语法），结果是**每条命令都失败且没有输出**，
 * 用户完全不知道原因。这条横幅就是那个「原因」。
 *
 * 实现要点（与更新横幅一致，别绕开）：
 *   - dom-ready 会重复注入 → 必须**幂等**（全局守卫 + 按 id 复用节点）
 *   - 主世界运行：要操作页面 DOM，preload 的隔离世界做不到
 *   - 文案里的路径/版本都来自本机探测，但一律 textContent，绝不 innerHTML
 *   - 拿不到 API 就安静退出，绝不报错刷屏
 *   - 用户点「不再提示」后记在 localStorage，不再出现（同一台机器上问题不会自己好，
 *     但用户可能只是暂时不想看）
 */
(function () {
  if (window.__dshDesktopEnvBannerInjected) return;
  window.__dshDesktopEnvBannerInjected = true;

  var api = window.dshDesktop;
  if (!api || typeof api.getEnvWarnings !== 'function') return; // 外壳没暴露（旧版）

  var TAG = '[dsh-desktop]';
  var STYLE_ID = 'dsh-desktop-env-style';
  var ROOT_ID = 'dsh-desktop-env-banner';
  var MUTE_KEY = 'dshDesktop.envBannerMuted';

  function say(m) {
    try {
      console.log(TAG + ' ' + m);
    } catch (e) {}
  }

  function muted() {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch (e) {
      return false;
    }
  }

  function setMuted() {
    try {
      localStorage.setItem(MUTE_KEY, '1');
    } catch (e) {}
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + ROOT_ID + '{position:fixed;top:10px;left:50%;transform:translate(-50%,-10px);',
      'z-index:2147483600;font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'background:rgba(24,24,27,.96);color:#e4e4e7;border:1px solid rgba(255,196,120,.42);',
      'border-radius:12px;padding:10px 14px;box-shadow:0 10px 32px rgba(0,0,0,.4);',
      'backdrop-filter:blur(8px);max-width:680px;width:calc(100% - 32px);',
      'opacity:0;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility .18s;',
      'user-select:none;pointer-events:none}',
      '#' + ROOT_ID + '.on{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto}',
      '#' + ROOT_ID + ' .deb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '#' + ROOT_ID + ' .deb-title{font-weight:600;font-size:13px;opacity:.95}',
      '#' + ROOT_ID + ' .deb-close{margin-left:auto;border:0;background:transparent;color:inherit;',
      'opacity:.55;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px}',
      '#' + ROOT_ID + ' .deb-close:hover{opacity:1;background:rgba(255,255,255,.08)}',
      '#' + ROOT_ID + ' .deb-detail{opacity:.72;font-size:11px;margin-top:3px;user-select:text}',
      '#' + ROOT_ID + ' .deb-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}',
      '#' + ROOT_ID + ' .deb-btn{border:0;border-radius:7px;padding:5px 12px;cursor:pointer;',
      'background:rgba(127,127,127,.25);color:inherit;font:inherit;font-weight:500;text-decoration:none}',
      '#' + ROOT_ID + ' .deb-btn:hover{background:rgba(127,127,127,.4)}',
      '#' + ROOT_ID + ' .deb-btn.primary{background:rgba(96,165,250,.28)}',
      '#' + ROOT_ID + ' .deb-btn.primary:hover{background:rgba(96,165,250,.42)}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureRoot() {
    var el = document.getElementById(ROOT_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ROOT_ID;
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  /** 只渲染第一条：真出了版本问题，一台机器上不会同时有两种原因 */
  function render(w) {
    var root = ensureRoot();
    root.textContent = '';

    var row = document.createElement('div');
    row.className = 'deb-row';

    var title = document.createElement('div');
    title.className = 'deb-title';
    title.textContent = w.title;
    row.appendChild(title);

    var close = document.createElement('button');
    close.className = 'deb-close';
    close.type = 'button';
    close.title = '关闭';
    close.textContent = '\u00d7';
    close.addEventListener('click', function () {
      setMuted();
      root.classList.remove('on');
    });
    row.appendChild(close);
    root.appendChild(row);

    var detail = document.createElement('div');
    detail.className = 'deb-detail';
    detail.textContent = w.detail;
    root.appendChild(detail);

    var actions = document.createElement('div');
    actions.className = 'deb-actions';

    if (w.url) {
      var a = document.createElement('a');
      a.className = 'deb-btn primary';
      a.href = w.url;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      a.textContent = '打开官方下载页';
      actions.appendChild(a);
    }

    var copyBtn = document.createElement('button');
    copyBtn.className = 'deb-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制修法';
    copyBtn.addEventListener('click', function () {
      try {
        navigator.clipboard.writeText(w.fix);
        copyBtn.textContent = '已复制';
        setTimeout(function () {
          copyBtn.textContent = '复制修法';
        }, 1500);
      } catch (e) {}
    });
    actions.appendChild(copyBtn);

    if (typeof api.copyDiagnostics === 'function') {
      var diagBtn = document.createElement('button');
      diagBtn.className = 'deb-btn';
      diagBtn.type = 'button';
      diagBtn.textContent = '复制诊断信息';
      diagBtn.addEventListener('click', function () {
        try {
          api.copyDiagnostics();
          diagBtn.textContent = '已复制';
          setTimeout(function () {
            diagBtn.textContent = '复制诊断信息';
          }, 1500);
        } catch (e) {}
      });
      actions.appendChild(diagBtn);
    }

    root.appendChild(actions);

    var fix = document.createElement('div');
    fix.className = 'deb-detail';
    fix.textContent = w.fix;
    root.appendChild(fix);

    root.classList.add('on');
  }

  function run() {
    if (muted()) return;
    Promise.resolve(api.getEnvWarnings())
      .then(function (list) {
        if (!Array.isArray(list) || list.length === 0) return;
        if (!document.body) {
          // 页面还没铺好 → 等下一帧再试（只重试有限次，避免空转）
          var tries = 0;
          var timer = setInterval(function () {
            tries++;
            if (document.body || tries > 40) {
              clearInterval(timer);
              if (document.body) render(list[0]);
            }
          }, 250);
          return;
        }
        render(list[0]);
      })
      .catch(function (err) {
        say('环境体检读取失败：' + err);
      });
  }

  // 注入时机可能早于 body 就绪，也可能晚于（dom-ready 会重复触发）→ 幂等且自带重试
  run();
})();
