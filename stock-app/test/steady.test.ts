import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { formatSteady, inverseVolWeights, runSteady, STEADY, trendFit } from "../src/engine/steady";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 合成資料：2001～2010 每天穩定 +0.4%（平滑上漲）、2011～2020 平均也漲但每天 ±3% 亂跳、2021～2030 下跌，0050 緩漲
function makeDays(n = 200): BtDay[] {
  const dates = weekdaysBack("20261016", n);
  const codes = [...Array.from({ length: 30 }, (_, k) => String(2001 + k)), "0050"];
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = dates.length - 1, step = 0; t >= 0; t--, step++) {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const r = c === "0050" ? 0.001 : k < 10 ? 0.004 + (k % 3) * 0.0005 : k < 20 ? 0.002 + (step % 2 ? 0.05 : -0.05) : -0.004;
      const p = +(p0 * (1 + r)).toFixed(4);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(4), 5e8, 1e6]);
      flows.push([c, 0, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}
const companies = Array.from({ length: 30 }, (_, k) => ({ code: String(2001 + k), name: "", industry: `產業${k % 6}` }));

describe("穩健選股回測", () => {
  it("趨勢回歸：直線上漲 R² 接近 1，亂跳的 R² 低", () => {
    const line = Array.from({ length: 90 }, (_, i) => 100 * 1.004 ** i);
    expect(trendFit(line).r2).toBeGreaterThan(0.999);
    expect(trendFit(line).slope).toBeCloseTo(Math.log(1.004), 6);
    const noisy = Array.from({ length: 90 }, (_, i) => 100 * 1.002 ** i * (i % 2 ? 1.05 : 0.95));
    expect(trendFit(noisy).r2).toBeLessThan(0.8);
  });

  it("依波動反比配置：波動小的權重大、單檔不超過上限、總和不超過 1", () => {
    const w = inverseVolWeights([0.01, 0.02, 0.04], 0.5);
    expect(w[0]).toBeGreaterThan(w[1]);
    expect(Math.max(...w)).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(w.reduce((a, x) => a + x, 0)).toBeLessThanOrEqual(1 + 1e-9);
    const w10 = inverseVolWeights(Array(10).fill(0.02), 0.12);
    expect(w10.every((x) => Math.abs(x - 0.1) < 1e-9)).toBe(true);
  });

  const r = runSteady(makeDays(), companies, { now: 0 });
  it("每個策略都有結果；穩健只挑平滑上漲的，不挑亂跳和下跌的，且每產業最多 2 檔", () => {
    expect(r.strategies.map((s) => s.key)).toEqual(["steady", "steadyNoRegime", "steadyNoStop", "lowVol", "buyList", "A_lowVolTrend", "A_lowVolTrendRegime", "B_buyListVol", "C_coreBuy", "C_coreA", "T60_off", "T60_half", "T120_off", "0050"]);
    const picks = r.latest.picks.map((p) => +p.code);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((c) => c >= 2001 && c <= 2010)).toBe(true);
    const per = new Map<string, number>();
    for (const p of r.latest.picks) per.set(p.sector, (per.get(p.sector) ?? 0) + 1);
    expect(Math.max(...per.values())).toBeLessThanOrEqual(STEADY.maxPerSector);
  });

  it("穩健組合在平滑上漲的資料上賺錢、回檔小，指標合理", () => {
    const s = r.strategies.find((x) => x.key === "steady")!;
    expect(s.total).toBeGreaterThan(0.05);
    expect(s.maxDd).toBeLessThanOrEqual(0);
    expect(s.maxDd).toBeGreaterThan(-0.05);
    expect(s.upDays).toBeGreaterThan(0.8);
    expect(s.equity[0].v).toBeCloseTo(1, 6);
    const b = r.strategies.find((x) => x.key === "0050")!;
    expect(b.total).toBeGreaterThan(0);
    expect(formatSteady(r).length).toBe(r.strategies.length + 2);
  });
});
