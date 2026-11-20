"""主視窗：選單、工具列、指令列、圖層、屬性、對話框。"""
from __future__ import annotations

import datetime
import os

from PySide6 import QtCore as qc, QtGui as qg, QtWidgets as qw
from ezdxf.math import Vec2
from ezdxf.colors import aci2rgb

from . import fileio, standards, geom
from .canvas import CadView
from .editor import Editor

APP_NAME = "簡易機械 CAD"
from ._version import VERSION
ODA_URL = "https://www.opendesign.com/guestfiles/oda_file_converter"

ACI_NAMES = {1: "紅", 2: "黃", 3: "綠", 4: "青", 5: "藍", 6: "洋紅", 7: "白/黑", 8: "深灰", 9: "淺灰"}


def aci_icon(aci: int) -> qg.QIcon:
    pm = qg.QPixmap(14, 14)
    if aci in (0, 256) or aci < 0:
        pm.fill(qc.Qt.transparent)
    else:
        r, g, b = aci2rgb(aci)
        pm.fill(qg.QColor(r, g, b))
    return qg.QIcon(pm)


# ---------------------------------------------------------------- 指令列
class CommandLine(qw.QWidget):
    def __init__(self, editor: Editor, parent=None):
        super().__init__(parent)
        self.editor = editor
        lay = qw.QVBoxLayout(self)
        lay.setContentsMargins(4, 2, 4, 2)
        lay.setSpacing(2)
        self.hist = qw.QPlainTextEdit(readOnly=True)
        self.hist.setMaximumBlockCount(1000)
        self.hist.setFixedHeight(88)
        f = qg.QFont("Consolas")
        f.setStyleHint(qg.QFont.Monospace)
        self.hist.setFont(f)
        row = qw.QHBoxLayout()
        self.prompt = qw.QLabel("指令：")
        self.prompt.setStyleSheet("font-weight:bold")
        self.edit = qw.QLineEdit()
        self.edit.setPlaceholderText("輸入指令（例如 L 直線、C 圓、DLI 標註），或輸入座標 x,y、@dx,dy、@距離<角度")
        self.edit.returnPressed.connect(self.submit)
        self.edit.installEventFilter(self)
        row.addWidget(self.prompt)
        row.addWidget(self.edit, 1)
        lay.addWidget(self.hist)
        lay.addLayout(row)

    def eventFilter(self, obj, ev):
        if obj is self.edit and ev.type() == qc.QEvent.KeyPress:
            k = ev.key()
            if k == qc.Qt.Key_Escape:
                self.edit.clear()
                self.editor.on_key(ev)
                return True
            if k == qc.Qt.Key_Space:
                req = self.editor.req
                if req is None or req.kind != "string":
                    self.submit()
                    return True
        return False

    def history(self, text):
        self.hist.appendPlainText(text)
        self.hist.verticalScrollBar().setValue(self.hist.verticalScrollBar().maximum())

    def set_prompt(self, text):
        self.prompt.setText(text)

    def text(self):
        return self.edit.text()

    def submit(self):
        t = self.edit.text()
        self.edit.clear()
        self.editor.submit(t)

    def forward_key(self, ev: qg.QKeyEvent):
        if ev.text() and ev.text().isprintable():
            self.edit.setFocus()
            self.edit.insert(ev.text())
        elif ev.key() == qc.Qt.Key_Backspace:
            self.edit.backspace()


# ---------------------------------------------------------------- 對話框
class FrameDialog(qw.QDialog):
    def __init__(self, std, parent=None):
        super().__init__(parent)
        self.setWindowTitle("插入圖框")
        form = qw.QFormLayout(self)
        self.paper = qw.QComboBox()
        self.paper.addItems(list(standards.PAPER))
        self.paper.setCurrentText("A3")
        self.std = qw.QComboBox()
        self.std.addItems(["CNS", "ISO"])
        self.std.setCurrentText(std)
        self.scale = qw.QComboBox()
        self.scale.setEditable(True)
        self.scale.addItems(["1:1", "1:2", "1:5", "1:10", "2:1", "5:1"])
        self.title = qw.QLineEdit()
        self.no = qw.QLineEdit()
        self.mat = qw.QLineEdit()
        self.des = qw.QLineEdit()
        self.date = qw.QLineEdit(datetime.date.today().strftime("%Y/%m/%d"))
        form.addRow("紙張", self.paper)
        form.addRow("標準", self.std)
        form.addRow("比例", self.scale)
        form.addRow("名稱", self.title)
        form.addRow("圖號", self.no)
        form.addRow("材質", self.mat)
        form.addRow("設計", self.des)
        form.addRow("日期", self.date)
        note = qw.QLabel("CNS：第三角法、中文標題欄　ISO：第一角法、英文標題欄")
        note.setStyleSheet("color:gray")
        form.addRow(note)
        bb = qw.QDialogButtonBox(qw.QDialogButtonBox.Ok | qw.QDialogButtonBox.Cancel)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        form.addRow(bb)

    def values(self):
        s = self.scale.currentText().replace("：", ":")
        try:
            a, b = (float(x) for x in s.split(":"))
            scale = b / a  # 1:2 → 圖框放大 2 倍
        except Exception:  # noqa: BLE001
            scale = 1.0
        return dict(paper=self.paper.currentText(), std=self.std.currentText(), scale=scale,
                    title=self.title.text(), dwg_no=self.no.text(), material=self.mat.text(),
                    designer=self.des.text(), date=self.date.text())


