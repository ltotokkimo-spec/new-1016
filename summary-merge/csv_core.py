# -*- coding: utf-8 -*-
"""測試結果 CSV（operator_log.csv）讀取與匯出。"""
import csv
import io
import os
from datetime import datetime

DEFAULT_CSV_NAME = "operator_log.csv"
DEFAULT_CHANNELS = 6
CHANNEL_METRICS = [("ch_tof_ns", "tof_ns"), ("ch_contrast", "contrast"), ("ch_cnr", "cnr"),
                   ("ch_noise", "noise"), ("ch_pkpk", "pkpk"), ("ch_baseline", "baseline")]
BASE_COLS = [("timestamp", "timestamp", "e"), ("date", "date", "e"), ("time", "time", "e"),
             ("opid", "opid", "e"), ("sn", "sn", "w"), ("test_status", "Test Status", "w"),
             ("verdict", "verdict", "w"), ("hold_channels", "hold_channels", "w"),
             ("fail_channels", "fail_channels", "w")]
TAIL_COLS = [("station", "station", "w"), ("station_name", "station_name", "w")]

# (底色, 字色)
VERDICT_COLORS = {"PASS": ("#66FF33", "#000000"), "FAIL": ("#FF0000", "#FFFFFF"), "HOLD": ("#FFC000", "#000000")}
CH_FAIL = ("#FFC7CE", "#C00000")
CH_HOLD = ("#FFEB9C", "#9C5700")
DUP = ("#D9B3FF", "#4B0082")


def decode_bytes(raw):
    for enc in ("utf-8-sig", "cp950"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", "replace")


def parse_dt(date_s, time_s, ts_s):
    cands = []
    if date_s and time_s:
        cands.append(f"{date_s.strip()} {time_s.strip()}")
    if ts_s:
        cands.append(ts_s.strip())
    for s in cands:
        s = s.replace("-", "/")
        for fmt in ("%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M"):
            try:
                return datetime.strptime(s, fmt)
            except ValueError:
                pass
    return None


def split_channels(s):
    out = set()
    for tok in (s or "").replace(",", ";").split(";"):
        tok = tok.strip().upper()
        if tok.startswith("CH") and tok[2:].isdigit():
            out.add(int(tok[2:]))
    return out


def split_values(s):
    return [x.strip() for x in (s or "").split(";")] if s else []


def load_records(path):
    """讀取一個 CSV，回傳 (records, channel_count)。"""
    with open(path, "rb") as f:
        raw = f.read()
    reader = csv.reader(io.StringIO(decode_bytes(raw), newline=""))
    try:
        header = [h.strip() for h in next(reader)]
    except StopIteration:
        return [], DEFAULT_CHANNELS
    records, n_ch = [], 0
    name = os.path.basename(path)
    for line_no, row in enumerate(reader, 2):
        if not any(c.strip() for c in row):
            continue
        if len(row) < len(header):
            continue                                # 測試程式寫到一半的列，下次再讀
        d = {h: row[i].strip() for i, h in enumerate(header)}
        if not d.get("sn") and not d.get("verdict"):
            continue
        dt = parse_dt(d.get("date"), d.get("time"), d.get("timestamp"))
        contrast = split_values(d.get("ch_contrast"))
        n_ch = max(n_ch, len(contrast))
        records.append({
            "_line": line_no, "_dt": dt, "_raw": d, "_file": name, "_path": path,
            "_hold": split_channels(d.get("hold_channels")),
            "_fail": split_channels(d.get("fail_channels")),
            "_contrast": contrast,
            "timestamp": dt.strftime("%Y/%m/%d %H:%M") if dt else d.get("timestamp", ""),
            "date": dt.strftime("%Y/%m/%d") if dt else d.get("date", ""),
            "time": dt.strftime("%H:%M:%S") if dt else d.get("time", ""),
            "opid": d.get("opid", ""),
            "sn": d.get("sn", ""),
            "verdict": d.get("verdict", "").upper(),
            "hold_channels": d.get("hold_channels", ""),
            "fail_channels": d.get("fail_channels", ""),
            "station": d.get("station", ""),
            "station_name": d.get("station_name", ""),
        })
    return records, n_ch or DEFAULT_CHANNELS


def finalize(records):
    """多個 CSV 合併後：依時間排序、標記同站重覆測試、cal2 站別的 FT / RT。"""
    records.sort(key=lambda r: (r["_dt"] or datetime.min, r["_file"], r["_line"]))
    total, seen = {}, {}
    for r in records:
        k = (r["station"], r["sn"])
        total[k] = total.get(k, 0) + 1
    for r in records:
        k = (r["station"], r["sn"])
        seen[k] = seen.get(k, 0) + 1
        r["__dup_total"] = total[k] if r["sn"] else 1
        r["__dup_no"] = seen[k]
        if (r["station"] or "").strip().lower() == "cal2":
            r["test_status"] = "FT" if seen[k] == 1 else f"RT{seen[k] - 1}"
        else:
            r["test_status"] = "NA"
    return records


def all_columns(n_ch):
    return BASE_COLS + [(f"CH{i}", f"CH{i}", "e") for i in range(n_ch)] + TAIL_COLS


def cell_text(rec, key):
    if key.startswith("CH") and key[2:].isdigit():
        i = int(key[2:])
        return rec["_contrast"][i] if i < len(rec["_contrast"]) else ""
    return str(rec.get(key, "") or "")


def export_xlsx(path, cols, rows):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    wb = Workbook()
    ws = wb.active
    ws.title = "result"
    thin = Side(style="thin", color="000000")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)

    def fill(c):
        return PatternFill("solid", fgColor=c.lstrip("#"))
    for j, (_k, title, _a) in enumerate(cols, 1):
        c = ws.cell(1, j, title)
        c.fill, c.font, c.border = fill("#444444"), Font(bold=True, color="FFFFFF"), border
        c.alignment = Alignment(horizontal="center")
    for i, r in enumerate(rows, 2):
        for j, (k, _t, a) in enumerate(cols, 1):
            v = cell_text(r, k)
            try:
                v = float(v) if k.startswith("CH") and v else v
            except ValueError:
                pass
            c = ws.cell(i, j, v)
            c.border = border
            c.alignment = Alignment(horizontal="left" if a == "w" else "right")
            bg = None
            if k == "verdict" and r["verdict"] in VERDICT_COLORS:
                bg, fg = VERDICT_COLORS[r["verdict"]]
            elif k == "sn" and r.get("__dup_total", 1) >= 2:
                bg, fg = DUP
            elif k.startswith("CH") and k[2:].isdigit():
                n = int(k[2:])
                if n in r["_fail"]:
                    bg, fg = CH_FAIL
                elif n in r["_hold"]:
                    bg, fg = CH_HOLD
            if bg:
                c.fill, c.font = fill(bg), Font(color=fg.lstrip("#"), bold=True)
    for j, (k, t, _a) in enumerate(cols, 1):
        w = max([len(t)] + [len(cell_text(r, k)) for r in rows[:500]]) + 2
        ws.column_dimensions[ws.cell(1, j).column_letter].width = min(max(w, 6), 40)
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    wb.save(path)


def export_csv(path, cols, rows):
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([t for _k, t, _a in cols])
        for r in rows:
            w.writerow([cell_text(r, k) for k, _t, _a in cols])
