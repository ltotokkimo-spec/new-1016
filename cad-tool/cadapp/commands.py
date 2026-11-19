"""所有指令。每個指令是一個 generator：yield Req(...) 取得使用者輸入。"""
from __future__ import annotations

import math

from ezdxf.math import Vec2, Matrix44, arc_angle_span_deg
from PySide6.QtGui import QTransform

from . import geom, standards
from .editor import Req

REGISTRY: dict[str, callable] = {}
HELP: list[tuple[str, str, str]] = []   # (分類, 指令與簡寫, 說明)


def command(names: str, group: str, desc: str):
    def deco(fn):
        for n in names.split(","):
            REGISTRY[n.strip().upper()] = fn
        HELP.append((group, names.replace(",", " / "), desc))
        return fn
    return deco


def is_kw(value, key: str) -> bool:
    """輸入是不是某個選項（Vec2 不能直接和字串比較）。"""
    return isinstance(value, str) and value == key


def lookup(name: str):
    return REGISTRY.get(name.strip().upper())


# ---------------------------------------------------------------- 小工具
def arc3(p1: Vec2, p2: Vec2, p3: Vec2):
    """三點圓弧 → (圓心, 半徑, 起始角, 結束角)，弧度、逆時針。"""
    ax, ay, bx, by, cx, cy = p1.x, p1.y, p2.x, p2.y, p3.x, p3.y
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    if abs(d) < 1e-12:
        return None
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    c = Vec2(ux, uy)
    r = c.distance(p1)
    a1, a2, am = (p1 - c).angle, (p3 - c).angle, (p2 - c).angle
    if ((am - a1) % math.tau) > ((a2 - a1) % math.tau):
        a1, a2 = a2, a1
    return c, r, a1, a2


def items_preview(entities, tr: QTransform):
    return [("items", [e.dxf.handle for e in entities], tr)]


def q_translate(d: Vec2) -> QTransform:
    return QTransform.fromTranslate(d.x, d.y)


def q_rotate(b: Vec2, ang: float) -> QTransform:
    t = QTransform()
    t.translate(b.x, b.y)
    t.rotateRadians(ang)
    t.translate(-b.x, -b.y)
    return t


def q_scale(b: Vec2, s: float) -> QTransform:
    t = QTransform()
    t.translate(b.x, b.y)
    t.scale(s, s)
    t.translate(-b.x, -b.y)
    return t


def q_mirror(a: Vec2, b: Vec2) -> QTransform:
    th = (b - a).angle
    c2, s2 = math.cos(2 * th), math.sin(2 * th)
    # p' = a + M (p - a)
    dx = a.x - (c2 * a.x + s2 * a.y)
    dy = a.y - (s2 * a.x - c2 * a.y)
    return QTransform(c2, s2, s2, -c2, dx, dy)


def m_rotate(b: Vec2, ang: float) -> Matrix44:
    return Matrix44.chain(Matrix44.translate(-b.x, -b.y, 0), Matrix44.z_rotate(ang), Matrix44.translate(b.x, b.y, 0))


def m_scale(b: Vec2, s: float) -> Matrix44:
    return Matrix44.chain(Matrix44.translate(-b.x, -b.y, 0), Matrix44.scale(s, s, s), Matrix44.translate(b.x, b.y, 0))


def m_mirror(a: Vec2, b: Vec2) -> Matrix44:
    th = (b - a).angle
    return Matrix44.chain(Matrix44.translate(-a.x, -a.y, 0), Matrix44.z_rotate(-th), Matrix44.scale(1, -1, 1),
                          Matrix44.z_rotate(th), Matrix44.translate(a.x, a.y, 0))


def transform_all(ed, ents, m: Matrix44):
    ed.before_change()
    done = []
    for e in ents:
        try:
            e.transform(m)
            done.append(e)
        except Exception as ex:  # noqa: BLE001
            ed.msg(f"{e.dxftype()} 無法轉換：{ex}")
    ed.modified(done)


def copy_all(ed, ents, m: Matrix44):
    ed.before_change()
    new = []
    for e in ents:
        try:
            c = e.copy()
            ed.msp.add_entity(c)
            c.transform(m)
            new.append(c)
        except Exception as ex:  # noqa: BLE001
            ed.msg(f"{e.dxftype()} 無法複製：{ex}")
    ed.view.add_entities(new)
    return new


def fix_text_mirror(ents):
    """鏡射後讓文字保持可讀（同 AutoCAD MIRRTEXT=0）。"""
    for e in ents:
        if e.dxftype() == "TEXT":
            e.dxf.text_generation_flag = 0
            if e.dxf.hasattr("extrusion") and e.dxf.extrusion.z < 0:
                e.dxf.extrusion = (0, 0, 1)


