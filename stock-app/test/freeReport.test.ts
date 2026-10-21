import { describe, expect, it } from "vitest";
import { freeReport } from "../src/engine/freeReport";
import { parseRevenue } from "../src/data/revenue";

const bars = Array.from({ length: 130 }, (_, i) => ({ date: `2026${String(4 + Math.floor(i / 22)).padStart(2, "0")}${String(1 + (i % 22)).padStart(2, "0")}`, close: 100 + i * 0.5, volume: 1000 + (i > 124 ? 2000 : 0), high: 101 + i * 0.5, low: 99 + i * 0.5 }));
const base: any = {
  code: "2330", name: "台積電", market: "TWSE", sector: "半導體", close: 164.5, value: 5e10,
  ret1w: 0.015, ret1m: 0.07, ret3m: 0.25, foreign5: 3_000_000, foreign10: 8_000_000, foreignStreak: 3, trust5: 200_000,
  score: 78, momentum: 0.85, flow: 0.7, sectorScore: 0.65, rating: "買入", foreignRatio5: 0.04,
  reasons: ["近1週 +1.5%", "外資近5日 +3,000 張", "半導體族群：轉強（近1週族群排名第 3/24）"],
};

describe("免費解析", () => {
  it("用資料寫出結論、技術面、籌碼、族群、營收與停損", () => {
    const t = freeReport({ s: base, bars, today: "20261017", holding: { id: "1", code: "2330", name: "台積電", market: "TWSE", shares: 1000, cost: 150 },
      revenue: { code: "2330", ym: "202609", revenue: 330_000_000, mom: 0.05, yoy: 0.32, cumYoy: 0.38 } });
    expect(t.split("\n")[0]).toBe("評等：買入");
    expect(t).toMatch(/78\/100/);
    expect(t).toMatch(/多頭排列/);
    expect(t).toMatch(/外資近5日 \+3,000 張、近10日 \+8,000 張，連續買超 3 天/);
    expect(t).toMatch(/半導體族群：轉強/);
    expect(t).toMatch(/當月營收 3300\.00 億元.*年增 \+32\.0%/);
    expect(t).toMatch(/營收高成長/);
    expect(t).toMatch(/量能明顯放大/);
    expect(t).toMatch(/停損價 135\.0/);
    expect(t).toMatch(/不含新聞/);
  });

  it("ETF 只當參考；美股沒有籌碼段落；日K不足時不會壞掉", () => {
    const etf = freeReport({ s: { ...base, code: "0050", refOnly: true, rating: "離場" }, bars, today: "20261017" });
    expect(etf.split("\n")[0]).toBe("評等：參考");
    expect(etf).not.toMatch(/規則評為/);
    const usT = freeReport({ s: { ...base, code: "AAOI", market: "US", aboveMa50: false, rating: "離場", foreign5: undefined }, bars: [], today: "20261017" });
    expect(usT).not.toMatch(/法人籌碼/);
    expect(usT).toMatch(/日K資料不足/);
    expect(usT).toMatch(/規則評為「離場」/);
  });
});

describe("每月營收", () => {
  it("證交所格式（中文欄位、民國年月、千元）", () => {
    const r = parseRevenue([{ "出表日期": "1151012", "資料年月": "11509", "公司代號": "2330", "公司名稱": "台積電", "營業收入-當月營收": "330000000", "營業收入-上月比較增減(%)": "5.12", "營業收入-去年同月增減(%)": "-3.5", "累計營業收入-前期比較增減(%)": "38.1" }]);
    expect(r[0]).toEqual({ code: "2330", ym: "202609", revenue: 330000000, mom: 0.0512, yoy: -0.035, cumYoy: 0.381 });
  });
  it("英文欄位與壞資料", () => {
    expect(parseRevenue([{ CompanyCode: "6488", DataYearMonth: "202609", MonthlyRevenue: "1,000", "YoY": "10" }])[0]).toMatchObject({ code: "6488", ym: "202609", revenue: 1000, yoy: 0.1 });
    expect(parseRevenue(null)).toEqual([]);
    expect(parseRevenue([{ foo: 1 }])).toEqual([]);
  });
});

describe("免費解析：日K對不上", () => {
  it("最後收盤和現價差超過 25% 時不算技術指標", () => {
    const t = freeReport({ s: { ...base, close: 59.8 }, bars, today: "20261017" });
    expect(t).toMatch(/日K資料不足/);
    expect(t).not.toMatch(/均線：/);
  });
});

describe("交給 Claude App 的提問", () => {
  it("帶著 App 數據、要求用 MCP 與搜尋，網址可帶入", async () => {
    const { claudeAppPrompt, claudeAppUrl } = await import("../src/ai/claude");
    const p = claudeAppPrompt(base, "2026-10-17", { id: "1", code: "2330", name: "台積電", market: "TWSE", shares: 1000, cost: 150 });
    expect(p).toMatch(/台積電（2330/);
    expect(p).toMatch(/MCP/);
    expect(p).toMatch(/我持有 1000 股，平均成本 150/);
    expect(p).toMatch(/評等（買入／觀望／離場/);
    const etf = claudeAppPrompt({ ...base, code: "0050", refOnly: true }, "2026-10-17");
    expect(etf).toMatch(/不要給買入／離場評等/);
    expect(decodeURIComponent(claudeAppUrl(p).split("?q=")[1])).toBe(p);
  });
});
