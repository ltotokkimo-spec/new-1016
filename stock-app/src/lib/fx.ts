// 美元兌台幣：持股頁把美股的美元損益換成台幣顯示。匯率用數據頁抓到的 CNBC 即時報價（代號 TWD=）。
export const USDTWD_SYMBOL = "TWD=";

/** 取出美元兌台幣匯率（1 美元 = N 台幣）；沒有資料或不合理就回傳 undefined */
export function usdTwdRate(quotes: { symbol: string; last: number }[] | undefined): number | undefined {
  const r = quotes?.find((q) => q.symbol === USDTWD_SYMBOL)?.last;
  return r !== undefined && Number.isFinite(r) && r > 10 && r < 100 ? r : undefined;
}

/** 美元金額換成帶正負號的台幣：-NT$6,500／+NT$3,200／NT$0 */
export function fmtNtd(usd: number, rate: number): string {
  const twd = usd * rate;
  if (!Number.isFinite(twd)) return "—";
  const n = Math.round(Math.abs(twd));
  return `${n === 0 ? "" : twd < 0 ? "-" : "+"}NT$${n.toLocaleString("en-US")}`;
}
