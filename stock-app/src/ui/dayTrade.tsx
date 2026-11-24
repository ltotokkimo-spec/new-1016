// 選股頁「當沖」分頁（11/12 使用者）：盤中成交量即時排名前 15 名，停在這頁時每 10 秒更新名次與成交量。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchRankQuotes } from "../data/volRank";
import { loadDtFlags } from "../data/dtFlags";
import { flagOf, type DtFlag, type DtLists } from "../engine/dtFlags";
import { livePolling, marketOpen } from "../data/twLive";
import { dtPicks, fmtValue, rankPool, rankQuotes, type DtPick, type RankBy, type RankRow } from "../engine/volRank";
import type { Scored } from "../engine/score";
import { pretty, taipeiToday } from "../lib/dates";
import { useStore } from "../store";
import { cls, fmtPct, fmtPrice } from "./common";

export const RANK_MS = 10_000;
/** 台北時間平日 9:00 以前 */
const beforeOpen = () => { const d = new Date(Date.now() + 8 * 3600_000); return d.getUTCHours() < 9; };
const TOP = 15;
/** 今天交易時段（9:00～13:30）已經過的比例；收盤後與非交易時間＝1 */
const sessionFrac = () => { const d = new Date(Date.now() + 8 * 3600_000), m = d.getUTCHours() * 60 + d.getUTCMinutes() - 9 * 60; return m <= 0 ? 1 : Math.min(1, m / 270); };
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
  const [pickMode, setPick0] = useState(() => load("dtPick", "0") === "1"); // 11/25：當沖推薦
  const setPick = (v: boolean) => { setPick0(v); save("dtPick", v ? "1" : "0"); };
  const [picks, setPicks] = useState<DtPick[]>([]);
  const [withEtf, setEtf0] = useState(() => load("dtEtf", "0") === "1");
  const setBy = (v: RankBy) => { setBy0(v); save("dtBy", v); };
  const setEtf = (v: boolean) => { setEtf0(v); save("dtEtf", v ? "1" : "0"); };
  const pool = useMemo(() => rankPool(st.tw, withEtf ? st.etf : [], 200, withEtf ? 40 : 0), [st.tw, st.etf, withEtf]);
  const [snap, setSnap] = useState<{ rows: RankRow[]; at: number; time?: string; date?: string; failed: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const prev = useRef(new Map<string, number>());
  const quotesRef = useRef<Parameters<typeof rankQuotes>[0]>([]);
  const busyRef = useRef(false);
  // 每 10 秒的自動更新是開頁時設好的計時器，要讀「現在」選的排序（11/13 盤中測試：切到成交值後，下一輪又被排回成交量）
  const byRef = useRef(by);
  byRef.current = by;
  // 處置股、可當沖標的：一天抓一次
  const [flags, setFlags] = useState<{ lists: DtLists; status: Record<string, string> } | undefined>();
  useEffect(() => { loadDtFlags().then(setFlags).catch(() => {}); }, []);
  const flagsRef = useRef(flags);
  flagsRef.current = flags;

  const pull = async () => {
    if (busyRef.current || !pool.length) return;
    busyRef.current = true; setBusy(true);
    try {
      const r = await fetchRankQuotes(pool);
      const qs = Object.values(r.quotes);
      if (!qs.length) { setSnap((s) => ({ rows: s?.rows ?? [], at: s?.at ?? 0, time: s?.time, date: s?.date, failed: r.failed, total: r.total })); return; }
      quotesRef.current = qs;
      const rows = rankQuotes(qs, byRef.current, TOP, prev.current);
      setPicks(dtPicks(qs as any, new Map(pool.map((x) => [x.code, x.volume ?? 0])), sessionFrac(), (c) => { const f = flagOf(c, (st.tw.find((x) => x.code === c) ?? st.etf.find((x) => x.code === c))?.market, flagsRef.current?.lists); return !!(f.disposal || f.noDayTrade); }));
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
        <span>{pickMode ? "當沖推薦・前 10 名" : `盤中成交${by === "vol" ? "量" : "值"}排行・前 ${TOP} 名`}</span>
        <span class="muted" style={{ fontSize: "12px", fontWeight: 400 }} data-testid="dt-state">{busy && !live ? "抓即時資料中…" : state}</span>
      </div>
      <div class="row" style={{ gap: "8px", marginBottom: "8px", flexWrap: "wrap" }}>
        <div class="seg" role="group" aria-label="排序">
          <button aria-pressed={!pickMode && by === "vol"} onClick={() => { setPick(false); setBy("vol"); }} data-testid="dt-by-vol">成交量</button>
          <button aria-pressed={!pickMode && by === "value"} onClick={() => { setPick(false); setBy("value"); }} data-testid="dt-by-value">成交值</button>
          <button aria-pressed={pickMode} onClick={() => setPick(true)} data-testid="dt-by-pick">當沖推薦</button>
        </div>
        <button class="chip" aria-pressed={withEtf} onClick={() => setEtf(!withEtf)} data-testid="dt-etf">含 ETF</button>
        <button class="chip" disabled={busy} onClick={() => void pull()} data-testid="dt-refresh">{busy ? "更新中…" : "立即更新"}</button>
      </div>
      {pickMode ? <DtPickList picks={picks} live={live && !(snap!.date && snap!.date < today)} open={(c) => { const x = find(c); if (x) open(x, picks.map((p) => find(p.code)).filter((y): y is Scored => !!y)); }} /> : rows.length === 0 ? <div class="empty">{busy ? "抓即時資料中…" : "抓不到即時資料，請檢查網路後按「立即更新」"}</div> : (
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

/** 當沖推薦清單（11/25）：適合當沖的標的，依「成交值、振幅、量能放大」綜合分數排序 */
function DtPickList({ picks, live, open }: { picks: DtPick[]; live: boolean; open: (code: string) => void }) {
  if (!live) return <div class="empty" data-testid="dt-pick-empty">當沖推薦要用今天的成交量與振幅，開盤（9:00）後才會出現；開盤後 15～30 分鐘較準。</div>;
  if (!picks.length) return <div class="empty" data-testid="dt-pick-empty">目前沒有同時符合「成交值夠大、振幅 1.5% 以上、沒有漲跌停鎖住、可當沖」的股票。</div>;
  const biasCls = (_b: DtPick["bias"]) => "muted"; // 中性描述，不用紅綠暗示方向
  return (
    <div class="list" data-testid="dt-pick-list">
      {picks.map((p) => (
        <button class="item rank-item" onClick={() => open(p.code)} data-testid="dt-pick-row" data-code={p.code}>
          <span class="rank-no num">{p.rank}</span>
          <div style={{ minWidth: 0 }}>
            <div class="name">{p.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{p.code}</span> <span class={biasCls(p.bias)} style={{ fontSize: "12px" }}>今天在{p.bias}</span></div>
            <div class="sub num">成交值 {fmtValue(p.value)}元・振幅 {(p.range * 100).toFixed(1)}%・量能 {p.relVol.toFixed(1)} 倍</div>
            <div class="sub num muted">價位在今天區間的 {Math.round(p.pos * 100)}%・推薦分數 {p.score}</div>
          </div>
          <div class="px num">
            <div class={`p ${cls(p.chg)}`}>{fmtPrice(p.price)}</div>
            <div class={`c ${cls(p.chg)}`}>{fmtPct(p.chg, 2)}</div>
          </div>
          <span />
        </button>
      ))}
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "6px" }} data-testid="dt-pick-note">
        怎麼挑：只看「適合當沖」，不預測漲跌。分數＝成交值排名 40%（好進出、價差小）＋今天振幅 30%（6% 以上滿分）＋量能放大 30%（和昨天同時段比，3 倍以上滿分）。排除漲停／跌停鎖住、處置股與不可當沖的股票。
        「今天在高檔／低檔／區間中段」只描述現價在今天最高最低之間的位置，不代表該做多或做空。回測（上市近半年、用日 K 近似）：推薦股隔天平均振幅 7.0%（一般 5.0%），確實比較有波動；但照前一天的強弱方向做多或放空，隔天平均 −0.8%、只有 41% 賺錢，當沖成本約 0.44% 也要算進去。方向請自己判斷，進場前先設好停損。
      </p>
    </div>
  );
}
