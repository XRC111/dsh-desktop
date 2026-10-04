<#
.SYNOPSIS
    发版：跟版 dsh 0.1.7-rc.2 / 0.2.0-rc.2（六通道全量）。

.DESCRIPTION
    这是对 scripts\release-v2.ps1 的**薄封装**：把本次发版要用的版本号、外链、
    插件白名单一次性写死，避免手敲六个外链参数出错。真正的逻辑仍在 release-v2.ps1。

    版本矩阵（用户拍板，避开 0.2.0 的破坏性变更）：
      stable -> dsh 0.1.7-rc.2    （官方没有 0.1.7 正式版，rc.2 是该线最后一版）
      beta   -> dsh 0.2.0-rc.2    （官方 latest/next 都指向它）
      dev    -> dsh 0.2.0-rc.2    （官方没有 0.2.0-alpha）

    为什么 stable 不跟 0.2.0：0.2.0 收紧了插件 peer 校验，声明 ^0.1.x 的插件
    会被静默禁用。本次外壳已加兼容层（src/main/plugin-compat.ts）自动写官方豁免，
    但仍按用户要求把 stable 锁在 0.1.7 线，0.2.0 先在 beta/dev 验证。

    三段式（推荐按顺序跑）：
      ① .\scripts\release-017-020.ps1 -Stage build    # 构建 6 个包 + 打热壳/差分 + 生成 feed
      ② 手动把 6 个安装包传到 GitHub Release（tag = 日期-序号，脚本会打印）
      ③ .\scripts\release-017-020.ps1 -Stage deploy   # 重新生成 feed（挂上外链哈希）+ 部署

    也可以一次跑完（-Stage all），但那样 feed 里的安装包哈希会是空的
    （因为包还没上传），客户端只能靠 HEAD 兜底探测大小。

.EXAMPLE
    # 第一步：构建 + 暂存（不部署），约 45-60 分钟
    .\scripts\release-017-020.ps1 -Stage build

.EXAMPLE
    # 只重建某几个通道（其余跳过）
    .\scripts\release-017-020.ps1 -Stage build -Only stable,beta

.EXAMPLE
    # 第三步：部署
    .\scripts\release-017-020.ps1 -Stage deploy
#>

[CmdletBinding()]
param(
    # 发版阶段：
    #   build  = 构建 + 打热壳/差分 + 生成 feed + 暂存（不部署）
    #   deploy = 跳过构建与生成，直接暂存 + 部署（用于安装包已传完后的收尾）
    #   all    = 一次跑完（构建 + 部署）
    [ValidateSet('build', 'deploy', 'all')]
    [string]$Stage = 'build',

    # 只跑指定通道（默认全部六个）。例：-Only stable,w7
    [string[]]$Only = @(),

    # 部署阶段跳过 wrangler 上传（只本地暂存，便于人工核对）
    [switch]$SkipUpload,

    # 干跑：只打印将要执行的命令，不真正执行
    [switch]$DryRun,

    # 跳过「安装包是否已上传到 release」的检查（默认**不跳**）。
    # 拦的是最常见的翻车：包还没传就发 feed → 客户端更新链接全是 404，上线后才发现。
    [switch]$SkipAssetCheck
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── 输出函数（必须定义在**第一次使用之前**：PowerShell 是顺序执行，
#    定义写在使用之后就报「术语 'Info' 不会被识别为 cmdlet」）────────────
function Info($m) { Write-Host "  . $m" -ForegroundColor DarkGray }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!!] $m" -ForegroundColor Yellow }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# ── 本次发版的版本号（改这里就能发下一版）────────────────────────────────────
$Versions = [ordered]@{
    Stable = '10.1.12'   # 主线 stable（dsh 0.1.7-rc.2）
    Beta   = '10.2.11'   # 主线 beta  （dsh 0.2.0-rc.2）
    Dev    = '10.3.10'   # 主线 dev   （dsh 0.2.0-rc.2）
    W7     = '7.1.13'   # w7 stable  （dsh 0.1.7-rc.2）
    W7Beta = '7.2.10'    # w7 beta    （dsh 0.2.0-rc.2）
    W7Dev  = '7.3.10'    # w7 dev     （dsh 0.2.0-rc.2）
}

