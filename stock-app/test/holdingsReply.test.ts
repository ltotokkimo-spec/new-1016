import { describe, expect, it } from "vitest";
import { holdingsAppPrompt, parseHoldingsReply } from "../src/ai/claude";

describe("Claude App 截圖匯入（免費）", () => {
  it("提問要求只回 JSON，張數換成股", () => {
    const t = holdingsAppPrompt("元大");
    expect(t).toContain("元大證券");
    expect(t).toContain("1 張 = 1000 股");
    expect(t).toContain('"holdings"');
  });
  it("讀出回覆裡的 JSON：股數、成本、市場；張數會換成股；美股代號判斷為 US", () => {
    const r = parseHoldingsReply('結果如下\n```json\n{"holdings":[{"code":"2330","name":"台積電","market":"TW","shares":1000,"cost":580.5},{"code":"0050","name":"元大台灣50","lots":2,"cost":100},{"code":"aapl","name":"Apple","shares":10,"cost":200}],"note":"有一檔看不清楚"}\n```')!;
    expect(r.holdings.map((h) => [h.code, h.market, h.shares, h.cost])).toEqual([["2330", "TW", 1000, 580.5], ["0050", "TW", 2000, 100], ["AAPL", "US", 10, 200]]);
    expect(r.note).toBe("有一檔看不清楚");
  });
  it("複製時被截斷也盡量讀出前面完整的；沒有 JSON 回傳 null", () => {
    const r = parseHoldingsReply('```json\n{"holdings":[{"code":"2317","name":"鴻海","market":"TW","shares":3000,"cost":198.5},{"code":"26');
    expect(r?.holdings[0]).toMatchObject({ code: "2317", shares: 3000, cost: 198.5 });
    expect(parseHoldingsReply("我看不到截圖")).toBeNull();
  });
});
