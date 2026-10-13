"""
小畫家 - Tkinter GUI 版本
畫筆、橡皮擦、直線、矩形、橢圓、油漆桶、滴管，可復原/重做、開啟與儲存 PNG。
可用 PyInstaller 打包成單一 .exe 執行檔，免安裝雙擊即可開啟。
"""

import json
import os
import tkinter as tk
from tkinter import colorchooser, filedialog, messagebox

from PIL import Image, ImageDraw, ImageTk

# ---------- 顏色設定（沿用計算機配色） ----------
COLOR_BG = "#211f1d"
COLOR_PANEL = "#2b2926"
COLOR_BTN = "#3a3733"
COLOR_BTN_HOVER = "#47433d"
COLOR_BTN_ACTIVE = "#b5502c"
COLOR_TEXT = "#f4f0e8"
COLOR_SUB = "#a39d91"
COLOR_WORKSPACE = "#4a4641"

FONT_UI = ("Microsoft JhengHei UI", 10)
FONT_UI_BOLD = ("Microsoft JhengHei UI", 10, "bold")
FONT_STATUS = ("Consolas", 9)

CANVAS_W, CANVAS_H = 800, 520
MAX_HISTORY = 40

PALETTE = [
    "#000000", "#7f7f7f", "#880015", "#ed1c24", "#ff7f27", "#fff200", "#22b14c", "#00a2e8",
    "#3f48cc", "#a349a4", "#ffffff", "#c3c3c3", "#b97a57", "#ffaec9", "#ffc90e", "#efe4b0",
    "#b5e61d", "#99d9ea", "#7092be", "#c8bfe7",
]

TOOLS = [
    # (代號, 顯示文字, 快捷鍵)
    ("pen", "✏ 畫筆", "P"),
    ("eraser", "▭ 橡皮擦", "E"),
    ("line", "╱ 直線", "L"),
    ("rect", "□ 矩形", "R"),
    ("oval", "○ 橢圓", "O"),
    ("fill", "◧ 油漆桶", "F"),
    ("picker", "⊙ 滴管", "I"),
]


def hex_to_rgb(color):
    color = color.lstrip("#")
    return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))


def rgb_to_hex(rgb):
    return "#{:02x}{:02x}{:02x}".format(*rgb[:3])


def normalize_box(p1, p2, square=False):
    """把兩個角落點轉成 (左, 上, 右, 下)；square=True 時強制成正方形。"""
    (x1, y1), (x2, y2) = p1, p2
    if square:
        side = max(abs(x2 - x1), abs(y2 - y1))
        x2 = x1 + side if x2 >= x1 else x1 - side
        y2 = y1 + side if y2 >= y1 else y1 - side
    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


