import { describe, expect, it } from "vitest";
import { flowRank, sharesOf } from "../src/engine/etfRank";
import { buildTwInputs } from "../src/data/twLoader";

const e = (code: string, close: number, flow1: [number, number, number], flow5: [number, number, number]) => ({ code, name: `ETF${code}`, close, flow1, flow5 });

describe("買賣超排名", () => {
  const list = [
    e("0050", 100, [1_000_000, 0, 0], [3_000_000, 0, 0]), // 今日買超 1 億
    e("00878", 20, [2_000_000, 1_000_000, 0], [-5_000_000, 0, 0]), // 今日 3000 張但只 6000 萬
    e("00632R", 10, [-4_000_000, 0, -1_000_000], [0, 0, 0]), // 今日賣超 5000 萬
    e("006208", 120, [0, 0, 0], [0, 0, 0]),
  ];
  it("依金額（股數 × 收盤）排名，不是依張數", () => {
    const r = flowRank(list, 1, "all");
    expect(r.buy.map((x) => x.item.code)).toEqual(["0050", "00878"]);
    expect(r.buy[0].amount).toBe(100_000_000);
    expect(r.sell.map((x) => x.item.code)).toEqual(["00632R"]);
    expect(r.sell[0].shares).toBe(-5_000_000);
  });
  it("分外資／投信／自營與近 5 日；買賣超為 0 的不列", () => {
    expect(flowRank(list, 1, "trust").buy.map((x) => x.item.code)).toEqual(["00878"]);
    expect(flowRank(list, 1, "dealer").sell.map((x) => x.item.code)).toEqual(["00632R"]);
    const r5 = flowRank(list, 5, "foreign");
    expect(r5.buy.map((x) => x.item.code)).toEqual(["0050"]);
    expect(r5.sell.map((x) => x.item.code)).toEqual(["00878"]);
    expect(sharesOf(undefined, "all")).toBeUndefined();
  });
  it("最多取前 N 名", () => {
    const many = Array.from({ length: 30 }, (_, i) => e(String(10 + i), 10, [(i + 1) * 1000, 0, 0], [0, 0, 0]));
    const r = flowRank(many, 1, "all", 20);
    expect(r.buy).toHaveLength(20);
    expect(r.buy[0].item.code).toBe("39");
  });
  it("評分輸入帶出今日與近 5 日的外資、投信、自營（新到舊）", () => {
    const q = (code: string, close: number) => [code, code, close, 0, 1e8, 1e6] as [string, string, number, number, number, number];
    const flows = Array.from({ length: 6 }, (_, i) => [["0050", 1000 * (i + 1), 10, -5] as [string, number, number, number]]);
    const [x] = buildTwInputs({ latest: [q("0050", 100)], week: [], month: [], quarter: [], flows, companies: [], tpexCodes: new Set() });
    expect(x.flow1).toEqual([1000, 10, -5]);
    expect(x.flow5).toEqual([1000 + 2000 + 3000 + 4000 + 5000, 50, -25]);
  });
  it("評分輸入帶出當日成交股數（ETF 清單依成交量排序用）", () => {
    const q = (code: string, close: number, vol: number) => [code, code, close, 0, 1e8, vol] as [string, string, number, number, number, number];
    const xs = buildTwInputs({ latest: [q("0050", 100, 123_456_000), q("00878", 20, 987_654_000)], week: [], month: [], quarter: [], flows: [], companies: [], tpexCodes: new Set() });
    expect(xs.map((x) => x.volume)).toEqual([123_456_000, 987_654_000]);
  });
});
