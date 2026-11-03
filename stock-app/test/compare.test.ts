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
