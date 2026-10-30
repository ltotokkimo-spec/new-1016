import { useEffect, useMemo, useState } from "preact/hooks";
import {
  LIVE_MS,
  findScored, getFetcher, getKv, getState, holdingViews, refreshEsb, refreshMacro, refreshTw, refreshUs, saveHoldings, saveReport,
  saveSettings, clearCache, useStore, usBars, recordSpend, estimatedBalance, checkForUpdate, installUpdate,
  addUsSymbol, removeUsSymbol, refreshLive, refreshUsLive, refreshTwIndex, refreshFutures, refreshTurnover, refreshEtfNav, revenueOf, startAiJob, dismissAiJob, type AiJob, type Market,
} from "../store";
import type { Holding, Rating, Scored, SectorStat } from "../engine/score";
import { type AiReport, analyzeStock, claudeAppPrompt, claudeAppUrl, client, explainError, parseUrls, holdingsFromImage, marketBrief, shrinkImage, MODEL, type ImportedHolding } from "../ai/claude";
import { twHistory } from "../data/history";
import { esbHistory } from "../data/esb";
import { CandleChart, type CandleBar } from "./candles";
import { FlowsPanel } from "./flows";
import { EtfHoldingsPanel, isActiveEtf } from "./etfHoldings";
import { isEtf } from "../data/tw";
import { freeReport } from "../engine/freeReport";
import { withLiveBar } from "../engine/liveBar";
import { isUsSymbol, MACRO_SYMBOLS } from "../data/us";
import { marketOpen, type LiveQuote } from "../data/twLive";
import { INDEX_CH } from "../data/twIndexLive";
import { pretty, prettyW, taipeiToday, usQuoteHours } from "../lib/dates";
import { latestNotes } from "../lib/notes";
import { fmtNtd, usdTwdRate } from "../lib/fx";
import type { BacktestResult } from "../engine/backtest";
import type { TurnPick } from "../engine/turning";
import { cls, fmtMoney, fmtPct, fmtPrice, fmtSigned, lots, Markdown, Progress, RatingPill, Sheet } from "./common";

// ---------------- 選股 ----------------
export function PicksScreen({ market, setMarket, sector, setSector, open }: {
  market: Market; setMarket: (m: Market) => void; sector: string; setSector: (s: string) => void; open: (s: Scored) => void;
}) {
  const ms = useStore((s) => (market === "TW" ? s.tw : market === "ETF" ? s.etf : s.us));
  const [filter0, setFilter] = useState<Rating | "全部" | "剛轉強">("買入");
  // 剛轉強：每天回測時一起算好（需要 3 個月以上的日K），只有台股
  const turn = useStore((s) => (market === "TW" ? s.backtest?.data.turning : undefined));
  const turnMap = useMemo(() => new Map((turn?.picks ?? []).map((p) => [p.code, p])), [turn]);
  const refOnly = market === "ETF";
  const filter = refOnly ? "全部" : filter0 === "剛轉強" && !turn ? "買入" : filter0; // ETF 不分評等；美股沒有「剛轉強」，從台股切過來時改回「買入」
  const [q, setQ] = useState("");
  const live = useStore((s) => s.live);
  // 清單前 60 檔用即時價（台股：證交所；美股：CNBC，盤中每 30 秒更新），其餘顯示最近收盤的漲跌
  const freshLive = (s: Scored): LiveQuote | undefined => {
    const lq = live[s.code];
    return lq && lq.date && lq.date >= (ms.asOf ?? "") ? lq : undefined;
  };
  // 從「族群」分頁點進來時只看該族群，評等檔數也跟著只算該族群
  const counts = useMemo(() => {
    const c: Record<string, number> = { 全部: 0, 買入: 0, 觀望: 0, 離場: 0, 剛轉強: 0 };
    for (const s of ms.scored) if (!sector || s.sector === sector) { c["全部"]++; c[s.rating]++; if (turnMap.has(s.code)) c["剛轉強"]++; }
    return c;
  }, [ms.scored, sector, turnMap]);
  const list = useMemo(() => {
    const t = q.trim().toUpperCase();
    return ms.scored.filter((s) =>
      (filter === "全部" || (filter === "剛轉強" ? turnMap.has(s.code) : s.rating === filter)) && (!sector || s.sector === sector) &&
      (!t || s.code.toUpperCase().includes(t) || s.name.toUpperCase().includes(t)))
      // ETF 依最近一個交易日的成交量排序（其他市場維持依分數）；用固定的收盤量，盤中不會一直重新排列
      .sort(market === "ETF" ? (a, b) => (b.volume ?? 0) - (a.volume ?? 0) : () => 0);
  }, [ms.scored, filter, q, sector, turnMap, market]);
  const liveCodes = list.slice(0, 60).map((x) => x.code);
  const liveKey = market + liveCodes.join(",");
  useEffect(() => {
    if (!liveCodes.length) return;
    const us = market === "US";
    const pull = () => (us ? refreshUsLive(liveCodes) : refreshLive(liveCodes));
    pull();
    const t = setInterval(() => { if (us ? usQuoteHours() : marketOpen()) pull(); }, LIVE_MS);
    return () => clearInterval(t);
  }, [liveKey]);

  return (
    <div>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <MarketSeg market={market} setMarket={setMarket} />
        <input class="search" type="search" placeholder="代號或名稱" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="搜尋股票" />
      </div>
      <div class="chips" style={{ marginTop: "10px" }} role="group" aria-label="評等篩選">
        {refOnly
          ? <button class="chip" aria-pressed="true">全部 {counts["全部"]} 檔</button>
          : (["買入", ...(turn ? ["剛轉強"] as const : []), "觀望", "離場", "全部"] as const).map((f) => (
            <button class="chip" aria-pressed={filter === f} onClick={() => setFilter(f)} data-testid={f === "剛轉強" ? "turn-chip" : undefined}>{f} {counts[f] ?? 0} 檔</button>
          ))}
      </div>
      {sector && (
        <div class="notice row" data-testid="sector-filter" style={{ marginTop: "10px", justifyContent: "space-between", gap: "8px" }}>
          <span>只看「<b style={{ color: "var(--fg)" }}>{sector}</b>」族群（從族群分頁點進來）</span>
          <button class="chip" aria-pressed="true" onClick={() => setSector("")}>看全部族群 ✕</button>
        </div>
      )}
      {filter === "剛轉強" && turn ? <TurnCard turn={turn} /> : <BacktestCard market={market} />}
      {ms.error && <div class="error" style={{ marginTop: "10px" }}>{ms.error}</div>}
      {ms.warning && <div class="notice" style={{ marginTop: "10px" }}>{ms.warning}</div>}
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "error" && <div class="empty">資料下載失敗，請檢查網路後按右上角重新整理</div>}
      {ms.status === "ready" && (
        <>
          <div class="section-title">
            <span>{sector ? `${sector}・` : ""}{filter === "全部" ? (market === "ETF" ? "全部 ETF" : "全部股票") : filter === "剛轉強" ? "剛轉強" : `評等「${filter}」`}・{market === "ETF" ? `依成交量排序${ms.asOf ? `（${prettyW(ms.asOf)}）` : ""}` : "依分數排序"}</span>
            <span>{list.length} 檔</span>
          </div>
          {market === "US" && <UsLookup q={q} found={list.length > 0} />}
          {list.length === 0 ? (
            <div class="empty">
              {filter === "剛轉強" && !q && !sector ? `${prettyW(turn?.asOf ?? "")}收盤沒有股票同時符合「剛轉強」的條件。` : filter === "買入" && !q && !sector ? <>今天沒有股票同時符合「分數 70 以上、外資買超、一週漲幅未過熱」。<br /><button class="chip" style={{ marginTop: "10px" }} onClick={() => setFilter("觀望")}>看「觀望」名單</button></> : "沒有符合的股票"}
            </div>
          ) : (
            <div class="list">
              {list.slice(0, 150).map((s) => <StockRow s={s} q={freshLive(s)} turn={filter === "剛轉強" ? turnMap.get(s.code) : undefined} onClick={() => open(s)} />)}
            </div>
          )}
          <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
            {market === "ETF"
              ? "ETF 只給分數當參考、不給買入／觀望／離場：回測顯示這套短線規則對 ETF 分辨不出好壞。分數 = 動能 40% ＋ 外資籌碼 40% ＋ 同類 ETF 強弱 20%，只列當日成交金額 5 千萬以上的 ETF；槓桿反向型波動大，請特別留意。"
              : market === "TW"
              ? "分數 = 動能 40%（近1週/1月/3月漲幅排名）＋ 外資籌碼 40%（5 日買超佔成交比重、連買天數、投信）＋ 族群強弱 20%。只列當日成交金額 5 千萬以上的股票。"
              : "分數 = 動能 40% ＋ 趨勢 40%（50 日均線、20/50 日均線排列、相對 S&P 500）＋ 產業強弱 20%。美股沒有外資資料。"}
          </p>
        </>
      )}
    </div>
  );
}

function MarketSeg({ market, setMarket }: { market: Market; setMarket: (m: Market) => void }) {
  return (
    <div class="seg" role="group" aria-label="市場">
      <button aria-pressed={market === "TW"} onClick={() => setMarket("TW")}>台股</button>
      <button aria-pressed={market === "ETF"} onClick={() => setMarket("ETF")}>ETF</button>
      <button aria-pressed={market === "US"} onClick={() => setMarket("US")}>美股</button>
    </div>
  );
}

