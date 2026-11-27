# -*- coding: utf-8 -*-
"""分頁 2：Summary*.xlsx 合併檢視與統計（來源目錄往下找所有子資料夾）。"""
import os
from datetime import datetime

import merge_core
from viewer_base import TableTab, open_path

RESULT_COLORS = {"pass": ("#66FF33", "#000000"), "fail": ("#FF0000", "#FFFFFF"), "abort": ("#BFBFBF", "#000000")}
SHEET_HIDDEN = {"TestRecord": ["Folder", "Thermal_history", "Slider", "Mode", "Recipe", "Thermal_with", "Source_File",
                               "Detail", "Repicks", "Thermal_checks", "Total_s", "Note", "Test_SN"],
                "Summary_SN": ["Source_File", "Detail", "Test_SN"]}
# 已經自己選過欄位的人，這些欄位也補進隱藏清單一次（之後可在「選擇欄位」再打開）
HIDE_ONCE = {"v2.1.5": {"TestRecord": ["Detail", "Repicks", "Thermal_checks", "Total_s"], "Summary_SN": ["Detail"]},
             "v2.1.7": {"TestRecord": ["Note", "Test_SN"], "Summary_SN": ["Test_SN"]}}
NO_SEC_COLS = {"Note", "Folder", "Thermal_history", "Detail", "Source_File", "SN", "Timestamp"}


def is_aborted(rec):
    return merge_core._aborted(rec)


