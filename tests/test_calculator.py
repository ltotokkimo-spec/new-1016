"""calculator.py 計算邏輯測試（不需要開視窗，Windows / Linux 都能跑）。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import calculator  # noqa: E402


class FakeVar:
    def __init__(self):
        self.value = None

    def set(self, value):
        self.value = value


def make_calc():
    calc = calculator.Calculator.__new__(calculator.Calculator)
    calc.result_var = FakeVar()
    calc.expr_var = FakeVar()
    calc._clear_all()
    return calc


def press(calc, keys):
    """用和按鈕相同的動作輸入，例如 "12+3=" 或 "5÷0=C"（C=AC、<=⌫）。"""
    for k in keys:
        if k.isdigit():
            calc._handle_action(("num", k))
        elif k == ".":
            calc._handle_action(("decimal", None))
        elif k in "+−×÷":
            calc._handle_action(("op", k))
        elif k == "=":
            calc._handle_action(("equals", None))
        elif k == "%":
            calc._handle_action(("percent", None))
        elif k == "C":
            calc._handle_action(("clear", None))
        elif k == "<":
            calc._handle_action(("backspace", None))
        else:
            raise ValueError(k)
    return calc.result_var.value


def run(keys):
    return press(make_calc(), keys)


class TestBasicMath(unittest.TestCase):
    def test_add(self):
        self.assertEqual(run("12+30="), "42")

    def test_subtract_negative(self):
        self.assertEqual(run("3−10="), "-7")

    def test_multiply(self):
        self.assertEqual(run("7×3="), "21")

    def test_divide(self):
        self.assertEqual(run("10÷4="), "2.5")

    def test_float_rounding(self):
        self.assertEqual(run("0.1+0.2="), "0.3")

    def test_chained(self):
        self.assertEqual(run("1+2+3="), "6")
        self.assertEqual(run("2×3−1="), "5")

    def test_continue_after_result(self):
        self.assertEqual(run("2+3=×4="), "20")

    def test_new_number_after_result(self):
        self.assertEqual(run("2+3=9"), "9")


class TestFormatting(unittest.TestCase):
    def test_thousands(self):
        self.assertEqual(run("1234567"), "1,234,567")

    def test_digit_limit(self):
        self.assertEqual(run("1234567890123"), "123,456,789,012")

    def test_decimal_only_once(self):
        self.assertEqual(run("1..5"), "1.5")

    def test_leading_decimal(self):
        self.assertEqual(run(".5"), "0.5")


class TestEditing(unittest.TestCase):
    def test_backspace(self):
        self.assertEqual(run("123<"), "12")
        self.assertEqual(run("5<"), "0")

    def test_percent(self):
        self.assertEqual(run("50%"), "0.5")

    def test_clear(self):
        self.assertEqual(run("12+3C"), "0")


class TestOperatorEdgeCases(unittest.TestCase):
    def test_repeated_operator_replaces(self):
        self.assertEqual(run("7+×3="), "21")
        self.assertEqual(run("5×÷5="), "1")

    def test_operator_shows_running_total(self):
        calc = make_calc()
        self.assertEqual(press(calc, "2+3+"), "5")
        self.assertEqual(calc.expr_var.value, "5 +")


class TestErrors(unittest.TestCase):
    def test_divide_by_zero(self):
        self.assertEqual(run("5÷0="), "Error")

    def test_operator_after_error_does_not_crash(self):
        self.assertEqual(run("5÷0=+"), "Error")

    def test_percent_after_error_does_not_crash(self):
        self.assertEqual(run("5÷0=%"), "Error")

    def test_number_after_error_starts_over(self):
        self.assertEqual(run("5÷0=4+1="), "5")

    def test_divide_by_zero_mid_chain(self):
        self.assertEqual(run("9÷0+"), "Error")

    def test_backspace_after_error_clears(self):
        self.assertEqual(run("5÷0=<"), "0")


if __name__ == "__main__":
    unittest.main()
