// 台指期即時報價（期交所 MIS）：日盤（MarketType 0，08:45～13:45）與夜盤（MarketType 1，15:00～隔天 05:00）。
// 回傳全部契約，第一檔期貨就是近月；夜盤收盤後到隔天開盤前仍回傳昨晚的夜盤資料。
import { parseNum } from "./twLive";

export const TAIFEX_URL = "https://mis.taifex.com.tw/futures/api/getQuoteList";
export type FutSession = "day" | "night";

export const taifexBody = (session: FutSession) => ({
  MarketType: session === "day" ? "0" : "1", SymbolType: "F", KindID: "1", CID: "TXF", ExpireMonth: "", RowSize: "全部", PageNo: "", SortColumn: "", AscDesc: "A",
});

export interface FutQuote {
  session: FutSession;
  symbol: string; // 例如 TXFK6-F（K = 11 月，6 = 2026 年）
  last: number;
  ref: number; // 前一個交易日的結算價（漲跌的基準）
  change: number;
  changePct: number; // 百分比，例如 −0.21
  high?: number; low?: number;
  volume?: number; // 累計成交量（口）
  spot?: number; // 同一份報價裡的現貨（加權指數）價位，算基差用；夜盤沒有現貨成交所沒有
  date: string; // 交易日 YYYYMMDD（夜盤算下一個交易日開頭的那一天，即 15:00 開盤那天）
  time: string; // HH:MM（最後一筆成交）
  settleOnly?: boolean; // 日盤還沒開盤：沒有成交價，last 是「前一交易日結算價」，不是成交價
}

const positive = (x: number) => (Number.isFinite(x) && x > 0 ? x : undefined);

/** 取近月（清單裡第一個期貨契約）；開盤前沒有成交價就回傳 undefined */
export function parseTaifex(json: any, session: FutSession): FutQuote | undefined {
  const list: any[] = json?.RtData?.QuoteList ?? [];
  const q = list.find((x) => /^TXF[A-L]\d-[FM]$/.test(String(x?.SymbolID ?? "")));
  if (!q) return undefined;
  const last = parseNum(q.CLastPrice), ref = parseNum(q.CRefPrice);
  // 日盤 08:45 開盤前沒有成交價，但有前一交易日結算價：回傳它並標 settleOnly，畫面顯示「昨結算」，不讓整張卡片消失
  if (!(last > 0) && ref > 0 && session === "day") return { session, symbol: String(q.SymbolID), last: ref, ref, change: 0, changePct: 0, date: "", time: "", settleOnly: true };
  if (!(last > 0) || !(ref > 0)) return undefined;
  const spotRow = list.find((x) => /^TXF-[SP]$/.test(String(x?.SymbolID ?? "")));
  const spot = parseNum(spotRow?.CLastPrice);
  const diff = parseNum(q.CDiff);
  const change = Number.isFinite(diff) ? diff : last - ref;
  const t = String(q.CTime ?? "");
  return {
    session, symbol: String(q.SymbolID), last, ref, change, changePct: (change / ref) * 100,
    high: positive(parseNum(q.CHighPrice)), low: positive(parseNum(q.CLowPrice)), volume: positive(parseNum(q.CTotalVolume)), spot: positive(spot),
    date: String(q.CDate ?? ""), time: t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : "",
  };
}
