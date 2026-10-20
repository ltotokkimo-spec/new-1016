// 台股指數盤中即時（證交所 MIS，與即時股價同一個端點）：盤中回傳現值，收盤後回傳收盤。
import { parseNum } from "./twLive";

export interface IndexLive {
  name: string; value: number; prevClose: number; change: number; changePct: number;
  date: string; time: string; final: boolean;
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
    out[name] = {
      name, value, prevClose: prev, change: value - prev,
      changePct: prev > 0 ? (value / prev - 1) * 100 : NaN,
      date: String(m.d ?? ""), time, final: time >= "13:30:00",
    };
  }
  return out;
}
