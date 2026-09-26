# ============================================================================
#  DSH Desktop 通道方案 v2.1 一键发版脚本
#
#  版本矩阵（minor=通道、patch=通道内迭代；版本号一律不带预发布后缀）：
#    主线(win10+)          w7 线（fork 壳）
#    10.1.0 stable         7.1.0 stable    <- dsh latest   0.1.5-rc.3
#    10.2.0 beta           7.2.0 beta      <- dsh next     0.1.7-rc.2
#    10.3.0 dev            7.3.0 dev       <- dsh alpha    0.1.7-alpha.2
#  本脚本产出：7.1.0(w7 修复版) + 10.1.0 + 10.2.0 + 10.3.0 四个安装包
#              + 六份 feed（全部 --hot-only 空骨架）+ 一次 Pages 部署
#
#  feed 矩阵：
#    latest.json         = 10.1.0 stable    latest-w7.json       = 7.1.0 stable
#    latest-beta.json    = 10.2.0 beta      latest-w7-beta.json  = 7.1.0 beta(占位)
#    latest-dev.json     = 10.3.0 dev       latest-w7-dev.json   = 7.1.0 dev(占位)
#
#  用法（在本机 PowerShell 里跑，不要走沙箱 —— 沙箱 IO 太慢）：
#    powershell -ExecutionPolicy Bypass -File scripts\release-v2.ps1
#    .\scripts\release-v2.ps1 -SkipDev          # 先不发 dev（不重建 rt-alpha）
#    .\scripts\release-v2.ps1 -SkipPack         # 跳过全部构建，只重发 feed + 部署
#    .\scripts\release-v2.ps1 -SkipW7 -SkipStable -SkipBeta   # 三个包已建好，只补 dev + feed + 部署
#    .\scripts\release-v2.ps1 -SkipW7           # 7.1.0 已重打过，只发主线
#    .\scripts\release-v2.ps1 -SkipWrangler     # 只本地暂存，不上传
#
#  机制与坑（务必了解再跑）：
#   1) normalizeChannel 陷阱：老 7.1.0 的 channel=w7 被壳回落成 stable，实际轮询
#      主线 latest.json。修复 = 载荷里塞 {channel} 占位符模板后重打 NSIS（本脚本步骤 1）。
#   2) 六份 feed 默认 --hot-only（无 files/hot/runtime 块）：Pages 单文件上限 25MiB
#      放不下安装包；且空骨架让「误轮询主线 feed 的老 w7 壳」无包可下，天然安全。
#      安装包分发改走外链：-SetupUrlStable/-SetupUrlBeta/-SetupUrlDev 填网盘直链后，
#      对应 feed 的 files 块挂外链（哈希自动从 dist 包补齐），客户端应用内直接
#      下载安装。留空则客户端提示手动下载（updater 死局守卫，不再报原始错误）。
#   3) beta/dev 壳直接内嵌对应 dsh 运行时（junction 换血）：pack-runtime 透 junction
#      打 tar（w7 7.1.0 构建已实测可行）；pickRuntime 按实际运行时版本过滤，不会被
#      旧补丁链诱导降级，所以 beta/dev feed 不需要挂 0.1.7 补丁尾。
#   4) dev 10.3.0 需要 rt-alpha 树（此前已删）：脚本用「junction 指到 build\rt-alpha +
#      临时改 config.dshVersion + fetch-dsh 安装」自动重建（npmmirror 已确认有
#      0.1.7-alpha.2），首次多花约 250MB 下载时间；树建好后重跑自动跳过。
#   5) Pages 是整目录替换：六份 feed 必须一次传齐（本脚本已保证）。
#   6) build\dsh-runtime.tar 会被最后一次构建覆盖 —— w7 的 rc.2 tar 已备份为
#      build\dsh-runtime-0.1.7-rc.2-w7.tar.bak，脚本会校验它还在。
#
#  幂等性：所有状态切换（版本号/通道/junction）都可重入，中断后直接重跑即可。
#  时长预估：7.1.0 重打 ~3 分钟，10.1.0 / 10.2.0 / 7.2.0 / 7.3.0 各 ~8 分钟，10.3.0 首次再 +10 分钟。
#  （w7 beta/dev 走完整 fork 构建链：electronDist -> build/electron-win7 + junction 换血，
#   产物自带 installer.nsh 三件套清理；收尾自动恢复 7.1.0 载荷就绪态供 --prepackaged 重打。）
# ============================================================================

