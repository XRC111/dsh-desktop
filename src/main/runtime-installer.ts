import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractRuntimeScript } from './paths';
import { log } from './logger';

/**
 * Harness 运行时的落位、完整性自检与自动修复。
 *
 * 背景与设计（1.0.9 起）：
 *   运行时是 3.5 万个 npm 小文件（≈314 MB）。若让 NSIS 逐个写，
 *   实测一次安装要 110 秒，且在杀软实时扫描下会静默丢文件（实测丢 25.6%）。
 *   因此安装包里运行时只以单个 dsh-runtime.tar 分发，落地后由多线程解压器
 *   （resources/extract-runtime.cjs，安装期 NSIS 与运行期本模块共用）并行展开：
 *   文件清单按字节均分成几十批、N 个 tar 进程并行写，解压后逐文件校验、缺失重试。
 *
 *   本模块负责：
 *     1) 落位：安装目录已有完整运行时 → 直接用；否则用解压器解到用户数据目录
 *     2) 抽样自检：只 stat 少量文件，快速发现大规模缺失
 *     3) 修复：把缺失清单交给同一个解压器并行补齐
 *
 * 开发态（未打包）直接使用项目里的 resources/dsh-runtime，跳过校验与修复。
 */

export interface RuntimeResolution {
  /** dsh 运行时根目录（内含 node_modules） */
  dir: string;
  /** 来源：安装目录 / 开发态 / 已解压复用 / 本次解压 */
  source: 'installed' | 'dev' | 'cached' | 'extracted';
}

export interface EnsureRuntimeOptions {
  /** 打包态首选：随安装包一起落地的运行时目录（resources/dsh-runtime） */
  packagedDir: string;
  /** 打包态兜底：resources/dsh-runtime.tar */
  tarFile: string;
  /** 解压根目录（如 <userData>/runtime） */
  targetRoot: string;
  /** 开发态：项目内的 resources/dsh-runtime */
  devDir: string;
  /** 运行时版本标识（应用版本 + 架构），不一致则重新解压 */
  versionTag: string;
  /** 进度回调，用于更新加载页 */
  onProgress?: (message: string) => void;
}

/** 运行时文件清单（构建期生成，见 scripts/gen-runtime-manifest.mjs） */
export interface RuntimeManifest {
  fileCount: number;
  totalBytes: number;
  /** 相对 resources 目录的 posix 路径（形如 "dsh-runtime/node_modules/..."） */
  files: string[];
}

const RUNTIME_DIRNAME = 'dsh-runtime';
const MARKER = '.runtime-version';

/** 运行时是否可用（存在 dsh 包与入口） */
function isRuntimeUsable(dir: string): boolean {
  const pkgDir = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return false;
  return fs.existsSync(path.join(pkgDir, 'lib', 'bin.js'));
}

// ---------------------------------------------------------------------------
// 1) 落位
// ---------------------------------------------------------------------------

export async function ensureRuntime(opts: EnsureRuntimeOptions): Promise<RuntimeResolution> {
  // 1) 首选：运行时已随安装包落地（正常安装流程），直接用，零额外开销
  if (isRuntimeUsable(opts.packagedDir)) {
    log(`运行时来源：安装目录 ${opts.packagedDir}`);
    return { dir: opts.packagedDir, source: 'installed' };
  }

  // 2) 开发态：项目内目录
  if (isRuntimeUsable(opts.devDir)) {
    log(`运行时来源：开发态目录 ${opts.devDir}`);
    return { dir: opts.devDir, source: 'dev' };
  }

  // 3) 兜底：安装目录不完整时，把 tar 解压到用户数据目录
  const targetDir = path.join(opts.targetRoot, RUNTIME_DIRNAME);
  const markerFile = path.join(opts.targetRoot, MARKER);

  let currentTag = '';
  try {
    currentTag = fs.readFileSync(markerFile, 'utf8').trim();
  } catch {
    /* 首次运行没有标记 */
  }

  if (currentTag === opts.versionTag && isRuntimeUsable(targetDir)) {
    log('运行时已解压且版本一致，跳过解压');
    return { dir: targetDir, source: 'cached' };
  }

  if (!fs.existsSync(opts.tarFile)) {
    // 既没有可用目录，也没有修复源：交由后续校验给出可读错误
    log('未找到可用的运行时目录与修复包');
    return { dir: opts.packagedDir, source: 'installed' };
  }

  opts.onProgress?.('正在多线程解压 Harness 运行时（首次启动需要）…');
  log(`解压运行时 → ${targetDir}`);

  try {
    if (fs.existsSync(targetDir)) fs.rmSync(targetDir, { recursive: true, force: true });
  } catch (err) {
    log(`清理旧运行时目录失败：${String(err)}`);
  }
  fs.mkdirSync(opts.targetRoot, { recursive: true });

  await extractParallel(opts.tarFile, opts.targetRoot, null, opts.onProgress, opts.versionTag);

  if (!isRuntimeUsable(targetDir)) {
    throw new Error(
      `运行时解压后校验失败：${targetDir} 中缺少 @deepseek-ai/dsh。请重新安装本应用。`,
    );
  }
  fs.writeFileSync(markerFile, opts.versionTag, 'utf8');
  log('运行时解压完成');
  return { dir: targetDir, source: 'extracted' };
}

