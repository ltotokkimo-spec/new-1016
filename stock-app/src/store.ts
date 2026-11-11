import { BOOK_INFO, type PickBook, type PickPerfFile } from "./engine/pickLog";
import { adjustReturns, type ExMap } from "./engine/exdiv";
// App 狀態：資料快照、評分結果、持股、設定。全部存在手機的 IndexedDB。
import { useEffect, useState } from "preact/hooks";
import { indexedKV, type KV } from "./lib/kv";
import { fetchJson, fetchText, postJson, type Fetcher, type TextFetcher } from "./lib/net";
import { TwLoader, TW_SNAPSHOT_VERSION, type TwSnapshot } from "./data/twLoader";
import { isEtf, parseEsbLatest, twUrls, type EsbQuote } from "./data/tw";
import { UsLoader, type UsSnapshot } from "./data/usLoader";
import { FNG_URL, parseFng, type Fng } from "./data/fng";
import { cnbcUrl, isUsSymbol, MACRO_SYMBOLS, parseCnbcQuotes, US_UNIVERSE, type MacroQuote, type UsExtra } from "./data/us";
import { indexLiveUrl, parseIndexLive, type IndexLive } from "./data/twIndexLive";
import { twTurnoverUrl, parseTurnover, twTurnoverLiveUrl, parseTurnoverLive } from "./data/twTurnover";
import { ETF_NAV_URL, parseEtfNav, type EtfNav } from "./data/etfNav";
import { TAIFEX_URL, parseTaifex, taifexBody, type FutQuote } from "./data/taifexLive";
import { scoreStocks, reviewHolding, type Holding, type HoldingView, type Scored, type SectorStat } from "./engine/score";
import { AiError, aiEtfAdvice, explainError, type AiProgress, type EtfAdviceInput, type AiReport, type OnProgress } from "./ai/claude";
import { addDays, orderDay, prettyW, taipeiToday, twNeedsRefresh, usNeedsRefresh } from "./lib/dates";
import { parseUsLive, usLiveUrl } from "./data/usLive";
import * as upd from "./lib/update";
import type { BacktestResult } from "./engine/backtest";
import type { VirtualEtf } from "./engine/virtualEtf";
import { mergeLive, parseMoneyDjHoldings, type ActiveEtfData } from "./lib/activeEtf";
import { liveUrl, parseLive, type LiveQuote } from "./data/twLive";
import { esbLiveUrl, parseEsbLive } from "./data/esb";
import { twHistory } from "./data/history";
import { parseRevenue, revenueUrls, type Revenue } from "./data/revenue";
import { emptyEtf, etfAlerts, isOffList, liquidityCut, pickCandidates, positions as etfPositions, recordNav, stopOf, valuate, type AiEtf, type EtfTrade } from "./engine/aiEtf";

// Claude 每個交易日收盤後更新的虛擬自組 ETF（存在 GitHub 分支上，App 只讀取顯示）
export const VIRTUAL_URL = "https://raw.githubusercontent.com/ltotokkimo-spec/new-1016/claude/ui-calculator-interface-t3x9kh/stock-app/virtual/v-2wy3g7efad1c.json";
// N5 觀察組合（0050 五成＋方案 A 五成）：每天回測工作流程跑完後發布，同樣的格式
export const WATCH_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/n5.json";
export const WIDE_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/wide.json"; // 全個股觀察組合
export const REGIME_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/regime.json"; // 攻守輪動觀察組合
export const ACTIVE_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/active-etf.json"; // 主動式 ETF 個股買賣超
export const AI_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/ai.json"; // AI 供應鏈觀察組合
// 推薦績效追蹤（每天收盤後更新）：台股、ETF、美股各一份
const RADAR_DATA = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/";
export const picksUrl = (b: PickBook) => RADAR_DATA + BOOK_INFO[b].files.perf;
export const picksCsvUrl = (b: PickBook) => RADAR_DATA + BOOK_INFO[b].files.csv;
export interface ExFile { version: 1; asOf: string; from: string; source: string; ev: ExMap }
export type PicksPerfEntry = { data: PickPerfFile; fetchedAt: number; error?: string };
const ppKey = (b: PickBook) => (b === "TW" ? "picksPerf" : `picksPerf:${b}`); // 台股沿用 1.0.283 的鍵
export const TURN_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/turn.json"; // 剛轉強觀察組合
export const RULE_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/real.json"; // 實單規則觀察組合（「我的實單」的選股規則）
export const LEAD_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/lead.json"; // 權值強化觀察組合
export const STEADY_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/steady.json"; // 觀察組合規則的 2 年回測結果
export const BACKTEST_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/radar-data-vug13iw701/backtest.json";

/** steady.json 裡總評比用到的欄位 */
export interface SteadyLite { from: string; to: string; strategies: { key: string; label: string; cagr: number; maxDd: number; sharpe: number; vol: number }[] }

export type Market = "TW" | "ETF" | "US";

export interface MarketState {
  status: "idle" | "loading" | "ready" | "error";
  progress?: { done: number; total: number; label: string };
  error?: string;
  warning?: string;
  asOf?: string;
  scored: Scored[];
  sectors: SectorStat[];
  fetchedAt?: number;
  flowDate?: string; // 三大法人最新資料日（台股／ETF）
}

export interface Settings {
  apiKey: string;
  balance?: { usd: number; at: number }; // 使用者從官網抄下來的餘額與時間
}

/** 估計剩餘額度＝使用者填的餘額 − 填寫之後這支手機的花費 */
export function estimatedBalance(s: State = state): number | undefined {
  const b = s.settings.balance;
  if (!b) return undefined;
  return b.usd - s.spend.filter((x) => x.at > b.at).reduce((a, x) => a + x.usd, 0);
}

