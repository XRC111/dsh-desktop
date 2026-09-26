<#
  DSH Desktop - Install/update a plugin without reinstalling the app.

  Usage (one line, no admin rights needed):
    irm https://dl.666-xrc.cc.cd/install-plugin.ps1 | iex

  Options:
    irm https://dl.666-xrc.cc.cd/install-plugin.ps1 | iex -ArgumentList ...   # not needed; use:
    & ([scriptblock]::Create((irm https://dl.666-xrc.cc.cd/install-plugin.ps1)))

  What it does:
    1) reads <BaseUrl>/latest.json  -> .plugins  (url / parts / sha256 / size)
    2) downloads the package (reassembling part files when the host splits them)
    3) verifies size + SHA256 (refuses to install anything that does not match)
    4) unpacks it into:
         %APPDATA%\DSH-Desktop\plugins\<name>                          (managed location)
         %APPDATA%\DSH-Desktop\dsh-home\profiles\node_modules\<name>    (takes effect now)
    5) tells you to restart DSH Desktop
#>
param(
    [string]$BaseUrl = 'https://dl.666-xrc.cc.cd',
    [string]$Name = ''
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

function Say($m) { Write-Host "[dsh-plugin] $m" }

Say "checking feed: $BaseUrl/latest.json"
$feed = Invoke-RestMethod -Uri "$BaseUrl/latest.json" -UseBasicParsing
$info = $feed.plugins
if (-not $info) {
    Say 'the feed does not publish a plugins section - nothing to install.'
    return
}
Say ("plugin package: {0}  ({1} bytes)" -f $info.version, $info.size)

$tmp = Join-Path $env:TEMP ("dsh-plugin-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$pack = Join-Path $tmp 'package.tar.gz'
$parts = @()
if ($info.parts) { $parts = @($info.parts) }
elseif ($info.url) { $parts = @($info.url) }

if ($parts.Count -eq 0) { Say 'no url/parts in the feed'; return }

Say ("downloading {0} file(s)..." -f $parts.Count)
$i = 0
$out = New-Object System.IO.FileStream($pack, [System.IO.FileMode]::Create)
try {
    foreach ($u in $parts) {
        $i++
        $chunk = Join-Path $tmp ("part{0:D2}" -f $i)
        Invoke-WebRequest -Uri $u -OutFile $chunk -UseBasicParsing
        $bytes = [System.IO.File]::ReadAllBytes($chunk)
        $out.Write($bytes, 0, $bytes.Length)
        Remove-Item $chunk -Force
        Say ("  part {0}/{1} ok ({2} KB)" -f $i, $parts.Count, [math]::Round($bytes.Length / 1KB))
    }
}
finally { $out.Close() }

$actual = (Get-Item $pack).Length
if ($info.size -and $actual -ne [int64]$info.size) {
    throw "size mismatch: expected $($info.size), got $actual"
}
$hash = (Get-FileHash -Path $pack -Algorithm SHA256).Hash.ToLower()
if ($hash -ne ($info.sha256.ToLower())) {
    throw "sha256 mismatch: expected $($info.sha256), got $hash"
}
Say 'checksum OK'

Say 'unpacking...'
$extract = Join-Path $tmp 'x'
New-Item -ItemType Directory -Path $extract -Force | Out-Null
& tar.exe -xzf $pack -C $extract
if ($LASTEXITCODE -ne 0) { throw "tar failed (exit $LASTEXITCODE)" }

$pluginName = $Name
if (-not $pluginName) {
    $dirs = Get-ChildItem -Path $extract -Directory
    if ($dirs.Count -eq 0) { throw 'nothing inside the package' }
    $pluginName = $dirs[0].Name
}
$src = Join-Path $extract $pluginName
if (-not (Test-Path $src)) { throw "package does not contain '$pluginName'" }

$targets = @(
    (Join-Path $env:APPDATA "DSH-Desktop\plugins\$pluginName"),
    (Join-Path $env:APPDATA "DSH-Desktop\dsh-home\profiles\node_modules\$pluginName")
)
foreach ($t in $targets) {
    Say "installing -> $t"
    if (Test-Path $t) { Remove-Item -Path $t -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $t -Parent) -Force | Out-Null
    Copy-Item -Path $src -Destination $t -Recurse -Force
}

Remove-Item -Path $tmp -Recurse -Force

Say 'done.'
Write-Host ''
Write-Host "  Plugin '$pluginName' installed." -ForegroundColor Green
Write-Host '  Please restart DSH Desktop (quit from the tray and start it again) to activate it.' -ForegroundColor Yellow
Write-Host ''
