import {
  BaseWindow,
  WebContentsView,
  shell,
  app,
  nativeTheme,
  type WebContents,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { rendererDir } from './paths';
import { log } from './logger';
import type { ShellFeatures } from './shell-features';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

/** 自绘标题栏高度（titlebar.html 与 titleBarOverlay.height 必须一致） */
const TITLEBAR_HEIGHT = 40;

/**
 * 主窗口管理。
 *
 * 架构（1.1.19 起去系统标题栏，改 harness 风格）：
 *  - BaseWindow：只承载窗口本身（titleBarStyle: hidden + titleBarOverlay 画原生三键）；
 *  - titleBarView：外壳自绘的顶条（titlebar.html，整条拖拽区）；
 *  - contentView：真正的内容（本地加载页 → Harness UI），所有注入/导航/开窗策略都挂这里。
 *  视图布局在 resize/maximize/全屏事件里重算。
 *
 * 性能约束：
 *  - 只创建 1 个内容渲染进程；
 *  - 隐藏到托盘时开启 backgroundThrottling，暂停非必要的渲染与动画。
 */
export class WindowManager {
  private win: BaseWindow | null = null;
  private titleBarView: WebContentsView | null = null;
  private contentView: WebContentsView | null = null;
  private dshUrl: string | null = null;
  private quitting = false;
  private readonly stateFile: string;
  /** 功能开关：窗口相关的适配（外链/圆角/顶条）都按它决定要不要生效 */
  private readonly features: ShellFeatures | null;

  constructor(userDataDir: string, features: ShellFeatures | null = null) {
    this.stateFile = path.join(userDataDir, 'window-state.json');
    this.features = features;
  }

  /** 开关查询：没注入开关实例时按「全开」处理，保持老行为 */
  private on(id: string): boolean {
    return this.features ? this.features.isEnabled(id) : true;
  }

  /** 窗口本体（托盘显隐/进度条/关闭行为都用它） */
  get window(): BaseWindow | null {
    return this.win;
  }

  /** 内容视图（加载页/Harness UI 所在；IPC 推送与页面注入都挂它的 webContents） */
  get content(): WebContentsView | null {
    return this.contentView;
  }

  setQuitting(value: boolean): void {
    this.quitting = value;
  }

  isQuitting(): boolean {
    return this.quitting;
  }

  private loadWindowState(): WindowState {
    const fallback: WindowState = { width: 1280, height: 840, maximized: false };
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (typeof raw?.width === 'number' && typeof raw?.height === 'number') {
        return {
          width: Math.max(900, raw.width),
          height: Math.max(600, raw.height),
          x: typeof raw.x === 'number' ? raw.x : undefined,
          y: typeof raw.y === 'number' ? raw.y : undefined,
          maximized: !!raw.maximized,
        };
      }
    } catch {
      /* 首次运行没有状态文件 */
    }
    return fallback;
  }

  private saveWindowState(): void {
    if (!this.win || this.win.isDestroyed()) return;
    try {
      const bounds = this.win.getNormalBounds();
      const state: WindowState = {
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        maximized: this.win.isMaximized(),
      };
      fs.writeFileSync(this.stateFile, JSON.stringify(state));
    } catch {
      /* 忽略写入失败 */
    }
  }

  /** WCO（右上角原生三键）配色，跟随系统深浅色 */
  private overlayColors(): { color: string; symbolColor: string } {
    return nativeTheme.shouldUseDarkColors
      ? { color: '#16181d', symbolColor: '#e4e4e7' }
      : { color: '#f6f7f9', symbolColor: '#1f2328' };
  }

  create(): BaseWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;

    const state = this.loadWindowState();

    this.win = new BaseWindow({
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      minWidth: 900,
      minHeight: 600,
      show: false, // 等内容首帧，避免白屏闪烁
      // 跟随系统深浅色，避免深色主题下启动瞬间闪白
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9',
      title: 'DSH Desktop',
      autoHideMenuBar: true,
      icon: pickWindowIcon(),
      titleBarStyle: 'hidden', // 去掉系统标题栏
      titleBarOverlay: {
        // 原生 最小化/最大化/关闭 以 harness 配色叠在右上角
        ...this.overlayColors(),
        height: TITLEBAR_HEIGHT,
      },
      // 无边框窗口默认是直角，与系统其它窗口不一致；roundedCorners 让它跟随系统圆角。
      // 关掉该开关即恢复 Electron 默认（直角）。
      ...(this.on('framelessFit') ? { roundedCorners: true } : {}),
    });

    // ---- 顶条视图（外壳自绘标题栏；关掉开关即沉浸模式，不创建它）----
    if (this.on('showTitleBar')) {
      this.titleBarView = new WebContentsView({
        webPreferences: { sandbox: true, spellcheck: false },
      });
      this.win.contentView.addChildView(this.titleBarView);
      void this.titleBarView.webContents.loadFile(path.join(rendererDir(), 'titlebar.html'));
    }

    // ---- 内容视图（加载页 → Harness UI）----
    this.contentView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true, // 安全默认值
        nodeIntegration: false, // 渲染进程不直接持有 Node 能力
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: true,
        webgl: false, // Harness UI 不需要，省 GPU 内存
        devTools: !app.isPackaged,
      },
    });
    this.win.contentView.addChildView(this.contentView);

    const layout = (): void => this.layoutViews();
    this.win.on('resize', layout);
    this.win.on('maximize', layout);
    this.win.on('unmaximize', layout);
    this.win.on('enter-full-screen', () => {
      // 全屏时标题条没有意义，内容铺满
      this.titleBarView?.setVisible(false);
      layout();
    });
    this.win.on('leave-full-screen', () => {
      this.titleBarView?.setVisible(true);
      layout();
    });
    layout();

    // 标题跟随会话：让任务栏与 Alt+Tab 里显示当前会话，符合桌面应用习惯
    this.contentView.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (!this.win || this.win.isDestroyed()) return;
      const clean = (title || '').trim();
      const base = 'DSH Desktop';
      const next = !clean || clean === base ? base : `${clean} — ${base}`;
      this.win.setTitle(next);
      // 顶条只显示会话名：dsh 页面标题自带 "— DeepSeek Harness" 后缀，任务栏保留全串，
      // 顶条再去掉尾巴（品牌名左侧已有，整串搬上来又长又重复）
      const bare = clean.split(' — ')[0].trim();
      const topbar = !bare || bare === base || /^deepseek harness$/i.test(bare) ? '' : bare;
      this.syncTitleBarText(topbar);
      // 窗口不可见时把标题变化反馈到任务栏（用户被别的事占住时更易察觉）
      if (!this.win.isVisible()) this.win.flashFrame(true);
    });

    // 内容首帧后再显示（加载页极小，did-finish-load 即首帧）
    this.contentView.webContents.once('did-finish-load', () => {
      if (state.maximized) this.win?.maximize();
      this.win?.show();
      this.applyContentInset();
    });

    // 关闭 = 最小化到托盘（除非用户选择完全退出）
    this.win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      this.saveWindowState();
      this.hide();
      log('窗口已隐藏到托盘（dsh 服务继续运行）');
    });

    this.win.on('closed', () => {
      this.win = null;
      this.titleBarView = null;
      this.contentView = null;
    });

    // 外部链接交给系统浏览器，应用内不新开窗口。
    // 关掉 externalLinks 时不再拦截：交回 Chromium 默认行为（target=_blank 会被
    // 下面 will-navigate 的允许列表挡住，等于「点了没反应」，这正是「关掉适配」的语义）。
    this.contentView.webContents.setWindowOpenHandler(({ url }) => {
      if (this.on('externalLinks') && /^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    // 只允许停留在本机 dsh 地址与本地加载页，其它导航一律拒绝
    this.contentView.webContents.on('will-navigate', (event, url) => {
      const allowed = this.isAllowedUrl(url);
      if (!allowed) {
        event.preventDefault();
        log(`已拦截外部导航：${url}`);
        if (this.on('externalLinks') && /^https?:\/\//i.test(url)) void shell.openExternal(url);
      }
    });

    this.loadLoadingPage();

    // 系统主题切换时同步窗口底色与 WCO 配色（Harness 界面自身的主题由它自己管理）
    nativeTheme.on('updated', () => {
      if (!this.win || this.win.isDestroyed()) return;
      this.win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#16181d' : '#f6f7f9');
      try {
        this.win.setTitleBarOverlay({ ...this.overlayColors(), height: TITLEBAR_HEIGHT });
      } catch (err) {
        log(`setTitleBarOverlay 失败（非 Windows 或旧系统忽略）：${String(err)}`);
      }
    });

    return this.win;
  }

  /** 重排两个视图：顶条固定高度，内容占其余部分 */
  private layoutViews(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const size = this.win.getContentSize();
    const width = size[0];
    const height = size[1];
    const fullscreen = this.win.isFullScreen();
    // 顶条关掉（沉浸模式）或全屏时，内容铺满整窗
    const barH = fullscreen || !this.titleBarView ? 0 : TITLEBAR_HEIGHT;
    this.titleBarView?.setBounds({ x: 0, y: 0, width, height: barH });
    this.contentView?.setBounds({ x: 0, y: barH, width, height: Math.max(0, height - barH) });
  }

  /** 会话标题变化时同步到顶条（空串 = 只显示品牌名，分隔点由 CSS 自动隐藏） */
  private syncTitleBarText(text: string): void {
    if (!this.titleBarView) return;
    const safe = JSON.stringify(text || '');
    this.titleBarView.webContents
      .executeJavaScript(
        `(function(){var n=document.getElementById('title');if(n)n.textContent=${safe};})()`,
        false,
      )
      .catch(() => {
        /* 顶条页面尚未就绪时忽略，下次标题变化会再同步 */
      });
  }

  /**
   * 运行期开关顶条（设置页「显示外壳顶条」）。
   * 顶条是独立 WebContentsView，只能创建/销毁，不能只隐藏——隐藏后那条 40px
   * 会变成一条空白带，内容并不上移。
   */
  setTitleBarEnabled(on: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (on && !this.titleBarView) {
      this.titleBarView = new WebContentsView({
        webPreferences: { sandbox: true, spellcheck: false },
      });
      this.win.contentView.addChildView(this.titleBarView);
      void this.titleBarView.webContents.loadFile(path.join(rendererDir(), 'titlebar.html'));
    } else if (!on && this.titleBarView) {
      this.win.contentView.removeChildView(this.titleBarView);
      this.titleBarView.webContents.close();
      this.titleBarView = null;
    }
    this.layoutViews();
    this.applyContentInset();
  }

  /**
   * 无边框适配：右上角那三个原生按钮（titleBarOverlay）是画在**窗口**上的，
   * 顶条在时它们落在顶条里，不挡内容；顶条关掉后内容铺满整窗，它们就会压住
   * Harness 自己的右上角控件。这里给页面注入一段安全边距把内容让开。
   * 注入是幂等的（按 id 找 style 元素），关掉开关时把元素删掉。
   */
  private applyContentInset(): void {
    const wc = this.contentView?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const need = this.on('framelessFit') && !this.titleBarView;
    const js = need
      ? "(function(){if(document.getElementById('dsh-desktop-wco-inset'))return;" +
        "var s=document.createElement('style');s.id='dsh-desktop-wco-inset';" +
        "s.textContent='body{padding-top:32px!important;padding-right:150px!important;box-sizing:border-box!important}';" +
        "document.head.appendChild(s);})()"
      : "(function(){var n=document.getElementById('dsh-desktop-wco-inset');if(n)n.remove();})()";
    wc.executeJavaScript(js, false).catch(() => {
      /* 页面尚未就绪：下次布局/加载完成时会再试 */
    });
  }

  private isAllowedUrl(url: string): boolean {
    if (url.startsWith('file://')) return true;
    if (url.startsWith('devtools://')) return true;
    if (this.dshUrl && url.startsWith(originOf(this.dshUrl))) return true;
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//i.test(url);
  }

  /** 显示本地加载页 */
  loadLoadingPage(): void {
    if (!this.contentView) return;
    void this.contentView.webContents.loadFile(path.join(rendererDir(), 'loading.html'));
  }

  /**
   * 加载**恢复工具**页面。
   *
   * 这是外壳自带的本地页面（renderer/recovery.html），**不依赖 dsh** ——
   * 它要解决的场景就是「dsh 起不来」，所以绝不能跑在 dsh web 里。
   *
   * 换 preload：主 preload 是给 Harness UI 用的（面大、跟 dsh 走），
   * 恢复页只该拿到 recovery.* 那一小组方法。WebContentsView 的 preload
   * 只能在创建时定，所以这里重建一个视图，用完再换回来。
   */
  loadRecoveryPage(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const { WebContentsView } = require('electron') as typeof import('electron');
    if (this.contentView) {
      this.win.contentView.removeChildView(this.contentView);
      this.contentView.webContents.close();
    }
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'recovery.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    this.contentView = view;
    this.win.contentView.addChildView(view);
    this.applyContentInset();
    void view.webContents.loadFile(path.join(rendererDir(), 'recovery.html'));
    log('已加载恢复工具页面（不依赖 Harness）');
  }

  /** dsh 就绪后加载 Harness 原生 Web UI（必须使用带 token 的完整地址） */
  loadDshUi(url: string): void {
    this.dshUrl = url;
    if (!this.contentView) return;
    log(`加载 Harness Web UI：${redactToken(url)}`);
    // 每次导航到 Harness UI 都要重新注入（换页面会丢掉注入的 style）
    this.contentView.webContents.once('did-finish-load', () => this.applyContentInset());
    void this.contentView.webContents.loadURL(url);
  }

  reloadDshUi(): void {
    if (this.dshUrl) this.loadDshUi(this.dshUrl);
  }

  /**
   * 自动化进行中且主窗口已隐藏时，是否禁止把主窗口拉回前台。
   *
   * 实测：DSH 的 Electron 窗口会在约 10 秒后**自己把前台抢回去**（无需用户操作）。
   * 而 computer use 的注入只能靠「激活那一刻」的快照判断目标 —— 于是输入会落到
   * DSH 自己的窗口上，且工具仍报成功。破局点是：窗口**隐藏**时不会抢焦点，
   * 所以自动化进行中就别把它叫回来。用户点悬浮球/托盘时再显式打开。
   */
  suppressAutoFocus = false;

  show(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.win.isVisible()) {
      // 自动化进行中：只恢复窗口可见性，**不抢焦点**（showInactive）
      if (this.suppressAutoFocus) {
        this.win.showInactive();
        this.contentView?.webContents.setBackgroundThrottling(false);
        return;
      }
      this.contentView?.webContents.setBackgroundThrottling(false);
      this.win.show();
    }
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  hide(): void {
    if (!this.win || this.win.isDestroyed()) return;
    // 隐藏后让 Chromium 降频，减少空闲 CPU
    this.contentView?.webContents.setBackgroundThrottling(true);
    this.win.hide();
  }

  toggle(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible() && !this.win.isMinimized()) this.hide();
    else this.show();
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible();
  }

  persistState(): void {
    this.saveWindowState();
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.titleBarView = null;
    this.contentView = null;
  }
}

/** 注入/IPC 目标的结构类型：BaseWindow 架构下内容在 WebContentsView 里 */
export interface WebContentsCarrier {
  webContents: WebContents;
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** 日志里不打印 token 明文 */
export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]+/i, '$1***');
}

function pickWindowIcon(): string | undefined {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'icon.ico')]
    : [path.join(app.getAppPath(), 'build', 'icon.ico')];
  return candidates.find((p) => fs.existsSync(p));
}
