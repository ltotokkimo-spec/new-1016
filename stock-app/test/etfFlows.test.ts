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
    const flows = [{ id: "a", date: "20261102", amount: 50_000 }, { id: "b", date: "20261104", amount: -50_000 }];
    const st = navStats(pts, 100_000, flows)!;
    expect(st.rows[1].mineDay).toBeCloseTo(0, 6);
    expect(st.rows[3].mineDay).toBeCloseTo(0, 6);
    expect(st.mine).toBeCloseTo(1.1 * 1.1 - 1, 6); // 兩段各 +10%
    expect(st.pnl).toBe(126_000 - 100_000);
    expect(st.maxDd).toBeCloseTo(0, 6);
    // 沒有 flows 時和以前一樣
    expect(navStats(pts.slice(0, 1), 100_000)!.mine).toBeCloseTo(0.1, 10);
  });

  it("存入前沒有任何淨值紀錄、當天已經有賺賠：用存入前一刻的淨值切段，報酬率不被稀釋（模擬器實測抓到的問題）", () => {
    // 起始 10 萬，存入前淨值 99,517（-0.48%），存入 5 萬後淨值 149,517
    const etf: AiEtf = { ...emptyEtf(100_000), trades: [buy("20261103", "2330", 10, 2300)], nav: [] };
    const px = (c: string) => (c === "2330" ? 2252 : 100);
    const before = valuate(etf, px);
    const flows = [{ id: "a", date: "20261103", amount: 50_000, navBefore: before.nav, benchBefore: before.bench }];
    const after = valuate({ ...etf, flows }, px);
    expect(after.ret).toBeCloseTo(before.ret, 6);
    expect(after.benchRet).toBeCloseTo(before.benchRet, 6);
    // 存入後記了當天的淨值，之後再漲：報酬照常累積
    const withPoint = valuate({ ...etf, flows, nav: [{ date: "20261103", nav: Math.round(after.nav), bench: Math.round(after.bench) }] }, (c) => (c === "2330" ? 2300 : 100));
    const expected = (before.nav / 100_000) * (withPoint.nav / (before.nav + 50_000)) - 1;
    expect(withPoint.ret).toBeCloseTo(expected, 4);
    // 走勢圖那天的報酬也一樣
    const st = navStats([{ date: "20261103", nav: Math.round(after.nav), bench: Math.round(after.bench) }], 100_000, flows)!;
    expect(st.mine).toBeCloseTo(before.ret, 4);
  });

  it("還沒有任何成交時也能存入／提領：現金與本金跟著變，報酬 0%", () => {
    const etf: AiEtf = { ...emptyEtf(500_000), flows: [{ id: "a", date: "20261104", amount: 100_000, navBefore: 500_000, benchBefore: 500_000 }] };
    const v = valuate(etf, () => undefined);
    expect(v.cash).toBe(600_000);
    expect(v.invested).toBe(600_000);
    expect(v.bench).toBe(600_000);
    expect(v.ret).toBeCloseTo(0, 10);
    expect(v.benchRet).toBeCloseTo(0, 10);
  });
});
