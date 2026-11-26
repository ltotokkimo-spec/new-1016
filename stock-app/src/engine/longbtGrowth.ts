// 長期回測實驗：成長組加「走勢濾網」的變體（研究用，不動 steady.ts 的現行規則）。
// 現行成長組（growthPicks）完全沒有價格條件；這裡複製同一套排名，只在候選池多一條：站上且上彎 60 日線（和低波動組 A 同一個濾網）。
import { isCommonStock } from "../data/tw";
import { revFactors } from "./revHist";
import { GROWTH, STEADY, foreign60, inverseVolWeights, trendFit, type Ctx, type Picker } from "./steady";

const px = (c: Ctx, code: string, j: number) => { const s = c.series.get(code); return s && j >= s.start && j - s.start < s.adj.length ? s.adj[j - s.start] : NaN; };
const ma = (c: Ctx, code: string, j: number, n: number) => { let t = 0; for (let k = j - n + 1; k <= j; k++) { const p = px(c, code, k); if (!(p > 0)) return NaN; t += p; } return t / n; };

function pctRank(codes: string[], vals: number[]): Map<string, number> {
  const idx = codes.map((_, i) => i).filter((i) => Number.isFinite(vals[i])).sort((a, b) => vals[a] - vals[b]);
  const out = new Map<string, number>();
  idx.forEach((i, r) => out.set(codes[i], idx.length > 1 ? r / (idx.length - 1) : 0.5));
  return out;
}
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

/** 和 steady.ts 的 growthPicks 相同；trend＝true 時候選池只留「站上且上彎 60 日線」的（已持有的也要通過，等於跌破就換掉） */
export function growthPicksLB(c: Ctx, j: number, held: ReadonlySet<string>, trend: boolean, allow?: ReadonlySet<string>): { code: string; weight: number }[] {
  if (!c.rev || j < GROWTH.minHistory) return [];
  const uni: string[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[2] > 0)) continue;
    if (allow && !allow.has(code)) continue; // 候選池限定（選股頁「買入」或四因子名單）
    let t = 0, ok = true;
    for (let k = j - 19; k <= j; k++) { const r = c.rows[k]?.get(code); if (!r) { ok = false; break; } t += r[4]; }
    if (!ok || !(t / 20 >= GROWTH.minValue)) continue;
    if (!(px(c, code, j - GROWTH.minHistory) > 0)) continue;
    if (trend) { const p = px(c, code, j), m = ma(c, code, j, 60), mb = ma(c, code, j - 20, 60); if (!(p > m) || !(m > mb)) continue; }
    uni.push(code);
  }
  const rf = uni.map((code) => revFactors(c.rev!, code, c.dates[j]));
  const flow = uni.map((code) => {
    let f = 0, v = 0;
    for (let k = j - GROWTH.flowDays + 1; k <= j; k++) { f += c.flows[k]?.get(code)?.[1] ?? 0; v += c.rows[k]?.get(code)?.[5] ?? 0; }
    return v > 0 ? f / v : NaN;
  });
  const ranks = [pctRank(uni, rf.map((x) => x?.yoy3 ?? NaN)), pctRank(uni, rf.map((x) => x?.newHigh ?? NaN)), pctRank(uni, flow)];
  const scored: { code: string; score: number }[] = [];
  uni.forEach((code) => {
    const r = ranks.map((m) => m.get(code));
    if (r.every((x) => x !== undefined)) scored.push({ code, score: (r[0]! + r[1]! + r[2]!) / 3 });
  });
  scored.sort((a, b) => b.score - a.score || (a.code < b.code ? -1 : 1));
  const per = new Map<string, number>(), chosen: typeof scored = [];
  const take = (x: (typeof scored)[number]) => {
    const sec = c.sector.get(x.code) ?? "其他";
    if ((per.get(sec) ?? 0) >= GROWTH.perSector) return;
    per.set(sec, (per.get(sec) ?? 0) + 1); chosen.push(x);
  };
  scored.forEach((x, rank) => { if (chosen.length < GROWTH.top && held.has(x.code) && rank < GROWTH.keep) take(x); });
  for (const x of scored) { if (chosen.length >= GROWTH.top) break; if (!chosen.includes(x)) take(x); }
  if (!chosen.length) return [];
  const raw = chosen.map((x) => Math.sqrt(Math.max(0, (c.capital.get(x.code) ?? 0) * (c.rows[j].get(x.code)?.[2] ?? 0))));
  const tot = raw.reduce((a, b) => a + b, 0);
  const w = capWeights(tot > 0 ? raw.map((x) => x / tot) : raw.map(() => 1 / raw.length), GROWTH.maxWeight);
  return chosen.map((x, k) => ({ code: x.code, weight: w[k] }));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : NaN; };
