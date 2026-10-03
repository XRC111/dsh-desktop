/**
 * 安全模式：不加载任何第三方模块，用最小配置把 Harness 拉起来。
 *
 * ── 解决什么问题 ────────────────────────────────────────────────────────────
 * dsh 的插件加载是**全有或全无**的：profile 的 \`dsh.profile.bundles\` 里只要有一个
 * 包解析不到、或它自带的补丁语法坏了，加载器就抛
 *   \`plugin tree failed to load: loader entries failed to apply\`
 * 进程 exit=1 —— 表现是「应用打开后 Harness 永远起不来」，而且用户没有任何
 * 可操作的界面去关掉那个坏插件（界面本身就跑在 dsh 里）。
 *
 * 这正是「装了个坏插件 → 整个应用变砖」的路径。安全模式给出逃生舱。
 *
 * ── 做法 ────────────────────────────────────────────────────────────────────
 * 不动用户数据，只在**启动时**把 profile 的 bundles 换成「只留内置」的最小集合：
 *
 *   1) 第一次进入安全模式前，把原始 bundles 备份到 safe-bundles.json
 *      （只备份一次，之后反复进出安全模式不会把「安全集合」当成原始值备份）
 *   2) 正常启动 → 从备份恢复原始 bundles
 *      安全启动 → 写入最小 bundles
 *
 * 为什么每次启动都重写而不是「进入时改、退出时改回」：dsh 可能崩溃/被强杀，
 * 「退出时恢复」就永远不执行了。每次启动按模式重写是**幂等**的，无论上次怎么死的，
 * 状态都由本次启动决定。
 *
 * ── 为什么不只靠 --patch ────────────────────────────────────────────────────
 * 补丁层能 disable 条目，但 bundles 里的第三方包**各自贡献自己的补丁**，
 * 要禁用就得先枚举它们的所有条目 id（还得先成功加载才知道）。直接换 bundles
 * 是从源头切断，最可靠。
 */
import * as fs from 'fs';
import * as path from 'path';
import { dshHomeDir, userDataDir } from './paths';
import { log } from './logger';

/** 内置 bundle：这些是 dsh 自带的，任何情况下都该保留。 */
const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
]);

/** 安全模式的开关（环境变量，便于命令行/快捷方式直接指定）。 */
export const SAFE_MODE_ENV = 'DSH_DESKTOP_SAFE_MODE';

/** 当前进程是否要求安全模式。 */
export function safeModeRequested(): boolean {
  const v = process.env[SAFE_MODE_ENV];
  return v === '1' || v === 'true';
}

/** 备份文件：存「用户原本的 bundles」。 */
function backupFile(): string {
  return path.join(userDataDir(), 'safe-bundles.json');
}

/** 一个 profile 的 package.json 路径。 */
function profileManifest(profileName: string): string {
  return path.join(dshHomeDir(), 'profiles', profileName, 'package.json');
}

interface Backup {
  version: 1;
  profile: string;
  bundles: string[];
  at: number;
}

/**
 * 读取/建立原始 bundles 备份。
 *
 * 关键点：**只在备份不存在时写**。如果每次都写，第二次进安全模式就会把
 * 「只剩内置」的安全集合当成原始值存下来，之后正常启动也恢复不回去了 ——
 * 那是不可逆的数据损坏。
 */
function ensureBackup(profileName: string, current: string[]): string[] {
  const file = backupFile();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Partial<Backup>;
    if (Array.isArray(data.bundles) && data.profile === profileName) return data.bundles;
    // 换了 profile：旧备份不适用，重新备份
  } catch {
    /* 没有或损坏，下面重建 */
  }
  const data: Backup = { version: 1, profile: profileName, bundles: current, at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    log('已备份原始 bundle 列表（' + current.length + ' 项）→ ' + file);
  } catch (err) {
    log('备份 bundle 列表失败（安全模式仍会继续，但退出安全模式后可能需手动恢复）：' + String(err));
  }
  return current;
}

export interface SafeModeResult {
  /** 实际是否进入了安全模式 */
  safe: boolean;
  /** 本次写入了哪些 bundle */
  bundles: string[];
  /** 被排除掉的第三方 bundle（安全模式下） */
  excluded: string[];
}

/**
 * 按当前模式准备 profile 的 bundles。
 *
 * 必须在**启动 dsh 之前**调用。任何失败都不抛异常 —— 它只是让「逃生舱」失效，
 * 不该反过来阻断正常启动。
 */
export function prepareBundles(profileName = 'web'): SafeModeResult {
  const file = profileManifest(profileName);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    log('读取 profile manifest 失败，跳过安全模式处理：' + String(err));
    return { safe: false, bundles: [], excluded: [] };
  }

  const dsh = (manifest.dsh ?? {}) as Record<string, unknown>;
  const profile = (dsh.profile ?? {}) as Record<string, unknown>;
  const current = Array.isArray(profile.bundles) ? (profile.bundles as string[]) : [];
  if (current.length === 0) {
    return { safe: false, bundles: [], excluded: [] };
  }

  const want = safeModeRequested();
  const backup = ensureBackup(profileName, current);
  const target = want ? current.filter((b) => INBOX_BUNDLES.has(b)) : backup;

  const same =
    target.length === current.length && target.every((b, i) => b === current[i]);
  if (!same) {
    profile.bundles = target;
    dsh.profile = profile;
    manifest.dsh = dsh;
    try {
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      log(
        (want ? '安全模式：已把 bundles 收敛为内置集合' : '已恢复原始 bundles') +
          '（' + current.length + ' → ' + target.length + ' 项）',
      );
    } catch (err) {
      log('写入 profile manifest 失败：' + String(err));
      return { safe: false, bundles: current, excluded: [] };
    }
  }

  const excluded = current.filter((b) => !target.includes(b));
  return { safe: want, bundles: target, excluded };
}

/** 安全模式下不该做的事，集中在这里供 boot 判断。 */
export function shouldSkipHeavyStartup(safe: boolean): boolean {
  // 安全模式下跳过：插件落位、热壳、可选 bundle 启用 —— 它们都可能引入坏东西。
  // 保留：运行时自检与修复（那是「让 dsh 能起来」的前提）。
  return safe;
}
