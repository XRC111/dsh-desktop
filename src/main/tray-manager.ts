import { Tray, Menu, nativeImage, app, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DshStatus } from './dsh-service';
import { UpdateState } from './updater';
import { log } from './logger';

export interface TrayHandlers {
  onToggleWindow: () => void;
  onRestart: () => void;
  onRestartApp: () => void;
  onRollbackHot: () => void;
  /** 更新菜单项：按当前状态分派（检查更新 / 取消倒计时 / 重启应用热更新 / 安装） */
  onUpdateAction: () => void;
  onOpenLogs: () => void;
  onOpenDataDir: () => void;
  /** 打开恢复工具（不依赖 dsh —— dsh 起不来时的入口） */
  onOpenRecovery: () => void;
  onQuit: () => void;
}

/** 系统托盘：常驻运行，提供显示/隐藏、检查更新、日志、完全退出 */
export class TrayManager {
  private tray: Tray | null = null;
  private statusText = '正在启动…';
  private updateLabel = '检查更新';
  private updateBusy = false;
  /** 当前生效的热更新壳版本（null = 内置壳） */
  private hotShellVersion: string | null = null;
  /** 任务是否在跑（由页面注入脚本上报，见 task-reporter.client.js） */
  private taskRunning = false;

  constructor(private readonly handlers: TrayHandlers) {}

  create(): void {
    if (this.tray) return;

    const icon = loadTrayIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('DSH Desktop');
    this.tray.on('click', () => this.handlers.onToggleWindow());
    this.tray.on('double-click', () => this.handlers.onToggleWindow());
    this.rebuildMenu();
    log('系统托盘已创建');
  }

  updateStatus(status: DshStatus): void {
    const map: Record<string, string> = {
      idle: '未启动',
      starting: '正在启动…',
      ready: '运行中',
      stopping: '正在停止…',
      stopped: '已停止',
      failed: '启动失败',
    };
    this.statusText = map[status.state] ?? status.state;
    this.refreshTooltip();
    this.rebuildMenu();
  }

  /** 告知托盘当前生效的热更新壳版本（用于菜单显示与「回退」入口） */
  setHotShell(version: string | null): void {
    this.hotShellVersion = version;
    this.refreshTooltip();
    this.rebuildMenu();
  }

  /**
   * 任务运行状态（页面注入脚本上报）。返回「本次是否发生了切换」，
   * 调用方据此决定要不要弹「任务完成」通知。
   */
  setTaskRunning(running: boolean): boolean {
    if (this.taskRunning === running) return false;
    this.taskRunning = running;
    this.refreshTooltip();
    this.rebuildMenu();
    return true;
  }

  isTaskRunning(): boolean {
    return this.taskRunning;
  }

  /** 托盘悬停提示：把任务状态放在最前面，一眼可见 */
  private refreshTooltip(): void {
    const parts = [
      this.taskRunning ? '正在运行' : this.statusText,
      this.hotShellVersion ? `热更新壳 ${this.hotShellVersion}` : '',
    ].filter(Boolean);
    this.tray?.setToolTip(`DSH Desktop — ${parts.join(' · ')}`);
  }

