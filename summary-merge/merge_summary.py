# -*- coding: utf-8 -*-
"""
Summary 合併統計工具（初版）

用法：
    python merge_summary.py                    # 跳出視窗選來源目錄
    python merge_summary.py <來源目錄>          # 指定來源目錄
    python merge_summary.py <來源目錄> -o 輸出.xlsx

會往來源目錄底下（含所有子目錄）找檔名以 "Summary" 開頭的 .xlsx，
把每個檔案的 Summary_SN 與 TestRecord 兩個工作表合併，依 Timestamp 排序，
輸出成跟原檔相同格式的一份 Excel。
"""
import argparse
import os
import re
import sys
from datetime import datetime

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

SHEETS = ["Summary_SN", "TestRecord"]
FILE_PREFIX = "summary"          # 不分大小寫
EXTS = (".xlsx", ".xlsm")
OUTPUT_PREFIX = "Merged_"        # 輸出檔不以 Summary 開頭，避免下次被當成來源

HEADER_FILL = PatternFill("solid", fgColor="D9D9D9")
PASS_FILL = PatternFill("solid", fgColor="C6EFCE")
FAIL_FILL = PatternFill("solid", fgColor="FFC7CE")
HEADER_FONT = Font(bold=True)


def find_summary_files(root):
    found = []
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            low = name.lower()
            if low.startswith("~$"):           # Excel 開啟中的暫存檔
                continue
            if low.startswith(FILE_PREFIX) and low.endswith(EXTS):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def file_date(path):
    m = re.search(r"(\d{8})", os.path.basename(path))
    return m.group(1) if m else ""


def read_sheet(ws):
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    headers = [str(h).strip() if h is not None else "" for h in rows[0]]
    while headers and headers[-1] == "":
        headers.pop()
    records = []
    for r in rows[1:]:
        if r is None or all(v is None or str(v).strip() == "" for v in r):
            continue
        records.append({h: (r[i] if i < len(r) else None) for i, h in enumerate(headers) if h})
    return [h for h in headers if h], records


def ts_key(rec):
    """Timestamp 格式 2026_11_25_13_52_01，轉成 datetime 排序；解析失敗排最後。"""
    v = rec.get("Timestamp")
    if isinstance(v, datetime):
        return v
    try:
        return datetime.strptime(str(v).strip(), "%Y_%m_%d_%H_%M_%S")
    except (ValueError, TypeError):
        return datetime.max


def merge(files, log=print):
    headers = {s: [] for s in SHEETS}
    data = {s: [] for s in SHEETS}
    widths = {s: {} for s in SHEETS}
    file_info = []

    for path in files:
        try:
            wb = load_workbook(path, read_only=False, data_only=True)
        except Exception as e:  # noqa: BLE001
            log(f"  [略過] 無法開啟 {path}: {e}")
            file_info.append((path, "無法開啟", 0, 0))
            continue
        counts = {}
        for s in SHEETS:
            if s not in wb.sheetnames:
                counts[s] = 0
                continue
            ws = wb[s]
            hdr, recs = read_sheet(ws)
            for h in hdr:                       # 欄位聯集，保持原順序
                if h not in headers[s]:
                    headers[s].append(h)
            for rec in recs:
                rec["__src"] = path
            data[s].extend(recs)
            counts[s] = len(recs)
            for col, dim in ws.column_dimensions.items():
                if dim.width:
                    widths[s][col] = max(widths[s].get(col, 0), dim.width)
        wb.close()
        file_info.append((path, "OK", counts["Summary_SN"], counts["TestRecord"]))
        log(f"  {os.path.basename(path)}: Summary_SN {counts['Summary_SN']} 筆, TestRecord {counts['TestRecord']} 筆")

    # TestRecord：同 Timestamp+SN 視為重複（例如同一個檔案被複製到兩個資料夾）
    seen, tr = set(), []
    for rec in sorted(data["TestRecord"], key=ts_key):
        k = (str(rec.get("Timestamp")), str(rec.get("SN")))
        if k not in seen:
            seen.add(k)
            tr.append(rec)
    data["TestRecord"] = tr

    # Summary_SN：每個 SN 一筆，跨日期時保留最新的一筆（與原檔每日 Summary 的規則一致）
    latest = {}
    for rec in sorted(data["Summary_SN"], key=ts_key):
        latest[str(rec.get("SN"))] = rec
    data["Summary_SN"] = sorted(latest.values(), key=ts_key)

    return headers, data, widths, file_info


def write_output(out_path, headers, data, widths, file_info):
    wb = Workbook()
    wb.remove(wb.active)
    for s in SHEETS:
        ws = wb.create_sheet(s)
        hdr = headers[s]
        if not hdr:
            continue
        ws.append(hdr)
        for c in ws[1]:
            c.fill, c.font = HEADER_FILL, HEADER_FONT
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
        for i in range(1, len(hdr) + 1):
            col = get_column_letter(i)
            ws.column_dimensions[col].width = widths[s].get(col, 14)
        ws.freeze_panes = "A2"
        ws.auto_filter.ref = f"A1:{get_column_letter(len(hdr))}{max(ws.max_row, 1)}"

    # 附加：來源檔清單，方便核對
    ws = wb.create_sheet("SourceFiles")
    ws.append(["File", "Date", "Status", "Summary_SN rows", "TestRecord rows", "Path"])
    for c in ws[1]:
        c.fill, c.font = HEADER_FILL, HEADER_FONT
    for path, status, n1, n2 in file_info:
        ws.append([os.path.basename(path), file_date(path), status, n1, n2, path])
    for col, w in zip("ABCDEF", (28, 10, 10, 16, 16, 80)):
        ws.column_dimensions[col].width = w
    ws.freeze_panes = "A2"

    wb.save(out_path)


def pick_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
    except ImportError:
        return None
    root = tk.Tk()
    root.withdraw()
    path = filedialog.askdirectory(title="選擇 Summary 來源目錄")
    root.destroy()
    return path or None


def main():
    ap = argparse.ArgumentParser(description="合併來源目錄下所有 Summary*.xlsx")
    ap.add_argument("source", nargs="?", help="來源目錄（不填會跳出視窗選擇）")
    ap.add_argument("-o", "--output", help="輸出檔路徑（預設放在來源目錄）")
    args = ap.parse_args()

    src = args.source or pick_folder()
    if not src:
        print("未指定來源目錄。用法: python merge_summary.py <來源目錄>")
        return 1
    src = os.path.abspath(src)
    if not os.path.isdir(src):
        print(f"找不到目錄: {src}")
        return 1

    print(f"來源目錄: {src}")
    files = find_summary_files(src)
    if args.output:
        files = [f for f in files if os.path.abspath(f) != os.path.abspath(args.output)]
    if not files:
        print("找不到任何 Summary 開頭的 Excel 檔。")
        return 1
    print(f"找到 {len(files)} 個檔案：")

    headers, data, widths, file_info = merge(files)

    dates = sorted(d for d in (file_date(f) for f in files) if d)
    tag = f"{dates[0]}-{dates[-1]}" if dates else datetime.now().strftime("%Y%m%d")
    out = args.output or os.path.join(src, f"{OUTPUT_PREFIX}Summary_{tag}.xlsx")
    write_output(out, headers, data, widths, file_info)

    print(f"\n合併完成：Summary_SN {len(data['Summary_SN'])} 筆（每個 SN 取最新），"
          f"TestRecord {len(data['TestRecord'])} 筆")
    print(f"輸出：{out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
