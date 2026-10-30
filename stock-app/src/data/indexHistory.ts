// 指數的日 K（點進「數據」頁的指數看走勢）：
//  ・加權指數：證交所「發行量加權股價指數歷史資料」每月一份，有完整開高低收
//  ・櫃買指數：櫃買中心 openapi 只回傳當月開高低收，App 每次看到就存進手機，累積成更長的走勢
//  ・臺灣50、半導體、金融保險、電子：證交所沒有這些指數的歷史開高低收，改抓每天的「指數收盤」（MI_INDEX type=IND，每天約 22KB），
//    一次抓回全部指數、存在手機裡；K 棒的開＝前一天收盤、收＝當天收盤（沒有真正的盤中高低）
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { taipeiHour, taipeiToday, weekdaysBack } from "../lib/dates";
import { rocToYmd, type DayBar } from "./tw";
import { beginForeground } from "./history";

export const taiexHistUrl = (ym: string) => `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym.slice(0, 6)}01&response=json`;
export const tpexIndexUrl = () => "https://www.tpex.org.tw/openapi/v1/tpex_index";
export const twseIndexDayUrl = (d: string) => `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${d}&type=IND&response=json`;
/** 診斷用：e2e 把 window.__srIdxTrace 設成陣列，下載過程就會記進去（平常不存在，沒有任何作用） */
const trace = (m: string) => { try { (globalThis as any).__srIdxTrace?.push(`${Date.now() % 1e6} ${m}`); } catch { /* ignore */ } };
const TRACKED = ["發行量加權股價指數", "臺灣50指數", "半導體類指數", "金融保險類指數", "電子工業類指數", "電子類指數"];

const n = (s: unknown): number => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) && v > 0 ? v : NaN; };

/** 證交所 MI_5MINS_HIST：日期、開盤指數、最高指數、最低指數、收盤指數 */
export function parseTaiexHist(json: any): DayBar[] {
  if (!json || json.stat !== "OK" || !Array.isArray(json.data)) return [];
  return json.data
    .map((r: any[]) => ({ date: rocToYmd(String(r[0])), open: n(r[1]), high: n(r[2]), low: n(r[3]), close: n(r[4]), volume: 0 }))
    .filter((b: DayBar) => b.date && Number.isFinite(b.close));
}

/** 櫃買 openapi tpex_index：Date(YYYYMMDD)、Open、High、Low、Close、Change */
export function parseTpexIndex(rows: any): DayBar[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({ date: String(r?.Date ?? ""), open: n(r?.Open), high: n(r?.High), low: n(r?.Low), close: n(r?.Close), volume: 0 }))
    .filter((b) => /^\d{8}$/.test(b.date) && Number.isFinite(b.close));
}

/** 只有收盤的指數：開＝前一天收盤、收＝當天收盤，高低就是兩者的高低 */
export function closesToBars(closes: { date: string; close: number }[]): DayBar[] {
  const s = [...closes].sort((a, b) => a.date.localeCompare(b.date));
  return s.map((c, i) => {
    const open = i ? s[i - 1].close : c.close;
    return { date: c.date, open, high: Math.max(open, c.close), low: Math.min(open, c.close), close: c.close, volume: 0 };
  });
}

/** MI_INDEX type=IND：每張表第一欄是「指數」，取我們追蹤的幾個指數的收盤；休市（stat 非 OK）回傳 null */
export function parseIndexDay(json: any): Record<string, number> | null {
  if (!json || json.stat !== "OK" || !Array.isArray(json.tables)) return null;
  const out: Record<string, number> = {};
  for (const t of json.tables) {
    if (t?.fields?.[0] !== "指數" || !Array.isArray(t.data)) continue;
    for (const r of t.data) {
      const name = String(r?.[0] ?? "").trim();
      if (TRACKED.includes(name) && !(name in out)) { const c = n(r[1]); if (Number.isFinite(c)) out[name] = c; }
    }
  }
  return Object.keys(out).length ? out : null;
}

/** 畫面上的指數名稱 → 證交所每日資料裡可能的名稱（電子指數在 MI_INDEX 叫「電子工業類指數」，盤中即時叫「電子類指數」） */
const DAILY_NAMES: Record<string, string[]> = { 加權指數: ["發行量加權股價指數"], 電子類指數: ["電子工業類指數", "電子類指數"] };
export const dailyIndexNames = (name: string) => DAILY_NAMES[name] ?? [name];
export function pickClose(rec: Record<string, number> | undefined, name: string): number {
  for (const k of dailyIndexNames(name)) { const v = rec?.[k]; if (Number.isFinite(v) && (v as number) > 0) return v as number; }
  return NaN;
}

const isFinalDay = (d: string, now: number) => { const t = taipeiToday(now); return d < t || (d === t && taipeiHour(now) >= 14); };

