import { contextBridge, ipcRenderer } from 'electron';

/**
 * 最小化 preload。
 *
 * 外壳只给渲染进程提供「读取启动状态 + 几个确定性操作」的窄接口，
 * 不暴露任何 Node 能力，保持 contextIsolation 的安全默认值。
 */
const api = {
  /** 主动拉取当前状态 */
  getStatus: () => ipcRenderer.invoke('app:get-status'),
  /** 订阅状态变化，返回取消订阅函数 */
  onStatus: (cb: (status: unknown) => void) => {
    const handler = (_e: unknown, status: unknown): void => cb(status);
    ipcRenderer.on('dsh:status', handler);
    return () => ipcRenderer.removeListener('dsh:status', handler);
  },
  /** 重新启动 dsh 服务 */
  retry: () => ipcRenderer.invoke('app:retry'),
  /** 打开日志目录 */
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  /** 打开用户数据目录 */
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  /** 完成退出（回收 dsh 子进程） */
  quit: () => ipcRenderer.invoke('app:quit'),
  /** 复制诊断信息 */
  copyDiagnostics: () => ipcRenderer.invoke('app:copy-diagnostics'),
  /**
   * 更新相关（供页面内小部件使用，见 renderer/updater.client.js）
   * 只暴露状态查询与已存在的动作，不暴露任意下载/执行能力。
   */
  /** 当前版本信息：外壳版本、dsh 运行时版本、更新源 */
  getVersions: () => ipcRenderer.invoke('app:get-versions'),
  /** 拉取当前更新状态 */
  getUpdateState: () => ipcRenderer.invoke('app:get-update-state'),
  /** 主动检查更新（会按配置决定要不要弹窗） */
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  /** 订阅更新状态变化，返回取消订阅函数 */
  onUpdateState: (cb: (state: unknown) => void) => {
    const handler = (_e: unknown, state: unknown): void => cb(state);
    ipcRenderer.on('dsh:update', handler);
    return () => ipcRenderer.removeListener('dsh:update', handler);
  },
  /** 重启应用（同时应用已落位的热更新/运行时补丁） */
  restart: () => ipcRenderer.invoke('app:restart'),
  /**
   * 安装更新（更新横幅「立即更新」用）：默认 auto（能热更就热更，否则完整安装包）；
   * 可显式传 'hot' | 'runtime' | 'installer' 强制通道。
   */
  installUpdate: (mode?: 'hot' | 'runtime' | 'installer') =>
    ipcRenderer.invoke('app:install-update', { mode }),
  /** 当前更新通道（stable / beta / dev）与它实际请求的 feed 地址 */
  getChannel: () => ipcRenderer.invoke('app:get-channel'),
  /** 切换更新通道（写回 update-config.json 并立即按新通道检查一次） */
  setChannel: (channel: 'stable' | 'beta' | 'dev') => ipcRenderer.invoke('app:set-channel', channel),
  /** 跳过某版本（更新横幅「跳过此版本」）：持久化偏好并收起横幅 */
  skipUpdate: (version: string) => ipcRenderer.invoke('app:skip-update', version),
  /**
   * 应用内文件选择（附件窗口）：列一层目录（含文件 + 盘符虚拟根）。
   * 只返回数据原语，窗口界面由注入脚本在页面主世界渲染。
   */
  attachmentList: (dir?: string) => ipcRenderer.invoke('attachment:list', dir),
  /** 读取选中的文件字节（附件窗口确认时用） */
  attachmentRead: (paths: string[]) => ipcRenderer.invoke('attachment:read', paths),
  /**
   * 外壳功能开关（设置页「桌面」面板读写）。
   * 注入脚本用它判断某个适配要不要装监听；页面脚本一律以「拿不到就按开启」兜底。
   */
  getFeatures: () => ipcRenderer.invoke('app:get-features'),
  /** 写入单个开关，返回写入后的完整快照 */
  setFeature: (id: string, enabled: boolean) =>
    ipcRenderer.invoke('app:set-feature', { id, enabled }),
  /** 同步查询单个开关（注入脚本启动时用，避免异步竞态） */
  isFeatureEnabled: (id: string) => ipcRenderer.sendSync('app:feature-enabled', id) === true,
  /**
   * 页面把「任务在不在跑」上报给外壳（托盘状态 + 任务完成通知）。
   * 单向通知，不需要返回值；外壳侧按功能开关决定怎么用。
   */
  reportTaskState: (state: { running: boolean; unloading?: boolean }) =>
    ipcRenderer.send('app:task-state', state),
};

contextBridge.exposeInMainWorld('dshDesktop', api);

export type DshDesktopApi = typeof api;
