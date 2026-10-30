import { describe, expect, it } from "vitest";
import { ETF_UNIVERSE, DEFAULT_CFG, align, chooseTarget, downSegmentReturn, evaluate, fixSplits, fixedDecider, isPeriodEnd, metrics, parseYahoo, simulate, strategyDecider, violations, waterFill, type EtfData } from "../src/engine/etfBacktest";

// 合成資料：每檔一條可控的價格路徑（從 2024-01-01 起每個平日一根）
const dates = (() => { const out: string[] = []; const d = new Date(Date.UTC(2024, 0, 1)); while (out.length < 330) { if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10).replace(/-/g, "")); d.setUTCDate(d.getUTCDate() + 1); } return out; })();
const series = (code: string, f: (i: number) => number, divs: [number, number][] = [], from = 0): EtfData => ({
  def: ETF_UNIVERSE.find((e) => e.code === code)!,
  bars: dates.map((d, i) => ({ d, o: f(i), c: f(i), v: 5e6 })).slice(from),
  divs: divs.map(([i, amt]) => ({ d: dates[i], amt })),
});
const flat = (x: number) => () => x;
const drift = (x: number, g: number) => (i: number) => x * Math.pow(1 + g, i);

describe("ETF 回測：分配與限制", () => {
  it("waterFill：碰到上限的固定，剩下的平分；放不下的回報 left", () => {
    expect(waterFill([0.4, 0.4, 0.4], 0.8).w.map((x) => +x.toFixed(4))).toEqual([0.2667, 0.2667, 0.2667]);
    const a = waterFill([0.2, 0.4, 0.4], 0.8);
    expect(a.w.map((x) => +x.toFixed(4))).toEqual([0.2, 0.3, 0.3]);
    const b = waterFill([0.2, 0.2], 0.8);
    expect(b.w).toEqual([0.2, 0.2]);
    expect(b.left).toBeCloseTo(0.4, 6);
  });

  const data = [
    series("0050", drift(100, 0.0004)), series("006208", drift(200, 0.0003)), // 同群組：只會選一檔
    series("00878", drift(30, 0.0006)), series("0056", drift(50, 0.0002)), series("0052", drift(60, 0.0005)),
    series("00981A", drift(10, 0.0009)), series("00406A", drift(10, 0.0008)),
    series("00720B", drift(30, 0.0001)), series("00751B", drift(30, 0.00005)), series("00679B", drift(26, 0.00005)),
  ];
  const a = align(data);

  it("目標配置：同群組只選 1 檔、主動式 ≤ 20%、單檔 ≤ 40%、權重加起來是 100%", () => {
    const t = chooseTarget(a, 200, new Set(), DEFAULT_CFG)!;
    expect(t).toBeTruthy();
    expect(violations(a, t, DEFAULT_CFG)).toEqual([]);
    const sum = Object.values(t.weights).reduce((s, x) => s + x, 0);
    expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    expect(sum).toBeGreaterThan(0.95);
    expect(!(t.weights["0050"] && t.weights["006208"])).toBe(true);
    for (const [c, w] of Object.entries(t.weights)) { expect(w).toBeLessThanOrEqual(0.4 + 1e-9); if (c.endsWith("A")) expect(w).toBeLessThanOrEqual(0.2 + 1e-9); }
    expect(Object.keys(t.weights).some((c) => c.endsWith("B"))).toBe(true); // 防守部分有債券
  });

  it("歷史不夠長（< warmup）的 ETF 不會被選進去", () => {
    const young = align([series("0050", drift(100, 0.0004)), series("00720B", drift(30, 0.0001)), series("00981A", drift(10, 0.01), [], 150)]);
    const t = chooseTarget(young, 200, new Set(), DEFAULT_CFG)!; // 00981A 只有 50 天
    expect(t.weights["00981A"]).toBeUndefined();
    const later = chooseTarget(young, 290, new Set(), DEFAULT_CFG)!; // 140 天，超過 120
    expect(later.weights["00981A"]).toBeGreaterThan(0);
  });

  it("沒有債券、沒有股票型可選時回傳 null，不會亂配", () => {
    const only = align([series("0050", flat(100))]);
    const t = chooseTarget(only, 200, new Set(), DEFAULT_CFG);
    expect(t === null || Object.keys(t.weights).every((c) => c === "0050")).toBe(true);
  });
});