export interface State {
  tw: MarketState;
  etf: MarketState; // 台股 ETF（和個股分開評分，跟台股一起下載）
  us: MarketState;
  esb: Record<string, true>; // 興櫃股票代號
  twIndices: TwSnapshot["indices"];
  twBreadth?: TwSnapshot["breadth"]; // 收盤漲跌家數
  usSectorEtfs: UsSnapshot["sectorEtfs"];
  macro: { status: "idle" | "loading" | "ready" | "error"; quotes: MacroQuote[]; error?: string; at?: number };
  fng?: Fng; // 虛擬幣恐懼貪婪指數
  twIndexLive: Record<string, IndexLive>; // 台股指數盤中即時（證交所 MIS）
  etfNav: Record<string, EtfNav>; // ETF 即時預估淨值與折溢價（證交所，詳情頁用）
  etfNavAt?: number;
  twTurnover?: { date: string; value: number; at: number }; // 最新交易日大盤成交金額（元，證交所「每日市場成交資訊」官方數字）
  twTurnoverLive?: { date: string; time: string; value: number; at: number }; // 盤中即時累計成交金額（元，證交所每 5 秒委託成交統計，上市）
  futures: { day?: FutQuote; night?: FutQuote; at?: number }; // 台指期近月日盤與夜盤（期交所 MIS）
  holdings: Holding[];
  settings: Settings;
  reports: Record<string, AiReport>; // key: "stock:2330:20261016" / "brief:20261016"
  prices: Record<string, { name: string; close: number }>;
  update: {
    status: "idle" | "checking" | "ready" | "error" | "downloading" | "installing" | "needPermission";
    info?: upd.UpdateInfo; error?: string; done?: number; total?: number;
  };
  spend: { at: number; usd: number; kind: string }[]; // 這支手機呼叫 Claude 的實際花費紀錄
  backtest?: { data: BacktestResult; fetchedAt: number };
  virtual?: { data: VirtualEtf; fetchedAt: number; error?: string };
  watch?: { data: VirtualEtf; fetchedAt: number; error?: string };
  wide?: { data: VirtualEtf; fetchedAt: number; error?: string };
  regime?: { data: VirtualEtf; fetchedAt: number; error?: string };
  lead?: { data: VirtualEtf; fetchedAt: number; error?: string };
  ai?: { data: VirtualEtf; fetchedAt: number; error?: string };
  rule?: { data: VirtualEtf; fetchedAt: number; error?: string }; // 實單規則觀察組合
  turn?: { data: VirtualEtf; fetchedAt: number; error?: string }; // 剛轉強觀察組合
  picksPerf: Partial<Record<PickBook, PicksPerfEntry>>; // 推薦績效追蹤（台股、ETF、美股）
  exdiv?: { data: ExFile; fetchedAt: number }; // 除權息事件（雲端每天整理）：評分還原除權息、ETF 配息資訊
  activeEtf?: { data: ActiveEtfData; fetchedAt: number; error?: string; liveAt?: number; liveProgress?: { done: number; total: number }; liveFound?: number; liveHoldings?: { code: string; name: string; date: string; shares: Record<string, number> }[] };
  steady?: { data: SteadyLite; fetchedAt: number };
  live: Record<string, LiveQuote>; // 證交所即時報價（盤中每 30 秒更新）
  liveAt?: number;
  liveError?: string; // 最近一次台股即時價抓取失敗的原因（成功就清掉）
  usExtra: UsExtra[]; // 使用者自己加的美股
  usPending: string[]; // 正在下載的美股持股代號
  usNotFound: string[]; // Nasdaq 查不到的代號
  aiJobs: Record<string, AiJob>; // 背景執行中／剛完成的 Claude 解析（key 同 reports）
  aiEtf: AiEtf; // 自組 ETF（照 Claude 建議實際買進）
  usLookup?: { symbol: string; status: "loading" | "notfound" | "error"; error?: string };
  loaded: boolean;
}

const empty = (): MarketState => ({ status: "idle", scored: [], sectors: [] });
const starting = (): MarketState => ({ status: "loading", scored: [], sectors: [], progress: { done: 0, total: 1, label: "讀取手機裡的資料" } });

let state: State = {
  tw: starting(), etf: starting(), us: starting(), esb: {}, twIndices: [], usSectorEtfs: [],
  macro: { status: "idle", quotes: [] }, twIndexLive: {}, futures: {}, etfNav: {}, holdings: [], settings: { apiKey: "" }, reports: {}, prices: {}, spend: [], update: { status: "idle" }, usExtra: [], usPending: [], usNotFound: [], aiJobs: {}, aiEtf: emptyEtf(), live: {}, picksPerf: {}, loaded: false,
};
const listeners = new Set<() => void>();

export function getState() { return state; }
function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useStore<T>(pick: (s: State) => T): T {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return pick(state);
}

let kv: KV = indexedKV();
let fetcher: Fetcher = fetchJson;
/** 測試用：換掉儲存與網路 */
export function _inject(k: KV, f: Fetcher) { kv = k; fetcher = f; }

/** 雲端資料（GitHub Releases）下載：偶爾逾時或 5xx，失敗時等一下再試，最多 3 次（11/9 CI 連續遇到回測、配息資料下載不到） */
async function fetchData(url: string): Promise<any> {
  for (let i = 0; ; i++) {
    try { return await fetcher(`${url}?t=${Date.now()}`); }
    catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, (i + 1) * 4000)); }
  }
}
/** 測試用：直接改狀態 */
export function _setState(p: Partial<State>) { set(p); }
let textFetcher: TextFetcher = fetchText;
export function _injectText(f: TextFetcher) { textFetcher = f; }

const timings: Record<string, number> = ((globalThis as any).__srTimings = {});
const mark = (k: string) => { timings[k] = Math.round(performance.now()); };

export async function init() {
  try { await initInner(); }
  catch (e) {
    // 手機的儲存空間讀不出來也要讓 App 能用（空資料），不能永遠停在「讀取手機裡的資料」
    console.error("init 失敗", e);
    set({ loaded: true });
    autoRefresh();
  }
}

async function initInner() {
  mark("init");
  const [holdings, settings, reports, twSnap0, usSnap, spend, esbSnap] = await Promise.all([
    kv.get<Holding[]>("holdings"), kv.get<Settings>("settings"), kv.get<Record<string, AiReport>>("reports"),
    kv.get<TwSnapshot>("snap:tw"), kv.get<UsSnapshot>("snap:us"), kv.get<State["spend"]>("spend"),
    kv.get<EsbSnapshot>("snap:esb"),
  ]);
  set({ usExtra: (await kv.get<UsExtra[]>("usExtra")) ?? [], aiEtf: (await kv.get<AiEtf>("aiEtf")) ?? emptyEtf(), fng: (await kv.get<Fng>("fng")) ?? undefined });
  const vt = await kv.get<State["virtual"]>("virtual");
  if (vt) set({ virtual: vt });
  const wt = await kv.get<State["watch"]>("watch");
  if (wt) set({ watch: wt });
  const wd = await kv.get<State["wide"]>("wide");
  if (wd) set({ wide: wd });
  const rg = await kv.get<State["regime"]>("regime");
  if (rg) set({ regime: rg });
  const ld = await kv.get<State["lead"]>("lead");
  if (ld) set({ lead: ld });
  const ae = await kv.get<State["activeEtf"]>("activeEtf");
  if (ae) set({ activeEtf: ae });
  const ai0 = await kv.get<State["ai"]>("ai");
  if (ai0) set({ ai: ai0 });
  const rule0 = await kv.get<State["rule"]>("rule");
  if (rule0) set({ rule: rule0 });
  const turn0 = await kv.get<State["turn"]>("turn");
  if (turn0) set({ turn: turn0 });
  for (const b of ["TW", "ETF", "US"] as PickBook[]) {
    const pp0 = await kv.get<PicksPerfEntry>(ppKey(b));
    if (pp0) set({ picksPerf: { ...state.picksPerf, [b]: pp0 } });
  }
  const sd = await kv.get<State["steady"]>("steady");
  if (sd) set({ steady: sd });
  const bt = await kv.get<State["backtest"]>("backtest");
  if (bt) set({ backtest: bt });
  const ex0 = await kv.get<State["exdiv"]>("exdiv");
  if (ex0) set({ exdiv: ex0 });
  // 舊版快照沒有 ETF，直接當作沒有資料重抓
  const twSnap = twSnap0?.version === TW_SNAPSHOT_VERSION ? twSnap0 : undefined;
  mark("kvRead");
  set({ holdings: holdings ?? [], settings: settings ?? { apiKey: "" }, reports: reports ?? {}, spend: spend ?? [], loaded: true });
  if (twSnap) applyTw(twSnap);
  if (usSnap) applyUs(usSnap);
  if (esbSnap) applyEsb(esbSnap);
  esbFetchedAt = esbSnap?.fetchedAt;
  autoRefresh();
  if (upd.isNative()) checkForUpdate();
}

let esbFetchedAt: number | undefined;
let lastAuto = 0;

/**
 * 開 App 或從背景切回來時：資料過時就自動重抓（快取會讓已下載的日子不重抓）。
 * 台股：沒資料、不是今天抓的、超過 3 小時，或 16:30 後但資料是 16:30 前抓的（當天評分已公布）。
 * 美股：紐約 17:00（台北清晨）後還沒抓過當天收盤就重抓。
 */
