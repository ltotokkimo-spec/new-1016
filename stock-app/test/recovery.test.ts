import { describe, expect, it } from "vitest";
import { breakEvenPrice, recoveryPlan, sharesToAverage } from "../src/engine/recovery";
import type { HoldingView, Scored } from "../src/engine/score";

const sc = (code: string, rating: Scored["rating"], score: number, name = `股${code}`): Scored => ({ code, name, market: "TWSE", sector: "x", close: 100, value: 1e9, ret1w: 0, ret1m: 0, ret3m: 0, score, momentum: 0.5, flow: 0.5, sectorScore: 0.5, rating, reasons: [] });
const hv = (code: string, shares: number, cost: number, price: number, rating: HoldingView["rating"], market: HoldingView["market"] = "TWSE"): HoldingView =>
  ({ id: code, code, name: `股${code}`, market, shares, cost, price, pnl: (price - cost) * shares, pnlPct: price / cost - 1, rating, advice: [] }) as HoldingView;

describe("持股分析與建議（回本計畫）", () => {
  it("回本價含手續費與證交稅：股票約成本 +0.59%、ETF 約 +0.39%", () => {
    expect(breakEvenPrice(100, "2330", "TWSE")).toBeCloseTo((100 * 1.001425) / (1 - 0.001425 - 0.003), 9);
    expect(breakEvenPrice(100, "0056", "TWSE") / 100 - 1).toBeLessThan(breakEvenPrice(100, "2330", "TWSE") / 100 - 1);
  });

  it("攤平股數：加碼後回本所需漲幅降到目標，且不超過上限", () => {
    const k = breakEvenPrice(1, "2330", "TWSE");
    const need = (100 * k) / 90 - 1;
    const n = sharesToAverage(1000, 100, 90, k, need / 2, 5000);
    const newCost = (1000 * 100 + n * 90) / (1000 + n);
    expect((newCost * k) / 90 - 1).toBeLessThanOrEqual(need / 2 + 1e-9);
    expect(sharesToAverage(1000, 100, 90, k, need / 2, 10)).toBe(10);
  });

  it("離場或達停損 → 停損換股並推薦評分最高、沒持有的「買入」股；買入評等 → 攤平；觀望 → 續抱設條件；獲利的不列", () => {
    const views = [
      hv("1111", 1000, 100, 85, "觀望"), // -15%：達停損
      hv("2222", 1000, 100, 97, "離場"),
      hv("3333", 2000, 50, 46, "買入"),
      hv("4444", 500, 80, 78, "觀望"),
      hv("5555", 100, 10, 12, "買入"), // 獲利
    ];
    const picks = { stocks: [sc("9001", "買入", 80, "強股"), sc("9002", "買入", 90, "最強"), sc("3333", "買入", 99), sc("9003", "觀望", 95)], etfs: [], us: [] };
    const { items, summary } = recoveryPlan(views, picks);
    expect(items.map((x) => [x.code, x.action])).toEqual([
      ["1111", "停損換股"], ["2222", "停損換股"], ["3333", "攤平"], ["4444", "續抱設條件"],
    ]);
    expect(items[0].swap?.code).toBe("9002"); // 已持有的 3333、觀望的 9003 不推薦；虧最多的 1111 先分到最高分
    expect(items[1].swap?.code).toBe("9001"); // 第二檔停損推薦不同的標的
    const a = items[2].avg!;
    expect(a.addShares).toBeGreaterThan(0);
    expect(a.addShares).toBeLessThanOrEqual(2000);
    expect(a.newNeedPct).toBeLessThan(items[2].needPct);
    expect(summary.losers).toBe(4);
    expect(summary.winners).toBe(1);
    expect(summary.lines.join("")).toContain("停損換股");
  });

  it("ETF 停損時推薦分數最高的 ETF；沒有虧損時給一句說明", () => {
    const { items } = recoveryPlan([hv("00406A", 1000, 10, 7.3, "參考")], { stocks: [sc("9002", "買入", 90)], etfs: [sc("0056", "觀望", 70), sc("00878", "觀望", 85)], us: [] });
    expect(items[0].action).toBe("停損換股");
    expect(items[0].swap?.code).toBe("00878");
    expect(recoveryPlan([hv("5555", 100, 10, 12, "買入")], { stocks: [], etfs: [], us: [] }).summary.lines[0]).toMatch(/沒有虧損/);
  });
});
