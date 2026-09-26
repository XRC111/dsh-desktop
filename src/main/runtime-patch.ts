import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { updatesDir, packagedRuntimeDir, dshRuntimeDir, devRuntimeDir, runtimeRoot } from './paths';

/**
 * 运行时差分补丁：让 dsh 本体也能走热更新。
 *
 * 背景：dsh 运行时是 269MB / 3.5 万文件，整包下载太重；但小版本升级通常只动一小部分，
 * 于是打包时对两棵运行时树做差分（见 scripts/pack-runtime-patch.mjs），
 * 客户端只下载「新增+改动」的文件与「待删除」清单（实测 rc.1→rc.2 未压缩 17.5MB），
 * 下载+落位在后台完成，**重启应用时一次性套用**（此时 dsh 未运行，文件不被占用）。
 *
 * 补丁包结构（tar.gz 解开后）：
 *   runtime-patch.json   { version, baseVersion, files:[{p,size,k}], deletes:[...] }
 *   files/<相对 node_modules 的路径>
 *
 * 应用到 <运行时可写目录>/node_modules/ 下；套用后写 `.runtime-patch.json` 作为标记，
 * 既用于显示"当前运行时来自热更新"，也用来**跳过安装包基于旧清单的完整性修复**
 * （旧清单描述的是安装包内置版本，会把补丁删掉的文件又塞回来）。
 */

export interface RuntimePatchManifest {
  version: string;
  baseVersion: string;
  files: Array<{ p: string; size: number; k?: string }>;
  deletes: string[];
  counts?: Record<string, number>;
  builtAt?: string;
}

export interface PendingRuntimePatch {
  version: string;
  baseVersion: string;
  /** 已解压好的补丁目录（内含 runtime-patch.json 与 files/） */
  dir: string;
  url?: string;
  at: number;
}

const PENDING_FILE = 'runtime-pending.json';
const APPLIED_MARKER = '.runtime-patch.json';

// ---------------------------------------------------------------------------
// 落位 / 读取
// ---------------------------------------------------------------------------

/** 「待应用补丁」的记录文件（重启时读取） */
export function pendingPatchFile(): string {
  return path.join(updatesDir(), PENDING_FILE);
}

export function readPendingPatch(): PendingRuntimePatch | null {
  try {
    const p = JSON.parse(fs.readFileSync(pendingPatchFile(), 'utf8')) as PendingRuntimePatch;
    if (!p?.version || !p?.dir) return null;
    if (!fs.existsSync(path.join(p.dir, 'runtime-patch.json'))) return null;
    return p;
  } catch {
    return null;
  }
}

export function writePendingPatch(patch: PendingRuntimePatch): void {
  fs.mkdirSync(updatesDir(), { recursive: true });
  fs.writeFileSync(pendingPatchFile(), JSON.stringify(patch, null, 2), 'utf8');
}

export function clearPendingPatch(): void {
  try {
    fs.rmSync(pendingPatchFile(), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 解压 .tar.gz 到指定目录（通用）。
 * 用系统 bsdtar（`-xzf` 直接吃 gzip）；不可用时回退到 tar npm 包 + zlib 手写解包。
 */
export function extractTarGz(tarFile: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  // 主路径：纯 JS 解包 —— 零外部依赖、零外部进程，不可能出现"卡死不返回"。
  return extractTarGzPure(tarFile, destDir).catch(async (pureErr) => {
    // 兜底：系统 tar.exe（限时 60s，防挂起）。仅当纯 JS 失败时才会走到这里。
    const tarExe =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    log(`纯 JS 解包失败（${String((pureErr as Error)?.message ?? pureErr).slice(0, 120)}），回退系统 tar…`);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(tarExe, ['-xzf', tarFile, '-C', destDir], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        reject(new Error('系统 tar 解包超时（60s）'));
      }, 60_000);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`tar 退出码 ${code}：${stderr.slice(-300)}`));
      });
    });
  });
}

/**
 * 纯 JS 解包 .tar.gz：不 spawn 任何外部进程。
 *
 * 为什么不用系统 tar.exe：它可能被安全软件/环境拦截后**既不退出也不报错**
 * （实测会把下载进度卡死在 99%）。tar 格式本身很简单，512 字节头 + 数据块，
 * 我们只需要支持自家打包器（bsdtar）产出的：普通文件、目录、GNU 长名（L）、PAX 扩展头（x）。
 */
