import { describe, expect, it } from "vitest";
import { cnnFngUrl, parseCnnFng } from "../src/data/fng";

// CNN Business 恐懼貪婪指數回應的格式（欄位名稱照官方，數字是示意）
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);
const sample = {
  fear_and_greed: { score: 39.4, rating: "fear", timestamp: "2026-11-16T15:30:00+00:00", previous_close: 41.2, previous_1_week: 52.6, previous_1_month: 61.1, previous_1_year: 48.9 },
  fear_and_greed_historical: { data: [
    { x: day("2026-11-11"), y: 55.2, rating: "neutral" },
    { x: day("2026-11-12"), y: 44.1, rating: "fear" },
    { x: day("2026-11-13"), y: 41.2, rating: "fear" },
    { x: day("2026-11-13") + 3600_000, y: 41.0, rating: "fear" }, // 同一天兩筆：取最後一筆
  ] },
  market_momentum_sp500: { score: 30.5, rating: "fear" },
  market_volatility_vix: { score: 12, rating: "extreme fear" },
  junk_bond_demand: { score: 70, rating: "greed" },
};

describe("美股恐懼貪婪指數（CNN）解析（11/16）", () => {
  it("分數四捨五入、分級中文化、前一交易日／一週／一個月／一年前", () => {
    const f = parseCnnFng(sample)!;
    expect(f).toMatchObject({ value: 39, label: "恐懼", date: "20261116", prev: 41, weekAgo: 53, monthAgo: 61, yearAgo: 49 });
  });
  it("歷史：同一天只留一筆、由舊到新、今天用最新分數；連續天數只算同一分級", () => {
    const f = parseCnnFng(sample)!;
    expect(f.hist).toEqual([{ date: "20261111", value: 55 }, { date: "20261112", value: 44 }, { date: "20261113", value: 41 }, { date: "20261116", value: 39 }]);
    expect(f.streak).toBe(3);
    expect(f.high).toEqual({ value: 55, date: "20261111" });
    expect(f.low).toEqual({ value: 39, date: "20261116" });
  });
  it("成分指標：只列有分數的，照固定順序、分級中文化", () => {
    const f = parseCnnFng(sample)!;
    expect(f.parts!.map((p) => [p.key, p.score, p.rating])).toEqual([["market_momentum_sp500", 31, "恐懼"], ["market_volatility_vix", 12, "極度恐懼"], ["junk_bond_demand", 70, "貪婪"]]);
  });
  it("格式不對回傳 undefined；網址帶一年前的日期", () => {
    expect(parseCnnFng({})).toBeUndefined();
    expect(cnnFngUrl(Date.parse("2026-11-16T00:00:00Z"))).toBe("https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2025-11-11");
  });
});
