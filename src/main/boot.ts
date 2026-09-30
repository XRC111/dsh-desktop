// ---------------------------------------------------------------------------
// 0) 最早的防御性处理（必须先于任何 electron API 使用）
// ---------------------------------------------------------------------------

// ELECTRON_RUN_AS_NODE 是在「进程启动那一刻」由 Electron 二进制读取的：
// 若外部环境已设置它，本进程会以纯 Node 模式运行，require('electron') 只返回
// 二进制路径，app / BrowserWindow 全部不可用。此处删除无法逆转已发生的启动模式，
// 它的作用是不让该变量继续向下传递（例如污染我们 spawn 出的子进程树）。
//
// 真正需要注意的是启动方式：请勿在设置该变量的终端里直接启动本应用
// （见 README「常见问题 · 启动即退出」）。启动 dsh 子进程时，dsh-service
// 会显式设置 ELECTRON_RUN_AS_NODE=1，与这里互不影响。
delete process.env.ELECTRON_RUN_AS_NODE;

import { app, ipcMain, shell, clipboard, dialog, session } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  desktopPatchFile,
  devRuntimeDir,
  dshHomeDir,
  dshLogFile,
  ensureAppDirs,
  logsDir,
  mainLogFile,
  packagedRuntimeDir,
  rendererDir,
  runtimeManifestFile,
  runtimeRoot,
  runtimeTarFile,
  userDataDir,
} from './paths';
import { initSessionLogger, log } from './logger';
import { verifyRuntime } from './dsh-locator';
import { DshService, DshStatus, healStaleLocks } from './dsh-service';
import {
  ensureRuntime,
  findAllMissing,
  loadManifest,
  repairMissing,
  sampleMissing,
} from './runtime-installer';
import { pickPort } from './port';
import { installPlugins } from './plugin-installer';
import { guardPatch } from './patch-guard';
import { ensurePluginCompatibility } from './plugin-compat';
import { SHELL_FEATURES, ShellFeatures } from './shell-features';
import { WindowManager, redactToken } from './window-manager';
import { TrayManager } from './tray-manager';
import { Updater, UpdateState } from './updater';
import { activeHotShell, rollbackHotShell, shellVersion } from './hot-shell';
import { appliedPatch, applyPendingRuntimePatch, findRuntimeDir, runtimeVersionOf } from './runtime-patch';
import { injectAttachmentPicker, registerAttachmentPickerHandlers } from './attachment-picker';
import { ensureHiddenConsole, ensureWin32ProcessNoWindowPatch } from './win-console';

/** dsh web 的首选端口，被占用时自动回退到系统分配端口 */
const PREFERRED_PORT = 3080;

// ---------------------------------------------------------------------------
// 1) 进程级设置（必须在 ready 之前完成）
// ---------------------------------------------------------------------------

// 用户数据统一放 %APPDATA%\DSH-Desktop（安装目录之外，卸载时可保留）
app.setPath('userData', userDataDir());

// 单实例锁：第二次启动聚焦已有窗口，而不是再起一套 dsh
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    log('检测到第二次启动，聚焦已有窗口');
    windowManager?.show();
  });
}

// 裁剪非必要的 Chromium 特性，降低常驻资源占用
app.commandLine.appendSwitch(
  'disable-features',
  [
    'MediaSessionService',
    'HardwareMediaKeyHandling',
    'AutofillServerCommunication',
    'OptimizationHints',
    'Translate',
    'BackgroundFetch',
    'InterestCohortAPI',
    'SpeculationRulesPrefetchProxy',
  ].join(','),
);
app.commandLine.appendSwitch('disable-spell-checking');
app.commandLine.appendSwitch('no-first-run');
app.commandLine.appendSwitch('disable-component-update');

// ---------------------------------------------------------------------------
// 2) 运行时状态
// ---------------------------------------------------------------------------

const service = new DshService();
let windowManager: WindowManager | null = null;
let trayManager: TrayManager | null = null;
/** 外壳功能开关（用户数据目录持久化；见 shell-features.ts） */
let shellFeatures: ShellFeatures | null = null;
let updater: Updater | null = null;
let quitting = false;
let lastStatus: DshStatus = { state: 'idle' };

