import { describe, expect, it } from "vitest";
import { emptyEtf, twrSeries, valuate, type AiEtf, type EtfTrade } from "../src/engine/aiEtf";
import { navStats } from "../src/engine/navStats";

const buy = (date: string, code: string, shares: number, price: number, benchPrice = 100): EtfTrade =>
  ({ id: `${date}${code}`, date, code, name: code, side: "buy", shares, price, benchPrice });

describe("我的實單：中途存入／提領資金", () => {
  it("沒有存提款時，時間加權報酬就等於 淨值 ÷ 起始資金（和以前一樣）", () => {
    const r = twrSeries([{ date: "20261101", v: 105_000 }, { date: "20261102", v: 99_000 }, { date: "20261103", v: 110_000 }], 100_000);
    expect(r.at(-1)!.cum).toBeCloseTo(0.1, 10);
  });

  it("存入的錢變成現金、0050 對照組也加同樣的錢；本金增加，報酬率不被稀釋", () => {
    // 10 萬起始，買 2330 50 股 @1000（約 5 萬），漲到 1200：賺約 1 萬（約 +10%）
    const etf: AiEtf = { ...emptyEtf(100_000), trades: [buy("20261101", "2330", 50, 1000)], nav: [{ date: "20261101", nav: 99_929, bench: 99_929 }, { date: "20261102", nav: 109_929, bench: 99_929 }] };
    const px = (c: string) => (c === "2330" ? 1200 : 100);
    const before = valuate(etf, px);
    const withIn = valuate({ ...etf, flows: [{ id: "a", date: "20261103", amount: 50_000 }] }, px);
    expect(withIn.cash).toBeCloseTo(before.cash + 50_000, 6);
    expect(withIn.bench).toBeCloseTo(before.bench + 50_000, 6);
    expect(withIn.invested).toBe(150_000);
    expect(withIn.nav - withIn.invested).toBeCloseTo(before.nav - 100_000, 6); // 總損益金額不變
    expect(withIn.ret).toBeCloseTo(before.ret, 4); // 報酬率沒有被 5 萬閒置現金稀釋
    expect(withIn.benchRet).toBeCloseTo(before.benchRet, 4);
  });

  it("提領：現金與本金減少，損益與報酬率不變", () => {
    const etf: AiEtf = { ...emptyEtf(100_000), trades: [buy("20261101", "2330", 50, 1000)], nav: [{ date: "20261102", nav: 109_929, bench: 99_929 }] };
    const px = (c: string) => (c === "2330" ? 1200 : 100);
    const before = valuate(etf, px);
    const out = valuate({ ...etf, flows: [{ id: "b", date: "20261103", amount: -20_000 }] }, px);
    expect(out.cash).toBeCloseTo(before.cash - 20_000, 6);
    expect(out.invested).toBe(80_000);
    expect(out.nav - out.invested).toBeCloseTo(before.nav - 100_000, 6);
    expect(out.ret).toBeCloseTo(before.ret, 4);
  });

  it("報酬走勢：存提款那天不跳動，損益金額扣掉投入本金，最大回檔不把提領當成下跌", () => {
    const pts = [
      { date: "20261101", nav: 110_000, bench: 102_000 }, // +10%
      { date: "20261102", nav: 160_000, bench: 152_000 }, // 存入 5 萬、當天持平
      { date: "20261103", nav: 176_000, bench: 152_000 }, // +10%
      { date: "20261104", nav: 126_000, bench: 102_000 }, // 提領 5 萬、當天持平
    ];
    const flows = [{ date: "20261102", amount: 50_000 }, { date: "20261104", amount: -50_000 }];
    const st = navStats(pts, 100_000, flows)!;
    expect(st.rows[1].mineDay).toBeCloseTo(0, 6);
    expect(st.rows[3].mineDay).toBeCloseTo(0, 6);
    expect(st.mine).toBeCloseTo(1.1 * 1.1 - 1, 6); // 兩段各 +10%
    expect(st.pnl).toBe(126_000 - 100_000);
    expect(st.maxDd).toBeCloseTo(0, 6);
    // 沒有 flows 時和以前一樣
    expect(navStats(pts.slice(0, 1), 100_000)!.mine).toBeCloseTo(0.1, 10);
  });
});
