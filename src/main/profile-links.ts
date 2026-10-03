/**
 * 启动自检：把 profile 共享 node_modules 里的「陈旧链接」替换成当前活动运行时的包。
 *
 * 【为什么】
 * dsh 的加载器**以 profile 目录为基准**解析插件包名（报错形如
 * 'Cannot find package X imported from .../profiles/web/'），而 profile 自己那份
 * profiles/web/node_modules 只装第三方 bundle 的依赖 —— harness 自身的包不在里面。
 * 于是 dsh 会把**自身依赖闭包**以 junction/symlink 的形式链进
 * $DSH_HOME/profiles/node_modules（0.1.x 的 healProfilesModuleFallback 行为）。
 *
 * 【问题】
 * 这些链接**按当时运行的那份运行时**写死目标，且**没有任何版本校验或清理**：
 *   · 0.2.0 只保留了 removeLinkProjections，且它只清理旧式
 *     .dsh-module-fallback 链接，管不到这种直指运行时目录的链接；
 *   · dsh-app-boot 的 linkedProfileRoots 反而把「指向 profiles 树之外」的
 *     链接**当作合法解析根**（不再修复）。
 *
 * 结果：只要机器上先后跑过两份不同的运行时（开发态 + 安装版、或换过安装路径），
 * profile 里就会**残留指向旧运行时的链接**，而进程入口用的是新的 ——
 * 同一个进程里两套 harness 并存，同名插件被实例化两次。
 *
 * 实测症状：resume 会话时 composeAgent -> mountPreset 二次挂载 preset 的插件，
 * 撞上根层已注册的同名工具，报
 *   tool "read" is already registered (for a per-agent variant, register through
 *   that agent's agent.ctx instead)
 * 并把 ptc preset 的整套工具（read/glob/job_output/skill/...）全部列出来。
 *
 * 【本自检做什么】
 * 扫 $DSH_HOME/profiles/node_modules（顶层 + @scope 下一层）里的 reparse point：
 *   · 目标**不在**当前活动运行时目录下 -> 陈旧
 *       - 当前运行时里有同名包 -> 替换为指向它
 *       - 没有 -> 删除（那是旧版独有的包，留着只会让旧代码被加载）
 *   · 目标是普通目录（pnpm 装的第三方包）-> 一律不动
 *
 * 幂等：目标已正确时不做任何写操作。整体失败只记日志、不阻断启动。
 */
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

export interface ProfileLinkRepairResult {
  /** 检查过的 reparse point 数量 */
  scanned: number;
  /** 重指到当前运行时的数量 */
  repointed: number;
  /** 因当前运行时没有同名包而删除的数量 */
  removed: number;
  /** 保持不动（目标已正确）的数量 */
  kept: number;
  /** 出错信息（不阻断启动） */
  problems: string[];
}

/** 顶层 + @scope 下一层的 reparse point（与 dsh-app-boot 的 symlinksUnder 同口径）。 */
function reparsePointsUnder(modulesDir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(modulesDir, entry.name);
    if (entry.isSymbolicLink()) {
      out.push(full);
      continue;
    }
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (child.isSymbolicLink()) out.push(path.join(full, child.name));
      }
    }
  }
  return out;
}

/** 读 reparse point 的目标；读不到（普通目录/已损坏）返回 null。 */
function linkTargetOf(p: string): string | null {
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return null;
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

/** Windows 的 junction 读出来是绝对路径；相对符号链接按所在目录解析。 */
function resolveTarget(p: string, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(path.dirname(p), target);
}

/** 目标是否已在给定根之下（同根或更深）。 */
function underRoot(target: string, root: string): boolean {
  const a = path.resolve(target);
  const b = path.resolve(root);
  return a === b || a.startsWith(b + path.sep);
}

/** 删除链接本身（junction 用 rmdir 语义，不递归进目标）。 */
function unlinkOnly(p: string): void {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) fs.rmdirSync(p);
  else fs.unlinkSync(p);
}

/** 建目录链接；优先 junction（Windows 上无需提权，且删链接不影响目标）。 */
function makeLink(linkPath: string, target: string): void {
  try {
    fs.symlinkSync(target, linkPath, 'junction');
    return;
  } catch {
    /* 非 Windows 或 junction 不支持时退回 dir 类型符号链接 */
  }
  fs.symlinkSync(target, linkPath, 'dir');
}

/**
 * 修复 profile 共享 node_modules 里的陈旧链接。
 *
 * @param profileModulesDir - $DSH_HOME/profiles/node_modules
 * @param runtimeDir - 当前**活动**运行时目录（findRuntimeDir() 的结果）
 */
export function ensureProfileModuleLinks(profileModulesDir: string, runtimeDir: string): ProfileLinkRepairResult {
  const result: ProfileLinkRepairResult = { scanned: 0, repointed: 0, removed: 0, kept: 0, problems: [] };
  if (!fs.existsSync(profileModulesDir)) return result;

  // 当前运行时的包根。链接目标应指向它下面的同名相对路径。
  const runtimeModules = path.join(runtimeDir, 'node_modules');
  if (!fs.existsSync(runtimeModules)) return result;

  const links = reparsePointsUnder(profileModulesDir);
  result.scanned = links.length;

  for (const linkPath of links) {
    try {
      const rawTarget = linkTargetOf(linkPath);
      if (rawTarget === null) continue; // 不是链接（普通目录）-> 不动
      const target = resolveTarget(linkPath, rawTarget);

      // 已经在当前运行时下 -> 正确，保持不动
      if (underRoot(target, runtimeModules)) {
        result.kept++;
        continue;
      }

      const rel = path.relative(profileModulesDir, linkPath);
      const candidate = path.join(runtimeModules, rel);

      unlinkOnly(linkPath);

      if (fs.existsSync(candidate)) {
        makeLink(linkPath, candidate);
        result.repointed++;
        log(`陈旧插件链接已重指：${rel} -> ${candidate}`);
      } else {
        // 当前运行时没有这个包（旧版独有）-> 删掉，否则旧代码仍会被加载
        result.removed++;
        log(`陈旧插件链接已删除（当前运行时无此包）：${rel}`);
      }
    } catch (err) {
      result.problems.push(`${linkPath}: ${String(err)}`);
    }
  }

  if (result.repointed > 0 || result.removed > 0) {
    log(`profile 插件链接自检：重指 ${result.repointed}、删除 ${result.removed}、保持 ${result.kept}（共 ${result.scanned}）`);
  }
  return result;
}
