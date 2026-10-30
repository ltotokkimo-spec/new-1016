import { describe, expect, it } from "vitest";
import { twHistory } from "../src/data/history";

const now = Date.UTC(2026, 9, 30, 2, 0, 0); // 台北 10/30 10:00
// 證交所個股月資料：欄位 日期、成交股數、成交金額、開、高、低、收、漲跌、筆數
const month = (ym: string, day: string) => ({ stat: "OK", fields: ["日期", "成交股數", "成交金額", "開盤價", "最高價", "最低價", "收盤價", "漲跌價差", "成交筆數"], data: [[`115/${ym.slice(4, 6)}/${day}`, "1,000,000", "50,000,000", "50.0", "51.0", "49.0", "50.5", "+0.5", "100"]] });
const mkKv = (init: Record<string, unknown> = {}) => { const m = new Map<string, unknown>(Object.entries(init)); return { m, get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, v); }, del: async () => {} } as any; };

describe("個股日 K 分段載入", () => {
  it("由最近的月份往回下載，每下載一個月就回報一次", async () => {
    const urls: string[] = [];
    const parts: number[] = [];
    const bars = await twHistory(async (u: string) => { urls.push(u); const ym = /date=(\d{6})/.exec(u)?.[1] ?? "202610"; return month(ym + "01", "02"); }, mkKv(), "2330", "TWSE", 3, now, (p) => parts.push(p.length));
    expect(urls.map((u) => /date=(\d{6})/.exec(u)![1])).toEqual(["202610", "202609", "202608"]);
    expect(parts).toEqual([1, 2, 3]);
    expect(bars.length).toBe(3);
    expect(bars.map((b) => b.date)).toEqual([...bars.map((b) => b.date)].sort());
  });
  it("手機裡已有的月份先全部馬上回報，只下載缺的", async () => {
    const kv = mkKv();
    await twHistory(async (u: string) => month((/date=(\d{6})/.exec(u)?.[1] ?? "202610") + "01", "02"), kv, "2330", "TWSE", 3, now); // 先存好三個月
    const parts: number[] = [];
    let calls = 0;
    const bars = await twHistory(async () => { calls++; return month("20261001", "05"); }, kv, "2330", "TWSE", 3, now, (p) => parts.push(p.length));
    expect(calls).toBe(0);
    expect(parts).toEqual([3]); // 一次就回報完整
    expect(bars.length).toBe(3);
  });
  it("更早的月份下載失敗：已經有的資料照樣回傳，不讓整張圖消失；全部失敗才丟錯", async () => {
    let n = 0;
    const ok = await twHistory(async (u: string) => { if (n++ >= 1) throw new Error("連線失敗"); return month((/date=(\d{6})/.exec(u)?.[1] ?? "202610") + "01", "02"); }, mkKv(), "2330", "TWSE", 3, now);
    expect(ok.length).toBe(1);
    await expect(twHistory(async () => { throw new Error("連線失敗"); }, mkKv(), "2330", "TWSE", 3, now)).rejects.toThrow("連線失敗");
  });
  it("背景預載不回報中間結果，結果存進快取，之後打開圖表馬上有", async () => {
    const kv = mkKv();
    const parts: number[] = [];
    await twHistory(async (u: string) => month((/date=(\d{6})/.exec(u)?.[1] ?? "202610") + "01", "02"), kv, "2330", "TWSE", 2, now, (p) => parts.push(p.length), true);
    expect(parts).toEqual([]);
    let calls = 0;
    const got: number[] = [];
    await twHistory(async () => { calls++; return month("20261001", "05"); }, kv, "2330", "TWSE", 2, now, (p) => got.push(p.length));
    expect(calls).toBe(0);
    expect(got).toEqual([2]);
  });
});
