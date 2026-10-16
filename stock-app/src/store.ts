// App 狀態：資料快照、評分結果、持股、設定。全部存在手機的 IndexedDB。
import { useEffect, useState } from "preact/hooks";
import { indexedKV, type KV } from "./lib/kv";
import { fetchJson, type Fetcher } from "./lib/net";
import { TwLoader, TW_SNAPSHOT_VERSION, type TwSnapshot } from "./data/twLoader";
import { isEtf, parseEsbLatest, twUrls, type EsbQuote } from "./data/tw";
import { UsLoader, type UsSnapshot } from "./data/usLoader";
import { cnbcUrl, MACRO_SYMBOLS, parseCnbcQuotes, type MacroQuote } from "./data/us";
import { scoreStocks, reviewHolding, type Holding, type HoldingView, type Scored, type SectorStat } from "./engine/score";
import type { AiReport } from "./ai/claude";
import { taipeiToday } from "./lib/dates";
import * as upd from "./lib/update";

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
  loaded: boolean;
}

const empty = (): MarketState => ({ status: "idle", scored: [], sectors: [] });
const starting = (): MarketState => ({ status: "loading", scored: [], sectors: [], progress: { done: 0, total: 1, label: "讀取手機裡的資料" } });

let state: State = {
  tw: starting(), etf: starting(), us: starting(), esb: {}, twIndices: [], usSectorEtfs: [],
  macro: { status: "idle", quotes: [] }, holdings: [], settings: { apiKey: "" }, reports: {}, prices: {}, spend: [], update: { status: "idle" }, loaded: false,
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
  set({ tw: { ...meta, scored: a.scored, sectors: a.sectors }, etf: { ...meta, scored: b.scored, sectors: b.sectors }, twIndices: snap.indices });
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

function applyUs(snap: UsSnapshot) {
  const { scored, sectors } = scoreStocks(snap.stocks);
  set({ prices: pricesOf(snap.stocks) });
  const warning = snap.failed?.length ? `${snap.failed.join("、")} 這次下載失敗，按右上角重新整理可重試` : undefined;
  set({ us: { status: "ready", scored, sectors, asOf: snap.asOf, fetchedAt: snap.fetchedAt, warning }, usSectorEtfs: snap.sectorEtfs });
}

let twBusy = false, usBusy = false;

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

export async function refreshUs() {
  if (usBusy) return;
  usBusy = true;
  const prev = state.us;
  set({ us: { ...prev, status: prev.scored.length ? "ready" : "loading", progress: { done: 0, total: 1, label: "準備中" }, error: undefined } });
  try {
    const snap = await new UsLoader(fetcher, kv).load((done, total, label) =>
      set({ us: { ...state.us, progress: { done, total, label } } }));
    const { bars, ...rest } = snap; // 日K 很大，快照只存計算結果
    await kv.set("snap:us", { ...rest, bars: {} });
    await kv.set("us:bars", bars);
    applyUs(snap);
  } catch (e: any) {
    set({ us: { ...state.us, status: state.us.scored.length ? "ready" : "error", error: `美股資料更新失敗：${e?.message ?? e}`, progress: undefined } });
  } finally { usBusy = false; }
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
    if (!v.scored && !Number.isFinite(v.price) && m.status !== "ready") v.advice = [m.status === "error" ? "行情下載失敗" : "行情載入中…"];
    return v;
  });
}

export async function saveHoldings(holdings: Holding[]) {
  set({ holdings });
  await kv.set("holdings", holdings);
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
  for (const k of await kv.keys()) if (/^(tw|us|snap):/.test(k)) await kv.del(k);
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
