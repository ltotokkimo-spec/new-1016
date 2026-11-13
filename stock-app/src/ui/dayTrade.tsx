// 選股頁「當沖」分頁（11/12 使用者）：盤中成交量即時排名前 15 名，停在這頁時每 10 秒更新名次與成交量。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchRankQuotes } from "../data/volRank";
import { loadDtFlags } from "../data/dtFlags";
import { flagOf, type DtFlag, type DtLists } from "../engine/dtFlags";
import { livePolling, marketOpen } from "../data/twLive";
import { fmtValue, rankPool, rankQuotes, type RankBy, type RankRow } from "../engine/volRank";
import type { Scored } from "../engine/score";
import { pretty, taipeiToday } from "../lib/dates";
import { useStore } from "../store";
import { cls, fmtPct, fmtPrice } from "./common";

export const RANK_MS = 10_000;
/** 台北時間平日 9:00 以前 */
const beforeOpen = () => { const d = new Date(Date.now() + 8 * 3600_000); return d.getUTCHours() < 9; };
const TOP = 15;
const load = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* 不記也沒關係 */ } };

function Flags({ f }: { f: DtFlag }) {
  return <>
    {f.disposal && <span class="dt-flag bad" data-testid="dt-flag" title={f.disposal.reason}>處置{f.disposal.period ? ` ${f.disposal.period}` : ""}</span>}
    {f.noDayTrade && !f.disposal && <span class="dt-flag bad" data-testid="dt-flag">不可當沖</span>}
    {f.noSellFirst && !f.disposal && <span class="dt-flag warn" data-testid="dt-flag">暫停先賣後買</span>}
  </>;
}

function Move({ m }: { m: RankRow["move"] }) {
  if (m === "new") return <span class="rank-move new">新進</span>;
  if (!m) return <span class="rank-move muted">—</span>;
  return <span class={`rank-move ${m > 0 ? "up" : "down"}`}>{m > 0 ? `↑${m}` : `↓${-m}`}</span>;
}

