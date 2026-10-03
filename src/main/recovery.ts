/**
 * 恢复工具（recovery）—— **完全脱离 dsh**，用于修复 dsh 及其环境。
 *
 * ── 为什么必须脱离 dsh ──────────────────────────────────────────────────────
 * 它要解决的场景就是「dsh 起不来」。如果它自己跑在 dsh web 里，那 dsh 一挂它跟着没，
 * 等于没有。所以：
 *   · 界面 = 外壳自己的本地 HTML（renderer/recovery.html），不经 dsh 前端
 *   · 逻辑 = 这个模块，跑在 Electron 主进程
 *   · 依赖 = 只有 Node + Electron，不 require 任何 dsh 的东西
 *
 * ── 它能修什么（按「实际踩过的故障」排序）──────────────────────────────────
 *
 *  1) 坏插件导致 plugin tree failed to load（最常见，且用户自己无法自救）
 *     → 进安全模式：把 profile 的 bundles 收敛为内置集合
 *  2) 运行时文件缺失/损坏（NSIS 静默丢文件、杀软误删）
 *     → 照 manifest 全量核对，从 dsh-runtime.tar 只补缺失的
 *  3) 上次被强杀留下 profile 锁
 *     → 清理 stale lock（dsh 自己也会清，但起不来时就轮到这里）
 *  4) 补丁层把 dsh 写坏（自己改坏 desktop-patch.yml / 热更新带来坏补丁）
 *     → 回退到内置补丁，或直接停用补丁
 *  5) 磁盘上的 dist 目录被降权（火绒打低完整性标签）导致打包失败
 *     → 只诊断并提示命令，不自动改 ACL（改 ACL 属于安全敏感操作，交给用户确认）
 *
 * ── 设计原则 ────────────────────────────────────────────────────────────────
 *  · 每个动作**先诊断、后修复**，诊断结果原样返回给界面（用户要看懂发生了什么）
 *  · 修复动作**可逆**：改动前备份，并把回滚方式一并返回
 *  · 任何单个动作失败都不影响其它动作（逐个 try/catch）
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dshHomeDir, dshRuntimeDir, extractRuntimeScript, runtimeManifestFile, runtimeTarFile, userDataDir } from './paths';
import { findAllMissing, loadManifest } from './runtime-installer';
import { log } from './logger';
import { prepareBundles, safeModeRequested, SAFE_MODE_ENV } from './safe-mode';

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

export interface CheckResult {
  id: string;
  label: string;
  /** ok = 正常；warn = 有问题但可修；bad = 严重 */
  status: 'ok' | 'warn' | 'bad';
  detail: string;
  /** 可执行的修复动作 id（界面据此显示按钮） */
  fix?: string;
}

/** 一个可执行的修复动作。 */
export interface FixResult {
  ok: boolean;
  message: string;
  /** 需要重启应用才生效 */
  needsRestart?: boolean;
}

/** profile 的 package.json 路径。 */
function profileManifest(profileName = 'web'): string {
  return path.join(dshHomeDir(), 'profiles', profileName, 'package.json');
}

/**
 * 列出 profile 里配置的第三方 bundle。
 *
 * 「第三方」= 不在内置集合里的。判断标准与 safe-mode.ts 保持一致（同一份常量）。
 */
function thirdPartyBundles(profileName = 'web'): { all: string[]; third: string[] } {
  try {
    const j = JSON.parse(fs.readFileSync(profileManifest(profileName), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } };
    };
    const all = Array.isArray(j.dsh?.profile?.bundles) ? (j.dsh!.profile!.bundles as string[]) : [];
    const INBOX = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']);
    return { all, third: all.filter((b) => !INBOX.has(b)) };
  } catch {
    return { all: [], third: [] };
  }
}

/**
 * 找出解析不到的 bundle —— 这就是「起不来」的直接原因。
 *
 * 只看**磁盘上有没有那个包**，不 require 它：require 一个坏包可能把恢复进程也带崩，
 * 而「包目录/入口不存在」已经能解释绝大多数加载失败。
 */
function unresolvableBundles(profileName = 'web'): string[] {
  const { third } = thirdPartyBundles(profileName);
  const modulesRoot = path.join(dshHomeDir(), 'profiles', 'node_modules');
  const profileModules = path.join(dshHomeDir(), 'profiles', profileName, 'node_modules');
  const missing: string[] = [];
  for (const name of third) {
    const candidates = [
      path.join(modulesRoot, name, 'package.json'),
      path.join(profileModules, name, 'package.json'),
    ];
    if (!candidates.some((c) => fs.existsSync(c))) missing.push(name);
  }
  return missing;
}

