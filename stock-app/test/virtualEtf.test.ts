import { describe, expect, it } from "vitest";
import { closeDay, fillPending, newVirtual, placeOrders } from "../src/engine/virtualEtf";
import { positions, valuate } from "../src/engine/aiEtf";

const q = (open: number, low = open, close = open, high = open) => ({ open, high, low, close });

describe("虛擬自組 ETF", () => {
  const start = placeOrders(newVirtual("20261019"), "20261018", [
    { code: "2027", name: "大成鋼", side: "buy", shares: 350, limit: 51.5, stop: 46.5, reason: "a" },
    { code: "2480", name: "敦陽科", side: "buy", shares: 90, limit: 180, stop: 170, reason: "b" },
    { code: "3010", name: "華立", side: "buy", shares: 120, limit: 130, stop: 128, reason: "c" },
  ]);
  const quotes = { "2027": q(50.7, 50.1), "2480": q(183.5, 179.5), "3010": q(138, 134), "0050": q(107.45) };
  const filled = fillPending(start, "20261019", quotes);

  it("開盤 ≤ 限價用開盤價成交；盤中碰到限價用限價成交；沒碰到就取消", () => {
    const t = Object.fromEntries(filled.trades.map((x) => [x.code, x.price]));
    expect(t).toEqual({ "2027": 50.7, "2480": 180 });
    expect(filled.cancelled?.map((c) => c.code)).toEqual(["3010"]);
    expect(filled.pending).toEqual([]);
    expect(filled.stops).toEqual({ "2027": 46.5, "2480": 170 });
    expect(filled.trades[0].benchPrice).toBe(107.45);
  });

  it("收盤跌破停損價，自動排入隔天開盤賣出；隔天以開盤價賣掉", () => {
    const closed = closeDay(filled, "20261019", { "2027": q(50.7, 45, 46), "2480": q(183, 180, 182), "0050": q(107, 107, 108) });
    expect(closed.nav).toHaveLength(1);
    expect(closed.pending).toMatchObject([{ code: "2027", side: "sell", shares: 350 }]);
    const next = fillPending(closed, "20261020", { "2027": q(45.5), "0050": q(108) });
    expect(positions(next.trades).find((p) => p.code === "2027")!.shares).toBe(0);
    expect(next.trades.at(-1)).toMatchObject({ side: "sell", price: 45.5 });
  });

  it("現金不夠時自動減少股數，不會變成負的", () => {
    const big = placeOrders(newVirtual("20261019"), "20261018", [{ code: "2603", name: "長榮", side: "buy", shares: 1000, reason: "x" }]);
    const f = fillPending(big, "20261019", { "2603": q(263.5), "0050": q(107) });
    expect(f.trades[0].shares).toBe(378);
    expect(valuate(f, () => 263.5).cash).toBeGreaterThanOrEqual(0);
  });
});
