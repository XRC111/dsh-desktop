/**
 * computer use 悬浮球。
 *
 * 【为什么需要】
 * 实测：DSH 的 Electron 窗口会在约 10 秒后**自己把前台抢回去**（无需用户操作）。
 * 而 computer use 的注入工具只能靠「激活那一刻」的快照判断目标 —— 于是文本/点击
 * 会落到 DSH 自己的窗口上，且工具仍报成功（静默失败，最危险的一类）。
 *
 * 破局点在窗口**隐藏**时：隐藏的窗口不会抢焦点。所以本模块做两件事：
 *   1) 自动化进行中且主窗口已隐藏时，悬浮球显示「进行中」，并**阻止**主窗口被拉回前台；
 *   2) 给用户一个可见的、可点的状态指示（点一下回到主窗口）。
 *
 * 【设计取舍】
 *  · 无边框 + 置顶 + 跳过任务栏：不抢任务栏、不抢 Alt-Tab，只是个浮层指示。
 *  · 默认**不拦截鼠标**（setIgnoreMouseEvents 视交互而定），可拖动。
 *  · 只依赖 Electron，不引第三方 UI。
 */
import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, nativeImage, app, ipcMain } from 'electron';
import { log } from './logger';
import { dshHomeDir } from './paths';

const BALL_SIZE = 56;

/** 心跳文件：computer-use 宿主插件在每次工具执行时写，外壳读它。 */
const HEARTBEAT_FILE = () => path.join(dshHomeDir(), 'computer-use-active.json');
/** 轮询间隔。心跳是「有没有在跑」的粗粒度信号，500ms 足够且几乎不耗资源。 */
const POLL_MS = 500;
/** 超过这个时间没更新就认为已结束（工具卡死/进程被杀时的兜底）。 */
const STALE_MS = 15000;
/** 悬浮球专用 preload：只暴露一个 click()，不暴露 node。 */
const BALL_PRELOAD =
  'data:text/javascript;base64,' +
  Buffer.from(
    `const { contextBridge, ipcRenderer } = require('electron');` +
      `contextBridge.exposeInMainWorld('ballApi', {` +
      `  click: () => ipcRenderer.send('app:ball-click')` +
      `});`
  ).toString('base64');

export interface ComputerUseState {
  active: boolean;
  /** 正在执行的具体动作，用于气泡提示（如「正在输入文本」） */
  action?: string;
}

/**
 * 悬浮球。
 *
 * 生命周期：create() 建窗（隐藏）→ setState() 切换显示/隐藏 → destroy() 清理。
 */
export class ComputerUseBall {
  private win: BrowserWindow | null = null;
  private active = false;
  private action = '';
  /** 主窗口当前是否可见（由外壳同步进来，决定是否允许显示悬浮球） */
  private mainVisible = true;
  private timer: NodeJS.Timeout | null = null;
  /** 自动化激活且主窗口隐藏时回调，外壳据此设置 suppressAutoFocus */
  onActiveChange?: (suppress: boolean) => void;

  constructor(private readonly handlers: {
    onOpenMainWindow: () => void;
    /** 悬浮球显示期间，主窗口是否允许被拉回前台 */
    isMainWindowHidden: () => boolean;
  }) {}

  create(): void {
    if (this.win) return;

    this.win = new BrowserWindow({
      width: BALL_SIZE,
      height: BALL_SIZE,
      type: 'toolbar',
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      show: false,
      webPreferences: {
        // 只有本地静态内容，不加载远程页面。开 contextIsolation + preload 暴露一个
        // 极小的 ballApi 给页面用来上报点击（不暴露任何 node 能力）。
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: BALL_PRELOAD,
      },
    });

    // 不参与 Alt-Tab、不显示在任务栏
    this.win.setSkipTaskbar(true);
    this.win.setAlwaysOnTop(true, 'screen-saver');

    const icon = loadBallIcon();
    if (icon) this.win.setIcon(icon);

    const html = buildBallHtml(icon ? icon.toDataURL() : '');
    this.win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    // 点击（非拖动）→ 打开主窗口。用 -webkit-app-region: drag 让 body 可拖动，
    // 同时在渲染进程里区分「拖动」和「点击」：只有没发生位移的 mouseup 才算点击。
    this.win.webContents.on('did-finish-load', () => {
      this.win?.webContents.executeJavaScript(`
        (function () {
          let moved = false; let sx = 0; let sy = 0;
          window.addEventListener('mousedown', (e) => { moved = false; sx = e.screenX; sy = e.screenY; });
          window.addEventListener('mousemove', (e) => {
            if (Math.abs(e.screenX - sx) > 3 || Math.abs(e.screenY - sy) > 3) moved = true;
          });
          window.addEventListener('mouseup', () => {
            if (!moved && window.ballApi && window.ballApi.click) window.ballApi.click();
          });
        })();
      `).catch(() => { /* ignore */ });
    });

    if (ipcMain.listenerCount('app:ball-click') === 0) {
      ipcMain.on('app:ball-click', () => this.handlers.onOpenMainWindow());
    }
    this.startPolling();
    log('computer use 悬浮球已创建（初始隐藏，轮询 ' + HEARTBEAT_FILE() + '）');
  }

