import { describe, expect, it } from "vitest";
import { appendPicks, assertAppendOnly, BOOK_INFO, emptyLog, evaluatePick, firstPickIds, netReturn, netReturnUs, perfStats, toCsv, type PickPerfFile } from "../src/engine/pickLog";

const base = { name: "測試", market: "TWSE" as const, score: 80, reasons: ["外資連買"], dataDate: "20261109" };

describe("推薦紀錄：只新增、不覆蓋", () => {
  it("同一天不重記、不補過去；停損＝推薦價 −8%", () => {
    let { log, added } = appendPicks(emptyLog(), "20261109", [{ ...base, code: "2412", price: 160 }]);
    expect(added).toBe(1);
    expect(log.start).toBe("20261109");
    expect(log.picks[0]).toMatchObject({ id: "20261109-2412", stop: 147.2, source: "買入" });
    expect(appendPicks(log, "20261109", [{ ...base, code: "2330", price: 2000 }]).added).toBe(0);
    expect(appendPicks(log, "20261106", [{ ...base, code: "2330", price: 2000 }]).added).toBe(0);
    const next = appendPicks(log, "20261110", [{ ...base, code: "2330", price: 2000 }]).log;
    expect(() => assertAppendOnly(log, next)).not.toThrow();
    const broken = { ...next, picks: next.picks.slice(1) };
    expect(() => assertAppendOnly(log, broken)).toThrow(/被改動或刪除/);
  });
});

describe("成本：手續費、證交稅、零股", () => {
  it("1 萬元買 160 元的股票＝62 股零股；手續費最低 1 元；賣出扣 0.3% 證交稅", () => {
    const r = netReturn(160, 160);
    expect(r.shares).toBe(62);
    // 買 9,920＋手續費 14；賣 9,920－手續費 14－稅 30
    expect(r.net).toBeCloseTo((9920 - 14 - 30) / (9920 + 14) - 1, 6);
  });
  it("整股（股價 8 元，1250 股）手續費最低 20 元；ETF 證交稅 0.1%", () => {
    const r = netReturn(8, 8);
    expect(r.shares).toBe(1250);
    expect(r.net).toBeCloseTo((10000 - 20 - 30) / (10000 + 20) - 1, 6);
    expect(netReturn(100, 100, true).net).toBeCloseTo((10000 - 14 - 10) / (10000 + 14) - 1, 6);
  });
});

describe("績效：持有 5 日、觸及停損、超額報酬", () => {
  const p = appendPicks(emptyLog(), "20261109", [{ ...base, code: "2412", price: 100 }]).log.picks[0];
  const days = ["20261110", "20261111", "20261112", "20261113", "20261116", "20261117"];
  it("5 日報酬、對加權與 0050 的超額；沒滿 10 日就沒有 10 日結果", () => {
    const path = [1.01, 1.02, 0.99, 1.03, 1.05, 1.04].map((f, i) => ({ date: days[i], f }));
    const tai = new Map(days.map((d, i) => [d, [0.01, 0.0, -0.01, 0.0, 0.02, 0.02][i]]));
    const b = new Map(days.map((d, i) => [d, [0.0, 0.0, 0.0, 0.0, 0.03, 0.03][i]]));
    const r = evaluatePick(p, path, tai, b);
    expect(r.elapsed).toBe(6);
    expect(r.h[5]!.ret).toBeCloseTo(0.05);
    expect(r.h[5]!.exTaiex).toBeCloseTo(r.h[5]!.net - 0.02);
    expect(r.h[5]!.ex0050).toBeCloseTo(r.h[5]!.net - 0.03);
    expect(r.h[5]!.stopHit).toBe(false);
    expect(r.h[10]).toBeUndefined();
  });
  it("期間收盤跌破停損（−8%）就算觸及，停損出場用那天收盤", () => {
    const path = [0.97, 0.91, 0.95, 1.0, 1.02].map((f, i) => ({ date: days[i], f }));
    const r = evaluatePick(p, path, new Map(), new Map());
    expect(r.h[5]!.stopHit).toBe(true);
    expect(r.h[5]!.stopDate).toBe("20261111");
    expect(r.h[5]!.stopNet).toBeCloseTo(netReturn(100, 91).net, 6);
    expect(r.h[5]!.net).toBeCloseTo(netReturn(100, 102).net, 6);
  });
  it("統計：勝率、平均、最大單筆虧損、停損比例；CSV 有表頭與每筆", () => {
    const a = evaluatePick(p, [1.05, 1.05, 1.05, 1.05, 1.05].map((f, i) => ({ date: days[i], f })), new Map(), new Map());
    const q = { ...p, id: "20261109-2330", code: "2330", name: "台積電" };
    const c = evaluatePick(q, [0.95, 0.9, 0.9, 0.9, 0.9].map((f, i) => ({ date: days[i], f })), new Map(), new Map());
    const s = perfStats([a, c], 5);
    expect(s.n).toBe(2);
    expect(s.win).toBe(0.5);
    expect(s.worst?.code).toBe("2330");
    expect(s.stopRate).toBe(0.5);
    const f: PickPerfFile = { version: 1, generatedAt: 0, start: "20261109", dataTo: "20261116", rule: "", source: "", cost: { notional: 10000, feeRate: 0.001425, feeMinLot: 20, feeMinOdd: 1, taxStock: 0.003, taxEtf: 0.001, stop: 0.08 }, rows: [a, c] };
    const csv = toCsv(f).replace(/^﻿/, "").trim().split("\n");
    expect(csv[0]).toMatch(/^推薦日,代號,名稱,市場,推薦價,停損價/);
    expect(csv.length).toBe(3);
    expect(csv[2]).toMatch(/^20261109,2330,台積電,上市,100,92,/);
  });
});

