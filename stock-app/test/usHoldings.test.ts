import { describe, expect, it } from "vitest";
import fs from "node:fs";

const aapl = JSON.parse(fs.readFileSync("test/fixtures/nasdaq_AAPL.json", "utf8"));
// 剛上市的 ETF：只有 30 天的日K
const short = { ...aapl, data: { ...aapl.data, tradesTable: { ...aapl.data.tradesTable, rows: aapl.data.tradesTable.rows.slice(0, 30) } } };

describe("持股裡清單外的美股（照片匯入）", () => {
  it("存檔後自動下載：一般股票評分、新 ETF 只算損益、查不到的標示出來", async () => {
    const store = await import("../src/store");
    const { memoryKV } = await import("../src/lib/kv");
    const fetcher = async (url: string) => {
      if (url.includes("/ZZZZ/")) return { data: null, status: { rCode: 400 } };
      if (url.includes("/DRAM/historical") && url.includes("assetclass=stocks")) return { data: null };
      if (url.includes("/DRAM/historical")) return short;
      if (url.includes("/historical")) return aapl;
      if (url.includes("/AXTI/info")) return { data: { companyName: "AXT Inc Common Stock" } };
      if (url.includes("/AXTI/summary")) return { data: { summaryData: { Sector: { value: "Technology" } } } };
      if (url.includes("/info") || url.includes("/summary")) return { data: null };
      throw new Error("offline " + url);
    };
    store._inject(memoryKV(), fetcher);
    // 先有今天的美股資料（模擬開 App 時已下載過）
    await store.refreshUs();
    expect(store.getState().us.scored.length).toBeGreaterThan(40);

    const h = (code: string, name: string) => ({ id: code, code, name, market: "US" as const, shares: 100, cost: 10 });
    await store.saveHoldings([h("AXTI", "AXT"), h("DRAM", "Roundhill記憶體ETF"), h("ZZZZ", "不存在")]);
    await store.ensureUsHoldings(); // 等背景下載完
    await new Promise((r) => setTimeout(r, 0));

    const views = store.holdingViews();
    const v = (c: string) => views.find((x) => x.code === c)!;
    expect(v("AXTI").scored?.code).toBe("AXTI");
    expect(["買入", "觀望", "離場"]).toContain(v("AXTI").rating);
    expect(v("AXTI").name).toBe("AXT"); // 照片辨識的名稱保留
    expect(Number.isFinite(v("DRAM").price)).toBe(true);
    expect(v("DRAM").advice.join()).toMatch(/上市時間短/);
    expect(v("ZZZZ").advice.join()).toMatch(/查不到/);
    expect(store.getState().usPending).toEqual([]);
  });
});