# ================================================================ 繪圖
@command("LINE,L,直線", "繪圖", "直線（連續畫，C 閉合，U 退一步）")
def cmd_line(ed):
    p = yield Req("point", "指定第一點")
    if p is None:
        return
    pts, made = [p], []
    while True:
        kw = {"U": "退回"}
        if len(pts) > 2:
            kw["C"] = "閉合"
        last = pts[-1]
        q = yield Req("point", "指定下一點", base=last, keywords=kw,
                      preview=lambda c, last=last: [("line", last, c)])
        if q is None:
            return
        if is_kw(q, "C"):
            ed.add_line(pts[-1], pts[0])
            return
        if is_kw(q, "U"):
            if made:
                ed.delete([made.pop()])
                pts.pop()
            continue
        made.append(ed.add_line(last, q))
        pts.append(q)


@command("PLINE,PL,聚合線", "繪圖", "聚合線（C 閉合，U 退一步）")
def cmd_pline(ed):
    p = yield Req("point", "指定起點")
    if p is None:
        return
    pts = [p]
    closed = False
    while True:
        kw = {"U": "退回"}
        if len(pts) > 2:
            kw["C"] = "閉合"
        q = yield Req("point", "指定下一點", base=pts[-1], keywords=kw,
                      preview=lambda c: [("poly", pts + [c], False)])
        if q is None:
            break
        if is_kw(q, "C"):
            closed = True
            break
        if is_kw(q, "U"):
            if len(pts) > 1:
                pts.pop()
            continue
        pts.append(q)
    if len(pts) >= 2:
        ed.before_change()
        ed.add(ed.msp.add_lwpolyline(pts, close=closed, dxfattribs=ed.attribs()))


@command("RECTANG,REC,矩形", "繪圖", "矩形（第二點可輸入 @寬,高）")
def cmd_rect(ed):
    a = yield Req("point", "指定第一個角點")
    if a is None:
        return
    b = yield Req("point", "指定對角點（或輸入 @寬,高）", base=a,
                  preview=lambda c: [("poly", [a, Vec2(c.x, a.y), c, Vec2(a.x, c.y)], True)])
    if b is None or not isinstance(b, Vec2):
        return
    ed.before_change()
    ed.add(ed.msp.add_lwpolyline([a, Vec2(b.x, a.y), b, Vec2(a.x, b.y)], close=True, dxfattribs=ed.attribs()))


@command("CIRCLE,C,圓", "繪圖", "圓（圓心＋半徑，D 直徑，2P 兩點，3P 三點）")
def cmd_circle(ed):
    c = yield Req("point", "指定圓心", keywords={"2P": "兩點", "3P": "三點"})
    if c is None:
        return
    if is_kw(c, "2P"):
        a = yield Req("point", "直徑第一點")
        if a is None:
            return
        b = yield Req("point", "直徑第二點", base=a,
                      preview=lambda q: [("circle", a.lerp(q, 0.5), a.distance(q) / 2)])
        if not isinstance(b, Vec2):
            return
        center, r = a.lerp(b, 0.5), a.distance(b) / 2
    elif is_kw(c, "3P"):
        a = yield Req("point", "第一點")
        if a is None:
            return
        b = yield Req("point", "第二點", base=a)
        if b is None:
            return

        def pv(q):
            r3 = arc3(a, b, q)
            return [("circle", r3[0], r3[1])] if r3 else []
        q = yield Req("point", "第三點", preview=pv)
        r3 = arc3(a, b, q) if isinstance(q, Vec2) else None
        if r3 is None:
            return
        center, r = r3[0], r3[1]
    else:
        center = c
        r = yield Req("point", "指定半徑", base=c, allow_number=True, keywords={"D": "直徑"},
                      default=ed.settings.get("circle_r"),
                      preview=lambda q: [("circle", c, c.distance(q)), ("guide", c, q)])
        if r is None:
            return
        if is_kw(r, "D"):
            d = yield Req("point", "指定直徑", base=c, allow_number=True,
                          preview=lambda q: [("circle", c, c.distance(q) / 2)])
            if d is None:
                return
            r = (d if isinstance(d, float) else c.distance(d) * 2) / 2
        elif isinstance(r, Vec2):
            r = c.distance(r)
    if r <= 0:
        return
    ed.settings["circle_r"] = r
    ed.before_change()
    ed.add(ed.msp.add_circle(center, r, dxfattribs=ed.attribs()))


@command("ARC,A,圓弧", "繪圖", "圓弧（三點，或 C 圓心-起點-終點）")
def cmd_arc(ed):
    p1 = yield Req("point", "指定起點", keywords={"C": "圓心"})
    if p1 is None:
        return
    if is_kw(p1, "C"):
        c = yield Req("point", "指定圓心")
        if c is None:
            return
        s = yield Req("point", "指定起點", base=c)
        if s is None:
            return
        r = c.distance(s)
        a1 = (s - c).angle
        e = yield Req("point", "指定終點（逆時針）", base=c,
                      preview=lambda q: [("arc", c, r, a1, (q - c).angle)])
        if not isinstance(e, Vec2):
            return
        ed.before_change()
        ed.add(ed.msp.add_arc(c, r, math.degrees(a1), math.degrees((e - c).angle), dxfattribs=ed.attribs()))
        return
    p2 = yield Req("point", "指定第二點", base=p1)
    if p2 is None:
        return

    def pv(q):
        r3 = arc3(p1, p2, q)
        return [("arc", *r3)] if r3 else [("line", p1, q)]
    p3 = yield Req("point", "指定終點", preview=pv)
    r3 = arc3(p1, p2, p3) if isinstance(p3, Vec2) else None
    if r3 is None:
        return
    c, r, a1, a2 = r3
    ed.before_change()
    ed.add(ed.msp.add_arc(c, r, math.degrees(a1), math.degrees(a2), dxfattribs=ed.attribs()))


