"""ODA File Converter 自動下載與安裝。

ODA 的授權不允許把它包進別的程式散佈，所以改成：
第一次執行時檢查，沒裝就從 ODA 官方網站下載安裝檔並安裝；裝過之後自動跳過。
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import urllib.request
from typing import Callable, Optional

PAGE_URL = "https://www.opendesign.com/guestfiles/oda_file_converter"
BASE = "https://www.opendesign.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


class SetupError(Exception):
    pass


def _get(url: str, timeout=30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def find_installer_url() -> str:
    """從 ODA 下載頁面找出 Windows 64 位元 .msi 的網址（版本號會隨時間改變，所以每次去抓）。"""
    html = _get(PAGE_URL).decode("utf-8", "ignore")
    links = re.findall(r'href\s*=\s*["\']([^"\']+\.msi[^"\']*)["\']', html, re.I)
    links += re.findall(r'(/guestfiles/get\?filename=[^"\'<>\s&]+\.msi)', html, re.I)
    cands = []
    for link in dict.fromkeys(links):
        name = link.split("filename=")[-1].split("/")[-1]
        if "odafileconverter" not in name.lower() or "amd64" not in name.lower():
            continue
        url = link if link.startswith("http") else BASE + (link if link.startswith("/") else "/" + link)
        # 偏好 QT6 與較新的 Visual C++ 版本
        score = (("qt6" in name.lower()) * 10
                 + max([int(v) for v in re.findall(r"vc(\d+)", name.lower())] or [0]))
        cands.append((score, url))
    if not cands:
        raise SetupError("在 ODA 下載頁找不到 Windows 64 位元安裝檔。\n"
                         "找到的連結：" + ", ".join(links[:10]))
    cands.sort(reverse=True)
    return cands[0][1]


def download(url: str, dest: str, progress: Optional[Callable[[int, int], bool]] = None) -> str:
    """下載到 dest；progress(已下載, 總大小) 回傳 False 代表取消。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": PAGE_URL})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = r.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if progress is not None and progress(done, total) is False:
                raise SetupError("已取消下載")
    with open(dest, "rb") as f:
        head = f.read(8)
    if head[:4] != b"\xd0\xcf\x11\xe0":  # MSI 檔的開頭
        raise SetupError("下載的檔案不是安裝檔（ODA 網站可能改版了）")
    return dest


# ODA 安裝程式會在「所有使用者」的桌面與開始選單建立捷徑（安裝檔沒有選項可以不建立），
# 本程式在背景呼叫 ODA，使用者用不到，所以安裝後順便刪掉。
def _shortcut_patterns() -> list[str]:
    pub = os.environ.get("PUBLIC", r"C:\Users\Public")
    pd = os.environ.get("ProgramData", r"C:\ProgramData")
    home = os.environ.get("USERPROFILE", "")
    appdata = os.environ.get("APPDATA", "")
    return [
        os.path.join(pub, "Desktop", "ODA File Converter*.lnk"),
        os.path.join(pd, r"Microsoft\Windows\Start Menu\Programs\ODA", "ODA File Converter*.lnk"),
        os.path.join(home, "Desktop", "ODA File Converter*.lnk"),
        os.path.join(appdata, r"Microsoft\Windows\Start Menu\Programs\ODA", "ODA File Converter*.lnk"),
    ]


def find_shortcuts() -> list[str]:
    import glob
    out = []
    for pat in _shortcut_patterns():
        out.extend(glob.glob(pat))
    return out


def _cleanup_batch_lines() -> list[str]:
    pub = os.environ.get("PUBLIC", r"C:\Users\Public")
    pd = os.environ.get("ProgramData", r"C:\ProgramData")
    menu = os.path.join(pd, r"Microsoft\Windows\Start Menu\Programs\ODA")
    return [
        f'del /f /q "{os.path.join(pub, "Desktop", "ODA File Converter*.lnk")}" >nul 2>&1',
        f'del /f /q "{os.path.join(menu, "ODA File Converter*.lnk")}" >nul 2>&1',
        f'rmdir "{menu}" >nul 2>&1',
    ]


def remove_shortcuts_user() -> list[str]:
    """不需要管理員權限就能刪的先刪；回傳還刪不掉的。"""
    left = []
    for p in find_shortcuts():
        try:
            os.remove(p)
        except OSError:
            left.append(p)
    import glob
    for pat in _shortcut_patterns():
        d = os.path.dirname(pat)
        if os.path.basename(d) == "ODA" and os.path.isdir(d) and not os.listdir(d):
            try:
                os.rmdir(d)
            except OSError:
                pass
    return left


