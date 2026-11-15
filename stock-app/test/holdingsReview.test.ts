import { describe, expect, it } from "vitest";
import { claudeAppUrl, holdingsReviewPrompt } from "../src/ai/claude";

describe("持股分頁「用 Claude Pro 解析持股」的提問（11/15）", () => {
  const rows = [
    { code: "1476", name: "儒鴻", market: "TW" as const, shares: 240, cost: 340, price: 386.5, pnlPct: 0.137, chg: 0.012, scored: { rating: "買入", score: 74, ret1m: 0.05, foreign5: 120000, sector: "紡織纖維" } as any },
    { code: "2610", name: "華航", market: "TW" as const, shares: 1000, cost: 22.1, price: NaN, pnlPct: NaN },
    { code: "AAPL", name: "Apple", market: "US" as const, shares: 5, cost: 190, price: 210, pnlPct: 210 / 190 - 1, scored: { rating: "觀望", score: 55, ret1m: -0.02, foreign5: undefined, sector: "Technology" } as any },
  ];
  const p = holdingsReviewPrompt(rows, "20261115", "口袋證券");
  it("帶日期、分頁名稱與每一檔的數字（股數、成本、現價、損益、評等、外資）", () => {
    expect(p).toContain("今天是 2026/11/15");
    expect(p).toContain("「口袋證券」的全部持股");
    expect(p).toContain("| 1476 | 儒鴻 | 台股 | 240 | 340 | 386.5 | +13.7% | +1.2% | +5.0% | 買入/74 | +120張 | 紡織纖維 |");
    expect(p).toContain("| 2610 | 華航 | 台股 | 1000 | 22.1 | — | — | — | — | 無評分 | — | — |"); // 沒有價格與評分：寫「—」，不要寫 NaN
    expect(p).toContain("| AAPL | Apple | 美股 | 5 | 190 | 210 | +10.5% | — | -2.0% | 觀望/55 | — | Technology |"); // 美股沒有外資
    expect(p).not.toMatch(/NaN|undefined/);
  });
  it("要求逐檔給續抱／減碼／加碼／停損，並說明之後會在 Claude 繼續追問", () => {
    expect(p).toMatch(/續抱／減碼／加碼／停損/);
    expect(p).toMatch(/繼續追問/);
    expect(p).toMatch(/非投資建議/);
  });
  it("網址太長時只開新對話（靠剪貼簿貼上），短的就直接帶入", () => {
    expect(claudeAppUrl(p)).toMatch(/^https:\/\/claude\.ai\/new/);
    const many = holdingsReviewPrompt(Array.from({ length: 30 }, (_, i) => ({ ...rows[0], code: String(2000 + i) })), "20261115", "合併");
    expect(claudeAppUrl(many)).toBe("https://claude.ai/new");
  });
});
