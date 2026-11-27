# -*- coding: utf-8 -*-
"""
測試資料工具（主程式）：分頁切換
  1. 測試結果 (CSV)：operator_log.csv 即時檢視（可多個 CSV）
  2. Summary 統計：Summary*.xlsx 合併、篩選、統計、匯出

說明 → 檢查更新：從更新來源下載新版程式碼，重開即套用（不用重新下載 exe）。
命令列（不開視窗，只合併 Summary）：TestDataTool.exe <來源目錄> [-o 輸出.xlsx]
"""
import json
import os
import queue
import sys
import threading

import merge_core
import updater
from version import VERSION

APP_TITLE = "測試資料工具"
CONFIG_PATH = os.path.join(updater.APPDATA_DIR, "settings.json")
CODE_INFO = {"dir": os.path.dirname(os.path.abspath(__file__)), "label": "原始碼"}


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


class Shell:
    def __init__(self, root):
        import tkinter as tk
        from tkinter import ttk
        from tab_csv import CsvTab
        from tab_summary import SummaryTab

        self.tk, self.ttk = tk, ttk
        self.root = root
        self.cfg = load_config()
        self.q = queue.Queue()
        self.app_dir = updater.exe_dir()
        self._checking = False

        root.title(f"{APP_TITLE}  v{VERSION}")
        root.geometry(self.cfg.get("geometry", "1500x800"))
        root.minsize(1000, 600)
        if self.cfg.get("maximized"):
            try:
                root.state("zoomed")
            except tk.TclError:
                pass
        try:
            ttk.Style().theme_use("vista" if sys.platform.startswith("win") else "clam")
        except tk.TclError:
            pass
        style = ttk.Style()
        style.configure("Treeview", rowheight=22)
        style.configure("Treeview.Heading", font=("", 9, "bold"))
        style.configure("TNotebook.Tab", padding=(14, 4), font=("", 10, "bold"))

        self.nb = ttk.Notebook(root)
        self.nb.pack(fill="both", expand=True)
        self.tabs = []
        for cls in (CsvTab, SummaryTab):
            t = cls(self, self.nb)
            self.nb.add(t.frame, text=f"  {t.TAB_TITLE}  ")
            self.tabs.append(t)
        self.nb.select(min(self.cfg.get("tab", 0), len(self.tabs) - 1))
        self.nb.bind("<<NotebookTabChanged>>", lambda _e: self._on_tab())
        self._build_menu()

        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.after(50, self._poll)
        for t in self.tabs:
            root.after(300, lambda t=t: t.reload(force=True, scroll="top"))
            self._schedule(t)
        if CODE_INFO.get("error"):
            root.after(500, lambda: self.show_text("更新的程式載入失敗", CODE_INFO["error"]))
        if self.cfg.get("auto_check_update", True):
            root.after(3000, lambda: self.check_update(silent=True))

    # ---------- 基礎
    def post(self, fn):
        """背景執行緒把要在 UI 執行的動作丟進來。"""
        self.q.put(fn)

    def _poll(self):
        try:
            while True:
                self.q.get_nowait()()
        except queue.Empty:
            pass
        self.root.after(80, self._poll)

    def _schedule(self, tab):
        def run():
            tab.tick()
            self.root.after(tab.interval() * 1000, run)
        self.root.after(tab.interval() * 1000, run)

    def current(self):
        return self.tabs[self.nb.index(self.nb.select())]

    def _on_tab(self):
        for t in self.tabs:
            t.close_date_popup()
        self.cfg["tab"] = self.nb.index(self.nb.select())

    def on_click_outside(self, popup, button, close):
        def handler(e):
            w = str(e.widget)
            if popup.winfo_exists() and (w.startswith(str(popup)) or e.widget is button):
                return
            close()
            self.root.unbind("<Button-1>", bid)
        bid = self.root.bind("<Button-1>", handler, add="+")

    def save(self):
        try:
            os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, ensure_ascii=False, indent=1)
        except Exception:  # noqa: BLE001
            pass

    def on_close(self):
        try:
            z = self.root.state() == "zoomed"
        except Exception:  # noqa: BLE001
            z = False
        self.cfg["maximized"] = z
        if not z:
            self.cfg["geometry"] = self.root.geometry()
        for t in self.tabs:
            t.remember_widths()
            t.save_extra()
        self.save()
        self.root.destroy()

    def show_text(self, title, text):
        w = self.tk.Toplevel(self.root)
        w.title(title)
        w.geometry("720x420")
        t = self.tk.Text(w, wrap="word")
        t.pack(fill="both", expand=True)
        t.insert("end", text)

    # ---------- 選單
    def _build_menu(self):
        tk = self.tk
        m = tk.Menu(self.root)
        f = tk.Menu(m, tearoff=0)
        f.add_command(label="重新載入（目前分頁）", command=lambda: self.current().reload(force=True))
        f.add_command(label="匯出 Excel（目前分頁）…", command=lambda: self.current().export())
        f.add_separator()
        f.add_command(label="結束", command=self.on_close)
        m.add_cascade(label="檔案", menu=f)
        h = tk.Menu(m, tearoff=0)
        h.add_command(label="檢查更新…", command=self.check_update)
        h.add_command(label="更新來源設定…", command=self.set_update_source)
        self.auto_upd = tk.BooleanVar(value=self.cfg.get("auto_check_update", True))
        h.add_checkbutton(label="啟動時自動檢查更新", variable=self.auto_upd,
                          command=lambda: (self.cfg.__setitem__("auto_check_update", self.auto_upd.get()), self.save()))
        h.add_command(label="回復 exe 內建版本", command=self.reset_update)
        h.add_separator()
        h.add_command(label="關於", command=self.about)
        m.add_cascade(label="說明", menu=h)
        self.root.config(menu=m)

    # ---------- 更新
    def update_source(self):
        return self.cfg.get("update_source") or updater.DEFAULT_SOURCE

    def check_update(self, silent=False):
        if self._checking:
            return
        self._checking = True
        src = self.update_source()
        import version as running_version
        files = getattr(running_version, "FILES", [])

        def work():
            try:
                has, ver, contents = updater.check(src, CODE_INFO.get("dir"), files)
                self.post(lambda: self._update_result(silent, has, ver, contents, None))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.post(lambda: self._update_result(silent, False, None, None, msg))
        threading.Thread(target=work, daemon=True).start()

    def _update_result(self, silent, has, ver, contents, err):
        from tkinter import messagebox
        self._checking = False
        if err:
            if not silent:
                messagebox.showerror(APP_TITLE, f"無法檢查更新：\n{err}\n\n更新來源：{self.update_source()}")
            return
        if not has:
            if not silent:
                messagebox.showinfo(APP_TITLE, f"目前已是最新版（v{VERSION}）")
            return
        if not messagebox.askyesno(APP_TITLE, f"有新版本：v{ver}（目前 v{VERSION}）\n\n要更新並重新開啟程式嗎？"):
            return
        try:
            updater.install(contents)
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(APP_TITLE, f"更新失敗：{e}")
            return
        self.on_close()
        updater.restart()

    def set_update_source(self):
        from tkinter import simpledialog
        v = simpledialog.askstring(
            APP_TITLE,
            "更新來源：GitHub raw 網址，或共用資料夾路徑（例如 \\\\server\\share\\TestDataTool）\n留空 = 預設",
            initialvalue=self.cfg.get("update_source", ""), parent=self.root)
        if v is not None:
            self.cfg["update_source"] = v.strip()
            self.save()

    def reset_update(self):
        from tkinter import messagebox
        if not messagebox.askyesno(APP_TITLE, "移除已下載的更新，回到 exe 內建版本並重開？"):
            return
        updater.reset()
        self.on_close()
        updater.restart()

    def about(self):
        from tkinter import messagebox
        messagebox.showinfo(APP_TITLE, f"{APP_TITLE}\n版本 v{VERSION}\n\n程式來源：{CODE_INFO.get('label')}\n"
                                       f"{CODE_INFO.get('dir')}\n\n更新來源：{self.update_source()}\n"
                                       f"設定檔：{CONFIG_PATH}")


# ---------------------------------------------------------------- 進入點
def cli(argv):
    import argparse
    ap = argparse.ArgumentParser(description="合併來源目錄下所有 Summary*.xlsx")
    ap.add_argument("source", help="來源目錄")
    ap.add_argument("-o", "--output", help="輸出檔路徑（預設放在來源目錄）")
    args = ap.parse_args(argv)
    try:
        merge_core.run(args.source, output=args.output)
    except Exception as e:  # noqa: BLE001
        print(f"錯誤：{e}")
        return 1
    return 0


def main():
    if len(sys.argv) > 1:
        return cli(sys.argv[1:])
    import tkinter as tk
    root = tk.Tk()
    Shell(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