describe("ETF 回測：模擬（成本、配息、基準）", () => {
  const start = 130; // 第 130 天是週五？用 weekKey 保證從週末那天開始
  const cfg = { ...DEFAULT_CFG, budget: 100_000 };
  const flat100 = align([series("0050", flat(100), [[start + 4, 2]])]);
  const wk = (() => { let s = start; while (!(new Date(Date.UTC(+dates[s].slice(0, 4), +dates[s].slice(4, 6) - 1, +dates[s].slice(6))).getUTCDay() === 5)) s++; return s; })();

  it("買進持有 0050：只扣買進手續費；除息日前一天收盤持有的才有配息", () => {
    const data = align([series("0050", flat(100), [[wk + 1, 2], [wk + 3, 2]])]); // wk+1 是隔天開盤買進的當天（不算），wk+3 才算
    const sim = simulate(data, wk, fixedDecider({ "0050": 1 }, 1e9), cfg); // 不做季調，只看第一次建倉
    const shares = sim.rebalances[0].legs[0].shares;
    expect(shares).toBe(Math.floor(100_000 / (100 * 1.001425)));
    expect(sim.dividends).toBeCloseTo(shares * 2, 6); // 只算 wk+3 那一次
    expect(sim.cost).toBeCloseTo(shares * 100 * 0.001425, 6);
    const last = sim.nav[sim.nav.length - 1].nav;
    expect(last).toBeCloseTo(100_000 - shares * 100 * 0.001425 + shares * 2, 4);
  });

  it("賣出要付手續費＋證交稅 0.1%", () => {
    const data = align([series("0050", flat(100)), series("00720B", flat(30))]);
    let call = 0;
    const sim = simulate(data, wk, ((_a: unknown, _i: number, held: Record<string, number>) => (call++ === 0 ? { target: { "0050": 1 }, risk: "on", why: "a" } : Object.keys(held).includes("0050") && call === 2 ? { target: { "00720B": 1 }, risk: "on", why: "b" } : null)) as any, cfg);
    expect(sim.rebalances).toHaveLength(2);
    const sell = sim.rebalances[1].legs.find((l) => l.side === "sell")!;
    const buy1 = sim.rebalances[0].legs[0];
    expect(sell.shares).toBe(buy1.shares);
    expect(sim.rebalances[1].cost).toBeGreaterThan(Math.round(sell.shares * 100 * 0.001425)); // 比單純手續費多（含稅）
  });

  it("策略不會在沒有理由時天天調整：價格平穩時只有建倉＋偶爾的季調", () => {
    const data = [
      series("0050", drift(100, 0.0004)), series("00878", drift(30, 0.0003)), series("0052", drift(60, 0.0002)),
      series("00720B", drift(30, 0.0001)), series("00679B", drift(26, 0.00005)),
    ];
    const a = align(data);
    const sim = simulate(a, wk + 100 - (wk % 5 ? 0 : 0), strategyDecider(DEFAULT_CFG), DEFAULT_CFG);
    expect(sim.rebalances.length).toBeLessThan(15);
    expect(sim.violations).toEqual([]);
    expect(sim.maxWeight).toBeLessThanOrEqual(1);
  });
  void flat100;
});

describe("ETF 回測：指標與標準", () => {
  const mk = (xs: number[]) => xs.map((nav, i) => ({ d: dates[i], nav }));
  it("最大回檔與總報酬", () => {
    const m = metrics(mk([100, 120, 90, 110]));
    expect(m.totalReturn).toBeCloseTo(0.1, 6);
    expect(m.maxDrawdown).toBeCloseTo(90 / 120 - 1, 6);
  });
  it("基準回落 ≥ 5% 的日子才算下跌段", () => {
    const bench = mk([100, 110, 100, 95, 105]); // 110→100(-9.1%)、100→95 都在下跌段；之後 105 仍低於高點 110 約 4.5%（不算）
    const strat = mk([100, 105, 104, 103, 110]);
    // 下跌段的日報酬：i=2（-0.95%）、i=3（-0.96%）
    expect(downSegmentReturn(strat, bench)).toBeCloseTo(Math.exp(Math.log(104 / 105) + Math.log(103 / 104)) - 1, 6);
  });
  it("evaluate：五條標準各自判斷", () => {
    const nav = (xs: number[]) => ({ nav: mk(xs), rebalances: [] as any[], cost: 0, dividends: 0, violations: [], maxWeight: 0.3, last: { weights: {}, target: null, date: "" }, picks: {} });
    const good = evaluate(nav([100, 102, 101, 106]), nav([100, 110, 95, 104]), nav([100, 103, 98, 103]), DEFAULT_CFG);
    expect(good.criteria.map((c) => c.pass)).toEqual([true, true, true, true, true]);
    const bad = evaluate(nav([100, 90, 85, 88]), nav([100, 110, 95, 104]), nav([100, 103, 98, 103]), DEFAULT_CFG);
    expect(bad.pass).toBe(false);
    expect(bad.criteria[0].pass).toBe(false);
  });
});

