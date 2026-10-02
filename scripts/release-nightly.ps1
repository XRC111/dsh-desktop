<#
.SYNOPSIS
    nightly 专用构建脚本（**只构建**，不发 Release、不打热壳、不生成也不部署 feed）。

.DESCRIPTION
    为什么独立于 release-v2.ps1：那是「六通道 + 安装包上传 + 整站 feed 部署」的脚本。
    nightly 只要一个安装包，混在一起会互相拖累 —— 实测踩到的坑全是混用造成的：
      1) 它的 feed 生成不看 -SkipXxx，nightly 一跑就把另外六份 feed 用默认版本号
         （10.1.0/7.1.0…）覆盖成空骨架；
      2) 它的暂存步骤要求七份 feed 都在本地，CI 上必然缺；
      3) 它默认要求本机的 wrangler 目录，CI 上不存在，自检就 throw；
      4) electron-builder 在 CI 上会隐式 publish，没有 GH_TOKEN 直接 exit=1。

    nightly 的定位是**每日构建验证**：产物进 GitHub Actions artifact（保留 14 天），
    由人按需下载试跑。所以这里刻意什么都不发 —— 没有 feed 就没有「把线上 feed
    弄坏」的可能，这是 nightly 最该保证的事。

    两条线都构建（与主线发版一致）：
      主线 10.4.x  → 官方 Electron 44（Win10/11）
      w7   7.4.x   → 社区 fork + 宿主指纹补丁（Windows 7）
    Win7 用户不该因为「没有 nightly」被落下；两条线同一天构建，版本号一一对应。

    通道说明：本脚本**不动** resources/update-config.json 的 channel（保持 stable）。
    因为 nightly 没有自己的 feed，写 nightly 只会让壳去轮询一个不存在的地址；
    保持 stable 则 nightly 包仍能正常收到插件热更，只是壳版本 10.4.x > 10.1.x，
    不会被拉回主线。

.EXAMPLE
    # CI
    pwsh -File scripts/release-nightly.ps1 -Version 10.4.12

.EXAMPLE
    # 本机试跑
    pwsh -File scripts/release-nightly.ps1 -Version 10.4.99
#>

