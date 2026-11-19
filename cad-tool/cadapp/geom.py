"""幾何運算：物件鎖點、交點、修剪、延伸、偏移、圓角、倒角。"""
from __future__ import annotations

import math
from typing import Iterable, Optional

from ezdxf.math import Vec2, ConstructionCircle, bulge_to_arc

TAU = math.tau

# 鎖點種類
END, MID, CEN, QUA, INT, PER, NEA, NOD, INS = "端點", "中點", "圓心", "四分點", "交點", "垂足", "最近點", "節點", "插入點"
ALL_SNAPS = (END, MID, CEN, QUA, INT, PER, NEA, NOD, INS)


# ---------------------------------------------------------------- 基本圖元
class Seg:
    __slots__ = ("a", "b")

    def __init__(self, a, b):
        self.a, self.b = Vec2(a), Vec2(b)


class Arc:
    """圓弧（逆時針從 a1 到 a2，單位弧度）；full=True 代表整圓。"""
    __slots__ = ("c", "r", "a1", "a2", "full")

    def __init__(self, c, r, a1=0.0, a2=TAU, full=False):
        self.c, self.r = Vec2(c), float(r)
        self.a1, self.a2, self.full = a1 % TAU, a2 % TAU, full

    def span(self) -> float:
        if self.full:
            return TAU
        s = (self.a2 - self.a1) % TAU
        return s if s > 1e-12 else TAU

    def contains_angle(self, ang: float, eps=1e-9) -> bool:
        if self.full:
            return True
        return ((ang - self.a1) % TAU) <= self.span() + eps

    def point(self, ang: float) -> Vec2:
        return self.c + Vec2.from_angle(ang, self.r)


