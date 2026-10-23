// 穩健選股回測（研究用，不影響 App 的評分）：使用者要「每天慢慢漲、跌的時候跌得少」。
// 規則參考公開案例：平滑趨勢動能（Clenow：回歸斜率 × R²）、低波動、大盤濾網（Faber）、依波動決定部位、停損。
// 用和每日回測同一份 2 年資料，逐日模擬整個組合（含手續費、證交稅、隔一天才成交），和現行「買入」清單、0050 比較。
import { buildTwInputs } from "../data/twLoader";
import { isCommonStock, isEtf, type Company } from "../data/tw";
import { addDays } from "../lib/dates";
import type { BtDay } from "./backtest";
import { scoreStocks } from "./score";
import { adjustedSeries } from "./turning";

/** 規則參數（改這裡就等於換一套規則，結果要重新看） */
export const STEADY = {
  lookback: 90, // 趨勢回歸的天數
  top: 10, // 持有檔數上限
  maxPerSector: 2, // 單一產業最多幾檔（10 檔 ≈ 20%）
  maxWeight: 0.12, // 單檔上限
  minValue: 3e8, // 當日成交金額下限（元）
  jumpDay: 0.07, // 近 5 日有單日漲超過這個就排除（不追急漲）
  w1Max: 0.1, // 近 1 週漲幅上限
  rebalanceEvery: 5, // 每 5 個交易日（約每週）換股一次
  stopAtr: 2.5, // 從買進後最高點回落超過「2.5 × 平均日波動」就停損
  regimeExposure: 0.5, // 0050 跌破 60 日線時，持股降到 5 成
  // 方案 A（低波動為主、趨勢為輔）
  lowVolHalf: 0.5, // 只看波動最低的這個比例
  trendCap: 1, // 年化趨勢超過 100% 視為暴漲股，排除
  // 方案 C（0050 為核心）
  coreWeight: 0.7, // 0050 占 7 成，其餘給選股
  // 全個股（不限檔數、每天局部修正）：沿用方案 A 的條件，但所有通過的都持有
  wideR2: 0.6, // 新買進要求走勢夠像直線（R² ≥ 0.6）
  wideHoldVol: 0.67, // 已持有的，波動排名放寬到前 2/3 才賣（避免在邊界來回買賣）
  wideTrendHold: 1.5, // 已持有的，年化趨勢放寬到 150% 才賣
  wideMaxSector: 0.25, // 單一產業合計不超過淨值 25%
  wideMinCap: 0.05, // 單檔上限至少 5%（檔數少時放寬到 1.5/檔數）
  wideBand: 0.005, // 與目標差距小於淨值 0.5% 就不動，只做局部修正
} as const;

/**
 * 攻守輪動（Claude 自訂規則 R1，使用者 10/23 授權「你決定規則」）：
 * 進攻（0050 站上 60 日線）：0050 七成＋方案 A 三成；防守（0050 跌破 60 日線）：0050 四成＋方案 A 四成，其餘現金。
 * 理由：方案 A 挑的是波動小、已站上 60 日線的股票，大盤轉弱時比 0050 抗跌，所以轉弱時把一部分從 0050 換到 A，
 * 並保留 2 成現金；為了不在 60 日線附近來回切換，加 ±2% 緩衝區（要跌破 98% 才轉防守、站回 102% 才轉進攻）。
 */
export const REGIME = { onCore: 0.7, onSat: 0.3, offCore: 0.4, offSat: 0.4, band: 0.02 } as const;

/**
 * 權值強化（Claude 設計，使用者 10/23 指定：不放 0050、要往贏 0050 的方向、和之前的組合不要太像）：
 * 0050 會贏是因為「依市值配置、大的買最多」，所以核心照市值買市值最大的 50 檔個股（自己組，不買 0050），
 * 再依三個因子微調：
 * 1. 趨勢（決定持股比重）：站上且上彎 60 日線全拿；站上但 60 日線下彎打 7 折；跌破 60 日線打 3 折；60、120 日線都跌破就不持有。
 *    被打折的部分變現金，所以大型股普遍轉弱時持股自然下降（最低 5 成），這是防守，和攻守輪動只看 0050 不同。
 * 2. 外資：近 20 日外資買超佔成交量，前 1/3 加 3 成、後 1/3 打 8 折（2 年因子分析中微弱正向）。
 * 3. 投信：近 20 日投信買超佔成交量最高的 1/10 打 8 折（因子分析中穩定反向，常是作帳後回落）。
 * 4. 走勢品質：近 90 日「年化趨勢 × R²」前 1/3 加 2 成。
 * 單檔上限 6 成（台積電權重和 0050 差不多，才有機會跟上），每 5 個交易日調整，差距小於淨值 0.5% 不動。
 */
export const LEAD = {
  universe: 50, minValue: 3e8, flowDays: 20,
  slowTrend: 0.7, below60: 0.3, // 趨勢打折
  flowUp: 1.3, flowDown: 0.8, trustCut: 0.8, trustTop: 0.1, qualityUp: 1.2,
  minExposure: 0.5, maxWeight: 0.6, band: 0.005,
} as const;

const FEE = 0.001425, TAX = 0.003, TAX_ETF = 0.001;
const BENCH = "0050";

