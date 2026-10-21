import { describe, expect, it } from "vitest";
import { twNeedsRefresh } from "../src/lib/dates";

const tpe = (ymd: string, h: number, m = 0) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), h - 8, m);

describe("twNeedsRefresh 台股資料何時要重抓", () => {
  it("沒抓過、昨天抓的 → 要", () => {
    expect(twNeedsRefresh(undefined)).toBe(true);
    expect(twNeedsRefresh(tpe("20261018", 20), tpe("20261019", 9))).toBe(true);
  });
  it("今天剛抓不久 → 不用", () => {
    expect(twNeedsRefresh(tpe("20261019", 10), tpe("20261019", 11))).toBe(false);
    expect(twNeedsRefresh(tpe("20261019", 17), tpe("20261019", 19))).toBe(false);
  });
  it("超過 3 小時 → 要", () => {
    expect(twNeedsRefresh(tpe("20261019", 9), tpe("20261019", 12, 30))).toBe(true);
  });
  it("下午 4:30 前抓的，4:30 後切回來 → 要（當天評分已公布）", () => {
    expect(twNeedsRefresh(tpe("20261019", 15, 0), tpe("20261019", 16, 40))).toBe(true);
    expect(twNeedsRefresh(tpe("20261019", 16, 35), tpe("20261019", 16, 50))).toBe(false);
  });
});
