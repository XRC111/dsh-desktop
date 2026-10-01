import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { hotRoot } from './paths';
import { extractTarPure, extractWithSystemTar, hasSystemTar } from './tar-pure';

/**
 * 热更新壳（hot shell）：不跑安装包，下载一份新壳代码 → 重启应用即生效。
 *
 * 为什么可以这样：
 *   外壳自身的代码就是 app.asar 里的 out/（main + preload + renderer），
 *   而 preload / renderer 的路径都是**相对 __dirname 解析**的（见 window-manager.ts），
 *   所以只要把一份完整的 out/ 放到一个可写目录，让入口优先加载它，
 *   就等价于换了整个壳 —— 不用管理员权限、不用覆盖安装目录里被占用的文件。
 *
 * 目录约定（都在用户数据目录下，卸载时可保留/清除）：
 *   %APPDATA%\DSH-Desktop\hot\shell-<version>\{main,preload,renderer,hot-manifest.json}
 *   %APPDATA%\DSH-Desktop\hot\.attempt.json     启动尝试计数（崩溃自动回退用）
 *   %APPDATA%\DSH-Desktop\hot\.staging-*        下载解压中的临时目录
 *
 * 安全与稳健：
 *   - 只加载 baseVersion ≤ 当前安装版的壳（安装版低于基线 → 走安装包）
 *   - 启动时若热壳连续两次没能标记「已健康启动」，自动禁用该热壳并回退到内置壳
 *   - 热壳只是代码，dsh 运行时不受影响，所以重启后几秒就能用
 */

export interface HotShellInfo {
  /** 壳目录 */
  dir: string;
  /** 壳版本（hot-manifest.json 里的 version） */
  version: string;
  /** 入口文件（<dir>/main/boot.js） */
  entry: string;
  /** 打包这份壳时的安装版版本 */
  baseVersion: string;
  installedAt?: number;
}

export interface HotManifest {
  version: string;
  baseVersion: string;
  builtAt?: string;
  sha256?: string;
  size?: number;
  source?: string;
}

const MANIFEST = 'hot-manifest.json';
const ATTEMPT = '.attempt.json';
/** 连续多少次启动失败就判定这个壳是坏的 */
const MAX_BOOT_ATTEMPTS = 2;

/**
 * 生效壳目录名：`shell-<version>-<epoch>`。
 *
 * 为什么带时间戳：**绝不能重命名或覆盖正在运行的那份壳**——
 * 进程里的 __dirname 指向它，一改名运行的代码就被抽走了（父目录还会被清理删掉）。
 * 每次落位用全新目录，旧目录等下次启动清理，谁在跑就不动谁。
 */
const SHELL_DIR_RE = /^shell-(.+)-(\d+)$/;

/** 目录名 → 是否为本应用管理的生效壳目录（.prev/.broken/.rolled-back/.staging 都不算） */
function isShellDir(name: string): boolean {
  return SHELL_DIR_RE.test(name);
}

/** 本进程实际加载的热壳（由引导器设置；注意跨模块实例不可见，见 selfHotShell） */
let loaded: HotShellInfo | null = null;

/**
 * 从**当前模块自身的位置**推断：本实例是不是跑在热更新壳里。
 *
 * 为什么需要它：热壳被加载后，`main/boot.js` 里的 `./hot-shell` 会解析到
 * **热壳目录里的那一份**，与引导器（app.asar 里那份）是两个不同的模块实例 ——
 * 模块级变量不共享。所以不能只靠 loaded，必须能从文件位置自证身份。
 */
function selfHotShell(): HotShellInfo | null {
  const dir = path.dirname(__dirname); // <shell 目录>/main → <shell 目录>
  const root = hotRoot();
  let rel = '';
  try {
    rel = path.relative(root, dir);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.includes(path.sep) || !isShellDir(path.basename(dir))) return null;
  const manifest = readManifest(dir);
  if (!manifest) return null;
  return {
    dir,
    version: manifest.version,
    entry: path.join(dir, 'main', 'boot.js'),
    baseVersion: manifest.baseVersion,
    installedAt: manifest.builtAt ? Date.parse(manifest.builtAt) : undefined,
  };
}

