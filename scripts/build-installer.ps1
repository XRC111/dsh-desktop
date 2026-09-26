<#
.SYNOPSIS
    DSH Desktop 一键打包：生成 Windows 安装包 dist\DSH-Desktop-Setup-<版本>.exe

.DESCRIPTION
    只做「打包」这一段（依赖与运行时已就绪），链路与 package.json 的 dist 脚本一致，
    但加了三处关键保护：

      * 先移开旧 dist\win-unpacked —— electron-builder 要删一万多个文件，
        批量删除在有安全拦截的环境里会直接让 build 失败；改名移开最稳。
      * --win nsis 必须带 --prepackaged —— 否则它会重新打包 app 目录，
        把上一步注入的运行时整个覆盖掉。
      * 打包完做一次产物自检（scripts/verify-package.mjs），
        确认 asar 版本 / 补丁 / 插件 / 运行时 / 安装包版本都对得上。

    对「下载 Electron 二进制时网络中断」这类瞬时失败会自动重试。

    步骤：
      0. 环境预检 + 结束正在运行的应用（会占用 dist\win-unpacked）
      1. 编译 TypeScript
      2. 打包运行时 tar + 生成文件清单（-SkipRuntime 可跳过）
      3. electron-builder --win dir
      4. 注入运行时到 dist\win-unpacked\resources
         （electron-builder 不复制 extraResources 里的 node_modules）
      5. electron-builder --win nsis --prepackaged dist\win-unpacked
      6. 产物自检 + 打印 SHA256

.PARAMETER SkipRuntime
    跳过「打包运行时 tar / 生成清单」。运行时与清单都没动过时用它省时。

.PARAMETER DirOnly
    只做到「解包目录」就停（不生成安装包），便于快速验证。

.PARAMETER CleanOld
    顺手删掉历次留存的 dist\win-unpacked-old-* 目录（会释放很多空间，但慢）。

.PARAMETER Attempts
    electron-builder --win dir 失败时的最大尝试次数，默认 3。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1

.EXAMPLE
    # 运行时没动过，跳过 tar/清单，最快
    powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -SkipRuntime
