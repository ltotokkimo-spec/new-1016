import { describe, expect, it } from "vitest";
import { parseEtfNav } from "../src/data/etfNav";

// 證交所 all_etf.txt 的真實回應（2026/10/22，只留幾檔）：數字有的是字串、有的是數字
const REAL = { a1: [
  { msgArray: [
    { a: "00693U", b: "街口標普高盛黃豆ER指數股票型期貨信託基金", c: 55166000.0, d: 0.0, e: 22.68, f: 22.74, g: -0.27, h: 22.74, i: "20261022", j: "14:31:15", k: "3" },
    { a: "00992B", b: "街口特選優息非投資等級債券ETF證券投資信託基金", c: 39114000.0, d: -1500000.0, e: 9.9, f: 10.05, g: -1.49, h: 10.02, i: "20261022", j: "14:31:15", k: "3" },
  ], refURL: "https://www.jkoam.com/etf/predict", userDelay: "15000", rtMessage: "OK", rtCode: "0000" },
  { msgArray: [
    { a: "00406A", b: "主動中信台灣收益", c: 11614062000, d: 521000000, e: "9.06", f: "8.94", g: "1.34", h: "9.18", i: "20261022", j: "13:34:45", k: 1 },
    { a: "00999X", b: "沒有淨值的 ETF", c: "0", d: "0", e: "10", f: "--", g: "--", h: "10", i: "20261022", j: "13:34:45", k: 1 },
  ] },
] };

describe("ETF 即時折溢價（證交所 all_etf）", () => {
  const m = parseEtfNav(REAL);
  it("字串與數字都能解析：市價、預估淨值、折溢價、前日淨值、時間", () => {
    expect(m["00406A"]).toMatchObject({ code: "00406A", name: "主動中信台灣收益", price: 9.06, nav: 8.94, premium: 1.34, prevNav: 9.18, date: "20261022", time: "13:34:45" });
    expect(m["00693U"].premium).toBe(-0.27);
    expect(m["00992B"].price).toBe(9.9);
  });
  it("折價是負的；沒有預估淨值的略過", () => {
    expect(m["00992B"].premium).toBeLessThan(0);
    expect(m["00999X"]).toBeUndefined();
  });
  it("沒給折溢價時用市價與淨值自己算", () => {
    const x = parseEtfNav({ a1: [{ msgArray: [{ a: "0050", b: "元大台灣50", e: "110", f: "100", g: "--", h: "99", i: "20261022", j: "13:30:00" }] }] });
    expect(x["0050"].premium).toBeCloseTo(10, 6);
  });
  it("格式不對不會拋錯", () => {
    expect(parseEtfNav(null)).toEqual({});
    expect(parseEtfNav({ a1: [{}] })).toEqual({});
  });
});
