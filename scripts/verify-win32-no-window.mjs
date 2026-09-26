// 验证 @deepseek-ai/dsh-win32-process 控制台弹窗补丁。
//
// 原理：本测试进程是 GUI 子系统的 electron.exe（ELECTRON_RUN_AS_NODE=1），
// 自身没有控制台 → 它用 spawnCurrentTokenJobProcess（CreateProcessW 普通令牌
// 路径）派生的 console 子进程（如 ping）默认会分配一个【可见】控制台窗口。
// 补丁（CREATE_NO_WINDOW）之后应为「无头控制台」，不再出现新窗口。
//
// 用法：
//   ELECTRON_RUN_AS_NODE=1 "D:\dsh\DSH Desktop\DSH Desktop.exe" \
//     verify-win32-no-window.mjs <dsh-win32-process/lib/index.js 路径> \
//     [命令 参数...]（默认 ping -n 4 127.0.0.1，存活约 3 秒）
//
// 判定：枚举可见控制台顶层窗口（conhost / Windows Terminal 两种窗口类），
// 取派生前快照，派生期间轮询；出现新控制台窗口 = 弹窗（补丁无效/未打）。
// 本机 koffi 为 3.3.1：回调只在 EnumWindows 调用期间使用 → 瞬态回调直接传函数。

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleFile = path.resolve(process.argv[2]);
const command = process.argv.slice(3);
if (command.length === 0) command.push('ping', '-n', '4', '127.0.0.1');

const requireFromModule = createRequire(moduleFile);
const koffi = requireFromModule('koffi');
const mod = await import(pathToFileURL(moduleFile).href);

// ── Win32 窗口枚举 ──────────────────────────────────────────────────────────
const user32 = koffi.load('user32.dll');
const EnumWindowsProc = koffi.proto('__stdcall', 'DSH_EnumWindowsProc', 'bool', ['void *', 'intptr']);
const EnumWindows = user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(EnumWindowsProc), 'intptr']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', ['void *']);
const GetClassNameW = user32.func('__stdcall', 'GetClassNameW', 'int', ['void *', 'void *', 'int']);
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', ['void *', 'void *', 'int']);

const decodeUtf16 = (buf, chars) => buf.toString('utf16le', 0, Math.max(0, chars) * 2);
// Win11 默认终端（Windows Terminal）的窗口类与经典 conhost 不同，两种都算控制台窗口
const CONSOLE_CLASSES = new Set(['ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS']);

function visibleConsoleWindows() {
  const found = [];
  const collect = (hwnd, _lparam) => {
    try {
      if (!IsWindowVisible(hwnd)) return true;
      const clsBuf = Buffer.alloc(512);
      const cls = decodeUtf16(clsBuf, GetClassNameW(hwnd, clsBuf, 256));
      if (!CONSOLE_CLASSES.has(cls)) return true;
      const titleBuf = Buffer.alloc(1024);
      const title = decodeUtf16(titleBuf, GetWindowTextW(hwnd, titleBuf, 512));
      found.push(`${cls}|${title}`);
    } catch { /* ignore */ }
    return true;
  };
  try {
    EnumWindows(collect, 0);
  } catch { /* ignore */ }
  return found;
}

// ── 被测模块 ────────────────────────────────────────────────────────────────
const api = mod.loadWin32ProcessBindings();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`[verify] 模块：${moduleFile}`);
console.log(`[verify] 命令：${command.join(' ')}`);
const before = visibleConsoleWindows();
console.log(`[verify] 派生前可见控制台窗口 ${before.length} 个：${JSON.stringify(before)}`);

const spawned = mod.spawnCurrentTokenJobProcess(api, {
  command: command[0],
  args: command.slice(1),
  cwd: process.cwd(),
  env: process.env,
  applicationName: null,
  stdio: { stdin: 0, stdout: 1, stderr: 2 },
});
console.log(`[verify] 子进程 pid=${spawned.pid}`);

let popup = null;
const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  const now = visibleConsoleWindows();
  const fresh = now.find((t) => !before.includes(t));
  if (fresh) {
    popup = fresh;
    break;
  }
  const alive = mod.pollProcessExit(api, spawned.process);
  if (alive !== undefined) break; // 进程已退出且始终无新窗口
  await sleep(120);
}

const exitCode = await mod.waitForProcessExit(api, spawned.process);
try {
  mod.closeHandleChecked(api, spawned.job);
} catch { /* 已随进程关闭 */ }

if (popup) {
  console.log(`[verify] ❌ 弹窗复现：出现新控制台窗口「${popup}」`);
  process.exitCode = 1;
} else {
  console.log(`[verify] ✅ 全程无新控制台窗口（exit=${exitCode}）`);
}
console.log(`[verify] 子进程 exit=${exitCode}（非 0 说明命令本身失败，与弹窗判定无关）`);
