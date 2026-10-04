/**
 * 把桌面适配插件安装到 dsh 能解析到的位置。
 *
 * 背景（这是踩过的坑，别绕开）：
 * dsh 的 cordis 加载器**以 profile 目录为基准**解析插件包名 —— 失败信息长这样：
 *   Cannot find package '@dsh-desktop/directory-picker' imported from
 *   C:\…\dsh-home\profiles\web\
 * 也就是说，把插件放进 dsh 运行时的 node_modules **没有用**（那不是 profile 的祖先目录）。
 *
 * 而 dsh 自己的 `healProfilesModuleFallback()` 只把**它自身安装依赖闭包里**的包
 * 链进 `$DSH_HOME/profiles/node_modules`（symlink 或 ESM proxy），我们的包不在那个闭包里，
 * 永远不会被链上。所以只能由桌面外壳在每次启动、**在 dsh 起来之前**把插件放进
 * `$DSH_HOME/profiles/node_modules/`。
 *
 * 落位规则（v2）：按各插件自己 package.json 的 `name` 解析目标路径 ——
 *   * `@dsh-desktop/directory-picker` → `profiles/node_modules/@dsh-desktop/directory-picker`
 *   * `dshmarket`（无 scope 的社区包）→ `profiles/node_modules/dshmarket`
 * 这样内置的第三方包（如 dsh-market 插件市场）与我们的自研插件走同一条链路。
 * 第三方包的依赖以「嵌套 node_modules」的形式随包分发（见 resources/dsh-plugins/dshmarket）。
 *
 * 性能：带版本戳（.dsh-desktop-managed.json），源版本没变就直接跳过复制 ——
 * dshmarket 连依赖有数百个文件，每次启动全量复制在慢盘上会拖慢启动。
 *
 * 这就是「允许启动后自动配置/修复环境」这条授权的具体落地：只写我们自己的
 * 用户数据目录，不碰安装目录、不碰 Harness 源码。
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { dshPluginsSourceDir, profileModulesDir, userPluginsDir } from './paths';
import { log } from './logger';

/** 我们自研插件的默认 scope（package.json 缺 name 时兜底用）。 */
export const PLUGIN_SCOPE = '@dsh-desktop';

/** 版本戳文件名：写在插件落位目录里，记录已安装的源版本。 */
const MARKER_FILE = '.dsh-desktop-managed.json';

export interface PluginInstallResult {
  /** 本次确认就位的插件包名（含跳过的未变更项）。 */
  installed: string[];
  /** 源里已不存在、被清掉的旧插件名。 */
  removed: string[];
  /** 出错信息（安装失败不阻断启动，只记日志）。 */
  problems: string[];
}

interface PkgInfo {
  name: string;
  version: string;
  /** 内容指纹（见 fingerprintOf） */
  fingerprint: string;
}

/**
 * 目录内容指纹：按「相对路径 + 大小 + mtime」排序后哈希。
 *
 * 为什么不能只看 package.json 的 version：插件改动时**经常忘记改版本号** ——
 * 实测 computer-use 从「只有 allowInput 总开关」重写成「5 个粒度开关」时版本号仍是 1.0.0，
 * 于是落位逻辑判定「版本没变」直接跳过复制，用户跑的一直是旧代码，
 * 表现为「改了插件但工具没出现」。指纹与版本号解耦，内容一变就一定重装。
 */
function fingerprintOf(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) continue; // 跳过符号链接等
      try {
        const st = fs.statSync(p);
        parts.push(r + ':' + st.size + ':' + Math.round(st.mtimeMs));
      } catch { /* 读不到就忽略 */ }
    }
  };
  walk(dir, '');
  parts.sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

function readPkgInfo(dir: string, fallbackName: string): PkgInfo | null {
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    // 没有 package.json 就不是插件：跳过，千万别兜底——否则会把
    // 下载暂存的 staging 目录当插件装进去，往 profile 里塞一个残缺的包。
    return null;
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    return {
      name: typeof pkg.name === 'string' && pkg.name ? pkg.name : `${PLUGIN_SCOPE}/${fallbackName}`,
      version: typeof pkg.version === 'string' ? pkg.version : '0',
      fingerprint: fingerprintOf(dir),
    };
  } catch {
    return null;
  }
}

