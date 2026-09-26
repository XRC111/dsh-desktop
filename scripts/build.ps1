<#
.SYNOPSIS
    DSH Desktop 一键构建脚本：拉取 Harness 运行时 → 编译 → 生成 Windows 安装包。

.DESCRIPTION
    默认执行完整链路：
      1. 安装应用自身依赖（Electron / electron-builder / TypeScript）
      2. 生成图标资源（build/icon.ico、build/tray.png）
      3. 拉取 DeepSeek Harness 生产依赖到 resources/dsh-runtime（国内镜像）
      4. 探测原生模块（必要时用 @electron/rebuild 重编译）
      5. 校验运行时（用 Electron 内置 Node 实际跑一次 dsh --version）
      6. 编译 TypeScript
      7. 用 electron-builder 生成 NSIS 安装包 dist/DSH-Desktop-Setup-<version>.exe

    不使用任何独立 Node 运行时：dsh 由 Electron 内置 Node 以
    ELECTRON_RUN_AS_NODE 模式启动。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1
.EXAMPLE
    # 只重新打包（运行时与依赖已就绪，最省时）
    powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -SkipInstall -SkipRuntime
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipRuntime,
    [switch]$ForceRuntime,
    [switch]$DirOnly,
    [string]$Registry = 'https://registry.npmmirror.com',
    [string]$ElectronMirror = 'https://npmmirror.com/mirrors/electron/'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($n, $text) {
    Write-Host ''
    Write-Host "[$n] $text" -ForegroundColor Cyan
}
function Fail($text) {
    Write-Host "[失败] $text" -ForegroundColor Red
    exit 1
}

try {
    # 镜像配置（下载 Electron 二进制与 electron-builder 工具包时使用）
    $env:ELECTRON_MIRROR = $ElectronMirror
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    $env:npm_config_registry = $Registry
    $env:DSH_NPM_REGISTRY = $Registry

    Step 0 '检查工具链'
    $nodeV = (node -v) 2>$null
    if (-not $nodeV) { Fail '未找到 Node.js（构建机需要 Node.js，最终用户机器不需要）' }
    Write-Host "  node $nodeV / npm $((npm -v))"
    Write-Host "  registry: $Registry"

    if (-not $SkipInstall) {
        Step 1 '安装应用依赖（Electron / electron-builder / TypeScript）'
        npm install --no-audit --no-fund --registry=$Registry
        if ($LASTEXITCODE -ne 0) { Fail 'npm install 失败' }
    } else {
        Step 1 '跳过应用依赖安装（-SkipInstall）'
    }

    Step 2 '生成图标资源（优先使用 DeepSeek 官方 favicon）'
    # 下载官方 favicon（可选：失败时沿用仓库内已有文件，不影响构建）
    node scripts/fetch-brand-icon.mjs
    if ($LASTEXITCODE -ne 0) { Write-Host '  （官方图标下载失败，将使用已存在的文件或内置占位图标）' -ForegroundColor Yellow }
    node scripts/gen-assets.mjs
    if ($LASTEXITCODE -ne 0) { Fail '图标生成失败' }

    if (-not $SkipRuntime) {
        Step 3 '拉取 DeepSeek Harness 运行时（生产依赖）'
        if ($ForceRuntime) { node scripts/fetch-dsh.mjs --force }
        else { node scripts/fetch-dsh.mjs }
        if ($LASTEXITCODE -ne 0) { Fail 'dsh 运行时拉取失败' }
    } else {
        Step 3 '跳过 dsh 运行时拉取（-SkipRuntime）'
    }

    Step 4 '探测原生模块 ABI（必要时重编译）'
    node scripts/rebuild-native.mjs
    if ($LASTEXITCODE -ne 0) { Fail '原生模块处理失败，请查看上面的探测输出' }

    Step 5 '校验运行时（用 Electron 内置 Node 运行 dsh）'
    node scripts/verify-runtime.mjs
    if ($LASTEXITCODE -ne 0) { Fail '运行时校验未通过' }

    Step 6 '编译 TypeScript'
    npm run build
    if ($LASTEXITCODE -ne 0) { Fail 'TypeScript 编译失败' }

    Step 7 '打包 Harness 运行时为 tar + 生成文件清单（供安装包分发/自愈）'
    node scripts/pack-runtime.mjs
    if ($LASTEXITCODE -ne 0) { Fail '运行时打包失败' }
    node scripts/gen-runtime-manifest.mjs
    if ($LASTEXITCODE -ne 0) { Fail '文件清单生成失败' }

    # 关键：electron-builder **不会**复制 extraResources 里的 node_modules，
    # 所以必须先用 dir 生成解包目录、把运行时注入进去，再用 --prepackaged 打 NSIS。
    # 直接 `--win nsis` 会重新打包 app 目录并覆盖载荷准备结果 → 装完运行时会缺失。
    Step 8 '打包为解包目录（--win dir）'
    npx electron-builder --win dir --x64
    if ($LASTEXITCODE -ne 0) { Fail 'electron-builder --win dir 失败' }

    Step 9 '准备载荷（剥离运行时目录，安装期多线程展开）'
    node scripts/prepare-payload.mjs
    if ($LASTEXITCODE -ne 0) { Fail '载荷准备失败' }

    if ($DirOnly) {
        Step 10 '跳过安装包（-DirOnly）'
    } else {
        Step 10 '生成 NSIS 安装包（必须带 --prepackaged）'
        npx electron-builder --win nsis --x64 --prepackaged dist/win-unpacked
        if ($LASTEXITCODE -ne 0) { Fail 'electron-builder --win nsis 失败' }
    }

    Step 11 '产物自检'
    node scripts/verify-package.mjs
    if ($LASTEXITCODE -ne 0) { Fail '产物自检未通过（详见上面的 FAIL 项）' }

    Write-Host ''
    Write-Host '构建完成，产物位于 dist/ ：' -ForegroundColor Green
    Get-ChildItem dist -File | Where-Object { $_.Extension -in '.exe', '.blockmap' } |
        ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
    Write-Host ''
    Write-Host '提示：只重新打包（依赖/运行时已就绪）用这个更快 —— ' -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -SkipRuntime' -ForegroundColor Yellow
}
finally {
    Pop-Location
}
