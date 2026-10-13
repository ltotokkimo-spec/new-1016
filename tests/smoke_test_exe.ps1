# 在 Windows 上實際啟動打包好的 exe：確認視窗有開、能用鍵盤算出結果、不會當掉，並存下截圖。
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$OutDir = "smoke"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@
[Win]::SetProcessDPIAware() | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Find-AppWindow {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
}

function Save-Shot([IntPtr]$hwnd, [string]$name) {
    $r = New-Object Win+RECT
    [Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
    $path = Join-Path $OutDir "$name.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "截圖 $path（${w}x${h}）"
}

# 程式會把螢幕上的數字寫到這個檔案，用來確認算出的結果
$displayFile = Join-Path (Resolve-Path $OutDir) "display.txt"
$env:CALC_DISPLAY_FILE = $displayFile

function Assert-Display([string]$expected, [string]$step) {
    $actual = ""
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-Path $displayFile) { $actual = (Get-Content $displayFile -Raw -Encoding utf8).Trim() }
        if ($actual -eq $expected) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($actual -ne $expected) { throw "$step：螢幕應顯示「$expected」，實際是「$actual」" }
    Write-Host "通過 $step → $actual"
}

$launcher = Start-Process -FilePath $ExePath -PassThru
Write-Host "已啟動 $ExePath（PID $($launcher.Id)）"

# 單一 exe 第一次啟動要先解壓縮，最多等 60 秒視窗出現
$app = $null
for ($i = 0; $i -lt 120 -and -not $app; $i++) {
    Start-Sleep -Milliseconds 500
    if ($launcher.HasExited -and $launcher.ExitCode -ne 0) {
        throw "程式啟動失敗，結束代碼 $($launcher.ExitCode)"
    }
    $app = Find-AppWindow
}
if (-not $app) { throw "60 秒內沒有出現標題為「$Title」的視窗" }
$hwnd = $app.MainWindowHandle
Write-Host "找到視窗「$($app.MainWindowTitle)」（PID $($app.Id)）"

# 不先切換視窗，直接打字：確認程式一開就能用鍵盤
Start-Sleep -Seconds 1
Assert-Display "0" "剛開啟"
Save-Shot $hwnd "1-start"
[System.Windows.Forms.SendKeys]::SendWait("7*3=")
Assert-Display "21" "開啟後直接輸入 7 × 3 ="
Save-Shot $hwnd "2-after-7x3"

$cases = @(
    @{ Keys = "{ESC}1234.5{+}0.5=";  Expect = "1,235";  Step = "1234.5 + 0.5 =" },
    @{ Keys = "{ESC}0.1{+}0.2=";     Expect = "0.3";    Step = "0.1 + 0.2 =" },
    @{ Keys = "{ESC}1{+}2{+}3=";     Expect = "6";      Step = "連續計算 1 + 2 + 3 =" },
    @{ Keys = "{ESC}7{+}*3=";        Expect = "21";     Step = "連按運算子 7 + × 3 =" },
    @{ Keys = "{ESC}10/4=";          Expect = "2.5";    Step = "10 ÷ 4 =" },
    @{ Keys = "{ESC}3-10=";          Expect = "-7";     Step = "3 − 10 =" },
    @{ Keys = "{ESC}50{%}";          Expect = "0.5";    Step = "50 %" },
    @{ Keys = "{ESC}123{BACKSPACE}"; Expect = "12";     Step = "倒退鍵" },
    @{ Keys = "{ESC}5/0={+}{%}";     Expect = "Error";  Step = "除以 0 後再按 + 和 %（舊版會當掉）" },
    @{ Keys = "4{+}1=";              Expect = "5";      Step = "錯誤後重新輸入 4 + 1 =" }
)
foreach ($c in $cases) {
    [System.Windows.Forms.SendKeys]::SendWait($c.Keys)
    Assert-Display $c.Expect $c.Step
}

[System.Windows.Forms.SendKeys]::SendWait("{ESC}5/0=")
Assert-Display "Error" "除以 0"
Save-Shot $hwnd "3-after-divide-by-zero"

# 用滑鼠點按鈕：AC、9、×、9、=
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Mouse {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, IntPtr e);
    public static void Click(int x, int y) { SetCursorPos(x, y); System.Threading.Thread.Sleep(80); mouse_event(2,0,0,0,IntPtr.Zero); mouse_event(4,0,0,0,IntPtr.Zero); System.Threading.Thread.Sleep(150); }
}
"@
$r = New-Object Win+RECT
[Win]::GetWindowRect($hwnd, [ref]$r) | Out-Null
# 依截圖位置換算按鈕中心：4 欄 × 5 列，按鍵區在視窗下方約 2/3
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
function Key-Center([int]$row, [int]$col) {
    $left = $r.Left + $w * 0.07; $right = $r.Right - $w * 0.07
    $top = $r.Top + $h * 0.33; $bottom = $r.Bottom - $h * 0.06
    $x = $left + ($right - $left) * (($col + 0.5) / 4)
    $y = $top + ($bottom - $top) * (($row + 0.5) / 5)
    return @([int]$x, [int]$y)
}
foreach ($k in @(@(0,0), @(1,2), @(1,3), @(1,2), @(4,3))) {
    $p = Key-Center $k[0] $k[1]
    [Mouse]::Click($p[0], $p[1])
}
Assert-Display "81" "滑鼠點 AC、9、×、9、="
Save-Shot $hwnd "4-mouse-9x9"

Start-Sleep -Seconds 2
$still = Find-AppWindow
if (-not $still) { throw "操作後程式關閉或當掉了" }
Write-Host "程式在操作後仍正常執行"

# 把截圖用 base64 印在紀錄裡，方便不下載也能檢查
foreach ($f in Get-ChildItem $OutDir -Filter *.png | Sort-Object Name) {
    Write-Host "=====BEGIN $($f.Name)====="
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
    for ($i = 0; $i -lt $b64.Length; $i += 1000) {
        Write-Host $b64.Substring($i, [Math]::Min(1000, $b64.Length - $i))
    }
    Write-Host "=====END $($f.Name)====="
}

Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -eq $Title -or $_.Id -eq $launcher.Id } |
    Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "冒煙測試通過"