export interface StrategyStats {
  key: string; label: string;
  days: number; total: number; cagr: number; vol: number; sharpe: number; maxDd: number;
  upDays: number; upWeeks: number; worstDay: number; bestDay: number;
  avgHold: number; exposure: number; turnover: number; // turnover：一年換手幾倍（單邊）
  monthsBeat: number; months: number; // 每月報酬贏過 0050 的月數
  first: { cagr: number; maxDd: number }; second: { cagr: number; maxDd: number }; // 前、後半段
  equity: { date: string; v: number }[]; // 每週取樣的淨值（起點 1）
}
export interface SteadyPick { code: string; name: string; sector: string; score: number; slope: number; r2: number; vol: number; weight: number }
export interface SteadyResult {
  version: 1; generatedAt: number; from: string; to: string; days: number;
  params: typeof STEADY;
  strategies: StrategyStats[];
  latest: { date: string; regimeOk: boolean; picks: SteadyPick[] };
}

type Series = { start: number; adj: number[] };
export interface Ctx {
  N: number; dates: string[]; // 舊到新
  series: Map<string, Series>;
  rows: Map<string, [string, string, number, number, number, number]>[]; // 舊到新：代號 → 當日行情
  sector: Map<string, string>;
  capital: Map<string, number>; // 實收資本額（元）
  flows: Map<string, [string, number, number, number]>[]; // 舊到新：代號 → [代號, 外資, 投信, 自營]（股）
}

const px = (s: Series | undefined, j: number) => (s && j >= s.start && j - s.start < s.adj.length ? s.adj[j - s.start] : NaN);
const ret = (s: Series | undefined, j: number) => { const a = px(s, j), b = px(s, j - 1); return a > 0 && b > 0 ? a / b - 1 : NaN; };
function ma(s: Series | undefined, j: number, n: number) {
  let t = 0;
  for (let k = j - n + 1; k <= j; k++) { const p = px(s, k); if (!(p > 0)) return NaN; t += p; }
  return t / n;
}
function rets(s: Series | undefined, j: number, n: number) {
  const out: number[] = [];
  for (let k = j - n + 1; k <= j; k++) { const r = ret(s, k); if (!Number.isFinite(r)) return null; out.push(r); }
  return out;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : NaN; };

/** 對近 n 天的 ln(價格) 做直線回歸：斜率（每天）與 R²（走勢多像一條直線，0～1） */
export function trendFit(prices: number[]): { slope: number; r2: number } {
  const n = prices.length;
  if (n < 10 || prices.some((p) => !(p > 0))) return { slope: NaN, r2: NaN };
  const y = prices.map(Math.log), xm = (n - 1) / 2, ym = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxy += (i - xm) * (y[i] - ym); sxx += (i - xm) ** 2; syy += (y[i] - ym) ** 2; }
  const slope = sxy / sxx;
  return { slope, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
}

/** 穩健分數：年化趨勢 × R²（漲得快但亂跳的會被扣分）；不符合條件回傳 undefined */
function steadyCandidate(c: Ctx, code: string, j: number): Omit<SteadyPick, "weight"> | undefined {
  const row = c.rows[j].get(code);
  if (!row || !isCommonStock(code) || !(row[4] >= STEADY.minValue)) return undefined;
  const s = c.series.get(code);
  const p = px(s, j);
  const m60 = ma(s, j, 60), m60b = ma(s, j - 20, 60);
  if (!(p > m60) || !(m60 > m60b)) return undefined; // 上升趨勢中
  const r5 = rets(s, j, 5);
  if (!r5 || Math.max(...r5) > STEADY.jumpDay) return undefined; // 近 5 日沒有急漲
  if (!(p / px(s, j - 5) - 1 < STEADY.w1Max)) return undefined;
  // 不用 RSI 擋過熱：走勢越平滑 RSI 越高（一路小漲的 RSI 接近 100），會把最想要的股票排除；過熱改由「近 1 週漲幅」與「單日急漲」把關
  const prices: number[] = [];
  for (let k = j - STEADY.lookback + 1; k <= j; k++) prices.push(px(s, k));
  const { slope, r2 } = trendFit(prices);
  const r60 = rets(s, j, 60);
  if (!Number.isFinite(slope) || slope <= 0 || !r60) return undefined;
  const annual = Math.exp(slope * 250) - 1;
  return { code, name: row[1], sector: c.sector.get(code) ?? "其他", score: annual * r2, slope: annual, r2, vol: std(r60) };
}

/** 依波動反比配置（波動大的少買），單檔上限 maxWeight，超出的部分分給其他檔；總和 ≤ 1 */
export function inverseVolWeights(vols: number[], maxW: number): number[] {
  const n = vols.length;
  if (!n) return [];
  const inv = vols.map((v) => (v > 0 ? 1 / v : 0));
  const w = new Array(n).fill(0), capped = new Array(n).fill(false);
  let left = 1;
  for (let it = 0; it < n; it++) {
    const free = inv.reduce((a, x, i) => a + (capped[i] ? 0 : x), 0);
    if (free <= 0) break;
    let changed = false;
    for (let i = 0; i < n; i++) if (!capped[i]) w[i] = (left * inv[i]) / free;
    for (let i = 0; i < n; i++) if (!capped[i] && w[i] > maxW) { w[i] = maxW; capped[i] = true; changed = true; }
    if (!changed) break;
    left = 1 - w.reduce((a, x, i) => a + (capped[i] ? x : 0), 0);
  }
  return w;
}


export function buildCtx(days: BtDay[], companies: Company[]): Ctx {
  const old = [...days].reverse();
  return {
    N: days.length, dates: old.map((d) => d.date), series: adjustedSeries(days),
    rows: old.map((d) => new Map(d.quotes.map((r) => [r[0], r]))),
    sector: new Map(companies.map((x) => [x.code, x.industry || "其他"])),
    capital: new Map(companies.filter((x) => (x.capital ?? 0) > 0).map((x) => [x.code, x.capital!])),
    flows: old.map((d) => new Map((d.flows ?? []).map((r) => [r[0], r]))),
  };
}

