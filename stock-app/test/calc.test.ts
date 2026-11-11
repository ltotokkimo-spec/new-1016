import { describe, expect, it } from "vitest";
import { averageDown, batchPlan, buyFee, dividendPlan, payout, sharesForAmount, sharesForMonthly, sharesForTarget } from "../src/engine/calc";

describe("攤平計算", () => {
  const base = { code: "2317", market: "TWSE", shares: 1000, cost: 260, price: 241.5, addShares: 1000, addPrice: 241.5 };
  it("加碼 1 張：均價、回本價、回本要漲多少、需要資金（範本的數字）", () => {
    const r = averageDown(base);
    expect(r.before.avg).toBe(260);
    expect(r.before.breakEven).toBeCloseTo(261.53, 2);
    expect(r.before.needPct).toBeCloseTo(0.0829, 4);
    expect(r.after.avg).toBeCloseTo(250.75, 9);
    expect(r.after.breakEven).toBeCloseTo(252.22, 2);
    expect(r.after.needPct).toBeCloseTo(0.0444, 4);
    expect(r.addCost).toBe(241500);
    expect(Math.round(r.addFee)).toBe(344);
    expect(Math.round(r.ifDrop10.after)).toBe(-66800);
    expect(Math.round(r.ifDrop10.before)).toBe(-42650);
    expect(r.stop).toBeCloseTo(225.675, 6);
  });
  it("手續費最低 20 元（整張）、1 元（零股）；美股 0.1%", () => {
    expect(buyFee(1000, 1000, "TWSE")).toBe(20);
    expect(buyFee(100, 5, "TWSE")).toBe(1);
    expect(buyFee(1000, 5, "US")).toBeCloseTo(1, 9);
  });
  it("目標均價反推股數、金額換股數、分批", () => {
    expect(sharesForTarget(1000, 260, 241.5, 250)).toBe(1177);
    expect(sharesForTarget(1000, 260, 241.5, 270)).toBeUndefined(); // 目標比原均價高，加碼做不到
    expect(sharesForAmount(250000, 241.5, "TWSE")).toBe(1000);
    expect(sharesForAmount(50000, 241.5, "TWSE")).toBe(207);
    expect(batchPlan(base).map((b) => b.shares)).toEqual([333, 333, 334]);
  });
});

describe("股息計算", () => {
  it("每次入帳：未達 2 萬不扣二代健保，扣匯費 10 元；達 2 萬扣 2.11%", () => {
    expect(payout(20000, 0.4, "TWSE")).toEqual({ gross: 8000, nhi: 0, fee: 10, net: 7990 });
    const big = payout(60000, 0.4, "TWSE");
    expect(big.nhi).toBe(Math.round(24000 * 0.0211));
    expect(payout(100, 1, "US").net).toBeCloseTo(70, 9); // 美股預扣 30%
  });
  it("股息再投入：股數逐年增加；領現金時股數不變", () => {
    const p = { code: "00878", market: "TWSE", shares: 20000, cost: 20, price: 22.5, perPay: 0.4, perYear: 4, years: 10, drip: true, priceGrowth: 0, addPerYear: 0 };
    const r = dividendPlan(p);
    expect(r.rows).toHaveLength(10);
    expect(r.rows[0].shares).toBeGreaterThan(20000);
    expect(r.rows[9].shares).toBeGreaterThan(r.rows[4].shares);
    const cash = dividendPlan({ ...p, drip: false });
    expect(cash.rows[9].shares).toBe(20000);
    expect(cash.rows[9].cumNet).toBe(7990 * 40);
  });
  it("目標反推：每月 1 萬要幾股（含二代健保與匯費）", () => {
    const sh = sharesForMonthly(10000, 0.4, 4, "TWSE");
    expect(payout(sh, 0.4, "TWSE").net * 4 / 12).toBeGreaterThanOrEqual(10000);
    expect(payout(sh - 100, 0.4, "TWSE").net * 4 / 12).toBeLessThan(10000);
  });
});
