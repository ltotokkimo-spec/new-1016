import { describe, expect, it } from "vitest";
import { nextWeekday as nw, openedOn as oo } from "../src/lib/dates";
describe("下單日與開盤（11/24）", () => {
  it("資料日的下一個平日，不隨現在時間往後跳", () => {
    expect(nw("20261124")).toBe("20261125");
    expect(nw("20261127")).toBe("20261130"); // 週五 → 下週一
  });
  it("下單日 09:00 開盤後才算開盤", () => {
    const tp = (ymdhm: string) => Date.UTC(+ymdhm.slice(0, 4), +ymdhm.slice(4, 6) - 1, +ymdhm.slice(6, 8), +ymdhm.slice(8, 10) - 8, +ymdhm.slice(10, 12));
    expect(oo("20261125", tp("202611241852"))).toBe(false);
    expect(oo("20261125", tp("202611250859"))).toBe(false);
    expect(oo("20261125", tp("202611250900"))).toBe(true);
    expect(oo("20261125", tp("202611251900"))).toBe(true);
    expect(oo("20261125", tp("202611260800"))).toBe(true);
  });
});
