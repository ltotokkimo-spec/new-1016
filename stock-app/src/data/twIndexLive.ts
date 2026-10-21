// 台股指數盤中即時（證交所 MIS，與即時股價同一個端點）：盤中回傳現值，收盤後回傳收盤。
import { parseNum } from "./twLive";

export interface IndexLive {
  name: string; value: number; prevClose: number; change: number; changePct: number;
  date: string; time: string; final: boolean;
  // 大盤量能（只有加權指數帶）：單位已用官方每日量值對準
  volShares?: number; // 累計成交量（股）
  trades?: number; // 累計成交筆數
  high?: number; low?: number; // 今日指數高低
}

// 顯示名稱 → MIS ex_ch（順序＝畫面顯示順序）
export const INDEX_CH: { name: string; ch: string }[] = [
  { name: "加權指數", ch: "tse_t00.tw" },
  { name: "臺灣50指數", ch: "tse_TW50.tw" },
  { name: "半導體類指數", ch: "tse_t24.tw" },
  { name: "金融保險類指數", ch: "tse_t17.tw" },
  { name: "電子類指數", ch: "tse_t13.tw" },
  { name: "櫃買指數", ch: "otc_o00.tw" },
];
const BY_CH = new Map(INDEX_CH.map((x) => [x.ch, x.name]));

export const indexLiveUrl = () =>
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${INDEX_CH.map((x) => x.ch).join("|")}`;

export function parseIndexLive(json: any): Record<string, IndexLive> {
  const out: Record<string, IndexLive> = {};
  for (const m of json?.msgArray ?? []) {
    const ch = `${m.ex}_${m.ch}`;
    const name = BY_CH.get(ch);
    if (!name) continue;
    const prev = parseNum(m.y);
    let value = parseNum(m.z);
    if (!Number.isFinite(value)) value = prev; // 開盤前沒有現值，先用昨收
    if (!Number.isFinite(value) || !Number.isFinite(prev)) continue;
    const time = String(m.t ?? "");
    const lots = parseFloat(String(m.m ?? "")); // 累計成交量（張），1 張 = 1000 股
    const tr = parseFloat(String(m.r ?? "")); // 累計成交筆數
    const hi = parseFloat(String(m.h ?? "")), lo = parseFloat(String(m.l ?? ""));
    out[name] = {
      name, value, prevClose: prev, change: value - prev,
      changePct: prev > 0 ? (value / prev - 1) * 100 : NaN,
      date: String(m.d ?? ""), time, final: time >= "13:30:00",
      volShares: Number.isFinite(lots) && lots > 0 ? lots * 1000 : undefined,
      trades: Number.isFinite(tr) && tr > 0 ? tr : undefined,
      high: Number.isFinite(hi) && hi > 0 ? hi : undefined,
      low: Number.isFinite(lo) && lo > 0 ? lo : undefined,
    };
  }
  return out;
}
