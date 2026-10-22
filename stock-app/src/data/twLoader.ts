// 台股全市場：找出最近的交易日，下載行情與三大法人，算出每檔的報酬與外資籌碼。
// 過去的交易日資料不會變，存在手機裡；之後每天只需要補新的一天。
import type { Fetcher } from "../lib/net";
import type { KV } from "../lib/kv";
import { addDays, taipeiHour, taipeiToday, weekdaysBack } from "../lib/dates";
import {
  parseTpexCompanies, parseTpexFlows, parseTpexQuotes, parseTwseCompanies, parseTwseFlows, parseTwseQuotes,
  twUrls, type Company, type Flow, type MarketIndex, type Quote, isEtf, etfCategory, isCommonStock,
} from "./tw";
import type { StockInput } from "../engine/score";

export type Progress = (done: number, total: number, label: string) => void;

// 精簡格式存檔：[代號, 名稱, 收盤, 漲跌, 成交金額, 成交股數]
export type QRow = [string, string, number, number, number, number];
export type FRow = [string, number, number, number]; // [代號, 外資, 投信, 自營]

interface DayQuotes { rows: QRow[]; indices?: MarketIndex[] }
const HOLIDAY = { holiday: true } as const;

// tw.ts 的網址函式用本地時間的 Date；這裡用 UTC 午夜建 Date 再轉成「本地同一天」
const localDate = (s: string) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

export interface Breadth { up: number; down: number; flat: number }
export interface TwBreadth { twse: Breadth; tpex: Breadth }

/** 收盤漲跌家數：只算普通股（不含 ETF、權證等），依當日漲跌（元）分上漲、下跌、持平 */
export function countBreadth(twse: QRow[], tpex: QRow[]): TwBreadth {
  const count = (rows: QRow[]): Breadth => {
    const b = { up: 0, down: 0, flat: 0 };
    for (const r of rows) {
      if (!isCommonStock(r[0]) || !Number.isFinite(r[2]) || !Number.isFinite(r[3])) continue;
      if (r[3] > 0) b.up++; else if (r[3] < 0) b.down++; else b.flat++;
    }
    return b;
  };
  return { twse: count(twse), tpex: count(tpex) };
}

export interface TwSnapshot {
  asOf: string; // 最新交易日
  dates: string[]; // 最近 10 個交易日（新到舊）
  ref: { w1: string; m1: string; m3: string }; // 計算報酬的基準日
  stocks: StockInput[];
  indices: MarketIndex[];
  breadth?: TwBreadth; // 最新交易日的收盤漲跌家數
  fetchedAt: number;
  version?: number; // 2 = 含 ETF
}

export const TW_SNAPSHOT_VERSION = 2;

export class TwLoader {
  requests = 0;
  /** 今天的三大法人下午還沒公布時，證交所有時候不回「無資料」而是一直不回應；最多等這麼久，逾時就當作還沒公布，改用前一個交易日 */
  todayWaitMs = 20_000;
  constructor(private fetch: Fetcher, private kv: KV, private now = () => Date.now()) {}

  private async cached<T>(key: string, isFinal: boolean, load: () => Promise<T | null>): Promise<T | null> {
    const hit = await this.kv.get<any>(key);
    if (hit !== undefined) return hit?.holiday ? null : hit;
    this.requests++;
    const v = await load();
    // 今天的資料可能還沒公布，空結果不存；過去的日子空結果＝休市，存起來
    if (v !== null) await this.kv.set(key, v);
    else if (isFinal) await this.kv.set(key, HOLIDAY);
    return v;
  }

  /** 該日是否已確定（今天下午 6 點後才視為已公布完整） */
  private isFinal(ymd: string) {
    const today = taipeiToday(this.now());
    return ymd < today || (ymd === today && taipeiHour(this.now()) >= 18);
  }

  async twseFlows(d: string): Promise<FRow[] | null> {
    return this.cached(`tw2:f:twse:${d}`, this.isFinal(d), async () => {
      const f = parseTwseFlows(await this.fetch(twUrls.twseFlows(localDate(d))));
      return f && f.length ? f.map((x): FRow => [x.code, x.foreign, x.trust, x.dealer]) : null;
    });
  }