@command("POLYGON,POL,多邊形", "繪圖", "正多邊形（內接於圓，例如六角螺帽）")
def cmd_polygon(ed):
    n = yield Req("point", "邊數", allow_number=True, default=ed.settings["polygon_n"])
    if not isinstance(n, float) or n < 3:
        return
    n = int(n)
    ed.settings["polygon_n"] = n
    c = yield Req("point", "指定中心點")
    if c is None:
        return

    def verts(q):
        r = c.distance(q)
        a0 = (q - c).angle
        return [c + Vec2.from_angle(a0 + i * math.tau / n, r) for i in range(n)]
    q = yield Req("point", "指定頂點（或輸入外接圓半徑）", base=c, allow_number=True,
                  preview=lambda q: [("poly", verts(q), True)])
    if q is None:
        return
    if isinstance(q, float):
        q = c + Vec2(q, 0).rotate(math.pi / 2 if n % 2 else 0)
    ed.before_change()
    ed.add(ed.msp.add_lwpolyline(verts(q), close=True, dxfattribs=ed.attribs()))


@command("TEXT,T,DT,文字", "繪圖", "單行文字（支援中文；%%c=Ø  %%p=±  %%d=°）")
def cmd_text(ed):
    p = yield Req("point", "指定文字起點")
    if p is None:
        return
    h = yield Req("point", "文字高度", base=p, allow_number=True, default=ed.settings["text_height"])
    if h is None:
        h = ed.settings["text_height"]
    if isinstance(h, Vec2):
        h = p.distance(h)
    ed.settings["text_height"] = h
    a = yield Req("point", "旋轉角度", base=p, allow_number=True, default=0.0)
    if isinstance(a, Vec2):
        a = math.degrees((a - p).angle)
    a = a or 0.0
    s = yield Req("string", "輸入文字")
    if not s:
        return
    ed.before_change()
    t = ed.msp.add_text(s, height=h, rotation=a, dxfattribs=ed.attribs(style=ed.textstyle))
    t.set_placement(p)
    ed.add(t)


# ================================================================ 標註
def _dim_options(ed, opts, kws, prompt, preview):
    """標註位置與選項（文字、直徑、公差、配合）。回傳位置點或 None。"""
    while True:
        q = yield Req("point", prompt, keywords=kws, preview=preview)
        if q is None or isinstance(q, Vec2):
            return q
        if is_kw(q, "T"):
            s = yield Req("string", "標註文字（<> 代表量測值）", default="<>")
            opts["text"] = s or "<>"
        elif is_kw(q, "D"):
            opts["prefix"] = "%%c"
            ed.msg("已加上直徑符號 Ø")
        elif is_kw(q, "P"):
            up = yield Req("point", "上偏差（例如 0.02）", allow_number=True, default=0.0)
            lo = yield Req("point", "下偏差（例如 -0.01；直接 Enter 代表 ±上偏差）", allow_number=True)
            if isinstance(up, float):
                opts["tol"] = (up, None if not isinstance(lo, float) else lo)
        elif is_kw(q, "F"):
            s = yield Req("string", "配合公差（例如 H7、g6、H7/g6）")
            if s:
                opts["fit"] = s.strip()
        elif q in ("H", "V", "R"):
            opts["force"] = q


def _dim_text(opts) -> str:
    base = opts.get("text", "<>")
    if "prefix" in opts and not base.startswith(opts["prefix"]):
        base = opts["prefix"] + base
    if "fit" in opts:
        base += opts["fit"]
    return base


def _finish_dim(ed, ov, opts):
    if "tol" in opts:
        up, lo = opts["tol"]
        if lo is None:
            ov.set_tolerance(abs(up), hfactor=0.7)
        else:
            ov.set_tolerance(up, -lo, hfactor=0.7)
    ov.render()
    ed.add(ov.dimension)


DIM_KW = {"T": "文字", "D": "直徑Ø", "P": "公差", "F": "配合"}


def _linear_angle(p1, p2, loc, force=None):
    if is_kw(force, "H"):
        return 0.0
    if is_kw(force, "V"):
        return 90.0
    xmin, xmax = min(p1.x, p2.x), max(p1.x, p2.x)
    ymin, ymax = min(p1.y, p2.y), max(p1.y, p2.y)
    out_y = max(ymin - loc.y, loc.y - ymax, 0)
    out_x = max(xmin - loc.x, loc.x - xmax, 0)
    return 0.0 if out_y >= out_x else 90.0


