import { describe, expect, it } from "vitest";
import { esbBars, esbHistUrl, esbHistory, parseEsbHist, parseEsbLive, parseEsbStamp } from "../src/data/esb";

// 櫃買中心 2026-10-30 09:28 的實際回應（貝爾威勒 7861、富味鄉 1260）
const live = {
  tables: [{
    date: "115年10月30日 09:28:03",
    fields: ["代號", "名稱", "前日均價", "報買價", "報買量", "報賣價", "報賣量", "日最高", "日最低", "日均價", "成交", "投資人成交買賣別", "暫停交易開始時間(時:分:秒)", "成交量"],
    data: [
      ["7861", "貝爾威勒", "805.54", 760, "3,000", 784, "1,950", "790.00", "715.00", "758.56", "784.00", "買進", "", "62,981"],
      ["1260", "富味鄉", "32.00", 31.4, "2,000", 32.95, "3,000", "31.80", "31.40", "31.54", "31.40", "賣出", "", "13,000"],
      ["9999", "還沒成交", "50.00", "49.5", "1,000", "50.5", "1,000", "0.00", "0.00", "0.00", "", "", "", "0"],
    ],
  }],
};
const hist = {
  stat: "ok",
  tables: [{
    data: [
      ["115/10/01", "90,257", "97,857,025", "1,135.00", "1,060.00", "1,084.20", "681", "0", "0", "0.00", "0.00", "0.00", "0"],
      ["115/10/02", "201,647", "211,180,670", "1,100.00", "1,010.00", "1,047.28", "868", "0", "0", "0.00", "0.00", "0.00", "0"],
      ["115/10/03", "0", "0", "0.00", "0.00", "0.00", "0", "0", "0", "0.00", "0.00", "0.00", "0"],
    ],
  }],
};

describe("興櫃 當日行情表 → 即時報價", () => {
  it("解析時間（民國年）", () => expect(parseEsbStamp("115年10月30日 09:28:03")).toEqual({ date: "20261030", time: "09:28:03" }));
  it("最後成交價、前日均價、高低、成交量（股）", () => {
    const q = parseEsbLive(live)["7861"];
    expect(q).toMatchObject({ code: "7861", name: "貝爾威勒", price: 784, prevClose: 805.54, high: 790, low: 715, date: "20261030", time: "09:28:03", final: false, volume: 62981 });
    expect(q.open).toBe(805.54); // 沒有開盤價，用前日均價
  });
  it("還沒成交：價格用前日均價、不產生 K 線的開盤價", () => {
    const q = parseEsbLive(live)["9999"];
    expect(q.price).toBe(50);
    expect(Number.isNaN(q.open)).toBe(true);
  });
  it("13:30 之後算收盤", () => {
    const q = parseEsbLive({ tables: [{ ...live.tables[0], date: "115年10月30日 13:31:00" }] })["7861"];
    expect(q.final).toBe(true);
  });
  it("壞資料不會當掉", () => { expect(parseEsbLive(null)).toEqual({}); expect(parseEsbLive({ tables: [] })).toEqual({}); });
});

describe("興櫃 個股歷史行情 → K 線", () => {
  it("日期換西元、沒成交的日子略過", () => {
    const d = parseEsbHist(hist);
    expect(d.map((x) => x.date)).toEqual(["20261001", "20261002"]);
    expect(d[0]).toMatchObject({ high: 1135, low: 1060, avg: 1084.2, volume: 90257 });
  });
  it("開＝前一日均價、收＝當日均價，高低包含開收", () => {
    const b = esbBars(parseEsbHist(hist));
    expect(b[0]).toMatchObject({ open: 1084.2, close: 1084.2 });
    expect(b[1]).toMatchObject({ open: 1084.2, close: 1047.28, high: 1100, low: 1010 });
  });
  it("網址要帶完整日期（只給年月會一律回傳當月）", () => expect(esbHistUrl("7861", "202609")).toContain("date=2026%2F09%2F01"));
  it("依月份下載、過去月份快取", async () => {
    const urls: string[] = [];
    const store = new Map<string, unknown>();
    const kv = { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v); }, del: async () => {} } as any;
    const fetcher = async (u: string) => { urls.push(u); return hist; };
    const now = Date.UTC(2026, 9, 30, 2, 0, 0);
    const a = await esbHistory(fetcher, kv, "7861", 3, now);
    expect(urls.length).toBe(3);
    expect(a.length).toBeGreaterThan(0);
    await esbHistory(fetcher, kv, "7861", 3, now);
    expect(urls.length).toBe(3); // 第二次全部走快取
  });
});