/**
 * 方案 A（低波動為主、趨勢為輔）：波動最低的一半裡，站上且上彎 60 日線、年化趨勢 0～100% 的，
 * 依「趨勢 × R²」排序取前 10 檔（每產業最多 2 檔），依波動配置（單檔上限 12%）。回傳代號 → 權重（合計 ≤ 1）。
 */
export function aPicks(c: Ctx, j: number): Map<string, number> {
  const vol60 = (code: string) => { const r60 = rets(c.series.get(code), j, 60); return r60 ? std(r60) : NaN; };
  const pool: { code: string; vol: number }[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[4] >= STEADY.minValue)) continue;
    const v = vol60(code);
    if (Number.isFinite(v)) pool.push({ code, vol: v });
  }
  pool.sort((a, b) => a.vol - b.vol);
  const cands: { code: string; vol: number; sector: string; score: number }[] = [];
  for (const { code, vol } of pool.slice(0, Math.ceil(pool.length * STEADY.lowVolHalf))) {
    const s = c.series.get(code), p = px(s, j);
    const m60 = ma(s, j, 60), m60b = ma(s, j - 20, 60);
    if (!(p > m60) || !(m60 > m60b)) continue;
    const prices: number[] = [];
    for (let k = j - STEADY.lookback + 1; k <= j; k++) prices.push(px(s, k));
    const { slope, r2 } = trendFit(prices);
    const annual = Math.exp(slope * 250) - 1;
    if (!(annual > 0) || annual > STEADY.trendCap) continue;
    cands.push({ code, vol, sector: c.sector.get(code) ?? "其他", score: annual * r2 });
  }
  cands.sort((a, b) => b.score - a.score || a.vol - b.vol);
  const per = new Map<string, number>(), chosen: typeof cands = [];
  for (const x of cands) {
    if (chosen.length >= STEADY.top) break;
    if ((per.get(x.sector) ?? 0) >= STEADY.maxPerSector) continue;
    per.set(x.sector, (per.get(x.sector) ?? 0) + 1); chosen.push(x);
  }
  const w = inverseVolWeights(chosen.map((x) => x.vol), STEADY.maxWeight);
  return new Map(chosen.map((x, i) => [x.code, w[i]]));
}


/**
 * 全個股（使用者 10/23 指定：不限檔數、只要是好的都參考、每天修正，檔數多所以局部修正或不動）：
 * 條件同方案 A（波動最小的一半、站上且上彎 60 日線、年化趨勢 0～100%），再加走勢要夠像直線（R² ≥ 0.6），
 * 通過的全部持有，依波動反比配置，單一產業合計 ≤ 25%。已持有的用較寬的條件（賣出門檻比買進門檻鬆），
 * 避免每天在邊界來回買賣。回傳代號 → 目標權重（合計 ≤ 1，其餘現金）。
 */
export function wideTargets(c: Ctx, j: number, held: ReadonlySet<string>): Map<string, number> {
  const pool: { code: string; vol: number }[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[4] >= STEADY.minValue)) continue;
    const r60 = rets(c.series.get(code), j, 60);
    if (r60) { const v = std(r60); if (Number.isFinite(v)) pool.push({ code, vol: v }); }
  }
  pool.sort((a, b) => a.vol - b.vol);
  const enterN = Math.ceil(pool.length * STEADY.lowVolHalf), holdN = Math.ceil(pool.length * STEADY.wideHoldVol);
  const chosen: { code: string; vol: number; sector: string }[] = [];
  pool.forEach((x, i) => {
    const isHeld = held.has(x.code);
    if (i >= (isHeld ? holdN : enterN)) return;
    const s = c.series.get(x.code), p = px(s, j), m60 = ma(s, j, 60);
    if (!(p > m60)) return;
    if (!isHeld && !(m60 > ma(s, j - 20, 60))) return;
    const prices: number[] = [];
    for (let k = j - STEADY.lookback + 1; k <= j; k++) prices.push(px(s, k));
    const { slope, r2 } = trendFit(prices);
    const annual = Math.exp(slope * 250) - 1;
    if (!(annual > 0) || annual > (isHeld ? STEADY.wideTrendHold : STEADY.trendCap)) return;
    if (!isHeld && !(r2 >= STEADY.wideR2)) return;
    chosen.push({ code: x.code, vol: x.vol, sector: c.sector.get(x.code) ?? "其他" });
  });
  if (!chosen.length) return new Map();
  const w = inverseVolWeights(chosen.map((x) => x.vol), Math.max(STEADY.wideMinCap, 1.5 / chosen.length));
  const bySector = new Map<string, number>();
  chosen.forEach((x, i) => bySector.set(x.sector, (bySector.get(x.sector) ?? 0) + w[i]));
  return new Map(chosen.map((x, i) => {
    const tot = bySector.get(x.sector) ?? 0;
    return [x.code, tot > STEADY.wideMaxSector ? w[i] * (STEADY.wideMaxSector / tot) : w[i]];
  }));
}