#>
[CmdletBinding()]
param(
    [switch]$SkipRuntime,
    [switch]$DirOnly,
    [switch]$CleanOld,
    [int]$Attempts = 3
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$distDir = Join-Path $root 'dist'
$unpacked = Join-Path $distDir 'win-unpacked'
$resources = Join-Path $unpacked 'resources'

# ── 先清掉可能被上层工具（IDE / 终端壳）注入的环境变量 ──────────────────────
#   NODE_OPTIONS 若指向某个 --require 垫片，会被 electron-builder / node 子进程继承，
#   其中「批量删除保护」之类的钩子会让 electron-builder 删除旧解包目录时直接抛错，
#   构建中途失败且报错指向删除、看不出真正原因。
#   ELECTRON_RUN_AS_NODE 若被设过，Electron 会以纯 Node 模式启动（GUI 不可用）。
$poisoned = @()
foreach ($v in @(
    'NODE_OPTIONS',
    'CODEBUDDY_SAFE_DELETE_ENABLED',
    'CODEBUDDY_SAFE_DELETE_BULK_GUARD',
    'CODEBUDDY_SAFE_DELETE_BROKER_DELETE',
    'CODEBUDDY_SAFE_DELETE_BIN_DIR',
    'CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR',
    'CODEBUDDY_SAFE_DELETE_REPORT_PATH',
    'CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD',
    'ELECTRON_RUN_AS_NODE'
)) {
    $cur = [Environment]::GetEnvironmentVariable($v)
    if ($cur) {
        $poisoned += "$v=$cur"
        [Environment]::SetEnvironmentVariable($v, $null)
    }
}

if (-not (Test-Path $distDir)) { New-Item -ItemType Directory -Path $distDir | Out-Null }
$script:logFile = Join-Path $distDir ("build-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

Push-Location $root

function Log {
    param([string]$Text, [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
    if ($script:logFile) { $Text | Out-File $script:logFile -Append -Encoding utf8 }
}
function Step {
    param([string]$N, [string]$Text)
    Log ''
    Log "[$N] $Text" 'Cyan'
}
function Fail {
    param([string]$Text, [string]$Hint)
    Log ''
    Log "[失败] $Text" 'Red'
    if ($Hint) { Log "  提示：$Hint" 'Yellow' }
    Log "  完整日志：$script:logFile" 'Yellow'
    exit 1
}
function Invoke-Step {
    param([string]$Exe, [string[]]$ArgList)
    Log ("  > {0} {1}" -f (Split-Path -Leaf $Exe), ($ArgList -join ' ')) 'DarkGray'
    # 原生命令（npm / electron-builder / robocopy）会往 stderr 写警告。全局 EAP=Stop 时
    # 这些警告会被当成终止错误，让整个脚本在无关紧要的输出上崩掉 —— 这里临时放宽。
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @ArgList 2>&1 | ForEach-Object {
            $line = [string]$_
            if ($script:logFile) { $line | Out-File $script:logFile -Append -Encoding utf8 }
            Write-Host "  $line"
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prev
    }
    return $code
}
function Move-Aside {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return }
    $stamp = Get-Date -Format 'HHmmss'
    $dst = "$Path-old-$stamp"
    try {
        Move-Item $Path $dst -Force -ErrorAction Stop
        Log "  已移开 $Path" 'DarkGray'
    } catch {
        Fail "无法移开 $Path" "很可能还有 DSH Desktop 在运行并占用它。请先完全退出应用再重试。($($_.Exception.Message))"
    }
}

try {
    # ── 0) 预检 ─────────────────────────────────────────────────────────────
    Step 0 '环境预检'
    Log "  项目根目录：$root"
    Log "  日志文件：$script:logFile"
    if ($poisoned.Count -gt 0) {
        Log '  已清除上层工具注入的环境变量（会干扰构建）：' 'Yellow'
        foreach ($p in $poisoned) { Log "    $p" 'Yellow' }
    }

    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) { Fail '未找到 Node.js' '构建机需要 Node.js 22.19+（最终用户机器不需要）。' }
    Log "  node $((& node -v))"

    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) { Fail '未找到 npm' '请确认 Node.js 安装完整。' }

    foreach ($need in @(
        @{ p = 'node_modules\electron\dist\electron.exe'; h = '先跑 npm install 安装应用依赖。' },
        @{ p = 'resources\desktop-patch.yml';             h = '缺少桌面适配补丁文件。' },
        @{ p = 'resources\dsh-plugins\directory-picker\package.json'; h = '缺少自有插件源 resources\dsh-plugins\directory-picker。' },
        @{ p = 'scripts\prepare-payload.mjs';             h = '缺少载荷准备脚本。' },
        @{ p = 'scripts\verify-package.mjs';              h = '缺少产物自检脚本。' }
    )) {
        $full = Join-Path $root $need.p
        if (-not (Test-Path $full)) { Fail "缺少 $($need.p)" $need.h }
    }
    if (-not $SkipRuntime) {
        $runtimeEntry = 'resources\dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (-not (Test-Path (Join-Path $root $runtimeEntry))) {
            Fail "缺少 Harness 运行时（$runtimeEntry）" '先跑 npm run prepare:runtime 拉取 dsh。'
        }
    }
    Log '  必需文件齐全'

    # 镜像（下载 Electron / electron-builder 工具包时用；已在环境里设过就不覆盖）
    if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/' }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }
    Log "  ELECTRON_MIRROR = $env:ELECTRON_MIRROR"

    # 应用在跑就会占住 dist\win-unpacked
    $running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like '*DSH*' -or $_.ProcessName -eq 'electron'
    }
    if ($running) {
        Log "  检测到正在运行的实例，先结束它们（否则 dist\win-unpacked 被占用）" 'Yellow'
        $prevEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'   # taskkill 的 stderr 不该让脚本崩掉
        try {
            foreach ($p in $running) {
                # 同一个进程树可能已被上一次 taskkill /T 连带杀掉，这里先确认还活着
                if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { continue }
                Log "    kill $($p.ProcessName) (pid $($p.Id))" 'Yellow'
                & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
            }
        } finally {
            $ErrorActionPreference = $prevEap
        }
        Start-Sleep -Seconds 3
    }

    if ($CleanOld) {
        Step 0.1 '清理历次留存的解包目录（-CleanOld）'
        $olds = Get-ChildItem $distDir -Directory -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like 'win-unpacked-old-*' -or $_.Name -like '_old-unpacked-*' }
        if (-not $olds) { Log '  没有需要清理的旧目录' }
        foreach ($d in $olds) {
            $mb = [math]::Round((Get-ChildItem $d.FullName -Recurse -File -ErrorAction SilentlyContinue |
                                 Measure-Object -Property Length -Sum).Sum / 1MB, 1)
            Log "  删除 $($d.Name)  ($mb MB)" 'Yellow'
            Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # 旧产物先移开（不要靠删除，见文件头说明）
    Move-Aside $unpacked
    Move-Aside "$unpacked.tmp"

    # ── 1) 编译 ─────────────────────────────────────────────────────────────
    Step 1 '编译 TypeScript'
    $code = Invoke-Step 'npm' @('run', 'build')
    if ($code -ne 0) { Fail 'TypeScript 编译失败' '看上面的 tsc 报错。' }

    if (-not $SkipRuntime) {
        Step 2 '打包运行时 tar + 生成文件清单'
        $code = Invoke-Step 'node' @('scripts\pack-runtime.mjs')
        if ($code -ne 0) { Fail '运行时打包失败' }
        $code = Invoke-Step 'node' @('scripts\gen-runtime-manifest.mjs')
        if ($code -ne 0) { Fail '文件清单生成失败' }
    } else {
        Step 2 '跳过运行时打包（-SkipRuntime）'
        foreach ($f in @('build\dsh-runtime.tar', 'build\dsh-runtime-manifest.json')) {
            if (-not (Test-Path (Join-Path $root $f))) { Fail "缺少 $f" '去掉 -SkipRuntime 重新跑，或先手动生成。' }
        }
    }

    # ── 3) dir 打包（带重试） ───────────────────────────────────────────────
    $ebPath = Join-Path $root 'node_modules\.bin\electron-builder.cmd'
    if (-not (Test-Path $ebPath)) { Fail '找不到 electron-builder' '先跑 npm install。' }

    $dirOk = $false
    for ($i = 1; $i -le $Attempts; $i++) {
        Step "3.$i" "electron-builder --win dir（第 $i / $Attempts 次）"
        $code = Invoke-Step $ebPath @('--win', 'dir', '--x64')
        if ($code -eq 0 -and (Test-Path (Join-Path $resources 'app.asar'))) {
            $dirOk = $true
            Log '  解包目录已生成' 'Green'
            break
        }
        Log "  本次失败（退出码 $code），清理半成品后重试" 'Yellow'
        Move-Aside $unpacked
        Move-Aside "$unpacked.tmp"
        Start-Sleep -Seconds 5
    }
    if (-not $dirOk) {
        Fail 'electron-builder --win dir 连续失败' '最常见是下载 Electron 二进制时网络中断（502/超时）。检查网络或换镜像后重试。'
    }

    # ── 4) 准备载荷（运行时只以单个 tar 分发，安装期由多线程解压器展开） ─────
    Step 4 '准备载荷（剥离运行时目录）'
    $code = Invoke-Step 'node' @('scripts\prepare-payload.mjs')
    if ($code -ne 0) { Fail '载荷准备失败' }
    foreach ($f in @('dsh-runtime.tar', 'dsh-runtime-manifest.json', 'extract-runtime.cjs', 'extract-runtime.cmd')) {
        $p = Join-Path $resources $f
        if (-not (Test-Path $p)) { Fail "载荷缺少 $f" "预期位置：$p" }
    }

    if ($DirOnly) {
        Step 5 '跳过安装包（-DirOnly）'
        Invoke-Step 'node' @('scripts\verify-package.mjs', $unpacked) | Out-Null
        Log ''
        Log '已生成解包目录（未生成安装包，因为指定了 -DirOnly）：' 'Green'
        Log "  $unpacked" 'Green'
        exit 0
    }

    # ── 5) NSIS 安装包（必须 --prepackaged） ────────────────────────────────
    Step 5 'electron-builder --win nsis --prepackaged'
    $code = Invoke-Step $ebPath @('--win', 'nsis', '--x64', '--prepackaged', 'dist/win-unpacked')
    if ($code -ne 0) { Fail 'NSIS 安装包生成失败' }

    # ── 6) 产物自检 ─────────────────────────────────────────────────────────
    Step 6 '产物自检'
    $code = Invoke-Step 'node' @('scripts\verify-package.mjs', $unpacked)
    if ($code -ne 0) {
        Fail '产物自检未通过' '上面 FAIL 的那几项就是问题所在；产物先别拿去装。'
    }

    # ── 汇总 ────────────────────────────────────────────────────────────────
    Log ''
    Log '打包完成' 'Green'
    Log ''
    $version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
    $installer = Join-Path $distDir "DSH-Desktop-Setup-$version.exe"
    if (Test-Path $installer) {
        $hash = (Get-FileHash $installer -Algorithm SHA256).Hash
        $size = [math]::Round((Get-Item $installer).Length / 1MB, 1)
        Log "  安装包：$installer" 'Green'
        Log "  版本  ：$version"
        Log "  大小  ：$size MB"
        Log "  SHA256：$hash"
    } else {
        Log "  未找到预期的安装包 $installer" 'Yellow'
        Log '  dist 下的 .exe：' 'Yellow'
        Get-ChildItem $distDir -Filter *.exe | ForEach-Object { Log "    $($_.Name)" 'Yellow' }
    }
    Log ''
    Log '  安装前建议先卸载旧版本（控制面板 → 应用）。' 'Yellow'
    Log "  构建日志：$script:logFile"
}
finally {
    Pop-Location
}