export function extractTarGzPure(tarFile: string, destDir: string): Promise<void> {
  return Promise.resolve().then(() => {
    const zlib = require('zlib') as typeof import('zlib');
    const tarBuf = zlib.gunzipSync(fs.readFileSync(tarFile));
    let offset = 0;
    let pendingName: string | null = null;

    const readStr = (buf: Buffer, off: number, len: number): string => {
      const raw = buf.subarray(off, off + len);
      const end = raw.indexOf(0);
      return (end === -1 ? raw : raw.subarray(0, end)).toString('utf8');
    };

    while (offset + 512 <= tarBuf.length) {
      const header = tarBuf.subarray(offset, offset + 512);
      if (header.every((b) => b === 0)) break; // 结束块

      const nameField = readStr(header, 0, 100);
      const prefix = readStr(header, 345, 155).trim();
      const sizeStr = readStr(header, 124, 12).replace(/[^0-7]/g, '');
      const size = parseInt(sizeStr || '0', 8) || 0;
      const type = String.fromCharCode(header[156] || 48);
      offset += 512;

      const data = tarBuf.subarray(offset, offset + size);
      offset += Math.ceil(size / 512) * 512;

      if (type === 'L') {
        pendingName = readStr(data, 0, size).replace(/\0[\s\S]*$/, '');
        continue;
      }
      if (type === 'x') {
        // PAX 扩展头：形如 "52 path=updater/lib/x.js\n"，作用于下一个条目
        const text = data.toString('utf8');
        const m = text.match(/(?:^|\n)\d+ path=([^\n]+)/);
        pendingName = m ? m[1] : pendingName;
        continue;
      }
      if (type === 'g') continue; // 全局扩展头，忽略

      let name = pendingName ?? (prefix ? `${prefix}/${nameField}` : nameField);
      pendingName = null;
      name = name.replace(/^\.\//, '');
      if (!name || name.includes('..') || path.isAbsolute(name)) continue;

      const dest = path.join(destDir, ...name.split('/'));
      if (type === '5') {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      if (type === '0' || type === '\0') {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, data.subarray(0, size));
      }
      // 其它类型（链接等）我们的包里没有，忽略
    }
  });
}

/**
 * 解压 .tar.gz 到指定目录（通用入口）。
 * 先用纯 JS 解包（零外部依赖，不可能卡死）；万一失败再退回系统 tar.exe。
 */
export function extractRuntimePatch(tarFile: string, destDir: string): Promise<void> {
  const tarExe =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  return new Promise((resolve, reject) => {
    const child = spawn(tarExe, ['-xzf', tarFile, '-C', destDir], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.once('error', (err) => reject(err));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压运行时补丁失败（tar 退出码 ${code}）：${stderr.slice(-300)}`));
    });
  });
}

export function readManifest(patchDir: string): RuntimePatchManifest {
  const raw = JSON.parse(
    fs.readFileSync(path.join(patchDir, 'runtime-patch.json'), 'utf8'),
  ) as RuntimePatchManifest;
  if (!raw?.version || !raw?.baseVersion || !Array.isArray(raw.files)) {
    throw new Error('runtime-patch.json 内容不完整');
  }
  return raw;
}

/** 当前运行时目录里记录的已应用补丁（无则 null） */
export function appliedPatch(runtimeDir: string): { version: string; at: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(runtimeDir, APPLIED_MARKER), 'utf8'));
    return raw?.version ? { version: String(raw.version), at: Number(raw.at ?? 0) } : null;
  } catch {
    return null;
  }
}

/** 读运行时自身的 dsh 版本 */
export function runtimeVersionOf(runtimeDir: string): string | null {
  try {
    const p = path.join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/**
 * 当前实际在用的运行时目录（按候选顺序找第一个真实存在的）。
 *
 * 千万别直接用 `dshRuntimeDir()` —— 它在打包态指向的是用户数据目录里的兜底位置，
 * 而运行时实际装在安装目录的 resources 下（见 packagedRuntimeDir）。
 * 曾经因为用错它导致"读不到当前运行时版本、跳过运行时更新"。
 */
export function findRuntimeDir(): string {
  const candidates = [
    packagedRuntimeDir(),
    path.join(runtimeRoot(), 'dsh-runtime'),
    dshRuntimeDir(),
    devRuntimeDir(),
  ];
  for (const dir of candidates) {
    if (runtimeVersionOf(dir)) return dir;
  }
  return candidates[0];
}

// ---------------------------------------------------------------------------
// 应用（重启时调用，必须保证 dsh 未运行）
// ---------------------------------------------------------------------------

export interface ApplyResult {
  ok: boolean;
  version?: string;
  message: string;
  copied?: number;
  deleted?: number;
}

export function applyPendingRuntimePatch(runtimeDir: string): ApplyResult | null {
  const pending = readPendingPatch();
  if (!pending) return null;

  const current = runtimeVersionOf(runtimeDir);
  if (!current) {
    clearPendingPatch();
    return { ok: false, message: `运行时目录不可用（${runtimeDir}），已放弃补丁` };
  }

  let manifest: RuntimePatchManifest;
  try {
    manifest = readManifest(pending.dir);
  } catch (err) {
    clearPendingPatch();
    return { ok: false, message: `补丁清单损坏：${String((err as Error).message)}` };
  }

  // 基线必须一致：别人的运行时版本套这个补丁会把文件搞乱
  if (manifest.baseVersion !== current) {
    clearPendingPatch();
    return {
      ok: false,
      message: `补丁基线 ${manifest.baseVersion} 与当前运行时 ${current} 不一致，已跳过（请用完整安装包）`,
    };
  }

  log(`开始应用运行时补丁：${current} → ${manifest.version}（文件 ${manifest.files.length}，删除 ${manifest.deletes.length}）`);
  const started = Date.now();
  const base = path.join(runtimeDir, 'node_modules');

  // 1) 覆盖/新增
  let copied = 0;
  for (const f of manifest.files) {
    const src = path.join(pending.dir, 'files', ...f.p.split('/'));
    const dst = path.join(base, ...f.p.split('/'));
    try {
      if (!fs.existsSync(src)) throw new Error(`补丁缺少文件 ${f.p}`);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copied++;
    } catch (err) {
      // 半途失败：清掉待应用标记，让下次启动回退为「重新展开安装包内置运行时」
      clearPendingPatch();
      return {
        ok: false,
        message: `套用补丁失败（第 ${copied + 1} 个文件 ${f.p}）：${String((err as Error).message)}`,
        copied,
      };
    }
  }

  // 2) 删除
  // 注意：清单里是**文件**路径，逐个删完会留下一堆空目录（npm 残留目录尤其明显），
  // 所以删完还要自底向上清掉空目录。
  let deleted = 0;
  const parentDirs = new Set<string>();
  for (const rel of manifest.deletes) {
    const dst = path.join(base, ...rel.split('/'));
    try {
      fs.rmSync(dst, { force: true, recursive: true });
      deleted++;
      let dir = path.dirname(dst);
      while (dir.length > base.length && dir.startsWith(base)) {
        parentDirs.add(dir);
        dir = path.dirname(dir);
      }
    } catch {
      /* 删不掉就留着，不影响运行 */
    }
  }
  // 深目录优先，只删空目录（rmdir 对非空目录会失败，正好跳过）
  for (const dir of [...parentDirs].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* 非空或已删，忽略 */
    }
  }

  // 3) 标记 + 清理
  try {
    fs.writeFileSync(
      path.join(runtimeDir, APPLIED_MARKER),
      JSON.stringify(
        { version: manifest.version, baseVersion: manifest.baseVersion, at: Date.now(), copied, deleted },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* 标记写失败不影响使用 */
  }
  clearPendingPatch();
  try {
    fs.rmSync(pending.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`运行时补丁已套用：${manifest.version}（覆盖 ${copied}，删除 ${deleted}，耗时 ${secs}s）`);
  return { ok: true, version: manifest.version, message: `运行时已更新到 ${manifest.version}`, copied, deleted };
}