# ── 安装包外链（GitHub Release；tag = 日期-序号，每次发版一个）──────────────
# 以前所有版本共用 `packages` tag，堆到 35 个资产、横跨十几版，找某一版很难。
# 现在按 scripts/release-tag.mjs 的规则算（如 2026.10.01-1）。
$ReleaseTag = if ($env:DSH_RELEASE_TAG) { $env:DSH_RELEASE_TAG } else { (node scripts/release-tag.mjs).Trim() }
Info "本次 release tag = $ReleaseTag"
$GhPrefix = "https://gh-proxy.com/https://github.com/XRC111/dsh-desktop/releases/download/$ReleaseTag"
$SetupUrls = [ordered]@{}
foreach ($k in $Versions.Keys) {
    $SetupUrls[$k] = "$GhPrefix/DSH-Desktop-Setup-$($Versions[$k]).exe"
}

# ── 组装 release-v2.ps1 的参数 ────────────────────────────────────────────────
$skip = @{
    Stable = '-SkipStable'
    Beta   = '-SkipBeta'
    Dev    = '-SkipDev'
    W7     = '-SkipW7'
    W7Beta = '-SkipW7Beta'
    W7Dev  = '-SkipW7Dev'
}
$all = @('Stable', 'Beta', 'Dev', 'W7', 'W7Beta', 'W7Dev')

# -Only 的解析有两个坑（都实测过）：
#   1) `powershell -File x.ps1 -Only stable,beta` **不会**按逗号拆成数组 ——
#      -File 模式下整个 "stable,beta" 是**一个字符串**（只有脚本内直接调用才拆）。
#   2) 用户更可能写小写，而我们的通道名是首字母大写。
# 所以这里手工按逗号/分号拆开，再做不区分大小写的匹配。
if ($Only.Count) {
    $wanted = @()
    foreach ($raw in $Only) {
        foreach ($o in ($raw -split '[,;]')) {
            $name = $o.Trim()
            if (-not $name) { continue }
            $hit = @($all | Where-Object { $_ -eq $name })   # 字符串 -eq 默认不区分大小写
            if ($hit.Count -eq 0) { throw "-Only 里有未知通道：$name（可选：$($all -join ', ')）" }
            if ($wanted -notcontains $hit[0]) { $wanted += $hit[0] }
        }
    }
    if ($wanted.Count -eq 0) { throw '-Only 没解析出任何通道' }
} else {
    $wanted = $all
}

$psArgs = New-Object System.Collections.ArrayList
[void]$psArgs.Add('-ExecutionPolicy'); [void]$psArgs.Add('Bypass')
[void]$psArgs.Add('-File'); [void]$psArgs.Add('scripts\release-v2.ps1')

# nightly runs in CI only - never build it locally (without -SkipNightly, release-v2.ps1 tries a source build and throws)
[void]$psArgs.Add('-SkipNightly')

# 未选中的通道 → 加对应的 -Skip 开关
foreach ($k in $all) {
    if ($wanted -notcontains $k) { [void]$psArgs.Add($skip[$k]) }
}

# 版本号 + 外链
foreach ($k in $all) {
    [void]$psArgs.Add("-$($k)Version"); [void]$psArgs.Add($Versions[$k])
}
foreach ($k in $all) {
    [void]$psArgs.Add("-SetupUrl$k"); [void]$psArgs.Add($SetupUrls[$k])
}

switch ($Stage) {
    'build' {
        # 构建 + 生成 feed + 暂存，但**不部署**（人工核对后再 deploy）
        [void]$psArgs.Add('-SkipWrangler')
    }
    'deploy' {
        # 包已传完 → 只重新生成 feed（这次能算到本地包的哈希）+ 部署
        [void]$psArgs.Add('-SkipPack')
    }
    'all' {
        # 一次跑完；若不想自动上传就加 -SkipUpload
        if ($SkipUpload) { [void]$psArgs.Add('-SkipWrangler') }
    }
}