function StockRow({ s, q, turn, onClick }: { s: Scored; q?: LiveQuote; turn?: TurnPick; onClick: () => void }) {
  const price = q?.price ?? s.close;
  const chg = q && Number.isFinite(q.prevClose) ? q.price / q.prevClose - 1 : s.chg1d;
  const intraday = !!q && !q.final && (s.market === "US" || q.date === taipeiToday());
  return (
    <button class="item" onClick={onClick} data-live={q ? "1" : undefined}>
      <div style={{ minWidth: 0 }}>
        <div class="name">{s.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{s.code}</span></div>
        <div class="sub">
          {s.sector}
          {isEtf(s.code) && s.volume ? <>・量 <b class="num">{Math.round(s.volume / 1000).toLocaleString("zh-TW")}</b> 張</> : null}
          {s.market !== "US" ? <>・外資5日 <span class={cls(s.foreign5)}>{lots(s.foreign5)}</span></> : <>・相對大盤 <span class={cls(s.rsVsIndex1m)}>{fmtPct(s.rsVsIndex1m)}</span></>}
        </div>
        {turn && <>
          <div class="sub" data-testid="turn-info">離20日線 {fmtPct(turn.gap20)}・MACD {turn.turnedAgo ? `${turn.turnedAgo} 天前` : "今天"}翻正</div>
          <div class="sub" data-testid="turn-stop">停損參考 <b class="num">{fmtPrice(turn.stop, s.market)}</b></div>
        </>}
      </div>
      <div class="px">
        <div class="p num"><span class="lbl">{intraday ? `現價 ${q!.time.slice(0, 5)}` : "收盤"}</span>{fmtPrice(price, s.market)}</div>
        {chg !== undefined && Number.isFinite(chg) && <div class={`c num ${cls(chg)}`} data-testid="pick-day"><span class="lbl">今日</span>{fmtPct(chg)}</div>}
        {q?.ext && <div class={`c num ${cls(q.ext.chg)}`} data-testid="pick-ext"><span class="lbl">{q.ext.label} {q.ext.time}</span>{fmtPrice(q.ext.price, s.market)} {fmtPct(q.ext.chg)}</div>}
        <div class={`c num ${cls(s.ret1m)}`}><span class="lbl">近1月</span>{fmtPct(s.ret1m)}</div>
      </div>
      <div>
        <RatingPill rating={s.refOnly ? "參考" : s.rating} />
        <div class="score num">分數 {s.score}</div>
      </div>
    </button>
  );
}

// ---------------- 搜尋不在清單裡的美股 ----------------
function UsLookup({ q, found }: { q: string; found: boolean }) {
  const lk = useStore((s) => s.usLookup);
  const sym = q.trim().toUpperCase();
  if (lk?.status === "loading") return <div class="notice" style={{ marginBottom: "10px" }}>正在從 Nasdaq 下載 {lk.symbol} 的資料並評分…</div>;
  if (found || !isUsSymbol(sym)) return null;
  return (
    <div class="card stack" style={{ marginBottom: "10px" }} data-testid="us-lookup">
      {lk?.symbol === sym && lk.status === "notfound" && <div class="error">Nasdaq 查不到 {sym}，請確認代號（例如 AAOI、BRK.B）</div>}
      {lk?.symbol === sym && lk.status === "error" && <div class="error">下載失敗：{lk.error}，請稍後再試</div>}
      <div style={{ fontSize: "14px", lineHeight: 1.6 }}>{sym} 不在預設的 55 檔大型股清單裡。要下載它的資料並評分嗎？加入後每天會一起更新。</div>
      <button class="btn block" onClick={() => addUsSymbol(sym)} data-testid="us-add">下載 {sym} 並評分</button>
    </div>
  );
}

// ---------------- 回測 ----------------
type BtGroup = "買入" | "觀望" | "離場" | "全部";

/** 選股頁上方的回測摘要：這套評等過去準不準 */
// 剛轉強的條件說明與過去表現
function TurnCard({ turn }: { turn: NonNullable<BacktestResult["turning"]> }) {
  const x = turn.stat[20];
  return (
    <div class="card" style={{ marginTop: "10px" }} data-testid="turn-card">
      <div style={{ fontWeight: 700 }}>剛轉強：剛站上 20 日線、還沒漲遠</div>
      <div style={{ fontSize: "13px", lineHeight: 1.7, marginTop: "6px" }}>
        條件：收盤在 20 日線上方 5% 以內、不低於 60 日線、MACD 最近 5 天內由負轉正、RSI 低於 70、沒有超過布林上軌、外資＋投信近 5 日買超、成交金額 5 千萬以上。
        停損參考設在 20／60 日線下方（約 −3%～−8%），跌破就出場。
      </div>
      {x && <div style={{ marginTop: "6px" }}>過去評等日符合的股票，之後 20 個交易日：平均 <b class={cls(x.avg)}>{fmtPct(x.avg)}</b>・上漲機率 {Math.round(x.win * 100)}%・贏過一半股票 {Math.round(x.beat * 100)}%（{x.n} 筆）</div>}
      <div class="muted" style={{ fontSize: "12px", marginTop: "4px" }}>根據 {prettyW(turn.asOf)} 收盤，每天傍晚更新。剛起漲的股票也常站不穩又跌回，一定要設停損；過去表現不代表未來。</div>
    </div>
  );
}

function BacktestCard({ market }: { market: Market }) {
  const bt = useStore((s) => s.backtest);
  const [open, setOpen] = useState(false);
  if (market !== "TW" || !bt) return null; // ETF 只當參考，不顯示評等回測
  const u = bt.data.stocks;
  const b = u.groups["買入"][20], a = u.groups["全部"][20];
  if (!u.signals || !b || !a) return null;
  const word = "股票";
  return (
    <>
      <button class="card" style={{ width: "100%", textAlign: "left", marginTop: "10px", cursor: "pointer", display: "block" }} onClick={() => setOpen(true)} data-testid="backtest-card">
        <div class="row" style={{ justifyContent: "space-between" }}>
          <b style={{ fontSize: "14px" }}>回測參考：評「買入」之後 20 個交易日</b>
          <span class="muted" style={{ fontSize: "12px" }}>詳情 ›</span>
        </div>
        <div class="num" style={{ marginTop: "6px", fontSize: "14px", lineHeight: 1.7 }}>
          平均 <span class={cls(b.avg)}>{fmtPct(b.avg)}</span>・上漲機率 {Math.round(b.win * 100)}%
          <span class="muted">（全部{word}平均 <span class={cls(a.avg)}>{fmtPct(a.avg)}</span>）</span>
        </div>
        <div class="muted" style={{ fontSize: "12px" }}>{pretty(bt.data.from)}～{pretty(bt.data.to)} 每週評等一次，共 {u.signals} 次・過去表現不代表未來</div>
      </button>
      {open && <BacktestSheet market={market} onClose={() => setOpen(false)} />}
    </>
  );
}

function BacktestSheet({ market, onClose }: { market: Market; onClose: () => void }) {
  const bt = useStore((s) => s.backtest)!;
  const u = market === "ETF" ? bt.data.etf : bt.data.stocks;
  const word = market === "ETF" ? "ETF" : "股票";
  const row = (g: BtGroup, h: 5 | 20) => {
    const x = u.groups[g][h];
    return (
      <tr>
        <td>{g === "全部" ? `全部${word}` : <RatingPill rating={g} />}</td>
        <td class="num">{x ? x.n.toLocaleString() : "—"}</td>
        <td class={`num ${cls(x?.avg)}`}>{fmtPct(x?.avg)}</td>
        <td class={`num ${cls(x?.median)}`}>{fmtPct(x?.median)}</td>
        <td class="num">{x ? `${Math.round(x.win * 100)}%` : "—"}</td>
        <td class="num">{x && g !== "全部" ? `${Math.round(x.beat * 100)}%` : "—"}</td>
      </tr>
    );
  };
  return (
    <Sheet title={`回測：${market === "ETF" ? "ETF" : "台股"}評等準不準`} onClose={onClose}>
      <div class="notice" style={{ lineHeight: 1.7 }}>
        方法：從 {pretty(bt.data.from)} 到 {pretty(bt.data.to)}，每 5 個交易日用和 App 完全相同的規則重新評等一次，再看每檔{word}之後 5 天、20 天的實際漲跌（已還原除權息）。資料來自證交所與櫃買中心，每次更新 App 資料時會一起下載最新結果。
      </div>
      {([5, 20] as const).map((h) => (
        <>
          <div class="section-title"><span>之後 {h} 個交易日</span></div>
          <div class="scroll-x">
            <table class="sectors">
              <thead><tr><th>評等</th><th>樣本</th><th>平均</th><th>中位數</th><th>上漲機率</th><th>贏過一半</th></tr></thead>
              <tbody>{(["買入", "觀望", "離場", "全部"] as const).map((g) => row(g, h))}</tbody>
            </table>
          </div>
        </>
      ))}
      <div class="section-title"><span>每次評等的結果（買入 vs 全部平均）</span></div>
      <div class="scroll-x">
        <table class="sectors">
          <thead><tr><th>評等日</th><th>買入檔數</th><th>買入 5日</th><th>全部 5日</th><th>買入 20日</th><th>全部 20日</th></tr></thead>
          <tbody>
            {u.series.map((r) => (
              <tr>
                <td class="num">{pretty(r.date)}</td>
                <td class="num">{r.nBuy}</td>
                <td class={`num ${cls(r.buy[5])}`}>{fmtPct(r.buy[5])}</td>
                <td class={`num ${cls(r.all[5])}`}>{fmtPct(r.all[5])}</td>
                <td class={`num ${cls(r.buy[20])}`}>{fmtPct(r.buy[20])}</td>
                <td class={`num ${cls(r.all[20])}`}>{fmtPct(r.all[20])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="muted" style={{ fontSize: "12px", lineHeight: 1.7 }}>
        怎麼看：「買入」的平均、中位數和上漲機率如果明顯高於「全部」，代表這套評等過去有參考價值；「贏過一半」是之後表現贏過同一天全部{word}中位數的比例，50% 等於亂選，高於 50% 才代表真的挑得比較好。平均比中位數高很多，表示有少數大漲股把平均拉高。
        注意：這份回測只涵蓋 {pretty(bt.data.from)} 到 {pretty(bt.data.dataTo)} 這一段，不同行情（多頭、空頭）結果可能差很多；沒有計算手續費與交易稅；最近 20 天內的評等還沒有 20 日結果。過去表現不代表未來，僅供參考。
      </p>
    </Sheet>
  );
}

// ---------------- 族群 ----------------
export function SectorsScreen({ market, setMarket, pick }: { market: Market; setMarket: (m: Market) => void; pick: (s: string) => void }) {
  const ms = useStore((s) => (market === "TW" ? s.tw : market === "ETF" ? s.etf : s.us));
  const rising = ms.sectors.filter((s) => s.rotation === "轉強");
  return (
    <div>
      <MarketSeg market={market} setMarket={setMarket} />
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "ready" && (
        <>
          <div class="section-title"><span>輪動訊號</span></div>
          <div class="card" style={{ lineHeight: 1.7 }}>
            {rising.length
              ? <>資金轉進：{rising.map((s) => <b class="up">{s.sector} </b>)}（近 1 週排名前段，但近 1 月還在後段）</>
              : "目前沒有明顯轉強的族群"}
            <div class="muted" style={{ fontSize: "13px" }}>
              最強：{ms.sectors.slice(0, 3).map((s) => s.sector).join("、")}；最弱：{ms.sectors.slice(-3).reverse().map((s) => s.sector).join("、")}
            </div>
          </div>
          <div class="section-title"><span>{market === "TW" ? "產業強弱（中位數報酬）" : market === "ETF" ? "ETF 類型強弱（中位數報酬）" : "產業強弱"}</span><span>點一下看個股</span></div>
          <div class="card scroll-x" style={{ padding: "4px 8px" }}>
            <table class="sectors">
              <thead><tr><th>族群</th><th>訊號</th><th>近1週</th><th>近1月</th>{market !== "US" && <th>外資5日</th>}<th>上漲比</th></tr></thead>
              <tbody>
                {ms.sectors.map((s: SectorStat) => (
                  <tr onClick={() => pick(s.sector)}>
                    <td><b>{s.sector}</b> <span class="muted num" style={{ fontSize: "11px" }}>{s.count}</span></td>
                    <td><span class={`tag ${s.rotation}`}>{s.rotation}</span></td>
                    <td class={`num ${cls(s.ret1w)}`}>{fmtPct(s.ret1w)}</td>
                    <td class={`num ${cls(s.ret1m)}`}>{fmtPct(s.ret1m)}</td>
                    {market !== "US" && <td class={`num ${cls(s.foreignValue5)}`}>{fmtMoney(s.foreignValue5)}</td>}
                    <td class="num">{Math.round(s.breadth * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
            轉強＝近1週排名前 1/3 但近1月不在前 1/3；強勢延續＝兩者都在前 1/3；轉弱＝近1週掉到後 1/3 但近1月在前 1/3。
          </p>
        </>
      )}
    </div>
  );
}

// ---------------- 個股詳細 ----------------
export function StockDetail({ s, onClose }: { s: Scored; onClose: () => void }) {
  const { holdings, apiKey, reports } = useStore((st) => ({ holdings: st.holdings, apiKey: st.settings.apiKey, reports: st.reports }));
  const [bars, setBars] = useState<CandleBar[] | null>(null);
  const [barsErr, setBarsErr] = useState("");
  const [chartTab, setChartTab] = useState<"k" | "flow">("k");
  const [adding, setAdding] = useState(false);
  const holding = holdings.find((h) => h.code === s.code);
  const isExtra = useStore((st) => st.usExtra.some((x) => x.symbol === s.code)) && !holding;
  const today = taipeiToday();
  const reportKey = `stock:${s.code}:${today}`;
  const report = reports[reportKey];
  // 現價與 ETF 即時折溢價：大字原本是最近一個「收盤價」（可能是昨天），開啟詳情頁就抓即時價，盤中每 30 秒更新
  const live = useStore((st) => st.live[s.code]);
  const snapAsOf = useStore((st) => (s.market === "US" ? st.us.asOf : st.tw.asOf));
  const etfNav = useStore((st) => st.etfNav[s.code]);
  const lq = live && live.date && live.date >= (snapAsOf ?? "") ? live : undefined;
  const etf = s.market !== "US" && isEtf(s.code);
  useEffect(() => {
    const pull = () => {
      if (s.market === "US") refreshUsLive([s.code]); else refreshLive([s.code]);
      if (etf) refreshEtfNav();
    };
    pull();
    const t = setInterval(() => { if (s.market === "US" || marketOpen()) pull(); }, LIVE_MS);
    return () => clearInterval(t);
  }, [s.code]);
  const price = lq ? lq.price : s.close;
  // K 線圖盤中即時：用即時報價拼今天那一根（台股：證交所；美股：CNBC，日期都是當地交易日）
  const shownBars = useMemo(() => (bars ? (withLiveBar(bars, lq) as CandleBar[]) : bars), [bars, lq]);
  const liveBar = shownBars?.at(-1)?.live ? lq : undefined;
  const dayChg = lq && lq.prevClose > 0 ? lq.price / lq.prevClose - 1 : undefined;

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const b = s.market === "US" ? await usBars(s.code) : await twHistory(getFetcher(), getKv(), s.code, s.market, 9);
        if (alive) setBars(b.slice(-200));
      } catch (e: any) { if (alive) setBarsErr(`走勢圖下載失敗：${e?.message ?? e}`); }
    })();
    return () => { alive = false; };
  }, [s.code]);

  const [free, setFree] = useState("");
  const [freeBusy, setFreeBusy] = useState(false);
  const runFree = async () => {
    // 先用手上的資料馬上產生，營收下載完再補上（最多等 20 秒）
    setFree(freeReport({ s, bars: bars ?? [], holding, today }));
    if (s.market === "US" || s.refOnly) return;
    setFreeBusy(true);
    try {
      const revenue = await Promise.race([revenueOf(s.code, s.market), new Promise<undefined>((r) => setTimeout(() => r(undefined), 20000))]);
      if (revenue) setFree(freeReport({ s, bars: bars ?? [], revenue, holding, today }));
    } catch { /* 營收只是補充 */ } finally { setFreeBusy(false); }
  };

  const job = useStore((st) => st.aiJobs[reportKey]);
  const busy = job?.status === "running";
  const [newsText, setNewsText] = useState("");
  const newsUrls = parseUrls(newsText);
  // 在這一頁看到結果了，就不用再在上方提醒
  useEffect(() => { if (job?.status === "done") dismissAiJob(reportKey); }, [job?.status]);
  const runAi = () => {
    if (report && !confirmRerun(0.5)) return;
    startAiJob({ key: reportKey, kind: "stock", title: `${s.name} ${s.code}`, code: s.code, market: s.market === "US" ? "US" : s.refOnly ? "ETF" : "TW" },
      (onProgress) => analyzeStock(apiKey, s, today, holding, onProgress, newsUrls));
  };

  return (
    <Sheet title={`${s.name} ${s.code}`} onClose={onClose}>
      <div class="hero">
        <div>
          <div class="price num" data-testid="detail-price">{fmtPrice(price, s.market)}</div>
          <div class="num" style={{ marginTop: "4px", fontSize: "13px" }} data-testid="detail-price-note">
            {lq
              ? <><div class="muted">{s.market === "US" ? (lq.session ?? "收盤") : lq.final || !marketOpen() ? "收盤" : "盤中"}</div><div><span class="muted">昨收 {fmtPrice(lq.prevClose, s.market)}　</span><span class={cls(dayChg)}>{fmtPct(dayChg)}</span></div></>
              : <span class="muted">收盤價 {snapAsOf ? pretty(snapAsOf) : ""}（還沒抓到即時價）</span>}
          </div>
          <div class="muted" style={{ marginTop: "6px", fontSize: "13px" }}>{s.sector}・{s.market === "US" ? "美股" : `${s.market === "TPEX" ? "上櫃" : "上市"}${isEtf(s.code) ? " ETF" : ""}`}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <RatingPill rating={s.refOnly ? "參考" : s.rating} />
          <div class="num" style={{ fontSize: "26px", fontWeight: 800, marginTop: "6px" }}>{s.score}<span class="muted" style={{ fontSize: "13px" }}> / 100</span></div>
        </div>
      </div>

      <div class="grid2" style={{ marginTop: "14px" }}>
        <Metric k="近 1 週" v={fmtPct(s.ret1w)} c={cls(s.ret1w)} />
        <Metric k="近 1 月" v={fmtPct(s.ret1m)} c={cls(s.ret1m)} />
        <Metric k="近 3 月" v={fmtPct(s.ret3m)} c={cls(s.ret3m)} />
        {s.market === "US"
          ? <Metric k="相對 S&P 500（1月）" v={fmtPct(s.rsVsIndex1m)} c={cls(s.rsVsIndex1m)} />
          : <Metric k="外資近 5 日" v={lots(s.foreign5)} c={cls(s.foreign5)} d={s.foreignStreak ? `${s.foreignStreak > 0 ? "連買" : "連賣"} ${Math.abs(s.foreignStreak)} 天` : ""} />}
        {s.market !== "US" && <Metric k="投信近 5 日" v={lots(s.trust5)} c={cls(s.trust5)} />}
        {s.market !== "US" && <Metric k="外資近 10 日" v={lots(s.foreign10)} c={cls(s.foreign10)} />}
        {etf && etfNav && Number.isFinite(etfNav.premium) && (
          <Metric k="折溢價（即時）" v={`${etfNav.premium > 0 ? "+" : ""}${etfNav.premium.toFixed(2)}%`}
            d={`預估淨值 ${fmtPrice(etfNav.nav)}${Math.abs(etfNav.premium) >= 1 ? (etfNav.premium > 0 ? "・溢價偏高" : "・折價偏深") : ""}`} />
        )}
      </div>

      <div class="section-title">
        {s.market === "US"
          ? <span>K 線圖（日）</span>
          : <div class="seg" role="group" aria-label="圖表" data-testid="chart-tabs">
              <button aria-pressed={chartTab === "k"} onClick={() => setChartTab("k")} data-testid="tab-k">K 線圖</button>
              <button aria-pressed={chartTab === "flow"} onClick={() => setChartTab("flow")} data-testid="tab-flow">法人</button>
            </div>}
      </div>
      <div class="card">
        {chartTab === "flow" && s.market !== "US"
          ? (bars ? <FlowsPanel code={s.code} market={s.market === "TPEX" ? "TPEX" : "TWSE"} bars={bars} livePrice={lq?.price} /> : barsErr ? <div class="error">{barsErr}</div> : <div class="empty">載入中…</div>)
          : shownBars ? (shownBars.length > 1 ? <>
              <CandleChart bars={shownBars} us={s.market === "US"} cost={holding?.cost} />
              {liveBar && <div class="date-hint" data-testid="kbar-live">⏱ 最後一根是{liveBar.final ? "最新收盤" : "盤中"}的即時價（含成交量{liveBar.time ? `，台北 ${liveBar.time.slice(0, 5)}` : ""}），每 30 秒更新；{s.market === "US" ? "下次更新美股資料時換成正式日 K" : "證交所正式資料（約 15:00 後）出來後會換成正式的"}</div>}
            </> : <div class="empty">沒有走勢資料</div>) : barsErr ? <div class="error">{barsErr}</div> : <div class="empty">載入中…</div>}
      </div>

      {s.market !== "US" && isActiveEtf(s.code) && (
        <>
          <div class="section-title"><span>主動式 ETF 買賣的成份</span><span>經理人實際加減碼</span></div>
          <EtfHoldingsPanel code={s.code} />
        </>
      )}

      <div class="section-title"><span>{s.refOnly ? "分數說明（ETF 只供參考）" : "評等理由"}</span><span>動能 {Math.round(s.momentum * 100)}・{s.market === "US" ? "趨勢" : "籌碼"} {Math.round(s.flow * 100)}・族群 {Math.round(s.sectorScore * 100)}</span></div>
      <div class="card"><ul class="reasons">{s.reasons.map((r) => <li>{r}</li>)}</ul></div>

      {holding && (
        <>
          <div class="section-title"><span>我的持股</span></div>
          <div class="card num">{holding.shares.toLocaleString()} 股・成本 {fmtPrice(holding.cost, s.market)}・損益 <span class={cls(price - holding.cost)}>{fmtMoney((price - holding.cost) * holding.shares, s.market)}（{fmtPct(price / holding.cost - 1)}）</span></div>
        </>
      )}

      <div class="section-title"><span>免費解析（App 內建，不花錢）</span></div>
      {free ? <div class="card" data-testid="free-report"><Markdown text={free.replace(/^評等：.*\n/, "")} />{freeBusy && <div class="muted" style={{ fontSize: "12px" }}>正在下載每月營收…</div>}</div> : (
        <div class="notice">用 App 已有的資料（走勢、均線、法人籌碼、族群、每月營收）依固定規則寫成解析，馬上產生、完全免費。不含新聞與國際經濟數據。</div>
      )}
      {!free && <button class="btn secondary block" style={{ marginTop: "10px" }} disabled={freeBusy || bars === null} onClick={runFree} data-testid="free-btn">
        {freeBusy ? "產生中…" : bars === null && !barsErr ? "等待走勢資料…" : "免費解析"}
      </button>}

      <div class="section-title"><span>用 Claude App 解析（用你的訂閱，不扣 API 額度）</span></div>
      <ClaudeAppButton prompt={claudeAppPrompt(s, today, holding)} />

      <div class="section-title"><span>Claude AI 深度解析（付費）</span>{report && <span>{new Date(report.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新</span>}</div>
      {job?.status === "error" && <div class="error">{job.error}</div>}
      {busy && <AiProgressView job={job!} />}
      {report && !busy ? <AiReportView r={report} /> : busy ? null : (
        <div class="notice">
          {s.refOnly
            ? "Claude 會搜尋這檔 ETF 的成分股、配息、費用率與國內外經濟數據，說明特性、風險與適合的持有方式（不給買賣評等）。"
            : "Claude 會搜尋這檔股票最近的新聞、法說會與國內外經濟數據發表，搭配上面的籌碼數據寫成解析，並給出評等。"}每次約 2 分鐘，實測花費約台幣 15~20 元（每份解析下方會顯示實際花費）。
        </div>
      )}
      <div class="stack" style={{ marginTop: "12px" }}>
        {!busy && apiKey && (
          <label class="field">想讓 Claude 一起讀的新聞網址（選填，最多 3 個）
            <textarea rows={2} value={newsText} onInput={(e) => setNewsText((e.target as HTMLTextAreaElement).value)} placeholder="在新聞頁按「分享 → 複製連結」，貼在這裡" data-testid="news-urls"
              style={{ border: "1px solid var(--line)", background: "var(--surface)", color: "var(--fg)", borderRadius: "10px", padding: "10px 12px", fontSize: "14px", resize: "vertical" }} />
            {newsText.trim() && <span style={{ fontSize: "12px" }}>{newsUrls.length ? `Claude 會先讀這 ${newsUrls.length} 篇文章再分析` : "沒有找到網址，請貼 http 開頭的連結"}</span>}
          </label>
        )}
        <button class="btn block" disabled={busy || !apiKey} onClick={runAi}>
          {busy ? "Claude 分析中，可以先去看別的…" : report ? "重新解析（API 付費）" : "AI 深度解析（API 付費）"}
        </button>
        {!apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }}>先到「設定」貼上 Claude API 金鑰才能使用</div>}
        {apiKey && <BalanceHint />}
        {!holding && <button class="btn secondary block" onClick={() => setAdding(true)}>加入我的持股</button>}
        {isExtra && <button class="btn danger block" onClick={async () => { await removeUsSymbol(s.code); onClose(); }}>從美股清單移除 {s.code}</button>}
      </div>
      {adding && <HoldingForm initial={{ code: s.code, name: s.name, market: s.market, shares: 1000, cost: s.close }} onDone={() => setAdding(false)} />}
    </Sheet>
  );
}

function Metric({ k, v, c = "", d = "" }: { k: string; v: string; c?: string; d?: string }) {
  return <div class="metric"><div class="k">{k}</div><div class={`v num ${c}`}>{v}</div>{d && <div class="d muted">{d}</div>}</div>;
}

export function AiReportView({ r }: { r: AiReport }) {
  const m = /^\s*\**評等\**\s*[:：]\s*\**\s*(買入|觀望|離場|參考)/.exec(r.text);
  const body = m ? r.text.slice(r.text.indexOf("\n") + 1) : r.text;
  return (
    <div class="card">
      {m && m[1] !== "參考" && <div class="ai-rating">Claude 評等 <RatingPill rating={m[1] as Rating} /></div>}
      <Markdown text={body} />
      {r.sources.length > 0 && (
        <>
          <div class="section-title" style={{ marginTop: "8px" }}><span>資料來源</span></div>
          <ol class="sources">{r.sources.map((x) => <li><a href={x.url} target="_blank" rel="noreferrer">{x.title}</a></li>)}</ol>
        </>
      )}
      {!!r.fetched?.length && (
        <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "8px" }}>Claude 讀過你貼的文章：{r.fetched.length} 篇</div>
      )}
      {!!r.queries?.length && (
        <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "8px" }} data-testid="ai-queries">
          Claude 搜尋過的關鍵字（{r.queries.length} 次）：{r.queries.map((q) => `「${q}」`).join("、")}
        </div>
      )}
      <div class="muted" style={{ fontSize: "11px", marginTop: "8px" }}>
        {new Date(r.at).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 由 {r.model} 產生{r.costUsd !== undefined && Number.isFinite(r.costUsd) ? `・本次約 US$${r.costUsd.toFixed(2)}（約台幣 ${Math.round(r.costUsd * 32)} 元）` : ""}，僅供研究參考，非投資建議
      </div>
    </div>
  );
}

// ---------------- 持股 ----------------
// ---------------- 興櫃個股詳細（沒有評等，只有報價、走勢、我的損益） ----------------
function EsbDetail({ h, onClose }: { h: { code: string; name: string; shares: number; cost: number }; onClose: () => void }) {
  const lq = useStore((st) => st.live[h.code]);
  const close = useStore((st) => st.prices[h.code]?.close);
  const [bars, setBars] = useState<CandleBar[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const pull = () => refreshLive([h.code]);
    pull();
    const t = setInterval(() => { if (marketOpen()) pull(); }, 60_000); // 櫃買的行情表每分鐘才更新一次
    return () => clearInterval(t);
  }, [h.code]);
  useEffect(() => {
    let alive = true;
    esbHistory(getFetcher(), getKv(), h.code, 9).then((b) => { if (alive) setBars(b.slice(-200)); }).catch((e) => { if (alive) setErr(`走勢圖下載失敗：${e?.message ?? e}`); });
    return () => { alive = false; };
  }, [h.code]);
  const shown = useMemo(() => (bars ? (withLiveBar(bars, lq) as CandleBar[]) : bars), [bars, lq]);
  const price = lq ? lq.price : close ?? NaN;
  const live = !!lq && !lq.final && lq.date === taipeiToday() && marketOpen();
  const chg = lq && lq.prevClose > 0 ? lq.price / lq.prevClose - 1 : NaN;
  const pnl = (price - h.cost) * h.shares;
  return (
    <Sheet title={`${h.name} ${h.code}`} onClose={onClose}>
      <div class="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div class="big num" data-testid="esb-price">{fmtPrice(price)}</div>
          {Number.isFinite(chg) && <div class={`num ${cls(chg)}`} data-testid="esb-chg">今日 {fmtPct(chg)}（對前日均價）</div>}
        </div>
        <div class="muted" style={{ fontSize: "12px", textAlign: "right" }} data-testid="esb-note">
          興櫃股票・{live ? `盤中 ${lq!.time.slice(0, 5)}` : "收盤"}<br />櫃買中心行情每分鐘更新
        </div>
      </div>
      {lq && (
        <div class="grid2" style={{ marginTop: "10px" }} data-testid="esb-stats">
          <div class="metric"><div class="k">前日均價</div><div class="v num">{fmtPrice(lq.prevClose)}</div></div>
          <div class="metric"><div class="k">今日高／低</div><div class="v num">{Number.isFinite(lq.high) ? fmtPrice(lq.high) : "—"} ／ {Number.isFinite(lq.low) ? fmtPrice(lq.low) : "—"}</div></div>
          <div class="metric"><div class="k">今日成交量</div><div class="v num">{lq.volume && lq.volume > 0 ? `${Math.round(lq.volume / 1000).toLocaleString()} 張` : "—"}</div></div>
        </div>
      )}
      <div class="section-title"><span>走勢（日 K）</span></div>
      {shown && shown.length >= 2 ? <CandleChart bars={shown} cost={h.cost} />
        : err ? <div class="notice">{err}</div>
        : shown ? <div class="notice">還沒有足夠的興櫃成交資料可以畫走勢圖。</div>
        : <div class="muted">下載走勢中…</div>}
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "6px" }} data-testid="esb-kline-note">
        興櫃沒有開盤價與收盤價：K 線的開＝前一日均價、收＝當日均價（盤中那一根收盤用最新成交價），高低是當天最高與最低成交價。
      </div>
      <div class="section-title"><span>我的持股</span></div>
      <div class="card num" data-testid="esb-hold">{h.shares.toLocaleString()} 股・成本 {fmtPrice(h.cost)}・損益 <span class={cls(pnl)}>{fmtMoney(pnl)}（{fmtPct(price / h.cost - 1)}）</span></div>
      <div class="notice" style={{ marginTop: "10px" }}>興櫃股票沒有三大法人與族群資料，App 不評分、不給買賣建議，只提供報價、走勢與損益。</div>
    </Sheet>
  );
}

