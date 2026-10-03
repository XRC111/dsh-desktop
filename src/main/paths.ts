import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 全局路径解析。
 *
 * 目录约定（Windows）：
 *   安装目录     %LOCALAPPDATA%\Programs\DSH Desktop
 *   用户数据     %APPDATA%\DSH-Desktop
 *   日志         %APPDATA%\DSH-Desktop\logs
 *   dsh 数据目录 %APPDATA%\DSH-Desktop\dsh-home   （DSH_HOME，与用户全局 ~/.dsh 隔离）
 *
 * 注意：这里一律用函数「惰性求值」，不在模块顶层调用 app.getPath()。
 * 模块加载顺序 + 环境异常（例如外部误设 ELECTRON_RUN_AS_NODE）都可能让 app 尚不可用，
 * 顶层求值会让整个进程直接崩溃。
 */

/** 用户数据根目录：%APPDATA%\DSH-Desktop */
export function userDataDir(): string {
  return path.join(app.getPath('appData'), 'DSH-Desktop');
}

/** 日志目录 */
export function logsDir(): string {
  return path.join(userDataDir(), 'logs');
}

/** 主日志文件（外壳自身日志） */
export function mainLogFile(): string {
  return path.join(logsDir(), 'app.log');
}

/** dsh web 的 stdout/stderr 日志文件 */
export function dshLogFile(): string {
  return path.join(logsDir(), 'dsh-web.log');
}

/** dsh 的数据目录（DSH_HOME）：配置 / 会话 / 插件都在这里 */
export function dshHomeDir(): string {
  // 允许通过环境变量覆盖（企业批量部署 / 测试时把数据目录放到指定位置）
  const override = process.env.DSH_DESKTOP_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(userDataDir(), 'dsh-home');
}

/**
 * 桌面适配补丁（通过 `--patch` 叠加到 web profile）。
 *
 * 优先用**热壳自带的那份**：热更新只换 out/，安装目录里的 desktop-patch.yml
 * 换不掉（打包态在 Program Files，无写权限也不该改）。若热壳引入了新的插件行
 * （insert），不读热壳那份就永远到不了已装用户 —— 表现为「外壳升上去了，但
 * 设置页少一节、新插件不生效」。
 *
 * 判定方式：本模块自身位置（__dirname = <壳目录>/main）是否落在 hotRoot() 下。
 * 这样不依赖 hot-shell.ts，避免模块循环引用。
 */
export function desktopPatchFile(): string {
  const hotDir = path.dirname(__dirname); // <壳目录>/main → <壳目录>
  try {
    const rel = path.relative(hotRoot(), hotDir);
    const insideHot = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (insideHot) {
      const hotPatch = path.join(hotDir, 'desktop-patch.yml');
      if (fs.existsSync(hotPatch)) return hotPatch;
    }
  } catch {
    /* 路径异常时退回内置补丁 */
  }
  return app.isPackaged
    ? path.join(process.resourcesPath, 'desktop-patch.yml')
    : path.join(app.getAppPath(), 'resources', 'desktop-patch.yml');
}

/**
 * 桌面适配插件（我们的 cordis 插件包）的源目录。
 *
 * 打包态随 extraResources 落到 `resources/dsh-plugins`；开发态用项目内的
 * `resources/dsh-plugins`。
 */
export function dshPluginsSourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dsh-plugins')
    : path.join(app.getAppPath(), 'resources', 'dsh-plugins');
}

/**
 * dsh 解析 profile 插件包名时查找的共享 node_modules。
 *
 * dsh 的加载器是**以 profile 目录为基准**解析包名的
 * （报错形如 `Cannot find package 'X' imported from …/profiles/web/`），
 * 而它自己只会把**自身依赖闭包里**的包链进这里（0.1.x 的 healProfilesModuleFallback；
 * 0.2.0 已不再新建，只保留 removeLinkProjections 清理旧式 .dsh-module-fallback）。
 * 我们的插件不在那个闭包里，所以必须由外壳自己放进去。
 *
 * 注意：dsh 链进来的那些链接**按当时那份运行时写死目标且无版本校验** —— 先后跑过两份
 * 运行时（开发态 + 安装版、或换过安装路径）就会残留指向旧运行时的链接，而入口用的是
 * 新的，同一个进程里两套 harness 并存。启动时的替换逻辑见 profile-links.ts。
 */
