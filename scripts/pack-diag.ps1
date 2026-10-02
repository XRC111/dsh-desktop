<#
.SYNOPSIS
    打包诊断脚本：一步一步跑，每步单独留日志，失败就停并告诉你看哪个文件。

.DESCRIPTION
    给「本机打包失败但 CI 能过」这类问题用的排查工具。

    为什么需要它：
      npm run dist 是一条长链（tsc → 工具 → runtime tar → electron-builder dir
      → prepare-payload → electron-builder nsis），中间任何一步炸了，
      错误信息都被 npm 的包装糊掉，而且**失败前还会把 dist 里同名的成品
      安装包覆盖成 0.2MB 的中间 stub** —— 排查一次就毁一个包。

    这个脚本做的事：
      1. 开跑前先把 dist 里的成品安装包备份到 dist-backup（默认开，-SkipBackup 关）
      2. 每一步单独计时、单独写日志到 build/pack-diag/
      3. 失败立刻停，打印：哪一步、退出码、日志路径、日志最后 25 行
      4. NSIS 失败时额外做「stub 体检」（单独把中间安装器跑一遍看退出码）

    安全：本脚本不会杀任何进程，不会动安装目录，不会上传任何东西。

.PARAMETER Version
    要打的版本号，例如 10.1.9。默认读 package.json 当前的 version。
    建议每次用一个新号，避免覆盖已有成品。

.PARAMETER Step
    all   跑完整条链（默认）
    dir   只跑到 electron-builder --win dir（产出 dist/win-unpacked）
    nsis  只跑 NSIS 那一步（要求 dir 已经产出）
    stub  只给上一次留下的 stub 做体检，不重新打包

.PARAMETER SkipBackup
    不备份 dist 里的成品（省时间，但失败时会覆盖同名成品）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\pack-diag.ps1 -Version 10.1.9
        跑完整链，版本号 10.1.9

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\pack-diag.ps1 -Version 10.1.9 -Step nsis
        只重跑 NSIS（dir 已经成功过时用这个省时间）

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\pack-diag.ps1 -Step stub
        给上一次留下的 stub 做体检
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [ValidateSet('all','dir','nsis','stub')]
    [string]$Step = 'all',
    [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$logDir  = Join-Path $root 'build\pack-diag'
$null = New-Item -ItemType Directory -Force -Path $logDir

# 让子进程输出不被代理 / NODE_OPTIONS 干扰
$env:NODE_OPTIONS    = $null
$env:http_proxy      = ''
$env:https_proxy     = ''
$env:all_proxy       = ''
$env:npm_config_registry              = 'https://registry.npmmirror.com'
$env:ELECTRON_MIRROR                  = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  [FAIL] $m" -ForegroundColor Red }
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Yellow }

function Show-Tail {
    param([string]$Path, [int]$N = 25)
    if (-not (Test-Path $Path)) { return }
    $lines = Get-Content $Path -Tail $N -EA SilentlyContinue
    Write-Host "    ---- 日志末尾 ----" -ForegroundColor DarkGray
    foreach ($l in $lines) { Write-Host "    $l" -ForegroundColor DarkGray }
    Write-Host "    ------------------" -ForegroundColor DarkGray
}

function Invoke-Step {
    param([string]$Name, [string]$LogFile, [scriptblock]$Body)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Write-Host "    运行: $Name"
    # 子进程把 stderr 合并进来时（2>&1），PowerShell 会把每一行 stderr 包成
    # ErrorRecord；而脚本顶部是 $ErrorActionPreference='Stop'，于是 npm 的
    # **warning 也会抛异常**——哪怕退出码是 0。实测 npm run build 在 stderr 打
    # 一条 `npm warn Unknown project config ...` 就足以让本步变成「抛异常」，
    # 真正的编译输出反而被这个异常顶掉了。
    # 这里只在调用子进程的局部作用域内放宽成 Continue：让 stderr 正常落进
    # $out（完整写进日志），成败只由 $LASTEXITCODE 决定。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & $Body 2>&1
        $code = $LASTEXITCODE
        $out | Out-File -FilePath $LogFile -Encoding utf8
        $sw.Stop()
        if ($code -ne 0) {
            Fail "$Name 失败（exit=$code）$([math]::Round($sw.Elapsed.TotalSeconds,1))s"
            Info "日志: $LogFile"
            Show-Tail $LogFile 25
            return $false
        }
        Ok "$Name 完成 $([math]::Round($sw.Elapsed.TotalSeconds,1))s"
        return $true
    } catch {
        $sw.Stop()
        Fail "$Name 抛异常: $($_.Exception.Message)"
        Show-Tail $LogFile 25
        return $false
    } finally {
        $ErrorActionPreference = $prevEap
    }
}

# ── 版本号 ────────────────────────────────────────────────────────────────
$pkgPath = Join-Path $root 'package.json'
# 同样要显式 UTF-8（见 Set-PkgVersion 里的说明），否则读到乱码 JSON 直接解析失败。
$origVersion = ([System.IO.File]::ReadAllText($pkgPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json).version
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $origVersion
    Info "未指定 -Version，用 package.json 的 $Version"
}