function broadcast(status: DshStatus): void {
  lastStatus = status;
  trayManager?.updateStatus(status);
  // 内容（加载页/Harness UI）在 contentView 里，IPC 推送要打到它
  const view = windowManager?.content;
  if (view && !view.webContents.isDestroyed()) view.webContents.send('dsh:status', status);
}

/**
 * 更新状态同步到托盘与界面：
 * 托盘菜单文字直接显示阶段/进度，下载期间顺带用任务栏进度条给出可见反馈。
 */
function applyUpdateState(state: UpdateState): void {
  trayManager?.updateUpdateState(state);
  const win = windowManager?.window;
  if (!win || win.isDestroyed()) return;
  const view = windowManager?.content;
  if (view && !view.webContents.isDestroyed()) view.webContents.send('dsh:update', state);
  if (state.phase === 'downloading' && typeof state.percent === 'number') {
    win.setProgressBar(Math.max(0, Math.min(1, state.percent / 100)));
  } else {
    win.setProgressBar(-1);
  }
}

function focusWindow(): void {
  if (!windowManager?.window || windowManager.window.isDestroyed()) windowManager?.create();
  windowManager?.show();
}

/**
 * 运行时完整性自检与自动修复。
 *
 * NSIS 解压 3.5 万个小文件时，在部分机器上（杀软实时扫描 / 慢盘）会静默丢文件，
 * 表现为 dsh 启动报 "Cannot find module './xxx'"。这里用构建期生成的清单做抽样自检，
 * 发现缺失就从安装包内附带的 tar 补齐（用户无需重装）。
 */
async function selfHealRuntime(runtimeDir: string): Promise<void> {
  if (!app.isPackaged) return; // 开发态不做校验

  // 装过热更新补丁的运行时不能拿安装包的旧清单去"修" ——
  // 那份清单描述的是安装包内置版本，补丁删掉的文件会被它当成缺失又塞回来。
  const patched = appliedPatch(runtimeDir);
  if (patched) {
    log(`运行时已套用热更新补丁（${patched.version}），跳过节完整性自检`);
    return;
  }

  const manifest = loadManifest(runtimeManifestFile());
  if (!manifest) {
    log('未找到运行时清单，跳过完整性自检');
    return;
  }

  // 清单里的路径以 resources 目录为基准
  const destBase = path.dirname(runtimeDir);
  const sampled = sampleMissing(destBase, manifest, 300);
  if (sampled.length === 0) return;

  log(`完整性自检：抽样发现缺失 ${sampled.length} 个文件，开始全量检查`);
  broadcast({
    state: 'starting',
    message: '检测到运行时文件缺失，正在自动修复…',
  });

  const missing = findAllMissing(destBase, manifest);
  const tarFile = runtimeTarFile();
  if (!fs.existsSync(tarFile)) {
    broadcast({
      state: 'failed',
      message: 'Harness 运行时不完整，且安装包内缺少修复数据。',
      problems: [`缺失 ${missing.length} 个文件，且未找到 ${tarFile}`],
      hints: ['请重新运行安装包修复或重新安装本应用。'],
    });
    return;
  }

  try {
    const fixed = await repairMissing(tarFile, destBase, missing, (message) =>
      broadcast({ state: 'starting', message }),
    );
    const still = sampleMissing(destBase, manifest, 300);
    if (still.length > 0) {
      broadcast({
        state: 'failed',
        message: '自动修复后运行时仍不完整。',
        problems: [`已补齐 ${fixed} 个文件，仍有缺失`],
        hints: ['请重新运行安装包修复，或卸载后重新安装本应用。'],
      });
    }
  } catch (err) {
    log(`自动修复失败：${String(err)}`);
    broadcast({
      state: 'failed',
      message: '自动修复运行时失败。',
      problems: [String((err as Error)?.message ?? err)],
      hints: [
        '请确认系统为 Windows 10 1803 或更高版本（修复依赖系统自带 tar）。',
        '也可以重新运行安装包进行修复安装。',
      ],
    });
  }
}