export interface LeadOpts { universe?: number; tilts?: boolean; trend?: boolean }
/** 單檔上限：超過的部分依比例分給其他檔（總和不變） */
function capWeights(w: number[], maxW: number): number[] {
  const out = [...w], tot = w.reduce((a, x) => a + x, 0);
  for (let it = 0; it < out.length; it++) {
    const over = out.reduce((a, x) => a + Math.max(0, x - maxW * tot), 0);
    if (over <= 1e-12) break;
    const free = out.reduce((a, x) => a + (x < maxW * tot ? x : 0), 0);
    for (let i = 0; i < out.length; i++) out[i] = out[i] >= maxW * tot ? maxW * tot : out[i] + (free > 0 ? (over * out[i]) / free : 0);
  }
  return out;
}

/**
 * 權值強化（見 LEAD）：回傳代號 → 目標權重（合計 ≤ 1，其餘現金）與說明用的數字。
 * 沒有實收資本額時（資料缺欄位）改用近 20 日平均成交金額當規模。
 */
export function leadTargets(c: Ctx, j: number, o: LeadOpts = {}): { targets: Map<string, number>; exposure: number; byCap: boolean } {
  const tilts = o.tilts ?? true, useTrend = o.trend ?? tilts, n = o.universe ?? LEAD.universe;
  const pool: { code: string; size: number; value: number }[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[2] > 0)) continue;
    let v = 0, k = 0;
    for (let i = Math.max(0, j - 19); i <= j; i++) { const r = c.rows[i].get(code); if (r) { v += r[4]; k++; } }
    if (k < 15 || !(v / k >= LEAD.minValue)) continue;
    if (!(ma(c.series.get(code), j, 60) > 0)) continue;
    pool.push({ code, size: 0, value: v / k });
  }
  // 規模：市值（收盤 × 實收資本額 ÷ 10）；前 100 大成交金額裡有 8 成以上查得到資本額才用，否則全部改用成交金額
  const top = [...pool].sort((a, b) => b.value - a.value).slice(0, 100);
  const byCap = top.length > 0 && top.filter((x) => c.capital.has(x.code)).length >= top.length * 0.8;
  for (const x of pool) x.size = byCap ? (c.capital.has(x.code) ? (c.rows[j].get(x.code)![2] * c.capital.get(x.code)!) / 10 : 0) : x.value;
  const uni = pool.filter((x) => x.size > 0).sort((a, b) => b.size - a.size).slice(0, n);
  if (!uni.length) return { targets: new Map(), exposure: 0, byCap };
  const tot = uni.reduce((a, x) => a + x.size, 0);
  const base = uni.map((x) => x.size / tot);
  const trendM = uni.map(({ code }) => {
    if (!useTrend) return 1;
    const s = c.series.get(code), p = px(s, j), m60 = ma(s, j, 60), m120 = ma(s, j, 120);
    if (p < m60 && p < m120) return 0;
    if (p < m60) return LEAD.below60;
    return m60 > ma(s, j - 20, 60) ? 1 : LEAD.slowTrend;
  });
  const exposure = useTrend ? Math.min(1, Math.max(LEAD.minExposure, base.reduce((a, b, i) => a + b * trendM[i], 0))) : 1;
  const mult = [...trendM];
  if (tilts) {
    const ratio = (code: string, col: 1 | 2) => {
      let f = 0, vol = 0;
      for (let i = Math.max(0, j - LEAD.flowDays + 1); i <= j; i++) { f += c.flows[i]?.get(code)?.[col] ?? 0; vol += c.rows[i].get(code)?.[5] ?? 0; }
      return vol > 0 ? f / vol : 0;
    };
    const rankOf = (xs: number[]) => { const idx = xs.map((_, i) => i).sort((a, b) => xs[b] - xs[a]); const r = new Array(xs.length); idx.forEach((i, k) => (r[i] = k / xs.length)); return r as number[]; };
    const fr = rankOf(uni.map((x) => ratio(x.code, 1))), tv = uni.map((x) => ratio(x.code, 2)), tr = rankOf(tv);
    const q = rankOf(uni.map(({ code }) => {
      const s = c.series.get(code), prices: number[] = [];
      for (let k = j - STEADY.lookback + 1; k <= j; k++) prices.push(px(s, k));
      const { slope, r2 } = trendFit(prices);
      return Number.isFinite(slope) ? (Math.exp(slope * 250) - 1) * r2 : -Infinity;
    }));
    uni.forEach((_, i) => {
      if (fr[i] < 1 / 3) mult[i] *= LEAD.flowUp; else if (fr[i] >= 2 / 3) mult[i] *= LEAD.flowDown;
      if (tr[i] < LEAD.trustTop && tv[i] > 0) mult[i] *= LEAD.trustCut;
      if (q[i] < 1 / 3) mult[i] *= LEAD.qualityUp;
    });
  }
  const raw = base.map((b, i) => b * mult[i]), sum = raw.reduce((a, x) => a + x, 0);
  if (!(sum > 0)) return { targets: new Map(), exposure: 0, byCap };
  const w = capWeights(raw.map((x) => (x / sum) * exposure), LEAD.maxWeight / exposure > 1 ? 1 : LEAD.maxWeight / exposure);
  return { targets: new Map(uni.map((x, i) => [x.code, w[i]] as [string, number]).filter(([, x]) => x > 1e-4)), exposure, byCap };
}

/** 攻守輪動：prevOn 是上一次的狀態（進攻 true／防守 false），回傳新狀態與目標權重 */
export function regimeStep(c: Ctx, j: number, prevOn: boolean | undefined): { on: boolean; targets: Map<string, number> } {
  const bs = c.series.get("0050"), p = px(bs, j), m = ma(bs, j, 60);
  const on = !(p > 0 && m > 0) ? prevOn ?? true : prevOn === undefined ? p >= m : prevOn ? !(p < m * (1 - REGIME.band)) : p > m * (1 + REGIME.band);
  const core = on ? REGIME.onCore : REGIME.offCore, sat = on ? REGIME.onSat : REGIME.offSat;
  const targets = new Map<string, number>([["0050", core]]);
  for (const [code, w] of aPicks(c, j)) targets.set(code, (targets.get(code) ?? 0) + w * sat);
  return { on, targets };
}

