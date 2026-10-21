import { describe, expect, it } from "vitest";
import { UsLoader } from "../src/data/usLoader";
import { memoryKV } from "../src/lib/kv";
import { usLatestSession, usNeedsRefresh } from "../src/lib/dates";

// Nasdaq 歷史 K：最後一天可指定
const hist = (lastDay: string) => ({ data: { tradesTable: { rows: [
  { date: "10/16/2026", open: "$10", high: "$11", low: "$9", close: "$10.00", volume: "1,000,000" },
  { date: lastDay, open: "$10", high: "$11", low: "$9", close: "$10.50", volume: "1,000,000" },
] } } });
const cnbc = (sym: string, last: string, date: string, status = "POST_MKT") => ({ FormattedQuoteResult: { FormattedQuote: [{
  symbol: sym, code: 0, name: sym, last, last_time: `${date}T16:00:00.000-0400`, change: "+0.30", open: "10.6", high: "11.2", low: "10.4",
  previous_day_closing: "10.50", curmktstatus: status, volume: "2,000,000",
}] } });
// 2026/10/20 18:10（紐約，已收盤，Nasdaq 還沒補上 10/20）
const NOW = Date.parse("2026-10-20T22:10:00Z");

describe("美股收盤後 Nasdaq 日K 晚更新（使用者回報：收盤後美股沒更新）", () => {
  it("最近交易日：紐約 17:00 後算當天，週末往前找平日", () => {
    expect(usLatestSession(NOW)).toBe("20261020");
    expect(usLatestSession(Date.parse("2026-10-25T15:00:00Z"))).toBe("20261023"); // 週日
  });

  it("舊資料不存成今天的快取：30 分鐘後重抓", async () => {
    let n = 0, t = NOW;
    const l = new UsLoader(async () => { n++; return hist("10/19/2026"); }, memoryKV(), () => t);
    await l.history("SPY", true);
    await l.history("SPY", true);
    expect(n).toBe(1); // 30 分鐘內用暫存
    t += 31 * 60_000;
    await l.history("SPY", true);
    expect(n).toBe(2); // 過 30 分鐘重抓
  });

  it("Nasdaq 已有最新一天就正常存一整天", async () => {
    let n = 0, t = NOW;
    const l = new UsLoader(async () => { n++; return hist("10/20/2026"); }, memoryKV(), () => t);
    await l.history("SPY", true); t += 5 * 3600_000; await l.history("SPY", true);
    expect(n).toBe(1);
  });

  it("收盤後用 CNBC 正式收盤補上當天 K 棒（含成交量）", async () => {
    const l = new UsLoader(async () => cnbc("SPY", "10.80", "2026-10-20"), memoryKV(), () => NOW);
    const bars: any = { SPY: hist("10/19/2026").data.tradesTable.rows.map((r) => ({ date: r.date === "10/16/2026" ? "20261016" : "20261019", open: 10, high: 11, low: 9, close: r.close === "$10.00" ? 10 : 10.5, volume: 1e6 })) };
    await l.patchLatest(bars);
    const last = bars.SPY[bars.SPY.length - 1];
    expect(last).toEqual({ date: "20261020", open: 10.6, high: 11.2, low: 10.4, close: 10.8, volume: 2e6 });
  });

  it("盤中（還沒收盤）不補", async () => {
    const l = new UsLoader(async () => cnbc("SPY", "10.80", "2026-10-20", "REG_MKT"), memoryKV(), () => NOW);
    const bars: any = { SPY: [{ date: "20261019", open: 10, high: 11, low: 9, close: 10.5, volume: 1e6 }] };
    await l.patchLatest(bars);
    expect(bars.SPY).toHaveLength(1);
  });

  it("自動重抓：資料日落後且 30 分鐘沒試過才重抓", () => {
    const fetched = NOW - 10 * 60_000; // 同一個資料日、10 分鐘前抓過
    expect(usNeedsRefresh(fetched, NOW, "20261019")).toBe(false);
    expect(usNeedsRefresh(NOW - 40 * 60_000, NOW, "20261019")).toBe(true);
    expect(usNeedsRefresh(NOW - 40 * 60_000, NOW, "20261020")).toBe(false); // 已是最新
  });
});
