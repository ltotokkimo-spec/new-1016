// 證交所「ETF 即時預估淨值與折溢價」（mis.twse.com.tw/stock/data/all_etf.txt）：全部 ETF 一次回傳（上市與上櫃、依投信分組），
// 盤中是投信即時預估淨值（約 15 秒更新），收盤後是當天最終數字。
import { parseNum } from "./twLive";

/** 折溢價可以是負數（parseNum 只收正數） */
const signed = (x: unknown) => { const n = parseFloat(String(x ?? "")); return Number.isFinite(n) ? n : NaN; };

export const ETF_NAV_URL = "https://mis.twse.com.tw/stock/data/all_etf.txt";

export interface EtfNav {
  code: string; name: string;
  price: number; // 市價
  nav: number; // 預估淨值
  premium: number; // 折溢價（%），正＝溢價（市價高於淨值）
  prevNav: number; // 前日淨值
  date: string; // YYYYMMDD
  time: string; // HH:MM:SS
}

/** 回傳 代號 → 資料；沒有預估淨值（或淨值 ≤ 0）的 ETF 略過 */
export function parseEtfNav(json: any): Record<string, EtfNav> {
  const out: Record<string, EtfNav> = {};
  for (const g of json?.a1 ?? []) {
    for (const m of g?.msgArray ?? []) {
      const code = String(m?.a ?? "").trim();
      const price = parseNum(m?.e), nav = parseNum(m?.f);
      if (!code || !(nav > 0)) continue;
      const given = signed(m?.g);
      out[code] = {
        code, name: String(m?.b ?? "").trim(), price, nav,
        premium: Number.isFinite(given) ? given : Number.isFinite(price) ? (price / nav - 1) * 100 : NaN,
        prevNav: parseNum(m?.h), date: String(m?.i ?? ""), time: String(m?.j ?? ""),
      };
    }
  }
  return out;
}
