// 盤中成交量排名的資料：證交所「基本市況報導」即時報價（App 盤中即時價用的同一個來源，約每 5 秒更新），
// 依上市／上櫃分別問（tse_／otc_），每次 100 檔（11/13 使用者選 A：從 60 檔加大，候選 240 檔只要問 3 次），照證交所的頻率限制一批一批抓。
import { fetchJson } from "../lib/net";
import { parseLive, type LiveQuote } from "./twLive";

export const rankUrl = (xs: { code: string; market: string }[]) =>
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${xs.map((x) => `${x.market === "TPEX" ? "otc" : "tse"}_${x.code}.tw`).join("|")}`;

const BATCH = 100;

/** 抓整個候選名單的即時報價；某一批失敗就略過（回傳 failed 批數） */
export async function fetchRankQuotes(pool: { code: string; market: string }[]): Promise<{ quotes: Record<string, LiveQuote>; failed: number; total: number }> {
  const t0 = Date.now();
  const quotes: Record<string, LiveQuote> = {};
  let failed = 0;
  const total = Math.ceil(pool.length / BATCH);
  for (let i = 0; i < pool.length; i += BATCH) {
    try { Object.assign(quotes, parseLive(await fetchJson(rankUrl(pool.slice(i, i + BATCH))))); } catch { failed++; }
  }
  (globalThis as any).__srRank = { ms: Date.now() - t0, total, failed, n: Object.keys(quotes).length, pool: pool.length, at: Date.now() }; // 測試看每輪花多久
  return { quotes, failed, total };
}
