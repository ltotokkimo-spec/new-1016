// ETF 組合回測（純計算，工具與單元測試共用）：
// 規則式的「選配＋調整」框架——每週收盤後判斷，隔天開盤成交；含手續費、證交稅、配息（除息日前一天收盤持有才有）。
// 這測的是「這套框架合不合理」，不是 Claude 本人的逐週判斷（過去兩年無法請 Claude 重新判斷一遍）。

export type EtfType = "大盤" | "高股息" | "科技" | "債券" | "主動";
export interface EtfDef { code: string; name: string; type: EtfType; group: string; bond?: "公司債" | "長債" }

/**
 * 候選名單與「重疊群組」：同一群組最多選 1 檔（用 2026/09 前十大持股人工分群，近似「任兩檔重疊不超過約 30%」；
 * 不是逐期的實際重疊，這點在報告裡要寫明）。海外型、槓桿、反向、期貨型不納入。
 */
export const ETF_UNIVERSE: EtfDef[] = [
  { code: "0050", name: "元大台灣50", type: "大盤", group: "台積電權值" },
  { code: "006208", name: "富邦台50", type: "大盤", group: "台積電權值" },
  { code: "009816", name: "凱基台灣TOP50", type: "大盤", group: "台積電權值" },
  { code: "0052", name: "富邦科技", type: "科技", group: "台積電權值" },
  { code: "00881", name: "國泰台灣科技龍頭", type: "科技", group: "台積電權值" },
  { code: "00927", name: "群益半導體收益", type: "科技", group: "台積電權值" },
  { code: "00891", name: "中信關鍵半導體", type: "科技", group: "台積電權值" },
  { code: "00878", name: "國泰永續高股息", type: "高股息", group: "金融代工高息" },
  { code: "00919", name: "群益台灣精選高息", type: "高股息", group: "金融代工高息" },
  { code: "0056", name: "元大高股息", type: "高股息", group: "其他高息" },
  { code: "00713", name: "元大台灣高息低波", type: "高股息", group: "其他高息" },
  { code: "00918", name: "大華優利高填息30", type: "高股息", group: "其他高息" },
  { code: "00929", name: "復華台灣科技優息", type: "高股息", group: "其他高息" },
  { code: "00981A", name: "主動統一台股增長", type: "主動", group: "主動成長" },
  { code: "00403A", name: "主動統一升級50", type: "主動", group: "主動成長" },
  { code: "00991A", name: "主動復華未來50", type: "主動", group: "主動成長" },
  { code: "00406A", name: "主動中信台灣收益", type: "主動", group: "主動收益" },
  { code: "00751B", name: "元大AAA至A公司債", type: "債券", group: "公司債", bond: "公司債" },
  { code: "00720B", name: "元大投資級公司債", type: "債券", group: "公司債", bond: "公司債" },
  { code: "00725B", name: "國泰投資級公司債", type: "債券", group: "公司債", bond: "公司債" },
  { code: "00772B", name: "中信高評級公司債", type: "債券", group: "公司債", bond: "公司債" },
  { code: "00679B", name: "元大美債20年", type: "債券", group: "長債", bond: "長債" },
  { code: "00687B", name: "國泰20年美債", type: "債券", group: "長債", bond: "長債" },
];

export interface Bar { d: string; o: number; c: number; v: number }
export interface EtfData { def: EtfDef; bars: Bar[]; divs: { d: string; amt: number }[] }

