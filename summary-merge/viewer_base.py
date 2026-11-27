# -*- coding: utf-8 -*-
"""
分頁共用的表格檢視器：表格、篩選（日期多選 / 時間區間 / 下拉 / SN / 重覆測試）、統計列、
右鍵選單、複製、只顯示選取列、選擇欄位、排序、定時自動重讀（背景執行緒）。

子類別要提供：
    TAB_KEY, TAB_TITLE, DEFAULT_HIDDEN, COMBOS = [(key, 標題, 寬度)], ROW_TAGS = {tag: 底色}
    build_source(frame)          來源選擇列
    load(force) -> (changed, records, info)   在背景執行緒讀檔；records 已依時間排序（舊→新）
    columns_all() -> [(key, 標題, 對齊 'w'/'e'/'center')]
    cell(rec, key) -> str
    rec_dt(rec) -> datetime|None ; rec_date(rec) -> 'YYYY-MM-DD' 之類 ; rec_sn(rec)
    row_tag(rec) -> tag
    stats_items(rows) -> [(文字, 字色, 底色)]
    show_detail(rec) ; export()
    context_extra(menu, rec)（可選）
"""
import os
import re
import subprocess
import sys
import threading

from grid_table import GridTable
from datetime import datetime, time as dtime

ALL = "全部"
DUP_COL = "__dup"


def open_path(path):
    if sys.platform.startswith("win"):
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def parse_when(s, upper=False):
    """'8' / '08:30' / '08:30:15' / '2026-11-25 08:30' / '2026/11/25' → (date|None, time|None)。
    upper=True（結束時間）時，省略的分 / 秒補 59。"""
    s = (s or "").strip()
    if not s:
        return None, None
    d = t = None
    m = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", s)
    if m:
        d = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).date()
        s = (s[:m.start()] + s[m.end():]).strip()
    if s:
        m = re.fullmatch(r"(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?", s)
        if not m:
            raise ValueError(s)
        fill = 59 if upper else 0
        mi = int(m.group(2)) if m.group(2) is not None else fill
        se = int(m.group(3)) if m.group(3) is not None else fill
        t = dtime(int(m.group(1)), mi, se)
    return d, t


