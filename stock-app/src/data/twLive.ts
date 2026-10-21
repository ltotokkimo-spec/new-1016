// 證交所「基本市況報導」即時報價（mis.twse.com.tw），上市、上櫃都可以查；收盤後回傳當天收盤價。
// 不知道代號是上市還是上櫃，所以兩種都問，查不到的會自動略過。
export interface LiveQuote {
  code: string; name: string;
  price: number; // 最新成交價（盤中沒成交時用最佳買價，再不然用昨收）
  prevClose: number; open: number; high: number; low: number;
  date: string; // YYYYMMDD
  time: string; // HH:MM:SS
  final: boolean; // 13:30 收盤後的價格（美股：不在正常交易時段）
  // 美股才有：時間已換成台北時間；盤前／盤後的成交
  ext?: { label: "盤前" | "盤後"; price: number; chg: number; time: string };
  volume?: number; // 美股：當日成交量（股）
}

export const liveUrl = (codes: string[]) =>
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join("|")}`;

export const parseNum = (s: unknown) => { const n = parseFloat(String(s ?? "")); return Number.isFinite(n) && n > 0 ? n : NaN; };
const num = parseNum;
const first = (s: unknown) => num(String(s ?? "").split("_")[0]);

export function parseLive(json: any): Record<string, LiveQuote> {
  const out: Record<string, LiveQuote> = {};
  for (const m of json?.msgArray ?? []) {
    const code = String(m.c ?? "");
    const prev = num(m.y);
    let price = num(m.z);
    if (!Number.isFinite(price)) price = first(m.b);
    if (!Number.isFinite(price)) price = prev;
    if (!code || !Number.isFinite(price)) continue;
    const time = String(m.t ?? "");
    out[code] = { code, name: String(m.n ?? code), price, prevClose: prev, open: num(m.o), high: num(m.h), low: num(m.l), date: String(m.d ?? ""), time, final: time >= "13:30:00" };
  }
  return out;
}

/** 台北時間是不是在交易時段（平日 9:00～13:35，含收盤集合競價後幾分鐘） */
export function marketOpen(now = Date.now()): boolean {
  const d = new Date(now + 8 * 3600_000);
  const w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return w >= 1 && w <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
}