export interface BtConfig {
  budget: number;
  warmup: number; // 每檔至少要有這麼多個交易日的歷史才可入選
  minTurnover: number; // 近 60 日平均日成交金額（元）下限，代替「規模 ≥ 100 億」（沒有歷史規模資料）
  momDays: number; // 動能與波動的計算天數
  riskOnEquity: number; // 0050 在 60 日線之上：股票型 ETF 比重
  riskOffEquity: number; // 0050 在 60 日線之下
  maxSingle: number; // 單檔上限
  maxActive: number; // 主動式單檔上限
  maxPerType: number; // 同類型最多幾檔（大盤型固定 1 檔）
  maxEquityPicks: number;
  keepRank: number; // 已持有的股票型 ETF 只要排名還在前幾名就留著（減少來回換）
  driftBand: number; // 股票型比重偏離目標超過這個比例才重新平衡
  fullEvery: number; // 每幾次判斷強制重新平衡一次（每週判斷用 13 次＝一季，每月判斷用 3 次＝一季）
  freq: "week" | "month"; // 判斷頻率：每週最後一個交易日、或每月最後一個交易日收盤判斷，隔天開盤成交
  legBand: number; // 重新平衡時，單檔偏離小於這個比例（對淨值）就不動
  fee: number; // 買賣手續費
  tax: number; // 賣出證交稅（ETF）
}
export const DEFAULT_CFG: BtConfig = {
  budget: 500_000, warmup: 120, minTurnover: 5e7, momDays: 60, riskOnEquity: 0.8, riskOffEquity: 0.5,
  maxSingle: 0.4, maxActive: 0.2, maxPerType: 2, maxEquityPicks: 3, keepRank: 5, driftBand: 0.1, fullEvery: 13, freq: "week", legBand: 0.02,
  fee: 0.001425, tax: 0.001,
};

// ---------------- 對齊資料 ----------------
export interface Aligned {
  dates: string[];
  etfs: { def: EtfDef; o: number[]; c: number[]; v: number[]; div: number[]; first: number; tr: number[] }[];
}

/** 以 0050 的交易日為主日曆，把各檔對齊（缺的日子沿用前一天收盤、沒有成交量；上市前是 NaN） */
export function align(data: EtfData[]): Aligned {
  const main = data.find((x) => x.def.code === "0050");
  if (!main) throw new Error("缺少 0050 資料");
  const dates = main.bars.map((b) => b.d);
  const etfs = data.map((e) => {
    const m = new Map(e.bars.map((b) => [b.d, b]));
    const dm = new Map<string, number>();
    for (const d of e.divs) dm.set(d.d, (dm.get(d.d) ?? 0) + d.amt);
    const n = dates.length, o = new Array<number>(n).fill(NaN), c = new Array<number>(n).fill(NaN), v = new Array<number>(n).fill(0), div = new Array<number>(n).fill(0);
    let first = -1;
    for (let i = 0; i < n; i++) {
      const b = m.get(dates[i]);
      if (b) { o[i] = b.o > 0 ? b.o : b.c; c[i] = b.c; v[i] = b.v; if (first < 0) first = i; }
      else if (first >= 0) { c[i] = c[i - 1]; o[i] = c[i - 1]; }
      div[i] = dm.get(dates[i]) ?? 0;
    }
    // 含息的日報酬（除息日把配息加回去）
    const tr = new Array<number>(n).fill(0);
    for (let i = 1; i < n; i++) if (Number.isFinite(c[i]) && Number.isFinite(c[i - 1]) && c[i - 1] > 0) tr[i] = (c[i] + div[i]) / c[i - 1] - 1;
    return { def: e.def, o, c, v, div, first: first < 0 ? Infinity : first, tr };
  });
  return { dates, etfs };
}

const weekKey = (d: string) => {
  const t = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  const wd = (new Date(t).getUTCDay() + 6) % 7; // 週一 = 0
  return Math.floor((t / 86400000 - wd + 3) / 7);
};

/** 第 i 個交易日是不是這個週期（週／月）的最後一個交易日（資料最後一天也算） */
export function isPeriodEnd(dates: string[], i: number, freq: "week" | "month"): boolean {
  if (i >= dates.length - 1) return true;
  return freq === "week" ? weekKey(dates[i + 1]) !== weekKey(dates[i]) : dates[i + 1].slice(0, 6) !== dates[i].slice(0, 6);
}

// ---------------- 選配 ----------------
export interface Scored { i: number; score: number; mom: number; vol: number }