async function startService(): Promise<void> {
  // Windows：先准备好隐藏控制台，让 dsh 继承它，
  // 这样 Harness 沙箱起的 shell 不会每次都弹一个可见窗口（详见 win-console.ts）
  ensureHiddenConsole();

  // 运行时落位：打包态首选安装目录，缺失则从 tar 解压到用户数据目录
  let runtimeDir: string;
  try {
    const resolution = await ensureRuntime({
      packagedDir: packagedRuntimeDir(),
      tarFile: runtimeTarFile(),
      targetRoot: runtimeRoot(),
      devDir: devRuntimeDir(),
      versionTag: `${app.getVersion()}-${process.arch}`,
      onProgress: (message) => broadcast({ state: 'starting', message }),
    });
    runtimeDir = resolution.dir;
    const rtVer = runtimeVersionOf(runtimeDir);
    if (rtVer) log(`Harness 运行时版本：dsh ${rtVer}`);
  } catch (err) {
    broadcast({
      state: 'failed',
      message: 'Harness 运行时准备失败。',
      problems: [String((err as Error)?.message ?? err)],
      hints: [
        '请确认系统为 Windows 10 1803 或更高版本（需要系统自带 tar）。',
        '若磁盘空间不足，请清理后点击「重试」。',
      ],
    });
    log(`运行时准备失败：${String(err)}`);
    return;
  }

  // ── 运行时热更新：在 dsh 启动前套用已下载好的差分补丁 ─────────────────────
  // 补丁的解压在下载阶段就完成了，这里只做「覆盖文件 + 删除清单」，实测 1~2 秒。
  // 失败不阻断启动：运行时的完整性修复会在下次启动兜底。
  const patchResult = applyPendingRuntimePatch(runtimeDir);
  if (patchResult) {
    log(`运行时补丁：${patchResult.message}`);
    if (patchResult.ok) {
      log(`  覆盖 ${patchResult.copied} 个文件、删除 ${patchResult.deleted} 个`);
    }
  }

  // 自检 + 自动修复（NSIS 解压丢文件时的补救）
  await selfHealRuntime(runtimeDir);

  // Windows 弹窗修复：确保 dsh-win32-process 的普通令牌路径带 CREATE_NO_WINDOW
  // （运行时热更新/自愈可能覆盖补丁，这里幂等重打；详见 win-console.ts）
  ensureWin32ProcessNoWindowPatch(runtimeDir);

  const verify = verifyRuntime(runtimeDir);
  if (!verify.ok || !verify.install) {
    broadcast({
      state: 'failed',
      message: 'DeepSeek Harness 运行时校验未通过。',
      problems: verify.problems,
      hints: verify.hints,
    });
    log(`运行时校验失败：${verify.problems.join(' | ')}`);
    return;
  }

  const install = verify.install;

  // 桌面适配插件：必须放在 dsh 能解析到的 profile 共享 node_modules 里，
  // 且必须在 dsh 起来之前完成（加载器是启动时一次性解析插件包名的）。
  installPlugins();

  // 自愈：dsh 若上次是被强杀（taskkill /F），会留下 profiles/*.lock，
  // 导致本次启动卡在「timed out waiting for the writer lock」。启动前先清理失效锁。
  const cleanedLocks = healStaleLocks(dshHomeDir());
  if (cleanedLocks > 0) log(`启动前清理了 ${cleanedLocks} 个失效锁文件`);

  const { port, fallback } = await pickPort(PREFERRED_PORT);
  if (fallback) log(`首选端口 ${PREFERRED_PORT} 被占用，改用系统分配端口`);

  // 补丁防护（必须在 installPlugins() 之后，才能看到刚落位的插件）：
  // 补丁里 insert 的插件只要有一个解析不到，dsh 会整体起不来
  // （plugin tree failed to load，实测 exit=1）→ 剔除未就绪的行再交给 dsh。
  // 解析根：profile 共享 node_modules（外壳落位插件的地方）+ 运行时自带 node_modules。
  const patchGuard = guardPatch(desktopPatchFile(), path.join(userDataDir(), 'desktop-patch.effective.yml'), [
    path.join(dshHomeDir(), 'profiles', 'node_modules'),
    path.join(install.runtimeDir, 'node_modules'),
  ]);

  // 插件兼容层：dsh 0.2.0 起按 manifest 的 peerDependencies 强制校验，声明写死在
  // 旧区间的插件会被**静默禁用**（如 dshmarket 的 dsh-settings: ^0.1.x 不含 0.2.x）。
  // 对「声明过时但依赖包仍在运行时」的插件写官方豁免（profiles/web/compatibility.json），
  // 依赖包真的不在的则拒绝放行。详见 plugin-compat.ts。
  const compat = ensurePluginCompatibility({
    profileDir: path.join(dshHomeDir(), 'profiles', 'web'),
    pluginDirs: pluginDirsInProfile(),
    runtimeVersion: install.version,
    searchRoots: [
      path.join(dshHomeDir(), 'profiles', 'node_modules'),
      path.join(install.runtimeDir, 'node_modules'),
    ],
  });
  if (compat.allowed.length > 0) {
    log(`插件兼容层：放行 ${compat.allowed.length} 个声明过时的插件（${compat.allowed.join('、')}）`);
  }
  for (const r of compat.refused) log(`插件兼容层：拒绝 ${r.key} —— ${r.reason}`);

  const status = await service.start({
    install,
    preferredPort: PREFERRED_PORT,
    listenPort: port,
    portFallback: fallback,
    dshHome: dshHomeDir(),
    patchFile: patchGuard.file,
    version: install.version,
    // 首次启动 dsh 会在 DSH_HOME/profiles 下建立 profile 依赖（数百个符号链接/文件）。
    // 在启用实时防护的机械盘或企业管控机器上，这一步实测可能持续数分钟，
    // 因此超时上限放宽到 10 分钟；加载页会持续显示已等待时间。
    readyTimeoutMs: 600000,
  });

  if (status.state === 'ready' && status.url) {
    windowManager?.loadDshUi(status.url);
  }
}