# ── 执行前自检 ────────────────────────────────────────────────────────────────
# ── 插件打包（含上游同步 + 版本号迭代）─────────────────────────────────────
# 放在自检之前：自检第 4 项要核「插件 meta 齐备」，而 build/ 不入库，
# 换机器就是空的 —— 先打齐再看，才不会报一堆假的「缺 meta」。
# 也必须在 release-v2.ps1 之前：它按 build/ 下的 meta 挂 feed。
if ($Stage -ne 'deploy') {
    Step '打包插件（内容变了会自动迭代版本号）'
    if ($DryRun) {
        Warn '-DryRun：只打印，不执行'
        Info 'node scripts\pack-all-plugins.mjs --dry-run'
    } else {
        & node scripts\pack-all-plugins.mjs
        if ($LASTEXITCODE -ne 0) { throw "插件打包失败（exit=$LASTEXITCODE）" }
    }
}

Step '发版前自检'

Info "阶段：$Stage"
Info "通道：$($wanted -join ', ')"

# 1) 版本号不能与已有安装包撞车（deploy 阶段除外——那时包已构建好）
if ($Stage -ne 'deploy') {
    foreach ($k in $wanted) {
        $v = $Versions[$k]
        $exe = "dist\DSH-Desktop-Setup-$v.exe"
        if (Test-Path -LiteralPath $exe) {
            Warn "$exe 已存在（会覆盖）。若要换版本号，改脚本顶部的 `$Versions。"
        }
    }
}

# 2) 运行时树版本必须与预期一致（stable=0.1.7-rc.2 / beta,dev=0.2.0-rc.2）
$treeExpect = [ordered]@{
    'resources\dsh-runtime' = '0.1.7-rc.2'
    'build\rt-next'         = '0.2.0-rc.2'
    'build\rt-alpha'        = '0.2.0-rc.2'
}
$treeBad = 0
foreach ($t in $treeExpect.Keys) {
    $f = Join-Path $t 'node_modules\@deepseek-ai\dsh\package.json'
    if (-not (Test-Path -LiteralPath $f)) { Warn "树缺失：$t"; $treeBad++; continue }
    $actual = (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json).version
    if ($actual -ne $treeExpect[$t]) { Warn "树版本不符：$t 期望 $($treeExpect[$t])，实为 $actual"; $treeBad++ }
    else { Ok "$t = $actual" }
}
if ($treeBad -gt 0 -and $Stage -ne 'deploy') {
    throw "有 $treeBad 棵运行时树版本不符，先修正再发版（见 README 的运行时树布局）"
}

# 3) 升级差分源（老 stable 用户热更用）
foreach ($t in @('build\rt-015')) {
    if (Test-Path -LiteralPath (Join-Path $t 'node_modules\@deepseek-ai\dsh\package.json')) {
        $v = (Get-Content -LiteralPath (Join-Path $t 'node_modules\@deepseek-ai\dsh\package.json') -Raw | ConvertFrom-Json).version
        Ok "升级差分源 $t = $v"
    } else { Warn "升级差分源缺失：$t（老用户将拿不到运行时热更）" }
}

# 4) 插件 meta 齐备
# 清单以 scripts/plugins.json 为准（与 pack-all-plugins.mjs 同一份），避免两处走样
$pluginListFile = Join-Path $PSScriptRoot 'plugins.json'
$pluginNames = if (Test-Path $pluginListFile) {
    @((Get-Content -Raw -Encoding UTF8 $pluginListFile | ConvertFrom-Json).plugins | ForEach-Object { $_.name })
} else { @('dshmarket', 'shell', 'updater', 'link') }
foreach ($n in $pluginNames) {
    # 必须按 mtime 取最新（与 release-v2.ps1 的探测逻辑一致）；
    # 直接取 $c[0] 会拿到**字母序第一个**（可能是 1.0.0 而最新是 1.1.0），显示会误导。
    $c = @(Get-ChildItem "build\plugins-$n-*.meta.json" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)
    if ($c.Count) {
        $ver = (Get-Content -LiteralPath $c[0].FullName -Raw | ConvertFrom-Json).version
        Ok "插件 $n：$($c[0].Name)  [$ver]"
    } else { Warn "缺插件 meta：$n（先跑 node scripts\pack-plugins.mjs --name $n）" }
}

