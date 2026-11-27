# -*- coding: utf-8 -*-
"""Summary 合併核心邏輯：找檔、合併、統計、輸出 Excel。"""
import os
import re
from collections import Counter, OrderedDict
from datetime import datetime

from openpyxl import Workbook, load_workbook
from openpyxl.chart import BarChart, LineChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

SHEETS = ["Summary_SN", "TestRecord"]
FILE_PREFIX = "summary"          # 不分大小寫
EXTS = (".xlsx", ".xlsm")
OUTPUT_PREFIX = "Merged_"        # 輸出檔不以 Summary 開頭，避免下次被當成來源

HEADER_FILL = PatternFill("solid", fgColor="D9D9D9")
TITLE_FILL = PatternFill("solid", fgColor="BDD7EE")
TOTAL_FILL = PatternFill("solid", fgColor="F2F2F2")
PASS_FILL = PatternFill("solid", fgColor="C6EFCE")
FAIL_FILL = PatternFill("solid", fgColor="FFC7CE")
BOLD = Font(bold=True)
TITLE_FONT = Font(bold=True, size=12)

EXTRA_FRONT = ["Date"]           # 加在最前面
EXTRA_BACK = ["Source_File"]     # 加在最後面


# ---------------------------------------------------------------- 讀檔
def find_summary_files(root, exclude=None):
    exclude = os.path.abspath(exclude) if exclude else None
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            low = name.lower()
            if low.startswith("~$"):            # Excel 開啟中的暫存檔
                continue
            if low.startswith(FILE_PREFIX) and low.endswith(EXTS):
                p = os.path.join(dirpath, name)
                if os.path.abspath(p) != exclude:
                    found.append(p)
    return sorted(found)


def file_date(path):
    m = re.search(r"(20\d{6})", os.path.basename(path))
    return m.group(1) if m else ""


def parse_ts(v):
    if isinstance(v, datetime):
        return v
    try:
        return datetime.strptime(str(v).strip(), "%Y_%m_%d_%H_%M_%S")
    except (ValueError, TypeError):
        return None


def ts_key(rec):
    return rec["__ts"] or datetime.max


def read_sheet(ws):
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    records = []
    for r in rows[1:]:
        if r is None or all(v is None or str(v).strip() == "" for v in r):
            continue
        records.append({h: (r[i] if i < len(r) else None) for i, h in enumerate(headers) if h})
    return [h for h in headers if h], records


def merge(files, log=print):
    headers = {s: [] for s in SHEETS}
    data = {s: [] for s in SHEETS}
    widths = {s: {} for s in SHEETS}
    file_info = []

    for path in files:
        name = os.path.basename(path)
        try:
            wb = load_workbook(path, data_only=True)
        except Exception as e:  # noqa: BLE001
            log(f"  [略過] 無法開啟 {name}: {e}")
            file_info.append((path, "無法開啟", 0, 0))
            continue
        counts = {}
        fdate = file_date(path)
        for s in SHEETS:
            if s not in wb.sheetnames:
                counts[s] = 0
                continue
            ws = wb[s]
            hdr, recs = read_sheet(ws)
            for h in hdr:
                if h not in headers[s]:
                    headers[s].append(h)
            for i, h in enumerate(hdr):
                w = ws.column_dimensions[get_column_letter(i + 1)].width
                if w:
                    widths[s][h] = max(widths[s].get(h, 0), w)
            for rec in recs:
                ts = parse_ts(rec.get("Timestamp"))
                rec["__ts"] = ts
                if ts:
                    rec["Date"] = ts.strftime("%Y-%m-%d")
                elif fdate:
                    rec["Date"] = f"{fdate[:4]}-{fdate[4:6]}-{fdate[6:]}"
                else:
                    rec["Date"] = ""
                rec["Source_File"] = name
            data[s].extend(recs)
            counts[s] = len(recs)
        wb.close()
        file_info.append((path, "OK", counts["Summary_SN"], counts["TestRecord"]))
        log(f"  {name}: Summary_SN {counts['Summary_SN']} 筆, TestRecord {counts['TestRecord']} 筆")

    # 同 SN + 同 Timestamp 才算重複（例如同一個檔被複製到兩個資料夾）；
    # 同 SN 不同時間的測試全部保留，以 Date / Timestamp 區分。
    for s in SHEETS:
        seen, out = set(), []
        for rec in sorted(data[s], key=ts_key):
            k = (str(rec.get("Timestamp")), str(rec.get("SN")))
            if k not in seen:
                seen.add(k)
                out.append(rec)
        data[s] = out
        headers[s] = EXTRA_FRONT + [h for h in headers[s] if h not in EXTRA_FRONT + EXTRA_BACK] + EXTRA_BACK
    return headers, data, widths, file_info