param(
    [switch]$SkipPack,        # 跳过全部四个构建（7.1.0 / 10.1.0 / 10.2.0 / 10.3.0）
    [switch]$SkipW7,          # 只跳过 7.1.0 重打
    [switch]$SkipW7Beta,      # 只跳过 7.2.0（已构建过时）
    [switch]$SkipW7Dev,       # 只跳过 7.3.0（已构建过时）
    [switch]$SkipStable,      # 只跳过 10.1.0（已构建过时）
    [switch]$SkipBeta,        # 只跳过 10.2.0
    [switch]$SkipDev,         # 只跳过 10.3.0（含 rt-alpha 重建）
    [switch]$SkipGen,         # 跳过 feed 生成
    [switch]$SkipWrangler,    # 跳过上传（只做本地暂存）
    [string]$BaseUrl     = 'https://dl.666-xrc.cc.cd',
    [string]$WranglerDir = 'C:\Users\Administrator\WorkBuddy\openlist\openlist-worker',
    [string]$StableVersion     = '10.1.0',
    [string]$BetaVersion       = '10.2.0',
    [string]$DevVersion        = '10.3.0',
    [string]$W7Version         = '7.1.0',
    [string]$W7BetaVersion     = '7.2.0',
    [string]$W7DevVersion      = '7.3.0',
    [string]$MainDshVersion    = '0.1.5-rc.3',     # 主线内嵌 dsh（latest 线）
    [string]$NextTreeDshVersion = '0.1.7-rc.2',    # build\rt-next 期望版本（next 线）
    [string]$DevDshVersion     = '0.1.7-alpha.2',  # dev 构建 / rt-alpha 树版本（alpha 线）
    # 安装包外链（网盘直链）：填了就挂进对应 feed 的 files 块，客户端走外链下载安装包，
    # sha256/size 自动从 dist 同名安装包补齐（下载完照常哈希校验）。留空 = 空骨架
    # （feed 不带安装包，客户端提示手动下载）。直链要求：程序可直接 GET（无验证码/登录校验、
    # token 长期有效），支持 Range 请求更佳（自动分片 + 断点续传，不支持也能单流下载）。
    [string]$SetupUrlStable = '',
    [string]$SetupUrlBeta   = '',
    [string]$SetupUrlDev    = '',
    [string]$SetupUrlW7     = '',
    [string]$SetupUrlW7Beta = '',
    [string]$SetupUrlW7Dev  = '',
    # 插件热更包 meta（scripts\pack-plugins.mjs 产物）。留空 = 自动取 build 下
    # 最新的 plugins-dshmarket-*.meta.json；挂进六份 feed 的 plugins 段后，
    # 在线用户（含已装的 beta/dev 壳）无需重下安装包即可升级插件。
    [string]$PluginsMeta    = ''
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $root
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

$PkgPath    = Join-Path $root 'package.json'
$CfgPath    = Join-Path $root 'resources\update-config.json'
$CfgW7Path  = Join-Path $root 'resources\update-config.w7.json'
$RtDir      = Join-Path $root 'resources\dsh-runtime'
$RtKeepName = 'dsh-runtime.keep-mainline'
$RtKeep     = Join-Path $root "resources\$RtKeepName"

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  . $msg" -ForegroundColor DarkGray }
function Warn($msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }

function Run-Node {
    param([string[]]$NodeArgs)
    $cmd = $NodeArgs -join ' '
    Info $cmd
    & node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "命令失败（exit=$LASTEXITCODE）：$cmd" }
}

# ---------------------------------------------------------------------------
# JSON 字段改写（正则定位、保留 BOM 与原格式，幂等：值相同则跳过）
# ---------------------------------------------------------------------------
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
    $enc = New-Object System.Text.UTF8Encoding($hasBom)
    [System.IO.File]::WriteAllText($File, $new, $enc)
    Ok "$Label : $old -> $NewValue"
}

function Set-PkgVersion  { param([string]$v) Set-JsonField $PkgPath '(?m)^(\s*"version":\s*")([^"]*)(")'   $v 'package.json version' }
function Set-DshVersion  { param([string]$v) Set-JsonField $PkgPath '("dshVersion":\s*")([^"]*)(")'          $v 'config.dshVersion' }
function Set-Channel     { param([string]$c) Set-JsonField $CfgPath '("channel":\s*")([^"]*)(")'             $c 'update-config channel' }