type Picker = (j: number) => Map<string, number>; // 目標權重（合計 ≤ 1，其餘現金）
interface SimOpts { stops?: boolean; every?: number; band?: number }

/** 逐日模擬：第 j 天收盤決定，第 j+1 天收盤成交（從 j+2 起承擔漲跌），含手續費與證交稅 */
function simulate(c: Ctx, j0: number, pick: Picker, opts: SimOpts = {}) {
  const hold = new Map<string, { v: number; peak: number; atr: number }>();
  let cash = 1, traded = 0, holdN = 0, expo = 0;
  let pending: Map<string, number> | null = null; // 明天收盤要換成的目標
  const stopOut = new Set<string>(); // 明天收盤要停損賣出的
  const eq: number[] = [];
  const tax = (code: string) => (isEtf(code) ? TAX_ETF : TAX);
  for (let j = j0; j < c.N; j++) {
    // 1. 今天的漲跌
    for (const [code, h] of hold) {
      const r = ret(c.series.get(code), j);
      if (Number.isFinite(r)) h.v *= 1 + r;
      h.peak = Math.max(h.peak, px(c.series.get(code), j));
    }
    let total = cash + [...hold.values()].reduce((a, h) => a + h.v, 0);
    // 2. 執行昨天決定的交易（今天收盤價）
    for (const code of stopOut) {
      const h = hold.get(code); if (!h) continue;
      cash += h.v * (1 - FEE - tax(code)); traded += h.v; hold.delete(code);
    }
    stopOut.clear();
    if (pending) {
      total = cash + [...hold.values()].reduce((a, h) => a + h.v, 0);
      for (const [code, h] of [...hold]) {
        const want = (pending.get(code) ?? 0) * total;
        if (want < h.v) {
          if (opts.band && want > 1e-12 && h.v - want < opts.band * total) continue; // 差距太小：不動
          const sell = h.v - want; cash += sell * (1 - FEE - tax(code)); traded += sell; h.v = want; if (want <= 1e-12) hold.delete(code); }
      }
      for (const [code, w] of pending) {
        const want = w * total, have = hold.get(code)?.v ?? 0;
        if (want > have + 1e-12) {
          if (opts.band && want - have < opts.band * total) continue;
          const buy = Math.min(want - have, cash / (1 + FEE));
          if (buy <= 0) continue;
          cash -= buy * (1 + FEE); traded += buy;
          const s = c.series.get(code);
          const r20 = rets(s, j, 20);
          const h = hold.get(code) ?? { v: 0, peak: px(s, j), atr: r20 ? mean(r20.map(Math.abs)) : 0.02 };
          h.v += buy; hold.set(code, h);
        }
      }
      pending = null;
    }
    total = cash + [...hold.values()].reduce((a, h) => a + h.v, 0);
    eq.push(total);
    holdN += hold.size; expo += total > 0 ? 1 - cash / total : 0;
    // 3. 收盤後：停損檢查、每週換股
    if (opts.stops) for (const [code, h] of hold) {
      const s = c.series.get(code), p = px(s, j);
      if (p < ma(s, j, 60) || p < h.peak * (1 - STEADY.stopAtr * h.atr)) stopOut.add(code);
    }
    if ((j - j0) % (opts.every ?? STEADY.rebalanceEvery) === 0 && j < c.N - 1) pending = pick(j);
  }
  return { eq, traded, avgHold: holdN / eq.length, exposure: expo / eq.length };
}

function stats(key: string, label: string, c: Ctx, j0: number, sim: ReturnType<typeof simulate>, bench: number[]): StrategyStats {
  const eq = sim.eq, n = eq.length;
  const r = eq.map((v, i) => (i ? v / eq[i - 1] - 1 : v - 1));
  const dd = (xs: number[]) => { let pk = xs[0], m = 0; for (const x of xs) { pk = Math.max(pk, x); m = Math.min(m, x / pk - 1); } return m; };
  const cagrOf = (xs: number[]) => (xs.length > 1 ? (xs[xs.length - 1] / xs[0]) ** (250 / (xs.length - 1)) - 1 : NaN);
  const weeks: number[] = [];
  for (let i = 5; i < n; i += 5) weeks.push(eq[i] / eq[i - 5] - 1);
  // 每月報酬和 0050 比
  const month = new Map<string, { a: number; b: number; a1: number; b1: number }>();
  for (let i = 0; i < n; i++) {
    const m = c.dates[j0 + i].slice(0, 6);
    const x = month.get(m);
    if (!x) month.set(m, { a: i ? eq[i - 1] : 1, b: i ? bench[i - 1] : 1, a1: eq[i], b1: bench[i] });
    else { x.a1 = eq[i]; x.b1 = bench[i]; }
  }
  const ms = [...month.values()];
  const half = n >> 1;
  const sd = std(r);
  return {
    key, label, days: n, total: eq[n - 1] - 1, cagr: cagrOf(eq), vol: sd * Math.sqrt(250), sharpe: (mean(r) / sd) * Math.sqrt(250), maxDd: dd(eq),
    upDays: r.filter((x) => x > 0).length / n, upWeeks: weeks.filter((x) => x > 0).length / weeks.length,
    worstDay: Math.min(...r), bestDay: Math.max(...r),
    avgHold: sim.avgHold, exposure: sim.exposure, turnover: sim.traded / mean(eq) / (n / 250) / 2,
    monthsBeat: ms.filter((x) => x.a1 / x.a > x.b1 / x.b).length, months: ms.length,
    first: { cagr: cagrOf(eq.slice(0, half + 1)), maxDd: dd(eq.slice(0, half + 1)) },
    second: { cagr: cagrOf(eq.slice(half)), maxDd: dd(eq.slice(half)) },
    equity: eq.filter((_, i) => i % 5 === 0 || i === n - 1).map((v, k, arr) => ({ date: c.dates[j0 + Math.min(n - 1, k * 5)], v: +v.toFixed(4) })).slice(0, Math.ceil(n / 5) + 1),
  };
}

