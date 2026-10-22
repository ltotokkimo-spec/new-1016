import { describe, expect, it } from "vitest";
import { navStats } from "../src/engine/navStats";

describe("報酬走勢的說明數字", () => {
  const pts = [
    { date: "20261019", nav: 498884, bench: 500488 },
    { date: "20261020", nav: 497733, bench: 499501 },
    { date: "20261021", nav: 497454, bench: 500249 },
    { date: "20261022", nav: 492028, bench: 494768 },
  ];
  const s = navStats(pts, 500000)!;

  it("累積報酬、損益與落後 0050 的差", () => {
    expect(s.mine).toBeCloseTo(-0.015944, 5);
    expect(s.bench).toBeCloseTo(-0.010464, 5);
    expect(s.diff).toBeCloseTo(-0.00548, 5);
    expect(s.pnl).toBe(-7972);
  });

  it("每天報酬：第一筆相對起始資金，之後相對前一天", () => {
    expect(s.rows[0].mineDay).toBeCloseTo(498884 / 500000 - 1, 8);
    expect(s.rows[3].mineDay).toBeCloseTo(492028 / 497454 - 1, 8);
    expect(s.rows[3].benchDay).toBeCloseTo(494768 / 500249 - 1, 8);
  });

  it("最大回檔從最高點算（起始資金也算一個高點）", () => {
    expect(s.maxDd).toBeCloseTo(492028 / 500000 - 1, 8);
    expect(s.benchMaxDd).toBeCloseTo(494768 / 500488 - 1, 8);
  });

  it("贏過 0050 的天數與最好最差的一天", () => {
    // 10/19 -0.22% vs +0.10%、10/20 -0.23% vs -0.20%、10/21 -0.06% vs +0.15%、10/22 -1.09% vs -1.10%
    expect(s.days).toBe(4);
    expect(s.winDays).toBe(1);
    expect(s.best?.date).toBe("20261021");
    expect(s.worst?.date).toBe("20261022");
  });

  it("沒有資料時回傳 undefined", () => {
    expect(navStats([], 500000)).toBeUndefined();
  });
});