export function autoRefresh() {
  if (Date.now() - lastAuto < 60_000) return; // 一分鐘內切來切去不重複檢查
  lastAuto = Date.now();
  if (twNeedsRefresh(state.tw.fetchedAt)) refreshTw();
  if (usNeedsRefresh(state.us.fetchedAt, Date.now(), state.us.asOf)) refreshUs();
  else ensureUsHoldings(); // 今天的美股已下載過，但持股裡可能有還沒下載的代號
  if (twNeedsRefresh(esbFetchedAt)) refreshEsb();
  refreshMacro(); refreshTwIndex(); refreshFutures(); refreshTurnover();
  if (!state.virtual || Date.now() - state.virtual.fetchedAt > 10 * 60_000) refreshVirtual();
  if (!state.backtest || Date.now() - state.backtest.fetchedAt > 6 * 3600_000) refreshBacktest();
  if (!state.exdiv || Date.now() - state.exdiv.fetchedAt > 6 * 3600_000) refreshExdiv();
}

function pricesOf(stocks: { code: string; name: string; close: number }[]) {
  const out: State["prices"] = { ...state.prices };
  for (const x of stocks) out[x.code] = { name: x.name, close: x.close };
  return out;
}

let lastTwSnap: TwSnapshot | undefined;
function applyTw(snap: TwSnapshot) {
  lastTwSnap = snap;
  // 近 1 週／1 月／3 月漲跌幅還原除權息（除息不算成下跌；11/9 加）。除權息資料還沒下載到就先用原始收盤，下載到後重算
  const stocks = snap.ref ? adjustReturns(snap.stocks, state.exdiv?.data.ev, snap.ref, snap.asOf) : snap.stocks;
  const common = stocks.filter((x) => !isEtf(x.code));
  const etfs = stocks.filter((x) => isEtf(x.code));
  const a = scoreStocks(common), b = scoreStocks(etfs);
  const meta = { status: "ready" as const, asOf: snap.asOf, fetchedAt: snap.fetchedAt, flowDate: snap.dates?.[0] };
  set({ prices: pricesOf(snap.stocks) });
  // ETF 回測顯示規則分辨不出好壞，只給分數當參考，不給買入／觀望／離場
  const etfScored = b.scored.map((x) => ({ ...x, refOnly: true }));
  set({ tw: { ...meta, scored: a.scored, sectors: a.sectors }, etf: { ...meta, scored: etfScored, sectors: b.sectors }, twIndices: snap.indices, twBreadth: snap.breadth });
  void snapshotEtfNav(snap.asOf);
  scheduleHistoryPrefetch();
}

/**
 * K 線預載：持股和評分最高的「買入」幾檔，在背景先把日 K 的月資料下載好存在手機裡，之後打開圖表就是即時的。
 * 慢慢下載（證交所每 3 秒一次）、使用者正在看圖時會讓路；每個交易日每檔只做一次。
 */
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
let prefetchedKey = "";
let prefetching = false;
function scheduleHistoryPrefetch() {
  if (prefetchTimer || prefetching) return;
  prefetchTimer = setTimeout(() => { prefetchTimer = undefined; void runHistoryPrefetch(); }, 30_000);
}
export async function runHistoryPrefetch() {
  const asOf = state.tw.asOf;
  if (!asOf || prefetching) return;
  const list: { code: string; market: "TWSE" | "TPEX" }[] = [];
  const seen = new Set<string>();
  const add = (code: string, market: string) => { if ((market === "TWSE" || market === "TPEX") && !seen.has(code) && !state.esb[code]) { seen.add(code); list.push({ code, market }); } };
  for (const h of state.holdings) add(h.code, h.market);
  [...state.tw.scored].filter((x) => x.rating === "買入").sort((x, y) => y.score - x.score).slice(0, 10).forEach((x) => add(x.code, x.market));
  const key = `${asOf}:${list.map((x) => x.code).join(",")}`;
  if (!list.length || key === prefetchedKey) return;
  prefetching = true;
  try {
    for (const x of list) {
      try { await twHistory(fetcher, kv, x.code, x.market, 6, Date.now(), undefined, true); } catch { /* 預載失敗不影響，打開圖表時再下載 */ }
    }
    prefetchedKey = key;
  } finally { prefetching = false; }
}

interface EsbSnapshot { quotes: EsbQuote[]; fetchedAt: number }

function applyEsb(snap: EsbSnapshot) {
  const esb: State["esb"] = {};
  for (const q of snap.quotes) esb[q.code] = true;
  // 上市櫃的價格優先，興櫃只補沒有的代號
  const prices = { ...state.prices };
  for (const q of snap.quotes) if (!prices[q.code]) prices[q.code] = { name: q.name, close: q.close };
  set({ esb, prices });
}

export async function refreshEsb() {
  try {
    const quotes = parseEsbLatest(await fetcher(twUrls.esbLatest()));
    if (!quotes.length) return;
    const snap = { quotes, fetchedAt: Date.now() };
    esbFetchedAt = snap.fetchedAt;
    await kv.set("snap:esb", snap);
    applyEsb(snap);
  } catch { /* 興櫃只是補充報價，失敗時沿用上次的資料 */ }
}

/** 一定要評分的美股：自己加的＋持股裡的 */
const usKeep = () => new Set([...state.usExtra.map((x) => x.symbol), ...state.holdings.filter((h) => h.market === "US").map((h) => h.code)]);

function applyUs(snap: UsSnapshot) {
  const { scored, sectors } = scoreStocks(snap.stocks, usKeep());
  set({ prices: pricesOf(snap.stocks) });
  const warning = snap.failed?.length ? `${snap.failed.join("、")} 這次下載失敗，按右上角重新整理可重試` : undefined;
  set({ us: { status: "ready", scored, sectors, asOf: snap.asOf, fetchedAt: snap.fetchedAt, warning }, usSectorEtfs: snap.sectorEtfs });
}

let twBusy = false;

export async function refreshTw() {
  if (twBusy) return;
  twBusy = true;
  const start = (m: MarketState): MarketState => ({ ...m, status: m.scored.length ? "ready" : "loading", progress: { done: 0, total: 1, label: "準備中" }, error: undefined });
  set({ tw: start(state.tw), etf: start(state.etf) });
  try {
    mark("twStart");
    const snap = await new TwLoader(fetcher, kv).load((done, total, label) => {
      if (!timings.twFirstProgress) mark("twFirstProgress");
      set({ tw: { ...state.tw, progress: { done, total, label } }, etf: { ...state.etf, progress: { done, total, label } } });
    });
    mark("twDone");
    await kv.set("snap:tw", snap);
    applyTw(snap);
  } catch (e: any) {
    const fail = (m: MarketState): MarketState => ({ ...m, status: m.scored.length ? "ready" : "error", error: `台股資料更新失敗：${e?.message ?? e}`, progress: undefined });
    set({ tw: fail(state.tw), etf: fail(state.etf) });
  } finally { twBusy = false; }
}

let usRun: Promise<void> | null = null, usQueued: Promise<void> | null = null;
/** 正在更新時再呼叫，會排一次在後面（例如剛加了一檔美股），回傳的 Promise 等到包含它的那次更新完成 */
export function refreshUs(): Promise<void> {
  if (usRun) return (usQueued ??= usRun.then(() => { usQueued = null; return refreshUs(); }));
  usRun = doRefreshUs().finally(() => { usRun = null; });
  return usRun;
}

