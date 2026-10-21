import { describe, expect, it } from "vitest";
import { aiEtfPrompt } from "../src/ai/claude";

describe("aiEtfPrompt", () => {
  const input = { today: "2026/10/17", budget: 100000, cash: 5000, nav: 98000, holdings: [{ code: "6515", name: "穎崴", shares: 20, avgCost: 5127.3, price: 5160, stop: 4614.6, rating: "離場" }], candidates: [] };
  it("Claude App 版和付費版的數據、規則完全相同，只多一段說明", () => {
    const api = aiEtfPrompt(input), app = aiEtfPrompt(input, true);
    expect(app.startsWith(api)).toBe(true);
    expect(app).toMatch(/MCP/);
    expect(api).toMatch(/穎崴：20 股，平均成本 5127.30，現價 5160.*停損價 4614.6，App 評等 離場/);
    expect(api).toMatch(/請檢視這個組合/);
  });
});

describe("aiEtfPrompt 下單日", () => {
  it("有資料日時告訴 Claude 收盤日與下單日", () => {
    const p = aiEtfPrompt({ today: "2026/10/18", budget: 100000, cash: 100000, nav: 100000, holdings: [], candidates: [], dataDate: "10/16（五）", orderDate: "10/19（一）" });
    expect(p).toMatch(/10\/16（五） 收盤後的資料；我會在 10\/19（一） 盤中用限價單下單/);
  });
});