export function HoldingsScreen({ open }: { open: (s: Scored) => void }) {
  useStore((s) => [s.holdings, s.tw.scored, s.etf.scored, s.us.scored, s.esb, s.prices]);
  const apiKey = useStore((s) => s.settings.apiKey);
  const fx = usdTwdRate(useStore((s) => s.macro.quotes)); // 美元兌台幣，美股損益換成台幣用
  const live = useStore((s) => s.live);
  const twAsOf = useStore((s) => s.tw.asOf);
  const usAsOf = useStore((s) => s.us.asOf);
  // 持股即時價：台股用證交所、美股用 CNBC（盤中每 30 秒更新）
  const hs = useStore((s) => s.holdings);
  const twCodes = hs.filter((h) => h.market !== "US").map((h) => h.code);
  const usCodes = hs.filter((h) => h.market === "US").map((h) => h.code);
  const codeKey = twCodes.join(",") + "|" + usCodes.join(",");
  useEffect(() => {
    if (twCodes.length) refreshLive(twCodes);
    if (usCodes.length) refreshUsLive(usCodes);
    const t = setInterval(() => {
      if (twCodes.length && marketOpen()) refreshLive(twCodes);
      if (usCodes.length && usQuoteHours()) refreshUsLive(usCodes);
    }, LIVE_MS);
    return () => clearInterval(t);
  }, [codeKey]);
  const today = taipeiToday();
  const views = holdingViews().map((v) => {
    const isUs = v.market === "US";
    const q = live[v.code];
    if (q && q.date && q.date >= ((isUs ? usAsOf : twAsOf) ?? "")) {
      const price = q.price;
      return { ...v, price, pnl: (price - v.cost) * v.shares, pnlPct: v.cost > 0 ? price / v.cost - 1 : NaN,
        chg: Number.isFinite(q.prevClose) ? price / q.prevClose - 1 : NaN, liveLabel: isUs ? (q.session ?? "收盤") : !q.final && q.date === today && marketOpen() ? "盤中" : "收盤", ext: q.ext };
    }
    return { ...v, chg: v.scored?.chg1d ?? NaN, liveLabel: "收盤" };
  });
  const [adding, setAdding] = useState(false);
  const [esbOpen, setEsbOpen] = useState<any>(null);
  const [importing, setImporting] = useState<{ rows: ImportedHolding[]; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const total = (m: "TW" | "US") => {
    const vs = views.filter((v) => (m === "US") === (v.market === "US") && Number.isFinite(v.price));
    // 今日損益：有今日漲跌的持股，現價 − 昨收
    const dv = vs.filter((v) => Number.isFinite(v.chg));
    const day = dv.reduce((a, v) => a + v.shares * (v.price - v.price / (1 + v.chg)), 0);
    const dayBase = dv.reduce((a, v) => a + v.shares * v.price / (1 + v.chg), 0);
    return { value: vs.reduce((a, v) => a + v.price * v.shares, 0), pnl: vs.reduce((a, v) => a + v.pnl, 0), cost: vs.reduce((a, v) => a + v.cost * v.shares, 0), day, dayPct: dayBase ? day / dayBase : NaN, hasDay: dv.length > 0 };
  };
  const tw = total("TW"), us = total("US");

  // 自動測試用：讓測試程式把產生的截圖直接送進同一套辨識流程（手機上一般不會用到）
  useEffect(() => {
    (window as any).__srImportBase64 = async (b64: string) => {
      setBusy(true); setErr("");
      try {
        const r = await holdingsFromImage(getState().settings.apiKey, b64, "image/png");
        await recordSpend(r.costUsd, "照片辨識");
        if (!r.holdings.length) setErr("照片裡沒有辨識到持股，請換一張清楚的庫存截圖");
        else setImporting({ rows: r.holdings, note: r.note });
      } catch (e2) { setErr(explainError(e2)); }
      finally { setBusy(false); }
    };
    return () => { delete (window as any).__srImportBase64; };
  }, []);

  const onPhoto = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true); setErr("");
    try {
      const img = await shrinkImage(file);
      const r = await holdingsFromImage(apiKey, img.base64, img.mediaType);
      await recordSpend(r.costUsd, "照片辨識");
      if (!r.holdings.length) setErr("照片裡沒有辨識到持股，請換一張清楚的庫存截圖");
      else setImporting({ rows: r.holdings, note: r.note });
    } catch (e2) { setErr(explainError(e2)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div class="summary">
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>台股市值</div>{tw.cost ? <><div class="big num">{fmtMoney(tw.value)}</div><div class={`num ${cls(tw.pnl)}`} style={{ fontSize: "13px" }} data-testid="tw-pnl">總損益 {fmtMoney(tw.pnl)}（{fmtPct(tw.pnl / tw.cost)}）</div>{tw.hasDay && <div class={`num ${cls(tw.day)}`} style={{ fontSize: "12px" }} data-testid="tw-day">今日 {fmtMoney(tw.day)}（{fmtPct(tw.dayPct)}）</div>}</> : <div class="big muted">—</div>}</div>
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>美股市值</div>{us.cost ? <><div class="big num">{fmtMoney(us.value, "US")}</div><div class={`num ${cls(us.pnl)}`} style={{ fontSize: "13px" }} data-testid="us-pnl">總損益 {fmtMoney(us.pnl, "US")}（{fmtPct(us.pnl / us.cost)}）</div>{fx && <div class={`num ${cls(us.pnl)}`} style={{ fontSize: "13px" }} data-testid="us-ntd">{fmtNtd(us.pnl, fx)}</div>}{us.hasDay && <div class={`num ${cls(us.day)}`} style={{ fontSize: "12px" }}>今日 {fmtMoney(us.day, "US")}（{fmtPct(us.dayPct)}）</div>}</> : <div class="big muted">—</div>}</div>
      </div>
      <div class="row" style={{ marginTop: "12px" }}>
        <label class="btn" style={{ flex: 1 }} aria-disabled={busy || !apiKey}>
          {busy ? "Claude 辨識中…" : <><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>拍照／截圖匯入（API 付費）</>}
          <input type="file" accept="image/*" hidden disabled={busy || !apiKey} onChange={onPhoto} data-testid="photo-input" />
        </label>
        <button class="btn secondary" onClick={() => setAdding(true)}>手動新增</button>
      </div>
      {!apiKey && <div class="muted" style={{ fontSize: "13px", marginTop: "8px" }}>照片匯入需要 Claude API 金鑰（到「設定」貼上）；手動新增不需要。</div>}
      {err && <div class="error" style={{ marginTop: "10px" }}>{err}</div>}

      <div class="section-title"><span>持股健檢</span><span>{views.length} 檔</span></div>
      {views.length === 0 ? (
        <div class="empty">還沒有持股。<br />拍一張證券 App 的「庫存」畫面，Claude 會自動辨識代號、股數與成本。</div>
      ) : (
        <div class="list">
          {views.map((v) => <HoldingRow v={v} open={open} onEsb={setEsbOpen} fx={fx} />)}
        </div>
      )}
      {views.length > 0 && <HoldingsEditor />}
      {adding && <HoldingForm onDone={() => setAdding(false)} />}
      {esbOpen && <EsbDetail h={esbOpen} onClose={() => setEsbOpen(null)} />}
      {importing && <ImportReview data={importing} onDone={() => setImporting(null)} />}
    </div>
  );
}

/** 持股一列：左邊是名稱、損益金額（含報酬率）、建議；右邊是現價、今日漲跌、（美股盤前盤後）；賺紅賠綠 */
function HoldingRow({ v, open, onEsb, fx }: { v: any; open: (s: Scored) => void; onEsb?: (v: any) => void; fx?: number }) {
  const isEsb = useStore((st) => !!st.esb[v.code]);
  return (
    <button class="item" onClick={() => (v.scored ? open(v.scored) : isEsb && onEsb?.(v))}>
      <div style={{ minWidth: 0 }}>
        <div class="name">{v.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{v.code}</span></div>
        <div class={`num ${cls(v.pnl)}`} style={{ fontSize: "13px", fontWeight: 600, marginTop: "2px" }} data-testid="hold-pnl"><span class="lbl" style={{ fontFamily: "var(--font)", fontSize: "11px", fontWeight: 400, color: "var(--muted)", marginRight: "4px" }}>損益</span>{fmtSigned(v.pnl, v.market)}<span style={{ whiteSpace: "nowrap" }}>（{fmtPct(v.pnlPct)}）</span>{v.market === "US" && fx && Number.isFinite(v.pnl) && <span style={{ display: "block", whiteSpace: "nowrap" }} data-testid="hold-ntd">{fmtNtd(v.pnl, fx)}</span>}</div>
        <div class="muted num" style={{ fontSize: "12px", marginTop: "2px" }} data-testid="hold-avg">{v.shares.toLocaleString()} 股・均價 {v.market === "US" ? "$" : ""}{fmtPrice(v.cost, v.market === "US" ? "US" : undefined)}</div>
        <div class="sub">{v.advice.join("；")}</div>
      </div>
      <div class="px">
        <div class="p num"><span class="lbl" data-testid="hold-label">{v.liveLabel}</span>{fmtPrice(v.price, v.market)}</div>
        {Number.isFinite(v.chg) && <div class={`c num ${cls(v.chg)}`} data-testid="hold-day"><span class="lbl">今日</span>{fmtPct(v.chg)}</div>}
        {"ext" in v && v.ext && <div class={`c num ${cls(v.ext.chg)}`} data-testid="hold-ext"><span class="lbl">{v.ext.label}</span>{fmtPrice(v.ext.price, v.market)} {fmtPct(v.ext.chg)}</div>}
      </div>
      <RatingPill rating={v.rating} />
    </button>
  );
}

function HoldingsEditor() {
  const holdings = useStore((s) => s.holdings);
  const [editing, setEditing] = useState<Holding | null>(null);
  return (
    <>
      <div class="section-title"><span>編輯持股</span></div>
      <div class="chips" style={{ flexWrap: "wrap" }}>
        {holdings.map((h) => <button class="chip" onClick={() => setEditing(h)}>{h.name} ✎</button>)}
      </div>
      {editing && <HoldingForm initial={editing} onDone={() => setEditing(null)} />}
    </>
  );
}

function marketOf(code: string, hint?: string): Holding["market"] {
  if (hint === "US" || /^[A-Z][A-Z.]*$/.test(code)) return "US";
  const s = findScored(code, "TW");
  return s?.market === "TPEX" ? "TPEX" : "TWSE";
}

function HoldingForm({ initial, onDone }: { initial?: Partial<Holding>; onDone: () => void }) {
  const holdings = useStore((s) => s.holdings);
  const [code, setCode] = useState(initial?.code ?? "");
  const [shares, setShares] = useState(String(initial?.shares ?? ""));
  const [cost, setCost] = useState(String(initial?.cost ?? ""));
  const [err, setErr] = useState("");
  const isEdit = !!initial?.id;
  const save = async () => {
    const c = code.trim().toUpperCase();
    const sh = Number(shares), co = Number(cost);
    if (!c) return setErr("請輸入股票代號");
    if (!(sh > 0)) return setErr("股數要大於 0（1 張 = 1000 股）");
    if (!(co > 0)) return setErr("成本要大於 0");
    const market = marketOf(c, initial?.market === "US" ? "US" : undefined);
    const name = findScored(c, market === "US" ? "US" : "TW")?.name ?? getState().prices[c]?.name ?? initial?.name ?? c;
    const h: Holding = { id: initial?.id ?? `${Date.now()}-${c}`, code: c, name, market, shares: sh, cost: co };
    await saveHoldings(isEdit ? holdings.map((x) => (x.id === h.id ? h : x)) : [...holdings.filter((x) => x.code !== c), h]);
    if (market === "US" && !findScored(c, "US")) addUsSymbol(c); // 不在清單裡的美股持股，自動下載
    onDone();
  };
  const remove = async () => { await saveHoldings(holdings.filter((x) => x.id !== initial?.id)); onDone(); };
  return (
    <Sheet title={isEdit ? `編輯 ${initial?.name}` : "新增持股"} onClose={onDone}>
      <div class="stack">
        <label class="field">股票代號<input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="例如 2330 或 AAPL" autocapitalize="characters" id="h-code" /></label>
        <div class="formgrid">
          <label class="field">股數<input inputMode="numeric" value={shares} onInput={(e) => setShares((e.target as HTMLInputElement).value)} id="h-shares" /></label>
          <label class="field">每股平均成本<input inputMode="decimal" value={cost} onInput={(e) => setCost((e.target as HTMLInputElement).value)} id="h-cost" /></label>
        </div>
        <div class="muted" style={{ fontSize: "12px" }}>台股 1 張 = 1000 股；零股直接填股數。</div>
        {err && <div class="error">{err}</div>}
        <button class="btn block" onClick={save}>儲存</button>
        {isEdit && <button class="btn danger block" onClick={remove}>刪除這檔持股</button>}
      </div>
    </Sheet>
  );
}

function ImportReview({ data, onDone }: { data: { rows: ImportedHolding[]; note: string }; onDone: () => void }) {
  const holdings = useStore((s) => s.holdings);
  // 股數、成本用字串存（打小數點時 "25." 不能被轉成數字吃掉），存檔時才轉成數字檢查
  const [rows, setRows] = useState(data.rows.map((r) => ({ ...r, sharesText: String(r.shares ?? ""), costText: String(r.cost ?? ""), keep: !!r.code && r.shares > 0 })));
  const [err, setErr] = useState("");
  const upd = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    const picked = rows.filter((r) => r.keep && r.code).map((r) => ({ r, shares: Number(r.sharesText), cost: Number(r.costText) }));
    const bad = picked.find((x) => !(x.shares > 0) || !(x.cost > 0));
    if (bad) return setErr(`「${bad.r.name || bad.r.code}」的股數或每股成本不正確（要大於 0），請改好再加入，或取消勾選這一檔`);
    setErr("");
    const add: Holding[] = picked.map(({ r, shares, cost }) => {
      const code = r.code.trim().toUpperCase();
      const market = marketOf(code, r.market);
      return { id: `${Date.now()}-${code}`, code, name: findScored(code, market === "US" ? "US" : "TW")?.name ?? getState().prices[code]?.name ?? r.name, market, shares, cost };
    });
    const codes = new Set(add.map((h) => h.code));
    await saveHoldings([...holdings.filter((h) => !codes.has(h.code)), ...add]);
    onDone();
  };
  return (
    <Sheet title="確認辨識結果" onClose={onDone}>
      <div class="notice">請核對 Claude 辨識的內容，數字不對可以直接改。同代號的持股會被覆蓋。{data.note && <><br />Claude 備註：{data.note}</>}</div>
      <div class="list" style={{ marginTop: "12px" }}>
        {rows.map((r, i) => (
          <div class="import-row">
            <label class="check">
              <input type="checkbox" checked={r.keep} onChange={(e) => upd(i, { keep: (e.target as HTMLInputElement).checked })} />
              <b>{r.name || "（未辨識名稱）"}</b>
            </label>
            <label class="field">代號<input value={r.code} onInput={(e) => upd(i, { code: (e.target as HTMLInputElement).value })} /></label>
            <label class="field">股數<input inputMode="numeric" value={r.sharesText} onInput={(e) => upd(i, { sharesText: (e.target as HTMLInputElement).value })} /></label>
            <label class="field" style={{ gridColumn: "1 / -1" }}>每股成本<input inputMode="decimal" value={r.costText} onInput={(e) => upd(i, { costText: (e.target as HTMLInputElement).value })} /></label>
          </div>
        ))}
      </div>
      {err && <div class="error" style={{ marginTop: "12px" }}>{err}</div>}
      <button class="btn block" style={{ marginTop: "14px" }} onClick={save}>加入 {rows.filter((r) => r.keep).length} 檔持股</button>
    </Sheet>
  );
}

// ---------------- 數據（國內外指標＋AI 解讀） ----------------
export function MacroScreen() {
  const st = useStore((s) => ({ macro: s.macro, tw: s.tw, us: s.us, idx: s.twIndices, breadth: s.twBreadth, idxLive: s.twIndexLive, fut: s.futures, turnover: s.twTurnover, etfs: s.usSectorEtfs, apiKey: s.settings.apiKey, reports: s.reports }));
  // 台股指數盤中每 30 秒更新（收盤後 MIS 回傳收盤價，仍會顯示）
  useEffect(() => {
    refreshTwIndex(); refreshFutures(); refreshTurnover();
    const t = setInterval(() => { if (marketOpen()) refreshTwIndex(); refreshFutures(); refreshTurnover(); }, LIVE_MS);
    return () => clearInterval(t);
  }, []);
  // 盤中即時優先，沒有再用快照的收盤
  const liveIdx = INDEX_CH.map((c) => st.idxLive[c.name]).filter(Boolean);
  const idxFinal = liveIdx.length > 0 && liveIdx.every((i) => i.final);
  const idxTime = liveIdx.find((i) => !i.final)?.time?.slice(0, 5) ?? "";
  const today = taipeiToday();
  const key = `brief:${today}`;
  const job = useStore((s) => s.aiJobs[key]);
  const busy = job?.status === "running";
  useEffect(() => { if (job?.status === "done") dismissAiJob(key); }, [job?.status]);
  const report = st.reports[key];
  const bySymbol = new Map(st.macro.quotes.map((q) => [q.symbol, q]));
  const groups = ["亞洲", "美股", "利率匯率", "原物料"] as const;

  const runAi = () => {
    if (report && !confirmRerun(1)) return;
    const top = [...st.tw.scored.slice(0, 5), ...st.us.scored.slice(0, 5)];
    startAiJob({ key, kind: "brief", title: "今日國內外數據" },
      (onProgress) => marketBrief(st.apiKey, today, st.tw.sectors, st.us.sectors, st.macro.quotes, top, onProgress));
  };

  return (
    <div>
      {liveIdx.length > 0 ? (
        <>
          <div class="section-title" data-testid="tw-index-title"><span>台股{idxFinal ? "收盤" : idxTime ? `盤中 ${idxTime}` : ""}</span></div>
          <div class="grid2">
            {liveIdx.map((i) => <Metric k={i.name.replace("發行量加權股價指數", "加權指數")} v={i.value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} c={cls(i.change)} d={`${i.change > 0 ? "+" : ""}${i.change.toFixed(2)}（${i.changePct > 0 ? "+" : ""}${i.changePct.toFixed(2)}%）`} />)}
            {(() => {
              const w = st.idxLive["加權指數"];
              if (!w) return null;
              return <>
                {st.turnover && <Metric k="成交金額" v={`${Math.round(st.turnover.value / 1e8).toLocaleString("zh-TW")} 億元`} c="" d={`${pretty(st.turnover.date)} 收盤・證交所公布的全市場合計`} />}
                {w.high !== undefined && w.low !== undefined && <Metric k="加權今日高低" v={`${w.high.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} / ${w.low.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`} c="" d="最高 / 最低" />}
              </>;
            })()}
          </div>
        </>
      ) : st.idx.length > 0 && (
        <>
          <div class="section-title"><span>台股收盤（{st.tw.asOf ? pretty(st.tw.asOf) : ""}）</span></div>
          <div class="grid2">
            {st.idx.map((i) => <Metric k={i.name.replace("發行量加權股價指數", "加權指數")} v={i.close.toLocaleString("zh-TW")} c={cls(i.change)} d={`${i.change > 0 ? "+" : ""}${i.change.toFixed(2)}（${i.changePct > 0 ? "+" : ""}${i.changePct}%）`} />)}
          </div>
        </>
      )}
      {(st.fut.day || st.fut.night) && (
        <>
          <div class="section-title" data-testid="fut-title"><span>台指期（近月）</span></div>
          <div class="grid2" data-testid="fut-grid">
            {([["日盤", st.fut.day], ["夜盤", st.fut.night]] as const).map(([name, q]) => q && (q.settleOnly ? (
              <Metric k={`台指期 ${name}`} v={q.last.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} d="昨結算價・08:45 開盤後換成即時" />
            ) : (
              <Metric k={`台指期 ${name}`} v={q.last.toLocaleString("zh-TW", { maximumFractionDigits: 0 })} c={cls(q.change)}
                d={`${q.change > 0 ? "+" : ""}${q.change.toFixed(0)}（${q.changePct > 0 ? "+" : ""}${q.changePct.toFixed(2)}%）${q.session === "day" && q.date && q.date !== taipeiToday() ? `・${q.date.slice(4, 6).replace(/^0/, "")}/${q.date.slice(6, 8).replace(/^0/, "")} 收盤` : q.time ? `・${q.time}` : ""}${q.high !== undefined && q.low !== undefined ? `・高 ${q.high.toLocaleString("zh-TW")} 低 ${q.low.toLocaleString("zh-TW")}` : ""}`} />
            )))}
            {st.fut.day?.spot && (() => {
              const q = st.fut.day, basis = q.last - q.spot!;
              return <Metric k="基差（期貨−現貨）" v={`${basis > 0 ? "+" : ""}${basis.toFixed(0)} 點`}
                d={`${basis > 0 ? "正價差" : basis < 0 ? "逆價差" : "平價"}（${basis > 0 ? "+" : ""}${((basis / q.spot!) * 100).toFixed(2)}%）・期貨 ${q.last.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}／現貨 ${q.spot!.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`} />;
            })()}
          </div>
          <div class="muted" style={{ fontSize: "11px", marginTop: "4px", lineHeight: 1.5 }}>夜盤是昨晚 15:00 到今天清晨 05:00 的交易，漲跌是對前一個交易日的結算價；開盤前可以先看夜盤預判今天開盤方向。基差＝日盤近月期貨價減現貨（加權指數）價，正的是正價差（期貨比現貨貴），負的是逆價差；日盤收盤後的基差是收盤時的。</div>
        </>
      )}
      {st.breadth && (
        <>
          <div class="section-title"><span>漲跌家數（收盤 {st.tw.asOf ? pretty(st.tw.asOf) : ""}）</span></div>
          <div class="grid2">
            {([["上市", st.breadth.twse], ["上櫃", st.breadth.tpex]] as const).map(([k, b]) => (
              <Metric k={k} v={`漲 ${b.up}／跌 ${b.down}`} c={b.up > b.down ? "up" : b.up < b.down ? "down" : ""} d={`持平 ${b.flat}`} />
            ))}
          </div>
        </>
      )}
      {st.macro.error && <div class="error" style={{ marginTop: "10px" }}>{st.macro.error}</div>}
      {st.macro.status === "loading" && <div class="empty">國際指標載入中…</div>}
      {groups.map((g) => {
        const items = MACRO_SYMBOLS.filter((m) => m.group === g && bySymbol.has(m.symbol));
        if (!items.length) return null;
        return (
          <>
            <div class="section-title"><span>{g}</span></div>
            <div class="grid2">
              {items.map((m) => {
                const q = bySymbol.get(m.symbol)!;
                return <Metric k={m.label} v={q.last.toLocaleString("en-US", { maximumFractionDigits: 3 })} c={cls(q.change)} d={`${q.change > 0 ? "+" : ""}${q.change}（${q.changePct > 0 ? "+" : ""}${q.changePct}%）`} />;
              })}
            </div>
          </>
        );
      })}
      {st.etfs.length > 0 && (
        <>
          <div class="section-title"><span>美股產業 ETF（近 1 月）</span></div>
          <div class="card scroll-x" style={{ padding: "4px 8px" }}>
            <table class="sectors">
              <thead><tr><th>產業</th><th>ETF</th><th>近1週</th><th>近1月</th><th>近3月</th></tr></thead>
              <tbody>
                {[...st.etfs].sort((a, b) => b.ret1m - a.ret1m).map((e) => (
                  <tr><td>{e.sector}</td><td class="num">{e.symbol}</td><td class={`num ${cls(e.ret1w)}`}>{fmtPct(e.ret1w)}</td><td class={`num ${cls(e.ret1m)}`}>{fmtPct(e.ret1m)}</td><td class={`num ${cls(e.ret3m)}`}>{fmtPct(e.ret3m)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div class="section-title"><span>AI 國內外數據解讀</span>{report && <span>{new Date(report.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })} 更新</span>}</div>
      {job?.status === "error" && <div class="error">{job.error}</div>}
      {busy && <AiProgressView job={job!} />}
      {report && !busy ? <AiReportView r={report} /> : busy ? null : (
        <div class="notice">Claude 會搜尋最近一週國內外發表的經濟數據（美國 CPI、非農、Fed、台灣出口、央行等），寫出實際值與預期值的比較，並解讀族群輪動與外資動向。約 3~4 分鐘，實測花費約台幣 30 元。</div>
      )}
      <button class="btn block" style={{ marginTop: "12px" }} disabled={busy || !st.apiKey} onClick={runAi}>
        {busy ? "Claude 分析中，可以先去看別的…" : report ? "重新解讀（API 付費）" : "產生今日解讀（API 付費）"}
      </button>
      {!st.apiKey && <div class="muted" style={{ fontSize: "13px", textAlign: "center", marginTop: "8px" }}>先到「設定」貼上 Claude API 金鑰</div>}
      {st.apiKey && <div style={{ marginTop: "8px" }}><BalanceHint /></div>}
    </div>
  );
}

// ---------------- 設定 ----------------
// ---------------- App 更新 ----------------
function UpdateBody({ compact }: { compact?: boolean }) {
  const u = useStore((s) => s.update);
  const latest = u.info?.latest;
  const pct = u.total ? Math.round(((u.done ?? 0) / u.total) * 100) : 0;
  if (u.status === "downloading") return (
    <div class="stack">
      <div>正在下載新版 {latest?.versionName}… {u.total ? `${pct}%（${((u.done ?? 0) / 1e6).toFixed(1)} / ${(u.total / 1e6).toFixed(1)} MB）` : ""}</div>
      <div class="bar"><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
  if (u.status === "installing") return <div>下載完成，請在跳出的畫面按「更新」。資料和持股都會保留。</div>;
  if (u.status === "needPermission") return (
    <div class="stack">
      <div>第一次更新需要允許：請在剛打開的設定頁開啟「允許安裝這個來源的應用程式」，回到 App 再按一次「立即更新」。</div>
      <button class="btn block" onClick={installUpdate} data-testid="install-update">立即更新</button>
    </div>
  );
  if (u.info?.available && latest) return (
    <div class="stack">
      <div><b>有新版本 {latest.versionName}</b>{compact ? "" : `（目前 ${u.info.current?.versionName}）`}</div>
      {latest.notes && <UpdateNotes notes={latest.notes} />}
      <button class="btn block" onClick={installUpdate} data-testid="install-update">立即更新</button>
    </div>
  );
  return null;
}

/** 更新內容：只先顯示最新 5 項（新的在最上面），其餘收起來 */
function UpdateNotes({ notes }: { notes: string }) {
  const [all, setAll] = useState(false);
  const { shown, hidden } = latestNotes(notes);
  const list = all ? [...shown, ...hidden] : shown;
  return (
    <div class="muted" style={{ fontSize: "13px", lineHeight: 1.6 }} data-testid="update-notes">
      <div style={{ fontWeight: 600, marginBottom: "2px" }}>最新更新</div>
      {list.map((x) => <div>{x}</div>)}
      {hidden.length > 0 && <button class="linkbtn" onClick={() => setAll(!all)}>{all ? "收起舊的更新" : `看更早的 ${hidden.length} 項更新`}</button>}
    </div>
  );
}

/** 有新版時顯示在每個分頁最上面 */
export function UpdateBanner() {
  const u = useStore((s) => s.update);
  if (!(u.info?.available || u.status === "downloading" || u.status === "installing" || u.status === "needPermission")) return null;
  return <div class="card" style={{ marginBottom: "12px", borderColor: "var(--accent)" }} data-testid="update-banner"><UpdateBody compact /></div>;
}

function UpdateCard() {
  const u = useStore((s) => s.update);
  const cur = u.info?.current;
  return (
    <div class="card stack" data-testid="update-card">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <div>目前版本 <span class="num">{cur?.versionName ?? "—"}</span></div>
        <button class="btn secondary" disabled={u.status === "checking" || u.status === "downloading"} onClick={checkForUpdate}>{u.status === "checking" ? "檢查中…" : "檢查更新"}</button>
      </div>
      {u.error && <div class="error">{u.error}</div>}
      {u.status === "ready" && !u.info?.available && <div class="muted" data-testid="up-to-date">已是最新版本{u.info?.latest ? `（最新 ${u.info.latest.versionName}）` : ""}</div>}
      <UpdateBody />
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>每次打開 App 會自動檢查；有新版會在畫面最上方提示，按「立即更新」就會在 App 裡下載並安裝，持股與設定都會保留。</div>
    </div>
  );
}

/** 把提問複製到剪貼簿，再打開 Claude App（或網頁）並帶入提問 */
/** 複製文字到剪貼簿。要在離開 App 之前同步複製完，所以先用同步的 execCommand，失敗才用非同步的 clipboard API */
export function copyText(text: string, done: (ok: boolean) => void) {
  const ta = document.createElement("textarea");
  ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { /* 改用 clipboard API */ }
  ta.remove();
  if (ok) { done(true); return; }
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
  else done(false);
}

function ClaudeAppButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const copy = () => copyText(prompt, (ok) => setCopied(ok ? "ok" : "fail"));
  return (
    <div class="stack">
      <div class="notice">
        會打開手機上的 Claude App，帶入這檔股票的 App 數據與提問。Claude App 用你的 Claude 訂閱（不扣這裡的 API 額度），可以上網搜尋新聞，也能用你在 Claude 連接的台股工具（MCP）查營收與法人資料，還能繼續追問。
      </div>
      <a class="btn secondary block" href={claudeAppUrl(prompt)} target="_blank" rel="noreferrer" onClick={copy} data-testid="claude-app">在 Claude App 解析</a>
      {copied === "ok" && <div class="muted" style={{ fontSize: "13px", textAlign: "center" }} data-testid="claude-app-copied">已複製提問。如果 Claude 沒有自動帶入，在輸入框長按「貼上」再送出。</div>}
      {copied === "fail" && <div class="muted" style={{ fontSize: "13px" }}>沒辦法自動複製，請在 Claude 自行描述要分析的股票。</div>}
    </div>
  );
}

// ---------------- Claude 背景解析：進度與提醒 ----------------
const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

/** 每秒重畫一次（顯示經過時間） */
function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

export function progressText(job: AiJob): string {
  const p = job.progress;
  switch (p.phase) {
    case "start": return "連線到 Claude…";
    case "thinking": return p.searches ? "整理搜尋到的資料…" : "思考要查哪些資料…";
    case "searching": return `網路搜尋第 ${p.searches} 次${p.lastQuery ? `：「${p.lastQuery}」` : "…"}`;
    case "fetching": return "讀你貼的新聞文章…";
    case "reading": return `閱讀搜尋結果（已搜尋 ${p.searches} 次）`;
    case "writing": return `撰寫中${p.section ? `：${p.section}` : ""}（已寫 ${p.chars.toLocaleString()} 字）`;
  }
}

/** 個股頁／數據頁裡的進度卡 */
export function AiProgressView({ job }: { job: AiJob }) {
  useTick(true);
  const p = job.progress;
  const steps = [
    { k: "搜尋資料", done: p.phase === "writing", on: p.phase === "searching" || p.phase === "reading" || p.phase === "thinking" || p.phase === "start" },
    { k: "撰寫解析", done: false, on: p.phase === "writing" },
  ];
  return (
    <div class="card stack" data-testid="ai-progress" aria-live="polite">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <b><span class="spin" style={{ display: "inline-block" }}>◐</span> Claude 正在分析</b>
        <span class="muted num" style={{ fontSize: "13px" }}>已經過 {mmss(Date.now() - job.startedAt)}</span>
      </div>
      <div style={{ fontSize: "14px" }} data-testid="ai-progress-text">{progressText(job)}</div>
      <div class="row" style={{ gap: "6px" }}>
        {steps.map((x) => <span class="tag" style={{ background: x.on ? "var(--hold-bg)" : "var(--surface-2)", color: x.done ? "var(--muted)" : x.on ? "var(--hold)" : "var(--muted)" }}>{x.done ? "✓ " : ""}{x.k}</span>)}
        <span class="muted" style={{ fontSize: "12px" }}>已搜尋 {p.searches} 次</span>
      </div>
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>通常 2～4 分鐘。可以離開這頁去看別的，App 最上方會顯示進度，完成後點一下就能看。請不要關掉 App。</div>
    </div>
  );
}

/** 每個分頁最上方：背景解析的進度與完成提醒 */
export function AiJobBanner({ open }: { open: (job: AiJob) => void }) {
  const jobs = useStore((s) => Object.values(s.aiJobs));
  useTick(jobs.some((j) => j.status === "running"));
  if (!jobs.length) return null;
  return (
    <div class="stack" style={{ marginBottom: "12px" }}>
      {jobs.map((j) => (
        <div class="card row" style={{ padding: "10px 12px", gap: "10px", flexWrap: "nowrap", borderColor: j.status === "done" ? "var(--up)" : j.status === "error" ? "var(--hold)" : "var(--accent)" }} data-testid="ai-banner">
          <button style={{ flex: 1, minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0, cursor: "pointer" }} onClick={() => open(j)}>
            <div style={{ fontWeight: 700, fontSize: "14px" }}>
              {j.status === "running" ? <>Claude 分析中：{j.title}<span class="muted num" style={{ fontWeight: 400 }}>・{mmss(Date.now() - j.startedAt)}</span></>
                : j.status === "done" ? <>{j.title} 解析完成，點我看</> : <>{j.title} 解析失敗</>}
            </div>
            <div class="muted" style={{ fontSize: "12px", marginTop: "2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {j.status === "running" ? progressText(j) : j.status === "error" ? j.error : j.kind === "aietf" ? "在「自組ETF」分頁，照建議下單後填入成交" : j.kind === "brief" ? "在「數據」分頁，之後再看也看得到" : "已存到這檔股票的頁面，之後再點進去也看得到"}
            </div>
          </button>
          {j.status !== "running" && <button class="iconbtn" style={{ width: "32px", height: "32px" }} aria-label="關閉提醒" onClick={() => dismissAiJob(j.key)}>✕</button>}
        </div>
      ))}
    </div>
  );
}

/** 已經有今天的報告時，重做前先確認（會再花一次錢） */
function confirmRerun(usd: number) {
  const left = estimatedBalance(getState());
  const bal = left === undefined ? "" : `，估計剩餘 US$${left.toFixed(2)}`;
  return window.confirm(`今天已經解析過了，畫面上的報告不用錢就能看。\n\n重新解析會再花約 US$${usd.toFixed(1)}（約台幣 ${Math.round(usd * 32)} 元）${bal}。確定要重新解析嗎？`);
}

/** 付費按鈕下方的小字：估計剩餘額度 */
export function BalanceHint() {
  const left = useStore((s) => estimatedBalance(s));
  if (left === undefined) return null;
  return <div class={`num ${left < 1 ? "warn" : "muted"}`} style={{ fontSize: "13px", textAlign: "center" }}>估計剩餘額度 US${left.toFixed(2)}{left < 1 ? "，快用完了" : ""}</div>;
}

function SpendCard() {
  const spend = useStore((s) => s.spend);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const sum = (xs: typeof spend) => xs.reduce((a, x) => a + x.usd, 0);
  const month = spend.filter((x) => x.at >= monthStart);
  const byKind = new Map<string, { n: number; usd: number }>();
  for (const x of month) {
    const k = byKind.get(x.kind) ?? { n: 0, usd: 0 };
    k.n++; k.usd += x.usd; byKind.set(x.kind, k);
  }
  const twd = (usd: number) => `約台幣 ${Math.round(usd * 32)} 元`;
  const settings = useStore((s) => s.settings);
  const left = useStore((s) => estimatedBalance(s));
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const [err, setErr] = useState("");
  const saveBal = async () => {
    const cleaned = val.replace(/[^\d.]/g, "");
    const v = cleaned ? Number(cleaned) : NaN;
    if (!Number.isFinite(v) || v <= 0) return setErr("請輸入官網顯示的金額（要大於 0），例如 2.05");
    await saveSettings({ ...settings, balance: { usd: v, at: Date.now() } });
    setEditing(false); setErr("");
  };
  const b = settings.balance;
  return (
    <div class="card stack">
      <div class="metric" data-testid="balance">
        <div class="k">估計剩餘額度</div>
        {left === undefined
          ? <div class="v muted" style={{ fontSize: "15px" }}>尚未填入</div>
          : <><div class={`v num ${left < 1 ? "warn" : ""}`}>US${left.toFixed(2)}</div>
            <div class="d muted">{twd(Math.max(left, 0))}・{new Date(b!.at).toLocaleDateString("zh-TW")} 填入 US${b!.usd.toFixed(2)}，之後花了 US${(b!.usd - left).toFixed(2)}</div></>}
        {left !== undefined && left < 1 && <div class="d warn">額度快用完了，請到官網儲值，儲值後再更新這裡的金額</div>}
      </div>
      {editing ? (
        <div class="stack">
          <label class="field">官網顯示的 Credit balance（美元）<input inputMode="decimal" value={val} onInput={(e) => setVal((e.target as HTMLInputElement).value)} placeholder="例如 2.05" id="balance-input" /></label>
          {err && <div class="error">{err}</div>}
          <div class="row"><button class="btn" style={{ flex: 1 }} onClick={saveBal}>儲存餘額</button><button class="btn secondary" onClick={() => setEditing(false)}>取消</button></div>
        </div>
      ) : (
        <button class="btn secondary block" onClick={() => { setVal(b ? b.usd.toFixed(2) : ""); setEditing(true); }}>{b ? "更新餘額（儲值後）" : "填入目前餘額"}</button>
      )}
      <div class="grid2">
        <div class="metric"><div class="k">本月花費</div><div class="v num">US${sum(month).toFixed(2)}</div><div class="d muted">{twd(sum(month))}</div></div>
        <div class="metric"><div class="k">累計花費</div><div class="v num">US${sum(spend).toFixed(2)}</div><div class="d muted">{spend.length} 次呼叫</div></div>
      </div>
      {byKind.size > 0 && (
        <div class="muted" style={{ fontSize: "13px", lineHeight: 1.7 }}>
          本月：{[...byKind.entries()].map(([k, v]) => `${k} ${v.n} 次 US$${v.usd.toFixed(2)}`).join("、")}
        </div>
      )}
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
        花費是 App 依 Claude 回傳的用量自己算的，只包含這支手機的使用。Anthropic 沒有開放用金鑰查詢餘額，所以剩餘額度要你從官網抄一次，之後 App 會自動扣掉每次的花費；儲值後再按「更新餘額」。
      </div>
      <a class="btn secondary block" href="https://platform.claude.com/settings/billing" target="_blank" rel="noreferrer">查看剩餘額度／儲值</a>
    </div>
  );
}

/** 設定頁的「資料」卡：兩個按鈕按下去要看得到進度與結果（之前只在別的分頁更新，設定頁看起來沒反應） */
function DataRefreshCard() {
  const st = useStore((s) => ({ tw: s.tw, us: s.us, macro: s.macro }));
  const [running, setRunning] = useState(false);
  const [doneAt, setDoneAt] = useState<number | undefined>();
  const busy = running || !!st.tw.progress || !!st.us.progress;
  const hhmm = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
  const refreshAll = async () => {
    setRunning(true); setDoneAt(undefined);
    await Promise.allSettled([refreshTw(), refreshEsb(), refreshUs(), refreshMacro()]);
    setRunning(false); setDoneAt(Date.now());
  };
  const clear = async () => {
    if (!window.confirm("清除快取會把台股、美股資料全部重新下載，台股約需 1～3 分鐘，這段時間選股頁會暫時沒有資料。確定要清除嗎？")) return;
    setRunning(true); setDoneAt(undefined);
    await clearCache();
    setRunning(false); setDoneAt(Date.now());
  };
  const line = (name: string, m: { progress?: { done: number; total: number; label: string }; error?: string; asOf?: string; fetchedAt?: number }) =>
    m.progress ? `${name}：更新中（${m.progress.label} ${m.progress.done}/${m.progress.total}）`
      : m.error ? `${name}：${m.error}`
      : m.asOf ? `${name}：資料日 ${pretty(m.asOf)}・${hhmm(m.fetchedAt)} 已檢查` : `${name}：尚無資料`;
  const lines = [line("台股", st.tw), line("美股", st.us),
    st.macro.status === "loading" ? "國際指標：更新中" : st.macro.error ? `國際指標：${st.macro.error}` : st.macro.at ? `國際指標：${hhmm(st.macro.at)} 已更新` : "國際指標：尚無資料"];
  const bad = lines.some((l) => /失敗|錯誤/.test(l));
  return (
    <div class="card stack" data-testid="data-card">
      <div class="row">
        <button class="btn secondary" disabled={busy} onClick={refreshAll} data-testid="refresh-all">{busy ? "更新中…" : "立即更新全部資料"}</button>
        <button class="btn danger" disabled={busy} onClick={clear}>清除快取重新下載</button>
      </div>
      <div class={bad ? "error" : "notice"} style={{ fontSize: "13px", lineHeight: 1.7 }} data-testid="data-status">
        {lines.map((l) => <div>{l}</div>)}
        {!busy && doneAt && !bad && <div style={{ marginTop: "4px" }}>已在 {hhmm(doneAt)} 檢查完畢。若資料日沒變，代表證交所還沒公布新資料。</div>}
      </div>
      <div class="muted" style={{ fontSize: "13px", lineHeight: 1.7 }}>
        資料來源：臺灣證券交易所、證券櫃檯買賣中心（行情、三大法人、產業別）、Nasdaq（美股日K）、CNBC（國際指標）。證交所約下午 2 點後公布當日收盤行情，下午 3~5 點公布當日法人資料。
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const settings = useStore((s) => s.settings);
  const [key, setKey] = useState(settings.apiKey);
  const [msg, setMsg] = useState("");
  const [testing, setTesting] = useState(false);
  const save = async () => {
    await saveSettings({ ...settings, apiKey: key.trim() });
    setMsg(key.trim() ? "已儲存金鑰" : "已清除金鑰");
  };
  const test = async () => {
    setTesting(true); setMsg("");
    try {
      const c = client(key.trim());
      await c.models.retrieve(MODEL);
      await saveSettings({ ...settings, apiKey: key.trim() });
      setMsg("金鑰可以使用，已儲存");
    } catch (e) { setMsg(explainError(e)); }
    finally { setTesting(false); }
  };
  return (
    <div class="stack">
      <div class="section-title"><span>Claude API 金鑰</span></div>
      <div class="card stack">
        <label class="field">金鑰（sk-ant- 開頭）<input type="password" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="sk-ant-..." autocomplete="off" id="api-key" /></label>
        <div class="row">
          <button class="btn" onClick={save}>儲存</button>
          <button class="btn secondary" onClick={test} disabled={testing || !key.trim()}>{testing ? "測試中…" : "測試金鑰"}</button>
        </div>
        {msg && <div class="notice">{msg}</div>}
        <div class="muted" style={{ fontSize: "13px", lineHeight: 1.6 }}>
          金鑰只存在這支手機裡，直接用來呼叫 Anthropic。到 platform.claude.com 建立金鑰並儲值。使用模型：{MODEL}。
        </div>
      </div>
      <div class="section-title"><span>Claude 額度與花費</span></div>
      <SpendCard />
      <div class="section-title"><span>App 更新</span></div>
      <UpdateCard />
      <div class="section-title"><span>資料</span></div>
      <DataRefreshCard />
      <div class="notice">本 App 為個人研究工具，評等由公開數據依固定規則計算，AI 解析可能有誤，不構成投資建議。投資前請自行判斷。</div>
    </div>
  );
}

export { getState };
