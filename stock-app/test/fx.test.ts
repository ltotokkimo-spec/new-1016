import { describe, expect, it } from "vitest";
import { fmtNtd, usdTwdRate } from "../src/lib/fx";

describe("美元換台幣", () => {
  it("從數據頁的報價取匯率，不合理的值當沒有", () => {
    expect(usdTwdRate([{ symbol: "JPY=", last: 157.9 }, { symbol: "TWD=", last: 32.376 }])).toBe(32.376);
    expect(usdTwdRate([{ symbol: "TWD=", last: NaN }])).toBeUndefined();
    expect(usdTwdRate([{ symbol: "TWD=", last: 0.03 }])).toBeUndefined();
    expect(usdTwdRate([])).toBeUndefined();
    expect(usdTwdRate(undefined)).toBeUndefined();
  });
  it("帶正負號的台幣金額（NT$）", () => {
    expect(fmtNtd(-201, 32.4)).toBe("-NT$6,512");
    expect(fmtNtd(104, 32.4)).toBe("+NT$3,370");
    expect(fmtNtd(0, 32.4)).toBe("NT$0");
    expect(fmtNtd(0.01, 32.4)).toBe("NT$0");
    expect(fmtNtd(NaN, 32.4)).toBe("—");
  });
});
