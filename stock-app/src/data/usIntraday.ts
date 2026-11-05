// 美股「即時走勢」：Yahoo 1 分鐘線含盤前、盤後（includePrePost），時間用美東時間。
// 橫軸從美東 04:00（盤前開始）到 20:00（盤後結束），共 960 分鐘；盤中 9:30～16:00。
import type { Fetcher } from "../lib/net";
import type { IntraPoint } from "./intraday";

export interface UsIntraday {
  date: string; // 美東日期 YYYYMMDD
  prevClose: number; // 前一交易日盤中收盤
  points: IntraPoint[]; // m＝美東 04:00 起第幾分鐘（0～960）
  regStart: number; // 盤中開始（預設 330＝9:30）
  regEnd: number; // 盤中結束（預設 720＝16:00）
  tz: number; // 美東與 UTC 的時差（秒，夏令 -14400、冬令 -18000）
}

export const US_SPAN = 960;
export const US_PRE = "盤前", US_REG = "盤中", US_POST = "盤後";

/** Yahoo 的代號：BRK.B → BRK-B */
export const usIntradayUrl = (code: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code.replace(/\./g, "-"))}?interval=1m&range=1d&includePrePost=true`;

const localMin = (t: number, tz: number) => { const d = new Date((t + tz) * 1000); return (d.getUTCHours() - 4) * 60 + d.getUTCMinutes(); };

export function parseUsIntraday(json: any): UsIntraday | null {
  const r = json?.chart?.result?.[0];
  const ts: number[] | undefined = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  const meta = r?.meta ?? {};
  const prevClose = Number(meta.chartPreviousClose ?? meta.previousClose ?? meta.regularMarketPreviousClose);
  if (!ts?.length || !q || !(prevClose > 0)) return null;
  const tz = Number.isFinite(Number(meta.gmtoffset)) ? Number(meta.gmtoffset) : -18000;
  const reg = meta.currentTradingPeriod?.regular;
  const regStart = reg?.start ? localMin(reg.start, tz) : 330;
  const regEnd = reg?.end ? localMin(reg.end, tz) : 720;
  const byMin = new Map<number, IntraPoint>();
  let date = "";
  ts.forEach((t, i) => {
    const c = q.close?.[i];
    if (c == null || !(c > 0)) return;
    const m = localMin(t, tz);
    if (m < 0 || m > US_SPAN) return;
    const d = new Date((t + tz) * 1000);
    date = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    const v = q.volume?.[i] > 0 ? Number(q.volume[i]) : 0;
    const p = byMin.get(m);
    byMin.set(m, { m, price: Number(c), vol: (p?.vol ?? 0) + v });
  });
  const points = [...byMin.values()].sort((a, b) => a.m - b.m);
  if (!points.length) return null;
  return { date, prevClose, points, regStart: regStart > 0 && regStart < US_SPAN ? regStart : 330, regEnd: regEnd > regStart && regEnd <= US_SPAN ? regEnd : 720, tz };
}

export async function fetchUsIntraday(fetcher: Fetcher, code: string): Promise<UsIntraday | null> {
  return parseUsIntraday(await fetcher(usIntradayUrl(code)));
}

export const usSessionOf = (d: Pick<UsIntraday, "regStart" | "regEnd">, m: number) => (m < d.regStart ? US_PRE : m < d.regEnd ? US_REG : US_POST);

/** 每個時段的最後價、漲跌（盤前對照昨收；盤中對照昨收；盤後對照今天盤中收盤），以及盤中最高最低與成交量 */
export function usSessionStats(d: UsIntraday) {
  const seg = (a: number, b: number) => d.points.filter((p) => p.m >= a && p.m < b);
  const pre = seg(0, d.regStart), reg = seg(d.regStart, d.regEnd), post = seg(d.regEnd, US_SPAN + 1);
  const regClose = reg.at(-1)?.price;
  const one = (pts: typeof pre, ref: number | undefined) => (pts.length && ref ? { last: pts.at(-1)!.price, chg: pts.at(-1)!.price / ref - 1 } : undefined);
  return {
    pre: one(pre, d.prevClose),
    reg: one(reg, d.prevClose),
    post: one(post, regClose ?? d.prevClose),
    regHigh: reg.length ? Math.max(...reg.map((p) => p.price)) : undefined,
    regLow: reg.length ? Math.min(...reg.map((p) => p.price)) : undefined,
    regVol: reg.reduce((a, p) => a + p.vol, 0),
    extVol: [...pre, ...post].reduce((a, p) => a + p.vol, 0),
  };
}

/** 美東分鐘（04:00 起）→ "HH:MM" */
export const usClock = (m: number) => `${String(4 + Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
/** 美東分鐘 → 台北 "HH:MM"（tz 秒） */
export const usToTaipei = (m: number, tz: number) => {
  const total = ((4 * 60 + m - tz / 60 + 8 * 60) % 1440 + 1440) % 1440 - 0;
  // tz 是美東相對 UTC（例如 -18000＝-5 小時）：台北＝美東 −tz＋8 小時
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};
