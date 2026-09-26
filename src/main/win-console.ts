/**
 * Windows：为外壳进程准备一个「隐藏控制台」。
 *
 * 【为什么需要】
 * Harness 在 Windows 上执行命令走沙箱：`dsh-pwsh-sandbox` 把命令交给
 * `ctx.sandbox`，后者在 Windows 上解析成 **ACL 受限令牌（restricted token）**
 * 运行链。受限令牌下**不能**用 CREATE_NO_WINDOW 创建子进程——子进程会以
 * STATUS_DLL_INIT_FAILED 直接死掉（见 `@deepseek-ai/dsh-sandbox-windows-acl`
 * 的说明），于是该路径只能让系统给子进程新建一个控制台，表现为：每次让
 * Harness 跑命令就"莫名其妙弹出一个窗口"。
 *
 * 同一个包的说明里还写着：**受限令牌下的子进程共享宿主控制台**
 * （"children share the host console"）。据此，只要宿主进程（dsh）自己有
 * 控制台——哪怕是被隐藏的——沙箱子进程就会继承它，不再新建窗口。
 *
 * 【做法】
 * 1) 外壳进程在这里 AllocConsole() 分配一个控制台（仅当本来没有时）；
 * 2) 立刻用 SW_HIDE 把它隐藏；
 * 3) spawn dsh 时**不要** windowsHide，让它继承这个控制台
 *    （见 dsh-service.ts：windowsHide 已改为 false）。
 *
 * 【注意】
 * - 只在「本来没有控制台」时才分配并隐藏；若用户是从终端启动外壳，
 *   那个控制台属于用户，不抢也不藏。
 * - 需要 FFI 调 Win32 API：复用 Harness 运行时里已有的 koffi（ABI 与外壳一致，
 *   两者用同一个 electron.exe）。取不到就安静失败，退回原来的行为。
 */
import * as fs from 'fs';
import * as path from 'path';
import { log } from './logger';
import { findRuntimeDir } from './runtime-patch';

let prepared = false;

export function ensureHiddenConsole(): void {
  if (process.platform !== 'win32' || prepared) return;
  prepared = true;

  try {
    // 用 findRuntimeDir() 而不是 packagedRuntimeDir()：后者在开发态指向
    // electron 自己的 resources（那里没有 dsh-runtime），前者能按候选顺序
    // 找到真正使用的运行时目录。
    const koffiPath = require.resolve('koffi', {
      paths: [path.join(findRuntimeDir(), 'node_modules')],
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require(koffiPath);

    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');

    const getConsoleWindow = kernel32.func('void *GetConsoleWindow()');
    const allocConsole = kernel32.func('int AllocConsole()');
    const showWindow = user32.func('bool ShowWindow(void *hwnd, int nCmdShow)');

    const existing = getConsoleWindow();
    if (!existing) {
      allocConsole();
      const created = getConsoleWindow();
      if (created) {
        showWindow(created, 0); // SW_HIDE
        log('已分配隐藏控制台：Harness 沙箱命令将继承它，不再弹出新窗口');
      } else {
        log('分配隐藏控制台未生效（GetConsoleWindow 仍为空）');
      }
    } else {
      // 从终端启动时已有控制台，属于用户，不抢不藏
      log('检测到已有控制台（可能从终端启动），跳过隐藏控制台准备');
    }
  } catch (err) {
    log(`准备隐藏控制台失败（不影响启动，命令仍可能弹窗）：${String((err as Error)?.message ?? err)}`);
  }
}

// ---------------------------------------------------------------------------
// 运行时补丁：dsh-win32-process 的 CreateProcessW 普通令牌路径补 CREATE_NO_WINDOW
// ---------------------------------------------------------------------------

/**
 * 【为什么】dsh-win32-process 派生普通令牌子进程（grep/ripgrep 等工具进程）时，
 * CreateProcessW 的创建标志只有 CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT，
 * 没有 CREATE_NO_WINDOW。外壳/dsh 都是 GUI 子系统进程（没有控制台可继承），
 * console 子系统子进程就会被 Windows 新建一个可见控制台窗口 —— 即"跑命令弹黑窗"。
 *
 * 【为什么不能补受限令牌路径】spawnInheritedJobProcess / spawnPipedProcess
 * （CreateProcessAsUserW，ACL 沙箱专用）加 CREATE_NO_WINDOW 会让子进程以
 * STATUS_DLL_INIT_FAILED (0xC0000142) 死亡（dsh-sandbox-windows-acl README
 * "Console isolation is unavailable"）。沙箱树不弹窗靠"受限子进程共享宿主控制台"。
 *
 * 【为什么放外壳里】补丁打在运行时的编译产物上，上游运行时热更新/自愈修复会
 * 覆盖它；启动时幂等重打一次，保证弹窗修复始终在场。上游若改了实现导致锚点
 * 失配，安静跳过（宁可不补也不能改坏）。
 */

const WIN32_PROCESS_FILE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-win32-process',
  'lib',
  'index.js',
);

/** 补丁锚点：常量插入点与 createProcessW 标志位（与上游编译产物逐字匹配）。 */
const ANCHOR_JOB_LIMIT = 'const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192;';
const ANCHOR_CREATE_PROCESS_W =
  'api.createProcessW(options.applicationName, commandLine, null, null, 1, 1028, environment, options.cwd, startupInfo, processInfo)';
const PATCHED_CREATE_PROCESS_W =
  'api.createProcessW(options.applicationName, commandLine, null, null, 1, 1028 | CREATE_NO_WINDOW, environment, options.cwd, startupInfo, processInfo)';
const PATCHED_MARKER = 'CREATE_NO_WINDOW';

const PATCHED_CONSTANT = [
  'const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 8192;',
  '/** CREATE_NO_WINDOW: spawn console children without a visible console window.',
  ' *  Normal-token path ONLY — restricted-token children (ACL sandbox) die with',
  ' *  STATUS_DLL_INIT_FAILED. Patched by DSH Desktop shell (idempotent). */',
  'const CREATE_NO_WINDOW = 0x08000000;',
].join('\n');

export function ensureWin32ProcessNoWindowPatch(runtimeDir: string): void {
  if (process.platform !== 'win32') return;
  try {
    const file = path.join(runtimeDir, WIN32_PROCESS_FILE);
    if (!fs.existsSync(file)) {
      log('win32-process 补丁：未找到目标文件，跳过');
      return;
    }
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes(PATCHED_MARKER)) return; // 已打过，幂等退出
    // 上游实现若已自带等价修复（dwFlags/创建标志变了），锚点失配 → 不动它
    if (!content.includes(ANCHOR_JOB_LIMIT) || !content.includes(ANCHOR_CREATE_PROCESS_W)) {
      log('win32-process 补丁：锚点未匹配（上游实现可能已变化），跳过');
      return;
    }
    const patched = content
      .replace(ANCHOR_JOB_LIMIT, PATCHED_CONSTANT)
      .replace(ANCHOR_CREATE_PROCESS_W, PATCHED_CREATE_PROCESS_W);
    fs.writeFileSync(file, patched, 'utf8');
    log('win32-process 补丁：已应用 CREATE_NO_WINDOW（普通令牌路径不再弹出控制台窗口）');
  } catch (err) {
    log(`win32-process 补丁失败（不影响启动）：${String((err as Error)?.message ?? err)}`);
  }
}