async function restartService(): Promise<void> {
  log('用户触发重启 Harness 服务');
  await service.stop();
  windowManager?.loadLoadingPage();
  await startService();
}

/**
 * 重启整个应用（热更新生效走这里：代码放在用户数据目录，重启即切换）。
 * 与「完全退出」一样先回收 dsh 进程树，再用 app.relaunch 拉起新进程。
 */
async function restartApp(reason: string): Promise<void> {
  log(`重启应用：${reason}`);
  windowManager?.setQuitting(true);
  windowManager?.persistState();
  try {
    await service.stop();
  } catch (err) {
    log(`重启前停止服务出错：${String(err)}`);
  }
  service.killTreeSync();
  trayManager?.destroy();
  app.relaunch();
  app.exit(0);
}

/** 完全退出：先回收 dsh 进程树，再退出应用 */
async function quitApp(): Promise<void> {
  if (quitting) return;
  quitting = true;
  windowManager?.setQuitting(true);
  windowManager?.persistState();
  log('开始完全退出，正在停止 dsh 服务…');
  try {
    await service.stop();
  } catch (err) {
    log(`停止服务时出错：${String(err)}`);
  }
  service.killTreeSync(); // 兜底：确保没有残留进程树
  trayManager?.destroy();
  updater?.dispose();
  log('退出完成');
  app.exit(0);
}

