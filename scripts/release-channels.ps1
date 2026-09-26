# DSH Desktop 分通道发版脚本
#
#   通道 <-> dsh 版本线：stable = latest / beta = next / dev = alpha
#
# 幂等设计：已存在的产物（热壳、差分、feed）会自动跳过，所以中断后可以直接重跑，
# 也可以只跑后半段（-SkipPack 跳过打包，-SkipWrangler 只暂存不上传）。
#
# 用法（在本机 PowerShell 里跑，不要走沙箱 —— 沙箱 IO 太慢）：
#   powershell -ExecutionPolicy Bypass -File scripts\release-channels.ps1
#   .\scripts\release-channels.ps1 -SkipPack        # 产物已就绪，直接生成 feed + 部署
#   .\scripts\release-channels.ps1 -SkipWrangler    # 只做本地暂存，不上传
#
# 注意：NODE_OPTIONS 里被注入了 node-language-shim，会拦 npm/node 的批量删除，必须清掉。
param(
    [switch]$SkipPack,          # 跳过打热壳 + 打差分
    [switch]$SkipWrangler,      # 跳过上传（只做本地暂存）
    [switch]$SkipGen,           # 连 feed 生成也跳过（用现成的 latest*.json）
    [string]$BetaVersion = '1.1.24-beta.1',
    [string]$DevVersion  = '1.1.24-dev.1',
    [string]$BaseUrl     = 'https://dl.666-xrc.cc.cd',
    [string]$WranglerDir = 'C:\Users\Administrator\WorkBuddy\openlist\openlist-worker'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $root
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "  . $msg" -ForegroundColor DarkGray }
function Fail($msg) { Write-Host "  [!!] $msg" -ForegroundColor Red }

# 每跑一个 node 脚本就查一次退出码
function Run-Node {
    param([string[]]$NodeArgs)
    $cmd = $NodeArgs -join ' '
    Info $cmd
    & node @NodeArgs
    if ($LASTEXITCODE -ne 0) { throw "命令失败（exit=$LASTEXITCODE）：$cmd" }
}

# dsh 版本线：beta -> next，dev -> alpha（版本变了就改 build\rt-<line> 里的树）
$lines = @(
    @{ Tag = 'beta'; Line = 'next';  Tree = 'build\rt-next';  Feed = 'latest-beta.json' },
    @{ Tag = 'dev';  Line = 'alpha'; Tree = 'build\rt-alpha'; Feed = 'latest-dev.json'  }
)

# ---------------------------------------------------------------------------
Step '1/6 热更新壳（beta / dev 各三档基线）'
# ---------------------------------------------------------------------------
if ($SkipPack) {
    Info '-SkipPack：跳过'
} else {
    foreach ($v in @($BetaVersion, $DevVersion)) {
        $have = @(Get-ChildItem "build\hot-shell-$v-*.tar" -ErrorAction SilentlyContinue)
        if ($have.Count -ge 3) { Info "已有 $($have.Count) 个热壳，跳过 $v"; continue }
        # ⚠️ 顺序必须是 baseVersion 降序（w7 > 1.1.13 > 1.1.1）：gen-update-json 会再按降序排，
        # 但客户端 pickHot 对「同版本多变体」按数组顺序取第一个能用的，而老引导器按
        # baseVersion === 安装版严格相等选壳 —— 顺序错了用户会永远停在旧壳（实测踩过）。
        foreach ($b in @('1.1.14-w7', '1.1.13', '1.1.1')) {
            Run-Node @('scripts\pack-hot.mjs', '--version', $v, '--base', $b)
        }
        Ok "热壳完成：$v"
    }
}

# ---------------------------------------------------------------------------
Step '2/6 运行时差分补丁（并发）'
# ---------------------------------------------------------------------------
if ($SkipPack) {
    Info '-SkipPack：跳过'
} else {
    foreach ($l in $lines) {
        if (-not (Test-Path "$($l.Tree)\node_modules\@deepseek-ai\dsh")) {
            throw "缺少运行时树 $($l.Tree)：先把 $($l.Line) 版本装进去（注意别加 --prefer-offline）"
        }
    }
    $j1 = $null
    $j2 = $null
    $jobs = New-Object System.Collections.ArrayList
    foreach ($l in $lines) {
        $pkg = Get-Content "$($l.Tree)\node_modules\@deepseek-ai\dsh\package.json" -Raw | ConvertFrom-Json
        $meta = @(Get-ChildItem "dist\update\*-to-$($pkg.version)*.meta.json" -ErrorAction SilentlyContinue)
        if ($meta.Count) { Info "差分已存在，跳过：$($l.Line) -> $($pkg.version)"; continue }
        Info "启动差分任务：$($l.Line) -> $($pkg.version)"
        $job = Start-Job -ScriptBlock {
            param($r, $tree)
            Set-Location $r
            Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
            & node scripts\pack-runtime-patch.mjs --from resources\dsh-runtime --to $tree --out dist\update --chunk-mb 20
        } -ArgumentList $root, $l.Tree
        [void]$jobs.Add($job)
    }
    if ($jobs.Count) {
        $jobs | Wait-Job | Out-Null
        foreach ($j in $jobs) {
            Receive-Job $j
            if ($j.State -ne 'Completed') { throw "差分任务失败：$($j.Name)" }
        }
        $jobs | Remove-Job
    }
    Ok '差分完成'
}

