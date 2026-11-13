import { NewsPane } from "./news";
import { DayTradeRank } from "./dayTrade";
import { ProfilePanel } from "./profile";
import { nameLookup, parseOcrHoldings, soldByOmission, type OcrLine } from "../engine/ocrHoldings";
import { fileToBase64, recognizeText } from "../lib/ocr";
import { useEffect, useMemo, useState } from "preact/hooks";
import {
  LIVE_MS,
  findScored, getFetcher, getKv, getState, holdingViews, refreshEsb, refreshMacro, refreshTw, refreshUs, saveHoldings, saveReport,
  saveSettings, clearCache, useStore, usBars, recordSpend, estimatedBalance, checkForUpdate, installUpdate,
  addUsSymbol, removeUsSymbol, refreshLive, refreshUsLive, refreshTwIndex, refreshFutures, refreshTurnover, refreshTurnoverLive, refreshEtfNav, revenueOf, startAiJob, dismissAiJob, type AiJob, type Market,
} from "../store";
import { BROKERS, brokerOf, mergeHoldings, type Broker, type Holding, type Rating, type Scored, type SectorStat } from "../engine/score";
import { type AiReport, analyzeStock, claudeAppPrompt, claudeAppUrl, client, explainError, parseUrls, holdingsAppPrompt, parseHoldingsReply, marketBrief, MODEL, type ImportedHolding } from "../ai/claude";
import { twHistory } from "../data/history";
import { esbHistory } from "../data/esb";
import { indexHistory, isCryptoSymbol, isUsIndexSymbol, type IndexHist } from "../data/indexHistory";
import { fngLabel, type Fng } from "../data/fng";
import type { EtfNav } from "../data/etfNav";
import { findXStock, OKX_BARS, okxCandlesUrl, okxInstrumentsUrl, okxTickerUrl, parseOkxCandles, parseOkxTicker, type OkxBar, type OkxTicker } from "../data/okx";
import { CandleChart, type CandleBar } from "./candles";
import { IntradayChart } from "./intraday";
import { dividendInfo } from "../engine/exdiv";
import { esbOpen } from "../data/intraday";
import { PicksPerfCard } from "./picksPerf";
import { UsIntradayChart } from "./usIntraday";
import { FlowsPanel } from "./flows";
import { EtfHoldingsPanel, isActiveEtf } from "./etfHoldings";
import { isEtf } from "../data/tw";
import { freeReport } from "../engine/freeReport";
import { DisclaimerText } from "./disclaimer";
import { levelsOf, recoveryPlan, type Levels, type RecoveryItem } from "../engine/recovery";
import { withLiveBar } from "../engine/liveBar";
import { isUsSymbol, MACRO_SYMBOLS, macroDelta, retN, sma, type MacroQuote } from "../data/us";
import { isLiveNow, livePolling, marketOpen, type LiveQuote } from "../data/twLive";
import { INDEX_CH } from "../data/twIndexLive";
// 數據頁可點進去看日 K 與詳細報價的國際指標（CNBC 代號）：美股指數、亞洲大盤、原物料期貨
const US_INDEX_SYMBOLS = [".SPX", ".IXIC", ".SOX", ".DJI", ".VIX"];
const CHART_SYMBOLS = new Set([...US_INDEX_SYMBOLS, ...MACRO_SYMBOLS.filter((m) => m.group === "亞洲" || m.group === "原物料" || m.group === "虛擬幣").map((m) => m.symbol)]);
import { nyParts, pretty, prettyW, taipeiToday, usQuoteHours, usSession } from "../lib/dates";
import { latestNotes } from "../lib/notes";
import { fmtNtd, ntd, usdTwdRate } from "../lib/fx";
import type { BacktestResult } from "../engine/backtest";
import type { TurnPick } from "../engine/turning";
import { CostValue, cls, fmtMoney, fmtPct, fmtPrice, fmtSigned, LimitPx, lots, Markdown, Progress, RatingPill, Sheet } from "./common";
import { limitFromChg } from "../lib/limit";

