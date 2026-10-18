import { describe, expect, it } from "vitest";
import { orderDay, prettyW } from "../src/lib/dates";

// 台北時間 → UTC 毫秒
const tpe = (ymd: string, hh: number, mm = 0) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), hh - 8, mm);

describe("orderDay 建議下單日", () => {
  it("週五收盤資料，週末看 → 下週一", () => {
    expect(orderDay("20261016", tpe("20261018", 9))).toBe("20261019");
  });
  it("週四收盤資料，週四晚上看 → 週五", () => {
    expect(orderDay("20261015", tpe("20261015", 20))).toBe("20261016");
  });
  it("資料舊了：週四資料、週五早上看 → 今天；週五下午收盤後看 → 下週一", () => {
    expect(orderDay("20261014", tpe("20261016", 8, 30))).toBe("20261016");
    expect(orderDay("20261014", tpe("20261016", 14))).toBe("20261019");
  });
  it("prettyW 顯示星期", () => {
    expect(prettyW("20261016")).toBe("10/16（五）");
    expect(prettyW("20261019")).toBe("10/19（一）");
  });
});