# ---------------------------------------------------------------- 統計
def _is(rec, key, val):
    return str(rec.get(key) or "").strip().lower() == val


def _aborted(rec):
    return "abort" in str(rec.get("Detail") or "").lower() or _is(rec, "Verdict", "aborted")


def _pct(a, b):
    return a / b if b else None


def build_stats(data):
    summ, tr = data["Summary_SN"], data["TestRecord"]
    dates = sorted({r["Date"] for r in summ + tr if r["Date"]})

    daily = []
    for d in dates + ["合計"]:
        S = [r for r in summ if d == "合計" or r["Date"] == d]
        T = [r for r in tr if d == "合計" or r["Date"] == d]
        sp = sum(_is(r, "Result", "pass") for r in S)
        sf = sum(_is(r, "Result", "fail") for r in S)
        sa = sum(_aborted(r) for r in S)
        tp = sum(_is(r, "Result", "pass") for r in T)
        ta = sum(_aborted(r) for r in T)
        secs = [r["Total_s"] for r in T if isinstance(r.get("Total_s"), (int, float)) and not _aborted(r)]
        daily.append(OrderedDict([
            ("日期", d),
            ("SN數", len({r.get("SN") for r in S})),
            ("Pass", sp),
            ("Fail", sf),
            ("其中Aborted", sa),
            ("良率", _pct(sp, sp + sf)),
            ("良率(排除Aborted)", _pct(sp, sp + sf - sa)),
            ("測試次數", len(T)),
            ("測試Pass次數", tp),
            ("測試Aborted次數", ta),
            ("平均測試秒數", round(sum(secs) / len(secs), 1) if secs else None),
        ]))

    def crosstab(rows, key):
        cats = Counter(str(r.get(key) or "(空白)") for r in rows)
        order = [c for c, _ in cats.most_common()]
        table = []
        for c in order:
            row = OrderedDict([(key, c)])
            for d in dates:
                row[d] = sum(1 for r in rows if r["Date"] == d and str(r.get(key) or "(空白)") == c)
            row["合計"] = cats[c]
            row["占比"] = _pct(cats[c], len(rows))
            table.append(row)
        return table

    return {
        "daily": daily,
        "detail": crosstab(summ, "Detail"),
        "spec": crosstab(summ, "Spec_class"),
        "contrast": crosstab(summ, "Contrast_class"),
        "dates": dates,
    }


# ---------------------------------------------------------------- 輸出
def _header(ws, row, values):
    for i, v in enumerate(values, 1):
        c = ws.cell(row, i, v)
        c.fill, c.font = HEADER_FILL, BOLD
        c.alignment = Alignment(horizontal="center")


def _table(ws, start_row, title, rows, pct_cols=()):
    ws.cell(start_row, 1, title).font = TITLE_FONT
    ws.cell(start_row, 1).fill = TITLE_FILL
    if not rows:
        ws.cell(start_row + 1, 1, "（無資料）")
        return start_row + 3, start_row + 1, start_row + 1
    keys = list(rows[0].keys())
    hr = start_row + 1
    _header(ws, hr, keys)
    for i, row in enumerate(rows):
        r = hr + 1 + i
        for j, k in enumerate(keys, 1):
            c = ws.cell(r, j, row[k])
            if k in pct_cols:
                c.number_format = "0.0%"
            if row[keys[0]] == "合計":
                c.font, c.fill = BOLD, TOTAL_FILL
    return hr + len(rows) + 2, hr, hr + len(rows)


