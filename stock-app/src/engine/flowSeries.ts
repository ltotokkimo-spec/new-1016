// 個股「法人」分頁：把每天的三大法人買賣超（股）整理成一個月的序列（張），配上當天收盤價。
import type { FRow } from "../data/twLoader";

export interface FlowDay { date: string; close: number; foreign: number; trust: number; dealer: number; total: number } // 買賣超單位：張

export const FLOW_DAYS = 22; // 約一個月的交易日

/**
 * bars：日K（舊到新）；flows：已下載的每日全市場法人資料（日期 → 列）。
 * 只列出「已經有該日法人資料」的日子（休市或還沒公布的日子沒有）；該日有資料但沒有這檔，代表法人當天沒買賣，記 0。
 * 三大法人 = 外資＋投信＋自營商（外資自營商極少，不另列）。
 */
export function buildFlowSeries(bars: { date: string; close: number }[], flows: Map<string, FRow[]>, code: string, days = FLOW_DAYS): FlowDay[] {
  const out: FlowDay[] = [];
  for (const b of bars.slice(-days)) {
    const rows = flows.get(b.date);
    if (!rows) continue;
    const r = rows.find((x) => x[0] === code);
    const f = (r?.[1] ?? 0) / 1000, t = (r?.[2] ?? 0) / 1000, d = (r?.[3] ?? 0) / 1000;
    out.push({ date: b.date, close: b.close, foreign: f, trust: t, dealer: d, total: f + t + d });
  }
  return out;
}

export interface FlowSum { total: number; foreign: number; trust: number; dealer: number }
export const sumFlows = (rows: FlowDay[]): FlowSum =>
  rows.reduce((s, r) => ({ total: s.total + r.total, foreign: s.foreign + r.foreign, trust: s.trust + r.trust, dealer: s.dealer + r.dealer }), { total: 0, foreign: 0, trust: 0, dealer: 0 });

/** 要抓法人資料的日期：日K最近 days 天；今天已過下午 2 點、日K還沒有今天時，也加上今天（法人資料通常下午 3～4 點公布） */
export function flowDates(barDates: string[], today: string, hour: number, isWeekdayToday: boolean, days = FLOW_DAYS): string[] {
  const d = barDates.slice(-days);
  if (isWeekdayToday && hour >= 14 && (d.length === 0 || d[d.length - 1] < today)) return [...d.slice(-(days - 1)), today];
  return d;
}
