/**
 * 内置命令行工具（git / python）的定位与 PATH 注入。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * dsh 跑命令时继承的是**外壳进程的 PATH**。Windows 上 git 常常不在 PATH（实测本机
 * 就找不到 git），于是模型执行 git 状态查询直接 'not recognized'；python 同理。
 * 用户装完 DSH Desktop 却要自己配环境才能用，体验很差。
 *
 * ── 做法：随安装包内置，启动 dsh 时注入 PATH ────────────────────────────────
 * 产物由 scripts/prepare-tools.mjs 生成到 resources/tools/：
 *   tools/git/bin/git.exe      PortableGit 裁剪副本（26MB）
 *   tools/python/python.exe    官方 embeddable + pip（约 30MB）
 *
 * 只在**目录真实存在**时才注入，避免开发态（未跑 prepare-tools）把不存在的路径塞进 PATH。
 * 注入是**前置**的：内置工具优先于系统里的同名命令，保证行为可预期。
 */

import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';

/** 内置工具根目录（打包态在 resources/ 下；开发态在仓库 resources/ 下） */
function toolsRoot(): string {
  // 打包态：app.asar 之外，进程资源目录
  const packaged = path.join(process.resourcesPath ?? '', 'tools');
  if (fs.existsSync(path.join(packaged, 'git'))) return packaged;
  // 开发态：仓库根/resources/tools（__dirname 形如 <root>/out/main）
  return path.join(__dirname, '..', '..', 'resources', 'tools');
}

export interface BuiltinTools {
  /** 存在且可用的 git 可执行文件 */
  gitExe?: string;
  /** 存在且可用的 python 可执行文件 */
  pythonExe?: string;
  /** 要前置到 PATH 的目录（去重、只含存在的） */
  pathDirs: string[];
}

/**
 * 探测内置工具。
 *
 * 返回值只包含**确实存在**的项 —— 调用方据此拼 PATH，不会引入死路径。
 */
export function detectBuiltinTools(): BuiltinTools {
  const root = toolsRoot();
  const out: BuiltinTools = { pathDirs: [] };

  const gitExe = path.join(root, 'git', 'bin', 'git.exe');
  if (fs.existsSync(gitExe)) {
    out.gitExe = gitExe;
    out.pathDirs.push(path.dirname(gitExe));
  }

  // python：可执行文件与 Scripts/（pip 装的命令行工具落在这）
  const pythonExe = path.join(root, 'python', 'python.exe');
  if (fs.existsSync(pythonExe)) {
    out.pythonExe = pythonExe;
    out.pathDirs.push(path.dirname(pythonExe));
    const scripts = path.join(root, 'python', 'Scripts');
    if (fs.existsSync(scripts)) out.pathDirs.push(scripts);
  }

  return out;
}

/**
 * 把内置工具目录前置到 PATH。
 *
 * @param baseEnv 原始环境（通常是 process.env）
 * @returns 新的 PATH 值；没有可注入项时返回原值（不制造无谓差异）
 */
export function prependToolsToPath(baseEnv: NodeJS.ProcessEnv): string {
  const cur = baseEnv.PATH ?? baseEnv.Path ?? '';
  const { pathDirs, gitExe, pythonExe } = detectBuiltinTools();
  if (pathDirs.length === 0) return cur;

  const sep = process.platform === 'win32' ? ';' : ':';
  // 去重：避免重复运行时 PATH 越滚越长
  const existing = new Set(cur.split(sep).filter(Boolean).map((p) => p.toLowerCase()));
  const add = pathDirs.filter((d) => !existing.has(d.toLowerCase()));
  if (add.length === 0) return cur;

  log(
    '内置工具注入 PATH：' +
      [gitExe ? 'git' : null, pythonExe ? 'python' : null].filter(Boolean).join(' + ') +
      '（' + add.join(' ; ') + '）',
  );
  return add.join(sep) + sep + cur;
}
