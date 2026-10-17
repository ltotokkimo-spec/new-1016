// App 狀態：資料快照、評分結果、持股、設定。全部存在手機的 IndexedDB。
import { useEffect, useState } from "preact/hooks";
import { indexedKV, type KV } from "./lib/kv";
import { fetchJson, type Fetcher } from "./lib/net";
import { TwLoader, TW_SNAPSHOT_VERSION, type TwSnapshot } from "./data/twLoader";
import { isEtf, parseEsbLatest, twUrls, type EsbQuote } from "./data/tw";
import { UsLoader, type UsSnapshot } from "./data/usLoader";
import { cnbcUrl, isUsSymbol, MACRO_SYMBOLS, parseCnbcQuotes, US_UNIVERSE, type MacroQuote, type UsExtra } from "./data/us";
import { scoreStocks, reviewHolding, type Holding, type HoldingView, type Scored, type SectorStat } from "./engine/score";
import { explainError, type AiProgress, type AiReport, type OnProgress } from "./ai/claude";
import { taipeiToday } from "./lib/dates";
import * as upd from "./lib/update";
import type { BacktestResult } from "./engine/backtest";
import { parseRevenue, revenueUrls, type Revenue } from "./data/revenue";

export const BACKTEST_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/stock-radar-data/backtest.json";

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
  usSectorEtfs: UsSnapshot["sectorEtfs"];
  macro: { status: "idle" | "loading" | "ready" | "error"; quotes: MacroQuote[]; error?: string; at?: number };
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
  usExtra: UsExtra[]; // 使用者自己加的美股
  usPending: string[]; // 正在下載的美股持股代號
  usNotFound: string[]; // Nasdaq 查不到的代號
  aiJobs: Record<string, AiJob>; // 背景執行中／剛完成的 Claude 解析（key 同 reports）
  usLookup?: { symbol: string; status: "loading" | "notfound" | "error"; error?: string };
  loaded: boolean;
}

const empty = (): MarketState => ({ status: "idle", scored: [], sectors: [] });
const starting = (): MarketState => ({ status: "loading", scored: [], sectors: [], progress: { done: 0, total: 1, label: "讀取手機裡的資料" } });

let state: State = {
  tw: starting(), etf: starting(), us: starting(), esb: {}, twIndices: [], usSectorEtfs: [],
  macro: { status: "idle", quotes: [] }, holdings: [], settings: { apiKey: "" }, reports: {}, prices: {}, spend: [], update: { status: "idle" }, usExtra: [], usPending: [], usNotFound: [], aiJobs: {}, loaded: false,
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

const timings: Record<string, number> = ((globalThis as any).__srTimings = {});
const mark = (k: string) => { timings[k] = Math.round(performance.now()); };

export async function init() {
  mark("init");
  const [holdings, settings, reports, twSnap0, usSnap, spend, esbSnap] = await Promise.all([
    kv.get<Holding[]>("holdings"), kv.get<Settings>("settings"), kv.get<Record<string, AiReport>>("reports"),
    kv.get<TwSnapshot>("snap:tw"), kv.get<UsSnapshot>("snap:us"), kv.get<State["spend"]>("spend"),
    kv.get<EsbSnapshot>("snap:esb"),
  ]);
  set({ usExtra: (await kv.get<UsExtra[]>("usExtra")) ?? [] });
  const bt = await kv.get<State["backtest"]>("backtest");
  if (bt) set({ backtest: bt });
  if (!bt || Date.now() - bt.fetchedAt > 6 * 3600_000) refreshBacktest();
  // 舊版快照沒有 ETF，直接當作沒有資料重抓
  const twSnap = twSnap0?.version === TW_SNAPSHOT_VERSION ? twSnap0 : undefined;
  mark("kvRead");
  set({ holdings: holdings ?? [], settings: settings ?? { apiKey: "" }, reports: reports ?? {}, spend: spend ?? [], loaded: true });
  if (twSnap) applyTw(twSnap);
  if (usSnap) applyUs(usSnap);
  if (esbSnap) applyEsb(esbSnap);
  // 開 App 時自動更新：沒資料或資料不是今天抓的就重抓（快取會讓已下載的日子不重抓）
  const today = taipeiToday();
  if (!twSnap || taipeiToday(twSnap.fetchedAt) !== today || Date.now() - twSnap.fetchedAt > 3 * 3600_000) refreshTw();
  if (!usSnap || taipeiToday(usSnap.fetchedAt) !== today) refreshUs();
  else ensureUsHoldings(); // 今天的美股已下載過，但持股裡可能有還沒下載的代號
  if (!esbSnap || taipeiToday(esbSnap.fetchedAt) !== today || Date.now() - esbSnap.fetchedAt > 3 * 3600_000) refreshEsb();
  refreshMacro();
  if (upd.isNative()) checkForUpdate();
}

function pricesOf(stocks: { code: string; name: string; close: number }[]) {
  const out: State["prices"] = { ...state.prices };
  for (const x of stocks) out[x.code] = { name: x.name, close: x.close };
  return out;
}

function applyTw(snap: TwSnapshot) {
  const common = snap.stocks.filter((x) => !isEtf(x.code));
  const etfs = snap.stocks.filter((x) => isEtf(x.code));
  const a = scoreStocks(common), b = scoreStocks(etfs);
  const meta = { status: "ready" as const, asOf: snap.asOf, fetchedAt: snap.fetchedAt };
  set({ prices: pricesOf(snap.stocks) });
  // ETF 回測顯示規則分辨不出好壞，只給分數當參考，不給買入／觀望／離場
  const etfScored = b.scored.map((x) => ({ ...x, refOnly: true }));
  set({ tw: { ...meta, scored: a.scored, sectors: a.sectors }, etf: { ...meta, scored: etfScored, sectors: b.sectors }, twIndices: snap.indices });
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

export async function refreshMacro() {
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

export function holdingViews(): HoldingView[] {
  return state.holdings.map((h) => {
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

export async function recordSpend(usd: number | undefined, kind: string) {
  if (usd === undefined || !Number.isFinite(usd)) return;
  const spend = [...state.spend, { at: Date.now(), usd, kind }].slice(-2000);
  set({ spend });
  await kv.set("spend", spend);
}

export async function saveReport(key: string, report: AiReport) {
  await recordSpend(report.costUsd, key.startsWith("brief") ? "數據解讀" : "個股解析");
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
  try {
    set({ update: { status: "ready", info: await upd.checkUpdate() } });
  } catch (e: any) {
    const current = await upd.currentVersion().catch(() => undefined);
    set({ update: { status: "error", info: { current, available: false }, error: `檢查更新失敗：${e?.message ?? e}` } });
  }
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
export async function refreshBacktest() {
  try {
    const data = (await fetcher(`${BACKTEST_URL}?t=${Date.now()}`)) as BacktestResult;
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
  if (snap) applyUs({ ...snap, stocks: snap.stocks.filter((x) => x.code !== symbol) });
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
  kind: "stock" | "brief";
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
    patchJob(job.key, { status: "error", error: explainError(e), finishedAt: Date.now() });
  }
}

/** 看過結果或關掉提示 */
export function dismissAiJob(key: string) {
  if (!state.aiJobs[key] || state.aiJobs[key].status === "running") return;
  const { [key]: _, ...rest } = state.aiJobs;
  set({ aiJobs: rest });
}
