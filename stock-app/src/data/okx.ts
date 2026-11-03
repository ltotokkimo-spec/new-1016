// 美股 24 小時行情：OKX 上的 xStocks（美股的代幣版本，例如 xAAOI/USDT），美股收盤後、週末也在交易。
// 用 OKX 公開 API（不需帳號）：
// - /api/v5/public/instruments?instType=SPOT：所有現貨交易對（找出某檔美股對應的 xStock 代號）
// - /api/v5/market/ticker：最新價與 24 小時高低量
// - /api/v5/market/candles：15 分／1 時／4 時／1 日 K 線（最新的在最前面）

export const OKX = "https://www.okx.com";
export const okxInstrumentsUrl = () => `${OKX}/api/v5/public/instruments?instType=SPOT`;
export const okxTickerUrl = (instId: string) => `${OKX}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`;
export const okxCandlesUrl = (instId: string, bar: OkxBar, limit = 300) =>
  `${OKX}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=${bar}&limit=${limit}`;

export type OkxBar = "15m" | "1H" | "4H" | "1D";
export const OKX_BARS: { bar: OkxBar; label: string }[] = [
  { bar: "15m", label: "15分" }, { bar: "1H", label: "1時" }, { bar: "4H", label: "4時" }, { bar: "1D", label: "1日" },
];

const okData = (json: any): any[] => (json && String(json.code) === "0" && Array.isArray(json.data) ? json.data : []);
const fin = (x: unknown) => { if (x === null || x === undefined || x === "") return undefined; const n = Number(x); return Number.isFinite(n) ? n : undefined; };

/**
 * 美股代號 → OKX 的 xStock 交易對（instId）。xStocks 的幣名是「x＋代號」（xAAOI），
 * 也接受「代號＋x」；計價優先 USDT，其次 USDC、USD。BRK.B 這類去掉點再比。找不到回傳 undefined。
 */
export function findXStock(json: any, usSymbol: string): string | undefined {
  const s = usSymbol.toUpperCase().replace(/[.\-\/]/g, "");
  if (!s) return undefined;
  const want = new Set([`X${s}`, `${s}X`]);
  const rank = (q: string) => (q === "USDT" ? 0 : q === "USDC" ? 1 : q === "USD" ? 2 : 9);
  const hits = okData(json)
    .filter((d) => want.has(String(d?.baseCcy ?? "").toUpperCase().replace(/[.\-\/]/g, "")) && String(d?.state ?? "live") === "live")
    .sort((a, b) => rank(String(a.quoteCcy).toUpperCase()) - rank(String(b.quoteCcy).toUpperCase()));
  return hits.length && rank(String(hits[0].quoteCcy).toUpperCase()) < 9 ? String(hits[0].instId) : undefined;
}

export interface OkxTicker { last: number; open24h?: number; high24h?: number; low24h?: number; vol24h?: number; amount24h?: number; ts?: number }
export function parseOkxTicker(json: any): OkxTicker | undefined {
  const d = okData(json)[0];
  const last = fin(d?.last);
  if (last === undefined) return undefined;
  return { last, open24h: fin(d.open24h), high24h: fin(d.high24h), low24h: fin(d.low24h), vol24h: fin(d.vol24h), amount24h: fin(d.volCcy24h), ts: fin(d.ts) };
}

/** 毫秒時間 → 台北時間 YYYYMMDDHHmm（K 線圖的時間標籤用） */
export function taipeiStamp(ms: number): string {
  const t = new Date(ms + 8 * 3600_000).toISOString(); // 2026-11-03T09:00:00.000Z
  return t.slice(0, 4) + t.slice(5, 7) + t.slice(8, 10) + t.slice(11, 13) + t.slice(14, 16);
}

/** K 線：[ts, o, h, l, c, vol, ...]，最新在前 → 由舊到新；日期欄位用台北時間 YYYYMMDDHHmm */
export function parseOkxCandles(json: any): { date: string; open: number; high: number; low: number; close: number; volume: number }[] {
  return okData(json)
    .map((r: any) => ({ ts: fin(r?.[0]), open: fin(r?.[1]), high: fin(r?.[2]), low: fin(r?.[3]), close: fin(r?.[4]), volume: fin(r?.[5]) ?? 0 }))
    .filter((b) => b.ts !== undefined && b.open !== undefined && b.high !== undefined && b.low !== undefined && b.close !== undefined)
    .sort((a, b) => a.ts! - b.ts!)
    .map((b) => ({ date: taipeiStamp(b.ts!), open: b.open!, high: b.high!, low: b.low!, close: b.close!, volume: b.volume }));
}
