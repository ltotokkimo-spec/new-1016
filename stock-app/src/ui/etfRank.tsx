// ETF排行分頁：個股被 ETF 買賣超的排名，今天、近 5 日買超與賣超前 20 名（依金額排名）。
// 兩種來源：主動式 ETF（每天比對各主動式 ETF 公布的持股，經理人實際加減碼）、投信全部（證交所／櫃買投信買賣超，含被動 ETF 與一般基金）。
import { useEffect, useMemo, useState } from "preact/hooks";
import { activeRank } from "../lib/activeEtf";
import { flowRank } from "../engine/etfRank";
import type { Scored } from "../engine/score";
import { prettyW } from "../lib/dates";
import { refreshActiveEtf, useStore } from "../store";
import { cls, fmtPct, fmtPrice } from "./common";

const lots = (shares: number) => `${shares > 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;
const amt = (x: number) => {
  const a = Math.abs(x), sign = x > 0 ? "+" : "-";
  return a >= 1e8 ? `${sign}${(a / 1e8).toFixed(2)} 億` : `${sign}${Math.round(a / 1e4).toLocaleString("zh-TW")} 萬`;
};
const ymdW = (d: string) => prettyW(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
const shortName = (n: string) => n.replace(/^主動/, "");

interface Row { item: Scored; shares: number; amount: number; sub?: string }

function RankList({ rows, side, open }: { rows: Row[]; side: "buy" | "sell"; open: (s: Scored) => void }) {
  if (!rows.length) return <div class="card empty">沒有{side === "buy" ? "買超" : "賣超"}的個股</div>;
  return (
    <div class="list" data-testid={`etfrank-${side}`}>
      {rows.map((r, i) => (
        <button class="item" onClick={() => open(r.item)}>
          <div style={{ minWidth: 0 }}>
            <div class="name"><span class="muted num" style={{ fontWeight: 400 }}>{i + 1}.</span> {r.item.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.item.code}</span></div>
            <div class="sub">{r.sub ?? r.item.sector}</div>
          </div>
          <div class="px">
            <div class={`p num ${cls(r.amount)}`}>{amt(r.amount)}</div>
            <div class={`c num ${cls(r.shares)}`}>{lots(r.shares)}</div>
          </div>
          <div class="px">
            <div class="c num"><span class="lbl">收盤</span>{fmtPrice(r.item.close)}</div>
            {r.item.chg1d !== undefined && <div class={`c num ${cls(r.item.chg1d)}`}><span class="lbl">今日</span>{fmtPct(r.item.chg1d)}</div>}
          </div>
        </button>
      ))}
    </div>
  );
}

export function EtfRankScreen({ open }: { open: (s: Scored) => void }) {
  const tw = useStore((s) => s.tw);
  const active = useStore((s) => s.activeEtf);
  const [src, setSrc] = useState<"active" | "trust">("active");
  const [days, setDays] = useState<1 | 5>(1);
  useEffect(() => { if (!active || Date.now() - active.fetchedAt > 10 * 60_000) refreshActiveEtf(); }, []);
  const byCode = useMemo(() => new Map(tw.scored.map((s) => [s.code, s])), [tw.scored]);
  const etfName = useMemo(() => new Map((active?.data.etfs ?? []).map((e) => [e.code, shortName(e.name)])), [active]);
  const rank = useMemo(() => {
    if (src === "trust") { const r = flowRank(tw.scored, days, "trust", 20); return { ...r, used: undefined }; }
    const r = activeRank(active?.data, days, (c) => byCode.get(c), 20);
    const sub = (b: [string, number][], side: 1 | -1) => {
      const same = b.filter(([, v]) => v * side > 0);
      const names = same.slice(0, 2).map(([e]) => etfName.get(e) ?? e).join("、");
      return `${same.length} 檔主動 ETF ${side > 0 ? "買" : "賣"}：${names}${same.length > 2 ? " 等" : ""}`;
    };
    return { buy: r.buy.map((x) => ({ ...x, sub: sub(x.buyers, 1) })), sell: r.sell.map((x) => ({ ...x, sub: sub(x.buyers, -1) })), used: r.used };
  }, [src, days, tw.scored, active, byCode, etfName]);
  const ready = tw.scored.length > 0 && (src === "trust" || !!active);
  const period = days === 1 ? "今日" : "近 5 日";
  const used = rank.used;
  const latestHold = active?.data.etfs.reduce((m, e) => (e.date > m ? e.date : m), "") ?? "";
  const accumulating = src === "active" && !!active && !active.data.days.length;
  return (
    <div data-testid="etfrank">
      <div class="seg" role="group" aria-label="來源" style={{ marginBottom: "8px" }}>
        <button aria-pressed={src === "active"} onClick={() => setSrc("active")} data-testid="etfrank-active">主動式 ETF</button>
        <button aria-pressed={src === "trust"} onClick={() => setSrc("trust")} data-testid="etfrank-trust">投信全部</button>
      </div>
      <div class="seg" role="group" aria-label="期間" style={{ marginBottom: "8px" }}>
        <button aria-pressed={days === 1} onClick={() => setDays(1)} data-testid="etfrank-d1">今日</button>
        <button aria-pressed={days === 5} onClick={() => setDays(5)} data-testid="etfrank-d5">近 5 日</button>
      </div>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, margin: "4px 2px 8px" }} data-testid="etfrank-note">
        {src === "active" ? <>
          {used?.length ? <>持股資料日 {ymdW(used[0].date)}{days === 5 ? `，往前 ${used.length} 個持股日合計（${ymdW(used[used.length - 1].date)} 起）` : ""}{days === 5 && used.length < 5 ? `，目前只累積 ${used.length} 天` : ""}。</> : null}
          主動式 ETF 個股買賣超：每天比對 {active?.data.etfs.length ?? 0} 檔台股主動式 ETF 公布的完整持股，股數增減就是 ETF 實際買賣（含申購買回造成的同比例買賣），全部加總後依金額（張數 × 收盤價）排前 20 名。
          持股約在當天晚上或隔天早上公布，App 每天 18:40 後更新。
        </> : <>
          {tw.flowDate ? <>法人資料日 {prettyW(tw.flowDate)}{days === 5 ? " 往前 5 個交易日合計" : ""}。</> : null}
          投信全部：證交所、櫃買中心的「投信」買賣超，包含主動式、被動式 ETF（申購買回依指數權重買賣）與一般投信基金，依金額（張數 × 收盤價）排前 20 名（上市＋上櫃個股，不含 ETF）。
          資料每天收盤後約 15:00～16:00 公布，盤中看到的是前一個交易日。
        </>}
      </div>
      {src === "active" && active?.error && <div class="card empty" style={{ marginBottom: "8px" }}>{active.error}</div>}
      {!ready ? <div class="card empty">{tw.status === "error" ? tw.error ?? "資料下載失敗" : "資料下載中…"}</div>
        : accumulating ? <div class="card empty" data-testid="etfrank-accum">資料累積中：已取得 {active!.data.etfs.length} 檔主動式 ETF 的持股{latestHold ? `（${ymdW(latestHold)}）` : ""}，下一份持股公布後就能比對出第一天的買賣超。</div>
        : <>
          <div class="section-title"><span class="up">{src === "active" ? "主動式 ETF" : "投信"} 買超前 20 名</span><span>{period}</span></div>
          <RankList rows={rank.buy} side="buy" open={open} />
          <div class="section-title"><span class="down">{src === "active" ? "主動式 ETF" : "投信"} 賣超前 20 名</span><span>{period}</span></div>
          <RankList rows={rank.sell} side="sell" open={open} />
        </>}
    </div>
  );
}