/** days：新到舊、連續的交易日（和 runBacktest 一樣） */
export function runSteady(days: BtDay[], companies: Company[], opts: { now?: number } = {}): SteadyResult {
  const c = buildCtx(days, companies), N = c.N;
  const j0 = Math.max(STEADY.lookback + 25, 100);
  if (N < j0 + 30) throw new Error(`交易日太少（${N}），至少要 ${j0 + 30} 天`);
  const benchS = c.series.get(BENCH);
  const regimeOk = (j: number) => { const p = px(benchS, j), m = ma(benchS, j, 60); return !(p < m); };

  const steadyPicks = (j: number): SteadyPick[] => {
    const cands: Omit<SteadyPick, "weight">[] = [];
    for (const code of c.rows[j].keys()) { const x = steadyCandidate(c, code, j); if (x) cands.push(x); }
    cands.sort((a, b) => b.score - a.score || a.vol - b.vol);
    const per = new Map<string, number>(), chosen: Omit<SteadyPick, "weight">[] = [];
    for (const x of cands) {
      if (chosen.length >= STEADY.top) break;
      if ((per.get(x.sector) ?? 0) >= STEADY.maxPerSector) continue;
      per.set(x.sector, (per.get(x.sector) ?? 0) + 1); chosen.push(x);
    }
    const w = inverseVolWeights(chosen.map((x) => x.vol), STEADY.maxWeight);
    return chosen.map((x, i) => ({ ...x, weight: w[i] }));
  };
  const steady = (useRegime: boolean): Picker => (j) => {
    const k = useRegime && !regimeOk(j) ? STEADY.regimeExposure : 1;
    return new Map(steadyPicks(j).map((p) => [p.code, p.weight * k]));
  };
  // 純低波動：成交金額達標的普通股中，近 60 日波動最小的 10 檔（同樣每產業最多 2 檔、依波動配置），不看趨勢、不停損
  const lowVol: Picker = (j) => {
    const cands: { code: string; vol: number; sector: string }[] = [];
    for (const [code, row] of c.rows[j]) {
      if (!isCommonStock(code) || !(row[4] >= STEADY.minValue)) continue;
      const r60 = rets(c.series.get(code), j, 60);
      if (r60) cands.push({ code, vol: std(r60), sector: c.sector.get(code) ?? "其他" });
    }
    cands.sort((a, b) => a.vol - b.vol);
    const per = new Map<string, number>(), chosen: typeof cands = [];
    for (const x of cands) {
      if (chosen.length >= STEADY.top) break;
      if ((per.get(x.sector) ?? 0) >= STEADY.maxPerSector) continue;
      per.set(x.sector, (per.get(x.sector) ?? 0) + 1); chosen.push(x);
    }
    const w = inverseVolWeights(chosen.map((x) => x.vol), STEADY.maxWeight);
    return new Map(chosen.map((x, i) => [x.code, w[i]]));
  };
  // 現行 App：評等「買入」中分數最高的 10 檔，等權，不停損
  const dateIdx = new Map(days.map((d, i) => [d.date, i]));
  const onOrBefore = (ymd: string) => { for (let k = 0; k < 10; k++) { const i = dateIdx.get(addDays(ymd, -k)); if (i !== undefined) return i; } return undefined; };
  const buyList: Picker = (j) => {
    const i = N - 1 - j, s = days[i].date;
    const m1 = onOrBefore(addDays(s, -28)), m3 = onOrBefore(addDays(s, -88));
    if (i + 5 >= N || m1 === undefined || m3 === undefined) return new Map();
    const inputs = buildTwInputs({
      latest: days[i].quotes, week: days[i + 5].quotes, month: days[m1].quotes, quarter: days[m3].quotes,
      flows: days.slice(i, i + 10).map((d) => d.flows), companies, tpexCodes: days[i].tpexCodes,
    });
    const buys = scoreStocks(inputs.filter((x) => !isEtf(x.code))).scored.filter((x) => x.rating === "買入").sort((a, b) => b.score - a.score).slice(0, STEADY.top);
    return new Map(buys.map((x) => [x.code, 1 / STEADY.top]));
  };
  const hold0050: Picker = () => new Map([[BENCH, 1]]);
  // 全個股（不限檔數）：每天或每週重算，已持有的用寬鬆條件，差距小於 0.5% 淨值就不動
  const widePicker = (): Picker => { let held = new Set<string>(); return (j) => { const t = wideTargets(c, j, held); held = new Set(t.keys()); return t; }; };
  // 攻守輪動 R1（見 regimeStep）：每週判斷一次
  const regimePicker = (): Picker => { let on: boolean | undefined; return (j) => { const r = regimeStep(c, j, on); on = r.on; return r.targets; }; };
  const vol60 = (code: string, j: number) => { const r60 = rets(c.series.get(code), j, 60); return r60 ? std(r60) : NaN; };
  // 方案 A（見 aPicks）
  const lowVolTrendPicks = (j: number) => aPicks(c, j);
  const lowVolTrend: Picker = (j) => lowVolTrendPicks(j);
  const lowVolTrendRegime: Picker = (j) => { const k = regimeOk(j) ? 1 : STEADY.regimeExposure; return new Map([...lowVolTrendPicks(j)].map(([code, w]) => [code, w * k])); };
  // 方案 B：同一份「買入」前 10 檔，改成依波動配置（單檔上限 maxWeight）
  const buyListVol: Picker = (j) => {
    const codes = [...buyList(j).keys()];
    const vols = codes.map((code) => vol60(code, j));
    const ok = codes.filter((_, i) => Number.isFinite(vols[i]));
    const w = inverseVolWeights(ok.map((code) => vol60(code, j)), STEADY.maxWeight);
    return new Map(ok.map((code, i) => [code, w[i]]));
  };
  // 方案 C：0050 占 coreWeight，其餘給選股
  const core = (sat: Picker): Picker => (j) => {
    const m = new Map<string, number>([[BENCH, STEADY.coreWeight]]);
    for (const [code, w] of sat(j)) m.set(code, (m.get(code) ?? 0) + w * (1 - STEADY.coreWeight));
    return m;
  };

  // 想贏 0050 的做法（研究）：1 槓桿 ETF 00631L（正 2）；2 0050 跌破均線就減碼
  const LEV = "00631L";
  const aboveMa = (n: number) => (j: number) => { const p = px(benchS, j), m = ma(benchS, j, n); return !(p < m); };
  const timing = (n: number, off: number): Picker => (j) => new Map([[BENCH, aboveMa(n)(j) ? 1 : off]]);
  const levTiming = (n: number): Picker => (j) => (aboveMa(n)(j) ? new Map([[LEV, 1]]) : new Map());
  const half: Picker = () => new Map([[BENCH, 0.5], [LEV, 0.5]]);

  // 不用槓桿的做法（研究）：大型股動能、相對強度、ETF 輪動，以及和 0050 搭配
  const momRet = (code: string, j: number) => { const s = c.series.get(code); return px(s, j) / px(s, j - STEADY.lookback) - 1; };
  const largeCapMom = (pool: number, top: number, needAbove0050: boolean): Picker => (j) => {
    const rows = [...c.rows[j]].filter(([code, r]) => isCommonStock(code) && r[4] >= STEADY.minValue).sort((a, b) => b[1][4] - a[1][4]).slice(0, pool);
    const b = momRet(BENCH, j);
    const cands: { code: string; m: number; sector: string }[] = [];
    for (const [code] of rows) {
      const sr = c.series.get(code), p = px(sr, j);
      const m = momRet(code, j);
      if (!Number.isFinite(m) || m <= 0 || !(p > ma(sr, j, 60))) continue;
      if (needAbove0050 && !(m > b)) continue;
      cands.push({ code, m, sector: c.sector.get(code) ?? "其他" });
    }
    cands.sort((x, y) => y.m - x.m);
    const per = new Map<string, number>(), chosen: typeof cands = [];
    for (const x of cands) {
      if (chosen.length >= top) break;
      if ((per.get(x.sector) ?? 0) >= STEADY.maxPerSector) continue;
      per.set(x.sector, (per.get(x.sector) ?? 0) + 1); chosen.push(x);
    }
    return new Map(chosen.map((x) => [x.code, 1 / top]));
  };
  // ETF 輪動：排除槓桿與反向（代號結尾 L／R），近 90 日報酬最強的 3 檔，要站上 60 日線
  const etfRotation: Picker = (j) => {
    const cands: { code: string; m: number }[] = [];
    for (const [code, r] of c.rows[j]) {
      if (!isEtf(code) || /[LR]$/.test(code) || !(r[4] >= 1e8)) continue;
      const sr = c.series.get(code), m = momRet(code, j);
      if (Number.isFinite(m) && m > 0 && px(sr, j) > ma(sr, j, 60)) cands.push({ code, m });
    }
    cands.sort((x, y) => y.m - x.m);
    const top = cands.slice(0, 3);
    return new Map(top.map((x) => [x.code, 1 / 3]));
  };
  const mix = (a: Picker, wa: number, b: Picker): Picker => (j) => {
    const m = new Map<string, number>();
    for (const [code, w] of a(j)) m.set(code, (m.get(code) ?? 0) + w * wa);
    for (const [code, w] of b(j)) m.set(code, (m.get(code) ?? 0) + w * (1 - wa));
    return m;
  };
  const bigWk = largeCapMom(100, 10, false), bigRs = largeCapMom(150, 10, true);

  const benchSim = simulate(c, j0, hold0050);
  const out: StrategyStats[] = [];
  const add = (key: string, label: string, p: Picker, o?: SimOpts) => out.push(stats(key, label, c, j0, simulate(c, j0, p, o), benchSim.eq));
  add("steady", "穩健（趨勢平滑＋低波動配置＋停損＋大盤濾網）", steady(true), { stops: true });
  add("steadyNoRegime", "穩健但不看大盤", steady(false), { stops: true });
  add("steadyNoStop", "穩健但不停損", steady(true));
  add("lowVol", "純低波動（不看趨勢、不停損）", lowVol);
  add("buyList", "現行 App「買入」前 10 檔（等權）", buyList);
  add("A_lowVolTrend", "A 低波動為主＋趨勢為輔（排除年化趨勢 >100%）", lowVolTrend);
  add("A_lowVolTrendRegime", "A＋大盤濾網", lowVolTrendRegime);
  add("B_buyListVol", "B 現行買入＋依波動配置", buyListVol);
  add("C_coreBuy", "C 0050 七成＋買入三成", core(buyList));
  add("C_coreA", "C 0050 七成＋A 三成", core(lowVolTrend));
  add("T60_off", "2 0050 跌破 60 日線全賣（站回再買）", timing(60, 0));
  add("T60_half", "2 0050 跌破 60 日線減半", timing(60, 0.5));
  add("T120_off", "2 0050 跌破 120 日線全賣", timing(120, 0));
  if (c.series.has(LEV)) {
    add("L_hold", "1 抱 00631L（正 2）", (() => new Map([[LEV, 1]])) as Picker);
    add("L_half", "1 0050 五成＋00631L 五成", half);
    add("L_T60", "1＋2 00631L，0050 跌破 60 日線全賣", levTiming(60));
  }
  add("R1_regime", "R1 攻守輪動（進攻 0050 七成＋A 三成，防守 0050 四成＋A 四成）", regimePicker());
  add("W1_wideDaily", "W1 全個股不限檔數（每天局部修正）", widePicker(), { every: 1, band: STEADY.wideBand });
  add("W2_wideWeekly", "W2 全個股不限檔數（每週修正）", widePicker(), { every: 5, band: STEADY.wideBand });
  add("Q0_capTop50", "Q0 市值前 50 檔依市值配置（自組權值股，不調整）", (j) => leadTargets(c, j, { tilts: false }).targets, { band: LEAD.band });
  add("Q1_capTrend", "Q1 同上＋只看趨勢打折", (j) => leadTargets(c, j, { tilts: false, trend: true }).targets, { band: LEAD.band });
  add("Q2_lead", "Q2 權值強化（市值前 50＋趨勢、外資、投信、走勢品質微調）", (j) => leadTargets(c, j).targets, { band: LEAD.band });
  add("Q3_lead30", "Q3 權值強化，只取市值前 30", (j) => leadTargets(c, j, { universe: 30 }).targets, { band: LEAD.band });
  add("N1_bigMomWk", "N1 大型股動能（成交金額前 100，近 90 日最強 10 檔，每週換）", bigWk);
  add("N1_bigMomMo", "N1 同上，每月換（約 20 個交易日）", bigWk, { every: 20 });
  add("N2_relStrength", "N2 相對強度（前 150 大，需贏過 0050，每月換）", bigRs, { every: 20 });
  add("N3_etfRotation", "N3 ETF 輪動（近 90 日最強 3 檔，不含槓桿反向，每月換）", etfRotation, { every: 20 });
  add("N4_half0050_bigMo", "N4 0050 五成＋大型股動能五成（月換）", mix(hold0050, 0.5, bigWk), { every: 20 });
  add("N5_half0050_A", "N5 0050 五成＋A 五成", mix(hold0050, 0.5, lowVolTrend));
  add("N6_half0050_etf", "N6 0050 五成＋ETF 輪動五成（月換）", mix(hold0050, 0.5, etfRotation), { every: 20 });
  add("N7_half0050_rs", "N7 0050 五成＋相對強度五成（月換）", mix(hold0050, 0.5, bigRs), { every: 20 });
  out.push(stats("0050", "買進持有 0050", c, j0, benchSim, benchSim.eq));

  const last = N - 1;
  return {
    version: 1, generatedAt: opts.now ?? Date.now(), from: c.dates[j0], to: c.dates[last], days: N - j0,
    params: STEADY, strategies: out,
    latest: { date: c.dates[last], regimeOk: regimeOk(last), picks: steadyPicks(last) },
  };
}

