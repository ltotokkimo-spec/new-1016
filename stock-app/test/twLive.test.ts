import { describe, expect, it } from "vitest";
import { isLiveNow, livePolling, liveUrl, marketOpen, parseLive, preOpen } from "../src/data/twLive";

describe("證交所即時報價", () => {
  it("鎖跌停（沒有買單、這筆沒有成交價）：用賣價第一個有價格的（跌停價），不是昨收；今日不會顯示 0%", () => {
    const q = parseLive({ msgArray: [{ c: "6515", n: "穎崴", z: "-", y: "4020.0000", o: "3995", h: "3995", l: "3620", u: "4420", w: "3620", v: "464", a: "0.0000_3620.0000_3640.0000_", b: "-", d: "20261105", t: "13:17:57" }] })["6515"];
    expect(q.price).toBe(3620);
    expect(q.limit).toBe("down");
    const up = parseLive({ msgArray: [{ c: "1111", z: "-", y: "100", u: "110", w: "90", a: "-", b: "110.0000_109.5000_", d: "20261105", t: "10:00:00" }] })["1111"];
    expect(up.price).toBe(110);
    expect(up.limit).toBe("up");
  });
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

// 2026/11/02 08:41 實際抓到的證交所回傳（開盤前試搓時段）：z 是 "-"（還沒成交），pz 是試搓價
describe("開盤前試搓價", () => {
  const pre = (o: Record<string, string>) => ({ msgArray: [{ n: "x", d: "20261102", o: "-", h: "-", l: "-", v: "0", z: "-", ...o }] });
  it("真實回傳：台積電試搓 2,255（昨收 2,370）；價格用 pz，標成試搓，不是昨收也不是買價", () => {
    const q = parseLive(pre({ c: "2330", n: "台積電", y: "2370.0000", pz: "2255.0000", b: "2250.0000_2245.0000_", a: "2255.0000_2260.0000_", t: "08:41:49" }))["2330"];
    expect(q.price).toBe(2255);
    expect(q.trial).toBe(true);
    expect(q.final).toBe(false);
    expect(q.prevClose).toBe(2370);
    expect(Number.isNaN(q.open)).toBe(true); // 沒有開盤價 → K 線不會拼出「今天」那一根
    expect(q.price / q.prevClose - 1).toBeCloseTo(-0.0485, 3);
  });
  it("真實回傳：友達、合晶（上櫃）、00406A 都有試搓價", () => {
    const r = parseLive({ msgArray: [
      { c: "2409", n: "友達", d: "20261102", y: "30.6500", pz: "27.6500", b: "27.6500_27.6000_", z: "-", o: "-", t: "08:41:43", v: "0" },
      { c: "6182", n: "合晶", d: "20261102", y: "93.9000", pz: "90.0000", b: "90.0000_89.9000_", z: "-", o: "-", t: "08:41:36", v: "0" },
      { c: "00406A", n: "主動中信台灣收益", d: "20261102", y: "8.6000", pz: "8.5900", b: "8.5900_8.5800_", z: "-", o: "-", t: "08:41:42", v: "0" },
    ] });
    expect([r["2409"].price, r["6182"].price, r["00406A"].price]).toEqual([27.65, 90, 8.59]);
    expect([r["2409"].trial, r["6182"].trial, r["00406A"].trial]).toEqual([true, true, true]);
  });
  it("試搓價和最佳買價不同時用 pz（不是買一價）", () => {
    const q = parseLive(pre({ c: "2308", y: "1335.0000", pz: "1205.0000", b: "1200.0000_", t: "08:41:45" }))["2308"];
    expect(q.price).toBe(1205);
  });
  it("已經有成交價（z）就用成交價，不是試搓；09:00 以後沒成交也不當試搓", () => {
    const traded = parseLive(pre({ c: "2330", y: "2370", z: "2360.0000", pz: "2255.0000", t: "09:00:05" }))["2330"];
    expect(traded.price).toBe(2360);
    expect(traded.trial).toBeUndefined();
    const noTrade = parseLive(pre({ c: "2330", y: "2370", pz: "2255.0000", b: "2350.0000_", t: "09:03:00" }))["2330"];
    expect(noTrade.trial).toBeUndefined();
    expect(noTrade.price).toBe(2350); // 維持原本：沒成交用最佳買價
  });
  it("試搓時段判斷與更新時段（台北時間）", () => {
    const at = (iso: string) => Date.parse(iso + "+08:00");
    expect(preOpen(at("2026-11-02T08:29:00"))).toBe(false);
    expect(preOpen(at("2026-11-02T08:30:00"))).toBe(true);
    expect(preOpen(at("2026-11-02T08:59:59"))).toBe(true);
    expect(preOpen(at("2026-11-02T09:00:00"))).toBe(false);
    expect(preOpen(at("2026-11-01T08:40:00"))).toBe(false); // 週日
    expect(livePolling(at("2026-11-02T08:40:00"))).toBe(true);
    expect(livePolling(at("2026-11-02T10:00:00"))).toBe(true);
    expect(livePolling(at("2026-11-02T08:00:00"))).toBe(false);
    expect(livePolling(at("2026-11-02T14:00:00"))).toBe(false);
  });
  it("isLiveNow：試搓價只在開盤前算即時；09:00 後過期的試搓價不算", () => {
    const q = parseLive(pre({ c: "2330", y: "2370", pz: "2255", t: "08:41:49" }))["2330"];
    const at = (iso: string) => Date.parse(iso + "+08:00");
    expect(isLiveNow(q, "20261102", at("2026-11-02T08:45:00"))).toBe(true);
    expect(isLiveNow(q, "20261102", at("2026-11-02T09:30:00"))).toBe(true); // 交易時段：照常算即時（下一次更新會換成成交價）
    expect(isLiveNow(q, "20261102", at("2026-11-02T15:00:00"))).toBe(false);
    expect(isLiveNow(q, "20261101", at("2026-11-02T08:45:00"))).toBe(false); // 不是今天的
  });
});

describe("漲停／跌停燈號（即時報價）", () => {
  const q = (o: Record<string, string>) => parseLive({ msgArray: [{ c: "2308", n: "台達電", d: "20261030", t: "13:30:00", v: "18264", o: "1365", h: "1395", l: "1335", y: "1480.0000", u: "1625.0000", w: "1335.0000", ...o }] })["2308"];
  it("成交價等於證交所給的跌停價 w → 跌停；等於漲停價 u → 漲停", () => {
    expect(q({ z: "1335.0000" }).limit).toBe("down"); // 10/30 台達電真實情況
    expect(q({ z: "1625.0000" }).limit).toBe("up");
    expect(q({ z: "1340.0000" }).limit).toBeUndefined();
  });
  it("開盤前試搓價碰到跌停價也亮燈（11/02 台達電試搓 1,205 = 跌停價 1,205）", () => {
    const r = parseLive({ msgArray: [{ c: "2308", n: "台達電", d: "20261102", t: "08:41:45", z: "-", pz: "1205.0000", y: "1335.0000", u: "1465.0000", w: "1205.0000", o: "-", v: "0" }] })["2308"];
    expect(r.trial).toBe(true);
    expect(r.limit).toBe("down");
  });
  it("沒有 u／w 時用規則算；有 u／w 但沒碰到就不亮", () => {
    const noUw = parseLive({ msgArray: [{ c: "2330", n: "台積電", d: "20261030", t: "13:30:00", z: "2605.0000", y: "2370.0000", v: "1" }] })["2330"];
    expect(noUw.limit).toBe("up");
    const normal = parseLive({ msgArray: [{ c: "2330", n: "台積電", d: "20261030", t: "13:30:00", z: "2370.0000", y: "2370.0000", u: "2605.0000", w: "2135.0000", v: "1" }] })["2330"];
    expect(normal.limit).toBeUndefined();
  });
});