# ---------------------------------------------------------------------------
Step '3/6 生成 beta / dev 两份 feed（stable 的 latest.json 不动）'
# ---------------------------------------------------------------------------
if ($SkipGen) {
    Info '-SkipGen：跳过'
} else {
    $hotB = @(Get-ChildItem "build\hot-shell-$BetaVersion-*.tar" -ErrorAction SilentlyContinue).FullName
    $hotD = @(Get-ChildItem "build\hot-shell-$DevVersion-*.tar"  -ErrorAction SilentlyContinue).FullName
    if ($hotB.Count -lt 3) { throw "热壳不足：$BetaVersion（找到 $($hotB.Count) 个）" }
    if ($hotD.Count -lt 3) { throw "热壳不足：$DevVersion（找到 $($hotD.Count) 个）" }

    function HotArgs($files) {
        $a = New-Object System.Collections.ArrayList
        foreach ($f in $files) { [void]$a.Add('--hot'); [void]$a.Add($f) }
        return , $a.ToArray()
    }
    $aB = HotArgs $hotB
    $aD = HotArgs $hotD

    # 基础链：rc.1 -> rc.2 -> rc.3（老用户先爬到 rc.3，再去 next / alpha）
    $rtBase = @(
        'dist\update\dsh-runtime-patch-0.1.5-rc.1-to-0.1.5-rc.2.tar.gz',
        'dist\update\dsh-runtime-patch-0.1.5-rc.2-to-0.1.5-rc.3-da2dd5bd.tar.gz'
    )
    $pluginMeta = @(Get-ChildItem 'build\plugins-updater-*.meta.json' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending)[0].FullName
    if (-not $pluginMeta) { throw '找不到 plugins meta：先跑 pack-plugins.mjs --name updater' }
    Info "插件包：$pluginMeta"

    foreach ($l in $lines) {
        $isBeta = $l.Tag -eq 'beta'
        if ($isBeta) { $ver = $BetaVersion; $hot = $aB; $label = '测试版' }
        else         { $ver = $DevVersion;  $hot = $aD; $label = '开发版' }

        $pkg = Get-Content "$($l.Tree)\node_modules\@deepseek-ai\dsh\package.json" -Raw | ConvertFrom-Json
        $lineVer = $pkg.version
        $meta = @(Get-ChildItem "dist\update\*-to-$lineVer*.meta.json" -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)[0].FullName
        if (-not $meta) { throw "找不到差分 meta：$lineVer" }

        $rtArgs = New-Object System.Collections.ArrayList
        foreach ($r in $rtBase) { [void]$rtArgs.Add('--runtime'); [void]$rtArgs.Add($r) }
        [void]$rtArgs.Add('--runtime'); [void]$rtArgs.Add($meta)

        $notes = $label + '：dsh 跟进 ' + $l.Line + '（' + $lineVer + '）+ 分通道更新'

        $nodeArgs = New-Object System.Collections.ArrayList
        [void]$nodeArgs.Add('scripts\gen-update-json.mjs')
        [void]$nodeArgs.Add('--base-url'); [void]$nodeArgs.Add($BaseUrl)
        [void]$nodeArgs.Add('--version');  [void]$nodeArgs.Add($ver)
        [void]$nodeArgs.Add('--channel');  [void]$nodeArgs.Add($l.Tag)
        foreach ($h in $hot)     { [void]$nodeArgs.Add($h) }
        foreach ($r in $rtArgs)  { [void]$nodeArgs.Add($r) }
        [void]$nodeArgs.Add('--plugins');  [void]$nodeArgs.Add($pluginMeta)
        [void]$nodeArgs.Add('--hot-only')
        [void]$nodeArgs.Add('--notes');    [void]$nodeArgs.Add($notes)
        Run-Node $nodeArgs.ToArray()
        Ok "已生成 dist\update\$($l.Feed)"
    }
}