@command("DIMLINEAR,DLI,線性標註", "標註", "線性標註（水平／垂直）")
def cmd_dimlinear(ed):
    p1 = yield Req("point", "第一條尺寸界線原點")
    if p1 is None:
        return
    p2 = yield Req("point", "第二條尺寸界線原點", base=p1)
    if p2 is None:
        return
    opts = {}

    def pv(q):
        ang = _linear_angle(p1, p2, q, opts.get("force"))
        if ang == 0:
            return [("line", Vec2(p1.x, q.y), Vec2(p2.x, q.y)), ("guide", p1, Vec2(p1.x, q.y)), ("guide", p2, Vec2(p2.x, q.y))]
        return [("line", Vec2(q.x, p1.y), Vec2(q.x, p2.y)), ("guide", p1, Vec2(q.x, p1.y)), ("guide", p2, Vec2(q.x, p2.y))]
    kws = dict(DIM_KW, H="水平", V="垂直")
    loc = yield from _dim_options(ed, opts, kws, "指定尺寸線位置", pv)
    if loc is None:
        return
    ed.before_change()
    ov = ed.msp.add_linear_dim(base=loc, p1=p1, p2=p2, angle=_linear_angle(p1, p2, loc, opts.get("force")),
                               text=_dim_text(opts), dimstyle=ed.dimstyle, dxfattribs=ed.attribs())
    _finish_dim(ed, ov, opts)


@command("DIMALIGNED,DAL,對齊標註", "標註", "對齊標註（斜邊實長）")
def cmd_dimaligned(ed):
    p1 = yield Req("point", "第一條尺寸界線原點")
    if p1 is None:
        return
    p2 = yield Req("point", "第二條尺寸界線原點", base=p1)
    if p2 is None:
        return
    opts = {}
    n = (p2 - p1).orthogonal().normalize()

    def dist(q):
        return (q - p1).dot(n)

    def pv(q):
        d = n * dist(q)
        return [("line", p1 + d, p2 + d), ("guide", p1, p1 + d), ("guide", p2, p2 + d)]
    loc = yield from _dim_options(ed, opts, dict(DIM_KW), "指定尺寸線位置", pv)
    if loc is None:
        return
    ed.before_change()
    ov = ed.msp.add_aligned_dim(p1=p1, p2=p2, distance=dist(loc), text=_dim_text(opts),
                                dimstyle=ed.dimstyle, dxfattribs=ed.attribs())
    _finish_dim(ed, ov, opts)


def _radial(ed, diameter: bool):
    r = yield Req("entity", "選取圓或圓弧", types=("CIRCLE", "ARC"))
    if r is None:
        return
    e, _ = r
    c, rad = Vec2(e.dxf.center), e.dxf.radius
    opts = {}

    def pv(q):
        d = (q - c).normalize(rad) if q.distance(c) > 1e-9 else Vec2(rad, 0)
        return [("line", c - d if diameter else c, q)]
    loc = yield from _dim_options(ed, opts, {"T": "文字", "P": "公差", "F": "配合"}, "指定標註位置", pv)
    if loc is None:
        return
    ed.before_change()
    style = ed.dimstyle
    if diameter:
        ov = ed.msp.add_diameter_dim(center=c, radius=rad, location=loc, text=_dim_text(opts),
                                     dimstyle=style, dxfattribs=ed.attribs())
    else:
        ov = ed.msp.add_radius_dim(center=c, radius=rad, location=loc, text=_dim_text(opts),
                                   dimstyle=style, dxfattribs=ed.attribs())
    _finish_dim(ed, ov, opts)


@command("DIMRADIUS,DRA,半徑標註", "標註", "半徑標註 R")
def cmd_dimradius(ed):
    yield from _radial(ed, False)


@command("DIMDIAMETER,DDI,直徑標註", "標註", "直徑標註 Ø")
def cmd_dimdiameter(ed):
    yield from _radial(ed, True)


@command("DIMANGULAR,DAN,角度標註", "標註", "角度標註（選兩條直線）")
def cmd_dimangular(ed):
    r1 = yield Req("entity", "選取第一條直線", types=("LINE",))
    if r1 is None:
        return
    r2 = yield Req("entity", "選取第二條直線", types=("LINE",))
    if r2 is None:
        return
    l1, l2 = r1[0], r2[0]
    opts = {}
    loc = yield from _dim_options(ed, opts, {"T": "文字", "P": "公差"}, "指定標註弧位置", None)
    if loc is None:
        return
    ed.before_change()
    from ezdxf.math import ConstructionLine
    ov = ed.msp.add_angular_dim_2l(
        base=loc, line1=(Vec2(l1.dxf.start), Vec2(l1.dxf.end)), line2=(Vec2(l2.dxf.start), Vec2(l2.dxf.end)),
        text=_dim_text(opts), dimstyle=ed.dimstyle, dxfattribs=ed.attribs())
    _finish_dim(ed, ov, opts)


