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
  // ⚠️ 默认**关**：官方 dsh 已内置拖放（dsh-client-ui-attachment 的 onDragEnter/onDrop，
  // 0.1.7 与 0.2.0 都有），而本垫片用**捕获阶段 + stopPropagation**，会**掐断**事件，
  // 让官方的拖放完全收不到 → 冲突。实测：官方监听是冒泡阶段，捕获先于冒泡，必被拦死。
  //
  // 历史：本垫片是 0.1.5 时代写的，当时官方没有拖放，属于补缺；现在官方不仅有了，
  // 还更全（目录递归、dropEffect、拖入高亮、canAcceptDrop 判断）—— 垫片从「补缺」变成「打架」。
  // 保留代码（万一将来官方回退，可手动打开），但默认关闭。
  {
    id: 'dragDropAttach',
    def: false,
    label: '拖放文件添加附件（外壳垫片）',
    desc:
      '⚠️ 与官方内置拖放冲突，默认关闭。官方本身已支持拖放，无需打开。' +
      '仅当官方拖放失效时才考虑启用（会覆盖官方行为）。',
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
  // ── computer use（操作本机桌面）──────────────────────────────────────────
  // 与上面那些「适配」不同，这组开关让 AI **能操作你的电脑**，风险性质不一样。
  // 所以按**能力粒度**拆开，而不是一个总开关 —— 你可以只给「看屏幕」，
  // 或只给「点鼠标」而不给「打字」，按需要逐项放开。
  //
  // 截图（看屏幕）默认开：它只是读，且是判断界面状态的必需品。
  // 其余默认关：都会**真实改变你的系统状态**。
  {
    id: 'computerUseScreenshot',
    def: true,
    label: '看屏幕（截图）',
    desc: '允许 AI 截取屏幕或指定窗口的画面。只读，不改动任何东西；关掉则它无法感知界面。',
  },
  {
    id: 'computerUseMouse',
    def: false,
    label: '操作鼠标（点击/移动/滚轮）',
    desc: '允许 AI 移动指针并点击。它能点到任何地方，包括删除按钮 —— 请只在盯着屏幕时开。',
  },
  {
    id: 'computerUseKeyboard',
    def: false,
    label: '操作键盘（按键/输入文本）',
    desc: '允许 AI 按键与打字。它能输入任意内容并触发快捷键（如 Ctrl+S、Alt+F4）。',
  },
  {
    id: 'computerUseWindows',
    def: false,
    label: '切换与调整窗口',
    desc: '允许 AI 把窗口切到前台、移动或缩放。会打断你当前的操作焦点。',
  },
  {
    id: 'computerUseUnattended',
    def: false,
    label: '允许后台无人值守操作',
    desc:
      '默认 AI 只能在本窗口处于前台时操作（你没在看就别动）。' +
      '开启后它可以在你切走后继续操作 —— 风险最高，除非在做长流程自动化，否则别开。',
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
