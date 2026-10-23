import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { runWatch, WATCH } from "../src/engine/watch";
import { valuate } from "../src/engine/aiEtf";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 合成資料：2001～2010 每天穩定上漲，2011～2020 每天 ±5% 亂跳，2021～2030 下跌，0050 緩漲
function makeDays(n = 200): BtDay[] {
  const dates = weekdaysBack("20261023", n);
  const codes = [...Array.from({ length: 30 }, (_, k) => String(2001 + k)), "0050"];
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = dates.length - 1, step = 0; t >= 0; t--, step++) {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const r = c === "0050" ? 0.001 : k < 10 ? 0.002 + (k % 3) * 0.0003 : k < 20 ? 0.002 + (step % 2 ? 0.05 : -0.05) : -0.004;
      const p = +(p0 * (1 + r)).toFixed(4);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(4), 5e8, 1e6]);
      flows.push([c, 0, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}
const companies = Array.from({ length: 30 }, (_, k) => ({ code: String(2001 + k), name: "", industry: `產業${k % 6}` }));
const days = makeDays();
const startAt = days[40].date; // 新到舊，索引 40 ＝ 倒數第 41 個交易日

describe("N5 觀察組合", () => {
  it("開始日還沒到（資料裡沒有）：回傳空的組合，不報錯", () => {
    const v = runWatch(days, companies, { start: "29990101", now: 0 });
    expect(v.trades).toEqual([]);
    expect(v.asOf).toBe("");
    expect(v.budget).toBe(WATCH.budget);
  });

  const v = runWatch(days, companies, { start: startAt, now: 0 });
  it("第一次決定隔天才成交；0050 約五成、方案 A 約五成；不放空、現金不為負", () => {
    expect(v.trades.length).toBeGreaterThan(0);
    const dates = [...new Set(v.trades.map((t) => t.date))].sort();
    expect(dates[0] > startAt).toBe(true);
    const val = valuate(v, (c) => v.last[c]?.close);
    expect(val.cash).toBeGreaterThanOrEqual(0);
    expect(val.missing).toEqual([]);
    const b = v.trades.filter((t) => t.code === "0050" && t.side === "buy").reduce((s, t) => s + t.shares * t.price, 0);
    expect(b / val.nav).toBeGreaterThan(0.35);
    expect(b / val.nav).toBeLessThan(0.65);
    expect(v.trades.every((t) => t.shares > 0 && Number.isInteger(t.shares) && t.price > 0 && t.benchPrice > 0)).toBe(true);
    // 方案 A 只挑平滑上漲的 2001～2010，不挑亂跳與下跌的
    const picks = new Set(v.trades.filter((t) => t.code !== "0050").map((t) => +t.code));
    expect(picks.size).toBeGreaterThan(0);
    expect([...picks].every((c) => c >= 2001 && c <= 2010)).toBe(true);
  });

  it("淨值逐日記錄、報酬為正（資料是上漲的）；說明有寫本日選股", () => {
    expect(v.nav.length).toBeGreaterThan(10);
    expect(v.nav.at(-1)!.nav).toBeGreaterThan(WATCH.budget);
    expect(v.asOf).toBe(days[0].date);
    expect(v.notes.some((n) => n.text.includes("重新選股"))).toBe(true);
  });

  it("結果是穩定的：用同樣資料重算，結果一樣（不需要保存狀態）", () => {
    const again = runWatch(days, companies, { start: startAt, now: 0 });
    expect(again.trades).toEqual(v.trades);
    expect(again.nav).toEqual(v.nav);
  });

  describe("全個股（不限檔數、每天局部修正）", () => {
    const w = runWatch(days, companies, { start: startAt, now: 0, mode: "wide" });
    it("沒有 0050 部位；只持有平滑上漲的個股，不挑亂跳與下跌的；現金不為負", () => {
      expect(w.trades.length).toBeGreaterThan(0);
      expect(w.trades.some((t) => t.code === "0050")).toBe(false);
      const codes = new Set(w.trades.map((t) => +t.code));
      expect([...codes].every((c) => c >= 2001 && c <= 2010)).toBe(true);
      const val = valuate(w, (c) => w.last[c]?.close);
      expect(val.cash).toBeGreaterThanOrEqual(0);
      expect(val.marketValue / val.nav).toBeGreaterThan(0.5);
    });
    it("檔數不設上限：所有通過的都持有（合成資料裡 10 檔都在）", () => {
      const held = new Set<string>();
      for (const t of w.trades) { if (t.side === "buy") held.add(t.code); }
      expect(held.size).toBeGreaterThanOrEqual(8);
    });
    it("每天重新判斷、只做局部修正：不是每天都換一堆（交易日數遠少於每檔每天都交易）", () => {
      const days = new Set(w.trades.map((t) => t.date)).size;
      const perDay = w.trades.length / Math.max(1, days);
      expect(w.nav.length).toBeGreaterThan(10);
      expect(w.trades.length).toBeLessThan(w.nav.length * 3);
      expect(perDay).toBeLessThan(10);
    });
    it("結果穩定：同樣資料重算一樣；說明有寫本日判斷", () => {
      const again = runWatch(days, companies, { start: startAt, now: 0, mode: "wide" });
      expect(again.trades).toEqual(w.trades);
      expect(w.notes.at(-1)!.text).toContain("本日判斷");
    });
  });
});
