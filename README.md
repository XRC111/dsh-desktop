<div align="center">

# DSH Desktop

**把 [DeepSeek Harness](https://github.com/deepseek-ai) 封装成开箱即用的 Windows 桌面应用**

双击安装包即用，用户机器**不需要安装 Node.js / npm / pnpm 或任何运行时**。

[![Release](https://img.shields.io/github/v/release/XRC111/dsh-desktop?label=Release&style=flat-square)](https://github.com/XRC111/dsh-desktop/releases/)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](./LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20%7C%207-0078D4?style=flat-square)](#)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?style=flat-square)](#)

</div>

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [架构设计](#架构设计)
- [目录结构](#目录结构)
- [更新体系](#更新体系)
- [桌面适配](#桌面适配)
- [从源码构建](#从源码构建)
- [发版流程](#发版流程)
- [排障指南](#排障指南)
- [已知限制](#已知限制)
- [致谢](#致谢)
- [License](#license)

---

## 功能特性

### 核心能力

- **零依赖安装** — 内嵌完整 dsh 运行时（Node 走 Electron 内置）、Git、Python，双击 Setup.exe 即用
- **原生 Web UI** — 直接加载 dsh 自带的 Web 界面，不是套壳网页，功能与官方版本完全一致
- **热更新体系** — 外壳逻辑改动只需下载几百 KB 的热更包，重启即生效，无需重新安装
- **多通道发版** — stable / beta / dev / nightly 四条更新通道，应用内一键切换
- **Windows 7 支持** — 独立的 7.x 版本线，社区 fork Electron + 宿主指纹补丁

### 桌面增强

| 功能 | 说明 |
|---|---|
| **自绘标题栏** | 无边框窗口 + 40px 自定义顶条，可在设置中关闭恢复系统标题栏 |
| **系统托盘** | 最小化到托盘、常驻通知、快捷操作菜单 |
| **目录选择器** | 自研 host 端支持 Windows 盘符浏览（C:\、D:\ 一键切换），不再困在用户目录 |
| **Computer Use** | 内置 `@dsh-desktop/computer-use`，模型可截屏、操作鼠标键盘（需显式授权） |
| **技能与 MCP 管理** | 图形界面管理 Skills 和 MCP 服务器，无需手写 YAML/frontmatter |
| **桌面适配开关** | 外链打开方式、拖放附件、托盘状态、任务通知等均可独立开关 |
| **插件市场** | 内置 dsh-market，设置页直接浏览安装社区插件 |
| **远程联动** | 与 dsh-mobile 配对后，手机可操作桌面、桌面可操作手机 |

### 安全设计

- 渲染进程 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`
- preload 只暴露窄 IPC 接口，不直接开放 Node API
- dsh Web UI 必须带 token 访问，地址从 stdout 动态解析（不硬编码端口）
- 补丁防护（patch-guard）自动剔除解析不到的插件，防止"砖机"
- 默认不自动重启、不自动下载，更新时机由用户决定

---

## 快速开始

### 安装（最终用户）

从 [GitHub Releases](https://github.com/XRC111/dsh-desktop/releases) 下载对应安装包。安装包以日期+序号为 tag（如 `2026.10.01-1`）。

| 安装包 | 通道 | 适用系统 | 说明 |
|---|---|---|---|
| `DSH-Desktop-Setup-10.1.x.exe` | stable | Windows 10 / 11 | **推荐大多数用户** |
| `DSH-Desktop-Setup-10.2.x.exe` | beta | Windows 10 / 11 | 尝鲜 0.2.0 线功能 |
| `DSH-Desktop-Setup-10.3.x.exe` | dev | Windows 10 / 11 | 跟 dev 最新开发版 |
| `DSH-Desktop-Setup-7.1.x.exe` | stable | **Windows 7** | Win7 必须用 7.x |
| `DSH-Desktop-Setup-7.2.x.exe` | beta | Windows 7 | Win7 + beta |
| `DSH-Desktop-Setup-7.3.x.exe` | dev | Windows 7 | Win7 + dev |

> **Windows 7 用户注意**：主线安装包内嵌官方 Electron 44，在 Win7 上无法启动。必须下载 7.x 版本（使用社区 fork 的 Electron 并打了宿主指纹补丁，详见 [Win7 支持](#win7-支持)）。

安装完成后应用会自动接管后续更新（默认 stable 通道）。

### 首次使用

1. 双击安装包，选择安装目录（可选，默认 `%LOCALAPPDATA%\Programs\DSH Desktop`）
2. 首次启动会解压内置运行时（仅一次，约几秒到十几秒）
3. 就绪后自动进入 dsh Web UI
4. 设置页可切换更新通道、管理插件/MCP/技能、调整桌面适配选项

---

## 架构设计

### 整体架构

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
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
                          │
                          │ spawn（ELECTRON_RUN_AS_NODE=1）
                          ▼
              dsh web  ──▶  http://127.0.0.1:<port>/?token=…
```

### 核心设计原则

这几条是硬约束，解释了代码为什么长这样：

| 原则 | 实现方式 |
|---|---|
| **不修改 Harness 源码** | 纯外壳：只启动 `dsh web`、加载其 Web UI、管理生命周期。不 fork、不 patch dsh 本身 |
| **不额外分发 Node 运行时** | 用 Electron 内置 Node（`ELECTRON_RUN_AS_NODE=1`）跑 dsh，不额外打包 `node.exe` |
| **必带 `--expose-internals`** | web profile 的模块解析拦截层需要它访问 Node 内部模块；缺了 dsh 会启动失败 |
| **从 stdout 解析服务地址** | 解析 `dsh web: http://127.0.0.1:<port>/?token=<token>`，不硬编码端口 |
| **杀进程树用 `taskkill /T /F`** | `ChildProcess.kill()` 只杀直接子进程，会留下孤儿 dsh 进程 |
| **安全默认值** | contextIsolation / sandbox / 窄 IPC，渲染进程不直接接触 Node |
| **重启时机由用户决定** | 默认绝不自动重启，热更落位后下次启动自动生效 |

### 热更新边界

热更新只替换 `out/` 目录（main + preload + renderer，约 350 KB），**不包含 `resources/`**。这意味着：

- 外壳逻辑、界面、补丁改动 → 热更新即可
- 新增内置插件 → 需要走插件热更通道单独下发
- Electron 版本升级 / 跨大版本 → 必须下载完整安装包

---

## 目录结构

```
dsh-desktop/
├── src/
│   ├── main/                    # Electron 主进程
│   │   ├── index.ts             # 应用入口
│   │   ├── boot.ts              # 启动编排（核心引导流程）
│   │   ├── dsh-service.ts       # dsh 子进程管理
│   │   ├── updater.ts           # 更新检查/下载/应用
│   │   ├── hot-shell.ts         # 热更新壳加载
│   │   ├── patch-guard.ts       # 补丁防护（防砖机）
│   │   ├── skill-mcp.ts         # 技能与 MCP 服务器管理
│   │   ├── window-manager.ts    # 窗口管理
│   │   ├── tray-manager.ts      # 托盘管理
│   │   ├── plugin-installer.ts  # 插件安装落位
│   │   ├── plugin-compat.ts     # 插件版本兼容层
│   │   ├── recovery.ts          # 崩溃恢复
│   │   ├── paths.ts             # 路径定义
│   │   ├── logger.ts            # 日志
│   │   ├── win-console.ts       # Windows 隐藏控制台
│   │   ├── acl-patch.ts         # ACL 令牌补丁
│   │   └── ...
│   ├── preload/
│   │   └── index.ts             # preload 桥（窄 IPC 接口）
│   └── renderer/                # 渲染进程（注入脚本等）
│
├── resources/
│   ├── desktop-patch.yml        # 桌面适配补丁（核心）
│   ├── update-config.json       # 更新源配置
│   ├── dsh-plugins/             # 内置 dsh 插件
│   │   ├── skill-mcp/           # 技能/MCP 管理面板
│   │   └── dshmarket/           # 插件市场
│   ├── tools/                   # 内置 Git / Python
│   └── ...
│
├── scripts/                     # 构建/打包/发版脚本
├── build/                       # 构建资源（图标、安装包配置）
├── docs/                        # 文档
└── package.json
```

---

## 更新体系

### 更新通道

版本号编码规则：**major. minor = 通道，patch = 通道内迭代**。

| 通道 | 主线版本 | Win7 版本 | Feed 文件 | 说明 |
|---|---|---|---|---|
| **stable** | 10.1.x | 7.1.x | `latest.json` / `latest-w7.json` | 稳定版，默认通道 |
| **beta** | 10.2.x | 7.2.x | `latest-beta.json` / `latest-w7-beta.json` | 测试版 |
| **dev** | 10.3.x | 7.3.x | `latest-dev.json` / `latest-w7-dev.json` | 开发版 |
| **nightly** | — | — | `latest-nightly.json` | 每日从 dsh master 源码编译 |

设计要点：
- 主线版本号（10.x）永远高于 Win7（7.x），避免互相误判
- Win7 客户端的 feed URL 固定在 w7 三份 feed 内轮换，不会碰到主线 feed
- 未知通道值一律回落 stable

### 三种更新载荷

| 载荷 | 体积 | 生效方式 | 用途 |
|---|---|---|---|
| **热更新壳（hot）** | ~350 KB | 重启进程即生效 | 外壳逻辑/界面/补丁改动 |
| **运行时差分（runtime）** | 3–15 MB | 重启时 dsh 启动前套用 | dsh 本体版本跟进 |
| **插件包（plugins）** | ~1–2 MB | 重启后自动落位 | 新增/升级功能插件 |
| 完整安装包 | ~160 MB | 覆盖安装 | Electron 升级/跨大版本 |

### 热更新机制

热更新包的 `baseVersion` 表示**最低支持的已安装版本**（不是必须精确等于）。客户端在满足基线的包中选择版本最高的一个。

热更包有两种变体，缺一不可：

| 变体 | baseVersion | 作用 |
|---|---|---|
| **前向壳** | `hotMinBaseVersion`（当前 1.1.1） | 让旧版用户热更到最新 |
| **降级壳** | beta/dev 的版本号 | 让从 beta/dev 切回 stable 的用户整体滚回 |

> 只有前向壳 → beta/dev 用户切回 stable 时壳版本回不去；只有降级壳 → 老用户拿不到热更，只能下完整安装包。

### 运行时差分

运行时补丁的 `baseVersion` 是**精确基线**（补丁只含差异文件，不是完整副本）。客户端：

1. 找到 `baseVersion` 与当前运行时版本完全一致的补丁
2. 重启时、dsh 启动之前套用
3. 下次检查再从新基线继续找下一档（支持升级链和降级链）

### 更新源配置

`resources/update-config.json` 关键字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `feedUrl` | — | 云端 JSON 地址，必须 HTTPS |
| `checkOnStartup` | true | 启动后自动检查一次 |
| `checkIntervalHours` | 6 | 后台轮询间隔 |
| `autoDownload` | false | 有更新自动下载（但不自动重启） |
| `autoRestart` | false | 更新就绪后自动重启（**默认关闭**） |

环境变量覆盖（联调用）：

```powershell
$env:DSH_DESKTOP_UPDATE_URL = 'http://127.0.0.1:8899/latest.json'
$env:DSH_DESKTOP_UPDATE_AUTO = '1'      # 自动下载
$env:DSH_DESKTOP_UPDATE_DRYRUN = '1'    # 只校验不安装
```

### 下载加速

- 多个镜像源竞速探测（Range 请求 1 字节，8 秒超时）
- 镜像下载失败自动回退原始地址
- 安装包通过 GitHub Release 分发，feed 中可挂代理前缀

---

## 桌面适配

### 组合层补丁机制

**不修改 dsh 源码**，利用 dsh 自带的补丁层机制调整插件组合。补丁加载顺序：

```
profile 根 → package.json bundles 各层 → cordis.patch.yml → --patch 覆盖层（我们的补丁）
```

越靠后的层优先级越高，按 id 定向覆盖，最后写入者生效。

两种操作：

```yaml
# ① 定向覆盖/禁用已有行（按 id 定位）
- id: hmr
  disabled: true

# ② 插入新插件
- insert:
    - id: my-plugin
      name: '@scope/my-plugin'
      config:
        key: value
```

验证补丁效果：

```powershell
dsh --profile web --patch desktop-patch.yml --dump-config
# 输出中每行标注 "# patched by <补丁路径>"
```

### 补丁防护（Patch Guard）

**问题**：补丁里 insert 的插件只要有一个解析不到，dsh 加载器直接报错退出（`plugin tree failed to load`），应用永远起不来。热更新带入的补丁和插件包下载不同步时最容易触发。

**做法**：启动前扫描补丁，把解析不到的 insert 行自动剔除，其余原样保留，生成"实际生效补丁"再交给 dsh。宁可少一个插件，也不能起不来。

### 目录选择器

dsh 默认的目录选择器在 Windows 上有两个问题：
- 解析成 native 后端会弹 Win32 COM 对话框，风格割裂
- browse 后端只能列目录，无法切换盘符（用户困在 `C:\Users\...`，没法到 D:\）

自研 `@dsh-desktop/directory-picker`：在 browse 能力上把 Windows 盘符根（C:\、D:\…）作为条目返回，前端点一下即可切盘。界面仍用 dsh 自带的 browse UI，不需要新的 wire API。

### Win7 支持

主线 Electron 44 不支持 Windows 7。7.x 版本线的特殊处理：

- 使用社区 fork 的 Electron（保持 API 兼容）
- 打宿主指纹补丁（dsh 按 V8 指纹校验 Electron 版本，fork 的指纹不在白名单）
- Win7 没有系统 `tar.exe`，解压器内置纯 JS 单线程兜底（26000+ 文件约 12 秒，比 Win10 多进程慢但可用）
- 独立的 feed 文件，与主线互不干扰

### Computer Use

内置 `@dsh-desktop/computer-use` 插件，给模型一组操作本机桌面的工具：

| 工具 | 能力 | 默认 |
|---|---|---|
| `screen_windows` | 列出窗口 | 启用（只读） |
| `screen_shot` | 截屏 | 启用（只读） |
| `screen_activate` | 激活/切换窗口 | 不注册 |
| `screen_resize` | 调整窗口大小 | 不注册 |
| `mouse_*` | 鼠标移动/点击/拖拽 | 不注册 |
| `key_*` | 键盘输入 | 不注册 |

鼠标键盘操作需要在补丁 config 中显式设置 `allowInput: true`。

### Windows 沙箱适配

Windows 上 `workspace-write` 模式的 ACL 受限令牌有两个已修复的问题：

1. **控制台弹窗**：受限令牌下不能用 `CREATE_NO_WINDOW`，沙箱子进程会弹控制台窗口。修复：外壳启动前分配并隐藏一个控制台，子进程继承它（`win-console.ts`）
2. **进程启动失败（0xC0000142）**：令牌默认 DACL 缺少正常 SID 列表。修复：`acl-patch.ts` 在启动时幂等修复

### 桌面适配开关

以下功能均可在设置中独立开关，配置存在用户数据目录的 `shell-features.json`：

- 外部链接打开方式
- 拖放附件
- 托盘图标/状态
- 任务通知
- 无边框窗口/自绘标题栏

---

## 从源码构建

### 环境要求

| 需要 | 版本/说明 |
|---|---|
| OS | Windows（构建 Win32 包） |
| Node.js | 22+ |
| npm | 随 Node 安装 |
| PowerShell | 构建脚本用 |

### 快速构建

```powershell
git clone https://github.com/XRC111/dsh-desktop.git
cd dsh-desktop
npm install
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```

产物：`dist\DSH-Desktop-Setup-<version>.exe`

### 分步构建

```powershell
# 1. 编译 TypeScript + 拷贝静态资源
npm run build

# 2. 准备内置工具（Git/Python）
npm run prepare:tools

# 3. 打包 dsh 运行时
npm run pack:runtime

# 4. 生成运行时 manifest
npm run gen:manifest

# 5. 打包免安装目录（最快验证）
npm run pack

# 6. 打 NSIS 安装包（完整发布）
npm run dist
```

### 开发调试

```powershell
# 编译并直接启动 Electron（不打包）
npm start
```

### 运行时版本管理

内嵌 dsh 版本在 `package.json` 的 `config.dshVersion` 中定义。升级 dsh 版本：

1. 修改 `config.dshVersion`
2. 运行 `npm run prepare:runtime -- --force`
3. 重新打包

---

## 发版流程

### 一键发版

```powershell
powershell -ExecutionPolicy Bypass -File scripts\release-v2.ps1
```

自动化九步：自检 → Win7 stable 构建 → 主线 stable（前向壳+降级壳）→ beta → dev → Win7 beta/dev → 生成六份 feed → 暂存部署 → 核验归位。

常用参数：

| 参数 | 作用 |
|---|---|
| `-SkipPack` | 跳过全部构建，只重发 feed |
| `-SkipW7` / `-SkipStable` / `-SkipBeta` / `-SkipDev` | 跳过对应通道构建 |
| `-SkipGen` | 跳过 feed 生成 |
| `-SkipWrangler` | 只本地暂存，不上传部署 |
| `-SkipNightly` | 跳过 nightly 编译（很慢） |
| `-Only stable,w7` | 只跑指定通道 |
| `-Plugins` | 插件白名单（默认 `dshmarket, shell, updater`） |

### 推荐：两段式发版

大版本更新建议分两段，中间手动上传安装包：

```powershell
# ① 构建全部包 + 热壳/差分 + 生成 feed + 暂存（不部署）
.\scripts\release-017-020.ps1 -Stage build

# ② 手动把安装包传到本次日期 Release（tag 如 2026.10.01-1）

# ③ 重新生成 feed（计算本地包 sha256/size）+ 部署
.\scripts\release-017-020.ps1 -Stage deploy
```

Release tag 规则：`yyyy.MM.dd` + 当日序号（同日第二版为 `-2`）。

### 发版后核验

```powershell
# 核验所有 feed 中的每一个 URL（版本号/安装包/热壳/差分/插件）
node scripts\verify-feeds.mjs

# 只核验指定通道
node scripts\verify-feeds.mjs --only latest,latest-w7
```

所有链接用 Range 请求各探 1 字节，任何一条不是 200/206 就报错退出。

> **注意两个假信号**：
> - `*.deployed.json` 不代表已部署（`--stage-only` 时也会写）
> - `-SkipWrangler` 时的"线上核验"拉的是旧内容，不反映本次改动

---

## 排障指南

### 日志位置

| 文件 | 内容 |
|---|---|
| `%APPDATA%\DSH-Desktop\logs\app.log` | 外壳主进程日志 |
| `%APPDATA%\DSH-Desktop\logs\dsh-web.log` | dsh 子进程 stdout/stderr |

### 关键路径

| 项 | 路径 |
|---|---|
| 安装目录 | `%LOCALAPPDATA%\Programs\DSH Desktop` |
| 用户数据 | `%APPDATA%\DSH-Desktop`（注意是连字符） |
| dsh 数据 | `%APPDATA%\DSH-Desktop\dsh-home` |
| 热更新壳 | `%APPDATA%\DSH-Desktop\hot\shell-<版本>-<时间戳>\` |
| MCP 配置 | `%APPDATA%\DSH-Desktop\mcp-servers.json` |

### 常见问题

| 症状 | 原因与处理 |
|---|---|
| dsh 起不来，日志有 `plugin tree failed to load` | 补丁插件解析不到。patch-guard 会自动剔除；仍失败则检查 `desktop-patch.effective.yml` |
| 启动卡在 `timed out waiting for the writer lock` | 上次强杀留了锁文件。外壳会自动清理；手动可删 `dsh-home/profiles/*.lock` |
| 设置页少了某一节 | 插件没落位。检查 `dsh-home/profiles/node_modules/<包名>` |
| 外壳版本升了但功能没变 | 热壳换了但补丁没跟上。检查热壳目录中是否有 `desktop-patch.yml` |
| 热更后仍反复提示同版本更新 | 已修复（pickHot 版本去重）。若仍出现，清除 `hot/` 目录后重启 |
| 命令执行弹出控制台窗口 | `win-console.ts` 应在启动前分配隐藏控制台；检查是否被安全软件拦截 |
| 沙箱下命令以 `0xC0000142` 失败 | ACL 令牌问题，`acl-patch.ts` 应自动修复；检查日志 |
| MCP 服务器添加后不生效 | 检查 `mcp-servers.json` 格式 + 重启应用；补丁 YAML 缩进问题已修复 |

### 手动复现 dsh 启动（绕过外壳）

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = "$env:TEMP\dsh-test"
node_modules\electron\dist\electron.exe --expose-internals `
  resources\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js `
  --profile web --patch resources\desktop-patch.yml --no-open --port 0
# 成功输出：dsh web: http://127.0.0.1:<port>/?token=...
```

---

## 已知限制

- 仅支持 **x64** 架构（Electron 44 已移除 32 位构建）
- **未做代码签名**，SmartScreen 首次运行可能提示未知发布者
- dsh 处于 developer preview 阶段，版本升级需修改 `package.json` 后重新构建
- Win7 线依赖社区 fork Electron，上游更新后需重新验证指纹补丁
- 完整安装包分发依赖 GitHub Release（静态托管单文件大小限制放不下）
- 安装包体积较大（约 240 MB，含完整运行时、Git、Python）

---

## 致谢

**作者与维护者**：[XRC111](https://github.com/XRC111)

**上游项目**：
- [DeepSeek Harness](https://github.com/deepseek-ai) — 核心运行时
- [Electron](https://www.electronjs.org/) — 桌面框架
- 社区 Electron Win7 fork 维护者

开发过程中使用了以下 AI 模型辅助代码编写、排障与文档撰写：

| 模型 | 提供方 |
|---|---|
| DeepSeek-v4-flash/v4.1-flash | DeepSeek |
| GLM-5.3-flash/GLM-5.3| Z.ai（智谱） |
| Hunyuan-4-preview | 腾讯 |
| Kimi-K3 | Moonshot AI（月之暗面） |
| Seed-2.1-lite/turbo/pro | 豆包（字节跳动） |
| ChatGPT-6-luna | OpenAI |
| Mimo-2.6-pro | Xiaomi |
| Qwen-3.8-flash | 通义千问（阿里巴巴） |
> 以上 AI 模型是开发工具，不是代码贡献者；项目的设计决策、实现取舍与最终质量由维护者负责。

---

## License

[MIT](./LICENSE)