/** 运行全部诊断。每个检查独立 try/catch，坏一个不影响其它。 */
export async function diagnose(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // 1) 第三方 bundle 是否都能解析
  try {
    const { third } = thirdPartyBundles();
    const missing = unresolvableBundles();
    if (third.length === 0) {
      out.push({ id: 'bundles', label: '第三方插件', status: 'ok', detail: '没有配置第三方插件' });
    } else if (missing.length > 0) {
      out.push({
        id: 'bundles',
        label: '第三方插件',
        status: 'bad',
        detail: '有 ' + missing.length + ' 个插件解析不到，这会让 Harness 完全起不来：' + missing.join('、'),
        fix: 'safe-mode',
      });
    } else {
      out.push({
        id: 'bundles',
        label: '第三方插件',
        status: 'ok',
        detail: third.length + ' 个第三方插件，磁盘上都能找到',
      });
    }
  } catch (err) {
    out.push({ id: 'bundles', label: '第三方插件', status: 'warn', detail: '检查失败：' + String(err) });
  }

  // 2) 运行时完整性
  //
  // ⚠️ runtimeManifestFile() 依赖 process.resourcesPath —— 它在打包后才有值，
  // 开发态/非 Electron 宿主下是 undefined，path.join 会抛。这里先判空再走，
  // 否则这一项会变成「检查失败」的噪音，掩盖真正的问题。
  try {
    const manifestFile = typeof process.resourcesPath === 'string' && process.resourcesPath
      ? runtimeManifestFile()
      : null;
    const manifest = manifestFile === null ? null : loadManifest(manifestFile);
    if (manifestFile === null) {
      out.push({ id: 'runtime', label: 'Harness 运行时', status: 'warn', detail: '无法定位运行时清单（非打包环境），跳过' });
    } else
    if (manifest === null) {
      out.push({ id: 'runtime', label: 'Harness 运行时', status: 'warn', detail: '读不到运行时清单，无法核对' });
    } else {
      // manifest 里的路径相对 **resourcesPath**（形如 "dsh-runtime/node_modules/..."），
      // 而 runtimeManifestFile() = <resourcesPath>/dsh-runtime-manifest.json，
      // 所以 base 就是它所在的那个目录。
      const missing = findAllMissing(path.dirname(runtimeManifestFile()), manifest);
      if (missing.length === 0) {
        out.push({ id: 'runtime', label: 'Harness 运行时', status: 'ok', detail: manifest.fileCount + ' 个文件全部在位' });
      } else {
        out.push({
          id: 'runtime',
          label: 'Harness 运行时',
          status: 'bad',
          detail: '缺 ' + missing.length + ' 个文件（共 ' + manifest.fileCount + ' 个）——运行时被删或被杀软误删',
          fix: 'restore-runtime',
        });
      }
    }
  } catch (err) {
    out.push({ id: 'runtime', label: 'Harness 运行时', status: 'warn', detail: '检查失败：' + String(err) });
  }

  // 3) profile 锁
  try {
    const profilesDir = path.join(dshHomeDir(), 'profiles');
    const locks = fs.existsSync(profilesDir)
      ? fs.readdirSync(profilesDir).filter((f) => f.endsWith('.lock'))
      : [];
    if (locks.length === 0) {
      out.push({ id: 'locks', label: 'profile 锁', status: 'ok', detail: '没有残留锁' });
    } else {
      out.push({
        id: 'locks',
        label: 'profile 锁',
        status: 'warn',
        detail: '有 ' + locks.length + ' 个锁文件（上次可能被强杀）：' + locks.join('、'),
        fix: 'clear-locks',
      });
    }
  } catch (err) {
    out.push({ id: 'locks', label: 'profile 锁', status: 'warn', detail: '检查失败：' + String(err) });
  }

  // 4) 补丁层
  try {
    const effective = path.join(userDataDir(), 'desktop-patch.effective.yml');
    const base = path.join(userDataDir(), 'desktop-patch.yml');
    const which = fs.existsSync(effective) ? effective : fs.existsSync(base) ? base : null;
    if (which === null) {
      out.push({ id: 'patch', label: '桌面补丁', status: 'ok', detail: '没有自定义补丁（用内置的）' });
    } else {
      const size = fs.statSync(which).size;
      out.push({
        id: 'patch',
        label: '桌面补丁',
        status: 'ok',
        detail: '生效补丁：' + path.basename(which) + '（' + size + ' 字节）',
      });
    }
  } catch (err) {
    out.push({ id: 'patch', label: '桌面补丁', status: 'warn', detail: '检查失败：' + String(err) });
  }

  // 5) 打包目录完整性级别（火绒会给 dist 打低完整性标签，导致 NSIS 失败）
  try {
    const target = path.join(process.cwd(), 'dist');
    if (!fs.existsSync(target)) {
      out.push({ id: 'integrity', label: '目录完整性级别', status: 'ok', detail: '没有 dist 目录（非开发环境，跳过）' });
    } else {
      // 只诊断：改 ACL 是安全敏感操作，命令交给用户自己执行
      const has = await hasLowIntegrity(target);
      out.push(
        has
          ? {
              id: 'integrity',
              label: '目录完整性级别',
              status: 'warn',
              detail:
                'dist 被打上低完整性标签，打包会在 NSIS 步骤失败（弹窗「Error writing temporary file」，日志里看不到）。' +
                '修复命令：icacls "' + target + '" /setintegritylevel "(OI)(CI)H"（不要加 /T）',
            }
          : { id: 'integrity', label: '目录完整性级别', status: 'ok', detail: 'dist 没有异常标签' },
      );
    }
  } catch (err) {
    out.push({ id: 'integrity', label: '目录完整性级别', status: 'warn', detail: '检查失败：' + String(err) });
  }

  return out;
}

