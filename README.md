<div align="center">

# DSH Desktop

**把 DeepSeek Harness 封装成开箱即用的 Windows 桌面应用**

双击安装包即用，用户机器**不需要 Node.js / npm / pnpm 或任何运行时**。

[![Release](https://img.shields.io/github/v/release/XRC111/dsh-desktop?label=Release&style=flat-square)](https://github.com/XRC111/dsh-desktop/releases/)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20%7C%207-0078D4?style=flat-square)](#系统要求)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square)](#)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)

</div>

---

## 简介

[DeepSeek Harness](https://github.com/deepseek-ai)（dsh）是一个能力很强、但需要命令行和 Node 环境的 AI 编程代理。**DSH Desktop 不修改 Harness 一行源码**，只做一层桌面外壳：

- 启动 `dsh web` 子进程，用 Electron 加载它自带的 Web UI
- 内嵌 Git、Python 与完整运行时，装完即用
- 在外壳层补齐托盘、自绘标题栏、插件市场、热更新等桌面能力

与姊妹项目 [dsh-mobile](https://github.com/XRC111/dsh-mobile)（Android 版）遵循同一套设计铁律。

> **项目定位**：非官方社区封装，与 DeepSeek 官方无隶属关系。

## 目录

- [功能特性](#功能特性)
- [下载与安装](#下载与安装)
- [使用](#使用)
- [架构设计](#架构设计)
- [更新体系](#更新体系)
- [从源码构建](#从源码构建)
- [发版流程](#发版流程)
- [排障指南](#排障指南)
- [已知限制](#已知限制)
- [相关项目](#相关项目)
- [License](#license)

---

## 功能特性

### 核心能力

| 能力 | 说明 |
| --- | --- |
| **零依赖安装** | 内嵌完整 dsh 运行时（Node 走 Electron 内置）、Git、Python，双击 `Setup.exe` 即用 |
| **原生 Web UI** | 直接加载 dsh 自带的 Web 界面，不是套壳网页，功能与官方版本一致 |
| **热更新** | 外壳逻辑改动只需下载约 350 KB 热更包，重启即生效 |
| **多通道发版** | stable / beta / dev / nightly 四条更新通道，应用内一键切换 |
| **Windows 7 支持** | 独立 7.x 版本线，社区 fork Electron + 宿主指纹补丁 |

### 桌面增强

| 功能 | 说明 |
| --- | --- |
| **自绘标题栏** | 无边框窗口 + 40px 自定义顶条，可在设置中恢复系统标题栏 |
| **系统托盘** | 最小化到托盘、常驻通知、快捷操作菜单 |
| **目录选择器** | 支持 Windows 盘符浏览（`C:\`、`D:\` 一键切换），不再困在用户目录 |
| **Computer Use** | 内置 `@dsh-desktop/computer-use`，模型可截屏、操作鼠标键盘（需显式授权） |
| **技能与 MCP 管理** | 图形界面管理 Skills 与 MCP 服务器，无需手写 YAML |
| **插件市场** | 内置 dsh-market，设置页直接浏览安装社区插件 |
| **远程联动** | 与 dsh-mobile 配对后，手机可操作桌面、桌面可操作手机 |

### 安全设计

- 渲染进程 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- preload 只暴露窄 IPC 接口，不直接开放 Node API
- Web UI 必须带 token 访问，地址从 stdout 动态解析（不硬编码端口）
- 补丁防护（patch-guard）自动剔除解析不到的插件，防止"砖机"
- 默认不自动重启、不自动下载，更新时机由用户决定

---

## 下载与安装

从 [Releases](https://github.com/XRC111/dsh-desktop/releases) 下载安装包。Release tag 为日期+序号（如 `2026.10.01-1`）。

| 安装包 | 通道 | 适用系统 | 说明 |
| --- | --- | --- | --- |
| `DSH-Desktop-Setup-10.1.x.exe` | stable | Windows 10 / 11 | **推荐大多数用户** |
| `DSH-Desktop-Setup-10.2.x.exe` | beta | Windows 10 / 11 | 尝鲜 0.2.0 线功能 |
| `DSH-Desktop-Setup-10.3.x.exe` | dev | Windows 10 / 11 | 跟随 dev 最新开发版 |
| `DSH-Desktop-Setup-7.1.x.exe` | stable | **Windows 7** | Win7 必须用 7.x |
| `DSH-Desktop-Setup-7.2.x.exe` | beta | Windows 7 | Win7 + beta |
| `DSH-Desktop-Setup-7.3.x.exe` | dev | Windows 7 | Win7 + dev |

> **Windows 7 用户注意**：主线安装包内嵌官方 Electron 44，在 Win7 上无法启动，必须下载 7.x 版本。

安装完成后应用会自动接管后续更新（默认 stable 通道）。

### 首次使用

1. 双击安装包，选择安装目录（默认 `%LOCALAPPDATA%\Programs\DSH Desktop`）
2. 首次启动会解压内置运行时（仅一次，数秒到十几秒）
3. 就绪后自动进入 dsh Web UI
4. 设置页可切换更新通道、管理插件/MCP/技能、调整桌面适配选项

### 系统要求

- Windows 10 / 11（x64）；Windows 7 请使用 7.x 版本线
- 安装包约 240 MB（含完整运行时、Git、Python），建议预留 1 GB 磁盘空间
- 不支持 32 位系统（Electron 44 已移除 32 位构建）

---

## 使用

### 托盘菜单

右键托盘图标可查看状态、暂停代理、打开日志、设置开机自启或退出。

### 设置页

| 分组 | 可调项 |
| --- | --- |
| 更新 | 通道切换、检查间隔、自动下载/重启 |
| 插件与技能 | 插件市场、MCP 服务器、Skills 管理 |
| 桌面适配 | 外链打开方式、拖放附件、托盘状态、任务通知、无边框窗口 |

桌面适配开关保存在用户数据目录的 `shell-features.json`。

### 目录选择器

dsh 默认选择器在 Windows 上无法切盘符。外壳内置 `@dsh-desktop/directory-picker`，把 `C:\`、`D:\` 等盘符根作为条目返回，界面仍复用 dsh 自带 browse UI。

---

## 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron 主进程                               │
│                                                                 │
│  index.ts ──引导──▶ boot.ts ──┬─ WindowManager（窗口/标题栏）     │
│    · 单实例锁                  ├─ TrayManager（系统托盘）          │
│    · 选壳（内置 / 热更新）      ├─ Updater（多通道 feed 更新）     │
│    · 崩溃恢复                  ├─ DshService ──▶ dsh web 子进程   │
│                                ├─ PatchGuard（补丁防护）          │
│                                ├─ SkillMcp（技能/MCP 管理）       │
│                                └─ PluginInstaller（插件落位）     │
├─────────────────────────────────────────────────────────────────┤
│                      渲染进程（BaseWindow）                      │
│                                                                 │
│  ├─ titleBarView   40px 自绘标题栏（可关）                        │
│  └─ contentView    dsh Web UI（IPC 桥 + 注入脚本挂这里）           │
└─────────────────────────────────────────────────────────────────┘
                          │ spawn（ELECTRON_RUN_AS_NODE=1）
                          ▼
              dsh web  ──▶  http://127.0.0.1:<port>/?token=…
```

### 核心设计原则

| 原则 | 实现方式 |
| --- | --- |
| **不修改 Harness 源码** | 只启动 `dsh web`、加载其 Web UI、管理生命周期 |
| **不额外分发 Node** | 用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`） |
| **必带 `--expose-internals`** | web profile 的模块解析拦截层需要访问 Node 内部模块 |
| **从 stdout 解析地址** | 解析 `dsh web: http://127.0.0.1:<port>/?token=<token>` |
| **杀进程树用 `taskkill /T /F`** | 避免留下孤儿 dsh 进程 |
| **安全默认值** | contextIsolation / sandbox / 窄 IPC |
| **重启时机由用户决定** | 热更落位后下次启动生效 |

### 目录结构

```
dsh-desktop/
├── src/
│   ├── main/          # Electron 主进程（boot / dsh-service / updater / patch-guard …）
│   ├── preload/       # 窄 IPC 桥
│   └── renderer/      # 注入脚本
├── resources/
│   ├── desktop-patch.yml     # 桌面适配补丁（核心）
│   ├── update-config.json    # 更新源配置
│   ├── dsh-plugins/          # 内置插件（skill-mcp / dshmarket）
│   └── tools/                # 内置 Git / Python
├── scripts/           # 构建、打包、发版脚本
├── build/             # 图标与安装包配置
└── docs/
```

---

## 更新体系

### 通道

版本号规则：**major.minor = 通道，patch = 通道内迭代**。

| 通道 | 主线 | Win7 | Feed |
| --- | --- | --- | --- |
| stable | 10.1.x | 7.1.x | `latest.json` / `latest-w7.json` |
| beta | 10.2.x | 7.2.x | `latest-beta.json` / `latest-w7-beta.json` |
| dev | 10.3.x | 7.3.x | `latest-dev.json` / `latest-w7-dev.json` |
| nightly | — | — | `latest-nightly.json` |

主线版本号永远高于 Win7 线，避免互相误判；未知通道值回落 stable。

### 更新载荷

| 载荷 | 体积 | 生效方式 | 用途 |
| --- | --- | --- | --- |
| 热更新壳 | ~350 KB | 重启即生效 | 外壳逻辑/界面/补丁 |
| 运行时差分 | 3–15 MB | 启动前套用 | dsh 本体跟进 |
| 插件包 | 1–2 MB | 重启后落位 | 新增/升级插件 |
| 完整安装包 | ~160–240 MB | 覆盖安装 | Electron 升级/跨大版本 |

热更包分**前向壳**与**降级壳**两种变体：前者让旧版用户升级，后者让 beta/dev 用户切回 stable。运行时差分以**精确基线**匹配，支持升级链与降级链。

### 更新源配置

`resources/update-config.json`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `feedUrl` | — | 云端 JSON 地址（HTTPS） |
| `checkOnStartup` | true | 启动后检查一次 |
| `checkIntervalHours` | 6 | 后台轮询间隔 |
| `autoDownload` | false | 自动下载（不自动重启） |
| `autoRestart` | false | 更新就绪后自动重启 |

联调用环境变量：`DSH_DESKTOP_UPDATE_URL` / `DSH_DESKTOP_UPDATE_AUTO` / `DSH_DESKTOP_UPDATE_DRYRUN`。

---

## 从源码构建

### 环境要求

| 需要 | 版本 |
| --- | --- |
| OS | Windows（构建 Win32 包） |
| Node.js | 22+ |
| PowerShell | 构建脚本使用 |

### 构建

```powershell
git clone https://github.com/XRC111/dsh-desktop.git
cd dsh-desktop
npm install
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

产物：`dist\DSH-Desktop-Setup-<version>.exe`

分步构建：

```powershell
npm run build            # 编译 TypeScript + 拷贝静态资源
npm run prepare:tools    # 准备内置 Git/Python
npm run pack:runtime     # 打包 dsh 运行时
npm run gen:manifest     # 生成运行时 manifest
npm run pack             # 免安装目录（最快验证）
npm run dist             # NSIS 安装包
npm start                # 开发调试（直接启动 Electron）
```

升级内嵌 dsh 版本：修改 `package.json` 的 `config.dshVersion` → `npm run prepare:runtime -- --force` → 重新打包。

---

## 发版流程

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-v2.ps1
```

自动完成：自检 → Win7 stable → 主线 stable（前向壳+降级壳）→ beta → dev → Win7 beta/dev → 生成六份 feed → 部署 → 核验。

常用参数：`-SkipPack`（只重发 feed）、`-Only stable,w7`、`-SkipWrangler`（只本地暂存）、`-SkipNightly`。

发版后核验：

```powershell
node scripts\verify-feeds.mjs
```

> 注意两个假信号：`*.deployed.json` 不代表已部署；`-SkipWrangler` 时的"线上核验"拉的是旧内容。

---

## 排障指南

### 日志与关键路径

| 项 | 路径 |
| --- | --- |
| 外壳日志 | `%APPDATA%\DSH-Desktop\logs\app.log` |
| dsh 日志 | `%APPDATA%\DSH-Desktop\logs\dsh-web.log` |
| 安装目录 | `%LOCALAPPDATA%\Programs\DSH Desktop` |
| 用户数据 | `%APPDATA%\DSH-Desktop`（连字符） |
| dsh 数据 | `%APPDATA%\DSH-Desktop\dsh-home` |
| 热更新壳 | `%APPDATA%\DSH-Desktop\hot\shell-<版本>-<时间戳>\` |

### 常见问题

| 症状 | 处理 |
| --- | --- |
| `plugin tree failed to load` | patch-guard 会自动剔除；仍失败看 `desktop-patch.effective.yml` |
| 卡在 `timed out waiting for the writer lock` | 删除 `dsh-home/profiles/*.lock` |
| 设置页少一节 | 插件未落位，检查 `dsh-home/profiles/node_modules/<包名>` |
| 外壳升级但功能没变 | 热壳换了但补丁没跟上，检查热壳目录里的 `desktop-patch.yml` |
| 命令执行弹控制台 | `win-console.ts` 应预先分配隐藏控制台，检查安全软件拦截 |
| 沙箱命令 `0xC0000142` | ACL 令牌问题，`acl-patch.ts` 应自动修复 |
| MCP 添加后不生效 | 检查 `mcp-servers.json` 格式并重启 |

手动复现 dsh 启动（绕过外壳）：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = "$env:TEMP\dsh-test"
node_modules\electron\dist\electron.exe --expose-internals `
  resources\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js `
  --profile web --patch resources\desktop-patch.yml --no-open --port 0
```

---

## 已知限制

- 仅支持 **x64**；未做代码签名，SmartScreen 首次运行会提示未知发布者
- dsh 处于 developer preview 阶段，升级需改 `config.dshVersion` 后重新构建
- Win7 线依赖社区 fork 的 Electron，上游更新后需重新验证指纹补丁
- 安装包体积较大（含完整运行时、Git、Python）

## 相关项目

- [dsh-mobile](https://github.com/XRC111/dsh-mobile) — Android 原生移植，与桌面端可互相远程操作

## 贡献

Issue / PR 均欢迎。提交前请说明复现步骤与系统版本；涉及热更新与补丁机制的改动，请附 `dsh --dump-config` 的对比结果。

## License

MIT（见 [LICENSE](./LICENSE)）

## 致谢

上游项目：[DeepSeek Harness](https://github.com/deepseek-ai)、[Electron](https://www.electronjs.org/) 及社区 Electron Win7 fork 维护者。

开发过程中使用了 DeepSeek、Z.ai、腾讯、Moonshot、字节跳动、OpenAI、小米、阿里等厂商的模型辅助编码与排障；模型是工具，设计取舍与最终质量由维护者负责。