# package.json 临时写入/移除 electronDist（w7 fork 构建专用）。
# electron-builder 拿到 electronDist 就用本地 fork 44.2.0 发行目录当 Electron 运行时
# （7.1.0 首打的同款机制），asar 的 version 取自根 package.json —— 壳自报版本天然正确。
# 用完必须 Remove-ElectronDist，否则会污染后续主线构建（官方 44.0.0 会变成 fork）。
function Add-ElectronDist {
    param([string]$Dir)
    $raw = [System.IO.File]::ReadAllText($PkgPath)
    if ($raw -match '"electronDist"') { Info 'package.json electronDist 已存在（跳过插入）'; return }
    $m = [regex]::Match($raw, '(?m)^(\s*"name":\s*"[^"]+",\s*\r?\n)')
    if (-not $m.Success) { throw 'package.json 找不到 name 字段（electronDist 插入点）' }
    $ins = $m.Groups[1].Value + '  "electronDist": "' + ($Dir -replace '\\', '/') + '",' + "`r`n"
    $new = $raw.Substring(0, $m.Index) + $ins + $raw.Substring($m.Index + $m.Length)
    [System.IO.File]::WriteAllText($PkgPath, $new, (New-Object System.Text.UTF8Encoding($false)))
    Ok "package.json +electronDist = $Dir"
}
function Remove-ElectronDist {
    $raw = [System.IO.File]::ReadAllText($PkgPath)
    $new = [regex]::Replace($raw, '(?m)^\s*"electronDist":\s*"[^"]*",\s*\r?\n', '')
    if ($new -eq $raw) { return }   # 幂等：本来就没有就安静返回
    [System.IO.File]::WriteAllText($PkgPath, $new, (New-Object System.Text.UTF8Encoding($false)))
    Ok 'package.json -electronDist（还原主线官方 Electron）'
}

# ---------------------------------------------------------------------------
# junction 换血（幂等、崩溃可恢复）
#   真目录 resources\dsh-runtime <-> resources\dsh-runtime.keep-mainline + junction -> build\<tree>
# ---------------------------------------------------------------------------
function Test-Junction { param([string]$p)
    if (-not (Test-Path -LiteralPath $p)) { return $false }
    return ((Get-Item -LiteralPath $p -Force).LinkType -eq 'Junction')
}

function Restore-Runtime {
    if (Test-Junction $RtDir) {
        & cmd.exe /c rmdir "$RtDir"
        if ($LASTEXITCODE -ne 0) { throw "rmdir junction 失败：$RtDir" }
        if (-not (Test-Path -LiteralPath $RtKeep)) { throw "junction 已删但备份目录不在：$RtKeep（人工检查！真目录可能丢失）" }
        Rename-Item -LiteralPath $RtKeep -NewName 'dsh-runtime'
        Ok "junction 已还原为真目录（$RtKeepName 改回）"
    } elseif ((Test-Path -LiteralPath $RtDir) -and (Test-Path -LiteralPath $RtKeep)) {
        throw "resources\dsh-runtime 是真目录但 $RtKeepName 也存在（两副本冲突，人工比对后删掉多余的那个）"
    } elseif (-not (Test-Path -LiteralPath $RtDir)) {
        throw "resources\dsh-runtime 不存在！若 $RtKeepName 存在请手工改回，否则跑 npm run prepare:runtime"
    } else {
        Info '运行时目录为真目录（正常态，无需还原）'
    }
}

function Swap-RuntimeTo { param([string]$treeName)
    $target = Join-Path $root "build\$treeName"
    if (-not (Test-Path -LiteralPath $target)) { throw "运行时树不存在：$target" }
    if (Test-Junction $RtDir) {
        $cur = (Get-Item -LiteralPath $RtDir -Force).Target
        if ($cur -like "*$treeName") { Info "junction 已指向 $treeName（跳过）"; return }
        # 上次中断残留的 junction：先还原成真目录，再走正常换血
        if (Test-Path -LiteralPath $RtKeep) {
            Warn "检测到上次中断残留（junction -> $cur + keep 目录在），先还原"
            Restore-Runtime
        } else {
            throw "junction($cur) 与 keep 目录状态不一致，人工检查 $RtDir"
        }
    }
    if (Test-Path -LiteralPath $RtKeep) {
        throw "$RtKeepName 已存在且当前是真目录（上次中断残留两副本），人工比对后处理"
    }
    Rename-Item -LiteralPath $RtDir -NewName $RtKeepName
    & cmd.exe /c mklink /J "$RtDir" "$target" | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Junction $RtDir)) {
        Rename-Item -LiteralPath $RtKeep -NewName 'dsh-runtime' -ErrorAction SilentlyContinue
        throw "mklink 失败：$RtDir -> $target（已还原真目录）"
    }
    Ok "junction 换血完成：resources\dsh-runtime -> build\$treeName"
}

function Get-TreeDshVersion { param([string]$treePath)
    $p = Join-Path $treePath 'node_modules\@deepseek-ai\dsh\package.json'
    if (-not (Test-Path -LiteralPath $p)) { return '' }
    return ([regex]::Match((Get-Content -LiteralPath $p -Raw), '"version":\s*"([^"]+)"')).Groups[1].Value
}

