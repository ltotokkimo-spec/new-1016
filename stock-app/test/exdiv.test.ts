import { describe, expect, it } from "vitest";
import { adjustReturns, dividendInfo, exEventsFromDays, exFactor } from "../src/engine/exdiv";
import type { QRow } from "../src/data/twLoader";

const q = (code: string, close: number, change: number): QRow => [code, code, close, change, 1e9, 1e6];

describe("除權息還原", () => {
  // 00406A 實際例子：11/3 除息 0.138（前收 8.58、參考價 8.44）；2330 沒有除息
  const days = [
    { date: "20261104", quotes: [q("00406A", 8.5, 0.06), q("2330", 1010, 10)] },
    { date: "20261103", quotes: [q("00406A", 8.44, 0), q("2330", 1000, 0)] },
    { date: "20261031", quotes: [q("00406A", 8.58, -0.1), q("2330", 1000, 5)] },
  ];
  it("找出除息事件（參考價 ≠ 前收）；沒除息的不算", () => {
    const ex = exEventsFromDays(days);
    expect(ex["00406A"]).toEqual([["20261103", Math.round((8.44 / 8.58) * 1e6) / 1e6, 0.14, 8.58]]);
    expect(ex["2330"]).toBeUndefined();
  });
  it("漲跌幅把除息加回去：原始 −0.93%，還原後約 +0.71%", () => {
    const ex = exEventsFromDays(days);
    expect(exFactor(ex["00406A"], "20261031", "20261104")).toBeCloseTo(8.44 / 8.58, 6);
    expect(exFactor(ex["00406A"], "20261103", "20261104")).toBe(1); // 基準日當天以後才算
    const raw = 8.5 / 8.58 - 1;
    const [a] = adjustReturns([{ code: "00406A", ret1w: raw, ret1m: NaN, ret3m: raw }], ex, { w1: "20261031", m1: "20261031", m3: "20261031" }, "20261104");
    expect(a.ret1w).toBeCloseTo(8.5 / 8.44 - 1, 6);
    expect(a.ret1m).toBeNaN();
    expect(adjustReturns([{ code: "2330", ret1w: 0.01, ret1m: 0, ret3m: 0 }], ex, { w1: "1", m1: "1", m3: "1" }, "9")[0].ret1w).toBe(0.01);
  });
  it("配息資訊：月配、殖利率、填息；分割不算配息", () => {
    const ev = Array.from({ length: 12 }, (_, i) => [`2026${String(i + 1).padStart(2, "0")}03`, 0.985, 0.138, 9] as [string, number, number, number]);
    const d = dividendInfo([...ev, ["20260615", 0.25, 30, 40]], 7.35, "20261109")!;
    expect(d.freq).toBe("月配");
    expect(d.count).toBe(11); // 2025/11/10 之後的 1～11 月（12 月還沒到）
    expect(d.total).toBeCloseTo(0.138 * 11, 6);
    expect(d.yieldPct).toBeCloseTo((0.138 * 11) / 7.35, 6);
    expect(d.filled).toBe(false);
    expect(d.gap).toBeCloseTo(9 - 7.35, 6);
    expect(dividendInfo(undefined, 10, "20261109")).toBeUndefined();
  });
});