@command("LEADER,LE,引線", "標註", "引線註記（例如 C1、4-Ø6 THRU）")
def cmd_leader(ed):
    p1 = yield Req("point", "指定箭頭位置")
    if p1 is None:
        return
    p2 = yield Req("point", "指定轉折點", base=p1)
    if p2 is None:
        return
    s = yield Req("string", "註記文字（%%c=Ø）")
    if not s:
        return
    ed.before_change()
    h = ed.settings["text_height"]
    right = p2.x >= p1.x
    width = h * 0.9 * len(s) + h
    p3 = p2 + Vec2(width if right else -width, 0)
    lead = ed.msp.add_leader([p1, p2, p3], dimstyle=ed.dimstyle, dxfattribs=ed.attribs())
    t = ed.msp.add_text(s, height=h, dxfattribs=ed.attribs(style=ed.textstyle))
    from ezdxf.enums import TextEntityAlignment
    t.set_placement(p2 + Vec2(h * 0.5 if right else -width + h * 0.5, h * 0.3), align=TextEntityAlignment.BOTTOM_LEFT)
    ed.add(lead, t)


# ================================================================ 修改
@command("ERASE,E,刪除", "修改", "刪除物件（也可選好後按 Delete）")
def cmd_erase(ed):
    ents = yield Req("select", "選取要刪除的物件")
    if ents:
        ed.delete(ents)
        ed.msg(f"已刪除 {len(ents)} 個物件")


@command("MOVE,M,移動", "修改", "移動")
def cmd_move(ed):
    ents = yield Req("select", "選取要移動的物件")
    if not ents:
        return
    b = yield Req("point", "指定基準點")
    if b is None:
        return
    t = yield Req("point", "指定目的點", base=b, preview=lambda q: items_preview(ents, q_translate(q - b)))
    if not isinstance(t, Vec2):
        return
    d = t - b
    transform_all(ed, ents, Matrix44.translate(d.x, d.y, 0))


@command("COPY,CO,CP,複製", "修改", "複製（可連續放置）")
def cmd_copy(ed):
    ents = yield Req("select", "選取要複製的物件")
    if not ents:
        return
    b = yield Req("point", "指定基準點")
    if b is None:
        return
    while True:
        t = yield Req("point", "指定目的點（Enter 結束）", base=b,
                      preview=lambda q: items_preview(ents, q_translate(q - b)))
        if not isinstance(t, Vec2):
            return
        d = t - b
        copy_all(ed, ents, Matrix44.translate(d.x, d.y, 0))


@command("ROTATE,RO,旋轉", "修改", "旋轉（輸入角度，逆時針為正）")
def cmd_rotate(ed):
    ents = yield Req("select", "選取要旋轉的物件")
    if not ents:
        return
    b = yield Req("point", "指定基準點")
    if b is None:
        return
    keep = False
    while True:
        a = yield Req("point", "旋轉角度", base=b, allow_number=True, keywords={"C": "複製"},
                      preview=lambda q: items_preview(ents, q_rotate(b, (q - b).angle)))
        if is_kw(a, "C"):
            keep = True
            ed.msg("旋轉後保留原物件")
            continue
        break
    if a is None:
        return
    ang = math.radians(a) if isinstance(a, float) else (a - b).angle
    m = m_rotate(b, ang)
    if keep:
        copy_all(ed, ents, m)
    else:
        transform_all(ed, ents, m)


@command("SCALE,SC,縮放", "修改", "比例縮放")
def cmd_scale(ed):
    ents = yield Req("select", "選取要縮放的物件")
    if not ents:
        return
    b = yield Req("point", "指定基準點")
    if b is None:
        return
    s = yield Req("point", "比例係數", base=b, allow_number=True,
                  preview=lambda q: items_preview(ents, q_scale(b, max(b.distance(q), 1e-9))))
    if s is None:
        return
    f = s if isinstance(s, float) else b.distance(s)
    if f <= 0:
        return
    transform_all(ed, ents, m_scale(b, f))


@command("MIRROR,MI,鏡射", "修改", "鏡射")
def cmd_mirror(ed):
    ents = yield Req("select", "選取要鏡射的物件")
    if not ents:
        return
    a = yield Req("point", "鏡射線第一點")
    if a is None:
        return
    b = yield Req("point", "鏡射線第二點", base=a,
                  preview=lambda q: items_preview(ents, q_mirror(a, q)) + [("guide", a, q)] if q.distance(a) > 1e-9 else [])
    if not isinstance(b, Vec2) or b.distance(a) < 1e-9:
        return
    k = yield Req("point", "刪除原物件？", keywords={"Y": "是", "N": "否"}, default="N")
    m = m_mirror(a, b)
    if is_kw(k, "Y"):
        transform_all(ed, ents, m)
        fix_text_mirror(ents)
        ed.modified(ents)
    else:
        new = copy_all(ed, ents, m)
        fix_text_mirror(new)
        ed.modified(new)