# ---------------------------------------------------------------------------
# 二进制指纹扫描（流式 + 边界 carry，防大文件爆内存）
# ---------------------------------------------------------------------------
function Count-AsciiNeedle {
    param([string]$Path, [string]$Needle)
    $fs = [System.IO.File]::OpenRead($Path)
    try {
        $enc = [System.Text.Encoding]::ASCII
        $nb = $enc.GetBytes($Needle)
        $chunk = 8MB
        $buf = New-Object byte[] ($chunk + $nb.Length)
        $carryLen = 0
        $count = 0
        while ($true) {
            $n = $fs.Read($buf, $carryLen, $chunk)
            if ($n -le 0) { break }
            $len = $carryLen + $n
            $s = $enc.GetString($buf, 0, $len)
            $idx = $s.IndexOf($Needle, [System.StringComparison]::Ordinal)
            while ($idx -ge 0) {
                $count++
                if ($idx + $nb.Length -gt $s.Length) { break }
                $idx = $s.IndexOf($Needle, $idx + $nb.Length, [System.StringComparison]::Ordinal)
            }
            $carryLen = [Math]::Min($nb.Length - 1, $len)
            if ($carryLen -gt 0) { [Array]::Copy($buf, $len - $carryLen, $buf, 0, $carryLen) }
        }
        return $count
    } finally { $fs.Close() }
}

# ---------------------------------------------------------------------------
# 完整构建（tsc -> pack-runtime(透 junction) -> manifest -> dir -> payload -> NSIS）
# ---------------------------------------------------------------------------
function Invoke-FullBuild {
    param([string]$Version, [string]$Channel, [string]$Label)
    Set-PkgVersion $Version
    Set-Channel $Channel
    Info "${Label}：version=$Version channel=$Channel，npm run dist 开始（数分钟）…"
    & npm run dist
    if ($LASTEXITCODE -ne 0) { throw "npm run dist 失败（exit=$LASTEXITCODE）" }
    $exe = Join-Path $root "dist\DSH-Desktop-Setup-$Version.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "构建产物缺失：$exe" }
    if (-not (Test-Path -LiteralPath "$exe.blockmap")) { Warn "缺 blockmap（后续差分热更依赖它）：$exe.blockmap" }
    Ok "${Label}构建完成：DSH-Desktop-Setup-$Version.exe（$([math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)) MB）"
}

# w7 beta/dev 完整构建（复刻 7.1.0 首打的链，非 --prepackaged 载荷复用）：
#   electronDist -> fork 44.2.0 + 根 resources 换 w7 模板 + junction 换血到目标树
#   + npm run dist 全链（build -> pack-runtime(透 junction) -> manifest -> dir
#   -> prepare-payload -> NSIS）。
# asar 的 version 取自根 package.json，壳自报版本天然正确；产物自带当前 installer.nsh
# （含三件套清理——w7 覆盖安装的旧热壳/旧运行时残留从此根治）。
# 收尾恢复 7.1.0 载荷就绪态（tar/manifest/w7 模板三件），下次 --prepackaged 重打 7.1.0 不受影响。
function Invoke-W7Build {
    param([string]$Version, [string]$Tree, [string]$Label)
    $cfgBak = Join-Path $root 'build\.update-config.mainline.bak'
    Set-PkgVersion $Version
    Add-ElectronDist 'build/electron-win7'
    Copy-Item -LiteralPath $CfgPath  -Destination $cfgBak -Force   # 主线 update-config 备份
    Copy-Item -LiteralPath $CfgW7Path -Destination $CfgPath -Force # 根 resources 换 w7 模板（electron-builder 从这复制进载荷）
    try {
        Swap-RuntimeTo $Tree
        try {
            Info "${Label}：version=$Version electronDist=fork junction->$Tree，npm run dist 开始（数分钟）…"
            & npm run dist
            if ($LASTEXITCODE -ne 0) { throw "w7 npm run dist 失败（exit=$LASTEXITCODE）" }
        } finally { Restore-Runtime }
    } finally {
        Copy-Item -LiteralPath $cfgBak -Destination $CfgPath -Force   # 还原主线 update-config
        Remove-ElectronDist
    }
    $exe = Join-Path $root "dist\DSH-Desktop-Setup-$Version.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "w7 构建产物缺失：$exe" }
    Ok "${Label}构建完成：DSH-Desktop-Setup-$Version.exe（$([math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)) MB）"
}

# 收尾归位（幂等）：junction 还原 + 版本/通道回到主线 stable 态
function Restore-WorkingState {
    Remove-ElectronDist
    Restore-Runtime
    Set-PkgVersion $StableVersion
    Set-DshVersion $MainDshVersion
    Set-Channel 'stable'
}

