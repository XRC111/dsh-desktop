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
  /** 被自动顶回内置版的插件（用户目录那份更旧）。 */
  healed: Array<{ name: string; builtin: string; hot: string; from: string }>;
  /** 内容不一致但**没有**自动修复的（第三方插件，或热更新那份更新）。 */
  shadowed: Array<{ name: string; builtin: string; hot: string; hotFrom: string; reason: string }>;
}

/** 最近一次 installPlugins 的结果，供诊断信息使用。 */
let lastResult: PluginInstallResult | null = null;
export function lastPluginInstall(): PluginInstallResult | null {
  return lastResult;
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

/**
 * **内容**哈希（不含 mtime）。
 *
 * 与 fingerprintOf 的区别很关键：fingerprintOf 掺了 mtime，只要两份拷贝的写入时间不同，
 * 哪怕字节完全一样也会得出不同指纹（实测：内置与用户目录的 shell/client.js sha256 都是
 * 7cf1dcdbd108，fingerprintOf 却给出 548171b5 / 91956aef）。所以它只能用来判断
 * 「源变没变、要不要重新复制」，**不能**用来判断「两份是不是同一份代码」。
 */
function contentHashOf(dir: string): string {
  const parts: string[] = [];
  const walk = (d: string, rel: string) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { walk(p, r); continue; }
      if (!e.isFile()) continue;
      try {
        parts.push(r + ':' + createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
      } catch { /* 读不到就忽略 */ }
    }
  };
  walk(dir, '');
  parts.sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const HASH_CACHE = 'plugin-content-hash-cache.json';

/**
 * 内容哈希缓存。
 *
 * 为什么要缓存：dshmarket 连依赖有 400+ 个文件、5.8MB，全量哈希实测约 115ms，
 * 两个源都算就是 230ms —— 每次启动都付这个代价不合理。
 * 缓存键用 fingerprintOf（含 mtime）：它一变内容必变，所以命中缓存的结果一定有效。
 */
function openHashCache(): { get: (dir: string, fp: string) => string; save: () => void } {
  const cacheFile = path.join(path.dirname(userPluginsDir()), HASH_CACHE);
  let cache: Record<string, { fp: string; hash: string }> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (raw && typeof raw === 'object') cache = raw as typeof cache;
  } catch { /* 首次运行或文件损坏都无所谓，重算一遍即可 */ }
  const memo = new Map<string, string>();
  return {
    get(dir, fp) {
      const done = memo.get(dir);
      if (done !== undefined) return done;
      const hit = cache[dir];
      const hash = hit && hit.fp === fp && typeof hit.hash === 'string' ? hit.hash : contentHashOf(dir);
      cache[dir] = { fp, hash };
      memo.set(dir, hash);
      return hash;
    },
    save() {
      try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch { /* 写不了就每次重算 */ }
    },
  };
}

