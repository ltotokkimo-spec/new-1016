import { describe, expect, it } from "vitest";
import { fmtValue, rankPool, rankQuotes } from "../src/engine/volRank";
import { rankUrl } from "../src/data/volRank";

const q = (code: string, price: number, prev: number, lots: number) => ({ code, name: `測試${code}`, price, prevClose: prev, volume: lots * 1000, time: "10:01:05", date: "20261112" });

describe("當沖成交量排行", () => {
  it("依成交量排前 n 名，量相同比成交值", () => {
    const rows = rankQuotes([q("1101", 30, 30, 500), q("2303", 50, 49, 9000), q("2330", 1000, 990, 9000), q("3481", 20, 19, 20000), { ...q("9999", 10, 10, 0) }], "vol", 3);
    expect(rows.map((r) => r.code)).toEqual(["3481", "2330", "2303"]);
    expect(rows[0]).toMatchObject({ rank: 1, lots: 20000, move: 0 });
    expect(rows[1].chg).toBeCloseTo(10 / 990);
  });
  it("依成交值排序", () => {
    const rows = rankQuotes([q("3481", 20, 19, 20000), q("2330", 1000, 990, 9000)], "value", 15);
    expect(rows.map((r) => r.code)).toEqual(["2330", "3481"]);
    expect(fmtValue(rows[0].value)).toBe("90.0 億");
    expect(fmtValue(4e8)).toBe("4.0 億");
    expect(fmtValue(5e6)).toBe("500 萬");
  });
  it("跟上一輪比：升降與新進榜", () => {
    const prev = new Map([["2330", 1], ["3481", 2]]);
    const rows = rankQuotes([q("3481", 20, 19, 20000), q("2330", 1000, 990, 9000), q("2303", 50, 49, 8000)], "vol", 15, prev);
    expect(rows.map((r) => r.move)).toEqual([1, -1, "new"]);
  });
  it("候選名單：股票依前一天量取前 n，ETF 另外加，不重複", () => {
    const st = [{ code: "A", volume: 1 }, { code: "B", volume: 5 }, { code: "C", volume: 3 }];
    const etf = [{ code: "00632R", volume: 9 }, { code: "B", volume: 5 }];
    expect(rankPool(st, etf, 2, 2).map((x) => x.code)).toEqual(["B", "C", "00632R"]);
    expect(rankPool(st, etf, 2, 0).map((x) => x.code)).toEqual(["B", "C"]);
  });
  it("上市問 tse_、上櫃問 otc_", () => {
    expect(rankUrl([{ code: "2330", market: "TWSE" }, { code: "6488", market: "TPEX" }])).toContain("ex_ch=tse_2330.tw|otc_6488.tw");
  });
});