  /** 托盘里的更新条目：把当前更新阶段直接显示出来（下载进度也在这里） */
  updateUpdateState(state: UpdateState): void {
    switch (state.phase) {
      case 'checking':
        this.updateLabel = '正在检查更新…';
        this.updateBusy = true;
        break;
      case 'available':
        this.updateLabel = `发现新版本 ${state.latestVersion ?? ''}，点击安装`;
        this.updateBusy = false;
        break;
      case 'downloading':
        this.updateLabel =
          `正在下载更新 ${state.percent ?? 0}%` +
          (state.speed && state.speed > 0
            ? `（${state.speed >= 1024 * 1024 ? `${(state.speed / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(state.speed / 1024)} KB/s`}）`
            : '');
        this.updateBusy = true;
        break;
      case 'downloaded':
        if (typeof state.restartIn === 'number') {
          // 用户选了「N 分钟后自动重启」：显示倒计时，点一下可以取消
          this.updateLabel = `将在 ${state.restartIn} 秒后重启以应用更新（点击取消）`;
        } else if (state.hotReady || state.runtimeReady || state.pluginsReady) {
          const what = [
            state.hotReady && state.hotVersion ? `外壳 ${state.hotVersion}` : '',
            state.runtimeReady && state.runtimeTarget ? `运行时 ${state.runtimeTarget}` : '',
            state.pluginsReady ? `新插件` : '',
          ].filter(Boolean).join(' + ');
          this.updateLabel = `重启以应用更新（${what}）（点击重启）`;
        } else {
          this.updateLabel = `重启并安装 ${state.latestVersion ?? '更新'}`;
        }
        this.updateBusy = false;
        break;
      case 'applying':
        this.updateLabel = '正在重启以应用更新…';
        this.updateBusy = true;
        break;
      case 'up-to-date':
        this.updateLabel = '检查更新（已是最新）';
        this.updateBusy = false;
        break;
      case 'error':
        this.updateLabel = '检查更新（上次失败）';
        this.updateBusy = false;
        break;
      case 'disabled':
        this.updateLabel = '检查更新（未配置更新源）';
        this.updateBusy = false;
        break;
      default:
        this.updateLabel = '检查更新';
        this.updateBusy = false;
    }
    this.rebuildMenu();
  }

  /** 托盘气泡通知（Windows 上比系统通知更省事，不需要额外权限） */
  notify(title: string, body: string): void {
    try {
      this.tray?.displayBalloon({ title, content: body, iconType: 'info' });
    } catch (err) {
      log(`托盘通知失败：${String(err)}`);
    }
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: this.taskRunning
          ? 'DSH Desktop — 正在运行任务…'
          : `DSH Desktop — ${this.statusText}${this.hotShellVersion ? `（热壳 ${this.hotShellVersion}）` : ''}`,
        enabled: false,
      },
      { type: 'separator' },
      { label: '显示主窗口', click: () => this.handlers.onToggleWindow() },
      { label: '重启 Harness 服务', click: () => this.handlers.onRestart() },
      { label: '重启应用', click: () => this.handlers.onRestartApp() },
      {
        label: this.updateLabel,
        enabled: !this.updateBusy,
        click: () => this.handlers.onUpdateAction(),
      },
    ];

    // 只有真的在跑热更新壳时才给回退入口，避免菜单噪音
    if (this.hotShellVersion) {
      template.push({
        label: `回退到内置版本（当前热壳 ${this.hotShellVersion}）`,
        click: () => this.handlers.onRollbackHot(),
      });
    }

    template.push(
      { type: 'separator' },
      { label: '打开日志目录', click: () => this.handlers.onOpenLogs() },
      { label: '打开数据目录', click: () => this.handlers.onOpenDataDir() },
      { label: '恢复工具（Harness 起不来时用）', click: () => this.handlers.onOpenRecovery() },
      { type: 'separator' },
      {
        label: '完全退出',
        click: () => {
          void confirmQuit(this.handlers.onQuit);
        },
      },
    );

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}

async function confirmQuit(onQuit: () => void): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['完全退出', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '完全退出 DSH Desktop',
    message: '确定要完全退出吗？',
    detail: 'DeepSeek Harness 本地服务将被停止，托盘图标也会退出。',
  });
  if (response === 0) onQuit();
}

function loadTrayIcon(): Electron.NativeImage {
  const candidates = [
    app.isPackaged ? path.join(process.resourcesPath, 'tray.png') : '',
    app.isPackaged ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.join(app.getAppPath(), 'build', 'tray.png'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'tray.png'),
  ].filter(Boolean);

  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (!img.isEmpty()) {
      return process.platform === 'win32' ? img.resize({ width: 16, height: 16 }) : img;
    }
  }
  // 兜底：1x1 透明图，保证托盘可创建（不会崩）
  return nativeImage.createEmpty();
}
