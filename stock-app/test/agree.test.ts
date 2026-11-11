import { describe, expect, it } from "vitest";
import { agreePlans, normConf, parsePlan, type PlanItem } from "../src/engine/aiEtf";
import { aiEtfPrompt } from "../src/ai/claude";

const it_ = (code: string, side: "buy" | "sell", shares: number, conf?: "高" | "中" | "低"): PlanItem => ({ code, side, shares, reason: "", conf });

describe("多份回覆比對：只執行重複出現、信心不是低的交易", () => {
  it("只有 1 份回覆：全部先不執行，等再問一次", () => {
    const a = agreePlans([[it_("2330", "buy", 10, "高")]], [it_("2330", "buy", 10, "高")]);
    expect(a.n).toBe(1);
    expect(a.go).toEqual([]);
    expect(a.once.map((x) => x.code)).toEqual(["2330"]);
  });
  it("3 份中 2 份都買 2330 → 執行，股數取最少；只出現 1 次的 2317 等確認；信心低的 2454 不做", () => {
    const p1 = [it_("2330", "buy", 10, "高"), it_("2317", "buy", 100, "中"), it_("2454", "buy", 5, "低")];
    const p2 = [it_("2330", "buy", 8, "中"), it_("2454", "buy", 5, "高")];
    const p3 = [it_("2603", "sell", 60, "高")];
    const a = agreePlans([p1, p2, p3], p1);
    expect(a.go.map((x) => [x.code, x.shares, x.conf])).toEqual([["2330", 8, "中"]]);
    expect(a.once.map((x) => x.code).sort()).toEqual(["2317", "2603"]);
    expect(a.low.map((x) => x.code)).toEqual(["2454"]); // 兩份都有，但有一份信心低 → 取最低
  });
  it("同代號但方向不同不算重複", () => {
    const a = agreePlans([[it_("2330", "buy", 10)], [it_("2330", "sell", 10)]], [it_("2330", "buy", 10)]);
    expect(a.go).toEqual([]);
  });
});

describe("信心欄位與換股門檻提示", () => {
  it("JSON 的 conf 讀成 高／中／低（也接受英文）", () => {
    expect(normConf("High")).toBe("高");
    expect(normConf("中")).toBe("中");
    expect(normConf("xx")).toBeUndefined();
    const p = parsePlan('```json\n{"trades":[{"code":"2330","side":"buy","shares":10,"conf":"低","reason":"x"}]}\n```');
    expect(p.items[0].conf).toBe("低");
  });
  it("檢視時提示寫明：除非跌破停損或候選股分數高 10 分以上，否則維持不變；並要求標信心", () => {
    const t = aiEtfPrompt({ today: "2026/11/12", budget: 1e5, cash: 5e4, nav: 1e5, holdings: [{ code: "2330", name: "台積電", shares: 10, avgCost: 2000, price: 2100, stop: 1900, rating: "觀望", score: 55 }], candidates: [] });
    expect(t).toContain("高 10 分以上");
    expect(t).toContain("維持不變");
    expect(t).toContain("conf");
    expect(t).toContain("| 55 |");
  });
});
