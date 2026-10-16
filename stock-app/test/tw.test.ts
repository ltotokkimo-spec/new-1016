import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { num, isCommonStock, parseTwseQuotes, parseTwseFlows, parseTpexQuotes, parseTpexFlows, parseTwseCompanies, parseTpexCompanies } from "../src/data/tw";

const fx = (n: string) => JSON.parse(fs.readFileSync(`test/fixtures/${n}`, "utf8"));

describe("數字與代號", () => {
  it("num", () => {
    expect(num("1,234.50")).toBe(1234.5);
    expect(num("-34,111,365")).toBe(-34111365);
    expect(num("+0.30")).toBe(0.3);
    expect(num(" ---")).toBeNaN();
    expect(num("--")).toBeNaN();
    expect(num("")).toBeNaN();
  });
  it("只留一般股票", () => {
    expect(isCommonStock("2330")).toBe(true);
    expect(isCommonStock("0050")).toBe(false);
    expect(isCommonStock("00632R")).toBe(false);
    expect(isCommonStock("020025")).toBe(false);
  });
});

describe("證交所（2026/10/15 實際資料）", () => {
  it("行情", () => {
    const r = parseTwseQuotes(fx("twse_quotes.json"))!;
    expect(r.date).toBe("20261015");
    const tsmc = r.quotes.find((q) => q.code === "2330")!;
    expect(tsmc).toMatchObject({ name: "台積電", close: 2440, change: -50, open: 2420, high: 2450, low: 2420, volume: 58486711, market: "TWSE" });
    expect(r.quotes.find((q) => q.code === "0050")).toBeUndefined();
    const taiex = r.indices.find((i) => i.name === "發行量加權股價指數")!;
    expect(taiex).toEqual({ name: "發行量加權股價指數", close: 46969.87, change: -1655.96, changePct: -3.41 });
  });
  it("三大法人", () => {
    const f = parseTwseFlows(fx("twse_t86.json"))!;
    expect(f.find((x) => x.code === "2330")).toEqual({ code: "2330", foreign: -34111365, trust: 3235000, dealer: 7415881, total: -23460484 });
  });
  it("休市或錯誤回傳 null", () => {
    expect(parseTwseQuotes({ stat: "很抱歉，沒有符合條件的資料!" })).toBeNull();
    expect(parseTwseFlows({ stat: "很抱歉，沒有符合條件的資料!" })).toBeNull();
  });
});

describe("櫃買中心（2026/10/15 實際資料）", () => {
  it("行情", () => {
    const r = parseTpexQuotes(fx("tpex_quotes.json"))!;
    const q = r.quotes.find((x) => x.code === "6488")!;
    expect(q.market).toBe("TPEX");
    expect(q.name).toBe("環球晶");
    expect(Number.isFinite(q.close) && q.close > 0).toBe(true);
    expect(r.quotes.every((x) => /^[1-9]\d{3}$/.test(x.code))).toBe(true);
  });
  it("三大法人：外資＋投信＋自營＝合計", () => {
    const f = parseTpexFlows(fx("tpex_insti.json"))!;
    const w = f.find((x) => x.code === "3105")!;
    expect(w).toEqual({ code: "3105", foreign: -1865345, trust: -867200, dealer: -593105, total: -3325650 });
    for (const x of f) expect(x.foreign + x.trust + x.dealer).toBe(x.total);
  });
  it("空資料回傳 null", () => {
    expect(parseTpexQuotes({ tables: [{ fields: [], data: [] }] })).toBeNull();
    expect(parseTpexFlows({ tables: [] })).toBeNull();
  });
});

describe("產業別", () => {
  it("上市與上櫃", () => {
    expect(parseTwseCompanies(fx("twse_companies.json")).find((c) => c.code === "2330")?.industry).toBe("半導體");
    expect(parseTwseCompanies(fx("twse_companies.json")).find((c) => c.code === "2603")?.industry).toBe("航運");
    expect(parseTpexCompanies(fx("tpex_companies.json")).find((c) => c.code === "6488")?.industry).toBe("半導體");
  });
});
