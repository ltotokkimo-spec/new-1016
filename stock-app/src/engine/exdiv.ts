// 除權息還原（11/9 使用者要求）：評分的近 1 週／1 月／3 月漲跌幅原本用原始收盤價，除息造成的下跌也被算成「跌」，
// 對月配息 ETF 與高股息股票系統性不利。這裡從每日行情找出除權息事件，把期間內的除權息加回去再算漲跌幅。
//
// 事件怎麼找：證交所／櫃買每天公布的「漲跌」是對「參考價」算的。平常參考價＝前一天收盤；除權息那天參考價＝除權息後的價格。
// 所以「收盤 − 漲跌 ≠ 前一天收盤」的那天就是除權息（或減資等），比例＝參考價 ÷ 前一天收盤，配發金額＝前一天收盤 − 參考價。
import type { QRow } from "../data/twLoader";

/** 一次除權息：[日期, 比例（參考價÷前收）, 每單位權息值（前收−參考價）, 除權息前收盤] */
export type ExEvent = [d: string, r: number, amt: number, pre: number];
export type ExMap = Record<string, ExEvent[]>; // 代號 → 事件（舊到新）

/** 從每日行情（新到舊）找出除權息事件 */
export function exEventsFromDays(days: { date: string; quotes: QRow[] }[]): ExMap {
  const out: ExMap = {};
  for (let i = days.length - 2; i >= 0; i--) {
    const prev = new Map(days[i + 1].quotes.map((r) => [r[0], r[2]]));
    for (const [code, , close, change] of days[i].quotes) {
      const p = prev.get(code);
      if (!(p && p > 0 && close > 0 && Number.isFinite(change))) continue;
      const ref = Math.round((close - change) * 10000) / 10000;
      if (!(ref > 0) || Math.abs(ref - p) <= Math.max(0.001, p * 1e-6)) continue;
      (out[code] ??= []).push([days[i].date, Math.round((ref / p) * 1e6) / 1e6, Math.round((p - ref) * 10000) / 10000, p]);
    }
  }
  return out;
}

/** (after, upTo] 期間的除權息比例連乘（沒有事件＝1） */
export function exFactor(ev: ExEvent[] | undefined, after: string, upTo: string): number {
  let f = 1;
  for (const e of ev ?? []) if (e[0] > after && e[0] <= upTo && e[1] > 0) f *= e[1];
  return f;
}

/** 把評分輸入的近 1 週／1 月／3 月漲跌幅改成還原除權息後的報酬；ref 是各期的基準日、asOf 是最新資料日 */
export function adjustReturns<T extends { code: string; ret1w: number; ret1m: number; ret3m: number }>(xs: T[], ex: ExMap | undefined, ref: { w1: string; m1: string; m3: string }, asOf: string): T[] {
  if (!ex) return xs;
  const adj = (ret: number, after: string, ev: ExEvent[]) => (Number.isFinite(ret) ? (1 + ret) / exFactor(ev, after, asOf) - 1 : ret);
  return xs.map((x) => {
    const ev = ex[x.code];
    if (!ev?.length) return x;
    return { ...x, ret1w: adj(x.ret1w, ref.w1, ev), ret1m: adj(x.ret1m, ref.m1, ev), ret3m: adj(x.ret3m, ref.m3, ev) };
  });
}

/** 比例小於這個的當成分割或減資（例如 0050 一拆四），不算配息 */
const SPLIT_R = 0.7;

export interface DividendInfo {
  count: number; // 近一年配息次數
  freq: string; // 月配／季配／半年配／年配
  total: number; // 近一年每單位配息合計
  yieldPct: number; // 近一年配息 ÷ 現價
  last?: { d: string; amt: number; pre: number }; // 最近一次
  filled?: boolean; // 現價已回到最近一次除息前的收盤（填息）
  gap?: number; // 還差多少填息（元）
}

/** ETF 配息資訊（近 365 天）；沒有配息回 undefined */
export function dividendInfo(ev: ExEvent[] | undefined, price: number, asOf: string): DividendInfo | undefined {
  if (!ev?.length || !(price > 0)) return undefined;
  const y = Number(asOf.slice(0, 4)), from = `${y - 1}${asOf.slice(4)}`;
  const divs = ev.filter((e) => e[0] > from && e[0] <= asOf && e[1] >= SPLIT_R && e[1] < 1 && e[2] > 0);
  if (!divs.length) return undefined;
  const total = divs.reduce((a, e) => a + e[2], 0);
  const n = divs.length;
  const freq = n >= 10 ? "月配" : n >= 3 ? "季配" : n === 2 ? "半年配" : "年配";
  const l = divs[divs.length - 1];
  return { count: n, freq, total, yieldPct: total / price, last: { d: l[0], amt: l[2], pre: l[3] }, filled: price >= l[3], gap: Math.max(0, l[3] - price) };
}