function scoreAt(a: Aligned, k: number, i: number, cfg: BtConfig): Scored | null {
  const e = a.etfs[k];
  if (!(i - e.first >= cfg.warmup) || !Number.isFinite(e.c[i])) return null;
  let tv = 0;
  for (let j = i - 59; j <= i; j++) tv += (e.c[j] || 0) * (e.v[j] || 0);
  if (tv / 60 < cfg.minTurnover) return null;
  let g = 1, s = 0, s2 = 0;
  const n = cfg.momDays;
  for (let j = i - n + 1; j <= i; j++) { g *= 1 + e.tr[j]; s += e.tr[j]; s2 += e.tr[j] * e.tr[j]; }
  const mean = s / n, vol = Math.sqrt(Math.max(0, s2 / n - mean * mean)) * Math.sqrt(252);
  const mom = g - 1;
  return { i: k, score: mom / Math.max(vol, 0.02), mom, vol };
}

/** 把總比重 total 依上限分給各檔（等分、碰到上限的固定、剩下的再分）；回傳每檔權重與沒分完的部分 */
export function waterFill(caps: number[], total: number): { w: number[]; left: number } {
  const w = caps.map(() => 0);
  let rest = total, open = caps.map((_, i) => i);
  for (let guard = 0; guard < 10 && rest > 1e-9 && open.length; guard++) {
    const each = rest / open.length;
    const next: number[] = [];
    for (const i of open) {
      const add = Math.min(each, caps[i] - w[i]);
      w[i] += add; rest -= add;
      if (caps[i] - w[i] > 1e-9) next.push(i);
    }
    open = next;
  }
  return { w, left: Math.max(0, rest) };
}

export interface Target { weights: Record<string, number>; risk: "on" | "off"; picks: string[] }

/** 在第 i 個交易日收盤後決定目標配置（held：目前持有的代號，用來做「留著不換」） */
export function chooseTarget(a: Aligned, i: number, held: Set<string>, cfg: BtConfig): Target | null {
  const sc = a.etfs.map((_, k) => scoreAt(a, k, i, cfg));
  const main = a.etfs.findIndex((e) => e.def.code === "0050");
  let ma = 0;
  for (let j = i - 59; j <= i; j++) ma += a.etfs[main].c[j];
  const risk: "on" | "off" = a.etfs[main].c[i] < ma / 60 ? "off" : "on";
  const eq = a.etfs.map((e, k) => ({ e, k, s: sc[k] })).filter((x) => x.s && x.e.def.type !== "債券").sort((x, y) => y.s!.score - x.s!.score);
  const typeCount = new Map<string, number>(), groups = new Set<string>(), picks: typeof eq = [];
  const ok = (x: (typeof eq)[number]) => {
    if (groups.has(x.e.def.group)) return false;
    const lim = x.e.def.type === "大盤" ? 1 : cfg.maxPerType;
    return (typeCount.get(x.e.def.type) ?? 0) < lim;
  };
  const take = (x: (typeof eq)[number]) => { picks.push(x); groups.add(x.e.def.group); typeCount.set(x.e.def.type, (typeCount.get(x.e.def.type) ?? 0) + 1); };
  eq.slice(0, cfg.keepRank).filter((x) => held.has(x.e.def.code)).forEach((x) => { if (picks.length < cfg.maxEquityPicks && ok(x)) take(x); }); // 先留著還在前幾名的
  for (const x of eq) if (picks.length < cfg.maxEquityPicks && !picks.includes(x) && ok(x)) take(x);
  if (!picks.length) return null;
  const eqTotal = risk === "on" ? cfg.riskOnEquity : cfg.riskOffEquity;
  const caps = picks.map((x) => (x.e.def.type === "主動" ? cfg.maxActive : cfg.maxSingle));
  const fill = waterFill(caps, eqTotal);
  const weights: Record<string, number> = {};
  picks.forEach((x, n) => { weights[x.e.def.code] = fill.w[n]; });
  const def = 1 - eqTotal + fill.left; // 防守部分（含股票型放不下的）
  const best = (kind: "公司債" | "長債") => a.etfs.map((e, k) => ({ e, s: sc[k] })).filter((x) => x.s && x.e.def.bond === kind).sort((x, y) => y.s!.score - x.s!.score)[0];
  const corp = best("公司債"), long = best("長債");
  let left = def;
  if (risk === "on") {
    const w = Math.min(left, cfg.maxSingle);
    if (corp) { weights[corp.e.def.code] = w; left -= w; }
  } else {
    const wc = Math.min(left * 0.6, cfg.maxSingle);
    if (corp) { weights[corp.e.def.code] = wc; left -= wc; }
    const wl = Math.min(left, cfg.maxSingle);
    if (long) { weights[long.e.def.code] = wl; left -= wl; }
  }
  return { weights, risk, picks: Object.keys(weights) };
}

