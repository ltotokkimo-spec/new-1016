// ETF 買賣排名：依三大法人（或外資／投信／自營）今天或近 5 日的買賣超，取買超、賣超前 N 名。
// 排名用「金額」（股數 × 收盤價）：ETF 每張價格差很多（幾元到幾百元），用張數排會偏向便宜的 ETF。
export type RankWho = "all" | "foreign" | "trust" | "dealer";
export interface RankInput { code: string; name: string; close: number; chg1d?: number; sector?: string; flow1?: [number, number, number]; flow5?: [number, number, number] }
export interface RankRow<T> { item: T; shares: number; amount: number }

export function sharesOf(f: [number, number, number] | undefined, who: RankWho): number | undefined {
  if (!f) return undefined;
  return who === "foreign" ? f[0] : who === "trust" ? f[1] : who === "dealer" ? f[2] : f[0] + f[1] + f[2];
}

export function etfFlowRank<T extends RankInput>(list: T[], days: 1 | 5, who: RankWho, n = 20): { buy: RankRow<T>[]; sell: RankRow<T>[] } {
  const rows: RankRow<T>[] = [];
  for (const item of list) {
    const shares = sharesOf(days === 1 ? item.flow1 : item.flow5, who);
    if (shares === undefined || !Number.isFinite(shares) || shares === 0 || !(item.close > 0)) continue;
    rows.push({ item, shares, amount: shares * item.close });
  }
  return {
    buy: rows.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, n),
    sell: rows.filter((r) => r.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, n),
  };
}
