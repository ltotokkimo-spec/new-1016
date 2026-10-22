import { describe, expect, it } from "vitest";
import { parseTaifex, taifexBody } from "../src/data/taifexLive";

// 期交所 MIS 的真實回應（2026/10/22 日盤 10:21、夜盤為 10/21 晚上到 10/22 清晨），只留前幾個契約
const DAY = { RtCode: "0", RtMsg: "", RtData: { QuoteList: [
  { SymbolID: "TXF-S", DispCName: "臺指現貨", CTotalVolume: "", COpenPrice: "46942.75", CHighPrice: "47332.18", CLowPrice: "46705.72", CLastPrice: "46794.63", CRefPrice: "46887.77", CDate: "20261022", CTime: "102155", CDiff: "-93.14", CDiffRate: "-0.20" },
  { SymbolID: "TXFK6-F", DispCName: "臺指期116", CTotalVolume: "24199", COpenPrice: "47164.00", CHighPrice: "47337.00", CLowPrice: "46840.00", CLastPrice: "46914.00", CRefPrice: "47013.00", CDate: "20261022", CTime: "102153", CDiff: "-99.00", CDiffRate: "-0.21" },
  { SymbolID: "TXFL6-F", DispCName: "臺指期126", CTotalVolume: "192", CHighPrice: "47463.00", CLowPrice: "46990.00", CLastPrice: "47014.00", CRefPrice: "47159.00", CDate: "20261022", CTime: "102038", CDiff: "-145.00", CDiffRate: "-0.31" },
] } };
const NIGHT = { RtCode: "0", RtMsg: "", RtData: { QuoteList: [
  { SymbolID: "TXF-P", DispCName: "臺指現貨", CLastPrice: "", CRefPrice: "46887.77", CDate: "20261021", CTime: "", CDiff: "0.00", CDiffRate: "0.00" },
  { SymbolID: "TXFK6-M", DispCName: "臺指期116", Status: "TC", CTotalVolume: "35705", COpenPrice: "46991.00", CHighPrice: "47555.00", CLowPrice: "46983.00", CLastPrice: "47482.00", CRefPrice: "47013.00", CDate: "20261021", CTime: "045958", CDiff: "469.00", CDiffRate: "1.00" },
  { SymbolID: "TXFL6-M", DispCName: "臺指期126", CLastPrice: "47636.00", CRefPrice: "47159.00", CDate: "20261021", CTime: "045446", CDiff: "477.00" },
] } };

describe("台指期（期交所 MIS）", () => {
  it("日盤：略過現貨，取近月契約的價格、漲跌、高低與成交量", () => {
    const q = parseTaifex(DAY, "day")!;
    expect(q.symbol).toBe("TXFK6-F");
    expect(q.last).toBe(46914);
    expect(q.change).toBe(-99);
    expect(q.changePct).toBeCloseTo(-0.2106, 3);
    expect([q.high, q.low, q.volume]).toEqual([47337, 46840, 24199]);
    expect(q.time).toBe("10:21");
    expect(q.session).toBe("day");
    expect(q.spot).toBe(46794.63); // 同一份報價裡的現貨（TXF-S）：基差 = 期貨 − 現貨 = 46,914 − 46,794.63
  });
  it("夜盤：昨晚到清晨的近月，漲跌對前一日結算價，時間是最後一筆成交", () => {
    const q = parseTaifex(NIGHT, "night")!;
    expect(q.symbol).toBe("TXFK6-M");
    expect(q.last).toBe(47482);
    expect(q.change).toBe(469);
    expect(q.changePct).toBeCloseTo(0.9976, 3);
    expect(q.time).toBe("04:59");
    expect(q.spot).toBeUndefined(); // 夜盤沒有現貨成交價，不算基差
  });
  it("開盤前沒有成交價（只有現貨或空值）就不顯示", () => {
    expect(parseTaifex({ RtData: { QuoteList: [{ SymbolID: "TXFK6-F", CLastPrice: "", CRefPrice: "47013.00" }] } }, "day")).toBeUndefined();
    expect(parseTaifex({ RtData: { QuoteList: [DAY.RtData.QuoteList[0]] } }, "day")).toBeUndefined();
    expect(parseTaifex({}, "day")).toBeUndefined();
    expect(parseTaifex(null, "night")).toBeUndefined();
  });
  it("請求內容：日盤 MarketType 0、夜盤 1，台指期 TXF", () => {
    expect(taifexBody("day")).toMatchObject({ MarketType: "0", CID: "TXF", SymbolType: "F" });
    expect(taifexBody("night").MarketType).toBe("1");
  });
});
