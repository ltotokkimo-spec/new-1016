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
import re
import subprocess
import sys
import time
from datetime import datetime, time as dtime

import tkinter as tk
import tkinter.font as tkfont
from tkinter import filedialog, messagebox, ttk

APP_VERSION = "1.7.0"
APP_TITLE = f"測試結果檢視器 v{APP_VERSION}"
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


ANY = "不限"


def parse_tod(s, upper=False):
    """'8' / '08:30' / '08:30:15' → time；空白回傳 None；格式錯誤丟 ValueError。
    upper=True 用於結束時間：省略的分/秒補 59（16:30 → 16:30:59，含整分鐘）"""
    s = (s or "").strip().replace("：", ":")
    if not s:
        return None
    parts = [int(p) for p in s.split(":")]
    if not 1 <= len(parts) <= 3:
        raise ValueError(s)
    parts += [59 if upper else 0] * (3 - len(parts))
    return dtime(*parts)


def build_columns(n_ch, hidden=()):
    """(key, 標題, 對齊)；hidden 內的欄位不顯示"""
    return [c for c in all_columns(n_ch) if c[0] not in hidden]


def all_columns(n_ch):
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
    def __init__(self, master, on_double_click=None, on_select=None, on_context=None,
                 on_copy=None):
        super().__init__(master)
        self.on_double_click = on_double_click   # 開啟詳細資料（Enter / 右鍵選單）
        self.on_copy = on_copy
        self.editor = None         # 雙擊儲存格時出現的可選取文字框
        self.ctx_cell = None       # 右鍵點到的 (rec, key)
        self.on_select = on_select
        self.on_context = on_context
        self.columns = []
        self.widths = []
        self.rows = []
        self.selected = set()      # 選取列的 _line
        self._anchor = None        # Shift 範圍選取的起點 (列 index)
        self._drag = None          # 拉框中: dict(x0, y0, x1, y1, base)
        self._redraw_pending = False

        base = tkfont.nametofont("TkDefaultFont")
        family = base.actual("family")
        size = max(10, abs(base.actual("size")))
        self.font = tkfont.Font(family=family, size=size)
        self.font_bold = tkfont.Font(family=family, size=size, weight="bold")
        self.font_big = tkfont.Font(family=family, size=size + 2, weight="bold")
        self.font_head = tkfont.Font(family=family, size=size, weight="bold")
        self.row_h = max(ROW_HEIGHT, self.font_big.metrics("linespace") + 6)

        # 標題列背景用白色：沒有欄位的地方不要出現黑色長條
        self.header = tk.Canvas(self, height=HEADER_HEIGHT, bg=COLORS["cell_bg"],
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

        self.body.bind("<Configure>", self._on_body_configure)
        self.body.bind("<Button-1>", self._on_press)
        self.body.bind("<B1-Motion>", self._on_motion)
        self.body.bind("<ButtonRelease-1>", self._on_release)
        self.body.bind("<Double-Button-1>", self._on_dclick)
        self.body.bind("<Button-3>", self._on_right_click)
        self.body.bind("<Up>", lambda e: self._move_sel(-1))
        self.body.bind("<Down>", lambda e: self._move_sel(1))
        self.body.bind("<Return>", lambda e: self._open_selected())
        self.body.bind("<Control-c>", self._copy_selected)
        self.body.bind("<Control-a>", self._select_all)
        self.body.bind("<Escape>", lambda e: self.clear_selection())
        for w in (self.body, self.header):
            w.bind("<MouseWheel>", self._on_wheel)
            w.bind("<Shift-MouseWheel>", self._on_shift_wheel)
            w.bind("<Button-4>", lambda e: self._scroll_units(-3))
            w.bind("<Button-5>", lambda e: self._scroll_units(3))

    # ---- 資料 ----
    def set_data(self, columns, rows, scroll=None):
        """scroll: None=保持位置, 'top', 'bottom'"""
        self.close_editor()
        self.columns = columns
        self.rows = rows
        self._autosize()
        self._update_scrollregion()
        if scroll == "top":
            self.body.yview_moveto(0)
        elif scroll == "bottom":
            self.body.yview_moveto(1)
        self._draw_header()
        self.schedule_redraw()

    def _update_scrollregion(self):
        # 捲動範圍至少等於可視區大小：資料少時不能捲，上方/左方不會跑出空白
        view_w = max(self.body.winfo_width(), 1)
        view_h = max(self.body.winfo_height(), 1)
        total_w = max(sum(self.widths) + 1, view_w)
        total_h = max(len(self.rows) * self.row_h + 1, view_h)
        self.body.configure(scrollregion=(0, 0, total_w, total_h))
        self.header.configure(scrollregion=(0, 0, total_w, HEADER_HEIGHT))
        if len(self.rows) * self.row_h + 1 <= view_h:
            self.body.yview_moveto(0)
        if sum(self.widths) + 1 <= view_w:
            self.body.xview_moveto(0)
            self.header.xview_moveto(0)

    def _on_body_configure(self, e):
        self._update_scrollregion()
        self.schedule_redraw()

    def _content_fits(self):
        return len(self.rows) * self.row_h + 1 <= self.body.winfo_height()

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
        c.delete("grid")
        if not self.rows:
            c.create_text(20, 20, anchor="nw", text="（沒有資料）", font=self.font,
                          fill="#888888", tags="grid")
            return
        h = c.winfo_height()
        y0 = c.canvasy(0)
        first = max(0, int(y0 // self.row_h))
        last = min(len(self.rows), int((y0 + h) // self.row_h) + 2)
        rh = self.row_h
        for idx in range(first, last):
            rec = self.rows[idx]
            y = idx * rh
            selected = rec["_line"] in self.selected
            x = 0
            for (key, _, anchor), w in zip(self.columns, self.widths):
                bg, fg, bold = cell_style(rec, key)
                if selected and bg == COLORS["cell_bg"]:
                    bg = COLORS["select_bg"]
                c.create_rectangle(x, y, x + w, y + rh, fill=bg, outline=COLORS["grid"],
                                   tags="grid")
                font = self.font_big if key == "CH0" else (
                    self.font_bold if bold else self.font)
                tx = x + w - 6 if anchor == "e" else x + 6
                c.create_text(tx, y + rh / 2, text=cell_text(rec, key), anchor=anchor,
                              fill=fg, font=font, tags="grid")
                x += w
            if selected:
                c.create_rectangle(1, y + 1, x - 1, y + rh - 1, outline="#0066CC", width=2,
                                   tags="grid")
        if self._drag and self._drag.get("moved"):
            d = self._drag
            c.create_rectangle(d["x0"], d["y0"], d["x1"], d["y1"], outline="#0066CC",
                               width=2, dash=(5, 3), fill="#3399FF", stipple="gray12",
                               tags="grid")
        c.tag_raise("editor")

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
        if not self._content_fits():
            self.body.yview_scroll(n, "units")

    def _on_wheel(self, e):
        if self._content_fits():
            return
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

    # ---- 選取（點選 / Ctrl 加選 / Shift 範圍 / 滑鼠拉框）----
    def _row_at_y(self, cy):
        return int(cy // self.row_h)

    def _row_at(self, event):
        idx = self._row_at_y(self.body.canvasy(event.y))
        return idx if 0 <= idx < len(self.rows) else None

    def _lines(self, i0, i1):
        lo, hi = sorted((i0, i1))
        lo, hi = max(lo, 0), min(hi, len(self.rows) - 1)
        return {self.rows[i]["_line"] for i in range(lo, hi + 1)}

    def _notify(self):
        if self.on_select:
            self.on_select(len(self.selected))

    def _on_press(self, e):
        self.body.focus_set()
        ctrl = bool(e.state & 0x0004)
        shift = bool(e.state & 0x0001)
        idx = self._row_at(e)
        if idx is None:
            if not ctrl:
                self.selected = set()
        elif shift and self._anchor is not None:
            rng = self._lines(self._anchor, idx)
            self.selected = (self.selected | rng) if ctrl else rng
        elif ctrl:
            self.selected ^= {self.rows[idx]["_line"]}
            self._anchor = idx
        else:
            self.selected = {self.rows[idx]["_line"]}
            self._anchor = idx
        cx, cy = self.body.canvasx(e.x), self.body.canvasy(e.y)
        self._drag = {"x0": cx, "y0": cy, "x1": cx, "y1": cy, "moved": False,
                      "base": set(self.selected) if ctrl else set()}
        self.schedule_redraw()
        self._notify()

    def _on_motion(self, e):
        d = self._drag
        if not d or not self.rows:
            return
        h = self.body.winfo_height()
        if not self._content_fits():
            if e.y < 0:
                self.body.yview_scroll(-1, "units")
            elif e.y > h:
                self.body.yview_scroll(1, "units")
        cx, cy = self.body.canvasx(e.x), self.body.canvasy(e.y)
        if not d["moved"] and abs(cy - d["y0"]) < 4 and abs(cx - d["x0"]) < 4:
            return
        d["moved"] = True
        d["x1"], d["y1"] = cx, cy
        i0 = self._row_at_y(d["y0"])
        i1 = self._row_at_y(max(0, cy))
        self.selected = d["base"] | self._lines(i0, i1)
        self._anchor = i0
        self.schedule_redraw()
        self._notify()

    def _on_release(self, e):
        if self._drag and self._drag["moved"]:
            self._drag = None
            self.schedule_redraw()
        self._drag = None
        self._notify()

    def _col_at(self, event):
        cx = self.body.canvasx(event.x)
        x = 0
        for i, w in enumerate(self.widths):
            if x <= cx < x + w:
                return i, x, w
            x += w
        return None

    def _on_dclick(self, e):
        """雙擊儲存格：變成可選取的文字框，內容全選並複製到剪貼簿"""
        idx = self._row_at(e)
        col = self._col_at(e)
        if idx is None or col is None:
            return
        ci, x, w = col
        key = self.columns[ci][0]
        rec = self.rows[idx]
        text = cell_text(rec, key)
        self.close_editor()
        bg, fg, bold = cell_style(rec, key)
        font = self.font_big if key == "CH0" else (self.font_bold if bold else self.font)
        ent = tk.Entry(self.body, font=font, relief="solid", bd=1,
                       readonlybackground="#FFFFFF", fg="#000000",
                       selectbackground="#0078D7", selectforeground="#FFFFFF",
                       highlightthickness=2, highlightcolor="#0066CC")
        ent.insert(0, text)
        ent.configure(state="readonly")
        y = idx * self.row_h
        self.body.create_window(x, y, window=ent, anchor="nw", width=max(w, 80),
                                height=self.row_h, tags="editor")
        self.editor = ent
        ent.focus_set()
        ent.select_range(0, "end")
        ent.icursor("end")
        ent.bind("<Escape>", lambda ev: self.close_editor())
        ent.bind("<Return>", lambda ev: self.close_editor())
        ent.bind("<FocusOut>", self._editor_focus_out)
        ent.bind("<Button-3>", lambda ev: self._editor_menu(ev, ent, text))
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            ent.bind(seq, lambda ev: (self.close_editor(), self._on_wheel(ev)))
        if text:
            self.clipboard_clear()
            self.clipboard_append(text)
            if self.on_copy:
                self.on_copy(text)
        return "break"

    def _editor_focus_out(self, ev):
        if not getattr(self, "_editor_menu_open", False):
            self.close_editor()

    def _editor_menu(self, ev, ent, text):
        """雙擊後的文字框右鍵：只有「複製」（有反白就複製反白部分）"""
        try:
            part = ent.selection_get() if ent.selection_present() else text
        except tk.TclError:
            part = text

        def copy():
            self.clipboard_clear()
            self.clipboard_append(part)
            if self.on_copy:
                self.on_copy(part)
            self.close_editor()

        m = tk.Menu(self, tearoff=0)
        m.add_command(label="複製", command=copy, state="normal" if part else "disabled")
        self._editor_menu_open = True
        try:
            m.tk_popup(ev.x_root, ev.y_root)
        finally:
            m.grab_release()
            self._editor_menu_open = False
        return "break"

    def close_editor(self):
        if self.editor is not None:
            ed, self.editor = self.editor, None
            self.body.delete("editor")
            ed.destroy()
            self.body.focus_set()

    def _on_right_click(self, e):
        self.close_editor()
        idx = self._row_at(e)
        col = self._col_at(e)
        self.ctx_cell = (self.rows[idx], self.columns[col[0]][0]) if (
            idx is not None and col is not None) else None
        if idx is not None and self.rows[idx]["_line"] not in self.selected:
            self.selected = {self.rows[idx]["_line"]}
            self._anchor = idx
            self.schedule_redraw()
            self._notify()
        if self.on_context:
            self.on_context(e)

    def _select_all(self, e=None):
        self.selected = {r["_line"] for r in self.rows}
        self.schedule_redraw()
        self._notify()
        return "break"

    def clear_selection(self):
        self.selected = set()
        self._anchor = None
        self.schedule_redraw()
        self._notify()

    def selected_rows(self):
        return [r for r in self.rows if r["_line"] in self.selected]

    def _move_sel(self, d):
        if not self.rows:
            return
        i = self._anchor
        i = 0 if i is None else min(max(i + d, 0), len(self.rows) - 1)
        self.selected = {self.rows[i]["_line"]}
        self._anchor = i
        self._ensure_visible(i)
        self.schedule_redraw()
        self._notify()

    def _open_selected(self):
        rows = self.selected_rows()
        if rows and self.on_double_click:
            self.on_double_click(rows[0])

    def _copy_selected(self, e=None):
        rows = self.selected_rows()
        if not rows:
            return
        lines = ["\t".join(t for _, t, _ in self.columns)]
        lines += ["\t".join(cell_text(r, k) for k, _, _ in self.columns) for r in rows]
        self.clipboard_clear()
        self.clipboard_append("\n".join(lines))


# --------------------------------------------------------------------------
# 主視窗
# --------------------------------------------------------------------------
class App(tk.Tk):
    def __init__(self, csv_path=None):
        super().__init__()
        self.title(APP_TITLE)
        self.settings = self._load_settings()
        self._normal_geom = self.settings.get("geometry", "1500x700")
        self.geometry(self._normal_geom)
        if self.settings.get("maximized"):
            self._set_maximized()
        self.bind("<Configure>", self._remember_geometry)
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
        self.var_date_from = tk.StringVar(value=ANY)
        self.var_date_to = tk.StringVar(value=ANY)
        self.var_time_from = tk.StringVar()
        self.var_time_to = tk.StringVar()
        self.var_opid = tk.StringVar()
        self.var_station = tk.StringVar(value="全部")
        self.var_verdict = tk.StringVar(value="全部")
        self.var_search = tk.StringVar()
        self.hidden_cols = set(self.settings.get("hidden_cols", []))
        self.only_lines = None     # None = 顯示全部；set = 只顯示框選確認的列
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

        # 篩選列：所有條件同時成立（AND）
        barf = ttk.Frame(self)
        barf.pack(fill="x", padx=6, pady=(2, 0))
        ttk.Label(barf, text="篩選", font=tkfont.Font(weight="bold")).pack(side="left", padx=(4, 6))
        ttk.Label(barf, text="日期").pack(side="left")
        self.cb_date_from = ttk.Combobox(barf, textvariable=self.var_date_from, width=11,
                                         state="readonly", values=[ANY])
        self.cb_date_from.pack(side="left", padx=(4, 0))
        ttk.Label(barf, text="～").pack(side="left")
        self.cb_date_to = ttk.Combobox(barf, textvariable=self.var_date_to, width=11,
                                       state="readonly", values=[ANY])
        self.cb_date_to.pack(side="left", padx=(0, 4))
        ttk.Label(barf, text="時間").pack(side="left", padx=(8, 0))
        self.ent_time_from = tk.Entry(barf, textvariable=self.var_time_from, width=8)
        self.ent_time_from.pack(side="left", padx=(4, 0))
        ttk.Label(barf, text="～").pack(side="left")
        self.ent_time_to = tk.Entry(barf, textvariable=self.var_time_to, width=8)
        self.ent_time_to.pack(side="left", padx=(0, 4))
        ttk.Label(barf, text="(HH:MM)", foreground="#888888").pack(side="left")
        ttk.Label(barf, text="站別").pack(side="left", padx=(10, 0))
        self.cb_station = ttk.Combobox(barf, textvariable=self.var_station, width=8,
                                       state="readonly", values=["全部"])
        self.cb_station.pack(side="left", **pad)
        ttk.Label(barf, text="結果").pack(side="left")
        self.cb_verdict = ttk.Combobox(barf, textvariable=self.var_verdict, width=6,
                                       state="readonly", values=["全部", "PASS", "FAIL", "HOLD"])
        self.cb_verdict.pack(side="left", **pad)
        ttk.Label(barf, text="SN").pack(side="left", padx=(6, 0))
        self.ent_sn = ttk.Entry(barf, textvariable=self.var_search, width=22)
        self.ent_sn.pack(side="left", **pad)
        ttk.Label(barf, text="OPID").pack(side="left")
        self.ent_opid = ttk.Entry(barf, textvariable=self.var_opid, width=10)
        self.ent_opid.pack(side="left", **pad)
        # 輸入框右鍵選單（剪下/複製/貼上/全選/清除）；時間欄貼上會自動拆出日期
        self._entry_menu(self.ent_time_from, self.var_time_from, self.var_date_from)
        self._entry_menu(self.ent_time_to, self.var_time_to, self.var_date_to)
        self._entry_menu(self.ent_sn, self.var_search)
        self._entry_menu(self.ent_opid, self.var_opid)
        ttk.Button(barf, text="✖ 清除篩選", command=self.clear_filters).pack(side="left", **pad)
        for cb in (self.cb_date_from, self.cb_date_to, self.cb_station, self.cb_verdict):
            cb.bind("<<ComboboxSelected>>", lambda e: self.refresh_view(scroll="end"))
        for v in (self.var_search, self.var_opid, self.var_time_from, self.var_time_to):
            v.trace_add("write", lambda *a: self.refresh_view(scroll="end"))

        # 框選 / 欄位
        bar3 = ttk.Frame(self)
        bar3.pack(fill="x", padx=6, pady=(2, 0))
        ttk.Button(bar3, text="☑ 選擇欄位…", command=self.choose_columns).pack(side="left", **pad)
        ttk.Separator(bar3, orient="vertical").pack(side="left", fill="y", padx=8)
        self.btn_only = ttk.Button(bar3, text="✔ 只顯示選取的列", command=self.show_only_selected)
        self.btn_only.pack(side="left", **pad)
        self.btn_all = ttk.Button(bar3, text="↺ 顯示全部", command=self.show_all)
        self.btn_all.pack(side="left", **pad)
        self.lbl_sel = ttk.Label(bar3, text="")
        self.lbl_sel.pack(side="left", padx=8)
        self.lbl_mode = tk.Label(bar3, text="", bg="#FFE699", fg="#7F4F00",
                                 font=tkfont.Font(weight="bold"))

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

        self.table = GridTable(self, on_double_click=self.show_detail,
                               on_select=self._on_select, on_context=self._context_menu,
                               on_copy=lambda t: self.var_status.set(
                                   f"已複製：{t}　（可直接 Ctrl+V 貼到 SN/OPID 篩選）"))
        self.table.pack(fill="both", expand=True, padx=6, pady=2)
        self.table.header.bind("<Button-3>", self._header_menu)

        sb = ttk.Label(self, textvariable=self.var_status, anchor="w", relief="sunken")
        sb.pack(fill="x", side="bottom")
        self.var_status.set("按住滑鼠左鍵拖曳可框選多列（Ctrl 加選、Shift 範圍、Ctrl+A 全選）；"
                            "雙擊儲存格可選取並複製；右鍵可複製任一格、整列、整欄或全部資料；Enter 看詳細資料")
        self._on_select(0)


    # ---- 框選 / 欄位 ----
    def _on_select(self, n):
        self.lbl_sel.config(text=f"已選 {n} 列" if n else "（拖曳滑鼠框選要的列）")
        self.btn_only.state(["!disabled"] if n else ["disabled"])

    def _copy_text(self, text):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.var_status.set(f"已複製：{text}")

    def _filter_sn(self, sn):
        self.var_search.set(sn)
        self.var_status.set(f"已用 SN 篩選：{sn}　（按「清除篩選」還原）")

    def _filter_opid(self, opid):
        self.var_opid.set(opid)
        self.var_status.set(f"已用 OPID 篩選：{opid}　（按「清除篩選」還原）")

    def _filter_date(self, date):
        self.var_date_from.set(date)
        self.var_date_to.set(date)
        self.refresh_view(scroll="end")

    def clear_filters(self):
        self._suspend = True
        for v in (self.var_date_from, self.var_date_to):
            v.set(ANY)
        for v in (self.var_station, self.var_verdict):
            v.set("全部")
        for v in (self.var_time_from, self.var_time_to, self.var_search, self.var_opid):
            v.set("")
        self._suspend = False
        self.refresh_view(scroll="end")

    # ---- 輸入框：右鍵選單與貼上 ----
    def _entry_menu(self, ent, var, date_var=None):
        def paste(e=None):
            try:
                text = self.clipboard_get()
            except tk.TclError:
                return "break"
            text = " ".join(text.split())          # 去掉換行/Tab（從 Excel 複製常帶換行）
            if date_var is not None:
                m = re.search(r"(\d{4})[/-](\d{1,2})[/-](\d{1,2})", text)
                t = re.search(r"\d{1,2}:\d{2}(:\d{2})?", text)
                if m:
                    date_var.set(f"{int(m[1]):04d}/{int(m[2]):02d}/{int(m[3]):02d}")
                if t:
                    var.set(t[0])
                elif not m:
                    var.set(text)
                self.refresh_view(scroll="end")
                return "break"
            try:
                ent.delete("sel.first", "sel.last")
            except tk.TclError:
                pass
            ent.insert("insert", text)
            return "break"

        def popup(e):
            ent.focus_set()
            m = tk.Menu(self, tearoff=0)
            has_sel = bool(ent.selection_present())
            m.add_command(label="剪下", state="normal" if has_sel else "disabled",
                          command=lambda: ent.event_generate("<<Cut>>"))
            m.add_command(label="複製", state="normal" if has_sel else "disabled",
                          command=lambda: ent.event_generate("<<Copy>>"))
            m.add_command(label="貼上", command=paste)
            m.add_separator()
            m.add_command(label="全選", command=lambda: ent.select_range(0, "end"))
            m.add_command(label="清除", command=lambda: var.set(""))
            try:
                m.tk_popup(e.x_root, e.y_root)
            finally:
                m.grab_release()

        ent.bind("<Button-3>", popup)
        ent.bind("<<Paste>>", paste)

    # ---- 右鍵複製 ----
    def _rows_to_text(self, rows, cols, header=True):
        lines = ["\t".join(t for _, t, _ in cols)] if header else []
        lines += ["\t".join(cell_text(r, k) for k, _, _ in cols) for r in rows]
        return "\n".join(lines)

    def _copy_block(self, text, what):
        self.clipboard_clear()
        self.clipboard_append(text)
        self.var_status.set(f"已複製{what}（以 Tab 分隔，可直接貼到 Excel）")

    def _copy_column(self, key, title):
        vals = [cell_text(r, key) for r in self.table.rows]
        self._copy_block("\n".join(vals), f"整欄「{title}」共 {len(vals)} 筆")

    def _filter_time_from(self, rec):
        self.var_date_from.set(rec["date"])
        self.var_time_from.set(rec["time"])

    def _filter_time_to(self, rec):
        self.var_date_to.set(rec["date"])
        self.var_time_to.set(rec["time"])

    def _context_menu(self, e):
        """右鍵選單：第一項只有「複製」這一格，其他功能收在「更多」裡"""
        top = self.menu = tk.Menu(self, tearoff=0)
        m = tk.Menu(top, tearoff=0)      # 「更多」子選單
        cols = self.table.columns
        cell = self.table.ctx_cell
        if cell:
            rec, key = cell
            title = next((t for k, t, _ in cols if k == key), key)
            text = cell_text(rec, key)
            show = text if len(text) <= 40 else text[:40] + "…"
            top.add_command(label=f"複製：{show}" if text else "複製（空白）",
                            state="normal" if text else "disabled",
                            command=lambda: self._copy_text(text))
            top.add_separator()
            # 這一列每個欄位都能單獨複製
            sub = tk.Menu(m, tearoff=0)
            for k, t, _ in all_columns(self.n_ch):
                v = cell_text(rec, k)
                sub.add_command(label=f"{t}：{v[:40] or '（空白）'}",
                                state="normal" if v else "disabled",
                                command=lambda v=v: self._copy_text(v))
            sub.add_separator()
            for k in ("notes", "out_dir", "duration_s", "measure_s", "engine_version"):
                v = rec["_raw"].get(k, "")
                if v:
                    sub.add_command(label=f"{k}：{v[:40]}", command=lambda v=v: self._copy_text(v))
            m.add_cascade(label="複製這一列的其他欄位", menu=sub)
            m.add_command(label="複製這一整列（含標題）",
                          command=lambda: self._copy_block(self._rows_to_text([rec], cols), "這一列"))
            m.add_command(label=f"複製整欄「{title}」",
                          command=lambda: self._copy_column(key, title))
            m.add_separator()
            m.add_command(label="查看詳細資料", command=lambda: self.show_detail(rec))
            m.add_command(label=f"用此 SN 篩選：{rec['sn']}",
                          command=lambda: self._filter_sn(rec["sn"]))
            m.add_command(label=f"用此 OPID 篩選：{rec['opid']}",
                          command=lambda: self._filter_opid(rec["opid"]))
            m.add_command(label=f"只看這一天：{rec['date']}",
                          command=lambda: self._filter_date(rec["date"]))
            m.add_command(label=f"從此時間開始：{rec['date']} {rec['time']}",
                          command=lambda: self._filter_time_from(rec))
            m.add_command(label=f"到此時間結束：{rec['date']} {rec['time']}",
                          command=lambda: self._filter_time_to(rec))
            m.add_separator()
        n_sel = len(self.table.selected)
        m.add_command(label=f"複製選取的列（{n_sel} 列，含標題）",
                      state="normal" if n_sel else "disabled",
                      command=lambda: self._copy_block(
                          self._rows_to_text(self.table.selected_rows(), cols), f"選取的 {n_sel} 列"))
        m.add_command(label=f"複製全部資料（畫面上 {len(self.table.rows)} 列，含標題）",
                      state="normal" if self.table.rows else "disabled",
                      command=lambda: self._copy_block(
                          self._rows_to_text(self.table.rows, cols), f"全部 {len(self.table.rows)} 列"))
        m.add_separator()
        m.add_command(label="只顯示選取的列", command=self.show_only_selected)
        m.add_command(label="顯示全部", command=self.show_all)
        m.add_command(label="選擇欄位…", command=self.choose_columns)
        top.add_cascade(label="更多", menu=m)
        try:
            top.tk_popup(e.x_root, e.y_root)
        finally:
            top.grab_release()

    def _header_menu(self, e):
        """在標題列按右鍵：複製整欄"""
        cx = self.table.header.canvasx(e.x)
        x = 0
        for (key, title, _), w in zip(self.table.columns, self.table.widths):
            if x <= cx < x + w:
                m = tk.Menu(self, tearoff=0)
                m.add_command(label=f"複製整欄「{title}」（{len(self.table.rows)} 筆）",
                              command=lambda: self._copy_column(key, title))
                m.add_command(label=f"複製整欄「{title}」（含標題）",
                              command=lambda: self._copy_block(
                                  title + "\n" + "\n".join(cell_text(r, key) for r in self.table.rows),
                                  f"整欄「{title}」"))
                m.add_separator()
                m.add_command(label="選擇欄位…", command=self.choose_columns)
                try:
                    m.tk_popup(e.x_root, e.y_root)
                finally:
                    m.grab_release()
                return
            x += w

    def show_only_selected(self):
        lines = self.table.selected.copy()
        if not lines:
            return
        self.only_lines = lines
        self.table.clear_selection()
        self.refresh_view(scroll="top")

    def show_all(self):
        self.only_lines = None
        self.refresh_view(scroll="end")

    def choose_columns(self):
        win = tk.Toplevel(self)
        win.title("選擇要顯示的欄位")
        win.transient(self)
        win.resizable(False, False)
        cols = all_columns(self.n_ch)
        vars_ = {}
        box = ttk.Frame(win, padding=12)
        box.pack(fill="both")
        per_col = 8
        for i, (key, title, _) in enumerate(cols):
            v = tk.BooleanVar(value=key not in self.hidden_cols)
            vars_[key] = v
            ttk.Checkbutton(box, text=title, variable=v).grid(
                row=i % per_col, column=i // per_col, sticky="w", padx=(0, 24), pady=2)

        def set_all(val):
            for v in vars_.values():
                v.set(val)

        def apply():
            hidden = {k for k, v in vars_.items() if not v.get()}
            if len(hidden) == len(cols):
                messagebox.showwarning(APP_TITLE, "至少要勾選一個欄位", parent=win)
                return
            self.hidden_cols = hidden
            win.destroy()
            self.refresh_view()

        btns = ttk.Frame(win, padding=(12, 0, 12, 12))
        btns.pack(fill="x")
        ttk.Button(btns, text="全選", command=lambda: set_all(True)).pack(side="left")
        ttk.Button(btns, text="全不選", command=lambda: set_all(False)).pack(side="left", padx=4)
        ttk.Button(btns, text="取消", command=win.destroy).pack(side="right")
        ttk.Button(btns, text="確定", command=apply).pack(side="right", padx=4)
        win.grab_set()
        return win

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
            self.only_lines = None
            self.var_date_from.set(ANY)
            self.var_date_to.set(ANY)
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
        self.cb_date_from["values"] = [ANY] + dates
        self.cb_date_to["values"] = [ANY] + dates
        self.cb_station["values"] = ["全部"] + stations

    # ---- 篩選/顯示 ----
    def _time_bounds(self):
        """解析時間欄位；格式錯誤的欄位標紅並忽略"""
        out = []
        for ent, var, upper in ((self.ent_time_from, self.var_time_from, False),
                                (self.ent_time_to, self.var_time_to, True)):
            try:
                t = parse_tod(var.get(), upper)
                ent.configure(bg="#FFFFFF")
            except (ValueError, TypeError):
                t = None
                ent.configure(bg="#FFC7CE")
            out.append(t)
        return out

    def filtered(self):
        """日期區間 + 時間 + 站別 + 結果 + SN + OPID，所有條件同時成立。
        有選日期：時間是「起始日的開始時間」到「結束日的結束時間」（可跨天）。
        沒選日期：時間是每天的時段（例如 20:00～08:00 夜班可跨午夜）。"""
        s, v = self.var_station.get(), self.var_verdict.get()
        q = self.var_search.get().strip().upper()
        qo = self.var_opid.get().strip().upper()
        d_from, d_to = self.var_date_from.get(), self.var_date_to.get()
        d_from = None if d_from in ("", ANY) else d_from
        d_to = None if d_to in ("", ANY) else d_to
        if d_from and d_to and d_from > d_to:   # 起訖日期選反了就自動對調
            d_from, d_to = d_to, d_from
        t_from, t_to = self._time_bounds()

        start = end = None
        tod_from = tod_to = None
        if d_from:
            start = datetime.combine(datetime.strptime(d_from, "%Y/%m/%d").date(),
                                     t_from or dtime(0, 0, 0))
        else:
            tod_from = t_from
        if d_to:
            end = datetime.combine(datetime.strptime(d_to, "%Y/%m/%d").date(),
                                   t_to or dtime(23, 59, 59))
        else:
            tod_to = t_to
        need_dt = bool(start or end or tod_from or tod_to)

        out = []
        for r in self.records:
            if s != "全部" and r["station"] != s:
                continue
            if v != "全部" and r["verdict"] != v:
                continue
            if q and q not in r["sn"].upper():
                continue
            if qo and qo not in r["opid"].upper():
                continue
            if need_dt:
                dt = r["_dt"]
                if dt is None:
                    continue
                if start and dt < start:
                    continue
                if end and dt > end:
                    continue
                if tod_from or tod_to:
                    t = dt.time()
                    if tod_from and tod_to and tod_from > tod_to:    # 跨午夜
                        if not (t >= tod_from or t <= tod_to):
                            continue
                    elif (tod_from and t < tod_from) or (tod_to and t > tod_to):
                        continue
            if self.only_lines is not None and r["_line"] not in self.only_lines:
                continue
            out.append(r)
        if self.var_newest_first.get():
            out.reverse()
        return out

    def refresh_view(self, scroll=None):
        if getattr(self, "_suspend", False):
            return
        rows = self.filtered()
        if scroll == "end":
            scroll = "top" if self.var_newest_first.get() else "bottom"
        self.table.set_data(build_columns(self.n_ch, self.hidden_cols), rows, scroll=scroll)
        self._update_stats(rows)
        if self.only_lines is not None:
            self.lbl_mode.config(text=f"  只顯示選取的 {len(self.only_lines)} 筆（按「顯示全部」還原）  ")
            self.lbl_mode.pack(side="right", padx=4)
            self.btn_all.state(["!disabled"])
        else:
            self.lbl_mode.pack_forget()
            self.btn_all.state(["disabled"])
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
        cols = build_columns(self.n_ch, self.hidden_cols)
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
            "hidden_cols": sorted(self.hidden_cols),
            "geometry": self._normal_geom,
            "maximized": self._is_maximized(),
        }
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    # ---- 視窗最大化（記住上次狀態）----
    def _set_maximized(self):
        try:
            self.state("zoomed")            # Windows / macOS
        except tk.TclError:
            try:
                self.attributes("-zoomed", True)   # Linux
            except tk.TclError:
                pass

    def _is_maximized(self):
        try:
            if self.state() == "zoomed":
                return True
        except tk.TclError:
            pass
        try:
            return bool(self.attributes("-zoomed"))
        except tk.TclError:
            return False

    def _remember_geometry(self, e):
        if e.widget is self and not self._is_maximized() and self.state() == "normal":
            self._normal_geom = self.geometry()

    def _on_close(self):
        if self._tick_job:
            self.after_cancel(self._tick_job)
            self._tick_job = None
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
