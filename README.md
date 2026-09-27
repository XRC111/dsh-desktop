# DSH Desktop

把 **DeepSeek Harness**（npm 包 `@deepseek-ai/dsh`）封装成开箱即用的 Windows 桌面应用。

双击安装包即用，**用户机器不需要安装 Node.js / npm / pnpm 或任何运行时**。

---

## 1. 设计原则

| 约束 | 实现方式 |
| --- | --- |
| 不碰 Harness 源码 | 纯外壳：只启动 `dsh web`、加载其原生 Web UI、管理生命周期。不 patch、不 fork |
| 不额外叠加运行时 | 用 **Electron 内置 Node**（`ELECTRON_RUN_AS_NODE=1`）以纯 Node 模式跑 dsh，不分发 `node.exe` |
| 渲染内核 | Electron 自带 Chromium，不依赖 WebView2 或任何系统 Web 组件 |
| 安全默认值 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，渲染进程只拿到一个窄 IPC 接口 |
| 单渲染进程 | 只创建 1 个 `BrowserWindow` 承载 Harness UI |
| 无残留 | 退出时用 `taskkill /T /F` 回收整棵 dsh 进程树（Windows 上 `ChildProcess.kill()` 只杀直接子进程） |

---

## 2. 关键集成边界（实测确认，dsh 0.1.5-rc.1）

这些是通过实际运行 `dsh --help` / `dsh web --help` 与启动探测得到的结论，**不是臆测**：

| 项 | 结论 |
| --- | --- |
| 包名 / 版本 | `@deepseek-ai/dsh@0.1.5-rc.1` |
| 入口 | `package.json` 的 `bin.dsh` → `lib/bin.js`（**运行时读取，不硬编码**） |
| 启动命令 | `dsh web`（等价于 `dsh --profile web`） |
| `--no-open` | ✅ 支持，用于禁止 dsh 拉起系统浏览器 |
| `--port <n>` | ✅ 支持；`--port 0` 由操作系统分配空闲端口 |
| 启动输出 | stdout 单行：`dsh web: http://127.0.0.1:<port>/?token=<token>` |
| **token 机制** | 无 token 访问 `/` 返回 **401**；带 token 访问返回 **303 重定向**并建立会话。**外壳必须加载带 token 的完整 URL，不能只连端口** |
| 数据目录 | `DSH_HOME`（默认 `~/.dsh`）；本项目将其重定向到 `%APPDATA%\DSH-Desktop\dsh-home`，与用户全局环境隔离 |
| **必须带 `--expose-internals`** | web profile 会加载 `@deepseek-ai/cordis-plugin-hmr`，缺少该 flag 时启动即报 `--expose-internals is required for HMR service` 并退出。外壳已在启动参数中固定加上 |
| **profile 初始化** | 首次启动 dsh 会在 `DSH_HOME/profiles` 下建立 profile 依赖（数百个包），耗时约 1~3 分钟；之后启动只需数秒。就绪等待上限设为 240 s |
| **写锁自愈** | dsh 用 `profiles/*.lock`（内容是持有者 PID）做互斥。若上次是被 `taskkill /F` 强杀，锁会残留，导致下次启动卡在 `atomic-write: timed out waiting for the writer lock`。外壳在启动前会清理 PID 已失效的锁 |
| 原生模块 | `node-pty`（N-API 预编译）、`koffi`、`sharp`、`node-addon-require-builtin` —— **实测在 Electron ABI 149 下可直接加载，无需重编译** |
| 依赖规模 | 244 个 `@deepseek-ai/*` 包，`node_modules` ≈ 250 MB |


> ⚠️ 三个容易踩的坑，已在代码/构建脚本中处理：
> 1. **端口与 token 都不是固定的**：外壳解析 stdout 得到真实端口与 token，`--port 0` 时由系统分配。
> 2. **`--expose-internals` 是必需的**：web profile 的 HMR 插件要求 Node 暴露内部模块，
>    否则启动后立刻退出（`failed to apply loader entry (@deepseek-ai/cordis-plugin-hmr)`）。
> 3. **`npm install` 会被安装脚本卡住**：`koffi` 的 install 会调 `cnoke` 重新拉取/编译二进制，
>    在 Windows 构建机上极易长时间挂起。所有原生模块的预编译产物本来就随 tarball 分发，
>    因此构建脚本使用 `--ignore-scripts`（并单独补跑 `ensure-spawn-helper`）。

---

## 3. 版本选型

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Electron | 44.3.0 | 内置 **Node 24.20.0**（ABI 149），满足 dsh 的 `^22.19.0 || >=24.0.0` |
| TypeScript | 5.9.3 | 编译主进程 / preload |
| electron-builder | 26.15.3 | 生成 NSIS 安装包 |

换 Electron 版本前**必须确认其内置 Node 版本**（`ELECTRON_RUN_AS_NODE=1 electron.exe -p process.versions.node`），
dsh 要求 22.19.0+ 或 24.x。

---

## 4. 目录结构

```
dsh-desktop/
├─ src/
│  ├─ main/
│  │  ├─ index.ts            # 入口：单实例锁、启动编排、IPC、退出清理
│  │  ├─ dsh-locator.ts      # 读取 bin 字段定位 dsh 入口 + 运行时完整性校验
│  │  ├─ dsh-service.ts      # 子进程生命周期：spawn / 就绪解析 / 进程树回收 / 清理失效锁
│  │  ├─ runtime-installer.ts# 首次启动解压 dsh-runtime.tar 到用户数据目录
│  │  ├─ port.ts             # 端口探测与 TCP 就绪轮询
│  │  ├─ window-manager.ts   # 窗口创建、加载态、隐藏到托盘
│  │  ├─ tray-manager.ts     # 系统托盘菜单
│  │  ├─ logger.ts           # 流式日志写入 + 10 MB 轮转
│  │  └─ paths.ts            # 路径约定
│  ├─ preload/index.ts       # 窄 IPC 接口（contextBridge）
│  └─ renderer/loading.html  # 本地加载页 / 错误诊断页
├─ scripts/
│  ├─ build.ps1              # ★ 一键构建
│  ├─ fetch-dsh.mjs          # 拉取 dsh 生产依赖到 resources/dsh-runtime
│  ├─ pack-runtime.mjs       # 把运行时打成 build/dsh-runtime.tar 供安装包分发
│  ├─ rebuild-native.mjs     # 原生模块 ABI 探测（必要时才重编译）
│  ├─ verify-runtime.mjs     # 用 Electron 内置 Node 实跑 dsh 校验
│  ├─ probe-native.cjs       # 原生模块加载探测
│  ├─ gen-assets.mjs         # 生成 icon.ico / tray.png（零依赖手写 PNG/ICO）
│  └─ copy-static.mjs        # 复制静态资源到 out/
├─ build/
│  ├─ installer.nsh          # NSIS 自定义：卸载前杀进程树 + 询问是否删数据
│  └─ license.txt            # 安装向导许可协议页
└─ resources/dsh-runtime/    # 构建产物：dsh 及其生产依赖树（不提交版本库）
```

