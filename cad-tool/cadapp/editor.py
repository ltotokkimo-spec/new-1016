"""編輯核心：指令執行、座標輸入、鎖點、選取、復原/重做。

指令寫成 Python generator：每個 `yield Req(...)` 代表向使用者要一個輸入
（點、選取、物件、文字），編輯器把滑鼠或指令列輸入送回去。
"""
from __future__ import annotations

import io
import math
import re
import zlib
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import ezdxf
from ezdxf.math import Vec2

from . import geom, standards


@dataclass
class Req:
    kind: str                      # point / select / entity / string
    prompt: str
    base: Optional[Vec2] = None    # 拉線預覽與正交的基準點
    preview: Optional[Callable[[Vec2], list]] = None
    keywords: dict = field(default_factory=dict)   # {"C": "閉合"}
    allow_number: bool = False     # 允許直接輸入數字（半徑、角度、距離）
    types: tuple = ()              # entity 時可選的實體類型
    default: Any = None


GRAPHIC_ATTRIBS = ("layer", "color", "linetype", "lineweight", "ltscale", "true_color")

_num = r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?"
RE_XY = re.compile(rf"^\s*(@?)\s*({_num})\s*,\s*({_num})\s*$")
RE_POLAR = re.compile(rf"^\s*(@?)\s*({_num})\s*<\s*({_num})\s*$")
RE_NUM = re.compile(rf"^\s*({_num})\s*$")


