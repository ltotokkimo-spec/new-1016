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
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, IntPtr extra);
}
"@
[Win]::SetProcessDPIAware() | Out-Null
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Find-AppWindow {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq $Title -and $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
}

function Focus-Window([IntPtr]$hwnd) {
    [Win]::ShowWindow($hwnd, 9) | Out-Null          # SW_RESTORE
    [Win]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)  # 按一下 Alt，讓系統允許切換前景視窗
    [Win]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [Win]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 500
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

Start-Sleep -Seconds 1
Focus-Window $hwnd
Save-Shot $hwnd "1-start"

# 用鍵盤輸入 7 × 3 = ，畫面應顯示 21
[System.Windows.Forms.SendKeys]::SendWait("7*3=")
Start-Sleep -Seconds 1
Save-Shot $hwnd "2-after-7x3"

# 除以 0 之後再按運算子：舊版會在這裡當掉
Focus-Window $hwnd
[System.Windows.Forms.SendKeys]::SendWait("{ESC}5/0={+}")
Start-Sleep -Seconds 1
Save-Shot $hwnd "3-after-divide-by-zero"

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