---

## 5. 构建

### 一键构建（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

完整链路：安装依赖 → 生成图标 → 拉取 dsh 运行时 → 原生模块探测 → 运行时校验 → 编译 TS → 打包运行时 tar → 生成 NSIS 安装包。

产物：`dist/DSH-Desktop-Setup-1.0.3.exe`（约 160 MB，含 260 MB 的 Harness 运行时压缩包）

### 运行时的分发方式（重要）

运行时**不能**直接交给 `extraResources`：electron-builder 会对其中的 `node_modules`
套用依赖树处理逻辑，结果一个文件都不会被复制（实测只复制出 `package.json`）。

也**不能**把 3.5 万个文件放进安装包让 NSIS 逐个写：NSIS 是单线程的，
实测一次安装要 **110 秒**，而且在杀软实时扫描的机器上会静默丢文件（实测丢 25.6%）。

因此运行时只以**单个 tar** 随包分发，安装期由**多线程解压器**并行展开：

1. `electron-builder --win dir` → 生成 `dist/win-unpacked`
2. `scripts/prepare-payload.mjs` → 校验 tar / 清单 / 解压器齐备，并清掉残留的
   `resources/dsh-runtime` 目录（让包内文件数保持数百个）
3. `electron-builder --win nsis --prepackaged dist/win-unpacked` → 生成安装包

安装时 NSIS 调用 `resources/extract-runtime.cmd`（用 Electron 内置 Node 充当解释器）
运行 `extract-runtime.cjs`：把文件清单按字节均分成几十批，用 8 个 tar 进程并行解压，
解压完逐文件校验、缺失自动重试。

实测（12 核 / NVMe，3.5 万文件 / 240 MB）：

| 方式 | 耗时 |
| --- | --- |
| NSIS 单线程逐个写（1.0.8 及以前） | 110s |
| 单进程 tar 解压 | 92s |
| 多线程解压（4 线程） | 26s |
| 多线程解压（8 线程） | **19s** |
| 多线程解压（16 线程） | 19s（I/O 已饱和） |

同一份解压器也用于**首次启动的兜底解压**与**运行时缺失修复**（`--only` 模式只补缺失项），
所以「安装 / 首启动 / 修复」三条路径的行为完全一致。

> 手动修复已安装的应用（安装目录通常需要管理员权限）：
> `node scripts/repair-installed.mjs "D:\dsh\DSH Desktop\resources"`
> 或直接运行安装目录下的 `resources\extract-runtime.cmd --force`。
>
> **改完代码必须重跑 `--win dir`**（或手动重打 `app.asar`）：
> `--prepackaged` 只重新生成安装器，**不会更新 `app.asar`**。本次踩过这个坑 ——
> 自愈逻辑写完后只重跑了 nsis，结果安装包里的应用代码还是旧版，自愈根本没生效。
> 手动重打 asar 的命令：
> ```powershell
> node node_modules\@electron\asar\bin\asar.js pack <含 package.json + out/ 的目录> dist\win-unpacked\resources\app.asar
> ```

> 注意：涉及 tar 时必须使用 Windows 自带的 `bsdtar`（`System32\tar.exe`）。
> Git Bash / MSYS 的 GNU tar 会把 `D:\...` 里的冒号当成远程主机名
> （`Cannot connect to D: resolve failed`）。

### 构建性能提示（慢盘 / 杀软环境）

构建慢**通常不是磁盘带宽的问题**，而是「每文件安全扫描 + 小文件系统调用」的开销。
本项目实测（关闭排除项的情况下）：

| 操作 | 实测 |
| --- | --- |
| 新建 200 个「目录 + 文件」 | 10.2 s（≈ **51 ms/文件**） |
| robocopy 复制 260 MB / 3.5 万文件 | 数分钟 |
| `tar -xf` 解压同规模文件树 | 约 30 分钟 |

按 NVMe 的顺序带宽算，260 MB 本应 0.1 s 级完成 —— 差距来自：
Windows Defender 实时保护（每个文件都要拦一次）+ 小文件无法利用顺序带宽。

优化建议：

1. **给工作目录加 Defender 排除**（管理员 PowerShell，收益最大）：
   ```powershell
   Add-MpPreference -ExclusionPath "D:\code\dsh-desktop"
   ```
2. **不要在 Git Bash 里做文件遍历统计**（`find | wc -l` 之类）：MSYS 层的每个
   `stat` 都要做 POSIX→Win32 转换，比原生慢 5~20 倍。改用 PowerShell 的 .NET API：
   ```powershell
   [System.IO.Directory]::GetDirectories($path).Count
   ```
3. **复制用 robocopy 多线程**：脚本已使用 `/MT:32`，慢盘上可提到 `/MT:64`
4. **分发形态权衡**：
   - 目录注入（当前方案）：NSIS 打包慢（要处理 3.5 万文件），但**首次启动快**
   - tar 分发：NSIS 打包快（只处理 1 个文件），但**首次启动慢**（要解压 3.5 万文件）