class Editor:
    def __init__(self, win):
        self.win = win            # MainWindow：訊息、對話框
        self.view = None          # CadView
        self.doc = None
        self.selection: set[str] = set()
        self.cmd = None
        self.cmd_name = ""
        self.req: Optional[Req] = None
        self.last_cmd = ""
        self.last_point: Optional[Vec2] = None
        self.cursor = Vec2(0, 0)
        self.snap: Optional[tuple[Vec2, str]] = None
        self.ortho = False
        self.osnap = True
        self.osnap_modes = {geom.END, geom.MID, geom.CEN, geom.QUA, geom.INT, geom.PER}
        self.undo_stack: list[bytes] = []
        self.redo_stack: list[bytes] = []
        self._snapshot_taken = False
        self.dirty = False
        self.settings = {"text_height": 3.5, "fillet_r": 1.0, "chamfer_d1": 1.0, "chamfer_d2": 1.0,
                         "offset": 5.0, "hatch_scale": 1.0, "hatch_pattern": "ANSI31", "polygon_n": 6}
        from . import commands
        self.commands = commands

    # ------------------------------------------------------------ 文件
    def set_doc(self, doc, keep_view=False):
        self.cancel()
        self.doc = doc
        self.selection.clear()
        self.view.render_all(doc, keep_view=keep_view)
        if not keep_view:
            self.view.zoom_extents()
        self.win.on_doc_changed()

    @property
    def msp(self):
        return self.doc.modelspace()

    def entity(self, handle):
        if handle is None:
            return None
        e = self.doc.entitydb.get(handle)
        return e if e is not None and e.is_alive else None

    def selected_entities(self):
        return [e for e in (self.entity(h) for h in self.selection) if e is not None]

    @property
    def current_layer(self) -> str:
        name = self.doc.header.get("$CLAYER", "0")
        return name if name in self.doc.layers else "0"

    def set_current_layer(self, name):
        self.doc.header["$CLAYER"] = name

    @property
    def dimstyle(self) -> str:
        name = self.doc.header.get("$DIMSTYLE", "Standard")
        if name in self.doc.dimstyles:
            return name
        standards.ensure_standard(self.doc, "CNS")
        return standards.DIM_STYLE["CNS"]

    @property
    def textstyle(self) -> str:
        name = self.doc.header.get("$TEXTSTYLE", "Standard")
        return name if name in self.doc.styles else "Standard"

    def attribs(self, **extra) -> dict:
        d = {"layer": self.current_layer}
        d.update(extra)
        return d

    # ------------------------------------------------------------ 修改與復原
    def _snapshot(self) -> bytes:
        s = io.StringIO()
        self.doc.write(s)
        return zlib.compress(s.getvalue().encode("utf-8"), 1)

    def _restore(self, data: bytes):
        doc = ezdxf.read(io.StringIO(zlib.decompress(data).decode("utf-8")))
        self.doc = doc
        self.selection.clear()
        self.view.render_all(doc, keep_view=True)
        self.win.on_doc_changed(reset_title=False)

    def before_change(self):
        if not self._snapshot_taken:
            self.undo_stack.append(self._snapshot())
            del self.undo_stack[:-50]
            self.redo_stack.clear()
            self._snapshot_taken = True
        self.dirty = True
        self.win.update_title()

    def undo(self):
        if self.cmd is not None:
            self.cancel()
        if not self.undo_stack:
            self.msg("沒有可以復原的動作")
            return
        self.redo_stack.append(self._snapshot())
        self._restore(self.undo_stack.pop())
        self.dirty = True
        self.msg("已復原")

    def redo(self):
        if not self.redo_stack:
            self.msg("沒有可以重做的動作")
            return
        self.undo_stack.append(self._snapshot())
        self._restore(self.redo_stack.pop())
        self.dirty = True
        self.msg("已重做")

    def add(self, *entities):
        """實體已加入模型空間後呼叫：更新畫面。"""
        self.view.add_entities(entities)
        return entities[0] if len(entities) == 1 else entities

    def add_line(self, a, b, **kw):
        self.before_change()
        return self.add(self.msp.add_line(Vec2(a), Vec2(b), dxfattribs=self.attribs(**kw)))

    def delete(self, entities):
        if not entities:
            return
        self.before_change()
        hs = []
        for e in entities:
            if e.is_alive:
                hs.append(e.dxf.handle)
                self.msp.delete_entity(e)
        self.selection -= set(hs)
        self.view.remove_handles(hs)

    def modified(self, entities):
        self.view.refresh_entities([e for e in entities if e.is_alive])
        self.view.set_highlight(self.selection)

    def copy_attribs(self, e) -> dict:
        return {k: e.dxf.get(k) for k in GRAPHIC_ATTRIBS if e.dxf.hasattr(k)}

    def regen(self):
        self.view.render_all(self.doc, keep_view=True)
        self.view.set_highlight(self.selection)

    # ------------------------------------------------------------ 訊息
    def msg(self, text):
        self.win.cmdline.history(text)

    def _show_prompt(self):
        if self.req is None:
            self.win.cmdline.set_prompt("指令：")
            return
        p = self.req.prompt
        if self.req.keywords:
            p += " [" + "/".join(f"{v}({k})" for k, v in self.req.keywords.items()) + "]"
        if self.req.default is not None:
            d = self.req.default
            p += f" <{d:g}>" if isinstance(d, (int, float)) else f" <{d}>"
        self.win.cmdline.set_prompt(p + "：")

    # ------------------------------------------------------------ 指令流程
    def run(self, name: str):
        name = name.strip()
        if not name:
            return
        func = self.commands.lookup(name)
        if func is None:
            self.msg(f"未知的指令：{name}　（輸入 HELP 看指令一覽）")
            return
        if self.cmd is not None:
            self.cancel()
        self.msg(f"指令：{name.upper()}")
        self.cmd_name = func.__name__
        self.last_cmd = name
        self._snapshot_taken = False
        gen = func(self)
        if gen is None:  # 立即完成的指令
            self._finish()
            return
        self.cmd = gen
        self._advance(None, first=True)

    def _advance(self, value, first=False):
        try:
            req = next(self.cmd) if first else self.cmd.send(value)
            # 選取請求：若已經有預選物件就直接用
            while req.kind == "select" and self.selection and not getattr(req, "_asked", False):
                ents = self.selected_entities()
                if not ents:
                    break
                self.msg(f"使用已選取的 {len(ents)} 個物件")
                self.selection.clear()
                self.view.set_highlight(self.selection)
                req = self.cmd.send(ents)
            self.req = req
            if req.kind == "select":
                req._asked = True
            if req.base is not None:
                self.last_point = req.base
        except StopIteration:
            self._finish()
        except Exception as ex:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            self.msg(f"錯誤：{ex}")
            self._finish()
        self._update_snap()
        self._show_prompt()
        self.view.viewport().update()

    def _finish(self):
        self.cmd = None
        self.req = None
        self.cmd_name = ""
        self._snapshot_taken = False
        self.view.set_highlight(self.selection)
        self._show_prompt()
        self.win.refresh_properties()

    def cancel(self):
        if self.cmd is not None:
            try:
                self.cmd.close()
            except Exception:  # noqa: BLE001
                pass
            self.msg("*取消*")
        self.cmd = None
        self.req = None
        self._snapshot_taken = False
        if self.view is not None:
            self._show_prompt()
            self.view.viewport().update()

    def submit(self, text: str):
        """指令列按 Enter。"""
        raw = text
        text = text.strip()
        if self.req is None:
            if not text:
                if self.last_cmd:
                    self.run(self.last_cmd)
                return
            self.run(text)
            return
        req = self.req
        if text:
            self.msg(f"{req.prompt}：{text}")
        if req.kind == "string":
            self._advance(raw if raw else req.default)
            return
        if not text:
            self._advance(req.default if req.default is not None and req.kind == "point" and req.allow_number else None)
            return
        key = text.upper()
        if key in req.keywords:
            self._advance(key)
            return
        for k, label in req.keywords.items():  # 也接受中文選項名稱
            if text == label:
                self._advance(k)
                return
        if req.kind == "select":
            if key in ("ALL", "全部"):
                self._advance([e for e in self.msp])
            else:
                self.msg("請用滑鼠選取物件，按 Enter 結束選取")
            return
        if req.kind == "entity":
            self.msg("請用滑鼠點選物件")
            return
        # point
        v = self.parse_point(text, req)
        if v is None:
            self.msg("無法辨識的輸入。座標格式：x,y　@dx,dy　@距離<角度　或直接輸入距離")
            return
        if isinstance(v, Vec2):
            self.last_point = v
        self._advance(v)

    def parse_point(self, text: str, req: Req):
        base = self.last_point if self.last_point is not None else Vec2(0, 0)
        m = RE_XY.match(text)
        if m:
            v = Vec2(float(m.group(2)), float(m.group(3)))
            return base + v if m.group(1) else v
        m = RE_POLAR.match(text)
        if m:
            v = Vec2.from_deg_angle(float(m.group(3)), float(m.group(2)))
            return base + v if m.group(1) else v
        m = RE_NUM.match(text)
        if m:
            num = float(m.group(1))
            if req.allow_number:
                return num
            if req.base is not None:  # 直接距離輸入：沿游標方向
                d = self.effective_point() - req.base
                if d.magnitude < 1e-12:
                    d = Vec2(1, 0)
                return req.base + d.normalize(num)
        return None

    # ------------------------------------------------------------ 滑鼠
    def wants_point(self) -> bool:
        return self.req is not None and self.req.kind == "point"

    def wants_select(self) -> bool:
        return self.req is not None and self.req.kind in ("select", "entity")

    def wants_window(self) -> bool:
        return self.req is None or self.req.kind == "select"

    def effective_point(self) -> Vec2:
        if self.snap is not None:
            return self.snap[0]
        p = self.cursor
        if self.ortho and self.req is not None and self.req.base is not None:
            b = self.req.base
            d = p - b
            p = Vec2(p.x, b.y) if abs(d.x) >= abs(d.y) else Vec2(b.x, p.y)
        return p

    def _update_snap(self):
        self.snap = None
        if not (self.osnap and self.wants_point() and self.view is not None):
            return
        tol = 12 * self.view.world_per_px()
        ents = self.view.nearby_entities(self.cursor, 12)
        if not ents:
            return
        base = self.req.base if self.req else None
        cands = geom.snap_candidates(ents, self.cursor, self.osnap_modes, base)
        best, bestd = None, tol
        for p, kind in cands:
            d = p.distance(self.cursor)
            if kind == geom.NEA:
                d += tol * 0.5  # 最近點優先度最低
            if d <= bestd:
                best, bestd = (p, kind), d
        self.snap = best

    def on_mouse_move(self, w: Vec2):
        self.cursor = w
        self._update_snap()
        p = self.effective_point()
        self.win.show_coords(p)

    def on_click(self, w: Vec2, shift=False):
        self.cursor = w
        self._update_snap()
        if self.req is None:
            h = self.view.entity_at(w)
            if h is None:
                if not shift:
                    self.selection.clear()
            elif shift:
                self.selection.discard(h)
            else:
                self.selection.add(h)
            self.view.set_highlight(self.selection)
            self.win.refresh_properties()
            return
        if self.req.kind == "point":
            p = self.effective_point()
            self.last_point = p
            self._advance(p)
        elif self.req.kind == "select":
            h = self.view.entity_at(w)
            if h is not None:
                if shift:
                    self.selection.discard(h)
                else:
                    self.selection.add(h)
                self.view.set_highlight(self.selection)
                self._sel_msg()
        elif self.req.kind == "entity":
            h = self.view.entity_at(w)
            e = self.entity(h)
            if e is None:
                self.msg("沒有點到物件")
                return
            if self.req.types and e.dxftype() not in self.req.types:
                self.msg("這個指令不能用在 " + e.dxftype())
                return
            self._advance((e, w))

    def _sel_msg(self):
        self.win.cmdline.set_prompt(f"{self.req.prompt}（已選 {len(self.selection)} 個，Enter 完成）：")

    def on_window(self, handles, shift=False):
        if shift:
            self.selection -= set(handles)
        else:
            self.selection |= set(h for h in handles if not h.startswith("v"))
        self.view.set_highlight(self.selection)
        if self.req is not None and self.req.kind == "select":
            self._sel_msg()
        else:
            self.win.refresh_properties()

    def on_double_click(self, w):
        if self.req is None:
            e = self.entity(self.view.entity_at(w))
            if e is not None and e.dxftype() in ("TEXT", "MTEXT", "DIMENSION"):
                self.win.edit_text(e)

    def on_enter(self):
        """滑鼠右鍵或空白鍵 = Enter。"""
        if self.req is not None and self.req.kind == "select":
            ents = self.selected_entities()
            self.selection.clear()
            self.view.set_highlight(self.selection)
            self._advance(ents)
            return
        self.win.cmdline.submit()

    def on_key(self, ev):
        from PySide6 import QtCore as qc
        k = ev.key()
        if k == qc.Qt.Key_Escape:
            if self.cmd is not None:
                self.cancel()
            self.selection.clear()
            self.view.set_highlight(self.selection)
            self.win.refresh_properties()
            return
        if k in (qc.Qt.Key_Delete,) and self.req is None and self.selection:
            self.delete(self.selected_entities())
            self.win.refresh_properties()
            return
        if k in (qc.Qt.Key_Return, qc.Qt.Key_Enter):
            self.on_enter()
            return
        if k == qc.Qt.Key_Space and (self.req is None or self.req.kind != "string"):
            if not self.win.cmdline.text():
                self.on_enter()
                return
        self.win.cmdline.forward_key(ev)

    # ------------------------------------------------------------ 預覽
    def preview_primitives(self) -> list:
        if self.req is None:
            return []
        out = []
        p = self.effective_point()
        if self.req.preview is not None and self.req.kind == "point":
            try:
                out.extend(self.req.preview(p))
            except Exception:  # noqa: BLE001
                pass
        elif self.req.base is not None and self.req.kind == "point":
            out.append(("guide", self.req.base, p))
        return out

    def current_snap(self):
        return self.snap if self.wants_point() else None
