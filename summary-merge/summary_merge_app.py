# -*- coding: utf-8 -*-
"""
Summary 合併統計工具（UI 版）

雙擊 exe 開啟視窗；也可用命令列：
    SummaryMerge.exe <來源目錄> [-o 輸出.xlsx]
"""
import json
import os
import queue
import subprocess
import sys
import threading

import merge_core

APP_TITLE = "Summary 合併統計工具"
VERSION = "1.1"
CONFIG_PATH = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "SummaryMerge.json")


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {}


def save_config(cfg):
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False)
    except Exception:  # noqa: BLE001
        pass


def open_path(path):
    if sys.platform.startswith("win"):
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


class App:
    def __init__(self, root):
        import tkinter as tk
        from tkinter import ttk
        from tkinter.scrolledtext import ScrolledText

        self.tk, self.ttk = tk, ttk
        self.root = root
        self.q = queue.Queue()
        self.out_path = None
        cfg = load_config()

        root.title(f"{APP_TITLE}  v{VERSION}")
        root.geometry("980x620")
        root.minsize(760, 520)
        try:
            ttk.Style().theme_use("vista" if sys.platform.startswith("win") else "clam")
        except tk.TclError:
            pass

        frm = ttk.Frame(root, padding=12)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(1, weight=1)

        ttk.Label(frm, text="來源目錄").grid(row=0, column=0, sticky="w", pady=4)
        self.src_var = tk.StringVar(value=cfg.get("source", ""))
        ttk.Entry(frm, textvariable=self.src_var).grid(row=0, column=1, sticky="ew", padx=6)
        ttk.Button(frm, text="瀏覽…", command=self.pick_src).grid(row=0, column=2)

        ttk.Label(frm, text="輸出目錄").grid(row=1, column=0, sticky="w", pady=4)
        self.out_var = tk.StringVar(value=cfg.get("output_dir", ""))
        ttk.Entry(frm, textvariable=self.out_var).grid(row=1, column=1, sticky="ew", padx=6)
        ttk.Button(frm, text="瀏覽…", command=self.pick_out).grid(row=1, column=2)
        ttk.Label(frm, text="（空白 = 放在來源目錄）", foreground="gray").grid(row=2, column=1, sticky="w", padx=6)

        bar = ttk.Frame(frm)
        bar.grid(row=3, column=0, columnspan=3, sticky="ew", pady=(8, 6))
        self.run_btn = ttk.Button(bar, text="▶ 開始合併", command=self.start)
        self.run_btn.pack(side="left")
        self.open_btn = ttk.Button(bar, text="開啟輸出檔", command=self.open_out, state="disabled")
        self.open_btn.pack(side="left", padx=6)
        self.dir_btn = ttk.Button(bar, text="開啟所在資料夾", command=self.open_dir, state="disabled")
        self.dir_btn.pack(side="left")
        self.auto_open = tk.BooleanVar(value=cfg.get("auto_open", True))
        ttk.Checkbutton(bar, text="完成後自動開啟", variable=self.auto_open).pack(side="left", padx=12)
        self.progress = ttk.Progressbar(bar, mode="indeterminate", length=160)
        self.progress.pack(side="right")

        nb = ttk.Notebook(frm)
        nb.grid(row=4, column=0, columnspan=3, sticky="nsew")
        frm.rowconfigure(4, weight=1)

        # 每日統計預覽
        tab1 = ttk.Frame(nb, padding=4)
        nb.add(tab1, text="每日統計")
        self.cols = ["日期", "SN數", "Pass", "Fail", "其中Aborted", "良率", "良率(排除Aborted)",
                     "測試次數", "平均測試秒數"]
        self.tree = ttk.Treeview(tab1, columns=self.cols, show="headings")
        for c in self.cols:
            self.tree.heading(c, text=c)
            self.tree.column(c, width=110 if c == "日期" else 100, anchor="center")
        self.tree.tag_configure("total", background="#F2F2F2", font=("", 9, "bold"))
        sb = ttk.Scrollbar(tab1, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        self.tree.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")

        # 執行紀錄
        tab2 = ttk.Frame(nb, padding=4)
        nb.add(tab2, text="執行紀錄")
        self.log_box = ScrolledText(tab2, height=10, font=("Consolas", 10))
        self.log_box.pack(fill="both", expand=True)
        self.nb = nb

        self.status = tk.StringVar(value="請選擇來源目錄，工具會往下找所有子資料夾裡 Summary 開頭的 Excel 檔")
        ttk.Label(root, textvariable=self.status, relief="sunken", anchor="w", padding=(8, 3)).pack(fill="x", side="bottom")

        root.after(100, self.poll)

    # ---------- UI 動作
    def pick_src(self):
        from tkinter import filedialog
        p = filedialog.askdirectory(title="選擇來源目錄", initialdir=self.src_var.get() or None)
        if p:
            self.src_var.set(os.path.normpath(p))

    def pick_out(self):
        from tkinter import filedialog
        p = filedialog.askdirectory(title="選擇輸出目錄", initialdir=self.out_var.get() or self.src_var.get() or None)
        if p:
            self.out_var.set(os.path.normpath(p))

    def log(self, msg):
        self.q.put(("log", msg))

    def start(self):
        from tkinter import messagebox
        src = self.src_var.get().strip().strip('"')
        if not src or not os.path.isdir(src):
            messagebox.showwarning(APP_TITLE, "請先選擇存在的來源目錄")
            return
        out_dir = self.out_var.get().strip().strip('"')
        if out_dir and not os.path.isdir(out_dir):
            messagebox.showwarning(APP_TITLE, "輸出目錄不存在")
            return
        save_config({"source": src, "output_dir": out_dir, "auto_open": self.auto_open.get()})
        self.log_box.delete("1.0", "end")
        self.tree.delete(*self.tree.get_children())
        self.run_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.dir_btn.configure(state="disabled")
        self.progress.start(12)
        self.status.set("合併中…")
        threading.Thread(target=self.worker, args=(src, out_dir), daemon=True).start()

    def worker(self, src, out_dir):
        try:
            output = None
            if out_dir:
                files = merge_core.find_summary_files(src)
                output = os.path.join(out_dir, os.path.basename(merge_core.default_output(src, files))) if files else None
            out, stats = merge_core.run(src, output=output, log=self.log)
            self.q.put(("done", (out, stats)))
        except PermissionError as e:
            self.q.put(("error", f"無法寫入輸出檔，可能檔案正在 Excel 中開啟，請關閉後再試。\n\n{e}"))
        except Exception as e:  # noqa: BLE001
            self.q.put(("error", str(e)))

    def poll(self):
        from tkinter import messagebox
        try:
            while True:
                kind, payload = self.q.get_nowait()
                if kind == "log":
                    self.log_box.insert("end", payload + "\n")
                    self.log_box.see("end")
                elif kind == "done":
                    out, stats = payload
                    self.finish()
                    self.out_path = out
                    self.fill_tree(stats["daily"])
                    self.open_btn.configure(state="normal")
                    self.dir_btn.configure(state="normal")
                    tot = stats["daily"][-1]
                    y = f"{tot['良率']:.1%}" if tot["良率"] is not None else "-"
                    self.status.set(f"完成：{os.path.basename(out)}　整體良率 {y}　（{len(stats['dates'])} 天）")
                    if self.auto_open.get():
                        try:
                            open_path(out)
                        except Exception:  # noqa: BLE001
                            pass
                elif kind == "error":
                    self.finish()
                    self.log_box.insert("end", "\n[錯誤] " + payload + "\n")
                    self.nb.select(1)
                    self.status.set("失敗")
                    messagebox.showerror(APP_TITLE, payload)
        except queue.Empty:
            pass
        self.root.after(100, self.poll)

    def finish(self):
        self.progress.stop()
        self.run_btn.configure(state="normal")

    def fill_tree(self, daily):
        for row in daily:
            vals = []
            for c in self.cols:
                v = row.get(c)
                if c.startswith("良率"):
                    v = f"{v:.1%}" if v is not None else "-"
                vals.append("" if v is None else v)
            self.tree.insert("", "end", values=vals, tags=("total",) if row["日期"] == "合計" else ())

    def open_out(self):
        if self.out_path:
            open_path(self.out_path)

    def open_dir(self):
        if self.out_path:
            open_path(os.path.dirname(self.out_path))


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
    App(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