// ---------------- 選股 ----------------
export function PicksScreen({ market, setMarket, sector, setSector, open }: {
  market: Market; setMarket: (m: Market) => void; sector: string; setSector: (s: string) => void; open: (s: Scored, list?: Scored[]) => void;
}) {
  const ms = useStore((s) => (market === "TW" ? s.tw : market === "ETF" ? s.etf : s.us));
  const [filter0, setFilter] = useState<Rating | "全部" | "剛轉強">("買入");
  // 剛轉強：每天回測時一起算好（需要 3 個月以上的日K），只有台股
  const turn = useStore((s) => (market === "TW" ? s.backtest?.data.turning : undefined));
  const turnMap = useMemo(() => new Map((turn?.picks ?? []).map((p) => [p.code, p])), [turn]);
  const refOnly = market === "ETF";
  const filter = refOnly ? "全部" : filter0 === "剛轉強" && !turn ? "買入" : filter0; // ETF 不分評等；美股沒有「剛轉強」，從台股切過來時改回「買入」
  const [q, setQ] = useState("");
  // ETF 清單排序：成交量（預設）或參考分數；記在手機裡，下次打開維持
  const [etfSort, setEtfSortS] = useState<"vol" | "score">(() => { try { return localStorage.getItem("etfSort") === "score" ? "score" : "vol"; } catch { return "vol"; } });
  const setEtfSort = (v: "vol" | "score") => { setEtfSortS(v); try { localStorage.setItem("etfSort", v); } catch { /* 不記也沒關係 */ } };
  const live = useStore((s) => s.live);
  // 「當沖」分頁（11/12 使用者）：盤中成交量即時排名；記在手機裡，下次打開維持
  const [dt, setDtS] = useState(() => { try { return localStorage.getItem("picksDT") === "1"; } catch { return false; } });
  const setDt = (v: boolean) => { setDtS(v); try { localStorage.setItem("picksDT", v ? "1" : "0"); } catch { /* 不記也沒關係 */ } };
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
      // 有輸入搜尋字時不限評等與族群：想查哪一檔都找得到（例如在「買入」頁查聯電）
      (t || filter === "全部" || (filter === "剛轉強" ? turnMap.has(s.code) : s.rating === filter)) && (t || !sector || s.sector === sector) &&
      (!t || s.code.toUpperCase().includes(t) || s.name.toUpperCase().includes(t)))
      // ETF 依最近一個交易日的成交量排序（其他市場維持依分數）；用固定的收盤量，盤中不會一直重新排列
      // 參考分數：scored 本來就是分數高到低，維持原順序
      .sort(market === "ETF" && etfSort === "vol" ? (a, b) => (b.volume ?? 0) - (a.volume ?? 0) : () => 0);
  }, [ms.scored, filter, q, sector, turnMap, market, etfSort]);
  const liveCodes = list.slice(0, 60).map((x) => x.code);
  const liveKey = (dt ? "dt" : market) + liveCodes.join(",");
  useEffect(() => {
    if (!liveCodes.length || dt) return;
    const us = market === "US";
    const pull = () => (us ? refreshUsLive(liveCodes) : refreshLive(liveCodes));
    pull();
    const t = setInterval(() => { if (us ? usQuoteHours() : livePolling()) pull(); }, LIVE_MS);
    return () => clearInterval(t);
  }, [liveKey]);

  return (
    <div>
      <div class="row" style={{ justifyContent: "space-between" }}>
        <MarketSeg market={market} setMarket={(m) => { setDt(false); setMarket(m); }} dt={dt} setDt={() => { setDt(true); if (market === "US") setMarket("TW"); }} />
        {!dt && <input class="search" type="search" placeholder="代號或名稱" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} aria-label="搜尋股票" />}
      </div>
      {dt ? <div style={{ marginTop: "10px" }}><DayTradeRank open={open} /></div> : <>
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
      {filter !== "剛轉強" && <PicksPerfCard book={market} />}
      {ms.error && <div class="error" style={{ marginTop: "10px" }}>{ms.error}</div>}
      {ms.warning && <div class="notice" style={{ marginTop: "10px" }}>{ms.warning}</div>}
      {ms.status === "loading" && <Progress p={ms.progress} />}
      {ms.status === "error" && <div class="empty">資料下載失敗，請檢查網路後按右上角重新整理</div>}
      {ms.status === "ready" && (
        <>
          <div class="section-title">
            <span>{q.trim() ? `搜尋「${q.trim()}」・全部評等` : <>{sector ? `${sector}・` : ""}{filter === "全部" ? (market === "ETF" ? "全部 ETF" : "全部股票") : filter === "剛轉強" ? "剛轉強" : `評等「${filter}」`}・{market === "ETF" ? (etfSort === "vol" ? `依成交量排序${ms.asOf ? `（${prettyW(ms.asOf)}）` : ""}` : "依參考分數排序") : "依分數排序"}</>}</span>
            <span>{list.length} 檔</span>
          </div>
          {market === "ETF" && (
            <div class="seg" role="group" aria-label="ETF 排序" style={{ marginBottom: "8px" }}>
              <button aria-pressed={etfSort === "vol"} onClick={() => setEtfSort("vol")} data-testid="etf-sort-vol">成交量</button>
              <button aria-pressed={etfSort === "score"} onClick={() => setEtfSort("score")} data-testid="etf-sort-score">參考分數</button>
            </div>
          )}
          {market === "US" && <UsLookup q={q} found={list.length > 0} />}
          {list.length === 0 ? (
            <div class="empty">
              {filter === "剛轉強" && !q && !sector ? `${prettyW(turn?.asOf ?? "")}收盤沒有股票同時符合「剛轉強」的條件。` : filter === "買入" && !q && !sector ? <>今天沒有股票同時符合「分數 70 以上、外資買超、一週漲幅未過熱」。<br /><button class="chip" style={{ marginTop: "10px" }} onClick={() => setFilter("觀望")}>看「觀望」名單</button></> : q.trim() ? `找不到「${q.trim()}」。這裡只列當日成交金額 5 千萬以上的股票，冷門股可能不在清單；也可以試試股票代號。` : "沒有符合的股票"}
            </div>
          ) : (
            <div class="list">
              {list.slice(0, 150).map((s) => <StockRow s={s} q={freshLive(s)} turn={filter === "剛轉強" ? turnMap.get(s.code) : undefined} onClick={() => open(s, list.slice(0, 150))} />)}
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
      </>}
    </div>
  );
}

function MarketSeg({ market, setMarket, dt, setDt }: { market: Market; setMarket: (m: Market) => void; dt?: boolean; setDt?: () => void }) {
  return (
    <div class="seg" role="group" aria-label="市場">
      <button aria-pressed={!dt && market === "TW"} onClick={() => setMarket("TW")}>台股</button>
      <button aria-pressed={!dt && market === "ETF"} onClick={() => setMarket("ETF")}>ETF</button>
      <button aria-pressed={!dt && market === "US"} onClick={() => setMarket("US")}>美股</button>
      {setDt && <button aria-pressed={!!dt} onClick={setDt} data-testid="picks-tab-dt">當沖</button>}
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
        <div class="sub" style={s.market === "US" ? { whiteSpace: "normal" } : undefined}>
          {s.sector}
          {isEtf(s.code) && s.volume ? <>・量 <b class="num">{Math.round(s.volume / 1000).toLocaleString("zh-TW")}</b> 張</> : null}
          {s.market !== "US" ? <>・外資5日 <span class={cls(s.foreign5)}>{lots(s.foreign5)}</span></> : <>・相對大盤 <span class={cls(s.rsVsIndex1m)}>{fmtPct(s.rsVsIndex1m)}</span></>}
        </div>
        {turn && <>
          <div class="sub" style={{ whiteSpace: "normal" }} data-testid="turn-info">離20日線 {fmtPct(turn.gap20)}・MACD {turn.turnedAgo ? `${turn.turnedAgo} 天前` : "今天"}翻正</div>
          <div class="sub" style={{ whiteSpace: "normal" }} data-testid="turn-stop">停損參考 <b class="num">{fmtPrice(turn.stop, s.market)}</b></div>
        </>}
      </div>
      <div class="px">
        <div class="p num"><span class="lbl">{q?.trial ? `試搓 ${q.time.slice(0, 5)}` : intraday ? `現價 ${q!.time.slice(0, 5)}` : "收盤"}</span><LimitPx s={s.market !== "US" ? q?.limit ?? limitFromChg(price, chg, isEtf(s.code)) : undefined}>{fmtPrice(price, s.market)}</LimitPx></div>
        {chg !== undefined && Number.isFinite(chg) && <div class={`c num ${cls(chg)}`} data-testid="pick-day"><span class="lbl">今日</span>{fmtPct(chg)}</div>}
        {q?.ext && <div class={`c num ${cls(q.ext.chg)}`} data-testid="pick-ext"><span class="lbl">{q.ext.label} {q.ext.time}</span>{fmtPrice(q.ext.price, s.market)} {fmtPct(q.ext.chg)}</div>}
        <div class={`c num ${cls(s.ret1m)}`}><span class="lbl">近1月</span>{fmtPct(s.ret1m)}</div>
      </div>
      <div>
        <RatingPill rating={s.refOnly ? "參考" : s.rating} rebound={s.rebound} />
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

/** ETF 配息資訊（11/9 使用者要求）：近一年配息次數與合計、年化殖利率、最近一次除息、填息狀況；資料是雲端由每日行情整理的除權息事件 */
function EtfDividend({ code, price }: { code: string; price: number }) {
  const ex = useStore((st) => st.exdiv);
  if (!ex) return null;
  const d = dividendInfo(ex.data.ev[code], price, ex.data.asOf);
  return (
    <div class="card stack" style={{ marginTop: "10px", fontSize: "13.5px", lineHeight: 1.7 }} data-testid="etf-div">
      <div class="row" style={{ justifyContent: "space-between" }}><b>配息</b><span class="muted" style={{ fontSize: "12px" }}>近一年（到 {prettyW(ex.data.asOf)}）</span></div>
      {!d ? <div class="muted" data-testid="etf-div-none">近一年沒有除息紀錄（不配息，或上市不到一年還沒配過）。</div> : <>
        <div class="grid2">
          <div class="metric"><div class="k">年化殖利率</div><div class="v num" data-testid="etf-div-yield">{(d.yieldPct * 100).toFixed(1)}%</div><div class="d muted">近一年配 {d.total.toFixed(3)} 元{d.annualized ? `（${d.count} 次；未滿一年，用平均每次 × 一年 ${d.perYear} 次估算）` : ""} ÷ 現價 {fmtPrice(price)}</div></div>
          <div class="metric"><div class="k">配息頻率</div><div class="v">{d.freq}</div><div class="d muted">近一年除息 {d.count} 次</div></div>
        </div>
        {d.last && <div data-testid="etf-div-last">最近一次：{prettyW(d.last.d)} 除息 <b class="num">{d.last.amt.toFixed(3)}</b> 元（除息前 {fmtPrice(d.last.pre)}）・
          {d.filled ? <span class="up">已填息</span> : <span>還沒填息，還差 <span class="num down">{fmtPrice(d.gap!)}</span> 元</span>}</div>}
        <div class="muted" style={{ fontSize: "12px" }}>殖利率用現價算，價格大跌時會偏高；高息與主動式 ETF 的配息可能含收益平準金或本金，要和淨值、價格走勢一起看。上面的近 1 週／1 月／3 月漲跌已把除息加回去（含息報酬）。</div>
      </>}
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
/** nav：切換到同一份清單的上一檔／下一檔（選股的台股、ETF、美股，持股，ETF 排行）；頭尾循環 */
export interface DetailNav { pos: number; total: number; prev: () => void; next: () => void; prevName: string; nextName: string; around?: { code: string; market: string }[] }
export function StockDetail({ s, onClose, nav }: { s: Scored; onClose: () => void; nav?: DetailNav }) {
  const { holdings, apiKey, reports } = useStore((st) => ({ holdings: st.holdings, apiKey: st.settings.apiKey, reports: st.reports }));
  const [bars, setBars] = useState<CandleBar[] | null>(null);
  const [barsErr, setBarsErr] = useState("");
  const [barsMore, setBarsMore] = useState(true); // 更早的月份還在下載
  // 圖表分頁：台股預設「走勢」（當日分時），記住上次選的（美股只有 K 線）
  const hasProfile = s.market !== "US" && !isEtf(s.code);
  const [chartTab, setChartTab0] = useState<"intra" | "k" | "flow" | "profile">(() => { try { const v = localStorage.getItem("detailChart"); return v === "k" || (v === "flow" && s.market !== "US") || (v === "profile" && hasProfile) ? v : "intra"; } catch { return "intra"; } });
  const setChartTab = (t: "intra" | "k" | "flow" | "profile") => { setChartTab0(t); try { localStorage.setItem("detailChart", t); } catch { /* 不重要 */ } };
  // 點方塊看詳細：近 1 週／1 月／3 月、相對 S&P 500、折溢價開說明頁；法人的方塊直接切到下面的「法人」逐日表
  const [mx, setMx] = useState<null | "1w" | "1m" | "3m" | "rs" | "nav">(null);
  const goFlows = () => { setChartTab("flow"); setTimeout(() => document.querySelector('[data-testid="chart-tabs"]')?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); };
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
    const t = setInterval(() => { if (s.market === "US" || livePolling()) pull(); }, LIVE_MS);
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
        // 手機裡已有的月份馬上畫，其餘由最近的月份往回下載、每到一個月就更新圖（不用等全部下載完）
        const b = s.market === "US" ? await usBars(s.code) : await twHistory(getFetcher(), getKv(), s.code, s.market, 9, Date.now(), (part) => { if (alive && part.length) setBars(part.slice(-200)); });
        if (alive) { setBars(b.slice(-200)); setBarsMore(false); }
      } catch (e: any) { if (alive) { setBarsMore(false); setBarsErr(`走勢圖下載失敗：${e?.message ?? e}`); } }
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
    <>
    <Sheet title={`${s.name} ${s.code}`} onClose={onClose} titleNav={nav && { ...nav, name: s.name, sub: s.code }}>
      <div class="hero">
        <div>
          <div class="price num" data-testid="detail-price"><LimitPx s={s.market !== "US" ? lq?.limit ?? limitFromChg(price, dayChg ?? s.chg1d, isEtf(s.code)) : undefined}>{fmtPrice(price, s.market)}</LimitPx></div>
          <div class="num" style={{ marginTop: "4px", fontSize: "13px" }} data-testid="detail-price-note">
            {lq
              ? <><div class="muted" data-testid="detail-session">{s.market === "US" ? `${lq.session ?? "收盤"}${lq.date ? ` ${prettyW(lq.date)}` : ""}` : lq.trial ? "試搓（開盤前試算價，還沒成交）" : lq.final || !marketOpen() ? "收盤" : "盤中"}</div><div data-testid="detail-chg"><span class={cls(dayChg)}>{fmtPct(dayChg)}</span></div></>
              : <span class="muted">收盤價 {snapAsOf ? pretty(snapAsOf) : ""}（還沒抓到即時價）</span>}
          </div>
          <div class="muted" style={{ marginTop: "6px", fontSize: "13px" }}>{s.sector}・{s.market === "US" ? "美股" : `${s.market === "TPEX" ? "上櫃" : "上市"}${isEtf(s.code) ? " ETF" : ""}`}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <RatingPill rating={s.refOnly ? "參考" : s.rating} rebound={s.rebound} />
          <div class="num" style={{ fontSize: "26px", fontWeight: 800, marginTop: "6px" }}>{s.score}<span class="muted" style={{ fontSize: "13px" }}> / 100</span></div>
        </div>
      </div>

      <div class="grid2" style={{ marginTop: "14px" }}>
        <Metric k="近 1 週" v={fmtPct(s.ret1w)} c={cls(s.ret1w)} onClick={() => setMx("1w")} id="mx-1w" />
        <Metric k="近 1 月" v={fmtPct(s.ret1m)} c={cls(s.ret1m)} onClick={() => setMx("1m")} id="mx-1m" />
        <Metric k="近 3 月" v={fmtPct(s.ret3m)} c={cls(s.ret3m)} onClick={() => setMx("3m")} id="mx-3m" />
        {s.market === "US"
          ? <Metric k="相對 S&P 500（1月）" v={fmtPct(s.rsVsIndex1m)} c={cls(s.rsVsIndex1m)} onClick={() => setMx("rs")} id="mx-rs" />
          : <Metric k="外資近 5 日" v={lots(s.foreign5)} c={cls(s.foreign5)} d={s.foreignStreak ? `${s.foreignStreak > 0 ? "連買" : "連賣"} ${Math.abs(s.foreignStreak)} 天` : ""} onClick={goFlows} id="mx-f5" />}
        {s.market !== "US" && <Metric k="投信近 5 日" v={lots(s.trust5)} c={cls(s.trust5)} onClick={goFlows} id="mx-t5" />}
        {s.market !== "US" && <Metric k="外資近 10 日" v={lots(s.foreign10)} c={cls(s.foreign10)} onClick={goFlows} id="mx-f10" />}
        {etf && etfNav && Number.isFinite(etfNav.premium) && (
          <Metric k="折溢價（即時）" onClick={() => setMx("nav")} id="mx-nav" v={`${etfNav.premium > 0 ? "+" : ""}${etfNav.premium.toFixed(2)}%`}
            d={`預估淨值 ${fmtPrice(etfNav.nav)}${Math.abs(etfNav.premium) >= 1 ? (etfNav.premium > 0 ? "・溢價偏高" : "・折價偏深") : ""}`} />
        )}
      </div>

      {etf && <EtfDividend code={s.code} price={price} />}
      {s.market === "US" && <UsOvernight code={s.code} close={s.close} />}

      <div class="section-title">
        <div class="seg" role="group" aria-label="圖表" data-testid="chart-tabs">
          <button aria-pressed={chartTab === "intra"} onClick={() => setChartTab("intra")} data-testid="tab-intra">{s.market === "US" ? "走勢（盤前後）" : "走勢"}</button>
          <button aria-pressed={chartTab === "k" || (chartTab === "flow" && s.market === "US")} onClick={() => setChartTab("k")} data-testid="tab-k">{s.market === "US" ? "K 線圖（日）" : "K 線圖"}</button>
          {s.market !== "US" && <button aria-pressed={chartTab === "flow"} onClick={() => setChartTab("flow")} data-testid="tab-flow">法人</button>}
          {hasProfile && <button aria-pressed={chartTab === "profile"} onClick={() => setChartTab("profile")} data-testid="tab-profile">公司</button>}
        </div>
      </div>
      <div class="card">
        {chartTab === "intra" && s.market === "US"
          ? <UsIntradayChart code={s.code} />
          : chartTab === "intra"
          ? <IntradayChart code={s.code} market={s.market} prefetch={nav?.around} />
          : chartTab === "profile" && hasProfile
          ? <ProfilePanel code={s.code} market={s.market === "TPEX" ? "TPEX" : "TWSE"} price={lq?.price ?? s.close} />
          : chartTab === "flow" && s.market !== "US"
          ? (bars ? <FlowsPanel code={s.code} market={s.market === "TPEX" ? "TPEX" : "TWSE"} bars={bars} livePrice={lq?.price} /> : barsErr ? <div class="error">{barsErr}</div> : <div class="empty">載入中…</div>)
          : shownBars ? (shownBars.length > 1 ? <>
              <CandleChart bars={shownBars} us={s.market === "US"} cost={holding?.cost} />
              {barsMore && s.market !== "US" && <div class="muted" style={{ fontSize: "12px" }} data-testid="kline-loading-more">更早的走勢下載中…（現有的已可以看）</div>}
              {liveBar && <div class="date-hint" data-testid="kbar-live">⏱ 最後一根是{liveBar.final ? "最新收盤" : "盤中"}的即時價（含成交量{liveBar.time ? `，台北 ${liveBar.time.slice(0, 5)}` : ""}），每 30 秒更新；{s.market === "US" ? "下次更新美股資料時換成正式日 K" : "證交所正式資料（約 15:00 後）出來後會換成正式的"}</div>}
            </> : barsMore ? <div class="empty" data-testid="kline-loading">載入中…（更早的走勢還在下載）</div> : <div class="empty">沒有走勢資料</div>) : barsErr ? <div class="error">{barsErr}</div> : <div class="empty">載入中…</div>}
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
    {mx && <MetricDetail kind={mx} s={s} bars={bars} nav={etfNav} onClose={() => setMx(null)} />}
    </>
  );
}

function Metric({ k, v, c = "", d = "", onClick, id }: { k: string; v: string; c?: string; d?: string; onClick?: () => void; id?: string }) {
  return (
    <div class="metric" onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined} data-testid={id} role={onClick ? "button" : undefined}>
      <div class="k" style={onClick ? { display: "flex", justifyContent: "space-between" } : undefined}>{k}{onClick && <span class="muted" aria-hidden="true">›</span>}</div>
      <div class={`v num ${c}`}>{v}</div>{d && <div class="d muted">{d}</div>}
    </div>
  );
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
  // 和一般個股一樣用分頁切換「走勢／K 線圖」，記住上次看的（和一般個股共用同一個設定）
  const [tab, setTab0] = useState<"intra" | "k">(() => { try { return localStorage.getItem("detailChart") === "k" ? "k" : "intra"; } catch { return "intra"; } });
  const setTab = (t: "intra" | "k") => { setTab0(t); try { localStorage.setItem("detailChart", t); } catch { /* 不重要 */ } };
  const lq = useStore((st) => st.live[h.code]);
  const close = useStore((st) => st.prices[h.code]?.close);
  const [bars, setBars] = useState<CandleBar[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const pull = () => refreshLive([h.code], [h.code]);
    pull();
    const retry = setTimeout(() => { if (!getState().live[h.code]) pull(); }, 5000); // 第一次沒抓到就再試一次
    const t = setInterval(() => { if (esbOpen()) pull(); }, 60_000); // 櫃買的行情表每分鐘才更新一次；興櫃交易到 15:00
    return () => { clearInterval(t); clearTimeout(retry); };
  }, [h.code]);
  useEffect(() => {
    let alive = true;
    esbHistory(getFetcher(), getKv(), h.code, 9).then((b) => { if (alive) setBars(b.slice(-200)); }).catch((e) => { if (alive) setErr(`走勢圖下載失敗：${e?.message ?? e}`); });
    return () => { alive = false; };
  }, [h.code]);
  const shown = useMemo(() => (bars ? (withLiveBar(bars, lq) as CandleBar[]) : bars), [bars, lq]);
  const price = lq ? lq.price : close ?? NaN;
  const live = !!lq && !lq.final && lq.date === taipeiToday() && esbOpen();
  const chg = lq && lq.prevClose > 0 ? lq.price / lq.prevClose - 1 : NaN;
  const pnl = (price - h.cost) * h.shares;
  return (
    <Sheet title={`${h.name} ${h.code}`} onClose={onClose}>
      <div class="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div class="big num" data-testid="esb-price">{fmtPrice(price)}</div>
          {Number.isFinite(chg) && <div class={`num ${cls(chg)}`} data-testid="esb-chg">今日 {fmtPct(chg)}</div>}
        </div>
        <div class="muted" style={{ fontSize: "12px", textAlign: "right" }} data-testid="esb-note">
          興櫃股票・{live ? `盤中 ${lq!.time.slice(0, 5)}` : "收盤"}<br />櫃買中心行情每分鐘更新
        </div>
      </div>
      {lq && (
        <div class="grid2" style={{ marginTop: "10px" }} data-testid="esb-stats">
          <div class="metric"><div class="k">今日高／低</div><div class="v num">{Number.isFinite(lq.high) ? fmtPrice(lq.high) : "—"} ／ {Number.isFinite(lq.low) ? fmtPrice(lq.low) : "—"}</div></div>
          <div class="metric"><div class="k">今日成交量</div><div class="v num">{lq.volume && lq.volume > 0 ? `${Math.round(lq.volume / 1000).toLocaleString()} 張` : "—"}</div></div>
        </div>
      )}
      <div class="section-title">
        <div class="seg" role="group" aria-label="圖表" data-testid="esb-chart-tabs">
          <button aria-pressed={tab === "intra"} onClick={() => setTab("intra")} data-testid="esb-tab-intra">走勢</button>
          <button aria-pressed={tab === "k"} onClick={() => setTab("k")} data-testid="esb-tab-k">K 線圖</button>
        </div>
        <span class="muted" style={{ fontSize: "12px", fontWeight: 400 }}>興櫃 09:00～15:00</span>
      </div>
      <div class="card">
        {tab === "intra"
          ? <div data-testid="esb-intra"><IntradayChart code={h.code} market="ESB" /></div>
          : <>
            {shown && shown.length >= 2 ? <CandleChart bars={shown} cost={h.cost} />
              : err ? <div class="notice">{err}</div>
              : shown ? <div class="notice">還沒有足夠的興櫃成交資料可以畫走勢圖。</div>
              : <div class="muted">下載走勢中…</div>}
            <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6, marginTop: "6px" }} data-testid="esb-kline-note">
              興櫃沒有開盤價與收盤價：K 線的開＝前一日均價、收＝當日均價（盤中那一根收盤用最新成交價）；影線是當天最高與最低成交價，若前日均價在範圍外，影線會延伸到前日均價。
            </div>
          </>}
      </div>
      <div class="section-title"><span>我的持股</span></div>
      <div class="card num" data-testid="esb-hold">{h.shares.toLocaleString()} 股・成本 {fmtPrice(h.cost)}・損益 <span class={cls(pnl)}>{fmtMoney(pnl)}（{fmtPct(price / h.cost - 1)}）</span></div>
      <div class="notice" style={{ marginTop: "10px" }}>興櫃股票沒有三大法人與族群資料，App 不評分、不給買賣建議，只提供報價、走勢與損益。</div>
    </Sheet>
  );
}

