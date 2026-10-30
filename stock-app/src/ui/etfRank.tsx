// ETF排行分頁：個股被 ETF 買賣超的排名，今天、近 5 日買超與賣超前 20 名（依金額排名）。
// 兩種來源：主動式 ETF（每天比對各主動式 ETF 公布的持股，經理人實際加減碼）、投信全部（證交所／櫃買投信買賣超，含被動 ETF 與一般基金）。
import { useEffect, useMemo, useState } from "preact/hooks";
import { activeCoverage, activeRank, etfBreakdown, liveNeeded } from "../lib/activeEtf";
import { flowRank } from "../engine/etfRank";
import type { Scored } from "../engine/score";
import { prettyW } from "../lib/dates";
import { LIVE_MS, getState, refreshActiveEtf, refreshActiveLive, refreshLive, useStore } from "../store";
import type { LiveQuote } from "../data/twLive";
import { marketOpen } from "../data/twLive";
import { taipeiHour, taipeiToday } from "../lib/dates";
import { cls, fmtPct, fmtPrice, Sheet } from "./common";

const lots = (shares: number) => `${shares > 0 ? "+" : ""}${Math.round(shares / 1000).toLocaleString("zh-TW")} 張`;
const amt = (x: number) => {
  const a = Math.abs(x), sign = x > 0 ? "+" : "-";
  return a >= 1e8 ? `${sign}${(a / 1e8).toFixed(2)} 億` : `${sign}${Math.round(a / 1e4).toLocaleString("zh-TW")} 萬`;
};
const ymdW = prettyW; // 持股資料日是 YYYYMMDD
const AUTO_MS = 5 * 60_000; // 還有 ETF 沒公布時的自動檢查間隔
const shortName = (n: string) => n.replace(/^主動/, "");

interface Row { item: Scored; shares: number; amount: number; sub?: string }

function RankList({ rows, side, open, live }: { rows: Row[]; side: "buy" | "sell"; open: (r: Row) => void; live: Record<string, LiveQuote> }) {
  if (!rows.length) return <div class="card empty">沒有{side === "buy" ? "買超" : "賣超"}的個股</div>;
  return (
    <div class="list" data-testid={`etfrank-${side}`}>
      {rows.map((r, i) => {
        // 盤中用證交所即時報價；沒有就顯示最近一個收盤
        const q = live[r.item.code];
        const intraday = !!q && !q.final && q.date === taipeiToday() && marketOpen();
        const price = intraday ? q!.price : r.item.close;
        const chg = intraday && Number.isFinite(q!.prevClose) ? q!.price / q!.prevClose - 1 : r.item.chg1d;
        return (
        <button class="item" onClick={() => open(r)}>
          <div style={{ minWidth: 0 }}>
            <div class="name"><span class="muted num" style={{ fontWeight: 400 }}>{i + 1}.</span> {r.item.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.item.code}</span></div>
            <div class="sub">{r.sub ?? r.item.sector}</div>
          </div>
          <div class="px">
            <div class={`p num ${cls(r.amount)}`}>{amt(r.amount)}</div>
            <div class={`c num ${cls(r.shares)}`}>{lots(r.shares)}</div>
          </div>
          <div class="px">
            <div class="c num"><span class="lbl">{intraday ? `現價 ${q!.time.slice(0, 5)}` : "收盤"}</span>{fmtPrice(price)}</div>
            {chg !== undefined && Number.isFinite(chg) && <div class={`c num ${cls(chg)}`} data-testid="rank-day"><span class="lbl">{intraday ? "今日" : "當日"}</span>{fmtPct(chg)}</div>}
          </div>
        </button>
        );
      })}
    </div>
  );
}