class TableTab:
    TAB_KEY = "tab"
    TAB_TITLE = "Tab"
    DEFAULT_HIDDEN = []
    COMBOS = []
    ROW_TAGS = {}
    SHOW_DUP_COL = True

    def __init__(self, shell, parent):
        import tkinter as tk
        from tkinter import ttk
        self.tk, self.ttk = tk, ttk
        self.shell = shell
        self.root = shell.root
        self.cfg = shell.cfg.setdefault(self.TAB_KEY, {})
        self.records = []
        self.view_rows = []
        self.only_ids = None
        self.sort_key, self.sort_desc = None, False
        self.sel_dates = set()
        self.date_popup = None
        self.loading = False
        self.last_count = None
        self.added = 0
        self.info = ""
        self._suspend = False
        self._deb = None

        self.frame = ttk.Frame(parent)
        self._build(self.frame)
        self.refresh_view()

    # ================================================================ 版面
    def _build(self, f):
        tk, ttk = self.tk, self.ttk
        cfg = self.cfg
        top = ttk.Frame(f, padding=(6, 6, 6, 0))
        top.pack(fill="x")
        self.build_source(top)

        opt = ttk.Frame(f, padding=(6, 4, 6, 0))
        opt.pack(fill="x")
        ttk.Button(opt, text="重新載入", command=lambda: self.reload(force=True)).pack(side="left")
        ttk.Button(opt, text="匯出 Excel…", command=self.export).pack(side="left", padx=4)
        self.extra_buttons(opt)
        self.auto_var = tk.BooleanVar(value=cfg.get("auto_refresh", True))
        ttk.Checkbutton(opt, text="自動更新", variable=self.auto_var, command=self.save).pack(side="left", padx=(10, 0))
        ttk.Label(opt, text="每").pack(side="left")
        self.interval_var = tk.IntVar(value=cfg.get("interval", 3))
        ttk.Spinbox(opt, from_=1, to=300, width=4, textvariable=self.interval_var, command=self.save).pack(side="left")
        ttk.Label(opt, text="秒").pack(side="left", padx=(2, 10))
        self.newest_var = tk.BooleanVar(value=cfg.get("newest_first", True))
        ttk.Checkbutton(opt, text="最新在上", variable=self.newest_var,
                        command=lambda: (self.save(), self._reset_sort(), self.refresh_view(scroll="top"))).pack(side="left")
        self.follow_var = tk.BooleanVar(value=cfg.get("follow", True))
        ttk.Checkbutton(opt, text="有新資料時自動捲到最新", variable=self.follow_var, command=self.save).pack(side="left", padx=8)

        flt = ttk.LabelFrame(f, text="篩選", padding=(6, 2))
        flt.pack(fill="x", padx=6, pady=4)
        r1 = ttk.Frame(flt)
        r1.pack(fill="x")
        self.filter_row_head(r1)
        ttk.Label(r1, text="日期").pack(side="left")
        self.date_btn = ttk.Button(r1, text="不限 ▼", width=16, command=self.toggle_date_popup)
        self.date_btn.pack(side="left", padx=(4, 8))
        ttk.Label(r1, text="時間").pack(side="left")
        self.from_var, self.to_var = tk.StringVar(), tk.StringVar()
        self.from_ent = ttk.Entry(r1, textvariable=self.from_var, width=18)
        self.from_ent.pack(side="left", padx=(4, 0))
        ttk.Label(r1, text="～").pack(side="left")
        self.to_ent = ttk.Entry(r1, textvariable=self.to_var, width=18)
        self.to_ent.pack(side="left")
        ttk.Label(r1, text="（HH:MM = 每天同時段；含日期 = 指定區間，可跨天）", foreground="#888888").pack(side="left", padx=4)

        r2 = ttk.Frame(flt)
        r2.pack(fill="x", pady=(4, 2))
        self.combo_vars, self.combos = {}, {}
        for key, label, w in self.COMBOS:
            ttk.Label(r2, text=label).pack(side="left")
            v = tk.StringVar(value=ALL)
            cb = ttk.Combobox(r2, textvariable=v, width=w, state="readonly", values=[ALL])
            cb.pack(side="left", padx=(4, 10))
            cb.bind("<<ComboboxSelected>>", lambda _e: self.refresh_view(scroll="top"))
            self.combo_vars[key], self.combos[key] = v, cb
        ttk.Label(r2, text="SN").pack(side="left")
        self.sn_var = tk.StringVar()
        sn_ent = ttk.Entry(r2, textvariable=self.sn_var, width=20)
        sn_ent.pack(side="left", padx=(4, 8))
        self.dup_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(r2, text="只看重覆測試", variable=self.dup_var,
                        command=lambda: self.refresh_view(scroll="top")).pack(side="left")
        ttk.Button(r2, text="✖ 清除篩選", command=self.clear_filters).pack(side="left", padx=8)
        ttk.Button(r2, text="☑ 選擇欄位…", command=self.choose_columns).pack(side="left")
        self.only_btn = ttk.Button(r2, text="✔ 只顯示選取的列", command=self.show_only_selected, state="disabled")
        self.only_btn.pack(side="right")
        self.all_btn = ttk.Button(r2, text="↺ 顯示全部", command=self.show_all, state="disabled")
        self.all_btn.pack(side="right", padx=4)
        for var in (self.sn_var, self.from_var, self.to_var):
            var.trace_add("write", lambda *_a: self._debounce())
        for ent in (sn_ent, self.from_ent, self.to_ent):
            self._entry_menu(ent)

        st = tk.Frame(f, bg="#F3F3F3")
        st.pack(fill="x", padx=6)
        self.stat_frame = st
        self.stat_labels = []
        self.st_info = tk.Label(st, bg="#F3F3F3", fg="#555555")
        self.st_info.pack(side="right", padx=4)

        tf = ttk.Frame(f)
        tf.pack(fill="both", expand=True, padx=6, pady=(2, 0))
        self.grid = GridTable(tf, style_fn=self.cell_style, on_double=self.show_detail,
                              on_context=self.on_right_click, on_header=self.sort_by,
                              on_select=self._on_select, on_copy=lambda: self.copy_rows(self.selected_recs()))
        self.grid.pack(fill="both", expand=True)
        self._col_keys = None

        self.status = tk.StringVar(value=self.initial_status())
        ttk.Label(f, textvariable=self.status, relief="sunken", anchor="w", padding=(6, 2)).pack(fill="x", side="bottom")
        ttk.Label(f, foreground="#888888", padding=(6, 0),
                  text="Ctrl/Shift 多選、Ctrl+A 全選、Ctrl+C 複製（可直接貼到 Excel）；右鍵：複製格/列/整欄、"
                       "用此 SN 篩選、只看這一天、從此時間開始；雙擊或 Enter 看詳細資料；點標題排序").pack(fill="x", side="bottom")

    # 子類別可覆寫
    def extra_buttons(self, frame):
        pass

    def filter_row_head(self, frame):
        pass

    def initial_status(self):
        return ""

    def _entry_menu(self, ent):
        tk = self.tk

        def popup(e):
            m = tk.Menu(ent, tearoff=0)
            m.add_command(label="剪下", command=lambda: ent.event_generate("<<Cut>>"))
            m.add_command(label="複製", command=lambda: ent.event_generate("<<Copy>>"))
            m.add_command(label="貼上", command=lambda: ent.event_generate("<<Paste>>"))
            m.add_separator()
            m.add_command(label="清除", command=lambda: ent.delete(0, "end"))
            m.tk_popup(e.x_root, e.y_root)
        ent.bind("<Button-3>", popup)

    # ================================================================ 設定
    def save(self):
        self.cfg.update({"auto_refresh": self.auto_var.get(), "newest_first": self.newest_var.get(),
                         "follow": self.follow_var.get()})
        try:
            self.cfg["interval"] = max(1, int(self.interval_var.get()))
        except Exception:  # noqa: BLE001
            pass
        self.save_extra()
        self.shell.save()

    def save_extra(self):
        pass

    # ================================================================ 讀檔
    def reload(self, force=False, scroll=None):
        if self.loading or not self.ready():
            return
        self.loading = True
        if force:
            self.status.set("讀取中…")

        def work():
            try:
                res = self.load(force)
                self.shell.post(lambda: self._loaded(res, scroll))
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.shell.post(lambda: self._load_failed(msg))
        threading.Thread(target=work, daemon=True).start()

    def ready(self):
        return True

    def _load_failed(self, msg):
        self.loading = False
        self.status.set(f"⚠ 讀取失敗（稍後重試）：{msg}")

    def _loaded(self, res, scroll):
        self.loading = False
        changed, records, info = res
        self.info = info
        if changed or self.last_count is None:
            old = self.last_count
            self.records = records
            n = len(records)
            self.added = n - old if old is not None and n > old else 0
            self.last_count = n
            self.on_records_changed()
            self._update_choices()
            if scroll is None and self.added and self.follow_var.get():
                scroll = "newest"
            self.refresh_view(scroll=scroll)
        now = datetime.now().strftime("%H:%M:%S")
        msg = f"最後讀取 {now}　共 {len(self.records)} 筆"
        if self.added:
            msg += f"　（新增 {self.added} 筆）"
        if info:
            msg += f"　{info}"
        self.status.set(msg)

    def on_records_changed(self):
        pass

    def tick(self):
        try:
            if self.auto_var.get() and not self.loading:
                self.reload()
        except Exception:  # noqa: BLE001
            pass

    def interval(self):
        try:
            return max(1, int(self.interval_var.get()))
        except Exception:  # noqa: BLE001
            return 3

    def reset_data(self):
        self.records, self.last_count, self.added = [], None, 0
        self.only_ids = None

    # ================================================================ 欄位
    def _all_cols(self):
        cols = list(self.columns_all())
        if self.SHOW_DUP_COL and cols:
            keys = [c[0] for c in cols]
            pos = keys.index(self.sn_key()) + 1 if self.sn_key() in keys else 1
            cols.insert(pos, (DUP_COL, "次數", "center"))
        return cols

    def sn_key(self):
        return "SN"

    def visible_cols(self):
        hidden = set(self.cfg.get(self.hidden_key(), self.DEFAULT_HIDDEN))
        return [c for c in self._all_cols() if c[0] not in hidden]

    def hidden_key(self):
        return "hidden"

    def text(self, rec, key):
        if key == DUP_COL:
            return f"{rec.get('__dup_no', 1)}/{rec.get('__dup_total', 1)}"
        return self.cell(rec, key)

    def col_width(self, key, title):
        return max(60, min(320, 9 * len(title) + 24))

    def _reset_sort(self):
        self.sort_key, self.sort_desc = None, False

    def _update_choices(self):
        for key, cb in self.combos.items():
            vals = sorted({self.cell(r, key) for r in self.records} - {""})
            vals = self.combo_values(key, vals)
            cb.configure(values=[ALL] + vals)
            if self.combo_vars[key].get() not in [ALL] + vals:
                self.combo_vars[key].set(ALL)
        self.sel_dates &= {self.rec_date(r) for r in self.records}
        self._update_date_btn()

    def combo_values(self, key, vals):
        return vals

    def combo_match(self, rec, key, val):
        return self.cell(rec, key) == val

    # ================================================================ 篩選
    def _debounce(self):
        if self._deb:
            self.root.after_cancel(self._deb)
        self._deb = self.root.after(300, lambda: self.refresh_view(scroll="top"))

    def _time_bounds(self):
        out = []
        for ent, var, upper in ((self.from_ent, self.from_var, False), (self.to_ent, self.to_var, True)):
            try:
                out.append(parse_when(var.get(), upper))
                ent.configure(foreground="black")
            except ValueError:
                out.append((None, None))
                ent.configure(foreground="red")
        return out

    def filtered(self, use_only=True):
        (fd, ft), (td, tt) = self._time_bounds()
        sns = [s.lower() for s in re.split(r"[\s,;]+", self.sn_var.get().strip()) if s]
        combos = {k: v.get() for k, v in self.combo_vars.items() if v.get() != ALL}
        timed = fd or ft or td or tt
        out = []
        for r in self.records:
            if self.sel_dates and self.rec_date(r) not in self.sel_dates:
                continue
            if any(not self.combo_match(r, k, v) for k, v in combos.items()):
                continue
            if sns:
                sn = self.rec_sn(r).lower()
                if not any(s in sn for s in sns):
                    continue
            if self.dup_var.get() and r.get("__dup_total", 1) < 2:
                continue
            if timed:
                ts = self.rec_dt(r)
                if ts is None:
                    continue
                if fd and ts < datetime.combine(fd, ft or dtime(0, 0)):
                    continue
                if not fd and ft and ts.time() < ft:
                    continue
                if td and ts > datetime.combine(td, tt or dtime(23, 59, 59)):
                    continue
                if not td and tt and ts.time() > tt:
                    continue
            out.append(r)
        if use_only and self.only_ids is not None:
            out = [r for r in out if id(r) in self.only_ids]
        return out

    def clear_filters(self, refresh=True):
        self._suspend = True
        for v in self.combo_vars.values():
            v.set(ALL)
        self.sn_var.set("")
        self.from_var.set("")
        self.to_var.set("")
        self.dup_var.set(False)
        self.sel_dates = set()
        self.only_ids = None
        self._update_date_btn()
        self._suspend = False
        if refresh:
            self.refresh_view(scroll="top")

    # ---------------------------------------------------------------- 日期多選
    def _update_date_btn(self):
        d = sorted(self.sel_dates)
        t = "不限" if not d else d[0] if len(d) == 1 else f"已選 {len(d)} 天"
        self.date_btn.configure(text=t + " ▼")

    def close_date_popup(self):
        if self.date_popup and self.date_popup.winfo_exists():
            self.date_popup.destroy()
        self.date_popup = None

    def toggle_date_popup(self):
        tk, ttk = self.tk, self.ttk
        if self.date_popup and self.date_popup.winfo_exists():
            self.close_date_popup()
            return
        counts = {}
        for r in self.records:
            d = self.rec_date(r)
            counts[d] = counts.get(d, 0) + 1
        top = tk.Toplevel(self.root)
        top.overrideredirect(True)
        top.geometry(f"+{self.date_btn.winfo_rootx()}+{self.date_btn.winfo_rooty() + self.date_btn.winfo_height()}")
        frm = tk.Frame(top, bd=1, relief="solid", bg="#FFFFFF")
        frm.pack(fill="both", expand=True)
        bar = tk.Frame(frm, bg="#F0F0F0")
        bar.pack(fill="x")
        vars_ = {}

        def apply():
            self.sel_dates = {d for d, v in vars_.items() if v.get()}
            self._update_date_btn()
            self.refresh_view(scroll="top")

        def set_all(val):
            for v in vars_.values():
                v.set(val)
            apply()
        ttk.Button(bar, text="全選", width=5, command=lambda: set_all(True)).pack(side="left", padx=2, pady=2)
        ttk.Button(bar, text="清除", width=5, command=lambda: set_all(False)).pack(side="left", pady=2)
        ttk.Button(bar, text="關閉", width=5, command=self.close_date_popup).pack(side="right", padx=2, pady=2)
        canvas = tk.Canvas(frm, bg="#FFFFFF", highlightthickness=0, width=220,
                           height=min(360, 24 * max(1, len(counts)) + 8))
        sb = ttk.Scrollbar(frm, orient="vertical", command=canvas.yview)
        body = tk.Frame(canvas, bg="#FFFFFF")
        canvas.create_window((0, 0), window=body, anchor="nw")
        canvas.configure(yscrollcommand=sb.set)
        canvas.pack(side="left", fill="both", expand=True, padx=4, pady=4)
        if len(counts) > 14:
            sb.pack(side="right", fill="y")
        if not counts:
            tk.Label(body, text="（沒有資料）", fg="#888888", bg="#FFFFFF").pack()
        for d in sorted(counts, reverse=True):
            v = tk.BooleanVar(value=d in self.sel_dates)
            vars_[d] = v
            tk.Checkbutton(body, text=f"{d}　（{counts[d]} 筆）", variable=v, command=apply, anchor="w",
                           bg="#FFFFFF", activebackground="#E5F1FB").pack(fill="x")
        body.update_idletasks()
        canvas.configure(scrollregion=canvas.bbox("all"))
        canvas.bind("<MouseWheel>", lambda e: canvas.yview_scroll(-1 if e.delta > 0 else 1, "units"))
        top.bind("<Escape>", lambda _e: self.close_date_popup())
        self.date_popup = top
        self.shell.on_click_outside(top, self.date_btn, self.close_date_popup)

    # ================================================================ 表格
    def reset_columns(self):
        if self._col_keys is not None:
            self.remember_widths()
        self._col_keys = None

    def cell_style(self, rec, key):
        """回傳 (底色, 字色, 粗體) 或 None；子類別覆寫。"""
        return None

    def refresh_view(self, scroll=None):
        if self._suspend:
            return
        cols = self.visible_cols()
        keys = [c[0] for c in cols]
        rows = self.filtered()
        if self.sort_key in keys:
            sk = self.sort_key

            def k(r):
                if sk == DUP_COL:
                    return (0, r.get("__dup_no", 1), "")
                v = self.cell(r, sk)
                try:
                    return (0, float(v), "")
                except ValueError:
                    return (1, 0, v)
            rows = sorted(rows, key=k, reverse=self.sort_desc)
        elif self.newest_var.get():
            rows = list(reversed(rows))
        self.view_rows = rows

        sel_ids = {id(r) for r in self.selected_recs()}
        y0 = self.grid.yview_frac()
        if self._col_keys != keys:
            if self._col_keys is not None:
                self.remember_widths()
            widths = self.cfg.get("widths", {})
            self._col_keys = keys
            self._titles = {k: t for k, t, _a in cols}
            gcols = [[k, t, a, widths.get(k, self.col_width(k, t))] for k, t, a in cols]
        else:
            gcols = self.grid.cols
        for c in gcols:
            arrow = (" ▼" if self.sort_desc else " ▲") if c[0] == self.sort_key else ""
            c[1] = self._titles[c[0]] + arrow
        self.grid.set_columns(gcols)
        self.grid.set_rows(rows, self.text, keep_sel_ids=sel_ids)
        if scroll == "top" or (scroll == "newest" and self.newest_var.get() and not self.sort_key):
            self.grid.to_top()
        elif scroll == "newest":
            self.grid.to_bottom()
        else:
            self.grid.moveto(y0)
        self._update_stats(rows)
        self.only_btn.configure(state="normal" if self.grid.sel else "disabled")
        self.all_btn.configure(state="normal" if self.only_ids is not None else "disabled")

    def remember_widths(self):
        w = self.cfg.setdefault("widths", {})
        w.update(self.grid.widths())

    def sort_by(self, col):
        if self.sort_key == col:
            if self.sort_desc:
                self.sort_key = None                # 第三次點 → 回到依時間
            self.sort_desc = not self.sort_desc
        else:
            self.sort_key, self.sort_desc = col, False
        if self.sort_key is None:
            self.sort_desc = False
        self.refresh_view(scroll="top")

    def _update_stats(self, rows):
        tk = self.tk
        for w in self.stat_labels:
            w.destroy()
        self.stat_labels = []
        for text, fg, bg in self.stats_items(rows):
            lb = tk.Label(self.stat_frame, text=text, font=("", 10, "bold"), fg=fg, bg=bg or "#F3F3F3")
            lb.pack(side="left", padx=(4, 12), pady=2)
            self.stat_labels.append(lb)
        dates = sorted({self.rec_date(r) for r in rows} - {""})
        self.st_info.configure(text=f"{dates[0]} ~ {dates[-1]}" if dates else "")

    def dup_stat(self, rows):
        sns = {self.rec_sn(r) for r in rows if r.get("__dup_total", 1) > 1}
        n = sum(1 for r in rows if r.get("__dup_total", 1) > 1)
        return (f" 重覆測試：{len(sns)} 個 SN／{n} 筆 " if sns else " 重覆測試：無 ", "#7F4F00", "#FFF2CC")

    def selected_recs(self):
        return self.grid.selected()

    def _on_select(self, n=0):
        self.only_btn.configure(state="normal" if n else "disabled")

    def show_only_selected(self):
        recs = self.selected_recs()
        if recs:
            self.only_ids = {id(r) for r in recs}
            self.refresh_view(scroll="top")
            self.status.set(f"只顯示選取的 {len(recs)} 筆（按「顯示全部」還原）")

    def show_all(self):
        self.only_ids = None
        self.refresh_view()

    # ================================================================ 複製 / 右鍵
    def clip(self, text, what=""):
        self.root.clipboard_clear()
        self.root.clipboard_append(text)
        self.status.set(f"已複製{what}（以 Tab 分隔，可直接貼到 Excel）")

    def rows_text(self, recs, header=True):
        cols = self.visible_cols()
        lines = ["\t".join(t for _k, t, _a in cols)] if header else []
        lines += ["\t".join(self.text(r, k).replace("\t", " ").replace("\n", " ") for k, _t, _a in cols) for r in recs]
        return "\n".join(lines)

    def copy_rows(self, recs):
        if recs:
            self.clip(self.rows_text(recs), f" {len(recs)} 列")
        return "break"

    def on_right_click(self, e, region, rec, key):
        tk = self.tk
        col = next((c for c in self.visible_cols() if c[0] == key), None)
        m = tk.Menu(self.root, tearoff=0)
        if region == "heading":
            if not col:
                return
            key, title, _a = col
            vals = [self.text(r, key) for r in self.view_rows]
            m.add_command(label=f"複製整欄「{title}」（{len(vals)} 筆）", command=lambda: self.clip("\n".join(vals), f"整欄「{title}」"))
            m.add_command(label=f"複製整欄「{title}」（含標題）",
                          command=lambda: self.clip("\n".join([title] + vals), f"整欄「{title}」"))
            m.add_command(label="選擇欄位…", command=self.choose_columns)
            m.tk_popup(e.x_root, e.y_root)
            return
        if rec is None:
            return
        if col:
            key, title, _a = col
            v = self.text(rec, key)
            short = v if len(v) <= 40 else v[:40] + "…"
            m.add_command(label=f"複製：{short}" if v else "複製（空白）", state="normal" if v else "disabled",
                          command=lambda: self.clip(v, f"：{short}"))
        more = tk.Menu(m, tearoff=0)
        sel = self.selected_recs()
        more.add_command(label="複製這一整列（含標題）", command=lambda: self.copy_rows([rec]))
        more.add_command(label=f"複製選取的列（{len(sel)} 列，含標題）", command=lambda: self.copy_rows(sel))
        more.add_command(label=f"複製全部資料（畫面上 {len(self.view_rows)} 列）", command=lambda: self.copy_rows(self.view_rows))
        if col:
            more.add_command(label=f"複製整欄「{col[1]}」",
                             command=lambda: self.clip("\n".join(self.text(r, col[0]) for r in self.view_rows), f"整欄「{col[1]}」"))
        m.add_cascade(label="複製更多", menu=more)
        m.add_separator()
        m.add_command(label="查看詳細資料", command=lambda: self.show_detail(rec))
        self.context_extra(m, rec)
        m.add_separator()
        sn = self.rec_sn(rec)
        if sn:
            m.add_command(label=f"用此 SN 篩選：{sn}", command=lambda: self._filter_sn(sn))
        d = self.rec_date(rec)
        if d:
            m.add_command(label=f"只看這一天：{d}", command=lambda: self._filter_date(d))
        ts = self.rec_dt(rec)
        if ts:
            t = ts.strftime("%Y-%m-%d %H:%M:%S")
            m.add_command(label=f"從此時間開始：{t}", command=lambda: self.from_var.set(t))
            m.add_command(label=f"到此時間結束：{t}", command=lambda: self.to_var.set(t))
        for key, label, _w in self.COMBOS:
            v = self.cell(rec, key)
            if v:
                m.add_command(label=f"只看 {label} = {v}",
                              command=lambda k=key, v=v: (self.combo_vars[k].set(v), self.refresh_view(scroll="top")))
        m.add_separator()
        m.add_command(label="只顯示選取的列", command=self.show_only_selected)
        m.add_command(label="顯示全部", command=self.show_all, state="normal" if self.only_ids is not None else "disabled")
        m.add_command(label="選擇欄位…", command=self.choose_columns)
        m.tk_popup(e.x_root, e.y_root)

    def context_extra(self, menu, rec):
        pass

    def _filter_sn(self, sn):
        self.sn_var.set(sn)
        self.status.set(f"已用 SN 篩選：{sn}　（按「清除篩選」還原）")

    def _filter_date(self, d):
        self.sel_dates = {d}
        self._update_date_btn()
        self.refresh_view(scroll="top")

    def open_folder(self, path):
        from tkinter import messagebox
        if not path or not os.path.exists(path):
            messagebox.showwarning(self.TAB_TITLE, f"找不到：\n{path}")
            return
        open_path(path)

    def open_detail(self):
        recs = self.selected_recs()
        if recs:
            self.show_detail(recs[0])

    # ================================================================ 欄位選擇
    def choose_columns(self):
        tk, ttk = self.tk, self.ttk
        from tkinter import messagebox
        cols = self._all_cols()
        if not cols:
            return
        hidden = set(self.cfg.get(self.hidden_key(), self.DEFAULT_HIDDEN))
        w = tk.Toplevel(self.root)
        w.title(f"選擇要顯示的欄位（{self.TAB_TITLE}）")
        w.transient(self.root)
        body = ttk.Frame(w, padding=10)
        body.pack(fill="both", expand=True)
        vars_ = {}
        for i, (key, title, _a) in enumerate(cols):
            v = tk.BooleanVar(value=key not in hidden)
            vars_[key] = v
            ttk.Checkbutton(body, text=title, variable=v).grid(row=i % 12, column=i // 12, sticky="w", padx=8)
        bar = ttk.Frame(w, padding=8)
        bar.pack(fill="x")

        def set_all(val):
            for v in vars_.values():
                v.set(val)

        def apply():
            hid = [k for k, v in vars_.items() if not v.get()]
            if len(hid) == len(cols):
                messagebox.showwarning(self.TAB_TITLE, "至少要勾選一個欄位", parent=w)
                return
            self.remember_widths()
            self.cfg[self.hidden_key()] = hid
            self.save()
            self.reset_columns()
            self.refresh_view()
            w.destroy()
        ttk.Button(bar, text="全選", command=lambda: set_all(True)).pack(side="left")
        ttk.Button(bar, text="全不選", command=lambda: set_all(False)).pack(side="left", padx=4)
        ttk.Button(bar, text="確定", command=apply).pack(side="right")
        ttk.Button(bar, text="取消", command=w.destroy).pack(side="right", padx=4)

    def export_path(self, prefix, ext=".xlsx", initialdir=None):
        from tkinter import filedialog
        return filedialog.asksaveasfilename(
            title="匯出", defaultextension=ext, initialfile=f"{prefix}{datetime.now():%Y%m%d_%H%M%S}{ext}",
            initialdir=initialdir, filetypes=[("Excel", "*.xlsx"), ("CSV", "*.csv")])
