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

/** 某天的除權息參考價（前收 × 比例）；那天沒有事件回 undefined */
export function exRefOn(ex: ExMap, code: string, date: string): number | undefined {
  const e = ex[code]?.find((x) => x[0] === date);
  return e ? Math.round(e[3] * e[1] * 10000) / 10000 : undefined;
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

/**
 * 證交所「除權除息計算結果表」（TWT49U）→ 事件。比從每日行情推算可靠：
 * 行情在除權息當天的漲跌欄只標「X」不分正負，推算會錯（11/9 實測 00406A 0.138 元被算成 0.6、−0.18 元）。
 * 欄位：資料日期（民國）、股票代號、除權息前收盤價、除權息參考價、權值+息值。
 */
export function parseTwt49u(json: any): ExMap {
  const out: ExMap = {};
  const t = Array.isArray(json?.tables) ? json.tables.find((x: any) => Array.isArray(x?.fields) && x.fields.includes("股票代號")) : json;
  const fields: string[] = t?.fields ?? json?.fields ?? [];
  const data: any[][] = t?.data ?? json?.data ?? [];
  const f = (name: string) => fields.findIndex((x) => String(x).replace(/\s/g, "").includes(name));
  const iD = f("資料日期"), iC = f("股票代號"), iPre = f("除權息前收盤價"), iRef = f("除權息參考價"), iAmt = f("權值+息值");
  if ([iD, iC, iPre, iRef].some((i) => i < 0)) return out;
  const num = (v: unknown) => Number(String(v ?? "").replace(/[,\s]/g, ""));
  for (const r of data) {
    const m = /(\d{2,3})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(r[iD]));
    if (!m) continue;
    const d = `${Number(m[1]) + 1911}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`;
    const code = String(r[iC]).trim(), pre = num(r[iPre]), ref = num(r[iRef]);
    if (!code || !(pre > 0) || !(ref > 0)) continue;
    const amt = iAmt >= 0 && Number.isFinite(num(r[iAmt])) ? num(r[iAmt]) : pre - ref;
    (out[code] ??= []).push([d, Math.round((ref / pre) * 1e6) / 1e6, Math.round(amt * 10000) / 10000, pre]);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}

/** 合併兩份事件：同一檔同一天以 primary 為準（證交所官方優先於推算） */
export function mergeEx(primary: ExMap, fallback: ExMap, skipCodes?: Set<string>): ExMap {
  const out: ExMap = {};
  for (const [k, v] of Object.entries(fallback)) if (!skipCodes?.has(k)) out[k] = [...v];
  for (const [k, v] of Object.entries(primary)) {
    const days = new Set(v.map((e) => e[0]));
    out[k] = [...(out[k] ?? []).filter((e) => !days.has(e[0])), ...v].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return out;
}

/**
 * 櫃買中心「上櫃股票除權除息計算結果表」→ 事件（上櫃行情在除權息當天漲跌欄不是數字，推算抓不到，11/9 實測 00679B 沒有任何事件）。
 * 新網站有 fields 時依欄名；舊網站 aaData 沒有欄名時依固定位置：[日期, 代號, 名稱, 除權息前收盤價, 除權息參考價, 權值, 息值, ...]。
 */
export function parseTpexExright(json: any): ExMap {
  const out: ExMap = {};
  const t = Array.isArray(json?.tables) ? json.tables.find((x: any) => Array.isArray(x?.fields) && Array.isArray(x?.data)) : undefined;
  const fields: string[] = (t?.fields ?? json?.fields ?? []).map((x: any) => String(x).replace(/\s/g, ""));
  const data: any[][] = t?.data ?? json?.data ?? json?.aaData ?? [];
  const f = (...names: string[]) => fields.findIndex((x) => names.some((n) => x.includes(n)));
  let iD = 0, iC = 1, iPre = 3, iRef = 4, iW = 5, iX = 6;
  if (fields.length) {
    iD = f("除權息日期", "日期"); iC = f("代號"); iPre = f("前收盤", "前收"); iRef = f("參考價"); iW = fields.findIndex((x) => x === "權值"); iX = fields.findIndex((x) => x === "息值");
    if ([iD, iC, iPre, iRef].some((i) => i < 0)) return out;
  }
  const num = (v: unknown) => Number(String(v ?? "").replace(/<[^>]*>/g, "").replace(/[,\s]/g, ""));
  for (const r of data) {
    if (!Array.isArray(r)) continue;
    const m = /(\d{2,4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(r[iD]));
    if (!m) continue;
    const y = Number(m[1]);
    const d = `${y < 1911 ? y + 1911 : y}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}`;
    const code = String(r[iC]).replace(/<[^>]*>/g, "").trim(), pre = num(r[iPre]), ref = num(r[iRef]);
    if (!code || !(pre > 0) || !(ref > 0) || ref > pre * 1.5) continue;
    const w = iW >= 0 ? num(r[iW]) : NaN, x = iX >= 0 ? num(r[iX]) : NaN;
    const amt = Number.isFinite(w) && Number.isFinite(x) && w + x > 0 ? w + x : pre - ref;
    (out[code] ??= []).push([d, Math.round((ref / pre) * 1e6) / 1e6, Math.round(amt * 10000) / 10000, pre]);
  }
  for (const k of Object.keys(out)) out[k].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return out;
}
