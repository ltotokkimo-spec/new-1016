import { describe, expect, it } from "vitest";
import { limitDownPrice, limitFromChg, limitState, limitUpPrice, tickSize } from "../src/lib/limit";

// 11/02 08:41 證交所即時資料給的漲停價 u、跌停價 w（昨收 → u / w），用來驗證算法
describe("漲跌停價算法（和證交所給的 u／w 對照）", () => {
  const real: [string, number, number, number, boolean][] = [
    ["2330 台積電", 2370, 2605, 2135, false],
    ["2409 友達", 30.65, 33.7, 27.6, false],
    ["6182 合晶（上櫃）", 93.9, 103, 84.6, false],
    ["00406A 主動ETF（10 元以下）", 8.6, 9.46, 7.74, true],
    ["0050 ETF（100 元以上）", 104.95, 115.4, 94.5, true],
    ["2308 台達電", 1335, 1465, 1205, false],
  ];
  for (const [name, prev, up, dn, etf] of real) {
    it(`${name}：昨收 ${prev} → 漲停 ${up}、跌停 ${dn}`, () => {
      expect(limitUpPrice(prev, etf)).toBe(up);
      expect(limitDownPrice(prev, etf)).toBe(dn);
    });
  }
  it("升降單位：股票 10／50／100／500／1000 元分段；ETF 50 元以上 0.05", () => {
    expect([9.99, 10, 49.95, 50, 99.9, 100, 499.5, 500, 999, 1000].map((p) => tickSize(p, false))).toEqual([0.01, 0.05, 0.05, 0.1, 0.1, 0.5, 0.5, 1, 1, 5]);
    expect([9.99, 10, 49.99, 50, 600, 2000].map((p) => tickSize(p, true))).toEqual([0.01, 0.01, 0.01, 0.05, 0.05, 0.05]);
  });
});

describe("漲停／跌停判斷", () => {
  it("台達電 10/30：昨收 1,480，收 1,335 就是跌停（真實事件）", () => {
    expect(limitDownPrice(1480)).toBe(1335);
    expect(limitState(1335, 1480)).toBe("down");
    expect(limitState(1340, 1480)).toBeUndefined();
  });
  it("漲停、跌停、一般", () => {
    expect(limitState(2605, 2370)).toBe("up");
    expect(limitState(2600, 2370)).toBeUndefined(); // 差一個升降單位不算
    expect(limitState(27.6, 30.65)).toBe("down");
    expect(limitState(30.65, 30.65)).toBeUndefined();
  });
  it("沒有價格或昨收就不判斷", () => {
    expect(limitState(NaN, 100)).toBeUndefined();
    expect(limitState(100, 0)).toBeUndefined();
    expect(limitState(100, NaN)).toBeUndefined();
  });
  it("只有漲跌幅時：由收盤價與漲跌幅還原昨收再判斷（收盤快照用）", () => {
    expect(limitFromChg(1335, 1335 / 1480 - 1)).toBe("down"); // 台達電
    expect(limitFromChg(2605, 2605 / 2370 - 1)).toBe("up");
    expect(limitFromChg(104.95, 104.95 / 104.5 - 1, true)).toBeUndefined();
    expect(limitFromChg(100, 0.05)).toBeUndefined(); // 漲跌幅不到 8% 直接略過
    expect(limitFromChg(100, undefined)).toBeUndefined();
  });
});
