// 自組 ETF／虛擬 ETF「報酬走勢」的說明用數字：累積報酬、落後或贏過 0050 多少、最大回檔、每天的報酬與贏過 0050 的天數。
import { twrSeries, type NavPoint } from "./aiEtf";

export interface NavRow {
  date: string; nav: number; bench: number;
  mineCum: number; benchCum: number; // 累積報酬（相對起始資金）
  mineDay: number; benchDay: number; // 當天報酬（相對前一天；第一筆相對起始資金）
}
export interface NavStats {
  rows: NavRow[];
  mine: number; bench: number; diff: number; // 累積報酬、0050 累積報酬、兩者差（百分點，小數）
  pnl: number; // 目前損益金額（元）
  maxDd: number; benchMaxDd: number; // 最大回檔（負數）：從最高點往下跌最多多少
  days: number; winDays: number; // 天數、贏過 0050 的天數
  best?: NavRow; worst?: NavRow; // 當天報酬最好、最差的一天
}

const maxDrawdown = (series: number[]) => {
  let peak = series[0], dd = 0;
  for (const v of series) { peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); }
  return dd;
};

/** flows：中途存入／提領（選用）。有的話報酬率用時間加權，存提款那天不會跳動；損益金額＝淨值－實際投入的本金 */
export function navStats(points: NavPoint[], budget: number, flows: { date: string; amount: number }[] = []): NavStats | undefined {
  if (!points.length || !(budget > 0)) return undefined;
  const mine = twrSeries(points.map((p) => ({ date: p.date, v: p.nav })), budget, flows);
  const bench = twrSeries(points.map((p) => ({ date: p.date, v: p.bench })), budget, flows);
  const rows: NavRow[] = points.map((p, i) => ({
    date: p.date, nav: p.nav, bench: p.bench,
    mineCum: mine[i].cum, benchCum: bench[i].cum,
    mineDay: mine[i].day, benchDay: bench[i].day,
  }));
  const last = rows[rows.length - 1];
  const invested = budget + flows.filter((f) => f.date <= last.date).reduce((a, f) => a + f.amount, 0);
  const byDay = [...rows].sort((a, b) => a.mineDay - b.mineDay);
  return {
    rows,
    mine: last.mineCum, bench: last.benchCum, diff: last.mineCum - last.benchCum,
    pnl: last.nav - invested,
    // 最大回檔用時間加權的累積淨值（存提款不會被當成漲跌）
    maxDd: maxDrawdown([1, ...rows.map((r) => 1 + r.mineCum)]),
    benchMaxDd: maxDrawdown([1, ...rows.map((r) => 1 + r.benchCum)]),
    days: rows.length, winDays: rows.filter((r) => r.mineDay > r.benchDay).length,
    best: byDay[byDay.length - 1], worst: byDay[0],
  };
}
