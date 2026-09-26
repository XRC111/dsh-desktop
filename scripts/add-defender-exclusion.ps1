<#
.SYNOPSIS
    把 DSH Desktop 的构建/运行目录加入 Windows Defender 排除名单。

.DESCRIPTION
    这台机器构建慢的主因不是磁盘带宽，而是 Defender 对每一个小文件做实时扫描
    （本项目 node_modules 有 3.5 万个小文件，实测是主要瓶颈）。

    把下面这些目录加进排除名单后，inject-runtime 的 robocopy 从 ~11 文件/秒
    提升到几百文件/秒，整条打包链路从半小时级降到分钟级。

    必须以【管理员】身份运行；脚本会自己弹 UAC 提权。

    排除的是「路径」，不影响 Defender 对其它目录的防护；
    想撤销时把 Add-MpPreference 换成 Remove-MpPreference 再跑一次即可。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\add-defender-exclusion.ps1
#>

# 非管理员则自动提权重启自己
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host '需要管理员权限，正在提权…' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath) `
        -Verb RunAs
    exit 0
}

$ErrorActionPreference = 'Continue'

# ── 先搞清楚「到底是谁在做实时扫描」 ────────────────────────────────────────
# Windows Defender 服务没在运行时（常见于装了第三方杀软），Add-MpPreference 会报
# 0x800106ba —— 那不是脚本或权限的问题，而是根本轮不到 Defender 来扫文件。
$defend = Get-Service -Name WinDefend -ErrorAction SilentlyContinue
if ($defend -and $defend.Status -ne 'Running') {
    Write-Host ''
    Write-Host '检测到 Windows Defender 服务未运行（WinDefend 已停止）。' -ForegroundColor Yellow
    Write-Host '这台机器的实时扫描不是 Defender 在做，给 Defender 加白名单没有意义，已跳过。' -ForegroundColor Yellow

    $hips = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.ProcessName -in @('HipsDaemon', 'HipsTray', 'usysdiag', 'wsctrlsvc') }
    if ($hips) {
        Write-Host ''
        Write-Host '检测到第三方安全软件正在运行（实时扫描来自它）：' -ForegroundColor Cyan
        $hips | ForEach-Object { Write-Host ("    {0}  (pid {1})" -f $_.ProcessName, $_.Id) }
        Write-Host ''
        Write-Host '请在那个安全软件里加白名单，二选一：' -ForegroundColor Cyan
        Write-Host '  A. 信任区（推荐，一次性解决）' -ForegroundColor Cyan
        Write-Host '     火绒：主界面 -> 防护中心 -> 信任区 -> 添加目录 -> D:\code\dsh-desktop'
        Write-Host '     （把整个项目目录加进去，包含 node_modules 的 3.5 万个小文件）'
        Write-Host '  B. 构建期间临时关闭「文件实时监控 / 病毒实时防护」，构建完再打开'
        Write-Host ''
        Write-Host '加完后重新跑打包脚本，robocopy 会从 ~11 文件/秒 提升到几百文件/秒：' -ForegroundColor Green
        Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -SkipRuntime' -ForegroundColor Green
    } else {
        Write-Host '也未检测到常见第三方杀软进程，请确认这台机器装的是哪个安全软件。' -ForegroundColor Yellow
    }
    exit 0
}

# 要排除的路径：本项目 + Electron/打包工具缓存 + 应用用户数据
$paths = @(
    'D:\code\dsh-desktop',
    'D:\code',
    "$env:LOCALAPPDATA\electron-builder\Cache",
    "$env:LOCALAPPDATA\electron\Cache",
    "$env:LOCALAPPDATA\electron-builder",
    "$env:APPDATA\DSH-Desktop",
    "$env:LOCALAPPDATA\Temp"
)

# 要排除的进程：构建链路里高频读写文件的几个
$processes = @('robocopy.exe', 'node.exe', 'electron.exe', 'electron-builder.cmd', 'tar.exe', '7za.exe')

Write-Host ''
Write-Host '== 添加 Defender 排除路径 ==' -ForegroundColor Cyan
foreach ($p in $paths) {
    if (-not (Test-Path $p)) {
        Write-Host "  跳过（不存在）：$p" -ForegroundColor DarkGray
        continue
    }
    try {
        Add-MpPreference -ExclusionPath $p -ErrorAction Stop
        Write-Host "  已排除路径：$p" -ForegroundColor Green
    } catch {
        Write-Host "  失败：$p  ->  $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '== 添加 Defender 排除进程 ==' -ForegroundColor Cyan
foreach ($p in $processes) {
    try {
        Add-MpPreference -ExclusionProcess $p -ErrorAction Stop
        Write-Host "  已排除进程：$p" -ForegroundColor Green
    } catch {
        Write-Host "  失败：$p  ->  $($_.Exception.Message)" -ForegroundColor Red
    }
}

Write-Host ''
Write-Host '当前生效的排除路径：' -ForegroundColor Cyan
try {
    $mp = Get-MpPreference
    $mp.ExclusionPath | ForEach-Object { Write-Host "  $_" }
} catch {
    Write-Host "  读取失败：$($_.Exception.Message)" -ForegroundColor Red
}

Write-Host ''
Write-Host '完成。回到普通终端重新跑打包脚本即可，速度会明显提升：' -ForegroundColor Green
Write-Host '  powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -SkipRuntime' -ForegroundColor Green
Write-Host ''
Write-Host '提示：正被 Defender 实时扫描占用的那次构建可以不管它，跑完就结束了；' -ForegroundColor DarkGray
Write-Host '      不想等就在任务管理器结束 robocopy.exe，然后重跑上面的打包脚本。' -ForegroundColor DarkGray
