// 应用内文件选择（附件）——主进程侧。
//
// 背景：Harness「添加附件」用的是隐藏 <input type="file">，在 Electron 里会弹
// Chromium 原生系统对话框。目录选择已有应用内浏览窗口（此电脑 + 盘符），这里为
// 附件提供同款体验：
//   * 主进程提供两个 IPC：列目录（含文件 + 盘符）与读取选中文件；
//   * 渲染侧由 attachment-picker.client.js 注入页面（main world），
//     拦截 file input 的 click、渲染窗口、把选中的文件构造成 File 塞回 input。
//
// 设计边界：不修改 Harness 任何源码；Harness 的 onPickFiles 收到的仍是
// 标准 FileList，上传链路零感知。窗口起点是「此电脑」，与目录选择一致。
import { execFile } from 'child_process';
import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rendererDir } from './paths';
import { log } from './logger';

/** 虚拟根「此电脑」：与目录选择插件（@dsh-desktop/directory-picker）保持同名语义 */
const COMPUTER = '此电脑';

/** 单层最多返回的条目数（防超大盘目录卡死界面） */
const MAX_ENTRIES = 2000;

/** 单个附件文件的大小上限（1 GiB）——超出直接报错而不是卡死 IPC 传输 */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

interface Entry {
  name: string;
  path: string;
  kind: 'dir' | 'file';
  size?: number;
}

interface Crumb {
  name: string;
  path: string;
}

interface Listing {
  path: string;
  home: string;
  crumbs: Crumb[];
  entries: Entry[];
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// 盘符探测（与目录选择插件同一策略：fsutil 一次调用，stat 兜底）
// ---------------------------------------------------------------------------

let driveCache: { at: number; roots: string[] } = { at: 0, roots: [] };
const DRIVE_CACHE_MS = 30_000;

function drivesViaFsutil(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'fsutil',
      ['fsinfo', 'drives'],
      { timeout: 4000, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        // 中文系统的标签是 GBK 的「驱动器:」，按 latin1 解出来也是乱码，
        // 但盘符 token 恒为 ASCII —— 直接扫描 token，与语言/编码无关。
        const text = (stdout as Buffer).toString('latin1');
        const roots: string[] = [];
        for (const match of text.matchAll(/[A-Za-z]:\\/g)) {
          if (!roots.includes(match[0])) roots.push(match[0]);
        }
        resolve(roots);
      },
    );
  });
}

async function drivesViaProbe(): Promise<string[]> {
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      if ((await fs.promises.stat(root)).isDirectory()) roots.push(root);
    } catch {
      /* 盘符不存在 */
    }
  }
  return roots;
}

async function windowsDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const now = Date.now();
  if (now - driveCache.at < DRIVE_CACHE_MS) return driveCache.roots;
  let roots = await drivesViaFsutil();
  if (roots.length === 0) roots = await drivesViaProbe();
  driveCache = { at: now, roots };
  return roots;
}

// ---------------------------------------------------------------------------
// 目录列举
// ---------------------------------------------------------------------------

/** 从文件系统根到 target 的祖先链（不含「此电脑」虚拟根） */
function ancestry(target: string): Crumb[] {
  const crumbs: Crumb[] = [];
  let current = target;
  for (;;) {
    const parent = path.dirname(current);
    crumbs.unshift({
      name: parent === current ? current : path.basename(current) || current,
      path: current,
    });
    if (parent === current) return crumbs;
    current = parent;
  }
}

/**
 * 面包屑：最前挂「此电脑」，并对恰好等于主目录的那一级补尾分隔符。
 *
 * 尾分隔符是关键：Harness browse 界面的 displayCrumbs 会把「主目录子树内」的
 * 面包屑折叠成单个 Home（丢弃 home 之前的全部 crumb）——我们的「此电脑」会被
 * 裁掉。补一个分隔符让前端匹配不上 home、放弃折叠（详见目录选择插件内注释）。
 */
function crumbsFor(target: string, home: string, withDrives: boolean): Crumb[] {
  const raw: Crumb[] = withDrives
    ? [{ name: COMPUTER, path: COMPUTER }, ...ancestry(target)]
    : ancestry(target);
  return raw.map((crumb) =>
    crumb.path === home && !crumb.path.endsWith(path.sep)
      ? { ...crumb, path: crumb.path + path.sep }
      : crumb,
  );
}

