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
  profileModulesDir,
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
import { installPlugins, lastPluginInstall } from './plugin-installer';
import { guardPatch } from './patch-guard';
import { ensurePluginCompatibility } from './plugin-compat';
import { ensureScheduleBundle } from './optional-bundles';
import { SHELL_FEATURES, ShellFeatures } from './shell-features';
import { WindowManager, redactToken } from './window-manager';
import { TrayManager } from './tray-manager';
import { Updater, UpdateState } from './updater';
import { activeHotShell, rollbackHotShell, shellVersion } from './hot-shell';
import { appliedPatch, applyPendingRuntimePatch, findRuntimeDir, runtimeVersionOf } from './runtime-patch';
import { injectAttachmentPicker, registerAttachmentPickerHandlers } from './attachment-picker';
import { ensureHiddenConsole, ensureWin32ProcessNoWindowPatch } from './win-console';
import { ensureAclDefaultDaclPatch } from './acl-patch';
import { ComputerUseBall } from './computer-use-ball';
import {
  listMcpServers,
  buildMcpPatchYaml,
  listSkills,
  createSkill,
  deleteSkill,
  saveMcpServers,
  mcpConfigFile,
  userSkillsDir,
} from './skill-mcp';
import { diagnose, FIXES, currentSafeMode, environmentSummary } from './recovery';
import { prepareBundles } from './safe-mode';
import { ensureProfileModuleLinks } from './profile-links';

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
let computerUseBall: ComputerUseBall | null = null;
/** 上次启动失败的原因（恢复页显示用）。进程内变量即可 —— 恢复页是同一次运行里打开的。 */
let lastStartupError: string | null = null;
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

  // Windows 沙箱修复：workspace-write 下受限子进程会在 DLL 初始化阶段
  // 0xC0000142 秒死（令牌默认 DACL 只挂了 restricting 列表里的能力 SID，
  // 缺正常 SID 列表的主体）。启动时幂等重打；详见 acl-patch.ts
  ensureAclDefaultDaclPatch(runtimeDir);

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

  // 安全模式：把 profile 的 bundles 收敛为内置集合（或从安全模式恢复）。
  //
  // 必须在 installPlugins() **之前**：它改的是「dsh 要加载哪些 bundle」，
  // 而插件落位是往 profile 里放包 —— 顺序反了会让安全模式下的本次启动
  // 仍然落位一批第三方插件（虽然不会被加载，但没必要）。
  //
  // 这一步是幂等的：无论上次是正常退出、崩溃还是被强杀，本次启动都会按
  // 当前模式把 bundles 写成该有的样子（而不是依赖「退出时恢复」）。
  const safe = prepareBundles('web');
  if (safe.safe) {
    log('⚠ 安全模式：本次只加载内置模块，已停用 ' + safe.excluded.length + ' 个第三方插件');
  }

  // 桌面适配插件：必须放在 dsh 能解析到的 profile 共享 node_modules 里，
  // 且必须在 dsh 起来之前完成（加载器是启动时一次性解析插件包名的）。
  installPlugins({ appVersion: app.getVersion() });

  // 陈旧链接自检：profile 共享 node_modules 里的包链接是「当时那份运行时」链进去的，
  // 且没有任何版本校验。机器上先后跑过两份运行时（开发态 + 安装版、或换过安装路径）时，
  // 会残留指向旧运行时的链接，而入口用的是新运行时 —— 同一个进程里两套 harness 并存，
  // 同名插件被实例化两次（实测：resume 会话报 tool "read" is already registered）。
  // 这里把目标不在**当前活动运行时**下的链接一律替换（无同名包则删除）；详见 profile-links.ts。
  ensureProfileModuleLinks(profileModulesDir(), runtimeDir);

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
  // computer use 的能力开关存在外壳侧（shell-features.json，用户在设置页改），
  // 但插件跑在 dsh 进程里、读的是自己的 config —— 两者靠**这里注入补丁**打通：
  // guardPatch 会把开关值写进 effective 补丁的 config 段，dsh 加载时自然读到。
  // 好处：改开关只需重启 dsh（不用改 YAML、不用重装插件）。
  // shellFeatures 在 initShell() 里赋值（L737），而 startService() 在其后（L810）才调用，
  // 所以到这里必然已就绪；`!` 只是让 TS 知道这个跨函数的时序事实。
  const sf = shellFeatures!;
  const cuConfig = {
    allowScreenshot: sf.isEnabled('computerUseScreenshot'),
    allowMouse: sf.isEnabled('computerUseMouse'),
    allowKeyboard: sf.isEnabled('computerUseKeyboard'),
    allowWindows: sf.isEnabled('computerUseWindows'),
    allowUnattended: sf.isEnabled('computerUseUnattended'),
  };
  const patchGuard = guardPatch(
    desktopPatchFile(),
    path.join(userDataDir(), 'desktop-patch.effective.yml'),
    [
      path.join(dshHomeDir(), 'profiles', 'node_modules'),
      path.join(install.runtimeDir, 'node_modules'),
    ],
    { 'dsh-desktop-computer-use': cuConfig },
  );

  // 把用户配置的 MCP 服务器追加进「生效补丁」。
  //
  // 为什么不直接写 desktop-patch.yml：那个文件是**仓库产物**，热更新会整份覆盖，
  // 用户配置会被抹掉。所以 MCP 配置存在自己的 mcp-servers.json，这里生成 YAML 追加。
  // 生成而不是让用户手写：args 里常带 Windows 路径（反斜杠+盘符），YAML 转义写错
  // 会让整个补丁解析失败 → dsh 起不来。
  let patchFile = patchGuard.file;
  try {
    const mcpYaml = buildMcpPatchYaml(listMcpServers());
    if (mcpYaml) {
      fs.appendFileSync(patchFile, mcpYaml, 'utf8');
      log('已把 MCP 服务器配置追加进生效补丁：' + patchFile);
    }
  } catch (err) {
    // 追加失败不能阻断启动：最多是 MCP 不生效，比起不来强
    log('追加 MCP 配置失败（不影响启动）：' + String(err));
  }

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

  // 可选 bundle：dsh 0.2.0 把「定时任务」剥成 @deepseek-ai/dsh-experimental-schedule-bundle，
  // 默认不启用（官方为省 token）。我们的用户升级前本来就有这个能力，所以按通道决定：
  // **只在 dev 启用**（试水），stable/beta 保持官方默认。详见 optional-bundles.ts。
  const channel = updater?.getChannel() ?? 'stable';
  const sched = ensureScheduleBundle(path.join(dshHomeDir(), 'profiles', 'web'), channel);
  if (sched.changed) log(`可选 bundle 已按 ${channel} 通道启用（定时任务）`);
  else if (sched.skipped) log(`可选 bundle 未启用（${channel}）：${sched.skipped}`);

  const status = await service.start({
    install,
    preferredPort: PREFERRED_PORT,
    listenPort: port,
    portFallback: fallback,
    dshHome: dshHomeDir(),
    patchFile,
    version: install.version,
    // 首次启动 dsh 会在 DSH_HOME/profiles 下建立 profile 依赖（数百个符号链接/文件）。
    // 在启用实时防护的机械盘或企业管控机器上，这一步实测可能持续数分钟，
    // 因此超时上限放宽到 10 分钟；加载页会持续显示已等待时间。
    readyTimeoutMs: 600000,
  });

  if (status.state === 'ready' && status.url) {
    windowManager?.loadDshUi(status.url);
    return;
  }

  // 启动失败 → 自动切到恢复工具。
  //
  // 这是本功能的意义所在：dsh 起不来时，用户原本只有一个转圈的加载页，
  // 没有任何可操作的东西（界面本身跑在 dsh 里）。现在直接把他带到恢复页，
  // 那里能体检、能一键进安全模式、能补运行时。
  lastStartupError = status.message ?? 'Harness 未能启动';
  log('Harness 启动失败，切换到恢复工具：' + lastStartupError);
  windowManager?.loadRecoveryPage();
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
  computerUseBall?.destroy();
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

