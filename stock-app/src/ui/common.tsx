import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Rating } from "../engine/score";

export const fmtPct = (x: number | undefined, digits = 1) =>
  x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

export const cls = (x: number | undefined) => (x === undefined || !Number.isFinite(x) || x === 0 ? "" : x > 0 ? "up" : "down");

export function fmtPrice(x: number, market?: string) {
  if (!Number.isFinite(x)) return "—";
  const d = market === "US" ? 2 : x >= 100 ? 1 : 2;
  return x.toLocaleString("zh-TW", { minimumFractionDigits: market === "US" ? 2 : 0, maximumFractionDigits: d });
}

export function fmtMoney(x: number, market?: string) {
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (market === "US") return `${sign}$${a.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 億`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(1)} 萬`;
  return `${sign}${Math.round(a).toLocaleString("zh-TW")}`;
}

export const lots = (shares: number | undefined) =>
  shares === undefined || !Number.isFinite(shares) ? "—" : `${shares > 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;

export function RatingPill({ rating }: { rating: Rating | "無資料" }) {
  const c = rating === "買入" ? "buy" : rating === "觀望" ? "hold" : rating === "離場" ? "exit" : "none";
  return <span class={`pill ${c}`}>{rating}</span>;
}

export function Progress({ p }: { p?: { done: number; total: number; label: string } }) {
  const pct = p ? Math.round((p.done / Math.max(p.total, 1)) * 100) : 0;
  return (
    <div class="progress" role="status">
      <div>{p ? `下載中：${p.label}` : "準備中"}</div>
      <div class="bar"><i style={{ width: `${pct}%` }} /></div>
      <div class="muted num" style={{ fontSize: "12px" }}>{pct}%・第一次下載約需 1~2 分鐘，之後只補新資料</div>
    </div>
  );
}

export function Sheet({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ComponentChildren; actions?: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div class="sheet" role="dialog" aria-label={title}>
      <header>
        <button class="iconbtn" aria-label="返回" onClick={onClose}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6" /></svg>
        </button>
        <h2>{title}</h2>
        {actions}
      </header>
      <div class="body">{children}</div>
    </div>
  );
}

/** 把 Claude 回覆的 Markdown 轉成畫面（只支援標題、條列、粗體，其餘當純文字，不執行任何 HTML） */
export function Markdown({ text }: { text: string }) {
  const out: preact.JSX.Element[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>);
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };
  let table: string[][] | null = null;
  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    out.push(
      <div class="table-wrap" key={out.length}><table>
        <thead><tr>{head.map((c) => <th>{inline(c)}</th>)}</tr></thead>
        <tbody>{body.map((r) => <tr>{r.map((c) => <td>{inline(c)}</td>)}</tr>)}</tbody>
      </table></div>);
    table = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    // Markdown 表格：| a | b |；分隔列 |---|---| 略過
    if (/^\|.*\|$/.test(line)) {
      flush();
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      (table ??= []).push(line.slice(1, -1).split("|").map((c) => c.trim()));
      continue;
    }
    if (!line && table) continue; // 表格列之間的空行
    flushTable();
    if (!line || /^---+$/.test(line)) { flush(); continue; }
    if ((m = /^#{1,4}\s+(.*)$/.exec(line))) { flush(); out.push(<h3 key={out.length}>{inline(m[1])}</h3>); continue; }
    if ((m = /^[-*•]\s+(.*)$/.exec(line))) {
      if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; }
      list.items.push(m[1]); continue;
    }
    if ((m = /^\d+[.)、]\s*(.*)$/.exec(line))) {
      // 「1. **評等與結論**」這類短的編號行當段落標題，長的當清單
      const body = m[1];
      if (/^\*\*[^*]+\*\*[:：]?$/.test(body) || body.length <= 24) { flush(); out.push(<h3 key={out.length}>{inline(line)}</h3>); continue; }
      if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; }
      list.items.push(body); continue;
    }
    flush();
    out.push(<p key={out.length}>{inline(line)}</p>);
  }
  flush();
  flushTable();
  return <div class="report">{out}</div>;
}

