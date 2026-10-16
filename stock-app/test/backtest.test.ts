import { describe, expect, it } from "vitest";
import { runBacktest, type BtDay } from "../src/engine/backtest";
import { weekdaysBack } from "../src/lib/dates";
import type { QRow, FRow } from "../src/data/twLoader";

// 40 檔股票、150 個交易日：前 10 檔每天穩定上漲且外資買超（應該被評為買入，之後也繼續漲），
// 後 10 檔每天下跌且外資賣超，其餘持平。2001 在中間除息 5 元（收盤掉 5 元、漲跌 0）。
function makeDays(): BtDay[] {
  const dates = weekdaysBack("20261016", 150); // 新到舊
  const n = dates.length;
  const codes = Array.from({ length: 40 }, (_, k) => String(2001 + k));
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = n - 1; t >= 0; t--) { // 舊到新產生
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const drift = k < 10 ? 0.01 : k >= 30 ? -0.01 : (k % 2 ? 0.001 : -0.001);
      let p = +(p0 * (1 + drift)).toFixed(2);
      let change = +(p - p0).toFixed(2);
      if (c === "2011" && t === 60) { p = p0 - 5; change = 0; } // 除息：參考價 p0-5，收盤平盤
      price.set(c, p);
      quotes.push([c, `股${c}`, p, change, 2e8, 1e6]);
      flows.push([c, k < 10 ? 500_000 : k >= 30 ? -500_000 : 0, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}

describe("回測", () => {
  const companies = Array.from({ length: 40 }, (_, k) => ({ code: String(2001 + k), name: "", industry: k < 20 ? "半導體" : k < 30 ? "電子零組件" : "航運" }));
  const r = runBacktest(makeDays(), companies, { now: 0 });

  it("每週評等一次，涵蓋約 6 個月", () => {
    expect(r.stocks.signals).toBeGreaterThan(15);
    expect(r.to > r.from).toBe(true);
    expect(r.etf.signals).toBe(0);
  });

  it("買入組之後的報酬高於全部與離場", () => {
    const g = r.stocks.groups;
    expect(g["買入"][20]!.n).toBeGreaterThan(0);
    expect(g["買入"][20]!.avg).toBeGreaterThan(g["全部"][20]!.avg);
    expect(g["離場"][20]!.avg).toBeLessThan(0);
    expect(g["買入"][5]!.win).toBe(1);
    expect(g["買入"][20]!.beat).toBe(1);
    // 每天 +1%，5 天約 +5.1%
    expect(g["買入"][5]!.avg).toBeCloseTo(1.01 ** 5 - 1, 3);
  });

  it("除息不算下跌（用漲跌連乘）", () => {
    // 2011 持平股：除息那天收盤掉 5 元但漲跌 0，含那天的報酬仍接近 0
    const all = r.stocks.groups["觀望"][20]!;
    expect(Math.abs(all.median)).toBeLessThan(0.03);
  });

  it("最新 5 天沒有未來資料，不會出現在統計裡", () => {
    expect(r.stocks.series[0].date <= makeDays()[5].date).toBe(true);
    expect(r.stocks.series.every((x) => x.all[5] !== undefined)).toBe(true);
  });
});
