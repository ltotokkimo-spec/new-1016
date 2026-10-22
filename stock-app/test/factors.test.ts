import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { formatFactors, quintileExcess, rankIC, runFactors } from "../src/engine/factors";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 和 backtest.test 同樣的合成資料：前 10 檔每天 +1% 且外資買超，後 10 檔每天 −1% 且外資賣超，其餘持平
function makeDays(): BtDay[] {
  const dates = weekdaysBack("20261016", 150);
  const codes = Array.from({ length: 40 }, (_, k) => String(2001 + k));
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = dates.length - 1; t >= 0; t--) {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const drift = k < 10 ? 0.01 : k >= 30 ? -0.01 : (k % 2 ? 0.001 : -0.001);
      const p = +(p0 * (1 + drift)).toFixed(2);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(2), 2e8, 1e6]);
      flows.push([c, k < 10 ? 500_000 : k >= 30 ? -500_000 : 0, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}

describe("rankIC／quintileExcess", () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  it("完全同向 = 1、完全反向 = −1、樣本太少 = NaN", () => {
    expect(rankIC(xs, xs.map((x) => x * 2))).toBeCloseTo(1, 6);
    expect(rankIC(xs, xs.map((x) => -x))).toBeCloseTo(-1, 6);
    expect(Number.isNaN(rankIC([1, 2, 3], [1, 2, 3]))).toBe(true);
  });
  it("NaN 的股票不算進去", () => {
    const ys = xs.map((x) => x);
    const withNaN = [...xs, NaN, NaN];
    expect(rankIC(withNaN, [...ys, 5, 6])).toBeCloseTo(1, 6);
  });
  it("五等分：高因子那組報酬較高，且五組相對平均加總約為 0", () => {
    const q = quintileExcess(xs, xs.map((x) => x / 100));
    expect(q[4]).toBeGreaterThan(q[0]);
    expect(q.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
  });
});

describe("因子分析", () => {
  const companies = Array.from({ length: 40 }, (_, k) => ({ code: String(2001 + k), name: "", industry: k < 20 ? "半導體" : k < 30 ? "電子零組件" : "航運" }));
  const r = runFactors(makeDays(), companies, { now: 0 });
  const get = (key: string, h: 5 | 20) => r.factors.find((f) => f.key === key)!.h[h]!;

  it("每天都算，涵蓋整段資料", () => {
    expect(r.days).toBeGreaterThan(60);
    expect(r.to > r.from).toBe(true);
    expect(r.upDays + r.downDays).toBe(r.days);
  });
  it("外資籌碼與動能在這份資料裡有預測力（IC 為正、多空差為正）", () => {
    expect(get("flow", 20).ic).toBeGreaterThan(0.3);
    expect(get("momentum", 20).ic).toBeGreaterThan(0.3);
    expect(get("flow", 20).spread).toBeGreaterThan(0);
    expect(get("score", 5).hit).toBeGreaterThan(0.9);
  });
  it("反轉因子在這份資料裡是反向的（IC 為負）", () => {
    expect(get("rev1m", 20).ic).toBeLessThan(0);
  });
  it("輸出文字表含每個因子", () => {
    const lines = formatFactors(r);
    expect(lines[0]).toContain("因子分析");
    expect(lines.some((l) => l.includes("外資籌碼分數") && l.includes("IC"))).toBe(true);
  });
});
