import { describe, expect, it } from "vitest";
import { DUAL_REAL, dualOrders } from "../src/engine/dualReal";
import { emptyEtf, FEE, valuate, type AiEtf } from "../src/engine/aiEtf";

const px: Record<string, number> = { "2330": 1000, "2412": 120, "2886": 40, "0050": 60 };
const price = (c: string) => px[c];
const name = (c: string) => `股${c}`;

describe("雙引擎實單：依目標權重算出這個帳戶要下的單（11/15）", () => {
  it("本金 50 萬、差距 0.5% 才調整（和觀察組合一樣）", () => {
    expect(DUAL_REAL).toEqual({ budget: 500_000, band: 0.005 });
  });
  it("空帳戶：照權重買進，股數無條件捨去，現金夠用、權重大的先列", () => {
    const o = dualOrders(emptyEtf(500_000), { "2330": 0.1, "2412": 0.3, "2886": 0.0001 }, price, name);
    expect(o.map((x) => [x.side, x.code, x.shares])).toEqual([["buy", "2412", 1250], ["buy", "2330", 50]]); // 2886 只有 50 元：小於 0.5% 不買
    expect(o[0].reason).toBe("新增：目標 30.0%");
  });
  it("持股不在名單全部賣出、超過目標的減碼、差距小的不動；先賣後買，買進受現金限制", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), trades: [
      { id: "1", date: "20261113", code: "2886", name: "兆豐金", side: "buy", shares: 5000, price: 40, benchPrice: 60 }, // 20 萬
      { id: "2", date: "20261113", code: "2412", name: "中華電", side: "buy", shares: 2000, price: 120, benchPrice: 60 }, // 24 萬
    ] };
    const nav = valuate(etf, price).nav;
    const o = dualOrders(etf, { "2412": 0.48, "2330": 0.4 }, price, name);
    expect(o[0]).toMatchObject({ side: "sell", code: "2886", shares: 5000, reason: "不在雙引擎今天的名單，全部賣出" });
    expect(o.some((x) => x.code === "2412")).toBe(false); // 目前 24 萬 ≈ 48%：差距小於 0.5% 不動
    const buy = o.find((x) => x.code === "2330")!;
    expect(buy.side).toBe("buy");
    expect(buy.shares).toBe(Math.floor(Math.min(0.4 * nav, Infinity) / 1000));
    expect(buy.shares * 1000 * (1 + FEE)).toBeLessThanOrEqual(valuate(etf, price).cash + 5000 * 40);
  });
  it("沒有價格的股票跳過；淨值是 0 時不下單", () => {
    expect(dualOrders(emptyEtf(500_000), { "9999": 0.5 }, price, name)).toEqual([]);
    expect(dualOrders(emptyEtf(0), { "2330": 0.5 }, price, name)).toEqual([]);
  });
});
