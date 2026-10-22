// 詳情頁「法人」分頁：最近一個月每天的三大法人買賣超（張）柱狀圖、股價線，和逐日表。
// 資料用證交所／櫃買每日三大法人（和選股用的同一份，過去的日子存在手機裡，只補新的一天）；今天的資料公布後（通常下午 3～4 點）自動更新。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { TwLoader, type FRow } from "../data/twLoader";
import { buildFlowSeries, flowDates, FLOW_DAYS, sumFlows, type FlowDay } from "../engine/flowSeries";
import { isWeekday, pretty, taipeiHour, taipeiToday } from "../lib/dates";
import { getFetcher, getKv } from "../store";

type Who = "total" | "foreign" | "trust" | "dealer";
const WHO: { k: Who; label: string }[] = [
  { k: "total", label: "三大法人" }, { k: "foreign", label: "外資" }, { k: "trust", label: "投信" }, { k: "dealer", label: "自營商" },
];
const POLL_MS = 120_000;
const TODAY_WAIT_MS = 20_000;

const sgn = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "muted");
const fmtLots = (v: number) => (Math.round(v) === 0 ? "0" : `${v > 0 ? "+" : "-"}${Math.abs(Math.round(v)).toLocaleString()}`);
const fmtAxis = (v: number) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1)}k` : String(Math.round(v)));

export function FlowsPanel({ code, market, bars, livePrice }: { code: string; market: "TWSE" | "TPEX"; bars: { date: string; close: number }[]; livePrice?: number }) {
  const [flows, setFlows] = useState<Map<string, FRow[]>>(new Map());
  const [failed, setFailed] = useState(0);
  const [done, setDone] = useState(false);
  const flowsRef = useRef(flows);
  const loader = useMemo(() => new TwLoader(getFetcher(), getKv()), []);
  const now = Date.now();
  const dates = useMemo(() => flowDates(bars.map((b) => b.date), taipeiToday(now), taipeiHour(now), isWeekday(taipeiToday(now))), [bars]);

  const loadOne = async (d: string, isToday: boolean) => {
    const get = () => (market === "TPEX" ? loader.tpexFlows(d) : loader.twseFlows(d));
    // 今天的資料還沒公布時，證交所有時候不回應，最多等 20 秒
    return isToday ? Promise.race([get(), new Promise<null>((r) => setTimeout(() => r(null), TODAY_WAIT_MS))]) : get();
  };

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const today = taipeiToday();
    const pass = async (all: boolean) => {
      let bad = 0;
      for (const d of [...dates].reverse()) { // 先抓最新的，使用者最想看
        if (!alive) return;
        if (!all && flowsRef.current.has(d)) continue;
        try {
          const rows = await loadOne(d, d === today);
          if (rows && alive) {
            const next = new Map(flowsRef.current); next.set(d, rows);
            flowsRef.current = next; setFlows(next);
          }
        } catch { bad++; }
      }
      if (alive) { setFailed(bad); setDone(true); }
      // 今天的資料還沒出來：每 2 分鐘再試（只重抓今天）
      const todayPending = dates.includes(today) && !flowsRef.current.has(today);
      if (alive && todayPending) timer = setTimeout(() => pass(false), POLL_MS);
    };
    flowsRef.current = new Map(); setFlows(flowsRef.current); setDone(false);
    pass(true);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [code, dates.join(",")]);

  const barsWithLive = useMemo(() => {
    const t = taipeiToday();
    const last = bars[bars.length - 1];
    return livePrice && dates.includes(t) && (!last || last.date < t) ? [...bars, { date: t, close: livePrice }] : bars;
  }, [bars, livePrice, dates.join(",")]);
  const rows = useMemo(() => buildFlowSeries(barsWithLive, flows, code), [barsWithLive, flows, code]);
  return <FlowsView rows={rows} dates={dates} done={done} failed={failed} market={market} />;
}

/** 畫面本身（不碰網路）：方便單獨測試 */
export function FlowsView({ rows, dates, done, failed, market }: { rows: FlowDay[]; dates: string[]; done: boolean; failed: number; market: "TWSE" | "TPEX" }) {
  const [who, setWho] = useState<Who>("total");
  const sum = sumFlows(rows);

  if (!rows.length) return <div class="empty" data-testid="flows-empty">{done ? (failed ? "法人資料下載失敗，稍後再試" : "這段期間沒有法人資料") : "載入法人資料中…"}</div>;
  const missing = dates.length - rows.length;
  const latest = rows[rows.length - 1];
  return (
    <div class="stack" data-testid="flows-panel">
      <div class="seg" role="group" aria-label="法人別" style={{ justifySelf: "start" }}>
        {WHO.map((w) => <button key={w.k} aria-pressed={who === w.k} onClick={() => setWho(w.k)} data-testid={`flow-${w.k}`}>{w.label}</button>)}
      </div>
      <div class="muted" style={{ fontSize: "12px" }}>柱狀：{WHO.find((w) => w.k === who)!.label}每日買賣超（張，左軸）　<span style={{ color: "var(--fg)" }}>—</span> 收盤價（右軸）</div>
      <FlowChart rows={rows} who={who} />
      <div class="num" style={{ fontSize: "13px", lineHeight: 1.7 }} data-testid="flow-sum">
        <b>近 {rows.length} 個交易日累計</b>（張）：
        {WHO.map((w) => <span key={w.k}>　{w.label} <b class={sgn(sum[w.k])}>{fmtLots(sum[w.k])}</b></span>)}
      </div>
      <table class="num" style={{ width: "100%", fontSize: "12.5px", borderCollapse: "collapse" }} data-testid="flow-table">
        <thead><tr class="muted">
          <th style={{ textAlign: "left", fontWeight: 400, padding: "4px 0" }}>日期</th>
          {WHO.map((w) => <th key={w.k} style={{ textAlign: "right", fontWeight: 400 }}>{w.label}</th>)}
        </tr></thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.date} style={{ borderTop: "1px solid var(--line)" }}>
              <td style={{ padding: "5px 0" }}>{pretty(r.date)}</td>
              {WHO.map((w) => <td key={w.k} class={sgn(r[w.k])} style={{ textAlign: "right" }}>{fmtLots(r[w.k])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
        單位：張（1 張 = 1,000 股），紅色是買超、綠色是賣超。資料來自{market === "TPEX" ? "櫃買中心" : "證交所"}每日三大法人買賣超，三大法人 = 外資 + 投信 + 自營商。
        {missing > 0 && !done ? `　還在下載，已取得 ${rows.length}／${dates.length} 天。` : ""}
        {missing > 0 && done ? `　有 ${missing} 天沒有資料（休市或還沒公布）。` : ""}
        {dates.includes(taipeiToday()) && latest.date !== taipeiToday() ? "　今天的法人資料通常下午 3～4 點公布，公布後會自動更新。" : ""}
      </div>
    </div>
  );
}

/** 柱狀圖：選定法人的每日買賣超（左軸，張）＋收盤價線（右軸） */
function FlowChart({ rows, who }: { rows: FlowDay[]; who: Who }) {
  const W = 340, H = 200, padL = 40, padR = 42, padT = 8, padB = 20;
  const n = rows.length;
  const vals = rows.map((r) => r[who]);
  const m = Math.max(...vals.map(Math.abs), 1) * 1.1;
  const closes = rows.map((r) => r.close).filter(Number.isFinite);
  const pLo = Math.min(...closes), pHi = Math.max(...closes), pPad = (pHi - pLo) * 0.1 || 1;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / n, bw = Math.max(2, slot * 0.62);
  const x = (i: number) => padL + (i + 0.5) * slot;
  const y = (v: number) => padT + (1 - (v + m) / (2 * m)) * plotH;
  const py = (p: number) => padT + (1 - (p - (pLo - pPad)) / (pHi - pLo + 2 * pPad)) * plotH;
  const path = rows.map((r, i) => (Number.isFinite(r.close) ? `${i ? "L" : "M"}${x(i).toFixed(1)},${py(r.close).toFixed(1)}` : "")).join("");
  const ticks = [m * 0.9, 0, -m * 0.9];
  const dateIdx = [...new Set([0, 1, 2, 3].map((k) => Math.round(((n - 1) * k) / 3)))];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="三大法人買賣超與股價" data-testid="flow-chart">
      {ticks.map((t, i) => <g key={i}>
        <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--line)" stroke-opacity={t === 0 ? 1 : 0.6} />
        <text x={padL - 4} y={y(t) + 3} font-size="10" fill="var(--muted)" text-anchor="end">{fmtAxis(t)}</text>
      </g>)}
      {rows.map((r, i) => {
        const v = r[who], y0 = y(0), y1 = y(v);
        return <rect key={r.date} x={x(i) - bw / 2} y={Math.min(y0, y1)} width={bw} height={Math.max(1, Math.abs(y1 - y0))} fill={v >= 0 ? "var(--up)" : "var(--down)"} />;
      })}
      <path d={path} fill="none" stroke="var(--fg)" stroke-opacity="0.75" stroke-width="1.4" />
      <text x={W - padR + 4} y={py(pHi) + 3} font-size="10" fill="var(--muted)">{pHi.toFixed(pHi >= 100 ? 0 : 1)}</text>
      <text x={W - padR + 4} y={py(pLo) + 3} font-size="10" fill="var(--muted)">{pLo.toFixed(pLo >= 100 ? 0 : 1)}</text>
      {dateIdx.map((i) => <text key={i} x={Math.min(W - padR, Math.max(padL + 10, x(i)))} y={H - 4} font-size="10" fill="var(--muted)" text-anchor="middle">{pretty(rows[i].date)}</text>)}
    </svg>
  );
}
