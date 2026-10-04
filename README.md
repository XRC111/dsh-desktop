# DSH Desktop

把 **DeepSeek Harness**封装成开箱即用的 Windows 桌面应用。

双击安装包即用，**用户机器不需要安装 Node.js / npm / pnpm 或任何运行时**。

[![Release](https://img.shields.io/github/v/release/XRC111/dsh-desktop?label=release)](https://github.com/XRC111/dsh-desktop/releases/)
[![License](https://img.shields.io/badge/license-MIT-blue)](./package.json)

---

## 目录

- [1. 快速开始](#1-快速开始)
- [2. 设计原则](#2-设计原则)
- [3. 架构](#3-架构)
- [4. 目录结构](#4-目录结构)
- [5. 关键集成边界](#5-关键集成边界实测结论)
- [6. 构建](#6-构建)
- [7. 更新体系](#7-更新体系)
- [8. 桌面适配](#8-桌面适配)
- [9. 发版流程](#9-发版流程)
- [10. 排障](#10-排障)
- [11. 已知限制](#11-已知限制)
- [12. 贡献者](#12-贡献者)

---

## 1. 快速开始

### 装（最终用户）

安装包**一版一个 release**，tag 用日期+序号（如 [`2026.10.01-1`](https://github.com/XRC111/dsh-desktop/releases/tag/2026.10.01-1)）。

| 安装包 | 通道 | 内嵌 dsh | 适用 |
| --- | --- | --- | --- |
| `DSH-Desktop-Setup-10.1.7.exe` | 主线 stable | 0.1.7-rc.2 | **推荐**，Win10/11 |
| `DSH-Desktop-Setup-10.2.6.exe` | 主线 beta | 0.2.0-rc.2 | 想尝鲜 0.2.0 线 |
| `DSH-Desktop-Setup-10.3.5.exe` | 主线 dev | 0.2.0-rc.2 | 跟 dev 线 |
| `DSH-Desktop-Setup-7.1.8.exe` | w7 stable | 0.1.7-rc.2 | **Windows 7** |
| `DSH-Desktop-Setup-7.2.5.exe` | w7 beta | 0.2.0-rc.2 | Win7 + 0.2.0 |
| `DSH-Desktop-Setup-7.3.5.exe` | w7 dev | 0.2.0-rc.2 | Win7 + dev |

> **Win7 必须用 7.x**：主线包内嵌官方 Electron 44，在 Win7 上起不来；7.x 用社区 fork 并打了宿主指纹补丁（见 [8.4](#84-win7-支持)）。

装完后应用会自动接管后续更新（默认走 stable 通道）。

### 从源码构建（开发者）

```powershell
git clone https://github.com/XRC111/dsh-desktop.git
cd dsh-desktop
npm install
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

产物：`dist/DSH-Desktop-Setup-<version>.exe`（约 244 MB —— 含 314 MB 运行时的 tar、内置 git/python 与 Electron）。

---

## 2. 设计原则

这几条是硬约束，改动前请先读——它们解释了为什么代码长这样。

| 约束 | 实现方式 |
| --- | --- |
| **不碰 Harness 源码** | 纯外壳：只启动 `dsh web`、加载其原生 Web UI、管理生命周期。不 patch、不 fork dsh |
| **不额外分发运行时** | 用 **Electron 内置 Node**（`ELECTRON_RUN_AS_NODE=1`）跑 dsh，不分发 `node.exe` |
| **必带 `--expose-internals`** | web profile 的 HMR 插件要求它；缺了 dsh 会**静默秒退** |
| **从 stdout 解析地址** | 拿 `dsh web: http://127.0.0.1:<port>/?token=<token>`；不硬编码端口，且必须带 token 访问（否则 401） |
| **杀进程树用 `taskkill /T /F`** | `ChildProcess.kill()` 只杀直接子进程，会留孤儿 dsh |
| **安全默认值** | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；渲染进程只拿到一个窄 IPC 接口 |
| **重启时机由用户决定** | 默认绝不自动重启（不打断手头工作）；热更已落位，下次启动自动生效 |

---

## 3. 架构

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（app.asar 或热更新壳）                        │
│  index.ts ──引导器──▶ boot.ts ──┬─ WindowManager             │
│    · 单实例锁                    ├─ TrayManager               │
│    · 选壳（内置 / 热更新）        ├─ Updater（6 通道 feed）     │
│                                  ├─ DshService ──▶ dsh web    │
│                                  └─ plugin-installer          │
├─────────────────────────────────────────────────────────────┤
│ BaseWindow（无系统标题栏）                                    │
│  ├─ titleBarView  40px 自绘顶条（可关）                       │
│  └─ contentView   Harness Web UI（注入脚本 + IPC 挂这里）      │
└─────────────────────────────────────────────────────────────┘
                    │ spawn（ELECTRON_RUN_AS_NODE=1）
                    ▼
        dsh web  ──▶  http://127.0.0.1:<port>/?token=…
```

**关键点**：

- 热更新只换 `out/`（main + preload + renderer，约 350 KB），**不含 `resources/`**
- 所以新增插件必须走 [插件热更](#73-插件热更) 通道，补丁文件必须随热壳打包（见 [8.3](#83-热壳必须自带补丁)）
- dsh 子进程 = 同一个 `electron.exe` 以 Node 模式运行，不是另外的 Node

---

## 4. 目录结构

```
dsh-desktop/
├─ src/
│  ├─ main/
│  │  ├─ index.ts               # 引导器：单实例锁 + 选壳（内置/热更新）
│  │  ├─ boot.ts                # 主编排：启动服务、IPC、注入、托盘、更新
│  │  ├─ dsh-service.ts         # dsh 子进程生命周期：spawn/就绪解析/进程树回收/失效锁自愈
│  │  ├─ dsh-locator.ts         # 读 bin 字段定位 dsh 入口 + 运行时完整性校验
│  │  ├─ window-manager.ts      # BaseWindow + 双 WebContentsView + 外链/圆角/安全边距
│  │  ├─ tray-manager.ts        # 托盘菜单、任务状态、通知
│  │  ├─ updater.ts             # 更新检查/下载/落位（热壳 + 运行时差分 + 插件）
│  │  ├─ hot-shell.ts           # 热更新壳的落位/回滚/健康检查/清理
│  │  ├─ runtime-installer.ts   # 多线程解压 dsh-runtime.tar
│  │  ├─ runtime-patch.ts       # 运行时差分补丁的套用与标记
│  │  ├─ plugin-installer.ts    # 把内置插件复制到 profile 共享 node_modules
│  │  ├─ patch-guard.ts         # 补丁防护：剔除解析不到的插件行（防砖机）
│  │  ├─ shell-features.ts      # 桌面适配开关（唯一真源）
│  │  ├─ attachment-picker.ts   # 应用内文件选择（主进程侧）
│  │  ├─ win-console.ts         # 隐藏控制台（消除沙箱命令弹窗）+ win32-process 补丁自愈
│  │  ├─ logger.ts              # 流式日志 + 10 MB 轮转
│  │  ├─ paths.ts               # 路径约定（含热壳补丁优先解析）
│  │  └─ port.ts                # 端口探测与 TCP 就绪轮询
│  ├─ preload/index.ts          # 窄 IPC 桥（contextBridge → window.dshDesktop）
│  └─ renderer/
│     ├─ loading.html                   # 本地加载页 / 错误诊断页
│     ├─ titlebar.html                  # 自绘顶条
│     ├─ attachment-picker.client.js    # 应用内文件选择窗口
│     ├─ drag-drop-attach.client.js     # 拖放文件进附件
│     ├─ task-reporter.client.js        # 上报任务运行状态（驱动托盘）
│     └─ update-banner.client.js        # 应用内更新横幅
├─ resources/
│  ├─ desktop-patch.yml         # 桌面适配补丁（--patch 叠加）
│  ├─ update-config.json        # 更新源配置（主线）
│  ├─ update-config.w7.json     # 更新源配置（w7 模板，构建时覆盖）
│  ├─ extract-runtime.cjs/.cmd  # 多线程运行时解压器（安装期 + 首启兜底 + 修复）
│  └─ dsh-plugins/              # 随包分发的插件
│     ├─ directory-picker/      # 自有：目录选择后端（补盘符）
│     ├─ shell/                 # 自有：设置页「桌面」面板
│     ├─ updater/               # 自有：设置页「桌面更新」面板
│     ├─ dshmarket/             # 第三方：插件市场
│     └─ dsh-univer-office/     # 第三方：Office 预览
├─ scripts/
│  ├─ build.ps1                 # 一键构建
│  ├─ release-v2.ps1            # ★ 一键发版（九步，见第 9 节）
│  ├─ fetch-dsh.mjs             # 拉取 dsh 生产依赖到 resources/dsh-runtime
│  ├─ pack-runtime.mjs          # 运行时打成 build/dsh-runtime.tar
│  ├─ pack-runtime-patch.mjs    # 运行时差分补丁
│  ├─ pack-hot.mjs              # 热更新壳（按 version+baseVersion 幂等）
│  ├─ pack-plugins.mjs          # 插件热更包（超 25 MiB 自动切片）
│  ├─ gen-update-json.mjs       # 生成 feed JSON（可多 --hot/--runtime/--plugins）
│  ├─ deploy-pages.mjs          # 暂存 + 部署到 Cloudflare Pages
│  ├─ gen-runtime-manifest.mjs  # 运行时文件清单（自检/修复基准）
│  ├─ verify-package.mjs        # 打包产物自检
│  ├─ verify-runtime.mjs        # 用 Electron 内置 Node 实跑 dsh 校验
│  ├─ verify-hot-base.mjs       # 热更新基线语义单测（23 用例）
│  ├─ patch-w7-electron.py      # w7 fork Electron 指纹补丁
│  ├─ repair-installed.mjs      # 就地修复已安装实例
│  ├─ clean.mjs / copy-static.mjs / gen-assets.mjs / …
│  └─ add-defender-exclusion.ps1
├─ build/
│  ├─ installer.nsh             # NSIS 自定义（杀进程树 + 清旧热壳/混合树）
│  └─ license.txt               # 许可协议页（必须 UTF-8 with BOM）
└─ dist/                        # 构建产物（不提交）
```

---

## 5. 关键集成边界（实测结论）

以下是通过实际运行探测得到的结论，**不是臆测**：

| 项 | 结论 |
| --- | --- |
| 包名 / 版本 | `@deepseek-ai/dsh`，当前内嵌 **0.1.5-rc.3** |
| 入口 | `package.json` 的 `bin.dsh` → `lib/bin.js`（**运行时读取，不硬编码**） |
| 启动命令 | `--profile web --patch <file> --no-open --port <n>` |
| **token 机制** | 无 token 访问 `/` 返回 **401**；带 token 返回 **303** 并建立会话。**必须加载带 token 的完整 URL** |
| 数据目录 | `DSH_HOME`（默认 `~/.dsh`）→ 重定向到 `%APPDATA%\DSH-Desktop\dsh-home`，与全局环境隔离 |
| **必须带 `--expose-internals`** | web profile 会加载 HMR 插件，缺该 flag 时启动即退出 |
| **profile 初始化** | 首次启动在 `DSH_HOME/profiles` 建依赖（数百个包），约 1~3 分钟；之后数秒。就绪上限设 600 s |
| **写锁自愈** | 用 `profiles/*.lock`（存 PID）互斥；被强杀会留锁 → 启动前清理失效锁 |
| 原生模块 | `node-pty` / `koffi` / `sharp` / `node-addon-require-builtin` 在 Electron ABI 下**可直接加载，无需重编译** |
| 依赖规模 | 244 个 `@deepseek-ai/*` 包，`node_modules` ≈ 250 MB |

> ⚠️ **三个坑**，已在代码/脚本中处理：
> 1. **端口与 token 都不固定** —— 解析 stdout 拿真实值，`--port 0` 时由系统分配。
> 2. **`--expose-internals` 必需** —— 否则 `failed to apply loader entry (cordis-plugin-hmr)` 秒退。
> 3. **`npm install` 会被 koffi 卡住** —— 构建脚本用 `--ignore-scripts`（预编译产物本来就随 tarball 分发）。

### 5.1 参数分层陷阱

`web` 是 `--profile web` 的别名，但**子命令形式不接受父级参数**：

```
dsh web --patch x.yml          # ✗ 报 "web takes none of parent --patch"
dsh --profile web --patch x.yml --no-open --port 0   # ✓
```

### 5.2 dsh 0.1.7 起的宿主指纹白名单

dsh 0.1.7 的 `installRuntimeInterception` 会按宿主指纹校验，表硬编码 **43.0.0 / 44.0.0 / 45.0.0-alpha.6**（44.0.0 = Node 24.18.1 + V8 15.2.124.13）。不在表内 → `Unsupported/no-context` fatal，**dsh 拒绝启动**。

所以外壳 Electron **锁定官方 44.0.0**。换 Electron 大版本前必须先查这张表。

---

## 6. 构建

### 6.1 一键构建

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

完整链路：装依赖 → 生成图标 → 拉 dsh 运行时 → 原生模块探测 → 运行时校验 → 编译 TS → 打包运行时 tar → 生成 NSIS。

常用开关：

```powershell
# 只重新打包（运行时与依赖已就绪，最省时）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipInstall -SkipRuntime
```

### 6.2 运行时的分发方式（重要）

运行时**不能**直接交给 `extraResources`：electron-builder 会对其中的 `node_modules` 套用依赖树逻辑，结果一个文件都复制不出来（实测只出 `package.json`）。

也**不能**把 3.5 万个文件放进安装包让 NSIS 逐个写：NSIS 单线程，实测一次安装 **110 秒**，且杀软实时扫描下会**静默丢文件**（实测丢 25.6%）。

因此运行时只以**单个 tar** 随包分发，安装期由**多线程解压器**并行展开：

1. `electron-builder --win dir` → `dist/win-unpacked`
2. `prepare-payload.mjs` → 校验 tar/清单/解压器齐备，清掉残留运行时目录（包内文件数保持数百个）
3. `electron-builder --win nsis --prepackaged` → 安装包

安装时 NSIS 调 `resources/extract-runtime.cmd`（用 Electron 内置 Node 当解释器）跑 `extract-runtime.cjs`：按清单把文件均分成几十批，**8 个 tar 进程并行解压**，解完逐文件校验、缺失重试。

同一实现复用于三处：**安装期**、**首启动兜底**、**运行时修复**。

### 6.3 构建性能提示

- 慢盘/杀软环境建议先加排除项：`scripts/add-defender-exclusion.ps1`
- 别用 Git Bash 构建（GNU tar 会把 `D:\...` 当远程主机）；用 PowerShell
- 重跑 `--win dir` 前把 `dist\win-unpacked` 移开（删 1 万+ 文件很慢）

---

## 7. 更新体系

### 7.1 通道与版本矩阵

**minor = 通道，patch = 通道内迭代**：

| 通道 | 主线（Win10/11） | w7 线 | 内嵌 dsh | feed |
| --- | --- | --- | --- | --- |
| stable | 10.1.x | 7.1.x | latest（0.1.5-rc.3） | `latest.json` / `latest-w7.json` |
| beta | 10.2.0 | 7.2.0 | next（0.1.7-rc.2） | `latest-beta.json` / `latest-w7-beta.json` |
| dev | 10.3.0 | 7.3.0 | alpha（0.1.7-alpha.2） | `latest-dev.json` / `latest-w7-dev.json` |

- **10 > 7**：主线版本永远高于 w7，避免互相误判
- w7 壳的 `feedUrl` 用占位符 `latest-w7{channel}.json` → 应用内切通道只在 w7 三份 feed 内轮换，**永远碰不到主线 feed**
- 未知通道一律回落 `stable`（`normalizeChannel`）

### 7.2 三种更新载荷

| 载荷 | 体积 | 生效 | 用途 |
| --- | --- | --- | --- |
| **热更新壳** `hot` | ~350 KB | 重启即生效 | 改外壳逻辑/界面/补丁
| **运行时差分** `runtime` | 3~15 MB | 重启时套用 | 跟版 dsh 本体
| **插件包** `plugins` | ~1.6 MB | 重启后落位 | 新增/升级插件（含新功能）
| 完整安装包 | ~160 MB | 覆盖安装 | 换 Electron / 跨大版本 |

**触发条件**：`available = shellOutdated || !!rt || !!plugins` —— **`hot` 不在其中**。

> ⚠️ 这条很关键：切回 stable 时云端版本低于当前，不触发 `shellOutdated`，全靠 **runtime 差分 baseVersion 精确命中**把整条降级链带起来（`pickHot` 不看升降方向，只按 `installed >= base` 过滤）。所以 stable feed 必须**同时挂 hot + rt 差分**。

### 7.3 插件热更

热更新只换 `out/`，**`resources/dsh-plugins/` 到不了已装用户** —— 新增插件必须单独下发：

```powershell
node scripts/pack-plugins.mjs --name shell
```

产物落 `build/plugins-<名>-<版本>-<sha8>.tar.gz` + `.meta.json`，`release-v2.ps1` 按白名单逐个挂进六份 feed。

> ⚠️ **白名单不是「build 下有什么就发什么」**：`dsh-univer-office` 有 57 MB 且历史切片不完整，全量探测会把 feed 撑爆、部署直接 die。它随安装包分发即可。

`feed.plugins` 支持**数组**（一次挂多个）。单个时仍输出对象，与历史 feed 完全兼容。

### 7.4 热更新壳的两种变体

`baseVersion` 是「**最低**支持的已安装版本」，`pickHot` 在可用的里面挑版本最高的：

| 变体 | base | 作用 |
| --- | --- | --- |
| **前向壳** | `config.hotMinBaseVersion`（1.1.1） | 让**已装旧版**的用户热更上来 |
| **降级壳** | beta/dev 版本号 | 让 beta/dev 切回 stable 时整体滚回 |

两种缺一不可：只有降级壳 → 老用户拿不到新版热更，只能下 160 MB；只有前向壳 → 切回 stable 时壳版本回不去。

```powershell
node scripts/pack-hot.mjs --version 10.1.2                 # 前向壳（base 自动）
node scripts/pack-hot.mjs --version 10.1.2 --base 10.2.0   # 降级壳
```

脚本按包内 `hot-manifest.json` 的 `(version, baseVersion)` **幂等去重**；`--force` 强制重打。

### 7.5 运行时差分

```powershell
node scripts/pack-runtime-patch.mjs --from build/rt-next --to resources/dsh-runtime --out dist/update
```

- `baseVersion` 是**精确**基线（补丁只含差异文件），客户端挑与当前运行时一致的那档，应用后重启再从新基线爬
- 套用时机：**重启时、dsh 启动之前**；套用后写 `.runtime-patch.json`（显示来源 + 跳过基于旧清单的完整性修复）

### 7.6 更新源配置

`resources/update-config.json`：

| 字段 | 说明 |
| --- | --- |
| `feedUrl` | 云端 JSON 地址，**必须 https**（localhost 与 `allowInsecureHttp` 例外） |
| `channel` | 通道标识（stable/beta/dev），支持 `{channel}` 占位符 |
| `checkOnStartup` | 启动后自动检查一次（默认 true） |
| `checkIntervalHours` | 后台轮询间隔（默认 6） |
| `autoDownload` | 有更新就自动下载（默认 false：只提示） |
| `autoRestart` | 更新就绪后自动重启（默认 **false**，绝不擅自重启） |

环境变量覆盖（联调方便）：

```powershell
$env:DSH_DESKTOP_UPDATE_URL = 'http://127.0.0.1:8899/latest.json'
$env:DSH_DESKTOP_UPDATE_AUTO  = '1'   # 自动下载但不自动重启
$env:DSH_DESKTOP_UPDATE_DRYRUN = '1'  # 只下载校验，不安装
```

### 7.7 当前部署

| 通道 | feed | 线上版本 | 内嵌 dsh |
| --- | --- | --- | --- |
| 主线 stable | `latest.json` | 10.1.7 | 0.1.7-rc.2 |
| 主线 beta | `latest-beta.json` | 10.2.6 | 0.2.0-rc.2 |
| 主线 dev | `latest-dev.json` | 10.3.5 | 0.2.0-rc.2 |
| w7 stable | `latest-w7.json` | 7.1.8 | 0.1.7-rc.2 |
| w7 beta | `latest-w7-beta.json` | 7.2.5 | 0.2.0-rc.2 |
| w7 dev | `latest-w7-dev.json` | 7.3.5 | 0.2.0-rc.2 |
| nightly | `latest-nightly.json` | 由 CI 每日从 harness `master` 源码编译 | — |

- **feed 托管**：Cloudflare Pages 项目 `dsh-desktop-feed`，域名 **`https://dl.666-xrc.cc.cd`**
- **安装包分发**：GitHub Release，**tag = 日期+序号**（`scripts/release-tag.mjs` 算出，如 `2026.10.01-1`），feed 挂 `gh-proxy.com` 前缀加速
- **客户端镜像融合**：4 个镜像竞速探测（Range 0-0，8 s 超时，206 且总长吻合）+ 原链兜底；镜像下载失败回 origin 重试

---

## 8. 桌面适配

### 8.1 组合层补丁

**不改 dsh 源码**，用 dsh 自己的组合机制调插件树。加载顺序：

```
profile 根 → package.json 的 dsh.profile.bundles 各层 → cordis.patch.yml → --patch 覆盖层（我们的）
```

两条规则：

```yaml
# ① 定向覆盖已有行（按 id 定位，最后一个写入者生效）
- id: some-row-id
  disabled: true

# ② 插入新行
- insert:
    - id: my-row
      name: '@scope/my-plugin'
```

> 补丁是**整体替换**目标行的 `config`，不是合并。
> **不能改已有行的 `name`**（loader 报 `name mismatch`）→ 换实现必须「禁用原行 + insert 新行」。

`resources/desktop-patch.yml` 当前做的事：

| 目标 | 作用 |
| --- | --- |
| `hmr` | 关闭热重载（桌面版不需要） |
| `session-telemetry-otel` | 关闭遥测 + 切断 `@opentelemetry/*` 深层依赖（那条路径安装时最易丢文件） |
| `directory-picker` | 禁用默认（Windows 上会弹系统对话框），换自有实现 |
| `insert` | `@dsh-desktop/directory-picker` / `-ui-directory-picker-browse` / `dshmarket` / `@dsh-desktop/updater` / `@dsh-desktop/shell` |

验证补丁是否生效：

```powershell
# 输出会标注 "# patched by <补丁路径>"
electron.exe bin.js --profile web --patch resources\desktop-patch.yml --dump-config
```

### 8.2 目录选择：为什么要自己写

web profile 挂的是 `dsh-host-directory-picker-auto` —— 它**不是实现，是个选择器**：启动时按平台采样，再动态挂载匹配的那一对。Windows + 绑定 127.0.0.1 → 解析成 **native**，而 native 的前端组件是**空实现**（`return null`），只负责回调主机弹 COM `IFileOpenDialog`。于是 Harness 风格的界面里冒出 Win32 对话框。

换成自带的 `-browse` 后风格统一了，但暴露真实缺陷：**换不了盘符**（`-browse` 只列直接子目录，Windows 没有能列出全部盘符的根目录）。

所以自有插件在 browse 能力之上补一层：提供**虚拟根「此电脑」**，内容是本机盘符。

| 调用 | 面包屑 | 盘符条目 |
| --- | --- | --- |
| `list()`（省略 = 主目录） | 此电脑 › C:\ › Users › … | 0 个 |
| `list('此电脑')` | 此电脑 | `C:\`、`D:\` |
| `list('D:\\')` | 此电脑 › D:\ | 0 个 |

> 哨兵值 `'此电脑'` 不是任何平台的合法路径，因此永不与真实目录重名。盘符的 `path` 就是它自己的根路径，**不需要任何新 wire API**。

**插件放哪**：dsh 的加载器**以 profile 目录为基准**解析包名，放进 dsh 运行时的 `node_modules` 没用。所以外壳在每次启动、**dsh 起来之前**把插件复制到 `$DSH_HOME/profiles/node_modules/`（见 `plugin-installer.ts`）。

### 8.3 热壳必须自带补丁

热更新只换 `out/`，而补丁在 `resources/`（打包态 = 安装目录，无写权限也改不了）→ **热壳里新增的 insert 行永远到不了已装用户**（表现：外壳升上去了，但设置页少一节、新插件不生效）。

修法：`pack-hot.mjs` 把 `resources/desktop-patch.yml` 一并打进热壳根目录；`paths.desktopPatchFile()` 用「`__dirname` 是否在 `hotRoot()` 下」判定并优先读热壳那份。

### 8.4 Win7 支持

dsh 0.1.7 起有宿主指纹白名单（见 [5.2](#52-dsh-017-起的宿主指纹白名单)），官方 Electron 44.0.0 之后的版本（如 44.2.0/44.3.0）V8 是 `.19`，**不在表内**。

`scripts/patch-w7-electron.py` 对社区 fork 做**等长原位替换**（文件大小不变），把宿主指纹伪装成 44.0.0：

1. 4 处 V8 串 `15.2.124.19-electron.0` → `.13`
2. `napi_get_node_version` 返回的静态 struct `{24,20,0}` → `{24,18,1}`（按导出表动态定位，勿硬编码偏移）
3. 其余 16 处 `24.20.0` → `24.18.1`

实测：打补丁后 fork 44.2.0 上 **0.1.5-rc.3 与 0.1.7 均完整启动**。

**Win7 没有 `%SystemRoot%\System32\tar.exe`**（微软从 Win10 1803 才随系统内置 bsdtar）。历史上安装器、热更新、运行时补丁三处都直接 spawn 它，Win7 上统一表现为 **「无法调用系统 tar」**（实测 7.1.8）。现在三条链路都不再依赖系统 tar：

| 位置 | 用途 | 现在的做法 |
| --- | --- | --- |
| `resources/extract-runtime.cjs` | 安装期 / 首启 / 自动修复展开运行时 | 有系统 tar 走多进程并行；没有则退回内置**纯 JS 单线程**解压 |
| `src/main/tar-pure.ts` | 热壳（`.tar`）与运行时补丁（`.tar.gz`） | **纯 JS 优先**，系统 tar 仅作兜底 |
| `src/main/runtime-installer.ts` | 解压器失败后的兜底 | 先探测系统 tar 是否存在，不存在就直报真实失败原因 |

纯 JS 解压实测：26617 个文件 / 474 MB 用时 **12.5 s**（NVMe，单线程）；热壳（33 文件）、运行时差分（441 文件）、插件包三份真实产物与系统 tar 的结果**逐文件 SHA256 完全一致**。

### 8.5 桌面适配开关

十一个开关，可在 设置 → 桌面 单独开关。前六个是**桌面适配**，后五个是 **computer use（让 AI 操作本机）** 的能力闸门：

| 开关 id | 默认 | 功能 |
| --- | --- | --- |
| `externalLinks` | ✅ | 外链走系统浏览器（不在应用内新开窗口） |
| `dragDropAttach` | ❌ | 拖放文件进对话即添加附件（**外壳垫片**：与官方内置拖放冲突，默认关） |
| `trayStatus` | ✅ | 托盘显示任务运行状态 |
| `taskNotify` | ✅ | 任务完成时通知（窗口不在前台才弹） |
| `framelessFit` | ✅ | 无边框适配：系统圆角 + 右上角三键安全边距 |
| `showTitleBar` | ✅ | 显示外壳顶条（关掉即沉浸模式） |
| `computerUseScreenshot` | ✅ | 看屏幕（截图）。只读，关掉 AI 就无法感知界面 |
| `computerUseMouse` | ❌ | 操作鼠标（移动/点击/滚轮） |
| `computerUseKeyboard` | ❌ | 操作键盘（按键/输入文本） |
| `computerUseWindows` | ❌ | 切换与调整窗口（置前/移动/缩放） |
| `computerUseUnattended` | ❌ | 允许后台无人值守操作（默认只在本窗口前台时能动） |

> computer use 只有「截图」默认开：其余四项都会**真实改变系统状态**，按能力粒度逐项放开，而不是一个总开关。
> 对应插件 `@dsh-desktop/computer-use`（`resources/dsh-plugins/computer-use`），实现见 [8.7](#87-computer-use-插件)。

- 真源：`src/main/shell-features.ts` 的 `SHELL_FEATURES` 数组；加开关只需加一条，老用户配置缺该键自动取默认
- 落盘：`%APPDATA%\DSH-Desktop\shell-features.json`
- 界面：插件 `@dsh-desktop/shell`（设置页 `settings.section`，order 91）
- 开关变化走 `applyFeatureChange()` 立即重应用，不必重启

### 8.6 补丁防护（防砖机）

> ⚠️ **补丁里 `insert` 的插件只要有一个解析不到，dsh 会整体起不来**（实测 `plugin tree failed to load`，exit=1）。

这个风险由热更新引入：热壳会带补丁（[8.3](#83-热壳必须自带补丁)），而插件走**另一条链路**下载，两者不同步就砖。

`src/main/patch-guard.ts` 在启动前把解析不到的 insert 行剔除，写一份 `desktop-patch.effective.yml` 再交给 dsh —— **宁可少一个插件，也不能起不来**。

---

### 8.7 computer use 插件

`resources/dsh-plugins/computer-use`（`@dsh-desktop/computer-use@1.0.0`）把 Windows 的截屏与合成输入暴露成 dsh 工具，让 AI 能直接看屏幕、点鼠标、敲键盘。

**零依赖**：不装 `sharp`/`robotjs`（都是原生模块，编译一次就要几分钟且要 VS 工具链），直接用 koffi 调 `user32`/`gdi32`/`kernel32`，PNG 也是自己用 `zlib` 拼的（`lib/png.js`）。

| 工具 | 做什么 | 需要开的开关 |
| --- | --- | --- |
| `screen_windows` | 列出可见窗口（标题/类名/进程/位置/是否最小化） | `computerUseScreenshot` |
| `screen_shot` | 截整个屏幕或指定窗口，**直接把图给模型看** | `computerUseScreenshot` |
| `screen_activate` | 把窗口切到前台 | `computerUseWindows` |
| `screen_resize` | 移动/缩放窗口 | `computerUseWindows` |
| `mouse_move` / `mouse_click` / `mouse_scroll` | 移动指针、点击、滚轮 | `computerUseMouse` |
| `key_press` / `key_type` | 按键（含组合键）、输入文本 | `computerUseKeyboard` |

**安全默认**：默认只开「看屏幕」（只读），其它四项默认关；`computerUseUnattended` 关着时，**只有本窗口在前台**才允许操作，你切走它就停下。

历史开关 `allowInput` 仍然兼容：`true` = 上面所有能力一次全开（老配置不用改）。

> 插件在 dsh 子进程里跑（`ELECTRON_RUN_AS_NODE=1`），那里 `require('electron')` 拿到的是**路径字符串**而不是 Electron API，所以截图不能走 `nativeImage` —— 这也是 `lib/png.js` 存在的原因。

---

### 8.8 Windows 沙箱：`workspace-write` 下命令全挂（`0xC0000142`）

**症状**：Windows + `workspace-write` 下，`pwsh` 工具**每一次**调用都以
`3221225794`（`0xC0000142`，`STATUS_DLL_INIT_FAILED`）结算，stdout/stderr 全空。
同参数换 `read-only` 正常，换 `danger-full-access` 也正常。前景/后台/换 workdir/
子智能体都一样 —— 看起来像「命令根本跑不起来」，很容易误判成 exe 或路径问题。

**根因**：`dsh-sandbox-windows-acl` 往令牌的**默认 DACL** 合并全权 ACE 时，两种模式传的
SID 不同：

| 模式 | 合并进默认 DACL 的 SID | 结果 |
| --- | --- | --- |
| `read-only` | `world`（Everyone） | ✅ 正常 |
| `workspace-write` | 能力 SID（`S-1-4-*`） | ❌ `0xC0000142` |

Windows 对写类访问做**两次**检查：先用令牌的**正常 SID 列表**（pass-1），再用 **restricting 列表**
（pass-2）。能力 SID **只在 restricting 列表里**，不在正常列表里 —— 于是 `workspace-write` 下
子进程启动时新建的无显式安全描述符对象（控制台、section、管道）只满足 pass-2，pass-1 无任何
SID 可匹配，对象不可用，进程在 DLL 初始化阶段就死。`read-only` 合并的是 Everyone（保活组成员，
在正常列表里），两次都过。

上游注释写的是「so each new object's own DACL passes **pass-2**」—— 精确命中了遗漏：
只考虑了 pass-2，漏了 pass-1。

**修法**：`src/main/acl-patch.ts` 在启动时给运行时**幂等打补丁** —— 在原有那次合并之后
再合并一次 `world`，补上 pass-1。四条路径都实测过：首次应用 / 重打不叠加 /
上游已自行修复则跳过 / 锚点失配则跳过。

**为什么这不削弱写边界**：默认 DACL 只作用于「本令牌新建的对象」，**对象创建本身**仍由父容器
DACL 把关。实测打完补丁：写工作区 ✅ / 写桌面 ❌ / 写 `C:\Windows` ❌ / 写 `D:\` 根 ❌。

---

### 8.9 打包：目录被降权导致 NSIS 失败（且**日志里什么都没有**）

**症状**：`npm run dist` 或发版脚本走到 NSIS 步骤失败，报

```
⨯ D:\...\dist\DSH-Desktop-Setup-<版本>.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
Exit code: 2      （或 null）
```

**stderr 是空的** —— electron-builder 的 `exec()` 什么都捕获不到，看起来毫无线索。

**真相**：中间 stub 弹了一个**模态框**，在等人点确定：

```
NSIS Error
Error writing temporary file. Make sure your temp folder is valid.
```

它卡在对话框上，直到 electron-builder 超时把进程杀掉（所以 exit code 是 `null`；
有人点了确定则是 `2`）。**这个框只有截图才看得到** —— 这就是它难查的原因。

**根因**：目录被打上**低完整性级别**：

```
icacls D:\code
        Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)
```

NSIS 启动时要在临时目录里反复创建/删除 `nsXXXX.tmp`，被完整性策略拦截。
本机来源是**火绒 HIPS** —— 它会给「存放可执行文件的目录」自动降权隔离，
而 `dist\` 里全是安装包 exe。

**修法**：

```powershell
# 查
icacls D:\code | Select-String 'Mandatory'
# 修（⚠️ 不要加 /T，见下）
icacls D:\code /setintegritylevel "(OI)(CI)H"
```

> **为什么不要加 `/T`**：`(OI)(CI)` 的继承会自动覆盖子项，加 `/T` 只是白遍历整棵树。
> 实测：对本仓库加 `/T` 会递归几万个文件，跑 448 秒并写出 **1.9 GB** 的备份文件
> （如果同时用了 `/save`）。这条是踩过的坑。

`scripts/release-v2.ps1` 的 **0/7 环境自检**已内置检查 + 自动修复：发现 `$root` 或 `dist\`
带 Low 标签就自动改回 High，改不动才报错中止。所以即使被重新打标签，脚本也会自己修好并
打印日志，不会再卡在那个无日志的弹窗上。

> **注意**：这不是一次性问题。安全软件会持续打标签 —— 如果反复出现，请在火绒里把工作目录
> 加进**信任目录/排除列表**，从源头解决。

---

## 9. 发版流程

### 9.1 一键发版

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-v2.ps1
```

九步：0 自检 → 1 w7 stable 构建 + 前向热壳 → 2 主线 stable 构建 + 前向壳 + 降级壳×2 →
3 主线 beta → 4 主线 dev → 4b/4c w7 beta/dev → 5 六份 feed → 6 暂存 + wrangler 部署 → 7 核验 + 归位。

常用开关：

| 开关 | 作用 |
| --- | --- |
| `-SkipPack` | 跳过全部构建，只重发 feed + 部署 |
| `-SkipW7` / `-SkipW7Beta` / `-SkipW7Dev` | 跳过对应 w7 构建 |
| `-SkipStable` / `-SkipBeta` / `-SkipDev` | 跳过对应主线构建 |
| `-SkipGen` | 跳过 feed 生成 |
| `-SkipWrangler` | 只本地暂存，不上传 |
| `-SkipNightly` | 跳过 nightly（要从 harness `master` 源码编译，很慢） |
| `-UpgradeDiffSources` | 运行时**升级**差分源（默认 `build\rt-015` → 0.1.5-rc.3），老用户靠它热更 |
| `-StableVersion` 等 | 指定各通道版本号 |
| `-SetupUrlStable` 等 | 安装包外链（挂进 feed 的 `files` 块） |
| `-Plugins` | 插件白名单（默认 `dshmarket, shell, updater`） |

### 9.2 推荐：两段式发版

大版本改动建议分两段，中间核对 feed：

推荐用薄封装 `scripts\release-017-020.ps1`（版本号、外链、release tag 一次性写死，免得手敲六个外链出错）：

```powershell
# ① 构建六个包 + 打热壳/差分 + 生成 feed + 暂存（不部署）
.\scripts\release-017-020.ps1 -Stage build

# ② 把 6 个安装包传到**本次的日期 release**（tag 由 scripts\release-tag.mjs 算出，如 2026.10.01-1）

# ③ 包传完后重新生成 feed（这次能算到本地包的 sha256/size）+ 部署
.\scripts\release-017-020.ps1 -Stage deploy
```

release tag 规则（`scripts/release-tag.mjs`）：`yyyy.MM.dd` + 当日序号，同日第二版就是 `2026.10.01-2`；非日期 tag 一律忽略。
只想跑部分通道：`-Only stable,w7`（**注意 `powershell -File` 不会按逗号拆参数**，脚本内部自己拆）。

### 9.3 发版后必须核验

```powershell
# 一条命令核验七份 feed 里**每一个 URL**（版本号 + 安装包 + 热壳 + 运行时差分切片 + 插件）
node scripts\verify-feeds.mjs

# 只看某几条通道
node scripts\verify-feeds.mjs --only latest,latest-w7
```

**别只看脚本输出**：版本号对不代表链接能下。真实翻车形态是「版本号对了，但某条链接 404」
（安装包忘了传、差分切片缺了 part03、热壳没打包）—— 这种错只有点到「更新」的用户才会遇到。
`verify-feeds.mjs` 把所有链接用 Range 各探 1 字节，任何一条不是 200/206 就退出码 1。

要确认：**版本号、hot 变体（含前向壳）、runtime 差分、plugins 数组**都对得上。

> ⚠️ **两个假信号**：
> - `*.deployed.json` **不等于「已部署」** —— `deploy-pages.mjs` 写它的代码在 `--stage-only` 时也会跑，只证明「已暂存」
> - `-SkipWrangler` 时脚本第 7 步的「线上核验」**是假的** —— 它在上传之前跑，拉的是旧线上内容

---

## 10. 排障

**日志**（排障首选）：

| 文件 | 内容 |
| --- | --- |
| `%APPDATA%\DSH-Desktop\logs\app.log` | 外壳自身日志 |
| `%APPDATA%\DSH-Desktop\logs\dsh-web.log` | Harness 子进程 stdout/stderr |

**常用位置**：

| 项 | 路径 |
| --- | --- |
| 安装目录 | `%LOCALAPPDATA%\Programs\DSH Desktop` |
| 用户数据 | `%APPDATA%\DSH-Desktop`（**连字符**，注意不是 `DSH Desktop`） |
| dsh 数据 | `%APPDATA%\DSH-Desktop\dsh-home` |
| 热更新壳 | `%APPDATA%\DSH-Desktop\hot\shell-<版本>-<时间戳>\` |

**常见问题**：

| 症状 | 原因与处理 |
| --- | --- |
| dsh 起不来，日志有 `plugin tree failed to load` | 补丁里的插件解析不到。已有 `patch-guard.ts` 自动剔除；若仍失败，检查 `desktop-patch.effective.yml` |
| 启动卡在「timed out waiting for the writer lock」 | 上次被强杀留了 `profiles/*.lock`。外壳会自动清理；手动可删 `dsh-home/profiles/*.lock` |
| 设置页少了某一节 | 插件没落位。检查 `dsh-home/profiles/node_modules/<包名>` 是否存在 |
| 外壳版本升了但功能没变 | 热壳换了但补丁没跟上。检查热壳目录里有没有 `desktop-patch.yml` |
| 装到一半报「无法调用系统 tar」 | **Win7 上不该再出现**（7.1.9 起解压器自带纯 JS 兜底）。若仍出现，说明包里的 `resources\extract-runtime.cjs` 是旧版 —— 见 [8.4](#84-win7-支持) |
| 更新一直提示但版本不变 | feed 里缺**前向热壳**（`base` 高于当前安装版，`pickHot` 挑不到） |
| 命令执行弹控制台窗口 | 见 `win-console.ts`：外壳启动前分配隐藏控制台，沙箱子进程继承它 |
| `git push` 报 `SSL_ERROR_SYSCALL` / `Failed to connect to github.com port 443: Timed out` | 多数是**网络抖动**（实测：同一时段 `api.github.com` 200、`uploads.github.com` 302，只有 `github.com` 超时；过一阵自己就好了）。先探测再重试：`curl -sS -o NUL -w '%{http_code}' https://github.com`。也可试 `git -c http.version=HTTP/1.1 push origin main`（有一次网络较差时它成功了，但不是根治）。**注意**：`gh` 走 `api.github.com`，所以 release 与资产上传不受影响 —— 只有源码推送会卡 |。加 `-c http.version=HTTP/1.1` 即可，实测一次成功：`git -c http.version=HTTP/1.1 push origin main` |
| Windows 沙箱下 `pwsh` 工具每次调用都以 `0xC0000142` 结算、无任何输出 | 令牌默认 DACL 只挂了 restricting 列表里的能力 SID，缺正常 SID 列表的主体（pass-1 不过）。已由 `acl-patch.ts` 在启动时幂等修复；见 [8.8](#88-windows-沙箱workspace-write-下命令全挂0xc0000142) |
| **打包到 NSIS 步骤失败，`exit 2` 或 `exit null`，日志里什么都没有** | 目录被打上**低完整性级别**（`Mandatory Label\Low`）。NSIS 要在临时目录反复建删 `nsXXXX.tmp`，被拦截后弹模态框 `NSIS Error: Error writing temporary file`，卡住直到 electron-builder 超时杀进程 —— 所以日志是空的。本机来源是**火绒 HIPS**（给「存放可执行文件的目录」自动降权）。修：`icacls <目录> /setintegritylevel "(OI)(CI)H"`（**不要加 `/T`**，见 [8.8](#88-windows-沙箱workspace-write-下命令全挂0xc0000142)）。`release-v2.ps1` 的 0/7 自检已会自动检查并修复 |

**手动复现 dsh 启动**（绕过外壳）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
$env:DSH_HOME="$env:TEMP\dsh-test"
node_modules\electron\dist\electron.exe --expose-internals `
  resources\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js `
  --profile web --patch resources\desktop-patch.yml --no-open --port 0
# 成功输出：dsh web: http://127.0.0.1:<port>/?token=...
```

---

## 11. 已知限制

- 仅 **x64**（Electron 44 已移除 32 位构建）
- **未做代码签名**，SmartScreen 首次运行可能提示
- Harness 处于 developer preview：升级 dsh 版本需改根 `package.json` 的 `config.dshVersion` 后重跑 `npm run prepare:runtime -- --force`
- Win7 线依赖社区 fork 的 Electron，指纹补丁需在 fork 更新后重新验证
- Win7 没有系统 `tar.exe`，解压走内置**纯 JS 单线程**（实测 26617 文件 / 474 MB 约 12.5 s，比 Win10 的多进程并行慢，但可用）；见 [8.4](#84-win7-支持)
- 安装包分发依赖 GitHub Release（Pages 单文件上限 25 MiB 放不下）

---

## 12. 贡献者

**作者与维护者**：[XRC111](https://github.com/XRC111)

开发过程中使用了以下 AI 模型（按字母序，用于代码编写、排障与文档撰写）：

| 模型 | 提供方 |
| --- | --- |
| [DeepSeek](https://github.com/deepseek-ai) | DeepSeek |
| [GLM](https://github.com/zai-org) | Z.ai（智谱） |
| [Hunyuan](https://github.com/Tencent-Hunyuan) | 腾讯 |
| [Kimi](https://github.com/MoonshotAI) | Moonshot AI（月之暗面） |

> 上表是**开发期间使用的模型/工具**，不是代码贡献者；项目的设计决策、实现取舍与最终质量由维护者负责。
