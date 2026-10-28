// 主動式 ETF 的詳情頁：這檔 ETF 最近買了、賣了哪些成份股，以及目前的完整持股（資料來自每天比對各 ETF 公布的持股）。
import { useEffect, useMemo, useState } from "preact/hooks";
import { etfHoldings } from "../lib/activeEtf";
import { prettyW } from "../lib/dates";
import { refreshActiveEtf, refreshActiveLive, useStore } from "../store";
import { cls } from "./common";

export const isActiveEtf = (code: string) => /^00\d{3}A$/.test(code);
const lots = (shares: number) => `${shares > 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;
const plain = (shares: number) => `${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;

export function EtfHoldingsPanel({ code }: { code: string }) {
  const active = useStore((s) => s.activeEtf);
  const scored = useStore((s) => s.tw.scored);
  const [days, setDays] = useState<1 | 5>(1);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const old = (t?: number) => !t || Date.now() - t > 10 * 60_000;
    if (!active || old(active.fetchedAt)) refreshActiveEtf().then(() => refreshActiveLive());
    else if (old(active.liveAt)) refreshActiveLive();
  }, [code]);
  const names = useMemo(() => new Map(scored.map((s) => [s.code, s.name])), [scored]);
  const r = useMemo(() => etfHoldings(active?.data, code, days), [active, code, days]);
  if (!r) return <div class="card empty" data-testid="etf-holdings">{active?.error ? active.error : active ? "這檔主動式 ETF 的持股還沒有資料（每天收盤後公布，約 17:00 後更新）" : "載入持股中…"}</div>;
  const buys = r.moves.filter((m) => m.delta > 0), sells = r.moves.filter((m) => m.delta < 0);
  const span = r.used.length ? `${prettyW(r.used[r.used.length - 1])}${r.used.length > 1 ? ` ～ ${prettyW(r.used[0])}` : ""}` : "";
  const nm = (c: string) => names.get(c) ?? "";
  const Row = ({ c, sub, right, sub2, tone }: { c: string; sub: string; right: string; sub2?: string; tone: number }) => (
    <div class="item" style={{ cursor: "default" }} data-testid="hold-row">
      <div style={{ minWidth: 0 }}>
        <div class="name">{nm(c) || "股票"} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{c}</span></div>
        <div class="sub">{sub}</div>
      </div>
      <div class="px"><div class={`p num ${cls(tone)}`}>{right}</div>{sub2 && <div class={`c num ${cls(tone)}`}>{sub2}</div>}</div>
    </div>
  );
  const moveRow = (m: (typeof r.moves)[number]) => {
    const tag = m.before === 0 && m.delta > 0 ? "新增" : m.after === 0 && m.delta < 0 ? "清倉" : m.delta > 0 ? "加碼" : "減碼";
    const pct = m.before > 0 ? `（${m.delta > 0 ? "+" : ""}${((m.delta / m.before) * 100).toFixed(1)}%）` : "";
    return <Row c={m.code} sub={`持有 ${Math.round(m.before / 1000).toLocaleString("zh-TW")} → ${Math.round(m.after / 1000).toLocaleString("zh-TW")} 張${pct}`} right={lots(m.delta)} sub2={tag} tone={m.delta} />;
  };
  const shown = all ? r.hold : r.hold.slice(0, 15);
  return (
    <div data-testid="etf-holdings">
      <div class="row" style={{ justifyContent: "space-between", margin: "2px 2px 6px" }}>
        <div class="muted" style={{ fontSize: "13px" }} data-testid="hold-summary">
          持股資料日 {prettyW(r.date)}・台股 {r.n} 檔{r.used.length ? `・買進 ${buys.length} 檔、賣出 ${sells.length} 檔` : "・買賣要累積到第二份持股才看得到"}
        </div>
        <div class="chips" style={{ margin: 0 }}>
          <button class="chip" aria-pressed={days === 1} onClick={() => setDays(1)}>最新一天</button>
          <button class="chip" aria-pressed={days === 5} onClick={() => setDays(5)}>近 5 日</button>
        </div>
      </div>
      {r.used.length > 0 && <div class="muted" style={{ fontSize: "12px", margin: "0 2px 8px" }}>{span}（買賣 = 兩份持股的股數差，含投資人申購買回造成的同比例增減）</div>}
      {r.used.length > 0 && (
        <>
          <div class="section-title"><span>買進（{buys.length}）</span></div>
          {buys.length ? <div class="list" data-testid="hold-buys">{buys.map(moveRow)}</div> : <div class="card empty">這段期間沒有買進</div>}
          <div class="section-title"><span>賣出（{sells.length}）</span></div>
          {sells.length ? <div class="list" data-testid="hold-sells">{sells.map(moveRow)}</div> : <div class="card empty">這段期間沒有賣出</div>}
        </>
      )}
      <div class="section-title"><span>目前持股（{r.n} 檔）</span><span>依持有張數</span></div>
      <div class="list" data-testid="hold-all">
        {shown.map((h) => <Row c={h.code} sub={h.delta ? `${days === 1 ? "最新一天" : "近 5 日"} ${lots(h.delta)}` : "沒有增減"} right={plain(h.shares)} tone={h.delta} />)}
      </div>
      {r.hold.length > 15 && <button class="btn secondary block" style={{ marginTop: "8px" }} onClick={() => setAll(!all)} data-testid="hold-more">{all ? "只看前 15 檔" : `看全部 ${r.hold.length} 檔`}</button>}
    </div>
  );
}