function inline(t: string) {
  const parts = t.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}

/** 收盤價走勢＋MA20/MA60＋成交量（Canvas） */
export function PriceChart({ bars }: { bars: { date: string; close: number; volume: number }[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || bars.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const col = (n: string) => css.getPropertyValue(n).trim();
    const padL = 6, padR = 52, padT = 10, volH = 40, gap = 8;
    const priceH = h - padT - volH - gap - 16;
    const closes = bars.map((b) => b.close);
    const ma = (n: number) => closes.map((_, i) => (i + 1 >= n ? closes.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n : NaN));
    const ma20 = ma(20), ma60 = ma(60);
    const all = [...closes, ...ma20, ...ma60].filter(Number.isFinite);
    const lo = Math.min(...all), hi = Math.max(...all);
    const x = (i: number) => padL + (i / (bars.length - 1)) * (w - padL - padR);
    const y = (v: number) => padT + (1 - (v - lo) / (hi - lo || 1)) * priceH;
    // 格線與價格刻度
    g.strokeStyle = col("--line"); g.fillStyle = col("--muted"); g.lineWidth = 1; g.font = "11px sans-serif"; g.textBaseline = "middle";
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3, yy = y(v);
      g.beginPath(); g.moveTo(padL, yy); g.lineTo(w - padR, yy); g.stroke();
      g.fillText(v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(v >= 100 ? 0 : 2), w - padR + 6, yy);
    }
    const line = (vals: number[], color: string, width: number) => {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath();
      let started = false;
      vals.forEach((v, i) => { if (!Number.isFinite(v)) return; if (!started) { g.moveTo(x(i), y(v)); started = true; } else g.lineTo(x(i), y(v)); });
      g.stroke();
    };
    const upTrend = closes[closes.length - 1] >= closes[0];
    // 收盤線下方淡色面積
    g.beginPath(); g.moveTo(x(0), y(closes[0]));
    closes.forEach((v, i) => g.lineTo(x(i), y(v)));
    g.lineTo(x(closes.length - 1), padT + priceH); g.lineTo(x(0), padT + priceH); g.closePath();
    g.fillStyle = col(upTrend ? "--up-bg" : "--down-bg"); g.fill();
    line(ma60, col("--muted"), 1);
    line(ma20, col("--accent"), 1.2);
    line(closes, col(upTrend ? "--up" : "--down"), 1.8);
    // 最後一點
    const li = closes.length - 1;
    g.fillStyle = col(upTrend ? "--up" : "--down"); g.beginPath(); g.arc(x(li), y(closes[li]), 3, 0, Math.PI * 2); g.fill();
    // 成交量
    const vmax = Math.max(...bars.map((b) => b.volume).filter(Number.isFinite), 1);
    const vy = h - 16 - volH;
    const bw = Math.max(1, (w - padL - padR) / bars.length - 1);
    bars.forEach((b, i) => {
      const up = i === 0 || b.close >= bars[i - 1].close;
      g.fillStyle = col(up ? "--up-bg" : "--down-bg");
      const hh = (b.volume / vmax) * volH;
      g.fillRect(x(i) - bw / 2, vy + volH - hh, bw, hh);
    });
    // 日期
    g.fillStyle = col("--muted"); g.textBaseline = "alphabetic";
    const d = (s: string) => `${+s.slice(4, 6)}/${+s.slice(6, 8)}`;
    g.textAlign = "left"; g.fillText(d(bars[0].date), padL, h - 2);
    g.textAlign = "right"; g.fillText(d(bars[li].date), w - padR, h - 2);
    g.textAlign = "left";
  }, [bars]);
  return (
    <div>
      <canvas ref={ref} class="chart" aria-label="股價走勢圖" />
      <div class="row muted" style={{ fontSize: "12px", gap: "14px" }}>
        <span>— 收盤</span><span style={{ color: "var(--accent)" }}>— 20 日均線</span><span>— 60 日均線</span>
      </div>
    </div>
  );
}
