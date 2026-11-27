# -*- coding: utf-8 -*-
"""
線上更新：從更新來源（GitHub raw 網址或共用資料夾）下載最新的 .py，
放到 %APPDATA%\\SummaryMerge\\app，下次啟動（或按更新後自動重開）就用新程式。

更新判斷看「檔案內容」而不是版本號，所以只要來源的程式有改，按「檢查更新」就會更新。
"""
import ast
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.request

DEFAULT_SOURCE = "https://raw.githubusercontent.com/ltotokkimo-spec/new-1016/claude/bold-bell-czdpb1/summary-merge"

APPDATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SummaryMerge")
UPDATE_DIR = os.path.join(APPDATA_DIR, "app")


def exe_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


LOCAL_DIR = os.path.join(exe_dir(), "app")      # 本機開發用：exe 旁邊放 app\*.py 會優先使用


def _read_source(source, name):
    if re.match(r"https?://", source, re.I):
        url = f"{source.rstrip('/')}/{name}?t={int(time.time())}"   # 避免 CDN 快取
        req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "SummaryMerge"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.read()
    with open(os.path.join(source, name), "rb") as f:
        return f.read()


def _parse_files(version_src):
    tree = ast.parse(version_src)
    info = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            try:
                info[node.targets[0].id] = ast.literal_eval(node.value)
            except ValueError:
                pass
    files = info.get("FILES") or []
    if "version.py" not in files:
        files = ["version.py"] + list(files)
    for f in files:                                 # 只允許同層的 .py 檔名
        if not re.fullmatch(r"[A-Za-z0-9_]+\.py", f):
            raise ValueError(f"FILES 內有不合法的檔名: {f}")
    return info.get("VERSION", "?"), files


def digest(contents):
    h = hashlib.sha256()
    for name in sorted(contents):
        h.update(name.encode() + b"\0" + contents[name].replace(b"\r\n", b"\n") + b"\0")
    return h.hexdigest()


def current_digest(code_dir, files):
    contents = {}
    for name in files:
        p = os.path.join(code_dir, name)
        if not os.path.exists(p):
            return None
        with open(p, "rb") as f:
            contents[name] = f.read()
    return digest(contents)


def fetch(source):
    """下載來源的全部檔案並檢查語法，回傳 (版本, {檔名: bytes})。"""
    vsrc = _read_source(source, "version.py")
    version, files = _parse_files(vsrc.decode("utf-8"))
    contents = {"version.py": vsrc}
    for name in files:
        if name not in contents:
            contents[name] = _read_source(source, name)
    for name, data in contents.items():            # 有語法錯誤就不更新，避免程式打不開
        compile(data, name, "exec")
    return version, contents


def check(source, running_dir, running_files):
    """回傳 (有無更新, 來源版本, 下載內容)。"""
    version, contents = fetch(source)
    cur = current_digest(running_dir, running_files) if running_dir else None
    return cur != digest(contents), version, contents


def install(contents):
    staging = UPDATE_DIR + ".new"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    for name, data in contents.items():
        with open(os.path.join(staging, name), "wb") as f:
            f.write(data)
    old = UPDATE_DIR + ".old"
    shutil.rmtree(old, ignore_errors=True)
    if os.path.isdir(UPDATE_DIR):
        os.replace(UPDATE_DIR, old)
    os.replace(staging, UPDATE_DIR)
    shutil.rmtree(old, ignore_errors=True)


def reset():
    """移除已下載的更新，回到 exe 內建版本。"""
    shutil.rmtree(UPDATE_DIR, ignore_errors=True)


def restart():
    env = dict(os.environ)
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"      # 讓新的 onefile 程序重新解壓，不沿用舊的暫存
    if getattr(sys, "frozen", False):
        cmd = [sys.executable]
    else:
        cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py")]
    subprocess.Popen(cmd, env=env, close_fds=True)