@command("OFFSET,O,偏移", "修改", "偏移複製（直線、圓、圓弧、聚合線）")
def cmd_offset(ed):
    d = yield Req("point", "偏移距離", allow_number=True, default=ed.settings["offset"])
    if d is None:
        return
    if isinstance(d, Vec2):
        d2 = yield Req("point", "第二點", base=d)
        if not isinstance(d2, Vec2):
            return
        d = d.distance(d2)
    ed.settings["offset"] = d
    while True:
        r = yield Req("entity", "選取要偏移的物件（Enter 結束）", types=("LINE", "CIRCLE", "ARC", "LWPOLYLINE"))
        if r is None:
            return
        e = r[0]
        side = yield Req("point", "點選要偏移的那一側")
        if not isinstance(side, Vec2):
            return
        res = geom.offset_entity(e, d, side)
        if res is None:
            ed.msg("這個物件無法偏移（含圓弧的聚合線暫不支援）")
            continue
        ed.before_change()
        at = ed.copy_attribs(e)
        if res[0] == "LINE":
            new = ed.msp.add_line(res[1], res[2], dxfattribs=at)
        elif res[0] == "CIRCLE":
            new = ed.msp.add_circle(res[1], res[2], dxfattribs=at)
        elif res[0] == "ARC":
            new = ed.msp.add_arc(res[1], res[2], e.dxf.start_angle, e.dxf.end_angle, dxfattribs=at)
        else:
            new = ed.msp.add_lwpolyline(res[1], close=res[2], dxfattribs=at)
        ed.add(new)


