"""paint.py 繪圖邏輯測試（不需要開視窗，Windows / Linux 都能跑）。"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from paint import PaintDocument, hex_to_rgb, normalize_box, rgb_to_hex  # noqa: E402

WHITE = (255, 255, 255)
RED = (237, 28, 36)
BLUE = (0, 162, 232)


def px(doc, x, y):
    return doc.image.getpixel((x, y))


class TestHelpers(unittest.TestCase):
    def test_color_convert(self):
        self.assertEqual(hex_to_rgb("#ed1c24"), RED)
        self.assertEqual(rgb_to_hex(RED), "#ed1c24")

    def test_normalize_box(self):
        self.assertEqual(normalize_box((50, 60), (10, 20)), (10, 20, 50, 60))
        self.assertEqual(normalize_box((10, 10), (40, 20), square=True), (10, 10, 40, 40))
        self.assertEqual(normalize_box((50, 50), (40, 10), square=True), (10, 10, 50, 50))


class TestDrawing(unittest.TestCase):
    def setUp(self):
        self.doc = PaintDocument(200, 100)

    def test_starts_white_and_clean(self):
        self.assertEqual(px(self.doc, 0, 0), WHITE)
        self.assertEqual(self.doc.size, (200, 100))
        self.assertFalse(self.doc.dirty)

    def test_pen_stroke(self):
        self.doc.stroke([(10, 50), (100, 50)], "#ed1c24", 6)
        self.assertEqual(px(self.doc, 55, 50), RED)
        self.assertEqual(px(self.doc, 55, 52), RED)
        self.assertEqual(px(self.doc, 55, 70), WHITE)
        self.assertTrue(self.doc.dirty)

    def test_single_click_draws_dot(self):
        self.doc.stroke([(30, 30)], "#000000", 10)
        self.assertEqual(px(self.doc, 30, 30), (0, 0, 0))
        self.assertEqual(px(self.doc, 33, 30), (0, 0, 0))

    def test_eraser_is_white_stroke(self):
        self.doc.rect((0, 0), (199, 99), "#000000", 1, filled=True)
        self.doc.stroke([(20, 50), (80, 50)], "#ffffff", 10)
        self.assertEqual(px(self.doc, 50, 50), WHITE)
        self.assertEqual(px(self.doc, 50, 80), (0, 0, 0))

    def test_line(self):
        self.doc.line((0, 0), (99, 99), "#000000", 3)
        self.assertEqual(px(self.doc, 50, 50), (0, 0, 0))

    def test_rect_outline_and_filled(self):
        self.doc.rect((20, 20), (80, 80), "#ed1c24", 2)
        self.assertEqual(px(self.doc, 20, 50), RED)
        self.assertEqual(px(self.doc, 50, 50), WHITE)
        self.doc.rect((100, 20), (160, 80), "#00a2e8", 2, filled=True)
        self.assertEqual(px(self.doc, 130, 50), BLUE)

    def test_oval(self):
        self.doc.oval((20, 20), (80, 80), "#ed1c24", 2, filled=True)
        self.assertEqual(px(self.doc, 50, 50), RED)
        self.assertEqual(px(self.doc, 21, 21), WHITE)  # 圓外的角落

    def test_fill_bucket_stays_inside_shape(self):
        self.doc.rect((20, 20), (80, 80), "#000000", 2)
        self.assertTrue(self.doc.fill((50, 50), "#00a2e8"))
        self.assertEqual(px(self.doc, 50, 50), BLUE)
        self.assertEqual(px(self.doc, 150, 50), WHITE)
        self.assertEqual(px(self.doc, 20, 50), (0, 0, 0))

    def test_fill_same_color_does_nothing(self):
        self.assertFalse(self.doc.fill((5, 5), "#ffffff"))
        self.assertFalse(self.doc.can_undo())

    def test_fill_outside_canvas_ignored(self):
        self.assertFalse(self.doc.fill((500, 5), "#000000"))

    def test_picker(self):
        self.doc.rect((0, 0), (10, 10), "#ed1c24", 1, filled=True)
        self.assertEqual(self.doc.pick((5, 5)), "#ed1c24")
        self.assertIsNone(self.doc.pick((-1, 5)))


class TestHistory(unittest.TestCase):
    def setUp(self):
        self.doc = PaintDocument(100, 100)

    def test_undo_redo(self):
        self.doc.rect((0, 0), (99, 99), "#ed1c24", 1, filled=True)
        self.assertEqual(px(self.doc, 50, 50), RED)
        self.assertTrue(self.doc.undo())
        self.assertEqual(px(self.doc, 50, 50), WHITE)
        self.assertTrue(self.doc.redo())
        self.assertEqual(px(self.doc, 50, 50), RED)

    def test_new_drawing_clears_redo(self):
        self.doc.line((0, 0), (99, 99), "#000000", 1)
        self.doc.undo()
        self.doc.line((0, 99), (99, 0), "#000000", 1)
        self.assertFalse(self.doc.can_redo())

    def test_nothing_to_undo(self):
        self.assertFalse(self.doc.undo())
        self.assertFalse(self.doc.redo())

    def test_clear_is_undoable(self):
        self.doc.rect((0, 0), (99, 99), "#000000", 1, filled=True)
        self.doc.clear()
        self.assertEqual(px(self.doc, 50, 50), WHITE)
        self.doc.undo()
        self.assertEqual(px(self.doc, 50, 50), (0, 0, 0))

    def test_history_limit(self):
        for i in range(60):
            self.doc.line((0, i), (99, i), "#000000", 1)
        self.assertLessEqual(len(self.doc.undo_stack), 40)


class TestFiles(unittest.TestCase):
    def test_save_and_load(self):
        doc = PaintDocument(120, 80)
        doc.rect((10, 10), (50, 50), "#00a2e8", 1, filled=True)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "畫.png")
            doc.save(path)
            self.assertFalse(doc.dirty)
            other = PaintDocument()
            other.load(path)
            self.assertEqual(other.size, (120, 80))
            self.assertEqual(px(other, 30, 30), BLUE)
            self.assertTrue(other.undo())  # 開檔前的空白畫布可以復原回來
            self.assertEqual(other.size, (800, 520))


if __name__ == "__main__":
    unittest.main()
