"""機械製圖標準：CNS（台灣）與 ISO 的圖層、線型、文字樣式、標註樣式、圖框。

CNS 3 / CNS 3-4 大致沿用 ISO 128 / ISO 129，主要差別：
- CNS 慣用第三角法，ISO（歐洲）慣用第一角法
- CNS 中文字型用 chineset.shx 大字型
"""
from __future__ import annotations

import ezdxf
from ezdxf.document import Drawing
from ezdxf.tools.standards import linetypes as std_linetypes

STANDARDS = ("CNS", "ISO")

# 名稱, 顏色(ACI), 線型, 線寬(1/100 mm)
LAYERS = [
    ("輪廓線", 7, "Continuous", 50),
    ("細實線", 3, "Continuous", 25),
    ("中心線", 1, "CENTER", 25),
    ("隱藏線", 2, "HIDDEN", 35),
    ("假想線", 6, "PHANTOM", 25),
    ("尺寸標註", 4, "Continuous", 25),
    ("剖面線", 8, "Continuous", 18),
    ("文字", 7, "Continuous", 25),
    ("圖框", 7, "Continuous", 50),
]

TEXT_STYLE = {"CNS": "CNS-文字", "ISO": "ISO-文字"}
DIM_STYLE = {"CNS": "CNS-機械", "ISO": "ISO-機械"}


def ensure_linetypes(doc: Drawing) -> None:
    for name, desc, pattern in std_linetypes():
        if name not in doc.linetypes:
            doc.linetypes.add(name, pattern=pattern, description=desc)


def ensure_standard(doc: Drawing, std: str = "CNS") -> None:
    """確保圖檔裡有指定標準的圖層、文字樣式、標註樣式（已存在的不覆蓋）。"""
    ensure_linetypes(doc)
    for name, color, lt, lw in LAYERS:
        if name not in doc.layers:
            doc.layers.add(name, color=color, linetype=lt, lineweight=lw)

    ts = TEXT_STYLE[std]
    if ts not in doc.styles:
        if std == "CNS":
            st = doc.styles.add(ts, font="romans.shx")
            st.dxf.bigfont = "chineset.shx"
        else:
            doc.styles.add(ts, font="isocp.shx")
        doc.styles.get(ts).dxf.width = 0.8 if std == "ISO" else 1.0

    ds = DIM_STYLE[std]
    if ds not in doc.dimstyles:
        # 兩者都：字高 3.5、箭頭 3、實心箭頭、文字在線上方、兩位小數去尾零
        d = doc.dimstyles.new(ds)
        d.dxf.dimtxsty = ts
        d.dxf.dimtxt = 3.5
        d.dxf.dimasz = 3.0
        d.dxf.dimexo = 1.0 if std == "CNS" else 0.0  # 尺寸界線離開物件
        d.dxf.dimexe = 2.0 if std == "CNS" else 1.5  # 尺寸界線超出尺寸線
        d.dxf.dimgap = 1.0
        d.dxf.dimdec = 2
        d.dxf.dimdsep = ord(".")
        d.dxf.dimtad = 1      # 文字在尺寸線上方
        d.dxf.dimtih = 0      # 內部文字對齊尺寸線
        d.dxf.dimtoh = 0
        d.dxf.dimzin = 8      # 去尾零 10.50 → 10.5
        d.dxf.dimlunit = 2    # 十進位
        d.dxf.dimaunit = 0    # 角度：十進位度
        d.dxf.dimadec = 1
        d.dxf.dimclrd = 0     # BYBLOCK
        d.dxf.dimclre = 0
        d.dxf.dimclrt = 0
        d.dxf.dimtfac = 0.7   # 公差文字比例
        d.dxf.dimtolj = 1
        d.dxf.dimtzin = 8
        d.dxf.dimcen = 2.5    # 中心記號
        d.dxf.dimatfit = 3
        d.dxf.dimtmove = 0
        d.dxf.dimscale = 1.0
    if std == "CNS" and doc.header.get("$INSUNITS", 0) == 0:
        doc.header["$INSUNITS"] = 4


def new_drawing(std: str = "CNS") -> Drawing:
    doc = ezdxf.new("R2018", setup=True, units=4)  # mm
    doc.header["$MEASUREMENT"] = 1
    doc.header["$LTSCALE"] = 1.0
    doc.header["$LWDISPLAY"] = 1
    ensure_standard(doc, std)
    ensure_standard(doc, "ISO" if std == "CNS" else "CNS")
    doc.header["$CLAYER"] = "輪廓線"
    doc.header["$DIMSTYLE"] = DIM_STYLE[std]
    doc.header["$TEXTSTYLE"] = TEXT_STYLE[std]
    return doc


