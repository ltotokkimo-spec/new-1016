// 興櫃股票（櫃買中心）：盤中報價與歷史行情。證交所的即時報價（mis）查不到興櫃，所以改用櫃買中心：
//  ・「興櫃股票當日行情表」每分鐘更新一次（含最後成交價、日最高、日最低、日均價、成交量、買賣報價）
//  ・「興櫃個股歷史行情」每個月一份（只有最高、最低、均價、成交量，沒有開盤價與收盤價）
// 興櫃沒有開收盤價：K 線用「前一日均價」當開盤、「當日均價」當收盤（盤中的那一根收盤改用最新成交價）。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { taipeiHour, taipeiToday } from "../lib/dates";
import type { LiveQuote } from "./twLive";
import type { DayBar } from "./tw";

export const esbLiveUrl = () => "https://www.tpex.org.tw/www/zh-tw/emerging/latest?response=json";
/** 個股歷史行情要給「該月任一天」的完整日期（只給年月會一律回傳當月） */
export const esbHistUrl = (code: string, ym: string) => `https://www.tpex.org.tw/www/zh-tw/emerging/historical?code=${code}&date=${encodeURIComponent(`${ym.slice(0, 4)}/${ym.slice(4, 6)}/01`)}&id=&response=json`;

const n = (s: unknown): number => { const v = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(v) && v > 0 ? v : NaN; };

/** "115年10月30日 09:28:03" → { date: "20261030", time: "09:28:03" } */
export function parseEsbStamp(s: unknown): { date: string; time: string } {
  const m = /(\d{2,3})年(\d{1,2})月(\d{1,2})日\s+(\d{2}:\d{2}:\d{2})/.exec(String(s ?? ""));
  if (!m) return { date: "", time: "" };
  return { date: `${+m[1] + 1911}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`, time: m[4] };
}

/** 當日行情表 → 即時報價（欄位：0 代號、1 名稱、2 前日均價、3 報買價、5 報賣價、7 日最高、8 日最低、9 日均價、10 成交、13 成交量(股)） */
export function parseEsbLive(json: any): Record<string, LiveQuote> {
  const t = json?.tables?.[0];
  const out: Record<string, LiveQuote> = {};
  if (!t || !Array.isArray(t.data)) return out;
  const { date, time } = parseEsbStamp(t.date ?? t.fileTime ?? t.subtitle2);
  for (const r of t.data) {
    const code = String(r?.[0] ?? "").trim();
    if (!code) continue;
    const prev = n(r[2]), last = n(r[10]), avg = n(r[9]);
    const price = [last, avg, prev].find((x) => Number.isFinite(x));
    if (price === undefined) continue;
    const traded = Number.isFinite(last) || Number.isFinite(avg);
    out[code] = {
      code, name: String(r[1] ?? code).trim(), price, prevClose: prev,
      open: traded && Number.isFinite(prev) ? prev : NaN, // 興櫃沒有開盤價，用前日均價當 K 線的開
      high: n(r[7]), low: n(r[8]), date, time, final: time >= "13:30:00", volume: n(r[13]),
    };
  }
  return out;
}

/** 民國 "115/10/29" → "20261029" */
const rocDay = (s: string) => { const m = /^(\d{2,3})\/(\d{2})\/(\d{2})$/.exec(String(s).trim()); return m ? `${+m[1] + 1911}${m[2]}${m[3]}` : ""; };

/** 個股歷史行情（一個月）→ 每天的最高、最低、均價、成交量；沒有成交的日子略過 */
export function parseEsbHist(json: any): { date: string; high: number; low: number; avg: number; volume: number }[] {
  const rows = json?.tables?.[0]?.data;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    const date = rocDay(r?.[0]);
    const vol = n(r?.[1]), high = n(r?.[3]), low = n(r?.[4]), avg = n(r?.[5]);
    if (!date || !Number.isFinite(avg) || !Number.isFinite(vol)) continue;
    out.push({ date, high: Number.isFinite(high) ? high : avg, low: Number.isFinite(low) ? low : avg, avg, volume: vol });
  }
  return out;
}

/** 把每天的均價資料串成 K 線：開＝前一日均價（第一天用自己的均價）、收＝當日均價 */
export function esbBars(days: ReturnType<typeof parseEsbHist>): DayBar[] {
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((d, i) => {
    const open = i ? sorted[i - 1].avg : d.avg;
    return { date: d.date, open, high: Math.max(d.high, open, d.avg), low: Math.min(d.low, open, d.avg), close: d.avg, volume: d.volume };
  });
}

/** 興櫃個股最近幾個月的日 K（過去的月份永久快取；本月收盤後與盤中各存一份） */
export async function esbHistory(fetch: Fetcher, kv: KV, code: string, months = 6, now = Date.now()): Promise<DayBar[]> {
  const today = taipeiToday(now);
  let y = +today.slice(0, 4), m = +today.slice(4, 6);
  const keys: string[] = [];
  for (let i = 0; i < months; i++) { keys.unshift(`${y}${String(m).padStart(2, "0")}`); m--; if (m === 0) { m = 12; y--; } }
  const days: ReturnType<typeof parseEsbHist> = [];
  for (const ym of keys) {
    const thisMonth = ym === today.slice(0, 6);
    const key = `esb:h:${code}:${ym}${thisMonth ? ":" + today + (taipeiHour(now) >= 17 ? "c" : "") : ""}`;
    let part = await kv.get<ReturnType<typeof parseEsbHist>>(key);
    if (!part) {
      try { part = parseEsbHist(await fetch(esbHistUrl(code, ym))); } catch { part = undefined; }
      if (part?.length) await kv.set(key, part);
    }
    days.push(...(part ?? []));
  }
  return esbBars(days);
}
