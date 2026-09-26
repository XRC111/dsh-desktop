/**
 * 应用内「更新横幅」（注入 dsh 页面主世界运行）。
 *
 * 1.1.22 起取代系统对话框的 UI：主进程 check() 把发现的新版本放进
 * UpdateState.prompt 推过来，这里负责渲染三种形态——
 *   - phase=available + prompt → 顶部「发现新版本」横幅
 *     （立即更新 / 下载完整安装包 / 跳过此版本 / 关闭；强制更新无跳过无关闭）
 *   - phase=downloading → 进度条
 *   - phase=downloaded → 「更新已就绪」条（立即重启 / 稍后）
 *
 * 与设置页版本卡片（updater.client.js）互不替代：横幅常驻任何页面、
 * 只在有动作可做时出现；卡片提供版本信息与手动检查入口。
 *
 * 实现要点：
 *   - dom-ready 会重复注入 → 必须**幂等**（全局守卫 + 节点按 id 复用）
 *   - 主世界运行：要操作页面 DOM，preload 的隔离世界做不到
 *   - onUpdateState 只推变化、不重放 → 启动时主动 getUpdateState() 拉一次
 *   - 云端 notes 是外部数据 → 一律 textContent，绝不 innerHTML
 *   - 拿不到 API 就安静退出，绝不报错刷屏
 */