async function doRefreshUs() {
  const prev = state.us;
  set({ us: { ...prev, status: prev.scored.length ? "ready" : "loading", progress: { done: 0, total: 1, label: "準備中" }, error: undefined } });
  try {
    const loader = new UsLoader(fetcher, kv);
    // 持股裡有、但清單沒有的美股，先查出名稱與產業再一起下載
    const known = new Set([...US_UNIVERSE.map((u) => u.symbol), ...state.usExtra.map((x) => x.symbol)]);
    const todo = [...new Set(state.holdings.filter((h) => h.market === "US" && !known.has(h.code) && isUsSymbol(h.code)).map((h) => h.code))];
    set({ usPending: todo });
    for (const code of todo) {
      const x = await loader.lookup(code).catch(() => undefined);
      if (x) await saveUsExtra([...state.usExtra, x]);
      else if (x === null) set({ usNotFound: [...new Set([...state.usNotFound, code])] }); // null＝確定查不到；undefined＝網路錯誤，下次再試
      set({ usPending: state.usPending.filter((c) => c !== code) });
    }
    const snap = await loader.load((done, total, label) =>
      set({ us: { ...state.us, progress: { done, total, label } } }), state.usExtra);
    const { bars, ...rest } = snap; // 日K 很大，快照只存計算結果
    await kv.set("snap:us", { ...rest, bars: {} });
    await kv.set("us:bars", bars);
    applyUs(snap);
  } catch (e: any) {
    set({ usPending: [], us: { ...state.us, status: state.us.scored.length ? "ready" : "error", error: `美股資料更新失敗：${e?.message ?? e}`, progress: undefined } });
  }
}

/** 台股指數盤中即時（加權、台灣50、半導體類、金融保險類…）；抓不到就沿用快照的收盤 */
export async function refreshTwIndex() {
  try {
    const got = parseIndexLive(await fetcher(indexLiveUrl()));
    if (Object.keys(got).length) set({ twIndexLive: { ...state.twIndexLive, ...got } });
  } catch { /* 盤中即時只是輔助 */ }
}

/** ETF 即時預估淨值與折溢價：全部 ETF 一次下載；20 秒內不重複抓，失敗就沿用上次的 */
export async function refreshEtfNav() {
  if (state.etfNavAt && Date.now() - state.etfNavAt < 20_000) return;
  try {
    const got = parseEtfNav(await fetcher(ETF_NAV_URL));
    if (Object.keys(got).length) set({ etfNav: got, etfNavAt: Date.now() });
  } catch { /* 折溢價只是輔助 */ }
}

/** 大盤成交金額：證交所每日市場成交資訊（本月，月初還沒有資料就看上個月）；5 分鐘內不重複抓 */
export async function refreshTurnover() {
  if (state.twTurnover && Date.now() - state.twTurnover.at < 5 * 60_000) return;
  try {
    const today = taipeiToday();
    let t = parseTurnover(await fetcher(twTurnoverUrl(today)));
    if (!t) t = parseTurnover(await fetcher(twTurnoverUrl(addDays(`${today.slice(0, 6)}01`, -1))));
    if (t) set({ twTurnover: { ...t, at: Date.now() } });
  } catch { /* 成交金額只是輔助，抓不到就不顯示或沿用舊的 */ }
}

/** 盤中即時成交金額：開盤到收盤後 1 小時（官方每日資料出來前）每分鐘最多抓一次 */
export async function refreshTurnoverLive() {
  const now = Date.now(), d = new Date(now + 8 * 3600e3), m = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  if (wd === 0 || wd === 6 || m < 9 * 60 || m > 14 * 60 + 30) return;
  if (state.twTurnoverLive && now - state.twTurnoverLive.at < 55_000) return;
  try {
    const t = parseTurnoverLive(await fetcher(twTurnoverLiveUrl()));
    if (t) set({ twTurnoverLive: { ...t, date: t.date || taipeiToday(), at: now } });
  } catch { /* 只是輔助 */ }
}

/** 台指期近月：日盤與夜盤各抓一次，其中一個失敗不影響另一個 */
export async function refreshFutures() {
  const [day, night] = await Promise.all((["day", "night"] as const).map(async (k) => {
    try { return parseTaifex(await postJson(TAIFEX_URL, taifexBody(k)), k); } catch { return undefined; }
  }));
  // 日盤要到 08:45 開盤才有成交價，開盤前期交所回空的：沿用上一個日盤（記在手機上，重開 App 也在），畫面標「10/28 收盤」
  let keepDay = day;
  if (day && !day.settleOnly) kv.set("futDay", day).catch(() => {});
  else {
    // 還沒開盤：優先用上一個真正的日盤（有收盤價與漲跌），沒有才用期交所給的前一交易日結算價
    const prev = [state.futures.day, await kv.get<FutQuote>("futDay").catch(() => undefined)].find((x) => x && !x.settleOnly);
    keepDay = prev ?? day;
  }
  if (keepDay || night) set({ futures: { day: keepDay, night: night ?? state.futures.night, at: Date.now() } });
}

/** 虛擬幣恐懼貪婪指數：失敗就沿用上次的（不影響其他國際指標） */
async function refreshFng() {
  try {
    const f = parseFng(await fetcher(`${FNG_URL}&t=${Date.now()}`));
    if (f) { set({ fng: f }); await kv.set("fng", f); }
  } catch { /* 留著上次的 */ }
}

export async function refreshMacro() {
  void refreshFng();
  set({ macro: { ...state.macro, status: state.macro.quotes.length ? "ready" : "loading", error: undefined } });
  try {
    const quotes = parseCnbcQuotes(await fetcher(cnbcUrl(MACRO_SYMBOLS.map((m) => m.symbol))));
    if (!quotes.length) throw new Error("沒有取得報價");
    set({ macro: { status: "ready", quotes, at: Date.now() } });
  } catch (e: any) {
    set({ macro: { ...state.macro, status: state.macro.quotes.length ? "ready" : "error", error: `國際指標更新失敗：${e?.message ?? e}` } });
  }
}

export function findScored(code: string, market?: Market): Scored | undefined {
  // "TW" 代表台灣上市櫃，個股與 ETF 都找
  const lists = market === "US" ? [state.us.scored] : market === "TW" || market === "ETF" ? [state.tw.scored, state.etf.scored] : [state.tw.scored, state.etf.scored, state.us.scored];
  for (const l of lists) { const s = l.find((x) => x.code === code); if (s) return s; }
  return undefined;
}

/** 持股檢視；hs 預設全部持股（持股頁依券商分頁、統計頁合併後再傳進來） */
export function holdingViews(hs: Holding[] = state.holdings): HoldingView[] {
  return hs.map((h) => {
    const m = h.market === "US" ? state.us : isEtf(h.code) ? state.etf : state.tw;
    const esb = h.market !== "US" && !!state.esb[h.code];
    const v = reviewHolding(h, findScored(h.code, h.market === "US" ? "US" : "TW"), state.prices[h.code]?.close, { esb });
    if (v.scored && v.name === v.code) v.name = v.scored.name; // 自己加的美股，下載後換成公司名稱
    if (h.market === "US" && !v.scored && state.usPending.includes(h.code)) v.advice = ["正在從 Nasdaq 下載這檔美股…"];
    else if (h.market === "US" && !v.scored && state.usNotFound.includes(h.code)) v.advice = ["Nasdaq 查不到這個代號，請確認是否正確"];
    else if (h.market === "US" && !v.scored && Number.isFinite(v.price)) v.advice = ["上市時間短、資料還不夠評分，先只計算損益"];
    else if (!v.scored && !Number.isFinite(v.price) && m.status !== "ready") v.advice = [m.status === "error" ? "行情下載失敗" : "行情載入中…"];
    return v;
  });
}

