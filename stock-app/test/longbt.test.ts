import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { buildCtx } from "../src/engine/steady";
import { LB, cagr, ddBetween, maxDd, mulberry32, randomPicker, rollingWin, simulateLB } from "../src/engine/longbt";
import { weekdaysBack } from "../src/lib/dates";

// 兩檔：2330 每天 +1%（第 6 天漲停 +10% 一次）、2317 每天 -1%（第 4 天跌停 -10%）；收盤價連乘
function mk(n = 12, limitUpDay = -1, limitDownDay = -1): BtDay[] {
  const dates = weekdaysBack("20261016", n).reverse();
  let a = 100, b = 100;
  const days: BtDay[] = [];
  dates.forEach((d, i) => {
    const ra = i === limitUpDay ? 0.1 : 0.01, rb = i === limitDownDay ? -0.1 : -0.01;
    const a0 = a, b0 = b; a *= 1 + ra; b *= 1 + rb;
    days.push({ date: d, quotes: [["2330", "甲", a, a - a0, 5e8, 1], ["2317", "乙", b, b - b0, 5e8, 1]], flows: [], tpexCodes: new Set() });
  });
  return days.reverse();
}

describe("longbt 模擬", () => {
  it("買進後隔天才成交，成本全扣後比不扣成本少", () => {
    const c = buildCtx(mk(), []);
    const pick = () => new Map([["2330", 1]]);
    const a = simulateLB(c, 0, pick, { costs: false, every: 100 });
    const b = simulateLB(c, 0, pick, { costs: true, every: 100 });
    expect(b.eq.at(-1)!).toBeLessThan(a.eq.at(-1)!);
    expect(b.costPaid).toBeGreaterThan(0);
    // 成本約為單邊手續費＋滑價
    expect(b.costPaid).toBeCloseTo(LB.fee + LB.slipStock, 3);
  });
  it("漲停那天買不到", () => {
    const c = buildCtx(mk(12, 2), []); // 第 2 天漲停；第 1 天收盤決定、第 2 天成交 → 買不到
    const s = simulateLB(c, 1, () => new Map([["2330", 1]]), { every: 100 });
    expect(s.blockedBuys).toBe(1);
    expect(s.exposure).toBe(0);
  });
  it("跌停賣不掉，隔天再試", () => {
    const c = buildCtx(mk(12, -1, 5), []);
    let call = 0;
    const s = simulateLB(c, 0, () => (call++ === 0 ? new Map([["2317", 1]]) : new Map()), { every: 4 });
    expect(s.blockedSells).toBeGreaterThanOrEqual(1);
  });
});

describe("longbt 指標", () => {
  it("最大回撤與年化", () => {
    expect(maxDd([1, 2, 1, 3])).toBeCloseTo(-0.5);
    expect(cagr([1, 1, 1])).toBe(0);
    const dates = ["20200101", "20200102", "20200103", "20200104"];
    expect(ddBetween([1, 2, 1, 3], dates, "20200101", "20200103")).toBeCloseTo(-0.5);
  });
  it("滾動區間勝率", () => {
    const eq = Array.from({ length: 30 }, (_, i) => 1 + i * 0.02), bench = Array.from({ length: 30 }, (_, i) => 1 + i * 0.01);
    expect(rollingWin(eq, bench, 10, 5).win).toBe(1);
  });
  it("隨機選股可重現、不重複", () => {
    const pool = Array.from({ length: 50 }, (_, i) => `c${i}`);
    const a = randomPicker(() => pool, 10, mulberry32(7))(0), b = randomPicker(() => pool, 10, mulberry32(7))(0);
    expect([...a.keys()]).toEqual([...b.keys()]);
    expect(a.size).toBe(10);
  });
});