# ---------------------------------------------------------------------------
Step '4/6 暂存（三份 feed 必须一次传齐：Pages 是整目录替换）'
# ---------------------------------------------------------------------------
$stagePtr = 'dist\update\.stage-dir'
Remove-Item $stagePtr -ErrorAction SilentlyContinue

$feedArgs = New-Object System.Collections.ArrayList
foreach ($f in @('latest.json', 'latest-beta.json', 'latest-dev.json')) {
    $p = "dist\update\$f"
    if (-not (Test-Path $p)) { throw "缺少 feed：$p" }
    [void]$feedArgs.Add('--feed'); [void]$feedArgs.Add($p)
}
# 顺带把两份通道的热壳也塞进去（其实 feed 里的 URL 已经会带上，这里只是双保险）
$hotArgs = New-Object System.Collections.ArrayList
foreach ($f in @(Get-ChildItem 'build\hot-shell-1.1.24-*.tar' -ErrorAction SilentlyContinue).FullName) {
    [void]$hotArgs.Add('--hot'); [void]$hotArgs.Add($f)
}

$dpArgs = New-Object System.Collections.ArrayList
[void]$dpArgs.Add('scripts\deploy-pages.mjs')
[void]$dpArgs.Add('--project');  [void]$dpArgs.Add('dsh-desktop-feed')
[void]$dpArgs.Add('--base-url'); [void]$dpArgs.Add($BaseUrl)
foreach ($a in $feedArgs) { [void]$dpArgs.Add($a) }
foreach ($a in $hotArgs)  { [void]$dpArgs.Add($a) }
[void]$dpArgs.Add('--stage-only')
Run-Node $dpArgs.ToArray()

if (-not (Test-Path $stagePtr)) { throw 'deploy-pages 没写出暂存指针' }
$stage = (Get-Content $stagePtr -Raw).Trim()
if (-not (Test-Path $stage)) { throw "暂存目录不存在：$stage" }
Ok "暂存目录：$stage"
Get-ChildItem $stage | ForEach-Object { Info ('  ' + $_.Name + '  ' + [math]::Round($_.Length / 1KB, 1) + ' KB') }

# ---------------------------------------------------------------------------
Step '5/6 上传到 Cloudflare Pages'
# ---------------------------------------------------------------------------
if ($SkipWrangler) {
    Info '-SkipWrangler：跳过上传。手动上传命令：'
    Write-Host "  cd $WranglerDir"
    Write-Host "  node node_modules\wrangler\bin\wrangler.js pages deploy `"$stage`" --project-name dsh-desktop-feed --branch main --commit-dirty=true"
} else {
    Push-Location $WranglerDir
    try {
        & node node_modules\wrangler\bin\wrangler.js pages deploy $stage `
            --project-name dsh-desktop-feed --branch main --commit-dirty=true
        if ($LASTEXITCODE -ne 0) { throw 'wrangler 部署失败' }
    } finally { Pop-Location }
    Ok '部署完成'
}

# ---------------------------------------------------------------------------
Step '6/6 线上核验'
# ---------------------------------------------------------------------------
$cb = Get-Date -Format yyyyMMddHHmmss
foreach ($f in @('latest.json', 'latest-beta.json', 'latest-dev.json')) {
    $raw = curl.exe -s ($BaseUrl + '/' + $f + '?cb=' + $cb)
    if (-not $raw) { Fail "$f 拉取失败"; continue }
    $j = $raw | ConvertFrom-Json
    $names = New-Object System.Collections.ArrayList
    foreach ($r in @($j.runtime)) {
        if ($r.parts) { [void]$names.Add($r.version + '(' + $r.parts.Count + '片)') }
        else          { [void]$names.Add($r.version) }
    }
    Write-Host ('  {0,-18} {1,-16} channel={2,-7} runtime: {3}' -f $f, $j.version, $j.channel, ($names -join ' -> '))
}
foreach ($f in @('latest-beta.json', 'latest-dev.json')) {
    $j = (curl.exe -s ($BaseUrl + '/' + $f + '?cb=' + $cb)) | ConvertFrom-Json
    $big = @($j.runtime | Where-Object { $_.parts })[0]
    if (-not $big) { continue }
    $code = curl.exe -s -o NUL -w '%{http_code}' ($BaseUrl + '/' + $big.parts[0])
    Write-Host ('  分片抽查 ' + $big.parts[0] + ' -> ' + $code)
    if ($code -ne '200') { Fail '分片不可达' }
}
Ok '完成'
