"""繪圖區：顯示 DXF、縮放平移、點選、框選、預覽、鎖點標記。"""
from __future__ import annotations

import math
from typing import Optional

from PySide6 import QtCore as qc, QtGui as qg, QtWidgets as qw
from ezdxf.math import Vec2
from ezdxf.addons.drawing import Frontend, RenderContext
from ezdxf.addons.drawing.config import Configuration, BackgroundPolicy, ColorPolicy, LineweightPolicy
from ezdxf.addons.drawing.pyqt import PyQtBackend, CorrespondingDXFEntity, CorrespondingDXFParentStack

from . import geom

ROLE_TOP = qc.Qt.UserRole + 10   # 頂層實體 handle
ROLE_PEN = qc.Qt.UserRole + 11   # 原本的畫筆（標示選取後還原用）

HILITE = qg.QColor("#3fa9ff")
PREVIEW = qg.QColor("#f0f0f0")
SNAP_COLOR = qg.QColor("#ffcc00")


def qpt(v) -> qc.QPointF:
    return qc.QPointF(v[0], v[1])


class CadView(qw.QGraphicsView):
    def __init__(self, editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        self.setScene(qw.QGraphicsScene(self))
        self.setRenderHints(qg.QPainter.Antialiasing | qg.QPainter.TextAntialiasing)
        self.setHorizontalScrollBarPolicy(qc.Qt.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(qc.Qt.ScrollBarAlwaysOff)
        self.setTransformationAnchor(qw.QGraphicsView.NoAnchor)
        self.setResizeAnchor(qw.QGraphicsView.AnchorViewCenter)
        self.setViewportUpdateMode(qw.QGraphicsView.MinimalViewportUpdate)
        self.setMouseTracking(True)
        self.setCursor(qc.Qt.BlankCursor)
        self.setFocusPolicy(qc.Qt.StrongFocus)
        self.setTransform(qg.QTransform.fromScale(1, -1))
        self.dark = True
        self.doc = None
        self.frontend: Optional[Frontend] = None
        self.items_by_handle: dict[str, list] = {}
        self.cursor_px: Optional[qc.QPoint] = None
        self._pan_start: Optional[qc.QPoint] = None
        self._press_px: Optional[qc.QPoint] = None
        self._band: Optional[tuple[qc.QPointF, qc.QPointF]] = None
        self._last_dirty = qg.QRegion()

    # ------------------------------------------------------------ 繪製
    def config(self) -> Configuration:
        return Configuration(
            background_policy=BackgroundPolicy.CUSTOM if self.dark else BackgroundPolicy.WHITE,
            custom_bg_color="#1e2329",
            color_policy=ColorPolicy.COLOR if self.dark else ColorPolicy.COLOR_NEGATIVE,
            lineweight_policy=LineweightPolicy.RELATIVE,
            lineweight_scaling=0.8,
        )

    def render_all(self, doc, keep_view=True):
        self.doc = doc
        old = self.transform() if keep_view else None
        center = self.mapToScene(self.viewport().rect().center()) if keep_view else None
        scene = self.scene()
        scene.clear()
        self.items_by_handle.clear()
        backend = PyQtBackend(scene)
        self.frontend = Frontend(RenderContext(doc), backend, config=self.config())
        self.frontend.draw_layout(doc.modelspace(), finalize=True)
        self._index_new_items()
        self._update_scene_rect()
        if old is not None and center is not None:
            self.setTransform(old)
            self.centerOn(center)

    def _update_scene_rect(self):
        r = self.scene().itemsBoundingRect()
        if r.isEmpty():
            r = qc.QRectF(-100, -100, 400, 300)
        size = max(r.width(), r.height(), 100)
        self.scene().setSceneRect(r.adjusted(-size * 20, -size * 20, size * 20, size * 20))

    def _index_new_items(self):
        for item in self.scene().items():
            if item.data(ROLE_TOP) is not None:
                continue
            ent = item.data(CorrespondingDXFEntity)
            stack = item.data(CorrespondingDXFParentStack) or ()
            top = stack[0] if stack else ent
            h = getattr(getattr(top, "dxf", None), "handle", None) or f"v{id(top)}"
            item.setData(ROLE_TOP, h)
            self.items_by_handle.setdefault(h, []).append(item)

    def add_entities(self, ents):
        if self.frontend is None:
            return
        self.frontend.draw_entities([e for e in ents if e.is_alive])
        self._index_new_items()
        self.viewport().update()

    def remove_handles(self, handles):
        sc = self.scene()
        for h in handles:
            for it in self.items_by_handle.pop(h, []):
                sc.removeItem(it)
        self.viewport().update()

    def refresh_entities(self, ents):
        self.remove_handles([e.dxf.handle for e in ents])
        self.add_entities(ents)

    def set_highlight(self, handles: set):
        for h, items in self.items_by_handle.items():
            on = h in handles
            for it in items:
                if not hasattr(it, "pen"):
                    continue
                orig = it.data(ROLE_PEN)
                if on:
                    if orig is None:
                        it.setData(ROLE_PEN, qg.QPen(it.pen()))
                        p = qg.QPen(it.pen())
                        p.setColor(HILITE)
                        p.setStyle(qc.Qt.DashLine)
                        p.setCosmetic(True)
                        p.setWidthF(max(p.widthF(), 1.5))
                        it.setPen(p)
                elif orig is not None:
                    it.setPen(orig)
                    it.setData(ROLE_PEN, None)
        self.viewport().update()

    # ------------------------------------------------------------ 座標
    def px_to_world(self, p) -> Vec2:
        s = self.mapToScene(p)
        return Vec2(s.x(), s.y())

    def world_per_px(self) -> float:
        return 1.0 / max(abs(self.transform().m11()), 1e-12)

    def zoom_extents(self):
        r = self.scene().itemsBoundingRect()
        if r.isEmpty():
            return
        self.fit_rect(r)

    def fit_rect(self, r: qc.QRectF):
        vw, vh = self.viewport().width(), self.viewport().height()
        s = 0.92 * min(vw / max(r.width(), 1e-9), vh / max(r.height(), 1e-9))
        self.setTransform(qg.QTransform.fromScale(s, -s))
        self.centerOn(r.center())

    def zoom_at(self, factor: float, px: qc.QPoint):
        before = self.mapToScene(px)
        self.scale(factor, factor)
        after = self.mapToScene(px)
        self._pan_by_scene(after - before)

    def _pan_by_scene(self, d: qc.QPointF):
        # translate() 在 NoAnchor 下會改變捲軸；用 centerOn 保持穩定
        c = self.mapToScene(self.viewport().rect().center())
        self.centerOn(c - d)

    # ------------------------------------------------------------ 選取
    def _pick_items(self, world: Vec2, tol_px=6):
        tol = tol_px * self.world_per_px()
        rect = qc.QRectF(world.x - tol, world.y - tol, 2 * tol, 2 * tol)
        return self.scene().items(rect, qc.Qt.IntersectsItemBoundingRect), rect, tol

    def entity_at(self, world: Vec2, tol_px=6) -> Optional[str]:
        items, rect, tol = self._pick_items(world, tol_px)
        stroker = qg.QPainterPathStroker()
        stroker.setWidth(2 * tol)
        best, bestd = None, 1e30
        pt = qc.QPointF(world.x, world.y)
        for it in items:
            h = it.data(ROLE_TOP)
            if h is None:
                continue
            if isinstance(it, qw.QGraphicsPathItem):
                path = it.sceneTransform().map(it.path())
                filled = it.brush().style() != qc.Qt.NoBrush
                hit = path.intersects(rect) if filled else stroker.createStroke(path).contains(pt)
            else:
                hit = it.sceneBoundingRect().intersects(rect)
            if hit:
                d = (it.sceneBoundingRect().width() + it.sceneBoundingRect().height())
                if d < bestd:  # 優先選比較小的物件
                    best, bestd = h, d
        return best

    def entities_in_rect(self, a: qc.QPointF, b: qc.QPointF, crossing: bool) -> list[str]:
        rect = qc.QRectF(a, b).normalized()
        out = []
        for h, items in self.items_by_handle.items():
            if not items:
                continue
            br = items[0].sceneBoundingRect()
            for it in items[1:]:
                br = br.united(it.sceneBoundingRect())
            if crossing:
                if rect.intersects(br) and any(rect.intersects(it.sceneBoundingRect()) for it in items):
                    out.append(h)
            elif rect.contains(br):
                out.append(h)
        return out

    def nearby_entities(self, world: Vec2, tol_px=12):
        """鎖點用：游標附近的實體（包含圖塊、標註內部已轉成世界座標的子實體）。"""
        items, _, _ = self._pick_items(world, tol_px)
        seen, out = set(), []
        for it in items:
            e = it.data(CorrespondingDXFEntity)
            if e is None or id(e) in seen:
                continue
            seen.add(id(e))
            out.append(e)
        return out

    # ------------------------------------------------------------ 滑鼠鍵盤
    def wheelEvent(self, ev: qg.QWheelEvent):
        f = 1.2 if ev.angleDelta().y() > 0 else 1 / 1.2
        self.zoom_at(f, ev.position().toPoint())
        self.editor.on_mouse_move(self.px_to_world(ev.position().toPoint()))
        self.viewport().update()

    def mousePressEvent(self, ev: qg.QMouseEvent):
        if ev.button() == qc.Qt.MiddleButton:
            self._pan_start = ev.position().toPoint()
            self.setCursor(qc.Qt.ClosedHandCursor)
            return
        if ev.button() == qc.Qt.LeftButton:
            self._press_px = ev.position().toPoint()
            return
        if ev.button() == qc.Qt.RightButton:
            self.editor.on_enter()

    def mouseDoubleClickEvent(self, ev):
        if ev.button() == qc.Qt.MiddleButton:
            self.zoom_extents()
            return
        if ev.button() == qc.Qt.LeftButton:
            self.editor.on_double_click(self.px_to_world(ev.position().toPoint()))

    def mouseMoveEvent(self, ev: qg.QMouseEvent):
        p = ev.position().toPoint()
        if self._pan_start is not None:
            d = self.mapToScene(p) - self.mapToScene(self._pan_start)
            self._pan_start = p
            self._pan_by_scene(d)
            self.viewport().update()
            return
        self.cursor_px = p
        w = self.px_to_world(p)
        if self._press_px is not None and (p - self._press_px).manhattanLength() > 6 \
                and self.editor.wants_window():
            self._band = (self.mapToScene(self._press_px), self.mapToScene(p))
        self.editor.on_mouse_move(w)
        self.viewport().update()

    def mouseReleaseEvent(self, ev: qg.QMouseEvent):
        if ev.button() == qc.Qt.MiddleButton:
            self._pan_start = None
            self.setCursor(qc.Qt.BlankCursor)
            return
        if ev.button() == qc.Qt.LeftButton and self._press_px is not None:
            p = ev.position().toPoint()
            if self._band is not None:
                a, b = self._band
                crossing = p.x() < self._press_px.x()
                self._band = None
                self.editor.on_window(self.entities_in_rect(a, b, crossing),
                                      bool(ev.modifiers() & qc.Qt.ShiftModifier))
            else:
                self.editor.on_click(self.px_to_world(p), bool(ev.modifiers() & qc.Qt.ShiftModifier))
            self._press_px = None
            self.viewport().update()

    def leaveEvent(self, ev):
        self.cursor_px = None
        self.viewport().update()

    def keyPressEvent(self, ev: qg.QKeyEvent):
        self.editor.on_key(ev)

    # ------------------------------------------------------------ 前景：十字游標、預覽、鎖點
    def drawForeground(self, painter: qg.QPainter, rect: qc.QRectF):
        painter.save()
        fg = PREVIEW if self.dark else qg.QColor("#202020")

        def pen(color, style=qc.Qt.SolidLine, w=1.0):
            p = qg.QPen(color, w, style)
            p.setCosmetic(True)
            return p

        # 預覽
        for prim in self.editor.preview_primitives():
            kind = prim[0]
            painter.setPen(pen(fg, qc.Qt.DashLine if kind == "guide" else qc.Qt.SolidLine))
            painter.setBrush(qc.Qt.NoBrush)
            if kind in ("line", "guide"):
                painter.drawLine(qpt(prim[1]), qpt(prim[2]))
            elif kind == "poly":
                pts = [qpt(p) for p in prim[1]]
                if prim[2]:
                    painter.drawPolygon(qg.QPolygonF(pts))
                else:
                    painter.drawPolyline(qg.QPolygonF(pts))
            elif kind == "circle":
                c, r = prim[1], prim[2]
                painter.drawEllipse(qpt(c), r, r)
            elif kind == "arc":
                c, r, a1, a2 = prim[1:5]
                span = (a2 - a1) % math.tau or math.tau
                n = max(8, int(span / math.tau * 96))
                pts = [qpt(Vec2(c) + Vec2.from_angle(a1 + span * i / n, r)) for i in range(n + 1)]
                painter.drawPolyline(qg.QPolygonF(pts))
            elif kind == "items":
                handles, tr = prim[1], prim[2]
                painter.setPen(pen(HILITE))
                for h in handles:
                    for it in self.items_by_handle.get(h, []):
                        if isinstance(it, qw.QGraphicsPathItem):
                            painter.drawPath(tr.map(it.sceneTransform().map(it.path())))
            elif kind == "text":
                p, s, hgt = prim[1], prim[2], prim[3]
                painter.save()
                painter.translate(p[0], p[1])
                painter.scale(1, -1)
                f = qg.QFont("Microsoft JhengHei")
                f.setPixelSize(max(1, int(hgt)))
                painter.setFont(f)
                painter.setPen(pen(fg))
                painter.drawText(qc.QPointF(0, 0), s)
                painter.restore()

        # 框選
        if self._band is not None:
            a, b = self._band
            crossing = self.mapFromScene(b).x() < self.mapFromScene(a).x()
            color = qg.QColor(80, 200, 120) if crossing else qg.QColor(70, 130, 255)
            painter.setPen(pen(color, qc.Qt.DashLine if crossing else qc.Qt.SolidLine))
            fill = qg.QColor(color)
            fill.setAlpha(40)
            painter.setBrush(fill)
            painter.drawRect(qc.QRectF(a, b).normalized())

        # 以下用像素座標畫
        painter.resetTransform()
        snap = self.editor.current_snap()
        if snap is not None:
            sp = self.mapFromScene(qpt(snap[0]))
            painter.setPen(pen(SNAP_COLOR, w=2))
            painter.setBrush(qc.Qt.NoBrush)
            k = 6
            x, y = sp.x(), sp.y()
            kind = snap[1]
            if kind == geom.END:
                painter.drawRect(qc.QRectF(x - k, y - k, 2 * k, 2 * k))
            elif kind == geom.MID:
                painter.drawPolygon(qg.QPolygonF([qc.QPointF(x - k, y + k), qc.QPointF(x + k, y + k), qc.QPointF(x, y - k)]))
            elif kind == geom.CEN:
                painter.drawEllipse(qc.QPointF(x, y), k, k)
            elif kind == geom.QUA:
                painter.drawPolygon(qg.QPolygonF([qc.QPointF(x - k, y), qc.QPointF(x, y - k), qc.QPointF(x + k, y), qc.QPointF(x, y + k)]))
            elif kind == geom.INT:
                painter.drawLine(x - k, y - k, x + k, y + k)
                painter.drawLine(x - k, y + k, x + k, y - k)
            elif kind == geom.PER:
                painter.drawLine(x - k, y + k, x + k, y + k)
                painter.drawLine(x - k, y + k, x - k, y - k)
                painter.drawLine(x - k, y, x, y)
                painter.drawLine(x, y, x, y + k)
            else:
                painter.drawLine(x - k, y - k, x + k, y + k)
                painter.drawLine(x - k, y + k, x + k, y - k)
                painter.drawRect(qc.QRectF(x - k, y - k, 2 * k, 2 * k))
            f = painter.font()
            f.setPointSize(9)
            painter.setFont(f)
            painter.drawText(qc.QPointF(x + 10, y + 20), kind)

        if self.cursor_px is not None and self._pan_start is None:
            c = self.cursor_px
            vr = self.viewport().rect()
            painter.setPen(pen(fg if self.dark else qg.QColor("#404040")))
            if self.editor.wants_point():
                painter.drawLine(vr.left(), c.y(), vr.right(), c.y())
                painter.drawLine(c.x(), vr.top(), c.x(), vr.bottom())
            else:
                painter.drawLine(c.x() - 25, c.y(), c.x() + 25, c.y())
                painter.drawLine(c.x(), c.y() - 25, c.x(), c.y() + 25)
            if self.editor.wants_select() or not self.editor.wants_point():
                painter.drawRect(c.x() - 4, c.y() - 4, 8, 8)
        painter.restore()
