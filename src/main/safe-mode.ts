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
 *   安全启动 → 把「剥离前的那份 bundles」存进 safe-bundles.json（带 stripped
 *              标记），再把 profile 收敛为最小集合
 *   正常启动 → 备份带 stripped 标记 → 从备份还原（并清掉标记）
 *              备份没带标记   → 什么都不做，只把备份刷新成当前这份
 *
 * 为什么每次启动都重写而不是「进入时改、退出时改回」：dsh 可能崩溃/被强杀，
 * 「退出时恢复」就永远不执行了。每次启动按模式重写是**幂等**的，无论上次怎么死的，
 * 状态都由本次启动决定。
 *
 * ── stripped 标记为什么必须有 ────────────────────────────────────────────────
 * 备份以前是「第一次见到就写死、之后永不更新」，而正常启动**无条件**拿它覆盖
 * profile —— 于是任何在备份建立之后才启用的插件，都会在下次启动被抹掉：备份里
 * 没有它，覆盖就等于删掉它。
 *
 * 插件市场（dshmarket）启用插件正是往 dsh.profile.bundles 里追加包名，所以
 * 「市场里点启用 → 当时好使 → 重启后全没了」就是这么来的。实测日志：
 *   13:30:51  已备份原始 bundle 列表（2 项）→ safe-bundles.json   ← 那时还没装插件
 *   13:33:07  已恢复原始 bundles（6 → 2 项）                      ← 刚启用的 3 个被抹
 *
 * 标记把两件事分开了：**安全模式剥离过的**才需要回滚，**用户自己改的**（插件市场、
 * 官方插件页、手改 package.json）永远以当前为准。
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
  /**
   * 这份 bundles 是不是「安全模式剥离前」存下来的。
   *
   * true  = 它是被安全模式换掉的那份，正常启动要拿它还原
   * false/缺省 = 它只是当前这份的镜像，正常启动不该拿它覆盖任何东西
   *
   * 旧版本（v10.1.8 及以前）写出的文件没有这个字段，读出来就是 false —— 正好
   * 是想要的语义：那些文件里的列表往往是「还没装插件时」的旧快照，拿它覆盖
   * 只会误删用户后来启用的插件。缺字段当作 false，等于让老文件自动失效。
   */
  stripped?: boolean;
}

/** 读备份文件。读不到/坏了/换了 profile 都返回 null。 */
function readBackup(profileName: string): Backup | null {
  try {
    const data = JSON.parse(fs.readFileSync(backupFile(), 'utf8')) as Partial<Backup>;
    if (!Array.isArray(data.bundles) || data.profile !== profileName) return null;
    return {
      version: 1,
      profile: profileName,
      bundles: data.bundles,
      at: typeof data.at === 'number' ? data.at : Date.now(),
      stripped: data.stripped === true,
    };
  } catch {
    return null;
  }
}

/** 写备份文件。失败只记日志 —— 逃生舱失效不该反过来阻断启动。 */
function writeBackup(data: Backup, what: string): void {
  const file = backupFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    log(`${what}（${data.bundles.length} 项${data.stripped ? '，安全模式剥离前' : ''}）→ ${file}`);
  } catch (err) {
    log('写入 bundle 备份失败（安全模式仍会继续，但退出安全模式后可能需手动恢复）：' + String(err));
  }
}

const sameBundles = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

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
 *
 * 三种情形（`stripped` 标记决定走哪条，见文件头）：
 *   安全启动                     → 收敛为内置集合，并把剥离前那份存成 stripped 备份
 *   正常启动 + 备份 stripped      → 从备份还原，随后清掉标记
 *   正常启动 + 备份未 stripped    → 什么都不动，当前这份就是用户的选择
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
  const backup = readBackup(profileName);
  // 只有「安全模式剥离过」的备份才有资格覆盖 profile。镜像（未带标记）永远不覆盖：
  // 它只是记录，拿它覆盖就是本文档开头那个「重启后插件全没了」。
  const restoring = !want && backup?.stripped === true;
  const target = want
    ? current.filter((b) => INBOX_BUNDLES.has(b))
    : restoring
      ? (backup as Backup).bundles
      : current;

  const same = sameBundles(target, current);
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
      // 没写成就别碰备份：还原可以下次启动再来一次。
      return { safe: false, bundles: current, excluded: [] };
    }
  }

  // 备份维护放在写文件**之后**：
  //   · 进安全模式 → 存下剥离前那份并打标记（已有标记就不覆盖，否则会把「只剩
  //     内置」当成原始值存下来，之后再也回不去）
  //   · 还原完成   → 清掉标记，免得它下次启动又把这份旧列表盖回来
  //   · 正常启动   → 把镜像刷新成当前这份，文件始终是「用户上一次的选择」
  const strippedNow = current.filter((b) => !INBOX_BUNDLES.has(b));
  if (want) {
    if (backup?.stripped !== true && strippedNow.length > 0) {
      writeBackup(
        { version: 1, profile: profileName, bundles: current, at: Date.now(), stripped: true },
        '已备份安全模式剥离前的 bundle 列表',
      );
    }
  } else if (restoring) {
    writeBackup(
      { version: 1, profile: profileName, bundles: target, at: Date.now(), stripped: false },
      '已还原 bundle 列表并清除剥离标记',
    );
  } else if (!sameBundles(backup?.bundles ?? [], target)) {
    writeBackup(
      { version: 1, profile: profileName, bundles: target, at: Date.now(), stripped: false },
      '已同步 bundle 列表备份',
    );
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
