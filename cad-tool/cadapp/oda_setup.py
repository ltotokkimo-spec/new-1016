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


def install(msi: str, silent: bool = False) -> int:
    """執行安裝。silent=True 完全不顯示（需要系統管理員權限，例如自動測試）；
    否則顯示進度條，Windows 會跳出「是否允許變更」請按「是」。"""
    if not sys.platform.startswith("win"):
        raise SetupError("只能在 Windows 上安裝")
    args = ["msiexec", "/i", msi, "/qn" if silent else "/passive", "/norestart"]
    return subprocess.run(args).returncode


def download_and_install(progress=None, silent=False, log=print) -> str:
    """回傳安裝好的 ODAFileConverter.exe 路徑。"""
    from . import fileio
    url = find_installer_url()
    log(f"下載：{url}")
    tmp = tempfile.mkdtemp(prefix="oda_")
    msi = os.path.join(tmp, url.split("filename=")[-1].split("/")[-1].split("?")[0] or "ODAFileConverter.msi")
    download(url, msi, progress)
    log(f"安裝：{msi}（{os.path.getsize(msi) // 1024 // 1024} MB）")
    code = install(msi, silent=silent)
    try:
        os.remove(msi)
    except OSError:
        pass
    found = fileio.find_oda()
    if not found:
        raise SetupError(f"安裝程式結束（代碼 {code}），但找不到 ODAFileConverter.exe。"
                         + ("\n可能是在「是否允許變更」時按了「否」。" if code in (1602, 1625, 1603) else ""))
    log(f"完成：{found}")
    return found
