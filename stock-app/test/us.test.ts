import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { parseNasdaqHistory, parseCnbcQuotes, retN, sma, rsi } from "../src/data/us";
import { parseTwseStockDay, parseTpexStockHist, rocToYmd } from "../src/data/tw";

const fx = (n: string) => JSON.parse(fs.readFileSync(`test/fixtures/${n}`, "utf8"));

describe("Nasdaq 歷史（實際資料）", () => {
  it("個股：去掉 $、由舊到新", () => {
    const bars = parseNasdaqHistory(fx("nasdaq_AAPL.json"));
    expect(bars.length).toBe(137);
    expect(bars[bars.length - 1]).toEqual({ date: "20261015", close: 342, volume: 39767260, open: 346.95, high: 347.85, low: 341.6 });
    expect(bars[0].date < bars[bars.length - 1].date).toBe(true);
  });
  it("ETF 與 BRK.B", () => {
    expect(parseNasdaqHistory(fx("nasdaq_SPY.json")).at(-1)!.close).toBe(771.79);
    expect(parseNasdaqHistory(fx("nasdaq_BRKB.json")).length).toBeGreaterThan(20);
  });
  it("指標", () => {
    const bars = parseNasdaqHistory(fx("nasdaq_AAPL.json"));
    expect(retN(bars, 5)).toBeCloseTo(342 / bars[bars.length - 6].close - 1, 10);
    const ma20 = sma(bars, 20);
    expect(ma20).toBeCloseTo(bars.slice(-20).reduce((a, b) => a + b.close, 0) / 20, 10);
    const r = rsi(bars);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(100);
    expect(retN(bars.slice(0, 3), 5)).toBeNaN();
  });
  it("錯誤回應回傳空陣列", () => {
    expect(parseNasdaqHistory({ data: null, status: { rCode: 400 } })).toEqual([]);
  });
});

describe("CNBC 指標（實際資料）", () => {
  it("美股、殖利率、匯率、原物料", () => {
    const q = parseCnbcQuotes(fx("cnbc_macro.json"));
    const by = Object.fromEntries(q.map((x) => [x.symbol, x]));
    expect(by[".SPX"]).toMatchObject({ last: 7744.06, change: 25.12, changePct: 0.33 });
    expect(by["US10Y"].last).toBe(5.102);
    expect(by["TWD="].last).toBe(32.376);
    expect(by["@GC.1"].last).toBe(4204.7);
    expect(by[".TWII"].last).toBe(47111.26);
  });
});

describe("台股個股月資料（實際資料）", () => {
  it("民國日期", () => expect(rocToYmd("115/09/01")).toBe("20260901"));
  it("證交所 2330", () => {
    const b = parseTwseStockDay(fx("twse_stock_day.json"));
    expect(b[0]).toEqual({ date: "20260901", open: 2395, high: 2440, low: 2390, close: 2440, volume: 31855287 });
  });
  it("櫃買 6488（成交仟股換算成股）", () => {
    const b = parseTpexStockHist(fx("tpex_stock_hist.json"));
    expect(b[0]).toEqual({ date: "20260901", open: 908, high: 998, low: 908, close: 994, volume: 12770000 });
  });
});