export function HoldingsScreen({ open }: { open: (s: Scored, list?: Scored[]) => void }) {
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
    if (twCodes.length) refreshLive(twCodes, [], true); // 持股優先
    if (usCodes.length) refreshUsLive(usCodes);
    const t = setInterval(() => {
      if (twCodes.length && livePolling()) refreshLive(twCodes, [], true);
      if (usCodes.length && usQuoteHours()) refreshUsLive(usCodes);
    }, LIVE_MS);
    return () => clearInterval(t);
  }, [codeKey]);
  // 還沒抓到即時價的那幾十秒，畫面上是上個交易日的收盤：明確標示「更新中」，不要讓人以為這就是最新的
  const [liveGiveUp, setLiveGiveUp] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLiveGiveUp(true), 60_000); return () => clearTimeout(t); }, []);
  const today = taipeiToday();
  const liveError = useStore((s) => s.liveError);
  const liveMissing = livePolling() && twCodes.some((c) => live[c]?.date !== today);
  // 還沒抓到即時價：抓取中、抓取失敗、或超過 60 秒仍沒有，都要明確說，不能讓人以為畫面上的收盤價就是最新的
  const liveNote = !liveMissing ? "" : liveError ? `即時價抓取失敗（${liveError}），目前是 ${twAsOf ? pretty(twAsOf) : "上次"} 收盤價，自動重試中` : liveGiveUp ? `即時價還沒抓到，目前是 ${twAsOf ? pretty(twAsOf) : "上次"} 收盤價` : "即時價更新中…";
  // 11/10 使用者：持股分成「口袋持股／元大持股／統計」三個分頁；統計把兩家合併（同一檔股數相加、成本加權）
  const [tab, setTabRaw] = useState<Broker | "stats">(() => { try { const t = localStorage.getItem("holdTab"); return t === "yuanta" || t === "stats" ? t : "pocket"; } catch { return "pocket"; } });
  const setTab = (t: Broker | "stats") => { setTabRaw(t); try { localStorage.setItem("holdTab", t); } catch { /* 記不住分頁沒關係 */ } };
  const broker: Broker = tab === "stats" ? "pocket" : tab;
  const brokerLabel = BROKERS.find((b) => b.key === broker)!.label;
  const base = tab === "stats" ? mergeHoldings(hs) : hs.filter((h) => brokerOf(h) === tab);
  const withLive = (list: Holding[]) => holdingViews(list).map((v) => {
    const isUs = v.market === "US";
    const q = live[v.code];
    if (q && q.date && q.date >= ((isUs ? usAsOf : twAsOf) ?? "")) {
      const price = q.price;
      return { ...v, price, pnl: (price - v.cost) * v.shares, pnlPct: v.cost > 0 ? price / v.cost - 1 : NaN,
        chg: Number.isFinite(q.prevClose) ? price / q.prevClose - 1 : NaN, liveLabel: isUs ? (q.session ?? "收盤") : q.trial && isLiveNow(q, today) ? "試搓" : !q.final && q.date === today && marketOpen() ? "盤中" : "收盤", ext: q.ext, limit: isUs || getState().esb[v.code] ? undefined : q.limit };
    }
    return { ...v, chg: v.scored?.chg1d ?? NaN, liveLabel: "收盤", limit: isUs || getState().esb[v.code] ? undefined : limitFromChg(v.price, v.scored?.chg1d, isEtf(v.code)) };
  });
  const views = withLive(base);
  const byBroker = tab === "stats" ? BROKERS.map((b) => ({ ...b, rows: withLive(hs.filter((h) => brokerOf(h) === b.key)) })) : [];
  const [adding, setAdding] = useState(false);
  const [esbOpen, setEsbOpen] = useState<any>(null);
  const [importing, setImporting] = useState<{ rows: ImportedHolding[]; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ocrSeen, setOcrSeen] = useState<string[] | null>(null); // 辨識不到持股時，列出手機讀到的文字（使用者截圖給我們查原因）

  const total = (m: "TW" | "US") => {
    const vs = views.filter((v) => (m === "US") === (v.market === "US") && Number.isFinite(v.price));
    // 今日損益：有今日漲跌的持股，現價 − 昨收
    const dv = vs.filter((v) => Number.isFinite(v.chg));
    const day = dv.reduce((a, v) => a + v.shares * (v.price - v.price / (1 + v.chg)), 0);
    const dayBase = dv.reduce((a, v) => a + v.shares * v.price / (1 + v.chg), 0);
    return { value: vs.reduce((a, v) => a + v.price * v.shares, 0), pnl: vs.reduce((a, v) => a + v.pnl, 0), cost: vs.reduce((a, v) => a + v.cost * v.shares, 0), day, dayPct: dayBase ? day / dayBase : NaN, hasDay: dv.length > 0 };
  };
  const tw = total("TW"), us = total("US");

  // 用 Claude App 辨識截圖（免費，11/12 使用者要求拿掉付費的照片匯入）：複製提問、打開 Claude App，回覆貼回來整理成持股
  // 手機內建辨識（11/12 使用者：不用 Claude App，截圖直接在手機上辨識；免費、離線）
  const ocrToHoldings = (lines: OcrLine[]) => {
    const st = getState();
    const lookup = nameLookup([...st.holdings, ...st.tw.scored, ...st.etf.scored, ...Object.entries(st.prices).map(([code, p]) => ({ code, name: p?.name ?? "" }))]);
    const rows = parseOcrHoldings(lines, lookup);
    if (!rows.length) { setOcrSeen([...lines].sort((a, b) => a.y - b.y || a.x - b.x).map((l) => l.text.trim()).filter(Boolean)); setErr("截圖裡沒有辨識到持股（要有「股數」和「均價」欄位的庫存畫面）。可以改用下面的「用 Claude App 辨識」。"); return; }
    setOcrSeen(null); setErr(""); setImporting({ rows, note: rows.some((r) => !r.code) ? "有幾檔只辨識到名稱、對不到代號，請補上代號" : "" });
  };
  const onOcr = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setBusy(true); setErr("");
    try { ocrToHoldings(await recognizeText(await fileToBase64(file))); }
    catch (e2: any) { setErr(`手機辨識失敗：${e2?.message ?? e2}。可以改用「用 Claude App 辨識」。`); }
    finally { setBusy(false); }
  };
  // 自動測試用：把合成的庫存截圖送進同一套手機辨識流程
  useEffect(() => {
    (window as any).__srOcrBase64 = async (b64: string) => { setBusy(true); try { ocrToHoldings(await recognizeText(b64)); } catch (e2: any) { setErr(String(e2?.message ?? e2)); } finally { setBusy(false); } };
    return () => { delete (window as any).__srOcrBase64; };
  }, [broker]);
  const [appOpen, setAppOpen] = useState(false);
  const [appText, setAppText] = useState("");
  const [appCopied, setAppCopied] = useState<"" | "ok" | "fail">("");
  const appPrompt = holdingsAppPrompt(brokerLabel);
  const loadAppReply = () => {
    const r = parseHoldingsReply(appText);
    if (!r) return setErr("回覆裡沒有找到持股 JSON：請在 Claude App 按回覆下方的「複製」，把整段貼上來");
    setErr(""); setImporting({ rows: r.holdings, note: r.note }); setAppText(""); setAppOpen(false);
  };

  return (
    <div>
      <div class="seg" role="tablist" style={{ marginBottom: "12px" }} data-testid="hold-tabs">
        {([["pocket", "口袋持股"], ["yuanta", "元大持股"], ["stats", "統計"]] as const).map(([k, l]) => (
          <button role="tab" aria-pressed={tab === k} onClick={() => setTab(k)} data-testid={`hold-tab-${k}`}>{l}</button>
        ))}
      </div>
      {tab === "stats" && <BrokerStats byBroker={byBroker} merged={views} fx={fx} />}
      <div class="summary">
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>{tab === "stats" ? "合計" : brokerLabel}台股市值</div>{tw.cost ? <><div class="big num">{fmtMoney(tw.value)}</div><div class="muted num" style={{ fontSize: "12px" }} data-testid="tw-cost">買進成本 {fmtMoney(tw.cost)}</div><div class={`num ${cls(tw.pnl)}`} style={{ fontSize: "13px" }} data-testid="tw-pnl">累計損益 {fmtMoney(tw.pnl)}（{fmtPct(tw.pnl / tw.cost)}）</div>{tw.hasDay && <div class={`num ${cls(tw.day)}`} style={{ fontSize: "12px" }} data-testid="tw-day">今日損益 {fmtMoney(tw.day)}（{fmtPct(tw.dayPct)}）</div>}</> : <div class="big muted">—</div>}</div>
        <div class="card"><div class="muted" style={{ fontSize: "12px" }}>{tab === "stats" ? "合計" : brokerLabel}美股市值</div>{us.cost ? <><div class="big num">{fx ? ntd(us.value, fx) : fmtMoney(us.value, "US")}</div><div class="muted num" style={{ fontSize: "12px" }} data-testid="us-cost">買進成本 {fx ? ntd(us.cost, fx) : fmtMoney(us.cost, "US")}</div><div class={`num ${cls(us.pnl)}`} style={{ fontSize: "13px" }} data-testid="us-pnl">累計損益 {fx ? fmtNtd(us.pnl, fx) : fmtMoney(us.pnl, "US")}（{fmtPct(us.pnl / us.cost)}）</div>{us.hasDay && <div class={`num ${cls(us.day)}`} style={{ fontSize: "12px" }} data-testid="us-day">今日損益 {fx ? fmtNtd(us.day, fx) : fmtMoney(us.day, "US")}（{fmtPct(us.dayPct)}）</div>}</> : <div class="big muted">—</div>}</div>
      </div>
      {tab !== "stats" && <><div class="row" style={{ marginTop: "12px" }}>
        <label class="btn" style={{ flex: 1 }} aria-disabled={busy} data-testid="ocr-import">
          {busy ? "辨識中…" : <><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>截圖匯入（免費）</>}
          <input type="file" accept="image/*" hidden disabled={busy} onChange={onOcr} data-testid="ocr-input" />
        </label>
        <button class="btn secondary" onClick={() => setAdding(true)}>手動新增</button>
      </div>
      <div class="muted" style={{ fontSize: "12px", marginTop: "6px", lineHeight: 1.6 }}>選一張{brokerLabel}證券 App 的「庫存」截圖，手機直接辨識（不用網路、不花錢）；截圖上沒有的{brokerLabel}持股會當作已賣出。辨識不準時可以
        <button class="linkbtn" style={{ fontSize: "12px" }} onClick={() => setAppOpen(!appOpen)} data-testid="app-import-toggle">改用 Claude App 辨識</button>。</div>
      {appOpen && (
        <div class="card stack" style={{ marginTop: "10px" }} data-testid="app-import">
          <b>用 Claude App 辨識{brokerLabel}庫存截圖（免費，用你的訂閱）</b>
          <ol class="steps muted" style={{ fontSize: "12.5px", lineHeight: 1.7, margin: 0, paddingLeft: "18px" }}>
            <li>先在{brokerLabel}證券 App 截好「庫存」畫面。</li>
            <li>按下面的按鈕：會複製提問並打開 Claude App。</li>
            <li>在 Claude App <b>附上截圖</b>（迴紋針或＋），輸入框長按<b>貼上</b>提問後送出。</li>
            <li>Claude 回答完，按回覆下方的<b>「複製」</b>，回來貼在下面，按「整理成持股」，確認後加入。</li>
          </ol>
          <a class="btn secondary block" href={claudeAppUrl(appPrompt)} target="_blank" rel="noreferrer"
            onClick={() => copyText(appPrompt, (ok) => setAppCopied(ok ? "ok" : "fail"))} data-testid="app-import-open">複製提問並打開 Claude App</a>
          {appCopied === "ok" && <div class="muted" style={{ fontSize: "12px" }}>已複製提問。記得在 Claude App 附上截圖再送出。</div>}
          {appCopied === "fail" && <div class="muted" style={{ fontSize: "12px" }}>沒辦法自動複製，請再按一次。</div>}
          <label class="field">貼上 Claude 的回覆
            <textarea rows={4} value={appText} onInput={(e) => setAppText((e.target as HTMLTextAreaElement).value)} placeholder="在 Claude App 按回覆下方的「複製」，再貼到這裡" data-testid="app-import-text" />
          </label>
          <button class="btn block" disabled={!appText.trim()} onClick={loadAppReply} data-testid="app-import-load">整理成持股</button>
        </div>
      )}</>}
      {err && <div class="error" style={{ marginTop: "10px" }}>{err}</div>}
      {err && ocrSeen && (
        <details style={{ marginTop: "6px", fontSize: "12.5px" }} data-testid="ocr-seen">
          <summary class="muted">看手機讀到的文字（{ocrSeen.length} 行；截圖這裡回報問題）</summary>
          <div class="muted" style={{ whiteSpace: "pre-wrap", lineHeight: 1.5, marginTop: "4px" }}>{ocrSeen.join("｜")}</div>
        </details>
      )}

      {views.length > 0 && <PnlRecon views={views} fx={fx} />}
      {views.length > 0 && <RecoveryCard views={views} />}

      <div class="section-title"><span>{tab === "stats" ? "合併持股" : `${brokerLabel}持股`}健檢{liveNote && <span class="muted" data-testid="live-loading" style={{ fontSize: "12px", fontWeight: 400, marginLeft: "8px" }}>{liveNote}</span>}</span><span>{views.length} 檔</span></div>
      {views.length === 0 ? (
        <div class="empty" data-testid="hold-empty">{tab === "stats" ? "還沒有持股。" : <>還沒有{brokerLabel}持股。<br />按「截圖匯入（免費）」，選一張{brokerLabel}證券 App 的「庫存」截圖，手機會直接辨識；或按「手動新增」。</>}</div>
      ) : (
        <div class="list">
          {views.map((v) => <HoldingRow v={v} brokers={tab === "stats" ? (v as any).brokers : undefined} open={(s) => open(s, views.map((x) => x.scored).filter((x): x is Scored => !!x))} onEsb={setEsbOpen} fx={fx} />)}
        </div>
      )}
      {views.length > 0 && tab !== "stats" && <HoldingsEditor broker={broker} />}
      {adding && <HoldingForm broker={broker} onDone={() => setAdding(false)} />}
      {esbOpen && <EsbDetail h={esbOpen} onClose={() => setEsbOpen(null)} />}
      {importing && <ImportReview broker={broker} data={importing} onDone={() => setImporting(null)} />}
    </div>
  );
}

