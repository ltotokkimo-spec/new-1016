# 在 Windows 上實際啟動小畫家 exe：用真的滑鼠和鍵盤畫圖，檢查畫布上的顏色、存檔、關閉前的詢問。
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$OutDir = "smoke-paint"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class W {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, IntPtr e);
    public static void Down() { mouse_event(2, 0, 0, 0, IntPtr.Zero); }
    public static void Up() { mouse_event(4, 0, 0, 0, IntPtr.Zero); }
}
"@

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$exportFile = Join-Path $OutDir "canvas.png"
$infoFile = Join-Path $OutDir "info.json"
$env:PAINT_TEST_EXPORT = $exportFile
$env:PAINT_TEST_INFO = $infoFile

function Find-App {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like "*小畫家" -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
}

function Save-Shot([string]$name, [switch]$FullScreen) {
    if ($FullScreen) {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $left = $b.Left; $top = $b.Top; $w = $b.Width; $h = $b.Height
    } else {
        $r = New-Object W+RECT
        [W]::GetWindowRect($script:hwnd, [ref]$r) | Out-Null
        $left = $r.Left; $top = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    }
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
    $bmp.Save((Join-Path $OutDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "截圖 $name.png（${w}x${h}）"
}

# 畫布座標 → 螢幕座標
function Screen-Point([int]$x, [int]$y) { return @(($script:cx + $x), ($script:cy + $y)) }

function Drag([array]$points) {
    $p = Screen-Point $points[0][0] $points[0][1]
    [W]::SetCursorPos($p[0], $p[1]) | Out-Null
    Start-Sleep -Milliseconds 60
    [W]::Down()
    foreach ($pt in $points[1..($points.Count - 1)]) {
        $p = Screen-Point $pt[0] $pt[1]
        [W]::SetCursorPos($p[0], $p[1]) | Out-Null
        Start-Sleep -Milliseconds 25
    }
    [W]::Up()
    Start-Sleep -Milliseconds 300
}

function Line-Points($x1, $y1, $x2, $y2, $steps = 12) {
    $pts = @()
    for ($i = 0; $i -le $steps; $i++) {
        $pts += , @([int]($x1 + ($x2 - $x1) * $i / $steps), [int]($y1 + ($y2 - $y1) * $i / $steps))
    }
    return , $pts
}

function Click-Canvas($x, $y) { Drag @(@($x, $y), @($x, $y)) }

function Click-Swatch([string]$color) {
    $p = $script:info.swatches.$color
    [W]::SetCursorPos($p[0], $p[1]) | Out-Null
    Start-Sleep -Milliseconds 60
    [W]::Down(); [W]::Up()
    Start-Sleep -Milliseconds 200
}

function Keys([string]$keys) {
    [System.Windows.Forms.SendKeys]::SendWait($keys)
    Start-Sleep -Milliseconds 250
}

function Read-Pixel([int]$x, [int]$y) {
    for ($i = 0; $i -lt 10; $i++) {
        try {
            $bytes = [IO.File]::ReadAllBytes($exportFile)
            $ms = New-Object IO.MemoryStream (, $bytes)
            $bmp = [System.Drawing.Bitmap]::FromStream($ms)
            $c = $bmp.GetPixel($x, $y)
            $bmp.Dispose(); $ms.Dispose()
            return "#{0:x2}{1:x2}{2:x2}" -f $c.R, $c.G, $c.B
        } catch { Start-Sleep -Milliseconds 200 }
    }
    throw "讀不到畫布輸出檔"
}

function Assert-Pixel([int]$x, [int]$y, [string]$expected, [string]$step) {
    $actual = ""
    for ($i = 0; $i -lt 15; $i++) {
        $actual = Read-Pixel $x $y
        if ($actual -eq $expected) { break }
        Start-Sleep -Milliseconds 200
    }
    if ($actual -ne $expected) { Save-Shot "失敗畫面"; throw "$step：畫布 ($x, $y) 應為 $expected，實際是 $actual" }
    Write-Host "通過 $step（($x, $y) = $actual）"
}

function Assert-AllWhite([int]$x1, [int]$y1, [int]$x2, [int]$y2, [string]$step) {
    $bytes = [IO.File]::ReadAllBytes($exportFile)
    $ms = New-Object IO.MemoryStream (, $bytes)
    $bmp = [System.Drawing.Bitmap]::FromStream($ms)
    $left = 0
    for ($x = $x1; $x -le $x2; $x++) {
        for ($y = $y1; $y -le $y2; $y++) {
            $c = $bmp.GetPixel($x, $y)
            if ($c.R -ne 255 -or $c.G -ne 255 -or $c.B -ne 255) { $left++ }
        }
    }
    $bmp.Dispose(); $ms.Dispose()
    if ($left -gt 0) { Save-Shot "失敗畫面"; throw "$step：範圍內還有 $left 個沒擦乾淨的像素" }
    Write-Host "通過 $step"
}

$BLACK = "#000000"; $WHITE = "#ffffff"; $RED = "#ed1c24"; $BLUE = "#00a2e8"; $YELLOW = "#ffc90e"

# ---------- 啟動 ----------
$launcher = Start-Process -FilePath $ExePath -PassThru
Write-Host "已啟動 $ExePath"
$app = $null
for ($i = 0; $i -lt 120 -and -not ($app -and (Test-Path $infoFile)); $i++) {
    Start-Sleep -Milliseconds 500
    if ($launcher.HasExited -and $launcher.ExitCode -ne 0) { throw "程式啟動失敗，結束代碼 $($launcher.ExitCode)" }
    $app = Find-App
}
if (-not $app) { throw "60 秒內沒有出現小畫家視窗" }
if (-not (Test-Path $infoFile)) { throw "程式沒有寫出位置資訊" }
$script:hwnd = $app.MainWindowHandle
$appPid = $app.Id
Start-Sleep -Seconds 1
$script:info = Get-Content $infoFile -Raw | ConvertFrom-Json
$script:cx = $info.canvas[0]; $script:cy = $info.canvas[1]
Write-Host "找到視窗「$($app.MainWindowTitle)」，畫布在螢幕 ($cx, $cy)，大小 $($info.canvas[2])x$($info.canvas[3])"
if ($info.canvas[2] -ne 800 -or $info.canvas[3] -ne 520) { throw "畫布大小不對" }
Save-Shot "1-start"

# 視窗要完整落在螢幕可用範圍內（不能被工作列擋住）
$r = New-Object W+RECT
[W]::GetWindowRect($script:hwnd, [ref]$r) | Out-Null
$work = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
if ($r.Bottom -gt $work.Bottom + 8 -or $r.Right -gt $work.Right + 8) {
    throw "視窗超出螢幕可用範圍：視窗 ($($r.Left),$($r.Top))-($($r.Right),$($r.Bottom))，可用範圍 $work"
}
Write-Host "通過 視窗在螢幕可用範圍內（視窗下緣 $($r.Bottom)，工作列上緣 $($work.Bottom)）"
Assert-Pixel 400 260 $WHITE "剛開啟是白色畫布"

# ---------- 畫筆（預設黑色）----------
Drag (Line-Points 100 100 300 100)
Assert-Pixel 200 100 $BLACK "畫筆畫出黑線"
Assert-Pixel 200 130 $WHITE "線外仍是白色"
$title = (Get-Process -Id $appPid).MainWindowTitle
if (-not $title.StartsWith("*")) { throw "畫完後標題應出現 *（未儲存），實際「$title」" }
Write-Host "通過 標題顯示未儲存：$title"

# ---------- 換色 + 矩形 ----------
Click-Swatch $RED
Keys "r"
Drag (Line-Points 400 50 600 200 6)
Assert-Pixel 401 125 $RED "紅色矩形外框"
Assert-Pixel 500 125 $WHITE "矩形內部沒填滿"

# ---------- 油漆桶 ----------
Click-Swatch $BLUE
Keys "f"
Click-Canvas 500 125
Assert-Pixel 500 125 $BLUE "油漆桶填滿矩形內部"
Assert-Pixel 700 300 $WHITE "油漆桶沒有漏到矩形外"

# ---------- 橢圓 + 復原 / 重做 ----------
Click-Swatch $YELLOW
Keys "o"
Drag (Line-Points 100 250 300 450 6)
Assert-Pixel 200 251 $YELLOW "黃色橢圓外框"
Keys "^z"
Assert-Pixel 200 251 $WHITE "Ctrl+Z 復原後橢圓消失"
Keys "^y"
Assert-Pixel 200 251 $YELLOW "Ctrl+Y 重做後橢圓回來"

# ---------- 橡皮擦 ----------
Keys "e"
Drag (Line-Points 150 100 250 100)
Assert-Pixel 200 100 $WHITE "橡皮擦擦掉黑線"
Assert-Pixel 120 100 $BLACK "沒擦到的地方還在"
Assert-AllWhite 152 90 248 110 "橡皮擦擦過的範圍沒有殘留"

# ---------- 滴管 → 用吸到的顏色畫 ----------
Keys "i"
Click-Canvas 500 125
Drag (Line-Points 100 490 300 490)
Assert-Pixel 200 490 $BLUE "滴管吸到藍色後自動切回畫筆"
Save-Shot "2-drawing"

# ---------- 儲存 ----------
$savePath = Join-Path $OutDir "saved.png"
Keys "^s"
Start-Sleep -Seconds 2
Save-Shot "3-save-dialog" -FullScreen
Keys $savePath
Keys "{ENTER}"
for ($i = 0; $i -lt 20 -and -not (Test-Path $savePath); $i++) { Start-Sleep -Milliseconds 250 }
if (-not (Test-Path $savePath)) { throw "Ctrl+S 存檔後找不到 $savePath" }
$saved = [System.Drawing.Bitmap]::FromFile($savePath)
$c = $saved.GetPixel(500, 125); $saved.Dispose()
if (("#{0:x2}{1:x2}{2:x2}" -f $c.R, $c.G, $c.B) -ne $BLUE) { throw "存下來的圖片內容不對" }
Start-Sleep -Milliseconds 500
$title = (Get-Process -Id $appPid).MainWindowTitle
if ($title -ne "saved.png - 小畫家") { throw "存檔後標題應為「saved.png - 小畫家」，實際「$title」" }
Write-Host "通過 Ctrl+S 存檔，圖片內容正確，標題變成「$title」"

# ---------- 關閉前詢問 ----------
Keys "p"
Drag (Line-Points 600 400 700 450)
(Get-Process -Id $appPid).CloseMainWindow() | Out-Null
Start-Sleep -Seconds 1
Save-Shot "4-close-prompt" -FullScreen
if ((Get-Process -Id $appPid -ErrorAction SilentlyContinue) -eq $null) { throw "有未儲存的變更卻直接關閉了" }
Write-Host "通過 有未儲存變更時，關閉前會詢問"
Keys "n"
for ($i = 0; $i -lt 20 -and (Get-Process -Id $appPid -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
if (Get-Process -Id $appPid -ErrorAction SilentlyContinue) { throw "選「否」之後程式沒有關閉" }
Write-Host "通過 選「否」後正常關閉"

# 截圖用 base64 印在紀錄裡，方便不下載也能檢查
foreach ($f in Get-ChildItem $OutDir -Filter "*.png" | Where-Object { $_.Name -match '^\d-' } | Sort-Object Name) {
    Write-Host "=====BEGIN paint-$($f.Name)====="
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
    for ($i = 0; $i -lt $b64.Length; $i += 1000) { Write-Host $b64.Substring($i, [Math]::Min(1000, $b64.Length - $i)) }
    Write-Host "=====END paint-$($f.Name)====="
}
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Id -eq $launcher.Id } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "小畫家冒煙測試通過"