def primitives(e) -> list:
    """把 DXF 實體拆成線段與圓弧（只處理 2D 常用實體）。"""
    t = e.dxftype()
    try:
        if t == "LINE":
            return [Seg(e.dxf.start, e.dxf.end)]
        if t == "CIRCLE":
            return [Arc(e.dxf.center, e.dxf.radius, full=True)]
        if t == "ARC":
            return [Arc(e.dxf.center, e.dxf.radius, math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle))]
        if t == "LWPOLYLINE":
            out = []
            pts = list(e.get_points("xyb"))
            n = len(pts)
            count = n if e.closed else n - 1
            for i in range(count):
                x1, y1, b = pts[i]
                x2, y2, _ = pts[(i + 1) % n]
                p1, p2 = Vec2(x1, y1), Vec2(x2, y2)
                if abs(b) > 1e-9:
                    c, sa, ea, r = bulge_to_arc(p1, p2, b)
                    out.append(Arc(c, r, sa, ea))
                else:
                    out.append(Seg(p1, p2))
            return out
        if t in ("POLYLINE", "SOLID", "TRACE", "3DFACE"):
            out = []
            for v in e.virtual_entities() if t == "POLYLINE" else []:
                out.extend(primitives(v))
            return out
        if t == "ELLIPSE" or t == "SPLINE":
            pts = list(e.flattening(0.05))
            return [Seg(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    except Exception:  # noqa: BLE001
        return []
    return []


# ---------------------------------------------------------------- 交點
def _seg_seg(s1: Seg, s2: Seg, extend1=False, extend2=False) -> list[Vec2]:
    d1, d2 = s1.b - s1.a, s2.b - s2.a
    den = d1.x * d2.y - d1.y * d2.x
    if abs(den) < 1e-12:
        return []
    w = s2.a - s1.a
    t = (w.x * d2.y - w.y * d2.x) / den
    u = (w.x * d1.y - w.y * d1.x) / den
    eps = 1e-9
    if (extend1 or -eps <= t <= 1 + eps) and (extend2 or -eps <= u <= 1 + eps):
        return [s1.a + d1 * t]
    return []


def _seg_arc(s: Seg, a: Arc, extend_seg=False) -> list[Vec2]:
    d = s.b - s.a
    f = s.a - a.c
    A = d.dot(d)
    if A < 1e-18:
        return []
    B = 2 * f.dot(d)
    C = f.dot(f) - a.r * a.r
    disc = B * B - 4 * A * C
    if disc < -1e-12:
        return []
    disc = math.sqrt(max(disc, 0.0))
    out = []
    for t in {(-B - disc) / (2 * A), (-B + disc) / (2 * A)}:
        if extend_seg or -1e-9 <= t <= 1 + 1e-9:
            p = s.a + d * t
            if a.contains_angle((p - a.c).angle):
                out.append(p)
    return out


def _arc_arc(a1: Arc, a2: Arc) -> list[Vec2]:
    try:
        pts = ConstructionCircle(a1.c, a1.r).intersect_circle(ConstructionCircle(a2.c, a2.r))
    except Exception:  # noqa: BLE001
        return []
    return [Vec2(p) for p in pts
            if a1.contains_angle((Vec2(p) - a1.c).angle) and a2.contains_angle((Vec2(p) - a2.c).angle)]


def intersect(p1, p2) -> list[Vec2]:
    if isinstance(p1, Seg) and isinstance(p2, Seg):
        return _seg_seg(p1, p2)
    if isinstance(p1, Seg):
        return _seg_arc(p1, p2)
    if isinstance(p2, Seg):
        return _seg_arc(p2, p1)
    return _arc_arc(p1, p2)


# ---------------------------------------------------------------- 鎖點
def snap_candidates(entities: Iterable, cursor: Vec2, modes: set, base: Optional[Vec2]) -> list[tuple[Vec2, str]]:
    cands: list[tuple[Vec2, str]] = []
    prims_all = []
    for e in entities:
        t = e.dxftype()
        try:
            if t in ("TEXT", "MTEXT", "INSERT") and INS in modes:
                cands.append((Vec2(e.dxf.insert), INS))
                continue
            if t == "POINT" and NOD in modes:
                cands.append((Vec2(e.dxf.location), NOD))
                continue
            if t == "ELLIPSE" and CEN in modes:
                cands.append((Vec2(e.dxf.center), CEN))
        except Exception:  # noqa: BLE001
            pass
        prims = primitives(e)
        prims_all.extend(prims)
        for p in prims:
            if isinstance(p, Seg):
                if END in modes:
                    cands += [(p.a, END), (p.b, END)]
                if MID in modes:
                    cands.append((p.a.lerp(p.b, 0.5), MID))
            else:
                if CEN in modes:
                    cands.append((p.c, CEN))
                if QUA in modes:
                    for k in range(4):
                        ang = k * math.pi / 2
                        if p.contains_angle(ang):
                            cands.append((p.point(ang), QUA))
                if not p.full:
                    if END in modes:
                        cands += [(p.point(p.a1), END), (p.point(p.a2), END)]
                    if MID in modes:
                        cands.append((p.point(p.a1 + p.span() / 2), MID))
    if INT in modes and len(prims_all) < 400:
        for i in range(len(prims_all)):
            for j in range(i + 1, len(prims_all)):
                for q in intersect(prims_all[i], prims_all[j]):
                    cands.append((q, INT))
    if PER in modes and base is not None:
        for p in prims_all:
            q = perpendicular_foot(p, base)
            if q is not None:
                cands.append((q, PER))
    if NEA in modes:
        for p in prims_all:
            q = nearest_on(p, cursor)
            if q is not None:
                cands.append((q, NEA))
    return cands


def perpendicular_foot(p, base: Vec2) -> Optional[Vec2]:
    if isinstance(p, Seg):
        d = p.b - p.a
        L = d.dot(d)
        if L < 1e-18:
            return None
        t = (base - p.a).dot(d) / L
        if -1e-9 <= t <= 1 + 1e-9:
            return p.a + d * t
        return None
    v = base - p.c
    if v.magnitude < 1e-12:
        return None
    ang = v.angle
    if p.contains_angle(ang):
        return p.point(ang)
    return None


def nearest_on(p, cur: Vec2) -> Optional[Vec2]:
    if isinstance(p, Seg):
        d = p.b - p.a
        L = d.dot(d)
        if L < 1e-18:
            return p.a
        t = min(1.0, max(0.0, (cur - p.a).dot(d) / L))
        return p.a + d * t
    v = cur - p.c
    if v.magnitude < 1e-12:
        return None
    ang = v.angle
    if p.contains_angle(ang):
        return p.point(ang)
    return None


def distance_to(p, cur: Vec2) -> float:
    q = nearest_on(p, cur)
    if q is None:
        if isinstance(p, Arc):
            return min(cur.distance(p.point(p.a1)), cur.distance(p.point(p.a2)))
        return 1e30
    return cur.distance(q)


# ---------------------------------------------------------------- 修剪 / 延伸
def _param_on_seg(s: Seg, q: Vec2) -> float:
    d = s.b - s.a
    return (q - s.a).dot(d) / d.dot(d)


def trim_entity(e, pick: Vec2, others: Iterable) -> Optional[tuple[str, list]]:
    """回傳 ('replace', [新實體屬性...]) 或 ('delete', [])；None 代表不能修剪。
    others：其他所有實體（作為切割邊界）。"""
    t = e.dxftype()
    if t not in ("LINE", "CIRCLE", "ARC"):
        return None
    me = primitives(e)[0]
    cuts = []
    for o in others:
        for p in primitives(o):
            cuts.extend(intersect(me, p))
    if t == "LINE":
        ts = sorted({round(_param_on_seg(me, q), 12) for q in cuts if 1e-9 < _param_on_seg(me, q) < 1 - 1e-9})
        tp = _param_on_seg(me, pick)
        lo = max([x for x in ts if x < tp], default=None)
        hi = min([x for x in ts if x > tp], default=None)
        if lo is None and hi is None:
            return ("delete", [])
        d = me.b - me.a
        pieces = []
        if lo is not None:
            pieces.append(("LINE", me.a, me.a + d * lo))
        if hi is not None:
            pieces.append(("LINE", me.a + d * hi, me.b))
        return ("replace", pieces)
    # 圓 / 圓弧
    angs = sorted({(q - me.c).angle % TAU for q in cuts})
    pa = (pick - me.c).angle % TAU
    if me.full:
        if len(angs) < 2:
            return ("delete", [])
        lo = max([a for a in angs if a < pa], default=angs[-1])
        hi = min([a for a in angs if a > pa], default=angs[0])
        if abs(hi - lo) < 1e-9:
            return None
        # 刪掉 lo→hi 那段，留下 hi→lo
        return ("replace", [("ARC", me.c, me.r, hi, lo)])
    rel = lambda a: (a - me.a1) % TAU  # noqa: E731
    span = me.span()
    inner = sorted(rel(a) for a in angs if 1e-9 < rel(a) < span - 1e-9)
    rp = rel(pa)
    lo = max([a for a in inner if a < rp], default=None)
    hi = min([a for a in inner if a > rp], default=None)
    if lo is None and hi is None:
        return ("delete", [])
    pieces = []
    if lo is not None:
        pieces.append(("ARC", me.c, me.r, me.a1, me.a1 + lo))
    if hi is not None:
        pieces.append(("ARC", me.c, me.r, me.a1 + hi, me.a2))
    return ("replace", pieces)


def extend_line(e, pick: Vec2, others: Iterable) -> Optional[tuple[Vec2, Vec2]]:
    """把直線靠近 pick 的那一端延伸到最近的邊界，回傳新的 (start, end)。"""
    if e.dxftype() != "LINE":
        return None
    s = Seg(e.dxf.start, e.dxf.end)
    from_end = pick.distance(s.b) < pick.distance(s.a)
    d = s.b - s.a
    best = None
    for o in others:
        for p in primitives(o):
            if isinstance(p, Seg):
                pts = _seg_seg(s, p, extend1=True)
            else:
                pts = _seg_arc(s, p, extend_seg=True)
            for q in pts:
                t = _param_on_seg(s, q)
                if from_end and t > 1 + 1e-9:
                    if best is None or t < best:
                        best = t
                elif not from_end and t < -1e-9:
                    if best is None or t > best:
                        best = t
    if best is None:
        return None
    q = s.a + d * best
    return (s.a, q) if from_end else (q, s.b)


# ---------------------------------------------------------------- 偏移
def offset_entity(e, dist: float, side: Vec2):
    """回傳 (dxftype, 參數) 或 None。"""
    t = e.dxftype()
    if t == "LINE":
        a, b = Vec2(e.dxf.start), Vec2(e.dxf.end)
        n = (b - a).orthogonal().normalize()
        if (side - a).dot(n) < 0:
            n = -n
        return ("LINE", a + n * dist, b + n * dist)
    if t in ("CIRCLE", "ARC"):
        c = Vec2(e.dxf.center)
        r = e.dxf.radius
        nr = r + dist if side.distance(c) > r else r - dist
        if nr <= 0:
            return None
        return (t, c, nr)
    if t == "LWPOLYLINE":
        pts = list(e.get_points("xyb"))
        if any(abs(b) > 1e-9 for *_, b in pts):
            return None
        from ezdxf.math import offset_vertices_2d
        verts = [Vec2(x, y) for x, y, _ in pts]
        # 判斷在哪一側：比較正負偏移後離點擊點的距離
        cand = []
        for sgn in (1, -1):
            try:
                v = list(offset_vertices_2d(verts, offset=sgn * dist, closed=e.closed))
            except Exception:  # noqa: BLE001
                return None
            dmin = min(distance_to(Seg(v[i], v[(i + 1) % len(v)]), side)
                       for i in range(len(v) if e.closed else len(v) - 1))
            cand.append((dmin, v))
        cand.sort(key=lambda x: x[0])
        return ("LWPOLYLINE", cand[0][1], e.closed)
    return None


# ---------------------------------------------------------------- 圓角 / 倒角
def corner(l1, pick1: Vec2, l2, pick2: Vec2):
    """兩條直線的交點與「保留方向」單位向量。"""
    s1 = Seg(l1.dxf.start, l1.dxf.end)
    s2 = Seg(l2.dxf.start, l2.dxf.end)
    pts = _seg_seg(s1, s2, extend1=True, extend2=True)
    if not pts:
        return None
    P = pts[0]
    u1 = (pick1 - P)
    u2 = (pick2 - P)
    if u1.magnitude < 1e-12 or u2.magnitude < 1e-12:
        return None
    d1 = (s1.b - s1.a).normalize()
    d2 = (s2.b - s2.a).normalize()
    u1 = d1 if u1.dot(d1) > 0 else -d1
    u2 = d2 if u2.dot(d2) > 0 else -d2
    return P, u1, u2


def far_end(line, P: Vec2, u: Vec2) -> Vec2:
    """直線在保留方向上離交點最遠的端點。"""
    a, b = Vec2(line.dxf.start), Vec2(line.dxf.end)
    return a if (a - P).dot(u) >= (b - P).dot(u) else b


def fillet(l1, pick1, l2, pick2, r: float):
    """回傳 (新線1端點, 新線2端點, 圓弧參數或None)。"""
    c = corner(l1, pick1, l2, pick2)
    if c is None:
        return None
    P, u1, u2 = c
    e1, e2 = far_end(l1, P, u1), far_end(l2, P, u2)
    if r <= 1e-12:
        return (e1, P), (e2, P), None
    theta = math.acos(max(-1.0, min(1.0, u1.dot(u2))))
    if theta < 1e-6 or abs(theta - math.pi) < 1e-6:
        return None
    d = r / math.tan(theta / 2)
    T1, T2 = P + u1 * d, P + u2 * d
    bis = (u1 + u2).normalize()
    C = P + bis * (r / math.sin(theta / 2))
    a1, a2 = (T1 - C).angle, (T2 - C).angle
    # 選逆時針較短那段
    if (a2 - a1) % TAU > math.pi:
        a1, a2 = a2, a1
    return (e1, T1), (e2, T2), (C, r, a1, a2)


def chamfer(l1, pick1, l2, pick2, d1: float, d2: float):
    c = corner(l1, pick1, l2, pick2)
    if c is None:
        return None
    P, u1, u2 = c
    e1, e2 = far_end(l1, P, u1), far_end(l2, P, u2)
    T1, T2 = P + u1 * d1, P + u2 * d2
    return (e1, T1), (e2, T2), (T1, T2)
