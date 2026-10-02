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

try {

# ---------------------------------------------------------------------------
Step "0/3 自检（nightly 外壳 $Version）"
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
Step "1/3 构建安装包 $Version"
# ---------------------------------------------------------------------------
# config.dshVersion 写**运行时实际版本**（带 +nightly.<sha>）：壳靠它上报内嵌 dsh 版本。
Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")' $Version 'package.json version'
Set-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")' $dshNightly 'config.dshVersion'
Info 'npm run dist 开始（数分钟）…'
& npm run dist
if ($LASTEXITCODE -ne 0) { throw "npm run dist 失败（exit=$LASTEXITCODE）" }

# ---------------------------------------------------------------------------
Step '2/3 自检产物'
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
Step '3/3 完成（nightly 只构建，不发 Release / 不打热壳 / 不部署 feed）'
# ---------------------------------------------------------------------------
Info "产物：$exe"
Info '下载：Actions 页面的本次 run → Artifacts'
} finally {
    if (-not $KeepVersion) {
        try {
            if ($origPkgVer) { Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")' $origPkgVer 'package.json version（回滚）' }
            if ($origDshVer) { Set-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")' $origDshVer 'config.dshVersion（回滚）' }
        } catch { Warn "回滚失败：$($_.Exception.Message)" }
    }
}
