import { describe, expect, it } from "vitest";
import { avgLine, intradayUrl, mergeLive, minuteOf, parseIntraday } from "../src/data/intraday";

// 台北 09:00 = UTC 01:00；2026-11-04
const t0 = Date.UTC(2026, 10, 4, 1, 0) / 1000;
const yahoo = (closes: (number | null)[], vols: number[], prev = 100) => ({
  chart: { result: [{ meta: { chartPreviousClose: prev }, timestamp: closes.map((_, i) => t0 + i * 60), indicators: { quote: [{ close: closes, volume: vols }] } }] },
});

describe("即時走勢（分時）", () => {
  it("上市用 .TW、上櫃用 .TWO 的 1 分鐘線", () => {
    expect(intradayUrl("2330", "TWSE")).toContain("/2330.TW?interval=1m&range=1d");
    expect(intradayUrl("6182", "TPEX")).toContain("/6182.TWO?interval=1m");
  });
  it("Yahoo 分鐘線轉成 09:00 起的分鐘、略過沒成交的分鐘、帶昨收與日期", () => {
    const d = parseIntraday(yahoo([101, null, 99], [1000, 0, 2000]))!;
    expect(d.date).toBe("20261104");
    expect(d.prevClose).toBe(100);
    expect(d.points).toEqual([{ m: 0, price: 101, vol: 1000 }, { m: 2, price: 99, vol: 2000 }]);
    expect(d.lastYahoo).toBe(2);
    expect(parseIntraday({ chart: { result: [] } })).toBeNull();
  });
  it("即時價接到最後：同一分鐘換成最新價，較晚的分鐘新增一點；累計量多出來的算在最新一分鐘", () => {
    const d = parseIntraday(yahoo([101, 102], [1000, 1000]))!;
    const a = mergeLive(d, { date: "20261104", time: "09:01:30", price: 103, prevClose: 100, volume: 2500 })!;
    expect(a.points.at(-1)).toEqual({ m: 1, price: 103, vol: 1500 });
    const b = mergeLive(d, { date: "20261104", time: "09:05:00", price: 104, prevClose: 100, volume: 2000 }, [{ m: 3, price: 102.5 }])!;
    expect(b.points.map((p) => p.m)).toEqual([0, 1, 3, 5]);
    expect(b.points.at(-1)!.price).toBe(104);
  });
  it("Yahoo 還是昨天、即時價是今天：只畫今天的即時價；收盤後的時間算 13:30", () => {
    const d = parseIntraday(yahoo([101], [1000]))!;
    const r = mergeLive(d, { date: "20261105", time: "09:10:00", price: 99, prevClose: 101 })!;
    expect(r.date).toBe("20261105");
    expect(r.points).toEqual([{ m: 10, price: 99, vol: 0 }]);
    expect(minuteOf("14:30:00")).toBe(270);
  });
  it("開盤前（07:50）證交所回今天日期＋昨收：不覆蓋上一個交易日的走勢", () => {
    const d = parseIntraday(yahoo([101, 102], [1000, 1000]))!;
    expect(mergeLive(d, { date: "20261105", time: "07:50:00", price: 102, prevClose: 102 })).toBe(d);
  });
  it("均價線是成交量加權", () => {
    expect(avgLine([{ m: 0, price: 100, vol: 1 }, { m: 1, price: 110, vol: 3 }, { m: 2, price: 120, vol: 0 }])).toEqual([100, 107.5, 107.5]);
  });
});