/** 檢查目標配置有沒有違反限制（回傳違規說明；沒有就是空陣列） */
export function violations(a: Aligned, t: Target, cfg: BtConfig): string[] {
  const out: string[] = [];
  const def = (code: string) => a.etfs.find((e) => e.def.code === code)!.def;
  const cnt = new Map<string, number>(), grp = new Map<string, number>();
  for (const [code, w] of Object.entries(t.weights)) {
    const d = def(code);
    if (w > cfg.maxSingle + 1e-9) out.push(`${code} 超過單檔上限`);
    if (d.type === "主動" && w > cfg.maxActive + 1e-9) out.push(`${code} 超過主動式上限`);
    cnt.set(d.type, (cnt.get(d.type) ?? 0) + 1);
    grp.set(d.group, (grp.get(d.group) ?? 0) + 1);
  }
  for (const [ty, n] of cnt) if (n > (ty === "大盤" ? 1 : cfg.maxPerType)) out.push(`${ty} 類型超過檔數`);
  for (const [g, n] of grp) if (n > 1) out.push(`${g} 群組重複`);
  return out;
}

// ---------------- 模擬 ----------------
export interface Leg { code: string; side: "buy" | "sell"; shares: number; price: number }
export interface Rebalance { date: string; risk: "on" | "off"; legs: Leg[]; cost: number; why: string }
export interface Sim {
  nav: { d: string; nav: number }[];
  rebalances: Rebalance[];
  cost: number; // 手續費＋證交稅合計
  dividends: number;
  violations: { date: string; list: string[] }[];
  maxWeight: number; // 觀察到的單檔最大實際比重（收盤）
  last: { weights: Record<string, number>; target: Target | null; date: string };
  picks: Record<string, number>; // 各檔被選進目標的次數
}

type Decider = (a: Aligned, i: number, heldW: Record<string, number>, n: number) => { target: Record<string, number>; risk: "on" | "off"; why: string; vio?: string[] } | null;

