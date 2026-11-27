# -*- coding: utf-8 -*-
"""
EXE 進入點。依序決定要用哪一份程式碼：
  1. exe 旁邊的 app\\ 資料夾（本機修改測試用）
  2. %APPDATA%\\SummaryMerge\\app（「檢查更新」下載的新版）
  3. exe 內建版本
載入失敗會自動退回內建版本。
"""
import importlib.util
import os
import sys
import traceback

MODULES = ["version", "updater", "merge_core", "csv_core", "viewer_base", "tab_csv", "tab_summary",
           "summary_merge_app"]


def _modules_in(code_dir):
    """依該資料夾 version.py 的 FILES 決定載入順序（新版可以加新模組）。"""
    try:
        import ast
        with open(os.path.join(code_dir, "version.py"), encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in tree.body:
            if isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") == "FILES":
                names = [n[:-3] for n in ast.literal_eval(node.value) if n.endswith(".py")]
                return names + [m for m in MODULES if m not in names]
    except Exception:  # noqa: BLE001
        pass
    return MODULES


def _bundled_dir():
    return getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))


def _load_from(code_dir):
    mods = _modules_in(code_dir)
    for name in mods:
        sys.modules.pop(name, None)
    for name in mods:
        path = os.path.join(code_dir, name + ".py")
        if not os.path.exists(path):
            continue                                 # 沒有的模組用內建的
        spec = importlib.util.spec_from_file_location(name, path)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    import summary_merge_app                         # noqa: E402  (內建或剛載入的)
    return summary_merge_app


def main():
    import updater as bundled_updater
    candidates = [(bundled_updater.LOCAL_DIR, "本機 app 資料夾"), (bundled_updater.UPDATE_DIR, "線上更新")]
    load_error = None
    for code_dir, label in candidates:
        if os.path.exists(os.path.join(code_dir, "summary_merge_app.py")):
            try:
                app = _load_from(code_dir)
                app.CODE_INFO = {"dir": code_dir, "label": label}
                return app.main()
            except SystemExit:
                raise
            except Exception:                        # noqa: BLE001
                load_error = f"{label}（{code_dir}）載入失敗，已改用內建版本：\n\n{traceback.format_exc()}"
                break
    for name in MODULES:
        sys.modules.pop(name, None)
    import summary_merge_app as app                  # 內建版本
    app.CODE_INFO = {"dir": _bundled_dir(), "label": "內建", "error": load_error}
    return app.main()


if __name__ == "__main__":
    sys.exit(main())
