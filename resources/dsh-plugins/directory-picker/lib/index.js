/**
 * DSH Desktop 的目录选择后端。
 *
 * 为什么需要它：Harness 自带的 `dsh-host-directory-picker-browse` 只提供
 * 「列出某个目录的直接子目录」这一种原语。Windows 上没有一个能列出全部盘符的
 * 根目录，而浏览器的起点是主目录（如 `C:\Users\xxx`），于是用户**没有任何办法
 * 换到 D:\**——只能靠对话框里的「编辑路径」手动键入。
 *
 * 本插件在 browse 能力之上补一层：每次列目录时，把 Windows 上探测到的盘符根
 * （`C:\`、`D:\` …）作为条目一并返回。盘符条目的 `path` 就是它自己的根路径，
 * 因此前端点一下即可切到那个盘，无需任何新的 wire API——
 * `DirectoryEntry` 的形状（`{ name, path, hidden }`）原样够用。
 *
 * 前端据此把「根路径」条目识别出来，单独渲染成一栏「此电脑」。
 *
 * 依赖方向：本包**不修改** Harness 任何源码，只是替换 profile 里的
 * `directory-picker` 那一行（通过 `--patch` 叠加层）。
 *
 * @module @dsh-desktop/directory-picker
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdir, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, posix, resolve, win32 } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';

/** 盘符根：`C:\`、`D:/` 这种「整个卷」的路径。前端用它把盘符条目挑出来单独渲染。 */
export const DRIVE_ROOT = /^[A-Za-z]:[\\/]?$/;

/**
 * 虚拟根「此电脑」的哨兵路径。
 *
 * 这里的关键设计决定：盘符**不能**塞进每个目录的条目里 —— 那样它们就成了
 * 「所有文件夹的子项」，选中 `D:\` 时右栏列它的子项，盘符又出现一遍（实测踩过）。
 *
 * 正确做法是给盘符一个**独立的虚拟父级**：任何目录的面包屑最前面都挂一个
 * 「此电脑」，点它才列出全部盘符。这样盘符只在那一层出现一次，
 * 语义上也和资源管理器一致。
 *
 * 哨兵值本身不是任何平台的合法路径，只在本后端内被解释；
 * 因此它永远不会和真实目录重名（真实目录一定是 `D:\此电脑` 这种绝对路径）。
 */
export const COMPUTER = '此电脑';

/** 「此电脑」在面包屑上显示的名字。 */
export const COMPUTER_LABEL = '此电脑';

/**
 * 一个路径是否「完全限定」——与进程当前状态无关的固定位置。
 *
 * Windows 上只认盘符限定（`C:\…`）和完整 UNC（`\\server\share…`）：
 * 以分隔符开头但没盘符的形式（`\foo`、`/foo`）以及只有 `\\`、`\\server`
 * 的残缺 UNC 虽然过得了 `isAbsolute`，却仍然要按进程当前盘解析，
 * 这在 wire 上是不可接受的（同一个字符串在不同进程里指向不同目录）。
 *
 * @param path - 待判定的路径。
 * @param platform - 便于确定性测试，默认取 `process.platform`。
 * @returns 是否指向唯一的固定位置。
 */
export function fullyQualified(path, platform = process.platform) {
  if (platform !== 'win32') return posix.isAbsolute(path);
  return win32.isAbsolute(path) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(path);
}

/**
 * 从文件系统根到 `target`（含）的祖先链，用作面包屑。
 * @param target - 目标目录的绝对路径。
 * @returns 每一级都是可跳转目标的条目数组。
 */
