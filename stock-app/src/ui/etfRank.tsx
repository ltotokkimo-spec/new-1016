// ETF排行分頁：個股被 ETF 買賣超的排名（用投信買賣超代表），今天、近 5 日買超與賣超前 20 名（依金額排名）
import { useMemo, useState } from "preact/hooks";
import { flowRank, type RankRow } from "../engine/etfRank";
import type { Scored } from "../engine/score";
import { prettyW } from "../lib/dates";
import { useStore } from "../store";
import { cls, fmtPct, fmtPrice } from "./common";

const lots = (shares: number) => `${shares > 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;
const amt = (x: number) => {
  const a = Math.abs(x), sign = x > 0 ? "+" : "-";
  return a >= 1e8 ? `${sign}${(a / 1e8).toFixed(2)} 億` : `${sign}${Math.round(a / 1e4).toLocaleString("zh-TW")} 萬`;
};

function RankList({ rows, side, open }: { rows: RankRow<Scored>[]; side: "buy" | "sell"; open: (s: Scored) => void }) {
  if (!rows.length) return <div class="card empty">沒有{side === "buy" ? "買超" : "賣超"}的個股</div>;
  return (
    <div class="list" data-testid={`etfrank-${side}`}>
      {rows.map((r, i) => (
        <button class="item" onClick={() => open(r.item)}>
          <div style={{ minWidth: 0 }}>
            <div class="name"><span class="muted num" style={{ fontWeight: 400 }}>{i + 1}.</span> {r.item.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.item.code}</span></div>
            <div class="sub">{r.item.sector}</div>
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
  const [days, setDays] = useState<1 | 5>(1);
  const rank = useMemo(() => flowRank(tw.scored, days, "trust", 20), [tw.scored, days]);
  const ready = tw.scored.length > 0;
  const period = days === 1 ? "今日" : "近 5 日";
  return (
    <div data-testid="etfrank">
      <div class="seg" role="group" aria-label="期間" style={{ marginBottom: "8px" }}>
        <button aria-pressed={days === 1} onClick={() => setDays(1)} data-testid="etfrank-d1">今日</button>
        <button aria-pressed={days === 5} onClick={() => setDays(5)} data-testid="etfrank-d5">近 5 日</button>
      </div>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, margin: "4px 2px 8px" }} data-testid="etfrank-note">
        {tw.flowDate ? <>法人資料日 {prettyW(tw.flowDate)}{days === 5 ? " 往前 5 個交易日合計" : ""}。</> : null}
        個股被 ETF 買賣超的排名，依買賣超金額（張數 × 收盤價）排前 20 名（上市＋上櫃個股，不含 ETF）。
        官方沒有公布「ETF 買賣個股」的資料，這裡用證交所、櫃買中心的「投信」買賣超代表：台股 ETF 幾乎都是投信發行，ETF 申購買回造成的買賣都算在投信，但也含一般投信基金。
        資料每天收盤後約 15:00～16:00 公布，盤中看到的是前一個交易日。
      </div>
      {!ready ? <div class="card empty">{tw.status === "error" ? tw.error ?? "資料下載失敗" : "台股資料下載中…"}</div> : <>
        <div class="section-title"><span class="up">ETF 買超前 20 名</span><span>{period}</span></div>
        <RankList rows={rank.buy} side="buy" open={open} />
        <div class="section-title"><span class="down">ETF 賣超前 20 名</span><span>{period}</span></div>
        <RankList rows={rank.sell} side="sell" open={open} />
      </>}
    </div>
  );
}