async function listDir(raw: unknown): Promise<Listing> {
  const home = os.homedir();

  if (typeof raw === 'string' && raw === COMPUTER) {
    const drives = await windowsDrives();
    const entries: Entry[] = [{ name: '主目录', path: home, kind: 'dir' }];
    for (const root of drives) entries.push({ name: root, path: root, kind: 'dir' });
    return {
      path: COMPUTER,
      home,
      crumbs: [{ name: COMPUTER, path: COMPUTER }],
      entries,
      truncated: false,
    };
  }

  const requested = typeof raw === 'string' && raw.length > 0 ? raw : home;
  const target = path.resolve(requested);
  const dirents = await fs.promises.readdir(target, { withFileTypes: true });

  const entries: Entry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    const full = path.join(target, dirent.name);
    if (dirent.isDirectory()) {
      entries.push({ name: dirent.name, path: full, kind: 'dir' });
    } else if (dirent.isFile()) {
      entries.push({ name: dirent.name, path: full, kind: 'file' });
    } else {
      // 符号链接等：跟随一次确定类型，断链静默跳过
      try {
        const st = await fs.promises.stat(full);
        entries.push({ name: dirent.name, path: full, kind: st.isDirectory() ? 'dir' : 'file' });
      } catch {
        /* skip */
      }
    }
    if (entries.length > MAX_ENTRIES) {
      truncated = true;
      break;
    }
  }

  // 文件补大小（目录不显示大小）
  await Promise.all(
    entries
      .filter((entry) => entry.kind === 'file')
      .map(async (entry) => {
        try {
          const st = await fs.promises.stat(entry.path);
          entry.size = st.size;
        } catch {
          /* 无大小可显示 */
        }
      }),
  );

  // 目录在前，名称按本地化排序
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, 'zh') : a.kind === 'dir' ? -1 : 1,
  );

  return { path: target, home, crumbs: crumbsFor(target, home, true), entries, truncated };
}

// ---------------------------------------------------------------------------
// 读取选中文件
// ---------------------------------------------------------------------------

interface ReadResult {
  name: string;
  data: Buffer;
  lastModified: number;
}

async function readFiles(raw: unknown): Promise<ReadResult[]> {
  if (!Array.isArray(raw)) throw new Error('paths must be an array');
  const results: ReadResult[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) {
      throw new Error('invalid file path');
    }
    // 只接受绝对路径，避免渲染侧用相对路径探到主进程 cwd
    if (!path.isAbsolute(item)) throw new Error(`not an absolute path: ${item}`);
    const target = path.resolve(item);
    const st = await fs.promises.stat(target);
    if (!st.isFile()) throw new Error(`not a file: ${target}`);
    if (st.size > MAX_FILE_BYTES) {
      throw new Error(`文件过大（>1 GiB）：${path.basename(target)}`);
    }
    const data = await fs.promises.readFile(target);
    results.push({ name: path.basename(target), data, lastModified: Math.floor(st.mtimeMs) });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 对外装配
// ---------------------------------------------------------------------------

let registered = false;

/** 注册附件选择用的 IPC 通道（幂等，进程内只需调一次）。 */
export function registerAttachmentPickerHandlers(): void {
  if (registered) return;
  registered = true;
  ipcMain.handle('attachment:list', (_event, dir: unknown) => listDir(dir));
  ipcMain.handle('attachment:read', (_event, paths: unknown) => readFiles(paths));
}

/**
 * 向窗口注入应用内文件选择脚本（每次 dom-ready 都会注入，脚本自身幂等）。
 * 注入发生在主世界：preload 的 contextIsolation 世界改不了页面的原型链。
 * BaseWindow 架构下内容在 WebContentsView 里，因此接收方只需暴露 webContents。
 */
export function injectAttachmentPicker(view: { webContents: Electron.WebContents } | null): void {
  if (!view) return;
  const wc = view.webContents;
  const clientFile = path.join(rendererDir(), 'attachment-picker.client.js');
  let code: string;
  try {
    code = fs.readFileSync(clientFile, 'utf8');
  } catch (err) {
    log(`附件选择脚本缺失（${clientFile}）：${String(err)}`);
    return;
  }
  wc.on('dom-ready', () => {
    wc.executeJavaScript(code, false).catch((err) => log(`注入附件选择脚本失败：${String(err)}`));
  });
  log('应用内附件选择已就绪：file input 将由桌面外壳接管');
}