  async tpexFlows(d: string): Promise<FRow[] | null> {
    return this.cached(`tw2:f:tpex:${d}`, this.isFinal(d), async () => {
      const f = parseTpexFlows(await this.fetch(twUrls.tpexFlows(localDate(d))));
      return f && f.length ? f.map((x): FRow => [x.code, x.foreign, x.trust, x.dealer]) : null;
    });
  }

  async twseQuotes(d: string): Promise<DayQuotes | null> {
    return this.cached(`tw2:q:twse:${d}`, this.isFinal(d), async () => {
      const r = parseTwseQuotes(await this.fetch(twUrls.twseQuotes(localDate(d))));
      return r && r.quotes.length ? { rows: r.quotes.map(toRow), indices: r.indices } : null;
    });
  }

  async tpexQuotes(d: string): Promise<DayQuotes | null> {
    return this.cached(`tw2:q:tpex:${d}`, this.isFinal(d), async () => {
      const r = parseTpexQuotes(await this.fetch(twUrls.tpexQuotes(localDate(d))));
      return r && r.quotes.length ? { rows: r.quotes.map(toRow) } : null;
    });
  }

  async companies(): Promise<Company[]> {
    const key = `tw:companies:${taipeiToday(this.now()).slice(0, 6)}`; // 每月更新一次
    const hit = await this.kv.get<Company[]>(key);
    if (hit) return hit;
    this.requests += 2;
    const [a, b] = await Promise.all([this.fetch(twUrls.twseCompanies()), this.fetch(twUrls.tpexCompanies())]);
    const list = [...parseTwseCompanies(a), ...parseTpexCompanies(b)];
    if (list.length) await this.kv.set(key, list);
    return list;
  }

  /** 從 target 往前找第一個有資料的交易日 */
  private async firstTradingOnOrBefore(target: string, get: (d: string) => Promise<DayQuotes | null>, limit = 10) {
    for (const d of weekdaysBack(target, limit)) {
      const q = await get(d);
      if (q) return { date: d, q };
    }
    return null;
  }

  async load(progress: Progress = () => {}): Promise<TwSnapshot> {
    const today = taipeiToday(this.now());
    // 1. 最近 10 個交易日（用證交所三大法人判斷，休市日會回「沒有符合條件的資料」）
    const dates: string[] = [];
    const flowsTwse = new Map<string, FRow[]>();
    const flowsTpex = new Map<string, FRow[]>();
    const tpexJobs: Promise<void>[] = []; // 上櫃與上市是不同網站，同時下載
    const candidates = weekdaysBack(today, 25);
    const total = 10 + 8 + 1;
    let step = 0;
    const companiesP = this.companies();
    companiesP.catch(() => {}); // 前面步驟失敗時不要留下未處理的錯誤；後面仍會 await 它
    for (const d of candidates) {
      if (dates.length >= 10) break;
      progress(dates.length, total, `三大法人 ${d.slice(4, 6)}/${d.slice(6)}`);
      // 今天的資料可能還沒公布：無回應或出錯都當作「還沒公布」，不要讓整個更新失敗（下午 2～3 點常遇到）
      const f = d === today
        ? await Promise.race([this.twseFlows(d).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), this.todayWaitMs))])
        : await this.twseFlows(d);
      if (f) {
        dates.push(d); flowsTwse.set(d, f);
        tpexJobs.push(this.tpexFlows(d).then((x) => { if (x) flowsTpex.set(d, x); }));
      }
    }
    if (dates.length < 6) throw new Error("找不到最近的交易資料，請確認網路連線後再試一次");
    await Promise.all(tpexJobs);
    step = 10;
    // 2. 行情：最新日、1 週前、約 1 個月前、約 3 個月前
    const d0 = dates[0];
    const w1 = dates[5];
    progress(step++, total, "公司產業別");
    const companies = await companiesP;
    const get = async (d: string) => {
      progress(step++, total, `行情 ${d.slice(4, 6)}/${d.slice(6)}`);
      const [a, b] = await Promise.all([this.twseQuotes(d), this.tpexQuotes(d)]);
      return a ? { a, b } : null;
    };
    const q0 = await get(d0);
    const qw = await get(w1);
    const m1 = await this.firstTradingOnOrBefore(addDays(d0, -28), (d) => this.twseQuotes(d));
    const m3 = await this.firstTradingOnOrBefore(addDays(d0, -88), (d) => this.twseQuotes(d));
    const qm1 = m1 ? await get(m1.date) : null;
    const qm3 = m3 ? await get(m3.date) : null;
    progress(total, total, "計算中");
    if (!q0) throw new Error("最新行情下載失敗，請稍後再試");

    const stocks = buildTwInputs({
      latest: [...q0.a.rows, ...(q0.b?.rows ?? [])],
      week: rowsOf(qw), month: rowsOf(qm1), quarter: rowsOf(qm3),
      flows: dates.map((d) => [...(flowsTwse.get(d) ?? []), ...(flowsTpex.get(d) ?? [])]),
      companies,
      tpexCodes: new Set((q0.b?.rows ?? []).map((r) => r[0])),
    });
    await this.prune(dates[dates.length - 1], m3?.date);
    return {
      asOf: d0, dates, ref: { w1, m1: m1?.date ?? "", m3: m3?.date ?? "" },
      stocks, indices: q0.a.indices ?? [], breadth: countBreadth(q0.a.rows, q0.b?.rows ?? []), fetchedAt: this.now(), version: TW_SNAPSHOT_VERSION,
    };
  }

  /** 刪掉用不到的舊資料，避免手機空間越用越多 */
  private async prune(oldestFlow: string, oldestQuote?: string) {
    const keepQ = oldestQuote ? addDays(oldestQuote, -10) : "";
    for (const k of await this.kv.keys()) {
      const m = /^tw2?:(f|q):\w+:(\d{8})$/.exec(k);
      if (m && k.startsWith("tw:")) { await this.kv.del(k); continue; } // 舊版快取（不含 ETF）
      if (!m) continue;
      if ((m[1] === "f" && m[2] < addDays(oldestFlow, -14)) || (m[1] === "q" && keepQ && m[2] < keepQ)) await this.kv.del(k);
    }
  }
}

