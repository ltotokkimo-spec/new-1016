import { describe, expect, it } from "vitest";
import { findRwaTotal, findStockCategory, fmtUsdYi, parseCgCategories, parseCgMarkets, rwaSubcategories, zhCategory } from "../src/data/rwa";

// CoinGecko /coins/categories 的回應格式（依官方文件的欄位）
const cats = [
  { id: "real-world-assets-rwa", name: "Real World Assets (RWA)", market_cap: 28_500_000_000, market_cap_change_24h: -1.23, volume_24h: 1e9, top_3_coins: [] },
  { id: "tokenized-treasury-bills", name: "Tokenized Treasury Bills (T-Bills)", market_cap: 7_400_000_000, market_cap_change_24h: 0.12 },
  { id: "tokenized-gold", name: "Tokenized Gold", market_cap: 3_100_000_000, market_cap_change_24h: -0.9 },
  { id: "tokenized-stock", name: "Tokenized Stock", market_cap: 600_000_000, market_cap_change_24h: 2.4 },
  { id: "xstocks-ecosystem", name: "xStocks Ecosystem", market_cap: 400_000_000, market_cap_change_24h: 1.1 },
  { id: "tokenized-commodities", name: "Tokenized Commodities", market_cap: 3_300_000_000, market_cap_change_24h: -0.8 },
  { id: "layer-1", name: "Layer 1 (L1)", market_cap: 2e12, market_cap_change_24h: 0.5 },
  { id: "empty", name: "Tokenized Nothing", market_cap: null },
];

describe("RWA 與代幣化美股（CoinGecko）", () => {
  const c = parseCgCategories(cats);
  it("類別：沒有市值的略過", () => {
    expect(c.find((x) => x.id === "empty")).toBeUndefined();
    expect(c.find((x) => x.id === "tokenized-gold")).toMatchObject({ cap: 3.1e9, chg24h: -0.9 });
  });
  it("找 RWA 總類別與代幣化美股類別（id 改名時用名稱比對）", () => {
    expect(findRwaTotal(c)!.id).toBe("real-world-assets-rwa");
    expect(findStockCategory(c)!.id).toBe("tokenized-stock");
    const renamed = c.map((x) => ({ ...x, id: x.id + "-v2" }));
    expect(findRwaTotal(renamed)!.name).toContain("Real World");
    expect(findStockCategory(renamed)!.name).toBe("Tokenized Stock");
    expect(findStockCategory(c.filter((x) => x.id !== "tokenized-stock"))!.id).toBe("xstocks-ecosystem");
  });
  it("子分類：只要代幣化類別、排除生態系、依市值排序、中文名稱不重複", () => {
    const subs = rwaSubcategories(c, findRwaTotal(c));
    expect(subs.map((x) => zhCategory(x.name))).toEqual(["代幣化公債", "代幣化商品", "代幣化黃金", "代幣化股票"]);
    expect(subs.some((x) => /ecosystem|Layer/i.test(x.name))).toBe(false);
  });
  it("代幣報價：價格、市值、24 小時與 7 天漲跌，代號轉大寫", () => {
    const t = parseCgMarkets([
      { id: "apple-xstock", symbol: "aaplx", name: "Apple xStock", current_price: 270.5, market_cap: 1.2e7, price_change_percentage_24h: 1.5, price_change_percentage_7d_in_currency: -2.1 },
      { id: "bad", symbol: "x", name: "沒有價格", current_price: null },
    ]);
    expect(t).toEqual([{ id: "apple-xstock", symbol: "AAPLX", name: "Apple xStock", price: 270.5, cap: 1.2e7, chg24h: 1.5, chg7d: -2.1 }]);
    expect(parseCgMarkets({ error: "rate limit" })).toEqual([]);
  });
  it("金額換成億美元", () => {
    expect(fmtUsdYi(28_500_000_000)).toBe("285 億美元");
    expect(fmtUsdYi(600_000_000)).toBe("6.0 億美元");
    expect(fmtUsdYi(12_000_000)).toBe("1,200 萬美元");
  });
});