/** 递归复制目录；目标先清空，避免删过的文件残留。 */
function copyDir(from: string, to: string): void {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

export function installPlugins(): PluginInstallResult {
  const result: PluginInstallResult = { installed: [], removed: [], problems: [] };
  const modulesRoot = profileModulesDir();

  // 插件来源（后面的优先）：
  //   1) 安装目录里随包分发的（resources/dsh-plugins）
  //   2) 用户数据目录里的（热更新/手动安装的，见 scripts/install-plugin.ps1）
  // 同名插件以**用户数据目录**的为准 —— 这样不用重打安装包也能换插件版本。
  const sources: Array<{ dir: string; tag: string }> = [
    { dir: dshPluginsSourceDir(), tag: '内置' },
    { dir: userPluginsDir(), tag: '热更新' },
  ];

  const plan: Array<{ srcDir: string; pkg: PkgInfo; dest: string; lastSegment: string; tag: string }> = [];
  const byName = new Map<string, (typeof plan)[number]>();
  /**
   * 被「热更新」源盖住、且内容指纹与内置不同的条目。
   *
   * 实测过的静默降级：用户数据目录里留着一份旧的同名插件，会一直赢过安装包内置的那份，
   * 而两者的 package.json version 可能**完全相同**（都是 1.0.0），只有内容指纹能区分 ——
   * 表现就是「明明升级了，设置页优化却没出现」。
   * 这里不改行为（热更新优先是设计意图），只把事实说出来。
   */
  const shadowed: Array<{ name: string; builtin: string; hot: string; hotFrom: string }> = [];

  for (const { dir: source, tag } of sources) {
    if (!fs.existsSync(source)) continue; // 开发态/未安装插件的机器可能没有
    let names: string[];
    try {
      names = fs
        .readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      result.problems.push(`读取插件源目录失败（${source}）：${String(err)}`);
      continue;
    }
    for (const name of names) {
      const srcDir = path.join(source, name);
      const pkg = readPkgInfo(srcDir, name);
      if (!pkg) {
        log(`跳过非插件目录：${name}（无 package.json）`);
        continue;
      }
      const item = {
        srcDir,
        pkg,
        dest: path.join(modulesRoot, ...pkg.name.split('/')),
        lastSegment: pkg.name.split('/').pop() ?? name,
        tag,
      };
      const shadow = byName.get(pkg.name);
      if (
        shadow &&
        shadow.tag === '内置' &&
        tag !== '内置' &&
        shadow.pkg.fingerprint !== pkg.fingerprint
      ) {
        shadowed.push({
          name: pkg.name,
          builtin: shadow.pkg.version,
          hot: pkg.version,
          hotFrom: srcDir,
        });
      }
      byName.set(pkg.name, item); // 后面的来源覆盖前面的
    }
  }
  {
    for (const item of byName.values()) plan.push(item);
  }
  for (const s of shadowed) {
    log(
      `注意：插件 ${s.name} 由用户数据目录提供（v${s.hot}），与安装包内置的 v${s.builtin} 内容不同 —— ` +
        `内置版本不会生效。若非有意锁旧版，删掉 ${s.hotFrom} 即可。`,
    );
  }
  if (plan.length === 0) return result;

  const keepSegments = new Set(plan.map((p) => p.lastSegment));

  // 清掉源里已不存在的旧插件（例如某个适配被回退）。
  // 只清理我们管理的目录：@dsh-desktop scope 下的、或根层带版本戳的。
  try {
    const scopeDir = path.join(modulesRoot, PLUGIN_SCOPE);
    if (fs.existsSync(scopeDir)) {
      for (const entry of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || keepSegments.has(entry.name)) continue;
        fs.rmSync(path.join(scopeDir, entry.name), { recursive: true, force: true });
        result.removed.push(`${PLUGIN_SCOPE}/${entry.name}`);
      }
    }
    if (fs.existsSync(modulesRoot)) {
      for (const entry of fs.readdirSync(modulesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || keepSegments.has(entry.name) || entry.name.startsWith('@')) continue;
        const marker = path.join(modulesRoot, entry.name, MARKER_FILE);
        if (!fs.existsSync(marker)) continue; // 不是我们装的，不碰
        fs.rmSync(path.join(modulesRoot, entry.name), { recursive: true, force: true });
        result.removed.push(entry.name);
      }
    }
  } catch (err) {
    result.problems.push(`清理旧插件失败：${String(err)}`);
  }

  for (const item of plan) {
    const markerPath = path.join(item.dest, MARKER_FILE);
    try {
      // 版本没变且入口仍在 → 跳过复制（启动更快）
      if (fs.existsSync(markerPath) && fs.existsSync(path.join(item.dest, 'package.json'))) {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as {
          version?: string;
          fingerprint?: string;
        };
        // 指纹优先：老戳没有 fingerprint 字段 → 视为需要重装（一次性升级代价，之后就走指纹）
        if (marker.fingerprint && marker.fingerprint === item.pkg.fingerprint) {
          result.installed.push(item.pkg.name);
          continue;
        }
      }
      copyDir(item.srcDir, item.dest);
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          version: item.pkg.version,
          fingerprint: item.pkg.fingerprint,
          managedBy: 'dsh-desktop',
        }),
      );
      result.installed.push(item.pkg.name);
    } catch (err) {
      result.problems.push(`安装插件 ${item.pkg.name} 失败：${String(err)}`);
    }
  }

  if (result.installed.length > 0) {
    log(`桌面适配插件已就位：${result.installed.join('、')}`);
    const hot = plan.filter((p) => p.tag === '热更新').map((p) => p.pkg.name);
    if (hot.length > 0) log(`  其中由用户数据目录提供（热更新/手动安装）：${hot.join('、')}`);
  }
  for (const problem of result.problems) log(problem);
  return result;
}
