import { describe, expect, it } from "vitest";
import { buildFlowSeries, flowDates, sumFlows } from "../src/engine/flowSeries";
import type { FRow } from "../src/data/twLoader";

const bars = ["20261019", "20261020", "20261021", "20261022"].map((date, i) => ({ date, close: 100 + i }));
const flows = new Map<string, FRow[]>([
  ["20261019", [["6182", 3_225_000, 267_000, -275_000]]],
  ["20261020", [["6182", -1_624_000, 316_000, -196_000], ["2330", 1, 2, 3]]],
  ["20261021", [["2330", 1, 2, 3]]], // 這天法人沒買賣 6182
]);

describe("法人分頁的序列", () => {
  const s = buildFlowSeries(bars, flows, "6182");
  it("股換成張、三大法人＝外資＋投信＋自營商", () => {
    expect(s[0]).toEqual({ date: "20261019", close: 100, foreign: 3225, trust: 267, dealer: -275, total: 3217 });
    expect(s[1].total).toBeCloseTo(-1504, 6);
  });
  it("有資料的日子但沒有這檔記 0；還沒下載的日子不列", () => {
    expect(s.map((x) => x.date)).toEqual(["20261019", "20261020", "20261021"]);
    expect(s[2]).toMatchObject({ foreign: 0, trust: 0, dealer: 0, total: 0 });
  });
  it("累計", () => {
    expect(sumFlows(s).foreign).toBeCloseTo(1601, 6);
  });
  it("只取最近 days 天", () => {
    expect(buildFlowSeries(bars, flows, "6182", 2).map((x) => x.date)).toEqual(["20261021"]);
  });
  it("今天下午 2 點後日K還沒有今天就加上今天，之前或日K已有就不加", () => {
    const d = bars.map((b) => b.date);
    expect(flowDates(d, "20261023", 15, true)).toEqual([...d, "20261023"]);
    expect(flowDates(d, "20261023", 11, true)).toEqual(d);
    expect(flowDates(d, "20261022", 15, true)).toEqual(d);
    expect(flowDates(d, "20261024", 15, false)).toEqual(d);
  });
});
