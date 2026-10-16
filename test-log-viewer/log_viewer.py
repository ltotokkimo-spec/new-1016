#!/usr/bin/env python3
"""
測試結果即時檢視器 (operator_log.csv viewer)

- 自動載入目標 CSV，定時偵測檔案變動並重新讀取（測試程式持續往下追加資料）
- 依時間排序，整理成：timestamp / date / time / opid / sn / verdict /
  hold_channels / fail_channels / CH0..CHn (contrast) / station / station_name
- verdict 上色 (PASS 綠 / FAIL 紅 / HOLD 黃)，FAIL 通道淺紅、HOLD 通道淺黃
- 篩選：日期、站別、結果、SN/OPID 關鍵字；統計：總數 / PASS / FAIL / HOLD / 良率
- 雙擊列可看完整資料（各通道 tof / contrast / cnr / noise / pkpk / baseline、notes）
  並可直接開啟結果資料夾
- 可匯出 Excel（需 openpyxl，否則匯出 CSV）

只使用 Python 標準函式庫 (tkinter)。用法：
    python log_viewer.py [CSV 路徑]
"""

import csv
import io
import json
import os
import subprocess
import sys
import time
from datetime import datetime

import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

APP_TITLE = "測試結果檢視器"
DEFAULT_CSV_NAME = "operator_log.csv"
DEFAULT_CHANNELS = 6
ROW_HEIGHT = 24
HEADER_HEIGHT = 28

# 顏色設定（Excel 條件式格式的配色）
COLORS = {
    "grid": "#000000",
    "header_bg": "#000000",
    "header_fg": "#FFFFFF",
    "cell_bg": "#FFFFFF",
    "cell_fg": "#000000",
    "select_bg": "#CCE4FF",
    "PASS": ("#66FF33", "#000000"),
    "FAIL": ("#FF0000", "#FFFFFF"),
    "HOLD": ("#FFC000", "#000000"),
    "ch_fail": ("#FFC7CE", "#C00000"),
    "ch_hold": ("#FFEB9C", "#9C5700"),
}

CHANNEL_METRICS = [
    ("ch_tof_ns", "tof_ns"),
    ("ch_contrast", "contrast"),
    ("ch_cnr", "cnr"),
    ("ch_noise", "noise"),
    ("ch_pkpk", "pkpk"),
    ("ch_baseline", "baseline"),
]


def app_dir():
    if getattr(sys, "frozen", False):  # PyInstaller
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


CONFIG_PATH = os.path.join(app_dir(), "log_viewer_settings.json")


