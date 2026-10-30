// ETF 組合回測：抓候選 ETF 的日線與配息（Yahoo），跑規則式選配策略，和 0050、固定比例組合比較，輸出 etf-backtest.json。
// 用法：node .eb-build/etfBacktest.js <輸出 etf-backtest.json>
import { writeFileSync } from "node:fs";
import { DEFAULT_CFG, ETF_UNIVERSE, align, chooseTarget, evaluate, fixSplits, fixedDecider, metrics, parseYahoo, simulate, strategyDecider, type EtfData, type Sim } from "../src/engine/etfBacktest";

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", accept: "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const outPath = process.argv[2] ?? "etf-backtest.json";
const cfg = DEFAULT_CFG;

async function load(code: string): Promise<{ bars: EtfData["bars"]; divs: EtfData["divs"]; fixed: string[] } | null> {
  for (const sfx of [".TW", ".TWO"]) {
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}${sfx}?range=5y&interval=1d&events=div%7Csplit`, { headers: UA, signal: AbortSignal.timeout(30000) });
        if (r.status === 404) break;
        if (!r.ok) { await sleep(1500); continue; }
        const p = parseYahoo(await r.json());
        if (p) return { bars: p.bars, divs: p.divs, fixed: fixSplits(p.bars, p.divs, p.splits) };
        break;
      } catch { await sleep(1500); }
    }
  }
  return null;
}

const data: EtfData[] = [];
const skipped: string[] = [];
for (const def of ETF_UNIVERSE) {
  const r = await load(def.code);
  if (!r) { skipped.push(def.code); console.log("查不到", def.code); continue; }
  if (r.fixed.length) console.log("分割還原", def.code, r.fixed.join(","));
  data.push({ def, bars: r.bars, divs: r.divs });
  await sleep(400);
}
if (!data.some((d) => d.def.code === "0050")) throw new Error("0050 資料抓不到，無法回測");
const a = align(data);

// 第一個能選出配置的週五收盤當起點；之後三條曲線（策略、0050、固定比例）從同一天起算
let S = -1;
for (let i = 100; i < a.dates.length; i++) {
  const d = new Date(Date.UTC(+a.dates[i].slice(0, 4), +a.dates[i].slice(4, 6) - 1, +a.dates[i].slice(6)));
  if (d.getUTCDay() !== 5) continue;
  if (chooseTarget(a, i, new Set(), cfg)) { S = i; break; }
}
if (S < 0) throw new Error("找不到可以開始的日子");
console.log("起點", a.dates[S], "終點", a.dates.at(-1), "交易日", a.dates.length - S);

const strat = simulate(a, S, strategyDecider(cfg), cfg);
const bench = simulate(a, S, fixedDecider({ "0050": 1 }, 1e9), cfg);
const basketW = { "0050": 0.6, "00878": 0.2, "00720B": 0.2 };
const basket = simulate(a, S, fixedDecider(basketW, 13), cfg);
const ev = evaluate(strat, bench, basket, cfg);

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const slice = (s: Sim, from: string) => s.nav.filter((p) => p.d >= from);
const yearly = (s: Sim) => {
  const out: Record<string, number> = {};
  const years = [...new Set(s.nav.map((p) => p.d.slice(0, 4)))];
  for (const y of years) {
    const pts = s.nav.filter((p) => p.d.slice(0, 4) === y);
    const prev = s.nav.filter((p) => p.d.slice(0, 4) < y).at(-1) ?? pts[0];
    out[y] = pts[pts.length - 1].nav / prev.nav - 1;
  }
  return out;
};
// 含主動式 ETF 的期間：第一檔主動式 ETF 滿 warmup 天之後
const activeFirst = Math.min(...a.etfs.filter((e) => e.def.type === "主動" && Number.isFinite(e.first)).map((e) => e.first + cfg.warmup));
const activeFrom = Number.isFinite(activeFirst) && activeFirst < a.dates.length ? a.dates[Math.max(activeFirst, S)] : "";
const eraM = (s: Sim) => (activeFrom ? metrics(slice(s, activeFrom)) : null);

const nameOf = (c: string) => ETF_UNIVERSE.find((e) => e.code === c)?.name ?? c;
const weekly = (s: Sim) => s.nav.filter((_, i) => i % 5 === 0 || i === s.nav.length - 1).map((p) => [p.d, Math.round(p.nav)]);
const out = {
  generatedAt: new Date().toISOString(),
  note: "規則式選配框架的回測（不是 Claude 本人逐週的判斷）；含手續費、證交稅 0.1%、配息（稅前）；週五收盤判斷、隔天開盤成交",
  config: cfg,
  period: { start: a.dates[S], end: a.dates.at(-1), days: a.dates.length - S },
  universe: a.etfs.map((e) => ({ code: e.def.code, name: e.def.name, type: e.def.type, group: e.def.group, firstDate: Number.isFinite(e.first) ? a.dates[e.first] : null, bars: Number.isFinite(e.first) ? a.dates.length - e.first : 0, dividends: data.find((d) => d.def.code === e.def.code)!.divs.length })),
  skipped,
  metrics: { strategy: metrics(strat.nav), bench0050: metrics(bench.nav), basket: metrics(basket.nav) },
  basketWeights: basketW,
  criteria: ev.criteria, pass: ev.pass,
  yearly: { strategy: yearly(strat), bench0050: yearly(bench), basket: yearly(basket) },
  activeEra: activeFrom ? { from: activeFrom, strategy: eraM(strat), bench0050: eraM(bench), basket: eraM(basket) } : null,
  costs: { strategy: Math.round(strat.cost), dividendsStrategy: Math.round(strat.dividends), rebalances: strat.rebalances.length },
  picks: Object.fromEntries(Object.entries(strat.picks).sort((x, y) => y[1] - x[1]).map(([c, n]) => [`${c} ${nameOf(c)}`, n])),
  currentTarget: strat.last.target ? { date: strat.last.date, risk: strat.last.target.risk, weights: Object.fromEntries(Object.entries(strat.last.target.weights).map(([c, w]) => [`${c} ${nameOf(c)}`, +w.toFixed(3)])) } : null,
  recentRebalances: strat.rebalances.slice(-25).map((r) => ({ date: r.date, risk: r.risk, why: r.why, cost: r.cost, legs: r.legs.map((l) => `${l.side === "buy" ? "買" : "賣"} ${l.code} ${l.shares}股 @${l.price.toFixed(2)}`) })),
  nav: { strategy: weekly(strat), bench0050: weekly(bench), basket: weekly(basket) },
};
writeFileSync(outPath, JSON.stringify(out));

console.log(`\n=== ETF 回測 ${out.period.start} ～ ${out.period.end}（${out.period.days} 個交易日）===`);
for (const [k, m] of Object.entries(out.metrics)) console.log(`${k.padEnd(10)} 報酬 ${pct(m.totalReturn)}｜年化 ${pct(m.cagr)}｜最大回檔 ${pct(m.maxDrawdown)}｜年化波動 ${pct(m.volatility)}`);
console.log("年度報酬", JSON.stringify(out.yearly));
for (const c of ev.criteria) console.log(`${c.pass ? "✓" : "✗"} ${c.id}. ${c.name}｜${c.detail}`);
console.log(ev.pass ? "→ 5 條都達成" : "→ 有未達成的標準");
if (out.activeEra) console.log("含主動式期間", JSON.stringify(out.activeEra));
console.log("目前目標", JSON.stringify(out.currentTarget));
console.log("入選次數", JSON.stringify(out.picks));
console.log("略過", skipped.join(",") || "無", "｜調整次數", out.costs.rebalances, "｜成本", out.costs.strategy, "｜配息", out.costs.dividendsStrategy);