export function profileModulesDir(): string {
  return path.join(dshHomeDir(), 'profiles', 'node_modules');
}

/** 运行时文件清单（构建期生成，用于启动自检与自动修复） */
export function runtimeManifestFile(): string {
  return path.join(process.resourcesPath, 'dsh-runtime-manifest.json');
}

/** 运行时 tar 包位置（自动修复与兜底分发的修复源） */
export function runtimeTarFile(): string {
  return path.join(process.resourcesPath, 'dsh-runtime.tar');
}

/**
 * 多线程运行时解压器脚本（随包分发）。
 *
 * 安装期由 NSIS 调用同一份脚本，运行期（首启动兜底解压 / 缺失修补）也复用它，
 * 保证「安装」「修复」两条路径的行为完全一致。
 */
export function extractRuntimeScript(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'extract-runtime.cjs')
    : path.join(app.getAppPath(), 'resources', 'extract-runtime.cjs');
}

/** 打包后随应用落地的运行时目录（正常安装流程使用） */
export function packagedRuntimeDir(): string {
  return path.join(process.resourcesPath, 'dsh-runtime');
}

/** 开发态运行时目录（项目内，未打包时直接使用） */
export function devRuntimeDir(): string {
  return path.join(app.getAppPath(), 'resources', 'dsh-runtime');
}

/** 运行时解压根目录（用户数据目录下，保证可写） */
export function runtimeRoot(): string {
  return path.join(userDataDir(), 'runtime');
}

/** 运行时目录（开发态用项目目录，打包态用用户数据目录下的解压结果） */
export function dshRuntimeDir(): string {
  return app.isPackaged ? path.join(runtimeRoot(), 'dsh-runtime') : devRuntimeDir();
}

/** 渲染进程静态资源目录（加载态 / 错误页） */
export function rendererDir(): string {
  return path.join(__dirname, '..', 'renderer');
}

// ---------------------------------------------------------------------------
// 热更新相关
// ---------------------------------------------------------------------------

/**
 * 更新源配置（随包分发，装好后可直接改，不必重新打包）。
 *
 * 打包态取 resources\update-config.json；开发态取项目 resources 目录。
 */
export function updateConfigFile(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'update-config.json')
    : path.join(app.getAppPath(), 'resources', 'update-config.json');
}

/** 更新状态持久化（上次检查时间 / 已跳过的版本） */
export function updateStateFile(): string {
  return path.join(userDataDir(), 'update-state.json');
}

/**
 * 热更新壳的存放根目录。
 *
 * 放在用户数据目录（可写），每个版本一个 `shell-<version>` 子目录；
 * 入口引导器启动时优先加载这里最新的壳，因此「热更新」只要重启进程即可生效。
 */
export function hotRoot(): string {
  return path.join(userDataDir(), 'hot');
}

/** 更新包下载目录（用户数据目录下，保证可写） */
export function updatesDir(): string {
  return path.join(userDataDir(), 'updates');
}

/**
 * 热更新插件目录（用户数据目录下）。
 *
 * 插件由 `plugin-installer` 在每次启动时复制到 `$DSH_HOME/profiles/node_modules`，
 * 所以「插件热更新」只要把新插件解到这里、重启应用即可 —— 不需要覆盖安装目录里
 * 随安装包分发的那份（`resources/dsh-plugins`）；同名时以这里的为准。
 */
export function userPluginsDir(): string {
  return path.join(userDataDir(), 'plugins');
}

/**
 * 应用自身的安装目录（<安装目录>\resources 的上一级）。
 *
 * 热更新时用它给安装包传 /D= 参数，保证覆盖安装到原位置。
 */
/** dsh profile 的 node_modules（原生插件落位处，plugin-installer 也写这里） */
export function profilesModulesDir(): string {
  return path.join(userDataDir(), 'dsh-home', 'profiles', 'node_modules');
}

export function installedAppDir(): string {
  return app.isPackaged ? path.dirname(process.resourcesPath) : app.getAppPath();
}

export function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录已存在或无权限，交由后续逻辑报错 */
  }
}

/** 启动前准备好所有需要的目录 */
export function ensureAppDirs(): void {
  ensureDir(userDataDir());
  ensureDir(logsDir());
  ensureDir(dshHomeDir());
}