def _others(ed, e):
    h = e.dxf.handle
    return [o for o in ed.msp if o.dxf.handle != h and o.dxftype() in
            ("LINE", "CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "ELLIPSE", "SPLINE")]


@command("TRIM,TR,修剪", "修改", "修剪（點選要剪掉的那段，所有物件都當切割邊）")
def cmd_trim(ed):
    while True:
        r = yield Req("entity", "點選要剪掉的部分（Enter 結束）", types=("LINE", "CIRCLE", "ARC"))
        if r is None:
            return
        e, pick = r
        res = geom.trim_entity(e, pick, _others(ed, e))
        if res is None:
            continue
        kind, pieces = res
        at = ed.copy_attribs(e)
        ed.before_change()
        new = []
        for pc in pieces:
            if pc[0] == "LINE":
                new.append(ed.msp.add_line(pc[1], pc[2], dxfattribs=at))
            else:
                new.append(ed.msp.add_arc(pc[1], pc[2], math.degrees(pc[3]), math.degrees(pc[4]), dxfattribs=at))
        ed.delete([e])
        if new:
            ed.view.add_entities(new)


@command("EXTEND,EX,延伸", "修改", "延伸直線到最近的邊界")
def cmd_extend(ed):
    while True:
        r = yield Req("entity", "點選要延伸的直線（靠近要延伸的那端，Enter 結束）", types=("LINE",))
        if r is None:
            return
        e, pick = r
        res = geom.extend_line(e, pick, _others(ed, e))
        if res is None:
            ed.msg("找不到可以延伸到的邊界")
            continue
        ed.before_change()
        e.dxf.start, e.dxf.end = res[0], res[1]
        ed.modified([e])


def _poly_corner(e, pick1, pick2):
    """聚合線上兩個相鄰線段的共同頂點索引。"""
    pts = [Vec2(x, y) for x, y, *_ in e.get_points("xyb")]
    n = len(pts)
    segs = range(n if e.closed else n - 1)

    def nearest(p):
        return min(segs, key=lambda i: geom.distance_to(geom.Seg(pts[i], pts[(i + 1) % n]), p))
    i, j = nearest(pick1), nearest(pick2)
    if (i + 1) % n == j:
        return j
    if (j + 1) % n == i:
        return i
    return None


def _poly_round(e, idx, r=None, d1=None, d2=None):
    """在聚合線頂點 idx 做圓角（r）或倒角（d1,d2）。"""
    pts = list(e.get_points("xyseb"))
    n = len(pts)
    if not e.closed and (idx == 0 or idx == n - 1):
        return False
    P = Vec2(pts[idx][0], pts[idx][1])
    A = Vec2(pts[idx - 1][0], pts[idx - 1][1])
    B = Vec2(pts[(idx + 1) % n][0], pts[(idx + 1) % n][1])
    u1, u2 = (A - P).normalize(), (B - P).normalize()
    theta = math.acos(max(-1.0, min(1.0, u1.dot(u2))))
    if theta < 1e-6 or abs(theta - math.pi) < 1e-6:
        return False
    if r is not None:
        t = r / math.tan(theta / 2)
        T1, T2 = P + u1 * t, P + u2 * t
        sweep = math.pi - theta
        turn = (-u1).x * u2.y - (-u1).y * u2.x
        bulge = math.tan(sweep / 4) * (1 if turn > 0 else -1)
    else:
        T1, T2 = P + u1 * d1, P + u2 * d2
        bulge = 0.0
    x, y, s, ee, b = pts[idx]
    new = pts[:idx] + [(T1.x, T1.y, s, ee, bulge), (T2.x, T2.y, s, ee, 0.0)] + pts[idx + 1:]
    e.set_points(new, format="xyseb")
    return True


def _corner_cmd(ed, mode):
    while True:
        if is_kw(mode, "F"):
            kw = {"R": "半徑", "P": "整條聚合線"}
            prompt = f"選取第一個物件（半徑 = {ed.settings['fillet_r']:g}）"
        else:
            kw = {"D": "距離", "P": "整條聚合線"}
            prompt = f"選取第一個物件（距離 = {ed.settings['chamfer_d1']:g}, {ed.settings['chamfer_d2']:g}）"
        r1 = yield Req("entity", prompt, types=("LINE", "LWPOLYLINE"), keywords=kw)
        if r1 is None:
            return
        if is_kw(r1, "R"):
            v = yield Req("point", "圓角半徑", allow_number=True, default=ed.settings["fillet_r"])
            if isinstance(v, float):
                ed.settings["fillet_r"] = v
            continue
        if is_kw(r1, "D"):
            v1 = yield Req("point", "第一倒角距離", allow_number=True, default=ed.settings["chamfer_d1"])
            if isinstance(v1, float):
                ed.settings["chamfer_d1"] = v1
                v2 = yield Req("point", "第二倒角距離", allow_number=True, default=v1)
                ed.settings["chamfer_d2"] = v2 if isinstance(v2, float) else v1
            continue
        if is_kw(r1, "P"):
            r = yield Req("entity", "選取聚合線", types=("LWPOLYLINE",))
            if r is None:
                return
            e = r[0]
            ed.before_change()
            count = 0
            idx = len(list(e.get_points())) - 1
            while idx >= 0:
                if _poly_round(e, idx, ed.settings["fillet_r"] if is_kw(mode, "F") else None,
                               ed.settings["chamfer_d1"], ed.settings["chamfer_d2"]):
                    count += 1
                idx -= 1
            ed.modified([e])
            ed.msg(f"已處理 {count} 個角")
            return
        r2 = yield Req("entity", "選取第二個物件", types=("LINE", "LWPOLYLINE"))
        if r2 is None:
            return
        (e1, p1), (e2, p2) = r1, r2
        if e1.dxftype() == "LWPOLYLINE" or e2.dxftype() == "LWPOLYLINE":
            if e1 is not e2:
                ed.msg("聚合線請點同一條上相鄰的兩段（或先用 EXPLODE 分解）")
                continue
            idx = _poly_corner(e1, p1, p2)
            if idx is None:
                ed.msg("請點選相鄰的兩段")
                continue
            ed.before_change()
            ok = _poly_round(e1, idx, ed.settings["fillet_r"] if is_kw(mode, "F") else None,
                             ed.settings["chamfer_d1"], ed.settings["chamfer_d2"])
            ed.modified([e1])
            if not ok:
                ed.msg("這個角無法處理")
            return
        if is_kw(mode, "F"):
            res = geom.fillet(e1, p1, e2, p2, ed.settings["fillet_r"])
        else:
            res = geom.chamfer(e1, p1, e2, p2, ed.settings["chamfer_d1"], ed.settings["chamfer_d2"])
        if res is None:
            ed.msg("兩條線平行或無法處理")
            continue
        (a1, b1), (a2, b2), extra = res
        ed.before_change()
        e1.dxf.start, e1.dxf.end = a1, b1
        e2.dxf.start, e2.dxf.end = a2, b2
        ed.modified([e1, e2])
        at = ed.copy_attribs(e1)
        if extra is not None:
            if is_kw(mode, "F"):
                c, r, aa, bb = extra
                ed.add(ed.msp.add_arc(c, r, math.degrees(aa), math.degrees(bb), dxfattribs=at))
            else:
                ed.add(ed.msp.add_line(extra[0], extra[1], dxfattribs=at))
        return


@command("FILLET,F,圓角", "修改", "圓角（R 設定半徑，P 整條聚合線）")
def cmd_fillet(ed):
    yield from _corner_cmd(ed, "F")


@command("CHAMFER,CHA,倒角", "修改", "倒角（D 設定距離，P 整條聚合線）")
def cmd_chamfer(ed):
    yield from _corner_cmd(ed, "C")


@command("EXPLODE,X,分解", "修改", "分解圖塊、聚合線、標註")
def cmd_explode(ed):
    ents = yield Req("select", "選取要分解的物件")
    if not ents:
        return
    ed.before_change()
    n = 0
    for e in ents:
        if not hasattr(e, "explode"):
            continue
        h = e.dxf.handle
        try:
            new = list(e.explode())
        except Exception as ex:  # noqa: BLE001
            ed.msg(f"{e.dxftype()} 無法分解：{ex}")
            continue
        ed.view.remove_handles([h])
        ed.view.add_entities(new)
        n += 1
    ed.msg(f"已分解 {n} 個物件")


@command("CENTERMARK,CM,中心線", "機械", "圓的中心線（十字中心線，放在「中心線」圖層）")
def cmd_centermark(ed):
    standards.ensure_linetypes(ed.doc)
    if "中心線" not in ed.doc.layers:
        ed.doc.layers.add("中心線", color=1, linetype="CENTER", lineweight=25)
        ed.regen()
    while True:
        r = yield Req("entity", "選取圓或圓弧（Enter 結束）", types=("CIRCLE", "ARC"))
        if r is None:
            return
        e = r[0]
        c, rad = Vec2(e.dxf.center), e.dxf.radius
        ext = rad + max(2.0, rad * 0.15)
        ed.before_change()
        at = {"layer": "中心線"}
        ed.add(ed.msp.add_line(c - Vec2(ext, 0), c + Vec2(ext, 0), dxfattribs=at),
               ed.msp.add_line(c - Vec2(0, ext), c + Vec2(0, ext), dxfattribs=at))


@command("HATCH,H,剖面線", "機械", "剖面線（選封閉的聚合線或圓；S 比例，A 角度）")
def cmd_hatch(ed):
    ang = 0.0
    while True:
        ents = yield Req("select", f"選取封閉邊界（聚合線/圓）— 樣式 {ed.settings['hatch_pattern']} 比例 {ed.settings['hatch_scale']:g}")
        if ents is None or ents == []:
            return
        break
    paths = []
    for e in ents:
        t = e.dxftype()
        if is_kw(t, "CIRCLE"):
            paths.append(("circle", e))
        elif is_kw(t, "LWPOLYLINE") and (e.closed or Vec2(e[0][:2]).isclose(Vec2(e[-1][:2]))):
            paths.append(("poly", e))
    if not paths:
        ed.msg("沒有可用的封閉邊界。目前支援封閉聚合線與圓；用直線圍成的區域請先用 PEDIT/BOUNDARY（下一版）")
        return
    s = yield Req("point", "剖面線比例", allow_number=True, default=ed.settings["hatch_scale"])
    if isinstance(s, float) and s > 0:
        ed.settings["hatch_scale"] = s
    a = yield Req("point", "剖面線角度", allow_number=True, default=0.0)
    if isinstance(a, float):
        ang = a
    ed.before_change()
    layer = "剖面線" if "剖面線" in ed.doc.layers else ed.current_layer
    h = ed.msp.add_hatch(dxfattribs={"layer": layer})
    for kind, e in paths:
        if kind == "circle":
            ep = h.paths.add_edge_path()
            ep.add_arc(e.dxf.center, e.dxf.radius, 0, 360)
        else:
            h.paths.add_polyline_path(list(e.get_points("xyb")), is_closed=True)
    h.set_pattern_fill(ed.settings["hatch_pattern"], scale=ed.settings["hatch_scale"], angle=ang)
    ed.add(h)


@command("FRAME,圖框", "機械", "插入 CNS/ISO 圖框與標題欄")
def cmd_frame(ed):
    opt = ed.win.ask_frame()
    if not opt:
        return
    p = yield Req("point", "指定圖框左下角", default=None)
    if not isinstance(p, Vec2):
        p = Vec2(0, 0)
    ed.before_change()
    ents = standards.draw_frame(ed.doc, origin=p, **opt)
    ed.regen()
    ed.view.zoom_extents()
    ed.msg(f"已插入 {opt['paper']} {opt['std']} 圖框（{len(ents)} 個物件）")


# ================================================================ 查詢與其他
@command("DIST,DI,距離", "查詢", "量測兩點距離")
def cmd_dist(ed):
    a = yield Req("point", "第一點")
    if a is None:
        return
    b = yield Req("point", "第二點", base=a)
    if not isinstance(b, Vec2):
        return
    d = b - a
    ed.msg(f"距離 = {d.magnitude:.4f}，ΔX = {d.x:.4f}，ΔY = {d.y:.4f}，角度 = {math.degrees(d.angle) % 360:.2f}°")


@command("LIST,LI,查詢", "查詢", "顯示物件資訊")
def cmd_list(ed):
    ents = yield Req("select", "選取物件")
    for e in ents or []:
        t = e.dxftype()
        info = f"{t}  圖層={e.dxf.layer}"
        if is_kw(t, "LINE"):
            a, b = Vec2(e.dxf.start), Vec2(e.dxf.end)
            info += f"  長度={a.distance(b):.4f}  角度={math.degrees((b - a).angle) % 360:.2f}°"
        elif t in ("CIRCLE", "ARC"):
            info += f"  圓心=({e.dxf.center.x:.3f},{e.dxf.center.y:.3f})  半徑={e.dxf.radius:.4f}  直徑={2 * e.dxf.radius:.4f}"
            if is_kw(t, "ARC"):
                span = arc_angle_span_deg(e.dxf.start_angle, e.dxf.end_angle)
                info += f"  弧長={math.radians(span) * e.dxf.radius:.4f}"
        elif is_kw(t, "DIMENSION"):
            try:
                info += f"  量測值={e.get_measurement():.4f}"
            except Exception:  # noqa: BLE001
                pass
        ed.msg(info)


@command("UNDO,U,復原", "其他", "復原（Ctrl+Z）")
def cmd_undo(ed):
    ed.undo()


@command("REDO,重做", "其他", "重做（Ctrl+Y）")
def cmd_redo(ed):
    ed.redo()


@command("ZOOM,Z,縮放全部", "其他", "縮放到全部（也可以雙擊滑鼠中鍵）")
def cmd_zoom(ed):
    ed.view.zoom_extents()


@command("REGEN,RE,重生", "其他", "重新產生畫面")
def cmd_regen(ed):
    ed.regen()


@command("ORTHO,正交", "其他", "切換正交模式（F8）")
def cmd_ortho(ed):
    ed.win.toggle_ortho()


@command("OSNAP,OS,鎖點", "其他", "切換物件鎖點（F3）")
def cmd_osnap(ed):
    ed.win.toggle_osnap()


@command("HELP,?,說明", "其他", "顯示指令一覽")
def cmd_help(ed):
    ed.win.show_help()