export async function saveHoldings(holdings: Holding[]) {
  set({ holdings });
  await kv.set("holdings", holdings);
  ensureUsHoldings(); // 照片匯入、手動新增都一樣：清單外的美股自動下載
}

/** 持股裡有、但還沒下載的美股代號 */
function missingUsHoldings(): string[] {
  const known = new Set([...US_UNIVERSE.map((u) => u.symbol), ...state.usExtra.map((x) => x.symbol), ...state.us.scored.map((x) => x.code)]);
  return [...new Set(state.holdings.filter((h) => h.market === "US" && isUsSymbol(h.code) && !known.has(h.code) && !state.usNotFound.includes(h.code)).map((h) => h.code))];
}

export function ensureUsHoldings(): Promise<void> {
  return missingUsHoldings().length ? refreshUs() : Promise.resolve();
}

export async function saveSettings(settings: Settings) {
  set({ settings });
  await kv.set("settings", settings);
}

const spendKind = (key: string) => (key.startsWith("brief") ? "數據解讀" : key.startsWith("aietfpro") ? "Claude App" : key.startsWith("aietf") ? "自組ETF建議" : "個股解析");

export async function recordSpend(usd: number | undefined, kind: string) {
  if (usd === undefined || !Number.isFinite(usd)) return;
  const spend = [...state.spend, { at: Date.now(), usd, kind }].slice(-2000);
  set({ spend });
  await kv.set("spend", spend);
}

export async function saveReport(key: string, report: AiReport) {
  await recordSpend(report.costUsd, spendKind(key));
  const reports = { ...state.reports, [key]: report };
  // 只留最近 40 份
  const keys = Object.keys(reports).sort((a, b) => reports[b].at - reports[a].at);
  for (const k of keys.slice(40)) delete reports[k];
  set({ reports });
  await kv.set("reports", reports);
}

export async function usBars(symbol: string) {
  const all = await kv.get<Record<string, any[]>>("us:bars");
  return all?.[symbol] ?? [];
}

export function getKv() { return kv; }
export function getFetcher() { return fetcher; }

export async function clearCache() {
  for (const k of await kv.keys()) if (/^(tw2?|us|snap):/.test(k)) await kv.del(k);
  set({ tw: empty(), etf: empty(), us: empty() });
  refreshTw(); refreshUs(); refreshEsb();
}

// ---------- App 內更新 ----------
export async function checkForUpdate() {
  set({ update: { ...state.update, status: "checking", error: undefined } });
  // GitHub 偶爾回 5xx（11/9 使用者看到 HTTP 504）：等一下自動再試，最多 3 次
  let err: any;
  for (let i = 0; i < 3; i++) {
    try { set({ update: { status: "ready", info: await upd.checkUpdate() } }); return; }
    catch (e: any) { err = e; if (i < 2) await new Promise((r) => setTimeout(r, (i + 1) * 3000)); }
  }
  const current = await upd.currentVersion().catch(() => undefined);
  const msg = String(err?.message ?? err);
  const busy = /HTTP 5\d\d|timeout|逾時|Failed to fetch|Network/i.test(msg);
  set({ update: { status: "error", info: { current, available: false }, error: busy ? `GitHub 暫時沒回應（${msg}），不是 App 的問題，等幾分鐘再按「檢查更新」` : `檢查更新失敗：${msg}` } });
}

export async function installUpdate() {
  const info = state.update.info;
  if (!(await upd.canInstall())) {
    set({ update: { status: "needPermission", info } });
    await upd.openInstallSettings();
    return;
  }
  set({ update: { status: "downloading", info, done: 0, total: 0 } });
  try {
    await upd.downloadAndInstall((done, total) => set({ update: { status: "downloading", info, done, total } }));
    set({ update: { status: "installing", info } });
  } catch (e: any) {
    set({ update: { status: "error", info, error: `下載更新失敗：${e?.message ?? e}` } });
  }
}

/** 自動測試用：假裝有新版，測試下載與安裝流程（手機上一般不會用到） */
(globalThis as any).__srForceUpdate = () =>
  set({ update: { status: "ready", info: { current: state.update.info?.current, latest: { versionCode: 999999, versionName: "測試版", notes: "測試下載流程" }, available: true } } });

// ---------- 回測結果（GitHub Actions 算好，App 只下載） ----------
/** 抓幾檔的即時報價（失敗就保留上次的） */
/** 即時資料盤中更新間隔（毫秒）：30 秒（10/28 試過 10 秒，證交所資料本身約 30～60 秒才更新，使用者改回 30 秒） */
export const LIVE_MS = 30_000;
const liveBusy = { tw: false, us: false };
/** 即時價的單一請求最多等這麼久；證交所沒回應時不要卡著（原本最久會等 4～5 分鐘，這段時間整個更新都停住、畫面也沒有任何提示） */
const LIVE_FETCH_MS = 15_000;
const LIVE_RETRY_MS = 4_000;
const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> => {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error("連線逾時")), ms); })]).finally(() => clearTimeout(t));
};
// 上一次還沒抓完時，新的要求先排隊，前一個一結束就補抓（合併成一次）；持股（priority）排在前面，
// 前一個還有幾批沒抓時也會先停下來處理持股。以前是直接略過：開 App 時選股頁正在抓 60 檔，切到持股頁的要求被丟掉，要等 30 秒才有即時價。
let liveQueue: { codes: Set<string>; esb: Set<string>; hi: Set<string> } | null = null;
let liveWait: ReturnType<typeof setInterval> | undefined;
export async function refreshLive(codes: string[], esbHint: string[] = [], priority = false, retry = 0) {
  const list = [...new Set(codes.filter((c) => /^[0-9A-Z]{4,6}$/.test(c)))];
  if (!list.length) return;
  // 第一次下載台股資料時（還沒有任何評分）先不抓即時價：證交所會把同一個 IP 太頻繁的請求封鎖（請求一直不回應），
  // 即時價每 30 秒 3 批再加上三大法人逐日下載，常卡在「下載中：三大法人」好幾分鐘。先排隊，下載完再一次補抓。
  if (state.tw.status === "loading" && !state.tw.scored.length) {
    const q = (liveQueue ??= { codes: new Set(), esb: new Set(), hi: new Set() });
    list.forEach((c) => { q.codes.add(c); if (priority) q.hi.add(c); });
    esbHint.forEach((c) => q.esb.add(c));
    liveWait ??= setInterval(() => {
      if (state.tw.status === "loading" && !state.tw.scored.length) return;
      clearInterval(liveWait!); liveWait = undefined;
      const next = liveQueue; liveQueue = null;
      if (next && !liveBusy.tw) void refreshLive([...next.hi, ...[...next.codes].filter((c) => !next.hi.has(c))], [...next.esb], true);
      else if (next) liveQueue = next;
    }, 2000);
    return;
  }
  if (liveBusy.tw) {
    const q = (liveQueue ??= { codes: new Set(), esb: new Set(), hi: new Set() });
    list.forEach((c) => { q.codes.add(c); if (priority) q.hi.add(c); });
    esbHint.forEach((c) => q.esb.add(c));
    return;
  }
  liveBusy.tw = true;
  let failed = false;
  try {
    const got: Record<string, LiveQuote> = {};
    for (let i = 0; i < list.length; i += 20) {
      try {
        Object.assign(got, parseLive(await withTimeout(fetcher(liveUrl(list.slice(i, i + 20))), LIVE_FETCH_MS)));
        set({ live: { ...state.live, ...got }, liveAt: Date.now(), liveError: undefined }); // 每一批抓到就先存，不要等全部批次
      } catch (e: any) {
        failed = true;
        set({ liveError: String(e?.message ?? e).slice(0, 60) });
        break;
      }
      if (liveQueue?.hi.size && i + 20 < list.length) { list.slice(i + 20).forEach((c) => liveQueue!.codes.add(c)); break; } // 持股在排隊：先處理它，剩下的稍後
    }
    // 興櫃：證交所查不到，改用櫃買中心每分鐘更新的當日行情表（一次下載全部，只取需要的代號）
    const esbCodes = failed ? [] : list.filter((c) => (state.esb[c] || esbHint.includes(c)) && !got[c]); // esbHint：詳情頁已知是興櫃，不用等興櫃名單下載完
    if (esbCodes.length) {
      try { const all = parseEsbLive(await withTimeout(fetcher(esbLiveUrl()), LIVE_FETCH_MS)); for (const c of esbCodes) if (all[c]) got[c] = all[c]; set({ live: { ...state.live, ...got }, liveAt: Date.now() }); } catch { /* 興櫃抓不到就沿用收盤價 */ }
    }
  } finally {
    liveBusy.tw = false;
    const next = liveQueue; liveQueue = null;
    if (next) void refreshLive([...next.hi, ...[...next.codes].filter((c) => !next.hi.has(c))], [...next.esb], false);
    else if (failed && retry < 2) setTimeout(() => void refreshLive(list, esbHint, priority, retry + 1), LIVE_RETRY_MS); // 失敗：幾秒後自動再試，不要等下一個 30 秒
  }
}