function Set-PkgVersion {
    param([string]$V)
    # ⚠️ 必须显式指定 UTF-8。package.json 是**无 BOM** 的 UTF-8，而
    # `Get-Content -Raw` 在 Windows PowerShell 5.1 下按系统 ANSI 代码页解码
    # （本机 gb2312）→ 中文变乱码，且破折号「—」(U+2014, e2 80 94) 被 GBK
    # 解读后产生的孤立字节会在写回时吃掉字符串结尾的引号，JSON 直接非法。
    # 症状：build 报 EJSONPARSE "Bad control character in string literal"。
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $t = [System.IO.File]::ReadAllText($pkgPath, $utf8)
    # 用 MatchEvaluator 而不是替换串：版本号以数字开头时（如 10.1.9），
    # 替换串里的 $1 会被 .NET 解析成命名组 $110，导致 "version": " 整段被吃掉。
    $t = [regex]::Replace($t, '("version":\s*")[^"]+(")', { param($m) $m.Groups[1].Value + $V + $m.Groups[2].Value })
    [System.IO.File]::WriteAllText($pkgPath, $t, $utf8)
}

# ── stub 体检 ─────────────────────────────────────────────────────────────
# electron-builder 的 NSIS 目标会先编一个「中间安装器」（带 BUILD_UNINSTALLER），
# 然后**执行它**让它把 uninstaller 吐出来（NsisTarget.js 里 wineVm.exec）。
# 本机就是这一步拿到 exit 2。这个体检单独把 stub 跑一遍，把退出码摆出来。
function Test-Stub {
    param([string]$V)
    Step "stub 体检"
    $stub = Join-Path $root "dist\DSH-Desktop-Setup-$V.exe"
    if (-not (Test-Path $stub)) {
        Fail "找不到 stub: $stub"
        Info "先跑 -Step nsis 让它失败一次，stub 会留在 dist 里。"
        return
    }
    $len = (Get-Item $stub).Length
    Info "stub: $stub"
    Info "大小: $([math]::Round($len/1KB,1)) KB"
    if ($len -gt 10MB) {
        Info "这个尺寸是**完整安装包**，不是中间 stub —— 上次 NSIS 其实成功了。"
        return
    }

    $uni = Join-Path $root "dist\DSH-Desktop-Setup-$V.__uninstaller.exe"
    if (Test-Path $uni) { Remove-Item $uni -Force -EA SilentlyContinue }

    $env:__COMPAT_LAYER = 'RunAsInvoker'
    $p = Start-Process -FilePath $stub -Wait -PassThru
    $env:__COMPAT_LAYER = $null
    Info "stub 退出码 = $($p.ExitCode)   （electron-builder 期待 0）"
    if (Test-Path $uni) {
        Ok "产出了 uninstaller: $([math]::Round((Get-Item $uni).Length/1KB,1)) KB"
    } else {
        Fail "没有产出 uninstaller —— stub 在 .onInit 里就退出了，没走到 WriteUninstaller"
        Info "NSIS exit 2 = 在 .onInit 阶段中止。"
    }
}

# ── 备份 dist 成品 ────────────────────────────────────────────────────────
if (-not $SkipBackup -and $Step -ne 'stub') {
    Step '备份 dist 里的成品安装包'
    $bak = Join-Path $root 'dist-backup'
    $null = New-Item -ItemType Directory -Force -Path $bak
    $n = 0
    Get-ChildItem (Join-Path $root 'dist') -Filter 'DSH-Desktop-Setup-*.exe' -EA SilentlyContinue |
        Where-Object { $_.Length -gt 10MB } |
        ForEach-Object {
            Copy-Item $_.FullName (Join-Path $bak $_.Name) -Force
            $n++
        }
    Ok "已备份 $n 个成品 → $bak"
}

if ($Step -eq 'stub') { Test-Stub -V $Version; exit 0 }

# ── 主流程 ────────────────────────────────────────────────────────────────
try {
    Set-PkgVersion $Version
    Info "版本号 → $Version"

    if ($Step -eq 'all') {
        Step '1/6 tsc + copy-static'
        if (-not (Invoke-Step 'build' (Join-Path $logDir '1-build.log') { npm run build })) { exit 1 }

        Step '2/6 内置 git/python'
        if (-not (Invoke-Step 'prepare-tools' (Join-Path $logDir '2-tools.log') { node scripts/prepare-tools.mjs })) { exit 1 }

        Step '3/6 打运行时 tar'
        if (-not (Invoke-Step 'pack-runtime' (Join-Path $logDir '3-runtime.log') { node scripts/pack-runtime.mjs })) { exit 1 }

        Step '4/6 运行时清单'
        if (-not (Invoke-Step 'gen-manifest' (Join-Path $logDir '4-manifest.log') { node scripts/gen-runtime-manifest.mjs })) { exit 1 }
    }

    if ($Step -eq 'all' -or $Step -eq 'dir') {
        Step '5/6 electron-builder --win dir'
        if (-not (Invoke-Step 'dir' (Join-Path $logDir '5-dir.log') {
            npx electron-builder --win dir --x64 --publish never
        })) { exit 1 }
        if (-not (Invoke-Step 'prepare-payload' (Join-Path $logDir '5b-payload.log') {
            node scripts/prepare-payload.mjs
        })) { exit 1 }
    }

    if ($Step -eq 'all' -or $Step -eq 'nsis') {
        Step '6/6 electron-builder --win nsis'
        $ok = Invoke-Step 'nsis' (Join-Path $logDir '6-nsis.log') {
            npx electron-builder --win nsis --x64 --publish never --prepackaged dist/win-unpacked
        }
        if (-not $ok) {
            Write-Host ""
            Fail "NSIS 失败 —— 这就是本机那个 exit 2"
            Test-Stub -V $Version
            exit 1
        }
        $exe = Join-Path $root "dist\DSH-Desktop-Setup-$Version.exe"
        if (Test-Path $exe) {
            Ok "产出: $exe  $([math]::Round((Get-Item $exe).Length/1MB,1)) MB"
        }
        exit 0
    }

    Ok "全部完成"
} finally {
    Set-PkgVersion $origVersion
    Info "版本号已还原 → $origVersion"
}
