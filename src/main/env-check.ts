/**
 * 环境依赖体检（外壳侧，只读、不碰 Harness 源码）。
 *
 * 目前只有一项：Windows 上 PowerShell 的版本。
 *
 * ── 为什么要检 ────────────────────────────────────────────────────────────
 * Harness 的 `pwsh` 工具走 `@deepseek-ai/dsh-pwsh-local`，它按下面的顺序解析可执行文件
 * （见该包 lib/index.js 的 candidatePwshPaths）：
 *   1. %ProgramFiles%\PowerShell\7\pwsh.exe
 *   2. PATH 里的每一项 \pwsh.exe
 *   3. %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe      ← 兜底
 *
 * Windows 10/11 通常命中的是 1 或 2（PowerShell 7，自带 UTF-8，没问题）。
 * **Windows 7 命中的必然是 3** —— Win7 装不了应用商店版的 pwsh，而且 PowerShell 7
 * 从 .NET 6 那一代起不再支持 Win7，能跑的旧版 7.x 要手动装，实际很少有人有。
 *
 * 而该执行器给每条命令加的前导是：
 *   [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ...
 * `[Type]::new(...)` 是 **PowerShell 5.0** 才有的语法。Win7 SP1 出厂自带 2.0
 * （3.0/4.0 来自 WMF 3/4），前导会直接抛「找不到 new 的重载」，
 * 表现为 **pwsh 工具每次都失败，而应用不告诉用户原因**。
 *
 * 所以这里做一次探测：解析出「dsh 实际会用哪个」，问它的主版本号；
 * 小于 5 就给出可操作的提示（装 Windows Management Framework 5.1）。
 *
 * ── 为什么探测顺序要和 dsh 一致 ───────────────────────────────────────────
 * 只查 powershell.exe 会误报：装了 PowerShell 7 的机器上 dsh 用 7，powershell.exe
 * 是 2.0 也无所谓。反过来只查 pwsh 又会漏掉 Win7。所以照抄它的候选顺序，
 * 探第一个存在的。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { log } from './logger';

export interface EnvWarning {
  /** 稳定标识，界面用它做去重/忽略 */
  id: string;
  /** 一句话说清问题 */
  title: string;
  /** 补充说明：现象与影响 */
  detail: string;
  /** 怎么办 */
  fix: string;
  /** 官方下载页（没有就为空） */
  url?: string;
}

/** Windows Management Framework 5.1 官方下载页（微软官方，长期有效） */
const WMF51_URL = 'https://www.microsoft.com/download/details.aspx?id=54616';

/**
 * 按 dsh 的顺序列出候选可执行文件。
 * 刻意与 @deepseek-ai/dsh-pwsh-local 的 candidatePwshPaths 保持一致 ——
 * 我们回答的是「dsh 会用哪个」，不是「本机装了哪些」。
 */
export function candidatePwshPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env.ProgramFiles ?? 'C:\Program Files';
  const systemRoot = env.SystemRoot ?? 'C:\Windows';
  const out = [path.join(programFiles, 'PowerShell', '7', 'pwsh.exe')];
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed.length === 0) continue;
    out.push(path.join(trimmed, 'pwsh.exe'));
  }
  out.push(path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  return out;
}

/** 第一个存在的候选（找不到就返回 null） */
export function resolveShellExe(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of candidatePwshPaths(env)) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() || stat.isSymbolicLink()) return candidate;
    } catch {
      /* 下一个 */
    }
  }
  return null;
}

/**
 * 问一个 PowerShell 可执行文件的主版本号。
 *
 * 用 `-NoProfile` 保证不受用户 profile 影响；超时 8 秒。
 * 拿不到（不存在 / 超时 / 输出不像数字）返回 null —— **绝不把探测失败当成不合格**，
 * 否则杀软拦截一次就让所有用户看到假警告。
 */
export function powershellMajor(exe: string): number | null {
  try {
    const res = spawnSync(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    if (res.status !== 0) return null;
    const n = parseInt(String(res.stdout ?? '').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

let cached: EnvWarning[] | null = null;

/**
 * 体检结果（进程内缓存一次；结果只依赖本机环境，启动后不会变）。
 *
 * 只在 Windows 上做这件事；其它平台直接返回空数组。
 */
export function envWarnings(): EnvWarning[] {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    cached = [];
    return cached;
  }

  const exe = resolveShellExe();
  if (!exe) {
    // 三个候选都不存在：这台机器没有任何 PowerShell，dsh 的 pwsh 工具必然不可用
    cached = [
      {
        id: 'powershell-missing',
        title: '本机找不到 PowerShell，命令执行工具将不可用',
        detail: 'Harness 的 pwsh 工具需要 powershell.exe 或 pwsh.exe，两者都没有找到。',
        fix: 'Windows 7 请安装 Windows Management Framework 5.1（含 PowerShell 5.1），然后重启本应用。',
        url: WMF51_URL,
      },
    ];
    log('环境体检：找不到任何 PowerShell（pwsh / powershell 均不存在）');
    return cached;
  }

  const major = powershellMajor(exe);
  log('环境体检：命令执行器 = ' + exe + '（主版本 ' + (major === null ? '未知' : major) + '）');

  // 探测不出来时保持安静：宁可漏报，也不要因为一次超时/被杀软拦住就天天弹假警告
  if (major === null || major >= 5) {
    cached = [];
    return cached;
  }

  const isWindowsPowerShell = /powershell\.exe$/i.test(exe);
  cached = [
    {
      id: 'powershell-too-old',
      title: 'PowerShell 版本过低（当前 ' + major + '.x，需要 5.0 以上）',
      detail:
        '命令执行工具每次调用都会先执行一句 UTF-8 编码设置，其中用到了 [Type]::new(...) —— ' +
        '这是 PowerShell 5.0 才有的语法。当前用的是 ' +
        (isWindowsPowerShell ? 'Windows PowerShell' : 'pwsh') +
        ' ' + major + '.x，该语句会直接报「找不到 new 的重载」，于是每条命令都失败且没有输出。',
      fix:
        '安装 Windows Management Framework 5.1（含 PowerShell 5.1）后重启本应用。' +
        'Windows 7 出厂自带的 2.0 以及 WMF 3 / WMF 4 都不满足。',
      url: WMF51_URL,
    },
  ];
  return cached;
}

/** 覆盖缓存（测试用） */
export function resetEnvWarningsCache(): void {
  cached = null;
}