/** 美股即時報價（CNBC）：盤中最新價、收盤後收盤價，附盤前／盤後成交 */
export async function refreshUsLive(symbols: string[]) {
  const list = [...new Set(symbols.filter((c) => /^[A-Z][A-Z.\-]{0,9}$/.test(c)))];
  if (!list.length || liveBusy.us) return;
  liveBusy.us = true;
  try {
    const got: Record<string, LiveQuote> = {};
    for (let i = 0; i < list.length; i += 20) Object.assign(got, parseUsLive(await fetcher(usLiveUrl(list.slice(i, i + 20)))));
    set({ live: { ...state.live, ...got }, liveAt: Date.now() });
  } catch { /* 抓不到就顯示最近收盤 */ }
  finally { liveBusy.us = false; }
}

/** 下載 Claude 的虛擬自組 ETF；失敗就沿用上次下載的 */
export async function refreshVirtual() {
  try {
    const data = (await fetchData(VIRTUAL_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("virtual", v);
    set({ virtual: v });
  } catch (e) {
    if (state.virtual) set({ virtual: { ...state.virtual, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ virtual: undefined });
  }
}

/** 下載 N5 觀察組合；失敗就沿用上次下載的 */
export async function refreshWatch() {
  try {
    const data = (await fetchData(WATCH_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("watch", v);
    set({ watch: v });
  } catch {
    if (state.watch) set({ watch: { ...state.watch, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ watch: undefined });
  }
}

/** 下載全個股觀察組合；失敗就沿用上次下載的 */
export async function refreshWide() {
  try {
    const data = (await fetchData(WIDE_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("wide", v);
    set({ wide: v });
  } catch {
    if (state.wide) set({ wide: { ...state.wide, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ wide: undefined });
  }
}

/** 下載攻守輪動觀察組合；失敗就沿用上次下載的 */
export async function refreshRegime() {
  try {
    const data = (await fetchData(REGIME_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("regime", v);
    set({ regime: v });
  } catch {
    if (state.regime) set({ regime: { ...state.regime, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ regime: undefined });
  }
}

/** 下載權值強化觀察組合；失敗就沿用上次下載的 */
export async function refreshLead() {
  try {
    const data = (await fetchData(LEAD_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("lead", v);
    set({ lead: v });
  } catch {
    if (state.lead) set({ lead: { ...state.lead, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ lead: undefined });
  }
}

/** 下載剛轉強觀察組合（規則自動算，每天收盤後更新）；失敗就沿用上次下載的 */
/** 下載推薦績效追蹤（雲端每天收盤後更新）；失敗就沿用上次下載的 */
export async function refreshPicksPerf(b: PickBook = "TW") {
  try {
    const data = (await fetchData(picksUrl(b))) as PickPerfFile;
    if (data?.version !== 1 || !Array.isArray(data.rows)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set(ppKey(b), v);
    set({ picksPerf: { ...state.picksPerf, [b]: v } });
  } catch (e: any) {
    const old = state.picksPerf[b];
    if (old) set({ picksPerf: { ...state.picksPerf, [b]: { ...old, error: "這次沒下載到最新資料，顯示上次的內容" } } });
    throw e;
  }
}

export async function refreshTurn() {
  try {
    const data = (await fetchData(TURN_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("turn", v);
    set({ turn: v });
  } catch {
    if (state.turn) set({ turn: { ...state.turn, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ turn: undefined });
  }
}

/** 下載實單規則觀察組合（「我的實單」的選股規則，用虛擬 50 萬照規則操作）；失敗就沿用上次下載的 */
export async function refreshRule() {
  try {
    const data = (await fetchData(RULE_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("rule", v);
    set({ rule: v });
  } catch {
    if (state.rule) set({ rule: { ...state.rule, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ rule: undefined });
  }
}

/** 下載 AI 供應鏈觀察組合；失敗就沿用上次下載的 */
export async function refreshAi() {
  try {
    const data = (await fetchData(AI_URL)) as VirtualEtf;
    if (data?.version !== 1 || !Array.isArray(data.trades)) throw new Error("格式不對");
    const v = { data, fetchedAt: Date.now() };
    await kv.set("ai", v);
    set({ ai: v });
  } catch {
    if (state.ai) set({ ai: { ...state.ai, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ ai: undefined });
  }
}

/** 下載主動式 ETF 個股買賣超（每天由 GitHub Actions 比對各主動式 ETF 持股產生）；失敗就沿用上次的 */
export async function refreshActiveEtf() {
  try {
    const data = (await fetchData(ACTIVE_URL)) as ActiveEtfData;
    if (data?.version !== 1 || !Array.isArray(data.days) || !Array.isArray(data.etfs)) throw new Error("格式不對");
    // GitHub 那份每天只整理一次、比較舊：把上次 App 自己抓到的新持股重新套上去，不然打開就又退回舊資料、要再等一輪
    const kept = state.activeEtf?.liveHoldings;
    const v = { data: kept?.length ? mergeLive(data, kept) : data, fetchedAt: Date.now(), liveAt: state.activeEtf?.liveAt, liveHoldings: kept, liveFound: state.activeEtf?.liveFound };
    await kv.set("activeEtf", v);
    set({ activeEtf: v });
  } catch {
    if (state.activeEtf) set({ activeEtf: { ...state.activeEtf, error: "這次沒下載到最新資料，顯示上次的內容" } });
    else set({ activeEtf: { data: { version: 1, updatedAt: "", etfs: [], days: [] }, fetchedAt: 0, error: "主動式 ETF 資料下載失敗" } });
  }
}

// MoneyDJ 的手機版只有前 10 大持股，要用電腦版瀏覽器的 UA 才有完整持股與股數
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
let activeLiveRunning = false;
/** App 自己向 MoneyDJ 抓各主動式 ETF 的最新持股，比 GitHub 那份新的就併進來（持股一公布打開就看得到，不用等每天 16:40） */
export async function refreshActiveLive() {
  const cur = state.activeEtf;
  if (!cur?.data.latest || !cur.data.etfs.length || activeLiveRunning) return;
  activeLiveRunning = true;
  const codes = cur.data.etfs.map((e) => e.code);
  const fresh: NonNullable<ReturnType<typeof parseMoneyDjHoldings>>[] = [];
  let done = 0;
  const upd = () => { if (state.activeEtf) set({ activeEtf: { ...state.activeEtf, liveProgress: { done, total: codes.length } } }); };
  upd();
  try {
    await Promise.all(codes.map(async (c) => {
      try {
        const p = parseMoneyDjHoldings(await textFetcher(`https://www.moneydj.com/ETF/X/Basic/Basic0007B.xdjhtm?etfid=${c}.TW`, DESKTOP_UA));
        if (p && p.code === c) fresh.push(p);
      } catch { /* 單檔失敗就沿用 GitHub 的 */ }
      done++; upd();
    }));
    const base = state.activeEtf ?? cur;
    // 每檔 ETF 只留最新的一份，供 GitHub 資料更新後重新套用
    const byCode = new Map((base.liveHoldings ?? []).map((h) => [h.code, h]));
    for (const f of fresh) { const o = byCode.get(f.code); if (!o || f.date >= o.date) byCode.set(f.code, f); }
    const v = { ...base, data: mergeLive(base.data, fresh), liveAt: Date.now(), liveProgress: undefined, liveFound: fresh.length, liveHoldings: [...byCode.values()] };
    await kv.set("activeEtf", v);
    set({ activeEtf: v });
  } finally {
    activeLiveRunning = false;
    if (state.activeEtf?.liveProgress) set({ activeEtf: { ...state.activeEtf, liveProgress: undefined } });
  }
}

/** 下載觀察組合規則的 2 年回測結果（總評比用）；失敗就沿用上次的 */
export async function refreshSteady() {
  try {
    const data = (await fetchData(STEADY_URL)) as SteadyLite;
    if (!Array.isArray(data?.strategies)) throw new Error("格式不對");
    const v = { data: { from: data.from, to: data.to, strategies: data.strategies.map((x) => ({ key: x.key, label: x.label, cagr: x.cagr, maxDd: x.maxDd, sharpe: x.sharpe, vol: x.vol })) }, fetchedAt: Date.now() };
    await kv.set("steady", v);
    set({ steady: v });
  } catch { /* 沒下載到就沿用上次的 */ }
}

/** 下載除權息事件（雲端每天收盤後由每日行情整理）；有新資料就用還原後的漲跌幅重新評分 */
export async function refreshExdiv() {
  try {
    const data = (await fetchData(`${RADAR_DATA}exdiv.json`)) as ExFile;
    if (data?.version !== 1 || !data.ev) return;
    const v = { data, fetchedAt: Date.now() };
    await kv.set("exdiv", v);
    const changed = state.exdiv?.data.asOf !== data.asOf;
    set({ exdiv: v });
    if (changed && lastTwSnap) applyTw(lastTwSnap);
  } catch { /* 沒下載到就沿用上次的（或原始收盤） */ }
}

export async function refreshBacktest() {
  try {
    const data = (await fetchData(BACKTEST_URL)) as BacktestResult;
    if (data?.version !== 1 || !data.stocks) return;
    const bt = { data, fetchedAt: Date.now() };
    await kv.set("backtest", bt);
    set({ backtest: bt });
  } catch { /* 回測只是參考，下載失敗就沿用上次的結果 */ }
}

// ---------- 自己加美股 ----------
async function saveUsExtra(list: UsExtra[]) {
  set({ usExtra: list });
  await kv.set("usExtra", list);
}

/** 下載一檔不在清單裡的美股並加入評分（之後每天一起更新） */
export async function addUsSymbol(raw: string) {
  const symbol = raw.trim().toUpperCase();
  if (!isUsSymbol(symbol)) return;
  set({ usLookup: { symbol, status: "loading" } });
  try {
    if (!state.usExtra.some((x) => x.symbol === symbol)) {
      const x = await new UsLoader(fetcher, kv).lookup(symbol);
      if (!x) { set({ usLookup: { symbol, status: "notfound" } }); return; }
      await saveUsExtra([...state.usExtra, x]);
    }
    await refreshUs(); // 其他股票今天已經下載過（有快取），只會多抓這一檔
    set({ usLookup: undefined });
  } catch (e: any) {
    set({ usLookup: { symbol, status: "error", error: e?.message ?? String(e) } });
  }
}

export async function removeUsSymbol(symbol: string) {
  await saveUsExtra(state.usExtra.filter((x) => x.symbol !== symbol));
  const snap = await kv.get<UsSnapshot>("snap:us");
  if (snap) {
    const next = { ...snap, stocks: snap.stocks.filter((x) => x.code !== symbol) };
    await kv.set("snap:us", next); // 也要寫回，不然重開 App 後被移除的美股又出現
    applyUs(next);
  }
}

// ---------- 每月營收（免費解析用，每天下載一次） ----------
export async function revenueOf(code: string, market: "TWSE" | "TPEX"): Promise<Revenue | undefined> {
  const key = `rev:${market}:${taipeiToday()}`;
  let list = await kv.get<Revenue[]>(key);
  if (!list) {
    const t0 = Date.now();
    const dbg = ((globalThis as any).__srRevenue = { market, ms: 0, rows: 0, error: "" });
    try {
      const raw = await fetcher(market === "TWSE" ? revenueUrls.twse : revenueUrls.tpex);
      list = parseRevenue(typeof raw === "string" ? JSON.parse(raw) : raw);
      dbg.rows = list.length;
    } catch (e: any) { dbg.error = String(e?.message ?? e); return undefined; }
    finally { dbg.ms = Date.now() - t0; }
    if (!list.length) { dbg.error = "沒有解析到資料"; return undefined; }
    for (const k of await kv.keys()) if (k.startsWith(`rev:${market}:`)) await kv.del(k);
    await kv.set(key, list);
  }
  return list.find((r) => r.code === code);
}

// ---------- Claude 解析在背景執行 ----------
// 存在全域狀態裡，離開個股頁、切到別的分頁都會繼續跑；畫面最上方顯示進度，完成後點一下就能看。
export interface AiJob {
  key: string;
  kind: "stock" | "brief" | "aietf";
  title: string; // 例如「友達 2409」或「今日國內外數據」
  code?: string;
  market?: Market;
  status: "running" | "done" | "error";
  progress: AiProgress;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

function patchJob(key: string, patch: Partial<AiJob>) {
  const j = state.aiJobs[key];
  if (j) set({ aiJobs: { ...state.aiJobs, [key]: { ...j, ...patch } } });
}

export async function startAiJob(job: Pick<AiJob, "key" | "kind" | "title" | "code" | "market">, work: (onProgress: OnProgress) => Promise<AiReport>) {
  if (state.aiJobs[job.key]?.status === "running") return;
  set({ aiJobs: { ...state.aiJobs, [job.key]: { ...job, status: "running", progress: { phase: "start", searches: 0, chars: 0 }, startedAt: Date.now() } } });
  try {
    const report = await work((progress) => patchJob(job.key, { progress }));
    await saveReport(job.key, report);
    patchJob(job.key, { status: "done", finishedAt: Date.now() });
  } catch (e) {
    if (e instanceof AiError && e.costUsd) await recordSpend(e.costUsd, spendKind(job.key)).catch(() => {});
    patchJob(job.key, { status: "error", error: explainError(e), finishedAt: Date.now() });
  }
}

/** 看過結果或關掉提示 */
export function dismissAiJob(key: string) {
  if (!state.aiJobs[key] || state.aiJobs[key].status === "running") return;
  const { [key]: _, ...rest } = state.aiJobs;
  set({ aiJobs: rest });
}

// ---------- 自組 ETF ----------
export const etfPrice = (code: string) => state.prices[code]?.close;

async function saveAiEtf(etf: AiEtf) {
  set({ aiEtf: etf });
  await kv.set("aiEtf", etf);
}

/** 用最新收盤價記下今天的淨值（每天一筆，畫走勢用） */
export async function snapshotEtfNav(date = state.tw.asOf ?? taipeiToday()) {
  const etf = state.aiEtf;
  if (!etf.trades.length) return;
  const v = valuate(etf, etfPrice);
  if (v.missing.length) return; // 價格還沒到齊就不記，免得走勢圖出現假的跳動
  await saveAiEtf(recordNav(etf, date, v));
}

/** 這檔現在不在 App 選股的「買入」清單裡嗎（只用來警告） */
export const offListNow = (code: string) => isOffList(findScored(code, "TW"));

export async function addEtfTrades(trades: Omit<EtfTrade, "id" | "benchPrice">[], fromPlan?: string, stops: Record<string, number> = {}) {
  const bench = etfPrice("0050") ?? NaN;
  const add = trades.map((t, i) => ({ ...t, id: `${Date.now()}-${i}-${t.code}`, benchPrice: bench, ...(t.side === "buy" ? { offList: offListNow(t.code) } : {}) }));
  const etf = state.aiEtf;
  await saveAiEtf({ ...etf, trades: [...etf.trades, ...add], appliedKey: fromPlan ?? etf.appliedKey, stops: { ...etf.stops, ...stops } });
  await snapshotEtfNav();
}

/** 從成交紀錄列表移除這一列；只是隱藏，這筆仍算在持股、現金與損益裡（持股不跟著消失） */
export async function hideEtfTrade(id: string) {
  await saveAiEtf({ ...state.aiEtf, trades: state.aiEtf.trades.map((t) => (t.id === id ? { ...t, hidden: true } : t)) });
}

/** 設定或清除（undefined）某檔的停損價 */
export async function setEtfStop(code: string, stop: number | undefined) {
  const stops = { ...state.aiEtf.stops };
  if (stop && stop > 0) stops[code] = stop; else delete stops[code];
  await saveAiEtf({ ...state.aiEtf, stops });
}

/** 自組 ETF 的免費提醒：跌破停損、被評為離場（不呼叫 Claude） */
/** 自組 ETF 裡每檔的 App 評等；ETF（0050 等）只當參考、不給評等 */
export function etfRating(code: string) {
  const s = findScored(code, "TW");
  return s && !s.refOnly ? s.rating : undefined;
}

export const etfAlertsNow = () => etfAlerts(state.aiEtf, etfPrice, etfRating);

/** 改起始資金：已記錄的淨值走勢一起平移，報酬率才會連貫 */
export async function setEtfBudget(budget: number) {
  const etf = state.aiEtf;
  const d = budget - etf.budget;
  await saveAiEtf({ ...etf, budget, nav: etf.nav.map((x) => ({ ...x, nav: x.nav + d, bench: x.bench + d })) });
}

/** 我的實單中途存入（amount > 0）或提領（amount < 0）資金；記在目前的資料日，0050 對照組同時加減同樣的錢 */
export async function addEtfFlow(amount: number, before?: { nav: number; bench: number }) {
  const etf = state.aiEtf;
  if (!Number.isFinite(amount) || !amount) return;
  const date = state.tw.asOf ?? taipeiToday();
  // before：畫面上存提款前一刻的淨值（用即時價），沒給就用目前的價格算
  const b = before ?? valuate(etf, etfPrice);
  const flow = { id: `f${Date.now()}`, date, amount: Math.round(amount), navBefore: Math.round(b.nav), benchBefore: Math.round(b.bench) };
  // 同一天已經記過的淨值是存提款前的，先加上這筆（價格到齊後 snapshot 會用新的覆蓋），免得那天看起來像大漲大跌
  const nav = etf.nav.map((x) => (x.date >= date ? { ...x, nav: x.nav + flow.amount, bench: x.bench + flow.amount } : x));
  await saveAiEtf({ ...etf, flows: [...(etf.flows ?? []), flow], nav });
  await snapshotEtfNav();
}

/** 刪掉一筆存提款紀錄（當作沒發生過：之後的淨值紀錄也扣回這筆錢） */
export async function removeEtfFlow(id: string) {
  const etf = state.aiEtf;
  const f = (etf.flows ?? []).find((x) => x.id === id);
  if (!f) return;
  const nav = etf.nav.map((x) => (x.date >= f.date ? { ...x, nav: x.nav - f.amount, bench: x.bench - f.amount } : x));
  await saveAiEtf({ ...etf, flows: (etf.flows ?? []).filter((x) => x.id !== id), nav });
  await snapshotEtfNav();
}

export async function resetAiEtf() {
  await saveAiEtf(emptyEtf(state.aiEtf.budget));
}

/** 請 Claude 建議建倉或調整（背景執行，完成後在「自組」分頁看） */
/** Claude 建議用的資料（付費 API 和 Claude App 版用同一份，方便比較） */
export function etfAdviceInput(): EtfAdviceInput {
  const etf = state.aiEtf;
  const v = valuate(etf, etfPrice);
  const holdings = etfPositions(etf.trades).filter((p) => p.shares > 0)
    .map((p) => ({ ...p, price: etfPrice(p.code), stop: stopOf(p, etf.stops).stop, rating: etfRating(p.code) }));
  const held = new Set(holdings.map((h) => h.code));
  // 候選：App「買入」的高分股，每個產業最多 3 檔、全部最多 12 檔，已持有的不重複（持股那邊有最新價格）
  const minValue = liquidityCut(state.tw.scored);
  const candidates = pickCandidates(state.tw.scored, held, 12, 3, 6, minValue);
  const today = taipeiToday();
  const asOf = state.tw.asOf;
  return {
    today: `${today.slice(0, 4)}/${today.slice(4, 6)}/${today.slice(6)}`, budget: v.invested, cash: v.cash, nav: v.nav, holdings, candidates, minValue,
    dataDate: asOf ? prettyW(asOf) : undefined, orderDate: asOf ? prettyW(orderDay(asOf)) : undefined,
  };
}

export async function startEtfAdvice() {
  const input = etfAdviceInput();
  const key = `aietf:${Date.now()}`;
  const prev = state.aiEtf;
  await saveAiEtf({ ...prev, planKey: key, fillFrom: "api", planAsOf: state.tw.asOf });
  await startAiJob({ key, kind: "aietf", title: input.holdings.length ? "自組 ETF 檢視調整" : "自組 ETF 建倉建議" },
    async (onProgress) => {
      try { return await aiEtfAdvice(state.settings.apiKey, input, onProgress); }
      catch (e) {
        // 這次失敗：還沒套用的上一份建議要留著，不能被指向一份不存在的報告
        await saveAiEtf({ ...state.aiEtf, planKey: prev.planKey, fillFrom: prev.fillFrom, planAsOf: prev.planAsOf });
        throw e;
      }
    });
}

/** 貼回 Claude App（Pro 訂閱）的回覆，存起來和付費 API 版比較 */
export async function saveProReply(text: string) {
  const key = `aietfpro:${Date.now()}`;
  await saveReport(key, { text: text.trim(), sources: [], model: "Claude App（Pro 訂閱）", at: Date.now() });
  await saveAiEtf({ ...state.aiEtf, proKey: key, proAsOf: state.tw.asOf });
}

export async function setEtfFillFrom(fillFrom: "api" | "pro") {
  await saveAiEtf({ ...state.aiEtf, fillFrom });
}
