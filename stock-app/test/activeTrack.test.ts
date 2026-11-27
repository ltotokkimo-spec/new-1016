import { describe, expect, it } from "vitest";
import { runActiveTrack } from "../src/engine/activeTrack";
import type { BtDay } from "../src/engine/backtest";
import { weekdaysBack } from "../src/lib/dates";

describe("主動式 ETF 主動加碼追蹤", () => {
  const dates = weekdaysBack("20261126", 30).reverse();
  // 1001～1003 天天漲 1%，其他平；1001～1003 在第 2 天被 3 家主動加碼
  const days: BtDay[] = dates.map((date, t) => ({ date, flows: [], tpexCodes: new Set(), quotes: ["1001", "1002", "1003", "2001", "2002"].map((c) => [c, `股${c}`, +(100 * (c < "2000" ? 1.01 ** t : 1)).toFixed(4), 0, 1e8, 1e6] as any) }));
  it("隔天收盤進場，5 日超額為正、20 日也算；減碼組沒有就不算", () => {
    const r = runActiveTrack(days, [{ date: dates[2], buy: { "1001": ["A", "B", "C"], "1002": ["A", "B", "C"], "1003": ["A", "B", "C"], "2001": ["A"] }, sell: {} }]);
    expect(r.signalDays).toBe(1);
    expect(r.buy[5].n).toBe(1);
    expect(r.buy[5].avg).toBeGreaterThan(0.02);
    expect(r.buy[20].n).toBe(1);
    expect(r.sell[5].n).toBe(0);
    expect(r.recent[0].picks.map((p) => p.code)).toEqual(["1001", "1002", "1003"]);
  });
});
