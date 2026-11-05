import { describe, expect, it } from "vitest";
import { fixPrevClose, parseUsIntraday, usClock, usIntradayUrl, usSessionOf, usSessionStats, usToTaipei } from "../src/data/usIntraday";

// 2026-11-05 美東（冬令 UTC-5）：04:00 ET = 09:00 UTC
const t0 = Date.UTC(2026, 10, 5, 9, 0) / 1000;
const at = (h: number, m: number) => t0 + ((h - 4) * 60 + m) * 60;
const yahoo = (rows: [number, number, number][]) => ({
  chart: { result: [{ meta: { chartPreviousClose: 100, gmtoffset: -18000, currentTradingPeriod: { regular: { start: at(9, 30), end: at(16, 0) } } },
    timestamp: rows.map((r) => r[0]), indicators: { quote: [{ close: rows.map((r) => r[1]), volume: rows.map((r) => r[2]) }] } }] },
});

describe("美股即時走勢（盤前、盤中、盤後）", () => {
  it("網址含盤前盤後；BRK.B 轉成 BRK-B", () => {
    expect(usIntradayUrl("AAPL")).toContain("/AAPL?interval=1m&range=1d&includePrePost=true");
    expect(usIntradayUrl("BRK.B")).toContain("/BRK-B?");
  });
  it("時間換成美東 04:00 起的分鐘，分出三個時段，各段漲跌對照正確", () => {
    const d = parseUsIntraday(yahoo([[at(4, 0), 101, 10], [at(9, 0), 102, 20], [at(9, 30), 103, 1000], [at(15, 59), 105, 2000], [at(16, 0), 106, 30], [at(19, 59), 104, 40]]))!;
    expect(d.date).toBe("20261105");
    expect(d.regStart).toBe(330);
    expect(d.regEnd).toBe(720);
    expect(d.points.map((p) => p.m)).toEqual([0, 300, 330, 719, 720, 959]);
    expect(usSessionOf(d, 300)).toBe("盤前");
    expect(usSessionOf(d, 330)).toBe("盤中");
    expect(usSessionOf(d, 720)).toBe("盤後");
    const st = usSessionStats(d);
    expect(st.pre!.last).toBe(102);
    expect(st.pre!.chg).toBeCloseTo(0.02);
    expect(st.reg!.last).toBe(105);
    expect(st.post!.chg).toBeCloseTo(104 / 105 - 1); // 盤後對照盤中收盤
    expect(st.regHigh).toBe(105);
    expect(st.regVol).toBe(3000);
    expect(st.extVol).toBe(100);
  });
  it("美東時間與台北時間（冬令差 13 小時）", () => {
    expect(usClock(330)).toBe("09:30");
    expect(usToTaipei(330, -18000)).toBe("22:30");
    expect(usToTaipei(0, -14400)).toBe("16:00"); // 夏令 04:00 ET＝台北 16:00
  });
  it("昨收校正：盤前用 CNBC 停在前一交易日的收盤；同一天用 CNBC 的昨收；沒有就用 Yahoo", () => {
    const d = parseUsIntraday(yahoo([[at(7, 20), 352.8, 10]]))!; // Yahoo 昨收 100（錯的）
    expect(fixPrevClose(d, { date: "20261104", price: 349.5, prevClose: 331.9, final: true }).d.prevClose).toBe(349.5);
    expect(fixPrevClose(d, { date: "20261105", price: 351, prevClose: 349.5, final: false }).d.prevClose).toBe(349.5);
    expect(fixPrevClose(d, undefined)).toEqual({ d, src: "yahoo" });
  });
  it("沒有資料回 null", () => {
    expect(parseUsIntraday({ chart: { result: [] } })).toBeNull();
  });
});