### 运行时完整性自检与自动修复

**问题**：NSIS 解压 3.5 万个小文件时，在部分机器上（杀软实时扫描 / 慢盘）会**静默丢文件**。
实测一次安装后 `dsh-runtime` 只剩 25972/34909 个文件（**缺失 25.6%**），
表现为 dsh 启动即退出并报 `Cannot find module './platform'` 之类。

**对策**：构建期生成清单，启动时自检，发现缺失就从安装包内附带的 tar 自动补齐，用户无需重装。

| 文件 | 作用 |
| --- | --- |
| `scripts/gen-runtime-manifest.mjs` | 扫描运行时生成 `build/dsh-runtime-manifest.json`（文件相对路径列表，与 tar 成员名一致） |
| `build/dsh-runtime.tar` | 自动修复的数据源（也是安装目录运行时缺失时的兜底解压源） |
| `runtime-installer.ts` | 抽样自检 → 全量查缺失 → `tar -T <list>` 批量补齐 |

流程：

```
启动 → 定位运行时（安装目录）
     → 抽样自检 300 个文件（几百次 stat，开销可忽略）
     → 有缺失？ 全量比对 → 从 tar 补齐 → 再次抽样确认
     → 继续启动 dsh
```

- 只在**打包态**执行；开发态直接跳过
- 修复期间加载页显示「检测到运行时文件缺失，正在自动修复…」
- 若补齐后仍不完整，或找不到 tar，会给出「重新运行安装包修复」的可读提示

### 常用参数

```powershell
# 只重新打包（运行时和依赖都已就绪，最省时）
scripts\build.ps1 -SkipInstall -SkipRuntime

# 强制重新拉取 dsh 运行时
scripts\build.ps1 -ForceRuntime

# 只产出免安装目录（不生成安装包）
scripts\build.ps1 -DirOnly
```

### 分步命令

```powershell
npm install                 # 应用自身依赖
npm run gen:assets          # 生成图标
npm run prepare:runtime     # 拉取 dsh 运行时至 resources/dsh-runtime
npm run rebuild:native      # 探测原生模块（默认不重编译）
npm run verify:runtime      # 校验运行时
npm run build               # 编译 TypeScript + 复制静态资源
npm run dist                # 生成 NSIS 安装包
npm start                   # 开发态直接运行（electron .）
```

### 国内镜像

镜像已写入项目根 `.npmrc`，环境变量亦可覆盖：

| 变量 | 默认值 |
| --- | --- |
| `DSH_NPM_REGISTRY` | `https://registry.npmmirror.com` |
| `ELECTRON_MIRROR` | `https://npmmirror.com/mirrors/electron/` |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | `https://npmmirror.com/mirrors/electron-builder-binaries/` |

---

## 6. 应用图标

图标取自 **DeepSeek 官方 favicon**（`https://www.deepseek.com/favicon.ico`，225×225、32bpp DIB 格式）。

生成链路（全部零依赖，手写解码/缩放/编码）：

| 脚本 | 作用 |
| --- | --- |
| `scripts/fetch-brand-icon.mjs` | 下载官方 favicon → `build/deepseek-icon/favicon.ico`（可选；离线时直接复用仓库内已放置的文件） |
| `scripts/gen-assets.mjs` | 解码 ICO 的 DIB 像素 → 预乘 alpha 双线性缩放 → 生成 `build/icon.ico`（256/128/64/48/32/16）与 `build/tray.png`（32×32） |

几点实现说明：

- 官方 favicon 是 **DIB/BMP 格式**（不是 PNG 内嵌），脚本按 `BITMAPINFOHEADER` 手动解码，
  自下而上读取像素、BGRA→RGBA，并在 alpha 全为 0 时回退到 AND mask
- 缩放使用**预乘 alpha** 的双线性插值，避免透明边缘出现黑边
- 若 `build/deepseek-icon/favicon.ico` 不存在，自动回退到内置占位图标（圆角渐变底 + 白色 D）

**换成自己的图标**：把图标放到 `build/deepseek-icon/favicon.ico`（或直接覆盖
`build/icon.ico` 与 `build/tray.png`），然后重新执行 `npm run dist`。

> 注意：窗口/安装包图标是编译进 exe 的，换图标必须重新跑一次 `electron-builder --win dir`
> （即完整 `npm run dist`），无法只替换文件生效。

## 7. 许可协议文件的编码（容易踩的坑）

安装向导的许可协议页由 `build/license.txt` 提供，**NSIS 3 对它的编码很敏感**：

- NSIS 读取 license 文本时会检测 BOM：UTF-16LE BOM / **UTF-8 BOM** 会被正确解码；
  **没有 BOM 则按系统 ANSI（简中为 GBK）解码** → UTF-8 无 BOM 的中文会整页乱码
- 因此该文件必须保存为 **UTF-8 with BOM**（首 3 字节 `EF BB BF`）

```powershell
# 校验 / 修复（需要时执行）
$p = "build\license.txt"
$t = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))
```

若在你的环境里仍然乱码，改用 RTF 更稳（MUI 会用 RichEdit 渲染，编码自描述）：

1. 把协议另存为 `build/license.rtf`
2. 将 `package.json` 的 `nsis.license` 改为 `build/license.rtf`
3. 重新执行 `npm run dist`

## 8. 桌面适配补丁（以 dsh 内置的插件/补丁机制实现）

**不改 Harness 源码**，而是用 dsh 自己的组合机制调整插件树。
dsh 的 `profiles/web/cordis.yml` 里写明了规则：

```
profile 根(空数组) → package.json 的 dsh.profile.bundles 各层 → cordis.patch.yml → --patch 覆盖层
```

所以外壳通过 `--patch` 叠加一份 `resources/desktop-patch.yml`（见 `dsh-service.ts`）。

### 补丁的两条规则

```yaml
# ① 定向覆盖已有行（按 id 定位，最后一个写入者生效）
- id: some-row-id
  disabled: true          # 或 config: {...}

# ② 插入新行
- insert:
    - id: my-row
      name: '@scope/my-plugin'
      config: {...}
```

