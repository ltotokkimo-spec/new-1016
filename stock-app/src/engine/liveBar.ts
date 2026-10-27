// 盤中 K 線：證交所的日 K 要收盤後（約 15:00）才有今天那一根，盤中用即時報價（開、高、低、現價、累積量）先拼一根暫時的，
// 收盤後正式資料下載到了就用正式的（不再加）。
export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; live?: boolean }
export interface LiveLike { date: string; price: number; open: number; high: number; low: number; volume?: number }

export function withLiveBar<T extends Bar>(bars: T[], q?: LiveLike): (T | Bar)[] {
  if (!q || !/^\d{8}$/.test(q.date) || !(q.price > 0) || !(q.open > 0)) return bars; // 還沒開盤成交（沒有開盤價）就不畫
  const last = bars[bars.length - 1];
  if (last && last.date >= q.date) return bars; // 已經有今天的正式資料
  const high = Math.max(q.high > 0 ? q.high : q.price, q.price, q.open);
  const low = Math.min(q.low > 0 ? q.low : q.price, q.price, q.open);
  return [...bars, { date: q.date, open: q.open, high, low, close: q.price, volume: q.volume && q.volume > 0 ? q.volume : 0, live: true }];
}
