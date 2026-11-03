import { describe, expect, it } from "vitest";
import { findXStock, parseOkxCandles, parseOkxTicker, taipeiStamp } from "../src/data/okx";

// OKX v5 回應格式：{ code: "0", msg: "", data: [...] }
const inst = (rows: [string, string, string, string?][]) => ({ code: "0", msg: "", data: rows.map(([instId, baseCcy, quoteCcy, state]) => ({ instId, baseCcy, quoteCcy, state: state ?? "live", instType: "SPOT" })) });

describe("OKX xStocks（美股 24 小時行情）", () => {
  const list = inst([
    ["XAAOI-USDT", "xAAOI", "USDT"], ["XAAOI-USDC", "xAAOI", "USDC"],
    ["AAPLX-USD", "AAPLx", "USD"], ["AAPLX-USDT", "AAPLx", "USDT"],
    ["XAXTI-USDT", "xAXTI", "USDT", "suspend"],
    ["XBRKB-USDT", "xBRKB", "USDT"], ["AXS-USDT", "AXS", "USDT"], ["XAAOIZ-USDT", "xAAOIZ", "USDT"],
  ]);
  it("「x＋代號」與「代號＋x」都找得到，計價優先 USDT", () => {
    expect(findXStock(list, "AAOI")).toBe("XAAOI-USDT");
    expect(findXStock(list, "aapl")).toBe("AAPLX-USDT");
  });
  it("停止交易的不算；名字相近的不誤認；BRK.B 去掉點再比", () => {
    expect(findXStock(list, "AXTI")).toBeUndefined();
    expect(findXStock(list, "BRK.B")).toBe("XBRKB-USDT");
    expect(findXStock(list, "AXS")).toBeUndefined();
    expect(findXStock({ code: "50011", msg: "Too Many Requests", data: [] }, "AAOI")).toBeUndefined();
  });
  it("ticker：最新價、24 小時開高低、量（幣）與額（USDT）", () => {
    const t = parseOkxTicker({ code: "0", data: [{ instId: "XAAOI-USDT", last: "63.05", open24h: "69.78", high24h: "73.92", low24h: "62.04", vol24h: "747.14", volCcy24h: "50100", ts: "1793700000000" }] });
    expect(t).toEqual({ last: 63.05, open24h: 69.78, high24h: 73.92, low24h: 62.04, vol24h: 747.14, amount24h: 50100, ts: 1793700000000 });
    expect(parseOkxTicker({ code: "51001", data: [] })).toBeUndefined();
  });
  it("K 線：最新在前 → 由舊到新，時間換成台北時間 YYYYMMDDHHmm", () => {
    const ts1 = Date.UTC(2026, 10, 3, 1, 0), ts2 = Date.UTC(2026, 10, 3, 2, 0); // 台北 09:00、10:00
    const b = parseOkxCandles({ code: "0", data: [[String(ts2), "48.5", "48.9", "47.7", "47.77", "12.3", "590", "590", "0"], [String(ts1), "50", "50.2", "48.1", "48.5", "20", "980", "980", "1"], ["bad"]] });
    expect(b).toEqual([
      { date: "202611030900", open: 50, high: 50.2, low: 48.1, close: 48.5, volume: 20 },
      { date: "202611031000", open: 48.5, high: 48.9, low: 47.7, close: 47.77, volume: 12.3 },
    ]);
  });
  it("台北時間跨日", () => {
    expect(taipeiStamp(Date.UTC(2026, 10, 2, 20, 30))).toBe("202611030430");
  });
});
