"""程式進入點：python main.py [圖檔.dwg]"""
import os
import sys


def setup_fonts():
    """SHX 字型無法顯示時，改用系統的中文字型（避免中文變成方框）。"""
    from ezdxf.fonts import fonts
    fm = fonts.font_manager
    for name in ("msjh.ttc", "msjh.ttf", "mingliu.ttc", "kaiu.ttf", "msyh.ttc", "simsun.ttc",
                 "NotoSansCJK-Regular.ttc", "NotoSansTC-Regular.otf", "wqy-zenhei.ttc"):
        try:
            if fm.has_font(name):
                fm._fallback_font_name = name
                _patch_family_match(fm, name)
                return name
        except Exception:  # noqa: BLE001
            pass
    return ""


def _patch_family_match(fm, fallback):
    """圖檔指定的字型（例如 Solid Edge ISO、PMingLiU）電腦裡沒有時，
    ezdxf 會挑一個「長得像」的英文字型，中文就變方框；改成用中文備用字型。"""
    original = fm.find_best_match
    generic = {"sans-serif", "serif", "monospace", ""}
    fallback_face = fm.get_font_face(fallback)

    def find_best_match(family="sans-serif", style="Regular", weight=400, width=5, italic=False):
        face = original(family, style, weight, width, italic)
        if family.lower() in generic:
            return face
        if face is None or face.family.lower() != family.lower():
            return fallback_face
        return face

    fm.find_best_match = find_best_match


def selftest(args):
    """自動測試（給 GitHub 編譯後檢查用）：MechCAD.exe --selftest 結果.txt [測試.dwg]"""
    os.environ["QT_QPA_PLATFORM"] = "offscreen"
    out = args[0] if args else "selftest.txt"
    lines, ok = [], True
    try:
        from PySide6 import QtWidgets as qw
        app = qw.QApplication([])
        lines.append("fallback font: " + (setup_fonts() or "(none)"))
        from cadapp.mainwindow import MainWindow
        from cadapp import fileio
        w = MainWindow()
        ed = w.editor
        for c in ("REC", "0,0", "@100,50", "C", "30,25", "10", "DLI", "0,0", "100,0", "50,-15",
                  "DDI"):
            ed.submit(c)
        circle = ed.msp.query("CIRCLE")[0]
        from ezdxf.math import Vec2
        ed._advance((circle, Vec2(40, 25)))
        ed.submit("60,40")
        n = len(ed.msp)
        lines.append(f"drawn entities: {n}")
        ok &= n >= 3
        tmp = os.path.join(os.path.dirname(os.path.abspath(out)), "selftest_out.dxf")
        fileio.save(ed.doc, tmp)
        doc, info, ver = fileio.load(tmp)
        lines.append(f"dxf roundtrip: {len(doc.modelspace())} entities ({info})")
        ok &= len(doc.modelspace()) == n
        fileio.export(ed.doc, tmp[:-4] + ".pdf")
        fileio.export(ed.doc, tmp[:-4] + ".png", dpi=72)
        lines.append("pdf/png export ok")
        lines.append(f"libredwg: {fileio.find_libredwg() or '(missing)'}")
        lines.append(f"oda: {fileio.find_oda() or '(not installed)'}")
        if fileio.find_oda():
            for ver in ("R2018", "R2013", "R2000"):
                dwg = tmp[:-4] + f"_{ver}.dwg"
                fileio.save(ed.doc, dwg, ver)
                d2, info2, v2 = fileio.load(dwg)
                good = len(d2.modelspace()) == n and v2 == ver
                lines.append(f"dwg save {ver}: {os.path.getsize(dwg)} bytes, reload {len(d2.modelspace())} entities, {info2} {'OK' if good else 'MISMATCH'}")
                ok &= good
        if len(args) > 1:
            doc, info, ver = fileio.load(args[1])
            lines.append(f"dwg read: {len(doc.modelspace())} entities ({info})")
            ok &= len(doc.modelspace()) > 0
            ed.dirty = False
            w.open_file(args[1])
            lines.append(f"dwg opened in window: {len(w.view.items_by_handle)} drawn")
    except Exception:  # noqa: BLE001
        import traceback
        lines.append(traceback.format_exc())
        ok = False
    lines.append("RESULT: " + ("PASS" if ok else "FAIL"))
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 0 if ok else 1


def main():
    if "--install-oda" in sys.argv:  # 自動測試用：無介面安裝
        from cadapp import oda_setup
        i = sys.argv.index("--install-oda")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else "install_oda.txt"
        lines = []
        try:
            oda_setup.download_and_install(silent=True, log=lines.append)
            code = 0
        except Exception as ex:  # noqa: BLE001
            lines.append(f"ERROR: {ex}")
            code = 1
        with open(out, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        sys.exit(code)
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        sys.exit(selftest(sys.argv[i + 1:]))
    from PySide6 import QtWidgets as qw, QtGui as qg, QtCore as qc
    app = qw.QApplication(sys.argv)
    app.setApplicationName("簡易機械 CAD")
    app.setStyle("Fusion")
    f = app.font()
    if sys.platform.startswith("win"):
        f.setFamily("Microsoft JhengHei UI")
        f.setPointSize(9)
        app.setFont(f)

    splash = qw.QSplashScreen()
    pm = qg.QPixmap(420, 120)
    pm.fill(qg.QColor("#1e2329"))
    splash.setPixmap(pm)
    splash.showMessage("簡易機械 CAD 啟動中…\n第一次啟動需要整理系統字型，請稍候", qc.Qt.AlignCenter, qg.QColor("white"))
    splash.show()
    app.processEvents()

    setup_fonts()
    from cadapp.mainwindow import MainWindow
    win = MainWindow()
    win.restore_layout()
    win.show()
    splash.finish(win)
    args = [a for a in sys.argv[1:] if os.path.isfile(a)]

    def after_start():
        win.check_oda_on_startup()
        if args:
            win.open_file(args[0])
    qc.QTimer.singleShot(300, after_start)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