/** 某天各指數收盤：先看手機存的（指數專用、每日行情兩種），沒有才連網；休市存空物件。連網失敗回傳 undefined */
export async function indexDay(fetch: Fetcher, kv: KV, d: string, now = Date.now()): Promise<Record<string, number> | undefined> {
  const mine = await kv.get<Record<string, number>>(`idx:d:${d}`);
  if (mine) return mine;
  if (!isFinalDay(d, now)) return undefined; // 今天還沒收盤：交給即時報價
  try {
    trace(`fetch ${d}`);
    const day = parseIndexDay(await fetch(twseIndexDayUrl(d))) ?? {};
    await kv.set(`idx:d:${d}`, day); // 休市日也存（空物件），之後不再問
    trace(`ok ${d} ${Object.keys(day).length}`);
    return day;
  } catch (e: any) { trace(`fail ${d} ${e?.message ?? e}`); return undefined; }
}

/** 每日排程累積的指數歷史（stock-index-hist.yml 產生）：加權／櫃買的真實開高低收＋臺灣50等的每日收盤，第一次打開就有完整走勢 */
export const INDEX_HIST_URL = "https://github.com/ltotokkimo-spec/new-1016/releases/download/stock-radar-data/index-hist.json";
export interface RemoteIndexHist { version: 1; updated?: string; ohlc: Record<string, [string, number, number, number, number][]>; closes: Record<string, [string, number][]>; seen?: string[] }
const REMOTE_FRESH_MS = 6 * 3600_000;

async function loadRemote(fetch: Fetcher, kv: KV, now: number): Promise<RemoteIndexHist | null> {
  const cached = await kv.get<{ at: number; data: RemoteIndexHist }>("idx:rem");
  if (cached && now - cached.at < REMOTE_FRESH_MS) return cached.data;
  try {
    const j = await fetch(`${INDEX_HIST_URL}?t=${now}`);
    if (j && j.version === 1 && j.ohlc && j.closes) { await kv.set("idx:rem", { at: now, data: j }); trace(`remote ok seen=${j.seen?.length ?? 0}`); return j as RemoteIndexHist; }
  } catch (e: any) { trace(`remote fail ${e?.message ?? e}`); }
  return cached?.data ?? null;
}
const remoteBars = (r: RemoteIndexHist | null, name: string): DayBar[] =>
  (r?.ohlc?.[name] ?? []).map(([date, open, high, low, close]) => ({ date, open, high, low, close, volume: 0 }));
function remoteCloses(r: RemoteIndexHist | null, name: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of dailyIndexNames(name)) for (const [d, c] of r?.closes?.[k] ?? []) if (Number.isFinite(c) && c > 0) m.set(d, c);
  return m;
}

// 美股指數（CNBC bars，和 App 的國際指標報價同一個來源）：真實開高低收，一次請求就有一年
export const cnbcBarsUrl = (sym: string, startYmd: string, endYmd: string) =>
  `https://ts-api.cnbc.com/harmony/app/bars/${encodeURIComponent(sym)}/1D/${startYmd}000000/${endYmd}000000/adjusted/EXTENDED.json`;
export function parseCnbcBars(json: any): DayBar[] {
  const list = json?.barData?.priceBars;
  if (!Array.isArray(list)) return [];
  return list
    .map((b: any) => ({ date: String(b?.tradeTime ?? "").slice(0, 8), open: n(b?.open), high: n(b?.high), low: n(b?.low), close: n(b?.close), volume: 0 }))
    .filter((b: DayBar) => /^\d{8}$/.test(b.date) && Number.isFinite(b.close) && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low));
}
export const isUsIndexSymbol = (name: string) => name.startsWith(".");

export interface IndexHist { bars: DayBar[]; kind: "ohlc" | "close" }

/**
 * 指數日 K。onPartial：有部分資料就先回報（手機裡已有的先畫，其餘下載後再更新）。
 */
export async function indexHistory(fetch: Fetcher, kv: KV, name: string, months = 6, now = Date.now(), onPartial?: (h: IndexHist) => void, days = 70, stop?: () => boolean): Promise<IndexHist> {
  const end = beginForeground(); // 證交所每 3 秒才能問一次，使用者正在看時背景預載先讓路
  try { return await indexHistoryInner(fetch, kv, name, months, now, onPartial, days, stop); } finally { end(); }
}

