# -*- coding: utf-8 -*-
"""分頁 1：測試結果（operator_log.csv）即時檢視，可同時讀多個 CSV。"""
import os

import csv_core
from viewer_base import TableTab, open_path

ROW_TAGS = {"PASS": "#FFFFFF", "FAIL": "#FFD6D6", "HOLD": "#FFF0C2", "OTHER": "#F2F2F2"}


class CsvTab(TableTab):
    TAB_KEY = "csv"
    TAB_TITLE = "測試結果 (CSV)"
    COMBOS = [("station", "站別", 8), ("verdict", "結果", 7), ("opid", "OPID", 10)]
    ROW_TAGS = ROW_TAGS
    DEFAULT_HIDDEN = ["timestamp"]

    def __init__(self, shell, parent):
        self.n_ch = csv_core.DEFAULT_CHANNELS
        self.sigs = {}
        self.errors = {}
        super().__init__(shell, parent)
        if not self.paths():
            default = os.path.join(shell.app_dir, csv_core.DEFAULT_CSV_NAME)
            if os.path.exists(default):
                self.set_paths([default])

    # ---------- 來源
    def build_source(self, top):
        tk, ttk = self.tk, self.ttk
        ttk.Label(top, text="CSV 檔案：").pack(side="left")
        self.path_var = tk.StringVar(value=" ; ".join(self.cfg.get("csv_paths", [])))
        ttk.Entry(top, textvariable=self.path_var, state="readonly").pack(side="left", fill="x", expand=True)
        ttk.Button(top, text="選擇檔案…（可多選）", command=self.choose_files).pack(side="left", padx=(4, 0))
        ttk.Button(top, text="加入檔案…", command=lambda: self.choose_files(add=True)).pack(side="left", padx=4)

    def initial_status(self):
        return "選擇測試結果 CSV（預設讀取程式旁邊的 operator_log.csv），測試程式往下追加資料時會自動更新"

    def paths(self):
        return list(self.cfg.get("csv_paths", []))

    def set_paths(self, paths):
        self.cfg["csv_paths"] = paths
        self.path_var.set(" ; ".join(paths))
        self.sigs, self.errors = {}, {}
        self.reset_data()
        self.shell.save()

    def choose_files(self, add=False):
        from tkinter import filedialog
        cur = self.paths()
        init = os.path.dirname(cur[0]) if cur else self.shell.app_dir
        ps = filedialog.askopenfilenames(title="選擇測試結果 CSV", initialdir=init,
                                         filetypes=[("CSV 檔", "*.csv"), ("所有檔案", "*.*")])
        if not ps:
            return
        ps = [os.path.normpath(p) for p in ps]
        if add:
            ps = cur + [p for p in ps if p not in cur]
        self.clear_filters(refresh=False)
        self.set_paths(ps)
        self.reload(force=True, scroll="top")

    def ready(self):
        return bool(self.paths())

    def load(self, force):
        sig = {}
        missing = []
        for p in self.paths():
            try:
                st = os.stat(p)
                sig[p] = (st.st_mtime, st.st_size)
            except OSError:
                missing.append(os.path.basename(p))
        if not force and sig == self.sigs and self.records:
            return False, self.records, self._info(missing)
        recs, n_ch, errors = [], 0, {}
        for p in sig:
            try:
                r, n = csv_core.load_records(p)
                recs += r
                n_ch = max(n_ch, n)
            except Exception as e:  # noqa: BLE001  檔案寫入中，稍後重試
                errors[p] = str(e)
        if errors and not recs and self.records:
            self.errors = errors
            return False, self.records, self._info(missing)
        self.sigs = {p: s for p, s in sig.items() if p not in errors}
        self.errors = errors
        self.n_ch = n_ch or csv_core.DEFAULT_CHANNELS
        return True, csv_core.finalize(recs), self._info(missing)

    def _info(self, missing):
        msg = f"{len(self.paths())} 個 CSV"
        if missing:
            msg += f"　⚠ 找不到檔案：{', '.join(missing)}"
        if self.errors:
            msg += f"　⚠ 讀取失敗（稍後重試）：{', '.join(os.path.basename(p) for p in self.errors)}"
        return msg

    def on_records_changed(self):
        self.tree["columns"] = ()          # 通道數可能變了

    # ---------- 欄位 / 顯示
    def columns_all(self):
        cols = csv_core.all_columns(self.n_ch)
        if len(self.paths()) > 1:
            cols = cols + [("_file", "來源檔", "w")]
        return cols

    def sn_key(self):
        return "sn"

    def cell(self, rec, key):
        return csv_core.cell_text(rec, key)

    def col_width(self, key, title):
        return {"timestamp": 130, "date": 85, "time": 70, "opid": 70, "sn": 170, "test_status": 80,
                "verdict": 62, "hold_channels": 100, "fail_channels": 100, "station": 70,
                "station_name": 120, "_file": 140}.get(key, 58 if key.startswith("CH") else 90)

    def rec_dt(self, rec):
        return rec["_dt"]

    def rec_date(self, rec):
        return rec["date"]

    def rec_sn(self, rec):
        return rec["sn"]

    def row_tag(self, rec):
        return rec["verdict"] if rec["verdict"] in ("PASS", "FAIL", "HOLD") else "OTHER"

    def combo_values(self, key, vals):
        if key == "verdict":
            return ["PASS", "FAIL", "HOLD"] + [v for v in vals if v not in ("PASS", "FAIL", "HOLD")]
        return vals

    def stats_items(self, rows):
        n = len(rows)
        c = {k: sum(1 for r in rows if r["verdict"] == k) for k in ("PASS", "FAIL", "HOLD")}
        items = [(f"總數 {n}", "#000000", None), (f"PASS {c['PASS']}", "#008000", None),
                 (f"FAIL {c['FAIL']}", "#C00000", None), (f"HOLD {c['HOLD']}", "#B07000", None),
                 (f"良率 {c['PASS'] / n * 100:.1f}%" if n else "良率 -", "#0050A0", None)]
        dup = {(r["station"], r["sn"]) for r in rows if r.get("__dup_total", 1) >= 2}
        dn = sum(1 for r in rows if r.get("__dup_total", 1) >= 2)
        items.append((f" 同站重覆測試：{len(dup)} 個 SN／{dn} 筆 " if dup else " 同站重覆測試：無 ",
                      csv_core.DUP[1], csv_core.DUP[0]))
        return items

    def context_extra(self, menu, rec):
        out_dir = rec["_raw"].get("out_dir")
        if out_dir:
            menu.add_command(label="開啟結果資料夾", command=lambda: self.open_folder(out_dir))
        menu.add_command(label="開啟來源 CSV", command=lambda: self.open_folder(rec["_path"]))

    # ---------- 詳細資料
    def show_detail(self, rec):
        tk, ttk = self.tk, self.ttk
        raw = rec["_raw"]
        w = tk.Toplevel(self.root)
        w.title(f"{rec['sn']}  {rec['verdict']}  {rec['timestamp']}")
        w.geometry("760x560")
        bg, fg = csv_core.VERDICT_COLORS.get(rec["verdict"], ("#DDDDDD", "#000000"))
        head = ttk.Frame(w)
        head.pack(fill="x", padx=8, pady=6)
        tk.Label(head, text=f" {rec['verdict'] or '-'} ", bg=bg, fg=fg, font=("", 16, "bold")).pack(side="left")
        tk.Label(head, text=f"   {rec['sn']}   OPID {rec['opid']}   {rec['timestamp']}   "
                            f"{rec['station']} {rec['station_name']}", font=("", 11)).pack(side="left")
        if rec.get("__dup_total", 1) >= 2:
            tk.Label(w, text=f" ⚠ 同站（{rec['station']}）重覆測試：這是第 {rec['__dup_no']} 次，共測了 {rec['__dup_total']} 次 ",
                     bg=csv_core.DUP[0], fg=csv_core.DUP[1], anchor="w", font=("", 10, "bold")).pack(fill="x", padx=8)
        n = max([len(csv_core.split_values(raw.get(k))) for k, _n in csv_core.CHANNEL_METRICS] + [0])
        cols = ["ch"] + [name for _k, name in csv_core.CHANNEL_METRICS] + ["status"]
        tv = ttk.Treeview(w, columns=cols, show="headings", height=min(max(n, 1), 10))
        tv.heading("ch", text="通道")
        tv.column("ch", width=60, anchor="center")
        for _k, name in csv_core.CHANNEL_METRICS:
            tv.heading(name, text=name)
            tv.column(name, width=85, anchor="e")
        tv.heading("status", text="狀態")
        tv.column("status", width=70, anchor="center")
        tv.tag_configure("fail", background=csv_core.CH_FAIL[0], foreground=csv_core.CH_FAIL[1])
        tv.tag_configure("hold", background=csv_core.CH_HOLD[0], foreground=csv_core.CH_HOLD[1])
        vals = {name: csv_core.split_values(raw.get(k)) for k, name in csv_core.CHANNEL_METRICS}
        for i in range(n):
            st = "FAIL" if i in rec["_fail"] else "HOLD" if i in rec["_hold"] else ""
            tv.insert("", "end", values=[f"CH{i}"] + [vals[nm][i] if i < len(vals[nm]) else "" for nm in vals] + [st],
                      tags=(st.lower(),) if st else ())
        tv.pack(fill="x", padx=8, pady=(6, 0))
        txt = tk.Text(w, wrap="word", height=12, font=("Consolas", 10))
        txt.pack(fill="both", expand=True, padx=8, pady=6)
        txt.tag_configure("k", font=("Consolas", 10, "bold"))
        for k, v in raw.items():
            txt.insert("end", f"{k}: ", ("k",))
            txt.insert("end", f"{v}\n")
        txt.insert("end", "來源檔: ", ("k",))
        txt.insert("end", f"{rec['_path']}  (第 {rec['_line']} 行)\n")
        txt.configure(state="disabled")
        bar = ttk.Frame(w)
        bar.pack(fill="x", padx=8, pady=(0, 8))
        if raw.get("out_dir"):
            ttk.Button(bar, text="開啟結果資料夾", command=lambda: self.open_folder(raw["out_dir"])).pack(side="left")
        ttk.Button(bar, text="複製全部",
                   command=lambda: self.clip("\n".join(f"{k}: {v}" for k, v in raw.items()), "詳細資料")).pack(side="left", padx=6)
        ttk.Button(bar, text="關閉", command=w.destroy).pack(side="right")
        w.bind("<Escape>", lambda _e: w.destroy())

    # ---------- 匯出
    def export(self):
        from tkinter import messagebox
        rows = self.view_rows
        if not rows:
            messagebox.showinfo(self.TAB_TITLE, "目前沒有可匯出的資料")
            return
        cur = self.paths()
        path = self.export_path("test_result_", initialdir=os.path.dirname(cur[0]) if cur else None)
        if not path:
            return
        cols = self.visible_cols()
        cols = [c for c in cols if c[0] != "__dup"]
        try:
            if path.lower().endswith(".csv"):
                csv_core.export_csv(path, cols, rows)
            else:
                csv_core.export_xlsx(path, cols, rows)
        except PermissionError:
            messagebox.showerror(self.TAB_TITLE, f"無法寫入，檔案可能正在 Excel 中開啟：\n{path}")
            return
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(self.TAB_TITLE, f"匯出失敗：{e}")
            return
        self.status.set(f"已匯出 {len(rows)} 筆 → {path}")
        if messagebox.askyesno(self.TAB_TITLE, f"已匯出 {len(rows)} 筆：\n{path}\n\n要開啟嗎？"):
            open_path(path)
