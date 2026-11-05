import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import type { Rating } from "../engine/score";

export const fmtPct = (x: number | undefined, digits = 1) =>
  x === undefined || !Number.isFinite(x) ? "—" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

/** 漲停：價格變成實心紅底白字的方塊；跌停：實心綠底白字（台股紅漲綠跌）。沒有漲跌停就原樣顯示價格 */
export function LimitPx({ s, children }: { s?: "up" | "down"; children: any }) {
  if (!s) return <>{children}</>;
  return <span class={`limit-px ${s}`} data-testid="limit-light" data-limit={s} title={s === "up" ? "漲停" : "跌停"}>{children}</span>;
}

export const cls = (x: number | undefined) => (x === undefined || !Number.isFinite(x) || x === 0 ? "" : x > 0 ? "up" : "down");

/** 帶正負號的損益金額：台股 +1,234／-567（台幣，不加幣別字樣）；美股 +$1,234／-$567 */
export function fmtSigned(x: number, market?: string) {
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : x > 0 ? "+" : "";
  const n = Math.round(Math.abs(x)).toLocaleString("en-US");
  return market === "US" ? `${sign}$${n}` : `${sign}${n}`;
}

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

export function RatingPill({ rating }: { rating: Rating | "無資料" | "無評等" | "參考" }) {
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

/** 個股頁切換箭頭：金色三角形，光帶往箭頭方向掃（左箭頭往左、右箭頭往右）；手機開「減少動態效果」時不動 */
const reduceMotion = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
export function FlowArrow({ dir }: { dir: "l" | "r" }) {
  const id = `navflow-${dir}`, l = dir === "l";
  return (
    <svg viewBox="0 0 24 24" width="60" height="60" aria-hidden="true" data-testid={`flow-arrow-${dir}`}>
      <defs>
        <linearGradient id={id} x1={l ? 1 : -1} x2={l ? 2 : 0} y1="0" y2="0">
          <stop offset="0" stop-color="#7a4f00" /><stop offset=".42" stop-color="#b77a07" /><stop offset=".5" stop-color="#fff2b8" /><stop offset=".58" stop-color="#b77a07" /><stop offset="1" stop-color="#7a4f00" />
          {!reduceMotion() && <animate attributeName="x1" values={l ? "1;-1" : "-1;1"} dur="1.8s" repeatCount="indefinite" />}
          {!reduceMotion() && <animate attributeName="x2" values={l ? "2;0" : "0;2"} dur="1.8s" repeatCount="indefinite" />}
        </linearGradient>
      </defs>
      <path d={l ? "M17 3 L5 12 L17 21 Z" : "M7 3 L19 12 L7 21 Z"} fill={`url(#${id})`} />
    </svg>
  );
}

/** titleNav：個股頁「◀ 名稱／代號 ▶」切換上一檔、下一檔（名稱與代號分兩行置中） */
export interface TitleNav { name: string; sub: string; prev: () => void; next: () => void; prevName: string; nextName: string; pos: number; total: number }
export function Sheet({ title, onClose, children, actions, titleNav }: { title: string; onClose: () => void; children: ComponentChildren; actions?: ComponentChildren; titleNav?: TitleNav }) {
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
        {titleNav ? (
          <div class="row" style={{ flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: "0" }} data-testid="detail-nav">
            <button class="iconbtn navarrow" aria-label={`上一檔：${titleNav.prevName}`} title={`上一檔：${titleNav.prevName}`} onClick={titleNav.prev} data-testid="detail-prev-stock">
              <FlowArrow dir="l" />
            </button>
            <div style={{ minWidth: 0, textAlign: "center", flex: "0 1 auto" }}>
              <h2 style={{ flex: "none", lineHeight: 1.25 }}>{titleNav.name} <span class="num" style={{ display: "block", fontSize: "15px", fontWeight: 600 }}>{titleNav.sub}</span></h2>
              <div class="muted num" style={{ fontSize: "10.5px", lineHeight: 1.2 }} data-testid="detail-pos">{titleNav.pos}/{titleNav.total}</div>
            </div>
            <button class="iconbtn navarrow" aria-label={`下一檔：${titleNav.nextName}`} title={`下一檔：${titleNav.nextName}`} onClick={titleNav.next} data-testid="detail-next">
              <FlowArrow dir="r" />
            </button>
          </div>
        ) : <h2>{title}</h2>}
        {titleNav && !actions && <span style={{ width: "38px", flex: "none" }} aria-hidden="true" />}{/* 和左邊返回鍵同寬，讓名稱置中 */}
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
    if ((m = /^\d+(?:[)、]\s*|\.(?!\d)\s*)(.*)$/.exec(line))) { // 「3.2% 的年增率」這種小數不是編號
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
