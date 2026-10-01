// 注入到 Harness 页面（main world）：把从系统拖进来的文件变成对话附件。
//
// 为什么要自己接：Harness 的附件入口只有一个隐藏 <input type="file">，
// 页面上没有可插拔的「接收拖放」接缝，而 Chromium 默认会把拖进窗口的文件
// 直接导航过去（整个页面被那个文件替换掉）——这正是用户看到的「拖进去就白屏」。
//
// 做法与 attachment-picker.client.js 完全一致，只是入口从「点按钮」换成「拖放」：
//   dragover/drop 阻止默认导航 → 拿到 File 对象 → 塞回那个隐藏 input 并派发 change。
// Harness 的 onPickFiles 原样收到标准 FileList，上传链路零感知。
//
// 注意：从资源管理器拖进来的是真 File 对象（有 path 属性，Chromium 直接给内容），
// 不需要走 preload 读盘；只有应用内选择窗口才需要 attachmentRead。
//
// 本脚本由桌面外壳在 dom-ready 时注入（src/main/boot.ts），自身幂等。
(() => {
  // 重复注入时先撤掉上一次的监听，保证开关「关掉再打开」不会叠加多份
  // （dom-ready 与设置页切换都会触发注入）。
  if (typeof window.__dshDesktopDragDropTeardown === 'function') {
    try { window.__dshDesktopDragDropTeardown(); } catch (e) { /* 忽略 */ }
  }

  const bridge = window.dshDesktop;
  // ⚠️ 拿不到开关时按「关」处理（不是按「开」）。
  // 本垫片与官方内置拖放（dsh-client-ui-attachment）**冲突**：它用捕获阶段 +
  // stopPropagation，会掐断事件让官方收不到。所以「不确定」时必须选不装监听，
  // 否则一旦桥不可用，就会把官方拖放压掉。
  if (!bridge || typeof bridge.isFeatureEnabled !== 'function') return;
  let on = false;
  try { on = !!bridge.isFeatureEnabled('dragDropAttach'); } catch (e) { on = false; }
  if (!on) return;

  // 过了所有前置检查才认领（语义：监听确实装上了）
  window.__dshDesktopDragDrop = true;

  /** 找到 Harness 那个隐藏的 file input（添加附件按钮点它） */
  function findFileInput() {
    const inputs = document.querySelectorAll('input[type="file"]');
    for (const input of inputs) return input; // 页面上只有一个附件入口
    return null;
  }

  /** 拖放中的视觉反馈：整窗描边，不遮挡页面交互 */
  let styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent =
      '.dshdd-veil{position:fixed;inset:0;z-index:2147483500;pointer-events:none;' +
      'border:2px dashed var(--dsw-alias-button-info-fill,#3370ff);border-radius:10px;' +
      'background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#3370ff) 6%,transparent);' +
      'display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;' +
      'font:500 13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;' +
      'color:var(--dsw-alias-label-primary,#1f2329);transition:opacity .12s;}';
    document.head.appendChild(styleEl);
  }

  let veil = null;
  let depth = 0; // dragenter/dragleave 会在子元素间反复触发，用计数判定真正离开

  function showVeil(label) {
    ensureStyle();
    if (!veil) {
      veil = document.createElement('div');
      veil.className = 'dshdd-veil';
      document.body.appendChild(veil);
    }
    veil.textContent = label;
  }

  function hideVeil() {
    depth = 0;
    if (veil) { veil.remove(); veil = null; }
  }

  /** 只处理「文件」拖放，不干扰页面内部的元素拖拽（例如拖动会话排序） */
  function hasFiles(e) {
    const dt = e.dataTransfer;
    if (!dt) return false;
    if (dt.types && Array.prototype.indexOf.call(dt.types, 'Files') !== -1) return true;
    return false;
  }

  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    showVeil('松开即添加为附件');
  }

  function onDragOver(e) {
    if (!hasFiles(e)) return;
    // 必须阻止默认：否则 Chromium 会用这个文件导航，页面被替换掉
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    depth -= 1;
    if (depth <= 0) hideVeil();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') hideVeil();
  }

  document.addEventListener('dragenter', onDragEnter, true);
  document.addEventListener('dragover', onDragOver, true);
  document.addEventListener('dragleave', onDragLeave, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', hideVeil);

  // 供主进程在设置页切换开关时调用（撤监听 + 收遮罩），让开关免重启生效
  window.__dshDesktopDragDropTeardown = function () {
    hideVeil();
    document.removeEventListener('dragenter', onDragEnter, true);
    document.removeEventListener('dragover', onDragOver, true);
    document.removeEventListener('dragleave', onDragLeave, true);
    document.removeEventListener('drop', onDrop, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', hideVeil);
    if (styleEl) { styleEl.remove(); styleEl = null; }
    window.__dshDesktopDragDrop = false;
    window.__dshDesktopDragDropTeardown = null;
  };

  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    hideVeil();

    const input = findFileInput();
    if (!input) {
      console.warn('[dsh-desktop] 页面上找不到附件输入框，已忽略本次拖放');
      return;
    }

    const files = e.dataTransfer ? Array.prototype.slice.call(e.dataTransfer.files || []) : [];
    if (files.length === 0) return;

    try {
      const dt = new DataTransfer();
      // multiple 为 false 时只取第一个，与原生 input 的语义保持一致
      const take = input.multiple ? files : files.slice(0, 1);
      for (const f of take) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (err) {
      console.warn('[dsh-desktop] 拖放附件失败：' + String(err));
    }
  }

  document.addEventListener('drop', onDrop, true);
})();