/** 插件落位概况：有影子/自愈时写进诊断，平时不占地方 */
function describePluginInstall(): string {
  const r = lastPluginInstall();
  if (!r) return '';
  const parts = [`插件 ${r.installed.length} 个`];
  if (r.healed.length > 0) {
    parts.push(
      `已自动顶回内置 ${r.healed.length} 个（${r.healed.map((h) => `${h.name} v${h.hot}→v${h.builtin}`).join('、')}）`,
    );
  }
  if (r.shadowed.length > 0) {
    parts.push(`内容不一致但保留用户目录版 ${r.shadowed.length} 个（${r.shadowed.map((s) => s.name).join('、')}）`);
  }
  if (r.problems.length > 0) parts.push(`问题 ${r.problems.length} 条`);
  return `插件: ${parts.join('；')}`;
}

/** 读日志文件最后 n 行；文件缺失/读失败返回空串（不进诊断，避免噪音） */
function tailOf(file: string, n: number, label: string): string {
  try {
    const tail = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return tail.length ? `${label}（末 ${Math.min(n, tail.length)} 行）:\n${tail.slice(-n).join('\n')}` : '';
  } catch {
    return '';
  }
}

/**
 * profile 共享 node_modules 里链接的健康度。
 *
 * 这些链接是「当时那份运行时」链进去的，且没有版本校验 —— 机器上先后跑过两份运行时
 * （开发态 + 安装版、或换过安装路径）时会残留指向旧运行时的链接，而入口用的是新运行时。
 * 这里只统计不修改（修复见 profile-links.ts 的 ensureProfileModuleLinks）。
 */