function toRow(q: Quote): QRow {
  return [q.code, q.name, q.close, q.change, q.value, q.volume];
}

function rowsOf(x: { a: DayQuotes; b: DayQuotes | null } | null): QRow[] {
  return x ? [...x.a.rows, ...(x.b?.rows ?? [])] : [];
}

/** 純計算：由各期行情與 10 日法人資料組出評分用的輸入 */
export function buildTwInputs(p: {
  latest: QRow[]; week: QRow[]; month: QRow[]; quarter: QRow[];
  flows: FRow[][]; // 新到舊
  companies: Company[];
  tpexCodes: Set<string>;
}): StockInput[] {
  const closeMap = (rows: QRow[]) => new Map(rows.map((r) => [r[0], r[2]]));
  const wk = closeMap(p.week), mo = closeMap(p.month), qt = closeMap(p.quarter);
  const ind = new Map(p.companies.map((c) => [c.code, c.industry]));
  const flowDays = p.flows.map((rows) => new Map(rows.map((r) => [r[0], r])));
  const ret = (now: number, then: number | undefined) => (then && then > 0 ? now / then - 1 : NaN);

  return p.latest.map(([code, name, close, change, value]) => {
    let foreign5 = 0, foreign10 = 0, trust5 = 0, has = false;
    flowDays.forEach((m, i) => {
      const r = m.get(code);
      if (!r) return;
      has = true;
      if (i < 5) { foreign5 += r[1] || 0; trust5 += r[2] || 0; }
      foreign10 += r[1] || 0;
    });
    // 連續買超／賣超天數（從最新一天往回）
    let streak = 0;
    for (const m of flowDays) {
      const f = m.get(code)?.[1] ?? 0;
      if (streak === 0) { if (f > 0) streak = 1; else if (f < 0) streak = -1; else break; }
      else if (streak > 0 && f > 0) streak++;
      else if (streak < 0 && f < 0) streak--;
      else break;
    }
    return {
      code, name, market: p.tpexCodes.has(code) ? ("TPEX" as const) : ("TWSE" as const),
      sector: isEtf(code) ? etfCategory(name) : ind.get(code) ?? "其他", close, value,
      ret1w: ret(close, wk.get(code)), ret1m: ret(close, mo.get(code)), ret3m: ret(close, qt.get(code)),
      chg1d: Number.isFinite(change) && close - change > 0 ? change / (close - change) : undefined,
      foreign5: has ? foreign5 : 0, foreign10: has ? foreign10 : 0, foreignStreak: streak, trust5: has ? trust5 : 0,
    };
  });
}
