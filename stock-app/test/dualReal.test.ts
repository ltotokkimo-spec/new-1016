import { describe, expect, it } from "vitest";
import { DUAL_REAL, dualExitOrders, dualOrders, waterLevel } from "../src/engine/dualReal";
import { emptyEtf, FEE, valuate, type AiEtf } from "../src/engine/aiEtf";

const px: Record<string, number> = { "2330": 1000, "2412": 120, "2886": 40, "0050": 60 };
const price = (c: string) => px[c];
const name = (c: string) => `股${c}`;

describe("雙引擎實單：依目標權重算出這個帳戶要下的單（11/15）", () => {
  it("本金 50 萬、差距 0.5% 才調整（和觀察組合一樣）", () => {
    expect(DUAL_REAL).toEqual({ budget: 500_000, band: 0.005 });
  });
  it("空帳戶：照權重買進，股數無條件捨去，現金夠用、權重大的先列", () => {
    const o = dualOrders(emptyEtf(500_000), { "2330": 0.1, "2412": 0.3, "2886": 0.0001 }, price, name);
    expect(o.map((x) => [x.side, x.code, x.shares])).toEqual([["buy", "2412", 1250], ["buy", "2330", 50]]); // 2886 只有 50 元：小於 0.5% 不買
    expect(o[0].reason).toBe("新增：目標 30.0%");
  });
  it("持股不在名單全部賣出、超過目標的減碼、差距小的不動；先賣後買，買進受現金限制", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), trades: [
      { id: "1", date: "20261113", code: "2886", name: "兆豐金", side: "buy", shares: 5000, price: 40, benchPrice: 60 }, // 20 萬
      { id: "2", date: "20261113", code: "2412", name: "中華電", side: "buy", shares: 2000, price: 120, benchPrice: 60 }, // 24 萬
    ] };
    const nav = valuate(etf, price).nav;
    const o = dualOrders(etf, { "2412": 0.48, "2330": 0.4 }, price, name);
    expect(o[0]).toMatchObject({ side: "sell", code: "2886", shares: 5000, reason: "不在雙引擎今天的名單，全部賣出" });
    expect(o.some((x) => x.code === "2412")).toBe(false); // 目前 24 萬 ≈ 48%：差距小於 0.5% 不動
    const buy = o.find((x) => x.code === "2330")!;
    expect(buy.side).toBe("buy");
    expect(buy.shares).toBe(Math.floor(Math.min(0.4 * nav, Infinity) / 1000));
    expect(buy.shares * 1000 * (1 + FEE)).toBeLessThanOrEqual(valuate(etf, price).cash + 5000 * 40);
  });
  it("沒有價格的股票跳過；淨值是 0 時不下單", () => {
    expect(dualOrders(emptyEtf(500_000), { "9999": 0.5 }, price, name)).toEqual([]);
    expect(dualOrders(emptyEtf(0), { "2330": 0.5 }, price, name)).toEqual([]);
  });
});

describe("資金水位：股票成本、賺賠、現金（11/15）", () => {
  const buy = (code: string, shares: number, p: number): AiEtf["trades"][number] => ({ id: code, date: "20261113", code, name: code, side: "buy", shares, price: p, benchPrice: 60 });
  it("空帳戶：整條都是現金", () => {
    const w = waterLevel(emptyEtf(500_000), price);
    expect(w).toMatchObject({ cost: 0, cash: 500_000, invested: 500_000, unrealized: 0 });
    expect(w.bar).toEqual({ stock: 0, gain: 0, loss: 0, cash: 100, tick: 0, reserve: 0 });
  });
  it("賺錢：成本＋賺＋現金＝100%，成本線在成本右緣", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), trades: [buy("2330", 100, 800)] }; // 成本 8 萬（含手續費），市值 10 萬
    const w = waterLevel(etf, price);
    expect(w.cost).toBeCloseTo(80_000 * (1 + FEE), 6);
    expect(w.unrealized).toBeCloseTo(100_000 - w.cost, 6);
    expect(w.bar.loss).toBe(0);
    expect(w.bar.stock + w.bar.gain + w.bar.cash).toBeCloseTo(100, 6);
    expect(w.bar.tick).toBeCloseTo(w.bar.stock, 6);
    expect(w.cost + w.cash).toBeCloseTo(500_000, 6);
  });
  it("賠錢：市值＋缺口＋現金＝100%，成本線在缺口右緣", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), trades: [buy("2330", 100, 1200)] };
    const w = waterLevel(etf, price);
    expect(w.unrealized).toBeLessThan(0);
    expect(w.bar.gain).toBe(0);
    expect(w.bar.stock + w.bar.loss + w.bar.cash).toBeCloseTo(100, 6);
    expect(w.bar.tick).toBeCloseTo(w.bar.stock + w.bar.loss, 6);
  });
  it("增加投入：現金和投入一起變多，要下的單照新的總值放大", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), trades: [buy("2412", 1250, 120)] };
    const more: AiEtf = { ...etf, flows: [{ id: "f", date: "20261116", amount: 100_000 }] };
    expect(waterLevel(more, price).invested).toBe(600_000);
    expect(waterLevel(more, price).cash - waterLevel(etf, price).cash).toBe(100_000);
    expect(dualOrders(etf, { "2412": 0.3 }, price, name)).toEqual([]);
    expect(dualOrders(more, { "2412": 0.3 }, price, name)[0]).toMatchObject({ side: "buy", code: "2412" });
  });
});