function buildDiagnostics(): string {
  const lines = [
    'DSH Desktop 诊断信息',
    `时间: ${new Date().toISOString()}`,
    `应用版本: ${app.getVersion()}`,
    `生效壳版本: ${shellVersion()}${activeHotShell() ? '（热更新）' : '（内置）'}`,
    `Electron: ${process.versions.electron}`,
    `内置 Node: ${process.versions.node}`,
    `Chromium: ${process.versions.chrome}`,
    `平台: ${process.platform} ${process.arch}`,
    `打包态: ${app.isPackaged}`,
    `运行时目录: ${runtimeRoot()}`,
    `dsh 版本: ${lastStatus.version ?? '未知'}`,
    `服务状态: ${lastStatus.state}`,
    lastStatus.url ? `服务地址: ${redactToken(lastStatus.url)}` : '',
    lastStatus.message ? `最近消息: ${lastStatus.message}` : '',
    updater ? `更新状态: ${updater.getState().phase}${updater.getState().message ? `（${updater.getState().message}）` : ''}` : '',
    updater?.getState().feedUrl ? `更新源: ${updater.getState().feedUrl}` : '',
    `日志目录: ${logsDir()}`,
    `主日志: ${mainLogFile()}`,
    `dsh 日志: ${dshLogFile()}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 与系统能力对接：把浏览器语义的操作翻译成 Windows 原生交互。
 * 原则是「贴近系统默认行为」，不改变 Harness 界面本身。
 */
function setupSystemIntegration(): void {
  const ses = session.defaultSession;

  // 1) 文件下载走系统「另存为」对话框，而不是静默落到浏览器下载目录。
  //    Harness 的 /export 会话导出、附件下载都会经过这里。
  ses.on('will-download', (_event, item) => {
    const suggested = item.getFilename();
    void dialog
      .showSaveDialog({
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), suggested),
        buttonLabel: '保存',
      })
      .then(({ canceled, filePath }) => {
        if (canceled || !filePath) {
          item.cancel();
          log(`用户取消了下载：${suggested}`);
          return;
        }
        item.setSavePath(filePath);
        log(`下载保存到：${filePath}`);
      })
      .catch(() => item.cancel());
  });

  // 2) 收窄权限：桌面外壳只需要通知与剪贴板写，其余（摄像头、麦克风、
  //    地理位置、HID、串口等）一律拒绝，避免网页侧无意中拿到系统能力。
  const allowed = new Set([
    'notifications',
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
  ]);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = allowed.has(permission);
    if (!ok) log(`已拒绝网页权限请求：${permission}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // 3) 打开完成 / 下载完成时，用系统任务栏进度条给出可见反馈（短暂显示）
  //    这里只在下载期间显示进度，符合 Windows 上用户对下载的预期。
  ses.on('will-download', (_event, item) => {
    const win = windowManager?.window;
    if (!win || win.isDestroyed()) return;
    item.on('updated', (_e, state) => {
      if (state === 'progressing' && item.getTotalBytes() > 0) {
        win.setProgressBar(item.getReceivedBytes() / item.getTotalBytes());
      } else {
        win.setProgressBar(-1);
      }
    });
    item.once('done', () => win.setProgressBar(-1));
  });
}

/**
 * 开关变化后重新应用。
 * 能立刻生效的就立刻生效；需要重建视图的交给 WindowManager（顶条）。
 * 外链/拖放/托盘这些是「读开关时现查」，无需额外动作。
 */
function applyFeatureChange(id: string, enabled: boolean): void {
  log(`应用功能开关：${id} = ${enabled}`);
  if (id === 'showTitleBar' || id === 'framelessFit') {
    // 顶条的显示/隐藏与右上角安全边距都由 WindowManager 重算
    windowManager?.setTitleBarEnabled(shellFeatures?.isEnabled('showTitleBar') ?? true);
    return;
  }
  if (id === 'trayStatus' && !enabled) {
    // 关掉托盘状态：立刻清运行态，免得托盘停在「正在运行」
    trayManager?.setTaskRunning(false);
    return;
  }
  if (id === 'dragDropAttach') {
    // 脚本自带撤装（见 __dshDesktopDragDropTeardown）：立刻重注入一次即可生效，不必重启
    const view = windowManager?.content;
    if (view && !view.webContents.isDestroyed()) {
      injectClientScript(view, 'drag-drop-attach.client.js', '拖放附件');
      try {
        const code = fs.readFileSync(path.join(rendererDir(), 'drag-drop-attach.client.js'), 'utf8');
        void view.webContents.executeJavaScript(code, false).catch(() => {});
      } catch {
        /* 读不到就算了：下次 dom-ready 仍会注入 */
      }
    }
  }
}

/**
 * 列出 profile 共享 node_modules 里已落位的插件目录（含 @scope/ 下一层）。
 * 兼容层要逐个读它们的 package.json 判定 peer 声明。
 */
function pluginDirsInProfile(): string[] {
  const root = path.join(dshHomeDir(), 'profiles', 'node_modules');
  const dirs: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (entry.name.startsWith('@')) {
        try {
          for (const sub of fs.readdirSync(full, { withFileTypes: true })) {
            if (sub.isDirectory()) dirs.push(path.join(full, sub.name));
          }
        } catch {
          /* 读不到跳过 */
        }
      } else {
        dirs.push(full);
      }
    }
  } catch {
    /* 首次启动没有该目录 → 空列表 */
  }
  return dirs;
}

