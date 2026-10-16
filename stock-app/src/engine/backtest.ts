// 回測：回到過去每一週，用和 App 完全相同的評分規則重新評等，看之後 5 天、20 天的實際漲跌。
// 純計算，資料由 GitHub Actions 每天下載後計算（tools/backtest.ts），App 只下載結果。
import { buildTwInputs, type FRow, type QRow } from "../data/twLoader";
import { isEtf, type Company } from "../data/tw";
import { addDays } from "../lib/dates";
import { scoreStocks, type Rating } from "./score";

export interface BtDay { date: string; quotes: QRow[]; tpexCodes: Set<string>; flows: FRow[] }

export const HORIZONS = [5, 20] as const;
type H = (typeof HORIZONS)[number];

export interface GroupStat {
  n: number; // 樣本數（股票×評等日）
  avg: number; // 平均報酬
  median: number;
  win: number; // 上漲比例
  beat: number; // 贏過同一天全部股票「中位數」的比例（50% ≈ 亂選）
}
export interface BtSeriesRow { date: string; nBuy: number; buy: Partial<Record<H, number>>; all: Partial<Record<H, number>> }
export interface BtUniverse {
  signals: number; // 評等日數
  groups: Record<Rating | "全部", Partial<Record<H, GroupStat>>>;
  series: BtSeriesRow[]; // 每個評等日：買入平均 vs 全部平均（新到舊）
}
export interface BacktestResult {
  version: 1;
  generatedAt: number;
  from: string; // 第一個評等日
  to: string; // 最後一個評等日
  dataTo: string; // 最新資料日
  stocks: BtUniverse;
  etf: BtUniverse;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function median(xs: number[]) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * days：新到舊、連續的交易日。
 * 之後的報酬用每天的「漲跌」連乘（漲跌是對除權息後的參考價計算），所以配息、除權不會被算成下跌。
 */
export function runBacktest(days: BtDay[], companies: Company[], opts: { step?: number; now?: number } = {}): BacktestResult {
  const step = opts.step ?? 5;
  const byDay = days.map((d) => new Map(d.quotes.map((r) => [r[0], r])));
  const dateIdx = new Map(days.map((d, i) => [d.date, i]));
  // 往前找「該日或更早」的第一個交易日索引
  const idxOnOrBefore = (ymd: string) => {
    for (let k = 0; k < 10; k++) { const i = dateIdx.get(addDays(ymd, -k)); if (i !== undefined) return i; }
    return undefined;
  };
  const fwd = (code: string, i: number, h: number) => {
    if (i - h < 0) return NaN;
    let g = 1;
    for (let t = i - 1; t >= i - h; t--) {
      const r = byDay[t].get(code);
      if (!r) continue; // 停牌當天不變
      const [, , close, change] = r;
      const ref = close - change;
      g *= Number.isFinite(change) && ref > 0 ? close / ref : 1;
    }
    return g - 1;
  };

  const uni = (): { pairs: Record<string, Partial<Record<H, number[]>>>; excess: Record<string, Partial<Record<H, boolean[]>>>; series: BtSeriesRow[]; signals: number } =>
    ({ pairs: {}, excess: {}, series: [], signals: 0 });
  const acc = { stocks: uni(), etf: uni() };
  const signalDates: string[] = [];

  for (let i = HORIZONS[0]; i < days.length; i += step) {
    const s = days[i].date;
    const w = i + 5;
    const m1 = idxOnOrBefore(addDays(s, -28));
    const m3 = idxOnOrBefore(addDays(s, -88));
    if (w >= days.length || m1 === undefined || m3 === undefined || i + 10 > days.length) continue;
    const inputs = buildTwInputs({
      latest: days[i].quotes, week: days[w].quotes, month: days[m1].quotes, quarter: days[m3].quotes,
      flows: days.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: days[i].tpexCodes,
    });
    signalDates.push(s);
    for (const key of ["stocks", "etf"] as const) {
      const a = acc[key];
      const { scored } = scoreStocks(inputs.filter((x) => (key === "etf") === isEtf(x.code)));
      if (!scored.length) continue;
      a.signals++;
      const row: BtSeriesRow = { date: s, nBuy: 0, buy: {}, all: {} };
      for (const h of HORIZONS) {
        const rs = scored.map((x) => fwd(x.code, i, h));
        const ok = rs.map(Number.isFinite);
        const valid = rs.filter((_, j) => ok[j]);
        const allAvg = mean(valid), allMed = median(valid);
        if (!Number.isFinite(allAvg)) continue;
        row.all[h] = allAvg;
        const buys: number[] = [];
        scored.forEach((x, j) => {
          if (!ok[j]) return;
          for (const g of [x.rating, "全部"]) {
            ((a.pairs[g] ??= {})[h] ??= []).push(rs[j]);
            ((a.excess[g] ??= {})[h] ??= []).push(rs[j] > allMed);
          }
          if (x.rating === "買入") buys.push(rs[j]);
        });
        if (buys.length) row.buy[h] = mean(buys);
      }
      row.nBuy = scored.filter((x) => x.rating === "買入").length;
      a.series.push(row);
    }
  }

  const finish = (a: ReturnType<typeof uni>): BtUniverse => {
    const groups = {} as BtUniverse["groups"];
    for (const g of ["買入", "觀望", "離場", "全部"] as const) {
      groups[g] = {};
      for (const h of HORIZONS) {
        const xs = a.pairs[g]?.[h] ?? [];
        const ex = a.excess[g]?.[h] ?? [];
        if (!xs.length) continue;
        groups[g][h] = { n: xs.length, avg: mean(xs), median: median(xs), win: xs.filter((x) => x > 0).length / xs.length, beat: ex.filter(Boolean).length / ex.length };
      }
    }
    return { signals: a.signals, groups, series: a.series };
  };
  return {
    version: 1, generatedAt: opts.now ?? Date.now(),
    from: signalDates[signalDates.length - 1] ?? "", to: signalDates[0] ?? "", dataTo: days[0]?.date ?? "",
    stocks: finish(acc.stocks), etf: finish(acc.etf),
  };
}