class ExportDialog(qw.QDialog):
    def __init__(self, title, with_format=True, parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        form = qw.QFormLayout(self)
        self.fmt = qw.QComboBox()
        self.fmt.addItems(["PDF", "PNG 圖片", "SVG 向量圖"])
        self.paper = qw.QComboBox()
        self.paper.addItems(list(fileio.PAPER_SIZES))
        self.orient = qw.QComboBox()
        self.orient.addItems(["橫向", "直向"])
        self.scale = qw.QComboBox()
        self.scale.setEditable(True)
        self.scale.addItems(["自動符合紙張", "1:1", "1:2", "1:5", "2:1"])
        self.mono = qw.QCheckBox("黑白輸出（建議）")
        self.mono.setChecked(True)
        if with_format:
            form.addRow("格式", self.fmt)
        form.addRow("紙張", self.paper)
        form.addRow("方向", self.orient)
        form.addRow("比例", self.scale)
        form.addRow(self.mono)
        bb = qw.QDialogButtonBox(qw.QDialogButtonBox.Ok | qw.QDialogButtonBox.Cancel)
        bb.accepted.connect(self.accept)
        bb.rejected.connect(self.reject)
        form.addRow(bb)

    def values(self):
        s = self.scale.currentText().replace("：", ":")
        scale = 0.0
        if ":" in s:
            try:
                a, b = (float(x) for x in s.split(":"))
                scale = a / b
            except Exception:  # noqa: BLE001
                scale = 0.0
        ext = {0: ".pdf", 1: ".png", 2: ".svg"}[self.fmt.currentIndex()]
        return dict(ext=ext, paper=self.paper.currentText(), landscape=self.orient.currentIndex() == 0,
                    monochrome=self.mono.isChecked(), scale=scale)


# ---------------------------------------------------------------- 主視窗
class MainWindow(qw.QMainWindow):
    def __init__(self):
        super().__init__()
        self.settings = qc.QSettings("SimpleMechCAD", "SimpleMechCAD")
        fileio.set_oda_path(self.settings.value("oda_path", "", str))
        self.path = ""
        self.save_version = "R2018"
        self.editor = Editor(self)
        self.view = CadView(self.editor)
        self.editor.view = self.view
        from .canvas import LINE_MODES, DEFAULT_MODE
        mode = self.settings.value("line_mode", DEFAULT_MODE, str)
        self.view.line_mode = mode if mode in LINE_MODES else DEFAULT_MODE
        self.view.dark = self.settings.value("dark", True, bool)
        self.cmdline = CommandLine(self.editor)
        central = qw.QWidget()
        v = qw.QVBoxLayout(central)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        v.addWidget(self.view, 1)
        v.addWidget(self.cmdline)
        self.setCentralWidget(central)
        self.resize(1400, 900)
        self.setAcceptDrops(True)
        # 拖放檔案：繪圖區、指令列等子元件會先攔截拖放，所以在整個程式層級處理
        qw.QApplication.instance().installEventFilter(self)

        self._build_status()
        self._build_docks()
        self._build_menus()
        self._build_toolbars()
        self.new_file(ask=False)
        self.view.setFocus()

    # ------------------------------------------------------------ 介面建置
    def _act(self, text, slot, shortcut=None, tip=None):
        a = qg.QAction(text, self)
        a.triggered.connect(slot)
        if shortcut:
            a.setShortcut(qg.QKeySequence(shortcut))
        if tip:
            a.setToolTip(tip)
            a.setStatusTip(tip)
        return a

    def _cmd_act(self, text, cmd, tip=""):
        return self._act(text, lambda: (self.editor.run(cmd), self.view.setFocus()),
                         tip=f"{tip}　指令：{cmd}" if tip else f"指令：{cmd}")

    def _build_menus(self):
        mb = self.menuBar()
        m = mb.addMenu("檔案(&F)")
        m.addAction(self._act("新建 CNS 圖面", lambda: self.new_file(std="CNS"), "Ctrl+N"))
        m.addAction(self._act("新建 ISO 圖面", lambda: self.new_file(std="ISO")))
        m.addAction(self._act("開啟…", self.open_file, "Ctrl+O"))
        self.recent_menu = m.addMenu("最近開啟")
        self._refresh_recent()
        m.addSeparator()
        m.addAction(self._act("儲存", self.save_file, "Ctrl+S"))
        m.addAction(self._act("另存新檔…", self.save_as, "Ctrl+Shift+S"))
        m.addSeparator()
        m.addAction(self._act("匯出 PDF / PNG / SVG…", self.export_file, "Ctrl+E"))
        m.addAction(self._act("列印…", self.print_file, "Ctrl+P"))
        m.addSeparator()
        m.addAction(self._act("設定 ODA File Converter 位置…", self.choose_oda))
        m.addSeparator()
        m.addAction(self._act("結束", self.close))

        m = mb.addMenu("編輯(&E)")
        m.addAction(self._act("復原", self.editor.undo, "Ctrl+Z"))
        m.addAction(self._act("重做", self.editor.redo, "Ctrl+Y"))
        m.addSeparator()
        m.addAction(self._act("全選", self.select_all, "Ctrl+A"))
        m.addAction(self._cmd_act("刪除", "ERASE"))
        m.addAction(self._act("取消選取 / 取消指令", lambda: self.editor.on_key(
            qg.QKeyEvent(qc.QEvent.KeyPress, qc.Qt.Key_Escape, qc.Qt.NoModifier))))

        m = mb.addMenu("檢視(&V)")
        m.addAction(self._act("縮放到全部", self.view.zoom_extents, "Ctrl+Home"))
        m.addAction(self._act("切換黑色／白色背景", self.toggle_background))
        lw = m.addMenu("線條顯示")
        group = qg.QActionGroup(self)
        from .canvas import LINE_MODES, DEFAULT_MODE
        cur = self.view.line_mode
        for name in LINE_MODES:
            a = lw.addAction(name)
            a.setCheckable(True)
            a.setChecked(name == cur)
            group.addAction(a)
            a.triggered.connect(lambda _=False, n=name: self.set_line_mode(n))
        m.addAction(self._act("重新產生畫面", self.editor.regen))
        m.addSeparator()
        m.addAction(self.layer_dock.toggleViewAction())
        m.addAction(self.prop_dock.toggleViewAction())

        for group in ("繪圖", "標註", "修改", "機械", "查詢"):
            m = mb.addMenu(group)
            for g, names, desc in self.editor.commands.HELP:
                if g == group:
                    first = names.split(" / ")[0]
                    zh = names.split(" / ")[-1]
                    m.addAction(self._cmd_act(f"{zh}　（{first}）", first, desc))

        m = mb.addMenu("說明(&H)")
        m.addAction(self._act("指令一覽", self.show_help, "F1"))
        m.addAction(self._act("自動安裝 ODA File Converter（DWG 需要）", lambda: self.auto_install_oda(ask=False)))
        m.addAction(self._act("ODA File Converter 狀態與說明", self.oda_help))
        m.addAction(self._act("檢查更新…", lambda: self.check_update(manual=True)))
        m.addAction(self._act("關於", self.about))

        # 功能鍵
        self.addAction(self._act("F3", self.toggle_osnap, "F3"))
        self.addAction(self._act("F8", self.toggle_ortho, "F8"))

    def _build_toolbars(self):
        def tb(name, items):
            t = self.addToolBar(name)
            t.setToolButtonStyle(qc.Qt.ToolButtonTextOnly)
            t.setObjectName(name)
            for text, cmd in items:
                t.addAction(self._cmd_act(text, cmd))
            return t
        t = self.addToolBar("檔案")
        t.setObjectName("檔案")
        t.setToolButtonStyle(qc.Qt.ToolButtonTextOnly)
        t.addAction(self._act("新建", lambda: self.new_file()))
        t.addAction(self._act("開啟", self.open_file))
        t.addAction(self._act("儲存", self.save_file))
        t.addAction(self._act("復原", self.editor.undo))
        t.addAction(self._act("重做", self.editor.redo))
        tb("繪圖", [("直線", "L"), ("聚合線", "PL"), ("矩形", "REC"), ("圓", "C"), ("圓弧", "A"),
                    ("多邊形", "POL"), ("文字", "T")])
        tb("修改", [("移動", "M"), ("複製", "CO"), ("旋轉", "RO"), ("鏡射", "MI"), ("縮放", "SC"),
                    ("偏移", "O"), ("修剪", "TR"), ("延伸", "EX"), ("圓角", "F"), ("倒角", "CHA"),
                    ("分解", "X"), ("刪除", "E")])
        self.addToolBarBreak()
        tb("標註", [("線性", "DLI"), ("對齊", "DAL"), ("半徑", "DRA"), ("直徑", "DDI"), ("角度", "DAN"),
                    ("引線", "LE")])
        tb("機械", [("中心線", "CM"), ("剖面線", "H"), ("圖框", "FRAME"), ("量距離", "DI"), ("查詢", "LI")])

        t = self.addToolBar("樣式")
        t.setObjectName("樣式")
        t.addWidget(qw.QLabel(" 圖層 "))
        self.layer_combo = qw.QComboBox()
        self.layer_combo.setMinimumWidth(160)
        self.layer_combo.activated.connect(lambda i: self._set_layer(self.layer_combo.itemText(i)))
        t.addWidget(self.layer_combo)
        t.addWidget(qw.QLabel(" 標註樣式 "))
        self.dim_combo = qw.QComboBox()
        self.dim_combo.setMinimumWidth(130)
        self.dim_combo.activated.connect(lambda i: self._set_dimstyle(self.dim_combo.itemText(i)))
        t.addWidget(self.dim_combo)

    def _build_status(self):
        sb = self.statusBar()
        self.coord_label = qw.QLabel("0.0000, 0.0000")
        self.coord_label.setMinimumWidth(220)
        sb.addWidget(self.coord_label)
        self.ortho_btn = qw.QPushButton("正交 F8")
        self.ortho_btn.setCheckable(True)
        self.ortho_btn.toggled.connect(self._set_ortho)
        self.osnap_btn = qw.QToolButton()
        self.osnap_btn.setText("物件鎖點 F3")
        self.osnap_btn.setCheckable(True)
        self.osnap_btn.setChecked(True)
        self.osnap_btn.setPopupMode(qw.QToolButton.MenuButtonPopup)
        self.osnap_btn.toggled.connect(self._set_osnap)
        menu = qw.QMenu(self)
        for kind in geom.ALL_SNAPS:
            a = menu.addAction(kind)
            a.setCheckable(True)
            a.setChecked(kind in self.editor.osnap_modes)
            a.toggled.connect(lambda on, k=kind: (self.editor.osnap_modes.add(k) if on
                                                   else self.editor.osnap_modes.discard(k)))
        self.osnap_btn.setMenu(menu)
        self.info_label = qw.QLabel("")
        sb.addPermanentWidget(self.info_label)
        sb.addPermanentWidget(self.ortho_btn)
        sb.addPermanentWidget(self.osnap_btn)

    def _build_docks(self):
        # 圖層
        self.layer_dock = qw.QDockWidget("圖層", self)
        self.layer_dock.setObjectName("layers")
        w = qw.QWidget()
        lay = qw.QVBoxLayout(w)
        lay.setContentsMargins(2, 2, 2, 2)
        self.layer_table = qw.QTableWidget(0, 4)
        self.layer_table.setHorizontalHeaderLabels(["名稱", "顯示", "顏色", "線型"])
        self.layer_table.verticalHeader().hide()
        hh = self.layer_table.horizontalHeader()
        hh.setSectionResizeMode(0, qw.QHeaderView.Stretch)
        for c in (1, 2, 3):
            hh.setSectionResizeMode(c, qw.QHeaderView.ResizeToContents)
        self.layer_table.verticalHeader().setDefaultSectionSize(22)
        self.layer_table.setSelectionBehavior(qw.QAbstractItemView.SelectRows)
        self.layer_table.setEditTriggers(qw.QAbstractItemView.NoEditTriggers)
        self.layer_table.cellDoubleClicked.connect(self._layer_dbl)
        self.layer_table.cellClicked.connect(self._layer_click)
        lay.addWidget(self.layer_table)
        row = qw.QHBoxLayout()
        b1 = qw.QPushButton("新增圖層")
        b1.clicked.connect(self.add_layer)
        b2 = qw.QPushButton("設為目前")
        b2.clicked.connect(lambda: self._set_layer(self._selected_layer()))
        b3 = qw.QPushButton("加入標準圖層")
        b3.setToolTip("加入輪廓線、中心線、隱藏線、尺寸標註等機械製圖常用圖層")
        b3.clicked.connect(self.add_standard_layers)
        row.addWidget(b1)
        row.addWidget(b2)
        row.addWidget(b3)
        lay.addLayout(row)
        hint = qw.QLabel("雙擊名稱＝設為目前圖層；點「顯示」切換開關；點「顏色」換顏色")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:gray")
        lay.addWidget(hint)
        w.setMinimumWidth(340)
        self.layer_dock.setWidget(w)
        self.addDockWidget(qc.Qt.RightDockWidgetArea, self.layer_dock)

        # 屬性
        self.prop_dock = qw.QDockWidget("屬性", self)
        self.prop_dock.setObjectName("props")
        w = qw.QWidget()
        self.prop_form = qw.QFormLayout(w)
        self.prop_count = qw.QLabel("未選取物件")
        self.prop_layer = qw.QComboBox()
        self.prop_color = qw.QComboBox()
        self.prop_color.addItem(aci_icon(256), "隨圖層 ByLayer", 256)
        for i, n in ACI_NAMES.items():
            self.prop_color.addItem(aci_icon(i), f"{i} {n}", i)
        self.prop_lt = qw.QComboBox()
        self.prop_info = qw.QLabel("")
        self.prop_info.setWordWrap(True)
        self.prop_info.setTextInteractionFlags(qc.Qt.TextSelectableByMouse)
        self.prop_value = qw.QLineEdit()
        self.prop_value_label = qw.QLabel("")
        self.prop_form.addRow(self.prop_count)
        self.prop_form.addRow("圖層", self.prop_layer)
        self.prop_form.addRow("顏色", self.prop_color)
        self.prop_form.addRow("線型", self.prop_lt)
        self.prop_form.addRow(self.prop_value_label, self.prop_value)
        self.prop_form.addRow(self.prop_info)
        self.prop_layer.activated.connect(lambda i: self._apply_prop("layer", self.prop_layer.itemText(i)))
        self.prop_color.activated.connect(lambda i: self._apply_prop("color", self.prop_color.itemData(i)))
        self.prop_lt.activated.connect(lambda i: self._apply_prop("linetype", self.prop_lt.itemText(i)))
        self.prop_value.editingFinished.connect(self._apply_value)
        self.prop_dock.setWidget(w)
        self.addDockWidget(qc.Qt.RightDockWidgetArea, self.prop_dock)

    # ------------------------------------------------------------ 狀態更新
    def show_coords(self, p: Vec2):
        self.coord_label.setText(f"X {p.x:.4f}   Y {p.y:.4f}")

    def update_title(self):
        name = os.path.basename(self.path) if self.path else "未命名"
        self.setWindowTitle(f"{'*' if self.editor.dirty else ''}{name} - {APP_NAME} v{VERSION}")

    def on_doc_changed(self, reset_title=True):
        self.refresh_layers()
        self.refresh_properties()
        self.update_title()

    def refresh_layers(self):
        doc = self.editor.doc
        cur = self.editor.current_layer
        names = sorted((l.dxf.name for l in doc.layers), key=lambda s: (s != "0", s.lower()))
        self.layer_table.setRowCount(len(names))
        for r, n in enumerate(names):
            layer = doc.layers.get(n)
            it = qw.QTableWidgetItem(("▶ " if n == cur else "") + n)
            it.setData(qc.Qt.UserRole, n)
            if n == cur:
                f = it.font()
                f.setBold(True)
                it.setFont(f)
            self.layer_table.setItem(r, 0, it)
            self.layer_table.setItem(r, 1, qw.QTableWidgetItem("開" if layer.is_on() else "關"))
            c = qw.QTableWidgetItem(str(abs(layer.color)))
            c.setIcon(aci_icon(abs(layer.color)))
            self.layer_table.setItem(r, 2, c)
            self.layer_table.setItem(r, 3, qw.QTableWidgetItem(layer.dxf.linetype))
        for combo in (self.layer_combo, self.prop_layer):
            combo.clear()
            for n in names:
                combo.addItem(aci_icon(abs(doc.layers.get(n).color)), n)
        self.layer_combo.setCurrentText(cur)
        self.dim_combo.clear()
        self.dim_combo.addItems([d.dxf.name for d in doc.dimstyles])
        self.dim_combo.setCurrentText(self.editor.dimstyle)
        self.prop_lt.clear()
        self.prop_lt.addItems(["ByLayer", "ByBlock"] + [lt.dxf.name for lt in doc.linetypes
                                                         if lt.dxf.name.upper() not in ("BYLAYER", "BYBLOCK")])
        self.info_label.setText(f"標準：{standards.current_standard(doc)}　")

    def refresh_properties(self):
        ents = self.editor.selected_entities()
        enable = bool(ents)
        for w in (self.prop_layer, self.prop_color, self.prop_lt):
            w.setEnabled(enable)
        self.prop_value.hide()
        self.prop_value_label.hide()
        self.prop_info.setText("")
        if not ents:
            self.prop_count.setText("未選取物件")
            return
        types = {}
        for e in ents:
            types[e.dxftype()] = types.get(e.dxftype(), 0) + 1
        self.prop_count.setText("已選取：" + "、".join(f"{k}×{v}" for k, v in types.items()))
        e = ents[0]
        self.prop_layer.setCurrentText(e.dxf.layer)
        col = e.dxf.get("color", 256)
        idx = self.prop_color.findData(col)
        if idx < 0:
            self.prop_color.addItem(aci_icon(col), str(col), col)
            idx = self.prop_color.count() - 1
        self.prop_color.setCurrentIndex(idx)
        self.prop_lt.setCurrentText(e.dxf.get("linetype", "ByLayer"))
        if len(ents) == 1:
            t = e.dxftype()
            if t in ("TEXT", "MTEXT"):
                self._show_value("內容", e.dxf.text if t == "TEXT" else e.text)
            elif t in ("CIRCLE", "ARC"):
                self._show_value("半徑", f"{e.dxf.radius:g}")
                self.prop_info.setText(f"直徑 {2 * e.dxf.radius:.4f}")
            elif t == "LINE":
                a, b = Vec2(e.dxf.start), Vec2(e.dxf.end)
                self.prop_info.setText(f"長度 {a.distance(b):.4f}\n起點 ({a.x:.3f}, {a.y:.3f})\n終點 ({b.x:.3f}, {b.y:.3f})")
            elif t == "DIMENSION":
                self._show_value("標註文字", e.dxf.get("text", "<>") or "<>")
                try:
                    self.prop_info.setText(f"量測值 {e.get_measurement():.4f}")
                except Exception:  # noqa: BLE001
                    pass

    def _show_value(self, label, value):
        self.prop_value_label.setText(label)
        self.prop_value.setText(value)
        self.prop_value_label.show()
        self.prop_value.show()

    def _apply_prop(self, key, value):
        ents = self.editor.selected_entities()
        if not ents:
            return
        self.editor.before_change()
        for e in ents:
            try:
                e.dxf.set(key, value)
            except Exception:  # noqa: BLE001
                pass
        self.editor._snapshot_taken = False
        self.editor.modified(ents)

    def _apply_value(self):
        ents = self.editor.selected_entities()
        if len(ents) != 1 or not self.prop_value.isVisible():
            return
        e = ents[0]
        val = self.prop_value.text()
        t = e.dxftype()
        try:
            if t == "TEXT":
                if val == e.dxf.text:
                    return
                self.editor.before_change()
                e.dxf.text = val
            elif t == "MTEXT":
                if val == e.text:
                    return
                self.editor.before_change()
                e.text = val
            elif t in ("CIRCLE", "ARC"):
                r = float(val)
                if r <= 0 or abs(r - e.dxf.radius) < 1e-12:
                    return
                self.editor.before_change()
                e.dxf.radius = r
            elif t == "DIMENSION":
                self.editor.before_change()
                e.dxf.text = "" if val == "<>" else val
                e.override().render()
        except ValueError:
            return
        self.editor._snapshot_taken = False
        self.editor.modified([e])
        self.refresh_properties()

    # ------------------------------------------------------------ 圖層
    def _selected_layer(self):
        r = self.layer_table.currentRow()
        if r < 0:
            return None
        return self.layer_table.item(r, 0).data(qc.Qt.UserRole)

    def _set_layer(self, name):
        if name and name in self.editor.doc.layers:
            self.editor.set_current_layer(name)
            self.editor.msg(f"目前圖層：{name}")
            self.refresh_layers()
        self.view.setFocus()

    def _set_dimstyle(self, name):
        self.editor.doc.header["$DIMSTYLE"] = name
        self.editor.msg(f"目前標註樣式：{name}")
        self.view.setFocus()

    def _layer_dbl(self, row, col):
        if col == 0:
            self._set_layer(self.layer_table.item(row, 0).data(qc.Qt.UserRole))

    def _layer_click(self, row, col):
        name = self.layer_table.item(row, 0).data(qc.Qt.UserRole)
        layer = self.editor.doc.layers.get(name)
        if col == 1:
            if layer.is_on():
                layer.off()
            else:
                layer.on()
            self.editor.dirty = True
            self.editor.regen()
            self.refresh_layers()
        elif col == 2:
            val, ok = qw.QInputDialog.getInt(self, "圖層顏色",
                                             "顏色編號 1–255（1紅 2黃 3綠 4青 5藍 6洋紅 7白 8深灰 9淺灰）",
                                             abs(layer.color), 1, 255)
            if ok:
                layer.color = val
                self.editor.dirty = True
                self.editor.regen()
                self.refresh_layers()

    def add_layer(self):
        name, ok = qw.QInputDialog.getText(self, "新增圖層", "圖層名稱：")
        if ok and name.strip():
            name = name.strip()
            if name in self.editor.doc.layers:
                qw.QMessageBox.information(self, "新增圖層", "已經有這個圖層")
                return
            self.editor.doc.layers.add(name, color=7)
            self.editor.dirty = True
            self.editor.regen()
            self.refresh_layers()

    def add_standard_layers(self):
        std = standards.current_standard(self.editor.doc)
        standards.ensure_standard(self.editor.doc, std)
        self.editor.dirty = True
        self.editor.regen()
        self.refresh_layers()
        self.editor.msg("已加入機械製圖標準圖層、文字樣式與標註樣式")

    # ------------------------------------------------------------ 模式
    def _set_ortho(self, on):
        self.editor.ortho = on
        self.editor.msg("<正交 開>" if on else "<正交 關>")

    def _set_osnap(self, on):
        self.editor.osnap = on
        self.editor.msg("<物件鎖點 開>" if on else "<物件鎖點 關>")

    def toggle_ortho(self):
        self.ortho_btn.setChecked(not self.ortho_btn.isChecked())

    def toggle_osnap(self):
        self.osnap_btn.setChecked(not self.osnap_btn.isChecked())

    def toggle_background(self):
        self.view.dark = not self.view.dark
        self.settings.setValue("dark", self.view.dark)
        self.editor.regen()

    def set_line_mode(self, name):
        self.view.line_mode = name
        self.settings.setValue("line_mode", name)
        self.editor.regen()

    def select_all(self):
        self.editor.selection = {e.dxf.handle for e in self.editor.msp}
        self.view.set_highlight(self.editor.selection)
        self.refresh_properties()

    # ------------------------------------------------------------ 檔案
    def maybe_save(self) -> bool:
        if not self.editor.dirty:
            return True
        r = qw.QMessageBox.question(self, APP_NAME, "圖面已修改，要先儲存嗎？",
                                    qw.QMessageBox.Save | qw.QMessageBox.Discard | qw.QMessageBox.Cancel)
        if r == qw.QMessageBox.Save:
            return self.save_file()
        return r == qw.QMessageBox.Discard

    def new_file(self, std=None, ask=True):
        if ask and not self.maybe_save():
            return
        std = std or self.settings.value("standard", "CNS", str)
        self.settings.setValue("standard", std)
        doc = standards.new_drawing(std)
        self.path = ""
        self.save_version = "R2018"
        self.editor.undo_stack.clear()
        self.editor.redo_stack.clear()
        self.editor.dirty = False
        self.editor.set_doc(doc)
        self.view.fit_rect(qc.QRectF(0, 0, 420, 297))
        self.editor.msg(f"新圖面（{std} 標準，單位 mm）。輸入 FRAME 可插入圖框。")

    def open_file(self, path=None):
        if not self.maybe_save():
            return
        if not path:
            path, _ = qw.QFileDialog.getOpenFileName(
                self, "開啟圖檔", self.settings.value("last_dir", "", str),
                "CAD 圖檔 (*.dwg *.dxf);;DWG (*.dwg);;DXF (*.dxf);;所有檔案 (*)")
        if not path:
            return
        self.settings.setValue("last_dir", os.path.dirname(path))
        qw.QApplication.setOverrideCursor(qc.Qt.WaitCursor)
        try:
            doc, info, ver = fileio.load(path)
        except Exception as ex:  # noqa: BLE001
            qw.QApplication.restoreOverrideCursor()
            msg = str(ex)
            if path.lower().endswith(".dwg") and not fileio.find_oda():
                msg += "\n\n建議安裝 ODA File Converter（免費）以完整支援 DWG。"
            qw.QMessageBox.warning(self, "開啟失敗", msg)
            return
        qw.QApplication.restoreOverrideCursor()
        self.path = path
        self.save_version = ver if ver in dict((v, v) for _, v in fileio.VERSIONS) else "R2018"
        self.editor.undo_stack.clear()
        self.editor.redo_stack.clear()
        self.editor.dirty = False
        self.editor.set_doc(doc)
        self._add_recent(path)
        n = len(doc.modelspace())
        self.editor.msg(f"已開啟 {os.path.basename(path)}　格式：{info}　物件數：{n}")

    def save_file(self) -> bool:
        if not self.path:
            return self.save_as()
        return self._save_to(self.path, self.save_version)

    def save_as(self) -> bool:
        filters = []
        mapping = {}
        for label, ver in fileio.VERSIONS:
            f = f"{label} DWG (*.dwg)"
            filters.append(f)
            mapping[f] = (".dwg", ver)
        for label, ver in fileio.VERSIONS:
            f = f"{label} DXF (*.dxf)"
            filters.append(f)
            mapping[f] = (".dxf", ver)
        start = self.path or os.path.join(self.settings.value("last_dir", "", str), "未命名.dwg")
        default_filter = next((f for f, (e, v) in mapping.items()
                               if v == self.save_version and start.lower().endswith(e)), filters[0])
        path, flt = qw.QFileDialog.getSaveFileName(self, "另存新檔", start, ";;".join(filters), default_filter)
        if not path:
            return False
        ext, ver = mapping.get(flt, (".dwg", "R2018"))
        if not path.lower().endswith(ext):
            path = os.path.splitext(path)[0] + ext
        if self._save_to(path, ver):
            self.path = path
            self.save_version = ver
            self.update_title()
            self._add_recent(path)
            return True
        return False

    def _save_to(self, path, ver) -> bool:
        if path.lower().endswith(".dwg") and not fileio.find_oda():
            self.auto_install_oda(ask=True, reason="存成 DWG 需要 ODA File Converter。")
            if not fileio.find_oda():
                return False
        qw.QApplication.setOverrideCursor(qc.Qt.WaitCursor)
        try:
            fileio.save(self.editor.doc, path, ver)
        except Exception as ex:  # noqa: BLE001
            qw.QApplication.restoreOverrideCursor()
            qw.QMessageBox.warning(self, "儲存失敗", str(ex))
            return False
        qw.QApplication.restoreOverrideCursor()
        self.editor.dirty = False
        self.update_title()
        self.editor.msg(f"已儲存：{path}（{ver}）")
        return True

    def export_file(self):
        dlg = ExportDialog("匯出", parent=self)
        if dlg.exec() != qw.QDialog.Accepted:
            return
        v = dlg.values()
        base = os.path.splitext(self.path)[0] if self.path else os.path.join(
            self.settings.value("last_dir", "", str), "未命名")
        path, _ = qw.QFileDialog.getSaveFileName(self, "匯出", base + v["ext"], f"*{v['ext']}")
        if not path:
            return
        if not path.lower().endswith(v["ext"]):
            path += v["ext"]
        qw.QApplication.setOverrideCursor(qc.Qt.WaitCursor)
        try:
            fileio.export(self.editor.doc, path, v["paper"], v["landscape"], v["monochrome"], v["scale"])
        except Exception as ex:  # noqa: BLE001
            qw.QApplication.restoreOverrideCursor()
            qw.QMessageBox.warning(self, "匯出失敗", str(ex))
            return
        qw.QApplication.restoreOverrideCursor()
        self.editor.msg(f"已匯出：{path}")
        qg.QDesktopServices.openUrl(qc.QUrl.fromLocalFile(path))

    def print_file(self):
        from PySide6 import QtPrintSupport as qp
        import tempfile
        dlg = ExportDialog("列印設定", with_format=False, parent=self)
        if dlg.exec() != qw.QDialog.Accepted:
            return
        v = dlg.values()
        printer = qp.QPrinter(qp.QPrinter.HighResolution)
        printer.setPageOrientation(qg.QPageLayout.Landscape if v["landscape"] else qg.QPageLayout.Portrait)
        pd = qp.QPrintDialog(printer, self)
        if pd.exec() != qw.QDialog.Accepted:
            return
        with tempfile.TemporaryDirectory() as tmp:
            png = os.path.join(tmp, "print.png")
            fileio.export(self.editor.doc, png, v["paper"], v["landscape"], v["monochrome"], v["scale"], dpi=300)
            img = qg.QImage(png)
            p = qg.QPainter(printer)
            r = p.viewport()
            size = img.size()
            size.scale(r.size(), qc.Qt.KeepAspectRatio)
            p.setViewport(r.x(), r.y(), size.width(), size.height())
            p.setWindow(img.rect())
            p.drawImage(0, 0, img)
            p.end()
        self.editor.msg("已送出列印")

    def _add_recent(self, path):
        rec = [p for p in self.settings.value("recent", [], list) or [] if p != path]
        rec.insert(0, path)
        self.settings.setValue("recent", rec[:10])
        self._refresh_recent()

    def _refresh_recent(self):
        self.recent_menu.clear()
        for p in self.settings.value("recent", [], list) or []:
            self.recent_menu.addAction(p, lambda p=p: self.open_file(p))

    # ------------------------------------------------------------ ODA
    def choose_oda(self):
        path, _ = qw.QFileDialog.getOpenFileName(self, "選擇 ODAFileConverter.exe", r"C:\Program Files\ODA",
                                                 "ODAFileConverter.exe (ODAFileConverter.exe);;所有檔案 (*)")
        if path:
            self.settings.setValue("oda_path", path)
            fileio.set_oda_path(path)
            self.editor.msg(f"ODA File Converter：{path}")

    def oda_help(self, saving=False):
        found = fileio.find_oda()
        text = ("<b>ODA File Converter</b> 是免費程式，本軟體用它來開啟和儲存各版本的 DWG 檔。<br><br>"
                + (f"目前狀態：<span style='color:green'>已找到</span><br>{found}<br><br>" if found else
                   "目前狀態：<span style='color:red'>尚未安裝</span><br><br>")
                + "安裝步驟：<ol>"
                  f"<li>按下方「開啟下載頁面」，或到 <a href='{ODA_URL}'>{ODA_URL}</a></li>"
                  "<li>在 Windows 那一列下載 <b>Windows 64-bit</b> 版本（.msi）</li>"
                  "<li>下載後雙擊安裝，一直按「下一步」就好</li>"
                  "<li>回到本軟體再存一次檔，會自動找到</li></ol>"
                  "如果裝在其他位置，請用「檔案 → 設定 ODA File Converter 位置」指定。")
        box = qw.QMessageBox(self)
        box.setWindowTitle("存成 DWG 需要 ODA File Converter" if saving else "ODA File Converter")
        box.setTextFormat(qc.Qt.RichText)
        box.setText(text)
        dl = box.addButton("開啟下載頁面", qw.QMessageBox.ActionRole)
        pick = box.addButton("我已安裝，手動指定位置", qw.QMessageBox.ActionRole)
        box.addButton("關閉", qw.QMessageBox.RejectRole)
        box.exec()
        if box.clickedButton() is dl:
            qg.QDesktopServices.openUrl(qc.QUrl(ODA_URL))
        elif box.clickedButton() is pick:
            self.choose_oda()

    def check_oda_on_startup(self):
        """啟動時檢查：已安裝就跳過；沒裝且使用者沒選「不要再問」就詢問自動安裝。"""
        if fileio.find_oda():
            self.cleanup_oda_shortcuts()
            return
        if self.settings.value("oda_never_ask", False, bool):
            return
        self.auto_install_oda(ask=True, reason="第一次使用：開啟和儲存 DWG 需要免費的 ODA File Converter。", startup=True)

    def cleanup_oda_shortcuts(self):
        """之前安裝時留下的 ODA 桌面／開始選單捷徑：自動刪掉（需要時請求一次管理員權限）。"""
        import sys as _sys
        from . import oda_setup
        if not _sys.platform.startswith("win") or self.settings.value("oda_shortcut_declined", False, bool):
            return
        if not oda_setup.find_shortcuts() or not oda_setup.remove_shortcuts_user():
            return
        box = qw.QMessageBox(self)
        box.setWindowTitle("移除 ODA 捷徑")
        box.setText("要幫你移除 ODA File Converter 在桌面和開始選單的捷徑（本程式會在背景使用它，你不需要自己打開）。\n\n"
                    "Windows 會問「是否允許變更」，請按「是」。")
        ok = box.addButton("移除", qw.QMessageBox.AcceptRole)
        box.addButton("不用了", qw.QMessageBox.RejectRole)
        box.exec()
        if box.clickedButton() is not ok:
            self.settings.setValue("oda_shortcut_declined", True)
            return
        try:
            done = oda_setup.remove_shortcuts(tick=qw.QApplication.processEvents)
        except Exception as ex:  # noqa: BLE001
            self.settings.setValue("oda_shortcut_declined", True)
            self.editor.msg(f"沒有移除 ODA 捷徑：{ex}")
            return
        self.editor.msg("已移除 ODA File Converter 的捷徑" if done else "部分 ODA 捷徑無法移除")

    def auto_install_oda(self, ask=True, reason="", startup=False) -> bool:
        from . import oda_setup
        if fileio.find_oda():
            if not ask:
                qw.QMessageBox.information(self, "ODA File Converter", f"已經安裝：\n{fileio.find_oda()}")
            return True
        if ask:
            box = qw.QMessageBox(self)
            box.setWindowTitle("安裝 ODA File Converter")
            box.setTextFormat(qc.Qt.RichText)
            box.setText(f"{reason}<br><br>要現在自動安裝嗎？<br>"
                        "程式會從 ODA 官方網站下載（約 30–60 MB）並安裝，只需要做一次。<br>"
                        "安裝時 Windows 會問「是否允許變更」，請按<b>「是」</b>。<br><br>"
                        f"<span style='color:gray'>按「安裝」表示同意 ODA File Converter 的使用條款"
                        f"（<a href='{ODA_URL}'>官方網站</a>）。</span>")
            yes = box.addButton("安裝", qw.QMessageBox.AcceptRole)
            box.addButton("以後再說", qw.QMessageBox.RejectRole)
            never = box.addButton("不要再問", qw.QMessageBox.DestructiveRole) if startup else None
            box.exec()
            if never is not None and box.clickedButton() is never:
                self.settings.setValue("oda_never_ask", True)
                self.editor.msg("之後不會再詢問。需要時可從「說明 → 自動安裝 ODA File Converter」安裝。")
                return False
            if box.clickedButton() is not yes:
                return False
        dlg = qw.QProgressDialog("正在從 ODA 官方網站下載…", "取消", 0, 100, self)
        dlg.setWindowTitle("安裝 ODA File Converter")
        dlg.setWindowModality(qc.Qt.WindowModal)
        dlg.setMinimumDuration(0)
        dlg.setValue(0)
        qw.QApplication.processEvents()

        def progress(done, total):
            if total:
                dlg.setMaximum(100)
                dlg.setValue(int(done * 100 / total))
            dlg.setLabelText(f"正在下載… {done / 1048576:.1f} MB" + (f" / {total / 1048576:.1f} MB" if total else ""))
            qw.QApplication.processEvents()
            return not dlg.wasCanceled()

        def log(text):
            self.editor.msg(text)
            if text.startswith("安裝"):
                dlg.setLabelText("正在安裝…（Windows 詢問是否允許變更時，請按「是」）")
                dlg.setCancelButton(None)
                dlg.setRange(0, 0)
            qw.QApplication.processEvents()

        try:
            path = oda_setup.download_and_install(progress=progress, log=log, tick=qw.QApplication.processEvents)
        except Exception as ex:  # noqa: BLE001
            dlg.close()
            box = qw.QMessageBox(self)
            box.setWindowTitle("自動安裝沒有成功")
            box.setText(f"{ex}\n\n可以改用手動安裝：開啟下載頁面，下載 Windows 64-bit 版本後雙擊安裝。")
            dl = box.addButton("開啟下載頁面", qw.QMessageBox.ActionRole)
            box.addButton("關閉", qw.QMessageBox.RejectRole)
            box.exec()
            if box.clickedButton() is dl:
                qg.QDesktopServices.openUrl(qc.QUrl(ODA_URL))
            return False
        dlg.close()
        self.settings.setValue("oda_path", path)
        fileio.set_oda_path(path)
        qw.QMessageBox.information(self, "安裝完成", f"ODA File Converter 已安裝，現在可以開啟和儲存 DWG 了。\n{path}")
        return True

    # ------------------------------------------------------------ 線上更新
    def check_update(self, manual=False):
        """manual=False：啟動時在背景檢查，沒網路或沒新版就安靜跳過。"""
        import threading
        from . import updater

        class Relay(qc.QObject):
            done = qc.Signal(object, object)

        self._update_relay = Relay()
        self._update_relay.done.connect(lambda rel, err: self._on_update_checked(rel, err, manual))

        def work():
            try:
                rel = updater.newer_available()
                self._update_relay.done.emit(rel, None)
            except Exception as ex:  # noqa: BLE001
                self._update_relay.done.emit(None, ex)
        if manual:
            self.editor.msg("正在檢查更新…")
        threading.Thread(target=work, daemon=True).start()

    def _on_update_checked(self, rel, err, manual):
        if err is not None:
            if manual:
                qw.QMessageBox.warning(self, "檢查更新", f"無法連線到更新伺服器：\n{err}")
            return
        if rel is None:
            if manual:
                qw.QMessageBox.information(self, "檢查更新", f"目前已是最新版本（v{VERSION}）。")
            return
        if not manual and self.settings.value("skip_version", "", str) == rel["version"]:
            return
        notes = "\n".join(l for l in rel["notes"].splitlines() if l.strip())[:1500]
        box = qw.QMessageBox(self)
        box.setWindowTitle("有新版本")
        box.setIcon(qw.QMessageBox.Information)
        box.setText(f"有新版本 v{rel['version']}（目前 v{VERSION}），要現在更新嗎？\n"
                    f"下載約 {rel['size'] / 1048576:.0f} MB，更新完會自動重新開啟。")
        box.setDetailedText(notes or "（沒有更新說明）")
        now = box.addButton("立即更新", qw.QMessageBox.AcceptRole)
        box.addButton("以後再說", qw.QMessageBox.RejectRole)
        skip = box.addButton("略過這個版本", qw.QMessageBox.DestructiveRole)
        box.exec()
        if box.clickedButton() is skip:
            self.settings.setValue("skip_version", rel["version"])
        elif box.clickedButton() is now:
            self.apply_update(rel)

    def apply_update(self, rel):
        from . import updater
        if updater.is_dev():
            qw.QMessageBox.information(self, "更新", "開發模式不能自動更新，請到 GitHub 下載：\n" + rel["page"])
            return
        target = updater.install_dir()
        if not updater.check_writable(target):
            qw.QMessageBox.warning(self, "更新", f"程式資料夾無法寫入：\n{target}\n\n"
                                   "請把 MechCAD 資料夾移到「文件」或「桌面」再更新。")
            return
        if not self.maybe_save():
            return
        dlg = qw.QProgressDialog("正在下載新版本…", "取消", 0, 100, self)
        dlg.setWindowTitle("更新")
        dlg.setWindowModality(qc.Qt.WindowModal)
        dlg.setMinimumDuration(0)

        def progress(done, total):
            if total:
                dlg.setValue(int(done * 100 / total))
            dlg.setLabelText(f"正在下載新版本… {done / 1048576:.0f} / {total / 1048576:.0f} MB")
            qw.QApplication.processEvents()
            return not dlg.wasCanceled()
        try:
            new_dir = updater.download_and_extract(rel, progress)
            updater.launch_replacer(new_dir, target, os.getpid())
        except Exception as ex:  # noqa: BLE001
            dlg.close()
            qw.QMessageBox.warning(self, "更新失敗", str(ex))
            return
        dlg.close()
        self.editor.dirty = False
        qw.QMessageBox.information(self, "更新", "下載完成，程式將關閉並自動更新，完成後會重新開啟。")
        qw.QApplication.quit()

    # ------------------------------------------------------------ 其他對話框
    def ask_frame(self):
        dlg = FrameDialog(standards.current_standard(self.editor.doc), self)
        if dlg.exec() == qw.QDialog.Accepted:
            return dlg.values()
        return None

    def edit_text(self, e):
        t = e.dxftype()
        cur = e.dxf.text if t == "TEXT" else (e.text if t == "MTEXT" else (e.dxf.get("text", "") or "<>"))
        label = "標註文字（<> 代表量測值，%%c=Ø %%p=± %%d=°）：" if t == "DIMENSION" else "文字內容（%%c=Ø %%p=± %%d=°）："
        val, ok = qw.QInputDialog.getText(self, "編輯文字", label, text=cur)
        if not ok or val == cur:
            return
        self.editor.before_change()
        if t == "TEXT":
            e.dxf.text = val
        elif t == "MTEXT":
            e.text = val
        else:
            e.dxf.text = "" if val == "<>" else val
            e.override().render()
        self.editor._snapshot_taken = False
        self.editor.modified([e])

    def show_help(self):
        rows = []
        group = None
        for g, names, desc in self.editor.commands.HELP:
            if g != group:
                rows.append(f"<tr><td colspan=2 style='padding-top:8px'><b>【{g}】</b></td></tr>")
                group = g
            rows.append(f"<tr><td style='padding-right:16px'><code>{names}</code></td><td>{desc}</td></tr>")
        html = ("<h3>指令一覽</h3><p>在下方指令列輸入指令（大小寫都可以），按 Enter 或空白鍵執行；"
                "空白鍵或滑鼠右鍵＝Enter，Esc＝取消。直接按 Enter 會重複上一個指令。</p>"
                "<p><b>座標輸入：</b> <code>100,50</code> 絕對座標　<code>@30,0</code> 相對座標　"
                "<code>@50&lt;30</code> 距離50、角度30°　只輸入 <code>25</code> ＝沿滑鼠方向 25</p>"
                "<p><b>滑鼠：</b>滾輪縮放、按住中鍵平移、雙擊中鍵縮放全部；由左往右框＝完全框住才選，由右往左框＝碰到就選；Shift＋點選＝取消選取</p>"
                "<p><b>特殊符號：</b> <code>%%c</code>＝Ø　<code>%%p</code>＝±　<code>%%d</code>＝°</p>"
                "<table>" + "".join(rows) + "</table>")
        dlg = qw.QDialog(self)
        dlg.setWindowTitle("指令一覽")
        dlg.resize(760, 720)
        lay = qw.QVBoxLayout(dlg)
        tb = qw.QTextBrowser()
        tb.setHtml(html)
        lay.addWidget(tb)
        dlg.exec()

    def about(self):
        qw.QMessageBox.about(self, "關於", f"<b>{APP_NAME}</b> {VERSION}<br>機械製圖用的 DWG/DXF 編輯工具。<br><br>"
                             "使用的開源元件：ezdxf（MIT）、Qt for Python／PySide6（LGPL）、"
                             "LibreDWG（GPL，讀取 DWG 用）、PyMuPDF（AGPL，匯出 PDF 用）。<br>"
                             "DWG 存檔透過使用者另外安裝的 ODA File Converter。")

    # ------------------------------------------------------------ 拖放與關閉
    @staticmethod
    def _cad_files(mime) -> list:
        if mime is None or not mime.hasUrls():
            return []
        return [u.toLocalFile() for u in mime.urls()
                if u.isLocalFile() and u.toLocalFile().lower().endswith((".dwg", ".dxf"))]

    def eventFilter(self, obj, ev):
        t = ev.type()
        if t in (qc.QEvent.DragEnter, qc.QEvent.DragMove, qc.QEvent.Drop):
            files = self._cad_files(ev.mimeData())
            if files:
                if t == qc.QEvent.Drop:
                    ev.setDropAction(qc.Qt.CopyAction)
                    ev.accept()
                    self.statusBar().clearMessage()
                    if len(files) > 1:
                        self.editor.msg(f"一次只能開一個檔案，開啟第一個：{os.path.basename(files[0])}")
                    # 等拖放動作結束後再開檔（開檔可能跳出「要先儲存嗎」視窗）
                    qc.QTimer.singleShot(0, lambda p=files[0]: (self.raise_(), self.activateWindow(), self.open_file(p)))
                else:
                    ev.setDropAction(qc.Qt.CopyAction)
                    ev.accept()
                    if t == qc.QEvent.DragEnter:
                        self.statusBar().showMessage(f"放開滑鼠即可開啟：{os.path.basename(files[0])}")
                return True
        elif t == qc.QEvent.DragLeave and obj is self:
            self.statusBar().clearMessage()
        return super().eventFilter(obj, ev)

    def closeEvent(self, ev):
        if self.maybe_save():
            self.settings.setValue("geometry", self.saveGeometry())
            self.settings.setValue("state", self.saveState())
            ev.accept()
        else:
            ev.ignore()

    def restore_layout(self):
        g = self.settings.value("geometry")
        s = self.settings.value("state")
        if g is not None:
            self.restoreGeometry(g)
        if s is not None:
            self.restoreState(s)