/** 用 icacls 查是否带 Low 标签（只读）。 */
function hasLowIntegrity(target: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn('icacls', [target], { windowsHide: true });
      let out = '';
      p.stdout?.on('data', (d) => { out += String(d); });
      p.on('error', () => resolve(false));
      p.on('close', () => resolve(/Mandatory Label\\Low/i.test(out)));
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// 修复动作
// ---------------------------------------------------------------------------

/** 修复动作的注册表：id → 实现。界面只认 id。 */
export const FIXES: Record<string, () => Promise<FixResult> | FixResult> = {
  /** 进安全模式：收敛 bundles 为内置集合。 */
  'safe-mode': () => {
    const before = thirdPartyBundles();
    process.env[SAFE_MODE_ENV] = '1';
    const r = prepareBundles();
    return {
      ok: true,
      message:
        '已进入安全模式：把 ' + before.third.length + ' 个第三方插件收敛为内置集合（' +
        r.bundles.length + ' 项）。重启后 Harness 会用最小配置启动。' +
        '原始列表已备份，修复插件后可在恢复工具里点「恢复正常启动」。',
      needsRestart: true,
    };
  },

  /** 退出安全模式：恢复原始 bundles。 */
  'normal-mode': () => {
    delete process.env[SAFE_MODE_ENV];
    const r = prepareBundles();
    return {
      ok: true,
      message: '已恢复正常启动：bundles 恢复为 ' + r.bundles.length + ' 项。重启后生效。',
      needsRestart: true,
    };
  },

  /** 从 tar 补回缺失的运行时文件。 */
  'restore-runtime': () =>
    new Promise<FixResult>((resolve) => {
      const tar = runtimeTarFile();
      if (!fs.existsSync(tar)) {
        resolve({ ok: false, message: '找不到运行时压缩包：' + tar + '（需要重新安装应用）' });
        return;
      }
      const dest = path.dirname(dshRuntimeDir());
      const script = extractRuntimeScript();
      log('恢复工具：开始从 tar 补回运行时文件');
      const p = spawn(process.execPath, [script, '--tar', tar, '--dest', dest], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
      });
      let out = '';
      p.stdout?.on('data', (d) => { out += String(d); });
      p.stderr?.on('data', (d) => { out += String(d); });
      p.on('error', (err) => resolve({ ok: false, message: '启动解压失败：' + String(err) }));
      p.on('close', (code) => {
        resolve({
          ok: code === 0,
          message: code === 0
            ? '运行时已补齐。解压器输出：' + (out.trim().split('\n').pop() ?? '')
            : '解压器退出码 ' + code + '：' + out.trim().slice(-400),
          needsRestart: true,
        });
      });
    }),

  /** 清理残留的 profile 锁。 */
  'clear-locks': () => {
    const profilesDir = path.join(dshHomeDir(), 'profiles');
    const removed: string[] = [];
    const failed: string[] = [];
    if (fs.existsSync(profilesDir)) {
      for (const f of fs.readdirSync(profilesDir)) {
        if (!f.endsWith('.lock')) continue;
        try {
          fs.rmSync(path.join(profilesDir, f), { force: true });
          removed.push(f);
        } catch (err) {
          failed.push(f + '（' + String(err) + '）');
        }
      }
    }
    return {
      ok: failed.length === 0,
      message: removed.length
        ? '已删除 ' + removed.length + ' 个锁文件' + (failed.length ? '，失败 ' + failed.length + ' 个：' + failed.join('；') : '')
        : '没有需要清理的锁',
    };
  },

  /** 停用桌面补丁（补丁写坏时的逃生舱）。 */
  'disable-patch': () => {
    const dir = userDataDir();
    const moved: string[] = [];
    for (const name of ['desktop-patch.yml', 'desktop-patch.effective.yml']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      const bak = f + '.disabled-' + Date.now();
      try {
        fs.renameSync(f, bak);
        moved.push(path.basename(bak));
      } catch (err) {
        return { ok: false, message: '重命名 ' + name + ' 失败：' + String(err) };
      }
    }
    return moved.length
      ? {
          ok: true,
          message: '已停用补丁（重命名为 ' + moved.join('、') + '）。重启后会使用内置补丁。要恢复就把文件名改回去。',
          needsRestart: true,
        }
      : { ok: false, message: '没有找到可停用的补丁文件' };
  },

  /** 打开数据目录（人工排查用）。 */
  'open-data-dir': () => ({
    ok: true,
    message: path.join(dshHomeDir()),
  }),
};

/** 当前是否处于安全模式（供界面显示）。 */
export function currentSafeMode(): boolean {
  return safeModeRequested();
}

/** 供界面显示的环境摘要。 */
export function environmentSummary(): Record<string, string> {
  return {
    应用数据: userDataDir(),
    dsh数据: dshHomeDir(),
    运行时: dshRuntimeDir(),
    平台: process.platform + ' ' + os.arch(),
    Node: process.versions.node,
    Electron: process.versions.electron ?? '(未知)',
  };
}
