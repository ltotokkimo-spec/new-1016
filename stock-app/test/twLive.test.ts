import { describe, expect, it } from "vitest";
import { liveUrl, marketOpen, parseLive } from "../src/data/twLive";

describe("證交所即時報價", () => {
  it("網址同時問上市與上櫃", () => {
    expect(liveUrl(["2330", "6488"])).toContain("ex_ch=tse_2330.tw|otc_2330.tw|tse_6488.tw|otc_6488.tw");
  });
  it("解析成交價；盤中沒成交用最佳買價；收盤後標示 final", () => {
    const r = parseLive({ msgArray: [
      { c: "2027", n: "大成鋼", z: "50.7000", y: "50.9000", o: "50.7000", h: "51.1000", l: "50.1000", d: "20261019", t: "11:44:44", b: "50.6000_50.5000_" },
      { c: "2480", n: "敦陽科", z: "-", y: "187.0000", o: "183.5000", h: "184.5000", l: "179.5000", d: "20261019", t: "11:43:49", b: "182.0000_181.5000_" },
      { c: "1476", n: "儒鴻", z: "321.0000", y: "329.5000", d: "20261019", t: "13:30:00" },
      { c: "9999", n: "沒資料", z: "-", y: "-", b: "-" },
    ] });
    expect(r["2027"]).toMatchObject({ price: 50.7, prevClose: 50.9, final: false, date: "20261019" });
    expect(r["2480"].price).toBe(182);
    expect(r["1476"]).toMatchObject({ price: 321, final: true });
    expect(r["9999"]).toBeUndefined();
  });
  it("交易時段判斷（台北時間）", () => {
    const tpe = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
    expect(marketOpen(tpe(2026, 10, 19, 10))).toBe(true);
    expect(marketOpen(tpe(2026, 10, 19, 14))).toBe(false);
    expect(marketOpen(tpe(2026, 10, 18, 10))).toBe(false); // 週日
  });
});