export function simulate(a: Aligned, start: number, decide: Decider, cfg: BtConfig): Sim {
  const N = a.dates.length;
  let cash = cfg.budget, cost = 0, divTotal = 0, maxW = 0, decisions = 0;
  const shares = new Map<string, number>();
  const idx = new Map(a.etfs.map((e, k) => [e.def.code, k]));
  const nav: Sim["nav"] = [], rebalances: Rebalance[] = [], vio: Sim["violations"] = [], picks: Record<string, number> = {};
  let pending: ReturnType<Decider> = null;
  let lastTarget: Target | null = null;
  const px = (code: string, arr: "o" | "c", i: number) => { const v = a.etfs[idx.get(code)!][arr][i]; return Number.isFinite(v) ? v : a.etfs[idx.get(code)!].c[i - 1]; };
  const value = (i: number, arr: "o" | "c") => { let s = cash; for (const [c, n] of shares) s += n * px(c, arr, i); return s; };
  for (let t = start; t < N; t++) {
    const before = new Map(shares); // 昨天收盤的持股（除息日用）
    if (pending) {
      const navO = value(t, "o");
      const legs: Leg[] = [];
      let c0 = 0;
      const codes = new Set([...shares.keys(), ...Object.keys(pending.target)]);
      const plan = [...codes].map((code) => {
        const price = px(code, "o", t);
        const cur = (shares.get(code) ?? 0) * price;
        const tgt = (pending!.target[code] ?? 0) * navO;
        return { code, price, delta: tgt - cur, cur, tgt };
      });
      for (const p of plan.filter((x) => x.delta < 0)) { // 先賣
        const full = p.tgt === 0;
        if (!full && -p.delta < cfg.legBand * navO) continue;
        const have = shares.get(p.code) ?? 0;
        const n = full ? have : Math.min(have, Math.floor(-p.delta / p.price));
        if (n <= 0) continue;
        const gross = n * p.price, fee = gross * (cfg.fee + cfg.tax);
        cash += gross - fee; cost += fee; c0 += fee;
        shares.set(p.code, have - n); if (have - n === 0) shares.delete(p.code);
        legs.push({ code: p.code, side: "sell", shares: n, price: p.price });
      }
      for (const p of plan.filter((x) => x.delta > 0).sort((x, y) => y.delta - x.delta)) { // 後買
        if (p.cur > 0 && p.delta < cfg.legBand * navO) continue;
        const n = Math.floor(Math.min(p.delta, cash) / (p.price * (1 + cfg.fee)));
        if (n <= 0) continue;
        const gross = n * p.price, fee = gross * cfg.fee;
        cash -= gross + fee; cost += fee; c0 += fee;
        shares.set(p.code, (shares.get(p.code) ?? 0) + n);
        legs.push({ code: p.code, side: "buy", shares: n, price: p.price });
      }
      if (legs.length) rebalances.push({ date: a.dates[t], risk: pending.risk, legs, cost: Math.round(c0), why: pending.why });
      pending = null;
    }
    for (const [code, n] of before) { // 配息（除息日前一天收盤持有才有）
      const d = a.etfs[idx.get(code)!].div[t];
      if (d > 0) { cash += n * d; divTotal += n * d; }
    }
    const navC = value(t, "c");
    nav.push({ d: a.dates[t], nav: navC });
    for (const [c, n] of shares) maxW = Math.max(maxW, (n * px(c, "c", t)) / navC);
    if (isPeriodEnd(a.dates, t, cfg.freq)) {
      const w: Record<string, number> = {};
      for (const [c, n] of shares) w[c] = (n * px(c, "c", t)) / navC;
      const d = decide(a, t, w, decisions++);
      if (d) {
        pending = d;
        lastTarget = { weights: d.target, risk: d.risk, picks: Object.keys(d.target) };
        for (const c of Object.keys(d.target)) picks[c] = (picks[c] ?? 0) + 1;
        if (d.vio?.length) vio.push({ date: a.dates[t], list: d.vio });
      }
    }
  }
  const lastI = N - 1, w: Record<string, number> = {};
  const navL = nav[nav.length - 1].nav;
  for (const [c, n] of shares) w[c] = (n * px(c, "c", lastI)) / navL;
  return { nav, rebalances, cost, dividends: divTotal, violations: vio, maxWeight: maxW, last: { weights: w, target: lastTarget, date: a.dates[lastI] }, picks };
}

/** 規則式策略：選配（chooseTarget）＋什麼時候動（組合改變、比重偏離、每季） */
export function strategyDecider(cfg: BtConfig): Decider {
  return (a, i, heldW, n) => {
    const held = new Set(Object.keys(heldW));
    const t = chooseTarget(a, i, held, cfg);
    if (!t) return null;
    const vio = violations(a, t, cfg);
    if (!held.size) return { target: t.weights, risk: t.risk, why: "第一次建倉", vio };
    const tgtSet = new Set(Object.keys(t.weights));
    const changed = [...tgtSet].some((c) => !held.has(c)) || [...held].some((c) => !tgtSet.has(c));
    const eqW = (m: Record<string, number>) => Object.entries(m).filter(([c]) => a.etfs.find((e) => e.def.code === c)!.def.type !== "債券").reduce((s, [, w]) => s + w, 0);
    const drift = Math.abs(eqW(heldW) - eqW(t.weights)) > cfg.driftBand;
    if (changed) return { target: t.weights, risk: t.risk, why: "入選名單改變", vio };
    if (drift) return { target: t.weights, risk: t.risk, why: "股票型比重偏離目標", vio };
    if (n % cfg.fullEvery === 0) return { target: t.weights, risk: t.risk, why: "每季重新平衡", vio };
    return null;
  };
}