/** 點進個股：這檔股票在選定期間是哪幾檔主動式 ETF 買賣（每檔增減、持有張數、每天明細）＋個股資訊 */
function WhoSheet({ row, days, onClose, openDetail, live }: { row: Row; days: 1 | 5; onClose: () => void; openDetail: () => void; live: Record<string, LiveQuote> }) {
  const active = useStore((s) => s.activeEtf);
  const { rows, used } = useMemo(() => etfBreakdown(active?.data, row.item.code, days), [active, row.item.code, days]);
  const s = row.item;
  const q = live[s.code];
  const intraday = !!q && !q.final && q.date === taipeiToday() && marketOpen();
  const price = intraday ? q!.price : s.close;
  const chg = intraday && Number.isFinite(q!.prevClose) ? q!.price / q!.prevClose - 1 : s.chg1d;
  const buyers = rows.filter((r) => r.delta > 0), sellers = rows.filter((r) => r.delta < 0);
  const sum = rows.reduce((a, r) => a + r.delta, 0);
  const span = used.length ? `${ymdW(used[used.length - 1].date)}${used.length > 1 ? ` ～ ${ymdW(used[0].date)}` : ""}` : "";
  return (
    <Sheet title={`${s.name} ${s.code}`} onClose={onClose} actions={<button class="chip" onClick={openDetail} data-testid="who-detail">個股詳情</button>}>
      <div data-testid="etf-who">
        <div class="card" style={{ marginBottom: "12px" }}>
          <div class="row" style={{ justifyContent: "space-between" }}>
            <div><div class="muted" style={{ fontSize: "12px" }}>{intraday ? `現價 ${q!.time.slice(0, 5)}` : "收盤"}</div><div class="num" style={{ fontSize: "22px", fontWeight: 700 }}>{fmtPrice(price)}</div></div>
            <div style={{ textAlign: "right" }}>
              {chg !== undefined && Number.isFinite(chg) && <div class={`num ${cls(chg)}`} style={{ fontWeight: 600 }}>{fmtPct(chg)}</div>}
              <div class="muted" style={{ fontSize: "12px" }}>{s.sector}</div>
            </div>
          </div>
          <div class="muted" style={{ fontSize: "12px", marginTop: "8px", lineHeight: 1.7 }}>
            評等 {s.rating}・分數 {s.score}　外資近 5 日 <span class={cls(s.foreign5)}>{lots(s.foreign5 ?? 0)}</span>　投信近 5 日 <span class={cls(s.trust5)}>{lots(s.trust5 ?? 0)}</span>
          </div>
        </div>
        <div class="section-title"><span>主動式 ETF 買賣</span><span>{days === 1 ? "最新一天" : "近 5 日"}{span ? `・${span}` : ""}</span></div>
        <div class="muted" style={{ fontSize: "13px", margin: "2px 2px 8px" }} data-testid="who-summary">
          合計 <b class={`num ${cls(sum)}`}>{lots(sum)}</b>（約 {amt(sum * price)}）・{buyers.length} 檔買、{sellers.length} 檔賣
        </div>
        {!rows.length ? <div class="card empty">這段期間沒有主動式 ETF 買賣這檔</div> : (
          <div class="list" data-testid="who-list">
            {rows.map((r) => {
              const pctChg = r.before > 0 ? r.delta / r.before : NaN;
              const tag = r.before === 0 && r.delta > 0 ? "新增" : r.after === 0 && r.delta < 0 ? "清倉" : r.delta > 0 ? "加碼" : "減碼";
              return (
                <div class="item" style={{ cursor: "default" }} data-testid="who-row">
                  <div style={{ minWidth: 0 }}>
                    <div class="name">{r.name.replace(/^主動/, "")} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{r.etf}</span></div>
                    <div class="sub">持有 {Math.round(r.before / 1000).toLocaleString("zh-TW")} → {Math.round(r.after / 1000).toLocaleString("zh-TW")} 張{Number.isFinite(pctChg) ? `（${pctChg > 0 ? "+" : ""}${(pctChg * 100).toFixed(1)}%）` : ""}</div>
                    {r.perDay.length > 1 && <div class="sub">{r.perDay.map(([d, v]) => `${ymdW(d).split("（")[0]} ${lots(v)}`).join("・")}</div>}
                  </div>
                  <div class="px">
                    <div class={`p num ${cls(r.delta)}`}>{lots(r.delta)}</div>
                    <div class={`c num ${cls(r.delta)}`}>{tag}・{amt(r.delta * price)}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, margin: "10px 2px" }}>增減＝同一檔 ETF 前後兩份持股的股數差，含申購買回造成的同比例買賣；金額用上面的價格估算。</div>
      </div>
    </Sheet>
  );
}

export function EtfRankScreen({ open }: { open: (s: Scored) => void }) {
  const tw = useStore((s) => s.tw);
  const active = useStore((s) => s.activeEtf);
  const [src, setSrc] = useState<"active" | "trust">("active");
  const [days, setDays] = useState<1 | 5>(1);
  const [who, setWho] = useState<Row | null>(null);
  // GitHub 每天整理一次；另外打開時 App 自己向 MoneyDJ 檢查最新持股（10 分鐘內不重複）
  useEffect(() => {
    const old = (t?: number) => !t || Date.now() - t > 10 * 60_000;
    // 已經全部公布到應有的日期就不用再向 MoneyDJ 抓一輪（以前每次打開都重抓、畫面一直停在舊資料等更新）
    const live = () => { if (liveNeeded(getState().activeEtf?.data)) refreshActiveLive(); };
    if (!active || old(active.fetchedAt)) refreshActiveEtf().then(live);
    else if (old(active.liveAt)) live();
  }, []);
  // 持股各投信收盤後陸續公布（有的到晚上）：停在這頁、還有 ETF 沒公布今天持股時，平日 15:30～24:00 每 5 分鐘自動檢查，公布了就馬上併進排行
  useEffect(() => {
    const t = setInterval(() => {
      const st = getState().activeEtf;
      const cov = activeCoverage(st?.data), now = new Date(Date.now() + 8 * 3600_000), dow = now.getUTCDay();
      const h = taipeiHour() + now.getUTCMinutes() / 60;
      const incomplete = !cov || cov.date < taipeiToday() || cov.n < cov.of;
      if (st && !st.liveProgress && dow >= 1 && dow <= 5 && h >= 15.5 && incomplete) refreshActiveLive();
    }, AUTO_MS);
    return () => clearInterval(t);
  }, []);
  const cover = useMemo(() => activeCoverage(active?.data), [active]);
  const live = useStore((s) => s.live);
  const byCode = useMemo(() => new Map(tw.scored.map((s) => [s.code, s])), [tw.scored]);
  const etfName = useMemo(() => new Map((active?.data.etfs ?? []).map((e) => [e.code, shortName(e.name)])), [active]);
  const rank = useMemo(() => {
    if (src === "trust") { const r = flowRank(tw.scored, days, "trust", 20); return { ...r, used: undefined, partial: undefined }; }
    const r = activeRank(active?.data, days, (c) => byCode.get(c), 20);
    const sub = (b: [string, number][], side: 1 | -1) => {
      const same = b.filter(([, v]) => v * side > 0);
      const names = same.slice(0, 2).map(([e]) => etfName.get(e) ?? e).join("、");
      return `${same.length} 檔主動 ETF ${side > 0 ? "買" : "賣"}：${names}${same.length > 2 ? " 等" : ""}`;
    };
    return { buy: r.buy.map((x) => ({ ...x, sub: sub(x.buyers, 1) })), sell: r.sell.map((x) => ({ ...x, sub: sub(x.buyers, -1) })), used: r.used, partial: r.partial };
  }, [src, days, tw.scored, active, byCode, etfName]);
  const liveCodes = useMemo(() => [...rank.buy, ...rank.sell].map((r) => r.item.code), [rank]);
  const liveKey = liveCodes.join(",");
  useEffect(() => {
    if (!liveCodes.length) return;
    refreshLive(liveCodes);
    const t = setInterval(() => { if (marketOpen()) refreshLive(liveCodes); }, LIVE_MS);
    return () => clearInterval(t);
  }, [liveKey]);
  // 主動式 ETF：點進去看是哪幾檔在買賣；投信全部沒有逐檔資料，直接開個股詳情
  const pick = (r: Row) => (src === "active" ? setWho(r) : open(r.item));
  const ready = tw.scored.length > 0 && (src === "trust" || !!active);
  const used = rank.used;
  const dataDay = src === "active" ? (used?.[0]?.date ?? active?.data.live ?? "") : (tw.flowDate ?? "");
  const period = days === 1 ? (dataDay ? `${ymdW(dataDay.replace(/-/g, ""))}` : "最新一天") : "近 5 日";
  const latestHold = active?.data.etfs.reduce((m, e) => (e.date > m ? e.date : m), "") ?? "";
  const accumulating = src === "active" && !!active && !active.data.days.length;
  return (
    <div data-testid="etfrank">
      <div class="seg" role="group" aria-label="來源" style={{ marginBottom: "8px" }}>
        <button aria-pressed={src === "active"} onClick={() => setSrc("active")} data-testid="etfrank-active">主動式 ETF</button>
        <button aria-pressed={src === "trust"} onClick={() => setSrc("trust")} data-testid="etfrank-trust">投信全部</button>
      </div>
      <div class="seg" role="group" aria-label="期間" style={{ marginBottom: "8px" }}>
        <button aria-pressed={days === 1} onClick={() => setDays(1)} data-testid="etfrank-d1">最新一天</button>
        <button aria-pressed={days === 5} onClick={() => setDays(5)} data-testid="etfrank-d5">近 5 日</button>
      </div>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, margin: "4px 2px 8px" }} data-testid="etfrank-note">
        {src === "active" ? <>
          {used?.length ? <>持股資料日 {ymdW(used[0].date)}{days === 5 ? `，往前 ${used.length} 個持股日合計（${ymdW(used[used.length - 1].date)} 起）` : ""}{days === 5 && used.length < 5 ? `，目前只累積 ${used.length} 天` : ""}。</> : null}
          {rank.partial ? <span data-testid="etfrank-partial">{ymdW(rank.partial.date)} 目前只有 {rank.partial.n} 檔（共 {rank.partial.of} 檔）公布持股，先顯示公布過半的 {ymdW(used![0].date)}；其餘公布後會自動換成新的一天。</span> : null}
          主動式 ETF 個股買賣超：每天比對 {active?.data.etfs.length ?? 0} 檔台股主動式 ETF 公布的完整持股，股數增減就是 ETF 實際買賣（含申購買回造成的同比例買賣），全部加總後依金額（張數 × 收盤價）排前 20 名。
          持股是各投信每天收盤後公布一次（盤中沒有即時持股），打開這頁時 App 會自己向 MoneyDJ 檢查有沒有新的持股。買賣超是「持股資料日」那一天的變動（不是今天盤中）；右邊的價格盤中會換成即時價（證交所約 30～60 秒才換一次資料），收盤後是收盤價。
        </> : <>
          {tw.flowDate ? <>法人資料日 {prettyW(tw.flowDate)}{days === 5 ? " 往前 5 個交易日合計" : ""}。</> : null}
          投信全部：證交所、櫃買中心的「投信」買賣超，包含主動式、被動式 ETF（申購買回依指數權重買賣）與一般投信基金，依金額（張數 × 收盤價）排前 20 名（上市＋上櫃個股，不含 ETF）。
          資料每天收盤後約 15:00～16:00 公布，盤中看到的是前一個交易日。
        </>}
      </div>
      {src === "active" && active && (active.liveProgress || active.liveAt || cover) && <div class="muted" style={{ fontSize: "12px", margin: "0 2px 8px" }} data-testid="etfrank-live">
        {active.liveProgress ? `正在檢查最新持股… ${active.liveProgress.done}/${active.liveProgress.total}`
          : !active.liveAt ? <>持股資料已是最新{cover ? `（${ymdW(cover.date)} 已公布 ${cover.n}／${cover.of} 檔）` : ""}，不用再等 <button class="linkbtn" onClick={() => refreshActiveLive()} data-testid="etfrank-recheck">重新檢查</button></>
          : <>已檢查最新持股（{new Date(active.liveAt!).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}，取得 {active.liveFound ?? 0} 檔）{active.data.live ? `，最新持股日 ${ymdW(active.data.live)}` : ""}{cover ? `，${ymdW(cover.date)} 已公布 ${cover.n}／${cover.of} 檔${cover.n < cover.of ? "（停在這頁每 5 分鐘自動檢查）" : ""}` : ""} <button class="linkbtn" onClick={() => refreshActiveLive()} data-testid="etfrank-recheck">重新檢查</button></>}
      </div>}
      {who && <WhoSheet row={who} days={days} live={live} onClose={() => setWho(null)} openDetail={() => open(who.item)} />}
      {src === "active" && active?.error && <div class="card empty" style={{ marginBottom: "8px" }}>{active.error}</div>}
      {!ready ? <div class="card empty">{tw.status === "error" ? tw.error ?? "資料下載失敗" : "資料下載中…"}</div>
        : accumulating ? <div class="card empty" data-testid="etfrank-accum">資料累積中：已取得 {active!.data.etfs.length} 檔主動式 ETF 的持股{latestHold ? `（${ymdW(latestHold)}）` : ""}，下一份持股公布後就能比對出第一天的買賣超。</div>
        : <>
          <div class="section-title"><span class="up">{src === "active" ? "主動式 ETF" : "投信"} 買超前 20 名</span><span>{period}</span></div>
          <RankList rows={rank.buy} side="buy" open={pick} live={live} />
          <div class="section-title"><span class="down">{src === "active" ? "主動式 ETF" : "投信"} 賣超前 20 名</span><span>{period}</span></div>
          <RankList rows={rank.sell} side="sell" open={pick} live={live} />
        </>}
    </div>
  );
}
