import * as fs from 'fs';
import * as path from 'path';

export const DSH_PACKAGE = '@deepseek-ai/dsh';

export interface DshInstall {
  /** 运行时根目录（含 node_modules） */
  runtimeDir: string;
  /** dsh 包目录 */
  packageDir: string;
  /** 从 package.json 的 bin 字段解析出的入口文件绝对路径 */
  entry: string;
  /** 已安装版本 */
  version: string;
}

export interface VerifyResult {
  ok: boolean;
  install?: DshInstall;
  /** 人类可读的问题列表 */
  problems: string[];
  /** 修复建议 */
  hints: string[];
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 解析 dsh 入口 —— 不硬编码 lib/bin.js，而是读取包的 bin 字段。
 * 这样 dsh 升级后入口变化也不会让外壳失效。
 */
function resolveEntryFromBin(packageDir: string, pkg: any): string | null {
  const bin = pkg?.bin;
  let rel: string | undefined;

  if (typeof bin === 'string') {
    rel = bin;
  } else if (bin && typeof bin === 'object') {
    // 优先取名为 dsh 的入口，否则取第一个
    rel = bin.dsh ?? (Object.values(bin)[0] as string | undefined);
  }
  if (!rel) return null;

  const abs = path.resolve(packageDir, rel);
  return fs.existsSync(abs) ? abs : null;
}

/** 校验 dsh 运行时完整性（首次启动时调用） */
export function verifyRuntime(runtimeDir: string): VerifyResult {
  const problems: string[] = [];
  const hints: string[] = [];

  if (!fs.existsSync(runtimeDir)) {
    problems.push(`未找到 dsh 运行时目录：${runtimeDir}`);
    hints.push('安装包可能不完整，请重新安装 DSH Desktop（运行时随安装包一起分发）。');
    return { ok: false, problems, hints };
  }

  const packageDir = path.join(runtimeDir, 'node_modules', DSH_PACKAGE);
  if (!fs.existsSync(packageDir)) {
    problems.push(`未找到 ${DSH_PACKAGE}：${packageDir}`);
    hints.push('请运行 `npm run prepare:runtime` 重新拉取 dsh 运行时后重新打包。');
    return { ok: false, problems, hints };
  }

  const pkg = readJson(path.join(packageDir, 'package.json'));
  if (!pkg) {
    problems.push(`dsh 的 package.json 无法解析：${packageDir}`);
    hints.push('文件可能损坏，请重新安装。');
    return { ok: false, problems, hints };
  }

  const entry = resolveEntryFromBin(packageDir, pkg);
  if (!entry) {
    problems.push('无法从 dsh 的 package.json bin 字段解析出入口文件。');
    hints.push('这通常意味着运行时目录不完整，请重新安装或重新打包。');
    return { ok: false, problems, hints };
  }

  return {
    ok: true,
    install: { runtimeDir, packageDir, entry, version: String(pkg.version ?? 'unknown') },
    problems,
    hints,
  };
}
