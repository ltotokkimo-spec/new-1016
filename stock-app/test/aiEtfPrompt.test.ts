import { describe, expect, it } from "vitest";
import { aiEtfPrompt } from "../src/ai/claude";

describe("aiEtfPrompt", () => {
  const input = { today: "2026/10/17", budget: 100000, cash: 5000, nav: 98000, holdings: [{ code: "6515", name: "穎崴", shares: 20, avgCost: 5127.3, price: 5160, stop: 4614.6, rating: "離場" }], candidates: [] };
  it("Claude App 版和付費版的數據、規則完全相同，只多一段說明", () => {
    const api = aiEtfPrompt(input), app = aiEtfPrompt(input, true);
    expect(app.startsWith(api)).toBe(true);
    expect(app).toMatch(/MCP/);
    expect(api).toMatch(/\| 6515 \| 穎崴 \| 20 \| 5127\.3 \| 5160\(.*\) \| 4614\.6 \| 離場 \|/);
    expect(api).toMatch(/\| 代號 \| 名稱 \| 股數 \| 成本 \| 現價\(損益\) \| 停損 \| App評等 \|/);
    expect(api).toMatch(/請檢視這個組合/);
  });
});

describe("aiEtfPrompt 下單日", () => {
  it("有資料日時告訴 Claude 收盤日與下單日", () => {
    const p = aiEtfPrompt({ today: "2026/10/18", budget: 100000, cash: 100000, nav: 100000, holdings: [], candidates: [], dataDate: "10/16（五）", orderDate: "10/19（一）" });
    expect(p).toMatch(/10\/16（五） 收盤後的資料；我會在 10\/19（一） 盤中用限價單下單/);
  });
});

describe("aiEtfPrompt 精簡版", () => {
  const mk = (code: string, sector: string, score: number) => ({ code, name: `股${code}`, sector, close: 100, score, rating: "買入", ret1w: 0.01, ret1m: 0.05, foreign5: 1500000 } as any);
  it("候選股一行一檔、只有必要欄位；要求簡短回答", () => {
    const p = aiEtfPrompt({ today: "2026/10/21", budget: 500000, cash: 400000, nav: 497000, holdings: [], candidates: [mk("2006", "鋼鐵", 83)] });
    expect(p).toContain("| 代號 | 名稱 | 產業 | 收盤 | 分數 | 週 | 月 | 外資5日 |");
    expect(p).toContain("| 2006 | 股2006 | 鋼鐵 | 100 | 83 | +1.0% | +5.0% | +1,500張 |");
    expect(p).toMatch(/Markdown 表格，每檔一行，只放這 5 欄/);
    expect(p).toMatch(/理由：每檔一行條列/);
    expect(p).not.toMatch(/買入｜|近1週|近1月/);
    expect(p).toMatch(/不超過 400 字/);
    expect(p.length).toBeLessThan(1250);
  });
  it("候選股標題寫明成交金額門檻；沒有門檻就不寫", () => {
    const base = { today: "2026/10/22", budget: 500000, cash: 400000, nav: 497000, holdings: [], candidates: [] };
    expect(aiEtfPrompt({ ...base, minValue: 3.4e8 })).toContain("只留當日成交金額 ≥ 3.4 億的大型股");
    expect(aiEtfPrompt(base)).not.toContain("成交金額 ≥");
  });
});