def run_elevated(lines: list[str], tick=None) -> int:
    """以系統管理員身分執行批次指令（Windows 會問一次「是否允許變更」）。
    回傳結束代碼；使用者按「否」時丟出 SetupError。"""
    import ctypes
    from ctypes import wintypes
    tmp = tempfile.mkdtemp(prefix="mechcad_admin_")
    bat = os.path.join(tmp, "run.bat")
    with open(bat, "w", encoding="utf-8") as f:
        f.write("@echo off\r\nchcp 65001 >nul\r\n" + "\r\n".join(lines) + "\r\n")

    class SHELLEXECUTEINFOW(ctypes.Structure):
        _fields_ = [("cbSize", wintypes.DWORD), ("fMask", ctypes.c_ulong), ("hwnd", wintypes.HWND),
                    ("lpVerb", wintypes.LPCWSTR), ("lpFile", wintypes.LPCWSTR),
                    ("lpParameters", wintypes.LPCWSTR), ("lpDirectory", wintypes.LPCWSTR),
                    ("nShow", ctypes.c_int), ("hInstApp", wintypes.HINSTANCE),
                    ("lpIDList", ctypes.c_void_p), ("lpClass", wintypes.LPCWSTR),
                    ("hkeyClass", wintypes.HKEY), ("dwHotKey", wintypes.DWORD),
                    ("hIcon", wintypes.HANDLE), ("hProcess", wintypes.HANDLE)]
    info = SHELLEXECUTEINFOW()
    info.cbSize = ctypes.sizeof(info)
    info.fMask = 0x00000040  # SEE_MASK_NOCLOSEPROCESS
    info.lpVerb = "runas"
    info.lpFile = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "cmd.exe")
    info.lpParameters = f'/c "{bat}"'
    info.lpDirectory = tmp
    info.nShow = 0  # SW_HIDE
    if not ctypes.windll.shell32.ShellExecuteExW(ctypes.byref(info)):
        err = ctypes.GetLastError()
        if err == 1223:
            raise SetupError("在「是否允許變更」時按了「否」，所以沒有完成。")
        raise SetupError(f"無法以管理員身分執行（錯誤 {err}）")
    k32 = ctypes.windll.kernel32
    while k32.WaitForSingleObject(info.hProcess, 200) == 0x102:  # WAIT_TIMEOUT
        if tick is not None:
            tick()
    code = wintypes.DWORD()
    k32.GetExitCodeProcess(info.hProcess, ctypes.byref(code))
    k32.CloseHandle(info.hProcess)
    return code.value


def remove_shortcuts(tick=None) -> bool:
    """刪除 ODA 捷徑；需要時會請求管理員權限。回傳是否全部刪除。"""
    if not remove_shortcuts_user():
        return True
    run_elevated(_cleanup_batch_lines(), tick)
    return not find_shortcuts()


def install(msi: str, silent: bool = False, tick=None) -> int:
    """以管理員身分安裝（Windows 會問一次「是否允許變更」），裝完順便刪掉 ODA 的捷徑。"""
    if not sys.platform.startswith("win"):
        raise SetupError("只能在 Windows 上安裝")
    lines = [f'msiexec /i "{msi}" /qn /norestart', "set RC=%ERRORLEVEL%"]
    lines += _cleanup_batch_lines()
    lines += ["exit /b %RC%"]
    return run_elevated(lines, tick)


def download_and_install(progress=None, silent=False, log=print, tick=None) -> str:
    """回傳安裝好的 ODAFileConverter.exe 路徑。"""
    from . import fileio
    url = find_installer_url()
    log(f"下載：{url}")
    tmp = tempfile.mkdtemp(prefix="oda_")
    msi = os.path.join(tmp, url.split("filename=")[-1].split("/")[-1].split("?")[0] or "ODAFileConverter.msi")
    download(url, msi, progress)
    log(f"安裝：{msi}（{os.path.getsize(msi) // 1024 // 1024} MB）")
    code = install(msi, silent=silent, tick=tick)
    try:
        os.remove(msi)
    except OSError:
        pass
    found = fileio.find_oda()
    if not found:
        raise SetupError(f"安裝程式結束（代碼 {code}），但找不到 ODAFileConverter.exe。"
                         + ("\n可能是在「是否允許變更」時按了「否」。" if code in (1602, 1625, 1603) else ""))
    left = find_shortcuts()
    log(f"完成：{found}" + (f"（未刪除的捷徑：{left}）" if left else "（已移除 ODA 捷徑）"))
    return found
