import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { TwLoader, buildTwInputs } from "../src/data/twLoader";
import { memoryKV } from "../src/lib/kv";

const fx = (n: string) => JSON.parse(fs.readFileSync(`test/fixtures/${n}`, "utf8"));
const NO_DATA = { stat: "很抱歉，沒有符合條件的資料!" };
const HOLIDAYS = new Set(["20261009"]);

// 用實際回應當作每一天的資料；休市日回傳交易所真正的「無資料」格式
function fakeFetch(log: string[]) {
  return async (url: string) => {
    log.push(url);
    const d = /date=(\d{8})/.exec(url)?.[1] ?? (/date=(\d{4})%2F(\d{2})%2F(\d{2})/.exec(url)?.slice(1).join("") ?? "");
    const holiday = HOLIDAYS.has(d) || d > "20261016";
    if (url.includes("/fund/T86")) return holiday ? NO_DATA : fx("twse_t86.json");
    if (url.includes("MI_INDEX")) return holiday ? NO_DATA : fx("twse_quotes.json");
    if (url.includes("dailyQuotes")) return holiday ? { tables: [{ fields: [], data: [] }] } : fx("tpex_quotes.json");
    if (url.includes("insti/dailyTrade")) return holiday ? { tables: [] } : fx("tpex_insti.json");
    if (url.includes("t187ap03_L")) return fx("twse_companies.json");
    if (url.includes("t187ap03_O")) return fx("tpex_companies.json");
    throw new Error("unexpected " + url);
  };
}

// 2026/10/16 (五) 台北時間晚上 8 點
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

describe("TwLoader", () => {
  it("跳過休市日、取 10 個交易日、第二次只用快取", async () => {
    const log: string[] = [];
    const kv = memoryKV();
    const loader = new TwLoader(fakeFetch(log), kv, () => NOW);
    const snap = await loader.load();
    expect(snap.asOf).toBe("20261016");
    expect(snap.dates).toHaveLength(10);
    expect(snap.dates).not.toContain("20261009");
    expect(snap.ref.w1).toBe(snap.dates[5]);
    expect(snap.ref.m1 <= "20260918").toBe(true);
    const tsmc = snap.stocks.find((s) => s.code === "2330")!;
    expect(tsmc).toMatchObject({ market: "TWSE", sector: "半導體", close: 2440 });
    expect(snap.stocks.find((s) => s.code === "6488")!.market).toBe("TPEX");
    // 每天都用同一份法人資料 → 5 日 = 5 倍
    expect(tsmc.foreign5).toBe(-34111365 * 5);
    expect(tsmc.foreignStreak).toBe(-10);
    expect(snap.indices.find((i) => i.name === "發行量加權股價指數")!.close).toBe(46969.87);

    const first = log.length;
    const again = new TwLoader(fakeFetch(log), kv, () => NOW);
    await again.load();
    expect(log.length).toBe(first); // 全部來自快取
  });

  it("今天下午還沒公布時，不把今天記成休市", async () => {
    const log: string[] = [];
    const kv = memoryKV();
    const early = Date.UTC(2026, 9, 19, 4, 0, 0); // 10/19（一）中午 12 點
    const fetch = fakeFetch(log); // 10/19 > 10/16 → 回無資料
    const snap = await new TwLoader(fetch, kv, () => early).load();
    expect(snap.asOf).toBe("20261016");
    expect(await kv.get("tw:f:twse:20261019")).toBeUndefined();
  });
});

describe("buildTwInputs", () => {
  it("報酬、外資 5/10 日與連買天數", () => {
    const row = (close: number): any => ["2330", "台積電", close, 0, 1e10, 1e6];
    const flow = (f: number): any => [["2330", f, 1000, 0]];
    const r = buildTwInputs({
      latest: [row(110)], week: [row(100)], month: [row(88)], quarter: [row(55)],
      flows: [flow(5), flow(4), flow(3), flow(-1), flow(2), flow(100), flow(0), flow(0), flow(0), flow(0)],
      companies: [{ code: "2330", name: "台積電", industry: "半導體" }],
      tpexCodes: new Set(),
    })[0];
    expect(r.ret1w).toBeCloseTo(0.1);
    expect(r.ret1m).toBeCloseTo(0.25);
    expect(r.ret3m).toBeCloseTo(1);
    expect(r.foreign5).toBe(13);
    expect(r.foreign10).toBe(113);
    expect(r.foreignStreak).toBe(3);
    expect(r.trust5).toBe(5000);
  });
});