// ---------------------------------------------------------------------------
// 2) 完整性自检
// ---------------------------------------------------------------------------

export function loadManifest(file: string): RuntimeManifest | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(data?.files) || data.files.length === 0) return null;
    return data as RuntimeManifest;
  } catch {
    return null;
  }
}

function exists(base: string, rel: string): boolean {
  return fs.existsSync(path.join(base, ...rel.split('/')));
}

/**
 * 抽样自检：只检查少量文件，用于快速发现"大规模缺失"。
 * 正常启动只需几百次 stat，开销可以忽略。
 */
export function sampleMissing(base: string, manifest: RuntimeManifest, n = 300): string[] {
  const total = manifest.files.length;
  const step = Math.max(1, Math.floor(total / n));
  const missing: string[] = [];
  for (let i = 0; i < total; i += step) {
    const rel = manifest.files[i];
    if (!exists(base, rel)) missing.push(rel);
  }
  return missing;
}

/** 全量查找缺失文件（仅在抽样已发现问题时调用） */
export function findAllMissing(base: string, manifest: RuntimeManifest): string[] {
  return manifest.files.filter((rel) => !exists(base, rel));
}

// ---------------------------------------------------------------------------
// 3) 自动修复
// ---------------------------------------------------------------------------

/**
 * 从 tar 补齐缺失文件（多线程解压器的 --only 模式）。
 * 缺失清单交给解压器后，它会按字节分批、并行解压、逐文件复核，
 * 因此修复本身也是多线程的，且不会再出现"解压完仍缺文件"的静默问题。
 */
export async function repairMissing(
  tarFile: string,
  destBase: string,
  missing: string[],
  onProgress?: (message: string) => void,
): Promise<number> {
  if (missing.length === 0) return 0;

  const listFile = path.join(os.tmpdir(), `dsh-runtime-repair-${process.pid}.txt`);
  fs.writeFileSync(listFile, missing.join('\n'), 'utf8');
  onProgress?.(`正在并行修复运行时（缺失 ${missing.length} 个文件）…`);
  log(`开始修复运行时：从 tar 并行补齐 ${missing.length} 个文件`);

  try {
    await extractParallel(tarFile, destBase, listFile, onProgress);
  } finally {
    try {
      fs.unlinkSync(listFile);
    } catch {
      /* ignore */
    }
  }

  let fixed = 0;
  for (const rel of missing) if (exists(destBase, rel)) fixed++;
  log(`修复完成：成功补齐 ${fixed}/${missing.length} 个文件`);
  return fixed;
}

// ---------------------------------------------------------------------------
// 多线程解压（与安装期 NSIS 调用的是同一份脚本）
// ---------------------------------------------------------------------------

/**
 * 调用多线程解压器。
 *
 * 用 Electron 自身二进制充当 Node 解释器（ELECTRON_RUN_AS_NODE=1），
 * 这样不必额外分发 Node 运行时 —— 与安装期 NSIS 的做法完全一致。
 */
function runExtractor(args: string[], onProgress?: (message: string) => void): Promise<void> {
  const script = extractRuntimeScript();
  if (!fs.existsSync(script)) {
    return Promise.reject(new Error(`未找到多线程解压器：${script}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let tail = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-2000);
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('[extract-runtime]')) {
          onProgress?.(line.replace('[extract-runtime]', '').trim());
        }
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (err) => reject(err));
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`多线程解压器退出码 ${code}：${tail.slice(-400)}`));
    });
  });
}

/**
 * 并行解压（失败则回退单线程 tar，保证任何环境下都能落地）。
 *
 * @param onlyListFile 非空时只解压清单内的缺失文件（修复路径）
 */
async function extractParallel(
  tarFile: string,
  destBase: string,
  onlyListFile: string | null,
  onProgress?: (message: string) => void,
  versionTag?: string,
): Promise<void> {
  const args = ['--tar', tarFile, '--dest', destBase];
  if (onlyListFile) args.push('--only', onlyListFile);
  if (versionTag) args.push('--version-tag', versionTag);
  if (!onProgress) args.push('--quiet');

  try {
    await runExtractor(args, onProgress);
    return;
  } catch (err) {
    log(`多线程解压不可用（${String((err as Error)?.message ?? err)}），回退单线程 tar`);
    onProgress?.('多线程解压不可用，改用单线程方式（会慢一些）…');
  }

  if (onlyListFile) await runTar(['-xf', tarFile, '-C', destBase, '-T', onlyListFile]);
  else await runTar(['-xf', tarFile, '-C', destBase]);
}

// ---------------------------------------------------------------------------
// tar 调用（必须用 Windows 自带的 bsdtar）
// ---------------------------------------------------------------------------

function runTar(args: string[]): Promise<void> {
  // 不使用裸 "tar"：Git Bash / MSYS 下的 GNU tar 会把 "D:\..." 里的冒号
  // 当作远程主机名而失败（Cannot connect to D: resolve failed）。
  const tarExe =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';

  return new Promise((resolve, reject) => {
    const child = spawn(tarExe, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });

    child.once('error', (err) => {
      reject(
        new Error(
          `无法调用系统 tar：${err.message}。请确认系统为 Windows 10 1803 或更高版本。`,
        ),
      );
    });

    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar 退出码 ${code}：${stderr.slice(-500)}`));
    });
  });
}
