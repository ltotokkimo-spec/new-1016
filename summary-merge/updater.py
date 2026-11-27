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
import urllib.parse
import urllib.request

DEFAULT_SOURCE = "https://raw.githubusercontent.com/ltotokkimo-spec/new-1016/claude/bold-bell-czdpb1/summary-merge"

APPDATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SummaryMerge")
UPDATE_DIR = os.path.join(APPDATA_DIR, "app")


def exe_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


LOCAL_DIR = os.path.join(exe_dir(), "app")      # 本機開發用：exe 旁邊放 app\*.py 會優先使用


RAW_RE = re.compile(r"https://raw\.githubusercontent\.com/([^/]+)/([^/]+)/(.+)$", re.I)


def _http(url, accept=None):
    headers = {"Cache-Control": "no-cache", "User-Agent": "SummaryMerge"}
    if accept:
        headers["Accept"] = accept
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as r:
        return r.read()


def pin_source(source):
    """GitHub raw 的分支網址 → 換成最新 commit 的網址。
    raw 網址有 5 分鐘 CDN 快取，用分支名稱下載可能拿到新舊混雜的檔案；用 commit 編號就一定是同一版。"""
    m = RAW_RE.match(source.rstrip("/"))
    if not m:
        return source
    owner, repo, rest = m.groups()
    # rest = <分支>/<資料夾>；分支名稱可能含 /，從最長的開始試
    parts = rest.split("/")
    for i in range(len(parts), 0, -1):
        ref, sub = "/".join(parts[:i]), "/".join(parts[i:])
        try:
            sha = _http(f"https://api.github.com/repos/{owner}/{repo}/commits/{urllib.parse.quote(ref, safe='')}",
                        accept="application/vnd.github.sha").decode().strip()
        except Exception:  # noqa: BLE001
            continue
        if re.fullmatch(r"[0-9a-f]{40}", sha):
            return f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}" + (f"/{sub}" if sub else "")
    return source


def _read_source(source, name):
    if re.match(r"https?://", source, re.I):
        url = f"{source.rstrip('/')}/{name}?t={int(time.time())}"
        return _http(url)
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
    source = pin_source(source)
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


def _selftest(code_dir):
    """用目前這個 exe 試載入新程式（不開視窗）；載入失敗就不安裝。舊版 exe 不支援時略過。"""
    main = sys.modules.get("__main__")
    if not getattr(main, "SUPPORTS_SELFTEST", False):
        return
    env = dict(os.environ)
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    if getattr(sys, "frozen", False):
        cmd = [sys.executable, "--selftest", code_dir]
    else:
        cmd = [sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "launcher.py"), "--selftest", code_dir]
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(cmd, env=env, capture_output=True, timeout=120, creationflags=flags)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or b"").decode("utf-8", "replace")[-2000:]
        raise RuntimeError(f"新版程式無法在這個 exe 上執行，已取消更新（需要下載新版 exe）：\n{err}")


def install(contents):
    staging = UPDATE_DIR + ".new"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    for name, data in contents.items():
        with open(os.path.join(staging, name), "wb") as f:
            f.write(data)
    try:
        _selftest(staging)
    except Exception:
        shutil.rmtree(staging, ignore_errors=True)
        raise
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
