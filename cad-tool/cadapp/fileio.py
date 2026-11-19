"""開檔、存檔、格式轉換。

- DXF：直接用 ezdxf 讀寫。
- DWG：優先用 ODA File Converter（讀寫都穩，可選版本）；
  沒裝 ODA 時，開檔改用程式內附的 LibreDWG（只能讀，不能寫）。
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import tempfile

import ezdxf
from ezdxf import recover
from ezdxf.document import Drawing

# 另存新檔可選的版本（顯示名稱, ezdxf/ODA 版本代碼）
VERSIONS = [
    ("AutoCAD 2018", "R2018"),
    ("AutoCAD 2013", "R2013"),
    ("AutoCAD 2010", "R2010"),
    ("AutoCAD 2007", "R2007"),
    ("AutoCAD 2004", "R2004"),
    ("AutoCAD 2000", "R2000"),
]

ACAD_RELEASE = {
    "AC1009": "R12", "AC1012": "R13", "AC1014": "R14", "AC1015": "R2000",
    "AC1018": "R2004", "AC1021": "R2007", "AC1024": "R2010",
    "AC1027": "R2013", "AC1032": "R2018",
}

_oda_path_override = ""


class ConvertError(Exception):
    pass


def set_oda_path(path: str) -> None:
    global _oda_path_override
    _oda_path_override = path or ""


def find_oda() -> str:
    """回傳 ODAFileConverter 執行檔路徑，找不到回傳空字串。"""
    if _oda_path_override and os.path.isfile(_oda_path_override):
        return _oda_path_override
    if sys.platform.startswith("win"):
        patterns = []
        for root in (os.environ.get("ProgramFiles", r"C:\Program Files"),
                     os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                     os.environ.get("LOCALAPPDATA", "")):
            if root:
                patterns.append(os.path.join(root, "ODA", "ODAFileConverter*", "ODAFileConverter.exe"))
        found = []
        for p in patterns:
            found.extend(glob.glob(p))
        if found:
            return sorted(found)[-1]  # 版本號最大的
        return ""
    return shutil.which("ODAFileConverter") or ""


def _bundled_dir(name: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(base, name)


def find_libredwg() -> str:
    exe = "dwg2dxf.exe" if sys.platform.startswith("win") else "dwg2dxf"
    for cand in (os.path.join(_bundled_dir("libredwg"), exe),
                 os.path.join(_bundled_dir("libredwg"), "bin", exe)):
        if os.path.isfile(cand):
            return cand
    return shutil.which("dwg2dxf") or ""


def _no_window_flags() -> int:
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run_oda(src_dir: str, dst_dir: str, out_ver: str, out_type: str, pattern: str) -> None:
    """ODAFileConverter <in> <out> <ver> <DWG|DXF> <recurse> <audit> [filter]"""
    oda = find_oda()
    if not oda:
        raise ConvertError("找不到 ODA File Converter")
    from ezdxf.addons.odafc import VERSION_MAP
    args = [oda, src_dir, dst_dir, VERSION_MAP.get(out_ver, out_ver), out_type, "0", "1", pattern]
    startupinfo = None
    if sys.platform.startswith("win"):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
    proc = subprocess.run(args, capture_output=True, timeout=300,
                          creationflags=_no_window_flags(), startupinfo=startupinfo)
    if proc.returncode not in (0, None):
        raise ConvertError(f"ODA 轉檔失敗（代碼 {proc.returncode}）")


def dwg_version(path: str) -> str:
    try:
        with open(path, "rb") as f:
            return ACAD_RELEASE.get(f.read(6).decode("ascii", "ignore"), "")
    except OSError:
        return ""


def load(path: str) -> tuple[Drawing, str, str]:
    """讀取 DWG 或 DXF，回傳 (doc, 說明文字, 原始版本如 R2018)。"""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".dxf":
        doc, auditor = recover.readfile(path)
        return doc, f"DXF {doc.acad_release}", ACAD_RELEASE.get(doc.dxfversion, "R2018")
    if ext != ".dwg":
        raise ConvertError("只支援 DWG 和 DXF 檔")

    ver = dwg_version(path) or "R2018"
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in")
        dst = os.path.join(tmp, "out")
        os.makedirs(src)
        os.makedirs(dst)
        name = "drawing.dwg"
        shutil.copyfile(path, os.path.join(src, name))
        out = os.path.join(dst, "drawing.dxf")
        errors = []
        if find_oda():
            try:
                _run_oda(src, dst, "R2018", "DXF", "*.DWG")
                if os.path.exists(out):
                    doc, _ = recover.readfile(out)
                    return doc, f"DWG {ver}（ODA 轉檔）", ver
                errors.append("ODA 沒有產生檔案")
            except Exception as e:  # noqa: BLE001
                errors.append(str(e))
        lib = find_libredwg()
        if lib:
            proc = subprocess.run([lib, "-y", "-o", out, os.path.join(src, name)],
                                  capture_output=True, timeout=300,
                                  creationflags=_no_window_flags())
            if os.path.exists(out) and os.path.getsize(out) > 0:
                doc, _ = recover.readfile(out)
                return doc, f"DWG {ver}（LibreDWG 讀取）", ver
            errors.append("LibreDWG 讀取失敗：" + proc.stderr.decode("utf-8", "ignore")[-300:])
        if not errors:
            errors.append("沒有可用的 DWG 轉檔程式，請安裝 ODA File Converter")
        raise ConvertError("\n".join(errors))


def save(doc: Drawing, path: str, version: str = "") -> None:
    """依副檔名存成 DWG 或 DXF。version 例如 'R2018'，空字串＝保持原版本。"""
    ext = os.path.splitext(path)[1].lower()
    cur = ACAD_RELEASE.get(doc.dxfversion, "R2018")
    version = version or cur
    if ext == ".dxf" and version == cur:
        doc.saveas(path)
        return
    if not find_oda():
        if ext == ".dxf":
            doc.saveas(path)  # 沒有 ODA 時無法轉版本，就存原版本
            return
        raise ConvertError("存成 DWG 需要 ODA File Converter（免費）。\n請到「說明 → 安裝 ODA File Converter」照步驟安裝。")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "in")
        dst = os.path.join(tmp, "out")
        os.makedirs(src)
        os.makedirs(dst)
        doc.saveas(os.path.join(src, "drawing.dxf"))
        out_type = "DWG" if ext == ".dwg" else "DXF"
        _run_oda(src, dst, version, out_type, "*.DXF")
        out = os.path.join(dst, "drawing" + ext)
        if not os.path.exists(out):
            raise ConvertError("ODA 轉檔沒有產生檔案")
        shutil.copyfile(out, path)


# ---------------------------------------------------------------- 匯出 PDF / PNG / SVG
PAPER_SIZES = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841)}


def export(doc: Drawing, path: str, paper: str = "A4", landscape: bool = True,
           monochrome: bool = True, scale: float = 0.0, dpi: int = 300) -> None:
    """scale=0 代表自動縮放到紙張大小；否則為出圖比例（1:2 → 0.5）。"""
    from ezdxf.addons.drawing import Frontend, RenderContext, layout, config
    w, h = PAPER_SIZES.get(paper, (297, 210))
    if not landscape:
        w, h = h, w
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        color_policy=config.ColorPolicy.BLACK if monochrome else config.ColorPolicy.COLOR,
        lineweight_policy=config.LineweightPolicy.ABSOLUTE,
    )
    msp = doc.modelspace()
    page = layout.Page(w, h, layout.Units.mm, margins=layout.Margins.all(5))
    settings = layout.Settings(fit_page=scale <= 0, scale=scale if scale > 0 else 1.0)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".svg":
        from ezdxf.addons.drawing.svg import SVGBackend
        be = SVGBackend()
        Frontend(RenderContext(doc), be, config=cfg).draw_layout(msp)
        with open(path, "w", encoding="utf-8") as f:
            f.write(be.get_string(page, settings=settings))
        return
    from ezdxf.addons.drawing.pymupdf import PyMuPdfBackend
    be = PyMuPdfBackend()
    Frontend(RenderContext(doc), be, config=cfg).draw_layout(msp)
    if ext == ".pdf":
        data = be.get_pdf_bytes(page, settings=settings)
    else:
        data = be.get_pixmap_bytes(page, fmt="png", dpi=dpi, settings=settings)
    with open(path, "wb") as f:
        f.write(data)