// ---------------------------------------------------------------------------
// 版本比较（与 updater.ts 同规则，这里独立一份以避免引导阶段引入依赖）
// ---------------------------------------------------------------------------

function parseVersion(v: string): { nums: number[]; pre: string[] } {
  let s = String(v).trim().replace(/^v/i, '');
  // 平台变体后缀（如 Win7 特供包的 `-w7`）不是预发布，与 updater.ts 同规则：
  // 若当预发布处理，`1.1.14-w7` 会被判成低于 `1.1.14`，下面的基线校验会跟着出错。
  s = s.replace(/-w7$/i, '');
  const [core, ...rest] = s.split('-');
  return {
    nums: core.split('.').map((str) => {
      const n = parseInt(str.replace(/[^0-9]/g, ''), 10);
      return Number.isFinite(n) ? n : 0;
    }),
    pre: rest.join('-').split('.').filter(Boolean),
  };
}

export function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = va.nums[i] ?? 0;
    const y = vb.nums[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (va.pre.length === 0 && vb.pre.length > 0) return 1;
  if (va.pre.length > 0 && vb.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(va.pre.length, vb.pre.length); i++) {
    const x = va.pre[i];
    const y = vb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 读取
// ---------------------------------------------------------------------------

function readManifest(dir: string): HotManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')) as HotManifest;
    if (!raw?.version || !raw?.baseVersion) return null;
    return raw;
  } catch {
    return null;
  }
}

/** 壳目录里该有的东西都在吗 */
function hasShellFiles(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'main', 'boot.js')) &&
    fs.existsSync(path.join(dir, 'preload', 'index.js')) &&
    fs.existsSync(path.join(dir, 'renderer', 'loading.html'))
  );
}

function listShellDirs(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isShellDir(e.name))
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

interface Attempt {
  version: string;
  count: number;
  at: number;
}

function readAttempt(root: string): Attempt | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ATTEMPT), 'utf8')) as Attempt;
  } catch {
    return null;
  }
}