describe("只看首次推薦", () => {
  it("連續在名單只算第一天；掉出後再回來算新的一次；第一個記錄日全部算首次", () => {
    const r = (date: string, code: string) => ({ id: `${date}-${code}`, date, code });
    const rows = [r("20261106", "2412"), r("20261106", "2330"), r("20261109", "2412"), r("20261109", "1101"), r("20261110", "2330"), r("20261110", "1101")];
    expect([...firstPickIds(rows)].sort()).toEqual(["20261106-2330", "20261106-2412", "20261109-1101", "20261110-2330"]);
  });
});

describe("排序", () => {
  it("CSV：新日期在前，同一天分數高到低", () => {
    const mk = (date: string, code: string, score: number) => ({ ...base, id: `${date}-${code}`, date, code, score, price: 10, stop: 9.2, source: "買入" as const, elapsed: 0, h: {} });
    const f: PickPerfFile = { version: 1, generatedAt: 0, start: "20261106", dataTo: "20261109", rule: "", source: "", cost: { notional: 10000, feeRate: 0.001425, feeMinLot: 20, feeMinOdd: 1, taxStock: 0.003, taxEtf: 0.001, stop: 0.08 },
      rows: [mk("20261106", "A", 70), mk("20261106", "B", 90), mk("20261109", "C", 75), mk("20261109", "D", 85)] };
    const codes = toCsv(f).trim().split("\n").slice(1).map((l) => l.split(",")[1]);
    expect(codes).toEqual(["D", "C", "B", "A"]);
  });
});

describe("ETF 與美股", () => {
  it("美股：1,000 美元小數股、買賣各 0.1% 手續費、沒有證交稅", () => {
    const r = netReturnUs(200, 220);
    expect(r.shares).toBeCloseTo(5, 9);
    expect(r.net).toBeCloseTo((1100 * 0.999) / (1000 * 1.001) - 1, 9);
  });
  it("美股推薦用美股成本；ETF 名單標「分數前10」；CSV 基準欄位用美股名稱", () => {
    const us = appendPicks(emptyLog("US"), "20261106", [{ ...base, code: "NVDA", market: "US", price: 200 }]).log;
    expect(us.rule).toMatch(/美股/);
    const r = evaluatePick(us.picks[0], [1, 1, 1, 1, 1.1].map((f, i) => ({ date: `2026111${i}`, f })), new Map(), new Map());
    expect(r.h[5]!.net).toBeCloseTo(netReturnUs(200, 220).net, 9);
    const etf = appendPicks(emptyLog("ETF"), "20261106", [{ ...base, code: "0050", price: 60 }], BOOK_INFO.ETF.source).log;
    expect(etf.picks[0].source).toBe("分數前10");
    const f: PickPerfFile = { version: 1, generatedAt: 0, start: "20261106", dataTo: "20261113", rule: "", source: "", book: "US", bench: BOOK_INFO.US.bench, currency: "USD", cost: { notional: 1000, feeRate: 0.001, feeMinLot: 0, feeMinOdd: 0, taxStock: 0, taxEtf: 0, stop: 0.08 }, rows: [r] };
    const csv = toCsv(f).replace(/^﻿/, "").split("\n");
    expect(csv[0]).toMatch(/5日S&P 500（SPY）%,5日那斯達克 100（QQQ）%/);
    expect(csv[1]).toMatch(/^20261106,NVDA,測試,美股,200,184,/);
  });
});
