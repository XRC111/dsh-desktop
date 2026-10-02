<#
.SYNOPSIS
    枚举屏幕上（或指定窗口内）所有 UI 元素及其**精确屏幕坐标**。

.DESCRIPTION
    为什么需要它：模型从截图里**目测估算**按钮坐标，典型误差 10-40px，
    而按钮本身只有 24-32px 高 —— 这就是「老是点偏」的根因。
    UI Automation 能直接给出每个控件的真实边界矩形，误差 0。

    用 PowerShell 的 UIAutomationClient（Windows 自带，零依赖）。

.PARAMETER Filter
    按名称子串过滤（不区分大小写）。留空返回全部。

.PARAMETER Hwnd
    只枚举该窗口内的元素。留空则枚举整个桌面。

.PARAMETER Types
    只要这些控件类型（逗号分隔，如 Button,Edit,MenuItem）。留空=全部。

.PARAMETER Max
    最多返回多少条（默认 200，避免一次吐几千条把上下文撑爆）。
#>
[CmdletBinding()]
param(
    [string]$Filter = '',
    [string]$Hwnd = '',
    [string]$Types = '',
    [int]$Max = 200
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

# 指定窗口时：先按 hwnd 找到该窗口元素，再在它下面找
if ($Hwnd) {
    $h = [intptr][long]$Hwnd
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NativeWindowHandleProperty, $h)
    $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if (-not $win) {
        # 兜底：整个桌面找（有些窗口不在顶层 children 里）
        $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    }
    if (-not $win) { Write-Output '[]'; exit 0 }
    $scope = $win
} else {
    $scope = $root
}

$wantTypes = @()
if ($Types) { $wantTypes = $Types.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

# 控件类型白名单：只要**可交互**的，跳过海量纯文本节点（816 个 Text 里绝大多数是噪声）
$interactive = @('Button','Edit','MenuItem','TabItem','ListItem','CheckBox','RadioButton',
                 'ComboBox','Hyperlink','TreeItem','DataItem','Slider','Spinner','SplitButton',
                 'ToggleButton','MenuItem','Tab','ToolBar','Menu')

$all = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                      [System.Windows.Automation.Condition]::TrueCondition)

$out = New-Object System.Collections.ArrayList
$q = $Filter.ToLower()
foreach ($e in $all) {
    try {
        $r = $e.Current.BoundingRectangle
        if ($r.Width -le 0 -or $r.Height -le 0) { continue }
        if ($r.Width -lt 3 -or $r.Height -lt 3) { continue }   # 太小的忽略
        $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        if ($wantTypes.Count) {
            if ($ct -notin $wantTypes) { continue }
        } elseif ($ct -notin $interactive) {
            continue
        }
        $n = $e.Current.Name
        if ($q) {
            if (-not $n -or $n.ToLower() -notlike "*$q*") { continue }
        }
        # 是否可点（Invoke 模式）—— 直接告诉模型「这个能点」
        $clickable = $false
        try {
            $p = $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            if ($p) { $clickable = $true }
        } catch { }
        [void]$out.Add([pscustomobject]@{
            name = $n; type = $ct
            x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
            cx = [int]($r.X + $r.Width / 2); cy = [int]($r.Y + $r.Height / 2)
            enabled = $e.Current.IsEnabled; clickable = $clickable
        })
        if ($out.Count -ge $Max) { break }
    } catch { }
}

$out | ConvertTo-Json -Compress -Depth 3