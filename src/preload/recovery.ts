/**
 * 恢复工具页面的 preload —— 只暴露恢复所需的最小接口。
 *
 * 为什么不复用主 preload：主 preload 是给 dsh Web UI 用的（功能开关、更新、渠道…），
 * 面大且跟着 dsh 走。恢复页要在 dsh 起不来时独立工作，所以单独一个 preload，
 * 只暴露 recovery.* 这一小组方法，且**不依赖任何 dsh 侧状态**。
 */
import { contextBridge, ipcRenderer } from 'electron';

const recovery = {
  /** 跑一遍体检，返回检查项数组。 */
  diagnose: () => ipcRenderer.invoke('recovery:diagnose'),
  /** 执行一个修复动作（id 由体检结果给出）。 */
  runFix: (id: string) => ipcRenderer.invoke('recovery:fix', { id }),
  /** 当前状态：是否安全模式、上次启动失败原因。 */
  state: () => ipcRenderer.invoke('recovery:state'),
  /** 环境摘要（路径、版本）。 */
  environment: () => ipcRenderer.invoke('recovery:environment'),
  /** 重启应用。 */
  restart: () => ipcRenderer.invoke('recovery:restart'),
  /** 打开数据目录。 */
  openDataDir: () => ipcRenderer.invoke('recovery:open-data-dir'),
};

contextBridge.exposeInMainWorld('recovery', recovery);

export type RecoveryApi = typeof recovery;
