// 台股漲跌停（一般股票、ETF：昨收 ±10%，價格取到升降單位）。
// 即時報價有證交所給的漲停價 u、跌停價 w 就直接用；收盤後的快照沒有，才用這裡的規則算。
export type Limit = "up" | "down";

/** 升降單位（證交所規定）：ETF 50 元以上固定 0.05；股票 10／50／100／500／1000 元分段 */
export function tickSize(p: number, etf: boolean): number {
  if (p < 10) return 0.01;
  if (etf) return p < 50 ? 0.01 : 0.05;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** 漲停價：昨收 × 1.1 往下取到升降單位 */
export function limitUpPrice(prev: number, etf = false): number {
  const x = prev * 1.1, t = tickSize(x, etf);
  return r2(Math.floor(Math.round((x / t) * 1e6) / 1e6) * t);
}

/** 跌停價：昨收 × 0.9 往上取到升降單位 */
export function limitDownPrice(prev: number, etf = false): number {
  const x = prev * 0.9, t = tickSize(x, etf);
  return r2(Math.ceil(Math.round((x / t) * 1e6) / 1e6) * t);
}

/** 價格剛好在漲停價／跌停價 → 漲停／跌停；沒有昨收或價格就不判斷 */
export function limitState(price: number, prev: number, etf = false): Limit | undefined {
  if (!(price > 0) || !(prev > 0)) return undefined;
  if (Math.abs(price - limitUpPrice(prev, etf)) < 0.001) return "up";
  if (Math.abs(price - limitDownPrice(prev, etf)) < 0.001) return "down";
  return undefined;
}

/** 只有「價格」和「漲跌幅」（沒有昨收）時：先由漲跌幅還原昨收再判斷（選股清單、持股的收盤快照用） */
export function limitFromChg(price: number, chg: number | undefined, etf = false): Limit | undefined {
  if (chg === undefined || !Number.isFinite(chg) || !(price > 0) || Math.abs(chg) < 0.08) return undefined; // 漲跌幅不到 8% 不可能漲跌停
  return limitState(price, Math.round((price / (1 + chg)) * 100) / 100, etf);
}