> 重要：补丁是**整体替换**目标行的 `config`，不是合并。只想关掉某行时写 `disabled: true` 即可。

### 当前补丁内容

| 目标 | 作用 |
| --- | --- |
| `session-telemetry-otel` | 关闭会话遥测。默认会向 `harness-telemetry.deepseeksvc.com` 上报；关闭后同时**切断 `@opentelemetry/*` 的深层文件依赖** —— 那条路径在安装解压时最容易丢文件，一旦缺失会让 dsh 整个启动失败 |
| `hmr` | 意图关闭热重载（桌面版不需要） |

### 一个已知限制：hmr 禁不掉

`patchReload: live` 会让 launcher **动态插入**一个哈希 id（如 `#37433b9a`）的 hmr 行，
补丁按 id 定位不到它，因此 `--expose-internals` 仍需保留。
好在 Electron 以 `RUN_AS_NODE` 模式运行时接受该 flag，成本很低。

### 如何验证补丁是否生效

```powershell
# 输出会标注 "# patched by <你的补丁路径>"
electron.exe bin.js --profile web --patch resources\desktop-patch.yml --dump-config
```

> 注意参数分层：`web` 是 `--profile web` 的别名，但**子命令形式不接受父级参数**
> （会报 `web takes none of parent --profile, --patch, ...`）。
> 要叠加 `--patch` 就必须写成 `--profile web --patch <file>`，app 参数跟在后面。

### 新增适配的流程

1. 编辑 `resources/desktop-patch.yml`
2. 用上面的 `--dump-config` 确认条目已被 patch
3. 实测启动：`npm start`，看 `%APPDATA%\DSH-Desktop\logs\app.log` 里的
   `应用桌面适配补丁：...` 与 dsh 的启动结果
4. 重新打包

## 9. 与系统能力的对接

设计取向分两类，不要混为一谈：

- **界面内的东西保持 Harness 原风格**。凡是"面板/对话框"形态的交互（选择文件夹、
  确认、设置……），一律用 Harness 自己渲染的 UI，不弹 Windows 系统窗口 —— 否则
  一个网页风格的界面里突然冒出一个 Win32 对话框，观感非常割裂。
- **真正属于操作系统的动作才交给系统**。例如下载文件时的"另存为"、用外部应用
  打开文件、任务栏进度条、深浅色跟随 —— 这些本来就是 OS 该管的事。

### 选择文件夹：为什么默认会弹 Windows 对话框

`directory-picker` 这个交互由**一对**插件组成，两边缺一不可：

| 面 | 包 | 职责 |
| --- | --- | --- |
| Host 后端 | `dsh-host-directory-picker-{native,browse}` | 在主机侧提供 `ctx.directoryPicker` 能力（数据原语） |
| Client 表面 | `dsh-client-ui-directory-picker-{native,browse}` | 在浏览器侧占据 `ui-workspace` 的 `directoryFlow` 座位（界面） |

web profile 里挂的那行是 **`dsh-host-directory-picker-auto`** —— 它**不是**一个
选择器实现，而是一个**选择器**：启动时按平台采样一次，再用 `loader.create()`
动态挂载匹配的那一对。它的判定顺序是：

```
bindHost !== '127.0.0.1' → browse    # 绑了外部地址，远程浏览器的 OS 对话框够不着
ssh                      → browse    # SSH 端口转发下对话框会开在无人值守的服务器上
platform === darwin|win32 → native   # ← 我们命中这里
linux 且无 zenity/kdialog → browse
```

于是 Windows 上挂的是 native 那一对，而 native 的**前端组件是个空实现**：

```js
function NativeDirectoryFlow() { ... return null; }   // 什么都不渲染
// 它只负责 ctx.uiWorkspace.pickDirectory() 回调主机去弹 COM IFileOpenDialog
```

所以界面上看不到任何 Harness 风格的目录浏览 UI，点一下就直接弹系统对话框 —— 这正是
最初那个"还是 Windows 弹窗"的来源。

### 我们怎么改：自有插件补上「盘符」

web-app 的注释给了正规做法（`dsh-web-app/cordis.patch.yml` 第 94 行）：

> Resolve bind host, SSH launch, and display once at boot, then mount the matching
> dual-face directory picker. **Mount -native or -browse directly in an overlay to
> pin the interaction.**

先用 Harness 自带的 `-browse` 钉住之后，界面风格统一了，但暴露出一个真实缺陷：
**换不了盘符**。`-browse` 只提供「列出某个目录的直接子目录」，而 Windows 上没有
能列出全部盘符的根目录，浏览器起点又是主目录（`C:\Users\…`）——于是用户没有任何
办法到 `D:\`，只能手动「编辑路径」。

所以我们在 browse 能力之上补一层，写成自有插件（`resources/dsh-plugins/directory-picker`）：
它在列目录时额外提供**虚拟根「此电脑」**，内容就是本机盘符。

```yaml
- id: directory-picker
  disabled: true
- insert:
    - id: directory-picker-desktop
      name: '@dsh-desktop/directory-picker'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

**两个都挂是关键**。只挂 host 后端（曾经踩过的坑）时，前端那两个 `directoryFlow`
座位没有任何插件注册，界面会落到兜底实现上 —— 仍然弹系统对话框，看起来像补丁没生效。

前端沿用 Harness 自带的 browse 表面：面包屑 + 可编辑路径 + 目录列表 + 新建文件夹，
全部由 Harness 自己的 UI primitives 渲染，与主界面同风格。插件只改数据原语，不动界面代码。

#### 关键设计：盘符不能塞进每个目录的条目里