function registerIpc(): void {
  ipcMain.handle('app:get-status', () => lastStatus);
  ipcMain.handle('app:retry', async () => {
    await restartService();
    return lastStatus;
  });
  ipcMain.handle('app:open-logs', async () => {
    await shell.openPath(logsDir());
  });
  ipcMain.handle('app:open-data-dir', async () => {
    await shell.openPath(userDataDir());
  });
  ipcMain.handle('app:quit', async () => {
    await quitApp();
  });
  ipcMain.handle('app:copy-diagnostics', () => {
    clipboard.writeText(buildDiagnostics());
    return true;
  });
  // ── 功能开关（设置页「桌面」面板）─────────────────────────────────────────
  ipcMain.handle('app:get-features', () => shellFeatures?.snapshot() ?? { values: {}, defs: [] });
  ipcMain.handle('app:set-feature', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { id?: unknown; enabled?: unknown };
    if (typeof p.id !== 'string' || typeof p.enabled !== 'boolean') {
      return shellFeatures?.snapshot() ?? { values: {}, defs: [] };
    }
    const changed = shellFeatures?.set(p.id, p.enabled) ?? false;
    if (changed) applyFeatureChange(p.id, p.enabled);
    return shellFeatures?.snapshot() ?? { values: {}, defs: [] };
  });
  // 同步查询：注入脚本在启动时用它决定要不要装监听（异步会有竞态）
  ipcMain.on('app:feature-enabled', (event, id: unknown) => {
    event.returnValue =
      typeof id === 'string' ? (shellFeatures?.isEnabled(id) ?? true) : false;
  });
  // 页面上报任务运行状态（托盘 + 任务完成通知）
  ipcMain.on('app:task-state', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { running?: unknown; unloading?: unknown };
    const running = p.running === true;
    const unloading = p.unloading === true;
    if (unloading) {
      // 页面要走了：立刻清掉运行态，别让托盘卡在「正在运行」
      trayManager?.setTaskRunning(false);
      return;
    }
    if (shellFeatures && !shellFeatures.isEnabled('trayStatus')) {
      trayManager?.setTaskRunning(false);
      return;
    }
    const flipped = trayManager?.setTaskRunning(running) ?? false;
    // 任务跑完 → 窗口不在前台时通知（前台时不打扰）
    if (flipped && !running && shellFeatures?.isEnabled('taskNotify')) {
      if (!windowManager?.isVisible()) {
        trayManager?.notify('任务已完成', 'DSH Desktop：Harness 任务已跑完，点击托盘图标回到窗口。');
      }
    }
  });

  // ── 更新 ──────────────────────────────────────────────────────────────────
  ipcMain.handle('app:get-update-state', () => updater?.getState() ?? null);
  /**
   * 版本信息（页面内小部件用）：外壳版本 + Harness 运行时版本 + 更新源。
   * 运行时版本按候选顺序找实际在用的那个目录（见 Updater.currentRuntimeDir）。
   */
  ipcMain.handle('app:get-versions', () => {
    const state = (updater?.getState() ?? {}) as Record<string, unknown>;
    return {
      app: app.getVersion(),
      shell: (state.currentVersion as string) || app.getVersion(),
      dsh: runtimeVersionOf(findRuntimeDir()) ?? null,
      feedUrl: updater?.getState().feedUrl ?? null,
      hotReady: !!state.hotReady,
      hotVersion: (state.hotVersion as string) ?? null,
      runtimeReady: !!state.runtimeReady,
      runtimeTarget: (state.runtimeTarget as string) ?? null,
      runtimeVersion: (state.runtimeVersion as string) ?? null,
      // 分通道：当前通道与它看到的云端版本（更新页插件用）
      channel: updater?.getChannel() ?? 'stable',
      latestVersion: (state.latestVersion as string) ?? null,
    };
  });
  ipcMain.handle('app:check-update', async () => {
    const state = await updater?.check({ interactive: true });
    return state ?? null;
  });
  /**
   * 安装更新：默认 auto（能热更就热更，否则完整安装包）；
   * 可显式指定 'hot' | 'runtime' | 'installer'（更新横幅的备选按钮用）。
   */
  ipcMain.handle('app:install-update', async (_e, opts?: { mode?: unknown }) => {
    const raw = opts?.mode;
    const mode =
      raw === 'hot' || raw === 'runtime' || raw === 'installer' ? raw : undefined;
    await updater?.applyUpdate({ interactive: true, mode });
    return updater?.getState() ?? null;
  });
  /** 强制走热更新通道 */
  ipcMain.handle('app:apply-hot-update', async () => {
    await updater?.applyUpdate({ interactive: true, mode: 'hot' });
    return updater?.getState() ?? null;
  });
  /** 手动重启（也会应用已落位的热更新） */
  ipcMain.handle('app:restart', async () => {
    await restartApp('渲染层请求重启');
    return true;
  });
  /** 当前更新通道（stable / beta / dev）与它实际请求的 feed 地址 */
  ipcMain.handle('app:get-channel', () => ({
    channel: updater?.getChannel() ?? 'stable',
    feedUrl: updater?.getState().feedUrl ?? null,
  }));
  /** 切换更新通道：写回 update-config.json 并立即按新通道检查一次 */
  ipcMain.handle('app:set-channel', async (_e, channel: unknown) => {
    if (!updater) return null;
    const ok = channel === 'stable' || channel === 'beta' || channel === 'dev';
    if (!ok) throw new Error(`未知更新通道：${String(channel)}`);
    return updater.setChannel(channel);
  });
}

