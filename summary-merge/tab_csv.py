# -*- coding: utf-8 -*-
"""分頁 1：測試結果（operator_log.csv）即時檢視。兩個來源設定，可各自啟用，資料合併顯示。"""
import os

import csv_core
from grid_table import COLORS
from viewer_base import TableTab, open_path

N_SOURCES = 2


class CsvTab(TableTab):
    TAB_KEY = "csv"
    TAB_TITLE = "Cal2_Testing"
    COMBOS = [("station", "站別", 8), ("verdict", "結果", 7), ("opid", "OPID", 10)]
    DEFAULT_HIDDEN = ["timestamp"]

    def __init__(self, shell, parent):
        self.n_ch = csv_core.DEFAULT_CHANNELS
        self.sigs = {}
        self.errors = {}
        cfg = shell.cfg.setdefault(self.TAB_KEY, {})
        srcs = cfg.get("sources")
        if not isinstance(srcs, list):                      # 舊版設定 csv_paths 轉過來
            old = cfg.pop("csv_paths", [])
            srcs = [{"path": old[i] if i < len(old) else "", "enabled": True} for i in range(N_SOURCES)]
        srcs = (srcs + [{"path": "", "enabled": True}] * N_SOURCES)[:N_SOURCES]
        if not any(s["path"] for s in srcs):
            default = os.path.join(shell.app_dir, csv_core.DEFAULT_CSV_NAME)
            if os.path.exists(default):
                srcs[0] = {"path": default, "enabled": True}
        cfg["sources"] = [dict(s) for s in srcs]
        super().__init__(shell, parent)

    # ---------- 來源（兩組，跟原程式一樣：路徑 + 選擇檔案）
    def build_source(self, top):
        tk, ttk = self.tk, self.ttk
        self.src_vars, self.en_vars = [], []
        box = ttk.Frame(top)
        box.pack(fill="x", expand=True)
        box.columnconfigure(2, weight=1)
        for i, src in enumerate(self.cfg["sources"]):
            ttk.Label(box, text=f"CSV 來源 {i + 1}：").grid(row=i, column=0, sticky="w", pady=1)
            en = tk.BooleanVar(value=src.get("enabled", True))
            ttk.Checkbutton(box, text="啟用", variable=en, command=lambda: self._sources_changed()).grid(row=i, column=1, padx=(0, 4))
            pv = tk.StringVar(value=src.get("path", ""))
            ttk.Entry(box, textvariable=pv, state="readonly").grid(row=i, column=2, sticky="ew")
            ttk.Button(box, text="選擇檔案…", command=lambda i=i: self.choose_file(i)).grid(row=i, column=3, padx=(4, 0))
            ttk.Button(box, text="清除", width=5, command=lambda i=i: self.clear_source(i)).grid(row=i, column=4, padx=(4, 0))
            self.src_vars.append(pv)
            self.en_vars.append(en)

    def initial_status(self):
        return "設定 CSV 來源 1 / 2（預設讀取程式旁邊的 operator_log.csv），測試程式往下追加資料時會自動更新"

    def active(self):
        """[(來源編號, 路徑)]，只含有啟用且有設定路徑的。"""
        return [(i + 1, s["path"]) for i, s in enumerate(self.cfg["sources"]) if s.get("enabled", True) and s.get("path")]

    def paths(self):
        return [p for _n, p in self.active()]

    def _sources_changed(self, clear=False):
        for i, s in enumerate(self.cfg["sources"]):
            s["path"] = self.src_vars[i].get()
            s["enabled"] = self.en_vars[i].get()
        self.sigs, self.errors = {}, {}
        self.reset_data()
        self.reset_columns()
        if clear:
            self.clear_filters(refresh=False)
        self.shell.save()
        if self.active():
            self.reload(force=True, scroll="top")
        else:
            self.records = []
            self._update_choices()
            self.refresh_view(scroll="top")
            self.status.set(self.initial_status())

    def choose_file(self, i):
        from tkinter import filedialog
        cur = self.src_vars[i].get() or (self.paths() or [""])[0]
        p = filedialog.askopenfilename(title=f"選擇測試結果 CSV（來源 {i + 1}）",
                                       initialdir=os.path.dirname(cur) if cur else self.shell.app_dir,
                                       filetypes=[("CSV 檔", "*.csv"), ("所有檔案", "*.*")])
        if p:
            self.src_vars[i].set(os.path.normpath(p))
            self.en_vars[i].set(True)
            self._sources_changed(clear=True)

    def clear_source(self, i):
        self.src_vars[i].set("")
        self._sources_changed(clear=True)

    def ready(self):
        return bool(self.active())

    def load(self, force):
        act = self.active()
        sig, missing = {}, []
        for _n, p in act:
            try:
                st = os.stat(p)
                sig[p] = (st.st_mtime, st.st_size)
            except OSError:
                missing.append(os.path.basename(p))
        if not force and sig == self.sigs and self.records:
            return False, self.records, self._info(missing)
        recs, n_ch, errors = [], 0, {}
        for n, p in act:
            if p not in sig:
                continue
            try:
                r, nc = csv_core.load_records(p)
                for x in r:
                    x["_src"] = f"來源{n}"
                recs += r
                n_ch = max(n_ch, nc)
            except Exception as e:  # noqa: BLE001  檔案寫入中，稍後重試
                errors[p] = str(e)
        if errors and self.records and len(errors) == len(sig):
            self.errors = errors
            return False, self.records, self._info(missing)
        self.sigs = {p: s for p, s in sig.items() if p not in errors}
        self.errors = errors
        self.n_ch = n_ch or csv_core.DEFAULT_CHANNELS
        return True, csv_core.finalize(recs), self._info(missing)

    def _info(self, missing):
        msg = "、".join(f"來源{n}" for n, _p in self.active())
        if missing:
            msg += f"　⚠ 找不到檔案：{', '.join(missing)}"
        if self.errors:
            msg += f"　⚠ 讀取失敗（稍後重試）：{', '.join(os.path.basename(p) for p in self.errors)}"
        return msg

    def on_records_changed(self):
        self.reset_columns()          # 通道數可能變了

    # ---------- 欄位 / 顯示
    def columns_all(self):
        cols = csv_core.all_columns(self.n_ch)
        if len(self.active()) > 1:
            cols = cols[:1] + [("_src", "來源", "center")] + cols[1:]
        return cols

    def sn_key(self):
        return "sn"

    def cell(self, rec, key):
        return csv_core.cell_text(rec, key)

    def col_width(self, key, title):
        return {"timestamp": 130, "date": 85, "time": 70, "opid": 70, "sn": 170, "test_status": 80,
                "verdict": 62, "hold_channels": 100, "fail_channels": 100, "station": 70,
                "station_name": 120, "_src": 56}.get(key, 58 if key.startswith("CH") else 90)

    def rec_dt(self, rec):
        return rec["_dt"]

    def rec_date(self, rec):
        return rec["date"]

    def rec_sn(self, rec):
        return rec["sn"]

    def cell_style(self, rec, key):
        """跟原程式一樣：verdict 整格上色、FAIL / HOLD 通道上色、通道數值粗體、重覆測試的 SN 紫色。"""
        if key == "sn" and rec.get("__dup_total", 1) >= 2:
            return csv_core.DUP + (True,)
        if key == "verdict":
            bg, fg = csv_core.VERDICT_COLORS.get(rec["verdict"], (COLORS["cell_bg"], COLORS["cell_fg"]))
            return bg, fg, True
        if key.startswith("CH") and key[2:].isdigit():
            i = int(key[2:])
            if i in rec["_fail"]:
                return csv_core.CH_FAIL + (True,)
            if i in rec["_hold"]:
                return csv_core.CH_HOLD + (True,)
            return COLORS["cell_bg"], COLORS["cell_fg"], True
        return None

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
        cols = [c for c in self.visible_cols() if c[0] != "__dup"]
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