/** 固定比例組合（每季重新平衡）；只有一檔 100% 就是買進持有 */
export function fixedDecider(weights: Record<string, number>, every: number): Decider {
  return (_a, _i, heldW, n) => (!Object.keys(heldW).length || n % every === 0 ? { target: weights, risk: "on", why: Object.keys(heldW).length ? "每季重新平衡" : "建倉" } : null);
}

// ---------------- 指標與標準 ----------------
export interface Metrics { totalReturn: number; cagr: number; maxDrawdown: number; volatility: number; days: number }
export function metrics(nav: { d: string; nav: number }[]): Metrics {
  const n0 = nav[0].nav, nL = nav[nav.length - 1].nav;
  let peak = n0, mdd = 0, s = 0, s2 = 0;
  for (let i = 1; i < nav.length; i++) {
    peak = Math.max(peak, nav[i].nav);
    mdd = Math.min(mdd, nav[i].nav / peak - 1);
    const r = nav[i].nav / nav[i - 1].nav - 1; s += r; s2 += r * r;
  }
  const n = Math.max(1, nav.length - 1), mean = s / n;
  const years = n / 252;
  return { totalReturn: nL / n0 - 1, cagr: years > 0 ? Math.pow(nL / n0, 1 / years) - 1 : 0, maxDrawdown: mdd, volatility: Math.sqrt(Math.max(0, s2 / n - mean * mean)) * Math.sqrt(252), days: nav.length };
}

/** 基準（0050）從高點回落 ≥ threshold 的那些日子，各組合累積的報酬（對數日報酬加總，轉成報酬率） */
export function downSegmentReturn(nav: { d: string; nav: number }[], bench: { d: string; nav: number }[], threshold = 0.05): number {
  let peak = bench[0].nav, s = 0;
  for (let i = 1; i < bench.length; i++) {
    peak = Math.max(peak, bench[i].nav);
    if (bench[i].nav / peak - 1 <= -threshold) s += Math.log(nav[i].nav / nav[i - 1].nav);
  }
  return Math.exp(s) - 1;
}