try {

# ---------------------------------------------------------------------------
Step '0/7 环境自检'
# ---------------------------------------------------------------------------
Info "工作目录：$root"
foreach ($f in @($PkgPath, $CfgPath, $CfgW7Path)) {
    if (-not (Test-Path -LiteralPath $f)) { throw "缺少文件：$f" }
}
$rtNext = Join-Path $root 'build\rt-next'
$rtNextVer = Get-TreeDshVersion $rtNext
if ($rtNextVer -ne $NextTreeDshVersion) { throw "build\rt-next 版本异常：期望 $NextTreeDshVersion，实为 '$rtNextVer'" }
Ok "rt-next 树：dsh $rtNextVer"
$rtAlpha = Join-Path $root 'build\rt-alpha'
$rtAlphaVer = Get-TreeDshVersion $rtAlpha
if ($rtAlphaVer) { Info "rt-alpha 树已存在：dsh $rtAlphaVer" } else { Info 'rt-alpha 树不存在（dev 构建时会自动重建）' }
$w7TarBak = Join-Path $root 'build\dsh-runtime-0.1.7-rc.2-w7.tar.bak'
if (Test-Path -LiteralPath $w7TarBak) { Ok "w7 运行时 tar 备份在位（$([math]::Round((Get-Item -LiteralPath $w7TarBak).Length / 1MB, 0)) MB）" }
else { Warn "w7 tar 备份缺失：$w7TarBak（不影响本次发版，但 w7 补丁链后续要用）" }
if (-not (Test-Path -LiteralPath (Join-Path $WranglerDir 'node_modules\wrangler\bin\wrangler.js'))) { throw "找不到 wrangler：$WranglerDir" }
if (Test-Junction $RtDir) { Warn "当前 resources\dsh-runtime 是 junction（上次中断残留），构建前会自动处理" }
$pkgVer = ([regex]::Match((Get-Content -LiteralPath $PkgPath -Raw), '(?m)^\s*"version":\s*"([^"]+)"')).Groups[1].Value
Info "当前 package.json version = $pkgVer"
Info "dist 现有安装包：$((@(Get-ChildItem 'dist\DSH-Desktop-Setup-*.exe' -ErrorAction SilentlyContinue) | ForEach-Object { $_.Name }) -join ', ')"

# ---------------------------------------------------------------------------
Step "1/7 w7 stable $W7Version（fork 完整构建，junction -> rt-next，内嵌 dsh $NextTreeDshVersion）"
# ---------------------------------------------------------------------------
# 废弃旧的「--prepackaged 载荷复用」路径：win-unpacked 的就绪态会被主线构建覆盖
# （官方 44.0.0 的 V8 串与补丁后 fork 一致，指纹校验有盲区；tar 尺寸也会变），靠状态
# 复用太脆弱。现在 7.1.0 与 7.2.0/7.3.0 走同一条完整 fork 链，任何时候重跑结果一致。
if ($SkipPack -or $SkipW7) {
    Info '跳过'
} else {
    Invoke-W7Build -Version $W7Version -Tree 'rt-next' -Label 'w7 stable'
}

# ---------------------------------------------------------------------------
Step "2/7 主线 stable $StableVersion（内嵌 dsh $MainDshVersion）"
# ---------------------------------------------------------------------------
if ($SkipPack -or $SkipStable) {
    Info '跳过'
} else {
    Restore-Runtime        # 防上次中断残留 junction
    Remove-ElectronDist    # 防上次中断残留 fork 指向（会污染主线构建的 Electron）
    $rtVer = Get-TreeDshVersion $RtDir
    if ($rtVer -ne $MainDshVersion) {
        throw "resources\dsh-runtime 版本异常：期望 $MainDshVersion，实为 '$rtVer'（先跑 npm run prepare:runtime）"
    }
    Invoke-FullBuild -Version $StableVersion -Channel 'stable' -Label '主线 stable'

    # ── 降级热壳 ×2（供 beta/dev 壳切回 stable 时整体滚回用）─────────────────
    # pickHot 只按 baseVersion 过滤（installed >= base 即可用）不看方向，10.2.0/10.3.0
    # 的壳切回 stable 时命中这里打包的变体、套上 10.1.0 壳代码；10.1.0 用户因
    # 版本低于 base 天然隔离。必须趁 out/ 还是 10.1.0 产物时打（步骤 3 会覆盖它）。
    $hotRollback = @(Get-ChildItem "build\hot-shell-$StableVersion-*.tar" -ErrorAction SilentlyContinue)
    if ($hotRollback.Count -ge 2) {
        Info "降级热壳已存在（$($hotRollback.Count) 个），跳过"
    } else {
        foreach ($base in @($BetaVersion, $DevVersion)) {
            Run-Node @('scripts\pack-hot.mjs', '--version', $StableVersion, '--base', $base)
        }
        Ok "降级热壳完成（base=$BetaVersion / $DevVersion -> version=$StableVersion）"
    }
}

# ---------------------------------------------------------------------------
Step "3/7 主线 beta $BetaVersion（junction -> rt-next，内嵌 dsh $NextTreeDshVersion）"
# ---------------------------------------------------------------------------
if ($SkipPack -or $SkipBeta) {
    Info '跳过'
} else {
    try {
        Swap-RuntimeTo 'rt-next'
        $treeVer = Get-TreeDshVersion $RtDir
        if ($treeVer -ne $NextTreeDshVersion) { throw "junction 后树版本异常：$treeVer" }
        Invoke-FullBuild -Version $BetaVersion -Channel 'beta' -Label '主线 beta'
    } finally {
        Restore-Runtime
    }
}

# ---------------------------------------------------------------------------
Step "4/7 主线 dev $DevVersion（junction -> rt-alpha，内嵌 dsh $DevDshVersion）"
# ---------------------------------------------------------------------------
if ($SkipPack -or $SkipDev) {
    Info '跳过'
} else {
    try {
        # rt-alpha 树此前已删：先建空骨架目录 junction 才有落点（fetch-dsh 随后往里装，
        # 它不删目标目录、junction 透明穿透，npm install 会落位到 build\rt-alpha）
        $rtAlphaDir = Join-Path $root 'build\rt-alpha'
        if (-not (Test-Path -LiteralPath $rtAlphaDir)) {
            New-Item -ItemType Directory -Path $rtAlphaDir -Force | Out-Null
            Info '已创建 build\rt-alpha 空骨架（fetch-dsh 稍后在此安装）'
        }
        Swap-RuntimeTo 'rt-alpha'
        $treeVer = Get-TreeDshVersion $RtDir
        if ($treeVer -ne $DevDshVersion) {
            Info "rt-alpha 树版本('$treeVer') != $DevDshVersion，用 fetch-dsh 重建（首次约 250MB 下载）…"
            Set-DshVersion $DevDshVersion
            try {
                Run-Node @('scripts\fetch-dsh.mjs')
            } finally {
                Set-DshVersion $MainDshVersion   # 无论成败都还原，避免污染后续构建
            }
            $treeVer = Get-TreeDshVersion $RtDir
            if ($treeVer -ne $DevDshVersion) { throw "rt-alpha 重建后版本仍不对：'$treeVer'" }
        }
        Invoke-FullBuild -Version $DevVersion -Channel 'dev' -Label '主线 dev'
    } finally {
        Restore-Runtime
    }

    # ── 运行时降级差分 ×2（此时 junction 已还原，resources\dsh-runtime = 主线 rc.3 树）──
    # pack-runtime-patch 方向任意：--from 高版本树 --to 主线树 → meta 里
    # baseVersion=高版本、version=主线版本。壳的 pickRuntime 按
    # baseVersion===当前运行时精确匹配（已支持降级方向），beta(rc.2) / dev(alpha.2)
    # 用户切回 stable 时各取所需；stable(rc.3) 用户无精确基线且已是最新，天然跳过。
    foreach ($p in @(
        @{ From = 'build\rt-next';  Tag = $NextTreeDshVersion },
        @{ From = 'build\rt-alpha'; Tag = $DevDshVersion }
    )) {
        $meta = @(Get-ChildItem "dist\update\dsh-runtime-patch-$($p.Tag)-to-$MainDshVersion*.meta.json" -ErrorAction SilentlyContinue)
        if ($meta.Count) { Info "降级差分已存在，跳过：$($p.Tag) -> $MainDshVersion"; continue }
        if (-not (Test-Path -LiteralPath (Join-Path $root $p.From))) {
            if ($p.Tag -eq $DevDshVersion) { Warn "rt-alpha 树不存在，跳过 alpha 降级差分（后续补跑）"; continue }
            throw "差分源树缺失：$($p.From)"
        }
        Run-Node @('scripts\pack-runtime-patch.mjs', '--from', $p.From, '--to', 'resources\dsh-runtime',
                   '--out', 'dist\update', '--chunk-mb', '20')
        Ok "降级差分完成：$($p.Tag) -> $MainDshVersion"
    }
}

# ---------------------------------------------------------------------------
Step "4b/7 w7 beta $W7BetaVersion（fork 构建，junction -> rt-next，内嵌 dsh $NextTreeDshVersion）"
# ---------------------------------------------------------------------------
if ($SkipPack -or $SkipW7 -or $SkipW7Beta) {
    Info '跳过'
} else {
    Invoke-W7Build -Version $W7BetaVersion -Tree 'rt-next' -Label 'w7 beta'
}

# ---------------------------------------------------------------------------
Step "4c/7 w7 dev $W7DevVersion（fork 构建，junction -> rt-alpha，内嵌 dsh $DevDshVersion）"
# ---------------------------------------------------------------------------
if ($SkipPack -or $SkipW7 -or $SkipW7Dev) {
    Info '跳过'
} else {
    if (-not (Get-TreeDshVersion $rtAlpha)) {
        throw "build\rt-alpha 树不存在——先跑一次主线 dev（不带 -SkipDev）让 fetch-dsh 重建它，再补 w7 dev"
    }
    Invoke-W7Build -Version $W7DevVersion -Tree 'rt-alpha' -Label 'w7 dev'
}

# ---------------------------------------------------------------------------
Step '5/7 生成六份 feed（全部 --hot-only 空骨架；Pages 整目录替换，版本号一次到位）'
# ---------------------------------------------------------------------------
if ($SkipGen) {
    Info '跳过'
} else {
    function Invoke-Feed {
        param([string]$Version, [string]$Channel, [string]$Notes, [string[]]$Extra = @(), [string]$SetupUrl = '')
        $nodeArgs = @('scripts\gen-update-json.mjs', '--base-url', $BaseUrl, '--version', $Version,
                      '--channel', $Channel, '--notes', $Notes) + $Extra
        if ($SetupUrl) { $nodeArgs += @('--setup-url', $SetupUrl) } else { $nodeArgs += '--hot-only' }
        if ($pluginsMeta) { $nodeArgs += @('--plugins', $pluginsMeta) }
        Run-Node $nodeArgs
        $suffix = if ($SetupUrl) { '（安装包走外链）' } else { '' }
        Ok "已生成 dist\update\latest$(if ($Channel -ne 'stable') { '-' + $Channel }).json$suffix"
    }
    # 插件热更包：dshmarket 的客户端捆了宿主 ui-primitives 的图标名（…14/…16），
    # dsh 0.1.7-alpha.1 把图标改名为 …Regular/…Medium 且删了旧导出 → beta/dev 壳的
    # 插件市场 React #130。上游 1.66.1 加了双代解析（icons.ts），换包即修。
    $pluginsMeta = $PluginsMeta
    if (-not $pluginsMeta) {
        $cand = @(Get-ChildItem 'build\plugins-dshmarket-*.meta.json' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1)
        if ($cand.Count) { $pluginsMeta = $cand[0].FullName }
    }
    if ($pluginsMeta) { Ok "插件热更包：$pluginsMeta" } else { Info '未挂插件热更包（feed 无 plugins 段）' }
    # stable feed 额外挂降级资源（热壳变体 ×2 + 运行时降级差分 ×2）：
    # beta/dev 壳切回 stable 后轮询 latest.json，壳版本(10.2.0/10.3.0) > feed 版本(10.1.0)
    # 不触发 shellOutdated，全靠 rt 精确基线命中触发 available → hot+rt 一起落位 → 整体滚回。
    $stableExtra = @()
    foreach ($h in @(Get-ChildItem "build\hot-shell-$StableVersion-*.tar" -ErrorAction SilentlyContinue)) {
        $stableExtra += @('--hot', $h.FullName)
    }
    foreach ($tag in @($NextTreeDshVersion, $DevDshVersion)) {
        $meta = @(Get-ChildItem "dist\update\dsh-runtime-patch-$tag-to-$MainDshVersion*.meta.json" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
        if ($meta.Count) { $stableExtra += @('--runtime', $meta[0].FullName) }
        else { Warn "缺降级差分 meta：$tag -> $MainDshVersion（stable feed 将不含该回滚链）" }
    }
    Invoke-Feed $StableVersion 'stable'  "$StableVersion 稳定版（dsh latest $MainDshVersion，含 beta/dev 回滚链）—— 通道方案 v2 首版" $stableExtra $SetupUrlStable
    Invoke-Feed $BetaVersion   'beta'    "$BetaVersion 测试版（dsh next $NextTreeDshVersion）" @() $SetupUrlBeta
    Invoke-Feed $DevVersion    'dev'     "$DevVersion 开发版（dsh alpha $DevDshVersion）" @() $SetupUrlDev
    Invoke-Feed $W7Version     'w7'      "$W7Version 稳定版（w7 专用，dsh next $NextTreeDshVersion）" @() $SetupUrlW7
    Invoke-Feed $W7BetaVersion 'w7-beta' "$W7BetaVersion 测试版（w7，dsh next $NextTreeDshVersion）" @() $SetupUrlW7Beta
    Invoke-Feed $W7DevVersion  'w7-dev'  "$W7DevVersion 开发版（w7，dsh alpha $DevDshVersion）" @() $SetupUrlW7Dev
    foreach ($v in @($StableVersion, $BetaVersion, $DevVersion, $W7Version, $W7BetaVersion, $W7DevVersion)) {
        if (Test-Path -LiteralPath "dist\DSH-Desktop-Setup-$v.exe") {
            $u = switch ($v) {
                $StableVersion { $SetupUrlStable }
                $BetaVersion   { $SetupUrlBeta }
                $DevVersion    { $SetupUrlDev }
                $W7Version     { $SetupUrlW7 }
                $W7BetaVersion { $SetupUrlW7Beta }
                $W7DevVersion  { $SetupUrlW7Dev }
                default        { '' }
            }
            if ($u) { Ok "安装包在位 + 外链已挂 feed：DSH-Desktop-Setup-$v.exe" }
            else { Ok "安装包在位（feed 未挂外链，客户端将提示手动下载）：DSH-Desktop-Setup-$v.exe" }
        }
        else { Warn "缺 dist\DSH-Desktop-Setup-$v.exe（feed 生成不受影响，但该版本没有可分发的安装包）" }
    }
}

# ---------------------------------------------------------------------------
Step '6/7 暂存 + 部署到 Cloudflare Pages（六份 feed 一次传齐）'
# ---------------------------------------------------------------------------
$allFeeds = @('latest.json', 'latest-beta.json', 'latest-dev.json',
              'latest-w7.json', 'latest-w7-beta.json', 'latest-w7-dev.json')
$dpArgs = New-Object System.Collections.ArrayList
[void]$dpArgs.Add('scripts\deploy-pages.mjs')
[void]$dpArgs.Add('--project');  [void]$dpArgs.Add('dsh-desktop-feed')
[void]$dpArgs.Add('--base-url'); [void]$dpArgs.Add($BaseUrl)
foreach ($f in $allFeeds) {
    $p = "dist\update\$f"
    if (-not (Test-Path -LiteralPath $p)) { throw "缺少 feed：$p" }
    [void]$dpArgs.Add('--feed'); [void]$dpArgs.Add($p)
}
[void]$dpArgs.Add('--stage-only')
Run-Node $dpArgs.ToArray()

$stagePtr = 'dist\update\.stage-dir'
if (-not (Test-Path -LiteralPath $stagePtr)) { throw 'deploy-pages 没写出暂存指针' }
$stage = (Get-Content -LiteralPath $stagePtr -Raw).Trim()
if (-not (Test-Path -LiteralPath $stage)) { throw "暂存目录不存在：$stage" }
Ok "暂存目录：$stage"
Get-ChildItem -LiteralPath $stage | ForEach-Object { Info ('  ' + $_.Name + '  ' + [math]::Round($_.Length / 1KB, 1) + ' KB') }

if ($SkipWrangler) {
    Warn '-SkipWrangler：未上传。手动上传命令：'
    Write-Host "  cd $WranglerDir"
    Write-Host "  node node_modules\wrangler\bin\wrangler.js pages deploy `"$stage`" --project-name dsh-desktop-feed --branch main --commit-dirty=true"
} else {
    Push-Location $WranglerDir
    try {
        & node node_modules\wrangler\bin\wrangler.js pages deploy $stage `
            --project-name dsh-desktop-feed --branch main --commit-dirty=true
        if ($LASTEXITCODE -ne 0) { throw 'wrangler 部署失败' }
    } finally { Pop-Location }
    Ok '六份 feed 已部署'
}

# ---------------------------------------------------------------------------
Step '7/7 线上核验 + 现场归位'
# ---------------------------------------------------------------------------
$cb = Get-Date -Format yyyyMMddHHmmss
foreach ($f in $allFeeds) {
    $raw = curl.exe -s ($BaseUrl + '/' + $f + '?cb=' + $cb)
    if (-not $raw) { Warn "$f 拉取失败（可能 CDN 延迟，稍后手动核验）"; continue }
    $j = $raw | ConvertFrom-Json
    Write-Host ('  {0,-22} version={1,-8} channel={2}' -f $f, $j.version, $j.channel) -ForegroundColor White
}
Restore-WorkingState
Ok '现场已归位：version=10.1.0 / dshVersion=0.1.5-rc.3 / channel=stable / 运行时目录还原'
Ok '全部完成'

} finally {
    # 兜底：任何一步 throw 都会走到这里（幂等，已还原则自动跳过）
    Write-Host ''
    try { Restore-WorkingState } catch { Warn "兜底归位异常：$($_.Exception.Message)（请手工检查 junction 与 package.json）" }
}
