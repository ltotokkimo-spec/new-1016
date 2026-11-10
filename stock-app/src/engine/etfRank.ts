// 買賣超排名：依三大法人（或外資／投信／自營）今天或近 5 日的買賣超，取買超、賣超前 N 名。
// 「ETF排行」分頁用投信買賣超代表個股被 ETF 買賣（沒有官方的 ETF 個股買賣超資料；台股 ETF 幾乎都是投信發行）。
// 排名用「金額」（股數 × 收盤價）：每張價格差很多，用張數排會偏向便宜的股票。
export type RankWho = "all" | "foreign" | "trust" | "dealer";
export interface RankInput { code: string; name: string; close: number; value?: number; chg1d?: number; sector?: string; flow1?: [number, number, number]; flow5?: [number, number, number] }
export interface RankRow<T> { item: T; shares: number; amount: number; pct?: number }

export function sharesOf(f: [number, number, number] | undefined, who: RankWho): number | undefined {
  if (!f) return undefined;
  return who === "foreign" ? f[0] : who === "trust" ? f[1] : who === "dealer" ? f[2] : f[0] + f[1] + f[2];
}

/**
 * sort="pct"（11/10 加碼幅度排名）：投信沒有逐檔持股，改用「買賣超金額 ÷ 成交金額」看力道（近 5 日用最新一天成交金額 × 5 估算），
 * 金額低於 1,000 萬的不列。
 */
export function flowRank<T extends RankInput>(list: T[], days: 1 | 5, who: RankWho, n = 20, sort: "amount" | "pct" = "amount"): { buy: RankRow<T>[]; sell: RankRow<T>[] } {
  const rows: RankRow<T>[] = [];
  for (const item of list) {
    const shares = sharesOf(days === 1 ? item.flow1 : item.flow5, who);
    if (shares === undefined || !Number.isFinite(shares) || shares === 0 || !(item.close > 0)) continue;
    const amount = shares * item.close;
    rows.push({ item, shares, amount, pct: item.value && item.value > 0 ? amount / (item.value * days) : undefined });
  }
  const pick = (side: 1 | -1) => {
    const r = rows.filter((x) => x.amount * side > 0);
    if (sort === "pct") return r.filter((x) => Math.abs(x.amount) >= 1e7 && x.pct !== undefined).sort((a, b) => side * (b.pct! - a.pct!)).slice(0, n);
    return r.sort((a, b) => side * (b.amount - a.amount)).slice(0, n);
  };
  return { buy: pick(1), sell: pick(-1) };
}
