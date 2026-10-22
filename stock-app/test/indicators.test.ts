import { describe, expect, it } from "vitest";
import { kdSeries, macdSeries, rsiSeries, smaSeries } from "../src/engine/indicators";

describe("技術指標", () => {
  it("均線：前 n-1 根是 NaN，之後是滾動平均", () => {
    const m = smaSeries([1, 2, 3, 4, 5], 3);
    expect(m.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(m.slice(2)).toEqual([2, 3, 4]);
  });

  it("RSI：一路上漲是 100、一路下跌是 0，教科書例子約 70", () => {
    const up = Array.from({ length: 20 }, (_, i) => 10 + i);
    expect(rsiSeries(up)[19]).toBe(100);
    const down = up.slice().reverse();
    expect(rsiSeries(down)[19]).toBeCloseTo(0, 5);
    // Wilder 經典範例（StockCharts）：第 15 筆 RSI 70.46
    const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(rsiSeries(c)[14]).toBeCloseTo(70.46, 1);
  });

  it("KD：收在區間最高 K、D 往 100 走，且 K 比 D 快", () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ high: 11 + i, low: 9 + i, close: 11 + i }));
    const { k, d } = kdSeries(bars);
    expect(Number.isNaN(k[7])).toBe(true);
    expect(k[29]).toBeGreaterThan(d[29]);
    expect(k[29]).toBeGreaterThan(80);
    expect(k[29]).toBeLessThanOrEqual(100);
  });

  it("KD：第一個值 = 50 往 RSV 靠 1/3（RSV 100 → K 66.7、D 55.6）", () => {
    const bars = Array.from({ length: 9 }, (_, i) => ({ high: 10 + i, low: 10, close: 10 + i }));
    const { k, d } = kdSeries(bars);
    expect(k[8]).toBeCloseTo(66.667, 2);
    expect(d[8]).toBeCloseTo(55.556, 2);
  });

  it("MACD：長期上漲 DIF > 0；DIF 從第 26 根、訊號線從第 34 根開始有值", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 1.5 + Math.sin(i) * 2);
    const { dif, macd, osc } = macdSeries(closes);
    expect(Number.isNaN(dif[24])).toBe(true);
    expect(Number.isFinite(dif[25])).toBe(true);
    expect(Number.isNaN(macd[32])).toBe(true);
    expect(Number.isFinite(macd[33])).toBe(true);
    expect(dif[59]).toBeGreaterThan(0);
    expect(osc[59]).toBeCloseTo(dif[59] - macd[59], 10);
  });
});
