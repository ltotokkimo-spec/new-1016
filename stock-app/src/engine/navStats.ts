// 自組 ETF／虛擬 ETF「報酬走勢」的說明用數字：累積報酬、落後或贏過 0050 多少、最大回檔、每天的報酬與贏過 0050 的天數。
import type { NavPoint } from "./aiEtf";

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

export function navStats(points: NavPoint[], budget: number): NavStats | undefined {
  if (!points.length || !(budget > 0)) return undefined;
  const rows: NavRow[] = points.map((p, i) => {
    const prevNav = i ? points[i - 1].nav : budget, prevBench = i ? points[i - 1].bench : budget;
    return {
      date: p.date, nav: p.nav, bench: p.bench,
      mineCum: p.nav / budget - 1, benchCum: p.bench / budget - 1,
      mineDay: p.nav / prevNav - 1, benchDay: p.bench / prevBench - 1,
    };
  });
  const last = rows[rows.length - 1];
  const byDay = [...rows].sort((a, b) => a.mineDay - b.mineDay);
  return {
    rows,
    mine: last.mineCum, bench: last.benchCum, diff: last.mineCum - last.benchCum,
    pnl: last.nav - budget,
    maxDd: maxDrawdown([budget, ...points.map((p) => p.nav)]),
    benchMaxDd: maxDrawdown([budget, ...points.map((p) => p.bench)]),
    days: rows.length, winDays: rows.filter((r) => r.mineDay > r.benchDay).length,
    best: byDay[byDay.length - 1], worst: byDay[0],
  };
}
