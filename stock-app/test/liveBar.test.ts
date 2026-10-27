import { describe, expect, it } from "vitest";
import { withLiveBar } from "../src/engine/liveBar";
import { parseLive } from "../src/data/twLive";

const bars = [
  { date: "20261021", open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
  { date: "20261022", open: 10.5, high: 12, low: 10, close: 11, volume: 2000 },
];

describe("盤中 K 棒", () => {
  it("今天還沒有正式資料：用即時報價加一根，高低點包含現價", () => {
    const r = withLiveBar(bars, { date: "20261027", price: 11.8, open: 11.2, high: 11.6, low: 11.1, volume: 3_000_000 });
    expect(r).toHaveLength(3);
    expect(r[2]).toEqual({ date: "20261027", open: 11.2, high: 11.8, low: 11.1, close: 11.8, volume: 3_000_000, live: true });
  });
  it("已經有今天的正式資料（收盤後）就不加；沒有開盤價（還沒成交）也不加", () => {
    expect(withLiveBar(bars, { date: "20261022", price: 11, open: 10.5, high: 12, low: 10, final: true })).toBe(bars);
    expect(withLiveBar(bars, { date: "20261027", price: 11, open: NaN, high: NaN, low: NaN })).toBe(bars);
    expect(withLiveBar(bars, undefined)).toBe(bars);
  });
  it("同一天已有一根（美股下載當時的盤中 K）：盤中用即時價取代；已收盤就保留正式的", () => {
    const r = withLiveBar(bars, { date: "20261022", price: 11.5, open: 10.5, high: 12.2, low: 10, volume: 2500, final: false });
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ close: 11.5, high: 12.2, volume: 2500, live: true });
    expect(withLiveBar(bars, { date: "20261022", price: 11.5, open: 10.5, high: 12.2, low: 10, final: true })).toBe(bars);
    expect(withLiveBar(bars, { date: "20261021", price: 9, open: 9, high: 9, low: 9 })).toBe(bars); // 報價比 K 線舊
  });
  it("沒有成交量時記 0，不會變成 NaN", () => {
    expect(withLiveBar(bars, { date: "20261027", price: 11, open: 11, high: 11, low: 11 })[2].volume).toBe(0);
  });
  it("證交所即時報價的 v（累積成交張數）換算成股數", () => {
    const q = parseLive({ msgArray: [{ c: "2330", n: "台積電", z: "2400", y: "2385", o: "2390", h: "2410", l: "2380", v: "12345", d: "20261027", t: "10:30:00" }] });
    expect(q["2330"].volume).toBe(12_345_000);
  });
});
