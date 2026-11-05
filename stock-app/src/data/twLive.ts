// 證交所「基本市況報導」即時報價（mis.twse.com.tw），上市、上櫃都可以查；收盤後回傳當天收盤價。
// 不知道代號是上市還是上櫃，所以兩種都問，查不到的會自動略過。
import { limitState, type Limit } from "../lib/limit";

export interface LiveQuote {
  code: string; name: string;
  price: number; // 最新成交價（盤中沒成交時用最佳買價，再不然用昨收）
  prevClose: number; open: number; high: number; low: number;
  date: string; // YYYYMMDD
  time: string; // HH:MM:SS
  final: boolean; // 13:30 收盤後的價格（美股：不在正常交易時段）
  limit?: Limit; // 價格在漲停價（up）或跌停價（down）：畫面亮紅燈／綠燈
  trial?: boolean; // 台股開盤前（08:30～09:00）的試搓價：還沒有成交，price 是試算的開盤價，成交後才是真的
  session?: "盤中" | "收盤"; // 美股才有：price 是正常交易時段的最新價（盤中），或已經收盤的價格；盤前／盤後的成交在 ext
  // 美股才有：時間已換成台北時間；盤前／盤後的成交
  ext?: { label: "盤前" | "盤後"; price: number; chg: number; time: string };
  // 美股才有：最近一筆盤前或盤後成交（現在不在盤前／盤後也保留；date 是紐約日期 YYYYMMDD）
  xq?: { label: "盤前" | "盤後"; price: number; chg: number; time: string; date: string };
  volume?: number; // 當日累積成交量（股）；台股由證交所 mis 的 v（張）× 1000
}

export const liveUrl = (codes: string[]) =>
  `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=${codes.flatMap((c) => [`tse_${c}.tw`, `otc_${c}.tw`]).join("|")}`;

export const parseNum = (s: unknown) => { const n = parseFloat(String(s ?? "")); return Number.isFinite(n) && n > 0 ? n : NaN; };
const num = parseNum;
const first = (s: unknown) => num(String(s ?? "").split("_")[0]);
/** 五檔裡第一個有價格的（賣價第一檔常是 0＝市價單，要跳過） */
const firstPos = (s: unknown) => { for (const x of String(s ?? "").split("_")) { const n = num(x); if (Number.isFinite(n)) return n; } return NaN; };

export function parseLive(json: any): Record<string, LiveQuote> {
  const out: Record<string, LiveQuote> = {};
  for (const m of json?.msgArray ?? []) {
    const code = String(m.c ?? "");
    const prev = num(m.y);
    const time = String(m.t ?? "");
    let price = num(m.z);
    // 開盤前（09:00 以前）還沒有成交（z 是 "-"），證交所把「試搓價」放在 pz；這時顯示試搓價，不是昨天的收盤
    const trialPx = num(m.pz);
    const trial = !Number.isFinite(price) && Number.isFinite(trialPx) && time < "09:00:00";
    if (trial) price = trialPx;
    // 這一筆快照沒有成交價（z 是 "-"，盤中很常見）：先用最佳買價；鎖跌停時沒有買單，改用最佳賣價（就是跌停價），
    // 都沒有才用昨收——以前直接退回昨收，鎖跌停的股票會顯示「今日 0.0%」
    if (!Number.isFinite(price)) price = first(m.b);
    if (!Number.isFinite(price)) price = firstPos(m.b);
    if (!Number.isFinite(price)) price = firstPos(m.a);
    if (!Number.isFinite(price)) price = prev;
    if (!code || !Number.isFinite(price)) continue;
    // 漲停價 u、跌停價 w 是證交所給的；沒有就用規則算（ETF 代號 00 開頭，升降單位不同）
    const up = num(m.u), dn = num(m.w);
    const limit: Limit | undefined = Number.isFinite(up) && price >= up - 1e-6 ? "up" : Number.isFinite(dn) && price <= dn + 1e-6 ? "down" : Number.isFinite(up) || Number.isFinite(dn) ? undefined : limitState(price, prev, /^00\d/.test(code));
    out[code] = { code, name: String(m.n ?? code), price, prevClose: prev, open: num(m.o), high: num(m.h), low: num(m.l), date: String(m.d ?? ""), time, final: time >= "13:30:00", volume: num(m.v) * 1000, ...(trial ? { trial: true } : {}), ...(limit ? { limit } : {}) };
  }
  return out;
}

/** 台北時間是不是在開盤前試搓時段（平日 8:30～9:00） */
export function preOpen(now = Date.now()): boolean {
  const d = new Date(now + 8 * 3600_000);
  const w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return w >= 1 && w <= 5 && m >= 8 * 60 + 30 && m < 9 * 60;
}

/** 要不要定時更新台股即時報價：試搓時段加上交易時段（8:30～13:35） */
export const livePolling = (now = Date.now()) => preOpen(now) || marketOpen(now);

/** 這筆即時報價現在還算「即時」：今天的、還沒收盤；交易時段，或開盤前的試搓價 */
export function isLiveNow(q: LiveQuote, today: string, now = Date.now()): boolean {
  return !q.final && q.date === today && (marketOpen(now) || (q.trial === true && preOpen(now)));
}

/** 台北時間是不是在交易時段（平日 9:00～13:35，含收盤集合競價後幾分鐘） */
export function marketOpen(now = Date.now()): boolean {
  const d = new Date(now + 8 * 3600_000);
  const w = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return w >= 1 && w <= 5 && m >= 9 * 60 && m <= 13 * 60 + 35;
}