function describeProfileLinks(): string {
  const root = profileModulesDir();
  const runtimeNm = path.join(findRuntimeDir(), 'node_modules').toLowerCase();
  let total = 0;
  let mismatched = 0;
  const samples: string[] = [];

  const visit = (dir: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.name.startsWith('@')) {
        visit(full, `${prefix}${e.name}/`);
        continue;
      }
      let real: string;
      try {
        real = fs.realpathSync(full);
      } catch {
        continue;
      }
      if (real.toLowerCase() === full.toLowerCase()) continue; // 不是链接
      total++;
      if (!real.toLowerCase().startsWith(runtimeNm)) {
        mismatched++;
        if (samples.length < 3) samples.push(`${prefix}${e.name} → ${real}`);
      }
    }
  };
  visit(root, '');

  if (total === 0) return `profile 链接: 无（${root}）`;
  if (mismatched === 0) return `profile 链接: ${total} 个，全部指向当前运行时`;
  return `profile 链接: ${total} 个，其中 ${mismatched} 个指向其它运行时 → ${samples.join('；')}`;
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
    `通道: ${updater?.getChannel() ?? 'stable'}`,
    `运行时来源: ${
      appliedPatch(findRuntimeDir())
        ? `差分补丁（补丁版本 ${appliedPatch(findRuntimeDir())!.version}）`
        : '内置/完整包'
    }`,
    `profile 目录: ${profileModulesDir()}`,
    describeProfileLinks(),
    describePluginInstall(),
    tailOf(mainLogFile(), 50, '主日志尾部'),
    tailOf(dshLogFile(), 50, 'dsh 日志尾部'),
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
 * 列出已落位的插件目录（含 @scope/ 下一层），供兼容层逐个读 package.json 判定 peer。
 *
 * ⚠️ 必须扫**两处**，实测踩过只扫一处的坑：
 *   · profiles/node_modules/         —— 共享位（外壳 installPlugins 落内置插件的地方）
 *   · profiles/<name>/node_modules/  —— profile 私有位（用户用 `dsh plugin add` 装的）
 *
 * 2026-09-30 实测：dsh-workbuddy-connect 装在**私有位**，而旧代码只扫共享位 →
 * 它从未进入兼容层视野、没写豁免 → dsh 原生校验把它拒了（报「可能崩溃或数据丢失」）。
 * 之前只拿 dshmarket / dsh-univer-office（都在共享位）验证，样本恰好绕过了这个盲区。
 *
 * 同名包以**私有位优先**（更接近用户实际意图），按 basename 去重。
 */