async function indexHistoryInner(fetch: Fetcher, kv: KV, name: string, months: number, now: number, onPartial: ((h: IndexHist) => void) | undefined, days: number, stop?: () => boolean): Promise<IndexHist> {
  if (isUsIndexSymbol(name)) {
    const key = `idx:us:${name}`;
    const saved = (await kv.get<DayBar[]>(key)) ?? [];
    if (saved.length) onPartial?.({ kind: "ohlc", bars: saved });
    const end = new Date(now + 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
    const start = new Date(now - 380 * 86400_000).toISOString().slice(0, 10).replace(/-/g, "");
    try {
      const bars = parseCnbcBars(await fetch(cnbcBarsUrl(name, start, end)));
      if (bars.length) { await kv.set(key, bars); return { kind: "ohlc", bars }; }
    } catch (e) { if (!saved.length) throw e; }
    if (!saved.length) throw new Error("下載走勢失敗");
    return { kind: "ohlc", bars: saved };
  }
  const remote = await loadRemote(fetch, kv, now);
  if (name === "加權指數") {
    const today = taipeiToday(now);
    let y = +today.slice(0, 4), m = +today.slice(4, 6);
    const keys: string[] = [];
    for (let i = 0; i < months; i++) { keys.unshift(`${y}${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } }
    const keyOf = (ym: string) => `idx:t00:${ym}${ym === today.slice(0, 6) ? ":" + today + (taipeiHour(now) >= 14 ? "c" : "") : ""}`;
    const got = new Map<string, DayBar[]>();
    const base = remoteBars(remote, name); // 排程累積的檔案當底，只需要補它之後的月份
    const baseYm = base.length ? base[base.length - 1].date.slice(0, 6) : "";
    const merged = (): IndexHist => {
      const byDate = new Map(base.map((b) => [b.date, b]));
      for (const k of keys) for (const b of got.get(k) ?? []) byDate.set(b.date, b); // 同一天以自己抓到的為準
      return { kind: "ohlc", bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) };
    };
    await Promise.all(keys.map(async (ym) => { const b = await kv.get<DayBar[]>(keyOf(ym)); if (b) got.set(ym, b); }));
    if (got.size || base.length) onPartial?.(merged());
    for (const ym of [...keys].reverse()) {
      if (got.has(ym) || stop?.() || (baseYm && ym < baseYm)) continue;
      let bars: DayBar[];
      try { bars = parseTaiexHist(await fetch(taiexHistUrl(ym))); } catch (e) { if (merged().bars.length) break; throw e; }
      if (bars.length) await kv.set(keyOf(ym), bars);
      got.set(ym, bars);
      onPartial?.(merged());
    }
    return merged();
  }
  if (name === "櫃買指數") {
    const saved = (await kv.get<DayBar[]>("idx:o00")) ?? [];
    const early = remoteBars(remote, name);
    if (saved.length || early.length) onPartial?.({ kind: "ohlc", bars: [...new Map([...early, ...saved].map((b) => [b.date, b])).values()].sort((a, b) => a.date.localeCompare(b.date)) });
    let fresh: DayBar[] = [];
    try { fresh = parseTpexIndex(await fetch(tpexIndexUrl())); } catch (e) { if (!saved.length && !early.length) throw e; }
    const byDate = new Map(remoteBars(remote, name).map((b) => [b.date, b]));
    for (const b of saved) byDate.set(b.date, b);
    for (const b of fresh) byDate.set(b.date, b); // 同一天以新的為準
    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    if (fresh.length) await kv.set("idx:o00", all);
    return { kind: "ohlc", bars: all };
  }
  // 其餘指數：最近 days 個平日各抓一次收盤（最新的先抓；手機存過的直接用），每抓完一批就回報一次
  const want = name;
  const dates = weekdaysBack(taipeiToday(now), days).filter((d) => isFinalDay(d, now)); // 新→舊
  const got = new Map<string, number>();
  const emit = () => onPartial?.({ kind: "close", bars: closesToBars([...got].map(([date, close]) => ({ date, close }))) });
  const pending: string[] = [];
  const rc = remoteCloses(remote, want);
  const rSeen = new Set(remote?.seen ?? []);
  trace(`start ${want} dates=${dates.length} remote=${rc.size}`);
  const mine = await Promise.all(dates.map((d) => kv.get<Record<string, number>>(`idx:d:${d}`))); // 平行讀手機裡存的（逐筆等會很慢）
  const olds = await Promise.all(dates.map((d, i) => (mine[i] ? undefined : kv.get<any>(`tw2:q:twse:${d}`))));
  dates.forEach((d, i) => {
    if (rc.has(d)) { got.set(d, rc.get(d)!); return; }
    if (rSeen.has(d)) return; // 排程檢查過但沒有這個指數的資料（休市）
    if (mine[i]) { const c = pickClose(mine[i], want); if (Number.isFinite(c)) got.set(d, c); return; } // 指數專用的存檔：空物件代表休市，不用再問
    // App 自己下載的每日行情快取只存了幾個指數（名稱也可能不同），沒有要的那個就當作沒有，去抓
    const c = pickClose(olds[i]?.indices ? Object.fromEntries((olds[i].indices as any[]).map((x) => [x?.name, x?.close])) : undefined, want);
    if (Number.isFinite(c)) got.set(d, c); else pending.push(d);
  });
  trace(`close ${want} cached=${got.size} pending=${pending.length}`);
  if (got.size) emit();
  let failed = 0;
  for (let i = 0; i < pending.length && failed < 3 && !stop?.(); i += 2) { // 兩天一批：第一張圖約 6 秒就出來，其餘慢慢補（存在手機，下次不用再抓）
    const rs = await Promise.all(pending.slice(i, i + 2).map(async (d) => [d, await indexDay(fetch, kv, d, now)] as const));
    for (const [d, r] of rs) { if (r === undefined) failed++; else { const c = pickClose(r, want); if (Number.isFinite(c)) got.set(d, c); } }
    emit();
  }
  if (!got.size && failed) throw new Error("下載指數收盤失敗");
  return { kind: "close", bars: closesToBars([...got].map(([date, close]) => ({ date, close }))) };
}