(function () {
  if (window.__dshDesktopUpdateBannerInjected) return;
  window.__dshDesktopUpdateBannerInjected = true;

  var api = window.dshDesktop;
  if (!api || typeof api.getUpdateState !== 'function') return; // 外壳没暴露（旧版）

  var TAG = '[dsh-desktop]';
  var STYLE_ID = 'dsh-desktop-banner-style';
  var ROOT_ID = 'dsh-desktop-update-banner';

  function say(m) {
    try {
      console.log(TAG + ' ' + m);
    } catch (e) {}
  }

  // -------------------------------------------------------------------------
  // 样式（暗色卡片，与设置页版本卡片同族配色；浮在页面顶部居中）
  // -------------------------------------------------------------------------
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + ROOT_ID + '{position:fixed;top:10px;left:50%;transform:translate(-50%,-10px);',
      'z-index:2147483600;font:12px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      'background:rgba(24,24,27,.96);color:#e4e4e7;border:1px solid rgba(255,255,255,.14);',
      'border-radius:12px;padding:10px 14px;box-shadow:0 10px 32px rgba(0,0,0,.4);',
      'backdrop-filter:blur(8px);max-width:680px;width:calc(100% - 32px);',
      'opacity:0;visibility:hidden;transition:opacity .18s ease,transform .18s ease,visibility .18s;',
      'user-select:none;pointer-events:none}',
      '#' + ROOT_ID + '.on{opacity:1;visibility:visible;transform:translate(-50%,0);pointer-events:auto}',
      '#' + ROOT_ID + ' .dub-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '#' + ROOT_ID + ' .dub-title{font-weight:600;font-size:13px;opacity:.95}',
      '#' + ROOT_ID + ' .dub-badge{font-size:10px;padding:1px 7px;border-radius:99px;',
      'border:1px solid rgba(255,255,255,.18);opacity:.8}',
      '#' + ROOT_ID + ' .dub-badge.warn{color:#fca5a5;border-color:rgba(252,165,165,.45)}',
      '#' + ROOT_ID + ' .dub-close{margin-left:auto;border:0;background:transparent;color:inherit;',
      'opacity:.55;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px}',
      '#' + ROOT_ID + ' .dub-close:hover{opacity:1;background:rgba(255,255,255,.08)}',
      '#' + ROOT_ID + ' .dub-meta{opacity:.65;font-size:11px;margin-top:2px}',
      '#' + ROOT_ID + ' .dub-notes{margin-top:6px;font-size:11px}',
      '#' + ROOT_ID + ' .dub-notes summary{cursor:pointer;opacity:.7;outline:none}',
      '#' + ROOT_ID + ' .dub-notes pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-word;',
      'font:11px/1.6 inherit;opacity:.85;max-height:180px;overflow:auto;user-select:text}',
      '#' + ROOT_ID + ' .dub-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}',
      '#' + ROOT_ID + ' .dub-btn{border:0;border-radius:7px;padding:5px 12px;cursor:pointer;',
      'background:rgba(127,127,127,.25);color:inherit;font:inherit;font-weight:500}',
      '#' + ROOT_ID + ' .dub-btn:hover{background:rgba(127,127,127,.4)}',
      '#' + ROOT_ID + ' .dub-btn:disabled{opacity:.55;cursor:default}',
      '#' + ROOT_ID + ' .dub-btn.primary{background:#2563eb;color:#fafafa}',
      '#' + ROOT_ID + ' .dub-btn.primary:hover{background:#1d4ed8}',
      /* 下载进度条 */
      '#' + ROOT_ID + ' .dub-progress{display:flex;align-items:center;gap:10px;margin-top:8px}',
      '#' + ROOT_ID + ' .dub-track{flex:1;height:6px;border-radius:3px;',
      'background:rgba(127,127,127,.28);overflow:hidden}',
      '#' + ROOT_ID + ' .dub-fill{height:100%;width:0;border-radius:3px;',
      'background:#2563eb;transition:width .25s ease}',
      '#' + ROOT_ID + ' .dub-pct{font-size:11px;opacity:.75;font-variant-numeric:tabular-nums;min-width:36px}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // -------------------------------------------------------------------------
  // DOM（build 一次，之后全部更新属性/文本）
  // -------------------------------------------------------------------------
  var root = null;
  var titleNode = null; // 标题行容器（含 badge，重建）
  var metaNode = null;
  var notesNode = null;
  var actionsNode = null;
  var progNode = null;
  var fillNode = null;
  var pctNode = null;
  var msgNode = null;

  /** 当前显示着的形态 key：available:<ver> / downloaded:<ver>；用于「稍后」记忆 */
  var shownKey = null;
  /** 用户点过关闭/稍后：同一 key 不再自动弹出，key 变化（新版本/新形态）时重置 */
  var dismissedKey = null;

  function ensureRoot() {
    if (root && document.getElementById(ROOT_ID)) return;
    ensureStyle();
    root = el('div');
    root.id = ROOT_ID;
    titleNode = el('div', 'dub-row');
    metaNode = el('div', 'dub-meta');
    notesNode = el('details', 'dub-notes');
    actionsNode = el('div', 'dub-actions');
    progNode = el('div', 'dub-progress');
    var track = el('div', 'dub-track');
    fillNode = el('div', 'dub-fill');
    pctNode = el('span', 'dub-pct', '0%');
    track.appendChild(fillNode);
    progNode.appendChild(track);
    progNode.appendChild(pctNode);
    msgNode = el('div', 'dub-meta');
    root.appendChild(titleNode);
    root.appendChild(metaNode);
    root.appendChild(notesNode);
    root.appendChild(actionsNode);
    root.appendChild(progNode);
    root.appendChild(msgNode);
    (document.body || document.documentElement).appendChild(root);
  }

  function show(key) {
    ensureRoot();
    shownKey = key;
    root.classList.add('on');
  }

  function hide() {
    shownKey = null;
    if (root) root.classList.remove('on');
  }

  /** 关闭按钮：记 dismissedKey，同形态不再自动弹出 */
  function dismissLater() {
    dismissedKey = shownKey;
    hide();
    say('横幅已暂时收起（' + shownKey + '），状态变化后重新评估');
  }

  /** 清空可变区域（titleRow 重建，notes/actions 内容清空） */
  function resetBody() {
    titleNode.textContent = '';
    metaNode.textContent = '';
    notesNode.textContent = '';
    notesNode.open = false;
    notesNode.style.display = 'none';
    actionsNode.textContent = '';
    progNode.style.display = 'none';
    msgNode.textContent = '';
  }

  function addCloseButton(onClose) {
    var x = el('button', 'dub-close', '\u00d7');
    x.title = '关闭';
    x.addEventListener('click', onClose);
    titleNode.appendChild(x);
  }

  /** 当前进度显示（downloading 态） */
  function renderProgress(state) {
    resetBody();
    titleNode.appendChild(el('span', 'dub-title', '正在更新'));
    if (state.latestVersion) titleNode.appendChild(el('span', 'dub-badge', 'v' + state.latestVersion));
    progNode.style.display = 'flex';
    var p = Math.max(0, Math.min(100, Number(state.percent) || 0));
    fillNode.style.width = p + '%';
    pctNode.textContent = p + '%';
    msgNode.textContent = state.message || '正在下载更新…';
  }

  /**
   * 「发现新版本」横幅。动作按钮按真实可用的通道给：
   *   立即更新 → auto 模式（热更优先，其次运行时/安装包，主进程自选最优）
   *   下载完整安装包 → 仅当同时有热更/运行时与安装包时作为备选出现
   *   跳过此版本 / 关闭 → 强制更新不给
   */
  function renderAvailable(state) {
    var prompt = state.prompt;
    if (!prompt) {
      // 无 prompt（跳过过/仅插件待装/跳过 IPC 刚清空）：横幅收起
      hide();
      return;
    }
    var key = 'available:' + prompt.version;
    if (key === dismissedKey) return; // 用户刚关掉同一个提示
    resetBody();

    titleNode.appendChild(el('span', 'dub-title', '发现新版本'));
    titleNode.appendChild(el('span', 'dub-badge', 'v' + prompt.version));
    if (prompt.mandatory) {
      var b = el('span', 'dub-badge warn', '重要更新');
      b.title = '此版本为强制更新，无法跳过';
      titleNode.appendChild(b);
    }
    if (prompt.skipped) {
      titleNode.appendChild(el('span', 'dub-badge', '此前已跳过'));
    }
    if (!prompt.mandatory) addCloseButton(dismissLater);

    var metaParts = [];
    if (prompt.viaHot) metaParts.push('热更新可用（重启即生效，无需安装程序）');
    if (prompt.rtVersion) metaParts.push('Harness 运行时 ' + prompt.rtVersion);
    if (prompt.installer) metaParts.push('完整安装包可用');
    metaNode.textContent = metaParts.join(' · ');

    if (prompt.notes && String(prompt.notes).trim()) {
      notesNode.style.display = '';
      var summary = el('summary', null, '更新内容');
      var pre = el('pre', null, String(prompt.notes));
      notesNode.appendChild(summary);
      notesNode.appendChild(pre);
    }

    var busy = false;
    function withBusy(btn, fn) {
      btn.addEventListener('click', function () {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        Promise.resolve()
          .then(fn)
          .catch(function (e) {
            say('更新动作失败：' + e);
            busy = false;
            btn.disabled = false;
          });
      });
    }

    var mainLabel = prompt.viaHot
      ? '立即更新（重启生效）'
      : prompt.rtVersion
        ? '立即更新（应用运行时）'
        : '下载完整安装包';
    var btnMain = el('button', 'dub-btn primary', mainLabel);
    withBusy(btnMain, function () {
      return api.installUpdate();
    });
    actionsNode.appendChild(btnMain);

    if ((prompt.viaHot || prompt.rtVersion) && prompt.installer) {
      var btnInstaller = el('button', 'dub-btn', '下载完整安装包');
      withBusy(btnInstaller, function () {
        // 强制安装包通道：下载完成后自动拉起安装程序并退出应用
        return api.installUpdate('installer');
      });
      actionsNode.appendChild(btnInstaller);
    }

    if (!prompt.mandatory) {
      var btnSkip = el('button', 'dub-btn', '跳过此版本');
      withBusy(btnSkip, function () {
        return api.skipUpdate(prompt.version).then(function () {
          dismissedKey = null; // 状态会变（prompt 清空），横幅由 hide() 收起
        });
      });
      actionsNode.appendChild(btnSkip);
    }

    show(key);
  }

  /** 「更新已就绪」条：重启即生效。稍后 = 关闭（下次启动也会自动生效） */
  function renderDownloaded(state) {
    var key = 'downloaded:' + (state.hotVersion || state.runtimeTarget || state.latestVersion || '');
    if (key === dismissedKey) return;
    resetBody();

    titleNode.appendChild(el('span', 'dub-title', '更新已就绪'));
    var what = [];
    if (state.hotReady && state.hotVersion) what.push('外壳 ' + state.hotVersion);
    if (state.runtimeReady && state.runtimeTarget) what.push('运行时 ' + state.runtimeTarget);
    if (state.pluginsReady && state.pluginsTarget) what.push('组件 ' + state.pluginsTarget);
    if (what.length) titleNode.appendChild(el('span', 'dub-badge', what.join(' + ')));
    addCloseButton(dismissLater);

    var btnRestart = el('button', 'dub-btn primary', '立即重启');
    btnRestart.addEventListener('click', function () {
      btnRestart.disabled = true;
      btnRestart.textContent = '正在重启…';
      Promise.resolve(api.restart()).catch(function (e) {
        btnRestart.disabled = false;
        btnRestart.textContent = '立即重启';
        say('重启失败：' + e);
      });
    });
    actionsNode.appendChild(btnRestart);

    msgNode.textContent = state.message || '重启应用（几秒）即可生效，也可以下次启动时自动生效。';
    show(key);
  }

  /** 更新失败：仅当横幅此前正显示着（用户点过更新/看到进度）才打扰 */
  function renderError(state) {
    var wasUpdating =
      shownKey === 'downloading' || (shownKey && shownKey.indexOf('available:') === 0);
    if (!wasUpdating) return;
    resetBody();
    titleNode.appendChild(el('span', 'dub-title', '更新失败'));
    addCloseButton(dismissLater);
    msgNode.textContent = state.message || '更新过程中出现问题。';
    show('error');
  }

  /** 所有更新状态的统一入口 */
  function handleState(state) {
    if (!state) return;
    try {
      switch (state.phase) {
        case 'available':
          renderAvailable(state);
          break;
        case 'downloading':
          renderProgress(state);
          show('downloading');
          break;
        case 'downloaded':
          renderDownloaded(state);
          break;
        case 'error':
          renderError(state);
          break;
        default:
          // idle / checking / up-to-date / disabled：横幅退场
          hide();
      }
    } catch (e) {
      say('渲染横幅失败：' + e);
    }
  }

  function boot() {
    if (!document.body) return false;
    ensureRoot();
    // 订阅先行，拉取兜底（避免漏掉订阅与拉取之间发生的状态变化）
    if (typeof api.onUpdateState === 'function') {
      try {
        api.onUpdateState(function (state) {
          handleState(state);
        });
      } catch (e) {}
    }
    Promise.resolve(api.getUpdateState())
      .then(function (state) {
        handleState(state);
        if (shownKey) say('横幅已显示：' + shownKey);
      })
      .catch(function () {});
    return true;
  }

  if (!boot()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      // body 尚未就绪的极端情况：短暂重试
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (boot() || tries > 50) clearInterval(t);
      }, 200);
    }
  }
})();
