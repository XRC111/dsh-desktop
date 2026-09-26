// 注入到 Harness 页面（main world）的应用内文件选择窗口。
//
// 为什么需要它：Harness「添加附件」按钮硬编码调用隐藏 <input type="file"> 的
// click()（弹 Chromium 原生系统对话框），且不经过任何可插拔的选择器接缝；
// 唯一不碰 Harness 源码的切入方式就是拦截这次 click 并自绘窗口。
//
// 外观：1:1 复刻 Harness 自带的目录浏览窗口（dsh-client-ui-directory-picker-browse，
// figma Harness 813-23126 family）——直接复用页面上的 --dsw-alias-* 设计令牌与
// 同样的类名结构（dialog 680×500、header(title+crumbBar)、Miller 双栏视图、
// footerBar），深浅色随页面令牌自动切换。
//
// 数据流：preload 暴露 dshDesktop.attachmentList / attachmentRead（主进程列目录
// 与读文件）；确认时 new File + DataTransfer 塞回 input.files 并派发 change，
// Harness 的 onPickFiles 原样收到标准 FileList，上传链路零感知。
//
// 本脚本运行在被注入页面的主世界（preload 隔离世界改不了页面原型链），
// 由桌面外壳在 dom-ready 时注入（src/main/attachment-picker.ts），自身幂等。
(() => {
  if (window.__dshDesktopAttachmentPicker) return;
  window.__dshDesktopAttachmentPicker = true;

  const bridge = window.dshDesktop;
  if (!bridge || typeof bridge.attachmentList !== 'function' || typeof bridge.attachmentRead !== 'function') {
    return; // preload 未就绪或旧版外壳：保持原生对话框
  }

  const COMPUTER = '此电脑';
  const HOME_LABEL = '主目录';
  const MAX_ROW = 2000;

  // ── 样式：复刻 DirectoryBrowser.module.css，全部走页面级 --dsw-alias-* 令牌 ──
  // 类名前缀 dshap-，映射关系与原模块一一对应（dialog/header/crumbBar/millerRow/…）。
  const CSS = `
.dshap-backdrop{position:fixed;inset:0;z-index:2147483600;background:rgba(0,0,0,.45);
  display:flex;align-items:center;justify-content:center;
  font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;}
.dshap-dialog{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  gap:0;width:min(680px,100%);height:min(500px,calc(100dvh - 32px));padding:0;
  display:flex;flex-direction:column;border-radius:14px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2,#fff);
  border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  box-shadow:0 18px 60px rgba(0,0,0,.30);color:var(--dsw-alias-label-primary,#1f2329);}
.dshap-header{border-bottom:.5px solid var(--dsw-alias-border-l3);flex-direction:column;
  flex:none;gap:8px;padding:16px 14px 8px 24px;display:flex;}
.dshap-title{min-height:28px;color:var(--dsw-alias-label-primary);align-items:flex-end;
  margin:0;font-size:16px;font-weight:510;line-height:24px;display:flex;}
.dshap-crumbBar{box-sizing:border-box;border:1px solid #0000;border-radius:8px;
  align-items:center;gap:4px;min-height:24px;margin-left:-9px;padding:0 8px;display:flex;}
.dshap-crumbBar:hover,.dshap-crumbBar:focus-within{border-color:var(--dsw-alias-border-l2);}
.dshap-crumbTrail{scrollbar-width:none;flex:0 auto;align-items:center;gap:4px;min-width:0;
  display:flex;overflow-x:auto;}
.dshap-crumbTrail::-webkit-scrollbar{display:none;}
.dshap-crumb{text-overflow:ellipsis;white-space:nowrap;max-width:160px;
  color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;
  padding:0;font-size:13px;font-weight:500;line-height:20px;overflow:hidden;flex:none;}
.dshap-crumb:hover{color:var(--dsw-alias-label-primary);}
.dshap-crumb.active{color:var(--dsw-alias-label-primary);}
.dshap-crumbChevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;}
.dshap-crumbEditZone{cursor:text;background:0 0;border:none;outline:none;flex:1 0 34px;
  justify-content:flex-end;align-items:center;min-width:34px;height:22px;padding:0;display:flex;}
.dshap-crumbEditGlyph{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;}
.dshap-crumbEditZone:hover .dshap-crumbEditGlyph,.dshap-crumbEditZone:focus-visible .dshap-crumbEditGlyph{
  color:var(--dsw-alias-label-primary);}
.dshap-pathInput{flex:1;min-width:0;height:22px;border:none;outline:none;background:transparent;
  color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;padding:0;}
.dshap-millerRow{scrollbar-width:none;flex:1 1 0;align-items:stretch;gap:12px;min-height:0;
  display:flex;overflow-x:auto;}
.dshap-millerRow::-webkit-scrollbar{display:none;}
.dshap-column{flex:1 1 0;gap:2px;min-width:256px;padding:8px 8px 8px 12px;display:flex;
  flex-direction:column;overflow-y:auto;scrollbar-width:thin;}
.dshap-divider{background:var(--dsw-alias-border-l3);flex:none;width:.5px;}
.dshap-row{cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;
  align-items:center;gap:6px;width:100%;height:28px;padding:4px;display:flex;text-align:left;
  font-family:inherit;}
.dshap-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshap-row.dshap-rowSelected,.dshap-row.dshap-rowSelected:hover{
  background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));}
.dshap-row:focus-visible{outline:2px solid var(--dsw-alias-border-focus,var(--dsw-alias-button-info-fill,#3370ff));
  outline-offset:-2px;}
.dshap-rowCheck{flex:none;width:16px;height:16px;border-radius:4px;
  border:1.5px solid var(--dsw-alias-border-l2);display:none;
  align-items:center;justify-content:center;color:transparent;}
.dshap-multi .dshap-rowCheck{display:inline-flex;}
.dshap-row.dshap-rowSelected .dshap-rowCheck{background:var(--dsw-alias-button-info-fill);
  border-color:var(--dsw-alias-button-info-fill);color:#fff;}
.dshap-rowIcon{color:var(--dsw-alias-label-secondary);flex:none;display:inline-flex;}
.dshap-row.dshap-rowSelected .dshap-rowIcon{color:var(--dsw-alias-button-info-fill);}
.dshap-rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;
  color:var(--dsw-alias-label-primary);flex:1 1 0;font-size:13px;font-weight:500;
  line-height:20px;overflow:hidden;}
.dshap-rowSize{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;
  font-weight:400;line-height:18px;}
.dshap-rowChevron{color:var(--dsw-alias-label-tertiary);flex:none;display:inline-flex;}
.dshap-status,.dshap-error{padding:4px 4px;font-size:12px;line-height:18px;}
.dshap-status{color:var(--dsw-alias-label-secondary);}
.dshap-error{color:var(--dsw-alias-state-error-primary);}
.dshap-loadingFloat{background:var(--dsw-alias-bg-layer-2,#fff);
  color:var(--dsw-alias-label-secondary);padding:2px 8px;position:absolute;bottom:8px;right:16px;
  font-size:12px;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.15);}
.dshap-footerBar{border-top:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap;flex:none;
  align-items:center;gap:8px;padding:12px 24px;display:flex;}
.dshap-footerGap{flex:1 1 0;}
.dshap-footerStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshap-footerStatus.err{color:var(--dsw-alias-state-error-primary);}
.dshap-btn{min-width:72px;height:32px;padding:0 14px;border-radius:8px;cursor:pointer;
  font-size:13px;font-weight:500;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-primary);}
.dshap-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dshap-btn:disabled{cursor:not-allowed;}
.dshap-btn.primary{background:var(--dsw-alias-label-primary,#1f2329);
  border-color:var(--dsw-alias-label-primary,#1f2329);
  color:var(--dsw-alias-bg-layer-2,#fff);font-weight:500;}
.dshap-btn.primary:hover{opacity:.88;}
.dshap-btn.primary:disabled{opacity:.35;cursor:not-allowed;}
.dshap-toggle{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;
  background:0 0;border:none;align-items:center;gap:4px;padding:0;font-size:13px;
  font-weight:500;line-height:20px;display:inline-flex;font-family:inherit;}
.dshap-toggle:hover{color:var(--dsw-alias-label-primary);}
.dshap-toggle.dshap-toggleActive{color:var(--dshap-label,var(--dsw-alias-label-primary));}
.dshap-empty{padding:32px;text-align:center;color:var(--dsw-alias-label-tertiary);}
`;

  // 与 Harness UI primitives 同款的 16px 线性图标（currentColor）
  const ICONS = {
    folder:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M1.75 4.2c0-.8.65-1.45 1.45-1.45h2.9c.43 0 .84.2 1.1.55l.65.85h5c.8 0 1.45.65 1.45 1.45v6.2c0 .8-.65 1.45-1.45 1.45H3.2c-.8 0-1.45-.65-1.45-1.45V4.2Z" stroke="currentColor" stroke-width="1.2"/></svg>',
    file:
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 2.7c0-.53.43-.95.95-.95h4.35L12.5 5.4v7.9c0 .53-.43.95-.95.95H4.45a.95.95 0 0 1-.95-.95V2.7Z" stroke="currentColor" stroke-width="1.2"/><path d="M8.6 1.9v3.4c0 .4.32.7.7.7h3" stroke="currentColor" stroke-width="1.2"/></svg>',
    chevron:
      '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pencil:
      '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M9.3 2.2a1.4 1.4 0 0 1 2 2l-6.4 6.4-2.6.6.6-2.6 6.4-6.4Z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
    check:
      '<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M1.8 5.2 4 7.4l4.2-4.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ── 工具 ────────────────────────────────────────────────────────────────
  let styleEl = null;
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);
  }

  function fmtSize(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return (i === 0 ? String(v) : v.toFixed(1)) + ' ' + units[i];
  }

  function acceptExts(accept) {
    if (!accept) return null;
    const exts = accept
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^\.[a-z0-9]+$/.test(s));
    return exts.length > 0 ? exts : null;
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function svg(parent, name, cls) {
    const span = el('span', cls);
    span.innerHTML = ICONS[name];
    parent.appendChild(span);
    return span;
  }

  function filterEntries(entries, exts) {
    let list = entries;
    if (!ctx.showHidden) list = list.filter((e) => !e.name.startsWith('.'));
    if (exts) list = list.filter((e) => e.kind === 'dir' || exts.includes(extOf(e.name)));
    return list;
  }

  // ── 窗口状态 ────────────────────────────────────────────────────────────
  // levels：Miller 链。levels[i].listing 是第 i 层目录数据；levels[i].selected
  // 记录该层被选中的目录行（右栏即它的子层）。levels.length===1 时单栏全宽，
  // 否则渲染最后两层（与 browse 的「选中即分栏」一致）。
  let ctx = null;

  function closePicker() {
    if (ctx) {
      ctx.backdrop.remove();
      document.removeEventListener('keydown', ctx.onKey, true);
      ctx = null;
    }
  }

  function currentLevel() {
    return ctx.levels[ctx.levels.length - 1];
  }

  function setLoading(on) {
    if (!ctx) return;
    if (on) {
      if (!ctx.loadingFloat) {
        ctx.loadingFloat = el('div', 'dshap-loadingFloat', '加载中…');
        ctx.dialog.appendChild(ctx.loadingFloat);
      }
    } else if (ctx.loadingFloat) {
      ctx.loadingFloat.remove();
      ctx.loadingFloat = null;
    }
  }

  function setStatus(text, isErr) {
    if (!ctx) return;
    ctx.footerStatus.textContent = text || '';
    ctx.footerStatus.classList.toggle('err', !!isErr);
    ctx.okBtn.textContent = ctx.multi && ctx.selected.size > 0 ? `打开（${ctx.selected.size}）` : '打开';
    ctx.okBtn.disabled = ctx.selected.size === 0;
  }

  /** 渲染整个 Miller 区（最后两层）。 */
  function renderMiller() {
    ctx.millerRow.textContent = '';
    const view = ctx.levels.slice(-2);
    view.forEach((level, idx) => {
      if (idx === 1) ctx.millerRow.appendChild(el('div', 'dshap-divider'));
      ctx.millerRow.appendChild(renderColumn(level, idx === view.length - 1));
    });
  }

  function renderColumn(level, isCurrent) {
    const col = el('div', 'dshap-column');
    const entries = filterEntries(level.listing.entries || [], ctx.exts).slice(0, MAX_ROW);
    if (entries.length === 0) {
      col.appendChild(el('div', 'dshap-empty', '此目录为空'));
      return col;
    }
    for (const entry of entries) {
      const row = el('button', 'dshap-row');
      row.type = 'button';
      const selectedHere =
        (isCurrent && ctx.selected.has(entry.path)) || level.selected === entry.path;
      if (selectedHere) row.classList.add('dshap-rowSelected');
      // 多选模式的勾选框（仅文件）
      const check = el('span', 'dshap-rowCheck');
      check.innerHTML = ICONS.check;
      row.appendChild(check);
      svg(row, entry.kind === 'dir' ? 'folder' : 'file', 'dshap-rowIcon');
      row.appendChild(el('span', 'dshap-rowName', entry.name));
      if (entry.kind === 'file') {
        row.appendChild(el('span', 'dshap-rowSize', fmtSize(entry.size)));
      } else {
        svg(row, 'chevron', 'dshap-rowChevron');
      }

      row.addEventListener('click', () => onRowClick(level, entry, isCurrent));
      row.addEventListener('dblclick', () => {
        // 双击文件 = 立即确认（与原生对话框习惯一致）
        if (entry.kind === 'file') {
          if (!ctx.multi) {
            ctx.selected.clear();
            ctx.selected.set(entry.path, entry);
          } else if (!ctx.selected.has(entry.path)) {
            ctx.selected.set(entry.path, entry);
          }
          void commit();
        } else {
          void enterDir(level, entry.path);
        }
      });
      col.appendChild(row);
    }
    return col;
  }

  function onRowClick(level, entry, isCurrent) {
    if (entry.kind === 'dir') {
      void enterDir(level, entry.path);
      return;
    }
    // 文件行
    if (ctx.multi) {
      if (ctx.selected.has(entry.path)) ctx.selected.delete(entry.path);
      else ctx.selected.set(entry.path, entry);
      setStatus(`已选 ${ctx.selected.size} 个文件`);
    } else {
      ctx.selected.clear();
      ctx.selected.set(entry.path, entry);
      setStatus(entry.name);
    }
    renderMiller();
  }

  /** 进入某层目录（可能来自左栏行点击 / 右栏行点击 / 面包屑 / 路径输入）。 */
  async function enterDir(level, targetPath) {
    // 同层重复点击忽略
    const cur = currentLevel();
    if (cur && cur.listing.path === targetPath) return;
    setLoading(true);
    try {
      // a) 点击当前层的子目录：选中该行并推入新层（Miller 右移）
      if (level && level.listing.path !== targetPath) {
        const child = (level.listing.entries || []).find(
          (e) => e.path === targetPath && e.kind === 'dir',
        );
        if (child && ctx.levels.includes(level)) {
          level.selected = targetPath;
          const idx = ctx.levels.indexOf(level);
          ctx.levels = ctx.levels.slice(0, idx + 1); // 丢弃更深的旧层
          const listing = await bridge.attachmentList(targetPath);
          if (!ctx) return;
          ctx.levels.push({ listing, selected: null });
          renderMiller();
          renderCrumbs();
          return;
        }
      }
      // b) 面包屑/路径跳转：若链中已有该层则回退到它
      const existing = ctx.levels.find((l) => l.listing.path === targetPath);
      if (existing) {
        const idx = ctx.levels.indexOf(existing);
        ctx.levels = ctx.levels.slice(0, idx + 1);
        renderMiller();
        renderCrumbs();
        return;
      }
      // c) 全新跳转：加载目标；能拿到父层就摆成 [父, 目标] 双栏（与 browse 落地一致）
      const listing = await bridge.attachmentList(targetPath);
      if (!ctx) return;
      const nextLevels = [];
      if (listing.crumbs && listing.crumbs.length >= 2) {
        const parentCrumb = listing.crumbs[listing.crumbs.length - 2];
        if (parentCrumb && parentCrumb.path !== listing.path) {
          try {
            const parentListing = await bridge.attachmentList(parentCrumb.path);
            if (!ctx) return;
            nextLevels.push({ listing: parentListing, selected: listing.path });
          } catch {
            /* 父层读不到就单栏落地 */
          }
        }
      }
      nextLevels.push({ listing, selected: null });
      ctx.levels = nextLevels;
      renderMiller();
      renderCrumbs();
    } catch (err) {
      setStatus(`无法打开：${String((err && err.message) || err)}`, true);
    } finally {
      setLoading(false);
    }
  }

  function renderCrumbs() {
    const level = currentLevel();
    ctx.crumbTrail.textContent = '';
    const crumbs = (level.listing.crumbs || []).slice();
    crumbs.forEach((crumb, i) => {
      if (i > 0) svg(ctx.crumbTrail, 'chevron', 'dshap-crumbChevron');
      const isLast = i === crumbs.length - 1;
      const btn = el('button', 'dshap-crumb' + (isLast ? ' active' : ''), crumb.name);
      btn.type = 'button';
      btn.title = crumb.path === COMPUTER ? COMPUTER : crumb.path;
      btn.addEventListener('click', () => {
        if (!isLast) void enterDir(null, crumb.path);
      });
      ctx.crumbTrail.appendChild(btn);
    });
  }

  /** crumbBar 的「点击编辑路径」区：进入输入态，Enter 提交。 */
  function startPathEdit() {
    const level = currentLevel();
    if (!level || ctx.editing) return;
    ctx.editing = true;
    ctx.crumbTrail.style.display = 'none';
    ctx.editZone.textContent = '';
    const input = el('input', 'dshap-pathInput');
    input.value = level.listing.path === COMPUTER ? '' : level.listing.path;
    input.placeholder = COMPUTER;
    input.spellcheck = false;
    const finish = () => {
      ctx.editing = false;
      ctx.editZone.textContent = '';
      svg(ctx.editZone, 'pencil', 'dshap-crumbEditGlyph');
      ctx.crumbTrail.style.display = '';
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = input.value.trim();
        finish();
        if (v) void enterDir(null, v);
      } else if (e.key === 'Escape') {
        finish();
      }
    });
    input.addEventListener('blur', () => setTimeout(finish, 120));
    ctx.editZone.appendChild(input);
    input.focus();
  }

  async function commit() {
    if (!ctx || ctx.selected.size === 0) return;
    const input = ctx.input;
    const chosen = [...ctx.selected.values()];
    setStatus('读取文件中…');
    ctx.okBtn.disabled = true;
    try {
      const results = await bridge.attachmentRead(chosen.map((e) => e.path));
      const dt = new DataTransfer();
      for (const r of results) {
        dt.items.add(new File([r.data], r.name, { lastModified: r.lastModified || 0 }));
      }
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      closePicker();
    } catch (err) {
      setStatus(`读取失败：${String((err && err.message) || err)}`, true);
      ctx.okBtn.disabled = false;
    }
  }

  function openPicker(input) {
    ensureStyle();
    closePicker();

    const multi = !!input.multiple;
    const exts = acceptExts(input.accept);

    const backdrop = el('div', 'dshap-backdrop');
    const dialog = el('div', 'dshap-dialog');

    // header：标题 + crumbBar（面包屑轨迹 + 点击编辑路径）
    const header = el('div', 'dshap-header');
    header.appendChild(el('div', 'dshap-title', multi ? '添加附件' : '选择文件'));
    const crumbBar = el('div', 'dshap-crumbBar');
    const crumbTrail = el('div', 'dshap-crumbTrail');
    const editZone = el('button', 'dshap-crumbEditZone');
    editZone.type = 'button';
    editZone.title = '编辑路径';
    editZone.addEventListener('click', (e) => {
      e.stopPropagation();
      startPathEdit();
    });
    svg(editZone, 'pencil', 'dshap-crumbEditGlyph');
    crumbBar.appendChild(crumbTrail);
    crumbBar.appendChild(editZone);
    header.appendChild(crumbBar);
    dialog.appendChild(header);

    // Miller 视图
    const millerRow = el('div', 'dshap-millerRow');
    dialog.appendChild(millerRow);

    // footer：左侧 显示隐藏文件 开关 + 状态文字，右侧 取消 / 打开（同款黑底主按钮）
    const footerBar = el('div', 'dshap-footerBar');
    const toggleBtn = el('button', 'dshap-toggle dshap-toggleActive', '显示隐藏文件');
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', () => {
      ctx.showHidden = !ctx.showHidden;
      toggleBtn.classList.toggle('dshap-toggleActive', ctx.showHidden);
      renderMiller();
    });
    const footerStatus = el('div', 'dshap-footerStatus', '');
    const gap = el('div', 'dshap-footerGap');
    const cancelBtn = el('button', 'dshap-btn', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', closePicker);
    const okBtn = el('button', 'dshap-btn primary', '打开');
    okBtn.type = 'button';
    okBtn.disabled = true;
    okBtn.addEventListener('click', () => void commit());
    footerBar.appendChild(toggleBtn);
    footerBar.appendChild(footerStatus);
    footerBar.appendChild(gap);
    footerBar.appendChild(cancelBtn);
    footerBar.appendChild(okBtn);
    dialog.appendChild(footerBar);

    backdrop.appendChild(dialog);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) closePicker();
    });
    document.body.appendChild(backdrop);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closePicker();
      }
    };
    document.addEventListener('keydown', onKey, true);

    ctx = {
      input, multi, exts, backdrop, dialog, crumbTrail, editZone,
      millerRow, footerStatus, okBtn, loadingFloat: null,
      selected: new Map(), levels: [], editing: false,
      showHidden: true, onKey,
    };

    // 起点是「此电脑」（盘符视图），与目录选择一致
    void enterDir(null, COMPUTER);
  }

  // ── 拦截 file input 的 click ────────────────────────────────────────────
  const originalClick = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function patchedClick() {
    if (this instanceof HTMLInputElement && this.type === 'file') {
      if (this.disabled) return; // 与原生行为一致：disabled 的 input 不弹窗
      openPicker(this);
      return;
    }
    return originalClick.apply(this, arguments);
  };
})();