第一版做错了 —— 把盘符注入到**每一次** `list()` 的返回里。结果盘符成了「所有文件夹的
子项」：选中 `D:\` 时右栏列它的子项，`C:\`、`D:\` 又出现一遍，左右两栏同时重复。

正确做法是给盘符一个**独立的虚拟父级**（像资源管理器那样）：

| 调用 | 面包屑 | 盘符条目 |
| --- | --- | --- |
| `list()`（省略 = 主目录） | 此电脑 › C:\ › Users › Administrator | 0 个 |
| `list('此电脑')` | 此电脑 | `C:\`、`D:\` |
| `list('D:\\')` | 此电脑 › D:\ | **0 个** |
| `list('D:\\code')` | 此电脑 › D:\ › code | **0 个** |

任何普通目录的面包屑最前面都挂一个「此电脑」，点它才列出全部盘符。
盘符的 `path` 就是它自己的根路径（`D:\`），前端点一下即切盘 ——
**不需要任何新的 wire API**（`DirectoryEntry` 的 `{ name, path, hidden }` 形状原样够用）。

> 哨兵值用 `'此电脑'`：它不是任何平台的合法路径，因此永远不会和真实目录重名
> （真实目录一定是 `D:\此电脑` 这样的绝对路径）。`createDirectory('此电脑', …)`
> 会被拒绝。前端对路径**不做**合法性校验（校验由后端负责），所以哨兵可用。

#### 插件放在哪：必须由外壳自己放进 profile

dsh 的加载器**以 profile 目录为基准**解析插件包名：

```
Cannot find package '@dsh-desktop/directory-picker' imported from …\profiles\web\
```

把插件放进 dsh 运行时的 `node_modules` **没有用** —— 那不是 profile 的祖先目录。
而 dsh 自己的 `healProfilesModuleFallback()` 只会把它**自身安装依赖闭包里**的包
链进 `$DSH_HOME/profiles/node_modules`，我们的包不在那个闭包里，永远不会被链上。

所以桌面外壳在每次启动、**在 dsh 起来之前**把插件复制到
`$DSH_HOME/profiles/node_modules/@dsh-desktop/`（见 `src/main/plugin-installer.ts`）。
放这里的另一个好处：插件自身 `import '@deepseek-ai/…'` 时向上一级就命中 dsh 已链好的包。

> 写 patch 时注意：**不能把 `directory-picker` 那行的 `name` 直接改成我们的包名** ——
> loader 会校验并跳过，报
> `patch: name mismatch for "directory-picker" (expected "...-auto", got "..."), skipping`。
> 必须是"禁用原行 + insert 新行"，id 也不能与原来的重复。

### 验证方法

只看 `--dump-config` 是不够的（它只证明行被组合进去了）。要证明**前端真的换了**，
得看首屏返回的 boot 清单：

```powershell
# 1) 抓带 token 的地址，用 cookie 换掉 token
curl -s -c cj.txt "http://127.0.0.1:<port>/?token=<token>"
curl -sL -b cj.txt "http://127.0.0.1:<port>/" -o index.html
# 2) boot 清单里应当只有 browse，没有 native
Select-String -Path index.html -Pattern 'directory-picker[a-z-]*' -AllMatches
```

正常情况下清单里会出现 `@deepseek-ai/dsh-client-ui-directory-picker-browse/client.js`，
而 `-native` 完全不出现。另外在握手暴露的 remote 列表里，browse 能力带的是
`directoryPicker/list` 与 `directoryPicker/createDirectory`（native 只有 `pick`）——
这两个原语出现即为 browse 后端已接管。

### 其他系统能力

| 能力 | 实现 | 说明 |
| --- | --- | --- |
| "用其他应用打开" | `dsh-host-open-in-app` 探测系统关联应用并在**界面内**展示按钮 | 随 web profile 挂载，UI 由 `dsh-client-ui-open-in-app` 渲染，不弹系统窗口 |
| 文件下载 → 系统"另存为" | `session.on('will-download')` + `dialog.showSaveDialog` | Harness 的 `/export` 会话导出、附件下载都经过这里；这个**应该**用系统对话框 |

### 外壳侧补充（Electron 主进程，见 `index.ts` 的 `setupSystemIntegration()`）

| 能力 | 实现 |
| --- | --- |
| 文件下载 → 系统「另存为」 | `session.on('will-download')` + `dialog.showSaveDialog`（Harness 的 `/export` 会话导出、附件下载都经过这里） |
| 下载进度 → 任务栏进度条 | `win.setProgressBar()`，完成或取消后复位 |
| 权限收窄 | `setPermissionRequestHandler` 只放行通知与剪贴板，其余（摄像头/麦克风/地理位置/HID/串口）一律拒绝并记日志 |
| 标题跟随会话 | `page-title-updated` → `setTitle('<会话> — DSH Desktop')`；窗口隐藏时 `flashFrame()` 提示 |
| 深浅色跟随系统 | `nativeTheme` → 窗口 `backgroundColor`（加载页本身也用 `prefers-color-scheme`） |
| 外链走系统浏览器 | `setWindowOpenHandler` + `will-navigate` 拦截 |

## 10. 安装包行为

- 默认**按当前用户安装**（`perMachine: false`），无需管理员权限 → `%LOCALAPPDATA%\Programs\DSH Desktop`
- 辅助安装向导：许可协议 → 选择安装目录 → 创建开始菜单/桌面快捷方式 → 完成后可立即启动
- 注册标准卸载程序；**卸载前先 `taskkill /IM "DSH Desktop.exe" /T /F` 回收 dsh 进程树**，再删除安装目录与快捷方式
- 用户数据在 `%APPDATA%\DSH-Desktop`，卸载**默认保留**并弹框询问是否删除
- 支持静默安装/卸载：`DSH-Desktop-Setup-1.0.3.exe /S`、`Uninstall DSH Desktop.exe /S`

---

## 11. 运行时行为

```
启动 → 立即显示窗口(本地加载页)  ─┐
                                 ├─ 并行：校验运行时 → 清理失效锁 → 选端口 → spawn dsh web
托盘图标创建 ────────────────────┘
                                 ↓
                  解析 stdout: http://127.0.0.1:<port>/?token=...
                                 ↓
                  TCP 确认端口可连接 → loadURL(带 token) → Harness 原生 UI