export interface Criterion { id: number; name: string; pass: boolean; detail: string }
export function evaluate(strategy: Sim, bench: Sim, basket: Sim, cfg: BtConfig): { criteria: Criterion[]; pass: boolean } {
  const ms = metrics(strategy.nav), mb = metrics(bench.nav), mk = metrics(basket.nav);
  const years = Math.max(1 / 252, (strategy.nav.length - 1) / 252);
  const avgNav = strategy.nav.reduce((s, x) => s + x.nav, 0) / strategy.nav.length;
  const costPerYear = strategy.cost / avgNav / years;
  const changes = strategy.rebalances.slice(1).map((r) => r.legs.length); // 第一次建倉不算「調整」
  const avgChanges = changes.length ? changes.reduce((s, x) => s + x, 0) / changes.length : 0;
  const dS = downSegmentReturn(strategy.nav, bench.nav);
  const dBench = downSegmentReturn(bench.nav, bench.nav);
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const c: Criterion[] = [
    { id: 1, name: "含息總報酬不輸固定比例組合", pass: ms.totalReturn >= mk.totalReturn, detail: `組合 ${pct(ms.totalReturn)}｜固定比例 ${pct(mk.totalReturn)}｜0050 ${pct(mb.totalReturn)}` },
    { id: 2, name: "最大回檔比 0050 小至少 20%", pass: Math.abs(ms.maxDrawdown) <= Math.abs(mb.maxDrawdown) * 0.8, detail: `組合 ${pct(ms.maxDrawdown)}｜0050 ${pct(mb.maxDrawdown)}（門檻 ${pct(mb.maxDrawdown * 0.8)}）` },
    { id: 3, name: "0050 回落超過 5% 的區間，表現比 0050 好", pass: dS > dBench, detail: `下跌段累積報酬：組合 ${pct(dS)}｜0050 ${pct(dBench)}` },
    { id: 4, name: "年化調整成本 ≤ 1%，平均每次調整 ≤ 2 檔", pass: costPerYear <= 0.01 && avgChanges <= 2, detail: `年化成本 ${pct(costPerYear)}｜平均每次 ${avgChanges.toFixed(2)} 筆買賣｜共 ${strategy.rebalances.length} 次` },
    { id: 5, name: "配置沒有失控（目標不違反限制、實際單檔不超過上限＋10%）", pass: strategy.violations.length === 0 && strategy.maxWeight <= cfg.maxSingle + 0.1, detail: `目標違規 ${strategy.violations.length} 次｜實際最大單檔 ${pct(strategy.maxWeight)}` },
  ];
  return { criteria: c, pass: c.every((x) => x.pass) };
}

/**
 * 分割還原：Yahoo 的日線通常已經是分割調整後的價格；如果某個分割日前後價格真的跳了分割倍數（沒調整），
 * 就把分割日以前的價格除以倍數、成交量與配息跟著調整。回傳有修正的分割日。
 */
export function fixSplits(bars: Bar[], divs: { d: string; amt: number }[], splits: { d: string; ratio: number }[]): string[] {
  const fixed: string[] = [];
  for (const sp of splits) {
    const i = bars.findIndex((b) => b.d >= sp.d);
    if (i <= 0 || !(sp.ratio > 0) || Math.abs(sp.ratio - 1) < 1e-9) continue;
    const r = bars[i].c / bars[i - 1].c; // 沒調整的話，r 會接近 1 / ratio
    if (r > 0.8 / sp.ratio && r < 1.25 / sp.ratio && Math.abs(Math.log(r)) > 0.3) {
      for (let j = 0; j < i; j++) { bars[j].o /= sp.ratio; bars[j].c /= sp.ratio; bars[j].v *= sp.ratio; }
      for (const d of divs) if (d.d < sp.d) d.amt /= sp.ratio;
      fixed.push(sp.d);
    }
  }
  return fixed;
}

/** Yahoo chart API → 日線與配息（日期用台北時間） */
export function parseYahoo(json: any): { bars: Bar[]; divs: { d: string; amt: number }[]; splits: { d: string; ratio: number }[] } | null {
  const r = json?.chart?.result?.[0];
  if (!r?.timestamp?.length) return null;
  const ymd = (t: number) => new Date(t * 1000 + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, "");
  const q = r.indicators?.quote?.[0];
  const bars: Bar[] = [];
  r.timestamp.forEach((t: number, i: number) => {
    const c = q?.close?.[i];
    if (c == null || !(c > 0)) return;
    bars.push({ d: ymd(t), o: q.open?.[i] > 0 ? q.open[i] : c, c, v: q.volume?.[i] > 0 ? q.volume[i] : 0 });
  });
  const divs = Object.values(r.events?.dividends ?? {}).map((x: any) => ({ d: ymd(x.date), amt: Number(x.amount) })).filter((x) => x.amt > 0).sort((a, b) => a.d.localeCompare(b.d));
  const splits = Object.values(r.events?.splits ?? {}).map((x: any) => ({ d: ymd(x.date), ratio: Number(x.numerator) / Number(x.denominator) })).filter((x) => x.ratio > 0).sort((a, b) => a.d.localeCompare(b.d));
  return bars.length ? { bars, divs, splits } : null;
}
