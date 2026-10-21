import { describe, expect, it } from "vitest";
import { beforeTopUp, closeDay, fillPending, newVirtual, placeOrders, topUp } from "../src/engine/virtualEtf";
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

  it("當天盤中才下的委託不會用當天開盤價成交，留到下一個交易日", () => {
    const v = placeOrders(newVirtual("20261019"), "20261019", [{ code: "2603", name: "長榮", side: "buy", shares: 10, reason: "x" }]);
    const f = fillPending(v, "20261019", { "2603": q(263.5), "0050": q(107) });
    expect(f.trades).toHaveLength(0);
    expect(f.pending).toHaveLength(1);
    expect(fillPending(f, "20261020", { "2603": q(260), "0050": q(107) }).trades[0].price).toBe(260);
  });

  it("加碼到 50 萬：現金多 40 萬、歷史淨值一起加，加碼前的報酬另外算", () => {
    const closed = closeDay(filled, "20261019", { "2027": q(50, 50, 50), "2480": q(170, 170, 170), "0050": q(107.45) });
    const before = valuate(closed, (c) => closed.last[c]?.close);
    const t = topUp(closed, "20261021", 500_000);
    const after = valuate(t, (c) => t.last[c]?.close);
    expect(after.cash - before.cash).toBeCloseTo(400_000);
    expect(after.nav - before.nav).toBeCloseTo(400_000);
    expect(t.nav[0].nav - closed.nav[0].nav).toBe(400_000);
    const b = beforeTopUp(t)!;
    expect(b.ret).toBeCloseTo(closed.nav[0].nav / 100_000 - 1, 6);
    expect(b.days).toBe(1);
    expect(() => topUp(t, "20261022", 400_000)).toThrow();
  });
});