/**
 * 把 out/renderer 下的注入脚本送进页面主世界（dom-ready 时注入，脚本自身幂等）。
 * 与 injectAttachmentPicker 同一范式：BaseWindow 架构下内容在 WebContentsView 里，
 * 接收方只需暴露 webContents。更新横幅等无复杂 IPC 的注入都用这条通路。
 */
function injectClientScript(
  view: { webContents: Electron.WebContents } | null,
  file: string,
  label: string,
): void {
  if (!view) return;
  const wc = view.webContents;
  const full = path.join(rendererDir(), file);
  let code: string;
  try {
    code = fs.readFileSync(full, 'utf8');
  } catch (err) {
    log(`${label}脚本缺失（${full}）：${String(err)}`);
    return;
  }
  wc.on('dom-ready', () => {
    wc.executeJavaScript(code, false).catch((err) => log(`注入${label}脚本失败：${String(err)}`));
  });
}

// ---------------------------------------------------------------------------
// 3) 生命周期
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  ensureAppDirs();
  initSessionLogger(mainLogFile());
  log(`DSH Desktop ${app.getVersion()} 启动`);
  const hotShell = activeHotShell();
  log(
    hotShell
      ? `壳版本：${hotShell.version}（热更新壳，基于安装版 ${hotShell.baseVersion}）`
      : `壳版本：${app.getVersion()}（内置壳）`,
  );
  log(`Electron ${process.versions.electron} / Node ${process.versions.node}`);
  log(`用户数据目录：${userDataDir()}`);
  log(`渲染资源目录：${rendererDir()}`);

  // 功能开关要在建窗口之前读好：顶条/圆角是建窗时就要决定的
  shellFeatures = new ShellFeatures(userDataDir());
  log(
    '功能开关：' +
      SHELL_FEATURES.map((f) => `${f.id}=${shellFeatures?.isEnabled(f.id)}`).join(' '),
  );

  windowManager = new WindowManager(userDataDir(), shellFeatures);
  windowManager.create(); // 立刻出窗口（本地加载页），不阻塞主线程

  registerIpc();
  registerAttachmentPickerHandlers();
  injectAttachmentPicker(windowManager.content);
  injectClientScript(windowManager.content, 'update-banner.client.js', '更新横幅');
  // 拖放附件与任务状态上报：都是页面侧脚本，各自读开关决定要不要生效
  injectClientScript(windowManager.content, 'drag-drop-attach.client.js', '拖放附件');
  injectClientScript(windowManager.content, 'task-reporter.client.js', '任务状态上报');
  setupSystemIntegration();

  trayManager = new TrayManager({
    onToggleWindow: () => windowManager?.toggle(),
    onRestart: () => void restartService(),
    onRestartApp: () => void restartApp('用户手动重启'),
    onRollbackHot: () => {
      rollbackHotShell('用户手动回退');
      void restartApp('回退热更新壳');
    },
    onUpdateAction: () => {
      const s = updater?.getState();
      if (s?.restartAt) {
        // 正在倒计时 → 点一下就是「取消」
        updater?.cancelScheduledRestart();
      } else if (s?.hotReady || s?.runtimeReady) {
        void updater?.restartNow('用户从托盘应用更新');
      } else {
        void updater?.check({ interactive: true });
      }
    },
    onOpenLogs: () => void shell.openPath(logsDir()),
    onOpenDataDir: () => void shell.openPath(userDataDir()),
    onQuit: () => void quitApp(),
  });
  trayManager.create();
  trayManager.setHotShell(hotShell?.version ?? null);

  // ── 更新 ──────────────────────────────────────────────────────────────────
  // 优先热更新（下载新壳 → 重启即生效），必要时降级到完整安装包。
  // 更新源在 resources/update-config.json 里配置（也可用 DSH_DESKTOP_UPDATE_URL 覆盖）。
  updater = new Updater({
    onState: (state) => applyUpdateState(state),
    onBeforeInstall: async () => {
      // 先释放文件占用：安装程序要覆盖的就是本进程的 exe
      windowManager?.setQuitting(true);
      windowManager?.persistState();
      try {
        await service.stop();
      } catch (err) {
        log(`安装更新前停止服务出错：${String(err)}`);
      }
      service.killTreeSync();
      trayManager?.destroy();
    },
    onExit: () => app.exit(0),
    onRestart: () => {
      app.relaunch();
      app.exit(0);
    },
    notify: (title, body) => trayManager?.notify(title, body),
  });
  updater.init();

  service.on('status', (status: DshStatus) => broadcast(status));

  // 预热启动：先显示窗口，再异步拉起 dsh
  void startService();
});