function rets(c: Ctx, code: string, j: number, n: number): number[] | null {
  const out: number[] = [];
  for (let k = j - n + 1; k <= j; k++) { const a = px(c, code, k), b = px(c, code, k - 1), r = a > 0 && b > 0 ? a / b - 1 : NaN; if (!Number.isFinite(r)) return null; out.push(r); }
  return out;
}

/** 和 steady.ts 的 aPicks 相同（低波動方案 A）；allow 有值時候選池限定在該名單內（在取「波動最低的一半」之前就限定） */
export function aPicksLB(c: Ctx, j: number, allow?: ReadonlySet<string>, foreignOk = false): Map<string, number> {
  const vol60 = (code: string) => { const r60 = rets(c, code, j, 60); return r60 ? std(r60) : NaN; };
  const pool: { code: string; vol: number }[] = [];
  for (const [code, row] of c.rows[j]) {
    if (!isCommonStock(code) || !(row[4] >= STEADY.minValue)) continue;
    if (allow && !allow.has(code)) continue;
    const v = vol60(code);
    if (Number.isFinite(v)) pool.push({ code, vol: v });
  }
  pool.sort((a, b) => a.vol - b.vol);
  const cands: { code: string; vol: number; sector: string; score: number }[] = [];
  for (const { code, vol } of pool.slice(0, Math.ceil(pool.length * STEADY.lowVolHalf))) {
    const p = px(c, code, j), m60 = ma(c, code, j, 60), m60b = ma(c, code, j - 20, 60);
    if (!(p > m60) || !(m60 > m60b)) continue;
    const prices: number[] = [];
    for (let k = j - STEADY.lookback + 1; k <= j; k++) prices.push(px(c, code, k));
    const { slope, r2 } = trendFit(prices);
    const annual = Math.exp(slope * 250) - 1;
    if (!(annual > 0) || annual > STEADY.trendCap) continue;
    if (foreignOk && !(foreign60(c, code, j) >= 0)) continue; // 雙引擎＋的外資條件
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

/** 成長 wG＋低波動 A wA；每 5 個交易日呼叫一次，成長組每 reselectEvery 次重選（4＝每 20 個交易日、1＝每週）。allowAt：每個判斷日的候選名單（沒給＝不限） */
export function growthLbPicker(c: Ctx, wG: number, wA: number, trend: boolean, reselectEvery: number, allowAt?: (j: number) => ReadonlySet<string>, foreignOk = false, variant: { steadyAll?: boolean; fillGrowth?: boolean } = {}): Picker {
  let last: { code: string; weight: number }[] | null = null, n = 0;
  return (j) => {
    const allow = allowAt?.(j);
    if (!last || n % reselectEvery === 0) last = growthPicksLB(c, j, new Set((last ?? []).map((x) => x.code)), trend, allow);
    n++;
    // 11/26 實驗（LBT_EXP6）：steadyAll＝低波動組的候選不限定名單（成長組照舊限定）；fillGrowth＝低波動組權重上限造成沒用完的部分，等比例補給成長組
    const steady = wA ? aPicksLB(c, j, variant.steadyAll ? undefined : allow, foreignOk) : new Map<string, number>();
    const used = [...steady.values()].reduce((a, v) => a + v * wA, 0);
    const gScale = variant.fillGrowth && wG > 0 && last.length ? (wG + Math.max(0, wA - used)) / wG : 1;
    const m = new Map<string, number>();
    for (const x of last) m.set(x.code, (m.get(x.code) ?? 0) + x.weight * wG * gScale);
    for (const [k, v] of steady) m.set(k, (m.get(k) ?? 0) + v * wA);
    return m;
  };
}
