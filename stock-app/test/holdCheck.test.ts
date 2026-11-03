import { describe, expect, it } from "vitest";
import { dailyHoldingCheck, emptyEtf, type AiEtf, type HoldScore } from "../src/engine/aiEtf";

const buy = (code: string, shares: number, price: number) => ({ id: `${code}-b`, date: "20261020", code, name: code, side: "buy" as const, shares, price, benchPrice: 100 });

describe("我的實單：每天自動的持股規則檢查", () => {
  const etf: AiEtf = { ...emptyEtf(1_000_000), trades: [buy("A", 1000, 100), buy("B", 1000, 100), buy("C", 1000, 100), buy("D", 1000, 100), buy("E", 1000, 100)] };
  const px: Record<string, number> = { A: 89, B: 105, C: 91, D: 110, E: 101 };
  const sc: Record<string, HoldScore> = {
    A: { rating: "觀望", score: 50 },
    B: { rating: "離場", score: 20 },
    C: { rating: "觀望", score: 40, foreignStreak: -4, ret1w: -0.03 },
    D: { rating: "買入", score: 80, ret1w: 0.05 },
    E: { rating: "觀望", score: 55, ret1w: 0.01 },
  };
  const r = dailyHoldingCheck(etf, (c) => px[c], (c) => sc[c]);
  const by = Object.fromEntries(r.map((x) => [x.code, x]));
  it("跌破停損（預設成本 −10%）或評為離場 → 出場", () => {
    expect(by.A.verdict).toBe("出場");
    expect(by.A.reasons[0]).toMatch(/跌破停損 90/);
    expect(by.B.verdict).toBe("出場");
    expect(by.B.reasons[0]).toMatch(/離場/);
  });
  it("外資連賣 3 天以上且一週下跌、或虧損超過 8% → 減碼", () => {
    expect(by.C.verdict).toBe("減碼");
    expect(by.C.reasons.join()).toMatch(/外資連賣 4 天/);
    expect(by.C.reasons.join()).toMatch(/虧損 -9\.\d%/);
  });
  it("買入評等、70 分以上、賺錢、一週沒過熱 → 可加碼；其餘續抱", () => {
    expect(by.D.verdict).toBe("可加碼");
    expect(by.E.verdict).toBe("續抱");
  });
  it("依嚴重程度排序：出場、減碼、可加碼、續抱", () => {
    expect(r.map((x) => x.verdict)).toEqual(["出場", "出場", "減碼", "可加碼", "續抱"]);
  });
  it("單一持股超過淨值 30% → 減碼（太集中）", () => {
    const one: AiEtf = { ...emptyEtf(100_000), trades: [buy("X", 500, 100)] };
    const x = dailyHoldingCheck(one, () => 100, () => ({ rating: "觀望", score: 50 }))[0];
    expect(x.verdict).toBe("減碼");
    expect(x.reasons.join()).toMatch(/佔淨值 50%/);
  });
  it("沒有價格時不判斷停損，也不報錯", () => {
    const x = dailyHoldingCheck({ ...emptyEtf(100_000), trades: [buy("Y", 10, 100)] }, () => undefined, () => undefined)[0];
    expect(x.verdict).toBe("續抱");
    expect(x.price).toBeUndefined();
  });
});
