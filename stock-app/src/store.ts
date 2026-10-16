// App 狀態：資料快照、評分結果、持股、設定。全部存在手機的 IndexedDB。
import { useEffect, useState } from "preact/hooks";
import { indexedKV, type KV } from "./lib/kv";
import { fetchJson, type Fetcher } from "./lib/net";
import { TwLoader, type TwSnapshot } from "./data/twLoader";
import { UsLoader, type UsSnapshot } from "./data/usLoader";
import { cnbcUrl, MACRO_SYMBOLS, parseCnbcQuotes, type MacroQuote } from "./data/us";
import { scoreStocks, reviewHolding, type Holding, type HoldingView, type Scored, type SectorStat } from "./engine/score";
import type { AiReport } from "./ai/claude";
import { taipeiToday } from "./lib/dates";

export type Market = "TW" | "US";

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

export interface Settings { apiKey: string }

export interface State {
  tw: MarketState;
  us: MarketState;
  twIndices: TwSnapshot["indices"];
  usSectorEtfs: UsSnapshot["sectorEtfs"];
  macro: { status: "idle" | "loading" | "ready" | "error"; quotes: MacroQuote[]; error?: string; at?: number };
  holdings: Holding[];
  settings: Settings;
  reports: Record<string, AiReport>; // key: "stock:2330:20261016" / "brief:20261016"
  prices: Record<string, { name: string; close: number }>; // 全市場收盤價（含未評分的低成交股）
  loaded: boolean;
}

const empty = (): MarketState => ({ status: "idle", scored: [], sectors: [] });
const starting = (): MarketState => ({ status: "loading", scored: [], sectors: [], progress: { done: 0, total: 1, label: "讀取手機裡的資料" } });

let state: State = {
  tw: starting(), us: starting(), twIndices: [], usSectorEtfs: [],
  macro: { status: "idle", quotes: [] }, holdings: [], settings: { apiKey: "" }, reports: {}, prices: {}, loaded: false,
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
  const [holdings, settings, reports, twSnap, usSnap] = await Promise.all([
    kv.get<Holding[]>("holdings"), kv.get<Settings>("settings"), kv.get<Record<string, AiReport>>("reports"),
    kv.get<TwSnapshot>("snap:tw"), kv.get<UsSnapshot>("snap:us"),
  ]);
  mark("kvRead");
  set({ holdings: holdings ?? [], settings: settings ?? { apiKey: "" }, reports: reports ?? {}, loaded: true });
  if (twSnap) applyTw(twSnap);
  if (usSnap) applyUs(usSnap);
  // 開 App 時自動更新：沒資料或資料不是今天抓的就重抓（快取會讓已下載的日子不重抓）
  const today = taipeiToday();
  if (!twSnap || taipeiToday(twSnap.fetchedAt) !== today || Date.now() - twSnap.fetchedAt > 3 * 3600_000) refreshTw();
  if (!usSnap || taipeiToday(usSnap.fetchedAt) !== today) refreshUs();
  refreshMacro();
}

function pricesOf(stocks: { code: string; name: string; close: number }[]) {
  const out: State["prices"] = { ...state.prices };
  for (const x of stocks) out[x.code] = { name: x.name, close: x.close };
  return out;
}

function applyTw(snap: TwSnapshot) {
  const { scored, sectors } = scoreStocks(snap.stocks);
  set({ prices: pricesOf(snap.stocks) });
  set({ tw: { status: "ready", scored, sectors, asOf: snap.asOf, fetchedAt: snap.fetchedAt }, twIndices: snap.indices });
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
  const prev = state.tw;
  set({ tw: { ...prev, status: prev.scored.length ? "ready" : "loading", progress: { done: 0, total: 1, label: "準備中" }, error: undefined } });
  try {
    mark("twStart");
    const snap = await new TwLoader(fetcher, kv).load((done, total, label) => {
      if (!timings.twFirstProgress) mark("twFirstProgress");
      set({ tw: { ...state.tw, progress: { done, total, label } } });
    });
    mark("twDone");
    await kv.set("snap:tw", snap);
    applyTw(snap);
  } catch (e: any) {
    set({ tw: { ...state.tw, status: state.tw.scored.length ? "ready" : "error", error: `台股資料更新失敗：${e?.message ?? e}`, progress: undefined } });
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
  const lists = market === "US" ? [state.us.scored] : market === "TW" ? [state.tw.scored] : [state.tw.scored, state.us.scored];
  for (const l of lists) { const s = l.find((x) => x.code === code); if (s) return s; }
  return undefined;
}

export function holdingViews(): HoldingView[] {
  return state.holdings.map((h) => {
    const m = h.market === "US" ? state.us : state.tw;
    const v = reviewHolding(h, findScored(h.code, h.market === "US" ? "US" : "TW"), state.prices[h.code]?.close);
    if (!v.scored && m.status !== "ready") v.advice = [m.status === "error" ? "行情下載失敗" : "行情載入中…"];
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

export async function saveReport(key: string, report: AiReport) {
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
  set({ tw: empty(), us: empty() });
  refreshTw(); refreshUs();
}