app.on('window-all-closed', () => {
  // 托盘常驻，关窗不退出（完全退出走托盘菜单）
  if (quitting) app.quit();
});

app.on('activate', () => focusWindow());

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  void quitApp();
});

// 最后一道防线：进程真正退出前同步回收 dsh 进程树
process.on('exit', () => {
  try {
    service.killTreeSync();
  } catch {
    /* ignore */
  }
});

process.on('uncaughtException', (err) => {
  // undici（Node 内置 fetch）在响应收尾阶段有个已知断言竞争：
  // assert(!this.paused) at Parser.finish / onHttpSocketEnd（Node 24 的 undici）。
  // 触发时响应体其实已经完整收到——更新下载的 sha256 校验、落位都正常完成，
  // 只是 socket 清理阶段多收到一次 end 事件。本地/小文件瞬时下载尤其容易踩。
  // 吞掉它：记日志、不弹窗，避免一次成功的更新以「应用遇到错误」收场。
  if (
    (err as NodeJS.ErrnoException)?.code === 'ERR_ASSERTION' &&
    String(err?.stack ?? '').includes('undici')
  ) {
    log(`忽略 undici 收尾断言（响应已完整，无实际影响）：${err?.message}`);
    return;
  }
  // EPIPE：stdout/stderr 的对端（管道、终端）已经走了。这不是应用故障，
  // 重试也没意义——只记一行，绝不弹窗（否则每次写日志都会再弹一次）。
  if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') {
    return;
  }
  log(`未捕获异常：${err?.stack ?? String(err)}`);
  if (!quitting) {
    void dialog
      .showMessageBox({
        type: 'error',
        title: 'DSH Desktop 发生错误',
        message: '应用遇到未处理的错误。',
        detail: `${err?.message ?? err}\n\n日志目录：${logsDir()}`,
        buttons: ['打开日志目录', '忽略'],
      })
      .then((r) => {
        if (r.response === 0) void shell.openPath(logsDir());
      });
  }
});
