/**
 * Win32 原生能力层（computer use 的底座）。
 *
 * 为什么用 koffi 直接调 Win32 而不是引第三方自动化库：
 *   · dsh 运行时里**已经带了 koffi**（3.3.1，profile 里可解析），零新增依赖
 *   · 不引入 playwright/puppeteer 那种几十 MB 的浏览器栈
 *   · 目标是「操作本机桌面」，本来就该用原生 API
 *
 * ⚠️ koffi 3.3.1 的 callback 写法（踩过，别写错）：
 *   ❌ koffi.callback(...) —— 3.x 没有这个函数
 *   ❌ koffi.proto('bool', 'intptr_t', 'intptr_t') —— 参数必须是**数组**
 *   ✅ const P = koffi.proto('bool', ['intptr_t', 'intptr_t']);
 *      const cb = koffi.register(fn, koffi.pointer(P));
 *      用完 koffi.unregister(cb)（否则回调常驻）
 *
 * 本模块只做「能力」，不做「策略」——工具定义在 index.js。
 */

import { createRequire } from 'node:module';
import { encodePng, bgraToRgba } from './png.js';

// koffi 的解析位置有讲究：
//   · **落位后**（正常运行时）：插件在 `$DSH_HOME/profiles/node_modules/@dsh-desktop/computer-use/`，
//     从那里向上就能命中 `profiles/node_modules/koffi`（dsh 自己链好的）→ 普通 require 即可。
//   · **源码态**（开发调试）：插件在仓库 `resources/dsh-plugins/…`，向上找不到 koffi，
//     需要显式回退到 dsh 运行时的 node_modules。
// 所以先试普通解析，失败再按几个已知位置兜底。
const require = createRequire(import.meta.url);

