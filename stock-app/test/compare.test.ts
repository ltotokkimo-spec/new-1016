import { describe, expect, it } from "vitest";
import { compareGroups } from "../src/engine/compare";
import { newVirtual } from "../src/engine/virtualEtf";

const mk = (start: string, nav: [string, number, number][], budget = 500000) => ({ ...newVirtual(start, budget), asOf: nav.at(-1)?.[0] ?? "", nav: nav.map(([date, n, b]) => ({ date, nav: n, bench: b })) });

describe("虛擬 ETF 總評比", () => {
  const claude = mk("20261019", [["20261019", 495000, 502000], ["20261020", 490000, 500000], ["20261021", 480000, 495000], ["20261022", 492000, 495000]]);
  const rule = mk("20261023", [["20261026", 500000, 500000], ["20261027", 510000, 505000]]);
  const c = compareGroups([{ key: "a", label: "Claude", v: claude }, { key: "b", label: "規則", v: rule }, { key: "c", label: "還沒開始", v: mk("20261023", []) }, { key: "d", label: "沒資料" }]);
  it("各自全期間：報酬、贏輸 0050、最大回檔", () => {
    const a = c.rows[0].all!;
    expect(a.ret).toBeCloseTo(492000 / 500000 - 1, 6);
    expect(a.bench).toBeCloseTo(495000 / 500000 - 1, 6);
    expect(a.diff).toBeCloseTo(a.ret - a.bench, 9);
    expect(a.maxDd).toBeCloseTo(480000 / 500000 - 1, 6);
    expect(a.days).toBe(4);
  });
  it("同期從大家都有資料的最晚那天起算，起點用該天之前最後一筆", () => {
    expect(c.commonFrom).toBe("20261026");
    expect(c.rows[0].same).toBeUndefined(); // Claude 虛擬還沒有 10/26 以後的資料
    const b = c.rows[1].same!;
    expect(b.ret).toBeCloseTo(0.02, 9);
    expect(b.bench).toBeCloseTo(0.01, 9);
    expect(b.days).toBe(2);
  });
  it("沒有淨值紀錄的組合標示尚未開始，不報錯", () => {
    expect(c.rows[2].ready).toBe(false);
    expect(c.rows[3].ready).toBe(false);
    expect(compareGroups([]).rows).toEqual([]);
  });

  it("全買 0050：從成交紀錄的淨值反推 0050 收盤價，算出起始日全買抱著的報酬", () => {
    // 10/28 用 108.65 買股票 10 萬（對照組同時買 0050），10/29 對照組淨值反映 0050 收 107.25
    const trade = { id: "1", date: "20261028", code: "2330", name: "台積電", side: "buy" as const, shares: 100, price: 1000, benchPrice: 108.65 };
    const units = (100 * 1000) / 108.65;
    const cash = 500000 - 100000 * 1.001425;
    const v = { ...mk("20261023", [["20261028", 499000, Math.round(cash + units * 108.65)], ["20261029", 495000, Math.round(cash + units * 107.25)]]), trades: [trade] };
    const r = compareGroups([{ key: "x", label: "X", v }]).rows[0].all!;
    expect(r.holdRet).toBeCloseTo(107.25 / 108.65 - 1, 4);
    expect(r.holdDiff).toBeCloseTo(r.ret - (107.25 / 108.65 - 1), 4);
  });
  it("沒有成交紀錄（反推不出 0050 價格）就不給全買 0050", () => {
    const r = compareGroups([{ key: "x", label: "X", v: mk("20261023", [["20261028", 500000, 500000], ["20261029", 495000, 498000]]) }]).rows[0].all!;
    expect(r.holdRet).toBeUndefined();
  });
});

describe("我的實單加入總評比", () => {
  it("從第一筆成交起算、存入資金不算報酬；不影響其他組的同期起點", async () => {
    const { realAsGroup, compareGroups } = await import("../src/engine/compare");
    const etf: any = {
      budget: 100000,
      trades: [{ id: "a", date: "20261103", code: "2330", name: "台積電", side: "buy", shares: 10, price: 2000 }],
      flows: [{ id: "f", date: "20261105", amount: 50000, navBefore: 110000, benchBefore: 102000 }],
      nav: [
        { date: "20261101", nav: 100000, bench: 100000 }, // 成交前：不算
        { date: "20261103", nav: 100000, bench: 100000 },
        { date: "20261104", nav: 110000, bench: 102000 },
        { date: "20261105", nav: 160000, bench: 152000 }, // 存入 5 萬當天沒有漲跌
      ],
    };
    const g = realAsGroup(etf)!;
    expect(g.start).toBe("20261103");
    expect(g.nav.map((p) => p.date)).toEqual(["20261103", "20261104", "20261105"]);
    expect(g.nav.at(-1)!.nav).toBe(110000); // +10%，存入的 5 萬不算報酬
    expect(g.nav.at(-1)!.bench).toBe(102000);
    expect(realAsGroup({ ...etf, trades: [] })).toBeUndefined();
    // 盤中剛成交：淨值紀錄還停在前一天收盤，加上「現在」這一點才看得到
    const fresh: any = { budget: 100000, trades: [{ id: "b", date: "20261106", code: "2412", name: "中華電", side: "buy", shares: 100, price: 160 }], nav: [{ date: "20261105", nav: 100000, bench: 100000 }] };
    expect(realAsGroup(fresh)).toBeUndefined();
    const g2 = realAsGroup(fresh, { date: "20261106", nav: 99800, bench: 99900 })!;
    expect(g2.nav).toEqual([{ date: "20261106", nav: 99800, bench: 99900 }]);
    const other: any = { version: 1, start: "20261023", asOf: "20261105", updatedAt: 0, budget: 500000, trades: [], pending: [], notes: [], last: {}, nav: [{ date: "20261023", nav: 500000, bench: 500000 }, { date: "20261105", nav: 510000, bench: 505000 }] };
    const c = compareGroups([{ key: "x", label: "X", v: other }, { key: "real", label: "我的實單", v: g, noCommon: true }]);
    expect(c.commonFrom).toBe("20261023");
    expect(c.rows[1].all!.ret).toBeCloseTo(0.1);
  });
});