```

- **端口**：首选 3080；被占用则用 `--port 0` 交给系统分配，并在日志与加载页提示
- **首次启动较慢**：dsh 需要初始化 `DSH_HOME/profiles`（约 1~3 分钟），加载页会一直显示「正在启动本地服务…」
- **关闭窗口**：最小化到托盘，dsh 保持运行，再次打开毫秒级恢复
- **完全退出**：托盘菜单 → 先停 dsh（含进程树）→ 再退出应用
- **日志**：`%APPDATA%\DSH-Desktop\logs\app.log`（外壳）与 `dsh-web.log`（Harness 输出），单文件超 10 MB 自动轮转
- **单实例锁**：第二次启动聚焦已有窗口

---

## 12. 验收自测清单

- [ ] 干净 Windows 虚拟机（无 Node.js）双击 `DSH-Desktop-Setup-1.0.3.exe` 完成安装
- [ ] **安装向导的许可协议页中文显示正常**（非乱码；若乱码见第 7 节编码说明）
- [ ] 从开始菜单启动，首次直接进入 Harness Web UI，无需任何额外配置
- [ ] 冷启动到窗口出现 ≤ 1 s（窗口先出，dsh 后台预热）
- [ ] 关闭窗口后托盘仍在、dsh 进程仍在；再次打开窗口毫秒级恢复
- [ ] 托盘 → 完全退出后，任务管理器无 `DSH Desktop.exe` 残留（含子进程）
- [ ] 日志文件正常写入并在超过 10 MB 时轮转
- [ ] 卸载后安装目录与快捷方式被清除；用户数据按提示保留或删除

> 提示：退出后确认残留进程可用
> `Get-Process "DSH Desktop" -ErrorAction SilentlyContinue` 检查。

---

## 13. 更新（热更新 + 完整安装包）

应用会读**云端 JSON** 拿更新信息。有两条通道，优先热更新：

| 通道 | 下载量 | 生效方式 | 适用 |
| --- | --- | --- | --- |
| **热更新** | ~220 KB（只有外壳代码） | **重启应用即生效**（几秒） | 改外壳逻辑/界面 |
| 完整安装包 | ~145 MB（含 dsh 运行时） | 静默覆盖安装（约 1 分钟） + 自动重启 | 换 dsh 运行时 / Electron / 跨大版本 |

### 重启时机由用户决定

**默认绝不擅自重启**（不会打断手头的工作）：

- 更新就绪后只弹一条托盘通知，托盘菜单变成「重启以应用热更新 x.y.z（点击重启）」
- 选「稍后」不等于放弃：热壳已经落位，**下次启动应用时自动生效**
- 主动检查更新时，弹窗给出三个选择：
  - 稍后（下次启动生效）— 默认项
  - N 分钟后自动重启 — 期间托盘菜单显示倒计时，点一下即可取消
  - 立即重启
- 只有显式配置 `autoRestart: true`（无人值守 / 企业批量部署）才会自动重启

### 当前实际部署（本项目）

- 托管：**Cloudflare Pages** 项目 `dsh-desktop-feed`（免费、不需要绑卡）
- 地址：**`https://dl.666-xrc.cc.cd`**（Pages 自定义域名，zone `666-xrc.cc.cd`）
- feedUrl 已写进 `resources/update-config.json`，新装的应用开箱即可检查更新
- 通道：**纯热更新**（`hot` + `latest.json`，合计约 220 KB）；145 MB 安装包不走 Pages
  （Pages 单文件上限 25 MiB），首次安装或换运行时版本时手工分发

发版三条命令：

```powershell
node scripts/pack-hot.mjs        --version 1.1.3 --base 1.1.1
node scripts/gen-update-json.mjs --base-url https://dl.666-xrc.cc.cd --version 1.1.3 `
     --hot build/hot-shell-1.1.3.tar --hot-only
node scripts/deploy-pages.mjs    --project dsh-desktop-feed --hot build/hot-shell-1.1.3.tar
```

上线前自测：`node .probe/verify-pages.mjs https://dl.666-xrc.cc.cd`
（会核对公网可访问性 + 大小 + sha256）。

### 运行时热更新（跟版 dsh 本体）

dsh 运行时是 269MB / 3.5 万文件，整包不现实；所以跟版走**差分补丁**：
对比两棵运行时树，只打「新增 + 改动」的文件与「待删除」清单。

实测 `dsh 0.1.5-rc.1 → 0.1.5-rc.2`：未压缩 17.49MB → **tar.gz 只有 3.31MB**，放进免费 Pages 毫无压力。

```powershell
# 0) 先在新目录装一份目标版本的运行时树（隔离，不动现有）
node .probe/fetch-dsh-tree.mjs 0.1.5-rc.2
# 1) 打差分补丁（自动识别版本、打印云端 JSON 片段）
node scripts/pack-runtime-patch.mjs --from resources/dsh-runtime --to .probe/dsh-tree-0.1.5-rc.2
# 2) 生成 JSON（--runtime）并部署
node scripts/gen-update-json.mjs --base-url https://dl.666-xrc.cc.cd --version 1.1.2 `
     --hot-only --runtime build/dsh-runtime-patch-0.1.5-rc.1-to-0.1.5-rc.2.tar.gz
