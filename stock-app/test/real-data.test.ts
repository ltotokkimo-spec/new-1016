// 用整套真實資料跑一次完整流程（設定 FIXTURE_DIR 才會執行），印出結果供人工檢查
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { TwLoader } from "../src/data/twLoader";
import { memoryKV } from "../src/lib/kv";
import { scoreStocks } from "../src/engine/score";

const dir = process.env.FIXTURE_DIR;
describe.skipIf(!dir)("整套真實資料", () => {
  it("台股全市場評分", async () => {
    const read = (n: string) => JSON.parse(fs.readFileSync(path.join(dir!, n), "utf8"));
    const has = (n: string) => fs.existsSync(path.join(dir!, n));
    const fetch = async (url: string) => {
      const u = new URL(url);
      const d8 = (u.searchParams.get("date") ?? "").replace(/\//g, "");
      if (url.includes("/fund/T86")) return has(`t86_${d8}.json`) ? read(`t86_${d8}.json`) : read("nodata_twse.json");
      if (url.includes("MI_INDEX")) return has(`twseq_${d8}.json`) ? read(`twseq_${d8}.json`) : read("nodata_twse.json");
      if (url.includes("dailyQuotes")) return has(`tpexq_${d8}.json`) ? read(`tpexq_${d8}.json`) : read("nodata_tpex.json");
      if (url.includes("insti/dailyTrade")) return has(`tpexf_${d8}.json`) ? read(`tpexf_${d8}.json`) : read("nodata_tpex.json");
      if (url.includes("t187ap03_L")) return read("companies_twse.json");
      if (url.includes("t187ap03_O")) return read("companies_tpex.json");
      throw new Error(url);
    };
    const now = Date.UTC(2026, 9, 16, 11, 0, 0);
    const snap = await new TwLoader(fetch, memoryKV(), () => now).load();
    const { scored, sectors } = scoreStocks(snap.stocks);
    console.log("asOf", snap.asOf, "ref", snap.ref, "stocks", snap.stocks.length, "scored", scored.length);
    const cnt = { 買入: 0, 觀望: 0, 離場: 0 } as Record<string, number>;
    scored.forEach((s) => cnt[s.rating]++);
    console.log("ratings", cnt);
    console.log("top10", scored.slice(0, 10).map((s) => `${s.code}${s.name} ${s.score} ${s.rating} 1w${(s.ret1w * 100).toFixed(1)} 1m${(s.ret1m * 100).toFixed(1)} 外資5日${Math.round(s.foreign5! / 1000)}張 streak${s.foreignStreak}`).join("\n"));
    console.log("bottom5", scored.slice(-5).map((s) => `${s.code}${s.name} ${s.score} ${s.rating}`).join(" | "));
    console.log("sectors", sectors.map((s) => `${s.sector}(${s.count}) ${s.rotation} 1w${(s.ret1w * 100).toFixed(1)} 1m${(s.ret1m * 100).toFixed(1)} 外資${(s.foreignValue5 / 1e8).toFixed(0)}億`).join("\n"));
    const tsmc = scored.find((s) => s.code === "2330")!;
    console.log("2330", JSON.stringify({ ...tsmc, reasons: tsmc.reasons }));
    expect(snap.dates).not.toContain("20261009");
    expect(scored.length).toBeGreaterThan(500);
    expect(snap.stocks.filter((s) => Number.isNaN(s.ret1m)).length).toBeLessThan(snap.stocks.length * 0.05);
  });
});