# --------------------------------------------------------------------------
# 資料讀取
# --------------------------------------------------------------------------
def decode_bytes(raw):
    for enc in ("utf-8-sig", "cp950"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")


def parse_dt(date_s, time_s, ts_s):
    candidates = []
    if date_s and time_s:
        candidates.append(f"{date_s.strip()} {time_s.strip()}")
    if ts_s:
        candidates.append(ts_s.strip())
    for s in candidates:
        s = s.replace("-", "/")
        for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                pass
    return None


def split_channels(s):
    out = set()
    for tok in (s or "").replace(",", ";").split(";"):
        tok = tok.strip().upper()
        if tok.startswith("CH") and tok[2:].isdigit():
            out.add(int(tok[2:]))
    return out


def split_values(s):
    return [v.strip() for v in (s or "").split(";")] if s else []


def load_records(path):
    """讀取 CSV，回傳 (records, channel_count)。records 已依時間排序（舊→新）。"""
    with open(path, "rb") as f:
        raw = f.read()
    text = decode_bytes(raw)
    reader = csv.reader(io.StringIO(text, newline=""))
    try:
        header = [h.strip() for h in next(reader)]
    except StopIteration:
        return [], DEFAULT_CHANNELS

    records = []
    n_ch = 0
    for line_no, row in enumerate(reader, start=2):
        if not any(c.strip() for c in row):
            continue
        # 欄位數不足 = 測試程式正在寫入的半行，下次再讀
        if len(row) < len(header):
            continue
        d = {h: (row[i].strip() if i < len(row) else "") for i, h in enumerate(header)}
        if not d.get("sn") and not d.get("verdict"):
            continue
        dt = parse_dt(d.get("date"), d.get("time"), d.get("timestamp"))
        contrast = split_values(d.get("ch_contrast"))
        n_ch = max(n_ch, len(contrast))
        rec = {
            "_line": line_no,
            "_dt": dt,
            "_raw": d,
            "_hold": split_channels(d.get("hold_channels")),
            "_fail": split_channels(d.get("fail_channels")),
            "_contrast": contrast,
            "timestamp": dt.strftime("%Y/%m/%d %H:%M") if dt else d.get("timestamp", ""),
            "date": dt.strftime("%Y/%m/%d") if dt else d.get("date", ""),
            "time": dt.strftime("%H:%M:%S") if dt else d.get("time", ""),
            "opid": d.get("opid", ""),
            "sn": d.get("sn", ""),
            "verdict": d.get("verdict", "").upper(),
            "hold_channels": d.get("hold_channels", ""),
            "fail_channels": d.get("fail_channels", ""),
            "station": d.get("station", ""),
            "station_name": d.get("station_name", ""),
        }
        records.append(rec)

    # 依時間排序；無法解析時間的排最後，同時間維持檔案順序
    records.sort(key=lambda r: (r["_dt"] is None, r["_dt"] or datetime.min, r["_line"]))
    return records, (n_ch or DEFAULT_CHANNELS)


def cell_text(rec, key):
    if key.startswith("CH"):
        i = int(key[2:])
        return rec["_contrast"][i] if i < len(rec["_contrast"]) else ""
    return rec.get(key, "")


def cell_style(rec, key):
    """回傳 (bg, fg, bold)"""
    if key == "verdict":
        bg, fg = COLORS.get(rec["verdict"], (COLORS["cell_bg"], COLORS["cell_fg"]))
        return bg, fg, False
    if key.startswith("CH"):
        i = int(key[2:])
        if i in rec["_fail"]:
            return COLORS["ch_fail"] + (True,)
        if i in rec["_hold"]:
            return COLORS["ch_hold"] + (True,)
        return COLORS["cell_bg"], COLORS["cell_fg"], True
    return COLORS["cell_bg"], COLORS["cell_fg"], False


def build_columns(n_ch):
    """(key, 標題, 對齊)"""
    cols = [
        ("timestamp", "timestamp", "e"),
        ("date", "date", "e"),
        ("time", "time", "e"),
        ("opid", "opid", "e"),
        ("sn", "sn", "w"),
        ("verdict", "verdict", "w"),
        ("hold_channels", "hold_channels", "w"),
        ("fail_channels", "fail_channels", "w"),
    ]
    cols += [(f"CH{i}", f"CH{i}", "e") for i in range(n_ch)]
    cols += [("station", "station", "w"), ("station_name", "station_name", "w")]
    return cols


# --------------------------------------------------------------------------
# 表格元件（Canvas 虛擬繪製，只畫可見列，資料量大也順暢）
# --------------------------------------------------------------------------
class GridTable(ttk.Frame):
    def __init__(self, master, on_double_click=None):
        super().__init__(master)
        self.on_double_click = on_double_click
        self.columns = []
        self.widths = []
        self.rows = []
        self.selected_line = None
        self._redraw_pending = False

        base = tkfont.nametofont("TkDefaultFont")
        family = base.actual("family")
        size = max(10, abs(base.actual("size")))
        self.font = tkfont.Font(family=family, size=size)
        self.font_bold = tkfont.Font(family=family, size=size, weight="bold")
        self.font_big = tkfont.Font(family=family, size=size + 2, weight="bold")
        self.font_head = tkfont.Font(family=family, size=size, weight="bold")
        self.row_h = max(ROW_HEIGHT, self.font_big.metrics("linespace") + 6)

        self.header = tk.Canvas(self, height=HEADER_HEIGHT, bg=COLORS["header_bg"],
                                highlightthickness=0)
        self.body = tk.Canvas(self, bg=COLORS["cell_bg"], highlightthickness=0,
                              takefocus=1)
        self.vsb = ttk.Scrollbar(self, orient="vertical", command=self._yview)
        self.hsb = ttk.Scrollbar(self, orient="horizontal", command=self._xview)
        self.body.configure(yscrollcommand=self._on_yscroll,
                            xscrollcommand=self._on_xscroll)

        self.header.grid(row=0, column=0, sticky="ew")
        self.body.grid(row=1, column=0, sticky="nsew")
        self.vsb.grid(row=1, column=1, sticky="ns")
        self.hsb.grid(row=2, column=0, sticky="ew")
        self.rowconfigure(1, weight=1)
        self.columnconfigure(0, weight=1)

        self.body.bind("<Configure>", lambda e: self.schedule_redraw())
        self.body.bind("<Button-1>", self._on_click)
        self.body.bind("<Double-Button-1>", self._on_dclick)
        self.body.bind("<Up>", lambda e: self._move_sel(-1))
        self.body.bind("<Down>", lambda e: self._move_sel(1))
        self.body.bind("<Return>", lambda e: self._open_selected())
        self.body.bind("<Control-c>", self._copy_selected)
        for w in (self.body, self.header):
            w.bind("<MouseWheel>", self._on_wheel)
            w.bind("<Shift-MouseWheel>", self._on_shift_wheel)
            w.bind("<Button-4>", lambda e: self._scroll_units(-3))
            w.bind("<Button-5>", lambda e: self._scroll_units(3))

    # ---- 資料 ----
    def set_data(self, columns, rows, scroll=None):
        """scroll: None=保持位置, 'top', 'bottom'"""
        self.columns = columns
        self.rows = rows
        self._autosize()
        total_w = sum(self.widths) + 1
        total_h = len(rows) * self.row_h + 1
        self.body.configure(scrollregion=(0, 0, total_w, total_h))
        self.header.configure(scrollregion=(0, 0, total_w, HEADER_HEIGHT))
        if scroll == "top":
            self.body.yview_moveto(0)
        elif scroll == "bottom":
            self.body.yview_moveto(1)
        self._draw_header()
        self.schedule_redraw()

    def _autosize(self):
        sample = self.rows[-3000:]
        widths = []
        for key, title, _ in self.columns:
            w = self.font_head.measure(title)
            f = self.font_big if key == "CH0" else (
                self.font_bold if key.startswith("CH") else self.font)
            seen = set()
            for r in sample:
                t = cell_text(r, key)
                if t in seen:
                    continue
                seen.add(t)
                w = max(w, f.measure(t))
            widths.append(min(w + 16, 600))
        self.widths = widths

    # ---- 繪製 ----
    def _draw_header(self):
        c = self.header
        c.delete("all")
        x = 0
        for (key, title, _), w in zip(self.columns, self.widths):
            c.create_rectangle(x, 0, x + w, HEADER_HEIGHT, fill=COLORS["header_bg"],
                               outline="#444444")
            c.create_text(x + w / 2, HEADER_HEIGHT / 2, text=title,
                          fill=COLORS["header_fg"], font=self.font_head)
            x += w

    def schedule_redraw(self):
        if not self._redraw_pending:
            self._redraw_pending = True
            self.after_idle(self._redraw)

    def _redraw(self):
        self._redraw_pending = False
        c = self.body
        c.delete("all")
        if not self.rows:
            c.create_text(20, 20, anchor="nw", text="（沒有資料）", font=self.font,
                          fill="#888888")
            return
        h = c.winfo_height()
        y0 = c.canvasy(0)
        first = max(0, int(y0 // self.row_h))
        last = min(len(self.rows), int((y0 + h) // self.row_h) + 2)
        rh = self.row_h
        for idx in range(first, last):
            rec = self.rows[idx]
            y = idx * rh
            selected = rec["_line"] == self.selected_line
            x = 0
            for (key, _, anchor), w in zip(self.columns, self.widths):
                bg, fg, bold = cell_style(rec, key)
                if selected and bg == COLORS["cell_bg"]:
                    bg = COLORS["select_bg"]
                c.create_rectangle(x, y, x + w, y + rh, fill=bg, outline=COLORS["grid"])
                font = self.font_big if key == "CH0" else (
                    self.font_bold if bold else self.font)
                tx = x + w - 6 if anchor == "e" else x + 6
                c.create_text(tx, y + rh / 2, text=cell_text(rec, key), anchor=anchor,
                              fill=fg, font=font)
                x += w
            if selected:
                c.create_rectangle(1, y + 1, x - 1, y + rh - 1, outline="#0066CC", width=2)

    # ---- 捲動 ----
    def _on_yscroll(self, a, b):
        self.vsb.set(a, b)
        self.schedule_redraw()

    def _on_xscroll(self, a, b):
        self.hsb.set(a, b)
        self.header.xview_moveto(a)

    def _yview(self, *args):
        self.body.yview(*args)

    def _xview(self, *args):
        self.body.xview(*args)
        self.header.xview(*args)

    def _scroll_units(self, n):
        self.body.yview_scroll(n, "units")

    def _on_wheel(self, e):
        if sys.platform == "darwin":
            self.body.yview_scroll(-e.delta, "units")
        else:
            self.body.yview_scroll(int(-e.delta / 120) * 3, "units")

    def _on_shift_wheel(self, e):
        step = -e.delta if sys.platform == "darwin" else int(-e.delta / 120) * 3
        self._xview("scroll", step, "units")

    def _ensure_visible(self, idx):
        total = len(self.rows) * self.row_h
        if total <= 0:
            return
        h = self.body.winfo_height()
        top = self.body.canvasy(0)
        y = idx * self.row_h
        if y < top:
            self.body.yview_moveto(y / total)
        elif y + self.row_h > top + h:
            self.body.yview_moveto(max(0, y + self.row_h - h) / total)

    # ---- 選取 ----
    def _row_at(self, event):
        idx = int(self.body.canvasy(event.y) // self.row_h)
        return idx if 0 <= idx < len(self.rows) else None

    def _on_click(self, e):
        self.body.focus_set()
        idx = self._row_at(e)
        self.selected_line = self.rows[idx]["_line"] if idx is not None else None
        self.schedule_redraw()

    def _on_dclick(self, e):
        idx = self._row_at(e)
        if idx is not None and self.on_double_click:
            self.on_double_click(self.rows[idx])

    def _selected_index(self):
        for i, r in enumerate(self.rows):
            if r["_line"] == self.selected_line:
                return i
        return None

    def _move_sel(self, d):
        if not self.rows:
            return
        i = self._selected_index()
        i = 0 if i is None else min(max(i + d, 0), len(self.rows) - 1)
        self.selected_line = self.rows[i]["_line"]
        self._ensure_visible(i)
        self.schedule_redraw()

    def _open_selected(self):
        i = self._selected_index()
        if i is not None and self.on_double_click:
            self.on_double_click(self.rows[i])

    def _copy_selected(self, e=None):
        i = self._selected_index()
        if i is None:
            return
        rec = self.rows[i]
        text = "\t".join(cell_text(rec, k) for k, _, _ in self.columns)
        self.clipboard_clear()
        self.clipboard_append(text)


# --------------------------------------------------------------------------
# 主視窗
# --------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self, csv_path=None):
        super().__init__()
        self.title(APP_TITLE)
        self.settings = self._load_settings()
        self.geometry(self.settings.get("geometry", "1500x700"))
        self.minsize(900, 400)

        self.csv_path = csv_path or self.settings.get("csv_path") or ""
        if not self.csv_path:
            guess = os.path.join(app_dir(), DEFAULT_CSV_NAME)
            if os.path.exists(guess):
                self.csv_path = guess
        self.records = []
        self.n_ch = DEFAULT_CHANNELS
        self.file_sig = None
        self.prev_count = 0
        self._tick_job = None

        self.var_path = tk.StringVar(value=self.csv_path)
        self.var_interval = tk.IntVar(value=int(self.settings.get("interval", 2)))
        self.var_auto = tk.BooleanVar(value=self.settings.get("auto_refresh", True))
        self.var_newest_first = tk.BooleanVar(value=self.settings.get("newest_first", False))
        self.var_follow = tk.BooleanVar(value=self.settings.get("follow", True))
        self.var_date = tk.StringVar(value="全部")
        self.var_station = tk.StringVar(value="全部")
        self.var_verdict = tk.StringVar(value="全部")
        self.var_search = tk.StringVar()
        self.var_status = tk.StringVar(value="")

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        if self.csv_path:
            self.reload(force=True, scroll="end")
        else:
            self.after(200, self.choose_file)
        self._schedule_tick()

    # ---- UI ----
    def _build_ui(self):
        pad = {"padx": 4, "pady": 3}

        bar1 = ttk.Frame(self)
        bar1.pack(fill="x", padx=6, pady=(6, 0))
        ttk.Label(bar1, text="CSV 檔案：").pack(side="left")
        ent = ttk.Entry(bar1, textvariable=self.var_path, state="readonly")
        ent.pack(side="left", fill="x", expand=True, **pad)
        ttk.Button(bar1, text="選擇檔案…", command=self.choose_file).pack(side="left", **pad)
        ttk.Button(bar1, text="重新載入", command=lambda: self.reload(force=True)).pack(
            side="left", **pad)
        ttk.Button(bar1, text="匯出 Excel…", command=self.export).pack(side="left", **pad)

        bar2 = ttk.Frame(self)
        bar2.pack(fill="x", padx=6)
        ttk.Checkbutton(bar2, text="自動更新", variable=self.var_auto,
                        command=self._schedule_tick).pack(side="left", **pad)
        ttk.Label(bar2, text="每").pack(side="left")
        sp = ttk.Spinbox(bar2, from_=1, to=60, width=4, textvariable=self.var_interval,
                         command=self._schedule_tick)
        sp.pack(side="left")
        ttk.Label(bar2, text="秒").pack(side="left", padx=(2, 10))
        ttk.Checkbutton(bar2, text="最新在上", variable=self.var_newest_first,
                        command=lambda: self.refresh_view(scroll="end")).pack(side="left", **pad)
        ttk.Checkbutton(bar2, text="有新資料時自動捲到最新", variable=self.var_follow).pack(
            side="left", **pad)

        ttk.Separator(bar2, orient="vertical").pack(side="left", fill="y", padx=8)
        ttk.Label(bar2, text="日期").pack(side="left")
        self.cb_date = ttk.Combobox(bar2, textvariable=self.var_date, width=11,
                                    state="readonly", values=["全部"])
        self.cb_date.pack(side="left", **pad)
        ttk.Label(bar2, text="站別").pack(side="left")
        self.cb_station = ttk.Combobox(bar2, textvariable=self.var_station, width=8,
                                       state="readonly", values=["全部"])
        self.cb_station.pack(side="left", **pad)
        ttk.Label(bar2, text="結果").pack(side="left")
        self.cb_verdict = ttk.Combobox(bar2, textvariable=self.var_verdict, width=6,
                                       state="readonly", values=["全部", "PASS", "FAIL", "HOLD"])
        self.cb_verdict.pack(side="left", **pad)
        ttk.Label(bar2, text="SN/OPID").pack(side="left")
        ttk.Entry(bar2, textvariable=self.var_search, width=22).pack(side="left", **pad)
        for cb in (self.cb_date, self.cb_station, self.cb_verdict):
            cb.bind("<<ComboboxSelected>>", lambda e: self.refresh_view(scroll="end"))
        self.var_search.trace_add("write", lambda *a: self.refresh_view(scroll="end"))

        # 統計
        stat = tk.Frame(self)
        stat.pack(fill="x", padx=10, pady=(4, 2))
        big = tkfont.Font(size=12, weight="bold")
        self.lbl_total = tk.Label(stat, font=big)
        self.lbl_pass = tk.Label(stat, font=big, fg="#008000")
        self.lbl_fail = tk.Label(stat, font=big, fg="#C00000")
        self.lbl_hold = tk.Label(stat, font=big, fg="#B07000")
        self.lbl_yield = tk.Label(stat, font=big, fg="#0050A0")
        for w in (self.lbl_total, self.lbl_pass, self.lbl_fail, self.lbl_hold, self.lbl_yield):
            w.pack(side="left", padx=(0, 22))
        self.lbl_update = tk.Label(stat, fg="#555555")
        self.lbl_update.pack(side="right")

        self.table = GridTable(self, on_double_click=self.show_detail)
        self.table.pack(fill="both", expand=True, padx=6, pady=2)

        sb = ttk.Label(self, textvariable=self.var_status, anchor="w", relief="sunken")
        sb.pack(fill="x", side="bottom")
        self.var_status.set("雙擊任一列可查看完整資料；↑↓ 選取，Ctrl+C 複製該列")

    # ---- 檔案 ----
    def choose_file(self):
        init_dir = os.path.dirname(self.csv_path) if self.csv_path else app_dir()
        p = filedialog.askopenfilename(
            title="選擇測試結果 CSV", initialdir=init_dir,
            filetypes=[("CSV 檔", "*.csv"), ("所有檔案", "*.*")])
        if p:
            self.csv_path = os.path.normpath(p)
            self.var_path.set(self.csv_path)
            self.file_sig = None
            self.records = []
            self.var_date.set("全部")
            self.var_station.set("全部")
            self.reload(force=True, scroll="end")
            self._save_settings()

    def _file_signature(self):
        st = os.stat(self.csv_path)
        return (st.st_mtime_ns, st.st_size)

    def reload(self, force=False, scroll=None):
        if not self.csv_path:
            return
        try:
            sig = self._file_signature()
        except OSError:
            self.lbl_update.config(text="⚠ 找不到檔案：" + self.csv_path, fg="#C00000")
            return
        if not force and sig == self.file_sig:
            return
        try:
            records, n_ch = load_records(self.csv_path)
        except (OSError, csv.Error) as e:
            # 測試程式正在寫入而被鎖住時，下一輪再試
            self.lbl_update.config(text=f"⚠ 讀取失敗（稍後重試）：{e}", fg="#C00000")
            return
        self.file_sig = sig
        added = len(records) - len(self.records) if self.records else 0
        self.records = records
        self.n_ch = n_ch
        self._update_filter_choices()
        if scroll is None and added > 0 and self.var_follow.get():
            scroll = "end"
        self.refresh_view(scroll=scroll)
        msg = f"最後讀取 {datetime.now():%H:%M:%S}　共 {len(records)} 筆"
        if added > 0:
            msg += f"　（新增 {added} 筆）"
            self.bell()
        self.lbl_update.config(text=msg, fg="#555555")

    def _update_filter_choices(self):
        dates = sorted({r["date"] for r in self.records if r["date"]}, reverse=True)
        stations = sorted({r["station"] for r in self.records if r["station"]})
        self.cb_date["values"] = ["全部"] + dates
        self.cb_station["values"] = ["全部"] + stations

    # ---- 篩選/顯示 ----
    def filtered(self):
        d, s, v = self.var_date.get(), self.var_station.get(), self.var_verdict.get()
        q = self.var_search.get().strip().upper()
        out = []
        for r in self.records:
            if d != "全部" and r["date"] != d:
                continue
            if s != "全部" and r["station"] != s:
                continue
            if v != "全部" and r["verdict"] != v:
                continue
            if q and q not in r["sn"].upper() and q not in r["opid"].upper():
                continue
            out.append(r)
        if self.var_newest_first.get():
            out.reverse()
        return out

    def refresh_view(self, scroll=None):
        rows = self.filtered()
        if scroll == "end":
            scroll = "top" if self.var_newest_first.get() else "bottom"
        self.table.set_data(build_columns(self.n_ch), rows, scroll=scroll)
        self._update_stats(rows)
        self._save_settings()

    def _update_stats(self, rows):
        n = len(rows)
        cnt = {"PASS": 0, "FAIL": 0, "HOLD": 0}
        for r in rows:
            if r["verdict"] in cnt:
                cnt[r["verdict"]] += 1
        self.lbl_total.config(text=f"總數 {n}")
        self.lbl_pass.config(text=f"PASS {cnt['PASS']}")
        self.lbl_fail.config(text=f"FAIL {cnt['FAIL']}")
        self.lbl_hold.config(text=f"HOLD {cnt['HOLD']}")
        self.lbl_yield.config(text=f"良率 {cnt['PASS'] / n * 100:.1f}%" if n else "良率 -")

    # ---- 定時更新 ----
    def _schedule_tick(self):
        if self._tick_job:
            self.after_cancel(self._tick_job)
        try:
            sec = max(1, int(self.var_interval.get()))
        except (tk.TclError, ValueError):
            sec = 2
        self._tick_job = self.after(sec * 1000, self._tick)

    def _tick(self):
        self._tick_job = None
        if self.var_auto.get():
            self.reload()
        self._schedule_tick()

    # ---- 詳細資料 ----
    def show_detail(self, rec):
        d = rec["_raw"]
        win = tk.Toplevel(self)
        win.title(f"{rec['sn']}  {rec['verdict']}  {rec['timestamp']}")
        win.geometry("760x560")

        top = ttk.Frame(win)
        top.pack(fill="x", padx=8, pady=6)
        bg, fg = COLORS.get(rec["verdict"], ("#DDDDDD", "#000000"))
        tk.Label(top, text=f" {rec['verdict'] or '-'} ", bg=bg, fg=fg,
                 font=tkfont.Font(size=16, weight="bold")).pack(side="left")
        tk.Label(top, text=f"  {rec['sn']}   OPID {rec['opid']}   {rec['timestamp']}   "
                           f"{rec['station']} {rec['station_name']}",
                 font=tkfont.Font(size=11)).pack(side="left")

        # 各通道量測值
        metrics = [(lbl, split_values(d.get(k))) for k, lbl in CHANNEL_METRICS if k in d]
        tv = ttk.Treeview(win, columns=["ch"] + [m[0] for m in metrics] + ["status"],
                          show="headings", height=self.n_ch)
        tv.heading("ch", text="通道")
        tv.column("ch", width=60, anchor="center")
        for lbl, _ in metrics:
            tv.heading(lbl, text=lbl)
            tv.column(lbl, width=85, anchor="e")
        tv.heading("status", text="狀態")
        tv.column("status", width=70, anchor="center")
        tv.tag_configure("fail", background=COLORS["ch_fail"][0], foreground=COLORS["ch_fail"][1])
        tv.tag_configure("hold", background=COLORS["ch_hold"][0], foreground=COLORS["ch_hold"][1])
        for i in range(self.n_ch):
            st = "FAIL" if i in rec["_fail"] else ("HOLD" if i in rec["_hold"] else "")
            vals = [f"CH{i}"] + [(v[i] if i < len(v) else "") for _, v in metrics] + [st]
            tv.insert("", "end", values=vals, tags=(st.lower(),) if st else ())
        tv.pack(fill="x", padx=8)

        txt = tk.Text(win, wrap="word", height=12)
        txt.pack(fill="both", expand=True, padx=8, pady=6)
        for k, v in d.items():
            txt.insert("end", f"{k}: ", ("k",))
            txt.insert("end", f"{v}\n")
        txt.tag_configure("k", font=tkfont.Font(weight="bold"))
        txt.configure(state="disabled")

        btns = ttk.Frame(win)
        btns.pack(fill="x", padx=8, pady=(0, 8))
        out_dir = d.get("out_dir", "")
        b = ttk.Button(btns, text="開啟結果資料夾", command=lambda: self._open_dir(out_dir))
        b.pack(side="left")
        if not out_dir:
            b.state(["disabled"])
        ttk.Button(btns, text="關閉", command=win.destroy).pack(side="right")

    def _open_dir(self, path):
        if not path or not os.path.isdir(path):
            messagebox.showwarning(APP_TITLE, f"找不到資料夾：\n{path}", parent=self)
            return
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])

    # ---- 匯出 ----
    def export(self):
        rows = self.filtered()
        if not rows:
            messagebox.showinfo(APP_TITLE, "目前沒有可匯出的資料", parent=self)
            return
        cols = build_columns(self.n_ch)
        try:
            import openpyxl  # noqa
            has_xl = True
        except ImportError:
            has_xl = False
        ext = ".xlsx" if has_xl else ".csv"
        p = filedialog.asksaveasfilename(
            title="匯出", defaultextension=ext,
            initialfile=f"test_result_{datetime.now():%Y%m%d_%H%M%S}{ext}",
            filetypes=[("Excel", "*.xlsx")] if has_xl else [("CSV", "*.csv")])
        if not p:
            return
        try:
            if has_xl and p.lower().endswith(".xlsx"):
                export_xlsx(p, cols, rows)
            else:
                export_csv(p, cols, rows)
        except OSError as e:
            messagebox.showerror(APP_TITLE, f"匯出失敗：{e}", parent=self)
            return
        self.var_status.set(f"已匯出 {len(rows)} 筆 → {p}")

    # ---- 設定 ----
    def _load_settings(self):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return {}

    def _save_settings(self):
        try:
            interval = int(self.var_interval.get())
        except (tk.TclError, ValueError):
            interval = 2
        data = {
            "csv_path": self.csv_path,
            "interval": interval,
            "auto_refresh": self.var_auto.get(),
            "newest_first": self.var_newest_first.get(),
            "follow": self.var_follow.get(),
            "geometry": self.geometry(),
        }
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def _on_close(self):
        self._save_settings()
        self.destroy()


def export_csv(path, cols, rows):
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow([t for _, t, _ in cols])
        for r in rows:
            w.writerow([cell_text(r, k) for k, _, _ in cols])


def export_xlsx(path, cols, rows):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    def fill(c):
        return PatternFill("solid", start_color=c.lstrip("#"), end_color=c.lstrip("#"))

    thin = Side(style="thin", color="000000")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    wb = Workbook()
    ws = wb.active
    ws.title = "result"
    for ci, (_, title, _) in enumerate(cols, 1):
        c = ws.cell(row=1, column=ci, value=title)
        c.fill = fill(COLORS["header_bg"])
        c.font = Font(bold=True, color=COLORS["header_fg"].lstrip("#"))
        c.alignment = Alignment(horizontal="center")
        c.border = border
    for ri, r in enumerate(rows, 2):
        for ci, (key, _, anchor) in enumerate(cols, 1):
            v = cell_text(r, key)
            if key.startswith("CH") or key == "opid":
                try:
                    v = int(v)
                except ValueError:
                    pass
            c = ws.cell(row=ri, column=ci, value=v)
            bg, fg, bold = cell_style(r, key)
            if bg != COLORS["cell_bg"]:
                c.fill = fill(bg)
            c.font = Font(bold=bold, color=fg.lstrip("#"), size=12 if key == "CH0" else 11)
            c.alignment = Alignment(horizontal="right" if anchor == "e" else "left")
            c.border = border
    for ci, (key, title, _) in enumerate(cols, 1):
        w = max([len(title)] + [len(str(cell_text(r, key))) for r in rows[-2000:]])
        ws.column_dimensions[get_column_letter(ci)].width = min(w + 3, 60)
    ws.freeze_panes = "A2"
    wb.save(path)


def main():
    if sys.platform.startswith("win"):
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    path = sys.argv[1] if len(sys.argv) > 1 else None
    if path:
        path = os.path.abspath(path)
    App(path).mainloop()


if __name__ == "__main__":
    main()
