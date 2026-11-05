// 個股「即時走勢」（當日分時圖）：Yahoo 的 1 分鐘線（上市 .TW、上櫃 .TWO）＋證交所即時價補上最新一分鐘。
// Yahoo 的分鐘線可能比證交所慢幾分鐘，所以最後一段用 App 每 30 秒抓的即時價接上（畫面上標「即時」）。
import type { Fetcher } from "../lib/net";

export interface IntraPoint { m: number; price: number; vol: number } // m＝09:00 起第幾分鐘（0～270），vol＝這一分鐘的成交股數
export interface Intraday { date: string; prevClose: number; points: IntraPoint[]; lastYahoo?: number; est?: { m: number; vol: number }[]; twErr?: string } // est＝沒有分鐘資料的幾分鐘、平均分攤的估計量 // lastYahoo＝Yahoo 最後一筆的分鐘

export const SESSION_MIN = 270; // 09:00～13:30

export const intradayUrl = (code: string, market: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.${market === "TPEX" ? "TWO" : "TW"}?interval=1m&range=1d&includePrePost=false`;

const taipei = (t: number) => new Date(t * 1000 + 8 * 3600e3);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Yahoo 奇摩股市網頁用的即時分時（不延遲）；國際版 query1 的台股分鐘線盤中常延遲約 20 分鐘 */
export const intradayUrlTw = (code: string, market: string) =>
  `https://tw.stock.yahoo.com/_td-stock/api/resource/FinanceChartService.ApacheChartVOL;period=1d;symbols=${encodeURIComponent(JSON.stringify([`${code}.${market === "TPEX" ? "TWO" : "TW"}`]))}?intl=tw&lang=zh-Hant-TW&region=TW`;

/** Yahoo chart API（1 分鐘）→ 當日分時；沒有資料回 null。也接受奇摩股市的格式（陣列包著 { chart: { meta, timestamp, indicators } }） */
export function parseIntraday(json: any): Intraday | null {
  const j = Array.isArray(json) ? json[0] : json;
  const r = j?.chart?.result?.[0] ?? (j?.chart?.timestamp ? j.chart : j?.timestamp ? j : undefined);
  const ts: number[] | undefined = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  const prevClose = Number(r?.meta?.chartPreviousClose ?? r?.meta?.previousClose ?? r?.meta?.regularMarketPreviousClose);
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
  // 有的來源給的是「累計成交量」：整段都沒有變少就換成每分鐘的量
  if (points.length >= 10 && points.every((p, i) => !i || p.vol >= points[i - 1].vol) && points.at(-1)!.vol > points[0].vol * 5) {
    for (let i = points.length - 1; i > 0; i--) points[i] = { ...points[i], vol: points[i].vol - points[i - 1].vol };
  }
  return { date, prevClose, points, lastYahoo: points[points.length - 1].m };
}

/** 兩個來源都抓，取比較新的（日期較新、或同一天分鐘較晚）；src 記下用了哪個（除錯用） */
export async function fetchIntraday(fetcher: Fetcher, code: string, market: string): Promise<(Intraday & { src?: string }) | null> {
  const [tw, intl] = await Promise.allSettled([fetcher(intradayUrlTw(code, market)).then(parseIntraday), fetcher(intradayUrl(code, market)).then(parseIntraday)]);
  const a = tw.status === "fulfilled" ? tw.value : null, b = intl.status === "fulfilled" ? intl.value : null;
  if (!a && !b) {
    const e = [tw, intl].find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
    if (e) throw e.reason;
    return null;
  }
  const newer = (x: Intraday, y: Intraday) => x.date !== y.date ? x.date > y.date : (x.lastYahoo ?? -1) >= (y.lastYahoo ?? -1);
  const twErr = tw.status === "rejected" ? String((tw.reason as any)?.message ?? tw.reason).slice(0, 60) : a ? "" : "格式不符或沒有資料";
  if (a && (!b || newer(a, b))) return { ...a, src: "tw" };
  return { ...b!, src: "intl", twErr };
}

/** 即時價的分鐘（09:00 起），收盤後的時間算 270 */
export function minuteOf(time: string): number {
  const [h, mm] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return NaN;
  return Math.min(SESSION_MIN, Math.max(0, (h - 9) * 60 + mm));
}

/**
 * 把證交所即時價接到分時圖最後：同一天才接；那一分鐘已經有就換成最新價，沒有就新增一點。
 * ticks：這次打開畫面以來記下的即時價（含當時的累計成交股數 cum）。Yahoo 落後時，中間這段用它補。
 * 成交量：每次即時價的累計量減掉上一次（或圖上分鐘線的合計），就是這段時間的量；
 * 如果中間隔了好幾分鐘沒有資料，這段量平均分到那幾分鐘（est，畫成淡色量柱），不會全部堆在最後一根。
 */
export function mergeLive(d: Intraday | null, live: { date: string; time?: string; price: number; prevClose: number; volume?: number } | undefined, ticks: { m: number; price: number; cum?: number }[] = []): Intraday | null {
  if (!live || !(live.price > 0) || !live.time) return d;
  if (live.time < "09:00") return d; // 開盤前證交所回的是「今天日期＋昨收」，不是成交：照舊畫上一個交易日的走勢
  if (d && d.date && live.date && live.date !== d.date) {
    // 即時價是新的一天（Yahoo 還是昨天）：只畫即時價
    if (live.date > d.date) d = null; else return d;
  }
  const base: Intraday = d ? { ...d, points: [...d.points], est: [] } : { date: live.date, prevClose: live.prevClose, points: [], est: [] };
  if (!(base.prevClose > 0)) base.prevClose = live.prevClose;
  const last = base.points.at(-1)?.m ?? -1;
  let cum = base.points.reduce((a, p) => a + p.vol, 0), prevM = last;
  const add = (m: number, price: number, c?: number) => {
    let v = c && c > cum ? c - cum : 0;
    if (c && c > cum) cum = c;
    if (v > 0 && m - prevM > 1) { // 中間沒資料的幾分鐘：量平均分攤（估計）
      const per = v / (m - prevM);
      for (let k = Math.max(0, prevM + 1); k < m; k++) base.est!.push({ m: k, vol: per });
      v = per;
    }
    const i = base.points.findIndex((p) => p.m === m);
    if (i >= 0) base.points[i] = { m, price, vol: base.points[i].vol + v };
    else base.points.push({ m, price, vol: v });
    prevM = Math.max(prevM, m);
  };
  for (const t of [...ticks].sort((x, y) => x.m - y.m)) if (t.m > last) add(t.m, t.price, t.cum);
  const m = minuteOf(live.time);
  if (Number.isFinite(m) && m >= (base.points.at(-1)?.m ?? -1)) add(m, live.price, live.volume);
  base.points.sort((x, y) => x.m - y.m);
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

/**
 * 分時快取：同一檔在一段時間內不重抓（盤中 50 秒、非盤中 30 分鐘），同時間的重複請求合併成一次。
 * 個股頁切到下一檔再切回來直接用快取；也用來預先載入清單裡前後幾檔。
 */
type CacheEntry = { at: number; d: (Intraday & { src?: string }) | null; p?: Promise<(Intraday & { src?: string }) | null> };
const intraCache = new Map<string, CacheEntry>();
export const cachedIntraday = (code: string) => intraCache.get(code);
export function loadIntraday(fetcher: Fetcher, code: string, market: string, maxAgeMs: number, now = Date.now()): Promise<(Intraday & { src?: string }) | null> {
  const c = intraCache.get(code);
  if (c?.p) return c.p;
  if (c && now - c.at < maxAgeMs) return Promise.resolve(c.d);
  const p = fetchIntraday(fetcher, code, market).then(
    (d) => { intraCache.set(code, { at: Date.now(), d }); return d; },
    (e) => { if (c) intraCache.set(code, { at: c.at, d: c.d }); else intraCache.delete(code); throw e; },
  );
  intraCache.set(code, { at: c?.at ?? 0, d: c?.d ?? null, p });
  return p;
}
export const clearIntradayCache = () => intraCache.clear();
