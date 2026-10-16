// 美股：大型股＋產業 ETF 的 6~9 個月日K（Nasdaq），每天快取一次。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { addDays, dash, taipeiToday } from "../lib/dates";
import { nasdaqUrl, parseNasdaqHistory, retN, sma, US_SECTOR_ETF, US_UNIVERSE, type Bar } from "./us";
import type { StockInput } from "../engine/score";
import type { Progress } from "./twLoader";

export interface UsSnapshot {
  asOf: string;
  stocks: StockInput[];
  bars: Record<string, Bar[]>;
  sectorEtfs: { sector: string; symbol: string; ret1w: number; ret1m: number; ret3m: number }[];
  failed: string[];
  fetchedAt: number;
}

export class UsLoader {
  requests = 0;
  constructor(private fetch: Fetcher, private kv: KV, private now = () => Date.now()) {}

  async history(symbol: string, etf: boolean): Promise<Bar[]> {
    const today = taipeiToday(this.now());
    const key = `us:h:${symbol}:${today}`;
    const hit = await this.kv.get<Bar[]>(key);
    if (hit) return hit;
    this.requests++;
    const bars = parseNasdaqHistory(await this.fetch(nasdaqUrl(symbol, etf ? "etf" : "stocks", dash(addDays(today, -280)), dash(today))));
    if (bars.length) await this.kv.set(key, bars);
    return bars;
  }

  async load(progress: Progress = () => {}): Promise<UsSnapshot> {
    const etfs = Object.entries(US_SECTOR_ETF);
    const jobs: { symbol: string; etf: boolean }[] = [
      { symbol: "SPY", etf: true },
      ...etfs.map(([, s]) => ({ symbol: s, etf: true })),
      ...US_UNIVERSE.map((u) => ({ symbol: u.symbol, etf: false })),
    ];
    const bars: Record<string, Bar[]> = {};
    const failed: string[] = [];
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const j = jobs.shift()!;
        try { bars[j.symbol] = await this.history(j.symbol, j.etf); } catch { failed.push(j.symbol); }
        progress(++done, 1 + etfs.length + US_UNIVERSE.length, `美股 ${j.symbol}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    const spy = bars["SPY"] ?? [];
    if (!spy.length) throw new Error("美股資料下載失敗，請稍後再試");
    const spy1m = retN(spy, 21);
    const stocks: StockInput[] = [];
    for (const u of US_UNIVERSE) {
      const b = bars[u.symbol];
      if (!b || b.length < 70) continue;
      const last = b[b.length - 1];
      const ma20 = sma(b, 20), ma50 = sma(b, 50);
      stocks.push({
        code: u.symbol, name: u.name, market: "US", sector: u.sector, close: last.close,
        value: last.close * last.volume,
        ret1w: retN(b, 5), ret1m: retN(b, 21), ret3m: retN(b, 63),
        aboveMa50: last.close > ma50, ma20AboveMa50: ma20 > ma50, rsVsIndex1m: retN(b, 21) - spy1m,
      });
    }
    const sectorEtfs = etfs.map(([sector, symbol]) => {
      const b = bars[symbol] ?? [];
      return { sector, symbol, ret1w: retN(b, 5), ret1m: retN(b, 21), ret3m: retN(b, 63) };
    });
    // 清掉前幾天的快取
    const today = taipeiToday(this.now());
    for (const k of await this.kv.keys()) {
      const m = /^us:h:.+:(\d{8})$/.exec(k);
      if (m && m[1] < today) await this.kv.del(k);
    }
    return { asOf: spy[spy.length - 1].date, stocks, bars, sectorEtfs, failed, fetchedAt: this.now() };
  }
}