  /**
   * 轮询心跳文件。
   *
   * 为什么不用客户端插件上报：computer use 的工具跑在 dsh 子进程里，
   * 客户端插件要订阅宿主的会话事件（`tool/result` 是 session 事件类型，
   * 得经 `ctx.sessions` 拿），各版本形状不一、耦合深。
   * 而宿主侧插件在每次 execute 时天然知道自己在跑 —— 它写文件，外壳读文件，
   * 是最低耦合的跨进程方式。
   */
  private startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    // 不让这个定时器拖住进程退出
    this.timer.unref?.();
    this.poll();
  }

  private poll(): void {
    let active = false;
    let action = '';
    try {
      const file = HEARTBEAT_FILE();
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw) as { active?: boolean; action?: string; at?: number };
      const at = typeof data.at === 'number' ? data.at : 0;
      if (data.active === true && Date.now() - at < STALE_MS) {
        active = true;
        action = typeof data.action === 'string' ? data.action : '';
      }
    } catch {
      // 文件不存在 / 正在写 / 内容不完整 —— 都按「没在跑」处理
    }
    this.setState({ active, action });
  }

  /** 同步主窗口可见性：主窗口可见时不显示悬浮球（避免和主窗口抢注意力） */
  setMainVisible(visible: boolean): void {
    this.mainVisible = visible;
    this.applyVisibility();
  }

  setState(state: ComputerUseState): void {
    const changed = state.active !== this.active || (state.action ?? '') !== this.action;
    this.active = state.active;
    this.action = state.action ?? '';
    // 自动化进行中且主窗口已隐藏 → 抑制主窗口自动抢焦点（悬浮球接管指示）
    this.onActiveChange?.(this.active && !this.mainVisible);
    if (changed) {
      this.applyVisibility();
      this.postState();
    }
  }

  private applyVisibility(): void {
    if (!this.win || this.win.isDestroyed()) return;
    // 只在「自动化进行中」且「主窗口已隐藏」时显示 —— 这正是抢焦点会被抑制的窗口态
    const shouldShow = this.active && !this.mainVisible;
    if (shouldShow && !this.win.isVisible()) {
      this.positionDefault();
      this.win.showInactive(); // 用 showInactive：绝不抢焦点
      log('computer use 悬浮球已显示（自动化进行中，主窗口已隐藏）');
    } else if (!shouldShow && this.win.isVisible()) {
      this.win.hide();
      log('computer use 悬浮球已隐藏');
    }
  }

  private postState(): void {
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.postMessage('state', { active: this.active, action: this.action });
  }

  private positionDefault(): void {
    if (!this.win || this.win.isDestroyed()) return;
    const display = require('electron').screen.getPrimaryDisplay();
    const area = display.workAreaSize;
    this.win.setPosition(area.width - BALL_SIZE - 24, Math.floor(area.height / 2));
  }

  destroy(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.win && !this.win.isDestroyed()) {
      this.win.destroy();
    }
    this.win = null;
  }
}

/** 优先用安装目录/仓库里的图标；拿不到就返回一个纯色占位（不报错）。 */
function loadBallIcon(): Electron.NativeImage | null {
  const candidates: string[] = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'icon.ico'));
    candidates.push(path.join(process.resourcesPath, 'tray.png'));
  }
  // 开发态：仓库内的资源
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'icon.ico'));
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'tray.png'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) return img.resize({ width: 40, height: 40 });
      }
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

/** 悬浮球的极简页面：中间 logo + 外圈脉冲，点击/拖动由外壳侧处理 */
function buildBallHtml(logoDataUrl: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  body { display: flex; align-items: center; justify-content: center;
    background: transparent; cursor: pointer; -webkit-app-region: drag; }
  .ball { position: relative; width: 48px; height: 48px; border-radius: 50%;
    background: rgba(20,22,28,.92); box-shadow: 0 4px 16px rgba(0,0,0,.45);
    display: flex; align-items: center; justify-content: center; }
  .ball::before { content: ""; position: absolute; inset: -5px; border-radius: 50%;
    border: 2px solid rgba(37,99,235,.9); animation: pulse 1.6s ease-out infinite; }
  @keyframes pulse {
    0%   { transform: scale(.92); opacity: .9; }
    100% { transform: scale(1.25); opacity: 0; }
  }
  .logo { width: 28px; height: 28px; border-radius: 6px; object-fit: contain;
    -webkit-user-drag: none; user-select: none; }
  .tip { position: absolute; bottom: -22px; left: 50%; transform: translateX(-50%);
    white-space: nowrap; font-size: 11px; color: #fff; background: rgba(0,0,0,.75);
    padding: 2px 7px; border-radius: 9px; display: none; }
  body.show-tip .tip { display: block; }
</style></head>
<body>
  <div class="ball">
    ${logoDataUrl ? '<img class="logo" alt="DSH" src="' + logoDataUrl + '">' : '<div class="logo" style="background:#2563eb;border-radius:6px"></div>'}
    <div class="tip" id="tip"></div>
  </div>
  <script>
    window.addEventListener('message', (e) => {
      const s = e.data || {};
      const tip = document.getElementById('tip');
      const txt = s.active ? (s.action || '正在操作本机…') : '';
      if (tip) { tip.textContent = txt; document.body.classList.toggle('show-tip', !!txt); }
    });
  </script>
</body></html>`;
}
