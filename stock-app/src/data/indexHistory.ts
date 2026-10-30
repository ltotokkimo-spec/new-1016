// 指數的日 K（點進「數據」頁的指數看走勢）：
//  ・加權指數：證交所「發行量加權股價指數歷史資料」每月一份，有完整開高低收
//  ・櫃買指數：櫃買中心 openapi 只回傳當月開高低收，App 每次看到就存進手機，累積成更長的走勢
//  ・臺灣50、半導體、金融保險、電子：證交所沒有這些指數的歷史開高低收，用 App 已經下載的每日收盤行情裡的「收盤指數」串起來，
//    K 棒的開＝前一天收盤、收＝當天收盤（沒有真正的盤中高低）
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { taipeiHour, taipeiToday, weekdaysBack } from "../lib/dates";
import { rocToYmd, type DayBar } from "./tw";

export const taiexHistUrl = (ym: string) => `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ym.slice(0, 6)}01&response=json`;
export const tpexIndexUrl = () => "https://www.tpex.org.tw/openapi/v1/tpex_index";

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

/** 畫面上的指數名稱 → 每日收盤行情裡的名稱 */
export const dailyIndexName = (name: string) => (name === "加權指數" ? "發行量加權股價指數" : name);

/** 從手機裡已下載的每日行情（loader 的快取）撈某指數的收盤 */
export async function cachedCloses(kv: KV, name: string, days = 130, now = Date.now()): Promise<{ date: string; close: number }[]> {
  const want = dailyIndexName(name);
  const dates = weekdaysBack(taipeiToday(now), days);
  const got = await Promise.all(dates.map(async (d) => {
    const hit = await kv.get<any>(`tw2:q:twse:${d}`);
    const c = hit?.indices?.find?.((x: any) => x?.name === want)?.close;
    return Number.isFinite(c) && c > 0 ? { date: d, close: c as number } : null;
  }));
  return got.filter((x): x is { date: string; close: number } => !!x);
}

export interface IndexHist { bars: DayBar[]; kind: "ohlc" | "close" }

/**
 * 指數日 K。onPartial：有部分資料就先回報（手機裡已有的先畫，其餘下載後再更新）。
 */
export async function indexHistory(fetch: Fetcher, kv: KV, name: string, months = 6, now = Date.now(), onPartial?: (h: IndexHist) => void): Promise<IndexHist> {
  if (name === "加權指數") {
    const today = taipeiToday(now);
    let y = +today.slice(0, 4), m = +today.slice(4, 6);
    const keys: string[] = [];
    for (let i = 0; i < months; i++) { keys.unshift(`${y}${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } }
    const keyOf = (ym: string) => `idx:t00:${ym}${ym === today.slice(0, 6) ? ":" + today + (taipeiHour(now) >= 14 ? "c" : "") : ""}`;
    const got = new Map<string, DayBar[]>();
    const merged = (): IndexHist => ({ kind: "ohlc", bars: keys.flatMap((k) => got.get(k) ?? []).sort((a, b) => a.date.localeCompare(b.date)) });
    await Promise.all(keys.map(async (ym) => { const b = await kv.get<DayBar[]>(keyOf(ym)); if (b) got.set(ym, b); }));
    if (got.size) onPartial?.(merged());
    for (const ym of [...keys].reverse()) {
      if (got.has(ym)) continue;
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
    if (saved.length) onPartial?.({ kind: "ohlc", bars: saved });
    let fresh: DayBar[] = [];
    try { fresh = parseTpexIndex(await fetch(tpexIndexUrl())); } catch (e) { if (!saved.length) throw e; }
    const byDate = new Map(saved.map((b) => [b.date, b]));
    for (const b of fresh) byDate.set(b.date, b); // 同一天以新的為準
    const all = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-400);
    if (fresh.length) await kv.set("idx:o00", all);
    return { kind: "ohlc", bars: all };
  }
  const bars = closesToBars(await cachedCloses(kv, name, 130, now));
  return { kind: "close", bars };
}