[CmdletBinding()]
param(
    # nightly 外壳版本号。留空则用 10.4.<CI run number>；本机跑必须显式给。
    [string]$Version = '',

    # 运行时树（必须是 fetch-nightly.mjs 编出来的：package.json 里有 dshNightly 段）
    [string]$RuntimeDir = 'resources\dsh-runtime',

    # 跳过 w7 线（只构建主线）。fork 下载失败时可临时用。
    [switch]$SkipW7,

    # w7 外壳版本号。留空则由主线推导：10.4.9 -> 7.4.9
    [string]$W7Version = '',

    # 构建完不回滚 package.json 的版本（CI 上无所谓；本机建议别加）
    [switch]$KeepVersion
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Info($m) { Write-Host "  . $m" -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

$PkgPath = Join-Path $root 'package.json'
$CfgPath = Join-Path $root 'resources\update-config.json'
$RtDir   = Join-Path $root $RuntimeDir

# JSON 字段改写（正则定位、保留 BOM 与原格式，幂等：值相同则跳过）
function Set-JsonField {
    param([string]$File, [string]$Pattern, [string]$NewValue, [string]$Label)
    $raw = [System.IO.File]::ReadAllText($File)
    $m = [regex]::Match($raw, $Pattern)
    if (-not $m.Success) { throw "在 $File 中找不到字段：$Label" }
    $old = $m.Groups[2].Value
    if ($old -eq $NewValue) { Info "$Label 已是 $NewValue（跳过）"; return }
    $new = $raw.Substring(0, $m.Groups[2].Index) + $NewValue +
           $raw.Substring($m.Groups[2].Index + $m.Groups[2].Length)
    $bytes = [System.IO.File]::ReadAllBytes($File)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    [System.IO.File]::WriteAllText($File, $new, (New-Object System.Text.UTF8Encoding($hasBom)))
    Ok "$Label : $old -> $NewValue"
}
function Get-JsonField {
    param([string]$File, [string]$Pattern)
    $m = [regex]::Match([System.IO.File]::ReadAllText($File), $Pattern)
    if ($m.Success) { return $m.Groups[2].Value }
    return ''
}

if (-not $Version) {
    if ($env:GITHUB_RUN_NUMBER) { $Version = '10.4.' + $env:GITHUB_RUN_NUMBER }
    else { throw '本机跑请显式指定 -Version（如 -Version 10.4.99）' }
}

$origPkgVer = Get-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")'
$origDshVer = Get-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")'
$origChannel = Get-JsonField $CfgPath '("channel":\s*")([^"]*)(")'
$CfgW7Path = Join-Path $root 'resources\update-config.w7.json'
$CfgBak    = Join-Path $root 'build\.update-config.mainline.bak'

if (-not $W7Version) {
    # 10.4.9 -> 7.4.9：patch 位对齐，minor 换成 w7 线的 7
    $parts = $Version.Split('.')
    if ($parts.Count -ge 3) { $W7Version = '7.4.' + $parts[2] } else { $W7Version = '7.4.0' }
}

try {

# ---------------------------------------------------------------------------
Step "0/5 自检（nightly 外壳 $Version / w7 $W7Version）"
# ---------------------------------------------------------------------------
$rtPkg = Join-Path $RtDir 'package.json'
if (-not (Test-Path -LiteralPath $rtPkg)) {
    throw "运行时树不存在：$RtDir`n  先跑：node scripts/fetch-nightly.mjs --to $RuntimeDir"
}
$info = (Get-Content -LiteralPath $rtPkg -Raw | ConvertFrom-Json).dshNightly
if (-not $info) {
    throw ("$RuntimeDir 不是 nightly 树（package.json 里没有 dshNightly 段）。`n" +
           "  先跑：node scripts/fetch-nightly.mjs --to $RuntimeDir`n" +
           '  否则会把主线 stable 的运行时当成 nightly 发出去。')
}
$dshNightly = $info.upstreamVersion + '+nightly.' + $info.commit.Substring(0,7)
Ok "上游 dsh $($info.upstreamVersion) @ $($info.commit.Substring(0,7))（内嵌 $dshNightly）"

# ---------------------------------------------------------------------------
Step "1/5 构建主线安装包 $Version"
# ---------------------------------------------------------------------------
# config.dshVersion 写**运行时实际版本**（带 +nightly.<sha>）：壳靠它上报内嵌 dsh 版本。
Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")' $Version 'package.json version'
Set-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")' $dshNightly 'config.dshVersion'
Info 'npm run dist 开始（数分钟）…'
& npm run dist
if ($LASTEXITCODE -ne 0) { throw "npm run dist 失败（exit=$LASTEXITCODE）" }

# ---------------------------------------------------------------------------
Step "2/5 构建 w7 安装包 $W7Version（fork Electron，Win7 用）"
# ---------------------------------------------------------------------------
if ($SkipW7) {
    Warn '跳过 w7 线（-SkipW7）'
} else {
    # fork Electron 必须就位且已打宿主指纹补丁（dsh 0.1.7 起有指纹白名单，不打补丁会拒绝启动）
    $w7Exe = Join-Path $root 'build\electron-win7\electron.exe'
    if (-not (Test-Path -LiteralPath $w7Exe)) {
        Info 'fork Electron 缺失 → 下载 build/electron-win7'
        & node scripts\fetch-w7-electron.mjs
        if ($LASTEXITCODE -ne 0) { throw "fetch-w7-electron.mjs 失败（exit=$LASTEXITCODE）" }
    }
    $patchPy = Join-Path $root 'scripts\patch-w7-electron.py'
    if ((Test-Path -LiteralPath $w7Exe) -and (Test-Path -LiteralPath $patchPy)) {
        # 幂等判定：已打补丁的 exe 里 .19 应为 0 处、.13 应为 4 处
        $txt = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($w7Exe))
        $n13 = ([regex]::Matches($txt, '15\.2\.124\.13-electron\.0')).Count
        $n19 = ([regex]::Matches($txt, '15\.2\.124\.19-electron\.0')).Count
        if ($n19 -gt 0 -or $n13 -lt 4) {
            Info "fork 指纹未打补丁（.13 命中 $n13 / .19 残留 $n19）→ 跑 patch-w7-electron.py"
            $py = Get-Command python -ErrorAction SilentlyContinue
            if (-not $py) { throw '找不到 python（打 fork 指纹补丁需要它；见 scripts/patch-w7-electron.py）' }
            & python $patchPy $w7Exe
            if ($LASTEXITCODE -ne 0) { throw "patch-w7-electron.py 失败（exit=$LASTEXITCODE）" }
            $txt2 = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($w7Exe))
            $c13 = ([regex]::Matches($txt2, '15\.2\.124\.13-electron\.0')).Count
            $c19 = ([regex]::Matches($txt2, '15\.2\.124\.19-electron\.0')).Count
            if ($c19 -ne 0 -or $c13 -lt 4) { throw "补丁后指纹仍不对：.13=$c13 .19=$c19" }
            Ok 'fork 指纹补丁完成'
        } else {
            Info 'fork 指纹已就绪（.13 ×4 / .19 ×0），跳过补丁'
        }
    }

    # electronDist 必须写进 package.json 的 **build 段**，放顶层会被静默忽略
    # （那样 w7 包会误用官方 Electron，Win7 上提示「不是有效的 Win32 应用程序」）
    $rawPkg = [System.IO.File]::ReadAllText($PkgPath)
    if ($rawPkg -notmatch '"electronDist"') {
        $m = [regex]::Match($rawPkg, '(?m)^(\s*)"build":\s*\{\s*\r?\n(\s*)"')
        if (-not $m.Success) { throw 'package.json 找不到 build 段（electronDist 插入点）' }
        $indent = $m.Groups[2].Value
        $ins = $indent + '"electronDist": "build/electron-win7",' + "`r`n"
        $pos = $m.Groups[2].Index
        [System.IO.File]::WriteAllText($PkgPath, $rawPkg.Substring(0, $pos) + $ins + $rawPkg.Substring($pos), (New-Object System.Text.UTF8Encoding($false)))
        $chk = [System.IO.File]::ReadAllText($PkgPath)
        if (-not [regex]::IsMatch($chk, '(?s)"build"\s*:\s*\{[^}]*"electronDist"')) {
            throw 'electronDist 未落进 build 段（这会让 w7 误用官方 Electron）'
        }
        Ok 'package.json build.electronDist = build/electron-win7'
    }

    Copy-Item -LiteralPath $CfgPath -Destination $CfgBak -Force      # 备份主线更新源
    Copy-Item -LiteralPath $CfgW7Path -Destination $CfgPath -Force   # 换 w7 模板（指向 latest-w7*.json）
    try {
        Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")' $W7Version 'package.json version（w7）'
        # w7 线内嵌的仍是同一天编出来的 nightly 运行时（latest 线，不换血）
        Info "w7 $W7Version：electronDist=fork，npm run dist 开始（数分钟）…"
        & npm run dist
        if ($LASTEXITCODE -ne 0) { throw "w7 npm run dist 失败（exit=$LASTEXITCODE）" }
    } finally {
        Copy-Item -LiteralPath $CfgBak -Destination $CfgPath -Force
        $raw2 = [System.IO.File]::ReadAllText($PkgPath)
        $new2 = [regex]::Replace($raw2, '(?m)^\s*"electronDist":\s*"[^"]*",\s*\r?\n', '')
        if ($new2 -ne $raw2) { [System.IO.File]::WriteAllText($PkgPath, $new2, (New-Object System.Text.UTF8Encoding($false))) }
    }
    $w7Out = Join-Path $root "dist\DSH-Desktop-Setup-$W7Version.exe"
    if (-not (Test-Path -LiteralPath $w7Out)) { throw "w7 构建产物缺失：$w7Out" }
    Ok "DSH-Desktop-Setup-$W7Version.exe  $([math]::Round((Get-Item -LiteralPath $w7Out).Length / 1MB, 1)) MB"
}
# ---------------------------------------------------------------------------
Step '3/5 自检产物'
# ---------------------------------------------------------------------------
$exe = Join-Path $root "dist\DSH-Desktop-Setup-$Version.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "构建产物缺失：$exe" }
$mb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)
if ($mb -lt 200) { throw "安装包只有 $mb MB，明显不完整（应约 244 MB）" }
Ok "DSH-Desktop-Setup-$Version.exe  $mb MB"

