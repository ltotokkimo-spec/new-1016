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

describe("自己加的美股", () => {
  it("公司名稱與產業", async () => {
    const { parseNasdaqName, parseNasdaqSector, isUsSymbol } = await import("../src/data/us");
    expect(parseNasdaqName({ data: { companyName: "Applied Optoelectronics, Inc. Common Stock" } })).toBe("Applied Optoelectronics");
    expect(parseNasdaqName({ data: { companyName: "NVIDIA Corporation Common Stock" } })).toBe("NVIDIA");
    expect(parseNasdaqName(null)).toBe("");
    expect(parseNasdaqSector({ data: { summaryData: { Sector: { label: "Sector", value: "Technology" } } } })).toBe("科技");
    expect(parseNasdaqSector({ data: { summaryData: { Sector: { value: "Health Care" } } } })).toBe("醫療保健");
    expect(parseNasdaqSector({})).toBe("自選");
    expect(["AAOI", "BRK.B", "A"].every(isUsSymbol)).toBe(true);
    expect(["2330", "aaoi", "TOOLONGSYM", ""].some(isUsSymbol)).toBe(false);
  });

  it("查詢：股票查不到時改用 ETF 查；都查不到回 null", async () => {
    const { UsLoader } = await import("../src/data/usLoader");
    const { memoryKV } = await import("../src/lib/kv");
    const hist = fx("nasdaq_AAPL.json");
    const fetcher = async (url: string) => {
      if (url.includes("/AAOI/historical") && url.includes("assetclass=stocks")) return hist;
      if (url.includes("/SOXL/historical") && url.includes("assetclass=etf")) return hist;
      if (url.includes("/AAOI/info")) return { data: { companyName: "Applied Optoelectronics, Inc. Common Stock" } };
      if (url.includes("/AAOI/summary")) return { data: { summaryData: { Sector: { value: "Technology" } } } };
      if (url.includes("/historical")) return { data: null, status: { rCode: 400 } };
      throw new Error("404");
    };
    const l = new UsLoader(fetcher, memoryKV());
    expect(await l.lookup("AAOI")).toEqual({ symbol: "AAOI", name: "Applied Optoelectronics", sector: "科技", etf: false });
    expect(await l.lookup("SOXL")).toEqual({ symbol: "SOXL", name: "SOXL", sector: "ETF", etf: true });
    expect(await l.lookup("ZZZZ")).toBeNull();
  });

  it("成交金額低於門檻的自選股仍會評分", async () => {
    const { scoreStocks } = await import("../src/engine/score");
    const mk = (code: string, value: number) => ({ code, name: code, market: "US" as const, sector: "科技", close: 10, value, ret1w: 0.01, ret1m: 0.02, ret3m: 0.03, aboveMa50: true, ma20AboveMa50: true, rsVsIndex1m: 0 });
    const xs = [mk("BIG1", 1e9), mk("BIG2", 1e9), mk("BIG3", 1e9), mk("TINY", 1e5)];
    expect(scoreStocks(xs).scored.map((x) => x.code)).not.toContain("TINY");
    expect(scoreStocks(xs, new Set(["TINY"])).scored.map((x) => x.code)).toContain("TINY");
  });
});