function pluginDirsInProfile(profileName = 'web'): string[] {
  const roots = [
    path.join(dshHomeDir(), 'profiles', 'node_modules'),
    path.join(dshHomeDir(), 'profiles', profileName, 'node_modules'),
  ];
  const byName = new Map<string, string>();

  for (const root of roots) {
    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // 目录不存在（首次启动 / 该 profile 没私有插件）→ 换下一个
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (entry.name.startsWith('@')) {
        let subs: import('node:fs').Dirent[];
        try {
          subs = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sub of subs) {
          if (!sub.isDirectory()) continue;
          // 私有位覆盖共享位：后写的赢（roots 里私有位在后面）
          byName.set(`${entry.name}/${sub.name}`, path.join(full, sub.name));
        }
      } else {
        byName.set(entry.name, full);
      }
    }
  }

  return [...byName.values()];
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
      typeof id === 'string' ? (shellFeatures?.isEnabled(id) ?? false) : false;
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
    computerUseBall?.setMainVisible(windowManager?.isVisible() ?? false);
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
  // ── 恢复工具（不依赖 dsh）───────────────────────────────────────────────
  // 这个界面在外壳自己的本地页面里跑（renderer/recovery.html），不走 dsh web ——
  // 它要解决的场景就是「dsh 起不来」。
  ipcMain.handle('recovery:diagnose', async () => {
    try {
      return await diagnose();
    } catch (err) {
      return [{ id: 'fatal', label: '体检', status: 'bad', detail: '体检本身失败：' + String(err) }];
    }
  });
  ipcMain.handle('recovery:fix', async (_e, payload: unknown) => {
    const p = (payload ?? {}) as { id?: unknown };
    const id = String(p.id ?? '');
    const fn = FIXES[id];
    if (!fn) return { ok: false, message: '未知的修复动作：' + id };
    try {
      const r = await fn();
      log('恢复工具执行了 ' + id + '：' + r.message);
      return r;
    } catch (err) {
      return { ok: false, message: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('recovery:state', () => ({
    safe: currentSafeMode(),
    lastError: lastStartupError,
  }));
  ipcMain.handle('recovery:environment', () => environmentSummary());
  ipcMain.handle('recovery:restart', () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('recovery:open-data-dir', () => shell.openPath(dshHomeDir()));

  // ── 技能与 MCP 管理 ──────────────────────────────────────────────────────
  // 这两个都是「文件/配置驱动、没有界面」的东西，这里给界面提供读写入口。
  // 所有写入都做校验（见 skill-mcp.ts）—— 写坏配置会让 dsh 起不来。
  ipcMain.handle('app:skills-list', () => {
    try {
      return { skills: listSkills(process.cwd()) };
    } catch (err) {
      return { skills: [], error: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('app:skills-create', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { name?: unknown; description?: unknown };
    try {
      return { skill: createSkill(String(p.name ?? ''), String(p.description ?? '')) };
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('app:skills-delete', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { name?: unknown };
    try {
      deleteSkill(String(p.name ?? ''));
      return { ok: true };
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('app:mcp-list', () => {
    try {
      return { servers: listMcpServers(), file: mcpConfigFile() };
    } catch (err) {
      return { servers: [], error: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('app:mcp-save', (_e, payload: unknown) => {
    const p = (payload ?? {}) as { servers?: unknown };
    try {
      if (!Array.isArray(p.servers)) throw new Error('servers 必须是数组');
      saveMcpServers(p.servers as never);
      return { ok: true, servers: listMcpServers() };
    } catch (err) {
      return { error: String((err as Error)?.message ?? err) };
    }
  });
  ipcMain.handle('app:open-skills-dir', async () => {
    const dir = userSkillsDir();
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    await shell.openPath(dir);
    return { ok: true, dir };
  });

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
    const ok = channel === 'stable' || channel === 'beta' || channel === 'dev' || channel === 'nightly';
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
    onOpenRecovery: () => {
      windowManager?.loadRecoveryPage();
      windowManager?.show();
    },
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

  // computer use 悬浮球：主窗口隐藏且自动化进行时显示，同时抑制主窗口把焦点抢回去
  computerUseBall = new ComputerUseBall({
    onOpenMainWindow: () => {
      // 用户主动点悬浮球 → 解除抑制，正常打开并聚焦
      if (windowManager) windowManager.suppressAutoFocus = false;
      windowManager?.show();
    },
    isMainWindowHidden: () => !windowManager?.isVisible(),
  });
  computerUseBall.create();

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
