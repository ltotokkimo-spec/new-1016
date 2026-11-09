import { describe, expect, it } from "vitest";
import { avgLine, cachedIntraday, clearIntradayCache, fetchIntraday, loadIntraday, intradayUrl, intradayUrlTw, mergeLive, minuteOf, parseIntraday } from "../src/data/intraday";

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
  it("也看得懂奇摩股市的格式（陣列包著 chart）", () => {
    const y = yahoo([101, 102], [1000, 1000]).chart.result[0];
    const d = parseIntraday([{ chart: { meta: { previousClose: 100 }, timestamp: y.timestamp, indicators: y.indicators } }])!;
    expect(d.prevClose).toBe(100);
    expect(d.points.length).toBe(2);
  });
  it("奇摩股市與國際版都抓，取分鐘比較新的；一個失敗用另一個", async () => {
    const tw = yahoo([101, 102, 103], [1, 1, 1]), intl = yahoo([101], [1]);
    const f = async (u: string) => (u.includes("tw.stock.yahoo.com") ? tw : intl);
    expect((await fetchIntraday(f, "2330", "TWSE"))!.src).toBe("tw");
    const g = async (u: string) => { if (u.includes("tw.stock.yahoo.com")) throw new Error("x"); return intl; };
    expect((await fetchIntraday(g, "2330", "TWSE"))!.src).toBe("intl");
    expect(intradayUrlTw("6182", "TPEX")).toContain(encodeURIComponent('["6182.TWO"]'));
  });
  it("累計成交量換成每分鐘的量", () => {
    const d = parseIntraday(yahoo(Array(10).fill(100), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]))!;
    expect(d.points.map((p) => p.vol)).toEqual([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  });
  it("分時快取：期限內不重抓、同時的請求合併、過期才重抓", async () => {
    clearIntradayCache();
    let n = 0;
    const f = async () => { n++; return yahoo([101, 102], [1, 1]); };
    const [a, b] = await Promise.all([loadIntraday(f, "2330", "TWSE", 60_000), loadIntraday(f, "2330", "TWSE", 60_000)]);
    expect(a).toBe(b);
    const calls = n; // 兩個來源各一次
    await loadIntraday(f, "2330", "TWSE", 60_000);
    expect(n).toBe(calls);
    expect(cachedIntraday("2330")?.d?.points.length).toBe(2);
    await loadIntraday(f, "2330", "TWSE", 60_000, Date.now() + 61_000);
    expect(n).toBe(calls * 2);
  });
  it("即時成交量：用累計量相減算每分鐘的量；分鐘線落後的那幾分鐘平均分攤（估計），不全堆在最後一根", () => {
    const d = parseIntraday(yahoo([101, 102], [1000, 1000]))!; // 09:00、09:01，合計 2000
    const r = mergeLive(d, { date: "20261104", time: "09:06:10", price: 104, prevClose: 100, volume: 9000 }, [{ m: 4, price: 103, cum: 6000 }])!;
    // 09:01→09:04 多了 4000 股：09:02、09:03 各 1333（估計），09:04 也 1333；09:04→09:06 多 3000：09:05 估 1500、09:06 1500
    expect(r.points.map((p) => p.m)).toEqual([0, 1, 4, 6]);
    expect(Math.round(r.points[2].vol)).toBe(1333);
    expect(r.points[3].vol).toBe(1500);
    expect(r.est!.map((e) => e.m)).toEqual([2, 3, 5]);
    const total = r.points.reduce((a, p) => a + p.vol, 0) + r.est!.reduce((a, e) => a + e.vol, 0);
    expect(Math.round(total)).toBe(9000);
  });
  it("均價線是成交量加權", () => {
    expect(avgLine([{ m: 0, price: 100, vol: 1 }, { m: 1, price: 110, vol: 3 }, { m: 2, price: 120, vol: 0 }])).toEqual([100, 107.5, 107.5]);
  });
});

describe("興櫃即時走勢（09:00～15:00）", () => {
  it("興櫃保留到 15:00 的分鐘線；上市櫃只到 13:30；代號用 .TWO", async () => {
    const { parseIntraday, sessionOf, intradayUrl, minuteOf } = await import("../src/data/intraday");
    const t0 = Date.UTC(2026, 10, 9, 1, 0) / 1000; // 台北 09:00
    const ts = [t0, t0 + 3600 * 4, t0 + 3600 * 5.5]; // 09:00、13:00、14:30
    const json = { chart: { result: [{ meta: { chartPreviousClose: 600 }, timestamp: ts, indicators: { quote: [{ close: [610, 620, 655], volume: [1000, 2000, 3000] }] } }] } };
    expect(sessionOf("ESB")).toBe(360);
    expect(parseIntraday(json, sessionOf("ESB"))!.points.map((p) => p.m)).toEqual([0, 240, 330]);
    expect(parseIntraday(json)!.points.map((p) => p.m)).toEqual([0, 240]);
    expect(intradayUrl("7861", "ESB")).toContain("7861.TWO");
    expect(minuteOf("14:30:00", 360)).toBe(330);
    expect(minuteOf("14:30:00")).toBe(270);
  });
});