def write_output(out_path, headers, data, widths, file_info):
    stats = build_stats(data)
    wb = Workbook()
    wb.remove(wb.active)

    # 統計頁
    ws = wb.create_sheet("Statistics")
    r = 1
    ws.cell(r, 1, f"Summary 合併統計　{stats['dates'][0] if stats['dates'] else ''} ~ "
                  f"{stats['dates'][-1] if stats['dates'] else ''}").font = Font(bold=True, size=14)
    ws.cell(r + 1, 1, "良率以 Summary_SN 為準；測試次數以 TestRecord 為準").font = Font(italic=True, color="808080")
    r = 4
    r, d_hr, d_last = _table(ws, r, "每日良率", stats["daily"], pct_cols=("良率", "良率(排除Aborted)"))
    chart_anchor_row = r
    r += 18                                   # 預留圖表空間
    r, *_ = _table(ws, r, "Detail 分類（Summary_SN）", stats["detail"], pct_cols=("占比",))
    r, *_ = _table(ws, r, "Spec_class 分類（Summary_SN）", stats["spec"], pct_cols=("占比",))
    r, *_ = _table(ws, r, "Contrast_class 分類（Summary_SN）", stats["contrast"], pct_cols=("占比",))
    ws.column_dimensions["A"].width = 24
    for i in range(2, 16):
        ws.column_dimensions[get_column_letter(i)].width = 13
    ws.freeze_panes = "B1"

    n_days = d_last - d_hr - 1                # 不含合計
    if n_days >= 1:
        bar = BarChart()
        bar.title = "每日 Pass / Fail 與良率"
        bar.y_axis.title = "SN數"
        bar.add_data(Reference(ws, min_col=3, max_col=4, min_row=d_hr, max_row=d_hr + n_days), titles_from_data=True)
        cats = Reference(ws, min_col=1, min_row=d_hr + 1, max_row=d_hr + n_days)
        bar.set_categories(cats)
        bar.grouping = "stacked"
        bar.overlap = 100
        line = LineChart()
        line.add_data(Reference(ws, min_col=6, min_row=d_hr, max_row=d_hr + n_days), titles_from_data=True)
        line.y_axis.axId = 200
        line.y_axis.title = "良率"
        line.y_axis.number_format = "0%"
        line.y_axis.scaling.min = 0
        line.y_axis.scaling.max = 1
        line.y_axis.crosses = "max"
        bar += line
        bar.width, bar.height = 22, 8
        ws.add_chart(bar, f"A{chart_anchor_row}")

    # 資料頁
    for s in SHEETS:
        ws = wb.create_sheet(s)
        hdr = headers[s]
        if not hdr:
            continue
        _header(ws, 1, hdr)
        for c in ws[1]:
            c.alignment = Alignment()
        res_col = hdr.index("Result") + 1 if "Result" in hdr else None
        for rec in data[s]:
            ws.append([rec.get(h) for h in hdr])
            if res_col:
                cell = ws.cell(ws.max_row, res_col)
                v = str(cell.value or "").strip().lower()
                if v == "pass":
                    cell.fill = PASS_FILL
                elif v == "fail":
                    cell.fill = FAIL_FILL
        for i, h in enumerate(hdr, 1):
            ws.column_dimensions[get_column_letter(i)].width = {"Date": 11, "Source_File": 26}.get(h, widths[s].get(h, 14))
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(hdr))}{max(ws.max_row, 1)}"

    # 來源檔清單
    ws = wb.create_sheet("SourceFiles")
    _header(ws, 1, ["File", "Date", "Status", "Summary_SN rows", "TestRecord rows", "Path"])
    for path, status, n1, n2 in file_info:
        ws.append([os.path.basename(path), file_date(path), status, n1, n2, path])
    for col, w in zip("ABCDEF", (28, 10, 10, 16, 16, 90)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"

    wb.save(out_path)
    return stats


def default_output(src, files):
    dates = sorted(d for d in (file_date(f) for f in files) if d)
    tag = f"{dates[0]}-{dates[-1]}" if dates else datetime.now().strftime("%Y%m%d")
    return os.path.join(src, f"{OUTPUT_PREFIX}Summary_{tag}.xlsx")


def run(src, output=None, log=print):
    """完整流程，回傳 (輸出路徑, stats)。"""
    src = os.path.abspath(src)
    if not os.path.isdir(src):
        raise FileNotFoundError(f"找不到目錄: {src}")
    log(f"來源目錄: {src}")
    files = find_summary_files(src, exclude=output)
    if not files:
        raise FileNotFoundError("找不到任何 Summary 開頭的 Excel 檔")
    log(f"找到 {len(files)} 個檔案：")
    headers, data, widths, file_info = merge(files, log=log)
    out = output or default_output(src, files)
    stats = write_output(out, headers, data, widths, file_info)
    tot = stats["daily"][-1]
    log("")
    log(f"Summary_SN {len(data['Summary_SN'])} 筆，TestRecord {len(data['TestRecord'])} 筆")
    if tot["良率"] is not None:
        log(f"整體良率 {tot['良率']:.1%}（Pass {tot['Pass']} / Fail {tot['Fail']}）")
    log(f"輸出：{out}")
    return out, stats