export function ancestryCrumbs(target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    const parent = dirname(current);
    crumbs.unshift({
      name: parent === current ? current : basename(current),
      path: current,
      hidden: false,
    });
    if (parent === current) return crumbs;
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// 盘符探测
// ---------------------------------------------------------------------------

let driveCache = { at: 0, roots: [] };
/** 盘符在一次会话里几乎不会变，缓存一小段时间即可，避免每次列目录都起进程。 */
const DRIVE_CACHE_MS = 30_000;

/**
 * 用 `fsutil fsinfo drives` 列出本机盘符。
 *
 * 选它而不是「A: 到 Z: 逐个 statSync」：断开的映射网络驱动器会让 stat 卡住几秒，
 * 而 fsutil 是一次调用、自带超时，不会把界面拖死。
 *
 * @returns 形如 `['C:\\', 'D:\\']` 的根路径数组；探测不到时返回空数组。
 */
function drivesViaFsutil() {
  try {
    const text = execFileSync('fsutil', ['fsinfo', 'drives'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    // 输出形如：`Drives: C:\ D:\ E:\`。注意中文系统上标签是 GBK 编码的「驱动器:」，
    // 按 UTF-8 解出来是乱码，不能按标签匹配 —— 直接扫描全部盘符 token，与语言无关。
    const roots = [];
    for (const match of text.matchAll(/[A-Za-z]:\\/g)) {
      if (!roots.includes(match[0])) roots.push(match[0]);
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * 兜底：把 A: 到 Z: 逐个 stat 一遍。只在 fsutil 不可用（非 Windows 或输出格式变化）时走到。
 * @returns 存在的盘符根路径数组。
 */
function drivesViaProbe() {
  const roots = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if (statSync(root).isDirectory()) roots.push(root);
    } catch {
      /* 该盘符不存在，跳过 */
    }
  }
  return roots;
}

/**
 * 本机可用的盘符根（带缓存）。
 * @returns 形如 `['C:\\', 'D:\\']` 的根路径数组，非 Windows 平台恒为空。
 */
export function windowsDrives() {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (now - driveCache.at < DRIVE_CACHE_MS) return driveCache.roots;
  let roots = drivesViaFsutil();
  if (roots.length === 0) roots = drivesViaProbe();
  driveCache = { at: now, roots };
  return roots;
}

// ---------------------------------------------------------------------------
// 后端
// ---------------------------------------------------------------------------

/** 把目录项按名称排序后截断到上限；`truncated` 表示这一层还有更多。 */
function bounded(rows, keep) {
  rows.sort((a, b) => a.name.localeCompare(b.name));
  if (rows.length <= keep) return { rows, truncated: false };
  return { rows: rows.slice(0, keep), truncated: true };
}

/** 一个 dirent 是否可进入的目录（符号链接要跟随一次才能确定）。 */
async function isEnterableDirectory(parent, name, dirent) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return (await stat(joinPath(parent, name))).isDirectory();
  } catch {
    /* 断链或循环链接：进不去，静默跳过 */
    return false;
  }
}

/** 拼接子路径（避免在文件顶部再引一个 join）。 */
function joinPath(parent, name) {
  const sep = process.platform === 'win32' ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}

/**
 * browse 交互后端：单层目录列举 + 创建子目录，并在 Windows 上把盘符一并列出。
 *
 * 能力对象的形状与 Harness 的 browse 完全一致（`kind: 'browse'` 加
 * `list`/`createDirectory`），所以前端的既有消费路径无需任何改动。
 */
class DesktopDirectoryPicker extends DirectoryPicker {
  static Config = z.object({
    /** 单层最多返回多少个子目录（盘符不计入此上限）。 */
    maxEntries: z.natural().min(1).default(1000),
    /** 是否把 Windows 盘符作为条目返回，从而允许在应用内换盘。 */
    drives: z.boolean().default(true),
  });

  constructor(ctx, config) {
    super(ctx);
    this.config = config;
    this.browseCapability = {
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    };
    ctx.logger?.info?.('目录选择后端：DSH Desktop（应用内浏览 + 盘符切换）');
    // 同时写 stdout：dsh 的启动输出会被桌面外壳收进 logs/dsh-web.log，
    // 这一行是「我们的补丁真的挂上了」最直接的凭据。
    console.log('[dsh-desktop] 目录选择后端已接管：@dsh-desktop/directory-picker');
  }

  /** @returns 稳定的 browse 能力对象。 */
  capability() {
    return this.browseCapability;
  }

  /**
   * 列出一层目录。`path` 省略时列出账户主目录；`path === COMPUTER` 时列出全部盘符。
   * @param path - 要列出的绝对目录路径，或虚拟根 COMPUTER。
   * @param signal - 调用方的生命周期；中止即停止扫描。
   * @returns 该层的目录条目、祖先面包屑，以及是否被截断。
   */
  async list(path, signal) {
    const home = homedir();

    // 虚拟根「此电脑」：内容就是本机盘符 + 主目录快捷入口。
    if (this.config.drives && path === COMPUTER) {
      return {
        path: COMPUTER,
        home,
        crumbs: [{ name: COMPUTER_LABEL, path: COMPUTER, hidden: false }],
        entries: [
          { name: '主目录', path: home, hidden: false },
          ...windowsDrives().map((root) => ({ name: root, path: root, hidden: false })),
        ],
        truncated: false,
      };
    }

    if (path !== undefined && !fullyQualified(path)) {
      throw new DirectoryPickerError('directory-unreadable', path, `cannot list "${path}": not a fully qualified path`);
    }
    const target = resolve(path ?? home);
    const keep = this.config.maxEntries + 1;
    const rows = [];
    let truncated = false;

    try {
      const level = await opendir(target);
      try {
        for (;;) {
          signal?.throwIfAborted();
          const dirent = await level.read();
          if (dirent === null) break;
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
          if (rows.length === keep) {
            truncated = true;
            continue;
          }
          if (await isEnterableDirectory(target, dirent.name, dirent)) {
            rows.push({ name: dirent.name, path: joinPath(target, dirent.name), hidden: dirent.name.startsWith('.') });
          }
        }
      } finally {
        await level.close().catch(() => {});
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new DirectoryPickerError(
        'directory-unreadable',
        target,
        `cannot list ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const boundedRows = bounded(rows, this.config.maxEntries);
    if (boundedRows.truncated) truncated = true;

    // 面包屑最前面挂上虚拟根，让「此电脑」（= 全部盘符）永远可达。
    //
    // 【致命坑】Harness 的 browse 界面（dsh-client-ui-directory-picker-browse 的
    // displayCrumbs）会把「主目录子树内」的面包屑折叠成单个 Home：它按
    // `crumb.path === listing.home` 找到 home 那一级，把**之前的所有 crumb 丢弃**。
    // 我们挂在最前面的「此电脑」正好在被丢弃之列 —— 用户打开选择器看到的是主目录，
    // 面包屑只剩「主目录」，盘符入口整个消失，且无法导航出主目录（死锁）。
    //
    // 对策：给恰好等于 home 的那一级 crumb 路径补一个尾部分隔符。前端匹配不上
    // `listing.home` 就放弃折叠，完整链（含「此电脑」）全部渲染；多出的分隔符
    // 对 `resolve`/`opendir`/`fullyQualified` 都无害，点它照常跳转。
    const sep = process.platform === 'win32' ? '\\' : '/';
    const rawCrumbs = this.config.drives
      ? [{ name: COMPUTER_LABEL, path: COMPUTER, hidden: false }, ...ancestryCrumbs(target)]
      : ancestryCrumbs(target);
    const crumbs = rawCrumbs.map((crumb) =>
      crumb.path === home && !crumb.path.endsWith(sep)
        ? { ...crumb, path: `${crumb.path}${sep}` }
        : crumb,
    );

    return { path: target, home, crumbs, entries: boundedRows.rows, truncated };
  }

  /**
   * 在既有父目录下创建一个子目录。
   * @param path - 绝对且存在的父目录。
   * @param name - 单个非空路径片段（不含分隔符，不是 `.`/`..`）。
   * @returns 新建目录的绝对路径。
   */
  async createDirectory(path, name) {
    // 「此电脑」是虚拟根，底下是盘符，不能新建文件夹。
    if (path === COMPUTER) {
      throw new DirectoryPickerError('directory-create-failed', COMPUTER, 'cannot create a folder under "此电脑"');
    }
    if (!fullyQualified(path)) {
      throw new DirectoryPickerError('directory-create-failed', path, `cannot create under "${path}": not a fully qualified parent path`);
    }
    const parent = resolve(path);
    if (name.trim() === '' || name === '.' || name === '..' || /[/\\]/.test(name)) {
      throw new DirectoryPickerError('directory-create-failed', joinPath(parent, name), `"${name}" is not a single path segment`);
    }
    const target = joinPath(parent, name);
    try {
      await mkdir(target);
      return target;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`);
      }
      throw new DirectoryPickerError(
        'directory-create-failed',
        target,
        `cannot create ${target}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export { DesktopDirectoryPicker as default };
