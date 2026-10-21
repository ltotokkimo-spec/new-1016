// 美股：大型股＋產業 ETF 的 6~9 個月日K（Nasdaq），每天快取一次。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { addDays, dash, taipeiToday, usLatestSession, usSessionDay } from "../lib/dates";
import { parseUsLive, usLiveUrl } from "./usLive";
import {
  nasdaqInfoUrl, nasdaqSummaryUrl, nasdaqUrl, parseNasdaqHistory, parseNasdaqName, parseNasdaqSector, retN, sma,
  US_SECTOR_ETF, US_UNIVERSE, type Bar, type UsExtra,
} from "./us";
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
    // 快取以「美股資料日」為準：紐約收盤後換新的一天，台北凌晨抓的舊資料在清晨收盤後會重抓
    const key = `us:h:${symbol}:${usSessionDay(this.now())}`;
    const hit = await this.kv.get<Bar[]>(key);
    if (hit) return hit;
    // Nasdaq 還沒補上最新一天時，暫存 30 分鐘就好，之後重抓（不要把舊資料存成今天的）
    const staleKey = `us:hs:${symbol}`;
    const stale = await this.kv.get<{ at: number; bars: Bar[] }>(staleKey);
    if (stale && this.now() - stale.at < 30 * 60_000) return stale.bars;
    this.requests++;
    const bars = parseNasdaqHistory(await this.fetch(nasdaqUrl(symbol, etf ? "etf" : "stocks", dash(addDays(today, -280)), dash(today))));
    if (!bars.length) return bars;
    if (bars[bars.length - 1].date >= usLatestSession(this.now())) { await this.kv.set(key, bars); await this.kv.del(staleKey); }
    else await this.kv.set(staleKey, { at: this.now(), bars });
    return bars;
  }

  /** 查一檔不在清單裡的美股：先當股票查，沒有再當 ETF 查；確定查不到回 null，網路錯誤則丟出錯誤 */
  async lookup(symbol: string): Promise<UsExtra | null> {
    let netError: unknown = null;
    for (const etf of [false, true]) {
      let bars: Bar[] = [];
      try { bars = await this.history(symbol, etf); } catch (e) { netError = e; continue; }
      if (bars.length < 1) continue; // 剛上市的股票資料少也沒關係，至少有現價可以算損益
      const cls = etf ? "etf" : "stocks";
      const [info, summary] = await Promise.all([
        this.fetch(nasdaqInfoUrl(symbol, cls)).catch(() => null),
        this.fetch(nasdaqSummaryUrl(symbol, cls)).catch(() => null),
      ]);
      return { symbol, name: parseNasdaqName(info) || symbol, sector: etf ? "ETF" : parseNasdaqSector(summary), etf };
    }
    if (netError) throw netError;
    return null;
  }

  /**
   * 收盤後 Nasdaq 日K 有時還沒補上當天：用 CNBC 的正式收盤（開高低收）補一根，
   * 讓評分、資料日與今日漲跌都對到最新收盤。盤中（還沒收盤）不補。
   */
  async patchLatest(bars: Record<string, Bar[]>) {
    const want = usLatestSession(this.now());
    const need = Object.keys(bars).filter((s) => bars[s].length && bars[s][bars[s].length - 1].date < want);
    if (!need.length) return;
    for (let i = 0; i < need.length; i += 20) {
      let q: ReturnType<typeof parseUsLive> = {};
      try { q = parseUsLive(await this.fetch(usLiveUrl(need.slice(i, i + 20)))); } catch { continue; }
      for (const sym of need.slice(i, i + 20)) {
        const x = q[sym], b = bars[sym];
        if (!x || !x.final || x.date !== want || x.date <= b[b.length - 1].date) continue;
        const open = Number.isFinite(x.open) ? x.open : x.price, high = Number.isFinite(x.high) ? x.high : x.price, low = Number.isFinite(x.low) ? x.low : x.price;
        bars[sym] = [...b, { date: x.date, open, high, low, close: x.price, volume: x.volume ?? b[b.length - 1].volume }];
      }
    }
  }

  async load(progress: Progress = () => {}, extra: UsExtra[] = []): Promise<UsSnapshot> {
    const etfs = Object.entries(US_SECTOR_ETF);
    const known = new Set(US_UNIVERSE.map((u) => u.symbol));
    const extras = extra.filter((x) => !known.has(x.symbol));
    const universe = [...US_UNIVERSE, ...extras];
    const jobs: { symbol: string; etf: boolean }[] = [
      { symbol: "SPY", etf: true },
      ...etfs.map(([, s]) => ({ symbol: s, etf: true })),
      ...US_UNIVERSE.map((u) => ({ symbol: u.symbol, etf: false })),
      ...extras.map((u) => ({ symbol: u.symbol, etf: u.etf })),
    ];
    const bars: Record<string, Bar[]> = {};
    const failed: string[] = [];
    let done = 0;
    const worker = async () => {
      while (jobs.length) {
        const j = jobs.shift()!;
        try {
          bars[j.symbol] = await this.history(j.symbol, j.etf);
          if (!bars[j.symbol].length) failed.push(j.symbol);
        } catch { failed.push(j.symbol); }
        progress(++done, 1 + etfs.length + universe.length, `美股 ${j.symbol}`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    await this.patchLatest(bars);
    const spy = bars["SPY"] ?? [];
    if (!spy.length) throw new Error("美股資料下載失敗，請稍後再試");
    const spy1m = retN(spy, 21);
    const stocks: StockInput[] = [];
    const extraSet = new Set(extras.map((x) => x.symbol));
    for (const u of universe) {
      const b = bars[u.symbol];
      // 預設清單要有足夠的日K才評分；自己加的股票資料少也列入（有現價就能算損益，報酬不足時不評分）
      if (!b || b.length < (extraSet.has(u.symbol) ? 1 : 70)) continue;
      const last = b[b.length - 1];
      const ma20 = sma(b, 20), ma50 = sma(b, 50);
      stocks.push({
        code: u.symbol, name: u.name, market: "US", sector: u.sector, close: last.close,
        value: last.close * last.volume,
        // 日K不到 70 天（剛上市）：只提供現價算損益，近1月報酬設為無資料，評分時就會略過，不會被誤判成跌破均線
        ret1w: retN(b, 5), ret1m: b.length >= 70 ? retN(b, 21) : NaN, ret3m: retN(b, 63),
        chg1d: b.length >= 2 && b[b.length - 2].close > 0 ? last.close / b[b.length - 2].close - 1 : undefined,
        aboveMa50: last.close > ma50, ma20AboveMa50: ma20 > ma50, rsVsIndex1m: retN(b, 21) - spy1m,
      });
    }
    const sectorEtfs = etfs.map(([sector, symbol]) => {
      const b = bars[symbol] ?? [];
      return { sector, symbol, ret1w: retN(b, 5), ret1m: retN(b, 21), ret3m: retN(b, 63) };
    });
    // 清掉前幾天的快取
    const day = usSessionDay(this.now());
    for (const k of await this.kv.keys()) {
      const m = /^us:h:.+:(\d{8})$/.exec(k);
      if (m && m[1] < day) await this.kv.del(k);
    }
    return { asOf: spy[spy.length - 1].date, stocks, bars, sectorEtfs, failed, fetchedAt: this.now() };
  }
}