node scripts/deploy-pages.mjs --project dsh-desktop-feed
```

云端 JSON 里对应：

```json
"runtime": {
  "version": "0.1.5-rc.2",
  "baseVersion": "0.1.5-rc.1",
  "url": "https://…/dsh-runtime-patch-0.1.5-rc.1-to-0.1.5-rc.2.tar.gz",
  "sha256": "…",
  "size": 3474040
}
```

客户端行为：

- 下载 + 校验 sha256 → 解压到 `%APPDATA%\DSH-Desktop\updates\runtime-patch-<版本>\`（**下载阶段就解压完**）
- 落位后写 `runtime-pending.json`，托盘提示「重启以应用运行时更新 x」；**不自动重启**
- 重启时、dsh 启动**之前**套用：覆盖文件 + 按清单删除 + 清掉留下的空目录，实测 5 秒内完成
- 套用后在运行时目录写 `.runtime-patch.json` 标记：
  ① 用于显示当前运行时来自热更新；② **跳过安装包基于旧清单的完整性修复**（否则旧清单会把补丁删掉的文件又塞回来）
- `baseVersion` 与当前运行时不一致时**拒绝套用**（差分补丁只能从对应基线升），此时需要完整安装包
- 回退：删掉运行时目录让它从安装包内的 `dsh-runtime.tar` 重新展开即可（`repair-installed.mjs`）

### 版本与升级链（OTA 语义）

升级通道按 **OTA** 的思路设计：发版只管发最新的，客户端自己爬上来。

**热更新包 `hot`（自包含，可跨版本跳）**

- `baseVersion` 是「**最低**支持的已安装版本」，不是"必须等于"
- 客户端在所有能用（`app.getVersion() >= baseVersion`）的包里挑**版本最高**的那个
- 热更新包是 `out/` 的完整副本、自包含 → 通常一个包就能让所有旧客户端直接跳到最新
- `hot` 可以是单个对象，也可以是**升级链数组**（客户端自己挑最合适的那一档）
- 下限由 `package.json` 的 `config.hotMinBaseVersion` 决定（默认 1.1.0），
  **每次发版不用再手工配比基线**；只有外壳开始依赖更新的 Electron 能力时才需要抬它

**运行时补丁 `runtime`（差分，逐级爬）**

- `baseVersion` 是「**精确**基线」——补丁只含差异文件，只能从这一版升上来
- 客户端挑 `baseVersion` 与当前运行时一致的那一档，应用后重启，下次从新基线继续爬
  （rc.1→rc.2→rc.3…）
- 也可以给**升级链数组**（`--runtime a.tar.gz --runtime b.tar.gz`），
  客户端每次重启爬一档

**发一条热更新版本**

```powershell
node scripts/pack-hot.mjs --version 1.1.4        # base 自动取 hotMinBaseVersion
node scripts/gen-update-json.mjs --base-url https://dl.666-xrc.cc.cd --version 1.1.4 `
     --hot-only --hot build/hot-shell-1.1.4-<hash>.tar [--runtime build/dsh-runtime-patch-….tar.gz]
node scripts/deploy-pages.mjs --project dsh-desktop-feed
```

自测矩阵（模拟不同安装版本的客户端）：

```powershell
node .probe/ota-matrix.mjs
```

### 配置更新源

改 `resources/update-config.json`（随包分发；装好后在
`<安装目录>\resources\update-config.json` 也能直接改，重启应用生效）：

| 字段 | 说明 |
| --- | --- |
| `feedUrl` | 云端 JSON 地址。**必须是 https**（localhost 与 `allowInsecureHttp` 例外） |
| `channel` | 渠道标识，作为 `?channel=` 传给服务端，便于稳定版/内测版分流 |
| `checkOnStartup` | 启动 25 秒后自动检查一次（默认 true） |
| `checkIntervalHours` | 后台轮询间隔，默认 6 小时 |
| `autoDownload` | 发现有更新就自动下载（默认 false：只提示） |
| `autoRestart` | 更新就绪后自动重启（默认 **false**，绝不擅自重启） |
| `restartDelaySeconds` | 「N 分钟后自动重启」里的 N，默认 60 |
| `disableHotUpdate` | 只用完整安装包、关掉热更新通道 |
| `allowInsecureHttp` | 允许 http 源（仅联调时打开） |

`feedUrl` 保持示例地址（example.com）时更新功能**整体关闭，不会发任何请求**。

也可以用环境变量覆盖，便于联调与私有部署：

```powershell
$env:DSH_DESKTOP_UPDATE_URL = 'http://127.0.0.1:8899/latest.json'
$env:DSH_DESKTOP_UPDATE_DRYRUN = '1'        # 只下载并校验，不执行安装/重启
$env:DSH_DESKTOP_UPDATE_AUTO = '1'          # 有更新就自动下载（但不自动重启）
$env:DSH_DESKTOP_UPDATE_AUTO_RESTART = '1'  # 自动重启（无人值守场景）
```

### 云端 JSON 格式

```json
{
  "version": "1.1.1",
  "releaseDate": "2026-09-20",
  "notes": "更新说明，支持换行",
  "mandatory": false,
  "minSupportedVersion": "1.0.0",

  "hot": {
    "version": "1.1.1",
    "baseVersion": "1.1.0",
    "url": "https://example.com/hot-shell-1.1.1.tar",
    "sha256": "在这里填热更新包的 sha256",
    "size": 225280
  },

  "files": {
    "win32-x64": {
      "url": "https://example.com/DSH-Desktop-Setup-1.1.1.exe",
      "sha256": "在这里填安装包的 sha256",
      "size": 151665432
    }
  }
}
```

- `version` 必填，比当前**生效壳版本**新才会提示（支持 `1.0.10 > 1.0.9`，预发布 `1.1.0-rc.1 < 1.1.0`）
- `hot.baseVersion` 必须等于客户端**已安装的版本**（app.asar 里的版本）；
  不一致（跨大版本）时客户端会自动忽略热更新、改走完整安装包
- 只给 `hot` 不给 `files` 也行 —— 纯热更新，服务端连安装包都不用放
- `files` 键为 `平台-架构`（如 `win32-x64`）；也可简写成顶层 `url`/`sha256`/`size`
- 请求会自动带上 `?platform=win32&arch=x64&version=<当前版本>&channel=<渠道>`
- **强烈建议两个 sha256 都填**：下载后校验，不匹配直接拒绝执行

### 发一个热更新

```powershell
npm run build                                     # 编译
node scripts/pack-hot.mjs --version 1.1.2 --base 1.1.0
# → build/hot-shell-1.1.2.tar（约 220 KB）+ 现成的云端 JSON 片段（含 sha256/size）
```

把 tar 传到你的静态托管，把 JSON 片段填进云端 `hot` 字段即可。
客户端下载 → 校验 → 解压到 `%APPDATA%\DSH-Desktop\hot\shell-<版本>-<时间戳>` → 重启生效。

### 热更新的安全网

- 热壳只在 `baseVersion` 与安装版一致时加载
- 启动时登记「尝试计数」，进程活过 4 秒才算成功；连续 2 次失败自动把该壳改名禁用并回退内置壳
- 托盘菜单里有「回退到内置版本」（一键回到安装包里的壳）
- 正在运行的那份壳目录不会被改名或清理（否则运行中的进程会读到空文件）
- 旧壳最多保留 2 份，便于回退

### 部署更新源（三步）

```powershell
# 1) 生成 latest.json（sha256 / size 由脚本从实际产物算出，不用手填）
node scripts/gen-update-json.mjs --base-url https://cdn.example.com/dsh --version 1.1.1
#   需要带热更新通道时加：--hot build/hot-shell-<版本>.tar
#   其它可选：--notes "更新说明" --mandatory --min-version 1.0.0 --channel stable