/** 按候选位置解析 koffi；返回 koffi 模块或 null */
function loadKoffi() {
  try {
    return require('koffi');
  } catch {
    /* 继续兜底 */
  }
  const cands = [
    process.env.DSH_COMPUTER_USE_KOFFI,
    // 源码态：外壳自己的运行时树
    new URL('../../../../dsh-runtime/node_modules/koffi/package.json', import.meta.url).pathname,
    // 落位态：DSH_HOME 下的 profile 共享 node_modules
    process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/node_modules/koffi/package.json` : '',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      const dir = c.replace(/\/package\.json$/, '').replace(/^\//, '');
      return require(dir);
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

let koffi = null;
let user32 = null;
let gdi32 = null;
let kernel32 = null;
let dwmapi = null;

/** 延迟加载：插件被加载但没人调用工具时，不付这份开销 */
export function ensureWin32() {
  if (koffi) return;
  koffi = loadKoffi();
  if (!koffi) {
    throw new Error(
      'computer use 需要 koffi（Win32 FFI），但没能解析到它。' +
        '它由 dsh 运行时提供（profiles/node_modules/koffi）；' +
        '若在源码态调试，可用环境变量 DSH_COMPUTER_USE_KOFFI 指定路径。',
    );
  }
  user32 = koffi.load('user32.dll');
  gdi32 = koffi.load('gdi32.dll');
  kernel32 = koffi.load('kernel32.dll');
  // dwmapi 用来问「这个窗口是不是被 DWM 隐藏了」（UWP 的幽灵窗口）以及拿真实边界。
  // 拿不到也不致命（老系统/精简系统可能没有），所以单独 try。
  try { dwmapi = koffi.load('dwmapi.dll'); } catch { dwmapi = null; }
}

export function isSupported() {
  return process.platform === 'win32';
}

// ---------------------------------------------------------------------------
// 函数表（首次使用时绑定）
// ---------------------------------------------------------------------------

let F = null;

function funcs() {
  if (F) return F;
  ensureWin32();
  F = {
    // 屏幕
    GetSystemMetrics: user32.func('int GetSystemMetrics(int nIndex)'),
    // 窗口
    EnumWindows: user32.func('bool EnumWindows(void* lpEnumFunc, intptr_t lParam)'),
    IsWindowVisible: user32.func('bool IsWindowVisible(intptr_t hWnd)'),
    IsWindowEnabled: user32.func('bool IsWindowEnabled(intptr_t hWnd)'),
    GetWindowTextW: user32.func('int GetWindowTextW(intptr_t hWnd, _Out_ uint16_t* lpString, int nMaxCount)'),
    GetClassNameW: user32.func('int GetClassNameW(intptr_t hWnd, _Out_ uint16_t* lpString, int nMaxCount)'),
    GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32* lpdwProcessId)'),
    GetWindowRect: user32.func('bool GetWindowRect(intptr_t hWnd, _Out_ void* lpRect)'),
    IsIconic: user32.func('bool IsIconic(intptr_t hWnd)'),
    IsZoomed: user32.func('bool IsZoomed(intptr_t hWnd)'),
    SetForegroundWindow: user32.func('bool SetForegroundWindow(intptr_t hWnd)'),
    ShowWindow: user32.func('bool ShowWindow(intptr_t hWnd, int nCmdShow)'),
    MoveWindow: user32.func('bool MoveWindow(intptr_t hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint)'),
    GetForegroundWindow: user32.func('intptr_t GetForegroundWindow()'),
    // 光标 / 鼠标
    GetCursorPos: user32.func('bool GetCursorPos(_Out_ void* lpPoint)'),
    SetCursorPos: user32.func('bool SetCursorPos(int X, int Y)'),
    mouse_event: user32.func('void mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr_t dwExtraInfo)'),
    // 键盘
    keybd_event: user32.func('void keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr_t dwExtraInfo)'),
    MapVirtualKeyW: user32.func('uint32 MapVirtualKeyW(uint32 uCode, uint32 uMapType)'),
    GetKeyState: user32.func('short GetKeyState(int nVirtKey)'),
    // GDI 截屏
    GetDC: user32.func('intptr_t GetDC(intptr_t hWnd)'),
    ReleaseDC: user32.func('int ReleaseDC(intptr_t hWnd, intptr_t hDC)'),
    GetWindowDC: user32.func('intptr_t GetWindowDC(intptr_t hWnd)'),
    CreateCompatibleDC: gdi32.func('intptr_t CreateCompatibleDC(intptr_t hdc)'),
    CreateCompatibleBitmap: gdi32.func('intptr_t CreateCompatibleBitmap(intptr_t hdc, int nWidth, int nHeight)'),
    SelectObject: gdi32.func('intptr_t SelectObject(intptr_t hdc, intptr_t h)'),
    BitBlt: gdi32.func('bool BitBlt(intptr_t hdcDest, int x, int y, int cx, int cy, intptr_t hdcSrc, int x1, int y1, uint32 rop)'),
    GetDIBits: gdi32.func('int GetDIBits(intptr_t hdc, intptr_t hbm, uint32 start, uint32 cLines, _Out_ void* lpvBits, _Inout_ void* lpbmi, uint32 usage)'),
    DeleteObject: gdi32.func('bool DeleteObject(intptr_t ho)'),
    DeleteDC: gdi32.func('bool DeleteDC(intptr_t hdc)'),
    // 前台窗口切换（SetForegroundWindow 会被系统拒绝，需要这个技巧）
    AttachThreadInput: user32.func('bool AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
    GetWindowThreadProcessId2: user32.func('uint32 GetWindowThreadProcessId(intptr_t hWnd, void* lpdwProcessId)'),
    GetCurrentThreadId: kernel32.func('uint32 GetCurrentThreadId()'),
    BringWindowToTop: user32.func('bool BringWindowToTop(intptr_t hWnd)'),
    SetActiveWindow: user32.func('intptr_t SetActiveWindow(intptr_t hWnd)'),
    SetFocus: user32.func('intptr_t SetFocus(intptr_t hWnd)'),
    SwitchToThisWindow: user32.func('void SwitchToThisWindow(intptr_t hWnd, bool fUnknown)'),
    // DWM：窗口是否被隐藏（cloked）、窗口的真实可见边界（去掉阴影边框）
    DwmGetWindowAttribute: dwmapi
      ? dwmapi.func('int DwmGetWindowAttribute(intptr_t hwnd, uint32 attr, _Out_ void* pv, uint32 cb)')
      : null,
  };
  return F;
}

// ---------------------------------------------------------------------------
// 结构体读取（koffi 返回的是 buffer，手工解）
// ---------------------------------------------------------------------------

function readRect(buf) {
  return {
    left: buf.readInt32LE(0),
    top: buf.readInt32LE(4),
    right: buf.readInt32LE(8),
    bottom: buf.readInt32LE(12),
  };
}

function readPoint(buf) {
  return { x: buf.readInt32LE(0), y: buf.readInt32LE(4) };
}

/** DWMWA_CLOAKED：0 = 正常显示；1/2/4 = 被 DWM 隐藏（UWP 后台页、最小化的商店应用等） */
function isCloaked(f, hwnd) {
  if (!f.DwmGetWindowAttribute) return false; // 没有 dwmapi 时按「未隐藏」处理
  try {
    const buf = Buffer.alloc(4);
    const hr = f.DwmGetWindowAttribute(hwnd, 14, buf, 4);
    if (hr !== 0) return false;
    return buf.readUInt32LE(0) !== 0;
  } catch {
    return false;
  }
}

/** DWMWA_EXTENDED_FRAME_BOUNDS：窗口的**可见**边界（去掉投影与不可见边框），失败返回 null */
function extendedFrame(f, hwnd) {
  if (!f.DwmGetWindowAttribute) return null;
  try {
    const buf = Buffer.alloc(16);
    const hr = f.DwmGetWindowAttribute(hwnd, 9, buf, 16);
    if (hr !== 0) return null;
    return readRect(buf);
  } catch {
    return null;
  }
}

function wstr(buf, n) {
  if (n <= 0) return '';
  return buf.toString('utf16le', 0, n * 2).replace(/\u0000+$/, '');
}

// ---------------------------------------------------------------------------
// 屏幕 / 窗口
// ---------------------------------------------------------------------------

export function screenSize() {
  const f = funcs();
  return { width: f.GetSystemMetrics(0), height: f.GetSystemMetrics(1) };
}

export function cursorPos() {
  const f = funcs();
  const buf = Buffer.alloc(8);
  f.GetCursorPos(buf);
  return readPoint(buf);
}

/** 枚举可见窗口（带标题的），返回 { hwnd, title, className, pid, rect, minimized, maximized } */
export function listWindows() {
  const f = funcs();
  const out = [];
  const PROC = koffi.proto('bool', ['intptr_t', 'intptr_t']);
  const cb = koffi.register((hwnd) => {
    try {
      if (!f.IsWindowVisible(hwnd)) return true;
      // 被 DWM 隐藏的窗口 IsWindowVisible 仍返回 true（UWP 后台页、已关闭的商店应用），
      // 它们会以「Windows 输入体验」「新通知」之类标题混进列表 —— 实测一次能混进 13 个，
      // 把真正的窗口淹没。cloked 判定是唯一可靠的过滤手段。
      if (isCloaked(f, hwnd)) return true;
      const tbuf = Buffer.alloc(1024);
      const tn = f.GetWindowTextW(hwnd, tbuf, 512);
      if (tn <= 0) return true; // 无标题的（工具窗/隐藏窗）跳过
      const title = wstr(tbuf, tn);
      if (!title) return true;
      const cbuf = Buffer.alloc(512);
      const cn = f.GetClassNameW(hwnd, cbuf, 256);
      const pbuf = Buffer.alloc(4);
      f.GetWindowThreadProcessId(hwnd, pbuf);
      const rbuf = Buffer.alloc(16);
      f.GetWindowRect(hwnd, rbuf);
      const rect = readRect(rbuf);
      // 零尺寸/1x1 的是消息窗与辅助窗，点不到也没内容，一并滤掉
      if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return true;
      out.push({
        hwnd: String(hwnd),
        title,
        className: wstr(cbuf, cn),
        pid: pbuf.readUInt32LE(0),
        rect,
        // 真实可见边界（截窗口时用它才不含投影/不可见边框），拿不到就退回 rect
        frame: extendedFrame(f, hwnd) ?? rect,
        minimized: f.IsIconic(hwnd),
        maximized: f.IsZoomed(hwnd),
      });
    } catch {
      /* 单个窗口读失败不影响整体 */
    }
    return true;
  }, koffi.pointer(PROC));
  try {
    f.EnumWindows(cb, 0);
  } finally {
    koffi.unregister(cb);
  }
  return out;
}

/** 按标题子串找窗口（不区分大小写），返回全部匹配 */
export function findWindows(substr) {
  const q = String(substr ?? '').toLowerCase();
  const all = listWindows();
  if (!q) return all;
  return all.filter((w) => w.title.toLowerCase().includes(q));
}

/**
 * 把窗口带到前台。
 *
 * 光调 SetForegroundWindow 会被 Windows 拒绝（前台锁定：只有当前拥有前台的进程才能抢），
 * 所以用 AttachThreadInput 把自己的线程挂到目标窗口线程上，抢完再摘掉。
 * 这是业界通用做法。
 */
export function activateWindow(hwnd) {
  const f = funcs();
  const h = BigInt(hwnd);
  if (f.IsIconic(h)) f.ShowWindow(h, 9); // SW_RESTORE
  const targetThread = f.GetWindowThreadProcessId2(h, null);
  const myThread = f.GetCurrentThreadId();
  let attached = false;
  try {
    if (targetThread && targetThread !== myThread) {
      attached = f.AttachThreadInput(myThread, targetThread, true);
    }
    f.BringWindowToTop(h);
    f.SetForegroundWindow(h);
    f.SetActiveWindow(h);
    f.SetFocus(h);
  } finally {
    if (attached) f.AttachThreadInput(myThread, targetThread, false);
  }
  return { hwnd: String(hwnd), foreground: String(f.GetForegroundWindow()) };
}

export function foregroundWindow() {
  const f = funcs();
  const h = f.GetForegroundWindow();
  const tbuf = Buffer.alloc(1024);
  const tn = f.GetWindowTextW(h, tbuf, 512);
  return { hwnd: String(h), title: wstr(tbuf, tn) };
}

export function showWindow(hwnd, cmd) {
  const f = funcs();
  f.ShowWindow(BigInt(hwnd), cmd);
  return { hwnd: String(hwnd), cmd };
}

export function moveWindow(hwnd, x, y, w, h) {
  const f = funcs();
  const ok = f.MoveWindow(BigInt(hwnd), x, y, w, h, true);
  return { hwnd: String(hwnd), ok };
}

// ---------------------------------------------------------------------------
// 输入合成
// ---------------------------------------------------------------------------

const MOUSEEVENTF = {
  MOVE: 0x0001,
  LEFTDOWN: 0x0002,
  LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008,
  RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020,
  MIDDLEUP: 0x0040,
  WHEEL: 0x0800,
  HWHEEL: 0x1000,
};

const KEYEVENTF = { KEYUP: 0x0002, EXTENDEDKEY: 0x0001 };

export function mouseMove(x, y) {
  const f = funcs();
  f.SetCursorPos(x, y);
  return cursorPos();
}

export function mouseClick(x, y, button = 'left', double = false) {
  const f = funcs();
  if (typeof x === 'number' && typeof y === 'number') f.SetCursorPos(x, y);
  const down =
    button === 'right' ? MOUSEEVENTF.RIGHTDOWN : button === 'middle' ? MOUSEEVENTF.MIDDLEDOWN : MOUSEEVENTF.LEFTDOWN;
  const up =
    button === 'right' ? MOUSEEVENTF.RIGHTUP : button === 'middle' ? MOUSEEVENTF.MIDDLEUP : MOUSEEVENTF.LEFTUP;
  const times = double ? 2 : 1;
  for (let i = 0; i < times; i++) {
    f.mouse_event(down, 0, 0, 0, 0);
    f.mouse_event(up, 0, 0, 0, 0);
  }
  return { at: cursorPos(), button, double };
}

export function mouseWheel(delta) {
  const f = funcs();
  f.mouse_event(MOUSEEVENTF.WHEEL, 0, 0, delta | 0, 0);
  return { delta };
}

export function keyPress(vk, extended = false) {
  const f = funcs();
  const flags = extended ? KEYEVENTF.EXTENDEDKEY : 0;
  f.keybd_event(vk, f.MapVirtualKeyW(vk, 0), flags, 0);
  f.keybd_event(vk, f.MapVirtualKeyW(vk, 0), flags | KEYEVENTF.KEYUP, 0);
  return { vk };
}

export function keyDown(vk, extended = false) {
  const f = funcs();
  f.keybd_event(vk, f.MapVirtualKeyW(vk, 0), extended ? KEYEVENTF.EXTENDEDKEY : 0, 0);
  return { vk };
}

export function keyUp(vk, extended = false) {
  const f = funcs();
  const flags = (extended ? KEYEVENTF.EXTENDEDKEY : 0) | KEYEVENTF.KEYUP;
  f.keybd_event(vk, f.MapVirtualKeyW(vk, 0), flags, 0);
  return { vk };
}

// ---------------------------------------------------------------------------
// 截屏
// ---------------------------------------------------------------------------

/**
 * 抓屏（全屏或指定窗口），返回 PNG 字节。
 *
 * 用 GDI BitBlt + GetDIBits 拿 BGRA 位图，再交给 Electron 的 nativeImage 编 PNG ——
 * 这样不用引任何图像库（pngjs/sharp 都不需要）。
 *
 * 输出是 PNG 字节（自己编，不依赖 Electron 的 nativeImage —— 插件跑在 dsh 子进程里，
 * 那里拿不到 Electron API，详见 png.js 的说明）。
 *
 * @param opts.hwnd 指定窗口（省略 = 全屏）
 */
export function capture(opts = {}) {
  const f = funcs();

  let x = 0;
  let y = 0;
  let w;
  let h;
  let srcDC;
  let releaseSrc;

  if (opts.hwnd) {
    const hwnd = BigInt(opts.hwnd);
    // 优先用 DWM 的真实可见边界（不含投影），拿不到再退回 GetWindowRect
    const r = extendedFrame(f, hwnd) ?? (() => {
      const rbuf = Buffer.alloc(16);
      if (!f.GetWindowRect(hwnd, rbuf)) throw new Error(`读不到窗口矩形：${opts.hwnd}`);
      return readRect(rbuf);
    })();
    x = r.left;
    y = r.top;
    w = r.right - r.left;
    h = r.bottom - r.top;
  } else {
    const s = screenSize();
    x = 0;
    y = 0;
    w = s.width;
    h = s.height;
  }

  // ⚠️ **一律从屏幕 DC 抓**，绝不用 GetWindowDC ——
  //    现代窗口（Chromium/Electron/WPF/UWP）都是 GPU 合成直接上屏的，窗口自身的 DC 里
  //    什么都没有：实测对同一个窗口 GetWindowDC 抓到的是 **100% 纯黑**（0/2028928 个非黑像素），
  //    而屏幕 DC 同一区域 99.2% 有内容。这就是「截指定窗口返回全黑图」的根因。
  //    代价：窗口被别的窗口遮住时会连遮挡物一起截进来。这是 GDI 的固有限制
  //    （要避开得用 Windows.Graphics.Capture 或 PrintWindow(PW_RENDERFULLCONTENT)）。
  srcDC = f.GetDC(0);
  releaseSrc = () => f.ReleaseDC(0, srcDC);

  if (w <= 0 || h <= 0) {
    releaseSrc();
    throw new Error(`无效的截取区域：${w}x${h}`);
  }

  const memDC = f.CreateCompatibleDC(srcDC);
  const bmp = f.CreateCompatibleBitmap(srcDC, w, h);
  const old = f.SelectObject(memDC, bmp);
  try {
    // SRCCOPY | CAPTUREBLT（CAPTUREBLT 让分层窗口也进画面，否则截图缺内容）
    // 源坐标用 (x, y)：屏幕 DC 的原点是屏幕左上角，而我们要的是窗口那一块。
    const ok = f.BitBlt(memDC, 0, 0, w, h, srcDC, x, y, 0x00cc0020 | 0x40000000);
    if (!ok) throw new Error('BitBlt 失败');

    // BITMAPINFOHEADER（40 字节）+ 颜色表，负高度 = 自上而下
    const bi = Buffer.alloc(40 + 4);
    bi.writeUInt32LE(40, 0);
    bi.writeInt32LE(w, 4);
    bi.writeInt32LE(-h, 8);
    bi.writeUInt16LE(1, 12);
    bi.writeUInt16LE(32, 14);
    bi.writeUInt32LE(0, 16);
    bi.writeUInt32LE(w * h * 4, 20);

    const pixels = Buffer.alloc(w * h * 4);
    const lines = f.GetDIBits(memDC, bmp, 0, h, pixels, bi, 0);
    if (lines === 0) throw new Error('GetDIBits 失败');

    // GDI 给的是 BGRA 且 alpha 恒为 0 → 转成 RGBA 并补不透明
    bgraToRgba(pixels);
    return { png: encodePng(pixels, w, h), width: w, height: h, origin: { x, y } };
  } finally {
    f.SelectObject(memDC, old);
    f.DeleteObject(bmp);
    f.DeleteDC(memDC);
    releaseSrc();
  }
}
