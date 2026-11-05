// 個股「即時走勢」（當日分時圖）：Yahoo 的 1 分鐘線（上市 .TW、上櫃 .TWO）＋證交所即時價補上最新一分鐘。
// Yahoo 的分鐘線可能比證交所慢幾分鐘，所以最後一段用 App 每 30 秒抓的即時價接上（畫面上標「即時」）。
import type { Fetcher } from "../lib/net";

export interface IntraPoint { m: number; price: number; vol: number } // m＝09:00 起第幾分鐘（0～270），vol＝這一分鐘的成交股數
export interface Intraday { date: string; prevClose: number; points: IntraPoint[]; lastYahoo?: number } // lastYahoo＝Yahoo 最後一筆的分鐘

export const SESSION_MIN = 270; // 09:00～13:30

export const intradayUrl = (code: string, market: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.${market === "TPEX" ? "TWO" : "TW"}?interval=1m&range=1d&includePrePost=false`;

const taipei = (t: number) => new Date(t * 1000 + 8 * 3600e3);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Yahoo chart API（1 分鐘）→ 當日分時；沒有資料回 null */
export function parseIntraday(json: any): Intraday | null {
  const r = json?.chart?.result?.[0];
  const ts: number[] | undefined = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  const prevClose = Number(r?.meta?.chartPreviousClose ?? r?.meta?.previousClose);
  if (!ts?.length || !q || !(prevClose > 0)) return null;
  const byMin = new Map<number, IntraPoint>();
  let date = "";
  ts.forEach((t, i) => {
    const c = q.close?.[i];
    if (c == null || !(c > 0)) return;
    const d = taipei(t);
    const m = (d.getUTCHours() - 9) * 60 + d.getUTCMinutes();
    if (m < 0 || m > SESSION_MIN) return;
    date = ymd(d);
    const v = q.volume?.[i] > 0 ? Number(q.volume[i]) : 0;
    const p = byMin.get(m);
    byMin.set(m, { m, price: Number(c), vol: (p?.vol ?? 0) + v });
  });
  const points = [...byMin.values()].sort((a, b) => a.m - b.m);
  if (!points.length) return null;
  return { date, prevClose, points, lastYahoo: points[points.length - 1].m };
}

export async function fetchIntraday(fetcher: Fetcher, code: string, market: string): Promise<Intraday | null> {
  return parseIntraday(await fetcher(intradayUrl(code, market)));
}

/** 即時價的分鐘（09:00 起），收盤後的時間算 270 */
export function minuteOf(time: string): number {
  const [h, mm] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return NaN;
  return Math.min(SESSION_MIN, Math.max(0, (h - 9) * 60 + mm));
}

/**
 * 把證交所即時價接到分時圖最後：同一天才接；那一分鐘已經有就換成最新價，沒有就新增一點。
 * 成交量：即時的累計成交股數減掉圖上已有的合計，剩下的算在最新一分鐘（不會是負的）。
 * ticks：這次打開畫面以來每 30 秒記下的即時價（Yahoo 落後時，中間這段用它補）。
 */
export function mergeLive(d: Intraday | null, live: { date: string; time?: string; price: number; prevClose: number; volume?: number } | undefined, ticks: { m: number; price: number }[] = []): Intraday | null {
  if (!live || !(live.price > 0) || !live.time) return d;
  if (live.time < "09:00") return d; // 開盤前證交所回的是「今天日期＋昨收」，不是成交：照舊畫上一個交易日的走勢
  if (d && d.date && live.date && live.date !== d.date) {
    // 即時價是新的一天（Yahoo 還是昨天）：只畫即時價
    if (live.date > d.date) d = null; else return d;
  }
  const base: Intraday = d ? { ...d, points: [...d.points] } : { date: live.date, prevClose: live.prevClose, points: [] };
  if (!(base.prevClose > 0)) base.prevClose = live.prevClose;
  const last = base.points.at(-1)?.m ?? -1;
  for (const t of ticks) if (t.m > last && !base.points.some((p) => p.m === t.m)) base.points.push({ m: t.m, price: t.price, vol: 0 });
  base.points.sort((a, b) => a.m - b.m);
  const m = minuteOf(live.time);
  if (!Number.isFinite(m)) return base;
  const have = base.points.reduce((a, p) => a + p.vol, 0);
  const extra = live.volume && live.volume > have ? live.volume - have : 0;
  const i = base.points.findIndex((p) => p.m === m);
  if (i >= 0) base.points[i] = { m, price: live.price, vol: base.points[i].vol + extra };
  else if (m > (base.points.at(-1)?.m ?? -1)) base.points.push({ m, price: live.price, vol: extra });
  return base;
}

/** 均價線：到每一分鐘為止的成交量加權平均價（沒有成交量的點沿用上一個均價） */
export function avgLine(points: IntraPoint[]): number[] {
  let pv = 0, v = 0, lastAvg = NaN;
  return points.map((p) => {
    if (p.vol > 0) { pv += p.price * p.vol; v += p.vol; }
    lastAvg = v > 0 ? pv / v : Number.isFinite(lastAvg) ? lastAvg : p.price;
    return lastAvg;
  });
}

export const clockOf = (m: number) => `${String(9 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
