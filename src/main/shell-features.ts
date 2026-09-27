/**
 * 外壳功能开关（桌面适配的可配置层）。
 *
 * 为什么要有它：桌面外壳对 Harness 页面做了若干「适配」——外链交给系统浏览器、
 * 拖放文件直接进附件、托盘反映任务状态、无边框窗口的避让与圆角。这些适配大多数
 * 人希望默认就有，但也必须能单独关掉（某个适配跟用户的用法打架时，不必因此退回旧版外壳）。
 *
 * 设计原则：
 *  - **默认全开**：不预设「哪个适配用户不需要」，一律先给，需要时再关；
 *  - 未知 id 一律忽略，不因为前端传错值把状态写坏；
 *  - 落盘在用户数据目录（不写安装目录，打包态在 Program Files 无写权限）；
 *  - 读盘失败（首次运行/文件损坏）一律回落默认值，绝不阻断启动。
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export interface ShellFeatureDef {
  /** 稳定 id（前端与 IPC 都用它） */
  id: string;
  /** 默认是否开启 */
  def: boolean;
  /** 设置页显示名 */
  label: string;
  /** 设置页说明（一句话讲清关掉会怎样） */
  desc: string;
}

/**
 * 全部开关。顺序即设置页显示顺序。
 * 新增开关只要往这里加一条：老用户的配置文件里没有它 → 自动取 def。
 */
export const SHELL_FEATURES: ShellFeatureDef[] = [
  {
    id: 'externalLinks',
    def: true,
    label: '外链走系统浏览器',
    desc: '页面里的 http/https 链接交给系统默认浏览器打开，不在应用内新开窗口。',
  },
  {
    id: 'dragDropAttach',
    def: true,
    label: '拖放文件添加附件',
    desc: '把文件从资源管理器拖进窗口即加入当前对话的附件，等效于点「添加附件」。',
  },
  {
    id: 'trayStatus',
    def: true,
    label: '托盘显示任务状态',
    desc: '任务运行中时托盘提示与菜单显示「正在运行」，完成后回到「空闲」。',
  },
  {
    id: 'taskNotify',
    def: true,
    label: '任务完成时通知',
    desc: '窗口不在前台时，任务跑完弹一条系统通知（窗口在前台时不打扰）。',
  },
  {
    id: 'framelessFit',
    def: true,
    label: '无边框窗口适配',
    desc: '窗口使用系统圆角，并让页面内容避开右上角的最小化/最大化/关闭三键。',
  },
  {
    id: 'showTitleBar',
    def: true,
    label: '显示外壳顶条',
    desc: '窗口顶部显示 DSH Desktop 自绘顶条（含当前会话名）。关掉即沉浸模式，内容铺满整窗。',
  },
];

const FILE_NAME = 'shell-features.json';

export class ShellFeatures {
  private readonly file: string;
  private values: Record<string, boolean>;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, FILE_NAME);
    this.values = this.load();
  }

  private load(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const f of SHELL_FEATURES) out[f.id] = f.def;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const f of SHELL_FEATURES) {
        if (typeof raw?.[f.id] === 'boolean') out[f.id] = raw[f.id] as boolean;
      }
    } catch {
      /* 首次运行或文件损坏：用默认值 */
    }
    return out;
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    } catch (err) {
      log('功能开关写入失败：' + String(err));
    }
  }

  isEnabled(id: string): boolean {
    const f = SHELL_FEATURES.find((x) => x.id === id);
    if (!f) return false;
    return this.values[id] ?? f.def;
  }

  /** 当前值 + 开关定义，一次给全，前端据此渲染设置页 */
  snapshot(): { values: Record<string, boolean>; defs: ShellFeatureDef[] } {
    return { values: { ...this.values }, defs: SHELL_FEATURES };
  }

  /** 写入单个开关；id 非法或值没变返回 false（调用方据此决定要不要重新应用） */
  set(id: string, enabled: boolean): boolean {
    const f = SHELL_FEATURES.find((x) => x.id === id);
    if (!f) {
      log('忽略未知功能开关：' + id);
      return false;
    }
    if (this.values[id] === enabled) return false;
    this.values[id] = enabled;
    this.save();
    log('功能开关已更新：' + id + ' = ' + String(enabled));
    return true;
  }
}
