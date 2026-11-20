"""線上更新：從 GitHub Releases 檢查新版，下載後在程式關閉時替換檔案並重新啟動。"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from typing import Callable, Optional

from ._version import VERSION

REPO = "ltotokkimo-spec/new-1016"
API = f"https://api.github.com/repos/{REPO}/releases?per_page=30"
TAG_PREFIX = "mechcad-v"
ASSET = "MechCAD-windows.zip"
UA = "MechCAD-updater"


class UpdateError(Exception):
    pass


def parse_version(v: str) -> tuple:
    nums = re.findall(r"\d+", v or "")
    return tuple(int(n) for n in nums) if nums else (0,)


def is_dev() -> bool:
    return not getattr(sys, "frozen", False)


def latest_release(timeout=10) -> Optional[dict]:
    """回傳最新版資訊 {version, notes, url, size, page}，查不到回傳 None。"""
    req = urllib.request.Request(API, headers={"User-Agent": UA, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        releases = json.loads(r.read().decode("utf-8"))
    best = None
    for rel in releases:
        tag = rel.get("tag_name", "")
        if rel.get("draft") or rel.get("prerelease") or not tag.startswith(TAG_PREFIX):
            continue
        asset = next((a for a in rel.get("assets", []) if a.get("name") == ASSET), None)
        if asset is None:
            continue
        ver = tag[len(TAG_PREFIX):]
        if best is None or parse_version(ver) > parse_version(best["version"]):
            best = {"version": ver, "notes": rel.get("body") or "", "url": asset["browser_download_url"],
                    "size": asset.get("size", 0), "page": rel.get("html_url", "")}
    return best


def newer_available(timeout=10) -> Optional[dict]:
    rel = latest_release(timeout)
    if rel and parse_version(rel["version"]) > parse_version(VERSION):
        return rel
    return None


def install_dir() -> str:
    return os.path.dirname(os.path.abspath(sys.executable))


def download_and_extract(rel: dict, progress: Optional[Callable[[int, int], bool]] = None) -> str:
    """下載並解壓縮，回傳新版 MechCAD 資料夾路徑（裡面有 MechCAD.exe）。"""
    tmp = tempfile.mkdtemp(prefix="mechcad_update_")
    zpath = os.path.join(tmp, ASSET)
    req = urllib.request.Request(rel["url"], headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r, open(zpath, "wb") as f:
        total = int(r.headers.get("Content-Length") or rel.get("size") or 0)
        done = 0
        while True:
            chunk = r.read(512 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            if progress is not None and progress(done, total) is False:
                raise UpdateError("已取消更新")
    out = os.path.join(tmp, "new")
    with zipfile.ZipFile(zpath) as z:
        z.extractall(out)
    os.remove(zpath)
    for root, dirs, files in os.walk(out):
        if "MechCAD.exe" in files:
            return root
    raise UpdateError("下載的更新檔裡找不到 MechCAD.exe")


def check_writable(folder: str) -> bool:
    test = os.path.join(folder, ".update_test")
    try:
        with open(test, "w") as f:
            f.write("x")
        os.remove(test)
        return True
    except OSError:
        return False


def launch_replacer(new_dir: str, target_dir: str, pid: int) -> None:
    """產生並啟動一個批次檔：等本程式結束 → 複製新檔覆蓋 → 重新開啟。"""
    bat = os.path.join(os.path.dirname(new_dir.rstrip("\\/")), "apply_update.bat")
    exe = os.path.join(target_dir, "MechCAD.exe")
    log = os.path.join(target_dir, "update_log.txt")
    script = f"""@echo off
chcp 65001 >nul
:wait
tasklist /FI "PID eq {pid}" 2>nul | find "{pid}" >nul
if not errorlevel 1 (
  timeout /t 1 /nobreak >nul
  goto wait
)
robocopy "{new_dir}" "{target_dir}" /E /R:5 /W:1 /NFL /NDL /NJH /NJS /NP > "{log}"
if %errorlevel% GEQ 8 (
  echo 更新失敗，請重新下載完整版本 >> "{log}"
) else (
  echo 更新完成 >> "{log}"
)
start "" "{exe}"
"""
    with open(bat, "w", encoding="utf-8") as f:
        f.write(script)
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    from .fileio import _clean_env
    env = _clean_env()
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"  # 重新開啟的程式當成全新啟動
    subprocess.Popen(["cmd", "/c", bat], creationflags=flags, close_fds=True,
                     cwd=os.path.dirname(bat), env=env)
