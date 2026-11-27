import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { buildCtx, momPicker, MOM } from "../src/engine/steady";
import { runWatch } from "../src/engine/watch";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 2001：前 200 天每天漲 1%，之後連跌；2002：平；0050 緩漲
function makeDays(n = 230): BtDay[] {
  const dates = weekdaysBack("20261126", n).reverse(); // 舊到新產生價格，最後轉成新到舊（和回測資料一樣）
  const price = new Map([["2001", 50], ["2002", 100], ["0050", 100]]);
  return dates.map((date, t) => {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const c of price.keys()) {
      const p0 = price.get(c)!;
      const r = c === "2001" ? (t < 200 ? 0.01 : -0.02) : c === "0050" ? 0.001 : 0;
      const p = +(p0 * (1 + r)).toFixed(4);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(4), 5e8, 1e6]);
      flows.push([c, 0, 0, 0]);
    }
    return { date, quotes, flows, tpexCodes: new Set<string>() };
  }).reverse();
}
const days = makeDays();
const companies = [{ code: "2001", name: "", industry: "A" }, { code: "2002", name: "", industry: "B" }];

describe("強勢股（移動停損）", () => {
  const c = buildCtx(days, companies);
  it("強漲的會買、平的不買；停損價跟著最高價往上拉，跌破最高價 8% 才賣", () => {
    const pick = momPicker(c);
    let boughtAt = -1, soldAt = -1;
    for (let j = 140; j < c.N; j++) {
      const t = pick(j);
      if (t.has("2002")) throw new Error("平的不該買");
      if (t.has("2001") && boughtAt < 0) boughtAt = j;
      if (boughtAt >= 0 && !t.has("2001") && soldAt < 0) soldAt = j;
      if (j === 190) expect(pick.held().get("2001")!.peak).toBeGreaterThan(pick.held().get("2001")!.entry * 1.3);
    }
    expect(boughtAt).toBeGreaterThan(0);
    expect(t2(soldAt)).toBe(true);
    function t2(j: number) { return j >= 201 && j <= 206; } // 第 200 天後每天跌 2%，約 4～5 天跌破最高價 8%
    expect(MOM.trail).toBe(0.08);
  });
  it("觀察組合：有停損價、持有中不加減碼", () => {
    const v = runWatch(days.slice(35), companies, { start: days[35 + 30].date, now: 0, mode: "mom" });
    const buys = v.trades.filter((t) => t.code === "2001" && t.side === "buy");
    expect(buys.length).toBe(1);
    expect(v.trades.filter((t) => t.code === "2001" && t.side === "sell").length).toBe(0);
    const st = v.stops?.["2001"] ?? 0;
    expect(st).toBeGreaterThan(buys[0].price * 0.92);
    expect(st).toBeCloseTo(v.last["2001"].close * 0.92, 0);
  });
});
