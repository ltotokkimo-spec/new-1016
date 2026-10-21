import { describe, expect, it } from "vitest";
import { adjustedSeries, indicators, turningAt } from "../src/engine/turning";
import type { BtDay } from "../src/engine/backtest";

// 由舊到新的收盤組出 days（新到舊），每天成交金額 1 億、外資每天買 1000 股
function mkDays(stocks: Record<string, number[]>, flow = 1000): BtDay[] {
  const n = Math.max(...Object.values(stocks).map((x) => x.length));
  const days: BtDay[] = [];
  for (let j = 0; j < n; j++) {
    const date = String(20260101 + j);
    days.unshift({
      date, tpexCodes: new Set(),
      quotes: Object.entries(stocks).map(([code, xs]) => [code, `股${code}`, xs[j], j ? +(xs[j] - xs[j - 1]).toFixed(4) : 0, 1e8, 1e6]),
      flows: Object.keys(stocks).map((code) => [code, flow, 0, 0]),
    });
  }
  return days;
}

// 盤整 → 拉回（MACD 翻負）→ 剛開始往上
const base = [
  ...Array.from({ length: 80 }, (_, i) => 30 + (i % 2 ? 0.2 : -0.2)),
  ...Array.from({ length: 12 }, (_, i) => 29.9 - i * 0.08),
  29.2, 29.45, 29.7, 29.95, 30.2,
];
// 一路急漲（過熱）
const hot = Array.from({ length: base.length }, (_, i) => 20 * 1.012 ** i);

describe("剛轉強", () => {
  it("指標：均線與 RSI", () => {
    const x = indicators(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(x.ma20[29]).toBeCloseTo(20.5);
    expect(x.rsi[29]).toBe(100);
    expect(x.osc[29]).toBeGreaterThanOrEqual(0);
  });

  it("打底後剛翻多的股票會選到，過熱的不會", () => {
    const days = mkDays({ "1101": base, "2330": hot });
    const picks = turningAt(days, 0);
    expect(picks.map((p) => p.code)).toEqual(["1101"]);
    const p = picks[0];
    expect(p.gap20).toBeGreaterThan(0);
    expect(p.gap20).toBeLessThanOrEqual(0.05);
    expect(p.rsi).toBeLessThan(70);
    expect(p.turnedAgo).toBeLessThanOrEqual(4);
    expect(p.stop).toBeLessThan(p.close);
    expect(p.stop).toBeGreaterThanOrEqual(+(p.close * 0.92).toFixed(2));
  });

  it("法人賣超就不選", () => {
    expect(turningAt(mkDays({ "1101": base }, -1000), 0)).toEqual([]);
  });

  it("除權息不會變成缺口：還原價連續", () => {
    const days = mkDays({ "1101": base });
    // 最後一天除息 2 元：收盤 30.1、漲跌 0（參考價 30.1）
    days[0].quotes[0] = ["1101", "股1101", 30.1, 0, 1e8, 1e6];
    const s = adjustedSeries(days).get("1101")!;
    expect(s.adj[s.adj.length - 1]).toBeCloseTo(s.adj[s.adj.length - 2]);
  });
});
