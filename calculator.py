"""
簡易計算機 - Tkinter GUI 版本
可用 PyInstaller 打包成單一 .exe 執行檔，免安裝雙擊即可開啟。
"""

import tkinter as tk

# ---------- 顏色設定 ----------
COLOR_BG = "#211f1d"
COLOR_SCREEN_BG = "#1a2b26"
COLOR_SCREEN_FG = "#eef6f0"
COLOR_SCREEN_SUB = "#7fae96"
COLOR_NUM = "#3a3733"
COLOR_NUM_HOVER = "#47433d"
COLOR_OP = "#b5502c"
COLOR_OP_HOVER = "#c25f39"
COLOR_FN = "#8a8478"
COLOR_FN_HOVER = "#97907f"
COLOR_EQ = "#2f5d62"
COLOR_EQ_HOVER = "#396d72"
COLOR_KEY_TEXT = "#f4f0e8"

FONT_SCREEN = ("Consolas", 30, "bold")
FONT_EXPR = ("Consolas", 12)
FONT_KEY = ("Consolas", 16, "bold")


class Calculator(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("計算機")
        self.geometry("320x460")
        self.resizable(False, False)
        self.configure(bg=COLOR_BG, padx=16, pady=16)

        # 狀態
        self.current = "0"
        self.previous = None
        self.operator = None
        self.just_evaluated = False
        self.fresh_operand = False  # 剛按完運算子、還沒輸入第二個數

        self._build_screen()
        self._build_keys()
        self._bind_keyboard()
        self._update_screen()

    # ---------- 畫面 ----------
    def _build_screen(self):
        screen_frame = tk.Frame(self, bg=COLOR_SCREEN_BG, padx=14, pady=10)
        screen_frame.pack(fill="x", pady=(0, 14))

        self.expr_var = tk.StringVar(value=" ")
        self.result_var = tk.StringVar(value="0")

        tk.Label(
            screen_frame, textvariable=self.expr_var, font=FONT_EXPR,
            bg=COLOR_SCREEN_BG, fg=COLOR_SCREEN_SUB, anchor="e", justify="right",
        ).pack(fill="x")

        tk.Label(
            screen_frame, textvariable=self.result_var, font=FONT_SCREEN,
            bg=COLOR_SCREEN_BG, fg=COLOR_SCREEN_FG, anchor="e", justify="right",
        ).pack(fill="x")

    def _build_keys(self):
        keys_frame = tk.Frame(self, bg=COLOR_BG)
        keys_frame.pack(fill="both", expand=True)

        for col in range(4):
            keys_frame.columnconfigure(col, weight=1, uniform="col")
        for row in range(5):
            keys_frame.rowconfigure(row, weight=1, uniform="row")

        # (文字, 動作, 顏色, 位置row, 位置col, 跨欄, 跨列)
        layout = [
            ("AC", ("clear", None), COLOR_FN, 0, 0, 1, 1),
            ("⌫", ("backspace", None), COLOR_FN, 0, 1, 1, 1),
            ("%", ("percent", None), COLOR_FN, 0, 2, 1, 1),
            ("÷", ("op", "÷"), COLOR_OP, 0, 3, 1, 1),

            ("7", ("num", "7"), COLOR_NUM, 1, 0, 1, 1),
            ("8", ("num", "8"), COLOR_NUM, 1, 1, 1, 1),
            ("9", ("num", "9"), COLOR_NUM, 1, 2, 1, 1),
            ("×", ("op", "×"), COLOR_OP, 1, 3, 1, 1),

            ("4", ("num", "4"), COLOR_NUM, 2, 0, 1, 1),
            ("5", ("num", "5"), COLOR_NUM, 2, 1, 1, 1),
            ("6", ("num", "6"), COLOR_NUM, 2, 2, 1, 1),
            ("−", ("op", "−"), COLOR_OP, 2, 3, 1, 1),

            ("1", ("num", "1"), COLOR_NUM, 3, 0, 1, 1),
            ("2", ("num", "2"), COLOR_NUM, 3, 1, 1, 1),
            ("3", ("num", "3"), COLOR_NUM, 3, 2, 1, 1),
            ("+", ("op", "+"), COLOR_OP, 3, 3, 1, 1),

            ("0", ("num", "0"), COLOR_NUM, 4, 0, 2, 1),
            (".", ("decimal", None), COLOR_NUM, 4, 2, 1, 1),
            ("=", ("equals", None), COLOR_EQ, 4, 3, 1, 1),
        ]

        for text, action, color, r, c, colspan, rowspan in layout:
            btn = tk.Button(
                keys_frame, text=text, font=FONT_KEY,
                bg=color, fg=COLOR_KEY_TEXT, activeforeground=COLOR_KEY_TEXT,
                bd=0, relief="flat", cursor="hand2",
                command=lambda a=action: self._handle_action(a),
            )
            btn.grid(
                row=r, column=c, columnspan=colspan, rowspan=rowspan,
                sticky="nsew", padx=5, pady=5,
            )
            self._add_hover_effect(btn, color)

    def _add_hover_effect(self, btn, base_color):
        hover_map = {
            COLOR_NUM: COLOR_NUM_HOVER,
            COLOR_OP: COLOR_OP_HOVER,
            COLOR_FN: COLOR_FN_HOVER,
            COLOR_EQ: COLOR_EQ_HOVER,
        }
        hover_color = hover_map.get(base_color, base_color)
        btn.bind("<Enter>", lambda e: btn.config(bg=hover_color))
        btn.bind("<Leave>", lambda e: btn.config(bg=base_color))

    # ---------- 鍵盤支援 ----------
    def _bind_keyboard(self):
        self.bind("<Key>", self._on_key_press)

    def _on_key_press(self, event):
        key = event.char
        if key.isdigit():
            self._input_number(key)
        elif key == ".":
            self._input_decimal()
        elif key == "+":
            self._choose_operator("+")
        elif key == "-":
            self._choose_operator("−")
        elif key == "*":
            self._choose_operator("×")
        elif key == "/":
            self._choose_operator("÷")
        elif key in ("\r", "="):
            self._equals()
        elif event.keysym == "BackSpace":
            self._backspace()
        elif event.keysym == "Escape":
            self._clear_all()
        elif key == "%":
            self._percent()

    # ---------- 動作分派 ----------
    def _handle_action(self, action):
        kind, value = action
        if kind == "num":
            self._input_number(value)
        elif kind == "decimal":
            self._input_decimal()
        elif kind == "op":
            self._choose_operator(value)
        elif kind == "equals":
            self._equals()
        elif kind == "clear":
            self._clear_all()
        elif kind == "backspace":
            self._backspace()
        elif kind == "percent":
            self._percent()

    # ---------- 核心邏輯 ----------
    def _format_number(self, num_str):
        if num_str in ("", "Error"):
            return num_str
        negative = num_str.startswith("-")
        body = num_str[1:] if negative else num_str
        if "." in body:
            int_part, dec_part = body.split(".", 1)
        else:
            int_part, dec_part = body, None
        int_part = int_part or "0"
        with_commas = "{:,}".format(int(int_part))
        out = ("-" if negative else "") + with_commas
        if dec_part is not None:
            out += "." + dec_part
        return out

    def _update_screen(self):
        self.result_var.set(self._format_number(self.current))
        if self.operator and self.previous is not None:
            self.expr_var.set(f"{self._format_number(self.previous)} {self.operator}")
        else:
            self.expr_var.set(" ")

    def _input_number(self, digit):
        if self.just_evaluated or self.fresh_operand or self.current == "Error":
            self.current = digit
            self.just_evaluated = False
            self.fresh_operand = False
        elif self.current == "0":
            self.current = digit
        else:
            if len(self.current.replace("-", "").replace(".", "")) >= 12:
                return
            self.current += digit
        self._update_screen()

    def _input_decimal(self):
        if self.just_evaluated or self.fresh_operand or self.current == "Error":
            self.current = "0."
            self.just_evaluated = False
            self.fresh_operand = False
        elif "." not in self.current:
            self.current += "."
        self._update_screen()

    def _compute(self, a, b, op):
        a, b = float(a), float(b)
        if op == "÷":
            if b == 0:
                return None
            return a / b
        if op == "×":
            return a * b
        if op == "−":
            return a - b
        if op == "+":
            return a + b
        return b

    def _trim_result(self, num):
        return round(num, 10)

    def _choose_operator(self, op):
        if self.current == "Error":
            return
        # 連按運算子時只替換運算子，不拿 0 去算
        if self.fresh_operand:
            self.operator = op
            self._update_screen()
            return
        if self.operator and self.previous is not None and not self.just_evaluated:
            result = self._compute(self.previous, self.current, self.operator)
            if result is None:
                self._show_error()
                return
            self.previous = self._num_to_str(self._trim_result(result))
        else:
            self.previous = self.current
        self.operator = op
        self.just_evaluated = False
        self.fresh_operand = True
        self.current = self.previous
        self._update_screen()

    def _num_to_str(self, num):
        if isinstance(num, str):
            return num
        if num == int(num):
            return str(int(num))
        return str(num)

    def _equals(self):
        if self.operator is None or self.previous is None:
            return
        result = self._compute(self.previous, self.current, self.operator)
        if result is None:
            self._show_error()
            return
        self.current = self._num_to_str(self._trim_result(result))
        self.operator = None
        self.previous = None
        self.just_evaluated = True
        self.fresh_operand = False
        self._update_screen()

    def _show_error(self):
        self.current = "Error"
        self.operator = None
        self.previous = None
        self.just_evaluated = True
        self.fresh_operand = False
        self._update_screen()

    def _clear_all(self):
        self.current = "0"
        self.previous = None
        self.operator = None
        self.just_evaluated = False
        self.fresh_operand = False
        self._update_screen()

    def _backspace(self):
        if self.just_evaluated or self.current == "Error":
            self._clear_all()
            return
        if self.fresh_operand:
            return
        if len(self.current) <= 1 or (len(self.current) == 2 and self.current.startswith("-")):
            self.current = "0"
        else:
            self.current = self.current[:-1]
        self._update_screen()

    def _percent(self):
        if self.current == "Error":
            return
        self.fresh_operand = False
        self.current = self._num_to_str(self._trim_result(float(self.current) / 100))
        self._update_screen()


if __name__ == "__main__":
    app = Calculator()
    app.mainloop()