/** 目录 mtime（取不到按 0，一律走保守分支） */
function mtimeOf(dir: string): number {
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
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

export function installPlugins(opts: { appVersion?: string } = {}): PluginInstallResult {
  const result: PluginInstallResult = {
    installed: [],
    removed: [],
    problems: [],
    healed: [],
    shadowed: [],
  };
  const modulesRoot = profileModulesDir();

  // 插件来源（后面的优先）：
  //   1) 安装目录里随包分发的（resources/dsh-plugins）
  //   2) 用户数据目录里的（热更新/手动安装的，见 scripts/install-plugin.ps1）
  //
  // 同名插件**默认**以用户数据目录的为准 —— 这样不用重打安装包也能换插件版本。
  // 但这条规则会被「残留的旧副本」滥用，所以下面要过一遍判据（见 plan 的构造）。
  type Item = { srcDir: string; pkg: PkgInfo; dest: string; lastSegment: string; tag: '内置' | '热更新' };
  const sources: Array<{ dir: string; tag: '内置' | '热更新' }> = [
    { dir: dshPluginsSourceDir(), tag: '内置' },
    { dir: userPluginsDir(), tag: '热更新' },
  ];
  const slots = new Map<string, { builtin?: Item; hot?: Item }>();

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
      const item: Item = {
        srcDir,
        pkg,
        dest: path.join(modulesRoot, ...pkg.name.split('/')),
        lastSegment: pkg.name.split('/').pop() ?? name,
        tag,
      };
      const slot = slots.get(pkg.name) ?? {};
      if (tag === '内置') slot.builtin = item;
      else slot.hot = item;
      slots.set(pkg.name, slot);
    }
  }
  // ── 决定每个插件由哪一份源生效 ───────────────────────────────────────────
  //
  // 只看 version 不够：自研插件的版本号常年不动（shell 一直是 1.0.0），内容却每版都变。
  // 只看 fingerprintOf 也不够：它掺了 mtime，同样内容会得出不同指纹。
  // 所以先比**内容哈希** —— 内容一致就谁赢都行；内容不同才按下面两条判据分派。
  const hashes = openHashCache();
  const plan: Item[] = [];
  for (const [name, slot] of slots) {
    if (!slot.hot) { if (slot.builtin) plan.push(slot.builtin); continue; }
    if (!slot.builtin) { plan.push(slot.hot); continue; }

    const bHash = hashes.get(slot.builtin.srcDir, slot.builtin.pkg.fingerprint);
    const hHash = hashes.get(slot.hot.srcDir, slot.hot.pkg.fingerprint);
    if (bHash === hHash) { plan.push(slot.hot); continue; } // 同一份代码，谁赢都一样

    const ours = name.startsWith(PLUGIN_SCOPE + '/');
    const builtinNewer = mtimeOf(slot.builtin.srcDir) > mtimeOf(slot.hot.srcDir);

    // 第三方插件：**只有版本号不一致时才值得说**。
    // 同为 1.66.1 而内容不同是正常的——安装包里那份是随包分发的目录，
    // 用户目录那份来自 feed 的 plugins-*.tar.gz，两者打包方式本就不同。
    // 不加这条判断就会每次启动都喊一次狼来了。
    if (!ours && slot.hot.pkg.version === slot.builtin.pkg.version) {
      plan.push(slot.hot);
      continue;
    }

    if (ours && builtinNewer) {
      // 自研插件：内置那份是随**本次安装**一起发布的，用户目录那份更旧 → 顶回内置。
      // 实测故障就是这么来的：残留的旧副本一直赢，安装包里新的设置页优化永远不生效，
      // 而两边版本号还都是 1.0.0，表面上看起来「版本没变」。
      plan.push(slot.builtin);
      result.healed.push({
        name,
        builtin: slot.builtin.pkg.version,
        hot: slot.hot.pkg.version,
        from: slot.hot.srcDir,
      });
      continue;
    }
    plan.push(slot.hot);
    result.shadowed.push({
      name,
      builtin: slot.builtin.pkg.version,
      hot: slot.hot.pkg.version,
      hotFrom: slot.hot.srcDir,
      reason: ours ? '用户目录那份更新，保留它' : '第三方插件归属插件市场，外壳不擅自替换',
    });
  }
  hashes.save();

  for (const h of result.healed) {
    log(
      `已自动修复插件影子：${h.name} 安装包内置 v${h.builtin} 比用户目录的 v${h.hot} 新，改用内置（原：${h.from}）`,
    );
  }
  for (const s of result.shadowed) {
    log(
      `注意：插件 ${s.name} 的用户目录副本（v${s.hot}）与安装包内置的 v${s.builtin} 内容不同，且会生效 —— ` +
        `${s.reason}（${s.hotFrom}）`,
    );
  }

  if (plan.length === 0) {
    lastResult = result;
    return result;
  }

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
          // 源变更检测用（含 mtime）：源没动就跳过重新复制
          fingerprint: item.pkg.fingerprint,
          // 内容哈希（不含 mtime）：用来判断「两份是不是同一份代码」
          contentHash: hashes.get(item.srcDir, item.pkg.fingerprint),
          // 这份是哪来的：内置随安装包，热更新来自用户数据目录
          srcTag: item.tag,
          // 落位时的外壳版本：判断用户目录那份是不是本次发布带来的
          appVersion: opts.appVersion ?? null,
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
  lastResult = result;
  return result;
}