# 载荷里的 Electron 必须是官方的（nightly 是主线，不是 w7 fork）
$unpacked = Join-Path $root 'dist\win-unpacked\DSH Desktop.exe'
if (Test-Path -LiteralPath $unpacked) {
    $sz = (Get-Item -LiteralPath $unpacked).Length
    Info "载荷 Electron：$sz B"
    if ($sz -gt 246000000) { Warn '载荷用的是 w7 fork（247.9MB）—— nightly 应该用官方 44.0.0（244.4MB）' }
}

# ---------------------------------------------------------------------------
Step '4/5 汇总（nightly 只构建，不发 Release / 不打热壳 / 不部署 feed）'
# ---------------------------------------------------------------------------
Info "主线产物：$exe"
if (-not $SkipW7) { Info "w7  产物：dist\DSH-Desktop-Setup-$W7Version.exe" }
Info '下载：Actions 页面的本次 run → Artifacts'
} finally {
    if (-not $KeepVersion) {
        try {
            if ($origPkgVer) { Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")' $origPkgVer 'package.json version（回滚）' }
            if ($origDshVer) { Set-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")' $origDshVer 'config.dshVersion（回滚）' }
            if ($origChannel -and (Test-Path -LiteralPath $CfgPath)) { Set-JsonField $CfgPath '("channel":\s*")([^"]*)(")' $origChannel 'update-config channel（回滚）' }
        } catch { Warn "回滚失败：$($_.Exception.Message)" }
    }
}