def current_standard(doc: Drawing) -> str:
    return "ISO" if doc.header.get("$DIMSTYLE", "") == DIM_STYLE["ISO"] else "CNS"


# ---------------------------------------------------------------- 圖框與標題欄
PAPER = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594), "A0": (1189, 841)}


def draw_frame(doc: Drawing, origin=(0.0, 0.0), paper: str = "A3", std: str = "CNS",
               scale: float = 1.0, title: str = "", dwg_no: str = "", material: str = "",
               designer: str = "", date: str = "") -> list:
    """畫圖框與標題欄。scale 為出圖比例，例如 1:2 傳 2（圖框放大 2 倍以配合實尺寸繪圖）。"""
    ensure_standard(doc, std)
    msp = doc.modelspace()
    w, h = PAPER[paper]
    k = scale
    ox, oy = origin
    left = 20 if paper in ("A0", "A1") else 20  # 裝訂邊
    m = 10 if paper in ("A0", "A1") else 5
    attr = {"layer": "圖框"}
    thin = {"layer": "圖框", "lineweight": 25}
    ts = TEXT_STYLE[std]
    created = []

    def P(x, y):
        return (ox + x * k, oy + y * k)

    def line(a, b, thick=False):
        e = msp.add_line(P(*a), P(*b), dxfattribs=attr if thick else thin)
        created.append(e)

    def text(s, x, y, hgt=3.5, align="LEFT"):
        if not s:
            return
        e = msp.add_text(s, height=hgt * k, dxfattribs={"layer": "文字", "style": ts})
        from ezdxf.enums import TextEntityAlignment
        e.set_placement(P(x, y), align=TextEntityAlignment[align])
        created.append(e)

    # 外框（細）與內框（粗）
    created.append(msp.add_lwpolyline([P(0, 0), P(w, 0), P(w, h), P(0, h)], close=True, dxfattribs=thin))
    created.append(msp.add_lwpolyline([P(left, m), P(w - m, m), P(w - m, h - m), P(left, h - m)],
                                      close=True, dxfattribs={"layer": "圖框", "lineweight": 50}))
    # 對中符號
    for a, b in (((w / 2, 0), (w / 2, m + 5)), ((w / 2, h), (w / 2, h - m - 5)),
                 ((0, h / 2), (left + 5, h / 2)), ((w, h / 2), (w - m - 5, h / 2))):
        line(a, b, thick=True)

    # 標題欄 180 x 40（右下角）
    tw, th = 180, 40
    x0, y0 = w - m - tw, m
    x1, y1 = w - m, m + th
    created.append(msp.add_lwpolyline([P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], close=True,
                                      dxfattribs={"layer": "圖框", "lineweight": 50}))
    for yy in (10, 20, 30):
        line((x0, y0 + yy), (x1, y0 + yy))
    for xx in (25, 75, 100, 140):
        line((x0 + xx, y0), (x0 + xx, y1))

    zh = std == "CNS"
    proj = "第三角法" if std == "CNS" else "第一角法"
    labels = [
        # (欄位標籤, 值, 左下角 x, y)
        ("名稱" if zh else "TITLE", title, 0, 30),
        ("圖號" if zh else "DWG NO.", dwg_no, 0, 20),
        ("材質" if zh else "MATERIAL", material, 0, 10),
        ("設計" if zh else "DESIGNED", designer, 0, 0),
        ("比例" if zh else "SCALE", _scale_text(scale), 75, 30),
        ("單位" if zh else "UNIT", "mm", 75, 20),
        ("投影" if zh else "PROJ.", proj, 75, 10),
        ("日期" if zh else "DATE", date, 75, 0),
    ]
    for lab, val, x, y in labels:
        text(lab, x0 + x + 2, y0 + y + 3, 2.5)
        text(val, x0 + x + (27 if x == 0 else 27), y0 + y + 3, 3.5)
    text("標準" if zh else "STANDARD", x0 + 142, y0 + 33, 2.5)
    text(std, x0 + 142, y0 + 23, 5)
    text("張次" if zh else "SHEET", x0 + 142, y0 + 13, 2.5)
    text("1 / 1", x0 + 142, y0 + 3, 3.5)
    text("尺寸未註公差依 CNS 4-1 中級" if zh else "GENERAL TOLERANCES ISO 2768-m",
         left + 5, m + 3, 2.5)
    return created


def _scale_text(scale: float) -> str:
    if scale >= 1:
        return f"1:{scale:g}"
    return f"{1 / scale:g}:1"