describe("Yahoo 日線解析", () => {
  it("取日線與配息，日期換成台北時間，沒有收盤價的跳過", () => {
    const t0 = Date.UTC(2026, 9, 29, 1, 0) / 1000; // 台北 10/29 09:00
    const r = parseYahoo({ chart: { result: [{ timestamp: [t0, t0 + 86400], indicators: { quote: [{ open: [10, null], close: [10.5, null], volume: [1000, 0] }] }, events: { dividends: { a: { date: t0 + 86400, amount: 0.4 } } } }] } })!;
    expect(r.bars).toEqual([{ d: "20261029", o: 10, c: 10.5, v: 1000 }]);
    expect(r.divs).toEqual([{ d: "20261030", amt: 0.4 }]);
    expect(r.splits).toEqual([]);
    expect(parseYahoo({})).toBeNull();
  });
});

describe("分割還原", () => {
  it("沒調整的分割（價格真的跳 4 倍）才會被修正；已調整的不動", () => {
    const raw = [{ d: "20250101", o: 200, c: 200, v: 100 }, { d: "20250102", o: 200, c: 200, v: 100 }, { d: "20250103", o: 50, c: 50, v: 400 }];
    const divs = [{ d: "20250102", amt: 4 }, { d: "20250103", amt: 1 }];
    const fixed = fixSplits(raw, divs, [{ d: "20250103", ratio: 4 }]);
    expect(fixed).toEqual(["20250103"]);
    expect(raw.map((b) => b.c)).toEqual([50, 50, 50]);
    expect(raw[0].v).toBe(400);
    expect(divs.map((d) => d.amt)).toEqual([1, 1]);
    const adjusted = [{ d: "20250101", o: 50, c: 50, v: 400 }, { d: "20250103", o: 50, c: 50, v: 400 }];
    expect(fixSplits(adjusted, [], [{ d: "20250103", ratio: 4 }])).toEqual([]);
    expect(adjusted[0].c).toBe(50);
  });
});

describe("判斷頻率", () => {
  it("每週：週五（或週五休市時該週最後一天）；每月：該月最後一個交易日", () => {
    const ds = ["20260105", "20260106", "20260109", "20260112", "20260130", "20260202"];
    expect(ds.map((_, i) => isPeriodEnd(ds, i, "week"))).toEqual([false, false, true, true, true, true]);
    expect(ds.map((_, i) => isPeriodEnd(ds, i, "month"))).toEqual([false, false, false, false, true, true]);
  });
  it("每月判斷的調整次數比每週少很多（同一份資料）", () => {
    const data = [
      series("0050", drift(100, 0.0004)), series("00878", drift(30, 0.0003)), series("0052", drift(60, 0.0002)), series("0056", drift(50, 0.0003)), series("00919", drift(30, 0.0001)),
      series("00720B", drift(30, 0.0001)), series("00679B", drift(26, 0.00005)),
    ];
    const a = align(data);
    const from = (() => { let s = 130; while (!isPeriodEnd(a.dates, s, "month")) s++; return s; })();
    const wk = simulate(a, from, strategyDecider({ ...DEFAULT_CFG, freq: "week" }), { ...DEFAULT_CFG, freq: "week" });
    const mo = simulate(a, from, strategyDecider({ ...DEFAULT_CFG, freq: "month", fullEvery: 3 }), { ...DEFAULT_CFG, freq: "month", fullEvery: 3 });
    expect(mo.rebalances.length).toBeLessThanOrEqual(wk.rebalances.length);
    expect(mo.rebalances.length).toBeLessThanOrEqual(8);
  });
});