/** 累計損益對帳（11/11）：把每一檔的累計損益（美股換成台幣）列出來加總，和上面卡片、統計頁的數字對得上 */
function PnlRecon({ views, fx }: { views: any[]; fx?: number }) {
  const [open, setOpen] = useState(false);
  const toTwd = (v: any) => (v.market === "US" ? (fx ? v.pnl * fx : NaN) : v.pnl);
  const rows = views.map((v) => ({ v, x: Number.isFinite(v.price) ? toTwd(v) : NaN }));
  const ok = rows.filter((r) => Number.isFinite(r.x)), skipped = rows.filter((r) => !Number.isFinite(r.x));
  const sum = ok.reduce((a, r) => a + r.x, 0);
  const sg = (x: number) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${Math.abs(Math.round(x)).toLocaleString("zh-TW")}`;
  return (
    <div class="card" style={{ marginTop: "12px" }} data-testid="pnl-recon">
      <div class="row" style={{ justifyContent: "space-between", gap: "8px" }}>
        <b>累計損益對帳</b>
        <button class="btn secondary mini" onClick={() => setOpen(!open)} data-testid="pnl-recon-toggle">{open ? "收合" : "看每一檔加總"}</button>
      </div>
      <div class={`num ${cls(sum)}`} style={{ fontSize: "14px", marginTop: "4px" }} data-testid="pnl-recon-total">{ok.length} 檔合計 {sg(sum)} 元（台幣；美股已換成台幣）</div>
      {open && <div class="stack" style={{ gap: "4px", marginTop: "8px" }}>
        {ok.map((r) => <div class="row" style={{ justifyContent: "space-between", fontSize: "13.5px" }} data-testid="pnl-recon-row"><span>{r.v.name} <span class="muted num">{r.v.code}</span></span><span class={`num ${cls(r.x)}`}>{sg(r.x)} 元</span></div>)}
        <div class="row" style={{ justifyContent: "space-between", fontSize: "13.5px", borderTop: "1px solid var(--line)", paddingTop: "4px", fontWeight: 600 }}><span>合計</span><span class={`num ${cls(sum)}`}>{sg(sum)} 元</span></div>
        {skipped.length > 0 && <div class="muted" style={{ fontSize: "12px" }}>沒有算進去（還沒有現價{fx ? "" : "或匯率"}）：{skipped.map((r) => r.v.name).join("、")}</div>}
      </div>}
    </div>
  );
}

/** 統計分頁（11/10）：口袋、元大各自的市值、損益、今日損益與佔比，合併後的產業分布 */
function BrokerStats({ byBroker, merged, fx }: { byBroker: { key: Broker; label: string; rows: any[] }[]; merged: any[]; fx?: number }) {
  const sum = (rows: any[], f: (v: any) => number) => rows.filter((v) => Number.isFinite(v.price)).map(f).filter(Number.isFinite).reduce((a, x) => a + x, 0);
  // 美股換成台幣後再加總（有匯率時），才能和台股一起算佔比
  const twd = (v: any, x: number) => (v.market === "US" ? (fx ? x * fx : NaN) : x);
  const stat = (rows: any[]) => {
    const value = sum(rows, (v) => twd(v, v.price * v.shares)), cost = sum(rows, (v) => twd(v, v.cost * v.shares)), pnl = sum(rows, (v) => twd(v, v.pnl));
    const dv = rows.filter((v) => Number.isFinite(v.chg) && Number.isFinite(v.price));
    const day = dv.map((v) => twd(v, v.shares * (v.price - v.price / (1 + v.chg)))).filter(Number.isFinite).reduce((a, x) => a + x, 0);
    return { value, cost, pnl, day, n: rows.length, win: rows.filter((v) => v.pnl > 0).length };
  };
  const all = stat(merged);
  const secs = new Map<string, number>();
  for (const v of merged) if (Number.isFinite(v.price)) { const k = v.market === "US" ? "美股" : /^00/.test(v.code) ? "ETF" : v.scored?.sector ?? "其他"; secs.set(k, (secs.get(k) ?? 0) + twd(v, v.price * v.shares)); }
  const secList = [...secs].filter(([, x]) => Number.isFinite(x)).sort((a, b) => b[1] - a[1]);
  // 每一項都標清楚名稱、單位（台幣元）、正負號與 %（11/10 使用者：「元大今日 8310 怎麼來的看不懂」）
  const nt = (x: number) => (Number.isFinite(x) ? `${fmtSigned(x)} 元` : "—");
  const Block = ({ title, t, share, testid }: { title: string; t: ReturnType<typeof stat>; share?: number; testid: string }) => (
    <div class="stack" style={{ gap: "6px" }} data-testid={testid}>
      <div class="row" style={{ justifyContent: "space-between" }}><b>{title}</b><span class="muted" style={{ fontSize: "12px" }}>{t.n ? `${t.n} 檔（${t.win} 檔賺、${t.n - t.win} 檔賠）` : "沒有持股"}</span></div>
      {t.n > 0 && <div class="grid2">
        <div class="metric"><div class="k">目前市值</div><div class="v num">{fmtMoney(t.value)}</div><div class="d muted" style={{ fontSize: "11.5px" }}>{share !== undefined ? `佔兩家合計 ${Math.round(share * 100)}%` : `買進成本 ${fmtMoney(t.cost)}`}</div></div>
        <div class="metric"><div class="k">累計損益</div><div class={`v num ${cls(t.pnl)}`}>{nt(t.pnl)}</div><div class={`d num ${cls(t.pnl)}`} style={{ fontSize: "11.5px" }}>{fmtPct(t.cost ? t.pnl / t.cost : NaN)}・從買進到現在</div></div>
        <div class="metric" style={{ gridColumn: "1 / -1" }}><div class="k">今日損益</div><div class={`v num ${cls(t.day)}`}>{nt(t.day)}<span style={{ fontSize: "13px", marginLeft: "6px" }}>（{fmtPct(t.value - t.day ? t.day / (t.value - t.day) : NaN)}）</span></div><div class="d muted" style={{ fontSize: "11.5px" }}>今天每檔（現價 − 昨天收盤）× 股數，加總</div></div>
      </div>}
    </div>
  );
  return (
    <div class="card stack" data-testid="broker-stats">
      <Block title="兩家合計" t={all} testid="broker-row-all" />
      {byBroker.map((b) => <div style={{ borderTop: "1px solid var(--line)", paddingTop: "10px" }}><Block title={b.label} t={stat(b.rows)} share={all.value ? stat(b.rows).value / all.value : 0} testid={`broker-row-${b.key}`} /></div>)}
      {secList.length > 0 && <div style={{ borderTop: "1px solid var(--line)", paddingTop: "8px" }} data-testid="broker-sectors">
        <b style={{ fontSize: "14px" }}>產業分布（兩家合併，依市值）</b>
        {secList.slice(0, 8).map(([k, x]) => (
          <div class="row" style={{ justifyContent: "space-between", fontSize: "13px" }}><span>{k}</span><span class="num">{all.value ? `${((x / all.value) * 100).toFixed(1)}%` : "—"}（{fmtMoney(x)}）</span></div>
        ))}
      </div>}
      <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>
        金額都是台幣：美股依今日匯率{fx ? `（1 美元 ≈ ${fx.toFixed(2)} 元）` : "（還沒載入，美股暫不計入）"}換算後一起加總。累計損益＝目前市值 − 買進成本（未扣賣出手續費與稅）。同一檔兩家都有時，下面的持股列合併成一筆（股數相加、成本加權平均），名稱旁標「口袋＋元大」。
      </div>
    </div>
  );
}

/** 持股分析與建議（11/9 使用者：「引導我將負損益做到正損益」）：規則計算，不花錢；預設收合，只顯示摘要 */
function RecoveryCard({ views }: { views: any[] }) {
  const fx = usdTwdRate(useStore((s) => s.macro.quotes));
  const st = useStore((s) => ({ tw: s.tw.scored, etf: s.etf.scored, us: s.us.scored }));
  const [levels, setLevels] = useState<Record<string, Levels | undefined>>({});
  const plan = recoveryPlan(views, { stocks: st.tw, etfs: st.etf, us: st.us }, levels);
  const [open, setOpen] = useState(false);
  // 展開時才下載虧損持股與換股標的的日 K（手機已有的月份直接用），算支撐、壓力
  const need = open ? [...new Set(plan.items.flatMap((x) => [x.code, ...(x.swapCodes ?? [])]))].filter((c) => !(c in levels)) : [];
  const needKey = need.join(",");
  useEffect(() => {
    if (!need.length) return;
    let alive = true;
    (async () => {
      for (const code of need) {
        const market = plan.items.find((x) => x.code === code)?.market ?? findScored(code)?.market;
        let lv: Levels | undefined;
        try {
          const bars = market === "US" ? await usBars(code) : market ? await twHistory(getFetcher(), getKv(), code, market as "TWSE" | "TPEX", 7) : [];
          lv = levelsOf(bars);
        } catch { lv = undefined; }
        if (!alive) return;
        setLevels((m) => ({ ...m, [code]: lv }));
      }
    })();
    return () => { alive = false; };
  }, [needKey]);
  const tone: Record<RecoveryItem["action"], string> = { 停損換股: "exit", 攤平: "buy", 續抱設條件: "hold" };
  return (
    <div class="card stack" style={{ marginTop: "12px" }} data-testid="recovery-card">
      <div class="row" style={{ justifyContent: "space-between" }}>
        <b>持股分析與建議</b>
        {plan.items.length > 0 && <button class="btn secondary mini" onClick={() => setOpen(!open)} data-testid="recovery-toggle">{open ? "收合" : `看 ${plan.items.length} 檔怎麼回本`}</button>}
      </div>
      <div style={{ fontSize: "14px", lineHeight: 1.7 }} data-testid="recovery-summary">{plan.summary.lines.map((l) => <div>{l}</div>)}</div>
      {open && plan.items.map((x) => (
        <div class="stack" style={{ borderTop: "1px solid var(--line)", paddingTop: "8px", gap: "4px" }} data-testid="recovery-item">
          <div class="row" style={{ justifyContent: "space-between", gap: "8px" }}>
            <b>{x.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{x.code}</span></b>
            <span class={`pill ${tone[x.action]}`} style={{ fontSize: "12px" }}>{x.action}</span>
          </div>
          <div class={`num ${cls(x.pnl)}`} style={{ fontSize: "13px" }}>累計損益 {x.market === "US" && fx ? fmtNtd(x.pnl, fx) : fmtSigned(x.pnl, x.market)}（{fmtPct(x.pnlPct)}）</div>
          <ul style={{ margin: 0, paddingLeft: "18px", fontSize: "13.5px", lineHeight: 1.7 }}>{x.lines.map((l) => <li>{l}</li>)}</ul>
          {x.sections.map((sec) => (
            <details data-testid="recovery-section" open={x.action === "停損換股"}>
              <summary style={{ fontSize: "13.5px", fontWeight: 600, cursor: "pointer" }}>{sec.title}</summary>
              <ul style={{ margin: "4px 0 0", paddingLeft: "18px", fontSize: "13px", lineHeight: 1.7 }}>{sec.lines.map((l) => <li>{l}</li>)}</ul>
            </details>
          ))}
        </div>
      ))}
      <div class="muted" style={{ fontSize: "12px" }}>依 App 評等與成本自動計算（不花 Claude 費用），只是參考、不是投資建議：攤平會加大部位，停損換股也不保證新標的會漲。</div>
    </div>
  );
}

/** 持股一列：左邊是名稱、損益金額（含報酬率）、建議；右邊是現價、今日漲跌、（美股盤前盤後）；賺紅賠綠 */
function HoldingRow({ v, open, onEsb, fx, brokers }: { v: any; open: (s: Scored) => void; onEsb?: (v: any) => void; fx?: number; brokers?: Broker[] }) {
  const isEsb = useStore((st) => !!st.esb[v.code]);
  return (
    <button class="item" onClick={() => (v.scored ? open(v.scored) : isEsb && onEsb?.(v))}>
      <div style={{ minWidth: 0 }}>
        <div class="name">{v.name} <span class="muted num" style={{ fontWeight: 400, fontSize: "13px" }}>{v.code}</span>{brokers && <span class="muted" style={{ fontWeight: 400, fontSize: "11px", marginLeft: "6px" }} data-testid="hold-brokers">{brokers.map((b) => BROKERS.find((x) => x.key === b)!.label).join("＋")}</span>}</div>
        <div class={`num ${cls(v.pnl)}`} style={{ fontSize: "13px", fontWeight: 600, marginTop: "2px" }} data-testid="hold-pnl"><span class="lbl" style={{ fontFamily: "var(--font)", fontSize: "11px", fontWeight: 400, color: "var(--muted)", marginRight: "4px" }}>累計損益</span>{v.market === "US" && fx ? fmtNtd(v.pnl, fx) : fmtSigned(v.pnl, v.market)}<span style={{ whiteSpace: "nowrap" }}>（{fmtPct(v.pnlPct)}）</span></div>
        <div class="muted num" style={{ fontSize: "12px", marginTop: "2px" }} data-testid="hold-avg">{v.shares.toLocaleString()} 股・均價 {v.market === "US" ? "$" : ""}{fmtPrice(v.cost, v.market === "US" ? "US" : undefined)}</div>
        <CostValue shares={v.shares} avgCost={v.cost} price={v.price} us={v.market === "US"} fx={fx} />
        <div class="sub">{v.advice.join("；")}</div>
      </div>
      <div class="px">
        <div class="p num"><span class="lbl" data-testid="hold-label">{v.liveLabel}</span><LimitPx s={(v as any).limit}>{fmtPrice(v.price, v.market)}</LimitPx></div>
        {Number.isFinite(v.chg) && <div class={`c num ${cls(v.chg)}`} data-testid="hold-day"><span class="lbl">今日</span>{fmtPct(v.chg)}</div>}
        {"ext" in v && v.ext && <div class={`c num ${cls(v.ext.chg)}`} data-testid="hold-ext"><span class="lbl">{v.ext.label}</span>{fmtPrice(v.ext.price, v.market)} {fmtPct(v.ext.chg)}</div>}
      </div>
      <RatingPill rating={v.rating} rebound={v.scored?.rebound} />
    </button>
  );
}

function HoldingsEditor({ broker }: { broker: Broker }) {
  const holdings = useStore((s) => s.holdings).filter((h) => brokerOf(h) === broker);
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

function HoldingForm({ initial, onDone, broker = initial?.broker ?? "pocket" }: { initial?: Partial<Holding>; onDone: () => void; broker?: Broker }) {
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
    const h: Holding = { id: initial?.id ?? `${Date.now()}-${c}`, code: c, name, market, shares: sh, cost: co, broker };
    // 同一家券商的同代號會被覆蓋；另一家的同代號不動
    await saveHoldings(isEdit ? holdings.map((x) => (x.id === h.id ? h : x)) : [...holdings.filter((x) => x.code !== c || brokerOf(x) !== broker), h]);
    if (market === "US" && !findScored(c, "US")) addUsSymbol(c); // 不在清單裡的美股持股，自動下載
    onDone();
  };
  const remove = async () => { await saveHoldings(holdings.filter((x) => x.id !== initial?.id)); onDone(); };
  return (
    <Sheet title={isEdit ? `編輯 ${initial?.name}（${BROKERS.find((b) => b.key === broker)!.label}）` : `新增${BROKERS.find((b) => b.key === broker)!.label}持股`} onClose={onDone}>
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

function ImportReview({ data, onDone, broker }: { data: { rows: ImportedHolding[]; note: string }; onDone: () => void; broker: Broker }) {
  const holdings = useStore((s) => s.holdings);
  // 股數、成本用字串存（打小數點時 "25." 不能被轉成數字吃掉），存檔時才轉成數字檢查
  const [rows, setRows] = useState(data.rows.map((r) => ({ ...r, sharesText: String(r.shares ?? ""), costText: String(r.cost ?? ""), keep: !!r.code && r.shares > 0 })));
  const [err, setErr] = useState("");
  const upd = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // 這家券商原本有、截圖上沒有的持股：預設視為已賣出（11/12 使用者），用最新價估算已實現損益；不想移除可取消勾選
  const mine = holdings.filter((h) => brokerOf(h) === broker);
  const gone = soldByOmission(mine, rows.filter((r) => r.keep), (c) => getState().live[c]?.price ?? getState().prices[c]?.close ?? findScored(c)?.close);
  const [drop, setDrop] = useState<Record<string, boolean>>(() => Object.fromEntries(gone.map((g) => [g.id, true])));
  const dropped = gone.filter((g) => drop[g.id] !== false);
  const goneSum = dropped.reduce((a, g) => a + (g.pnl ?? 0), 0);
  const save = async () => {
    const picked = rows.filter((r) => r.keep && r.code).map((r) => ({ r, shares: Number(r.sharesText), cost: Number(r.costText) }));
    const bad = picked.find((x) => !(x.shares > 0) || !(x.cost > 0));
    if (bad) return setErr(`「${bad.r.name || bad.r.code}」的股數或每股成本不正確（要大於 0），請改好再加入，或取消勾選這一檔`);
    setErr("");
    const add: Holding[] = picked.map(({ r, shares, cost }) => {
      const code = r.code.trim().toUpperCase();
      const market = marketOf(code, r.market);
      return { id: `${Date.now()}-${code}`, code, name: findScored(code, market === "US" ? "US" : "TW")?.name ?? getState().prices[code]?.name ?? r.name, market, shares, cost, broker };
    });
    const codes = new Set(add.map((h) => h.code));
    const dropIds = new Set(dropped.map((g) => g.id));
    await saveHoldings([...holdings.filter((h) => !dropIds.has(h.id) && (!codes.has(h.code) || brokerOf(h) !== broker)), ...add]);
    onDone();
  };
  return (
    <Sheet title="確認辨識結果" onClose={onDone}>
      <div class="notice">會加入「{BROKERS.find((b) => b.key === broker)!.label}持股」。請核對辨識的內容，數字不對可以直接改。這家券商同代號的持股會被覆蓋。{data.note && <><br />備註：{data.note}</>}</div>
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
      {gone.length > 0 && (
        <div class="card stack" style={{ marginTop: "12px" }} data-testid="import-sold">
          <b>截圖上沒有 → 視為已賣出（{dropped.length} 檔）</b>
          {gone.map((g) => (
            <label class="check" style={{ justifyContent: "space-between", width: "100%" }} data-testid="import-sold-row">
              <span><input type="checkbox" checked={drop[g.id] !== false} onChange={(e) => setDrop({ ...drop, [g.id]: (e.target as HTMLInputElement).checked })} /> {g.name} <span class="muted num">{g.code}</span> {g.shares.toLocaleString()} 股</span>
              <span class={`num ${cls(g.pnl ?? 0)}`}>{g.pnl !== undefined ? `${g.pnl > 0 ? "+" : ""}${Math.round(g.pnl).toLocaleString()} 元` : "—"}</span>
            </label>
          ))}
          <div class="muted" style={{ fontSize: "12px", lineHeight: 1.6 }}>估計已實現損益合計 <b class={`num ${cls(goneSum)}`}>{goneSum > 0 ? "+" : ""}{Math.round(goneSum).toLocaleString()} 元</b>（用最新價 −均價 × 股數估算，未扣手續費與稅；實際以成交為準）。取消勾選的會留著。</div>
        </div>
      )}
      {err && <div class="error" style={{ marginTop: "12px" }}>{err}</div>}
      <button class="btn block" style={{ marginTop: "14px" }} onClick={save}>加入 {rows.filter((r) => r.keep).length} 檔持股{dropped.length ? `、移除 ${dropped.length} 檔` : ""}</button>
    </Sheet>
  );
}

// ---------------- 虛擬幣恐懼貪婪指數 ----------------
function FngCard({ f, onOpen }: { f: Fng; onOpen: () => void }) {
  // 恐懼偏綠（跌）、貪婪偏紅（漲），和台股紅漲綠跌的配色一致；整排寬，左邊文字、右邊儀表板
  const c = f.value <= 44 ? "down" : f.value >= 56 ? "up" : "";
  const diff = (x?: number) => (x === undefined ? "" : `${f.value - x >= 0 ? "+" : ""}${f.value - x}`);
  return (
    <div class="metric" data-testid="fng-card" style={{ cursor: "pointer", gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: "10px" }} onClick={onOpen}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div class="k">恐懼貪婪指數</div>
        <div class={`v num ${c}`}>{f.value}　<span style={{ fontSize: "14px" }}>{f.label}</span></div>
        <div class="d muted" style={{ fontSize: "11.5px", lineHeight: 1.5 }}>
          {[f.prev !== undefined ? `昨天 ${f.prev}（${diff(f.prev)}）` : "", f.weekAgo !== undefined ? `一週前 ${f.weekAgo}` : "", f.monthAgo !== undefined ? `一個月前 ${f.monthAgo}` : ""].filter(Boolean).join("・")}
          <div>點進去看近一年走勢</div>
        </div>
      </div>
      <FngGauge v={f.value} />
    </div>
  );
}

/** 半圓儀表板：左 0（極度恐懼）到右 100（極度貪婪），指針指到目前分數 */
const GAUGE_SEGS = [[0, 25, "#13834a"], [25, 45, "#7cc49a"], [45, 56, "#b9b4a8"], [56, 76, "#ec8f97"], [76, 100, "#d7263d"]] as const;
function FngGauge({ v }: { v: number }) {
  const cx = 70, cy = 66, r = 54, w = 14;
  const pt = (val: number, rad: number) => { const a = Math.PI * (1 - val / 100); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; };
  const arc = (a: number, b: number) => { const [x1, y1] = pt(a, r), [x2, y2] = pt(b, r); return `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 1 ${x2.toFixed(1)},${y2.toFixed(1)}`; };
  const vv = Math.max(0, Math.min(100, v));
  const [nx, ny] = pt(vv, r - 8);
  return (
    <svg viewBox="0 0 140 82" width="140" height="82" role="img" aria-label={`恐懼貪婪指數 ${v}`} data-testid="fng-gauge" data-value={v} style={{ flex: "none" }}>
      {GAUGE_SEGS.map(([a, b, col]) => <path d={arc(a + 0.6, b - 0.6)} fill="none" stroke={col} stroke-width={w} />)}
      <line x1={cx} y1={cy} x2={nx.toFixed(1)} y2={ny.toFixed(1)} stroke="var(--fg)" stroke-width="3" stroke-linecap="round" data-testid="fng-needle" />
      <circle cx={cx} cy={cy} r="5" fill="var(--fg)" />
      <text x={cx - r} y={cy + 14} font-size="9" fill="var(--muted)" text-anchor="middle">0</text>
      <text x={cx + r} y={cy + 14} font-size="9" fill="var(--muted)" text-anchor="middle">100</text>
      <text x={cx - r + 6} y={cy - r + 4} font-size="9" fill="#13834a">恐懼</text>
      <text x={cx + r - 6} y={cy - r + 4} font-size="9" fill="#d7263d" text-anchor="end">貪婪</text>
    </svg>
  );
}

// ---------------- 個股頁方塊的詳細內容 ----------------
function MetricDetail({ kind, s, bars, nav, onClose }: { kind: "1w" | "1m" | "3m" | "rs" | "nav"; s: Scored; bars: CandleBar[] | null; nav?: EtfNav; onClose: () => void }) {
  const fp = (x: number) => fmtPrice(x, s.market);
  const fd = (d: string) => prettyW(d);
  if (kind === "nav") {
    return (
      <Sheet title={`${s.name} 折溢價`} onClose={onClose}>
        {nav ? <>
          <div class="grid2" data-testid="mx-detail">
            <Metric k="市價" v={fp(nav.price)} />
            <Metric k="預估淨值" v={fp(nav.nav)} />
            <Metric k="折溢價" v={`${nav.premium > 0 ? "+" : ""}${nav.premium.toFixed(2)}%`} c={cls(nav.premium)} d={Math.abs(nav.premium) >= 1 ? (nav.premium > 0 ? "溢價偏高" : "折價偏深") : "在合理範圍（±1% 內）"} />
            <Metric k="前一日淨值" v={Number.isFinite(nav.prevNav) ? fp(nav.prevNav) : "—"} d={nav.time ? `證交所 ${nav.time.slice(0, 5)} 更新` : ""} />
          </div>
          <div class="card" style={{ fontSize: "13px", lineHeight: 1.7, marginTop: "10px" }}>
            折溢價＝（市價 − 預估淨值）÷ 預估淨值。<b>溢價</b>代表買的價格比 ETF 實際持有的資產價值貴，<b>折價</b>代表比較便宜。
            溢價超過 1% 時買進，等於多付了這段差價，之後溢價縮小就會虧在這裡；主動式與熱門 ETF 常在搶購時出現溢價。預估淨值是證交所盤中依成分股即時價推算，收盤後以投信公布的淨值為準。
          </div>
        </> : <div class="muted">還沒抓到預估淨值。</div>}
      </Sheet>
    );
  }
  if (kind === "rs") {
    const rs = s.rsVsIndex1m, r1 = s.ret1m;
    const spx = rs !== undefined && Number.isFinite(rs) && Number.isFinite(r1) ? r1 - rs : undefined;
    return (
      <Sheet title={`${s.name} 相對 S&P 500`} onClose={onClose}>
        <div class="grid2" data-testid="mx-detail">
          <Metric k={`${s.code} 近 1 月`} v={fmtPct(r1)} c={cls(r1)} />
          <Metric k="S&P 500 近 1 月" v={fmtPct(spx)} c={cls(spx ?? 0)} d="用 SPY 計算" />
          <Metric k="相對表現（超額報酬）" v={fmtPct(rs)} c={cls(rs ?? 0)} d={rs === undefined ? "" : rs >= 0 ? "比大盤強" : "比大盤弱"} />
        </div>
        <div class="card" style={{ fontSize: "13px", lineHeight: 1.7, marginTop: "10px" }}>相對表現＝這檔近 1 個月（21 個交易日）的漲跌減去 S&P 500 同期的漲跌。正值代表跑贏大盤，評分的「動能」會參考這個數字；短期大幅落後大盤通常代表資金正在撤出。</div>
      </Sheet>
    );
  }
  const n = kind === "1w" ? 5 : kind === "1m" ? 21 : 63;
  const label = kind === "1w" ? "近 1 週" : kind === "1m" ? "近 1 月" : "近 3 月";
  const b = bars ?? [];
  const ok = b.length > n;
  const seg = ok ? b.slice(b.length - 1 - n) : [];
  const base = seg[0], last = seg[seg.length - 1];
  const ret = ok ? last.close / base.close - 1 : undefined;
  const hi = ok ? seg.slice(1).reduce((m, x) => (x.high > m.high ? x : m), seg[1]) : undefined;
  const lo = ok ? seg.slice(1).reduce((m, x) => (x.low < m.low ? x : m), seg[1]) : undefined;
  let pk = base?.close ?? 0, dd = 0;
  for (const x of seg.slice(1)) { pk = Math.max(pk, x.close); dd = Math.min(dd, x.close / pk - 1); }
  const days = seg.slice(1).map((x, i) => ({ d: x.date, c: x.close, chg: x.close / seg[i].close - 1 }));
  const up = days.filter((x) => x.chg > 0).length;
  return (
    <Sheet title={`${s.name} ${label}`} onClose={onClose}>
      {!ok ? <div class="muted">走勢資料下載中，稍後再點一次。</div> : <>
        <div class="grid2" data-testid="mx-detail">
          <Metric k={`${label}漲跌`} v={fmtPct(ret)} c={cls(ret ?? 0)} d={`${fd(base.date)} 收 ${fp(base.close)} → ${fd(last.date)} 收 ${fp(last.close)}`} />
          <Metric k="期間最大回檔" v={fmtPct(dd)} c={dd < 0 ? "down" : ""} d="從期間最高收盤往下最多跌多少" />
          <Metric k="期間最高" v={fp(hi!.high)} d={fd(hi!.date)} />
          <Metric k="期間最低" v={fp(lo!.low)} d={fd(lo!.date)} />
          <Metric k="上漲天數" v={`${up}／${days.length} 天`} d={`下跌 ${days.filter((x) => x.chg < 0).length} 天`} />
          <Metric k="目前距期間高點" v={fmtPct(last.close / hi!.high - 1)} c={cls(last.close / hi!.high - 1)} />
        </div>
        <div class="section-title"><span>每天收盤</span><span class="muted" style={{ fontSize: "12px" }}>新到舊</span></div>
        <div class="card" style={{ padding: "4px 12px" }} data-testid="mx-days">
          {[...days].reverse().map((x) => (
            <div class="row" style={{ justifyContent: "space-between", padding: "5px 0", borderTop: "1px solid var(--line)", fontSize: "13px" }}>
              <span>{fd(x.d)}</span><span class="num">{fp(x.c)} <span class={cls(x.chg)} style={{ display: "inline-block", minWidth: "62px", textAlign: "right" }}>{fmtPct(x.chg, 2)}</span></span>
            </div>
          ))}
        </div>
        <div class="muted" style={{ fontSize: "11.5px", marginTop: "6px" }}>{label}＝最近 {n} 個交易日；用日 K 收盤計算，和上方方塊（評分當天的資料）可能差一兩天。</div>
      </>}
    </Sheet>
  );
}

// ---------------- 美股 24 小時行情（OKX xStocks：美股的代幣版本，收盤後與週末也在交易） ----------------
/** 美股代號 → OKX xStock 交易對；OKX 的商品清單一天抓一次存手機（約 1,000 筆） */
async function okxInstId(code: string): Promise<string | undefined> {
  const kv = getKv(), key = "okx:inst";
  let saved = await kv.get<{ at: number; json: any }>(key);
  if (!saved || Date.now() - saved.at > 24 * 3600_000) {
    try { const json = await getFetcher()(okxInstrumentsUrl()); saved = { at: Date.now(), json: { code: "0", data: (json?.data ?? []).filter((d: any) => /^x|x$/i.test(String(d?.baseCcy ?? ""))).map((d: any) => ({ instId: d.instId, baseCcy: d.baseCcy, quoteCcy: d.quoteCcy, state: d.state })) } }; await kv.set(key, saved); }
    catch (e) { if (!saved) throw e; }
  }
  return findXStock(saved.json, code);
}

function UsOvernight({ code, close }: { code: string; close: number }) {
  const [inst, setInst] = useState<string | null | undefined>(undefined); // undefined＝查詢中、null＝沒有
  const [bar, setBar] = useState<OkxBar>("1H");
  const [tk, setTk] = useState<OkxTicker | undefined>();
  const [bars, setBars] = useState<CandleBar[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    okxInstId(code).then((id) => { if (alive) setInst(id ?? null); }).catch((e) => { if (alive) { setInst(null); setErr(`OKX 連線失敗：${e?.message ?? e}`); } });
    return () => { alive = false; };
  }, [code]);
  // 即時：OKX 最新價每 3 秒、K 線每 15 秒（最後一根用最新價即時更新）
  useEffect(() => {
    if (!inst) return;
    let alive = true;
    const pullTk = async () => {
      try { const t = parseOkxTicker(await getFetcher()(okxTickerUrl(inst))); if (alive && t) { setTk(t); setErr(""); } }
      catch (e: any) { if (alive) setErr(`OKX 行情下載失敗：${e?.message ?? e}`); }
    };
    pullTk();
    const t = setInterval(pullTk, 3_000);
    return () => { alive = false; clearInterval(t); };
  }, [inst]);
  useEffect(() => {
    if (!inst) return;
    let alive = true;
    const pullK = async () => {
      try { const c = parseOkxCandles(await getFetcher()(okxCandlesUrl(inst, bar))) as CandleBar[]; if (alive) setBars(c); }
      catch (e: any) { if (alive) setErr(`OKX K 線下載失敗：${e?.message ?? e}`); }
    };
    setBars(null); pullK();
    const t = setInterval(pullK, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [inst, bar]);
  // 美股報價（CNBC，含盤前／盤後）每 5 秒
  useEffect(() => {
    refreshUsLive([code]);
    const t = setInterval(() => refreshUsLive([code]), 5_000);
    return () => clearInterval(t);
  }, [code]);
  const lq = useStore((st) => st.live[code]);
  const [, tick] = useState(0); // 每秒重畫一次，「幾秒前更新」才會走
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1_000); return () => clearInterval(t); }, []);
  // 最後一根 K 棒（進行中）用最新價更新收盤與高低
  const shownBars = useMemo(() => {
    if (!bars || !bars.length || !tk) return bars;
    const last = bars[bars.length - 1];
    return [...bars.slice(0, -1), { ...last, close: tk.last, high: Math.max(last.high, tk.last), low: Math.min(last.low, tk.last) }];
  }, [bars, tk]);
  const chg = tk && tk.open24h ? tk.last / tk.open24h - 1 : undefined; // 對照 24 小時前
  // 交易時段表：盤前／盤中（或收盤）／盤後／24 小時（OKX）。漲跌都對照「最近一次正常盤收盤」或昨收
  const sess = usSession();
  const nyToday = nyParts().ymd;
  const reg = lq?.price ?? close;
  const chgReg = tk && reg > 0 ? tk.last / reg - 1 : undefined; // 24 小時價對照最近一次正常盤收盤（和交易時段表一致）
  const regPrev = lq?.prevClose;
  const xq = lq?.xq;
  const pre = xq?.label === "盤前" && xq.date === nyToday ? xq : undefined;
  const post = xq?.label === "盤後" ? xq : undefined;
  const pctTxt = (x?: number) => (x === undefined || !Number.isFinite(x) ? "" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);
  const rows: { k: string; live: boolean; price?: number; chg?: number; note: string; id: string }[] = [
    { id: "pre", k: "盤前", live: sess === "盤前", price: pre?.price, chg: pre ? pre.price / reg - 1 : undefined, note: pre ? `台北 ${pre.time}・對照前一天收盤` : "美東 4:00～9:30（台北約 16:00／17:00 起）" },
    { id: "reg", k: lq && !lq.final ? "盤中" : "收盤", live: sess === "盤中", price: reg, chg: regPrev ? reg / regPrev - 1 : undefined, note: lq ? [lq.date ? prettyW(lq.date) : "", lq.time ? `台北 ${lq.time}` : ""].filter(Boolean).join("・") : "還沒抓到即時價" },
    { id: "post", k: "盤後", live: sess === "盤後", price: post?.price, chg: post ? post.chg : undefined, note: post ? `台北 ${post.time}・對照收盤` : "美東 16:00～20:00" },
    { id: "24h", k: "24 小時", live: sess === "夜間" || sess === "週末", price: tk?.last, chg: tk ? tk.last / reg - 1 : undefined, note: tk ? `OKX ${inst?.replace("-", "/")}・對照最近收盤` : err ? err : inst === null ? "OKX 沒有這檔的 24 小時交易" : inst === undefined ? "查詢 OKX 交易對中…" : "OKX 報價下載中…" },
  ];
  const sym = inst?.split("-")[0] ?? "";
  return (
    <>
      <div class="section-title"><span>即時行情・交易時段</span><span class="muted" style={{ fontSize: "12px" }}>現在：{sess === "夜間" ? "美股收盤（夜間）" : sess === "週末" ? "週末休市" : sess}</span></div>
      <div class="card" style={{ padding: "6px 12px" }} data-testid="us-sessions">
        {rows.map((r) => (
          <div class="row" style={{ justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderTop: r.id === "pre" ? "none" : "1px solid var(--line)" }} data-testid={`us-sess-${r.id}`}>
            <div style={{ minWidth: 0 }}>
              <b>{r.k}</b>{r.live && <span class="up" style={{ fontSize: "11px", marginLeft: "6px" }} data-testid="us-sess-live">● 進行中</span>}
              <div class="muted" style={{ fontSize: "11px" }}>{r.note}</div>
            </div>
            <div style={{ textAlign: "right", flex: "none" }}>
              <div class={`num ${r.chg === undefined ? "" : cls(r.chg)}`} style={{ fontSize: "17px", fontWeight: 700 }}>{r.price !== undefined && Number.isFinite(r.price) ? fmtPrice(r.price) : "—"}</div>
              <div class={`num ${r.chg === undefined ? "" : cls(r.chg)}`} style={{ fontSize: "12px" }}>{pctTxt(r.chg)}</div>
            </div>
          </div>
        ))}
        <div class="muted" style={{ fontSize: "11px", padding: "4px 0 2px" }}>美股報價每 5 秒、24 小時（OKX）每 3 秒自動更新；開著這頁就會一直更新。</div>
      </div>

      <div class="section-title"><span>24 小時行情{inst ? `（OKX ${inst.replace("-", "/")}）` : ""}</span><span class="muted" style={{ fontSize: "12px" }}>隔夜・週末也交易</span></div>
      <div class="card stack" style={{ padding: "10px" }} data-testid="us-24h">
        {inst === undefined && !err && <div class="muted" style={{ fontSize: "13px" }}>查詢 OKX 有沒有 {code} 的 24 小時交易…</div>}
        {inst === null && !err && <div class="muted" style={{ fontSize: "13px" }} data-testid="us-24h-none">OKX 目前沒有 {code} 的 xStock（24 小時交易版本），只有部分美股有。</div>}
        {err && <div class="muted" style={{ fontSize: "13px" }} data-testid="us-24h-err">{err}</div>}
        {inst && tk && (
          <div class="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }} data-testid="us-24h-quote">
            <div>
              <div class={`big num ${cls(chgReg ?? 0)}`} style={{ fontSize: "28px" }} data-testid="us-24h-last">{fmtPrice(tk.last)}</div>
              <div class={`num ${cls(chgReg ?? 0)}`} style={{ fontSize: "13px" }} data-testid="us-24h-chg">{pctTxt(chgReg)}<span class="muted">（對照最近收盤 {fmtPrice(reg)}）</span></div>
              {chg !== undefined && <div class="muted num" style={{ fontSize: "11.5px" }}>24 小時前起算 <span class={cls(chg)}>{pctTxt(chg)}</span></div>}
            </div>
            <div style={{ fontSize: "12.5px", lineHeight: 1.7, textAlign: "right" }}>
              <div><span class="muted">24 小時最高</span> <b class="num">{tk.high24h !== undefined ? fmtPrice(tk.high24h) : "—"}</b></div>
              <div><span class="muted">24 小時最低</span> <b class="num">{tk.low24h !== undefined ? fmtPrice(tk.low24h) : "—"}</b></div>
              <div><span class="muted">24 小時量（{sym}）</span> <b class="num">{tk.vol24h !== undefined ? tk.vol24h.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"}</b></div>
              <div><span class="muted">24 小時額（USDT）</span> <b class="num">{tk.amount24h !== undefined ? (tk.amount24h >= 1e4 ? `${(tk.amount24h / 1e4).toFixed(2)} 萬` : Math.round(tk.amount24h).toLocaleString("en-US")) : "—"}</b></div>
            </div>
          </div>
        )}
        {inst && (
          <div class="seg" role="group" aria-label="K 線週期" data-testid="us-24h-bars">
            {OKX_BARS.map((b) => <button aria-pressed={bar === b.bar} onClick={() => setBar(b.bar)} data-testid={`us-24h-bar-${b.bar}`}>{b.label}</button>)}
          </div>
        )}
        {inst && (bars === null ? <div class="muted" style={{ fontSize: "13px" }}>K 線下載中…</div>
          : bars.length >= 2 ? <CandleChart bars={shownBars ?? bars} us intraday /> : <div class="muted" style={{ fontSize: "13px" }}>這個週期還沒有 K 線資料。</div>)}
        {inst && <div class="muted" style={{ fontSize: "11px", lineHeight: 1.5 }}>xStock 是在 OKX 交易、對應 {code} 的代幣，美股收盤後與週末也能交易，所以能看到隔夜的價格變化；價格是 USDT 計價，可能和美股收盤價有落差。時間為台北時間；最新價每 3 秒、K 線每 15 秒更新。</div>}
      </div>
    </>
  );
}

// ---------------- 恐懼貪婪指數詳情：近一年走勢（疊比特幣）、摘要、算法說明 ----------------
const FNG_BANDS = [[0, 25, "極度恐懼"], [25, 45, "恐懼"], [45, 56, "中立"], [56, 76, "貪婪"], [76, 101, "極度貪婪"]] as const;
const FNG_RANGES = [["3 個月", 90], ["6 個月", 182], ["1 年", 400]] as const;
function FngDetail({ f, onClose }: { f: Fng; onClose: () => void }) {
  const [btc, setBtc] = useState<{ date: string; close: number }[]>([]);
  const [range, setRange] = useState<number>(90);
  const [pick, setPick] = useState<number | null>(null); // 點選的那一天（在 view 裡的位置）
  useEffect(() => {
    let alive = true;
    indexHistory(getFetcher(), getKv(), "BTC.CM=", 12, Date.now(), (h) => { if (alive) setBtc(h.bars); }).then((h) => { if (alive) setBtc(h.bars); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const all = f.hist ?? [];
  // 7 日平均：每天的數字跳很大，平均線比較看得出趨勢
  const ma7 = all.map((_, k) => { const a = all.slice(Math.max(0, k - 6), k + 1); return a.reduce((t, h) => t + h.value, 0) / a.length; });
  const start = Math.max(0, all.length - range);
  const view = all.slice(start).map((h, k) => ({ ...h, ma: ma7[start + k] }));
  const n = view.length;
  const btcBy = new Map(btc.map((b) => [b.date, b.close]));
  const W = 340, padL = 34, padR = 10;
  const x = (i: number) => padL + (n > 1 ? i / (n - 1) : 0) * (W - padL - padR);
  // 上：比特幣價格（自己的刻度）；下：恐懼貪婪指數（0～100 與分級底色）
  const bH = 120, bT = 8, bB = 16;
  const bpts = view.map((h, i) => ({ i, v: btcBy.get(h.date) })).filter((p): p is { i: number; v: number } => p.v !== undefined);
  const bLo0 = Math.min(...bpts.map((p) => p.v)), bHi0 = Math.max(...bpts.map((p) => p.v)), bm = (bHi0 - bLo0) * 0.08;
  const bLo = bLo0 - bm, bHi = bHi0 + bm;
  const by = (v: number) => bT + (1 - (v - bLo) / (bHi - bLo || 1)) * (bH - bT - bB);
  const bline = bpts.map((p, k) => `${k ? "L" : "M"}${x(p.i).toFixed(1)},${by(p.v).toFixed(1)}`).join("");
  const bTicks = [bLo0, (bLo0 + bHi0) / 2, bHi0];
  const fH = 170, fT = 6, fB = 20;
  const y = (v: number) => fT + (1 - v / 100) * (fH - fT - fB);
  const raw = view.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.value).toFixed(1)}`).join("");
  const avg = view.map((h, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(h.ma).toFixed(1)}`).join("");
  const bandColor = (lo: number) => (lo < 45 ? "var(--down)" : lo < 56 ? "var(--muted)" : "var(--up)");
  const bandOp = (lo: number) => (lo < 25 || lo >= 76 ? 0.2 : lo < 45 || lo >= 56 ? 0.09 : 0.05);
  // 日期刻度：每個月 1 號（3 個月），6 個月和 1 年只標單數月
  const ticks: number[] = [];
  view.forEach((h, i) => { if (i > 0 && h.date.slice(4, 6) !== view[i - 1].date.slice(4, 6) && (range <= 90 || +h.date.slice(4, 6) % 2 === 1)) ticks.push(i); });
  const fmtD = (d?: string) => (d ? `${+d.slice(4, 6)}/${+d.slice(6)}` : "");
  const fmtY = (d?: string) => (d ? `${d.slice(0, 4)}/${+d.slice(4, 6)}/${+d.slice(6)}` : "");
  const c = (v: number) => (v <= 44 ? "down" : v >= 56 ? "up" : "");
  const selI = pick !== null && view[pick] ? pick : n - 1;
  const sel = view[selI];
  const selBtc = sel ? btcBy.get(sel.date) : undefined;
  // 點或拖曳圖：換成那一天
  const onPoint = (e: PointerEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setPick(Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1)))));
  };
  const onMove = (e: PointerEvent) => { if (e.buttons || e.pointerType !== "mouse") onPoint(e); };
  const cross = (h: number) => <line x1={x(selI)} x2={x(selI)} y1={0} y2={h} stroke="var(--fg)" stroke-opacity="0.35" stroke-dasharray="3 3" />;
  return (
    <Sheet title="虛擬幣恐懼貪婪指數" onClose={onClose}>
      <div class="row" style={{ justifyContent: "space-between", alignItems: "center" }} data-testid="fng-detail">
        <div>
          <div class={`big num ${c(f.value)}`} data-testid="fng-value">{f.value}</div>
          <div class={c(f.value)}><b>{f.label}</b>{f.streak ? <span class="muted">・已連續 {f.streak} 天</span> : null}</div>
          <div class="muted" style={{ fontSize: "12px" }}>{fmtY(f.date)}（UTC）・alternative.me</div>
        </div>
        <FngGauge v={f.value} />
      </div>

      <div class="section-title"><span>近一年走勢</span><span>{all.length} 天</span></div>
      {n >= 2 ? (
        <div class="card stack" style={{ padding: "10px" }} data-testid="fng-chart">
          <div class="row" style={{ gap: "6px" }} role="group" aria-label="期間" data-testid="fng-range">
            {FNG_RANGES.map(([lb, d]) => <button class="chip" aria-pressed={range === d} onClick={() => { setRange(d); setPick(null); }} data-testid={`fng-range-${d}`}>{lb}</button>)}
          </div>
          <div class="row" style={{ justifyContent: "space-between", fontSize: "13px", alignItems: "baseline" }} data-testid="fng-pick">
            <b>{fmtY(sel?.date)}</b>
            <span>指數 <b class={`num ${c(sel?.value ?? 50)}`}>{sel?.value}</b> {sel ? fngLabel(sel.value) : ""}<span class="muted">・7 日平均 {sel ? Math.round(sel.ma) : ""}</span></span>
          </div>
          <div class="muted" style={{ fontSize: "12px", marginTop: "-4px" }}>比特幣 <b class="num" style={{ color: "#c98a0b" }}>{selBtc !== undefined ? `$${Math.round(selBtc).toLocaleString("en-US")}` : bpts.length ? "（那天沒有價格）" : "下載中…"}</b></div>

          <div class="muted" style={{ fontSize: "12px" }}>比特幣價格（美元）</div>
          <svg viewBox={`0 0 ${W} ${bH}`} width="100%" role="img" aria-label="比特幣價格" style={{ touchAction: "none" }} onPointerDown={onPoint} onPointerMove={onMove} data-testid="fng-btc-svg">
            {bpts.length >= 2 ? <>
              {bTicks.map((t) => <g><line x1={padL} x2={W - padR} y1={by(t)} y2={by(t)} stroke="var(--line)" /><text x={padL - 4} y={by(t) + 3} font-size="9.5" fill="var(--muted)" text-anchor="end">{t >= 10000 ? `${Math.round(t / 1000)}k` : Math.round(t)}</text></g>)}
              <path d={bline} fill="none" stroke="#e8a317" stroke-width="1.8" data-testid="fng-btc-line" />
              {cross(bH - bB)}
              {selBtc !== undefined && <circle cx={x(selI)} cy={by(selBtc)} r="3.5" fill="#e8a317" />}
            </> : <text x={W / 2} y={bH / 2} font-size="11" fill="var(--muted)" text-anchor="middle">比特幣價格下載中…</text>}
          </svg>

          <div class="muted" style={{ fontSize: "12px" }}>恐懼貪婪指數（細線＝每天、粗線＝7 日平均）</div>
          <svg viewBox={`0 0 ${W} ${fH}`} width="100%" role="img" aria-label="恐懼貪婪指數走勢" style={{ touchAction: "none" }} onPointerDown={onPoint} onPointerMove={onMove} data-testid="fng-svg" data-n={n}>
            {FNG_BANDS.map(([lo, hi, nm]) => <g>
              <rect x={padL} width={W - padL - padR} y={y(Math.min(hi, 100))} height={y(lo) - y(Math.min(hi, 100))} fill={bandColor(lo)} fill-opacity={bandOp(lo)} />
              <text x={W - padR - 3} y={(y(Math.min(hi, 100)) + y(lo)) / 2 + 3} font-size="9" fill={bandColor(lo)} text-anchor="end">{nm}</text>
            </g>)}
            {[0, 25, 50, 75, 100].map((t) => <text x={padL - 4} y={y(t) + 3} font-size="9.5" fill="var(--muted)" text-anchor="end">{t}</text>)}
            <path d={raw} fill="none" stroke="var(--fg)" stroke-width="0.9" stroke-opacity="0.35" data-testid="fng-line" />
            <path d={avg} fill="none" stroke="var(--fg)" stroke-width="2.2" data-testid="fng-ma" />
            {cross(fH - fB)}
            {sel && <circle cx={x(selI)} cy={y(sel.value)} r="3.5" fill="var(--fg)" />}
            {ticks.map((i) => <text x={x(i)} y={fH - 5} font-size="9.5" fill="var(--muted)" text-anchor="middle">{fmtD(view[i].date)}</text>)}
          </svg>
          <div class="muted" style={{ fontSize: "11.5px", lineHeight: 1.6 }}>點或左右拖曳圖可以看那一天的數字。底色：綠＝恐懼（0～44）、灰＝中立（45～55）、紅＝貪婪（56～100），顏色越深越極端。</div>
        </div>
      ) : <div class="muted">歷史資料下載中…</div>}

      <div class="section-title"><span>摘要</span></div>
      <div class="grid2" data-testid="fng-summary">
        <Metric k="昨天" v={f.prev !== undefined ? String(f.prev) : "—"} c={f.prev !== undefined ? c(f.prev) : ""} d={f.prev !== undefined ? `今天比昨天 ${f.value - f.prev >= 0 ? "+" : ""}${f.value - f.prev}` : ""} />
        <Metric k="一週前" v={f.weekAgo !== undefined ? String(f.weekAgo) : "—"} c={f.weekAgo !== undefined ? c(f.weekAgo) : ""} d={f.weekAgo !== undefined ? fngLabel(f.weekAgo) : ""} />
        <Metric k="一個月前" v={f.monthAgo !== undefined ? String(f.monthAgo) : "—"} c={f.monthAgo !== undefined ? c(f.monthAgo) : ""} d={f.monthAgo !== undefined ? fngLabel(f.monthAgo) : ""} />
        <Metric k="一年內最高／最低" v={f.high && f.low ? `${f.high.value}／${f.low.value}` : "—"} d={f.high && f.low ? `最高 ${fmtY(f.high.date)}・最低 ${fmtY(f.low.date)}` : ""} />
      </div>

      <div class="section-title"><span>這個指數怎麼算</span></div>
      <div class="card" style={{ fontSize: "13px", lineHeight: 1.7 }} data-testid="fng-about">
        alternative.me 每天用以下資料算出 0～100 分（比重是官方公布的大約比例）：
        <ul style={{ margin: "6px 0 6px 18px", padding: 0 }}>
          <li>波動度 約 25%：比特幣近 30／90 天波動和平均比，波動異常放大代表恐懼。</li>
          <li>市場動能與成交量 約 25%：買盤量大、價格上漲代表貪婪。</li>
          <li>社群媒體 約 15%：社群上討論比特幣的熱度與速度。</li>
          <li>問卷 約 15%：官方注明目前暫停。</li>
          <li>比特幣市占率 約 10%：市占率上升代表資金躲回比特幣（偏恐懼），下降代表追小幣（偏貪婪）。</li>
          <li>Google 搜尋趨勢 約 10%：例如「比特幣 崩盤」這類搜尋變多代表恐懼。</li>
        </ul>
        <div class="muted">怎麼看：這是虛擬幣市場的情緒，不是台股或美股的。常見的用法是「別人恐懼時留意機會、別人貪婪時小心過熱」，但情緒可以極端很久，只當參考，不是買賣訊號。</div>
      </div>
    </Sheet>
  );
}

// ---------------- 國際指標詳細報價（今日開高低、52 週區間、區間報酬、均線位置） ----------------
const fmtQ = (x: number | undefined) => (x !== undefined && Number.isFinite(x) ? x.toLocaleString("en-US", { maximumFractionDigits: 3 }) : "—");
function QuotePanel({ q, bars, crypto = false }: { crypto?: boolean; q: MacroQuote; bars: { date: string; open: number; high: number; low: number; close: number; volume: number }[] }) {
  const closes = bars.map((b) => ({ ...b }));
  const ret = (n: number) => { const r = retN(closes, n); return Number.isFinite(r) ? r : undefined; };
  const ma = (n: number) => { const m = sma(closes, n); return Number.isFinite(m) ? m : undefined; };
  const px = q.last;
  const range = q.yearHigh !== undefined && q.yearLow !== undefined && q.yearHigh > q.yearLow ? (px - q.yearLow) / (q.yearHigh - q.yearLow) : undefined;
  // 虛擬幣每天都有一根（含週末），一週 7 根；股市一週約 5 個交易日
  const rr = (crypto ? [["近 1 週", ret(7)], ["近 1 月", ret(30)], ["近 3 月", ret(90)]] : [["近 1 週", ret(5)], ["近 1 月", ret(21)], ["近 3 月", ret(63)]]) as [string, number | undefined][];
  const mas = [["20 日線", ma(20)], ["60 日線", ma(60)]] as const;
  const pcts = (x: number | undefined) => (x === undefined ? "—" : fmtPct(x, 2));
  return (
    <div data-testid="idx-stats">
      <div class="section-title"><span>今日報價</span><span>{q.time ? q.time.slice(0, 10) : ""}</span></div>
      <div class="grid2">
        <Metric k="開盤" v={fmtQ(q.open)} />
        <Metric k="昨收" v={fmtQ(q.prevClose)} />
        <Metric k="最高" v={fmtQ(q.high)} />
        <Metric k="最低" v={fmtQ(q.low)} />
      </div>
      {(q.yearHigh !== undefined || q.yearLow !== undefined) && (
        <>
          <div class="section-title"><span>52 週區間</span></div>
          <div class="card" style={{ padding: "10px 12px" }}>
            <div class="row" style={{ justifyContent: "space-between", fontSize: "13px" }}>
              <span>低 <b class="num">{fmtQ(q.yearLow)}</b></span><span>52 週高 <b class="num">{fmtQ(q.yearHigh)}</b></span>
            </div>
            {range !== undefined && <>
              <div style={{ position: "relative", height: "8px", borderRadius: "4px", background: "var(--line)", margin: "8px 0" }}>
                <div style={{ position: "absolute", left: `calc(${Math.min(100, Math.max(0, range * 100)).toFixed(1)}% - 5px)`, top: "-2px", width: "12px", height: "12px", borderRadius: "50%", background: "var(--fg)" }} />
              </div>
              <div class="muted" style={{ fontSize: "12px" }} data-testid="idx-range">目前在 52 週區間的 {(range * 100).toFixed(0)}% 位置；距 52 週高 {fmtPct(px / q.yearHigh! - 1, 1)}、高於 52 週低 {fmtPct(px / q.yearLow! - 1, 1)}</div>
            </>}
          </div>
        </>
      )}
      {bars.length >= 6 && (
        <>
          <div class="section-title"><span>區間報酬與均線</span></div>
          <div class="card" style={{ padding: "6px 12px" }} data-testid="idx-returns">
            {rr.map(([k, v]) => <div class="row" style={{ justifyContent: "space-between", padding: "4px 0" }}><span>{k}</span><b class={`num ${v === undefined ? "" : cls(v)}`}>{pcts(v)}</b></div>)}
            {mas.map(([k, v]) => <div class="row" style={{ justifyContent: "space-between", padding: "4px 0" }}><span>{k}</span><span class="num">{v === undefined ? "資料不足" : <>{fmtQ(v)}　<b class={cls(px - v)}>{px >= v ? "站上" : "跌破"}（{fmtPct(px / v - 1, 1)}）</b></>}</span></div>)}
          </div>
        </>
      )}
      <div class="muted" style={{ fontSize: "12px", marginTop: "6px" }}>{[q.exchange, q.currency, q.status === "REG_MKT" ? "交易中" : q.status === "CLOSED" ? "已收盤" : ""].filter(Boolean).join("・")}</div>
    </div>
  );
}

// ---------------- 指數走勢（數據頁點指數卡片） ----------------
function IndexDetail({ name, label, onClose }: { name: string; label?: string; onClose: () => void }) {
  const us = isUsIndexSymbol(name); // 美股、亞洲指數、原物料期貨用 CNBC 代號（.SPX、.KS11、@GC.1）
  const lq = useStore((st) => st.twIndexLive[name]);
  const mq = useStore((st) => (us ? st.macro.quotes.find((q) => q.symbol === name) : undefined));
  const [hist, setHist] = useState<IndexHist | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    let alive = true;
    indexHistory(getFetcher(), getKv(), name, 6, Date.now(), (h) => { if (alive) setHist(h); }, 70, () => !alive)
      .then((h) => { if (alive) { setHist(h); setDone(true); } })
      .catch((e) => { if (alive) { setErr(`走勢圖下載失敗：${e?.message ?? e}`); setDone(true); } });
    return () => { alive = false; };
  }, [name]);
  const shown = useMemo(() => {
    if (!hist) return null;
    const live = lq ? { date: lq.date, price: lq.value, open: lq.prevClose, high: lq.high ?? lq.value, low: lq.low ?? lq.value, final: lq.final } : undefined;
    return withLiveBar(hist.bars as CandleBar[], live) as CandleBar[];
  }, [hist, lq]);
  return (
    <Sheet title={`${label ?? name} 走勢`} onClose={onClose}>
      {mq && (
        <div class="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div class="big num" data-testid="idx-price">{mq.last.toLocaleString("en-US", { maximumFractionDigits: 3 })}</div>
            <div class={`num ${cls(mq.change)}`}>{macroDelta(mq)}</div>
          </div>
          <div class="muted" style={{ fontSize: "12px", textAlign: "right" }}>CNBC 報價</div>
        </div>
      )}
      {lq && (
        <div class="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
          <div>
            <div class="big num" data-testid="idx-price">{lq.value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })}</div>
            <div class={`num ${cls(lq.change)}`}>{lq.change > 0 ? "+" : ""}{lq.change.toFixed(2)}（{lq.changePct > 0 ? "+" : ""}{lq.changePct.toFixed(2)}%）</div>
          </div>
          <div class="muted" style={{ fontSize: "12px", textAlign: "right" }}>{lq.final ? "收盤" : `盤中 ${lq.time.slice(0, 5)}`}</div>
        </div>
      )}
      <div class="section-title"><span>走勢（日 K）</span></div>
      {err && !shown?.length && <div class="muted" data-testid="idx-err">{err}</div>}
      {!done && <div class="muted" data-testid="idx-loading" style={{ fontSize: "12px" }}>走勢圖下載中…（已有的先畫，其餘陸續補上）</div>}
      {shown && shown.length >= 2 && <CandleChart bars={shown} noVol />}
      {done && shown && shown.length < 2 && !err && <div class="muted" data-testid="idx-few">目前只累積到 {shown.length} 天的資料，之後每天打開 App 會自動增加。</div>}
      {hist && hist.kind === "close" && <div class="muted" data-testid="idx-note" style={{ fontSize: "12px", marginTop: "6px" }}>這個指數官方沒有提供歷史開高低收：K 棒的「開」用前一天收盤、「收」用當天收盤。歷史由每日排程累積（約 1 年），缺的日子手機自己補抓（證交所限制每 3 秒一次，會慢一點，抓過就存在手機裡）。</div>}
      {us && mq && <QuotePanel q={mq} bars={shown ?? []} crypto={isCryptoSymbol(name)} />}
      {hist && us && <div class="muted" data-testid="idx-note" style={{ fontSize: "12px", marginTop: "6px" }}>日 K 來自 CNBC，約近 1 年；{isCryptoSymbol(name) ? "虛擬幣 24 小時交易，每天一根（含週末），以 UTC 日期計。" : "以該市場的交易日計。"}</div>}
      {hist && name === "櫃買指數" && <div class="muted" data-testid="idx-note" style={{ fontSize: "12px", marginTop: "6px" }}>櫃買中心只提供當月資料，更早的由每日排程累積（約 1 年）。</div>}
    </Sheet>
  );
}

// ---------------- 數據頁：「數據」「新聞」兩個分頁（11/12 使用者） ----------------
export function MacroScreen() {
  // 新聞在左、數據在右（11/12 使用者）；預設打開左邊的新聞，之後記住上次看的分頁
  const [sub, setSub] = useState<"data" | "news">(() => { try { return localStorage.getItem("macroSub") === "data" ? "data" : "news"; } catch { return "news"; } });
  const pick = (v: "data" | "news") => { setSub(v); try { localStorage.setItem("macroSub", v); } catch { /* 無痕模式 */ } };
  return (
    <div>
      <div class="seg" role="tablist" style={{ marginBottom: "12px", width: "100%", gridAutoColumns: "1fr" }} data-testid="macro-tabs">
        <button role="tab" aria-pressed={sub === "news"} onClick={() => pick("news")} data-testid="macro-tab-news">新聞</button>
        <button role="tab" aria-pressed={sub === "data"} onClick={() => pick("data")} data-testid="macro-tab-data">數據</button>
      </div>
      {sub === "data" ? <DataPane /> : <NewsPane />}
    </div>
  );
}

// ---------------- 數據（國內外指標＋AI 解讀） ----------------
function DataPane() {
  const [idxOpen, setIdxOpen] = useState<string | null>(null);
  const [fngOpen, setFngOpen] = useState(false);
  const st = useStore((s) => ({ macro: s.macro, fng: s.fng, tw: s.tw, us: s.us, idx: s.twIndices, breadth: s.twBreadth, idxLive: s.twIndexLive, fut: s.futures, turnover: s.twTurnover, turnoverLive: s.twTurnoverLive, etfs: s.usSectorEtfs, apiKey: s.settings.apiKey, reports: s.reports }));
  // 台股指數盤中每 30 秒更新（收盤後 MIS 回傳收盤價，仍會顯示）
  useEffect(() => {
    refreshTwIndex(); refreshFutures(); refreshTurnover(); refreshTurnoverLive();
    const t = setInterval(() => { if (marketOpen()) refreshTwIndex(); refreshFutures(); refreshTurnover(); }, LIVE_MS);
    const t2 = setInterval(refreshTurnoverLive, 60_000); // 盤中成交金額每分鐘更新
    return () => { clearInterval(t); clearInterval(t2); };
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
  const groups = ["亞洲", "美股", "利率匯率", "原物料", "虛擬幣"] as const;

  const runAi = () => {
    if (report && !confirmRerun(1)) return;
    const top = [...st.tw.scored.slice(0, 5), ...st.us.scored.slice(0, 5)];
    startAiJob({ key, kind: "brief", title: "今日國內外數據" },
      (onProgress) => marketBrief(st.apiKey, today, st.tw.sectors, st.us.sectors, st.macro.quotes, top, onProgress));
  };

  return (
    <div>
      {fngOpen && st.fng && <FngDetail f={st.fng} onClose={() => setFngOpen(false)} />}
      {idxOpen && <IndexDetail name={idxOpen.split("|")[0]} label={idxOpen.split("|")[1]} onClose={() => setIdxOpen(null)} />}
      {liveIdx.length > 0 ? (
        <>
          <div class="section-title" data-testid="tw-index-title"><span>台股{idxFinal ? "收盤" : idxTime ? `盤中 ${idxTime}` : ""}</span></div>
          <div class="grid2">
            {liveIdx.map((i) => <div data-testid={`idx-card-${i.name}`} style={{ cursor: "pointer" }} onClick={() => setIdxOpen(i.name)}><Metric k={i.name.replace("發行量加權股價指數", "加權指數")} v={i.value.toLocaleString("zh-TW", { maximumFractionDigits: 2 })} c={cls(i.change)} d={`${i.change > 0 ? "+" : ""}${i.change.toFixed(2)}（${i.changePct > 0 ? "+" : ""}${i.changePct.toFixed(2)}%）`} /></div>)}
            {(() => {
              const w = st.idxLive["加權指數"];
              if (!w) return null;
              return <>
                {(() => {
                  // 今天官方收盤數字還沒出來前，用證交所每 5 秒成交統計的累計成交金額（上市）；下方附昨天收盤比較
                  const lv = st.turnoverLive, off = st.turnover;
                  const useLive = lv && lv.date === taipeiToday() && (!off || off.date < lv.date);
                  if (useLive) {
                    const done = lv!.time >= "13:30";
                    return <div data-testid="turnover-live"><Metric k={done ? "成交金額（今日收盤）" : "成交金額（盤中即時）"} v={`${Math.round(lv!.value / 1e8).toLocaleString("zh-TW")} 億元`} c="" d={`${done ? "13:30 收盤" : `${lv!.time.slice(0, 5)} 累計`}・上市${off ? `；${pretty(off.date)} 全日 ${Math.round(off.value / 1e8).toLocaleString("zh-TW")} 億` : ""}`} /></div>;
                  }
                  return off ? <Metric k="成交金額" v={`${Math.round(off.value / 1e8).toLocaleString("zh-TW")} 億元`} c="" d={`${pretty(off.date)} 收盤・證交所公布的全市場合計`} /> : null;
                })()}
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
        const fng = g === "虛擬幣" ? st.fng : undefined;
        if (!items.length && !fng) return null;
        return (
          <>
            <div class="section-title"><span>{g}</span></div>
            <div class="grid2">
              {items.map((m) => {
                const q = bySymbol.get(m.symbol)!;
                const card = <Metric k={m.label} v={q.last.toLocaleString("en-US", { maximumFractionDigits: 3 })} c={cls(q.change)} d={macroDelta(q)} />;
                if (!CHART_SYMBOLS.has(m.symbol)) return card;
                return <div data-testid={`idx-card-${m.symbol}`} style={{ cursor: "pointer" }} onClick={() => setIdxOpen(`${m.symbol}|${m.label}`)}>{card}</div>;
              })}
              {fng && <FngCard f={fng} onOpen={() => setFngOpen(true)} />}
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
      <div class="section-title"><span>免責聲明與授權</span></div>
      <div class="card" data-testid="settings-disclaimer"><DisclaimerText /></div>
      <div class="notice">本 App 為個人研究工具，評等由公開數據依固定規則計算，AI 解析可能有誤，不構成投資建議。投資前請自行判斷。</div>
    </div>
  );
}

export { getState };
