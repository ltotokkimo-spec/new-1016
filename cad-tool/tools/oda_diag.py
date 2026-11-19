"""CI 診斷：用不同方式呼叫 ODAFileConverter，找出卡住的原因。"""
import ctypes
import glob
import os
import subprocess
import sys
import tempfile
import time
from ctypes import wintypes

import ezdxf

user32 = ctypes.windll.user32
oda = sorted(glob.glob(r"C:\Program Files\ODA\ODAFileConverter*\ODAFileConverter.exe"))[-1]
print("ODA:", oda)


def windows_of(pid):
    out = []
    PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def text(h):
        n = user32.GetWindowTextLengthW(h)
        b = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(h, b, n + 1)
        return b.value

    def child(h, _):
        t = text(h)
        if t:
            out.append("    child: " + t[:200])
        return True

    def top(h, _):
        p = wintypes.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid:
            out.append(f"  window visible={bool(user32.IsWindowVisible(h))}: {text(h)[:200]}")
            user32.EnumChildWindows(h, PROC(child), 0)
        return True
    user32.EnumWindows(PROC(top), 0)
    return out


def run(label, ver, typ, audit, startup, flags, src_ext):
    tmp = tempfile.mkdtemp()
    src, dst = os.path.join(tmp, "in"), os.path.join(tmp, "out")
    os.makedirs(src); os.makedirs(dst)
    doc = ezdxf.new("R2018")
    doc.modelspace().add_line((0, 0), (10, 10))
    doc.saveas(os.path.join(src, "a.dxf"))
    si = None
    if startup:
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 0
    args = [oda, src, dst, ver, typ, "0", audit, "*.DXF"]
    t = time.time()
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, startupinfo=si, creationflags=flags)
    try:
        so, se = p.communicate(timeout=60)
        print(f"[{label}] exit={p.returncode} {time.time()-t:.1f}s out={os.listdir(dst)} stdout={so[-200:]!r} stderr={se[-200:]!r}")
    except subprocess.TimeoutExpired:
        print(f"[{label}] HANG after 60s; windows:")
        print("\n".join(windows_of(p.pid)) or "  (no windows)")
        p.kill()


NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
run("A mine audit1 nowin", "ACAD2018", "DWG", "1", True, NOWIN, ".dxf")
run("B audit0 nowin", "ACAD2018", "DWG", "0", True, NOWIN, ".dxf")
run("C audit0 plain", "ACAD2018", "DWG", "0", True, 0, ".dxf")
run("D audit0 visible", "ACAD2018", "DWG", "0", False, 0, ".dxf")
run("E filter none audit0", "ACAD2018", "DWG", "0", True, 0, ".dxf")
sys.stdout.flush()
