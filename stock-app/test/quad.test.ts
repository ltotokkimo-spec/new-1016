import { describe, expect, it } from "vitest";
import type { BtDay } from "../src/engine/backtest";
import { QUAD, quadFactors, quadPicks, runQuad } from "../src/engine/quad";
import { buildCtx } from "../src/engine/steady";
import { prevYm, revTable, type RevEntry } from "../src/engine/revHist";
import { weekdaysBack } from "../src/lib/dates";
import type { FRow, QRow } from "../src/data/twLoader";

// 合成資料：60 檔個股＋0050。前 30 檔緩漲（代號越小波動越小、外資買越多），後 30 檔下跌
function makeDays(n = 260, last = "20261113"): BtDay[] {
  const dates = weekdaysBack(last, n);
  const codes = [...Array.from({ length: 60 }, (_, k) => String(2001 + k)), "0050"];
  const price = new Map(codes.map((c) => [c, 100]));
  const days: BtDay[] = [];
  for (let t = dates.length - 1, step = 0; t >= 0; t--, step++) {
    const quotes: QRow[] = [], flows: FRow[] = [];
    for (const [k, c] of codes.entries()) {
      const p0 = price.get(c)!;
      const r = c === "0050" ? 0.001 : k < 30 ? 0.0015 + (step % 2 ? 1 : -1) * 0.0005 * (k + 1) : -0.002;
      const p = +(p0 * (1 + r)).toFixed(4);
      price.set(c, p);
      quotes.push([c, `股${c}`, p, +(p - p0).toFixed(4), 2e8 + (60 - k) * 1e7, 1e6]);
      flows.push([c, k < 30 ? (30 - k) * 1000 : -5000, 0, 0]);
    }
    days.push({ date: dates[t], quotes, flows, tpexCodes: new Set() });
  }
  return days.reverse();
}
const companies = Array.from({ length: 60 }, (_, k) => ({ code: String(2001 + k), name: "", industry: `產業${k % 6}` }));
const months: { ym: string; rows: RevEntry[] }[] = [];
for (let k = 0; k < 30; k++) months.push({ ym: prevYm("202610", k), rows: companies.map((c, i) => [c.code, 1000 + (60 - i) * 10, 800] as RevEntry) });
const rev = revTable(months);
const days = makeDays();

describe("四因子選股名單（11/15：和現有買入並列、一起追蹤）", () => {
  it("規則參數鎖住（改了就等於重新開始追蹤，要先跟使用者說）", () => {
    expect(QUAD).toMatchObject({ wFlow: 0.3, wLiq: 0.25, wVol: 0.25, wRev: 0.2, flowDays: 60, liqDays: 20, volDays: 60, maDays: 60, maLag: 20, maxRet1w: 0.2, start: "20261116" });
    expect(QUAD.wFlow + QUAD.wLiq + QUAD.wVol + QUAD.wRev).toBeCloseTo(1, 10);
  });
  it("因子：外資買超佔比、平均成交金額、波動、營收年增、站上且上彎 60 日線", () => {
    const c = buildCtx(days, companies, rev), j = c.N - 1;
    const a = quadFactors(c, "2001", j), z = quadFactors(c, "2060", j);
    expect(a.flow60).toBeCloseTo(30000 / 1e6, 10);
    expect(a.flow5).toBeCloseTo(30000 / 1e6, 10); // 每天買一樣多，5 日佔比和 60 日相同
    expect(z.flow5).toBeLessThan(0);
    expect(a.value20).toBeCloseTo(2e8 + 60 * 1e7, 0);
    expect(a.vol60).toBeGreaterThan(0);
    expect(a.yoy3).toBeCloseTo(1600 / 800 - 1, 10);
    expect(a.trendOk).toBe(true);
    expect(z.trendOk).toBe(false); // 一路下跌：不在 60 日線上
    expect(quadFactors(c, "2001", 30).trendOk).toBe(false); // 資料不夠算 60 日線
  });
  it("名單：只取通過門檻的、最多 k 檔、依分數排序、名次從 1 起；沒有營收資料就沒有名單", () => {
    const c = buildCtx(days, companies, rev), j = c.N - 1;
    const base = companies.map((x) => ({ code: x.code, name: `股${x.code}`, ret1w: 0.01, rating: "觀望" })) as any;
    const p = quadPicks(c, j, base, 10);
    expect(p.length).toBe(10);
    expect(p.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < p.length; i++) expect(p[i - 1].score).toBeGreaterThanOrEqual(p[i].score);
    expect(p.every((x) => Number(x.code) <= 2030)).toBe(true); // 下跌的那 30 檔不會入選
    expect(p[0].code).toBe("2001"); // 外資買最多、成交金額最大、波動最小、營收年增最高
    expect(quadPicks(c, j, base.map((x: any) => ({ ...x, ret1w: 0.25 })), 10)).toEqual([]); // 一週漲太多：全部排除
    expect(quadPicks(c, j, base, 0)).toEqual([]);
    expect(quadPicks(buildCtx(days, companies), j, base, 10)).toEqual([]);
  });
  it("回測與追蹤分開：定案日以前算回測（每 5 個交易日），之後算追蹤（每個交易日）；結果穩定", () => {
    const r = runQuad(days, companies, rev, { now: 0, start: "20261001" });
    expect(r.version).toBe(1);
    expect(r.asOf).toBe(days[0].date);
    expect(r.track.start).toBe("20261001");
    expect(r.hist.to < "20261001").toBe(true);
    expect(r.hist.stats.all[20]!.days).toBeGreaterThan(5);
    expect(r.track.stats.all[5]!.days).toBeGreaterThan(r.track.stats.all[20]?.days ?? 0); // 5 日的結果比 20 日先成熟
    expect(r.hist.stats.all[20]!.ex).toBeCloseTo(0, 10); // 全部股票的超額一定是 0
    expect(runQuad(days, companies, rev, { now: 0, start: "20261001" })).toEqual(r);
    // 外資近 5 日賣超／買超分組：兩組的檔數加起來等於四因子（這份合成資料裡入選的都是買超，賣超那組是空的）
    const q20 = r.hist.stats.quad[20]!, b20 = r.hist.stats.buy5[20]!;
    expect(b20.n).toBeCloseTo(q20.n, 10);
    expect(r.hist.stats.sell5[20]?.n ?? 0).toBe(0);
    const d = runQuad(days, companies, rev, { now: 0 }); // 預設起始日在資料之後：追蹤還是空的
    expect(Object.keys(d.track.stats.quad).length).toBe(0);
    expect(d.picks.length).toBe(d.k);
  });
});