class SummaryTab(TableTab):
    TAB_KEY = "summary"
    TAB_TITLE = "Roll Testing"
    COMBOS = [("Result", "結果", 7), ("Detail", "Detail", 12), ("Spec_class", "Spec", 5),
              ("Operator", "Operator", 9), ("Jig", "Jig", 6)]

    def __init__(self, shell, parent):
        self.cache = {}            # path -> (signature, read_file 結果 或 None)
        self.errors = {}
        self.headers = {s: [] for s in merge_core.SHEETS}
        self.data = {s: [] for s in merge_core.SHEETS}
        self.widths = {s: {} for s in merge_core.SHEETS}
        self.file_info = []
        cfg = shell.cfg.setdefault(self.TAB_KEY, {})
        done = cfg.setdefault("hide_once", [])
        for tag, sheets in HIDE_ONCE.items():
            if tag in done:
                continue
            for sheet, cols in sheets.items():
                key = "hidden_" + sheet
                if key in cfg:
                    cfg[key] = list(cfg[key]) + [c for c in cols if c not in cfg[key]]
            done.append(tag)
        super().__init__(shell, parent)

    # 每個資料表各自記住隱藏欄位
    @property
    def DEFAULT_HIDDEN(self):  # noqa: N802
        return SHEET_HIDDEN.get(self.sheet_var.get(), [])

    def hidden_key(self):
        return "hidden_" + self.sheet_var.get()

    # ---------- 來源
    def build_source(self, top):
        tk, ttk = self.tk, self.ttk
        ttk.Label(top, text="來源目錄：").pack(side="left")
        self.src_var = tk.StringVar(value=self.cfg.get("source", ""))
        e = ttk.Entry(top, textvariable=self.src_var)
        e.pack(side="left", fill="x", expand=True)
        e.bind("<Return>", lambda _e: self.set_source(self.src_var.get()))
        ttk.Button(top, text="選擇目錄…", command=self.choose_dir).pack(side="left", padx=(4, 0))
        ttk.Label(top, text="（往下找所有子資料夾裡 Summary 開頭的 Excel）", foreground="#888888").pack(side="left", padx=6)

    def extra_buttons(self, frame):
        ttk = self.ttk
        ttk.Button(frame, text="統計…", command=self.show_stats).pack(side="left")
        ttk.Button(frame, text="合併全部存到來源目錄", command=self.export_all).pack(side="left", padx=4)

    def filter_row_head(self, r1):
        tk, ttk = self.tk, self.ttk
        ttk.Label(r1, text="資料表").pack(side="left")
        self.sheet_var = tk.StringVar(value=self.cfg.get("sheet", "TestRecord"))
        for s, label in (("TestRecord", "TestRecord（每次測試）"), ("Summary_SN", "Summary_SN")):
            ttk.Radiobutton(r1, text=label, value=s, variable=self.sheet_var,
                            command=self.on_sheet_change).pack(side="left", padx=(4, 0))
        ttk.Separator(r1, orient="vertical").pack(side="left", fill="y", padx=8)

    def initial_status(self):
        return "選擇來源目錄後會自動讀取底下所有 Summary 開頭的 Excel，測試程式產生新檔或寫入新資料時會自動更新"

    def save_extra(self):
        self.cfg["source"] = self.src_var.get().strip()
        self.cfg["sheet"] = self.sheet_var.get()

    def choose_dir(self):
        from tkinter import filedialog
        p = filedialog.askdirectory(title="選擇來源目錄", initialdir=self.src_var.get() or None)
        if p:
            self.set_source(p)

    def set_source(self, p):
        p = os.path.normpath(p.strip().strip('"'))
        self.src_var.set(p)
        self.cache, self.errors = {}, {}
        self.reset_data()
        self.clear_filters(refresh=False)
        self.save()
        self.reload(force=True, scroll="top")

    def ready(self):
        src = self.src_var.get().strip()
        if not src:
            return False
        if not os.path.isdir(src):
            self.status.set(f"⚠ 找不到目錄：{src}")
            return False
        return True

    def load(self, force):
        root = self.src_var.get().strip()
        sig = {}
        for p in merge_core.find_summary_files(root):
            try:
                st = os.stat(p)
                sig[p] = (st.st_mtime, st.st_size)
            except OSError:
                pass
        changed = force or set(sig) != set(self.cache)
        for p in list(self.cache):
            if p not in sig:
                del self.cache[p]
                self.errors.pop(p, None)
        for p, s in sig.items():
            old = self.cache.get(p)
            if force or old is None or old[0] != s:
                try:
                    self.cache[p] = (s, merge_core.read_file(p))
                    self.errors.pop(p, None)
                    changed = True
                except Exception as e:  # noqa: BLE001  寫入中，下次再讀
                    self.errors[p] = str(e)
                    if old is None:
                        self.cache[p] = (None, None)
        if changed:
            results = [(p, res) for p, (_s, res) in sorted(self.cache.items()) if res is not None]
            self.headers, self.data, self.widths = merge_core.combine(results)
            self.file_info = [(p, "無法開啟", 0, 0) if res is None else
                              (p, "OK", len(res.get("Summary_SN", ((), ()))[1]), len(res.get("TestRecord", ((), ()))[1]))
                              for p, (_s, res) in sorted(self.cache.items())]
        info = f"{len(self.cache)} 個檔案"
        if self.errors:
            info += f"　⚠ 讀取失敗（稍後重試）：{', '.join(os.path.basename(p) for p in self.errors)}"
        return changed, self.data.get(self.sheet_var.get(), []), info

    def on_sheet_change(self):
        self.save()
        self.only_ids = None
        self.records = self.data.get(self.sheet_var.get(), [])
        self.last_count = len(self.records)
        self._reset_sort()
        self.reset_columns()
        self._update_choices()
        self.refresh_view(scroll="top")

    # ---------- 欄位 / 顯示
    def columns_all(self):
        hdr = self.headers.get(self.sheet_var.get()) or []
        titles = {"Timestamp": "Time"}           # 日期已有 Date 欄，這裡只顯示 時_分_秒
        return [(h, titles.get(h, h), "w" if h in NO_SEC_COLS and h != "Timestamp" else "center") for h in hdr]

    def cell(self, rec, key):
        v = rec.get(key)
        if v is None:
            return ""
        if key == "Timestamp":                    # 2026_11_25_14_00_38 → 14_00_38
            ts = rec.get("__ts")
            return ts.strftime("%H_%M_%S") if ts else str(v)
        if isinstance(v, float):
            return f"{v:g}"
        return str(v)

    def sort_value(self, rec, key):
        if key == "Timestamp" and rec.get("__ts"):
            return rec["__ts"].timestamp()           # Time 欄排序仍依完整日期時間
        return self.cell(rec, key)

    def col_width(self, key, title):
        w = self.widths.get(self.sheet_var.get(), {}).get(key)
        fixed = {"Date": 88, "Result": 60, "Source_File": 170, "Timestamp": 90, "SN": 160}
        if key in fixed:
            return fixed[key]
        return int(min(w or 12, 50) * 7.5) if w else super().col_width(key, title)

    def rec_dt(self, rec):
        return rec.get("__ts")

    def rec_date(self, rec):
        return rec.get("Date", "")

    def rec_sn(self, rec):
        return str(rec.get("SN") or "")

    def row_tag(self, rec):
        if is_aborted(rec):
            return "abort"
        return "fail" if str(rec.get("Result") or "").strip().lower() == "fail" else "pass"

    def cell_style(self, rec, key):
        """Result / Verdict 整格上色（Pass 綠、Fail 紅、Aborted 灰），重覆測試的 SN 紫色。"""
        if key in ("Result", "Verdict"):
            bg, fg = RESULT_COLORS[self.row_tag(rec)]
            return bg, fg, True
        if key == "SN" and rec.get("__dup_total", 1) > 1:
            return "#D9B3FF", "#4B0082", True
        return None

    def combo_values(self, key, vals):
        if key == "Result":
            return [v for v in ("Pass", "Fail") if v in vals] + [v for v in vals if v not in ("Pass", "Fail")] + ["Aborted"]
        return vals

    def combo_match(self, rec, key, val):
        if key == "Result" and val == "Aborted":
            return is_aborted(rec)
        return self.cell(rec, key) == val

    def _update_choices(self):
        super()._update_choices()
        hdr = self.headers.get(self.sheet_var.get(), [])
        for key, cb in self.combos.items():
            cb.configure(state="readonly" if key in hdr else "disabled")

    def stats_items(self, rows):
        n = len(rows)
        p = sum(1 for r in rows if str(r.get("Result") or "").lower() == "pass")
        f = sum(1 for r in rows if str(r.get("Result") or "").lower() == "fail")
        a = sum(1 for r in rows if is_aborted(r))
        y1 = f"{p / (p + f) * 100:.1f}%" if p + f else "-"
        y2 = f"{p / (p + f - a) * 100:.1f}%" if p + f - a > 0 else "-"
        return [(f"總數 {n}", "#000000", None), (f"Pass {p}", "#008000", None), (f"Fail {f}", "#C00000", None),
                (f"（其中 Aborted {a}）", "#666666", None), (f"良率 {y1}　（排除 Aborted {y2}）", "#0050A0", None),
                self.dup_stat(rows)]

    def context_extra(self, menu, rec):
        if rec.get("Folder"):
            menu.add_command(label="開啟測試資料夾", command=lambda: self.open_folder(rec["Folder"]))
        menu.add_command(label="開啟來源 Excel", command=lambda: self.open_folder(rec.get("__path")))

    # ---------- 詳細資料
    def show_detail(self, rec):
        tk, ttk = self.tk, self.ttk
        w = tk.Toplevel(self.root)
        w.title(f"{rec.get('SN', '')}　{rec.get('Result', '')}　{rec.get('Timestamp', '')}")
        w.geometry("760x560")
        kind = self.row_tag(rec)
        hb = {"pass": "#C6EFCE", "fail": "#FFC7CE", "abort": "#E7E6E6"}[kind]
        head = tk.Frame(w, bg=hb)
        head.pack(fill="x")
        tk.Label(head, text=f"  {rec.get('SN', '')}   {rec.get('Result', '')}   {rec.get('Detail', '')}",
                 font=("", 13, "bold"), bg=hb).pack(side="left", pady=6)
        if rec.get("__dup_total", 1) > 1:
            tk.Label(head, text=f"  ⚠ 重覆測試：第 {rec['__dup_no']} 次，共 {rec['__dup_total']} 次  ",
                     bg="#FFF2CC", fg="#7F4F00").pack(side="right", padx=6)
        bar = ttk.Frame(w, padding=6)
        bar.pack(fill="x", side="bottom")
        txt = tk.Text(w, wrap="word", font=("Consolas", 10))
        txt.pack(fill="both", expand=True)
        txt.tag_configure("k", font=("Consolas", 10, "bold"))
        keys = [k for k, _t, _a in self._all_cols()]
        width = max((len(k) for k in keys), default=10)
        lines = []
        for k in keys:
            t = "次數" if k == "__dup" else k
            v = str(rec.get(k) or "") if k == "Timestamp" else self.text(rec, k)   # 詳細資料保留完整時間
            lines.append(f"{t}: {v}")
            txt.insert("end", f"{t:<{width}} : ", ("k",))
            txt.insert("end", v + "\n")
        txt.insert("end", f"{'來源檔':<{width}} : ", ("k",))
        txt.insert("end", str(rec.get("__path", "")))
        txt.configure(state="disabled")
        if rec.get("Folder"):
            ttk.Button(bar, text="開啟測試資料夾", command=lambda: self.open_folder(rec["Folder"])).pack(side="left")
        ttk.Button(bar, text="開啟來源 Excel", command=lambda: self.open_folder(rec.get("__path"))).pack(side="left", padx=6)
        ttk.Button(bar, text="複製全部", command=lambda: self.clip("\n".join(lines), "詳細資料")).pack(side="left")
        ttk.Button(bar, text="關閉", command=w.destroy).pack(side="right")
        w.bind("<Escape>", lambda _e: w.destroy())

    # ---------- 統計 / 匯出
    def _filtered_both(self):
        """目前的篩選套用到兩個資料表（統計、匯出用）。「只顯示選取的列」只套用在目前資料表。"""
        cur = self.sheet_var.get()
        saved = self.records
        out = {}
        for s in merge_core.SHEETS:
            self.records = self.data.get(s, [])
            out[s] = self.filtered(use_only=(s == cur))
        self.records = saved
        return out

    def show_stats(self):
        tk, ttk = self.tk, self.ttk
        if not any(self.data.values()):
            return
        stats = merge_core.build_stats(self._filtered_both())
        w = tk.Toplevel(self.root)
        w.title("統計（套用目前篩選）")
        w.geometry("1000x520")
        nb = ttk.Notebook(w)
        nb.pack(fill="both", expand=True, padx=6, pady=6)
        for key, title in (("daily", "每日良率"), ("detail", "Detail"), ("spec", "Spec_class"),
                           ("contrast", "Contrast_class")):
            rows = stats[key]
            f = ttk.Frame(nb)
            nb.add(f, text=title)
            if not rows:
                ttk.Label(f, text="（無資料）").pack()
                continue
            cols = list(rows[0].keys())
            tv = ttk.Treeview(f, columns=cols, show="headings")
            for c in cols:
                tv.heading(c, text=c)
                tv.column(c, width=110 if c in ("日期", "Detail") else 85, anchor="center")
            tv.tag_configure("total", background="#F2F2F2")
            for r in rows:
                vals = []
                for c in cols:
                    v = r[c]
                    if c.startswith("良率") or c == "占比":
                        v = f"{v:.1%}" if v is not None else "-"
                    vals.append("" if v is None else v)
                tv.insert("", "end", values=vals, tags=("total",) if r[cols[0]] == "合計" else ())
            tv.pack(fill="both", expand=True)
        ttk.Label(w, text="良率以 Summary_SN 為準；測試次數以 TestRecord 為準", foreground="#888888").pack(pady=(0, 6))

    def export(self):
        from tkinter import messagebox
        if not any(self.data.values()):
            messagebox.showinfo(self.TAB_TITLE, "目前沒有可匯出的資料")
            return
        path = self.export_path("Merged_Summary_", initialdir=self.src_var.get() or None)
        if path:
            if not path.lower().endswith(".xlsx"):
                path += ".xlsx"
            self._write(path, self._filtered_both())

    def export_all(self):
        from tkinter import messagebox
        if not any(self.data.values()):
            messagebox.showinfo(self.TAB_TITLE, "目前沒有可匯出的資料")
            return
        path = merge_core.default_output(self.src_var.get(), [p for p, *_ in self.file_info])
        self._write(path, self.data)

    def _write(self, path, data):
        from tkinter import messagebox
        try:
            merge_core.write_output(path, self.headers, data, self.widths, self.file_info)
        except PermissionError:
            messagebox.showerror(self.TAB_TITLE, f"無法寫入，檔案可能正在 Excel 中開啟：\n{path}")
            return
        except Exception as e:  # noqa: BLE001
            messagebox.showerror(self.TAB_TITLE, f"匯出失敗：{e}")
            return
        self.status.set(f"已匯出 TestRecord {len(data['TestRecord'])} 筆 / Summary_SN {len(data['Summary_SN'])} 筆 → {path}"
                        f"　{datetime.now():%H:%M:%S}")
        if messagebox.askyesno(self.TAB_TITLE, f"已匯出：\n{path}\n\n要開啟嗎？"):
            open_path(path)