class PaintDocument:
    """畫布內容與復原紀錄（只用 PIL，不需要視窗，可單獨測試）。"""

    def __init__(self, width=CANVAS_W, height=CANVAS_H):
        self.image = Image.new("RGB", (width, height), "white")
        self.undo_stack = []
        self.redo_stack = []
        self.dirty = False

    @property
    def size(self):
        return self.image.size

    # ---------- 紀錄 ----------
    def _checkpoint(self):
        self.undo_stack.append(self.image.copy())
        if len(self.undo_stack) > MAX_HISTORY:
            self.undo_stack.pop(0)
        self.redo_stack.clear()
        self.dirty = True

    def can_undo(self):
        return bool(self.undo_stack)

    def can_redo(self):
        return bool(self.redo_stack)

    def undo(self):
        if not self.undo_stack:
            return False
        self.redo_stack.append(self.image)
        self.image = self.undo_stack.pop()
        self.dirty = True
        return True

    def redo(self):
        if not self.redo_stack:
            return False
        self.undo_stack.append(self.image)
        self.image = self.redo_stack.pop()
        self.dirty = True
        return True

    # ---------- 繪圖 ----------
    def stroke(self, points, color, width):
        """自由筆畫（畫筆與橡皮擦）：線段相接處畫圓，筆畫才會圓滑。"""
        if not points:
            return
        self._checkpoint()
        draw = ImageDraw.Draw(self.image)
        rgb = hex_to_rgb(color)
        if len(points) > 1:
            draw.line(points, fill=rgb, width=width)
        if width > 2 or len(points) == 1:
            for p in points:
                self._dot(draw, p, rgb, width)

    @staticmethod
    def _dot(draw, point, rgb, width):
        """畫一個直徑剛好等於筆寬的圓點，接在線段上不會凸出來。"""
        # 偏移量與 PIL 畫線一致：線寬 w 會涵蓋 -(w-1)//2 到 +w//2
        x, y = point
        lo, hi = (width - 1) // 2, width // 2
        draw.ellipse((x - lo, y - lo, x + hi, y + hi), fill=rgb)

    def line(self, p1, p2, color, width):
        self._checkpoint()
        draw = ImageDraw.Draw(self.image)
        rgb = hex_to_rgb(color)
        draw.line([p1, p2], fill=rgb, width=width)
        if width > 2:
            for p in (p1, p2):
                self._dot(draw, p, rgb, width)

    def rect(self, p1, p2, color, width, filled=False, square=False):
        box = normalize_box(p1, p2, square)
        self._checkpoint()
        rgb = hex_to_rgb(color)
        ImageDraw.Draw(self.image).rectangle(
            box, outline=rgb, fill=rgb if filled else None, width=width)

    def oval(self, p1, p2, color, width, filled=False, square=False):
        box = normalize_box(p1, p2, square)
        self._checkpoint()
        rgb = hex_to_rgb(color)
        ImageDraw.Draw(self.image).ellipse(
            box, outline=rgb, fill=rgb if filled else None, width=width)

    def fill(self, point, color):
        """油漆桶：把相連的同色區域換成新顏色。點到同色時不做事。"""
        x, y = point
        w, h = self.size
        if not (0 <= x < w and 0 <= y < h):
            return False
        rgb = hex_to_rgb(color)
        if self.image.getpixel((x, y)) == rgb:
            return False
        self._checkpoint()
        ImageDraw.floodfill(self.image, (x, y), rgb)
        return True

    def pick(self, point):
        x, y = point
        w, h = self.size
        if not (0 <= x < w and 0 <= y < h):
            return None
        return rgb_to_hex(self.image.getpixel((x, y)))

    def clear(self):
        self._checkpoint()
        self.image = Image.new("RGB", self.size, "white")

    # ---------- 檔案 ----------
    def save(self, path):
        self.image.save(path)
        self.dirty = False

    def load(self, path):
        img = Image.open(path).convert("RGB")
        self._checkpoint()
        self.image = img
        self.dirty = False


class PaintApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("小畫家")
        self._fit_to_screen(1040, 680)
        self.configure(bg=COLOR_BG)

        self.doc = PaintDocument()
        self.file_path = None
        self.tool = tk.StringVar(value="pen")
        self.color = "#000000"
        self.size_var = tk.IntVar(value=4)
        self.filled_var = tk.BooleanVar(value=False)

        self._points = []
        self._start = None
        self._preview_items = []
        self._photo = None

        self._build_ui()
        self._bind_keys()
        self._refresh_canvas()
        self._select_tool("pen")
        self._update_title()
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(200, self._grab_focus)

    def _fit_to_screen(self, want_w, want_h):
        """視窗不超過螢幕（扣掉工作列和標題列），小螢幕上狀態列才不會被擋住。"""
        w = min(want_w, self.winfo_screenwidth() - 20)
        h = min(want_h, self.winfo_screenheight() - 110)
        x = max((self.winfo_screenwidth() - w) // 2, 0)
        y = max((self.winfo_screenheight() - 80 - h) // 2, 0)
        self.geometry(f"{w}x{h}+{x}+{y}")
        self.minsize(min(760, w), min(520, h))

    def _grab_focus(self):
        self.lift()
        self.focus_force()
        self._write_test_info()

    def _write_test_info(self):
        # 自動測試用：設定 PAINT_TEST_INFO 時，寫出畫布與調色盤在螢幕上的位置
        path = os.environ.get("PAINT_TEST_INFO")
        if not path:
            return
        self.update_idletasks()
        c = self.canvas
        info = {
            "canvas": [c.winfo_rootx(), c.winfo_rooty(), c.winfo_width(), c.winfo_height()],
            "swatches": {
                color: [sw.winfo_rootx() + sw.winfo_width() // 2, sw.winfo_rooty() + sw.winfo_height() // 2]
                for color, sw in self.swatches.items()
            },
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(info, f)

    # ---------- 版面 ----------
    def _build_ui(self):
        self._build_topbar()
        body = tk.Frame(self, bg=COLOR_BG)
        body.pack(fill="both", expand=True)
        self._build_toolbox(body)
        self._build_workspace(body)
        self._build_statusbar()

    def _button(self, parent, text, command, width=None):
        btn = tk.Button(
            parent, text=text, command=command, font=FONT_UI,
            bg=COLOR_BTN, fg=COLOR_TEXT, activebackground=COLOR_BTN_HOVER,
            activeforeground=COLOR_TEXT, bd=0, relief="flat", cursor="hand2",
            padx=10, pady=4,
        )
        if width:
            btn.config(width=width)
        btn.bind("<Enter>", lambda e: btn.config(bg=COLOR_BTN_HOVER) if btn["bg"] == COLOR_BTN else None)
        btn.bind("<Leave>", lambda e: btn.config(bg=COLOR_BTN) if btn["bg"] == COLOR_BTN_HOVER else None)
        return btn

    def _build_topbar(self):
        bar = tk.Frame(self, bg=COLOR_PANEL, padx=10, pady=8)
        bar.pack(fill="x")

        files = tk.Frame(bar, bg=COLOR_PANEL)
        files.pack(side="left")
        self._button(files, "開新", self._new_file).pack(side="left", padx=(0, 4))
        self._button(files, "開啟", self._open_file).pack(side="left", padx=4)
        self._button(files, "儲存", self._save_file).pack(side="left", padx=4)
        self.undo_btn = self._button(files, "↶ 復原", self._undo)
        self.undo_btn.pack(side="left", padx=(16, 4))
        self.redo_btn = self._button(files, "↷ 重做", self._redo)
        self.redo_btn.pack(side="left", padx=4)

        # 顏色：目前顏色 + 調色盤 + 自訂
        colors = tk.Frame(bar, bg=COLOR_PANEL)
        colors.pack(side="right")
        self.current_swatch = tk.Label(
            colors, bg=self.color, width=4, height=2, relief="solid", bd=1, cursor="hand2")
        self.current_swatch.pack(side="left", padx=(0, 10))
        self.current_swatch.bind("<Button-1>", lambda e: self._choose_custom_color())

        grid = tk.Frame(colors, bg=COLOR_PANEL)
        grid.pack(side="left")
        per_row = len(PALETTE) // 2
        self.swatches = {}
        for i, c in enumerate(PALETTE):
            sw = tk.Label(grid, bg=c, width=2, height=1, relief="solid", bd=1, cursor="hand2")
            sw.grid(row=i // per_row, column=i % per_row, padx=1, pady=1)
            sw.bind("<Button-1>", lambda e, col=c: self._set_color(col))
            self.swatches[c] = sw
        self._button(colors, "自訂…", self._choose_custom_color).pack(side="left", padx=(10, 0))

    def _build_toolbox(self, parent):
        box = tk.Frame(parent, bg=COLOR_PANEL, padx=8, pady=10)
        box.pack(side="left", fill="y")

        tk.Label(box, text="工具", font=FONT_UI_BOLD, bg=COLOR_PANEL, fg=COLOR_SUB,
                 anchor="w").pack(fill="x", pady=(0, 6))
        self.tool_buttons = {}
        for key, label, shortcut in TOOLS:
            btn = self._button(box, f"{label}  ({shortcut})", lambda k=key: self._select_tool(k), width=12)
            btn.config(anchor="w")
            btn.pack(fill="x", pady=2)
            self.tool_buttons[key] = btn

        tk.Label(box, text="粗細", font=FONT_UI_BOLD, bg=COLOR_PANEL, fg=COLOR_SUB,
                 anchor="w").pack(fill="x", pady=(16, 0))
        tk.Scale(
            box, from_=1, to=40, orient="horizontal", variable=self.size_var,
            bg=COLOR_PANEL, fg=COLOR_TEXT, troughcolor=COLOR_BTN, highlightthickness=0,
            activebackground=COLOR_BTN_ACTIVE, bd=0, length=130, font=FONT_UI,
            command=lambda v: self._update_size_preview(),
        ).pack(fill="x")
        self.size_preview = tk.Canvas(box, width=130, height=44, bg=COLOR_PANEL, highlightthickness=0)
        self.size_preview.pack(pady=(2, 0))

        tk.Checkbutton(
            box, text="圖形填滿", variable=self.filled_var, font=FONT_UI,
            bg=COLOR_PANEL, fg=COLOR_TEXT, selectcolor=COLOR_BTN,
            activebackground=COLOR_PANEL, activeforeground=COLOR_TEXT, anchor="w",
        ).pack(fill="x", pady=(10, 0))

        self._button(box, "清除畫布", self._clear).pack(fill="x", side="bottom")
        tk.Label(
            box, text="Shift：正方形／正圓\nCtrl+Z 復原  Ctrl+Y 重做\nCtrl+S 儲存",
            font=("Microsoft JhengHei UI", 8), bg=COLOR_PANEL, fg=COLOR_SUB, justify="left",
        ).pack(fill="x", side="bottom", pady=(0, 10))

    def _build_workspace(self, parent):
        ws = tk.Frame(parent, bg=COLOR_WORKSPACE)
        ws.pack(side="left", fill="both", expand=True)
        self.canvas = tk.Canvas(
            ws, width=CANVAS_W, height=CANVAS_H, bg="white",
            highlightthickness=0, cursor="crosshair",
        )
        self.canvas.place(relx=0.5, rely=0.5, anchor="center")
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<B1-Motion>", self._on_drag)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Motion>", self._on_motion)
        self.canvas.bind("<Leave>", lambda e: self.pos_var.set(""))

    def _build_statusbar(self):
        bar = tk.Frame(self, bg=COLOR_PANEL, padx=10, pady=3)
        bar.pack(fill="x", side="bottom")
        self.pos_var = tk.StringVar()
        self.info_var = tk.StringVar()
        tk.Label(bar, textvariable=self.pos_var, font=FONT_STATUS, bg=COLOR_PANEL,
                 fg=COLOR_SUB, width=14, anchor="w").pack(side="left")
        tk.Label(bar, textvariable=self.info_var, font=FONT_STATUS, bg=COLOR_PANEL,
                 fg=COLOR_SUB, anchor="e").pack(side="right")

    def _bind_keys(self):
        for key, _label, shortcut in TOOLS:
            for k in (shortcut.lower(), shortcut):
                self.bind(f"<KeyPress-{k}>", lambda e, t=key: self._select_tool(t))
        self.bind("<Control-z>", lambda e: self._undo())
        self.bind("<Control-Z>", lambda e: self._undo())
        self.bind("<Control-y>", lambda e: self._redo())
        self.bind("<Control-Y>", lambda e: self._redo())
        self.bind("<Control-s>", lambda e: self._save_file())
        self.bind("<Control-o>", lambda e: self._open_file())
        self.bind("<Control-n>", lambda e: self._new_file())
        self.bind("<bracketleft>", lambda e: self.size_var.set(max(1, self.size_var.get() - 1)) or self._update_size_preview())
        self.bind("<bracketright>", lambda e: self.size_var.set(min(40, self.size_var.get() + 1)) or self._update_size_preview())

    # ---------- 狀態更新 ----------
    def _select_tool(self, key):
        self.tool.set(key)
        for k, btn in self.tool_buttons.items():
            btn.config(bg=COLOR_BTN_ACTIVE if k == key else COLOR_BTN)
        self.canvas.config(cursor="dotbox" if key == "eraser" else "crosshair")
        self._update_info()

    def _set_color(self, color):
        self.color = color
        self.current_swatch.config(bg=color)
        self._update_size_preview()
        self._update_info()

    def _choose_custom_color(self):
        result = colorchooser.askcolor(color=self.color, title="選擇顏色")
        if result and result[1]:
            self._set_color(result[1])

    def _update_size_preview(self):
        c = self.size_preview
        c.delete("all")
        s = self.size_var.get()
        c.create_oval(65 - s / 2, 22 - s / 2, 65 + s / 2, 22 + s / 2, fill=self.color, outline=COLOR_SUB)
        self._update_info()

    def _update_info(self):
        if not hasattr(self, "info_var"):
            return
        names = {k: label.split(" ", 1)[1] for k, label, _ in TOOLS}
        w, h = self.doc.size
        self.info_var.set(
            f"{names[self.tool.get()]}  ·  {self.color.upper()}  ·  粗細 {self.size_var.get()}px  ·  畫布 {w}×{h}")

    def _update_title(self):
        name = os.path.basename(self.file_path) if self.file_path else "未命名"
        self.title(f"{'*' if self.doc.dirty else ''}{name} - 小畫家")
        self.undo_btn.config(state="normal" if self.doc.can_undo() else "disabled")
        self.redo_btn.config(state="normal" if self.doc.can_redo() else "disabled")

    def _refresh_canvas(self):
        w, h = self.doc.size
        self.canvas.config(width=w, height=h)
        self._photo = ImageTk.PhotoImage(self.doc.image)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self._photo, anchor="nw")
        self._preview_items.clear()
        self._update_title()
        self._update_info()
        self._export_for_test()

    def _export_for_test(self):
        # 自動測試用：設定 PAINT_TEST_EXPORT 時，每次畫完把畫布存成 PNG
        path = os.environ.get("PAINT_TEST_EXPORT")
        if path:
            self.doc.image.save(path)

    # ---------- 滑鼠繪圖 ----------
    def _clamp(self, event):
        w, h = self.doc.size
        return min(max(int(event.x), 0), w - 1), min(max(int(event.y), 0), h - 1)

    def _on_motion(self, event):
        x, y = self._clamp(event)
        self.pos_var.set(f"{x}, {y} px")

    def _on_press(self, event):
        self.canvas.focus_set()
        p = (int(event.x), int(event.y))
        tool = self.tool.get()
        if tool == "fill":
            if self.doc.fill(self._clamp(event), self.color):
                self._refresh_canvas()
            return
        if tool == "picker":
            picked = self.doc.pick(self._clamp(event))
            if picked:
                self._set_color(picked)
                self._select_tool("pen")
            return
        self._start = p
        self._points = [p]
        if tool in ("pen", "eraser"):
            color = "#ffffff" if tool == "eraser" else self.color
            s = self.size_var.get()
            r = max(s / 2, 0.5)
            self._preview_items.append(self.canvas.create_oval(
                p[0] - r, p[1] - r, p[0] + r, p[1] + r, fill=color, outline=color))

    def _on_drag(self, event):
        if self._start is None:
            return
        self._on_motion(event)
        p = (int(event.x), int(event.y))
        tool = self.tool.get()
        s = self.size_var.get()
        shift = bool(event.state & 0x0001)
        if tool in ("pen", "eraser"):
            if p == self._points[-1]:
                return
            color = "#ffffff" if tool == "eraser" else self.color
            last = self._points[-1]
            self._preview_items.append(self.canvas.create_line(
                last[0], last[1], p[0], p[1], fill=color, width=s,
                capstyle="round", joinstyle="round"))
            self._points.append(p)
            return
        for item in self._preview_items:
            self.canvas.delete(item)
        self._preview_items.clear()
        fill = self.color if self.filled_var.get() else ""
        if tool == "line":
            item = self.canvas.create_line(*self._start, *p, fill=self.color, width=s, capstyle="round")
        elif tool == "rect":
            item = self.canvas.create_rectangle(
                *normalize_box(self._start, p, shift), outline=self.color, width=s, fill=fill)
        else:
            item = self.canvas.create_oval(
                *normalize_box(self._start, p, shift), outline=self.color, width=s, fill=fill)
        self._preview_items.append(item)

    def _on_release(self, event):
        if self._start is None:
            return
        p = (int(event.x), int(event.y))
        tool = self.tool.get()
        s = self.size_var.get()
        shift = bool(event.state & 0x0001)
        filled = self.filled_var.get()
        if tool == "pen":
            self.doc.stroke(self._points, self.color, s)
        elif tool == "eraser":
            self.doc.stroke(self._points, "#ffffff", s)
        elif tool == "line":
            self.doc.line(self._start, p, self.color, s)
        elif tool == "rect":
            self.doc.rect(self._start, p, self.color, s, filled, shift)
        elif tool == "oval":
            self.doc.oval(self._start, p, self.color, s, filled, shift)
        self._start = None
        self._points = []
        self._refresh_canvas()

    # ---------- 指令 ----------
    def _undo(self):
        if self.doc.undo():
            self._refresh_canvas()

    def _redo(self):
        if self.doc.redo():
            self._refresh_canvas()

    def _clear(self):
        self.doc.clear()
        self._refresh_canvas()

    def _confirm_discard(self):
        """有未儲存的變更時詢問；回傳 True 表示可以繼續。"""
        if not self.doc.dirty:
            return True
        answer = messagebox.askyesnocancel("小畫家", "要儲存目前的圖畫嗎？")
        if answer is None:
            return False
        if answer:
            return self._save_file()
        return True

    def _new_file(self):
        if not self._confirm_discard():
            return
        self.doc = PaintDocument()
        self.file_path = None
        self._refresh_canvas()

    def _open_file(self):
        if not self._confirm_discard():
            return
        path = filedialog.askopenfilename(
            title="開啟圖片",
            filetypes=[("圖片", "*.png *.jpg *.jpeg *.bmp *.gif"), ("所有檔案", "*.*")])
        if not path:
            return
        try:
            self.doc.load(path)
        except Exception as exc:  # 檔案損毀或不是圖片
            messagebox.showerror("小畫家", f"無法開啟這個檔案：\n{exc}")
            return
        self.file_path = path
        self._refresh_canvas()

    def _save_file(self):
        path = self.file_path
        if not path:
            path = filedialog.asksaveasfilename(
                title="儲存圖片", defaultextension=".png", initialfile="未命名.png",
                filetypes=[("PNG 圖片", "*.png"), ("JPEG 圖片", "*.jpg"), ("BMP 圖片", "*.bmp")])
            if not path:
                return False
        try:
            self.doc.save(path)
        except Exception as exc:
            messagebox.showerror("小畫家", f"無法儲存：\n{exc}")
            return False
        self.file_path = path
        self._update_title()
        return True

    def _on_close(self):
        if self._confirm_discard():
            self.destroy()


if __name__ == "__main__":
    app = PaintApp()
    app.mainloop()
