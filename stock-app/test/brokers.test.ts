import { describe, expect, it } from "vitest";
import { brokerOf, mergeHoldings, type Holding } from "../src/engine/score";

describe("口袋／元大持股（11/10）", () => {
  it("舊資料沒有券商欄位＝口袋", () => {
    expect(brokerOf({})).toBe("pocket");
    expect(brokerOf({ broker: "yuanta" })).toBe("yuanta");
  });
  it("統計合併：同一檔兩家的股數相加、成本加權平均，記下來源；不同檔不合併", () => {
    const hs: Holding[] = [
      { id: "1", code: "2330", name: "台積電", market: "TWSE", shares: 100, cost: 1000 },
      { id: "2", code: "2330", name: "台積電", market: "TWSE", shares: 300, cost: 1200, broker: "yuanta" },
      { id: "3", code: "2317", name: "鴻海", market: "TWSE", shares: 1000, cost: 200, broker: "yuanta" },
    ];
    const m = mergeHoldings(hs);
    expect(m).toHaveLength(2);
    const t = m.find((x) => x.code === "2330")!;
    expect(t.shares).toBe(400);
    expect(t.cost).toBeCloseTo((100 * 1000 + 300 * 1200) / 400, 9);
    expect(t.brokers).toEqual(["pocket", "yuanta"]);
    expect(m.find((x) => x.code === "2317")!.brokers).toEqual(["yuanta"]);
  });
});
