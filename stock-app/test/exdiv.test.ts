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

describe("證交所除權除息計算結果（TWT49U）", () => {
  it("解析官方資料：00406A 每次 0.138 元；民國日期轉西元；合併時官方優先", async () => {
    const { parseTwt49u, mergeEx } = await import("../src/engine/exdiv");
    const json = { stat: "OK", fields: ["資料日期", "股票代號", "股票名稱", "除權息前收盤價", "除權息參考價", "權值+息值", "權/息"], data: [
      ["115年09月02日", "00406A", "主動中信台灣收益", "9.96", "9.82", "0.138000", "息"],
      ["115年11月03日", "00406A", "主動中信台灣收益", "8.58", "8.44", "0.138000", "息"],
      ["115年07月15日", "2330", "台積電", "1,050.00", "1,045.00", "5.000000", "息"],
    ] };
    const ex = parseTwt49u(json);
    expect(ex["00406A"]).toEqual([["20260902", Math.round((9.82 / 9.96) * 1e6) / 1e6, 0.138, 9.96], ["20261103", Math.round((8.44 / 8.58) * 1e6) / 1e6, 0.138, 8.58]]);
    expect(ex["2330"][0][3]).toBe(1050);
    const m = mergeEx(ex, { "00406A": [["20261103", 0.93, 0.6, 8.58]], "6488": [["20260801", 0.98, 1, 50]] }, new Set(["9999"]));
    expect(m["00406A"].map((e) => e[2])).toEqual([0.138, 0.138]);
    expect(m["6488"]).toHaveLength(1);
  });
});
