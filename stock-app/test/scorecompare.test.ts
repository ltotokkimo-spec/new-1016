import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { formatCompare, runScoreCompare, shadowVerdict, SHADOW_KEY, SHADOW_MIN_DAYS, SHADOW_START, VARIANTS, type ShadowResult } from "../src/engine/scoreCompare";
import { DEFAULT_WEIGHTS, scoreStocks, type StockInput } from "../src/engine/score";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 和 backtest.test 同樣的合成資料：前 10 檔每天 +1% 且外資買超，後 10 檔每天 −1% 且外資賣超，其餘持平
function makeDays(): BtDay[] {
  const dates = weekdaysBack("20261016", 150);
  const codes = Array.from({ length: 40 }, (_, k) => String(2001 + k));
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = dates.length - 1; t >= 0; t--) {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const drift = k < 10 ? 0.01 : k >= 30 ? -0.01 : (k % 2 ? 0.001 : -0.001);
      const p = +(p0 * (1 + drift)).toFixed(2);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(2), 2e8, 1e6]);
      flows.push([c, k < 10 ? 500_000 : k >= 30 ? -500_000 : 0, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}

describe("新舊評分對照", () => {
  const companies = Array.from({ length: 40 }, (_, k) => ({ code: String(2001 + k), name: "", industry: k < 20 ? "半導體" : k < 30 ? "電子零組件" : "航運" }));
  const r = runScoreCompare(makeDays(), companies, { now: 0 });
  const get = (key: string, h: 5 | 20) => r.variants.find((v) => v.key === key)!.h[h]!;

  it("每個評分組合都有 5、20 日結果，且有前後半與大盤漲跌切分", () => {
    expect(r.variants.map((v) => v.key)).toEqual(VARIANTS.map((v) => v.key));
    for (const v of r.variants) for (const h of [5, 20] as const) {
      expect(v.h[h]!.days).toBeGreaterThan(50);
      expect(v.h[h]!.first!.days + v.h[h]!.second!.days).toBe(v.h[h]!.days);
    }
    expect(r.split > r.from && r.split <= r.to).toBe(true);
  });
  it("合成資料裡外資買超的股票之後一直漲：含外資籌碼的評分 IC 為正、前 5% 贏過全部", () => {
    for (const k of ["old", "A", "B", "D"]) {
      expect(get(k, 20).ic).toBeGreaterThan(0.2);
      expect(get(k, 20).top).toBeGreaterThan(0);
    }
  });
  it("輸出文字表每組評分都有", () => {
    const lines = formatCompare(r);
    expect(lines[0]).toContain("新舊評分對照");
    for (const v of VARIANTS) expect(lines.some((l) => l.startsWith(`${v.key}｜全部`))).toBe(true);
  });
  it("預設權重不變：不傳權重與傳 DEFAULT_WEIGHTS 結果一樣；流動性權重為 0 時不影響", () => {
    const stocks: StockInput[] = Array.from({ length: 40 }, (_, k) => ({ code: String(2001 + k), name: "", market: "TWSE", sector: "半導體", close: 100, value: 2e8 + (39 - k) * 1e7, ret1w: k / 100, ret1m: k / 50, ret3m: k / 30, foreign5: (k - 20) * 1000, foreignStreak: k % 6, trust5: (20 - k) * 500 }));
    const a = scoreStocks(stocks).scored.map((x) => [x.code, x.score]);
    const b = scoreStocks(stocks, undefined, DEFAULT_WEIGHTS).scored.map((x) => [x.code, x.score]);
    expect(a).toEqual(b);
    const c = scoreStocks(stocks, undefined, { ...DEFAULT_WEIGHTS, liquidity: 0.3, momentum: 0.1 }).scored.map((x) => [x.code, x.score]);
    expect(c).not.toEqual(a);
  });
});

describe("影子追蹤", () => {
  const companies = Array.from({ length: 40 }, (_, k) => ({ code: String(2001 + k), name: `股${2001 + k}`, industry: k < 20 ? "半導體" : k < 30 ? "電子零組件" : "航運" }));
  const days = makeDays();
  const start = days[40].date; // 第 40 天前（新到舊）以後的評等日才算
  const r = runScoreCompare(days, companies, { now: 0, shadowStart: start });
  const sh = r.shadow!;

  it("只算凍結日之後的評等日，且天數比全部少", () => {
    expect(sh.start).toBe(start);
    expect(sh.matured[20]!).toBeGreaterThan(0);
    expect(sh.matured[20]!).toBeLessThan(r.variants[0].h[20]!.days);
    expect(sh.matured[5]!).toBeGreaterThanOrEqual(sh.matured[20]!);
  });
  it("樣本太少時判定資料不足，不下結論", () => {
    expect(sh.matured[20]!).toBeLessThan(SHADOW_MIN_DAYS);
    expect(sh.verdict.status).toBe("資料不足");
    expect(sh.verdict.reasons[0]).toContain(`/${SHADOW_MIN_DAYS}`);
  });
  it("最新資料日有兩份買入名單", () => {
    expect(sh.latest!.date).toBe(days[0].date);
    expect(sh.latest!.old.length).toBeGreaterThan(0);
    expect(sh.latest!.shadow[0]).toHaveProperty("name");
  });
  it("事先訂的通過標準：全部不輸才通過，任何一項輸就未通過", () => {
    const sl = (o: Partial<{ ic: number; top: number; buy: number; buyN: number; days: number }>) => ({ days: 50, ic: 0.01, spread: 0.01, top: 0.01, buy: 0.01, buyN: 40, buyBeat: 0.5, ...o });
    const base = (c: ReturnType<typeof sl>, cd = sl({ ic: 0 }), od = sl({ ic: 0 })): ShadowResult => ({ start: "x", matured: { 20: 50 }, old: { 20: sl({}) }, shadow: { 20: c }, oldDown: { 20: od }, shadowDown: { 20: cd }, liqSpread: {}, verdict: { status: "資料不足", reasons: [] } });
    expect(shadowVerdict(base(sl({ ic: 0.02 }))).status).toBe("通過");
    expect(shadowVerdict(base(sl({ ic: 0.0 }))).status).toBe("未通過");
    expect(shadowVerdict(base(sl({ ic: 0.02, top: 0 }))).reasons.join()).toContain("前 5%");
    expect(shadowVerdict(base(sl({ ic: 0.02, buy: 0 }))).reasons.join()).toContain("買入組");
    expect(shadowVerdict(base(sl({ ic: 0.02 }), sl({ ic: -0.05 }))).reasons.join()).toContain("下跌日");
    expect(shadowVerdict(base(sl({ ic: 0.02, buyN: 70 }))).reasons.join()).toContain("買入檔數");
    expect(shadowVerdict({ ...base(sl({})), matured: { 20: 10 } }).status).toBe("資料不足");
  });
  it("輸出文字有影子追蹤段", () => {
    expect(formatCompare(r).some((l) => l.includes("影子追蹤") && l.includes("資料不足"))).toBe(true);
  });
  it("C 的權重已凍結：改動這組權重或起始日就失去樣本外驗證的意義（要改請重新開始追蹤）", () => {
    expect(SHADOW_KEY).toBe("C");
    expect(SHADOW_START).toBe("20261015");
    expect(VARIANTS.find((v) => v.key === "C")!.w).toEqual({ momentum: 0.2, flow: 0.4, sector: 0.15, liquidity: 0.25, foreign: 0.7, streak: 0.3, trust: 0 });
  });
});
