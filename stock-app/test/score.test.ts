import { describe, expect, it } from "vitest";
import { percentiles, scoreStocks, sectorStats, reviewHolding, type StockInput } from "../src/engine/score";

function mk(code: string, sector: string, ret1m: number, foreign5: number, extra: Partial<StockInput> = {}): StockInput {
  return { code, name: code, market: "TWSE", sector, close: 100, value: 1e9, ret1w: ret1m / 4, ret1m, ret3m: ret1m * 2, foreign5, foreignStreak: foreign5 > 0 ? 5 : -3, trust5: 0, ...extra };
}

describe("百分位", () => {
  it("由小到大 0~1，同值同分，NaN 給 0.5", () => {
    expect(percentiles([3, 1, 2])).toEqual([1, 0, 0.5]);
    expect(percentiles([5, 5, 1])).toEqual([0.75, 0.75, 0]);
    expect(percentiles([NaN, 1, 2])).toEqual([0.5, 0, 1]);
  });
});

describe("評分與評等", () => {
  const universe: StockInput[] = [];
  for (let i = 0; i < 10; i++) universe.push(mk(`A${i}`, "半導體", 0.1 + i * 0.01, 5_000_000 + i * 1e6));
  for (let i = 0; i < 10; i++) universe.push(mk(`B${i}`, "航運", -0.12 - i * 0.01, -5_000_000 - i * 1e6));
  for (let i = 0; i < 10; i++) universe.push(mk(`C${i}`, "金融保險", 0.0 + i * 0.002, i % 2 ? 1e5 : -1e5));
  universe.push(mk("TINY", "半導體", 0.5, 1e7, { value: 1e6 })); // 成交太小
  const { scored, sectors } = scoreStocks(universe);

  it("流動性不足的股票不列入", () => {
    expect(scored.find((s) => s.code === "TINY")).toBeUndefined();
  });
  it("強動能＋外資買超＝買入；弱動能＋外資賣超＝離場", () => {
    expect(scored.find((s) => s.code === "A9")!.rating).toBe("買入");
    expect(scored.find((s) => s.code === "B9")!.rating).toBe("離場");
    expect(scored[0].score).toBeGreaterThanOrEqual(scored[scored.length - 1].score);
  });
  it("理由寫出實際數字", () => {
    const a = scored.find((s) => s.code === "A9")!;
    expect(a.reasons.join("\n")).toContain("外資近5日 +14,000 張，連續買超 5 天");
    expect(a.reasons.join("\n")).toContain("近1月 +19.0%");
  });
  it("族群強弱排序與輪動標籤", () => {
    expect(sectors[0].sector).toBe("半導體");
    expect(sectors[sectors.length - 1].sector).toBe("航運");
    expect(sectors[0].rotation).toBe("強勢延續");
    expect(sectors.find((s) => s.sector === "航運")!.rotation).toBe("弱勢");
  });
  it("一週漲超過 20% 不給買入", () => {
    const hot = [...universe.slice(0, 30), mk("HOT", "半導體", 0.6, 3e7, { ret1w: 0.35, ret3m: 1.5 })];
    const r = scoreStocks(hot).scored.find((s) => s.code === "HOT")!;
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.rating).toBe("觀望");
    expect(r.reasons.join()).toContain("追高風險");
  });
});

describe("族群：上週轉強", () => {
  it("1 週排名前段、1 月排名後段 → 轉強", () => {
    const xs: StockInput[] = [];
    const sectors = ["甲", "乙", "丙", "丁", "戊", "己"];
    sectors.forEach((sec, k) => {
      for (let i = 0; i < 3; i++) {
        const s = mk(`${sec}${i}`, sec, 0.1 - k * 0.04, 0);
        if (sec === "己") s.ret1w = 0.2; // 月線最弱、週線最強
        xs.push(s);
      }
    });
    expect(sectorStats(xs).find((s) => s.sector === "己")!.rotation).toBe("轉強");
  });
});

describe("持股健檢", () => {
  const base = { id: "1", code: "2330", name: "台積電", market: "TWSE" as const, shares: 1000 };
  it("損益與停損", () => {
    const v = reviewHolding({ ...base, cost: 2800 }, undefined, 2440);
    expect(v.pnl).toBe(-360000);
    expect(v.pnlPct).toBeCloseTo(-0.1286, 3);
    expect(v.advice.join()).toContain("已達 10% 停損線");
  });
});

describe("ETF 只當參考", () => {
  it("持股健檢不給買入／觀望／離場，但仍提醒停損", async () => {
    const { reviewHolding } = await import("../src/engine/score");
    const s: any = { code: "0050", name: "元大台灣50", market: "TWSE", sector: "市值型", close: 88, value: 1e10, ret1w: 0, ret1m: -0.05, ret3m: 0, score: 30, momentum: 0, flow: 0, sectorScore: 0, rating: "離場", refOnly: true, reasons: [] };
    const v = reviewHolding({ id: "1", code: "0050", name: "元大台灣50", market: "TWSE", shares: 1000, cost: 100 }, s);
    expect(v.rating).toBe("參考");
    expect(v.advice.join()).toMatch(/停損/);
    expect(v.advice.join()).toMatch(/ETF 只供參考/);
    expect(v.advice.join()).not.toMatch(/減碼或出場/);
  });
});