# 5) wrangler 登录态（deploy / all 阶段需要）
if ($Stage -ne 'build' -and -not $SkipUpload) {
    $cfg = "$env:APPDATA\xdg.config\.wrangler\config\default.toml"
    if (Test-Path $cfg) {
        $exp = (Select-String -Path $cfg -Pattern 'expiration_time' | Select-Object -First 1).Line
        Ok "wrangler 凭据存在（$($exp.Trim())，有 refresh_token 会自动续）"
    } else { Warn 'wrangler 未登录 → 部署会失败，先跑 npx wrangler login' }
}

# 6) 安装包必须真的已经在 release 上 —— 否则 feed 挂的全是 404 链接，
#    而且要等客户端点「更新」才会发现。gh-proxy 对 HEAD 不友好，用 Range 取 1 字节探测。
if ($Stage -ne 'build' -and -not $SkipAssetCheck) {
    $missing = @()
    foreach ($k in $wanted) {
        $u = $SetupUrls[$k]
        $code = (& curl.exe -sS -o NUL -w '%{http_code}' --noproxy '*' --ssl-no-revoke -L -r 0-0 --max-time 30 $u 2>$null)
        if ("$code" -notmatch '^(200|206)$') { $missing += "$k $($Versions[$k]) → HTTP $code" }
    }
    if ($missing.Count) {
        foreach ($m in $missing) { Warn "安装包还下不到：$m" }
        throw ("有 $($missing.Count) 个安装包不在 release $ReleaseTag 上。" + [Environment]::NewLine +
               "  先把 dist\DSH-Desktop-Setup-<版本>.exe 传到这里：" + [Environment]::NewLine +
               "    https://github.com/XRC111/dsh-desktop/releases/tag/$ReleaseTag" + [Environment]::NewLine +
               "  再跑 -Stage deploy。（确认要跳过检查就加 -SkipAssetCheck）")
    }
    Ok "$($wanted.Count) 个安装包都已在 release $ReleaseTag 上可下载"
}
# ── 执行 ──────────────────────────────────────────────────────────────────────
Step "执行 release-v2.ps1（$Stage）"

$cmdLine = 'powershell ' + ($psArgs -join ' ')
Info "命令：$cmdLine"

if ($DryRun) {
    Warn '-DryRun：只打印，不执行'
    return
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
& powershell @psArgs
$code = $LASTEXITCODE
$sw.Stop()

Step '结果'
if ($code -ne 0) {
    Warn "release-v2.ps1 退出码 $code（耗时 $([math]::Round($sw.Elapsed.TotalMinutes,1)) 分钟）"
    Warn '现场归位由 release-v2.ps1 的 try/finally 兜底；若中断，检查 package.json 的 version 与 junction'
    exit $code
}
Ok "完成（耗时 $([math]::Round($sw.Elapsed.TotalMinutes,1)) 分钟）"

# ── 收尾提示 ──────────────────────────────────────────────────────────────────
if ($Stage -eq 'build') {
    Step '下一步'
    Info "1) 把下面这些安装包传到 GitHub Release（tag=$ReleaseTag）："
    foreach ($k in $wanted) {
        $v = $Versions[$k]
        $exe = "dist\DSH-Desktop-Setup-$v.exe"
        if (Test-Path -LiteralPath $exe) {
            $mb = [math]::Round((Get-Item -LiteralPath $exe).Length / 1MB, 1)
            Write-Host "     $exe（$mb MB）"
        }
    }
    Info '2) 传完后跑：.\scripts\release-017-020.ps1 -Stage deploy'
    Info '   （deploy 会重新生成 feed，这次能算到本地安装包的 sha256/size）'
}

if ($Stage -eq 'deploy') {
    Step '部署后核验（务必自己拉一次，别只看脚本输出）'
    Info 'curl.exe -s "https://dl.666-xrc.cc.cd/latest.json?cb=$(Get-Date -Format yyyyMMddHHmmss)"'
    Info '要确认：版本号、hot 变体（含前向壳）、runtime 差分、plugins 数组'
    Warn '注意：-SkipWrangler 时脚本第 7 步的「线上核验」跑在上传之前，是假的'
}