describe("保留現金：買進不動用保留的那筆（11/15）", () => {
  it("沒設定＝和以前一樣；保留 10 萬，買進最多只用到現金剩 10 萬", () => {
    const t = { "2412": 0.5 }; // 目標 25 萬，現金 50 萬
    const full = dualOrders(emptyEtf(500_000), t, price, name);
    expect(full[0].shares).toBe(Math.floor(250_000 / 120));
    const kept = dualOrders({ ...emptyEtf(500_000), cashReserve: 400_000 }, t, price, name); // 只能動用 10 萬
    expect(kept[0].shares).toBe(Math.floor(100_000 / (1 + FEE) / 120));
    expect(dualOrders({ ...emptyEtf(500_000), cashReserve: 500_000 }, t, price, name)).toEqual([]); // 全部保留＝不買
  });
  it("水位：保留的現金標在現金段右側，最多算到現有現金", () => {
    const w = waterLevel({ ...emptyEtf(500_000), cashReserve: 100_000 }, price);
    expect(w.reserve).toBe(100_000);
    expect(w.bar.reserve).toBeCloseTo(20, 6);
    expect(waterLevel({ ...emptyEtf(500_000), cashReserve: 900_000 }, price).bar.reserve).toBe(100);
    expect(waterLevel(emptyEtf(500_000), price).bar.reserve).toBe(0);
  });
});

describe("先不買：指定的代號這次不買，空出的現金不轉去買別檔（11/16）", () => {
  it("略過 2412 後只剩 2330，股數不變", () => {
    const t = { "2412": 0.3, "2330": 0.1 };
    const all = dualOrders(emptyEtf(500_000), t, price, name);
    const skipped = dualOrders(emptyEtf(500_000), t, price, name, DUAL_REAL.band, new Set(["2412"]));
    expect(all.map((x) => x.code)).toEqual(["2412", "2330"]);
    expect(skipped.map((x) => x.code)).toEqual(["2330"]);
    expect(skipped[0].shares).toBe(all[1].shares);
  });
});

describe("雙引擎實單：跌破停損／停利的持股列進要下的單（11/26，和手機推播同一條件）", () => {
  const held = (extra: Partial<AiEtf> = {}): AiEtf => ({ ...emptyEtf(500_000), ...extra, trades: [
    { id: "1", date: "20261113", code: "2886", name: "兆豐金", side: "buy", shares: 5000, price: 50, benchPrice: 60 }, // 均價 50，預設停損 45
    { id: "2", date: "20261113", code: "2412", name: "中華電", side: "buy", shares: 1000, price: 120, benchPrice: 60 },
  ] });
  it("沒跌破：不列", () => {
    expect(dualExitOrders(held(), (c) => ({ "2886": 46, "2412": 118 })[c], name)).toEqual([]);
  });
  it("現價 ≤ 預設停損（均價 −10%）：整檔列賣出，說明寫停損價與報酬", () => {
    const o = dualExitOrders(held(), (c) => ({ "2886": 44, "2412": 118 })[c], name);
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ code: "2886", side: "sell", shares: 5000, price: 44 });
    expect(o[0].reason).toContain("跌破停損價 45.06");
    expect(o[0].reason).toContain("預設均價 −10%");
    expect(o[0].reason).toContain("-12.1%");
  });
  it("自己設的停損價高於均價＝停利價：寫達標離場", () => {
    const o = dualExitOrders(held({ stops: { "2412": 125 } }), (c) => ({ "2886": 52, "2412": 124 })[c], name);
    expect(o.map((x) => x.code)).toEqual(["2412"]);
    expect(o[0].reason).toContain("跌破停利價（達標離場）");
  });
  it("沒有價格的持股跳過", () => {
    expect(dualExitOrders(held(), () => undefined, name)).toEqual([]);
  });
});