export function DayTradeRank({ open }: { open: (s: Scored, list?: Scored[]) => void }) {
  const st = useStore((s) => ({ tw: s.tw.scored, etf: s.etf.scored, status: s.tw.status, asOf: s.tw.asOf }));
  const [by, setBy0] = useState<RankBy>(() => (load("dtBy", "vol") === "value" ? "value" : "vol"));
  const [withEtf, setEtf0] = useState(() => load("dtEtf", "0") === "1");
  const setBy = (v: RankBy) => { setBy0(v); save("dtBy", v); };
  const setEtf = (v: boolean) => { setEtf0(v); save("dtEtf", v ? "1" : "0"); };
  const pool = useMemo(() => rankPool(st.tw, withEtf ? st.etf : [], 200, withEtf ? 40 : 0), [st.tw, st.etf, withEtf]);
  const [snap, setSnap] = useState<{ rows: RankRow[]; at: number; time?: string; date?: string; failed: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const prev = useRef(new Map<string, number>());
  const quotesRef = useRef<Parameters<typeof rankQuotes>[0]>([]);
  const busyRef = useRef(false);
  // 處置股、可當沖標的：一天抓一次
  const [flags, setFlags] = useState<{ lists: DtLists; status: Record<string, string> } | undefined>();
  useEffect(() => { loadDtFlags().then(setFlags).catch(() => {}); }, []);

  const pull = async () => {
    if (busyRef.current || !pool.length) return;
    busyRef.current = true; setBusy(true);
    try {
      const r = await fetchRankQuotes(pool);
      const qs = Object.values(r.quotes);
      if (!qs.length) { setSnap((s) => ({ rows: s?.rows ?? [], at: s?.at ?? 0, time: s?.time, date: s?.date, failed: r.failed, total: r.total })); return; }
      quotesRef.current = qs;
      const rows = rankQuotes(qs, by, TOP, prev.current);
      prev.current = new Map(rows.map((x) => [x.code, x.rank]));
      const time = qs.reduce((m, q) => (q.time > m ? q.time : m), "");
      const date = qs.reduce((m, q) => (q.date > m ? q.date : m), "");
      setSnap({ rows, at: Date.now(), time, date, failed: r.failed, total: r.total });
    } finally { busyRef.current = false; setBusy(false); }
  };
  // 換排序方式：用手上的報價馬上重排（不用等下一輪），名次升降從這次重新算
  useEffect(() => {
    if (!quotesRef.current.length) return;
    const rows = rankQuotes(quotesRef.current, by, TOP);
    prev.current = new Map(rows.map((x) => [x.code, x.rank]));
    setSnap((s) => (s ? { ...s, rows } : s));
  }, [by]);
  useEffect(() => {
    prev.current = new Map();
    void pull();
    const t = setInterval(() => { if (livePolling() && document.visibilityState !== "hidden") void pull(); }, RANK_MS);
    return () => clearInterval(t);
  }, [pool]);

  // 開盤前（今天還沒有成交量）：先列前一個交易日的排名
  const yesterday = useMemo(() => rankQuotes(pool.map((s) => ({ code: s.code, name: s.name, price: s.close, prevClose: s.close / (1 + (s.chg1d ?? 0)), volume: s.volume })), by, TOP), [pool, by]);
  const live = !!snap?.rows.length;
  const rows = live ? snap!.rows : yesterday;
  const today = taipeiToday();
  const isOpen = marketOpen();
  // 證交所的資料日期比今天舊：週末休市、平日開盤前（11/13 使用者 05:59 看到「今天沒有交易」是錯的）、或平日收盤後仍是舊日期（休市日）
  const wd = new Date(Date.now() + 8 * 3600_000).getUTCDay();
  const oldWhy = wd === 0 || wd === 6 ? "今天休市" : beforeOpen() ? "還沒開盤" : "今天休市";
  const state = !live ? (st.asOf ? `還沒有今天的成交，先列 ${pretty(st.asOf)} 收盤的排名` : "")
    : snap!.date && snap!.date < today ? `${oldWhy}，先列 ${pretty(snap!.date)} 收盤的排名`
    : isOpen ? `${snap!.time?.slice(0, 8) ?? ""} 即時・每 10 秒更新` : `今天收盤的排名（${snap!.time?.slice(0, 5) ?? ""}）`;
  const find = (code: string) => st.tw.find((x) => x.code === code) ?? st.etf.find((x) => x.code === code);
  const list = rows.map((r) => find(r.code)).filter((x): x is Scored => !!x);

  if (st.status !== "ready" && !st.tw.length) return <div class="empty">台股資料下載中，下載完就會開始排名…</div>;
  return (
    <div data-testid="daytrade">
      <div class="section-title">
        <span>盤中成交{by === "vol" ? "量" : "值"}排行・前 {TOP} 名</span>
        <span class="muted" style={{ fontSize: "12px", fontWeight: 400 }} data-testid="dt-state">{busy && !live ? "抓即時資料中…" : state}</span>
      </div>
      <div class="row" style={{ gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
        <div class="seg" role="group" aria-label="排序">
          <button aria-pressed={by === "vol"} onClick={() => setBy("vol")} data-testid="dt-by-vol">成交量</button>
          <button aria-pressed={by === "value"} onClick={() => setBy("value")} data-testid="dt-by-value">成交值</button>
        </div>
        <button class="chip" aria-pressed={withEtf} onClick={() => setEtf(!withEtf)} data-testid="dt-etf">含 ETF</button>
        <button class="chip" disabled={busy} onClick={() => void pull()} data-testid="dt-refresh">{busy ? "更新中…" : "立即更新"}</button>
      </div>
      {rows.length === 0 ? <div class="empty">{busy ? "抓即時資料中…" : "抓不到即時資料，請檢查網路後按「立即更新」"}</div> : (
        <div class="list" data-testid="dt-list">
          <div class="rank-item rank-head muted" data-testid="dt-head"><span>名次</span><span>股票名稱 代號</span><span style={{ textAlign: "right" }}>成交價（元）<br />漲跌幅</span><span style={{ textAlign: "right" }}>名次<br />變化</span></div>
          {rows.map((r) => (
            <button class="item rank-item" onClick={() => { const s = find(r.code); if (s) open(s, list); }} data-testid="dt-row" data-code={r.code} data-lots={r.lots}>
              <span class="rank-no num">{r.rank}</span>
              <div style={{ minWidth: 0 }}>
                <div class="name">{r.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.code}</span></div>
                <div class="sub num"><span class={by === "vol" ? "rank-key" : ""}>成交量 {r.lots.toLocaleString("zh-TW")} 張</span></div>
                <div class="sub num"><span class={by === "value" ? "rank-key" : ""}>成交值 {fmtValue(r.value)}元</span><Flags f={flagOf(r.code, find(r.code)?.market, flags?.lists)} /></div>
              </div>
              <div class="px num">
                <div class={`p ${cls(r.chg)}`}>{fmtPrice(r.price)}</div>
                <div class={`c ${cls(r.chg)}`}>{fmtPct(r.chg, 2)}</div>
              </div>
              {live && isOpen ? <Move m={r.move} /> : <span />}
            </button>
          ))}
        </div>
      )}
      {snap && snap.failed > 0 && <div class="muted" style={{ fontSize: "11.5px", marginTop: "6px" }} data-testid="dt-failed">這次有 {snap.failed}／{snap.total} 批沒抓到，排名可能不完整</div>}
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }} data-testid="dt-note" data-flags={flags ? JSON.stringify(flags.status) : ""}>
        標示：<span class="dt-flag bad">處置</span> 處置期間（須預收款券，實際上不能當沖）、<span class="dt-flag bad">不可當沖</span> 不在證交所／櫃買的現股當沖標的、<span class="dt-flag warn">暫停先賣後買</span> 只能先買後賣。上櫃股票只標處置（櫃買的可當沖標的沒有公開資料可抓）。{flags && !flags.lists.eligible.TWSE ? "這次沒抓到證交所的可當沖標的，只標處置。" : ""}{!flags ? "（標示資料下載中）" : ""}<br />
        資料來源：證交所即時報價（約每 5 秒更新，比券商看盤軟體慢幾秒；每 100 檔問一次，一輪約 2～3 秒抓完）。從前一個交易日成交量最大的 200 檔股票{withEtf ? "與 40 檔 ETF" : ""}即時排名；成交值是「現價 × 成交量」估計。名次箭頭是跟上一次更新（10 秒前）比。當沖風險高，請自行設停損，這不是投資建議。
      </p>
    </div>
  );
}