# 2) 把 dist/update/ 整个目录上传到静态托管（当前含 latest.json + 安装包）
# 3) 让客户端读它：改 resources/update-config.json 的 feedUrl
#    → https://cdn.example.com/dsh/latest.json
```

发新版：

```powershell
npm run build
npm run dist                                        # 产出安装包（跨大版本/含运行时变更时需要）
node scripts/pack-hot.mjs --version 1.1.3 --base 1.1.1   # 只改外壳时：热更新包 ~220KB
node scripts/gen-update-json.mjs --base-url https://cdn.example.com/dsh `
     --version 1.1.3 --hot build/hot-shell-1.1.3.tar
```

### 一键部署到 Cloudflare R2

```powershell
# 首次先授权（浏览器 OAuth，不用把密钥贴出来）
cd C:\Users\Administrator\WorkBuddy\openlist\openlist-worker ; npx wrangler login

# 以后每次发版：
node scripts/pack-hot.mjs --version 1.1.3 --base 1.1.1
node scripts/gen-update-json.mjs --base-url https://你的域名/dsh --version 1.1.3 --hot build/hot-shell-1.1.3.tar
node scripts/deploy-r2.mjs --bucket openlist --prefix dsh-desktop
```

`deploy-r2.mjs` 会：校验登录态 → 按需创建桶、开启 r2.dev 公开访问（或读你已绑的自定义域名）
→ **先传安装包/热更新包、最后传 latest.json**（顺序保证客户端不会拿到指向空文件的 JSON）
→ 上传前把 JSON 里的 url 自动改写成真实公开地址 → 打印该填进 `update-config.json` 的 `feedUrl`。

也可以先用 `--dry-run` 看它到底要做什么。用 API token 时：
`set CLOUDFLARE_API_TOKEN=…`（权限 Account → Workers R2 Storage → Edit）+ `--account-id`。

> R2 桶默认**不公开**。生产建议给桶绑自定义域名（比 `r2.dev` 稳定，国内访问也好得多）。

### 只有 220KB 时：热更新通道可以完全免费托管

Cloudflare 免费存储的单文件上限：**KV 单值 25 MiB、Pages / Workers 静态资源 25 MiB/文件** ——
都放不下 145 MB 的安装包，但放 **220 KB 的热更新包绰绰有余**。

所以可以只发「纯热更新 feed」：`--hot-only` 生成不带 `files` 的 JSON，客户端照样能更新：

```powershell
node scripts/gen-update-json.mjs --base-url https://你的静态托管/dsh `
     --version 1.1.3 --hot build/hot-shell-1.1.3.tar --hot-only
```

只要 `latest.json` 与 `hot-*.tar` 能被 https 直链下载即可（Cloudflare Pages、你自己的服务器、
任何静态托管都行）。安装包通道（`files`）需要 R2（免费额度 10 GB，启用时需绑支付方式）
或你自己的服务器/对象存储，首次安装或换运行时版本时才用得上。

托管要求：任意静态托管都行（对象存储 / nginx / GitHub Pages）。要点：

- 三个文件（`latest.json`、`*.exe`、`hot-*.tar`）放在**同一目录**，URL 前缀一致
- `latest.json` 建议 `Cache-Control: no-cache`（客户端已带 no-cache 请求头，但 CDN 别缓存太久）
- 大文件（exe / tar）要可直接下载，不要返回 HTML 登录页
- 更新源必须是 **https**（本地联调可用 `http://127.0.0.1`）

### 本地联调

```powershell
# 1) 起本地更新源：版本 1.1.1 + 假安装包 + 真热更新包
node .probe/serve-update.mjs 8899 1.1.1 auto 524288 --hot build/hot-shell-1.1.1.tar
# 2) 让应用读它（自动下载，但不自动重启）
$env:DSH_DESKTOP_UPDATE_URL = 'http://127.0.0.1:8899/latest.json'
$env:DSH_DESKTOP_UPDATE_AUTO = '1'
```

`updater.ts` 里的 `compareVersions` / `pickFileForThisMachine` 是纯函数，可单独跑单测。

---

## 14. 已知限制

- 仅提供 **x64** 目标（Electron 44 已移除 32 位构建）
- 未做代码签名，SmartScreen 首次运行可能提示；如需消除，请配置 `win.certificateFile` / `certificatePassword` 或走企业签名流程
- Harness 处于 developer preview，升级 dsh 版本请修改根 `package.json` 的 `config.dshVersion` 后重新执行 `npm run prepare:runtime -- --force`

---

## 15. 贡献者

**作者与维护者**：[XRC111](https://github.com/XRC111)

开发过程中使用了以下 AI 模型（按字母序，用于代码编写、排障与文档撰写）：

| 模型 | 提供方 |
| --- | --- |
| [DeepSeek](https://github.com/deepseek-ai) | DeepSeek |
| [GLM](https://github.com/zai-org) | Z.ai（智谱） |
| [Hunyuan](https://github.com/Tencent-Hunyuan) | 腾讯 |
| [Kimi](https://github.com/MoonshotAI) | Moonshot AI（月之暗面） |

> 上表是**开发期间使用的模型/工具**，不是代码贡献者；
> 项目的设计决策、实现取舍与最终质量由维护者负责。

