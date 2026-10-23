import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { num, isCommonStock, isEtf, isTradable, etfCategory, parseTwseQuotes, parseTwseFlows, parseTpexQuotes, parseTpexFlows, parseTwseCompanies, parseTpexCompanies } from "../src/data/tw";

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

describe("ETF", () => {
  it("代號判斷", () => {
    for (const c of ["0050", "00632R", "00406A", "006208", "00679B"]) expect(isEtf(c)).toBe(true);
    for (const c of ["2330", "020025", "7861", "030012"]) expect(isEtf(c)).toBe(false); // 020025 是 ETN、030012 是權證
  });
  it("分類", () => {
    expect(etfCategory("元大台灣50")).toBe("市值型");
    expect(etfCategory("元大台灣50反1")).toBe("槓桿反向");
    expect(etfCategory("國泰永續高股息")).toBe("高股息");
    expect(etfCategory("主動中信台灣收益")).toBe("主動式");
    expect(etfCategory("元大美債20年")).toBe("債券");
    expect(etfCategory("國泰費城半導體")).toBe("海外");
    expect(etfCategory("富邦台灣半導體")).toBe("科技主題");
  });
});

describe("證交所（2026/10/15 實際資料）", () => {
  it("行情", () => {
    const r = parseTwseQuotes(fx("twse_quotes.json"))!;
    expect(r.date).toBe("20261015");
    const tsmc = r.quotes.find((q) => q.code === "2330")!;
    expect(tsmc).toMatchObject({ name: "台積電", close: 2440, change: -50, open: 2420, high: 2450, low: 2420, volume: 58486711, market: "TWSE" });
    const etf = r.quotes.find((q) => q.code === "0050")!;
    expect(etf.name).toBe("元大台灣50");
    expect(etf.close).toBeGreaterThan(0);
    expect(r.quotes.find((q) => q.code === "00632R")).toBeDefined();
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
    expect(r.quotes.every((x) => isTradable(x.code))).toBe(true);
    expect(r.quotes.find((x) => x.code === "020025")).toBeUndefined(); // ETN 不列入
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
    // 實收資本額（權值強化估市值用）：有就讀，沒有就留空
    expect(parseTwseCompanies([{ 公司代號: "2330", 公司簡稱: "台積電", 產業別: "24", 實收資本額: "259325245210" }])[0].capital).toBe(259325245210);
    expect(parseTpexCompanies([{ SecuritiesCompanyCode: "6488", CompanyAbbreviation: "環球晶", SecuritiesIndustryCode: "24", "Paidin.Capital.NTDollars": "4781466950" }])[0].capital).toBe(4781466950);
    expect(parseTwseCompanies(fx("twse_companies.json"))[0].capital).toBeUndefined();
  });
});

describe("興櫃報價", () => {
  it("解析櫃買 openapi 興櫃最新統計", async () => {
    const { parseEsbLatest } = await import("../src/data/tw");
    const { readFileSync } = await import("node:fs");
    const rows = JSON.parse(readFileSync(new URL("./fixtures/tpex_esb.json", import.meta.url), "utf8"));
    const q = parseEsbLatest(rows);
    const b = q.find((x) => x.code === "7861")!;
    expect(b).toEqual({ code: "7861", name: "貝爾威勒", close: 992, date: "20261016" });
    expect(q.length).toBeGreaterThan(15);
    expect(q.every((x) => x.close > 0)).toBe(true);
  });
  it("沒有成交價時用均價", async () => {
    const { parseEsbLatest } = await import("../src/data/tw");
    expect(parseEsbLatest([{ SecuritiesCompanyCode: "1234", CompanyName: "測試", LatestPrice: "", Average: "12.5", Date: "1151016" }])[0].close).toBe(12.5);
    expect(parseEsbLatest([{ SecuritiesCompanyCode: "1234", LatestPrice: "", Average: "", PreviousAveragePrice: "" }])).toEqual([]);
    expect(parseEsbLatest(null)).toEqual([]);
  });
});