const pc = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—");

/** 給 Actions 紀錄看的文字表 */
export function formatSteady(r: SteadyResult): string[] {
  const out = [`穩健選股回測：${r.from} ~ ${r.to}，${r.days} 個交易日（含手續費、證交稅，隔天收盤成交）`];
  for (const s of r.strategies) {
    out.push(`${s.label}｜總報酬 ${pc(s.total)} 年化 ${pc(s.cagr)} 年化波動 ${pc(s.vol)} 夏普 ${s.sharpe.toFixed(2)} 最大回檔 ${pc(s.maxDd)}｜上漲天數 ${pc(s.upDays, 0)} 上漲週數 ${pc(s.upWeeks, 0)} 最差一天 ${pc(s.worstDay)}｜月報酬贏 0050 ${s.monthsBeat}/${s.months}｜平均持股 ${s.avgHold.toFixed(1)} 檔 持股比重 ${pc(s.exposure, 0)} 年換手 ${s.turnover.toFixed(1)} 倍｜前半 年化 ${pc(s.first.cagr)} 回檔 ${pc(s.first.maxDd)}／後半 年化 ${pc(s.second.cagr)} 回檔 ${pc(s.second.maxDd)}`);
  }
  out.push(`最新（${r.latest.date}，大盤濾網${r.latest.regimeOk ? "通過" : "未通過：持股減半"}）：` + r.latest.picks.map((p) => `${p.code}${p.name}（${p.sector}）年化趨勢 ${pc(p.slope, 0)} R² ${p.r2.toFixed(2)} 權重 ${pc(p.weight, 0)}`).join("；"));
  return out;
}
