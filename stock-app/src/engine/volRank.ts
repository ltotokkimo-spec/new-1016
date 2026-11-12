// 當沖用「盤中成交量即時排名」（11/12 使用者）：從候選名單的即時報價排出前 N 名，並算出這一輪名次的升降。
export interface RankQuote { code: string; name: string; price: number; prevClose: number; volume?: number; time?: string; final?: boolean; date?: string }
export interface RankRow { code: string; name: string; price: number; chg: number; lots: number; value: number; rank: number; move: number | "new"; time?: string }
export type RankBy = "vol" | "value";

/** 候選名單：前一個交易日成交量最大的股票（含 ETF 時另外加 ETF 前幾名）；當天爆量的股票通常前一天量也不小 */
export function rankPool<T extends { code: string; volume?: number; value?: number }>(stocks: T[], etfs: T[], nStock = 200, nEtf = 40): T[] {
  const byVol = (a: T, b: T) => (b.volume ?? 0) - (a.volume ?? 0);
  const out = [...stocks].sort(byVol).slice(0, nStock);
  if (nEtf > 0) out.push(...[...etfs].sort(byVol).slice(0, nEtf));
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.code) ? false : (seen.add(x.code), true)));
}

/** 依成交量（張）或估計成交值排出前 n 名；prev＝上一輪的名次（代號→名次），算升降與「新進榜」 */
export function rankQuotes(qs: RankQuote[], by: RankBy, n = 15, prev?: Map<string, number>): RankRow[] {
  const rows = qs
    .filter((q) => Number.isFinite(q.volume) && (q.volume ?? 0) > 0 && q.price > 0)
    .map((q) => ({ code: q.code, name: q.name, price: q.price, chg: q.prevClose > 0 ? q.price / q.prevClose - 1 : 0, lots: Math.round((q.volume ?? 0) / 1000), value: q.price * (q.volume ?? 0), time: q.time }))
    .sort((a, b) => (by === "vol" ? b.lots - a.lots || b.value - a.value : b.value - a.value || b.lots - a.lots))
    .slice(0, n);
  return rows.map((r, i) => {
    const p = prev?.get(r.code);
    return { ...r, rank: i + 1, move: !prev || !prev.size ? 0 : p === undefined ? "new" : p - (i + 1) };
  });
}

/** 成交值：億／萬 */
export const fmtValue = (v: number) => (v >= 1e8 ? `${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 億` : `${Math.round(v / 1e4).toLocaleString("zh-TW")} 萬`);
