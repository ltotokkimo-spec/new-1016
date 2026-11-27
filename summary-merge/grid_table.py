# -*- coding: utf-8 -*-
"""
Canvas 表格（仿原「測試結果檢視器」）：黑底表頭、格線、每一格可個別上色、只畫看得到的列（資料多也很快）。

用法：
    g = GridTable(parent, style_fn=..., on_double=..., on_context=..., on_header=..., on_select=..., on_copy=...)
    g.set_columns([(key, title, anchor, width), ...])
    g.set_rows(rows, text_fn)        # text_fn(rec, key) -> str
    style_fn(rec, key) -> (bg, fg, bold) 或 None（用預設）
"""
import tkinter as tk
import tkinter.font as tkfont
from tkinter import ttk

COLORS = {"grid": "#A0A0A0", "header_bg": "#444444", "header_fg": "#FFFFFF", "cell_bg": "#FFFFFF",
          "cell_fg": "#000000", "select_bg": "#CCE4FF", "select_line": "#3399FF"}
ROW_H = 24
HEAD_H = 28
RESIZE_ZONE = 5


class GridTable(ttk.Frame):
    def __init__(self, master, style_fn=None, on_double=None, on_context=None, on_header=None,
                 on_select=None, on_copy=None):
        super().__init__(master)
        self.style_fn = style_fn or (lambda r, k: None)
        self.on_double, self.on_context, self.on_header = on_double, on_context, on_header
        self.on_select, self.on_copy = on_select, on_copy
        base = tkfont.nametofont("TkDefaultFont")
        self.font = tkfont.Font(family=base.actual("family"), size=max(base.actual("size"), 10))
        self.bold = tkfont.Font(family=base.actual("family"), size=max(base.actual("size"), 10), weight="bold")
        self.cols = []            # [(key, title, anchor, width)]
        self.rows = []
        self.text_fn = lambda r, k: ""
        self.top = 0              # 第一個可見列
        self.sel = set()          # 選取的列 index
        self.anchor_row = None
        self._drag = None
        self._resize = None
        self._press_row = None

        self.head = tk.Canvas(self, height=HEAD_H, bg=COLORS["header_bg"], highlightthickness=0)
        self.body = tk.Canvas(self, bg=COLORS["cell_bg"], highlightthickness=0, takefocus=1)
        self.vs = ttk.Scrollbar(self, orient="vertical", command=self._yscroll)
        self.hs = ttk.Scrollbar(self, orient="horizontal", command=self._xscroll)
        self.head.grid(row=0, column=0, sticky="ew")
        self.body.grid(row=1, column=0, sticky="nsew")
        self.vs.grid(row=0, column=1, rowspan=2, sticky="ns")
        self.hs.grid(row=2, column=0, sticky="ew")
        self.rowconfigure(1, weight=1)
        self.columnconfigure(0, weight=1)

        b = self.body
        b.bind("<Configure>", lambda e: self.redraw())
        b.bind("<Button-1>", self._press)
        b.bind("<B1-Motion>", self._motion)
        b.bind("<ButtonRelease-1>", lambda e: setattr(self, "_drag", None))
        b.bind("<Double-Button-1>", self._dclick)
        b.bind("<Button-3>", lambda e: self._context(e, "cell"))
        b.bind("<Up>", lambda e: self._move(-1, e))
        b.bind("<Down>", lambda e: self._move(1, e))
        b.bind("<Prior>", lambda e: self._move(-self._page(), e))
        b.bind("<Next>", lambda e: self._move(self._page(), e))
        b.bind("<Home>", lambda e: self._move(-len(self.rows), e))
        b.bind("<End>", lambda e: self._move(len(self.rows), e))
        b.bind("<Return>", lambda e: self._open_sel())
        b.bind("<Control-a>", self.select_all)
        b.bind("<Control-A>", self.select_all)
        b.bind("<Control-c>", lambda e: (self.on_copy and self.on_copy(), "break")[1])
        b.bind("<Control-C>", lambda e: (self.on_copy and self.on_copy(), "break")[1])
        for w in (b, self.head):
            w.bind("<MouseWheel>", self._wheel)
            w.bind("<Shift-MouseWheel>", self._shift_wheel)
            w.bind("<Button-4>", lambda e: self.scroll(-3))
            w.bind("<Button-5>", lambda e: self.scroll(3))
        h = self.head
        h.bind("<Motion>", self._head_motion)
        h.bind("<Button-1>", self._head_press)
        h.bind("<B1-Motion>", self._head_drag)
        h.bind("<ButtonRelease-1>", self._head_release)
        h.bind("<Button-3>", lambda e: self._context(e, "heading"))
        h.bind("<Leave>", lambda e: h.configure(cursor=""))

    # ================================================================ 資料
    def set_columns(self, cols):
        self.cols = [list(c) for c in cols]
        self._scrollregion()
        self.redraw()

    def widths(self):
        return {c[0]: c[3] for c in self.cols}

    def set_rows(self, rows, text_fn, keep_sel_ids=None):
        self.rows = rows
        self.text_fn = text_fn
        if keep_sel_ids is not None:
            self.sel = {i for i, r in enumerate(rows) if id(r) in keep_sel_ids}
        else:
            self.sel = set()
        self.top = min(self.top, max(0, len(rows) - 1))
        self.redraw()

    def selected(self):
        return [self.rows[i] for i in sorted(self.sel) if i < len(self.rows)]

    def select_all(self, _e=None):
        self.sel = set(range(len(self.rows)))
        self.redraw()
        self._notify()
        return "break"

    def clear_selection(self):
        self.sel = set()
        self.redraw()
        self._notify()

    def select_rec(self, rec):
        for i, r in enumerate(self.rows):
            if r is rec:
                self.sel = {i}
                self.anchor_row = i
                self.redraw()
                self._notify()
                return

    # ================================================================ 捲動
    def _visible_n(self):
        return max(1, self.body.winfo_height() // ROW_H)

    def _page(self):
        return max(1, self._visible_n() - 1)

    def _max_top(self):
        return max(0, len(self.rows) - self._visible_n())

    def moveto(self, frac):
        self.top = int(round(frac * len(self.rows)))
        self.top = max(0, min(self.top, self._max_top()))
        self.redraw()

    def yview_frac(self):
        return self.top / len(self.rows) if self.rows else 0.0

    def to_top(self):
        self.top = 0
        self.redraw()

    def to_bottom(self):
        self.top = self._max_top()
        self.redraw()

    def scroll(self, n):
        self.top = max(0, min(self.top + n, self._max_top()))
        self.redraw()

    def _yscroll(self, *a):
        if a[0] == "moveto":
            self.moveto(float(a[1]))
        elif a[0] == "scroll":
            n = int(a[1])
            self.scroll(n * (self._page() if a[2] == "pages" else 1))

    def _xscroll(self, *a):
        self.body.xview(*a)
        self.head.xview(*a)
        self._update_hbar()

    def _wheel(self, e):
        self.scroll(-3 if e.delta > 0 else 3)
        return "break"

    def _shift_wheel(self, e):
        self._xscroll("scroll", -3 if e.delta > 0 else 3, "units")
        return "break"

    def _scrollregion(self):
        w = sum(c[3] for c in self.cols) + 1
        self.body.configure(scrollregion=(0, 0, w, 1), xscrollincrement=20)
        self.head.configure(scrollregion=(0, 0, w, HEAD_H), xscrollincrement=20)
        self._update_hbar()

    def _update_hbar(self):
        f = self.body.xview()
        self.hs.set(*f)

    def ensure_visible(self, i):
        if i < self.top:
            self.top = i
        elif i >= self.top + self._visible_n():
            self.top = i - self._visible_n() + 1
        self.top = max(0, min(self.top, self._max_top()))

    # ================================================================ 繪圖
    def redraw(self):
        self._draw_header()
        self._draw_body()

    def _draw_header(self):
        h = self.head
        h.delete("all")
        x = 0
        for key, title, _a, w in self.cols:
            h.create_rectangle(x, 0, x + w, HEAD_H, fill=COLORS["header_bg"], outline="#777777")
            h.create_text(x + w / 2, HEAD_H / 2, text=title, fill=COLORS["header_fg"], font=self.bold)
            x += w

    def _draw_body(self):
        b = self.body
        b.delete("all")
        n = len(self.rows)
        vis = self._visible_n() + 1
        width = sum(c[3] for c in self.cols)
        if not n:
            b.create_text(10, 10, text="（沒有資料）", anchor="nw", fill="#888888", font=self.font)
        for vi in range(min(vis, n - self.top)):
            i = self.top + vi
            r = self.rows[i]
            y0, y1 = vi * ROW_H, (vi + 1) * ROW_H
            selected = i in self.sel
            x = 0
            for key, _t, anchor, w in self.cols:
                st = self.style_fn(r, key)
                bg, fg, bold = st if st else (COLORS["cell_bg"], COLORS["cell_fg"], False)
                if selected and bg == COLORS["cell_bg"]:
                    bg = COLORS["select_bg"]
                b.create_rectangle(x, y0, x + w, y1, fill=bg, outline=COLORS["grid"])
                text = self.text_fn(r, key)
                if text:
                    f = self.bold if bold else self.font
                    if anchor == "w":
                        tx, an = x + 5, "w"
                    elif anchor == "e":
                        tx, an = x + w - 5, "e"
                    else:
                        tx, an = x + w / 2, "center"
                    item = b.create_text(tx, (y0 + y1) / 2, text=text, anchor=an, fill=fg, font=f)
                    bb = b.bbox(item)
                    if bb and (bb[2] - bb[0]) > w - 6:      # 太長就截斷
                        b.delete(item)
                        b.create_text(x + 5, (y0 + y1) / 2, text=self._clip(text, w - 10, f), anchor="w", fill=fg, font=f)
                x += w
            if selected:
                b.create_line(0, y0, width, y0, fill=COLORS["select_line"])
                b.create_line(0, y1, width, y1, fill=COLORS["select_line"])
        # 垂直捲軸
        if n:
            self.vs.set(self.top / n, min(1.0, (self.top + self._visible_n()) / n))
        else:
            self.vs.set(0, 1)
        self._update_hbar()

    def _clip(self, text, maxw, font):
        if font.measure(text) <= maxw:
            return text
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if font.measure(text[:mid] + "…") <= maxw:
                lo = mid
            else:
                hi = mid - 1
        return text[:lo] + "…"

    # ================================================================ 位置
    def row_at(self, y):
        i = self.top + int(y // ROW_H)
        return i if 0 <= i < len(self.rows) else None

    def col_at(self, x_widget, canvas=None):
        x = (canvas or self.body).canvasx(x_widget)
        acc = 0
        for idx, c in enumerate(self.cols):
            if acc <= x < acc + c[3]:
                return idx
            acc += c[3]
        return None

    # ================================================================ 滑鼠 / 鍵盤
    def _notify(self):
        if self.on_select:
            self.on_select(len(self.sel))

    def _press(self, e):
        self.body.focus_set()
        i = self.row_at(e.y)
        if i is None:
            return
        ctrl = e.state & 0x0004
        shift = e.state & 0x0001
        if shift and self.anchor_row is not None:
            lo, hi = sorted((self.anchor_row, i))
            rng = set(range(lo, hi + 1))
            self.sel = (self.sel | rng) if ctrl else rng
        elif ctrl:
            self.sel ^= {i}
            self.anchor_row = i
        else:
            self.sel = {i}
            self.anchor_row = i
        self._drag = (i, set(self.sel) if ctrl else set())
        self.redraw()
        self._notify()

    def _motion(self, e):
        if not self._drag:
            return
        if e.y < 0:
            self.scroll(-1)
        elif e.y > self.body.winfo_height():
            self.scroll(1)
        y = min(max(e.y, 0), self.body.winfo_height() - 1)
        i = self.row_at(y)
        if i is None:
            i = len(self.rows) - 1
        start, base = self._drag
        lo, hi = sorted((start, i))
        self.sel = base | set(range(lo, hi + 1))
        self.redraw()
        self._notify()

    def _move(self, d, e):
        if not self.rows:
            return "break"
        cur = self.anchor_row if self.anchor_row is not None else (min(self.sel) if self.sel else -1)
        i = max(0, min(len(self.rows) - 1, cur + d))
        if e.state & 0x0001 and self.anchor_row is not None:
            lo, hi = sorted((self.anchor_row, i))
            self.sel = set(range(lo, hi + 1))
        else:
            self.sel = {i}
            self.anchor_row = i
        self.ensure_visible(i)
        self.redraw()
        self._notify()
        return "break"

    def _dclick(self, e):
        i = self.row_at(e.y)
        if i is not None and self.on_double:
            self.on_double(self.rows[i])

    def _open_sel(self):
        s = self.selected()
        if s and self.on_double:
            self.on_double(s[0])

    def _context(self, e, region):
        canvas = self.head if region == "heading" else self.body
        ci = self.col_at(e.x, canvas)
        key = self.cols[ci][0] if ci is not None else None
        rec = None
        if region == "cell":
            i = self.row_at(e.y)
            if i is None:
                return
            if i not in self.sel:
                self.sel = {i}
                self.anchor_row = i
                self.redraw()
                self._notify()
            rec = self.rows[i]
        if self.on_context:
            self.on_context(e, region, rec, key)

    # ---------- 表頭：點擊排序、拖曳邊界調整欄寬
    def _border_at(self, x_widget):
        x = self.head.canvasx(x_widget)
        acc = 0
        for idx, c in enumerate(self.cols):
            acc += c[3]
            if abs(x - acc) <= RESIZE_ZONE:
                return idx
        return None

    def _head_motion(self, e):
        self.head.configure(cursor="sb_h_double_arrow" if self._border_at(e.x) is not None else "")

    def _head_press(self, e):
        idx = self._border_at(e.x)
        if idx is not None:
            self._resize = (idx, self.head.canvasx(e.x), self.cols[idx][3])
        else:
            self._resize = None
            self._click_col = self.col_at(e.x, self.head)

    def _head_drag(self, e):
        if not self._resize:
            return
        idx, x0, w0 = self._resize
        self.cols[idx][3] = max(30, int(w0 + self.head.canvasx(e.x) - x0))
        self._scrollregion()
        self.redraw()

    def _head_release(self, e):
        if self._resize:
            self._resize = None
            return
        ci = getattr(self, "_click_col", None)
        if ci is not None and ci == self.col_at(e.x, self.head) and self.on_header:
            self.on_header(self.cols[ci][0])