function writeAttempt(root: string, attempt: Attempt): void {
  try {
    fs.writeFileSync(path.join(root, ATTEMPT), JSON.stringify(attempt), 'utf8');
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 选择与加载
// ---------------------------------------------------------------------------

/**
 * 选出生效的热壳。
 *
 * 约束：
 *   - baseVersion ≤ 当前安装版（app.getVersion()）→ 安装版低于基线就回退安装包
 *   - 取版本号最高的一个
 *   - 若上一次启动标记了「未健康启动」且已达上限 → 判为坏壳，改名禁用并回退
 */
export function resolveHotShell(): HotShellInfo | null {
  const root = hotRoot();
  if (!fs.existsSync(root)) return null;

  const builtin = app.getVersion();
  const attempt = readAttempt(root);

  const candidates: Array<{ key: string; info: HotShellInfo; manifest: HotManifest }> = [];
  for (const dir of listShellDirs(root)) {
    if (!hasShellFiles(dir)) {
      log(`热壳目录不完整，忽略：${dir}`);
      continue;
    }
    const manifest = readManifest(dir);
    if (!manifest) continue;
    // 与 installHotShell 同语义：安装版低于基线才跳过（≥ 基线即兼容）。
    // 严格相等会让热更机器（安装版停在最初安装包）之外的一切全新安装加载不了热壳。
    if (compareVersions(builtin, manifest.baseVersion) < 0) {
      log(`热壳 ${manifest.version} 要求安装版 ≥ ${manifest.baseVersion}，当前 ${builtin}，跳过`);
      continue;
    }
    candidates.push({
      key: manifest.version,
      manifest,
      info: {
        dir,
        version: manifest.version,
        entry: path.join(dir, 'main', 'boot.js'),
        baseVersion: manifest.baseVersion,
        installedAt: manifest.builtAt ? Date.parse(manifest.builtAt) : undefined,
      },
    });
  }

  if (candidates.length === 0) return null;
  // 版本高的优先；同版本取最近落位的那个
  candidates.sort((a, b) => {
    const v = compareVersions(a.key, b.key);
    if (v !== 0) return v;
    return (a.info.installedAt ?? 0) - (b.info.installedAt ?? 0);
  });
  const best = candidates[candidates.length - 1];

  // 坏壳保护：上次启动加载了同一个版本但没标记健康
  if (attempt && attempt.version === best.info.version && attempt.count >= MAX_BOOT_ATTEMPTS) {
    const broken = `${best.info.dir}.broken`;
    log(`热壳 ${best.info.version} 连续 ${attempt.count} 次启动未成功，禁用并回退到内置壳`);
    try {
      fs.renameSync(best.info.dir, broken);
      fs.rmSync(path.join(root, ATTEMPT), { force: true });
    } catch (err) {
      log(`禁用坏壳失败：${String(err)}`);
    }
    const rest = candidates.slice(0, -1);
    if (rest.length === 0) return null;
    const fallback = rest[rest.length - 1];
    loaded = fallback.info;
    return fallback.info;
  }

  loaded = best.info;
  return best.info;
}

/** 引导器在加载热壳前登记一次尝试（热壳跑起来后会调 markShellHealthy 清掉） */
export function noteBootAttempt(info: HotShellInfo): void {
  const root = hotRoot();
  const prev = readAttempt(root);
  const count = prev && prev.version === info.version ? prev.count + 1 : 1;
  writeAttempt(root, { version: info.version, count, at: Date.now() });
  log(`准备加载热壳 ${info.version}（第 ${count} 次尝试）`);
}

/**
 * 热壳已成功启动（窗口已创建）。
 * 由引导器调用：清掉尝试计数，表示这套壳是好的。
 */
export function markShellHealthy(): void {
  const self = selfHotShell() ?? loaded;
  if (!self) return;
  const root = hotRoot();
  const attempt = readAttempt(root);
  if (attempt && attempt.version === self.version) {
    try {
      fs.rmSync(path.join(root, ATTEMPT), { force: true });
      log(`热壳 ${self.version} 启动正常，清除尝试计数`);
    } catch {
      /* ignore */
    }
  }
}

/** 当前生效的壳版本：热壳优先，否则内置 */
export function shellVersion(): string {
  return selfHotShell()?.version ?? loaded?.version ?? app.getVersion();
}

/** 当前生效的热壳信息（未启用则为 null） */
export function activeHotShell(): HotShellInfo | null {
  const self = selfHotShell();
  if (self) return self;
  return loaded ? { ...loaded } : null;
}

/** 供引导器在 require 热壳入口前设置（同一进程内只调用一次） */
export function setLoadedHotShell(info: HotShellInfo | null): void {
  loaded = info;
}

// ---------------------------------------------------------------------------
// 落位 / 回滚 / 清理
// ---------------------------------------------------------------------------

/**
 * 把已解压的目录装成生效壳。
 *
 * @param stagingDir 已解压好的候选目录（内含 main/preload/renderer + hot-manifest.json）
 *
 * 关键：**每次落位都用全新的目录名**，绝不重命名/覆盖现有目录 ——
 * 因为正在运行的那个进程的 __dirname 就指向它，一改名运行的代码就被抽走。
 * 旧目录交给下次启动的 cleanupOldShells 清理（且不会删正在跑的那份）。
 */
export function installHotShell(stagingDir: string): HotShellInfo {
  const manifest = readManifest(stagingDir);
  if (!manifest) throw new Error('热更新包缺少可用的 hot-manifest.json');
  if (!hasShellFiles(stagingDir)) throw new Error('热更新包内容不完整（缺 main/preload/renderer）');

  const builtin = app.getVersion();
  // baseVersion 是「最低支持的已安装版本」：安装版 ≥ 基线即可用，与 pickHot 同语义。
  // 之前是严格相等，导致一切非 1.1.1 起步的全新安装（如 Win7 特供包 1.1.14-w7）永远
  // 无法热更——pickHot 按 floor 放行、这里按全等拦截，自相矛盾（实测踩过）。
  if (compareVersions(builtin, manifest.baseVersion) < 0) {
    throw new Error(
      `热更新包要求安装版 ≥ ${manifest.baseVersion}，当前安装版为 ${builtin}，只能走完整安装包`,
    );
  }

  const root = hotRoot();
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, `shell-${manifest.version}-${Date.now()}`);

  try {
    fs.renameSync(stagingDir, target);
  } catch {
    // 跨卷时 rename 会失败，退回递归复制
    copyDir(stagingDir, target);
  }

  const info: HotShellInfo = {
    dir: target,
    version: manifest.version,
    entry: path.join(target, 'main', 'boot.js'),
    baseVersion: manifest.baseVersion,
    installedAt: Date.now(),
  };
  log(`热壳已就位：${info.version} → ${target}`);
  return info;
}

/** 停用当前热壳（下次启动回到内置壳） */
export function rollbackHotShell(reason: string): void {
  const root = hotRoot();
  const current = selfHotShell() ?? loaded;
  const targets = current
    ? [current.dir]
    : listShellDirs(root)
        .map((dir) => ({ dir, m: readManifest(dir) }))
        .sort((a, b) => compareVersions(a.m?.version ?? '', b.m?.version ?? ''))
        .slice(-1)
        .map((x) => x.dir);

  for (const dir of targets) {
    try {
      fs.renameSync(dir, `${dir}.rolled-back`);
      log(`已停用热壳（${reason}）：${dir}`);
    } catch (err) {
      log(`停用热壳失败：${String(err)}`);
    }
  }
  try {
    fs.rmSync(path.join(root, ATTEMPT), { force: true });
  } catch {
    /* ignore */
  }
}

/** 清理临时目录与过老的热壳（保留版本最高的 keep 个） */
export function cleanupOldShells(keep = 2): void {
  const root = hotRoot();
  if (!fs.existsSync(root)) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith('.staging-')) {
      try {
        fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // 正在运行的那份绝对不能删（进程还在从里面读代码）
  const runningDir = selfHotShell()?.dir ?? loaded?.dir ?? null;

  const shells = entries
    .filter((e) => e.isDirectory() && isShellDir(e.name))
    .map((e) => {
      const dir = path.join(root, e.name);
      const m = readManifest(dir);
      return {
        dir,
        version: m?.version ?? '0',
        installedAt: m?.builtAt ? Date.parse(m.builtAt) : safeMtime(dir),
      };
    })
    .sort((a, b) => {
      const byVersion = compareVersions(a.version, b.version);
      return byVersion !== 0 ? byVersion : a.installedAt - b.installedAt;
    });

  for (const old of shells.slice(0, Math.max(0, shells.length - keep))) {
    if (runningDir && path.resolve(old.dir) === path.resolve(runningDir)) {
      log(`跳过清理正在运行的热壳 ${old.version}`);
      continue;
    }
    try {
      fs.rmSync(old.dir, { recursive: true, force: true });
      log(`清理旧热壳 ${old.version}`);
    } catch {
      /* ignore */
    }
  }
}

function safeMtime(dir: string): number {
  try {
    return fs.statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export function hotStagingDir(version: string): string {
  const root = hotRoot();
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `.staging-${version}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 解压热更新包（.tar）。
 *
 * 主路径是纯 JS 解包：热壳只有 out/ 那几百 KB，纯 JS 毫秒级完成，
 * 而且 Win7 根本没有系统 tar.exe（Win10 1803 才内置），
 * 老的「用系统自带 bsdtar 解压（不额外分发解压器）」在 Win7 上会让热更新整个失效。
 */
export function extractHotPackage(tarFile: string, destDir: string): Promise<void> {
  return extractTarPure(tarFile, destDir).catch(async (pureErr) => {
    if (!hasSystemTar()) {
      throw new Error(
        `解压热更新包失败（内置解压器）：${String((pureErr as Error)?.message ?? pureErr)}`,
      );
    }
    log(`热更新包纯 JS 解包失败（${String((pureErr as Error)?.message ?? pureErr).slice(0, 120)}），回退系统 tar…`);
    return extractWithSystemTar(tarFile, destDir);
  });
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}
