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

APP_TITLE = "USS測試資料工具"
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

        root.title(f"{APP_TITLE} v{VERSION}")
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
        """silent=True：啟動時背景檢查，有新版才跳出視窗；否則一開始就顯示進度視窗。"""
        if self._checking:
            return
        self._checking = True
        src = self.update_source()
        import version as running_version
        files = getattr(running_version, "FILES", [])
        dlg = None if silent else UpdateDialog(self, "檢查更新")

        def progress(frac, step, detail=""):
            if dlg:
                self.post(lambda: dlg.set(frac, step, detail))

        def work():
            try:
                has, ver, contents = updater.check(src, CODE_INFO.get("dir"), files, progress=progress)
                self.post(lambda: self._update_result(dlg, has, ver, contents, None))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.post(lambda: self._update_result(dlg, False, None, None, msg))
        threading.Thread(target=work, daemon=True).start()

    def _update_result(self, dlg, has, ver, contents, err):
        self._checking = False
        if err:
            if dlg:
                dlg.finish(f"無法檢查更新：\n{err}", error=True)
            return
        if not has:
            if dlg:
                dlg.finish(f"目前已是最新版（v{VERSION}）")
            return
        if dlg is None:
            dlg = UpdateDialog(self, "有新版本")
            dlg.set(1.0, "下載完成", f"新版 v{ver}")
        dlg.ask(f"有新版本：v{ver}（目前 v{VERSION}）\n要更新並重新開啟程式嗎？",
                lambda: self._install(dlg, contents))

    def _install(self, dlg, contents):
        dlg.busy()

        def progress(frac, step, detail=""):
            self.post(lambda: dlg.set(frac, step, detail))

        def work():
            try:
                updater.install(contents, progress=progress)
                self.post(lambda: self._installed(dlg))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.post(lambda: dlg.finish(f"更新失敗：\n{msg}", error=True))
        threading.Thread(target=work, daemon=True).start()

    def _installed(self, dlg):
        dlg.set(1.0, "更新完成，程式即將重新開啟…", "")
        self.root.after(1200, lambda: (self.on_close(), updater.restart()))

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
                                       f"{CODE_INFO.get('dir')}\n\n"
                                       f"設定檔：{CONFIG_PATH}")


class UpdateDialog:
    """更新進度視窗：步驟說明、進度條（百分比）、目前檔案 / 大小，詢問與結果都在同一個視窗。"""

    def __init__(self, shell, title):
        tk, ttk = shell.tk, shell.ttk
        self.shell = shell
        w = self.w = tk.Toplevel(shell.root)
        w.title(title)
        w.transient(shell.root)
        w.resizable(False, False)
        w.protocol("WM_DELETE_WINDOW", self.close)
        f = ttk.Frame(w, padding=16)
        f.pack(fill="both", expand=True)
        self.step = tk.StringVar(value="準備中…")
        self.detail = tk.StringVar(value="")
        self.pct = tk.StringVar(value="0%")
        ttk.Label(f, textvariable=self.step, font=("", 10, "bold"), wraplength=440, justify="left").pack(anchor="w")
        row = ttk.Frame(f)
        row.pack(fill="x", pady=(8, 2))
        self.bar = ttk.Progressbar(row, length=380, maximum=100, mode="determinate")
        self.bar.pack(side="left")
        ttk.Label(row, textvariable=self.pct, width=6, anchor="e").pack(side="left", padx=(6, 0))
        ttk.Label(f, textvariable=self.detail, foreground="#666666", wraplength=440, justify="left").pack(anchor="w")
        self.btns = ttk.Frame(f)
        self.btns.pack(fill="x", pady=(12, 0))
        self._indet = False
        self._closable = True
        w.update_idletasks()
        x = shell.root.winfo_rootx() + (shell.root.winfo_width() - w.winfo_width()) // 2
        y = shell.root.winfo_rooty() + (shell.root.winfo_height() - w.winfo_height()) // 3
        w.geometry(f"+{max(x, 0)}+{max(y, 0)}")

    def exists(self):
        return self.w.winfo_exists()

    def set(self, frac, step, detail=""):
        if not self.exists():
            return
        self.step.set(step)
        self.detail.set(detail)
        if frac is None:                       # 不確定要多久：跑馬燈
            if not self._indet:
                self.bar.configure(mode="indeterminate")
                self.bar.start(12)
                self._indet = True
            self.pct.set("")
        else:
            if self._indet:
                self.bar.stop()
                self.bar.configure(mode="determinate")
                self._indet = False
            self.bar["value"] = max(0, min(100, frac * 100))
            self.pct.set(f"{frac * 100:.0f}%")

    def _buttons(self, *specs):
        ttk = self.shell.ttk
        for c in self.btns.winfo_children():
            c.destroy()
        for text, cmd in reversed(specs):
            ttk.Button(self.btns, text=text, command=cmd).pack(side="right", padx=(6, 0))

    def ask(self, text, on_yes):
        self.step.set(text)
        self._buttons(("更新並重新開啟", on_yes), ("稍後", self.close))
        self.w.lift()

    def busy(self):
        self._closable = False
        self._buttons()
        self.bar["value"] = 0
        self.pct.set("0%")

    def finish(self, text, error=False):
        self._closable = True
        if self._indet:
            self.bar.stop()
            self.bar.configure(mode="determinate")
            self._indet = False
        if not error:
            self.bar["value"] = 100
            self.pct.set("100%")
        self.step.set(text)
        self.detail.set("")
        self._buttons(("關閉", self.close))

    def close(self):
        if self._closable and self.exists():
            self.w.destroy()


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
